-- Stop the cron burning the D1 write budget.
--
-- The cron re-detected gaps for EVERY operator every 15 minutes, and the gap
-- upsert wrote a row whether or not anything had changed. That is ~3,840 row
-- writes per operator per day against a 100,000/day free-tier ceiling — the
-- whole allowance gone at 26 operators, before a single client is texted.
--
-- Fix: operators carry a calendar version, bumped by anything that can move a
-- gap (a booking, a completion, a cancellation, a change to working hours or
-- time off). The cron only rescans operators whose version has moved since
-- their last scan, plus a daily pass to roll the 14-day window forward.

ALTER TABLE operators ADD COLUMN calendar_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE operators ADD COLUMN scanned_version  INTEGER NOT NULL DEFAULT -1;
ALTER TABLE operators ADD COLUMN last_scan_at     INTEGER;

-- The cron's selection query: cheap, and bounded by the batch it takes.
CREATE INDEX idx_operators_scan ON operators (plan, last_scan_at);
