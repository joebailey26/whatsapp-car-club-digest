/**
 * Minimal, defensive ZIP reader for WhatsApp exports, run in the Worker.
 *
 * Nothing is ever written to a filesystem, so path traversal can't escape a
 * directory. Entry names are still validated, and suspicious archives are
 * rejected. Supports stored (0) and deflate (8) entries; ZIP64, encryption and
 * multi-disk archives are rejected.
 */

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export class ZipError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ZipError';
  }
}

export const ZIP_LIMITS = {
  maxEntries: 20,
  maxEntryBytes: 50 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  /** Reject entries that inflate more than this ratio (zip bombs). */
  maxRatio: 200,
};

const u16 = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number): number => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

export function listEntries(buf: Uint8Array): ZipEntry[] {
  // End of central directory: scan back over the max comment length.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (u32(buf, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('ZIP_NO_EOCD');
  if (u16(buf, eocd + 4) !== 0 || u16(buf, eocd + 6) !== 0) throw new ZipError('ZIP_MULTIDISK');
  const count = u16(buf, eocd + 10);
  const cdSize = u32(buf, eocd + 12);
  const cdOffset = u32(buf, eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError('ZIP64_UNSUPPORTED');
  if (count > ZIP_LIMITS.maxEntries) throw new ZipError('ZIP_TOO_MANY_ENTRIES');
  if (cdOffset + cdSize > eocd) throw new ZipError('ZIP_BAD_CENTRAL_DIRECTORY');

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || u32(buf, p) !== 0x02014b50) throw new ZipError('ZIP_BAD_CENTRAL_DIRECTORY');
    const flags = u16(buf, p + 8);
    const method = u16(buf, p + 10);
    const compressedSize = u32(buf, p + 20);
    const uncompressedSize = u32(buf, p + 24);
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commentLen = u16(buf, p + 32);
    const localHeaderOffset = u32(buf, p + 42);
    const name = new TextDecoder('utf-8').decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1) throw new ZipError('ZIP_ENCRYPTED');
    if (method !== 0 && method !== 8) throw new ZipError('ZIP_UNSUPPORTED_METHOD');
    if (!isSafeName(name)) throw new ZipError('ZIP_UNSAFE_ENTRY_NAME');
    if (uncompressedSize > ZIP_LIMITS.maxEntryBytes) throw new ZipError('ZIP_ENTRY_TOO_LARGE');
    if (compressedSize > 0 && uncompressedSize / compressedSize > ZIP_LIMITS.maxRatio) throw new ZipError('ZIP_SUSPICIOUS_RATIO');
    total += uncompressedSize;
    if (total > ZIP_LIMITS.maxTotalBytes) throw new ZipError('ZIP_TOO_LARGE');
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
  }
  return entries;
}

/** Reject absolute paths, traversal, backslashes and control characters. */
export function isSafeName(name: string): boolean {
  if (!name || name.length > 255) return false;
  if (name.startsWith('/') || name.includes('\\') || /^[A-Za-z]:/.test(name)) return false;
  if (name.split('/').some((seg) => seg === '..')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) return false;
  return true;
}

export async function readEntry(buf: Uint8Array, e: ZipEntry): Promise<Uint8Array> {
  const h = e.localHeaderOffset;
  if (h + 30 > buf.length || u32(buf, h) !== 0x04034b50) throw new ZipError('ZIP_BAD_LOCAL_HEADER');
  const start = h + 30 + u16(buf, h + 26) + u16(buf, h + 28);
  const end = start + e.compressedSize;
  if (end > buf.length) throw new ZipError('ZIP_TRUNCATED');
  const data = buf.subarray(start, end);
  if (e.method === 0) {
    if (e.compressedSize !== e.uncompressedSize) throw new ZipError('ZIP_SIZE_MISMATCH');
    return data;
  }
  const out = await inflateRaw(data, e.uncompressedSize);
  if (out.length !== e.uncompressedSize) throw new ZipError('ZIP_SIZE_MISMATCH');
  return out;
}

/** Inflate with a hard output cap, so a lying size header can't exhaust memory. */
async function inflateRaw(data: Uint8Array, expected: number): Promise<Uint8Array> {
  const cap = Math.min(expected, ZIP_LIMITS.maxEntryBytes) + 1;
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  void writer.write(data).then(() => writer.close()).catch(() => undefined);
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > cap) {
      await reader.cancel().catch(() => undefined);
      throw new ZipError('ZIP_INFLATE_OVERRUN');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Pick the chat transcript: exactly one top-level-ish .txt entry. */
export function pickTranscript(entries: ZipEntry[]): ZipEntry {
  const txt = entries.filter((e) => e.name.toLowerCase().endsWith('.txt') && !e.name.endsWith('/'));
  if (txt.length === 0) throw new ZipError('ZIP_NO_TRANSCRIPT');
  if (txt.length > 1) throw new ZipError('ZIP_MULTIPLE_TRANSCRIPTS');
  return txt[0]!;
}
