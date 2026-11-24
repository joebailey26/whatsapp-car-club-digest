import { INJECTION, placeGrounded, type SourceMessage } from './grounding';
import type { Listing } from './schema';

/**
 * Sale listings: grounding and deterministic reconciliation (pure; unit-tested).
 *
 * A listing must be stated in the cited messages: an offer needs a sale cue, a
 * sold/withdrawn update needs explicit wording, and every price, year,
 * mileage, location, make and model must appear in the cited text, or it is
 * set to null. Listings are matched only within the same group and the same
 * seller, so one member's update can never close another member's listing.
 */

export const SALE_CUE =
  // A bare price is deliberately NOT a cue ("saw one for £12k" is chatter).
  // Postage/delivery wording added 2026-11-24: real parts sales ("£20 + postage") were being rejected.
  // Informal offers added 2026-11-24 ("Anyone want this for £900 before I put it on marketplace?").
  // More real phrasings (re-analysis 2026-11-24): "surplus to requirements £30", "if anyone wants to buy the …,
  // I don't need it anymore", "I may part with if desired", "I have some of these available".
  /\b(anyone (want|need|fancy|interested in) (this|these|it|them|mine|my|a|an|some)|anyone wants? to buy|surplus to requirements?|(open to |thinking of |going to )?breaking (it|her|him|my|the car|for parts)|open to breaking|(don'?t|do not|no longer) need (it|them|this|these|that) any ?more|(may|might|would|will|could) (be willing to )?part with|(have|got) (some|a few|a couple)( of (these|them))? (available|going spare)|(can|could) (buy|have) mine|(put|putting|stick|sticking|list|listing) (it|her|him|them|this)? ?on (marketplace|fb|facebook|ebay|gumtree)|free to (collect|a good home|whoever)|for sale|f\/s|fs|selling|sell(ing)? (it|my|the|this)|up for (sale|grabs)|ono|ovno|o\.n\.o|obo|px|p\/x|part ex|swaps?|collection only|asking|any offers|offers (over|around|in the region)|buy it now|first to see|ftsw?b|pm (me|for)|dm (me|for)|price drop|reduced|now £|posted|postage|p&p|plus (postage|delivery|p&p)|can post|will post|happy to post|delivery (available|possible|extra))|£\s?\d+(\.\d+)?k?\s?(each|the pair|a pair|for (the|both|all|the lot)|the lot|inc|delivered|collected)\b/i;
/** First-person sale wording that outweighs wanted-ad words in the same message. */
const OWN_SALE = /\b(for sale|f\/s|selling (my|the|this|our|a few|some|off)|up for sale)\b/i;
export const CLOSED_CUE =
  /\b(sold|sale agreed|deposit (taken|paid|received|down)|now gone|has gone|gone now|no longer (for sale|available)|withdrawn|off the market|not selling|keeping (it|her|him)|decided to keep|sale pending|stc|(i'?ll|i will|will) (hold|keep|save) (it|them|this|that|these) for (you|ya|u)|reserved (for|to))\b/i;
/** Wanted ads look like sales ("budget £15k") but are out of scope. */
const WANTED = /\b(wtb|wanted|looking for|in search of|iso|after a|anyone selling|anyone got)\b/i;

export type ListingFlag =
  | 'ungrounded_price'
  | 'ungrounded_year'
  | 'ungrounded_mileage'
  | 'ungrounded_location'
  | 'ungrounded_make'
  | 'ungrounded_model'
  | 'dropped_unknown_refs';

export interface GroundedListing {
  listing: Listing;
  sources: SourceMessage[];
  seller: string | null;
  flags: ListingFlag[];
  removed: Record<string, string | number>;
}

export type ListingGroundingResult = { ok: true; value: GroundedListing } | { ok: false; reason: string };

const compact = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');
const digits = (s: string): string[] => (s.replace(/(\d),(\d{3})/g, '$1$2').match(/\d+(?:\.\d+)?/g) ?? []);

/** Every number in the value appears in the source text (thousands separators ignored). */
export function numbersGrounded(value: string, text: string): boolean {
  const want = digits(value);
  if (want.length === 0) return false;
  const have = new Set(digits(text));
  return want.every((n) => have.has(n));
}

/** "Galant", "VR-4", "R33" etc: compact substring match, or a significant word match. */
export function nameGrounded(value: string, text: string): boolean {
  const v = compact(value);
  if (v.length >= 2 && compact(text).includes(v)) return true;
  // Every word must appear: one shared word ("VR4") must not ground "Lancer Evolution VR4".
  const t = compact(text);
  const ws = value.split(/[\s/]+/).map(compact).filter((w) => w.length >= 2);
  return ws.length > 0 && ws.every((w) => t.includes(w));
}

export function yearGrounded(year: number, text: string): boolean {
  const yy = String(year).slice(2);
  return new RegExp(`\\b${year}\\b|\\b'?${yy}\\b(?!\\s?(k|miles|mi|bhp|hp|%))`, 'i').test(text);
}

export function groundListing(l: Listing, byRef: ReadonlyMap<string, SourceMessage>): ListingGroundingResult {
  const sources = l.sourceRefs.map((r) => byRef.get(r)).filter((s): s is SourceMessage => !!s);
  if (sources.length === 0) return { ok: false, reason: 'NO_VALID_SOURCES' };
  if (sources.every((s) => INJECTION.test(s.text))) return { ok: false, reason: 'SUSPECTED_INJECTION' };
  const text = sources.map((s) => s.text).join('\n');
  const flags: ListingFlag[] = sources.length < l.sourceRefs.length ? ['dropped_unknown_refs'] : [];
  const removed: Record<string, string | number> = {};

  if (l.action === 'sold' || l.action === 'withdrawn') {
    if (!CLOSED_CUE.test(text)) return { ok: false, reason: 'CLOSED_NOT_IN_SOURCES' };
  } else {
    if (!SALE_CUE.test(text)) return { ok: false, reason: 'NO_SALE_CUE' };
    if (WANTED.test(text) && !OWN_SALE.test(text)) return { ok: false, reason: 'WANTED_AD' };
  }

  const out: Listing = { ...l, sourceRefs: sources.map((s) => s.ref) };
  const drop = <K extends 'price' | 'mileage' | 'location' | 'make' | 'model'>(k: K, flag: ListingFlag): void => {
    removed[k] = out[k] as string;
    out[k] = null;
    flags.push(flag);
  };
  if (out.price && !numbersGrounded(out.price, text)) drop('price', 'ungrounded_price');
  if (out.mileage && !numbersGrounded(out.mileage, text)) drop('mileage', 'ungrounded_mileage');
  if (out.location && !placeGrounded(out.location, text)) drop('location', 'ungrounded_location');
  if (out.make && !nameGrounded(out.make, text)) drop('make', 'ungrounded_make');
  if (out.model && !nameGrounded(out.model, text)) drop('model', 'ungrounded_model');
  if (out.year !== null && !yearGrounded(out.year, text)) {
    removed.year = out.year;
    out.year = null;
    flags.push('ungrounded_year');
  }

  // Year stated in the title but left empty by the model: take it, if the text supports it.
  if (out.year === null) {
    const m = /\b(19[5-9]\d|20[0-4]\d)\b/.exec(out.title);
    if (m && yearGrounded(Number(m[1]), text)) out.year = Number(m[1]);
  }

  // The seller is the author of the first cited message that is not context.
  const own = sources.find((s) => s.ref.startsWith('m')) ?? sources[0]!;
  return { ok: true, value: { listing: out, sources, seller: own.author ?? null, flags, removed } };
}

// ───────────────────────────── reconciliation ─────────────────────────────

export interface StoredListing {
  id: string;
  groupId: string;
  kind: 'car' | 'part';
  title: string;
  make: string | null;
  model: string | null;
  year: number | null;
  price: string | null;
  mileage: string | null;
  location: string | null;
  details: string | null;
  status: 'available' | 'sold' | 'withdrawn';
  seller: string | null;
  firstPostedAt: string;
  lastSeenAt: string;
}

export interface ListingRevision {
  field: string;
  oldValue: string | null;
  newValue: string | null;
  messageId: string | null;
}

export interface ListingPlanItem {
  action: 'create' | 'update';
  listing: StoredListing;
  revisions: ListingRevision[];
  sources: Array<{ messageId: string; exportId: string; excerpt: string }>;
}

const STOP = new Set(['for', 'sale', 'the', 'and', 'with', 'set', 'car', 'cars', 'parts', 'part', 'selling', 'sold', 'my', 'of', 'in']);
const words = (...xs: Array<string | null>): Set<string> =>
  new Set(
    xs
      .filter((x): x is string => !!x)
      .join(' ')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 2 && !STOP.has(w))
      .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)), // "strips" = "strip"
  );

export function listingMatchScore(l: Listing, s: StoredListing): number {
  if (l.kind !== s.kind) return 0;
  const a = words(l.title, l.make, l.model, l.refersTo, l.year ? String(l.year) : null);
  const b = words(s.title, s.make, s.model, s.year ? String(s.year) : null);
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  let score = inter / Math.min(a.size, b.size);
  if (l.make && s.make && compact(l.make) === compact(s.make)) score += 0.2;
  if (l.model && s.model && compact(l.model) === compact(s.model)) score += 0.3;
  if (l.year && s.year && l.year !== s.year) score -= 0.5;
  return Math.max(0, Math.min(1, score));
}

export function reconcileListings(
  found: readonly GroundedListing[],
  existing: readonly StoredListing[],
  opts: { groupId: string; newId: () => string },
): ListingPlanItem[] {
  const listings = existing.map((x) => ({ ...x }));
  const plan = new Map<string, ListingPlanItem>();
  const item = (s: StoredListing, action: ListingPlanItem['action']): ListingPlanItem => {
    let it = plan.get(s.id);
    if (!it) plan.set(s.id, (it = { action, listing: s, revisions: [], sources: [] }));
    return it;
  };

  for (const g of found) {
    const l = g.listing;
    const msgTs = g.sources.map((s) => s.timestamp).sort().at(-1)!;
    const firstMsg = g.sources[0]?.id ?? null;
    const evidence = g.sources.map((s) => ({ messageId: s.id, exportId: s.exportId, excerpt: s.text.replace(/\s+/g, ' ').slice(0, 200) }));
    // Same group, same seller only.
    const pool = listings.filter((s) => s.groupId === opts.groupId && s.seller === g.seller);
    let best: StoredListing | null = null;
    let bestScore = 0;
    for (const s of pool) {
      const sc = listingMatchScore(l, s);
      if (sc > bestScore) [best, bestScore] = [s, sc];
    }
    let match = bestScore >= 0.5 ? best : null;
    // Members rarely sell two cars at once: an unnamed car offer ("anyone want this for £900?")
    // from a seller with exactly one available car, and no conflicting make/model/year, is that car.
    if (!match && l.kind === 'car') {
      const conflict = (a: string | number | null, b: string | number | null): boolean => a !== null && b !== null && compact(String(a)) !== compact(String(b));
      const cars = pool.filter((s) => s.kind === 'car' && s.status === 'available' && !conflict(l.make, s.make) && !conflict(l.model, s.model) && !conflict(l.year, s.year));
      if (cars.length === 1 && pool.filter((s) => s.kind === 'car' && s.status === 'available').length === 1) match = cars[0]!;
    }

    if (!match) {
      if (l.action === 'sold' || l.action === 'withdrawn') continue; // nothing known to close
      const s: StoredListing = {
        id: opts.newId(),
        groupId: opts.groupId,
        kind: l.kind,
        title: l.title,
        make: l.make,
        model: l.model,
        year: l.year,
        price: l.price,
        mileage: l.mileage,
        location: l.location,
        details: l.details,
        status: 'available',
        seller: g.seller,
        firstPostedAt: msgTs,
        lastSeenAt: msgTs,
      };
      listings.push(s);
      const it = item(s, 'create');
      it.revisions.push({ field: 'created', oldValue: null, newValue: s.price, messageId: firstMsg });
      it.sources.push(...evidence);
      continue;
    }

    const s = match;
    const it = item(s, 'update');
    it.sources.push(...evidence);
    // A message older than what we already know (e.g. a re-analysed backfill) adds evidence and
    // fills gaps, but never rolls status or price back.
    const stale = msgTs < s.lastSeenAt;
    if (msgTs > s.lastSeenAt) s.lastSeenAt = msgTs;

    if (stale) {
      for (const k of ['make', 'model', 'mileage', 'location', 'details'] as const) if (!s[k] && l[k]) s[k] = l[k];
      continue;
    }
    if (l.action === 'sold' || l.action === 'withdrawn') {
      const to = l.action === 'sold' ? 'sold' : 'withdrawn';
      if (s.status !== to) {
        it.revisions.push({ field: 'status', oldValue: s.status, newValue: to, messageId: firstMsg });
        s.status = to;
      }
      continue;
    }
    if (s.status !== 'available') {
      it.revisions.push({ field: 'status', oldValue: s.status, newValue: 'available', messageId: firstMsg });
      s.status = 'available';
    }
    if (l.price && l.price !== s.price) {
      it.revisions.push({ field: 'price', oldValue: s.price, newValue: l.price, messageId: firstMsg });
      s.price = l.price;
    }
    for (const k of ['make', 'model', 'mileage', 'location', 'details'] as const) {
      if (!s[k] && l[k]) {
        it.revisions.push({ field: k, oldValue: null, newValue: l[k], messageId: firstMsg });
        s[k] = l[k];
      }
    }
    if (!s.year && l.year) s.year = l.year;
  }
  return [...plan.values()];
}
