import { describe, expect, it, beforeEach, vi } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import type { Env } from '../src/types';
import { startThread, threadByToken } from '../src/lib/chat';
import { startPayment } from '../src/lib/checkout';
import {
  askForEstimate, decideEstimate, estimatesForGuest, estimatesForOperator,
  expireEstimates, quoteEstimate, withdrawEstimate,
} from '../src/lib/estimates';
import { newId, now } from '../src/lib/util';

/**
 * Estimates: the price a business names for a job nobody posted.
 *
 * This file exists because there was none. Seven hundred lines that put a
 * number in front of a stranger, take their yes, and are the front door to
 * charging them had no test at all — so the two rules the module is written
 * around were only claims in a comment.
 *
 * Those two rules are what this file is mostly about:
 *
 *   1. Nobody is charged for a number they have not seen. The price and the
 *      time on the row the customer tapped are the only ones that can bind,
 *      a second tap decides nothing twice, and a quote whose start time has
 *      gone cannot be accepted however late the sweep ran.
 *   2. Neither side is trusted with an id. An estimate id lifted from another
 *      customer's link, or another operator's account, is answered exactly as
 *      an id that was never real.
 *
 * The third rule arrived with the payment seam and is the reason half this file
 * exists:
 *
 *   3. AN ACCEPTED ESTIMATE IS AN ORDINARY BOOKING. Accepting writes an order,
 *      an appointment and an order_item — the same rows a posted opening
 *      produces — and writes the order's id onto the estimate in the same
 *      batch as the status change. 'accepted' with order_id NULL therefore
 *      means one thing only: the customer said yes and the booking did not get
 *      made. The tests below pin every way that could come apart.
 */

const MIGRATIONS = ALL_MIGRATIONS;

let env: Env;

const OP = 'op-estimates';
const OTHER_OP = 'op-someone-else';

const HOUR = 3600;

const one = async <T>(sql: string, ...args: unknown[]) =>
  env.DB.prepare(sql).bind(...args).first<T>();

const count = async (sql: string, ...args: unknown[]) =>
  (await one<{ n: number }>(sql, ...args))!.n;

/**
 * stripe_payouts_enabled defaults to 1 here, and it is load-bearing rather
 * than boilerplate: a business with nowhere to be paid cannot sell, so an
 * accepted estimate for one is refused before any booking is written. Drop it
 * and every acceptance in this file comes back 'operator_cannot_be_paid'.
 * `payouts: false` is how the test for that refusal asks for the other case.
 */
async function addOperator(
  id: string, name: string, email: string, opts: { payouts?: boolean } = {},
) {
  const n = now();
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,trade,timezone,country,currency,language,
       location_mode,fill_model,sms_mode,max_detour_seconds,min_gap_seconds,buffer_seconds,
       offer_ttl_seconds,offers_per_wave,min_notice_seconds,reoffer_cooldown_seconds,
       discount_percent,plan,accept_public_bookings,deposit_cents,created_at,updated_at,
       stripe_payouts_enabled)
     VALUES (?,?,?, 'house cleaning','America/Los_Angeles','US','USD','en','mobile','both',
       'device',900,3600,900,5400,3,3600,604800,0,'active',1,1000,?,?,?)`,
  ).bind(id, email, name, n, n, opts.payouts === false ? 0 : 1).run();
}

/** A job already on the operator's calendar, to collide an acceptance with. */
async function addAppointment(
  operatorId: string, startsAt: number, endsAt: number, status = 'scheduled',
) {
  const n = now();
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO appointments (id, operator_id, starts_at, ends_at, is_mobile,
       status, source, created_at, updated_at)
     VALUES (?,?,?,?,1,?, 'manual', ?,?)`,
  ).bind(id, operatorId, startsAt, endsAt, status, n, n).run();
  return id;
}

/** A conversation with a customer, and the raw guest token that reaches it. */
async function conversation(operatorId = OP, guestName = 'Rosa') {
  const { thread, token } = await startThread(env, {
    operator_id: operatorId,
    guest_name: guestName,
    first_message: 'Hello',
  });
  return { thread, token };
}

/** A sane set of numbers to quote with: half a day, starting tomorrow. */
const goodQuote = (overrides: Partial<{
  description: string; price_cents: number; duration_seconds: number; starts_at: number;
}> = {}) => ({
  description: 'Whole house, three bedrooms and the conservatory',
  price_cents: 24000,
  duration_seconds: 4 * HOUR,
  starts_at: now() + 24 * HOUR,
  ...overrides,
});

beforeEach(async () => {
  env = makeEnv(MIGRATIONS) as unknown as Env;
  await addOperator(OP, 'Valley Cleaning', 'valley@example.com');
  await addOperator(OTHER_OP, 'Someone Else Cleaning', 'else@example.com');
});

// ---------------------------------------------------------------------------

describe('asking for an estimate', () => {
  it('records the question and puts it in the conversation the operator reads', async () => {
    const { thread, token } = await conversation();
    const e = await askForEstimate(env, token, 'Can you do the whole house next Thursday?');

    expect(e.status).toBe('asked');
    expect(e.thread_id).toBe(thread.id);
    expect(e.operator_id).toBe(OP);
    // Nothing about money exists until the business answers.
    expect(e.price_cents).toBeNull();
    expect(e.starts_at).toBeNull();
    expect(e.currency).toBeNull();
    // An unanswered question has no fuse: expiring it would only delete the
    // evidence that the business never replied.
    expect(e.expires_at).toBeNull();

    const msg = await one<{ body: string }>(
      `SELECT body FROM chat_messages WHERE thread_id = ? AND body LIKE 'Asked for an estimate%'`,
      thread.id,
    );
    expect(msg?.body).toContain('whole house');
  });

  /**
   * The most tempting box on the site: the person typing it is describing a
   * job and reaching for "just call me about it". If the filter is ever
   * dropped here it is dropped on the one text box where a phone number is
   * most likely to be typed.
   */
  it('strips a phone number out of the request before it is stored', async () => {
    const { token } = await conversation();
    const e = await askForEstimate(
      env, token, 'Whole house please, just call me on (818) 555-0142',
    );
    expect(e.request).not.toContain('555-0142');
    expect(e.request).not.toMatch(/\d{3}[-\s]?\d{4}/);

    // And not by way of the row either — the redaction happens before insert.
    const row = await one<{ request: string }>(
      `SELECT request FROM estimates WHERE id = ?`, e.id,
    );
    expect(row!.request).not.toContain('555-0142');
  });

  it('refuses a blank, and refuses more than a phone screen of text', async () => {
    const { token } = await conversation();
    await expect(askForEstimate(env, token, '   ')).rejects.toThrow(/blank/i);
    await expect(askForEstimate(env, token, 'x'.repeat(601))).rejects.toThrow(/600/);
  });

  it('caps how many unanswered questions one conversation may carry', async () => {
    const { token } = await conversation();
    for (let i = 0; i < 3; i++) await askForEstimate(env, token, `Job number ${i}`);
    await expect(askForEstimate(env, token, 'And one more'))
      .rejects.toThrow(/questions waiting/i);
  });

  it('is not reachable with a token that resolves to nothing', async () => {
    await expect(askForEstimate(env, 'not-a-real-token', 'Anything'))
      .rejects.toThrow(/not valid/i);
  });
});

// ---------------------------------------------------------------------------

describe('quoting a price', () => {
  it('puts a price, a length and a start on the row, and says so in the thread', async () => {
    const { thread, token } = await conversation();
    const asked = await askForEstimate(env, token, 'Whole house');
    const q = await quoteEstimate(env, OP, asked.id, goodQuote());

    expect(q.status).toBe('quoted');
    expect(q.price_cents).toBe(24000);
    expect(q.currency).toBe('USD');
    // The job itself is the deadline. A separate TTL would either kill a quote
    // the customer was still thinking about, or leave one answerable after the
    // morning it was for.
    expect(q.expires_at).toBe(q.starts_at);

    const msg = await one<{ body: string }>(
      `SELECT body FROM chat_messages WHERE thread_id = ? AND body LIKE '%sent an estimate%'`,
      thread.id,
    );
    // The customer is told, in the same breath as the number, that tapping is
    // still required. This sentence is the promise the feature rests on.
    expect(msg?.body).toContain('Nothing is booked or charged until you accept it');
    expect(msg?.body).toContain('$240.00');
  });

  it('refuses prices, durations and start times that are somebody mistyping', async () => {
    const { token } = await conversation();
    const asked = await askForEstimate(env, token, 'Whole house');

    // Zero is a message, not something to accept; the ceiling is a typo guard.
    await expect(quoteEstimate(env, OP, asked.id, goodQuote({ price_cents: 0 })))
      .rejects.toThrow(/needs a price/i);
    await expect(quoteEstimate(env, OP, asked.id, goodQuote({ price_cents: 50_000_01 })))
      .rejects.toThrow(/typo/i);

    // Seconds typed where minutes were meant, at both ends.
    await expect(quoteEstimate(env, OP, asked.id, goodQuote({ duration_seconds: 60 })))
      .rejects.toThrow(/how long/i);
    await expect(quoteEstimate(env, OP, asked.id, goodQuote({ duration_seconds: 13 * HOUR })))
      .rejects.toThrow(/how long/i);

    // A start in the past, and one so close the customer could not read it in
    // time — which would be swept to expired almost at once and read to both
    // of them as the site losing the job.
    await expect(quoteEstimate(env, OP, asked.id, goodQuote({ starts_at: now() - 60 })))
      .rejects.toThrow(/future/i);
    await expect(quoteEstimate(env, OP, asked.id, goodQuote({ starts_at: now() + 5 * 60 })))
      .rejects.toThrow(/half an hour/i);

    // Nothing above got as far as the row.
    const still = await one<{ status: string }>(
      `SELECT status FROM estimates WHERE id = ?`, asked.id,
    );
    expect(still!.status).toBe('asked');
  });

  it('refuses a price with no description of what it buys', async () => {
    const { token } = await conversation();
    const asked = await askForEstimate(env, token, 'Whole house');
    await expect(quoteEstimate(env, OP, asked.id, goodQuote({ description: '   ' })))
      .rejects.toThrow(/what you would be doing/i);
  });

  it('filters contact details out of the operator\'s answer too', async () => {
    const { token } = await conversation();
    const asked = await askForEstimate(env, token, 'Whole house');
    const q = await quoteEstimate(env, OP, asked.id, goodQuote({
      description: 'Whole house — ring me on (818) 555-0199 to arrange',
    }));
    expect(q.description).not.toContain('555-0199');
  });

  /**
   * An operator who typed 300 meaning 3000 has to be able to fix it, and the
   * corrected row must be the only number the customer can ever tap.
   */
  it('lets a live quote be re-quoted, and the new number is the only one', async () => {
    const { token } = await conversation();
    const asked = await askForEstimate(env, token, 'Whole house');
    await quoteEstimate(env, OP, asked.id, goodQuote({ price_cents: 300 }));
    const fixed = await quoteEstimate(env, OP, asked.id, goodQuote({ price_cents: 30000 }));

    expect(fixed.price_cents).toBe(30000);
    const row = await one<{ price_cents: number }>(
      `SELECT price_cents FROM estimates WHERE id = ?`, asked.id,
    );
    expect(row!.price_cents).toBe(30000);
  });

  /**
   * operator_id is in the WHERE clause rather than checked after the read, so
   * which estimate ids exist is not something this API confirms.
   */
  it('will not let one business price another business\'s estimate', async () => {
    const { token } = await conversation();
    const asked = await askForEstimate(env, token, 'Whole house');

    await expect(quoteEstimate(env, OTHER_OP, asked.id, goodQuote()))
      .rejects.toThrow(/not yours/i);

    const row = await one<{ status: string; price_cents: number | null }>(
      `SELECT status, price_cents FROM estimates WHERE id = ?`, asked.id,
    );
    expect(row!.status).toBe('asked');
    expect(row!.price_cents).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('the customer deciding', () => {
  /** Ask, quote, and hand back everything a decision needs. */
  async function quoted(opts: { price?: number; startsAt?: number } = {}) {
    const { thread, token } = await conversation();
    const asked = await askForEstimate(env, token, 'Whole house');
    const q = await quoteEstimate(env, OP, asked.id, goodQuote({
      price_cents: opts.price ?? 24000,
      ...(opts.startsAt ? { starts_at: opts.startsAt } : {}),
    }));
    return { thread, token, estimate: q };
  }

  it('records an acceptance once, against the numbers the customer saw', async () => {
    const { token, estimate } = await quoted();
    const accepted = await decideEstimate(env, token, estimate.id, 'accepted');

    expect(accepted.status).toBe('accepted');
    // The figures are the ones on the row that was tapped, never recalculated.
    expect(accepted.price_cents).toBe(24000);
    expect(accepted.starts_at).toBe(estimate.starts_at);

    const row = await one<{ status: string; decided_at: number | null }>(
      `SELECT status, decided_at FROM estimates WHERE id = ?`, estimate.id,
    );
    expect(row!.status).toBe('accepted');
    expect(row!.decided_at).not.toBeNull();
  });

  /**
   * THE SEAM, from the customer's side. Accepting is supposed to leave behind
   * everything a posted opening leaves behind, and the figures on all of it
   * are the ones on the row that was tapped.
   *
   * For a long time this was the dead end: the yes was recorded and nothing
   * else happened — no appointment, no order, no charge. The assertions below
   * are the ones that fail if that ever comes back.
   */
  it('books an appointment and an order at the quoted price and time', async () => {
    const { token, estimate } = await quoted();
    const accepted = await decideEstimate(env, token, estimate.id, 'accepted');

    // The contract the guest page is written against.
    expect(accepted.order).not.toBeNull();
    expect(accepted.order!.total_cents).toBe(24000);
    expect(accepted.order!.currency).toBe('USD');
    expect(accepted.order!.id).toBe(accepted.order_id);

    // The order: unpaid, in the quoted currency, for the quoted amount. Never
    // recalculated and never taken off the operator's price list.
    const order = await one<{
      id: string; status: string; total_cents: number; currency: string;
      paid_at: number | null; payment_intent_id: string | null;
    }>(`SELECT id, status, total_cents, currency, paid_at, payment_intent_id
          FROM orders`);
    expect(order!.id).toBe(accepted.order!.id);
    expect(order!.total_cents).toBe(24000);
    expect(order!.currency).toBe('USD');
    // The money has not moved. startPayment opens the charge; this does not.
    expect(order!.status).toBe('pending');
    expect(order!.paid_at).toBeNull();
    expect(order!.payment_intent_id).toBeNull();

    // The appointment: the operator's calendar, for exactly the window quoted.
    const appt = await one<{
      operator_id: string; starts_at: number; ends_at: number;
      status: string; price_cents: number; source: string; service_id: string | null;
    }>(`SELECT operator_id, starts_at, ends_at, status, price_cents, source, service_id
          FROM appointments`);
    expect(appt!.operator_id).toBe(OP);
    expect(appt!.starts_at).toBe(estimate.starts_at);
    expect(appt!.ends_at).toBe(estimate.starts_at! + estimate.duration_seconds!);
    expect(appt!.status).toBe('scheduled');
    expect(appt!.price_cents).toBe(24000);
    // The same source as a booking sold by a posted opening, so every query
    // that filters on 'online' keeps covering this one.
    expect(appt!.source).toBe('online');
    // A bespoke job is not on the price list, so there is no service to name.
    expect(appt!.service_id).toBeNull();

    // The order line: no gap, because no opening was ever posted — and a start
    // code, because a job must never be startable without one.
    const item = await one<{
      order_id: string; gap_id: string | null; appointment_id: string;
      starts_at: number; duration_seconds: number; price_cents: number;
      start_code: string | null; cancelled_at: number | null;
    }>(`SELECT order_id, gap_id, appointment_id, starts_at, duration_seconds,
               price_cents, start_code, cancelled_at FROM order_items`);
    expect(item!.order_id).toBe(accepted.order!.id);
    expect(item!.gap_id).toBeNull();
    expect(item!.starts_at).toBe(estimate.starts_at);
    expect(item!.duration_seconds).toBe(estimate.duration_seconds);
    expect(item!.price_cents).toBe(24000);
    expect(item!.start_code).toMatch(/^\d{4}$/);
    expect(item!.cancelled_at).toBeNull();

    // The receipt says what was bought, in the words the customer agreed to.
    const receipt = await one<{ name: string; price_cents: number }>(
      `SELECT name, price_cents FROM order_item_services`,
    );
    expect(receipt!.name).toContain('Whole house');
    expect(receipt!.price_cents).toBe(24000);
  });

  /**
   * The invariant, written down in estimates.ts and pinned here: a row that
   * says 'accepted' with order_id NULL means the booking did not get made, and
   * nothing on this path can produce one. The id is on the row, not merely in
   * the return value.
   */
  it('writes the order id onto the estimate row itself', async () => {
    const { token, estimate } = await quoted();
    const accepted = await decideEstimate(env, token, estimate.id, 'accepted');

    const row = await one<{ status: string; order_id: string | null }>(
      `SELECT status, order_id FROM estimates WHERE id = ?`, estimate.id,
    );
    expect(row!.status).toBe('accepted');
    expect(row!.order_id).toBe(accepted.order!.id);

    // The report somebody would have to work through by hand, and it is empty.
    expect(await count(
      `SELECT COUNT(*) AS n FROM estimates WHERE status = 'accepted' AND order_id IS NULL`,
    )).toBe(0);
  });

  /**
   * A customer double-tapping accept on a phone, one-handed, on a bad
   * connection. The second tap matches no row and must not become a second
   * booking or a second charge.
   *
   * Counting the rows is the half that matters now. The status guard always
   * stopped the second flip; what it did not stop, before the writes carried
   * the same guard, was the second tap inserting a whole second order and a
   * second appointment and THEN being told the estimate was already answered.
   */
  it('cannot be decided twice, and a double accept books exactly once', async () => {
    const { token, estimate } = await quoted();
    const first = await decideEstimate(env, token, estimate.id, 'accepted');

    await expect(decideEstimate(env, token, estimate.id, 'accepted'))
      .rejects.toThrow(/already|accepted/i);
    await expect(decideEstimate(env, token, estimate.id, 'declined'))
      .rejects.toThrow(/already|accepted/i);

    const row = await one<{ status: string; order_id: string | null }>(
      `SELECT status, order_id FROM estimates WHERE id = ?`, estimate.id,
    );
    expect(row!.status).toBe('accepted');
    // Still the first tap's booking, not a later one written over it.
    expect(row!.order_id).toBe(first.order!.id);

    expect(await count(`SELECT COUNT(*) AS n FROM orders`)).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM order_items`)).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM appointments`)).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM clients`)).toBe(1);
    // And the transcript carries one acceptance, not three decisions.
    expect(await count(
      `SELECT COUNT(*) AS n FROM chat_messages WHERE body LIKE 'Accepted:%'`,
    )).toBe(1);
    expect(await count(
      `SELECT COUNT(*) AS n FROM chat_messages WHERE body LIKE 'Declined:%'`,
    )).toBe(0);
  });

  /**
   * A quote stands for days, and in that time the operator takes other work.
   * Nothing goes back and withdraws the quote, so the booking write is the
   * only thing that can find out — and when it does the customer gets a
   * sentence, not a 500, and not half a booking.
   */
  it('refuses when the quoted time has been filled since, and writes nothing', async () => {
    const { token, estimate } = await quoted();
    // A job that starts an hour into the quoted window: overlapping, not equal.
    await addAppointment(OP, estimate.starts_at! + HOUR, estimate.starts_at! + 2 * HOUR);

    await expect(decideEstimate(env, token, estimate.id, 'accepted'))
      .rejects.toThrow(/another job/i);

    // The estimate is untouched, so the customer can be shown the refusal and
    // the operator can send a new time against the same conversation.
    const row = await one<{ status: string; order_id: string | null }>(
      `SELECT status, order_id FROM estimates WHERE id = ?`, estimate.id,
    );
    expect(row!.status).toBe('quoted');
    expect(row!.order_id).toBeNull();

    expect(await count(`SELECT COUNT(*) AS n FROM orders`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM order_items`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM clients`)).toBe(0);
    // Only the one that was already there.
    expect(await count(`SELECT COUNT(*) AS n FROM appointments`)).toBe(1);
    expect(await count(
      `SELECT COUNT(*) AS n FROM chat_messages WHERE body LIKE 'Accepted:%'`,
    )).toBe(0);
  });

  /**
   * THE ACTUAL RACE, not the comfortable version of it.
   *
   * Every refusal above is decided by a read taken before the batch, which is
   * the ordinary case and proves nothing about the guards riding on the writes
   * themselves. These two force the other path: something commits in the
   * instant between the last read and the batch, exactly as a second customer
   * or the operator would.
   *
   * What is being pinned is that a D1 batch commits what its statements
   * MATCHED. A guarded flip on its own is not enough — the order, the client,
   * the appointment and the receipt would all still land and only the
   * acceptance would fail, which is a complete booking nobody agreed to,
   * hidden behind an error message. So: nothing at all, or all of it.
   */
  function raceOn(interfere: () => Promise<void>) {
    const db = env.DB as unknown as { batch: (s: unknown[]) => Promise<unknown> };
    const real = db.batch.bind(db);
    let fired = false;
    db.batch = async (stmts: unknown[]) => {
      if (!fired) { fired = true; await interfere(); }
      return real(stmts);
    };
  }

  /** Nothing survived the batch except what was there before it. */
  async function nothingWasBooked() {
    expect(await count(`SELECT COUNT(*) AS n FROM orders`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM order_items`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM order_item_services`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM clients`)).toBe(0);
    expect(await count(
      `SELECT COUNT(*) AS n FROM chat_messages WHERE body LIKE 'Accepted:%'`,
    )).toBe(0);
  }

  it('writes nothing when the hour is taken between the check and the batch', async () => {
    const { token, estimate } = await quoted();
    raceOn(async () => {
      await addAppointment(OP, estimate.starts_at!, estimate.starts_at! + HOUR);
    });

    await expect(decideEstimate(env, token, estimate.id, 'accepted'))
      .rejects.toThrow(/another job/i);

    const row = await one<{ status: string; order_id: string | null }>(
      `SELECT status, order_id FROM estimates WHERE id = ?`, estimate.id,
    );
    expect(row!.status).toBe('quoted');
    expect(row!.order_id).toBeNull();
    // Only the interloper's.
    expect(await count(`SELECT COUNT(*) AS n FROM appointments`)).toBe(1);
    await nothingWasBooked();
  });

  it('writes nothing when the estimate stops being live between the check and the batch',
    async () => {
      const { token, estimate } = await quoted();
      raceOn(async () => {
        await env.DB.prepare(
          `UPDATE estimates SET status = 'withdrawn' WHERE id = ?`,
        ).bind(estimate.id).run();
      });

      await expect(decideEstimate(env, token, estimate.id, 'accepted'))
        .rejects.toThrow(/already answered/i);

      const row = await one<{ status: string; order_id: string | null }>(
        `SELECT status, order_id FROM estimates WHERE id = ?`, estimate.id,
      );
      expect(row!.status).toBe('withdrawn');
      expect(row!.order_id).toBeNull();
      expect(await count(`SELECT COUNT(*) AS n FROM appointments`)).toBe(0);
      await nothingWasBooked();
    });

  /**
   * A cancelled job is not work, and its hours go back on the market. The
   * overlap check has to know the difference or an operator who cancelled
   * something can never sell that morning again.
   */
  it('books over a cancelled job, because cancelled time is free time', async () => {
    const { token, estimate } = await quoted();
    await addAppointment(
      OP, estimate.starts_at!, estimate.starts_at! + HOUR, 'cancelled');

    const accepted = await decideEstimate(env, token, estimate.id, 'accepted');
    expect(accepted.order).not.toBeNull();
  });

  /**
   * An opening posted over the same hours stops being for sale. Without this
   * the operator would have sold the identical time twice — once by quote and
   * once off the map — and the second customer would find out on the doorstep.
   */
  it('takes any opening covering the booked time off the market', async () => {
    const { token, estimate } = await quoted();
    const gapId = newId();
    const n = now();
    await env.DB.prepare(
      `INSERT INTO gaps (id,operator_id,starts_at,ends_at,is_mobile,status,source,
         created_at,updated_at)
       VALUES (?,?,?,?,1,'open','posted',?,?)`,
    ).bind(gapId, OP, estimate.starts_at! - HOUR, estimate.starts_at! + HOUR, n, n).run();

    await decideEstimate(env, token, estimate.id, 'accepted');

    const gap = await one<{ status: string }>(
      `SELECT status FROM gaps WHERE id = ?`, gapId,
    );
    expect(gap!.status).toBe('expired');
  });

  it('records a decline, and says so in the conversation', async () => {
    const { thread, token, estimate } = await quoted();
    const declined = await decideEstimate(env, token, estimate.id, 'declined');
    expect(declined.status).toBe('declined');

    const msg = await one<{ body: string }>(
      `SELECT body FROM chat_messages WHERE thread_id = ? AND body LIKE 'Declined:%'`,
      thread.id,
    );
    expect(msg?.body).toContain('$240.00');
  });

  it('will not accept a question that has never been priced', async () => {
    const { token } = await conversation();
    const asked = await askForEstimate(env, token, 'Whole house');
    await expect(decideEstimate(env, token, asked.id, 'accepted'))
      .rejects.toThrow(/not sent a price/i);
  });

  /**
   * A row is only still 'quoted' because nothing has expired it yet. A
   * customer must never be able to accept a start time that has already gone
   * because the cron was late.
   */
  it('refuses a quote whose start time has passed, even before the sweep runs', async () => {
    const { token, estimate } = await quoted();
    // Move the deadline into the past without touching status, which is
    // exactly the state a late cron leaves behind.
    await env.DB.prepare(
      `UPDATE estimates SET expires_at = ?, starts_at = ? WHERE id = ?`,
    ).bind(now() - 60, now() - 60, estimate.id).run();

    await expect(decideEstimate(env, token, estimate.id, 'accepted'))
      .rejects.toThrow(/passed/i);

    const row = await one<{ status: string; order_id: string | null }>(
      `SELECT status, order_id FROM estimates WHERE id = ?`, estimate.id,
    );
    expect(row!.status).toBe('quoted');
    expect(row!.order_id).toBeNull();

    // And nothing was booked on the way to that refusal. An expired quote that
    // still put an appointment on the calendar would be the worst of both: a
    // job the operator thinks is happening, for a morning already gone.
    expect(await count(`SELECT COUNT(*) AS n FROM orders`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM appointments`)).toBe(0);
  });

  /**
   * The estimate is fetched by id AND the thread the token resolved to, so an
   * id lifted from somebody else's link is answered as one that never existed.
   */
  it('will not let one customer decide another customer\'s estimate', async () => {
    const { estimate } = await quoted();
    const { token: strangerToken } = await conversation(OP, 'Someone Else');

    await expect(decideEstimate(env, strangerToken, estimate.id, 'accepted'))
      .rejects.toThrow(/not on your conversation/i);

    const row = await one<{ status: string }>(
      `SELECT status FROM estimates WHERE id = ?`, estimate.id,
    );
    expect(row!.status).toBe('quoted');
  });

  it('refuses a decision that is neither accept nor decline', async () => {
    const { token, estimate } = await quoted();
    await expect(
      decideEstimate(env, token, estimate.id, 'maybe' as 'accepted'),
    ).rejects.toThrow(/accept it or decline it/i);
  });

  /** Declining still books nothing, and says so in the return value. */
  it('returns no order for a decline', async () => {
    const { token, estimate } = await quoted();
    const declined = await decideEstimate(env, token, estimate.id, 'declined');
    expect(declined.order).toBeNull();
    expect(declined.order_id).toBeNull();
    expect(await count(`SELECT COUNT(*) AS n FROM orders`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM appointments`)).toBe(0);
  });
});

// ---------------------------------------------------------------------------

/**
 * A BUSINESS WITH NOWHERE TO BE PAID CANNOT SELL THIS WAY EITHER.
 *
 * The worst state this product can reach is a real card payment taken for a
 * business Stripe will not pay out to: the transfer is skipped every time the
 * sweep runs, nobody asks for a refund because nothing looks wrong, and the
 * customer's money sits in the platform balance with nothing in the product
 * that resolves it. lib/checkout.ts refuses to open a charge for one; an
 * estimate must not be a way round that, at either end of the flow.
 */
describe('a business with nowhere to be paid', () => {
  const BROKE = 'op-no-payouts';

  /** Ask, quote and hand back what a decision needs, at a named business. */
  async function quotedAt(operatorId: string) {
    const { token } = await conversation(operatorId);
    const asked = await askForEstimate(env, token, 'Whole house');
    return { token, estimate: await quoteEstimate(env, operatorId, asked.id, goodQuote()) };
  }

  /**
   * Refused at the door, before a booking exists.
   *
   * assertPayable would catch it later, but by then the appointment is on the
   * operator's calendar and the customer has been told they are booked — and
   * the only thing left to do with that booking fails. priceOrder refuses the
   * same business before it sells anything, and this is the same door.
   */
  it('cannot have its estimate accepted at all', async () => {
    await addOperator(BROKE, 'No Payouts Cleaning', 'broke@example.com',
      { payouts: false });
    const { token, estimate } = await quotedAt(BROKE);

    await expect(decideEstimate(env, token, estimate.id, 'accepted'))
      .rejects.toThrow(/finished setting up payments/i);

    const row = await one<{ status: string; order_id: string | null }>(
      `SELECT status, order_id FROM estimates WHERE id = ?`, estimate.id,
    );
    expect(row!.status).toBe('quoted');
    expect(row!.order_id).toBeNull();
    expect(await count(`SELECT COUNT(*) AS n FROM orders`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM appointments`)).toBe(0);
  });

  /**
   * And if payouts go away AFTER the booking — Stripe can switch them off at
   * any time — the charge is refused rather than taken.
   *
   * This is the assertion that an estimate-born order is an ordinary order as
   * far as the money path is concerned: startPayment reads it, finds its
   * order_item, joins the operator, and applies exactly the gate it applies to
   * a booking sold off the map. It throws before it ever reaches Stripe, which
   * is why no network stub is needed here.
   */
  it('cannot be charged for an estimate booked before payouts were switched off', async () => {
    const { token, estimate } = await quotedAt(OP);
    const accepted = await decideEstimate(env, token, estimate.id, 'accepted');
    expect(accepted.order).not.toBeNull();

    await env.DB.prepare(
      `UPDATE operators SET stripe_payouts_enabled = 0 WHERE id = ?`,
    ).bind(OP).run();

    // A key, so the refusal is the payouts gate and not "cards are off here".
    const paying = { ...env, STRIPE_SECRET_KEY: 'sk_test_not_used' } as Env;
    await expect(startPayment(paying, accepted.order!.id))
      .rejects.toThrow(/finished setting up payments/i);

    const order = await one<{ paid_at: number | null; payment_intent_id: string | null }>(
      `SELECT paid_at, payment_intent_id FROM orders WHERE id = ?`, accepted.order!.id,
    );
    expect(order!.paid_at).toBeNull();
    expect(order!.payment_intent_id).toBeNull();
  });

  /**
   * The ordinary case, and the reason the two above are not simply a broken
   * fixture: with payouts on, the same order opens a charge — for the price on
   * the row the customer tapped and not a cent else.
   *
   * Stripe is stood in for so the amount, the currency and the order the
   * charge names are asserted rather than described. This is the end of the
   * thread the whole feature hangs on: the number in the quote is the number
   * that reaches the card.
   */
  it('opens a charge for exactly the quoted price, against the quoted order', async () => {
    const { token, estimate } = await quotedAt(OP);
    const accepted = await decideEstimate(env, token, estimate.id, 'accepted');

    const posted: Array<Record<string, string>> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: any, init: any = {}) => {
      const path = String(input).replace('https://api.stripe.com/v1', '');
      const body: Record<string, string> = {};
      for (const pair of String(init.body ?? '').split('&')) {
        const [k, v] = pair.split('=');
        if (k) body[decodeURIComponent(k)] = decodeURIComponent(v ?? '');
      }
      posted.push({ path, ...body });
      return new Response(JSON.stringify({
        id: 'pi_test_estimate',
        client_secret: 'pi_test_estimate_secret',
        status: 'requires_payment_method',
        amount: Number(body.amount ?? 0),
        currency: body.currency ?? 'usd',
      }), { status: 200 });
    }) as typeof fetch;

    try {
      const paying = { ...env, STRIPE_SECRET_KEY: 'sk_test_not_used' } as Env;
      const handle = await startPayment(paying, accepted.order!.id);
      expect(handle.amount_cents).toBe(24000);
      expect(handle.currency).toBe('usd');
      expect(handle.paid).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }

    const intent = posted.find((c) => c.path === '/payment_intents');
    expect(intent).toBeDefined();
    // The figure on the estimate, not a recalculated one.
    expect(intent!.amount).toBe('24000');
    expect(intent!.currency).toBe('usd');
    expect(intent!['metadata[order_id]']).toBe(accepted.order!.id);

    // And the order now carries the intent it was charged under, exactly as a
    // booking sold off the map would.
    const order = await one<{ payment_intent_id: string | null; total_cents: number }>(
      `SELECT payment_intent_id, total_cents FROM orders WHERE id = ?`,
      accepted.order!.id,
    );
    expect(order!.payment_intent_id).toBe('pi_test_estimate');
    expect(order!.total_cents).toBe(24000);
  });
});

// ---------------------------------------------------------------------------

describe('withdrawing and expiring', () => {
  it('withdraws a live quote and tells the customer, rather than deleting it', async () => {
    const { thread, token } = await conversation();
    const asked = await askForEstimate(env, token, 'Whole house');
    const q = await quoteEstimate(env, OP, asked.id, goodQuote());

    const w = await withdrawEstimate(env, OP, q.id);
    expect(w.status).toBe('withdrawn');

    const msg = await one<{ body: string }>(
      `SELECT body FROM chat_messages WHERE thread_id = ? AND body LIKE '%withdrew%'`,
      thread.id,
    );
    expect(msg?.body).toContain('withdrew their estimate');
  });

  /**
   * Pretending a price was pulled when none was ever sent would leave the
   * customer waiting for one that is not coming.
   */
  it('says something different when there was never a price', async () => {
    const { thread, token } = await conversation();
    const asked = await askForEstimate(env, token, 'Whole house');
    await withdrawEstimate(env, OP, asked.id);

    const msg = await one<{ body: string }>(
      `SELECT body FROM chat_messages WHERE thread_id = ? AND body LIKE '%cannot take%'`,
      thread.id,
    );
    expect(msg?.body).toContain('cannot take that one on');
  });

  it('cannot withdraw something the customer has already accepted', async () => {
    const { token } = await conversation();
    const asked = await askForEstimate(env, token, 'Whole house');
    const q = await quoteEstimate(env, OP, asked.id, goodQuote());
    await decideEstimate(env, token, q.id, 'accepted');

    await expect(withdrawEstimate(env, OP, q.id)).rejects.toThrow(/accepted/i);
  });

  it('will not let one business withdraw another\'s estimate', async () => {
    const { token } = await conversation();
    const asked = await askForEstimate(env, token, 'Whole house');
    await expect(withdrawEstimate(env, OTHER_OP, asked.id)).rejects.toThrow(/not yours/i);
  });

  /**
   * A quote left 'quoted' forever is a standing offer to book a morning that
   * has already happened. An 'asked' row has no time and no number in it, so
   * expiring one would erase the evidence that nobody answered.
   */
  it('sweeps quotes whose time has gone, and leaves unanswered questions alone', async () => {
    const { token } = await conversation();

    const stale = await askForEstimate(env, token, 'Job one');
    await quoteEstimate(env, OP, stale.id, goodQuote());
    await env.DB.prepare(
      `UPDATE estimates SET expires_at = ?, starts_at = ? WHERE id = ?`,
    ).bind(now() - HOUR, now() - HOUR, stale.id).run();

    const live = await askForEstimate(env, token, 'Job two');
    await quoteEstimate(env, OP, live.id, goodQuote());

    const unanswered = await askForEstimate(env, token, 'Job three');

    expect(await expireEstimates(env)).toBe(1);

    const status = async (id: string) => (await one<{ status: string }>(
      `SELECT status FROM estimates WHERE id = ?`, id,
    ))!.status;
    expect(await status(stale.id)).toBe('expired');
    expect(await status(live.id)).toBe('quoted');
    expect(await status(unanswered.id)).toBe('asked');
  });

  /**
   * expires_at is only set when the quote is sent; a row written by anything
   * else may carry only a start time, and the job starting is the deadline
   * either way.
   */
  it('falls back to the start time when a quote carries no expiry', async () => {
    const { token } = await conversation();
    const e = await askForEstimate(env, token, 'Whole house');
    await quoteEstimate(env, OP, e.id, goodQuote());
    await env.DB.prepare(
      `UPDATE estimates SET expires_at = NULL, starts_at = ? WHERE id = ?`,
    ).bind(now() - HOUR, e.id).run();

    expect(await expireEstimates(env)).toBe(1);
    const row = await one<{ status: string }>(
      `SELECT status FROM estimates WHERE id = ?`, e.id,
    );
    expect(row!.status).toBe('expired');
  });
});

// ---------------------------------------------------------------------------

describe('reading estimates back', () => {
  it('gives a customer only what is on their own conversation', async () => {
    const { token: mine } = await conversation(OP, 'Rosa');
    const { token: theirs } = await conversation(OP, 'Someone Else');
    await askForEstimate(env, mine, 'My job');
    await askForEstimate(env, theirs, 'Their job');

    const forMe = await estimatesForGuest(env, mine);
    expect(forMe).toHaveLength(1);
    expect(forMe[0]!.request).toContain('My job');

    // A token that resolves to nothing gets an empty list, not somebody else's.
    expect(await estimatesForGuest(env, 'not-a-token')).toEqual([]);
  });

  it('scopes an operator to their own, and filters by status and thread', async () => {
    const { thread: t1, token: k1 } = await conversation(OP, 'Rosa');
    const { token: k2 } = await conversation(OP, 'Dev');
    const a1 = await askForEstimate(env, k1, 'Job one');
    await askForEstimate(env, k2, 'Job two');
    await quoteEstimate(env, OP, a1.id, goodQuote());

    // Another business's conversation must not appear in this one's list.
    const { token: other } = await conversation(OTHER_OP, 'Not mine');
    await askForEstimate(env, other, 'Somebody else entirely');

    const all = await estimatesForOperator(env, OP);
    expect(all).toHaveLength(2);
    expect(all.every((e) => e.operator_id === OP)).toBe(true);

    const onlyQuoted = await estimatesForOperator(env, OP, { status: 'quoted' });
    expect(onlyQuoted.map((e) => e.id)).toEqual([a1.id]);

    const onlyThread = await estimatesForOperator(env, OP, { thread_id: t1.id });
    expect(onlyThread.map((e) => e.id)).toEqual([a1.id]);

    expect(await estimatesForOperator(env, OTHER_OP)).toHaveLength(1);
  });

  it('holds the guest link to one thread, so a stale token reads nothing', async () => {
    const { token } = await conversation();
    await askForEstimate(env, token, 'Whole house');
    // The token is the only credential; resolving it is what scopes the read.
    const thread = await threadByToken(env, token);
    expect(thread).not.toBeNull();
    expect((await estimatesForGuest(env, token))[0]!.thread_id).toBe(thread!.id);
  });
});
