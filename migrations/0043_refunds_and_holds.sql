-- ---------------------------------------------------------------------------
-- 0043 — the money actually goes back, and it waits before it goes out
-- ---------------------------------------------------------------------------
--
-- Two things were true of this schema and should not have been.
--
-- THE FIRST: refund_cents (0024) recorded what a customer was owed and nothing
-- anywhere gave it to them. The cancellation screen quoted the figure, the
-- cancellation wrote it down, the hold in 0025 decided whether it was really
-- owed — and then it sat in a column. A customer cancelling three days out was
-- told "you get all of it back" and got none of it. The columns below are what
-- turn that number into a Stripe refund exactly once.
--
-- THE SECOND: every business was paid the instant the card cleared, days
-- before the work. So the money for a job on Friday had already left the
-- platform by Tuesday, and a customer cancelling on Wednesday for a full
-- refund was refunded out of the platform's own pocket — a transfer cannot be
-- taken back cheaply once it has landed in somebody's bank. Nothing is added
-- here for that: the wait is expressed in time the schema already stores, and
-- the index at the bottom is what makes sweeping for it cheap.
--
-- NO CARD DATA, exactly as in 0040. Every column below holds a Stripe object
-- id, an amount, a count, or a message Stripe wrote.

-- ---------------------------------------------------------------------------
-- 1. The refund that actually happened
-- ---------------------------------------------------------------------------

-- The Refund that gave this line's money back: 're_...'. NULL means the money
-- has not left, whatever refund_cents says — those two columns answer
-- different questions and the difference is the whole point of this one.
-- refund_cents is what was DECIDED; this is what was DONE.
ALTER TABLE order_items ADD COLUMN refund_id TEXT;

-- When it left. Shown to the customer on their own bookings list, because
-- "cancelled" and "cancelled, and your money is on its way back" are not the
-- same sentence to somebody who is out three hundred dollars.
ALTER TABLE order_items ADD COLUMN refunded_at INTEGER;

-- How many times Stripe has RECEIVED this refund and REFUSED it.
--
-- This exists because of the trap written out above createConnectAccount in
-- lib/stripe.ts: Stripe caches the response to an idempotency key for 24
-- hours, failures included. A refund keyed on nothing but the line would
-- therefore replay the first refusal for the rest of the day — the cause gets
-- fixed, the sweep runs again every quarter of an hour, and every one of those
-- attempts gets handed the stored error without the request ever arriving. The
-- customer waits a day for money they were told was coming back.
--
-- A clock bucket is the usual answer to that and is the wrong one here. A
-- bucket moves on its own, so a refund that SUCCEEDED at Stripe and then
-- failed to be written down — a worker killed mid-request — would be sent
-- again under a fresh key ten minutes later and the customer would be paid
-- twice. This only moves when Stripe has answered 4xx, which means it
-- evaluated the request and created nothing. A dropped connection leaves it
-- alone, so an attempt whose outcome we genuinely do not know is retried under
-- the same key and Stripe deduplicates it.
ALTER TABLE order_items ADD COLUMN refund_attempts INTEGER NOT NULL DEFAULT 0;

-- What Stripe said the last time it refused. Kept so that a refund which is
-- not happening is VISIBLE as a refund that is not happening — the failure
-- this product could least afford to make quiet is one where the customer has
-- been told their money is coming back. Cleared when the refund goes through.
ALTER TABLE order_items ADD COLUMN refund_error TEXT;

-- One refund per line, enforced here and not only in the code that writes it.
-- NULLABLE plus a unique index is the same pattern 0040 uses for
-- stripe_account_id and transfer_id: SQLite treats NULLs as distinct, so every
-- line that has not been refunded sits here at once while a real refund id
-- belongs to exactly one of them. A sweep racing itself, a webhook replayed by
-- hand, a customer answering the work question twice — all three end at this
-- index rather than at somebody being paid back twice out of one charge.
CREATE UNIQUE INDEX idx_order_items_refund ON order_items (refund_id);

-- The refund sweep's work queue: money the hold released and nobody has sent.
-- Partial, so it holds the handful of rows that are actually owed rather than
-- every line ever booked.
CREATE INDEX idx_order_items_refund_due ON order_items (settlement)
  WHERE refund_id IS NULL AND refund_cents > 0;

-- ---------------------------------------------------------------------------
-- 2. Paying the business afterwards rather than in advance
-- ---------------------------------------------------------------------------

-- The payout sweep's work queue: lines that have been paid for and not yet
-- paid out, ordered by when their work finishes.
--
-- There is no new column for the wait itself, deliberately. "Pay this business
-- once the job has happened and the cancellation can no longer take the money
-- back" is a statement about ends_at and the watch tail in lib/settlement.ts,
-- both of which already exist — and a stored payable-at date would be a second
-- copy of that policy, written at booking time, that goes stale the moment the
-- appointment is moved. The sweep reads the appointment's own end time, so a
-- job pushed to next week is paid next week without anything having to notice.
CREATE INDEX idx_order_items_payout_due ON order_items (ends_at)
  WHERE transfer_id IS NULL AND cancelled_at IS NULL;
