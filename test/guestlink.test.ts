import { describe, expect, it, beforeEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import worker from '../src/index';
import type { Env } from '../src/types';
import { GUEST_LINK_LIMITS, sweepGuestLinkAttempts } from '../src/lib/guestlink';
import { placeOrder } from '../src/lib/orders';
import { saveOperatorCard } from '../src/lib/standing';
import { newId, newToken, now } from '../src/lib/util';

/**
 * Walking the guest token space.
 *
 * /c/:token is the only authority in this product held by somebody with no
 * account, and it carries a booking, an address, the photographs of the inside
 * of a house and the code that gets a stranger through the front door. The
 * hash in the database is not a defence against somebody trying tokens; it is
 * a defence against somebody who already has the database.
 */

const BASE = 'https://gap.test';
let env: Env;

const OP = 'op-guest';
const PREV = { lat: 34.1500, lng: -118.4490 };
const NEXT = { lat: 34.1520, lng: -118.4400 };
const NEAR = { lat: 34.1510, lng: -118.4450 };

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function call(method: string, path: string, opts: { ip?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.ip) headers['cf-connecting-ip'] = opts.ip;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return worker.fetch(new Request(`${BASE}${path}`, {
    method, headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  }), env, ctx);
}

async function seed() {
  env = makeEnv(ALL_MIGRATIONS) as unknown as Env;
  const n = now();
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,trade,timezone,country,currency,language,
       location_mode,fill_model,sms_mode,plan,accept_public_bookings,share_location,
       created_at,updated_at)
     VALUES (?,?,?, 'mobile car wash and detailing','America/Los_Angeles','US','USD','en',
       'mobile','both','device','active',1,1,?,?)`,
  ).bind(OP, 'g@x.com', 'Valley Detailing', n, n).run();
  await saveOperatorCard(env, OP, { ref: 'pm', brand: 'visa', last4: '4242' });
  await env.DB.prepare(
    `INSERT INTO services (id,operator_id,name,duration_seconds,price_cents,created_at,updated_at)
     VALUES ('s1',?, 'Full detail',3600,20000,?,?)`,
  ).bind(OP, n, n).run();
  await env.DB.prepare(
    `INSERT INTO postal_codes (country_code,postal_code,place_name,lat,lng,accuracy)
     VALUES ('US','91403','Sherman Oaks',?,?,6)`,
  ).bind(NEAR.lat, NEAR.lng).run();
}

/** A real booking, and the raw link its customer was given. */
async function booking() {
  const n = now();
  const gapId = newId();
  await env.DB.prepare(
    `INSERT INTO gaps (id,operator_id,starts_at,ends_at,prev_lat,prev_lng,next_lat,next_lng,
       baseline_drive_seconds,is_mobile,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,180,1,'open',?,?)`,
  ).bind(gapId, OP, n + 30 * 3600, n + 35 * 3600,
    PREV.lat, PREV.lng, NEXT.lat, NEXT.lng, n, n).run();

  const order = await placeOrder(env, {
    guest_name: 'Debra Dawson', phone: '(818) 555-0142',
    address_line: '15200 Ventura Blvd', postcode: '91403',
    items: [{ gap_id: gapId, service_ids: ['s1'] }],
  });
  return order.thread_token;
}

const attempts = (ip: string) => env.DB.prepare(
  `SELECT failures, window_started_at, locked_until FROM guest_link_attempts WHERE ip = ?`,
).bind(ip).first<{ failures: number; window_started_at: number; locked_until: number | null }>();

beforeEach(seed);

describe('a guest link that is being guessed at', () => {
  it('locks the caller out after a run of wrong links', async () => {
    const ip = '203.0.113.7';
    for (let i = 0; i < GUEST_LINK_LIMITS.MAX_FAILURES; i++) {
      const res = await call('GET', `/api/public/threads/${newToken()}`, { ip });
      // Every one of them says exactly what an unknown token has always said.
      // A caller who could tell the ninth refusal from the first has been
      // handed a counter to calibrate against.
      expect(res.status).toBe(404);
    }

    const res = await call('GET', `/api/public/threads/${newToken()}`, { ip });
    expect(res.status).toBe(429);
    const b = await res.json() as any;
    expect(b.code).toBe('link_locked');
    // A person caught by somebody else on their address is told when to come
    // back rather than left reloading into the wall.
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('shuts every guest route, not the one that happened to be guessed at', async () => {
    const ip = '203.0.113.8';
    for (let i = 0; i < GUEST_LINK_LIMITS.MAX_FAILURES; i++) {
      await call('GET', `/api/public/threads/${newToken()}`, { ip });
    }
    // The walk does not have to keep using the endpoint it started on, so the
    // gate is on the whole family of routes rather than on a handler.
    for (const [method, path] of [
      ['GET', `/api/public/threads/${newToken()}/code`],
      ['GET', `/api/public/threads/${newToken()}/reviewable`],
      ['POST', `/api/public/threads/${newToken()}/messages`],
      ['GET', `/api/public/threads/${newToken()}/pending`],
      ['GET', `/api/public/threads/${newToken()}/track`],
    ] as const) {
      const res = await call(method, path, { ip, body: method === 'POST' ? { body: 'hi' } : undefined });
      expect(res.status).toBe(429);
    }
  });

  it('counts the caller and not the token, which is the whole point', async () => {
    // The rate limits already on these routes are bucketed on the token, so a
    // walk — a different token every time — opens a fresh bucket per guess and
    // never trips any of them. This asserts the thing they cannot do.
    const ip = '203.0.113.9';
    for (let i = 0; i < GUEST_LINK_LIMITS.MAX_FAILURES; i++) {
      const res = await call('GET', `/api/public/threads/${newToken()}`, { ip });
      expect(res.status).toBe(404);
    }
    expect((await attempts(ip))?.failures).toBe(GUEST_LINK_LIMITS.MAX_FAILURES);
    expect((await attempts(ip))?.locked_until).toBeGreaterThan(now());
  });

  it('does not shut the door on anybody else', async () => {
    const walker = '203.0.113.10';
    const customer = '198.51.100.4';
    const token = await booking();

    for (let i = 0; i < GUEST_LINK_LIMITS.MAX_FAILURES + 3; i++) {
      await call('GET', `/api/public/threads/${newToken()}`, { ip: walker });
    }
    expect((await call('GET', `/api/public/threads/${newToken()}`, { ip: walker })).status).toBe(429);

    const res = await call('GET', `/api/public/threads/${token}`, { ip: customer });
    expect(res.status).toBe(200);
    expect((await attempts(customer))).toBeNull();
  });

  it('does not extend its own lockout every time the script knocks again', async () => {
    // A lockout that is pushed further out by the requests it is already
    // refusing never ends, and the address it is on is shared with somebody
    // whose booking is real.
    const ip = '203.0.113.11';
    for (let i = 0; i < GUEST_LINK_LIMITS.MAX_FAILURES; i++) {
      await call('GET', `/api/public/threads/${newToken()}`, { ip });
    }
    const first = (await attempts(ip))!.locked_until;

    for (let i = 0; i < 20; i++) {
      await call('GET', `/api/public/threads/${newToken()}`, { ip });
    }
    expect((await attempts(ip))!.locked_until).toBe(first);
  });
});

describe('a customer using the link they were actually given', () => {
  it('is never locked out by polling, however long the tab is open', async () => {
    // GuestThread.tsx polls every fifteen seconds. Sixty polls is a quarter of
    // an hour of somebody sitting on their own booking, which must not be
    // indistinguishable from an attack on it.
    const ip = '198.51.100.9';
    const token = await booking();

    for (let i = 0; i < 60; i++) {
      const res = await call('GET', `/api/public/threads/${token}`, { ip });
      expect(res.status).toBe(200);
    }
    // Not merely under the limit — not counted at all. Success is not a
    // cheaper failure.
    expect(await attempts(ip)).toBeNull();
  });

  it('can still get their link wrong a few times and recover', async () => {
    const ip = '198.51.100.10';
    const token = await booking();

    // Half a URL out of an email, three times.
    for (let i = 0; i < 3; i++) {
      expect((await call('GET', `/api/public/threads/${newToken()}`, { ip })).status).toBe(404);
    }
    expect((await call('GET', `/api/public/threads/${token}`, { ip })).status).toBe(200);
  });

  it('starting a conversation is not gated — there is no link to be wrong about', async () => {
    const ip = '198.51.100.11';
    for (let i = 0; i < GUEST_LINK_LIMITS.MAX_FAILURES + 2; i++) {
      await call('GET', `/api/public/threads/${newToken()}`, { ip });
    }
    // Locked for the token routes...
    expect((await call('GET', `/api/public/threads/${newToken()}`, { ip })).status).toBe(429);
    // ...and POST /api/public/threads has no token segment, so it is untouched
    // and answers on its own merits.
    const res = await call('POST', '/api/public/threads', {
      ip, body: { operator_id: OP, guest_name: 'Ada', first_message: 'Are you free Friday?' },
    });
    expect(res.status).toBe(201);
  });
});

describe('the counter ages out', () => {
  it('forgets failures once the window has passed', async () => {
    const ip = '203.0.113.12';
    for (let i = 0; i < GUEST_LINK_LIMITS.MAX_FAILURES - 1; i++) {
      await call('GET', `/api/public/threads/${newToken()}`, { ip });
    }
    expect((await attempts(ip))!.failures).toBe(GUEST_LINK_LIMITS.MAX_FAILURES - 1);

    // Walk the row's window back rather than the clock: nine wrong links a
    // year apart must not add up to a lockout.
    await env.DB.prepare(
      `UPDATE guest_link_attempts SET window_started_at = ? WHERE ip = ?`,
    ).bind(now() - GUEST_LINK_LIMITS.WINDOW_SECONDS - 60, ip).run();

    const res = await call('GET', `/api/public/threads/${newToken()}`, { ip });
    expect(res.status).toBe(404);
    expect((await attempts(ip))!.failures).toBe(1);
    expect((await attempts(ip))!.locked_until).toBeNull();
  });

  it('lets a locked caller back in when the lockout expires', async () => {
    const ip = '203.0.113.13';
    const token = await booking();
    for (let i = 0; i < GUEST_LINK_LIMITS.MAX_FAILURES; i++) {
      await call('GET', `/api/public/threads/${newToken()}`, { ip });
    }
    expect((await call('GET', `/api/public/threads/${token}`, { ip })).status).toBe(429);

    await env.DB.prepare(
      `UPDATE guest_link_attempts SET locked_until = ?, window_started_at = ? WHERE ip = ?`,
    ).bind(now() - 1, now() - GUEST_LINK_LIMITS.WINDOW_SECONDS - 1, ip).run();

    expect((await call('GET', `/api/public/threads/${token}`, { ip })).status).toBe(200);
  });

  it('sweeps rows that are neither counting nor locking any more', async () => {
    const stale = '203.0.113.14';
    const live = '203.0.113.15';
    await call('GET', `/api/public/threads/${newToken()}`, { ip: stale });
    await call('GET', `/api/public/threads/${newToken()}`, { ip: live });
    await env.DB.prepare(
      `UPDATE guest_link_attempts SET window_started_at = ? WHERE ip = ?`,
    ).bind(now() - GUEST_LINK_LIMITS.WINDOW_SECONDS - 1, stale).run();

    await sweepGuestLinkAttempts(env);
    expect(await attempts(stale)).toBeNull();
    expect(await attempts(live)).not.toBeNull();
  });

  it('keeps a row whose lockout is still running even once its window is old', async () => {
    const ip = '203.0.113.16';
    for (let i = 0; i < GUEST_LINK_LIMITS.MAX_FAILURES; i++) {
      await call('GET', `/api/public/threads/${newToken()}`, { ip });
    }
    await env.DB.prepare(
      `UPDATE guest_link_attempts SET window_started_at = ? WHERE ip = ?`,
    ).bind(now() - GUEST_LINK_LIMITS.WINDOW_SECONDS - 1, ip).run();

    await sweepGuestLinkAttempts(env);
    // Sweeping this away would be handing back a lockout that has not expired.
    expect((await attempts(ip))!.locked_until).toBeGreaterThan(now());
  });
});
