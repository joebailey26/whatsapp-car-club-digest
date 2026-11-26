import { describe, expect, it } from 'vitest';
import { canonicalItemUrl, dedupeCards, itemIdFromHref, parseCard, parseDetail, parseMileage, redactContact } from '../src/marketplace/parse';
import { distanceFromHome } from '../src/marketplace/geo';

const card = (href: string, ...lines: string[]) => ({ href, lines, photo: null });

describe('Marketplace item IDs and URLs', () => {
  it('extracts the stable ID from relative and absolute links, dropping tracking', () => {
    expect(itemIdFromHref('/marketplace/item/1234567890123456/?ref=search&tracking=abc')).toBe('1234567890123456');
    expect(itemIdFromHref('https://www.facebook.com/marketplace/item/987654321/')).toBe('987654321');
    expect(canonicalItemUrl('987654321')).toBe('https://www.facebook.com/marketplace/item/987654321/');
  });
  it('rejects non-item and non-Facebook links', () => {
    expect(itemIdFromHref('/marketplace/category/vehicles')).toBeNull();
    expect(itemIdFromHref('https://evil.example/marketplace/item/123456789/')).toBeNull();
  });
});

describe('parseCard', () => {
  it('reads price, title, location, mileage and stated year', () => {
    const c = parseCard(card('/marketplace/item/111111111/', '£750', '2003 Mazda MX-5 1.8i Sport', 'Huntingdon, Cambridgeshire', '98K miles'))!;
    expect(c).toMatchObject({ sourceId: '111111111', pricePence: 75_000, title: '2003 Mazda MX-5 1.8i Sport', location: 'Huntingdon, Cambridgeshire', mileage: 98_000, year: 2003, currency: 'GBP', shownPreviousPence: null });
    expect(c.url).toBe('https://www.facebook.com/marketplace/item/111111111/');
  });
  it('recognises a reduced price shown with the struck-through original', () => {
    expect(parseCard(card('/marketplace/item/222222222/', '£650£750', 'Honda Civic', 'Peterborough'))).toMatchObject({ pricePence: 65_000, shownPreviousPence: 75_000 });
    expect(parseCard(card('/marketplace/item/222222223/', '£1,200 £1,450', 'Toyota MR2', 'Ely'))).toMatchObject({ pricePence: 120_000, shownPreviousPence: 145_000 });
  });
  it('handles free, km and missing fields without guessing', () => {
    expect(parseCard(card('/marketplace/item/333333333/', 'Free', 'Spares car'))).toMatchObject({ free: true, pricePence: 0, location: null, year: null });
    expect(parseMileage('160 km')).toBe(99);
    expect(parseMileage('Driven 120,000 miles')).toBe(120_000);
    const bare = parseCard(card('/marketplace/item/444444444/', 'Ford Focus'))!;
    expect(bare.pricePence).toBeNull();
    expect(bare.mileage).toBeNull();
  });
  it('drops "Just listed"/"Sponsored" noise lines', () => {
    expect(parseCard(card('/marketplace/item/555555555/', 'Just listed', '£400', 'Nissan Micra', 'March'))).toMatchObject({ title: 'Nissan Micra', location: 'March', pricePence: 40_000 });
  });
  it('dedupes the same advert seen twice, keeping the richer card', () => {
    const a = parseCard(card('/marketplace/item/666666666/', 'Honda Jazz'))!;
    const b = parseCard(card('/marketplace/item/666666666/?x=1', '£500', 'Honda Jazz', 'St Ives'))!;
    const d = dedupeCards([a, b]);
    expect(d).toHaveLength(1);
    expect(d[0]!.pricePence).toBe(50_000);
  });
});

describe('parseDetail', () => {
  it('keeps the description and the "Listed … ago" line as written, and redacts contact details', () => {
    const d = parseDetail({
      href: 'x',
      lines: ['£750', 'Mazda MX-5', 'Listed 2 hours ago in Ramsey, Cambridgeshire', 'Driven 98,000 miles', "Seller's description", 'Comes with hardtop. MOT till May.', 'Call 07700 900123 or a@b.com', 'Seller information', 'Jane Seller'],
    });
    expect(d.publishedText).toBe('Listed 2 hours ago in Ramsey, Cambridgeshire');
    expect(d.mileage).toBe(98_000);
    expect(d.description).toContain('hardtop');
    expect(d.description).not.toContain('07700');
    expect(d.description).not.toContain('a@b.com');
    expect(d.description).not.toContain('Jane');
  });
  it('leaves posting time null when the page does not show it', () => {
    expect(parseDetail({ href: 'x', lines: ['Description', 'Runs fine'] })).toMatchObject({ publishedText: null, description: 'Runs fine' });
  });
  it('redacts UK phone numbers in several formats', () => {
    expect(redactContact('ring +44 7700 900123 now')).toBe('ring [phone] now');
  });
});

describe('distance from Ramsey', () => {
  it('uses the town when known, the county as a low-confidence fallback, and unknown otherwise', () => {
    const h = distanceFromHome('Huntingdon, Cambridgeshire');
    expect(h.basis).toBe('town');
    expect(h.miles!).toBeGreaterThan(5);
    expect(h.miles!).toBeLessThan(12);
    expect(distanceFromHome('Somewhere Tiny, Norfolk').basis).toBe('county');
    expect(distanceFromHome('Atlantis')).toEqual({ miles: null, basis: 'unknown' });
    expect(distanceFromHome(null).basis).toBe('unknown');
    expect(distanceFromHome('London').miles!).toBeGreaterThan(55);
  });
});
