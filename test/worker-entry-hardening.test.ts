import { describe, expect, it, beforeEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import worker from '../src/index';
import type { Env } from '../src/types';
import { newId, now } from '../src/lib/util';

/**
 * The handlers in src/index.ts that took a caller at their word.
 *
 * Every case here fails on the code as it stood. They are grouped by the
 * mistake rather than by route, because two of the three defects showed up on
 * more than one endpoint and fixing either one at a single call site would
 * have left the other one working exactly as before.
 */

const BASE = 'https://gap.test';
let env: Env;

function makeReq(method: string, path: string, opts: {
  body?: unknown; cookie?: string; ip?: string;
} = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers['cookie'] = opts.cookie;
  headers['cf-connecting-ip'] = opts.ip ?? '203.0.113.11';
  return new Request(`${BASE}${path}`, {
    method, headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

const call = (method: string, path: string, opts?: Parameters<typeof makeReq>[2]) =>
  worker.fetch(makeReq(method, path, opts), env, {} as ExecutionContext);

/** An operator with a live session, created directly so no email is needed. */
async function signIn(email: string) {
  const t = now();
  const opId = newId();
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,timezone,country,currency,
       location_mode,fill_model,sms_mode,plan,created_at,updated_at)
     VALUES (?,?,?, 'America/Los_Angeles','US','USD','mobile','both','device','active',?,?)`,
  ).bind(opId, email, 'A Business', t, t).run();

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

const scalar = async <T>(sql: string, ...args: unknown[]): Promise<T> => {
  const row = await env.DB.prepare(sql).bind(...args).first<Record<string, T>>();
  return Object.values(row ?? {})[0] as T;
};

/** A service, so a client can have a cadence to be due on. */
async function service(opId: string, cadenceDays: number | null) {
  const id = newId(), t = now();
  await env.DB.prepare(
    `INSERT INTO services (id, operator_id, name, duration_seconds, cadence_days,
                           created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(id, opId, 'A service', 3600, cadenceDays, t, t).run();
  return id;
}

async function client(opId: string, defaultServiceId: string | null) {
  const id = newId(), t = now();
  await env.DB.prepare(
    `INSERT INTO clients (id, operator_id, first_name, default_service_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?)`,
  ).bind(id, opId, 'Pat', defaultServiceId, t, t).run();
  return id;
}

beforeEach(() => {
  env = makeEnv(ALL_MIGRATIONS) as unknown as Env;
});

// ---------------------------------------------------------------------------
describe('a missing query parameter falls back instead of reading as zero', () => {
  /**
   * `int()` ran everything through `Number()`, and `Number(null)` is 0. An
   * absent `?from=` is exactly null, so it arrived as a finite zero and the
   * `?? now()` beside it never ran. Both windowed reads therefore asked for a
   * fortnight in January 1970 and answered "you have nothing on" — which is
   * indistinguishable, to the person reading it, from an empty diary.
   */

  async function appointmentSoon(opId: string) {
    const t = now(), id = newId();
    await env.DB.prepare(
      `INSERT INTO appointments (id, operator_id, starts_at, ends_at, status, created_at, updated_at)
       VALUES (?,?,?,?, 'scheduled', ?,?)`,
    ).bind(id, opId, t + 7200, t + 10800, t, t).run();
    return id;
  }

  it('GET /api/appointments with no window shows what is coming up', async () => {
    const op = await signIn('window@x.test');
    const id = await appointmentSoon(op.opId);

    const res = await call('GET', '/api/appointments', { cookie: op.cookie });
    const got = await res.json() as { appointments: Array<{ id: string }> };
    expect(got.appointments.map((a) => a.id)).toContain(id);
  });

  it('GET /api/appointments given only a start still has an end', async () => {
    // The half of this that is easy to miss: `to` falls back to `from` plus a
    // fortnight, and that fallback was dead too — so naming `from` by itself
    // closed the window at zero, before the start it had just been given.
    const op = await signIn('window2@x.test');
    const id = await appointmentSoon(op.opId);

    const res = await call('GET', `/api/appointments?from=${now()}`, { cookie: op.cookie });
    const got = await res.json() as { appointments: Array<{ id: string }> };
    expect(got.appointments.map((a) => a.id)).toContain(id);
  });

  it('GET /api/gaps with no window shows an open gap', async () => {
    const op = await signIn('window3@x.test');
    const t = now(), id = newId();
    await env.DB.prepare(
      `INSERT INTO gaps (id, operator_id, starts_at, ends_at, status, created_at, updated_at)
       VALUES (?,?,?,?, 'open', ?,?)`,
    ).bind(id, op.opId, t + 7200, t + 14400, t, t).run();

    const res = await call('GET', '/api/gaps', { cookie: op.cookie });
    const got = await res.json() as { gaps: Array<{ id: string }> };
    expect(got.gaps.map((g) => g.id)).toContain(id);
  });

  it('an explicit window is still obeyed exactly', async () => {
    // The fallback must not become a floor: asking for last week means last
    // week, and a caller who names both ends gets the range they named.
    const op = await signIn('window4@x.test');
    await appointmentSoon(op.opId);
    const t = now();

    const res = await call('GET', `/api/appointments?from=${t - 86400}&to=${t - 3600}`,
      { cookie: op.cookie });
    const got = await res.json() as { appointments: unknown[] };
    expect(got.appointments).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('PATCH /api/settings checks every column it writes', () => {
  /**
   * These are the operating parameters of a business, and the values that
   * break them are ordinary-looking. Every one of these was accepted, and the
   * two the database happened to catch were answered with a 500.
   */

  const patch = (cookie: string, body: unknown) =>
    call('PATCH', '/api/settings', { cookie, body });

  it('refuses offers_per_wave: 0, which silently stops every wave', async () => {
    const op = await signIn('set1@x.test');
    const res = await patch(op.cookie, { offers_per_wave: 0 });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain('offers_per_wave');
    expect(await scalar<number>(
      `SELECT offers_per_wave FROM operators WHERE id = ?`, op.opId)).toBe(3);
  });

  it('refuses a number where the caller sent letters', async () => {
    const op = await signIn('set2@x.test');
    const res = await patch(op.cookie, { min_gap_seconds: 'abc' });
    expect(res.status).toBe(400);
    // Stored as text in an INTEGER column, SQLite keeps it and every
    // comparison gaps.ts makes against it stops being arithmetic.
    expect(await scalar<number>(
      `SELECT min_gap_seconds FROM operators WHERE id = ?`, op.opId)).toBe(3600);
  });

  it('answers a discount outside 0..100 with a message, not a 500', async () => {
    const op = await signIn('set3@x.test');
    for (const bad of [-5, 150]) {
      const res = await patch(op.cookie, { discount_percent: bad });
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toContain('discount_percent');
    }
  });

  it('refuses a language that is not one we write in', async () => {
    const op = await signIn('set4@x.test');
    for (const bad of ['', 'zz', 'not a language']) {
      expect((await patch(op.cookie, { language: bad })).status).toBe(400);
    }
    expect((await patch(op.cookie, { language: 'es' })).status).toBe(200);
    expect(await scalar<string>(
      `SELECT language FROM operators WHERE id = ?`, op.opId)).toBe('es');
  });

  it('refuses a blank business name on a public profile', async () => {
    const op = await signIn('set5@x.test');
    expect((await patch(op.cookie, { business_name: '   ' })).status).toBe(400);
    expect(await scalar<string>(
      `SELECT business_name FROM operators WHERE id = ?`, op.opId)).toBe('A Business');
  });

  it('refuses a mode outside the set the column allows', async () => {
    const op = await signIn('set6@x.test');
    expect((await patch(op.cookie, { location_mode: 'teleport' })).status).toBe(400);
    expect((await patch(op.cookie, { fill_model: 'everyone' })).status).toBe(400);
    expect((await patch(op.cookie, { sms_mode: 'carrier pigeon' })).status).toBe(400);
  });

  it('refuses a home base that is not on Earth', async () => {
    const op = await signIn('set7@x.test');
    expect((await patch(op.cookie, { home_lat: 999 })).status).toBe(400);
    expect((await patch(op.cookie, { home_lng: 'over there' })).status).toBe(400);
    // Null is a real answer: it is "I have no fixed base".
    expect((await patch(op.cookie, { home_lat: null })).status).toBe(200);
  });

  it('normalises the operator phone the way every other number is stored', async () => {
    const op = await signIn('set8@x.test');
    expect((await patch(op.cookie, { phone_e164: 'not a number' })).status).toBe(400);
    expect((await patch(op.cookie, { phone_e164: '310 555 0198' })).status).toBe(200);
    expect(await scalar<string>(
      `SELECT phone_e164 FROM operators WHERE id = ?`, op.opId)).toBe('+13105550198');
  });

  it('still saves the ordinary settings a person actually changes', async () => {
    const op = await signIn('set9@x.test');
    const res = await patch(op.cookie, {
      business_name: 'Renamed', offers_per_wave: 5, discount_percent: 10,
      max_detour_seconds: 1800, min_gap_seconds: 1800, timezone: 'America/Denver',
    });
    expect(res.status).toBe(200);
    expect(await scalar<number>(
      `SELECT offers_per_wave FROM operators WHERE id = ?`, op.opId)).toBe(5);
    expect(await scalar<string>(
      `SELECT timezone FROM operators WHERE id = ?`, op.opId)).toBe('America/Denver');
  });
});

// ---------------------------------------------------------------------------
describe('the cron cadence sweep agrees with the inline completion path', () => {
  /**
   * PATCH /api/appointments sets a due date from the service on the
   * appointment and keeps any existing one when there is no cadence to apply.
   * The sweep took cadence from the client's default service alone and wrapped
   * the result in COALESCE(x, NULL) — nothing to fall back to — so within a
   * day it replaced those due dates with NULL and the customers behind them
   * left the overdue pool the ranker reads.
   */

  /** A completed appointment, as the inline path leaves one. */
  async function completed(opId: string, clientId: string, serviceId: string | null) {
    const t = now(), id = newId();
    await env.DB.prepare(
      `INSERT INTO appointments (id, operator_id, client_id, service_id, starts_at, ends_at,
                                 status, created_at, updated_at)
       VALUES (?,?,?,?,?,?, 'completed', ?,?)`,
    ).bind(id, opId, clientId, serviceId, t - 7200, t - 3600, t, t).run();
    return { id, ends: t - 3600 };
  }

  it('keeps a due date the appointment\'s own service set', async () => {
    const op = await signIn('cad1@x.test');
    // No default service: this is every break-fix trade, and it is the case
    // the sweep could not see at all.
    const sv = await service(op.opId, 30);
    const cl = await client(op.opId, null);
    const appt = await completed(op.opId, cl, sv);

    const res = await call('PATCH', `/api/appointments/${appt.id}`,
      { cookie: op.cookie, body: { status: 'completed' } });
    expect(res.status).toBe(200);
    const inline = await scalar<number>(`SELECT next_due_at FROM clients WHERE id = ?`, cl);
    expect(inline).toBe(appt.ends + 30 * 86400);

    await worker.scheduled({} as ScheduledController, env);

    expect(await scalar<number>(`SELECT next_due_at FROM clients WHERE id = ?`, cl))
      .toBe(inline);
  });

  it('leaves an existing due date alone when nothing repeats', async () => {
    // A one-off job for a client who is on a schedule for something else. The
    // visit does not set a new due date; it also does not cancel the one that
    // is there.
    const op = await signIn('cad2@x.test');
    const oneOff = await service(op.opId, null);
    const cl = await client(op.opId, null);
    const due = now() + 45 * 86400;
    await env.DB.prepare(`UPDATE clients SET next_due_at = ? WHERE id = ?`).bind(due, cl).run();
    await completed(op.opId, cl, oneOff);

    await worker.scheduled({} as ScheduledController, env);

    expect(await scalar<number>(`SELECT next_due_at FROM clients WHERE id = ?`, cl)).toBe(due);
  });

  it('still reconciles a job that reached completed without the API', async () => {
    // The case the sweep exists for — an import or a direct edit — must keep
    // working, and it must use the appointment's service like the inline path.
    const op = await signIn('cad3@x.test');
    const fortnightly = await service(op.opId, 14);
    const yearly = await service(op.opId, 365);
    const cl = await client(op.opId, yearly);
    const appt = await completed(op.opId, cl, fortnightly);

    await worker.scheduled({} as ScheduledController, env);

    expect(await scalar<number>(`SELECT next_due_at FROM clients WHERE id = ?`, cl))
      .toBe(appt.ends + 14 * 86400);
    expect(await scalar<number>(`SELECT visit_count FROM clients WHERE id = ?`, cl)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('the PATCH handlers refuse what their own POST refuses', () => {
  /**
   * Both of these built an UPDATE out of raw body values. SQLite does not
   * enforce column types, so the bad ones were stored; where a CHECK caught
   * one, the caller got "Something went wrong." and a 500 for a typo.
   */

  async function lead(opId: string) {
    const cl = await client(opId, null);
    const id = newId(), t = now();
    await env.DB.prepare(
      `INSERT INTO job_leads (id, operator_id, client_id, title, status, created_at, updated_at)
       VALUES (?,?,?,?, 'open', ?,?)`,
    ).bind(id, opId, cl, 'A job', t, t).run();
    return { id, clientId: cl };
  }

  it('names the field instead of answering 500 on an unknown lead status', async () => {
    const op = await signIn('patch1@x.test');
    const l = await lead(op.opId);
    const res = await call('PATCH', `/api/leads/${l.id}`,
      { cookie: op.cookie, body: { status: 'bogus' } });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain('status');
    expect(await scalar<string>(`SELECT status FROM job_leads WHERE id = ?`, l.id)).toBe('open');
  });

  it('refuses an urgency outside the range that sorts the queue', async () => {
    const op = await signIn('patch2@x.test');
    const l = await lead(op.opId);
    expect((await call('PATCH', `/api/leads/${l.id}`,
      { cookie: op.cookie, body: { urgency: 9 } })).status).toBe(400);
    expect((await call('PATCH', `/api/leads/${l.id}`,
      { cookie: op.cookie, body: { quoted_price_cents: -500 } })).status).toBe(400);
    expect((await call('PATCH', `/api/leads/${l.id}`,
      { cookie: op.cookie, body: { urgency: 4, status: 'won' } })).status).toBe(200);
  });

  it('refuses coordinates and timestamps that are not numbers', async () => {
    const op = await signIn('patch3@x.test');
    const cl = await client(op.opId, null);
    for (const bad of [{ lat: 'not-a-number' }, { lng: 999 }, { next_due_at: 'soon' }]) {
      const res = await call('PATCH', `/api/clients/${cl}`, { cookie: op.cookie, body: bad });
      expect(res.status).toBe(400);
    }
    expect(await scalar<unknown>(`SELECT lat FROM clients WHERE id = ?`, cl)).toBeNull();
  });

  it('checks a client postcode on the way in, as the create path does', async () => {
    const op = await signIn('patch4@x.test');
    const cl = await client(op.opId, null);
    const res = await call('PATCH', `/api/clients/${cl}`,
      { cookie: op.cookie, body: { postcode: 'NOT A ZIP' } });
    expect(res.status).toBe(400);
    expect((await call('PATCH', `/api/clients/${cl}`,
      { cookie: op.cookie, body: { postcode: '91403' } })).status).toBe(200);
  });

  it('clears a default service rather than storing a blank id', async () => {
    // str() gives null for "", so the ownership check was skipped and the
    // empty string went into the column as a service id nothing joins to.
    const op = await signIn('patch5@x.test');
    const sv = await service(op.opId, 30);
    const cl = await client(op.opId, sv);
    const res = await call('PATCH', `/api/clients/${cl}`,
      { cookie: op.cookie, body: { default_service_id: '' } });
    expect(res.status).toBe(200);
    expect(await scalar<unknown>(
      `SELECT default_service_id FROM clients WHERE id = ?`, cl)).toBeNull();
  });

  it('still refuses another business\'s service on a client', async () => {
    const mine = await signIn('patch6@x.test');
    const theirs = await signIn('patch7@x.test');
    const cl = await client(mine.opId, null);
    const sv = await service(theirs.opId, 30);
    const res = await call('PATCH', `/api/clients/${cl}`,
      { cookie: mine.cookie, body: { default_service_id: sv } });
    expect(res.status).toBe(404);
  });

  it('still saves the ordinary edits a person makes', async () => {
    const op = await signIn('patch8@x.test');
    const cl = await client(op.opId, null);
    const res = await call('PATCH', `/api/clients/${cl}`, {
      cookie: op.cookie,
      body: { first_name: 'Alex', lat: 34.15, lng: -118.44, notes: 'Back gate' },
    });
    expect(res.status).toBe(200);
    expect(await scalar<number>(`SELECT lat FROM clients WHERE id = ?`, cl)).toBeCloseTo(34.15);
    expect(await scalar<string>(`SELECT first_name FROM clients WHERE id = ?`, cl)).toBe('Alex');
  });
});
