# Phase 6 results

**Gate:** two consecutive scheduled weekly runs succeed without manual intervention.

**Verdict: PENDING.** It can't be met before **Sun 6 Dec 2026**. Everything is built, deployed and verified, and the schedule is **enabled** (approved by the owner 2026-11-24 13:29 UTC). The gate is met when these two runs both report success with no manual steps:

| Scheduled run | UTC | Expected | Result |
|---|---|---|---|
| Sun 29 Nov 2026, 09:00 UK | 09:00 | export → process → analyse → digest sent | _pending_ |
| Sun 6 Dec 2026, 09:00 UK | 09:00 | same | _pending_ |

Check with `GET /admin/api/schedule` (`lastKey`, `lastResult`), `GET /admin/api/exports`, `GET /admin/api/digests` and `GET /admin/api/alerts`. Record the results here.

## Verified on 2026-11-24

| Check | Evidence |
|---|---|
| Cloudflare cron → Worker `scheduled()` → controller | A temporary `*/2 * * * *` cron fired at 13:24:54 and 13:26:54 UTC (`wrangler tail`), and the controller returned `ignored:unknown_cron` as designed. The temporary cron was then removed |
| Registered triggers | Dashboard: `0 8 * * SUN`, `0 9 * * SUN` (next run 29 Nov), `30 6 * * *` (watchdog, next 25 Nov 06:30) |
| 09:00 London across GMT/BST | Unit tests cover winter, summer and both clock-change Sundays. Live simulation: Sun 29 Nov 08:00Z is ignored, 09:00Z gives `would_start`; summer Sun 08:00Z gives `would_start`; Saturday is ignored |
| Disabled means no run | Simulated while disabled: `skipped:disabled` |
| Run once per Sunday | The tick records `lastKey` (the London date); a second tick that day gives `skipped:already_ran_today` |
| Scheduled digest sends even if a manual digest went earlier in the week | Covered by `sentBeforeToday()`. This week's manual sends (24 Nov) won't block Sunday's digest |
| Alert delivery | `POST /admin/api/alerts/test` sent at 13:29:51 UTC |
| Session longevity | The 24 Nov 12:30 export restored a session last saved about 19.5 h earlier, with no re-link |
| Tests | 147/147 pass (13 Phase 6 tests) |

## What runs automatically

| When | What |
|---|---|
| **Sunday 09:00 UK** | If enabled and not already run that day: restore the WhatsApp snapshot, export every enabled group, process, analyse and **email the digest**. Each group retries once on a UI timing failure. Alerts are sent for anything that failed |
| **Daily 06:30 UTC** | Watchdog. It alerts if re-linking is needed, if the snapshot expires within 7 days, or if no digest has been sent for 8+ days while the schedule is on. It also applies retention |
| **Each run** | AI tokens are added to a monthly total, with an alert above `AI_MONTHLY_TOKEN_ALERT` (2,000,000) |

### Alerts (email to `ALERT_TO`, at most once per issue per 24 h, no message content)

| Code | Raised when | What to do |
|---|---|---|
| `RELINK_REQUIRED` | WhatsApp showed the QR screen | Pair again from `/admin` |
| `SESSION_FAILED` | The session couldn't start for another reason | Run the restore test; check status |
| `EXPORT_FAILED` | One or more groups weren't exported (after the retry) | Usually a WhatsApp UI change: inspect and update the flow |
| `PROCESSING_FAILED` | An export couldn't be read | Reprocess from R2 once fixed |
| `ANALYSIS_FAILED` | AI analysis failed, was partial, or ran out of budget | Re-run analysis; check budgets |
| `DIGEST_SEND_FAILED` | The email couldn't be sent | `POST /admin/api/digest {"resend":true}` |
| `OP_FAILED` | A job hit its deadline or was interrupted | Check status; re-run manually |
| `SCHEDULED_RUN_SKIPPED` | The Sunday tick found the controller busy | Start an export manually once it's idle |
| `MISSED_WEEKLY_RUN` | No digest sent for 8+ days while enabled | Check the cron triggers and status |
| `SNAPSHOT_EXPIRING` | The saved session expires within 7 days | Run the restore test (weekly runs refresh it) |
| `AI_USAGE_HIGH` | Monthly AI tokens are above the threshold | Check for repeated manual runs |

### Retention (applied daily)

| Data | Kept |
|---|---|
| Raw exports and `messages.json` (R2 `exports/`) | 30 days (R2 lifecycle) |
| Digests (R2 `digests/`) | 90 days (R2 lifecycle) |
| Dedup index (`messages_seen`) | 60 days (pruned on processing) |
| Events, with their sources and revisions | Until 120 days after the event date |
| D1 `runs` and `exports` rows | 180 days |
| Snapshot | Superseded weekly; unreferenced snapshots expire after 30 days (Cloudflare) |

## Known limits

- **Two flows can't both be confirmed today:** an alert actually firing from a *real* failed scheduled run (the logic is unit-tested and delivery was tested), and the watchdog's first real tick (due 25 Nov 06:30 UTC).
- **The admin page** still shows only the Phase 1 controls. Phases 2–6 are operated through the admin API (`/admin/api/*`), which is Access-protected.
- **Beta features:** Container snapshots and Email Sending are both in public beta. Breaking changes on Cloudflare's side would show up as `SESSION_FAILED`, `RESTORE_START_FAILED` or `DIGEST_SEND_FAILED` alerts.
