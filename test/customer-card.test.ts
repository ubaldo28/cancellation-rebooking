import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import type { Env } from '../src/types';
import { newId, now } from '../src/lib/util';
import { accountById, ensureStripeCustomer, type CustomerAccount } from '../src/lib/customers';
import { createSetupIntent, getPaymentMethod } from '../src/lib/stripe';

/**
 * THE CARD A CUSTOMER LEAVES BEHIND.
 *
 * Taking a card at booking time is only worth anything if the card can be
 * charged later, and that needs two things to be right: the card has to be
 * filed under an account at Stripe that outlives the form it was typed into,
 * and the form has to ask the bank for permission to use it while nobody is
 * watching. Neither is visible from the outside until months afterwards, when
 * a charge is declined or a stranger's card is charged, so both are pinned
 * here.
 *
 * Stripe is stood in for. Everything this code does goes through fetch, so
 * fetch is what is replaced — which means the request bodies, the idempotency
 * keys and the absence of one are all real and asserted rather than described.
 */

let env: Env;
/** Every request the code made to Stripe, in order. */
let calls: Array<{
  method: string; path: string;
  body: Record<string, string>; idempotency: string | null;
}>;
/**
 * Never reset between accounts. Stripe object ids are unique forever, and the
 * unique index migration 0041 puts on stripe_customer_id exists precisely to
 * refuse a repeat — a counter that restarted would have this stub violating it
 * and look like a bug in the code under test.
 */
let issued = 0;

function stripeStub() {
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
      method: init.method ?? 'GET',
      path,
      body,
      idempotency: init.headers?.['idempotency-key'] ?? null,
    });

    if (path === '/customers') {
      issued += 1;
      return new Response(JSON.stringify({ id: `cus_test_${issued}` }), { status: 200 });
    }
    if (path === '/setup_intents') {
      issued += 1;
      return new Response(JSON.stringify({
        id: `seti_test_${issued}`,
        client_secret: `seti_test_${issued}_secret_abc`,
        status: 'requires_payment_method',
      }), { status: 200 });
    }
    if (path.startsWith('/payment_methods/')) {
      return new Response(JSON.stringify({
        id: path.split('/').pop(),
        // What Stripe says the card is, which is the only account of it that
        // was not written by a browser.
        card: { brand: 'visa', last4: '4242' },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: `unstubbed ${path}` } }),
      { status: 400 });
  });
}

/** A signed-up customer, straight into the table the real sign-in writes. */
async function account(
  opts: { email?: string; name?: string | null } = {},
): Promise<CustomerAccount> {
  const id = newId();
  const t = now();
  const email = opts.email ?? 'rosa@example.com';
  await env.DB.prepare(
    `INSERT INTO customer_accounts
       (id, login_email, email_verified_at, first_name, email, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(id, email, t, opts.name === undefined ? 'Rosa' : opts.name, email, t, t).run();
  return (await accountById(env, id))!;
}

const storedCustomer = async (id: string) => (await env.DB.prepare(
  `SELECT stripe_customer_id FROM customer_accounts WHERE id = ?`,
).bind(id).first<{ stripe_customer_id: string | null }>())!.stripe_customer_id;

beforeEach(() => {
  calls = [];
  issued = 0;
  env = {
    ...makeEnv(ALL_MIGRATIONS),
    STRIPE_SECRET_KEY: 'sk_test_stub',
    APP_URL: 'https://roundtheway.app',
  } as unknown as Env;
  vi.stubGlobal('fetch', stripeStub());
});
afterEach(() => vi.unstubAllGlobals());

describe('the customer at the processor', () => {
  it('creates one and writes it to the account', async () => {
    const rosa = await account();
    const customerId = await ensureStripeCustomer(env, rosa);

    expect(customerId).toBe('cus_test_1');
    expect(await storedCustomer(rosa.id)).toBe('cus_test_1');

    const [call] = calls;
    expect(call!.method).toBe('POST');
    expect(call!.path).toBe('/customers');
    // The trace back to a row here, so a customer found in the Stripe
    // dashboard never has to be identified by guessing at an email address.
    expect(call!.body['metadata[customer_account_id]']).toBe(rosa.id);
    expect(call!.body.email).toBe('rosa@example.com');
    expect(call!.body.name).toBe('Rosa');
  });

  it('sends an idempotency key derived from the account', async () => {
    const rosa = await account();
    await ensureStripeCustomer(env, rosa);
    // Keyed on the account, and bucketed in time for the reason written above
    // createConnectAccount: Stripe caches failures against a key for a day, so
    // a key that never moves turns one bad morning into a bad day.
    expect(calls[0]!.idempotency).toMatch(new RegExp(`^cus:${rosa.id}:\\d+$`));
  });

  it('asks Stripe once, however many times it is called', async () => {
    const rosa = await account();
    const first = await ensureStripeCustomer(env, rosa);
    const second = await ensureStripeCustomer(env, (await accountById(env, rosa.id))!);

    expect(second).toBe(first);
    expect(calls.filter((c) => c.path === '/customers')).toHaveLength(1);
  });

  it('never moves an account onto a second customer', async () => {
    const rosa = await account();
    // Both callers holding the row as it was BEFORE either of them wrote: two
    // tabs, or a double-tapped button. Nothing can stop the second create at
    // Stripe, because it has already happened by the time the first write
    // lands. What must not happen is the row moving off the handle a card may
    // already have been saved under.
    const [first, second] = await Promise.all([
      ensureStripeCustomer(env, rosa),
      ensureStripeCustomer(env, rosa),
    ]);

    expect(second).toBe(first);
    expect(await storedCustomer(rosa.id)).toBe(first);
  });

  it('refuses when payments are not switched on', async () => {
    const rosa = await account();
    const off = { ...env, STRIPE_SECRET_KEY: '' } as unknown as Env;

    await expect(ensureStripeCustomer(off, rosa)).rejects.toMatchObject({
      status: 400, code: 'stripe_unconfigured',
    });
    // Refused at the door rather than half-way through, so nothing exists at
    // Stripe for a deployment that cannot charge anything.
    expect(calls).toHaveLength(0);
  });

  it('refuses an account that was closed while this was in flight', async () => {
    const rosa = await account();
    await env.DB.prepare(`UPDATE customer_accounts SET closed_at = ? WHERE id = ?`)
      .bind(now(), rosa.id).run();

    await expect(ensureStripeCustomer(env, rosa)).rejects.toMatchObject({
      code: 'account_closed',
    });
    // The row is the authority: it holds nothing, so there is no account left
    // for a card to be saved against.
    expect(await storedCustomer(rosa.id)).toBeNull();
  });
});

describe('asking to keep the card', () => {
  it('takes no money and keeps the customer on this site', async () => {
    const intent = await createSetupIntent(env, 'cus_test_1');
    expect(intent.client_secret).toBe(`${intent.id}_secret_abc`);

    const [call] = calls;
    expect(call!.method).toBe('POST');
    expect(call!.path).toBe('/setup_intents');
    expect(call!.body.customer).toBe('cus_test_1');
    // The card is being saved to be charged when nobody is at the screen. Say
    // so now, or a European card passes this form and declines the first time
    // it is actually used.
    expect(call!.body.usage).toBe('off_session');
    // The two that keep the customer here, the same pair createPaymentIntent
    // sends: a method that can only be finished on somebody else's page is not
    // offered at all.
    expect(call!.body['automatic_payment_methods[enabled]']).toBe('true');
    expect(call!.body['automatic_payment_methods[allow_redirects]']).toBe('never');
    // Nothing is charged by putting a card on file.
    expect(call!.body.amount).toBeUndefined();
  });

  it('carries no idempotency key, so a second attempt is a second attempt', async () => {
    const first = await createSetupIntent(env, 'cus_test_1');
    const second = await createSetupIntent(env, 'cus_test_1');

    // Stripe caches a key's answer for 24 hours, failures included. A key here
    // would hand somebody whose card was declined at nine in the morning that
    // same refusal every time they tried again until tomorrow.
    expect(calls.map((c) => c.idempotency)).toEqual([null, null]);
    expect(second.id).not.toBe(first.id);
  });
});

describe('what card was actually saved', () => {
  it('reads the brand and last four from Stripe, not from the browser', async () => {
    const method = await getPaymentMethod(env, 'pm_test_123');

    expect(method.card?.brand).toBe('visa');
    expect(method.card?.last4).toBe('4242');

    const [call] = calls;
    expect(call!.method).toBe('GET');
    expect(call!.path).toBe('/payment_methods/pm_test_123');
    // A read, so nothing is sent and no key is needed. Stripe rejects an
    // idempotency key on a GET outright.
    expect(call!.idempotency).toBeNull();
  });
});
