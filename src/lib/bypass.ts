import type { Env } from '../types';
import { threadByToken, type ThreadRef } from './chat';
import { formatMoney, localeFor } from './countries';
import { notify } from './feed';
import { redactContact } from './redact';
import { flag, holdStatement } from './settlement';
import {
  NEEDS_LOCATION_OPERATOR,
  NEEDS_PAYOUTS_OPERATOR, NEEDS_VEHICLE_OPERATOR, operatorStanding,
} from './standing';
import { getVehicle, vehicleComplete } from './startcode';
import { badRequest, conflict, newId, notFound, now } from './util';

/**
 * Stopping the doorstep bypass, and pricing it when it happens anyway.
 *
 * The hole this closes: an operator takes the booking, drives to the address
 * we found for them, stands outside, cancels in the app and does the job for
 * cash. Up to that moment the platform has done all of its work — found the
 * customer, priced the job, held the slot, carried the messages, delivered the
 * introduction to their door — and earned nothing. In the schema as it stood,
 * that cancellation was indistinguishable from one made three days earlier
 * from the sofa, which is the reason it was free.
 *
 * The fix is not a clause in a terms page. It is:
 *
 *   1. Record arrival, so "my van broke down this morning" and "I am outside
 *      your house" stop looking identical.
 *   2. Charge for the introduction at the one moment it has already been fully
 *      delivered — and only then.
 *   3. Make an unpaid fee stop the account listing, which is the only
 *      enforcement that works before any card is on file.
 *
 * A customer cancelling never owes this. They have no bypass available to
 * them: they did not receive a lead, they received a service they had already
 * paid for. A fee on them would be a cancellation charge wearing a costume.
 */

// ---------------------------------------------------------------------------
// What the introduction is worth
// ---------------------------------------------------------------------------
// One place, so changing the policy is changing three numbers and not hunting
// through branches. These are the starting values, not a law of nature. The
// bottom rung is a quarter of one job, which is under what every lead-selling
// service in this market charges for a lead that might not even answer the
// phone, and this one already booked and paid.

/**
 * ONE LADDER, USED BY BOTH SIDES: 25, then 75, then 100.
 *
 *      more than 48 hours out .... nothing ........ full refund
 *      12 to 48 hours out ........ owes a quarter . keeps three quarters
 *      inside 12 hours ........... owes three ..... keeps a quarter
 *                                  quarters
 *      turned up and walked, ..... owes all ....... keeps nothing
 *      or never showed
 *
 * The same three numbers price the operator's fee and the customer's
 * forfeiture, so the whole policy is one sentence to either side: whatever it
 * would cost them, it costs you.
 *
 * The rungs replace two cliffs. The customer's refund used to fall from half
 * to nothing at the twelve-hour mark -- cancel at 12h01m and get half back,
 * at 11h59m and get nothing -- which is a trapdoor rather than a rule, and
 * the sort of thing somebody screenshots. The operator's fee jumped the same
 * way in the other direction.
 *
 * The top rung is about ARRIVING, not the clock. An operator cancelling
 * eleven hours out never left the house; the customer can still rearrange,
 * and the slot often resells. One who parked outside, looked at the job and
 * drove off has taken the appointment away at the one moment nothing can be
 * done about it. Only that is worth the whole job -- and pricing every late
 * cancellation at 100% would punish the genuine breakdown exactly as hard,
 * which is the one that happens to good operators.
 */
export const LEAD_FEE_LATE_PERCENT = 25;
export const LEAD_FEE_LAST_HOURS_PERCENT = 75;
export const LEAD_FEE_DOORSTEP_PERCENT = 100;

/**
 * Below this the fee costs more in resentment than it collects.
 *
 * It is a floor under the PERCENTAGE, never above the job. See leadFeeCents:
 * on a job worth less than this the floor is the job's own price, because a
 * fee of $15 on a $10 job is 150% of it and the top rung of the ladder — the
 * one for standing on somebody's doorstep and driving off — is 100%.
 */
export const LEAD_FEE_MIN_CENTS = 15_00;

/**
 * There is no ceiling, deliberately.
 *
 * A cap is a price list for bypassing the platform: past it, the bigger the
 * job the better the maths for walking away, and the jobs worth walking away
 * from are exactly the big ones. Three quarters of a $900 job is $675 and it is
 * meant to be -- that operator was paid to be there.
 *
 * Worth knowing what this is: a liquidated-damages clause, and a court will
 * only enforce one that is a genuine estimate of the harm rather than a
 * punishment. The whole job is defensible on one delivered to the door, where
 * the customer has lost the appointment at the last moment nothing can be done
 * about it; the rungs below it are what keep the earlier cancellations
 * proportionate. It is the kind of term worth having a lawyer look at before
 * launch, and worth being able to waive when it is plainly wrong -- which is
 * why settleFee() has 'waived' in it.
 */

/**
 * The line: forty-eight hours before the appointment starts.
 *
 * ONE WINDOW, BOTH SIDES, AND THAT IS THE WHOLE POINT OF IT.
 *
 * Inside 48 hours the operator has turned other work away for that slot and
 * the customer has arranged their day around it. Neither can undo that for
 * free, and the rule is the same in both directions: whichever side walks away
 * owes a quarter of the job, and three quarters once it is inside 12 hours.
 * The customer pays theirs by not getting it back; the operator pays theirs as
 * a lead fee.
 *
 * Two hours -- what this used to be -- only ever caught the operator who
 * cancelled from the driveway. Forty-eight catches the one who took a better
 * job on Thursday for a slot they sold on Tuesday, which is the common case
 * and the one that actually costs a customer their day.
 *
 * Drawing the line only at a recorded arrival would make the whole rule
 * optional: an operator who never taps "I'm here" would never owe anything.
 */
export const DOORSTEP_WINDOW_SECONDS = 48 * 60 * 60;

/**
 * Beyond this the slot can genuinely be resold, so it goes back on the market.
 *
 * Shorter than the fee window on purpose. A slot 30 hours out is inside the
 * fee window -- the operator still owes -- but somebody can absolutely still
 * book it, and refusing to relist would waste a real opening to make a point.
 */
const RELISTABLE_SECONDS = 12 * 60 * 60;

// ---------------------------------------------------------------------------
// What the customer gets back
// ---------------------------------------------------------------------------

/** Inside this, only a quarter comes back. */
export const NO_REFUND_SECONDS = 12 * 60 * 60;

/** Between this and NO_REFUND_SECONDS, three quarters come back. */
export const HALF_REFUND_SECONDS = 48 * 60 * 60;

/** What the customer keeps at each rung. The operator's fee is the remainder. */
export const REFUND_LATE_PERCENT = 75;
export const REFUND_LAST_HOURS_PERCENT = 25;

/** How long after booking an obvious mistake can be undone for nothing. */
export const GRACE_SECONDS = 30 * 60;

/**
 * The floor under the grace window, and the reason it exists.
 *
 * Thirty minutes of grace on an appointment starting in forty-five is not
 * grace, it is a free cancellation on a job somebody is already driving to.
 * Grace is for the wrong-day, wrong-address, wrong-service mistake, which
 * costs the operator nothing because they have not moved yet — so it only
 * applies while there is still real time before the appointment.
 *
 * Three hours: enough that a mobile operator in Los Angeles has not set off,
 * planned their route around it, or turned down the job that would have filled
 * it. Book something starting sooner than that and it is yours from the moment
 * you book it, because you have asked a person to drop what they are doing.
 */
export const GRACE_FLOOR_SECONDS = 3 * 60 * 60;

export type RefundReason =
  | 'full' | 'grace' | 'most' | 'some' | 'none' | 'operator_cancelled';

export interface RefundDecision {
  reason: RefundReason;
  /** 25, 75 or 100 — the ladder never reaches zero. */
  percent: number;
  cents: number;
  /** What to tell the customer BEFORE they confirm, in their words. */
  message: string;
}

/** The longest a "why are you cancelling" box has ever been allowed to be. */
const MAX_REASON_CHARS = 300;

/**
 * Why somebody cancelled, as it is stored and shown to the other side.
 *
 * This box is the last thing either party types before the app stops being the
 * place they talk. "Cancelling -- call me on ... and we'll sort a time direct"
 * is the sentence, it is written by the person with the most reason to write
 * it, and until now it went into cancel_reason and into the other side's feed
 * row exactly as typed: the one free-text field left in the product that the
 * chat filter did not read. Same filter, same reason as chat.ts and
 * estimates.ts.
 *
 * Cleaned before the length cut, so a number sitting on the 300th character is
 * not left as a readable fragment. Null when nothing survives, because a stored
 * reason reading "[removed]" tells the other side less than no reason at all.
 */
function cancelReason(raw: string | null | undefined): string | null {
  const text = (raw ?? '').trim().slice(0, MAX_REASON_CHARS);
  return text ? (redactContact(text).body.trim() || null) : null;
}

/**
 * What comes back if this customer cancels right now.
 *
 * Pure and side-effect free, so the same function answers the "are you sure?"
 * screen and the cancellation itself. Two different bits of arithmetic for
 * those two questions is how a customer gets shown one number and refunded
 * another.
 */
export function refundFor(
  item: { starts_at: number; price_cents: number; created_at: number; arrived_at: number | null },
  at: number,
): RefundDecision {
  const until = item.starts_at - at;
  const sinceBooking = at - item.created_at;
  const pct = (p: number) => Math.round((item.price_cents * p) / 100);

  // Grace first, because it beats the tier it sits inside -- but only while
  // all three of its conditions hold. The arrival check is the airtight one:
  // whatever the clock says, somebody standing on the doorstep has already
  // done the driving.
  if (sinceBooking <= GRACE_SECONDS
      && until >= GRACE_FLOOR_SECONDS
      && item.arrived_at == null) {
    return {
      reason: 'grace', percent: 100, cents: item.price_cents,
      message: 'You booked this a few minutes ago, so you get all of it back.',
    };
  }

  if (until > HALF_REFUND_SECONDS) {
    return {
      reason: 'full', percent: 100, cents: item.price_cents,
      message: 'More than 48 hours away, so you get all of it back.',
    };
  }

  if (until > NO_REFUND_SECONDS) {
    return {
      reason: 'most', percent: REFUND_LATE_PERCENT,
      cents: pct(REFUND_LATE_PERCENT),
      message: 'This is inside 48 hours, so three quarters comes back. The '
        + 'business has been holding that time and may not be able to fill it '
        + 'now.',
    };
  }

  return {
    reason: 'some', percent: REFUND_LAST_HOURS_PERCENT,
    cents: pct(REFUND_LAST_HOURS_PERCENT),
    message: 'This starts within 12 hours, so a quarter comes back — the '
      + 'business has kept that time free and turned other work away for it. '
      + 'Message them instead: moving it is usually fine and is up to them.',
  };
}

/**
 * 'cancelled_late'       -- 12 to 48 hours out. A quarter.
 * 'cancelled_last_hours' -- inside 12 hours, but they never went. Three quarters.
 * 'cancelled_on_arrival' -- they drove there and walked. All of it.
 * 'no_show'              -- never applied automatically; see standing.ts.
 */
export type FeeReason =
  | 'cancelled_late' | 'cancelled_last_hours' | 'cancelled_on_arrival' | 'no_show';

export interface LeadFee {
  id: string;
  operator_id: string;
  order_item_id: string;
  cents: number;
  currency: string;
  reason: FeeReason;
  status: 'owed' | 'paid' | 'waived';
  note: string | null;
  /**
   * How much of it has already come off a payout. Shown to the operator, not
   * only counted, because a fee being paid down over two payouts is exactly
   * the case where a balance with no history of it looks like a second bill.
   */
  settled_cents: number;
  settled_at: number | null;
  created_at: number;
  updated_at: number;
}

const FEE_FIELDS =
  `id, operator_id, order_item_id, cents, currency, reason, status, note,
   settled_cents, settled_at, created_at, updated_at`;

/**
 * The fee for one job, from its booked price and how late the cancellation is.
 *
 * Never from the parts total. Parts the customer approved are money the
 * operator laid out on their behalf, and charging a share of that back would
 * be a fee on the alternator rather than on the introduction.
 *
 * The percentage is chosen by the SAME clock that decides the customer's
 * refund, so the two can never drift apart into a rule nobody can explain.
 */
export function leadFeeCents(jobCents: number, reason: FeeReason): number {
  // A job with no price has no introduction to charge for. The floor used to
  // apply here too, which billed an operator $15 for cancelling a service they
  // give away — a charge with no job behind it at all.
  const job = Math.max(0, Math.round(jobCents));
  if (job === 0) return 0;

  const percent = reason === 'cancelled_late'
    ? LEAD_FEE_LATE_PERCENT
    : reason === 'cancelled_last_hours'
      ? LEAD_FEE_LAST_HOURS_PERCENT
      : LEAD_FEE_DOORSTEP_PERCENT;

  // The floor lifts a small fee to something worth collecting; it must never
  // lift it past the whole job. 'Owes all of it' is the top of the ladder and
  // there is nothing above that, so a $10 job cancelled on the doorstep costs
  // $10 rather than the $15 the floor would otherwise have made of it.
  return Math.min(job, Math.max(LEAD_FEE_MIN_CENTS, Math.round((job * percent) / 100)));
}

interface ItemRow {
  id: string; order_id: string; operator_id: string;
  gap_id: string | null; appointment_id: string | null; client_id: string | null;
  starts_at: number; ends_at: number; price_cents: number; created_at: number;
  arrived_at: number | null; arrival_confirmed_at: number | null;
  code_verified_at: number | null; cancelled_at: number | null;
  /** Set once this line's share has left the platform for the operator's bank. */
  transfer_id: string | null;
  currency: string; guest_name: string | null; order_status: string;
}

const ITEM_SELECT =
  `SELECT oi.id, oi.order_id, oi.operator_id, oi.gap_id, oi.appointment_id, oi.client_id,
          oi.starts_at, oi.ends_at, oi.price_cents, oi.created_at,
          oi.arrived_at, oi.arrival_confirmed_at, oi.code_verified_at, oi.cancelled_at,
          oi.transfer_id,
          o.currency, o.guest_name, o.status AS order_status
     FROM order_items oi JOIN orders o ON o.id = oi.order_id`;

// ---------------------------------------------------------------------------
// Arrival
// ---------------------------------------------------------------------------

/**
 * "I'm here."
 *
 * Deliberately the same tap that tells the customer their van has arrived, so
 * it is not a button an operator can quietly never press: skipping it means
 * the customer is not told they have arrived, which they will ask about.
 * Arrival is recorded once and never moved — a second tap is a no-op rather
 * than a way to walk the timestamp forward after the fact.
 */
export async function markArrived(
  env: Env, operatorId: string, orderItemId: string,
): Promise<number> {
  const t = now();
  const res = await env.DB.prepare(
    `UPDATE order_items SET arrived_at = ?
      WHERE id = ? AND operator_id = ? AND arrived_at IS NULL AND cancelled_at IS NULL`,
  ).bind(t, orderItemId, operatorId).run();

  if ((res.meta.changes ?? 0) === 0) {
    const row = await env.DB.prepare(
      `SELECT arrived_at, cancelled_at FROM order_items WHERE id = ? AND operator_id = ?`,
    ).bind(orderItemId, operatorId).first<{ arrived_at: number | null; cancelled_at: number | null }>();
    if (!row) throw notFound('That booking is not yours.');
    if (row.cancelled_at) throw conflict('That booking was cancelled.', 'cancelled');
    return row.arrived_at!;   // already arrived; saying so is not an error
  }

  const item = await env.DB.prepare(
    `SELECT thread_id FROM (SELECT t.id AS thread_id FROM threads t
       JOIN order_items oi ON oi.appointment_id = t.appointment_id
      WHERE oi.id = ? AND t.operator_id = ? LIMIT 1)`,
  ).bind(orderItemId, operatorId).first<{ thread_id: string }>();

  if (item?.thread_id) {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO chat_messages (id, thread_id, sender, body, created_at)
         VALUES (?,?,'operator','They have arrived.',?)`,
      ).bind(newId(), item.thread_id, t),
      env.DB.prepare(
        `UPDATE threads SET last_message_at=?, guest_unread = guest_unread + 1,
           updated_at=? WHERE id=?`,
      ).bind(t, t, item.thread_id),
    ]);
  }

  return t;
}

// ---------------------------------------------------------------------------
// Cancelling
// ---------------------------------------------------------------------------

/**
 * Which fee, if any, this cancellation earns.
 *
 * Only two of the three reasons are decided here, and that is on purpose.
 * 'no_show' — the operator never arrived and never cancelled — is NOT raised
 * automatically anywhere in this file. An operator who did the job and forgot
 * to tap a button looks identical to one who never turned up, and billing the
 * first of those for the second is how a platform loses the operators it
 * cannot afford to lose. That reason exists in the schema for a person to
 * apply after reading a customer's report, not for a cron job to guess at.
 */
function feeFor(item: ItemRow, at: number): FeeReason | null {
  // Arrival first, and it is the only thing that reaches the full amount --
  // whatever the clock says. Somebody who drove there and left has done the
  // worst version of this.
  if (item.arrived_at != null) return 'cancelled_on_arrival';

  const until = item.starts_at - at;
  // The same two boundaries the customer's refund reads, so the two ladders
  // cannot drift into rules that need separate explaining.
  if (until <= NO_REFUND_SECONDS) return 'cancelled_last_hours';
  if (until <= HALF_REFUND_SECONDS) return 'cancelled_late';
  return null;
}

/**
 * Refuses a cancellation on a booking whose money has already gone out.
 *
 * THIS IS THE ONE THAT COSTS THE PLATFORM REAL MONEY. A $200 job finishes on
 * Monday, the sweep transfers $170 to the operator on Monday evening, and on
 * Tuesday somebody cancels — an operator tidying a calendar, a customer having
 * second thoughts about a job that already happened. refundFor sees a start
 * time in the past, returns 100%, the hold lifts a minute later because the
 * slot is long gone, and the customer is refunded the whole $200. The operator
 * keeps the $170. A Transfer that has landed in somebody's bank account is not
 * something this product can take back, so the $170 comes out of the platform,
 * silently, on a path where every screen involved looks completely ordinary.
 *
 * Refused rather than repriced, and deliberately: a cancellation whose only
 * honest outcome is "nothing happens" is not a cancellation, and telling
 * somebody so is better than recording one that changes nothing. Whatever
 * genuinely needs undoing after a payout is a refund somebody decides by hand,
 * with the operator's side of it in the conversation — which is the shape that
 * argument has anyway.
 */
function assertNotPaidOut(item: { transfer_id: string | null }): void {
  if (!item.transfer_id) return;
  throw conflict(
    'That booking has already been paid out to the business, so it cannot be '
    + 'cancelled here. Message them — anything owed after a payout has to be '
    + 'sorted out between you.',
    'already_paid_out',
  );
}

/**
 * Says why a guarded cancellation matched nothing, by reading the row rather
 * than assuming.
 *
 * Both cancel paths read the booking and then write it under a WHERE clause,
 * which is two round trips, so the loser of a race lands here — and the race
 * now has two possible winners. Another cancellation is one of them; the payout
 * sweep, which runs every quarter of an hour, is the other. "That booking is
 * already cancelled" is a false sentence for the second, and a customer told
 * their booking is cancelled when it is not is worse off than one told nothing.
 */
async function refuseCancellation(env: Env, orderItemId: string): Promise<never> {
  const row = await env.DB.prepare(
    `SELECT cancelled_at, transfer_id FROM order_items WHERE id = ?`,
  ).bind(orderItemId).first<{ cancelled_at: number | null; transfer_id: string | null }>();
  if (row && row.cancelled_at == null) assertNotPaidOut(row);
  throw conflict('That booking is already cancelled.', 'already_cancelled');
}

export interface CancelResult {
  order_item_id: string;
  fee: LeadFee | null;
  relisted: boolean;
  /** What the customer gets back. Always the full price when the operator cancels. */
  refund: RefundDecision;
}

/**
 * The operator cancels.
 *
 * Everything moves in one batch — the item, the appointment, the claim, the
 * gap and the fee — because a half-applied cancellation is the worst of every
 * world: a customer who still thinks they have a booking, a slot that is
 * neither sold nor for sale, or a fee raised against a cancellation that did
 * not go through.
 *
 * The unique index on lead_fees.order_item_id from migration 0022 is what
 * makes this safe to retry: a double-tapped cancel raises the fee once, and
 * the second attempt fails the whole batch rather than doubling somebody's
 * debt. The INSERT is written with OR IGNORE so a retry after a partial client
 * timeout reports the cancellation rather than an error about a fee.
 */
export async function cancelByOperator(
  env: Env, operatorId: string, orderItemId: string, reason?: string | null,
): Promise<CancelResult> {
  const t = now();
  const item = await env.DB.prepare(
    `${ITEM_SELECT} WHERE oi.id = ? AND oi.operator_id = ?`,
  ).bind(orderItemId, operatorId).first<ItemRow>();
  if (!item) throw notFound('That booking is not yours.');
  if (item.cancelled_at) throw conflict('That booking is already cancelled.', 'already_cancelled');
  assertNotPaidOut(item);

  const why = cancelReason(reason);
  const feeReason = feeFor(item, t);
  const relisted = item.gap_id != null && item.starts_at - t > RELISTABLE_SECONDS;

  // Whatever the clock says and whatever the operator owes, a customer whose
  // business cancelled gets everything back. The tiers below are about a
  // customer changing their mind; this is not that.
  const refund: RefundDecision = {
    reason: 'operator_cancelled', percent: 100, cents: item.price_cents,
    message: 'The business cancelled, so you get all of it back.',
  };

  const writes = [
    env.DB.prepare(
      // transfer_id in the WHERE as well as in the read above, because the two
      // are separate round trips and the payout sweep runs every quarter of an
      // hour: a transfer landing in between would otherwise be cancelled out
      // from underneath, which is the expensive case this guard is for.
      `UPDATE order_items SET cancelled_at=?, cancelled_by='operator', cancel_reason=?,
         address_released_at=NULL, refund_cents=?, refund_reason='operator_cancelled'
        WHERE id=? AND cancelled_at IS NULL AND transfer_id IS NULL`,
    ).bind(t, why, refund.cents, orderItemId),

    // Both sides freeze here, inside the same batch as the cancellation. A
    // booking that was cancelled but not frozen would refund on the next
    // sweep before anybody had been asked anything, which is the exact
    // behaviour this whole system exists to remove.
    holdStatement(env, orderItemId, t, item.starts_at),
    env.DB.prepare(
      `UPDATE appointments SET status='cancelled', cancelled_at=?, cancelled_by='operator',
         updated_at=? WHERE id=? AND status <> 'cancelled'`,
    ).bind(t, t, item.appointment_id),
    env.DB.prepare(
      `UPDATE public_claims SET status='cancelled', updated_at=? WHERE appointment_id=?`,
    ).bind(t, item.appointment_id),
    // The slot goes back on the market only when there is enough time for
    // somebody to actually take it. Relisting a slot starting in ninety
    // minutes advertises an appointment nobody can fill and that the customer
    // has already lost.
    env.DB.prepare(
      item.gap_id && relisted
        ? `UPDATE gaps SET status='open', filled_appointment_id=NULL, updated_at=? WHERE id=?`
        : `UPDATE gaps SET status='expired', filled_appointment_id=NULL, updated_at=? WHERE id=?`,
    ).bind(t, item.gap_id ?? ''),
    env.DB.prepare(
      `UPDATE operators SET calendar_version = calendar_version + 1, updated_at=? WHERE id=?`,
    ).bind(t, operatorId),
  ];

  let fee: LeadFee | null = null;
  if (feeReason) {
    fee = {
      id: newId(),
      operator_id: operatorId,
      order_item_id: orderItemId,
      cents: leadFeeCents(item.price_cents, feeReason),
      currency: item.currency,
      reason: feeReason,
      status: 'owed',
      note: feeReason === 'cancelled_on_arrival'
        ? 'Cancelled after arriving at the customer.'
        : feeReason === 'cancelled_last_hours'
          ? 'Cancelled within 12 hours of the appointment.'
          : 'Cancelled within 48 hours of the appointment.',
      settled_cents: 0,
      settled_at: null,
      created_at: t,
      updated_at: t,
    };
    // Conditional on THIS call being the one that cancelled the booking. The
    // first statement in the batch is guarded and may match nothing; an
    // unconditional insert after it raises a fee off a cancellation that did
    // not happen. The unique index would still keep it to one row, but a fee
    // is a debt, and a debt should exist because of a write that landed rather
    // than because the transaction it rode in on committed.
    writes.push(env.DB.prepare(
      `INSERT OR IGNORE INTO lead_fees (id, operator_id, order_item_id, cents, currency,
         reason, status, note, settled_at, created_at, updated_at)
       SELECT ?,?,?,?,?,?, 'owed', ?, NULL, ?, ?
        WHERE EXISTS (SELECT 1 FROM order_items
                       WHERE id = ? AND cancelled_at = ? AND cancelled_by = 'operator')`,
    ).bind(fee.id, operatorId, orderItemId, fee.cents, fee.currency, fee.reason,
      fee.note, t, t, orderItemId, t));
  }

  // ---------------------------------------------------------------------
  // WHERE THE TWO AMOUNTS RAISED HERE ACTUALLY GO.
  //
  // The money flow is not a shop's. The platform took the customer's payment
  // up front, holds it, and pays the operator after the job. So a cancellation
  // on the doorstep means the platform refunds the customer in full out of
  // money it is already holding, and eats the processing on both legs, while
  // the customer blames the platform rather than the operator. The fee is what
  // covers that, and it is not conditional on anything: a customer is refunded
  // in full whatever their operator owes.
  //
  // THE REFUND: frozen here, released when the hold lifts, and sent to the
  // card by sweepRefunds. refund_cents written below is what is sent.
  //
  // THE FEE: netted off the operator's next payout, in settleOrder. That is
  // money the platform is already holding on their behalf, so it costs nothing
  // to collect, it cannot fail, and it cannot be disputed the way a card debit
  // can — every gig platform settles this way for those reasons, and it is
  // what the Terms say happens. A payout smaller than the fee pays down what
  // it can and the rest comes off the one after; see applyFeesTo.
  //
  // THE CARD ON FILE IS STILL NOT CHARGED FOR A FEE, and it is the deliberate
  // second choice rather than an unbuilt one. A debit an operator did not
  // initiate is the most chargeback-prone transaction a platform can make, and
  // losing that dispute costs the fee plus the dispute fee. It is worth
  // building only for the operator who has no payout coming at all — a brand
  // new account, or one already paid out for everything — and until then that
  // fee sits owed and stops them listing, which is enforcement enough.
  // ---------------------------------------------------------------------

  const res = await env.DB.batch(writes);
  // The read above and the guarded write below it are two round trips, so two
  // cancellations racing on the same booking BOTH pass the `item.cancelled_at`
  // check and both reach here. Only one of them changes the row. Without this
  // the loser returned a refund figure and a fee object for a cancellation
  // that did not happen, and the payment seam above refunds `refund.cents`
  // against whatever this function hands back — which is the customer being
  // paid out twice for one booking.
  if ((res[0]?.meta.changes ?? 0) === 0) {
    await refuseCancellation(env, orderItemId);
  }

  // Recorded after the cancellation lands, never as part of it: a flag that
  // will not insert must not take down a cancellation that already happened.
  if (item.code_verified_at != null) {
    // The strongest thing this system can observe. To have entered that code
    // the operator stood next to the customer and read it off their phone --
    // not a tap they could have made from the end of the road. Cancelling
    // afterwards says the job never happened, which cannot be true and also
    // have the work done, unless it was done off the books.
    await flag(env, operatorId, orderItemId, 'confirmed_then_cancelled',
      'The start code was entered on the doorstep, then the job was cancelled.');
  } else if (item.arrival_confirmed_at != null) {
    // Weaker than the code but still two people, with opposite incentives,
    // both saying somebody was at the door.
    await flag(env, operatorId, orderItemId, 'confirmed_then_cancelled',
      'The customer confirmed they arrived, then the job was cancelled.');
  } else if (item.arrived_at != null) {
    const fix = await env.DB.prepare(
      `SELECT share_location FROM operators WHERE id = ?`,
    ).bind(operatorId).first<{ share_location: number }>();
    // Location is required to list at all now, so it being off at the moment
    // somebody cancels on a doorstep has no innocent version worth assuming.
    if (fix?.share_location !== 1) {
      await flag(env, operatorId, orderItemId, 'location_dark',
        'Location sharing was off when this was cancelled on arrival.');
    }
  }

  // If nothing in the order survives, the order is cancelled rather than left
  // reading 'pending' forever against a booking that no longer exists.
  await env.DB.prepare(
    `UPDATE orders SET status='cancelled', updated_at=?
      WHERE id=? AND NOT EXISTS (
        SELECT 1 FROM order_items WHERE order_id=? AND cancelled_at IS NULL)`,
  ).bind(t, item.order_id, item.order_id).run();

  return { order_item_id: orderItemId, fee, relisted, refund };
}

/**
 * The customer cancels.
 *
 * No fee, ever. A customer has no bypass available to them: they did not
 * receive a lead, they received a service they had already paid for, and a fee
 * on them would be a cancellation charge wearing a costume. What they carry
 * instead is how much of their own money comes back — see refundFor.
 *
 * THE CANCELLATION IS ALWAYS ALLOWED, including when nothing is refunded, and
 * that is a deliberate reversal of how this worked before. Refusing looked
 * protective and was not: the operator still drives out to a job nobody wants,
 * burns the fuel and the afternoon, and finds out on the doorstep. Letting the
 * cancellation through inside 12 hours means the operator keeps the whole
 * payment AND gets their afternoon back — strictly better for them than being
 * told to turn up anyway — while the customer loses exactly what they were
 * told they would lose before they confirmed.
 *
 * Authorised by the guest link and nothing else, like everything else the
 * customer does here.
 */
export async function cancelByCustomer(
  env: Env, ref: ThreadRef, orderItemId: string, reason?: string | null,
): Promise<CancelResult> {
  const t = now();
  const thread = await threadByToken(env, ref);
  if (!thread) throw notFound('That link is not valid any more.');

  const item = await env.DB.prepare(
    `${ITEM_SELECT}
      WHERE oi.id = ? AND oi.operator_id = ?
        AND oi.order_id = (SELECT order_id FROM order_items WHERE appointment_id = ? LIMIT 1)`,
  ).bind(orderItemId, thread.operator_id, thread.appointment_id).first<ItemRow>();
  if (!item) throw notFound('That booking is not on your order.');
  if (item.cancelled_at) throw conflict('That booking is already cancelled.', 'already_cancelled');
  assertNotPaidOut(item);

  const refund = refundFor(item, t);

  const why = cancelReason(reason);
  const relisted = item.gap_id != null && item.starts_at - t > RELISTABLE_SECONDS;

  // ---------------------------------------------------------------------
  // PAYMENT SEAM — the customer's refund, of refund.cents and no other figure.
  //
  // What is NOT refunded is not the platform's: it belongs to the operator,
  // who held that time and turned work away for it. When payouts exist, the
  // retained amount pays out to them as if the job had happened, because from
  // their side it may as well have.
  // ---------------------------------------------------------------------

  const res = await env.DB.batch([
    env.DB.prepare(
      // Guarded on transfer_id for the same reason the operator's side is: the
      // read and this write are two round trips, and a payout landing between
      // them must not be cancelled out from underneath.
      `UPDATE order_items SET cancelled_at=?, cancelled_by='customer', cancel_reason=?,
         address_released_at=NULL, refund_cents=?, refund_reason=?
        WHERE id=? AND cancelled_at IS NULL AND transfer_id IS NULL`,
    ).bind(t, why, refund.cents, refund.reason, orderItemId),

    // The customer's refund freezes too. The bypass in this direction is a
    // customer cancelling for a full refund and having the operator come
    // anyway for cash, so the question is whether the van turns up at that
    // address around the original slot -- which cannot be answered until the
    // slot has passed.
    holdStatement(env, orderItemId, t, item.starts_at),
    env.DB.prepare(
      `UPDATE appointments SET status='cancelled', cancelled_at=?, cancelled_by='client',
         updated_at=? WHERE id=? AND status <> 'cancelled'`,
    ).bind(t, t, item.appointment_id),
    env.DB.prepare(
      `UPDATE public_claims SET status='cancelled', updated_at=? WHERE appointment_id=?`,
    ).bind(t, item.appointment_id),
    env.DB.prepare(
      item.gap_id && relisted
        ? `UPDATE gaps SET status='open', filled_appointment_id=NULL, updated_at=? WHERE id=?`
        : `UPDATE gaps SET status='expired', filled_appointment_id=NULL, updated_at=? WHERE id=?`,
    ).bind(t, item.gap_id ?? ''),
    env.DB.prepare(
      `UPDATE operators SET calendar_version = calendar_version + 1, updated_at=? WHERE id=?`,
    ).bind(t, item.operator_id),
  ]);
  // Same read-then-write race as the operator's side, and the same reason it
  // matters: this function's return value is what the refund is issued
  // against, so a second cancellation that changed nothing must not come back
  // carrying a refund figure.
  if ((res[0]?.meta.changes ?? 0) === 0) {
    await refuseCancellation(env, orderItemId);
  }

  await env.DB.prepare(
    `UPDATE orders SET status='cancelled', updated_at=?
      WHERE id=? AND NOT EXISTS (
        SELECT 1 FROM order_items WHERE order_id=? AND cancelled_at IS NULL)`,
  ).bind(t, item.order_id, item.order_id).run();

  await notify(env, item.operator_id, {
    kind: 'booking_cancelled',
    title: `${thread.guest_name} cancelled`,
    body: why,
    appointment_id: item.appointment_id,
    thread_id: thread.id,
    starts_at: item.starts_at,
  });

  return { order_item_id: orderItemId, fee: null, relisted, refund };
}

/**
 * What a customer would get back if they cancelled right now.
 *
 * Read-only, for the confirmation screen. It is the same refundFor() the
 * cancellation itself uses, so the number somebody is shown and the number
 * they are refunded cannot disagree.
 */
export async function quoteRefund(
  env: Env, ref: ThreadRef, orderItemId: string,
): Promise<RefundDecision> {
  const thread = await threadByToken(env, ref);
  if (!thread) throw notFound('That link is not valid any more.');
  const item = await env.DB.prepare(
    `${ITEM_SELECT}
      WHERE oi.id = ? AND oi.operator_id = ?
        AND oi.order_id = (SELECT order_id FROM order_items WHERE appointment_id = ? LIMIT 1)`,
  ).bind(orderItemId, thread.operator_id, thread.appointment_id).first<ItemRow>();
  if (!item) throw notFound('That booking is not on your order.');
  return refundFor(item, now());
}

// ---------------------------------------------------------------------------
// What is owed, and what that stops
// ---------------------------------------------------------------------------

export interface FeesOwed {
  cents: number;
  currency: string | null;
  count: number;
  /** Ready to print. Empty string when nothing is owed. */
  amount: string;
}

export async function feesOwed(env: Env, operatorId: string): Promise<FeesOwed> {
  const row = await env.DB.prepare(
    // What is LEFT, not what was raised. A fee is collected off payouts and a
    // payout is often smaller than the fee, so a row can be half paid for days
    // — and an operator told they owe the whole $200 after $170 of it has
    // already been taken out of their money would reasonably conclude they were
    // being billed twice. See settled_cents in migration 0046.
    `SELECT COALESCE(SUM(cents - settled_cents),0) AS cents, COUNT(*) AS n,
            MIN(currency) AS currency
       FROM lead_fees WHERE operator_id = ? AND status = 'owed'`,
  ).bind(operatorId).first<{ cents: number; n: number; currency: string | null }>();

  const op = await env.DB.prepare(
    `SELECT country, language, currency FROM operators WHERE id = ?`,
  ).bind(operatorId).first<{ country: string; language: string; currency: string }>();

  const cents = row?.cents ?? 0;
  const currency = row?.currency ?? op?.currency ?? 'USD';
  return {
    cents,
    currency: cents > 0 ? currency : null,
    count: row?.n ?? 0,
    amount: cents > 0
      ? formatMoney(cents, currency, localeFor(op?.country ?? 'US', op?.language ?? 'en'))
      : '',
  };
}

/**
 * The one gate: may this operator put work up right now?
 *
 * Three things stop them, checked in the order a person would want to hear
 * them — the one they can fix in thirty seconds first, the one that needs a
 * decision from us last:
 *
 *   1. No card on file. Nothing can be charged, so nothing can be promised.
 *   2. An unpaid lead fee.
 *   3. A no-show suspension or a ban.
 *
 * NONE OF THEM TOUCH WORK ALREADY BOOKED. A customer who has paid gets their
 * appointment whatever their operator has done or owes, and cancelling their
 * job to punish the operator would mean the platform failing the exact person
 * it exists to protect. Every message below says so out loud, because an
 * operator who thinks their diary just got wiped will phone every customer on
 * it — off the platform, with the numbers they do not have.
 *
 * Returns null when they are clear, so callers read as a guard.
 */
export async function listingBlock(env: Env, operatorId: string): Promise<string | null> {
  // A CARD IS NOT REQUIRED OF A BUSINESS. This check used to sit right here
  // and it was wrong. What a business must have is somewhere to be PAID — the
  // bank account checked further down. Demanding a card on top means asking a
  // self-employed person to hand over a payment instrument before they have
  // earned a penny, against a late cancellation they have not made. That is
  // the wall people walk away at. They are encouraged to add one in settings,
  // and encouragement is where it stops.
  //
  // The customer side is the opposite and stays required: no card on file, no
  // booking. Theirs is the money that has to be there when the work is done.

  // Location moved from a feature to a requirement when it became the evidence
  // that decides whether somebody is charged. An operator with it off cannot
  // be told apart from one doing jobs off the books, so they cannot list.
  const loc = await env.DB.prepare(
    `SELECT share_location FROM operators WHERE id = ?`,
  ).bind(operatorId).first<{ share_location: number }>();
  if (loc?.share_location !== 1) return NEEDS_LOCATION_OPERATOR;

  // The van a customer is told to look for. Cheap to fill in, and the thing
  // somebody standing behind their own front door actually checks.
  if (!vehicleComplete(await getVehicle(env, operatorId))) return NEEDS_VEHICLE_OPERATOR;

  // SOMEWHERE TO SEND THE MONEY, and this is the gate that removes a whole
  // class of broken state rather than merely reporting one. Every booking is
  // paid up front and the business's share is transferred afterwards; a
  // business that can be booked without an account to transfer to leaves the
  // customer's money sitting in the platform balance with nowhere to go and
  // nothing in the product to resolve it. No account, no listing — so the
  // situation cannot arise. See NEEDS_PAYOUTS_OPERATOR.
  //
  // Deliberately reads the CACHED flag rather than calling Stripe. This runs
  // on every listing check; the flag is refreshed by the account.updated
  // webhook and whenever the operator opens their settings, and being an hour
  // stale here costs an operator an hour of listing rather than costing a
  // customer their money.
  const payouts = await env.DB.prepare(
    `SELECT stripe_payouts_enabled FROM operators WHERE id = ?`,
  ).bind(operatorId).first<{ stripe_payouts_enabled: number }>();
  if (payouts?.stripe_payouts_enabled !== 1) return NEEDS_PAYOUTS_OPERATOR;

  const owed = await feesOwed(env, operatorId);
  if (owed.cents > 0) {
    return `You have ${owed.amount} in unpaid lead fees from `
      + `${owed.count === 1 ? 'a booking you cancelled' : `${owed.count} bookings you cancelled`} `
      + 'late or after arriving. Settle that and your openings go straight back up. '
      + 'Anything already booked is unaffected — those customers still get their appointment.';
  }

  const standing = await operatorStanding(env, operatorId);
  if (standing.blocked) return standing.message;

  return null;
}

export async function listFees(
  env: Env, operatorId: string, limit = 50,
): Promise<LeadFee[]> {
  const rows = await env.DB.prepare(
    `SELECT ${FEE_FIELDS} FROM lead_fees WHERE operator_id = ?
      ORDER BY created_at DESC LIMIT ?`,
  ).bind(operatorId, Math.min(Math.max(1, Math.floor(limit)), 200)).all<LeadFee>();
  return rows.results ?? [];
}

/**
 * Settles a fee by hand.
 *
 * 'waived' exists because the first version of a rule like this is wrong about
 * somebody — the operator who arrived, found a dog loose in the yard and left,
 * and is now being billed for it. The alternative to a waiver is deleting the
 * row, which destroys the record of what happened along with the charge.
 *
 * NOT THE ORDINARY WAY A FEE IS PAID ANY MORE. It used to be the only way:
 * nothing in the product could collect one, so the comment here said 'paid'
 * was written by a charge that did not exist yet. A fee is now netted off the
 * business's next payout by settleOrder — which is what the Terms have always
 * said happens — and this is what is left: an appeal, a fee settled some other
 * way, a decision a person takes for a reason the schema does not hold.
 *
 * STILL REACHED BY NO ROUTE, and it is worth being exact about why rather than
 * leaving it looking forgotten. A waiver is an admin action, every admin action
 * in this Worker is written to admin_actions, and the action and subject kinds
 * that table accepts are a closed list in lib/audit.ts. Adding a door for this
 * means adding 'settle_fee' to that list in the same change — an unlogged
 * admin cancelling somebody's debt is precisely what that log exists to
 * prevent — so the route lands with the audit entry or not at all.
 *
 * 'paid' fills settled_cents in, so a fee marked paid here and one collected
 * off a payout describe themselves the same way to feesOwed. 'waived' leaves
 * it alone: whatever was already collected before somebody decided to waive
 * the rest really was collected, and rewriting it to the full amount would
 * claim money that never moved.
 */
export async function settleFee(
  env: Env, feeId: string, status: 'paid' | 'waived', note?: string | null,
): Promise<void> {
  if (status !== 'paid' && status !== 'waived') {
    throw badRequest('A fee is settled as paid or waived.', 'bad_status');
  }
  const t = now();
  const res = await env.DB.prepare(
    `UPDATE lead_fees SET status=?, settled_at=?, updated_at=?,
        settled_cents = CASE WHEN ? = 'paid' THEN cents ELSE settled_cents END,
        note = COALESCE(?, note)
      WHERE id=? AND status='owed'`,
  ).bind(status, t, t, status, (note ?? '').trim() || null, feeId).run();
  if ((res.meta.changes ?? 0) === 0) {
    throw conflict('That fee is already settled.', 'already_settled');
  }
}

// ---------------------------------------------------------------------------
// Collecting it off the next payout
// ---------------------------------------------------------------------------

/** One unpaid fee, as much of it as is still outstanding. */
export interface OwedFee {
  id: string;
  cents: number;
  /** How much has already come off earlier payouts. See migration 0046. */
  settled_cents: number;
}

/** What one payout takes off one fee, and what is left of the payout after. */
export interface FeeNetting {
  /** The transfer amount after the fees below have been taken off it. Never negative. */
  net: number;
  credits: Array<{ fee: OwedFee; take: number }>;
}

/**
 * The fees this business still owes, oldest first.
 *
 * Scoped to one currency because a payout is in one currency and a debt in
 * another cannot be taken out of it without an exchange rate this product does
 * not have and should not invent. A fee in the wrong currency stays owed and
 * keeps blocking the listing, which is the honest outcome: somebody has to
 * deal with it by hand.
 */
export async function unsettledFees(
  env: Env, operatorId: string, currency: string,
): Promise<OwedFee[]> {
  const rows = await env.DB.prepare(
    `SELECT id, cents, settled_cents FROM lead_fees
      WHERE operator_id = ? AND status = 'owed' AND currency = ?
        AND cents > settled_cents
      ORDER BY created_at`,
  ).bind(operatorId, currency).all<OwedFee>();
  return rows.results ?? [];
}

/**
 * How much of a payout goes to the fees owed against it.
 *
 * A TRANSFER NEVER GOES BELOW ZERO, which is the whole reason this is
 * arithmetic rather than a subtraction. The ladder's top rung is the whole job
 * while a payout is that job less the platform's share, so a doorstep
 * cancellation routinely costs more than the next payout can cover — and
 * "reduce the transfer by what they owe" taken literally would ask Stripe to
 * move a negative amount. What is not covered stays owed, keeps the account
 * from listing, and comes off the payout after that.
 *
 * Oldest debt first, so a business paying down several fees sees them close in
 * the order they were raised rather than at random.
 *
 * Pure, so the same arithmetic answers "what will this payout be" on a screen
 * and "what is this payout" in the transfer. Two versions of that sum is how a
 * business is quoted one figure and paid another.
 */
export function applyFeesTo(amount: number, fees: OwedFee[]): FeeNetting {
  let left = Math.max(0, Math.round(amount));
  const credits: FeeNetting['credits'] = [];
  for (const fee of fees) {
    if (left <= 0) break;
    const take = Math.min(left, Math.max(0, fee.cents - fee.settled_cents));
    if (take <= 0) continue;
    credits.push({ fee, take });
    left -= take;
  }
  return { net: left, credits };
}

/**
 * Credits one fee with what a payout just covered.
 *
 * Returned as a statement rather than run, so the credit goes into the SAME
 * batch as the rows recording the payout it came out of. A fee credited in its
 * own round trip is a fee that can be credited against a payout that then
 * failed to be written down, and the operator would have paid it twice.
 *
 * The WHERE clause carries the settled_cents THAT WAS READ, which is what makes
 * two sweeps racing on one payout safe: they both compute the same reduced
 * transfer, Stripe's idempotency key gives them one transfer between them, and
 * only the first credit matches a row. The second changes nothing instead of
 * collecting the same debt a second time.
 */
export function creditFeeStatement(
  env: Env, fee: OwedFee, take: number, at: number,
): D1PreparedStatement {
  const settled = fee.settled_cents + take;
  return env.DB.prepare(
    `UPDATE lead_fees
        SET settled_cents = ?,
            status = CASE WHEN ? >= cents THEN 'paid' ELSE status END,
            settled_at = CASE WHEN ? >= cents THEN ? ELSE settled_at END,
            updated_at = ?
      WHERE id = ? AND status = 'owed' AND settled_cents = ?`,
  ).bind(settled, settled, settled, at, at, fee.id, fee.settled_cents);
}

/**
 * Hands a credit back, for a payout that then did not happen.
 *
 * The credit above has to be CLAIMED before the transfer it is netted out of
 * is built, because it is the claim that stops two overlapping sweeps taking
 * the same debt out of two different payouts — a D1 batch does not roll back
 * because one statement matched nothing, so a credit sitting in the same batch
 * as the payout rows loses the race silently and the business is short. See
 * payLabour in checkout.ts.
 *
 * Claiming first means there is a moment where the debt is collected and the
 * money it was collected out of has not moved, and this is what closes it: if
 * the transfer fails or cannot be written down, the fee goes back to being
 * owed in full rather than being marked as paid by a payout that never
 * happened. Guarded on the value the claim wrote, so it can only ever undo
 * that exact claim and never somebody else's.
 */
export function releaseFeeStatement(
  env: Env, fee: OwedFee, take: number, at: number,
): D1PreparedStatement {
  const claimed = fee.settled_cents + take;
  return env.DB.prepare(
    `UPDATE lead_fees
        SET settled_cents = ?, status = 'owed', settled_at = NULL, updated_at = ?
      WHERE id = ? AND settled_cents = ?`,
  ).bind(fee.settled_cents, at, fee.id, claimed);
}
