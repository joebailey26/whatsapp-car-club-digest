import { describe, expect, it } from 'vitest';
import { emailAllowed, normaliseTeamDomain, verifyAccess } from '../src/api/access';
import type { Env } from '../src/types/env';

const baseEnv = {
  ACCESS_TEAM_DOMAIN: '',
  ACCESS_AUD: '',
  BROWSER_IMAGE_VERSION: '0.1.0',
  CONTAINER_INSTANCE: 'standard-1',
} as unknown as Env;

describe('verifyAccess', () => {
  it('fails closed when Access is not configured', async () => {
    const r = await verifyAccess(new Request('https://digest.example.com/admin'), baseEnv);
    expect(r).toEqual({ ok: false, status: 503, code: 'ACCESS_NOT_CONFIGURED' });
  });

  it('rejects requests without an Access token', async () => {
    const env = { ...baseEnv, ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'aud' } as Env;
    const r = await verifyAccess(new Request('https://digest.example.com/admin'), env);
    expect(r).toEqual({ ok: false, status: 401, code: 'MISSING_ACCESS_TOKEN' });
  });

  it('only honours the dev bypass on localhost', async () => {
    const env = { ...baseEnv, DEV_ALLOW_UNAUTHENTICATED: 'true' } as Env;
    expect((await verifyAccess(new Request('http://localhost:8787/admin'), env)).ok).toBe(true);
    expect((await verifyAccess(new Request('https://digest.example.com/admin'), env)).ok).toBe(false);
  });
});

describe('normaliseTeamDomain', () => {
  it('accepts cloudflareaccess.com team domains with or without scheme', () => {
    expect(normaliseTeamDomain('https://MyTeam.cloudflareaccess.com/')).toBe('myteam.cloudflareaccess.com');
  });
  it('rejects arbitrary hosts (JWKS must come from Cloudflare)', () => {
    expect(normaliseTeamDomain('evil.example.com')).toBeNull();
    expect(normaliseTeamDomain('')).toBeNull();
  });
});

describe('emailAllowed', () => {
  it('defers to the Access policy when no allowlist is set', () => {
    expect(emailAllowed('a@b.com', '')).toBe(true);
  });
  it('enforces the allowlist case-insensitively', () => {
    expect(emailAllowed('Me@Example.com', 'me@example.com, other@example.com')).toBe(true);
    expect(emailAllowed('x@example.com', 'me@example.com')).toBe(false);
    expect(emailAllowed(null, 'me@example.com')).toBe(false);
  });
});
