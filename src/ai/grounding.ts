import type { Candidate } from './schema';

/**
 * Hallucination controls. After schema validation, every factual field must be
 * traceable to the text of the cited source messages, or it is set to null and
 * flagged. Dates may be relative ("Sunday", "tomorrow"); they are resolved
 * against the message's own timestamp in Europe/London.
 *
 * This is deliberately conservative: a missing detail is better than an invented one.
 */

export interface SourceMessage {
  ref: string; // "m12"
  id: string; // real message id
  exportId: string;
  timestamp: string; // UTC ISO
  author?: string | null;
  text: string;
}

export type GroundingFlag =
  | 'ungrounded_date'
  | 'ungrounded_time'
  | 'ungrounded_location'
  | 'ungrounded_meeting_point'
  | 'ungrounded_price'
  | 'ungrounded_rsvp'
  | 'ungrounded_deadline'
  | 'dropped_unknown_refs';

export interface Grounded {
  candidate: Candidate;
  sources: SourceMessage[];
  flags: GroundingFlag[];
  /** Original values of fields removed by grounding (diagnostics; never shown in the digest). */
  removed: Record<string, string | boolean>;
}

export type GroundingResult = { ok: true; value: Grounded } | { ok: false; reason: string };

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'meet', 'meeting', 'point', 'car', 'cars', 'park', 'near', 'at', 'on', 'in', 'of', 'to', 'a', 'an', 'area', 'road', 'usual', 'place']);
const CANCEL_WORDS = /\b(cancel+ed|cancel+ing|cancel|called off|call(ing)? it off|postponed?|not happening|won'?t be happening|is off|no longer|scrapped|rescheduled)\b/i;
const RSVP_WORDS = /\b(rsvp|confirm|let (me|us) know|names? (down|in|to (me|us|the organi[sz]er))|(limited|few|only \d+) (spaces|places|tickets)|spaces? (left|remaining)|sign[- ]?up|book(ing|ed)?|tickets?|register|registration|who'?s (in|coming|going)|attending|reply|count me|put your name|headcount|numbers)\b/i;

/**
 * Messages that read like attempts to instruct an AI. They stay in the chat
 * context, but a candidate supported ONLY by such messages is rejected,
 * whatever the model says (seen: GLM-4.7-flash obeyed one in evaluation).
 */
export const INJECTION = new RegExp(
  [
    'ignore (all |any )?(the )?(previous|prior|above|earlier) (instructions|prompts?|rules)',
    'disregard (all |the )?(previous|prior|above) ',
    'you are now (in )?',
    '(system|developer) (prompt|message|mode)',
    'admin mode',
    'new instructions:',
    'output (an|the following|this) (event|json)',
    'jailbreak',
  ].join('|'),
  'i',
);

export function ukDateOf(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
  const g = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')}`;
}

function addDays(isoDate: string, n: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** All calendar dates a message's text could plausibly be referring to. */
export function dateMentions(text: string, sentAtIso: string): Set<string> {
  const t = text.toLowerCase();
  const sent = ukDateOf(sentAtIso);
  const year = Number(sent.slice(0, 4));
  const out = new Set<string>();
  if (/\b(today|tonight|this (morning|afternoon|evening))\b/.test(t)) out.add(sent);
  if (/\b(tomorrow|tmrw|tmw)\b/.test(t)) out.add(addDays(sent, 1));
  const dow = new Date(`${sent}T12:00:00Z`).getUTCDay();
  WEEKDAYS.forEach((name, i) => {
    const re = new RegExp(`\\b(${name}|${name.slice(0, 3)})\\b`);
    if (re.test(t)) {
      const ahead = (i - dow + 7) % 7;
      out.add(addDays(sent, ahead)); // this <day> (or today)
      out.add(addDays(sent, ahead + 7)); // next <day>
    }
  });
  if (/\b(this|next) weekend\b|\bweekend\b/.test(t)) {
    const toSat = (6 - dow + 7) % 7;
    for (const base of [toSat, toSat + 7]) {
      out.add(addDays(sent, base));
      out.add(addDays(sent, base + 1));
    }
  }
  // "21st November", "21 Nov", "November 21"
  MONTHS.forEach((name, mi) => {
    const mon = `(${name}|${name.slice(0, 3)})`;
    for (const re of [new RegExp(`\\b(\\d{1,2})(st|nd|rd|th)?\\s+(of\\s+)?${mon}\\b`, 'g'), new RegExp(`\\b${mon}\\s+(\\d{1,2})(st|nd|rd|th)?\\b`, 'g')]) {
      for (const m of t.matchAll(re)) {
        const day = Number(m[1]?.match(/^\d+$/) ? m[1] : m[2]);
        if (day >= 1 && day <= 31) {
          for (const y of [year, year + 1]) out.add(`${y}-${String(mi + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
        }
      }
    }
  });
  // Day-only ordinals "on the 6th", "the 21st": this month if still ahead, else next month.
  for (const m of t.matchAll(/\bthe\s+(\d{1,2})(st|nd|rd|th)\b(?!\s+(of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/g)) {
    const day = Number(m[1]);
    if (day < 1 || day > 31) continue;
    const [sy, sm, sd] = sent.split('-').map(Number) as [number, number, number];
    const [y, mo] = day >= sd ? [sy, sm] : sm === 12 ? [sy + 1, 1] : [sy, sm + 1];
    out.add(`${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  }
  // Numeric UK dates "21/11", "21/11/26", "21.11.2026"
  for (const m of t.matchAll(/\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?\b/g)) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) {
      const ys = m[3] ? [Number(m[3].length === 2 ? `20${m[3]}` : m[3])] : [year, year + 1];
      for (const y of ys) out.add(`${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    }
  }
  return out;
}

/** All HH:MM times a text could be referring to. */
export function timeMentions(text: string): Set<string> {
  const t = text.toLowerCase();
  const out = new Set<string>();
  const add = (h: number, m: number): void => {
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) out.add(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  };
  if (/\b(noon|midday)\b/.test(t)) add(12, 0);
  if (/\bmidnight\b/.test(t)) add(0, 0);
  for (const m of t.matchAll(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)/g)) {
    let h = Number(m[1]);
    const min = m[2] ? Number(m[2]) : 0;
    const pm = m[3]!.startsWith('p');
    if (h >= 1 && h <= 12) {
      h = (h % 12) + (pm ? 12 : 0);
      add(h, min);
    }
  }
  for (const m of t.matchAll(/\b(\d{1,2})[:.](\d{2})\b/g)) {
    const h = Number(m[1]);
    add(h, Number(m[2]));
    if (h < 12) add(h + 12, Number(m[2]));
  }
  for (const m of t.matchAll(/\b(\d{2})(\d{2})\s*(hrs|hours|h)\b/g)) add(Number(m[1]), Number(m[2]));
  // bare hour only after "at"/"from"/"for"/"by", e.g. "at 10", "from 9"
  for (const m of t.matchAll(/\b(at|from|for|by|around|about|approx|~)\s+(\d{1,2})\b(?![:./\d])/g)) {
    const h = Number(m[2]);
    if (h >= 1 && h <= 12) {
      add(h, 0);
      add(h + 12 === 24 ? 12 : h + 12, 0);
    } else add(h, 0);
  }
  return out;
}

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

/** A place name is grounded if one of its significant words appears in the sources. */
export function placeGrounded(value: string, sourceText: string): boolean {
  const src = new Set(tokens(sourceText));
  const vt = tokens(value);
  return vt.length > 0 && vt.some((w) => src.has(w));
}

export function priceGrounded(value: string, sourceText: string): boolean {
  const nums = value.match(/\d+(?:\.\d{1,2})?/g);
  if (!nums) return /\bfree\b/i.test(value) && /\bfree\b/i.test(sourceText);
  return nums.every((n) => new RegExp(`(£|\\$|€)\\s?${n.replace('.', '\\.')}\\b|\\b${n.replace('.', '\\.')}\\s?(quid|pounds?|gbp|p)\\b`, 'i').test(sourceText));
}

export function ground(c: Candidate, byRef: ReadonlyMap<string, SourceMessage>): GroundingResult {
  const flags: GroundingFlag[] = [];
  const sources = c.sourceRefs.map((r) => byRef.get(r)).filter((s): s is SourceMessage => !!s);
  if (sources.length === 0) return { ok: false, reason: 'NO_VALID_SOURCES' };
  if (sources.length < c.sourceRefs.length) flags.push('dropped_unknown_refs');
  if (sources.every((s) => INJECTION.test(s.text))) return { ok: false, reason: 'SUSPECTED_INJECTION' };

  const text = sources.map((s) => s.text).join('\n');
  const out: Candidate = { ...c, sourceRefs: sources.map((s) => s.ref) };
  const removed: Record<string, string | boolean> = {};

  if (c.kind === 'cancellation' || c.status === 'cancelled') {
    if (!CANCEL_WORDS.test(text)) return { ok: false, reason: 'CANCELLATION_NOT_IN_SOURCES' };
  }

  const dateOk = (d: string): boolean => sources.some((s) => dateMentions(s.text, s.timestamp).has(d));
  if (out.date && !dateOk(out.date)) {
    removed.date = out.date;
    out.date = null;
    flags.push('ungrounded_date');
  }
  if (out.rsvpDeadline && !dateOk(out.rsvpDeadline)) {
    removed.rsvpDeadline = out.rsvpDeadline;
    out.rsvpDeadline = null;
    flags.push('ungrounded_deadline');
  }
  if (out.startTime && !sources.some((s) => timeMentions(s.text).has(out.startTime!))) {
    removed.startTime = out.startTime;
    out.startTime = null;
    flags.push('ungrounded_time');
  }
  if (out.location && !placeGrounded(out.location, text)) {
    removed.location = out.location;
    out.location = null;
    flags.push('ungrounded_location');
  }
  if (out.meetingPoint && !placeGrounded(out.meetingPoint, text)) {
    removed.meetingPoint = out.meetingPoint;
    out.meetingPoint = null;
    flags.push('ungrounded_meeting_point');
  }
  if (out.price && !priceGrounded(out.price, text)) {
    removed.price = out.price;
    out.price = null;
    flags.push('ungrounded_price');
  }
  if (out.rsvpRequired && !RSVP_WORDS.test(text)) {
    removed.rsvpRequired = true;
    out.rsvpRequired = false;
    flags.push('ungrounded_rsvp');
  }
  return { ok: true, value: { candidate: out, sources, flags, removed } };
}
