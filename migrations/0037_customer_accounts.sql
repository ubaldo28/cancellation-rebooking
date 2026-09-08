-- A customer account, and the correction of the assumption underneath the
-- whole product.
--
-- Every migration before this one is written on a sentence that turned out not
-- to be the model: "the customer has no account and there is not going to be
-- one". Migration 0023 says it twice while explaining why a suspension is
-- keyed on a phone number; 0016 says it while explaining why the guest token
-- is the only durable thing a customer owns; 0011 said it first. The owner has
-- corrected it. A customer needs an account and a card to book, once payment
-- is switched on. What was right about the old sentence is the part that is
-- kept: nobody is asked to sign up before they have decided to buy anything.
--
-- SO THE ACCOUNT IS CREATED AT THE CONFIRM STEP OF THE CHECKOUT, in the same
-- action that would take the card, and it is the shape a rider's account has:
-- a mobile number, proved by a code sent to it in a text message. No password,
-- no mailbox, no second screen. That is not a shortcut around security -- it
-- is the only identifier this product already treats as the person, and the
-- reason is in the next paragraph.
--
-- THE NUMBER IS ALREADY THE IDENTITY, WHICH IS WHY THE ACCOUNT IS THE NUMBER.
-- customer_standing from 0023 is keyed on phone_e164 and is what makes the
-- no-show ladder work: three confirmed no-shows and that number cannot book.
-- An account keyed on anything else -- an email, a generated id, a password --
-- would be a second identity beside the first, and the gap between them is
-- exactly where somebody walks away from a suspension. Keying the account on
-- the same column means a sanction follows the person and not the booking,
-- there is nothing to reconcile, and a new account for a suspended number is
-- simply that number again, still suspended. Nothing here writes to, clears or
-- shortens a row in customer_standing, and closing or erasing an account
-- deliberately does not either.
--
-- WHAT IS NOT CHANGED. /c/:token still opens a booking with no sign-in at all.
-- It is how somebody reads their appointment on a phone that has never had a
-- session on it, and turning it into a sign-in wall would take the product's
-- one genuinely frictionless surface away for nothing: the token is already
-- bearer authority over precisely that one booking, which is less than an
-- account carries, not more.

-- ---------------------------------------------------------------------------
-- 1. The account
-- ---------------------------------------------------------------------------
CREATE TABLE customer_accounts (
  id                TEXT PRIMARY KEY,

  -- The account, in one column. E.164, normalised by toE164 before it ever
  -- reaches here, so that a number typed four ways is one account and one
  -- standing row rather than four of each.
  --
  -- NULLABLE, and only for one reason: closing or erasing an account empties
  -- it. SQLite treats NULLs as distinct in a unique index, so any number of
  -- closed accounts can sit here without colliding, while a live number can
  -- only ever belong to one row.
  phone_e164        TEXT,

  -- Proof that a code sent to that number was typed back in. An account row
  -- with this NULL has never been verified and cannot be signed in to; there
  -- is no path that writes one, and the column exists so that "verified" is a
  -- fact on the row rather than an inference from a row existing.
  phone_verified_at INTEGER,

  -- What to call them, and where to send a receipt. Both optional and neither
  -- is an identity: an email here is a contact detail, so changing it moves no
  -- standing, unlocks nothing, and cannot be used to reach an account.
  first_name        TEXT,
  email             TEXT,

  -- A SECOND FACTOR, NEVER THE FIRST. Allowed for because somebody will
  -- eventually want one on top of the code, and adding a column later to a
  -- table this size is a worse day than adding it now. Nothing in the Worker
  -- reads or writes it, and nothing may make it sufficient on its own: an
  -- account whose owner has changed their number gets back in by proving the
  -- new one, not by remembering a password.
  password_hash     TEXT,

  -- The card, in the only form this codebase ever holds one: the processor's
  -- own opaque reference, plus the brand and last four so a person can tell
  -- which of their cards it is. Identical in kind to operators.payment_ref
  -- from 0023, and under the same rule -- NO CARD NUMBER IS EVER STORED IN
  -- THIS DATABASE, and none of these columns can hold one. See
  -- src/lib/payments.ts, which enforces that at ingress, at every D1 bind and
  -- at egress rather than trusting this comment.
  --
  -- EMPTY IN EVERY ROW TODAY. Stripe is not wired, so nothing exists that
  -- could produce a reference to put here. The columns are the seam, not a
  -- claim that a card has been taken.
  payment_ref       TEXT,
  payment_brand     TEXT,
  payment_last4     TEXT,
  payment_added_at  INTEGER,

  -- Set when the person closes the account. Read in the WHERE clause of every
  -- session lookup rather than checked afterwards, for the same reason
  -- operators.closed_at is: a closed account must not be reachable by a
  -- credential that was minted before it closed.
  closed_at         INTEGER,

  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- One live account per number. This index is the whole of the "a new account
-- cannot escape a suspension" guarantee at the storage layer: there is no
-- second row for a number to hide behind.
CREATE UNIQUE INDEX idx_customer_accounts_phone ON customer_accounts (phone_e164);

-- ---------------------------------------------------------------------------
-- 2. The customer's session, in its own table on purpose
-- ---------------------------------------------------------------------------
-- A SEPARATE TABLE, NOT A NULLABLE operator_id ON sessions.
--
-- The obvious version is one sessions table with two nullable owner columns,
-- and it is wrong in a way that only shows up once. requireOperator's lookup
-- is `sessions JOIN operators ON o.id = s.operator_id`; add a customer column
-- to that table and the protection against a customer session satisfying an
-- operator route becomes "the join finds no operator", which is a property of
-- one query rather than of the schema -- and it is one LEFT JOIN, one
-- COALESCE, one well-meaning refactor away from being false. With two tables
-- there is no row for the wrong query to find, whatever anybody writes later.
--
-- The token hashes are domain-separated as well (see hashCustomerToken in
-- src/lib/customers.ts): a customer's cookie value hashed the operator way
-- produces a digest that matches nothing in `sessions`, and the reverse.
-- Belt on top of braces, and it is what makes "an operator session can never
-- satisfy a customer route" survive somebody one day deciding both should use
-- the same cookie name.
CREATE TABLE customer_sessions (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,

  -- sha256('customer-session:' || token || ':' || SESSION_PEPPER). The raw
  -- token exists only in the cookie, exactly as for an operator session and
  -- for every guest link in this product.
  token_hash    TEXT NOT NULL,

  user_agent    TEXT,

  -- A YEAR, WHERE AN OPERATOR GETS THIRTY DAYS, and the difference is the
  -- point rather than an oversight. An operator signs in to a dashboard they
  -- work in; a customer signs in on the phone in their pocket and then books
  -- twice a year, and a session that expires between bookings turns every
  -- booking into a sign-in. The session is also extended on use -- see
  -- requireCustomer -- so a phone that is used stays signed in indefinitely
  -- and only a device that has been silent for a year has to prove the number
  -- again. Re-verification is for a new device or a risky change; it is not a
  -- toll on ordinary use.
  expires_at    INTEGER NOT NULL,

  revoked_at    INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_customer_sessions_hash    ON customer_sessions (token_hash);
CREATE INDEX        idx_customer_sessions_account ON customer_sessions (account_id, expires_at);

-- ---------------------------------------------------------------------------
-- 3. The code that was texted
-- ---------------------------------------------------------------------------
-- Six digits, ten minutes, single use, five wrong guesses and it is dead.
-- The numbers and the reasoning behind each of them are in
-- src/lib/customers.ts, where they can be read next to the code that applies
-- them; what is here is only the shape that makes them enforceable.
--
-- The row is keyed on the NUMBER rather than on an account, because at the
-- moment a code is sent there may be no account yet -- that is the ordinary
-- case, since this is how one is created. It is also why nothing here reveals
-- whether an account exists: the send path writes and answers identically
-- either way, so this endpoint cannot be used to ask whether somebody's mobile
-- number has ever booked.
CREATE TABLE customer_login_codes (
  id            TEXT PRIMARY KEY,

  phone_e164    TEXT NOT NULL,

  -- sha256('customer-code:' || phone || ':' || code || ':' || SESSION_PEPPER).
  -- The number is inside the digest, not merely beside it, so a code minted
  -- for one number cannot be replayed against another even by somebody holding
  -- this table. Six digits is a small space and a bare hash of one is a
  -- lookup, not a secret -- the pepper is a Worker secret and is what makes
  -- these unusable in a stolen copy of the database.
  code_hash     TEXT NOT NULL,

  -- Wrong guesses against THIS code. The pattern is order_items.code_attempts
  -- from 0026: where there is a row to count a failure against, count it there
  -- rather than against the caller's address, because the address is shared by
  -- everyone behind it and the row is not.
  attempts      INTEGER NOT NULL DEFAULT 0,

  expires_at    INTEGER NOT NULL,

  -- Set the moment a code is used, and also the moment it is superseded by a
  -- newer one or exhausted by wrong guesses. One column for "this code can
  -- never be accepted again", whichever of the three reasons put it there:
  -- three flags would be three chances for a query to ask about the wrong one.
  consumed_at   INTEGER,

  -- Who asked for it. Kept only so that a burst of sends aimed at many
  -- different numbers is visible after the fact; it is not what limits them,
  -- because a limit that a botnet can spread across ten thousand hosts is not
  -- a limit. The volume ceilings that actually bind are per-NUMBER, which is
  -- the thing an attacker cannot vary when the attack is texting a stranger.
  send_ip       TEXT,

  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_customer_codes_phone ON customer_login_codes (phone_e164, created_at DESC);
-- The sweep's way in. Without it the cron scans the whole table every quarter
-- hour to find the handful of rows that have aged out.
CREATE INDEX idx_customer_codes_expiry ON customer_login_codes (expires_at);

-- ---------------------------------------------------------------------------
-- 4. Which account an order belongs to
-- ---------------------------------------------------------------------------
-- Nullable, and it will stay nullable: every order placed before this
-- migration was placed by somebody who had no account to attach it to, and
-- rewriting history to pretend otherwise would be inventing a fact. Those
-- orders are claimed onto an account the first time the same number verifies
-- itself -- see claimGuestHistory in src/lib/customers.ts -- which is the
-- honest version: the row says which account it belongs to from the moment
-- anybody can prove they are that account, and not before.
--
-- orders.phone_e164 stays where it is and stays authoritative. It is what
-- customer_standing joins on, what erasure searches by, and what the no-show
-- ladder reads; making the account id the only link would put a JOIN between
-- the ladder and its subject for no gain. Once an order has an account, the
-- number on it is COPIED FROM THE ACCOUNT and never from what was typed into
-- the checkout -- otherwise a suspended customer signs in and books under a
-- friend's number, which is the whole ladder undone in one text box.
ALTER TABLE orders ADD COLUMN customer_account_id TEXT;
CREATE INDEX idx_orders_account ON orders (customer_account_id, created_at DESC);
