/**
 * R2 storage for raw exports.
 *
 *   exports/<groupId>/<YYYY-MM-DD>/original.<zip|txt|bin>
 *   exports/<groupId>/<YYYY-MM-DD>/metadata.json
 *
 * The bucket is private. Its lifecycle rule deletes exports/ after 30 days.
 * The Chromium profile and credentials never go here.
 */

export type FileKind = 'zip' | 'text' | 'other' | 'empty';

export type ExportStatus =
  | 'succeeded' // file captured, verified and stored
  | 'failed' // UI flow failed (see errorCode)
  | 'wrong_chat' // chat verification failed: nothing was exported
  | 'logged_out' // WhatsApp not authenticated when the run started
  | 'corrupt' // download empty, truncated or of an unexpected type
  | 'skipped'; // not attempted because an earlier failure stopped the run

export interface ExportRecord {
  id: string;
  runId: string;
  groupId: string;
  dateFrom: string;
  dateTo: string;
  startedAt: string;
  completedAt: string;
  status: ExportStatus;
  errorCode: string | null;
  failedStep: string | null;
  r2Key: string | null;
  bytes: number | null;
  sha256: string | null;
  kind: FileKind | null;
  flowVersion: number;
}

export function exportKeys(groupId: string, exportDate: string, kind: FileKind): { original: string; metadata: string } {
  const ext = kind === 'zip' ? 'zip' : kind === 'text' ? 'txt' : 'bin';
  const base = `exports/${groupId}/${exportDate}`;
  return { original: `${base}/original.${ext}`, metadata: `${base}/metadata.json` };
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Basic integrity check before storing. Full parsing happens in Phase 3. */
export function checkIntegrity(data: ArrayBuffer, kind: FileKind): string | null {
  if (data.byteLength === 0 || kind === 'empty') return 'EMPTY_FILE';
  const b = new Uint8Array(data);
  if (kind === 'zip') {
    // A complete ZIP ends with an end-of-central-directory record ("PK\x05\x06") within the last 64 KiB + 22 bytes.
    const tail = b.subarray(Math.max(0, b.length - 65_557));
    let found = false;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
        found = true;
        break;
      }
    }
    if (!found) return 'ZIP_TRUNCATED';
  }
  if (kind === 'other') return 'UNEXPECTED_FILE_TYPE';
  return null;
}
