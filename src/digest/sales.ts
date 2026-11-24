import { shortDate, ukDate } from './model';

/**
 * "For sale" section of the digest (pure; unit-tested).
 * New listings first posted in the period, price changes, and items marked
 * sold/withdrawn in the period. Capped to keep the email short.
 */

export interface DigestListing {
  id: string;
  groupName: string;
  kind: 'car' | 'part';
  title: string;
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

export interface ListingChange {
  listingId: string;
  changedAt: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

export interface SaleItem {
  id: string;
  title: string;
  facts: string; // "£4,500 ono · 1993 · 98k miles · Reading"
  details: string | null;
  note: string | null; // "Was £5,000" / "Sold"
  provenance: string; // "Seller Name in Group A, posted Sat 21 Nov"
}

export interface SalesSection {
  newCars: SaleItem[];
  newParts: SaleItem[];
  priceChanges: SaleItem[];
  closed: SaleItem[];
  more: number; // items omitted by the cap
  total: number;
}

export const SALES_CAP = 20;

export function buildSales(listings: readonly DigestListing[], changes: readonly ListingChange[], since: string, today: string): SalesSection {
  const item = (l: DigestListing, note: string | null = null): SaleItem => ({
    id: l.id,
    title: l.title,
    facts: [l.price ?? 'No price given', l.year ? String(l.year) : null, l.mileage, l.location].filter(Boolean).join(' · '),
    details: l.details,
    note,
    provenance: `${l.seller ?? 'Unknown seller'} in ${l.groupName}, posted ${shortDate(ukDate(l.firstPostedAt), today)}`,
  });
  const byNewest = (a: DigestListing, b: DigestListing): number => b.firstPostedAt.localeCompare(a.firstPostedAt);
  const fresh = listings.filter((l) => l.status === 'available' && l.firstPostedAt > since);
  const freshIds = new Set(fresh.map((l) => l.id));

  const priceChanged = new Map<string, ListingChange>();
  const closedChanges = new Map<string, ListingChange>();
  for (const c of [...changes].sort((a, b) => a.changedAt.localeCompare(b.changedAt))) {
    if (c.changedAt <= since) continue;
    if (c.field === 'price' && !freshIds.has(c.listingId)) {
      const first = priceChanged.get(c.listingId);
      priceChanged.set(c.listingId, first ? { ...c, oldValue: first.oldValue } : c); // earliest old → latest new
    }
    if (c.field === 'status' && (c.newValue === 'sold' || c.newValue === 'withdrawn')) closedChanges.set(c.listingId, c);
  }
  const byId = new Map(listings.map((l) => [l.id, l] as const));

  const all = {
    newCars: fresh.filter((l) => l.kind === 'car').sort(byNewest).map((l) => item(l)),
    newParts: fresh.filter((l) => l.kind === 'part').sort(byNewest).map((l) => item(l)),
    priceChanges: [...priceChanged.values()]
      .map((c) => byId.get(c.listingId))
      .filter((l): l is DigestListing => !!l && l.status === 'available')
      .map((l) => item(l, `Was ${priceChanged.get(l.id)!.oldValue ?? 'unpriced'}`)),
    closed: [...closedChanges.values()]
      .map((c) => byId.get(c.listingId))
      .filter((l): l is DigestListing => !!l && l.status !== 'available')
      .map((l) => item(l, l.status === 'sold' ? 'Sold' : 'No longer available')),
  };
  const total = all.newCars.length + all.newParts.length + all.priceChanges.length + all.closed.length;
  // Apply the cap in priority order: cars, parts, price changes, closed.
  let budget = SALES_CAP;
  const take = (xs: SaleItem[]): SaleItem[] => {
    const out = xs.slice(0, Math.max(0, budget));
    budget -= out.length;
    return out;
  };
  const capped = { newCars: take(all.newCars), newParts: take(all.newParts), priceChanges: take(all.priceChanges), closed: take(all.closed) };
  const shown = capped.newCars.length + capped.newParts.length + capped.priceChanges.length + capped.closed.length;
  return { ...capped, more: total - shown, total };
}

export function salesSummary(s: SalesSection): string | null {
  const n = s.newCars.length + s.newParts.length + s.more;
  const parts: string[] = [];
  if (s.newCars.length + s.newParts.length) parts.push(`${s.newCars.length + s.newParts.length} new for sale`);
  if (s.priceChanges.length) parts.push(`${s.priceChanges.length} price change${s.priceChanges.length > 1 ? 's' : ''}`);
  if (s.closed.length) parts.push(`${s.closed.length} sold or withdrawn`);
  void n;
  return parts.length ? parts.join(', ') : null;
}
