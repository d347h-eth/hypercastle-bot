-- 002_retry_and_indexes.sql
-- Add retry/backoff columns and helpful indexes; prune meta

ALTER TABLE sales ADD COLUMN next_attempt_at INTEGER;
ALTER TABLE sales ADD COLUMN attempt_count INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_sales_queued_ready
  ON sales(status, next_attempt_at, created_at);

INSERT INTO meta(key,value)
  SELECT 'last_prune_at', ''
  WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key='last_prune_at');

