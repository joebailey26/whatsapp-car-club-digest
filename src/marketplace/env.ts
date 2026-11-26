import type { MarketplaceController } from './controller';

/** Bindings and vars of the separate `car-marketplace-alerts` Worker (wrangler.marketplace.jsonc). */
export interface MarketEnv {
  MARKET_CONTROLLER: DurableObjectNamespace<MarketplaceController>;
  DB: D1Database;
  AI: Ai;
  EMAIL: SendEmail;

  /** Must equal marketplace-browser/package.json "version". Snapshots are tied to it. */
  MARKET_IMAGE_VERSION: string;
  MARKET_CONTAINER_INSTANCE: string;

  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ADMIN_EMAILS?: string;

  ALERT_FROM?: string;
  ALERT_TO?: string;
  WORKER_URL?: string;
  LOGIN_TTL_MS?: string;

  /** Local `wrangler dev` only (set in .dev.vars); ignored unless the request host is localhost. */
  DEV_ALLOW_UNAUTHENTICATED?: string;
}
