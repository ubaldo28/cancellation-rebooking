import { describe, expect, it, beforeEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import { fakeKV, type FakeKV } from './kv';
import worker from '../src/index';
import type { Env } from '../src/types';
import { closeOperatorAccount } from '../src/lib/retention';
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
let photos: FakeKV;
/** The backing map, named as it was when this was a fake R2 bucket. */
let objects: FakeKV['entries'];

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
/**
 * The identity, and therefore the scope of an erasure.
 *
 * It was the mobile number until migration 0038. The number is still on the
 * order, the client row, the claim digest and the instant request below --
 * those are records of a job, and a job genuinely had a number on it -- but
 * nobody has proved one since 0038, so it is no longer what ties this person's
 * rows together. The address is.
 */
const LOGIN = 'erased@mailbox.test';
/** The contact number on the job. Reached THROUGH the address, never keyed on. */
const PHONE = '+13105550147';
/** The mailbox on the order and on her openings alert. */
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
  return `__Host-gf_session=${raw}`;
}

/**
 * A photograph sent inside a conversation: migration 0051's table.
 *
 * Seeded in both halves, the row and the bytes, because the two halves are the
 * whole point of this table. `photo_key` is the ONLY record of where the
 * picture is — 0051 gives the table no foreign keys precisely so that no
 * cascade can delete the row and leave the bytes unnameable — so a test that
 * only counted rows would pass on an erasure that deleted the pointer and left
 * the photograph of somebody's kitchen in the store forever.
 */
async function messagePhoto(id: string, threadId: string, itemId: string | null) {
  const key = `c/${OP}/${id}`;
  await env.DB.prepare(
    `INSERT INTO message_photos (id,message_id,thread_id,operator_id,order_item_id,
       photo_key,content_type,bytes,width,height,created_at)
     VALUES (?,?,?,?,?,?, 'image/jpeg',2048,800,600,?)`,
  ).bind(id, `m-${id}`, threadId, OP, itemId, key, now()).run();
  photos.seed(key, 'image/jpeg');
  return key;
}

/**
 * One customer with a full footprint: a booking, a conversation, a photo of
 * their hallway, a photograph sent in the conversation itself, a review, an
 * alert on their mailbox and a client row.
 */
async function seedCustomer(token = 'guest-token-rosa') {
  const t = now();
  const apptId = 'a-rosa';
  const orderId = 'o-rosa';
  const itemId = 'i-rosa';
  const clientId = 'c-rosa';
  const gapId = 'g-rosa';

  // THE SHAPE A PLATFORM BOOKING ACTUALLY WRITES, which this fixture used to
  // get wrong in the one way that mattered. It carried a phone number and a
  // mailbox on the client row; the inserts in public.ts and orders.ts write
  // NULL into both columns and set platform_introduced = 1, and migration 0023
  // cleared them on every row that already existed. Seeding a number here made
  // the old `DELETE FROM clients WHERE phone_e164 IN (...)` look like it
  // worked, when against a real row it matched nothing and could never match
  // anything — `NULL IN (...)` is never true. The fixture is the production
  // shape now, so the test is about the erasure rather than about itself.
  await env.DB.prepare(
    `INSERT INTO clients (id,operator_id,first_name,last_name,phone_e164,email,
       address_line,postcode,lat,lng,acquired,platform_introduced,
       created_at,updated_at)
     VALUES (?,?, 'Rosa',NULL,NULL,NULL, '15200 Ventura Blvd','91403',34.151,-118.445,
       'public',1,?,?)`,
  ).bind(clientId, OP, t, t).run();

  await env.DB.prepare(
    `INSERT INTO appointments (id,operator_id,client_id,starts_at,ends_at,status,
       address_line,postcode,lat,lng,notes,created_at,updated_at)
     VALUES (?,?,?,?,?, 'completed','15200 Ventura Blvd','91403',34.151,-118.445,
       'side gate unlocked',?,?)`,
  ).bind(apptId, OP, clientId, t - 7200, t - 3600, t, t).run();

  // login_email is what the erasure follows: the order names the address the
  // account was proved with, and every other row below is reached from it.
  await env.DB.prepare(
    `INSERT INTO orders (id,status,guest_name,login_email,phone_e164,email,address_line,
       postcode,lat,lng,currency,total_cents,created_at,updated_at)
     VALUES (?, 'confirmed','Rosa Delgado',?,?,?, '15200 Ventura Blvd','91403',
       34.151,-118.445,'USD',12500,?,?)`,
  ).bind(orderId, LOGIN, PHONE, EMAIL, t, t).run();

  await env.DB.prepare(
    `INSERT INTO order_items (id,order_id,operator_id,appointment_id,client_id,
       starts_at,ends_at,duration_seconds,price_cents,created_at)
     VALUES (?,?,?,?,?,?,?,3600,12500,?)`,
  ).bind(itemId, orderId, OP, apptId, clientId, t - 7200, t - 3600, t).run();

  await env.DB.prepare(
    `INSERT INTO gaps (id,operator_id,starts_at,ends_at,status,created_at,updated_at)
     VALUES (?,?,?,?, 'filled',?,?)`,
  ).bind(gapId, OP, t - 7200, t - 3600, t, t).run();

  // The claim carries the peppered digest of the number and no contact
  // details at all -- migration 0035 took them off this table. Erasure has to
  // find this row by that digest, which is what the assertions below check.
  await env.DB.prepare(
    `INSERT INTO public_claims (id,operator_id,gap_id,client_id,appointment_id,
       phone_hash,address_line,postcode,lat,lng,price_cents,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?, '15200 Ventura Blvd','91403',34.151,-118.445,
       12500,'confirmed',?,?)`,
  ).bind(newId(), OP, gapId, clientId, apptId, await peppered(PHONE), t, t).run();

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
  photos.seed(key, 'image/jpeg');

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

  // "Is this the tap you meant?" — a picture in the conversation rather than
  // in the staged before/after gallery above. It is in the fixture because it
  // is what the erasure used to walk straight past: deleting the thread does
  // not take this row with it, so the endpoint answered 200 with the picture
  // still in the store until the next cron tick collected the orphan.
  const messagePhotoKey = await messagePhoto('mp-rosa', 'th-rosa', itemId);

  return { token, orderId, itemId, apptId, clientId, messagePhotoKey };
}

beforeEach(async () => {
  photos = fakeKV();
  objects = photos.entries;
  env = { ...makeEnv(ALL_MIGRATIONS), PHOTOS: photos } as unknown as Env;
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
    // The conversation photograph too. It hangs off a table with no foreign
    // keys, so the thread delete above cannot take it and nothing here used
    // to: the row and the bytes both outlived an erasure that said otherwise.
    expect(await count(`FROM message_photos`)).toBe(0);
    expect(await count(`FROM clients WHERE id = ?`, clientId)).toBe(0);
    expect(await count(`FROM instant_requests`)).toBe(0);
    expect(await count(`FROM watches WHERE email = ?`, EMAIL)).toBe(0);
    // The file, not just the pointer at it.
    expect(objects.size).toBe(0);
  });

  it('counts the conversation photographs on the receipt it hands back', async () => {
    const { token } = await seedCustomer();

    const res = await call('DELETE', `/api/public/threads/${token}/data`);
    const body = await res.json() as { removed: Record<string, number> };

    // The receipt is the whole point of the fix. The photographs were never
    // lost — the orphan arm of sweepMessagePhotos collected them on the next
    // cron tick — but the customer was told at the moment they asked that
    // their pictures were gone, and for the length of a cron interval that was
    // not true. A count that does not name them is the same lie in smaller
    // print, so what the receipt says and what happened have to be one thing.
    expect(body.removed.message_photos).toBe(1);

    const receipt = await one<{ rows_removed: number }>(
      `SELECT rows_removed FROM erasures`);
    expect(receipt?.rows_removed).toBeGreaterThanOrEqual(body.removed.message_photos);
  });

  it('deletes the photograph sent in a conversation that never became a booking',
    async () => {
      // The enquiry branch, which is the one that matters most: 0051 says the
      // single most useful photograph on a job is the broken tap sent BEFORE
      // there is anything to book, and this is the only path that ever sees
      // one. There is no order, no appointment and no order_item_id on the
      // row, so the conversation is the only key there has ever been to it.
      const t = now();
      await env.DB.prepare(
        `INSERT INTO threads (id,operator_id,guest_name,guest_token_hash,last_message_at,
           status,created_at,updated_at)
         VALUES ('th-ask',?, 'Rosa', ?, ?, 'open', ?, ?)`,
      ).bind(OP, await peppered('guest-ask'), t, t, t).run();
      const key = await messagePhoto('mp-ask', 'th-ask', null);

      const res = await call('DELETE', '/api/public/threads/guest-ask/data');
      expect(res.status).toBe(200);
      expect((await res.json() as { removed: Record<string, number> })
        .removed.message_photos).toBe(1);

      expect(await count(`FROM message_photos`)).toBe(0);
      expect(objects.has(key)).toBe(false);
    });

  it('refuses rather than orphaning a conversation photograph with no store bound',
    async () => {
      const { messagePhotoKey } = await seedCustomer();
      await env.DB.prepare(`DELETE FROM job_photos`).run();

      // job_photos is cleared first so that the refusal being tested is the
      // one on THIS table rather than the older one at step 1 firing before it
      // ever gets there.
      const without = { ...env, PHOTOS: undefined } as unknown as Env;
      const { eraseCustomerByToken } = await import('../src/lib/retention');
      await expect(eraseCustomerByToken(without, 'guest-token-rosa'))
        .rejects.toThrow();

      // `photo_key` is the only route back to the bytes. Deleting the row
      // without them is the one outcome nothing can recover from, so the whole
      // erasure is refused and the customer can ask again.
      expect(await count(`FROM message_photos WHERE id = 'mp-rosa'`)).toBe(1);
      expect(objects.has(messagePhotoKey)).toBe(true);
      // And the conversation is still there, which is what makes the next
      // attempt able to find the row at all.
      expect(await count(`FROM threads WHERE id = 'th-rosa'`)).toBe(1);
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

    const claim = await one<{ phone_hash: string | null; lat: number | null }>(
      `SELECT phone_hash, lat FROM public_claims`);
    // Kept as a row because its unique index on gap_id is the double-booking
    // guard, and emptied of everything that leads back to anybody. There is no
    // name and no number on this table to empty any more; the digest that
    // found the row goes with the rest.
    expect(claim?.phone_hash).toBeNull();
    expect(claim?.lat).toBeNull();
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
      `INSERT INTO customer_standing (login_email,no_show_strikes,banned_at,created_at,updated_at)
       VALUES (?,4,?,?,?)`,
    ).bind(LOGIN, t, t, t).run();

    const res = await call('DELETE', `/api/public/threads/${token}/data`);
    const body = await res.json() as { standing_retained: boolean };

    // Otherwise "delete my data" is also the button that clears a ban, and
    // every suspended customer finds that out within a week of the first one.
    expect(body.standing_retained).toBe(true);
    expect(await count(`FROM customer_standing WHERE login_email = ?`, LOGIN)).toBe(1);
  });

  it('deletes a standing record whose sanction has already lapsed', async () => {
    const { token } = await seedCustomer();
    const t = now();
    await env.DB.prepare(
      `INSERT INTO customer_standing (login_email,no_show_strikes,suspended_until,
         created_at,updated_at) VALUES (?,1,?,?,?)`,
    ).bind(LOGIN, t - 86400, t, t).run();

    const res = await call('DELETE', `/api/public/threads/${token}/data`);
    expect((await res.json() as { standing_retained: boolean }).standing_retained).toBe(false);
    expect(await count(`FROM customer_standing WHERE login_email = ?`, LOGIN)).toBe(0);
  });

  it('leaves a receipt that is not itself a copy of the person', async () => {
    const { token } = await seedCustomer();
    await call('DELETE', `/api/public/threads/${token}/data`);

    const receipt = await one<{ subject_kind: string; subject_hash: string; rows_removed: number }>(
      `SELECT subject_kind, subject_hash, rows_removed FROM erasures`);
    expect(receipt?.subject_kind).toBe('customer');
    expect(receipt?.rows_removed).toBeGreaterThan(0);
    // The one row that survives an erasure must not be the one holding what
    // was erased -- neither the address it was keyed on nor the number that
    // was on the job.
    expect(receipt?.subject_hash).not.toContain('3105550147');
    expect(receipt?.subject_hash).not.toContain('erased');
    expect(receipt?.subject_hash).toBe(await peppered(LOGIN));
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
    const { messagePhotoKey } = await seedCustomer();
    const cookie = await sessionFor(OP);
    const res = await call('POST', '/api/account/close', { cookie });

    // Somebody else's name, number and conversation only ever existed here
    // because this account did.
    expect(await count(`FROM clients WHERE operator_id = ?`, OP)).toBe(0);
    expect(await count(`FROM threads WHERE operator_id = ?`, OP)).toBe(0);
    expect(await count(`FROM chat_messages`)).toBe(0);
    expect(await count(`FROM instant_requests WHERE operator_id = ?`, OP)).toBe(0);

    // And the photographs those people sent into those conversations, which
    // are the same kind of thing and were the one part of it nothing removed.
    // The rows do not go with the threads — 0051 gives them no foreign keys —
    // so closure left them naming a business that no longer existed, with the
    // insides of strangers' houses still in the store.
    expect(await count(`FROM message_photos WHERE operator_id = ?`, OP)).toBe(0);
    expect(objects.has(messagePhotoKey)).toBe(false);
    expect((await res.json() as { removed: Record<string, number> })
      .removed.message_photos).toBe(1);
  });

  it('refuses to close rather than orphaning a customer\'s conversation photograph',
    async () => {
      const { messagePhotoKey } = await seedCustomer();
      const t = now();
      await env.DB.prepare(
        `INSERT INTO work_photos (id,operator_id,r2_key,content_type,created_at,updated_at)
         VALUES ('wp-guard',?, 'w/op/guard','image/jpeg',?,?)`,
      ).bind(OP, t, t).run();
      photos.seed('w/op/guard', 'image/jpeg');

      const without = { ...env, PHOTOS: undefined } as unknown as Env;
      await expect(closeOperatorAccount(without, OP)).rejects.toThrow();

      // NOTHING was touched, which is why the guard is the first thing this
      // function does. A closure that gave up half way through would already
      // have deleted the portfolio and emptied the operator's row, with no
      // second attempt possible — closed_at refuses one.
      expect(await count(`FROM message_photos WHERE id = 'mp-rosa'`)).toBe(1);
      expect(objects.has(messagePhotoKey)).toBe(true);
      expect(await count(`FROM work_photos WHERE id = 'wp-guard'`)).toBe(1);
      expect(await count(`FROM threads WHERE operator_id = ?`, OP)).toBe(1);
      const row = await one<{ email: string; closed_at: number | null }>(
        `SELECT email, closed_at FROM operators WHERE id = ?`, OP);
      expect(row?.email).toBe('op@example.com');
      expect(row?.closed_at).toBeNull();
    });

  it('deletes the portfolio out of the bucket', async () => {
    const t = now();
    await env.DB.prepare(
      `INSERT INTO work_photos (id,operator_id,r2_key,content_type,created_at,updated_at)
       VALUES (?,?, 'w/op/1','image/jpeg',?,?)`,
    ).bind(newId(), OP, t, t).run();
    photos.seed('w/op/1', 'image/jpeg');

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
