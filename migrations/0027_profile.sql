-- The business profile, built to the shape of the reference.
--
-- The existing profile was a name, a tagline, a bio and some photos. The
-- reference profile -- a real, established marketplace listing -- carries far
-- more, and almost all of it is load-bearing for the decision a customer is
-- actually making: do I let this stranger into my house.
--
-- What it has that this did not:
--
--   a rating and a review count, at the top, before anything else
--   how many times they have been hired
--   how long they have been in business, and how many people work there
--   where they work, and WHICH WAY THEY TRAVEL
--   how you can pay them
--   a background check, named
--   the questions everybody asks, answered in their own words
--
-- One thing the reference notably does NOT do is gate a listing on trade
-- licences. Its entire credentials section is a background check. That is
-- worth copying too, and this migration is where it stops being a debate.

-- ---------------------------------------------------------------------------
-- 1. The overview block
-- ---------------------------------------------------------------------------

-- "I travel to my customers" / "My customers travel to me", and the very
-- common both. It is the first thing somebody looks for on a mobile trade and
-- there was nowhere to say it.
ALTER TABLE operators ADD COLUMN work_location TEXT NOT NULL DEFAULT 'i_travel'
  CHECK (work_location IN ('i_travel','they_travel','both'));

-- "4 employees". A solo operator is the norm here, so the default says so.
ALTER TABLE operators ADD COLUMN employees INTEGER NOT NULL DEFAULT 1;

-- "40 years in business". Distinct from years_experience, which is the
-- person's own time in the trade -- somebody can have twenty years behind a
-- chair and have opened their own shop last spring, and both numbers are
-- worth showing.
ALTER TABLE operators ADD COLUMN years_in_business INTEGER;

-- Free text, comma separated, shown as a list. Not an enum: the ways people
-- take money change faster than a migration can, and a card that reads
-- "Zelle, Venmo, cash" is doing its whole job as a string.
ALTER TABLE operators ADD COLUMN payment_methods TEXT;

ALTER TABLE operators ADD COLUMN social_instagram TEXT;
ALTER TABLE operators ADD COLUMN social_facebook TEXT;
ALTER TABLE operators ADD COLUMN social_tiktok TEXT;

-- ---------------------------------------------------------------------------
-- 2. The background check
-- ---------------------------------------------------------------------------
-- The reference's ENTIRE credentials section is this: "Background Check",
-- a name, and a link to the detail. No trade licences, no board numbers.
--
-- NOTHING HERE RUNS A CHECK. It records that one was run, by whom, and on
-- which name, exactly as the licence fields record what a business asserts.
-- A `verified` boolean with nothing behind it would be the platform putting
-- its own word behind a stranger, and the people relying on it would be
-- customers letting that stranger through the door.
ALTER TABLE operators ADD COLUMN background_check_name TEXT;
ALTER TABLE operators ADD COLUMN background_checked_at INTEGER;
ALTER TABLE operators ADD COLUMN background_check_provider TEXT;

-- ---------------------------------------------------------------------------
-- 3. The questions everybody asks
-- ---------------------------------------------------------------------------
-- On the reference these are answered in the operator's own voice and they are
-- some of the most useful text on the page -- pricing, what happens on the
-- day, what training they have. Free text both sides, because the value is
-- entirely in it not being a form.
CREATE TABLE operator_faqs (
  id          TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  question    TEXT NOT NULL,
  answer      TEXT NOT NULL,
  -- Hand-ordered: the pricing question belongs first whatever order it was
  -- typed in.
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_faqs_operator ON operator_faqs (operator_id, position);

-- ---------------------------------------------------------------------------
-- 4. Reviews
-- ---------------------------------------------------------------------------
-- The single biggest thing missing. On the reference, reviews are most of the
-- page: a score, a count, a five-bar distribution, the words people search for
-- most, and then the reviews themselves -- each one carrying the exact options
-- that customer booked.
--
-- ONLY A REAL BOOKING CAN LEAVE ONE. order_item_id is required and unique, so
-- a review is always attached to a job that happened, and one job leaves at
-- most one review. That is what makes the number mean anything, and it is
-- worth more than volume: a marketplace with invented reviews is worth less
-- than one with none, because the first is a lie and the second is just young.
CREATE TABLE reviews (
  id            TEXT PRIMARY KEY,

  operator_id   TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,

  -- Not a foreign key with a cascade, like everything else that records what
  -- happened: cleaning up a booking must not erase what somebody said about it.
  order_item_id TEXT NOT NULL,

  -- The name as the customer gave it at booking. Shown as "Debra D." -- the
  -- surname is cut to an initial when it is displayed, never stored differently,
  -- so a correction stays possible.
  author_name   TEXT NOT NULL,

  rating        INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body          TEXT,

  -- "Wedding - 2 people - Day-of touch ups". Copied at the time from what was
  -- actually booked, exactly like order_item_services copies the price: the
  -- operator will rename that service one day and the review has to keep
  -- describing the job the customer actually had.
  details       TEXT,

  -- The business's reply, which the reference allows and which is often the
  -- most revealing thing on a bad review.
  reply         TEXT,
  replied_at    INTEGER,

  -- Hidden rather than deleted, for abuse. A removed review that leaves no row
  -- is indistinguishable from one that never existed, and that is exactly the
  -- power a platform should not quietly hold over its own rating.
  hidden_at     INTEGER,
  hidden_reason TEXT,

  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- ONE REVIEW PER JOB. Without it, one delighted customer can leave six
-- five-star reviews for the same afternoon and the score stops meaning
-- anything.
CREATE UNIQUE INDEX idx_reviews_item ON reviews (order_item_id);

-- The profile page's own query: this operator's reviews, newest first.
CREATE INDEX idx_reviews_operator ON reviews (operator_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 5. The score, kept on the operator
-- ---------------------------------------------------------------------------
-- Denormalised because it is read on every card, every map pin and every
-- search result, and recomputing an average over a growing table for each one
-- is the query that quietly gets slower for a year and then falls over.
-- Recomputed whenever a review lands.
ALTER TABLE operators ADD COLUMN rating_sum INTEGER NOT NULL DEFAULT 0;
ALTER TABLE operators ADD COLUMN rating_count INTEGER NOT NULL DEFAULT 0;

-- "Hired 314 times". Completed jobs, counted as they complete for the same
-- reason.
ALTER TABLE operators ADD COLUMN hired_count INTEGER NOT NULL DEFAULT 0;
