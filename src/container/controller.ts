import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types/env';
import {
  INITIAL_STATE,
  canQueue,
  checkSnapshotUsable,
  classifyRestore,
  consecutivePasses,
  isInterrupted,
  parseConfig,
  snapshotExpiresAt,
  type Config,
  type ControllerState,
  type OpName,
  type Probe,
  type RestoreOutcome,
  type SnapshotRecord,
  type TestResult,
  isRetryableUiFailure,
} from './lifecycle';
import {
  FlowSchema,
  GroupsConfigSchema,
  InspectRequestSchema,
  zodMessage,
  type Flow,
  type Group,
  type GroupsConfig,
  type InspectRequest,
  type Step,
} from '../config/schema';
import { exportRange, renderSteps, varsFor } from '../config/template';
import { sanitizeUi } from './sanitize';
import { importPseudonymKey } from '../exports/normalise';
import { processExport, windowStartIso, type ProcessDeps, type ProcessResult } from '../exports/process';

const nextDay = (d: string): string => new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
import { analyseExport, type GroupAnalysis } from '../ai/analyse';
import { SUPPORTED_MODELS, type ModelId } from '../ai/extract';
import { runEval as runModelEval, type EvalReport } from '../ai/eval';
import { runDigest, type DigestOutcome } from '../digest/send';
import { alertsForRun, renderAlert, shouldSend, type Alert, type AlertCode } from '../ops/alerts';
import { WATCHDOG_CRON, WEEKLY_CRONS, isWeeklySlot, londonTime, nextWeeklySlot } from '../ops/schedule';
import { checkIntegrity, exportKeys, sha256Hex, type ExportRecord, type FileKind } from '../exports/store';

/** Mirrors browser/src/driver.ts RunResult (container response). */
interface RunResult {
  ok: boolean;
  failedStep: number | null;
  error_code: string | null;
  steps: Array<{ i: number; op: string; ok: boolean; skipped?: boolean; ms: number; error_code?: string }>;
  facts: Record<string, boolean>;
  inspections: Record<string, unknown[]>;
  downloads: Array<{ id: string; filename: string; bytes: number; sha256: string; kind: FileKind }>;
}

interface SessionOutcome {
  outcome: RestoreOutcome | 'error';
  errorCode: string | null;
  probe: Probe | null;
  generationBefore: number | null;
  generationAfter: number | null;
  containerStopped: boolean;
  durationMs: number;
  workError: string | null;
}

export interface InspectionResult {
  at: number;
  sessionOutcome: SessionOutcome['outcome'];
  errorCode: string | null;
  run: RunResult | null;
}

export interface ExportRun {
  runId: string;
  startedAt: string;
  completedAt: string;
  sessionOutcome: SessionOutcome['outcome'];
  errorCode: string | null;
  records: ExportRecord[];
  /** Phase 3 processing results, one per record (absent until processed). */
  processing?: ProcessResult[];
  /** Phase 4 analysis results, one per processed record. */
  analysis?: GroupAnalysis[];
}

export type ConfigResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Single Durable Object (name "controller") that owns the browser container.
 *
 * Uses the raw ctx.container API: the @cloudflare/containers helper class does
 * not support the `durable_object` scheduling policy that snapshots require.
 *
 * Long operations (pairing start/complete, restore test) are queued and run in
 * the alarm handler, so HTTP callers return immediately and poll /status.
 * Operations are never retried automatically: an alarm handler that throws is
 * retried by the runtime, so every op catches its own errors, and an op that
 * was interrupted by eviction is reported, not re-run.
 */

const PORT = 8080;
const HEALTH_TIMEOUT_MS = 90_000;
const STOP_GRACE_MS = 15_000;
const MAX_TEST_RESULTS = 20;

const K_STATE = 'state';
const K_SNAPSHOT = 'snapshot';
const K_PREVIOUS = 'previous_snapshot';
const K_TESTS = 'tests';
const K_GROUPS = 'groups';
const K_FLOW = 'flow';
const K_OP_PAYLOAD = 'op_payload';
const K_INSPECTION = 'last_inspection';
const K_EXPORT_RUNS = 'export_runs';
const K_LAST_SUCCESS = 'last_success_to';
const K_EVAL = 'ai_eval_reports';
const K_LAST_DIGEST = 'last_digest_outcome';
const K_SCHEDULE = 'schedule';
const K_SCHEDULED_FLAG = 'next_export_is_scheduled';
const K_ALERTS = 'alerts';
const K_AI_MONTH = 'ai_month_tokens';

interface ScheduleState {
  enabled: boolean;
  approvedAt: string | null;
  lastKey: string | null; // London date of the last scheduled run started
  lastTickAt: string | null;
  lastResult: string | null;
  lastWatchdogAt: string | null;
}
const DEFAULT_SCHEDULE: ScheduleState = { enabled: false, approvedAt: null, lastKey: null, lastTickAt: null, lastResult: null, lastWatchdogAt: null };

interface AlertState {
  lastSent: Record<string, number>;
  recent: Array<{ at: string; code: AlertCode; title: string; sent: boolean; error: string | null }>;
}
const MAX_EXPORT_RUNS = 20;
/** Bumped by hand when diagnosing which code version a Durable Object runs. */
const CODE_BUILD = '2026-11-24.17';

/** R2 folder stamp, e.g. 2026-11-23_153012 (UTC). */
function stampFor(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '');
}

export interface StatusView {
  phase: ControllerState['phase'];
  session: ControllerState['session'];
  pendingOp: OpName | null;
  runningOp: OpName | null;
  opStartedAt: string | null;
  pairingExpiresAt: string | null;
  lastProbe: Probe | null;
  lastError: { code: string; at: string; detail?: string } | null;
  containerRunning: boolean;
  expectedImageVersion: string;
  snapshot: {
    idPrefix: string;
    sizeBytes: number;
    createdAt: string;
    expiresAt: string;
    imageVersion: string;
    generation: number;
    origin: SnapshotRecord['origin'];
    usable: boolean;
    unusableReason: string | null;
  } | null;
  restoreTests: Array<Omit<TestResult, 'at'> & { at: string }>;
  consecutivePasses: number;
  build: string;
}

export type QueueResult = { ok: true; status: StatusView } | { ok: false; code: string; status: StatusView };

class OpError extends Error {
  constructor(
    readonly code: string,
    readonly detail?: string,
  ) {
    super(code);
  }
}

export class BrowserController extends DurableObject<Env> {
  private st: ControllerState = { ...INITIAL_STATE };
  private cfg: Config;
  /** A monitor() call is pending (keeps the DO, and so the container, alive). */
  private watching = false;
  /** We initiated the stop; an exit is expected. */
  private stopping = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.cfg = parseConfig(env as unknown as Record<string, unknown>);
    void ctx.blockConcurrencyWhile(async () => {
      this.st = { ...INITIAL_STATE, ...((await ctx.storage.get<ControllerState>(K_STATE)) ?? {}) };
      // A fresh isolate cannot be executing anything: a recorded running op was interrupted.
      if (isInterrupted(this.st, Date.now(), this.cfg.opDeadlineMs, false)) {
        this.log('warn', 'op_interrupted', { op: this.st.runningOp });
        this.st = {
          ...this.st,
          phase: 'idle',
          runningOp: null,
          opStartedAt: null,
          pairingExpiresAt: null,
          lastError: { code: 'OP_INTERRUPTED', at: Date.now(), detail: this.st.runningOp ?? undefined },
          pendingAlert: 'OP_INTERRUPTED',
        };
        await this.save();
        // Clean up any container left behind on the next alarm tick.
        await ctx.storage.setAlarm(Date.now() + 1000);
      }
    });
  }

  // ───────────────────────────── RPC surface ─────────────────────────────

  async getStatus(): Promise<StatusView> {
    return this.view();
  }

  async startPairing(): Promise<QueueResult> {
    return this.queue('start_pairing');
  }

  async completePairing(): Promise<QueueResult> {
    return this.queue('complete_pairing');
  }

  async runRestoreTest(): Promise<QueueResult> {
    return this.queue('restore_test');
  }

  async runInspect(raw: unknown): Promise<QueueResult | { ok: false; code: string; detail: string }> {
    const parsed = InspectRequestSchema.safeParse(raw ?? {});
    if (!parsed.success) return { ok: false, code: 'INVALID_REQUEST', detail: zodMessage(parsed.error) };
    const allowed = canQueue('inspect', this.st);
    if (!allowed.ok) return { ok: false, code: allowed.code, status: await this.view() };
    await this.ctx.storage.put(K_OP_PAYLOAD, parsed.data);
    return this.queue('inspect');
  }

  /** Reprocess stored exports (no WhatsApp access). Defaults to the latest run. */
  async runProcess(raw: unknown): Promise<QueueResult | { ok: false; code: string; detail: string }> {
    const body = (raw ?? {}) as { runId?: unknown; exportId?: unknown; windowFrom?: unknown };
    if (body.windowFrom !== undefined && !(typeof body.windowFrom === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.windowFrom))) {
      return { ok: false, code: 'INVALID_WINDOW_FROM', detail: 'windowFrom must be YYYY-MM-DD' };
    }
    const req = {
      runId: typeof body.runId === 'string' ? body.runId : undefined,
      exportId: typeof body.exportId === 'string' ? body.exportId : undefined,
      windowFrom: typeof body.windowFrom === 'string' ? body.windowFrom : undefined,
    };
    const allowed = canQueue('process', this.st);
    if (!allowed.ok) return { ok: false, code: allowed.code, status: await this.view() };
    await this.ctx.storage.put(K_OP_PAYLOAD, req);
    return this.queue('process');
  }

  async runAnalyse(raw: unknown): Promise<QueueResult | { ok: false; code: string; detail: string }> {
    const body = (raw ?? {}) as { runId?: unknown; exportId?: unknown; from?: unknown; to?: unknown };
    const day = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
    if ((body.from !== undefined || body.to !== undefined) && !(day(body.from) && day(body.to) && body.from <= body.to)) {
      return { ok: false, code: 'INVALID_RANGE', detail: 'from and to must both be YYYY-MM-DD, from <= to (to is inclusive)' };
    }
    const allowed = canQueue('analyse', this.st);
    if (!allowed.ok) return { ok: false, code: allowed.code, status: await this.view() };
    await this.ctx.storage.put(K_OP_PAYLOAD, {
      runId: typeof body.runId === 'string' ? body.runId : undefined,
      exportId: typeof body.exportId === 'string' ? body.exportId : undefined,
      from: day(body.from) ? body.from : undefined,
      to: day(body.to) ? body.to : undefined,
    });
    return this.queue('analyse');
  }

  async runModelEvaluation(raw: unknown): Promise<QueueResult | { ok: false; code: string; detail: string }> {
    const model = (raw as { model?: unknown } | null)?.model;
    if (model !== undefined && !(SUPPORTED_MODELS as readonly unknown[]).includes(model)) {
      return { ok: false, code: 'UNSUPPORTED_MODEL', detail: `model must be one of ${SUPPORTED_MODELS.join(', ')}` };
    }
    const allowed = canQueue('eval', this.st);
    if (!allowed.ok) return { ok: false, code: allowed.code, status: await this.view() };
    await this.ctx.storage.put(K_OP_PAYLOAD, { model });
    return this.queue('eval');
  }

  async runDigestOp(raw: unknown): Promise<QueueResult> {
    const b = (raw ?? {}) as Record<string, unknown>;
    const allowed = canQueue('digest', this.st);
    if (!allowed.ok) return { ok: false, code: allowed.code, status: await this.view() };
    await this.ctx.storage.put(K_OP_PAYLOAD, {
      force: b.force === true,
      allHistory: b.allHistory === true,
      resend: b.resend === true,
      dryRun: b.dryRun === true,
      key: typeof b.key === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.key) ? b.key : undefined,
    });
    return this.queue('digest');
  }

  async getDigests(): Promise<{ last: unknown; rows: unknown[] }> {
    const rows = await this.env.DB.prepare(
      'SELECT id, created_at, period_from, period_to, coverage_complete, events_upcoming, status, attempts, last_error, sent_at, message_id FROM digests ORDER BY id DESC LIMIT 20',
    ).all();
    return { last: (await this.ctx.storage.get(K_LAST_DIGEST)) ?? null, rows: rows.results };
  }

  /** Stored HTML rendering of a digest (for preview in the admin page). */
  async getDigestHtml(key: string): Promise<string | null> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
    const o = await this.env.EXPORTS.get(`digests/${key}/email.html`);
    return o ? o.text() : null;
  }

  // ───────────────────────────── Phase 6: schedule & operations ─────────────────────────────

  /** Called by the Worker's scheduled() handler for every cron. Never throws. */
  async scheduledTick(cron: string, scheduledTime: number): Promise<string> {
    const now = new Date(scheduledTime);
    const sch = { ...DEFAULT_SCHEDULE, ...((await this.ctx.storage.get<ScheduleState>(K_SCHEDULE)) ?? {}) };
    if (cron === WATCHDOG_CRON) {
      const r = await this.watchdog(now);
      await this.ctx.storage.put(K_SCHEDULE, { ...sch, lastWatchdogAt: now.toISOString() });
      return r;
    }
    if (!(WEEKLY_CRONS as readonly string[]).includes(cron)) return `ignored:unknown_cron`;
    if (!isWeeklySlot(now)) return 'ignored:not_09_london';
    const key = londonTime(now).date;
    const record = async (result: string): Promise<string> => {
      await this.ctx.storage.put(K_SCHEDULE, { ...sch, lastTickAt: now.toISOString(), lastResult: result, ...(result === 'started' ? { lastKey: key } : {}) });
      this.log('info', 'scheduled_weekly', { key, result });
      return result;
    };
    if (!sch.enabled) return record('skipped:disabled');
    if (sch.lastKey === key) return record('skipped:already_ran_today');
    const allowed = canQueue('export', this.st);
    if (!allowed.ok) {
      await this.sendAlert({ code: 'SCHEDULED_RUN_SKIPPED', title: 'This week\'s scheduled run could not start', detail: [`The controller was busy (${allowed.code}, phase ${this.st.phase}).`], action: 'Check /admin. Once idle, start an export manually from the admin API.' });
      return record(`skipped:${allowed.code}`);
    }
    await this.ctx.storage.put(K_SCHEDULED_FLAG, true);
    await this.queue('export');
    return record('started');
  }

  /** Daily health check and retention. Sends at most one alert per issue per day. */
  private async watchdog(now: Date): Promise<string> {
    const notes: string[] = [];
    const sch = { ...DEFAULT_SCHEDULE, ...((await this.ctx.storage.get<ScheduleState>(K_SCHEDULE)) ?? {}) };
    const snap = (await this.ctx.storage.get<SnapshotRecord>(K_SNAPSHOT)) ?? null;
    if (this.st.session === 'relink_required') {
      await this.sendAlert({ code: 'RELINK_REQUIRED', title: 'WhatsApp needs re-linking', detail: ['The last session check found the QR screen. Weekly runs cannot export until you pair again.'], action: 'Open /admin, Start pairing, scan with WhatsApp → Linked devices, Complete pairing.' });
      notes.push('relink_required');
    }
    if (snap) {
      const left = snapshotExpiresAt(snap) - now.getTime();
      if (left < 7 * 86_400_000) {
        await this.sendAlert({ code: 'SNAPSHOT_EXPIRING', title: 'The saved WhatsApp session expires soon', detail: [`Snapshot expires ${new Date(snapshotExpiresAt(snap)).toISOString().slice(0, 10)} unless a run restores it first.`], action: 'Run the restore test (or any export) from /admin to refresh it. A weekly run does this automatically.' });
        notes.push('snapshot_expiring');
      }
    }
    if (sch.enabled) {
      const last = await this.env.DB.prepare("SELECT MAX(sent_at) AS t FROM digests WHERE status = 'sent'").first<{ t: string | null }>();
      const lastMs = last?.t ? Date.parse(last.t) : 0;
      const approvedMs = sch.approvedAt ? Date.parse(sch.approvedAt) : now.getTime();
      // Missed: no digest sent within 8 days, counted from whichever is later, approval or the last send.
      if (now.getTime() - Math.max(lastMs, approvedMs) > 8 * 86_400_000) {
        await this.sendAlert({ code: 'MISSED_WEEKLY_RUN', title: 'No weekly digest has been sent for over 8 days', detail: [`Last digest sent: ${last?.t ?? 'never'}. Last scheduled tick: ${sch.lastTickAt ?? 'never'} (${sch.lastResult ?? 'n/a'}).`], action: 'Check /admin status, the cron triggers and the latest run.' });
        notes.push('missed_run');
      }
    }
    // Retention: events that ended 120+ days ago (with their evidence and history) and run rows older than 180 days.
    const cutoff = new Date(now.getTime() - 120 * 86_400_000).toISOString().slice(0, 10);
    const runCut = new Date(now.getTime() - 180 * 86_400_000).toISOString();
    const listingCut = new Date(now.getTime() - 90 * 86_400_000).toISOString();
    await this.env.DB.batch([
      this.env.DB.prepare('DELETE FROM event_sources WHERE event_id IN (SELECT id FROM events WHERE event_date IS NOT NULL AND event_date < ?)').bind(cutoff),
      this.env.DB.prepare('DELETE FROM event_revisions WHERE event_id IN (SELECT id FROM events WHERE event_date IS NOT NULL AND event_date < ?)').bind(cutoff),
      this.env.DB.prepare('DELETE FROM events WHERE event_date IS NOT NULL AND event_date < ?').bind(cutoff),
      this.env.DB.prepare('DELETE FROM listing_sources WHERE listing_id IN (SELECT id FROM listings WHERE last_seen_at < ?)').bind(listingCut),
      this.env.DB.prepare('DELETE FROM listing_revisions WHERE listing_id IN (SELECT id FROM listings WHERE last_seen_at < ?)').bind(listingCut),
      this.env.DB.prepare('DELETE FROM listings WHERE last_seen_at < ?').bind(listingCut),
      this.env.DB.prepare('DELETE FROM runs WHERE started_at < ?').bind(runCut),
      this.env.DB.prepare('DELETE FROM exports WHERE created_at < ?').bind(runCut),
    ]);
    this.log('info', 'watchdog', { notes: notes.join(',') || 'ok' });
    return `watchdog:${notes.join(',') || 'ok'}`;
  }

  /** Send (or suppress, within the cool-down) an operational alert. Never throws. */
  private async sendAlert(a: Alert): Promise<boolean> {
    const st = (await this.ctx.storage.get<AlertState>(K_ALERTS)) ?? { lastSent: {}, recent: [] };
    const now = Date.now();
    const to = this.env.ALERT_TO ?? this.env.DIGEST_TO;
    const from = this.env.DIGEST_FROM;
    let sent = false;
    let error: string | null = null;
    if (!shouldSend(a.code, st.lastSent, now)) {
      error = 'suppressed_cooldown';
    } else if (!to || !from) {
      error = 'not_configured';
    } else {
      const r = renderAlert(a, this.env.WORKER_URL ?? '');
      try {
        await this.env.EMAIL.send({ from: { email: from, name: 'Car Club Digest' }, to, subject: r.subject, text: r.text, headers: { 'X-Alert-Code': a.code } } as unknown as EmailMessageBuilder);
        sent = true;
        st.lastSent[a.code] = now;
      } catch (err) {
        const code = (err as { code?: unknown })?.code;
        error = typeof code === 'string' ? code : 'E_SEND_FAILED';
      }
    }
    st.recent = [{ at: new Date(now).toISOString(), code: a.code, title: a.title, sent, error }, ...st.recent].slice(0, 50);
    await this.ctx.storage.put(K_ALERTS, st);
    this.log(sent ? 'warn' : 'info', 'alert', { code: a.code, sent, error });
    return sent;
  }

  private async alertForRun(run: ExportRun, digest: DigestOutcome | null): Promise<void> {
    const names = new Map((await this.groups()).groups.map((g) => [g.id, g.name] as const));
    const name = (id: string): string => names.get(id) ?? id;
    const alerts = alertsForRun({
      runId: run.runId,
      sessionOutcome: run.sessionOutcome,
      sessionError: run.errorCode,
      records: run.records.map((r) => ({ groupName: name(r.groupId), status: r.status, errorCode: r.errorCode, failedStep: r.failedStep })),
      processing: (run.processing ?? []).map((p) => ({ groupName: name(p.groupId), status: p.status, errorCode: p.errorCode })),
      analysis: (run.analysis ?? []).map((a) => ({ groupName: name(a.groupId), status: a.status, reason: a.reason })),
      digest: digest ? { status: digest.status, errorCode: digest.errorCode } : { status: 'failed', errorCode: 'DIGEST_NOT_RUN' },
    });
    for (const a of alerts) await this.sendAlert(a);
  }

  /** True if this week's digest was already sent on a previous day (a manual or test send). */
  private async sentBeforeToday(): Promise<boolean> {
    const today = londonTime(new Date()).date;
    const r = await this.env.DB.prepare("SELECT sent_at FROM digests WHERE status = 'sent' ORDER BY sent_at DESC LIMIT 1").first<{ sent_at: string | null }>();
    return !!r?.sent_at && londonTime(new Date(r.sent_at)).date < today;
  }

  private async trackAiTokens(tokens: number): Promise<void> {
    const month = new Date().toISOString().slice(0, 7);
    const cur = (await this.ctx.storage.get<{ month: string; tokens: number }>(K_AI_MONTH)) ?? { month, tokens: 0 };
    const next = cur.month === month ? { month, tokens: cur.tokens + tokens } : { month, tokens };
    await this.ctx.storage.put(K_AI_MONTH, next);
    const limit = Number(this.env.AI_MONTHLY_TOKEN_ALERT ?? 2_000_000) || 2_000_000;
    if (next.tokens > limit) {
      await this.sendAlert({ code: 'AI_USAGE_HIGH', title: 'AI token usage is above the monthly threshold', detail: [`${next.tokens.toLocaleString('en-GB')} tokens used in ${month} (threshold ${limit.toLocaleString('en-GB')}).`], action: 'Check for repeated manual analysis runs. Lower AI_MAX_TOKENS_PER_RUN or switch AI_MODEL if needed.' });
    }
  }

  async getSchedule(): Promise<unknown> {
    const sch = { ...DEFAULT_SCHEDULE, ...((await this.ctx.storage.get<ScheduleState>(K_SCHEDULE)) ?? {}) };
    const ai = (await this.ctx.storage.get<{ month: string; tokens: number }>(K_AI_MONTH)) ?? null;
    return { ...sch, nextRunAt: sch.enabled ? nextWeeklySlot(new Date()).toISOString() : null, timezone: 'Europe/London', slot: 'Sunday 09:00', aiTokensThisMonth: ai };
  }

  async setSchedule(raw: unknown): Promise<unknown> {
    const enabled = (raw as { enabled?: unknown } | null)?.enabled;
    if (typeof enabled !== 'boolean') return { error: 'enabled must be true or false' };
    const sch = { ...DEFAULT_SCHEDULE, ...((await this.ctx.storage.get<ScheduleState>(K_SCHEDULE)) ?? {}) };
    await this.ctx.storage.put(K_SCHEDULE, { ...sch, enabled, approvedAt: enabled ? (sch.approvedAt ?? new Date().toISOString()) : sch.approvedAt });
    this.log('info', 'schedule_changed', { enabled });
    return this.getSchedule();
  }

  /** Decision only: what the weekly cron WOULD do at `at`. Starts nothing and changes no state. */
  async simulateSchedule(raw: unknown): Promise<unknown> {
    const at = Date.parse(String((raw as { at?: unknown } | null)?.at ?? ''));
    if (!Number.isFinite(at)) return { error: 'at must be an ISO timestamp' };
    const d = new Date(at);
    const sch = { ...DEFAULT_SCHEDULE, ...((await this.ctx.storage.get<ScheduleState>(K_SCHEDULE)) ?? {}) };
    const key = londonTime(d).date;
    const decision = !isWeeklySlot(d) ? 'ignored:not_09_london' : !sch.enabled ? 'skipped:disabled' : sch.lastKey === key ? 'skipped:already_ran_today' : !canQueue('export', this.st).ok ? 'skipped:busy' : 'would_start';
    return { at: d.toISOString(), london: londonTime(d), decision, sendsDigestEvenIfSentEarlierThisWeek: true };
  }

  async getAlerts(): Promise<AlertState> {
    return (await this.ctx.storage.get<AlertState>(K_ALERTS)) ?? { lastSent: {}, recent: [] };
  }

  async sendTestAlert(): Promise<boolean> {
    return this.sendAlert({ code: 'TEST', title: 'Test alert', detail: ['Alert delivery is working.'], action: 'No action needed.' });
  }

  async getEvalReports(): Promise<Record<string, EvalReport>> {
    return (await this.ctx.storage.get<Record<string, EvalReport>>(K_EVAL)) ?? {};
  }

  /** Upcoming and undated events with evidence counts (admin view). */
  async getEvents(): Promise<unknown[]> {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await this.env.DB.prepare(
      `SELECT e.*, (SELECT COUNT(*) FROM event_sources s WHERE s.event_id = e.id) AS sources,
              (SELECT COUNT(*) FROM event_revisions r WHERE r.event_id = e.id) AS revisions
       FROM events e WHERE e.event_date IS NULL OR e.event_date >= ? ORDER BY e.event_date IS NULL, e.event_date, e.start_time LIMIT 200`,
    )
      .bind(today)
      .all();
    return rows.results;
  }

  async runExport(): Promise<QueueResult> {
    return this.queue('export');
  }

  async getInspection(): Promise<InspectionResult | null> {
    const r = (await this.ctx.storage.get<InspectionResult>(K_INSPECTION)) ?? null;
    if (!r?.run) return r;
    // Sanitize on read too, so results stored by older code are never returned unredacted.
    const clean: InspectionResult = {
      ...r,
      run: { ...r.run, inspections: Object.fromEntries(Object.entries(r.run.inspections).map(([k, v]) => [k, sanitizeUi(v)])) },
    };
    await this.ctx.storage.put(K_INSPECTION, clean);
    return clean;
  }

  async getExportRuns(): Promise<ExportRun[]> {
    return ((await this.ctx.storage.get<ExportRun[]>(K_EXPORT_RUNS)) ?? []).slice().reverse();
  }

  async getGroups(): Promise<GroupsConfig> {
    return this.groups();
  }

  async setGroups(raw: unknown): Promise<ConfigResult<GroupsConfig>> {
    const parsed = GroupsConfigSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: zodMessage(parsed.error) };
    await this.ctx.storage.put(K_GROUPS, parsed.data);
    this.log('info', 'groups_updated', { count: parsed.data.groups.length, enabled: parsed.data.groups.filter((g) => g.enabled).length });
    return { ok: true, value: parsed.data };
  }

  async getFlow(): Promise<Flow | null> {
    return (await this.ctx.storage.get<Flow>(K_FLOW)) ?? null;
  }

  async setFlow(raw: unknown): Promise<ConfigResult<Flow>> {
    const parsed = FlowSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: zodMessage(parsed.error) };
    if (!parsed.data.export.some((s) => s.op === 'expectDownload')) return { ok: false, error: 'export: must include an expectDownload step' };
    if (!parsed.data.verifyChat.some((s) => s.op === 'exists' && s.as.startsWith('chat_'))) {
      return { ok: false, error: 'verifyChat: must include at least one exists step whose "as" starts with chat_' };
    }
    // Check placeholders render with sample values.
    try {
      const v = varsFor('Sample', exportRange(new Date(), null));
      renderSteps([...parsed.data.openChat, ...parsed.data.verifyChat, ...parsed.data.export, ...parsed.data.reset], v);
    } catch (err) {
      return { ok: false, error: errorName(err) };
    }
    await this.ctx.storage.put(K_FLOW, parsed.data);
    this.log('info', 'flow_updated', { version: parsed.data.version });
    return { ok: true, value: parsed.data };
  }

  /** Emergency stop: stop the container and return to idle. Does not touch the snapshot. */
  async abort(): Promise<StatusView> {
    await this.stopContainer();
    this.st = {
      ...this.st,
      phase: 'idle',
      pendingOp: null,
      runningOp: null,
      opStartedAt: null,
      pairingExpiresAt: null,
      controlToken: null,
      lastError: { code: 'ABORTED_BY_ADMIN', at: Date.now() },
    };
    await this.save();
    return this.view();
  }

  /** Pairing screen PNG, only while pairing. */
  async pairingScreenshot(): Promise<{ ok: true; png: ArrayBuffer } | { ok: false; code: string }> {
    if (this.st.phase !== 'pairing_awaiting_scan' && this.st.phase !== 'pairing_starting') {
      return { ok: false, code: 'NOT_PAIRING' };
    }
    if (!this.container.running) return { ok: false, code: 'CONTAINER_NOT_RUNNING' };
    try {
      const res = await this.call('/session/screenshot', { method: 'GET' }, 20_000);
      if (res.status !== 200) {
        const body = (await res.json().catch(() => ({}))) as { reason?: string };
        return { ok: false, code: `SCREENSHOT_${(body.reason ?? String(res.status)).toUpperCase()}` };
      }
      return { ok: true, png: await res.arrayBuffer() };
    } catch {
      return { ok: false, code: 'SCREENSHOT_FAILED' };
    }
  }

  // ───────────────────────────── alarm / op runner ─────────────────────────────

  override async alarm(): Promise<void> {
    if (this.st.pendingAlert) {
      const what = this.st.lastError?.detail ?? 'an operation';
      this.st = { ...this.st, pendingAlert: null };
      await this.save();
      await this.sendAlert({ code: 'OP_FAILED', title: 'A job was interrupted', detail: [`The ${what} job stopped part-way (the controller restarted). It was not retried automatically.`], action: 'Check /admin status and re-run the job manually if needed.' });
    }
    const op = this.st.pendingOp;
    if (op) {
      // Mark running *before* doing anything so a retried alarm never re-runs it.
      this.st = { ...this.st, pendingOp: null, runningOp: op, opStartedAt: Date.now() };
      await this.save();
      try {
        await this.withDeadline(op, () => this.runOp(op));
      } finally {
        this.st = { ...this.st, runningOp: null, opStartedAt: null };
        await this.save();
      }
      await this.scheduleHousekeeping();
      return;
    }

    // Housekeeping: expire abandoned pairing sessions; stop stray containers.
    const now = Date.now();
    if (this.st.phase === 'pairing_awaiting_scan' && this.st.pairingExpiresAt !== null && now >= this.st.pairingExpiresAt) {
      this.log('info', 'pairing_expired');
      await this.stopContainer();
      this.st = { ...this.st, phase: 'idle', pairingExpiresAt: null, controlToken: null, lastError: { code: 'PAIRING_EXPIRED', at: now } };
      await this.save();
      return;
    }
    if (this.st.phase === 'idle' && this.container.running) {
      this.log('warn', 'stray_container_stopped');
      await this.stopContainer();
    }
    await this.scheduleHousekeeping();
  }

  private async runOp(op: OpName): Promise<void> {
    try {
      switch (op) {
        case 'start_pairing':
          return await this.opStartPairing();
        case 'complete_pairing':
          return await this.opCompletePairing();
        case 'restore_test':
          return await this.opRestoreTest();
        case 'inspect':
          return await this.opInspect();
        case 'export':
          return await this.opExport();
        case 'process':
          return await this.opProcess();
        case 'analyse':
          return await this.opAnalyse();
        case 'eval':
          return await this.opEval();
        case 'digest':
          return await this.opDigest();
      }
    } catch (err) {
      const code = err instanceof OpError ? err.code : 'UNEXPECTED_ERROR';
      const detail = err instanceof OpError ? err.detail : errorName(err);
      this.log('error', 'op_failed', { op, error_code: code });
      this.st = { ...this.st, lastError: { code, at: Date.now(), ...(detail ? { detail } : {}) } };
      await this.save();
    }
  }

  private async withDeadline(op: OpName, fn: () => Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.cfg.opDeadlineMs);
    });
    const result = await Promise.race([fn().then(() => 'done' as const), timeout]);
    if (timer !== undefined) clearTimeout(timer);
    if (result === 'timeout') {
      this.log('error', 'op_deadline_exceeded', { op });
      await this.container.destroy().catch(() => undefined);
      this.st = {
        ...this.st,
        phase: 'idle',
        pairingExpiresAt: null,
        controlToken: null,
        lastError: { code: 'OP_DEADLINE_EXCEEDED', at: Date.now(), detail: op },
      };
      if (op === 'restore_test') await this.recordTest({ outcome: 'error', errorCode: 'OP_DEADLINE_EXCEEDED' });
      await this.save();
      await this.sendAlert({ code: 'OP_FAILED', title: `The ${op} job ran out of time`, detail: [`Stopped after ${Math.round(this.cfg.opDeadlineMs / 60000)} minutes; the container was destroyed.`], action: 'Check /admin status and the latest run. Retry the job manually if needed.' });
    }
  }

  // ───────────────────────────── operations ─────────────────────────────

  /** Fresh container from the image (no snapshot), open WhatsApp Web, wait for the QR code. */
  private async opStartPairing(): Promise<void> {
    this.st = { ...this.st, phase: 'pairing_starting', lastError: null, lastProbe: null };
    await this.save();
    if (this.container.running) await this.stopContainer();

    try {
      await this.startContainer({ fromSnapshot: null, purpose: 'pairing' });
      await this.expectJson('/session/start', { method: 'POST' }, 90_000);
      const probe = await this.expectJson<Probe>('/session/status?settle=60000', { method: 'GET' }, 75_000);
      this.st = {
        ...this.st,
        phase: 'pairing_awaiting_scan',
        lastProbe: pickProbe(probe),
        pairingExpiresAt: Date.now() + this.cfg.pairingTtlMs,
        // An unrecognised page is left up until expiry so the admin can see it in the screenshot.
        lastError: probe.state === 'qr' ? null : { code: 'PAIRING_UNEXPECTED_STATE', at: Date.now(), detail: probe.state },
      };
      await this.save();
      this.log('info', 'pairing_ready', { state: probe.state });
    } catch (err) {
      await this.stopContainer();
      this.st = { ...this.st, phase: 'idle', pairingExpiresAt: null, controlToken: null };
      await this.save();
      throw err;
    }
  }

  /** After the user scanned the QR code: confirm auth, let WhatsApp settle, close Chromium, snapshot, stop. */
  private async opCompletePairing(): Promise<void> {
    if (!this.container.running) {
      this.st = { ...this.st, phase: 'idle', pairingExpiresAt: null };
      throw new OpError('CONTAINER_NOT_RUNNING');
    }
    this.st = { ...this.st, phase: 'pairing_completing', lastError: null };
    await this.save();

    const auth = await this.expectJson<Probe>('/session/wait-auth?timeout=60000', { method: 'POST' }, 75_000);
    this.st = { ...this.st, lastProbe: pickProbe(auth) };
    if (auth.state !== 'authenticated') {
      // Back to waiting; the admin can scan and press "complete" again before expiry.
      this.st = { ...this.st, phase: 'pairing_awaiting_scan' };
      await this.save();
      throw new OpError('PAIRING_NOT_AUTHENTICATED', auth.state);
    }

    // Give WhatsApp time to finish the initial link handshake and persist keys.
    await sleep(this.cfg.postAuthSettleMs);
    const settled = await this.expectJson<Probe>('/session/status', { method: 'GET' }, 20_000);
    this.st = { ...this.st, lastProbe: pickProbe(settled) };
    if (settled.state !== 'authenticated') {
      await this.stopContainer();
      this.st = { ...this.st, phase: 'idle', pairingExpiresAt: null, controlToken: null };
      await this.save();
      throw new OpError('PAIRING_LOST_AFTER_AUTH', settled.state);
    }

    const snap = await this.closeBrowserAndSnapshot('pairing', 0);
    await this.stopContainer();
    this.st = { ...this.st, phase: 'idle', session: 'paired', pairingExpiresAt: null, controlToken: null };
    await this.save();
    this.log('info', 'pairing_complete', { snapshot_bytes: snap.sizeBytes });
  }

  /**
   * Shared lifecycle for every op that uses the logged-in session:
   * restore snapshot → start Chromium → confirm authenticated → work →
   * confirm still authenticated → close Chromium → re-snapshot → stop.
   *
   * WhatsApp's linked-device state advances during every session, so a
   * successful session ALWAYS re-snapshots, even if the work itself failed.
   * A session that is not authenticated is reported and never retried.
   */
  private async withSession(
    phase: 'restore_testing' | 'inspecting' | 'exporting',
    origin: SnapshotRecord['origin'],
    work: () => Promise<void>,
  ): Promise<SessionOutcome> {
    const t0 = Date.now();
    const snap = (await this.ctx.storage.get<SnapshotRecord>(K_SNAPSHOT)) ?? null;
    this.st = { ...this.st, phase, lastError: null, lastProbe: null };
    await this.save();

    const out: SessionOutcome = {
      outcome: 'error',
      errorCode: null,
      probe: null,
      generationBefore: snap?.generation ?? null,
      generationAfter: null,
      containerStopped: false,
      durationMs: 0,
      workError: null,
    };
    const finish = async (): Promise<SessionOutcome> => {
      out.containerStopped = await this.stopContainer();
      out.durationMs = Date.now() - t0;
      this.st = { ...this.st, phase: 'idle', controlToken: null };
      if (out.errorCode && !this.st.lastError) this.st = { ...this.st, lastError: { code: out.errorCode, at: Date.now() } };
      await this.save();
      return out;
    };

    const usable = checkSnapshotUsable(snap, this.cfg.imageVersion, Date.now());
    if (!usable.ok) {
      this.st = { ...this.st, session: usable.code === 'NO_SNAPSHOT' ? 'unpaired' : 'relink_required' };
      out.errorCode = usable.code;
      return finish();
    }

    try {
      await this.startContainer({ fromSnapshot: snap!, purpose: origin });
    } catch (err) {
      this.st = { ...this.st, session: 'unknown' };
      out.errorCode = err instanceof OpError ? err.code : 'RESTORE_START_FAILED';
      return finish();
    }
    // A successful restore refreshes the snapshot's 30-day TTL.
    await this.ctx.storage.put(K_SNAPSHOT, { ...snap!, lastTouchedAt: Date.now() } satisfies SnapshotRecord);

    try {
      await this.expectJson('/session/start', { method: 'POST' }, 90_000);
      out.probe = pickProbe(
        await this.expectJson<Probe>(`/session/status?settle=${this.cfg.restoreSettleMs}`, { method: 'GET' }, this.cfg.restoreSettleMs + 15_000),
      );
    } catch (err) {
      out.errorCode = err instanceof OpError ? err.code : 'BROWSER_START_FAILED';
      return finish();
    }
    this.st = { ...this.st, lastProbe: out.probe };

    const first = classifyRestore(out.probe);
    if (first !== 'pass') {
      out.outcome = first;
      out.errorCode = first === 'relink_required' ? 'RELINK_REQUIRED' : 'STATE_INDETERMINATE';
      this.st = { ...this.st, session: first === 'relink_required' ? 'relink_required' : 'unknown' };
      if (first === 'relink_required') this.log('error', 'session_requires_relink', { origin });
      return finish();
    }

    // Logged in. Do the work; its failure does not skip the re-snapshot.
    try {
      await work();
    } catch (err) {
      out.workError = err instanceof OpError ? err.code : 'WORK_FAILED';
      this.log('error', 'session_work_failed', { origin, error_code: out.workError });
    }

    try {
      // Re-check: a session WhatsApp is revoking can flash the chat list before dropping to the QR screen.
      const recheck = pickProbe(await this.expectJson<Probe>('/session/status?settle=15000', { method: 'GET' }, 30_000));
      this.st = { ...this.st, lastProbe: recheck };
      const again = classifyRestore(recheck);
      if (again !== 'pass') {
        out.outcome = again;
        out.probe = recheck;
        out.errorCode = again === 'relink_required' ? 'RELINK_REQUIRED' : 'STATE_INDETERMINATE';
        this.st = {
          ...this.st,
          session: again === 'relink_required' ? 'relink_required' : 'unknown',
          lastError: { code: out.errorCode, at: Date.now(), detail: 'after_work' },
        };
        return finish();
      }
      const newSnap = await this.closeBrowserAndSnapshot(origin, snap!.generation + 1);
      out.generationAfter = newSnap.generation;
      out.outcome = 'pass';
      out.errorCode = out.workError;
      this.st = { ...this.st, session: 'paired' };
    } catch (err) {
      // Login worked but the new snapshot did not: the stored snapshot is now a generation behind.
      out.errorCode = err instanceof OpError ? err.code : 'RESNAPSHOT_FAILED';
      this.st = { ...this.st, session: 'unknown', lastError: { code: out.errorCode, at: Date.now() } };
    }
    return finish();
  }

  /** Phase 1 gate: restore, confirm login persists, re-snapshot. */
  private async opRestoreTest(): Promise<void> {
    const r = await this.withSession('restore_testing', 'restore_test', async () => {
      await sleep(Math.min(this.cfg.postAuthSettleMs, 20_000));
    });
    await this.recordTest({
      outcome: r.outcome,
      errorCode: r.errorCode,
      durationMs: r.durationMs,
      probe: r.probe,
      generationBefore: r.generationBefore,
      generationAfter: r.generationAfter,
      containerStopped: r.containerStopped,
    });
    if (r.outcome === 'pass') this.log('info', 'restore_test_passed', { generation: r.generationAfter });
  }

  /**
   * Selector discovery: optionally run steps (e.g. open a chat and its menu),
   * then return a redacted list of the interactive UI. No content is captured.
   */
  private async opInspect(): Promise<void> {
    const req = (await this.ctx.storage.get<InspectRequest>(K_OP_PAYLOAD)) ?? {};
    let run: RunResult | null = null;
    let runError: string | null = null;
    const r = await this.withSession('inspecting', 'inspect', async () => {
      let steps: Step[] = [];
      if (req.steps?.length) {
        const group = req.groupId ? (await this.groups()).groups.find((g) => g.id === req.groupId) : undefined;
        if (req.groupId && !group) throw new OpError('UNKNOWN_GROUP');
        const vars = group ? varsFor(group.name, exportRange(new Date(), null)) : {};
        try {
          steps = renderSteps(req.steps, vars);
        } catch (err) {
          throw new OpError('TEMPLATE_ERROR', errorName(err));
        }
      }
      steps.push({ op: 'inspect', as: 'final' });
      const res = await this.driverRun(steps, 150_000);
      if ('refused' in res) throw new OpError('RUN_REFUSED', res.refused);
      run = { ...res, inspections: Object.fromEntries(Object.entries(res.inspections).map(([k, v]) => [k, sanitizeUi(v)])) };
      // Leave the UI neutral before closing.
      await this.driverRun([{ op: 'press', key: 'Escape', times: 3 }], 10_000).catch(() => undefined);
    }).catch((err: unknown) => {
      runError = errorName(err);
      return null;
    });
    const result: InspectionResult = {
      at: Date.now(),
      sessionOutcome: r?.outcome ?? 'error',
      errorCode: r?.errorCode ?? runError,
      run,
    };
    await this.ctx.storage.put(K_INSPECTION, result);
    await this.ctx.storage.delete(K_OP_PAYLOAD);
  }

  /** Phase 2: export each enabled group via the configured flow, store in R2. */
  private async opExport(): Promise<void> {
    const runId = `run-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
    const groups = (await this.groups()).groups.filter((g) => g.enabled);
    const flow = await this.ctx.storage.get<Flow>(K_FLOW);
    const records: ExportRecord[] = [];
    const startedAt = new Date().toISOString();

    const preflight = !flow ? 'FLOW_NOT_CONFIGURED' : groups.length === 0 ? 'NO_GROUPS_ENABLED' : null;
    if (preflight) {
      this.st = { ...this.st, lastError: { code: preflight, at: Date.now() } };
      await this.save();
      await this.saveExportRun({ runId, startedAt, completedAt: new Date().toISOString(), sessionOutcome: 'error', errorCode: preflight, records });
      return;
    }

    const r = await this.withSession('exporting', 'export', async () => {
      const lastSuccess = (await this.ctx.storage.get<Record<string, string>>(K_LAST_SUCCESS)) ?? {};
      let stop: string | null = null;
      for (const group of groups) {
        if (stop) {
          records.push(this.skipped(runId, group.id, flow!, stop));
          continue;
        }
        let rec = await this.exportGroup(runId, group, flow!, lastSuccess[group.id] ?? null);
        // One retry for a UI timing flake (e.g. a menu item not yet rendered), and only when
        // nothing was downloaded. Never for login, wrong-chat or corrupt-download outcomes.
        if (isRetryableUiFailure(rec)) {
          this.log('warn', 'group_export_retry', { group_id: group.id, error_code: rec.errorCode, failed_step: rec.failedStep });
          await sleep(3000);
          const firstStep = rec.failedStep;
          const retry = await this.exportGroup(runId, group, flow!, lastSuccess[group.id] ?? null);
          rec = retry.status === 'succeeded' ? retry : { ...retry, failedStep: `${retry.failedStep ?? '?'} (retried; first attempt failed at ${firstStep ?? '?'})` };
        }
        records.push(rec);
        if (rec.status === 'succeeded') lastSuccess[group.id] = rec.dateTo;
        if (rec.status === 'logged_out') stop = 'LOGGED_OUT';
        await this.ctx.storage.put(K_LAST_SUCCESS, lastSuccess);
      }
    });

    // Groups never reached because the session failed are recorded explicitly, never silently dropped.
    for (const g of groups) {
      if (!records.some((x) => x.groupId === g.id)) {
        records.push(this.skipped(runId, g.id, flow!, r.outcome === 'relink_required' ? 'LOGGED_OUT' : (r.errorCode ?? 'SESSION_FAILED')));
      }
    }
    const run: ExportRun = { runId, startedAt, completedAt: new Date().toISOString(), sessionOutcome: r.outcome, errorCode: r.errorCode, records };
    await this.saveExportRun(run);
    // Container is stopped; process and analyse outside container time (spec state machine).
    await this.processRun(run);
    await this.analyseRun(run);
    // Weekly digest: sent once per digest key; later runs in the same week are skipped,
    // except that the scheduled Sunday run sends the official digest even if a manual run sent one earlier in the week.
    const scheduled = (await this.ctx.storage.get<boolean>(K_SCHEDULED_FLAG)) === true;
    await this.ctx.storage.delete(K_SCHEDULED_FLAG);
    const digest = await this.digestNow(scheduled ? { force: await this.sentBeforeToday() } : {});
    await this.alertForRun(run, digest);
    this.log('info', 'export_run_complete', {
      groups: records.length,
      succeeded: records.filter((x) => x.status === 'succeeded').length,
      session: r.outcome,
    });
  }

  private async exportGroup(runId: string, group: Group, flow: Flow, lastSuccessTo: string | null): Promise<ExportRecord> {
    const startedAt = new Date().toISOString();
    const range = exportRange(new Date(), lastSuccessTo);
    const vars = varsFor(group.name, range);
    const base: ExportRecord = {
      id: `${runId}-${group.id}`,
      runId,
      groupId: group.id,
      dateFrom: vars.dateFromIso!,
      dateTo: vars.dateToIso!,
      startedAt,
      completedAt: startedAt,
      status: 'failed',
      errorCode: null,
      failedStep: null,
      r2Key: null,
      bytes: null,
      sha256: null,
      kind: null,
      flowVersion: flow.version,
    };
    const done = async (patch: Partial<ExportRecord>): Promise<ExportRecord> => {
      // Always try to return the UI to a neutral state; failures here don't matter.
      if (flow.reset.length) await this.driverRun(renderSteps(flow.reset, vars), 15_000).catch(() => undefined);
      const rec = { ...base, ...patch, completedAt: new Date().toISOString() };
      this.log(rec.status === 'succeeded' ? 'info' : 'warn', 'group_export', {
        group_id: group.id,
        status: rec.status,
        error_code: rec.errorCode,
        failed_step: rec.failedStep,
        bytes: rec.bytes,
      });
      return rec;
    };

    // 1. Open the chat and prove it is the right one.
    const openSteps = [...flow.openChat, ...flow.verifyChat];
    let open: RunResult;
    try {
      const res = await this.driverRun(renderSteps(openSteps, vars), 120_000);
      if ('refused' in res) return done({ status: res.refused.startsWith('not_authenticated') ? 'logged_out' : 'failed', errorCode: 'RUN_REFUSED' });
      open = res;
    } catch (err) {
      return done({ errorCode: err instanceof OpError ? err.code : 'DRIVER_ERROR' });
    }
    if (!open.ok) {
      const i = open.failedStep ?? 0;
      const label = i < flow.openChat.length ? `openChat#${i}` : `verifyChat#${i - flow.openChat.length}`;
      return done({ errorCode: open.error_code, failedStep: label });
    }
    const chatFacts = Object.entries(open.facts).filter(([k]) => k.startsWith('chat_'));
    if (chatFacts.length === 0 || chatFacts.some(([, v]) => !v)) {
      return done({ status: 'wrong_chat', errorCode: 'CHAT_NOT_VERIFIED', failedStep: chatFacts.find(([, v]) => !v)?.[0] ?? 'verifyChat' });
    }

    // 2. Run the native export.
    let exp: RunResult;
    try {
      const res = await this.driverRun(renderSteps(flow.export, vars), 180_000);
      if ('refused' in res) return done({ status: 'logged_out', errorCode: 'RUN_REFUSED' });
      exp = res;
    } catch (err) {
      return done({ errorCode: err instanceof OpError ? err.code : 'DRIVER_ERROR' });
    }
    const cleanup = async (): Promise<void> => {
      for (const d of exp.downloads) await this.call(`/downloads/${d.id}`, { method: 'DELETE' }, 15_000).catch(() => undefined);
    };
    if (!exp.ok) {
      await cleanup();
      const code = exp.error_code ?? 'EXPORT_FAILED';
      const corrupt = code.startsWith('DOWNLOAD_');
      return done({ status: corrupt ? 'corrupt' : 'failed', errorCode: code, failedStep: `export#${exp.failedStep ?? 0}` });
    }
    if (exp.downloads.length !== 1) {
      await cleanup();
      return done({ status: 'corrupt', errorCode: exp.downloads.length === 0 ? 'NO_DOWNLOAD' : 'MULTIPLE_DOWNLOADS' });
    }

    // 3. Pull the file out of the container, verify, store in R2.
    const d = exp.downloads[0]!;
    try {
      const res = await this.call(`/downloads/${d.id}`, { method: 'GET' }, 60_000);
      if (!res.ok) throw new OpError('DOWNLOAD_FETCH_FAILED', `HTTP ${res.status}`);
      const data = await res.arrayBuffer();
      const sha = await sha256Hex(data);
      if (data.byteLength !== d.bytes || sha !== d.sha256) {
        return done({ status: 'corrupt', errorCode: 'TRANSFER_MISMATCH', bytes: data.byteLength });
      }
      const bad = checkIntegrity(data, d.kind);
      if (bad) return done({ status: 'corrupt', errorCode: bad, bytes: d.bytes, sha256: sha, kind: d.kind });

      const keys = exportKeys(group.id, stampFor(new Date()), d.kind);
      await this.env.EXPORTS.put(keys.original, data, {
        httpMetadata: { contentType: d.kind === 'zip' ? 'application/zip' : d.kind === 'text' ? 'text/plain; charset=utf-8' : 'application/octet-stream' },
        customMetadata: { groupId: group.id, runId, sha256: sha, dateFrom: base.dateFrom, dateTo: base.dateTo },
        sha256: sha,
      });
      const rec = await done({ status: 'succeeded', r2Key: keys.original, bytes: d.bytes, sha256: sha, kind: d.kind });
      await this.env.EXPORTS.put(keys.metadata, JSON.stringify(rec, null, 2), { httpMetadata: { contentType: 'application/json' } });
      return rec;
    } catch (err) {
      return done({ status: 'failed', errorCode: err instanceof OpError ? err.code : 'STORE_FAILED' });
    } finally {
      await cleanup();
    }
  }

  private skipped(runId: string, groupId: string, flow: Flow, reason: string): ExportRecord {
    const now = new Date().toISOString();
    return {
      id: `${runId}-${groupId}`,
      runId,
      groupId,
      dateFrom: '',
      dateTo: '',
      startedAt: now,
      completedAt: now,
      status: reason === 'LOGGED_OUT' ? 'logged_out' : 'skipped',
      errorCode: reason,
      failedStep: null,
      r2Key: null,
      bytes: null,
      sha256: null,
      kind: null,
      flowVersion: flow?.version ?? 0,
    };
  }

  private async saveExportRun(run: ExportRun): Promise<void> {
    const runs = (await this.ctx.storage.get<ExportRun[]>(K_EXPORT_RUNS)) ?? [];
    const i = runs.findIndex((r) => r.runId === run.runId);
    if (i >= 0) runs[i] = run;
    else runs.push(run);
    await this.ctx.storage.put(K_EXPORT_RUNS, runs.slice(-MAX_EXPORT_RUNS));
  }

  private model(): ModelId {
    const m = this.env.AI_MODEL as ModelId | undefined;
    return m && (SUPPORTED_MODELS as readonly string[]).includes(m) ? m : '@cf/zai-org/glm-4.7-flash';
  }

  /** Phase 4: extract and reconcile events from a run's processed exports. */
  private async analyseRun(run: ExportRun, onlyExportId?: string, range?: { from: string; to: string }): Promise<void> {
    const budget = {
      chunksLeft: Math.max(1, Number(this.env.AI_MAX_CHUNKS_PER_RUN ?? 40) || 40),
      tokensLeft: Math.max(1000, Number(this.env.AI_MAX_TOKENS_PER_RUN ?? 400_000) || 400_000),
    };
    const results: GroupAnalysis[] = [...(run.analysis ?? [])];
    for (const p of run.processing ?? []) {
      if (onlyExportId && p.exportId !== onlyExportId) continue;
      let a: GroupAnalysis;
      try {
        a = await analyseExport(p, { ai: this.env.AI, db: this.env.DB, r2: this.env.EXPORTS, model: this.model(), now: new Date() }, budget, range);
      } catch (err) {
        this.log('error', 'analysis_failed', { group_id: p.groupId, error_code: errorName(err) });
        a = {
          exportId: p.exportId,
          groupId: p.groupId,
          status: 'failed',
          reason: `UNCAUGHT_${errorName(err).split(':')[0]}`,
          model: this.model(),
          messagesAnalysed: 0,
          chunks: 0,
          candidates: 0,
          accepted: 0,
          rejected: {},
          flags: {},
          created: 0,
          updated: 0,
          evidenceOnly: 0,
          tokensIn: 0,
          tokensOut: 0,
          errors: [],
        };
      }
      const i = results.findIndex((x) => x.exportId === a.exportId);
      if (i >= 0) results[i] = a;
      else results.push(a);
      this.log(a.status === 'failed' ? 'warn' : 'info', 'export_analysed', {
        group_id: a.groupId,
        status: a.status,
        reason: a.reason,
        model: a.model,
        messages: a.messagesAnalysed,
        chunks: a.chunks,
        accepted: a.accepted,
        created: a.created,
        updated: a.updated,
        tokens_in: a.tokensIn,
        tokens_out: a.tokensOut,
        errors: a.errors.length,
      });
    }
    run.analysis = results;
    await this.saveExportRun(run);
    const tokens = results.reduce((n, a) => n + a.tokensIn + a.tokensOut, 0);
    await this.trackAiTokens(tokens);
    await this.env.DB.prepare('UPDATE runs SET ai_tokens_used = ? WHERE id = ?')
      .bind(tokens, run.runId)
      .run()
      .catch((err: unknown) => this.log('error', 'runs_tokens_failed', { error_code: errorName(err) }));
  }

  private async opAnalyse(): Promise<void> {
    const req = (await this.ctx.storage.get<{ runId?: string; exportId?: string; from?: string; to?: string }>(K_OP_PAYLOAD)) ?? {};
    await this.ctx.storage.delete(K_OP_PAYLOAD);
    const runs = (await this.ctx.storage.get<ExportRun[]>(K_EXPORT_RUNS)) ?? [];
    const run = req.exportId
      ? runs.find((r) => r.records.some((x) => x.id === req.exportId))
      : req.runId
        ? runs.find((r) => r.runId === req.runId)
        : runs[runs.length - 1];
    if (!run?.processing?.length) {
      this.st = { ...this.st, lastError: { code: run ? 'RUN_NOT_PROCESSED' : 'RUN_NOT_FOUND', at: Date.now() } };
      await this.save();
      return;
    }
    this.st = { ...this.st, phase: 'analysing', lastError: null };
    await this.save();
    try {
      // Range days are Europe/London; `to` is inclusive, so the bound is midnight after it.
      const range = req.from && req.to ? { from: windowStartIso(req.from), to: windowStartIso(nextDay(req.to)) } : undefined;
      await this.analyseRun(run, req.exportId, range);
    } finally {
      this.st = { ...this.st, phase: 'idle' };
      await this.save();
    }
  }

  /** Generate, store and (unless dryRun) send the digest. Never throws. */
  private async digestNow(opts: { force?: boolean; resend?: boolean; dryRun?: boolean; key?: string; allHistory?: boolean }): Promise<DigestOutcome | null> {
    const from = this.env.DIGEST_FROM ?? '';
    const to = this.env.DIGEST_TO ?? '';
    if (!from || !to) {
      this.st = { ...this.st, lastError: { code: 'DIGEST_NOT_CONFIGURED', at: Date.now() } };
      await this.save();
      return null;
    }
    try {
      const outcome = await runDigest(
        {
          db: this.env.DB,
          r2: this.env.EXPORTS,
          email: this.env.EMAIL,
          from,
          to,
          groups: (await this.groups()).groups,
          runs: (await this.ctx.storage.get<ExportRun[]>(K_EXPORT_RUNS)) ?? [],
          now: new Date(),
        },
        opts,
      );
      await this.ctx.storage.put(K_LAST_DIGEST, { ...outcome, at: new Date().toISOString() });
      this.log(outcome.status === 'failed' ? 'error' : 'info', 'digest', {
        id: outcome.id,
        status: outcome.status,
        error_code: outcome.errorCode,
        upcoming: outcome.upcoming,
        coverage_complete: outcome.coverageComplete,
        attempts: outcome.attempts,
      });
      if (outcome.status === 'failed') this.st = { ...this.st, lastError: { code: `DIGEST_${outcome.errorCode ?? 'FAILED'}`, at: Date.now() } };
      await this.save();
      return outcome;
    } catch (err) {
      this.log('error', 'digest_crashed', { error_code: errorName(err) });
      this.st = { ...this.st, lastError: { code: 'DIGEST_CRASHED', at: Date.now(), detail: errorName(err).slice(0, 80) } };
      await this.save();
      return null;
    }
  }

  private async opDigest(): Promise<void> {
    const req = (await this.ctx.storage.get<{ force?: boolean; resend?: boolean; dryRun?: boolean; key?: string; allHistory?: boolean }>(K_OP_PAYLOAD)) ?? {};
    await this.ctx.storage.delete(K_OP_PAYLOAD);
    this.st = { ...this.st, phase: 'digesting', lastError: null };
    await this.save();
    try {
      await this.digestNow(req);
    } finally {
      this.st = { ...this.st, phase: 'idle' };
      await this.save();
    }
  }

  /** Model evaluation on fictional fixtures only. No real messages are used. */
  private async opEval(): Promise<void> {
    const req = (await this.ctx.storage.get<{ model?: string }>(K_OP_PAYLOAD)) ?? {};
    await this.ctx.storage.delete(K_OP_PAYLOAD);
    const model = (SUPPORTED_MODELS as readonly string[]).includes(req.model ?? '') ? (req.model as ModelId) : this.model();
    this.st = { ...this.st, phase: 'evaluating', lastError: null };
    await this.save();
    try {
      const report = await runModelEval(this.env.AI, model);
      const all = (await this.ctx.storage.get<Record<string, EvalReport>>(K_EVAL)) ?? {};
      all[model] = report;
      await this.ctx.storage.put(K_EVAL, all);
      this.log('info', 'eval_complete', { model, passed: report.passed, total: report.total, tokens_in: report.tokensIn, tokens_out: report.tokensOut });
    } finally {
      this.st = { ...this.st, phase: 'idle' };
      await this.save();
    }
  }

  /** Reprocess stored exports from R2. Never touches the container or WhatsApp. */
  private async opProcess(): Promise<void> {
    const req = (await this.ctx.storage.get<{ runId?: string; exportId?: string; windowFrom?: string }>(K_OP_PAYLOAD)) ?? {};
    await this.ctx.storage.delete(K_OP_PAYLOAD);
    const runs = (await this.ctx.storage.get<ExportRun[]>(K_EXPORT_RUNS)) ?? [];
    const run = req.exportId
      ? runs.find((r) => r.records.some((x) => x.id === req.exportId))
      : req.runId
        ? runs.find((r) => r.runId === req.runId)
        : runs[runs.length - 1];
    if (!run) {
      this.st = { ...this.st, lastError: { code: 'RUN_NOT_FOUND', at: Date.now() } };
      await this.save();
      return;
    }
    this.st = { ...this.st, phase: 'processing', lastError: null };
    await this.save();
    try {
      await this.processRun(run, req.exportId, req.windowFrom);
    } finally {
      this.st = { ...this.st, phase: 'idle' };
      await this.save();
    }
  }

  /**
   * Phase 3 processing for a run's records. Each record is processed
   * independently; a failure is recorded for that group and never hides the
   * others. Results are stored on the run and in D1.
   */
  private async processRun(run: ExportRun, onlyExportId?: string, windowFrom?: string): Promise<void> {
    let deps: ProcessDeps;
    try {
      deps = {
        r2: this.env.EXPORTS,
        db: this.env.DB,
        pseudonymKey: await importPseudonymKey(this.env.PSEUDONYM_KEY),
        exportTimeZone: this.env.EXPORT_TIMEZONE || 'UTC',
        dateOrderHint: this.env.EXPORT_DATE_ORDER_HINT === 'DMY' ? 'DMY' : 'MDY',
        windowFrom,
      };
    } catch (err) {
      this.log('error', 'processing_config_error', { error_code: errorName(err) });
      this.st = { ...this.st, lastError: { code: 'PROCESSING_CONFIG_ERROR', at: Date.now() } };
      await this.save();
      return;
    }

    const results: ProcessResult[] = [...(run.processing ?? [])];
    for (const rec of run.records) {
      if (onlyExportId && rec.id !== onlyExportId) continue;
      const r = await processExport(rec, deps).catch(
        (err: unknown): ProcessResult => ({
          exportId: rec.id,
          groupId: rec.groupId,
          status: 'failed',
          errorCode: `UNCAUGHT_${errorName(err).split(':')[0]}`,
          messagesTotal: 0,
          messagesInWindow: 0,
          messagesNew: 0,
          messagesDuplicate: 0,
          invalidDates: 0,
          dateOrder: null,
          dateOrderAmbiguous: false,
          firstMessageAt: null,
          lastMessageAt: null,
          messagesKey: null,
        }),
      );
      const i = results.findIndex((x) => x.exportId === r.exportId);
      if (i >= 0) results[i] = r;
      else results.push(r);
      this.log(r.status === 'failed' ? 'warn' : 'info', 'export_processed', {
        group_id: r.groupId,
        status: r.status,
        error_code: r.errorCode,
        total: r.messagesTotal,
        in_window: r.messagesInWindow,
        new: r.messagesNew,
        duplicate: r.messagesDuplicate,
        date_order: r.dateOrder,
        ambiguous: r.dateOrderAmbiguous,
      });
    }
    run.processing = results;
    await this.saveExportRun(run);

    const processed = results.reduce((n, r) => n + r.messagesNew, 0);
    await this.env.DB.prepare(
      `INSERT INTO runs (id, started_at, completed_at, status, error_code, groups_processed, messages_processed, ai_tokens_used)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT (id) DO UPDATE SET completed_at = excluded.completed_at, status = excluded.status,
         error_code = excluded.error_code, groups_processed = excluded.groups_processed, messages_processed = excluded.messages_processed`,
    )
      .bind(
        run.runId,
        run.startedAt,
        new Date().toISOString(),
        results.some((r) => r.status === 'failed') || run.records.some((r) => r.status !== 'succeeded') ? 'partial' : 'processed',
        run.errorCode,
        results.filter((r) => r.status === 'processed' || r.status === 'empty').length,
        processed,
      )
      .run()
      .catch((err: unknown) => this.log('error', 'runs_row_failed', { error_code: errorName(err) }));
  }

  private async driverRun(steps: Step[], deadlineMs: number): Promise<RunResult | { refused: string }> {
    const res = await this.call('/driver/run', { method: 'POST', body: JSON.stringify({ steps, deadlineMs }) }, deadlineMs + 15_000);
    const body = (await res.json().catch(() => null)) as (RunResult & { error?: string; reason?: string }) | null;
    if (res.status === 409 && body?.error === 'run_refused') return { refused: body.reason ?? 'refused' };
    if (!res.ok || !body) throw new OpError('DRIVER_REQUEST_FAILED', `HTTP ${res.status}${body?.error ? ` ${body.error}` : ''}`);
    return body;
  }

  private async groups(): Promise<GroupsConfig> {
    return (await this.ctx.storage.get<GroupsConfig>(K_GROUPS)) ?? { groups: [] };
  }

  // ───────────────────────────── container helpers ─────────────────────────────

  private get container(): Container {
    const c = this.ctx.container;
    if (!c) throw new OpError('NO_CONTAINER_BINDING');
    return c;
  }

  private async startContainer(opts: { fromSnapshot: SnapshotRecord | null; purpose: string }): Promise<void> {
    const token = randomToken();
    this.st = { ...this.st, controlToken: token };
    await this.save();

    const common = {
      instance: this.cfg.instance as 'standard-1',
      enableInternet: true,
      env: { CONTROL_TOKEN: token },
      labels: { purpose: opts.purpose },
    };
    try {
      if (opts.fromSnapshot) {
        this.container.start({ ...common, containerSnapshot: { id: opts.fromSnapshot.id } });
      } else {
        const image = this.container.images.browser;
        if (!image) throw new OpError('IMAGE_NOT_CONFIGURED');
        this.container.start({ ...common, image });
      }
    } catch (err) {
      if (err instanceof OpError) throw err;
      throw new OpError(opts.fromSnapshot ? 'RESTORE_START_FAILED' : 'CONTAINER_START_FAILED', errorName(err));
    }
    this.log('info', 'container_starting', { purpose: opts.purpose, from_snapshot: opts.fromSnapshot !== null });

    const health = await this.waitHealthy();
    // Without this the platform SIGTERMs an idle container after ~40 s with no
    // inbound requests (seen during re-pairing on 2026-11-23). Our own
    // deadlines and alarms decide when it stops instead.
    const keepAliveMs = opts.purpose === 'pairing' ? this.cfg.pairingTtlMs + 120_000 : this.cfg.opDeadlineMs + 60_000;
    try {
      await this.container.setInactivityTimeout(keepAliveMs);
    } catch (err) {
      this.log('warn', 'inactivity_timeout_failed', { error_code: errorName(err) });
    }
    this.watchContainer();
    // The image version reported by the running container must match what we
    // expect for this kind of start (fresh image → configured version; restore →
    // the snapshot's version).
    const expected = opts.fromSnapshot ? opts.fromSnapshot.imageVersion : this.cfg.imageVersion;
    if (health.image_version !== expected) {
      throw new OpError('IMAGE_VERSION_MISMATCH', `running=${health.image_version} expected=${expected}`);
    }
  }

  /**
   * Keep a monitor() call pending while the container runs. A pending
   * monitor() blocks Durable Object eviction (up to 15 minutes); without it the
   * DO was evicted between sparse admin-page polls and the platform stopped
   * the container mid-pairing (2026-11-23, twice).
   */
  private watchContainer(): void {
    if (this.watching) return;
    this.watching = true;
    this.stopping = false;
    void this.container
      .monitor()
      .then(
        () => 'exited',
        () => 'crashed',
      )
      .then(async (how) => {
        this.watching = false;
        if (this.stopping) return;
        this.log('error', 'container_exited_unexpectedly', { how, phase: this.st.phase });
        if (this.st.phase === 'pairing_awaiting_scan' || this.st.phase === 'pairing_starting') {
          this.st = {
            ...this.st,
            phase: 'idle',
            pairingExpiresAt: null,
            controlToken: null,
            lastError: { code: 'CONTAINER_EXITED', at: Date.now(), detail: how },
          };
          await this.save();
        }
      });
  }

  private async waitHealthy(): Promise<{ ok: boolean; image_version: string }> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.container.running) {
        await sleep(1000);
        continue;
      }
      try {
        const res = await this.container
          .getTcpPort(PORT)
          .fetch('http://container/healthz', { signal: AbortSignal.timeout(5000) });
        if (res.ok) return (await res.json()) as { ok: boolean; image_version: string };
      } catch {
        /* still booting */
      }
      await sleep(1000);
    }
    throw new OpError('CONTAINER_HEALTH_TIMEOUT');
  }

  private async closeBrowserAndSnapshot(origin: SnapshotRecord['origin'], generation: number): Promise<SnapshotRecord> {
    const closed = await this.expectJson<{ closed: boolean }>('/session/close', { method: 'POST' }, 60_000);
    if (!closed.closed) throw new OpError('BROWSER_CLOSE_FAILED');

    let handle: ContainerSnapshot;
    try {
      handle = await this.container.snapshotContainer({ name: `wa-${origin}-g${generation}` });
    } catch (err) {
      throw new OpError('SNAPSHOT_FAILED', errorName(err));
    }
    const now = Date.now();
    const rec: SnapshotRecord = {
      id: handle.id,
      sizeBytes: handle.size,
      name: handle.name ?? null,
      createdAt: now,
      lastTouchedAt: now,
      imageVersion: origin === 'pairing' ? this.cfg.imageVersion : ((await this.ctx.storage.get<SnapshotRecord>(K_SNAPSHOT))?.imageVersion ?? this.cfg.imageVersion),
      origin,
      generation,
    };
    // Keep the superseded record for diagnostics only. It is never restored
    // automatically: its WhatsApp device state is older than the live session.
    const prev = await this.ctx.storage.get<SnapshotRecord>(K_SNAPSHOT);
    await this.ctx.storage.put({ [K_SNAPSHOT]: rec, ...(prev ? { [K_PREVIOUS]: prev } : {}) });
    this.log('info', 'snapshot_created', { origin, generation, size_bytes: rec.sizeBytes });
    return rec;
  }

  /** Graceful stop: close Chromium, SIGTERM, wait, then destroy. Returns whether the container is confirmed stopped. */
  private async stopContainer(): Promise<boolean> {
    const c = this.ctx.container;
    if (!c || !c.running) return true;
    this.stopping = true;
    try {
      await this.call('/session/close', { method: 'POST' }, 30_000);
    } catch {
      /* best effort; SIGTERM handler also closes the browser */
    }
    try {
      c.signal(15);
    } catch {
      /* already exiting */
    }
    const exited = await Promise.race([
      c.monitor().then(
        () => true,
        () => true,
      ),
      sleep(STOP_GRACE_MS).then(() => false),
    ]);
    if (!exited || c.running) {
      await c.destroy().catch(() => undefined);
    }
    // Give the runtime a moment to reflect the stopped state.
    for (let i = 0; i < 10 && c.running; i++) await sleep(500);
    const stopped = !c.running;
    this.log(stopped ? 'info' : 'error', 'container_stopped', { graceful: exited, confirmed: stopped });
    return stopped;
  }

  private async call(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const token = this.st.controlToken;
    if (!token) throw new OpError('NO_CONTROL_TOKEN');
    return this.container.getTcpPort(PORT).fetch(`http://container${path}`, {
      ...init,
      headers: { 'x-control-token': token },
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  private async expectJson<T = unknown>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
    let res: Response;
    try {
      res = await this.call(path, init, timeoutMs);
    } catch (err) {
      throw new OpError('CONTAINER_REQUEST_FAILED', `${path}: ${errorName(err)}`);
    }
    const body = (await res.json().catch(() => null)) as T | null;
    if (!res.ok || body === null) throw new OpError('CONTAINER_REQUEST_FAILED', `${path}: HTTP ${res.status}`);
    return body;
  }

  // ───────────────────────────── state helpers ─────────────────────────────

  private async queue(op: OpName): Promise<QueueResult> {
    const allowed = canQueue(op, this.st);
    if (!allowed.ok) return { ok: false, code: allowed.code, status: await this.view() };
    this.st = { ...this.st, pendingOp: op };
    await this.save();
    await this.ctx.storage.setAlarm(Date.now());
    this.log('info', 'op_queued', { op });
    return { ok: true, status: await this.view() };
  }

  private async scheduleHousekeeping(): Promise<void> {
    if (this.st.phase === 'pairing_awaiting_scan' && this.st.pairingExpiresAt) {
      await this.ctx.storage.setAlarm(this.st.pairingExpiresAt);
    } else if (this.container.running) {
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
    }
  }

  private async save(): Promise<void> {
    await this.ctx.storage.put(K_STATE, this.st);
  }

  private async recordTest(partial: Partial<TestResult> & Pick<TestResult, 'outcome'>): Promise<void> {
    const tests = (await this.ctx.storage.get<TestResult[]>(K_TESTS)) ?? [];
    tests.push({
      at: Date.now(),
      errorCode: null,
      durationMs: 0,
      probe: null,
      generationBefore: null,
      generationAfter: null,
      imageVersion: this.cfg.imageVersion,
      containerStopped: !(this.ctx.container?.running ?? false),
      ...partial,
    });
    await this.ctx.storage.put(K_TESTS, tests.slice(-MAX_TEST_RESULTS));
  }

  private async view(): Promise<StatusView> {
    const snap = (await this.ctx.storage.get<SnapshotRecord>(K_SNAPSHOT)) ?? null;
    const tests = (await this.ctx.storage.get<TestResult[]>(K_TESTS)) ?? [];
    const usable = checkSnapshotUsable(snap, this.cfg.imageVersion, Date.now());
    const iso = (n: number | null): string | null => (n === null ? null : new Date(n).toISOString());
    return {
      phase: this.st.phase,
      session: this.st.session,
      pendingOp: this.st.pendingOp,
      runningOp: this.st.runningOp,
      opStartedAt: iso(this.st.opStartedAt),
      pairingExpiresAt: iso(this.st.pairingExpiresAt),
      lastProbe: this.st.lastProbe,
      lastError: this.st.lastError
        ? { code: this.st.lastError.code, at: iso(this.st.lastError.at)!, ...(this.st.lastError.detail ? { detail: this.st.lastError.detail } : {}) }
        : null,
      containerRunning: this.ctx.container?.running ?? false,
      expectedImageVersion: this.cfg.imageVersion,
      snapshot: snap
        ? {
            idPrefix: `${snap.id.slice(0, 8)}…`,
            sizeBytes: snap.sizeBytes,
            createdAt: iso(snap.createdAt)!,
            expiresAt: iso(snapshotExpiresAt(snap))!,
            imageVersion: snap.imageVersion,
            generation: snap.generation,
            origin: snap.origin,
            usable: usable.ok,
            unusableReason: usable.ok ? null : usable.code,
          }
        : null,
      restoreTests: tests
        .slice()
        .reverse()
        .slice(0, 10)
        .map((t) => ({ ...t, at: iso(t.at)! })),
      consecutivePasses: consecutivePasses(tests),
      build: CODE_BUILD,
    };
  }

  private log(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}): void {
    const line = JSON.stringify({ level, event, phase: this.st.phase, ...fields });
    if (level === 'error') console.error(line);
    else console.log(line);
  }
}

function pickProbe(p: Probe): Probe {
  // Only state + selector names leave the container; never page content.
  return { state: p.state, matched: Array.isArray(p.matched) ? p.matched.slice(0, 20) : [] };
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function errorName(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message.split('\n')[0]?.slice(0, 120) ?? ''}`;
  return 'UnknownError';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
