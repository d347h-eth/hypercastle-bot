-- 002_add_media_uploaded_at.sql
-- Track when media was uploaded so we can re-upload after 24h.

ALTER TABLE sales ADD COLUMN media_uploaded_at INTEGER;
