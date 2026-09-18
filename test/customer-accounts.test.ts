import { beforeEach, describe, expect, it } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import worker from '../src/index';
import type { Env } from '../src/types';
import { captureSms, configureSms, signInCustomer } from './customer';
import { CUSTOMER_AUTH } from '../src/lib/customers';
import { newId, now } from '../src/lib/util';

/**
 * The customer account: an email address, proved by a code sent to it.
 *
 * EVERY TEST IN THIS FILE FAILS ON THE CODE BEFORE MIGRATION 0037. Most of
 * them fail with a 404, because the routes did not exist; the ones about
 * booking fail because a booking with no account used to be the only kind
 * there was, and the ones about standing fail because the number on an order
 * came out of the checkout form and could therefore be anybody's.
 *
 * MIGRATION 0038 MOVED THE IDENTITY OFF THE NUMBER. There is no way to send a
 * text message, so the code goes to a mailbox — and the account had to move
 * with the code rather than the code alone, because an account keyed on an
 * unproved number and unlocked by a proved address is an account takeover.
 * The number is still asked for and still written down: an operator driving to
 * a stranger's address needs something to ring on arrival. It identifies
 * nobody, and the tests below say so in the places it used to.
 *
 * The file is grouped by the claim each group is defending rather than by
 * route, because several of these are one property showing up in three places.
 */

const BASE = 'https://gap.test';
const OP = 'op-accounts';
const HERE = { lat: 34.1510, lng: -118.4450 };
/** The identity: the mailbox the code goes to, and what standing hangs on. */
const EMAIL = 'rosa@mailbox.test';
/** The contact number on the account. Taken on trust, proves nothing. */
const E164 = '+18185550142';

let env: Env;

beforeEach(async () => {
  env = makeEnv(ALL_MIGRATIONS) as unknown as Env;
});

/**
 * Signs somebody in with the contact number this file asserts on.
 *
 * The helper's default number is deliberately not E164, so anything checking
 * "the number came off the account" has to say which number it means.
 */
const signIn = (
  email = EMAIL, opts: { first_name?: string; phone?: string } = {},
) => signInCustomer(env, email, { phone: E164, ...opts });

function makeReq(method: string, path: string, opts: {
  body?: unknown; cookie?: string; ip?: string;
} = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = opts.cookie;
  headers['cf-connecting-ip'] = opts.ip ?? '203.0.113.7';
  return new Request(`${BASE}${path}`, {
    method, headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

const call = (method: string, path: string, opts: Parameters<typeof makeReq>[2] = {}) =>
  worker.fetch(makeReq(method, path, opts), env, {} as ExecutionContext);

const count = async (sql: string, ...args: unknown[]) =>
  (await env.DB.prepare(sql).bind(...args).first<{ n: number }>())!.n;

/** A business with one opening a stranger could actually book. */
async function seed(): Promise<{ gapId: string }> {
  const t = now();
  // stripe_payouts_enabled = 1 is load-bearing, not boilerplate: a business
  // must have somewhere to be paid before its work can be sold, so priceOrder
  // treats an opening for an operator without it as unlisted. Drop it and every
  // booking in this file comes back slot_gone.
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,timezone,country,currency,language,
       location_mode,fill_model,sms_mode,max_detour_seconds,min_gap_seconds,buffer_seconds,
       offer_ttl_seconds,offers_per_wave,min_notice_seconds,reoffer_cooldown_seconds,
       discount_percent,plan,accept_public_bookings,created_at,updated_at,
       stripe_payouts_enabled)
     VALUES (?,?,?, 'America/Los_Angeles','US','USD','en','mobile','both','device',
       3600,3600,900,5400,3,3600,604800,0,'active',1,?,?,1)`,
  ).bind(OP, 'accounts@example.com', 'Valley Detailing', t, t).run();

  await env.DB.prepare(
    `INSERT INTO services (id,operator_id,name,duration_seconds,price_cents,created_at,updated_at)
     VALUES ('svc-wash',?,'Wash only',3600,4900,?,?)`,
  ).bind(OP, t, t).run();

  await env.DB.prepare(
    `INSERT INTO postal_codes (country_code,postal_code,place_name,lat,lng,accuracy)
     VALUES ('US','91403','Sherman Oaks',?,?,6)`,
  ).bind(HERE.lat, HERE.lng).run();

  const gapId = newId();
  await env.DB.prepare(
    `INSERT INTO gaps (id,operator_id,starts_at,ends_at,prev_lat,prev_lng,next_lat,next_lng,
       baseline_drive_seconds,is_mobile,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,180,1,'open',?,?)`,
  ).bind(gapId, OP, t + 4 * 3600, t + 9 * 3600,
    HERE.lat, HERE.lng, HERE.lat, HERE.lng, t, t).run();

  return { gapId };
}

const orderBody = (gapId: string, extra: Record<string, unknown> = {}) => ({
  items: [{ gap_id: gapId, service_ids: ['svc-wash'] }],
  guest_name: 'Rosa',
  email: EMAIL,
  phone: E164,
  address_line: '15200 Ventura Blvd',
  postcode: '91403',
  ...extra,
});

/** An operator with a real session, minted the way lib/auth.ts hashes one. */
async function signInOperator(email = 'other@example.com') {
  const t = now();
  const opId = newId();
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,timezone,country,currency,
       location_mode,fill_model,sms_mode,plan,created_at,updated_at)
     VALUES (?,?,?, 'America/Los_Angeles','US','USD','mobile','both','device','active',?,?)`,
  ).bind(opId, email, 'Another Business', t, t).run();

  const raw = `sess-${opId}`;
  const digest = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(`${raw}:${env.SESSION_PEPPER}`));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  await env.DB.prepare(
    `INSERT INTO sessions (id,operator_id,token_hash,expires_at,created_at)
     VALUES (?,?,?,?,?)`,
  ).bind(newId(), opId, hash, t + 86400, t).run();
  return { opId, raw, cookie: `__Host-gf_session=${raw}` };
}

/**
 * Put an address under a live sanction, the way confirmNoShow would.
 *
 * Keyed on login_email since 0038, which is the whole of the guarantee this
 * file's suspension tests are about: a sanction has to hang on something the
 * sanctioned person cannot simply retype into a form.
 */
async function suspend(loginEmail: string, opts: { banned?: boolean } = {}) {
  const t = now();
  await env.DB.prepare(
    `INSERT INTO customer_standing
       (login_email,no_show_strikes,suspended_until,banned_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?)`,
  ).bind(loginEmail, opts.banned ? 4 : 1, opts.banned ? null : t + 3 * 86400,
    opts.banned ? t : null, t, t).run();
}

// ---------------------------------------------------------------------------
describe('with no email provider, the front door is shut and says so', () => {
  it('refuses to issue a code at all', async () => {
    const res = await call('POST', '/api/customer/auth/code', { body: { email: EMAIL } });
    expect(res.status).toBe(503);
    const b = await res.json() as { code: string; error: string };
    expect(b.code).toBe('email_not_configured');
    // Names the state exactly rather than blaming the caller's address.
    expect(b.error).toContain('no email provider is configured');
  });

  it('writes no code row, so an unconfigured deployment cannot be walked', async () => {
    await call('POST', '/api/customer/auth/code', { body: { email: EMAIL } });
    expect(await count('SELECT COUNT(*) AS n FROM customer_login_codes')).toBe(0);
  });

  it('lets nobody in through the checkout instead', async () => {
    // The refusal has to hold on the other door as well, or "fails closed"
    // means "fails closed on the route somebody remembered".
    const { gapId } = await seed();
    const res = await call('POST', '/api/public/orders', {
      body: orderBody(gapId, { code: '123456' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'bad_code' });
    expect(await count('SELECT COUNT(*) AS n FROM orders')).toBe(0);
  });

  it('says so on the public booking-state route before anyone fills a basket in', async () => {
    const res = await call('GET', '/api/public/booking-state');
    const b = await res.json() as Record<string, unknown>;
    expect(b.account_required).toBe(true);
    expect(b.sms_ready).toBe(false);
    expect(b.guest_link_works).toBe(true);
    // Payment is not switched on, so no card is asked for today.
    expect(b.payments_live).toBe(false);
    expect(b.card_required).toBe(false);
  });

  it('says the door is OPEN once a provider is set, which it did not', async () => {
    // THE CASE NOTHING COVERED, AND THE BUG THAT LIVED IN THE GAP.
    //
    // The test above only ever ran with nothing configured, where every flag is
    // false and a wrong flag looks exactly like a right one. This route asked
    // smsConfigured() until it was caught, and after the code moved to email no
    // deployment has a Telnyx key — so on a correctly-configured production
    // site it told every visitor booking was unavailable, with a note saying no
    // email provider was set up, while the checkout worked perfectly.
    //
    // A readiness flag that is wrong in the reassuring-looking direction is
    // worse than no flag: it turns people away from a working door. So the
    // configured case is pinned, and it is pinned with the provider the door
    // actually uses.
    configureSms(env);
    const res = await call('GET', '/api/public/booking-state');
    const b = await res.json() as Record<string, unknown>;
    expect(b.sms_ready).toBe(true);
    expect(b.sms_note).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('creating an account', () => {
  it('emails a six-digit code to the address and nowhere else', async () => {
    configureSms(env);
    const { messages } = await captureSms(() =>
      call('POST', '/api/customer/auth/code', { body: { email: EMAIL } }));
    expect(messages).toHaveLength(1);
    expect(messages[0]!.to).toBe(EMAIL);
    expect(/\b\d{6}\b/.test(messages[0]!.body)).toBe(true);
    // No link in a sign-in message: a tappable URL in one is the exact shape
    // of the phishing mail this product would be teaching people to trust.
    expect(messages[0]!.body).not.toContain('http');
  });

  it('never returns the code to whoever asked for it', async () => {
    configureSms(env);
    const { result } = await captureSms(() =>
      call('POST', '/api/customer/auth/code', { body: { email: EMAIL } }));
    const b = await result.json() as Record<string, unknown>;
    expect(b.code).toBeUndefined();
    expect(b.expires_in).toBe(CUSTOMER_AUTH.CODE_TTL);
  });

  it('stores no code anybody could read out of the database', async () => {
    configureSms(env);
    const { messages } = await captureSms(() =>
      call('POST', '/api/customer/auth/code', { body: { email: EMAIL } }));
    const code = /(\d{6})/.exec(messages[0]!.body)![1]!;
    const row = await env.DB.prepare(
      'SELECT code_hash FROM customer_login_codes').first<{ code_hash: string }>();
    expect(row!.code_hash).not.toContain(code);
    expect(row!.code_hash).toHaveLength(64);
  });

  it('answers identically for an address that has an account and one that does not', async () => {
    configureSms(env);
    await signIn();
    const known = await captureSms(() =>
      call('POST', '/api/customer/auth/code', { body: { email: EMAIL } }));
    const stranger = await captureSms(() =>
      call('POST', '/api/customer/auth/code', { body: { email: 'nobody@mailbox.test' } }));
    expect(known.result.status).toBe(stranger.result.status);
    expect(await known.result.json()).toEqual(await stranger.result.json());
  });

  it('creates the account on the first verify and finds it on the second', async () => {
    const first = await signIn(EMAIL, { first_name: 'Rosa' });
    const second = await signIn();
    expect(second.accountId).toBe(first.accountId);
    expect(await count('SELECT COUNT(*) AS n FROM customer_accounts')).toBe(1);
    const me = await call('GET', '/api/customer/me', { cookie: second.cookie });
    expect(me.status).toBe(200);
    expect((await me.json() as any).account.first_name).toBe('Rosa');
  });

  it('keeps a second device signed in without disturbing the first', async () => {
    // A new device is a new session, not a replacement. Somebody who signs in
    // on a laptop must not be signed out on the phone in their pocket.
    const phoneDevice = await signIn();
    const laptop = await signIn();
    expect(laptop.cookie).not.toBe(phoneDevice.cookie);
    for (const c of [phoneDevice.cookie, laptop.cookie]) {
      expect((await call('GET', '/api/customer/me', { cookie: c })).status).toBe(200);
    }
    expect(await count('SELECT COUNT(*) AS n FROM customer_sessions')).toBe(2);
  });

  it('gives a customer a session that outlives an operator\'s by design', async () => {
    // Decided rather than inherited: an operator works in a dashboard daily,
    // a customer books twice a year, and thirty days would mean the account
    // exists only in the sense that it is re-created on every use.
    const me = await signIn();
    const row = await env.DB.prepare(
      'SELECT expires_at FROM customer_sessions').first<{ expires_at: number }>();
    expect(row!.expires_at - now()).toBeGreaterThan(300 * 86400);
    expect(CUSTOMER_AUTH.SESSION_TTL).toBe(365 * 86400);
    expect(me.cookie).toContain('__Host-sf_customer=');
  });
});

// ---------------------------------------------------------------------------
describe('the code itself', () => {
  it('dies after five wrong guesses, and the right one no longer works', async () => {
    configureSms(env);
    const { messages } = await captureSms(() =>
      call('POST', '/api/customer/auth/code', { body: { email: EMAIL } }));
    const real = /(\d{6})/.exec(messages[0]!.body)![1]!;
    const wrong = real === '000000' ? '111111' : '000000';

    for (let i = 0; i < CUSTOMER_AUTH.MAX_CODE_ATTEMPTS; i++) {
      const res = await call('POST', '/api/customer/auth/verify',
        { body: { email: EMAIL, code: wrong } });
      expect(res.status).toBe(400);
    }
    const after = await call('POST', '/api/customer/auth/verify',
      { body: { email: EMAIL, code: real } });
    expect(after.status).toBe(400);
    expect(await count('SELECT COUNT(*) AS n FROM customer_sessions')).toBe(0);
  });

  it('says exactly the same thing however it failed', async () => {
    configureSms(env);
    const { messages } = await captureSms(() =>
      call('POST', '/api/customer/auth/code', { body: { email: EMAIL } }));
    const real = /(\d{6})/.exec(messages[0]!.body)![1]!;

    const wrongDigits = await call('POST', '/api/customer/auth/verify',
      { body: { email: EMAIL, code: real === '000000' ? '111111' : '000000' } });
    const wrongShape = await call('POST', '/api/customer/auth/verify',
      { body: { email: EMAIL, code: 'abc' } });
    const noCodeAtAll = await call('POST', '/api/customer/auth/verify',
      { body: { email: 'stranger@mailbox.test', code: '123456' } });

    const bodies = await Promise.all(
      [wrongDigits, wrongShape, noCodeAtAll].map((r) => r.json() as Promise<any>));
    // A caller who can tell these apart has an oracle for guessing and a way
    // to ask which mailboxes are mid-sign-in.
    expect(new Set(bodies.map((b) => b.error)).size).toBe(1);
    expect(new Set(bodies.map((b) => b.code)).size).toBe(1);
  });

  it('works once and not twice', async () => {
    const me = await signIn();
    const replay = await call('POST', '/api/customer/auth/verify',
      { body: { email: EMAIL, code: me.code } });
    expect(replay.status).toBe(400);
  });

  it('is dead once it has expired', async () => {
    configureSms(env);
    const { messages } = await captureSms(() =>
      call('POST', '/api/customer/auth/code', { body: { email: EMAIL } }));
    const real = /(\d{6})/.exec(messages[0]!.body)![1]!;
    await env.DB.prepare('UPDATE customer_login_codes SET expires_at = ?')
      .bind(now() - 1).run();
    const res = await call('POST', '/api/customer/auth/verify',
      { body: { email: EMAIL, code: real } });
    expect(res.status).toBe(400);
  });

  it('kills the previous code when a new one is sent', async () => {
    // Otherwise asking for three codes buys fifteen guesses instead of five
    // and the per-code ceiling stops meaning what it says.
    configureSms(env);
    const first = await captureSms(() =>
      call('POST', '/api/customer/auth/code', { body: { email: EMAIL } }));
    const second = await captureSms(() =>
      call('POST', '/api/customer/auth/code', { body: { email: EMAIL } }));
    const oldCode = /(\d{6})/.exec(first.messages[0]!.body)![1]!;
    const newCode = /(\d{6})/.exec(second.messages[0]!.body)![1]!;

    const stale = await call('POST', '/api/customer/auth/verify',
      { body: { email: EMAIL, code: oldCode } });
    expect(stale.status).toBe(400);
    const fresh = await call('POST', '/api/customer/auth/verify',
      { body: { email: EMAIL, code: newCode } });
    expect(fresh.status).toBe(200);
  });

  it('cannot be replayed against a different address', async () => {
    // The address is inside the digest, not merely beside it.
    configureSms(env);
    const { messages } = await captureSms(() =>
      call('POST', '/api/customer/auth/code', { body: { email: EMAIL } }));
    const real = /(\d{6})/.exec(messages[0]!.body)![1]!;
    await captureSms(() =>
      call('POST', '/api/customer/auth/code', { body: { email: 'other@mailbox.test' } }));
    const res = await call('POST', '/api/customer/auth/verify',
      { body: { email: 'other@mailbox.test', code: real } });
    expect(res.status).toBe(400);
  });

  it('stops somebody being used as a mail cannon at a stranger\'s mailbox', async () => {
    configureSms(env);
    const results: number[] = [];
    await captureSms(async () => {
      for (let i = 0; i < 5; i++) {
        const res = await call('POST', '/api/customer/auth/code', {
          // A different address every time, which is what a botnet has and a
          // per-address limit therefore cannot see. The mailbox being aimed at
          // is the thing the attacker cannot vary, so that is what is counted.
          body: { email: EMAIL }, ip: `198.51.100.${i}`,
        });
        results.push(res.status);
      }
    });
    expect(results.slice(0, 3)).toEqual([200, 200, 200]);
    expect(results.slice(3)).toEqual([429, 429]);
  });
});

// ---------------------------------------------------------------------------
describe('booking needs an account', () => {
  it('refuses a checkout with no account and writes nothing at all', async () => {
    const { gapId } = await seed();
    const res = await call('POST', '/api/public/orders', { body: orderBody(gapId) });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'account_required' });
    expect(await count('SELECT COUNT(*) AS n FROM orders')).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM appointments')).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM threads')).toBe(0);
    expect(await count(
      "SELECT COUNT(*) AS n FROM gaps WHERE id = ? AND status = 'open'", gapId)).toBe(1);
  });

  it('books for a signed-in customer and stamps the order with the account', async () => {
    const { gapId } = await seed();
    const me = await signIn();
    const res = await call('POST', '/api/public/orders',
      { cookie: me.cookie, body: orderBody(gapId) });
    expect(res.status).toBe(201);
    const order = await env.DB.prepare(
      'SELECT customer_account_id, login_email, phone_e164, status FROM orders').first<any>();
    expect(order.customer_account_id).toBe(me.accountId);
    // The proved address is stamped on the order, because that is what a
    // no-show months from now has to find the person by.
    expect(order.login_email).toBe(EMAIL);
    expect(order.phone_e164).toBe(E164);
    // No money has moved and none can. 'pending' is the honest state.
    expect(order.status).toBe('pending');
  });

  it('creates the account and the booking in one request', async () => {
    // The owner's requirement: they sign up at the same moment they pay, not
    // in a separate journey beforehand.
    const { gapId } = await seed();
    configureSms(env);
    const { messages } = await captureSms(() =>
      call('POST', '/api/customer/auth/code', { body: { email: EMAIL } }));
    const code = /(\d{6})/.exec(messages[0]!.body)![1]!;

    const res = await call('POST', '/api/public/orders',
      { body: orderBody(gapId, { code }) });
    expect(res.status).toBe(201);
    expect(res.headers.get('set-cookie')).toContain('__Host-sf_customer=');
    expect(await count('SELECT COUNT(*) AS n FROM customer_accounts')).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM orders')).toBe(1);
  });

  it('takes the number off the account and not out of the form', async () => {
    // The number is a contact detail rather than an identity now, but it is
    // still the account's own and not whatever was typed into this basket:
    // an operator ringing the doorbell should reach the person who booked.
    const { gapId } = await seed();
    const me = await signIn();
    const res = await call('POST', '/api/public/orders', {
      cookie: me.cookie,
      body: orderBody(gapId, { phone: '(818) 555-0999' }),
    });
    expect(res.status).toBe(201);
    const order = await env.DB.prepare('SELECT phone_e164 FROM orders').first<any>();
    expect(order.phone_e164).toBe(E164);
  });

  it('needs one for an instant request too, because an accepted one is a booking', async () => {
    await seed();
    const res = await call('POST', '/api/public/online/requests', {
      body: { operator_id: OP, guest_name: 'Rosa', email: EMAIL },
    });
    expect(res.status).toBe(401);
    expect(await count('SELECT COUNT(*) AS n FROM instant_requests')).toBe(0);
  });

  it('still lets anybody price a basket without one', async () => {
    // Looking, comparing and changing your mind are the whole product. A
    // sign-in wall in front of pricing is the friction this design avoids.
    const { gapId } = await seed();
    const res = await call('POST', '/api/public/orders/price', {
      body: { items: [{ gap_id: gapId, service_ids: ['svc-wash'] }] },
    });
    expect(res.status).toBe(200);
    expect((await res.json() as any).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('the booking form that works without JavaScript', () => {
  /** The same post a browser with no JavaScript makes. */
  const post = (gapId: string, fields: Record<string, string>, cookie?: string) =>
    worker.fetch(new Request(`${BASE}/book/${gapId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'cf-connecting-ip': '203.0.113.8',
        ...(cookie ? { cookie } : {}),
      },
      body: new URLSearchParams({
        first_name: 'Rosa', email: EMAIL, phone: E164,
        address_line: '15200 Ventura Blvd', postcode: '91403', ...fields,
      }).toString(),
    }), env, {} as ExecutionContext);

  it('asks for the code and holds everything already typed', async () => {
    const { gapId } = await seed();
    configureSms(env);
    const { result, messages } = await captureSms(() => post(gapId, {}));
    expect(result.status).toBe(200);
    const page = await result.text();
    expect(page).toContain('Confirm your email');
    // Nothing is booked yet and the opening is still there.
    expect(await count('SELECT COUNT(*) AS n FROM appointments')).toBe(0);
    // The address is carried into the second post rather than asked for twice.
    expect(page).toContain('value="15200 Ventura Blvd"');
    expect(messages).toHaveLength(1);
  });

  it('books on the second post and signs the device in', async () => {
    const { gapId } = await seed();
    configureSms(env);
    const { messages } = await captureSms(() => post(gapId, {}));
    const code = /(\d{6})/.exec(messages[0]!.body)![1]!;
    const res = await post(gapId, { code });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/^\/c\//);
    expect(res.headers.get('set-cookie')).toContain('__Host-sf_customer=');
    expect(await count('SELECT COUNT(*) AS n FROM appointments')).toBe(1);
  });

  it('books in one post for a device that is already signed in', async () => {
    const { gapId } = await seed();
    const me = await signIn();
    const res = await post(gapId, {}, me.cookie);
    expect(res.status).toBe(303);
    expect(await count('SELECT COUNT(*) AS n FROM appointments')).toBe(1);
  });

  it('says why nothing can be booked when no code can be sent', async () => {
    const { gapId } = await seed();
    const res = await post(gapId, {});
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('no email provider is configured');
    expect(await count('SELECT COUNT(*) AS n FROM appointments')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('the two kinds of session never satisfy each other', () => {
  it('refuses an operator route to a customer session', async () => {
    const me = await signIn();
    expect((await call('GET', '/api/me', { cookie: me.cookie })).status).toBe(401);
    expect((await call('GET', '/api/standing', { cookie: me.cookie })).status).toBe(401);
  });

  it('refuses a customer route to an operator session', async () => {
    const op = await signInOperator();
    expect((await call('GET', '/api/customer/me', { cookie: op.cookie })).status).toBe(401);
    expect((await call('GET', '/api/customer/bookings', { cookie: op.cookie })).status).toBe(401);
  });

  it('refuses an operator token pasted into the customer cookie', async () => {
    // The tables are the first wall. The digest domains are the second, and
    // the second is the one that survives somebody deciding both sides should
    // share a cookie name.
    const op = await signInOperator();
    const res = await call('GET', '/api/customer/me', { cookie: `__Host-sf_customer=${op.raw}` });
    expect(res.status).toBe(401);
  });

  it('refuses a customer token pasted into the operator cookie', async () => {
    const me = await signIn();
    const token = me.cookie.split('=')[1]!;
    const res = await call('GET', '/api/me', { cookie: `__Host-gf_session=${token}` });
    expect(res.status).toBe(401);
  });

  it('lets one browser hold both at once', async () => {
    const op = await signInOperator();
    const me = await signIn();
    const both = `${op.cookie}; ${me.cookie}`;
    expect((await call('GET', '/api/me', { cookie: both })).status).toBe(200);
    expect((await call('GET', '/api/customer/me', { cookie: both })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe('a suspension follows the person', () => {
  it('blocks a booking made through a brand-new account on a brand-new device', async () => {
    const { gapId } = await seed();
    await suspend(EMAIL);
    // A fresh account: no account row existed for this address before the
    // sanction, and the sign-up is happening after it. A different mobile
    // number changes nothing, because no sanction hangs on a number.
    const me = await signIn(EMAIL, { phone: '+18185550777' });
    const res = await call('POST', '/api/public/orders', {
      cookie: me.cookie, body: orderBody(gapId, { phone: '+18185550777' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'suspended' });
    expect(await count('SELECT COUNT(*) AS n FROM orders')).toBe(0);
  });

  it('is not escaped by typing a different number into the checkout', async () => {
    // Standing hangs on the proved ADDRESS since 0038, so the number in the
    // form is not a lever any more — which is what makes this stronger than it
    // was rather than weaker. The number was the identity when this test was
    // written, and a suspended person retyping one is exactly what the
    // migration moved the key away from.
    const { gapId } = await seed();
    await suspend(EMAIL, { banned: true });
    const me = await signIn();
    const res = await call('POST', '/api/public/orders', {
      cookie: me.cookie, body: orderBody(gapId, { phone: '(818) 555-0999' }),
    });
    expect(res.status).toBe(409);
  });

  it('is not escaped by closing the account and signing up again', async () => {
    const { gapId } = await seed();
    await suspend(EMAIL);
    const first = await signIn();

    const closed = await call('POST', '/api/customer/close', { cookie: first.cookie });
    expect(closed.status).toBe(200);
    // The standing row is untouched by closure. If it were not, "close and
    // start again" would be the way round the whole ladder.
    expect(await count('SELECT COUNT(*) AS n FROM customer_standing')).toBe(1);

    const again = await signIn();
    expect(again.accountId).not.toBe(first.accountId);
    const res = await call('POST', '/api/public/orders',
      { cookie: again.cookie, body: orderBody(gapId) });
    expect(res.status).toBe(409);
  });

  it('is told at sign-in rather than discovered at checkout', async () => {
    await suspend(EMAIL);
    configureSms(env);
    const { messages } = await captureSms(() =>
      call('POST', '/api/customer/auth/code', { body: { email: EMAIL } }));
    const code = /(\d{6})/.exec(messages[0]!.body)![1]!;
    const res = await call('POST', '/api/customer/auth/verify',
      { body: { email: EMAIL, code } });
    // Signing in is allowed: a suspended customer can still read their
    // bookings and answer a business. Only booking is refused.
    expect(res.status).toBe(200);
    expect((await res.json() as any).standing.blocked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('closing an account, and being erased from one', () => {
  it('revokes every session and empties the contact details', async () => {
    const phoneDevice = await signIn();
    const laptop = await signIn();
    await call('POST', '/api/customer/close', { cookie: phoneDevice.cookie });
    for (const c of [phoneDevice.cookie, laptop.cookie]) {
      expect((await call('GET', '/api/customer/me', { cookie: c })).status).toBe(401);
    }
    const row = await env.DB.prepare(
      'SELECT phone_e164, closed_at FROM customer_accounts').first<any>();
    expect(row.phone_e164).toBeNull();
    expect(row.closed_at).toBeGreaterThan(0);
  });

  it('keeps the bookings, because an order is a record between two people', async () => {
    const { gapId } = await seed();
    const me = await signIn();
    await call('POST', '/api/public/orders', { cookie: me.cookie, body: orderBody(gapId) });
    await call('POST', '/api/customer/close', { cookie: me.cookie });
    expect(await count('SELECT COUNT(*) AS n FROM orders')).toBe(1);
  });

  it('erases through the account exactly as the guest link does', async () => {
    const { gapId } = await seed();
    const me = await signIn();
    const placed = await call('POST', '/api/public/orders',
      { cookie: me.cookie, body: orderBody(gapId) });
    expect(placed.status).toBe(201);

    const res = await call('DELETE', '/api/customer/data', { cookie: me.cookie });
    expect(res.status).toBe(200);
    const order = await env.DB.prepare(
      'SELECT guest_name, phone_e164, address_line FROM orders').first<any>();
    expect(order.phone_e164).toBeNull();
    expect(order.address_line).toBeNull();
    expect(order.guest_name).toBe('Removed');
    expect(await count('SELECT COUNT(*) AS n FROM threads')).toBe(0);
    const account = await env.DB.prepare(
      'SELECT login_email, phone_e164, closed_at FROM customer_accounts').first<any>();
    // The identity goes with the rest of it, which is also what releases the
    // address: the unique index treats NULLs as distinct, so the same person
    // can sign up again one day.
    expect(account.login_email).toBeNull();
    expect(account.phone_e164).toBeNull();
    expect(account.closed_at).toBeGreaterThan(0);
  });

  it('keeps a live sanction through an erasure', async () => {
    await suspend(EMAIL, { banned: true });
    const { gapId } = await seed();
    const me = await signIn();
    // The booking is refused, so erase from an account with nothing but itself.
    expect((await call('POST', '/api/public/orders',
      { cookie: me.cookie, body: orderBody(gapId) })).status).toBe(409);

    const res = await call('DELETE', '/api/customer/data', { cookie: me.cookie });
    expect((await res.json() as any).standing_retained).toBe(true);
    expect(await count('SELECT COUNT(*) AS n FROM customer_standing')).toBe(1);
  });

  it('leaves the guest link and its erasure working exactly as before', async () => {
    const { gapId } = await seed();
    const me = await signIn();
    const placed = await call('POST', '/api/public/orders',
      { cookie: me.cookie, body: orderBody(gapId) });
    const token = (await placed.json() as any).thread_token as string;

    // No cookie at all: this is the phone that has never been signed in.
    const read = await call('GET', `/api/public/threads/${token}`);
    expect(read.status).toBe(200);
    const erase = await call('DELETE', `/api/public/threads/${token}/data`);
    expect(erase.status).toBe(200);
    expect(await count('SELECT COUNT(*) AS n FROM threads')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('the card, which is a seam and not a fiction', () => {
  it('refuses anything shaped like a card number', async () => {
    const me = await signIn();
    const res = await call('POST', '/api/customer/payment-method', {
      cookie: me.cookie, body: { ref: '4242424242424242' },
    });
    expect(res.status).toBe(400);
    expect(await count(
      'SELECT COUNT(*) AS n FROM customer_accounts WHERE payment_ref IS NOT NULL')).toBe(0);
  });

  it('refuses a value that is not a processor handle', async () => {
    const me = await signIn();
    const res = await call('POST', '/api/customer/payment-method', {
      cookie: me.cookie, body: { ref: '1234-5678' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'not_a_ref' });
  });

  it('stores a reference and never hands it back', async () => {
    const me = await signIn();
    const saved = await call('POST', '/api/customer/payment-method', {
      cookie: me.cookie, body: { ref: 'pm_1NotARealReference', brand: 'Visa', last4: '4242' },
    });
    expect(saved.status).toBe(200);
    const meRes = await call('GET', '/api/customer/me', { cookie: me.cookie });
    const account = (await meRes.json() as any).account;
    expect(account.has_card).toBe(true);
    expect(account.payment_last4).toBe('4242');
    expect(JSON.stringify(account)).not.toContain('pm_1NotARealReference');
  });

  it('asks for no card while payment is switched off', async () => {
    const { gapId } = await seed();
    const me = await signIn();
    const res = await call('POST', '/api/public/orders',
      { cookie: me.cookie, body: orderBody(gapId) });
    expect(res.status).toBe(201);
    const order = await env.DB.prepare('SELECT payment_ref FROM orders').first<any>();
    // Nothing pretends a card was taken, because nothing can take one.
    expect(order.payment_ref).toBeNull();
  });

  it('requires one the day payment is switched on', async () => {
    const { gapId } = await seed();
    const me = await signIn();
    env.STRIPE_WEBHOOK_SECRET = 'whsec_pretend';

    const refused = await call('POST', '/api/public/orders',
      { cookie: me.cookie, body: orderBody(gapId) });
    expect(refused.status).toBe(402);
    expect(await refused.json()).toMatchObject({ code: 'card_required' });
    expect(await count('SELECT COUNT(*) AS n FROM orders')).toBe(0);

    const placed = await call('POST', '/api/public/orders', {
      cookie: me.cookie,
      body: orderBody(gapId, { card_ref: 'pm_1NotARealReference', card_last4: '4242' }),
    });
    expect(placed.status).toBe(201);
    const order = await env.DB.prepare(
      'SELECT payment_ref, payment_last4 FROM orders').first<any>();
    expect(order.payment_ref).toBe('pm_1NotARealReference');
    expect(order.payment_last4).toBe('4242');
  });
});

// ---------------------------------------------------------------------------
describe('what somebody did before they had an account', () => {
  it('claims their earlier bookings the first time the address is proved', async () => {
    const t = now();
    const orderId = newId();
    await env.DB.prepare(
      `INSERT INTO orders (id,status,guest_name,login_email,phone_e164,currency,total_cents,
         created_at,updated_at)
       VALUES (?,'pending','Rosa',?,?, 'USD', 4900, ?, ?)`,
    ).bind(orderId, EMAIL, E164, t, t).run();

    const me = await signIn();
    const row = await env.DB.prepare(
      'SELECT customer_account_id FROM orders WHERE id = ?').bind(orderId).first<any>();
    expect(row.customer_account_id).toBe(me.accountId);

    const list = await call('GET', '/api/customer/bookings', { cookie: me.cookie });
    expect(list.status).toBe(200);
  });

  it('claims nothing belonging to a different address', async () => {
    // And nothing belonging to somebody who merely typed the same mobile
    // number into a booking form: since 0038 the number on an order is a claim
    // about a phone, and matching on it would hand a stranger's bookings and
    // home address to anybody willing to type it.
    const t = now();
    await env.DB.prepare(
      `INSERT INTO orders (id,status,guest_name,login_email,phone_e164,currency,total_cents,
         created_at,updated_at)
       VALUES (?,'pending','Someone Else',?,?,'USD',4900,?,?)`,
    ).bind(newId(), 'someone.else@mailbox.test', E164, t, t).run();
    await signIn();
    expect(await count(
      'SELECT COUNT(*) AS n FROM orders WHERE customer_account_id IS NOT NULL')).toBe(0);
  });
});
