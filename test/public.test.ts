import { describe, expect, it, beforeEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import type { Env } from '../src/types';
import { claimSlot, slotById, slotsNear } from '../src/lib/public';
import { newId, now } from '../src/lib/util';

const MIGRATIONS = ALL_MIGRATIONS;

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
    `INSERT INTO service_areas (id,operator_id,name,slug,place_slug,lat,lng,radius_meters,created_at,updated_at)
     VALUES (?,?,'Sherman Oaks','sherman-oaks','sherman-oaks',?,?,8000,?,?)`,
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

describe('regressions in the public listing', () => {
  it('lists a slot once even when the operator covers several areas', async () => {
    const gapId = await seed();
    const n = t();
    // Same operator, three overlapping areas. The join used to return the gap
    // once per area, so one opening appeared three times on the page.
    for (const [name, slug] of [['Valley Village', 'valley-village'],
                                ['Studio City', 'studio-city']] as const) {
      await env.DB.prepare(
        `INSERT INTO service_areas (id,operator_id,name,slug,place_slug,lat,lng,radius_meters,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,8000,?,?)`,
      ).bind(newId(), OP, name, slug, slug, PREV.lat, PREV.lng, n, n).run();
    }
    const all = await slotsNear(env, NEAR, null);
    expect(all.filter((s) => s.gap_id === gapId).length).toBe(1);
  });

  it('lists a slot once even when the operator sells several services', async () => {
    const gapId = await seed();
    const n = t();
    await env.DB.prepare(
      `INSERT INTO services (id,operator_id,name,duration_seconds,price_cents,created_at,updated_at)
       VALUES ('sv2',?,'Wash only',3600,4900,?,?)`,
    ).bind(OP, n, n).run();
    const slots = await slotsNear(env, NEAR, 'sherman-oaks');
    expect(slots.filter((s) => s.gap_id === gapId).length).toBe(1);
    // And it offers the most valuable service that fits — the same one
    // claimSlot would pick, so the price shown is the price charged.
    expect(slots[0]!.service_name).toBe('Full detail');
  });

  it('finds a slot by id regardless of how far down the list it sits', async () => {
    const gapId = await seed();
    const n = t();
    // Bury it under a pile of earlier openings. The old booking page fetched a
    // capped page of slots and searched it, so anything past the cap read as
    // "gone" while it was still live and bookable.
    for (let i = 1; i <= 40; i++) {
      const start = n + 3600 + i * 60;
      await env.DB.prepare(
        `INSERT INTO gaps (id,operator_id,starts_at,ends_at,prev_lat,prev_lng,
           next_lat,next_lng,baseline_drive_seconds,is_mobile,status,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,1,'open',?,?)`,
      ).bind(newId(), OP, start, start + 5 * 3600,
        PREV.lat, PREV.lng, NEXT.lat, NEXT.lng, 180, n, n).run();
    }
    const one = await slotById(env, gapId);
    expect(one).not.toBeNull();
    expect(one!.gap_id).toBe(gapId);
  });

  it('returns nothing for a gap id that does not exist', async () => {
    await seed();
    expect(await slotById(env, 'no-such-gap')).toBeNull();
  });
});

describe('what a card says about the business', () => {
  /** A finished job with a review on it, as leaveReview would have left it. */
  async function review(
    opts: { author: string; rating: number; body: string | null; createdAt: number },
  ) {
    await env.DB.prepare(
      `INSERT INTO reviews (id,operator_id,order_item_id,author_name,rating,body,
         details,created_at,updated_at)
       VALUES (?,?,?,?,?,?,NULL,?,?)`,
    ).bind(newId(), OP, newId(), opts.author, opts.rating, opts.body,
      opts.createdAt, opts.createdAt).run();
    // Denormalised on the operator by leaveReview, and read from there by the
    // listing, so the fixture has to keep the two in step the same way.
    await env.DB.prepare(
      `UPDATE operators SET rating_sum = rating_sum + ?, rating_count = rating_count + 1
        WHERE id = ?`,
    ).bind(opts.rating, OP).run();
  }

  it('shows no rating and no quote for a business nobody has reviewed', async () => {
    await seed();
    const slot = (await slotsNear(env, NEAR, 'sherman-oaks'))[0]!;
    // Null, not 0 and not 5. A business with no reviews has no rating; giving
    // it one would be the platform inventing a reputation for a stranger.
    expect(slot.rating).toBeNull();
    expect(slot.review_count).toBe(0);
    expect(slot.review_snippet).toBeNull();
    expect(slot.hired_count).toBe(0);
    expect(slot.background_check).toBe(false);
  });

  it('shows the score and the newest quote, surname cut to an initial', async () => {
    await seed();
    const n = t();
    await review({ author: 'Debra Delgado', rating: 5, body: 'Spotless.', createdAt: n - 7200 });
    await review({ author: 'Marcus Oyelaran', rating: 4, body: 'On time, fair price.',
      createdAt: n - 600 });

    const slot = (await slotsNear(env, NEAR, 'sherman-oaks'))[0]!;
    expect(slot.rating).toBe(4.5);
    expect(slot.review_count).toBe(2);
    expect(slot.review_snippet).toEqual({
      body: 'On time, fair price.', author: 'Marcus O.', rating: 4,
    });
  });

  it('rates a business off its reviews but quotes only one that has words', async () => {
    await seed();
    const n = t();
    await review({ author: 'Debra Delgado', rating: 5, body: 'Spotless.', createdAt: n - 7200 });
    // Newer, but a bare star rating. The stars still count towards the score;
    // there is simply no line for the card to print, so the older one stands.
    await review({ author: 'Marcus Oyelaran', rating: 4, body: null, createdAt: n - 600 });

    const slot = (await slotsNear(env, NEAR, 'sherman-oaks'))[0]!;
    expect(slot.rating).toBe(4.5);
    expect(slot.review_snippet?.body).toBe('Spotless.');
    expect(slot.review_snippet?.author).toBe('Debra D.');
  });

  it('is online only while the switch still has time left on it', async () => {
    await seed();
    expect((await slotsNear(env, NEAR, 'sherman-oaks'))[0]!.online).toBe(false);

    await env.DB.prepare(`UPDATE operators SET online_until = ? WHERE id = ?`)
      .bind(t() + 1800, OP).run();
    expect((await slotsNear(env, NEAR, 'sherman-oaks'))[0]!.online).toBe(true);

    // Nothing sweeps this. "Online" is online_until > now and nothing else, so
    // a timestamp that has passed reads as off without anything having run.
    await env.DB.prepare(`UPDATE operators SET online_until = ? WHERE id = ?`)
      .bind(t() - 60, OP).run();
    expect((await slotsNear(env, NEAR, 'sherman-oaks'))[0]!.online).toBe(false);
  });

  it('carries the profile numbers a card shows next to the name', async () => {
    await seed();
    await env.DB.prepare(
      `UPDATE operators SET hired_count = 314, years_in_business = 12, employees = 4,
         background_check_name = 'Ana Ruiz', background_checked_at = ? WHERE id = ?`,
    ).bind(t() - 86400, OP).run();

    const slot = (await slotsNear(env, NEAR, 'sherman-oaks'))[0]!;
    expect(slot.hired_count).toBe(314);
    expect(slot.years_in_business).toBe(12);
    expect(slot.employees).toBe(4);
    expect(slot.background_check).toBe(true);
  });

  it('says the same things on the confirmation as it did on the card', async () => {
    const gapId = await seed();
    await review({ author: 'Debra Delgado', rating: 5, body: 'Spotless.', createdAt: t() - 600 });
    const { slot } = await claimSlot(env, {
      gapId, first_name: 'Rosa', phone: '8185550142', postcode: '91403',
      address_line: '15200 Ventura Blvd',
    });
    expect(slot.rating).toBe(5);
    expect(slot.review_count).toBe(1);
    expect(slot.review_snippet?.author).toBe('Debra D.');
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
    expect(client.acquired).toBe('public');      // this is the billable one
    // The operator gets a real client and a real address, and no way to
    // contact this person off the platform. The number lives on the claim,
    // which is ours, not on their list.
    expect(client.platform_introduced).toBe(1);
    expect(client.phone_e164).toBeNull();
    expect(client.address_line).toBe('15200 Ventura Blvd');

    const claim = await env.DB.prepare(`SELECT phone_e164 FROM public_claims LIMIT 1`)
      .first<any>();
    expect(claim.phone_e164).toBe('+18185550142');

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
