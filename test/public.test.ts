import { describe, expect, it, beforeEach } from 'vitest';
import { makeEnv } from './d1';
import type { Env } from '../src/types';
import { claimSlot, slotsNear } from '../src/lib/public';
import { newId, now } from '../src/lib/util';

const MIGRATIONS = [1, 2, 3, 4, 5, 6].map((n) => {
  const names: Record<number, string> = {
    1: '0001_init.sql', 2: '0002_postal_codes.sql', 3: '0003_hardening.sql',
    4: '0004_scan_budget.sql', 5: '0005_language.sql', 6: '0006_public_booking.sql',
  };
  return new URL(`../migrations/${names[n]}`, import.meta.url).pathname;
});

let env: Env;
const OP = 'op1';
const t = () => now();

// Sherman Oaks-ish. The customer sits between the two jobs; the far address
// is over the hill in Woodland Hills.
const PREV = { lat: 34.1500, lng: -118.4490 };
const NEXT = { lat: 34.1520, lng: -118.4400 };
const NEAR = { lat: 34.1510, lng: -118.4450 };
const FAR = { lat: 34.1680, lng: -118.6050 };

async function seed(opts: { publicBookings?: boolean; maxDetour?: number } = {}) {
  env = makeEnv(MIGRATIONS) as unknown as Env;
  const n = t();
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,timezone,country,currency,language,
       location_mode,fill_model,sms_mode,max_detour_seconds,min_gap_seconds,buffer_seconds,
       offer_ttl_seconds,offers_per_wave,min_notice_seconds,reoffer_cooldown_seconds,
       discount_percent,plan,accept_public_bookings,deposit_cents,created_at,updated_at)
     VALUES (?,?,?, 'America/Los_Angeles','US','USD','en','mobile','both','device',
       ?,3600,900,5400,3,3600,604800,0,'active',?,1000,?,?)`,
  ).bind(OP, 'a@x.com', 'Valley Detailing',
    opts.maxDetour ?? 900, opts.publicBookings === false ? 0 : 1, n, n).run();

  await env.DB.prepare(
    `INSERT INTO services (id,operator_id,name,duration_seconds,price_cents,cadence_days,created_at,updated_at)
     VALUES ('sv',?,'Full detail',7200,9900,28,?,?)`,
  ).bind(OP, n, n).run();

  await env.DB.prepare(
    `INSERT INTO service_areas (id,operator_id,name,slug,lat,lng,radius_meters,created_at,updated_at)
     VALUES (?,?,'Sherman Oaks','sherman-oaks',?,?,8000,?,?)`,
  ).bind(newId(), OP, PREV.lat, PREV.lng, n, n).run();

  // The offline geocoder needs the ZIP to exist, same as in production.
  await env.DB.prepare(
    `INSERT INTO postal_codes (country_code,postal_code,place_name,lat,lng,accuracy)
     VALUES ('US','91403','Sherman Oaks',?,?,6)`,
  ).bind(NEAR.lat, NEAR.lng).run();
  await env.DB.prepare(
    `INSERT INTO postal_codes (country_code,postal_code,place_name,lat,lng,accuracy)
     VALUES ('US','91367','Woodland Hills',?,?,6)`,
  ).bind(FAR.lat, FAR.lng).run();

  const gapId = newId();
  const start = n + 4 * 3600;
  await env.DB.prepare(
    `INSERT INTO gaps (id,operator_id,starts_at,ends_at,prev_lat,prev_lng,next_lat,next_lng,
       baseline_drive_seconds,is_mobile,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,1,'open',?,?)`,
  ).bind(gapId, OP, start, start + 5 * 3600,
    PREV.lat, PREV.lng, NEXT.lat, NEXT.lng, 180, n, n).run();
  return gapId;
}

describe('what a stranger sees', () => {
  it('lists a nearby slot with the reason it is cheap', async () => {
    await seed();
    const slots = await slotsNear(env, NEAR, 'sherman-oaks');
    expect(slots.length).toBe(1);
    expect(slots[0]!.business_name).toBe('Valley Detailing');
    expect(slots[0]!.price).toContain('99');
    expect(slots[0]!.proximity).toBeTruthy();
    expect(slots[0]!.detour_minutes).toBeLessThanOrEqual(15);
  });

  it('hides a slot that would drag the operator off their route', async () => {
    await seed({ maxDetour: 300 });          // 5 minutes of tolerance
    expect(await slotsNear(env, FAR, 'sherman-oaks')).toHaveLength(0);
  });

  it('shows nothing for an operator who never opted in', async () => {
    await seed({ publicBookings: false });
    expect(await slotsNear(env, NEAR, 'sherman-oaks')).toHaveLength(0);
  });

  it('never lists a slot that starts within the hour', async () => {
    const gapId = await seed();
    await env.DB.prepare(`UPDATE gaps SET starts_at = ?, ends_at = ? WHERE id = ?`)
      .bind(t() + 600, t() + 4000, gapId).run();
    expect(await slotsNear(env, NEAR, 'sherman-oaks')).toHaveLength(0);
  });
});

describe('claiming a slot', () => {
  it('creates a client marked as won by the platform, plus the appointment', async () => {
    const gapId = await seed();
    const { appointment_id } = await claimSlot(env, {
      gapId, first_name: 'Rosa', phone: '(818) 555-0142',
      address_line: '15200 Ventura Blvd', postcode: '91403',
    });

    const client = await env.DB.prepare(`SELECT * FROM clients LIMIT 1`).first<any>();
    expect(client.first_name).toBe('Rosa');
    expect(client.phone_e164).toBe('+18185550142');
    expect(client.acquired).toBe('public');      // this is the billable one

    const appt = await env.DB.prepare(`SELECT * FROM appointments WHERE id=?`)
      .bind(appointment_id).first<any>();
    expect(appt.source).toBe('online');
    expect(appt.price_cents).toBe(9900);

    const gap = await env.DB.prepare(`SELECT status FROM gaps WHERE id=?`).bind(gapId).first<any>();
    expect(gap.status).toBe('filled');
  });

  it('lets only one of two simultaneous strangers win', async () => {
    const gapId = await seed();
    const one = claimSlot(env, {
      gapId, first_name: 'Rosa', phone: '8185550142', postcode: '91403',
      address_line: '15200 Ventura Blvd',
    });
    const two = claimSlot(env, {
      gapId, first_name: 'Dan', phone: '8185550199', postcode: '91403',
      address_line: '15300 Ventura Blvd',
    }).catch((e) => e);

    await one;
    const second = await two;
    expect(second).toBeInstanceOf(Error);
    expect(String(second)).toMatch(/just been taken|no longer/i);

    const appts = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM appointments`).first<{ n: number }>();
    expect(appts!.n).toBe(1);
    const claims = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM public_claims WHERE status='confirmed'`).first<{ n: number }>();
    expect(claims!.n).toBe(1);
  });

  it('refuses a booking with no address when the operator has to drive there', async () => {
    const gapId = await seed();
    await expect(claimSlot(env, {
      gapId, first_name: 'Rosa', phone: '8185550142',
    })).rejects.toThrow(/address/i);
  });

  it('refuses a number that is not a real US mobile', async () => {
    const gapId = await seed();
    await expect(claimSlot(env, {
      gapId, first_name: 'Rosa', phone: '12', postcode: '91403',
      address_line: '15200 Ventura Blvd',
    })).rejects.toThrow(/valid mobile/i);
  });

  it('takes the slot off the public list once claimed', async () => {
    const gapId = await seed();
    await claimSlot(env, {
      gapId, first_name: 'Rosa', phone: '8185550142', postcode: '91403',
      address_line: '15200 Ventura Blvd',
    });
    expect(await slotsNear(env, NEAR, 'sherman-oaks')).toHaveLength(0);
  });
});
