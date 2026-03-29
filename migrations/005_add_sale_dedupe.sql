CREATE TABLE IF NOT EXISTS sale_dedupe (
  sale_id TEXT PRIMARY KEY,
  token_id TEXT,
  sale_timestamp INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO sale_dedupe (sale_id, token_id, sale_timestamp, first_seen_at)
SELECT sale_id, token_id, created_at, seen_at
FROM sales;
