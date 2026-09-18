import { describe, expect, it, beforeEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import { fakeKV, type FakeKV } from './kv';
import { signInCustomer } from './customer';
import worker from '../src/index';
import type { Env } from '../src/types';
import { closeCustomerAccount } from '../src/lib/customers';
import { maskInstantRequest } from '../src/lib/online';
import { rateLimit, sweepRateLimits } from '../src/lib/ratelimit';
import {
  RETENTION, eraseCustomerByPhone, sweepEstimates, sweepJobLocations,
  sweepJobPhotos, sweepStanding, sweepStartCodes, sweepThreads,
  sweepVehicleReports,
} from '../src/lib/retention';
import { openReports, provedCustomerStanding } from '../src/lib/standing';
import { DAY, now, sha256 } from '../src/lib/util';

/**
 * The copies of a person that "delete my data" could not reach.
 *
 * EVERY TEST IN THIS FILE IS A SILENT FAILURE. That is what makes them worth
 * writing separately from erasure.test.ts, which checks the rows everybody
 * remembers. An erasure that misses a table does not throw, does not log and
 * does not look any different to the customer: the endpoint returns 200, the
 * page says "Deleted outright", and the address is still on an operator's
 * client list a year later. The defect this file was written after was exactly
 * that shape — a DELETE whose WHERE clause could not match a single row,
 * shipped, passing its own test, for as long as the feature had existed.
 *
 * So each test below asserts on the DATABASE after the erasure, names the row
 * it is about, and where there is a neighbouring row that must SURVIVE it
 * checks that too. A sweep or an erasure that takes too much is discovered by
 * somebody whose booking vanished, which is not better.
 */

const BASE = 'https://gap.test';
const OP = 'op-gaps';
const OTHER_OP = 'op-other';
const LOGIN = 'gapsy@mailbox.test';
const PHONE = '+13105550188';
const ADDRESS = '15200 Ventura Blvd';

let env: Env;
let photos: FakeKV;
/** The backing map, named as it was when this was a fake R2 bucket. */
let objects: FakeKV['entries'];

const ctx = {
  waitUntil: () => {}, passThroughOnException: () => {},
} as unknown as ExecutionContext;

const call = (method: string, path: string, cookie?: string) =>
  worker.fetch(new Request(`${BASE}${path}`, {
    method,
    headers: {
      'cf-connecting-ip': '203.0.113.31',
      ...(cookie ? { cookie } : {}),
    },
  }), env, ctx);

const one = <T>(sql: string, ...args: unknown[]) =>
  env.DB.prepare(sql).bind(...args).first<T>();
const count = async (sql: string, ...args: unknown[]) =>
  (await one<{ n: number }>(`SELECT COUNT(*) AS n ${sql}`, ...args))?.n ?? 0;

async function operator(id: string) {
  const t = now();
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,timezone,country,currency,
       location_mode,fill_model,sms_mode,plan,created_at,updated_at)
     VALUES (?,?, 'Sparkle','America/Los_Angeles','US','USD',
       'mobile','both','device','active',?,?)`,
  ).bind(id, `${id}@example.com`, t, t).run();
}

/**
 * One customer's whole footprint, written the way the product writes it.
 *
 * The client row in particular: `phone_e164` and `email` NULL and
 * `platform_introduced` 1, which is what the inserts in public.ts and orders.ts
 * actually produce. A fixture that seeded a number here would make the old
 * phone-keyed erasure look like it worked.
 */
async function seed(opts: { status?: string; endsAt?: number } = {}) {
  const t = now();
  const endsAt = opts.endsAt ?? t - 3600;
  const status = opts.status ?? 'completed';

  await env.DB.prepare(
    `INSERT INTO clients (id,operator_id,first_name,phone_e164,email,
       address_line,postcode,lat,lng,acquired,platform_introduced,created_at,updated_at)
     VALUES ('c-1',?, 'Rosa',NULL,NULL,?, '91403',34.151,-118.445,'public',1,?,?)`,
  ).bind(OP, ADDRESS, t, t).run();

  // The operator's OWN client, at the same address, which nothing here may
  // touch: they typed it in themselves and it is their business record.
  await env.DB.prepare(
    `INSERT INTO clients (id,operator_id,first_name,phone_e164,
       address_line,postcode,acquired,platform_introduced,created_at,updated_at)
     VALUES ('c-mine',?, 'Rosa',?,?, '91403','operator',0,?,?)`,
  ).bind(OP, PHONE, ADDRESS, t, t).run();

  await env.DB.prepare(
    `INSERT INTO appointments (id,operator_id,client_id,starts_at,ends_at,status,
       address_line,postcode,lat,lng,notes,created_at,updated_at)
     VALUES ('a-1',?, 'c-1',?,?,?,?, '91403',34.151,-118.445,'gate code 4417',?,?)`,
  ).bind(OP, endsAt - 3600, endsAt, status, ADDRESS, t, t).run();

  await env.DB.prepare(
    `INSERT INTO orders (id,status,guest_name,login_email,phone_e164,email,
       address_line,postcode,lat,lng,currency,total_cents,created_at,updated_at)
     VALUES ('o-1', 'confirmed','Rosa',?,?, 'rosa@example.com',?, '91403',
       34.151,-118.445,'USD',12500,?,?)`,
  ).bind(LOGIN, PHONE, ADDRESS, t, t).run();

  await env.DB.prepare(
    `INSERT INTO order_items (id,order_id,operator_id,appointment_id,client_id,
       starts_at,ends_at,duration_seconds,price_cents,start_code,created_at)
     VALUES ('i-1','o-1',?, 'a-1','c-1',?,?,3600,12500,'4417',?)`,
  ).bind(OP, endsAt - 3600, endsAt, t).run();

  await env.DB.prepare(
    `INSERT INTO threads (id,operator_id,appointment_id,client_id,guest_name,
       guest_token_hash,last_message_at,status,created_at,updated_at)
     VALUES ('th-1',?, 'a-1','c-1','Rosa','th-hash',?, 'open',?,?)`,
  ).bind(OP, t, t, t).run();

  // The openings either side of the job. detectGaps copies the appointment's
  // coordinates onto both, at full precision.
  await env.DB.prepare(
    `INSERT INTO gaps (id,operator_id,starts_at,ends_at,status,
       prev_appointment_id,prev_lat,prev_lng,created_at,updated_at)
     VALUES ('g-before',?,?,?, 'filled','a-1',34.151,-118.445,?,?)`,
  ).bind(OP, endsAt, endsAt + 3600, t, t).run();
  await env.DB.prepare(
    `INSERT INTO gaps (id,operator_id,starts_at,ends_at,status,
       next_appointment_id,next_lat,next_lng,created_at,updated_at)
     VALUES ('g-after',?,?,?, 'expired','a-1',34.151,-118.445,?,?)`,
  ).bind(OP, endsAt - 9000, endsAt - 3600, t, t).run();

  await env.DB.prepare(
    `INSERT INTO estimates (id,thread_id,operator_id,request,status,created_at,updated_at)
     VALUES ('e-1','th-1',?, 'Back bedroom radiator, the one under the window',
       'asked',?,?)`,
  ).bind(OP, t, t).run();

  return { endsAt };
}

/**
 * A photograph sent inside a conversation: migration 0051's table.
 *
 * Both halves are seeded, the row and the bytes, because both halves are the
 * point. `photo_key` is the only record of where the picture is — the table
 * has no foreign keys precisely so that no cascade can delete the row and
 * leave the bytes unnameable — so a test counting rows alone would pass on an
 * erasure that deleted the pointer and left the photograph in the store.
 */
async function messagePhoto(
  id: string, threadId: string, itemId: string | null, opId = OP,
) {
  await env.DB.prepare(
    `INSERT INTO message_photos (id,message_id,thread_id,operator_id,order_item_id,
       photo_key,content_type,bytes,width,height,created_at)
     VALUES (?,?,?,?,?,?, 'image/jpeg',2048,800,600,?)`,
  ).bind(id, `m-${id}`, threadId, opId, itemId, `c/${opId}/${id}`, now()).run();
  photos.seed(`c/${opId}/${id}`, 'image/jpeg');
}

beforeEach(async () => {
  photos = fakeKV();
  objects = photos.entries;
  env = { ...makeEnv(ALL_MIGRATIONS), PHOTOS: photos } as unknown as Env;
  await operator(OP);
  await operator(OTHER_OP);
});

// ---------------------------------------------------------------------------
describe('the copies an erasure could not reach', () => {
  it("deletes the business's own copy of the customer, which was keyed on NULL",
    async () => {
      await seed();
      // The old query was `phone_e164 IN (the numbers this person gave) AND
      // acquired = 'public'`, and a platform client row has phone_e164 NULL.
      // `NULL IN (...)` is never true, so it matched nothing, ever.
      await eraseCustomerByPhone(env, LOGIN);

      expect(await count(`FROM clients WHERE id = 'c-1'`)).toBe(0);
      // And the operator's own row at the same address is still theirs.
      const mine = await one<{ address_line: string | null; phone_e164: string | null }>(
        `SELECT address_line, phone_e164 FROM clients WHERE id = 'c-mine'`);
      expect(mine?.address_line).toBe(ADDRESS);
      expect(mine?.phone_e164).toBe(PHONE);
    });

  it('takes the doorstep off the openings either side of the job', async () => {
    await seed();
    await eraseCustomerByPhone(env, LOGIN);

    const before = await one<{ prev_lat: number | null; prev_lng: number | null }>(
      `SELECT prev_lat, prev_lng FROM gaps WHERE id = 'g-before'`);
    expect(before?.prev_lat).toBeNull();
    expect(before?.prev_lng).toBeNull();

    const after = await one<{ next_lat: number | null; next_lng: number | null }>(
      `SELECT next_lat, next_lng FROM gaps WHERE id = 'g-after'`);
    expect(after?.next_lat).toBeNull();
    expect(after?.next_lng).toBeNull();
  });

  it('deletes what the customer asked for in their own words', async () => {
    await seed();
    await eraseCustomerByPhone(env, LOGIN);
    // estimates.thread_id is not a foreign key, so deleting the thread does
    // not take this with it and nothing else was ever going to find it.
    expect(await count(`FROM estimates WHERE id = 'e-1'`)).toBe(0);
  });

  it('clears the code that gets a stranger through the front door', async () => {
    await seed();
    await eraseCustomerByPhone(env, LOGIN);

    const item = await one<{ start_code: string | null; price_cents: number }>(
      `SELECT start_code, price_cents FROM order_items WHERE id = 'i-1'`);
    expect(item?.start_code).toBeNull();
    // The money stays. The row is a record of work that happened.
    expect(item?.price_cents).toBe(12500);
  });

  it('deletes the signed-in sessions rather than flagging them revoked',
    async () => {
      const me = await signInCustomer(env, LOGIN, { first_name: 'Rosa', phone: PHONE });
      await seed();
      expect(await count(`FROM customer_sessions WHERE account_id = ?`, me.accountId))
        .toBe(1);

      await eraseCustomerByPhone(env, LOGIN);

      // Not revoked_at = <a timestamp>. A revoked row still names the account
      // and holds the device string that was signing in on it.
      expect(await count(`FROM customer_sessions WHERE account_id = ?`, me.accountId))
        .toBe(0);
    });

  it('clears the Stripe customer reference, on erasure and on a close',
    async () => {
      const me = await signInCustomer(env, LOGIN, { first_name: 'Rosa', phone: PHONE });
      await env.DB.prepare(
        `UPDATE customer_accounts SET stripe_customer_id = 'cus_live123' WHERE id = ?`,
      ).bind(me.accountId).run();
      await seed();

      await eraseCustomerByPhone(env, LOGIN);
      expect((await one<{ stripe_customer_id: string | null }>(
        `SELECT stripe_customer_id FROM customer_accounts WHERE id = ?`, me.accountId,
      ))?.stripe_customer_id).toBeNull();

      // And the smaller request beside it, which listed the same eleven
      // columns and left the twelfth.
      const them = await signInCustomer(env, 'second@mailbox.test');
      await env.DB.prepare(
        `UPDATE customer_accounts SET stripe_customer_id = 'cus_live456' WHERE id = ?`,
      ).bind(them.accountId).run();
      await closeCustomerAccount(env, them.accountId);
      expect((await one<{ stripe_customer_id: string | null }>(
        `SELECT stripe_customer_id FROM customer_accounts WHERE id = ?`, them.accountId,
      ))?.stripe_customer_id).toBeNull();
    });

  it('refuses rather than orphaning photographs when there is no bucket',
    async () => {
      await seed();
      await env.DB.prepare(
        `INSERT INTO job_photos (id,order_item_id,operator_id,uploaded_by,stage,
           r2_key,content_type,bytes,created_at,public_on_review)
         VALUES ('ph-1','i-1',?, 'customer','after','j/x/1','image/jpeg',10,?,0)`,
      ).bind(OP, now()).run();

      const without = { ...env, PHOTOS: undefined } as unknown as Env;
      await expect(eraseCustomerByPhone(without, LOGIN)).rejects.toThrow();
      // The row is still there, which is what makes the next attempt able to
      // delete the object as well as the pointer at it.
      expect(await count(`FROM job_photos WHERE id = 'ph-1'`)).toBe(1);
    });

  it('deletes a photograph sent in the conversation, out of the store as well',
    async () => {
      await seed();
      await messagePhoto('mp-1', 'th-1', 'i-1');
      // Another business's conversation, at the same moment. Neither key this
      // erasure uses may reach it: the threads are the ones found from THIS
      // customer's appointments and link, and the items are their own lines.
      await messagePhoto('mp-theirs', 'th-someone-else', 'i-someone-else', OTHER_OP);

      const result = await eraseCustomerByPhone(env, LOGIN);

      // The row does not go with the thread — 0051 gives this table no foreign
      // keys on purpose — so until the erasure collected these rows itself the
      // endpoint returned success with the picture still in the store, and the
      // cron tidied up afterwards. The receipt was the thing that was wrong.
      expect(await count(`FROM message_photos WHERE id = 'mp-1'`)).toBe(0);
      expect(objects.has(`c/${OP}/mp-1`)).toBe(false);
      expect(result.removed.message_photos).toBe(1);

      expect(await count(`FROM message_photos WHERE id = 'mp-theirs'`)).toBe(1);
      expect(objects.has(`c/${OTHER_OP}/mp-theirs`)).toBe(true);
    });

  it('reaches one whose conversation was already swept, by the booking it names',
    async () => {
      await seed();
      // sweepThreads deletes a finished job's conversation at
      // THREAD_AFTER_JOB_DAYS and does not touch this table, so a photograph
      // can outlive its thread by months while the booking it belongs to is
      // still on file. Keyed on the thread alone, an erasure would walk past
      // it and leave the customer's picture for a cron tick to find.
      await messagePhoto('mp-orphan', 'th-swept-long-ago', 'i-1');

      await eraseCustomerByPhone(env, LOGIN);

      expect(await count(`FROM message_photos WHERE id = 'mp-orphan'`)).toBe(0);
      expect(objects.has(`c/${OP}/mp-orphan`)).toBe(false);
    });

  it('refuses rather than orphaning a conversation photograph when there is no store',
    async () => {
      await seed();
      await messagePhoto('mp-nokv', 'th-1', 'i-1');

      const without = { ...env, PHOTOS: undefined } as unknown as Env;
      await expect(eraseCustomerByPhone(without, LOGIN)).rejects.toThrow();

      // Doing nothing is what a sweep does when the store is missing, because
      // there is always another tick. An erasure has somebody waiting in front
      // of a page, so it takes the other recoverable option and says so. What
      // neither may do is delete the row that names bytes it could not delete.
      expect(await count(`FROM message_photos WHERE id = 'mp-nokv'`)).toBe(1);
      expect(objects.has(`c/${OP}/mp-nokv`)).toBe(true);
      // The conversation survives too, so the next attempt can still find it.
      expect(await count(`FROM threads WHERE id = 'th-1'`)).toBe(1);
    });

  it('clears what the customer wrote about the van on their own doorstep',
    async () => {
      await seed();
      const t = now();
      await env.DB.prepare(
        `UPDATE order_items SET vehicle_reported_at = ?, vehicle_reported_note = ?
          WHERE id = 'i-1'`,
      ).bind(t, 'A white transit, three men, not the van in the app').run();

      await eraseCustomerByPhone(env, LOGIN);

      // Five hundred characters typed by somebody standing at their front door
      // with a stranger on it. The row stays — it is the record of work that
      // happened — and this is not part of that record.
      const item = await one<{
        vehicle_reported_note: string | null;
        vehicle_reported_at: number | null;
        price_cents: number;
      }>(`SELECT vehicle_reported_note, vehicle_reported_at, price_cents
            FROM order_items WHERE id = 'i-1'`);
      expect(item?.vehicle_reported_note).toBeNull();
      // The timestamp goes too: on its own it is still the fact that this
      // person challenged this business on this day.
      expect(item?.vehicle_reported_at).toBeNull();
      expect(item?.price_cents).toBe(12500);
    });

  it('reaches an order taken before login_email existed, from its own link',
    async () => {
      // Migration 0038 added orders.login_email with no backfill, so every
      // order older than it has NULL there. The erasure used to branch on that
      // column being empty and delete the conversation alone: the order, the
      // address, the client row and the door code all stayed, and the endpoint
      // answered 200.
      await seed();
      await env.DB.prepare(`UPDATE orders SET login_email = NULL WHERE id = 'o-1'`).run();

      const raw = 'link-from-before-0038';
      await env.DB.prepare(
        `UPDATE threads SET guest_token_hash = ? WHERE id = 'th-1'`,
      ).bind(await sha256(`${raw}:${env.SESSION_PEPPER}`)).run();

      const res = await call('DELETE', `/api/public/threads/${raw}/data`);
      expect(res.status).toBe(200);

      // The work-shaped half of the erasure runs off the order the link names.
      expect(await count(`FROM clients WHERE id = 'c-1'`)).toBe(0);
      expect((await one<{ address_line: string | null }>(
        `SELECT address_line FROM orders WHERE id = 'o-1'`))?.address_line).toBeNull();
      expect((await one<{ address_line: string | null; notes: string | null }>(
        `SELECT address_line, notes FROM appointments WHERE id = 'a-1'`))?.notes)
        .toBeNull();
      expect((await one<{ start_code: string | null }>(
        `SELECT start_code FROM order_items WHERE id = 'i-1'`))?.start_code).toBeNull();
      expect(await count(`FROM threads WHERE id = 'th-1'`)).toBe(0);
    });

  it('erases a feed row from an instant request by not writing one about anybody',
    async () => {
      // These rows carry no appointment_id and no thread_id, because a request
      // nobody accepted never becomes either, so an erasure has no key to find
      // one by. The fix is that they no longer say who: see online.ts.
      const source = await import('node:fs').then((fs) => fs.readFileSync(
        new URL('../src/lib/online.ts', import.meta.url), 'utf8'));
      const notifyCalls = [...source.matchAll(/notify\(env,[\s\S]{0,400}?\}\);/g)]
        .map((m) => m[0]);
      expect(notifyCalls.length).toBeGreaterThan(0);
      for (const block of notifyCalls) {
        // No interpolation of the customer's name, and no quoting of the note
        // they typed, into a row nothing can come back for.
        expect(block).not.toContain('guest_name');
        expect(block).not.toContain('guestName');
        expect(block).not.toContain('request.note');
      }
    });
});

// ---------------------------------------------------------------------------
describe('the sweeps that could never run', () => {
  it('reaches a job nobody ever marked completed', async () => {
    // The only thing that writes 'completed' is an operator tapping a button.
    // A business that stops tapping used to keep every address and every
    // transcript forever.
    const old = now() - (RETENTION.THREAD_AFTER_JOB_DAYS + 10) * DAY;
    await seed({ status: 'scheduled', endsAt: old });

    await sweepJobLocations(env);
    await sweepThreads(env);

    const appt = await one<{ address_line: string | null; lat: number | null }>(
      `SELECT address_line, lat FROM appointments WHERE id = 'a-1'`);
    expect(appt?.address_line).toBeNull();
    expect(appt?.lat).toBeNull();
    expect(await count(`FROM threads WHERE id = 'th-1'`)).toBe(0);
  });

  it('leaves a scheduled job that has not happened yet completely alone', async () => {
    await seed({ status: 'scheduled', endsAt: now() + 7 * DAY });
    await sweepJobLocations(env);
    await sweepThreads(env);

    expect((await one<{ address_line: string | null }>(
      `SELECT address_line FROM appointments WHERE id = 'a-1'`))?.address_line)
      .toBe(ADDRESS);
    expect(await count(`FROM threads WHERE id = 'th-1'`)).toBe(1);
  });

  it('scrubs the anchor coordinates off an opening that is long past', async () => {
    await seed({ endsAt: now() - (RETENTION.JOB_LOCATION_DAYS + 10) * DAY });
    await sweepJobLocations(env);

    expect((await one<{ prev_lat: number | null }>(
      `SELECT prev_lat FROM gaps WHERE id = 'g-before'`))?.prev_lat).toBeNull();
    expect((await one<{ next_lat: number | null }>(
      `SELECT next_lat FROM gaps WHERE id = 'g-after'`))?.next_lat).toBeNull();
  });

  it('leaves the anchors on an opening that is still in the diary', async () => {
    await seed({ endsAt: now() + 7 * DAY });
    await sweepJobLocations(env);
    expect((await one<{ prev_lat: number | null }>(
      `SELECT prev_lat FROM gaps WHERE id = 'g-before'`))?.prev_lat).toBe(34.151);
  });

  it('deletes an estimate whose conversation has already gone', async () => {
    await seed();
    await env.DB.prepare(`DELETE FROM threads WHERE id = 'th-1'`).run();
    expect(await count(`FROM estimates`)).toBe(1);
    await sweepEstimates(env);
    expect(await count(`FROM estimates`)).toBe(0);
  });

  it('leaves an estimate on a live conversation alone', async () => {
    await seed();
    await sweepEstimates(env);
    expect(await count(`FROM estimates WHERE id = 'e-1'`)).toBe(1);
  });

  it('deletes the report and the suspension behind a lapsed record', async () => {
    const t = now();
    const old = t - (RETENTION.STANDING_DAYS + 10) * DAY;
    await seed();

    await env.DB.prepare(
      `INSERT INTO customer_standing (login_email,no_show_strikes,suspended_until,
         banned_at,created_at,updated_at)
       VALUES (?,1,?,NULL,?,?)`,
    ).bind(LOGIN, old + DAY, old, old).run();
    await env.DB.prepare(
      `INSERT INTO no_show_reports (id,order_item_id,against,operator_id,phone_e164,
         login_email,note,status,decided_at,strike_number,created_at,updated_at)
       VALUES ('nsr-old','i-1','customer',?,?,?, 'She was not in and the dog was loose',
         'confirmed',?,1,?,?)`,
    ).bind(OP, PHONE, LOGIN, old, old, old).run();
    await env.DB.prepare(
      `INSERT INTO suspensions (id,subject_kind,subject_id,reason,strike_number,
         starts_at,ends_at,note,created_at)
       VALUES ('sus-old','customer',?, 'no_show',1,?,?, 'Suspended 3 days.',?)`,
    ).bind(LOGIN, old, old + 3 * DAY, old).run();

    await sweepStanding(env);

    expect(await count(`FROM customer_standing WHERE login_email = ?`, LOGIN)).toBe(0);
    // The two the privacy page's 730-day row is actually about: an operator's
    // free-text note about a named person, and the ladder rung it produced.
    expect(await count(`FROM no_show_reports WHERE id = 'nsr-old'`)).toBe(0);
    expect(await count(`FROM suspensions WHERE id = 'sus-old'`)).toBe(0);
  });

  it('keeps a report and a ban while the sanction is still live', async () => {
    const t = now();
    const old = t - (RETENTION.STANDING_DAYS + 10) * DAY;
    await seed();

    await env.DB.prepare(
      `INSERT INTO customer_standing (login_email,no_show_strikes,suspended_until,
         banned_at,created_at,updated_at)
       VALUES (?,4,NULL,?,?,?)`,
    ).bind(LOGIN, old, old, old).run();
    await env.DB.prepare(
      `INSERT INTO no_show_reports (id,order_item_id,against,operator_id,phone_e164,
         login_email,note,status,decided_at,strike_number,created_at,updated_at)
       VALUES ('nsr-live','i-1','customer',?,?,?, 'note','confirmed',?,4,?,?)`,
    ).bind(OP, PHONE, LOGIN, old, old, old).run();
    // A ban has no end date, by design, so nothing can expire it.
    await env.DB.prepare(
      `INSERT INTO suspensions (id,subject_kind,subject_id,reason,strike_number,
         starts_at,ends_at,note,created_at)
       VALUES ('sus-ban','customer',?, 'no_show',4,?,NULL,'Banned.',?)`,
    ).bind(LOGIN, old, old).run();
    // And an open report, which nobody has looked at yet.
    await env.DB.prepare(
      `INSERT INTO no_show_reports (id,order_item_id,against,operator_id,phone_e164,
         login_email,note,status,decided_at,strike_number,created_at,updated_at)
       VALUES ('nsr-open','i-1','operator',?,?,?, 'note','open',NULL,NULL,?,?)`,
    ).bind(OP, PHONE, LOGIN, old, old).run();

    await sweepStanding(env);

    expect(await count(`FROM customer_standing WHERE login_email = ?`, LOGIN)).toBe(1);
    expect(await count(`FROM no_show_reports WHERE id = 'nsr-live'`)).toBe(1);
    expect(await count(`FROM no_show_reports WHERE id = 'nsr-open'`)).toBe(1);
    expect(await count(`FROM suspensions WHERE id = 'sus-ban'`)).toBe(1);
  });

  it('clears a vehicle report once the dispute window behind it has closed',
    async () => {
      const old = now() - (RETENTION.VEHICLE_REPORT_DAYS + 10) * DAY;
      await seed({ endsAt: old });
      await env.DB.prepare(
        `UPDATE order_items SET ends_at = ?, vehicle_reported_at = ?,
                vehicle_reported_note = 'not the van in the app' WHERE id = 'i-1'`,
      ).bind(old, old).run();

      expect(await sweepVehicleReports(env)).toBe(1);
      expect((await one<{ vehicle_reported_note: string | null }>(
        `SELECT vehicle_reported_note FROM order_items WHERE id = 'i-1'`))
        ?.vehicle_reported_note).toBeNull();
    });

  it('clears a spent door code, and leaves a live booking its own', async () => {
    // Four digits a customer reads out to a stranger on their own doorstep,
    // stored in plain text. Erasure cleared it; nothing cleared it for the
    // customer who never asks for anything.
    await seed({ endsAt: now() - (RETENTION.JOB_LOCATION_DAYS + 10) * DAY });
    await env.DB.prepare(
      `UPDATE order_items SET ends_at = ? WHERE id = 'i-1'`,
    ).bind(now() - (RETENTION.JOB_LOCATION_DAYS + 10) * DAY).run();

    expect(await sweepStartCodes(env)).toBe(1);
    expect((await one<{ start_code: string | null }>(
      `SELECT start_code FROM order_items WHERE id = 'i-1'`))?.start_code).toBeNull();

    // A booking still in the diary keeps the code the customer is going to
    // need on the day.
    await env.DB.prepare(
      `INSERT INTO order_items (id,order_id,operator_id,starts_at,ends_at,
         duration_seconds,price_cents,start_code,created_at)
       VALUES ('i-soon','o-1',?,?,?,3600,12500,'5566',?)`,
    ).bind(OP, now() + DAY, now() + DAY + 3600, now()).run();

    expect(await sweepStartCodes(env)).toBe(0);
    expect((await one<{ start_code: string | null }>(
      `SELECT start_code FROM order_items WHERE id = 'i-soon'`))?.start_code).toBe('5566');
  });

  it('leaves a vehicle report on a job that is still inside the window', async () => {
    await seed();
    await env.DB.prepare(
      `UPDATE order_items SET vehicle_reported_at = ?,
              vehicle_reported_note = 'not the van in the app' WHERE id = 'i-1'`,
    ).bind(now()).run();

    expect(await sweepVehicleReports(env)).toBe(0);
    expect((await one<{ vehicle_reported_note: string | null }>(
      `SELECT vehicle_reported_note FROM order_items WHERE id = 'i-1'`))
      ?.vehicle_reported_note).toBe('not the van in the app');
  });

  it('leaves photo rows standing when there is no bucket to delete from',
    async () => {
      await seed();
      const old = now() - (RETENTION.JOB_PHOTO_DAYS + 10) * DAY;
      await env.DB.prepare(
        `UPDATE order_items SET ends_at = ?, starts_at = ? WHERE id = 'i-1'`,
      ).bind(old, old - 3600).run();
      await env.DB.prepare(
        `INSERT INTO job_photos (id,order_item_id,operator_id,uploaded_by,stage,
           r2_key,content_type,bytes,created_at,public_on_review)
         VALUES ('ph-old','i-1',?, 'customer','after','j/x/old','image/jpeg',10,?,0)`,
      ).bind(OP, old).run();

      const without = { ...env, PHOTOS: undefined } as unknown as Env;
      expect(await sweepJobPhotos(without)).toBe(0);
      // The r2_key is the only thing that can ever name the object again.
      expect(await count(`FROM job_photos WHERE id = 'ph-old'`)).toBe(1);

      // With the binding back, both go.
      photos.seed('j/x/old', 'image/jpeg');
      expect(await sweepJobPhotos(env)).toBe(1);
      expect(objects.has('j/x/old')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
describe('the rate-limit table, which was a list of working booking links', () => {
  it('stores a fingerprint of the key and never the key', async () => {
    const key = 'erase:a-real-guest-token-value';
    await rateLimit(env, key, 3, 900);

    const rows = await env.DB.prepare(`SELECT bucket_key FROM rate_limits`)
      .all<{ bucket_key: string }>();
    expect(rows.results!.length).toBe(1);
    // Not the token, not the prefix, not anything a reader could use.
    expect(rows.results![0]!.bucket_key).not.toContain('a-real-guest-token-value');
    expect(rows.results![0]!.bucket_key)
      .toBe(await sha256(`${key}:${env.SESSION_PEPPER}`));
  });

  it('still counts the same caller into the same bucket', async () => {
    const key = 'auth:someone@example.com';
    for (let i = 0; i < 3; i++) await rateLimit(env, key, 3, 900);
    const fourth = await rateLimit(env, key, 3, 900);
    expect(fourth.ok).toBe(false);
    expect(await count(`FROM rate_limits`)).toBe(1);
  });

  it('deletes windows that have closed, and leaves live ones counting', async () => {
    await rateLimit(env, 'auth:live@example.com', 5, 900);
    await env.DB.prepare(
      `INSERT INTO rate_limits (bucket_key, count, window_start) VALUES ('old', 4, ?)`,
    ).bind(now() - 5 * DAY).run();

    expect(await sweepRateLimits(env)).toBe(1);
    expect(await count(`FROM rate_limits WHERE bucket_key = 'old'`)).toBe(0);
    expect(await count(`FROM rate_limits`)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('the answers that were being given away', () => {
  it('will not answer about an address the caller has not proved', async () => {
    const t = now();
    await env.DB.prepare(
      `INSERT INTO customer_standing (login_email,no_show_strikes,suspended_until,
         banned_at,created_at,updated_at)
       VALUES (?,2,?,NULL,?,?)`,
    ).bind(LOGIN, t + 5 * DAY, t, t).run();

    // A stranger walking a list gets exactly what they would get for an
    // address with nothing against it, which is the only answer that leaks
    // nothing.
    const probed = await provedCustomerStanding(env, LOGIN, null);
    expect(probed.blocked).toBe(false);
    expect(probed.message).toBeNull();

    const wrongAccount = await provedCustomerStanding(env, LOGIN, 'someone@else.test');
    expect(wrongAccount.blocked).toBe(false);

    // The person it is built for still gets the truth about themselves.
    const mine = await provedCustomerStanding(env, LOGIN, LOGIN);
    expect(mine.blocked).toBe(true);
    expect(mine.message).toBeTruthy();
  });

  it('masks the mailbox on the moderator queue as well as the number', async () => {
    await seed();
    const t = now();
    await env.DB.prepare(
      `INSERT INTO no_show_reports (id,order_item_id,against,operator_id,phone_e164,
         login_email,note,status,decided_at,strike_number,created_at,updated_at)
       VALUES ('nsr-1','i-1','customer',?,?,?, 'note','open',NULL,NULL,?,?)`,
    ).bind(OP, PHONE, LOGIN, t, t).run();

    const rows = await openReports(env);
    expect(rows.length).toBe(1);
    const row = rows[0] as Record<string, unknown>;
    // Since 0038 the address IS the identity, so serving it in full beside a
    // masked number left the screen exactly as revealing as it was before.
    expect(row.login_email).not.toBe(LOGIN);
    expect(String(row.login_email)).not.toContain('gapsy');
    expect(String(row.phone_e164)).not.toContain('5550188');
  });

  it('withholds the doorstep on a request nobody has accepted', async () => {
    const pending = {
      status: 'pending' as const,
      guest_name: 'Rosa',
      phone_e164: PHONE,
      email: 'rosa@example.com',
      address_line: ADDRESS,
      postcode: '91403',
      lat: 34.151,
      lng: -118.445,
    };

    const masked = maskInstantRequest(pending);
    expect(masked.address_line).toBeNull();
    expect(masked.lat).toBeNull();
    expect(masked.lng).toBeNull();
    // The postcode stays: it is what the operator decides on, and it is the
    // same coarse geography the retention sweep keeps after the job.
    expect(masked.postcode).toBe('91403');
    expect(masked.phone_e164).not.toContain('5550188');
    expect(masked.email).not.toContain('rosa@example.com');

    // And it arrives the moment they agree to drive there.
    const accepted = maskInstantRequest({ ...pending, status: 'accepted' as const });
    expect(accepted.address_line).toBe(ADDRESS);
    expect(accepted.lat).toBe(34.151);
  });
});

// ---------------------------------------------------------------------------
describe('both doors on the erasure remove the same rows', () => {
  it('reaches the client row, the estimate and the gap anchors from the link too',
    async () => {
      await seed();
      const raw = 'guest-token-for-the-link';
      await env.DB.prepare(
        `UPDATE threads SET guest_token_hash = ? WHERE id = 'th-1'`,
      ).bind(await sha256(`${raw}:${env.SESSION_PEPPER}`)).run();

      const res = await call('DELETE', `/api/public/threads/${raw}/data`);
      expect(res.status).toBe(200);

      expect(await count(`FROM clients WHERE id = 'c-1'`)).toBe(0);
      expect(await count(`FROM estimates WHERE id = 'e-1'`)).toBe(0);
      expect((await one<{ prev_lat: number | null }>(
        `SELECT prev_lat FROM gaps WHERE id = 'g-before'`))?.prev_lat).toBeNull();
      expect((await one<{ start_code: string | null }>(
        `SELECT start_code FROM order_items WHERE id = 'i-1'`))?.start_code).toBeNull();
    });

  it('finds an instant request by the mailbox, and leaves a housemate\'s alone',
    async () => {
      await seed();
      const t = now();
      // Two people, one household mobile. The old erasure keyed these rows on
      // phone_e164 alone, so this pair was one subject: erasing the first
      // deleted the second's request, address and all.
      const request = (id: string, email: string | null, phone: string) =>
        env.DB.prepare(
          `INSERT INTO instant_requests (id,operator_id,starts_at,duration_seconds,
             price_cents,currency,guest_name,phone_e164,login_email,address_line,
             postcode,lat,lng,status,expires_at,token_hash,created_at,updated_at)
           VALUES (?,?,?,3600,9000,'USD','Rosa',?,?,?, '91403',34.151,-118.445,
             'expired',?,?,?,?)`,
        ).bind(id, OP, t, phone, email, ADDRESS, t, `hash-${id}`, t, t).run();

      await request('ir-mine', LOGIN, PHONE);
      await request('ir-housemate', 'housemate@mailbox.test', PHONE);

      await eraseCustomerByPhone(env, LOGIN);

      expect(await count(`FROM instant_requests WHERE id = 'ir-mine'`)).toBe(0);
      expect(await count(`FROM instant_requests WHERE id = 'ir-housemate'`)).toBe(1);
    });

  it('still reaches an instant request written before the mailbox column existed',
    async () => {
      await seed();
      const t = now();
      await env.DB.prepare(
        `INSERT INTO instant_requests (id,operator_id,starts_at,duration_seconds,
           price_cents,currency,guest_name,phone_e164,login_email,address_line,
           postcode,lat,lng,status,expires_at,token_hash,created_at,updated_at)
         VALUES ('ir-old',?,?,3600,9000,'USD','Rosa',?,NULL,?, '91403',34.151,
           -118.445,'expired',?, 'hash-old',?,?)`,
      ).bind(OP, t, PHONE, ADDRESS, t, t, t).run();

      // The number is the only key such a row has, so the legacy arm keeps it.
      await eraseCustomerByPhone(env, LOGIN);
      expect(await count(`FROM instant_requests WHERE id = 'ir-old'`)).toBe(0);
    });

  it('leaves an unrelated customer at the same business untouched', async () => {
    await seed();
    const t = now();
    await env.DB.prepare(
      `INSERT INTO clients (id,operator_id,first_name,address_line,postcode,
         acquired,platform_introduced,created_at,updated_at)
       VALUES ('c-other',?, 'Sam','9 Oak Ave','91403','public',1,?,?)`,
    ).bind(OP, t, t).run();
    await env.DB.prepare(
      `INSERT INTO orders (id,status,guest_name,login_email,currency,total_cents,
         created_at,updated_at)
       VALUES ('o-other','confirmed','Sam','sam@mailbox.test','USD',5000,?,?)`,
    ).bind(t, t).run();
    await env.DB.prepare(
      `INSERT INTO order_items (id,order_id,operator_id,client_id,starts_at,ends_at,
         duration_seconds,price_cents,start_code,created_at)
       VALUES ('i-other','o-other',?, 'c-other',?,?,3600,5000,'9911',?)`,
    ).bind(OP, t - 7200, t - 3600, t).run();

    await eraseCustomerByPhone(env, LOGIN);

    expect(await count(`FROM clients WHERE id = 'c-other'`)).toBe(1);
    expect((await one<{ start_code: string | null }>(
      `SELECT start_code FROM order_items WHERE id = 'i-other'`))?.start_code)
      .toBe('9911');
  });
});
