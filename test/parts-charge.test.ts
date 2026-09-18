import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import type { Env } from '../src/types';
import { newId, now } from '../src/lib/util';
import {
  markPaid, settleDueWork, startPayment, sweepPartsRefunds, sweepRefunds,
} from '../src/lib/checkout';
import { placeOrder } from '../src/lib/orders';
import { decideQuote, expireQuotes, reconcileSentQuotes, sendQuote } from '../src/lib/parts';
import { cancelByOperator } from '../src/lib/bypass';
import { answerWork, settleExpiredHolds, WATCH_TAIL_SECONDS } from '../src/lib/settlement';

/**
 * THE SECOND CHARGE, AND WHERE IT ENDS UP.
 *
 * The first charge is the labour, at checkout. This file is about the other
 * one: the customer taps approve on a $180 quote for brake pads while the
 * mechanic is standing next to the car, and until now that tap added $180 to a
 * column and moved nothing. `charged_at` was declared in migration 0020 as "the
 * payment seam for the second charge", nothing in the product ever wrote it,
 * and the operator was left collecting the difference at the door in cash —
 * which is the exact conversation parts quotes exist to prevent.
 *
 * What is pinned here is the pair of things that would be expensive to get
 * wrong and cheap to get wrong quietly:
 *
 *   the customer is charged the number they tapped, once, however many times
 *   they tap it, and never a cent more;
 *
 *   that money reaches the business, held until the work is behind it exactly
 *   as the labour is, rather than sitting in the platform balance.
 *
 * Stripe is stood in for the same way it is in money-path.test.ts: the calls go
 * out through fetch, so fetch is what is replaced, and every assertion is on the
 * REQUEST BODY Stripe actually received — the amount, the card, the
 * idempotency key — rather than on this code's own opinion of what it sent.
 */

let env: Env;
/** Every request the code made to Stripe, in order. */
let calls: Array<{ path: string; body: Record<string, string>; idempotency: string | null }>;
/** Never reset, because Stripe object ids are unique forever. */
let issued = 0;
let lastIntent = '';

const $ = (dollars: number) => Math.round(dollars * 100);
const HOUR = 3600;

const intents = () => calls.filter((c) => c.path === '/payment_intents');
/** The second charge: the one confirmed in the request, against a saved card. */
const partsCharges = () => intents().filter((c) => c.body.confirm === 'true');
const transfers = () => calls.filter((c) => c.path === '/transfers');
const partsTransfers = () =>
  transfers().filter((c) => c.body['metadata[parts_quote_id]']);

const OP = 'op-parts';
const ACCOUNT = 'acct-rosa';
const PREV = { lat: 34.1500, lng: -118.4490 };
const NEXT = { lat: 34.1520, lng: -118.4400 };
const NEAR = { lat: 34.1510, lng: -118.4450 };

/**
 * Stripe, as far as this Worker can tell.
 *
 * `cardDeclines` is how many times the SECOND charge is refused before it goes
 * through — a 402 with a body Stripe really sends, which is the case that
 * matters: it read the request and created nothing.
 */
/**
 * Charges Stripe is holding that this database knows nothing about — the
 * wreckage of an approval whose write-back failed after the money moved.
 * Pushed here by the test that recovers one.
 */
let orphanedCharges: Array<{
  id: string; status: string; amount: number; currency: string;
  latest_charge: unknown; metadata: { parts_quote_id: string };
}> = [];

/**
 * What Stripe has already made under each idempotency key, and what it made at
 * all.
 *
 * A stub that mints a fresh id for every request cannot tell "one payout
 * happened" from "the database guard caught the second write", so a test named
 * for idempotency would pass with every key deleted. Replaying a key it has
 * seen is what makes the two distinguishable.
 */
let byKey: Map<string, { status: number; body: any }>;
let madeTransfers: any[];

function stripeStub(opts: { cardDeclines?: number; keyInFlight?: number } = {}) {
  let declines = opts.cardDeclines ?? 0;
  let inFlight = opts.keyInFlight ?? 0;
  return vi.fn(async (input: any, init: any = {}) => {
    const path = String(input).replace('https://api.stripe.com/v1', '');
    const body: Record<string, string> = {};
    if (init.body) {
      for (const pair of String(init.body).split('&')) {
        const [k, v] = pair.split('=');
        body[decodeURIComponent(k!)] = decodeURIComponent(v ?? '');
      }
    }
    const key: string | null = init.headers?.['idempotency-key'] ?? null;
    calls.push({ path, body, idempotency: key });

    // Seen this key before: hand back exactly what it produced, which is what
    // Stripe does and what every key in this Worker is relying on.
    if (key && byKey.has(key)) {
      const held = byKey.get(key)!;
      return new Response(JSON.stringify(held.body), { status: held.status });
    }

    if (path === '/payment_intents') {
      // Confirmed in the request means a card already on file and nobody at a
      // form: the money either moves now or it does not.
      if (body.confirm === 'true') {
        if (inFlight > 0) {
          inFlight -= 1;
          // The answer to a second request arriving while the first is still
          // being processed. Stripe is saying a charge for this key is very
          // probably being created RIGHT NOW — the opposite of a decline.
          return new Response(JSON.stringify({
            error: {
              message: 'There is currently another in-progress request using this '
                + 'Idempotent Key.',
              code: 'idempotency_key_in_use',
              type: 'idempotency_error',
            },
          }), { status: 409 });
        }
        if (declines > 0) {
          declines -= 1;
          return new Response(JSON.stringify({
            error: { message: 'Your card was declined.', code: 'card_declined' },
          }), { status: 402 });
        }
        issued += 1;
        return new Response(JSON.stringify({
          id: `pi_parts_${issued}`,
          client_secret: `pi_parts_${issued}_secret`,
          status: 'succeeded',
          amount: Number(body.amount ?? 0),
          currency: body.currency ?? 'usd',
          latest_charge: `ch_parts_${issued}`,
        }), { status: 200 });
      }
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
    if (path === '/transfers') {
      issued += 1;
      const transfer = {
        id: `tr_test_${issued}`,
        amount: Number(body.amount ?? 0),
        destination: body.destination ?? '',
        metadata: { parts_quote_id: body['metadata[parts_quote_id]'] ?? '' },
      };
      madeTransfers.push(transfer);
      if (key) byKey.set(key, { status: 200, body: transfer });
      return new Response(JSON.stringify(transfer), { status: 200 });
    }
    if (path === '/refunds') {
      issued += 1;
      return new Response(JSON.stringify({
        id: `re_test_${issued}`,
        amount: Number(body.amount ?? 0),
        status: 'succeeded',
      }), { status: 200 });
    }
    // The payout sweep asks the connected account whether it can still be paid
    // rather than trusting the cached flag, which is what migration 0040 says
    // beside that column.
    if (path.startsWith('/accounts/')) {
      return new Response(JSON.stringify({
        id: decodeURIComponent(path.split('/').pop()!),
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
      }), { status: 200 });
    }
    // Every intent Stripe holds against one quote id, which is the only way
    // back from a charge that succeeded and was never written down.
    if (path.startsWith('/payment_intents/search')) {
      const wanted = decodeURIComponent(path.split('query=')[1]!.split('&')[0]!);
      const found = orphanedCharges.filter((i) => wanted.includes(i.metadata.parts_quote_id));
      return new Response(JSON.stringify({ data: found }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: `unstubbed ${path}` } }),
      { status: 400 });
  });
}

const one = async <T>(sql: string, ...args: unknown[]) =>
  env.DB.prepare(sql).bind(...args).first<T>();

const quoteRow = (id: string) => one<{
  status: string; charged_at: number | null; payment_intent_id: string | null;
  charge_id: string | null; charge_attempts: number; charge_error: string | null;
  transfer_id: string | null; transferred_at: number | null;
  refund_id: string | null; refunded_at: number | null;
}>(
  `SELECT status, charged_at, payment_intent_id, charge_id, charge_attempts,
          charge_error, transfer_id, transferred_at, refund_id, refunded_at
     FROM parts_quotes WHERE id = ?`, id);

/**
 * One mechanic, one booked diagnosis, and a customer with a card on file.
 *
 * The card matters more than it looks: orders.payment_ref is what the second
 * charge is made against, copied onto the order at checkout so that a charge
 * months later cannot quietly follow whichever card the account holds today.
 * `card: null` is how this file gets a booking that cannot be charged for
 * parts, which is a case with its own test rather than an oversight.
 */
async function seed(opts: { card?: boolean } = {}) {
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
       stripe_account_id,stripe_charges_enabled,stripe_payouts_enabled,created_at,updated_at)
     VALUES (?,?,?, 'mobile mechanic','America/Los_Angeles','US','USD','en','mobile','both',
       'device',3600,3600,900,5400,3,3600,604800,0,'active',1,0,1,'acct_mech',1,1,?,?)`,
  ).bind(OP, 'm@x.com', 'Rosa Mobile Auto', n, n).run();

  await env.DB.prepare(
    `INSERT INTO services (id,operator_id,name,duration_seconds,price_cents,
       parts_policy,created_at,updated_at)
     VALUES ('s-diag',?, 'Check-engine diagnosis',3600,?, 'quoted',?,?)`,
  ).bind(OP, $(120), n, n).run();

  await env.DB.prepare(
    `INSERT INTO postal_codes (country_code,postal_code,place_name,lat,lng,accuracy)
     VALUES ('US','91403','Sherman Oaks',?,?,6)`,
  ).bind(NEAR.lat, NEAR.lng).run();

  // The customer, as Stripe knows them. A saved card can only be charged
  // alongside the customer object it is filed under — see migration 0041.
  await env.DB.prepare(
    `INSERT INTO customer_accounts (id, phone_e164, login_email, email, first_name,
       stripe_customer_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).bind(ACCOUNT, '+18185550142', 'rosa@mailbox.test', 'rosa@mailbox.test', 'Rosa',
    'cus_rosa', n, n).run();

  const gapId = newId();
  const starts = n + 30 * HOUR;
  await env.DB.prepare(
    `INSERT INTO gaps (id,operator_id,starts_at,ends_at,prev_lat,prev_lng,next_lat,next_lng,
       baseline_drive_seconds,is_mobile,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,180,1,'open',?,?)`,
  ).bind(gapId, OP, starts, starts + 5 * HOUR,
    PREV.lat, PREV.lng, NEXT.lat, NEXT.lng, n, n).run();

  const order = await placeOrder(env, {
    guest_name: 'Rosa',
    phone: '(818) 555-0142',
    address_line: '15200 Ventura Blvd',
    postcode: '91403',
    account: { id: ACCOUNT, phone: '+18185550142', login_email: 'rosa@mailbox.test' },
    card: opts.card === false
      ? null
      : { ref: 'pm_rosa', brand: 'visa', last4: '4242' },
    items: [{ gap_id: gapId, service_ids: ['s-diag'] }],
  });

  return {
    order_id: order.order_id,
    item: order.items[0]!.order_item_id,
    token: order.thread_token,
  };
}

/** The labour clears, so everything after this is money the platform holds. */
async function pay(orderId: string) {
  await startPayment(env, orderId);
  await markPaid(env, lastIntent, 'ch_labour');
}

/** Move the booking into the past, as the fifteen-minute cron would find it. */
const finished = (id: string, endedSecondsAgo: number) => env.DB.prepare(
  `UPDATE order_items SET starts_at = ?, ends_at = ? WHERE id = ?`,
).bind(now() - endedSecondsAgo - HOUR, now() - endedSecondsAgo, id).run();

const refunds = () => calls.filter((c) => c.path === '/refunds');
const partsRefunds = () =>
  refunds().filter((c) => c.body['metadata[parts_quote_id]']);

/** Let a frozen cancellation's hold run out, exactly as the cron does. */
async function releaseHold(id: string) {
  await env.DB.prepare(`UPDATE order_items SET hold_until = ? WHERE id = ?`)
    .bind(now() - 1, id).run();
  await settleExpiredHolds(env);
}

const quoteFor = (itemId: string, parts: number, labor = 0) => sendQuote(env, OP, {
  order_item_id: itemId,
  description: 'Front pads and rotors, ceramic',
  parts_cents: parts,
  labor_cents: labor,
});

beforeEach(() => {
  calls = [];
  lastIntent = '';
  orphanedCharges = [];
  byKey = new Map();
  madeTransfers = [];
  vi.stubGlobal('fetch', stripeStub());
});
afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------

describe('approving a part takes the money', () => {
  it('charges the saved card for exactly the figure that was approved', async () => {
    const { order_id, item, token } = await seed();
    await pay(order_id);
    const quote = await quoteFor(item, $(180), $(30));
    calls = [];

    await decideQuote(env, token, quote.id, 'approved');

    expect(partsCharges()).toHaveLength(1);
    const charge = partsCharges()[0]!;
    // The number on the row they tapped, parts and extra labour together, and
    // nothing else folded in — not the booking, not a running total.
    expect(charge.body.amount).toBe(String($(210)));
    expect(charge.body.currency).toBe('usd');
    // A card already on file, charged with nobody at a form. All three are
    // required together: the customer object it is filed under, the card
    // itself, and the confirmation that takes the money in this one request.
    expect(charge.body.customer).toBe('cus_rosa');
    expect(charge.body.payment_method).toBe('pm_rosa');
    expect(charge.body.confirm).toBe('true');
    expect(charge.body.off_session).toBe('true');
    // So a $210 debit in the dashboard says which part it was for.
    expect(charge.body['metadata[parts_quote_id]']).toBe(quote.id);
    // Keyed on the QUOTE. An order-keyed charge would hand the second quote on
    // a booking a copy of the first one's intent and charge for it once.
    expect(charge.idempotency).toBe(`pq:${quote.id}:0`);

    const row = (await quoteRow(quote.id))!;
    expect(row.status).toBe('approved');
    expect(row.charged_at).toBeGreaterThan(0);
    expect(row.payment_intent_id).toMatch(/^pi_parts_/);
    expect(row.charge_id).toMatch(/^ch_parts_/);
    expect(row.charge_error).toBeNull();
  });

  it('charges once however many times they tap approve', async () => {
    const { order_id, item, token } = await seed();
    await pay(order_id);
    const quote = await quoteFor(item, $(180));
    calls = [];

    await decideQuote(env, token, quote.id, 'approved');
    // The double tap: a phone, on a driveway, on one bar of signal.
    await expect(decideQuote(env, token, quote.id, 'approved'))
      .rejects.toThrow(/already/i);

    expect(partsCharges()).toHaveLength(1);
    const totals = await one<{ parts_cents: number }>(
      `SELECT parts_cents FROM order_items WHERE id = ?`, item);
    expect(totals!.parts_cents).toBe($(180));
  });

  it('charges the corrected number when the quote was replaced', async () => {
    // The operator typed 180, then found it needed rotors too and sent 240.
    // Only the number currently on the customer's screen can be charged.
    const { order_id, item, token } = await seed();
    await pay(order_id);
    await quoteFor(item, $(180));
    const corrected = await quoteFor(item, $(240));
    calls = [];

    await decideQuote(env, token, corrected.id, 'approved');
    expect(partsCharges()).toHaveLength(1);
    expect(partsCharges()[0]!.body.amount).toBe(String($(240)));
  });

  it('takes nothing when they decline', async () => {
    const { order_id, item, token } = await seed();
    await pay(order_id);
    const quote = await quoteFor(item, $(180));
    calls = [];

    await decideQuote(env, token, quote.id, 'declined');
    expect(partsCharges()).toHaveLength(0);
    expect((await quoteRow(quote.id))!.charged_at).toBeNull();
  });
});

describe('a charge that does not go through', () => {
  it('does not look like an approval', async () => {
    vi.stubGlobal('fetch', stripeStub({ cardDeclines: 1 }));
    const { order_id, item, token } = await seed();
    await pay(order_id);
    const quote = await quoteFor(item, $(180));
    calls = [];

    const refusal = await decideQuote(env, token, quote.id, 'approved')
      .then(() => null, (e) => e as { status: number; message: string });
    // Stripe's own sentence, at the status this product uses when a card is
    // what is missing. Left as a raw StripeError the customer would have got a
    // 500 reading "Something went wrong", which is both untrue and useless to
    // somebody standing next to a mechanic waiting on an answer.
    expect(refusal!.status).toBe(402);
    expect(refusal!.message).toMatch(/declined/i);

    // Nothing moved and nothing was recorded as owed: the operator has not
    // been told to fit a part that will never be paid for.
    const row = (await quoteRow(quote.id))!;
    expect(row.status).toBe('sent');
    expect(row.charged_at).toBeNull();
    expect(row.charge_error).toMatch(/declined/i);
    // Stripe answered 4xx, so it read the request and created nothing. The
    // counter moves, which is what gets the retry a fresh idempotency key
    // instead of the stored refusal Stripe caches for 24 hours.
    expect(row.charge_attempts).toBe(1);

    const totals = await one<{ parts_cents: number }>(
      `SELECT parts_cents FROM order_items WHERE id = ?`, item);
    expect(totals!.parts_cents).toBe(0);
  });

  it('goes through on the next try, under a key Stripe has not seen', async () => {
    vi.stubGlobal('fetch', stripeStub({ cardDeclines: 1 }));
    const { order_id, item, token } = await seed();
    await pay(order_id);
    const quote = await quoteFor(item, $(180));
    calls = [];

    await expect(decideQuote(env, token, quote.id, 'approved')).rejects.toThrow();
    await decideQuote(env, token, quote.id, 'approved');

    expect(partsCharges()).toHaveLength(2);
    expect(partsCharges()[0]!.idempotency).toBe(`pq:${quote.id}:0`);
    // The whole point of counting refusals: somebody whose card was declined
    // at nine in the morning can fix it and approve at ten, rather than being
    // handed the stored decline for the rest of the day.
    expect(partsCharges()[1]!.idempotency).toBe(`pq:${quote.id}:1`);
    expect((await quoteRow(quote.id))!.charge_error).toBeNull();
  });

  it('does not move the key when Stripe says that key is still in flight', async () => {
    // THE DOUBLE TAP ON ONE BAR OF SIGNAL. Two approvals go out together,
    // Stripe answers the second with a 409 saying the same key is still being
    // processed, and the old code read every 4xx as "Stripe created nothing"
    // and moved the attempt counter. The counter moves the idempotency key, so
    // the next tap was a brand new request for money that was already moving:
    // one $340 part, two charges. A 429 rate limit had the same shape.
    vi.stubGlobal('fetch', stripeStub({ keyInFlight: 1 }));
    const { order_id, item, token } = await seed();
    await pay(order_id);
    const quote = await quoteFor(item, $(340));
    calls = [];

    await expect(decideQuote(env, token, quote.id, 'approved')).rejects.toThrow();
    // Nothing recorded as charged, and the counter has NOT moved.
    const after = (await quoteRow(quote.id))!;
    expect(after.status).toBe('sent');
    expect(after.charged_at).toBeNull();
    expect(after.charge_attempts).toBe(0);
    expect(after.charge_error).toMatch(/in-progress request/i);

    // So the retry goes out under the SAME key, where Stripe deduplicates it
    // against whatever that first request made.
    await decideQuote(env, token, quote.id, 'approved');
    expect(partsCharges()).toHaveLength(2);
    expect(partsCharges().map((c) => c.idempotency))
      .toEqual([`pq:${quote.id}:0`, `pq:${quote.id}:0`]);

    // One part, charged once.
    expect((await one<{ parts_cents: number }>(
      `SELECT parts_cents FROM order_items WHERE id = ?`, item))!.parts_cents).toBe($(340));
  });

  it('refuses to approve at all when there is no card to charge', async () => {
    // A booking with no card on it cannot pay for a part, and recording the
    // approval anyway is how an operator ends up fitting one on the platform's
    // word and never being paid for it.
    const { order_id, item, token } = await seed({ card: false });
    await pay(order_id);
    const quote = await quoteFor(item, $(180));
    calls = [];

    await expect(decideQuote(env, token, quote.id, 'approved'))
      .rejects.toThrow(/cannot charge a card/i);
    expect(partsCharges()).toHaveLength(0);
    expect((await quoteRow(quote.id))!.status).toBe('sent');
  });
});

describe('the money reaching the business', () => {
  it('waits for the work, then transfers the part in full', async () => {
    const { order_id, item, token } = await seed();
    await pay(order_id);
    const quote = await quoteFor(item, $(180), $(30));
    await decideQuote(env, token, quote.id, 'approved');
    calls = [];

    // Charged, and still the platform's until the job is behind it — exactly
    // the wait the labour does. Paying it out now would put the money out of
    // reach at the moment an argument about it could start.
    expect(await settleDueWork(env)).toMatchObject({ transferred: 0 });
    expect(transfers()).toHaveLength(0);

    await finished(item, WATCH_TAIL_SECONDS + 60);
    await settleDueWork(env);

    expect(partsTransfers()).toHaveLength(1);
    const out = partsTransfers()[0]!;
    // IN FULL. The platform's 15% is for the introduction; a part is money the
    // operator laid out on the customer's behalf, so none of it is kept.
    expect(out.body.amount).toBe(String($(210)));
    expect(out.body.destination).toBe('acct_mech');
    // Funded by the PARTS charge. Naming the labour charge would ask Stripe to
    // move this money out of a charge that has already been paid out.
    expect(out.body.source_transaction).toMatch(/^ch_parts_/);
    expect(out.idempotency).toBe(`trp:${quote.id}`);

    const row = (await quoteRow(quote.id))!;
    expect(row.transfer_id).toMatch(/^tr_test_/);
    expect(row.transferred_at).toBeGreaterThan(0);
  });

  it('pays the labour and the part as their own transfers', async () => {
    const { order_id, item, token } = await seed();
    await pay(order_id);
    const quote = await quoteFor(item, $(180));
    await decideQuote(env, token, quote.id, 'approved');
    await finished(item, WATCH_TAIL_SECONDS + 60);
    calls = [];

    await settleDueWork(env);
    // Two charges fund these, so there are two transfers: a transfer naming a
    // source_transaction cannot exceed that charge, and the part was never in
    // the labour one.
    expect(transfers()).toHaveLength(2);
    const amounts = transfers().map((c) => Number(c.body.amount)).sort((a, b) => a - b);
    expect(amounts).toEqual([$(102), $(180)]);   // $120 less 15%, and the part
  });

  it('pays the part once when three sweeps run AT THE SAME TIME', async () => {
    // Three sequential calls proved nothing: the first writes transfer_id
    // before the second reads it, so the second never reached Stripe and the
    // assertion held with every idempotency key removed. Overlapping ticks are
    // the real case — the sweep runs every fifteen minutes and a slow pass
    // after an outage outlives its own interval, so two of them read the same
    // unpaid quote and both decide to pay for it.
    const { order_id, item, token } = await seed();
    await pay(order_id);
    const quote = await quoteFor(item, $(180));
    await decideQuote(env, token, quote.id, 'approved');
    await finished(item, WATCH_TAIL_SECONDS + 60);
    calls = [];

    await Promise.all([settleDueWork(env), settleDueWork(env), settleDueWork(env)]);

    // All three really did ask Stripe to move the part's money.
    expect(partsTransfers().length).toBeGreaterThan(1);
    // Under one key, keyed on the QUOTE rather than the line, because a
    // booking can carry several parts and each is its own charge.
    expect(new Set(partsTransfers().map((c) => c.idempotency)))
      .toEqual(new Set([`trp:${quote.id}`]));
    // And Stripe made one transfer. Delete the key and this becomes three.
    const forThisQuote = madeTransfers.filter(
      (tr) => tr.metadata.parts_quote_id === quote.id);
    expect(new Set(forThisQuote.map((tr) => tr.id)).size).toBe(1);
    expect((await quoteRow(quote.id))!.transfer_id).toBe(forThisQuote[0]!.id);
  });

  it('still pays for a part approved after the labour went out', async () => {
    // The quote lives for three days and the payout goes at the job's end plus
    // the watch tail, so a customer answering that evening lands here. Looking
    // only at lines with no transfer id left this money in the platform balance
    // with nothing in the product that could move it.
    const { order_id, item, token } = await seed();
    await pay(order_id);
    await finished(item, WATCH_TAIL_SECONDS + 60);
    await settleDueWork(env);

    const quote = await quoteFor(item, $(180));
    await decideQuote(env, token, quote.id, 'approved');
    calls = [];

    expect(await settleDueWork(env)).toMatchObject({ orders: 1, transferred: 1 });
    expect(partsTransfers()).toHaveLength(1);
    expect(partsTransfers()[0]!.body.amount).toBe(String($(180)));
  });
});

describe('a part paid for on a booking that was then cancelled', () => {
  it('goes back to the customer along with the labour', async () => {
    // THERE WAS NO PATH FOR THIS AT ALL. A part is a second charge against a
    // second intent, and every refund in this product works off
    // orders.payment_intent_id — which is the labour. So the customer who
    // approved a $340 alternator on Monday and whose mechanic cancelled on
    // Tuesday was refunded the labour and not the part, and because the line
    // was cancelled nothing in the product ever looked at that quote again.
    // They were $340 down looking at a screen saying "refunded in full".
    const { order_id, item, token } = await seed();
    await pay(order_id);
    const quote = await quoteFor(item, $(340));
    await decideQuote(env, token, quote.id, 'approved');
    expect((await quoteRow(quote.id))!.charged_at).toBeGreaterThan(0);
    calls = [];

    await cancelByOperator(env, OP, item);
    // Frozen, like everything else: nobody has said whether the work happened.
    expect(await sweepPartsRefunds(env)).toEqual({ refunded: 0, failed: 0 });
    expect(partsRefunds()).toHaveLength(0);

    // Nobody answers, so the money goes back — both halves of it.
    await releaseHold(item);
    await sweepRefunds(env);
    expect(await sweepPartsRefunds(env)).toEqual({ refunded: 1, failed: 0 });

    // The labour, against the checkout charge.
    const labour = refunds().find((c) => !c.body['metadata[parts_quote_id]'])!;
    expect(labour.body.payment_intent).toBe(lastIntent);
    expect(labour.body.amount).toBe(String($(120)));

    // And the part, against ITS OWN charge and under its own key. Keyed on the
    // line instead, a booking with two approved quotes would have the second
    // refund handed back a copy of the first.
    expect(partsRefunds()).toHaveLength(1);
    const part = partsRefunds()[0]!;
    expect(part.body.payment_intent).toMatch(/^pi_parts_/);
    expect(part.body.amount).toBe(String($(340)));
    expect(part.idempotency).toBe(`rfp:${quote.id}:0`);

    const row = (await quoteRow(quote.id))!;
    expect(row.refund_id).toMatch(/^re_test_/);
    expect(row.refunded_at).toBeGreaterThan(0);

    // And nothing is paid out to the business for a part it did not fit.
    await finished(item, WATCH_TAIL_SECONDS + 60);
    await settleDueWork(env);
    expect(partsTransfers()).toHaveLength(0);
  });

  it('goes to the business instead when the work happened anyway', async () => {
    // The other answer to the same question. The customer says the job was
    // done despite the cancellation, so the part is on their car — refunding
    // it would leave the mechanic paying for an alternator they fitted.
    const { order_id, item, token } = await seed();
    await pay(order_id);
    const quote = await quoteFor(item, $(340));
    await decideQuote(env, token, quote.id, 'approved');
    await cancelByOperator(env, OP, item);
    calls = [];

    await answerWork(env, token, item, 'done');
    await finished(item, WATCH_TAIL_SECONDS + 60);
    await settleDueWork(env);

    expect(await sweepPartsRefunds(env)).toEqual({ refunded: 0, failed: 0 });
    expect(partsRefunds()).toHaveLength(0);
    expect(partsTransfers()).toHaveLength(1);
    expect(partsTransfers()[0]!.body.amount).toBe(String($(340)));
    expect((await quoteRow(quote.id))!.transfer_id).toMatch(/^tr_test_/);
  });

  it('is never refunded once it has been paid out', async () => {
    const { order_id, item, token } = await seed();
    await pay(order_id);
    const quote = await quoteFor(item, $(340));
    await decideQuote(env, token, quote.id, 'approved');
    await finished(item, WATCH_TAIL_SECONDS + 60);
    await settleDueWork(env);
    expect((await quoteRow(quote.id))!.transfer_id).toMatch(/^tr_test_/);
    calls = [];

    // Cancelled after the payout by a route that does not go through the
    // cancel guards, which is the only way to reach this state.
    await env.DB.prepare(
      `UPDATE order_items SET cancelled_at = ?, settlement = 'released' WHERE id = ?`,
    ).bind(now(), item).run();

    // The money is in the mechanic's bank account; refunding it would come out
    // of the platform rather than out of them.
    expect(await sweepPartsRefunds(env)).toEqual({ refunded: 0, failed: 0 });
    expect(partsRefunds()).toHaveLength(0);
  });
});

describe('a parts charge that succeeded and was never written down', () => {
  /**
   * The wreckage of an approval that died between Stripe and D1: the card has
   * been charged and the row still says 'sent'. It cannot be produced through
   * decideQuote, because decideQuote is what would have written it down.
   */
  async function orphan(quoteId: string, amount: number) {
    orphanedCharges.push({
      id: 'pi_parts_orphan',
      status: 'succeeded',
      amount,
      currency: 'usd',
      // Expanded, as Stripe sends it whenever anything asks — String() on this
      // writes "[object Object]" into charge_id.
      latest_charge: { id: 'ch_parts_orphan', object: 'charge' },
      metadata: { parts_quote_id: quoteId },
    });
    await env.DB.prepare(`UPDATE parts_quotes SET expires_at = ? WHERE id = ?`)
      .bind(now() - 1, quoteId).run();
  }

  it('is found rather than buried by the expiry sweep', async () => {
    // expireQuotes selected on status and expires_at and nothing else, so
    // three days after the crash it wrote 'expired' over the one row that
    // pointed at the customer's $340 — leaving no approved quote to transfer,
    // no charged_at to notice and a status meaning "nothing happened". The
    // money became unreachable, by a cron job, silently.
    const { order_id, item, token } = await seed();
    await pay(order_id);
    const quote = await quoteFor(item, $(340));
    await orphan(quote.id, $(340));
    calls = [];

    // The cron asks Stripe first, by the quote id createPaymentIntent puts in
    // the intent's metadata for exactly this.
    expect(await reconcileSentQuotes(env)).toEqual({ checked: 1, recovered: 1 });
    const search = calls.find((c) => c.path.startsWith('/payment_intents/search'))!;
    expect(decodeURIComponent(search.path)).toContain(
      `metadata['parts_quote_id']:'${quote.id}'`);

    const row = (await quoteRow(quote.id))!;
    expect(row.status).toBe('approved');
    expect(row.charged_at).toBeGreaterThan(0);
    expect(row.payment_intent_id).toBe('pi_parts_orphan');
    expect(row.charge_id).toBe('ch_parts_orphan');

    // The part is on the booking's total now, exactly as approving it would
    // have put it there.
    expect((await one<{ parts_cents: number }>(
      `SELECT parts_cents FROM order_items WHERE id = ?`, item))!.parts_cents).toBe($(340));

    // And the sweep that used to bury it leaves it alone.
    expect(await expireQuotes(env)).toBe(0);

    // Which means the mechanic can finally be paid for the part they fitted.
    await finished(item, WATCH_TAIL_SECONDS + 60);
    await settleDueWork(env);
    expect(partsTransfers()).toHaveLength(1);
    expect(partsTransfers()[0]!.body.amount).toBe(String($(340)));
    expect(partsTransfers()[0]!.body.source_transaction).toBe('ch_parts_orphan');

    // Nothing sent the customer a second charge on the way through.
    expect(partsCharges()).toHaveLength(0);
  });

  it('is never expired while it carries an intent, whatever Stripe says', async () => {
    // The cheap half of the same protection, and the one that does not depend
    // on Stripe answering: a quote with money against it is not a quote nobody
    // answered, so the expiry sweep does not get to decide anything about it.
    const { order_id, item } = await seed();
    await pay(order_id);
    const quote = await quoteFor(item, $(340));
    await env.DB.prepare(
      `UPDATE parts_quotes SET expires_at = ?, payment_intent_id = 'pi_parts_half'
        WHERE id = ?`,
    ).bind(now() - 1, quote.id).run();

    expect(await expireQuotes(env)).toBe(0);
    expect((await quoteRow(quote.id))!.status).toBe('sent');
  });

  it('still expires an ordinary quote nobody answered', async () => {
    const { order_id, item } = await seed();
    await pay(order_id);
    const quote = await quoteFor(item, $(340));
    await env.DB.prepare(`UPDATE parts_quotes SET expires_at = ? WHERE id = ?`)
      .bind(now() - 1, quote.id).run();

    // Stripe holds nothing for it, so there is nothing to recover and the
    // ordinary rule applies: a live quote is a standing authorisation to
    // charge somebody, and part prices move.
    expect(await reconcileSentQuotes(env)).toEqual({ checked: 1, recovered: 0 });
    expect(await expireQuotes(env)).toBe(1);
    expect((await quoteRow(quote.id))!.status).toBe('expired');
  });
});
