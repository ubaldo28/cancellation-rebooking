-- "Build some sort of tracking so we can see the van moving."
--
-- Two audiences, and the difference between them is the whole design.
--
-- The OPERATOR sees their own van: where it is now and the short trail behind
-- it, on their own dashboard, scoped by operator_id like everything else here.
--
-- The CUSTOMER sees roughly where the van is and when it will arrive, and only
-- in a window around the appointment they actually booked. They never get a
-- live dot following a self-employed person around all day. That is not a
-- product decision to be traded off later: the operator is one person driving
-- their own vehicle, often home to a home address, and a public link that
-- tracks them continuously is a stalking tool. So the customer read is gated
-- on consent, on time, and on freshness, and the coordinate handed over is
-- rounded to ~110 m -- close enough to say "they are nearly here", too coarse
-- to say which house they are outside.

-- ---------------------------------------------------------------------------
-- Where each van is RIGHT NOW. One row per operator, upserted forever.
-- ---------------------------------------------------------------------------
--
-- This is deliberately NOT an append-only log of pings, and that is the single
-- most important line in this file.
--
-- A van pinging every 30 seconds over an 8-hour day is 960 writes; a phone
-- left on all day is 2,880. One row per ping per operator means a thousand
-- operators write roughly 3 million rows a day into a database on a free tier
-- whose daily write allowance is a fraction of that -- and then we would pay
-- to store, index and eventually delete a breadcrumb trail of a named
-- individual's movements, which is both the biggest bill in the product and
-- the worst thing in it to hold.
--
-- And nothing in the product needs yesterday's breadcrumbs. The operator's
-- dashboard wants "where am I now"; the customer wants "how long until you get
-- here". Neither question has ever been asked about last Tuesday. If route
-- history is ever genuinely wanted, it belongs in a separate opt-in feature
-- with its own retention rule, not as a side effect of a live map.
--
-- So: one row, overwritten in place. Write volume is bounded by the number of
-- operators, not by the number of pings.
CREATE TABLE van_positions (
  operator_id     TEXT PRIMARY KEY REFERENCES operators(id) ON DELETE CASCADE,

  lat             REAL NOT NULL,
  lng             REAL NOT NULL,

  -- Straight off the phone's Geolocation API. accuracy_meters is what makes a
  -- position honest: a 2 km fix from a cell tower and a 5 m fix from GPS look
  -- identical once they are two numbers, and only one of them should be shown
  -- to a customer as "the van is here".
  accuracy_meters REAL,
  heading         REAL,
  speed_mps       REAL,

  -- When the PHONE took the fix, not when we stored it. These two differ by
  -- however long the van spent in a dead spot, and the difference is exactly
  -- what the staleness gate is measuring -- a five-minute-old fix that arrived
  -- one second ago is still a five-minute-old fix.
  recorded_at     INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- A SHORT recent trail, so the map draws movement instead of a static pin.
-- ---------------------------------------------------------------------------
--
-- A single pin tells you nothing: a van parked for lunch and a van doing 50
-- along the ring road look the same. A few dozen points behind it show
-- direction and whether it is actually moving, which is the entire difference
-- between "we can see the van moving" and "we can see a dot".
--
-- This is a DISPLAY DETAIL, not history. It is trimmed to the most recent N
-- points per operator on every write (see MAX_TRAIL_POINTS in src/lib/track.ts
-- -- 40, roughly the last twenty minutes at a ping every 30 seconds), so the
-- table's size is bounded by operator count, exactly like van_positions above,
-- and the same reasoning applies: the rows that age out are somebody's
-- movements and we are better off not holding them.
--
-- Nothing here is ever shown to a customer. The trail is the operator's own
-- view of their own day.
CREATE TABLE van_trail (
  id          TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  recorded_at INTEGER NOT NULL
);

-- Both reads this table gets: the newest N points for one operator (drawing
-- the trail) and the oldest ones past N (trimming it). operator_id leads
-- because it is the tenant boundary and no query here may ever omit it;
-- recorded_at DESC means both reads come straight off the index.
CREATE INDEX idx_van_trail_operator ON van_trail (operator_id, recorded_at DESC);

-- ---------------------------------------------------------------------------
-- Consent. Off by default, and it has to be.
-- ---------------------------------------------------------------------------
--
-- DEFAULT 0 is the whole point of this column. Location sharing is something a
-- person switches on for themselves, knowing what it does; it is never
-- something switched on for them by a migration, by an admin, or by a helpful
-- default that nobody read. Every existing operator gets 0, and the only thing
-- that can move it to 1 is that operator's own request through
-- setShareLocation().
--
-- It gates the CUSTOMER read only. An operator can always see their own van --
-- it is their phone, their van and their dashboard -- but with this at 0 no
-- customer link will return a position, whatever else is true.
ALTER TABLE operators ADD COLUMN share_location INTEGER NOT NULL DEFAULT 0
  CHECK (share_location IN (0,1));
