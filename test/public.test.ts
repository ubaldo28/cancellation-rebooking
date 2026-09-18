import { describe, expect, it } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import type { Env } from '../src/types';
import { claimSlot, mapData, slotById, slotsNear } from '../src/lib/public';
import { DEMO_OPERATOR_ID } from '../src/lib/demo';
import { type HttpError, newId, now, sha256 } from '../src/lib/util';

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
  // stripe_payouts_enabled = 1 is load-bearing, not boilerplate: a business
  // must have somewhere to be paid before its work can be sold, so slotsNear
  // leaves an opening for an operator without it off the public list and
  // claimSlot refuses it. Drop it and nothing in this file is listed at all.
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,timezone,country,currency,language,
       location_mode,fill_model,sms_mode,max_detour_seconds,min_gap_seconds,buffer_seconds,
       offer_ttl_seconds,offers_per_wave,min_notice_seconds,reoffer_cooldown_seconds,
       discount_percent,plan,accept_public_bookings,deposit_cents,created_at,updated_at,
       stripe_payouts_enabled)
     VALUES (?,?,?, 'America/Los_Angeles','US','USD','en','mobile','both','device',
       ?,3600,900,5400,3,3600,604800,0,'active',?,1000,?,?,1)`,
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

    // And not on the claim either, since migration 0035: that table carries an
    // operator_id, so the number on it was one `SELECT *` away from the
    // business. What is left is the peppered digest erasure finds the row by.
    const claim = await env.DB.prepare(`SELECT * FROM public_claims LIMIT 1`)
      .first<any>();
    expect(JSON.stringify(claim)).not.toContain('8185550142');
    expect(claim.phone_hash).toBe(await sha256(`+18185550142:${env.SESSION_PEPPER}`));

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

/**
 * One of lib/demo.ts's seeded businesses, working the same neighbourhood.
 *
 * stripe_payouts_enabled is 0 and that is the true value, not a convenience:
 * none of the sample businesses has a Stripe account because none of them is a
 * business. Everything below turns on that being so — a fixture that gave the
 * sample a payout account would sail through the plain flag filter and prove
 * nothing at all about the exemption.
 *
 * Its service_areas.slug differs from the real operator's while place_slug is
 * identical, which is how demo.ts writes them: that column is globally unique
 * because it is a public URL, and the map groups its pins on place_slug.
 */
async function sampleBusiness(): Promise<string> {
  const n = t();
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,timezone,country,currency,language,
       location_mode,fill_model,sms_mode,max_detour_seconds,min_gap_seconds,buffer_seconds,
       offer_ttl_seconds,offers_per_wave,min_notice_seconds,reoffer_cooldown_seconds,
       discount_percent,plan,accept_public_bookings,deposit_cents,created_at,updated_at,
       stripe_payouts_enabled)
     VALUES (?,?,?, 'America/Los_Angeles','US','USD','en','mobile','both','device',
       900,3600,900,5400,3,3600,604800,0,'active',1,1000,?,?,0)`,
  ).bind(DEMO_OPERATOR_ID, 'demo@roundtheway.app',
    'Valley Shine Mobile Detailing', n, n).run();

  await env.DB.prepare(
    `INSERT INTO services (id,operator_id,name,duration_seconds,price_cents,cadence_days,created_at,updated_at)
     VALUES ('sv-sample',?,'Full detail',7200,18900,28,?,?)`,
  ).bind(DEMO_OPERATOR_ID, n, n).run();

  await env.DB.prepare(
    `INSERT INTO service_areas (id,operator_id,name,slug,place_slug,lat,lng,radius_meters,created_at,updated_at)
     VALUES (?,?,'Sherman Oaks','sherman-oaks-sample','sherman-oaks',?,?,8000,?,?)`,
  ).bind(newId(), DEMO_OPERATOR_ID, PREV.lat, PREV.lng, n, n).run();

  const gapId = newId();
  const start = n + 5 * 3600;
  await env.DB.prepare(
    `INSERT INTO gaps (id,operator_id,starts_at,ends_at,prev_lat,prev_lng,next_lat,next_lng,
       baseline_drive_seconds,is_mobile,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,1,'open',?,?)`,
  ).bind(gapId, DEMO_OPERATOR_ID, start, start + 5 * 3600,
    PREV.lat, PREV.lng, NEXT.lat, NEXT.lng, 180, n, n).run();
  return gapId;
}

describe('who the public listing leaves out, and who it must never leave out', () => {
  it('drops a real business that has nowhere to be paid', async () => {
    const gapId = await seed();
    // Listed first, so the disappearance below is the payout flag and not the
    // fixture quietly failing some other condition.
    expect(await slotsNear(env, NEAR, 'sherman-oaks')).toHaveLength(1);

    // Every booking is paid up front and the operator's share is transferred
    // afterwards. bypass.ts refuses to let a business in this state PUBLISH an
    // opening, but the cron detects gaps for every operator on a live plan, so
    // one reached the map without ever passing that gate — and the customer
    // only found out at the pricing step, after picking a time and typing an
    // address.
    await env.DB.prepare(`UPDATE operators SET stripe_payouts_enabled = 0 WHERE id = ?`)
      .bind(OP).run();

    expect(await slotsNear(env, NEAR, 'sherman-oaks')).toHaveLength(0);
    // And the booking page cannot reach it by id either: that lookup is this
    // same query asked for one row, so the two can never disagree about
    // whether the opening is on sale.
    expect(await slotById(env, gapId)).toBeNull();
  });

  it('keeps the sample businesses on the map even though not one of them can be paid',
    async () => {
      // THIS IS THE TEST THAT STOPS A TIDY-UP BLANKING THE WHOLE PUBLIC MAP.
      //
      // The payout filter above and the sample exemption are one line in the
      // WHERE clause, and the exemption reads like a loophole in the rule
      // beside it. It is not: it is the rule not applying. None of the seeded
      // businesses has a Stripe account because none of them is a business,
      // so a future "why is there an OR here" that deletes the second half
      // takes EVERY sample listing off the map at once — and before the first
      // real operator signs up the samples are the entire contents of the
      // product. The failure is a blank map on a live site, with every query
      // succeeding and nothing in a log to say why.
      //
      // What stops a sample being SOLD is priceOrder's sample_listing refusal
      // and claimSlot's, both pinned below and in orders.test.ts. Being listed
      // and being bookable are two different questions, and this file is the
      // one that says a sample answers yes to the first.
      await seed();
      const sampleGap = await sampleBusiness();

      // The real operator goes unpayable, so nothing but the sample is left to
      // list. A map that survives this is a map a first-time visitor sees.
      await env.DB.prepare(`UPDATE operators SET stripe_payouts_enabled = 0 WHERE id = ?`)
        .bind(OP).run();

      const slots = await slotsNear(env, NEAR, 'sherman-oaks');
      expect(slots.map((s) => s.gap_id)).toEqual([sampleGap]);
      expect(slots[0]!.business_name).toBe('Valley Shine Mobile Detailing');
      // And it is badged as what it is wherever it is drawn, which is the other
      // half of why it is allowed to stay.
      expect(slots[0]!.is_sample).toBe(true);

      // The map's two halves have to agree about who is on it: this query
      // decides which pins exist and what is drawn driving out of them, and
      // filtering only the openings would leave the neighbourhood pinned for
      // nobody. So the sample keeps its pin here too.
      const { areas, slots: pinned } = await mapData(env, NEAR);
      expect(areas.map((a) => a.slug)).toContain('sherman-oaks');
      expect(areas.find((a) => a.slug === 'sherman-oaks')!.slot_count).toBe(1);
      expect(pinned.map((s) => s.gap_id)).toEqual([sampleGap]);
    });
});

describe('the second front door: the no-JavaScript booking form', () => {
  /**
   * The refusal itself rather than only the fact that something was thrown.
   *
   * The code is what the page maps to a sentence, so a test that checked the
   * message alone would pass on a refusal a browser could only render as
   * "something went wrong".
   */
  async function refusal(p: Promise<unknown>): Promise<HttpError> {
    return p.then(
      () => { throw new Error('that booking was supposed to be refused'); },
      (e: HttpError) => e,
    );
  }

  it('refuses a sample opening in the same words the checkout uses', async () => {
    await seed();
    const sampleGap = await sampleBusiness();

    // POST /book/:gapId went through neither priceOrder nor anything else that
    // knew what a sample was, so it would have written an appointment and a
    // client row against a business invented in lib/demo.ts — rows the next
    // reseed deletes underneath the customer, for work nobody was going to
    // turn up and do.
    const e = await refusal(claimSlot(env, {
      gapId: sampleGap, first_name: 'Rosa', phone: '8185550142',
      postcode: '91403', address_line: '15200 Ventura Blvd',
    }));
    expect(e.code).toBe('sample_listing');
    expect(e.message).toContain('Valley Shine Mobile Detailing');
    expect(e.message).toContain('sample data, not a real business');

    // Nothing was written on the way to the refusal.
    const appts = await env.DB.prepare(`SELECT COUNT(*) AS n FROM appointments`)
      .first<{ n: number }>();
    expect(appts!.n).toBe(0);
  });

  it('refuses a real opening with nowhere to send the money, and says no more', async () => {
    const gapId = await seed();
    // The listing query hides this business now, but the gap id travels in the
    // URL of the form and a page cached before the account went bad still
    // posts to it.
    await env.DB.prepare(`UPDATE operators SET stripe_payouts_enabled = 0 WHERE id = ?`)
      .bind(OP).run();

    const e = await refusal(claimSlot(env, {
      gapId, first_name: 'Rosa', phone: '8185550142',
      postcode: '91403', address_line: '15200 Ventura Blvd',
    }));
    expect(e.message).toBe('That opening is no longer listed.');
    // Somebody's bank arrangements are not a stranger's business — the same
    // reason priceOrder gives the vague answer for a real operator. A later
    // "more helpful" wording here would be the platform telling the public
    // that a named business's payouts have fallen over.
    expect(e.message).not.toMatch(/payout|bank|stripe/i);

    const appts = await env.DB.prepare(`SELECT COUNT(*) AS n FROM appointments`)
      .first<{ n: number }>();
    expect(appts!.n).toBe(0);
  });
});
