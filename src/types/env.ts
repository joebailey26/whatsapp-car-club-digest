import type { BrowserController } from '../container/controller';

export interface Env {
  CONTROLLER: DurableObjectNamespace<BrowserController>;
  EXPORTS: R2Bucket;
  DB: D1Database;
  AI: Ai;
  EMAIL: SendEmail;
  DIGEST_FROM?: string;
  DIGEST_TO?: string;
  ALERT_TO?: string;
  WORKER_URL?: string;
  AI_MONTHLY_TOKEN_ALERT?: string;
  AI_MODEL?: string;
  AI_MAX_CHUNKS_PER_RUN?: string;
  AI_MAX_TOKENS_PER_RUN?: string;
  /** HMAC key for phone-number author pseudonyms (wrangler secret). */
  PSEUDONYM_KEY: string;
  EXPORT_TIMEZONE?: string;
  EXPORT_DATE_ORDER_HINT?: string;

  BROWSER_IMAGE_VERSION: string;
  CONTAINER_INSTANCE: string;

  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ADMIN_EMAILS?: string;

  PAIRING_TTL_MS?: string;
  POST_AUTH_SETTLE_MS?: string;
  RESTORE_SETTLE_MS?: string;
  OP_DEADLINE_MS?: string;

  /** Local `wrangler dev` only (set in .dev.vars); ignored unless the request host is localhost. */
  DEV_ALLOW_UNAUTHENTICATED?: string;
}
