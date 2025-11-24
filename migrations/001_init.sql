-- 001_init.sql
-- Initial schema for sales tracking, media pipeline, and rate limiting.

-- meta key-value store
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- sales table: tracks seen/enqueued/posting/posted/failed sales and media workflow
CREATE TABLE IF NOT EXISTS sales (
  sale_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL,
  enqueued_at INTEGER,
  posting_at INTEGER,
  posted_at INTEGER,
  status TEXT NOT NULL CHECK (status IN (
    'seen','queued','fetching_html','capturing_frames','rendering_video','uploading_media','posting','posted','failed'
  )),
  tweet_id TEXT,
  tweet_text TEXT,
  payload TEXT,
  next_attempt_at INTEGER,
  attempt_count INTEGER DEFAULT 0,
  html_path TEXT,
  frames_dir TEXT,
  video_path TEXT,
  media_id TEXT,
  metadata_json TEXT,
  capture_fps REAL
);

CREATE INDEX IF NOT EXISTS idx_sales_status_created ON sales(status, created_at);
CREATE INDEX IF NOT EXISTS idx_sales_posted_at ON sales(posted_at);
CREATE INDEX IF NOT EXISTS idx_sales_queued_ready ON sales(status, next_attempt_at, created_at);

-- seed flags
INSERT INTO meta (key, value)
  SELECT 'initialized', '0'
  WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key='initialized');

-- rate limit bookkeeping (current window start day + used count)
INSERT INTO meta (key, value)
  SELECT 'rate_window_day', ''
  WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key='rate_window_day');
INSERT INTO meta (key, value)
  SELECT 'rate_used', '0'
  WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key='rate_used');
