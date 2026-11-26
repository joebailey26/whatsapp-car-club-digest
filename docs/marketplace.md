# Marketplace car-lead collector

Status: **built, not deployed, and not enabled.** This is the implementation for [issue #4](https://github.com/joebailey26/whatsapp-car-club-digest/issues/4). It finds fresh Facebook Marketplace car adverts near Ramsey and emails you the promising ones quickly. Nothing contacts Facebook until you deploy it, sign in yourself, and run the gate tests below. Hourly collection stays off until you switch it on with an explicit risk acknowledgement, and only after measured runs show it fits the £0 budget.

> **"First discovered" is not "originally posted".** `first_seen_at` is when the collector first saw an advert. Marketplace results are not newest-first and the collector only looks once an hour, so an advert may be hours old when it's found. The posting time is recorded only when the item page shows it ("Listed 2 hours ago"), stored exactly as written, and never inferred.

## Terms and account risk (read before enabling)

Meta's terms prohibit automated collection from Facebook without permission. That includes logged-in browsing of Marketplace by a script, however slow. Running this collector:

- **could breach Meta's terms**, and could get the account restricted, checkpointed or disabled. Use an account you can afford to lose access to.
- is **owner-only, low-volume and read-only**. By default it runs at most 2 searches an hour with bounded scrolling and up to 3 item pages. It never messages sellers, makes offers or buys anything.
- uses **no evasion**: no stealth plugins, no user-agent or fingerprint spoofing, no CAPTCHA or challenge solving, and no automated account recovery. On a login page, checkpoint, verification or warning screen it stops immediately, pauses the schedule and emails you.

Enabling the schedule requires `"acknowledgeRisk": true`. The time of that acknowledgement is stored.

## Architecture and isolation

The isolation boundary is a **separate Worker**, `car-marketplace-alerts`, configured in `wrangler.marketplace.jsonc` and deployed with `pnpm run deploy:marketplace`. That keeps the live WhatsApp release safe:

| | WhatsApp digest (unchanged) | Marketplace collector |
|---|---|---|
| Worker / deploy | `whatsapp-car-club-digest` (`wrangler.jsonc`) | `car-marketplace-alerts` (`wrangler.marketplace.jsonc`) |
| Durable Object | `BrowserController` | `MarketplaceController` |
| Container image | `browser/` (0.3.0, standard-2) | `marketplace-browser/` (0.1.0, `basic`) |
| Browser profile / snapshot | WhatsApp only | Facebook only |
| Schedule | Sunday 09:00 UK | hourly cron, off by default |
| Access application | existing | **its own** (fails closed until `ACCESS_AUD` is set) |
| D1 | `listings`, `events`, … | `market_*` tables (migration 0004), same database |

A Marketplace deploy never restarts the WhatsApp controller, never rebuilds its image and never touches its snapshot. The only shared code change is a type-only widening of `src/api/access.ts`.

```
hourly cron (:07) ──► MarketplaceController
   │ 1. restore Facebook profile snapshot → basic container (Chromium on Xvfb)
   │ 2. confirm signed in (session cookie, no login form, no checkpoint/warning)
   │ 3. visit ≤ N saved searches, read result cards (images blocked)
   │ 4. parse → dedupe → D1 upsert, price history → rule-based score (no AI)
   │ 5. EMAIL urgent leads now (one email per run)
   │ 6. read ≤ 3 new item pages (description, "Listed … ago"), re-score, maybe a 2nd email
   │ 7. measure CPU/memory; re-snapshot at most daily; stop container
   ▼
   8. (container stopped) optional, budget-capped Workers AI for borderline leads
   9. cost guard, circuit breaker, run record
daily at ROUNDUP hour: one email of borderline leads (non-empty only, never repeats)
06:00 UK: retention + snapshot-expiry check
```

## Routing (three paths, everything kept in D1)

1. **Immediate email.** The deterministic rules route the advert to `urgent`. It is sent straight after collection, before item pages are read and before any AI. A desirable car (MX-5, MR2, Type R, …) at or under £1,000 within range always alerts, whatever else is unknown.
2. **Borderline (daily review).** These adverts have a missing price or location, an uncertain fault, or a middling score. If AI is enabled and within budget, one call gives a second opinion. A confident "high" sends an immediate email. Anything else, including a timeout, an error, invalid output or no budget, stays in the daily roundup.
3. **Low.** These are stored with their reasons and never emailed. Nothing is rejected for a missing year, mileage, MOT, fault detail or ROI.

Scoring (`src/marketplace/score.ts`) is a transparent, versioned ruleset. It weighs price bands (under £500, £500–£1,000, up to £1,500 if desirable), distance from Ramsey (a built-in gazetteer; county centres give low confidence; an unknown location means review), pre-2010 age, enthusiast/quirky models and Japanese makes, extras (a hardtop, …), repairable faults (welding is costed at about £300 a patch, not rejected), major or unexplained faults (downranked, still reviewable), uncertain electrics, non-cars and wanted adverts, and price drops. Every point is stored as a reason in D1 and shown in the email. All weights and word lists are settings, and `POST /admin/api/replay` re-scores stored adverts under proposed settings before you apply them.

**Baseline.** A search's first successful run stores everything and alerts nothing, so the first run can't send hundreds of emails. Changing a search's URL resets its baseline.

**Dedupe.** Listings are keyed by `facebook_marketplace:<item id>`. Notifications are keyed by listing, class and dedupe key (`new`, the new price for a drop, or `manual`/`ai`). The daily roundup skips anything already alerted.

## Cost (Cloudflare docs read 2026-11-25)

Workers Paid includes **25 GiB-hours memory, 375 vCPU-minutes and 200 GB-hours disk a month, account-wide**, shared with the WhatsApp digest. **Memory and disk bill on the provisioned size for as long as the container runs. CPU bills on active use.** Snapshots are free during the beta. Email Sending includes 3,000 emails a month, and sends to verified destination addresses are free. Workers AI includes 10,000 neurons a day.

Memory is the binding limit. At 720 runs a month:

| Instance | Memory | Max billable seconds per run within 90% of the allowance (after the WhatsApp reservation) |
|---|---|---|
| `basic` (¼ vCPU, 1 GiB) | 1 GiB | ~97 s |
| `standard-1` (½ vCPU, 4 GiB) | 4 GiB | ~24 s (not realistic for Chromium) |
| `standard-2` (1 vCPU, 6 GiB) | 6 GiB | ~16 s |

So hourly collection at £0 is only realistic on `basic`, at roughly 90 seconds or less from container start to confirmed stop. That is unproven until measured. If Chromium is too slow or runs out of memory on `basic`, the honest options are a longer interval (`intervalHours` 2–4) or accepting some spend. The guard doesn't guess:

- Every run records billable container time (from start request to confirmed stop), cgroup CPU seconds, peak memory, and timings for startup, navigation, collection, item pages, snapshot and shutdown in `market_runs`.
- `GET /admin/api/usage` projects a 30-day month as the WhatsApp reservation plus the average measured run × runs per month, and shows the per-run ceiling for the current instance.
- The schedule can't be enabled with fewer than 3 measured runs, or with a projection over budget, unless you pass `force`.
- After every run, an over-budget projection pauses the schedule and emails you (`COST_GUARD`); at 75% you get `COST_WARN`. Before every scheduled run, month-to-date usage past 90% also pauses it.

Restore tests and login sessions are not counted in the projection. They are occasional and manual.

## Gate tests (do these in order)

1. **Deploy, without the schedule:** apply the migration (`pnpm exec wrangler d1 migrations apply whatsapp-digest --remote`), run `pnpm --dir marketplace-browser install`, then `pnpm run deploy:marketplace`. Create the Worker's own Access application (Worker → Access → All traffic, your email only), put its AUD in `ACCESS_AUD`, and deploy again.
2. **Sign in:** on `/admin`, press **Start login**. Use the console to click on the screenshot and type (your typing is sent once and never stored or logged). Sign in and complete any 2FA yourself, then press **Complete login**.
3. **Session persistence:** press **Run restore test** twice. Each test fully stops and restores the container. Both must pass with no re-login (`restoreTests` in status).
4. **Searches:** `PUT /admin/api/searches` with your saved Marketplace searches. Example shape (find the real location slug by searching Ramsey on Marketplace yourself and copying the URL):
   ```json
   {"searches":[{"id":"ramsey-pre2010-u1k","label":"Ramsey 50mi, <£1k, pre-2010","url":"https://www.facebook.com/marketplace/<location>/vehicles?maxPrice=1000&maxYear=2009&sortBy=creation_time_descend&radius=80","enabled":true,"maxScrolls":2}]}
   ```
5. **Dry runs:** run `POST /admin/api/collect {"dryRun":true}` at least 3 times. Each one collects and scores but writes no listings and sends no email. Check `GET /admin/api/runs` (`lastDryRun` shows what would have alerted) and `GET /admin/api/usage`. Record the card selectors and visibility lag below.
6. **Live, manual:** run `POST /admin/api/collect` once (the baseline). Later runs alert. Check the email's link, `first_seen_to_email_ms` in the run, and the review page.
7. **Approval:** only with your explicit OK, run `PUT /admin/api/schedule {"enabled":true,"acknowledgeRisk":true}`. Watch 24 hours of runs for duplicate alerts, login health and cost.

## Runbook

| Situation | Do this |
|---|---|
| `FB_LOGIN_REQUIRED` | The schedule is already paused. Start login, sign in, Complete login, run the restore test twice, then resume. |
| `FB_CHECKPOINT` | The schedule is already paused. Resolve it yourself on your own device first. Then decide whether to continue. Never automate past it. |
| `COLLECT_FAILED` repeatedly / `CIRCUIT_OPEN` | Facebook's markup may have changed. Check `GET /admin/api/runs` (per-search `NO_RESULTS`). Card parsing is in `src/marketplace/parse.ts` (a Worker deploy, no image change). In-page selectors are in `marketplace-browser/src/session.ts` (an image change). |
| `COST_GUARD` / `COST_WARN` | `GET /admin/api/usage`. Reduce `limits` (searches, scrolls, detail pages), raise `intervalHours`, or keep `basic`. |
| Too many or too few emails | `POST /admin/api/replay {"settings":{"scoring":{…}}}` first, then `PUT /admin/api/settings`. Bump `scoring.version`. Use Interested/Pass feedback as ground truth; nothing self-tunes. |
| Turn on AI triage | `PUT /admin/api/settings {"ai":{"enabled":true}}`. It is capped per run, per day and per month, and runs after alerts with the container stopped. |
| Pause everything | `PUT /admin/api/schedule {"enabled":false}` (the roundup also stops if `roundup.enabled` is false). |
| Changing the image | Bump `marketplace-browser/package.json` version **and** `MARKET_IMAGE_VERSION` together, then sign in again (the old snapshot becomes `SNAPSHOT_IMAGE_MISMATCH`). This doesn't affect WhatsApp. |

## Admin API (`/admin`, behind Access; non-GET requests need `x-requested-with: market-admin`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin` | Page: status, login console, collect, schedule, listings |
| GET | `/admin/api/status` | Phase, session health, snapshot, restore tests, schedule |
| POST | `/admin/api/login/start` · `/login/complete` | Interactive sign-in |
| GET / POST | `/admin/api/login/screen` · `/login/input` | Login console (refused once signed in) |
| POST | `/admin/api/test/restore` · `/admin/api/abort` | Restore test / stop container |
| GET/PUT | `/admin/api/searches` · `/admin/api/settings` | Searches (D1) / limits, scoring, cost, AI, roundup |
| GET/PUT | `/admin/api/schedule` | On/off (`acknowledgeRisk`), `intervalHours`, usage |
| POST | `/admin/api/collect` | `{}` live, or `{"dryRun":true}` |
| GET | `/admin/api/runs` · `/admin/api/usage` · `/admin/api/alerts` | Runs and timings, cost projection, ops alerts |
| GET | `/admin/api/listings?view=new\|alerted\|review\|interested\|dismissed\|all` | Listings with reasons |
| GET | `/admin/api/listings/<id>` | Detail: price history, notifications, feedback |
| POST | `/admin/api/listings/<id>/feedback` | `interested` / `pass` / `ignore` / `send_alert` (+ `reason`) |
| POST | `/admin/api/replay` | Re-score stored adverts under proposed settings (changes nothing) |
| POST | `/admin/api/roundup` | Send the daily roundup now (`{"dryRun":true}` to preview) |
| GET | `/admin/review/<id>` | Email review page: **display only**; buttons POST with the CSRF header, so link scanners can't vote |

## Data and privacy

- Stored: the advert ID, canonical URL, title, price and price history, location, stated year and mileage, a short description (contact details redacted, cut before seller details), the "Listed … ago" text, first and last seen, scores and reasons, alert state and your feedback.
- Not stored or logged: seller names or profiles, messages, cookies, credentials, typed login input, screenshots (shown live during login only, and refused once signed in).
- Retention: listings unseen for 90 days are deleted with their history (unless marked Interested). Run records are kept 180 days.
- AI sees only listing metadata and description (no seller data), and only for borderline adverts when enabled.

## Delivery checklist (issue #4)

| Item | State |
|---|---|
| Feasibility, Meta terms risk, quotas, isolation boundary | Documented here (separate Worker) |
| Standalone session persistence test, 2 full restore cycles | Built (`/admin/api/test/restore`); **needs running after deploy** |
| Real search pages, extraction reliability, visibility lag | Built; **selectors unverified against live Facebook**. Record findings here |
| Idempotent D1 schema, ingest, new/price-drop detection, retention | Done (migration 0004, `ingest.ts`, `repository.ts`) |
| Bounded hourly scheduler, timeout, circuit breaker, AI-free alerts, admin controls | Done |
| Actionable email with URL, first-seen-to-email latency, no ROI gate | Done (`first_seen_to_email_ms` per run); latency needs live runs |
| Works with AI, ChatGPT and Sheets unavailable | Done (AI is off by default; no ChatGPT or Sheets dependency) |
| Unit tests | 71 new tests (parser, normalisation, dupes, price drops, missing/partial, auth state, quota guard, filtering, AI fallback, roundup, feedback security, alert suppression) |
| Dry-run measurement and monthly incremental spend | Built; **needs ≥3 live dry runs** |
| No regression to WhatsApp | WhatsApp Worker, image, controller and tests unchanged; 186 existing tests pass |
| Hourly collection on | **Owner approval required** |

### Findings log (fill in during the gate tests)

| Date | Test | Result |
|---|---|---|
| | Restore test 1 | |
| | Restore test 2 | |
| | Dry run: cards read per search, `NO_RESULTS`? | |
| | Dry run: billable s, CPU s, peak memory on `basic` | |
| | Visibility lag: "Listed X ago" vs first seen | |
