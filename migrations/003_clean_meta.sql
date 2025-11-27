-- 003_clean_meta.sql
-- Remove unused legacy rate limit keys from meta.

DELETE FROM meta WHERE key IN ('rate_window_day','rate_used');
