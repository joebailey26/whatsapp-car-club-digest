/**
 * Metadata-only structured logging.
 *
 * Never pass listing text, cookies, credentials, typed input, page HTML
 * or screenshots to this logger. Only short codes, counts and durations.
 */
type Fields = Record<string, string | number | boolean | null | undefined>;

export function log(level: 'info' | 'warn' | 'error', event: string, fields: Fields = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === 'error') console.error(line);
  else console.log(line);
}

/** Reduce an unknown error to a safe, short code + message without stack or page content. */
export function errorCode(err: unknown): string {
  if (err instanceof Error) {
    const name = err.name || 'Error';
    // Puppeteer timeout / protocol errors have predictable names; keep the first line only.
    const firstLine = (err.message.split('\n')[0] ?? '').slice(0, 160);
    return `${name}: ${firstLine}`;
  }
  return 'UnknownError';
}
