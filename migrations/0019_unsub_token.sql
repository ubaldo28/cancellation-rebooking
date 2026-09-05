-- A one-purpose key so an alert email can carry an unsubscribe link.
--
-- The watch's own token is stored only as a hash, on purpose: it grants full
-- control of the watch, so a leaked database must not hand it out. But that
-- means the matcher — which is what actually sends the email — has no way to
-- build a link back to the watch, and an email nobody can stop is not a
-- product decision, it is a legal problem.
--
-- This token is stored in plain text deliberately. It does exactly one thing:
-- switch this watch off. It cannot read the watch, change the address, or
-- reveal anything, so the worst a leak allows is turning off alerts somebody
-- asked for. That is a far smaller harm than sending mail with no way out.
ALTER TABLE watches ADD COLUMN unsub_token TEXT;

CREATE UNIQUE INDEX idx_watch_unsub ON watches (unsub_token)
  WHERE unsub_token IS NOT NULL;
