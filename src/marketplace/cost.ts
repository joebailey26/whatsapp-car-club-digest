import { z } from 'zod';

/**
 * Container usage accounting and the £0 incremental-spend guard (pure).
 *
 * Figures are from the Cloudflare Containers docs as read on 2026-11-25
 * (pricing page modified 2026-11-13). They are configuration, not constants,
 * because pricing and allowances can change: re-check the docs and the
 * dashboard before enabling the hourly schedule.
 *
 * Billing model: memory and disk are charged on the PROVISIONED size for as
 * long as the container runs; CPU only on active use. The allowance is shared
 * with the WhatsApp digest, so its monthly usage is reserved first.
 */

export interface InstanceSpec {
  vcpu: number;
  memGiB: number;
  diskGB: number;
}

export const INSTANCE_SPECS: Record<string, InstanceSpec> = {
  lite: { vcpu: 1 / 16, memGiB: 0.25, diskGB: 2 },
  basic: { vcpu: 0.25, memGiB: 1, diskGB: 4 },
  'standard-1': { vcpu: 0.5, memGiB: 4, diskGB: 8 },
  'standard-2': { vcpu: 1, memGiB: 6, diskGB: 12 },
  'standard-3': { vcpu: 2, memGiB: 8, diskGB: 16 },
  'standard-4': { vcpu: 4, memGiB: 12, diskGB: 20 },
};

const Usage = z.object({ memGiBHours: z.number().min(0), vcpuMinutes: z.number().min(0), diskGBHours: z.number().min(0) });
export type Usage = z.infer<typeof Usage>;

export const CostSchema = z.object({
  /** Workers Paid monthly included container allowance (account-wide). */
  included: Usage,
  /** Overage prices in USD. */
  usdPer: z.object({ memGiBSecond: z.number().min(0), vcpuSecond: z.number().min(0), diskGBSecond: z.number().min(0) }),
  gbpPerUsd: z.number().positive(),
  /** Reserved for the WhatsApp weekly digest and its restore tests (standard-2, ~4 min, ~4.35 runs/month, plus margin). */
  whatsappMonthly: Usage,
  /** Plan against this fraction of the allowance, leaving headroom for manual runs and drift. */
  safetyFraction: z.number().min(0.1).max(1),
  /** Warn (alert) once the projection passes this fraction of the allowance. */
  warnFraction: z.number().min(0.1).max(1),
  /** Disable the hourly schedule automatically when the projection breaks the budget. */
  autoDisable: z.boolean(),
  /** Measured runs needed before the schedule may be switched on. */
  minMeasuredRuns: z.number().int().min(1).max(50),
  /** When the container can't report CPU, assume this fraction of provisioned vCPU was busy. */
  assumedCpuUtilisation: z.number().min(0).max(1),
});
export type CostConfig = z.infer<typeof CostSchema>;

export const DEFAULT_COST: CostConfig = {
  included: { memGiBHours: 25, vcpuMinutes: 375, diskGBHours: 200 },
  usdPer: { memGiBSecond: 0.0000025, vcpuSecond: 0.00002, diskGBSecond: 0.00000007 },
  gbpPerUsd: 0.8,
  whatsappMonthly: { memGiBHours: 3, vcpuMinutes: 30, diskGBHours: 6 },
  safetyFraction: 0.9,
  warnFraction: 0.75,
  autoDisable: true,
  minMeasuredRuns: 3,
  assumedCpuUtilisation: 1,
};

export interface RunMeasurement {
  instance: string;
  billableMs: number;
  /** Container cgroup CPU time, when the container could read it. */
  cpuSeconds: number | null;
}

export function usageForRun(m: RunMeasurement, cfg: CostConfig): Usage {
  const spec = INSTANCE_SPECS[m.instance] ?? INSTANCE_SPECS['standard-2']!;
  const s = Math.max(0, m.billableMs) / 1000;
  const cpuS = m.cpuSeconds ?? spec.vcpu * s * cfg.assumedCpuUtilisation;
  return { memGiBHours: (spec.memGiB * s) / 3600, vcpuMinutes: cpuS / 60, diskGBHours: (spec.diskGB * s) / 3600 };
}

export function addUsage(a: Usage, b: Usage, times = 1): Usage {
  return { memGiBHours: a.memGiBHours + b.memGiBHours * times, vcpuMinutes: a.vcpuMinutes + b.vcpuMinutes * times, diskGBHours: a.diskGBHours + b.diskGBHours * times };
}

const ZERO: Usage = { memGiBHours: 0, vcpuMinutes: 0, diskGBHours: 0 };

export function overageUsd(u: Usage, cfg: CostConfig): number {
  const over = (used: number, inc: number): number => Math.max(0, used - inc);
  return (
    over(u.memGiBHours, cfg.included.memGiBHours) * 3600 * cfg.usdPer.memGiBSecond +
    over(u.vcpuMinutes, cfg.included.vcpuMinutes) * 60 * cfg.usdPer.vcpuSecond +
    over(u.diskGBHours, cfg.included.diskGBHours) * 3600 * cfg.usdPer.diskGBSecond
  );
}

/** Highest fraction of any one allowance that `u` uses (the binding constraint). */
export function allowanceFraction(u: Usage, cfg: CostConfig): { fraction: number; binding: keyof Usage } {
  const f: Array<[keyof Usage, number]> = [
    ['memGiBHours', u.memGiBHours / cfg.included.memGiBHours],
    ['vcpuMinutes', u.vcpuMinutes / cfg.included.vcpuMinutes],
    ['diskGBHours', u.diskGBHours / cfg.included.diskGBHours],
  ];
  f.sort((a, b) => b[1] - a[1]);
  return { fraction: f[0]![1], binding: f[0]![0] };
}

export interface Projection {
  measuredRuns: number;
  avgBillableSeconds: number | null;
  perRun: Usage | null;
  runsPerMonth: number;
  projectedMonthly: Usage;
  fractionOfAllowance: number;
  binding: keyof Usage;
  incrementalUsd: number;
  incrementalGbp: number;
  /** Max billable seconds per run that would still fit in budget on this instance. */
  maxSecondsPerRunWithinBudget: number | null;
  verdict: 'insufficient_data' | 'ok' | 'warn' | 'over_budget';
}

/**
 * Project a 30-day month from observed runs (never from assumed durations).
 * @param recent most recent measured runs (any trigger) on the instance being planned
 */
export function projectMonthly(recent: readonly RunMeasurement[], runsPerMonth: number, cfg: CostConfig, instance: string): Projection {
  const measured = recent.filter((r) => r.billableMs > 0);
  const base = cfg.whatsappMonthly;
  if (measured.length === 0) {
    const fr = allowanceFraction(base, cfg);
    return {
      measuredRuns: 0,
      avgBillableSeconds: null,
      perRun: null,
      runsPerMonth,
      projectedMonthly: base,
      fractionOfAllowance: fr.fraction,
      binding: fr.binding,
      incrementalUsd: 0,
      incrementalGbp: 0,
      maxSecondsPerRunWithinBudget: maxSeconds(instance, runsPerMonth, cfg, null),
      verdict: 'insufficient_data',
    };
  }
  const per = measured.reduce<Usage>((acc, m) => addUsage(acc, usageForRun(m, cfg)), ZERO);
  const n = measured.length;
  const perRun: Usage = { memGiBHours: per.memGiBHours / n, vcpuMinutes: per.vcpuMinutes / n, diskGBHours: per.diskGBHours / n };
  const projected = addUsage(base, perRun, runsPerMonth);
  const fr = allowanceFraction(projected, cfg);
  const usd = overageUsd(projected, cfg);
  const cpuShare = measured.every((m) => m.cpuSeconds !== null)
    ? measured.reduce((a, m) => a + m.cpuSeconds! / Math.max(1, m.billableMs / 1000), 0) / n
    : null;
  let verdict: Projection['verdict'] = 'ok';
  if (n < cfg.minMeasuredRuns) verdict = 'insufficient_data';
  if (usd > 0 || fr.fraction > cfg.safetyFraction) verdict = 'over_budget';
  else if (verdict === 'ok' && fr.fraction > cfg.warnFraction) verdict = 'warn';
  return {
    measuredRuns: n,
    avgBillableSeconds: measured.reduce((a, m) => a + m.billableMs, 0) / n / 1000,
    perRun,
    runsPerMonth,
    projectedMonthly: projected,
    fractionOfAllowance: fr.fraction,
    binding: fr.binding,
    incrementalUsd: usd,
    incrementalGbp: usd * cfg.gbpPerUsd,
    maxSecondsPerRunWithinBudget: maxSeconds(instance, runsPerMonth, cfg, cpuShare),
    verdict,
  };
}

/** Longest run (seconds) on `instance` that keeps every allowance within the safety fraction. */
function maxSeconds(instance: string, runsPerMonth: number, cfg: CostConfig, cpuPerSecond: number | null): number | null {
  const spec = INSTANCE_SPECS[instance];
  if (!spec || runsPerMonth <= 0) return null;
  const room = (inc: number, used: number): number => Math.max(0, inc * cfg.safetyFraction - used);
  const cpuRate = cpuPerSecond ?? spec.vcpu * cfg.assumedCpuUtilisation;
  const limits = [
    (room(cfg.included.memGiBHours, cfg.whatsappMonthly.memGiBHours) * 3600) / (spec.memGiB * runsPerMonth),
    cpuRate > 0 ? (room(cfg.included.vcpuMinutes, cfg.whatsappMonthly.vcpuMinutes) * 60) / (cpuRate * runsPerMonth) : Infinity,
    (room(cfg.included.diskGBHours, cfg.whatsappMonthly.diskGBHours) * 3600) / (spec.diskGB * runsPerMonth),
  ];
  return Math.floor(Math.min(...limits));
}

/** Month-to-date guard: actual marketplace usage plus the WhatsApp reservation already beyond the budget. */
export function monthToDateOverBudget(mtdMarketplace: Usage, cfg: CostConfig): boolean {
  const total = addUsage(cfg.whatsappMonthly, mtdMarketplace);
  return overageUsd(total, cfg) > 0 || allowanceFraction(total, cfg).fraction > cfg.safetyFraction;
}

export function sumUsage(runs: readonly RunMeasurement[], cfg: CostConfig): Usage {
  return runs.reduce<Usage>((acc, m) => addUsage(acc, usageForRun(m, cfg)), ZERO);
}
