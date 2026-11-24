-- WhatsApp Car Club Digest: initial schema (Phase 3).
-- Message bodies are NOT stored in D1: they live in R2 (messages.json, 30-day lifecycle).
-- D1 holds metadata, message IDs for deduplication, and (from Phase 4) structured events.

-- One row per group export attempt (mirrors the Durable Object export record).
CREATE TABLE exports (
  id                    TEXT PRIMARY KEY,           -- "<runId>-<groupId>"
  run_id                TEXT NOT NULL,
  group_id              TEXT NOT NULL,
  date_from             TEXT,                       -- processing window start (YYYY-MM-DD, Europe/London)
  date_to               TEXT,
  r2_key                TEXT,                       -- original.zip
  checksum              TEXT,                       -- sha256 of original.zip
  bytes                 INTEGER,
  status                TEXT NOT NULL,              -- export status: succeeded | failed | wrong_chat | logged_out | corrupt | skipped
  error_code            TEXT,
  created_at            TEXT NOT NULL,
  -- processing (Phase 3)
  processing_status     TEXT,                       -- processed | empty | failed
  processing_error      TEXT,
  processed_at          TEXT,
  messages_total        INTEGER,                    -- parsed from the whole transcript
  messages_in_window    INTEGER,
  messages_new          INTEGER,                    -- not seen in any earlier export
  messages_duplicate    INTEGER,
  invalid_dates         INTEGER,
  date_order            TEXT,                       -- DMY | MDY
  date_order_ambiguous  INTEGER,                    -- 1 if decided by hint
  first_message_at      TEXT,
  last_message_at       TEXT,
  messages_r2_key       TEXT
);
CREATE INDEX exports_group_created ON exports (group_id, created_at);

-- Deduplication index. No content: id, group, timestamp, provenance only.
CREATE TABLE messages_seen (
  id             TEXT PRIMARY KEY,                  -- deterministic message id
  group_id       TEXT NOT NULL,
  ts             TEXT NOT NULL,                     -- UTC ISO
  export_id      TEXT NOT NULL,                     -- first export it was seen in
  first_seen_at  TEXT NOT NULL
);
CREATE INDEX messages_seen_group_ts ON messages_seen (group_id, ts);

CREATE TABLE runs (
  id                  TEXT PRIMARY KEY,
  started_at          TEXT NOT NULL,
  completed_at        TEXT,
  status              TEXT NOT NULL,
  error_code          TEXT,
  groups_processed    INTEGER,
  messages_processed  INTEGER,
  ai_tokens_used      INTEGER
);

-- Phase 4+ (created now so the schema matches the spec's entities).
CREATE TABLE events (
  id             TEXT PRIMARY KEY,
  group_id       TEXT NOT NULL,
  title          TEXT NOT NULL,
  event_date     TEXT,                              -- YYYY-MM-DD, null if unknown
  start_time     TEXT,                              -- HH:MM, null if unknown
  timezone       TEXT NOT NULL DEFAULT 'Europe/London',
  location       TEXT,
  meeting_point  TEXT,
  status         TEXT NOT NULL,                     -- tentative | confirmed | updated | cancelled
  confidence     REAL,
  rsvp_required  INTEGER NOT NULL DEFAULT 0,
  rsvp_deadline  TEXT,
  notes          TEXT,
  needs_review   INTEGER NOT NULL DEFAULT 0,        -- conflicting evidence
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX events_date ON events (event_date);

CREATE TABLE event_sources (
  event_id          TEXT NOT NULL REFERENCES events (id),
  message_id        TEXT NOT NULL,
  export_id         TEXT NOT NULL,
  evidence_excerpt  TEXT,
  PRIMARY KEY (event_id, message_id)
);

-- Revision history so the digest can say exactly what changed.
CREATE TABLE event_revisions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT NOT NULL REFERENCES events (id),
  changed_at  TEXT NOT NULL,
  field       TEXT NOT NULL,
  old_value   TEXT,
  new_value   TEXT,
  message_id  TEXT
);
CREATE INDEX event_revisions_event ON event_revisions (event_id, changed_at);
