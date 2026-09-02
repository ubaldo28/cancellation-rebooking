import { describe, expect, it, beforeEach } from 'vitest';
import { makeEnv } from './d1';
import worker from '../src/index';
import type { Env } from '../src/types';
import { newId, now } from '../src/lib/util';

const MIGRATIONS = [
  new URL('../migrations/0001_init.sql', import.meta.url).pathname,
  new URL('../migrations/0002_postal_codes.sql', import.meta.url).pathname,
  new URL('../migrations/0003_hardening.sql', import.meta.url).pathname,
  new URL('../migrations/0004_scan_budget.sql', import.meta.url).pathname,
];

const BASE = 'https://gap.test';
let env: Env;

function makeReq(method: string, path: string, opts: {
  body?: unknown; cookie?: string; origin?: string; headers?: Record<string, string>;
} = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers['cookie'] = opts.cookie;
  if (opts.origin) headers['origin'] = opts.origin;
  return new Request(`${BASE}${path}`, {
    method, headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

const call = (method: string, path: string, opts?: Parameters<typeof makeReq>[2]) =>
  worker.fetch(makeReq(method, path, opts), env);

/** Create an operator directly and mint a session, bypassing email. */
async function signIn(email: string, businessName: string) {
  const t = now();
  const opId = newId();
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,timezone,country,currency,
       location_mode,fill_model,sms_mode,plan,created_at,updated_at)
     VALUES (?,?,?, 'Europe/London','GB','GBP','mobile','both','device','active',?,?)`,
  ).bind(opId, email, businessName, t, t).run();

  const raw = `sess-${opId}`;
  const { default: crypto0 } = { default: globalThis.crypto };
  const digest = await crypto0.subtle.digest(
    'SHA-256', new TextEncoder().encode(`${raw}:${env.SESSION_PEPPER}`));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');

  await env.DB.prepare(
    `INSERT INTO sessions (id,operator_id,token_hash,expires_at,created_at)
     VALUES (?,?,?,?,?)`,
  ).bind(newId(), opId, hash, t + 86400, t).run();

  return { opId, cookie: `gf_session=${raw}` };
}

beforeEach(() => { env = makeEnv(MIGRATIONS) as unknown as Env; });

// ---------------------------------------------------------------------------
describe('sign-in link is never handed to the caller', () => {
  it('refuses to sign in at all when no email provider is configured', async () => {
    const res = await call('POST', '/api/auth/request', { body: { email: 'a@example.com' } });
    expect(res.status).toBe(503);
    const b = await res.json() as any;
    expect(b.code).toBe('email_not_configured');
    expect(JSON.stringify(b)).not.toContain('/auth/verify');
  });

  it('never echoes the link without the debug secret, even on localhost', async () => {
    env = { ...makeEnv(MIGRATIONS), APP_URL: 'http://localhost:8787' } as unknown as Env;
    const res = await call('POST', '/api/auth/request', { body: { email: 'a@example.com' } });
    expect(await res.text()).not.toContain('/auth/verify');
  });

  it('refuses to echo the link on a production host even WITH the debug secret', async () => {
    env = {
      ...makeEnv(MIGRATIONS),
      APP_URL: 'https://gapfiller.example.com',
      AUTH_DEBUG_TOKEN: 'a-long-enough-debug-token-value',
    } as unknown as Env;
    const res = await call('POST', '/api/auth/request', {
      body: { email: 'a@example.com' },
      headers: { 'x-auth-debug': 'a-long-enough-debug-token-value' },
    });
    expect(await res.text()).not.toContain('/auth/verify');
  });

  it('echoes the link only on localhost with the correct secret', async () => {
    env = {
      ...makeEnv(MIGRATIONS),
      APP_URL: 'http://localhost:8787',
      AUTH_DEBUG_TOKEN: 'a-long-enough-debug-token-value',
    } as unknown as Env;
    const res = await call('POST', '/api/auth/request', {
      body: { email: 'a@example.com' },
      headers: { 'x-auth-debug': 'a-long-enough-debug-token-value' },
    });
    const b = await res.json() as any;
    expect(b.sign_in_link).toContain('/auth/verify?token=');
  });

  it('rate limits repeated sign-in attempts for one address', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await call('POST', '/api/auth/request', { body: { email: 'a@example.com' } });
      codes.push(res.status);
    }
    expect(codes).toContain(429);
  });
});

// ---------------------------------------------------------------------------
describe('authentication is required', () => {
  const protectedRoutes: Array<[string, string]> = [
    ['GET', '/api/me'],
    ['PATCH', '/api/settings'],
    ['GET', '/api/clients'],
    ['POST', '/api/clients'],
    ['GET', '/api/leads'],
    ['GET', '/api/appointments'],
    ['POST', '/api/appointments'],
    ['GET', '/api/gaps'],
    ['POST', '/api/gaps/detect'],
    ['GET', '/api/services'],
    ['GET', '/api/working-hours'],
  ];

  for (const [method, path] of protectedRoutes) {
    it(`${method} ${path} rejects an anonymous caller`, async () => {
      const res = await call(method, path, { body: method === 'GET' ? undefined : {} });
      expect(res.status).toBe(401);
    });
  }

  it('rejects a forged session cookie', async () => {
    const res = await call('GET', '/api/me', { cookie: 'gf_session=not-a-real-token' });
    expect(res.status).toBe(401);
  });

  it('rejects an expired session', async () => {
    const { cookie, opId } = await signIn('a@example.com', 'A');
    await env.DB.prepare(`UPDATE sessions SET expires_at = ? WHERE operator_id = ?`)
      .bind(now() - 10, opId).run();
    expect((await call('GET', '/api/me', { cookie })).status).toBe(401);
  });

  it('rejects a revoked session', async () => {
    const { cookie, opId } = await signIn('a@example.com', 'A');
    await env.DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE operator_id = ?`)
      .bind(now(), opId).run();
    expect((await call('GET', '/api/me', { cookie })).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
describe('tenant isolation', () => {
  let a: { opId: string; cookie: string };
  let b: { opId: string; cookie: string };
  let bClientId: string;
  let bApptId: string;
  let bLeadId: string;

  beforeEach(async () => {
    a = await signIn('a@example.com', 'Operator A');
    b = await signIn('b@example.com', 'Operator B');
    const t = now();

    bClientId = newId();
    await env.DB.prepare(
      `INSERT INTO clients (id,operator_id,first_name,phone_e164,sms_consent,sms_consent_at,created_at,updated_at)
       VALUES (?,?,?,?,1,?,?,?)`,
    ).bind(bClientId, b.opId, 'BSecret', '+447700900999', t, t, t).run();

    bApptId = newId();
    await env.DB.prepare(
      `INSERT INTO appointments (id,operator_id,client_id,starts_at,ends_at,status,source,created_at,updated_at)
       VALUES (?,?,?,?,?, 'scheduled','manual',?,?)`,
    ).bind(bApptId, b.opId, bClientId, t + 7200, t + 10800, t, t).run();

    bLeadId = newId();
    await env.DB.prepare(
      `INSERT INTO job_leads (id,operator_id,client_id,title,status,created_at,updated_at)
       VALUES (?,?,?,?, 'open',?,?)`,
    ).bind(bLeadId, b.opId, bClientId, 'B private job', t, t).run();
  });

  it("A's client list never contains B's clients", async () => {
    const res = await call('GET', '/api/clients', { cookie: a.cookie });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).not.toContain('BSecret');
    expect(JSON.parse(body).clients).toHaveLength(0);
  });

  it("A's appointment list never contains B's appointments", async () => {
    const res = await call('GET', '/api/appointments', { cookie: a.cookie });
    expect(JSON.parse(await res.text()).appointments).toHaveLength(0);
  });

  it("A's lead list never contains B's leads", async () => {
    const res = await call('GET', '/api/leads', { cookie: a.cookie });
    expect(await res.text()).not.toContain('B private job');
  });

  it("A cannot patch B's client", async () => {
    const res = await call('PATCH', `/api/clients/${bClientId}`, {
      cookie: a.cookie, body: { first_name: 'Hijacked' },
    });
    expect(res.status).toBe(404);
    const row = await env.DB.prepare(`SELECT first_name FROM clients WHERE id=?`)
      .bind(bClientId).first<any>();
    expect(row.first_name).toBe('BSecret');
  });

  it("A cannot patch B's appointment", async () => {
    const res = await call('PATCH', `/api/appointments/${bApptId}`, {
      cookie: a.cookie, body: { status: 'cancelled' },
    });
    expect(res.status).toBe(404);
    const row = await env.DB.prepare(`SELECT status FROM appointments WHERE id=?`)
      .bind(bApptId).first<any>();
    expect(row.status).toBe('scheduled');
  });

  it("A cannot cancel B's appointment", async () => {
    const res = await call('POST', `/api/appointments/${bApptId}/cancel`, {
      cookie: a.cookie, body: {},
    });
    expect(res.status).toBe(404);
  });

  it("A cannot patch B's lead", async () => {
    const res = await call('PATCH', `/api/leads/${bLeadId}`, {
      cookie: a.cookie, body: { status: 'lost' },
    });
    expect(res.status).toBe(404);
  });

  it("A cannot attach a lead to B's client", async () => {
    const res = await call('POST', '/api/leads', {
      cookie: a.cookie, body: { client_id: bClientId, title: 'sneaky' },
    });
    expect(res.status).toBe(404);
  });

  it("A cannot read B's gap candidates", async () => {
    const t = now();
    const gapId = newId();
    await env.DB.prepare(
      `INSERT INTO gaps (id,operator_id,starts_at,ends_at,status,created_at,updated_at)
       VALUES (?,?,?,?, 'open',?,?)`,
    ).bind(gapId, b.opId, t + 3600, t + 10800, t, t).run();
    expect((await call('GET', `/api/gaps/${gapId}/candidates`, { cookie: a.cookie })).status).toBe(404);
    expect((await call('POST', `/api/gaps/${gapId}/offers`, { cookie: a.cookie, body: {} })).status).toBe(404);
    expect((await call('POST', `/api/gaps/${gapId}/dismiss`, { cookie: a.cookie, body: {} })).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
describe('completing a job drives the overdue list', () => {
  it('advances last_serviced_at and sets next_due_at from the cadence', async () => {
    const { opId, cookie } = await signIn('a@example.com', 'A');
    const t = now();

    await env.DB.prepare(
      `INSERT INTO services (id,operator_id,name,duration_seconds,price_cents,cadence_days,created_at,updated_at)
       VALUES ('sv',?, 'Full detail',7200,6500,28,?,?)`,
    ).bind(opId, t, t).run();

    const clientId = newId();
    await env.DB.prepare(
      `INSERT INTO clients (id,operator_id,first_name,phone_e164,default_service_id,
         sms_consent,sms_consent_at,created_at,updated_at)
       VALUES (?,?,?,?, 'sv',1,?,?,?)`,
    ).bind(clientId, opId, 'Dan', '+447700900001', t, t, t).run();

    const before = await env.DB.prepare(`SELECT * FROM clients WHERE id=?`).bind(clientId).first<any>();
    expect(before.next_due_at).toBeNull();
    expect(before.visit_count).toBe(0);

    const apptId = newId();
    const ends = t - 3600;
    await env.DB.prepare(
      `INSERT INTO appointments (id,operator_id,client_id,service_id,starts_at,ends_at,
         status,source,created_at,updated_at)
       VALUES (?,?,?, 'sv',?,?, 'scheduled','manual',?,?)`,
    ).bind(apptId, opId, clientId, ends - 7200, ends, t, t).run();

    const res = await call('PATCH', `/api/appointments/${apptId}`, {
      cookie, body: { status: 'completed' },
    });
    expect(res.status).toBe(200);

    const after = await env.DB.prepare(`SELECT * FROM clients WHERE id=?`).bind(clientId).first<any>();
    expect(after.last_serviced_at).toBe(ends);
    expect(after.visit_count).toBe(1);
    expect(after.next_due_at).toBe(ends + 28 * 86400);
  });

  it('counts a no-show against the client for future ranking', async () => {
    const { opId, cookie } = await signIn('a@example.com', 'A');
    const t = now();
    const clientId = newId();
    await env.DB.prepare(
      `INSERT INTO clients (id,operator_id,first_name,phone_e164,created_at,updated_at)
       VALUES (?,?,?,?,?,?)`,
    ).bind(clientId, opId, 'Sam', '+447700900002', t, t).run();
    const apptId = newId();
    await env.DB.prepare(
      `INSERT INTO appointments (id,operator_id,client_id,starts_at,ends_at,status,source,created_at,updated_at)
       VALUES (?,?,?,?,?, 'scheduled','manual',?,?)`,
    ).bind(apptId, opId, clientId, t - 7200, t - 3600, t, t).run();

    await call('PATCH', `/api/appointments/${apptId}`, { cookie, body: { status: 'no_show' } });
    const c = await env.DB.prepare(`SELECT no_show_count FROM clients WHERE id=?`)
      .bind(clientId).first<any>();
    expect(c.no_show_count).toBe(1);
  });

  it('refuses a reschedule that collides with another job', async () => {
    const { opId, cookie } = await signIn('a@example.com', 'A');
    const t = now() + 86400;
    const one = newId(), two = newId();
    for (const [id, s, e] of [[one, t, t + 3600], [two, t + 7200, t + 10800]] as const) {
      await env.DB.prepare(
        `INSERT INTO appointments (id,operator_id,starts_at,ends_at,status,source,created_at,updated_at)
         VALUES (?,?,?,?, 'scheduled','manual',?,?)`,
      ).bind(id, opId, s, e, now(), now()).run();
    }
    const res = await call('PATCH', `/api/appointments/${two}`, {
      cookie, body: { starts_at: t + 1800, ends_at: t + 5400 },
    });
    expect(res.status).toBe(409);
    expect((await res.json() as any).code).toBe('overlap');
  });
});

// ---------------------------------------------------------------------------
describe('CORS', () => {
  beforeEach(() => {
    env = { ...makeEnv(MIGRATIONS), ALLOWED_ORIGINS: 'https://app.gapfiller.test' } as unknown as Env;
  });

  it('answers a preflight from an allowed origin', async () => {
    const res = await call('OPTIONS', '/api/clients', { origin: 'https://app.gapfiller.test' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.gapfiller.test');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('does not grant credentials to an unlisted origin', async () => {
    const res = await call('OPTIONS', '/api/clients', { origin: 'https://evil.example.com' });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('never answers with a wildcard, which would defeat cookie auth entirely', async () => {
    const res = await call('GET', '/api/me', { origin: 'https://app.gapfiller.test' });
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
  });

  it('attaches CORS headers to error responses too', async () => {
    const res = await call('GET', '/api/me', { origin: 'https://app.gapfiller.test' });
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.gapfiller.test');
  });
});

// ---------------------------------------------------------------------------
describe('Twilio webhooks reject unsigned requests', () => {
  async function post(path: string, fields: Record<string, string>, sig?: string) {
    const form = new URLSearchParams(fields);
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
    };
    if (sig) headers['x-twilio-signature'] = sig;
    return worker.fetch(
      new Request(`${BASE}${path}`, { method: 'POST', headers, body: form.toString() }),
      env,
    );
  }

  beforeEach(async () => {
    env = { ...makeEnv(MIGRATIONS), TWILIO_AUTH_TOKEN: 'test-auth-token' } as unknown as Env;
    const t = now();
    const opId = newId();
    await env.DB.prepare(
      `INSERT INTO operators (id,email,business_name,timezone,country,currency,
         location_mode,fill_model,sms_mode,plan,created_at,updated_at)
       VALUES (?,?,?, 'Europe/London','GB','GBP','mobile','both','twilio','active',?,?)`,
    ).bind(opId, 'a@example.com', 'A', t, t).run();
    await env.DB.prepare(
      `INSERT INTO clients (id,operator_id,first_name,phone_e164,sms_consent,sms_consent_at,created_at,updated_at)
       VALUES (?,?,?,?,1,?,?,?)`,
    ).bind(newId(), opId, 'Dan', '+447700900001', t, t, t).run();
  });

  it('refuses an unsigned STOP and leaves the client subscribed', async () => {
    const res = await post('/webhooks/twilio/inbound',
      { From: '+447700900001', Body: 'STOP', MessageSid: 'SM1' });
    expect(res.status).toBe(403);
    const c = await env.DB.prepare(`SELECT opted_out_at, sms_consent FROM clients LIMIT 1`)
      .first<any>();
    expect(c.opted_out_at).toBeNull();
    expect(c.sms_consent).toBe(1);
  });

  it('refuses a wrong signature', async () => {
    const res = await post('/webhooks/twilio/inbound',
      { From: '+447700900001', Body: 'STOP' }, 'obviously-wrong');
    expect(res.status).toBe(403);
  });

  it('accepts a correctly signed STOP and opts the client out', async () => {
    const fields = { Body: 'STOP', From: '+447700900001' };
    const payload = `${BASE}/webhooks/twilio/inbound` +
      Object.keys(fields).sort().map((k) => k + (fields as any)[k]).join('');
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode('test-auth-token'),
      { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
    const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));

    const res = await post('/webhooks/twilio/inbound', fields, sig);
    expect(res.status).toBe(200);
    const c = await env.DB.prepare(`SELECT opted_out_at, sms_consent FROM clients LIMIT 1`)
      .first<any>();
    expect(c.opted_out_at).not.toBeNull();
    expect(c.sms_consent).toBe(0);
  });

  it('refuses status callbacks when no auth token is configured at all', async () => {
    env = makeEnv(MIGRATIONS) as unknown as Env;   // no TWILIO_AUTH_TOKEN
    const res = await post('/webhooks/twilio/status',
      { MessageSid: 'SM1', MessageStatus: 'delivered' }, 'anything');
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
describe('cron scan budget', () => {
  it('bumps the calendar version on anything that can move a gap', async () => {
    const { opId, cookie } = await signIn('a@example.com', 'A');
    const version = async () => (await env.DB.prepare(
      `SELECT calendar_version AS v FROM operators WHERE id=?`).bind(opId).first<any>()).v;

    expect(await version()).toBe(0);

    const t = now() + 86400;
    await call('POST', '/api/appointments', {
      cookie, body: { starts_at: t, ends_at: t + 3600 },
    });
    const afterBooking = await version();
    expect(afterBooking).toBeGreaterThan(0);

    await call('PUT', '/api/working-hours', {
      cookie, body: { working_hours: [{ weekday: 3, start_minute: 540, end_minute: 1020 }] },
    });
    expect(await version()).toBeGreaterThan(afterBooking);

    const afterHours = await version();
    await call('POST', '/api/time-off', {
      cookie, body: { starts_at: t + 7200, ends_at: t + 10800 },
    });
    expect(await version()).toBeGreaterThan(afterHours);
  });

  it('bumps it on completion and on cancellation', async () => {
    const { opId, cookie } = await signIn('a@example.com', 'A');
    const t = now();
    const apptId = newId();
    await env.DB.prepare(
      `INSERT INTO appointments (id,operator_id,starts_at,ends_at,status,source,created_at,updated_at)
       VALUES (?,?,?,?, 'scheduled','manual',?,?)`,
    ).bind(apptId, opId, t - 7200, t - 3600, t, t).run();
    const version = async () => (await env.DB.prepare(
      `SELECT calendar_version AS v FROM operators WHERE id=?`).bind(opId).first<any>()).v;

    const before = await version();
    await call('PATCH', `/api/appointments/${apptId}`, { cookie, body: { status: 'completed' } });
    const afterComplete = await version();
    expect(afterComplete).toBeGreaterThan(before);

    const second = newId();
    await env.DB.prepare(
      `INSERT INTO appointments (id,operator_id,starts_at,ends_at,status,source,created_at,updated_at)
       VALUES (?,?,?,?, 'scheduled','manual',?,?)`,
    ).bind(second, opId, t + 86400, t + 90000, t, t).run();
    await call('POST', `/api/appointments/${second}/cancel`, { cookie, body: {} });
    expect(await version()).toBeGreaterThan(afterComplete);
  });

  it('a re-detect with no calendar change writes no gap rows', async () => {
    const { opId } = await signIn('a@example.com', 'A');
    const t = now();
    for (let wd = 1; wd <= 5; wd++) {
      await env.DB.prepare(
        `INSERT INTO working_hours (id,operator_id,weekday,start_minute,end_minute,created_at)
         VALUES (?,?,?,540,1020,?)`,
      ).bind(newId(), opId, wd, t).run();
    }
    const op = await env.DB.prepare(`SELECT * FROM operators WHERE id=?`).bind(opId).first<any>();

    const { detectGaps } = await import('../src/lib/gaps');
    await detectGaps(env, op, now() + 172800, 7);
    const stamps = async () => (await env.DB.prepare(
      `SELECT COALESCE(SUM(updated_at),0) AS s, COUNT(*) AS n FROM gaps`).first<any>());
    const first = await stamps();
    expect(first.n).toBeGreaterThan(0);

    // Nothing about the calendar changed, so the upsert must be a no-op:
    // same rows, same updated_at stamps, zero writes charged.
    await detectGaps(env, op, now() + 172800, 7);
    const second = await stamps();
    expect(second.n).toBe(first.n);
    expect(second.s).toBe(first.s);
  });
});
