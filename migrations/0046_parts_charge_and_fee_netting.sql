-- ---------------------------------------------------------------------------
-- 0046 — the second charge happens, and a lead fee is actually collected
-- ---------------------------------------------------------------------------
--
-- Two amounts this product has been writing down for a year and never moving.
--
-- THE FIRST is an approved parts quote. Migration 0020 built the whole
-- approval flow and left `charged_at` as a column described as "the payment
-- seam for the second charge. Null until money actually moves" — and nothing
-- ever moved it. A customer tapped approve, the operator fitted a $340
-- alternator, order_items.parts_cents went up by $340, and there was no path
-- in the product by which a single cent of that reached the business. The
-- operator was left collecting it at the door in cash, which is the exact
-- conversation parts quotes exist to keep on the platform.
--
-- THE SECOND is a late-cancellation lead fee. 0022 raised the row, the
-- listing gate reads it, and the only thing that could ever settle one was a
-- person calling settleFee() by hand — which nothing in the product does. The
-- Terms say the fee is settled against the business's next payout, so the
-- payout is where it is now taken, and a fee that is bigger than one payout
-- has to be collectable across several.
--
-- NO CARD DATA, exactly as in 0040, 0041 and 0043. Every column below holds a
-- Stripe object id, an amount, a count, or a sentence Stripe wrote.

-- ---------------------------------------------------------------------------
-- 1. The second charge
-- ---------------------------------------------------------------------------

-- The PaymentIntent that took the money for this approved quote: 'pi_...'.
-- Separate from orders.payment_intent_id and not a substitute for it: that one
-- is the labour the customer agreed to at checkout, this one is the part they
-- agreed to afterwards, on a different day, for a figure they saw on their own
-- phone. Blending them would make "what did I agree to when I booked, and what
-- did I approve after?" unanswerable, which is the question 0020 split
-- parts_cents out for in the first place.
ALTER TABLE parts_quotes ADD COLUMN payment_intent_id TEXT;

-- The charge that intent produced: 'ch_...'. Needed by name, because the
-- transfer that pays the business for the part names it as source_transaction
-- — without that, Stripe is asked to send money out of the platform balance
-- rather than out of the charge that funded it, and a transfer can then leave
-- before the money to cover it has arrived.
ALTER TABLE parts_quotes ADD COLUMN charge_id TEXT;

-- How many times Stripe has RECEIVED this charge and REFUSED it.
--
-- The same counter as order_items.refund_attempts in 0043, for the same trap
-- written out above createConnectAccount in lib/stripe.ts: Stripe caches the
-- response to an idempotency key for 24 hours, failures included. A key of
-- nothing but the quote id would therefore hand a customer whose card was
-- declined at nine in the morning the same stored decline every time they
-- tapped approve for the rest of the day — after they had fixed the card, put
-- a different one on the account, or rung their bank. A quote they cannot
-- approve is a part that does not get fitted.
--
-- It moves only on a definite 4xx, which means Stripe read the request and
-- created nothing. A dropped connection or a 5xx leaves it alone, so the next
-- attempt goes out under the SAME key and Stripe deduplicates it instead of
-- charging a card twice for one alternator. A clock bucket would be the usual
-- answer and is the wrong one here for exactly that reason.
ALTER TABLE parts_quotes ADD COLUMN charge_attempts INTEGER NOT NULL DEFAULT 0;

-- What Stripe said the last time it refused. Kept so that a quote which did
-- not go through is VISIBLE as one rather than looking like a quote nobody got
-- round to answering: the operator is standing next to the car deciding
-- whether to fit the part, and "your customer's card was declined" is the only
-- sentence that helps them. Cleared when the charge goes through.
ALTER TABLE parts_quotes ADD COLUMN charge_error TEXT;

-- The Transfer that paid the business for the part: 'tr_...'.
--
-- ITS OWN TRANSFER, NOT ADDED TO THE LINE'S. A Stripe transfer that names a
-- source_transaction cannot exceed that charge, so parts money simply will not
-- fit inside the transfer funded by the labour charge — it is a different
-- charge and it has to be a different transfer. That also matches how an
-- operator has to account for it: 0020 keeps parts and labour apart because
-- California taxes repair labour and parts differently, and two arrivals in
-- the bank are easier to file than one blended one.
ALTER TABLE parts_quotes ADD COLUMN transfer_id TEXT;
ALTER TABLE parts_quotes ADD COLUMN transferred_at INTEGER;

-- One charge per quote and one payout per quote, enforced here and not only in
-- the code that writes them. The same NULLABLE-plus-unique pattern as
-- order_items.transfer_id in 0040 and refund_id in 0043: SQLite treats NULLs
-- as distinct, so every unanswered quote sits here at once while a real Stripe
-- id belongs to exactly one row. A customer double-tapping approve on one bar
-- of signal, a payout sweep overlapping its own previous pass and a support
-- replay all end at these two indexes rather than at somebody being charged or
-- paid twice.
CREATE UNIQUE INDEX idx_parts_quotes_intent ON parts_quotes (payment_intent_id);
CREATE UNIQUE INDEX idx_parts_quotes_transfer ON parts_quotes (transfer_id);

-- The payout sweep's work queue: parts the customer has paid for and the
-- business has not been paid for yet. Partial, so it holds the handful of
-- quotes actually owing rather than every quote ever sent.
CREATE INDEX idx_parts_quotes_payout_due ON parts_quotes (order_item_id)
  WHERE status = 'approved' AND charged_at IS NOT NULL AND transfer_id IS NULL;

-- ---------------------------------------------------------------------------
-- 2. Collecting a lead fee a bit at a time
-- ---------------------------------------------------------------------------

-- How much of this fee has actually been recovered, in cents.
--
-- WHY IT CANNOT JUST BE A STATUS. The fee is settled by netting it off the
-- business's next payout, and a payout is frequently smaller than the fee: the
-- top rung of the ladder is the whole job, while a payout is that job less the
-- platform's share — so a doorstep cancellation on the only job a business has
-- that week can never be collected in one go. Without this column the choice
-- would be between taking the whole fee out of a payout that cannot cover it,
-- which drives the transfer below zero, and marking a fee 'paid' when most of
-- it was not. The remainder stays 'owed', keeps blocking new listings, and
-- comes off the payout after that.
--
-- It is also what makes the netting safe to run twice. Every credit is written
-- with the value that was read in the same breath in its WHERE clause, so two
-- sweeps racing on one payout cannot both credit it — the second matches no
-- row and changes nothing, rather than collecting the same debt twice.
ALTER TABLE lead_fees ADD COLUMN settled_cents INTEGER NOT NULL DEFAULT 0;
