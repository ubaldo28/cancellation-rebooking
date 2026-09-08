import type { Env } from '../types';
import { hashOfferToken } from './auth';
import { FEED_EXCERPT_CHARS, notify } from './feed';
import { RateLimitedError } from './ratelimit';
import { firstNameOnly, redactContact, redactionMessage } from './redact';
import { badRequest, conflict, newId, newToken, notFound, now } from './util';

/**
 * In-app messages between a customer and a business.
 *
 * The requirement is "no number exchange, no sms": the two sides talk here or
 * not at all. The customer has no account -- their identity is the secret in
 * the link they were given -- so everything a guest does is authorised by that
 * token and nothing else, and everything an operator does is scoped by
 * operator_id in the WHERE clause, the same as everywhere else in this
 * codebase.
 */

/** One conversation. */
export interface Thread {
  id: string;
  operator_id: string;
  /** The opening being asked about, before any booking exists. */
  gap_id: string | null;
  appointment_id: string | null;
  client_id: string | null;
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
 * The guest endpoint has no account behind it -- a token is enough to post --
 * so without this it is a free relay for anyone who scrapes one link. The
 * limit is per thread rather than per IP because the token is the only
 * identity we actually have.
 */
const GUEST_WINDOW_SECONDS = 300;
const GUEST_MAX_IN_WINDOW = 20;

const DEFAULT_MESSAGE_LIMIT = 200;
const MAX_MESSAGE_LIMIT = 500;
const DEFAULT_THREAD_LIMIT = 50;
const MAX_THREAD_LIMIT = 200;

const THREAD_FIELDS =
  `id, operator_id, gap_id, appointment_id, client_id, guest_name, subject,
   last_message_at, operator_unread, guest_unread, redacted_count, status,
   created_at, updated_at`;

const MESSAGE_FIELDS = `id, thread_id, sender, body, created_at, redacted`;

/**
 * The one place a message body is checked.
 *
 * Both post paths go through it, so a guest and an operator cannot end up with
 * different ideas of what fits in the column.
 */
function cleanBody(raw: string | null | undefined): string {
  const body = (raw ?? '').trim();
  if (!body) throw badRequest('Type a message first.', 'empty_message');
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
      `INSERT INTO threads (id, operator_id, gap_id, appointment_id, client_id, guest_name,
         guest_token_hash, subject, last_message_at, operator_unread, guest_unread,
         redacted_count, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(thread.id, thread.operator_id, thread.gap_id, thread.appointment_id,
      thread.client_id, thread.guest_name, await hashGuestToken(raw, env), thread.subject,
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
 * Resolves a guest's secret link.
 *
 * Returns null for anything that does not match, including a blank token, so a
 * caller cannot accidentally look up "the thread whose hash is the hash of the
 * empty string".
 */
export async function threadByToken(env: Env, rawToken: string): Promise<Thread | null> {
  const raw = (rawToken ?? '').trim();
  if (!raw) return null;
  const row = await env.DB.prepare(
    `SELECT ${THREAD_FIELDS} FROM threads WHERE guest_token_hash = ?`,
  ).bind(await hashGuestToken(raw, env)).first<Thread>();
  return row ?? null;
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
  const rows = await env.DB.prepare(
    `SELECT ${MESSAGE_FIELDS} FROM chat_messages
      WHERE thread_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?`,
  ).bind(threadId, capped).all<ChatMessage>();
  return (rows.results ?? []).slice().reverse();
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
  env: Env, rawToken: string, body: string,
): Promise<ChatMessage> {
  const clean = cleanBody(body);

  const thread = await threadByToken(env, rawToken);
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

  // After the write, never as part of it. notify swallows its own failures so
  // a message that was said is never lost to a feed row that would not insert.
  //
  // message.body, not `clean` -- `clean` is only length-checked, and putting it
  // here would push the phone number the message body just had stripped out
  // straight into the notification feed instead.
  await notify(env, thread.operator_id, {
    kind: 'chat_message',
    title: `${thread.guest_name} sent you a message`,
    body: message.body.slice(0, FEED_EXCERPT_CHARS),
    appointment_id: thread.appointment_id,
    thread_id: thread.id,
  });

  return message;
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

/** The operator's inbox, most recently active first. Scoped by operator_id, always. */
export async function listThreads(
  env: Env, operatorId: string,
  opts: { unreadOnly?: boolean; limit?: number } = {},
): Promise<Thread[]> {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? DEFAULT_THREAD_LIMIT)),
    MAX_THREAD_LIMIT);

  const rows = opts.unreadOnly
    ? await env.DB.prepare(
        `SELECT ${THREAD_FIELDS} FROM threads
          WHERE operator_id = ? AND operator_unread > 0
          ORDER BY last_message_at DESC, id DESC
          LIMIT ?`,
      ).bind(operatorId, limit).all<Thread>()
    : await env.DB.prepare(
        `SELECT ${THREAD_FIELDS} FROM threads
          WHERE operator_id = ?
          ORDER BY last_message_at DESC, id DESC
          LIMIT ?`,
      ).bind(operatorId, limit).all<Thread>();

  return rows.results ?? [];
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
 */
export async function markThreadRead(
  env: Env, side: 'guest', ref: { token: string },
): Promise<void>;
export async function markThreadRead(
  env: Env, side: 'operator', ref: { operator_id: string; thread_id: string },
): Promise<void>;
export async function markThreadRead(
  env: Env, side: 'guest' | 'operator',
  ref: { token?: string; operator_id?: string; thread_id?: string },
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
 */
export async function attachBooking(
  env: Env, threadId: string,
  booking: { appointment_id: string; client_id?: string | null },
): Promise<void> {
  const appointmentId = booking?.appointment_id?.trim();
  if (!appointmentId) throw badRequest('That booking has no appointment.', 'no_appointment');

  const res = await env.DB.prepare(
    `UPDATE threads SET appointment_id = ?, client_id = COALESCE(?, client_id), updated_at = ?
      WHERE id = ?`,
  ).bind(appointmentId, booking.client_id ?? null, now(), threadId).run();

  if ((res.meta.changes ?? 0) === 0) throw notFound('No such conversation.');
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

/** How many conversations are waiting on the operator. Drives the badge, so one row. */
export async function unreadThreadCount(env: Env, operatorId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM threads
      WHERE operator_id = ? AND operator_unread > 0`,
  ).bind(operatorId).first<{ n: number }>();
  return row?.n ?? 0;
}
