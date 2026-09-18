import { beforeEach, describe, expect, it } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import worker from '../src/index';
import type { Env } from '../src/types';
import { newId, now } from '../src/lib/util';

/**
 * THE TWO SWITCHES A BUSINESS HAS, TESTED THROUGH THE ROUTER.
 *
 * Both of these are one line of SQL behind an HTTP route, and both were built
 * because the thing they change had no way to be changed:
 *
 *   accept_public_bookings was read by a dozen public queries — the map, the
 *   search pages, the browse lists, the profile — and settable by nothing. A
 *   business wanting to stop being listed for a fortnight had to delete their
 *   openings one at a time.
 *
 *   customer mode did not exist at all. A detailer who needed a locksmith had
 *   to make a second account under a second mailbox.
 *
 * These go through worker.fetch rather than calling the functions directly,
 * because what is being defended is the ROUTE: that it exists, that it wants a
 * business session, and that the cookie it sets is the customer's and not a
 * replacement for the operator's.
 */

const BASE = 'https://gap.test';
let env: Env;

beforeEach(async () => { env = makeEnv(ALL_MIGRATIONS) as unknown as Env; });

function makeReq(method: string, path: string, opts: {
  body?: unknown; cookie?: string;
} = {}) {
  const headers: Record<string, string> = { 'cf-connecting-ip': '203.0.113.11' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = opts.cookie;
  return new Request(`${BASE}${path}`, {
    method, headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

const call = (method: string, path: string, opts?: Parameters<typeof makeReq>[2]) =>
  worker.fetch(makeReq(method, path, opts), env, {} as ExecutionContext);

/** A business with a live session, made directly so no mail has to be sent. */
async function signIn(email: string | null = 'switches@example.com') {
  const t = now();
  const opId = newId();
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,timezone,country,currency,
       location_mode,fill_model,sms_mode,plan,accept_public_bookings,created_at,updated_at)
     VALUES (?,?,'Valley Detailing','America/Los_Angeles','US','USD','mobile','both',
       'device','active',1,?,?)`,
  ).bind(opId, email, t, t).run();

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

const listedFlag = async (opId: string) =>
  (await env.DB.prepare(`SELECT accept_public_bookings AS f FROM operators WHERE id = ?`)
    .bind(opId).first<{ f: number }>())!.f;

describe('taking bookings, or paused', () => {
  it('turns the listing off and back on', async () => {
    const { opId, cookie } = await signIn();
    expect(await listedFlag(opId)).toBe(1);

    expect((await call('PATCH', '/api/settings',
      { cookie, body: { accept_public_bookings: false } })).status).toBe(200);
    expect(await listedFlag(opId)).toBe(0);

    expect((await call('PATCH', '/api/settings',
      { cookie, body: { accept_public_bookings: true } })).status).toBe(200);
    expect(await listedFlag(opId)).toBe(1);
  });

  it('refuses a value that is neither on nor off', async () => {
    // A front end sending the STRING "false" and getting a listed business
    // back is the bug this rejects — it looks like it worked and hides for
    // months. Anything that is not plainly one or the other is refused.
    const { opId, cookie } = await signIn();
    const res = await call('PATCH', '/api/settings',
      { cookie, body: { accept_public_bookings: 'maybe' } });
    expect(res.status).toBe(400);
    expect(await listedFlag(opId)).toBe(1);
  });

  it('is nobody else\'s switch to throw', async () => {
    const { opId } = await signIn();
    const res = await call('PATCH', '/api/settings',
      { body: { accept_public_bookings: false } });
    expect(res.status).toBe(401);
    expect(await listedFlag(opId)).toBe(1);
  });
});

describe('a business booking other businesses', () => {
  it('opens a customer side and hands back its cookie', async () => {
    const { opId, cookie } = await signIn('detailer@example.com');
    const res = await call('POST', '/api/operator/customer-mode', { cookie });
    expect(res.status).toBe(200);

    // The customer's cookie, and only it. Replacing the operator's would mean
    // switching back was a sign-in rather than a link, which is the entire
    // reason the two identities have different cookie names.
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^__Host-sf_customer=/);
    expect(setCookie).not.toMatch(/__Host-gf_session/);

    const linked = await env.DB.prepare(
      `SELECT operator_id FROM customer_accounts WHERE operator_id = ?`,
    ).bind(opId).first<{ operator_id: string }>();
    expect(linked?.operator_id).toBe(opId);
  });

  it('gives the same account back the second time', async () => {
    const { cookie } = await signIn('again@example.com');
    await call('POST', '/api/operator/customer-mode', { cookie });
    const second = await call('POST', '/api/operator/customer-mode', { cookie });
    expect(second.status).toBe(200);
    expect((await second.json() as { created: boolean }).created).toBe(false);

    const n = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM customer_accounts`,
    ).first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it('is not a door into anybody\'s account without a business session', async () => {
    await signIn('quiet@example.com');
    const res = await call('POST', '/api/operator/customer-mode');
    expect(res.status).toBe(401);
    const n = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM customer_accounts`,
    ).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it('has no route the other way', async () => {
    // Becoming a business means a bank account, a vehicle, location sharing
    // and working hours. If a matching toggle ever appears, this fails and
    // whoever added it has to come and read why it was refused.
    const { cookie } = await signIn('oneway@example.com');
    const res = await call('POST', '/api/customer/operator-mode', { cookie });
    expect(res.status).toBe(404);
  });
});
