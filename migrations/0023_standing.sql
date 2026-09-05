-- Cards on file, a 48-hour line, and what happens when somebody does not turn up.
--
-- Three changes, and they are one idea: both sides commit something real
-- before a booking exists, so that breaking the booking costs the person who
-- broke it rather than the person who was let down.
--
--   1. Neither side can transact without a card on file. The operator's card
--      is what a lead fee is charged to; the customer's is what the job is
--      charged to. Before this, a fee was a number in a table that nobody
--      could ever collect.
--   2. The line moves from two hours to forty-eight, and it now cuts both
--      ways. Inside 48 hours the customer cannot cancel at all and is not
--      refunded, because the operator has held the slot and turned work away
--      for it. Inside 48 hours the operator pays half the job, because the
--      customer has arranged their day around it.
--   3. A no-show is not a fee. It is a suspension, and it escalates.
--
-- The fee percentages and the window live in bypass.ts, not here: they are
-- policy and they will be tuned. What lives here is the shape that makes them
-- enforceable.

-- ---------------------------------------------------------------------------
-- 1. A card on file, on both sides
-- ---------------------------------------------------------------------------
-- NO CARD NUMBER IS EVER STORED IN THIS DATABASE, and none of these columns
-- can hold one. What is stored is the processor's own reference to a card the
-- processor holds -- the thing you charge with, which is useless to anyone who
-- steals this table -- plus the last four digits and the brand, which exist
-- only so a person can tell which of their cards this is. A PAN in here would
-- put this project inside PCI scope for no benefit whatsoever, and the whole
-- reason processors sell this is so that never has to happen.
ALTER TABLE operators ADD COLUMN payment_ref TEXT;
ALTER TABLE operators ADD COLUMN payment_brand TEXT;
ALTER TABLE operators ADD COLUMN payment_last4 TEXT;
ALTER TABLE operators ADD COLUMN payment_added_at INTEGER;

-- The customer's card, on the order that used it. On the order rather than on
-- a customer record because there is no customer record: they have no account,
-- by design, and the order is the only durable thing they own here.
ALTER TABLE orders ADD COLUMN payment_ref TEXT;
ALTER TABLE orders ADD COLUMN payment_brand TEXT;
ALTER TABLE orders ADD COLUMN payment_last4 TEXT;

-- ---------------------------------------------------------------------------
-- 2. The operator's standing
-- ---------------------------------------------------------------------------
-- A suspension stops an account listing and taking new work. It never touches
-- work already booked: a customer who has paid gets their appointment whatever
-- their operator has done, and punishing the customer for the operator's
-- record would be the platform failing the exact person it is supposed to
-- protect.
--
-- suspended_until is a timestamp rather than a flag so the suspension ends by
-- itself. A flag needs somebody to remember to clear it, and the person it
-- would be forgotten for is always the one with the least ability to chase it.
ALTER TABLE operators ADD COLUMN suspended_until INTEGER;
ALTER TABLE operators ADD COLUMN banned_at INTEGER;

-- ---------------------------------------------------------------------------
-- 3. The customer's standing
-- ---------------------------------------------------------------------------
-- Keyed on the phone number, because that is the only durable identity a
-- customer has here -- there is no account and there is not going to be one.
-- That is a real limitation and it is worth being honest about it: a new
-- number is a clean record. It is still worth having, because the behaviour
-- this deters is casual rather than determined, and the alternative -- making
-- everybody sign up so we can suspend them -- costs more bookings than
-- no-shows ever will.
CREATE TABLE customer_standing (
  phone_e164      TEXT PRIMARY KEY,

  -- How many confirmed no-shows. Drives the ladder in standing.ts; kept as a
  -- count rather than derived from the reports table so the gate on the
  -- booking path is one indexed read.
  no_show_strikes INTEGER NOT NULL DEFAULT 0,

  suspended_until INTEGER,
  banned_at       INTEGER,

  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- 4. Somebody did not turn up
-- ---------------------------------------------------------------------------
-- A report, not a verdict. Either side can file one and neither side's filing
-- does anything on its own.
--
-- THIS IS DELIBERATELY NOT AUTOMATIC, and the reason is worth writing down
-- because the shortcut is tempting every single time. An operator who did the
-- job and forgot to tap "I'm here" leaves exactly the same trace as one who
-- never went. A cron job cannot tell those apart, and the one it would punish
-- is the operator who was working. The same holds in reverse: an operator who
-- wants a customer suspended can simply say they did not answer the door, and
-- an auto-applied strike hands that operator a weapon.
--
-- So a report sits at 'open' until a person confirms it, and only the confirm
-- moves the ladder.
CREATE TABLE no_show_reports (
  id             TEXT PRIMARY KEY,

  order_item_id  TEXT NOT NULL,

  -- Who is being reported: 'operator' (they never came) or 'customer' (they
  -- were not there). The side filing is always the other one.
  against        TEXT NOT NULL CHECK (against IN ('operator','customer')),

  operator_id    TEXT NOT NULL,
  -- The customer's number, so a confirmed report can find their standing row
  -- after the booking itself is long gone.
  phone_e164     TEXT,

  note           TEXT,

  status         TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','confirmed','rejected')),

  -- Set with a terminal status, so "when was this decided" is a column and not
  -- an inference from an audit log that does not exist.
  decided_at     INTEGER,
  -- Which strike this turned out to be, copied at confirm time. The ladder can
  -- be retuned later and this has to keep saying what actually happened.
  strike_number  INTEGER,

  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- ONE REPORT PER BOOKING PER DIRECTION.
--
-- Without it, an operator can file the same customer no-show five times and,
-- once confirmed, walk somebody from a three-day suspension to a ban over a
-- single missed appointment. Both directions are allowed on one booking --
-- each side blaming the other is a real and common outcome -- but each side
-- gets one.
CREATE UNIQUE INDEX idx_no_show_once ON no_show_reports (order_item_id, against);

CREATE INDEX idx_no_show_open ON no_show_reports (status, created_at DESC);
CREATE INDEX idx_no_show_operator ON no_show_reports (operator_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 5. Every suspension that was ever applied
-- ---------------------------------------------------------------------------
-- operators.suspended_until answers "can they list right now" in one read.
-- This table answers "why, and what happened before" -- which is the question
-- asked when somebody appeals, and the one a mutable column on the operator
-- row can never answer.
CREATE TABLE suspensions (
  id            TEXT PRIMARY KEY,

  subject_kind  TEXT NOT NULL CHECK (subject_kind IN ('operator','customer')),
  -- The operator's id, or the customer's phone number. Not a foreign key: a
  -- customer has no row to point at, and the record of a suspension must
  -- outlive the account it was applied to.
  subject_id    TEXT NOT NULL,

  reason        TEXT NOT NULL CHECK (reason IN ('no_show','fees_owed','manual')),
  strike_number INTEGER NOT NULL,

  starts_at     INTEGER NOT NULL,
  -- NULL means a ban: no end date rather than a date far in the future, so
  -- nothing can quietly expire it.
  ends_at       INTEGER,

  note          TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX idx_suspensions_subject
  ON suspensions (subject_kind, subject_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 6. The operator's client list stops holding our customers' details
-- ---------------------------------------------------------------------------
-- Until now a public booking wrote the customer's real phone number, email and
-- address straight onto a `clients` row owned by the operator, and the API
-- masked it on the way out. That is the wrong place to solve it. A filter on
-- four queries is one forgotten query away from failing, and it fails
-- silently; meanwhile the number is sitting in the table for every backup,
-- export and future endpoint to carry.
--
-- So a client row created by a platform booking no longer holds contact
-- details at all. This column marks those rows: the platform introduced this
-- person, their details live on the order, and the operator's list simply does
-- not contain them. Nothing to filter, nothing to leak, nothing to import.
--
-- The operator's OWN clients -- the book they arrived with, the numbers they
-- typed in themselves -- are untouched by this and always will be. That list
-- is theirs and taking it would break the product for the exact people it is
-- built for.
ALTER TABLE clients ADD COLUMN platform_introduced INTEGER NOT NULL DEFAULT 0
  CHECK (platform_introduced IN (0,1));

-- Existing public rows are marked, and their contact columns cleared. This is
-- a one-way cleanup and it is the point of the migration: the numbers we
-- should not have been keeping stop being kept.
UPDATE clients
   SET platform_introduced = 1,
       phone_e164 = NULL,
       email = NULL,
       last_name = NULL
 WHERE acquired = 'public';
