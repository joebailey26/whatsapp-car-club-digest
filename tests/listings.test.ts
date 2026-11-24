import { describe, expect, it } from 'vitest';
import { EVAL_CASES, scoreListings } from '../src/ai/eval';
import type { SourceMessage } from '../src/ai/grounding';
import { groundListing, nameGrounded, numbersGrounded, reconcileListings, yearGrounded, type GroundedListing, type StoredListing } from '../src/ai/listings';
import type { Listing } from '../src/ai/schema';
import { buildDigest } from '../src/digest/model';
import { renderDigest } from '../src/digest/render';
import { buildSales, SALES_CAP, type DigestListing } from '../src/digest/sales';

const T = '2026-11-23T18:10:00.000Z';
const src = (text: string, ref = 'm1', author: string | null = 'Sam', timestamp = T): SourceMessage => ({ ref, id: `id-${ref}`, exportId: 'e1', timestamp, text, author });
const by = (...s: SourceMessage[]): Map<string, SourceMessage> => new Map(s.map((x) => [x.ref, x]));
const lst = (over: Partial<Listing> = {}): Listing => ({
  kind: 'car',
  action: 'for_sale',
  title: '1993 Galant VR-4',
  make: 'Mitsubishi',
  model: 'Galant VR-4',
  year: 1993,
  price: '£4,500 ono',
  mileage: '98k miles',
  location: 'Reading',
  details: null,
  refersTo: null,
  confidence: 0.9,
  sourceRefs: ['m1'],
  ...over,
});
const AD = 'Selling my 1993 Mitsubishi Galant VR-4, 98k miles, £4,500 ono. Based in Reading';

// ════════════════════ grounding ════════════════════
describe('listing grounding', () => {
  it('keeps a fully stated listing and records the seller', () => {
    const r = groundListing(lst(), by(src(AD)));
    expect(r.ok && r.value.flags).toEqual([]);
    expect(r.ok && r.value.seller).toBe('Sam');
  });
  it('nulls invented price, year, mileage, location, make and model', () => {
    const r = groundListing(lst({ price: '£5,000', year: 1994, mileage: '120k', location: 'Leeds', make: 'Nissan', model: 'Skyline' }), by(src(AD)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const l = r.value.listing;
    // year 1994 is removed; the grounded year in the title (1993, present in the text) fills it instead
    expect([l.price, l.year, l.mileage, l.location, l.make, l.model]).toEqual([null, 1993, null, null, null, null]);
    expect(r.value.removed).toMatchObject({ price: '£5,000', year: 1994 });
  });
  it('requires a sale cue and rejects wanted ads and price chatter', () => {
    expect(groundListing(lst(), by(src('My mate sold his GTO for 8k last year')))).toMatchObject({ ok: false });
    expect(groundListing(lst(), by(src('WTB: Evo 6, budget around £15k')))).toMatchObject({ ok: false }); // no sale cue at all
    expect(groundListing(lst(), by(src('WTB: Evo 6 RS, anyone selling one? budget around £15k')))).toEqual({ ok: false, reason: 'WANTED_AD' });
    expect(groundListing(lst(), by(src('Saw a VR-4 on eBay for £12k, crazy money')))).toEqual({ ok: false, reason: 'NO_SALE_CUE' });
    // A seller who also mentions what they want in return is still selling.
    expect(groundListing(lst(), by(src(`${AD}. Looking for a swap for an Evo`))).ok).toBe(true);
    expect(groundListing(lst({ kind: 'part' }), by(src('FS: set of 4 Rota Grid 17s, £350, collection only'))).ok).toBe(true);
  });
  it('requires explicit wording for sold/withdrawn', () => {
    expect(groundListing(lst({ action: 'sold' }), by(src('Still got the VR-4, any takers?')))).toEqual({ ok: false, reason: 'CLOSED_NOT_IN_SOURCES' });
    expect(groundListing(lst({ action: 'sold', price: null, year: null, mileage: null, location: null }), by(src('VR-4 is now sold, thanks all'))).ok).toBe(true);
    expect(groundListing(lst({ action: 'withdrawn', price: null, year: null, mileage: null, location: null }), by(src('Decided to keep it, no longer for sale'))).ok).toBe(true);
  });
  it('matches numbers, names and years flexibly but strictly', () => {
    expect(numbersGrounded('£4,500 ono', '£4500 ovno')).toBe(true);
    expect(numbersGrounded('£4,500', 'asking 4k')).toBe(false);
    expect(nameGrounded('VR-4', 'galant vr4 for sale')).toBe(true);
    expect(nameGrounded('Galant VR-4', 'my vr4 galant, open to offers')).toBe(true);
    expect(nameGrounded('Lancer Evolution VR4', 'my red vr4 is up for breaking')).toBe(false);
    expect(yearGrounded(1993, "'93 Galant")).toBe(true);
    expect(yearGrounded(1993, '93k miles')).toBe(false);
  });
});

// ════════════════════ reconciliation ════════════════════
const gl = (l: Partial<Listing>, seller = 'Sam', ts = T, text = AD): GroundedListing => ({ listing: lst(l), sources: [src(text, 'm1', seller, ts)], seller, flags: [], removed: {} });
const stored = (over: Partial<StoredListing> = {}): StoredListing => ({
  id: 'l1',
  groupId: 'club-a',
  kind: 'car',
  title: '1993 Galant VR-4',
  make: 'Mitsubishi',
  model: 'Galant VR-4',
  year: 1993,
  price: '£4,500 ono',
  mileage: '98k miles',
  location: 'Reading',
  details: null,
  status: 'available',
  seller: 'Sam',
  firstPostedAt: '2026-11-20T10:00:00.000Z',
  lastSeenAt: '2026-11-20T10:00:00.000Z',
  ...over,
});
let n = 0;
const opts = { groupId: 'club-a', newId: () => `new${++n}` };

describe('reconcileListings', () => {
  it('creates a new listing', () => {
    const p = reconcileListings([gl({})], [], opts);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ action: 'create', listing: { status: 'available', seller: 'Sam', firstPostedAt: T } });
  });
  it('treats a repost as the same listing and records a price change', () => {
    const p = reconcileListings([gl({ price: '£4,000 ono', title: 'Galant VR-4 price drop' })], [stored()], opts);
    expect(p[0]!.action).toBe('update');
    expect(p[0]!.listing.price).toBe('£4,000 ono');
    expect(p[0]!.revisions).toContainEqual(expect.objectContaining({ field: 'price', oldValue: '£4,500 ono', newValue: '£4,000 ono' }));
    expect(p[0]!.listing.lastSeenAt).toBe(T);
  });
  it('closes a listing when its seller says it sold', () => {
    const p = reconcileListings([gl({ action: 'sold', price: null })], [stored()], opts);
    expect(p[0]!.listing.status).toBe('sold');
  });
  it('never lets a different member close someone else\'s listing', () => {
    expect(reconcileListings([gl({ action: 'sold' }, 'Alex')], [stored()], opts)).toEqual([]);
  });
  it('does not match a part to a car, and relists a sold item offered again', () => {
    expect(reconcileListings([gl({ kind: 'part', title: 'Galant VR-4 wheels' })], [stored()], opts)[0]!.action).toBe('create');
    const p = reconcileListings([gl({})], [stored({ status: 'sold' })], opts);
    expect(p[0]!.listing.status).toBe('available');
  });
  it("matches an unnamed car offer to the seller's only available car (real-data fix)", () => {
    const vague = stored({ title: 'Car needing clutch', make: null, model: null, year: null, price: '£1000' });
    const p = reconcileListings([gl({ title: 'Car for sale', make: null, model: null, year: null, price: '£900' })], [vague], opts);
    expect(p[0]).toMatchObject({ action: 'update', listing: { id: 'l1', price: '£900' } });
    // Conflicting make, two cars on sale, or another seller: no guess.
    expect(reconcileListings([gl({ title: 'Car', make: 'Subaru', model: null, year: null })], [stored({ title: 'Car' })], opts)[0]!.action).toBe('create');
    expect(reconcileListings([gl({ title: 'Car', make: null, model: null, year: null })], [stored({ title: 'Car A' }), stored({ id: 'l2', title: 'Car B' })], opts)[0]!.action).toBe('create');
    expect(reconcileListings([gl({ title: 'Car', make: null, model: null, year: null }, 'Alex')], [vague], opts)[0]!.action).toBe('create');
  });
  it('matches singular and plural titles from the same seller (real-data fix)', () => {
    const strips = stored({ kind: 'part', title: 'Mud flaps (red)', make: null, model: null, year: null, price: '£20 + £4 postage' });
    const p = reconcileListings([gl({ kind: 'part', title: 'Mud flap set', make: null, model: null, year: null, price: '£20 + £4 postage' })], [strips], opts);
    expect(p[0]!.action).toBe('update');
  });
  it('never rolls status or price back from an older message (re-analysis)', () => {
    const sold = stored({ status: 'sold', price: '£4,000', lastSeenAt: '2026-11-21T10:00:00.000Z' });
    const p = reconcileListings([gl({ price: '£4,500 ono' }, 'Sam', '2026-11-20T10:00:00.000Z')], [sold], opts);
    expect(p[0]!.listing).toMatchObject({ status: 'sold', price: '£4,000' });
    expect(p[0]!.revisions).toEqual([]);
  });
  it('ignores a sold update for something never listed', () => {
    expect(reconcileListings([gl({ action: 'sold' })], [], opts)).toEqual([]);
  });
});

// ════════════════════ digest section ════════════════════
const dl = (over: Partial<DigestListing> = {}): DigestListing => ({
  id: 'l1',
  groupName: 'Club A',
  kind: 'car',
  title: '1993 Galant VR-4',
  year: 1993,
  price: '£4,500 ono',
  mileage: '98k miles',
  location: 'Reading',
  details: 'MOT till August',
  status: 'available',
  seller: 'Sam',
  firstPostedAt: '2026-11-21T10:00:00.000Z',
  lastSeenAt: '2026-11-21T10:00:00.000Z',
  ...over,
});
const SINCE = '2026-11-17T00:00:00.000Z';

describe('buildSales', () => {
  it('splits new cars and parts, price changes and closed listings', () => {
    const s = buildSales(
      [
        dl({ id: 'c1' }),
        dl({ id: 'p1', kind: 'part', title: 'Rota Grid 17s', price: '£350' }),
        dl({ id: 'old', firstPostedAt: '2026-11-01T10:00:00.000Z', price: '£3,800' }),
        dl({ id: 'gone', firstPostedAt: '2026-11-02T10:00:00.000Z', status: 'sold' }),
      ],
      [
        { listingId: 'old', changedAt: '2026-11-20T10:00:00.000Z', field: 'price', oldValue: '£4,200', newValue: '£3,800' },
        { listingId: 'gone', changedAt: '2026-11-22T10:00:00.000Z', field: 'status', oldValue: 'available', newValue: 'sold' },
        { listingId: 'c1', changedAt: '2026-11-21T10:00:00.000Z', field: 'created', oldValue: null, newValue: '£4,500 ono' },
      ],
      SINCE,
      '2026-11-24',
    );
    expect(s.newCars.map((x) => x.id)).toEqual(['c1']);
    expect(s.newParts.map((x) => x.id)).toEqual(['p1']);
    expect(s.priceChanges[0]).toMatchObject({ id: 'old', note: 'Was £4,200' });
    expect(s.closed[0]).toMatchObject({ id: 'gone', note: 'Sold' });
    expect(s.newCars[0]!.facts).toBe('£4,500 ono · 1993 · 98k miles · Reading');
    expect(s.newCars[0]!.provenance).toBe('Sam in Club A, posted Sat 21 Nov');
  });
  it('caps the section and counts what was left out', () => {
    const many = Array.from({ length: SALES_CAP + 5 }, (_, i) => dl({ id: `x${i}`, firstPostedAt: `2026-11-2${i % 3}T10:00:00.000Z` }));
    const s = buildSales(many, [], SINCE, '2026-11-24');
    expect(s.newCars).toHaveLength(SALES_CAP);
    expect(s.more).toBe(5);
  });
});

describe('digest with sales', () => {
  const base = { id: '2026-11-29', generatedAt: '2026-11-24T08:00:00.000Z', periodFrom: SINCE, events: [], revisions: [], provenance: [], coverage: [{ groupId: 'a', groupName: 'Club A', exportStatus: 'succeeded', processingStatus: 'processed', analysisStatus: 'analysed', newMessages: 10, exportedAt: null }] };
  it('mentions sales in the headline and renders an escaped "For sale" section', () => {
    const m = buildDigest({ ...base, listings: [dl({ title: '<b>VR-4</b> & spares' })], listingChanges: [] });
    expect(m.headline).toBe('No upcoming meets or actions were identified in the groups this week. For sale: 1 new for sale.');
    const r = renderDigest(m);
    expect(r.html).toContain('>For sale</h2>');
    expect(r.html).toContain('&lt;b&gt;VR-4&lt;/b&gt; &amp; spares');
    expect(r.text).toContain('FOR SALE');
    expect(r.text).toContain('Sam in Club A, posted Sat 21 Nov');
  });
  it('omits the section when there are no listings', () => {
    const r = renderDigest(buildDigest({ ...base }));
    expect(r.html).not.toContain('For sale');
    expect(r.text).not.toContain('FOR SALE');
  });
});

describe('scoreListings', () => {
  const c = (name: string) => EVAL_CASES.find((x) => x.name === name)!;
  it('fails event cases that produce any listing', () => {
    expect(scoreListings(c('casual-chat'), [gl({})]).length).toBeGreaterThan(0);
    expect(scoreListings(c('casual-chat'), [])).toEqual([]);
  });
  it('checks listing facts', () => {
    const ok = gl({ price: '£4,500 ono', year: 1993, mileage: '98k miles', location: 'Reading' });
    expect(scoreListings(c('sale-car'), [ok])).toEqual([]);
    expect(scoreListings(c('sale-car'), [gl({ price: '£5,000' })]).length).toBeGreaterThan(0);
  });
});

describe('sale cues for parts sold by post (real-data fix 2026-11-24)', () => {
  const part = (text: string) => groundListing(lst({ kind: 'part', title: 'Wheels', make: null, model: null, year: null, price: null, mileage: null, location: null }), by(src(text)));
  it.each(['Set of wheels £200 plus postage', 'Front lip £40 posted', 'Spare intercooler, £60 + p&p', 'Coilovers £350 the pair', 'Mirrors £25 each, can post'])('accepts "%s"', (text) => {
    expect(part(text).ok).toBe(true);
  });
  it('still rejects a bare price mention and "bin" as in rubbish', () => {
    expect(part('Paid £200 for mine last year')).toEqual({ ok: false, reason: 'NO_SALE_CUE' });
    expect(part('Old exhaust went in the bin')).toEqual({ ok: false, reason: 'NO_SALE_CUE' });
  });
});

describe('informal sale offers (real-data fix 2026-11-24)', () => {
  const car = (text: string) => groundListing(lst({ title: 'Car', make: null, model: null, year: null, price: null, mileage: null, location: null }), by(src(text)));
  it.each([
    'Anyone want this for £900 before I put it on marketplace? Needs a clutch',
    'He can buy mine that needs a clutch for £1000',
    'Anyone want a roof rack for an estate?',
    'Rear lights, free to collect from Leeds',
    'Putting it on ebay next week',
    'Spare strut brace, surplus to requirements £30',
    "If anyone wants to buy the head unit I don't need it anymore",
    'I have a set of gold wheels I may part with if desired?',
    'I have some of these available, 100mm',
    "I've got my red saloon that I'm open to breaking if there's interest",
  ])('accepts "%s"', (text) => {
    expect(car(text).ok).toBe(true);
  });
  it('treats "it\'s yours, I\'ll hold it for you" as sale agreed', () => {
    const sold = groundListing(lst({ action: 'sold', kind: 'part', title: 'Roof rack', make: null, model: null, year: null, price: null, mileage: null, location: null }), by(src("It's yours, I'll hold it for you")));
    expect(sold.ok).toBe(true);
    expect(groundListing(lst({ action: 'sold', kind: 'part', title: 'Roof rack' }), by(src('Hold it steady while I torque it')))).toEqual({ ok: false, reason: 'CLOSED_NOT_IN_SOURCES' });
  });
  it('still rejects chatter and wanted ads', () => {
    expect(car('Saw a nice one on marketplace for £9.5k')).toEqual({ ok: false, reason: 'NO_SALE_CUE' });
    expect(car('Anyone got a clutch for an estate? Budget £300')).toEqual({ ok: false, reason: 'NO_SALE_CUE' });
  });
});

describe('all-history digest', () => {
  it('includes older listings when the sales look-back is overridden', () => {
    const base = { id: '2026-11-29', generatedAt: '2026-11-24T15:00:00.000Z', periodFrom: null, events: [], revisions: [], provenance: [], coverage: [] };
    const old = dl({ id: 'old', firstPostedAt: '2026-11-16T19:42:39.000Z', kind: 'part', title: 'Mud flap set' });
    expect(buildDigest({ ...base, listings: [old] }).sales.total).toBe(0); // default: last 7 days only
    expect(buildDigest({ ...base, listings: [old], salesSince: '1970-01-01T00:00:00.000Z' }).sales.newParts.map((x) => x.id)).toEqual(['old']);
  });
});
