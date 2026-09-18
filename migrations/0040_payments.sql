-- ---------------------------------------------------------------------------
-- 0040 — money actually moves
-- ---------------------------------------------------------------------------
--
-- Migration 0016 wrote `status TEXT NOT NULL DEFAULT 'pending'` on orders and
-- said in its own comment: "'confirmed' is what the payment step will write
-- when there is one." This is that step.
--
-- WHAT THE SHAPE IS. The customer pays the whole basket once, on this site,
-- into the platform's own Stripe account. Nothing is charged to the businesses
-- and nothing is redirected anywhere — see lib/stripe.ts for why there is no
-- Checkout Session here. Once that charge has settled, each business is paid
-- what it earned, minus the fee, by a separate Transfer to its own connected
-- account.
--
-- THAT IS WHY THE FEE IS RECORDED PER ITEM AND PER ORDER. The fee is 15%
-- capped at $150 per business per day (lib/fees.ts), which means it cannot be
-- recovered later from the order total alone: a $1,200 day and two $600 days
-- come to the same money and a different fee. What was charged has to be
-- written down at the moment it was worked out, because it is the number a
-- business will one day ask about.
--
-- NO CARD DATA. Not a PAN, not an expiry, not a CVC — not in these columns and
-- not in any other. The only card-shaped things stored anywhere are a
-- processor reference and the last four digits, and lib/payments.ts wraps the
-- database to make writing anything else impossible rather than merely
-- discouraged. Every column added below holds a Stripe object id or an amount.

-- ---------------------------------------------------------------------------
-- 1. The business, and where it gets paid
-- ---------------------------------------------------------------------------

-- The connected account this business is paid into: 'acct_...' from Stripe.
-- NULL until they have been through onboarding, which is most operators for
-- most of this product's life so far. A business with NULL here can still list
-- and still be booked; what it cannot do is be paid, which is why the two
-- flags below are read before any transfer is attempted.
ALTER TABLE operators ADD COLUMN stripe_account_id TEXT;

-- Stripe's own answers about that account, copied here so the booking path
-- never has to make a network call to find out whether somebody can be paid.
--
-- COPIES OF A REMOTE FACT, and treated as such. Stripe is the authority; these
-- are a cache refreshed from the account.updated webhook and whenever the
-- operator opens their settings. Anything that MOVES money re-reads Stripe
-- rather than trusting these — a stale 1 here would mean a transfer that fails
-- after the customer has already been charged.
ALTER TABLE operators ADD COLUMN stripe_charges_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE operators ADD COLUMN stripe_payouts_enabled INTEGER NOT NULL DEFAULT 0;

-- When those two flags were last refreshed, so a stale cache is visible as
-- stale rather than looking like a fresh 'no'.
ALTER TABLE operators ADD COLUMN stripe_updated_at INTEGER;

-- One connected account per business, and one business per connected account.
-- NULLABLE plus a unique index is the same pattern login_email uses in 0038:
-- SQLite treats NULLs as distinct, so every un-onboarded operator can sit here
-- at once while a real account id belongs to exactly one row. Without this, a
-- bug that copied an account id across two operators would pay the wrong
-- person and leave no trace of why.
CREATE UNIQUE INDEX idx_operators_stripe_account ON operators (stripe_account_id);

-- ---------------------------------------------------------------------------
-- 2. The charge
-- ---------------------------------------------------------------------------

-- The PaymentIntent taking the money for this order: 'pi_...'. Written when
-- the payment form is opened, not when it succeeds, so a customer who comes
-- back to a half-finished checkout resumes the same intent rather than
-- creating a second one against the same appointments.
ALTER TABLE orders ADD COLUMN payment_intent_id TEXT;

-- The charge the intent produced: 'ch_...'. Needed by name when transferring,
-- because source_transaction is what tells Stripe which settled charge is
-- funding a transfer — without it, money can be sent that has not arrived.
ALTER TABLE orders ADD COLUMN charge_id TEXT;

-- What the platform kept across the whole order, in cents. The sum of the
-- per-item fees below, stored again here because a total that has to be
-- recomputed from its parts is a total that will one day disagree with them.
ALTER TABLE orders ADD COLUMN fee_cents INTEGER NOT NULL DEFAULT 0;

-- When the money actually arrived. NULL is the honest state for every order
-- written before this migration and for every basket abandoned at the card
-- form, and it is what separates "claimed" from "paid".
ALTER TABLE orders ADD COLUMN paid_at INTEGER;

-- What Stripe last said about the intent — 'requires_payment_method',
-- 'processing', 'succeeded', 'canceled'. Kept so a support question about a
-- stuck booking can be answered without opening the Stripe dashboard.
ALTER TABLE orders ADD COLUMN payment_status TEXT;

-- One order per PaymentIntent. The webhook finds the order from the intent id,
-- and two orders claiming one intent would make that lookup ambiguous at the
-- exact moment money is being assigned to a booking.
CREATE UNIQUE INDEX idx_orders_payment_intent ON orders (payment_intent_id);
CREATE INDEX idx_orders_unpaid ON orders (paid_at, created_at)
  WHERE paid_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Paying the business
-- ---------------------------------------------------------------------------

-- This line's share of the fee, in cents, as it was worked out at checkout.
--
-- WRITTEN DOWN RATHER THAN DERIVED, and this is the column that matters most
-- in the file. The ceiling is per business per day, so one line's fee depends
-- on what else that same business is doing that same day inside that same
-- order. Recomputing it later — from a price, from a rate, from anything —
-- gets a different answer the moment a line is cancelled or refunded. What
-- was charged is a historical fact and it is recorded as one.
ALTER TABLE order_items ADD COLUMN fee_cents INTEGER NOT NULL DEFAULT 0;

-- The Transfer that paid this business: 'tr_...'. NULL until the charge has
-- settled and the transfer has been made, which is a separate step from the
-- customer paying — see the webhook.
ALTER TABLE order_items ADD COLUMN transfer_id TEXT;
ALTER TABLE order_items ADD COLUMN transferred_at INTEGER;

-- The work queue for the webhook: everything paid for and not yet paid out.
-- Partial, so it stays small — the overwhelming majority of rows are settled
-- and are not in it.
CREATE INDEX idx_order_items_untransferred ON order_items (order_id)
  WHERE transfer_id IS NULL;

-- One transfer per line. A webhook delivered twice, a retry after a timeout, a
-- manual replay from the Stripe dashboard — all three end at this index rather
-- than at a business being paid twice out of money that was only collected
-- once. lib/stripe.ts also sends an idempotency key keyed on the same row; the
-- two together mean a double payout needs both Stripe and this database to
-- fail at once.
CREATE UNIQUE INDEX idx_order_items_transfer ON order_items (transfer_id);
