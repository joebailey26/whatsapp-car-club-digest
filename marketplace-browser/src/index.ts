import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { errorCode, log } from './log.js';
import { BrowserSession, readMetrics, type CollectSearch } from './session.js';

/**
 * Control API, reachable only through the MarketplaceController Durable Object.
 * Every request except /healthz needs the per-start CONTROL_TOKEN.
 *
 *   GET  /healthz
 *   GET  /metrics                     cgroup CPU seconds and memory (cost measurement)
 *   POST /session/start               launch Chromium on the persistent profile (body {to:"login"} opens the login page)
 *   GET  /session/status?settle=ms    authenticated | login | checkpoint | loading | unknown
 *   GET  /session/screenshot          JPEG for the remote login console (refused once authenticated)
 *   POST /session/input               remote click / type / key for the owner's sign-in (refused once authenticated)
 *   POST /collect                     read result cards from the given searches
 *   POST /details                     read description + "Listed … ago" from item pages
 *   POST /session/close               graceful Chromium shutdown + fsync (before snapshot)
 */

const IMAGE_VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();
const PORT = Number(process.env.PORT ?? 8080);
const CONTROL_TOKEN = process.env.CONTROL_TOKEN ?? '';
const MAX_WAIT_MS = 10 * 60_000;

const session = new BrowserSession({
  executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
  profileDir: process.env.PROFILE_DIR ?? '/data/chrome-profile',
  navigationTimeoutMs: Number(process.env.NAV_TIMEOUT_MS ?? 30_000),
});

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

function authorised(req: IncomingMessage): boolean {
  if (!CONTROL_TOKEN) return false;
  const got = req.headers['x-control-token'];
  if (typeof got !== 'string') return false;
  const a = Buffer.from(got);
  const b = Buffer.from(CONTROL_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) return null;
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const clamp = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : fallback;
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://container');
  const route = `${req.method} ${url.pathname}`;
  const t0 = Date.now();

  const handle = async (): Promise<void> => {
    if (route === 'GET /healthz') return json(res, 200, { ok: true, image_version: IMAGE_VERSION, browser_running: session.running });
    if (!authorised(req)) return json(res, 401, { error: 'unauthorised' });
    switch (route) {
      case 'GET /metrics':
        return json(res, 200, await readMetrics());
      case 'POST /session/start': {
        const body = await readJson(req, 4096);
        const to = body?.to === 'login' ? 'https://www.facebook.com/login/' : undefined;
        return json(res, 200, await serial(() => session.start(to)));
      }
      case 'GET /session/status': {
        const settle = clamp(url.searchParams.get('settle'), 0, 0, MAX_WAIT_MS);
        return json(res, 200, await serial(() => (settle > 0 ? session.waitForSettled(settle) : session.status())));
      }
      case 'GET /session/screenshot': {
        const shot = await session.loginScreenshot();
        if ('refused' in shot) return json(res, 409, { error: 'screenshot_refused', reason: shot.refused });
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' });
        res.end(shot);
        return;
      }
      case 'POST /session/input': {
        const body = await readJson(req, 4096);
        if (!body) return json(res, 400, { error: 'invalid_body' });
        const r = await serial(() => session.input(body));
        return 'refused' in r ? json(res, 409, { error: 'input_refused', reason: r.refused }) : json(res, 200, r);
      }
      case 'POST /collect': {
        const body = await readJson(req, 64 * 1024);
        if (!body || !Array.isArray(body.searches)) return json(res, 400, { error: 'invalid_body' });
        const searches: CollectSearch[] = (body.searches as unknown[]).slice(0, 10).flatMap((s) => {
          const x = s as { id?: unknown; url?: unknown; maxScrolls?: unknown };
          return typeof x.id === 'string' && typeof x.url === 'string' ? [{ id: x.id, url: x.url, maxScrolls: clamp(x.maxScrolls, 2, 0, 6) }] : [];
        });
        const r = await serial(() =>
          session.collect(searches, {
            maxItems: clamp(body.maxItems, 40, 1, 200),
            pageDelayMs: clamp(body.pageDelayMs, 4000, 0, 30_000),
            deadlineMs: clamp(body.deadlineMs, 180_000, 10_000, MAX_WAIT_MS),
            blockImages: body.blockImages !== false,
          }),
        );
        return json(res, 200, r);
      }
      case 'POST /details': {
        const body = await readJson(req, 64 * 1024);
        if (!body || !Array.isArray(body.urls)) return json(res, 400, { error: 'invalid_body' });
        const urls = (body.urls as unknown[]).filter((u): u is string => typeof u === 'string').slice(0, 15);
        const r = await serial(() => session.details(urls, { pageDelayMs: clamp(body.pageDelayMs, 3000, 0, 30_000), deadlineMs: clamp(body.deadlineMs, 90_000, 10_000, MAX_WAIT_MS) }));
        return json(res, 200, r);
      }
      case 'POST /session/close':
        return json(res, 200, await serial(() => session.close()));
    }
    return json(res, 404, { error: 'not_found' });
  };

  handle()
    .then(() => {
      if (url.pathname !== '/healthz') log('info', 'request', { route, status: res.statusCode, duration_ms: Date.now() - t0 });
    })
    .catch((err: unknown) => {
      log('error', 'request_failed', { route, error_code: errorCode(err) });
      if (!res.headersSent) json(res, 500, { error: 'internal', error_code: errorCode(err) });
      else res.end();
    });
});

server.listen(PORT, '0.0.0.0', () => log('info', 'control_server_listening', { port: PORT }));

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    log('info', 'signal_received', { signal: sig });
    session
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  });
}
