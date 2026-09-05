-- Photos on a review, and the consent that has to come with them.
--
-- The reference profile shows photographs attached to individual reviews, and
-- they are among the most persuasive things on the page: somebody else's
-- actual result, next to the words of the person who paid for it.
--
-- This product already takes photographs of every job -- before, during and
-- after, from both sides -- so the pictures exist. What it cannot do is show
-- them. Those are the inside of somebody's house, their car, their driveway,
-- sometimes their children's things in the background, and they were taken as
-- EVIDENCE for a dispute, not as marketing. Publishing them because they
-- happen to be there would be the worst kind of default: technically the
-- customer uploaded it, practically nobody agreed to anything.
--
-- So a job photo becomes public only when the customer who took it says so,
-- one photo at a time, while writing their review.

-- 0 for every photo that already exists and every photo taken from now on.
-- The only thing that can set it to 1 is the customer, on their own photo,
-- from the review form.
ALTER TABLE job_photos ADD COLUMN public_on_review INTEGER NOT NULL DEFAULT 0
  CHECK (public_on_review IN (0,1));

-- The public read: this booking's photos that were released, in order taken.
-- Partial, because the released ones are a tiny fraction of the table and this
-- index is only ever used to find them.
CREATE INDEX idx_job_photos_public
  ON job_photos (order_item_id, created_at) WHERE public_on_review = 1;

-- ---------------------------------------------------------------------------
-- Why the operator cannot do this
-- ---------------------------------------------------------------------------
-- There is deliberately no operator path to setting this flag, and it is worth
-- writing down because it will look like a missing feature. An operator would
-- have every commercial reason to publish their best work and no way of
-- knowing whether the customer minds their hallway being on the internet. The
-- person whose house it is decides. An operator who wants photographs for
-- their profile takes their own and puts them in work_photos, which is what
-- that table has always been for.
