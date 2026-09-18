import type { Env } from '../types';
import { threadByToken, type ThreadRef } from './chat';
import { formatMoney, localeFor } from './countries';
import { notify } from './feed';
import { badRequest, conflict, newId, notFound, now } from './util';

/**
 * Money that waits until we know what happened.
 *
 * A cancelled booking used to refund instantly. That is what made the doorstep
 * bypass safe: an operator standing at the door says "cancel it in the app and
 * pay me cash", the customer cancels, the platform refunds them in full, and
 * the work happens anyway. Everybody is better off except the platform that
 * found the job, held the slot and carried the payment.
 *
 * Tracking does not catch that. An operator about to do a cash job turns
 * location off first, which is two taps, and anything built on the assumption
 * that they will not is a feature that only catches the careless.
 *
 * WHAT ACTUALLY BREAKS IT is removing the certainty. On any cancellation both
 * sides freeze, and the customer is asked one question: did they do the work
 * anyway? The operator now has to trust a stranger. If they do the job for
 * cash and the customer answers "no, they left", the customer keeps the cash
 * discount AND is refunded in full, while the operator has worked for nothing
 * and owes the fee on top. The scheme does not have to be detected to fail --
 * it only has to be unsafe to attempt, and it is.
 *
 * The other half is silence, and WHO PAYS FOR IT DEPENDS ON WHO CANCELLED.
 *
 * When the CUSTOMER cancelled, silence really does decide something. They told
 * us they were cancelling, the only person who could answer "did they do it
 * anyway" against their own interest is the operator, and the ladder they were
 * shown before they confirmed is what applies. Nothing about that changes.
 *
 * When the OPERATOR cancelled, silence proves nothing about anybody and the
 * money goes back. This used to resolve the other way — keep the money, charge
 * nobody, neither side profits — and that rule was written when NO money could
 * move, so "keeping" it cost nobody anything and read as a tidy symmetry. Now
 * that the card is really charged at booking, it means the platform quietly
 * keeps a stranger's money for a job that was never done because they did not
 * read an email. There is no version of this product where that is defensible.
 * The operator's fee stays waived, because an unanswered question is not
 * evidence against them either, and the deterrent is untouched: an operator
 * doing the job for cash still cannot rely on the customer to stay quiet, and
 * an answer of "no, they left" still costs them the whole fee. What changes is
 * only that the cost of a question nobody answered lands on the platform that
 * asked it rather than on the customer who paid.
 */

/** The longest the money waits for evidence that has not arrived. */
export const HOLD_CEILING_SECONDS = 7 * 24 * 60 * 60;

/**
 * How long after the original slot we keep watching before calling it clean.
 *
 * A customer cancels a Friday job on Tuesday. The question is whether the van
 * turns up on Friday anyway, so the hold cannot lift before Friday -- but it
 * must lift shortly after, not the following Tuesday. Holding an honest
 * person's refund for a week to catch a dishonest one loses more customers
 * than it saves money.
 */
export const WATCH_TAIL_SECONDS = 3 * 60 * 60;

export type Settlement = 'held' | 'released' | 'withheld';
export type WorkAnswer = 'done' | 'not_done';

export interface HeldItem {
  id: string;
  order_id: string;
  operator_id: string;
  starts_at: number;
  ends_at: number;
  price_cents: number;
  currency: string;
  refund_cents: number | null;
  cancelled_by: string | null;
  arrived_at: number | null;
  arrival_confirmed_at: number | null;
  settlement: Settlement;
  hold_until: number | null;
  work_confirmed: WorkAnswer | null;
}

const ITEM_FIELDS =
  `oi.id, oi.order_id, oi.operator_id, oi.starts_at, oi.ends_at, oi.price_cents,
   oi.refund_cents, oi.cancelled_by, oi.arrived_at, oi.arrival_confirmed_at,
   oi.settlement, oi.hold_until, oi.work_confirmed, o.currency`;

/**
 * Freezes both sides of one cancelled booking.
 *
 * Called from inside the cancellation batch, not after it: a booking that was
 * cancelled but not frozen would refund on the next sweep before anybody was
 * asked anything, which is the exact behaviour being removed.
 *
 * Returns the statement so the caller can put it in their own batch. This
 * function deliberately does not run it.
 */
export function holdStatement(
  env: Env, orderItemId: string, at: number, startsAt: number,
): D1PreparedStatement {
  // The ceiling and the watch tail, whichever comes first. A job three weeks
  // out does not need a hold that runs three weeks; a job cancelled an hour
  // before does not need one that expired yesterday.
  const until = Math.min(at + HOLD_CEILING_SECONDS, Math.max(
    at + 60, startsAt + WATCH_TAIL_SECONDS));
  return env.DB.prepare(
    `UPDATE order_items SET settlement='held', hold_until=? WHERE id=?`,
  ).bind(until, orderItemId);
}

/**
 * The customer answers the one question.
 *
 * 'not_done' -- they left, nothing happened. The refund goes through and the
 *               operator is charged, which is the ordinary honest case.
 * 'done'     -- they did the work anyway. No refund, the operator is paid as
 *               though the job completed, and no fee: the work was done and
 *               somebody has to be paid for it. Filing this honestly costs the
 *               customer their refund, which is exactly why an answer of
 *               'done' is trustworthy in a way that silence is not.
 */
export async function answerWork(
  env: Env, ref: ThreadRef, orderItemId: string, answer: WorkAnswer,
): Promise<{ settlement: Settlement; refund_cents: number }> {
  if (answer !== 'done' && answer !== 'not_done') {
    throw badRequest('Tell us whether the work happened.', 'bad_answer');
  }

  const thread = await threadByToken(env, ref);
  if (!thread) throw notFound('That link is not valid any more.');

  const item = await env.DB.prepare(
    `SELECT ${ITEM_FIELDS} FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.id = ? AND oi.operator_id = ?
        AND oi.order_id = (SELECT order_id FROM order_items WHERE appointment_id = ? LIMIT 1)`,
  ).bind(orderItemId, thread.operator_id, thread.appointment_id).first<HeldItem>();
  if (!item) throw notFound('That booking is not on your order.');

  if (item.settlement !== 'held') {
    throw conflict('That one is already settled.', 'already_settled');
  }

  const t = now();
  const settlement: Settlement = answer === 'not_done' ? 'released' : 'withheld';
  // Released means the refund that was decided at cancellation time actually
  // moves. Withheld means it does not, and the figure is zeroed rather than
  // left sitting there looking owed.
  const refund = answer === 'not_done' ? (item.refund_cents ?? 0) : 0;

  // ---------------------------------------------------------------------
  // PAYMENT SEAM.
  //
  //   'not_done' -> refund `refund` to the customer, pay the operator nothing
  //                 for this job, and apply the lead fee already recorded.
  //   'done'     -> refund nothing, pay the operator as a completed job, and
  //                 void the lead fee: the work was done.
  //
  // BOTH HALVES NOW HAPPEN, and for a while only the first one did. The refund
  // moved and the payout did not: settleDueWork excluded cancelled lines, so
  // "the operator is paid as though the job completed" was a sentence in this
  // comment and nothing else, and the whole job sat in the platform balance.
  // payableCents in checkout.ts is what reads this decision now.
  //
  // Both are a single decision taken here, once, on a row that can only be in
  // 'held'. The status guard in the WHERE clause is what makes a double tap on
  // a phone harmless.
  // ---------------------------------------------------------------------

  const writes = [
    env.DB.prepare(
      `UPDATE order_items SET work_confirmed=?, work_confirmed_at=?, settlement=?,
         settled_at=?, refund_cents=?
        WHERE id=? AND settlement='held'`,
    ).bind(answer, t, settlement, t, refund, orderItemId),
  ];

  if (answer === 'done') {
    // The work happened, so the fee does not apply. Waived rather than
    // deleted: the record that an operator cancelled a job they then went on
    // to do is worth keeping even when nothing is charged for it.
    writes.push(env.DB.prepare(
      `UPDATE lead_fees SET status='waived', settled_at=?, updated_at=?,
         note='Customer confirmed the work was done anyway.'
        WHERE order_item_id=? AND status='owed'`,
    ).bind(t, t, orderItemId));
  }

  const res = await env.DB.batch(writes);
  if ((res[0]?.meta.changes ?? 0) === 0) {
    throw conflict('That one is already settled.', 'already_settled');
  }

  // An operator who cancelled and whose customer then said the job happened
  // has some explaining to do, and telling them we know is most of the
  // deterrent. Said neutrally: there are innocent versions of this.
  if (answer === 'done' && item.cancelled_by === 'operator') {
    await flag(env, item.operator_id, orderItemId, 'photos_after',
      'Cancelled, and the customer says the work was done anyway.');
  }

  return { settlement, refund_cents: refund };
}

/**
 * The sweep. Settles everything whose hold has run out.
 *
 * A CUSTOMER cancellation settles on evidence, because their own answer is
 * already on the record: a van seen at the address means withheld, nothing
 * seen means the ladder they were quoted is paid out.
 *
 * An OPERATOR cancellation that nobody answered RELEASES THE CUSTOMER'S MONEY,
 * and that is a deliberate reversal. It used to resolve to 'withheld' on the
 * reasoning that neither side should profit from staying quiet — written when
 * the payment seam did not exist, so withholding moved nothing and cost nobody
 * anything. It costs somebody now: the card was charged at booking, the
 * business cancelled the job, and 'withheld' meant this platform kept the
 * money for work that was never done because a customer did not open an email.
 * A fee we are not sure is owed we waive; money we are not sure we may keep we
 * give back. The two halves are the same principle and only one of them was
 * ever implemented.
 *
 * The operator is still not charged and is still flagged. Silence is not
 * evidence against them, and the thing that actually deters the doorstep cash
 * job is unchanged — it was never the silence rule, it was that an operator
 * has to trust a stranger not to answer "no, they left".
 */
export async function settleExpiredHolds(env: Env): Promise<number> {
  const t = now();
  const due = await env.DB.prepare(
    `SELECT ${ITEM_FIELDS} FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.settlement = 'held' AND oi.hold_until IS NOT NULL AND oi.hold_until <= ?
      LIMIT 200`,
  ).bind(t).all<HeldItem>();

  const rows = due.results ?? [];
  for (const item of rows) {
    // A customer-cancelled booking has nobody to ask -- the customer already
    // told us they were cancelling, and the question "did they do it anyway"
    // is one only the operator could answer against their own interest. So it
    // settles on evidence alone: a van visit flag means withheld, no flag
    // means the refund goes through.
    const flagged = item.cancelled_by === 'customer'
      ? await hasFlag(env, item.id, 'visit_after')
      : false;

    // An operator cancellation with no answer releases: see the note above.
    // The customer's side is unchanged, because there silence genuinely is an
    // answer — they are the one who cancelled, and the ladder they were shown
    // before they confirmed is what they get.
    //
    // 'withheld' here means a van really was seen at that address after the
    // customer said they were cancelling, so the work happened and the whole
    // job is the operator's. That is money the payout sweep now moves; it used
    // to be a status nothing acted on. See payableCents in checkout.ts.
    const settlement: Settlement =
      item.cancelled_by === 'customer' ? (flagged ? 'withheld' : 'released') : 'released';

    const res = await env.DB.prepare(
      `UPDATE order_items SET settlement=?, settled_at=?, refund_cents=?
        WHERE id=? AND settlement='held'`,
    ).bind(settlement, t, settlement === 'withheld' ? 0 : (item.refund_cents ?? 0), item.id).run();
    if ((res.meta.changes ?? 0) === 0) continue;   // answered while this ran

    if (item.cancelled_by === 'operator' && item.work_confirmed === null) {
      // The fee is waived for the same reason the refund is released: nobody
      // answered. An unanswered question is not proof the operator walked away
      // from a job they had been paid to do, and a fee is a real debt that
      // blocks their listing until it is settled — billing one on a silence is
      // charging somebody for something nobody established. Waived rather than
      // deleted, so the record that they cancelled survives the decision not to
      // charge for it.
      await env.DB.prepare(
        `UPDATE lead_fees SET status='waived', settled_at=?, updated_at=?,
           note='Nobody said whether the work happened, so nothing was charged for it.'
          WHERE order_item_id=? AND status='owed'`,
      ).bind(t, t, item.id).run();

      await flag(env, item.operator_id, item.id, 'silence',
        'The customer never said whether the work happened.');
    }
  }
  return rows.length;
}

/** What a customer needs to be asked, if anything, on their own page. */
export async function pendingQuestion(env: Env, ref: ThreadRef) {
  const thread = await threadByToken(env, ref);
  if (!thread?.appointment_id) return null;

  const item = await env.DB.prepare(
    `SELECT ${ITEM_FIELDS},
            (SELECT GROUP_CONCAT(s.name, ' + ') FROM order_item_services s
              WHERE s.order_item_id = oi.id) AS services
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.operator_id = ?
        AND oi.order_id = (SELECT order_id FROM order_items WHERE appointment_id = ? LIMIT 1)
        AND oi.settlement = 'held'
        AND oi.cancelled_by = 'operator'
        AND oi.work_confirmed IS NULL
      ORDER BY oi.starts_at DESC LIMIT 1`,
  ).bind(thread.operator_id, thread.appointment_id).first<HeldItem & { services: string | null }>();

  if (!item) return null;

  const op = await env.DB.prepare(
    `SELECT business_name, country, language FROM operators WHERE id = ?`,
  ).bind(item.operator_id).first<{
    business_name: string; country: string; language: string;
  }>();
  const locale = localeFor(op?.country ?? 'US', op?.language ?? 'en');

  return {
    order_item_id: item.id,
    services: item.services,
    business_name: op?.business_name ?? 'The business',
    refund: formatMoney(item.refund_cents ?? 0, item.currency, locale),
    refund_cents: item.refund_cents ?? 0,
    hold_until: item.hold_until,
  };
}

// ---------------------------------------------------------------------------
// Arrival, from both sides
// ---------------------------------------------------------------------------

/**
 * The customer confirms the van turned up.
 *
 * Never required to start the job -- a customer whose phone is indoors must
 * not be able to strand an appointment -- so the work proceeds on the
 * operator's tap alone. What this changes is what a later cancellation means.
 * An operator who cancels AFTER the customer confirmed they arrived has, on
 * the record, driven there, been seen, and then walked away. That is the
 * strongest single signal in the system, which is why it gets its own flag.
 */
export async function confirmArrival(
  env: Env, ref: ThreadRef, orderItemId: string,
): Promise<{ arrival_confirmed_at: number }> {
  const thread = await threadByToken(env, ref);
  if (!thread) throw notFound('That link is not valid any more.');

  const t = now();
  const res = await env.DB.prepare(
    `UPDATE order_items SET arrival_confirmed_at = ?
      WHERE id = ? AND operator_id = ? AND arrival_confirmed_at IS NULL
        AND cancelled_at IS NULL
        AND order_id = (SELECT order_id FROM order_items WHERE appointment_id = ? LIMIT 1)`,
  ).bind(t, orderItemId, thread.operator_id, thread.appointment_id).run();

  if ((res.meta.changes ?? 0) === 0) {
    // Scoped exactly as the update above is. Reading the row by id alone made
    // this the one query on the guest side that answered about a booking the
    // caller has no claim to: "already confirmed" for somebody else's item is
    // a fact about a stranger's appointment, and it came back as a success.
    const row = await env.DB.prepare(
      `SELECT arrival_confirmed_at FROM order_items
        WHERE id = ? AND operator_id = ?
          AND order_id = (SELECT order_id FROM order_items WHERE appointment_id = ? LIMIT 1)`,
    ).bind(orderItemId, thread.operator_id, thread.appointment_id)
      .first<{ arrival_confirmed_at: number | null }>();
    if (row?.arrival_confirmed_at) return { arrival_confirmed_at: row.arrival_confirmed_at };
    throw notFound('That booking is not on your order.');
  }

  await notify(env, thread.operator_id, {
    kind: 'chat_message',
    title: `${thread.guest_name} confirmed you arrived`,
    body: null,
    thread_id: thread.id,
  });

  return { arrival_confirmed_at: t };
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export type FlagKind =
  | 'dwell' | 'location_dark' | 'photos_after' | 'visit_after'
  | 'silence' | 'confirmed_then_cancelled';

/**
 * Records an observation. Never a verdict, and nothing acts on one alone.
 *
 * Swallows a duplicate: the unique index means a sweep that runs twice records
 * one afternoon once rather than making it look like two incidents, and that
 * is the desired outcome rather than an error worth propagating.
 */
export async function flag(
  env: Env, operatorId: string, orderItemId: string | null,
  kind: FlagKind, detail?: string | null,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO bypass_flags (id, operator_id, order_item_id, kind, detail, created_at)
       VALUES (?,?,?,?,?,?)`,
    ).bind(newId(), operatorId, orderItemId, kind, detail ?? null, now()).run();
  } catch {
    // Duplicate, or a race with the same sweep. Either way there is nothing
    // useful to do and nothing worth failing a settlement over.
  }
}

async function hasFlag(env: Env, orderItemId: string, kind: FlagKind): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS n FROM bypass_flags WHERE order_item_id = ? AND kind = ? LIMIT 1`,
  ).bind(orderItemId, kind).first<{ n: number }>();
  return !!row;
}

/**
 * One operator's flags, and how far out of line they are.
 *
 * The rate matters and the count does not. Somebody doing forty jobs a month
 * will collect the odd flag honestly; somebody doing four and collecting three
 * is a different thing entirely, and a rule written on raw counts punishes the
 * busy operator for being busy.
 */
export async function flagSummary(env: Env, operatorId: string) {
  const flags = await env.DB.prepare(
    `SELECT kind, COUNT(*) AS n FROM bypass_flags
      WHERE operator_id = ? AND created_at >= ?
      GROUP BY kind`,
  ).bind(operatorId, now() - 90 * 86400).all<{ kind: string; n: number }>();

  const jobs = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM order_items
      WHERE operator_id = ? AND created_at >= ?`,
  ).bind(operatorId, now() - 90 * 86400).first<{ n: number }>();

  const total = (flags.results ?? []).reduce((a, r) => a + r.n, 0);
  const done = jobs?.n ?? 0;

  return {
    jobs: done,
    flags: total,
    by_kind: Object.fromEntries((flags.results ?? []).map((r) => [r.kind, r.n])),
    /** Flags per job over the last 90 days. Compared against peers, not a threshold. */
    rate: done > 0 ? total / done : 0,
  };
}

/** The review queue: operators whose flag rate stands out. No automatic action. */
export async function flaggedOperators(env: Env, limit = 50) {
  const rows = await env.DB.prepare(
    `SELECT f.operator_id, o.business_name, COUNT(*) AS flags,
            MAX(f.created_at) AS last_flag,
            (SELECT COUNT(*) FROM order_items oi
              WHERE oi.operator_id = f.operator_id AND oi.created_at >= ?) AS jobs
       FROM bypass_flags f
       LEFT JOIN operators o ON o.id = f.operator_id
      WHERE f.created_at >= ?
      GROUP BY f.operator_id
      ORDER BY flags DESC
      LIMIT ?`,
  ).bind(now() - 90 * 86400, now() - 90 * 86400,
    Math.min(Math.max(1, Math.floor(limit)), 200)).all();
  return rows.results ?? [];
}
