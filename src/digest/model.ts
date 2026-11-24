import { buildSales, salesSummary, type DigestListing, type ListingChange, type SalesSection } from './sales';

/**
 * Pure digest model: turns events, their recent revisions and per-group
 * coverage into the sections the email shows. No I/O; unit-tested.
 *
 * Spec §8: prioritise upcoming events sorted by date, highlight changes since
 * the previous digest, call out deadlines and responses, consolidate across
 * groups, flag tentative or uncertain items, give provenance, never imply the
 * user has RSVP'd, keep it short, and NEVER claim "nothing happening" when
 * coverage is incomplete.
 */

export interface DigestEvent {
  id: string;
  title: string;
  eventDate: string | null; // YYYY-MM-DD
  startTime: string | null; // HH:MM
  location: string | null;
  meetingPoint: string | null;
  status: 'tentative' | 'confirmed' | 'updated' | 'cancelled';
  rsvpRequired: boolean;
  rsvpDeadline: string | null;
  needsReview: boolean;
  createdAt: string; // UTC ISO
  updatedAt: string;
}

export interface DigestRevision {
  eventId: string;
  changedAt: string; // UTC ISO
  field: string; // e.g. "startTime", "status", "conflict:location", "needsReview"
  oldValue: string | null;
  newValue: string | null;
}

export interface Provenance {
  eventId: string;
  groupName: string;
  lastMentionedAt: string; // UTC ISO of latest supporting message in that group
}

export interface GroupCoverage {
  groupId: string;
  groupName: string;
  exportStatus: string; // succeeded | failed | wrong_chat | logged_out | corrupt | skipped | not_run
  processingStatus: string | null; // processed | empty | failed | not_applicable | null
  analysisStatus: string | null; // analysed | skipped | failed | budget_exceeded | partial | null
  newMessages: number | null;
  exportedAt: string | null;
}

export interface DigestItem {
  eventId: string;
  title: string;
  when: string; // "Sun 29 Nov, 10:00" or "Date to be confirmed"
  date: string | null;
  where: string | null;
  meetingPoint: string | null;
  badges: Array<'tentative' | 'confirmed' | 'updated' | 'cancelled' | 'new' | 'check' | 'rsvp'>;
  changes: string[]; // human-readable "Time changed from 09:00 to 10:00"
  action: string | null; // "Reply by Fri 27 Nov" (never "you're going")
  provenance: string; // "Example Owners Group, last mentioned Sat 21 Nov"
  needsReview: boolean;
}

export interface DigestModel {
  id: string; // digest key
  generatedAt: string;
  periodFrom: string | null;
  today: string; // Europe/London date
  upcoming: DigestItem[];
  changed: DigestItem[];
  actions: DigestItem[];
  cancelled: DigestItem[];
  review: DigestItem[];
  coverage: GroupCoverage[];
  coverageComplete: boolean;
  missingGroups: string[];
  headline: string;
  /** "For sale" section (cars and parts posted by members). */
  sales: SalesSection;
}

const FIELD_LABEL: Record<string, string> = {
  eventDate: 'Date',
  startTime: 'Time',
  location: 'Venue',
  meetingPoint: 'Meeting point',
  rsvpDeadline: 'Reply deadline',
  rsvpRequired: 'Booking/RSVP',
  status: 'Status',
};

export function ukDate(iso: string): string {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
  const g = (t: string): string => p.find((x) => x.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')}`;
}

/** "Sun 29 Nov" (adds the year only when it differs from `today`'s). */
export function shortDate(ymd: string, today: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  const s = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(d);
  return ymd.slice(0, 4) === today.slice(0, 4) ? s : `${s} ${ymd.slice(0, 4)}`;
}

export function longDate(ymd: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${ymd}T12:00:00Z`));
}

/** The digest key: the date of the next Sunday on/after `today` (a weekly digest sent Sunday morning). */
export function digestKey(today: string): string {
  const d = new Date(`${today}T12:00:00Z`);
  const ahead = (7 - d.getUTCDay()) % 7;
  d.setUTCDate(d.getUTCDate() + ahead);
  return d.toISOString().slice(0, 10);
}

function describeChange(r: DigestRevision, today: string): string | null {
  const conflict = r.field.startsWith('conflict:');
  const field = conflict ? r.field.slice(9) : r.field;
  const label = FIELD_LABEL[field];
  if (!label) return null;
  const fmt = (v: string | null): string => {
    if (v === null || v === '') return 'not set';
    if ((field === 'eventDate' || field === 'rsvpDeadline') && /^\d{4}-\d{2}-\d{2}$/.test(v)) return shortDate(v, today);
    if (field === 'rsvpRequired') return v === 'true' ? 'required' : 'not required';
    return v;
  };
  if (conflict) return `Conflicting ${label.toLowerCase()} mentioned: ${fmt(r.oldValue)} vs ${fmt(r.newValue)}`;
  if (field === 'status') {
    if (r.newValue === 'cancelled') return 'Cancelled';
    if (r.oldValue === 'tentative' && r.newValue === 'confirmed') return 'Now confirmed';
    if (r.newValue === 'updated') return null; // implied by the field changes
    if (r.oldValue === null) return null; // creation
    return `Status: ${fmt(r.oldValue)} → ${fmt(r.newValue)}`;
  }
  if (r.oldValue === null) return `${label} added: ${fmt(r.newValue)}`;
  return `${label} changed from ${fmt(r.oldValue)} to ${fmt(r.newValue)}`;
}

export function buildDigest(input: {
  id: string;
  generatedAt: string;
  periodFrom: string | null;
  events: readonly DigestEvent[];
  revisions: readonly DigestRevision[];
  provenance: readonly Provenance[];
  coverage: readonly GroupCoverage[];
  listings?: readonly DigestListing[];
  listingChanges?: readonly ListingChange[];
  /** Override the sales look-back (e.g. all history). */
  salesSince?: string;
}): DigestModel {
  const today = ukDate(input.generatedAt);
  const since = input.periodFrom ?? '0000';
  const revsBy = new Map<string, DigestRevision[]>();
  for (const r of input.revisions) if (r.changedAt > since) revsBy.set(r.eventId, [...(revsBy.get(r.eventId) ?? []), r]);
  const provBy = new Map<string, Provenance[]>();
  for (const p of input.provenance) provBy.set(p.eventId, [...(provBy.get(p.eventId) ?? []), p]);

  const item = (e: DigestEvent): DigestItem => {
    const isNew = e.createdAt > since;
    const changes = isNew ? [] : (revsBy.get(e.id) ?? []).map((r) => describeChange(r, today)).filter((x): x is string => !!x);
    const badges: DigestItem['badges'] = [];
    if (e.status === 'cancelled') badges.push('cancelled');
    else if (e.status === 'tentative') badges.push('tentative');
    else if (e.status === 'updated') badges.push('updated');
    else badges.push('confirmed');
    if (isNew && e.status !== 'cancelled') badges.push('new');
    if (e.needsReview) badges.push('check');
    if (e.rsvpRequired) badges.push('rsvp');
    const when = e.eventDate ? `${shortDate(e.eventDate, today)}${e.startTime ? `, ${e.startTime}` : ''}` : 'Date to be confirmed';
    const action = e.rsvpRequired
      ? e.rsvpDeadline
        ? `Members asked to reply or book by ${shortDate(e.rsvpDeadline, today)}`
        : 'Members asked to reply or book (no deadline given)'
      : null;
    const prov = (provBy.get(e.id) ?? []).sort((a, b) => b.lastMentionedAt.localeCompare(a.lastMentionedAt));
    const provenance = prov.length
      ? prov.map((p) => `${p.groupName}, last mentioned ${shortDate(ukDate(p.lastMentionedAt), today)}`).join('; ')
      : 'Source group not recorded';
    return {
      eventId: e.id,
      title: e.title,
      when,
      date: e.eventDate,
      where: e.location,
      meetingPoint: e.meetingPoint,
      badges,
      changes,
      action,
      provenance,
      needsReview: e.needsReview,
    };
  };

  const byDate = (a: DigestEvent, b: DigestEvent): number => {
    if (a.eventDate && b.eventDate) return a.eventDate.localeCompare(b.eventDate) || (a.startTime ?? '99').localeCompare(b.startTime ?? '99');
    if (a.eventDate) return -1;
    if (b.eventDate) return 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  };

  const live = input.events.filter((e) => (!e.eventDate || e.eventDate >= today) && e.status !== 'cancelled').sort(byDate);
  const cancelledRecently = input.events
    .filter((e) => e.status === 'cancelled' && (!e.eventDate || e.eventDate >= today) && (e.updatedAt > since || e.createdAt > since))
    .sort(byDate);

  const upcoming = live.map(item);
  const changed = upcoming.filter((i) => i.changes.length > 0 && !i.badges.includes('new'));
  const actions = upcoming.filter((i) => i.action && !(i.date && i.date < today)).sort((a, b) => (a.action ?? '').localeCompare(b.action ?? ''));
  const review = upcoming.filter((i) => i.needsReview);
  const cancelled = cancelledRecently.map(item);

  const missing = input.coverage.filter((c) => c.exportStatus !== 'succeeded' || (c.processingStatus !== 'processed' && c.processingStatus !== 'empty') || (c.analysisStatus !== null && !['analysed', 'skipped'].includes(c.analysisStatus)));
  const coverageComplete = input.coverage.length > 0 && missing.length === 0;

  // Sales look back to the previous digest, or 7 days for the first one.
  const salesSince = input.salesSince ?? input.periodFrom ?? new Date(Date.parse(input.generatedAt) - 7 * 86_400_000).toISOString();
  const sales = buildSales(input.listings ?? [], input.listingChanges ?? [], salesSince, today);
  const salesLine = salesSummary(sales);

  let headline: string;
  if (upcoming.length === 0 && cancelled.length === 0) {
    headline = coverageComplete
      ? 'No upcoming meets or actions were identified in the groups this week.'
      : `No upcoming meets were identified in the groups that were checked, but ${missing.length} of ${input.coverage.length} group(s) could not be fully checked. See coverage below.`;
  } else {
    const parts = [`${upcoming.length} upcoming`];
    if (changed.length) parts.push(`${changed.length} changed`);
    if (cancelled.length) parts.push(`${cancelled.length} cancelled`);
    if (actions.length) parts.push(`${actions.length} needing a reply`);
    headline = `${parts.join(', ')}.${coverageComplete ? '' : ` Coverage is incomplete: ${missing.map((m) => m.groupName).join(', ')} not fully checked.`}`;
  }
  if (salesLine) headline += ` For sale: ${salesLine}.`;

  return {
    id: input.id,
    generatedAt: input.generatedAt,
    periodFrom: input.periodFrom,
    today,
    upcoming,
    changed,
    actions,
    cancelled,
    review,
    coverage: [...input.coverage],
    coverageComplete,
    missingGroups: missing.map((m) => m.groupName),
    headline,
    sales,
  };
}

export function coverageNote(c: GroupCoverage): string {
  if (c.exportStatus === 'not_run') return 'Not exported this week';
  if (c.exportStatus === 'logged_out') return 'Not checked: WhatsApp needs re-linking';
  if (c.exportStatus !== 'succeeded') return `Not checked: export ${c.exportStatus.replace('_', ' ')}`;
  if (c.processingStatus === 'failed') return 'Exported, but the messages could not be read';
  if (c.processingStatus === 'empty') return 'Checked: no messages in the period';
  if (c.analysisStatus === 'failed' || c.analysisStatus === 'partial' || c.analysisStatus === 'budget_exceeded') return `Checked ${c.newMessages ?? '?'} new messages, but event analysis was ${c.analysisStatus.replace('_', ' ')}`;
  return `Checked ${c.newMessages ?? 0} new message${c.newMessages === 1 ? '' : 's'}`;
}
