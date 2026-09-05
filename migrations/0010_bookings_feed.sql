-- Telling the operator their day changed.
--
-- A stranger can already take a slot from the public page. claimSlot writes a
-- client, an appointment and a claim, and then stops. Nothing reaches the
-- person whose day it is. Three people can book overnight and the only way to
-- find out is to open the calendar and notice.
--
-- There is no email provider on this account and no SMS, so the app itself has
-- to be where the news arrives. This table is that record: one row per thing
-- that happened to an operator's day, written by whatever caused it.
CREATE TABLE notifications (
  id              TEXT PRIMARY KEY,
  operator_id     TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,

  -- A closed set, so the feed can label and style a row without reading the
  -- title. Free text here would have been three spellings of the same event
  -- inside a month.
  kind            TEXT NOT NULL
                    CHECK (kind IN ('public_booking','offer_accepted','booking_cancelled')),

  -- The sentence the operator reads, written at the moment it happened.
  -- Rebuilding it later from joins would show today's price and today's client
  -- record for a booking made weeks ago, and a booking that has since been
  -- cancelled and cleaned up would leave the row with nothing to say at all.
  title           TEXT NOT NULL,
  body            TEXT,

  -- Deliberately not foreign keys. The point of the feed is that it still says
  -- "Rosa booked Thursday" after the appointment is deleted; ON DELETE CASCADE
  -- would erase the only trace, and a hard reference would block the delete.
  -- A row whose appointment has gone still reads correctly, it just cannot be
  -- opened.
  appointment_id  TEXT,
  claim_id        TEXT,

  -- When the job is. The operator reads this feed asking what is about to hit
  -- their week, which is not the same question as when the message arrived, so
  -- both times are kept.
  starts_at       INTEGER,

  -- NULL until the operator has seen it. A separate table of read markers was
  -- the alternative and it needs a second query for every badge.
  read_at         INTEGER,
  created_at      INTEGER NOT NULL
);

-- Every read this table gets: one operator's rows, sometimes only the unread
-- ones, newest first. operator_id leads because it is the tenant boundary and
-- no query is ever allowed to omit it.
CREATE INDEX idx_notifications_operator
  ON notifications (operator_id, read_at, created_at DESC);
