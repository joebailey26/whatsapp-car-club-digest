/**
 * Scheduling helpers (pure). Cloudflare cron triggers run in UTC, so the
 * weekly job has two crons (08:00 and 09:00 UTC on Sunday) and only the one
 * that is 09:00 in Europe/London acts. That keeps 09:00 local in GMT and BST.
 */

export const WEEKLY_CRONS = ['0 8 * * SUN', '0 9 * * SUN'] as const;
export const WATCHDOG_CRON = '30 6 * * *';

export interface LocalTime {
  date: string; // YYYY-MM-DD
  weekday: number; // 0 = Sunday
  hour: number;
  minute: number;
}

export function londonTime(d: Date): LocalTime {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(d);
  const g = (t: string): string => p.find((x) => x.type === t)?.value ?? '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday'));
  return { date: `${g('year')}-${g('month')}-${g('day')}`, weekday, hour: Number(g('hour')), minute: Number(g('minute')) };
}

/** True when `d` is the configured weekly slot in London (default Sunday 09:xx). */
export function isWeeklySlot(d: Date, weekday = 0, hour = 9): boolean {
  const t = londonTime(d);
  return t.weekday === weekday && t.hour === hour;
}

/** Next weekly slot strictly after `from`, as a UTC Date (searches hour by hour; at most 8 days). */
export function nextWeeklySlot(from: Date, weekday = 0, hour = 9): Date {
  const start = new Date(Math.floor(from.getTime() / 3_600_000) * 3_600_000 + 3_600_000);
  for (let i = 0; i < 24 * 8; i++) {
    const d = new Date(start.getTime() + i * 3_600_000);
    if (isWeeklySlot(d, weekday, hour)) return d;
  }
  throw new Error('no slot found');
}
