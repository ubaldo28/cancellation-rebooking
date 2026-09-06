import { describe, expect, it, beforeEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import worker from '../src/index';
import type { Env } from '../src/types';
import { VanTracker } from '../src/do/van';
import { SECURITY_HEADERS } from '../src/lib/headers';
import { closeOperatorAccount } from '../src/lib/retention';
import { newId, now } from '../src/lib/util';

/**
 * The second security pass.
 *
 * Every case here failed before the change it guards, and they are grouped by
 * the mistake rather than by route, because most of these are one mistake
 * turning up in several places: an id that was scoped where it was written and
 * not where it pointed, a deletion path that only knew about the database, a
 * pass of work with no isolation between its steps.
 */

const BASE = 'https://gap.test';
let env: Env;
let vans: FakeVanNamespace;

// ---------------------------------------------------------------------------
// The Durable Object namespace, in a Map.
// ---------------------------------------------------------------------------
// The real VanTracker running in-process behind the same two calls the Worker
// makes, so "the van is forgotten" is asserted against the object's own
// storage rather than against a description of it.

class FakeStorage {
  readonly kv = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.kv.get(key)) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> { this.kv.set(key, structuredClone(value)); }
  async delete(key: string): Promise<boolean> { return this.kv.delete(key); }
  async setAlarm(at: number): Promise<void> { this.alarm = at; }
  async getAlarm(): Promise<number | null> { return this.alarm; }
  async deleteAlarm(): Promise<void> { this.alarm = null; }
}

class FakeState {
  ready: Promise<unknown> = Promise.resolve();
  constructor(readonly id: { name: string }, readonly storage: FakeStorage) {}
  blockConcurrencyWhile<T>(cb: () => Promise<T>): Promise<T> {
    const p = cb();
    this.ready = p;
    return p;
  }
}

class FakeVanNamespace {
  private readonly live = new Map<string, { ctx: FakeState; van: VanTracker }>();
  idFromName(name: string) { return { name }; }
  get(id: { name: string }) {
    const o = this.instance(id.name);
    return {
      ping: async (p: unknown) => { await o.ctx.ready; return o.van.ping(p as never); },
      read: async () => { await o.ctx.ready; return o.van.read(); },
      clear: async () => { await o.ctx.ready; return o.van.clear(); },
    };
  }
  /** What is actually on the object's disk, which is the thing being asserted. */
  storageOf(name: string) { return this.instance(name).ctx.storage; }
  private instance(name: string) {
    let o = this.live.get(name);
    if (!o) {
      const ctx = new FakeState({ name }, new FakeStorage());
      o = { ctx, van: new VanTracker(ctx as never, {} as never) };
      this.live.set(name, o);
    }
    return o;
  }
}

function makeReq(method: string, path: string, opts: {
  body?: unknown; cookie?: string; ip?: string;
} = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers['cookie'] = opts.cookie;
  headers['cf-connecting-ip'] = opts.ip ?? '198.51.100.7';
  return new Request(`${BASE}${path}`, {
    method, headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

const call = (method: string, path: string, opts?: Parameters<typeof makeReq>[2]) =>
  worker.fetch(makeReq(method, path, opts), env, {} as ExecutionContext);

/** An operator and a session cookie for them, without going near email. */
async function signIn(email: string) {
  const t = now();
  const opId = newId();
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,timezone,country,currency,
       location_mode,fill_model,sms_mode,plan,created_at,updated_at)
     VALUES (?,?, 'A Business', 'America/Los_Angeles','US','USD','mobile','both','device','active',?,?)`,
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

async function client(operatorId: string, id = newId()) {
  const t = now();
  await env.DB.prepare(
    `INSERT INTO clients (id,operator_id,first_name,last_name,phone_e164,acquired,
       is_active,created_at,updated_at)
     VALUES (?,?, 'Victim','Homeowner','+13105550147','operator',1,?,?)`,
  ).bind(id, operatorId, t, t).run();
  return id;
}

async function service(operatorId: string) {
  const id = newId(); const t = now();
  await env.DB.prepare(
    `INSERT INTO services (id,operator_id,name,duration_seconds,price_cents,created_at,updated_at)
     VALUES (?,?, 'Their service',3600,12000,?,?)`,
  ).bind(id, operatorId, t, t).run();
  return id;
}

const scalar = async (sql: string, ...args: unknown[]) =>
  (await env.DB.prepare(sql).bind(...args).first<{ n: number }>())?.n ?? 0;

beforeEach(() => {
  vans = new FakeVanNamespace();
  env = { ...makeEnv(ALL_MIGRATIONS), VAN: vans } as unknown as Env;
});

// ---------------------------------------------------------------------------
describe('an id in a request body has to belong to the caller', () => {
  /**
   * The row being written was always scoped by operator_id, and that was
   * mistaken for the whole tenancy check. It is not: what a row POINTS AT is
   * joined and displayed by the routes that read it back.
   */

  it('refuses an appointment filed against another business\'s client', async () => {
    const a = await signIn('a@x.test');
    const b = await signIn('b@x.test');
    const theirs = await client(b.opId);

    const res = await call('POST', '/api/appointments', {
      cookie: a.cookie,
      body: { starts_at: now() + 3600, ends_at: now() + 7200, client_id: theirs },
    });

    // 404 and not 403: "belongs to somebody else" must not be distinguishable
    // from "no such row" to a caller probing with ids.
    expect(res.status).toBe(404);
    expect(await scalar(
      `SELECT COUNT(*) AS n FROM appointments WHERE client_id = ?`, theirs)).toBe(0);
  });

  it('does not hand the other business\'s customer back on the calendar', async () => {
    const a = await signIn('a2@x.test');
    const b = await signIn('b2@x.test');
    const theirs = await client(b.opId);

    await call('POST', '/api/appointments', {
      cookie: a.cookie,
      body: { starts_at: now() + 3600, ends_at: now() + 7200, client_id: theirs },
    });

    // The window is given explicitly because the route reads `from` and `to`
    // off the query string exactly as the dashboard sends them.
    const list = await call(
      'GET', `/api/appointments?from=${now()}&to=${now() + 86400}`, { cookie: a.cookie });
    const text = await list.text();
    // The join on the calendar route selects first_name, last_name and
    // phone_e164, which is exactly what this used to leak.
    expect(text).not.toContain('Homeowner');
    expect(text).not.toContain('3105550147');
  });

  it('refuses an appointment on another business\'s service', async () => {
    const a = await signIn('a3@x.test');
    const b = await signIn('b3@x.test');
    const res = await call('POST', '/api/appointments', {
      cookie: a.cookie,
      body: {
        starts_at: now() + 3600, ends_at: now() + 7200, service_id: await service(b.opId),
      },
    });
    expect(res.status).toBe(404);
  });

  it('refuses another business\'s service as a client\'s default', async () => {
    const a = await signIn('a4@x.test');
    const b = await signIn('b4@x.test');
    const res = await call('POST', '/api/clients', {
      cookie: a.cookie,
      body: { first_name: 'Rosa', default_service_id: await service(b.opId) },
    });
    expect(res.status).toBe(404);
    expect(await scalar(`SELECT COUNT(*) AS n FROM clients WHERE first_name = 'Rosa'`)).toBe(0);
  });

  it('refuses another business\'s service on a lead', async () => {
    const a = await signIn('a5@x.test');
    const b = await signIn('b5@x.test');
    const mine = await client(a.opId);
    const res = await call('POST', '/api/leads', {
      cookie: a.cookie,
      body: { title: 'Boiler', client_id: mine, service_id: await service(b.opId) },
    });
    expect(res.status).toBe(404);
  });

  it('still accepts every one of those when they are the caller\'s own', async () => {
    const a = await signIn('a6@x.test');
    const mine = await client(a.opId);
    const svc = await service(a.opId);
    const res = await call('POST', '/api/appointments', {
      cookie: a.cookie,
      body: {
        starts_at: now() + 3600, ends_at: now() + 7200, client_id: mine, service_id: svc,
      },
    });
    expect(res.status).toBe(201);
  });

  /**
   * The write half of the same hole, and the one that leaves a mark.
   *
   * Rows created before the check above went in can still name a client
   * belonging to another business, so the increment is scoped rather than
   * merely prevented upstream. no_show_count is what ranks a customer down for
   * future gaps, and it is only ever about this operator and this client.
   */
  it('will not put a no-show strike on another business\'s client', async () => {
    const a = await signIn('a7@x.test');
    const b = await signIn('b7@x.test');
    const theirs = await client(b.opId);

    const t = now();
    const apptId = newId();
    await env.DB.prepare(
      `INSERT INTO appointments (id,operator_id,client_id,starts_at,ends_at,is_mobile,
         status,source,created_at,updated_at)
       VALUES (?,?,?,?,?,1,'scheduled','manual',?,?)`,
    ).bind(apptId, a.opId, theirs, t + 3600, t + 7200, t, t).run();

    const res = await call('PATCH', `/api/appointments/${apptId}`, {
      cookie: a.cookie, body: { status: 'no_show' },
    });
    expect(res.status).toBe(200);
    expect(await scalar(
      `SELECT no_show_count AS n FROM clients WHERE id = ?`, theirs)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('a path that cannot be decoded is answered, not thrown', () => {
  /**
   * decodeURIComponent was called outside the router's try, so three
   * characters with no session and no body took the request out of fetch()
   * altogether: the runtime's own error response, with none of the security
   * headers the entry point exists to guarantee.
   */

  it('answers a malformed escape as an ordinary 404', async () => {
    for (const path of ['/o/%FF', '/api/public/photo/%ZZ', '/api/public/watches/%']) {
      const res = await call('GET', path);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    }
  });

  it('still puts the security headers on that answer', async () => {
    const res = await call('GET', '/o/%E0%A4%A');
    for (const k of Object.keys(SECURITY_HEADERS)) {
      expect(res.headers.get(k)).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
describe('the van is forgotten when somebody says stop', () => {
  /**
   * The one piece of personal data in this product that is not a row.
   * VanTracker.clear() existed from the day the object was written and nothing
   * outside the tests had ever called it, so a position and a trail survived
   * both the privacy toggle and account closure.
   */

  async function pingedVan(operatorId: string) {
    const stub = vans.get(vans.idFromName(operatorId));
    await stub.ping({
      lat: 34.05, lng: -118.24, accuracy_meters: 5, heading: null,
      speed_mps: null, recorded_at: now(),
    } as never);
    // Force the snapshot the eviction cushion writes, so there is durable
    // state to assert against rather than only a field in memory.
    await stub.ping({
      lat: 34.06, lng: -118.25, accuracy_meters: 5, heading: null,
      speed_mps: null, recorded_at: now() + 3600,
    } as never);
    expect(vans.storageOf(operatorId).kv.size).toBeGreaterThan(0);
  }

  it('clears the position and trail when sharing is switched off', async () => {
    const a = await signIn('van1@x.test');
    await pingedVan(a.opId);

    const res = await call('POST', '/api/track/share', {
      cookie: a.cookie, body: { share_location: false },
    });
    expect(res.status).toBe(200);

    expect(vans.storageOf(a.opId).kv.size).toBe(0);
    expect((await vans.get(vans.idFromName(a.opId)).read()).position).toBeNull();
  });

  it('leaves it alone when sharing is switched on', async () => {
    const a = await signIn('van2@x.test');
    await pingedVan(a.opId);
    await call('POST', '/api/track/share', {
      cookie: a.cookie, body: { share_location: true },
    });
    expect(vans.storageOf(a.opId).kv.size).toBeGreaterThan(0);
  });

  it('clears it when the account is closed', async () => {
    const a = await signIn('van3@x.test');
    await pingedVan(a.opId);

    await closeOperatorAccount(env, a.opId);

    expect(vans.storageOf(a.opId).kv.size).toBe(0);
    expect((await vans.get(vans.idFromName(a.opId)).read()).position).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('one broken step does not switch off the rest of the cron', () => {
  /**
   * Retention is deliberately last in the tick, because everything above it
   * keeps the product working. With no isolation between the steps that
   * ordering made the most important sweep the most fragile: anything earlier
   * throwing meant no expired sessions removed and no personal data deleted,
   * every quarter of an hour, silently.
   */

  it('still sweeps expired sessions after an earlier step throws', async () => {
    const a = await signIn('cron@x.test');
    const t = now();
    await env.DB.prepare(
      `INSERT INTO sessions (id,operator_id,token_hash,expires_at,created_at)
       VALUES (?,?,?,?,?)`,
    ).bind(newId(), a.opId, 'stale-hash', t - 300000, t - 400000).run();

    const realPrepare = env.DB.prepare.bind(env.DB);
    (env.DB as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      if (sql.includes('gap_offers')) throw new Error('the first step is broken');
      return realPrepare(sql);
    };

    await worker.scheduled({} as ScheduledController, env);

    expect(await scalar(
      `SELECT COUNT(*) AS n FROM sessions WHERE token_hash = 'stale-hash'`)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('the anonymous token links have a ceiling', () => {
  /**
   * Bucketed on the address rather than the token, because every guess carries
   * a different token and a per-token bucket therefore opens a fresh allowance
   * for each one. Same reasoning as guestlink.ts, different token space: these
   * two answer with a mailbox and with a stranger's name, number and address.
   */

  it('stops a walk over alert links from one address', async () => {
    let refused = 0;
    for (let i = 0; i < 210; i++) {
      const res = await call('GET', `/api/public/watches/guess-${i}`, { ip: '203.0.113.42' });
      if (res.status === 429) refused++;
    }
    expect(refused).toBeGreaterThan(0);
  });

  it('stops a walk over instant-request links from one address', async () => {
    let refused = 0;
    for (let i = 0; i < 210; i++) {
      const res = await call('GET', `/api/public/online/requests/guess-${i}`, {
        ip: '203.0.113.43',
      });
      if (res.status === 429) refused++;
    }
    expect(refused).toBeGreaterThan(0);
  });
});
