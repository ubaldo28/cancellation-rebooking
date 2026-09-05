-- Posted openings, and a basket that can hold more than one of them.
--
-- Two things were impossible before this migration, and both of them are the
-- first thing a real business tries to do.
--
-- 1. An opening could only come from detectGaps finding a hole between two
--    booked jobs. Somebody who already has a full book and wants to sell one
--    free Thursday afternoon had to type their entire week into the calendar
--    before the product would show them anything at all. That is the wrong ask
--    of the exact person we most want, so an opening can now simply be typed.
--
-- 2. A slot sold exactly one service, chosen by the server as the most
--    expensive one that fits. A customer who wants a wash and an interior
--    clean had no way to say so, and no way to take two slots — one today, one
--    next week — in a single checkout.

-- ---------------------------------------------------------------------------
-- 1. Where a gap came from
-- ---------------------------------------------------------------------------
-- 'detected' rows are derived state: detectGaps recomputes them from the
-- calendar on every run, and expires any that no longer match free time. A
-- 'posted' row is not derived from anything — a person typed it — so there is
-- nothing for detection to recompute it against, and the expiry pass would
-- delete it on its very next run purely because no calendar hole matches it.
-- detectGaps must therefore never expire or overwrite a posted row. Existing
-- rows default to 'detected', which is exactly what they are.
ALTER TABLE gaps ADD COLUMN source TEXT NOT NULL DEFAULT 'detected'
  CHECK (source IN ('detected','posted'));

-- The listing and expiry passes both filter on source now; they already lead
-- with operator_id and status.
CREATE INDEX idx_gaps_source ON gaps (operator_id, source, status, starts_at);

-- ---------------------------------------------------------------------------
-- 2. What the operator will actually do in a given opening
-- ---------------------------------------------------------------------------
-- Someone posting "Thursday 2-5, cuts and colour only" is making a promise
-- about that afternoon, not about their price list. Without this table the
-- only expressible answer is "anything I sell", and a customer could buy the
-- three-hour job the operator posted the slot to avoid.
--
-- NO ROWS FOR A GAP MEANS "any eligible service". That is deliberate: every
-- gap that already exists has no rows here, and keeps behaving exactly as it
-- did. An empty set must never be read as "nothing is bookable".
CREATE TABLE gap_services (
  id          TEXT PRIMARY KEY,
  gap_id      TEXT NOT NULL REFERENCES gaps(id) ON DELETE CASCADE,
  service_id  TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,

  -- Offering the same service twice in one slot is a double-tap on a form,
  -- not an intent, and it would price the slot at twice its real cost.
  UNIQUE (gap_id, service_id)
);
CREATE INDEX idx_gap_services_service ON gap_services (service_id);

-- ---------------------------------------------------------------------------
-- 3. One checkout
-- ---------------------------------------------------------------------------
-- An order is the customer's side of the transaction and it deliberately does
-- not belong to an operator: a basket may hold Thursday at one business and
-- Saturday at another, and forcing one operator_id onto it would mean two
-- checkouts, two address forms and two chances to abandon.
--
-- The guest's details live here rather than only on the claims, because an
-- order can fail before a single claim exists and we still want to know who
-- was trying to buy.
CREATE TABLE orders (
  id                TEXT PRIMARY KEY,

  -- 'pending' is the honest state for everything this migration ships: the
  -- items are claimed but no money has moved, because there is no payment
  -- step yet. 'confirmed' is what the payment step will write when there is.
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','confirmed','failed','cancelled')),

  guest_name        TEXT,
  phone_e164        TEXT,
  email             TEXT,
  address_line      TEXT,
  postcode          TEXT,
  lat               REAL,
  lng               REAL,

  -- One currency per order. Two businesses billing in different currencies
  -- cannot be summed into a total, and a total that silently adds 50 USD to
  -- 50 GBP is worse than a refused checkout.
  currency          TEXT NOT NULL,
  total_cents       INTEGER NOT NULL DEFAULT 0,

  -- The guest has no account; the secret in their link is their identity, the
  -- same as everywhere else in this codebase. Only the hash is ever stored.
  thread_token_hash TEXT,

  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX idx_orders_created ON orders (created_at DESC);
CREATE INDEX idx_orders_phone   ON orders (phone_e164, created_at DESC);

-- ---------------------------------------------------------------------------
-- 4. One opening inside an order
-- ---------------------------------------------------------------------------
-- operator_id, gap_id, appointment_id and client_id are plain columns rather
-- than foreign keys with a cascade. An order is a record of what somebody
-- agreed to and paid for; deleting an operator must not quietly erase the
-- evidence that the sale happened, and it must not block the delete either.
CREATE TABLE order_items (
  id               TEXT PRIMARY KEY,
  order_id         TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  operator_id      TEXT NOT NULL,
  gap_id           TEXT,
  appointment_id   TEXT,
  client_id        TEXT,

  starts_at        INTEGER NOT NULL,
  ends_at          INTEGER NOT NULL,
  duration_seconds INTEGER NOT NULL,
  price_cents      INTEGER NOT NULL,

  created_at       INTEGER NOT NULL,

  CHECK (ends_at > starts_at)
);
CREATE INDEX idx_order_items_order    ON order_items (order_id);
CREATE INDEX idx_order_items_operator ON order_items (operator_id, starts_at);

-- ---------------------------------------------------------------------------
-- 5. The services chosen for one item
-- ---------------------------------------------------------------------------
-- name, duration and price are COPIES, not joins. A service row is live data
-- the operator edits — they raise the price, rename it, shorten it — and a
-- receipt that reads through to it would rewrite what the customer agreed to
-- every time they did. service_id is kept for reporting and is nullable so
-- deleting a service cannot take the receipt with it.
CREATE TABLE order_item_services (
  id               TEXT PRIMARY KEY,
  order_item_id    TEXT NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  service_id       TEXT,
  name             TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL,
  price_cents      INTEGER NOT NULL
);
CREATE INDEX idx_order_item_services_item ON order_item_services (order_item_id);
