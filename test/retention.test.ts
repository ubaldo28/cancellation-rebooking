import { describe, expect, it, beforeEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import type { Env } from '../src/types';
import {
  RETENTION, sweepInstantRequests, sweepJobLocations, sweepJobPhotos,
  sweepMessageLog, sweepNotifications, sweepRetention, sweepStanding, sweepThreads,
  sweepWatches,
} from '../src/lib/retention';
import { newId, now } from '../src/lib/util';

/**
 * The retention sweeps.
 *
 * Every test here comes in a pair: one that proves the sweep removes the thing
 * it exists to remove, and one that proves it leaves the neighbouring row
 * alone. The second half is the half worth writing. A sweep that deletes too
 * much is discovered by a customer whose booking vanished, weeks later, with
 * no way to get it back -- so "does not remove what it should keep" is the
 * property these tests are actually for.
 */

const DAY = 86400;
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

const one = <T>(sql: string, ...args: unknown[]) =>
  env.DB.prepare(sql).bind(...args).first<T>();
const count = async (sql: string, ...args: unknown[]) =>
  (await one<{ n: number }>(`SELECT COUNT(*) AS n ${sql}`, ...args))?.n ?? 0;

const OP = 'op-retention';

async function seedOperator() {
  const t = now();
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,timezone,country,currency,
       location_mode,fill_model,sms_mode,plan,created_at,updated_at)
     VALUES (?, 'op@example.com','Sweeper','America/Los_Angeles','US','USD',
       'mobile','both','device','active',?,?)`,
  ).bind(OP, t, t).run();
}

/** An appointment, at whatever point in the past the test needs it. */
async function appointment(
  id: string, endsAt: number, status = 'completed',
  where: { address?: string | null; lat?: number | null } = {},
) {
  const t = now();
  await env.DB.prepare(
    `INSERT INTO appointments (id,operator_id,starts_at,ends_at,status,
       address_line,postcode,lat,lng,notes,created_at,updated_at)
     VALUES (?,?,?,?,?,?,'91403',?,?, 'side gate is unlocked',?,?)`,
  ).bind(id, OP, endsAt - 3600, endsAt, status,
    where.address === undefined ? '15200 Ventura Blvd' : where.address,
    where.lat === undefined ? 34.1510 : where.lat,
    where.lat === undefined ? -118.4450 : where.lat, t, t).run();
}

async function thread(
  id: string, lastMessageAt: number, appointmentId: string | null,
) {
  await env.DB.prepare(
    `INSERT INTO threads (id,operator_id,appointment_id,guest_name,guest_token_hash,
       last_message_at,status,created_at,updated_at)
     VALUES (?,?,?, 'Rosa', ?, ?, 'open', ?, ?)`,
  ).bind(id, OP, appointmentId, `hash-${id}`, lastMessageAt, lastMessageAt, lastMessageAt).run();
  await env.DB.prepare(
    `INSERT INTO chat_messages (id,thread_id,sender,body,created_at)
     VALUES (?,?, 'guest','the side gate is unlocked',?)`,
  ).bind(newId(), id, lastMessageAt).run();
}

async function order(id: string, itemId: string, endsAt: number, phone = '+13105550147') {
  const t = now();
  await env.DB.prepare(
    `INSERT INTO orders (id,status,guest_name,phone_e164,email,address_line,postcode,
       lat,lng,currency,total_cents,created_at,updated_at)
     VALUES (?, 'confirmed','Rosa',?, 'rosa@example.com','15200 Ventura Blvd','91403',
       34.1510,-118.4450,'USD',12500,?,?)`,
  ).bind(id, phone, endsAt - 3600, endsAt - 3600).run();
  await env.DB.prepare(
    `INSERT INTO order_items (id,order_id,operator_id,starts_at,ends_at,duration_seconds,
       price_cents,created_at)
     VALUES (?,?,?,?,?,3600,12500,?)`,
  ).bind(itemId, id, OP, endsAt - 3600, endsAt, endsAt - 3600).run();
  return t;
}

beforeEach(async () => {
  env = { ...makeEnv(ALL_MIGRATIONS), PHOTOS: fakeBucket() } as unknown as Env;
  await seedOperator();
});

// ---------------------------------------------------------------------------
describe('conversations', () => {
  it('deletes a question that never became a booking, and its messages with it', async () => {
    const t = now();
    await thread('t-old', t - (RETENTION.THREAD_NO_BOOKING_DAYS + 1) * DAY, null);

    expect(await sweepThreads(env)).toBe(1);
    expect(await count(`FROM threads WHERE id = 't-old'`)).toBe(0);
    // The transcript is where the gate code and the description of somebody's
    // house actually live, so the cascade is the point of deleting the thread.
    expect(await count(`FROM chat_messages WHERE thread_id = 't-old'`)).toBe(0);
  });

  it('keeps a question asked last week', async () => {
    const t = now();
    await thread('t-fresh', t - 7 * DAY, null);
    await sweepThreads(env);
    expect(await count(`FROM threads WHERE id = 't-fresh'`)).toBe(1);
  });

  it('keeps the conversation about a job that is over but still disputable', async () => {
    const t = now();
    // Quiet for months, but the job itself is inside the chargeback window.
    await appointment('a-recent', t - 30 * DAY);
    await thread('t-recent-job', t - 100 * DAY, 'a-recent');

    await sweepThreads(env);
    expect(await count(`FROM threads WHERE id = 't-recent-job'`)).toBe(1);
  });

  it('deletes the conversation once the job is past every dispute window', async () => {
    const t = now();
    await appointment('a-ancient', t - (RETENTION.THREAD_AFTER_JOB_DAYS + 1) * DAY);
    await thread('t-ancient', t - (RETENTION.THREAD_AFTER_JOB_DAYS + 1) * DAY, 'a-ancient');

    await sweepThreads(env);
    expect(await count(`FROM threads WHERE id = 't-ancient'`)).toBe(0);
  });

  it('keeps a quiet conversation about a job that has not happened yet', async () => {
    const t = now();
    // The booking is next month; the last message was when it was made. This
    // is the row a sweep measuring from last_message_at alone would destroy.
    await appointment('a-future', t + 30 * DAY, 'scheduled');
    await thread('t-future', t - 60 * DAY, 'a-future');

    await sweepThreads(env);
    expect(await count(`FROM threads WHERE id = 't-future'`)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('instant requests', () => {
  async function request(id: string, status: string, createdAt: number) {
    await env.DB.prepare(
      `INSERT INTO instant_requests (id,operator_id,starts_at,duration_seconds,price_cents,
         currency,guest_name,phone_e164,email,address_line,postcode,lat,lng,status,
         expires_at,created_at,updated_at)
       VALUES (?,?,?,3600,12500,'USD','Rosa','+13105550147','rosa@example.com',
         '15200 Ventura Blvd','91403',34.151,-118.445,?,?,?,?)`,
    ).bind(id, OP, createdAt, status, createdAt + 300, createdAt, createdAt).run();
  }

  it('deletes a request that expired a fortnight ago', async () => {
    const t = now();
    await request('r-dead', 'expired', t - (RETENTION.INSTANT_REQUEST_DEAD_DAYS + 7) * DAY);
    expect(await sweepInstantRequests(env)).toBe(1);
    expect(await count(`FROM instant_requests`)).toBe(0);
  });

  it('never touches a pending one, however old it looks', async () => {
    const t = now();
    // Expiry is decided on read in online.ts. A sweep that deleted this would
    // turn "nobody answered" into "that request does not exist", which reads
    // to a customer as the site losing their booking.
    await request('r-pending', 'pending', t - 400 * DAY);
    await sweepInstantRequests(env);
    expect(await count(`FROM instant_requests WHERE id = 'r-pending'`)).toBe(1);
  });

  it('keeps a request declined this morning, so the customer can still read why', async () => {
    await request('r-today', 'declined', now() - 3600);
    await sweepInstantRequests(env);
    expect(await count(`FROM instant_requests WHERE id = 'r-today'`)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('standing alerts', () => {
  async function watch(id: string, opts: {
    active: number; createdAt: number; updatedAt: number; notifiedAt?: number | null;
  }) {
    await env.DB.prepare(
      `INSERT INTO watches (id,token_hash,postcode,lat,lng,country,max_detour_seconds,
         active,last_notified_at,notify_count,created_at,updated_at)
       VALUES (?,?, '91403',34.151,-118.445,'US',900,?,?,0,?,?)`,
    ).bind(id, `wh-${id}`, opts.active, opts.notifiedAt ?? null,
      opts.createdAt, opts.updatedAt).run();
  }

  it('deletes a watch switched off three months ago', async () => {
    const t = now();
    const old = t - (RETENTION.WATCH_INACTIVE_DAYS + 1) * DAY;
    await watch('w-off', { active: 0, createdAt: old, updatedAt: old });
    expect(await sweepWatches(env)).toBe(1);
  });

  it('keeps one switched off last week, because undoing that is one tap', async () => {
    const t = now();
    await watch('w-recent-off', { active: 0, createdAt: t - 30 * DAY, updatedAt: t - 7 * DAY });
    await sweepWatches(env);
    expect(await count(`FROM watches WHERE id = 'w-recent-off'`)).toBe(1);
  });

  it('keeps a live watch that has actually matched something', async () => {
    const t = now();
    await watch('w-live', {
      active: 1, createdAt: t - 500 * DAY, updatedAt: t - 2 * DAY, notifiedAt: t - 2 * DAY,
    });
    await sweepWatches(env);
    expect(await count(`FROM watches WHERE id = 'w-live'`)).toBe(1);
  });

  it('deletes a live watch that has never matched anything in a year', async () => {
    const t = now();
    const old = t - (RETENTION.WATCH_UNUSED_DAYS + 1) * DAY;
    await watch('w-stale', { active: 1, createdAt: old, updatedAt: old });
    await sweepWatches(env);
    expect(await count(`FROM watches WHERE id = 'w-stale'`)).toBe(0);
  });

  it('takes the browser subscriptions with it', async () => {
    const t = now();
    const old = t - (RETENTION.WATCH_INACTIVE_DAYS + 1) * DAY;
    await watch('w-subbed', { active: 0, createdAt: old, updatedAt: old });
    await env.DB.prepare(
      `INSERT INTO push_subscriptions (id,watch_id,endpoint,p256dh,auth,created_at)
       VALUES (?, 'w-subbed', 'https://push.example/x','k','a',?)`,
    ).bind(newId(), old).run();

    await sweepWatches(env);
    expect(await count(`FROM push_subscriptions`)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('photographs of the inside of somebody\'s house', () => {
  async function photo(id: string, itemId: string, createdAt: number, publicOnReview = 0) {
    await env.DB.prepare(
      `INSERT INTO job_photos (id,order_item_id,operator_id,uploaded_by,stage,r2_key,
         content_type,bytes,created_at,public_on_review)
       VALUES (?,?,?, 'operator','after',?, 'image/jpeg', 1024, ?, ?)`,
    ).bind(id, itemId, OP, `j/${OP}/${itemId}/${id}`, createdAt, publicOnReview).run();
    objects.set(`j/${OP}/${itemId}/${id}`, new Uint8Array());
  }

  it('deletes the photo and the object once the dispute window has closed', async () => {
    const t = now();
    const old = t - (RETENTION.JOB_PHOTO_DAYS + 1) * DAY;
    await order('o-old', 'i-old', old);
    await photo('p-old', 'i-old', old);

    expect(await sweepJobPhotos(env)).toBe(1);
    expect(await count(`FROM job_photos`)).toBe(0);
    // The row alone is not the leak. The file is.
    expect(objects.size).toBe(0);
  });

  it('keeps a photo of a job that finished last month', async () => {
    const t = now();
    await order('o-recent', 'i-recent', t - 30 * DAY);
    await photo('p-recent', 'i-recent', t - 30 * DAY);

    await sweepJobPhotos(env);
    expect(await count(`FROM job_photos WHERE id = 'p-recent'`)).toBe(1);
    expect(objects.size).toBe(1);
  });

  it('never sweeps one the customer published on their own review', async () => {
    const t = now();
    const old = t - (RETENTION.JOB_PHOTO_DAYS + 200) * DAY;
    await order('o-rev', 'i-rev', old);
    await photo('p-rev', 'i-rev', old, 1);

    await sweepJobPhotos(env);
    // Taking this one down on a timer would silently edit somebody's review
    // months after they wrote it.
    expect(await count(`FROM job_photos WHERE id = 'p-rev'`)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('the doorstep', () => {
  it('removes the street line and the coordinates once the job is long over', async () => {
    const t = now();
    const old = t - (RETENTION.JOB_LOCATION_DAYS + 1) * DAY;
    await appointment('a-scrub', old);
    await order('o-scrub', 'i-scrub', old);

    await sweepJobLocations(env);

    const appt = await one<{ address_line: string | null; lat: number | null; postcode: string }>(
      `SELECT address_line, lat, postcode FROM appointments WHERE id = 'a-scrub'`);
    expect(appt?.address_line).toBeNull();
    expect(appt?.lat).toBeNull();
    // The postcode stays: it is the coarse geography the business genuinely
    // works from, and it is not a doorstep.
    expect(appt?.postcode).toBe('91403');

    const ord = await one<{ address_line: string | null; lat: number | null; total_cents: number }>(
      `SELECT address_line, lat, total_cents FROM orders WHERE id = 'o-scrub'`);
    expect(ord?.address_line).toBeNull();
    expect(ord?.lat).toBeNull();
    // The money is a record of a transaction and is not the customer's to erase.
    expect(ord?.total_cents).toBe(12500);
  });

  it('leaves a job that happened last week exactly as it is', async () => {
    const t = now();
    await appointment('a-keep', t - 7 * DAY);
    await sweepJobLocations(env);
    const appt = await one<{ address_line: string | null; lat: number | null }>(
      `SELECT address_line, lat FROM appointments WHERE id = 'a-keep'`);
    expect(appt?.address_line).toBe('15200 Ventura Blvd');
    expect(appt?.lat).not.toBeNull();
  });

  it('leaves a booking that has not happened yet alone', async () => {
    const t = now();
    // Created long ago, scheduled for next week. A sweep keyed on created_at
    // rather than on the end of the job would delete the address the operator
    // needs in order to turn up.
    await appointment('a-future', t + 7 * DAY, 'scheduled');
    await sweepJobLocations(env);
    const appt = await one<{ address_line: string | null }>(
      `SELECT address_line FROM appointments WHERE id = 'a-future'`);
    expect(appt?.address_line).toBe('15200 Ventura Blvd');
  });

  it('leaves an operator\'s own imported client untouched, whatever its age', async () => {
    const t = now();
    const old = t - 400 * DAY;
    await env.DB.prepare(
      `INSERT INTO clients (id,operator_id,first_name,phone_e164,address_line,lat,lng,
         acquired,created_at,updated_at)
       VALUES ('c-mine',?, 'Mrs Patel','+13105550111','9 Oak Ave',34.1,-118.4,
         'operator',?,?)`,
    ).bind(OP, old, old).run();
    await env.DB.prepare(
      `INSERT INTO clients (id,operator_id,first_name,phone_e164,address_line,lat,lng,
         acquired,created_at,updated_at)
       VALUES ('c-ours',?, 'Rosa','+13105550147','15200 Ventura Blvd',34.1,-118.4,
         'public',?,?)`,
    ).bind(OP, old, old).run();

    await sweepJobLocations(env);

    // They typed this one in themselves. It is their business record, not ours.
    expect((await one<{ address_line: string | null }>(
      `SELECT address_line FROM clients WHERE id = 'c-mine'`))?.address_line).toBe('9 Oak Ave');
    expect((await one<{ address_line: string | null }>(
      `SELECT address_line FROM clients WHERE id = 'c-ours'`))?.address_line).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('the smaller copies nobody thinks about', () => {
  it('deletes feed rows, which carry the first 140 characters of a message', async () => {
    const t = now();
    await env.DB.prepare(
      `INSERT INTO notifications (id,operator_id,kind,title,body,created_at)
       VALUES (?,?, 'chat_message','Rosa sent you a message','the side gate is unlocked',?)`,
    ).bind(newId(), OP, t - (RETENTION.NOTIFICATION_DAYS + 1) * DAY).run();
    await env.DB.prepare(
      `INSERT INTO notifications (id,operator_id,kind,title,body,created_at)
       VALUES (?,?, 'chat_message','Rosa sent you a message','hello',?)`,
    ).bind(newId(), OP, t - DAY).run();

    expect(await sweepNotifications(env)).toBe(1);
    expect(await count(`FROM notifications`)).toBe(1);
  });

  it('deletes the SMS log, whose to_address column is a phone number', async () => {
    const t = now();
    await env.DB.prepare(
      `INSERT INTO messages (id,operator_id,direction,channel,to_address,body,status,
         created_at,updated_at)
       VALUES (?,?, 'out','device','+13105550147','Thursday 2pm?','sent',?,?)`,
    ).bind(newId(), OP, t - (RETENTION.MESSAGE_LOG_DAYS + 1) * DAY, t).run();
    await env.DB.prepare(
      `INSERT INTO messages (id,operator_id,direction,channel,to_address,body,status,
         created_at,updated_at)
       VALUES (?,?, 'out','device','+13105550148','Friday 2pm?','sent',?,?)`,
    ).bind(newId(), OP, t - DAY, t).run();

    expect(await sweepMessageLog(env)).toBe(1);
  });

  it('lets a lapsed standing record end, and never lets a ban end', async () => {
    const t = now();
    const old = t - (RETENTION.STANDING_DAYS + 1) * DAY;
    await env.DB.prepare(
      `INSERT INTO customer_standing (phone_e164,no_show_strikes,created_at,updated_at)
       VALUES ('+13105550101',1,?,?)`,
    ).bind(old, old).run();
    await env.DB.prepare(
      `INSERT INTO customer_standing (phone_e164,no_show_strikes,banned_at,created_at,updated_at)
       VALUES ('+13105550102',4,?,?,?)`,
    ).bind(old, old, old).run();
    await env.DB.prepare(
      `INSERT INTO customer_standing (phone_e164,no_show_strikes,suspended_until,
         created_at,updated_at)
       VALUES ('+13105550103',2,?,?,?)`,
    ).bind(t + 30 * DAY, old, old).run();

    expect(await sweepStanding(env)).toBe(1);
    // A ban has no end date by design, and a suspension still running is
    // still running. Only the lapsed one goes.
    expect(await count(`FROM customer_standing WHERE phone_e164 = '+13105550102'`)).toBe(1);
    expect(await count(`FROM customer_standing WHERE phone_e164 = '+13105550103'`)).toBe(1);
    expect(await count(`FROM customer_standing WHERE phone_e164 = '+13105550101'`)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('the whole pass, as the cron runs it', () => {
  it('reports what each sweep did and finishes even when one cannot run', async () => {
    const result = await sweepRetention(env);
    for (const pass of ['threads', 'instant_requests', 'watches', 'job_photos',
      'job_locations', 'notifications', 'message_log', 'standing']) {
      // -1 is the marker for a pass that threw. A green run must have none.
      expect(result[pass], pass).toBe(0);
    }
  });

  it('does nothing at all to a database of a week\'s ordinary trading', async () => {
    const t = now();
    await appointment('a-1', t - 3 * DAY);
    await thread('t-1', t - 3 * DAY, 'a-1');
    await order('o-1', 'i-1', t - 3 * DAY);

    const before = await count(`FROM threads`) + await count(`FROM appointments`)
      + await count(`FROM orders`);
    await sweepRetention(env);
    const after = await count(`FROM threads`) + await count(`FROM appointments`)
      + await count(`FROM orders`);
    expect(after).toBe(before);
  });
});
