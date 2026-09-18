import type { Env } from '../types';
import { threadByToken, type ThreadRef } from './chat';
import { sweepRateLimits } from './ratelimit';
import { claimPhoneHash, pepperedHash } from './redact';
import { DAY, HttpError, badRequest, newId, notFound, now } from './util';

/**
 * Getting rid of things.
 *
 * Until this file there was no way to delete anything in this product. Not a
 * customer asking to be erased, not an operator closing their account, and not
 * the large amount of data that stops having a reason to exist about a week
 * after the job it belonged to. Everything that arrived, stayed — home
 * addresses, coordinates accurate to a doorstep, phone numbers, email
 * addresses, photographs of the inside of people's houses, and a running
 * record of where a self-employed person drove.
 *
 * Three separate jobs live here, and they are separate on purpose:
 *
 *   ERASURE      a customer asks for their personal data to be removed. Real
 *                deletion of the personal parts, immediately, on their say-so,
 *                proved either by the secret link in their confirmation or by
 *                the account that link's booking now belongs to. Both doors
 *                run the same code and remove the same rows.
 *   CLOSURE      an operator closes their account. The personal columns on
 *                their row are emptied and their customers' data goes with
 *                them; the settled financial records stay, describing a
 *                business that no longer exists rather than a person.
 *   SWEEPS       the cron, deleting what nobody asked about because it simply
 *                has no reason to still be here.
 *
 * WHAT IS KEPT, AND WHY. Money that has already moved is not erasable: an
 * invoice, a refund and a fee are records of a transaction between two
 * parties, and a marketplace that can be talked into deleting its own books is
 * a marketplace that cannot answer a chargeback or a tax question. So an
 * order, an order item and a lead fee survive both erasure and closure — with
 * every column that identifies a PERSON emptied. What remains is an amount, a
 * currency, a date and the business it was with.
 *
 * The other deliberate retention is a live safety record. A customer with an
 * active suspension or ban keeps their customer_standing row through an
 * erasure, because the alternative is that "delete my data" is also the button
 * that clears a ban, and the ladder in standing.ts stops meaning anything the
 * day somebody notices. It is the narrowest exception this file makes: the row
 * is deleted the moment the sanction lapses, and a customer with no sanction
 * has no row to keep.
 */

/**
 * How long each kind of thing lives when nobody asks.
 *
 * Every one of these is a judgement and they are gathered here so they can be
 * argued with in one place rather than found in six queries. The rule used to
 * pick them: how long after the job could this data still answer a question
 * somebody is entitled to ask? Past that it is not evidence, it is a liability
 * with a date on it.
 *
 * THIS OBJECT IS A LIST OF PUBLISHED PROMISES, NOT A DRAWER FOR WINDOWS, and
 * that is worth knowing before adding to it. Every entry has a matching row in
 * the retention table on /privacy, and test/two-trees.test.ts pins the two to
 * each other one for one so that a sentence telling a stranger how long their
 * address is kept can never outlive the constant behind it. A sweep of
 * something that is not a person's data — `sweepRateLimits`, or
 * `sweepStripeEvents` and its STRIPE_EVENT_DAYS below — keeps its window
 * beside itself instead. Putting one of those in here does not fail quietly;
 * it fails by demanding a row on a privacy page about something no reader has
 * any stake in.
 */
export const RETENTION = {
  /**
   * A conversation that never became a booking. Thirty days.
   *
   * Somebody asked a business a question and did not book. Neither side needs
   * that in April, and it carries a stranger's name and whatever they typed
   * about where they live.
   */
  THREAD_NO_BOOKING_DAYS: 30,

  /**
   * A conversation attached to a job that is over. A hundred and eighty days.
   *
   * This is the dispute window, and it is set by the longest thing that can
   * still arrive: a card chargeback, which most schemes allow for 120 days and
   * some for longer. Deleting the conversation before that leaves the operator
   * unable to show what was agreed at exactly the moment they need to.
   */
  THREAD_AFTER_JOB_DAYS: 180,

  /**
   * An instant request nobody accepted. Seven days.
   *
   * The row holds a name, a phone number, a street address and coordinates,
   * for a job that never happened, on a five-minute fuse. Its whole useful
   * life is those five minutes; a week is generous margin for the customer's
   * own page to still explain what happened.
   */
  INSTANT_REQUEST_DEAD_DAYS: 7,
  /** One that became a booking: the order holds it now, so this copy goes. */
  INSTANT_REQUEST_ACCEPTED_DAYS: 30,

  /** A watch the customer switched off. Ninety days, then the postcode goes. */
  WATCH_INACTIVE_DAYS: 90,
  /** A watch that has never matched anything in a year is a stale postcode. */
  WATCH_UNUSED_DAYS: 365,

  /**
   * Photographs of a job. Twenty-one days after it ended, unless somebody has
   * raised a claim about that booking.
   *
   * THIS WAS NINETY DAYS, AND NINETY WAS THREE MISTAKES AT ONCE.
   *
   * THE FIRST IS WHAT IT COST. The photo store is a Workers KV namespace with
   * one gigabyte for the WHOLE ACCOUNT — standing rather than monthly, shared
   * with anything else this account ever puts in KV, see photostore.ts. At the
   * upload caps that is a low-hundreds number of photographs for the entire
   * product, and nothing here sits behind a card, so a full store is not a
   * bigger bill: it is the next upload failing, for everybody, with no way to
   * pay to make it stop. Ninety days meant the store was carrying a quarter of
   * a year of every job on the site whether or not one of them was ever
   * argued about, and the argument is the only reason any of them is there.
   *
   * THE SECOND IS THAT THE NUMBER WAS NEVER DERIVED FROM ANYTHING. The comment
   * that used to sit here said ninety days was "past every window in this
   * codebase for raising a dispute". That is true, and it is not an argument
   * for ninety — it is an argument for the smallest number that is also past
   * them. Read the windows and none of them is measured in months:
   *
   *   - `payoutDueAt` in checkout.ts sends the business its money at
   *     `ends_at + WATCH_TAIL_SECONDS`, which is three hours after the slot.
   *     After that `refundItem` can only reach the platform's own fee, because
   *     the rest is in somebody's bank account and a Transfer does not come
   *     back. The window in which the money on a booking is still fully
   *     reachable closes that afternoon.
   *   - `holdStatement` in settlement.ts takes the MINIMUM of the seven-day
   *     ceiling and `starts_at + WATCH_TAIL_SECONDS`, so no frozen payment
   *     outlives the afternoon of the job either, whatever
   *     HOLD_CEILING_SECONDS says about cancellations booked far ahead.
   *
   * Every question this product asks ITSELF about a booking therefore has an
   * answer within three hours of the slot. What this window is buying is not
   * machine time, it is a person's: `reportNoShow` refuses a report only
   * before the job has finished and has no upper bound at all, so the door a
   * human uses never closes on its own and the number here is the budget for
   * somebody noticing that something was wrong and saying so.
   *
   * Three weeks is a fortnight away from home plus a week to get round to it,
   * and it is three times the seven days this product is already willing to
   * wait for a person to answer a question about a booking. Two weeks would
   * miss somebody who was away for a fortnight, which is the ordinary reason a
   * complaint is late. A month is the round number that gets picked because it
   * is round, and then defended afterwards.
   *
   * THE THIRD IS THE ONE THIS CHANGE IS REALLY ABOUT. Nothing anywhere knew
   * whether a booking was disputed, so the timer ran identically on a job
   * nobody has ever mentioned and on a job with an open no-show report against
   * it. Shortening a blind window would have made that strictly worse. See
   * CLAIM_PHOTO_DAYS and `claimHoldsPhotos` below: a booking with a claim on
   * it is off this clock entirely until the claim is decided.
   *
   * WHAT THIS DELIBERATELY DOES NOT COVER, because the privacy page says it
   * too and neither should be quieter than the other. A card chargeback is the
   * longest thing that can still arrive, and it is the whole reason a finished
   * job's CONVERSATION is kept for THREAD_AFTER_JOB_DAYS. Nothing in this
   * codebase records one: there is no dispute table, and the Stripe webhook
   * handles no `charge.dispute.*` event, so a chargeback cannot make the test
   * below true no matter how long this window is. What answers "what was
   * agreed" is the transcript rather than a photograph of a hallway, and the
   * transcript is kept. Holding every picture on the site for six months
   * against a case this product cannot see was the trade ninety days was
   * making by accident, on a store that holds a few hundred pictures in total.
   *
   * A photo the customer chose to publish on their own review is not swept.
   * That one they made public on purpose, and it is theirs to unpublish.
   */
  JOB_PHOTO_DAYS: 21,

  /**
   * Photographs of a booking somebody has raised a claim about. Thirty days
   * after the claim is settled — and not one day before it is settled,
   * however old the job.
   *
   * THE FAILURE THIS EXISTS TO STOP is the only one in this file that takes
   * money off a real person. `sweepJobPhotos` deleted on age alone, and no row
   * anywhere in this database said whether a booking was disputed, so an open
   * no-show report, a payment frozen while we ask whether the work happened,
   * and a job nobody has ever mentioned were all the same row to the sweep. An
   * open report has no deadline — it sits in the admin queue until a person
   * looks at it, and there is no admin UI yet, so "until a person looks at it"
   * is as long as it is — and the pictures it turns on were being deleted
   * underneath it on a ninety-day timer. Deleting a disputed job's evidence on
   * a clock does not leave the dispute undecided. It decides it, in favour of
   * whichever side is lying.
   *
   * WHY THIRTY, RATHER THAN A MARGIN PICKED FOR FEELING GENEROUS. What a
   * settled claim produces is a consequence, and the evidence has to outlast
   * the consequence, because the consequence is the thing somebody appeals.
   * The consequence here is the no-show ladder in standing.ts: `STRIKE_DAYS`
   * is [3, 7, 30], so the longest suspension a confirmed report can impose is
   * thirty days, and past the end of that list it stops being a suspension and
   * becomes a ban. Thirty days after the decision therefore means that
   * somebody serving the longest suspension this product hands out can have
   * the photographs that produced it looked at again for the whole of it. A
   * shorter margin means somebody appealing on the last day of their
   * suspension finds the evidence gone; a longer one is keeping pictures of
   * the inside of a house against an appeal nobody can still be making.
   *
   * A BAN IS DELIBERATELY NOT TREATED AS "NEVER DELETE". It has no end date by
   * design — migration 0023 — so making it hold the photographs would turn
   * this into permanent storage for exactly the bookings most likely to have
   * photographs on them, which is the ninety-day problem again with a worse
   * ending on a one-gigabyte store. The record that has to outlive the
   * pictures is the ban itself, and it does: `sweepStanding` keeps
   * `customer_standing`, `no_show_reports` and `suspensions` for
   * STANDING_DAYS and keeps a ban through it.
   */
  CLAIM_PHOTO_DAYS: 30,

  /**
   * The exact address and coordinates of a finished job. Ninety days.
   *
   * The sharpest data in the product. A latitude and longitude to five decimal
   * places is a doorstep, and after the van has been and gone there is no
   * question it answers. The postcode is kept — it is the coarse geography the
   * business needs to know where it works — and the street line and the
   * coordinates are removed.
   */
  JOB_LOCATION_DAYS: 90,

  /** Feed rows, which carry FEED_EXCERPT_CHARS of a chat message. */
  NOTIFICATION_DAYS: 90,

  /** The SMS/device log, whose to_address column is a phone number. */
  MESSAGE_LOG_DAYS: 180,

  /** A lapsed customer standing record. Two years, then the address goes. */
  STANDING_DAYS: 730,

  /**
   * What a customer wrote when the van that turned up was not the right one.
   * A hundred and eighty days.
   *
   * `order_items.vehicle_reported_note` is five hundred characters typed by a
   * person standing at their own front door with a stranger on it — see
   * reportVehicle in startcode.ts — and in practice it is a description of
   * whoever arrived and of what happened on the doorstep. It had no sweep of
   * any kind and no erasure step: it was the one column on that table nothing
   * ever cleared apart from start_code, so a note written the week the product
   * launched was still there, unreachable from every customer-facing screen
   * and readable by an admin, forever.
   *
   * The clock is the SAME as a finished job's conversation, because that is
   * what this is a part of: it is evidence in a dispute about one booking, and
   * it stops being evidence on the same day the transcript beside it does. Two
   * numbers here would be two answers to one question.
   */
  VEHICLE_REPORT_DAYS: 180,

  /**
   * A request for an estimate. A hundred and eighty days.
   *
   * `estimates.request` is what the customer asked for in their own words —
   * migration 0029 says so at the column — which in practice is a description
   * of a household and its problem, typed by a stranger. It sits on a
   * thread_id that is not a foreign key, so when sweepThreads deleted the
   * conversation the estimate stayed behind with nothing pointing at it and no
   * sweep of its own: the one row in this product that outlived the thing it
   * belonged to. The clock is deliberately the SAME as a finished job's
   * conversation, because that is what an estimate is part of, and two numbers
   * would be two answers to one question.
   */
  ESTIMATE_DAYS: 180,
} as const;

/** How many photographs one cron tick will delete from the photo store. */
const PHOTO_SWEEP_BATCH = 200;

/**
 * A Stripe event id we have already acted on. Thirty days.
 *
 * DELIBERATELY NOT IN `RETENTION` ABOVE, AND THAT IS THE FIRST THING TO SAY
 * ABOUT IT, because the obvious home for a number ending in _DAYS in this file
 * is the obvious home. `RETENTION` is not a bag of windows; it is the set of
 * PUBLISHED PROMISES. Every entry in it has a matching row in the retention
 * table on /privacy, test/two-trees.test.ts pins the two to each other one for
 * one, and the reason it does is that a sentence telling a stranger how long
 * their address is kept must never be able to outlive the constant behind it.
 * `stripe_events` holds no personal data — an opaque Stripe-side identifier
 * ('evt_...') and the second it arrived, with migration 0050 explicit that the
 * event BODY (names, billing addresses, email addresses, amounts) is
 * deliberately not stored — so there is nothing here to promise anybody, and a
 * row on a privacy table about a message Stripe sent us would make that table
 * harder to read without making it truer.
 *
 * This is where `sweepRateLimits` keeps its own window too: beside the sweep,
 * in the file that owns it, rather than in the published list. Housekeeping,
 * not privacy — and in no erasure path for the same reason, since the row is
 * about a message we were sent rather than about a person.
 *
 * WHAT THE NUMBER IS ACTUALLY PROTECTING, which is why it is not small. That
 * row is the entire replay defence on /webhooks/stripe. The signature proves
 * Stripe sent these bytes; it does not prove this is the first time we have
 * been handed them, and two of the three arms of that switch are not
 * idempotent — markPaymentFailed lands a stale decline on an order paid since
 * with another card, and syncConnectAccount replays a stale "payouts disabled"
 * over an operator who is payable again. Deleting the id is therefore not
 * tidying: it makes the very next delivery of that event look like a first one
 * and runs the handler again. The age is a FLOOR before it is anything else.
 *
 * TWO WINDOWS HAVE TO BE CLEARED, and thirty days clears both with room that is
 * not close. The first is the signature tolerance — STRIPE_TOLERANCE_SECONDS in
 * ./payments.ts is 300, so a captured copy of a real event still verifies for
 * five minutes after its timestamp, and thirty days is four orders of magnitude
 * past that. The second is the sender's own retry schedule: Stripe re-sends
 * anything that does not answer 2xx, and the webhook handler and migration 0050
 * both describe that as running for days. Days is the unit that matters, so the
 * number is set in the unit above it. A week would very likely do; a month
 * costs one extra row per event on a table that gets one row per payment event,
 * which is nothing, and buys the margin that means nobody has to be right about
 * Stripe's exact backoff curve for this to be safe.
 *
 * DO NOT LOWER IT TO A FEW DAYS TO SAVE SPACE. There is no space worth saving
 * here, and the failure it would buy is silent: a retry arriving an hour after
 * its id was swept is processed a second time, and what that looks like
 * downstream is a business Stripe is perfectly happy with quietly going
 * unpayable. That is the exact hole migration 0050 exists to close.
 */
export const STRIPE_EVENT_DAYS = 30;

/** Peppered so a hash in the erasure receipt is useless in a stolen dump. */
const subjectHash = pepperedHash;

export interface SweepResult {
  /** Rows removed or scrubbed, by the sweep that did it. */
  [pass: string]: number;
}

const changes = (r: { meta?: { changes?: number } } | undefined): number =>
  r?.meta?.changes ?? 0;

// ---------------------------------------------------------------------------
// The sweeps
// ---------------------------------------------------------------------------

/**
 * Conversations with nothing left to say.
 *
 * chat_messages cascades off threads, so deleting the thread takes the
 * transcript with it — which is the point: the transcript is where a gate
 * code, a "the spare key is under the pot" and a description of somebody's
 * house actually live.
 *
 * Two passes because there are two different clocks. A thread that never
 * became a booking is measured from the last thing anybody said; a thread
 * attached to a job is measured from the end of the job, because a
 * conversation that went quiet in January about work done in June is not
 * stale.
 *
 * A JOB NOBODY MARKED DONE IS STILL A JOB THAT IS OVER, and until the second
 * arm of the status test below existed this sweep could not see one. Only a
 * manual tap sets 'completed'; nothing in the cron does. So a sole trader who
 * stops tapping it — because they are busy, or because they have stopped using
 * the app — left every customer's whole transcript in the database
 * permanently, gate codes and "the key is under the pot" included. The clock is
 * `ends_at` either way, which is the honest reading: the appointment's own end
 * time is when the work was due to be over, whatever anybody remembered to tap
 * afterwards.
 */
export async function sweepThreads(env: Env): Promise<number> {
  const t = now();

  const orphaned = await env.DB.prepare(
    `DELETE FROM threads
      WHERE last_message_at < ?
        AND (appointment_id IS NULL
             OR NOT EXISTS (SELECT 1 FROM appointments a WHERE a.id = threads.appointment_id))`,
  ).bind(t - RETENTION.THREAD_NO_BOOKING_DAYS * DAY).run();

  const finished = await env.DB.prepare(
    `DELETE FROM threads
      WHERE appointment_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM appointments a
                     WHERE a.id = threads.appointment_id
                       AND ((a.status IN ('completed','cancelled','no_show') AND a.ends_at < ?)
                            OR (a.status = 'scheduled' AND a.ends_at < ?)))`,
  ).bind(t - RETENTION.THREAD_AFTER_JOB_DAYS * DAY,
    t - RETENTION.THREAD_AFTER_JOB_DAYS * DAY).run();

  return changes(orphaned) + changes(finished);
}

/**
 * Instant requests that went nowhere, and ones that became bookings.
 *
 * Pending rows are never touched however old they look: expiry is decided on
 * read in online.ts, and a sweep that deleted one out from under a customer
 * polling their own page would turn "nobody answered" into "that request does
 * not exist", which reads as the site losing their booking.
 */
export async function sweepInstantRequests(env: Env): Promise<number> {
  const t = now();
  const dead = await env.DB.prepare(
    `DELETE FROM instant_requests
      WHERE status IN ('expired','declined','cancelled') AND created_at < ?`,
  ).bind(t - RETENTION.INSTANT_REQUEST_DEAD_DAYS * DAY).run();

  const accepted = await env.DB.prepare(
    `DELETE FROM instant_requests WHERE status = 'accepted' AND created_at < ?`,
  ).bind(t - RETENTION.INSTANT_REQUEST_ACCEPTED_DAYS * DAY).run();

  return changes(dead) + changes(accepted);
}

/**
 * Standing alerts nobody is using.
 *
 * A watch is a home postcode with coordinates next to a browser push endpoint.
 * Migration 0013 keeps a switched-off watch rather than deleting it, so an
 * accidental unsubscribe is one tap to undo — that reasoning holds for a
 * fortnight and stops holding after three months, at which point it is a
 * stranger's home location kept against a decision they already made.
 *
 * push_subscriptions and watch_hits both cascade off the watch.
 */
export async function sweepWatches(env: Env): Promise<number> {
  const t = now();
  const res = await env.DB.prepare(
    `DELETE FROM watches
      WHERE (active = 0 AND updated_at < ?)
         OR (active = 1 AND last_notified_at IS NULL AND created_at < ?)`,
  ).bind(t - RETENTION.WATCH_INACTIVE_DAYS * DAY,
    t - RETENTION.WATCH_UNUSED_DAYS * DAY).run();
  return changes(res);
}

/**
 * Whether this booking is one somebody is arguing about, and so has to keep
 * its photographs past the ordinary window.
 *
 * ONE PREDICATE, USED BY BOTH PHOTO SWEEPS, and that is the point of it being
 * a function rather than two WHERE clauses that happen to look alike today.
 * A staged before/after picture on a booking and a photograph sent in the
 * conversation about the same booking are evidence about the same afternoon.
 * Two copies of this rule would disagree the first time one of them gained a
 * case, and the failure would be silent: half the evidence for one dispute
 * deleted and half kept.
 *
 * Takes the alias of an `order_items` row and returns SQL that is true when
 * the pictures must stay. It binds the CLAIM CUTOFF twice, in order — the
 * moment before which a settled claim stops holding anything.
 *
 * ---------------------------------------------------------------------------
 * WHAT A CLAIM IS HERE, AND WHY IT IS THESE THREE THINGS
 * ---------------------------------------------------------------------------
 * A claim is a row, attached to one booking, in which somebody has said that
 * what happened on that booking is not what should have happened — and which
 * a person still has to decide, or has only just decided. All three of the
 * following have that shape, and each has a moment it is DECIDED, which is
 * what lets the clock start again afterwards. A "claim" with no decided state
 * is not claim-awareness, it is permanent storage wearing a predicate, and
 * that is the thing this whole change exists to get away from.
 *
 *   1. A NO-SHOW REPORT AGAINST THE BOOKING. `no_show_reports.order_item_id`,
 *      filed by either side — see reportNoShow in standing.ts — saying the
 *      other one did not turn up. This is the plainest claim in the product
 *      and the photographs are literally what answers it: migration 0025
 *      created job_photos as before/during/after proof precisely so "a dispute
 *      can be settled on pictures rather than on two accounts of the same
 *      afternoon". It is unresolved while `status = 'open'`, which is where a
 *      report sits until a person confirms or rejects it, and resolved at
 *      `decided_at` — falling back to `updated_at`, because a report decided
 *      by some future path that forgets to stamp one must not read as resolved
 *      at the epoch and lose its evidence immediately.
 *
 *   2. THE BOOKING'S MONEY FROZEN WHILE WE ASK WHETHER THE WORK HAPPENED,
 *      `settlement = 'held'`. This is the platform itself recording that what
 *      happened on this booking is in question: the cancellation is in, both
 *      sides are frozen, and the customer has been asked the one question in
 *      migration 0025. `photos_after` — pictures of the job uploaded after a
 *      cancellation — is one of the bypass signals that answers it, so the
 *      pictures are not incidental to this state, they are its evidence. It
 *      resolves the moment the settlement leaves 'held', at `settled_at`,
 *      either because the customer answered or because settleExpiredHolds
 *      called it.
 *
 *   3. THAT QUESTION ANSWERED AGAINST THE CUSTOMER, `settlement = 'withheld'`.
 *      The one outcome in this product where somebody is refused money they
 *      were told they were owed, on a finding about what happened at their own
 *      address — either they said the work was done anyway, or a van was seen
 *      there after they cancelled. It is decided the instant it is written, so
 *      this arm is not a wait, it is the margin: the pictures that produced
 *      the finding stay for CLAIM_PHOTO_DAYS after it.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS CHECKED AND IS NOT A CLAIM
 * ---------------------------------------------------------------------------
 * A REFUND ON ITS OWN IS NOT ONE, and this is the candidate most likely to be
 * added back by somebody reading migration 0043 and reasonably assuming money
 * going backwards means an argument. It does not. The tiers in 0024 are
 * arithmetic applied to a published policy — full outside 48 hours, three
 * quarters, a quarter, nothing — and a customer cancelling three days out and
 * getting all their money back is not disputing anything. `refund_cents` is
 * written on very nearly every cancellation, so treating its presence as a
 * claim would keep the photographs of every cancelled booking on the site and
 * the constant would stop meaning anything.
 *
 * `refund_cents > 0 AND refund_id IS NULL` looks like the sharper version of
 * that — the customer is owed and has not been paid — and it is a trap. That
 * condition is PERMANENTLY true for a line that was never charged:
 * `refundItem` answers 'not_paid' and never writes a refund id, so nothing
 * ever clears it, and every such booking would keep its pictures forever.
 * What is genuinely a dispute inside the refund machinery is the HOLD and the
 * REFUSAL, and those are arms 2 and 3 above, both of which have a settled_at.
 *
 * `admin_actions` IS NOT ONE EITHER, and it cannot be: it deliberately does
 * not name a booking. `subject_ref` holds a report id on the two writes and
 * nothing at all on the reads, and `subject_phone` is stored as a peppered
 * digest — the whole design in audit.ts is that the audit trail must not
 * become a second copy of the data it is about. There is no join from an admin
 * action back to an order item, by intent, and the report it points at is
 * already arm 1. Reading the log here would add no case and would only be a
 * way to get the join wrong.
 *
 * `bypass_flags` IS THE CLOSEST CALL OF ALL OF THEM, and the reason it is out
 * is worth writing down because the argument for it is good. `photos_after` is
 * a flag about these very photographs, and `confirmed_then_cancelled` is
 * described in 0025 as the strongest signal in the system. But a flag is
 * explicitly an observation and never a verdict, nothing acts on one alone,
 * and — decisively — it has no decided state and no sweep anywhere in this
 * codebase. A booking with a flag on it would keep its photographs for ever,
 * which is not a stricter version of this rule, it is the abandonment of it.
 * If flags ever gain a decision, they belong here and the case is already
 * made.
 *
 * A VEHICLE REPORT IS NOT ONE, for the same reason: `vehicle_reported_at` is a
 * customer saying the van on their doorstep was not the one in the app, it
 * shows in the admin flags queue, and it has no decided state at all — nothing
 * closes one, so it could never start a clock. It is also a report about WHO
 * ARRIVED rather than a claim about whether the work happened, and the words
 * themselves are already kept for VEHICLE_REPORT_DAYS by sweepVehicleReports.
 *
 * AND `public_claims` IS NOT ONE, despite the name. A row there is somebody
 * having claimed an OPENING — a booking — and it has nothing to do with
 * disputes. It is in this list only so that the next person to grep for
 * "claim" in this repository finds the answer here rather than assuming.
 */
const claimHoldsPhotos = (item: string): string => `(
        EXISTS (SELECT 1 FROM no_show_reports r
                 WHERE r.order_item_id = ${item}.id
                   AND (r.status = 'open'
                        OR COALESCE(r.decided_at, r.updated_at) >= ?))
        OR ${item}.settlement = 'held'
        OR (${item}.settlement = 'withheld'
            AND COALESCE(${item}.settled_at, ${item}.ends_at) >= ?)
      )`;

/**
 * The stored bytes, and then the rows, for one batch of photographs.
 *
 * THE ORDER IS THE WHOLE FUNCTION. The bytes go first because the row is what
 * proves they should exist: a failure part-way through leaves a photo-store
 * key with no row, which the next tick cannot find but which goes on eating
 * the account's 1 GB of Workers KV, and that is strictly better than a row
 * pointing at nothing, which shows a customer a broken photo in a dispute.
 *
 * NOTHING AT ALL WHEN THERE IS NO PHOTO STORE, rather than the rows.
 *
 * The stored-bytes delete was guarded on the binding and the row delete
 * beneath it was not, so a deployment that had once had the binding and then
 * lost it would have the sweep delete the only record of where the photograph
 * is — the key — and report success. The photographs, which are the inside of
 * somebody's house, would then sit in the store forever with nothing left able
 * to name them. Doing nothing leaves the rows for the next tick, which is the
 * one outcome that is still recoverable.
 *
 * `delete` is one of the two calls that read identically on KV and on R2, so
 * this loop did not change when the store did — only what it is deleting from.
 * It matters more than it used to: the store is a KV namespace sharing 1 GB
 * with the whole account (see lib/photostore.ts), so these sweeps are not
 * tidying, they are what keeps uploads working at all.
 *
 * SHARED BY BOTH PHOTO SWEEPS deliberately. This guard and this ordering are
 * the two things in the photo path that are easy to get subtly wrong and
 * impossible to notice afterwards, and a second copy of them written for
 * message_photos would be the copy that drifts.
 */
async function dropPhotos(
  env: Env, table: string, found: Array<{ id: string; key: string }>,
): Promise<number> {
  if (found.length === 0) return 0;
  if (!env.PHOTOS) return 0;

  for (const p of found) {
    await env.PHOTOS.delete(p.key).catch(() => {});
  }

  const holes = found.map(() => '?').join(',');
  const res = await env.DB.prepare(
    `DELETE FROM ${table} WHERE id IN (${holes})`,
  ).bind(...found.map((p) => p.id)).run();

  return changes(res);
}

/**
 * Staged job photographs past the window in which anybody could still be
 * arguing — unless somebody actually is.
 *
 * Two clocks have to be past, not one: the photograph's own age and the
 * booking's end time. They are usually the same week and they are not always,
 * because a picture uploaded AFTER a cancellation is the whole point of the
 * `photos_after` signal, and a file that arrived last night should not be
 * deleted tonight because the job it names was in the spring.
 *
 * The claim test is what is new here. Until it existed this sweep could not
 * tell an open dispute from a job nobody has ever mentioned, and deleted both
 * on the same timer — see CLAIM_PHOTO_DAYS for what that costs and
 * `claimHoldsPhotos` for what counts.
 *
 * Released review photos are excluded, exactly as before. The customer
 * published that one deliberately, on their own review, and taking it down on
 * a timer would silently edit their review months later.
 */
export async function sweepJobPhotos(env: Env): Promise<number> {
  const t = now();
  const cutoff = t - RETENTION.JOB_PHOTO_DAYS * DAY;
  const claimCutoff = t - RETENTION.CLAIM_PHOTO_DAYS * DAY;

  const rows = await env.DB.prepare(
    `SELECT p.id, p.r2_key AS key FROM job_photos p
      WHERE p.public_on_review = 0
        AND p.created_at < ?
        AND EXISTS (SELECT 1 FROM order_items oi
                     WHERE oi.id = p.order_item_id
                       AND oi.ends_at < ?
                       AND NOT ${claimHoldsPhotos('oi')})
      LIMIT ?`,
  ).bind(cutoff, cutoff, claimCutoff, claimCutoff, PHOTO_SWEEP_BATCH)
    .all<{ id: string; key: string }>();

  return dropPhotos(env, 'job_photos', rows.results ?? []);
}

/**
 * Photographs sent inside a conversation.
 *
 * THE SCHEMA THIS DEPENDS ON IS MIGRATION 0051, AND THIS IS THE ONLY PLACE IN
 * THIS FILE THAT NAMES IT. `message_photos` holds, of the columns that matter
 * here: `id`, `thread_id` (the conversation it was sent in), `order_item_id`
 * (the booking that conversation was about WHEN THE PICTURE WAS SENT, or NULL
 * if there was not one yet), `photo_key` — not `r2_key`, that table took the
 * chance to use the honest name — and `created_at`. If any of those move, this
 * query is the one thing to change.
 *
 * WHY THIS EXISTS AT ALL. 0051 split routine pictures out of job_photos
 * because the two do not live the same length of time: the staged gallery is
 * evidence about whether a job happened, and "it is the tap by the back door,
 * look" is a sentence with a picture attached. But a routine picture is still
 * the inside of somebody's house, it still costs the same bytes out of the one
 * gigabyte this account has in total, and 0051 shipped with NO SWEEP — it says
 * so itself, and hands the obligation to this file in as many words.
 *
 * THREE ARMS, AND THEY ARE THREE DIFFERENT CLOCKS.
 *
 *   1. THE CONVERSATION IS ALREADY GONE. 0051 gives this table no foreign keys
 *      at all, on purpose and at length: a cascade from threads would delete
 *      the row holding `photo_key`, which is the only record of where the
 *      bytes are, and leave the picture in KV with nothing able to name it. So
 *      rows here outlive their thread, and something has to come looking. This
 *      arm is that something, and it has no age test deliberately — the thread
 *      went either because sweepThreads reached it at THREAD_AFTER_JOB_DAYS,
 *      which is months past every photo window below, or because a customer
 *      asked to be erased or an operator closed their account, in which case
 *      the picture must go whatever else is true of the booking. An open claim
 *      does not hold this arm, and that is the right answer rather than a gap:
 *      by the time a thread is swept the transcript of the same argument has
 *      gone with it, so there is nothing left to argue from either way.
 *
 *      DO NOT DELETE THIS ARM NOW THAT THE ERASURE PATHS DO THEIR OWN. Both
 *      erasures and account closure collect these rows, delete the bytes and
 *      delete the rows BEFORE they delete the threads — see
 *      eraseMessagePhotos — so on a run that finishes there is nothing here
 *      for this arm to find, and it reads exactly like dead code. It is not,
 *      for two reasons. The first is `sweepThreads` at the top of this file,
 *      which deletes conversations on age and does not touch this table at
 *      all: every row it strands is reachable ONLY by this arm, because arm 3
 *      still wants a matching order_items row and arm 2 still wants the age.
 *      The second is that the bytes are in Workers KV and the row is in D1,
 *      nothing spans both, and nothing spans the gap between deleting a photo
 *      row and deleting the thread either — so a Worker that dies part way,
 *      or a thread written between the SELECT that collected the keys and the
 *      DELETE that removes it, leaves a row behind with no conversation.
 *      Taking this arm out as now-dead code would reopen the hole the erasure
 *      fix closed, silently, for the next crash and for every swept thread.
 *   2. NO BOOKING BEHIND IT. A picture sent before there was a job — the
 *      broken tap in the enquiry, which 0051 calls the single most useful
 *      photograph on the job. There is no booking, so no claim can attach to
 *      it, and its only context is the conversation it was sent in. It goes on
 *      the conversation's own clock, THREAD_NO_BOOKING_DAYS, so the picture
 *      never outlives the sentence it was sent with. That constant is reused
 *      rather than a new one invented for the same question, exactly as
 *      sweepStartCodes rides on JOB_LOCATION_DAYS: two numbers here would be
 *      two answers to one question, and the privacy page would have to print
 *      both.
 *   3. A BOOKING, PAST THE WINDOW, WITH NOBODY ARGUING ABOUT IT. The same
 *      JOB_PHOTO_DAYS window and the same `claimHoldsPhotos` test the staged
 *      gallery gets, because a picture of the customer's kitchen is the same
 *      evidence about the same afternoon whichever screen it arrived through.
 *      The NOT EXISTS also covers an `order_item_id` naming a row that is not
 *      there, which nothing in this codebase produces today — order_items are
 *      emptied by erasure, never deleted — but which would otherwise be a row
 *      no arm could ever match.
 *
 * NOTE WHAT IS NOT HERE: a review exemption. `public_on_review` is a column on
 * job_photos and there is no equivalent on this table, because there is no
 * path from a conversation photograph onto a public review — releasePhoto in
 * reviews.ts only touches job_photos, and only ones the customer uploaded. A
 * conversation picture is private to the two people in the thread for its
 * whole life.
 */
export async function sweepMessagePhotos(env: Env): Promise<number> {
  const t = now();
  const cutoff = t - RETENTION.JOB_PHOTO_DAYS * DAY;
  const claimCutoff = t - RETENTION.CLAIM_PHOTO_DAYS * DAY;
  const threadCutoff = t - RETENTION.THREAD_NO_BOOKING_DAYS * DAY;

  const rows = await env.DB.prepare(
    `SELECT p.id, p.photo_key AS key FROM message_photos p
      WHERE NOT EXISTS (SELECT 1 FROM threads th WHERE th.id = p.thread_id)
         OR (p.order_item_id IS NULL AND p.created_at < ?)
         OR (p.order_item_id IS NOT NULL
             AND p.created_at < ?
             AND NOT EXISTS (SELECT 1 FROM order_items oi
                              WHERE oi.id = p.order_item_id
                                AND (oi.ends_at >= ?
                                     OR ${claimHoldsPhotos('oi')})))
      LIMIT ?`,
  ).bind(threadCutoff, cutoff, cutoff, claimCutoff, claimCutoff, PHOTO_SWEEP_BATCH)
    .all<{ id: string; key: string }>();

  return dropPhotos(env, 'message_photos', rows.results ?? []);
}

/**
 * The doorstep, removed from jobs that are over.
 *
 * FIVE tables hold the same address because each of them needed it at a
 * different moment: the appointment for routing, the order for the receipt,
 * the claim for the race, the client for next time, and the GAP either side of
 * it for the detour maths. That is defensible while the work is live and
 * indefensible three months later, so all five are scrubbed together — street
 * line and coordinates gone, postcode kept.
 *
 * Only clients the PLATFORM introduced are touched. An operator's own imported
 * list is their business record: they typed those addresses in themselves and
 * nothing here has any business editing them.
 *
 * THE STATUS TEST HAS A SECOND ARM, and without it none of this ran. 'completed'
 * is only ever set by an operator tapping a button; no cron and no webhook sets
 * it. A business that stops tapping — or stops using the app — therefore left
 * every customer's street line and five-decimal-place coordinates in four
 * tables forever, while maskWithdrawnAddress went on serving them. A scheduled
 * appointment whose end time is three months in the past is over whatever the
 * column says, so it is swept on the same clock, measured from `ends_at`.
 */
export async function sweepJobLocations(env: Env): Promise<number> {
  const t = now();
  const cutoff = t - RETENTION.JOB_LOCATION_DAYS * DAY;
  let n = 0;

  n += changes(await env.DB.prepare(
    `UPDATE appointments SET address_line = NULL, lat = NULL, lng = NULL, updated_at = ?
      WHERE ((status IN ('completed','cancelled','no_show') AND ends_at < ?)
             OR (status = 'scheduled' AND ends_at < ?))
        AND (address_line IS NOT NULL OR lat IS NOT NULL)`,
  ).bind(t, cutoff, cutoff).run());

  n += changes(await env.DB.prepare(
    `UPDATE orders SET address_line = NULL, lat = NULL, lng = NULL, updated_at = ?
      WHERE (address_line IS NOT NULL OR lat IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM order_items oi
                         WHERE oi.order_id = orders.id AND oi.ends_at >= ?)
        AND created_at < ?`,
  ).bind(t, cutoff, cutoff).run());

  n += changes(await env.DB.prepare(
    `UPDATE public_claims SET address_line = NULL, lat = NULL, lng = NULL, updated_at = ?
      WHERE (address_line IS NOT NULL OR lat IS NOT NULL) AND created_at < ?`,
  ).bind(t, cutoff).run());

  n += changes(await env.DB.prepare(
    `UPDATE clients SET address_line = NULL, lat = NULL, lng = NULL,
            geocode_status = 'pending', geocoded_at = NULL, updated_at = ?
      WHERE acquired = 'public'
        AND (address_line IS NOT NULL OR lat IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM appointments a
                         WHERE a.client_id = clients.id AND a.ends_at >= ?)
        AND created_at < ?`,
  ).bind(t, cutoff, cutoff).run());

  // THE FIFTH TABLE, and for a long time nothing anywhere touched it.
  //
  // `gaps.prev_lat/prev_lng/next_lat/next_lng` are copied off the appointments
  // either side of an opening so the detour can be measured — see detectGaps in
  // gaps.ts. They are full precision, and public.ts says in as many words what
  // they are: the previous and the next customer's front door. Neither of those
  // people booked this opening, neither of them can reach this row, and no
  // sweep and no erasure had ever looked at it. A filled or expired gap from
  // last spring was still holding two strangers' doorsteps.
  //
  // Scrubbed on the gap's own clock rather than the neighbours' appointments,
  // because a gap is bounded by the two jobs around it: a gap whose own end
  // time is three months past sits between two jobs that are at least as old.
  // The baseline drive time stays — it is a number of seconds and names nobody.
  n += changes(await env.DB.prepare(
    `UPDATE gaps SET prev_lat = NULL, prev_lng = NULL, next_lat = NULL, next_lng = NULL,
            updated_at = ?
      WHERE ends_at < ?
        AND (prev_lat IS NOT NULL OR prev_lng IS NOT NULL
             OR next_lat IS NOT NULL OR next_lng IS NOT NULL)`,
  ).bind(t, cutoff).run());

  return n;
}

/** Feed rows carry the first FEED_EXCERPT_CHARS of somebody's message. */
export async function sweepNotifications(env: Env): Promise<number> {
  const res = await env.DB.prepare(
    `DELETE FROM notifications WHERE created_at < ?`,
  ).bind(now() - RETENTION.NOTIFICATION_DAYS * DAY).run();
  return changes(res);
}

/** The outbound SMS log, whose to_address column is a phone number. */
export async function sweepMessageLog(env: Env): Promise<number> {
  const res = await env.DB.prepare(
    `DELETE FROM messages WHERE created_at < ?`,
  ).bind(now() - RETENTION.MESSAGE_LOG_DAYS * DAY).run();
  return changes(res);
}

/**
 * The safety record, once the sanction behind it has lapsed.
 *
 * This is what gives the safety record an end. A ban is kept — it has no end
 * date by design, see migration 0023 — and everything else stops being a
 * mailbox on our servers two years after it last mattered.
 *
 * THREE TABLES, WHERE THIS USED TO SWEEP ONE. The retention table on the
 * privacy page promises that a lapsed no-show record is deleted at 730 days,
 * and `customer_standing` is the least of what one is. `no_show_reports`
 * carries the customer's email address, their phone number and an operator's
 * free-text note about a named person — "she was not there and the dog was
 * loose" — and `suspensions` is the ledger of every rung anybody was ever put
 * on. Neither had a sweep anywhere in this codebase, so both were kept
 * forever, which made the row in that table untrue about the two places the
 * words actually live.
 *
 * Each pass checks for itself that no live sanction depends on the row, rather
 * than relying on the pass above having run: a report is the evidence behind a
 * suspension, and deleting one while the suspension it produced is still
 * running would leave somebody blocked with nothing on file saying why.
 */
export async function sweepStanding(env: Env): Promise<number> {
  const t = now();
  const cutoff = t - RETENTION.STANDING_DAYS * DAY;
  let n = 0;

  n += changes(await env.DB.prepare(
    `DELETE FROM customer_standing
      WHERE banned_at IS NULL
        AND (suspended_until IS NULL OR suspended_until < ?)
        AND updated_at < ?`,
  ).bind(t, cutoff).run());

  // Decided reports only. An open one is a dispute nobody has looked at yet,
  // and a sweep that quietly threw those away would be deciding them by
  // default, in favour of whoever was reported.
  n += changes(await env.DB.prepare(
    `DELETE FROM no_show_reports
      WHERE status <> 'open'
        AND updated_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM customer_standing cs
           WHERE cs.login_email = no_show_reports.login_email
             AND (cs.banned_at IS NOT NULL
                  OR (cs.suspended_until IS NOT NULL AND cs.suspended_until > ?)))
        AND NOT EXISTS (
          SELECT 1 FROM operators o
           WHERE o.id = no_show_reports.operator_id
             AND (o.banned_at IS NOT NULL
                  OR (o.suspended_until IS NOT NULL AND o.suspended_until > ?)))`,
  ).bind(cutoff, t, t).run());

  // A ban is `ends_at IS NULL` — no end date rather than a date far in the
  // future, precisely so nothing can expire it — so the NOT NULL test is what
  // keeps a ban on file while letting every finished suspension go.
  n += changes(await env.DB.prepare(
    `DELETE FROM suspensions
      WHERE ends_at IS NOT NULL AND ends_at < ? AND created_at < ?`,
  ).bind(cutoff, cutoff).run());

  return n;
}

/**
 * Estimate requests, which are a stranger describing their own house.
 *
 * `estimates.request` had no sweep of any kind and no erasure step.
 * `expireEstimates` in estimates.ts only moves a status, which was easy to
 * mistake for a retention story and is not one: an expired row holds exactly
 * the same sentence it held the day it was written.
 *
 * Two arms, and the first is the one that matters. An estimate names a
 * thread_id that is not a foreign key, so when sweepThreads deleted the
 * conversation the row survived with nothing pointing at it — unreachable from
 * every screen in the product and still on disk. Those go as soon as the
 * conversation does. The second arm is the ceiling for a thread that is still
 * alive, on the same clock a finished job's conversation gets.
 */
export async function sweepEstimates(env: Env): Promise<number> {
  const t = now();
  let n = 0;

  n += changes(await env.DB.prepare(
    `DELETE FROM estimates
      WHERE NOT EXISTS (SELECT 1 FROM threads th WHERE th.id = estimates.thread_id)`,
  ).run());

  n += changes(await env.DB.prepare(
    `DELETE FROM estimates WHERE created_at < ?`,
  ).bind(t - RETENTION.ESTIMATE_DAYS * DAY).run());

  return n;
}

/**
 * The note a customer wrote about the van on their doorstep.
 *
 * `order_items.vehicle_reported_note` is the one free-text box in this product
 * that nothing anywhere deleted. The row it sits on is deliberately kept — it
 * is the record of work that really happened and of money that really moved,
 * which is why erasure empties order_items rather than deleting it — and this
 * column was simply carried along with that exemption without ever being
 * argued for. It is not a financial record. It is a sentence a stranger typed
 * about another stranger, under stress, and it belongs to the dispute rather
 * than to the books.
 *
 * The timestamp goes with the words. `vehicle_reported_at` on its own is still
 * the fact that this customer challenged this business on this date, which is
 * a claim about two people kept for no purpose once the note behind it is
 * gone, and leaving it would also make the admin queue in startcode.ts show a
 * report with nothing in it.
 *
 * Measured from the booking's own end time rather than from when the report
 * was written, so it lines up exactly with the transcript and the photographs
 * from the same job — the three of them are one dispute and they should not
 * expire on three different days.
 */
export async function sweepVehicleReports(env: Env): Promise<number> {
  const res = await env.DB.prepare(
    `UPDATE order_items SET vehicle_reported_note = NULL, vehicle_reported_at = NULL
      WHERE vehicle_reported_at IS NOT NULL AND ends_at < ?`,
  ).bind(now() - RETENTION.VEHICLE_REPORT_DAYS * DAY).run();
  return changes(res);
}

/**
 * Door codes for jobs that are long over.
 *
 * `order_items.start_code` is four digits the customer reads out to a stranger
 * on their own doorstep, and it is stored in plain text — see startcode.ts,
 * where `code_attempts` is what bounds guessing at it. Erasure clears it,
 * because a secret about getting into a house has no business outliving
 * somebody asking to be forgotten. Nothing cleared it for the far more common
 * customer who never asks for anything, so a code minted for a job last spring
 * is still sitting on the row beside the address it belongs to.
 *
 * It is spent the moment the job starts — the customer's own view already
 * refuses to show one once `code_verified_at` is set — so past the window in
 * which the street line itself is removed there is nothing left for it to be
 * for. Swept on JOB_LOCATION_DAYS rather than on a number of its own,
 * deliberately: the code and the address are one fact about one doorstep, and
 * a code outliving the address it opens would be the odd thing to keep.
 *
 * `code_verified_at` and `code_attempts` stay. Neither is a secret, the first
 * is evidence the job really started and the second is the guess counter, and
 * clearing the counter would hand a fresh set of attempts to anybody working
 * through old bookings.
 */
export async function sweepStartCodes(env: Env): Promise<number> {
  const res = await env.DB.prepare(
    `UPDATE order_items SET start_code = NULL
      WHERE start_code IS NOT NULL AND ends_at < ?`,
  ).bind(now() - RETENTION.JOB_LOCATION_DAYS * DAY).run();
  return changes(res);
}

/**
 * Stripe event ids we have already acted on, long after anyone could resend
 * them.
 *
 * HOUSEKEEPING RATHER THAN PRIVACY, and it is the only pass in this file of
 * which that is true apart from `sweepRateLimits`. Every sweep above removes
 * something written by or about a person; this one removes an opaque
 * identifier Stripe minted and a timestamp. Nothing here is erasable data and
 * nothing here belongs in the erasure path — see STRIPE_EVENT_DAYS, which is
 * also why that constant sits outside `RETENTION` rather than in it.
 *
 * WHAT WAS WRONG BEFORE THIS FUNCTION EXISTED. Nothing at all deleted from
 * `stripe_events`. Migration 0050 added the table, the webhook handler in
 * index.ts began writing a row per event on the first delivery, and the
 * comments in both places said in so many words that the sweep was still
 * missing — so the table was a deliberate, documented, unbounded growth: one
 * row for every Stripe event this deployment has ever been sent, kept forever
 * to answer a question that stops being askable within days. It is the same
 * shape of defect migration 0048 had to fix in `rate_limits`.
 *
 * Nothing subtler than a DELETE on the timestamp is needed, because the row
 * has no other reader: the dedupe check is a single INSERT OR IGNORE keyed on
 * the primary key, so a row's only job is to exist, and a row old enough to
 * sweep is one no delivery can still be matched against. `received_at` is not
 * indexed, deliberately — at one row per payment event this is a table scan
 * over a handful of rows once a cron tick, and an index on a column only the
 * sweep ever reads would cost more on every webhook than it saves here.
 */
export async function sweepStripeEvents(env: Env): Promise<number> {
  const res = await env.DB.prepare(
    `DELETE FROM stripe_events WHERE received_at < ?`,
  ).bind(now() - STRIPE_EVENT_DAYS * DAY).run();
  return changes(res);
}

/**
 * Every sweep, in one call, for the cron.
 *
 * Each pass is caught separately: one failing query must not stop the others,
 * because the failure mode of a retention sweep that silently stops running is
 * a database that quietly goes back to keeping everything forever.
 */
export async function sweepRetention(env: Env): Promise<SweepResult> {
  const passes: Array<[string, () => Promise<number>]> = [
    ['threads', () => sweepThreads(env)],
    ['instant_requests', () => sweepInstantRequests(env)],
    ['watches', () => sweepWatches(env)],
    ['job_photos', () => sweepJobPhotos(env)],
    // Migration 0051 added message_photos with no sweep of its own and said so
    // at the bottom of itself: the table has no foreign keys, so its rows
    // outlive the conversations they hang off, and every one of them is bytes
    // out of the one gigabyte this whole account has. See sweepMessagePhotos.
    ['message_photos', () => sweepMessagePhotos(env)],
    ['job_locations', () => sweepJobLocations(env)],
    ['notifications', () => sweepNotifications(env)],
    ['message_log', () => sweepMessageLog(env)],
    ['standing', () => sweepStanding(env)],
    ['estimates', () => sweepEstimates(env)],
    ['vehicle_reports', () => sweepVehicleReports(env)],
    ['start_codes', () => sweepStartCodes(env)],
    // Not personal data of a customer's in the way the rows above are, and it
    // is in this list for the same reason they are: the bucket key is a raw
    // guest link or a raw mailbox on sixteen routes, and nothing had ever
    // deleted one. See sweepRateLimits.
    ['rate_limits', () => sweepRateLimits(env)],
    // Not personal data either, and not even close to it — an opaque Stripe
    // event id and the second it arrived. Pure housekeeping on a table that
    // had no sweep at all and therefore only ever grew. See sweepStripeEvents,
    // and STRIPE_EVENT_DAYS for why the age has a floor under it rather than
    // being as small as it could be, and why it is not one of the published
    // windows in RETENTION.
    ['stripe_events', () => sweepStripeEvents(env)],
  ];

  const out: SweepResult = {};
  for (const [name, run] of passes) {
    try {
      out[name] = await run();
    } catch (e) {
      out[name] = -1;
      console.error(`retention sweep ${name} failed`, e);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// A customer asking to be erased
// ---------------------------------------------------------------------------

export interface ErasureResult {
  /** What went, by table, so the customer can be told something concrete. */
  removed: Record<string, number>;
  /** True when a live suspension or ban meant one row had to stay. */
  standing_retained: boolean;
}

/**
 * Whether this number is under a sanction that has to outlive an erasure.
 *
 * The one exception in this file, and it is deliberately narrow: without it,
 * "erase my data" is also the button that clears a ban, and every suspended
 * customer finds that out within a week of the first one doing it.
 */
async function sanctioned(env: Env, loginEmail: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT banned_at, suspended_until FROM customer_standing WHERE login_email = ?`,
  ).bind(loginEmail).first<{ banned_at: number | null; suspended_until: number | null }>();
  if (!row) return false;
  return !!row.banned_at || (!!row.suspended_until && row.suspended_until > now());
}

/**
 * The answer an erasure gives when the photo store is not reachable.
 *
 * ONE SENTENCE IN ONE PLACE, because two separate steps of an erasure now
 * raise it — the staged gallery at step 1 and the conversation photographs at
 * step 2b — and somebody who is refused has to be told the same thing
 * whichever table tripped it. Two wordings would read as two different faults
 * and would send the same person round the same loop twice.
 *
 * What the words have to carry is the one thing the customer cannot see from
 * the outside: that NOTHING was removed. Without that sentence the safe move
 * looks like not asking again, when asking again is exactly the right move and
 * cannot delete anything twice.
 */
function photoStoreUnavailable(): HttpError {
  return new HttpError(
    503,
    'We could not reach the photo storage, so nothing has been deleted. '
    + 'Nothing has been half-deleted either — try again shortly.',
    'photo_store_unavailable',
  );
}

/**
 * Photographs sent inside a conversation, out of the store and then out of the
 * database, for one erasure.
 *
 * WHAT WAS WRONG, AND WHAT IT COST. Every erasure path in this file deletes
 * threads, and chat_messages cascades off threads, so the transcript goes with
 * the conversation it was part of. `message_photos` does not, and cannot:
 * migration 0051 gives that table no foreign keys at all, on purpose and at
 * length, precisely so that no cascade can delete the row holding `photo_key`
 * — the only record of where the bytes are — and strand the picture in a store
 * with nothing left able to name it. The obligation that decision hands over,
 * and which 0051 writes out beside its indexes, is the other half: if nothing
 * is going to take these rows automatically then something has to come and
 * take them deliberately. In the erasure paths nothing did. "Delete my data"
 * deleted the conversation, answered 200, and left the photographs of the
 * inside of the customer's house sitting in the store.
 *
 * THE PHOTOGRAPHS DID NOT STAY THERE FOREVER, WHICH IS WHY THIS WAS EASY TO
 * MISS AND IS NOT WHY IT MATTERED. The first arm of `sweepMessagePhotos`
 * collects rows whose thread has gone, so the next cron tick found them and
 * deleted them properly, bytes and all. What was wrong the whole time was the
 * RECEIPT. The customer was told — on the page, in the moment they asked, by
 * an endpoint that returned success — that their photographs had been deleted,
 * and for up to a full cron interval that was not true. The privacy page
 * promises deletion that happens when somebody asks for it, not deletion that
 * happens when a timer next fires, so this was never a leak; it was the
 * product saying something about itself that was not so, to the one person
 * with the least ability to check.
 *
 * THE ORDER IS THE ORDER `dropPhotos` KEEPS, FOR THE REASON IT KEEPS IT. Bytes
 * first, row second, always. A row deleted first is a key nobody can ever name
 * again: the bytes go on occupying the account's single shared gigabyte of
 * Workers KV — see lib/photostore.ts — with nothing in the database able to
 * ask for them, and on a store that small that is not untidiness, it is the
 * next upload failing for everybody. A failure the other way round leaves a
 * row pointing at bytes that have already gone, which shows one broken
 * thumbnail and is cleaned up by the sweep.
 *
 * REFUSED RATHER THAN HALF-DONE WHEN THERE IS NO STORE, which is the decision
 * step 1 already makes for the staged gallery and the same reasoning
 * `sweepJobPhotos` sets out for the sweeps. The two are the same rule reaching
 * two different answers because they have different audiences. A sweep with no
 * binding does NOTHING and leaves the rows for a tick that has one, because
 * there is always another tick and nobody is waiting. An erasure cannot do
 * nothing: a person is in front of a page waiting to be told what happened, so
 * it takes the other recoverable option and refuses out loud. What neither of
 * them may ever do is delete a row whose bytes it could not delete.
 *
 * TAKES A WHERE CLAUSE RATHER THAN A LIST OF IDS because the three callers ask
 * three genuinely different questions — one conversation, one customer's whole
 * footprint, and every conversation a closing business ever had. What they
 * share is the guard and the ordering, and those are the two things in this
 * path that are easy to get subtly wrong and impossible to notice afterwards.
 * A second copy written for the third caller would be the copy that drifts.
 */
async function eraseMessagePhotos(
  env: Env, where: string, binds: unknown[],
): Promise<number> {
  const found = (await env.DB.prepare(
    `SELECT id, photo_key FROM message_photos WHERE ${where}`,
  ).bind(...binds).all<{ id: string; photo_key: string }>()).results ?? [];
  if (!found.length) return 0;
  if (!env.PHOTOS) throw photoStoreUnavailable();

  for (const p of found) {
    await env.PHOTOS.delete(p.photo_key).catch(() => {});
  }

  const holes = found.map(() => '?').join(',');
  return changes(await env.DB.prepare(
    `DELETE FROM message_photos WHERE id IN (${holes})`,
  ).bind(...found.map((p) => p.id)).run());
}

/**
 * Erases a customer, proved by the secret link in their confirmation.
 *
 * THIS PATH KEEPS WORKING EXACTLY AS IT DID, and migration 0037 adding
 * accounts is not allowed to change that. Somebody reading their booking on a
 * phone that has never been signed in must be able to ask to be forgotten from
 * the page they are already on; making them verify a mobile number first would
 * be asking somebody to create an account in order to delete one. The link IS
 * the authority here: it already reads the whole booking, the conversation and
 * the photographs, so somebody holding it can already see everything this
 * removes.
 *
 * A customer who does have an account reaches the same erasure through
 * DELETE /api/customer/data, which is behind their session and runs the same
 * function — see eraseCustomerByPhone below, which despite its name now takes
 * the address as its subject.
 *
 * SCOPE. The thread names one booking; the booking names an email address; the
 * address is what ties this person's rows together across every business they
 * have used here. So erasure follows the address, not the thread — a customer
 * who asks to be forgotten and finds that only one of their three bookings went
 * has not been forgotten.
 *
 * IT FOLLOWED THE NUMBER UNTIL 0038 and could not go on doing so. A number on
 * an order is now whatever somebody typed into a form, so erasing by one would
 * have reached every stranger who ever typed the same digits and deleted their
 * bookings too — an erasure that erases other people is not a smaller version
 * of the promise.
 *
 * A conversation that never became a booking has no address attached, and there
 * the erasure is exactly what there is: the thread and its messages.
 */
export async function eraseCustomerByToken(
  env: Env, ref: ThreadRef,
): Promise<ErasureResult> {
  const thread = await threadByToken(env, ref);
  if (!thread) throw notFound('That link is not valid any more.');

  // The number on the order this link belongs to, if there is an order yet.
  const order = thread.appointment_id
    ? await env.DB.prepare(
        `SELECT o.id, o.phone_e164, o.login_email, o.email FROM orders o
           JOIN order_items oi ON oi.order_id = o.id
          WHERE oi.appointment_id = ? LIMIT 1`,
      ).bind(thread.appointment_id).first<{
        id: string; phone_e164: string | null;
        login_email: string | null; email: string | null;
      }>()
    : null;

  // The ADDRESS on the order, not the number. Since 0038 the number on an order
  // is whatever was typed into a form and identifies nobody; the address is the
  // one the account was proved with. Erasing by the number would have swept up
  // every stranger who ever typed the same digits.
  const loginEmail = order?.login_email ?? null;

  if (!order) {
    // Nothing but a conversation. Deleting the thread takes the messages with
    // it, and that is the whole of this person's footprint — except for the
    // feed rows below, which are the copy of it kept somewhere else.
    const removed: Record<string, number> = {};
    const add = (k: string, n: number) => { removed[k] = (removed[k] ?? 0) + n; };
    add('notifications', changes(await env.DB.prepare(
      `DELETE FROM notifications WHERE thread_id = ?`,
    ).bind(thread.id).run()));
    // The estimate request too, for the reason step 3 of the other path gives:
    // `estimates.thread_id` is not a foreign key, so the row does not go with
    // the thread and nothing else would ever have found it.
    add('estimates', changes(await env.DB.prepare(
      `DELETE FROM estimates WHERE thread_id = ?`,
    ).bind(thread.id).run()));
    // And the photographs sent in that conversation, BEFORE the thread goes.
    //
    // THIS IS THE BRANCH WHERE THE PICTURE MATTERS MOST, which is what made
    // the omission expensive. A thread with no order behind it is a stranger's
    // enquiry, and migration 0051 says in as many words that the single most
    // useful photograph on a job is the one sent here — the broken tap, shown
    // before there is anything to book. It hangs off a table with no foreign
    // keys, so deleting the thread never took it and nothing else in this
    // branch looked: the erasure removed the sentence, kept the photograph of
    // the inside of the house, and told the person it had removed both.
    //
    // Before the thread rather than after it because the bytes have to be
    // gone before the row that names them is, and a row whose thread has
    // already been deleted is one only the sweep's orphan arm can still find.
    // See eraseMessagePhotos for the ordering and for why a missing photo
    // store refuses here instead of skipping.
    add('message_photos', await eraseMessagePhotos(
      env, 'thread_id = ?', [thread.id]));
    const res = await env.DB.prepare(`DELETE FROM threads WHERE id = ?`)
      .bind(thread.id).run();
    add('threads', changes(res));
    await recordErasure(env, 'customer', thread.id, sum(removed));
    return { removed, standing_retained: false };
  }

  // The thread this link named is passed through because it may not be one of
  // the ones reachable from an appointment: an enquiry that later became a
  // booking keeps its original thread, and dropping it here would leave the
  // conversation standing after everything it was about had gone.
  //
  // AND SO IS THE ORDER ID, WHICH IS THE FIX FOR A SILENT NO-OP.
  //
  // The branch above used to test `!loginEmail` rather than `!order`, and the
  // difference between those two is a column that is NULL on every row written
  // before migration 0038. That migration added `orders.login_email` with no
  // backfill — see the ALTER at the bottom of it, which has no UPDATE under it
  // — so an order taken before it shipped has NULL there to this day. For
  // every one of those, "Delete my data" resolved the link, found the order,
  // read NULL, and fell into the branch that deletes a conversation and
  // nothing else. The order, the appointment, the street line, the
  // coordinates, the photographs of the inside of the house, the client row on
  // the business's list and the door code all stayed exactly where they were,
  // the endpoint answered 200, and the page went on saying "Deleted outright".
  // It is the same failure the client-row delete had — a WHERE clause keyed on
  // a column that is NULL — wearing an `if` instead of an `IN`.
  //
  // Passing the order id means the work-shaped half of the erasure runs off
  // the booking the link actually names, whether or not anybody's address was
  // ever written onto it. What cannot run without a login_email is the half
  // that is keyed on the PERSON — their account, their standing, their alert
  // watches — and those are skipped rather than guessed at, because there is
  // nothing on a pre-0038 order that says which mailbox it belonged to and
  // inventing one would erase somebody else.
  return eraseCustomerByPhone(env, loginEmail, {
    extraThreadIds: [thread.id],
    extraOrderIds: [order.id],
  });
}

/**
 * The same erasure, reached from a signed-in account instead of from a link.
 *
 * ONE IMPLEMENTATION, TWO DOORS, and it is one implementation deliberately.
 * The link path and the account path have to remove exactly the same rows --
 * a customer who is erased through their account and finds that the version
 * of erasure reachable from a link went further has not been erased -- and two
 * copies of a fourteen-step deletion drift the first time one of them gains a
 * table. So the link path resolves its token to a number and calls this, and
 * this is the only place that knows what erasing somebody means.
 *
 * The scope is the NUMBER, not the account and not the booking. That is what
 * makes "forget me" reach the March booking made before there was an account,
 * the June one made after it, and the conversations attached to both.
 */
export async function eraseCustomerByPhone(
  env: Env, loginEmail: string | null,
  opts: { extraThreadIds?: string[]; extraOrderIds?: string[] } = {},
): Promise<ErasureResult> {
  const removed: Record<string, number> = {};
  const add = (k: string, n: number) => { removed[k] = (removed[k] ?? 0) + n; };

  const retainStanding = loginEmail ? await sanctioned(env, loginEmail) : false;

  // Everything this person has, found once through the ADDRESS.
  //
  // It was the number until 0038, and the swap is not cosmetic: a number on an
  // order is now unproved, so erasing by one would reach every stranger who
  // ever typed the same digits into a booking form and delete their bookings
  // too. The address is the thing this person demonstrated they control.
  //
  // `extraOrderIds` is the pre-0038 case, and it is a union rather than an
  // alternative on purpose: a customer may hold one order from before that
  // migration and three from after it, and an erasure that reached only the
  // set the link happened to name would be the same partial erasure this
  // function was written to stop. See eraseCustomerByToken for why the column
  // can be NULL at all.
  const orders = loginEmail
    ? await env.DB.prepare(
        `SELECT id FROM orders WHERE login_email = ?`,
      ).bind(loginEmail).all<{ id: string }>()
    : { results: [] as Array<{ id: string }> };
  const orderIds = [...new Set([
    ...(orders.results ?? []).map((r) => r.id),
    ...(opts.extraOrderIds ?? []),
  ])];
  const orderHoles = orderIds.map(() => '?').join(',');

  // THE NUMBERS THIS PERSON GAVE, read here and used by the phone-keyed steps
  // further down. Several tables -- clients, instant_requests, public_claims --
  // are the operator's own copies and are keyed on the number that was on the
  // job, so erasing the person means clearing every number they ever typed,
  // not the one currently on their account.
  //
  // Read BEFORE anything is emptied, for the same reason the mailboxes below
  // are: step 4 clears phone_e164 off the order rows, and the same query run in
  // its natural place would return nothing.
  //
  // READ OFF THE ORDERS THIS FUNCTION ALREADY FOUND rather than by repeating
  // the login_email lookup. For a signed-in erasure the two are the same set by
  // construction; for one reached from a pre-0038 link they are not, and asking
  // by login_email again would find nothing and leave the number on the rows
  // below exactly where it was.
  const phones = new Set<string>();
  if (orderIds.length) {
    for (const r of ((await env.DB.prepare(
      `SELECT DISTINCT phone_e164 FROM orders
        WHERE id IN (${orderHoles}) AND phone_e164 IS NOT NULL`,
    ).bind(...orderIds).all<{ phone_e164: string }>()).results ?? [])) phones.add(r.phone_e164);
  }
  if (loginEmail) {
    for (const r of ((await env.DB.prepare(
      `SELECT DISTINCT phone_e164 FROM customer_accounts
        WHERE login_email = ? AND phone_e164 IS NOT NULL`,
    ).bind(loginEmail).all<{ phone_e164: string }>()).results ?? [])) phones.add(r.phone_e164);
  }
  const phoneList = [...phones];
  const phoneHoles = phoneList.map(() => '?').join(',');

  const items = orderIds.length
    ? await env.DB.prepare(
        `SELECT id, appointment_id, client_id FROM order_items
          WHERE order_id IN (${orderHoles})`,
      ).bind(...orderIds).all<{
        id: string; appointment_id: string | null; client_id: string | null;
      }>()
    : { results: [] as Array<{ id: string; appointment_id: string | null; client_id: string | null }> };

  const itemIds = (items.results ?? []).map((r) => r.id);
  const appointmentIds = (items.results ?? [])
    .map((r) => r.appointment_id).filter((v): v is string => !!v);
  // The client rows the PLATFORM made for this person, found through the work
  // rather than through a number. See step 7 for why this is the only way back
  // to them that has ever worked.
  const clientIds = [...new Set((items.results ?? [])
    .map((r) => r.client_id).filter((v): v is string => !!v))];


  // Every mailbox this person has given us, read HERE and used at step 9.
  //
  // Read before anything is emptied, which is the whole reason it is up here
  // rather than beside the delete it feeds: step 4 clears both the email and
  // the phone number off the order rows, so the same query run in its natural
  // place would return nothing at all and the standing alerts would survive
  // the erasure — the most visible possible way to fail at one, since they
  // keep arriving by email afterwards. The account is asked as well as the
  // orders, because somebody may have set an address on the account and never
  // typed one into a checkout.
  //
  // Read off the orders this function found, for the reason the numbers above
  // are: on a pre-0038 link there is no login_email to ask by, and the contact
  // address sitting on that order is then the only mailbox this person has
  // anywhere in the database.
  const mailboxes = new Set<string>(loginEmail ? [loginEmail] : []);
  if (orderIds.length) {
    for (const r of ((await env.DB.prepare(
      `SELECT DISTINCT email FROM orders WHERE id IN (${orderHoles}) AND email IS NOT NULL`,
    ).bind(...orderIds).all<{ email: string }>()).results ?? [])) mailboxes.add(r.email);
  }
  if (loginEmail) {
    for (const r of ((await env.DB.prepare(
      `SELECT DISTINCT email FROM customer_accounts
        WHERE login_email = ? AND email IS NOT NULL`,
    ).bind(loginEmail).all<{ email: string }>()).results ?? [])) mailboxes.add(r.email);
  }

  // 1. Photographs. The stored bytes first, then the rows — including any the
  //    customer had published on a review, because "erase me" covers the
  //    picture of their hallway they once chose to show.
  if (itemIds.length) {
    const holes = itemIds.map(() => '?').join(',');
    const photos = await env.DB.prepare(
      `SELECT id, r2_key FROM job_photos WHERE order_item_id IN (${holes})`,
    ).bind(...itemIds).all<{ id: string; r2_key: string }>();
    const files = photos.results ?? [];
    // REFUSED RATHER THAN HALF-DONE. The stored-bytes delete was guarded on
    // the binding and the row delete under it was not, so a deployment whose
    // PHOTOS binding had gone away would delete the r2_key, tell the customer
    // they had been erased, and leave photographs of the inside of their house
    // in the store with nothing left in the database able to name them.
    // Failing here means the customer is told it did not work and can ask
    // again — the only outcome of the three that is still recoverable.
    //
    // Unchanged by the move from R2 to Workers KV: `delete` has the same
    // signature and the same "no such key is not an error" behaviour on both,
    // so only the store behind the binding is different.
    //
    // The sentence itself moved out to `photoStoreUnavailable` when step 2b
    // below gained the same refusal for conversation photographs. Two copies
    // of it would be two apparent faults for one missing binding.
    if (files.length && !env.PHOTOS) throw photoStoreUnavailable();
    for (const p of files) {
      await env.PHOTOS!.delete(p.r2_key).catch(() => {});
    }
    add('job_photos', changes(await env.DB.prepare(
      `DELETE FROM job_photos WHERE order_item_id IN (${holes})`,
    ).bind(...itemIds).run()));
  }

  // 2. Feed rows, before the conversations they point at.
  //
  //    THE ONE COPY OF THIS PERSON THAT NOTHING HERE USED TO REACH. Every step
  //    in this function either deletes a row or empties the columns that name
  //    somebody, because those are all read out of tables. A notification is
  //    not: it is a sentence written at the moment something happened, holding
  //    the customer's first name and an excerpt of what they wrote, and it
  //    survived erasure entirely — an operator who was told "that person asked
  //    to be forgotten" could still scroll their Bookings tab and read them.
  //    The retention sweep got there in the end, which is not what somebody
  //    asking to be erased is asking for.
  //
  //    Deleted rather than emptied, unlike the appointment and the claim: a
  //    notification is a nudge about something that has already been dealt
  //    with, so there is no business record inside it to keep. Found by both
  //    of the keys a feed row can carry, because a chat notification names the
  //    thread and a booking notification names the appointment.
  //
  //    A THIRD KEY SINCE MIGRATION 0052, and leaving it out would have made
  //    this function quietly less complete than it was the day before that
  //    migration shipped.
  //
  //    A conversation that never became a booking has no appointment, so the
  //    lookup below cannot reach one and never could. That used to be correct
  //    rather than a gap: nothing in the database tied an anonymous enquiry to
  //    a person, so there was nothing here to erase on anybody's behalf. 0052
  //    changed that. A question asked while signed in now carries
  //    `threads.customer_account_id`, so the database DOES hold a link from
  //    this person to a conversation holding their first name and whatever
  //    they typed about their house — and "delete everything you hold about
  //    me" has to reach anything we can name them from. A new way to find
  //    somebody is a new thing to erase, and the two have to land in the same
  //    release or the receipt this function returns is wrong.
  //
  //    Joined through customer_accounts on login_email rather than taking an
  //    account id, because the ADDRESS is the scope of this whole function and
  //    an account is something found by it. It also means an account closed
  //    and reopened on the same address is reached, which is the same union
  //    the orders lookup above depends on.
  //
  //    Deduplicated, because a booking's conversation is now found by two keys
  //    and counting it twice would overstate the receipt.
  const threadIds = [...new Set([
    ...(opts.extraThreadIds ?? []),
    ...(appointmentIds.length
      ? ((await env.DB.prepare(
          `SELECT id FROM threads WHERE appointment_id IN (${appointmentIds.map(() => '?').join(',')})`,
        ).bind(...appointmentIds).all<{ id: string }>()).results ?? []).map((r) => r.id)
      : []),
    ...(loginEmail
      ? ((await env.DB.prepare(
          `SELECT t.id FROM threads t
             JOIN customer_accounts a ON a.id = t.customer_account_id
            WHERE a.login_email = ?`,
        ).bind(loginEmail).all<{ id: string }>()).results ?? []).map((r) => r.id)
      : []),
  ])];

  //    TWO KEYS IS ALL THERE IS, AND A THIRD KIND OF ROW USED TO FALL BETWEEN
  //    THEM. An instant request writes three feed rows — somebody wants a job
  //    now, you missed one, they cancelled — and none of them can carry either
  //    key, because a request nobody accepted never becomes an appointment or a
  //    thread. So this delete could not reach one, and the customer's first
  //    name and whatever they had typed about their house stayed in the
  //    operator's feed until the ninety-day sweep happened past. That is fixed
  //    in online.ts rather than here: those three rows no longer carry a name
  //    or a note at all, because the request they point at holds both and is
  //    deleted outright at step 9. A copy that cannot be found is a copy that
  //    should not be written.
  const feedKeys: Array<[string, string[]]> = [
    ['appointment_id', appointmentIds],
    ['thread_id', threadIds],
  ];
  for (const [column, ids] of feedKeys) {
    if (!ids.length) continue;
    add('notifications', changes(await env.DB.prepare(
      `DELETE FROM notifications WHERE ${column} IN (${ids.map(() => '?').join(',')})`,
    ).bind(...ids).run()));
  }

  // 2b. The photographs sent inside those conversations, before the
  //     conversations go.
  //
  //     THE THIRD THING HANGING OFF A THREAD THAT DOES NOT GO WITH IT — after
  //     the feed rows above and the estimate requests in step 3 below — and
  //     the only one of the three whose row is not the whole of what has to be
  //     removed. A `message_photos` row names bytes in the photo store, and
  //     migration 0051 gives that table no foreign keys precisely so that no
  //     cascade can delete the row holding `photo_key` and leave those bytes
  //     unnameable in a namespace with one gigabyte for the entire account.
  //
  //     WHAT NOT BEING WIRED TO IT COST. Not a permanent leak: the orphan arm
  //     of `sweepMessagePhotos` collected these rows on the next cron tick and
  //     deleted the bytes properly. What it cost was the truth of the answer.
  //     This function returns a receipt, index.ts sends it back with a 200 and
  //     the page tells the customer their data is gone, and for the whole of
  //     that window the photographs were still there. A privacy page that
  //     promises self-service deletion is promising deletion when you ask, not
  //     deletion when a timer fires, and a receipt that is wrong about the one
  //     thing the reader cannot check for themselves is worse than a slower
  //     promise honestly described.
  //
  //     BOTH KEYS, BECAUSE EITHER ON ITS OWN MISSES ROWS THAT ARE THIS
  //     PERSON'S. The thread ids are the conversations about to be deleted
  //     below, which is where a picture sent in an enquiry that never became a
  //     booking lives — `order_item_id` is NULL on one of those and no
  //     booking-shaped key could ever reach it. The order-item ids catch the
  //     opposite case: a photograph whose conversation has ALREADY gone,
  //     swept at THREAD_AFTER_JOB_DAYS while the booking it belongs to is
  //     still on file, leaving a row that names this customer's job and
  //     nothing else. Neither key can reach anybody else: the threads are the
  //     ones found from this customer's own appointments plus the link they
  //     arrived on, and the items are this customer's own order lines.
  if (threadIds.length || itemIds.length) {
    const arms: string[] = [];
    const photoBinds: unknown[] = [];
    if (threadIds.length) {
      arms.push(`thread_id IN (${threadIds.map(() => '?').join(',')})`);
      photoBinds.push(...threadIds);
    }
    if (itemIds.length) {
      arms.push(`order_item_id IN (${itemIds.map(() => '?').join(',')})`);
      photoBinds.push(...itemIds);
    }
    add('message_photos', await eraseMessagePhotos(env, arms.join(' OR '), photoBinds));
  }

  // 3. Conversations, which cascade to every message in them — and the estimate
  //    requests hanging off them, which do not.
  //
  //    The estimates go FIRST and they are in this step rather than a step of
  //    their own because they are part of the same conversation: `request` is
  //    what the customer asked for in their own words, which migration 0029
  //    says at the column and which in practice is a description of their
  //    house. `estimates.thread_id` is a plain TEXT column with no foreign key
  //    behind it, so deleting the thread first would leave the request standing
  //    with nothing pointing at it — which is precisely how it came to survive
  //    every erasure this product has ever run.
  if (threadIds.length) {
    add('estimates', changes(await env.DB.prepare(
      `DELETE FROM estimates WHERE thread_id IN (${threadIds.map(() => '?').join(',')})`,
    ).bind(...threadIds).run()));
  }
  if (appointmentIds.length) {
    const holes = appointmentIds.map(() => '?').join(',');
    add('threads', changes(await env.DB.prepare(
      `DELETE FROM threads WHERE appointment_id IN (${holes})`,
    ).bind(...appointmentIds).run()));
  }
  if (threadIds.length) {
    add('threads', changes(await env.DB.prepare(
      `DELETE FROM threads WHERE id IN (${threadIds.map(() => '?').join(',')})`,
    ).bind(...threadIds).run()));
  }

  // 4. The order rows. Real deletion of every personal column; the money, the
  //    currency and the dates stay, because a settled transaction is not the
  //    customer's to erase and is no longer about a person once these are out.
  if (orderIds.length) {
    const holes = orderIds.map(() => '?').join(',');
    add('orders', changes(await env.DB.prepare(
      `UPDATE orders SET guest_name = 'Removed', phone_e164 = NULL, email = NULL,
              address_line = NULL, postcode = NULL, lat = NULL, lng = NULL,
              thread_token_hash = NULL, updated_at = ?
        WHERE id IN (${holes})`,
    ).bind(now(), ...orderIds).run()));
  }

  // 5. The appointment: kept as a business record of work done, emptied of
  //    where it happened and of anything anybody wrote about the household.
  //
  //    And the GAPS either side of it, which hold a second full-precision copy
  //    of the same doorstep. detectGaps copies the appointment's coordinates
  //    onto the opening before it and the opening after it so the detour can be
  //    measured, and nothing had ever deleted one: an erased customer's front
  //    door stayed on two gap rows belonging to a business they had asked to
  //    forget them. Found by the appointment ids, which is the only key those
  //    columns can be reached by.
  if (appointmentIds.length) {
    const holes = appointmentIds.map(() => '?').join(',');
    add('appointments', changes(await env.DB.prepare(
      `UPDATE appointments SET address_line = NULL, postcode = NULL, lat = NULL,
              lng = NULL, notes = NULL, updated_at = ?
        WHERE id IN (${holes})`,
    ).bind(now(), ...appointmentIds).run()));

    add('gaps', changes(await env.DB.prepare(
      `UPDATE gaps SET prev_lat = NULL, prev_lng = NULL, updated_at = ?
        WHERE prev_appointment_id IN (${holes})
          AND (prev_lat IS NOT NULL OR prev_lng IS NOT NULL)`,
    ).bind(now(), ...appointmentIds).run()));
    add('gaps', changes(await env.DB.prepare(
      `UPDATE gaps SET next_lat = NULL, next_lng = NULL, updated_at = ?
        WHERE next_appointment_id IN (${holes})
          AND (next_lat IS NOT NULL OR next_lng IS NOT NULL)`,
    ).bind(now(), ...appointmentIds).run()));
  }

  // 6. The claim row, which holds the doorstep for the booking race.
  //
  // Emptied rather than deleted: the unique index on gap_id is what stops two
  // people confirming the same opening, and removing the row would take that
  // guard away from a slot that may still be in the future.
  //
  // Found by the peppered digest of the number rather than by the number,
  // because migration 0035 took the number itself off this table -- it sat
  // beside an operator_id, was read by nothing, and was one `SELECT *` away
  // from being the whole promise. The reach is the same as it was: every claim
  // this person ever made, at every business, not merely the one whose link
  // they happened to open.
  //
  // The second arm is for claims written before that migration, which have no
  // digest and could not be given one. Those are reachable through the
  // appointment the order names, and this is the only way back to them.
  const claimHoles = appointmentIds.length
    ? ` OR appointment_id IN (${appointmentIds.map(() => '?').join(',')})` : '';
  const claimHashes = await Promise.all(phoneList.map((p) => claimPhoneHash(env, p)));
  const hashHoles = claimHashes.length
    ? `phone_hash IN (${claimHashes.map(() => '?').join(',')})` : '0 = 1';
  add('public_claims', changes(await env.DB.prepare(
    `UPDATE public_claims SET phone_hash = NULL,
            address_line = NULL, postcode = NULL, lat = NULL, lng = NULL, updated_at = ?
      WHERE ${hashHoles}${claimHoles}`,
  ).bind(now(), ...claimHashes, ...appointmentIds).run()));

  // 7. Client rows the PLATFORM created for this person. Deleted outright:
  //    appointments hold client_id ON DELETE SET NULL, so the work survives.
  //    An operator's own imported client is untouched — they typed that in
  //    themselves and it is their record, not ours.
  //
  //    FOUND BY ID, AND THE OLD QUERY COULD NEVER HAVE MATCHED ANYTHING. It
  //    looked for `phone_e164 IN (the numbers this person gave)`, and migration
  //    0023 is the reason that was dead on arrival: a platform-created client
  //    row is written with `phone_e164 = NULL` — see the inserts in public.ts
  //    and orders.ts, which spell out three NULLs on purpose — and 0023 cleared
  //    the column on every row that already existed. `NULL IN (...)` is never
  //    true, so this deleted nothing, ever. The customer's first name, street
  //    line, postcode and five-decimal-place coordinates stayed on every
  //    business's client list after they had been told they were erased, and
  //    the page said "Deleted outright" the whole time.
  //
  //    The way back to those rows is the work: order_items.client_id names the
  //    row this person's booking created, at each business they booked with.
  //    `platform_introduced` is the flag those same inserts set, and it is what
  //    keeps an operator's own list out of this — see migration 0048, which is
  //    where the reader migration 0023 asked for is recorded.
  if (clientIds.length) {
    add('clients', changes(await env.DB.prepare(
      `DELETE FROM clients
        WHERE platform_introduced = 1
          AND id IN (${clientIds.map(() => '?').join(',')})`,
    ).bind(...clientIds).run()));
  }

  // 7b. The code that opens the customer's front door, and what they wrote
  //     about whoever turned up at it.
  //
  //     `order_items.start_code` is the four digits the customer reads out to
  //     the stranger on the doorstep — startcode.ts — and it was the one
  //     column on that table nothing ever cleared. The rest of the row is the
  //     money and the dates, which stay; this is a secret about getting into a
  //     house, it is spent the moment the job starts, and it has no business
  //     outliving the person who asked to be forgotten. Cleared rather than
  //     deleted with the row for the same reason everything else on order_items
  //     is kept: it is the record of work that really happened.
  //
  //     AND IT WAS NOT THE ONLY ONE. `vehicle_reported_note` is up to five
  //     hundred characters the customer typed while a van they did not
  //     recognise was outside their house, and `vehicle_reported_at` is the
  //     fact that they did. reportVehicle in startcode.ts writes both, nothing
  //     in this file had ever touched either, and no sweep anywhere had either
  //     — see sweepVehicleReports above, which is the other half of this fix.
  //     So somebody who asked to be forgotten left behind a sentence in their
  //     own words about a frightening afternoon, on an admin screen, forever.
  //     It is not part of the settled transaction that keeps this row alive:
  //     it names nothing an accountant needs and everything a person would
  //     want back.
  //
  //     Cleared in the same statement as the code rather than in a step of its
  //     own, because they are the same decision about the same row — the parts
  //     of order_items that are about the PERSON rather than about the money —
  //     and splitting them is how the next column added to this table gets
  //     added to one list and not the other.
  if (itemIds.length) {
    add('order_items', changes(await env.DB.prepare(
      `UPDATE order_items
          SET start_code = NULL,
              vehicle_reported_note = NULL, vehicle_reported_at = NULL
        WHERE id IN (${itemIds.map(() => '?').join(',')})
          AND (start_code IS NOT NULL OR vehicle_reported_at IS NOT NULL)`,
    ).bind(...itemIds).run()));
  }

  // 8. Reviews. The rating and the words stay — they are the business's
  //    record and other customers rely on them — and the name attached to
  //    them goes, which is the part that identifies anybody.
  if (itemIds.length) {
    const holes = itemIds.map(() => '?').join(',');
    add('reviews', changes(await env.DB.prepare(
      `UPDATE reviews SET author_name = 'A customer', updated_at = ?
        WHERE order_item_id IN (${holes}) AND author_name <> 'A customer'`,
    ).bind(now(), ...itemIds).run()));
  }

  // 9. Requests that never became anything, and the alert watches on this
  //    person's mailbox.
  //
  //    TWO ARMS, AND THE SPLIT IS THE WHOLE POINT OF MIGRATION 0049. An
  //    instant request is the sharpest row in this product — a first name, a
  //    street line, coordinates to five decimal places and a note the customer
  //    typed about their own house, usually for a job that never happened —
  //    and until 0049 the only way back to one was `phone_e164`. Since 0038
  //    nobody proves a number, so that key was wrong in both directions at
  //    once: a household sharing one mobile was ONE subject, so erasing one
  //    person deleted the other's requests, and a person whose account carries
  //    no number had NO subject, so their own requests survived an erasure
  //    that told them otherwise.
  //
  //    The first arm is the proved mailbox, which is what every other table in
  //    this function is keyed on and what online.ts now writes onto the row.
  //    The second is for rows written before that column existed, where the
  //    number is genuinely the only key there is — kept because dropping it
  //    would leave those rows unreachable, and bounded because they age out
  //    under INSTANT_REQUEST_DEAD_DAYS and INSTANT_REQUEST_ACCEPTED_DAYS
  //    within a month. `login_email IS NULL` on that arm is what stops a new
  //    row belonging to somebody else being caught by a shared number.
  if (loginEmail) {
    add('instant_requests', changes(await env.DB.prepare(
      `DELETE FROM instant_requests WHERE login_email = ?`,
    ).bind(loginEmail).run()));
  }
  if (phoneList.length) {
    add('instant_requests', changes(await env.DB.prepare(
      `DELETE FROM instant_requests
        WHERE login_email IS NULL AND phone_e164 IN (${phoneHoles})`,
    ).bind(...phoneList).run()));
  }

  // The mailboxes gathered at the top of this function, before step 4 emptied
  // the rows they were read from.
  for (const email of mailboxes) {
    add('watches', changes(await env.DB.prepare(
      `DELETE FROM watches WHERE email = ?`,
    ).bind(email).run()));
  }

  // to_address held a phone number while codes were texted and holds a mailbox
  // now, so both are cleared: a deployment that has been through 0038 has rows
  // of each kind, and erasing only the newer sort would leave the older one.
  for (const target of [...phoneList, ...mailboxes]) {
    add('messages', changes(await env.DB.prepare(
      `DELETE FROM messages WHERE to_address = ?`,
    ).bind(target).run()));
  }

  // 10 to 12. Everything keyed on the PERSON rather than on the work.
  //
  //    Skipped entirely, rather than run with a NULL subject, when the link
  //    that reached this erasure belongs to an order taken before migration
  //    0038 — see eraseCustomerByToken. `WHERE login_email = NULL` matches
  //    nothing in SQL, so running these anyway would be four statements that
  //    silently do nothing, which is precisely the class of bug this function
  //    has now been caught by twice. Saying so with an `if` makes it a
  //    decision that is visible in the code and in the receipt below, instead
  //    of an accident that reads like a delete.
  //
  //    It is also the only honest answer. A pre-0038 order carries no proof of
  //    which mailbox it belonged to; guessing one from the contact address on
  //    the row would mean closing an account, clearing a suspension and
  //    deleting the alert watches of whoever happens to own that mailbox now,
  //    on the say-so of a link. The work-shaped half above has already run and
  //    is the part the link genuinely authorises.
  if (loginEmail) {
    // 10. The dispute record. An open report, or one behind a live sanction,
    //    keeps the number it needs to find the standing row. Everything settled
    //    loses both the number and whatever prose was written about the person.
    add('no_show_reports', changes(await env.DB.prepare(
      `UPDATE no_show_reports SET phone_e164 = NULL, login_email = NULL, note = NULL,
              updated_at = ?
        WHERE login_email = ? AND status <> 'open' AND ? = 0`,
    ).bind(now(), loginEmail, retainStanding ? 1 : 0).run()));

    // 11. The account itself, if this number ever made one.
  //
  //     Emptied and closed rather than deleted, and the number set to NULL,
  //     which is what releases it: the unique index treats NULLs as distinct,
  //     so the row can sit here forever without stopping the same person
  //     signing up again one day. Every session on it dies in the same breath,
  //     because a cookie in a browser must not outlive the row it names — and
  //     currentCustomer refuses on closed_at anyway, which is the second of
  //     the two reasons that is true.
  //
  //     The row is kept rather than deleted for the same reason the order is:
  //     order_items and reviews point at work that really happened, and a
  //     dangling id is worse evidence than an emptied one. Nothing
  //     identifying a person is left on it.
  //     DELETED, NOT REVOKED, and that is the difference between closing an
  //     account and erasing one. A revoked session is still a row naming this
  //     account id with the device string that was signing in on it — a record
  //     of which phone this person used and when, kept for no purpose once the
  //     row it points at has been emptied. sweepCustomerAuth would reach it a
  //     day later; somebody asking to be erased is not asking for that.
    add('customer_sessions', changes(await env.DB.prepare(
      `DELETE FROM customer_sessions
        WHERE account_id IN (SELECT id FROM customer_accounts WHERE login_email = ?)`,
    ).bind(loginEmail).run()));
    add('customer_login_codes', changes(await env.DB.prepare(
      `DELETE FROM customer_login_codes WHERE login_email = ?`,
    ).bind(loginEmail).run()));
  //     stripe_customer_id GOES WITH THE REST OF IT. Eleven columns were listed
  //     here and this was the twelfth, left behind — a live pointer at a Stripe
  //     Customer object holding this person's name and email address, sitting
  //     on a row we had just told them held nothing about them. Clearing the
  //     column does not delete Stripe's copy, and nothing in this codebase can:
  //     see the note in the report and section 7 of the privacy page, which now
  //     says plainly that Stripe keeps its own record under its own policy.
  //     What clearing it does do is stop this database being the thing that
  //     links a person to it.
    add('customer_accounts', changes(await env.DB.prepare(
      `UPDATE customer_accounts
          SET login_email = NULL, email_verified_at = NULL,
              phone_e164 = NULL, first_name = NULL, email = NULL,
              payment_ref = NULL, payment_brand = NULL, payment_last4 = NULL,
              payment_added_at = NULL, password_hash = NULL,
              stripe_customer_id = NULL,
              closed_at = COALESCE(closed_at, ?), updated_at = ?
        WHERE login_email = ?`,
    ).bind(now(), now(), loginEmail).run()));

    // 12. Standing, and the suspensions that produced it.
    if (!retainStanding) {
      add('customer_standing', changes(await env.DB.prepare(
        `DELETE FROM customer_standing WHERE login_email = ?`,
      ).bind(loginEmail).run()));
      add('suspensions', changes(await env.DB.prepare(
        `DELETE FROM suspensions WHERE subject_kind = 'customer' AND subject_id = ?`,
      ).bind(loginEmail).run()));
    }
  }

  // The receipt names the subject it actually erased. On a pre-0038 link there
  // is no mailbox to name, so the orders are the subject — hashed exactly the
  // same way, so this row is no more readable than any other one.
  await recordErasure(
    env, 'customer', loginEmail ?? `orders:${orderIds.join(',')}`, sum(removed));
  return { removed, standing_retained: retainStanding };
}

const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);

/**
 * The van's last fix and its trail, erased.
 *
 * THE ONE PIECE OF PERSONAL DATA IN THIS PRODUCT THAT IS NOT IN D1. Position
 * pings stopped being rows in migration 0015 and became state on a Durable
 * Object -- see src/do/van.ts -- and every deletion path in this file was
 * written against the database, so not one of them ever reached it.
 * VanTracker.clear() has existed since the day that object was written and
 * nothing outside the tests had ever called it. The result was that an
 * operator's last known position and up to twenty sampled points of where they
 * drove stayed in Durable Object storage indefinitely: after they switched
 * location sharing off, and after they closed the account this file is
 * otherwise so careful to empty. Both of those are a person saying "stop
 * holding where I am", and neither of them did anything about it.
 *
 * Failures are swallowed on purpose. The object may never have been created,
 * the binding is optional in every environment that has not run the tracking
 * migration, and a tracking-storage hiccup must not be what makes an account
 * closure or a privacy toggle fail -- the caller has already done, or is about
 * to do, the part that is recorded.
 */
interface VanClearStub { clear(): Promise<void> }
interface VanClearNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): VanClearStub;
}

export async function forgetVan(env: Env, operatorId: string): Promise<void> {
  const id = (operatorId ?? '').trim();
  if (!id) return;
  const ns = (env as unknown as { VAN?: VanClearNamespace }).VAN;
  if (!ns) return;
  try { await ns.get(ns.idFromName(id)).clear(); }
  catch (e) { console.error('van clear failed', id, e); }
}

/** The receipt. A peppered hash of the subject, never the subject. */
async function recordErasure(
  env: Env, kind: 'customer' | 'operator', subject: string, rows: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO erasures (id, subject_kind, subject_hash, rows_removed, created_at)
     VALUES (?,?,?,?,?)`,
  ).bind(newId(), kind, await subjectHash(env, subject), rows, now()).run();
}

// ---------------------------------------------------------------------------
// An operator closing their account
// ---------------------------------------------------------------------------

/**
 * Closes an operator's account.
 *
 * NOT A FLAG ON A ROW THAT STILL HOLDS EVERYTHING. The personal columns are
 * really emptied: the email they sign in with, their phone number, their home
 * address and its coordinates, their licence number, their insurance policy
 * number, the name a background check was run against, their vehicle's
 * registration plate, their social handles, their avatar. What is left is a
 * business name of "Closed business", a country, a currency and a timezone —
 * which is what the financial rows pointing at this id need in order to still
 * make sense, and which identifies nobody.
 *
 * It also takes their customers' data with it. An operator's client list,
 * their conversations and the instant requests strangers sent them are all
 * personal data about OTHER people that only existed because this account
 * existed, and leaving it behind attached to a dead business would be the
 * worst of both worlds.
 *
 * What survives: order_items, orders, lead_fees, suspensions and reviews. Work
 * that happened, money that moved, and what customers said about it.
 */
export async function closeOperatorAccount(
  env: Env, operatorId: string,
): Promise<{ removed: Record<string, number> }> {
  const id = (operatorId ?? '').trim();
  if (!id) throw badRequest('An account needs an operator.', 'no_operator');

  const op = await env.DB.prepare(
    `SELECT id, email, avatar_key, closed_at FROM operators WHERE id = ?`,
  ).bind(id).first<{
    id: string; email: string; avatar_key: string | null; closed_at: number | null;
  }>();
  if (!op) throw notFound('No such account.');
  if (op.closed_at) throw badRequest('That account is already closed.', 'already_closed');

  // Not while somebody is expecting them on Thursday.
  //
  // Closing deletes the conversations, so a customer with a paid booking would
  // lose the thread, the address they gave, the photographs and the only way
  // to reach the business — and find out by nobody arriving. Cancelling those
  // bookings first is a decision with a refund attached, and it belongs to the
  // operator making it rather than to a side effect of this function.
  const live = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM appointments
      WHERE operator_id = ? AND status = 'scheduled' AND ends_at > ?`,
  ).bind(id, now()).first<{ n: number }>();
  if ((live?.n ?? 0) > 0) {
    throw badRequest(
      `You still have ${live!.n} booking${live!.n === 1 ? '' : 's'} in the diary. `
      + 'Cancel or finish those first — closing now would leave those customers '
      + 'with nobody coming and no way to reach you.',
      'live_bookings',
    );
  }

  const removed: Record<string, number> = {};
  const add = (k: string, n: number) => { removed[k] = (removed[k] ?? 0) + n; };
  const t = now();

  // Their customers' conversation photographs, collected and deleted first.
  //
  // WHAT THIS WAS LEAVING BEHIND. Closing an account deletes the client list,
  // the conversations and the instant requests, because all of it is personal
  // data about OTHER PEOPLE that only existed because this account existed.
  // The photographs those people sent into those conversations are the same
  // thing and were the one part of it that nothing removed. `message_photos`
  // has no foreign keys — migration 0051, on purpose — so deleting the threads
  // below never touched these rows: they sat there naming a conversation that
  // no longer existed, and the bytes, which are the insides of strangers'
  // houses, stayed in the photo store until a cron tick happened past. The
  // operator was told their account was closed either way.
  //
  // FIRST IN THE FUNCTION, AND THE POSITION IS DOING TWO JOBS. The rows have
  // to go before `DELETE FROM threads` further down, because once the thread
  // is gone the only thing that can still find them is the orphan arm of the
  // sweep. And the refusal that happens when there is no photo store has to
  // happen before ANYTHING has been written, because a closure that gives up
  // half way through is a closure that has already deleted a portfolio and
  // emptied an operator's row with no way back. Everything above this line is
  // a SELECT, so refusing here leaves the account exactly as it was and the
  // operator can close it again when the store answers.
  //
  // `idx_message_photos_operator` exists for this query and, as 0051 says at
  // the index itself, for nothing else. operator_id is denormalised onto the
  // row precisely so that the keys can be asked for by business — one seek,
  // no created_at, all of them — before the threads that are otherwise the
  // only route back to them are deleted.
  add('message_photos', await eraseMessagePhotos(env, 'operator_id = ?', [id]));

  // The portfolio, stored bytes first so a failure cannot leave a row pointing
  // at a photo-store key that is gone. `delete` reads the same on Workers KV
  // as it did on R2, so this is untouched by the move between the two.
  const photos = await env.DB.prepare(
    `SELECT id, r2_key FROM work_photos WHERE operator_id = ?`,
  ).bind(id).all<{ id: string; r2_key: string }>();
  for (const p of photos.results ?? []) {
    if (env.PHOTOS) await env.PHOTOS.delete(p.r2_key).catch(() => {});
  }
  add('work_photos', changes(await env.DB.prepare(
    `DELETE FROM work_photos WHERE operator_id = ?`,
  ).bind(id).run()));
  if (op.avatar_key && env.PHOTOS) await env.PHOTOS.delete(op.avatar_key).catch(() => {});

  // Where they last were, and the trail of where they drove. Not a row, which
  // is exactly why it was being missed. See forgetVan.
  await forgetVan(env, id);

  // Other people's data that only existed because this account did.
  add('threads', changes(await env.DB.prepare(
    `DELETE FROM threads WHERE operator_id = ?`,
  ).bind(id).run()));
  add('clients', changes(await env.DB.prepare(
    `DELETE FROM clients WHERE operator_id = ?`,
  ).bind(id).run()));
  add('instant_requests', changes(await env.DB.prepare(
    `DELETE FROM instant_requests WHERE operator_id = ?`,
  ).bind(id).run()));
  add('messages', changes(await env.DB.prepare(
    `DELETE FROM messages WHERE operator_id = ?`,
  ).bind(id).run()));
  add('notifications', changes(await env.DB.prepare(
    `DELETE FROM notifications WHERE operator_id = ?`,
  ).bind(id).run()));

  // Nobody signs in to this account again, starting now.
  add('sessions', changes(await env.DB.prepare(
    `UPDATE sessions SET revoked_at = ? WHERE operator_id = ? AND revoked_at IS NULL`,
  ).bind(t, id).run()));
  add('login_tokens', changes(await env.DB.prepare(
    `DELETE FROM login_tokens WHERE operator_id = ?`,
  ).bind(id).run()));

  // The row itself. Emptied, not flagged.
  //
  // The email is set to a value that cannot be a mailbox rather than to NULL,
  // because the column is NOT NULL and carries a unique index: two closed
  // accounts both holding '' would collide and the second close would fail.
  //
  // ONE COLUMN IS DELIBERATELY NOT IN THIS LIST, AND IT IS NOT AN OVERSIGHT:
  // `stripe_account_id`. It is the mirror of `customer_accounts
  // .stripe_customer_id`, which IS cleared on both the customer's close and
  // their erasure, and the asymmetry is on purpose rather than the same bug
  // left on the other side of the product.
  //
  // What it points at is a Stripe Connect Express account holding this
  // person's legal name, their date of birth, whatever identity document
  // Stripe asked them for and their bank details. On the face of it that is
  // exactly the pointer an emptied row should not carry — and clearing it here
  // would strand their money. This function refuses to close while there are
  // BOOKINGS in the diary; it does not and cannot refuse while there is money
  // in flight, because a card can be captured and a transfer owed days after
  // the last job ends, and parts approved at the car are settled later still.
  // `settleDueWork` in checkout.ts finds those lines on the cron and pays them
  // to the account named in this column. Emptying it would leave a sole trader
  // permanently unpaid for work they had already done, with nothing left in
  // the database able to say where the money was supposed to go — the exact
  // failure migration 0047 exists about.
  //
  // So the honest state of it is: kept, on purpose, for as long as anything
  // might still be owed, and nothing clears it afterwards because nothing
  // looks again. WHAT IS MISSING is a sweep that revisits a closed operator
  // once every line of theirs has settled — no order_item of theirs with
  // `transfer_id IS NULL`, no parts_quote `approved AND charged_at IS NOT NULL
  // AND transfer_id IS NULL AND refund_id IS NULL`, nothing owed in lead_fees
  // — and clears it then. That belongs beside the sweeps at the top of this
  // file and it is not written here because getting its predicate wrong makes
  // somebody unpaid rather than merely over-retained, and the money path is
  // not this file's to decide. Section 7 of the privacy page says plainly that
  // Stripe keeps its own copy either way, which is the part that is true
  // whatever this column holds.
  add('operators', changes(await env.DB.prepare(
    `UPDATE operators SET
        email = ?, business_name = 'Closed business', trade = NULL, phone_e164 = NULL,
        home_address = NULL, home_lat = NULL, home_lng = NULL,
        tagline = NULL, bio = NULL, avatar_key = NULL, profile_slug = NULL,
        license_number = NULL, license_state = NULL, license_expires_at = NULL,
        insurer = NULL, policy_number = NULL, insurance_expires_at = NULL,
        background_check_name = NULL, background_check_provider = NULL,
        background_checked_at = NULL,
        vehicle_make = NULL, vehicle_model = NULL, vehicle_color = NULL,
        vehicle_plate = NULL,
        social_instagram = NULL, social_facebook = NULL, social_tiktok = NULL,
        payment_ref = NULL, payment_brand = NULL, payment_last4 = NULL,
        payment_added_at = NULL,
        is_published = 0, accept_public_bookings = 0, share_location = 0,
        online_until = NULL, online_since = NULL,
        plan = 'cancelled', closed_at = ?, updated_at = ?
      WHERE id = ?`,
  ).bind(`closed+${id}@invalid`, t, t, id).run()));

  await recordErasure(env, 'operator', op.email, sum(removed));
  return { removed };
}
