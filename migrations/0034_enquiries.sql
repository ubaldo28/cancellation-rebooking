-- A stranger writes to a business from its profile, and cannot write to all of
-- them.
--
-- Until now the only way into a conversation was to place a booking: claimSlot
-- and placeOrder mint the guest token, and /c/:token is worthless without one.
-- So the reference marketplace's two first-class profile actions -- "Message"
-- and "Request a quote", both usable when nothing is scheduled -- had no
-- server behind them at all. Adding one raises a question the booking path
-- never had to answer, because a booking costs the person making it a name, a
-- phone number and an address: what stops one script opening a conversation
-- with every business in Los Angeles.
--
-- IT IS NOT A RATE LIMIT, AND THIS IS THE WHOLE REASON THIS TABLE EXISTS.
-- rate_limits counts REQUESTS in a fixed window, bucketed by whatever key the
-- caller passes. `thread-ip:<ip>` at ten per quarter hour is the right shape
-- for volume and blind to the thing that matters here: ten conversations with
-- ten different businesses and ten messages inside one conversation are the
-- same number to it, and they are not remotely the same act. The first is a
-- spray; the second is a customer talking. Counting BREADTH -- how many
-- distinct businesses one address has opened a conversation with -- separates
-- them, and it is the only measurement that does.
--
-- The same shape as guest_link_attempts in 0030: the one thing a sender cannot
-- vary for free is where they are calling from, so that is the key. A row is
-- the fact that this address has already reached this business, which is why
-- writing to the same business again does not add one -- somebody going back
-- and forth with a plumber must never be spending the allowance that stops a
-- spray.
CREATE TABLE enquiry_reach (
  -- CF-Connecting-IP, which cannot be spoofed at the edge. 'unknown' when
  -- there is no header, which lumps those callers into one bucket on purpose:
  -- a caller we cannot place is exactly the one that should not get its own
  -- private allowance.
  ip           TEXT NOT NULL,

  -- The business reached. Not a foreign key with a cascade: this is a record
  -- of what an address did, and deleting an operator must not quietly hand
  -- whoever was spraying it a fresh allowance.
  operator_id  TEXT NOT NULL,

  -- When this address first reached this business. The window is measured from
  -- here and never bumped, so a long conversation with one business does not
  -- keep its own row alive and crowd out the count.
  first_at     INTEGER NOT NULL,

  PRIMARY KEY (ip, operator_id)
);

-- The count is "distinct businesses this address reached since T", so the
-- lookup is by ip and then by time. Ordering the key this way lets one index
-- serve both that count and the sweep's range scan below.
CREATE INDEX idx_enquiry_reach_window ON enquiry_reach (first_at);

-- ---------------------------------------------------------------------------
-- Reading reviews across a whole trade, rather than one business at a time
-- ---------------------------------------------------------------------------
-- The reference's service page carries a strip of recent reviews from every
-- business doing that work. idx_reviews_operator from 0027 is (operator_id,
-- created_at DESC), which is exactly wrong for that question: there is no
-- operator to look up, and the trade lives on the operators table. Without
-- these the query is a full scan of reviews joined against a full scan of
-- operators, on a page built to be crawled.

-- Which businesses are in this trade and have a public page to link a review
-- to. is_published is in the key rather than left to a filter because an
-- unpublished business is the majority of rows on a young site.
CREATE INDEX idx_operators_trade_published ON operators (trade, is_published);

-- Newest first across every business at once. Partial, because a hidden review
-- is never read by any public path and there is no reason to carry it in the
-- index the public paths use.
CREATE INDEX idx_reviews_recent ON reviews (created_at DESC) WHERE hidden_at IS NULL;
