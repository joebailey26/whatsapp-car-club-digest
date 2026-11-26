import type { Search } from './config';
import type { NotificationClass, PlanItem, StoredMarketListing } from './ingest';
import type { Route } from './score';

/** D1 access for the Marketplace collector. Every write is idempotent. */

interface ListingRow {
  id: string;
  source: string;
  source_id: string;
  url: string;
  title: string;
  price_pence: number | null;
  location: string | null;
  distance_miles: number | null;
  distance_basis: string | null;
  year: number | null;
  mileage: number | null;
  description: string | null;
  published_text: string | null;
  photo_ref: string | null;
  first_seen_at: string;
  last_seen_at: string;
  first_search_id: string | null;
  status: string;
  baseline: number;
  score: number | null;
  route: string | null;
  reasons: string | null;
  ruleset_version: string | null;
  review_state: string;
}

export function fromRow(r: ListingRow): StoredMarketListing {
  let reasons: string[] = [];
  try {
    reasons = r.reasons ? (JSON.parse(r.reasons) as string[]) : [];
  } catch {
    reasons = [];
  }
  return {
    id: r.id,
    source: r.source,
    sourceId: r.source_id,
    url: r.url,
    title: r.title,
    pricePence: r.price_pence,
    location: r.location,
    distanceMiles: r.distance_miles,
    distanceBasis: (r.distance_basis as StoredMarketListing['distanceBasis']) ?? 'unknown',
    year: r.year,
    mileage: r.mileage,
    description: r.description,
    publishedText: r.published_text,
    photoRef: r.photo_ref,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    firstSearchId: r.first_search_id,
    status: r.status === 'missing' ? 'missing' : 'active',
    baseline: r.baseline === 1,
    score: r.score,
    route: (r.route as Route | null) ?? null,
    reasons,
    rulesetVersion: r.ruleset_version,
    reviewState: (r.review_state as StoredMarketListing['reviewState']) ?? 'new',
  };
}

// ───────────── searches ─────────────

export interface SearchRow extends Search {
  baselineDoneAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
}

export async function loadSearches(db: D1Database): Promise<SearchRow[]> {
  const r = await db
    .prepare('SELECT id, label, url, enabled, max_scrolls, baseline_done_at, last_ok_at, last_error FROM market_searches ORDER BY created_at, id')
    .all<{ id: string; label: string; url: string; enabled: number; max_scrolls: number; baseline_done_at: string | null; last_ok_at: string | null; last_error: string | null }>();
  return r.results.map((x) => ({
    id: x.id,
    label: x.label,
    url: x.url,
    enabled: x.enabled === 1,
    maxScrolls: x.max_scrolls,
    baselineDoneAt: x.baseline_done_at,
    lastOkAt: x.last_ok_at,
    lastError: x.last_error,
  }));
}

/** Replace the search list. Kept searches keep their baseline state; removed ones are deleted. Changing a URL resets the baseline. */
export async function saveSearches(db: D1Database, searches: readonly Search[], source: string, now: string): Promise<void> {
  const stmts: D1PreparedStatement[] = [];
  const ids = searches.map((s) => s.id);
  stmts.push(
    ids.length
      ? db.prepare(`DELETE FROM market_searches WHERE id NOT IN (${ids.map(() => '?').join(',')})`).bind(...ids)
      : db.prepare('DELETE FROM market_searches'),
  );
  for (const s of searches) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO market_searches (id, source, label, url, enabled, max_scrolls, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET label = excluded.label, enabled = excluded.enabled, max_scrolls = excluded.max_scrolls,
             baseline_done_at = CASE WHEN market_searches.url = excluded.url THEN market_searches.baseline_done_at ELSE NULL END,
             url = excluded.url, updated_at = excluded.updated_at`,
        )
        .bind(s.id, source, s.label, s.url, s.enabled ? 1 : 0, s.maxScrolls, now, now),
    );
  }
  await db.batch(stmts);
}

export async function recordSearchOutcomes(db: D1Database, outcomes: ReadonlyArray<{ id: string; ok: boolean; error: string | null }>, now: string): Promise<void> {
  if (!outcomes.length) return;
  await db.batch(
    outcomes.map((o) =>
      o.ok
        ? db.prepare('UPDATE market_searches SET last_ok_at = ?, last_error = NULL, baseline_done_at = COALESCE(baseline_done_at, ?) WHERE id = ?').bind(now, now, o.id)
        : db.prepare('UPDATE market_searches SET last_error = ? WHERE id = ?').bind(o.error ?? 'failed', o.id),
    ),
  );
}

// ───────────── listings ─────────────

export async function loadListings(db: D1Database, ids: readonly string[]): Promise<Map<string, StoredMarketListing>> {
  const out = new Map<string, StoredMarketListing>();
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const r = await db.prepare(`SELECT * FROM market_listings WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all<ListingRow>();
    for (const row of r.results) out.set(row.id, fromRow(row));
  }
  return out;
}

export async function getListing(db: D1Database, id: string): Promise<StoredMarketListing | null> {
  const r = await db.prepare('SELECT * FROM market_listings WHERE id = ?').bind(id).first<ListingRow>();
  return r ? fromRow(r) : null;
}

/** Upsert listings, append price history, and create notification rows (INSERT OR IGNORE = dedupe). */
export async function applyPlan(db: D1Database, items: readonly PlanItem[], runId: string, now: string): Promise<{ notificationsCreated: number }> {
  const stmts: D1PreparedStatement[] = [];
  for (const it of items) {
    const l = it.listing;
    stmts.push(
      db
        .prepare(
          `INSERT INTO market_listings (id, source, source_id, url, title, price_pence, currency, location, distance_miles, distance_basis, year, mileage,
             description, published_text, photo_ref, first_seen_at, last_seen_at, first_search_id, status, baseline, score, route, reasons, ruleset_version,
             review_state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, 'new', ?, ?)
           ON CONFLICT (id) DO UPDATE SET title = excluded.title, price_pence = excluded.price_pence, location = excluded.location,
             distance_miles = excluded.distance_miles, distance_basis = excluded.distance_basis, year = excluded.year, mileage = excluded.mileage,
             description = excluded.description, published_text = excluded.published_text, photo_ref = excluded.photo_ref,
             last_seen_at = excluded.last_seen_at, status = 'active', score = excluded.score, route = excluded.route, reasons = excluded.reasons,
             ruleset_version = excluded.ruleset_version, updated_at = excluded.updated_at`,
        )
        .bind(
          l.id, l.source, l.sourceId, l.url, l.title, l.pricePence, l.pricePence === null ? null : 'GBP', l.location, l.distanceMiles, l.distanceBasis,
          l.year, l.mileage, l.description, l.publishedText, l.photoRef, l.firstSeenAt, l.lastSeenAt, l.firstSearchId, l.baseline ? 1 : 0, l.score,
          l.route, JSON.stringify(l.reasons), l.rulesetVersion, now, now,
        ),
    );
    if (it.priceChanged) {
      stmts.push(db.prepare('INSERT OR IGNORE INTO market_price_history (listing_id, observed_at, price_pence, run_id) VALUES (?, ?, ?, ?)').bind(l.id, now, l.pricePence, runId));
    }
    if (it.notify) {
      stmts.push(
        db
          .prepare("INSERT OR IGNORE INTO market_notifications (listing_id, class, dedupe_key, status, run_id, created_at) VALUES (?, ?, ?, 'pending', ?, ?)")
          .bind(l.id, it.notify.class, it.notify.dedupeKey, runId, now),
      );
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return { notificationsCreated: items.filter((x) => x.notify).length };
}

/** Pending urgent notifications for a run (or any run), joined to their listings. */
export async function pendingNotifications(
  db: D1Database,
  classes: readonly NotificationClass[],
  opts: { runId?: string; since?: string; limit: number },
): Promise<Array<{ listing: StoredMarketListing; class: NotificationClass; dedupeKey: string }>> {
  const where = [`n.status = 'pending'`, `n.class IN (${classes.map(() => '?').join(',')})`];
  const binds: unknown[] = [...classes];
  if (opts.runId) {
    where.push('n.run_id = ?');
    binds.push(opts.runId);
  }
  if (opts.since) {
    where.push('n.created_at >= ?');
    binds.push(opts.since);
  }
  const r = await db
    .prepare(
      `SELECT l.*, n.class AS n_class, n.dedupe_key AS n_key FROM market_notifications n JOIN market_listings l ON l.id = n.listing_id
       WHERE ${where.join(' AND ')} AND l.review_state NOT IN ('passed', 'ignored') ORDER BY l.score DESC LIMIT ?`,
    )
    .bind(...binds, opts.limit)
    .all<ListingRow & { n_class: NotificationClass; n_key: string }>();
  return r.results.map((row) => ({ listing: fromRow(row), class: row.n_class, dedupeKey: row.n_key }));
}

export async function markNotifications(
  db: D1Database,
  rows: ReadonlyArray<{ listingId: string; class: NotificationClass; dedupeKey: string }>,
  status: 'sent' | 'failed' | 'suppressed',
  now: string,
  error: string | null = null,
): Promise<void> {
  if (!rows.length) return;
  await db.batch(
    rows.map((r) =>
      db
        .prepare('UPDATE market_notifications SET status = ?, sent_at = ?, error = ? WHERE listing_id = ? AND class = ? AND dedupe_key = ?')
        .bind(status, status === 'sent' ? now : null, error, r.listingId, r.class, r.dedupeKey),
    ),
  );
}

/** True if this listing already had an urgent email of any class (so the roundup never repeats it). */
export async function alreadyAlerted(db: D1Database, listingIds: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < listingIds.length; i += 80) {
    const chunk = listingIds.slice(i, i + 80);
    const r = await db
      .prepare(`SELECT DISTINCT listing_id FROM market_notifications WHERE status = 'sent' AND class LIKE 'urgent%' AND listing_id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk)
      .all<{ listing_id: string }>();
    for (const x of r.results) out.add(x.listing_id);
  }
  return out;
}

export async function insertNotification(db: D1Database, listingId: string, cls: NotificationClass, key: string, runId: string | null, now: string): Promise<boolean> {
  const r = await db
    .prepare("INSERT OR IGNORE INTO market_notifications (listing_id, class, dedupe_key, status, run_id, created_at) VALUES (?, ?, ?, 'pending', ?, ?)")
    .bind(listingId, cls, key, runId, now)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}

export async function setAiResult(db: D1Database, id: string, v: { priority: string; reason: string; confidence: number } | null, now: string): Promise<void> {
  if (!v) return;
  await db.prepare('UPDATE market_listings SET ai_priority = ?, ai_reason = ?, ai_confidence = ?, ai_at = ? WHERE id = ?').bind(v.priority, v.reason.slice(0, 300), v.confidence, now, id).run();
}

export async function markMissing(db: D1Database, olderThan: string): Promise<number> {
  const r = await db.prepare("UPDATE market_listings SET status = 'missing' WHERE status = 'active' AND last_seen_at < ?").bind(olderThan).run();
  return r.meta?.changes ?? 0;
}

/** Delete old listings and everything hanging off them. Listings marked interested are kept. */
export async function applyRetention(db: D1Database, cutoff: string, runCutoff: string): Promise<void> {
  const sel = "SELECT id FROM market_listings WHERE last_seen_at < ? AND review_state != 'interested'";
  await db.batch([
    db.prepare(`DELETE FROM market_price_history WHERE listing_id IN (${sel})`).bind(cutoff),
    db.prepare(`DELETE FROM market_notifications WHERE listing_id IN (${sel})`).bind(cutoff),
    db.prepare(`DELETE FROM market_feedback WHERE listing_id IN (${sel})`).bind(cutoff),
    db.prepare("DELETE FROM market_listings WHERE last_seen_at < ? AND review_state != 'interested'").bind(cutoff),
    db.prepare('DELETE FROM market_runs WHERE started_at < ?').bind(runCutoff),
  ]);
}

// ───────────── feedback ─────────────

export type FeedbackAction = 'interested' | 'pass' | 'ignore' | 'send_alert';

export async function recordFeedback(db: D1Database, l: StoredMarketListing, action: FeedbackAction, reason: string | null, actor: string | null, now: string): Promise<void> {
  const state = action === 'interested' ? 'interested' : action === 'pass' ? 'passed' : action === 'ignore' ? 'ignored' : null;
  const stmts = [
    db
      .prepare('INSERT INTO market_feedback (listing_id, action, reason, score, route, ruleset_version, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(l.id, action, reason ? reason.slice(0, 300) : null, l.score, l.route, l.rulesetVersion, actor, now),
  ];
  if (state) stmts.push(db.prepare('UPDATE market_listings SET review_state = ?, updated_at = ? WHERE id = ?').bind(state, now, l.id));
  await db.batch(stmts);
}

// ───────────── runs ─────────────

export interface RunRow {
  id: string;
  trigger: 'scheduled' | 'manual' | 'dry_run';
  startedAt: string;
  completedAt: string | null;
  status: 'ok' | 'partial' | 'auth_failed' | 'failed' | 'skipped';
  errorCode: string | null;
  searchesOk: number;
  searchesFailed: number;
  itemsSeen: number;
  newCount: number;
  priceDrops: number;
  urgentCount: number;
  reviewCount: number;
  alertEmailSentAt: string | null;
  firstSeenToEmailMs: number | null;
  instance: string | null;
  billableMs: number | null;
  timings: Record<string, number | null>;
}

export async function saveRun(db: D1Database, r: RunRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO market_runs (id, trigger, started_at, completed_at, status, error_code, searches_ok, searches_failed, items_seen, new_count, price_drops,
         urgent_count, review_count, alert_email_sent_at, first_seen_to_email_ms, instance, billable_ms, timings)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET completed_at = excluded.completed_at, status = excluded.status, error_code = excluded.error_code,
         searches_ok = excluded.searches_ok, searches_failed = excluded.searches_failed, items_seen = excluded.items_seen, new_count = excluded.new_count,
         price_drops = excluded.price_drops, urgent_count = excluded.urgent_count, review_count = excluded.review_count,
         alert_email_sent_at = excluded.alert_email_sent_at, first_seen_to_email_ms = excluded.first_seen_to_email_ms, billable_ms = excluded.billable_ms,
         timings = excluded.timings`,
    )
    .bind(
      r.id, r.trigger, r.startedAt, r.completedAt, r.status, r.errorCode, r.searchesOk, r.searchesFailed, r.itemsSeen, r.newCount, r.priceDrops,
      r.urgentCount, r.reviewCount, r.alertEmailSentAt, r.firstSeenToEmailMs, r.instance, r.billableMs, JSON.stringify(r.timings),
    )
    .run();
}

export async function recentRuns(db: D1Database, limit: number): Promise<unknown[]> {
  const r = await db.prepare('SELECT * FROM market_runs ORDER BY started_at DESC LIMIT ?').bind(limit).all<Record<string, unknown>>();
  return r.results.map((x) => ({ ...x, timings: safeJson(x.timings) }));
}

/** Billable measurements (runs that started a container), newest first, optionally since a date. */
export async function measuredRuns(db: D1Database, opts: { since?: string; limit: number }): Promise<Array<{ instance: string; billableMs: number; cpuSeconds: number | null; startedAt: string }>> {
  const r = await db
    .prepare(`SELECT instance, billable_ms, timings, started_at FROM market_runs WHERE billable_ms > 0 ${opts.since ? 'AND started_at >= ?' : ''} ORDER BY started_at DESC LIMIT ?`)
    .bind(...(opts.since ? [opts.since, opts.limit] : [opts.limit]))
    .all<{ instance: string | null; billable_ms: number; timings: string | null; started_at: string }>();
  return r.results.map((x) => {
    const t = safeJson(x.timings) as { cpuSeconds?: number | null } | null;
    return { instance: x.instance ?? 'standard-2', billableMs: x.billable_ms, cpuSeconds: typeof t?.cpuSeconds === 'number' ? t.cpuSeconds : null, startedAt: x.started_at };
  });
}

function safeJson(v: unknown): unknown {
  if (typeof v !== 'string') return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

// ───────────── admin views ─────────────

export type ListingView = 'new' | 'alerted' | 'review' | 'dismissed' | 'interested' | 'all';

export async function listListings(db: D1Database, view: ListingView, limit: number): Promise<StoredMarketListing[]> {
  const q: Record<ListingView, string> = {
    new: "SELECT * FROM market_listings WHERE review_state = 'new' AND baseline = 0 ORDER BY first_seen_at DESC LIMIT ?",
    alerted: "SELECT * FROM market_listings WHERE id IN (SELECT listing_id FROM market_notifications WHERE status = 'sent' AND class LIKE 'urgent%') ORDER BY first_seen_at DESC LIMIT ?",
    review: "SELECT * FROM market_listings WHERE route = 'review' AND review_state = 'new' ORDER BY first_seen_at DESC LIMIT ?",
    dismissed: "SELECT * FROM market_listings WHERE review_state IN ('passed', 'ignored') ORDER BY updated_at DESC LIMIT ?",
    interested: "SELECT * FROM market_listings WHERE review_state = 'interested' ORDER BY updated_at DESC LIMIT ?",
    all: 'SELECT * FROM market_listings ORDER BY last_seen_at DESC LIMIT ?',
  };
  const r = await db.prepare(q[view]).bind(limit).all<ListingRow>();
  return r.results.map(fromRow);
}

export async function listingDetail(db: D1Database, id: string): Promise<unknown | null> {
  const l = await getListing(db, id);
  if (!l) return null;
  const [prices, notes, feedback] = await Promise.all([
    db.prepare('SELECT observed_at, price_pence, run_id FROM market_price_history WHERE listing_id = ? ORDER BY observed_at').bind(id).all(),
    db.prepare('SELECT class, dedupe_key, status, created_at, sent_at, error FROM market_notifications WHERE listing_id = ? ORDER BY created_at').bind(id).all(),
    db.prepare('SELECT action, reason, score, route, ruleset_version, actor, created_at FROM market_feedback WHERE listing_id = ? ORDER BY created_at').bind(id).all(),
  ]);
  return { listing: l, priceHistory: prices.results, notifications: notes.results, feedback: feedback.results };
}

/** Stored listings for a threshold replay (most recent first). */
export async function listingsForReplay(db: D1Database, limit: number): Promise<StoredMarketListing[]> {
  const r = await db.prepare('SELECT * FROM market_listings ORDER BY first_seen_at DESC LIMIT ?').bind(limit).all<ListingRow>();
  return r.results.map(fromRow);
}
