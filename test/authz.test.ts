import { describe, expect, it, beforeEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import { fakeKV, type FakeKV } from './kv';
import worker from '../src/index';
import { maskInstantRequest } from '../src/lib/online';
import type { Env } from '../src/types';
import { addJobPhoto } from '../src/lib/proof';
import { createWatch } from '../src/lib/alerts';
import { newId, newToken, now, sha256 } from '../src/lib/util';

/**
 * Who is allowed to call what, and what comes back when they do.
 *
 * Every case here failed before the change it guards. They are grouped by the
 * thing that was wrong rather than by route, because several of these were one
 * mistake showing up in two places.
 */

const BASE = 'https://gap.test';
let env: Env;
let photos: FakeKV;
/** The backing map, named as it was when this was a fake R2 bucket. */
let stored: FakeKV['entries'];

function makeReq(method: string, path: string, opts: {
  body?: unknown; cookie?: string; ip?: string;
} = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers['cookie'] = opts.cookie;
  headers['cf-connecting-ip'] = opts.ip ?? '203.0.113.9';
  return new Request(`${BASE}${path}`, {
    method, headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

const call = (method: string, path: string, opts?: Parameters<typeof makeReq>[2]) =>
  worker.fetch(makeReq(method, path, opts), env, {} as ExecutionContext);

/** Create an operator directly and mint a session, bypassing email. */
async function signIn(email: string, businessName = 'A Business') {
  const t = now();
  const opId = newId();
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,timezone,country,currency,
       location_mode,fill_model,sms_mode,plan,created_at,updated_at)
     VALUES (?,?,?, 'America/Los_Angeles','US','USD','mobile','both','device','active',?,?)`,
  ).bind(opId, email, businessName, t, t).run();

  const raw = `sess-${opId}`;
  const digest = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(`${raw}:${env.SESSION_PEPPER}`));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  await env.DB.prepare(
    `INSERT INTO sessions (id,operator_id,token_hash,expires_at,created_at)
     VALUES (?,?,?,?,?)`,
  ).bind(newId(), opId, hash, t + 86400, t).run();

  return { opId, cookie: `__Host-gf_session=${raw}` };
}

/** A finished booking for `opId`, with the customer's details on the order. */
async function bookingFor(opId: string, phone = '+13105550147') {
  const t = now();
  const orderId = newId(); const itemId = newId();
  await env.DB.prepare(
    `INSERT INTO orders (id,status,guest_name,phone_e164,email,address_line,postcode,
       total_cents,currency,created_at,updated_at)
     VALUES (?, 'confirmed','Jane Homeowner',?,'jane@example.com','12 Private Rd','90210',
       10000,'USD',?,?)`,
  ).bind(orderId, phone, t, t).run();
  await env.DB.prepare(
    `INSERT INTO order_items (id,order_id,operator_id,starts_at,ends_at,duration_seconds,
       price_cents,created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).bind(itemId, orderId, opId, t - 7200, t - 3600, 3600, 10000, t).run();
  return { orderId, itemId };
}

/** A one-pixel PNG, so cleanImageUpload has real bytes to sniff. */
function pngFile(): File {
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0x90, 0x77, 0x53, 0xde,
    0, 0, 0, 12, 0x49, 0x44, 0x41, 0x54,
    0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00,
    0x18, 0xdd, 0x8d, 0xb0,
    0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
  return new File([png], 'p.png', { type: 'image/png' });
}

beforeEach(() => {
  photos = fakeKV();
  stored = photos.entries;
  env = { ...makeEnv(ALL_MIGRATIONS), PHOTOS: photos } as unknown as Env;
});

// ---------------------------------------------------------------------------
describe('the moderation queue is not open to every business on the site', () => {
  /**
   * These two routes read every operator's disputes and decide them. A session
   * used to be the whole check, which meant any signed-up business — and
   * anybody at all, since /demo hands out a session with no email and no
   * password — could read other people's customers by name and phone number
   * and suspend a competitor in one POST.
   */
  async function openReport(againstOpId: string) {
    const { itemId } = await bookingFor(againstOpId);
    const id = newId(); const t = now();
    await env.DB.prepare(
      `INSERT INTO no_show_reports (id,order_item_id,against,operator_id,phone_e164,
         note,status,created_at,updated_at)
       VALUES (?,?, 'operator',?, '+13105550147','never showed','open',?,?)`,
    ).bind(id, itemId, againstOpId, t, t).run();
    return id;
  }

  it('refuses the queue to an ordinary signed-in operator', async () => {
    const victim = await signIn('victim@example.com', 'Victim Plumbing');
    await openReport(victim.opId);
    const nosey = await signIn('nosey@example.com');

    const res = await call('GET', '/api/admin/no-shows', { cookie: nosey.cookie });
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain('3105550147');
  });

  it('refuses the flag report to an ordinary signed-in operator', async () => {
    const nosey = await signIn('nosey@example.com');
    expect((await call('GET', '/api/admin/flags', { cookie: nosey.cookie })).status).toBe(404);
  });

  it('will not let one operator suspend another', async () => {
    const victim = await signIn('victim@example.com', 'Victim Plumbing');
    const reportId = await openReport(victim.opId);
    const rival = await signIn('rival@example.com');

    const res = await call('POST', `/api/admin/no-shows/${reportId}`, {
      cookie: rival.cookie, body: { decision: 'confirmed' },
    });
    expect(res.status).toBe(404);

    const row = await env.DB.prepare(
      `SELECT suspended_until, banned_at FROM operators WHERE id = ?`,
    ).bind(victim.opId).first<{ suspended_until: number | null; banned_at: number | null }>();
    expect(row?.suspended_until).toBeNull();
    expect(row?.banned_at).toBeNull();
  });

  it('still works for an operator on the admin allowlist', async () => {
    const victim = await signIn('victim@example.com', 'Victim Plumbing');
    const reportId = await openReport(victim.opId);
    const admin = await signIn('ops@roundtheway.app');
    env.ADMIN_EMAILS = ' OPS@roundtheway.app , someone@else.test ';

    const queue = await call('GET', '/api/admin/no-shows', { cookie: admin.cookie });
    expect(queue.status).toBe(200);
    expect((await queue.json() as any).reports).toHaveLength(1);

    const decided = await call('POST', `/api/admin/no-shows/${reportId}`, {
      cookie: admin.cookie, body: { decision: 'confirmed' },
    });
    expect(decided.status).toBe(200);
  });

  it('refuses when no allowlist is configured at all', async () => {
    const op = await signIn('anyone@example.com');
    env.ADMIN_EMAILS = '';
    expect((await call('GET', '/api/admin/flags', { cookie: op.cookie })).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
describe('private job photos have no public URL', () => {
  /**
   * proof.ts is explicit that these are the inside of somebody's house and
   * that every read is authorised. The public photo route took a raw key and
   * fetched it, and job_photos.r2_key is handed to both sides in the proof
   * summary — so the key that route needs was already in the operator's and
   * the customer's hands.
   */
  it('refuses a job-photo key on the public photo route', async () => {
    const op = await signIn('op@example.com');
    const { itemId } = await bookingFor(op.opId);
    const photo = await addJobPhoto(env, { operator_id: op.opId }, {
      order_item_id: itemId, stage: 'before', file: pngFile(),
    });

    expect(photo.r2_key.startsWith('j/')).toBe(true);
    expect(stored.has(photo.r2_key)).toBe(true);

    const res = await call('GET', `/api/public/photo/${encodeURIComponent(photo.r2_key)}`);
    expect(res.status).toBe(404);
  });

  it('still serves an operator portfolio photo', async () => {
    const key = 'w/some-operator/some-photo';
    photos.seed(key, 'image/jpeg', new Uint8Array([1, 2, 3]));
    expect((await call('GET', `/api/public/photo/${encodeURIComponent(key)}`)).status).toBe(200);
  });

  it('answers a private key that really exists exactly as it answers a missing one', async () => {
    photos.seed('j/op/item/real', 'image/jpeg', new Uint8Array([1, 2, 3]));
    const a = await call('GET', `/api/public/photo/${encodeURIComponent('j/op/item/real')}`);
    const b = await call('GET', `/api/public/photo/${encodeURIComponent('w/op/never-existed')}`);
    expect(a.status).toBe(404);
    expect(a.status).toBe(b.status);
    expect(await a.text()).toBe(await b.text());
  });
});

// ---------------------------------------------------------------------------
describe('a push subscription may only name a real push service', () => {
  /**
   * The stored endpoint is a URL the cron POSTs to, carrying a VAPID JWT this
   * deployment signed. Anything beginning https:// used to be accepted, which
   * made a throwaway watch token into an outbound-fetch primitive.
   */
  async function watchToken() {
    await env.DB.prepare(
      `INSERT INTO postal_codes (country_code, postal_code, place_name, lat, lng)
       VALUES ('US','91403','Sherman Oaks',34.15,-118.44)`,
    ).run();
    const { token } = await createWatch(env, { postcode: '91403', email: 'w@example.com' });
    return token;
  }

  const endpoints = (t: string) => `/api/public/watches/${t}/subscriptions`;
  const keys = { p256dh: 'BBBBBBBB', auth: 'AAAA' };

  it('refuses an internal address', async () => {
    const token = await watchToken();
    const res = await call('POST', endpoints(token), {
      body: { endpoint: 'https://192.168.1.1/admin', keys },
    });
    expect(res.status).toBe(400);
    const rows = await env.DB.prepare(`SELECT endpoint FROM push_subscriptions`).all();
    expect(rows.results ?? []).toHaveLength(0);
  });

  it('refuses a hostname that merely ends in a push service name', async () => {
    const token = await watchToken();
    const res = await call('POST', endpoints(token), {
      body: { endpoint: 'https://fcm.googleapis.com.evil.test/x', keys },
    });
    expect(res.status).toBe(400);
  });

  it('accepts a real one', async () => {
    const token = await watchToken();
    const res = await call('POST', endpoints(token), {
      body: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', keys },
    });
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
describe('contact details do not cross between the two sides', () => {
  it('cuts the surname off a review on the public reviews route', async () => {
    const op = await signIn('op@example.com');
    const { itemId } = await bookingFor(op.opId);
    const t = now();
    await env.DB.prepare(
      `INSERT INTO reviews (id,operator_id,order_item_id,author_name,rating,body,
         created_at,updated_at)
       VALUES (?,?,?, 'Marguerite Halloway', 5, 'Lovely job', ?,?)`,
    ).bind(newId(), op.opId, itemId, t, t).run();

    const res = await call('GET', `/api/public/reviews/${op.opId}`);
    const names = (await res.json() as any).reviews.map((r: any) => r.author_name);
    expect(names).toEqual(['Marguerite H.']);
  });

  it('masks the customer number and mailbox on a pending instant request', async () => {
    const op = await signIn('op@example.com');
    const t = now();
    await env.DB.prepare(
      `UPDATE operators SET online_until = ? WHERE id = ?`,
    ).bind(t + 3600, op.opId).run();
    await env.DB.prepare(
      `INSERT INTO instant_requests (id,operator_id,starts_at,duration_seconds,price_cents,
         currency,guest_name,phone_e164,email,address_line,status,expires_at,token_hash,
         created_at,updated_at)
       VALUES (?,?,?,?,?, 'USD','Jane','+13105550147','jane@example.com','12 Private Rd',
         'pending',?,?,?,?)`,
    ).bind(newId(), op.opId, t, 3600, 5000, t + 300, 'hash-x', t, t).run();

    const res = await call('GET', '/api/online/requests', { cookie: op.cookie });
    const text = await res.text();
    expect(text).not.toContain('3105550147');
    expect(text).not.toContain('jane@example.com');

    // AND THE ADDRESS DOES NOT SURVIVE, WHICH IS THE OPPOSITE OF WHAT THIS
    // TEST USED TO ASSERT.
    //
    // "They have to drive there" is true of a job somebody has TAKEN. This
    // request is pending: it is offered to every operator who happens to be
    // switched on, most of whom will never touch it, and handing each of them
    // a stranger's exact street line is the one piece of data in this product
    // with a person's front door in it. Every other doorstep is governed by
    // address_released_at; a pending request has no order item, so it had no
    // release rule at all and simply gave the address away.
    //
    // The postcode stays, because an operator has to judge whether it is worth
    // driving to before they accept.
    expect(text).not.toContain('12 Private Rd');
  });

  it('hands the address over once the job has actually been accepted', () => {
    // Through the mask directly rather than the route: pendingForOperator
    // selects `status = 'pending'` only, so an accepted request never comes
    // back from it. The rule being defended is the mask's, and this is where
    // it lives.
    const accepted = maskInstantRequest({
      status: 'accepted',
      phone_e164: '+13105550147',
      email: 'jane@example.com',
      address_line: '12 Private Rd',
      lat: 34.15101,
      lng: -118.44502,
      postcode: '91403',
    });
    // The operator who took it is the one driving, so they get the door. The
    // number and the mailbox still never cross — the app carries the messages.
    expect(accepted.address_line).toBe('12 Private Rd');
    expect(accepted.lat).toBe(34.15101);
    expect(accepted.phone_e164).not.toContain('3105550147');
    expect(accepted.email).not.toContain('jane@example.com');

    const pending = maskInstantRequest({
      status: 'pending',
      phone_e164: '+13105550147',
      email: 'jane@example.com',
      address_line: '12 Private Rd',
      lat: 34.15101,
      lng: -118.44502,
      postcode: '91403',
    });
    expect(pending.address_line).toBeNull();
    expect(pending.lat).toBeNull();
    expect(pending.lng).toBeNull();
    // The postcode stays either way: an operator has to judge whether it is
    // worth driving to before they can decide to accept.
    expect(pending.postcode).toBe('91403');
  });
});

// ---------------------------------------------------------------------------
describe('what an operator row is allowed to carry out of the API', () => {
  it('keeps the processor card reference out of /api/me', async () => {
    const op = await signIn('op@example.com');
    await env.DB.prepare(
      `UPDATE operators SET payment_ref = ?, payment_brand = 'visa', payment_last4 = '4242',
         payment_added_at = ? WHERE id = ?`,
    ).bind('pm_secret_reference_value', now(), op.opId).run();

    const me = await call('GET', '/api/me', { cookie: op.cookie });
    const body = await me.text();
    expect(body).not.toContain('pm_secret_reference_value');
    expect(body).not.toContain('payment_ref');
    // The parts a person needs to recognise their own card still come back.
    expect(body).toContain('4242');

    const patched = await call('PATCH', '/api/settings', {
      cookie: op.cookie, body: { business_name: 'Renamed' },
    });
    expect(await patched.text()).not.toContain('pm_secret_reference_value');
  });

  it('never puts a signed-in answer in a shared cache', async () => {
    const op = await signIn('op@example.com');
    const me = await call('GET', '/api/me', { cookie: op.cookie });
    expect(me.headers.get('cache-control')).toBe('no-store');
  });
});

// ---------------------------------------------------------------------------
describe('no card number reaches the database by any field', () => {
  it('refuses a PAN sent as the reference', async () => {
    const op = await signIn('op@example.com');
    const res = await call('POST', '/api/payment-method', {
      cookie: op.cookie, body: { ref: '4111 1111 1111 1111' },
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).code).toBe('raw_card');
  });

  it('refuses a PAN sent as the brand, which used to be stored verbatim', async () => {
    const op = await signIn('op@example.com');
    const res = await call('POST', '/api/payment-method', {
      cookie: op.cookie, body: { ref: 'pm_abc123', brand: '4111111111111111', last4: '1111' },
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).code).toBe('raw_card');

    const row = await env.DB.prepare(
      `SELECT payment_ref, payment_brand FROM operators WHERE id = ?`,
    ).bind(op.opId).first<{ payment_ref: string | null; payment_brand: string | null }>();
    expect(row?.payment_ref).toBeNull();
    expect(row?.payment_brand).toBeNull();
  });

  it('still accepts an ordinary processor reference', async () => {
    const op = await signIn('op@example.com');
    const res = await call('POST', '/api/payment-method', {
      cookie: op.cookie, body: { ref: 'pm_1PabcDEF', brand: 'visa', last4: '4242' },
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe('the unauthenticated endpoints that had no ceiling now have one', () => {
  it('bounds a walk over addresses on the standing lookup', async () => {
    // It asked about the number until migration 0038 and asks about the
    // address now, because that is what standing hangs on. The walk is the
    // same shape and so is the reason for the ceiling: anonymous, and it
    // answers a yes/no question about anybody the caller cares to type, which
    // over a list becomes "has this person been reported for missing
    // appointments" — a fact about them and not about us.
    let last = 0;
    for (let i = 0; i < 40; i++) {
      last = (await call('GET',
        `/api/public/standing?email=walker${i}%40mailbox.test`,
        { ip: '198.51.100.7' })).status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });

  it('bounds guessing at the session issuer', async () => {
    let last = 0;
    for (let i = 0; i < 40; i++) {
      last = (await call('POST', '/api/auth/verify', {
        body: { token: `guess-${i}` }, ip: '198.51.100.8',
      })).status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });

  /**
   * A walk over a token space carries a different token every time, so a
   * per-token bucket opens a fresh allowance for each guess and no ceiling is
   * ever reached. The address is the only thing the walk has in common with
   * itself, which is why every route in both token spaces is bucketed on it.
   *
   * PATCH on a watch is the one that was missed. It already had a ceiling —
   * sixty an hour, on the token, for the geocode behind an edit — and that is
   * exactly the shape that cannot see a walk.
   */
  const TOKEN_SPACE_ROUTES: Array<[string, string, unknown?]> = [
    ['GET', '/api/public/watches/'],
    ['DELETE', '/api/public/watches/'],
    ['PATCH', '/api/public/watches/', { label: 'x' }],
    ['GET', '/a/stop/'],
    // The offer opt-out, a second token space in the same shape: a link at the
    // bottom of an email, opened with no session, that turns something off. It
    // is deliberately not the watch unsubscribe above and does not share its
    // bucket — a walk over one would otherwise spend the other's allowance,
    // and the two spaces have different owners and different sizes.
    ['GET', '/a/stop-offers/'],
    ['GET', '/api/public/online/requests/'],
    ['DELETE', '/api/public/online/requests/'],
  ];

  for (const [method, prefix, payload] of TOKEN_SPACE_ROUTES) {
    it(`bounds a walk over the token space on ${method} ${prefix}:token`, async () => {
      // A different IP per route so the six do not share one bucket and pass
      // on each other's refusals.
      const ip = `198.51.100.${20 + TOKEN_SPACE_ROUTES.findIndex((r) => r[0] === method && r[1] === prefix)}`;
      let last = 0;
      for (let i = 0; i < 260; i++) {
        last = (await call(method, `${prefix}walk-${i}`,
          payload === undefined ? { ip } : { ip, body: payload })).status;
        if (last === 429) break;
      }
      expect(last).toBe(429);
    });
  }
});

// ---------------------------------------------------------------------------
// A business that keeps working is never mailed another link
// ---------------------------------------------------------------------------

describe('the operator session renews itself', () => {
  /**
   * WHY THIS IS WORTH A TEST AND NOT JUST A CONSTANT.
   *
   * The session was thirty days with no renewal, and nothing failed — it is an
   * omission rather than a bug, and an omission has no failing assertion to
   * find it. What it cost was invisible from the code: every listed business
   * was mailed a fresh sign-in link about once a month, out of an allowance of
   * a hundred emails a day shared with the codes that let new customers join.
   * A hundred businesses is three a day, for nothing.
   *
   * So the renewal is pinned from both ends: that using a session pushes its
   * expiry out, and that a session left alone past the window is still refused.
   * The second half is the one that stops "renew on use" quietly becoming
   * "never expires".
   */
  const DAY = 86400;

  /** A real operator with a session whose expiry we choose. */
  async function sessionAgedTo(expiresIn: number): Promise<string> {
    const { opId } = await signIn(`renew-${newId()}@example.com`);
    const token = newToken();
    await env.DB.prepare(
      `INSERT INTO sessions (id, operator_id, token_hash, user_agent, expires_at, created_at)
       VALUES (?,?,?,?,?,?)`,
    ).bind(newId(), opId, await sha256(`${token}:${env.SESSION_PEPPER}`), null,
      now() + expiresIn, now()).run();
    return token;
  }

  const expiryOf = (token: string) =>
    sha256(`${token}:${env.SESSION_PEPPER}`).then((h) => env.DB.prepare(
      `SELECT expires_at FROM sessions WHERE token_hash = ?`,
    ).bind(h).first<{ expires_at: number }>());

  it('pushes the expiry out when a stale session is used', async () => {
    // Two hundred days left of a year, so it is past the thirty-day floor.
    const token = await sessionAgedTo(200 * DAY);
    const before = (await expiryOf(token))!.expires_at;

    const res = await call('GET', '/api/me', { cookie: `__Host-gf_session=${token}` });
    expect(res.status).toBe(200);

    const after = (await expiryOf(token))!.expires_at;
    expect(after).toBeGreaterThan(before);
    // Back to a full year from now, not merely nudged.
    expect(after - now()).toBeGreaterThan(364 * DAY);
  });

  it('leaves a fresh session alone, so this is not a write per request', async () => {
    // Three hundred and sixty days left: inside the floor, nothing to do.
    const token = await sessionAgedTo(360 * DAY);
    const before = (await expiryOf(token))!.expires_at;
    expect((await call('GET', '/api/me', { cookie: `__Host-gf_session=${token}` })).status).toBe(200);
    expect((await expiryOf(token))!.expires_at).toBe(before);
  });

  it('still refuses one that ran out, because renewing is not never expiring', async () => {
    const token = await sessionAgedTo(-60);
    expect((await call('GET', '/api/me', { cookie: `__Host-gf_session=${token}` })).status).toBe(401);
  });
});
