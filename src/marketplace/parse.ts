/**
 * Pure parsing of what the container saw on Marketplace search and item pages.
 *
 * The container returns only the visible text of each result card (split into
 * lines) and the item link. Everything here is deterministic and unit-tested;
 * nothing is inferred that the advert doesn't show. In particular the time an
 * advert was *posted* is only recorded when Marketplace shows it ("Listed 2
 * hours ago"), and even then as written. `first_seen_at` is when WE found it.
 */

export const SOURCE_FB = 'facebook_marketplace';

/** One result card as returned by the container's /collect endpoint. */
export interface RawCard {
  href: string;
  lines: string[];
  photo?: string | null;
}

/** One item page as returned by /details. */
export interface RawDetail {
  href: string;
  lines: string[];
}

export interface ParsedCard {
  source: typeof SOURCE_FB;
  sourceId: string;
  url: string;
  title: string;
  pricePence: number | null;
  /** A struck-through earlier price shown on the card, if any. */
  shownPreviousPence: number | null;
  currency: 'GBP' | null;
  free: boolean;
  location: string | null;
  mileage: number | null;
  year: number | null;
  photoRef: string | null;
}

export interface ParsedDetail {
  description: string | null;
  publishedText: string | null;
  mileage: number | null;
}

const ITEM_PATH = /\/marketplace\/item\/(\d{5,25})(?:[/?#]|$)/;

/** Stable Marketplace item ID from any item link (relative or absolute), or null. */
export function itemIdFromHref(href: string): string | null {
  let path = href;
  try {
    const u = new URL(href, 'https://www.facebook.com');
    if (!/(^|\.)facebook\.com$/i.test(u.hostname)) return null;
    path = u.pathname;
  } catch {
    return null;
  }
  return ITEM_PATH.exec(path)?.[1] ?? null;
}

/** The canonical original advert URL: no tracking parameters, no referral IDs. */
export function canonicalItemUrl(id: string): string {
  return `https://www.facebook.com/marketplace/item/${id}/`;
}

const PRICE_TOKEN = /£\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?/g;
const PRICE_LINE = /^(?:\s*(?:£\s?[\d,]+(?:\.\d{2})?|free)\s*)+$/i;
const MILEAGE_LINE = /^(?:driven\s+)?([\d.,]+)\s*(k)?\s*(miles?|mi|km|kilometres|kilometers)\b/i;
const YEAR = /\b(19[3-9]\d|20[0-3]\d)\b/;

export function parsePrices(line: string): { amounts: number[]; free: boolean } {
  const amounts: number[] = [];
  for (const m of line.matchAll(PRICE_TOKEN)) {
    const pounds = Number(m[1]!.replace(/,/g, ''));
    const pence = m[2] ? Number(m[2]) : 0;
    if (Number.isFinite(pounds)) amounts.push(pounds * 100 + pence);
  }
  return { amounts, free: /\bfree\b/i.test(line) };
}

export function parseMileage(line: string): number | null {
  const m = MILEAGE_LINE.exec(line.trim());
  if (!m) return null;
  let n = Number(m[1]!.replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  if (m[2]) n *= 1000;
  if (/^k(m|ilomet)/i.test(m[3]!)) n *= 0.621371;
  n = Math.round(n);
  return n > 0 && n < 2_000_000 ? n : null;
}

export function yearFrom(text: string): number | null {
  const m = YEAR.exec(text);
  if (!m) return null;
  const y = Number(m[1]);
  return y <= new Date().getUTCFullYear() + 1 ? y : null;
}

const NOISE = /^(sponsored|just listed|new listing|·|•|see more|shipping available|ships to you|pending)$/i;

/** Parse one result card. Returns null when the link is not a Marketplace item. */
export function parseCard(card: RawCard): ParsedCard | null {
  const id = itemIdFromHref(card.href);
  if (!id) return null;
  const lines = card.lines.map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l && !NOISE.test(l));

  let pricePence: number | null = null;
  let shownPreviousPence: number | null = null;
  let free = false;
  let mileage: number | null = null;
  const rest: string[] = [];
  let sawPrice = false;
  for (const l of lines) {
    if (!sawPrice && PRICE_LINE.test(l)) {
      sawPrice = true;
      const p = parsePrices(l);
      free = p.free && p.amounts.length === 0;
      pricePence = p.amounts[0] ?? (free ? 0 : null);
      // Marketplace shows a reduced price followed by the struck-through original.
      const prev = p.amounts[1];
      if (prev !== undefined && pricePence !== null && prev > pricePence) shownPreviousPence = prev;
      continue;
    }
    if (mileage === null) {
      const m = parseMileage(l);
      if (m !== null) {
        mileage = m;
        continue;
      }
    }
    rest.push(l);
  }
  const title = (rest[0] ?? '').slice(0, 200);
  const location = rest[1] ? rest[1].slice(0, 120) : null;
  return {
    source: SOURCE_FB,
    sourceId: id,
    url: canonicalItemUrl(id),
    title: title || '(untitled)',
    pricePence,
    shownPreviousPence,
    currency: pricePence !== null ? 'GBP' : null,
    free,
    location,
    mileage,
    year: yearFrom(title),
    photoRef: card.photo && /^https:\/\/[a-z0-9.-]+\.fbcdn\.net\//i.test(card.photo) ? card.photo.slice(0, 500) : null,
  };
}

/** Collapse duplicates within one run (the same item can appear in several searches or twice in one feed). */
export function dedupeCards(cards: readonly ParsedCard[]): ParsedCard[] {
  const byId = new Map<string, ParsedCard>();
  for (const c of cards) {
    const prev = byId.get(c.sourceId);
    // Prefer the richer card (has a price / location) when the same item appears twice.
    if (!prev || (prev.pricePence === null && c.pricePence !== null) || (!prev.location && c.location)) byId.set(c.sourceId, c);
  }
  return [...byId.values()];
}

const DESCRIPTION_HEADINGS = /^(seller'?s description|description|about this vehicle)$/i;
const STOP_HEADINGS =
  /^(seller information|seller details|location is approximate|today'?s picks|related listings|sponsored|send seller a message|message|see less|see translation|similar listings|more from this seller)$/i;

/** Remove things that are personal data and add nothing to a car lead. */
export function redactContact(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/(?:\+?44\s?|\b0)\d(?:[\s-]?\d){8,9}\b/g, '[phone]');
}

/** Parse an item page's visible text (description and "Listed … ago" line only). */
export function parseDetail(d: RawDetail, maxChars = 600): ParsedDetail {
  const lines = d.lines.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  let publishedText: string | null = null;
  let mileage: number | null = null;
  const desc: string[] = [];
  let inDesc = false;
  for (const l of lines) {
    if (!publishedText && /^listed\b.*\bago\b/i.test(l)) publishedText = l.slice(0, 120);
    if (mileage === null && /^driven\b/i.test(l)) mileage = parseMileage(l);
    if (DESCRIPTION_HEADINGS.test(l)) {
      inDesc = true;
      continue;
    }
    if (inDesc) {
      if (STOP_HEADINGS.test(l)) {
        inDesc = false;
        continue;
      }
      desc.push(l);
    }
  }
  const description = desc.length ? redactContact(desc.join('\n')).slice(0, maxChars) : null;
  return { description, publishedText, mileage };
}
