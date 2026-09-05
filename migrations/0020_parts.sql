-- Parts.
--
-- Until this migration the product had no idea parts existed. A service was a
-- name, a duration and one price, and the only advice we gave an operator was
-- "include the parts in your price". That advice is fine for a car wash and
-- wrong for most of the trades this thing is built for. A mobile mechanic does
-- not know whether your car needs a $40 sensor or a $400 alternator until they
-- are under the hood. An appliance tech does not know which board failed until
-- the panel is off. A locksmith drilling a lock does not know which cylinder
-- fits until the old one is out. Telling those people to guess a number in
-- advance produces one of two outcomes, and both of them are bad: they pad the
-- price so high they never get booked, or they take the job at a loss and
-- collect the difference at the door — in cash, off the platform, in exactly
-- the conversation this product exists to keep on the platform.
--
-- So parts get a real representation, and it has three shapes because there
-- are only three honest ones:
--
--   'none'     — no parts. The price is the whole price. Detailing, cleaning,
--                junk removal, grooming, pressure washing.
--   'included' — the operator supplies parts and has already priced them in.
--                A rekey with the cylinder, an oil change with the filter and
--                the oil. The price is still the whole price, and we say so
--                out loud rather than leaving the customer to wonder.
--   'quoted'   — the part is not knowable in advance. The customer pays the
--                labour or diagnostic through the site at checkout, at full
--                price. When the operator gets there and knows what is needed
--                they send a parts quote, in the conversation that already
--                exists for this booking. The customer approves or declines
--                it, in the app, before anything is fitted. An approved quote
--                is charged through the site as a second payment.
--
-- The last one is the reason this migration exists at all, and the rule it
-- enforces is the important part: NOTHING IS CHARGED THAT THE CUSTOMER HAS NOT
-- SEEN AND TAPPED APPROVE ON. No surprise total, no "it came to a bit more",
-- no cash at the door. That is a promise we can actually keep, unlike "nothing
-- is added on top", which was simply false for half the trades on the site.

-- ---------------------------------------------------------------------------
-- 1. The policy lives on the service
-- ---------------------------------------------------------------------------
-- NOT on the operator and not on the gap. One mechanic sells both a mobile oil
-- change ('included' — they carry the oil and the filter) and a check-engine
-- diagnosis ('quoted' — nobody knows yet). Hanging this off the business would
-- force a single answer on a price list that genuinely has two.
--
-- 'none' is the default, so every service that already exists keeps behaving
-- exactly as it does today: one price, nothing added. A default of 'quoted'
-- would silently tell every existing customer their bill might go up.
--
-- This is NOT services.requires_parts, which already exists and means
-- something else entirely: that flag is a scheduling gate — "this job needs
-- parts on hand, so it cannot fill a slot two hours from now". It says nothing
-- about who pays for them or how much. The two are independent: a job can need
-- parts on hand (requires_parts = 1) that are already priced in
-- (parts_policy = 'included').
ALTER TABLE services ADD COLUMN parts_policy TEXT NOT NULL DEFAULT 'none'
  CHECK (parts_policy IN ('none','included','quoted'));

-- What the operator wants the customer to read before booking, in their own
-- words. "Price covers the diagnosis and the labour. If it needs a part I'll
-- show you the price on your phone before I fit anything." Optional, but the
-- booking page is much weaker without it, so the form asks for it.
ALTER TABLE services ADD COLUMN parts_note TEXT;

-- A typical range, in cents, for a 'quoted' service. Optional and honest about
-- being an estimate: the point is that a customer booking a brake job is not
-- staring at an unbounded blank. Both NULL means "no range given", which the
-- UI states plainly rather than filling in with an invented number.
--
-- "Both or neither", and low <= high, are enforced in cleanParts() rather than
-- here: SQLite's ALTER TABLE cannot add a table-level CHECK spanning two
-- columns, and rebuilding services to get one would mean copying a table every
-- operator's price list hangs off for a rule the only writer already applies.
-- An inverted range renders as "$400–$40" and reads as a bug, because it is,
-- so the writer swaps them rather than rejecting the form.
ALTER TABLE services ADD COLUMN parts_estimate_low_cents INTEGER;
ALTER TABLE services ADD COLUMN parts_estimate_high_cents INTEGER;

-- ---------------------------------------------------------------------------
-- 2. The receipt remembers the policy, not just the price
-- ---------------------------------------------------------------------------
-- Copied at booking time, exactly like name/duration/price already are and for
-- exactly the same reason (migration 0016): the operator edits the live
-- service row, and a receipt that read through to it would rewrite what the
-- customer agreed to. If they booked a job whose note said "I'll show you the
-- part price before I fit it", that promise has to survive the operator
-- rewording it next Tuesday.
ALTER TABLE order_item_services ADD COLUMN parts_policy TEXT NOT NULL DEFAULT 'none'
  CHECK (parts_policy IN ('none','included','quoted'));
ALTER TABLE order_item_services ADD COLUMN parts_note TEXT;
ALTER TABLE order_item_services ADD COLUMN parts_estimate_low_cents INTEGER;
ALTER TABLE order_item_services ADD COLUMN parts_estimate_high_cents INTEGER;

-- ---------------------------------------------------------------------------
-- 3. Parts money is kept apart from booked money
-- ---------------------------------------------------------------------------
-- orders.total_cents and order_items.price_cents keep their existing meaning:
-- what was agreed and charged AT CHECKOUT. Approved parts are a separate
-- number rather than an addition to those, because they are a separate
-- payment, taken later, that the customer approved separately — and because a
-- support question six months from now is always "what did I agree to when I
-- booked, and what did I approve after?". A single mutated total cannot answer
-- that. Adding them is the display's job.
ALTER TABLE orders ADD COLUMN parts_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE order_items ADD COLUMN parts_cents INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 4. The quote itself
-- ---------------------------------------------------------------------------
-- One offer, from the operator, of specific parts at a specific price, for one
-- booked item. It is a first-class row rather than a chat message with a
-- number in it, because it has to be approvable, chargeable and auditable, and
-- because "the customer said yes to $180" cannot be reconstructed from free
-- text after a dispute.
CREATE TABLE parts_quotes (
  id              TEXT PRIMARY KEY,

  -- The booking it belongs to. Cascades: no order item, no quote against it.
  order_item_id   TEXT NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,

  -- Denormalised so every read and every authorisation check can lead with the
  -- tenant boundary without joining back through order_items first.
  operator_id     TEXT NOT NULL,

  -- Where the customer sees and answers it. Not a foreign key, for the same
  -- reason threads avoids them: a cleaned-up booking must not erase the record
  -- of what was quoted and agreed.
  thread_id       TEXT,

  -- "Front brake pads and rotors, ceramic" — what they are approving. Required:
  -- a bare number is not something anyone can reasonably say yes to.
  description     TEXT NOT NULL,

  -- The parts. Zero is allowed (a quote can be labour-only — the job turned
  -- out bigger than it looked), but the two cannot both be zero, which the
  -- CHECK below enforces: a quote for nothing is a message, not a quote.
  parts_cents     INTEGER NOT NULL DEFAULT 0 CHECK (parts_cents >= 0),

  -- Extra labour beyond what was already booked and paid for. Separate from
  -- parts because California taxes them differently — CDTFA treats repair
  -- labour as not taxable and the parts as taxable — and an operator who has
  -- to file that cannot do it from one blended figure.
  labor_cents     INTEGER NOT NULL DEFAULT 0 CHECK (labor_cents >= 0),

  -- Carried on the row rather than read from the operator at charge time. The
  -- currency of a quote is the currency it was agreed in, and it must not be
  -- able to change underneath an approved one.
  currency        TEXT NOT NULL,

  status          TEXT NOT NULL DEFAULT 'sent'
                    CHECK (status IN ('sent','approved','declined','withdrawn','expired')),

  -- A quote left open forever is a live authorisation to charge somebody, and
  -- part prices move. Past this the quote stops being approvable and the
  -- operator sends a fresh one.
  expires_at      INTEGER,

  -- Set together with a terminal status, so "when did they say yes" is one
  -- column and not an inference from an audit log we do not have.
  decided_at      INTEGER,

  -- The payment seam for the second charge. Null until money actually moves.
  charged_at      INTEGER,

  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,

  CHECK (parts_cents + labor_cents > 0)
);

-- AT MOST ONE LIVE QUOTE PER BOOKED ITEM.
--
-- This is the concurrency guard, in the same style as the one-confirmed-claim-
-- per-gap index from migration 0006, and it is not a nicety. Without it an
-- operator can have three 'sent' quotes outstanding for the same job — say
-- $180, then a corrected $240, then $210 — the customer's screen shows
-- whichever arrived last, and they approve a row that is not the one the
-- operator thinks is live. Every one of those is chargeable. Forcing the old
-- quote to be withdrawn before a new one can be sent means the number on the
-- customer's screen is always the only number that can be charged.
CREATE UNIQUE INDEX idx_parts_quotes_live
  ON parts_quotes (order_item_id) WHERE status = 'sent';

-- The customer's view: every quote on this booking, newest first.
CREATE INDEX idx_parts_quotes_item ON parts_quotes (order_item_id, created_at DESC);

-- The operator's view, and the expiry sweep. operator_id leads because it is
-- the tenant boundary and no query here may omit it.
CREATE INDEX idx_parts_quotes_operator
  ON parts_quotes (operator_id, status, created_at DESC);

-- The sweep that expires stale quotes runs over this one.
CREATE INDEX idx_parts_quotes_expiry ON parts_quotes (status, expires_at);
