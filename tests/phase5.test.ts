import { describe, expect, it } from 'vitest';
import { coverageFor } from '../src/digest/data';
import { buildDigest, coverageNote, digestKey, type DigestEvent, type GroupCoverage } from '../src/digest/model';
import { esc, renderDigest } from '../src/digest/render';
import { runDigest, type DigestDeps } from '../src/digest/send';

const NOW = '2026-11-24T08:00:00.000Z'; // Tue 24 Nov
const ev = (over: Partial<DigestEvent> = {}): DigestEvent => ({
  id: 'e1',
  title: 'Sunday Cars & Coffee',
  eventDate: '2026-11-29',
  startTime: '09:00',
  location: 'Brooklands Museum',
  meetingPoint: null,
  status: 'confirmed',
  rsvpRequired: false,
  rsvpDeadline: null,
  needsReview: false,
  createdAt: '2026-11-20T10:00:00.000Z',
  updatedAt: '2026-11-20T10:00:00.000Z',
  ...over,
});
const cov = (over: Partial<GroupCoverage> = {}): GroupCoverage => ({
  groupId: 'club-a',
  groupName: 'Club A',
  exportStatus: 'succeeded',
  processingStatus: 'processed',
  analysisStatus: 'analysed',
  newMessages: 42,
  exportedAt: NOW,
  ...over,
});
const build = (events: DigestEvent[], coverage: GroupCoverage[] = [cov()], extra: Partial<Parameters<typeof buildDigest>[0]> = {}) =>
  buildDigest({ id: '2026-11-29', generatedAt: NOW, periodFrom: '2026-11-17T08:00:00.000Z', events, revisions: [], provenance: [], coverage, ...extra });

// ════════════════════ model ════════════════════
describe('buildDigest', () => {
  it('sorts upcoming by date then time, undated last, and drops past events', () => {
    const m = build([
      ev({ id: 'b', title: 'Later', eventDate: '2026-12-06' }),
      ev({ id: 'a', title: 'Earlier late', eventDate: '2026-11-29', startTime: '18:00' }),
      ev({ id: 'c', title: 'Earlier early', eventDate: '2026-11-29', startTime: '08:00' }),
      ev({ id: 'd', title: 'Undated', eventDate: null, startTime: null }),
      ev({ id: 'p', title: 'Past', eventDate: '2026-11-21' }),
    ]);
    expect(m.upcoming.map((i) => i.title)).toEqual(['Earlier early', 'Earlier late', 'Later', 'Undated']);
    expect(m.upcoming[3]!.when).toBe('Date to be confirmed');
  });

  it('marks new items and explains changes since the previous digest', () => {
    const m = build([ev({ id: 'x', createdAt: '2026-11-01T10:00:00.000Z' }), ev({ id: 'n', title: 'Brand new', createdAt: '2026-11-23T10:00:00.000Z' })], [cov()], {
      revisions: [
        { eventId: 'x', changedAt: '2026-11-22T10:00:00.000Z', field: 'startTime', oldValue: '09:00', newValue: '10:00' },
        { eventId: 'x', changedAt: '2026-11-22T10:00:00.000Z', field: 'conflict:location', oldValue: 'Brooklands', newValue: 'Goodwood' },
        { eventId: 'x', changedAt: '2026-11-10T10:00:00.000Z', field: 'meetingPoint', oldValue: null, newValue: 'Gate 2' }, // before period
      ],
    });
    expect(m.upcoming.find((i) => i.eventId === 'n')!.badges).toContain('new');
    const x = m.changed.find((i) => i.eventId === 'x')!;
    expect(x.changes).toEqual(['Time changed from 09:00 to 10:00', 'Conflicting venue mentioned: Brooklands vs Goodwood']);
  });

  it('lists required replies as actions without implying the user has replied', () => {
    const m = build([ev({ rsvpRequired: true, rsvpDeadline: '2026-11-27' })]);
    expect(m.actions[0]!.action).toBe('Members asked to reply or book by Fri 27 Nov');
    const r = renderDigest(m);
    expect(r.text).toContain('does not mean you have replied to or booked anything');
    expect(r.text.toLowerCase()).not.toMatch(/you('| a)re (going|booked|attending)/);
  });

  it('shows recently cancelled future events and flags conflicting ones for review', () => {
    const m = build([
      ev({ id: 'c', status: 'cancelled', updatedAt: '2026-11-23T10:00:00.000Z' }),
      ev({ id: 'old', status: 'cancelled', createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z' }),
      ev({ id: 'r', title: 'Disputed', needsReview: true }),
    ]);
    expect(m.cancelled.map((i) => i.eventId)).toEqual(['c']);
    expect(m.review.map((i) => i.eventId)).toEqual(['r']);
    expect(renderDigest(m).text).toContain('Messages disagree on some details');
  });

  it('says "nothing identified" only when every group was fully checked', () => {
    const complete = build([], [cov(), cov({ groupId: 'club-b', groupName: 'Club B', processingStatus: 'empty' })]);
    expect(complete.coverageComplete).toBe(true);
    expect(complete.headline).toBe('No upcoming meets or actions were identified in the groups this week.');

    const partial = build([], [cov(), cov({ groupId: 'club-b', groupName: 'Club B', exportStatus: 'logged_out', processingStatus: null, analysisStatus: null })]);
    expect(partial.coverageComplete).toBe(false);
    expect(partial.missingGroups).toEqual(['Club B']);
    expect(partial.headline).toMatch(/1 of 2 group\(s\) could not be fully checked/);
    expect(partial.headline).not.toMatch(/^No upcoming meets or actions/);
    const r = renderDigest(partial);
    expect(r.subject).toMatch(/\(incomplete\)$/);
    expect(r.text).toContain('INCOMPLETE COVERAGE: Club B');
  });

  it('treats a group with no run, or failed analysis, as incomplete', () => {
    expect(build([], [cov({ exportStatus: 'not_run', processingStatus: null, analysisStatus: null })]).coverageComplete).toBe(false);
    expect(build([], [cov({ analysisStatus: 'budget_exceeded' })]).coverageComplete).toBe(false);
    expect(build([], []).coverageComplete).toBe(false); // no groups at all is never "complete"
  });

  it('gives provenance per group', () => {
    const m = build([ev()], [cov()], { provenance: [{ eventId: 'e1', groupName: 'Club A', lastMentionedAt: '2026-11-22T19:30:00.000Z' }] });
    expect(m.upcoming[0]!.provenance).toBe('Club A, last mentioned Sun 22 Nov');
  });

  it('keys the digest by the coming Sunday', () => {
    expect(digestKey('2026-11-24')).toBe('2026-11-29');
    expect(digestKey('2026-11-29')).toBe('2026-11-29');
  });
});

// ════════════════════ rendering ════════════════════
describe('renderDigest', () => {
  it('escapes message-derived text in HTML', () => {
    const m = build([ev({ title: '<script>alert(1)</script> & <b>meet</b>', location: '"><img src=x onerror=alert(1)>' })]);
    const r = renderDigest(m);
    expect(r.html).not.toContain('<script>alert');
    expect(r.html).not.toContain('<img src=x');
    expect(r.html).toContain('&lt;script&gt;');
    expect(esc(`a&<>"'`)).toBe('a&amp;&lt;&gt;&quot;&#39;');
  });
  it('produces matching subject, HTML and plain text', () => {
    const r = renderDigest(build([ev()]));
    expect(r.subject).toBe('Your Car Club Weekly Digest — 29 November 2026');
    expect(r.text).toContain('UPCOMING MEETS');
    expect(r.text).toContain('Sunday Cars & Coffee — Sun 29 Nov, 09:00');
    expect(r.html).toContain('Sunday Cars &amp; Coffee');
  });
  it('contains no remote resources', () => {
    const r = renderDigest(build([ev()]));
    expect(r.html).not.toMatch(/src=["']https?:|href=["']https?:/i);
  });
});

describe('coverage', () => {
  const runs = [
    { runId: 'old', startedAt: '2026-11-10T09:00:00Z', records: [{ id: 'old-a', groupId: 'club-a', status: 'succeeded', completedAt: '' }] },
    {
      runId: 'new',
      startedAt: '2026-11-23T09:00:00Z',
      records: [{ id: 'new-a', groupId: 'club-a', status: 'succeeded', completedAt: '2026-11-23T09:05:00Z' }],
      processing: [{ exportId: 'new-a', status: 'processed', messagesNew: 12 }],
      analysis: [{ exportId: 'new-a', status: 'analysed' }],
    },
  ];
  it('uses the latest run since the previous digest and marks unrun groups', () => {
    const c = coverageFor(
      [
        { id: 'club-a', name: 'A' },
        { id: 'club-b', name: 'B' },
      ],
      runs,
      '2026-11-17T00:00:00Z',
    );
    expect(c[0]).toMatchObject({ exportStatus: 'succeeded', processingStatus: 'processed', analysisStatus: 'analysed', newMessages: 12 });
    expect(c[1]).toMatchObject({ exportStatus: 'not_run' });
    expect(coverageNote(c[1]!)).toBe('Not exported this week');
    expect(coverageNote(c[0]!)).toBe('Checked 12 new messages');
  });
});

// ════════════════════ delivery state machine ════════════════════
class MemR2 {
  o = new Map<string, string>();
  async put(k: string, v: string) {
    this.o.set(k, v);
  }
  async get(k: string) {
    const v = this.o.get(k);
    return v === undefined ? null : { text: async () => v, json: async () => JSON.parse(v) };
  }
}
class MemD1 {
  digests = new Map<string, Record<string, unknown>>();
  events: Array<Record<string, unknown>> = [];
  prepare(sql: string) {
    const db = this;
    const mk = (args: unknown[]) => ({
      bind: (...a: unknown[]) => mk(a),
      first: async () => db.first(sql, args),
      all: async () => ({ results: db.all(sql, args) }),
      run: async () => {
        db.run(sql, args);
        return {};
      },
    });
    return mk([]);
  }
  first(sql: string, a: unknown[]) {
    if (sql.startsWith('SELECT id, period_to, status, attempts, r2_key FROM digests')) return this.digests.get(a[0] as string) ?? null;
    if (sql.startsWith('SELECT period_to FROM digests')) {
      const sent = [...this.digests.values()].filter((d) => d.status === 'sent' && d.id !== a[0]).sort((x, y) => String(y.period_to).localeCompare(String(x.period_to)));
      return sent[0] ? { period_to: sent[0].period_to } : null;
    }
    throw new Error(`first: ${sql.slice(0, 50)}`);
  }
  all(sql: string, _a: unknown[]) {
    if (/FROM events\b/.test(sql)) return this.events;
    if (sql.includes('FROM event_revisions') || sql.includes('FROM event_sources')) return [];
    if (sql.includes('FROM listings') || sql.includes('FROM listing_revisions')) return [];
    throw new Error(`all: ${sql.slice(0, 50)}`);
  }
  run(sql: string, a: unknown[]) {
    if (sql.startsWith('INSERT INTO digests')) {
      const [id, created_at, period_from, period_to, r2_key, coverage_complete, events_upcoming] = a;
      const prev = this.digests.get(id as string);
      this.digests.set(id as string, { ...prev, id, created_at, period_from, period_to, r2_key, coverage_complete, events_upcoming, status: prev?.status === 'sent' ? 'sent' : 'rendered', attempts: prev?.attempts ?? 0 });
    } else if (sql.startsWith("UPDATE digests SET status = 'sending'")) this.digests.get(a[1] as string)!.status = 'sending', (this.digests.get(a[1] as string)!.attempts = a[0]);
    else if (sql.startsWith("UPDATE digests SET status = 'sent'")) Object.assign(this.digests.get(a[2] as string)!, { status: 'sent', sent_at: a[0], message_id: a[1] });
    else if (sql.startsWith("UPDATE digests SET status = 'failed'")) Object.assign(this.digests.get(a[1] as string)!, { status: 'failed', last_error: a[0] });
    else throw new Error(`run: ${sql.slice(0, 50)}`);
  }
}

function deps(over: { fail?: string } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const db = new MemD1();
  db.events = [
    { id: 'e1', title: 'Sunday Cars & Coffee', event_date: '2026-11-29', start_time: '09:00', location: 'Brooklands', meeting_point: null, status: 'confirmed', rsvp_required: 0, rsvp_deadline: null, needs_review: 0, created_at: '2026-11-23T10:00:00Z', updated_at: '2026-11-23T10:00:00Z' },
  ];
  const email = {
    send: async (m: Record<string, unknown>) => {
      if (over.fail) throw Object.assign(new Error('nope'), { code: over.fail });
      sent.push(m);
      return { messageId: `msg-${sent.length}` };
    },
  };
  const d: DigestDeps = {
    db: db as unknown as D1Database,
    r2: new MemR2() as unknown as R2Bucket,
    email: email as unknown as SendEmail,
    from: 'digest@example.test',
    to: 'me@example.test',
    groups: [{ id: 'club-a', name: 'Club A', enabled: true }],
    runs: [{ runId: 'r', startedAt: '2026-11-23T09:00:00Z', records: [{ id: 'r-a', groupId: 'club-a', status: 'succeeded', completedAt: '2026-11-23T09:05:00Z' }], processing: [{ exportId: 'r-a', status: 'processed', messagesNew: 5 }], analysis: [{ exportId: 'r-a', status: 'analysed' }] }],
    now: new Date(NOW),
  };
  return { d, sent, db };
}

describe('runDigest', () => {
  it('sends once per week, then skips duplicates unless forced', async () => {
    const { d, sent, db } = deps();
    const first = await runDigest(d);
    expect(first).toMatchObject({ id: '2026-11-29', status: 'sent', messageId: 'msg-1', upcoming: 1, coverageComplete: true });
    expect(sent[0]).toMatchObject({ to: 'me@example.test', subject: 'Your Car Club Weekly Digest — 29 November 2026' });
    expect(String(sent[0]!.text)).toContain('Sunday Cars & Coffee');
    expect((await runDigest(d)).status).toBe('skipped_already_sent');
    expect(sent).toHaveLength(1);
    expect((await runDigest(d, { force: true })).status).toBe('sent');
    expect(sent).toHaveLength(2);
    expect(db.digests.get('2026-11-29')).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('stores the rendering before sending and records email failures separately', async () => {
    const { d, db } = deps({ fail: 'E_DELIVERY_FAILED' });
    const r = await runDigest(d);
    expect(r).toMatchObject({ status: 'failed', errorCode: 'E_DELIVERY_FAILED' });
    expect(db.digests.get('2026-11-29')).toMatchObject({ status: 'failed', last_error: 'E_DELIVERY_FAILED' });
    expect(await (d.r2 as unknown as MemR2).get('digests/2026-11-29/email.html')).not.toBeNull();
  });

  it('resends the stored rendering without regenerating', async () => {
    const failing = deps({ fail: 'E_RATE_LIMIT_EXCEEDED' });
    await runDigest(failing.d);
    const ok = deps();
    ok.d.r2 = failing.d.r2;
    ok.d.db = failing.d.db;
    (failing.db as MemD1).events = []; // if it regenerated, the event would vanish
    const r = await runDigest(ok.d, { resend: true });
    expect(r.status).toBe('sent');
    expect(String(ok.sent[0]!.text)).toContain('Sunday Cars & Coffee');
  });

  it('dry run renders and stores without sending', async () => {
    const { d, sent } = deps();
    expect((await runDigest(d, { dryRun: true })).status).toBe('rendered_only');
    expect(sent).toHaveLength(0);
  });
});

describe('coverage message counts', () => {
  it('sums new messages across all runs in the period', () => {
    const runs = [
      { runId: 'r1', startedAt: '2026-11-23T16:59:00Z', records: [{ id: 'r1-a', groupId: 'club-a', status: 'succeeded', completedAt: '' }], processing: [{ exportId: 'r1-a', status: 'processed', messagesNew: 356 }] },
      { runId: 'r2', startedAt: '2026-11-23T17:06:00Z', records: [{ id: 'r2-a', groupId: 'club-a', status: 'succeeded', completedAt: '' }], processing: [{ exportId: 'r2-a', status: 'processed', messagesNew: 2 }], analysis: [{ exportId: 'r2-a', status: 'analysed' }] },
    ];
    expect(coverageFor([{ id: 'club-a', name: 'A' }], runs, null)[0]!.newMessages).toBe(358);
    expect(coverageFor([{ id: 'club-a', name: 'A' }], runs, '2026-11-23T17:00:00Z')[0]!.newMessages).toBe(2);
  });
});

describe('export retry policy', () => {
  it('retries only UI timing failures with no download', async () => {
    const { isRetryableUiFailure } = await import('../src/container/lifecycle');
    expect(isRetryableUiFailure({ status: 'failed', errorCode: 'STEP_TIMEOUT', bytes: null })).toBe(true);
    expect(isRetryableUiFailure({ status: 'failed', errorCode: 'STEP_NOT_INTERACTABLE', bytes: null })).toBe(true);
    expect(isRetryableUiFailure({ status: 'logged_out', errorCode: 'RUN_REFUSED', bytes: null })).toBe(false);
    expect(isRetryableUiFailure({ status: 'wrong_chat', errorCode: 'CHAT_NOT_VERIFIED', bytes: null })).toBe(false);
    expect(isRetryableUiFailure({ status: 'corrupt', errorCode: 'DOWNLOAD_INCOMPLETE', bytes: null })).toBe(false);
    expect(isRetryableUiFailure({ status: 'failed', errorCode: 'STEP_TIMEOUT', bytes: 1234 })).toBe(false);
  });
});
