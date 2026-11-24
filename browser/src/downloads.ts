import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Browser, CDPSession } from 'puppeteer-core';
import { log } from './log.js';

/**
 * Captures browser downloads via the Chrome DevTools Protocol.
 *
 * Files are saved under DOWNLOAD_DIR named by the download GUID. The directory
 * is wiped whenever the browser closes, so an export is never captured in a
 * container snapshot.
 */

export const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR ?? '/tmp/downloads';
const ID_RE = /^[A-Za-z0-9-]{8,64}$/;

export type FileKind = 'zip' | 'text' | 'other' | 'empty';

export interface DownloadInfo {
  id: string;
  /** Suggested filename, basename only. May contain the chat name: never log it. */
  filename: string;
  bytes: number;
  sha256: string;
  kind: FileKind;
}

interface Tracked {
  guid: string;
  filename: string;
  state: 'inProgress' | 'completed' | 'canceled';
  claimed: boolean;
}

export class DownloadManager {
  private cdp: CDPSession | undefined;
  private readonly tracked = new Map<string, Tracked>();

  async attach(browser: Browser): Promise<void> {
    await mkdir(DOWNLOAD_DIR, { recursive: true });
    this.cdp = await browser.target().createCDPSession();
    await this.cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allowAndName',
      downloadPath: DOWNLOAD_DIR,
      eventsEnabled: true,
    });
    this.cdp.on('Browser.downloadWillBegin', (e: { guid: string; suggestedFilename: string }) => {
      this.tracked.set(e.guid, {
        guid: e.guid,
        filename: basename(e.suggestedFilename || 'download').slice(0, 200),
        state: 'inProgress',
        claimed: false,
      });
      log('info', 'download_started');
    });
    this.cdp.on('Browser.downloadProgress', (e: { guid: string; state: string }) => {
      const t = this.tracked.get(e.guid);
      if (!t) return;
      if (e.state === 'completed' || e.state === 'canceled') {
        t.state = e.state;
        log('info', 'download_finished', { state: e.state });
      }
    });
  }

  /**
   * Wait for the next unclaimed download to finish, then return its verified
   * metadata. Rejects empty, oversized or cancelled downloads.
   */
  async next(timeoutMs: number, maxBytes: number): Promise<DownloadInfo> {
    const deadline = Date.now() + timeoutMs;
    let pick: Tracked | undefined;
    while (Date.now() < deadline) {
      pick = [...this.tracked.values()].find((t) => !t.claimed && t.state !== 'inProgress');
      if (pick) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!pick) {
      const pending = [...this.tracked.values()].some((t) => !t.claimed && t.state === 'inProgress');
      throw new DriverError(pending ? 'DOWNLOAD_INCOMPLETE' : 'DOWNLOAD_NOT_STARTED');
    }
    pick.claimed = true;
    if (pick.state === 'canceled') throw new DriverError('DOWNLOAD_CANCELED');

    const path = join(DOWNLOAD_DIR, pick.guid);
    const st = await stat(path).catch(() => null);
    if (!st) throw new DriverError('DOWNLOAD_FILE_MISSING');
    if (st.size > maxBytes) {
      await rm(path, { force: true });
      throw new DriverError('DOWNLOAD_TOO_LARGE');
    }
    const { sha256, head } = await hashFile(path);
    const info: DownloadInfo = {
      id: pick.guid,
      filename: pick.filename,
      bytes: st.size,
      sha256,
      kind: st.size === 0 ? 'empty' : detectKind(head),
    };
    log('info', 'download_verified', { bytes: info.bytes, kind: info.kind });
    return info;
  }

  pathFor(id: string): string | null {
    if (!ID_RE.test(id)) return null;
    return join(DOWNLOAD_DIR, id);
  }

  async remove(id: string): Promise<boolean> {
    const p = this.pathFor(id);
    if (!p) return false;
    await rm(p, { force: true });
    this.tracked.delete(id);
    return true;
  }

  /** Delete every downloaded file. Called on browser close, before any snapshot. */
  async wipe(): Promise<number> {
    this.tracked.clear();
    this.cdp = undefined;
    let entries: string[] = [];
    try {
      entries = await readdir(DOWNLOAD_DIR);
    } catch {
      return 0;
    }
    await Promise.all(entries.map((e) => rm(join(DOWNLOAD_DIR, e), { recursive: true, force: true })));
    return entries.length;
  }
}

export class DriverError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'DriverError';
  }
}

export function detectKind(head: Uint8Array): FileKind {
  if (head.length === 0) return 'empty';
  // ZIP local file header "PK\x03\x04" (or empty archive "PK\x05\x06")
  if (head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05)) return 'zip';
  // Treat as text if the first bytes decode as UTF-8 without control characters (other than tab/CR/LF).
  const sample = head.subarray(0, Math.min(head.length, 512));
  try {
    const s = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(sample.subarray(0, trimPartialUtf8(sample)));
    // eslint-disable-next-line no-control-regex
    if (!/[\u0000-\u0008\u000e-\u001f]/.test(s)) return 'text';
  } catch {
    /* not utf-8 */
  }
  return 'other';
}

/** Length of the sample excluding a trailing partial UTF-8 sequence. */
function trimPartialUtf8(b: Uint8Array): number {
  let end = b.length;
  for (let i = 1; i <= 3 && end - i >= 0; i++) {
    const c = b[end - i]!;
    if ((c & 0xc0) === 0x80) continue; // continuation byte
    if ((c & 0x80) === 0) return end; // ascii: complete
    const need = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : 2;
    return i < need ? end - i : end;
  }
  return end;
}

async function hashFile(path: string): Promise<{ sha256: string; head: Uint8Array }> {
  const hash = createHash('sha256');
  let head: Uint8Array = new Uint8Array(0);
  await new Promise<void>((resolve, reject) => {
    const s = createReadStream(path);
    s.on("data", (raw: string | Buffer) => {
      const chunk = typeof raw === "string" ? Buffer.from(raw) : raw;
      if (head.length < 512) head = Buffer.concat([head, chunk]).subarray(0, 512);
      hash.update(chunk);
    });
    s.on('end', () => resolve());
    s.on('error', reject);
  });
  return { sha256: hash.digest('hex'), head };
}
