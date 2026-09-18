import type { Env } from '../types';
import { attachBooking, threadByToken, threadForOperator, type ThreadRef } from './chat';
import { formatMoney, localeFor } from './countries';
import { FEED_EXCERPT_CHARS, notify } from './feed';
import {
  NOWHERE, bookingLineWrites, calendarBumpWrite, clientWrite, orderWrite,
  type BookingPlace, type WriteGuard,
} from './orders';
import { redactContact } from './redact';
import { customerStanding } from './standing';
import { formatTimeRange } from './tz';
import {
  MAX_DURATION_SECONDS, MAX_NOTE_CHARS, MIN_DURATION_SECONDS,
  badRequest, conflict, newId, notFound, now,
} from './util';

/**
 * Estimates, asked for and answered in the chat.
 *
 * The problem this solves, in one sentence: everything else on this site is
 * "pick a posted opening and pay for it", and the job somebody actually wants
 * is often neither posted nor on the price list — "can you do the whole house
 * next Thursday?" — so until now the only way to ask was to get a phone number
 * off the platform, which is the one conversation this product exists to keep
 * on it.
 *
 * The shape, deliberately the same four steps as a parts quote (see parts.ts)
 * one step earlier in the story:
 *
 *   asked      the customer describes what they want, in their own words
 *   quoted     the business answers with a description, a price, how long it
 *              will take and when it would start
 *   accepted   the customer taps yes and it becomes an ordinary booking —
 *              an order, an appointment, a start code and a card form, the
 *              same rows a posted opening produces. See decideEstimate.
 *   declined / withdrawn / expired — the ways it ends without a booking
 *
 * THIS IS NOT A SEPARATE MARKETPLACE. Nothing here invents a second kind of
 * job with its own rules about money. An accepted estimate is a front door
 * into the existing booking flow, and every promise the rest of the site makes
 * about what a customer sees before they are charged has to hold here too.
 *
 * The two rules every function below is written around:
 *
 *   1. NOBODY IS EVER CHARGED FOR A NUMBER THEY HAVE NOT SEEN. The price and
 *      the start time live on the row the customer tapped, and the acceptance
 *      is guarded on `status='quoted'` in the WHERE clause so a second tap
 *      cannot decide anything twice.
 *   2. NEITHER SIDE IS TRUSTED WITH AN ID. The customer is whoever holds the
 *      guest link — the token resolves to exactly one thread, and an estimate
 *      is only theirs if it is in that thread. The operator is whoever the
 *      session says, and operator_id is in the WHERE clause of every statement
 *      rather than checked by the caller.
 */

/** The states from migration 0029, in the order they happen. */
export const ESTIMATE_STATUSES = [
  'asked', 'quoted', 'accepted', 'declined', 'withdrawn', 'expired',
] as const;
export type EstimateStatus = (typeof ESTIMATE_STATUSES)[number];

/** The two states where something is still expected of somebody. */
const LIVE_STATUSES: readonly EstimateStatus[] = ['asked', 'quoted'];

/**
 * "Can you do the whole house next Thursday? Three bedrooms, the conservatory
 * is bad" is the job here. A page of requirements is a document, and a D1 row
 * is not the place for one.
 */
const MAX_REQUEST_CHARS = 600;

/*
 * The operator's answer is a line the customer reads on a phone, not a scope
 * of work. Three hundred characters, which is MAX_NOTE_CHARS in ./util —
 * the same ceiling as the parts note, the parts-quote description and the note
 * on an instant opening, all of which used to declare it separately.
 */

/**
 * Typo guards, not policy. Nobody quotes a bespoke domestic job at fifty
 * thousand, and a zero-price "estimate" is a message, not something to accept.
 *
 * MAX_PRICE_CENTS IS NOT THE SAME NUMBER AS online.ts's, AND IS NOT SHARED.
 * It is $50,000 here and $10,000 there, sitting beside the very same duration
 * bounds in both files, which is exactly the trap: the two look like one
 * constant written twice and they are not. A quoted estimate is a bespoke job
 * an operator has thought about and priced — a loft conversion, a full
 * repaint — while an instant opening is a slot somebody taps to fill this
 * afternoon, so the ceiling that catches a typo is five times higher here.
 *
 * WHETHER THAT GAP IS STILL WANTED HAS NOT BEEN DECIDED. It may well be
 * deliberate; it may equally be two people picking a round number a year
 * apart. Until somebody decides, BOTH STAY, and neither is quietly moved to
 * the other's value on the way past. The matching note is at the declaration
 * in online.ts.
 */
const MIN_PRICE_CENTS = 1;
const MAX_PRICE_CENTS = 50_000_00;

/*
 * Fifteen minutes to twelve hours. Outside that somebody has typed seconds as
 * minutes. Shared with online.ts through ./util — unlike MAX_PRICE_CENTS
 * above, these two ARE the same decision in both files.
 */

/**
 * How far ahead a quoted start may sit.
 *
 * The near end matters more than the far end: a quote that starts in four
 * minutes is a quote the customer cannot realistically read, answer and be
 * ready for, and it would be swept to 'expired' almost immediately — which
 * reads to both of them as the site losing the job.
 */
const MIN_LEAD_SECONDS = 30 * 60;
const MAX_LEAD_SECONDS = 180 * 24 * 60 * 60;

/**
 * How many unanswered estimates one conversation may carry.
 *
 * Not a rate limit on rudeness — three open questions from one customer is a
 * person who has thought of three jobs, which is good. It is a cap on a
 * scraped guest link being used to bury an operator's screen in requests that
 * each demand a price.
 */
const MAX_LIVE_PER_THREAD = 3;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

export interface Estimate {
  id: string;
  thread_id: string;
  operator_id: string;
  /** What the customer asked for, in their own words. */
  request: string;
  /** The operator's answer. NULL until they reply — the customer's "waiting on them". */
  description: string | null;
  price_cents: number | null;
  duration_seconds: number | null;
  starts_at: number | null;
  currency: string | null;
  status: EstimateStatus;
  expires_at: number | null;
  decided_at: number | null;
  /**
   * The order this estimate became, written in the SAME batch as the flip to
   * 'accepted'. THE INVARIANT: a row that says 'accepted' with order_id still
   * NULL means exactly one thing — the customer said yes and the booking did
   * not get made — and nothing in this file can produce that state any more.
   * See decideEstimate, and the query for finding such rows written out there.
   */
  order_id: string | null;
  created_at: number;
  updated_at: number;
}

const ESTIMATE_FIELDS =
  `id, thread_id, operator_id, request, description, price_cents, duration_seconds,
   starts_at, currency, status, expires_at, decided_at, order_id, created_at, updated_at`;

/** The business's currency, timezone and how to write numbers for them. */
interface OperatorVoice {
  business_name: string;
  currency: string;
  timezone: string;
  locale: string;
}

/**
 * One read for everything needed to write a sentence about money and time.
 *
 * Falls back rather than throwing: a missing operator row must not stop a
 * customer answering a quote they have already been shown. The worst case is a
 * transcript line that says "The business" and prints dollars — annoying, and
 * strictly better than a decision that will not go through.
 */
async function operatorVoice(env: Env, operatorId: string): Promise<OperatorVoice> {
  const row = await env.DB.prepare(
    `SELECT business_name, currency, timezone, country, language
       FROM operators WHERE id = ?`,
  ).bind(operatorId).first<{
    business_name: string; currency: string; timezone: string;
    country: string; language: string;
  }>();
  return {
    business_name: row?.business_name ?? 'The business',
    currency: row?.currency ?? 'USD',
    timezone: row?.timezone ?? 'UTC',
    locale: localeFor(row?.country ?? 'US', row?.language ?? 'en'),
  };
}

/** How a quote reads in one line, wherever it is read. One place, so it cannot disagree. */
function quoteLine(e: Estimate, v: OperatorVoice): string {
  const money = formatMoney(e.price_cents ?? 0, e.currency ?? v.currency, v.locale);
  const when = e.starts_at != null && e.duration_seconds != null
    ? formatTimeRange(e.starts_at, e.starts_at + e.duration_seconds, v.timezone, v.locale)
    : null;
  return when ? `${e.description} — ${money}, ${when}` : `${e.description} — ${money}`;
}

/**
 * Writes a line into the conversation and moves the thread with it.
 *
 * Returned as statements rather than run here, so the transcript line always
 * goes into the SAME batch as the state change it describes. A message that
 * landed without its status change is the site telling one side something that
 * did not happen; a status change with no message is a booking that appears out
 * of nowhere in a conversation that never mentions it.
 *
 * The unread counter goes to the OTHER side, and which column that is is
 * decided here from `sender` rather than passed in — the same rule as chat.ts,
 * where neither side gets to clear or raise the other's badge.
 *
 * THE GUARD IS NOT OPTIONAL DECORATION on the decision paths, and leaving it
 * off was a real if small bug. A D1 batch is one transaction, but a
 * transaction commits whatever its statements matched: when the guarded
 * UPDATE on the estimate matched nothing — a second tap, a race — these two
 * still landed, so the transcript grew a "Declined: …" line for an estimate
 * that had in fact been accepted a moment earlier, and the operator's badge
 * went up for a message about something that did not happen. Same fragment,
 * same statements, no second spelling.
 */
function chatWrites(
  env: Env, threadId: string, sender: 'guest' | 'operator', body: string, t: number,
  guard?: WriteGuard | null,
) {
  const column = sender === 'guest' ? 'operator_unread' : 'guest_unread';
  return [
    env.DB.prepare(
      `INSERT INTO chat_messages (id, thread_id, sender, body, created_at)
       SELECT ?,?,?,?,?${guard ? ` WHERE ${guard.sql}` : ''}`,
    ).bind(newId(), threadId, sender, body, t, ...(guard?.args ?? [])),
    env.DB.prepare(
      `UPDATE threads SET last_message_at = ?, ${column} = ${column} + 1, updated_at = ?
        WHERE id = ?${guard ? ` AND ${guard.sql}` : ''}`,
    ).bind(t, t, threadId, ...(guard?.args ?? [])),
  ];
}

/** Why a state change was refused, in words the person reading them can act on. */
function whyNotLive(status: EstimateStatus): string {
  switch (status) {
    case 'accepted': return 'That estimate has already been accepted.';
    case 'declined': return 'That estimate was already declined.';
    case 'withdrawn': return 'The business took that estimate back. They can send a new one.';
    case 'expired': return 'That estimate ran out — the time it was for has passed. '
      + 'Ask them for a fresh one.';
    default: return 'That estimate has already been answered.';
  }
}

// ---------------------------------------------------------------------------
// 1. The customer asks
// ---------------------------------------------------------------------------

/**
 * A customer asks for something that is not on the price list.
 *
 * Authorised by the guest link and nothing else. There is no thread id in this
 * signature on purpose: the token resolves to exactly one conversation, so
 * there is no id for a caller to swap for somebody else's.
 *
 * The request text goes through the same contact-detail filter every chat
 * message does, BEFORE the insert. Skipping it here would make this the one
 * text box on the site where a phone number survives — and it is the most
 * tempting box there is, because the person typing it is describing a job and
 * reaching for "just call me about it".
 */
export async function askForEstimate(
  env: Env, ref: ThreadRef, requestText: string,
): Promise<Estimate> {
  const thread = await threadByToken(env, ref);
  if (!thread) throw notFound('That conversation link is not valid any more.');
  if (thread.status !== 'open') {
    throw conflict('This conversation has been closed.', 'thread_closed');
  }

  const raw = (requestText ?? '').trim();
  if (!raw) {
    throw badRequest('Say what you would like doing. They cannot price a blank.',
      'no_request');
  }
  if (raw.length > MAX_REQUEST_CHARS) {
    throw badRequest(
      `That is a lot to read on a phone. Keep it under ${MAX_REQUEST_CHARS} characters `
      + 'and they can ask for the rest here.', 'request_too_long');
  }
  const request = redactContact(raw).body;

  // Counted rather than left to the database.
  //
  // Migration 0029 puts a partial unique index on (thread_id, id) over the
  // live statuses, which reads like "one live estimate per thread" but is not:
  // id is already unique, so every row satisfies it. Whether that index is
  // right is a schema question and this file does not own the schema, so the
  // limit that actually protects the operator is enforced here, in code, where
  // it can also produce a sentence a human understands.
  const live = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM estimates
      WHERE thread_id = ? AND status IN ('asked','quoted')`,
  ).bind(thread.id).first<{ n: number }>();
  if ((live?.n ?? 0) >= MAX_LIVE_PER_THREAD) {
    throw conflict(
      'You already have questions waiting with them. Give them a chance to answer '
      + 'those first.', 'too_many_open');
  }

  const t = now();
  const estimate: Estimate = {
    id: newId(),
    thread_id: thread.id,
    operator_id: thread.operator_id,
    request,
    description: null,
    price_cents: null,
    duration_seconds: null,
    starts_at: null,
    currency: null,
    status: 'asked',
    // No fuse on a question. A quote is a standing number and has to die; an
    // unanswered question costs nobody anything, and expiring it would only
    // delete the evidence that the business never replied.
    expires_at: null,
    decided_at: null,
    order_id: null,
    created_at: t,
    updated_at: t,
  };

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO estimates (id, thread_id, operator_id, request, description,
         price_cents, duration_seconds, starts_at, currency, status, expires_at,
         decided_at, order_id, created_at, updated_at)
       VALUES (?,?,?,?,NULL,NULL,NULL,NULL,NULL,'asked',NULL,NULL,NULL,?,?)`,
    ).bind(estimate.id, estimate.thread_id, estimate.operator_id, estimate.request, t, t),
    // Said out loud in the conversation, in the customer's own words, as the
    // customer. The operator is not watching an estimates screen; they are
    // reading a thread, and a request that only exists in a panel they have to
    // go and find is a request nobody answers.
    ...chatWrites(env, thread.id, 'guest',
      `Asked for an estimate: ${request}`, t),
  ]);

  // After the write, never as part of it — notify swallows its own failures so
  // a question that was asked is never lost to a feed row that would not
  // insert. Filed as 'chat_message' because that is what the CHECK in
  // migration 0021 allows and this file does not own the schema; an estimate
  // deserves its own kind and adding one is a migration, not a line here.
  await notify(env, thread.operator_id, {
    kind: 'chat_message',
    title: `${thread.guest_name} asked for an estimate`,
    body: request.slice(0, FEED_EXCERPT_CHARS),
    appointment_id: thread.appointment_id,
    thread_id: thread.id,
  });

  return estimate;
}

// ---------------------------------------------------------------------------
// 2. The business answers
// ---------------------------------------------------------------------------

export interface QuoteEstimateInput {
  description: string;
  price_cents: number;
  duration_seconds: number;
  starts_at: number;
}

/**
 * The business puts a price and a time against what was asked.
 *
 * All four are required, and that is the point of the whole feature: a price
 * with no start time is a conversation, not something a customer can accept,
 * and a start time with no price is how people end up arguing on a doorstep.
 *
 * Re-quoting a quote is allowed — the guard is `status IN ('asked','quoted')`,
 * not `'asked'` — because an operator who typed 300 meaning 3000 needs to fix
 * it, and the corrected row is the only number the customer can ever see or
 * tap. What the guard refuses is the change that comes after a decision:
 * accepted, declined, withdrawn and expired are all final.
 */
export async function quoteEstimate(
  env: Env, operatorId: string, estimateId: string, input: QuoteEstimateInput,
): Promise<Estimate> {
  // The customer's half of this conversation is already filtered a hundred
  // lines up; the operator's answer was not, which left the one free-text box
  // in the product that goes from a business to a stranger with nothing
  // reading it. Same filter, same reason.
  const description = redactContact(
    (input?.description ?? '').trim().slice(0, MAX_NOTE_CHARS),
  ).body.trim();
  if (!description) {
    throw badRequest('Say what you would be doing. A price on its own is not '
      + 'something anyone can agree to.', 'no_description');
  }

  const price = Math.round(Number(input?.price_cents));
  if (!Number.isFinite(price) || price < MIN_PRICE_CENTS) {
    throw badRequest('An estimate needs a price. If there is nothing to pay, just '
      + 'send them a message.', 'bad_price');
  }
  if (price > MAX_PRICE_CENTS) throw badRequest('That price looks like a typo.', 'bad_price');

  const duration = Math.round(Number(input?.duration_seconds));
  if (!Number.isFinite(duration)
    || duration < MIN_DURATION_SECONDS || duration > MAX_DURATION_SECONDS) {
    throw badRequest('How long will it take? Somewhere between a quarter of an hour '
      + 'and a full day.', 'bad_duration');
  }

  const t = now();
  const startsAt = Math.round(Number(input?.starts_at));
  if (!Number.isFinite(startsAt) || startsAt <= t) {
    throw badRequest('The start time has to be in the future.', 'bad_start');
  }
  if (startsAt < t + MIN_LEAD_SECONDS) {
    throw badRequest('Give them at least half an hour to answer and get ready. '
      + 'For work starting sooner than that, take the job as it stands.', 'too_soon');
  }
  if (startsAt > t + MAX_LEAD_SECONDS) {
    throw badRequest('That is too far ahead to hold a price for.', 'too_far');
  }

  // operator_id in the WHERE clause, not checked afterwards. An id copied from
  // somewhere else gets the same answer as one that was never real, because
  // which estimate ids exist is not a thing this API confirms.
  const row = await env.DB.prepare(
    `SELECT ${ESTIMATE_FIELDS} FROM estimates WHERE id = ? AND operator_id = ?`,
  ).bind(estimateId, operatorId).first<Estimate>();
  if (!row) throw notFound('That estimate is not yours.');
  // Read first only so the operator gets a sentence instead of a bare 409. The
  // guarantee is the guard in the UPDATE below, which is what survives two
  // taps arriving at once.
  if (!LIVE_STATUSES.includes(row.status)) throw conflict(whyNotLive(row.status), 'estimate_decided');

  const voice = await operatorVoice(env, operatorId);
  const quoted: Estimate = {
    ...row,
    description,
    price_cents: price,
    duration_seconds: duration,
    starts_at: startsAt,
    currency: voice.currency,
    status: 'quoted',
    // The job itself is the deadline, so that is the expiry. A separate TTL
    // would either kill a quote the customer was still thinking about or leave
    // one answerable after the morning it was for, and the second one is a
    // customer accepting a slot the operator has already given away.
    expires_at: startsAt,
    updated_at: t,
  };

  const writes = [
    env.DB.prepare(
      `UPDATE estimates
          SET description = ?, price_cents = ?, duration_seconds = ?, starts_at = ?,
              currency = ?, status = 'quoted', expires_at = ?, updated_at = ?
        WHERE id = ? AND operator_id = ? AND status IN ('asked','quoted')`,
    ).bind(description, price, duration, startsAt, voice.currency, startsAt, t,
      estimateId, operatorId),
    ...chatWrites(env, row.thread_id, 'operator',
      `${voice.business_name} sent an estimate: ${quoteLine(quoted, voice)}. `
      + 'Nothing is booked or charged until you accept it.', t),
  ];

  const res = await env.DB.batch(writes);
  if ((res[0]?.meta.changes ?? 0) === 0) {
    throw conflict('That estimate was answered while you were typing.', 'estimate_decided');
  }

  return quoted;
}

/**
 * The business takes it back before the customer answers.
 *
 * Withdrawn, not deleted, and the customer is told in the thread. They may
 * already have seen the number and be about to tap it, and a row that quietly
 * vanished cannot explain itself.
 */
export async function withdrawEstimate(
  env: Env, operatorId: string, estimateId: string,
): Promise<Estimate> {
  const row = await env.DB.prepare(
    `SELECT ${ESTIMATE_FIELDS} FROM estimates WHERE id = ? AND operator_id = ?`,
  ).bind(estimateId, operatorId).first<Estimate>();
  if (!row) throw notFound('That estimate is not yours.');
  if (!LIVE_STATUSES.includes(row.status)) throw conflict(whyNotLive(row.status), 'estimate_decided');

  const t = now();
  const voice = await operatorVoice(env, operatorId);

  // A withdrawn question and a withdrawn quote are different news. "We cannot
  // take that on" is the honest version of the first; pretending a price was
  // pulled when none was ever sent would leave the customer waiting for one.
  const body = row.status === 'quoted'
    ? `${voice.business_name} withdrew their estimate for ${row.description}. `
      + 'Ask them if you would still like the work doing.'
    : `${voice.business_name} cannot take that one on.`;

  const res = await env.DB.batch([
    env.DB.prepare(
      `UPDATE estimates SET status = 'withdrawn', decided_at = ?, updated_at = ?
        WHERE id = ? AND operator_id = ? AND status IN ('asked','quoted')`,
    ).bind(t, t, estimateId, operatorId),
    ...chatWrites(env, row.thread_id, 'operator', body, t),
  ]);
  if ((res[0]?.meta.changes ?? 0) === 0) {
    throw conflict('That estimate was answered before you took it back.', 'estimate_decided');
  }

  return { ...row, status: 'withdrawn', decided_at: t, updated_at: t };
}

// ---------------------------------------------------------------------------
// 3. The customer decides
// ---------------------------------------------------------------------------

/** The order an accepted estimate became, in the shape the browser needs it. */
export interface EstimateOrder {
  id: string;
  total_cents: number;
  currency: string;
}

/**
 * What a decision hands back: the estimate row, plus the booking if one was made.
 *
 * `order` is NULL for a decline, and for nothing else. An ACCEPT either books
 * and returns a non-null order, or throws — it never comes back with a yes
 * recorded and no booking behind it, because the two are written in one batch
 * and cannot come apart. Callers handling an accept therefore have two cases,
 * not three: a 200 with an order id to pay against, or a refusal with a
 * sentence to show. See decideEstimate.
 */
export interface EstimateDecision extends Estimate {
  order: EstimateOrder | null;
}

/**
 * What the customer is told when the time they were quoted has since gone.
 *
 * One sentence, in one place, because it is said from two: once by the read
 * below, which catches the ordinary case of a slot filled hours ago, and once
 * by the guarded write, which catches the same thing happening in the
 * milliseconds either side of the batch.
 */
const SLOT_GONE =
  'They have taken another job in that time since they sent this estimate, so it '
  + 'cannot be booked. Nothing has been charged — ask them for a new time.';

/**
 * Accept or decline, authorised by nothing but the guest link.
 *
 * The status change IS the commitment, and it is written with
 * `status='quoted'` in the WHERE clause. A customer double-tapping accept — on
 * a phone, one-handed, on a bad connection — matches no row the second time,
 * so the second tap changes nothing and cannot become a second booking or a
 * second charge. That guard is not defensive tidiness; it is the difference
 * between a Thursday morning being booked once and being booked twice.
 *
 * The estimate is fetched by id AND thread_id, where the thread is whichever
 * one the token resolved to. An id lifted from somebody else's link resolves
 * to no row and gets the same answer as an id that was never real.
 */
export async function decideEstimate(
  env: Env, ref: ThreadRef, estimateId: string, decision: 'accepted' | 'declined',
): Promise<EstimateDecision> {
  if (decision !== 'accepted' && decision !== 'declined') {
    throw badRequest('Accept it or decline it.', 'bad_decision');
  }

  const thread = await threadByToken(env, ref);
  if (!thread) throw notFound('That link is not valid any more.');

  const row = await env.DB.prepare(
    `SELECT ${ESTIMATE_FIELDS} FROM estimates WHERE id = ? AND thread_id = ?`,
  ).bind(estimateId, thread.id).first<Estimate>();
  if (!row) throw notFound('That estimate is not on your conversation.');

  const t = now();
  if (row.status === 'asked') {
    throw conflict('They have not sent a price for that yet.', 'not_quoted');
  }
  if (row.status !== 'quoted') throw conflict(whyNotLive(row.status), 'estimate_decided');
  // Checked here as well as in the sweep, for the same reason the online
  // switch is a timestamp: a row is only still live because nothing has
  // expired it yet, and a customer must never be able to accept a start time
  // that has already gone past because the cron was late.
  const deadline = row.expires_at ?? row.starts_at;
  if (deadline != null && deadline <= t) {
    throw conflict('That time has passed. Ask them for a fresh estimate.', 'estimate_expired');
  }

  const voice = await operatorVoice(env, row.operator_id);
  const money = formatMoney(row.price_cents ?? 0, row.currency ?? voice.currency, voice.locale);

  /**
   * "…and only while that estimate still says 'quoted'." Appended to every
   * write either path makes, exactly as parts.ts appends `stillSent`.
   *
   * This is what makes a double tap harmless for the whole booking and not
   * merely for the status column. The batch is one transaction, but a
   * transaction commits what its statements MATCHED — so without this the
   * second tap would still insert an order, a client, an appointment and a
   * receipt, then find the estimate already decided and throw, leaving a
   * complete second booking behind the apology.
   */
  const stillQuoted =
    `EXISTS (SELECT 1 FROM estimates q WHERE q.id = ? AND q.status = 'quoted')`;

  // -------------------------------------------------------------------------
  // Declining: two statements, and no booking to make.
  // -------------------------------------------------------------------------
  if (decision === 'declined') {
    const guard: WriteGuard = { sql: stillQuoted, args: [estimateId] };
    const writes = [
      // Written as the customer, because the customer is who decided. An
      // operator scrolling back months later is reading a conversation, and
      // "you said no on the 3rd" has to be visible inside it.
      ...chatWrites(env, row.thread_id, 'guest',
        `Declined: ${row.description} — ${money}.`, t, guard),
      // LAST, so everything above it saw the row as it was before the decision.
      env.DB.prepare(
        `UPDATE estimates SET status = 'declined', decided_at = ?, updated_at = ?
          WHERE id = ? AND status = 'quoted'`,
      ).bind(t, t, estimateId),
    ];
    const res = await env.DB.batch(writes);
    if ((res[res.length - 1]?.meta.changes ?? 0) === 0) {
      throw conflict('That estimate was already answered.', 'estimate_decided');
    }
    // After the batch. A notification that will not insert must never undo a
    // decision the customer has already made.
    await notify(env, row.operator_id, {
      kind: 'chat_message',
      title: `${thread.guest_name} declined the ${money} estimate`,
      body: row.description,
      appointment_id: thread.appointment_id,
      thread_id: row.thread_id,
      starts_at: row.starts_at,
    });
    return { ...row, status: 'declined', decided_at: t, updated_at: t, order: null };
  }

  // -------------------------------------------------------------------------
  // Accepting: where a quote becomes a booking.
  //
  // THIS USED TO BE A COMMENT. For a long time there was a block here headed
  // "PAYMENT SEAM" explaining what ought to happen on this line, and what
  // happened instead was nothing: the customer tapped accept, the row went to
  // 'accepted', and no appointment, no order and no charge followed. The
  // operator was told somebody had said yes to $240 of work and had no booking
  // to do it against; the customer had agreed to a price and was never asked
  // for money. That is the dead end this block replaces, on a live site.
  //
  // WHAT NOW HAPPENS, in one batch:
  //
  //   an order for exactly `row.price_cents` in `row.currency` — the figure
  //   on the row the customer tapped, never recalculated and never read off
  //   the operator's current price list, because the price the customer saw
  //   is the only price this site will ever charge;
  //
  //   a client row, an appointment and an order_item for `row.starts_at` +
  //   `row.duration_seconds`, written by the SAME builders placeOrder uses
  //   (orderWrite, clientWrite, bookingLineWrites in lib/orders.ts), so a
  //   booking sold by a quote is the same rows as one sold by a posted
  //   opening and inherits start code, photographs, arrival, cancellation,
  //   refunds and settlement without a second code path to keep in step;
  //
  //   and the estimate's flip to 'accepted' WITH `order_id` set, in that one
  //   statement, which is the last in the batch.
  //
  // THE INVARIANT THAT BUYS. 'accepted' with order_id still NULL means one
  // thing and cannot mean anything else: the customer said yes and the
  // booking did not get made. Nothing this function does can produce that
  // state — the two live in one UPDATE — so every such row is either from
  // before this block existed or is a bug worth paging somebody about. It is
  // found with:
  //
  //   SELECT id, thread_id, operator_id, decided_at FROM estimates
  //    WHERE status = 'accepted' AND order_id IS NULL;
  //
  // NO MONEY MOVES HERE. The order is written 'pending' and unpaid, and the
  // customer pays it through the embedded card form like every other order —
  // POST /api/public/orders/:id/pay, which is startPayment in lib/checkout.ts.
  // Charging inside this function would mean a second way to take money, with
  // its own idempotency, its own fee split and its own reconciliation, for a
  // charge that is identical in every respect to the one that already exists.
  // The order id in the return value is the whole of what the browser needs.
  // -------------------------------------------------------------------------

  // A quoted row carries all four of these by construction — quoteEstimate
  // refuses to write one without them. Read out and checked anyway, because
  // the columns are nullable and a row that somehow lost them is a row nothing
  // can safely book: a sentence the customer can act on beats an appointment
  // assembled out of NULLs.
  const price = row.price_cents;
  const duration = row.duration_seconds;
  const startsAt = row.starts_at;
  if (price == null || duration == null || startsAt == null) {
    throw conflict('That estimate is missing its price or its time. '
      + 'Ask them to send a fresh one.', 'estimate_incomplete');
  }
  const currency = row.currency ?? voice.currency;
  const endsAt = startsAt + duration;

  const op = await env.DB.prepare(
    `SELECT business_name, location_mode, stripe_payouts_enabled
       FROM operators WHERE id = ?`,
  ).bind(row.operator_id).first<{
    business_name: string; location_mode: string; stripe_payouts_enabled: number;
  }>();
  if (!op) throw conflict('That business is no longer taking bookings.', 'operator_gone');

  // A BUSINESS WITH NOWHERE TO BE PAID CANNOT SELL, AND THAT INCLUDES HERE.
  //
  // assertPayable in lib/checkout.ts refuses to open a charge for a business
  // whose Stripe payouts are off, and it covers an estimate-born order without
  // any change — the order_item carries an operator_id, so the same LEFT JOIN
  // finds the same flag. That gate is real and it stays.
  //
  // It is simply the wrong place to find out. By the time the card form is
  // open the appointment exists, the operator's calendar says a job is
  // happening, and the customer has been told their booking is made — and then
  // the only thing left to do with it fails. priceOrder refuses the same
  // business at the door for exactly this reason, and this is that door.
  //
  // The wording names the business, unlike priceOrder's deliberately vague
  // "that opening is no longer listed". The reasoning for the vague version is
  // that a stranger browsing a map has no business knowing about somebody's
  // banking; it does not hold here, where the two of them are already in a
  // conversation and the customer is holding a quote with the name on it. Not
  // saying who would leave them with nobody to chase.
  if (op.stripe_payouts_enabled !== 1) {
    throw conflict(
      `${op.business_name} has not finished setting up payments yet, so we cannot `
      + 'take your money for this. Nothing has been booked or charged. Message them, '
      + 'and they can send the estimate again once it is sorted.',
      'operator_cannot_be_paid');
  }

  // WHO THIS BOOKING IS FOR, when there is any way to know.
  //
  // A conversation started from a profile page belongs to a stranger: a first
  // name and a link, and nothing anybody has proved. A conversation that grew
  // out of a booking belongs to the customer who made it, and `appointment_id`
  // on the thread is that booking — attachBooking points it at the newest one.
  // Reading the order behind it is what lets an estimate accepted inside an
  // existing conversation land on the same account, with the number and the
  // mailbox already proved, so the card form opens with their saved card and
  // the booking shows up in their account rather than orphaned beside it.
  //
  // Every field of it is optional, because the stranger case is the common one
  // and a quote to a stranger must still be bookable.
  const buyer = thread.appointment_id
    ? await env.DB.prepare(
      `SELECT o.customer_account_id, o.phone_e164, o.login_email, o.email
         FROM order_items i JOIN orders o ON o.id = i.order_id
        WHERE i.appointment_id = ?`,
    ).bind(thread.appointment_id).first<{
      customer_account_id: string | null; phone_e164: string | null;
      login_email: string | null; email: string | null;
    }>()
    : null;

  // The no-show ladder, on the one identity anybody has proved. Counted
  // against the address rather than the number for the reason placeOrder gives
  // at the same call: a number typed into a form is a claim, an address that
  // has received a code is a fact. A stranger has neither, and customerStanding
  // answers "nothing known" for an empty string rather than refusing.
  const standing = await customerStanding(env, buyer?.login_email ?? '');
  if (standing.blocked) throw conflict(standing.message!, 'suspended');

  // ONE CLIENT ROW PER PERSON PER BUSINESS, reused when the conversation
  // already has one. A second row for the same person would show the operator
  // two customers with the same first name and split their history in half —
  // and it is the existing row that knows where they live, which is the only
  // address this flow has. An estimate asked from a profile page has none:
  // nobody was ever asked for one, and the two of them arrange it in the
  // conversation. 'pending' rather than 'failed' says exactly that — nobody
  // has looked — where 'failed' would send the operator hunting for a typo in
  // an address that was never typed.
  const existing = thread.client_id
    ? await env.DB.prepare(
      `SELECT id, address_line, postcode, lat, lng FROM clients
        WHERE id = ? AND operator_id = ?`,
    ).bind(thread.client_id, row.operator_id).first<{
      id: string; address_line: string | null; postcode: string | null;
      lat: number | null; lng: number | null;
    }>()
    : null;

  const place: BookingPlace = existing
    ? {
      address_line: existing.address_line, postcode: existing.postcode,
      lat: existing.lat, lng: existing.lng,
    }
    : NOWHERE;
  const clientId = existing?.id ?? newId();

  /**
   * THE OVERLAP RACE, and the only place it can be settled.
   *
   * A quote is a standing offer against a start time, and it can stand for
   * days. In that time the operator takes other work — through a posted
   * opening, a gap offer, or by typing it into their own calendar — and
   * nothing in this product goes back and withdraws a quote because the
   * morning it names has filled up. Only the write that books it can find
   * out, and it has to find out at the moment it writes.
   *
   * Two appointments overlap when each starts before the other ends, which is
   * `a.starts_at < endsAt AND a.ends_at > startsAt`. Anything not cancelled
   * still owns its time — a completed job is time that was used, a no-show is
   * time the operator held and lost — so only 'cancelled' frees it.
   *
   * Checked TWICE, on purpose. The read below catches the ordinary case, which
   * is a slot filled hours or days ago, and turns it into a sentence rather
   * than a bare code. The same condition then rides on every statement of the
   * batch, which is what settles the genuine race: two customers accepting
   * overlapping quotes from the same business in the same instant. A batch is
   * one transaction and SQLite serialises writers, so one of the two sees the
   * other's appointment and writes nothing at all — no order, no half booking,
   * nothing to unpick afterwards.
   *
   * IT EXCLUDES OUR OWN APPOINTMENT BY ID, and that is not a nicety. The
   * appointment this batch inserts overlaps its own window perfectly, so every
   * statement after it — the order line, the receipt, the transcript, the flip
   * itself — would find the hour "taken" and write nothing, leaving an order
   * with no line in it and an acceptance that never happened. Which is exactly
   * what the first run of this code did. The id is therefore minted here,
   * before the guard, and handed to bookingLineWrites rather than made by it.
   */
  const appointmentId = newId();
  const freeSlot =
    `NOT EXISTS (SELECT 1 FROM appointments a
                  WHERE a.operator_id = ? AND a.id <> ? AND a.status <> 'cancelled'
                    AND a.starts_at < ? AND a.ends_at > ?)`;

  const clash = await env.DB.prepare(
    `SELECT 1 AS n FROM appointments
      WHERE operator_id = ? AND status <> 'cancelled'
        AND starts_at < ? AND ends_at > ? LIMIT 1`,
  ).bind(row.operator_id, endsAt, startsAt).first<{ n: number }>();
  if (clash) throw conflict(SLOT_GONE, 'slot_taken');

  const orderId = newId();

  /** Every write below happens only if the estimate is live AND the time is free. */
  const bookable: WriteGuard = {
    sql: `${stillQuoted} AND ${freeSlot}`,
    args: [estimateId, row.operator_id, appointmentId, endsAt, startsAt],
  };

  // The calendar entry, the order line and the receipt, from the one builder
  // every booking on this site goes through.
  //
  // service_id is NULL on all of them and that is the point of an estimate:
  // this job is not on the price list, so there is no service row to name and
  // inventing one would put a made-up entry on the operator's own list. The
  // receipt line carries the description the customer agreed to and the price
  // they agreed to pay for it, which is what a receipt is for.
  //
  // parts_policy 'none' because nothing about parts was quoted. An operator
  // who needs a part for this job raises a parts quote against the order_item
  // exactly as they would on any other booking — see parts.ts.
  const line = bookingLineWrites(env, {
    order_id: orderId,
    operator_id: row.operator_id,
    client_id: clientId,
    // Minted above, because the overlap guard has to be able to exclude it.
    appointment_id: appointmentId,
    // No gap, and that is the whole reason placeOrder could not be called for
    // this: an estimate is a job nobody posted an opening for.
    gap_id: null,
    service_id: null,
    starts_at: startsAt,
    ends_at: endsAt,
    duration_seconds: duration,
    price_cents: price,
    is_mobile: op.location_mode === 'premises' ? 0 : 1,
    place,
    services: [{
      service_id: null,
      name: row.description ?? 'Estimate',
      duration_seconds: duration,
      price_cents: price,
      parts_policy: 'none',
      parts_note: null,
      parts_estimate_low_cents: null,
      parts_estimate_high_cents: null,
    }],
    at: t,
  }, bookable);

  const writes = [
    // Unpaid and 'pending'. No card reference is copied on: nothing in this
    // flow showed the customer a card to agree to, and the embedded form asks
    // for one. A signed-in buyer's saved card still appears in it, because
    // startPayment reaches it through customer_account_id above.
    orderWrite(env, {
      id: orderId,
      account_id: buyer?.customer_account_id ?? null,
      guest_name: thread.guest_name,
      phone: buyer?.phone_e164 ?? null,
      login_email: buyer?.login_email ?? null,
      email: buyer?.email ?? null,
      place,
      currency,
      total_cents: price,
      card: null,
      at: t,
    }, bookable),
  ];

  if (!existing) {
    writes.push(clientWrite(env, {
      id: clientId,
      operator_id: row.operator_id,
      first_name: thread.guest_name,
      place: NOWHERE,
      geocode_status: 'pending',
      default_service_id: null,
      at: t,
    }, bookable));
  }

  writes.push(...line.writes);

  // THE TIME IS NO LONGER FOR SALE, so any opening that covers it stops being
  // sold. A detected gap would sort itself out on the next detection pass —
  // detectGaps recomputes those from the calendar and expires the ones that no
  // longer match free time — but a POSTED opening is not derived from anything
  // and nothing withdraws it. Left alone, an operator who posted Thursday
  // afternoon and also quoted a job inside it would sell the same hours twice,
  // and the second customer would find out on the doorstep.
  //
  // The whole opening goes, not the part of it this job covers. Splitting one
  // is a bigger change than this, and of the two ways to be wrong — sell less
  // than they could, or sell the same hour twice — only the first is
  // recoverable by the operator posting it again.
  writes.push(env.DB.prepare(
    `UPDATE gaps SET status = 'expired', updated_at = ?
      WHERE operator_id = ? AND status IN ('open','offering')
        AND starts_at < ? AND ends_at > ? AND ${bookable.sql}`,
  ).bind(t, row.operator_id, endsAt, startsAt, ...bookable.args));

  writes.push(calendarBumpWrite(env, row.operator_id, t, bookable));

  // Written as the customer, because the customer is who decided, and it says
  // the booking is made AND that it is not paid for — those are two different
  // facts and a transcript that only carries the first is how somebody arrives
  // on the day expecting a job that was never confirmed.
  writes.push(...chatWrites(env, row.thread_id, 'guest',
    `Accepted: ${quoteLine(row, voice)}. It is booked — paying for it confirms it.`,
    t, bookable));

  // LAST, and it is the statement that decides everything above it.
  //
  // The order id is written in the same UPDATE as the status, because they are
  // one fact: the customer said yes AND this is the booking it became. Two
  // statements, or two batches, is how "accepted with no order" gets created
  // in the first place.
  //
  // Its WHERE clause is `stillQuoted` and `freeSlot` said the other way round:
  // the estimate row itself rather than an EXISTS over it. Same two conditions,
  // so this statement and every statement above it agree, and `changes` here is
  // a true answer for the whole batch.
  writes.push(env.DB.prepare(
    `UPDATE estimates
        SET status = 'accepted', order_id = ?, decided_at = ?, updated_at = ?
      WHERE id = ? AND status = 'quoted' AND ${freeSlot}`,
  ).bind(orderId, t, t, estimateId,
    row.operator_id, appointmentId, endsAt, startsAt));

  const res = await env.DB.batch(writes);
  if ((res[res.length - 1]?.meta.changes ?? 0) === 0) {
    // Nothing above it landed either — every statement carried the same two
    // conditions — so there is nothing to unpick, only something to explain.
    // Which of the two failed is worth knowing: "somebody took that time" and
    // "you already answered this" send the customer to different places.
    const after = await env.DB.prepare(
      `SELECT status FROM estimates WHERE id = ?`,
    ).bind(estimateId).first<{ status: EstimateStatus }>();
    throw after?.status === 'quoted'
      ? conflict(SLOT_GONE, 'slot_taken')
      : conflict('That estimate was already answered.', 'estimate_decided');
  }

  // After the batch, never as part of it, and neither of these may undo it:
  // the booking is committed, the customer has been told, and nothing below is
  // worth rolling one back for.
  //
  // attachBooking is what gives the new job the photographs the customer
  // already sent. On an estimate that is the most valuable picture on the
  // whole job — the one a stranger sends to show what they actually want done,
  // taken before there was anything to attach it to — and without this call it
  // would keep a NULL order_item_id for ever and read to every sweep
  // downstream as an idle enquiry with no work behind it.
  //
  // Wrapped, because unlike notify it does not swallow its own failures, and
  // an exception here would hand the customer an error for a booking that
  // exists — which is the one answer guaranteed to make them try again and
  // ask why it says the estimate was already accepted.
  //
  // THE ACCOUNT GOES ON WITH IT, from the same `buyer` row the order above was
  // written against, so a quote accepted inside an existing conversation puts
  // the CONVERSATION on the buyer's account and not only the booking. Without
  // this line the customer would find the new job listed at /account and still
  // have no way back to the thread where they agreed the price — which is the
  // one place the description of the work actually lives.
  //
  // `buyer` is null for a stranger's estimate, because nobody proved anything.
  // attachBooking COALESCEs the column, so passing that null cannot blank an
  // account off a conversation that already had one.
  try {
    await attachBooking(env, row.thread_id, {
      appointment_id: line.appointment_id, client_id: clientId,
      customer_account_id: buyer?.customer_account_id ?? null,
    });
  } catch {
    // Nothing to do about it here. The thread keeps pointing at whatever it
    // pointed at before; the booking, the order and the acceptance all stand.
  }

  await notify(env, row.operator_id, {
    kind: 'chat_message',
    title: `${thread.guest_name} accepted your ${money} estimate`,
    body: row.description,
    // The booking that was just made, not the one the thread used to point at.
    appointment_id: line.appointment_id,
    thread_id: row.thread_id,
    starts_at: startsAt,
  });

  return {
    ...row,
    status: 'accepted',
    decided_at: t,
    updated_at: t,
    order_id: orderId,
    order: { id: orderId, total_cents: price, currency },
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Every estimate in one conversation, newest first.
 *
 * Takes a thread id and no identity, so it is the one function here that
 * checks nothing: both sides' callers reach it through something that has
 * already established who they are — the token on the guest side, the
 * operator-scoped thread lookup on theirs. Do not hand it an id from a
 * request body.
 */
export async function listEstimatesForThread(
  env: Env, threadId: string, limit = DEFAULT_LIMIT,
): Promise<Estimate[]> {
  if (!threadId) return [];
  const capped = Math.min(Math.max(1, Math.floor(limit)), MAX_LIMIT);
  const rows = await env.DB.prepare(
    // rowid, not id: ids are random and created_at only has one-second
    // resolution, so an estimate quoted in the same second it was asked for
    // would otherwise come back in arbitrary order.
    `SELECT ${ESTIMATE_FIELDS} FROM estimates
      WHERE thread_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?`,
  ).bind(threadId, capped).all<Estimate>();
  return rows.results ?? [];
}

/**
 * What the holder of this guest link has asked for and been quoted.
 *
 * An unrecognised link returns an empty list rather than a 404: a stale link
 * showing "nothing here" is a dead end, and a stale link that says "that
 * conversation exists but is not yours" is a way to test tokens.
 */
export async function estimatesForGuest(env: Env, ref: ThreadRef): Promise<Estimate[]> {
  const thread = await threadByToken(env, ref);
  if (!thread) return [];
  return listEstimatesForThread(env, thread.id);
}

/** The operator's estimates, newest first. Scoped by operator_id, always. */
export async function estimatesForOperator(
  env: Env, operatorId: string,
  opts: { status?: EstimateStatus; thread_id?: string; limit?: number } = {},
): Promise<Estimate[]> {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);

  // Written out per shape rather than assembled from string fragments. Three
  // near-identical statements are duller to read than one built query and far
  // harder to accidentally leave a tenant filter out of.
  if (opts.thread_id) {
    const rows = await env.DB.prepare(
      `SELECT ${ESTIMATE_FIELDS} FROM estimates
        WHERE operator_id = ? AND thread_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).bind(operatorId, opts.thread_id, limit).all<Estimate>();
    return rows.results ?? [];
  }
  if (opts.status) {
    const rows = await env.DB.prepare(
      `SELECT ${ESTIMATE_FIELDS} FROM estimates
        WHERE operator_id = ? AND status = ?
        ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).bind(operatorId, opts.status, limit).all<Estimate>();
    return rows.results ?? [];
  }
  const rows = await env.DB.prepare(
    `SELECT ${ESTIMATE_FIELDS} FROM estimates
      WHERE operator_id = ?
      ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  ).bind(operatorId, limit).all<Estimate>();
  return rows.results ?? [];
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/**
 * Expires quotes whose start time went past unanswered. Runs on the existing cron.
 *
 * A quote left 'quoted' forever is a standing offer to book a morning that has
 * already happened, and the operator has almost certainly given that time to
 * somebody else. Expiring it costs them one tap to re-send and removes a whole
 * class of "I accepted that, where are you".
 *
 * Only 'quoted' rows are swept. An 'asked' row has no time and no number in it
 * — nothing can be booked or charged on one — so expiring it would do nothing
 * except erase the evidence that a customer asked and was never answered.
 *
 * Nothing is written into the transcript here. A cron posting "this expired"
 * into conversations at four in the morning is noise, and both screens already
 * read the status off the row.
 */
export async function expireEstimates(env: Env): Promise<number> {
  const t = now();
  const res = await env.DB.prepare(
    // COALESCE, because expires_at is only set when the quote is sent and a
    // row written by anything else may carry only a start time. The job
    // starting is the deadline either way.
    `UPDATE estimates SET status = 'expired', updated_at = ?
      WHERE status = 'quoted'
        AND COALESCE(expires_at, starts_at) IS NOT NULL
        AND COALESCE(expires_at, starts_at) <= ?`,
  ).bind(t, t).run();
  return res.meta.changes ?? 0;
}

/** Re-exported so callers importing from here do not reach past this module. */
export { threadForOperator };
