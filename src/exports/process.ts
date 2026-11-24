import { normalise, inWindow, zonedTimeToUtc, type NormalisedMessage } from './normalise';
import { parseTranscript, ParseError, type DateOrder } from './parser';
import { sha256Hex, type ExportRecord } from './store';
import { listEntries, pickTranscript, readEntry, ZipError } from './zip';

/**
 * Processes one stored export: R2 zip → transcript → normalised messages →
 * window filter → deduplicate against D1 → messages.json in R2 + metadata in D1.
 *
 * Idempotent: reprocessing the same export gives the same counts. A message
 * first seen in this export still counts as new for it, and a stored
 * export is never re-downloaded from WhatsApp.
 */

export interface ProcessDeps {
  r2: R2Bucket;
  db: D1Database;
  pseudonymKey: CryptoKey;
  /** Timezone of wall-clock times in the export (the container's TZ; UTC for image 0.2.0). */
  exportTimeZone: string;
  /** Date order to assume when a transcript is ambiguous (container locale en-US → MDY). */
  dateOrderHint: DateOrder;
  now?: Date;
  /** Backfill: start the window at this date (YYYY-MM-DD, Europe/London) instead of the export's dateFrom. */
  windowFrom?: string;
}

export type ProcessingStatus = 'processed' | 'empty' | 'failed' | 'not_applicable';

export interface ProcessResult {
  exportId: string;
  groupId: string;
  status: ProcessingStatus;
  errorCode: string | null;
  messagesTotal: number;
  messagesInWindow: number;
  messagesNew: number;
  messagesDuplicate: number;
  invalidDates: number;
  dateOrder: DateOrder | null;
  dateOrderAmbiguous: boolean;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  messagesKey: string | null;
}

export const SEEN_RETENTION_DAYS = 60;

export async function processExport(rec: ExportRecord, deps: ProcessDeps): Promise<ProcessResult> {
  const now = deps.now ?? new Date();
  const base: ProcessResult = {
    exportId: rec.id,
    groupId: rec.groupId,
    status: 'failed',
    errorCode: null,
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
  };

  await upsertExportRow(deps.db, rec);
  if (rec.status !== 'succeeded' || !rec.r2Key) {
    const r = { ...base, status: 'not_applicable' as const };
    await saveProcessing(deps.db, r, now);
    return r;
  }

  let result: ProcessResult;
  try {
    result = await run(rec, deps, base);
  } catch (err) {
    const code = err instanceof ZipError || err instanceof ParseError || err instanceof ProcessError ? err.code : 'PROCESSING_ERROR';
    result = { ...base, status: 'failed', errorCode: code };
  }
  await saveProcessing(deps.db, result, now);
  await deps.db
    .prepare('DELETE FROM messages_seen WHERE ts < ?')
    .bind(new Date(now.getTime() - SEEN_RETENTION_DAYS * 86_400_000).toISOString())
    .run();
  return result;
}

class ProcessError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

async function run(rec: ExportRecord, deps: ProcessDeps, base: ProcessResult): Promise<ProcessResult> {
  const obj = await deps.r2.get(rec.r2Key!);
  if (!obj) throw new ProcessError('EXPORT_OBJECT_MISSING');
  const zipBytes = await obj.arrayBuffer();
  if (rec.sha256 && (await sha256Hex(zipBytes)) !== rec.sha256) throw new ProcessError('EXPORT_CHECKSUM_MISMATCH');

  const buf = new Uint8Array(zipBytes);
  let transcriptBytes: Uint8Array;
  if (rec.kind === 'text') {
    transcriptBytes = buf;
  } else {
    const entries = listEntries(buf);
    transcriptBytes = await readEntry(buf, pickTranscript(entries));
  }
  const text = new TextDecoder('utf-8').decode(transcriptBytes).replace(/^﻿/, '');

  const parsed = parseTranscript(text, deps.dateOrderHint);
  const norm = await normalise(parsed.messages, {
    groupId: rec.groupId,
    exportId: rec.id,
    dateOrder: parsed.dateOrder,
    exportTimeZone: deps.exportTimeZone,
    pseudonymKey: deps.pseudonymKey,
  });

  const fromIso = deps.windowFrom ? windowStartIso(deps.windowFrom) : rec.dateFrom ? windowStartIso(rec.dateFrom) : '0000';
  const win = inWindow(norm.messages, fromIso);
  const { newIds, duplicates } = await dedupe(deps.db, rec, win);

  const ts = norm.messages.map((m) => m.timestamp).sort();
  const key = rec.r2Key!.replace(/original\.[a-z]+$/, 'messages.json');
  const payload = {
    schema: 1,
    exportId: rec.id,
    groupId: rec.groupId,
    window: { from: fromIso, dateFrom: rec.dateFrom, dateTo: rec.dateTo },
    generatedAt: new Date().toISOString(),
    dateOrder: parsed.dateOrder,
    dateOrderAmbiguous: parsed.dateOrderAmbiguous,
    exportTimeZone: deps.exportTimeZone,
    messages: win.map((m) => ({ ...m, isNew: newIds.has(m.id) })),
  };
  await deps.r2.put(key, JSON.stringify(payload), { httpMetadata: { contentType: 'application/json' } });

  return {
    ...base,
    status: win.length === 0 ? 'empty' : 'processed',
    messagesTotal: norm.messages.length,
    messagesInWindow: win.length,
    messagesNew: newIds.size,
    messagesDuplicate: duplicates,
    invalidDates: norm.invalidDates,
    dateOrder: parsed.dateOrder,
    dateOrderAmbiguous: parsed.dateOrderAmbiguous,
    firstMessageAt: ts[0] ?? null,
    lastMessageAt: ts[ts.length - 1] ?? null,
    messagesKey: key,
  };
}

/** Midnight Europe/London on dateFrom, as UTC ISO. */
export function windowStartIso(dateFrom: string): string {
  const [y, m, d] = dateFrom.split('-').map(Number) as [number, number, number];
  return new Date(zonedTimeToUtc(y, m, d, 0, 0, 0, 'Europe/London')).toISOString();
}

async function dedupe(db: D1Database, rec: ExportRecord, msgs: readonly NormalisedMessage[]): Promise<{ newIds: Set<string>; duplicates: number }> {
  const existing = new Map<string, string>(); // id → first export_id
  for (let i = 0; i < msgs.length; i += 80) {
    const chunk = msgs.slice(i, i + 80).map((m) => m.id);
    const rows = await db
      .prepare(`SELECT id, export_id FROM messages_seen WHERE id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk)
      .all<{ id: string; export_id: string }>();
    for (const r of rows.results) existing.set(r.id, r.export_id);
  }
  const newIds = new Set<string>();
  let duplicates = 0;
  const inserts: D1PreparedStatement[] = [];
  const now = new Date().toISOString();
  const stmt = db.prepare('INSERT OR IGNORE INTO messages_seen (id, group_id, ts, export_id, first_seen_at) VALUES (?, ?, ?, ?, ?)');
  for (const m of msgs) {
    const first = existing.get(m.id);
    if (first === undefined) {
      newIds.add(m.id);
      inserts.push(stmt.bind(m.id, m.groupId, m.timestamp, rec.id, now));
    } else if (first === rec.id) {
      newIds.add(m.id); // reprocessing the export that first introduced it
    } else {
      duplicates++;
    }
  }
  for (let i = 0; i < inserts.length; i += 100) await db.batch(inserts.slice(i, i + 100));
  return { newIds, duplicates };
}

async function upsertExportRow(db: D1Database, rec: ExportRecord): Promise<void> {
  await db
    .prepare(
      `INSERT INTO exports (id, run_id, group_id, date_from, date_to, r2_key, checksum, bytes, status, error_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET status = excluded.status, error_code = excluded.error_code,
         r2_key = excluded.r2_key, checksum = excluded.checksum, bytes = excluded.bytes`,
    )
    .bind(rec.id, rec.runId, rec.groupId, rec.dateFrom || null, rec.dateTo || null, rec.r2Key, rec.sha256, rec.bytes, rec.status, rec.errorCode, rec.startedAt)
    .run();
}

async function saveProcessing(db: D1Database, r: ProcessResult, now: Date): Promise<void> {
  await db
    .prepare(
      `UPDATE exports SET processing_status = ?, processing_error = ?, processed_at = ?, messages_total = ?, messages_in_window = ?,
         messages_new = ?, messages_duplicate = ?, invalid_dates = ?, date_order = ?, date_order_ambiguous = ?,
         first_message_at = ?, last_message_at = ?, messages_r2_key = ?
       WHERE id = ?`,
    )
    .bind(
      r.status,
      r.errorCode,
      now.toISOString(),
      r.messagesTotal,
      r.messagesInWindow,
      r.messagesNew,
      r.messagesDuplicate,
      r.invalidDates,
      r.dateOrder,
      r.dateOrderAmbiguous ? 1 : 0,
      r.firstMessageAt,
      r.lastMessageAt,
      r.messagesKey,
      r.exportId,
    )
    .run();
}
