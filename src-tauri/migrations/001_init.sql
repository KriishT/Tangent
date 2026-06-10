-- Tangent schema (see docs/04-technical-feasibility.md)
CREATE TABLE IF NOT EXISTS thoughts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  body          TEXT NOT NULL,            -- cleaned text (or raw if no cleanup)
  raw_body      TEXT,                     -- original transcript before cleanup
  cleanup_tier  TEXT,                     -- null | 'rules' | 'local_llm' | 'cloud'
  created_at    TEXT NOT NULL,            -- ISO timestamp
  source        TEXT NOT NULL,            -- 'voice' | 'type'
  audio_path    TEXT,
  -- work context
  ctx_app       TEXT,
  ctx_title     TEXT,
  ctx_detail    TEXT,
  -- triage
  bucket        TEXT,                     -- null | 'do_now' | 'do_soon' | 'later' | 'idea' | 'done' | 'dropped'
  due_at        TEXT,
  priority      INTEGER,
  resurface_at  TEXT,
  notified_at   TEXT,
  triaged_at    TEXT,
  completed_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_thoughts_bucket ON thoughts(bucket);
CREATE INDEX IF NOT EXISTS idx_thoughts_due ON thoughts(due_at);
CREATE INDEX IF NOT EXISTS idx_thoughts_resurface ON thoughts(resurface_at);
CREATE INDEX IF NOT EXISTS idx_thoughts_created ON thoughts(created_at);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
