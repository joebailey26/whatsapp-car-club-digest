import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Env } from '../types/env';

/**
 * Verifies the Cloudflare Access JWT (Cf-Access-Jwt-Assertion) on every admin
 * request. Fails closed: if Access is not configured, admin is unavailable.
 */

/** The vars access checks need; satisfied by both the WhatsApp and Marketplace Workers' env. */
export type AccessEnv = Pick<Env, 'ACCESS_TEAM_DOMAIN' | 'ACCESS_AUD' | 'ADMIN_EMAILS' | 'DEV_ALLOW_UNAUTHENTICATED'>;

export type AccessResult = { ok: true; email: string | null } | { ok: false; status: 401 | 403 | 503; code: string };

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function normaliseTeamDomain(raw: string): string | null {
  const v = raw.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!v) return null;
  // e.g. "myteam.cloudflareaccess.com"
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(v)) return null;
  return v.toLowerCase();
}

export function isLocalDevBypass(env: AccessEnv, url: URL): boolean {
  return env.DEV_ALLOW_UNAUTHENTICATED === 'true' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

export function emailAllowed(email: string | null, allowlist: string | undefined): boolean {
  const list = (allowlist ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0) return true; // Access policy is the gate
  return email !== null && list.includes(email.toLowerCase());
}

export async function verifyAccess(request: Request, env: AccessEnv): Promise<AccessResult> {
  const url = new URL(request.url);
  if (isLocalDevBypass(env, url)) return { ok: true, email: 'local-dev' };

  const team = normaliseTeamDomain(env.ACCESS_TEAM_DOMAIN ?? '');
  const aud = (env.ACCESS_AUD ?? '').trim();
  if (!team || !aud) return { ok: false, status: 503, code: 'ACCESS_NOT_CONFIGURED' };

  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) return { ok: false, status: 401, code: 'MISSING_ACCESS_TOKEN' };

  let jwks = jwksCache.get(team);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
    jwksCache.set(team, jwks);
  }

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, jwks, { issuer: `https://${team}`, audience: aud }));
  } catch {
    return { ok: false, status: 401, code: 'INVALID_ACCESS_TOKEN' };
  }
  const email = typeof payload.email === 'string' ? payload.email : null;
  if (!emailAllowed(email, env.ADMIN_EMAILS)) return { ok: false, status: 403, code: 'NOT_ALLOWLISTED' };
  return { ok: true, email };
}
