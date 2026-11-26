import { z } from 'zod';
import { CostSchema, DEFAULT_COST } from './cost';
import { DEFAULT_SCORING, ScoringSchema } from './score';

/**
 * Collector settings, stored in the MarketplaceController's Durable Object
 * storage (PUT /admin/api/settings). Searches themselves live in D1.
 */

export const SearchSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/, 'id: lower-case letters, digits and dashes'),
  label: z.string().min(1).max(80),
  url: z
    .string()
    .url()
    .refine((u) => {
      try {
        const x = new URL(u);
        return x.protocol === 'https:' && /^(www\.)?facebook\.com$/i.test(x.hostname) && x.pathname.startsWith('/marketplace/');
      } catch {
        return false;
      }
    }, 'url must be an https://www.facebook.com/marketplace/... search'),
  enabled: z.boolean().default(true),
  maxScrolls: z.number().int().min(0).max(6).default(2),
});
export type Search = z.infer<typeof SearchSchema>;
export const SearchesSchema = z.object({ searches: z.array(SearchSchema).max(10) }).refine(
  (v) => new Set(v.searches.map((s) => s.id)).size === v.searches.length,
  'search ids must be unique',
);

export const LimitsSchema = z.object({
  /** Searches visited per run (in configured order). */
  maxSearchesPerRun: z.number().int().min(1).max(10),
  /** Result cards read per search. */
  maxItemsPerSearch: z.number().int().min(5).max(200),
  /** Item pages opened per run, for new adverts only, to read the description and "Listed … ago". 0 disables. */
  maxDetailPagesPerRun: z.number().int().min(0).max(15),
  /** Pause between page loads, to keep the pattern human-paced. */
  pageDelayMs: z.number().int().min(1000).max(30_000),
  /** Hard cap on the whole container session for one run. */
  runDeadlineMs: z.number().int().min(60_000).max(10 * 60_000),
  /** Per page navigation timeout. */
  navTimeoutMs: z.number().int().min(5_000).max(60_000),
  /** Consecutive failed runs before the schedule pauses itself. */
  circuitBreakerFailures: z.number().int().min(1).max(10),
  /** Re-snapshot the browser profile at most this often (hours). Cookies refresh slowly; a snapshot per run is unnecessary. */
  resnapshotEveryHours: z.number().int().min(1).max(24 * 7),
  /** A listing not seen in this many hours (after complete runs) is marked missing. */
  missingAfterHours: z.number().int().min(6).max(24 * 30),
  /** Listings unseen for this many days are deleted (with history), unless marked interested. */
  retentionDays: z.number().int().min(7).max(365),
});
export type Limits = z.infer<typeof LimitsSchema>;

export const AiSchema = z.object({
  enabled: z.boolean(),
  model: z.string().min(3).max(100),
  timeoutMs: z.number().int().min(1000).max(30_000),
  maxCallsPerRun: z.number().int().min(0).max(20),
  maxCallsPerDay: z.number().int().min(0).max(200),
  maxCallsPerMonth: z.number().int().min(0).max(3000),
  /** An AI "high" result only alerts when at least this confident. */
  minConfidenceForAlert: z.number().min(0).max(1),
});
export type AiConfig = z.infer<typeof AiSchema>;

export const RoundupSchema = z.object({
  enabled: z.boolean(),
  /** Hour in Europe/London (0–23) at which the daily low-priority roundup is sent, if non-empty. */
  hourLondon: z.number().int().min(0).max(23),
  maxItems: z.number().int().min(1).max(100),
});

export const SettingsSchema = z.object({
  limits: LimitsSchema,
  scoring: ScoringSchema,
  cost: CostSchema,
  ai: AiSchema,
  roundup: RoundupSchema,
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  limits: {
    maxSearchesPerRun: 2,
    maxItemsPerSearch: 40,
    maxDetailPagesPerRun: 3,
    pageDelayMs: 4000,
    runDeadlineMs: 4 * 60_000,
    navTimeoutMs: 30_000,
    circuitBreakerFailures: 3,
    resnapshotEveryHours: 24,
    missingAfterHours: 72,
    retentionDays: 90,
  },
  scoring: DEFAULT_SCORING,
  cost: DEFAULT_COST,
  ai: {
    enabled: false,
    model: '@cf/openai/gpt-oss-120b',
    timeoutMs: 12_000,
    maxCallsPerRun: 3,
    maxCallsPerDay: 20,
    maxCallsPerMonth: 300,
    minConfidenceForAlert: 0.7,
  },
  roundup: { enabled: true, hourLondon: 18, maxItems: 30 },
};

/** Deep-merge a partial update over the current settings, then validate the whole. */
export function mergeSettings(current: Settings, patch: unknown): { ok: true; value: Settings } | { ok: false; error: string } {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'body must be an object' };
  const merged = deepMerge(current as unknown as Record<string, unknown>, patch as Record<string, unknown>);
  const parsed = SettingsSchema.safeParse(merged);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  return { ok: true, value: parsed.data };
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)
        ? deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>)
        : v;
  }
  return out;
}

/** Fill settings stored by an older version with any newly added defaults. */
export function withDefaults(stored: unknown): Settings {
  if (!stored) return DEFAULT_SETTINGS;
  const r = mergeSettings(DEFAULT_SETTINGS, stored);
  return r.ok ? r.value : DEFAULT_SETTINGS;
}
