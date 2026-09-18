import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import type { Env } from '../src/types';
import { newId, now } from '../src/lib/util';
import { markPaid, markPaymentFailed, settleOrder, startPayment } from '../src/lib/checkout';

/**
 * THE MONEY PATH.
 *
 * A customer pays once, on our own site. Each business is then paid what it
 * earned minus the fee. What this file is for is the three things that would
 * be expensive to get wrong and cheap to get wrong quietly:
 *
 *   nobody is charged twice for one basket;
 *   nobody is PAID twice out of money collected once;
 *   the fee taken matches lib/fees.ts to the cent, including its per-business
 *   per-day ceiling.
 *
 * Stripe is stood in for. Every call this code makes goes through fetch, so
 * fetch is what is replaced — which means the request bodies, the idempotency
 * keys and the amounts are all real and asserted rather than described.
 */

let env: Env;
/** Every request the code made to Stripe, in order. */
let calls: Array<{ path: string; body: Record<string, string>; idempotency: string | null }>;
/**
 * Never reset between orders, and that is the point. Stripe object ids are
 * unique forever, and the unique indexes in migration 0040 exist precisely to
 * refuse a repeat — a counter that restarted would have this stub violating
 * them and look like a bug in the code under test.
 */
let issued = 0;
/** The last intent the stub handed out, so a re-read returns the same one. */
let lastIntent = '';

const $ = (dollars: number) => Math.round(dollars * 100);

/**
 * Stripe, as far as this Worker can tell.
 *
 * `payouts` is what the connected account says when the payout sweep asks it —
 * and it ASKS, every time, rather than reading the cached flag on the operator
 * row. Migration 0040 says so beside that column: anything that moves money
 * re-reads Stripe, because a stale 1 there is a transfer that fails after the
 * customer has already been charged.
 */
function stripeStub(opts: { payouts?: boolean } = {}) {
  return vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    const path = url.replace('https://api.stripe.com/v1', '');
    const body: Record<string, string> = {};
    if (init.body) {
      for (const pair of String(init.body).split('&')) {
        const [k, v] = pair.split('=');
        body[decodeURIComponent(k!)] = decodeURIComponent(v ?? '');
      }
    }
    calls.push({
      path,
      body,
      idempotency: init.headers?.['idempotency-key'] ?? null,
    });

    if (path === '/payment_intents') {
      issued += 1;
      lastIntent = `pi_test_${issued}`;
      return new Response(JSON.stringify({
        id: lastIntent,
        client_secret: `${lastIntent}_secret_abc`,
        status: 'requires_payment_method',
        amount: Number(body.amount ?? 0),
        currency: body.currency ?? 'usd',
      }), { status: 200 });
    }
    if (path.startsWith('/payment_intents/')) {
      const id = path.split('/').pop()!;
      return new Response(JSON.stringify({
        id,
        client_secret: `${id}_secret_abc`,
        status: 'requires_payment_method',
        amount: 0,
        currency: 'usd',
      }), { status: 200 });
    }
    if (path === '/transfers') {
      issued += 1;
      return new Response(JSON.stringify({
        id: `tr_test_${issued}`,
        amount: Number(body.amount ?? 0),
        destination: body.destination ?? '',
      }), { status: 200 });
    }
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

async function operator(id: string, opts: { account?: string | null; tz?: string } = {}) {
  const n = now();
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,timezone,country,currency,language,
       location_mode,fill_model,sms_mode,max_detour_seconds,min_gap_seconds,buffer_seconds,
       offer_ttl_seconds,offers_per_wave,min_notice_seconds,reoffer_cooldown_seconds,
       discount_percent,plan,accept_public_bookings,deposit_cents,
       stripe_account_id,stripe_charges_enabled,stripe_payouts_enabled,
       created_at,updated_at)
     VALUES (?,?,?,?,'US','USD','en','mobile','both','device',
       900,3600,900,5400,3,3600,604800,0,'active',1,0,?,1,1,?,?)`,
  ).bind(id, `${id}@x.com`, id, opts.tz ?? 'UTC',
    opts.account === undefined ? `acct_${id}` : opts.account, n, n).run();
}

/** An order with the given lines. `day` is a whole-day offset from now. */
async function order(lines: Array<{ op: string; dollars: number; day?: number }>) {
  const n = now();
  const orderId = newId();
  const total = lines.reduce((s, l) => s + $(l.dollars), 0);
  await env.DB.prepare(
    `INSERT INTO orders (id,status,currency,total_cents,email,created_at,updated_at)
     VALUES (?,'pending','USD',?,?,?,?)`,
  ).bind(orderId, total, 'rosa@example.com', n, n).run();

  for (const l of lines) {
    // Anchored to midnight UTC so a "day" offset is a real different day and
    // the test does not drift depending on what time it is run.
    const midnight = Math.floor(n / 86400) * 86400;
    const start = midnight + (l.day ?? 0) * 86400 + 10 * 3600;
    await env.DB.prepare(
      `INSERT INTO order_items (id,order_id,operator_id,starts_at,ends_at,
         duration_seconds,price_cents,created_at)
       VALUES (?,?,?,?,?,3600,?,?)`,
    ).bind(newId(), orderId, l.op, start, start + 3600, $(l.dollars), n).run();
  }
  return orderId;
}

const paidFee = async (orderId: string) => (await env.DB.prepare(
  `SELECT fee_cents FROM orders WHERE id = ?`,
).bind(orderId).first<{ fee_cents: number }>())!.fee_cents;

beforeEach(async () => {
  calls = [];
  issued = 0;
  lastIntent = '';
  env = {
    ...makeEnv(ALL_MIGRATIONS),
    STRIPE_SECRET_KEY: 'sk_test_stub',
    APP_URL: 'https://roundtheway.app',
  } as unknown as Env;
  vi.stubGlobal('fetch', stripeStub());
});
afterEach(() => vi.unstubAllGlobals());

describe('opening the charge', () => {
  it('charges the basket total, on our own site', async () => {
    await operator('a');
    const id = await order([{ op: 'a', dollars: 200 }]);

    const handle = await startPayment(env, id);
    expect(handle.client_secret).toBe(`${lastIntent}_secret_abc`);
    expect(handle.paid).toBe(false);

    const [call] = calls;
    expect(call!.path).toBe('/payment_intents');
    expect(call!.body.amount).toBe(String($(200)));
    // The two that keep the customer here. A Checkout Session would be a
    // different endpoint entirely; allow_redirects=never refuses any payment
    // method that could only be finished on somebody else's page.
    expect(call!.body['automatic_payment_methods[enabled]']).toBe('true');
    expect(call!.body['automatic_payment_methods[allow_redirects]']).toBe('never');
    expect(calls.some((c) => c.path.includes('checkout'))).toBe(false);
  });

  it('writes the fee down at the moment the charge is opened', async () => {
    await operator('a');
    const id = await order([{ op: 'a', dollars: 200 }]);
    await startPayment(env, id);
    expect(await paidFee(id)).toBe($(30));      // 15% of $200
  });

  it('applies the ceiling per business per day', async () => {
    await operator('a');
    // Two $600 jobs on ONE day is $1,200 of work — the $150 ceiling.
    const sameDay = await order([
      { op: 'a', dollars: 600, day: 3 }, { op: 'a', dollars: 600, day: 3 },
    ]);
    await startPayment(env, sameDay);
    expect(await paidFee(sameDay)).toBe($(150));

    calls = [];
    // The same two jobs on DIFFERENT days are two days' work: $90 each.
    const twoDays = await order([
      { op: 'a', dollars: 600, day: 3 }, { op: 'a', dollars: 600, day: 4 },
    ]);
    await startPayment(env, twoDays);
    expect(await paidFee(twoDays)).toBe($(180));
  });

  it('writes each day fee onto that day own lines and no others', async () => {
    // THE ORDER TOTAL BEING RIGHT IS WHY NOTHING CAUGHT THIS. The ceiling is
    // per business per day, so $600 and $600 on Monday are capped at $150
    // between them while $600 on Wednesday is $90 on its own — $75, $75 and
    // $90. The split added those to $240 and divided by price, which writes
    // $80 to all three rows: right in total, wrong on every line. Those rows
    // are what a business is shown, what the price step quotes somebody before
    // they book, and what a cancelled line's payout is worked out from.
    await operator('a');
    const id = await order([
      { op: 'a', dollars: 600, day: 1 }, { op: 'a', dollars: 600, day: 1 },
      { op: 'a', dollars: 600, day: 3 },
    ]);
    await startPayment(env, id);

    const rows = await env.DB.prepare(
      `SELECT fee_cents FROM order_items WHERE order_id = ? ORDER BY starts_at, rowid`,
    ).bind(id).all<{ fee_cents: number }>();
    expect((rows.results ?? []).map((r) => r.fee_cents))
      .toEqual([$(75), $(75), $(90)]);
    // And they still add up to exactly what was charged.
    expect(await paidFee(id)).toBe($(240));
  });

  it('gives each business its own ceiling', async () => {
    await operator('a');
    await operator('b');
    const id = await order([
      { op: 'a', dollars: 800, day: 1 }, { op: 'b', dollars: 800, day: 1 },
    ]);
    await startPayment(env, id);
    expect(await paidFee(id)).toBe($(240));      // 15% each, neither capped
  });

  it('spreads the fee across the lines so the parts equal the whole', async () => {
    await operator('a');
    const id = await order([
      { op: 'a', dollars: 333.33, day: 2 }, { op: 'a', dollars: 333.33, day: 2 },
      { op: 'a', dollars: 333.34, day: 2 },
    ]);
    await startPayment(env, id);
    const rows = await env.DB.prepare(
      `SELECT fee_cents FROM order_items WHERE order_id = ?`,
    ).bind(id).all<{ fee_cents: number }>();
    const sum = (rows.results ?? []).reduce((s, r) => s + r.fee_cents, 0);
    expect(sum).toBe(await paidFee(id));
  });

  it('never opens a second charge for the same basket', async () => {
    await operator('a');
    const id = await order([{ op: 'a', dollars: 100 }]);
    await startPayment(env, id);
    await startPayment(env, id);
    // The second call READ the held intent rather than creating another.
    expect(calls.filter((c) => c.path === '/payment_intents').length).toBe(1);
    expect(calls.some((c) => c.path === `/payment_intents/${lastIntent}`)).toBe(true);
  });

  it('sends an idempotency key keyed on the order, in a bucket that moves', async () => {
    await operator('a');
    const id = await order([{ op: 'a', dollars: 100 }]);
    await startPayment(env, id);
    // The order is in the key, so a double-submitted form cannot open two
    // charges. The bucket is in it too, because Stripe caches a key's response
    // for 24 hours INCLUDING ITS FAILURES: keyed on the order alone, one
    // transient refusal locked that basket out of being paid for until the
    // next day, with the customer pressing Pay against a request that never
    // left this Worker. A bucket is safe here and nowhere near the parts
    // charge, because this intent takes no money by existing — the customer's
    // own confirmation does that, against the one intent stored on the order.
    expect(calls[0]!.idempotency).toMatch(new RegExp(`^pi:${id}:\\d+$`));
  });

  it('refuses to pay a business Stripe has stopped paying', async () => {
    // The cached flag on the operator row says yes and Stripe says no — an
    // expired document, a bank that rejected a payout, a restriction applied
    // after the booking. Checking only that an account id exists meant the
    // transfer failed at Stripe every fifteen minutes forever with nothing
    // anywhere saying why.
    vi.stubGlobal('fetch', stripeStub({ payouts: false }));
    await operator('a');
    const id = await order([{ op: 'a', dollars: 200 }]);
    await startPayment(env, id);
    await markPaid(env, lastIntent, 'ch_1');
    calls = [];

    const res = await settleOrder(env, id);
    expect(res.transferred).toBe(0);
    expect(res.skipped).toEqual([{ operator_id: 'a', reason: 'payouts_disabled' }]);
    expect(calls.filter((c) => c.path === '/transfers')).toHaveLength(0);

    // And it is written back onto the operator, which is how anybody finds
    // out: the listing gate and their own settings page read that flag.
    const row = await env.DB.prepare(
      `SELECT stripe_payouts_enabled FROM operators WHERE id = 'a'`,
    ).first<{ stripe_payouts_enabled: number }>();
    expect(row!.stripe_payouts_enabled).toBe(0);
  });
});

describe('the money landing', () => {
  it('confirms the order', async () => {
    await operator('a');
    const id = await order([{ op: 'a', dollars: 100 }]);
    await startPayment(env, id);

    const res = await markPaid(env, lastIntent, 'ch_1');
    expect(res).toEqual({ order_id: id, changed: true });

    const row = await env.DB.prepare(
      `SELECT status, paid_at, charge_id FROM orders WHERE id = ?`,
    ).bind(id).first<any>();
    expect(row.status).toBe('confirmed');
    expect(row.charge_id).toBe('ch_1');
    expect(row.paid_at).toBeGreaterThan(0);
  });

  it('does nothing the second time the same event arrives', async () => {
    await operator('a');
    const id = await order([{ op: 'a', dollars: 100 }]);
    await startPayment(env, id);

    expect((await markPaid(env, lastIntent, 'ch_1')).changed).toBe(true);
    // Stripe redelivers events by design. The second one must be a no-op, not
    // a second confirmation with a later timestamp.
    expect((await markPaid(env, lastIntent, 'ch_1')).changed).toBe(false);
  });

  it('shrugs at an intent belonging to no order', async () => {
    expect(await markPaid(env, 'pi_unknown', null))
      .toEqual({ order_id: null, changed: false });
  });

  it('records a failure without throwing the booking away', async () => {
    await operator('a');
    const id = await order([{ op: 'a', dollars: 100 }]);
    await startPayment(env, id);
    await markPaymentFailed(env, lastIntent, 'requires_payment_method');

    const row = await env.DB.prepare(
      `SELECT status, payment_status, paid_at FROM orders WHERE id = ?`,
    ).bind(id).first<any>();
    // A declined card is somebody trying again in thirty seconds, not somebody
    // who changed their mind. The claim stands.
    expect(row.status).toBe('pending');
    expect(row.paid_at).toBeNull();
    expect(row.payment_status).toBe('requires_payment_method');
  });
});

describe('paying the businesses', () => {
  const transfers = () => calls.filter((c) => c.path === '/transfers');

  it('pays each business the price minus its fee', async () => {
    await operator('a');
    const id = await order([{ op: 'a', dollars: 200 }]);
    await startPayment(env, id);
    await markPaid(env, lastIntent, 'ch_1');
    calls = [];

    const res = await settleOrder(env, id);
    expect(res.transferred).toBe(1);
    expect(transfers()).toHaveLength(1);
    expect(transfers()[0]!.body.amount).toBe(String($(170)));   // $200 less 15%
    expect(transfers()[0]!.body.destination).toBe('acct_a');
    // Tied to the charge that funded it, so Stripe will not move money that
    // has not actually arrived.
    expect(transfers()[0]!.body.source_transaction).toBe('ch_1');
  });

  it('sends ONE transfer per business, not one per job', async () => {
    await operator('a');
    const id = await order([
      { op: 'a', dollars: 100, day: 1 }, { op: 'a', dollars: 100, day: 2 },
    ]);
    await startPayment(env, id);
    await markPaid(env, lastIntent, 'ch_1');
    calls = [];

    await settleOrder(env, id);
    expect(transfers()).toHaveLength(1);
    expect(transfers()[0]!.body.amount).toBe(String($(170)));   // $200 less $30
  });

  it('never pays twice out of money collected once', async () => {
    await operator('a');
    const id = await order([{ op: 'a', dollars: 200 }]);
    await startPayment(env, id);
    await markPaid(env, lastIntent, 'ch_1');
    calls = [];

    await settleOrder(env, id);
    await settleOrder(env, id);
    // The second pass found every line already carrying a transfer id.
    expect(transfers()).toHaveLength(1);
  });

  it('holds the share of a business that has not finished onboarding', async () => {
    await operator('a');
    await operator('b', { account: null });
    const id = await order([
      { op: 'a', dollars: 100, day: 1 }, { op: 'b', dollars: 100, day: 1 },
    ]);
    await startPayment(env, id);
    await markPaid(env, lastIntent, 'ch_1');
    calls = [];

    const res = await settleOrder(env, id);
    // One paid, one waiting — and the customer's booking is untouched either
    // way. This is retryable the moment they finish.
    expect(res.transferred).toBe(1);
    expect(res.skipped).toEqual([{ operator_id: 'b', reason: 'no_connected_account' }]);

    const held = await env.DB.prepare(
      `SELECT transfer_id FROM order_items WHERE operator_id = 'b'`,
    ).first<{ transfer_id: string | null }>();
    expect(held!.transfer_id).toBeNull();
  });

  it('pays the held share once that business finishes', async () => {
    await operator('a');
    await operator('b', { account: null });
    const id = await order([
      { op: 'a', dollars: 100, day: 1 }, { op: 'b', dollars: 100, day: 1 },
    ]);
    await startPayment(env, id);
    await markPaid(env, lastIntent, 'ch_1');
    await settleOrder(env, id);
    calls = [];

    await env.DB.prepare(
      `UPDATE operators SET stripe_account_id = 'acct_b' WHERE id = 'b'`,
    ).run();
    const res = await settleOrder(env, id);
    expect(res.transferred).toBe(1);
    expect(transfers()[0]!.body.destination).toBe('acct_b');
  });

  it('refuses to pay anybody out of an order nobody paid for', async () => {
    await operator('a');
    const id = await order([{ op: 'a', dollars: 100 }]);
    await expect(settleOrder(env, id)).rejects.toThrow();
    expect(transfers()).toHaveLength(0);
  });

  it('leaves the platform exactly the fee', async () => {
    await operator('a');
    await operator('b');
    const id = await order([
      { op: 'a', dollars: 600, day: 1 }, { op: 'a', dollars: 600, day: 1 },
      { op: 'b', dollars: 65, day: 1 },
    ]);
    await startPayment(env, id);
    await markPaid(env, lastIntent, 'ch_1');
    calls = [];
    await settleOrder(env, id);

    const collected = $(1265);
    const paidOut = transfers().reduce((s, c) => s + Number(c.body.amount), 0);
    // a: $1,200 on one day → capped at $150. b: $65 → $9.75.
    expect(collected - paidOut).toBe($(159.75));
    expect(await paidFee(id)).toBe($(159.75));
  });
});
