import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { importPseudonymKey, isPhoneAuthor, normalise, zonedTimeToUtc } from '../src/exports/normalise';
import { parseTranscript, ParseError } from '../src/exports/parser';
import { processExport, windowStartIso, type ProcessDeps } from '../src/exports/process';
import { sha256Hex, type ExportRecord } from '../src/exports/store';
import { isSafeName, listEntries, pickTranscript, readEntry, ZipError } from '../src/exports/zip';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fx = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');
const KEY = 'k'.repeat(64);

// ─── tiny ZIP writer for tests (CRC not validated by the reader) ───
function makeZip(files: Array<{ name: string; data: string | Uint8Array; store?: boolean; flags?: number; sizeOverride?: number }>): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const raw = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const comp = f.store ? raw : new Uint8Array(deflateRawSync(raw));
    const name = enc.encode(f.name);
    const method = f.store ? 0 : 8;
    const usize = f.sizeOverride ?? raw.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(6, f.flags ?? 0, true);
    lh.setUint16(8, method, true);
    lh.setUint32(18, comp.length, true);
    lh.setUint32(22, usize, true);
    lh.setUint16(26, name.length, true);
    const local = concat(new Uint8Array(lh.buffer), name, comp);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(8, f.flags ?? 0, true);
    ch.setUint16(10, method, true);
    ch.setUint32(20, comp.length, true);
    ch.setUint32(24, usize, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    centrals.push(concat(new Uint8Array(ch.buffer), name));
    locals.push(local);
    offset += local.length;
  }
  const cd = concat(...centrals);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, cd.length, true);
  eocd.setUint32(16, offset, true);
  return concat(...locals, cd, new Uint8Array(eocd.buffer));
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ─── in-memory R2 and D1 (only the calls processExport makes) ───
class MemR2 {
  objects = new Map<string, Uint8Array>();
  async get(key: string) {
    const v = this.objects.get(key);
    return v ? { arrayBuffer: async () => v.slice().buffer } : null;
  }
  async put(key: string, value: string | ArrayBuffer | Uint8Array) {
    this.objects.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value as ArrayBuffer));
  }
  json(key: string): any {
    return JSON.parse(new TextDecoder().decode(this.objects.get(key)!));
  }
}
class MemD1 {
  exports = new Map<string, Record<string, unknown>>();
  seen = new Map<string, { id: string; group_id: string; ts: string; export_id: string }>();
  prepare(sql: string) {
    const db = this;
    const stmt = {
      args: [] as unknown[],
      bind(...a: unknown[]) {
        return { ...stmt, args: a };
      },
      async run() {
        db.exec(sql, this.args);
        return { success: true };
      },
      async all<T>() {
        return { results: db.query(sql, this.args) as T[] };
      },
    };
    return stmt;
  }
  async batch(stmts: Array<{ run: () => Promise<unknown> }>) {
    for (const s of stmts) await s.run();
    return [];
  }
  exec(sql: string, a: unknown[]) {
    if (sql.includes('INSERT INTO exports')) {
      const [id, run_id, group_id, date_from, date_to, r2_key, checksum, bytes, status, error_code, created_at] = a;
      const prev = this.exports.get(id as string) ?? {};
      this.exports.set(id as string, { ...prev, id, run_id, group_id, date_from, date_to, r2_key, checksum, bytes, status, error_code, created_at });
    } else if (sql.startsWith('UPDATE exports SET processing_status')) {
      const cols = ['processing_status', 'processing_error', 'processed_at', 'messages_total', 'messages_in_window', 'messages_new', 'messages_duplicate', 'invalid_dates', 'date_order', 'date_order_ambiguous', 'first_message_at', 'last_message_at', 'messages_r2_key'];
      const id = a[a.length - 1] as string;
      const row = this.exports.get(id)!;
      cols.forEach((c, i) => (row[c] = a[i]));
    } else if (sql.startsWith('INSERT OR IGNORE INTO messages_seen')) {
      const [id, group_id, ts, export_id] = a as string[];
      if (!this.seen.has(id!)) this.seen.set(id!, { id: id!, group_id: group_id!, ts: ts!, export_id: export_id! });
    } else if (sql.startsWith('DELETE FROM messages_seen WHERE ts <')) {
      for (const [k, v] of this.seen) if (v.ts < (a[0] as string)) this.seen.delete(k);
    } else throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
  }
  query(sql: string, a: unknown[]) {
    if (sql.startsWith('SELECT id, export_id FROM messages_seen')) return a.map((id) => this.seen.get(id as string)).filter(Boolean);
    throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
  }
}

let key: CryptoKey;
beforeAll(async () => {
  key = await importPseudonymKey(KEY);
});

// ════════════════════════════ parser ════════════════════════════
describe('parseTranscript', () => {
  it('parses the observed WhatsApp Web format (bracketed, M/D/YY, 12h with seconds)', () => {
    const r = parseTranscript(fx('web-mdy-week1.txt'), 'MDY');
    expect(r.format).toBe('bracketed');
    expect(r.preambleLines).toBe(1); // encryption notice
    expect(r.dateOrder).toBe('MDY'); // detected: second component 14..17 > 12
    expect(r.dateOrderAmbiguous).toBe(false);
    expect(r.messages).toHaveLength(8);
  });

  it('joins multiline messages, keeping blank lines and emoji', () => {
    const m = parseTranscript(fx('web-mdy-week1.txt'), 'MDY').messages[3]!;
    expect(m.author).toBe('Sam Sample');
    expect(m.text).toBe('Late one. Thinking\nof heading over at 10\n\nBring the VR-4 if it starts 😅');
  });

  it('converts 12-hour times, including midnight and noon', () => {
    const ms = parseTranscript(fx('web-mdy-week1.txt'), 'MDY').messages;
    expect([ms[3]!.hour, ms[3]!.minute]).toEqual([0, 5]); // 12:05 AM
    expect([ms[4]!.hour, ms[4]!.minute, ms[4]!.second]).toEqual([12, 30, 44]); // 12:30:44 PM
    expect(ms[7]!.hour).toBe(19); // 7:45 PM
  });

  it('strips invisible direction marks and flags attachment placeholders', () => {
    const m = parseTranscript(fx('web-mdy-week1.txt'), 'MDY').messages[4]!;
    expect(m.author).toBe('Alex Example');
    expect(m.attachment).toBe(true);
    expect(m.text.startsWith('<attached:')).toBe(true);
  });

  it('treats system notices as authorless', () => {
    const m = parseTranscript(fx('web-mdy-week1.txt'), 'MDY').messages[5]!;
    expect(m.author).toBeNull();
    expect(m.text).toContain('changed the group description');
  });

  it('parses UK Android format and detects D/M order', () => {
    const r = parseTranscript(fx('android-uk-dmy.txt'), 'MDY');
    expect(r.format).toBe('dash');
    expect(r.dateOrder).toBe('DMY'); // 23/11, 13/07, 31/02 → first component > 12
    expect(r.messages.find((m) => m.text.startsWith('Summer'))?.author).toBe('Jo Bloggs');
  });

  it('flags ambiguous dates and resolves them with the hint', () => {
    const us = parseTranscript(fx('ambiguous.txt'), 'MDY');
    expect(us.dateOrderAmbiguous).toBe(true);
    expect(us.dateOrder).toBe('MDY');
    const uk = parseTranscript(fx('ambiguous.txt'), 'DMY');
    expect(uk.dateOrder).toBe('DMY');
  });

  it('rejects a transcript that contradicts itself on date order', () => {
    expect(() => parseTranscript('[13/01/26, 1:00:00 PM] A: x\n[01/13/26, 1:00:00 PM] B: y', 'MDY')).toThrow(ParseError);
  });

  it('handles empty and malformed input without inventing messages', () => {
    const empty = parseTranscript(fx('empty.txt'), 'MDY');
    expect(empty.messages).toHaveLength(0);
    expect(empty.dateOrderAmbiguous).toBe(false);
    const bad = parseTranscript(fx('malformed.txt'), 'MDY');
    expect(bad.messages).toHaveLength(0);
    expect(bad.rejectedHeaders).toBe(1);
    expect(bad.format).toBe('none');
  });

  it('accepts CRLF line endings', () => {
    const r = parseTranscript('[11/14/26, 9:00:00 AM] A: one\r\nmore\r\n[11/14/26, 9:01:00 AM] B: two\r\n', 'MDY');
    expect(r.messages.map((m) => m.text)).toEqual(['one\nmore', 'two']);
  });
});

// ════════════════════════════ normalise ════════════════════════════
describe('normalise', () => {
  const opts = (exportId: string, groupId = 'club-a') => ({ groupId, exportId, dateOrder: 'MDY' as const, exportTimeZone: 'UTC', pseudonymKey: key });

  it('converts to UTC ISO and pseudonymises phone-number authors', async () => {
    const { messages } = await normalise(parseTranscript(fx('web-mdy-week1.txt'), 'MDY').messages, opts('e1'));
    expect(messages[0]!.timestamp).toBe('2026-11-14T09:58:02.000Z');
    const phone = messages[1]!;
    expect(phone.author).toMatch(/^Member [0-9a-f]{6}$/);
    expect(phone.authorIsPseudonym).toBe(true);
    expect(JSON.stringify(messages)).not.toContain('7700');
    expect(messages[0]!.author).toBe('Alex Example');
  });

  it('gives the same pseudonym within a group but a different one across groups', async () => {
    const raw = parseTranscript(fx('web-mdy-week1.txt'), 'MDY').messages;
    const a1 = (await normalise(raw, opts('e1', 'club-a'))).messages[1]!.author;
    const a2 = (await normalise(raw, opts('e2', 'club-a'))).messages[1]!.author;
    const b = (await normalise(raw, opts('e3', 'club-b'))).messages[1]!.author;
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  it('keeps genuinely repeated messages as distinct IDs', async () => {
    const { messages } = await normalise(parseTranscript(fx('web-mdy-week1.txt'), 'MDY').messages, opts('e1'));
    const thumbs = messages.filter((m) => m.text === '👍');
    expect(thumbs).toHaveLength(2);
    expect(thumbs[0]!.id).not.toBe(thumbs[1]!.id);
    expect(new Set(messages.map((m) => m.id)).size).toBe(messages.length);
  });

  it('produces identical IDs for the same messages in overlapping exports', async () => {
    const w1 = (await normalise(parseTranscript(fx('web-mdy-week1.txt'), 'MDY').messages, opts('e1'))).messages;
    const w2 = (await normalise(parseTranscript(fx('web-mdy-week2-overlap.txt'), 'MDY').messages, opts('e2'))).messages;
    const ids1 = new Set(w1.map((m) => m.id));
    const shared = w2.filter((m) => ids1.has(m.id));
    expect(shared).toHaveLength(w1.length);
    expect(w2.length - shared.length).toBe(2);
  });

  it('drops impossible dates and converts Europe/London wall clock across BST', async () => {
    const p = parseTranscript(fx('android-uk-dmy.txt'), 'DMY');
    const r = await normalise(p.messages, { ...opts('e1'), dateOrder: p.dateOrder, exportTimeZone: 'Europe/London' });
    expect(r.invalidDates).toBe(1); // 31/02/2026
    expect(r.messages.find((m) => m.text.startsWith('Summer'))!.timestamp).toBe('2026-07-13T17:30:00.000Z'); // BST = UTC+1
    expect(r.messages.find((m) => m.text.startsWith('Winter'))!.timestamp).toBe('2026-02-01T08:15:00.000Z'); // GMT
  });

  it('identifies phone-number authors', () => {
    expect(isPhoneAuthor('+44 7700 900123')).toBe(true);
    expect(isPhoneAuthor('Alex Example')).toBe(false);
    expect(isPhoneAuthor('VR4 Owner 2')).toBe(false);
  });

  it('computes zone offsets including DST changes', () => {
    expect(new Date(zonedTimeToUtc(2026, 3, 29, 2, 30, 0, 'Europe/London')).toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(new Date(zonedTimeToUtc(2026, 10, 25, 12, 0, 0, 'Europe/London')).toISOString()).toBe('2026-10-25T12:00:00.000Z');
    expect(windowStartIso('2026-07-01')).toBe('2026-06-30T23:00:00.000Z');
  });
});

// ════════════════════════════ zip ════════════════════════════
describe('zip reader', () => {
  it('reads deflated and stored transcripts and picks the .txt', async () => {
    for (const store of [false, true]) {
      const z = makeZip([
        { name: 'WhatsApp Chat - Example.txt', data: fx('web-mdy-week1.txt'), store },
        { name: 'WhatsApp Chat - Example.md', data: '# md', store },
      ]);
      const e = pickTranscript(listEntries(z));
      expect(new TextDecoder().decode(await readEntry(z, e))).toBe(fx('web-mdy-week1.txt'));
    }
  });

  it.each([
    ['../evil.txt', 'ZIP_UNSAFE_ENTRY_NAME'],
    ['/etc/passwd.txt', 'ZIP_UNSAFE_ENTRY_NAME'],
    ['dir\\evil.txt', 'ZIP_UNSAFE_ENTRY_NAME'],
  ])('rejects unsafe entry name %s', (name, code) => {
    expect(() => listEntries(makeZip([{ name, data: 'x' }]))).toThrow(code);
  });

  it('rejects encrypted entries, zip bombs, truncation and missing/multiple transcripts', async () => {
    expect(() => listEntries(makeZip([{ name: 'a.txt', data: 'x', flags: 1 }]))).toThrow('ZIP_ENCRYPTED');
    expect(() => listEntries(makeZip([{ name: 'a.txt', data: 'a'.repeat(1_000_000) }]))).toThrow('ZIP_SUSPICIOUS_RATIO');
    expect(() => listEntries(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).toThrow('ZIP_NO_EOCD');
    expect(() => pickTranscript(listEntries(makeZip([{ name: 'a.md', data: 'x' }])))).toThrow('ZIP_NO_TRANSCRIPT');
    expect(() => pickTranscript(listEntries(makeZip([{ name: 'a.txt', data: 'x' }, { name: 'b.txt', data: 'y' }])))).toThrow('ZIP_MULTIPLE_TRANSCRIPTS');
    const lying = makeZip([{ name: 'a.txt', data: 'hello world, hello world', sizeOverride: 5 }]);
    await expect(readEntry(lying, listEntries(lying)[0]!)).rejects.toThrow(ZipError);
  });

  it('validates names', () => {
    expect(isSafeName('WhatsApp Chat - Club.txt')).toBe(true);
    expect(isSafeName('a/../b.txt')).toBe(false);
  });
});

// ════════════════════════════ end-to-end processing ════════════════════════════
describe('processExport (R2 + D1, in memory)', () => {
  async function setup(exportId: string, transcript: string, dateFrom: string, extra: Partial<ExportRecord> = {}) {
    const zip = makeZip([{ name: 'WhatsApp Chat - Example.txt', data: transcript }]);
    const r2Key = `exports/club-a/${exportId}/original.zip`;
    const rec: ExportRecord = {
      id: exportId,
      runId: `run-${exportId}`,
      groupId: 'club-a',
      dateFrom,
      dateTo: '2026-11-23',
      startedAt: '2026-11-23T09:00:00Z',
      completedAt: '2026-11-23T09:01:00Z',
      status: 'succeeded',
      errorCode: null,
      failedStep: null,
      r2Key,
      bytes: zip.length,
      sha256: await sha256Hex(zip.slice().buffer),
      kind: 'zip',
      flowVersion: 3,
      ...extra,
    };
    return { rec, zip, r2Key };
  }
  const deps = (r2: MemR2, db: MemD1): ProcessDeps => ({
    r2: r2 as unknown as R2Bucket,
    db: db as unknown as D1Database,
    pseudonymKey: key,
    exportTimeZone: 'UTC',
    dateOrderHint: 'MDY',
    now: new Date('2026-11-23T10:00:00Z'),
  });

  it('deduplicates across overlapping exports and is idempotent on reprocessing', async () => {
    const r2 = new MemR2();
    const db = new MemD1();
    const a = await setup('e1', fx('web-mdy-week1.txt'), '2026-11-07');
    await r2.put(a.r2Key, a.zip);
    const r1 = await processExport(a.rec, deps(r2, db));
    expect(r1).toMatchObject({ status: 'processed', messagesTotal: 8, messagesInWindow: 8, messagesNew: 8, messagesDuplicate: 0, dateOrder: 'MDY' });

    const b = await setup('e2', fx('web-mdy-week2-overlap.txt'), '2026-11-16'); // window starts 16 Nov
    await r2.put(b.r2Key, b.zip);
    const r2r = await processExport(b.rec, deps(r2, db));
    // In window (≥ 16 Nov 00:00 London): 16th ×2, 17th ×2, 21st, 22nd = 6; 4 already seen, 2 new.
    expect(r2r).toMatchObject({ status: 'processed', messagesTotal: 10, messagesInWindow: 6, messagesNew: 2, messagesDuplicate: 4 });

    const again = await processExport(b.rec, deps(r2, db));
    expect(again).toMatchObject({ messagesNew: 2, messagesDuplicate: 4 });
    expect(db.seen.size).toBe(10);

    const out = r2.json(b.r2Key.replace('original.zip', 'messages.json'));
    expect(out.messages).toHaveLength(6);
    expect(out.messages.filter((m: { isNew: boolean }) => m.isNew)).toHaveLength(2);
    expect(JSON.stringify(out)).not.toContain('7700');
    expect(db.exports.get('e2')).toMatchObject({ processing_status: 'processed', messages_new: 2, date_order: 'MDY', date_order_ambiguous: 0 });
  });

  it('reports an empty window as "empty", never as a failure or inactivity proof', async () => {
    const r2 = new MemR2();
    const db = new MemD1();
    const a = await setup('e1', fx('web-mdy-week1.txt'), '2026-11-20');
    await r2.put(a.r2Key, a.zip);
    const r = await processExport(a.rec, deps(r2, db));
    expect(r).toMatchObject({ status: 'empty', messagesTotal: 8, messagesInWindow: 0 });
  });

  it('fails clearly on corrupt, tampered, missing and malformed exports', async () => {
    const r2 = new MemR2();
    const db = new MemD1();
    const a = await setup('e1', fx('web-mdy-week1.txt'), '2026-11-07');
    await r2.put(a.r2Key, a.zip.slice(0, a.zip.length - 30)); // truncated in storage
    expect((await processExport(a.rec, deps(r2, db))).errorCode).toBe('EXPORT_CHECKSUM_MISMATCH');

    const b = await setup('e2', fx('web-mdy-week1.txt'), '2026-11-07');
    expect((await processExport(b.rec, deps(r2, db))).errorCode).toBe('EXPORT_OBJECT_MISSING');

    const c = await setup('e3', fx('malformed.txt'), '2026-11-07');
    await r2.put(c.r2Key, c.zip);
    expect(await processExport(c.rec, deps(r2, db))).toMatchObject({ status: 'empty', messagesTotal: 0 });

    const d = await setup('e4', '', '2026-11-07', { status: 'failed', r2Key: null });
    expect((await processExport(d.rec, deps(r2, db))).status).toBe('not_applicable');
    expect(db.exports.get('e4')).toMatchObject({ status: 'failed', processing_status: 'not_applicable' });
  });
});
