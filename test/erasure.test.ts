import { describe, expect, it, beforeEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import worker from '../src/index';
import type { Env } from '../src/types';
import { newId, now, sha256 } from '../src/lib/util';

/**
 * Deleting things, proved by counting rows rather than by reading a flag.
 *
 * Every assertion here is against the database after the call, because the
 * failure this file exists to prevent is the one where "deleted" means a
 * column set to 1 and the phone number still sitting in the row underneath.
 * The tests that matter most are the ones checking what SURVIVES: a settled
 * amount of money, and a live ban.
 */

const BASE = 'https://gap.test';
let env: Env;
let objects: Map<string, Uint8Array>;

function fakeBucket() {
  objects = new Map();
  return {
    put: async (key: string) => { objects.set(key, new Uint8Array()); return {}; },
    get: async (key: string) => (objects.has(key) ? { body: null } : null),
    delete: async (key: string) => { objects.delete(key); },
  };
}

function makeReq(method: string, path: string, opts: {
  body?: unknown; cookie?: string; ip?: string;
} = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers['cookie'] = opts.cookie;
  headers['cf-connecting-ip'] = opts.ip ?? '203.0.113.77';
  return new Request(`${BASE}${path}`, {
    method, headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

const call = (method: string, path: string, opts?: Parameters<typeof makeReq>[2]) =>
  worker.fetch(makeReq(method, path, opts), env, {} as ExecutionContext);

const one = <T>(sql: string, ...args: unknown[]) =>
  env.DB.prepare(sql).bind(...args).first<T>();
const count = async (sql: string, ...args: unknown[]) =>
  (await one<{ n: number }>(`SELECT COUNT(*) AS n ${sql}`, ...args))?.n ?? 0;

const peppered = (raw: string) => sha256(`${raw}:${env.SESSION_PEPPER}`);

const OP = 'op-erasure';
const PHONE = '+13105550147';
const EMAIL = 'rosa@example.com';

async function seedOperator(id = OP, email = 'op@example.com') {
  const t = now();
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,phone_e164,timezone,country,currency,
       location_mode,fill_model,sms_mode,plan,home_address,home_lat,home_lng,
       license_number,policy_number,background_check_name,vehicle_plate,
       created_at,updated_at)
     VALUES (?,?, 'Sparkle Detailing','+13105550100','America/Los_Angeles','US','USD',
       'mobile','both','device','active','4 Rosewood Ave',34.05,-118.25,
       'C-27 998811','POL-4471','Maria Alvarez','8ABC123',?,?)`,
  ).bind(id, email, t, t).run();
}

async function sessionFor(opId: string) {
  const raw = `sess-${opId}-${newId()}`;
  const t = now();
  await env.DB.prepare(
    `INSERT INTO sessions (id,operator_id,token_hash,expires_at,created_at)
     VALUES (?,?,?,?,?)`,
  ).bind(newId(), opId, await peppered(raw), t + 86400, t).run();
  return `gf_session=${raw}`;
}

/**
 * One customer with a full footprint: a booking, a conversation, a photo of
 * their hallway, a review, an alert on their mailbox and a client row.
 */
async function seedCustomer(token = 'guest-token-rosa') {
  const t = now();
  const apptId = 'a-rosa';
  const orderId = 'o-rosa';
  const itemId = 'i-rosa';
  const clientId = 'c-rosa';
  const gapId = 'g-rosa';

  await env.DB.prepare(
    `INSERT INTO clients (id,operator_id,first_name,last_name,phone_e164,email,
       address_line,postcode,lat,lng,acquired,created_at,updated_at)
     VALUES (?,?, 'Rosa','Delgado',?,?, '15200 Ventura Blvd','91403',34.151,-118.445,
       'public',?,?)`,
  ).bind(clientId, OP, PHONE, EMAIL, t, t).run();

  await env.DB.prepare(
    `INSERT INTO appointments (id,operator_id,client_id,starts_at,ends_at,status,
       address_line,postcode,lat,lng,notes,created_at,updated_at)
     VALUES (?,?,?,?,?, 'completed','15200 Ventura Blvd','91403',34.151,-118.445,
       'side gate unlocked',?,?)`,
  ).bind(apptId, OP, clientId, t - 7200, t - 3600, t, t).run();

  await env.DB.prepare(
    `INSERT INTO orders (id,status,guest_name,phone_e164,email,address_line,postcode,
       lat,lng,currency,total_cents,created_at,updated_at)
     VALUES (?, 'confirmed','Rosa Delgado',?,?, '15200 Ventura Blvd','91403',
       34.151,-118.445,'USD',12500,?,?)`,
  ).bind(orderId, PHONE, EMAIL, t, t).run();

  await env.DB.prepare(
    `INSERT INTO order_items (id,order_id,operator_id,appointment_id,client_id,
       starts_at,ends_at,duration_seconds,price_cents,created_at)
     VALUES (?,?,?,?,?,?,?,3600,12500,?)`,
  ).bind(itemId, orderId, OP, apptId, clientId, t - 7200, t - 3600, t).run();

  await env.DB.prepare(
    `INSERT INTO gaps (id,operator_id,starts_at,ends_at,status,created_at,updated_at)
     VALUES (?,?,?,?, 'filled',?,?)`,
  ).bind(gapId, OP, t - 7200, t - 3600, t, t).run();

  await env.DB.prepare(
    `INSERT INTO public_claims (id,operator_id,gap_id,client_id,appointment_id,first_name,
       phone_e164,email,address_line,postcode,lat,lng,price_cents,status,created_at,updated_at)
     VALUES (?,?,?,?,?, 'Rosa',?,?, '15200 Ventura Blvd','91403',34.151,-118.445,
       12500,'confirmed',?,?)`,
  ).bind(newId(), OP, gapId, clientId, apptId, PHONE, EMAIL, t, t).run();

  await env.DB.prepare(
    `INSERT INTO threads (id,operator_id,appointment_id,client_id,guest_name,
       guest_token_hash,last_message_at,status,created_at,updated_at)
     VALUES ('th-rosa',?,?,?, 'Rosa', ?, ?, 'open', ?, ?)`,
  ).bind(OP, apptId, clientId, await peppered(token), t, t, t).run();

  await env.DB.prepare(
    `INSERT INTO chat_messages (id,thread_id,sender,body,created_at)
     VALUES (?, 'th-rosa','guest','the side gate is unlocked',?)`,
  ).bind(newId(), t).run();

  const key = `j/${OP}/${itemId}/photo-1`;
  await env.DB.prepare(
    `INSERT INTO job_photos (id,order_item_id,operator_id,uploaded_by,stage,r2_key,
       content_type,bytes,created_at,public_on_review)
     VALUES ('ph-rosa',?,?, 'customer','after',?, 'image/jpeg',1024,?,1)`,
  ).bind(itemId, OP, key, t).run();
  objects.set(key, new Uint8Array());

  await env.DB.prepare(
    `INSERT INTO reviews (id,operator_id,order_item_id,author_name,rating,body,
       created_at,updated_at)
     VALUES ('rv-rosa',?,?, 'Rosa Delgado',5,'Spotless, on time',?,?)`,
  ).bind(OP, itemId, t, t).run();

  await env.DB.prepare(
    `INSERT INTO watches (id,token_hash,postcode,lat,lng,country,max_detour_seconds,
       active,notify_count,email,created_at,updated_at)
     VALUES ('w-rosa','wh-rosa','91403',34.151,-118.445,'US',900,1,0,?,?,?)`,
  ).bind(EMAIL, t, t).run();

  await env.DB.prepare(
    `INSERT INTO instant_requests (id,operator_id,starts_at,duration_seconds,price_cents,
       currency,guest_name,phone_e164,status,expires_at,created_at,updated_at)
     VALUES (?,?,?,3600,12500,'USD','Rosa',?, 'expired',?,?,?)`,
  ).bind(newId(), OP, t, PHONE, t + 300, t, t).run();

  return { token, orderId, itemId, apptId, clientId };
}

beforeEach(async () => {
  env = { ...makeEnv(ALL_MIGRATIONS), PHOTOS: fakeBucket() } as unknown as Env;
  await seedOperator();
});

// ---------------------------------------------------------------------------
describe('a customer asking to be erased', () => {
  it('really removes the rows, and the photographs out of the bucket', async () => {
    const { token, clientId } = await seedCustomer();

    const res = await call('DELETE', `/api/public/threads/${token}/data`);
    expect(res.status).toBe(200);

    // Not a flag. The rows are gone.
    expect(await count(`FROM threads WHERE id = 'th-rosa'`)).toBe(0);
    expect(await count(`FROM chat_messages`)).toBe(0);
    expect(await count(`FROM job_photos`)).toBe(0);
    expect(await count(`FROM clients WHERE id = ?`, clientId)).toBe(0);
    expect(await count(`FROM instant_requests`)).toBe(0);
    expect(await count(`FROM watches WHERE email = ?`, EMAIL)).toBe(0);
    // The file, not just the pointer at it.
    expect(objects.size).toBe(0);
  });

  it('empties every column that names the person, on rows that stay', async () => {
    const { token } = await seedCustomer();
    await call('DELETE', `/api/public/threads/${token}/data`);

    const order = await one<{
      guest_name: string; phone_e164: string | null; email: string | null;
      address_line: string | null; lat: number | null; total_cents: number; currency: string;
    }>(`SELECT * FROM orders WHERE id = 'o-rosa'`);
    expect(order?.phone_e164).toBeNull();
    expect(order?.email).toBeNull();
    expect(order?.address_line).toBeNull();
    expect(order?.lat).toBeNull();
    expect(order?.guest_name).toBe('Removed');

    const appt = await one<{ address_line: string | null; lat: number | null; notes: string | null }>(
      `SELECT address_line, lat, notes FROM appointments WHERE id = 'a-rosa'`);
    expect(appt?.address_line).toBeNull();
    expect(appt?.lat).toBeNull();
    // "the side gate is unlocked" is about a house, and it is the note a
    // scrub that only looked at address columns would leave behind.
    expect(appt?.notes).toBeNull();

    const claim = await one<{ phone_e164: string | null; first_name: string; lat: number | null }>(
      `SELECT phone_e164, first_name, lat FROM public_claims`);
    // Kept as a row because its unique index on gap_id is the double-booking
    // guard, and emptied of everything that names anybody.
    expect(claim?.phone_e164).toBe('');
    expect(claim?.lat).toBeNull();
    expect(claim?.first_name).toBe('Removed');
  });

  it('keeps the money, because a settled transaction is not one party\'s to delete', async () => {
    const { token, itemId } = await seedCustomer();
    await env.DB.prepare(
      `INSERT INTO lead_fees (id,operator_id,order_item_id,cents,currency,reason,status,
         created_at,updated_at)
       VALUES (?,?,?, 3125,'USD','cancelled_late','owed',?,?)`,
    ).bind(newId(), OP, itemId, now(), now()).run();

    await call('DELETE', `/api/public/threads/${token}/data`);

    const order = await one<{ total_cents: number; currency: string }>(
      `SELECT total_cents, currency FROM orders WHERE id = 'o-rosa'`);
    expect(order?.total_cents).toBe(12500);
    expect(order?.currency).toBe('USD');
    expect(await count(`FROM order_items WHERE id = ?`, itemId)).toBe(1);
    expect(await count(`FROM lead_fees`)).toBe(1);
  });

  it('keeps the review and takes the name off it', async () => {
    const { token } = await seedCustomer();
    await call('DELETE', `/api/public/threads/${token}/data`);

    const review = await one<{ author_name: string; rating: number; body: string }>(
      `SELECT author_name, rating, body FROM reviews WHERE id = 'rv-rosa'`);
    // Other customers rely on the score. The name is the part that identifies
    // anybody, and it is the part that goes.
    expect(review?.rating).toBe(5);
    expect(review?.body).toBe('Spotless, on time');
    expect(review?.author_name).toBe('A customer');
  });

  it('does not lift a live ban', async () => {
    const { token } = await seedCustomer();
    const t = now();
    await env.DB.prepare(
      `INSERT INTO customer_standing (phone_e164,no_show_strikes,banned_at,created_at,updated_at)
       VALUES (?,4,?,?,?)`,
    ).bind(PHONE, t, t, t).run();

    const res = await call('DELETE', `/api/public/threads/${token}/data`);
    const body = await res.json() as { standing_retained: boolean };

    // Otherwise "delete my data" is also the button that clears a ban, and
    // every suspended customer finds that out within a week of the first one.
    expect(body.standing_retained).toBe(true);
    expect(await count(`FROM customer_standing WHERE phone_e164 = ?`, PHONE)).toBe(1);
  });

  it('deletes a standing record whose sanction has already lapsed', async () => {
    const { token } = await seedCustomer();
    const t = now();
    await env.DB.prepare(
      `INSERT INTO customer_standing (phone_e164,no_show_strikes,suspended_until,
         created_at,updated_at) VALUES (?,1,?,?,?)`,
    ).bind(PHONE, t - 86400, t, t).run();

    const res = await call('DELETE', `/api/public/threads/${token}/data`);
    expect((await res.json() as { standing_retained: boolean }).standing_retained).toBe(false);
    expect(await count(`FROM customer_standing WHERE phone_e164 = ?`, PHONE)).toBe(0);
  });

  it('leaves a receipt that is not itself a copy of the number', async () => {
    const { token } = await seedCustomer();
    await call('DELETE', `/api/public/threads/${token}/data`);

    const receipt = await one<{ subject_kind: string; subject_hash: string; rows_removed: number }>(
      `SELECT subject_kind, subject_hash, rows_removed FROM erasures`);
    expect(receipt?.subject_kind).toBe('customer');
    expect(receipt?.rows_removed).toBeGreaterThan(0);
    // The one row that survives an erasure must not be the one holding what
    // was erased.
    expect(receipt?.subject_hash).not.toContain('3105550147');
    expect(receipt?.subject_hash).toBe(await peppered(PHONE));
  });

  it('erases a conversation that never became a booking', async () => {
    const t = now();
    await env.DB.prepare(
      `INSERT INTO threads (id,operator_id,guest_name,guest_token_hash,last_message_at,
         status,created_at,updated_at)
       VALUES ('th-ask',?, 'Rosa', ?, ?, 'open', ?, ?)`,
    ).bind(OP, await peppered('guest-ask'), t, t, t).run();

    const res = await call('DELETE', '/api/public/threads/guest-ask/data');
    expect(res.status).toBe(200);
    expect(await count(`FROM threads`)).toBe(0);
  });

  it('refuses a link that resolves to nothing', async () => {
    const res = await call('DELETE', '/api/public/threads/not-a-real-token/data');
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
describe('an operator closing their account', () => {
  it('empties the personal columns rather than setting a flag beside them', async () => {
    const cookie = await sessionFor(OP);
    const res = await call('POST', '/api/account/close', { cookie });
    expect(res.status).toBe(200);

    const row = await one<Record<string, unknown>>(
      `SELECT * FROM operators WHERE id = ?`, OP);
    expect(row?.phone_e164).toBeNull();
    expect(row?.home_address).toBeNull();
    expect(row?.home_lat).toBeNull();
    expect(row?.license_number).toBeNull();
    expect(row?.policy_number).toBeNull();
    expect(row?.background_check_name).toBeNull();
    expect(row?.vehicle_plate).toBeNull();
    expect(row?.business_name).toBe('Closed business');
    expect(String(row?.email)).not.toContain('op@example.com');
    expect(row?.closed_at).not.toBeNull();
    // The row survives only so the financial records can still point at it.
    expect(row?.plan).toBe('cancelled');
    expect(row?.country).toBe('US');
  });

  it('takes their customers\' data with it', async () => {
    await seedCustomer();
    const cookie = await sessionFor(OP);
    await call('POST', '/api/account/close', { cookie });

    // Somebody else's name, number and conversation only ever existed here
    // because this account did.
    expect(await count(`FROM clients WHERE operator_id = ?`, OP)).toBe(0);
    expect(await count(`FROM threads WHERE operator_id = ?`, OP)).toBe(0);
    expect(await count(`FROM chat_messages`)).toBe(0);
    expect(await count(`FROM instant_requests WHERE operator_id = ?`, OP)).toBe(0);
  });

  it('deletes the portfolio out of the bucket', async () => {
    const t = now();
    await env.DB.prepare(
      `INSERT INTO work_photos (id,operator_id,r2_key,content_type,created_at,updated_at)
       VALUES (?,?, 'w/op/1','image/jpeg',?,?)`,
    ).bind(newId(), OP, t, t).run();
    objects.set('w/op/1', new Uint8Array());

    const cookie = await sessionFor(OP);
    await call('POST', '/api/account/close', { cookie });

    expect(await count(`FROM work_photos`)).toBe(0);
    expect(objects.has('w/op/1')).toBe(false);
  });

  it('keeps the settled financial record of work that happened', async () => {
    const { itemId } = await seedCustomer();
    await env.DB.prepare(
      `INSERT INTO lead_fees (id,operator_id,order_item_id,cents,currency,reason,status,
         created_at,updated_at)
       VALUES (?,?,?, 3125,'USD','no_show','owed',?,?)`,
    ).bind(newId(), OP, itemId, now(), now()).run();

    const cookie = await sessionFor(OP);
    await call('POST', '/api/account/close', { cookie });

    expect(await count(`FROM order_items WHERE id = ?`, itemId)).toBe(1);
    expect(await count(`FROM lead_fees`)).toBe(1);
    expect(await count(`FROM orders WHERE id = 'o-rosa'`)).toBe(1);
  });

  it('ends the session that closed it, and every other one', async () => {
    const cookie = await sessionFor(OP);
    const closed = await call('POST', '/api/account/close', { cookie });
    expect(closed.headers.get('set-cookie')).toContain('Max-Age=0');

    // And a magic link already sitting in the mailbox cannot mint a new one:
    // requireOperator refuses on closed_at, not only on the revoked session.
    expect((await call('GET', '/api/me', { cookie })).status).toBe(401);
  });

  it('refuses a second close rather than writing the scrub twice', async () => {
    const cookie = await sessionFor(OP);
    await call('POST', '/api/account/close', { cookie });
    const again = await sessionFor(OP);
    expect((await call('POST', '/api/account/close', { cookie: again })).status).toBe(401);
  });

  it('refuses while somebody is still expecting them on Thursday', async () => {
    const t = now();
    await env.DB.prepare(
      `INSERT INTO appointments (id,operator_id,starts_at,ends_at,status,created_at,updated_at)
       VALUES ('a-live',?,?,?, 'scheduled',?,?)`,
    ).bind(OP, t + 3 * 86400, t + 3 * 86400 + 3600, t, t).run();

    const cookie = await sessionFor(OP);
    const res = await call('POST', '/api/account/close', { cookie });
    expect(res.status).toBe(400);
    expect((await res.json() as { code: string }).code).toBe('live_bookings');

    // And nothing was half-done on the way to refusing.
    const row = await one<{ email: string; closed_at: number | null }>(
      `SELECT email, closed_at FROM operators WHERE id = ?`, OP);
    expect(row?.email).toBe('op@example.com');
    expect(row?.closed_at).toBeNull();
  });

  it('allows it once the diary is clear', async () => {
    const t = now();
    await env.DB.prepare(
      `INSERT INTO appointments (id,operator_id,starts_at,ends_at,status,created_at,updated_at)
       VALUES ('a-done',?,?,?, 'completed',?,?)`,
    ).bind(OP, t - 7200, t - 3600, t, t).run();

    const cookie = await sessionFor(OP);
    expect((await call('POST', '/api/account/close', { cookie })).status).toBe(200);
  });

  it('leaves other operators completely alone', async () => {
    await seedOperator('op-other', 'other@example.com');
    const cookie = await sessionFor(OP);
    await call('POST', '/api/account/close', { cookie });

    const other = await one<{ email: string; phone_e164: string | null }>(
      `SELECT email, phone_e164 FROM operators WHERE id = 'op-other'`);
    expect(other?.email).toBe('other@example.com');
    expect(other?.phone_e164).toBe('+13105550100');
  });
});
