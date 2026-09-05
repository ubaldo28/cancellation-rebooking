import type { Env } from '../types';
import { notify } from './feed';
import { maskPhone } from './redact';
import { badRequest, conflict, newId, notFound, now } from './util';

/**
 * No-shows, suspensions, and whether somebody is allowed to transact.
 *
 * A no-show is not a fee. Charging for one means deciding, from a database,
 * that a person did not turn up — and the evidence for that is always the
 * absence of something rather than the presence of anything. An operator who
 * did the job and forgot to tap "I'm here" leaves precisely the same trace as
 * one who never left the house. So the answer is time, not money: a suspension
 * that stops you taking new work, escalating each time, ending by itself.
 *
 * THE LADDER: 3 days, then 7, then 30, then banned. Same on both sides,
 * because a customer who does not answer the door has cost an operator their
 * afternoon exactly as much as the reverse.
 *
 * NOTHING HERE IS AUTOMATIC. A report is filed by one side and does nothing at
 * all until it is confirmed. The shortcut — sweep for bookings that were never
 * marked arrived and strike them — is tempting every time it is looked at, and
 * it is wrong every time: it punishes the operator who was working, and it
 * hands any operator who wants a customer gone a one-tap weapon.
 */

/** Days of suspension per strike. Past the end of this list, it is a ban. */
export const STRIKE_DAYS = [3, 7, 30] as const;

const DAY = 86_400;

export type Subject = 'operator' | 'customer';

export interface Standing {
  kind: Subject;
  id: string;
  no_show_strikes: number;
  suspended_until: number | null;
  banned_at: number | null;
  /** True when they cannot list or book right now. */
  blocked: boolean;
  /** What to tell them, in words they can act on. Null when they are clear. */
  message: string | null;
}

/** What the next strike costs. Null means the next one is a ban. */
export const nextStrikeDays = (strikes: number): number | null =>
  STRIKE_DAYS[strikes] ?? null;

function describe(kind: Subject, until: number | null, banned: number | null): string | null {
  if (banned) {
    return kind === 'operator'
      ? 'This account is closed to new bookings after repeated no-shows. '
        + 'Reply to any email from us if you think that is wrong.'
      : 'This number cannot book here after repeated no-shows.';
  }
  if (!until || until <= now()) return null;

  const days = Math.max(1, Math.ceil((until - now()) / DAY));
  const left = days === 1 ? 'tomorrow' : `in ${days} days`;

  return kind === 'operator'
    ? `Your openings are paused after a missed appointment. They go back up ${left}. `
      + 'Anything already booked is unaffected — those customers still get their appointment.'
    : `This number cannot book new appointments after a missed one. That lifts ${left}.`;
}

// ---------------------------------------------------------------------------
// Reading standing
// ---------------------------------------------------------------------------

export async function operatorStanding(env: Env, operatorId: string): Promise<Standing> {
  const row = await env.DB.prepare(
    `SELECT suspended_until, banned_at FROM operators WHERE id = ?`,
  ).bind(operatorId).first<{ suspended_until: number | null; banned_at: number | null }>();

  const strikes = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM no_show_reports
      WHERE operator_id = ? AND against = 'operator' AND status = 'confirmed'`,
  ).bind(operatorId).first<{ n: number }>();

  const until = row?.suspended_until ?? null;
  const banned = row?.banned_at ?? null;
  return {
    kind: 'operator',
    id: operatorId,
    no_show_strikes: strikes?.n ?? 0,
    suspended_until: until,
    banned_at: banned,
    blocked: !!banned || (!!until && until > now()),
    message: describe('operator', until, banned),
  };
}

/**
 * A customer's standing, by phone number.
 *
 * The number is the only durable identity a customer has here, and that is a
 * real limitation worth being straight about: a new SIM is a clean record.
 * It is still worth doing, because what this deters is casual — somebody who
 * books three slots to see which suits and never cancels the other two — and
 * the alternative, making everyone create an account so they can be tracked,
 * costs far more bookings than no-shows ever will.
 */
export async function customerStanding(env: Env, phone: string): Promise<Standing> {
  const row = await env.DB.prepare(
    `SELECT no_show_strikes, suspended_until, banned_at
       FROM customer_standing WHERE phone_e164 = ?`,
  ).bind(phone).first<{
    no_show_strikes: number; suspended_until: number | null; banned_at: number | null;
  }>();

  const until = row?.suspended_until ?? null;
  const banned = row?.banned_at ?? null;
  return {
    kind: 'customer',
    id: phone,
    no_show_strikes: row?.no_show_strikes ?? 0,
    suspended_until: until,
    banned_at: banned,
    blocked: !!banned || (!!until && until > now()),
    message: describe('customer', until, banned),
  };
}

// ---------------------------------------------------------------------------
// Reporting one
// ---------------------------------------------------------------------------

export interface ReportInput {
  order_item_id: string;
  against: Subject;
  note?: string | null;
}

/**
 * File a no-show report. Changes nothing about anybody's standing.
 *
 * Both sides may file on the same booking — each blaming the other is a real
 * and frequent outcome, and a schema that only allows one story picks a winner
 * before anyone has looked. Each side gets exactly one, enforced by the unique
 * index in migration 0023: without it, five filings become a ban over a single
 * missed appointment.
 */
export async function reportNoShow(
  env: Env, by: Subject, input: ReportInput,
): Promise<{ id: string }> {
  const itemId = (input?.order_item_id ?? '').trim();
  const against: Subject = input.against === 'operator' ? 'operator' : 'customer';
  if (by === against) {
    throw badRequest('You cannot report yourself.', 'bad_report');
  }

  const item = await env.DB.prepare(
    `SELECT oi.id, oi.operator_id, oi.starts_at, oi.ends_at, oi.cancelled_at, o.phone_e164
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.id = ?`,
  ).bind(itemId).first<{
    id: string; operator_id: string; starts_at: number; ends_at: number;
    cancelled_at: number | null; phone_e164: string | null;
  }>();
  if (!item) throw notFound('No such booking.');

  // A cancellation and a no-show are different things and only one of them can
  // be true. Allowing both would let an operator cancel a job on the doorstep,
  // pay the lead fee, and then file the customer as a no-show on top.
  if (item.cancelled_at) {
    throw conflict('That booking was cancelled, so nobody failed to turn up.', 'was_cancelled');
  }
  if (item.ends_at > now()) {
    throw conflict('That appointment has not finished yet.', 'too_early');
  }

  const id = newId();
  const t = now();
  try {
    await env.DB.prepare(
      `INSERT INTO no_show_reports (id, order_item_id, against, operator_id, phone_e164,
         note, status, decided_at, strike_number, created_at, updated_at)
       VALUES (?,?,?,?,?,?, 'open', NULL, NULL, ?,?)`,
    ).bind(id, itemId, against, item.operator_id, item.phone_e164,
      (input.note ?? '').trim().slice(0, 500) || null, t, t).run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) {
      throw conflict('You have already reported that appointment.', 'already_reported');
    }
    throw e;
  }

  if (against === 'operator') {
    // Told, not hidden. An operator who first hears about a report when their
    // account is suspended has no chance to say what actually happened.
    await notify(env, item.operator_id, {
      kind: 'booking_cancelled',
      title: 'A customer says you did not turn up',
      body: 'We have not done anything to your account. Reply on that booking '
        + 'and tell us what happened.',
      starts_at: item.starts_at,
    });
  }

  return { id };
}

// ---------------------------------------------------------------------------
// Confirming one — the only thing that moves the ladder
// ---------------------------------------------------------------------------

export interface Applied {
  strike_number: number;
  /** Null when this strike is a ban. */
  days: number | null;
  until: number | null;
  banned: boolean;
}

/**
 * Uphold a report, and apply the next rung.
 *
 * The strike number is counted from CONFIRMED reports only, so a pile of
 * unreviewed filings cannot silently inflate what the next confirmation costs.
 */
export async function confirmNoShow(
  env: Env, reportId: string, note?: string | null,
): Promise<Applied> {
  const t = now();
  const report = await env.DB.prepare(
    `SELECT id, order_item_id, against, operator_id, phone_e164, status
       FROM no_show_reports WHERE id = ?`,
  ).bind(reportId).first<{
    id: string; order_item_id: string; against: Subject;
    operator_id: string; phone_e164: string | null; status: string;
  }>();
  if (!report) throw notFound('No such report.');
  if (report.status !== 'open') {
    throw conflict(`That report was already ${report.status}.`, 'already_decided');
  }

  const kind = report.against;
  const subjectId = kind === 'operator' ? report.operator_id : (report.phone_e164 ?? '');
  if (!subjectId) {
    throw badRequest('That report has nobody to apply to.', 'no_subject');
  }

  const prior = kind === 'operator'
    ? (await operatorStanding(env, subjectId)).no_show_strikes
    : (await customerStanding(env, subjectId)).no_show_strikes;

  const strikeNumber = prior + 1;
  const days = nextStrikeDays(prior);
  const banned = days === null;
  const until = banned ? null : t + days * DAY;

  const writes = [
    env.DB.prepare(
      `UPDATE no_show_reports SET status='confirmed', decided_at=?, strike_number=?,
         note = COALESCE(?, note), updated_at=?
        WHERE id=? AND status='open'`,
    ).bind(t, strikeNumber, (note ?? '').trim() || null, t, reportId),
    env.DB.prepare(
      `INSERT INTO suspensions (id, subject_kind, subject_id, reason, strike_number,
         starts_at, ends_at, note, created_at)
       VALUES (?,?,?, 'no_show', ?,?,?,?,?)`,
    ).bind(newId(), kind, subjectId, strikeNumber, t, until,
      banned ? 'Banned after a fourth no-show.' : `Suspended ${days} days.`, t),
  ];

  // A RUNG OF THIS LADDER ONLY EVER GOES UP.
  //
  // Both writes below used to assign suspended_until and banned_at outright,
  // which made confirming a report able to move somebody's standing BACKWARDS:
  // a first strike on an account that was already banned wrote banned_at=NULL
  // and let them straight back in, and a shorter suspension landing on top of
  // a longer one shortened it. Neither is a decision anybody made; both are an
  // assignment where a maximum was meant.
  //
  //   banned_at  keeps the FIRST ban, because that is when it happened, and
  //              never returns to NULL here — lifting a ban is somebody's
  //              deliberate act and needs its own path, not a side effect of
  //              deciding an unrelated report.
  //   suspended_until  keeps whichever end date is later.
  const bannedAt = banned ? t : null;
  if (kind === 'operator') {
    writes.push(env.DB.prepare(
      `UPDATE operators
          SET suspended_until = NULLIF(MAX(COALESCE(suspended_until, 0), COALESCE(?, 0)), 0),
              banned_at = COALESCE(banned_at, ?),
              updated_at = ?
        WHERE id = ?`,
    ).bind(until, bannedAt, t, subjectId));
  } else {
    // Upsert: a customer has no row until the first time they need one, and
    // creating one for every booking would be a table of everybody who ever
    // used the site for no reason.
    writes.push(env.DB.prepare(
      `INSERT INTO customer_standing
         (phone_e164, no_show_strikes, suspended_until, banned_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(phone_e164) DO UPDATE SET
         no_show_strikes = MAX(customer_standing.no_show_strikes, ?),
         suspended_until = NULLIF(MAX(COALESCE(customer_standing.suspended_until, 0),
                                      COALESCE(?, 0)), 0),
         banned_at = COALESCE(customer_standing.banned_at, ?),
         updated_at = ?`,
    ).bind(subjectId, strikeNumber, until, bannedAt, t, t,
      strikeNumber, until, bannedAt, t));
  }

  const res = await env.DB.batch(writes);
  if ((res[0]?.meta.changes ?? 0) === 0) {
    throw conflict('That report was already decided.', 'already_decided');
  }

  if (kind === 'operator') {
    await notify(env, subjectId, {
      kind: 'booking_cancelled',
      title: banned
        ? 'Your account is closed to new bookings'
        : `Your openings are paused for ${days} days`,
      body: banned
        ? 'This follows a fourth confirmed no-show.'
        : `This follows a confirmed no-show. Anything already booked is unaffected.`,
    });
  }

  return { strike_number: strikeNumber, days, until, banned };
}

/** Throw a report out. Nothing is applied and the ladder does not move. */
export async function rejectNoShow(
  env: Env, reportId: string, note?: string | null,
): Promise<void> {
  const t = now();
  const res = await env.DB.prepare(
    `UPDATE no_show_reports SET status='rejected', decided_at=?, note=COALESCE(?,note),
       updated_at=? WHERE id=? AND status='open'`,
  ).bind(t, (note ?? '').trim() || null, t, reportId).run();
  if ((res.meta.changes ?? 0) === 0) {
    throw conflict('That report was already decided.', 'already_decided');
  }
}

/**
 * Reports waiting on a person. There is no admin UI yet; this is the queue.
 *
 * The number is masked on the way out and the strike count is joined in to
 * take its place. `r.*` used to hand an admin the customer's phone number in
 * full, on every row, for every open dispute on the site — and nothing about
 * deciding a no-show needs it. What the decision actually turns on is the
 * timeline, whether the operator marked themselves arrived, and whether this
 * has happened before; that last one is what the number was standing in for,
 * so it is answered directly instead.
 *
 * Applying the strike does not go through this payload: confirmNoShow reads
 * the report row itself, where the number still is.
 */
export async function openReports(env: Env, limit = 100) {
  const rows = await env.DB.prepare(
    `SELECT r.*, oi.starts_at, oi.ends_at, oi.arrived_at, o.guest_name, op.business_name,
            (SELECT cs.no_show_strikes FROM customer_standing cs
              WHERE cs.phone_e164 = r.phone_e164) AS customer_strikes
       FROM no_show_reports r
       LEFT JOIN order_items oi ON oi.id = r.order_item_id
       LEFT JOIN orders o ON o.id = oi.order_id
       LEFT JOIN operators op ON op.id = r.operator_id
      WHERE r.status = 'open'
      ORDER BY r.created_at
      LIMIT ?`,
  ).bind(Math.min(Math.max(1, Math.floor(limit)), 200)).all<Record<string, unknown>>();

  return (rows.results ?? []).map((r) => ({
    ...r,
    phone_e164: maskPhone(r.phone_e164 as string | null),
    customer_strikes: (r.customer_strikes as number | null) ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Cards on file
// ---------------------------------------------------------------------------

/**
 * Whether this operator can be charged.
 *
 * NOTHING IN THIS FILE TOUCHES A CARD NUMBER. The processor holds the card and
 * gives back a reference; that reference is what is stored and what is
 * charged. A PAN in this database would drag the whole project into PCI scope
 * for no benefit at all, which is precisely what this arrangement exists to
 * avoid.
 */
export async function hasOperatorCard(env: Env, operatorId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT payment_ref FROM operators WHERE id = ?`,
  ).bind(operatorId).first<{ payment_ref: string | null }>();
  return !!row?.payment_ref;
}

/** The sentence an operator sees when they have not added one. */
/** Location is evidence now, not a nicety, so it gates listing. */
export const NEEDS_LOCATION_OPERATOR =
  'Turn location sharing back on to put openings up. It is what shows a '
  + 'customer their van is coming, and it is what proves you were where you '
  + 'said you were if a job is ever disputed. With it off we cannot tell an '
  + 'honest cancellation from a job done off the books, so we cannot list you.';

/** A customer is opening their door to a stranger; they get to know the van. */
export const NEEDS_VEHICLE_OPERATOR =
  'Add your vehicle before your openings go up — make, colour and plate. It is '
  + 'what a customer checks before they open the door to somebody they have '
  + 'never met, and it takes about twenty seconds.';

export const NEEDS_CARD_OPERATOR =
  'Add a card before your openings go up. Nothing is charged to it for using '
  + 'the site. It is there for one thing: cancelling a job late. Inside 48 '
  + 'hours that is a quarter of the job, inside 12 hours three quarters, and '
  + 'the whole job once you have said you arrived — the same amounts the '
  + 'customer forfeits if they are the one who cancels. More than 48 hours out '
  + 'costs you nothing.';

/** The sentence a customer sees at checkout. Kept in step with refundFor(). */
export const NEEDS_CARD_CUSTOMER =
  'Your card is charged for the appointment when you book. If you cancel, how '
  + 'much comes back depends on how close it is: all of it more than 48 hours '
  + 'out, three quarters from 12 to 48 hours, a quarter inside 12 — the '
  + 'business has kept that time free and turned other work away for it. '
  + 'Change your mind within 30 minutes of booking and you get everything '
  + 'back, as long as the appointment is still at least three hours away. You '
  + 'always see the exact amount before you confirm.';

/**
 * Records the processor's reference to a card. Never the card.
 *
 * PAYMENT SEAM: called after the processor's own form has taken the details
 * and handed back a reference. There is deliberately no path in this codebase
 * that accepts a card number, and there should never be one.
 */
export async function saveOperatorCard(
  env: Env, operatorId: string,
  card: { ref: string; brand?: string | null; last4?: string | null },
): Promise<void> {
  const ref = (card?.ref ?? '').trim();
  if (!ref) throw badRequest('No card was added.', 'no_card');
  // A refusal rather than a silent truncation: anything long enough to be a
  // card number reaching this function means the seam has been wired up wrong,
  // and storing it would be far worse than failing loudly.
  if (/^\d{12,19}$/.test(ref.replace(/[\s-]/g, ''))) {
    throw badRequest(
      'That looks like a card number. This endpoint takes the processor\'s '
      + 'reference, never the card itself.', 'raw_card');
  }
  const t = now();
  await env.DB.prepare(
    `UPDATE operators SET payment_ref=?, payment_brand=?, payment_last4=?,
       payment_added_at=?, updated_at=? WHERE id=?`,
  ).bind(ref, card.brand ?? null, (card.last4 ?? '').slice(-4) || null, t, t, operatorId).run();
}
