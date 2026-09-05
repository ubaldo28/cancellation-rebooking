-- Keeping the job on the platform, and the two sides' details off each other.
--
-- Two holes, and they are the same hole seen from both ends.
--
-- 1. An operator can drive to the address, stand on the doorstep, cancel in
--    the app and do the job for cash. Everything up to that moment cost them
--    nothing: we found the customer, priced the job, held the slot and drove
--    the introduction to their door. Nothing in the schema even records that
--    it happened — a cancellation on arrival looks exactly like a cancellation
--    from the sofa three days earlier.
--
-- 2. The two sides can simply swap numbers in the chat and every booking after
--    the first one happens somewhere else. The product has been explicit since
--    migration 0011 that there is no number exchange and no SMS; that promise
--    was enforced by not building an SMS path, which is not the same thing as
--    enforcing it.
--
-- Neither is solved by a rule in a terms page. Both are solved by making the
-- bypass cost something and making the contact details unavailable to copy.

-- ---------------------------------------------------------------------------
-- 1. Did they actually turn up
-- ---------------------------------------------------------------------------
-- The difference between "sorry, my van broke down this morning" and "I am
-- outside your house, let us do this off the books" is entirely whether they
-- arrived. Without a recorded arrival there is no fair way to tell those apart
-- and no honest way to charge for one and not the other.
--
-- Set by the operator tapping "I'm here", which is the same tap that starts
-- the customer's job timer, so it is not a button they can simply decline to
-- press without losing something. The van tracker can set it too when the van
-- sits inside the drop radius; that is a later refinement and this column is
-- what it would write.
ALTER TABLE order_items ADD COLUMN arrived_at INTEGER;

-- A cancellation on the item itself, not only on the appointment. An order
-- item is the thing money was taken against, and the fee question is asked of
-- it, so the answer lives beside it rather than a join away.
ALTER TABLE order_items ADD COLUMN cancelled_at INTEGER;
ALTER TABLE order_items ADD COLUMN cancelled_by TEXT
  CHECK (cancelled_by IN ('operator','customer','platform',NULL));
ALTER TABLE order_items ADD COLUMN cancel_reason TEXT;

CREATE INDEX idx_order_items_arrived ON order_items (operator_id, arrived_at);

-- ---------------------------------------------------------------------------
-- 2. The fee
-- ---------------------------------------------------------------------------
-- Charged when an operator cancels a job they had already driven to, or one
-- starting so soon that they are effectively on the doorstep. It is not a
-- punishment for cancelling — vans break down and people get sick, and a
-- cancellation the day before costs nothing. It is the price of the
-- introduction, charged at the one moment the introduction has already been
-- fully delivered.
--
-- A customer cancelling never owes this. They have no route to bypass: they
-- did not receive a lead, they received a service they have already paid for,
-- and a fee on them would just be a cancellation charge wearing a different
-- name.
CREATE TABLE lead_fees (
  id             TEXT PRIMARY KEY,

  -- Denormalised so the "can this operator still list" check is one indexed
  -- read on the hot path rather than a join through orders on every publish.
  operator_id    TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,

  -- Not a foreign key with a cascade, deliberately, like order_items itself: a
  -- deleted booking must not erase the record that a fee was owed for it.
  order_item_id  TEXT NOT NULL,

  cents          INTEGER NOT NULL CHECK (cents >= 0),
  currency       TEXT NOT NULL,

  -- Why it was raised, in a value the code branches on rather than prose.
  -- 'cancelled_on_arrival' is the doorstep case; 'cancelled_same_day' is the
  -- one where they were close enough that the distinction stops being
  -- meaningful; 'no_show' is when they never arrived and never cancelled.
  reason         TEXT NOT NULL
                   CHECK (reason IN ('cancelled_on_arrival','cancelled_last_hours',
                                     'cancelled_late','no_show')),

  -- 'owed' blocks the account from listing. 'waived' is the appeal outcome and
  -- exists because the first version of any rule like this will be wrong about
  -- somebody, and the only alternative to a waiver is deleting the row, which
  -- destroys the evidence of what happened.
  status         TEXT NOT NULL DEFAULT 'owed'
                   CHECK (status IN ('owed','paid','waived')),

  -- Free text, shown to the operator. A fee whose reason they cannot read is a
  -- fee they will dispute by email instead of paying.
  note           TEXT,

  settled_at     INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- ONE FEE PER BOOKING, EVER.
--
-- Without this, a retried cancel request — a double tap, a client that resends
-- on timeout — raises a second fee for the same event, and the operator sees
-- their debt double for something they did once. There is no version of this
-- feature where two fees for one booking is correct.
CREATE UNIQUE INDEX idx_lead_fees_item ON lead_fees (order_item_id);

-- The gate: "does this operator owe anything", answered from the index.
CREATE INDEX idx_lead_fees_owed ON lead_fees (operator_id, status);

-- ---------------------------------------------------------------------------
-- 3. Contact details never cross
-- ---------------------------------------------------------------------------
-- A message that tried to carry a phone number, an email, a payment-app handle
-- or an outside link is stored with the contact detail already removed, and
-- this flag records that it happened. The flag matters more than it looks: one
-- redacted message is somebody typing their number out of habit, and eleven
-- from the same account is somebody working around the platform on purpose.
-- Without the flag those two are indistinguishable and neither is visible.
ALTER TABLE chat_messages ADD COLUMN redacted INTEGER NOT NULL DEFAULT 0
  CHECK (redacted IN (0,1));

-- A running count on the thread so the pattern is visible without scanning
-- every message either side has ever sent.
ALTER TABLE threads ADD COLUMN redacted_count INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 4. The address is released, not published
-- ---------------------------------------------------------------------------
-- A mobile operator genuinely needs the street address — they have to drive
-- there, and pretending otherwise would break the product. What they do not
-- need is the address of somebody who has not booked them, or the address of a
-- job they cancelled, or a phone number at any point.
--
-- So the address is released at booking and closed again when the job ends,
-- and this column records the release rather than leaving "can they see it"
-- to be re-derived from booking status in four different queries, which is how
-- one of them ends up disagreeing with the others.
ALTER TABLE order_items ADD COLUMN address_released_at INTEGER;
