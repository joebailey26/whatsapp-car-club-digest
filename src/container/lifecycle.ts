/**
 * Pure state and decision logic for the browser controller. No Cloudflare
 * APIs here, so it is unit-testable in plain Node.
 */

export const SNAPSHOT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // documented implicit TTL
export const SNAPSHOT_EXPIRY_MARGIN_MS = 24 * 60 * 60 * 1000; // treat as expired a day early

export type WhatsAppState = 'not_running' | 'loading' | 'qr' | 'authenticated' | 'unknown';

export interface Probe {
  state: WhatsAppState;
  matched: string[];
}

export type Phase =
  | 'idle'
  | 'pairing_starting'
  | 'pairing_awaiting_scan'
  | 'pairing_completing'
  | 'restore_testing'
  | 'inspecting'
  | 'exporting'
  | 'processing'
  | 'analysing'
  | 'evaluating'
  | 'digesting';

export type OpName = 'start_pairing' | 'complete_pairing' | 'restore_test' | 'inspect' | 'export' | 'process' | 'analyse' | 'eval' | 'digest';

/** Ops that restore the snapshot, use the logged-in session, then re-snapshot. */
export const SESSION_OPS: readonly OpName[] = ['restore_test', 'inspect', 'export'];

export type SessionHealth = 'unpaired' | 'paired' | 'relink_required' | 'unknown';

export interface SnapshotRecord {
  id: string;
  sizeBytes: number;
  name: string | null;
  createdAt: number;
  /** Creation or last successful restore; the 30-day TTL counts from here. */
  lastTouchedAt: number;
  /** Image version the snapshot was taken on; it can only restore into that image. */
  imageVersion: string;
  origin: 'pairing' | 'restore_test' | 'inspect' | 'export';
  /** 0 for the pairing snapshot, +1 for each successful restore→re-snapshot cycle. */
  generation: number;
}

export interface ErrorInfo {
  code: string;
  at: number;
  detail?: string;
}

export interface ControllerState {
  phase: Phase;
  session: SessionHealth;
  pendingOp: OpName | null;
  runningOp: OpName | null;
  opStartedAt: number | null;
  pairingExpiresAt: number | null;
  controlToken: string | null;
  lastProbe: Probe | null;
  lastError: ErrorInfo | null;
  /** Alert to send on the next alarm tick (set where sending is unsafe, e.g. the constructor). */
  pendingAlert?: string | null;
}

export const INITIAL_STATE: ControllerState = {
  phase: 'idle',
  session: 'unpaired',
  pendingOp: null,
  runningOp: null,
  opStartedAt: null,
  pairingExpiresAt: null,
  controlToken: null,
  lastProbe: null,
  lastError: null,
};

export type RestoreOutcome = 'pass' | 'relink_required' | 'indeterminate';

export interface TestResult {
  at: number;
  outcome: RestoreOutcome | 'error';
  errorCode: string | null;
  durationMs: number;
  probe: Probe | null;
  generationBefore: number | null;
  generationAfter: number | null;
  imageVersion: string | null;
  /** Verified that ctx.container.running was false after the test. */
  containerStopped: boolean;
}

export interface Config {
  instance: string;
  imageVersion: string;
  pairingTtlMs: number;
  postAuthSettleMs: number;
  restoreSettleMs: number;
  opDeadlineMs: number;
}

const INSTANCES = new Set(['lite', 'standard-1', 'standard-2', 'standard-3', 'standard-4']);

export function parseConfig(env: Record<string, unknown>): Config {
  const num = (key: string, fallback: number, min: number, max: number): number => {
    const raw = env[key];
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : fallback;
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, min), max);
  };
  const instance = typeof env.CONTAINER_INSTANCE === 'string' ? env.CONTAINER_INSTANCE : 'standard-1';
  if (!INSTANCES.has(instance)) throw new Error(`CONTAINER_INSTANCE "${instance}" is not valid under the durable_object policy`);
  const imageVersion = typeof env.BROWSER_IMAGE_VERSION === 'string' ? env.BROWSER_IMAGE_VERSION.trim() : '';
  if (!imageVersion) throw new Error('BROWSER_IMAGE_VERSION is not set');
  return {
    instance,
    imageVersion,
    pairingTtlMs: num('PAIRING_TTL_MS', 600_000, 60_000, 30 * 60_000),
    postAuthSettleMs: num('POST_AUTH_SETTLE_MS', 45_000, 0, 5 * 60_000),
    restoreSettleMs: num('RESTORE_SETTLE_MS', 90_000, 10_000, 5 * 60_000),
    // Must stay well under the 15-minute alarm handler limit.
    opDeadlineMs: num('OP_DEADLINE_MS', 480_000, 60_000, 12 * 60_000),
  };
}

export function classifyRestore(probe: Probe): RestoreOutcome {
  if (probe.state === 'authenticated') return 'pass';
  if (probe.state === 'qr') return 'relink_required';
  return 'indeterminate';
}

export function snapshotExpiresAt(s: SnapshotRecord): number {
  return s.lastTouchedAt + SNAPSHOT_TTL_MS;
}

export type Usability = { ok: true } | { ok: false; code: 'NO_SNAPSHOT' | 'SNAPSHOT_EXPIRED' | 'SNAPSHOT_IMAGE_MISMATCH' };

/**
 * Whether a stored snapshot can be restored. A mismatched image version is
 * refused rather than restored: restoring would silently run the old image.
 */
export function checkSnapshotUsable(s: SnapshotRecord | null, expectedImageVersion: string, now: number): Usability {
  if (!s) return { ok: false, code: 'NO_SNAPSHOT' };
  if (now >= snapshotExpiresAt(s) - SNAPSHOT_EXPIRY_MARGIN_MS) return { ok: false, code: 'SNAPSHOT_EXPIRED' };
  if (s.imageVersion !== expectedImageVersion) return { ok: false, code: 'SNAPSHOT_IMAGE_MISMATCH' };
  return { ok: true };
}

/**
 * An op is interrupted when it was marked running but the Durable Object was
 * evicted/restarted before it finished. Interrupted ops are never re-run
 * automatically (no silent retries against WhatsApp).
 */
export function isInterrupted(st: ControllerState, now: number, opDeadlineMs: number, inProcess: boolean): boolean {
  if (!st.runningOp || st.opStartedAt === null) return false;
  if (!inProcess) return true; // nothing in this isolate is executing it
  return now - st.opStartedAt > opDeadlineMs + 60_000;
}

export function consecutivePasses(results: readonly TestResult[]): number {
  // results ordered oldest → newest
  let n = 0;
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i]!.outcome !== 'pass') break;
    n++;
  }
  return n;
}

/** Which ops are allowed to start from which phase. */
export function canQueue(op: OpName, st: ControllerState): { ok: true } | { ok: false; code: string } {
  if (st.pendingOp || st.runningOp) return { ok: false, code: 'BUSY' };
  switch (op) {
    case 'start_pairing':
      return st.phase === 'idle' || st.phase === 'pairing_awaiting_scan' ? { ok: true } : { ok: false, code: 'INVALID_PHASE' };
    case 'complete_pairing':
      return st.phase === 'pairing_awaiting_scan' ? { ok: true } : { ok: false, code: 'NOT_PAIRING' };
    case 'restore_test':
    case 'inspect':
    case 'export':
    case 'process':
    case 'analyse':
    case 'eval':
    case 'digest':
      return st.phase === 'idle' ? { ok: true } : { ok: false, code: 'INVALID_PHASE' };
  }
}

/** A UI step timed out or wasn't clickable, before any download began. Safe to retry the group once. */
export function isRetryableUiFailure(rec: { status: string; errorCode: string | null; bytes: number | null }): boolean {
  return rec.status === 'failed' && rec.bytes === null && (rec.errorCode === 'STEP_TIMEOUT' || rec.errorCode === 'STEP_NOT_INTERACTABLE');
}
