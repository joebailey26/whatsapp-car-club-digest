import type { Step } from './schema';

/**
 * Placeholder rendering for flow steps.
 *
 *   {{groupName}}     exact WhatsApp display name (for typing into search)
 *   {{groupNameCss}}  same, escaped for use inside a double-quoted CSS attribute value
 *   {{dateFromUk}} {{dateToUk}}    DD/MM/YYYY (Europe/London)
 *   {{dateFromIso}} {{dateToIso}}  YYYY-MM-DD
 *
 * Unknown placeholders are an error, never silently left in.
 */

export type TemplateVars = Record<string, string>;

const PLACEHOLDER = /\{\{([A-Za-z]+)\}\}/g;

export function cssString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ');
}

export function renderString(s: string, vars: TemplateVars): string {
  return s.replace(PLACEHOLDER, (_m, name: string) => {
    const v = vars[name];
    if (v === undefined) throw new Error(`UNKNOWN_PLACEHOLDER:${name}`);
    return v;
  });
}

export function renderSteps(steps: readonly Step[], vars: TemplateVars): Step[] {
  return steps.map((s) => {
    const out: Record<string, unknown> = { ...s };
    for (const k of ['selector', 'text'] as const) {
      if (typeof out[k] === 'string') out[k] = renderString(out[k] as string, vars);
    }
    return out as Step;
  });
}

export interface DateRange {
  from: Date;
  to: Date;
}

/**
 * Export window: from the previous successful export's end date minus a
 * one-day overlap, or the last `defaultDays` days for a first export.
 * Overlap is deduplicated during processing (Phase 3).
 */
export function exportRange(now: Date, lastSuccessTo: string | null, defaultDays = 7): DateRange {
  const to = startOfUkDay(now);
  let from: Date;
  if (lastSuccessTo) {
    from = new Date(Date.parse(`${lastSuccessTo}T00:00:00Z`) - 86_400_000);
  } else {
    from = new Date(to.getTime() - defaultDays * 86_400_000);
  }
  if (from > to) from = to;
  return { from, to };
}

/** Midnight UTC of the calendar date in Europe/London. */
export function startOfUkDay(d: Date): Date {
  return new Date(`${ukIsoDate(d)}T00:00:00Z`);
}

export function ukIsoDate(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function varsFor(groupName: string, range: DateRange): TemplateVars {
  const iso = (d: Date): string => d.toISOString().slice(0, 10);
  const uk = (d: Date): string => {
    const [y, m, day] = iso(d).split('-');
    return `${day}/${m}/${y}`;
  };
  return {
    groupName,
    groupNameCss: cssString(groupName),
    dateFromIso: iso(range.from),
    dateToIso: iso(range.to),
    dateFromUk: uk(range.from),
    dateToUk: uk(range.to),
  };
}
