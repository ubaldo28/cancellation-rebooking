-- Holding real people's details, and being able to stop holding them.
--
-- Everything before this migration was built on the assumption that data
-- arrives and stays. There was no way to delete anything: not a customer
-- asking to be erased, not an operator closing their account, and not the
-- large amount of data that has no reason to exist a week after the job it
-- belonged to. A marketplace that holds home addresses, coordinates accurate
-- to a doorstep, phone numbers and photographs of the inside of people's
-- houses cannot be a place where all of that accumulates forever by default.
--
-- This migration adds the three things the code needs to fix that, and no
-- more. The deletions and the sweeps themselves are in src/lib/retention.ts;
-- what is here is the small amount of state they cannot work without.

-- ---------------------------------------------------------------------------
-- 1. Who used the admin surface, and when
-- ---------------------------------------------------------------------------
-- /api/admin/* reads other people's disputes -- names, phone numbers, what
-- somebody said happened in their home -- and suspends or bans the businesses
-- those disputes name. requireAdmin decides WHETHER somebody may. Nothing
-- recorded THAT they did, which means a misused admin session left no trace at
-- all, and neither did a correctly used one that somebody later disputed.
--
-- THE RECORD MUST NOT BECOME A SECOND COPY OF THE DATA IT IS ABOUT. That is
-- the whole design constraint here, and it is why there are no name, phone,
-- address or note columns: an audit trail that quietly duplicates the personal
-- data of every dispute an admin opened is a bigger liability than the gap it
-- was filling, and it would survive the erasure that removes the original.
--
-- So a row says who, what, when, and which record -- by the id we already
-- hold, or, where the subject is a customer and the only identifier is their
-- phone number, by a peppered hash of it. The hash is checkable (you can
-- recompute it from a number you already have) and is not a phone number.
CREATE TABLE admin_actions (
  id                TEXT PRIMARY KEY,

  -- The operator row behind the admin session. An id, not an email: the email
  -- is already on that row and copying it here would be a second place to
  -- rewrite when that person closes their account.
  actor_operator_id TEXT NOT NULL,

  -- 'read_no_show_queue', 'confirm_no_show', 'reject_no_show', 'read_flags'.
  -- Reads are recorded as well as writes, on purpose: the queue is where the
  -- personal data actually is, and looking at it is the act most likely to be
  -- misused and least likely to leave any other trace.
  action            TEXT NOT NULL,

  subject_kind      TEXT CHECK (subject_kind IN ('operator','customer','report','queue',NULL)),

  -- An id we already store, or sha256(phone + pepper) for a customer. Never a
  -- phone number, a name or an address.
  subject_ref       TEXT,

  -- Short, structural, and never free text about a person: 'confirmed',
  -- 'rejected', 'strike_2'. The note an admin writes about a dispute belongs
  -- on the dispute, where erasure can reach it.
  detail            TEXT,

  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_admin_actions_time  ON admin_actions (created_at DESC);
CREATE INDEX idx_admin_actions_actor ON admin_actions (actor_operator_id, created_at DESC);
CREATE INDEX idx_admin_actions_subject ON admin_actions (subject_kind, subject_ref);

-- ---------------------------------------------------------------------------
-- 2. That an erasure happened
-- ---------------------------------------------------------------------------
-- A deletion that leaves no trace cannot be shown to have happened, and "we
-- deleted it, trust us" is the answer nobody accepts from a company. This is
-- the receipt: the subject as a peppered hash, what kind of subject it was,
-- how many rows went, and when.
--
-- Same constraint as above and it matters more here: a record of an erasure
-- that stored the number it erased would be the one row that survived the
-- erasure, holding exactly the thing that was asked to be removed.
CREATE TABLE erasures (
  id            TEXT PRIMARY KEY,
  subject_kind  TEXT NOT NULL CHECK (subject_kind IN ('customer','operator')),
  -- sha256(identifier + SESSION_PEPPER). Checkable, not reversible, and
  -- useless in a dump without the pepper, which is a Worker secret.
  subject_hash  TEXT NOT NULL,
  rows_removed  INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_erasures_time ON erasures (created_at DESC);
CREATE INDEX idx_erasures_hash ON erasures (subject_hash);

-- ---------------------------------------------------------------------------
-- 3. An operator who has closed their account
-- ---------------------------------------------------------------------------
-- Closing is not a soft delete and this is not a "deleted" flag. The personal
-- columns on the row are really emptied -- email, phone, home address and
-- coordinates, licence number, insurance policy number, the name a background
-- check was run against, the vehicle plate, the social handles -- and the row
-- that remains exists only so the financial records that reference it
-- (order_items, lead_fees, reviews of work that really happened) still have
-- something to point at. What is left identifies a business that no longer
-- exists, not a person.
--
-- The timestamp is what stops a closed account being signed into, listed,
-- offered work, or emailed. See src/lib/retention.ts.
ALTER TABLE operators ADD COLUMN closed_at INTEGER;

-- ---------------------------------------------------------------------------
-- 4. Making the retention sweeps cheap enough to run every quarter hour
-- ---------------------------------------------------------------------------
-- Each of these exists for exactly one sweep in retention.ts. Without them the
-- cron does a full table scan of the largest tables in the product on every
-- tick, which is the reason retention passes get quietly disabled.
CREATE INDEX IF NOT EXISTS idx_threads_last_message ON threads (last_message_at);
CREATE INDEX IF NOT EXISTS idx_instant_requests_created ON instant_requests (status, created_at);
CREATE INDEX IF NOT EXISTS idx_watches_updated ON watches (active, updated_at);
CREATE INDEX IF NOT EXISTS idx_job_photos_created ON job_photos (created_at);
CREATE INDEX IF NOT EXISTS idx_appointments_ends ON appointments (status, ends_at);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications (created_at);
