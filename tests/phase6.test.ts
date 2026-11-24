import { describe, expect, it } from 'vitest';
import { ALERT_COOLDOWN_MS, alertsForRun, renderAlert, shouldSend, type RunSummary } from '../src/ops/alerts';
import { isWeeklySlot, londonTime, nextWeeklySlot, WEEKLY_CRONS } from '../src/ops/schedule';

describe('weekly slot (Sunday 09:00 Europe/London)', () => {
  it('fires on the 09:00 UTC cron in winter (GMT) and not the 08:00 one', () => {
    expect(isWeeklySlot(new Date('2026-11-29T09:00:00Z'))).toBe(true);
    expect(isWeeklySlot(new Date('2026-11-29T08:00:00Z'))).toBe(false);
  });
  it('fires on the 08:00 UTC cron in summer (BST) and not the 09:00 one', () => {
    expect(isWeeklySlot(new Date('2027-06-06T08:00:00Z'))).toBe(true);
    expect(isWeeklySlot(new Date('2027-06-06T09:00:00Z'))).toBe(false);
  });
  it('handles the clock-change Sundays exactly once', () => {
    // 28 Mar 2027: clocks go forward at 01:00 UTC → 09:00 BST = 08:00 UTC
    expect([8, 9].filter((h) => isWeeklySlot(new Date(`2027-03-28T0${h}:00:00Z`)))).toEqual([8]);
    // 31 Oct 2027: clocks go back at 01:00 UTC → 09:00 GMT = 09:00 UTC
    expect([8, 9].filter((h) => isWeeklySlot(new Date(`2027-10-31T0${h}:00:00Z`)))).toEqual([9]);
  });
  it('never fires on other days', () => {
    expect(isWeeklySlot(new Date('2026-11-28T09:00:00Z'))).toBe(false); // Saturday
  });
  it('computes the next run', () => {
    expect(nextWeeklySlot(new Date('2026-11-24T12:00:00Z')).toISOString()).toBe('2026-11-29T09:00:00.000Z');
    expect(nextWeeklySlot(new Date('2026-11-29T09:00:00Z')).toISOString()).toBe('2026-12-06T09:00:00.000Z');
    expect(nextWeeklySlot(new Date('2027-03-25T12:00:00Z')).toISOString()).toBe('2027-03-28T08:00:00.000Z');
  });
  it('uses Cloudflare day names in the cron strings', () => {
    expect(WEEKLY_CRONS).toEqual(['0 8 * * SUN', '0 9 * * SUN']);
    expect(londonTime(new Date('2026-11-29T09:30:00Z'))).toEqual({ date: '2026-11-29', weekday: 0, hour: 9, minute: 30 });
  });
});

const healthy: RunSummary = {
  runId: 'run-1',
  sessionOutcome: 'pass',
  sessionError: null,
  records: [
    { groupName: 'Club A', status: 'succeeded', errorCode: null, failedStep: null },
    { groupName: 'Club B', status: 'succeeded', errorCode: null, failedStep: null },
  ],
  processing: [
    { groupName: 'Club A', status: 'processed', errorCode: null },
    { groupName: 'Club B', status: 'empty', errorCode: null },
  ],
  analysis: [
    { groupName: 'Club A', status: 'analysed', reason: null },
    { groupName: 'Club B', status: 'skipped', reason: 'no_new_messages' },
  ],
  digest: { status: 'sent', errorCode: null },
};

describe('alertsForRun', () => {
  it('stays quiet for a healthy run (including skipped digests)', () => {
    expect(alertsForRun(healthy)).toEqual([]);
    expect(alertsForRun({ ...healthy, digest: { status: 'skipped_already_sent', errorCode: null } })).toEqual([]);
  });
  it('sends only the re-link alert when WhatsApp is logged out', () => {
    const a = alertsForRun({ ...healthy, sessionOutcome: 'relink_required', records: healthy.records.map((r) => ({ ...r, status: 'logged_out' })) });
    expect(a.map((x) => x.code)).toEqual(['RELINK_REQUIRED']);
    expect(a[0]!.action).toMatch(/Start pairing/);
  });
  it('names each failed group and step', () => {
    const a = alertsForRun({ ...healthy, records: [{ groupName: 'Club A', status: 'failed', errorCode: 'STEP_TIMEOUT', failedStep: 'export#2' }, healthy.records[1]!] });
    expect(a.map((x) => x.code)).toEqual(['EXPORT_FAILED']);
    expect(a[0]!.detail).toEqual(['Club A: failed STEP_TIMEOUT at export#2']);
  });
  it('flags processing, analysis and digest failures separately', () => {
    const a = alertsForRun({
      ...healthy,
      processing: [{ groupName: 'Club A', status: 'failed', errorCode: 'ZIP_TRUNCATED' }],
      analysis: [{ groupName: 'Club B', status: 'budget_exceeded', reason: 'token_budget' }],
      digest: { status: 'failed', errorCode: 'E_DELIVERY_FAILED' },
    });
    expect(a.map((x) => x.code)).toEqual(['PROCESSING_FAILED', 'ANALYSIS_FAILED', 'DIGEST_SEND_FAILED']);
  });
  it('reports a session that failed for other reasons', () => {
    expect(alertsForRun({ ...healthy, sessionOutcome: 'error', sessionError: 'RESTORE_START_FAILED' }).map((x) => x.code)).toContain('SESSION_FAILED');
  });
});

describe('alert delivery rules', () => {
  it('sends each code at most once per cool-down', () => {
    const now = Date.UTC(2026, 10, 24, 12);
    expect(shouldSend('EXPORT_FAILED', {}, now)).toBe(true);
    expect(shouldSend('EXPORT_FAILED', { EXPORT_FAILED: now - 1000 }, now)).toBe(false);
    expect(shouldSend('EXPORT_FAILED', { EXPORT_FAILED: now - ALERT_COOLDOWN_MS }, now)).toBe(true);
    expect(shouldSend('RELINK_REQUIRED', { EXPORT_FAILED: now }, now)).toBe(true);
    expect(shouldSend('TEST', { TEST: now }, now)).toBe(true);
  });
  it('renders a plain-text alert with a link to the admin page', () => {
    const r = renderAlert(alertsForRun({ ...healthy, digest: { status: 'failed', errorCode: 'E_RATE_LIMIT_EXCEEDED' } })[0]!, 'https://example.test');
    expect(r.subject).toBe('[Car Club Digest] Alert: The weekly digest email could not be sent');
    expect(r.text).toContain('E_RATE_LIMIT_EXCEEDED');
    expect(r.text).toContain('https://example.test/admin');
    expect(r.text).toContain('contains no WhatsApp message content');
  });
});
