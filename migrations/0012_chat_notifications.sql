-- A customer message is not a booking.
--
-- The notifications CHECK only allowed 'public_booking', 'offer_accepted' and
-- 'booking_cancelled'. A question about whether the price covers the wheels
-- had to be filed as one of those or not filed at all, so the operator was
-- never told a message had arrived.
--
-- SQLite cannot alter a CHECK in place, so the table is rebuilt. Rows are
-- carried across rather than dropped: an operator's unread list is theirs.
ALTER TABLE notifications RENAME TO notifications_old;

CREATE TABLE notifications (
  id             TEXT PRIMARY KEY,
  operator_id    TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL
                   CHECK (kind IN ('public_booking','offer_accepted',
                                   'booking_cancelled','chat_message')),
  title          TEXT NOT NULL,
  body           TEXT,
  appointment_id TEXT,
  claim_id       TEXT,
  thread_id      TEXT,          -- so the Inbox can open the conversation
  starts_at      INTEGER,
  read_at        INTEGER,
  created_at     INTEGER NOT NULL
);

INSERT INTO notifications
  (id, operator_id, kind, title, body, appointment_id, claim_id, starts_at, read_at, created_at)
SELECT id, operator_id, kind, title, body, appointment_id, claim_id, starts_at, read_at, created_at
  FROM notifications_old;

DROP TABLE notifications_old;

CREATE INDEX idx_notifications_feed
  ON notifications (operator_id, read_at, created_at DESC);
