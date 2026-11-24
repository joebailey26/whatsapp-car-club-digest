# Phase 3 test results

**Gate:** test fixtures including ambiguous dates, multiline messages and duplicate exports pass.

**Verdict: PASSED (2026-11-23).** 81/81 tests pass (`npm test`), 26 of them Phase 3 tests. The pipeline was also run on the real stored exports, with the results below.

## How the format was established without reading messages

The spec says to parse the format actually observed. I reduced one real export to **line shapes** (letters → `a`, digits → `9`, punctuation kept) and counted them. No message text was printed. The format observed:

```
[9/99/99, 9:99:99 a+] +99 9999 999999: …   ← [M/D/YY, h:mm:ss AM] author: text
```

- **Date and time:** dates are US order (M/D/YY) because the container's Chromium locale is `en-US`. Times are 12-hour with seconds, in the container's timezone (**UTC**).
- **Line structure:**
  - Most authors are raw phone numbers (contacts not saved on the paired phone); some are names.
  - Continuation lines carry no header.
  - Attachment placeholders start with `<`.
  - The first line is an encryption-notice preamble.
- **What the file doesn't contain:** BOM, CRLF and direction marks were absent from this file. They're handled anyway.
- **ZIP contents:** each ZIP also contains a `.md` rendering. It's ignored; the `.txt` is the source of truth.

## Fixture coverage (`tests/phase3.test.ts`, all fictional data)

| Spec requirement | Test |
|---|---|
| Ambiguous UK/US dates | `ambiguous.txt` is flagged `dateOrderAmbiguous` and resolved by the configured hint (MDY for this container; DMY gives the UK reading). A self-contradicting file is rejected (`INCONSISTENT_DATE_ORDER`) |
| UK date formatting | `android-uk-dmy.txt` is detected as D/M. BST/GMT are converted correctly (13/07 18:30 → 17:30Z; 01/02 08:15 → 08:15Z) |
| Multiline messages | Joined, with blank lines and emoji kept |
| Duplicate messages in overlapping exports | Week-2 fixture shares 8 messages with week 1. Same IDs, so 2 new and the rest duplicates, through the full R2 + D1 pipeline. Reprocessing gives identical counts |
| Genuinely repeated messages | Two "👍" from the same author in the same second keep **distinct** IDs |
| Empty exports | An empty transcript gives zero messages, no invented ones. An empty window gives status `empty`, never `failed` and never "inactive" |
| Malformed exports | Non-WhatsApp text gives 0 messages plus 1 rejected header. A corrupt, truncated or tampered object gives `EXPORT_CHECKSUM_MISMATCH`; a missing object gives `EXPORT_OBJECT_MISSING` |
| Impossible dates | 31/02 is dropped and counted (`invalidDates`) |
| Midnight and noon in 12-hour time | 12:05 AM → 00:05, 12:30 PM → 12:30 |
| Attachment placeholders and system messages | Flagged `attachment` / `system` (author `null`) |
| Unusual characters | U+200E/U+200F, U+202F and the BOM are stripped; text is NFC-normalised |
| Untrusted ZIPs | Rejected: `../` and absolute and backslash paths, encrypted entries, compression ratio over 200 (zip bomb), entries that lie about their inflated size (capped inflate), missing or multiple transcripts, ZIP64 and multi-disk archives |
| Sender minimisation | Phone-number authors become `Member <6 hex>`, an HMAC keyed by a Worker secret, stable within a group and different across groups. No phone digits appear in the output |

## Real exports, processed from R2 only

None of this touched WhatsApp.

| Export | Window (Europe/London) | Parsed | In window | New | Duplicate | Date order |
|---|---|---|---|---|---|---|
| group-a @ 17:00 | from 16 Nov | 3,999 (since 26 Aug) | 356 | 356 | 0 | MDY (detected) |
| group-a @ 17:06 | from 22 Nov | 4,001 | 63 | **2** | **61** | MDY (detected) |
| group-b @ 17:06 | from 16 Nov | 822 (since 15 Aug) | 279 | 279 | 0 | MDY (detected) |
| group-b @ 17:00 | n/a | n/a | n/a | n/a | n/a | the export had failed, so `not_applicable` |

- The group-a transcript grew by exactly two messages between the two exports, six minutes apart. Exactly those two were new, and all 61 overlapping messages matched their earlier IDs.
- Reprocessing run 17:06 again gave identical counts. D1 `messages_seen` holds 637 rows, which is 356 + 2 + 279.
- The stored `messages.json` for group-b has 279 messages, **0 phone-number authors**, 274 pseudonymised (25 distinct pseudonyms), 1 named author, 58 attachment placeholders and 4 system messages. Timestamps are in order.

## Storage and retention

| Data | Where | Retention |
|---|---|---|
| Raw export | R2 `exports/<group>/<stamp>/original.zip` | 30 days (lifecycle) |
| Normalised in-window messages | R2 `…/messages.json` | 30 days (lifecycle) |
| Export and processing metadata | D1 `exports` | Kept; contains no content |
| Deduplication index | D1 `messages_seen` (id, group, timestamp, export only) | Rows older than 60 days are pruned on every processing run |
| Events, sources, revisions | D1 (created; used from Phase 4) | Phase 4 will define this |

## Deviations and decisions

1. **Export timezone and locale come from the container** (UTC, en-US), not the UK. Both are explicit config (`EXPORT_TIMEZONE=UTC`, `EXPORT_DATE_ORDER_HINT=MDY`). The parser always prefers the date order it detects in the data. If the image is ever changed to set `TZ=Europe/London` / `LANG=en_GB`, these vars must change with it.
2. **The window is applied in processing**, because the export dialog's date range isn't used yet (see the Phase 2 results). Each export contains the whole local history (about 3 months here), but only in-window messages are stored in `messages.json`, and deduplication makes the overlap safe.
3. **Message ID** = SHA-256 of (group, UTC timestamp, author or pseudonym, normalised text, occurrence index). An edited message (whose text changes) becomes a new ID. Phase 4 treats that as a possible update.
4. **Named authors are kept** because they're needed to interpret events ("Sam's organising"). Only phone-number authors are pseudonymised.
