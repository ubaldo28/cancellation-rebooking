-- Telling a customer when a van with a free hour comes near their door.
--
-- Everything so far is pull: a stranger opens the map, types a postcode and
-- sees what is open right now. That only works if they happen to look in the
-- window between a cancellation and somebody else taking the slot, which is
-- usually a few hours. Most people are not looking. The opening expires, the
-- operator eats the empty hour, and the customer who would gladly have taken
-- it never knew it existed.
--
-- So this is the push half: "I want mobile detailing near 91403, tell me."
--
-- Deliberately NOT SMS. The operator has been explicit -- no number exchange,
-- no SMS -- and the same reasoning applies here with more force: a watch is a
-- standing subscription, so an SMS watch is a standing per-message bill and a
-- phone number we would have to hold, secure and honour a deletion request
-- for, for someone who never even booked. Web Push costs nothing, needs no
-- provider account, is revocable by the customer from their own browser in one
-- tap, and carries no identifier we could sell or leak. The endpoint IS the
-- address; there is no phone number in this file anywhere.

-- One standing request: a place, optionally a kind of work, and how far out of
-- a van's way the customer is willing to be.
CREATE TABLE watches (
  id                  TEXT PRIMARY KEY,

  -- The hash of the secret in their link, never the secret itself, hashed with
  -- the server pepper exactly like sessions, offer links and chat threads.
  -- The customer has no account -- by design, see migration 0011 -- so this
  -- link is the only thing that says "this watch is mine": it is what edits
  -- the radius, adds a browser, and turns the whole thing off. Stored raw, a
  -- dumped database would be a working set of keys to every stranger's home
  -- postcode with nothing to revoke. Hashed, the dump is inert.
  token_hash          TEXT NOT NULL,

  -- Where they are. The postcode is kept as they typed it so the manage page
  -- can show them what they asked for, and the coordinates are resolved once
  -- at creation: the matcher runs every fifteen minutes over every watch, and
  -- re-geocoding each one on every tick would be the same lookup, forever, for
  -- an address that has not moved.
  postcode            TEXT NOT NULL,
  lat                 REAL NOT NULL,
  lng                 REAL NOT NULL,
  country             TEXT NOT NULL,

  -- JSON array of trade strings: ["mobile detailing","junk removal"].
  -- NULL means any trade, which is the honest default -- somebody who asked
  -- for "anything near me" should not be filtered down to nothing by a
  -- spelling difference between what they picked and what an operator typed.
  --
  -- Not a join table on purpose. A watch has one to three of these, they are
  -- rewritten wholesale whenever the customer edits the watch, and nothing
  -- ever queries "which watches want detailing" -- the matcher already holds
  -- every candidate slot in memory when it needs to know.
  trades              TEXT,

  -- The number that makes this different from a mailing list: how far out of
  -- the van's way this customer is worth going. It is the customer's half of
  -- the same tolerance operators.max_detour_seconds expresses for the
  -- operator, and a match has to satisfy both. Fifteen minutes by default.
  max_detour_seconds  INTEGER NOT NULL DEFAULT 900,

  -- Optional ceiling. Someone watching for a cheap slot does not want to be
  -- woken for the premium package.
  max_price_cents     INTEGER,

  -- What they called it: "home", "mum's place". Shown back to them so a
  -- person with two watches can tell which is which before switching one off.
  label               TEXT,

  -- Off, not deleted. An unsubscribe that erases the row loses the record of
  -- what they asked for, so a customer who turns alerts off for a fortnight
  -- has to describe their whole watch again to get it back -- and most do not
  -- bother. It also means an accidental unsubscribe is one tap to undo.
  active              INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),

  -- The rate limiter's memory. The matcher reads last_notified_at before it
  -- sends anything: without it, a busy morning in one neighbourhood is twenty
  -- pushes for twenty openings to the same person, and the second thing they
  -- do is turn notifications off for the whole site -- which is a permission
  -- we never get back. notify_count is cumulative and is there to answer "is
  -- this feature actually delivering anything" without reading the hits table.
  last_notified_at    INTEGER,
  notify_count        INTEGER NOT NULL DEFAULT 0,

  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- One live link per watch. A duplicate hash would mean two watches answering
-- to the same secret, and whichever one a lookup happened to return first
-- would decide whose home postcode a stranger gets to edit.
CREATE UNIQUE INDEX idx_watches_token ON watches (token_hash);

-- The matcher's only read of this table: every live watch, with the
-- coordinates it needs, straight out of the index. active leads because a
-- switched-off watch must never cost the cron anything.
CREATE INDEX idx_watches_live ON watches (active, lat, lng);

-- Where a notification is actually delivered.
--
-- A Web Push subscription is browser-and-device specific: the same person on a
-- phone and a laptop is two rows, and neither is an identity we can resolve
-- back to a human. That is the point -- the endpoint is a bearer URL issued by
-- Google/Mozilla/Apple, revocable by the customer, and worth nothing to
-- anybody who steals it without the keys below.
CREATE TABLE push_subscriptions (
  id           TEXT PRIMARY KEY,

  -- CASCADE here, unlike the chat tables, because a subscription has no
  -- meaning without the watch it belongs to. There is nothing to preserve for
  -- the record: it is a delivery address, not a conversation.
  watch_id     TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,

  -- The push service URL we POST the encrypted payload to.
  endpoint     TEXT NOT NULL,

  -- The browser's public key and auth secret, from the PushSubscription the
  -- customer's own browser handed us. Both are needed to encrypt a payload
  -- per RFC 8291 -- the push service itself can never read the message, which
  -- is why storing them here is safe and why we cannot recover a payload
  -- either.
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,

  -- A push service answers 404 or 410 when a subscription is dead: the browser
  -- was uninstalled, the customer cleared site data, the endpoint rotated.
  -- Retrying that forever is a request per watch per tick that can never
  -- succeed, so a dead endpoint is stamped here and skipped. failed_count
  -- catches the slower version -- an endpoint that keeps timing out without
  -- ever admitting it is gone.
  failed_count INTEGER NOT NULL DEFAULT 0,
  disabled_at  INTEGER,

  created_at   INTEGER NOT NULL
);

-- One row per endpoint, globally. A browser that re-subscribes hands back the
-- same endpoint, and without this the customer collects a duplicate row on
-- every visit and then gets the same alert three times from one tap.
CREATE UNIQUE INDEX idx_push_subscriptions_endpoint ON push_subscriptions (endpoint);

-- Every live delivery address for one watch, which is what the matcher asks
-- for the instant it decides to send.
CREATE INDEX idx_push_subscriptions_watch ON push_subscriptions (watch_id, disabled_at);

-- What has already been announced to whom.
--
-- An opening stays open for hours and the matcher runs every fifteen minutes,
-- so the same gap is a match on every single tick until somebody books it.
-- Without this table that is one push, then another, then another, for the
-- same slot -- the exact behaviour that teaches a person to deny notification
-- permission for good.
CREATE TABLE watch_hits (
  id         TEXT PRIMARY KEY,
  watch_id   TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,

  -- Deliberately not a foreign key, for the reason migration 0011 gives for
  -- appointment_id: gaps are expired and cleaned up on a schedule, and a
  -- CASCADE here would quietly forget that we already told somebody about an
  -- opening -- which is only ever discovered by the customer being told twice.
  gap_id     TEXT NOT NULL,

  created_at INTEGER NOT NULL
);

-- THIS is the de-duplication. Not a SELECT in the matcher, not a set held in
-- memory: the matcher inserts the hit it wants to announce and lets the index
-- say whether it is new, so two cron ticks overlapping -- or two Workers
-- running at once, which is normal on Cloudflare -- cannot both decide the
-- announcement is theirs to make.
CREATE UNIQUE INDEX idx_watch_hits_once ON watch_hits (watch_id, gap_id);

-- The daily cap counts recent hits per watch. Time leads so the whole history
-- of the table is not walked once per tick.
CREATE INDEX idx_watch_hits_recent ON watch_hits (created_at, watch_id);
