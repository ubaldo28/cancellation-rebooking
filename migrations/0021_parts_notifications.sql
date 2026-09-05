-- A parts decision is not a chat message.
--
-- Migration 0020 gave the customer a button that commits them to paying more
-- money. The operator has to hear about it landing, and the notifications
-- CHECK from 0012 only allows 'public_booking', 'offer_accepted',
-- 'booking_cancelled' and 'chat_message'. Filing "Rosa approved $240 of
-- parts" as a chat message puts it behind the same generic label as "I'll
-- leave the gate unlocked", and an operator standing next to a car waiting to
-- know whether to order the part will miss it.
--
-- SQLite cannot alter a CHECK in place, so the table is rebuilt, exactly as
-- 0012 did. Rows are carried across rather than dropped: an operator's unread
-- list is theirs.
ALTER TABLE notifications RENAME TO notifications_old;

CREATE TABLE notifications (
  id             TEXT PRIMARY KEY,
  operator_id    TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL
                   CHECK (kind IN ('public_booking','offer_accepted',
                                   'booking_cancelled','chat_message',
                                   -- The customer answered a parts quote, either
                                   -- way. A decline is as urgent as an approval:
                                   -- it is the operator's cue to stop and talk,
                                   -- not to fit anything.
                                   'parts_quote')),
  title          TEXT NOT NULL,
  body           TEXT,
  appointment_id TEXT,
  claim_id       TEXT,
  thread_id      TEXT,
  starts_at      INTEGER,
  read_at        INTEGER,
  created_at     INTEGER NOT NULL
);

INSERT INTO notifications
  (id, operator_id, kind, title, body, appointment_id, claim_id, thread_id,
   starts_at, read_at, created_at)
SELECT id, operator_id, kind, title, body, appointment_id, claim_id, thread_id,
       starts_at, read_at, created_at
  FROM notifications_old;

DROP TABLE notifications_old;

CREATE INDEX idx_notifications_feed
  ON notifications (operator_id, read_at, created_at DESC);
