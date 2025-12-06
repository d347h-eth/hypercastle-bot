ALTER TABLE sales ADD COLUMN token_id TEXT;
CREATE INDEX idx_sales_token_id_posted ON sales(token_id, status, posted_at);

-- Try to backfill (best effort)
UPDATE sales 
SET token_id = COALESCE(
    json_extract(payload, '$.tokenId'), 
    json_extract(payload, '$.token.tokenId')
) 
WHERE token_id IS NULL;
