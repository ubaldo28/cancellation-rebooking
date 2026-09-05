-- What the law already requires of the businesses listed here.
--
-- This site is United States only, and California only while we are testing.
-- The work it lists is work California regulates. A mobile locksmith is
-- licensed by the Bureau of Security and Investigative Services. A mobile
-- mechanic has to be registered with the Bureau of Automotive Repair as an
-- Automotive Repair Dealer. Pest control is licensed by the Structural Pest
-- Control Board. And any single job over $1,000, labour and materials counted
-- together, is contractor work and needs a licence from the Contractors State
-- License Board; under that figure, someone without one has to say in their
-- advertising that they are unlicensed.
--
-- Listing an unlicensed person for licensed work is real exposure — for them,
-- for the customer who finds they have no recourse, and for us. So the platform
-- collects what those businesses are already required to hold, and shows it.
--
-- What the platform does NOT do is check it. Nothing in these columns is
-- verified against CSLB, BSIS, BAR or the Structural Pest Control Board. They
-- hold what a business asserted about itself, and that is exactly why they are
-- worth storing: the claim is the operator's own, and saving it moves
-- operators.updated_at, so it is on the record as of when they made it. A
-- "verified" column would be a lie about work nobody here does, so there is
-- none.

-- Which authority, if any, licenses this business: 'cslb', 'bsis', 'bar',
-- 'spcb', or 'none' for work that needs no state licence.
--
-- Free text rather than a CHECK list, because the set of regulators grows the
-- moment this leaves California and a migration is a poor place to find that
-- out. NULL means they have not answered yet, which is not the same as 'none'
-- and must never be displayed as it.
ALTER TABLE operators ADD COLUMN license_kind TEXT;

-- The number as printed on the licence. Kept as typed: it is a reference a
-- customer or a regulator can look up for themselves, which is the only
-- checking that actually happens.
ALTER TABLE operators ADD COLUMN license_number TEXT;

-- The state that issued it. 'CA' for everyone today. A licence number with no
-- state against it is a number nobody can look up, and this field is what stops
-- an out-of-state licence being read as a California one when we open up.
ALTER TABLE operators ADD COLUMN license_state TEXT;

-- Unix seconds. An expired licence is not a licence, and it is the one part of
-- this claim that goes wrong on its own, with nobody doing anything — so it is
-- stored as a date we can compare against rather than as more prose.
ALTER TABLE operators ADD COLUMN license_expires_at INTEGER;

-- The operator has acknowledged that they must advertise as unlicensed and cap
-- any single job at $1,000 in labour and materials.
--
-- Recorded rather than inferred from the absence of a licence. Not holding a
-- licence is a fact about them; agreeing to the obligation that comes with it
-- is a decision they made, and only the second one is worth anything if the
-- listing is ever questioned. Defaults to 0, because nobody has agreed to
-- anything by sitting still.
ALTER TABLE operators ADD COLUMN unlicensed_ack INTEGER NOT NULL DEFAULT 0
  CHECK (unlicensed_ack IN (0,1));

-- Who wrote the policy, and its number. Insurance is not a state licence and
-- is not required by any of the rules above; it is here because it is the first
-- thing a customer asks a stranger working on their property, and because a
-- business that carries it should be able to say so.
ALTER TABLE operators ADD COLUMN insurer TEXT;
ALTER TABLE operators ADD COLUMN policy_number TEXT;

-- Unix seconds. Same reason as the licence date: cover lapses quietly, and a
-- lapsed policy still showing on a public page is worse than no policy shown.
ALTER TABLE operators ADD COLUMN insurance_expires_at INTEGER;

-- The operator has acknowledged that the cover they entered is theirs and
-- current. Stored for the same reason as unlicensed_ack: it dates the claim to
-- the person who made it.
ALTER TABLE operators ADD COLUMN insured_ack INTEGER NOT NULL DEFAULT 0
  CHECK (insured_ack IN (0,1));
