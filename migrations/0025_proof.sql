-- Proof that a job happened, and money that waits until we know.
--
-- The problem this closes is the one the fee alone cannot: an operator and a
-- customer can agree, on the doorstep, to cancel in the app and do the job for
-- cash. The platform refunds the customer, nobody is paid, and the work
-- happens anyway. Location tracking does not catch it — an operator about to
-- do a cash job turns location off first, which is two taps.
--
-- What does catch it is removing the certainty. Three things together:
--
--   1. BOTH SIDES MARK ARRIVAL. Not just the operator. Two independent
--      confirmations that somebody turned up, from two people with opposite
--      incentives to lie about it.
--
--   2. PROOF PHOTOS, before / during / after, from either side. A job that
--      happened leaves pictures. Pictures taken after a "cancellation" are not
--      a hint, they are the thing itself.
--
--   3. NOTHING SETTLES IMMEDIATELY. On any cancellation both sides freeze, and
--      the customer is asked a single question: did they do the work anyway?
--
-- The last one is what actually breaks collusion, and it is worth being clear
-- about why, because it is not obvious. The operator has to trust the customer
-- to answer honestly. If they do the job for cash and the customer then says
-- "no, they left", the customer keeps the cash discount AND gets refunded,
-- while the operator has done the work for nothing and eaten the fee on top.
-- Nobody hands a stranger that much money on the honour system. The scheme
-- does not need to be detected to fail; it only needs to be unsafe to attempt.

-- ---------------------------------------------------------------------------
-- 1. Both sides say they turned up
-- ---------------------------------------------------------------------------
-- order_items.arrived_at is the operator's tap and already exists. This is the
-- customer's, and it is the half that makes the other half worth anything: one
-- person's claim that they were there is a claim, and two people's is a fact.
--
-- It is not required to start the job. A customer whose phone is inside while
-- they are in the driveway must not be able to strand the appointment, so the
-- work proceeds on the operator's tap alone. What the customer's confirmation
-- changes is what a later cancellation means: an operator who cancels AFTER
-- the customer confirmed they arrived has, on the record, driven there, been
-- seen, and then walked. That is the strongest signal in the system.
ALTER TABLE order_items ADD COLUMN arrival_confirmed_at INTEGER;

-- ---------------------------------------------------------------------------
-- 2. Nothing settles until we know
-- ---------------------------------------------------------------------------
-- 'held'     — frozen. Neither the refund nor the payout moves.
-- 'released' — the money went where it should.
-- 'withheld' — the customer is not refunded, because the work appears to have
--              happened. Never a silent state: it is always written alongside
--              the reason that produced it.
ALTER TABLE order_items ADD COLUMN settlement TEXT NOT NULL DEFAULT 'released'
  CHECK (settlement IN ('held','released','withheld'));

-- The ceiling on the freeze, not the wait.
--
-- Seven days is how long we will wait for evidence that has not arrived. It is
-- NOT how long an honest person waits for their money: the release happens the
-- moment the question is settled — the customer answers, or the original
-- appointment window passes with no van anywhere near the address. Somebody
-- who cancels a Friday job on Tuesday is refunded on Friday evening, not the
-- following Tuesday. Holding an honest refund for a week to catch a dishonest
-- one is a trade that loses more customers than it saves money.
ALTER TABLE order_items ADD COLUMN hold_until INTEGER;
ALTER TABLE order_items ADD COLUMN settled_at INTEGER;

-- The customer's answer to the one question, and when they gave it.
--
-- NULL is not "no". NULL means they have not answered, and silence resolves
-- to keeping the money without charging the operator — see settlement.ts.
-- Somebody genuinely left standing on their own doorstep complains within
-- minutes; somebody who quietly received the service says nothing. Treating
-- silence as "they left" would make staying quiet the profitable move for
-- both sides at once, which is precisely the hole being closed.
ALTER TABLE order_items ADD COLUMN work_confirmed TEXT
  CHECK (work_confirmed IN ('done','not_done',NULL));
ALTER TABLE order_items ADD COLUMN work_confirmed_at INTEGER;

CREATE INDEX idx_order_items_held ON order_items (settlement, hold_until);

-- ---------------------------------------------------------------------------
-- 3. Pictures of the job
-- ---------------------------------------------------------------------------
-- Either side, at any of three stages. Both sides can upload because both
-- sides have something to protect: the operator against "they never came" on a
-- job they did, and the customer against "I did the work" on a job nobody
-- turned up for.
--
-- These are photographs of somebody's home, car or driveway, so they are
-- private to the two people on the booking and to a dispute review. They are
-- never public, never on a profile page, and never reused as marketing — the
-- operator's own portfolio is work_photos and stays a separate table for
-- exactly that reason.
CREATE TABLE job_photos (
  id            TEXT PRIMARY KEY,

  order_item_id TEXT NOT NULL,

  -- Denormalised so every authorisation check leads with the tenant boundary
  -- rather than joining back through order_items to find it.
  operator_id   TEXT NOT NULL,

  -- Which side's camera it came from. Not a claim about who is right; a fact
  -- about where the file came from.
  uploaded_by   TEXT NOT NULL CHECK (uploaded_by IN ('operator','customer')),

  stage         TEXT NOT NULL CHECK (stage IN ('before','during','after')),

  r2_key        TEXT NOT NULL,
  content_type  TEXT,
  bytes         INTEGER,
  width         INTEGER,
  height        INTEGER,
  caption       TEXT,

  created_at    INTEGER NOT NULL
);

CREATE INDEX idx_job_photos_item ON job_photos (order_item_id, created_at);
CREATE INDEX idx_job_photos_operator ON job_photos (operator_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 4. Things that look like a bypass
-- ---------------------------------------------------------------------------
-- A flag is an observation, never a verdict, and nothing in this system acts
-- on one alone. A van idling forty minutes after a doorstep cancellation is a
-- van whose driver stopped for lunch, once. The same operator doing it every
-- other week is a case, and only the pattern reaches the suspension ladder.
--
-- Kept as rows rather than as a score on the operator, because when somebody
-- appeals — and they will, and sometimes they will be right — the answer has
-- to be "here is what we saw and when", not a number nobody can argue with.
CREATE TABLE bypass_flags (
  id            TEXT PRIMARY KEY,

  operator_id   TEXT NOT NULL,
  order_item_id TEXT,

  -- 'dwell'            — the van stayed at the address after cancelling.
  -- 'location_dark'    — no recent fix at the moment they cancelled on
  --                      arrival. Turning tracking off is itself the tell, and
  --                      with location now required to list there is no
  --                      innocent version of it being off at that moment.
  -- 'photos_after'     — pictures of the job uploaded after the cancellation.
  -- 'visit_after'      — the van went to the address of a job the CUSTOMER
  --                      cancelled, around the time it would have happened.
  -- 'silence'          — the customer never answered whether the work
  --                      happened. The weakest of these on its own.
  -- 'confirmed_then_cancelled' — the customer confirmed the operator arrived
  --                      and the operator then cancelled. The strongest.
  kind          TEXT NOT NULL
                  CHECK (kind IN ('dwell','location_dark','photos_after',
                                  'visit_after','silence',
                                  'confirmed_then_cancelled')),

  -- Free text for the human who reads it: minutes dwelled, metres away, how
  -- stale the last fix was. Never parsed, only displayed.
  detail        TEXT,

  created_at    INTEGER NOT NULL
);

-- One flag of a kind per booking. A dwell check that runs twice must not make
-- one afternoon look like two incidents.
CREATE UNIQUE INDEX idx_bypass_flags_once ON bypass_flags (order_item_id, kind);
CREATE INDEX idx_bypass_flags_operator ON bypass_flags (operator_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 5. Location is not optional any more
-- ---------------------------------------------------------------------------
-- operators.share_location already exists, from when this was a nicety that
-- let a customer watch the van approach. It is now the evidence that decides
-- whether somebody is charged, so it is required to list at all — and the
-- default flips accordingly. An operator with it off cannot put work up.
--
-- Existing operators are switched on rather than being quietly barred from
-- listing by a migration they did not read. They are told, and they can still
-- turn it off; doing so takes their openings down until they turn it back on.
UPDATE operators SET share_location = 1 WHERE share_location = 0;
