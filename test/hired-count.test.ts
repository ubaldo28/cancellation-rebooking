import { describe, expect, it, beforeEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import worker from '../src/index';
import type { Env } from '../src/types';
import { newId, now } from '../src/lib/util';

/**
 * The public "Hired N times" number on a listing card and a profile.
 *
 * Migration 0027 added `operators.hired_count` and nothing ever wrote to it,
 * so every real business advertised nought hires forever while the seeded
 * sample businesses showed figures. These cases pin the one write that fixes
 * that: the transition of an appointment into 'completed'. They are grouped by
 * the way the count was wrong rather than by route, because the interesting
 * failures are all the same route called twice.
 */

const MIGRATIONS = ALL_MIGRATIONS;
const BASE = 'https://gap.test';

let env: Env;

function makeReq(method: string, path: string, opts: {
  body?: unknown; cookie?: string;
} = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers['cookie'] = opts.cookie;
  return new Request(`${BASE}${path}`, {
    method, headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

const call = (method: string, path: string, opts?: Parameters<typeof makeReq>[2]) =>
  worker.fetch(makeReq(method, path, opts), env, {} as ExecutionContext);

/** Create an operator directly and mint a session, bypassing email. */
async function signIn(email: string, businessName: string) {
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

/** A regular client on the operator's books, the way a manual booking has one. */
async function addClient(opId: string, name = 'Rosa') {
  const t = now();
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO clients (id,operator_id,first_name,phone_e164,geocode_status,
       created_at,updated_at)
     VALUES (?,?,?,?, 'ok',?,?)`,
  ).bind(id, opId, name, '+13105550142', t, t).run();
  return id;
}

/**
 * Book a job through the API, an hour long, `hoursOut` hours from now.
 * The offset exists so several appointments in one test do not trip the
 * double-booking guard and fail for a reason that has nothing to do with the
 * count.
 */
async function book(cookie: string, hoursOut: number, clientId?: string) {
  const start = now() + hoursOut * 3600;
  const res = await call('POST', '/api/appointments', {
    cookie,
    body: { starts_at: start, ends_at: start + 3600, client_id: clientId, price_cents: 9900 },
  });
  expect(res.status).toBe(201);
  return (await res.json() as { id: string }).id;
}

/** Set an appointment's status the way the operator's "done" button does. */
async function setStatus(cookie: string, apptId: string, status: string) {
  const res = await call('PATCH', `/api/appointments/${apptId}`, {
    cookie, body: { status },
  });
  expect(res.status).toBe(200);
  return res;
}

const hiredCount = async (opId: string) =>
  (await env.DB.prepare(`SELECT hired_count FROM operators WHERE id = ?`)
    .bind(opId).first<{ hired_count: number }>())!.hired_count;

beforeEach(() => { env = makeEnv(MIGRATIONS) as unknown as Env; });

// ---------------------------------------------------------------------------
describe('finishing a job is what counts as a hire', () => {
  it('raises the count by exactly one when a job is marked done', async () => {
    const { opId, cookie } = await signIn('a@example.com', 'Valley Detailing');
    const clientId = await addClient(opId);
    const apptId = await book(cookie, 4, clientId);

    // A brand new business starts at nought, which is the state that used to
    // be permanent no matter how much work it did.
    expect(await hiredCount(opId)).toBe(0);

    await setStatus(cookie, apptId, 'completed');
    expect(await hiredCount(opId)).toBe(1);
  });

  it('does not count the same job twice when the operator saves it again', async () => {
    const { opId, cookie } = await signIn('a@example.com', 'Valley Detailing');
    const clientId = await addClient(opId);
    const apptId = await book(cookie, 4, clientId);

    // Saving a finished job a second time is ordinary -- the operator reopens
    // it to add a price or a note. The count is public, so a second save must
    // not inflate it; that is why the write is guarded on the transition into
    // 'completed' and not merely on the status being 'completed'.
    await setStatus(cookie, apptId, 'completed');
    await setStatus(cookie, apptId, 'completed');
    expect(await hiredCount(opId)).toBe(1);

    // Editing a field on an already-finished job is the same hazard wearing
    // different clothes: the status travels along in the body untouched.
    const res = await call('PATCH', `/api/appointments/${apptId}`, {
      cookie, body: { status: 'completed', notes: 'Paid in cash.' },
    });
    expect(res.status).toBe(200);
    expect(await hiredCount(opId)).toBe(1);
  });

  it('counts a job booked by a stranger who never became a client record', async () => {
    const { opId, cookie } = await signIn('a@example.com', 'Valley Detailing');
    // A booking taken off the public map has no row in `clients`; the customer
    // is a passer-by, not somebody on the operator's books. That is precisely
    // the hire this number exists to advertise, so the count must not depend
    // on a client row the way the cadence bookkeeping beside it does.
    const apptId = await book(cookie, 4);

    await setStatus(cookie, apptId, 'completed');
    expect(await hiredCount(opId)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('a job that never happened is not a hire', () => {
  it('leaves the count alone when a job is cancelled', async () => {
    const { opId, cookie } = await signIn('a@example.com', 'Valley Detailing');
    const clientId = await addClient(opId);
    const apptId = await book(cookie, 4, clientId);

    // Cancelling also ends the appointment and also refreshes the calendar, so
    // it runs through most of the same code as completing it. Nobody was
    // served, so nobody hired anybody.
    await setStatus(cookie, apptId, 'cancelled');
    expect(await hiredCount(opId)).toBe(0);
  });

  it('leaves the count alone when the customer does not turn up', async () => {
    const { opId, cookie } = await signIn('a@example.com', 'Valley Detailing');
    const clientId = await addClient(opId);
    const apptId = await book(cookie, 4, clientId);

    // A no-show already increments a counter of its own on the client, so the
    // risk here is the two bookkeeping steps being confused for each other.
    await setStatus(cookie, apptId, 'no_show');
    expect(await hiredCount(opId)).toBe(0);

    const client = await env.DB.prepare(`SELECT no_show_count FROM clients WHERE id = ?`)
      .bind(clientId).first<{ no_show_count: number }>();
    expect(client!.no_show_count).toBe(1);
  });

  it('counts a job that was rescued after being cancelled only once', async () => {
    const { opId, cookie } = await signIn('a@example.com', 'Valley Detailing');
    const clientId = await addClient(opId);
    const apptId = await book(cookie, 4, clientId);

    // Customers put a job back on, and operators fix a status they tapped by
    // mistake. What matters is that the job ends up done exactly once, however
    // many statuses it passed through on the way.
    await setStatus(cookie, apptId, 'cancelled');
    await setStatus(cookie, apptId, 'scheduled');
    await setStatus(cookie, apptId, 'completed');
    expect(await hiredCount(opId)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('the count belongs to the business that did the work', () => {
  it('credits only the operator who owns the appointment', async () => {
    const a = await signIn('a@example.com', 'Valley Detailing');
    const b = await signIn('b@example.com', 'Encino Barbers');
    const aClient = await addClient(a.opId, 'Rosa');
    const bClient = await addClient(b.opId, 'Dev');

    const aAppt = await book(a.cookie, 4, aClient);
    // The second business has a job of its own on the books, so a stray
    // increment landing on the wrong row would have somewhere plausible to go
    // rather than being obviously nonsense.
    await book(b.cookie, 4, bClient);

    await setStatus(a.cookie, aAppt, 'completed');
    expect(await hiredCount(a.opId)).toBe(1);
    expect(await hiredCount(b.opId)).toBe(0);
  });

  it('does not let another business finish a job it does not own', async () => {
    const a = await signIn('a@example.com', 'Valley Detailing');
    const b = await signIn('b@example.com', 'Encino Barbers');
    const apptId = await book(a.cookie, 4, await addClient(a.opId));

    // Nothing about the count may become a way to reach across businesses: the
    // route must not find the appointment at all, and neither count moves.
    const res = await call('PATCH', `/api/appointments/${apptId}`, {
      cookie: b.cookie, body: { status: 'completed' },
    });
    expect(res.status).toBe(404);
    expect(await hiredCount(a.opId)).toBe(0);
    expect(await hiredCount(b.opId)).toBe(0);
  });

  it('adds one per finished job, so a busy day accumulates', async () => {
    const { opId, cookie } = await signIn('a@example.com', 'Valley Detailing');
    const clientId = await addClient(opId);
    const first = await book(cookie, 4, clientId);
    const second = await book(cookie, 8, clientId);
    const third = await book(cookie, 12, clientId);

    // Three separate jobs for the same returning customer are three hires, and
    // the count reads them off the appointments rather than off the client.
    await setStatus(cookie, first, 'completed');
    await setStatus(cookie, second, 'completed');
    await setStatus(cookie, third, 'cancelled');
    expect(await hiredCount(opId)).toBe(2);
  });
});
