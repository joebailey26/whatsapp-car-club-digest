/**
 * Pure state and decision logic for the Marketplace controller (unit-tested).
 * Deliberately separate from src/container/lifecycle.ts so nothing here can
 * change the WhatsApp controller's behaviour.
 */

import { londonTime } from '../ops/schedule';

export const SNAPSHOT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SNAPSHOT_EXPIRY_MARGIN_MS = 24 * 60 * 60 * 1000;

export type FbState = 'not_running' | 'loading' | 'login' | 'checkpoint' | 'authenticated' | 'unknown';
export type MarketPhase = 'idle' | 'login_starting' | 'login_awaiting' | 'login_completing' | 'restore_testing' | 'collecting';
export type MarketOp = 'start_login' | 'complete_login' | 'restore_test' | 'collect';
export type MarketSession = 'unpaired' | 'signed_in' | 'relogin_required' | 'checkpoint' | 'unknown';

export interface MarketSnapshot {
  id: string;
  sizeBytes: number;
  createdAt: number;
  lastTouchedAt: number;
  imageVersion: string;
  origin: 'login' | 'restore_test' | 'collect';
  generation: number;
}

export interface MarketState {
  phase: MarketPhase;
  session: MarketSession;
  pendingOp: MarketOp | null;
  runningOp: MarketOp | null;
  opStartedAt: number | null;
  loginExpiresAt: number | null;
  controlToken: string | null;
  lastProbe: { state: FbState; signals: unknown } | null;
  lastError: { code: string; at: number; detail?: string } | null;
  pendingAlert: string | null;
  consecutiveFailures: number;
}

export const INITIAL_MARKET_STATE: MarketState = {
  phase: 'idle',
  session: 'unpaired',
  pendingOp: null,
  runningOp: null,
  opStartedAt: null,
  loginExpiresAt: null,
  controlToken: null,
  lastProbe: null,
  lastError: null,
  pendingAlert: null,
  consecutiveFailures: 0,
};

export function canQueueMarket(op: MarketOp, st: MarketState): { ok: true } | { ok: false; code: string } {
  if (st.pendingOp || st.runningOp) return { ok: false, code: 'BUSY' };
  switch (op) {
    case 'start_login':
      return st.phase === 'idle' || st.phase === 'login_awaiting' ? { ok: true } : { ok: false, code: 'INVALID_PHASE' };
    case 'complete_login':
      return st.phase === 'login_awaiting' ? { ok: true } : { ok: false, code: 'NOT_LOGGING_IN' };
    case 'restore_test':
    case 'collect':
      return st.phase === 'idle' ? { ok: true } : { ok: false, code: 'INVALID_PHASE' };
  }
}

export function snapshotUsable(s: MarketSnapshot | null, imageVersion: string, now: number): { ok: true } | { ok: false; code: 'NO_SNAPSHOT' | 'SNAPSHOT_EXPIRED' | 'SNAPSHOT_IMAGE_MISMATCH' } {
  if (!s) return { ok: false, code: 'NO_SNAPSHOT' };
  if (now >= s.lastTouchedAt + SNAPSHOT_TTL_MS - SNAPSHOT_EXPIRY_MARGIN_MS) return { ok: false, code: 'SNAPSHOT_EXPIRED' };
  if (s.imageVersion !== imageVersion) return { ok: false, code: 'SNAPSHOT_IMAGE_MISMATCH' };
  return { ok: true };
}

/** Re-snapshot only when the current one is old enough (cookies refresh slowly) or close to expiry. */
export function shouldResnapshot(s: MarketSnapshot, now: number, everyHours: number): boolean {
  return now - s.createdAt >= everyHours * 3_600_000 || now - s.lastTouchedAt >= SNAPSHOT_TTL_MS / 2;
}

export interface ScheduleState {
  collectionEnabled: boolean;
  intervalHours: number;
  approvedAt: string | null;
  riskAcknowledgedAt: string | null;
  pausedReason: string | null;
  lastSlot: string | null; // "YYYY-MM-DDTHH" (UTC) of the last collection started by the cron
  lastTickAt: string | null;
  lastResult: string | null;
  lastRoundupDate: string | null; // London date
  lastWatchdogDate: string | null; // London date
}

export const DEFAULT_SCHEDULE: ScheduleState = {
  collectionEnabled: false,
  intervalHours: 1,
  approvedAt: null,
  riskAcknowledgedAt: null,
  pausedReason: null,
  lastSlot: null,
  lastTickAt: null,
  lastResult: null,
  lastRoundupDate: null,
  lastWatchdogDate: null,
};

export const WATCHDOG_HOUR_LONDON = 6;

export interface TickDecision {
  collect: 'start' | 'disabled' | 'not_this_hour' | 'already_ran' | 'busy' | 'session_bad';
  roundup: boolean;
  watchdog: boolean;
  slot: string;
}

/** What one hourly cron tick should do (pure). */
export function decideTick(now: Date, sch: ScheduleState, st: Pick<MarketState, 'session' | 'pendingOp' | 'runningOp' | 'phase'>, roundup: { enabled: boolean; hourLondon: number }): TickDecision {
  const slot = now.toISOString().slice(0, 13);
  const lt = londonTime(now);
  let collect: TickDecision['collect'] = 'start';
  if (!sch.collectionEnabled) collect = 'disabled';
  else if (now.getUTCHours() % Math.max(1, sch.intervalHours) !== 0) collect = 'not_this_hour';
  else if (sch.lastSlot === slot) collect = 'already_ran';
  else if (st.session === 'relogin_required' || st.session === 'checkpoint' || st.session === 'unpaired') collect = 'session_bad';
  else if (st.pendingOp || st.runningOp || st.phase !== 'idle') collect = 'busy';
  return {
    collect,
    roundup: roundup.enabled && lt.hour === roundup.hourLondon && sch.lastRoundupDate !== lt.date,
    watchdog: lt.hour === WATCHDOG_HOUR_LONDON && sch.lastWatchdogDate !== lt.date,
    slot,
  };
}

/** Circuit breaker: pause the schedule after N consecutive failed runs. */
export function circuitOpen(consecutiveFailures: number, threshold: number): boolean {
  return consecutiveFailures >= threshold;
}

export type RunStatus = 'ok' | 'partial' | 'auth_failed' | 'failed' | 'skipped';

export function runStatus(o: { aborted: string | null; searchesOk: number; searchesFailed: number; sessionError: string | null }): RunStatus {
  if (o.aborted === 'login' || o.aborted === 'checkpoint') return 'auth_failed';
  if (o.sessionError) return 'failed';
  if (o.searchesOk === 0) return 'failed';
  return o.searchesFailed > 0 ? 'partial' : 'ok';
}
