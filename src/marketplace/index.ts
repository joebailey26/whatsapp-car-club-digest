import { handleMarketAdmin } from './admin';
import type { MarketEnv } from './env';

export { MarketplaceController } from './controller';

/**
 * Entry point of the separate `car-marketplace-alerts` Worker
 * (wrangler.marketplace.jsonc). Deployed independently of the WhatsApp digest
 * Worker, so a Marketplace deploy never restarts the WhatsApp controller or
 * touches its container image and snapshot.
 */
export default {
  async fetch(request: Request, env: MarketEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return handleMarketAdmin(request, env);
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  },

  async scheduled(controller: ScheduledController, env: MarketEnv, ctx: ExecutionContext): Promise<void> {
    const stub = env.MARKET_CONTROLLER.get(env.MARKET_CONTROLLER.idFromName('marketplace'));
    ctx.waitUntil(
      stub.scheduledTick(controller.scheduledTime).then(
        (r) => console.log(JSON.stringify({ level: 'info', event: 'market_tick', cron: controller.cron, result: r })),
        (err: unknown) => console.error(JSON.stringify({ level: 'error', event: 'market_tick_failed', error: err instanceof Error ? err.name : 'unknown' })),
      ),
    );
  },
} satisfies ExportedHandler<MarketEnv>;
