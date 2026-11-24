import type { Grounded } from './grounding';

/**
 * Deterministic event reconciliation (spec §6 Stage B, §7).
 *
 * Grounded candidates are matched against stored events by title, date and
 * location similarity. No AI is used here. The result is a plan of creates,
 * field updates (each with a revision record) and evidence links, applied by
 * the repository.
 *
 * Rules:
 *  - Fill a missing field from any grounded candidate.
 *  - A differing value replaces an existing one only when the candidate is an
 *    explicit change/update with confidence ≥ CHANGE_CONFIDENCE. Otherwise the
 *    event is marked needs_review and the conflict is recorded, not applied.
 *  - tentative → confirmed only with confidence ≥ CONFIRM_CONFIDENCE.
 *  - A cancellation (already proven in its sources by grounding) cancels the
 *    matched event; an unmatched cancellation is stored as a needs_review event.
 *  - Events dated in the past are not modified by new mentions; the mention
 *    is linked as evidence only.
 */

export const CHANGE_CONFIDENCE = 0.7;
export const CONFIRM_CONFIDENCE = 0.7;
export const MATCH_THRESHOLD = 0.5;

export interface StoredEvent {
  id: string;
  groupId: string;
  title: string;
  eventDate: string | null;
  startTime: string | null;
  location: string | null;
  meetingPoint: string | null;
  status: 'tentative' | 'confirmed' | 'updated' | 'cancelled';
  confidence: number | null;
  rsvpRequired: boolean;
  rsvpDeadline: string | null;
  notes: string | null;
  needsReview: boolean;
}

export type Field = 'title' | 'eventDate' | 'startTime' | 'location' | 'meetingPoint' | 'status' | 'rsvpRequired' | 'rsvpDeadline' | 'needsReview' | 'notes' | 'confidence';

export interface Revision {
  field: Field;
  oldValue: string | null;
  newValue: string | null;
  messageId: string | null;
  /** "applied" changed the event; "conflict" recorded evidence without changing it. */
  kind: 'applied' | 'conflict' | 'created';
}

export interface PlanItem {
  action: 'create' | 'update' | 'evidence_only';
  event: StoredEvent; // the resulting event state
  revisions: Revision[];
  sources: Array<{ messageId: string; exportId: string; excerpt: string }>;
}

const STOP = new Set(['the', 'and', 'for', 'with', 'meet', 'meetup', 'event', 'club', 'car', 'cars', 'run', 'day', 'this', 'next', 'our', 'sunday', 'saturday', 'monthly', 'weekly']);

function words(s: string | null): Set<string> {
  if (!s) return new Set();
  return new Set(
    s
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

export function matchScore(c: Grounded['candidate'], e: StoredEvent, groupId?: string): number {
  const cTitle = words(`${c.title} ${c.refersTo ?? ''}`);
  const eTitle = words(e.title);
  let s = jaccard(cTitle, eTitle) * 0.6;
  // Containment helps short titles ("Cars and Coffee" vs "Sunday Cars & Coffee at Brooklands")
  const contained = [...eTitle].filter((w) => cTitle.has(w)).length;
  if (eTitle.size > 0 && contained / eTitle.size >= 0.6) s += 0.2;
  if (c.date && e.eventDate) {
    if (c.date === e.eventDate) s += 0.35;
    else if (c.kind !== 'change') return 0; // different dates, not a change → different events
  }
  if (c.location && e.location && jaccard(words(c.location), words(e.location)) > 0) s += 0.15;
  // Generic titles ("Saturday meet", "Saturday Car Meet") carry no distinguishing words. In the same
  // group on the same date they are the same meet unless their locations clearly differ.
  if (groupId && e.groupId === groupId && c.date && c.date === e.eventDate && cTitle.size === 0 && eTitle.size === 0) {
    const locClash = c.location && e.location && jaccard(words(c.location), words(e.location)) === 0;
    if (!locClash) s += 0.2;
  }
  return Math.min(1, s);
}

export function findMatch(c: Grounded['candidate'], events: readonly StoredEvent[], groupId?: string): StoredEvent | null {
  let best: StoredEvent | null = null;
  let bestScore = 0;
  for (const e of events) {
    const s = matchScore(c, e, groupId);
    if (s > bestScore) {
      best = e;
      bestScore = s;
    }
  }
  return bestScore >= MATCH_THRESHOLD ? best : null;
}

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export function reconcile(
  grounded: readonly Grounded[],
  existing: readonly StoredEvent[],
  opts: { groupId: string; today: string; newId: () => string },
): PlanItem[] {
  // Work on a mutable copy so several candidates in one batch merge into one event.
  const events = existing.map((e) => ({ ...e }));
  const plan = new Map<string, PlanItem>();

  const itemFor = (e: StoredEvent, action: PlanItem['action']): PlanItem => {
    let it = plan.get(e.id);
    if (!it) {
      it = { action, event: e, revisions: [], sources: [] };
      plan.set(e.id, it);
    } else if (it.action === 'evidence_only' && action === 'update') it.action = 'update';
    return it;
  };

  for (const g of grounded) {
    const c = g.candidate;
    const firstMsg = g.sources[0]?.id ?? null;
    const evidence = g.sources.map((s) => ({ messageId: s.id, exportId: s.exportId, excerpt: s.text.replace(/\s+/g, ' ').slice(0, 200) }));
    const isCancel = c.kind === 'cancellation' || c.status === 'cancelled';
    if (c.kind === 'announcement' && !c.date && !isCancel) continue; // no event to track

    const match = findMatch(c, events, opts.groupId);

    if (!match) {
      // A meet that has already happened is not worth tracking for a weekly digest.
      if (c.date && c.date < opts.today) continue;
      // A change to an event we have no record of: keep it visible as a tentative event for review,
      // unless it carries nothing to show.
      if (c.kind === 'change' && !c.date && !c.location && !c.meetingPoint && !c.startTime) continue;
      const e: StoredEvent = {
        id: opts.newId(),
        groupId: opts.groupId,
        title: c.title,
        eventDate: c.date,
        startTime: c.startTime,
        location: c.location,
        meetingPoint: c.meetingPoint,
        status: isCancel ? 'cancelled' : c.kind === 'change' ? 'tentative' : c.confidence >= CONFIRM_CONFIDENCE && c.status === 'confirmed' ? 'confirmed' : 'tentative',
        confidence: c.confidence,
        rsvpRequired: c.rsvpRequired,
        rsvpDeadline: c.rsvpDeadline,
        notes: c.notes,
        // A cancellation of an event we never saw announced needs a human look.
        needsReview: isCancel || c.kind === 'change' || g.flags.length > 0,
      };
      events.push(e);
      const it = itemFor(e, 'create');
      it.revisions.push({ field: 'status', oldValue: null, newValue: e.status, messageId: firstMsg, kind: 'created' });
      it.sources.push(...evidence);
      continue;
    }

    const e = match;
    const isPast = !!e.eventDate && e.eventDate < opts.today;
    if (isPast) {
      itemFor(e, 'evidence_only').sources.push(...evidence);
      continue;
    }
    const it = itemFor(e, 'update');
    it.sources.push(...evidence);
    const explicitChange = (c.kind === 'change' || c.status === 'updated') && c.confidence >= CHANGE_CONFIDENCE;

    const setField = <K extends keyof StoredEvent & Field>(field: K, value: StoredEvent[K] | null): void => {
      if (value === null || value === undefined) return;
      const old = e[field];
      if (old === value) return;
      if (old === null || old === undefined) {
        (e as unknown as Record<string, unknown>)[field] = value;
        it.revisions.push({ field, oldValue: null, newValue: str(value), messageId: firstMsg, kind: 'applied' });
      } else if (explicitChange) {
        (e as unknown as Record<string, unknown>)[field] = value;
        it.revisions.push({ field, oldValue: str(old), newValue: str(value), messageId: firstMsg, kind: 'applied' });
        if (e.status !== 'cancelled' && e.status !== 'updated') {
          it.revisions.push({ field: 'status', oldValue: e.status, newValue: 'updated', messageId: firstMsg, kind: 'applied' });
          e.status = 'updated';
        }
      } else {
        it.revisions.push({ field, oldValue: str(old), newValue: str(value), messageId: firstMsg, kind: 'conflict' });
        if (!e.needsReview) {
          e.needsReview = true;
          it.revisions.push({ field: 'needsReview', oldValue: 'false', newValue: 'true', messageId: firstMsg, kind: 'applied' });
        }
      }
    };

    if (isCancel) {
      if (e.status !== 'cancelled') {
        it.revisions.push({ field: 'status', oldValue: e.status, newValue: 'cancelled', messageId: firstMsg, kind: 'applied' });
        e.status = 'cancelled';
      }
      continue;
    }
    if (e.status === 'cancelled') {
      // A later mention of a cancelled event: possible reinstatement. Don't guess; flag it.
      if (c.status === 'confirmed' && !e.needsReview) {
        e.needsReview = true;
        it.revisions.push({ field: 'needsReview', oldValue: 'false', newValue: 'true', messageId: firstMsg, kind: 'applied' });
      }
      continue;
    }

    setField('eventDate', c.date);
    setField('startTime', c.startTime);
    setField('location', c.location);
    setField('meetingPoint', c.meetingPoint);
    setField('rsvpDeadline', c.rsvpDeadline);
    if (c.rsvpRequired && !e.rsvpRequired) setField('rsvpRequired', true);
    if (e.status === 'tentative' && c.status === 'confirmed' && c.confidence >= CONFIRM_CONFIDENCE) {
      it.revisions.push({ field: 'status', oldValue: 'tentative', newValue: 'confirmed', messageId: firstMsg, kind: 'applied' });
      e.status = 'confirmed';
    }
  }
  return [...plan.values()];
}
