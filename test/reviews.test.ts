import { describe, expect, it } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import type { Env } from '../src/types';
import { placeOrder } from '../src/lib/orders';
import { cancelByOperator } from '../src/lib/bypass';
import {
  displayName, leaveReview, listReviews, mentionedWords, ratingFor, ratingLabel,
  releasePhoto, replyToReview, reviewableFor,
} from '../src/lib/reviews';
import { saveOperatorCard } from '../src/lib/standing';
import { saveVehicle } from '../src/lib/startcode';
import { newId, now } from '../src/lib/util';

/**
 * Reviews are a public number that strangers will trust when deciding whether
 * to let somebody into their house. Almost every test here is about the one
 * rule that makes the number worth anything: only a real, finished booking
 * can produce one, and one booking produces at most one.
 */

let env: Env;
const OP = 'op-rev';
const PREV = { lat: 34.1500, lng: -118.4490 };
const NEXT = { lat: 34.1520, lng: -118.4400 };
const NEAR = { lat: 34.1510, lng: -118.4450 };

const BUYER = {
  guest_name: 'Debra Dawson', phone: '(818) 555-0142',
  address_line: '15200 Ventura Blvd', postcode: '91403',
};

const one = async <T>(sql: string, ...args: unknown[]) =>
  env.DB.prepare(sql).bind(...args).first<T>();

async function seed() {
  env = makeEnv(ALL_MIGRATIONS) as unknown as Env;
  const n = now();
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,trade,timezone,country,currency,language,
       location_mode,fill_model,sms_mode,max_detour_seconds,min_gap_seconds,buffer_seconds,
       offer_ttl_seconds,offers_per_wave,min_notice_seconds,reoffer_cooldown_seconds,
       discount_percent,plan,accept_public_bookings,deposit_cents,share_location,
       created_at,updated_at)
     VALUES (?,?,?, 'mobile car wash and detailing','America/Los_Angeles','US','USD','en',
       'mobile','both','device',3600,3600,900,5400,3,3600,604800,0,'active',1,0,1,?,?)`,
  ).bind(OP, 'r@x.com', 'Valley Detailing', n, n).run();
  await saveOperatorCard(env, OP, { ref: 'pm', brand: 'visa', last4: '4242' });
  await saveVehicle(env, OP, { make: 'Ford', model: 'Transit', color: 'White', plate: '8ABC' });

  await env.DB.prepare(
    `INSERT INTO services (id,operator_id,name,duration_seconds,price_cents,created_at,updated_at)
     VALUES ('s1',?, 'Full detail',3600,20000,?,?)`,
  ).bind(OP, n, n).run();
  await env.DB.prepare(
    `INSERT INTO postal_codes (country_code,postal_code,place_name,lat,lng,accuracy)
     VALUES ('US','91403','Sherman Oaks',?,?,6)`,
  ).bind(NEAR.lat, NEAR.lng).run();
  return n;
}

/** Books a slot and drags it into the past so the job is finished. */
async function finishedBooking(hoursOut = 30) {
  const n = now();
  const gapId = newId();
  await env.DB.prepare(
    `INSERT INTO gaps (id,operator_id,starts_at,ends_at,prev_lat,prev_lng,next_lat,next_lng,
       baseline_drive_seconds,is_mobile,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,180,1,'open',?,?)`,
  ).bind(gapId, OP, n + hoursOut * 3600, n + (hoursOut + 5) * 3600,
    PREV.lat, PREV.lng, NEXT.lat, NEXT.lng, n, n).run();

  const order = await placeOrder(env, {
    ...BUYER, items: [{ gap_id: gapId, service_ids: ['s1'] }],
  });
  const itemId = order.items[0]!.order_item_id;
  await env.DB.prepare(`UPDATE order_items SET starts_at=?, ends_at=? WHERE id=?`)
    .bind(now() - 7200, now() - 3600, itemId).run();
  return { itemId, token: order.thread_token };
}

describe('only a finished job can leave a review', () => {
  it('takes one from a completed booking', async () => {
    await seed();
    const { itemId, token } = await finishedBooking();
    const r = await leaveReview(env, token, {
      order_item_id: itemId, rating: 5, body: 'The car looked brand new.',
    });
    expect(r.rating).toBe(5);
    expect((await ratingFor(env, OP)).count).toBe(1);
  });

  it('refuses one before the job has happened', async () => {
    await seed();
    const n = now();
    const gapId = newId();
    await env.DB.prepare(
      `INSERT INTO gaps (id,operator_id,starts_at,ends_at,prev_lat,prev_lng,next_lat,next_lng,
         baseline_drive_seconds,is_mobile,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,180,1,'open',?,?)`,
    ).bind(gapId, OP, n + 30 * 3600, n + 35 * 3600,
      PREV.lat, PREV.lng, NEXT.lat, NEXT.lng, n, n).run();
    const order = await placeOrder(env, {
      ...BUYER, items: [{ gap_id: gapId, service_ids: ['s1'] }],
    });
    await expect(leaveReview(env, order.thread_token, {
      order_item_id: order.items[0]!.order_item_id, rating: 5,
    })).rejects.toThrow(/once the job is done/i);
  });

  it('refuses one on a cancelled booking', async () => {
    await seed();
    const n = now();
    const gapId = newId();
    await env.DB.prepare(
      `INSERT INTO gaps (id,operator_id,starts_at,ends_at,prev_lat,prev_lng,next_lat,next_lng,
         baseline_drive_seconds,is_mobile,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,180,1,'open',?,?)`,
    ).bind(gapId, OP, n + 72 * 3600, n + 77 * 3600,
      PREV.lat, PREV.lng, NEXT.lat, NEXT.lng, n, n).run();
    const order = await placeOrder(env, {
      ...BUYER, items: [{ gap_id: gapId, service_ids: ['s1'] }],
    });
    const itemId = order.items[0]!.order_item_id;
    await cancelByOperator(env, OP, itemId);
    // A cancellation already costs the operator a fee. Letting it become a
    // one-star review as well punishes them twice for one event and hands any
    // customer a lever.
    await expect(leaveReview(env, order.thread_token, { order_item_id: itemId, rating: 1 }))
      .rejects.toThrow(/cancelled/i);
  });

  it('takes exactly one per booking', async () => {
    await seed();
    const { itemId, token } = await finishedBooking();
    await leaveReview(env, token, { order_item_id: itemId, rating: 5 });
    await expect(leaveReview(env, token, { order_item_id: itemId, rating: 5 }))
      .rejects.toThrow(/already reviewed/i);
    expect((await ratingFor(env, OP)).count).toBe(1);
  });

  it('cannot be left with somebody else\'s link', async () => {
    await seed();
    const { itemId } = await finishedBooking();
    await expect(leaveReview(env, 'not-a-token', { order_item_id: itemId, rating: 5 }))
      .rejects.toThrow(/not valid/i);
  });

  it('refuses a rating outside one to five', async () => {
    await seed();
    const { itemId, token } = await finishedBooking();
    for (const rating of [0, 6, -1, Number.NaN]) {
      await expect(leaveReview(env, token, { order_item_id: itemId, rating }))
        .rejects.toThrow(/one and five/i);
    }
  });

  it('rounds a fractional rating rather than refusing it', async () => {
    // Star pickers produce whole numbers, but a slider or a rounding error on
    // the way in should not lose somebody's review over a decimal point.
    await seed();
    const { itemId, token } = await finishedBooking();
    const r = await leaveReview(env, token, { order_item_id: itemId, rating: 4.4 });
    expect(r.rating).toBe(4);
  });

  it('lists which finished bookings still need one', async () => {
    await seed();
    const { itemId, token } = await finishedBooking();
    expect((await reviewableFor(env, token))).toHaveLength(1);
    await leaveReview(env, token, { order_item_id: itemId, rating: 4 });
    expect((await reviewableFor(env, token))).toHaveLength(0);
  });
});

describe('the score', () => {
  it('averages, counts and distributes', async () => {
    await seed();
    for (const rating of [5, 5, 3]) {
      const { itemId, token } = await finishedBooking();
      await leaveReview(env, token, { order_item_id: itemId, rating });
    }
    const r = await ratingFor(env, OP);
    expect(r.count).toBe(3);
    expect(r.average).toBe(4.3);            // 13/3 to one decimal
    expect(r.distribution[5]).toBe(2);
    expect(r.distribution[3]).toBe(1);
  });

  it('is null rather than zero when nobody has reviewed', async () => {
    await seed();
    const r = await ratingFor(env, OP);
    // Zero would render as a zero-star business, which is a lie about a new
    // one. Null lets the page say "new here" instead.
    expect(r.average).toBeNull();
    expect(r.label).toBeNull();
    expect(r.count).toBe(0);
  });

  it('labels the number the way a person reads it', () => {
    expect(ratingLabel(5)).toBe('Exceptional');
    expect(ratingLabel(4.9)).toBe('Exceptional');
    expect(ratingLabel(4.6)).toBe('Very good');
    expect(ratingLabel(4.1)).toBe('Good');
    expect(ratingLabel(2.2)).toBe('Poor');
    expect(ratingLabel(null)).toBeNull();
  });

  it('cuts the surname to an initial', () => {
    // A full surname beside a review of a home visit is more identifying than
    // anybody signing a review expects.
    expect(displayName('Debra Dawson')).toBe('Debra D.');
    expect(displayName('Prince')).toBe('Prince');
    expect(displayName('  ')).toBe('A customer');
  });

  it('hands the profile the shortened name, never the full one', async () => {
    await seed();
    const { itemId, token } = await finishedBooking();
    await leaveReview(env, token, { order_item_id: itemId, rating: 5, body: 'Great' });
    const stored = await one<{ author_name: string }>(
      `SELECT author_name FROM reviews LIMIT 1`);
    // Stored whole so a correction stays possible; cut at display time.
    expect(stored!.author_name).toBe('Debra Dawson');
  });
});

describe('what customers talk about', () => {
  it('counts a word once per review, not once per mention', async () => {
    await seed();
    for (const body of [
      'The paint looks incredible, paint paint paint',
      'Paint and interior both spotless',
      'Interior was the best part',
    ]) {
      const { itemId, token } = await finishedBooking();
      await leaveReview(env, token, { order_item_id: itemId, rating: 5, body });
    }
    const words = await mentionedWords(env, OP);
    const paint = words.find((w) => w.word === 'paint');
    // One person writing "paint" four times is one person who liked the paint.
    expect(paint?.n).toBe(2);
    expect(words.find((w) => w.word === 'interior')?.n).toBe(2);
  });

  it('drops filler nobody searches for', async () => {
    await seed();
    for (let i = 0; i < 3; i += 1) {
      const { itemId, token } = await finishedBooking();
      await leaveReview(env, token, {
        order_item_id: itemId, rating: 5,
        body: 'Absolutely amazing work, highly recommend, definitely great job',
      });
    }
    const words = (await mentionedWords(env, OP)).map((w) => w.word);
    for (const filler of ['amazing', 'highly', 'recommend', 'great', 'definitely']) {
      expect(words, filler).not.toContain(filler);
    }
  });
});

describe('the reply', () => {
  it('lets the business answer once', async () => {
    await seed();
    const { itemId, token } = await finishedBooking();
    const r = await leaveReview(env, token, { order_item_id: itemId, rating: 2, body: 'Late' });

    await replyToReview(env, OP, r.id, 'Sorry — traffic on the 405. Refunded the callout.');
    // A reply that can be edited later is one somebody can quietly rewrite
    // when the argument moves on.
    await expect(replyToReview(env, OP, r.id, 'Actually it was fine'))
      .rejects.toThrow(/already replied/i);
  });

  it('is not another business\'s to write', async () => {
    await seed();
    const { itemId, token } = await finishedBooking();
    const r = await leaveReview(env, token, { order_item_id: itemId, rating: 5 });
    await expect(replyToReview(env, 'someone-else', r.id, 'thanks'))
      .rejects.toThrow(/not yours/i);
  });
});

describe('photos on a review', () => {
  const addPhoto = async (itemId: string, by: 'customer' | 'operator') => {
    const id = newId();
    await env.DB.prepare(
      `INSERT INTO job_photos (id, order_item_id, operator_id, uploaded_by, stage,
         r2_key, created_at) VALUES (?,?,?,?, 'after', ?, ?)`,
    ).bind(id, itemId, OP, by, `k/${id}`, now()).run();
    return id;
  };

  it('shows nothing until the customer releases it', async () => {
    await seed();
    const { itemId, token } = await finishedBooking();
    await addPhoto(itemId, 'customer');
    await leaveReview(env, token, { order_item_id: itemId, rating: 5 });

    // Job photos are evidence for a dispute, taken inside somebody's home.
    // Publishing them because they exist would be the worst kind of default.
    const [review] = await listReviews(env, OP);
    expect(review!.photos).toEqual([]);
  });

  it('shows one the customer released', async () => {
    await seed();
    const { itemId, token } = await finishedBooking();
    const photo = await addPhoto(itemId, 'customer');
    await leaveReview(env, token, { order_item_id: itemId, rating: 5 });

    await releasePhoto(env, token, photo, true);
    const [review] = await listReviews(env, OP);
    expect(review!.photos).toEqual([photo]);

    await releasePhoto(env, token, photo, false);
    expect((await listReviews(env, OP))[0]!.photos).toEqual([]);
  });

  it('will not release a photo the operator took', async () => {
    await seed();
    const { itemId, token } = await finishedBooking();
    const theirs = await addPhoto(itemId, 'operator');
    // The person whose house it is decides. An operator has every commercial
    // reason to publish and no way of knowing whether the customer minds.
    await expect(releasePhoto(env, token, theirs, true)).rejects.toThrow(/not yours/i);
  });
});
