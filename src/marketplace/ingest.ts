import { distanceFromHome } from './geo';
import type { ParsedCard, ParsedDetail } from './parse';
import { isSignificantDrop, scoreListing, type Route, type Scoring } from './score';

/**
 * Pure ingest planning: compare one run's observations with what D1 already
 * holds and decide what to write and what to notify. Writes are applied
 * idempotently by the repository (upserts keyed by source + source ID, and
 * notifications keyed by listing + class + dedupe key), so re-applying the
 * same plan, or a run that sees the same advert twice, never double-alerts.
 */

export type NotificationClass = 'urgent_new' | 'urgent_price_drop' | 'urgent_ai' | 'urgent_manual' | 'daily';

export interface StoredMarketListing {
  id: string;
  source: string;
  sourceId: string;
  url: string;
  title: string;
  pricePence: number | null;
  location: string | null;
  distanceMiles: number | null;
  distanceBasis: 'town' | 'county' | 'unknown';
  year: number | null;
  mileage: number | null;
  description: string | null;
  publishedText: string | null;
  photoRef: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  firstSearchId: string | null;
  status: 'active' | 'missing';
  baseline: boolean;
  score: number | null;
  route: Route | null;
  reasons: string[];
  rulesetVersion: string | null;
  reviewState: 'new' | 'interested' | 'passed' | 'ignored';
}

export interface Observation {
  card: ParsedCard;
  detail: ParsedDetail | null;
  searchId: string;
}

export interface PlanItem {
  kind: 'new' | 'seen' | 'price_drop' | 'price_change';
  listing: StoredMarketListing;
  priceChanged: boolean;
  previousPricePence: number | null;
  borderline: boolean;
  notify: { class: NotificationClass; dedupeKey: string } | null;
}

export interface IngestPlan {
  items: PlanItem[];
  counts: { seen: number; new: number; priceDrops: number; urgent: number; review: number; baseline: number };
}

export function listingId(source: string, sourceId: string): string {
  return `${source}:${sourceId}`;
}

/**
 * @param baselineSearches searches whose first successful collection this is: their new
 *   adverts are stored as baseline and never alerted (prevents a first-run flood).
 */
export function planIngest(
  observations: readonly Observation[],
  existing: ReadonlyMap<string, StoredMarketListing>,
  opts: { now: string; scoring: Scoring; baselineSearches: ReadonlySet<string> },
): IngestPlan {
  const items: PlanItem[] = [];
  const counts = { seen: 0, new: 0, priceDrops: 0, urgent: 0, review: 0, baseline: 0 };
  const done = new Set<string>();

  for (const o of observations) {
    const c = o.card;
    const id = listingId(c.source, c.sourceId);
    if (done.has(id)) continue; // same advert in two searches: first wins
    done.add(id);
    counts.seen++;

    const prev = existing.get(id) ?? null;
    const dist = distanceFromHome(c.location);
    const description = o.detail?.description ?? prev?.description ?? null;
    const year = c.year ?? prev?.year ?? null;

    let previousPricePence: number | null = null;
    let drop: number | null = null;
    let priceChanged = false;
    if (prev) {
      priceChanged = c.pricePence !== null && prev.pricePence !== c.pricePence;
      if (priceChanged && isSignificantDrop(prev.pricePence, c.pricePence, opts.scoring.priceDrop)) {
        previousPricePence = prev.pricePence;
        drop = prev.pricePence! - c.pricePence!;
      }
    } else if (c.shownPreviousPence !== null && c.pricePence !== null && isSignificantDrop(c.shownPreviousPence, c.pricePence, opts.scoring.priceDrop)) {
      // A new-to-us advert already showing a reduced price.
      previousPricePence = c.shownPreviousPence;
      drop = c.shownPreviousPence - c.pricePence;
    }

    const s = scoreListing(
      {
        title: c.title,
        description,
        pricePence: c.pricePence ?? prev?.pricePence ?? null,
        distanceMiles: dist.miles,
        distanceBasis: dist.basis,
        year,
        priceDropPence: drop,
        previousPricePence,
      },
      opts.scoring,
    );

    const isNew = prev === null;
    const baseline = isNew ? opts.baselineSearches.has(o.searchId) : prev.baseline;
    const listing: StoredMarketListing = {
      id,
      source: c.source,
      sourceId: c.sourceId,
      url: c.url,
      title: c.title,
      pricePence: c.pricePence ?? prev?.pricePence ?? null,
      location: c.location ?? prev?.location ?? null,
      distanceMiles: dist.miles,
      distanceBasis: dist.basis,
      year,
      mileage: o.detail?.mileage ?? c.mileage ?? prev?.mileage ?? null,
      description,
      publishedText: o.detail?.publishedText ?? prev?.publishedText ?? null,
      photoRef: c.photoRef ?? prev?.photoRef ?? null,
      firstSeenAt: prev?.firstSeenAt ?? opts.now,
      lastSeenAt: opts.now,
      firstSearchId: prev?.firstSearchId ?? o.searchId,
      status: 'active',
      baseline,
      score: s.score,
      route: s.route,
      reasons: s.reasons,
      rulesetVersion: s.rulesetVersion,
      reviewState: prev?.reviewState ?? 'new',
    };

    let notify: PlanItem['notify'] = null;
    const dismissed = listing.reviewState === 'passed' || listing.reviewState === 'ignored';
    if (isNew && baseline) {
      counts.baseline++;
    } else if (!dismissed && isNew) {
      if (s.route === 'urgent') notify = { class: 'urgent_new', dedupeKey: 'new' };
      else if (s.route === 'review') notify = { class: 'daily', dedupeKey: 'new' };
    } else if (!dismissed && drop !== null && c.pricePence !== null) {
      if (s.route === 'urgent') notify = { class: 'urgent_price_drop', dedupeKey: String(c.pricePence) };
      else if (s.route === 'review') notify = { class: 'daily', dedupeKey: `drop:${c.pricePence}` };
    }

    if (isNew) counts.new++;
    if (drop !== null && !isNew) counts.priceDrops++;
    if (notify?.class.startsWith('urgent')) counts.urgent++;
    if (notify?.class === 'daily') counts.review++;

    items.push({
      kind: isNew ? 'new' : drop !== null ? 'price_drop' : priceChanged ? 'price_change' : 'seen',
      listing,
      priceChanged: isNew || priceChanged,
      previousPricePence,
      borderline: s.borderline && !dismissed && !baseline,
      notify,
    });
  }
  return { items, counts };
}

/**
 * Listings stop being "active" only after a run in which every enabled search
 * completed: a partial run proves nothing about what is gone. Results are not
 * guaranteed complete even then, so this is "missing", never "sold".
 */
export function canMarkMissing(run: { searchesOk: number; searchesFailed: number }): boolean {
  return run.searchesFailed === 0 && run.searchesOk > 0;
}
