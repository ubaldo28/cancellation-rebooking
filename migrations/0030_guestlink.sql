-- Wrong guest links, counted, so the token space cannot be walked.
--
-- A customer has no account. The secret in /c/:token IS their identity, and it
-- is bearer authority over a whole conversation: the booking, the address, the
-- photographs of the inside of their house, the start code that gets somebody
-- through their front door. Only the hash is stored, which is right, and it is
-- also the whole of the defence -- there was nothing anywhere that noticed a
-- caller trying one token after another.
--
-- The rate limits already on those routes do not notice either, and it is
-- worth writing down why, because at a glance they look like they cover this.
-- They are bucketed ON THE TOKEN -- `thread-read:<token>`, `guest-msg:<token>`
-- -- which is the correct bucket for the thing they were built for: a family
-- behind one address must not share a budget, and the link is the only
-- identity a guest has. But a walk uses a DIFFERENT token every single time,
-- so every guess lands in a fresh bucket with a fresh allowance and the
-- ceiling is never reached by anybody. The one thing an attacker cannot vary
-- for free is where they are calling from, so that is what this counts.
--
-- The pattern is order_items.code_attempts from 0026, moved to the only key
-- available here. A wrong start code has a booking to be counted against; a
-- wrong guest token matches no row at all, so there is nothing to hang a
-- counter off except the caller.
CREATE TABLE guest_link_attempts (
  -- CF-Connecting-IP, which cannot be spoofed at the edge. 'unknown' when
  -- there is no header at all, which lumps those callers together -- a
  -- deliberate choice: a caller we cannot place is exactly the one that should
  -- not get its own private allowance.
  ip            TEXT PRIMARY KEY,

  -- Wrong links presented since window_started_at. Successful ones are never
  -- counted: the guest page polls its own valid link every fifteen seconds,
  -- and a customer reading their own booking must never be able to lock
  -- themselves out of it.
  failures      INTEGER NOT NULL DEFAULT 0,

  -- Failures older than the window are forgotten rather than accumulated over
  -- a lifetime. A permanent count would eventually catch a real person who
  -- mistyped a link twice a year, and a lockout somebody cannot age out of is
  -- a support ticket with no answer.
  window_started_at INTEGER NOT NULL,

  -- Set once the count crosses the threshold. Until it passes, every guest
  -- route refuses before it looks anything up, which is the point: the cost of
  -- a guess has to fall to nothing for the walker and stay nothing for us.
  locked_until  INTEGER
);

-- The sweep that clears rows nobody has touched in a long time. Without it
-- this table grows one row per address that ever fat-fingered a link and never
-- gives any of them back.
CREATE INDEX idx_guest_link_attempts_window
  ON guest_link_attempts (window_started_at);
