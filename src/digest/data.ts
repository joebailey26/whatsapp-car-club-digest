import type { DigestEvent, DigestRevision, GroupCoverage, Provenance } from './model';
import type { DigestListing, ListingChange } from './sales';

/** Listings seen or changed since `since` (or in the last 7 days), with their recent revisions. */
export async function loadListingData(
  db: D1Database,
  since: string,
  groupNames: ReadonlyMap<string, string>,
): Promise<{ listings: DigestListing[]; changes: ListingChange[] }> {
  const rows = await db
    .prepare('SELECT * FROM listings WHERE last_seen_at > ? OR updated_at > ? ORDER BY first_posted_at DESC LIMIT 200')
    .bind(since, since)
    .all<{ id: string; group_id: string; kind: 'car' | 'part'; title: string; year: number | null; price: string | null; mileage: string | null; location: string | null; details: string | null; status: DigestListing['status']; seller: string | null; first_posted_at: string; last_seen_at: string }>();
  const listings: DigestListing[] = rows.results.map((r) => ({
    id: r.id,
    groupName: groupNames.get(r.group_id) ?? r.group_id,
    kind: r.kind,
    title: r.title,
    year: r.year,
    price: r.price,
    mileage: r.mileage,
    location: r.location,
    details: r.details,
    status: r.status,
    seller: r.seller,
    firstPostedAt: r.first_posted_at,
    lastSeenAt: r.last_seen_at,
  }));
  const changes: ListingChange[] = [];
  const ids = listings.map((l) => l.id);
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const rv = await db
      .prepare(`SELECT listing_id, changed_at, field, old_value, new_value FROM listing_revisions WHERE changed_at > ? AND listing_id IN (${chunk.map(() => '?').join(',')})`)
      .bind(since, ...chunk)
      .all<{ listing_id: string; changed_at: string; field: string; old_value: string | null; new_value: string | null }>();
    for (const r of rv.results) changes.push({ listingId: r.listing_id, changedAt: r.changed_at, field: r.field, oldValue: r.old_value, newValue: r.new_value });
  }
  return { listings, changes };
}

/** D1 queries feeding the digest model. Undated events are included only if touched in the last 30 days. */
export async function loadDigestData(
  db: D1Database,
  today: string,
  groupNames: ReadonlyMap<string, string>,
): Promise<{ events: DigestEvent[]; revisions: DigestRevision[]; provenance: Provenance[] }> {
  const undatedSince = new Date(Date.parse(`${today}T00:00:00Z`) - 30 * 86_400_000).toISOString();
  const ev = await db
    .prepare(
      `SELECT id, title, event_date, start_time, location, meeting_point, status, rsvp_required, rsvp_deadline, needs_review, created_at, updated_at
       FROM events
       WHERE (event_date IS NOT NULL AND event_date >= ?) OR (event_date IS NULL AND updated_at >= ?)
       ORDER BY event_date LIMIT 300`,
    )
    .bind(today, undatedSince)
    .all<{
      id: string;
      title: string;
      event_date: string | null;
      start_time: string | null;
      location: string | null;
      meeting_point: string | null;
      status: DigestEvent['status'];
      rsvp_required: number;
      rsvp_deadline: string | null;
      needs_review: number;
      created_at: string;
      updated_at: string;
    }>();
  const events: DigestEvent[] = ev.results.map((r) => ({
    id: r.id,
    title: r.title,
    eventDate: r.event_date,
    startTime: r.start_time,
    location: r.location,
    meetingPoint: r.meeting_point,
    status: r.status,
    rsvpRequired: r.rsvp_required === 1,
    rsvpDeadline: r.rsvp_deadline,
    needsReview: r.needs_review === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
  if (events.length === 0) return { events, revisions: [], provenance: [] };

  const ids = events.map((e) => e.id);
  const revisions: DigestRevision[] = [];
  const provenance: Provenance[] = [];
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const ph = chunk.map(() => '?').join(',');
    const rv = await db
      .prepare(`SELECT event_id, changed_at, field, old_value, new_value FROM event_revisions WHERE event_id IN (${ph}) ORDER BY changed_at`)
      .bind(...chunk)
      .all<{ event_id: string; changed_at: string; field: string; old_value: string | null; new_value: string | null }>();
    for (const r of rv.results) revisions.push({ eventId: r.event_id, changedAt: r.changed_at, field: r.field, oldValue: r.old_value, newValue: r.new_value });
    const pv = await db
      .prepare(
        `SELECT es.event_id AS event_id, ms.group_id AS group_id, MAX(ms.ts) AS last_ts
         FROM event_sources es JOIN messages_seen ms ON ms.id = es.message_id
         WHERE es.event_id IN (${ph}) GROUP BY es.event_id, ms.group_id`,
      )
      .bind(...chunk)
      .all<{ event_id: string; group_id: string; last_ts: string }>();
    for (const p of pv.results) provenance.push({ eventId: p.event_id, groupName: groupNames.get(p.group_id) ?? p.group_id, lastMentionedAt: p.last_ts });
  }
  return { events, revisions, provenance };
}

function sumNew(runs: readonly RunForCoverage[], groupId: string): number {
  let n = 0;
  for (const run of runs) {
    for (const rec of run.records) {
      if (rec.groupId !== groupId) continue;
      n += run.processing?.find((x) => x.exportId === rec.id)?.messagesNew ?? 0;
    }
  }
  return n;
}

/** Minimal shapes of the controller's run records needed for coverage. */
export interface RunForCoverage {
  runId: string;
  startedAt: string;
  records: Array<{ id: string; groupId: string; status: string; completedAt: string }>;
  processing?: Array<{ exportId: string; status: string; messagesNew: number }>;
  analysis?: Array<{ exportId: string; status: string }>;
}

/**
 * Coverage per enabled group from the most recent run that includes it,
 * considering only runs started after the previous digest. A group with no
 * such run is "not_run", which marks the digest incomplete.
 */
export function coverageFor(groups: ReadonlyArray<{ id: string; name: string }>, runs: readonly RunForCoverage[], since: string | null): GroupCoverage[] {
  const recent = runs.filter((r) => !since || r.startedAt > since).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return groups.map((g) => {
    for (const run of recent) {
      const rec = run.records.find((x) => x.groupId === g.id);
      if (!rec) continue;
      const p = run.processing?.find((x) => x.exportId === rec.id);
      const a = run.analysis?.find((x) => x.exportId === rec.id);
      return {
        groupId: g.id,
        groupName: g.name,
        exportStatus: rec.status,
        processingStatus: p?.status ?? null,
        analysisStatus: a?.status ?? null,
        // Status comes from the latest run; new-message count covers every run in the period.
        newMessages: p ? sumNew(recent, g.id) : null,
        exportedAt: rec.completedAt,
      };
    }
    return { groupId: g.id, groupName: g.name, exportStatus: 'not_run', processingStatus: null, analysisStatus: null, newMessages: null, exportedAt: null };
  });
}
