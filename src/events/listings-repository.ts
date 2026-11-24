import type { ListingPlanItem, StoredListing } from '../ai/listings';

/** D1 access for sale listings. */

interface ListingRow {
  id: string;
  group_id: string;
  kind: 'car' | 'part';
  title: string;
  make: string | null;
  model: string | null;
  year: number | null;
  price: string | null;
  mileage: string | null;
  location: string | null;
  details: string | null;
  status: StoredListing['status'];
  seller: string | null;
  first_posted_at: string;
  last_seen_at: string;
}

const fromRow = (r: ListingRow): StoredListing => ({
  id: r.id,
  groupId: r.group_id,
  kind: r.kind,
  title: r.title,
  make: r.make,
  model: r.model,
  year: r.year,
  price: r.price,
  mileage: r.mileage,
  location: r.location,
  details: r.details,
  status: r.status,
  seller: r.seller,
  firstPostedAt: r.first_posted_at,
  lastSeenAt: r.last_seen_at,
});

/** Listings in a group seen within the last 90 days (candidates for matching). */
export async function loadListingsForMatching(db: D1Database, groupId: string, now: Date): Promise<StoredListing[]> {
  const since = new Date(now.getTime() - 90 * 86_400_000).toISOString();
  const r = await db.prepare('SELECT * FROM listings WHERE group_id = ? AND last_seen_at >= ? LIMIT 500').bind(groupId, since).all<ListingRow>();
  return r.results.map(fromRow);
}

export async function applyListingPlan(db: D1Database, plan: readonly ListingPlanItem[]): Promise<{ created: number; updated: number }> {
  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  let created = 0;
  let updated = 0;
  for (const it of plan) {
    const l = it.listing;
    if (it.action === 'create') {
      created++;
      stmts.push(
        db
          .prepare(
            `INSERT INTO listings (id, group_id, kind, title, make, model, year, price, mileage, location, details, status, seller,
               first_posted_at, last_seen_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(l.id, l.groupId, l.kind, l.title, l.make, l.model, l.year, l.price, l.mileage, l.location, l.details, l.status, l.seller, l.firstPostedAt, l.lastSeenAt, now, now),
      );
    } else {
      updated++;
      stmts.push(
        db
          .prepare(
            `UPDATE listings SET make = ?, model = ?, year = ?, price = ?, mileage = ?, location = ?, details = ?, status = ?,
               last_seen_at = ?, updated_at = ? WHERE id = ?`,
          )
          .bind(l.make, l.model, l.year, l.price, l.mileage, l.location, l.details, l.status, l.lastSeenAt, now, l.id),
      );
    }
    for (const r of it.revisions) {
      stmts.push(
        db
          .prepare('INSERT INTO listing_revisions (listing_id, changed_at, field, old_value, new_value, message_id) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(l.id, now, r.field, r.oldValue, r.newValue, r.messageId),
      );
    }
    for (const s of it.sources) {
      stmts.push(
        db.prepare('INSERT OR IGNORE INTO listing_sources (listing_id, message_id, export_id, evidence_excerpt) VALUES (?, ?, ?, ?)').bind(l.id, s.messageId, s.exportId, s.excerpt),
      );
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return { created, updated };
}
