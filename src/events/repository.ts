import type { PlanItem, StoredEvent } from '../ai/reconcile';

/** D1 access for events, evidence and revision history. */

interface EventRow {
  id: string;
  group_id: string;
  title: string;
  event_date: string | null;
  start_time: string | null;
  location: string | null;
  meeting_point: string | null;
  status: StoredEvent['status'];
  confidence: number | null;
  rsvp_required: number;
  rsvp_deadline: string | null;
  notes: string | null;
  needs_review: number;
}

const fromRow = (r: EventRow): StoredEvent => ({
  id: r.id,
  groupId: r.group_id,
  title: r.title,
  eventDate: r.event_date,
  startTime: r.start_time,
  location: r.location,
  meetingPoint: r.meeting_point,
  status: r.status,
  confidence: r.confidence,
  rsvpRequired: r.rsvp_required === 1,
  rsvpDeadline: r.rsvp_deadline,
  notes: r.notes,
  needsReview: r.needs_review === 1,
});

/**
 * Events eligible for matching: undated ones, and dated ones from 30 days ago
 * onwards. Matching works across all groups, so the same meet discussed in two
 * groups merges into one event.
 */
export async function loadCandidatesForMatching(db: D1Database, today: string): Promise<StoredEvent[]> {
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10);
  const rows = await db
    .prepare('SELECT * FROM events WHERE event_date IS NULL OR event_date >= ? ORDER BY event_date LIMIT 500')
    .bind(since)
    .all<EventRow>();
  return rows.results.map(fromRow);
}

export async function applyPlan(db: D1Database, plan: readonly PlanItem[]): Promise<{ created: number; updated: number; evidence: number }> {
  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  let created = 0;
  let updated = 0;
  let evidence = 0;
  for (const it of plan) {
    const e = it.event;
    if (it.action === 'create') {
      created++;
      stmts.push(
        db
          .prepare(
            `INSERT INTO events (id, group_id, title, event_date, start_time, timezone, location, meeting_point, status, confidence,
               rsvp_required, rsvp_deadline, notes, needs_review, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'Europe/London', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(e.id, e.groupId, e.title, e.eventDate, e.startTime, e.location, e.meetingPoint, e.status, e.confidence, e.rsvpRequired ? 1 : 0, e.rsvpDeadline, e.notes, e.needsReview ? 1 : 0, now, now),
      );
    } else if (it.action === 'update' && it.revisions.some((r) => r.kind === 'applied')) {
      updated++;
      stmts.push(
        db
          .prepare(
            `UPDATE events SET event_date = ?, start_time = ?, location = ?, meeting_point = ?, status = ?, rsvp_required = ?,
               rsvp_deadline = ?, needs_review = ?, updated_at = ? WHERE id = ?`,
          )
          .bind(e.eventDate, e.startTime, e.location, e.meetingPoint, e.status, e.rsvpRequired ? 1 : 0, e.rsvpDeadline, e.needsReview ? 1 : 0, now, e.id),
      );
    } else evidence++;
    for (const r of it.revisions) {
      stmts.push(
        db
          .prepare('INSERT INTO event_revisions (event_id, changed_at, field, old_value, new_value, message_id) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(e.id, now, r.kind === 'conflict' ? `conflict:${r.field}` : r.field, r.oldValue, r.newValue, r.messageId),
      );
    }
    for (const s of it.sources) {
      stmts.push(
        db
          .prepare('INSERT OR IGNORE INTO event_sources (event_id, message_id, export_id, evidence_excerpt) VALUES (?, ?, ?, ?)')
          .bind(e.id, s.messageId, s.exportId, s.excerpt),
      );
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return { created, updated, evidence };
}
