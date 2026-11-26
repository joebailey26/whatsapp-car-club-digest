import { describe, expect, it, vi } from 'vitest';
import { budgetBlock, classifyBorderline, freshBudget, parseVerdict, type AiRunner } from '../src/marketplace/classify';
import { DEFAULT_SETTINGS, SearchesSchema, mergeSettings, withDefaults } from '../src/marketplace/config';
import { DEFAULT_COST, monthToDateOverBudget, projectMonthly, usageForRun } from '../src/marketplace/cost';
import { planIngest, type StoredMarketListing } from '../src/marketplace/ingest';
import {
  DEFAULT_SCHEDULE,
  INITIAL_MARKET_STATE,
  canQueueMarket,
  circuitOpen,
  decideTick,
  runStatus,
  shouldResnapshot,
  snapshotUsable,
  type MarketSnapshot,
} from '../src/marketplace/lifecycle';
import { MARKET_ALERT_COOLDOWN_MS, renderRoundupEmail, renderUrgentEmail, shouldSendAlert } from '../src/marketplace/notify';
import { parseCard } from '../src/marketplace/parse';
import { DEFAULT_SCORING } from '../src/marketplace/score';

// ───────────── cost guard ─────────────

describe('cost projection and £0 guard', () => {
  it('refuses to project without measurements (no assumed durations)', () => {
    const p = projectMonthly([], 720, DEFAULT_COST, 'basic');
    expect(p.verdict).toBe('insufficient_data');
    expect(p.perRun).toBeNull();
    expect(p.maxSecondsPerRunWithinBudget).toBeGreaterThan(0);
  });
  it('needs the configured number of measured runs before saying ok', () => {
    const runs = [{ instance: 'basic', billableMs: 60_000, cpuSeconds: 8 }];
    expect(projectMonthly(runs, 720, DEFAULT_COST, 'basic').verdict).toBe('insufficient_data');
    expect(projectMonthly([...runs, ...runs, ...runs], 720, DEFAULT_COST, 'basic').verdict).toBe('ok');
  });
  it('flags hourly standard-1 runs as over budget: memory bills on provisioned size', () => {
    const runs = Array(3).fill({ instance: 'standard-1', billableMs: 120_000, cpuSeconds: 20 });
    const p = projectMonthly(runs, 720, DEFAULT_COST, 'standard-1');
    expect(p.verdict).toBe('over_budget');
    expect(p.binding).toBe('memGiBHours');
    expect(p.incrementalGbp).toBeGreaterThan(0);
  });
  it('includes the WhatsApp reservation (shared allowance)', () => {
    const p = projectMonthly(Array(3).fill({ instance: 'basic', billableMs: 60_000, cpuSeconds: 5 }), 720, DEFAULT_COST, 'basic');
    expect(p.projectedMonthly.memGiBHours).toBeCloseTo(DEFAULT_COST.whatsappMonthly.memGiBHours + 12, 5);
  });
  it('assumes full CPU when the container cannot report it (conservative)', () => {
    expect(usageForRun({ instance: 'basic', billableMs: 60_000, cpuSeconds: null }, DEFAULT_COST).vcpuMinutes).toBeCloseTo(0.25, 5);
    expect(usageForRun({ instance: 'basic', billableMs: 60_000, cpuSeconds: 6 }, DEFAULT_COST).vcpuMinutes).toBeCloseTo(0.1, 5);
  });
  it('trips the month-to-date guard past the safety fraction', () => {
    expect(monthToDateOverBudget({ memGiBHours: 1, vcpuMinutes: 10, diskGBHours: 2 }, DEFAULT_COST)).toBe(false);
    expect(monthToDateOverBudget({ memGiBHours: 21, vcpuMinutes: 10, diskGBHours: 2 }, DEFAULT_COST)).toBe(true);
  });
});

// ───────────── optional AI ─────────────

const aiCfg = { ...DEFAULT_SETTINGS.ai, enabled: true, timeoutMs: 50 };
const input = { title: 'Rover 75', pricePence: 60_000, location: null, distanceMiles: null, year: null, mileage: null, description: null, ruleReasons: [] };
const budget = freshBudget(new Date('2026-11-25T10:00:00Z'), null);

describe('borderline AI classification never blocks or drops leads', () => {
  it('is skipped when disabled', async () => {
    const run = vi.fn();
    const r = await classifyBorderline(input, { ...aiCfg, enabled: false }, budget, 0, run);
    expect(r.outcome).toMatchObject({ status: 'skipped', reason: 'disabled', route: 'review' });
    expect(run).not.toHaveBeenCalled();
  });
  it('falls back to the daily review queue on timeout', async () => {
    const slow: AiRunner = () => new Promise((r) => setTimeout(() => r({ response: '{}' }), 500));
    expect((await classifyBorderline(input, aiCfg, budget, 0, slow)).outcome).toMatchObject({ status: 'failed', reason: 'AI_TIMEOUT', route: 'review' });
  });
  it('falls back on errors and invalid output', async () => {
    expect((await classifyBorderline(input, aiCfg, budget, 0, () => Promise.reject(new Error('boom')))).outcome.route).toBe('review');
    expect((await classifyBorderline(input, aiCfg, budget, 0, () => Promise.resolve({ response: 'not json' }))).outcome).toMatchObject({ status: 'failed', reason: 'AI_INVALID_OUTPUT' });
  });
  it('alerts only on a confident "high"', async () => {
    const say = (v: object): AiRunner => () => Promise.resolve({ response: '```json\n' + JSON.stringify(v) + '\n```' });
    expect((await classifyBorderline(input, aiCfg, budget, 0, say({ priority: 'high', reason: 'cheap', confidence: 0.9 }))).outcome.route).toBe('urgent');
    expect((await classifyBorderline(input, aiCfg, budget, 0, say({ priority: 'high', reason: 'cheap', confidence: 0.4 }))).outcome.route).toBe('review');
    expect((await classifyBorderline(input, aiCfg, budget, 0, say({ priority: 'ignore', reason: 'no', confidence: 0.5 }))).outcome.route).toBe('review');
  });
  it('enforces per-run, per-day and per-month budgets', () => {
    expect(budgetBlock(aiCfg, budget, aiCfg.maxCallsPerRun)).toBe('budget_run');
    expect(budgetBlock(aiCfg, { ...budget, dayCalls: aiCfg.maxCallsPerDay }, 0)).toBe('budget_day');
    expect(budgetBlock(aiCfg, { ...budget, monthCalls: aiCfg.maxCallsPerMonth }, 0)).toBe('budget_month');
    expect(freshBudget(new Date('2026-11-26T00:00:01Z'), { ...budget, dayCalls: 9 }).dayCalls).toBe(0);
  });
  it('parses fenced JSON and rejects schema violations', () => {
    expect(parseVerdict('x {"priority":"daily","reason":"r","confidence":0.5} y')?.priority).toBe('daily');
    expect(parseVerdict('{"priority":"urgent","reason":"r","confidence":0.5}')).toBeNull();
  });
});

// ───────────── schedule, circuit breaker, session ─────────────

const idle = { ...INITIAL_MARKET_STATE, session: 'signed_in' as const };
const on = { ...DEFAULT_SCHEDULE, collectionEnabled: true };
const roundup = { enabled: true, hourLondon: 18 };

describe('hourly tick decisions', () => {
  it('does nothing while collection is off (the default)', () => {
    expect(decideTick(new Date('2026-11-25T10:07:00Z'), DEFAULT_SCHEDULE, idle, roundup).collect).toBe('disabled');
  });
  it('starts once per slot and never overlaps a running op', () => {
    const now = new Date('2026-11-25T10:07:00Z');
    expect(decideTick(now, on, idle, roundup).collect).toBe('start');
    expect(decideTick(now, { ...on, lastSlot: '2026-11-25T10' }, idle, roundup).collect).toBe('already_ran');
    expect(decideTick(now, on, { ...idle, runningOp: 'collect' }, roundup).collect).toBe('busy');
    expect(decideTick(now, on, { ...idle, phase: 'login_awaiting' }, roundup).collect).toBe('busy');
  });
  it('never collects with a logged-out or challenged session', () => {
    expect(decideTick(new Date('2026-11-25T10:07:00Z'), on, { ...idle, session: 'checkpoint' }, roundup).collect).toBe('session_bad');
    expect(decideTick(new Date('2026-11-25T10:07:00Z'), on, { ...idle, session: 'relogin_required' }, roundup).collect).toBe('session_bad');
  });
  it('honours a longer interval', () => {
    expect(decideTick(new Date('2026-11-25T11:07:00Z'), { ...on, intervalHours: 2 }, idle, roundup).collect).toBe('not_this_hour');
    expect(decideTick(new Date('2026-11-25T12:07:00Z'), { ...on, intervalHours: 2 }, idle, roundup).collect).toBe('start');
  });
  it('sends the roundup once a day at the configured UK hour, independent of collection', () => {
    expect(decideTick(new Date('2026-11-25T18:07:00Z'), DEFAULT_SCHEDULE, idle, roundup).roundup).toBe(true); // GMT
    expect(decideTick(new Date('2026-11-25T18:07:00Z'), { ...DEFAULT_SCHEDULE, lastRoundupDate: '2026-11-25' }, idle, roundup).roundup).toBe(false);
    expect(decideTick(new Date('2027-06-01T17:07:00Z'), DEFAULT_SCHEDULE, idle, roundup).roundup).toBe(true); // BST
    expect(decideTick(new Date('2026-11-25T18:07:00Z'), DEFAULT_SCHEDULE, idle, { ...roundup, enabled: false }).roundup).toBe(false);
  });
  it('opens the circuit after N consecutive failures', () => {
    expect(circuitOpen(2, 3)).toBe(false);
    expect(circuitOpen(3, 3)).toBe(true);
  });
  it('classifies run outcomes, including auth failure and partial runs', () => {
    expect(runStatus({ aborted: 'checkpoint', searchesOk: 1, searchesFailed: 0, sessionError: null })).toBe('auth_failed');
    expect(runStatus({ aborted: null, searchesOk: 1, searchesFailed: 1, sessionError: null })).toBe('partial');
    expect(runStatus({ aborted: null, searchesOk: 2, searchesFailed: 0, sessionError: null })).toBe('ok');
    expect(runStatus({ aborted: null, searchesOk: 0, searchesFailed: 0, sessionError: 'CONTAINER_HEALTH_TIMEOUT' })).toBe('failed');
  });
  it('allows only one op at a time', () => {
    expect(canQueueMarket('collect', idle).ok).toBe(true);
    expect(canQueueMarket('collect', { ...idle, pendingOp: 'restore_test' })).toEqual({ ok: false, code: 'BUSY' });
    expect(canQueueMarket('complete_login', idle)).toEqual({ ok: false, code: 'NOT_LOGGING_IN' });
  });
});

describe('snapshots', () => {
  const snap: MarketSnapshot = { id: 'abc', sizeBytes: 1, createdAt: 0, lastTouchedAt: 0, imageVersion: '0.1.0', origin: 'login', generation: 0 };
  it('refuses an image mismatch or an expired snapshot', () => {
    expect(snapshotUsable(snap, '0.1.0', 1000)).toEqual({ ok: true });
    expect(snapshotUsable(snap, '0.2.0', 1000)).toEqual({ ok: false, code: 'SNAPSHOT_IMAGE_MISMATCH' });
    expect(snapshotUsable(snap, '0.1.0', 30 * 86_400_000)).toEqual({ ok: false, code: 'SNAPSHOT_EXPIRED' });
    expect(snapshotUsable(null, '0.1.0', 0)).toEqual({ ok: false, code: 'NO_SNAPSHOT' });
  });
  it('re-snapshots at most every N hours', () => {
    expect(shouldResnapshot(snap, 3 * 3_600_000, 24)).toBe(false);
    expect(shouldResnapshot(snap, 25 * 3_600_000, 24)).toBe(true);
  });
});

// ───────────── settings ─────────────

describe('settings and searches', () => {
  it('only accepts https Facebook Marketplace search URLs', () => {
    expect(SearchesSchema.safeParse({ searches: [{ id: 'ramsey', label: 'x', url: 'https://www.facebook.com/marketplace/108/vehicles?maxPrice=1000' }] }).success).toBe(true);
    expect(SearchesSchema.safeParse({ searches: [{ id: 'ramsey', label: 'x', url: 'https://evil.example/marketplace/' }] }).success).toBe(false);
    expect(SearchesSchema.safeParse({ searches: [{ id: 'a', label: 'x', url: 'https://www.facebook.com/marketplace/x' }] }).success).toBe(false); // id too short
  });
  it('deep-merges partial updates and validates the whole', () => {
    const r = mergeSettings(DEFAULT_SETTINGS, { limits: { maxSearchesPerRun: 3 } });
    expect(r.ok && r.value.limits.maxSearchesPerRun).toBe(3);
    expect(r.ok && r.value.limits.maxItemsPerSearch).toBe(DEFAULT_SETTINGS.limits.maxItemsPerSearch);
    expect(mergeSettings(DEFAULT_SETTINGS, { limits: { runDeadlineMs: 60 * 60_000 } }).ok).toBe(false);
    expect(withDefaults(null)).toEqual(DEFAULT_SETTINGS);
  });
});

// ───────────── emails ─────────────

function listing(patch: Partial<StoredMarketListing> = {}): StoredMarketListing {
  const o = { card: parseCard({ href: '/marketplace/item/123456789/', lines: ['£750', 'Mazda MX-5 <script>', 'Ramsey'] })!, detail: null, searchId: 's' };
  return { ...planIngest([o], new Map(), { now: '2026-11-25T10:07:00.000Z', scoring: DEFAULT_SCORING, baselineSearches: new Set() }).items[0]!.listing, ...patch };
}

describe('lead emails', () => {
  it('carries the original URL, reasons, discovery time and the review link, with no AI', () => {
    const m = renderUrgentEmail([{ listing: listing(), class: 'urgent_new', previousPricePence: null }], 'https://w.example');
    expect(m.subject).toContain('£750');
    expect(m.text).toContain('https://www.facebook.com/marketplace/item/123456789/');
    expect(m.text).toContain('First discovered by the collector');
    expect(m.text).toContain('Originally posted: not shown');
    expect(m.text).toContain('https://w.example/admin/review/facebook_marketplace%3A123456789');
    expect(m.text).toMatch(/LEADS-JSON: \[/);
  });
  it('escapes advert text in HTML', () => {
    const m = renderUrgentEmail([{ listing: listing(), class: 'urgent_new', previousPricePence: null }], 'https://w.example');
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;');
  });
  it('shows price drops with the previous price', () => {
    const m = renderUrgentEmail([{ listing: listing({ pricePence: 60_000 }), class: 'urgent_price_drop', previousPricePence: 75_000 }], 'https://w.example');
    expect(m.subject).toContain('PRICE DROP £750 → £600');
  });
  it('renders the daily roundup', () => {
    const m = renderRoundupEmail([{ listing: listing(), class: 'daily', previousPricePence: null }], 'https://w.example', '2026-11-25');
    expect(m.subject).toContain('Daily review: 1 borderline advert');
  });
  it('rate-limits operational alerts per code', () => {
    expect(shouldSendAlert('FB_CHECKPOINT', {}, 0)).toBe(true);
    expect(shouldSendAlert('FB_CHECKPOINT', { FB_CHECKPOINT: 0 }, MARKET_ALERT_COOLDOWN_MS - 1)).toBe(false);
    expect(shouldSendAlert('TEST', { TEST: 0 }, 1)).toBe(true);
  });
});
