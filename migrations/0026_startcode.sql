-- The start code, and the van it arrives in.
--
-- Two things every delivery and ride app settled on years ago, for the same
-- two reasons: the customer needs to know the person on their driveway is the
-- person the app sent, and the platform needs one moment it can actually
-- prove.
--
-- 1. THE CODE. Four digits, shown only to the customer, read out to the
--    operator, typed in to start the job. It is not security -- four digits
--    guessed against a live booking is not a threat model worth designing
--    around -- it is EVIDENCE. A code can only be entered by somebody standing
--    next to the person holding it. That makes it the one moment in the whole
--    flow where the platform knows, rather than infers, that these two people
--    met.
--
--    Which makes cancelling AFTER entering it close to conclusive. "I arrived
--    and left" is a story that survives a tapped button; it does not survive
--    having read a code off the customer's phone first.
--
-- 2. THE VAN. Make, model, colour, plate, shown to the customer before anyone
--    turns up. Mostly this is safety: somebody is being asked to open their
--    door to a stranger, and "a white Transit, plate ending 4RTY" is the
--    difference between opening it and not. It is also identity -- an operator
--    who sends somebody else entirely is a different problem from a bypass,
--    and one nobody would otherwise notice.

-- ---------------------------------------------------------------------------
-- 1. The code
-- ---------------------------------------------------------------------------
-- Stored as typed rather than hashed, deliberately, and it is worth saying why
-- since every other secret in this codebase is hashed. The customer has to be
-- able to READ this one off their screen, so a one-way hash cannot work: there
-- would be nothing to show them. The exposure is one four-digit number tied to
-- one appointment, useless the moment the job starts and useless to anybody
-- not standing at that address on that afternoon. The offer tokens and session
-- secrets stay hashed because they are bearer authority over a whole
-- conversation; this is not that.
ALTER TABLE order_items ADD COLUMN start_code TEXT;

-- When the operator typed it correctly. THIS is the arrival record that
-- matters: arrived_at is one person's tap, and this is two people in the same
-- place at the same time.
ALTER TABLE order_items ADD COLUMN code_verified_at INTEGER;

-- Wrong guesses. A live booking's code is four digits and somebody who has the
-- job in front of them will get it in one; a run of failures is either the
-- wrong booking open or somebody trying numbers, and both are worth stopping.
ALTER TABLE order_items ADD COLUMN code_attempts INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 2. The van
-- ---------------------------------------------------------------------------
-- On the operator rather than on the booking: a solo mobile trade has one van,
-- and asking them to restate it per job is a form nobody fills in. If a
-- business ever runs two, this becomes a table and the booking points at a
-- row; there is no reason to build that before anybody needs it.
--
-- All optional at the database level even though the app asks for them,
-- because an operator who has not filled this in yet must be able to exist --
-- the listing gate is where the requirement is enforced, not here, where it
-- would break every account that already exists.
ALTER TABLE operators ADD COLUMN vehicle_make TEXT;
ALTER TABLE operators ADD COLUMN vehicle_model TEXT;
ALTER TABLE operators ADD COLUMN vehicle_color TEXT;

-- Kept as typed. It is shown to a customer to check against their own eyes,
-- never matched programmatically, so normalising it would only introduce a
-- way for the stored version to stop matching the plate on the van.
ALTER TABLE operators ADD COLUMN vehicle_plate TEXT;

-- ---------------------------------------------------------------------------
-- 3. The customer says the van was wrong
-- ---------------------------------------------------------------------------
-- Its own column rather than a flag row, because unlike everything in
-- bypass_flags this is not an inference the platform drew -- it is a person
-- reporting what they saw, and it belongs with the booking it happened on.
--
-- A mismatch is not automatically anything. Vans break and people borrow one;
-- the honest version of this is common. What it does is put the booking in
-- front of a person, and give a customer who is uneasy something to do other
-- than let a stranger they cannot identify into their house.
ALTER TABLE order_items ADD COLUMN vehicle_reported_at INTEGER;
ALTER TABLE order_items ADD COLUMN vehicle_reported_note TEXT;
