-- ---------------------------------------------------------------------------
-- 0038 — the customer signs in by EMAIL, not by text message
-- ---------------------------------------------------------------------------
--
-- WHY THIS EXISTS, and why it is a schema change rather than a swap of one
-- send call for another.
--
-- 0037 built the customer account around a mobile number: the number was the
-- identity, a texted code was the proof of it, and customer_standing was keyed
-- to the number so that a suspended person could not walk away from a strike by
-- opening a second account. Every one of those three facts depended on the
-- number being PROVEN, and the texted code is what proved it.
--
-- There is no text message. Sending to a US mobile needs a registered 10DLC or
-- toll-free campaign, every route to one needs a rentable street address that
-- has to appear publicly on the site, and that is not a thing this business has
-- yet. So the door is shut: with no provider, sendSignInCode refuses, and a
-- customer cannot create an account or book at all. Zero, not few.
--
-- The obvious fix -- keep the number as the identity and email the code
-- instead -- is WRONG, and quietly so. It severs proof from identity. Anyone
-- could type a stranger's mobile beside their own email address, receive the
-- code at the address they control, and be handed the account belonging to that
-- number: its booking history, and its standing. That is not a smaller version
-- of the guarantee, it is the absence of one.
--
-- So the identity moves to the thing that is actually proven. The email address
-- receives the code, so the email address is the account, and standing follows
-- it. The mobile number stays -- an operator driving to a stranger's address
-- needs a number to ring on arrival -- but it is demoted to what it now is: a
-- contact detail nobody has verified. 0037's comment calling email "a contact
-- detail, never an identity" described the world before this file; the two have
-- swapped places, and the columns below say so.
--
-- SAFE TO RUN AS A PLAIN ADD. No customer account exists in any environment --
-- nothing could have created one, because the code path to do it has been
-- refusing since the day it shipped. There is no backfill here because there is
-- nothing to back-fill, and that is the only reason this is not a migration
-- with a data step.

-- ---------------------------------------------------------------------------
-- 1. The account, re-keyed
-- ---------------------------------------------------------------------------

-- The address the code is sent to, lowercased before it ever reaches here so
-- that one mailbox typed four ways is one account and one standing row.
--
-- NULLABLE for exactly the reason phone_e164 is: closing or erasing an account
-- empties it, and SQLite treats NULLs as distinct in a unique index, so any
-- number of closed accounts can sit here while a live address belongs to one
-- row only.
ALTER TABLE customer_accounts ADD COLUMN login_email TEXT;

-- Proof that a code sent to that address was typed back in. An account row with
-- this NULL has never been verified and cannot be signed in to. Same shape and
-- same rule as phone_verified_at was in 0037 -- "verified" is a fact on the row,
-- not an inference from the row existing.
ALTER TABLE customer_accounts ADD COLUMN email_verified_at INTEGER;

-- One live account per address. This index is the whole of the "a new account
-- cannot escape a suspension" guarantee at the storage layer, inherited intact
-- from idx_customer_accounts_phone, which no longer carries it: there is no
-- second row for an address to hide behind.
CREATE UNIQUE INDEX idx_customer_accounts_login_email
  ON customer_accounts (login_email);

-- ---------------------------------------------------------------------------
-- 2. The code, re-keyed
-- ---------------------------------------------------------------------------

-- REBUILT RATHER THAN ALTERED, for the same reason customer_standing is below:
-- phone_e164 is NOT NULL on this table, so a code minted for a mailbox with no
-- number attached could not be written at all. Adding a column beside a NOT
-- NULL one that no path can fill is not a migration, it is a table that throws.
--
-- Safe to drop, and this one is safe for a second reason on top of "no row can
-- exist": every row here is a six-digit code that expires in minutes. Even in a
-- world where the table were full, dropping it would cost the people
-- mid-sign-in one retry — which is why this is the table to rebuild and
-- customer_accounts is the one to ALTER.
DROP TABLE IF EXISTS customer_login_codes;

CREATE TABLE customer_login_codes (
  id            TEXT PRIMARY KEY,

  -- The mailbox the code was sent to. Lowercased before it ever reaches here.
  login_email   TEXT NOT NULL,

  -- sha256('customer-code:' || login_email || ':' || code || ':' || SESSION_PEPPER).
  -- The address is inside the digest, not merely beside it, so a code minted
  -- for one mailbox cannot be replayed against another even by somebody holding
  -- this table -- the same property the number gave in 0037. Six digits is a
  -- small space and a bare hash of one is a lookup, not a secret: the pepper is
  -- a Worker secret and is what makes these unusable in a stolen copy.
  code_hash     TEXT NOT NULL,

  -- Wrong guesses against THIS code. Where there is a row to count a failure
  -- against, count it there rather than against the caller's address, because
  -- the address is shared by everyone behind it and the row is not.
  attempts      INTEGER NOT NULL DEFAULT 0,

  expires_at    INTEGER NOT NULL,

  -- Set the moment a code is used, and also the moment it is superseded by a
  -- newer one or exhausted by wrong guesses. One column for "this code can
  -- never be accepted again", whichever of the three reasons put it there.
  consumed_at   INTEGER,

  send_ip       TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX idx_customer_codes_email
  ON customer_login_codes (login_email, created_at DESC);
CREATE INDEX idx_customer_codes_expiry ON customer_login_codes (expires_at);

-- ---------------------------------------------------------------------------
-- 3. Standing, re-keyed — the part that is easy to forget
-- ---------------------------------------------------------------------------
--
-- A ban has to hang on something the banned person cannot simply retype. While
-- the number was proven, customer_standing.phone_e164 was that thing. It is not
-- any more: after this migration a number is whatever was typed into a booking
-- form, so a suspension keyed to one is escapable by pressing backspace.
--
-- REBUILT RATHER THAN ALTERED, because the key is the whole table. phone_e164
-- was the PRIMARY KEY and SQLite cannot move one; adding login_email beside it
-- would leave the upsert in confirmNoShow conflicting on a column that no
-- longer identifies anybody, which is not a smaller version of the guarantee.
--
-- The DROP is safe here and nowhere else: no row can exist. A standing row is
-- only ever written by confirming a no-show report, a report only exists
-- against a booking, and a booking has needed a text message that this
-- deployment has never been able to send. The table has been empty in every
-- environment since the day it was created. Do not copy this pattern into a
-- migration that runs against real rows.
DROP TABLE IF EXISTS customer_standing;

CREATE TABLE customer_standing (
  -- The identity, lowercased, matching customer_accounts.login_email. This
  -- column is the whole of the "a new account cannot escape a suspension"
  -- guarantee: one live account per address, so one standing row per person.
  login_email     TEXT PRIMARY KEY,

  -- How many confirmed no-shows. Drives the ladder in standing.ts; kept as a
  -- count rather than derived from the reports table so the gate on the
  -- booking path is one indexed read.
  no_show_strikes INTEGER NOT NULL DEFAULT 0,

  suspended_until INTEGER,
  banned_at       INTEGER,

  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- The report keeps its phone column: a report about a job genuinely is about
-- the number that was on that job, and an operator reading their own history
-- should still see it. What is added is the address the LADDER counts on.
ALTER TABLE no_show_reports ADD COLUMN login_email TEXT;
CREATE INDEX idx_no_show_reports_login_email ON no_show_reports (login_email);

-- ---------------------------------------------------------------------------
-- 4. The order carries the address it was booked with
-- ---------------------------------------------------------------------------
-- Two jobs, both of which used to be done by the number.
--
--   1. Confirming a no-show months later finds the account the strike belongs
--      to, without joining through a mobile number that may since have been
--      retyped by somebody else entirely.
--   2. claimGuestHistory attaches bookings made before the account existed. It
--      matched on phone_e164 until 0038, which was safe only while a number
--      had to be proved — matching on it now would hand a stranger's bookings
--      and home address to anybody willing to type their mobile number.
ALTER TABLE orders ADD COLUMN login_email TEXT;
CREATE INDEX idx_orders_login_email ON orders (login_email);
