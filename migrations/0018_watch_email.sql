-- A second way to reach someone who asked to be told.
--
-- Migration 0013 made Web Push the only channel, and the reasoning there still
-- holds: it is free, it needs no provider account, the customer revokes it in
-- one tap and it carries no identifier worth stealing. What it does not do is
-- reach everybody. A person who says no to the browser prompt is never asked
-- again -- the denial is permanent and covers the whole origin. A person on an
-- iPhone has no push at all until they add the site to their Home Screen, and
-- almost nobody does that on the strength of one visit. Both of them fill in
-- the form, both of them are told the watch is set up, and then nothing ever
-- arrives. They do not conclude that notifications are off; they conclude the
-- product does not work.
--
-- So: an optional email address, and only that. Still no phone number, for the
-- reason 0013 gives -- an SMS watch is a standing per-message bill and a number
-- we would have to hold and secure for someone who never even booked.

-- Optional, and it stays optional.
--
-- Requiring an address to make a watch would cost more requests than the
-- silence does: the whole point of a watch with no account is that a stranger
-- can say "detailing near 91403" and be done. NULL is the normal, expected
-- state for anyone whose browser can push, and the matcher treats it as "this
-- customer has one channel, not two".
--
-- Storing an address here is consent to be emailed about THIS watch and
-- nothing else. It is not a mailing list, it is not a marketing record, and
-- there is no code path that reads this column for any purpose other than
-- sending the alert the customer asked for.
ALTER TABLE watches ADD COLUMN email TEXT;

-- When the customer proved the address is theirs.
--
-- Nothing sets this yet: there is no confirmation step, because an address
-- typed by the person sitting in front of the form is usually simply correct,
-- and a confirmation email that has to arrive before alerts can start is one
-- more place the whole thing quietly fails. The column exists so that adding
-- that step later is a matcher change and not a migration on a live table --
-- if it is added, the gate goes in matchWatches and reads this.
ALTER TABLE watches ADD COLUMN email_verified_at INTEGER;

-- How many times in a row the provider refused this address.
--
-- An address can be wrong: a typo, a work mailbox that has since closed, a
-- domain that no longer exists. Push has the same problem and solves it with
-- failed_count and disabled_at on push_subscriptions -- a dead endpoint is
-- stamped and skipped, because retrying it is one request per tick, forever,
-- that cannot succeed. An address that keeps bouncing is exactly that, with a
-- worse tail: sending to it every fifteen minutes is what gets a sending
-- domain treated as a spam source, which takes down the alerts of every
-- customer whose address does work.
--
-- There is no email_disabled_at to go with it on purpose. The counter reaching
-- its ceiling IS the disabled state, and unlike a timestamp it also says why
-- the address was dropped. A send that succeeds resets it to 0, so one bad
-- afternoon at a provider does not permanently retire a good address.
ALTER TABLE watches ADD COLUMN email_failed_count INTEGER NOT NULL DEFAULT 0;
