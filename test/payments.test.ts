import { describe, expect, it, beforeEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import worker from '../src/index';
import type { Env } from '../src/types';
import { findCardData, looksLikeIban, looksLikePan, luhn } from '../src/lib/cardscan';
import {
  assertNoCardData, assertPaymentRef, cardSafeDb, safeBrand, safeLast4,
} from '../src/lib/payments';
import { json, newId, now } from '../src/lib/util';

/**
 * The rule: a card number, a CVC, an expiry or a full bank detail can never be
 * accepted, stored, logged or returned. Only the processor's opaque reference.
 *
 * These tests are written against the three places that rule is enforced --
 * the request body, the database binding and the JSON response -- rather than
 * against the one endpoint that happens to be about payment. That is the whole
 * claim being made: the guard holds on routes nobody wrote with cards in mind,
 * which is where a mis-wired form would actually land.
 */

const BASE = 'https://gap.test';
let env: Env;

/** Test PANs. Every one of these is a published test number, not a card. */
const VISA = '4111111111111111';
const VISA_SPACED = '4111 1111 1111 1111';
const MASTERCARD = '5555555555554444';
const AMEX = '378282246310005';

function makeReq(method: string, path: string, opts: {
  body?: unknown; cookie?: string; ip?: string; raw?: string;
  headers?: Record<string, string>;
} = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined || opts.raw !== undefined) {
    headers['content-type'] = headers['content-type'] ?? 'application/json';
  }
  if (opts.cookie) headers['cookie'] = opts.cookie;
  headers['cf-connecting-ip'] = opts.ip ?? '203.0.113.44';
  return new Request(`${BASE}${path}`, {
    method, headers,
    body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
}

const call = (method: string, path: string, opts?: Parameters<typeof makeReq>[2]) =>
  worker.fetch(makeReq(method, path, opts), env, {} as ExecutionContext);

async function signIn(email: string) {
  const t = now();
  const opId = newId();
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,timezone,country,currency,
       location_mode,fill_model,sms_mode,plan,created_at,updated_at)
     VALUES (?,?, 'A Business', 'America/Los_Angeles','US','USD','mobile','both','device',
       'active',?,?)`,
  ).bind(opId, email, t, t).run();

  const raw = `sess-${opId}`;
  const digest = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(`${raw}:${env.SESSION_PEPPER}`));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  await env.DB.prepare(
    `INSERT INTO sessions (id,operator_id,token_hash,expires_at,created_at)
     VALUES (?,?,?,?,?)`,
  ).bind(newId(), opId, hash, t + 86400, t).run();
  return { opId, cookie: `gf_session=${raw}` };
}

beforeEach(() => {
  env = makeEnv(ALL_MIGRATIONS) as unknown as Env;
});

// ---------------------------------------------------------------------------
describe('telling a card number from everything else that is long and numeric', () => {
  it('recognises the card brands', () => {
    for (const pan of [VISA, VISA_SPACED, MASTERCARD, AMEX, '4111-1111-1111-1111']) {
      expect(looksLikePan(pan), pan).toBe(true);
    }
  });

  it('leaves the numbers this product is actually full of alone', () => {
    // Every one of these appears in ordinary rows or ordinary sentences, and a
    // guard that refuses any of them is a guard somebody switches off.
    const innocent = [
      '1757030400',                         // an epoch second
      '+13105550147',                       // an E.164 phone number
      '+447700900123',                      // the same, twelve digits
      '+8613800138000',                     // and thirteen
      '90210',                              // a postcode
      '125000',                             // a price in cents
      'pm_1PabcDEF2ghiJKL',                 // a processor reference
      '0193f8a1-4b2c-7d3e-8f90-1a2b3c4d5e6f', // one of our own ids
      '34.152000,-118.445000',              // a coordinate pair
      '4111111111111112',                   // sixteen digits that fail Luhn
      '9111111111111111',                   // Luhn-valid, but no issuer starts 9
    ];
    for (const s of innocent) expect(looksLikePan(s), s).toBe(false);
  });

  it('never reads a token hash as a card, however the digits fall', () => {
    // Every session, offer link, guest link and watch token in this product is
    // stored as a sha256 hex digest. Sixty-four hex characters are about
    // five-eighths digits, so roughly one digest in four contains a run of
    // thirteen or more and one in ten of those passes Luhn by chance -- which
    // made this guard reject about one sign-in in a hundred, intermittently,
    // for no reason anybody could reproduce.
    const embedded = `abc${VISA}def`;
    expect(looksLikePan(embedded)).toBe(false);
    expect(findCardData({ token_hash: embedded })).toBeNull();

    for (let i = 0; i < 400; i++) {
      const digest = [...crypto.getRandomValues(new Uint8Array(32))]
        .map((b) => b.toString(16).padStart(2, '0')).join('');
      expect(looksLikePan(digest), digest).toBe(false);
    }
  });

  it('checks an IBAN properly rather than by shape', () => {
    expect(looksLikeIban('GB82 WEST 1234 5698 7654 32')).toBe(true);
    expect(looksLikeIban('GB82WEST12345698765433')).toBe(false);
    expect(looksLikeIban('LOS-ANGELES-91403-XYZ')).toBe(false);
  });

  it('knows what Luhn is for', () => {
    expect(luhn(VISA)).toBe(true);
    expect(luhn('4111111111111112')).toBe(false);
  });

  it('catches the fields that carry a value no pattern could recognise', () => {
    // A CVC is three digits and an expiry month is two. There is no shape to
    // match, so the name of the field is the only thing left to catch it by.
    expect(findCardData({ cvc: '737' })?.kind).toBe('named_field');
    expect(findCardData({ cvv2: '737' })?.kind).toBe('named_field');
    expect(findCardData({ exp_month: 4, exp_year: 2029 })?.kind).toBe('named_field');
    expect(findCardData({ security_code: '737' })?.kind).toBe('named_field');
    expect(findCardData({ routing_number: '110000000' })?.kind).toBe('named_field');
  });

  it('does not mistake this codebase\'s own field names for card fields', () => {
    // expires_at is on offers, quotes, requests and sessions. If the pattern
    // that catches "expiry" also caught this, nothing in the product would
    // save at all.
    expect(findCardData({ expires_at: 1757030400 })).toBeNull();
    expect(findCardData({ insurance_expires_at: 1788566400 })).toBeNull();
    expect(findCardData({ phone_e164: '+13105550147' })).toBeNull();
    expect(findCardData({ number_of_rooms: 3 })).toBeNull();
  });

  it('finds one nested several levels down, and says where without saying what', () => {
    const hit = findCardData({ order: { items: [{ note: `pay with ${VISA}` }] } });
    expect(hit?.kind).toBe('pan');
    expect(hit?.path).toBe('order.items[0].note');
    // The path is the diagnostic. The value must never be in it, because the
    // path ends up in a log line.
    expect(JSON.stringify(hit)).not.toContain('4111');
  });
});

// ---------------------------------------------------------------------------
describe('the guard on the way in', () => {
  it('refuses a card number on a route that has nothing to do with payment', async () => {
    const op = await signIn('op@example.com');
    const res = await call('POST', '/api/clients', {
      cookie: op.cookie,
      body: { first_name: 'Rosa', notes: `card on file ${VISA}` },
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { code: string }).code).toBe('raw_card');

    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM clients`)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it('refuses a CVC field even though the value is three harmless digits', async () => {
    const op = await signIn('op@example.com');
    const res = await call('POST', '/api/clients', {
      cookie: op.cookie, body: { first_name: 'Rosa', cvc: '737' },
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { code: string }).code).toBe('card_data');
  });

  it('lets an ordinary body through untouched', async () => {
    const op = await signIn('op@example.com');
    const res = await call('POST', '/api/clients', {
      cookie: op.cookie,
      body: { first_name: 'Rosa', phone_e164: '+13105550147', notes: 'gate code 4471' },
    });
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
describe('the guard on the way to the database', () => {
  /**
   * The one that matters most: it does not care how the value arrived. A
   * webhook, an import or a library function assembling a string out of three
   * others all end up at prepare().bind(), and so does anything written next
   * year by somebody who never read payments.ts.
   */
  it('refuses a bound value that is a card number', async () => {
    const db = cardSafeDb(env.DB as unknown as D1Database);
    expect(() => db.prepare(
      `INSERT INTO clients (id,operator_id,first_name,notes,created_at,updated_at)
       VALUES (?,?,?,?,?,?)`,
    ).bind(newId(), 'op', 'Rosa', VISA, now(), now())).toThrow(/card or bank details/);
  });

  it('still writes everything that is not one', async () => {
    const db = cardSafeDb(env.DB as unknown as D1Database);
    const t = now();
    await db.prepare(
      `INSERT INTO operators (id,email,business_name,phone_e164,timezone,country,currency,
         location_mode,fill_model,sms_mode,plan,created_at,updated_at)
       VALUES (?,?,?,?, 'America/Los_Angeles','US','USD','mobile','both','device','active',?,?)`,
    ).bind('op-1', 'a@b.test', 'A Business', '+13105550147', t, t).run();

    const row = await env.DB.prepare(`SELECT phone_e164 FROM operators WHERE id='op-1'`)
      .first<{ phone_e164: string }>();
    expect(row?.phone_e164).toBe('+13105550147');
  });

  it('hands real statements to batch, not wrapped ones', async () => {
    const db = cardSafeDb(env.DB as unknown as D1Database);
    const t = now();
    await db.batch([
      db.prepare(
        `INSERT INTO operators (id,email,business_name,timezone,country,currency,
           location_mode,fill_model,sms_mode,plan,created_at,updated_at)
         VALUES (?,?, 'B', 'America/Los_Angeles','US','USD','mobile','both','device','active',?,?)`,
      ).bind('op-2', 'c@d.test', t, t),
    ]);
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM operators`).first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it('is what the Worker actually runs with', async () => {
    // Not a unit test of the wrapper but of the wiring: the entry point
    // replaces env.DB, so a handler reaching for it gets the guarded one.
    const op = await signIn('op@example.com');
    const res = await call('PATCH', '/api/settings', {
      cookie: op.cookie, body: { home_address: `Flat 2, ${MASTERCARD}` },
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe('the guard on the way out', () => {
  it('refuses to serialise a response carrying a card number', async () => {
    const res = json({ client: { notes: `card ${VISA}` } });
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain('4111');
    expect(body).toContain('card_data_blocked');
  });

  it('does not mistake the phone numbers every response is full of', async () => {
    const res = json({ clients: [{ phone_e164: '+447700900123', last_name: 'Ross' }] });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('+447700900123');
  });

  it('costs an ordinary response nothing it would notice', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      id: newId(), starts_at: 1757030400 + i, price_cents: 12500, postcode: '91403',
    }));
    const res = json({ rows });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe('what a payment reference has to be', () => {
  it('takes the processor\'s handle', () => {
    expect(assertPaymentRef('pm_1PabcDEF2ghiJKL')).toBe('pm_1PabcDEF2ghiJKL');
    expect(assertPaymentRef('  cus_ABC123  ')).toBe('cus_ABC123');
  });

  it('refuses a bare number, which is what a mis-wired form sends', () => {
    expect(() => assertPaymentRef(VISA)).toThrow();
    // Not a card by shape, but still not a reference: no processor hands back
    // a value with no letters in it.
    expect(() => assertPaymentRef('1234 5678')).toThrow(/payment reference/);
    expect(() => assertPaymentRef('')).toThrow();
  });

  it('keeps last4 to four digits and the brand to a label', () => {
    expect(safeLast4(VISA)).toBe('1111');
    expect(safeLast4('4242')).toBe('4242');
    expect(safeLast4(null)).toBeNull();
    expect(safeBrand('visa')).toBe('visa');
    expect(safeBrand('American Express')).toBe('American Express');
    expect(safeBrand(VISA)).toBeNull();
  });

  it('refuses to log the value it is refusing', () => {
    // assertNoCardData throws; nothing it produces may carry the number,
    // because the error message reaches the client and the log reaches a tail.
    try {
      assertNoCardData({ ref: VISA }, 'a test');
      expect.unreachable();
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('4111');
    }
  });
});

// ---------------------------------------------------------------------------
describe('the Stripe webhook, built before there is a charge to receive', () => {
  const SECRET = 'whsec_test_secret_value';
  const PAYLOAD = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded' });

  async function sign(payload: string, timestamp: number, secret = SECRET) {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const mac = await crypto.subtle.sign(
      'HMAC', key, new TextEncoder().encode(`${timestamp}.${payload}`));
    const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `t=${timestamp},v1=${hex}`;
  }

  it('answers 503 while the secret is unset, and processes nothing', async () => {
    // The deliberate difference from Turnstile: an endpoint that will one day
    // mark jobs paid must not have a mode where it takes unsigned orders.
    const res = await call('POST', '/webhooks/stripe', { raw: PAYLOAD });
    expect(res.status).toBe(503);
    expect((await res.json() as { code: string }).code).toBe('stripe_unconfigured');
  });

  it('accepts a correctly signed event once the secret is set', async () => {
    env.STRIPE_WEBHOOK_SECRET = SECRET;
    const t = now();
    const res = await call('POST', '/webhooks/stripe', {
      raw: PAYLOAD, headers: { 'stripe-signature': await sign(PAYLOAD, t) },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
  });

  it('refuses a signature made with the wrong secret', async () => {
    env.STRIPE_WEBHOOK_SECRET = SECRET;
    const res = await call('POST', '/webhooks/stripe', {
      raw: PAYLOAD,
      headers: { 'stripe-signature': await sign(PAYLOAD, now(), 'whsec_not_the_secret') },
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { code: string }).code).toBe('bad_signature');
  });

  it('refuses a body that was changed after it was signed', async () => {
    env.STRIPE_WEBHOOK_SECRET = SECRET;
    const header = await sign(PAYLOAD, now());
    const tampered = JSON.stringify({ id: 'evt_1', type: 'charge.refunded' });
    const res = await call('POST', '/webhooks/stripe', {
      raw: tampered, headers: { 'stripe-signature': header },
    });
    expect(res.status).toBe(400);
  });

  it('refuses a replay of yesterday\'s signed event', async () => {
    env.STRIPE_WEBHOOK_SECRET = SECRET;
    const old = now() - 86400;
    const res = await call('POST', '/webhooks/stripe', {
      raw: PAYLOAD, headers: { 'stripe-signature': await sign(PAYLOAD, old) },
    });
    expect(res.status).toBe(400);
  });

  it('refuses a request with no signature at all', async () => {
    env.STRIPE_WEBHOOK_SECRET = SECRET;
    const res = await call('POST', '/webhooks/stripe', { raw: PAYLOAD });
    expect(res.status).toBe(400);
  });

  it('refuses an otherwise valid event that carries a card number', async () => {
    env.STRIPE_WEBHOOK_SECRET = SECRET;
    const payload = JSON.stringify({ id: 'evt_2', type: 'x', data: { number: VISA } });
    const res = await call('POST', '/webhooks/stripe', {
      raw: payload, headers: { 'stripe-signature': await sign(payload, now()) },
    });
    expect(res.status).toBe(400);
  });
});
