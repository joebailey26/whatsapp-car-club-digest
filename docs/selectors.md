# WhatsApp Web selectors

Defined in `browser/src/state.ts`. Each one is either **verified** (observed on the real interface, with the date) or **candidate** (unconfirmed). Only element presence is ever checked; text is never read.

| Name | Selector | State | Status |
|---|---|---|---|
| `qr_canvas_aria` | `canvas[aria-label*="QR" i]` | qr | ✅ verified 2026-11-23 (login page) |
| `qr_canvas_aria_scan` | `canvas[aria-label*="scan" i]` | qr | ✅ verified 2026-11-23 (login page) |
| `qr_data_ref` | `div[data-ref] canvas` | qr | ✅ verified 2026-11-23 (login page) |
| `progress` | `progress` | loading | ✅ verified 2026-11-23 (shown briefly before the QR code) |
| `chat_list_aria` | `[aria-label="Chat list" i]` | authenticated | ✅ verified 2026-11-23 (logged-in app) |
| `chat_list_grid` | `[role="grid"][aria-label*="chat" i]` | authenticated | ✅ verified 2026-11-23 (logged-in app) |
| `chat_pane_id` | `#pane-side` | authenticated | ✅ verified 2026-11-23 (logged-in app) |
| `url_not_login` | page URL is on web.whatsapp.com but not `/login/` | authenticated (fallback) | ✅ login route verified 2026-11-23. Used only when no QR code is visible, loading has finished, and the state holds for 3 polls. |

Unauthenticated browsers are redirected to `https://web.whatsapp.com/login/`.

All four authenticated signals matched during pairing and both restore tests on 2026-11-23. Re-verify if WhatsApp changes its interface; a sudden run of `STATE_INDETERMINATE` results is the usual sign.

## Export flow selectors

These are verified selectors for the export click path, stored as data rather than in the image. See [export-flow.json](export-flow.json) and the table in [phase2-test-results.md](phase2-test-results.md#interface-facts-verified-during-discovery).
