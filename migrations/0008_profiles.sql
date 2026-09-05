-- Operator profiles and work photos.
--
-- The public slot list sells a time and a price. What it cannot answer is the
-- question every stranger actually asks before letting someone into their
-- driveway: who is this, and is their work any good. A directory listing with
-- no face and no photographs loses that person to the one that has both.
--
-- So an operator gets a page of their own — a slug they can hand out, a short
-- pitch, and a handful of photographs of finished jobs — and it is opt-in,
-- because a half-filled profile published by default is worse than none.

-- One line under the business name. Kept separate from bio so the slot list
-- and map pins can show something short without loading a paragraph.
ALTER TABLE operators ADD COLUMN tagline TEXT;

ALTER TABLE operators ADD COLUMN bio TEXT;

-- Years in the trade. The single credential a sole trader has that a directory
-- cannot fake, and the one strangers weigh hardest.
ALTER TABLE operators ADD COLUMN years_experience INTEGER;

-- The operator's public URL segment, derived from business_name at first
-- publish. Stored rather than computed so renaming the business does not break
-- links already printed on a van.
ALTER TABLE operators ADD COLUMN profile_slug TEXT;

-- R2 object key for the avatar. We keep the key, not a URL: the bucket and
-- the public hostname in front of it change, the object does not.
ALTER TABLE operators ADD COLUMN avatar_key TEXT;

-- Nothing goes public until the operator says so. A profile is created empty
-- during onboarding, and an empty profile discovered by a customer reads as an
-- abandoned business.
ALTER TABLE operators ADD COLUMN is_published INTEGER NOT NULL DEFAULT 0
  CHECK (is_published IN (0,1));

-- Two businesses cannot claim the same public URL. Partial so the vast
-- majority of operators — who have never published — all sit at NULL without
-- colliding with each other.
CREATE UNIQUE INDEX idx_operators_profile_slug ON operators (profile_slug)
  WHERE profile_slug IS NOT NULL;

-- Photographs of finished work.
--
-- Rows, not a JSON blob on operators, because the operator reorders them,
-- deletes one at a time, and the caption is edited long after upload. Each row
-- points at an R2 object; the bytes never touch D1.
CREATE TABLE work_photos (
  id            TEXT PRIMARY KEY,
  operator_id   TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,

  r2_key        TEXT NOT NULL,

  caption       TEXT,

  -- Recorded at upload so the public page can reserve the right box before the
  -- image arrives. Without them the profile reflows as each photo loads.
  width         INTEGER,
  height        INTEGER,

  -- Kept so the per-operator storage an account is using can be totted up
  -- without listing the bucket.
  bytes         INTEGER,

  content_type  TEXT NOT NULL,

  -- The operator's chosen order. Their best job has to be able to lead,
  -- and upload order is not that.
  sort_order    INTEGER NOT NULL DEFAULT 0,

  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- The public page's only query: this operator's photos, in their order.
CREATE INDEX idx_work_photos_operator ON work_photos (operator_id, sort_order);
