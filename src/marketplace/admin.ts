import { verifyAccess } from '../api/access';
import type { MarketEnv } from './env';
import { MARKET_ADMIN_PAGE, reviewPage } from './page';
import type { ListingView } from './repository';

/**
 * Admin routes of the Marketplace Worker (all behind Cloudflare Access plus the
 * in-Worker JWT check and email allowlist). Non-GET requests must send
 * `x-requested-with: market-admin`: a custom header forces a CORS preflight,
 * so neither cross-site forms nor link-prefetching mail scanners can change state.
 * GET requests never change state, including the review page linked from emails.
 */

export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'market-admin';

const SECURITY_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};
const PAGE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const VIEWS: readonly ListingView[] = ['new', 'alerted', 'review', 'dismissed', 'interested', 'all'];

export async function handleMarketAdmin(request: Request, env: MarketEnv): Promise<Response> {
  const url = new URL(request.url);
  const auth = await verifyAccess(request, env);
  if (!auth.ok) return json({ error: auth.code }, auth.status);
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.headers.get(CSRF_HEADER) !== CSRF_VALUE) {
    return json({ error: 'CSRF_HEADER_REQUIRED' }, 403);
  }

  const c = env.MARKET_CONTROLLER.get(env.MARKET_CONTROLLER.idFromName('marketplace'));
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const route = `${request.method} ${path}`;

  switch (route) {
    case 'GET /admin':
      return html(MARKET_ADMIN_PAGE);
    case 'GET /admin/api/status':
      return json(await c.getStatus());
    case 'POST /admin/api/login/start':
      return queued(await c.startLogin());
    case 'POST /admin/api/login/complete':
      return queued(await c.completeLogin());
    case 'GET /admin/api/login/screen': {
      const shot = await c.loginScreenshot();
      if (!shot.ok) return json({ error: shot.code }, 409);
      return new Response(shot.jpeg, { headers: { ...SECURITY_HEADERS, 'content-type': 'image/jpeg' } });
    }
    case 'POST /admin/api/login/input': {
      const body = await readJson(request);
      if (body === undefined) return json({ error: 'INVALID_JSON' }, 400);
      const r = await c.loginInput(body);
      return json(r, r.ok ? 200 : 409);
    }
    case 'POST /admin/api/test/restore':
      return queued(await c.runRestoreTest());
    case 'POST /admin/api/abort':
      return json(await c.abort());
    case 'GET /admin/api/searches':
      return json(await c.getSearches());
    case 'PUT /admin/api/searches': {
      const body = await readJson(request);
      if (body === undefined) return json({ error: 'INVALID_JSON' }, 400);
      const r = (await c.setSearches(body)) as { ok: true; value: unknown } | { ok: false; error: string };
      return r.ok ? json(r.value) : json({ error: 'INVALID_CONFIG', detail: r.error }, 400);
    }
    case 'GET /admin/api/settings':
      return json(await c.getSettings());
    case 'PUT /admin/api/settings': {
      const body = await readJson(request);
      if (body === undefined) return json({ error: 'INVALID_JSON' }, 400);
      const r = (await c.setSettings(body)) as { ok: true; value: unknown } | { ok: false; error: string };
      return r.ok ? json(r.value) : json({ error: 'INVALID_CONFIG', detail: r.error }, 400);
    }
    case 'GET /admin/api/schedule':
      return json(await c.getSchedule());
    case 'PUT /admin/api/schedule': {
      const body = await readJson(request);
      if (body === undefined) return json({ error: 'INVALID_JSON' }, 400);
      const r = (await c.setSchedule(body)) as { error?: string };
      return json(r, r.error ? 409 : 200);
    }
    case 'POST /admin/api/collect': {
      const body = await readJson(request, true);
      if (body === undefined) return json({ error: 'INVALID_JSON' }, 400);
      return queued(await c.runCollect(body));
    }
    case 'GET /admin/api/runs':
      return json(await c.getRuns());
    case 'GET /admin/api/usage':
      return json(await c.getUsage());
    case 'GET /admin/api/alerts':
      return json(await c.getAlerts());
    case 'POST /admin/api/alerts/test':
      return json({ sent: await c.sendTestAlert() });
    case 'POST /admin/api/roundup': {
      const body = await readJson(request, true);
      if (body === undefined) return json({ error: 'INVALID_JSON' }, 400);
      return json(await c.runRoundup(body));
    }
    case 'POST /admin/api/replay': {
      const body = await readJson(request, true);
      if (body === undefined) return json({ error: 'INVALID_JSON' }, 400);
      return json(await c.replay(body));
    }
    case 'GET /admin/api/listings': {
      const v = url.searchParams.get('view') ?? 'new';
      if (!(VIEWS as readonly string[]).includes(v)) return json({ error: 'INVALID_VIEW', views: VIEWS }, 400);
      return json(await c.getListings(v as ListingView, Number(url.searchParams.get('limit') ?? 50) || 50));
    }
  }

  // /admin/api/listings/<id> and /admin/api/listings/<id>/feedback
  const lm = /^\/admin\/api\/listings\/([^/]+)(\/feedback)?$/.exec(path);
  if (lm) {
    const id = safeDecode(lm[1]!);
    if (!id || !/^[a-z_]+:[0-9]{5,25}$/.test(id)) return json({ error: 'INVALID_ID' }, 400);
    if (!lm[2] && request.method === 'GET') {
      const d = await c.getListing(id);
      return d ? json(d) : json({ error: 'NOT_FOUND' }, 404);
    }
    if (lm[2] && request.method === 'POST') {
      const body = await readJson(request);
      if (body === undefined) return json({ error: 'INVALID_JSON' }, 400);
      const r = await c.feedback(id, body, auth.email);
      return r.ok ? json(r) : json({ error: r.code }, r.code === 'NOT_FOUND' ? 404 : 400);
    }
  }

  // GET /admin/review/<id>: page linked from emails. Display only; the buttons POST with the CSRF header.
  const rm = /^\/admin\/review\/([^/]+)$/.exec(path);
  if (rm && request.method === 'GET') {
    const id = safeDecode(rm[1]!);
    if (!id || !/^[a-z_]+:[0-9]{5,25}$/.test(id)) return json({ error: 'INVALID_ID' }, 400);
    const d = (await c.getListing(id)) as { listing: Parameters<typeof reviewPage>[0] } | null;
    if (!d) return json({ error: 'NOT_FOUND' }, 404);
    return html(reviewPage(d.listing));
  }

  return json({ error: 'NOT_FOUND' }, 404);
}

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

async function readJson(request: Request, allowEmpty = false): Promise<unknown> {
  const text = await request.text();
  if (text.length > 64 * 1024) return undefined;
  if (!text.trim()) return allowEmpty ? null : undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function queued(r: { ok: boolean; code?: string; status: unknown }): Response {
  return r.ok ? json({ queued: true, status: r.status }, 202) : json({ queued: false, error: r.code, status: r.status }, 409);
}

function html(body: string): Response {
  return new Response(body, { headers: { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PAGE_CSP } });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { ...SECURITY_HEADERS, 'content-type': 'application/json' } });
}
