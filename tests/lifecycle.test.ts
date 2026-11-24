import { describe, expect, it } from 'vitest';
import {
  INITIAL_STATE,
  SNAPSHOT_TTL_MS,
  canQueue,
  checkSnapshotUsable,
  classifyRestore,
  consecutivePasses,
  isInterrupted,
  parseConfig,
  type ControllerState,
  type SnapshotRecord,
  type TestResult,
} from '../src/container/lifecycle';

const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);

const snap = (over: Partial<SnapshotRecord> = {}): SnapshotRecord => ({
  id: 'abc',
  sizeBytes: 100,
  name: null,
  createdAt: NOW,
  lastTouchedAt: NOW,
  imageVersion: '0.1.0',
  origin: 'pairing',
  generation: 0,
  ...over,
});

const result = (outcome: TestResult['outcome']): TestResult => ({
  at: NOW,
  outcome,
  errorCode: null,
  durationMs: 1,
  probe: null,
  generationBefore: 0,
  generationAfter: 1,
  imageVersion: '0.1.0',
  containerStopped: true,
});

describe('classifyRestore', () => {
  it('passes only when authenticated', () => {
    expect(classifyRestore({ state: 'authenticated', matched: [] })).toBe('pass');
  });
  it('treats a QR code as relink required', () => {
    expect(classifyRestore({ state: 'qr', matched: [] })).toBe('relink_required');
  });
  it.each(['loading', 'unknown', 'not_running'] as const)('treats %s as indeterminate, not a pass', (state) => {
    expect(classifyRestore({ state, matched: [] })).toBe('indeterminate');
  });
});

describe('checkSnapshotUsable', () => {
  it('rejects a missing snapshot', () => {
    expect(checkSnapshotUsable(null, '0.1.0', NOW)).toEqual({ ok: false, code: 'NO_SNAPSHOT' });
  });
  it('accepts a fresh snapshot on the same image', () => {
    expect(checkSnapshotUsable(snap(), '0.1.0', NOW)).toEqual({ ok: true });
  });
  it('rejects a snapshot taken on a different image version', () => {
    expect(checkSnapshotUsable(snap(), '0.2.0', NOW)).toEqual({ ok: false, code: 'SNAPSHOT_IMAGE_MISMATCH' });
  });
  it('treats a snapshot as expired a day before the 30-day TTL', () => {
    const s = snap({ lastTouchedAt: NOW - SNAPSHOT_TTL_MS + 12 * 3600_000 });
    expect(checkSnapshotUsable(s, '0.1.0', NOW)).toEqual({ ok: false, code: 'SNAPSHOT_EXPIRED' });
  });
  it('counts TTL from the last restore, not creation', () => {
    const s = snap({ createdAt: NOW - 40 * 86400_000, lastTouchedAt: NOW - 86400_000 });
    expect(checkSnapshotUsable(s, '0.1.0', NOW)).toEqual({ ok: true });
  });
});

describe('isInterrupted', () => {
  const running: ControllerState = { ...INITIAL_STATE, runningOp: 'restore_test', opStartedAt: NOW - 1000 };
  it('is false when nothing is running', () => {
    expect(isInterrupted(INITIAL_STATE, NOW, 480_000, false)).toBe(false);
  });
  it('is true in a fresh isolate that finds a recorded running op', () => {
    expect(isInterrupted(running, NOW, 480_000, false)).toBe(true);
  });
  it('is false for an op running in this isolate within its deadline', () => {
    expect(isInterrupted(running, NOW, 480_000, true)).toBe(false);
  });
  it('is true once an in-process op is well past its deadline', () => {
    expect(isInterrupted({ ...running, opStartedAt: NOW - 600_000 }, NOW, 480_000, true)).toBe(true);
  });
});

describe('canQueue', () => {
  it('refuses any op while another is pending or running', () => {
    expect(canQueue('restore_test', { ...INITIAL_STATE, pendingOp: 'start_pairing' })).toEqual({ ok: false, code: 'BUSY' });
    expect(canQueue('start_pairing', { ...INITIAL_STATE, runningOp: 'restore_test' })).toEqual({ ok: false, code: 'BUSY' });
  });
  it('only completes pairing while awaiting a scan', () => {
    expect(canQueue('complete_pairing', INITIAL_STATE).ok).toBe(false);
    expect(canQueue('complete_pairing', { ...INITIAL_STATE, phase: 'pairing_awaiting_scan' }).ok).toBe(true);
  });
  it('only runs a restore test from idle', () => {
    expect(canQueue('restore_test', INITIAL_STATE).ok).toBe(true);
    expect(canQueue('restore_test', { ...INITIAL_STATE, phase: 'pairing_awaiting_scan' }).ok).toBe(false);
  });
});

describe('consecutivePasses', () => {
  it('counts trailing passes only', () => {
    expect(consecutivePasses([result('pass'), result('relink_required'), result('pass'), result('pass')])).toBe(2);
    expect(consecutivePasses([result('pass'), result('error')])).toBe(0);
    expect(consecutivePasses([])).toBe(0);
  });
});

describe('parseConfig', () => {
  it('applies defaults and clamps values', () => {
    const c = parseConfig({ BROWSER_IMAGE_VERSION: '0.1.0', CONTAINER_INSTANCE: 'standard-2', OP_DEADLINE_MS: '99999999' });
    expect(c.instance).toBe('standard-2');
    expect(c.opDeadlineMs).toBe(12 * 60_000); // under the 15-minute alarm limit
    expect(c.pairingTtlMs).toBe(600_000);
  });
  it('rejects instance types not allowed under the durable_object policy', () => {
    expect(() => parseConfig({ BROWSER_IMAGE_VERSION: '0.1.0', CONTAINER_INSTANCE: 'basic' })).toThrow();
  });
  it('requires an image version', () => {
    expect(() => parseConfig({ CONTAINER_INSTANCE: 'standard-1' })).toThrow();
  });
});
