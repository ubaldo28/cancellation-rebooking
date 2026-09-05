-- Open for work right now, and estimates asked for in the chat.
--
-- Two things, and they are the two that make this site different from every
-- marketplace it will be compared to.
--
-- 1. THE SWITCH. Until now the only question the site could answer was "who
--    has a gap in their calendar near me". A business could be sitting in a
--    van at eight on a Sunday evening, willing and idle, and be invisible,
--    because willingness was not a thing the schema could hold. Now a business
--    flips a switch -- fixed premises or mobile, any hour, nothing to do with
--    their working hours -- and the site can answer "who is switched on and
--    working right now".
--
--    The rules are deliberately unforgiving in the operator's favour:
--      it turns itself off after 3 hours, and they turn it back on
--      accepting a job turns it off, because they are now busy
--      an incoming job must be ACCEPTED, never auto-assigned
--      unaccepted after 5 minutes it is cancelled and the customer moves on
--
--    That last one is the whole promise on the customer's side. Somebody who
--    wants a job done now cannot be left waiting on a person who wandered
--    off, so the request dies fast and loudly rather than hanging.
--
-- 2. ESTIMATES IN THE CHAT. A customer who wants something that is not on the
--    price list, or wants it a week on Tuesday, had nowhere to ask. They can
--    now ask in the conversation they already have, and the business answers
--    with a price and a time. Accepting turns it into an ordinary Slotfill
--    booking -- paid up front, start code, photos, settlement, all of it.
--    This is not a different business model bolted on; it is the front door
--    to the same one.

-- ---------------------------------------------------------------------------
-- 1. The switch
-- ---------------------------------------------------------------------------
-- A timestamp rather than a boolean, and that is the whole trick. "Are they
-- online" becomes "is online_until in the future", which needs no cron to be
-- correct, cannot get stuck on, and survives a Worker that never ran a sweep.
-- A boolean would need something to turn it off and would lie whenever that
-- something failed -- and the failure mode is a customer booking somebody who
-- went to bed.
ALTER TABLE operators ADD COLUMN online_until INTEGER;

-- When they last flipped it on, so the UI can show "on for 40 minutes" and so
-- a pattern of flipping on and ignoring requests is visible.
ALTER TABLE operators ADD COLUMN online_since INTEGER;

-- How far they will travel for a right-now job, which is a different number
-- from their normal service area: somebody idle will drive further for work
-- in the next hour than they would plan into a Tuesday.
ALTER TABLE operators ADD COLUMN online_radius_meters INTEGER NOT NULL DEFAULT 16000;

CREATE INDEX idx_operators_online ON operators (online_until);

-- ---------------------------------------------------------------------------
-- 2. A job offered to somebody who is switched on
-- ---------------------------------------------------------------------------
-- Not an order and not a booking. It is an offer with a fuse on it, and it
-- becomes a booking only when the operator accepts.
--
-- The customer's details live here rather than being written into clients or
-- appointments, because most of these will expire and never become anything,
-- and a table of half-bookings from people who moved on is a table that has to
-- be explained to every query afterwards.
CREATE TABLE instant_requests (
  id             TEXT PRIMARY KEY,

  operator_id    TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,

  -- What they want and when it would start. starts_at is usually "now" but is
  -- stored rather than assumed, so an operator accepting three minutes later
  -- is agreeing to a time and not to a word.
  service_id     TEXT,
  starts_at      INTEGER NOT NULL,
  duration_seconds INTEGER NOT NULL,
  price_cents    INTEGER NOT NULL,
  currency       TEXT NOT NULL,

  guest_name     TEXT NOT NULL,
  phone_e164     TEXT NOT NULL,
  email          TEXT,
  address_line   TEXT,
  postcode       TEXT,
  lat            REAL,
  lng            REAL,
  note           TEXT,

  -- 'pending'   waiting on the operator, fuse burning
  -- 'accepted'  they took it; order_id points at the booking it became
  -- 'declined'  they said no, and the customer is told immediately
  -- 'expired'   five minutes passed. Not a failure of anybody, and worded
  --             that way to the customer: the site moves them on rather than
  --             blaming a person who was probably driving.
  -- 'cancelled' the customer changed their mind while it was pending
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','accepted','declined','expired','cancelled')),

  -- THE FUSE. Five minutes from creation. Read on every fetch rather than
  -- trusted to a sweep, for the same reason online_until is a timestamp: a
  -- request that is live only because nothing expired it is a request that
  -- will be accepted twenty minutes late.
  expires_at     INTEGER NOT NULL,

  decided_at     INTEGER,
  order_id       TEXT,

  -- The customer's link into the conversation, hashed like every other guest
  -- secret here. Issued when the request is made so they can be told the
  -- answer without an account.
  token_hash     TEXT,

  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- The operator's own screen: what is waiting on me, soonest fuse first.
CREATE INDEX idx_instant_pending ON instant_requests (operator_id, status, expires_at);

-- The expiry sweep, and the customer polling for an answer.
CREATE INDEX idx_instant_expiry ON instant_requests (status, expires_at);
CREATE UNIQUE INDEX idx_instant_token ON instant_requests (token_hash)
  WHERE token_hash IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Estimates, asked for and answered in the chat
-- ---------------------------------------------------------------------------
-- "Can you do the whole house next Thursday?" -- a job that is not on the
-- price list, at a time that is not a posted opening. The customer asks in the
-- thread they already have; the business answers with a price and a time; the
-- customer accepts and it becomes a normal booking.
--
-- Deliberately the same shape as parts_quotes, because it is the same idea one
-- step earlier: one side names an amount, the other side taps approve, and
-- nothing is charged until they do. Somebody who has understood one of these
-- has understood both.
CREATE TABLE estimates (
  id             TEXT PRIMARY KEY,

  thread_id      TEXT NOT NULL,
  operator_id    TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,

  -- What the customer asked for, in their own words. The whole reason this
  -- exists is that it does not fit a dropdown.
  request        TEXT NOT NULL,

  -- The operator's answer. NULL until they reply, which is the state the
  -- customer's screen shows as "waiting on them".
  description    TEXT,
  price_cents    INTEGER,
  duration_seconds INTEGER,
  starts_at      INTEGER,
  currency       TEXT,

  -- 'asked'     the customer asked, nobody has answered
  -- 'quoted'    the business named a price and a time
  -- 'accepted'  the customer took it; order_id is the booking
  -- 'declined'  the customer said no
  -- 'withdrawn' the business took the quote back
  -- 'expired'   the quoted start time passed without an answer
  status         TEXT NOT NULL DEFAULT 'asked'
                   CHECK (status IN ('asked','quoted','accepted','declined',
                                     'withdrawn','expired')),

  expires_at     INTEGER,
  decided_at     INTEGER,
  order_id       TEXT,

  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- The live rows in one conversation.
--
-- NOT a unique index, and that is worth explaining because the first draft of
-- this migration tried to make it one. Parts quotes get a genuine
-- "one live row per booking" unique index and it does real work there. Here
-- the equivalent constraint is "not more than a handful of open questions in
-- one thread", and a unique index cannot express a small number -- the first
-- attempt was UNIQUE (thread_id, id), which includes the primary key and
-- therefore enforces precisely nothing while looking as though it does.
--
-- An index that appears to guarantee something and does not is worse than no
-- index: the next person reads the schema, believes the invariant, and stops
-- checking for it. So the cap lives in estimates.ts where it can be a number,
-- and this index exists only to make the lookup fast.
CREATE INDEX idx_estimates_live ON estimates (thread_id, status);

CREATE INDEX idx_estimates_thread ON estimates (thread_id, created_at DESC);
CREATE INDEX idx_estimates_operator ON estimates (operator_id, status, created_at DESC);
