-- The conversation, on the customer's account.
--
-- WHAT WAS WRONG, AND WHAT IT COST.
--
-- A customer's conversation with a business has lived behind exactly one
-- secret since 0011: the token in /c/:token. Only its peppered hash is stored,
-- deliberately, so nobody here can hand it back -- and the page said so in as
-- many words: "Keep this link, it is the only way to this conversation."
--
-- That was true when it was written and stopped being true at 0037, when
-- customers got accounts. It went on being PRINTED, though, and the gap
-- between the sentence and the schema is the whole of this migration. A person
-- who booked, closed the tab and cleared their history had a proved email
-- address, an account, an order against it and a booking listed at /account --
-- and no way whatever back to the conversation about that booking. Not the
-- messages, not the photographs they had sent of their own kitchen, not the
-- start code, not the unpaid card form. All of it sat behind a secret that by
-- design nobody could reissue, including them.
--
-- The business side never had this problem: an operator signs in and
-- /app/messages lists every thread they have, scoped by operator_id in the
-- WHERE clause. The customer side had no equivalent column, so it had no
-- equivalent query, so it had no equivalent page.
--
-- ---------------------------------------------------------------------------
-- WHY A COLUMN AND NOT THE JOIN THAT ALREADY EXISTS
-- ---------------------------------------------------------------------------
-- A thread can already be walked to an account without this column, and it is
-- worth writing down exactly how, because that walk is what backfills it at
-- the bottom of this file and it is also the reason the column is here rather
-- than the walk being run on every request.
--
-- There are two hops, and BOTH are needed -- neither on its own is complete:
--
--   threads.appointment_id -> order_items.appointment_id -> orders.customer_account_id
--   threads.client_id      -> order_items.client_id      -> orders.customer_account_id
--
-- appointment_id is the tighter of the two and the one that goes stale: a
-- thread is not retired when a job ends, so a returning customer writing to
-- the same business on the same link has their thread RE-POINTED at the new
-- booking (see attachBooking in lib/chat.ts). client_id is the stable one --
-- one row per person per business -- but it is null on a thread that started
-- as an enquiry and on the older single-slot claims that predate orders
-- entirely. So the honest form of the join is an OR over both, and an OR over
-- two nullable columns is exactly the shape no index helps with.
--
-- There is a third path and it is a trap: orders.thread_token_hash, added in
-- 0016, is the hash of a thread's guest token and joins straight to
-- threads.guest_token_hash. It looks like the best of the three and it is
-- incomplete by construction -- placeOrder writes threads[0] only, so a basket
-- spanning two businesses records one of its two conversations and silently
-- loses the other, and lib/retention.ts nulls the column on erasure. A door
-- built on it would open for the first business in a two-business basket and
-- 404 for the second, which is worse than not having the door.
--
-- So the column, for three reasons in the order they matter:
--
--   1. AUTHORISATION HAS TO BE ONE INDEXED EQUALITY. The check a request does
--      is "is this thread this account's", and the pattern the rest of this
--      codebase uses for that question is threadForOperator's
--      `WHERE id = ? AND operator_id = ?` -- one row, one index, nothing to
--      get subtly wrong. Spelling the same check as a three-table EXISTS with
--      an OR over two nullable columns is a correctness risk before it is a
--      performance one: every future reader has to re-derive why NULL = NULL
--      being false is what stops an enquiry thread with no client_id matching
--      every account in the table.
--
--   2. IT IS THE ONLY WAY TO ANSWER A BOOKING-LESS ENQUIRY. A conversation
--      that never became a booking has no order, no appointment and no client
--      row, so the join above reaches nothing and can never reach anything.
--      That is most of the enquiries opened from a profile page. When the
--      person who opened one was signed in at the time we know whose it is,
--      and a column is the only place to put that -- there is nothing else on
--      the thread to infer it from later, and inventing one would mean
--      guessing at an address nobody proved.
--
--   3. THE LIST IS THE REVERSE DIRECTION. "Every conversation on this account,
--      most recent first" driven through the OR-join is a scan of the
--      account's order_items joined to threads with no supporting index. As
--      one column with an index on it, it is the same shape as the operator's
--      own inbox query and costs the same.
--
-- ---------------------------------------------------------------------------
-- WHAT THE COLUMN IS NOT
-- ---------------------------------------------------------------------------
-- NOT A FOREIGN KEY, for the reason the rest of this table already gives
-- about appointment_id and client_id: a conversation is the record of what two
-- people agreed, and closing or erasing an account must not take the business
-- end of it away. lib/customers.ts empties a closed account's personal columns
-- and leaves the orders; the same reasoning applies here, and ON DELETE
-- CASCADE would quietly delete the operator's copy of the conversation too.
--
-- NOT THE AUTHORITY ON THE LINK. /c/:token is untouched by this file and by
-- every line of the code that reads it. A guest who never made an account has
-- nothing else, and a customer opening their confirmation on a phone that has
-- never been signed in is the ordinary case rather than the exotic one. This
-- is a second door, and the token door was not narrowed to fit it.
--
-- NOT A SECRET. It is an account id, not a token: holding it proves nothing
-- and grants nothing. Nothing is authorised by comparing it to a value from a
-- request -- the value it is compared against comes from a session cookie
-- resolved through lib/customers.ts, exactly as /api/customer/bookings does.
-- It is deliberately stripped out of the guest payload anyway (see guestView
-- in src/index.ts): there is no screen that shows it, and a field nothing
-- reads is a field that only travels.
ALTER TABLE threads ADD COLUMN customer_account_id TEXT;

-- last_message_at DESC in the index, because that is the order the list is
-- read in and there is no second ordering anybody wants: a conversation list
-- is "what is happening now, first". The same shape as idx_threads_operator
-- from 0011, which serves the business's side of exactly this query.
CREATE INDEX idx_threads_account
  ON threads (customer_account_id, last_message_at DESC);

-- ---------------------------------------------------------------------------
-- The backfill
-- ---------------------------------------------------------------------------
-- Every conversation that ALREADY belongs to an account, filled in from the
-- join described above. Without this the feature would ship working only for
-- bookings made after the deploy, which on a live site means the people who
-- most need it -- the ones who lost a link months ago -- are the ones it does
-- not help.
--
-- The OR is the whole point and it is written the long way round on purpose.
-- NULL = NULL is not true in SQL, so a thread with a null appointment_id and a
-- null client_id matches no order_item at all and keeps its null account,
-- which is the correct answer for an anonymous enquiry. Relying on that
-- silently would be relying on a reader knowing it; hence this paragraph.
--
-- operator_id is in the condition as well as the OR, and it is not redundant
-- decoration. client ids are the operator's own, so two businesses can hold
-- rows with ids that mean different people; without the scope, a thread could
-- in principle be attributed through another business's line. The correlated
-- lookup is cheap either way -- idx_orders_account finds the account's orders
-- and idx_order_items_order finds their lines -- and this runs once, at deploy.
--
-- LIMIT 1 rather than an aggregate: a thread reaches at most one account by
-- construction (one person holds one link), and if the data ever disagreed
-- with that the right behaviour is to pick the row the join found and leave
-- the anomaly visible, not to invent a merge.
UPDATE threads
   SET customer_account_id = (
     SELECT o.customer_account_id
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
      WHERE o.customer_account_id IS NOT NULL
        AND oi.operator_id = threads.operator_id
        AND (oi.appointment_id = threads.appointment_id
             OR oi.client_id = threads.client_id)
      LIMIT 1)
 WHERE customer_account_id IS NULL;
