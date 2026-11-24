# Phase 2 test results

**Gate:** one complete group export succeeds twice, across separate container starts, without relinking WhatsApp.

**Verdict: PASSED (2026-11-23).** `group-a` exported successfully in two runs, each a separate container started from its own snapshot (17:00 and 17:06 UTC). The session stayed paired throughout, with snapshot generations advancing up to gen 11. On the second run `group-b` succeeded too.

## Export runs (image 0.2.0, `standard-2`)

| Run (UTC) | Flow | group-a | group-b | Notes |
|---|---|---|---|---|
| 16:46 | v1 | ❌ `STEP_TIMEOUT @export#3` | ❌ `STEP_TIMEOUT @openChat#1` | No "Without media" option exists; the export dialog stayed open and blocked the next group |
| 16:59 | v2 | ✅ 956 KB zip | ❌ `STEP_TIMEOUT @openChat#1` | Search box loses its `aria-label` once it contains text |
| 17:06 | v3 | ✅ 957 KB zip | ✅ 177 KB zip | **Gate run 2** |

Each failure was recorded per group, with its step and error code. No group was silently skipped, and every session re-snapshotted, even when its work failed.

## Stored exports (verified 2026-11-23)

- **R2 location:** each export is at `exports/<groupId>/<UTC stamp>/original.zip`, with a `metadata.json` beside it that holds no group name.
- **Contents:** each ZIP contains one `.txt` transcript and one `.md` rendering of the same chat. There's no media. Both pass `zipfile.testzip()`. The R2 object sizes and SHA-256 hashes match the recorded metadata.
- **Lifecycle:** the bucket is private, and its rule expires `exports/` after 30 days.

## Interface facts verified during discovery

These were checked by redacted inspection: element presence and labels only.

| Item | Finding |
|---|---|
| "What's new" dialog | May appear after login; dismissed with an optional click on `::-p-aria(Close)` |
| Search box | `input[aria-label="Search or start a new chat"]` while empty. The label **disappears once it has text**, so the flow uses `input[role="textbox"][type="text"]` |
| Chat row | `#pane-side span[title="<exact name>"]` |
| Chat verification | `[data-testid="conversation-info-header"]` contains the group name. `#main header span[title=…]` does **not** match |
| Chat menu | `#main header ::-p-aria(Menu)`. The sidebar has its own "Menu", so it must be scoped to `#main header` |
| Menu item | `menuitem` "Export chat". The menu also offers Group info, Search, Select messages, Mute, Chat theme, Favourites, Add to list, Close chat, Clear chat, Exit group |
| Export dialog | `h1` "Export chat"; radio 1 "All messages" (default); radio 2 is a date range that reveals `input[type=date]` fields `data-testid="export-start-date"` / `"export-end-date"`; Cancel and Export buttons. **No media option** |
| Download | One `.zip` per export, captured through CDP |
| Timing | After opening a chat, the header menu needs about 2 s before it responds |

The full verified flow is in [export-flow.json](export-flow.json). It's stored in the Durable Object and set with `PUT /admin/api/flow`.

## Deviations from the spec

1. **No date range is selected in the dialog.** WhatsApp Web does offer one, but its fields are native `<input type="date">`. With image 0.2.0, typing into them was unreliable in a local test: depending on the field width, either nothing was entered or the wrong date was (`16/11/2026` became `2026-12-11`). The flow therefore exports **All messages**, and the date window (since the last success, with a one-day overlap) is applied during Phase 3 processing.
   - `metadata.json`'s `dateFrom` and `dateTo` are that **processing window**, not the extent of the export.
   - Fix: add a dedicated `setDate` driver step at the next image change. An image change forces re-pairing, so bundle it with other image work.
2. **The export includes a `.md` file** alongside the `.txt`, which the spec doesn't mention. Phase 3 parses the `.txt`.

## Incidents found and fixed during Phase 2

| Issue | Cause | Fix |
|---|---|---|
| Linked session lost twice during re-pairing | 1) The platform stops an idle container (SIGTERM) about 40 s after its last inbound request; 2) the Durable Object was evicted between sparse polls from a background tab, taking the container with it | `setInactivityTimeout` after each start, plus a pending `monitor()` call for the container's lifetime (this blocks eviction for up to 15 min). Verified: an idle pairing container survived 4+ minutes with no requests |
| Chromium CPU-starved | `standard-1` is 1/2 vCPU; p90 CPU was 117% | Moved to `standard-2` (1 vCPU, 6 GiB). Instance size doesn't affect snapshots |
| Participants' names appeared in an inspection result | Avatar buttons labelled "Open chat details for <name>" in the message list passed the in-container filter | `sanitizeUi` in the Worker drops them before storage and again on read. A unit test covers it, and the stored result was overwritten |
| New Worker code not yet live on the running Durable Object straight after deploy | Deploy propagation to the running instance | A build marker in `/admin/api/status` (`build`) confirms which code is running |

## Observations relevant to risk and cost

- The container runs in **US/California** (`$cf.country=US, regionCode=CA`), even though requests come in through LHR. WhatsApp therefore sees the linked device on a US datacenter IP while the phone is in the UK. Containers have no region setting. No warning has been seen so far.
- The snapshot grew from 12 MB to 140 MB after re-pairing, presumably because more chat history is cached locally. It's well within the 20 GB limit.
- A complete two-group export run takes about 2–3 minutes of container time on `standard-2`.
