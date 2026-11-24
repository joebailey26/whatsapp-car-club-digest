# Phase 1 test results

The gate: WhatsApp Web authentication survives a complete container shutdown and a restore from a snapshot, at least twice in a row, without another QR scan.

## Verified locally on 2026-11-23 (Docker Desktop, linux/amd64 image `0.1.0`)

These checks confirm the browser container works. They are **not** the gate: no WhatsApp account was linked, and no Cloudflare snapshot was involved.

| Check | Result |
|---|---|
| Image builds (`node:22-bookworm-slim`, Debian Chromium, Xvfb) | ✅ |
| Wrangler dry-run deploy: config valid, `BrowserController (durable_object)` recognised | ✅ |
| Control API rejects requests without `CONTROL_TOKEN` (401) | ✅ |
| Chromium launches headful under Xvfb | ✅ about 1.5 s |
| WhatsApp Web loads and settles on the QR pairing screen, not an "unsupported browser" page | ✅ `state: qr` within about 3 s |
| "Stay logged in on this browser" is ticked by default | ✅ seen in screenshot |
| Graceful `POST /session/close` | ✅ |
| Filesystem-only restore simulated with `docker commit` after an **ungraceful** stop (3 stale `Singleton*` locks in the profile) | ✅ locks cleared; Chromium relaunched on the restored profile on a new host |
| SIGTERM closes Chromium, then exits 0 | ✅ |
| Unit tests (`npm test`) | ✅ 37/37 |
| Unauthenticated page never misread as logged in: 3 fresh launches, each settled as `qr` (the state must hold for 3 consecutive polls) | ✅ |
| Profile size on a fresh login page | 22 MB |

## Deployed tests (Cloudflare, `standard-1`, image `0.1.0`)

| # | Test | Date | Outcome | Notes |
|---|---|---|---|---|
| 1 | Deploy; `/admin` returns 503 before Access is configured | 2026-11-23 | ✅ | `/admin`, `/admin/api/status`, `POST /admin/api/pairing/start` → 503 `ACCESS_NOT_CONFIGURED`; `/` → 404 |
| 2 | Access configured; `/admin` loads only after sign-in | 2026-11-23 | ✅ | Worker Access on all traffic, policy "WhatsApp digest admin" (one email). Unauthenticated `/`, `/admin`, `/admin/api/status` and a forged JWT header → 302 to Access login. Signed-in browser: page and status API load, so the Worker JWT and allowlist checks pass |
| 3 | Pairing: QR code shown; scanned; *Complete pairing* gives `paired`, gen 0, container stopped | 2026-11-23 | ✅ | Paired by the user from Android Linked devices |
| 4 | Restore test 1 | 2026-11-23 15:17 UTC | ✅ pass | Fresh container from the gen 0 snapshot reached `authenticated` with no QR code; re-snapshot to gen 1; container confirmed stopped; 50 s |
| 5 | Restore test 2 | 2026-11-23 15:19 UTC | ✅ pass | gen 1 → gen 2; container confirmed stopped; 46 s. **2 consecutive passes** |
| 6 | Restore test 3 after at least 24 h (optional but recommended) | | ⏳ | Checks that WhatsApp doesn't drop a device that has been offline for a while |
| 7 | Phone's Linked devices still shows exactly one device | | ⏳ | Confirm on the phone |
| 8 | Worker logs contain no message text, cookies or snapshot IDs | 2026-11-23 | ✅ | Checked `snapshot_created` events in Workers Observability: size, generation, origin, phase and event name only. Every log call in the code carries metadata only |
| 9 | Chromium memory on `standard-1` is adequate (no crash or OOM) | 2026-11-23 | ✅ | Pairing and both restores completed with no container errors |

Snapshot after the tests: gen 2, 12.3 MB (11.7 MiB), expires 2026-12-23 (refreshed on each restore). In every authenticated probe, all three chat-list selectors and `url_not_login` matched.

Gate verdict: **PASSED (2026-11-23).** Authentication survived a complete container shutdown and restore twice in a row, with no QR re-scan, no manual file copying, and no browser process left running between tests. Tests 6 and 7 are recommended confirmations before Phase 2.
