-- A stamp saying which version of the sample data is currently in the database.
--
-- WHY THIS EXISTS. The demo seed decides whether to rebuild by counting the
-- sample businesses: if all of them are present, it assumes the data is
-- current and does nothing. That test only notices a business being ADDED.
--
-- It missed a whole release. Reviews, star ratings, hired counts, background
-- checks, years in business and the open-for-work switch were all added to the
-- sample businesses, and none of it ever reached the live site -- the sixteen
-- rows were still sixteen rows, so the check said "up to date" and the site
-- kept serving businesses with no reviews. Every card feature built on that
-- data was invisible in production while looking perfectly fine locally,
-- because a local database starts empty and therefore always seeds fresh.
--
-- So the freshness test needs to measure the CONTENT of the seed, not its
-- row count. A version the seed itself carries does that: change the sample
-- data, bump the number, and the next request rebuilds. It also fails in the
-- safe direction -- forgetting to bump it leaves the old data in place, which
-- is the situation we are already in and can always be fixed by bumping it,
-- whereas a check that rebuilt too eagerly would wipe and rewrite the whole
-- sample account on every request.
--
-- Deliberately one row, keyed, rather than a general settings table. There is
-- exactly one thing to record and a general-purpose key-value table invites
-- everything else to move in and become a schema nobody designed.
CREATE TABLE demo_seed (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  version      INTEGER NOT NULL,
  seeded_at    INTEGER NOT NULL
);
