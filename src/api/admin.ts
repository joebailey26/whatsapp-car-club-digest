import type { Env } from '../types/env';
import { verifyAccess } from './access';
import { ADMIN_PAGE } from './page';

/**
 * Admin routes (all under /admin, all behind Cloudflare Access):
 *
 *   GET  /admin                         minimal admin + pairing page
 *   GET  /admin/api/status              controller status (no secrets, no message content)
 *   POST /admin/api/pairing/start       start a fresh container and open WhatsApp Web
 *   GET  /admin/api/pairing/screen      PNG of the pairing screen (refused once logged in)
 *   POST /admin/api/pairing/complete    confirm login, snapshot, stop container
 *   POST /admin/api/test/restore        Phase 1 gate: restore from snapshot, check login persists
 *   POST /admin/api/abort               stop the container immediately
 *
 * State-changing requests must send `x-requested-with: digest-admin`. A custom
 * header forces a CORS preflight, which blocks cross-site form posts (CSRF).
 */

const CSRF_HEADER = 'x-requested-with';
const CSRF_VALUE = 'digest-admin';

const SECURITY_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

export async function handleAdmin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  const auth = await verifyAccess(request, env);
  if (!auth.ok) return json({ error: auth.code }, auth.status);

  if (request.method !== 'GET' && request.method !== 'HEAD' && request.headers.get(CSRF_HEADER) !== CSRF_VALUE) {
    return json({ error: 'CSRF_HEADER_REQUIRED' }, 403);
  }

  const controller = env.CONTROLLER.get(env.CONTROLLER.idFromName('controller'));
  const route = `${request.method} ${url.pathname.replace(/\/+$/, '') || '/'}`;

  switch (route) {
    case 'GET /admin':
      return new Response(ADMIN_PAGE, {
        headers: {
          ...SECURITY_HEADERS,
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy':
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        },
      });
    case 'GET /admin/api/status':
      return json(await controller.getStatus());
    case 'POST /admin/api/pairing/start':
      return queued(await controller.startPairing());
    case 'POST /admin/api/pairing/complete':
      return queued(await controller.completePairing());
    case 'POST /admin/api/test/restore':
      return queued(await controller.runRestoreTest());
    case 'POST /admin/api/abort':
      return json(await controller.abort());

    // ── Phase 2 ──
    case 'GET /admin/api/groups':
      return json(await controller.getGroups());
    case 'PUT /admin/api/groups': {
      const body = await readJson(request);
      if (body === undefined) return json({ error: 'INVALID_JSON' }, 400);
      const r = await controller.setGroups(body);
      return r.ok ? json(r.value) : json({ error: 'INVALID_CONFIG', detail: r.error }, 400);
    }
    case 'GET /admin/api/flow':
      return json(await controller.getFlow());
    case 'PUT /admin/api/flow': {
      const body = await readJson(request);
      if (body === undefined) return json({ error: 'INVALID_JSON' }, 400);
      const r = await controller.setFlow(body);
      return r.ok ? json(r.value) : json({ error: 'INVALID_CONFIG', detail: r.error }, 400);
    }
    case 'POST /admin/api/inspect': {
      const body = await readJson(request, true);
      if (body === undefined) return json({ error: 'INVALID_JSON' }, 400);
      const r = await controller.runInspect(body);
      if (!r.ok && 'detail' in r) return json({ queued: false, error: r.code, detail: r.detail }, 400);
      return queued(r);
    }
    case 'GET /admin/api/inspection':
      return json(await controller.getInspection());
    case 'POST /admin/api/export':
      return queued(await controller.runExport());
    case 'POST /admin/api/process': {
      const body = await readJson(request, true);
      if (body === undefined) return json({ error: 'INVALID_JSON' }, 400);
      const r = await controller.runProcess(body);
      if (!r.ok && 'detail' in r) return json({ queued: false, error: r.code, detail: r.detail }, 400);
      return queued(r);
    }
    case 'POST /admin/api/analyse': {
      const body = await readJson(request, true);
      if (body === undefined) return json({ error: 'INVALID_JSON' }, 400);
      const r = await controller.runAnalyse(body);
      if (!r.ok && 'detail' in r) return json({ queued: false, error: r.code, detail: r.detail }, 400);
      return queued(r);
    }
    case 'POST /admin/api/ai/eval': {
      const body = await readJson(request, true);
      if (body === undefined) return json({ error: 'INVALID_JSON' }, 400);
      const r = await controller.runModelEvaluation(body);
      if (!r.ok && 'detail' in r) return json({ queued: false, error: r.code, detail: r.detail }, 400);
      return queued(r);
    }
    case 'GET /admin/api/ai/eval':
      return json(await controller.getEvalReports());
    case 'GET /admin/api/events':
      return json(await controller.getEvents());
    case 'POST /admin/api/digest': {
      const body = await readJson(request, true);
      if (body === undefined) return json({ error: 'INVALID_JSON' }, 400);
      return queued(await controller.runDigestOp(body));
    }
    case 'GET /admin/api/digests':
      return json(await controller.getDigests());
    case 'GET /admin/api/schedule':
      return json(await controller.getSchedule());
    case 'PUT /admin/api/schedule': {
      const body = await readJson(request);
      if (body === undefined) return json({ error: 'INVALID_JSON' }, 400);
      return json(await controller.setSchedule(body));
    }
    case 'POST /admin/api/schedule/simulate': {
      const body = await readJson(request);
      if (body === undefined) return json({ error: 'INVALID_JSON' }, 400);
      return json(await controller.simulateSchedule(body));
    }
    case 'GET /admin/api/alerts':
      return json(await controller.getAlerts());
    case 'POST /admin/api/alerts/test':
      return json({ sent: await controller.sendTestAlert() });
    case 'GET /admin/api/exports':
      return json(await controller.getExportRuns());
    case 'GET /admin/api/pairing/screen': {
      const shot = await controller.pairingScreenshot();
      if (!shot.ok) return json({ error: shot.code }, 409);
      return new Response(shot.png, { headers: { ...SECURITY_HEADERS, 'content-type': 'image/png' } });
    }
    default: {
      // GET /admin/digest/<YYYY-MM-DD>: stored HTML rendering, no scripts allowed.
      const m = /^GET \/admin\/digest\/(\d{4}-\d{2}-\d{2})$/.exec(route);
      if (m) {
        const html = await controller.getDigestHtml(m[1]!);
        if (!html) return json({ error: 'NOT_FOUND' }, 404);
        return new Response(html, {
          headers: {
            ...SECURITY_HEADERS,
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          },
        });
      }
      return json({ error: 'NOT_FOUND' }, 404);
    }
  }
}

/** Parse a JSON body (max 64 KiB). Returns undefined on invalid JSON; null for an allowed empty body. */
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...SECURITY_HEADERS, 'content-type': 'application/json' },
  });
}
