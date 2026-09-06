-- Two quarter-hourly sweeps that read a whole table to find a handful of rows.
--
-- Every other table swept on the cron tick was given an index shaped for its
-- sweep when the sweep was written: parts_quotes has (status, expires_at) from
-- 0020, order_items has (settlement, hold_until) from 0025, instant_requests
-- has (status, expires_at) from 0029, distance_cache has (expires_at) from
-- 0001. These two were missed.
--
--   gap_offers   "expire offers"  WHERE status IN ('sent','delivered',
--                                   'viewed','queued') AND expires_at <= ?
--   gaps         "release gaps"   WHERE status = 'offering'
--                                   AND NOT EXISTS (... live offers ...)
--
-- EXPLAIN QUERY PLAN answers `SCAN gap_offers` and `SCAN gaps` for those two.
-- Both tables already carry indexes that look as though they cover them and do
-- not: idx_offers_live is (operator_id, status, expires_at) and idx_gaps_open
-- is (operator_id, status, starts_at), and a query that names no operator
-- cannot use a leading operator_id column. gap_offers is the one that hurts —
-- it holds every invitation ever sent, nothing deletes from it, and the sweep
-- reads all of it four times an hour to find the ones that lapsed since the
-- last tick.
--
-- gaps is only half of the same story, and worth being exact about: the two
-- sweeps that also give it a starts_at range already fall onto idx_gaps_window,
-- the partial unique index from 0001, which covers only the open and offering
-- rows. The release sweep has no range to give — it asks for a status and
-- nothing else — so it gets neither that nor idx_gaps_open, and reads the whole
-- table including every gap that has ever been filled or expired.
--
-- Neither index enforces anything and neither changes a result.

-- status leads because both sweeps pin it; expires_at trails because it is
-- asked as a range, which is the order that lets SQLite seek rather than scan.
CREATE INDEX IF NOT EXISTS idx_offers_expiry ON gap_offers (status, expires_at);

-- Same shape and the same reason. starts_at is here rather than the index
-- being on status alone so the two sweeps that do carry a time range can use
-- it too, and so it stays useful if the release sweep ever grows one.
CREATE INDEX IF NOT EXISTS idx_gaps_live ON gaps (status, starts_at);
