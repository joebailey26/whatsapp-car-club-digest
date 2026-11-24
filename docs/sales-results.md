# Car sales listings: results

Added 2026-11-24. The digest now has a **For sale** section: cars and parts members offer for sale, price changes, and items marked sold or withdrawn. Wanted ads are out of scope. Every listing is included, with no filtering by make or price.

## How it works

1. **A separate AI call per chunk** (`LISTINGS_PROMPT`, its own JSON schema). It runs alongside the event call, which is unchanged. Combining both in one prompt measurably degraded event extraction (below), so they're kept apart.
2. **Grounding** (`src/ai/listings.ts`):
   - **Offers** need a sale cue in the cited text: "for sale", "selling my…", ono/ovno, PX/swap, collection only, "£… + postage", "posted", "£… each / the pair" and so on. A bare price is not a cue ("saw one for £12k").
   - **Wanted ads** ("WTB", "anyone selling one?") are rejected unless the message also has first-person sale wording.
   - **Sold/withdrawn** needs explicit wording (sold, sale agreed, no longer available, decided to keep…).
   - **Field checks:** the price, mileage, year, location, make and model must each appear in the cited text, or they're set to null. A year stated in the title is used when the text supports it.
3. **Reconciliation** is deterministic, within the **same group and same seller** only:
   - A repost updates "last seen".
   - A new price becomes a price-change revision.
   - A "sold" update closes the listing.
   - Another member can never close someone else's listing.
4. **Digest** (`src/digest/sales.ts`) shows new cars and new parts first posted since the previous digest (7 days for the first one), price changes ("Was £…"), and sold/withdrawn items. Each entry has the price, year, mileage, location, details, seller, group and post date. It's capped at 20 items, with "+N more".
5. **Storage:** D1 `listings`, `listing_sources` and `listing_revisions` (migration `0003`). Listings are pruned 90 days after last seen.

## Evaluation (`@cf/openai/gpt-oss-120b`, fictional cases)

| Run | Build | Total | Events (12) | Sales (5) | False listings in event cases |
|---|---|---|---|---|---|
| Single combined prompt | .6 | 14/17 | 10 | 4 | 0 |
| Single combined prompt (repeat) | .6 | 15/17 | 11 | 4 | 0 |
| **Separate listings call** | .7 | 14/17 | 9 | **5** | 0 |
| **Separate listings call** (repeat) | .7 | 15/17 | 10 | **5** | 0 |

Sales cases:
- a car for sale with year, price, mileage and location;
- parts for sale;
- a seller's "sold" update;
- price chatter, which must not become a listing;
- a wanted ad, which must not become a listing.

All five passed on both runs with the separate call.

**Event results vary between runs** (9–11 of 12) even though the event prompt is byte-identical to the one that scored 11/12 in Phase 4. At temperature 0.1 the model is not deterministic. The recurring misses are:
- **`same-event-different-names`:** labelled `rsvp_request` rather than `event` (reconciliation still creates the event);
- **`rsvp-deadline-price`:** the deadline was returned as a separate `deadline` item instead of `rsvpDeadline`.

Neither is an invented detail; grounding removed at most 2 fields per run. The scorer now treats `status: cancelled` the same as `kind: cancellation`, because the pipeline does.

## Real messages (16–24 Nov, both groups)

| Export | Messages analysed | Listings proposed → accepted |
|---|---|---|
| Group A (23 Nov 17:00) | 331 | 0 |
| Group B (23 Nov 17:06), first cue list | 221 | 2 → **0** (both `NO_SALE_CUE`) |
| Group B (23 Nov 17:06), after the postage fix | 221 | 1 → **1** |
| Group A / Group B (24 Nov runs) | 57 / 19 | 0 |

**The false negative and its fix.** A content-free keyword survey counted sale vocabulary in the stored messages. No message text was printed, only counts and keywords. In the Group B messages it found "postage" wording that the first cue list lacked. Parts are usually sold as "£15 + postage", so real sales were being rejected. Postage and delivery cues were added, with tests, and re-analysis then accepted a real parts listing posted on 16 Nov. The price is kept exactly as the seller typed it. The survey also showed some cue words are ambiguous in car chat ("bin", engine "swap", "asking"). "bin" was removed; the others only act as a gate on what the model proposes.

That listing was posted on 16 Nov, so it correctly doesn't appear as "new" in the 29 Nov digest, which covers the week up to that Sunday. A dry-run digest exercised the real D1 queries; its preview row and files were deleted afterwards.

## Limits

- **Text only.** Photo-only sale posts can't be detected, and photos aren't included.
- **Sellers who aren't saved contacts** appear as pseudonyms (`Member 3fa9c2`). The digest gives the group and post date so you can find the post.
- **Year in the title only.** The model sometimes leaves `year` empty even when the title has it; the deterministic title fill covers that.
- **Recall depends on the model.** On the same messages it proposed 2 listings once and 1 another time. The weekly digest is a convenience, not a guarantee of catching every listing.

## Backfill and informal offers (24 Nov, evening)

A member's car, offered informally twice in early November, was missing from the digest. The offers were along the lines of "he can have mine for £X" and "anyone want this before I put it on marketplace?", with the price dropping between the two. Quotes in this repo are paraphrased; no real message text is kept. There were two causes:

1. **Window.** The first export processed only the 7 days before 16 Nov, so earlier messages were never analysed. The exports hold the full chat history, so `POST /admin/api/process {"windowFrom":"2026-10-25"}` and then `analyse` reprocessed both groups from 25 Oct: 1,068 + 443 older messages, 29 chunks.
2. **Cue gate.** Informal offers had no sale cue. Added cues: "anyone want/need/fancy this…", "can have/buy mine", "put it on marketplace/eBay/Gumtree", "free to collect". The listings prompt gives similar examples. Chatter ("saw one on marketplace for £9.5k") and wanted ads are still rejected (tests).

The backfill found 12 listings, including a 1 Nov parts clear-out with its sold/withdrawn updates and the car above. It also showed two reconciliation gaps, both now fixed with tests:
- an unnamed car offer is matched to the seller's only available car, when make, model and year don't conflict;
- singular and plural titles match ("mud flap" / "mud flaps").

The two duplicate pairs this created were merged by hand in D1, so the car now shows its new price and records the price drop. Its title is generic because neither message names the model, and grounding never adds a name the cited text doesn't state.

## A missed part offer (24 Nov, late)

A member asked whether anyone wanted a part for an estate car, with no price, and promised it to another member a minute later. It was still missed after the backfill. There were three causes:

1. **Output cut off.** That chunk also holds a 10-item parts clear-out. The listings call ran out of its 4,096-token budget, which includes gpt-oss reasoning, and returned invalid JSON. That error was silent until runs started recording `listingsErrors`. The listings call now gets 8,192 tokens, and both calls retry once on invalid or empty JSON.
2. **Recall.** The prompt now says an offer with no price still counts. An item spoken for in the same messages gets a for_sale and a sold entry.
3. **Sale agreed.** "I'll hold it for you" and "reserved for" now count as sale agreed.

Diagnosing this added `POST /admin/api/analyse {exportId, from, to}`, which re-analyses exactly those days. Runs now record rejected listing titles with reasons, and schema errors name the failing field. Re-analysis showed that an older message could roll a newer status back (sold → available → sold). Reconciliation now uses an older message only to fill empty fields.

Data fixes by hand: the model had marked the wrong one of two similar items as withdrawn, and the flip-flop revisions were removed.

## Wider cues after a full re-analysis (24 Nov, night)

Re-analysing 25 Oct–24 Nov with every fix in place found no new cut-off responses. The rejected-listing log showed four more phrasings the cue gate missed:
- "surplus to requirements";
- "if anyone wants to buy…, I don't need it anymore";
- "I may part with";
- "open to breaking" (a car offered for parts).

All four were added, with tests.
