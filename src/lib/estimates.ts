import type { Env } from '../types';
import { threadByToken, threadForOperator } from './chat';
import { formatMoney, localeFor } from './countries';
import { notify } from './feed';
import { redactContact } from './redact';
import { formatTimeRange } from './tz';
import { badRequest, conflict, newId, notFound, now } from './util';

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
 *   accepted   the customer taps yes and it becomes an ordinary booking,
 *              paid up front, with a start code and photos like any other
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
/** The operator's answer is a line the customer reads on a phone, not a scope of work. */
const MAX_DESCRIPTION_CHARS = 300;

/**
 * Typo guards, not policy. Nobody quotes a bespoke domestic job at fifty
 * thousand, and a zero-price "estimate" is a message, not something to accept.
 */
const MIN_PRICE_CENTS = 1;
const MAX_PRICE_CENTS = 50_000_00;

/** Fifteen minutes to twelve hours. Outside that somebody has typed seconds as minutes. */
const MIN_DURATION_SECONDS = 15 * 60;
const MAX_DURATION_SECONDS = 12 * 60 * 60;

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
  /** The booking it became. Written by the payment step, never here. See the seam below. */
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
 */
function chatWrites(
  env: Env, threadId: string, sender: 'guest' | 'operator', body: string, t: number,
) {
  const column = sender === 'guest' ? 'operator_unread' : 'guest_unread';
  return [
    env.DB.prepare(
      `INSERT INTO chat_messages (id, thread_id, sender, body, created_at)
       VALUES (?,?,?,?,?)`,
    ).bind(newId(), threadId, sender, body, t),
    env.DB.prepare(
      `UPDATE threads SET last_message_at = ?, ${column} = ${column} + 1, updated_at = ?
        WHERE id = ?`,
    ).bind(t, t, threadId),
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
  env: Env, rawToken: string, requestText: string,
): Promise<Estimate> {
  const thread = await threadByToken(env, rawToken);
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
    body: request.slice(0, 140),
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
    (input?.description ?? '').trim().slice(0, MAX_DESCRIPTION_CHARS),
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
  env: Env, rawToken: string, estimateId: string, decision: 'accepted' | 'declined',
): Promise<Estimate> {
  if (decision !== 'accepted' && decision !== 'declined') {
    throw badRequest('Accept it or decline it.', 'bad_decision');
  }

  const thread = await threadByToken(env, rawToken);
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

  if (decision === 'accepted') {
    // -------------------------------------------------------------------
    // PAYMENT SEAM — where an accepted estimate becomes a booking.
    //
    // NOT WIRED HERE ON PURPOSE. This function's whole job is to record,
    // exactly once, that the customer said yes to the numbers on `row`.
    // Turning that into money and a calendar entry belongs on this line,
    // before the batch below, and it has to do three things:
    //
    //   1. charge exactly `row.price_cents` in `row.currency` — the figure
    //      on the row the customer just tapped, never a recalculated one,
    //      never the operator's current price list;
    //   2. create the appointment and the order for `row.starts_at` +
    //      `row.duration_seconds`, so this lands in the same tables as
    //      every other booking and inherits start code, photos and
    //      settlement without a second code path;
    //   3. write the new order's id into `order_id` in the SAME batch as
    //      the status change, so an accepted estimate with order_id still
    //      NULL means exactly one thing: the customer said yes and the
    //      booking did not get made. That is the report somebody will have
    //      to work through by hand, and it must be findable.
    //
    // placeOrder in orders.ts cannot be called as-is: it books a POSTED
    // gap, and the point of an estimate is that no gap was posted. The
    // overlap check against the operator's existing appointments belongs
    // with that wiring too — this row was quoted for a time that may since
    // have been filled, and only the booking write can settle that race.
    //
    // Until then the acceptance is recorded and no money moves.
    // -------------------------------------------------------------------
  }

  const body = decision === 'accepted'
    ? `Accepted: ${row.description} — ${money}.`
    : `Declined: ${row.description} — ${money}.`;

  const res = await env.DB.batch([
    env.DB.prepare(
      `UPDATE estimates SET status = ?, decided_at = ?, updated_at = ?
        WHERE id = ? AND status = 'quoted'`,
    ).bind(decision, t, t, estimateId),
    // Written as the customer, because the customer is who decided. An
    // operator scrolling back months later is reading a conversation, and
    // "you said yes on the 3rd" has to be visible inside it.
    ...chatWrites(env, row.thread_id, 'guest', body, t),
  ]);
  if ((res[0]?.meta.changes ?? 0) === 0) {
    throw conflict('That estimate was already answered.', 'estimate_decided');
  }

  // After the batch. A notification that will not insert must never undo a
  // decision the customer has already made.
  await notify(env, row.operator_id, {
    kind: 'chat_message',
    title: decision === 'accepted'
      ? `${thread.guest_name} accepted your ${money} estimate`
      : `${thread.guest_name} declined the ${money} estimate`,
    body: row.description,
    appointment_id: thread.appointment_id,
    thread_id: row.thread_id,
    starts_at: row.starts_at,
  });

  return { ...row, status: decision, decided_at: t, updated_at: t };
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
export async function estimatesForGuest(env: Env, rawToken: string): Promise<Estimate[]> {
  const thread = await threadByToken(env, rawToken);
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
