-- The customer's phone number and email address, off the one table that
-- carries an operator_id.
--
-- public_claims is the row the booking race is decided on: the partial unique
-- index below is what stops two people confirming the same opening. Since
-- migration 0006 it has also carried first_name, phone_e164 and email, copied
-- from whatever the customer typed at checkout. Nothing has ever read them.
-- Every query against this table in the Worker is an EXISTS or a COUNT — "has
-- this gap been claimed", "how many claims does this operator have" — so the
-- three columns have sat there being backed up and never being used.
--
-- Which is why they are dangerous rather than merely untidy. The table is
-- scoped by operator_id, so the first `SELECT * FROM public_claims WHERE
-- operator_id = ?` anybody writes for a dashboard, an export or a support
-- screen hands a business the customer's mobile number and mailbox: the exact
-- thing orders.ts refuses to write onto the clients row, in the row beside it.
-- A promise that holds only while nobody writes an obvious query is not a
-- promise, and the fix is not to keep asking people to remember. The columns
-- go.
--
-- WHERE THE DETAILS STILL LIVE, because they have to live somewhere. The
-- contact details of a platform-introduced customer belong on `orders`, which
-- is the platform's own record and carries no operator_id. That is where the
-- standing ladder reads the number from -- three no-shows and the same number
-- cannot simply rebook under a new name -- and it is where erasure starts from
-- when somebody asks to be forgotten. Neither is touched by this migration.
--
-- first_name goes with them. The operator learns the customer's first name
-- from their own clients row and from the conversation, both of which are
-- written at the same instant as the claim; a third copy here was only ever a
-- third place for it to be wrong.
--
-- phone_e164 is replaced by phone_hash rather than simply dropped, and that
-- one column is the whole reason this is a table rebuild instead of a delete.
-- Erasure finds every claim a person ever made by their number: "delete my
-- data" that reaches one of three bookings has not deleted anybody's data.
-- Storing sha256(number : SESSION_PEPPER) -- the same peppered digest
-- retention.ts already uses for erasure receipts and audit subjects -- keeps
-- that lookup working exactly as it did, while what sits in the column is not
-- a phone number, cannot be dialled, and is useless in a stolen copy of the
-- database without the pepper.
--
-- Rows written before this migration cannot be given a hash: SQLite has no
-- SHA-256 and the numbers are about to be gone. They keep NULL, and erasure
-- reaches them through their appointment instead -- see the claim step in
-- eraseCustomerByToken, which asks both questions for exactly this reason.

ALTER TABLE public_claims RENAME TO public_claims_old;

CREATE TABLE public_claims (
  id              TEXT PRIMARY KEY,
  operator_id     TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  gap_id          TEXT NOT NULL REFERENCES gaps(id) ON DELETE CASCADE,
  service_id      TEXT REFERENCES services(id) ON DELETE SET NULL,
  client_id       TEXT REFERENCES clients(id) ON DELETE SET NULL,
  appointment_id  TEXT REFERENCES appointments(id) ON DELETE SET NULL,

  -- sha256('<E.164 number>:<SESSION_PEPPER>'), or NULL for a claim written
  -- before this migration. Nullable on purpose: a claim is still a valid claim
  -- once erasure has emptied it, and there is no number left to hash then.
  phone_hash      TEXT,

  -- The doorstep stays. The operator has to drive there while the booking is
  -- live, and the retention sweep and erasure both already clear these.
  address_line    TEXT,
  postcode        TEXT,
  lat             REAL,
  lng             REAL,

  -- Frozen at claim time so the fee can be reconciled later.
  detour_seconds  INTEGER,
  price_cents     INTEGER,
  deposit_cents   INTEGER,

  status          TEXT NOT NULL DEFAULT 'confirmed'
                    CHECK (status IN ('confirmed','cancelled','completed','no_show')),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- Carried across rather than dropped: these rows are what stop a filled
-- opening being sold twice, and some of them are for bookings still in the
-- future. Only the three contact columns are left behind.
INSERT INTO public_claims
  (id, operator_id, gap_id, service_id, client_id, appointment_id,
   address_line, postcode, lat, lng,
   detour_seconds, price_cents, deposit_cents, status, created_at, updated_at)
SELECT id, operator_id, gap_id, service_id, client_id, appointment_id,
       address_line, postcode, lat, lng,
       detour_seconds, price_cents, deposit_cents, status, created_at, updated_at
  FROM public_claims_old;

DROP TABLE public_claims_old;

CREATE INDEX idx_claims_operator ON public_claims (operator_id, created_at);

-- The race guarantee, unchanged: one confirmed claim per opening.
CREATE UNIQUE INDEX idx_claims_gap ON public_claims (gap_id)
  WHERE status = 'confirmed';

-- Erasure's way in. Without it, forgetting one person walks the whole table.
CREATE INDEX idx_claims_phone_hash ON public_claims (phone_hash);
