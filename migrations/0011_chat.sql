-- Letting the customer and the business talk, inside the app.
--
-- Two questions currently have nowhere to go. Before booking: "does that price
-- include the inside of the windows?" After booking: "I'll leave the gate
-- unlocked." Today the only answer is to swap phone numbers, and the operator
-- has been explicit that they will not do that -- no number exchange, no SMS.
-- A number handed over once is handed over forever, and the platform stops
-- being able to see, moderate or end the conversation it started.
--
-- So the conversation lives here, in text, in the app. The existing `messages`
-- table is not it: that one is the SMS/device pipeline, with carriers,
-- provider ids and delivery costs. Mixing a free in-app thread into a table
-- whose rows cost money to send would be a billing bug waiting to happen, so
-- the chat gets its own tables.

-- One conversation between one operator and one customer.
CREATE TABLE threads (
  id                TEXT PRIMARY KEY,
  operator_id       TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,

  -- The opening they are asking about. Set when the conversation starts from
  -- the public slot page, which is *before* any booking exists -- that is the
  -- whole point: most of these questions decide whether there is a booking at
  -- all, so the thread cannot be made to wait for one.
  gap_id            TEXT,

  -- Filled in later, if and when they book. Deliberately not foreign keys, for
  -- the same reason the notifications table avoids them: a cancelled booking
  -- that gets cleaned up must not take the conversation about it with it, and
  -- ON DELETE CASCADE here would silently erase the record of what was agreed.
  appointment_id    TEXT,
  client_id         TEXT,

  -- The customer has no account and never will. Asking a stranger to pick a
  -- password before they can ask one question loses the question and the
  -- booking behind it; and an account we would then have to secure, reset and
  -- delete is a liability we get nothing for. Their name is what they typed
  -- and their identity is the secret link, nothing more.
  guest_name        TEXT NOT NULL,

  -- The hash of the secret in that link, never the secret itself, hashed with
  -- the server pepper exactly like sessions and offer tokens. The link is
  -- bearer authority: anyone holding it can read and write this conversation.
  -- If we stored it raw, a leaked or dumped database would be a working set of
  -- keys to every stranger's conversation -- names, addresses, gate codes --
  -- with nothing to revoke. Hashed, the dump is inert.
  guest_token_hash  TEXT NOT NULL,

  subject           TEXT,

  -- Denormalised so the operator's inbox is one indexed read rather than a
  -- correlated MAX(created_at) over every message they have ever received.
  last_message_at   INTEGER NOT NULL,

  -- Per-side unread counts, kept on the thread. Read markers in the message
  -- table would mean a second query for every badge, and the guest has no
  -- account to hang a marker on.
  operator_unread   INTEGER NOT NULL DEFAULT 0,
  guest_unread      INTEGER NOT NULL DEFAULT 0,

  -- 'closed' ends the conversation without deleting it: the link stops
  -- accepting messages but still reads, so what was agreed stays visible.
  status            TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','closed')),

  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- One live link per conversation. A duplicate hash would mean two threads
-- answering to the same secret, and whichever one a lookup happened to return
-- first would decide whose messages a stranger sees.
CREATE UNIQUE INDEX idx_threads_guest_token ON threads (guest_token_hash);

-- The operator's inbox: their threads, most recently active first.
-- operator_id leads because it is the tenant boundary, and no query against
-- this table is ever allowed to omit it.
CREATE INDEX idx_threads_operator ON threads (operator_id, last_message_at DESC);

-- The messages themselves. Named chat_messages so it cannot be confused with
-- `messages`, which is SMS and costs money per row.
CREATE TABLE chat_messages (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,

  -- Only two participants exist, so this is a flag rather than a user id --
  -- there is no guest user row to point at, by design.
  sender      TEXT NOT NULL CHECK (sender IN ('guest','operator')),

  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Every read this table gets: one thread, oldest first, as a transcript.
CREATE INDEX idx_chat_messages_thread ON chat_messages (thread_id, created_at);
