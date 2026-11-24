import { handleAdmin } from './api/admin';
import type { Env } from './types/env';

export { BrowserController } from './container/controller';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      return handleAdmin(request, env);
    }
    // Nothing else is public.
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const stub = env.CONTROLLER.get(env.CONTROLLER.idFromName('controller'));
    ctx.waitUntil(
      stub.scheduledTick(controller.cron, controller.scheduledTime).then(
        (r) => console.log(JSON.stringify({ level: 'info', event: 'scheduled_tick', cron: controller.cron, result: r })),
        (err: unknown) => console.error(JSON.stringify({ level: 'error', event: 'scheduled_tick_failed', cron: controller.cron, error: err instanceof Error ? err.name : 'unknown' })),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
