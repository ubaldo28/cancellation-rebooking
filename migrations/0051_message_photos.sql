-- A photograph inside the conversation.
--
-- WHAT WAS WRONG, AND WHAT IT COST.
--
-- Until this file there was exactly one way to attach a photograph to a piece
-- of work: job_photos, from 0025 — a staged before/during/after gallery hung
-- off an order_item, capped at six pictures, every one of them kept for ninety
-- days because it exists to settle an argument. That is the right table for
-- evidence and the wrong table for everything else, and everything else is
-- most of what a camera is actually used for on a job.
--
-- "Is this the tap you meant?" "It is the one by the back door, look."
-- "That is the wrong part, here is the label." "Here is where I left the key."
--
-- None of those had anywhere to go. lib/chat.ts had no attachment support of
-- any kind, so the only way to show somebody a picture mid-conversation was to
-- file it as before/during/after proof on a booking — which is wrong three
-- ways over. It puts a photograph of a tap into the six slots reserved for
-- evidence about whether the job happened; it needs a booking to exist, so the
-- most useful photograph of the lot — the one a stranger sends BEFORE they
-- book, showing what they actually want done — could not be sent at all; and
-- it holds a conversational aside under the retention rule written for a
-- dispute. The cost was not a missing feature. It was that the two sides went
-- back to describing things in words, and a plumber quoting a job from a
-- sentence quotes it wrong.
--
-- So: routine photographs belong in the conversation, the stored gallery
-- belongs to claims, and this is the conversation half.
--
-- ---------------------------------------------------------------------------
-- WHY A TABLE AND NOT FIVE COLUMNS ON chat_messages
-- ---------------------------------------------------------------------------
-- The obvious alternative is photo_key/content_type/bytes/width/height hung
-- off chat_messages, which costs no join and no second insert. It was not
-- taken, for three reasons, in order of how much they matter.
--
--   1. THE TWO THINGS DO NOT LIVE THE SAME LENGTH OF TIME. A photograph of the
--      inside of somebody's kitchen has a retention window measured against
--      what it is a picture of. The sentence "can you come Thursday" does not,
--      and the conversation is the record of what was agreed — it is the thing
--      an operator scrolls back through a year later to show what was asked
--      for. Columns on the message force one row to have one lifetime, so the
--      only ways to expire the picture are to delete the sentence with it or
--      to UPDATE the message row to blank the columns. Deleting the sentence
--      destroys the record; UPDATEing a conversation row to expire a
--      photograph is a write to the message body's row every time the sweep
--      runs, on the largest and most append-only table in this schema. A
--      separate row is simply DELETEd, and the message it hung off is
--      untouched.
--
--   2. THE SWEEP WOULD BE LOOKING FOR A NEEDLE. chat_messages is where this
--      product's row count actually grows: every question, every answer, every
--      "on my way", for every booking, forever. The overwhelming majority of
--      those rows will never have a photograph on them. A retention sweep over
--      photographs would then be a query over the conversation table filtered
--      on a column that is null nearly everywhere, which needs an index that
--      exists only to describe the exceptions. A table whose every row IS an
--      exception needs no such thing, and the sweep reads only rows it is
--      actually interested in.
--
--   3. THE PAYLOAD SHAPE STAYS HONEST. The thread payload gives every message
--      `photo: {...} | null`. With a separate row that is a LEFT JOIN and the
--      null case is the absence of a row, which is what it means. With columns
--      it is five nullable fields that have to be null or non-null together
--      and nothing in the schema says so — one bad INSERT and there is a
--      message with a width and no key.
--
-- ---------------------------------------------------------------------------
-- THERE ARE NO FOREIGN KEYS ON THIS TABLE, AND THAT IS THE CAREFUL PART
-- ---------------------------------------------------------------------------
-- message_id, thread_id and operator_id all name rows in tables that exist,
-- and none of them is declared REFERENCES. That looks like an oversight and is
-- the opposite of one.
--
-- The natural spelling is `message_id REFERENCES chat_messages(id) ON DELETE
-- CASCADE`, so that deleting a message takes its photograph's row with it.
-- Follow that through. chat_messages already cascades off threads (0011), and
-- lib/retention.ts deletes from threads in five separate places — the stale
-- thread sweep, the per-booking erasure, the by-token erasure, the by-phone
-- erasure and operator account closure. Every one of those was written before
-- this table existed. With a cascade, each of them would silently delete the
-- row holding photo_key, which is THE ONLY RECORD OF WHERE THE PHOTOGRAPH IS.
-- The bytes would stay in the photo store — a Workers KV namespace with 1 GB
-- for the entire account (see src/lib/photostore.ts) — with nothing left in
-- the database able to name them, forever, and the delete would report
-- success. That is precisely the failure sweepJobPhotos in lib/retention.ts
-- guards against by hand and says so at length: a key with no row cannot be
-- found by the next tick, so the row must outlive the thing that points at it
-- until the bytes are gone.
--
-- The other spelling, REFERENCES with no cascade, is worse still: with
-- PRAGMA foreign_keys ON, the cascade from threads to chat_messages would hit
-- a live child row here and the whole DELETE would fail. Erasure — the path
-- that has to work because somebody has asked us in law to delete their data —
-- would start failing on any conversation that ever had a photograph in it.
--
-- So the columns are plain TEXT and the ordering is a rule the code keeps
-- rather than one the schema enforces: bytes first, row second, always. This
-- is the same choice job_photos made in 0025 for the same reason, and it is
-- why that table has no foreign keys either.
--
-- The obligation this hands to whoever maintains lib/retention.ts is written
-- out with the indexes below: rows here can outlive their thread, and
-- something has to go looking for them.
CREATE TABLE message_photos (
  id             TEXT PRIMARY KEY,

  -- The message this photograph IS. One picture per message, enforced by the
  -- unique index below rather than by convention: "one per message" is the
  -- contract the browser is built against, and a second row for the same
  -- message would mean the thread payload silently picking one of two.
  --
  -- Note what this is not: there is no `caption` column. The caption of a
  -- photograph in a conversation is the message it was sent with, in
  -- chat_messages.body, where it goes through the same contact-detail filter
  -- every other sentence goes through. A second free-text field beside it
  -- would be one more box a stranger types into and the other side reads, and
  -- the filter would have to be remembered for it separately — which is how
  -- threads.guest_name ended up being the one place a phone number could be
  -- handed over in plain sight, until startThread in lib/chat.ts was changed
  -- to run the name through redactContact like everything else.
  message_id     TEXT NOT NULL,

  -- Denormalised off the message, so every authorisation check and the
  -- per-thread ceiling lead with the thread rather than joining back through
  -- chat_messages to find it. It is also what makes an orphan findable after
  -- the thread is gone — see the note on foreign keys above.
  thread_id      TEXT NOT NULL,

  -- The tenant boundary, denormalised for the same reason job_photos
  -- denormalises it: no query about a photograph should have to join two
  -- tables to discover which business it belongs to. It is also the key that
  -- account closure sweeps on.
  operator_id    TEXT NOT NULL,

  -- The booking this conversation was about WHEN THE PHOTOGRAPH WAS SENT, or
  -- NULL if there was not one yet.
  --
  -- Resolved at upload from the thread's appointment, and backfilled once —
  -- and only once — when a conversation that started before the booking gets
  -- one attached (attachBooking in lib/chat.ts). Both halves matter.
  --
  -- Recording it at upload rather than reading threads.appointment_id at sweep
  -- time is what makes it stable. A thread is not retired when a job finishes:
  -- a returning customer messages the same business on the same link, and
  -- attachBooking re-points threads.appointment_id at the new job. Anything
  -- that asked the thread "which booking is this?" in six months' time would
  -- get the LATEST answer and quietly attribute last spring's photographs to
  -- this autumn's job. This column is the answer as it was on the day.
  --
  -- Backfilling the NULLs once is the other half, and it is the case that
  -- actually matters: the photograph of the broken tap is sent BEFORE the
  -- booking exists, and it is the single most useful picture on the job. Left
  -- NULL it would look like an idle enquiry photo with no job behind it, and a
  -- retention sweep that keeps photographs longer while a booking is disputed
  -- would age out the one picture the dispute is about. The backfill only ever
  -- fills a NULL, so a photograph already attributed to an earlier job keeps
  -- that job.
  order_item_id  TEXT,

  -- Where the bytes are: the key of this picture in the photo store.
  --
  -- NOT called r2_key, which is the name the same column carries in job_photos
  -- (0025) and work_photos (0008). Those two are stuck with it: the photo
  -- store has been a Workers KV namespace and never an R2 bucket in
  -- production, so the name has been wrong since it was written, and the top
  -- of src/lib/photostore.ts sets out at length why renaming a NOT NULL column
  -- read by name in six modules and in a JSON payload the shipped web app
  -- already consumes is not a trade worth taking on a live deployment.
  --
  -- None of that applies to a table being created here for the first time.
  -- There is no migration to write, no query to rewrite and no client to
  -- break, so the cost of the honest name is zero and the cost of the wrong
  -- one is that a reader six months from now goes looking for a bucket that
  -- has never existed. A new table is the only chance to stop spreading it.
  photo_key      TEXT NOT NULL,

  -- The SNIFFED type from cleanImageUpload, never the one the uploader
  -- declared. A file announced as image/jpeg that is really HTML has to be
  -- stored and served as what its bytes are, or the first time it is served
  -- back a browser executes it. The same value is also written into the photo
  -- store's KV metadata by putPhoto; this copy is the one the serve route
  -- reads, because that route already holds the row.
  content_type   TEXT,

  -- The size of what was STORED, which is smaller than what arrived: the EXIF
  -- strip runs first. Written so the one number that actually constrains this
  -- product can be asked as a question — SUM(bytes) is how much of the
  -- account's single shared gigabyte the conversations are using, and that
  -- gigabyte is the hardest limit in the system.
  bytes          INTEGER,

  -- What the sender's browser measured before it uploaded, so the conversation
  -- can reserve the right shaped box and not reflow when the image lands.
  -- Nullable because they are the client's word for it and a caller that is
  -- not the app sends neither; the payload reports 0 for an unknown one rather
  -- than null, so the browser has one thing to check instead of two.
  width          INTEGER,
  height         INTEGER,

  created_at     INTEGER NOT NULL
);

-- ONE PHOTOGRAPH PER MESSAGE, in the schema and not in a comment.
--
-- The thread payload gives each message a single `photo` or null. If two rows
-- could name one message the payload would show whichever the join happened
-- to return first, which is the kind of bug that is invisible until the day
-- somebody notices the wrong picture in their own conversation. It is also the
-- index the payload's LEFT JOIN runs on, so making the rule true costs
-- nothing that was not already being paid.
CREATE UNIQUE INDEX idx_message_photos_message ON message_photos (message_id);

-- (a) Every photograph on one thread, oldest first.
--
-- Three readers. The per-thread rolling ceiling in lib/chat.ts counts rows in
-- this shape (thread_id pinned, created_at as a range, which is the order that
-- lets SQLite seek instead of scan); erasing one conversation deletes in it;
-- and the sweep that has to find rows whose thread is already gone groups by
-- it.
CREATE INDEX idx_message_photos_thread ON message_photos (thread_id, created_at);

-- (b) Every photograph on one booking, which is also (c) the way to ask
-- whether that booking is under a claim.
--
-- The claim itself is not recorded here and must not be: a no_show_reports
-- row, a bypass_flag and a held settlement are three different facts about the
-- BOOKING, they change after the photograph was taken, and a copy of any of
-- them on this row would be a stale answer to a question the source table
-- already answers. What this index buys is that the join to go and ask is one
-- seek rather than a scan — order_item_id pinned, created_at trailing so an
-- age-bounded sweep on one booking still falls on it.
CREATE INDEX idx_message_photos_item ON message_photos (order_item_id, created_at);

-- The age sweep, which is the one that keeps uploads working at all.
--
-- Neither index above can serve `WHERE created_at < ? LIMIT n`: both lead with
-- a column such a query does not name, and a leading column a query cannot pin
-- is an index it cannot use. This is the shape sweepJobPhotos already uses
-- against job_photos, and it is not housekeeping — the photo store is 1 GB for
-- the whole account, so the sweep is what stops the next upload failing.
CREATE INDEX idx_message_photos_age ON message_photos (created_at);

-- Account closure, and nothing else.
--
-- Deleting an operator deletes their threads, and with no cascade on this
-- table (see above) that would leave every photograph ever sent to them with a
-- row whose thread_id names nothing. The erasure path has to collect the keys
-- BEFORE the threads go, which means asking for them by operator, and erasure
-- is the one path that must never be the thing that times out — somebody has
-- asked in law to be deleted and a half-finished deletion is worse than either
-- outcome. No created_at on it: the only caller wants all of them.
CREATE INDEX idx_message_photos_operator ON message_photos (operator_id);
