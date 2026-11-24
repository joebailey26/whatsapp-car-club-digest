# Phase 5 test results

**Gate:** a manually triggered run produces a useful email from a real exported conversation.

**Verdict: PASSED (2026-11-24),** with one caveat below. A manual export run at 12:30 UTC went export → process → analyse → digest, and **sent a digest email** from `digest@joebailey.xyz` to `joe@joebailey.xyz` (Email Service returned a message ID at 12:31:15 UTC). The digest reported its coverage honestly: one group had failed to export, so it was marked *incomplete*, not "nothing happening".

**Caveat:** I can't see the inbox. Delivery past Cloudflare's acceptance (inbox vs spam) needs confirming by the recipient.

## Runs

| Run (UTC) | WhatsApp session | Group A | Group B | Digest |
|---|---|---|---|---|
| 12:30 | ✅ restored after **~19.5 h offline**, no re-link (gen 11 → 12) | ❌ `STEP_TIMEOUT` at `export#2` ("Export chat" menu item) | ✅ 182 KB; 19 new; 0 events | **Sent**, subject "… 29 November 2026 (incomplete)" |
| 12:39 | ✅ (gen 12 → 13) | ✅ 975 KB; 61 new, 62 dup; 0 events | ✅ 0 new, 19 dup | **`skipped_already_sent`**: no duplicate email |

What the 12:31 email contained (stored at R2 `digests/2026-11-29/`):

> **No upcoming meets were identified in the groups that were checked, but 1 of 2 group(s) could not be fully checked.**
> *Incomplete coverage: … Example Club Chat.*
> Groups checked: ⚠️ Example Club Chat: Not checked, export failed · ✅ Example Owners Group: Checked 298 new messages

No upcoming events were found because the analysis this week found none. On 2026-11-23, 550+ messages produced no future-dated meets; the only one mentioned had been on 21 Nov.

## Fixes made during the gate

| Issue | Fix |
|---|---|
| Coverage showed only the latest run's new-message count (Group A "2" instead of 358) | New messages are now summed across every run since the previous digest; status still comes from the latest run (tested) |
| Group A export timed out clicking the menu item (passed on 3 earlier runs) | Flow v4 waits for the `Export chat` menu item and pauses 3 s after opening a chat (data-only change). The controller retries a group **once** when a UI step times out **before any download** (never for login, wrong chat or corrupt download; tested). The 12:39 run passed first time |

## Delivery setup

- **Cloudflare Email Service (Email Sending, beta):** `joebailey.xyz` onboarded 2026-11-24 with the user's approval. The records added were on `cf-bounce.joebailey.xyz` only: MX ×3, SPF and DKIM.
- **Existing records:** the DMARC record (`p=reject` plus `rua` reporting) was checked straight after activation and is unchanged and still single. The root SPF and Email Routing MX are unchanged.
- **Binding** `send_email: EMAIL`, locked to one sender and one recipient (`allowed_sender_addresses: [digest@joebailey.xyz]`, `allowed_destination_addresses: [joe@joebailey.xyz]`), so a bug can't email anyone else.
- **Quota:** Workers Paid includes 3,000 emails a month; this uses about 4–5.

## Digest behaviour (unit-tested, 18 Phase 5 tests)

| Spec requirement | Implementation |
|---|---|
| Prioritise upcoming, sort by date | Sorted by date and then time; undated events last; past events excluded |
| Highlight changes since the last digest | Revisions after the previous *sent* digest, described as "Time changed from 09:00 to 10:00", "Conflicting venue mentioned: A vs B" |
| Deadlines and responses | "Action required": *"Members asked to reply or book by Fri 27 Nov"* |
| Consolidate across groups; provenance | One item per event, with provenance per group: "Example Owners Group, last mentioned Sat 21 Nov" |
| Flag tentative or uncertain items | Badges (Tentative, Check the chat) plus explanatory lines |
| Don't imply RSVP | Wording never says "you're going"; the footer says the digest doesn't mean you have replied or booked |
| Nothing found | A concise line, only when every enabled group was fully checked |
| **Incomplete coverage** | Named in the headline, an amber banner and the subject `(incomplete)`. A group with no run, failed export, processing or analysis, or a spent budget all count as incomplete. No groups at all is never "complete" |
| No transcripts or attachments | None. No remote images or links. Every message-derived string is HTML-escaped (an XSS test covers it) |
| Store before sending | `digests/<key>/digest.json`, `digest.md`, `email.html` and `email.txt` are written to R2 first (90-day lifecycle) |
| Email errors tracked separately | D1 `digests` row: `rendered → sending → sent/failed`, with attempts, `last_error` (an `E_*` code) and message ID. The recipient is stored only as a SHA-256 hash |
| No duplicate digest emails | One digest per key (the Sunday the week runs up to). Later runs skip it; `force` overrides |
| Retry a failed email without re-exporting | `POST /admin/api/digest {"resend":true}` re-sends the stored rendering |
| Preview | `GET /admin/digest/<key>` serves the stored HTML under a no-script CSP |

## Corrected digest (2026-11-24 12:47 UTC)

The recipient confirmed the 12:31 email arrived and approved a forced re-send. `POST /admin/api/digest {"force":true}` rebuilt the digest from the 12:39 run, in which both groups succeeded. It was sent (attempt 2, new message ID) with **coverage complete**: "No upcoming meets or actions were identified in the groups this week." Group A shows 419 new messages checked (356 + 2 + 61) and Group B 298.
