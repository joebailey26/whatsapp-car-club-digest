import { DurableObject } from 'cloudflare:workers';
import { londonTime } from '../ops/schedule';
import { classifyBorderline, freshBudget, type AiBudgetState, type AiRunner } from './classify';
import { DEFAULT_SETTINGS, SearchesSchema, mergeSettings, withDefaults, type Settings } from './config';
import { INSTANCE_SPECS, monthToDateOverBudget, projectMonthly, sumUsage, type Projection } from './cost';
import { canMarkMissing, planIngest, type Observation, type StoredMarketListing } from './ingest';
import type { MarketEnv } from './env';
import {
  DEFAULT_SCHEDULE,
  INITIAL_MARKET_STATE,
  SNAPSHOT_TTL_MS,
  canQueueMarket,
  circuitOpen,
  decideTick,
  runStatus,
  shouldResnapshot,
  snapshotUsable,
  type FbState,
  type MarketOp,
  type MarketSnapshot,
  type MarketState,
  type RunStatus,
  type ScheduleState,
} from './lifecycle';
import { renderOpsAlert, renderRoundupEmail, renderUrgentEmail, shouldSendAlert, type Lead, type MarketAlertCode } from './notify';
import { SOURCE_FB, dedupeCards, parseCard, parseDetail, type ParsedCard, type ParsedDetail, type RawCard } from './parse';
import * as repo from './repository';
import { scoreListing } from './score';

/**
 * MarketplaceController: the single Durable Object ("marketplace") that owns
 * the Marketplace collector's container, browser profile snapshot, schedule,
 * settings and alerts. It lives in its own Worker and shares nothing with the
 * WhatsApp BrowserController except the D1 database (separate tables).
 *
 * Same lifecycle rules as the WhatsApp controller: long ops run in the alarm
 * handler, are never retried automatically, and a session that is not plainly
 * logged in is reported and never worked around.
 */

const PORT = 8080;
const HEALTH_TIMEOUT_MS = 90_000;
const STOP_GRACE_MS = 15_000;
const CODE_BUILD = '2026-11-25.1';

const K_STATE = 'state';
const K_SNAPSHOT = 'snapshot';
const K_SETTINGS = 'settings';
const K_SCHEDULE = 'schedule';
const K_ALERTS = 'alerts';
const K_AI_BUDGET = 'ai_budget';
const K_TESTS = 'restore_tests';
const K_OP_PAYLOAD = 'op_payload';
const K_LAST_DRY_RUN = 'last_dry_run';

interface AlertLog {
  lastSent: Record<string, number>;
  recent: Array<{ at: string; code: MarketAlertCode; title: string; sent: boolean; error: string | null }>;
}

interface RestoreTest {
  at: string;
  outcome: 'pass' | 'login' | 'checkpoint' | 'indeterminate' | 'error';
  errorCode: string | null;
  generationBefore: number | null;
  generationAfter: number | null;
  durationMs: number;
  containerStopped: boolean;
}

interface CollectPayload {
  trigger: 'scheduled' | 'manual' | 'dry_run';
}

interface CollectResponse {
  aborted: string | null;
  searches: Array<{ id: string; ok: boolean; errorCode: string | null; state: FbState; cards: RawCard[]; navMs: number; collectMs: number }>;
}

class OpError extends Error {
  constructor(
    readonly code: string,
    readonly detail?: string,
  ) {
    super(code);
  }
}

export type MarketQueueResult = { ok: true; status: unknown } | { ok: false; code: string; status: unknown };

export class MarketplaceController extends DurableObject<MarketEnv> {
  private st: MarketState = { ...INITIAL_MARKET_STATE };
  private watching = false;
  private stopping = false;
  private readonly instance: string;
  private readonly imageVersion: string;

  constructor(ctx: DurableObjectState, env: MarketEnv) {
    super(ctx, env);
    this.instance = INSTANCE_SPECS[env.MARKET_CONTAINER_INSTANCE] ? env.MARKET_CONTAINER_INSTANCE : 'basic';
    this.imageVersion = (env.MARKET_IMAGE_VERSION ?? '').trim() || 'unset';
    void ctx.blockConcurrencyWhile(async () => {
      this.st = { ...INITIAL_MARKET_STATE, ...((await ctx.storage.get<MarketState>(K_STATE)) ?? {}) };
      if (this.st.runningOp) {
        // A fresh isolate cannot be running anything: the op was interrupted. Never re-run it.
        this.st = {
          ...this.st,
          phase: 'idle',
          runningOp: null,
          opStartedAt: null,
          loginExpiresAt: null,
          lastError: { code: 'OP_INTERRUPTED', at: Date.now(), detail: this.st.runningOp },
          pendingAlert: this.st.runningOp,
        };
        await this.save();
        await ctx.storage.setAlarm(Date.now() + 1000);
      }
    });
  }

  // ───────────────────────────── RPC: status & config ─────────────────────────────

  async getStatus(): Promise<unknown> {
    const snap = (await this.ctx.storage.get<MarketSnapshot>(K_SNAPSHOT)) ?? null;
    const usable = snapshotUsable(snap, this.imageVersion, Date.now());
    const iso = (n: number | null): string | null => (n === null ? null : new Date(n).toISOString());
    return {
      phase: this.st.phase,
      session: this.st.session,
      pendingOp: this.st.pendingOp,
      runningOp: this.st.runningOp,
      opStartedAt: iso(this.st.opStartedAt),
      loginExpiresAt: iso(this.st.loginExpiresAt),
      lastProbe: this.st.lastProbe,
      lastError: this.st.lastError ? { ...this.st.lastError, at: iso(this.st.lastError.at) } : null,
      consecutiveFailures: this.st.consecutiveFailures,
      containerRunning: this.ctx.container?.running ?? false,
      instance: this.instance,
      expectedImageVersion: this.imageVersion,
      snapshot: snap
        ? {
            idPrefix: `${snap.id.slice(0, 8)}…`,
            sizeBytes: snap.sizeBytes,
            createdAt: iso(snap.createdAt),
            expiresAt: iso(snap.lastTouchedAt + SNAPSHOT_TTL_MS),
            generation: snap.generation,
            origin: snap.origin,
            imageVersion: snap.imageVersion,
            usable: usable.ok,
            unusableReason: usable.ok ? null : usable.code,
          }
        : null,
      restoreTests: ((await this.ctx.storage.get<RestoreTest[]>(K_TESTS)) ?? []).slice(-10).reverse(),
      schedule: await this.schedule(),
      build: CODE_BUILD,
    };
  }

  async getSettings(): Promise<Settings> {
    return this.settings();
  }

  async setSettings(raw: unknown): Promise<{ ok: true; value: Settings } | { ok: false; error: string }> {
    const r = mergeSettings(await this.settings(), raw);
    if (r.ok) {
      await this.ctx.storage.put(K_SETTINGS, r.value);
      this.log('info', 'settings_updated', { ruleset: r.value.scoring.version });
    }
    return r;
  }

  async getSearches(): Promise<unknown> {
    return { searches: await repo.loadSearches(this.env.DB) };
  }

  async setSearches(raw: unknown): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
    const parsed = SearchesSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
    await repo.saveSearches(this.env.DB, parsed.data.searches, SOURCE_FB, new Date().toISOString());
    return { ok: true, value: await this.getSearches() };
  }

  async getSchedule(): Promise<unknown> {
    const sch = await this.schedule();
    return { ...sch, usage: await this.usage() };
  }

  /**
   * Switch the hourly collection on or off. Turning it on needs an explicit
   * acknowledgement of the Facebook terms/account risk, a signed-in session,
   * at least one search, enough measured runs and a projection within budget.
   * `force` skips only the measurement checks, never the acknowledgement.
   */
  async setSchedule(raw: unknown): Promise<unknown> {
    const b = (raw ?? {}) as { enabled?: unknown; acknowledgeRisk?: unknown; intervalHours?: unknown; force?: unknown };
    const sch = await this.schedule();
    if (b.intervalHours !== undefined) {
      const n = Number(b.intervalHours);
      if (![1, 2, 3, 4, 6, 8, 12, 24].includes(n)) return { error: 'intervalHours must be one of 1, 2, 3, 4, 6, 8, 12, 24' };
      sch.intervalHours = n;
    }
    if (b.enabled === false) {
      sch.collectionEnabled = false;
      sch.pausedReason = 'paused_by_admin';
    } else if (b.enabled === true) {
      if (b.acknowledgeRisk !== true) {
        return { error: 'RISK_NOT_ACKNOWLEDGED', detail: 'Send "acknowledgeRisk": true to confirm you accept that automated Facebook access may breach Meta\'s terms and risk the account.' };
      }
      if (this.st.session !== 'signed_in') return { error: 'NOT_SIGNED_IN', detail: `session is ${this.st.session}` };
      const searches = (await repo.loadSearches(this.env.DB)).filter((s) => s.enabled);
      if (!searches.length) return { error: 'NO_SEARCHES' };
      const proj = await this.projection(sch.intervalHours);
      if (b.force !== true && proj.verdict === 'insufficient_data') {
        return { error: 'NOT_MEASURED', detail: `Need ${(await this.settings()).cost.minMeasuredRuns} measured runs (have ${proj.measuredRuns}). Run POST /admin/api/collect {"dryRun":true} first.`, projection: proj };
      }
      if (b.force !== true && proj.verdict === 'over_budget') {
        return { error: 'OVER_BUDGET', detail: 'The measured runs project past the included allowance. Use a smaller instance, fewer searches/scrolls, or a longer interval.', projection: proj };
      }
      sch.collectionEnabled = true;
      sch.pausedReason = null;
      sch.riskAcknowledgedAt = sch.riskAcknowledgedAt ?? new Date().toISOString();
      sch.approvedAt = new Date().toISOString();
    } else if (b.intervalHours === undefined) {
      return { error: 'enabled must be true or false' };
    }
    await this.ctx.storage.put(K_SCHEDULE, sch);
    this.log('info', 'schedule_changed', { enabled: sch.collectionEnabled, interval: sch.intervalHours });
    return this.getSchedule();
  }

  async getAlerts(): Promise<AlertLog> {
    return (await this.ctx.storage.get<AlertLog>(K_ALERTS)) ?? { lastSent: {}, recent: [] };
  }

  async sendTestAlert(): Promise<boolean> {
    return this.alert({ code: 'TEST', title: 'Test alert', detail: ['Marketplace alert delivery is working.'], action: 'No action needed.' });
  }

  async getRuns(): Promise<unknown> {
    return { runs: await repo.recentRuns(this.env.DB, 50), lastDryRun: (await this.ctx.storage.get(K_LAST_DRY_RUN)) ?? null };
  }

  async getUsage(): Promise<unknown> {
    return this.usage();
  }

  async getListings(view: repo.ListingView, limit: number): Promise<unknown> {
    return { view, listings: await repo.listListings(this.env.DB, view, Math.min(Math.max(limit, 1), 200)) };
  }

  async getListing(id: string): Promise<unknown> {
    return repo.listingDetail(this.env.DB, id);
  }

  /** Feedback and manual overrides. `send_alert` sends an urgent email now (deduped per listing). */
  async feedback(id: string, raw: unknown, actor: string | null): Promise<{ ok: true; listing: unknown; emailed?: boolean } | { ok: false; code: string }> {
    const b = (raw ?? {}) as { action?: unknown; reason?: unknown };
    const action = b.action;
    if (action !== 'interested' && action !== 'pass' && action !== 'ignore' && action !== 'send_alert') return { ok: false, code: 'INVALID_ACTION' };
    const l = await repo.getListing(this.env.DB, id);
    if (!l) return { ok: false, code: 'NOT_FOUND' };
    const now = new Date().toISOString();
    await repo.recordFeedback(this.env.DB, l, action, typeof b.reason === 'string' ? b.reason : null, actor, now);
    let emailed: boolean | undefined;
    if (action === 'send_alert') {
      await repo.insertNotification(this.env.DB, l.id, 'urgent_manual', 'manual', null, now);
      emailed = (await this.sendUrgent([{ listing: l, class: 'urgent_manual', previousPricePence: null }], [{ listingId: l.id, class: 'urgent_manual', dedupeKey: 'manual' }])).sent;
    }
    return { ok: true, listing: await repo.getListing(this.env.DB, id), ...(emailed !== undefined ? { emailed } : {}) };
  }

  /** Re-score stored listings with proposed settings and report what would change. Changes nothing. */
  async replay(raw: unknown): Promise<unknown> {
    const current = await this.settings();
    const proposed = mergeSettings(current, (raw as { settings?: unknown } | null)?.settings ?? {});
    if (!proposed.ok) return { error: 'INVALID_SETTINGS', detail: proposed.error };
    const limit = Math.min(Math.max(Number((raw as { limit?: unknown } | null)?.limit ?? 500) || 500, 1), 2000);
    const listings = await repo.listingsForReplay(this.env.DB, limit);
    const changes: unknown[] = [];
    const tally = { urgent: 0, review: 0, low: 0 };
    const was = { urgent: 0, review: 0, low: 0 };
    for (const l of listings) {
      const s = scoreListing(
        { title: l.title, description: l.description, pricePence: l.pricePence, distanceMiles: l.distanceMiles, distanceBasis: l.distanceBasis, year: l.year, priceDropPence: null, previousPricePence: null },
        proposed.value.scoring,
      );
      tally[s.route]++;
      if (l.route) was[l.route]++;
      if (s.route !== l.route) changes.push({ id: l.id, title: l.title, pricePence: l.pricePence, from: l.route, to: s.route, score: s.score, reasons: s.reasons, feedback: l.reviewState });
    }
    // Feedback is the ground truth for tuning: how would liked/passed listings route?
    const interestedMissed = listings.filter((l) => l.reviewState === 'interested').filter((l) => {
      const s = scoreListing({ title: l.title, description: l.description, pricePence: l.pricePence, distanceMiles: l.distanceMiles, distanceBasis: l.distanceBasis, year: l.year, priceDropPence: null, previousPricePence: null }, proposed.value.scoring);
      return s.route !== 'urgent';
    }).length;
    return { rulesetFrom: current.scoring.version, rulesetTo: proposed.value.scoring.version, listings: listings.length, routesBefore: was, routesAfter: tally, interestedNotUrgent: interestedMissed, changes: changes.slice(0, 200) };
  }

  // ───────────────────────────── RPC: operations ─────────────────────────────

  async startLogin(): Promise<MarketQueueResult> {
    return this.queue('start_login');
  }

  async completeLogin(): Promise<MarketQueueResult> {
    return this.queue('complete_login');
  }

  async runRestoreTest(): Promise<MarketQueueResult> {
    return this.queue('restore_test');
  }

  async runCollect(raw: unknown): Promise<MarketQueueResult> {
    const dryRun = (raw as { dryRun?: unknown } | null)?.dryRun === true;
    const allowed = canQueueMarket('collect', this.st);
    if (!allowed.ok) return { ok: false, code: allowed.code, status: await this.getStatus() };
    await this.ctx.storage.put(K_OP_PAYLOAD, { trigger: dryRun ? 'dry_run' : 'manual' } satisfies CollectPayload);
    return this.queue('collect');
  }

  async abort(): Promise<unknown> {
    await this.stopContainer();
    this.st = { ...this.st, phase: 'idle', pendingOp: null, runningOp: null, opStartedAt: null, loginExpiresAt: null, controlToken: null, lastError: { code: 'ABORTED_BY_ADMIN', at: Date.now() } };
    await this.save();
    return this.getStatus();
  }

  /** Screenshot for the remote login console; only while logging in, refused by the container once authenticated. */
  async loginScreenshot(): Promise<{ ok: true; jpeg: ArrayBuffer } | { ok: false; code: string }> {
    if (this.st.phase !== 'login_awaiting') return { ok: false, code: 'NOT_LOGGING_IN' };
    if (!this.container.running) return { ok: false, code: 'CONTAINER_NOT_RUNNING' };
    try {
      const res = await this.call('/session/screenshot', { method: 'GET' }, 20_000);
      if (res.status !== 200) {
        const body = (await res.json().catch(() => ({}))) as { reason?: string };
        return { ok: false, code: `SCREENSHOT_${(body.reason ?? String(res.status)).toUpperCase()}` };
      }
      return { ok: true, jpeg: await res.arrayBuffer() };
    } catch {
      return { ok: false, code: 'SCREENSHOT_FAILED' };
    }
  }

  /** Forward one remote input event during login. The content is never logged or stored. */
  async loginInput(raw: unknown): Promise<{ ok: boolean; code?: string }> {
    if (this.st.phase !== 'login_awaiting') return { ok: false, code: 'NOT_LOGGING_IN' };
    if (!this.container.running) return { ok: false, code: 'CONTAINER_NOT_RUNNING' };
    try {
      const res = await this.call('/session/input', { method: 'POST', body: JSON.stringify(raw ?? {}) }, 30_000);
      if (res.ok) return { ok: true };
      const body = (await res.json().catch(() => ({}))) as { reason?: string };
      return { ok: false, code: `INPUT_${(body.reason ?? String(res.status)).toUpperCase()}` };
    } catch {
      return { ok: false, code: 'INPUT_FAILED' };
    }
  }

  /** Daily roundup on demand (`dryRun` returns what would be sent). */
  async runRoundup(raw: unknown): Promise<unknown> {
    const b = (raw ?? {}) as { dryRun?: unknown };
    return this.roundup(new Date(), b.dryRun === true);
  }

  // ───────────────────────────── cron ─────────────────────────────

  /** Called by the hourly cron. Never throws. */
  async scheduledTick(scheduledTime: number): Promise<string> {
    const now = new Date(scheduledTime);
    const sch = await this.schedule();
    const settings = await this.settings();
    const d = decideTick(now, sch, this.st, settings.roundup);
    const notes: string[] = [`collect:${d.collect}`];
    sch.lastTickAt = now.toISOString();

    if (d.collect === 'start') {
      // Cost guard before every scheduled run: stop if this month is already past the budget.
      const monthStart = `${now.toISOString().slice(0, 7)}-01T00:00:00.000Z`;
      const mtd = sumUsage(await repo.measuredRuns(this.env.DB, { since: monthStart, limit: 2000 }), settings.cost);
      if (monthToDateOverBudget(mtd, settings.cost) && settings.cost.autoDisable) {
        sch.collectionEnabled = false;
        sch.pausedReason = 'cost_guard_month_to_date';
        notes.push('cost_guard');
        await this.alert({ code: 'COST_GUARD', title: 'Hourly Marketplace collection paused: monthly container allowance nearly used', detail: [`Month-to-date usage (with the WhatsApp reservation) is past ${Math.round(settings.cost.safetyFraction * 100)}% of the included allowance.`], action: 'Check GET /admin/api/usage. Resume next month or after reducing per-run cost.' });
      } else {
        sch.lastSlot = d.slot;
        await this.ctx.storage.put(K_OP_PAYLOAD, { trigger: 'scheduled' } satisfies CollectPayload);
        const q = await this.queue('collect');
        if (!q.ok) notes.push(`queue:${q.code}`);
      }
    }
    sch.lastResult = notes.join(',');
    await this.ctx.storage.put(K_SCHEDULE, sch);

    if (d.roundup) {
      const r = await this.roundup(now, false).catch((err: unknown) => ({ error: errorName(err) }));
      notes.push(`roundup:${JSON.stringify(r).slice(0, 80)}`);
      const s2 = await this.schedule();
      await this.ctx.storage.put(K_SCHEDULE, { ...s2, lastRoundupDate: londonTime(now).date });
    }
    if (d.watchdog) {
      notes.push(`watchdog:${await this.watchdog(now).catch((err: unknown) => errorName(err))}`);
      const s3 = await this.schedule();
      await this.ctx.storage.put(K_SCHEDULE, { ...s3, lastWatchdogDate: londonTime(now).date });
    }
    this.log('info', 'tick', { notes: notes.join(' ') });
    return notes.join(' ');
  }

  private async watchdog(now: Date): Promise<string> {
    const settings = await this.settings();
    const notes: string[] = [];
    const snap = (await this.ctx.storage.get<MarketSnapshot>(K_SNAPSHOT)) ?? null;
    if (snap && snap.lastTouchedAt + SNAPSHOT_TTL_MS - now.getTime() < 7 * 86_400_000) {
      await this.alert({ code: 'SNAPSHOT_EXPIRING', title: 'The saved Facebook browser profile expires soon', detail: [`Snapshot expires ${new Date(snap.lastTouchedAt + SNAPSHOT_TTL_MS).toISOString().slice(0, 10)} unless restored first.`], action: 'Run the restore test from /admin (any collection also refreshes it).' });
      notes.push('snapshot_expiring');
    }
    const cutoff = new Date(now.getTime() - settings.limits.retentionDays * 86_400_000).toISOString();
    const runCut = new Date(now.getTime() - 180 * 86_400_000).toISOString();
    await repo.applyRetention(this.env.DB, cutoff, runCut);
    notes.push('retention');
    return notes.join(',') || 'ok';
  }

  // ───────────────────────────── alarm / op runner ─────────────────────────────

  override async alarm(): Promise<void> {
    if (this.st.pendingAlert) {
      const what = this.st.pendingAlert;
      this.st = { ...this.st, pendingAlert: null };
      await this.save();
      await this.alert({ code: 'OP_FAILED', title: 'A Marketplace job was interrupted', detail: [`The ${what} job stopped part-way (the controller restarted). It was not retried.`], action: 'Check /admin status; run it again manually if needed.' });
    }
    const op = this.st.pendingOp;
    if (op) {
      this.st = { ...this.st, pendingOp: null, runningOp: op, opStartedAt: Date.now() };
      await this.save();
      try {
        await this.withDeadline(op, () => this.runOp(op));
      } finally {
        this.st = { ...this.st, runningOp: null, opStartedAt: null };
        await this.save();
      }
      await this.housekeepingAlarm();
      return;
    }
    if (this.st.phase === 'login_awaiting' && this.st.loginExpiresAt !== null && Date.now() >= this.st.loginExpiresAt) {
      await this.stopContainer();
      this.st = { ...this.st, phase: 'idle', loginExpiresAt: null, controlToken: null, lastError: { code: 'LOGIN_EXPIRED', at: Date.now() } };
      await this.save();
      return;
    }
    if (this.st.phase === 'idle' && this.container.running) {
      this.log('warn', 'stray_container_stopped');
      await this.stopContainer();
    }
    await this.housekeepingAlarm();
  }

  private async runOp(op: MarketOp): Promise<void> {
    try {
      switch (op) {
        case 'start_login':
          return await this.opStartLogin();
        case 'complete_login':
          return await this.opCompleteLogin();
        case 'restore_test':
          return await this.opRestoreTest();
        case 'collect':
          return await this.opCollect();
      }
    } catch (err) {
      const code = err instanceof OpError ? err.code : 'UNEXPECTED_ERROR';
      const detail = err instanceof OpError ? err.detail : errorName(err);
      this.log('error', 'op_failed', { op, error_code: code });
      this.st = { ...this.st, lastError: { code, at: Date.now(), ...(detail ? { detail } : {}) } };
      await this.save();
    }
  }

  private async opDeadlineMs(): Promise<number> {
    // Collection deadline + container boot + snapshot; well under the 15-minute alarm limit.
    return Math.min((await this.settings()).limits.runDeadlineMs + 4 * 60_000, 13 * 60_000);
  }

  private async withDeadline(op: MarketOp, fn: () => Promise<void>): Promise<void> {
    const ms = op === 'start_login' || op === 'complete_login' ? 5 * 60_000 : await this.opDeadlineMs();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ms);
    });
    const result = await Promise.race([fn().then(() => 'done' as const), timeout]);
    if (timer !== undefined) clearTimeout(timer);
    if (result === 'timeout') {
      await this.container.destroy().catch(() => undefined);
      this.st = { ...this.st, phase: 'idle', loginExpiresAt: null, controlToken: null, lastError: { code: 'OP_DEADLINE_EXCEEDED', at: Date.now(), detail: op }, consecutiveFailures: this.st.consecutiveFailures + (op === 'collect' ? 1 : 0) };
      await this.save();
      await this.alert({ code: 'OP_FAILED', title: `The Marketplace ${op} job ran out of time`, detail: [`Stopped after ${Math.round(ms / 60000)} minutes; the container was destroyed.`], action: 'Check /admin status and the latest run.' });
    }
  }

  // ───────────────────────────── login ─────────────────────────────

  /** Fresh container from the image (new, empty profile) on Facebook's login page. The owner signs in through the remote console. */
  private async opStartLogin(): Promise<void> {
    this.st = { ...this.st, phase: 'login_starting', lastError: null, lastProbe: null };
    await this.save();
    if (this.container.running) await this.stopContainer();
    try {
      await this.startContainer(null, 'login');
      await this.expectJson('/session/start', { method: 'POST', body: JSON.stringify({ to: 'login' }) }, 90_000);
      const probe = await this.expectJson<{ state: FbState; signals: unknown }>('/session/status?settle=20000', { method: 'GET' }, 35_000);
      const ttl = Math.min(Math.max(Number(this.env.LOGIN_TTL_MS ?? 900_000) || 900_000, 120_000), 30 * 60_000);
      this.st = { ...this.st, phase: 'login_awaiting', lastProbe: probe, loginExpiresAt: Date.now() + ttl };
      await this.save();
    } catch (err) {
      await this.stopContainer();
      this.st = { ...this.st, phase: 'idle', loginExpiresAt: null, controlToken: null };
      await this.save();
      throw err;
    }
  }

  /** After the owner signed in: confirm, let Facebook settle, close Chromium, snapshot, stop. */
  private async opCompleteLogin(): Promise<void> {
    if (!this.container.running) {
      this.st = { ...this.st, phase: 'idle', loginExpiresAt: null };
      throw new OpError('CONTAINER_NOT_RUNNING');
    }
    this.st = { ...this.st, phase: 'login_completing', lastError: null };
    await this.save();
    // Load Marketplace itself so its storage is part of the profile, then confirm.
    await this.expectJson('/session/input', { method: 'POST', body: JSON.stringify({ type: 'navigate', to: 'marketplace' }) }, 45_000).catch(() => undefined);
    const probe = await this.expectJson<{ state: FbState; signals: unknown }>('/session/status?settle=30000', { method: 'GET' }, 45_000);
    this.st = { ...this.st, lastProbe: probe };
    if (probe.state !== 'authenticated') {
      this.st = { ...this.st, phase: 'login_awaiting' };
      await this.save();
      throw new OpError('LOGIN_NOT_AUTHENTICATED', probe.state);
    }
    await sleep(15_000);
    const snap = await this.closeAndSnapshot('login', 0, this.imageVersion);
    await this.stopContainer();
    this.st = { ...this.st, phase: 'idle', session: 'signed_in', loginExpiresAt: null, controlToken: null, consecutiveFailures: 0 };
    await this.save();
    this.log('info', 'login_complete', { snapshot_bytes: snap.sizeBytes });
  }

  /** Gate test: restore from snapshot, confirm still signed in without logging in again, re-snapshot. */
  private async opRestoreTest(): Promise<void> {
    const t0 = Date.now();
    const snap = (await this.ctx.storage.get<MarketSnapshot>(K_SNAPSHOT)) ?? null;
    const test: RestoreTest = { at: new Date().toISOString(), outcome: 'error', errorCode: null, generationBefore: snap?.generation ?? null, generationAfter: null, durationMs: 0, containerStopped: false };
    this.st = { ...this.st, phase: 'restore_testing', lastError: null };
    await this.save();
    try {
      const probe = await this.restoreAndProbe(snap);
      test.outcome = probe.state === 'authenticated' ? 'pass' : probe.state === 'login' ? 'login' : probe.state === 'checkpoint' ? 'checkpoint' : 'indeterminate';
      if (test.outcome === 'pass') {
        await sleep(10_000);
        const again = await this.expectJson<{ state: FbState; signals: unknown }>('/session/status?settle=10000', { method: 'GET' }, 25_000);
        if (again.state === 'authenticated') {
          const next = await this.closeAndSnapshot('restore_test', snap!.generation + 1, snap!.imageVersion);
          test.generationAfter = next.generation;
          this.st = { ...this.st, session: 'signed_in' };
        } else {
          test.outcome = again.state === 'login' ? 'login' : again.state === 'checkpoint' ? 'checkpoint' : 'indeterminate';
        }
      }
      if (test.outcome === 'login' || test.outcome === 'checkpoint') await this.sessionLost(test.outcome);
    } catch (err) {
      test.errorCode = err instanceof OpError ? err.code : 'RESTORE_FAILED';
    } finally {
      test.containerStopped = await this.stopContainer();
      test.durationMs = Date.now() - t0;
      this.st = { ...this.st, phase: 'idle', controlToken: null, ...(test.errorCode ? { lastError: { code: test.errorCode, at: Date.now() } } : {}) };
      await this.save();
      const tests = (await this.ctx.storage.get<RestoreTest[]>(K_TESTS)) ?? [];
      await this.ctx.storage.put(K_TESTS, [...tests, test].slice(-20));
    }
  }

  /** Start from the snapshot and probe. Throws OpError on an unusable snapshot or a failed start. */
  private async restoreAndProbe(snap: MarketSnapshot | null): Promise<{ state: FbState; signals: unknown }> {
    const usable = snapshotUsable(snap, this.imageVersion, Date.now());
    if (!usable.ok) {
      this.st = { ...this.st, session: usable.code === 'NO_SNAPSHOT' ? 'unpaired' : 'relogin_required' };
      throw new OpError(usable.code);
    }
    await this.startContainer(snap!, 'restore');
    await this.ctx.storage.put(K_SNAPSHOT, { ...snap!, lastTouchedAt: Date.now() } satisfies MarketSnapshot);
    await this.expectJson('/session/start', { method: 'POST' }, 90_000);
    const probe = await this.expectJson<{ state: FbState; signals: unknown }>('/session/status?settle=30000', { method: 'GET' }, 45_000);
    this.st = { ...this.st, lastProbe: probe };
    return probe;
  }

  /** Logged out or challenged: stop using the account, pause the schedule and tell the owner. Never retried. */
  private async sessionLost(state: 'login' | 'checkpoint'): Promise<void> {
    this.st = { ...this.st, session: state === 'login' ? 'relogin_required' : 'checkpoint' };
    const sch = await this.schedule();
    if (sch.collectionEnabled) await this.ctx.storage.put(K_SCHEDULE, { ...sch, collectionEnabled: false, pausedReason: `session_${state}` });
    await this.alert(
      state === 'login'
        ? { code: 'FB_LOGIN_REQUIRED', title: 'Facebook session logged out: Marketplace collection paused', detail: ['The restored browser profile showed the Facebook login page.'], action: 'On /admin, Start login, sign in through the console, Complete login, run the restore test twice, then resume the schedule.' }
        : { code: 'FB_CHECKPOINT', title: 'Facebook showed a security check or account warning: collection paused', detail: ['The collector stopped immediately and did not try to get past it.'], action: 'Sign in to Facebook yourself on your own device and resolve it. Only then re-login on /admin and decide whether to resume.' },
    );
  }

  // ───────────────────────────── collection ─────────────────────────────

  private async opCollect(): Promise<void> {
    const payload = (await this.ctx.storage.get<CollectPayload>(K_OP_PAYLOAD)) ?? { trigger: 'manual' };
    await this.ctx.storage.delete(K_OP_PAYLOAD);
    const dryRun = payload.trigger === 'dry_run';
    const settings = await this.settings();
    const L = settings.limits;
    const runId = `mrun-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
    const startedAt = new Date().toISOString();
    const timings: Record<string, number | null> = {};
    const run: repo.RunRow = {
      id: runId, trigger: payload.trigger, startedAt, completedAt: null, status: 'failed', errorCode: null, searchesOk: 0, searchesFailed: 0,
      itemsSeen: 0, newCount: 0, priceDrops: 0, urgentCount: 0, reviewCount: 0, alertEmailSentAt: null, firstSeenToEmailMs: null,
      instance: this.instance, billableMs: null, timings,
    };

    const searches = (await repo.loadSearches(this.env.DB)).filter((s) => s.enabled).slice(0, L.maxSearchesPerRun);
    const snap = (await this.ctx.storage.get<MarketSnapshot>(K_SNAPSHOT)) ?? null;
    if (!searches.length) return this.finishRun(run, 'skipped', 'NO_SEARCHES');
    // Check the snapshot before starting anything, so a run that never started a container is never "measured".
    const usable = snapshotUsable(snap, this.imageVersion, Date.now());
    if (!usable.ok) {
      this.st = { ...this.st, session: usable.code === 'NO_SNAPSHOT' ? 'unpaired' : 'relogin_required' };
      return this.finishRun(run, 'skipped', usable.code);
    }

    this.st = { ...this.st, phase: 'collecting', lastError: null };
    await this.save();

    let containerStartedAt: number | null = null;
    let aborted: string | null = null;
    let sessionError: string | null = null;
    let observations: Observation[] = [];
    let plan: ReturnType<typeof planIngest> | null = null;
    let existing = new Map<string, StoredMarketListing>();
    const searchOutcomes: Array<{ id: string; ok: boolean; error: string | null }> = [];
    const t0 = Date.now();

    try {
      containerStartedAt = Date.now();
      const probe = await this.restoreAndProbe(snap);
      timings.startupMs = Date.now() - t0;
      if (probe.state !== 'authenticated') {
        aborted = probe.state === 'login' || probe.state === 'checkpoint' ? probe.state : null;
        if (!aborted) sessionError = `STATE_${probe.state.toUpperCase()}`;
      } else {
        // 1. Collect result cards.
        const tc = Date.now();
        const res = await this.expectJson<CollectResponse>(
          '/collect',
          { method: 'POST', body: JSON.stringify({ searches: searches.map((s) => ({ id: s.id, url: s.url, maxScrolls: s.maxScrolls })), maxItems: L.maxItemsPerSearch, pageDelayMs: L.pageDelayMs, deadlineMs: L.runDeadlineMs, blockImages: true }) },
          L.runDeadlineMs + 30_000,
        );
        timings.navigationMs = res.searches.reduce((a, s) => a + s.navMs, 0);
        timings.collectMs = Date.now() - tc;
        aborted = res.aborted === 'login' || res.aborted === 'checkpoint' ? res.aborted : null;
        for (const s of res.searches) {
          searchOutcomes.push({ id: s.id, ok: s.ok, error: s.errorCode });
          if (!s.ok) continue;
          for (const c of dedupeCards(s.cards.map(parseCard).filter((x): x is ParsedCard => x !== null))) observations.push({ card: c, detail: null, searchId: s.id });
        }
        run.searchesOk = res.searches.filter((s) => s.ok).length;
        run.searchesFailed = searches.length - run.searchesOk;

        // 2. Plan, store and alert immediately (no detail pages, no AI on this path).
        existing = await repo.loadListings(this.env.DB, observations.map((o) => `${o.card.source}:${o.card.sourceId}`));
        const baselineSearches = new Set(searches.filter((s) => !s.baselineDoneAt).map((s) => s.id));
        const now = new Date().toISOString();
        plan = planIngest(observations, existing, { now, scoring: settings.scoring, baselineSearches });
        if (!dryRun) {
          await repo.applyPlan(this.env.DB, plan.items, runId, now);
          await this.sendRunUrgent(run);
        }

        // 3. Enrich a few new adverts from their item pages, best first, then re-score (may add a second, later alert).
        const candidates = plan.items.filter((i) => i.kind === 'new' && !i.listing.baseline && i.listing.route !== 'low').sort((a, b) => (b.listing.score ?? 0) - (a.listing.score ?? 0)).slice(0, L.maxDetailPagesPerRun);
        if (candidates.length && !aborted) {
          const td = Date.now();
          const det = await this.expectJson<{ aborted: string | null; items: Array<{ href: string; ok: boolean; lines: string[] }> }>(
            '/details',
            { method: 'POST', body: JSON.stringify({ urls: candidates.map((c) => c.listing.url), pageDelayMs: Math.min(L.pageDelayMs, 3000), deadlineMs: 90_000 }) },
            120_000,
          ).catch(() => null);
          timings.detailsMs = Date.now() - td;
          if (det) {
            if (det.aborted === 'login' || det.aborted === 'checkpoint') aborted = det.aborted;
            const byUrl = new Map(det.items.filter((d) => d.ok).map((d) => [d.href, parseDetail(d) as ParsedDetail] as const));
            const enriched = observations.filter((o) => byUrl.has(o.card.url)).map((o) => ({ ...o, detail: byUrl.get(o.card.url)! }));
            if (enriched.length) {
              const replan = planIngest(enriched, existing, { now, scoring: settings.scoring, baselineSearches });
              const byId = new Map(replan.items.map((i) => [i.listing.id, i] as const));
              plan = { ...plan, items: plan.items.map((i) => byId.get(i.listing.id) ?? i) };
              if (!dryRun) {
                await repo.applyPlan(this.env.DB, replan.items, runId, now);
                await this.sendRunUrgent(run);
              }
            }
          }
        }
      }

      // 4. Measure, maybe re-snapshot, stop.
      if (containerStartedAt !== null && this.container.running) {
        const m = await this.expectJson<{ cpu_seconds: number | null; mem_peak_bytes: number | null }>('/metrics', { method: 'GET' }, 10_000).catch(() => null);
        timings.cpuSeconds = m?.cpu_seconds ?? null;
        timings.memPeakBytes = m?.mem_peak_bytes ?? null;
        const current = (await this.ctx.storage.get<MarketSnapshot>(K_SNAPSHOT)) ?? null;
        if (!aborted && !sessionError && current && shouldResnapshot(current, Date.now(), L.resnapshotEveryHours)) {
          const ts = Date.now();
          const recheck = await this.expectJson<{ state: FbState }>('/session/status?settle=5000', { method: 'GET' }, 20_000).catch(() => null);
          if (recheck?.state === 'authenticated') {
            await this.closeAndSnapshot('collect', current.generation + 1, current.imageVersion).catch((err: unknown) => this.log('warn', 'resnapshot_failed', { error_code: err instanceof OpError ? err.code : errorName(err) }));
          }
          timings.snapshotMs = Date.now() - ts;
        }
      }
    } catch (err) {
      sessionError = err instanceof OpError ? err.code : 'COLLECT_ERROR';
      this.log('error', 'collect_failed', { error_code: sessionError });
    } finally {
      const ts = Date.now();
      await this.stopContainer();
      timings.shutdownMs = Date.now() - ts;
      if (containerStartedAt !== null) run.billableMs = Date.now() - containerStartedAt;
      timings.totalMs = Date.now() - t0;
      this.st = { ...this.st, phase: 'idle', controlToken: null };
      await this.save();
    }

    // 5. After the container is stopped: bookkeeping, optional AI for borderline, guards.
    const status: RunStatus = runStatus({ aborted, searchesOk: run.searchesOk, searchesFailed: run.searchesFailed, sessionError });
    run.itemsSeen = plan?.counts.seen ?? 0;
    run.newCount = plan?.counts.new ?? 0;
    run.priceDrops = plan?.counts.priceDrops ?? 0;
    run.urgentCount = plan?.items.filter((i) => i.notify?.class.startsWith('urgent')).length ?? 0;
    run.reviewCount = plan?.items.filter((i) => i.notify?.class === 'daily').length ?? 0;

    if (!dryRun) {
      const now = new Date().toISOString();
      await repo.recordSearchOutcomes(this.env.DB, searchOutcomes, now);
      if (status === 'ok' && canMarkMissing(run)) await repo.markMissing(this.env.DB, new Date(Date.now() - L.missingAfterHours * 3_600_000).toISOString());
      if (plan) await this.classifyBorderline(plan.items.filter((i) => i.borderline && i.kind === 'new').map((i) => i.listing), settings, runId);
    } else if (plan) {
      await this.ctx.storage.put(K_LAST_DRY_RUN, {
        runId,
        at: startedAt,
        counts: plan.counts,
        items: plan.items
          .slice()
          .sort((a, b) => (b.listing.score ?? 0) - (a.listing.score ?? 0))
          .slice(0, 50)
          .map((i) => ({ id: i.listing.id, url: i.listing.url, title: i.listing.title, pricePence: i.listing.pricePence, location: i.listing.location, route: i.listing.route, score: i.listing.score, reasons: i.listing.reasons, kind: i.kind, wouldNotify: i.notify })),
      });
    }

    if (aborted === 'login' || aborted === 'checkpoint') await this.sessionLost(aborted);
    await this.finishRun(run, status, sessionError ?? (aborted ? `ABORTED_${aborted.toUpperCase()}` : status === 'failed' ? 'NO_SEARCH_SUCCEEDED' : null));
  }

  private async finishRun(run: repo.RunRow, status: RunStatus, errorCode: string | null): Promise<void> {
    run.status = status;
    run.errorCode = errorCode;
    run.completedAt = new Date().toISOString();
    await repo.saveRun(this.env.DB, run).catch((err: unknown) => this.log('error', 'run_row_failed', { error_code: errorName(err) }));
    const settings = await this.settings();
    const failed = status === 'failed' || status === 'auth_failed';
    this.st = { ...this.st, phase: 'idle', consecutiveFailures: failed ? this.st.consecutiveFailures + 1 : status === 'skipped' ? this.st.consecutiveFailures : 0, ...(errorCode && failed ? { lastError: { code: errorCode, at: Date.now() } } : {}) };
    await this.save();
    if (status === 'failed' && run.trigger !== 'dry_run') {
      await this.alert({ code: 'COLLECT_FAILED', title: 'A Marketplace collection failed', detail: [`Run ${run.id}: ${errorCode ?? 'failed'}.`], action: 'Check GET /admin/api/runs and /admin status. Facebook may have changed its pages.' });
    }
    const sch = await this.schedule();
    if (sch.collectionEnabled && circuitOpen(this.st.consecutiveFailures, settings.limits.circuitBreakerFailures)) {
      await this.ctx.storage.put(K_SCHEDULE, { ...sch, collectionEnabled: false, pausedReason: 'circuit_breaker' });
      await this.alert({ code: 'CIRCUIT_OPEN', title: 'Hourly Marketplace collection paused after repeated failures', detail: [`${this.st.consecutiveFailures} failed runs in a row. Last: ${errorCode ?? status}.`], action: 'Investigate on /admin, then resume with PUT /admin/api/schedule.' });
    }
    // Cost guard after every measured run.
    if (run.billableMs) {
      const s2 = await this.schedule();
      const proj = await this.projection(s2.intervalHours);
      if (proj.verdict === 'over_budget' && s2.collectionEnabled && settings.cost.autoDisable) {
        await this.ctx.storage.put(K_SCHEDULE, { ...s2, collectionEnabled: false, pausedReason: 'cost_guard_projection' });
        await this.alert({ code: 'COST_GUARD', title: 'Hourly Marketplace collection paused: projected to exceed the free allowance', detail: [`Projected ${Math.round(proj.fractionOfAllowance * 100)}% of the included ${proj.binding} (incremental ~£${proj.incrementalGbp.toFixed(2)}/month).`, `Average billable run ${proj.avgBillableSeconds?.toFixed(0) ?? '?'} s; budget allows ~${proj.maxSecondsPerRunWithinBudget ?? '?'} s on ${this.instance}.`], action: 'Reduce searches/scrolls/detail pages, use a smaller instance or a longer interval, then resume.' });
      } else if (proj.verdict === 'warn' && s2.collectionEnabled) {
        await this.alert({ code: 'COST_WARN', title: 'Marketplace collection is using most of the container allowance', detail: [`Projected ${Math.round(proj.fractionOfAllowance * 100)}% of the included ${proj.binding}.`], action: 'No action needed yet; check GET /admin/api/usage.' });
      }
    }
    this.log('info', 'collect_run_complete', { run: run.id, status, items: run.itemsSeen, new: run.newCount, urgent: run.urgentCount, billable_ms: run.billableMs });
  }

  /** Send every pending urgent notification created in this run as one email. */
  private async sendRunUrgent(run: repo.RunRow): Promise<void> {
    const pending = await repo.pendingNotifications(this.env.DB, ['urgent_new', 'urgent_price_drop'], { runId: run.id, limit: 25 });
    if (!pending.length) return;
    const prevPrices = await this.previousPrices(pending.filter((p) => p.class === 'urgent_price_drop').map((p) => p.listing.id));
    const leads: Lead[] = pending.map((p) => ({ listing: p.listing, class: p.class, previousPricePence: prevPrices.get(p.listing.id) ?? null }));
    const r = await this.sendUrgent(leads, pending.map((p) => ({ listingId: p.listing.id, class: p.class, dedupeKey: p.dedupeKey })));
    if (r.sent) {
      run.alertEmailSentAt = r.at;
      const lat = pending.filter((p) => p.class === 'urgent_new').map((p) => Date.parse(r.at) - Date.parse(p.listing.firstSeenAt));
      if (lat.length) run.firstSeenToEmailMs = Math.max(run.firstSeenToEmailMs ?? 0, ...lat);
    }
  }

  private async previousPrices(ids: readonly string[]): Promise<Map<string, number | null>> {
    const out = new Map<string, number | null>();
    for (const id of ids) {
      const r = await this.env.DB.prepare('SELECT price_pence FROM market_price_history WHERE listing_id = ? ORDER BY observed_at DESC LIMIT 1 OFFSET 1').bind(id).first<{ price_pence: number | null }>();
      out.set(id, r?.price_pence ?? null);
    }
    return out;
  }

  private async sendUrgent(leads: Lead[], rows: Array<{ listingId: string; class: Lead['class']; dedupeKey: string }>): Promise<{ sent: boolean; at: string }> {
    const at = new Date().toISOString();
    const to = this.env.ALERT_TO;
    const from = this.env.ALERT_FROM;
    if (!to || !from) {
      await repo.markNotifications(this.env.DB, rows, 'failed', at, 'not_configured');
      return { sent: false, at };
    }
    const mail = renderUrgentEmail(leads, this.env.WORKER_URL ?? '');
    try {
      await this.env.EMAIL.send({ from: { email: from, name: 'Car Leads' }, to, subject: mail.subject, text: mail.text, html: mail.html, headers: { 'X-Car-Lead': 'urgent' } } as unknown as EmailMessageBuilder);
      const sentAt = new Date().toISOString();
      await repo.markNotifications(this.env.DB, rows, 'sent', sentAt);
      this.log('info', 'lead_email_sent', { leads: leads.length });
      return { sent: true, at: sentAt };
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      await repo.markNotifications(this.env.DB, rows, 'failed', at, typeof code === 'string' ? code : 'E_SEND_FAILED');
      await this.alert({ code: 'LEAD_EMAIL_FAILED', title: 'A car lead email could not be sent', detail: [`${leads.length} lead(s). Error: ${typeof code === 'string' ? code : 'unknown'}.`], action: 'Check the leads on /admin (GET /admin/api/listings?view=new) and Email Sending status.' });
      return { sent: false, at };
    }
  }

  /** Optional AI second opinion for borderline adverts (after urgent emails; container already stopped). */
  private async classifyBorderline(listings: StoredMarketListing[], settings: Settings, runId: string): Promise<void> {
    if (!listings.length || !settings.ai.enabled) return;
    let budget = freshBudget(new Date(), (await this.ctx.storage.get<AiBudgetState>(K_AI_BUDGET)) ?? null);
    const runner: AiRunner = (model, input) => this.env.AI.run(model as Parameters<Ai['run']>[0], input as never) as Promise<unknown>;
    let calls = 0;
    const urgent: Lead[] = [];
    const rows: Array<{ listingId: string; class: Lead['class']; dedupeKey: string }> = [];
    for (const l of listings.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))) {
      const { outcome, tokens, called } = await classifyBorderline(
        { title: l.title, pricePence: l.pricePence, location: l.location, distanceMiles: l.distanceMiles, year: l.year, mileage: l.mileage, description: l.description, ruleReasons: l.reasons },
        settings.ai,
        budget,
        calls,
        runner,
      );
      if (called) {
        calls++;
        budget = { ...budget, dayCalls: budget.dayCalls + 1, monthCalls: budget.monthCalls + 1, monthTokens: budget.monthTokens + tokens };
      }
      if (outcome.status === 'skipped' && outcome.reason !== 'disabled') break;
      if (outcome.status === 'ok') {
        await repo.setAiResult(this.env.DB, l.id, outcome.verdict, new Date().toISOString());
        if (outcome.route === 'urgent' && (await repo.insertNotification(this.env.DB, l.id, 'urgent_ai', 'ai', runId, new Date().toISOString()))) {
          urgent.push({ listing: l, class: 'urgent_ai', previousPricePence: null, aiReason: outcome.verdict.reason });
          rows.push({ listingId: l.id, class: 'urgent_ai', dedupeKey: 'ai' });
        }
      }
      // Failures and "daily" verdicts leave the listing's daily notification pending: it reaches the roundup.
    }
    await this.ctx.storage.put(K_AI_BUDGET, budget);
    if (urgent.length) await this.sendUrgent(urgent, rows);
  }

  /** The daily roundup: pending borderline leads, never ones already alerted, only if there are any. */
  private async roundup(now: Date, dryRun: boolean): Promise<unknown> {
    const settings = await this.settings();
    const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    const pending = await repo.pendingNotifications(this.env.DB, ['daily'], { since, limit: 500 });
    const alerted = await repo.alreadyAlerted(this.env.DB, pending.map((p) => p.listing.id));
    const repeat = pending.filter((p) => alerted.has(p.listing.id));
    const fresh = pending.filter((p) => !alerted.has(p.listing.id)).slice(0, settings.roundup.maxItems);
    const rowsOf = (xs: typeof pending): Array<{ listingId: string; class: 'daily'; dedupeKey: string }> => xs.map((p) => ({ listingId: p.listing.id, class: 'daily', dedupeKey: p.dedupeKey }));
    if (dryRun) return { wouldSend: fresh.length, suppressedAlreadyAlerted: repeat.length, items: fresh.map((p) => ({ id: p.listing.id, title: p.listing.title, score: p.listing.score })) };
    const at = now.toISOString();
    await repo.markNotifications(this.env.DB, rowsOf(repeat), 'suppressed', at, 'already_alerted');
    if (!fresh.length) return { sent: false, reason: 'empty' };
    const to = this.env.ALERT_TO;
    const from = this.env.ALERT_FROM;
    if (!to || !from) return { sent: false, reason: 'not_configured' };
    const mail = renderRoundupEmail(
      fresh.map((p) => ({ listing: p.listing, class: 'daily', previousPricePence: null })),
      this.env.WORKER_URL ?? '',
      londonTime(now).date,
    );
    try {
      await this.env.EMAIL.send({ from: { email: from, name: 'Car Leads' }, to, subject: mail.subject, text: mail.text, html: mail.html, headers: { 'X-Car-Lead': 'daily' } } as unknown as EmailMessageBuilder);
      await repo.markNotifications(this.env.DB, rowsOf(fresh), 'sent', new Date().toISOString());
      return { sent: true, items: fresh.length };
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      await this.alert({ code: 'LEAD_EMAIL_FAILED', title: 'The daily car-lead roundup could not be sent', detail: [`Error: ${typeof code === 'string' ? code : 'unknown'}. The leads stay queued for the next roundup.`], action: 'POST /admin/api/roundup to retry once fixed.' });
      return { sent: false, reason: 'send_failed' };
    }
  }

  // ───────────────────────────── usage ─────────────────────────────

  private async projection(intervalHours: number): Promise<Projection> {
    const settings = await this.settings();
    const recent = (await repo.measuredRuns(this.env.DB, { limit: 20 })).filter((r) => r.instance === this.instance);
    return projectMonthly(recent, Math.round((30 * 24) / Math.max(1, intervalHours)), settings.cost, this.instance);
  }

  private async usage(): Promise<unknown> {
    const settings = await this.settings();
    const sch = await this.schedule();
    const monthStart = `${new Date().toISOString().slice(0, 7)}-01T00:00:00.000Z`;
    const mtdRuns = await repo.measuredRuns(this.env.DB, { since: monthStart, limit: 2000 });
    const budget = (await this.ctx.storage.get<AiBudgetState>(K_AI_BUDGET)) ?? null;
    return {
      instance: this.instance,
      spec: INSTANCE_SPECS[this.instance],
      monthToDate: { runs: mtdRuns.length, usage: sumUsage(mtdRuns, settings.cost) },
      projection: await this.projection(sch.intervalHours),
      allowance: settings.cost.included,
      whatsappReservation: settings.cost.whatsappMonthly,
      ai: budget ? freshBudget(new Date(), budget) : null,
      note: 'Projection = WhatsApp reservation + average measured marketplace run × runs per 30-day month. Memory and disk bill on provisioned size; CPU on measured cgroup time when available.',
    };
  }

  // ───────────────────────────── container helpers (mirrors the WhatsApp controller) ─────────────────────────────

  private get container(): Container {
    const c = this.ctx.container;
    if (!c) throw new OpError('NO_CONTAINER_BINDING');
    return c;
  }

  private async startContainer(fromSnapshot: MarketSnapshot | null, purpose: string): Promise<void> {
    const token = randomToken();
    this.st = { ...this.st, controlToken: token };
    await this.save();
    const common = { instance: this.instance as 'basic', enableInternet: true, env: { CONTROL_TOKEN: token }, labels: { purpose: `market-${purpose}` } };
    try {
      if (fromSnapshot) this.container.start({ ...common, containerSnapshot: { id: fromSnapshot.id } });
      else {
        const image = this.container.images.market;
        if (!image) throw new OpError('IMAGE_NOT_CONFIGURED');
        this.container.start({ ...common, image });
      }
    } catch (err) {
      if (err instanceof OpError) throw err;
      throw new OpError(fromSnapshot ? 'RESTORE_START_FAILED' : 'CONTAINER_START_FAILED', errorName(err));
    }
    const health = await this.waitHealthy();
    const keepAlive = purpose === 'login' ? 32 * 60_000 : (await this.opDeadlineMs()) + 60_000;
    await this.container.setInactivityTimeout(keepAlive).catch((err: unknown) => this.log('warn', 'inactivity_timeout_failed', { error_code: errorName(err) }));
    this.watchContainer();
    const expected = fromSnapshot ? fromSnapshot.imageVersion : this.imageVersion;
    if (health.image_version !== expected) throw new OpError('IMAGE_VERSION_MISMATCH', `running=${health.image_version} expected=${expected}`);
  }

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
        if (this.st.phase === 'login_awaiting' || this.st.phase === 'login_starting') {
          this.st = { ...this.st, phase: 'idle', loginExpiresAt: null, controlToken: null, lastError: { code: 'CONTAINER_EXITED', at: Date.now(), detail: how } };
          await this.save();
        }
      });
  }

  private async waitHealthy(): Promise<{ ok: boolean; image_version: string }> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.container.running) {
        try {
          const res = await this.container.getTcpPort(PORT).fetch('http://container/healthz', { signal: AbortSignal.timeout(5000) });
          if (res.ok) return (await res.json()) as { ok: boolean; image_version: string };
        } catch {
          /* booting */
        }
      }
      await sleep(1000);
    }
    throw new OpError('CONTAINER_HEALTH_TIMEOUT');
  }

  private async closeAndSnapshot(origin: MarketSnapshot['origin'], generation: number, imageVersion: string): Promise<MarketSnapshot> {
    const closed = await this.expectJson<{ closed: boolean }>('/session/close', { method: 'POST' }, 60_000);
    if (!closed.closed) throw new OpError('BROWSER_CLOSE_FAILED');
    let handle: ContainerSnapshot;
    try {
      handle = await this.container.snapshotContainer({ name: `fbm-${origin}-g${generation}` });
    } catch (err) {
      throw new OpError('SNAPSHOT_FAILED', errorName(err));
    }
    const now = Date.now();
    const rec: MarketSnapshot = { id: handle.id, sizeBytes: handle.size, createdAt: now, lastTouchedAt: now, imageVersion, origin, generation };
    await this.ctx.storage.put(K_SNAPSHOT, rec);
    this.log('info', 'snapshot_created', { origin, generation, size_bytes: rec.sizeBytes });
    return rec;
  }

  private async stopContainer(): Promise<boolean> {
    const c = this.ctx.container;
    if (!c || !c.running) return true;
    this.stopping = true;
    if (this.st.controlToken) await this.call('/session/close', { method: 'POST' }, 30_000).catch(() => undefined);
    try {
      c.signal(15);
    } catch {
      /* exiting */
    }
    const exited = await Promise.race([
      c.monitor().then(
        () => true,
        () => true,
      ),
      sleep(STOP_GRACE_MS).then(() => false),
    ]);
    if (!exited || c.running) await c.destroy().catch(() => undefined);
    for (let i = 0; i < 10 && c.running; i++) await sleep(500);
    const stopped = !c.running;
    this.log(stopped ? 'info' : 'error', 'container_stopped', { graceful: exited, confirmed: stopped });
    return stopped;
  }

  private async call(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const token = this.st.controlToken;
    if (!token) throw new OpError('NO_CONTROL_TOKEN');
    return this.container.getTcpPort(PORT).fetch(`http://container${path}`, { ...init, headers: { 'x-control-token': token, 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
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

  private async queue(op: MarketOp): Promise<MarketQueueResult> {
    const allowed = canQueueMarket(op, this.st);
    if (!allowed.ok) return { ok: false, code: allowed.code, status: await this.getStatus() };
    this.st = { ...this.st, pendingOp: op };
    await this.save();
    await this.ctx.storage.setAlarm(Date.now());
    this.log('info', 'op_queued', { op });
    return { ok: true, status: await this.getStatus() };
  }

  private async housekeepingAlarm(): Promise<void> {
    if (this.st.phase === 'login_awaiting' && this.st.loginExpiresAt) await this.ctx.storage.setAlarm(this.st.loginExpiresAt);
    else if (this.ctx.container?.running) await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }

  private async settings(): Promise<Settings> {
    return withDefaults((await this.ctx.storage.get<unknown>(K_SETTINGS)) ?? DEFAULT_SETTINGS);
  }

  private async schedule(): Promise<ScheduleState> {
    return { ...DEFAULT_SCHEDULE, ...((await this.ctx.storage.get<ScheduleState>(K_SCHEDULE)) ?? {}) };
  }

  private async save(): Promise<void> {
    await this.ctx.storage.put(K_STATE, this.st);
  }

  /** Operational alert (no listing content), at most once per code per cool-down. Never throws. */
  private async alert(a: { code: MarketAlertCode; title: string; detail: string[]; action: string }): Promise<boolean> {
    const log = (await this.ctx.storage.get<AlertLog>(K_ALERTS)) ?? { lastSent: {}, recent: [] };
    const now = Date.now();
    let sent = false;
    let error: string | null = null;
    if (!shouldSendAlert(a.code, log.lastSent, now)) error = 'suppressed_cooldown';
    else if (!this.env.ALERT_TO || !this.env.ALERT_FROM) error = 'not_configured';
    else {
      const r = renderOpsAlert(a, this.env.WORKER_URL ?? '');
      try {
        await this.env.EMAIL.send({ from: { email: this.env.ALERT_FROM, name: 'Car Leads' }, to: this.env.ALERT_TO, subject: r.subject, text: r.text, headers: { 'X-Alert-Code': a.code } } as unknown as EmailMessageBuilder);
        sent = true;
        log.lastSent[a.code] = now;
      } catch (err) {
        const code = (err as { code?: unknown })?.code;
        error = typeof code === 'string' ? code : 'E_SEND_FAILED';
      }
    }
    log.recent = [{ at: new Date(now).toISOString(), code: a.code, title: a.title, sent, error }, ...log.recent].slice(0, 50);
    await this.ctx.storage.put(K_ALERTS, log);
    this.log(sent ? 'warn' : 'info', 'alert', { code: a.code, sent, error });
    return sent;
  }

  private log(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}): void {
    const line = JSON.stringify({ level, event, worker: 'marketplace', phase: this.st.phase, ...fields });
    if (level === 'error') console.error(line);
    else console.log(line);
  }
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
