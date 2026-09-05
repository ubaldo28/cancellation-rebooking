import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import worker from '../src/index';
import type { Env } from '../src/types';
import { startThread } from '../src/lib/chat';
import { newId, now } from '../src/lib/util';

/**
 * Turnstile, on both settings of its switch.
 *
 * The interesting claim is not "a bad token is refused". It is that the whole
 * thing is inert until TURNSTILE_SECRET is set — because that is how it is
 * shipping, with no key anywhere, and a protection that quietly changed the
 * behaviour of the booking endpoint on the way in would be a worse bug than
 * the abuse it is aimed at. So every case below is run twice where it can be:
 * once with the secret and once without.
 *
 * siteverify is stubbed throughout. A test that reached challenges.cloudflare.com
 * would be testing Cloudflare's uptime, would fail in a sandbox with no egress,
 * and would need a real secret to say anything at all.
 */

const BASE = 'https://gap.test';
const SECRET = 'test-secret-not-a-real-one';
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

let env: Env;
let calls: Array<{ url: string; secret: string; response: string; remoteip: string | null }>;

/** What the stub will say next. */
let verdict: 'pass' | 'fail' | 'unreachable' = 'pass';

const realFetch = globalThis.fetch;

beforeEach(async () => {
  env = makeEnv(ALL_MIGRATIONS) as unknown as Env;
  calls = [];
  verdict = 'pass';

  globalThis.fetch = vi.fn(async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    if (!url.startsWith(SITEVERIFY)) {
      throw new Error(`unexpected outbound fetch in test: ${url}`);
    }
    const form = init?.body as FormData;
    calls.push({
      url,
      secret: String(form.get('secret') ?? ''),
      response: String(form.get('response') ?? ''),
      remoteip: form.has('remoteip') ? String(form.get('remoteip')) : null,
    });
    if (verdict === 'unreachable') throw new TypeError('network');
    return new Response(JSON.stringify(
      verdict === 'pass'
        ? { success: true }
        : { success: false, 'error-codes': ['invalid-input-response'] },
    ), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
});

afterEach(() => { globalThis.fetch = realFetch; });

function makeReq(method: string, path: string, opts: {
  body?: unknown; ip?: string;
} = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.ip) headers['cf-connecting-ip'] = opts.ip;
  return new Request(`${BASE}${path}`, {
    method, headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

const call = (method: string, path: string, opts?: Parameters<typeof makeReq>[1]) =>
  worker.fetch(makeReq(method, path, opts), env, {} as ExecutionContext);

/** With the secret present the check is live; without it, it is not there at all. */
const armed = () => { env.TURNSTILE_SECRET = SECRET; };

const count = async (sql: string) =>
  (await env.DB.prepare(sql).first<{ n: number }>())!.n;

// ---------------------------------------------------------------------------
// A business with an opening somebody can actually book, so "no order row was
// written" is a claim about a request that would otherwise have written one.
// ---------------------------------------------------------------------------
const OP = 'op-turnstile';
const HERE = { lat: 34.1510, lng: -118.4450 };

async function seed() {
  const t = now();
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,timezone,country,currency,language,
       location_mode,fill_model,sms_mode,max_detour_seconds,min_gap_seconds,buffer_seconds,
       offer_ttl_seconds,offers_per_wave,min_notice_seconds,reoffer_cooldown_seconds,
       discount_percent,plan,accept_public_bookings,created_at,updated_at)
     VALUES (?,?,?, 'America/Los_Angeles','US','USD','en','mobile','both','device',
       3600,3600,900,5400,3,3600,604800,0,'active',1,?,?)`,
  ).bind(OP, 'turnstile@example.com', 'Valley Detailing', t, t).run();

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
  phone: '(818) 555-0142',
  address_line: '15200 Ventura Blvd',
  postcode: '91403',
  ...extra,
});

// ---------------------------------------------------------------------------
describe('with no secret set, nothing about these endpoints has changed', () => {
  it('places an order with no token at all', async () => {
    const { gapId } = await seed();
    const res = await call('POST', '/api/public/orders', {
      ip: '203.0.113.10', body: orderBody(gapId),
    });
    expect(res.status).toBe(201);
    expect(await count(`SELECT COUNT(*) AS n FROM orders`)).toBe(1);
    // Not "did not fail" — did not even ask. An unset secret must not turn
    // into an outbound request on the hot path of a booking.
    expect(calls).toHaveLength(0);
  });

  it('creates a standing alert with no token at all', async () => {
    await seed();
    const res = await call('POST', '/api/public/watches', {
      ip: '203.0.113.11', body: { postcode: '91403', email: 'sam@example.com' },
    });
    expect(res.status).toBe(201);
    expect(await count(`SELECT COUNT(*) AS n FROM watches`)).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it('gets the same 404 as before when a conversation names no real business', async () => {
    const res = await call('POST', '/api/public/threads', {
      ip: '203.0.113.12', body: { operator_id: 'no-such-operator', guest_name: 'Sam' },
    });
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('ignores a token that was sent anyway', async () => {
    // A bundle built with a site key against a Worker whose secret has not
    // been set yet. The token is meaningless here and must not become an error.
    const { gapId } = await seed();
    const res = await call('POST', '/api/public/orders', {
      ip: '203.0.113.13', body: orderBody(gapId, { turnstile_token: 'whatever' }),
    });
    expect(res.status).toBe(201);
    expect(calls).toHaveLength(0);
  });

  it('is off for an empty or whitespace secret, not just an absent one', async () => {
    const { gapId } = await seed();
    env.TURNSTILE_SECRET = '   ';
    const res = await call('POST', '/api/public/orders', {
      ip: '203.0.113.14', body: orderBody(gapId),
    });
    expect(res.status).toBe(201);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('with the secret set, a missing token is refused', () => {
  beforeEach(armed);

  it('refuses a booking and writes nothing', async () => {
    const { gapId } = await seed();
    const res = await call('POST', '/api/public/orders', {
      ip: '203.0.113.20', body: orderBody(gapId),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'turnstile_missing' });

    // The whole point of verifying first. Nothing was booked, no conversation
    // was opened, and the opening is still there for a real customer.
    expect(await count(`SELECT COUNT(*) AS n FROM orders`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM appointments`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM threads`)).toBe(0);
    expect(await count(
      `SELECT COUNT(*) AS n FROM gaps WHERE id = '${gapId}' AND status = 'open'`)).toBe(1);
  });

  it('refuses a standing alert and writes nothing', async () => {
    await seed();
    const res = await call('POST', '/api/public/watches', {
      ip: '203.0.113.21', body: { postcode: '91403', email: 'sam@example.com' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'turnstile_missing' });
    expect(await count(`SELECT COUNT(*) AS n FROM watches`)).toBe(0);
  });

  it('refuses a new conversation before it looks the business up', async () => {
    await seed();
    const res = await call('POST', '/api/public/threads', {
      ip: '203.0.113.22', body: { operator_id: OP, guest_name: 'Sam' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'turnstile_missing' });
    expect(await count(`SELECT COUNT(*) AS n FROM threads`)).toBe(0);
  });

  it('refuses an instant request before anybody is rung', async () => {
    await seed();
    const res = await call('POST', '/api/public/online/requests', {
      ip: '203.0.113.23',
      body: { operator_id: OP, guest_name: 'Sam', phone: '(818) 555-0142' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'turnstile_missing' });
    expect(await count(`SELECT COUNT(*) AS n FROM instant_requests`)).toBe(0);
  });

  it('never contacts siteverify when there is nothing to verify', async () => {
    const { gapId } = await seed();
    await call('POST', '/api/public/orders', { ip: '203.0.113.24', body: orderBody(gapId) });
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('with the secret set, Cloudflare decides', () => {
  beforeEach(armed);

  it('refuses a token Cloudflare rejects, and still writes nothing', async () => {
    const { gapId } = await seed();
    verdict = 'fail';
    const res = await call('POST', '/api/public/orders', {
      ip: '203.0.113.30', body: orderBody(gapId, { turnstile_token: 'forged' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'turnstile_failed' });
    expect(await count(`SELECT COUNT(*) AS n FROM orders`)).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('lets a token Cloudflare accepts straight through to the booking', async () => {
    const { gapId } = await seed();
    const res = await call('POST', '/api/public/orders', {
      ip: '203.0.113.31', body: orderBody(gapId, { turnstile_token: 'solved' }),
    });
    expect(res.status).toBe(201);
    expect(await count(`SELECT COUNT(*) AS n FROM orders`)).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('sends the secret, the token and the caller address', async () => {
    const { gapId } = await seed();
    await call('POST', '/api/public/orders', {
      ip: '203.0.113.32', body: orderBody(gapId, { turnstile_token: 'solved' }),
    });
    expect(calls[0]).toMatchObject({
      secret: SECRET,
      response: 'solved',
      // Cloudflare scores the token against the address it was solved from.
      remoteip: '203.0.113.32',
    });
  });

  it('reads the widget\'s own field name as well as ours', async () => {
    // What arrives if a form is ever posted the way Turnstile's own hidden
    // input names it, rather than as the JSON body the SPA sends.
    const { gapId } = await seed();
    const res = await call('POST', '/api/public/orders', {
      ip: '203.0.113.33',
      body: orderBody(gapId, { 'cf-turnstile-response': 'solved' }),
    });
    expect(res.status).toBe(201);
    expect(calls[0]!.response).toBe('solved');
  });

  it('fails closed when siteverify cannot be reached', async () => {
    const { gapId } = await seed();
    verdict = 'unreachable';
    const res = await call('POST', '/api/public/orders', {
      ip: '203.0.113.34', body: orderBody(gapId, { turnstile_token: 'solved' }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'turnstile_unavailable' });
    expect(await count(`SELECT COUNT(*) AS n FROM orders`)).toBe(0);
  });

  it('says nothing about why Cloudflare said no', async () => {
    // The error codes name a misconfigured secret or a replayed token. That is
    // for the log, not for whoever is probing the form.
    const { gapId } = await seed();
    verdict = 'fail';
    const res = await call('POST', '/api/public/orders', {
      ip: '203.0.113.35', body: orderBody(gapId, { turnstile_token: 'forged' }),
    });
    expect(JSON.stringify(await res.json())).not.toContain('invalid-input-response');
  });

  it('lets a solved challenge open a conversation and create an alert', async () => {
    await seed();
    const thread = await call('POST', '/api/public/threads', {
      ip: '203.0.113.36',
      body: { operator_id: OP, guest_name: 'Sam', turnstile_token: 'solved' },
    });
    expect(thread.status).toBe(201);

    const watch = await call('POST', '/api/public/watches', {
      ip: '203.0.113.37',
      body: { postcode: '91403', email: 'sam@example.com', turnstile_token: 'solved' },
    });
    expect(watch.status).toBe(201);
    expect(await count(`SELECT COUNT(*) AS n FROM watches`)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('the challenge is on the door, never in the corridor', () => {
  beforeEach(armed);

  /** A customer who is already through: they hold a link to a real thread. */
  async function guestLink() {
    const t = now();
    await env.DB.prepare(
      `INSERT INTO operators (id,email,business_name,timezone,country,currency,
         location_mode,fill_model,sms_mode,plan,created_at,updated_at)
       VALUES ('op-mid','mid@example.com','Mid Job','America/Los_Angeles','US','USD',
         'mobile','both','device','active',?,?)`,
    ).bind(t, t).run();
    const { token } = await startThread(env, { operator_id: 'op-mid', guest_name: 'Sam' });
    return token;
  }

  it('does not challenge a message sent on a conversation already open', async () => {
    const token = await guestLink();
    const res = await call('POST', `/api/public/threads/${token}/messages`, {
      ip: '203.0.113.40', body: { body: 'Any chance of half an hour earlier?' },
    });
    expect(res.status).toBe(201);
    expect(calls).toHaveLength(0);
  });

  it('does not challenge reading a conversation', async () => {
    const token = await guestLink();
    const res = await call('GET', `/api/public/threads/${token}`, { ip: '203.0.113.41' });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it('does not challenge signing in', async () => {
    // Rate limited per address and per host already, and a challenge on the
    // front door is friction paid by every real business forever. See the
    // note on the route in src/index.ts.
    const res = await call('POST', '/api/auth/request', {
      ip: '203.0.113.42', body: { email: 'someone@example.com' },
    });
    expect(res.status).not.toBe(400);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('the policy makes room for the widget and nothing else', () => {
  const csp = async () => {
    const res = await call('GET', '/health');
    const header = res.headers.get('content-security-policy')!;
    return {
      header,
      directive: (name: string) =>
        header.split('; ').find((d) => d.startsWith(`${name} `)) ?? '',
    };
  };

  it('allows the script host and the frame host', async () => {
    const { directive } = await csp();
    // api.js is a script; the challenge it draws is an iframe. Both, or the
    // widget loads and then renders nothing.
    expect(directive('script-src')).toContain('https://challenges.cloudflare.com');
    expect(directive('frame-src')).toContain('https://challenges.cloudflare.com');
  });

  it('still refuses to be framed by anybody', async () => {
    // frame-src is what this page may embed. frame-ancestors is who may embed
    // this page, and widening the first must never touch the second.
    const { header } = await csp();
    expect(header).toContain(`frame-ancestors 'none'`);
    expect((await call('GET', '/health')).headers.get('x-frame-options')).toBe('DENY');
  });

  it('widens nothing else for it', async () => {
    const { directive } = await csp();
    // The challenge's own network traffic is made by the document inside the
    // iframe, on Cloudflare's origin under Cloudflare's policy. Nothing about
    // it reaches connect-src, img-src or font-src here.
    for (const d of ['connect-src', 'img-src', 'font-src', 'worker-src', 'form-action']) {
      expect(directive(d)).not.toContain('challenges.cloudflare.com');
    }
    expect(directive('script-src')).not.toContain('unsafe-inline');
    expect(directive('script-src')).not.toContain('unsafe-eval');
  });
});
