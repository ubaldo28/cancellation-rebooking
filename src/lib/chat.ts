import type { Env } from '../types';
import { hashOfferToken } from './auth';
import { FEED_EXCERPT_CHARS, notify } from './feed';
import { WEB_IMAGE_TYPES, cleanImageUpload } from './images';
import { getPhoto, putPhoto } from './photostore';
import { RateLimitedError } from './ratelimit';
import { firstNameOnly, redactContact, redactionMessage } from './redact';
import { badRequest, conflict, newId, newToken, notFound, now } from './util';

/**
 * In-app messages between a customer and a business.
 *
 * The requirement is "no number exchange, no sms": the two sides talk here or
 * not at all. A guest's identity here is the secret in the link they were
 * given, so everything a guest does is authorised by that token and nothing
 * else, and everything an operator does is scoped by operator_id in the WHERE
 * clause, the same as everywhere else in this codebase.
 *
 * CUSTOMERS DO HAVE ACCOUNTS SINCE MIGRATION 0037, and nothing in this file
 * asks for one. That is deliberate rather than an oversight, and it is the
 * point of /c/:token: the link opens the conversation on a phone that has
 * never been signed in, which is how somebody reads a message from the
 * business while standing in their own driveway. Booking needs an account;
 * reading and answering a booking you already have does not, and putting a
 * sign-in in front of this would take the product's one genuinely
 * frictionless surface away for nothing.
 */

/** One conversation. */
export interface Thread {
  id: string;
  operator_id: string;
  /** The opening being asked about, before any booking exists. */
  gap_id: string | null;
  appointment_id: string | null;
  client_id: string | null;
  /**
   * The customer account this conversation belongs to, when one is known.
   *
   * NULL IS AN ORDINARY ANSWER AND ALWAYS WILL BE. A stranger who messages a
   * business from its profile page without signing in has no account for this
   * to name, and nothing later can work out which account they meant -- see
   * migration 0052. Those conversations stay reachable on their link and only
   * on their link, which is what the link is for.
   *
   * NOT AN AUTHORITY BY ITSELF. It is compared against an account id that came
   * out of a session cookie, never against anything in a URL or a body. See
   * threadForCustomer below, which is the only place that comparison is made.
   */
  customer_account_id: string | null;
  guest_name: string;
  subject: string | null;
  last_message_at: number;
  operator_unread: number;
  guest_unread: number;
  /** How many messages here have had a contact detail stripped out. */
  redacted_count: number;
  status: 'open' | 'closed';
  created_at: number;
  updated_at: number;
}

/**
 * How a caller names the conversation they are talking about.
 *
 * THE WHOLE OF THE SECOND DOOR IS IN THIS TYPE, so it is worth the paragraphs.
 *
 * Every guest-side function in this codebase used to take `rawToken: string`
 * and resolve it with threadByToken. That is twenty-odd functions across ten
 * files -- the messages, the photographs, the estimates, the parts quotes, the
 * start code, the van, the refund, the cancellation, the review, the erasure
 * -- and every one of them means "the conversation the holder of this secret
 * is allowed to act on".
 *
 * Adding a second way in therefore had three possible shapes, and two of them
 * are bad:
 *
 *   A SECOND SET OF ROUTES under /api/customer/threads/:id, one per endpoint.
 *   That is twenty-odd twins of routes that handle money, cancellations and
 *   erasure, each of which then has to be kept in step with its twin for ever.
 *   The first one to drift is a hole, and it drifts silently.
 *
 *   A MAGIC STRING -- a token-shaped value the router hands over meaning
 *   "already authorised", say `id:<thread>`. That is an authority bypass
 *   waiting to happen: the values these functions receive come out of a URL,
 *   so the moment a caller can spell the magic prefix themselves the ownership
 *   check is gone. It was considered and rejected outright.
 *
 *   THIS: a union of "a secret to resolve" and "a conversation already
 *   resolved and already authorised". A string can only ever be the first --
 *   URL segments are strings, so a request cannot forge the second even in
 *   principle -- and the only code that constructs the second is the router,
 *   after guardGuestLink has proved the signed-in customer owns that thread.
 *
 * What it buys is that the token door did not change at all. Hand any of these
 * functions a string and they do exactly what they did before, byte for byte,
 * including the lookup and the wording of the refusal.
 */
export type ThreadRef = string | Thread;

/**
 * A photograph hanging off one message, as the thread payload reports it.
 *
 * THREE FIELDS AND DELIBERATELY NOT FOUR. There is no URL in here and there
 * must never be one: the bytes are fetched from a route that authorises the
 * caller on every single read (readMessagePhoto below), so what the payload
 * hands over is an id the browser turns into a request, not a link anybody
 * else could follow. The moment this carried a signed or guessable URL, a
 * screenshot of a chat window or a referrer header would be a permanent
 * public link to the inside of somebody's house.
 *
 * width and height are NUMBERS and never null, which is a small lie the
 * database does not tell: the columns are nullable because they are the
 * sending browser's word for the picture's size and a caller that is not our
 * app sends neither. Zero is reported for an unknown one. The browser then
 * has one case to handle — "0 means I do not know, do not reserve a box" —
 * instead of two spellings of the same ignorance.
 */
export interface MessagePhotoRef {
  id: string;
  width: number;
  height: number;
}

/** One message in a conversation. Never an SMS -- see migration 0011. */
export interface ChatMessage {
  id: string;
  thread_id: string;
  sender: 'guest' | 'operator';
  body: string;
  created_at: number;
  /** 1 when a contact detail was stripped out of this message. See redact.ts. */
  redacted?: number;
  /**
   * The photograph sent with this message, if there was one.
   *
   * Present on EVERY message and null on most of them, rather than being
   * absent from the ones without a picture. An optional key is two states the
   * browser has to tell apart — "there is no photo" and "this payload is from
   * a version that did not know about photos" — and it would have had to tell
   * them apart at exactly the moment the feature shipped, against a Worker and
   * a bundle that deploy separately. One explicit null is one state.
   */
  photo: MessagePhotoRef | null;
  /**
   * Shown to the SENDER only, on the response to their own post, and never
   * stored. The other side must not be told "they tried to send you a phone
   * number" -- that is an accusation the platform cannot support from a regex,
   * and it would poison a conversation over somebody signing off with their
   * number out of habit.
   */
  notice?: string | null;
}

export interface StartThreadInput {
  operator_id: string;
  gap_id?: string | null;
  appointment_id?: string | null;
  client_id?: string | null;
  /**
   * The account of whoever is opening this, when we actually know it.
   *
   * Set from the order's own account when a booking mints the thread, and from
   * the session when a signed-in customer opens an enquiry from a profile page.
   * Left null the rest of the time, which is most enquiries -- see the note on
   * Thread.customer_account_id for why null stays an ordinary answer and why
   * nothing tries to work it out afterwards.
   */
  customer_account_id?: string | null;
  guest_name: string;
  subject?: string | null;
  first_message?: string;
}

/**
 * The hash used for a guest link.
 *
 * Same pepper-and-sha256 helper the offer links and sessions use, imported
 * rather than re-derived: two hashing schemes for the same class of secret is
 * how one of them ends up being the weak one.
 */
const hashGuestToken = hashOfferToken;

/** Long enough that guessing one is not a strategy. Chat links are bearer authority. */
const guestToken = () => newToken();

/** A message longer than this is a document, and D1 rows are not the place for one. */
export const MAX_MESSAGE_CHARS = 2000;

/** Names are typed by strangers into a public form; this is a sanity bound, not a rule. */
const MAX_NAME_CHARS = 80;
const MAX_SUBJECT_CHARS = 140;

/**
 * The guest rate limit: at most 20 messages from one thread in five minutes.
 *
 * The guest endpoint asks for no sign-in -- a token is enough to post -- so
 * without this it is a free relay for anyone who scrapes one link. The limit
 * is per thread rather than per IP because the token is the only identity this
 * endpoint has: a customer with an account is not required to be signed in
 * here and usually will not be.
 */
const GUEST_WINDOW_SECONDS = 300;
const GUEST_MAX_IN_WINDOW = 20;

/**
 * The size cap on a photograph sent in a conversation: 2 MB.
 *
 * The same number MAX_BYTES in ./proof.ts uses, written out here rather than
 * imported, and that is a deliberate duplication of a constant. proof.ts
 * imports threadByToken from this file, so importing MAX_BYTES back from
 * proof.ts would close a cycle between two modules that have no business
 * knowing about each other — a conversation does not depend on the proof
 * gallery and must not start to.
 *
 * What the two numbers actually have in common is not the feature, it is the
 * budget: both doors spend the SAME 1 GB of Workers KV, which is the whole
 * account's standing allowance and cannot be topped up. See the top of
 * ./photostore.ts. If that budget is ever re-cut, both of these move together
 * and neither is free to drift on its own.
 *
 * Two megabytes is around six times what a photograph taken on a phone and
 * shrunk by the app before sending actually weighs, so nobody using the
 * product notices it. What it really bounds is a caller that is NOT the app.
 */
export const MAX_MESSAGE_PHOTO_BYTES = 2_000_000;

/**
 * Photographs one conversation may carry in a day, counted across both sides.
 *
 * ROLLING, NOT A TOTAL, AND THAT IS THE WHOLE DESIGN. proof.ts caps a booking
 * at six photographs for its whole life, which is right there: the gallery is
 * a fixed set of evidence about one job, and "before, during and after, from
 * each side" is a shape rather than a number. A conversation has no such
 * shape. It is open-ended by construction — the same customer messages the
 * same business about a new job a year later on the same link — so a lifetime
 * total would eventually answer a repeat customer of three years with "this
 * conversation already has plenty of photos", which is an absurd thing to say
 * to somebody trying to show a plumber a leak.
 *
 * A window bounds the burst, which is the thing actually worth bounding, and
 * forgets about it afterwards. Twenty a day is far past documenting one job
 * from several angles and far short of anything that would matter to the
 * store: at the 2 MB ceiling above it is 40 MB a day from the busiest possible
 * single conversation, against a shared gigabyte.
 *
 * It counts BOTH sides together on purpose. This is not an anti-spam measure
 * against the guest — the rate limits on the routes are that — it is the hard
 * per-record ceiling that ./photostore.ts names as the thing which actually
 * bounds the account's 1,000 writes a day, and a write costs the same whoever
 * made it.
 */
const PHOTO_WINDOW_SECONDS = 24 * 60 * 60;
const PHOTO_MAX_IN_WINDOW = 20;

/**
 * What a conversation photograph is allowed to be, and why it is a shorter
 * list than the proof gallery's.
 *
 * proof.ts accepts CAMERA_IMAGE_TYPES, which includes HEIC, and gives the
 * reason: a job photo is evidence, an iPhone writes HEIC unless somebody
 * changed a setting, and refusing the evidence is worse than storing a format
 * some browsers will not draw.
 *
 * A conversation photograph is not evidence, it is a sentence. The only thing
 * it is for is being LOOKED AT by the other person, immediately, inline, in
 * whatever browser they happen to be holding — and no desktop Chrome or
 * Firefox will render a HEIC. Accepting one would mean the sender gets a
 * cheerful 201, believes they have shown somebody the broken tap, and the
 * other side sees a grey box with a torn-page icon on it. Neither of them
 * would ever find out why.
 *
 * That is the exact failure this whole feature exists to prevent, written
 * about postMessage below: a message that silently does not arrive. So the
 * list is the three formats every browser draws, and an upload that is not one
 * of them is refused at the door where the sender can still see the refusal
 * and do something about it. The app shrinks and re-encodes before sending —
 * the same thing JobProof.tsx does — so this only ever bites a caller that
 * bypassed it.
 */
const PHOTO_TYPES = WEB_IMAGE_TYPES;

const DEFAULT_MESSAGE_LIMIT = 200;
const MAX_MESSAGE_LIMIT = 500;

/**
 * How many conversations one page of a list holds, and why both numbers came
 * down rather than up.
 *
 * WHAT WAS WRONG. Both lists were written for a handful of rows and had no
 * pagination of any kind: the operator's inbox and the customer's list each
 * took a `limit`, defaulted it to fifty, capped it at two hundred, and then
 * there was simply no way to see row 201. That is not a slow list, it is a
 * list with a silent lid on it — a business with three hundred conversations
 * had a hundred of them permanently unreachable from the only screen where a
 * customer's question can be answered, and nothing on the page said so. The
 * one after the lid is the oldest, which on this ordering means the one that
 * has been waiting longest.
 *
 * Twenty-five rather than fifty, because a page is now a page: there is a
 * cursor to ask for the next one, the operator's inbox re-reads itself every
 * fifteen seconds while it is open (Messages.tsx), and fifty rows joined to
 * operators and appointments on every poll is bytes spent on rows nobody has
 * scrolled to. A hundred rather than two hundred for the ceiling, for the same
 * reason: this is what a caller may ask for at once, not what they may see in
 * total, and the total is now unbounded because the cursor is.
 */
const DEFAULT_THREAD_LIMIT = 25;
const MAX_THREAD_LIMIT = 100;

/** The free-text box is a filter, not a document search. Bounded at the door. */
const MAX_SEARCH_CHARS = 80;

const THREAD_FIELDS =
  `id, operator_id, gap_id, appointment_id, client_id, customer_account_id,
   guest_name, subject, last_message_at, operator_unread, guest_unread,
   redacted_count, status, created_at, updated_at`;

/**
 * The same field list, prefixed for a query that joins.
 *
 * Written as a function rather than as a second hand-typed list, because the
 * two would drift the moment a column is added -- and the way they drift is
 * that one query returns a Thread and the other returns a Thread with a field
 * missing, which TypeScript cannot see because both are cast at the boundary.
 * `guest_token_hash` is absent from THREAD_FIELDS on purpose and stays absent
 * here: no query in this file has any business selecting it.
 */
const qualified = (alias: string) =>
  THREAD_FIELDS.split(',').map((f) => `${alias}.${f.trim()}`).join(', ');

// ---------------------------------------------------------------------------
// Paging a conversation list
// ---------------------------------------------------------------------------
//
// The owner's description of the problem this section exists for: "business
// will have more messages by customers asking questions. but also customers
// will be messaging multiple [businesses]. so we need to figure this out."
//
// Neither list could answer it. Both took a limit, capped it, and stopped --
// see the note on DEFAULT_THREAD_LIMIT above for what that silently did to row
// 201. So both lists now hand back a cursor, and both sort the same way.
//
// THERE WAS NO EXISTING CURSOR CONVENTION IN THIS CODEBASE TO MATCH. Every
// other list route here is `?limit=` and a filter or two and a hard ceiling --
// GET /api/clients, GET /api/notifications, GET /api/admin/audit -- because
// every one of them is bounded by something real: an operator's own client
// list, their own notifications, the admin log. A conversation list is the
// first one on this site that genuinely is not bounded, so this is the first
// cursor, and it is written to be the shape the next one copies.
//
// KEYSET AND NOT OFFSET, which matters more here than it usually does. An
// OFFSET page is read by counting rows and throwing them away, so page five
// costs five pages of work; worse, these lists MOVE while they are being read
// -- a message arriving bumps last_message_at, which is the sort key -- so
// with OFFSET a conversation that jumped to the top while somebody was on page
// two would push a different one across the boundary and that one would never
// be seen at all. A keyset cursor names the row the last page ended on, so the
// next page starts where the last one stopped whatever has happened in
// between, and the rows that moved to the top are simply found again by
// reloading.

/**
 * Where a page stopped, as the caller carries it.
 *
 * THREE PARTS AND ALL THREE ARE LOAD-BEARING.
 *
 * `waiting` is which of the two ordering segments the row was in -- see
 * pageOfThreads for why the list is read in two -- and without it a cursor
 * cannot say whether the next page continues among the unanswered ones or has
 * already moved past them into the answered ones.
 *
 * `at` is last_message_at, which is the sort key.
 *
 * `id` is the tie-break, and it is not decoration. last_message_at has
 * one-second resolution, and two conversations can easily land on the same
 * second -- an operator sending the same answer to two people, a batch that
 * writes into two threads at once. Without a second key the page boundary
 * between two rows sharing a second is arbitrary: one of them is returned
 * twice and the other is never returned at all. The ORDER BY carries the same
 * tie-break, so the two agree.
 */
interface ThreadCursor {
  waiting: boolean;
  at: number;
  id: string;
}

/**
 * The cursor, as one opaque-looking string.
 *
 * Dot-separated rather than base64 or JSON, deliberately. It travels in a
 * query string, so it has to survive a URL; ids here are UUIDs from newId()
 * and contain no dot, so the split is unambiguous; and a reader debugging a
 * paging complaint can see what the value means without decoding it. It is not
 * a secret and is not authority: every field in it is compared inside a query
 * that is ALREADY scoped to one operator or one account, so the worst a forged
 * cursor can do to its sender is skip or repeat some of their own rows.
 */
function encodeThreadCursor(c: ThreadCursor): string {
  return `${c.waiting ? 1 : 0}.${c.at}.${c.id}`;
}

/**
 * The same, read back, and null for anything that is not one.
 *
 * NULL RATHER THAN A REFUSAL, on purpose. A cursor reaches this from a URL
 * somebody may have edited, truncated in an email or kept from a previous
 * version of the payload, and the honest answer to a value that means nothing
 * is "start at the beginning" -- which is what a list does with a null cursor.
 * Throwing would turn a stale bookmark into an error page over a list the
 * reader can see perfectly well by pressing reload.
 */
function decodeThreadCursor(raw: string | null | undefined): ThreadCursor | null {
  const parts = (raw ?? '').split('.');
  if (parts.length !== 3) return null;
  const [seg, at, id] = parts as [string, string, string];
  if (seg !== '0' && seg !== '1') return null;
  const n = Number(at);
  if (!Number.isFinite(n) || !id) return null;
  return { waiting: seg === '1', at: Math.trunc(n), id };
}

/** One page of a conversation list, and where the next one starts. */
export interface ThreadPage<T> {
  threads: T[];
  /**
   * The cursor for the page after this one, or null when this was the last.
   *
   * NULL IS THE END AND IS THE ONLY SIGNAL OF IT. There is no total count
   * beside it and deliberately not: a count over a filtered, searched,
   * two-segment list is a second query on every poll to print a number nobody
   * acts on, and it is wrong by the time it is drawn because these lists move.
   * "There is more" is what a list needs to know, and a cursor already says it.
   */
  next_cursor: string | null;
}

/** What either side may narrow a conversation list by. */
export interface ThreadListOptions {
  /** Only the conversations with something unread for the side that is asking. */
  unreadOnly?: boolean;
  /**
   * Which statuses to include.
   *
   * The two sides default differently and that is the whole point of the
   * option -- see the notes on listThreads and listThreadsForCustomer.
   */
  status?: 'open' | 'closed' | 'all';
  /**
   * Free text: the other side's name, the subject, and what was said.
   *
   * `null` is allowed as well as absent, because that is what
   * URLSearchParams.get hands back for a parameter nobody sent and there is no
   * reason to make every route convert it. searchPattern reads both as "no
   * text filter", along with a blank string — a search box the reader has
   * emptied means the same thing as one they never typed in.
   */
  q?: string | null;
  limit?: number;
  cursor?: string | null;
}

/**
 * The search term, ready to go into a LIKE.
 *
 * Returns null for nothing to search, which every query below reads as "no
 * text filter" through a `? IS NULL OR` guard -- the same shape GET
 * /api/clients already uses for its own name search.
 *
 * THE WILDCARDS ARE ESCAPED, which /api/clients does not do and should. `%`
 * and `_` are LIKE metacharacters, so a customer called "Jo_" or a business
 * with a % in its name searched for the wrong thing entirely, and somebody
 * typing a bare `%` into the box got every row back. Escaping them means the
 * box searches for the characters somebody typed, which is the only thing they
 * can have meant. The backslash is escaped first, or escaping the other two
 * would introduce backslashes this then treats as escapes of its own.
 *
 * Bounded at MAX_SEARCH_CHARS because this is a filter box on a list, and a
 * two-kilobyte LIKE pattern is not a search, it is a way to make the database
 * compare two kilobytes against every row in range.
 */
function searchPattern(raw: string | null | undefined): string | null {
  const q = (raw ?? '').trim().slice(0, MAX_SEARCH_CHARS);
  if (!q) return null;
  return `%${q.replace(/\\/g, '\\\\').replace(/[%_]/g, (m) => `\\${m}`)}%`;
}

/**
 * Reads one page out of a list that is ordered "waiting on this reader first".
 *
 * ---------------------------------------------------------------------------
 * WHY THE LIST IS READ IN TWO SEGMENTS RATHER THAN ONE SORTED QUERY
 * ---------------------------------------------------------------------------
 * Both lists used to be ordered by last_message_at alone, and with no paging
 * that was nearly harmless: everything an operator had was on the one screen.
 * With hundreds of conversations it is the failure the owner is describing. A
 * customer's unanswered question is at the top the moment it lands and then
 * sinks one place for every OTHER conversation that gets a message -- so the
 * question that has been waiting longest, which is the one that loses the job,
 * is the one furthest from the top and eventually on a page nobody opens. An
 * inbox ordered purely by recency is a log, not a work queue.
 *
 * So the ordering is: anything unread by the reader first, and inside each of
 * those two groups, most recent first. The obvious spelling of that is
 * `ORDER BY (operator_unread > 0) DESC, last_message_at DESC` in one query,
 * and it was not used because of what it costs: an expression in the leading
 * ORDER BY position cannot be satisfied by any index on this table, so SQLite
 * would read EVERY one of the operator's conversations and sort them in a temp
 * b-tree on every poll, which is precisely the scan this whole change is
 * supposed to remove. LIMIT does not help, because a sort has to see every row
 * before it knows which twenty-five are first.
 *
 * Read as two segments, each one is an index seek. `operator_unread > 0` is
 * spelled literally in the WHERE clause so it matches the predicate of the
 * partial index migration 0053 adds, and `operator_unread = 0` walks the
 * ordinary inbox index from the cursor and skips the handful of unread rows on
 * the way. The second read only happens when the first did not fill the page,
 * so an operator with unanswered questions pays for one query and an operator
 * who is up to date pays for one that returns nothing.
 *
 * `read` is given the segment, the cursor to start after and how many rows are
 * still wanted, and each caller supplies its own SQL because the two lists
 * select different things -- the customer's joins the business and the hour.
 * `waitingOf` answers which segment a row was in, so the cursor can be built
 * from the last row of the page without the caller restating the rule.
 *
 * A CURSOR BELONGS TO THE FILTERS IT WAS PRODUCED WITH, which is worth saying
 * because the one odd combination is silent rather than wrong. A cursor taken
 * from an unfiltered page and then sent back alongside `unreadOnly` names a
 * row in the answered segment, which that filter excludes -- so the answer is
 * an empty page and no next cursor, meaning "nothing more under this filter".
 * That is the honest reading and it costs a reload to get out of; it is also
 * unreachable from either screen, because both drop the cursor when a filter
 * changes. What must not happen instead is starting the unanswered segment
 * again from the top, which would repeat rows the reader has already seen.
 */
async function pageOfThreads<T>(
  env: Env,
  opts: ThreadListOptions,
  read: (
    segment: 'waiting' | 'read', after: ThreadCursor | null, want: number,
  ) => Promise<T[]>,
  waitingOf: (row: T) => boolean,
  idOf: (row: T) => string,
  atOf: (row: T) => number,
): Promise<ThreadPage<T>> {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? DEFAULT_THREAD_LIMIT)),
    MAX_THREAD_LIMIT);
  const after = decodeThreadCursor(opts.cursor);

  // One more row than the page holds, so "is there another page" is answered
  // by the read that was happening anyway rather than by a COUNT over the same
  // filters. The extra row is dropped before the page is returned.
  const want = limit + 1;

  const rows: T[] = [];

  // A cursor in the answered segment has already passed the unanswered ones,
  // so asking for them again would repeat rows the reader has seen. With no
  // cursor at all, the page starts at the top, which is the first segment.
  if (!after || after.waiting) {
    rows.push(...await read('waiting', after?.waiting ? after : null, want));
  }

  // The answered segment is skipped entirely when the caller asked for unread
  // only -- that filter IS the first segment, and reading the second would
  // contradict it.
  if (!opts.unreadOnly && rows.length < want) {
    rows.push(...await read(
      'read',
      // Only when the cursor was already in this segment. A cursor from the
      // unanswered segment says nothing about where the answered one starts,
      // and using its timestamp here would skip every answered conversation
      // more recent than the last unanswered one -- which is most of them.
      after && !after.waiting ? after : null,
      want - rows.length,
    ));
  }

  const threads = rows.slice(0, limit);
  const last = threads[threads.length - 1];
  return {
    threads,
    next_cursor: rows.length > limit && last
      ? encodeThreadCursor({ waiting: waitingOf(last), at: atOf(last), id: idOf(last) })
      : null,
  };
}

/**
 * The cursor comparison, as SQL, and the status and text filters with it.
 *
 * Written once and shared by both lists, because the one thing that must not
 * drift between them is the page boundary: two spellings of a keyset
 * comparison is two chances to write `<=` where `<` belongs, and that bug
 * repeats one conversation on every page for ever.
 *
 * `? IS NULL OR` guards rather than a string built out of branches, which is
 * the shape this codebase already uses for optional filters (GET /api/clients)
 * and which keeps the statement one statement -- D1 caches prepared statements
 * per SQL string, and a query assembled differently per filter combination is
 * a different string every time.
 */
const CURSOR_SQL = `
     AND (? IS NULL
          OR t.last_message_at < ?
          OR (t.last_message_at = ? AND t.id < ?))`;

/** Binds for CURSOR_SQL, in order. Four of them, three of which are the same. */
const cursorBinds = (c: ThreadCursor | null) =>
  [c ? c.at : null, c?.at ?? null, c?.at ?? null, c?.id ?? null];

/**
 * `AND` for the status filter. 'all' passes everything through.
 *
 * Two binds, both the same value, because `status = 'all'` is not a row
 * anybody has -- the CHECK constraint on the column only allows 'open' and
 * 'closed' -- so comparing the parameter to the literal is a safe way to spell
 * "no filter" without a second SQL string.
 */
const STATUS_SQL = `     AND (? = 'all' OR t.status = ?)`;
const statusBinds = (s: 'open' | 'closed' | 'all') => [s, s];

/**
 * A message, plus the photograph on it if there is one.
 *
 * Aliased to `m` and `p` because this is a join now. The photo columns are
 * pulled from message_photos rather than from chat_messages for the reasons
 * migration 0051 sets out at length; the short version is that the picture and
 * the sentence do not live the same length of time, so they do not live in the
 * same row.
 *
 * Only three of the photo table's columns are read here. The key, the content
 * type and the byte count are not the transcript's business: they belong to
 * the route that serves the bytes and to the sweep that deletes them, and a
 * payload that carried the photo-store key would be publishing the one string
 * that must never leave the server.
 */
const MESSAGE_FIELDS =
  `m.id, m.thread_id, m.sender, m.body, m.created_at, m.redacted,
   p.id AS photo_id, p.width AS photo_width, p.height AS photo_height`;

/** The message row as the join above returns it, before the photo is folded in. */
interface MessageRow {
  id: string;
  thread_id: string;
  sender: 'guest' | 'operator';
  body: string;
  created_at: number;
  redacted: number | null;
  photo_id: string | null;
  photo_width: number | null;
  photo_height: number | null;
}

/**
 * One joined row, as the rest of the product sees it.
 *
 * The null photo is spelled out here, in the one place that builds a message
 * out of a row, so that no caller anywhere has to remember to add it. See the
 * note on ChatMessage.photo for why absent and null are not the same thing.
 */
function toMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    thread_id: row.thread_id,
    sender: row.sender,
    body: row.body,
    created_at: row.created_at,
    redacted: row.redacted ?? 0,
    photo: row.photo_id
      // Zero, not null, for a dimension the sender's browser did not measure.
      // See MessagePhotoRef.
      ? { id: row.photo_id, width: row.photo_width ?? 0, height: row.photo_height ?? 0 }
      : null,
  };
}

/**
 * The one place a message body is checked.
 *
 * All four post paths go through it, so a guest and an operator cannot end up
 * with different ideas of what fits in the column.
 *
 * `allowEmpty` is for the one case where there is genuinely nothing to type: a
 * photograph sent on its own. "Type a message first" is the right refusal for
 * somebody who pressed send on an empty box and the wrong one for somebody who
 * has just attached a picture of the thing they are asking about — the picture
 * IS the message, and demanding a caption for it would be the app inventing a
 * requirement the person does not have. The length cap still applies either
 * way, because a caption is a message body and lands in the same column.
 */
function cleanBody(raw: string | null | undefined, allowEmpty = false): string {
  const body = (raw ?? '').trim();
  if (!body && !allowEmpty) throw badRequest('Type a message first.', 'empty_message');
  if (body.length > MAX_MESSAGE_CHARS) {
    throw badRequest(
      `That message is too long. Keep it under ${MAX_MESSAGE_CHARS} characters.`,
      'message_too_long',
    );
  }
  return body;
}

/** A closed thread still reads; it just stops taking new messages. */
function assertOpen(thread: Thread): void {
  if (thread.status !== 'open') {
    throw conflict('This conversation has been closed.', 'thread_closed');
  }
}

/**
 * Starts a conversation and returns the RAW guest token, once.
 *
 * Only the hash is stored, so this return value is the only time the token
 * exists in readable form. Put it in the customer's link here or it is gone --
 * there is no "resend my link" that does not amount to issuing a new one.
 */
export async function startThread(
  env: Env, input: StartThreadInput,
): Promise<{ thread: Thread; token: string }> {
  const operatorId = input.operator_id?.trim();
  if (!operatorId) throw badRequest('A conversation needs an operator.', 'no_operator');

  // The name and the subject go through the same filter the messages do.
  //
  // They did not, and that was the shortest way round the whole thing: the
  // name is shown to the operator verbatim at the top of the conversation, so
  // "Rosa 818 555 0199" was a phone number handed over in the one box nothing
  // was reading. Every field a stranger types and the other side reads has to
  // be filtered, not only the ones called "message".
  //
  // And only the first word of the name, for the reason firstNameOnly sets
  // out: this is the line the operator reads at the top of the conversation,
  // and a stranger who typed their full name into a box labelled "your name"
  // has handed over a surname nobody asked them for. Cut before the filter
  // runs, so the filter sees the string that is actually going to be stored.
  const guestName = redactContact(
    firstNameOnly(input.guest_name).slice(0, MAX_NAME_CHARS),
  ).body.trim();
  if (!guestName) throw badRequest('Tell them who you are first.', 'no_name');

  const subjectRaw = (input.subject ?? '').trim().slice(0, MAX_SUBJECT_CHARS);
  const subject = subjectRaw ? redactContact(subjectRaw).body.trim() || null : null;
  // The opening message goes through the same filter as every other one. It
  // is the single most likely place for a number -- "hi, it's Rosa, my mobile
  // is ..." is how people open a message to a stranger.
  const firstClean = input.first_message == null
    ? null : redactContact(cleanBody(input.first_message));
  const firstMessage = firstClean?.body ?? null;

  const raw = guestToken();
  const t = now();

  const thread: Thread = {
    id: newId(),
    operator_id: operatorId,
    gap_id: input.gap_id ?? null,
    appointment_id: input.appointment_id ?? null,
    client_id: input.client_id ?? null,
    customer_account_id: input.customer_account_id ?? null,
    guest_name: guestName,
    subject,
    last_message_at: t,
    // The operator is the side with something new to read, and only if the
    // customer actually said something when they opened the thread.
    operator_unread: firstMessage ? 1 : 0,
    guest_unread: 0,
    redacted_count: firstClean?.redacted ? 1 : 0,
    status: 'open',
    created_at: t,
    updated_at: t,
  };

  const statements = [
    env.DB.prepare(
      `INSERT INTO threads (id, operator_id, gap_id, appointment_id, client_id,
         customer_account_id, guest_name,
         guest_token_hash, subject, last_message_at, operator_unread, guest_unread,
         redacted_count, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(thread.id, thread.operator_id, thread.gap_id, thread.appointment_id,
      thread.client_id, thread.customer_account_id,
      thread.guest_name, await hashGuestToken(raw, env), thread.subject,
      thread.last_message_at, thread.operator_unread, thread.guest_unread,
      thread.redacted_count, thread.status, thread.created_at, thread.updated_at),
  ];

  if (firstMessage) {
    statements.push(env.DB.prepare(
      `INSERT INTO chat_messages (id, thread_id, sender, body, created_at, redacted)
       VALUES (?,?,'guest',?,?,?)`,
    ).bind(newId(), thread.id, firstMessage, t, firstClean?.redacted ? 1 : 0));
  }

  // One batch: a thread whose opening message failed to land would show the
  // operator an empty conversation with an unread badge on it.
  await env.DB.batch(statements);

  return { thread, token: raw };
}

/**
 * Resolves a guest's secret link -- or hands back a conversation somebody else
 * has already resolved and already authorised.
 *
 * Returns null for anything that does not match, including a blank token, so a
 * caller cannot accidentally look up "the thread whose hash is the hash of the
 * empty string".
 *
 * THE OBJECT ARM IS NOT A LOOKUP AND IS NOT A CHECK. When the router has
 * proved that the signed-in customer owns a thread -- threadForCustomer below,
 * called from guardGuestLink -- it passes the resolved Thread down instead of
 * a secret, and this hands it straight back. Twenty-odd guest functions across
 * ten files call this as their first line, so that one branch is what lets the
 * account door reuse every single one of them rather than growing a twin of
 * each. See the note on ThreadRef for the two shapes that were rejected.
 *
 * WHY THAT IS SAFE, stated plainly because it is the thing a reader will want
 * to check. The only values a request can put here are strings: a URL segment
 * is a string, a JSON body field is a string. There is no way to spell a
 * Thread object from outside the Worker, so the arm that skips the secret
 * cannot be reached by anything a caller sends -- only by code that already
 * holds a row it fetched itself. The name is still threadByToken because that
 * is what it does for every caller that existed before, and renaming it across
 * thirty call sites would have obscured how little actually changed.
 */
export async function threadByToken(env: Env, ref: ThreadRef): Promise<Thread | null> {
  if (typeof ref !== 'string') return ref;
  const raw = (ref ?? '').trim();
  if (!raw) return null;
  const row = await env.DB.prepare(
    `SELECT ${THREAD_FIELDS} FROM threads WHERE guest_token_hash = ?`,
  ).bind(await hashGuestToken(raw, env)).first<Thread>();
  return row ?? null;
}

/**
 * One thread, but only if it belongs to this customer account.
 *
 * THE OBJECT-LEVEL CHECK, and it is deliberately the same two-column WHERE
 * clause threadForOperator uses further down this file. That symmetry is the
 * point: the business side has had "this row, and only if it is yours" since
 * 0011, the query is one indexed equality, and there is nothing in it for a
 * future reader to get subtly wrong. Both sides of the market now answer the
 * question the same way.
 *
 * NULL RATHER THAN A REFUSAL, for the reason threadForOperator gives: the
 * caller turns null into the same "no such conversation" a made-up id gets, so
 * a thread id copied out of somebody else's account is indistinguishable from
 * one that was never real. An endpoint that answered "that exists but is not
 * yours" would be a way to count other people's conversations.
 *
 * THE ACCOUNT ID MUST COME FROM A SESSION. There is no code path that passes a
 * value from a URL or a body into this argument, and there must never be one --
 * the whole authority here is that the caller proved they can read mail at the
 * address the account is keyed on. See currentCustomer in lib/customers.ts.
 */
export async function threadForCustomer(
  env: Env, accountId: string, threadId: string,
): Promise<Thread | null> {
  if (!accountId || !threadId) return null;
  const row = await env.DB.prepare(
    `SELECT ${THREAD_FIELDS} FROM threads WHERE id = ? AND customer_account_id = ?`,
  ).bind(threadId, accountId).first<Thread>();
  return row ?? null;
}

/** One conversation as the customer's own list of them reports it. */
export interface CustomerThread extends Thread {
  /** Who they are talking to. The thread only carries an operator id. */
  business_name: string;
  /** So the list can link to the business's page. Null when they have no slug. */
  profile_slug: string | null;
  /** Set when this conversation is about a booking. Null for a bare enquiry. */
  starts_at: number | null;
  /** The other end of that hour. Null with starts_at, never on its own. */
  ends_at: number | null;
}

/** How a customer narrows their own list of conversations. */
export interface CustomerThreadListOptions extends ThreadListOptions {
  /**
   * One business, when the reader has picked one.
   *
   * THE FILTER THIS SIDE OF THE MARKET ACTUALLY NEEDS. The operator's list is
   * many different people talking to one business, so a name tells them apart.
   * The customer's list is the other way round -- the owner's words are
   * "customers will be messaging multiple [businesses]" -- and somebody who
   * has had five trades out has five rows that differ only by which business
   * is on them. So this is the one narrowing that matches how the list is
   * actually read: "the plumber", not "everything from last Tuesday".
   *
   * An operator id, not a slug, and it is NOT an authority: it narrows a query
   * already scoped by customer_account_id, so naming a business this account
   * has never written to returns an empty page rather than anybody else's
   * conversations.
   */
  operatorId?: string | null;
}

/**
 * One page of the conversations on this account, unanswered ones first.
 *
 * THE THING AN ACCOUNT BUYS THAT A LINK NEVER COULD, and the mirror image of
 * listThreads below: scoped by customer_account_id in the WHERE clause exactly
 * as the operator's inbox is scoped by operator_id, reading
 * idx_threads_account from migration 0052 and idx_threads_account_waiting from
 * 0053.
 *
 * THE GUEST LINK IS NOT IN THIS PAYLOAD AND CANNOT BE -- the same sentence
 * /api/customer/bookings carries, for the same reason. Only the hash of a
 * /c/:token is stored, so there is nothing here to hand back; this list
 * reaches a conversation by its id and on the account's authority instead, and
 * whoever still holds an old link keeps using it.
 *
 * `starts_at` is joined off the appointment rather than computed, so the list
 * can say "Tuesday's detail" instead of showing a reader five identical rows
 * for five jobs with one business. LEFT, because a conversation that never
 * became a booking is an ordinary member of this list -- for many people it is
 * the only kind they have -- and an inner join would answer them with nothing.
 *
 * ---------------------------------------------------------------------------
 * CLOSED CONVERSATIONS ARE IN THIS LIST BY DEFAULT, AND THAT IS NOT AN
 * OVERSIGHT
 * ---------------------------------------------------------------------------
 * The operator's own list defaults the other way -- see listThreads -- because
 * closing is how a business gets a finished job off its screen, and a queue
 * that never empties is a queue nobody trusts. Doing the same here would mean
 * a business closing a conversation made it VANISH from the customer's
 * account, along with the messages agreeing what the work was, the
 * photographs, and the price they paid. Nobody told the customer, and the
 * customer did nothing.
 *
 * That is the exact dead end migration 0052 exists to close, arriving by a
 * different route. A closed conversation still reads -- the schema says so
 * where it defines the column, and assertOpen only stops new messages -- so
 * the honest thing is to list it and say on the row that it has been closed,
 * which is what /account does. The reader can then narrow to open ones if they
 * want to; the default is everything they have.
 *
 * WHAT THE SEARCH IS AND IS NOT. `q` matches the BUSINESS's name -- the other
 * side, which is the only name on this screen a reader recognises; their own
 * first name is on every row -- the subject, and the text of what was said.
 * The message match is an EXISTS correlated on t.id, so it can only ever look
 * inside conversations this WHERE clause has already admitted; there is no
 * spelling of a search term that reaches a row on another account, because no
 * row on another account is ever a candidate.
 */
export async function listThreadsForCustomer(
  env: Env, accountId: string, opts: CustomerThreadListOptions = {},
): Promise<ThreadPage<CustomerThread>> {
  if (!accountId) return { threads: [], next_cursor: null };

  const pattern = searchPattern(opts.q);
  const operatorId = (opts.operatorId ?? '').trim() || null;
  const status = opts.status ?? 'all';

  return pageOfThreads<CustomerThread>(env, opts, async (segment, after, want) => {
    const rows = await env.DB.prepare(
      `SELECT ${qualified('t')},
              op.business_name AS business_name, op.profile_slug AS profile_slug,
              a.starts_at AS starts_at, a.ends_at AS ends_at
         FROM threads t
         LEFT JOIN operators op ON op.id = t.operator_id
         LEFT JOIN appointments a ON a.id = t.appointment_id
        WHERE t.customer_account_id = ?
          -- Spelled as a literal comparison and not as a bind, so it matches
          -- the predicate of the partial index in 0053. A parameter cannot:
          -- SQLite decides index usability from the text of the WHERE clause
          -- before it has any bound values.
          AND t.guest_unread ${segment === 'waiting' ? '> 0' : '= 0'}
          AND (? IS NULL OR t.operator_id = ?)
${STATUS_SQL}
${CURSOR_SQL}
          AND (? IS NULL
               OR op.business_name LIKE ? ESCAPE '\\'
               OR t.subject LIKE ? ESCAPE '\\'
               OR EXISTS (SELECT 1 FROM chat_messages m
                           WHERE m.thread_id = t.id AND m.body LIKE ? ESCAPE '\\'))
        ORDER BY t.last_message_at DESC, t.id DESC
        LIMIT ?`,
    ).bind(
      accountId,
      operatorId, operatorId,
      ...statusBinds(status),
      ...cursorBinds(after),
      pattern, pattern, pattern, pattern,
      want,
    ).all<CustomerThread>();

    return (rows.results ?? []).map((r) => ({
      ...r,
      business_name: r.business_name ?? '',
      profile_slug: r.profile_slug ?? null,
      starts_at: r.starts_at ?? null,
      ends_at: r.ends_at ?? null,
    }));
  }, (r) => r.guest_unread > 0, (r) => r.id, (r) => r.last_message_at);
}

/**
 * Which businesses this account has conversations with, for the filter.
 *
 * ITS OWN QUERY RATHER THAN DERIVED FROM THE PAGE, which is the whole reason
 * it exists. The filter has to offer every business the reader has written to,
 * and the page only holds twenty-five rows -- building the list of businesses
 * out of the rows on screen would mean the filter could not reach the business
 * whose conversation is the reason somebody is paging in the first place.
 *
 * Bounded, because it is drawn as a list of choices: somebody with more
 * businesses than this has a search box for the rest.
 *
 * WHAT IT COSTS, HONESTLY, because this is the one query behind either list
 * that is not purely index-ordered. It is an index seek on idx_threads_account
 * for this one account, a unique-index lookup per business for the name, and
 * then a temp b-tree to group and to order -- so the sort is over one person's
 * own conversations and nothing else. That is acceptable where a sort over the
 * table would not be: the set is bounded by how many conversations one
 * customer has, and it runs once per page rather than per row.
 */
export async function businessesInCustomerThreads(
  env: Env, accountId: string,
): Promise<Array<{ operator_id: string; business_name: string; threads: number }>> {
  if (!accountId) return [];
  const rows = await env.DB.prepare(
    `SELECT t.operator_id AS operator_id,
            COALESCE(op.business_name, '') AS business_name,
            COUNT(*) AS threads
       FROM threads t
       LEFT JOIN operators op ON op.id = t.operator_id
      WHERE t.customer_account_id = ?
      GROUP BY t.operator_id
      ORDER BY MAX(t.last_message_at) DESC
      LIMIT 50`,
  ).bind(accountId).all<{ operator_id: string; business_name: string; threads: number }>();
  return rows.results ?? [];
}

/**
 * How many of this account's conversations are waiting on the customer.
 *
 * The mirror of unreadThreadCount at the bottom of this file, and it did not
 * exist: the customer's list badged each row and had no total, so the only way
 * to find out whether anybody had replied was to read every row -- and once
 * the list is paged, to read every page. One row, one index seek on
 * idx_threads_account_waiting.
 *
 * COUNTS CLOSED CONVERSATIONS TOO, deliberately, because this list shows them:
 * a business's last word before closing a conversation is exactly the kind of
 * message a customer needs to be told about, and a badge whose number does not
 * match the rows underneath it is worse than no badge.
 */
export async function unreadThreadCountForCustomer(
  env: Env, accountId: string,
): Promise<number> {
  if (!accountId) return 0;
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM threads
      WHERE customer_account_id = ? AND guest_unread > 0`,
  ).bind(accountId).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * The transcript, oldest first.
 *
 * The limit takes the most recent messages and then puts them back in order,
 * because the end of a long conversation is the part either side is reading.
 */
export async function listMessages(
  env: Env, threadId: string, limit = DEFAULT_MESSAGE_LIMIT,
): Promise<ChatMessage[]> {
  const capped = Math.min(Math.max(1, Math.floor(limit)), MAX_MESSAGE_LIMIT);
  // Tie-broken on rowid, which is SQLite's insertion order, NOT on id.
  //
  // Ids are random, and created_at only has one-second resolution, so two
  // messages sent inside the same second were ordered arbitrarily — a quick
  // exchange could display the reply above the question. rowid is monotonic
  // and free; the table has one because it is not declared WITHOUT ROWID.
  //
  // LEFT and not INNER: almost every message has no photograph, and an inner
  // join would quietly return only the ones that do — a transcript consisting
  // of nothing but pictures, with every sentence between them missing. The
  // join runs on idx_message_photos_message, which is unique, so it is one
  // index seek per message and there is exactly one row or none.
  const rows = await env.DB.prepare(
    `SELECT ${MESSAGE_FIELDS} FROM chat_messages m
       LEFT JOIN message_photos p ON p.message_id = m.id
      WHERE m.thread_id = ?
      ORDER BY m.created_at DESC, m.rowid DESC
      LIMIT ?`,
  ).bind(threadId, capped).all<MessageRow>();
  return (rows.results ?? []).slice().reverse().map(toMessage);
}

/** How many guest messages this thread has taken in the rate-limit window. */
async function recentGuestMessages(env: Env, threadId: string, since: number): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM chat_messages
      WHERE thread_id = ? AND sender = 'guest' AND created_at >= ?`,
  ).bind(threadId, since).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Writes a message and moves the thread with it.
 *
 * The insert and the thread update are one batch on purpose: a message that
 * landed without bumping last_message_at sinks to the bottom of the operator's
 * inbox and is never seen, and an unread counter that missed an increment is a
 * badge that never appears. Either half alone is a message that silently does
 * not arrive, which is the one failure this whole feature exists to prevent.
 */
async function postMessage(
  env: Env, thread: Thread, sender: 'guest' | 'operator', body: string,
  photo?: PendingPhoto,
): Promise<ChatMessage> {
  const t = now();

  // Contact details are stripped BEFORE the insert, so the number never lands
  // in the row at all. Cleaning on the way out instead would leave it sitting
  // in the database for every export, backup and support query to carry, and
  // one query written without the filter would undo the whole thing.
  const clean = redactContact(body);

  const message: ChatMessage = {
    id: newId(), thread_id: thread.id, sender, body: clean.body, created_at: t,
    redacted: clean.redacted ? 1 : 0,
    photo: photo
      ? { id: photo.id, width: photo.width ?? 0, height: photo.height ?? 0 }
      : null,
    notice: redactionMessage(clean),
  };

  // The other side is the one who has something new to read.
  const column = sender === 'guest' ? 'operator_unread' : 'guest_unread';

  const writes = [
    env.DB.prepare(
      `INSERT INTO chat_messages (id, thread_id, sender, body, created_at, redacted)
       VALUES (?,?,?,?,?,?)`,
    ).bind(message.id, message.thread_id, message.sender, message.body,
      message.created_at, message.redacted),
    env.DB.prepare(
      `UPDATE threads
          SET last_message_at = ?, ${column} = ${column} + 1, updated_at = ?
        WHERE id = ? AND operator_id = ?`,
    ).bind(t, t, thread.id, thread.operator_id),
  ];

  // The photograph's row rides in the SAME batch as the message, for the same
  // reason the thread bump does. The bytes are already in the photo store by
  // the time this runs — they have to be, because a row pointing at a key that
  // was never written shows the other side a broken picture in a conversation
  // they cannot re-ask about. What must not happen is the mirror of that: a
  // message that arrives with the caption and no picture, because the second
  // insert failed on its own. D1 rolls a batch back as a unit, so either the
  // whole message exists with its photograph or none of it does, and the
  // caller above deletes the stored bytes when the batch throws.
  if (photo) {
    writes.push(env.DB.prepare(
      `INSERT INTO message_photos (id, message_id, thread_id, operator_id, order_item_id,
         photo_key, content_type, bytes, width, height, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(photo.id, message.id, thread.id, thread.operator_id, photo.order_item_id,
      photo.photo_key, photo.content_type, photo.bytes, photo.width, photo.height, t));
  }

  // Counted on the thread so a pattern is visible without scanning every
  // message. One redaction is habit; eleven from one account is somebody
  // working around the platform on purpose, and those two have to be
  // distinguishable before anyone can act on either.
  if (clean.redacted) {
    writes.push(env.DB.prepare(
      `UPDATE threads SET redacted_count = redacted_count + 1 WHERE id = ?`,
    ).bind(thread.id));
  }

  await env.DB.batch(writes);

  return message;
}

/**
 * A customer replies, authorised by nothing but their link.
 *
 * The operator is told, as a 'chat_message' — its own kind, added in migration
 * 0012. Filing a question about window cleaning as a booking would put "Rosa
 * booked Thursday" framing on it, and an operator who learns to distrust the
 * label stops reading the feed.
 */
export async function postAsGuest(
  env: Env, ref: ThreadRef, body: string,
): Promise<ChatMessage> {
  const clean = cleanBody(body);

  const thread = await threadByToken(env, ref);
  if (!thread) throw notFound('That conversation link is not valid any more.');
  assertOpen(thread);

  const recent = await recentGuestMessages(env, thread.id, now() - GUEST_WINDOW_SECONDS);
  if (recent >= GUEST_MAX_IN_WINDOW) {
    throw conflict(
      'That is a lot of messages at once. Give it a few minutes and try again.',
      'rate_limited',
    );
  }

  const message = await postMessage(env, thread, 'guest', clean);
  await tellOperator(env, thread, message);
  return message;
}

/**
 * Puts a customer's message in the operator's feed.
 *
 * After the write, never as part of it. notify swallows its own failures so a
 * message that was said is never lost to a feed row that would not insert.
 *
 * Extracted rather than copied into the photo path below, because the one
 * thing it does that is easy to get wrong is easy to get wrong twice:
 * message.body, not the caller's `body` -- the caller's string is only
 * length-checked, and putting it here would push the phone number the message
 * body just had stripped out straight into the notification feed instead.
 */
async function tellOperator(env: Env, thread: Thread, message: ChatMessage): Promise<void> {
  // A photograph with nothing typed alongside it has an empty body, and an
  // empty feed line reads as a bug rather than as a message. What the operator
  // needs to see in the list is that something arrived and what kind of thing
  // it was; the picture itself is one tap away in the conversation, which is
  // the only place it is ever shown.
  const excerpt = message.body.slice(0, FEED_EXCERPT_CHARS)
    || (message.photo ? 'Sent a photo' : '');

  await notify(env, thread.operator_id, {
    kind: 'chat_message',
    title: message.photo && !message.body
      ? `${thread.guest_name} sent you a photo`
      : `${thread.guest_name} sent you a message`,
    body: excerpt,
    appointment_id: thread.appointment_id,
    thread_id: thread.id,
  });
}

/**
 * The business replies.
 *
 * operator_id is in the WHERE clause of the lookup and of the thread update,
 * not checked by the caller: one business must never be able to read or write
 * another's conversation, and a thread id copied from somewhere else reports
 * the same "not found" a made-up one would.
 */
export async function postAsOperator(
  env: Env, operatorId: string, threadId: string, body: string,
): Promise<ChatMessage> {
  const clean = cleanBody(body);

  const thread = await threadForOperator(env, operatorId, threadId);
  if (!thread) throw notFound('That conversation is not yours.');
  assertOpen(thread);

  return postMessage(env, thread, 'operator', clean);
}

// ---------------------------------------------------------------------------
// Photographs, in the conversation
// ---------------------------------------------------------------------------
//
// "Is this the tap you meant?" "It is the one by the back door, look." "That
// is the wrong part, here is the label off it." None of those had anywhere to
// go: this file had no attachment support of any kind, and the only way to put
// a photograph on a job was ./proof.ts -- a staged before/during/after gallery
// hung off a booking, six pictures, kept for the length of time a dispute
// might take.
//
// That is the right home for evidence and the wrong home for a conversation,
// and using it as one fails three ways at once. It spends the six evidence
// slots on a picture of a tap. It requires a booking to exist, so the single
// most useful photograph of the lot -- the one a stranger sends BEFORE they
// book, showing what they actually want done -- had nowhere to go at all. And
// it files an aside under the retention rule written for an argument.
//
// So the split is: routine photographs are shared here, in the conversation,
// where they are a sentence; the stored gallery stays what it was, which is
// the record a claim is settled from. Migration 0051 is the schema and says at
// length why this is its own table and not five columns on chat_messages.
//
// EVERYTHING BELOW OBEYS THE SAME TWO RULES THE REST OF THE FILE DOES. A guest
// is authorised by the secret in their link and by nothing else; an operator
// is scoped by operator_id in the WHERE clause, so a photo id copied out of
// somebody else's conversation answers "no such photo" exactly as a made-up
// one does.

/**
 * A photograph whose bytes are already in the store, waiting for its row.
 *
 * This exists because the two writes cannot be one write. The bytes go to
 * Workers KV and the row goes to D1, and there is no transaction spanning
 * both, so the order has to be chosen and then kept: bytes first, row second,
 * and the bytes deleted again if the row is refused. That is the same order
 * addJobPhoto uses and the reasoning is identical -- the row is the record of
 * truth, so a row pointing at nothing would show somebody a broken picture,
 * while a stored value with no row is storage nobody can reach that is still
 * eating the account's one shared gigabyte of Workers KV, which the retention
 * sweep can be told to go and find.
 */
interface PendingPhoto {
  id: string;
  photo_key: string;
  content_type: string;
  bytes: number;
  width: number | null;
  height: number | null;
  order_item_id: string | null;
}

/** One stored photograph, as its own row. Never handed to a client whole. */
interface MessagePhoto {
  id: string;
  message_id: string;
  thread_id: string;
  operator_id: string;
  order_item_id: string | null;
  photo_key: string;
  content_type: string | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
  created_at: number;
}

const PHOTO_FIELDS =
  `id, message_id, thread_id, operator_id, order_item_id, photo_key,
   content_type, bytes, width, height, created_at`;

/** What the sender's browser measured, if it measured anything sane. */
function dimension(raw: number | null | undefined): number | null {
  if (raw == null || !Number.isFinite(raw)) return null;
  const n = Math.floor(raw);
  // A negative or absurd number is the client's arithmetic being wrong, not a
  // photograph, and storing it would make the browser reserve a box the size
  // of a building. Null means "unknown", which is a state the payload and the
  // renderer both already handle.
  return n > 0 && n <= 100_000 ? n : null;
}

/** How many photographs this conversation has taken in the rolling window. */
async function recentThreadPhotos(env: Env, threadId: string, since: number): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM message_photos WHERE thread_id = ? AND created_at >= ?`,
  ).bind(threadId, since).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * The booking this conversation is about right now, or null.
 *
 * Recorded on the photograph at upload rather than looked up when a sweep
 * eventually asks, because threads.appointment_id MOVES: a returning customer
 * writes to the same business on the same link, attachBooking re-points the
 * thread at the new job, and anything that asked the thread "which booking is
 * this?" afterwards would attribute last spring's photographs to this autumn's
 * job. Null is a real and common answer -- a stranger asking a question before
 * there is anything booked -- and attachBooking fills those in once, later.
 */
async function bookingForThread(env: Env, thread: Thread): Promise<string | null> {
  if (!thread.appointment_id) return null;
  const row = await env.DB.prepare(
    `SELECT id FROM order_items WHERE appointment_id = ? LIMIT 1`,
  ).bind(thread.appointment_id).first<{ id: string }>();
  return row?.id ?? null;
}

export interface PhotoMessageInput {
  file: unknown;
  /** What was typed alongside the picture, if anything. The picture may go alone. */
  body?: string | null;
  width?: number | null;
  height?: number | null;
}

/**
 * Stores one photograph and posts it as a message.
 *
 * ORDER OF OPERATIONS, AND WHY IT IS NOT proof.ts's ORDER. addJobPhoto cleans
 * the upload first and authorises second. This authorises first, because the
 * conversation is already resolved by the time we get here and the cheap
 * checks -- is the link real, is the thread still open, has this conversation
 * already had its day's worth -- are three indexed reads, while cleaning the
 * upload means buffering up to two megabytes into the isolate and walking
 * every EXIF box in it. Doing the expensive thing first on behalf of a caller
 * who was never going to be allowed to post is work done for a stranger.
 *
 * The store binding is checked before any of it. `env.PHOTOS` is optional --
 * see the note on it in ../types.ts -- and an environment without the
 * namespace bound must refuse cleanly and WRITE NOTHING, rather than inserting
 * a message row whose photograph can never exist.
 */
async function addMessagePhoto(
  env: Env, thread: Thread, sender: 'guest' | 'operator', input: PhotoMessageInput,
): Promise<ChatMessage> {
  if (!env.PHOTOS) {
    throw badRequest('Photo sharing is not switched on yet.', 'no_storage');
  }

  assertOpen(thread);

  // Empty allowed: the photograph is the message. See cleanBody.
  const caption = cleanBody(input.body, true);

  const t = now();
  const recent = await recentThreadPhotos(env, thread.id, t - PHOTO_WINDOW_SECONDS);
  if (recent >= PHOTO_MAX_IN_WINDOW) {
    throw conflict(
      'That is a lot of photos for one conversation today. '
      + 'Carry on in words, and you can send more tomorrow.',
      'too_many_photos',
    );
  }

  // Sized, identified by its own bytes, and stripped of where it was taken --
  // all before anything is stored. The sniffed type is what gets stored and
  // what gets served, never the one the uploader declared: a file announced as
  // image/jpeg that is really HTML would otherwise be handed back to the other
  // side's browser with a content type that invites it to execute.
  //
  // The strip matters more here than almost anywhere else in this product.
  // These are photographs one stranger is sending another stranger from inside
  // their own home, on a platform whose entire promise is that the two sides
  // do not exchange contact details. A JPEG straight off a phone carries the
  // coordinates it was taken at. Handing those over would be handing over the
  // customer's address in a feature built to avoid handing over their phone
  // number. See ./images.ts, which is honest about what that guarantee is
  // worth format by format.
  const { bytes, contentType } = await cleanImageUpload(input.file, {
    maxBytes: MAX_MESSAGE_PHOTO_BYTES, allowed: PHOTO_TYPES,
  });

  const orderItemId = await bookingForThread(env, thread);

  // Write-once, never overwritten: newId() is unique per upload and nothing in
  // this file ever puts to a key that already exists. That promise is not just
  // tidiness -- /api/public/photo derives its etag from the key on the
  // strength of it, so a writer that overwrote one would turn a cached
  // portfolio picture stale forever.
  //
  // The prefix is `m/` for message: `j/` is job proof, `w/` is an operator's
  // portfolio, `a/` is reserved for avatars. A sweep walking the store can
  // then tell what it is looking at from the key alone, which is the only
  // thing it has when the row is already gone. `m/` is deliberately absent
  // from PUBLIC_PHOTO_PREFIXES in ../index.ts: these are private, like `j/`.
  const key = `m/${thread.operator_id}/${thread.id}/${newId()}`;
  await putPhoto(env.PHOTOS, key, bytes, contentType);

  const pending: PendingPhoto = {
    id: newId(),
    photo_key: key,
    content_type: contentType,
    // What was stored, not what arrived. The stripped file is smaller than the
    // one the phone sent, and the row has to describe the bytes it points at
    // -- this number is what tells anybody how much of the shared gigabyte the
    // conversations are actually using.
    bytes: bytes.length,
    width: dimension(input.width),
    height: dimension(input.height),
    order_item_id: orderItemId,
  };

  try {
    return await postMessage(env, thread, sender, caption, pending);
  } catch (e) {
    // The batch rolled back, so there is no row and no message -- only bytes
    // in the store that nothing will ever name. Deleting them here is the only
    // moment anything still knows the key.
    await env.PHOTOS.delete(key).catch(() => {});
    throw e;
  }
}

/**
 * A customer sends a photograph, authorised by nothing but their link.
 *
 * The same door postAsGuest uses and the same identity: the secret in the
 * link, no sign-in, on a phone that has never been signed in to anything. That
 * is the point of the whole guest surface and it is what makes this usable --
 * somebody standing in their own kitchen photographing a leak is not going to
 * stop and create an account first.
 */
export async function postPhotoAsGuest(
  env: Env, ref: ThreadRef, input: PhotoMessageInput,
): Promise<ChatMessage> {
  const thread = await threadByToken(env, ref);
  if (!thread) throw notFound('That conversation link is not valid any more.');

  const message = await addMessagePhoto(env, thread, 'guest', input);
  await tellOperator(env, thread, message);
  return message;
}

/**
 * The business sends a photograph.
 *
 * operator_id is in the WHERE clause of the lookup, exactly as it is in
 * postAsOperator: a thread id copied from somewhere else reports the same "not
 * found" a made-up one would, and no business can post into another's
 * conversation.
 */
export async function postPhotoAsOperator(
  env: Env, operatorId: string, threadId: string, input: PhotoMessageInput,
): Promise<ChatMessage> {
  const thread = await threadForOperator(env, operatorId, threadId);
  if (!thread) throw notFound('That conversation is not yours.');

  return addMessagePhoto(env, thread, 'operator', input);
}

/**
 * Streams one conversation photograph, to somebody on that conversation.
 *
 * Deliberately NOT a public URL with an unguessable key, for the same reason
 * readJobPhoto is not: a key that leaks in a referrer header, a screenshot or
 * a support ticket would be a permanent public link to the inside of a
 * stranger's house. Every read is authorised, every time.
 *
 * AND IT MUST NOT BE AN ENUMERATOR, which is the specific thing this shape
 * buys. A photo id says nothing about who may see it, so the row is fetched
 * first and then the caller is made to prove they are on THAT conversation:
 * an operator through threadForOperator, which scopes by operator_id, and a
 * guest through their own token, which resolves to exactly one thread. An id
 * belonging to any other conversation -- guessed, or copied out of a different
 * chat window -- fails the comparison and gets the same "no such photo" a
 * made-up id gets. The caller cannot tell the two apart, which is the whole
 * point: an oracle that distinguishes "exists but not yours" from "does not
 * exist" is a way to count other people's photographs.
 */
export async function readMessagePhoto(
  env: Env, who: { operator_id?: string; token?: ThreadRef }, photoId: string,
): Promise<Response> {
  // 404 and not 503. There is no such photo in an environment with no photo
  // store, which is the true answer and is also the one that says least.
  if (!env.PHOTOS) throw notFound('No such photo.');

  const photo = await env.DB.prepare(
    `SELECT ${PHOTO_FIELDS} FROM message_photos WHERE id = ?`,
  ).bind(photoId).first<MessagePhoto>();
  if (!photo) throw notFound('No such photo.');

  const thread = who.operator_id
    ? await threadForOperator(env, who.operator_id, photo.thread_id)
    : await threadByToken(env, who.token ?? '');
  // The second half of that condition is what refuses a stranger's id. The
  // operator branch cannot fail it -- threadForOperator was asked for this
  // exact thread -- but the guest branch resolves the caller's OWN thread from
  // their token without ever looking at the photo, so this is the line where
  // the two are compared. Written once, for both, so neither can be changed
  // without the other being looked at.
  if (!thread || thread.id !== photo.thread_id) throw notFound('No such photo.');

  // Null here means no such key in the store, which is the same thing it meant
  // when the store was R2 and is answered the same way.
  const stored = await getPhoto(env.PHOTOS, photo.photo_key);
  if (!stored) throw notFound('No such photo.');

  return new Response(stored.body, {
    headers: {
      // The row's content_type and not the copy in the store's metadata. They
      // are the same sniffed value, written from one cleanImageUpload result,
      // and this function already holds the row. Neither is what the uploader
      // declared -- see ./images.ts.
      'content-type': photo.content_type ?? 'image/jpeg',
      // Private, and never shared: the URL is only meaningful to somebody who
      // already holds the session or the link that authorised it, and a shared
      // cache holding a copy would be a copy nobody authorised.
      'cache-control': 'private, max-age=3600',
    },
  });
}

/** Exported for the tests, so the numbers above are asserted rather than retyped. */
export const MESSAGE_PHOTO_LIMITS = {
  MAX_BYTES: MAX_MESSAGE_PHOTO_BYTES,
  MAX_IN_WINDOW: PHOTO_MAX_IN_WINDOW,
  WINDOW_SECONDS: PHOTO_WINDOW_SECONDS,
  TYPES: PHOTO_TYPES,
} as const;

/** How an operator narrows their own inbox. */
export interface OperatorThreadListOptions extends ThreadListOptions {
  /**
   * Only the conversations with a booking behind them.
   *
   * THE ONE DISTINCTION THAT DECIDES WHICH ROW GETS ANSWERED FIRST when there
   * are more rows than anybody can read. "Someone asking a price" and
   * "somebody who has paid and is expecting a van on Tuesday" are two
   * different obligations, and the inbox drew them identically -- the only
   * difference on the row was the subject line, which is often null. A
   * business behind on its messages needs to be able to see the paid ones on
   * their own.
   *
   * appointment_id IS NOT NULL is the test, which is the same thing the row's
   * "About a booking" label is drawn from, so the filter and the label cannot
   * disagree about what a booking is.
   */
  bookedOnly?: boolean;
}

/**
 * One page of the operator's inbox, unanswered questions first.
 *
 * SCOPED BY operator_id IN THE WHERE CLAUSE, ALWAYS, which is the rule this
 * table has had since 0011 and the reason no filter below is allowed to be the
 * only thing standing between one business and another's conversations. Every
 * narrowing here -- unread, booked, status, the search -- runs INSIDE that
 * scope; none of them can widen it, because none of them touches operator_id.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS WAS AND WHAT IT COST
 * ---------------------------------------------------------------------------
 * Two queries, both `ORDER BY last_message_at DESC LIMIT 50`, one with
 * `operator_unread > 0` and one without, and nothing else. Three things were
 * wrong with it and they got worse together as the inbox filled up:
 *
 *   NO WAY PAST ROW 200. The limit was capped and there was no cursor, so a
 *   business with three hundred conversations had a hundred of them
 *   unreachable from the only screen where a customer's question can be
 *   answered. Silently -- the list simply ended.
 *
 *   NO WAY TO FIND ONE. A name, a time and a subject line per row, no search
 *   and no filter except unread. "The woman in Van Nuys who asked about the
 *   arches" was findable by scrolling and by nothing else.
 *
 *   ORDERED BY RECENCY ALONE, so an unanswered question sank one place for
 *   every other conversation that got a message. The question that has been
 *   waiting longest -- the one about to cost the job -- ended up furthest from
 *   the top. See pageOfThreads for why the ordering is now "waiting on you
 *   first" and why that is read as two index seeks rather than one sort.
 *
 * ---------------------------------------------------------------------------
 * CLOSED CONVERSATIONS ARE OUT BY DEFAULT, AND THE CUSTOMER'S LIST DIFFERS
 * ---------------------------------------------------------------------------
 * `status` defaults to 'open' here because closing is the only way a business
 * gets a finished conversation off this screen, and an archive that still
 * appears in the queue is not an archive. listThreadsForCustomer defaults to
 * 'all' instead, and the note there says why at length: a business closing a
 * conversation must not make it disappear off the customer's account.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE SEARCH COSTS, HONESTLY
 * ---------------------------------------------------------------------------
 * `q` matches the customer's name, the subject, and the text of the messages.
 * The first two are a string compare per row over the operator's own index
 * range. The third is an EXISTS correlated on t.id, which seeks
 * idx_chat_messages_thread per candidate thread and walks that one
 * conversation -- so a search reads the operator's messages and nobody
 * else's, and it is the only query in this file that is not a plain index
 * seek. It is here anyway because "what was said" is frequently the only thing
 * the operator remembers about the conversation they are looking for, and a
 * search that cannot find it sends them back to scrolling. It runs only when
 * somebody has typed in the box, never on the poll.
 *
 * THE SEARCH CANNOT CROSS A TENANT BOUNDARY, which is the property that
 * matters more than the cost. The EXISTS is correlated to a thread that the
 * WHERE clause has already restricted to this operator, so a message body
 * belonging to another business is never a candidate to be compared -- there
 * is no term anybody can type that widens the set of threads being searched.
 */
export async function listThreads(
  env: Env, operatorId: string, opts: OperatorThreadListOptions = {},
): Promise<ThreadPage<Thread>> {
  if (!operatorId) return { threads: [], next_cursor: null };

  const pattern = searchPattern(opts.q);
  const status = opts.status ?? 'open';

  return pageOfThreads<Thread>(env, opts, async (segment, after, want) => {
    const rows = await env.DB.prepare(
      `SELECT ${qualified('t')}
         FROM threads t
        WHERE t.operator_id = ?
          -- A literal and not a bind, so the partial index from 0053 is
          -- usable: SQLite decides that from the text of the WHERE clause,
          -- before any value is bound. See pageOfThreads.
          AND t.operator_unread ${segment === 'waiting' ? '> 0' : '= 0'}
          AND (? = 0 OR t.appointment_id IS NOT NULL)
${STATUS_SQL}
${CURSOR_SQL}
          AND (? IS NULL
               OR t.guest_name LIKE ? ESCAPE '\\'
               OR t.subject LIKE ? ESCAPE '\\'
               OR EXISTS (SELECT 1 FROM chat_messages m
                           WHERE m.thread_id = t.id AND m.body LIKE ? ESCAPE '\\'))
        ORDER BY t.last_message_at DESC, t.id DESC
        LIMIT ?`,
    ).bind(
      operatorId,
      opts.bookedOnly ? 1 : 0,
      ...statusBinds(status),
      ...cursorBinds(after),
      pattern, pattern, pattern, pattern,
      want,
    ).all<Thread>();
    return rows.results ?? [];
  }, (r) => r.operator_unread > 0, (r) => r.id, (r) => r.last_message_at);
}

/**
 * Closes a conversation, or opens it again. The operator's decision, only.
 *
 * ---------------------------------------------------------------------------
 * threads.status HAS EXISTED SINCE 0011 AND NOTHING HAS EVER WRITTEN IT
 * ---------------------------------------------------------------------------
 * The column was there, the CHECK constraint was there, assertOpen refused new
 * messages on a closed thread, rank.ts refused to offer an hour into one, the
 * operator's inbox drew a "this conversation is closed" notice and the
 * customer's account page had a sentence ready for it. Every consumer of the
 * feature was built. There was no producer: no route, no function, no path of
 * any kind set the value, so every row in the table was 'open' for ever and
 * all of that code was unreachable.
 *
 * What that cost is the whole of the owner's problem in one line. An inbox
 * where nothing can be finished only grows, so the conversation from March
 * about a job that was done in March sits between two live ones for ever, and
 * the answer to "more messages by customers asking questions" was to scroll
 * past the ones already dealt with. This is the producer.
 *
 * OPERATOR ONLY, AND THE CUSTOMER SIDE IS NOT GETTING ONE. Closing withdraws
 * the business's willingness to keep talking, which is the business's call to
 * make about its own queue; a customer who wants a conversation to stop can
 * stop writing in it. Giving the customer the same button would also mean
 * either hiding the thread from the business -- one side deciding what the
 * other may see -- or a second kind of closed, which is two states pretending
 * to be one.
 *
 * SCOPED IN THE WHERE CLAUSE, like every other write in this file: a thread id
 * copied out of somebody else's inbox reports the same "not yours" a made-up
 * one gets, and changes nothing.
 *
 * ---------------------------------------------------------------------------
 * CLOSING CLEARS THE OPERATOR'S OWN UNREAD COUNT, AND NEVER THE CUSTOMER'S
 * ---------------------------------------------------------------------------
 * Those are two different decisions and both are deliberate.
 *
 * The operator's badge is cleared because leaving it would produce a number
 * nobody can act on. The header count is "how many conversations are waiting
 * on you"; the default list hides closed ones; so a closed thread with an
 * unread message on it would say "1 unread conversation" above a list that
 * does not contain it, for ever, with no way to find the row and no way to
 * clear it. Closing a conversation is a statement that the operator is done
 * with it, which is the same statement marking it read makes.
 *
 * The CUSTOMER's badge is untouched, because it is not the operator's to
 * clear. The business's last message before closing -- "we cannot do Tuesday
 * after all" -- is exactly the message a customer most needs to be told
 * arrived, and zeroing guest_unread would be the business marking its own
 * message as read on the customer's behalf. Their row keeps its badge until
 * they open it.
 *
 * REOPENING DOES NOT RESURRECT A COUNT, and should not. The number was "how
 * many messages you have not looked at", the operator looked at the
 * conversation in order to close it, and inventing a badge on the way back in
 * would be the app claiming something it does not know.
 */
export async function setThreadStatus(
  env: Env, operatorId: string, threadId: string, status: 'open' | 'closed',
): Promise<Thread> {
  const thread = await threadForOperator(env, operatorId, threadId);
  if (!thread) throw notFound('That conversation is not yours.');

  const t = now();
  // operator_unread is written in the same statement rather than in a second
  // one, so the row can never be seen closed-but-still-unread by a list read
  // in between. Only on the way to 'closed': the CASE leaves it alone when a
  // conversation is being reopened, per the note above.
  await env.DB.prepare(
    `UPDATE threads
        SET status = ?,
            operator_unread = CASE WHEN ? = 'closed' THEN 0 ELSE operator_unread END,
            updated_at = ?
      WHERE id = ? AND operator_id = ?`,
  ).bind(status, status, t, threadId, operatorId).run();

  return {
    ...thread,
    status,
    operator_unread: status === 'closed' ? 0 : thread.operator_unread,
    updated_at: t,
  };
}

/** One thread, but only if it belongs to this operator. Null otherwise -- never a leak. */
export async function threadForOperator(
  env: Env, operatorId: string, threadId: string,
): Promise<Thread | null> {
  if (!operatorId || !threadId) return null;
  const row = await env.DB.prepare(
    `SELECT ${THREAD_FIELDS} FROM threads WHERE id = ? AND operator_id = ?`,
  ).bind(threadId, operatorId).first<Thread>();
  return row ?? null;
}

/**
 * Clears one side's unread count.
 *
 * The guest is identified by their token and the operator by their id, because
 * those are the only two things either side has. Neither can clear the other's
 * badge: the column being zeroed is chosen here, not by the caller.
 *
 * ---------------------------------------------------------------------------
 * THE CUSTOMER NOW HAS TWO DOORS AND THIS FUNCTION ANSWERS TO BOTH
 * ---------------------------------------------------------------------------
 * Worth stating in as many words, because it is the one place a badge could
 * have gone wrong when the account door landed and it did not, and a reader
 * checking that has to be able to see why rather than infer it.
 *
 * A customer reaches a conversation two ways since migration 0052: the secret
 * in /c/:token, and their own account at /account/messages/:id. Both arrive at
 * GET /api/public/threads/:ref, which calls this with whatever the router put
 * in `ref` -- the raw token string on the link door, and the already-resolved
 * Thread on the account door. The `token` parameter is therefore a ThreadRef
 * and not a string, and threadByToken hands an object straight back rather
 * than looking anything up (see the note on its object arm). So the badge is
 * cleared by reading through EITHER door, and it is the same column either
 * way.
 *
 * The failure that would have been is worth naming: if this had taken a
 * `string`, the account door would have called it with an object, the lookup
 * would have missed, the early return would have swallowed it silently, and a
 * customer who reads every message on their account would have kept a badge
 * on the row for ever with no way to clear it except finding the link they
 * came here because they had lost. Nothing would have thrown.
 *
 * THE GUEST BRANCH'S UPDATE IS SCOPED BY id ALONE, and that is correct rather
 * than an omission. There is no second column to scope it by: the token
 * resolved to exactly one row by unique index, or the router proved the
 * signed-in account owns that row, so by the time either branch reaches the
 * UPDATE the authorisation has already happened and the id is the answer to it.
 * Adding `AND customer_account_id = ?` would break the link door, where there
 * is no account and frequently never will be.
 */
export async function markThreadRead(
  env: Env, side: 'guest', ref: { token: ThreadRef },
): Promise<void>;
export async function markThreadRead(
  env: Env, side: 'operator', ref: { operator_id: string; thread_id: string },
): Promise<void>;
export async function markThreadRead(
  env: Env, side: 'guest' | 'operator',
  ref: { token?: ThreadRef; operator_id?: string; thread_id?: string },
): Promise<void> {
  const t = now();

  if (side === 'guest') {
    const thread = await threadByToken(env, ref.token ?? '');
    if (!thread) return;   // a stale link clears nothing, and says nothing
    await env.DB.prepare(
      `UPDATE threads SET guest_unread = 0, updated_at = ? WHERE id = ?`,
    ).bind(t, thread.id).run();
    return;
  }

  if (!ref.operator_id || !ref.thread_id) return;
  await env.DB.prepare(
    `UPDATE threads SET operator_unread = 0, updated_at = ?
      WHERE id = ? AND operator_id = ?`,
  ).bind(t, ref.thread_id, ref.operator_id).run();
}

/**
 * Links a conversation that started before the booking to the booking itself.
 *
 * The common case: someone asks a question from the public slot page, likes
 * the answer and books. Without this the operator has the appointment in one
 * place and the conversation about it in another, and the gate code is in
 * neither.
 *
 * THE ACCOUNT ARRIVES HERE FOR MOST CONVERSATIONS THAT HAVE ONE, and that is
 * worth saying out loud because it is not obvious from the call sites. The
 * enquiry is the common way a thread starts -- somebody asks whether a van
 * fits down their alley before they pay for anything -- and at that moment
 * there is frequently no account to name. Booking is where one appears: the
 * checkout proved an address with a six-digit code and wrote the order against
 * the account it belongs to. So this is where an anonymous conversation
 * becomes a conversation the person can find again from /account, and a thread
 * that skipped this step would stay reachable only on its link for ever even
 * though its owner is sitting there with a proved account.
 */
export async function attachBooking(
  env: Env, threadId: string,
  booking: {
    appointment_id: string; client_id?: string | null;
    /** The order's own account, when the booking was made against one. */
    customer_account_id?: string | null;
  },
): Promise<void> {
  const appointmentId = booking?.appointment_id?.trim();
  if (!appointmentId) throw badRequest('That booking has no appointment.', 'no_appointment');

  // Two statements, one batch, and the second one is the reason this is a
  // batch at all.
  //
  // THE PHOTOGRAPHS SENT BEFORE THERE WAS A BOOKING BELONG TO THE BOOKING.
  // That is not a nicety, it is the most valuable picture on the whole job:
  // the one a stranger sends to show what they actually want done, which is
  // sent while they are still deciding whether to book at all. Left as it was,
  // that photograph carried a NULL order_item_id for ever -- it was taken
  // before there was anything to attach it to -- and to anything reading the
  // table afterwards it looked like an idle enquiry with no work behind it.
  // The failure that produces is quiet and bad: a retention sweep that keeps
  // photographs longer while a booking is disputed would age out the one
  // picture the dispute is actually about, because nothing had ever told it
  // which job that picture was of.
  //
  // ONLY THE NULLs, which is what makes it safe to run on every attach. A
  // thread is not retired when a job ends -- a returning customer writes to
  // the same business on the same link and this function re-points the thread
  // at the new job -- so a photograph already attributed to an earlier booking
  // must keep that booking. COALESCE is not used for the same reason: the
  // WHERE clause is the filter, so a row that already has an answer is not
  // rewritten with today's.
  //
  // The subselect resolving NULL is a no-op rather than a wipe, which is the
  // case that actually turns up: the older single-slot claims that predate
  // orders have an appointment and no order_item, and setting NULL where it is
  // already NULL changes nothing.
  //
  // THE ACCOUNT IS FILLED IN AND NEVER MOVED, which is a different rule from
  // the two columns beside it, so all three are worth saying separately.
  //
  //   appointment_id is overwritten, because the thread follows the current
  //   job -- that is what makes a returning customer's link keep working.
  //
  //   client_id takes the new value when there is one and keeps the old one
  //   otherwise: COALESCE(?, client_id). Unchanged by this edit.
  //
  //   customer_account_id is COALESCE(customer_account_id, ?) -- the other way
  //   round -- so a null is filled in and an answer already there is left
  //   alone. Two reasons, and the second is the one that matters. A
  //   conversation belongs to a PERSON rather than to a job, so the first
  //   account to claim it is the right one and every later booking on the same
  //   link agrees with it. And writing the incoming value unconditionally
  //   would let a booking placed while signed out -- where the order carries a
  //   null account -- blank the account off a conversation that had one, which
  //   would silently drop it out of that customer's list at /account with no
  //   way for anybody to notice.
  const [linked] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE threads SET appointment_id = ?, client_id = COALESCE(?, client_id),
              customer_account_id = COALESCE(customer_account_id, ?), updated_at = ?
        WHERE id = ?`,
    ).bind(appointmentId, booking.client_id ?? null,
      booking.customer_account_id ?? null, now(), threadId),
    env.DB.prepare(
      `UPDATE message_photos
          SET order_item_id = (SELECT oi.id FROM order_items oi
                                WHERE oi.appointment_id = ? LIMIT 1)
        WHERE thread_id = ? AND order_item_id IS NULL`,
    ).bind(appointmentId, threadId),
  ]);

  // Checked after the batch rather than before it, because the batch is what
  // makes the two writes one thing. A thread id that matches nothing changes
  // no threads AND owns no photographs, so the second statement is a no-op on
  // exactly the requests this refuses.
  if ((linked?.meta?.changes ?? 0) === 0) throw notFound('No such conversation.');
}

// ---------------------------------------------------------------------------
// A stranger opening a conversation, from a profile page and nothing else
// ---------------------------------------------------------------------------
//
// Everything above assumes the guest already holds a link, because until now
// only a booking could mint one. The two functions below are the other door:
// the reference marketplace puts "Message" and "Request a quote" on a profile
// as first-class actions, usable when nothing is scheduled, and a person who
// wants to ask whether a van fits down their alley before they pay for
// anything had nowhere on this site to ask it.
//
// Opening that door is the reason the rest of this section exists. A booking
// costs the person making it a name, a phone number, an address and a
// geocode; a message costs them a sentence. That difference is the whole
// abuse surface, and it is answered below.

/** How this business is named by whoever is writing to it. */
export interface EnquiryTarget {
  /** The public URL segment, which is all a profile page has. */
  slug?: string | null;
  /** The operator id, which the slot and gap pages already carry. */
  id?: string | null;
}

/** The business, as far as anyone starting a conversation needs to know it. */
export interface EnquiryOperator {
  id: string;
  business_name: string;
  profile_slug: string | null;
  trade: string | null;
}

/**
 * Resolves a business a stranger is allowed to write to, or null.
 *
 * ONE PLACE, AND EVERY PATH THAT MINTS A GUEST TOKEN GOES THROUGH IT. The
 * conditions are the same set claimSlot applies before it will sell a slot,
 * and they were not all being applied here: the thread route checked the plan
 * and the public-bookings flag and nothing else, so a business suspended for
 * missed appointments — whose openings are pulled from the map, who cannot
 * post a new one, and who cannot be sent an instant request — still had its
 * inbox open to every stranger on the internet. A ladder that stops the work
 * and leaves the enquiries is not a suspension, it is a slower version of
 * being listed.
 *
 * `is_published` is required of a SLUG and not of an id, which is the one
 * place the two spellings genuinely differ. A slug names a profile page, and a
 * business that has taken its page down has said what it wants. An id comes
 * from an open slot on the map — `accept_public_bookings` is what put it
 * there, publishing a profile is a separate decision, and a customer looking
 * at a bookable appointment must be able to ask a question about it whether or
 * not the business has written an About section.
 */
export async function operatorForEnquiry(
  env: Env, ref: EnquiryTarget,
): Promise<EnquiryOperator | null> {
  const slug = (ref.slug ?? '').trim();
  const id = (ref.id ?? '').trim();
  if (!slug && !id) return null;

  const t = now();
  // Both spellings in one statement rather than two functions that can drift:
  // whichever the caller has, the conditions below are the same conditions.
  const row = await env.DB.prepare(
    `SELECT id, business_name, profile_slug, trade
       FROM operators
      WHERE ((? <> '' AND profile_slug = ? AND is_published = 1)
             OR (? <> '' AND id = ?))
        AND accept_public_bookings = 1
        AND plan IN ('trial','active')
        AND banned_at IS NULL
        AND (suspended_until IS NULL OR suspended_until <= ?)`,
  ).bind(slug, slug, id, id, t).first<EnquiryOperator>();

  return row ?? null;
}

/**
 * How many different businesses one address may open a conversation with.
 *
 * Ten, over six hours. The shape of the number matters more than the number:
 * it counts BUSINESSES REACHED, not messages sent, so a customer going back
 * and forth with one plumber never touches it however much they type, and
 * somebody genuinely shopping around — three or four quotes for the same job,
 * which is what the reference's own "request a quote" flow encourages — is
 * nowhere near it either. What it does bound is breadth: at this ceiling an
 * address can reach forty businesses a day, which is a rounding error against
 * a city and is reached by nobody who is actually asking about a job.
 *
 * Six hours rather than a day because the key is an address and an address is
 * not a person — an office, a café and everything behind CGNAT are one row
 * here — so a wrongly-caught bystander gets their allowance back inside the
 * same afternoon without anybody having to ask for it.
 */
const REACH_MAX_OPERATORS = 10;
const REACH_WINDOW_SECONDS = 6 * 60 * 60;

/**
 * Refuses before a conversation is opened with a business this address has not
 * reached before.
 *
 * Called with the operator already resolved, so a business already spoken to
 * is free: the count is of DISTINCT rows, and the row for that pair already
 * exists. That is what makes this survivable for a real customer and fatal for
 * a spray — the two are told apart by the only thing that actually
 * distinguishes them.
 */
export async function assertEnquiryReachAllowed(
  env: Env, ip: string, operatorId: string,
): Promise<void> {
  const t = now();
  const since = t - REACH_WINDOW_SECONDS;

  const already = await env.DB.prepare(
    `SELECT 1 FROM enquiry_reach WHERE ip = ? AND operator_id = ? AND first_at > ?`,
  ).bind(ip, operatorId, since).first();
  // Writing again to somebody already written to is not reaching anybody new.
  if (already) return;

  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM enquiry_reach WHERE ip = ? AND first_at > ?`,
  ).bind(ip, since).first<{ n: number }>();

  if ((row?.n ?? 0) >= REACH_MAX_OPERATORS) {
    // 429 with a Retry-After rather than a bare refusal, so a person caught by
    // somebody else on their address is told when to come back instead of
    // reloading into the wall. The window is fixed from each first contact, so
    // the honest answer is when the oldest row in it ages out.
    const oldest = await env.DB.prepare(
      `SELECT MIN(first_at) AS at FROM enquiry_reach WHERE ip = ? AND first_at > ?`,
    ).bind(ip, since).first<{ at: number | null }>();
    const retryAfter = Math.max(60, (oldest?.at ?? t) + REACH_WINDOW_SECONDS - t);

    const err = new RateLimitedError(
      'You have started conversations with a lot of businesses in a short time. '
      + `Carry on with the ones you have opened — you can write to a new business again in ${
        Math.ceil(retryAfter / 3600)} hours.`,
      retryAfter,
    );
    // Its own code, so this is distinguishable in a log — and by the front end
    // — from the ordinary volume limits, which mean something else entirely.
    err.code = 'too_many_businesses';
    throw err;
  }
}

/**
 * Records that this address has now reached this business.
 *
 * After the conversation exists, never before: a refusal further down — a
 * blank name, a message over the length cap — must not spend an allowance on
 * a conversation that was never opened.
 *
 * ON CONFLICT DO NOTHING keeps first_at as the FIRST contact rather than the
 * latest, which is what makes the window a window. Refreshing it on every
 * message would let one long conversation hold a slot open indefinitely.
 */
export async function recordEnquiryReach(
  env: Env, ip: string, operatorId: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO enquiry_reach (ip, operator_id, first_at) VALUES (?,?,?)
     ON CONFLICT(ip, operator_id) DO NOTHING`,
  ).bind(ip, operatorId, now()).run();
}

/**
 * Drops rows the window has moved past, on the cron.
 *
 * A row is only interesting while it is counting. Kept for ever it would be a
 * permanent record of which businesses each address has ever written to, which
 * is a thing worth having only if you want to be asked for it.
 */
export async function sweepEnquiryReach(env: Env): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM enquiry_reach WHERE first_at <= ?`,
  ).bind(now() - REACH_WINDOW_SECONDS).run();
}

/** Exported for the tests, so the numbers above are asserted rather than retyped. */
export const ENQUIRY_REACH_LIMITS = {
  MAX_OPERATORS: REACH_MAX_OPERATORS, WINDOW_SECONDS: REACH_WINDOW_SECONDS,
} as const;

/**
 * How many conversations are waiting on the operator. Drives the badge, so one row.
 *
 * OPEN ONLY, and that condition was added with the close button rather than
 * before it. The number is printed above a list that now hides closed
 * conversations by default, and a badge counting rows the list does not show
 * is a badge nobody can clear: "1 unread conversation" over a list with
 * nothing unread in it, permanently, with no row to press. setThreadStatus
 * zeroes operator_unread on close so this should already agree with it, and
 * the condition is here as well because agreement by arithmetic is worth less
 * than agreement stated in both queries -- lib/parts.ts increments this column
 * from a path of its own, and the day one of those lands on a closed thread
 * the badge and the list must still say the same thing.
 *
 * It reads idx_threads_operator_waiting from 0053, which is a partial index
 * over exactly the rows being counted -- so on a business with two thousand
 * conversations and three unread this touches three index entries instead of
 * walking all two thousand. This is polled every fifteen seconds by an open
 * inbox, which is what made it worth an index.
 */
export async function unreadThreadCount(env: Env, operatorId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM threads
      WHERE operator_id = ? AND operator_unread > 0 AND status = 'open'`,
  ).bind(operatorId).first<{ n: number }>();
  return row?.n ?? 0;
}
