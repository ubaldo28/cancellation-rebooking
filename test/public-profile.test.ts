import { describe, expect, it, beforeEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import worker from '../src/index';
import type { Env } from '../src/types';
import { placeOrder } from '../src/lib/orders';
import { addPhoto, ensureProfileSlug, saveFaq } from '../src/lib/profile';
import { leaveReview, releasePhoto } from '../src/lib/reviews';
import { saveOperatorCard } from '../src/lib/standing';
import { newId, now } from '../src/lib/util';

/**
 * The contract between GET /api/public/profile/:slug and PublicProfile.tsx.
 *
 * This file exists because that contract was broken in production and nothing
 * noticed. getPublicProfile had always fetched the rating, the reviews, the
 * mentioned words, the FAQs and the service areas; the route handler named
 * only `operator` and `photos` in the object it serialised, so everything else
 * was thrown away one line before it reached the wire. The page destructures
 * all seven keys and reads `rating.count` immediately, which threw, which meant
 * every public profile on the site rendered as a blank page -- for a new
 * business and an established one alike.
 *
 * There were tests over getPublicProfile and tests over the page, and the gap
 * between them was exactly where the bug lived. So these assertions are
 * deliberately written against the ROUTE and phrased as "what the page reads
 * off this", down to the individual field names, because a shape test that
 * paraphrases the consumer is a test that can pass while the page is blank.
 */

const BASE = 'https://gap.test';
let env: Env;

const OP = 'op-profile';
const PREV = { lat: 34.1500, lng: -118.4490 };
const NEXT = { lat: 34.1520, lng: -118.4400 };
const NEAR = { lat: 34.1510, lng: -118.4450 };

const BUYER = {
  guest_name: 'Debra Dawson', phone: '(818) 555-0142',
  address_line: '15200 Ventura Blvd', postcode: '91403',
};

/**
 * `caches` is a Workers global and Node has none, and this route is on the
 * edge-cache list, so the entry point reaches for it before any handler runs.
 *
 * The stand-in deliberately never stores anything. A cache that actually held
 * a response would make the assertions below lie: several of them ask for the
 * same profile twice with a write in between, and a hit would return the
 * answer from before the write and pass for the wrong reason.
 */
(globalThis as any).caches ??= {
  default: { match: async () => undefined, put: async () => {} },
};

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

const get = (path: string) =>
  worker.fetch(new Request(`${BASE}${path}`), env, ctx);

async function makeOperator(id: string, businessName: string) {
  const n = now();
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,trade,timezone,country,currency,language,
       location_mode,fill_model,sms_mode,plan,accept_public_bookings,is_published,
       share_location,tagline,bio,years_experience,work_location,employees,
       years_in_business,payment_methods,hired_count,created_at,updated_at)
     VALUES (?,?,?, 'mobile car wash and detailing','America/Los_Angeles','US','USD','en',
       'mobile','both','device','active',1,1,1,?,?,?, 'both',3,12,'Zelle, cash',41,?,?)`,
  ).bind(id, `${id}@x.com`, businessName,
    'Paint correction and ceramic coating',
    'Fifteen years of it, mostly in the Valley.', 15, n, n).run();
  await saveOperatorCard(env, id, { ref: 'pm', brand: 'visa', last4: '4242' });
  return ensureProfileSlug(env, id, businessName);
}

/** The rest of the world a bookable operator needs before an order can exist. */
async function bookable() {
  const n = now();
  await env.DB.prepare(
    `INSERT INTO services (id,operator_id,name,duration_seconds,price_cents,created_at,updated_at)
     VALUES ('s1',?, 'Full detail',3600,20000,?,?)`,
  ).bind(OP, n, n).run();
  await env.DB.prepare(
    `INSERT INTO postal_codes (country_code,postal_code,place_name,lat,lng,accuracy)
     VALUES ('US','91403','Sherman Oaks',?,?,6)`,
  ).bind(NEAR.lat, NEAR.lng).run();
}

/** Books a slot and drags it into the past, so the job is finished and reviewable. */
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

async function addArea(name: string, slug: string, active = true) {
  const n = now();
  await env.DB.prepare(
    `INSERT INTO service_areas (id,operator_id,name,slug,lat,lng,is_active,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(newId(), OP, name, slug, NEAR.lat, NEAR.lng, active ? 1 : 0, n, n).run();
}

beforeEach(() => { env = makeEnv(ALL_MIGRATIONS) as unknown as Env; });

/**
 * Every key PublicProfile.tsx pulls out of the response, in the order the
 * component's own destructure names them. This list is the contract: if the
 * page starts reading an eighth thing, it goes here and the endpoint has to
 * grow to match.
 */
const PAGE_READS = ['operator', 'photos', 'rating', 'reviews', 'mentions', 'faqs', 'areas'];

describe('the public profile endpoint answers what the page destructures', () => {
  it('carries every key, populated, for a business with reviews', async () => {
    const slug = await makeOperator(OP, 'Valley Vista Pool Service');
    await bookable();
    await addArea('Sherman Oaks', 'sherman-oaks');
    await addArea('Encino', 'encino');
    // Inactive areas are somewhere this operator used to work. The page
    // prints these as "Serves ..." and must not name one of those.
    await addArea('Pasadena', 'pasadena', false);
    await saveFaq(env, OP, { question: 'Do you bring your own water?', answer: 'Always.' });
    await addPhoto(env, OP, {
      r2_key: 'w/op-profile/one', content_type: 'image/jpeg', bytes: 400_000,
      caption: 'A finished job',
    });

    const a = await finishedBooking(30);
    await leaveReview(env, a.token, {
      order_item_id: a.itemId, rating: 5,
      body: 'The pool was green when they arrived and swimmable by the evening.',
    });
    const b = await finishedBooking(40);
    await leaveReview(env, b.token, {
      order_item_id: b.itemId, rating: 4,
      body: 'Swimmable again, and they explained the chemistry as they went.',
    });

    const res = await get(`/api/public/profile/${slug}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    for (const key of PAGE_READS) expect(body).toHaveProperty(key);

    // `const { operator: o, photos, rating, reviews, mentions, faqs, areas }`,
    // then `rating.count` on the very next line -- the exact read that threw.
    expect(typeof body.rating.count).toBe('number');
    expect(body.rating.count).toBe(2);
    expect(body.rating.average).toBeCloseTo(4.5, 5);
    expect(body.rating.label).toBe('Very good');
    // `rating.distribution[star] ?? 0` for each of 5..1, and the bar widths are
    // computed off it, so a distribution keyed any other way silently draws
    // five empty bars.
    for (const star of [5, 4, 3, 2, 1]) {
      expect(typeof body.rating.distribution[star]).toBe('number');
    }
    expect(body.rating.distribution['5']).toBe(1);
    expect(body.rating.distribution['4']).toBe(1);

    expect(Array.isArray(body.reviews)).toBe(true);
    expect(body.reviews).toHaveLength(2);
    for (const r of body.reviews) {
      // Every field the review card renders or keys off.
      expect(typeof r.id).toBe('string');
      expect(typeof r.author_name).toBe('string');
      expect(typeof r.rating).toBe('number');
      expect(typeof r.created_at).toBe('number');
      expect(r).toHaveProperty('body');
      expect(r).toHaveProperty('details');
      expect(r).toHaveProperty('reply');
      expect(Array.isArray(r.photos)).toBe(true);
      // "Debra D." -- the surname is cut at display time, and this endpoint is
      // the display. A full surname beside a review of a home visit is more
      // than anybody signing one expects to publish.
      expect(r.author_name).toBe('Debra D.');
    }

    // The chips read `m.word` and `m.n`.
    expect(Array.isArray(body.mentions)).toBe(true);
    for (const m of body.mentions) {
      expect(typeof m.word).toBe('string');
      expect(typeof m.n).toBe('number');
    }
    expect(body.mentions.map((m: any) => m.word)).toContain('swimmable');

    // FAQs render as `f.id` keyed `f.question` / `f.answer`.
    expect(body.faqs).toHaveLength(1);
    expect(body.faqs[0].question).toBe('Do you bring your own water?');
    expect(body.faqs[0].answer).toBe('Always.');
    expect(typeof body.faqs[0].id).toBe('string');

    // `areas.join(', ')` -- strings, not rows.
    expect(body.areas).toEqual(['Encino', 'Sherman Oaks']);

    // The gallery reads `p.r2_key`, `p.caption` and keys off `p.id`.
    expect(body.photos).toHaveLength(1);
    expect(body.photos[0].r2_key).toBe('w/op-profile/one');
    expect(body.photos[0].caption).toBe('A finished job');
    expect(typeof body.photos[0].id).toBe('string');

    // The overview block and the header.
    expect(body.operator.business_name).toBe('Valley Vista Pool Service');
    expect(body.operator.work_location).toBe('both');
    expect(body.operator.employees).toBe(3);
    expect(body.operator.hired_count).toBe(41);
    expect(body.operator.years_in_business).toBe(12);
    expect(body.operator.payment_methods).toBe('Zelle, cash');
    expect(body.operator).toHaveProperty('background_checked_at');
    expect(body.operator).toHaveProperty('background_check_name');
    expect(body.operator).toHaveProperty('avatar_key');
    expect(body.operator).toHaveProperty('tagline');
    expect(body.operator).toHaveProperty('trade');
  });

  it('carries every key for a business with nothing on it yet', async () => {
    // The page says "New -- no reviews yet" in words rather than drawing five
    // grey stars, and it can only do that if the endpoint answers with a real
    // empty rating instead of omitting the key or inventing a number.
    const slug = await makeOperator(OP, 'Valley Vista Pool Service');

    const res = await get(`/api/public/profile/${slug}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    for (const key of PAGE_READS) expect(body).toHaveProperty(key);

    expect(body.rating.count).toBe(0);
    expect(body.rating.average).toBeNull();
    expect(body.rating.label).toBeNull();
    expect(body.rating.distribution).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });

    // Nothing is invented to fill the page out. No sample FAQ, no placeholder
    // area, no default rating: a young business is allowed to look young.
    expect(body.reviews).toEqual([]);
    expect(body.mentions).toEqual([]);
    expect(body.faqs).toEqual([]);
    expect(body.areas).toEqual([]);
    expect(body.photos).toEqual([]);
  });

  it('still keeps the operator row id off the public page', async () => {
    const slug = await makeOperator(OP, 'Valley Vista Pool Service');
    await addPhoto(env, OP, {
      r2_key: 'w/op-profile/one', content_type: 'image/jpeg', bytes: 1000,
    });

    const body = await (await get(`/api/public/profile/${slug}`)).json() as any;
    expect(body.operator.id).toBeUndefined();
    expect(body.operator.email).toBeUndefined();
    expect(body.photos[0].operator_id).toBeUndefined();
    expect(body.operator.is_sample).toBe(false);
  });

  it('publishes a review photo only once the customer released it', async () => {
    // The whole of migration 0028 in one assertion. A job photo is evidence
    // taken inside somebody's house; it reaches this endpoint when its owner
    // put it on their own review and at no other time.
    const slug = await makeOperator(OP, 'Valley Vista Pool Service');
    await bookable();
    const { itemId, token } = await finishedBooking();
    await leaveReview(env, token, {
      order_item_id: itemId, rating: 5, body: 'Green to swimmable in an afternoon.',
    });

    const n = now();
    for (const [id, side] of [['ph-cust', 'customer'], ['ph-op', 'operator']] as const) {
      await env.DB.prepare(
        `INSERT INTO job_photos (id,order_item_id,operator_id,uploaded_by,stage,r2_key,
           content_type,created_at) VALUES (?,?,?,?, 'after',?, 'image/jpeg',?)`,
      ).bind(id, itemId, OP, side, `j/${id}`, n).run();
    }

    const before = await (await get(`/api/public/profile/${slug}`)).json() as any;
    expect(before.reviews[0].photos).toEqual([]);

    await releasePhoto(env, token, 'ph-cust', true);

    const after = await (await get(`/api/public/profile/${slug}`)).json() as any;
    expect(after.reviews[0].photos).toEqual(['ph-cust']);

    // And the operator's own photo of the same job stays where it is. There is
    // no path here that would move it, and this asserts that stays true.
    await expect(releasePhoto(env, token, 'ph-op', true)).rejects.toThrow(/not yours/i);
    const again = await (await get(`/api/public/profile/${slug}`)).json() as any;
    expect(again.reviews[0].photos).toEqual(['ph-cust']);
  });

  it('is still a 404 for a slug nobody owns', async () => {
    expect((await get('/api/public/profile/nobody-at-all')).status).toBe(404);
  });
});
