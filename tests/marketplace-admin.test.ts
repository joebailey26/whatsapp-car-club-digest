import { describe, expect, it, vi } from 'vitest';
import { handleMarketAdmin } from '../src/marketplace/admin';
import type { MarketEnv } from '../src/marketplace/env';
import { planIngest } from '../src/marketplace/ingest';
import { parseCard } from '../src/marketplace/parse';
import { DEFAULT_SCORING } from '../src/marketplace/score';

const listing = planIngest(
  [{ card: parseCard({ href: '/marketplace/item/123456789/', lines: ['£750', 'Mazda MX-5', 'Ramsey'] })!, detail: null, searchId: 's' }],
  new Map(),
  { now: '2026-11-25T10:07:00.000Z', scoring: DEFAULT_SCORING, baselineSearches: new Set() },
).items[0]!.listing;

function env(over: Partial<MarketEnv> = {}) {
  const stub = {
    getListing: vi.fn(async () => ({ listing })),
    feedback: vi.fn(async () => ({ ok: true, listing })),
    getStatus: vi.fn(async () => ({ phase: 'idle' })),
  };
  const e = {
    MARKET_CONTROLLER: { idFromName: () => 'id', get: () => stub },
    ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
    ACCESS_AUD: 'aud',
    DEV_ALLOW_UNAUTHENTICATED: 'true',
    ...over,
  } as unknown as MarketEnv;
  return { e, stub };
}

const id = encodeURIComponent('facebook_marketplace:123456789');

describe('feedback security', () => {
  it('the review page linked from emails only displays: a prefetching scanner cannot vote', async () => {
    const { e, stub } = env();
    const res = await handleMarketAdmin(new Request(`http://localhost/admin/review/${id}`), e);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Mazda MX-5');
    expect(html).toContain('Nothing is recorded until you press a button');
    expect(stub.feedback).not.toHaveBeenCalled();
    expect(res.headers.get('content-security-policy')).toContain("form-action 'none'");
  });
  it('rejects a vote without the CSRF header', async () => {
    const { e, stub } = env();
    const res = await handleMarketAdmin(new Request(`http://localhost/admin/api/listings/${id}/feedback`, { method: 'POST', body: '{"action":"interested"}' }), e);
    expect(res.status).toBe(403);
    expect(stub.feedback).not.toHaveBeenCalled();
  });
  it('accepts a vote with the CSRF header', async () => {
    const { e, stub } = env();
    const res = await handleMarketAdmin(
      new Request(`http://localhost/admin/api/listings/${id}/feedback`, { method: 'POST', headers: { 'x-requested-with': 'market-admin' }, body: '{"action":"interested"}' }),
      e,
    );
    expect(res.status).toBe(200);
    expect(stub.feedback).toHaveBeenCalledWith('facebook_marketplace:123456789', { action: 'interested' }, 'local-dev');
  });
  it('fails closed without Access outside local dev', async () => {
    const { e } = env({ DEV_ALLOW_UNAUTHENTICATED: undefined, ACCESS_AUD: '' });
    expect((await handleMarketAdmin(new Request(`https://car.example/admin/review/${id}`), e)).status).toBe(503);
    const { e: e2 } = env({ DEV_ALLOW_UNAUTHENTICATED: undefined });
    expect((await handleMarketAdmin(new Request(`https://car.example/admin/review/${id}`), e2)).status).toBe(401);
  });
  it('rejects malformed listing IDs', async () => {
    const { e } = env();
    expect((await handleMarketAdmin(new Request('http://localhost/admin/review/..%2F..%2Fetc'), e)).status).toBe(400);
  });
});
