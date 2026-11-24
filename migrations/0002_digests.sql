-- Phase 5: digest delivery log. One row per digest period; prevents duplicate emails
-- and lets a failed send be retried from the stored rendering in R2.
CREATE TABLE digests (
  id              TEXT PRIMARY KEY,           -- digest key, e.g. "2026-11-29" (the Sunday it covers up to)
  created_at      TEXT NOT NULL,
  period_from     TEXT,                       -- previous digest's generated_at (UTC ISO), null for the first
  period_to       TEXT NOT NULL,              -- generated_at of this digest
  r2_key          TEXT NOT NULL,              -- digests/<id>/digest.json
  coverage_complete INTEGER NOT NULL,         -- 0 if any enabled group was not fully processed
  events_upcoming INTEGER NOT NULL,
  status          TEXT NOT NULL,              -- rendered | sending | sent | failed
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  message_id      TEXT,
  sent_at         TEXT,
  recipient_hash  TEXT                        -- sha256 of recipient, so the log has no address in clear
);
CREATE INDEX digests_created ON digests (created_at);
