-- An entirely unbooked working day is not a cancellation.
--
-- Gap detection subtracts booked jobs from the working window, so a day with
-- no jobs at all produces one gap covering the whole day. The dashboard was
-- then offering "08:00-18:00, 10h free" beside a real 3-hour hole between two
-- jobs, with the same "Fill this slot" button. Nobody fills ten hours with one
-- job, and mixing the two buries the gap that is actually worth acting on.
--
-- This flag lets the app say "nothing booked" for an empty day and keep
-- "fill this slot" for a genuine hole in a working day.
ALTER TABLE gaps ADD COLUMN fills_whole_day INTEGER NOT NULL DEFAULT 0
  CHECK (fills_whole_day IN (0,1));

CREATE INDEX idx_gaps_whole_day ON gaps (operator_id, fills_whole_day, starts_at);
