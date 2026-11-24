-- Sale listings: members' cars and parts for sale, with evidence and revision history.
-- No message bodies beyond short evidence excerpts (same as events).
CREATE TABLE listings (
  id              TEXT PRIMARY KEY,
  group_id        TEXT NOT NULL,
  kind            TEXT NOT NULL,            -- car | part
  title           TEXT NOT NULL,
  make            TEXT,
  model           TEXT,
  year            INTEGER,
  price           TEXT,                     -- as written, e.g. "£4,500 ono"
  mileage         TEXT,
  location        TEXT,
  details         TEXT,
  status          TEXT NOT NULL,            -- available | sold | withdrawn
  seller          TEXT,                     -- display name or pseudonym
  first_posted_at TEXT NOT NULL,            -- UTC ISO of the first supporting message
  last_seen_at    TEXT NOT NULL,            -- UTC ISO of the latest supporting message
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX listings_group_seller ON listings (group_id, seller);
CREATE INDEX listings_last_seen ON listings (last_seen_at);

CREATE TABLE listing_sources (
  listing_id       TEXT NOT NULL REFERENCES listings (id),
  message_id       TEXT NOT NULL,
  export_id        TEXT NOT NULL,
  evidence_excerpt TEXT,
  PRIMARY KEY (listing_id, message_id)
);

CREATE TABLE listing_revisions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id  TEXT NOT NULL REFERENCES listings (id),
  changed_at  TEXT NOT NULL,
  field       TEXT NOT NULL,               -- created | price | status | make | model | mileage | location | details
  old_value   TEXT,
  new_value   TEXT,
  message_id  TEXT
);
CREATE INDEX listing_revisions_listing ON listing_revisions (listing_id, changed_at);
