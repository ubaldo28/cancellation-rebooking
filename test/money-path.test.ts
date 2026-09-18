import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import type { Env } from '../src/types';
import { newId, now } from '../src/lib/util';
import {
  markPaid, reconcileUnpaidOrders, refundItem, settleDueWork, settleOrder,
  startPayment, sweepRefunds,
} from '../src/lib/checkout';
import { cancelByCustomer, cancelByOperator, feesOwed, markArrived } from '../src/lib/bypass';
import { answerWork, settleExpiredHolds, WATCH_TAIL_SECONDS } from '../src/lib/settlement';
import { placeOrder } from '../src/lib/orders';

/**
 * THE MONEY ACTUALLY MOVING, IN BOTH DIRECTIONS.
 *
 * checkout-payment.test.ts covers the charge and the split. This file covers
 * the three ways the money used to go missing, each of which was invisible
 * from every screen involved:
 *
 *   a refund that was decided, written down, quoted to the customer on their
 *   own cancellation screen — and never sent to anybody's card;
 *
 *   every business paid seconds after the card cleared and days before the
 *   job, so the money for a cancellation was already gone when the customer
 *   asked for it back;
 *
 *   a business that never finished onboarding taking a real payment it could
 *   never be paid out of.
 *
 * Stripe is stood in for exactly as it is in checkout-payment.test.ts: the
 * calls go out through fetch, so fetch is what is replaced, and the assertions
 * are on the REQUEST BODIES — the amounts, the intent, the idempotency keys —
 * rather than on this code's own opinion of what it sent.
 */

let env: Env;
/** Every request the code made to Stripe, in order. */
let calls: Array<{
  path: string; method: string;
  body: Record<string, string>; idempotency: string | null;
}>;
/** Never reset, because Stripe object ids are unique forever. */
let issued = 0;
let lastIntent = '';

const $ = (dollars: number) => Math.round(dollars * 100);
const HOUR = 3600;

const refunds = () => calls.filter((c) => c.path === '/refunds');
const transfers = () => calls.filter((c) => c.path === '/transfers');
const intents = () => calls.filter((c) => c.path === '/payment_intents');

/**
 * What Stripe has already made under each idempotency key, and the objects it
 * has made at all.
 *
 * THE STUB REPLAYS A KEY, BECAUSE STRIPE DOES, and without that half of it the
 * idempotency keys in this Worker are untested. A stub that mints a fresh id
 * for every request lets a test "prove" that one transfer happened purely
 * because the database guard caught the second write — which is exactly the
 * assertion the old overlap tests were making, and they would have passed with
 * every idempotency key deleted from the codebase. Replaying makes the two
 * distinguishable: the number of REQUESTS says how many callers asked, and the
 * number of OBJECTS says how many times Stripe actually moved money.
 */
let byKey: Map<string, { status: number; body: any }>;
/** Every object Stripe really created, as opposed to every request it answered. */
let made: { transfers: any[]; refunds: any[] };
/** Amount per intent, so a re-read of one answers with what it was opened for. */
let intentAmounts: Map<string, number>;

const distinct = (rows: Array<{ id: string }>) => new Set(rows.map((r) => r.id)).size;

/** Stripe, as far as this Worker can tell. Refuses anything it has not been taught. */
function stripeStub(opts: {
  refundsFail?: number;
  /** What that failure IS. A rate limit and a decline are not the same news. */
  refundFailure?: { status: number; code: string; type: string; message: string };
  /** What a re-read of an open intent says, which is how a lost webhook is staged. */
  intentStatus?: string;
  /** What the connected account says when the payout sweep asks it. */
  payouts?: boolean;
} = {}) {
  let refundFailures = opts.refundsFail ?? 0;
  return vi.fn(async (input: any, init: any = {}) => {
    const path = String(input).replace('https://api.stripe.com/v1', '');
    const method = String(init.method ?? 'GET').toUpperCase();
    const body: Record<string, string> = {};
    if (init.body) {
      for (const pair of String(init.body).split('&')) {
        const [k, v] = pair.split('=');
        body[decodeURIComponent(k!)] = decodeURIComponent(v ?? '');
      }
    }
    const key: string | null = init.headers?.['idempotency-key'] ?? null;
    calls.push({ path, method, body, idempotency: key });

    // Seen this key before: hand back exactly what it produced, including if
    // that was a refusal. This is the behaviour every attempt counter in the
    // Worker exists to work around.
    if (key && byKey.has(key)) {
      const held = byKey.get(key)!;
      return new Response(JSON.stringify(held.body), { status: held.status });
    }
    const answer = (status: number, payload: any) => {
      // A 409 or a 429 is not a RESULT and Stripe does not file one under the
      // key — which is the whole reason the retry is allowed to reuse it.
      if (key && status !== 409 && status !== 429) byKey.set(key, { status, body: payload });
      return new Response(JSON.stringify(payload), { status });
    };

    if (path === '/payment_intents') {
      issued += 1;
      lastIntent = `pi_test_${issued}`;
      intentAmounts.set(lastIntent, Number(body.amount ?? 0));
      return answer(200, {
        id: lastIntent,
        client_secret: `${lastIntent}_secret_abc`,
        status: 'requires_payment_method',
        amount: Number(body.amount ?? 0),
        currency: body.currency ?? 'usd',
      });
    }
    if (path.startsWith('/payment_intents/')) {
      const id = decodeURIComponent(path.split('/').pop()!);
      if (method === 'POST') intentAmounts.set(id, Number(body.amount ?? 0));
      return answer(200, {
        id,
        client_secret: `${id}_secret_abc`,
        status: method === 'POST'
          ? 'requires_payment_method'
          : (opts.intentStatus ?? 'requires_payment_method'),
        amount: intentAmounts.get(id) ?? 0,
        currency: 'usd',
        // AN OBJECT, NOT A STRING, and deliberately. Stripe expands this
        // whenever anything asks it to, and String() on it writes the literal
        // text "[object Object]" into orders.charge_id — which then reaches
        // createTransfer as source_transaction and is rejected.
        latest_charge: { id: 'ch_reconciled', object: 'charge' },
      });
    }
    if (path === '/transfers' && method === 'POST') {
      issued += 1;
      const transfer = {
        id: `tr_test_${issued}`,
        amount: Number(body.amount ?? 0),
        destination: body.destination ?? '',
        metadata: { order_item_id: body['metadata[order_item_id]'] ?? '' },
      };
      made.transfers.push(transfer);
      return answer(200, transfer);
    }
    if (path.startsWith('/transfers?')) {
      return new Response(JSON.stringify({ data: made.transfers }), { status: 200 });
    }
    if (path === '/refunds' && method === 'POST') {
      if (refundFailures > 0) {
        refundFailures -= 1;
        const failure = opts.refundFailure ?? {
          // A refusal Stripe actually made, which is the case that matters: it
          // read the request and created nothing.
          status: 400,
          message: 'Charge has already been refunded.',
          code: 'charge_already_refunded',
          type: 'invalid_request_error',
        };
        return answer(failure.status, {
          error: {
            message: failure.message, code: failure.code, type: failure.type,
          },
        });
      }
      issued += 1;
      const refund = {
        id: `re_test_${issued}`,
        amount: Number(body.amount ?? 0),
        status: 'succeeded',
        payment_intent: body.payment_intent ?? '',
        metadata: { order_item_id: body['metadata[order_item_id]'] ?? '' },
      };
      made.refunds.push(refund);
      return answer(200, refund);
    }
    if (path.startsWith('/refunds?')) {
      const intent = decodeURIComponent(
        path.split('payment_intent=')[1]!.split('&')[0]!);
      return new Response(JSON.stringify({
        data: made.refunds.filter((r) => r.payment_intent === intent),
      }), { status: 200 });
    }
    // The payout sweep asks the account itself whether it can still be paid
    // rather than reading the cached flag on the operator row; migration 0040
    // says so beside that column.
    if (path.startsWith('/accounts/')) {
      return new Response(JSON.stringify({
        id: decodeURIComponent(path.split('/').pop()!),
        charges_enabled: true,
        payouts_enabled: opts.payouts !== false,
        details_submitted: true,
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: `unstubbed ${path}` } }),
      { status: 400 });
  });
}

const OP = 'op-money';
const PREV = { lat: 34.1500, lng: -118.4490 };
const NEXT = { lat: 34.1520, lng: -118.4400 };
const NEAR = { lat: 34.1510, lng: -118.4450 };

const BUYER = {
  guest_name: 'Rosa', phone: '(818) 555-0142',
  address_line: '15200 Ventura Blvd', postcode: '91403',
};

const one = async <T>(sql: string, ...args: unknown[]) =>
  env.DB.prepare(sql).bind(...args).first<T>();

const itemRow = (id: string) => one<{
  transfer_id: string | null; transferred_at: number | null;
  refund_id: string | null; refunded_at: number | null; refund_cents: number | null;
  refund_error: string | null; refund_attempts: number; refund_reason: string | null;
  settlement: string; fee_cents: number; price_cents: number;
}>(
  `SELECT transfer_id, transferred_at, refund_id, refunded_at, refund_cents,
          refund_error, refund_attempts, refund_reason, settlement, fee_cents,
          price_cents
     FROM order_items WHERE id = ?`, id);

/**
 * One business, and as many openings as the test needs.
 *
 * Built through placeOrder rather than by hand, unlike checkout-payment's
 * fixture, because everything here turns on what a CANCELLATION does — and a
 * cancellation needs the appointment, the claim and the guest thread that only
 * the real booking path creates.
 */
async function seed(opts: {
  hoursOut?: number;
  jobs?: number;
  payouts?: boolean;
  account?: string | null;
  priceCents?: number;
} = {}) {
  const hoursOut = opts.hoursOut ?? 72;
  const jobs = opts.jobs ?? 1;
  env = {
    ...makeEnv(ALL_MIGRATIONS),
    STRIPE_SECRET_KEY: 'sk_test_stub',
    APP_URL: 'https://roundtheway.app',
  } as unknown as Env;
  const n = now();

  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,trade,timezone,country,currency,language,
       location_mode,fill_model,sms_mode,max_detour_seconds,min_gap_seconds,buffer_seconds,
       offer_ttl_seconds,offers_per_wave,min_notice_seconds,reoffer_cooldown_seconds,
       discount_percent,plan,accept_public_bookings,deposit_cents,share_location,
       stripe_account_id,stripe_charges_enabled,stripe_payouts_enabled,
       created_at,updated_at)
     VALUES (?,?,?, 'mobile car wash and detailing','America/Los_Angeles','US','USD','en',
       'mobile','both','device',3600,3600,900,5400,3,3600,604800,0,'active',1,0,1,
       ?,1,?,?,?)`,
  ).bind(OP, 'o@x.com', 'Valley Detailing',
    opts.account === undefined ? 'acct_valley' : opts.account,
    opts.payouts === false ? 0 : 1, n, n).run();

  await env.DB.prepare(
    `INSERT INTO services (id,operator_id,name,duration_seconds,price_cents,created_at,updated_at)
     VALUES ('s1',?, 'Full detail',3600,?,?,?)`,
  ).bind(OP, opts.priceCents ?? $(200), n, n).run();

  await env.DB.prepare(
    `INSERT INTO postal_codes (country_code,postal_code,place_name,lat,lng,accuracy)
     VALUES ('US','91403','Sherman Oaks',?,?,6)`,
  ).bind(NEAR.lat, NEAR.lng).run();

  const gapIds: string[] = [];
  for (let i = 0; i < jobs; i++) {
    const gapId = newId();
    const starts = n + (hoursOut + i * 24) * HOUR;
    await env.DB.prepare(
      `INSERT INTO gaps (id,operator_id,starts_at,ends_at,prev_lat,prev_lng,next_lat,next_lng,
         baseline_drive_seconds,is_mobile,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,180,1,'open',?,?)`,
    ).bind(gapId, OP, starts, starts + 5 * HOUR,
      PREV.lat, PREV.lng, NEXT.lat, NEXT.lng, n, n).run();
    gapIds.push(gapId);
  }

  const order = await placeOrder(env, {
    ...BUYER,
    items: gapIds.map((gap_id) => ({ gap_id, service_ids: ['s1'] })),
  });
  return {
    order_id: order.order_id,
    items: order.items.map((i) => i.order_item_id),
    item: order.items[0]!.order_item_id,
    token: order.thread_token,
  };
}

/**
 * Age the booking past the half-hour grace window.
 *
 * Everything here is booked and cancelled in the same millisecond, which is
 * inside the window for the obvious mistake — wrong day, wrong address — and
 * that window refunds in full whatever the clock says about the appointment.
 * Without this, every test below would be testing the grace rule rather than
 * the rung of the ladder it means to test.
 */
const bookedEarlier = (id: string) => env.DB.prepare(
  `UPDATE order_items SET created_at = ? WHERE id = ?`,
).bind(now() - 2 * HOUR, id).run();

/** The card clears. Everything downstream of here is money the platform holds. */
async function pay(orderId: string) {
  await startPayment(env, orderId);
  await markPaid(env, lastIntent, 'ch_1');
}

/** Move one booking into the past, as the fifteen-minute cron would find it. */
const finished = (id: string, endedSecondsAgo: number) => env.DB.prepare(
  `UPDATE order_items SET starts_at = ?, ends_at = ? WHERE id = ?`,
).bind(now() - endedSecondsAgo - HOUR, now() - endedSecondsAgo, id).run();

/** Let a frozen cancellation's hold run out, exactly as the cron does. */
async function releaseHold(id: string) {
  await env.DB.prepare(`UPDATE order_items SET hold_until = ? WHERE id = ?`)
    .bind(now() - 1, id).run();
  await settleExpiredHolds(env);
}

beforeEach(() => {
  calls = [];
  lastIntent = '';
  byKey = new Map();
  made = { transfers: [], refunds: [] };
  intentAmounts = new Map();
  vi.stubGlobal('fetch', stripeStub());
});
afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------

describe('the refund a customer was promised', () => {
  it('reaches the card, for the amount they were quoted', async () => {
    const { order_id, item, token } = await seed({ hoursOut: 72 });
    await pay(order_id);
    calls = [];

    // Three days out: "More than 48 hours away, so you get all of it back."
    const res = await cancelByCustomer(env, token, item);
    expect(res.refund.cents).toBe($(200));

    // NOT YET, and deliberately. The cancellation freezes both sides — the
    // doorstep bypass is a customer cancelling for a full refund and having
    // the work done for cash anyway — so nothing goes back until the hold has
    // run out with no evidence of a van turning up. See settlement.ts.
    expect(refunds()).toHaveLength(0);
    expect((await itemRow(item))!.settlement).toBe('held');

    await releaseHold(item);
    expect((await itemRow(item))!.settlement).toBe('released');

    expect(await sweepRefunds(env)).toEqual({ refunded: 1, failed: 0, retried: 0 });

    // The request Stripe actually received, not this code's opinion of it.
    expect(refunds()).toHaveLength(1);
    expect(refunds()[0]!.body.payment_intent).toBe(lastIntent);
    expect(refunds()[0]!.body.amount).toBe(String($(200)));
    expect(refunds()[0]!.body.reason).toBe('requested_by_customer');
    // Keyed on the LINE. An order-and-amount key refunded one of two identical
    // jobs in the same basket and handed the second a copy of the first.
    expect(refunds()[0]!.idempotency).toBe(`rf:${item}:0`);

    const row = (await itemRow(item))!;
    expect(row.refund_id).toMatch(/^re_test_/);
    expect(row.refunded_at).toBeGreaterThan(0);
    expect(row.refund_error).toBeNull();
  });

  it('gives back a quarter when that is what the ladder said', async () => {
    // Inside twelve hours the customer keeps a quarter and the business keeps
    // the rest for the time it held. The number sent to Stripe has to be the
    // number the cancellation screen showed, or the two disagree in public.
    const { order_id, item, token } = await seed({ hoursOut: 6 });
    await pay(order_id);
    await bookedEarlier(item);
    calls = [];

    const res = await cancelByCustomer(env, token, item);
    await releaseHold(item);
    await sweepRefunds(env);

    expect(refunds()[0]!.body.amount).toBe(String(res.refund.cents));
    expect(res.refund.cents).toBe($(50));            // a quarter of $200
  });

  it('refunds once when three callers ask AT THE SAME TIME', async () => {
    // WHAT THIS USED TO TEST, WHICH WAS NOTHING. It called refundItem twice in
    // a row and asserted one refund — and the first call finishes writing
    // refund_id before the second one reads the row, so the second returned
    // early without going near Stripe. The assertion held with every
    // idempotency key deleted from the codebase, which is the opposite of what
    // it was named for.
    //
    // The race is real and ordinary: the customer answers the work question on
    // their phone (index.ts refunds inline so they do not wait a quarter of an
    // hour), the cron's refund sweep runs in the same second, and a support
    // person clicks the button. All three read a row with no refund on it and
    // all three send a request. Only Stripe can stop that being three refunds,
    // and only if the key is right.
    const { order_id, item, token } = await seed({ hoursOut: 72 });
    await pay(order_id);
    await cancelByCustomer(env, token, item);
    await releaseHold(item);
    calls = [];

    const [first, second, third] = await Promise.all([
      refundItem(env, item), refundItem(env, item), refundItem(env, item),
    ]);

    // Three callers really did ask Stripe — this is a race, not a queue.
    expect(refunds().length).toBeGreaterThan(1);
    // Under ONE key, so Stripe answered two of them with a copy of the first.
    expect(new Set(refunds().map((c) => c.idempotency))).toEqual(
      new Set([`rf:${item}:0`]));
    // And made exactly one refund. This is the assertion that fails the moment
    // the key stops being sent.
    expect(distinct(made.refunds)).toBe(1);
    expect(made.refunds[0]!.amount).toBe($(200));

    // Every caller was told the truth, and they agree about which refund it is.
    const ids = [first, second, third].map((r) => (r as { refund_id: string }).refund_id);
    expect(new Set(ids).size).toBe(1);
    expect([first, second, third].filter((r) => (r as { already: boolean }).already))
      .toHaveLength(2);
    expect((await itemRow(item))!.refund_id).toBe(ids[0]);

    // And the sweep on top of all of it still moves nothing.
    await sweepRefunds(env);
    expect(distinct(made.refunds)).toBe(1);
  });

  it('does not look like it worked when Stripe refused it', async () => {
    vi.stubGlobal('fetch', stripeStub({ refundsFail: 1 }));
    const { order_id, item, token } = await seed({ hoursOut: 72 });
    await pay(order_id);
    await cancelByCustomer(env, token, item);
    await releaseHold(item);
    calls = [];

    expect(await sweepRefunds(env)).toMatchObject({ refunded: 0, failed: 1 });

    const failed = (await itemRow(item))!;
    expect(failed.refund_id).toBeNull();              // no money moved
    expect(failed.refunded_at).toBeNull();
    expect(failed.refund_error).toMatch(/already been refunded/);
    // Stripe answered 4xx, so it read the request and created nothing. The
    // attempt counter moves, which is what gets the retry a fresh idempotency
    // key instead of the stored failure Stripe caches for 24 hours.
    expect(failed.refund_attempts).toBe(1);

    // The next tick tries again rather than parking it, and says out loud that
    // this one has failed before.
    expect(await sweepRefunds(env)).toEqual({ refunded: 1, failed: 0, retried: 1 });
    expect(refunds()[1]!.idempotency).toBe(`rf:${item}:1`);
    expect((await itemRow(item))!.refund_error).toBeNull();
  });

  it('keeps the same key when Stripe only said it was too busy', async () => {
    // A 429 is not a refusal. Stripe never reached the thing that would have
    // created a refund, so nobody knows whether one exists — and the old test
    // for that was the status range, which counted it as a definite decline,
    // moved the attempt counter and therefore moved the idempotency key. The
    // retry was then a brand new request, and the customer could be paid back
    // twice out of one charge.
    vi.stubGlobal('fetch', stripeStub({
      refundsFail: 1,
      refundFailure: {
        status: 429, code: 'rate_limit', type: 'rate_limit_error',
        message: 'Too many requests hit the API too quickly.',
      },
    }));
    const { order_id, item, token } = await seed({ hoursOut: 72 });
    await pay(order_id);
    await cancelByCustomer(env, token, item);
    await releaseHold(item);
    calls = [];

    expect(await sweepRefunds(env)).toMatchObject({ refunded: 0, failed: 1 });
    const failed = (await itemRow(item))!;
    expect(failed.refund_id).toBeNull();
    expect(failed.refund_error).toMatch(/too many requests/i);
    // THE COUNTER DOES NOT MOVE, which is the whole point.
    expect(failed.refund_attempts).toBe(0);

    expect(await sweepRefunds(env)).toEqual({ refunded: 1, failed: 0, retried: 1 });
    // Same key both times, so Stripe deduplicates the two rather than making
    // two refunds. It also asked Stripe what it already held before re-sending,
    // because a key only protects a retry for 24 hours and this sweep runs
    // every fifteen minutes for as long as the row exists.
    expect(refunds().map((c) => c.idempotency))
      .toEqual([`rf:${item}:0`, `rf:${item}:0`]);
    expect(calls.some((c) => c.path.startsWith('/refunds?payment_intent='))).toBe(true);
    expect(distinct(made.refunds)).toBe(1);
  });

  it('does not pay the customer twice when the write-back failed, not the refund',
    async () => {
      // The refund goes through and the row recording it does not: an isolate
      // evicted, D1 unavailable for a second. The throw used to escape past
      // recordRefundFailure entirely, so refund_error stayed NULL and the line
      // looked exactly like one that had never been tried — and a day later,
      // with the idempotency key expired, the sweep refunded it again.
      const { order_id, item, token } = await seed({ hoursOut: 72 });
      await pay(order_id);
      await cancelByCustomer(env, token, item);
      await releaseHold(item);
      calls = [];

      const real = env.DB.prepare.bind(env.DB);
      let broken = true;
      (env.DB as any).prepare = (sql: string) => {
        if (broken && sql.includes('SET refund_id =')) {
          broken = false;
          return { bind: () => ({ run: () => { throw new Error('D1_ERROR: network'); } }) };
        }
        return real(sql);
      };

      await expect(refundItem(env, item)).rejects.toThrow(/D1_ERROR/);
      expect(distinct(made.refunds)).toBe(1);

      // Visible as a refund that needs looking at, and NOT counted as a
      // refusal: Stripe created something, so the retry must reuse the key.
      const stuck = (await itemRow(item))!;
      expect(stuck.refund_id).toBeNull();
      expect(stuck.refund_attempts).toBe(0);
      expect(stuck.refund_error).toMatch(/could not be written down/i);

      // The next tick finds the refund Stripe is already holding rather than
      // sending a second one, and writes it down.
      expect(await sweepRefunds(env)).toEqual({ refunded: 1, failed: 0, retried: 1 });
      expect(distinct(made.refunds)).toBe(1);
      expect((await itemRow(item))!.refund_id).toBe(made.refunds[0]!.id);
    });

  it('goes back in full when the business cancelled and never came', async () => {
    // The operator's side of the same machinery, and the one the customer is
    // least at fault for. They are asked one question — did the work happen
    // anyway? — and answering "no, they left" is what unfreezes their money.
    // This is the path /api/public/threads/:token/answer/:id runs.
    const { order_id, item, token } = await seed({ hoursOut: 72 });
    await pay(order_id);
    await cancelByOperator(env, OP, item);
    calls = [];

    const answered = await answerWork(env, token, item, 'not_done');
    expect(answered).toEqual({ settlement: 'released', refund_cents: $(200) });

    await refundItem(env, item);
    expect(refunds()).toHaveLength(1);
    expect(refunds()[0]!.body.amount).toBe(String($(200)));
    expect((await itemRow(item))!.refund_id).toMatch(/^re_test_/);
  });

  it('refunds nothing for an order nobody ever paid for', async () => {
    // The card form was abandoned, then the booking was cancelled. There is
    // money owed on paper and none of it was ever taken.
    const { item, token } = await seed({ hoursOut: 72 });
    await cancelByCustomer(env, token, item);
    await releaseHold(item);

    expect(await refundItem(env, item)).toEqual({ refunded: false, reason: 'not_paid' });
    expect(await sweepRefunds(env)).toMatchObject({ refunded: 0, failed: 0 });
    expect(refunds()).toHaveLength(0);
  });

  it('leaves a frozen cancellation alone until somebody answers', async () => {
    const { order_id, item, token } = await seed({ hoursOut: 72 });
    await pay(order_id);
    await cancelByCustomer(env, token, item);

    expect(await refundItem(env, item)).toEqual({ refunded: false, reason: 'still_held' });
    expect(refunds()).toHaveLength(0);
  });
});

describe('the business is paid after the work, not before it', () => {
  it('transfers nothing while the job is still days away', async () => {
    const { order_id, item } = await seed({ hoursOut: 72 });
    await pay(order_id);
    calls = [];

    // This is the whole defect: the webhook used to settle here, seconds after
    // the card cleared, and the money for Friday's job left the platform on
    // Tuesday. A customer cancelling on Wednesday was then refunded out of the
    // platform's own pocket, because a Transfer cannot be pulled back.
    expect(await settleDueWork(env)).toEqual({ orders: 0, transferred: 0, skipped: 0 });
    expect(transfers()).toHaveLength(0);
    expect((await itemRow(item))!.transfer_id).toBeNull();
  });

  it('transfers nothing the minute the job ends, either', async () => {
    // The appointment being over is not enough. A customer whose van never
    // turned up is saying so in the hour afterwards, and money already sent to
    // a bank account cannot answer them.
    const { order_id, item } = await seed({ hoursOut: 72 });
    await pay(order_id);
    await finished(item, 60);
    calls = [];

    expect(await settleDueWork(env)).toMatchObject({ transferred: 0 });
    expect(transfers()).toHaveLength(0);
  });

  it('transfers once the work is done and the window has closed', async () => {
    const { order_id, item } = await seed({ hoursOut: 72 });
    await pay(order_id);
    await finished(item, WATCH_TAIL_SECONDS + 60);
    calls = [];

    expect(await settleDueWork(env)).toMatchObject({ orders: 1, transferred: 1 });
    expect(transfers()).toHaveLength(1);
    expect(transfers()[0]!.body.amount).toBe(String($(170)));   // $200 less 15%
    expect(transfers()[0]!.body.destination).toBe('acct_valley');
    expect(transfers()[0]!.body.source_transaction).toBe('ch_1');
    expect(transfers()[0]!.idempotency).toBe(`tr:${item}`);

    const row = (await itemRow(item))!;
    expect(row.transfer_id).toMatch(/^tr_test_/);
    expect(row.transferred_at).toBeGreaterThan(0);
  });

  it('pays the finished job and leaves the one next week alone', async () => {
    // One basket, two appointments, a week apart. The first one being done is
    // not a reason to send the money for the second.
    const { order_id, items } = await seed({ hoursOut: 72, jobs: 2 });
    await pay(order_id);
    await finished(items[0]!, WATCH_TAIL_SECONDS + 60);
    calls = [];

    await settleDueWork(env);
    expect(transfers()).toHaveLength(1);
    expect(transfers()[0]!.body.amount).toBe(String($(170)));
    expect((await itemRow(items[0]!))!.transfer_id).toMatch(/^tr_test_/);
    expect((await itemRow(items[1]!))!.transfer_id).toBeNull();

    // And the second one is paid on its own day, without the first being paid
    // twice on the way.
    await finished(items[1]!, WATCH_TAIL_SECONDS + 60);
    await settleDueWork(env);
    expect(transfers()).toHaveLength(2);
    expect((await itemRow(items[1]!))!.transfer_id).toMatch(/^tr_test_/);
  });

  it('pays once when three sweeps run AT THE SAME TIME', async () => {
    // WHAT THIS USED TO TEST, WHICH WAS NOTHING. Three sequential calls, one
    // transfer asserted — and the first call writes transfer_id before the
    // second one reads it, so the second never reached Stripe at all. It
    // passed with every idempotency key removed.
    //
    // Overlapping ticks are the actual failure mode. The sweep runs every
    // fifteen minutes and a slow pass after an outage outlives its own
    // interval, so two of them read the same due list and both decide to pay
    // the same business. The database guard cannot help: both read a NULL
    // transfer_id before either writes one.
    const { order_id, item } = await seed({ hoursOut: 72 });
    await pay(order_id);
    await finished(item, WATCH_TAIL_SECONDS + 60);
    calls = [];

    await Promise.all([settleDueWork(env), settleDueWork(env), settleDueWork(env)]);

    // All three really did ask Stripe to move the money.
    expect(transfers().length).toBeGreaterThan(1);
    // Under one key, and for one amount — which is what lets Stripe recognise
    // them as the same request rather than as three payouts.
    expect(new Set(transfers().map((c) => c.idempotency))).toEqual(
      new Set([`tr:${item}`]));
    expect(new Set(transfers().map((c) => c.body.amount))).toEqual(
      new Set([String($(170))]));
    // One transfer made. Delete the key and this becomes three.
    expect(distinct(made.transfers)).toBe(1);

    const row = (await itemRow(item))!;
    expect(row.transfer_id).toBe(made.transfers[0]!.id);
  });

  it('never transfers money that is frozen by a cancellation', async () => {
    const { order_id, item, token } = await seed({ hoursOut: 72 });
    await pay(order_id);
    await cancelByCustomer(env, token, item);
    await finished(item, WATCH_TAIL_SECONDS + 60);
    calls = [];

    // The customer's refund is still being decided. Paying the operator now
    // would settle that question in their favour without asking it.
    expect(await settleDueWork(env)).toMatchObject({ transferred: 0 });
    expect(transfers()).toHaveLength(0);
  });
});

describe('a business with nowhere to be paid', () => {
  it('cannot take the money in the first place', async () => {
    // THE REFUSAL MOVED EARLIER; IT DID NOT GO AWAY.
    //
    // This used to get as far as an appointment and be turned away at the till
    // by assertPayable. priceOrder now refuses to sell the opening at all, so
    // "in the first place" is literal: the booking itself fails, and there is
    // no order, no claim and no appointment a customer has been promised.
    // The opening simply reads as unlisted — which is what it is from the
    // customer's side, and is the only answer that does not tell a stranger
    // about somebody's bank arrangements.
    //
    // The fixture is deliberately unpayable. Do not "fix" it with payouts: 1 —
    // an operator with somewhere to be paid is exactly what this test is not.
    await expect(seed({ hoursOut: 72, payouts: false }))
      .rejects.toThrow(/no longer listed/i);

    // Nothing was written and no card was touched.
    expect(intents()).toHaveLength(0);
    expect((await one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM orders`))!.n).toBe(0);
    expect((await one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM public_claims`))!.n).toBe(0);
  });

  it('is still refused at the till when payouts lapse after the booking', async () => {
    // The second wall, and the one the first cannot replace: the sale was
    // legitimate when it was made and the flag went to 0 afterwards — an
    // account.updated from Stripe arriving between the booking and the
    // payment. priceOrder is long past by then, so assertPayable is all that
    // stands between a real card and money with nowhere to go.
    const { order_id } = await seed({ hoursOut: 72 });
    await env.DB.prepare(`UPDATE operators SET stripe_payouts_enabled = 0 WHERE id = ?`)
      .bind(OP).run();
    calls = [];

    // Refused where it costs nothing: no card has been touched, the
    // appointment is still theirs, and the business is told what is missing.
    await expect(startPayment(env, order_id)).rejects.toThrow(/setting up payments/i);
    expect(intents()).toHaveLength(0);
  });

  it('is skipped rather than breaking the order when the account is missing', async () => {
    // payouts_enabled says yes and there is no account id to send it to — the
    // cache and Stripe disagreeing, which is the state the flag is a copy of.
    const { order_id, item } = await seed({ hoursOut: 72, account: null });
    await pay(order_id);
    await finished(item, WATCH_TAIL_SECONDS + 60);
    calls = [];

    const res = await settleDueWork(env);
    expect(res).toMatchObject({ transferred: 0, skipped: 1 });
    expect(transfers()).toHaveLength(0);
    // Waiting, not lost: the money is still in the platform balance and the
    // next sweep after they finish onboarding pays it.
    expect((await itemRow(item))!.transfer_id).toBeNull();

    await env.DB.prepare(`UPDATE operators SET stripe_account_id = 'acct_late' WHERE id = ?`)
      .bind(OP).run();
    expect(await settleDueWork(env)).toMatchObject({ transferred: 1 });
    expect(transfers()[0]!.body.destination).toBe('acct_late');
  });
});

describe('a line that was cancelled before anybody paid', () => {
  it('is not charged for, not fee-d, and not transferred', async () => {
    const { order_id, items } = await seed({ hoursOut: 72, jobs: 2 });
    const [gone, live] = items as [string, string];

    // The operator's van breaks down an hour after the booking and before the
    // customer has got as far as paying.
    await cancelByOperator(env, OP, gone);
    calls = [];

    await startPayment(env, order_id);
    // ONE job's money, not two. The basket total is not lowered by a
    // cancellation, so charging it would have taken $400 for one $200 job.
    expect(intents()).toHaveLength(1);
    expect(intents()[0]!.body.amount).toBe(String($(200)));
    expect((await one<{ total_cents: number }>(
      `SELECT total_cents FROM orders WHERE id = ?`, order_id))!.total_cents).toBe($(200));

    // No share of the fee either, and nothing owed back on a line that was
    // never charged for — otherwise the refund sweep would later hand the
    // customer the money for the job that is still going ahead.
    expect((await itemRow(gone))!.fee_cents).toBe(0);
    expect((await itemRow(gone))!.refund_cents).toBe(0);
    expect((await itemRow(live))!.fee_cents).toBe($(30));

    await markPaid(env, lastIntent, 'ch_1');
    await finished(live, WATCH_TAIL_SECONDS + 60);
    await finished(gone, WATCH_TAIL_SECONDS + 60);
    calls = [];

    await settleDueWork(env);
    await sweepRefunds(env);

    // The surviving job is paid for and paid out. The cancelled one is not in
    // either direction — no transfer, no refund of money nobody took.
    expect(transfers()).toHaveLength(1);
    expect(transfers()[0]!.body.amount).toBe(String($(170)));
    expect(refunds()).toHaveLength(0);
    expect((await itemRow(gone))!.transfer_id).toBeNull();
    expect((await itemRow(live))!.transfer_id).toMatch(/^tr_test_/);
  });
});

describe('a late cancellation the business owes for', () => {
  const fee = () => one<{ status: string; cents: number; settled_cents: number }>(
    `SELECT status, cents, settled_cents FROM lead_fees WHERE operator_id = ?`, OP);

  it('comes off their next payout, which is what the Terms say', async () => {
    // The fee was raised, shown to the operator, allowed to block their
    // listing — and nothing in the product ever collected one. settleFee was
    // exported and called by nobody, so the only way to settle a fee was for a
    // person to run it by hand, while the Terms told businesses it came off
    // their next payout.
    const { order_id, items } = await seed({ hoursOut: 30, jobs: 2 });
    const [cancelled, live] = items as [string, string];

    // Inside 48 hours, so a quarter of the job: $50 of a $200 booking.
    const res = await cancelByOperator(env, OP, cancelled, 'took a better job');
    expect(res.fee!.cents).toBe($(50));

    await pay(order_id);
    await finished(live, WATCH_TAIL_SECONDS + 60);
    calls = [];

    await settleDueWork(env);

    // $200 less the platform's 15% is $170, less the $50 they owe.
    expect(transfers()).toHaveLength(1);
    expect(transfers()[0]!.body.amount).toBe(String($(120)));

    const owed = (await fee())!;
    expect(owed.status).toBe('paid');
    expect(owed.settled_cents).toBe($(50));
    expect((await feesOwed(env, OP)).cents).toBe(0);
  });

  it('never drives the transfer below zero, and carries the rest', async () => {
    // The top rung of the ladder is the whole job, while a payout is that job
    // less the platform's share — so a doorstep cancellation costs more than
    // one payout can cover, every time. "Reduce the transfer by what they owe"
    // taken literally would ask Stripe to move a negative amount.
    const { order_id, items } = await seed({ hoursOut: 30, jobs: 3 });
    const [cancelled, first, second] = items as [string, string, string];

    await markArrived(env, OP, cancelled);
    const res = await cancelByOperator(env, OP, cancelled);
    expect(res.fee!.cents).toBe($(200));           // drove there and walked

    await pay(order_id);
    await finished(first, WATCH_TAIL_SECONDS + 60);
    calls = [];

    // The whole payout goes to the debt, so there is no transfer to make —
    // and the line is still marked as paid out, or the next sweep would take
    // the same debt out of the same money all over again.
    expect(await settleDueWork(env)).toMatchObject({ transferred: 0 });
    expect(transfers()).toHaveLength(0);
    expect((await itemRow(first))!.transfer_id).toMatch(/^fees:/);

    const part = (await fee())!;
    expect(part.status).toBe('owed');
    expect(part.settled_cents).toBe($(170));
    // What they are told they owe is what is LEFT, not what was raised.
    expect((await feesOwed(env, OP)).cents).toBe($(30));

    // And the remainder comes off the payout after that.
    await finished(second, WATCH_TAIL_SECONDS + 60);
    await settleDueWork(env);
    expect(transfers()).toHaveLength(1);
    expect(transfers()[0]!.body.amount).toBe(String($(140)));   // $170 less $30
    expect((await fee())!.status).toBe('paid');
    expect((await feesOwed(env, OP)).cents).toBe(0);
  });

  it('leaves a waived fee alone', async () => {
    // An operator cancelling more than 48 hours out owes nothing, so there is
    // nothing to net and the payout is the ordinary one.
    const { order_id, items } = await seed({ hoursOut: 72, jobs: 2 });
    const [cancelled, live] = items as [string, string];

    expect((await cancelByOperator(env, OP, cancelled)).fee).toBeNull();
    await pay(order_id);
    await finished(live, WATCH_TAIL_SECONDS + 60);
    calls = [];

    await settleDueWork(env);
    expect(transfers()[0]!.body.amount).toBe(String($(170)));
  });
});

describe('an operator cancellation nobody answered', () => {
  it('sends the customer their money back rather than keeping it', async () => {
    // THE POLICY CHANGED. Silence used to resolve to 'withheld' on both sides,
    // which was written when no money could move and therefore cost nobody
    // anything. With a real charge behind it, it meant this platform keeping a
    // stranger's payment for a job that never happened because they did not
    // read an email.
    const { order_id, item, token } = await seed({ hoursOut: 30 });
    await pay(order_id);
    await cancelByOperator(env, OP, item);
    calls = [];

    // The customer is asked whether the work happened anyway, and says nothing.
    await releaseHold(item);
    expect((await itemRow(item))!.settlement).toBe('released');

    expect(await sweepRefunds(env)).toMatchObject({ refunded: 1, failed: 0 });
    expect(refunds()).toHaveLength(1);
    expect(refunds()[0]!.body.payment_intent).toBe(lastIntent);
    expect(refunds()[0]!.body.amount).toBe(String($(200)));
    expect((await itemRow(item))!.refund_id).toMatch(/^re_test_/);

    // The operator's half of the old rule stands: an unanswered question is
    // not evidence against them either, so nothing is charged.
    const owed = await one<{ status: string }>(
      `SELECT status FROM lead_fees WHERE order_item_id = ?`, item);
    expect(owed!.status).toBe('waived');
    expect(transfers()).toHaveLength(0);

    // And the silence is still on the record.
    const flagged = await one<{ kind: string }>(
      `SELECT kind FROM bypass_flags WHERE order_item_id = ?`, item);
    expect(flagged!.kind).toBe('silence');
  });
});

describe('a cancelled booking that still owes the business', () => {
  it('pays them in full once the customer says the work happened anyway', async () => {
    // THE MONEY WAS SIMPLY STRANDED. answerWork('done') zeroes the refund and
    // settlement.ts says in its own docstring that "the operator is paid as
    // though the job completed" — and then every query that could have paid
    // them filtered on `cancelled_at IS NULL`. The customer kept nothing, the
    // operator got nothing, and the whole $200 stayed in the platform balance
    // with no screen anywhere reporting it.
    const { order_id, item, token } = await seed({ hoursOut: 30 });
    await pay(order_id);
    await cancelByOperator(env, OP, item);
    calls = [];

    const answered = await answerWork(env, token, item, 'done');
    expect(answered).toEqual({ settlement: 'withheld', refund_cents: 0 });

    // Not before the work would have finished, exactly like any other line.
    expect(await settleDueWork(env)).toMatchObject({ transferred: 0 });

    await finished(item, WATCH_TAIL_SECONDS + 60);
    expect(await settleDueWork(env)).toMatchObject({ orders: 1, transferred: 1 });

    // The whole job less the platform's 15%, because nothing is going back.
    expect(transfers()).toHaveLength(1);
    expect(transfers()[0]!.body.amount).toBe(String($(170)));
    expect(transfers()[0]!.body.destination).toBe('acct_valley');
    expect(transfers()[0]!.body.source_transaction).toBe('ch_1');
    expect((await itemRow(item))!.transfer_id).toMatch(/^tr_test_/);

    // And nothing goes back to the customer, on a line where they answered
    // that they got what they paid for.
    expect(await sweepRefunds(env)).toMatchObject({ refunded: 0 });
    expect(refunds()).toHaveLength(0);

    // The fee is waived — the work happened — so none of it is netted off.
    const fee = await one<{ status: string }>(
      `SELECT status FROM lead_fees WHERE order_item_id = ?`, item);
    expect(fee!.status).toBe('waived');
  });

  it('pays them the quarter the customer did not get back', async () => {
    // The other stranded amount, and the commoner one. bypass.ts says it in
    // writing at the cancel path: what is not refunded "belongs to the
    // operator... pays out to them as if the job had happened". Nothing paid
    // it out. A customer cancelling inside twelve hours got their quarter and
    // the operator's three quarters went nowhere.
    const { order_id, item, token } = await seed({ hoursOut: 6 });
    await pay(order_id);
    await bookedEarlier(item);
    calls = [];

    const res = await cancelByCustomer(env, token, item);
    expect(res.refund.cents).toBe($(50));            // a quarter of $200
    await releaseHold(item);
    await finished(item, WATCH_TAIL_SECONDS + 60);

    // THE CUSTOMER IS PAID FIRST. Until their refund has actually left, the
    // business's remainder is not the business's — sending it out ahead would
    // leave a refund that then fails to come out of the platform's own pocket,
    // which is the whole reason payouts wait at all.
    expect(await settleDueWork(env)).toMatchObject({ transferred: 0 });
    expect(transfers()).toHaveLength(0);

    await sweepRefunds(env);
    expect(refunds()).toHaveLength(1);
    expect(refunds()[0]!.body.amount).toBe(String($(50)));

    // And now the remainder: $200 less the $30 fee less the $50 refunded.
    expect(await settleDueWork(env)).toMatchObject({ transferred: 1 });
    expect(transfers()).toHaveLength(1);
    expect(transfers()[0]!.body.amount).toBe(String($(120)));

    // Every cent accounted for: the customer's $50, the operator's $120, the
    // platform's $30 fee.
    expect($(50) + $(120) + (await itemRow(item))!.fee_cents).toBe($(200));
  });

  it('still pays nothing for a line the charge never covered', async () => {
    // The line cancelled before anybody paid. It is cancelled, it is settled,
    // and `price - fee - refund` is the whole $200 — so the arithmetic that
    // pays the two cases above would hand a business $200 of money that was
    // never collected from anybody. startPayment marks it 'none': nothing back,
    // because nothing was taken.
    const { order_id, items } = await seed({ hoursOut: 72, jobs: 2 });
    const [gone, live] = items as [string, string];

    await cancelByOperator(env, OP, gone);
    await pay(order_id);
    await releaseHold(gone);
    await finished(gone, WATCH_TAIL_SECONDS + 60);
    await finished(live, WATCH_TAIL_SECONDS + 60);
    calls = [];

    await settleDueWork(env);
    // One transfer, for the job that happened, and not a penny for the other.
    expect(transfers()).toHaveLength(1);
    expect(transfers()[0]!.body.amount).toBe(String($(170)));
    expect((await itemRow(gone))!.transfer_id).toBeNull();
    expect((await itemRow(gone))!.refund_reason).toBe('none');

    // And it does not sit in the payout queue forever either. Nothing ever
    // clears an untransferred line out of that sweep, so a cancelled line that
    // can never owe anybody anything has to be kept out of it rather than
    // re-read and re-rejected every fifteen minutes for the life of the row.
    expect(await settleDueWork(env)).toMatchObject({ orders: 0 });
  });
});

describe('a booking whose money has already gone out', () => {
  /** Paid, finished, swept: the operator has the money in their bank. */
  async function paidOut(opts: { hoursOut?: number } = {}) {
    const seeded = await seed({ hoursOut: opts.hoursOut ?? 72 });
    await pay(seeded.order_id);
    await finished(seeded.item, WATCH_TAIL_SECONDS + 60);
    await settleDueWork(env);
    expect((await itemRow(seeded.item))!.transfer_id).toMatch(/^tr_test_/);
    calls = [];
    return seeded;
  }

  it('cannot be cancelled by the business', async () => {
    // THE EXPENSIVE ONE. $200 job ends Monday, $170 is transferred Monday
    // evening, and on Tuesday the operator cancels to tidy their calendar.
    // refundFor sees a start time in the past and returns 100%, the hold lifts
    // in sixty seconds because the slot is long gone, and the customer is
    // refunded the whole $200. The operator keeps the $170. A Transfer cannot
    // be pulled back, so the $170 comes out of the platform — silently, on a
    // path where every screen involved looks entirely ordinary.
    const { item } = await paidOut();

    await expect(cancelByOperator(env, OP, item)).rejects.toThrow(/already been paid out/i);

    // Nothing moved, nothing was frozen, and no refund is sitting waiting.
    const row = (await itemRow(item))!;
    expect(row.settlement).toBe('released');
    expect(row.refund_cents ?? 0).toBe(0);
    expect(await sweepRefunds(env)).toMatchObject({ refunded: 0 });
    expect(refunds()).toHaveLength(0);
  });

  it('cannot be cancelled by the customer either', async () => {
    const { item, token } = await paidOut();
    await expect(cancelByCustomer(env, token, item)).rejects.toThrow(/already been paid out/i);
    expect(refunds()).toHaveLength(0);
  });

  it('is never refunded for more than the platform is still holding', async () => {
    // The backstop under both refusals above. A $200 refund figure written
    // onto a transferred line by any route at all must not become a $200
    // refund: $170 of that is in somebody's bank account and cannot be pulled
    // back, so paying it would be the platform buying the customer out of a
    // booking with its own money. What is still here is the fee it kept, and
    // that is the most that can go.
    const { item } = await paidOut();
    await env.DB.prepare(
      `UPDATE order_items SET refund_cents = ?, settlement = 'released',
         cancelled_at = ? WHERE id = ?`,
    ).bind($(200), now(), item).run();

    const out = await refundItem(env, item);
    expect(out).toMatchObject({ refunded: true });
    expect(refunds()).toHaveLength(1);
    expect(refunds()[0]!.body.amount).toBe(String($(30)));   // the fee, not the job

    // And the sweep leaves it alone entirely, so this is only ever reachable
    // by somebody asking for it by hand.
    await env.DB.prepare(`UPDATE order_items SET refund_id = NULL WHERE id = ?`)
      .bind(item).run();
    expect(await sweepRefunds(env)).toMatchObject({ refunded: 0, failed: 0 });
    expect(refunds()).toHaveLength(1);
  });
});

describe('the webhook that never arrived', () => {
  it('confirms the order anyway, off the cron', async () => {
    // markPaid was reachable from /webhooks/stripe and from nothing else, and
    // startPayment could see with its own eyes that an intent said 'succeeded'
    // and merely reported it to the browser. So one bad delivery window — an
    // outage, a rotated signing secret, the 503 this Worker returns while
    // STRIPE_WEBHOOK_SECRET is unset — left a real charge with paid_at NULL
    // forever: no payout, no refund path, and a customer whose card was
    // debited looking at a booking that says unpaid.
    vi.stubGlobal('fetch', stripeStub({ intentStatus: 'succeeded' }));
    const { order_id, item } = await seed({ hoursOut: 72 });
    await startPayment(env, order_id);

    // Nothing told this Worker. The order is an hour old and still unpaid.
    await env.DB.prepare(`UPDATE orders SET created_at = ? WHERE id = ?`)
      .bind(now() - 2 * HOUR, order_id).run();
    calls = [];

    expect(await reconcileUnpaidOrders(env)).toEqual({ checked: 1, confirmed: 1 });
    expect(calls.map((c) => c.path)).toEqual([`/payment_intents/${lastIntent}`]);

    const order = (await one<{ status: string; paid_at: number; charge_id: string }>(
      `SELECT status, paid_at, charge_id FROM orders WHERE id = ?`, order_id))!;
    expect(order.status).toBe('confirmed');
    expect(order.paid_at).toBeGreaterThan(0);
    // AND THE CHARGE ID IS A CHARGE ID. Stripe hands latest_charge back as an
    // expanded object whenever anything asks it to, and String() on that
    // writes "[object Object]" — which then goes out as source_transaction and
    // is the one field stopping a payout leaving before the charge settles.
    expect(order.charge_id).toBe('ch_reconciled');

    // Which means the money can now actually reach the business.
    await finished(item, WATCH_TAIL_SECONDS + 60);
    await settleDueWork(env);
    expect(transfers()).toHaveLength(1);
    expect(transfers()[0]!.body.source_transaction).toBe('ch_reconciled');
  });

  it('leaves an abandoned card form alone', async () => {
    const { order_id } = await seed({ hoursOut: 72 });
    await startPayment(env, order_id);
    await env.DB.prepare(`UPDATE orders SET created_at = ? WHERE id = ?`)
      .bind(now() - 2 * HOUR, order_id).run();

    expect(await reconcileUnpaidOrders(env)).toEqual({ checked: 1, confirmed: 0 });
    const order = (await one<{ paid_at: number | null; payment_status: string }>(
      `SELECT paid_at, payment_status FROM orders WHERE id = ?`, order_id))!;
    expect(order.paid_at).toBeNull();
    // Said out loud on the row, so a basket stuck for a week looks stuck.
    expect(order.payment_status).toBe('requires_payment_method');
  });

  it('does not go asking about an order somebody is still paying for', async () => {
    // An hour, because a customer at a card form takes minutes and Stripe
    // retries a real webhook for days. This is the backstop, not the path.
    const { order_id } = await seed({ hoursOut: 72 });
    await startPayment(env, order_id);
    calls = [];
    expect(await reconcileUnpaidOrders(env)).toEqual({ checked: 0, confirmed: 0 });
    expect(calls).toHaveLength(0);
  });
});

describe('a basket that shrank while the card form was open', () => {
  it('lowers the intent rather than charging for the job that went away', async () => {
    // The resume path returned the held intent and skipped everything the
    // new-intent path does — the amount recomputed from the lines that are
    // still happening, the fee split rewritten, the refund on a line this
    // charge no longer covers taken back to nothing. So the customer who
    // opened the payment page for two jobs, had one cancelled, and came back
    // to the page they already had was charged $400 for one $200 job.
    const { order_id, items } = await seed({ hoursOut: 72, jobs: 2 });
    const [gone, live] = items as [string, string];

    await startPayment(env, order_id);
    expect(intents()[0]!.body.amount).toBe(String($(400)));

    await cancelByOperator(env, OP, gone);
    calls = [];

    const again = await startPayment(env, order_id);
    expect(again.amount_cents).toBe($(200));
    // Moved, not replaced: the browser is holding a secret for THIS intent,
    // and a second one would be two live claims on one order.
    expect(intents()).toHaveLength(0);
    const moved = calls.filter((c) =>
      c.path === `/payment_intents/${lastIntent}` && c.method === 'POST');
    expect(moved).toHaveLength(1);
    expect(moved[0]!.body.amount).toBe(String($(200)));

    // And everything the row has to say about it comes down with the charge.
    expect((await one<{ total_cents: number; fee_cents: number }>(
      `SELECT total_cents, fee_cents FROM orders WHERE id = ?`, order_id)))
      .toEqual({ total_cents: $(200), fee_cents: $(30) });
    expect((await itemRow(live))!.fee_cents).toBe($(30));
    expect((await itemRow(gone))!.fee_cents).toBe(0);
    expect((await itemRow(gone))!.refund_cents).toBe(0);
  });
});

describe('two sweeps reaching for the same lead fee', () => {
  it('never lets one payout be shortened by a debt another one collected', async () => {
    // creditFeeStatement guards on the settled_cents it read, which is what
    // makes two sweeps safe — but it used to sit in the SAME batch as the
    // payout rows, and a D1 batch does not roll back because one statement
    // matched nothing. So both passes netted the same $50 off two different
    // payouts, only one credit landed, and the operator received $120 and $120
    // instead of $120 and $170 while feesOwed said nothing was owed.
    const { order_id, items } = await seed({ hoursOut: 30, jobs: 3 });
    const [cancelled, first, second] = items as [string, string, string];

    expect((await cancelByOperator(env, OP, cancelled)).fee!.cents).toBe($(50));
    await pay(order_id);
    await finished(first, WATCH_TAIL_SECONDS + 60);
    await finished(second, WATCH_TAIL_SECONDS + 60);
    calls = [];

    // Both lines are due at once and both sweeps see both of them, so the two
    // passes race on the one debt.
    await Promise.all([settleDueWork(env), settleDueWork(env)]);
    // Whatever is left over goes on the next tick.
    await settleDueWork(env);

    // $170 + $170 of payout, less the $50 owed, ONCE.
    const paidOut = made.transfers.reduce((sum, tr) => sum + tr.amount, 0);
    expect(paidOut).toBe($(170) + $(170) - $(50));

    const fee = (await one<{ status: string; settled_cents: number }>(
      `SELECT status, settled_cents FROM lead_fees WHERE operator_id = ?`, OP))!;
    expect(fee.settled_cents).toBe($(50));
    expect(fee.status).toBe('paid');
    expect((await feesOwed(env, OP)).cents).toBe(0);

    // And both lines really were paid out, rather than one being abandoned.
    expect((await itemRow(first))!.transfer_id).not.toBeNull();
    expect((await itemRow(second))!.transfer_id).not.toBeNull();
  });
});

describe('settleOrder, called directly', () => {
  it('still skips a business with no connected account', async () => {
    const { order_id, item } = await seed({ hoursOut: 72, account: null });
    await pay(order_id);
    calls = [];

    const res = await settleOrder(env, order_id);
    expect(res.transferred).toBe(0);
    expect(res.skipped).toEqual([{ operator_id: OP, reason: 'no_connected_account' }]);
    expect((await itemRow(item))!.transfer_id).toBeNull();
  });

  it('pays nothing ahead of the work when the caller asks for due lines only', async () => {
    const { order_id } = await seed({ hoursOut: 72 });
    await pay(order_id);
    calls = [];

    expect(await settleOrder(env, order_id, { onlyDue: true }))
      .toEqual({ transferred: 0, skipped: [] });
    expect(transfers()).toHaveLength(0);
  });
});
