-- Marketplace collector (issue #4). Source-agnostic listing tables, separate from the
-- WhatsApp-specific `listings` / `listing_sources` tables, which are left untouched.
-- Only visible listing data is stored: no seller names, messages, cookies or credentials.

CREATE TABLE market_searches (
  id          TEXT PRIMARY KEY,            -- short slug, e.g. "ramsey-pre2010-under1k"
  source      TEXT NOT NULL,               -- facebook_marketplace
  label       TEXT NOT NULL,
  url         TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  max_scrolls INTEGER NOT NULL DEFAULT 2,
  baseline_done_at TEXT,                   -- first successful collection; before it nothing alerts
  last_ok_at  TEXT,
  last_error  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE market_listings (
  id               TEXT PRIMARY KEY,       -- "<source>:<source_id>"
  source           TEXT NOT NULL,
  source_id        TEXT NOT NULL,
  url              TEXT NOT NULL,          -- canonical original advert URL
  title            TEXT NOT NULL,
  price_pence      INTEGER,                -- current asking price; NULL when not shown / "Free" ambiguity
  currency         TEXT,
  location         TEXT,
  distance_miles   REAL,                   -- from the configured home point; NULL when unknown
  distance_basis   TEXT,                   -- town | county | unknown
  year             INTEGER,                -- only when stated
  mileage          INTEGER,                -- only when stated
  description      TEXT,                   -- short, truncated; only when a detail page was read
  published_text   TEXT,                   -- exactly as shown, e.g. "Listed 2 hours ago"; never inferred
  photo_ref        TEXT,
  first_seen_at    TEXT NOT NULL,          -- first DISCOVERED by us, not when it was posted
  last_seen_at     TEXT NOT NULL,
  first_search_id  TEXT,
  status           TEXT NOT NULL DEFAULT 'active',   -- active | missing
  baseline         INTEGER NOT NULL DEFAULT 0,       -- seen in a search's first (baseline) run: never alerted as new
  score            INTEGER,
  route            TEXT,                   -- urgent | review | low
  reasons          TEXT,                   -- JSON array of short rule explanations
  ruleset_version  TEXT,
  ai_priority      TEXT,                   -- high | daily | ignore (optional borderline classification)
  ai_reason        TEXT,
  ai_confidence    REAL,
  ai_at            TEXT,
  review_state     TEXT NOT NULL DEFAULT 'new',      -- new | interested | passed | ignored
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (source, source_id)
);
CREATE INDEX market_listings_seen ON market_listings (last_seen_at);
CREATE INDEX market_listings_route ON market_listings (route, first_seen_at);

CREATE TABLE market_price_history (
  listing_id   TEXT NOT NULL REFERENCES market_listings (id),
  observed_at  TEXT NOT NULL,
  price_pence  INTEGER,
  run_id       TEXT NOT NULL,
  PRIMARY KEY (listing_id, run_id)
);

-- One row per (listing, notification class, dedupe key). The primary key is the dedupe:
-- urgent_new uses key "new", price drops use the new price, the roundup uses "daily".
CREATE TABLE market_notifications (
  listing_id  TEXT NOT NULL REFERENCES market_listings (id),
  class       TEXT NOT NULL,               -- urgent_new | urgent_price_drop | urgent_ai | urgent_manual | daily
  dedupe_key  TEXT NOT NULL,
  status      TEXT NOT NULL,               -- pending | sent | failed | suppressed
  run_id      TEXT,
  created_at  TEXT NOT NULL,
  sent_at     TEXT,
  error       TEXT,
  PRIMARY KEY (listing_id, class, dedupe_key)
);
CREATE INDEX market_notifications_status ON market_notifications (class, status, created_at);

CREATE TABLE market_feedback (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id       TEXT NOT NULL REFERENCES market_listings (id),
  action           TEXT NOT NULL,          -- interested | pass | ignore | send_alert
  reason           TEXT,
  score            INTEGER,
  route            TEXT,
  ruleset_version  TEXT,
  actor            TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX market_feedback_listing ON market_feedback (listing_id, created_at);

CREATE TABLE market_runs (
  id               TEXT PRIMARY KEY,
  trigger          TEXT NOT NULL,          -- scheduled | manual | dry_run
  started_at       TEXT NOT NULL,
  completed_at     TEXT,
  status           TEXT NOT NULL,          -- ok | partial | auth_failed | failed | skipped
  error_code       TEXT,
  searches_ok      INTEGER NOT NULL DEFAULT 0,
  searches_failed  INTEGER NOT NULL DEFAULT 0,
  items_seen       INTEGER NOT NULL DEFAULT 0,
  new_count        INTEGER NOT NULL DEFAULT 0,
  price_drops      INTEGER NOT NULL DEFAULT 0,
  urgent_count     INTEGER NOT NULL DEFAULT 0,
  review_count     INTEGER NOT NULL DEFAULT 0,
  alert_email_sent_at TEXT,
  first_seen_to_email_ms INTEGER,          -- worst case in this run
  instance         TEXT,
  billable_ms      INTEGER,                -- container start request → confirmed stop
  timings          TEXT                    -- JSON: startup, navigation, collect, snapshot, shutdown
);
CREATE INDEX market_runs_started ON market_runs (started_at);
