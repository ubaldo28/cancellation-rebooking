-- What a customer gets back, and when.
--
-- The rule was all-or-nothing: free more than 48 hours out, nothing inside it.
-- That charged somebody cancelling 47 hours ahead exactly what it charged
-- somebody cancelling an hour ahead, and those are not the same act. At 47
-- hours the operator has not left the house and the slot can usually be
-- resold; at one hour their afternoon is gone either way.
--
-- So it graduates:
--
--   more than 48 hours out ....... refunded in full
--   12 to 48 hours out ........... three quarters back
--   inside 12 hours .............. a quarter back
--   did not show up at all ....... nothing back
--
-- plus a short grace window for the obvious mistake -- wrong day, wrong
-- address, wrong service -- which is spotted within minutes of booking and
-- costs the operator nothing at all.
--
-- THE GRACE WINDOW HAS A FLOOR, and it is the part worth reading. Thirty
-- minutes of grace on an appointment starting in forty-five is not grace, it
-- is a free cancellation on a job the operator is already driving to. So it
-- only applies while the appointment is still at least three hours away, and
-- it dies the moment the operator marks that they have arrived. Somebody
-- booking a slot that starts in an hour is asking a person to drop what they
-- are doing and drive; that booking is theirs from the moment they make it.

-- What was actually given back, in money, decided at cancellation time.
--
-- Stored rather than recomputed. The tiers will be tuned -- they are a policy,
-- not a law -- and a receipt that recalculates itself against today's rules
-- would quietly restate what somebody was refunded last March. This is the
-- record of what happened.
ALTER TABLE order_items ADD COLUMN refund_cents INTEGER;

-- Which rule produced that number, so support can answer "why did I only get
-- half back" without reconstructing the arithmetic from timestamps.
ALTER TABLE order_items ADD COLUMN refund_reason TEXT
  CHECK (refund_reason IN ('full','grace','most','some','none','operator_cancelled',NULL));
