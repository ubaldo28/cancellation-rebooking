import { describe, expect, it, beforeEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import worker from '../src/index';
import type { Env } from '../src/types';
import { addJobPhoto } from '../src/lib/proof';
import { createWatch } from '../src/lib/alerts';
import { newId, now } from '../src/lib/util';

/**
 * Who is allowed to call what, and what comes back when they do.
 *
 * Every case here failed before the change it guards. They are grouped by the
 * thing that was wrong rather than by route, because several of these were one
 * mistake showing up in two places.
 */

const BASE = 'https://gap.test';
let env: Env;
let stored: Map<string, Uint8Array>;

/** Enough of an R2 bucket for the photo routes to read and write against. */
function fakeBucket() {
  stored = new Map();
  return {
    put: async (key: string, body: unknown) => {
      const bytes = body instanceof Uint8Array ? new Uint8Array(body)
        : new Uint8Array(await new Response(body as any).arrayBuffer());
      stored.set(key, bytes);
      return {};
    },
    get: async (key: string) => {
      const hit = stored.get(key);
      if (!hit) return null;
      return {
        body: new Blob([hit]).stream(),
        httpEtag: '"e"',
        writeHttpMetadata: () => {},
      };
    },
    delete: async (key: string) => { stored.delete(key); },
  };
}

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

  return { opId, cookie: `gf_session=${raw}` };
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
  env = { ...makeEnv(ALL_MIGRATIONS), PHOTOS: fakeBucket() } as unknown as Env;
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
    const admin = await signIn('ops@slotfill.app');
    env.ADMIN_EMAILS = ' OPS@slotfill.app , someone@else.test ';

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
    stored.set(key, new Uint8Array([1, 2, 3]));
    expect((await call('GET', `/api/public/photo/${encodeURIComponent(key)}`)).status).toBe(200);
  });

  it('answers a private key that really exists exactly as it answers a missing one', async () => {
    stored.set('j/op/item/real', new Uint8Array([1, 2, 3]));
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
    // The address survives: they have to drive there.
    expect(text).toContain('12 Private Rd');
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
  it('bounds a walk over phone numbers on the standing lookup', async () => {
    let last = 0;
    for (let i = 0; i < 40; i++) {
      last = (await call('GET', `/api/public/standing?phone=%2B1310555${String(i).padStart(4, '0')}`,
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
});
