import { describe, expect, it } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import type { Env, Operator } from '../src/types';
import { cancelOpening, listOpenings, postOpening } from '../src/lib/openings';
import { detectGaps } from '../src/lib/gaps';
import { slotsNear } from '../src/lib/public';
import { newId, now } from '../src/lib/util';

const MIGRATIONS = ALL_MIGRATIONS;

let env: Env;
const OP = 'op1';
const OTHER = 'op2';
const t = () => now();

const PREV = { lat: 34.1500, lng: -118.4490 };
const NEAR = { lat: 34.1510, lng: -118.4450 };

async function seed() {
  env = makeEnv(MIGRATIONS) as unknown as Env;
  const n = t();

  for (const [id, email, name] of [
    [OP, 'a@x.com', 'Valley Detailing'],
    [OTHER, 'b@x.com', 'Encino Barbers'],
  ] as const) {
    await env.DB.prepare(
      `INSERT INTO operators (id,email,business_name,timezone,country,currency,language,
         location_mode,fill_model,sms_mode,max_detour_seconds,min_gap_seconds,buffer_seconds,
         offer_ttl_seconds,offers_per_wave,min_notice_seconds,reoffer_cooldown_seconds,
         discount_percent,plan,accept_public_bookings,deposit_cents,created_at,updated_at)
       VALUES (?,?,?, 'America/Los_Angeles','US','USD','en','mobile','both','device',
         3600,3600,900,5400,3,3600,604800,0,'active',1,1000,?,?)`,
    ).bind(id, email, name, n, n).run();
  }

  await env.DB.prepare(
    `INSERT INTO services (id,operator_id,name,duration_seconds,price_cents,created_at,updated_at)
     VALUES ('sv-detail',?,'Full detail',7200,9900,?,?)`,
  ).bind(OP, n, n).run();
  await env.DB.prepare(
    `INSERT INTO services (id,operator_id,name,duration_seconds,price_cents,created_at,updated_at)
     VALUES ('sv-wash',?,'Wash only',3600,4900,?,?)`,
  ).bind(OP, n, n).run();
  // Belongs to the OTHER business. op1 must never be able to sell it.
  await env.DB.prepare(
    `INSERT INTO services (id,operator_id,name,duration_seconds,price_cents,created_at,updated_at)
     VALUES ('sv-cut',?,'Cut',1800,3500,?,?)`,
  ).bind(OTHER, n, n).run();

  await env.DB.prepare(
    `INSERT INTO service_areas (id,operator_id,name,slug,place_slug,lat,lng,radius_meters,created_at,updated_at)
     VALUES (?,?,'Sherman Oaks','sherman-oaks','sherman-oaks',?,?,8000,?,?)`,
  ).bind(newId(), OP, PREV.lat, PREV.lng, n, n).run();

  // Detection needs a working week to have anything to subtract from.
  for (let weekday = 0; weekday < 7; weekday++) {
    await env.DB.prepare(
      `INSERT INTO working_hours (id,operator_id,weekday,start_minute,end_minute,created_at)
       VALUES (?,?,?,540,1020,?)`,
    ).bind(newId(), OP, weekday, n).run();
  }

  return n;
}

const operatorRow = async (id = OP) =>
  (await env.DB.prepare(`SELECT * FROM operators WHERE id = ?`).bind(id).first<Operator>())!;

const gapStatus = async (id: string) =>
  (await env.DB.prepare(`SELECT status FROM gaps WHERE id = ?`).bind(id).first<{ status: string }>())!.status;

describe('posting an opening by hand', () => {
  it('puts a slot on the public list without any calendar behind it', async () => {
    const n = await seed();
    // No appointments, no imported schedule — the whole point. Someone who
    // already has a full book types one free afternoon and it is for sale.
    const opening = await postOpening(env, OP, {
      starts_at: n + 4 * 3600, ends_at: n + 7 * 3600,
    });
    expect(opening.source).toBe('posted');

    const slots = await slotsNear(env, NEAR, 'sherman-oaks');
    expect(slots).toHaveLength(1);
    expect(slots[0]!.gap_id).toBe(opening.id);
    expect(slots[0]!.service_name).toBe('Full detail');
  });

  it('refuses a slot in the past', async () => {
    const n = await seed();
    await expect(postOpening(env, OP, { starts_at: n - 3600, ends_at: n + 3600 }))
      .rejects.toThrow(/in the past/i);
  });

  it('refuses a slot that ends before it starts', async () => {
    const n = await seed();
    await expect(postOpening(env, OP, { starts_at: n + 7200, ends_at: n + 3600 }))
      .rejects.toThrow(/end after it starts/i);
  });

  it('refuses a slot that overlaps a job already booked', async () => {
    const n = await seed();
    await env.DB.prepare(
      `INSERT INTO appointments (id,operator_id,starts_at,ends_at,is_mobile,status,source,created_at,updated_at)
       VALUES (?,?,?,?,1,'scheduled','manual',?,?)`,
    ).bind(newId(), OP, n + 4 * 3600, n + 6 * 3600, n, n).run();

    await expect(postOpening(env, OP, { starts_at: n + 5 * 3600, ends_at: n + 7 * 3600 }))
      .rejects.toThrow(/already have a job/i);
  });

  it('refuses a slot that overlaps one already listed as open', async () => {
    const n = await seed();
    await postOpening(env, OP, { starts_at: n + 4 * 3600, ends_at: n + 7 * 3600 });
    await expect(postOpening(env, OP, { starts_at: n + 5 * 3600, ends_at: n + 6 * 3600 }))
      .rejects.toThrow(/already listed as open/i);
  });

  it('will not let one business sell another business’s service', async () => {
    const n = await seed();
    await expect(postOpening(env, OP, {
      starts_at: n + 4 * 3600, ends_at: n + 7 * 3600, service_ids: ['sv-cut'],
    })).rejects.toThrow(/price list/i);

    const gaps = await env.DB.prepare(`SELECT COUNT(*) AS n FROM gaps`).first<{ n: number }>();
    expect(gaps!.n).toBe(0);
  });

  it('records the chosen services once each, and lists them back', async () => {
    const n = await seed();
    const opening = await postOpening(env, OP, {
      starts_at: n + 4 * 3600, ends_at: n + 7 * 3600,
      // The duplicate is a double-tap on a chip, not two of the same job.
      service_ids: ['sv-detail', 'sv-wash', 'sv-detail'],
    });
    expect(opening.service_ids.sort()).toEqual(['sv-detail', 'sv-wash']);

    const mine = await listOpenings(env, OP, n, n + 7 * 86400);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.service_ids.sort()).toEqual(['sv-detail', 'sv-wash']);

    // Every read is scoped by operator_id, so the other business sees nothing.
    expect(await listOpenings(env, OTHER, n, n + 7 * 86400)).toHaveLength(0);
  });

  it('takes a slot back down, and only for the business that owns it', async () => {
    const n = await seed();
    const opening = await postOpening(env, OP, {
      starts_at: n + 4 * 3600, ends_at: n + 7 * 3600,
    });
    await expect(cancelOpening(env, OTHER, opening.id)).rejects.toThrow(/not yours|not open/i);
    expect(await gapStatus(opening.id)).toBe('open');

    await cancelOpening(env, OP, opening.id);
    expect(await gapStatus(opening.id)).toBe('dismissed');
  });
});

describe('gap detection and posted openings', () => {
  it('expires a detected gap that no longer matches free time, and leaves a posted one alone', async () => {
    const n = await seed();

    // Typed by a person. Nothing in the calendar corresponds to it, which is
    // exactly why the expiry pass would have deleted it before migration 0016.
    const posted = await postOpening(env, OP, {
      starts_at: n + 30 * 3600, ends_at: n + 32 * 3600,
    });

    // Derived state that has gone stale: a window detection will never produce
    // again, because the job that made it has moved.
    const stale = newId();
    await env.DB.prepare(
      `INSERT INTO gaps (id,operator_id,starts_at,ends_at,is_mobile,status,created_at,updated_at)
       VALUES (?,?,?,?,1,'open',?,?)`,
    ).bind(stale, OP, n + 50 * 3600 + 137, n + 52 * 3600 + 137, n, n).run();

    const res = await detectGaps(env, await operatorRow(), n, 14);

    expect(await gapStatus(stale)).toBe('expired');
    expect(res.expired).toBe(1);
    expect(await gapStatus(posted.id)).toBe('open');
  });

  it('still leaves the posted opening alone on a second run', async () => {
    const n = await seed();
    const posted = await postOpening(env, OP, {
      starts_at: n + 30 * 3600, ends_at: n + 32 * 3600,
    });
    await detectGaps(env, await operatorRow(), n, 14);
    await detectGaps(env, await operatorRow(), n, 14);
    expect(await gapStatus(posted.id)).toBe('open');
  });
});
