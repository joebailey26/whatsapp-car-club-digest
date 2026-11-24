import { calendarDate, type DateOrder, type RawMessage } from './parser';

/**
 * Turns parsed transcript lines into normalised messages:
 *  - wall-clock export time → UTC ISO (the export timezone is configurable;
 *    the 0.2.0 container exports in UTC)
 *  - phone-number authors → stable pseudonyms (HMAC, keyed by a Worker secret)
 *  - deterministic message IDs, stable across overlapping exports
 */

export interface NormalisedMessage {
  id: string;
  groupId: string;
  author: string | null; // display name, pseudonym or null (system message)
  authorIsPseudonym: boolean;
  timestamp: string; // UTC ISO 8601
  text: string;
  attachment: boolean;
  system: boolean;
  sourceExport: string; // export id
  sourceLine: number;
}

export interface NormaliseOptions {
  groupId: string;
  exportId: string;
  dateOrder: DateOrder;
  /** IANA zone the export's wall-clock times are in. */
  exportTimeZone: string;
  pseudonymKey: CryptoKey;
}

export interface NormaliseResult {
  messages: NormalisedMessage[];
  /** Messages dropped because their date was impossible under the detected order. */
  invalidDates: number;
}

const PHONE = /^\+?[\d\s().-]{7,20}$/;

export function isPhoneAuthor(author: string): boolean {
  const digits = author.replace(/\D/g, '');
  return PHONE.test(author) && digits.length >= 7;
}

export async function importPseudonymKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 32) throw new Error('PSEUDONYM_KEY_MISSING');
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function hmacHex(key: CryptoKey, data: string, chars: number): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, chars);
}

async function sha256Hex(data: string, chars: number): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, chars);
}

/** "Member 3fa9c2": same number → same pseudonym within a group, unlinkable across groups. */
export async function pseudonymFor(key: CryptoKey, groupId: string, phone: string): Promise<string> {
  const digits = phone.replace(/\D/g, '');
  return `Member ${await hmacHex(key, `${groupId}\u0000${digits}`, 6)}`;
}

/**
 * Convert a wall-clock time in `timeZone` to a UTC epoch (ms). Uses Intl to
 * find the zone offset, iterating once to handle DST transitions. Times that
 * fall in a spring-forward gap resolve to the later offset.
 */
export function zonedTimeToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, timeZone: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  if (timeZone === 'UTC' || timeZone === 'Etc/UTC') return guess;
  const offset = (t: number): number => {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(t));
    const g = (k: string): number => Number(parts.find((p) => p.type === k)?.value);
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - t;
  };
  let t = guess - offset(guess);
  t = guess - offset(t);
  return t;
}

export function normaliseText(s: string): string {
  return s.normalize('NFC').replace(/[ \t]+$/gm, '').trim();
}

export async function normalise(raw: readonly RawMessage[], o: NormaliseOptions): Promise<NormaliseResult> {
  const out: NormalisedMessage[] = [];
  const seen = new Map<string, number>();
  const pseudonyms = new Map<string, string>();
  let invalid = 0;

  for (const m of raw) {
    const date = calendarDate(m, o.dateOrder);
    if (!date) {
      invalid++;
      continue;
    }
    const ts = new Date(zonedTimeToUtc(date.year, date.month, date.day, m.hour, m.minute, m.second, o.exportTimeZone)).toISOString();

    let author: string | null = m.author ? m.author.normalize('NFC').trim() : null;
    let pseudo = false;
    if (author && isPhoneAuthor(author)) {
      const cached = pseudonyms.get(author);
      const p = cached ?? (await pseudonymFor(o.pseudonymKey, o.groupId, author));
      pseudonyms.set(author, p);
      author = p;
      pseudo = true;
    }
    const text = normaliseText(m.text);

    // Identical (group, time, author, text) tuples are numbered in order, so a
    // genuinely repeated message ("👍" twice in one second) keeps both copies
    // while the same message in an overlapping export maps to the same ID.
    const key = JSON.stringify([o.groupId, ts, author, text]);
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    const id = await sha256Hex(`${key}#${n}`, 32);

    out.push({
      id,
      groupId: o.groupId,
      author,
      authorIsPseudonym: pseudo,
      timestamp: ts,
      text,
      attachment: m.attachment,
      system: m.author === null,
      sourceExport: o.exportId,
      sourceLine: m.line,
    });
  }
  return { messages: out, invalidDates: invalid };
}

/** Keep messages at or after the window start (UTC ISO comparison). */
export function inWindow(messages: readonly NormalisedMessage[], fromIso: string): NormalisedMessage[] {
  return messages.filter((m) => m.timestamp >= fromIso);
}
