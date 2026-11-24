# WhatsApp Car Club Digest

A weekly email digest of selected WhatsApp car club groups, running entirely on Cloudflare. It lets you mute busy groups without missing meets, changes, cancellations, anything you need to reply to, or cars and parts members are selling.

**Status: live.** The weekly schedule was switched on 2026-11-24, and the first scheduled run is Sunday 29 Nov 2026. Every Sunday at 09:00 UK time it:
1. restores a linked WhatsApp Web session;
2. exports the configured groups with WhatsApp's own *Export chat*;
3. parses and deduplicates the messages;
4. extracts events and sale listings with Workers AI;
5. emails a digest.

Failures send an alert email. Phases 1–5 have passed their gates. Phase 6's gate (two scheduled runs without help) completes after the runs on 29 Nov and 6 Dec ([results](docs/phase6-results.md)).

> **Account risk.** WhatsApp does not authorise arbitrary browser automation. Even once a week, automating WhatsApp Web could breach its terms or get the account restricted. Use only your own linked account, and stop at the first warning. Group members' messages are personal data, so tell the groups that a digest is being produced.

## How it works

```
Cron (Sun 08:00 + 09:00 UTC, daily 06:30 UTC)
  │ scheduled()
  ▼
Worker ──► BrowserController (Durable Object, single instance)
              │ 1. restore container from snapshot
              ▼
           Container (standard-2): Xvfb + Chromium + Puppeteer
              │ 2. WhatsApp Web → Export chat per group → ZIP
              ▼  3. re-snapshot, stop container
           R2 exports/<group>/<time>/original.zip
              │ 4. unzip → parse → normalise → window → dedupe   (D1 messages_seen)
              ▼
           R2 …/messages.json (new messages flagged)
              │ 5. Workers AI (gpt-oss-120b), two calls per chunk: events + sale listings
              │    → validate → ground → reconcile  (D1 events, listings)
              ▼
           6. Digest → R2 digests/<Sunday>/ → Email Service → you
           7. Alerts for anything that failed
```

**One weekly run:**

- **Restore.** The controller starts a fresh container from the latest snapshot, which holds the linked Chromium profile. It checks WhatsApp opened without a QR code, and stops with a re-link alert if not.
- **Export.** For each enabled group it searches for the chat, verifies the header, opens the menu, picks *Export chat* → *All messages* → *Export*, captures the download, checks the ZIP and stores it in R2. One retry is allowed per group, for UI timing only.
- **Re-snapshot.** It re-checks the login, closes Chromium cleanly, snapshots the profile (WhatsApp's device state moves on every session) and stops the container. This takes about 3–4 minutes of container time.
- **Process.** Parsing detects date order per file, converts times to UTC and replaces phone-number authors with keyed pseudonyms. Messages since the last export (with one day of overlap) are kept, and stable message IDs remove duplicates.
- **Analyse.** New messages go to Workers AI as untrusted data. Every extracted date, time, venue, price, deadline and RSVP must be traceable to the cited message text, or it's dropped. Events are matched and updated in D1, with revision history. Conflicting details are flagged for review, never silently overwritten.
- **Sales.** A separate call finds members selling their own car or parts, plus price changes and "sold" updates. A listing needs sale wording in the message ("for sale", "ono", "£15 + postage"…), and every price, year, mileage and location must appear in it. Listings are matched per seller, so only the seller can mark their item sold. Details: [docs/sales-results.md](docs/sales-results.md).
- **Digest.** The email covers upcoming meets, changes, actions needed, cancellations, a **For sale** section (new cars, new parts, price changes, sold) and coverage per group. If any group couldn't be fully checked, the email says so. It's sent once per week.

## Operating it

The admin UI and API are at `https://whatsapp-car-club-digest.joebailey.workers.dev/admin`, behind Cloudflare Access (one allowed email). The page itself only has the pairing and restore-test buttons. Everything else is the admin API below, which you can call from the browser console while signed in. POST and PUT need the header `x-requested-with: digest-admin`.

### Schedule

| | |
|---|---|
| Status, next run, last result, AI tokens this month | `GET /admin/api/schedule` |
| Pause / resume | `PUT /admin/api/schedule` `{"enabled": false}` / `{"enabled": true}` |
| What would the cron do at a given time? | `POST /admin/api/schedule/simulate` `{"at":"2026-11-29T09:00:00Z"}` (changes nothing) |

Two UTC crons fire on Sundays (08:00 and 09:00), and only the one that is 09:00 in London acts, so the time stays right through GMT and BST. A run starts at most once per Sunday. The scheduled digest is sent even if a manual one went out earlier that week.

### Checking a run

`GET /admin/api/exports` (per-group export, processing and analysis), `GET /admin/api/digests` (delivery), `GET /admin/api/events` (what the AI found), `GET /admin/api/alerts`, and `GET /admin/digest/<YYYY-MM-DD>` to view a stored digest.

### Runbook

| Situation | Do this |
|---|---|
| **"WhatsApp needs re-linking" alert** | 1. Pause the schedule if a Sunday is close.<br>2. On your phone, open WhatsApp → Linked devices and log out the old device.<br>3. On `/admin`, press **Start pairing**, scan the QR code and press **Complete pairing**. Keep "Stay logged in" ticked.<br>4. Press **Run restore test**.<br>5. Resume the schedule. |
| **"Group export failed", repeatedly** | WhatsApp Web has probably changed. `POST /admin/api/inspect` runs flow steps and returns a redacted list of the UI. Fix the selectors with `PUT /admin/api/flow`; no deploy or re-pair is needed. Keep [docs/export-flow.json](docs/export-flow.json) in sync. |
| **Digest not sent** | `GET /admin/api/digests` for the error, then `POST /admin/api/digest {"resend":true}` (no re-export). |
| **Run a week by hand** | `POST /admin/api/export` runs export → process → analyse → digest. This week's digest is skipped if it was already sent. |
| **Correct this week's digest** | `POST /admin/api/digest {"force":true}`. This rebuilds the digest and sends a second email. |
| **Reprocess without WhatsApp** | `POST /admin/api/process` / `POST /admin/api/analyse` with `{"runId":"…"}`. To re-check specific days: `POST /admin/api/analyse {"exportId":"…","from":"YYYY-MM-DD","to":"YYYY-MM-DD"}`. The run then lists rejected listings with reasons in `listingsRejectedDetail`. |
| **Backfill older messages** | `POST /admin/api/process {"windowFrom":"YYYY-MM-DD"}` then `POST /admin/api/analyse`. Exports hold the full chat history (R2 keeps them 30 days), so this re-reads messages before the normal weekly window. |
| **Snapshot expiring** | Run the restore test. Any successful run refreshes the 30-day TTL. |
| **Pause everything** | `PUT /admin/api/schedule {"enabled":false}` |
| **Deploying** | Check `GET /admin/api/status` shows `phase: idle` first. A deploy restarts the controller, so a job in progress is interrupted and raises an `OP_FAILED` alert. |

### Alerts

Alerts are plain-text emails to `ALERT_TO`, at most one per issue per 24 hours, with no message content:

| Code | When |
|---|---|
| `RELINK_REQUIRED` | WhatsApp showed the QR code |
| `SESSION_FAILED` | The session couldn't start for another reason |
| `EXPORT_FAILED` | A group couldn't be exported, after its one retry |
| `PROCESSING_FAILED` | An export couldn't be read |
| `ANALYSIS_FAILED` | Analysis failed, was partial, or ran out of budget |
| `DIGEST_SEND_FAILED` | The email couldn't be sent |
| `OP_FAILED` | A job hit its deadline or was interrupted |
| `SCHEDULED_RUN_SKIPPED` | The controller was busy at the scheduled time |
| `MISSED_WEEKLY_RUN` | No digest for over 8 days while the schedule is on |
| `SNAPSHOT_EXPIRING` | The saved session expires within 7 days |
| `AI_USAGE_HIGH` | Monthly AI tokens are above `AI_MONTHLY_TOKEN_ALERT` |

The daily watchdog (06:30 UTC) raises the session, snapshot and missed-run alerts, and applies retention.

## Configuration

| Where | What |
|---|---|
| Durable Object storage (`PUT /admin/api/groups`) | The groups to export: `{"groups":[{"id":"group-a","name":"<exact WhatsApp name>","enabled":true}]}`. Names stay out of the repo. |
| Durable Object storage (`PUT /admin/api/flow`) | The export click path, as data. The verified current version is [docs/export-flow.json](docs/export-flow.json) (v4). |
| Durable Object storage (`PUT /admin/api/schedule`) | Schedule on/off |
| Secret `PSEUDONYM_KEY` | HMAC key for phone-number pseudonyms. Rotating it changes every message ID, so clear `messages_seen` at the same time. |
| `wrangler.jsonc` vars | See below |

| Var | Value / purpose |
|---|---|
| `BROWSER_IMAGE_VERSION` | Must equal `browser/package.json` version (currently `0.3.0`). Snapshots are tied to it. |
| `CONTAINER_INSTANCE` | `standard-2` (`standard-1` was CPU-starved) |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ADMIN_EMAILS` | Cloudflare Access verification for `/admin` (fails closed if unset) |
| `PAIRING_TTL_MS`, `POST_AUTH_SETTLE_MS`, `RESTORE_SETTLE_MS`, `OP_DEADLINE_MS` | Timeouts |
| `EXPORT_TIMEZONE`, `EXPORT_DATE_ORDER_HINT` | `UTC`, `MDY`: the container exports in UTC with en-US dates |
| `AI_MODEL`, `AI_MAX_CHUNKS_PER_RUN`, `AI_MAX_TOKENS_PER_RUN`, `AI_MONTHLY_TOKEN_ALERT` | `@cf/openai/gpt-oss-120b`, plus per-run and monthly caps |
| `DIGEST_FROM`, `DIGEST_TO`, `ALERT_TO`, `WORKER_URL` | `digest@joebailey.xyz` → `joe@joebailey.xyz` |

The `send_email` binding is locked to that one sender and one recipient.

## Admin API

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin` | Admin page (pairing, restore test) |
| GET | `/admin/api/status` | Phase, session health, snapshot, restore tests, build |
| POST | `/admin/api/pairing/start` · `/pairing/complete` | Pair WhatsApp |
| GET | `/admin/api/pairing/screen` | QR screenshot (refused once logged in) |
| POST | `/admin/api/test/restore` | Restore from snapshot and check the login persists |
| POST | `/admin/api/abort` | Stop the container now |
| GET/PUT | `/admin/api/groups` · `/admin/api/flow` | Groups and export flow |
| POST / GET | `/admin/api/inspect` · `/admin/api/inspection` | Redacted UI inspection (selector discovery) |
| POST / GET | `/admin/api/export` · `/admin/api/exports` | Run an export / recent runs with per-group results |
| POST | `/admin/api/process` · `/admin/api/analyse` | Reprocess / re-analyse stored exports |
| POST / GET | `/admin/api/ai/eval` | Run / read the fictional model evaluation |
| GET | `/admin/api/events` | Upcoming and undated events |
|  | D1 `listings` (via `pnpm exec wrangler d1 execute`) | Sale listings (no admin endpoint yet) |
| POST / GET | `/admin/api/digest` · `/admin/api/digests` | Build and send (`dryRun`/`resend`/`force`) / delivery log |
| GET | `/admin/digest/<YYYY-MM-DD>` | Stored digest preview (no-script CSP) |
| GET/PUT | `/admin/api/schedule` · POST `/admin/api/schedule/simulate` | Schedule |
| GET / POST | `/admin/api/alerts` · `/admin/api/alerts/test` | Alert log / test delivery |

## Safeguards

| Area | Safeguard |
|---|---|
| WhatsApp account | Headful Chromium with no user-agent spoofing or stealth plugins. One session a week. A login failure is reported, never retried. Messages are never sent. |
| Session | The snapshot is replaced after every session and older ones are never restored. A snapshot from a different image is refused (`SNAPSHOT_IMAGE_MISMATCH`). The container can't outlive its job: inactivity timeout, a pending `monitor()`, and an 11-minute deadline. |
| Personal data | Phone numbers become HMAC pseudonyms before storage or AI. D1 holds no message text. Logs carry codes and counts only. UI inspection is redacted twice, so chat rows and names are excluded. Screenshots are refused once chats are visible. |
| AI output | Zod-validated, grounded in the cited message text, cancellations proven, injection-only sources rejected, conflicts flagged for review. Model chosen on a 12-case fictional evaluation ([phase 4](docs/phase4-test-results.md)). |
| Digest | HTML-escaped, no remote resources or transcripts. Never says "nothing happening" when coverage is incomplete. Sent once per week. |
| Admin | Cloudflare Access plus in-Worker JWT verification, an email allowlist and a CSRF header. Fails closed. |

## Setting up from scratch

**Prerequisites:**
- Cloudflare **Workers Paid**.
- A Zero Trust team (the free tier is fine).
- A domain on Cloudflare DNS for sending email.
- Node.js 24 (see `.nvmrc`) with pnpm 10 (`corepack enable`).
- **Docker Desktop running**, because Wrangler builds the image.
- WhatsApp on your phone.

**Steps:**

1. **Install, test and deploy:**
   ```bash
   pnpm install
   ```
   ```bash
   pnpm --dir browser install
   ```
   ```bash
   pnpm test
   ```
   ```bash
   pnpm exec wrangler deploy
   ```
   The first deploy builds and pushes the image, which takes a few minutes. `/admin` answers `503 ACCESS_NOT_CONFIGURED` until step 3.
2. **Create storage and the pseudonym secret.** Create the R2 bucket `whatsapp-digest`, with lifecycle rules `exports/` 30 d and `digests/` 90 d, and the D1 database `whatsapp-digest`. Put the D1 database ID in `wrangler.jsonc`. Then:
   ```bash
   pnpm exec wrangler d1 migrations apply whatsapp-digest --remote
   ```
   ```bash
   openssl rand -hex 32 | pnpm exec wrangler secret put PSEUDONYM_KEY
   ```
3. **Protect `/admin`.** Go to Worker → **Access** → *Protect this Worker behind Access* → **All traffic**, with a policy allowing only your email. Copy the AUD tag and team domain into `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN` (optionally `ADMIN_EMAILS`) and redeploy.
4. **Set up email.** Go to **Compute → Email Service → Email Sending → Onboard Domain**. This adds MX, SPF and DKIM records on `cf-bounce.<domain>`. It also lists a `_dmarc` record. On joebailey.xyz the existing DMARC record was left unchanged, but check yours afterwards. Then set `DIGEST_FROM`, `DIGEST_TO`, `ALERT_TO` and the binding's `allowed_*` lists, and redeploy.
5. **Pair WhatsApp.** On `/admin`, press **Start pairing**, then on your phone go to WhatsApp → Settings → Linked devices → Link a device and scan the QR code. Press **Complete pairing**, then **Run restore test**.
6. **Add groups and the flow:** `PUT /admin/api/groups`, then `PUT /admin/api/flow` with the contents of [docs/export-flow.json](docs/export-flow.json).
7. **First run:** `POST /admin/api/export`, then check `/admin/api/exports` and your inbox.
8. **Turn on the schedule:** `PUT /admin/api/schedule {"enabled":true}`.

## Updating the container image

Most changes don't touch the image. Selector and flow fixes are data (`PUT /admin/api/flow`), and all Worker code (processing, AI, digest, alerts) deploys without affecting the WhatsApp session. If `browser/` must change:

1. Bump `browser/package.json` → `version` **and** `BROWSER_IMAGE_VERSION` together.
2. Pause the schedule.
3. Deploy. The old snapshot becomes `UNUSABLE: SNAPSHOT_IMAGE_MISMATCH`.
4. Pair again and remove the old linked device on your phone.
5. Run the restore test, then resume the schedule.

## Cloudflare limitations

These come from the Cloudflare docs as of November 2026. **Container snapshots and Email Sending are both in public beta.**

- **Snapshot rules:**
  - Snapshots need the `durable_object` scheduling policy, which can't be changed later.
  - The `@cloudflare/containers` helper class doesn't support that policy, so the raw `ctx.container` API is used.
  - A snapshot captures the filesystem only, not processes, which is why Chromium is closed before each snapshot.
  - Each snapshot is immutable and tied to its image.
  - It expires 30 days after creation or its last restore.
- **No snapshot list, delete or jurisdiction controls.** The controller tracks the current handle, and superseded snapshots expire on their own.
- **Containers run wherever Cloudflare places them.** This one has run in **US/California**, so WhatsApp sees a US datacenter IP. Workers AI has no documented region guarantee either. Mention processing outside the UK in any notice to group members.
- **Idle containers get stopped.** The platform stops an idle container, and an evicted Durable Object takes its container with it. Handled with `setInactivityTimeout` plus a pending `monitor()`.
- **Workers AI** has zero data retention and doesn't train on prompts for these Cloudflare-hosted models. The model is configurable.
- **Email Sending** is transactional only, with 3,000 emails a month included on Workers Paid.

## Costs

The expected incremental cost is effectively £0, but not guaranteed. A weekly run uses:
- **Containers:** about 3–4 minutes on `standard-2`.
- **Workers AI:** about 70k tokens (events + listings calls), roughly 3k neurons, inside the free 10k a day.
- **Email:** 1 email, plus any alerts.
- **Storage:** a few MB of R2 and a small D1.

All of this is within Workers Paid allowances. The `AI_USAGE_HIGH` alert and the dashboard usage pages are the guardrails.

## Data retention and deletion

| Data | Where | Kept |
|---|---|---|
| Raw exports, normalised messages | R2 `exports/` | 30 days |
| Digests | R2 `digests/` | 90 days |
| Dedup index (IDs and timestamps only) | D1 `messages_seen` | 60 days |
| Events, evidence excerpts, revisions | D1 | Until 120 days after the event |
| Sale listings, evidence excerpts, revisions | D1 | 90 days after last seen |
| Run and export metadata | D1 | 180 days |
| WhatsApp session | Container snapshot | Replaced weekly; old ones expire after 30 days |

To delete everything:
1. **Unlink the device on your phone** (Linked devices → Log out). This invalidates every snapshot.
2. Pause the schedule.
3. Empty the R2 bucket.
4. `pnpm exec wrangler d1 delete whatsapp-digest`.
5. `pnpm exec wrangler delete`, which removes the Worker and its Durable Object state.
6. Remove the domain from Email Sending, which also removes the `cf-bounce` records.

## Project history

Built in phases against an engineering spec, with each phase gated on real tests:

| Phase | Result |
|---|---|
| 1. Authentication persistence | ✅ The session survived complete container shutdown and restore ([results](docs/phase1-test-results.md)) |
| 2. Export automation | ✅ Two successful exports across separate starts ([results](docs/phase2-test-results.md), [selectors](docs/selectors.md)) |
| 3. Parsing and deduplication | ✅ Real exports deduplicated exactly ([results](docs/phase3-test-results.md)) |
| 4. AI event extraction | ✅ gpt-oss-120b 11/12, all safety cases pass ([results](docs/phase4-test-results.md)) |
| 5. Weekly digest | ✅ A real digest was emailed ([results](docs/phase5-test-results.md)) |
| 6. Schedule and operations | ⏳ Live; the gate needs the 29 Nov and 6 Dec runs ([results](docs/phase6-results.md)) |
| + Car sales listings | ✅ 5/5 sales cases on repeat runs, no false listings; a real-data false negative found and fixed ([results](docs/sales-results.md)) |

Deviations from the spec:
- **No date range in the export dialog.** The flow exports *All messages*, and the date window is applied in processing.
- **Date order and timezone.** Exports use the container's en-US locale and UTC, not UK formats.
- **No AI similarity.** Event matching is deterministic only.

## Repository layout

```
src/index.ts                  Worker entry: /admin (Access-protected) + scheduled() cron handler
src/api/                      Access JWT check, admin API routes, minimal admin page
src/container/controller.ts   BrowserController Durable Object: container lifecycle, snapshots, all ops,
                              schedule tick, watchdog, alerts
src/container/lifecycle.ts    Pure state/decision logic
src/container/sanitize.ts     Redaction of UI inspection output
src/config/                   Zod schemas (groups, flow, steps) and flow templating
src/exports/                  ZIP reader, transcript parser, normalisation, processing, R2 store
src/ai/                       Workers AI extraction (events + sale listings), grounding, reconciliation,
                              analysis, evaluation set
src/events/                   D1 repositories: events and sale listings
src/digest/                   Digest model (incl. For sale section), rendering, data loading, delivery
src/ops/                      Weekly schedule slot logic, operational alerts
browser/                      Container image: Xvfb + Chromium + Puppeteer, data-driven step driver,
                              redacted inspection, CDP download capture
migrations/                   D1 schema
tests/                        Vitest unit tests (181) + fictional fixtures
docs/                         Phase results, verified selectors, verified export flow
```

## License

[MIT](LICENSE) © Joe Bailey: free to copy, change and use however you like, as long as you keep the copyright and license notice crediting Joe Bailey.
