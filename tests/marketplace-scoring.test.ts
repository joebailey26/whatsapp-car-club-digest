import { describe, expect, it } from 'vitest';
import { canMarkMissing, planIngest, type Observation, type StoredMarketListing } from '../src/marketplace/ingest';
import { parseCard } from '../src/marketplace/parse';
import { DEFAULT_SCORING, isSignificantDrop, scoreListing, type ScoreInput } from '../src/marketplace/score';

const base: ScoreInput = { title: '', description: null, pricePence: null, distanceMiles: null, distanceBasis: 'unknown', year: null, priceDropPence: null, previousPricePence: null };

describe('historical cases (agreed design)', () => {
  it('a £750 MX-5 with a hardtop alerts immediately, with no valuation data at all', () => {
    const r = scoreListing({ ...base, title: 'Mazda MX-5', description: 'Comes with hardtop. No MOT.', pricePence: 75_000, distanceMiles: 8, distanceBasis: 'town' });
    expect(r.route).toBe('urgent');
    expect(r.reasons.join(' ')).toMatch(/hardtop/);
  });
  it('the MX-5 still alerts with unknown location, year and mileage (no strict gate)', () => {
    expect(scoreListing({ ...base, title: 'mx5 for sale', pricePence: 75_000 }).route).toBe('urgent');
  });
  it('an £800 Civic with an unexplained transmission fault is not top priority, but is not discarded', () => {
    const r = scoreListing({ ...base, title: 'Honda Civic 1.6', description: 'Transmission fault, not sure what is wrong', pricePence: 80_000, distanceMiles: 20, distanceBasis: 'town' });
    expect(r.route).not.toBe('urgent');
    expect(r.route).toBe('review');
  });
  it('a borderline, incomplete advert goes to review', () => {
    const r = scoreListing({ ...base, title: 'Ford Focus', pricePence: 60_000 });
    expect(r.route).toBe('review');
    expect(r.borderline).toBe(true);
  });
  it('welding/rust is a costed repair, not a rejection', () => {
    const r = scoreListing({ ...base, title: 'Toyota MR2 Mk2', description: 'needs welding on sills for MOT', pricePence: 90_000, distanceMiles: 30, distanceBasis: 'town', year: 1995 });
    expect(r.route).toBe('urgent');
    expect(r.reasons.join(' ')).toMatch(/£300\/patch/);
  });
  it('a missing price is a review candidate, never auto-rejected', () => {
    expect(scoreListing({ ...base, title: 'Nissan Micra', distanceMiles: 10, distanceBasis: 'town' }).route).toBe('review');
  });
  it('downranks but keeps reviewable very cheap cars with major faults', () => {
    const r = scoreListing({ ...base, title: 'Vauxhall Corsa', description: 'head gasket gone', pricePence: 30_000, distanceMiles: 15, distanceBasis: 'town' });
    expect(r.route).toBe('review');
  });
  it('parts and wanted adverts are low priority; far-away cars are not urgent', () => {
    expect(scoreListing({ ...base, title: 'WANTED cars any condition', pricePence: 10_000, distanceMiles: 5, distanceBasis: 'town' }).route).toBe('low');
    expect(scoreListing({ ...base, title: 'Mazda MX-5', pricePence: 70_000, distanceMiles: 120, distanceBasis: 'town' }).route).not.toBe('urgent');
  });
  it('expensive ordinary cars stay out of urgent alerts', () => {
    expect(scoreListing({ ...base, title: '2007 Ford Fiesta', pricePence: 250_000, distanceMiles: 5, distanceBasis: 'town', year: 2007 }).route).toBe('low');
  });
  it('is deterministic and records the ruleset version', () => {
    const i = { ...base, title: 'Honda Jazz', pricePence: 45_000, distanceMiles: 12, distanceBasis: 'town' as const };
    expect(scoreListing(i)).toEqual(scoreListing(i));
    expect(scoreListing(i).rulesetVersion).toBe(DEFAULT_SCORING.version);
  });
});

describe('price drop significance', () => {
  it('needs £50 or 10%', () => {
    expect(isSignificantDrop(100_000, 95_000, DEFAULT_SCORING.priceDrop)).toBe(true);
    expect(isSignificantDrop(30_000, 28_000, DEFAULT_SCORING.priceDrop)).toBe(false);
    expect(isSignificantDrop(30_000, 26_000, DEFAULT_SCORING.priceDrop)).toBe(true);
    expect(isSignificantDrop(30_000, 31_000, DEFAULT_SCORING.priceDrop)).toBe(false);
    expect(isSignificantDrop(null, 1, DEFAULT_SCORING.priceDrop)).toBe(false);
  });
});

// ───────────── ingest ─────────────

const obs = (id: string, price: string, title: string, loc: string | null, searchId = 's1'): Observation => ({
  card: parseCard({ href: `/marketplace/item/${id}/`, lines: [price, title, ...(loc ? [loc] : [])] })!,
  detail: null,
  searchId,
});
const opts = (baseline: string[] = []) => ({ now: '2026-11-25T10:07:00.000Z', scoring: DEFAULT_SCORING, baselineSearches: new Set(baseline) });

function stored(o: Observation, patch: Partial<StoredMarketListing> = {}): StoredMarketListing {
  const p = planIngest([o], new Map(), { ...opts(), now: '2026-11-24T10:07:00.000Z' }).items[0]!.listing;
  return { ...p, ...patch };
}

describe('planIngest', () => {
  it('alerts a promising new advert once, and records first-seen as discovery time', () => {
    const p = planIngest([obs('100000001', '£750', 'Mazda MX-5 hardtop', 'Huntingdon')], new Map(), opts());
    expect(p.items[0]!.notify).toEqual({ class: 'urgent_new', dedupeKey: 'new' });
    expect(p.items[0]!.listing.firstSeenAt).toBe('2026-11-25T10:07:00.000Z');
    expect(p.items[0]!.listing.publishedText).toBeNull();
    expect(p.counts).toMatchObject({ new: 1, urgent: 1 });
  });
  it('stores but never alerts adverts from a search\'s baseline run', () => {
    const p = planIngest([obs('100000002', '£750', 'Mazda MX-5', 'Ramsey'), obs('100000003', '£600', 'Ford Focus', null)], new Map(), opts(['s1']));
    expect(p.items.every((i) => i.notify === null && i.listing.baseline)).toBe(true);
    expect(p.counts.baseline).toBe(2);
  });
  it('treats the same advert in two searches as one listing', () => {
    const p = planIngest([obs('100000004', '£750', 'Mazda MX-5', 'Ramsey', 's1'), obs('100000004', '£750', 'Mazda MX-5', 'Ramsey', 's2')], new Map(), opts());
    expect(p.items).toHaveLength(1);
    expect(p.counts.seen).toBe(1);
  });
  it('does not re-alert an advert seen again at the same price, and keeps first-seen', () => {
    const o = obs('100000005', '£750', 'Mazda MX-5', 'Ramsey');
    const prev = stored(o);
    const p = planIngest([o], new Map([[prev.id, prev]]), opts());
    expect(p.items[0]!.kind).toBe('seen');
    expect(p.items[0]!.notify).toBeNull();
    expect(p.items[0]!.listing.firstSeenAt).toBe('2026-11-24T10:07:00.000Z');
  });
  it('alerts a genuine price drop, deduped by the new price', () => {
    const prev = stored(obs('100000006', '£1,000', 'Toyota MR2', 'Ely'));
    const p = planIngest([obs('100000006', '£800', 'Toyota MR2', 'Ely')], new Map([[prev.id, prev]]), opts());
    expect(p.items[0]!.kind).toBe('price_drop');
    expect(p.items[0]!.notify).toEqual({ class: 'urgent_price_drop', dedupeKey: '80000' });
    expect(p.items[0]!.previousPricePence).toBe(100_000);
    expect(p.items[0]!.listing.reasons.join(' ')).toMatch(/price dropped £200/);
  });
  it('ignores trivial price changes but records them', () => {
    const prev = stored(obs('100000007', '£500', 'Honda Jazz', 'March'));
    const p = planIngest([obs('100000007', '£480', 'Honda Jazz', 'March')], new Map([[prev.id, prev]]), opts());
    expect(p.items[0]!.kind).toBe('price_change');
    expect(p.items[0]!.priceChanged).toBe(true);
    expect(p.items[0]!.notify).toBeNull();
  });
  it('never alerts listings the owner passed or ignored', () => {
    const prev = stored(obs('100000008', '£1,000', 'Toyota MR2', 'Ely'), { reviewState: 'passed' });
    const p = planIngest([obs('100000008', '£700', 'Toyota MR2', 'Ely')], new Map([[prev.id, prev]]), opts());
    expect(p.items[0]!.notify).toBeNull();
  });
  it('routes borderline new adverts to the daily roundup queue', () => {
    const p = planIngest([obs('100000009', '£600', 'Ford Focus', null)], new Map(), opts());
    expect(p.items[0]!.notify).toEqual({ class: 'daily', dedupeKey: 'new' });
    expect(p.items[0]!.borderline).toBe(true);
  });
  it('re-activates a listing previously marked missing', () => {
    const o = obs('100000010', '£750', 'Mazda MX-5', 'Ramsey');
    const prev = stored(o, { status: 'missing' });
    expect(planIngest([o], new Map([[prev.id, prev]]), opts()).items[0]!.listing.status).toBe('active');
  });
});

describe('missing listings after partial runs', () => {
  it('only marks listings missing after a complete run', () => {
    expect(canMarkMissing({ searchesOk: 2, searchesFailed: 0 })).toBe(true);
    expect(canMarkMissing({ searchesOk: 1, searchesFailed: 1 })).toBe(false);
    expect(canMarkMissing({ searchesOk: 0, searchesFailed: 0 })).toBe(false);
  });
});
