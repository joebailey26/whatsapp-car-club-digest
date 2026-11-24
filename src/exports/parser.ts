/**
 * WhatsApp chat-export transcript parser.
 *
 * Observed format (WhatsApp Web export, container locale en-US, 2026-11-23):
 *   [11/9/26, 5:07:43 PM] +44 7700 900123: message text
 *   continuation line of the same message
 * Also supported (fixtures / other exporters):
 *   [23/11/2026, 17:07:43] Name: text           (bracketed, 24h)
 *   23/11/2026, 17:07 - Name: text              (Android)
 *   11/23/26, 5:07 PM - Name: text              (Android, en-US)
 *
 * Date order (D/M vs M/D) is detected per file. When no component exceeds 12
 * the file is ambiguous; the caller's hint decides and the result is flagged.
 * Times are wall-clock in the exporting device's timezone; conversion to UTC
 * happens in normalise.ts.
 */

export type DateOrder = 'DMY' | 'MDY';

export interface RawMessage {
  /** 1-based line number of the header line, for provenance. */
  line: number;
  a: number; // first date component
  b: number; // second date component
  year: number;
  hour: number; // 0-23
  minute: number;
  second: number;
  author: string | null; // null for system messages
  text: string;
  attachment: boolean;
}

export interface ParseResult {
  messages: RawMessage[];
  dateOrder: DateOrder;
  dateOrderAmbiguous: boolean;
  /** Lines before the first message header (e.g. the encryption notice). */
  preambleLines: number;
  /** Header-like lines that failed validation (bad date/time); kept as continuation text. */
  rejectedHeaders: number;
  format: 'bracketed' | 'dash' | 'none';
}

export class ParseError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ParseError';
  }
}

export const PARSE_LIMITS = { maxBytes: 50 * 1024 * 1024, maxLines: 500_000, maxMessageChars: 20_000 };

const INVISIBLE = /[‎‏‪-‮⁦-⁩﻿]/g;
const SPACE = '[ \\u00a0\\u202f]';
const TIME = `(\\d{1,2}):(\\d{2})(?::(\\d{2}))?(?:${SPACE}?([AaPp])\\.?\\s?[Mm]\\.?)?`;
const DATE = '(\\d{1,2})[/.\\-](\\d{1,2})[/.\\-](\\d{2}|\\d{4})';
const BRACKETED = new RegExp(`^\\[${DATE},?${SPACE}${TIME}\\]${SPACE}(.*)$`, 's');
const DASH = new RegExp(`^${DATE},?${SPACE}${TIME}${SPACE}[-–]${SPACE}(.*)$`, 's');

const ATTACHMENT = /^<(attached: .+|Media omitted|[^>]*omitted)>$|^(image|video|audio|sticker|GIF|document) omitted$|\.(jpe?g|png|webp|mp4|opus|pdf|vcf) \(file attached\)$/i;

interface Header {
  a: number;
  b: number;
  year: number;
  hour: number;
  minute: number;
  second: number;
  rest: string;
  kind: 'bracketed' | 'dash';
}

function matchHeader(line: string): Header | null {
  const m = BRACKETED.exec(line) ?? DASH.exec(line);
  if (!m) return null;
  const kind = line.startsWith('[') ? 'bracketed' : 'dash';
  const [, a, b, y, hh, mm, ss, ampm, rest] = m;
  let hour = Number(hh);
  const minute = Number(mm);
  const second = ss ? Number(ss) : 0;
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    const pm = ampm.toLowerCase() === 'p';
    hour = (hour % 12) + (pm ? 12 : 0);
  }
  if (hour > 23 || minute > 59 || second > 59) return null;
  let year = Number(y);
  if (y!.length === 2) year += 2000;
  const na = Number(a);
  const nb = Number(b);
  if (na < 1 || nb < 1 || na > 31 || nb > 31) return null;
  return { a: na, b: nb, year, hour, minute, second, rest: rest ?? '', kind };
}

/** Split "Author: text". System lines have no author. */
function splitAuthor(rest: string): { author: string | null; text: string } {
  const i = rest.indexOf(': ');
  if (i > 0 && i <= 60) {
    const author = rest.slice(0, i).trim();
    // System notices ("X changed the subject to: …") contain verbs and are long-ish; authors are names or numbers.
    if (author && !/\b(changed|added|removed|left|joined|created|pinned|deleted|turned|set|updated|was)\b/i.test(author)) {
      return { author, text: rest.slice(i + 2) };
    }
  }
  if (rest.endsWith(':') && rest.length <= 61 && !rest.includes(' changed ')) {
    // "Author:" with empty text (e.g. a deleted message stub)
    return { author: rest.slice(0, -1).trim(), text: '' };
  }
  return { author: null, text: rest };
}

export function parseTranscript(input: string, hint: DateOrder): ParseResult {
  if (input.length > PARSE_LIMITS.maxBytes) throw new ParseError('TRANSCRIPT_TOO_LARGE');
  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > PARSE_LIMITS.maxLines) throw new ParseError('TRANSCRIPT_TOO_MANY_LINES');

  const messages: RawMessage[] = [];
  let preamble = 0;
  let rejected = 0;
  let format: ParseResult['format'] = 'none';
  let maxA = 0;
  let maxB = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(INVISIBLE, '');
    const h = line.length >= 10 ? matchHeader(line) : null;
    if (h) {
      if (format === 'none') format = h.kind;
      maxA = Math.max(maxA, h.a);
      maxB = Math.max(maxB, h.b);
      const { author, text } = splitAuthor(h.rest);
      messages.push({
        line: i + 1,
        a: h.a,
        b: h.b,
        year: h.year,
        hour: h.hour,
        minute: h.minute,
        second: h.second,
        author,
        text,
        attachment: ATTACHMENT.test(text.trim()),
      });
      continue;
    }
    if (/^\[?\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}/.test(line)) rejected++;
    const last = messages[messages.length - 1];
    if (!last) {
      if (line.trim()) preamble++;
      continue;
    }
    if (last.text.length < PARSE_LIMITS.maxMessageChars) last.text += `\n${line}`;
  }

  let dateOrder: DateOrder;
  let ambiguous = false;
  if (maxA > 12 && maxB > 12) throw new ParseError('INCONSISTENT_DATE_ORDER');
  if (maxA > 12) dateOrder = 'DMY';
  else if (maxB > 12) dateOrder = 'MDY';
  else {
    dateOrder = hint;
    ambiguous = messages.length > 0;
  }

  for (const m of messages) {
    m.text = m.text.replace(/\n+$/, '');
    if (m.text.length > PARSE_LIMITS.maxMessageChars) m.text = `${m.text.slice(0, PARSE_LIMITS.maxMessageChars)}…`;
  }
  return { messages, dateOrder, dateOrderAmbiguous: ambiguous, preambleLines: preamble, rejectedHeaders: rejected, format };
}

/** Calendar date of a raw message under the detected order; null if invalid (e.g. 31/02). */
export function calendarDate(m: RawMessage, order: DateOrder): { year: number; month: number; day: number } | null {
  const [day, month] = order === 'DMY' ? [m.a, m.b] : [m.b, m.a];
  if (month < 1 || month > 12) return null;
  const dim = new Date(Date.UTC(m.year, month, 0)).getUTCDate();
  if (day < 1 || day > dim) return null;
  return { year: m.year, month, day };
}
