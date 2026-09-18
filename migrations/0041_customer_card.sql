-- ---------------------------------------------------------------------------
-- 0041 — the customer, as the processor knows them
-- ---------------------------------------------------------------------------
--
-- 0037 gave the account somewhere to put a card: payment_ref, plus the brand
-- and the last four so a person can tell which of their cards it is. What it
-- did not give it is the thing at the processor that a SAVED card has to hang
-- off. A card typed into a form belongs to that form and to nothing after it;
-- charging it a second time needs it filed under an object that outlives the
-- form, and at Stripe that object is a Customer — `cus_...`, with an id of its
-- own. Without one there is nothing to charge in December against a card typed
-- in September, which is the whole reason a card is taken at booking time
-- rather than asked for on the doorstep.
--
-- IT BELONGS TO THE PLATFORM ACCOUNT, NOT TO A BUSINESS. 0040 set the shape:
-- the customer pays this platform once, and each business is paid afterwards by
-- a separate transfer. So the card has to be saved where the charge is made. A
-- customer object created on a connected account would hold a card that the
-- account actually taking the money cannot use, and a basket spanning two
-- businesses would mean the same person storing the same card twice and being
-- asked for it again by whichever business they had not booked before.
--
-- STILL NO CARD DATA, and this column changes nothing about that. `cus_...` is
-- an opaque handle, the same kind of thing payment_ref already holds; it is not
-- a number, an expiry or a CVC, and src/lib/payments.ts refuses any of those at
-- ingress, at every database bind and on the way out.

-- The account's identity at the processor. NULL for everybody who has not
-- reached a card form yet, which today is every customer there is: the column
-- is written the first time somebody adds a card and read on every booking
-- afterwards, so that the second booking charges the card the first one saved
-- instead of asking for it again.
ALTER TABLE customer_accounts ADD COLUMN stripe_customer_id TEXT;

-- One customer object per account, and one account per customer object.
--
-- The same NULLABLE-plus-unique pattern as operators.stripe_account_id in 0040
-- and login_email in 0038: SQLite treats NULLs in a unique index as distinct,
-- so every account without a card sits here at once while a real handle belongs
-- to exactly one row. This is the half of the guarantee that survives a race.
-- Two requests arriving together can both create a customer at Stripe, and only
-- one of them can write the id — ensureStripeCustomer makes its UPDATE
-- conditional on this column still being NULL, so the loser re-reads the row
-- and uses the winner's id. What that costs is one unused customer object at
-- Stripe holding no card. What it prevents is two rows claiming one handle, or
-- one person's saved card being charged for somebody else's booking, which is
-- the failure nobody would notice until a stranger's statement showed it.
CREATE UNIQUE INDEX idx_customer_accounts_stripe_customer
  ON customer_accounts (stripe_customer_id);
