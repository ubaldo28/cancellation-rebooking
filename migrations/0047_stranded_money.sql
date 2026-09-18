-- ---------------------------------------------------------------------------
-- 0047 — money that moved and money that could not
-- ---------------------------------------------------------------------------
--
-- Everything below exists because of a state this product could reach and had
-- no way out of. None of it is a new feature; all of it is a door out of a
-- room somebody's money was already locked in.
--
-- THE FIRST ROOM: a payout whose amount is not fixed. A business's transfer is
-- its share less whatever it owed at the moment the sweep looked, and the key
-- that makes that transfer safe to retry is keyed on the line alone. Stripe
-- refuses a key it has seen before if the parameters differ — so a transfer
-- that reached Stripe and whose write-back then failed deadlocked for good:
-- the next pass credited a fee, or raised one, computed a different figure,
-- sent it under the same key and got a 400, every quarter of an hour, forever,
-- with the money already in the business's bank account and the line still
-- reading as unpaid. The amount and the key are now written down together
-- before the call, so the retry is the same request and Stripe answers it with
-- the transfer it already made.
--
-- THE SECOND ROOM: a part on a booking that was then cancelled. A part is its
-- own charge against its own PaymentIntent (0046), and every refund in this
-- product works off orders.payment_intent_id, which is the labour. So the
-- customer who approved a $340 alternator on Monday and whose operator
-- cancelled on Tuesday was refunded the labour and not the part, and because
-- the line was cancelled nothing in the product ever looked at that quote
-- again. They were $340 down on a screen that said "refunded in full".
--
-- THE THIRD ROOM is not a column at all but an index, and it is at the bottom.
--
-- NO CARD DATA, exactly as in 0040, 0041, 0043 and 0046. Every column below
-- holds a Stripe object id, an amount, a count, or a sentence Stripe wrote.

-- ---------------------------------------------------------------------------
-- 1. The payout, decided before it is sent
-- ---------------------------------------------------------------------------

-- What the transfer for this line's group was decided to be, in cents, written
-- BEFORE Stripe is called rather than after it answers.
--
-- After is useless: the case this exists for is precisely the one where there
-- is no answer to write. Recorded on the first unpaid line of the group, which
-- is the same row the transfer id lands on and the same row the key is built
-- from, so the three of them cannot drift apart.
--
-- It is also what keeps the fee arithmetic honest across a retry. A second
-- pass must send the figure the first one committed to, not today's, so the
-- credits it takes off the outstanding fees are whatever that figure actually
-- held back — see payLabour in lib/checkout.ts.
ALTER TABLE order_items ADD COLUMN transfer_amount_cents INTEGER;

-- The idempotency key that amount was sent under.
--
-- Derivable from the line id today, and stored anyway, because the pair is the
-- thing that has to survive: a key read back off the row can never disagree
-- with the amount sitting next to it, whereas a key recomputed from whatever
-- the code currently believes the first line of the group to be can. This is
-- the column that turns "Stripe refuses this forever" into "Stripe hands back
-- what it already made".
ALTER TABLE order_items ADD COLUMN transfer_key TEXT;

-- ---------------------------------------------------------------------------
-- 2. Giving a part's money back
-- ---------------------------------------------------------------------------

-- The Refund that gave this part's money back: 're_...'. NULL means it has not
-- left, whatever the cancellation says — the same distinction 0043 draws for
-- order_items between what was DECIDED and what was DONE.
ALTER TABLE parts_quotes ADD COLUMN refund_id TEXT;

-- When it left, so a customer's own page can say "and your money is on its way
-- back" rather than only "cancelled" to somebody who is out three hundred
-- dollars for a part that was never fitted.
ALTER TABLE parts_quotes ADD COLUMN refunded_at INTEGER;

-- How many times Stripe has RECEIVED this refund and REFUSED it, and what it
-- said the last time.
--
-- The same counter as order_items.refund_attempts in 0043 and
-- parts_quotes.charge_attempts in 0046, for the same trap: Stripe caches a
-- key's response for 24 hours WITH ITS FAILURES, so a refund keyed on nothing
-- but the quote would replay the day's first refusal at every later attempt.
-- It moves only on a refusal Stripe has classified as one — a 409 saying the
-- same key is still in flight and a 429 saying we asked too fast are not
-- refusals, and counting them as such is how one key becomes two.
ALTER TABLE parts_quotes ADD COLUMN refund_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE parts_quotes ADD COLUMN refund_error TEXT;

-- One refund per quote, enforced here and not only in the code that writes it.
-- The same NULLABLE-plus-unique pattern as refund_id in 0043 and transfer_id in
-- 0046: SQLite treats NULLs as distinct, so every quote that has not been
-- refunded sits here at once while a real refund id belongs to exactly one.
CREATE UNIQUE INDEX idx_parts_quotes_refund ON parts_quotes (refund_id);

-- The parts refund sweep's work queue: parts charged for, not paid out to the
-- business, and not given back yet. Partial, so it holds the handful actually
-- owing rather than every quote ever approved.
CREATE INDEX idx_parts_quotes_refund_due ON parts_quotes (order_item_id)
  WHERE status = 'approved' AND charged_at IS NOT NULL
    AND transfer_id IS NULL AND refund_id IS NULL;

-- ---------------------------------------------------------------------------
-- 3. The payout sweep reading an index again
-- ---------------------------------------------------------------------------

-- 0043 created idx_order_items_payout_due over lines that are neither
-- transferred nor cancelled, and two things have happened to it since.
--
-- The sweep grew a second reason to visit an order — a part approved after the
-- labour had already gone out — and expressed it as `transfer_id IS NULL OR
-- EXISTS (SELECT ... parts_quotes ...)`. An OR spanning two tables is not
-- something SQLite can answer from an index, so the partial index stopped
-- being used at all and every tick read every line this product has ever sold.
-- The sweep is now a UNION of two queries that each match one index, which is
-- the same set of orders for the cost of the rows that are owed something.
--
-- And the `cancelled_at IS NULL` half of the old index is now wrong rather
-- than merely narrow. A cancelled line very often still holds money that is
-- the business's: a customer cancelling inside twelve hours keeps a quarter
-- and the business keeps three quarters for the time it held, and a customer
-- who answers that the work was done anyway gets nothing back at all. Both
-- figures were being written down, described in the code as belonging to the
-- operator, and then filtered out of every query that could have moved them.
--
-- So: the same index without that half, and the old one dropped rather than
-- left to be maintained on every write for a query nobody runs.
DROP INDEX idx_order_items_payout_due;
CREATE INDEX idx_order_items_payout_due ON order_items (ends_at)
  WHERE transfer_id IS NULL;
