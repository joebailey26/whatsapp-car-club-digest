import { timingSafeEqual } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { DriverError } from './downloads.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { errorCode, log } from './log.js';
import { BrowserSession } from './session.js';

/**
 * Control API for the browser, reachable only through the Durable Object that
 * owns this container. Every request except /healthz must carry the
 * per-container CONTROL_TOKEN (set by the Durable Object via envVars).
 *
 * Endpoints:
 *   GET  /healthz
 *   POST /session/start              launch Chromium on the persistent profile and open WhatsApp Web
 *   GET  /session/status?settle=ms   probe state; optionally wait until qr/authenticated
 *   POST /session/wait-auth?timeout=ms  wait until authenticated (after QR scan)
 *   GET  /session/screenshot         PNG of the pairing screen (refused once authenticated)
 *   POST /session/close              graceful Chromium shutdown + fsync (call before snapshot)
 */

const IMAGE_VERSION = readImageVersion();
const PORT = Number(process.env.PORT ?? 8080);
const CONTROL_TOKEN = process.env.CONTROL_TOKEN ?? '';
const MAX_WAIT_MS = 5 * 60_000;

const session = new BrowserSession({
  executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
  profileDir: process.env.PROFILE_DIR ?? '/data/chrome-profile',
  navigationTimeoutMs: Number(process.env.NAV_TIMEOUT_MS ?? 60_000),
});

// Serialise browser operations: one at a time.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

/** The image version is browser/package.json "version"; it ties snapshots to images. */
function readImageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function authorised(req: IncomingMessage): boolean {
  if (!CONTROL_TOKEN) return false; // fail closed
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

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) return null;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

function clampMs(raw: string | null, fallback: number): number {
  const n = raw === null ? fallback : Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, MAX_WAIT_MS);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://container');
  const route = `${req.method} ${url.pathname}`;
  const t0 = Date.now();

  const handle = async (): Promise<void> => {
    if (route === 'GET /healthz') {
      return json(res, 200, { ok: true, image_version: IMAGE_VERSION, browser_running: session.running });
    }
    if (!authorised(req)) return json(res, 401, { error: 'unauthorised' });

    switch (route) {
      case 'POST /session/start':
        return json(res, 200, await serial(() => session.start()));
      case 'GET /session/status': {
        const settle = clampMs(url.searchParams.get('settle'), 0);
        const probe = await serial(() => (settle > 0 ? session.waitForSettled(settle) : session.status()));
        return json(res, 200, probe);
      }
      case 'POST /session/wait-auth': {
        const timeout = clampMs(url.searchParams.get('timeout'), 120_000);
        return json(res, 200, await serial(() => session.waitForAuthenticated(timeout)));
      }
      case 'GET /session/screenshot': {
        // Not serialised: must stay responsive while wait-auth is polling.
        const shot = await session.pairingScreenshot();
        if ('refused' in shot) return json(res, 409, { error: 'screenshot_refused', reason: shot.refused });
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
        res.end(shot);
        return;
      }
      case 'POST /session/close':
        return json(res, 200, await serial(() => session.close()));
      case 'POST /driver/run': {
        const body = (await readJson(req, 64 * 1024)) as { steps?: unknown; deadlineMs?: unknown } | null;
        if (!body) return json(res, 400, { error: 'invalid_body' });
        const deadline = clampMs(typeof body.deadlineMs === 'number' ? String(body.deadlineMs) : null, 180_000);
        try {
          const result = await serial(() => session.run(body.steps, deadline));
          if ('refused' in result) return json(res, 409, { error: 'run_refused', reason: result.refused });
          return json(res, 200, result);
        } catch (err) {
          if (err instanceof DriverError) return json(res, 400, { error: err.code });
          throw err;
        }
      }
    }

    // /downloads/:id: fetch or delete a captured export
    const dl = /^\/downloads\/([A-Za-z0-9-]{8,64})$/.exec(url.pathname);
    if (dl && (req.method === 'GET' || req.method === 'DELETE')) {
      const id = dl[1]!;
      if (req.method === 'DELETE') return json(res, 200, { deleted: await session.downloads.remove(id) });
      const path = session.downloads.pathFor(id);
      const st = path ? await stat(path).catch(() => null) : null;
      if (!path || !st) return json(res, 404, { error: 'not_found' });
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(st.size), 'cache-control': 'no-store' });
      await new Promise<void>((resolve, reject) => {
        createReadStream(path).on('error', reject).on('end', resolve).pipe(res);
      });
      return;
    }
    return json(res, 404, { error: 'not_found' });
  };

  handle()
    .then(() => {
      if (url.pathname !== '/healthz') {
        log('info', 'request', { route, status: res.statusCode, duration_ms: Date.now() - t0 });
      }
    })
    .catch((err: unknown) => {
      log('error', 'request_failed', { route, error_code: errorCode(err) });
      if (!res.headersSent) json(res, 500, { error: 'internal', error_code: errorCode(err) });
      else res.end();
    });
});

server.listen(PORT, '0.0.0.0', () => log('info', 'control_server_listening', { port: PORT }));

// On container stop signals, close Chromium gracefully so the profile is flushed.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    log('info', 'signal_received', { signal: sig });
    session
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  });
}
