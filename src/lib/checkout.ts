/**
 * TAKING THE MONEY, HOLDING IT, AND PASSING IT ON.
 *
 * Four steps, deliberately separate, because they fail in different ways and
 * at different times:
 *
 *   1. startPayment  — works out the fee, writes it down, and opens a charge.
 *                      The customer is still on our own page; nothing has been
 *                      taken yet.
 *   2. markPaid      — the charge succeeded. The order becomes confirmed. This
 *                      is driven by the webhook and never by the browser: a
 *                      customer who closes the tab the instant they pay must
 *                      still end up with a confirmed booking.
 *   3. settleOrder   — each business is paid what it earned, once the work is
 *                      behind it, less anything it owes. Separate from step 2
 *                      because a transfer can fail on its own (an account not
 *                      finished onboarding, say) and must be retryable without
 *                      touching the charge.
 *   4. refundItem    — a cancelled booking's money goes back to the card it
 *                      was taken from.
 *
 * AND TWO RECONCILERS UNDER ALL OF IT, because every step above depends on
 * somebody else's HTTP request arriving. reconcileUnpaidOrders asks Stripe
 * about orders whose webhook never came — markPaid had no other caller, so one
 * failed delivery window left a real charge reading as unpaid forever, with no
 * payout and no refund path. And refundItem asks what refunds Stripe already
 * holds before re-sending one, because an idempotency key protects a retry for
 * 24 hours and these sweeps run every quarter of an hour for as long as the
 * row exists.
 *
 * A CANCELLED BOOKING IS NOT THE END OF THE MONEY, and treating it as one was
 * how the largest amounts went missing. Once the freeze lifts, a cancellation
 * can owe the business (the three quarters a customer forfeits inside twelve
 * hours; the whole job when the customer says the work happened anyway) and it
 * can owe the customer a part as well as the labour, on a second charge the
 * labour's refund cannot reach. See payableCents and sweepPartsRefunds.
 *
 * PARTS ARE A SECOND CHARGE AND A SECOND TRANSFER, and they are not opened
 * here: a part is quoted and approved in the middle of a job, so parts.ts takes
 * that money at the moment the customer taps approve. What this file owns is
 * the other end of it — the same wait as the labour, then a transfer of its own.
 * It has to be its own transfer because one naming a source_transaction cannot
 * exceed that charge, and the part was paid for by a charge the labour's
 * transfer knows nothing about.
 *
 * THE MONEY WAITS NOW, AND IT DID NOT USE TO. Settlement ran straight off the
 * webhook — every business paid seconds after the card cleared and days before
 * anybody drove anywhere. Then the customer cancelled on Wednesday a job
 * booked for Friday, was owed all of it back, and the platform had already
 * sent that money into somebody's bank account: a Transfer is not a thing that
 * can be quietly pulled back, so the refund came out of the platform's own
 * pocket every time. A line is therefore paid out only once its appointment is
 * over AND the window in which a cancellation could still claim the money has
 * closed — see payoutDueAt — and the cron sweeps for the lines that have
 * reached that point. Nothing about the customer's booking changes; what
 * changes is that the platform is still holding the money on the day somebody
 * asks for it back.
 *
 * A BUSINESS THAT CANNOT BE PAID CANNOT BE CHARGED FOR. The charge is opened
 * only when every business in the basket has payouts switched on at Stripe,
 * because the alternative is a real card payment whose money then has nowhere
 * to go: settleOrder skips the business, no payout is possible and no refund
 * has been asked for, and the customer's money sits in the platform balance
 * with nothing in the product to resolve it.
 *
 * THE CUSTOMER NEVER LEAVES THIS SITE. No Checkout Session, no redirect. The
 * browser gets a client secret and the embedded form does the rest.
 *
 * EVERY STEP IS SAFE TO RUN TWICE. Webhooks are delivered more than once by
 * design, a customer will refresh a payment page, a cron sweep overlaps its own
 * previous pass, and a support person will replay an event. So: one
 * PaymentIntent per order enforced by a unique index, one Transfer per line
 * enforced by another, one Refund per line enforced by a third, and an
 * idempotency key on all three Stripe calls. A double charge, a double payout
 * or a double refund needs this database AND Stripe to fail at the same
 * moment.
 */

import type { Env } from '../types';
import {
  applyFeesTo, creditFeeStatement, releaseFeeStatement, unsettledFees,
} from './bypass';
import { refreshConnectAccount } from './connect';
import { feeForOrder, feeGroupKey, type FeeLine } from './fees';
import { WATCH_TAIL_SECONDS } from './settlement';
import {
  chargeIdOf, createPaymentIntent, createRefund, createTransfer, findTransferFor,
  getPaymentIntent, isIdempotencyConflict, refundsForIntent, stripeConfigured,
  stripeRefused, updatePaymentIntent,
} from './stripe';
import { localDayStart } from './tz';
import { badRequest, conflict, notFound, now } from './util';

interface OrderRow {
  id: string;
  status: string;
  currency: string;
  total_cents: number;
  email: string | null;
  payment_intent_id: string | null;
  charge_id: string | null;
  paid_at: number | null;
  fee_cents: number;
  /** The customer at Stripe, when this order was placed by a signed-in one. */
  stripe_customer_id: string | null;
}

interface ItemRow {
  id: string;
  operator_id: string;
  price_cents: number;
  starts_at: number;
  ends_at: number;
  timezone: string | null;
  stripe_account_id: string | null;
  /** The cached answer to "can this business be paid at all?" — see 0040. */
  payouts_enabled: number;
  business_name: string | null;
  transfer_id: string | null;
  fee_cents: number;
  settlement: string;
  cancelled_at: number | null;
  refund_cents: number | null;
  /** 'none' means this line was never part of the charge. See startPayment. */
  refund_reason: string | null;
  refund_id: string | null;
  /** The amount a previous pass decided to send, and the key it sent it under. */
  transfer_amount_cents: number | null;
  transfer_key: string | null;
}

async function loadOrder(env: Env, orderId: string): Promise<OrderRow> {
  const row = await env.DB.prepare(
    `SELECT o.id, o.status, o.currency, o.total_cents, o.email,
            o.payment_intent_id, o.charge_id, o.paid_at, o.fee_cents,
            a.stripe_customer_id
       FROM orders o
       LEFT JOIN customer_accounts a ON a.id = o.customer_account_id
      WHERE o.id = ?`,
  ).bind(orderId).first<OrderRow>();
  if (!row) throw notFound('That order does not exist.');
  return row;
}

/**
 * The lines of an order, each with the operator's timezone attached.
 *
 * The timezone is joined in because the fee ceiling is per business PER DAY,
 * and "day" has to mean the operator's own local day. A job at 8pm and one at
 * 9am the next morning are twelve hours apart and are two days; two jobs on
 * one afternoon are one day however far apart they were booked. Comparing UTC
 * timestamps would put a Los Angeles evening on tomorrow's date for most of
 * the working year.
 *
 * WHETHER A CANCELLED LINE IS A LINE DEPENDS ENTIRELY ON WHAT IS BEING ASKED,
 * which is why the caller has to say.
 *
 * Opening the charge asks "what work is happening", and a cancelled line is
 * not work: charging for it, giving it a share of the fee and transferring it
 * out would be paying a business for a job nobody is going to do.
 *
 * Paying a business asks a different question — "whose money is this now" —
 * and there the answer is often the operator's even though the booking is
 * cancelled. A customer cancelling inside twelve hours keeps a quarter and
 * the business keeps three quarters for the time it held; a customer who
 * answers that the work was done anyway gets nothing back and the business is
 * paid as though the job completed. For a long time both of those amounts were
 * simply stranded: the cancel path wrote the figure down, the docstrings said
 * out loud that it belonged to the operator, and every query that could have
 * moved it filtered the row out. See payableCents.
 */
async function loadItems(
  env: Env, orderId: string, opts: { includeCancelled?: boolean } = {},
): Promise<ItemRow[]> {
  const rows = await env.DB.prepare(
    `SELECT i.id, i.operator_id, i.price_cents, i.starts_at, i.ends_at, i.fee_cents,
            i.transfer_id, i.settlement, i.cancelled_at, i.refund_cents, i.refund_reason,
            i.refund_id, i.transfer_amount_cents, i.transfer_key,
            o.timezone, o.stripe_account_id,
            o.business_name, o.stripe_payouts_enabled AS payouts_enabled
       FROM order_items i
       LEFT JOIN operators o ON o.id = i.operator_id
      WHERE i.order_id = ?${opts.includeCancelled ? '' : ' AND i.cancelled_at IS NULL'}
      ORDER BY i.starts_at`,
  ).bind(orderId).all<ItemRow>();
  return rows.results ?? [];
}

/**
 * What this line is worth to the business, in cents, or null if not yet.
 *
 * A LIVE LINE is the price less the platform's share, which is what it has
 * always been.
 *
 * A CANCELLED LINE is the price less the platform's share less whatever is
 * going back to the customer. Three different paths arrive at a cancelled line
 * with money still owed to the business, and none of them could move it:
 *
 *   the customer cancelled late, so the ladder gives them back three quarters
 *   or a quarter and the rest is the operator's — bypass.ts says so in as many
 *   words, "pays out to them as if the job had happened";
 *
 *   the customer answered that the work was done anyway, so the refund is
 *   zeroed and settlement.ts says "the operator is paid as though the job
 *   completed";
 *
 *   a van was seen at the address after a customer cancellation, which the
 *   hold sweep settles the same way.
 *
 * NULL — not payable yet — covers the three states where paying would decide
 * something nobody has decided:
 *
 *   'held' means nobody has yet said whether the work happened, and paying the
 *   operator now would answer that in their favour without asking;
 *
 *   a refund that is owed and has not gone yet, because the customer's money
 *   has to leave before the remainder becomes the business's. Sending the
 *   business its share first would leave a failed refund to come out of the
 *   platform's own pocket, which is the whole reason payouts wait at all;
 *
 *   a line the charge never covered. startPayment writes refund_reason 'none'
 *   on a line cancelled before the card was touched, precisely to say "they
 *   get nothing back because they were never charged" — and a line nobody paid
 *   for is not money this platform is holding on anybody's behalf.
 */
function payableCents(item: ItemRow): number | null {
  if (!item.cancelled_at) return item.price_cents - item.fee_cents;
  if (item.settlement === 'held') return null;
  if (item.refund_reason === 'none') return null;
  const refund = item.refund_cents ?? 0;
  if (refund > 0 && !item.refund_id) return null;
  return Math.max(0, item.price_cents - item.fee_cents - refund);
}

/**
 * May the parts on this line be paid out to the business?
 *
 * Separate from payableCents because a cancelled line splits the two answers.
 * The labour ladder prices the TIME a business held and turned other work away
 * for, and on a late cancellation some of that is genuinely theirs. A part is
 * not time — it is a thing, fitted to a car or not fitted to it — and the only
 * record this product has of which of those happened is the settlement. So a
 * cancelled line settled 'withheld' means the work was done anyway and the
 * part goes to the business along with the rest of it, while one settled
 * 'released' means it was not, and the part is money the customer must get
 * back. That second case had no path at all: the labour was refunded, the $340
 * sitting on the quote's own charge was not, and the line being cancelled
 * meant nothing in the product ever looked at it again. See sweepPartsRefunds.
 */
const partsPayable = (item: ItemRow): boolean =>
  !item.cancelled_at || item.settlement === 'withheld';

/** The fee key for one line: the operator's own local day. */
const dayKey = (item: ItemRow): string =>
  String(localDayStart(item.starts_at, item.timezone ?? 'UTC'));

/**
 * Works out the fee for an order and writes it to every line.
 *
 * Exported because the price step shows the business what it will receive
 * before anybody has paid, and it must be the same arithmetic — a quoted
 * payout that disagrees with the transfer by a cent is a support ticket that
 * costs more than the cent.
 */
export function splitOrder(items: ItemRow[]): {
  total: number;
  byOperator: Map<string, number>;
  perItem: Map<string, number>;
} {
  const lines: FeeLine[] = items.map((i) => ({
    operator_id: i.operator_id,
    price_cents: i.price_cents,
    day: dayKey(i),
  }));
  const { total, byOperator, byGroup } = feeForOrder(lines);

  // SPREAD OVER THE DAY THE FEE WAS CAPPED ON, not over everything that
  // business is doing in the basket. The ceiling is per business per day
  // (lib/fees.ts) so each day's fee has to come back down onto that day's
  // lines and no others. Spreading the business's whole fee across all of its
  // lines by price alone gets the order total right and every single row
  // wrong: $600 and $600 on Monday capped at $150, plus $600 on Wednesday at
  // $90, is $75 / $75 / $90 — and the old arithmetic wrote $80 to all three.
  // Nothing catches that from the total, and those rows are what a business is
  // shown, what a cancelled line's payout is worked out from, and what the
  // price step quotes somebody before they ever book.
  //
  // Largest remainder within each day, so the last line of each day absorbs
  // the rounding and the parts always sum to exactly what was charged.
  const perItem = new Map<string, number>();
  for (const [key, fee] of byGroup) {
    const mine = items.filter((i) => feeGroupKey(i.operator_id, dayKey(i)) === key);
    const gross = mine.reduce((s, i) => s + Math.max(0, i.price_cents), 0);
    let assigned = 0;
    mine.forEach((item, idx) => {
      const share = idx === mine.length - 1
        ? fee - assigned
        : (gross === 0 ? 0 : Math.floor((fee * Math.max(0, item.price_cents)) / gross));
      assigned += share;
      perItem.set(item.id, share);
    });
  }
  return { total, byOperator, perItem };
}

export interface PaymentHandle {
  client_secret: string;
  payment_intent_id: string;
  amount_cents: number;
  currency: string;
  /** Already paid — the caller should show the confirmation, not a card form. */
  paid: boolean;
}

/**
 * Refuses a basket holding a business that has nowhere to be paid.
 *
 * THE GATE EXISTS FURTHER UP AND DOES NOT COVER THIS. listingBlock() in
 * bypass.ts says a business cannot put work up without payouts switched on,
 * but it is only consulted when an opening is posted or a profile published —
 * while the cron's detectGaps invents openings for anybody on a live plan, and
 * the public queries that show them filter on the plan, the suspension and the
 * "accept bookings" switch and nothing else. So a business that never finished
 * onboarding still appears on the map and can still be booked.
 *
 * Left alone, that ends in the worst state this product can reach: a real card
 * payment taken, settleOrder skipping the business every time it runs because
 * there is no account to transfer to, no refund asked for because nothing
 * looks wrong to the customer, and their money sitting in the platform balance
 * with nothing in the product that resolves it. Nobody is told, because from
 * every screen involved it looks like an ordinary confirmed booking.
 *
 * Refusing HERE, at the moment the charge is opened, is the cheapest place to
 * be wrong: the customer has not paid yet, the appointment is still theirs to
 * rearrange, and the business gets a message that names what is missing rather
 * than a payout that never arrives. The right long-term home for this is the
 * order path itself — a basket like that should never be bookable — but this
 * is the line the money crosses, and a check on the line the money crosses is
 * the one that cannot be walked around.
 *
 * Reads the cached flag, like listingBlock does and for the same reason: this
 * is refreshed by the account.updated webhook, and being an hour stale costs a
 * business an hour of bookings rather than costing a customer their money.
 */
function assertPayable(items: ItemRow[]): void {
  const unpayable = items.find((i) => i.payouts_enabled !== 1);
  if (!unpayable) return;
  throw conflict(
    `${unpayable.business_name ?? 'That business'} has not finished setting up `
    + 'payments yet, so we cannot take your money for it. Nothing has been '
    + 'charged. Message them, or pick another opening.',
    'operator_cannot_be_paid',
  );
}

/**
 * Writes down what this charge is for, at the moment the charge is set to it.
 *
 * One batch, so an order can never hold an intent without the fee that was
 * quoted against it. See migration 0040 on why the fee is stored and not
 * derived. The total comes down with it for the same reason: an order whose
 * stored total says one thing while the charge against it says another is the
 * row a support person reads when somebody asks what they were charged, and it
 * would be answering with a number nobody ever paid.
 *
 * Used by both the new-intent path and the resume path, which is the point of
 * it being a function. The two disagreeing is how a resumed payment came to
 * charge for a job that had been cancelled in the meantime.
 */
async function recordFeeSplit(
  env: Env, orderId: string, items: ItemRow[], amountCents: number, feeTotal: number,
  perItem: Map<string, number>, paymentStatus: string, intentId?: string,
): Promise<void> {
  const t = now();
  await env.DB.batch([
    intentId
      ? env.DB.prepare(
        `UPDATE orders SET payment_intent_id = ?, fee_cents = ?, payment_status = ?,
           total_cents = ?, updated_at = ? WHERE id = ?`,
      ).bind(intentId, feeTotal, paymentStatus, amountCents, t, orderId)
      : env.DB.prepare(
        `UPDATE orders SET fee_cents = ?, payment_status = ?, total_cents = ?,
           updated_at = ? WHERE id = ?`,
      ).bind(feeTotal, paymentStatus, amountCents, t, orderId),
    ...items.map((i) => env.DB.prepare(
      `UPDATE order_items SET fee_cents = ? WHERE id = ?`,
    ).bind(perItem.get(i.id) ?? 0, i.id)),
    // And a line this charge is not paying for carries no fee and is owed
    // nothing back, because nothing is being taken for it. Left as it was, the
    // cancellation's promise of a full refund would sit on a line that was
    // never charged, and the refund sweep would later hand the customer money
    // out of the charge for the job that IS going ahead — paying them back for
    // the work they are about to receive. 'none' is the honest reason, and it
    // is also what tells the payout sweep this line is not money the platform
    // is holding for anybody; see payableCents.
    env.DB.prepare(
      `UPDATE order_items SET fee_cents = 0, refund_cents = 0, refund_reason = 'none'
        WHERE order_id = ? AND cancelled_at IS NOT NULL`,
    ).bind(orderId),
  ]);
}

/**
 * Opens the charge for an order and hands the browser what it needs.
 *
 * Reuses an existing intent rather than making a second one. A customer who
 * refreshes the payment page, or comes back to it from their confirmation
 * link, is paying for the same appointments; a second intent against the same
 * order is how somebody gets charged twice for one booking.
 *
 * REUSED IS NOT THE SAME AS UNCHANGED, and it used to be. The appointments can
 * go away while the card form sits open — an operator cancels one of two jobs
 * in the hour between booking and paying — so a resumed intent is moved to
 * what is still happening before it is handed back. Returning it as it stood
 * charged a customer $200 for one $100 job, by the one route that looked like
 * it had already been dealt with.
 */
export async function startPayment(env: Env, orderId: string): Promise<PaymentHandle> {
  if (!stripeConfigured(env)) {
    throw badRequest('Card payments are not switched on yet.', 'stripe_unconfigured');
  }
  const order = await loadOrder(env, orderId);

  if (order.paid_at != null) {
    return {
      client_secret: '',
      payment_intent_id: order.payment_intent_id ?? '',
      amount_cents: order.total_cents,
      currency: order.currency,
      paid: true,
    };
  }

  const items = await loadItems(env, orderId);
  if (items.length === 0) throw badRequest('That order has nothing in it.', 'empty_order');

  // Checked before the held intent is handed back as well as before a new one
  // is opened, because a business can lose its payout account between the two.
  // Somebody who left a payment half-finished on Monday and came back to it on
  // Thursday would otherwise complete a charge into a business Stripe had
  // stopped paying in the meantime — the same dead end as never checking at
  // all, reached by the one route that looks like it had already been checked.
  assertPayable(items);

  const { total: feeTotal, perItem } = splitOrder(items);

  // WHAT IS STILL HAPPENING, WHICH IS NOT ALWAYS WHAT WAS BOOKED.
  //
  // orders.total_cents is the basket as it was placed and nothing lowers it
  // when a line is cancelled, so a customer whose operator cancelled one of
  // two jobs in the hour between booking and paying was charged for both — for
  // an appointment that no longer existed, on a card form that had no way of
  // telling them. The fee split already ignores cancelled lines (see
  // loadItems); the amount did not, which made the filter half a fix.
  //
  // Never MORE than the basket they agreed to, whatever the lines add up to.
  // If those two ever disagree in the other direction it is a bug in pricing,
  // and the safe side of a pricing bug is the customer's.
  const live = items.reduce((s, i) => s + Math.max(0, i.price_cents), 0);
  const amountCents = Math.min(order.total_cents, live);

  if (order.payment_intent_id) {
    const held = await getPaymentIntent(env, order.payment_intent_id);

    // An intent that has already taken the money, or is taking it right now:
    // do not open a second one and do not try to move the amount underneath a
    // bank that is already working on it. The webhook confirms it a moment
    // later, or reconcileUnpaidOrders does if that webhook never arrives.
    if (held.status === 'succeeded' || held.status === 'processing') {
      return {
        client_secret: held.client_secret,
        payment_intent_id: held.id,
        amount_cents: held.amount,
        currency: held.currency,
        paid: held.status === 'succeeded',
      };
    }

    // THE BASKET CAN SHRINK WHILE THE CARD FORM IS OPEN, and returning early
    // here meant it never shrank on the intent. Everything that makes a
    // resumed payment honest — the amount recomputed from the lines that are
    // still happening, the fee split rewritten, the refund promised on a line
    // this charge is no longer paying for taken back down to nothing — lived
    // only on the path that creates a NEW intent. So the customer who opened
    // the payment page for two jobs, had one cancelled, and came back to the
    // page they already had was charged $200 for one $100 job, out of the one
    // route that looked like it had already been handled.
    if (held.amount !== amountCents) {
      const moved = await updatePaymentIntent(env, held.id, {
        amountCents, feeCents: feeTotal, orderId,
      });
      await recordFeeSplit(env, orderId, items, amountCents, feeTotal, perItem, moved.status);
      return {
        client_secret: held.client_secret,
        payment_intent_id: moved.id,
        amount_cents: moved.amount,
        currency: moved.currency,
        paid: moved.status === 'succeeded',
      };
    }

    return {
      client_secret: held.client_secret,
      payment_intent_id: held.id,
      amount_cents: held.amount,
      currency: held.currency,
      paid: held.status === 'succeeded',
    };
  }

  const intent = await createPaymentIntent(env, {
    orderId,
    amountCents,
    currency: order.currency,
    feeCents: feeTotal,
    customerEmail: order.email,
    // So the card they added a moment ago is already in the form. See the note
    // on customerId in lib/stripe.ts: without it they are asked to type the
    // same card a second time, which reads as the first attempt having failed.
    customerId: order.stripe_customer_id,
  });

  await recordFeeSplit(env, orderId, items, amountCents, feeTotal, perItem, intent.status,
    intent.id);

  return {
    client_secret: intent.client_secret,
    payment_intent_id: intent.id,
    amount_cents: intent.amount,
    currency: intent.currency,
    paid: intent.status === 'succeeded',
  };
}

/**
 * The charge landed. Confirms the order.
 *
 * Driven by the webhook rather than by the browser, because the browser is the
 * one participant that can walk away: a customer who pays and immediately
 * closes the tab must still end up with a confirmed booking, and an operator
 * must not be left holding an appointment marked unpaid for money that was
 * taken.
 *
 * The CONFIRMATION carries `paid_at IS NULL`, so a redelivered event confirms
 * nothing twice and reports honestly that it changed nothing.
 *
 * THE CHARGE ID IS NOT UNDER THAT GUARD, and it used to be. charge_id is the
 * only thing that lets a transfer name source_transaction, which is what stops
 * Stripe moving a business's share before the charge behind it has settled —
 * and it arrives on the same event as the confirmation, from a field that is
 * sometimes an id and sometimes a whole expanded charge object. So the first
 * delivery could perfectly well confirm the order and write nothing usable
 * into that column, and with the guard in place no later delivery, no manual
 * replay and no reconciliation pass could ever put it right: every one of them
 * matched no row and reported success. The repair below is its own statement
 * and runs whatever the order's state is, and it treats anything that is not
 * a 'ch_' as the absence of an answer rather than as an answer.
 */
export async function markPaid(
  env: Env, paymentIntentId: string, chargeId: string | null, status = 'succeeded',
): Promise<{ order_id: string | null; changed: boolean }> {
  const order = await env.DB.prepare(
    `SELECT id, paid_at FROM orders WHERE payment_intent_id = ?`,
  ).bind(paymentIntentId).first<{ id: string; paid_at: number | null }>();
  if (!order) return { order_id: null, changed: false };

  const t = now();
  const writes = [
    env.DB.prepare(
      `UPDATE orders
          SET status = 'confirmed', paid_at = ?, charge_id = COALESCE(charge_id, ?),
              payment_status = ?, updated_at = ?
        WHERE id = ? AND paid_at IS NULL`,
    ).bind(t, chargeId, status, t, order.id),
  ];
  if (chargeId) {
    writes.push(env.DB.prepare(
      `UPDATE orders SET charge_id = ?, updated_at = ?
        WHERE id = ? AND COALESCE(substr(charge_id, 1, 3), '') <> 'ch_'`,
    ).bind(chargeId, t, order.id));
  }

  const res = await env.DB.batch(writes);
  return { order_id: order.id, changed: (res[0]?.meta?.changes ?? 0) > 0 };
}

/**
 * The orders whose money arrived and whose webhook did not.
 *
 * EVERY ORDER IN THIS PRODUCT IS CONFIRMED BY ONE HTTP REQUEST FROM SOMEBODY
 * ELSE'S SERVER, and there was nothing else. markPaid was reachable from the
 * webhook and from nowhere else; startPayment can see with its own eyes that
 * an intent says 'succeeded' and only reported it to the browser. So one bad
 * delivery window — an outage, a rotated signing secret, the 503 this Worker
 * itself returns while STRIPE_WEBHOOK_SECRET is unset — and orders.paid_at
 * stays NULL forever on a card that really was charged. Nothing pays the
 * business, because settleDueWork requires paid_at. Nothing refunds the
 * customer, because refundItem requires it too. The booking reads as unpaid to
 * everybody while the money sits in the platform balance, and no screen
 * anywhere says so.
 *
 * An hour is deliberately long. A customer at a card form can take minutes,
 * Stripe retries a failed webhook for days, and this is the backstop rather
 * than the primary path — asking Stripe about every intent a few seconds after
 * it was opened would be a lot of calls to find out what the webhook is about
 * to say anyway.
 *
 * Reads idx_orders_unpaid from migration 0040, which was created for exactly
 * this work queue and which nothing had ever read.
 */
export async function reconcileUnpaidOrders(env: Env, limit = 50): Promise<{
  checked: number; confirmed: number;
}> {
  if (!stripeConfigured(env)) return { checked: 0, confirmed: 0 };
  const rows = await env.DB.prepare(
    `SELECT id, payment_intent_id FROM orders
      WHERE paid_at IS NULL AND payment_intent_id IS NOT NULL AND created_at <= ?
      ORDER BY created_at
      LIMIT ?`,
  ).bind(now() - 3600, Math.min(Math.max(1, Math.floor(limit)), 200))
    .all<{ id: string; payment_intent_id: string }>();

  let confirmed = 0;
  const orders = rows.results ?? [];
  for (const row of orders) {
    try {
      const intent = await getPaymentIntent(env, row.payment_intent_id);
      if (intent.status === 'succeeded') {
        const out = await markPaid(env, intent.id, chargeIdOf(intent.latest_charge));
        if (out.changed) confirmed += 1;
      } else {
        // Not paid, and saying so on the row is the other half of this: an
        // order stuck at 'requires_payment_method' for a week is a basket
        // somebody abandoned, and it should look like one.
        await markPaymentFailed(env, intent.id, intent.status);
      }
    } catch (err) {
      // One order Stripe will not answer about must not stop the rest. The
      // next tick tries it again.
      console.error('unpaid reconcile failed', row.id, (err as Error).message);
    }
  }
  if (confirmed > 0) {
    console.warn(`orders confirmed by reconciliation, not by webhook: ${confirmed}`);
  }
  return { checked: orders.length, confirmed };
}

/** The charge did not land. Recorded, but the claim is not thrown away. */
export async function markPaymentFailed(
  env: Env, paymentIntentId: string, status: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE orders SET payment_status = ?, updated_at = ?
      WHERE payment_intent_id = ? AND paid_at IS NULL`,
  ).bind(status, now(), paymentIntentId).run();
}

export interface SettleResult {
  transferred: number;
  skipped: Array<{ operator_id: string; reason: string }>;
}

/**
 * The moment one line's money stops being at risk and becomes the business's.
 *
 * Two things have to be behind us, and the second is the one that was missing.
 * The appointment itself, obviously — nobody is paid for work that has not
 * happened. And then the tail settlement.ts watches after every slot, because
 * a cancellation arriving at the start time is still a cancellation, and a
 * customer whose van never turned up is answering that question in the hour
 * afterwards rather than the week before. Paying at the start time would put
 * the money out of reach at the exact moment the argument about it begins.
 *
 * WATCH_TAIL_SECONDS is deliberately borrowed rather than chosen again here.
 * It is already the answer to "how long after a slot do we keep watching
 * before calling it clean", and having a second number for the same question
 * is how a refund and a payout come to disagree about the same afternoon.
 */
export const payoutDueAt = (item: { ends_at: number }): number =>
  item.ends_at + WATCH_TAIL_SECONDS;

export interface SettleOptions {
  /**
   * Pay only the lines whose work is behind them. See payoutDueAt.
   *
   * OPT-IN, AND EVERY AUTOMATIC CALLER OPTS IN. settleDueWork — the cron sweep,
   * and the only thing in this Worker that settles an order without a person
   * asking — always passes it, so no transfer leaves the platform ahead of the
   * work in normal operation. What the flag leaves reachable is the deliberate
   * "pay this order out now" for a person holding facts the schema does not
   * have: an appointment everybody agrees happened but which was never marked,
   * a settlement replayed after an outage. That is a decision somebody takes
   * knowingly, and it should look different in the code from the sweep that
   * runs by itself every quarter of an hour.
   */
  onlyDue?: boolean;
}

/** One approved parts quote the customer has paid for and the business has not been paid for. */
interface PartsPayout {
  id: string;
  order_item_id: string;
  operator_id: string;
  amount_cents: number;
  /** The currency it was AGREED in, which is why it is on the quote and not read off the order. */
  currency: string;
  /** The second charge that funded it, named as the transfer's source. */
  charge_id: string | null;
}

/**
 * The parts on these lines that are charged, approved and not yet paid out.
 *
 * Read separately from the lines rather than joined onto them because parts are
 * separate money: a different charge, taken on a different day, against a
 * figure the customer approved on their phone rather than one they agreed to at
 * checkout. See migration 0046 on why it also has to be a separate transfer.
 */
async function loadDueParts(env: Env, itemIds: string[]): Promise<PartsPayout[]> {
  if (itemIds.length === 0) return [];
  const rows = await env.DB.prepare(
    `SELECT id, order_item_id, operator_id, charge_id, currency,
            parts_cents + labor_cents AS amount_cents
       FROM parts_quotes
      WHERE order_item_id IN (${itemIds.map(() => '?').join(',')})
        AND status = 'approved' AND charged_at IS NOT NULL AND transfer_id IS NULL
        AND refund_id IS NULL`,
  ).bind(...itemIds).all<PartsPayout>();
  return rows.results ?? [];
}

/**
 * Pays one business for the lines of one order that are now its money.
 *
 * Pulled out of settleOrder's loop so that a business whose labour payout has
 * to be abandoned half way — a debt another sweep claimed first, a transfer
 * Stripe refused — can be abandoned without also abandoning the parts it is
 * owed on the same order. Returns the reason rather than throwing, because one
 * business that cannot be paid must never stop the others.
 */
async function payLabour(env: Env, input: {
  operatorId: string;
  mine: ItemRow[];
  account: string;
  currency: string;
  chargeId: string | null;
  at: number;
}): Promise<{ transferred: number; skipped: string | null }> {
  const { mine, at } = input;
  const head = mine[0]!;
  const amount = mine.reduce((s, i) => s + (payableCents(i) ?? 0), 0);
  if (amount <= 0) return { transferred: 0, skipped: 'nothing_owed' };

  // Read inside the loop, not once for the order, because a business with two
  // orders settling in the same sweep must not have the same debt taken out of
  // both: the first pass writes the credit, and the second reads what is left
  // rather than the figure the first one saw.
  const owed = await unsettledFees(env, input.operatorId, input.currency);

  // THE PLAN: ONE AMOUNT, ONE KEY, DECIDED TOGETHER AND WRITTEN DOWN.
  //
  // Stripe refuses a key it has already seen if the parameters differ, and the
  // labour transfer's amount is not a fixed number — it is the payout less
  // whatever this business owed at the moment the sweep looked. So a transfer
  // that reached Stripe and whose write-back then failed used to deadlock
  // permanently: the next pass raised a new lead fee, or credited an old one,
  // recomputed a different figure, sent it under the same key, and got a 400
  // every quarter of an hour forever — with the money already gone and the
  // line still reading as unpaid. Keeping the pair on the row means the retry
  // is the same request, which is what an idempotency key is for: Stripe hands
  // back the transfer it already made instead of refusing to talk about it.
  const planned = head.transfer_amount_cents;
  const key = head.transfer_key ?? `tr:${head.id}`;
  // When a plan already exists, the fees to credit are whatever that plan
  // actually held back — not whatever is owed today, which may be more.
  const { net, credits } = planned == null
    ? applyFeesTo(amount, owed)
    : { net: planned, credits: applyFeesTo(Math.max(0, amount - planned), owed).credits };

  // THE DEBT IS CLAIMED BEFORE THE PAYOUT IS BUILT ON IT, in its own round
  // trip, and that ordering is the whole correctness argument here.
  //
  // creditFeeStatement guards on the settled_cents it read, so two sweeps
  // racing on one fee cannot both credit it — but a D1 batch does not roll
  // back because one of its statements matched nothing. Sitting in the same
  // batch as the payout rows, a credit that lost the race changed nothing
  // while the transfer it had already been netted out of went ahead anyway:
  // two overlapping ticks each took the same $60 off a different $100 payout,
  // the business received $40 and $40 instead of $40 and $100, and feesOwed
  // reported the fee settled in full. Claiming first turns that into a visible
  // refusal — nothing is sent, nothing is marked, and the next tick reads the
  // fee as already paid and hands over the whole payout.
  let claimed: typeof credits = [];
  if (credits.length > 0) {
    const res = await env.DB.batch(credits.map((c) => creditFeeStatement(env, c.fee, c.take, at)));
    claimed = credits.filter((_, i) => (res[i]?.meta?.changes ?? 0) > 0);
    if (claimed.length !== credits.length) {
      // Whatever did land is handed back, so a debt is never left half
      // collected against a payout that is not going to happen.
      if (claimed.length > 0) {
        await env.DB.batch(claimed.map((c) => releaseFeeStatement(env, c.fee, c.take, at)));
      }
      return { transferred: 0, skipped: 'fee_contended' };
    }
  }

  try {
    // A payout swallowed whole by what the business owes is not a transfer of
    // nothing — Stripe refuses a zero amount, and there is nothing to send
    // because all of it went to the debt. The lines are still marked as paid
    // out, against an id naming the fee rather than a Stripe object, because
    // otherwise the next sweep would take the same debt out of the same money
    // all over again.
    let paidOutId = `fees:${head.id}`;
    if (net > 0) {
      if (planned == null) {
        // Before the call, never after it. A plan written down only on success
        // is a plan that does not exist in exactly the case it is for.
        await env.DB.prepare(
          `UPDATE order_items SET transfer_amount_cents = ?, transfer_key = ?
            WHERE id = ? AND transfer_id IS NULL AND transfer_amount_cents IS NULL`,
        ).bind(net, key, head.id).run();
      }
      let transfer;
      try {
        transfer = await createTransfer(env, {
          // Keyed on the FIRST line, which is also the row the id is written
          // to, so a retry produces the same key and Stripe returns the
          // original transfer instead of making a second one.
          orderItemId: head.id,
          amountCents: net,
          currency: input.currency,
          destinationAccountId: input.account,
          chargeId: input.chargeId,
          idempotencyKey: key,
        });
      } catch (err) {
        if (!isIdempotencyConflict(err)) throw err;
        // Stripe is telling us this key has already moved money. Refusing the
        // request is it protecting us, so the answer is to go and find what it
        // made rather than to treat a transfer that HAPPENED as one that did
        // not and leave the business paid but the line unmarked forever.
        const existing = await findTransferFor(env, {
          destinationAccountId: input.account, orderItemId: head.id,
        });
        if (!existing) throw err;
        console.warn(`recovered an existing transfer for ${head.id}`);
        transfer = existing;
      }
      paidOutId = transfer.id;
    }

    await env.DB.batch(mine.map((i) => env.DB.prepare(
      `UPDATE order_items SET transfer_id = ?, transferred_at = ?
        WHERE id = ? AND transfer_id IS NULL`,
    ).bind(i.id === head.id ? paidOutId : `${paidOutId}:${i.id}`, at, i.id)));

    return { transferred: net > 0 ? 1 : 0, skipped: null };
  } catch (err) {
    // The money is already collected and sitting in the platform account, so
    // this is retryable and the next call picks it up. The debt claimed a
    // moment ago is handed back, because it was claimed against a payout that
    // did not get written down — and the plan above is what makes the retry
    // send the same request rather than a differently-priced one.
    console.error('transfer failed', input.operatorId, (err as Error).message);
    if (claimed.length > 0) {
      await env.DB.batch(claimed.map((c) => releaseFeeStatement(env, c.fee, c.take, at)))
        .catch((e) => console.error('fee release failed', input.operatorId, (e as Error).message));
    }
    return { transferred: 0, skipped: 'transfer_failed' };
  }
}

/**
 * Pays every business in an order what it earned.
 *
 * One transfer per business, not per line: a business with three jobs in an
 * order is owed one amount and should see one arrival in its account, not
 * three. The line rows each record their share, and the first unpaid line of
 * each business carries the transfer id — which is what the unique index on
 * that column protects.
 *
 * PARTS ARE PAID SEPARATELY, one transfer per approved quote, and that is
 * Stripe's rule rather than a preference: a transfer naming a source_transaction
 * cannot exceed that charge, and the part was paid for by a second charge the
 * labour's transfer knows nothing about. Two charges, two transfers.
 *
 * WHAT THE BUSINESS OWES COMES OFF IT FIRST. A late cancellation raises a lead
 * fee, the Terms say it is settled against the next payout, and for a long time
 * nothing in this product did that — settleFee existed and nothing called it.
 * The fee is netted off the LABOUR transfer only: parts money is what the
 * customer paid for a part the operator has already bought on their behalf, and
 * taking a debt out of that leaves them personally out of pocket for an
 * alternator. It is the same reason the platform's own fee is never taken off
 * parts.
 *
 * SKIPS RATHER THAN FAILS when a business cannot be paid yet. An operator who
 * has not finished onboarding has money waiting rather than a broken order,
 * and this can be called again the moment they finish. The customer's booking
 * is unaffected either way: they have paid and the work is confirmed.
 *
 * A LINE THAT IS FROZEN IS NOT PAID. settlement.ts freezes both sides of a
 * cancelled booking until somebody says whether the work happened anyway;
 * transferring the operator's share out from under that would decide the
 * question in their favour by paying them before it was asked.
 *
 * A LINE THAT IS CANCELLED OFTEN IS PAID, AND FOR A LONG TIME NEVER WAS. Once
 * the freeze lifts, a cancelled booking can still hold money that is plainly
 * the business's: the three quarters a customer forfeits by cancelling inside
 * twelve hours, or the whole job on a cancellation the customer says went
 * ahead anyway. Both were decided, written down, described in the code as the
 * operator's — and filtered out of every query that could have moved them.
 * payableCents is where that judgement now lives.
 *
 * WHETHER A BUSINESS CAN BE PAID IS ASKED OF STRIPE, not of the cached flag on
 * its row. Migration 0040 says so beside that column, for the reason it gives:
 * a stale 1 there is a transfer that fails after the customer has already been
 * charged, every quarter of an hour, with nothing surfacing it.
 */
export async function settleOrder(
  env: Env, orderId: string, opts: SettleOptions = {},
): Promise<SettleResult> {
  const order = await loadOrder(env, orderId);
  if (order.paid_at == null) {
    throw badRequest('That order has not been paid.', 'not_paid');
  }
  const t = now();
  // Cancelled lines included, because a cancelled line very often still holds
  // money that is the business's — see payableCents, which is what decides.
  const all = await loadItems(env, orderId, { includeCancelled: true });
  const payable = all.filter((i) => payableCents(i) != null);
  const items = opts.onlyDue ? payable.filter((i) => payoutDueAt(i) <= t) : payable;
  const parts = await loadDueParts(env, items.filter(partsPayable).map((i) => i.id));
  const skipped: SettleResult['skipped'] = [];
  let transferred = 0;

  const operators = [...new Set(items.map((i) => i.operator_id))];
  for (const operatorId of operators) {
    const mine = items.filter((i) => i.operator_id === operatorId && !i.transfer_id);
    const myParts = parts.filter((p) => p.operator_id === operatorId);
    if (mine.length === 0 && myParts.length === 0) continue;

    // Answered before anything is asked of Stripe. A cancelled line where the
    // customer got everything back leaves the business owed exactly nothing,
    // and there is no point checking whether somebody who is owed nothing can
    // be paid — this sweep runs every fifteen minutes and that would be a
    // network call per order per tick, forever.
    if (mine.reduce((s, i) => s + (payableCents(i) ?? 0), 0) <= 0 && myParts.length === 0) {
      skipped.push({ operator_id: operatorId, reason: 'nothing_owed' });
      continue;
    }

    const account = items.find((i) => i.operator_id === operatorId)!.stripe_account_id;
    if (!account) {
      skipped.push({ operator_id: operatorId, reason: 'no_connected_account' });
      continue;
    }

    // ASKED OF STRIPE, NOT OF THE CACHE, and migration 0040 says so beside the
    // column: "Anything that MOVES money re-reads Stripe rather than trusting
    // these." This did not. It checked that an account id existed and sent the
    // transfer, so an account Stripe had stopped paying — a failed bank
    // verification, a document that expired, a business Stripe restricted —
    // failed at the processor every fifteen minutes forever with nothing
    // anywhere saying why. The refresh also writes the answer back onto the
    // operator row, which is what makes it visible: their own settings page
    // and the listing gate both read that flag, so a business that cannot be
    // paid is told what is wrong instead of watching payouts silently stop.
    let payouts: boolean;
    try {
      payouts = (await refreshConnectAccount(env, operatorId)).payouts_enabled;
    } catch (err) {
      console.error('payout check failed', operatorId, (err as Error).message);
      skipped.push({ operator_id: operatorId, reason: 'payouts_unknown' });
      continue;
    }
    if (!payouts) {
      console.warn(`payouts are switched off at Stripe for ${operatorId}; money is waiting`);
      skipped.push({ operator_id: operatorId, reason: 'payouts_disabled' });
      continue;
    }

    if (mine.length > 0) {
      const out = await payLabour(env, {
        operatorId,
        mine,
        account,
        currency: order.currency,
        chargeId: order.charge_id ?? null,
        at: t,
      });
      transferred += out.transferred;
      if (out.skipped) skipped.push({ operator_id: operatorId, reason: out.skipped });
    }

    for (const quote of myParts) {
      if (quote.amount_cents <= 0) continue;
      try {
        const transfer = await createTransfer(env, {
          orderItemId: quote.order_item_id,
          partsQuoteId: quote.id,
          amountCents: quote.amount_cents,
          // The quote's own currency, not the order's. It is carried on the row
          // precisely so it cannot change underneath an approved quote, and
          // paying out in a different one from the one the customer was charged
          // in is a rounding argument nobody can win.
          currency: quote.currency,
          destinationAccountId: account,
          // The parts charge, not the checkout one. Naming the wrong charge
          // would ask Stripe to move the part's money out of the labour it
          // already paid out, which it refuses, and rightly.
          chargeId: quote.charge_id,
        });
        await env.DB.prepare(
          `UPDATE parts_quotes SET transfer_id = ?, transferred_at = ?, updated_at = ?
            WHERE id = ? AND transfer_id IS NULL`,
        ).bind(transfer.id, t, t, quote.id).run();
        transferred += 1;
      } catch (err) {
        console.error('parts transfer failed', quote.id, (err as Error).message);
        skipped.push({ operator_id: operatorId, reason: 'parts_transfer_failed' });
      }
    }
  }
  return { transferred, skipped };
}

/**
 * The payout sweep: every business whose work is now behind it, paid.
 *
 * This is what replaced settling from the webhook, and the change is the whole
 * point of it — the webhook fires when the card clears, which is days before
 * anybody drives anywhere, and money that has already been transferred cannot
 * fund the refund the customer asks for the next morning.
 *
 * Runs on the cron, so an order becomes payable within a quarter of an hour of
 * its last job finishing rather than at a moment anybody has to arrange. It is
 * safe to run on top of itself: every line that was paid on the last pass
 * carries a transfer id, the unique index refuses a second one, and Stripe
 * holds an idempotency key on the same row.
 *
 * ORDER BY the oldest work first, so a backlog after an outage drains in the
 * order businesses have been waiting rather than at random, and one business
 * whose transfers keep failing cannot starve the rest by sitting at the front
 * of every pass — it is skipped, the others are paid, and it is retried on the
 * next tick.
 */
export async function settleDueWork(env: Env, limit = 100): Promise<{
  orders: number; transferred: number; skipped: number;
}> {
  const t = now();
  const cutoff = t - WATCH_TAIL_SECONDS;
  const due = await env.DB.prepare(
    // TWO WORK QUEUES UNIONED, RATHER THAN ONE OR'd. This was a single scan
    // with `(transfer_id IS NULL OR EXISTS (... parts_quotes ...))` in it, and
    // an OR across two tables is a condition SQLite cannot answer from an
    // index: the partial index migration 0043 created for exactly this sweep
    // was inapplicable, so every quarter of an hour the query read every line
    // this product has ever sold and every quote ever raised against one. A
    // UNION of two queries that each match one index is the same set of orders
    // for the cost of the rows that are actually owed something.
    //
    // The first arm is a line nobody has been paid for. The second is the one
    // that has to exist alongside it: A LINE ALREADY PAID OUT CAN STILL OWE
    // PARTS, because a quote is approved and charged while the operator is
    // standing at the car and the customer has three days to answer it, so a
    // part can be paid for hours after the labour's transfer has gone.
    //
    // CANCELLED LINES ARE IN THE FIRST ARM NOW, and they were excluded. A
    // cancellation does not always mean nobody is owed anything: a customer
    // cancelling inside twelve hours keeps a quarter and the business keeps
    // three quarters, and a customer who answers that the work happened anyway
    // gets nothing back at all. Both figures were written down, described in
    // the code as the operator's, and then filtered out of the only query that
    // could have moved them. settleOrder decides which of them is really
    // payable; see payableCents.
    `SELECT id, MIN(oldest) AS oldest FROM (
        SELECT i.order_id AS id, i.ends_at AS oldest
          FROM order_items i
          JOIN orders o ON o.id = i.order_id
         WHERE i.transfer_id IS NULL
           AND i.ends_at <= ?
           AND i.settlement <> 'held'
           AND o.paid_at IS NOT NULL
           -- A cancelled line only belongs in this queue while there is
           -- actually something left on it. Nothing ever clears an untransferred
           -- line out of here, so a cancelled one that can never owe anybody
           -- anything — the charge never covered it, or the customer got all of
           -- it back — would sit in every sweep for the life of the row. The
           -- arithmetic is payableCents's, kept here only to bound the queue;
           -- what is really payable is still decided in settleOrder.
           AND (i.cancelled_at IS NULL
                OR (COALESCE(i.refund_reason, '') <> 'none'
                    AND i.price_cents - i.fee_cents - COALESCE(i.refund_cents, 0) > 0))
        UNION ALL
        SELECT i.order_id AS id, i.ends_at AS oldest
          FROM parts_quotes q
          JOIN order_items i ON i.id = q.order_item_id
          JOIN orders o ON o.id = i.order_id
         WHERE q.status = 'approved' AND q.charged_at IS NOT NULL
           AND q.transfer_id IS NULL AND q.refund_id IS NULL
           AND i.ends_at <= ?
           AND i.settlement <> 'held'
           AND o.paid_at IS NOT NULL
           -- Parts on a cancelled line are only the business's when the
           -- customer said the work happened anyway; otherwise they are being
           -- refunded and this sweep has no business holding the order open
           -- for them. See partsPayable.
           AND (i.cancelled_at IS NULL OR i.settlement = 'withheld')
      )
      GROUP BY id
      ORDER BY oldest
      LIMIT ?`,
  ).bind(cutoff, cutoff, Math.min(Math.max(1, Math.floor(limit)), 500))
    .all<{ id: string }>();

  let transferred = 0;
  let skipped = 0;
  const orders = due.results ?? [];
  for (const row of orders) {
    try {
      const res = await settleOrder(env, row.id, { onlyDue: true });
      transferred += res.transferred;
      skipped += res.skipped.length;
    } catch (err) {
      // One broken order does not get to stop the sweep. Nothing has been
      // written for it, so the next tick tries it again.
      console.error('settle sweep failed', row.id, (err as Error).message);
    }
  }
  return { orders: orders.length, transferred, skipped };
}

// ---------------------------------------------------------------------------
// Giving it back
// ---------------------------------------------------------------------------

interface RefundRow {
  id: string;
  order_id: string;
  refund_cents: number | null;
  refund_id: string | null;
  refund_attempts: number;
  refund_error: string | null;
  settlement: string;
  /** Set means this line's share is already in the business's bank account. */
  transfer_id: string | null;
  fee_cents: number;
  payment_intent_id: string | null;
  paid_at: number | null;
}

export type RefundOutcome =
  | { refunded: true; refund_id: string; amount_cents: number; already: boolean }
  | {
    refunded: false;
    reason: 'unknown_item' | 'nothing_owed' | 'still_held' | 'not_paid' | 'already_paid_out';
  };

/**
 * Records a refund that did not happen, so that a refund which is not
 * happening looks like one.
 *
 * The failure this product can least afford to keep quiet is this one: the
 * customer has already been told, on their own cancellation screen, how much
 * is coming back. A refund that silently never leaves is indistinguishable to
 * them from being robbed, and the first anybody here would hear of it is a
 * chargeback.
 *
 * THE ATTEMPT COUNTER ONLY MOVES ON A DEFINITE REFUSAL, which is a question
 * only Stripe's own classification of the error can answer — see stripeRefused
 * in stripe.ts for why the status code cannot. A refusal means Stripe read the
 * request and created nothing, so the next attempt is safe to send under a new
 * idempotency key, which is what stops the day's first failure being replayed
 * for 24 hours. Anything else is an outcome nobody knows: the refund may well
 * exist, so the counter stays where it is and the retry goes out under the
 * SAME key, where Stripe deduplicates it rather than paying the customer
 * twice. Migration 0043 has the long version.
 *
 * `refused` can be forced, and the one caller that forces it is the write-back
 * failing AFTER Stripe has already given the money back. That is the case
 * where we know more than the error does: the refund exists, so the counter
 * must not move however the database phrased its complaint.
 */
async function recordRefundFailure(
  env: Env, orderItemId: string, err: unknown, refused = stripeRefused(err),
): Promise<void> {
  const message = `${(err as Error)?.message ?? 'The refund failed.'}`.slice(0, 300);
  console.error('refund failed', orderItemId, message);
  await env.DB.prepare(
    `UPDATE order_items
        SET refund_error = ?, refund_attempts = refund_attempts + ?
      WHERE id = ? AND refund_id IS NULL`,
  ).bind(message, refused ? 1 : 0, orderItemId).run();
}

/**
 * The refund Stripe is already holding for this line, if there is one.
 *
 * ASKED BEFORE A SECOND ATTEMPT, NEVER BEFORE THE FIRST. An idempotency key
 * protects a retry for 24 hours and this sweep runs every fifteen minutes for
 * as long as the row exists, so a refund that succeeded at Stripe and whose
 * write-back then failed is safe for a day and duplicated on the day after.
 * The row cannot answer whether that happened — nothing was written, which is
 * the whole problem — so Stripe is asked instead, and the answer is matched on
 * the line id that createRefund puts in the refund's metadata.
 */
async function recordedElsewhere(
  env: Env, row: RefundRow,
): Promise<{ id: string; amount: number } | null> {
  const held = await refundsForIntent(env, row.payment_intent_id!);
  return held.find((r) => r.metadata?.order_item_id === row.id
    && r.status !== 'failed' && r.status !== 'canceled') ?? null;
}

/**
 * Gives one cancelled booking's money back, once and only once.
 *
 * WHAT WAS MISSING. refund_cents has been written at every cancellation since
 * migration 0024 and read back to the customer on the screen that asks them to
 * confirm — "More than 48 hours away, so you get all of it back" — and no
 * money has ever moved. The figure was a decision nothing carried out.
 *
 * WHY THE REFUND IS NOT ISSUED AT THE CANCELLATION ITSELF. Both cancel paths
 * in bypass.ts freeze the line in the same batch that cancels it, because an
 * instant refund is exactly what made the doorstep bypass profitable: cancel
 * in the app, get the money back, have the work done for cash anyway. So the
 * refund belongs at the moment the freeze LIFTS — when the customer answers
 * that the work never happened, or when the hold runs out with no evidence
 * against it. That is settlement.ts's decision to make, and this is called
 * once it has been made.
 *
 * ONCE AND ONLY ONCE is four things together, because each one alone has a
 * hole in it. The row is read first and a line that already carries a refund
 * id is left alone. The write back is conditional on that column still being
 * empty. The unique index from 0043 sits under both, so two sweeps overlapping
 * cannot both succeed. Stripe's own idempotency key closes the seconds between
 * this reading the row and writing to it — and recordedElsewhere closes the
 * day after that key expires, which is the gap a failed write-back falls into.
 *
 * A LINE THAT HAS BEEN PAID OUT IS NOT REFUNDABLE FROM HERE. The money is in
 * somebody's bank account; a refund against it would come out of the platform
 * and not out of the operator. Both cancel paths refuse a transferred line for
 * the same reason, and this is the backstop under them.
 */
export async function refundItem(env: Env, orderItemId: string): Promise<RefundOutcome> {
  const row = await env.DB.prepare(
    `SELECT i.id, i.order_id, i.refund_cents, i.refund_id, i.refund_attempts,
            i.refund_error, i.settlement, i.transfer_id, i.fee_cents,
            o.payment_intent_id, o.paid_at
       FROM order_items i
       JOIN orders o ON o.id = i.order_id
      WHERE i.id = ?`,
  ).bind(orderItemId).first<RefundRow>();

  if (!row) return { refunded: false, reason: 'unknown_item' };

  // Already given back. Said as a success rather than an error: a second
  // webhook, a second tap on the same button and a sweep overlapping its own
  // previous pass are all ordinary, and none of them is a problem.
  if (row.refund_id) {
    return {
      refunded: true,
      refund_id: row.refund_id,
      amount_cents: row.refund_cents ?? 0,
      already: true,
    };
  }

  const owed = row.refund_cents ?? 0;
  if (owed <= 0) return { refunded: false, reason: 'nothing_owed' };
  // Still frozen: nobody has said yet whether the work happened anyway.
  if (row.settlement === 'held') return { refunded: false, reason: 'still_held' };
  // Nothing was ever taken, so there is nothing to hand back. An order that
  // was cancelled before the card cleared is the ordinary way to get here.
  if (row.paid_at == null || !row.payment_intent_id) {
    return { refunded: false, reason: 'not_paid' };
  }

  // CAPPED AT WHAT IS STILL HERE. Once a line has been paid out, the only part
  // of its price the platform is still holding is its own fee — the rest is in
  // the operator's bank account and a Transfer is not something that can be
  // quietly pulled back. Refunding the full price on top of that would be the
  // platform buying the customer out of a booking with its own money, which is
  // the exact hole this whole wait-before-paying design exists to close.
  const ceiling = row.transfer_id ? Math.max(0, row.fee_cents) : owed;
  const amount = Math.min(owed, ceiling);
  if (amount <= 0) return { refunded: false, reason: 'already_paid_out' };

  let refund: { id: string; amount: number; status: string } | null = null;

  // An attempt has been made before and we do not know how it ended. Ask
  // Stripe what it holds before sending anything, because the 24-hour life of
  // an idempotency key is shorter than the life of this row.
  if (row.refund_error != null || row.refund_attempts > 0) {
    const already = await recordedElsewhere(env, row);
    if (already) refund = { ...already, status: 'succeeded' };
  }

  if (!refund) {
    try {
      refund = await createRefund(env, {
        orderId: row.order_id,
        orderItemId: row.id,
        paymentIntentId: row.payment_intent_id,
        amountCents: amount,
        attempt: row.refund_attempts,
      });
    } catch (err) {
      await recordRefundFailure(env, row.id, err);
      throw err;
    }
  }

  // THE WRITE IS INSIDE THE TRY TOO, and it was not. The money has left at
  // this point; a database that refuses the row recording that — an isolate
  // evicted, D1 unavailable for a second, a constraint nobody expected — used
  // to throw straight past recordRefundFailure, so refund_error stayed NULL,
  // the attempt counter stayed put, and the line looked exactly like one that
  // had never been tried. The sweep then sent it again, and a day later the
  // idempotency key was gone and Stripe made a second refund.
  let res;
  try {
    res = await env.DB.prepare(
      `UPDATE order_items SET refund_id = ?, refunded_at = ?, refund_error = NULL
        WHERE id = ? AND refund_id IS NULL`,
    ).bind(refund.id, now(), row.id).run();
  } catch (err) {
    // Forced, because we know what the error does not: the refund exists. The
    // counter must not move, so the next attempt reads it back from Stripe.
    await recordRefundFailure(env, row.id,
      new Error(`The refund went through and could not be written down: `
        + `${(err as Error)?.message ?? 'unknown'}`), false);
    throw err;
  }

  return {
    refunded: true,
    refund_id: refund.id,
    amount_cents: refund.amount ?? amount,
    // Nothing changed here means another pass wrote the same refund's id a
    // moment ago. The customer has their money either way.
    already: (res.meta?.changes ?? 0) === 0,
  };
}

/**
 * The refund sweep: every released hold whose money has not gone back yet.
 *
 * Paired with 'settle holds' on the cron and running straight after it, so a
 * hold that lifts on one tick is refunded on the same tick. settleExpiredHolds
 * writes the decision; this is what makes the decision money. The two are
 * separate because settling a hold is a judgement about what happened and a
 * refund is a request to a payment processor that can fail on its own — and a
 * network failure at Stripe must not be able to leave a hold unsettled.
 *
 * A line that failed before is retried here rather than parked. Most reasons a
 * refund fails are temporary, and the one that is not — a charge Stripe will
 * never refund — shows up as the same message every quarter of an hour in the
 * count this returns, which is the point of keeping it.
 */
export async function sweepRefunds(env: Env, limit = 100): Promise<{
  refunded: number; failed: number; retried: number;
}> {
  const due = await env.DB.prepare(
    `SELECT i.id, i.refund_error
       FROM order_items i
       JOIN orders o ON o.id = i.order_id
      WHERE i.refund_id IS NULL
        AND i.refund_cents > 0
        AND i.settlement = 'released'
        -- A LINE ALREADY PAID OUT IS NOT REFUNDED FROM HERE. The operator's
        -- share is in their bank account and cannot be pulled back, so a
        -- refund against it would come out of the platform rather than out of
        -- them. Both cancel paths refuse a transferred line outright; this is
        -- the sweep's half of the same rule, and it is also what keeps the
        -- ordering honest for a cancelled line that owes BOTH — the customer
        -- is paid back first and the business's remainder is transferred
        -- afterwards, never the other way round. See payableCents.
        AND i.transfer_id IS NULL
        AND o.paid_at IS NOT NULL
        AND o.payment_intent_id IS NOT NULL
      ORDER BY i.cancelled_at
      LIMIT ?`,
  ).bind(Math.min(Math.max(1, Math.floor(limit)), 500))
    .all<{ id: string; refund_error: string | null }>();

  const rows = due.results ?? [];
  // Counted before anything is attempted: these are the ones that have already
  // been refused at least once, and a number that stays the same tick after
  // tick is a refund somebody has to look at by hand.
  const retried = rows.filter((r) => r.refund_error != null).length;
  let refunded = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const out = await refundItem(env, row.id);
      if (out.refunded) refunded += 1;
    } catch {
      // Already recorded on the row by recordRefundFailure, and one refund
      // that will not go through must not stop the others.
      failed += 1;
    }
  }
  if (retried > 0) {
    console.warn(`refunds retried after an earlier failure: ${retried}`);
  }
  return { refunded, failed, retried };
}

/**
 * The parts refund sweep: money taken for a part on a booking that was then
 * cancelled and settled as not having happened.
 *
 * THERE WAS NO PATH FOR THIS AT ALL. A part is a second charge against a second
 * intent — see migration 0046 — and every refund in this file works off
 * orders.payment_intent_id, which is the labour. So a customer who approved a
 * $340 alternator on Monday and whose operator cancelled on Tuesday got the
 * labour back and not the part, and because the line was cancelled nothing in
 * the product ever looked at that quote again. The customer was $340 down with
 * a screen telling them they had been refunded in full.
 *
 * ONLY WHERE THE WORK IS AGREED NOT TO HAVE HAPPENED. A line settled
 * 'withheld' is one the customer confirmed was done anyway, and the part was
 * fitted to their car; that one is paid to the business by settleOrder. A line
 * still 'held' has not been decided and waits. See partsPayable.
 *
 * ONLY WHERE IT HAS NOT ALREADY BEEN PAID OUT, for the same reason the labour
 * sweep refuses a transferred line: the money is in somebody's bank account
 * and refunding it would come out of the platform.
 */
export async function sweepPartsRefunds(env: Env, limit = 100): Promise<{
  refunded: number; failed: number;
}> {
  const due = await env.DB.prepare(
    `SELECT q.id, q.order_item_id, q.payment_intent_id, q.refund_attempts,
            q.parts_cents + q.labor_cents AS amount_cents, i.order_id
       FROM parts_quotes q
       JOIN order_items i ON i.id = q.order_item_id
      WHERE q.status = 'approved'
        AND q.charged_at IS NOT NULL
        AND q.payment_intent_id IS NOT NULL
        AND q.transfer_id IS NULL
        AND q.refund_id IS NULL
        AND i.cancelled_at IS NOT NULL
        AND i.settlement = 'released'
      ORDER BY i.cancelled_at
      LIMIT ?`,
  ).bind(Math.min(Math.max(1, Math.floor(limit)), 500)).all<{
    id: string; order_item_id: string; payment_intent_id: string;
    refund_attempts: number; amount_cents: number; order_id: string;
  }>();

  let refunded = 0;
  let failed = 0;
  for (const quote of due.results ?? []) {
    if (quote.amount_cents <= 0) continue;
    try {
      const refund = await createRefund(env, {
        orderId: quote.order_id,
        orderItemId: quote.order_item_id,
        partsQuoteId: quote.id,
        paymentIntentId: quote.payment_intent_id,
        amountCents: quote.amount_cents,
        attempt: quote.refund_attempts,
      });
      const t = now();
      await env.DB.prepare(
        `UPDATE parts_quotes SET refund_id = ?, refunded_at = ?, refund_error = NULL,
           updated_at = ?
          WHERE id = ? AND refund_id IS NULL`,
      ).bind(refund.id, t, t, quote.id).run();
      refunded += 1;
    } catch (err) {
      // Recorded on the row rather than swallowed, exactly as the labour side
      // does it: a refund that is not happening has to be visible as one,
      // because the customer has already been told the money is coming back.
      const message = `${(err as Error)?.message ?? 'The refund failed.'}`.slice(0, 300);
      console.error('parts refund failed', quote.id, message);
      await env.DB.prepare(
        `UPDATE parts_quotes SET refund_error = ?,
           refund_attempts = refund_attempts + ?, updated_at = ?
          WHERE id = ? AND refund_id IS NULL`,
      ).bind(message, stripeRefused(err) ? 1 : 0, now(), quote.id).run();
      failed += 1;
    }
  }
  return { refunded, failed };
}
