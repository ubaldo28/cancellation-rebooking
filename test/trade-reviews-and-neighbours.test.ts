import { describe, expect, it, beforeEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import worker from '../src/index';
import type { Env } from '../src/types';
import { getPublicProfile, similarBusinesses } from '../src/lib/profile';
import { reviewsForTrade } from '../src/lib/reviews';
import { profilePage, tradePage } from '../src/lib/seo';
import { newId, now } from '../src/lib/util';

/**
 * Two things a marketplace has and a directory does not: what people say about
 * a whole trade, and where else to go when this business is not the one.
 *
 * Both fail entirely on the code before this file. `reviews` rows existed and
 * could only be read one business at a time, so a visitor who had not already
 * chosen a business could not see that anybody on the site had ever been
 * reviewed; and a profile page ended in two links back to itself, which is a
 * dead end at exactly the moment a reader has decided against somebody.
 *
 * The rule underneath every assertion here is the same one the SEO file opens
 * with: nothing is invented. A trade nobody has reviewed shows nothing, a
 * business nobody has rated has no score, and a trade with one business in it
 * says so rather than padding the list.
 */

const BASE = 'https://gap.test';
let env: Env;

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

(globalThis as any).caches ??= {
  default: { match: async () => undefined, put: async () => {} },
};

const get = (path: string) => worker.fetch(new Request(`${BASE}${path}`), env, ctx);

const WINDOWS = 'window cleaning';
const JUNK = 'junk removal';

async function operator(id: string, opts: {
  name?: string; slug?: string | null; trade?: string | null;
  published?: number; accepting?: number;
  suspended_until?: number | null; banned_at?: number | null;
  rating_sum?: number; rating_count?: number; hired?: number; years?: number | null;
} = {}) {
  const n = now();
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,trade,timezone,country,currency,language,
       location_mode,fill_model,sms_mode,plan,accept_public_bookings,is_published,
       profile_slug,suspended_until,banned_at,rating_sum,rating_count,hired_count,
       years_in_business,share_location,created_at,updated_at)
     VALUES (?,?,?,?, 'America/Los_Angeles','US','USD','en','mobile','both','device',
       'active',?,?,?,?,?,?,?,?,?,1,?,?)`,
  ).bind(id, `${id}@x.com`, opts.name ?? id,
    opts.trade === undefined ? WINDOWS : opts.trade,
    opts.accepting ?? 1, opts.published ?? 1,
    opts.slug === undefined ? id : opts.slug,
    opts.suspended_until ?? null, opts.banned_at ?? null,
    opts.rating_sum ?? 0, opts.rating_count ?? 0, opts.hired ?? 0,
    opts.years === undefined ? null : opts.years, n, n).run();
  return id;
}

/**
 * A review written straight into the table.
 *
 * Written directly rather than through leaveReview because these tests are
 * about reading across a trade; leaveReview's own rules — one per finished
 * booking, never for a cancelled one — are tested where they belong.
 */
async function review(operatorId: string, opts: {
  author?: string; rating?: number; body?: string | null;
  details?: string | null; at?: number; hidden?: boolean;
} = {}) {
  const t = opts.at ?? now();
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO reviews (id, operator_id, order_item_id, author_name, rating, body,
       details, reply, replied_at, hidden_at, hidden_reason, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,NULL,NULL,?,NULL,?,?)`,
  ).bind(id, operatorId, newId(), opts.author ?? 'Debra Dawson', opts.rating ?? 5,
    opts.body === undefined ? 'They were on time and left no mess.' : opts.body,
    opts.details ?? null, opts.hidden ? t : null, t, t).run();
  return id;
}

async function area(operatorId: string, name: string, placeSlug: string) {
  const n = now();
  await env.DB.prepare(
    `INSERT INTO service_areas (id, operator_id, name, slug, place_slug, lat, lng,
       radius_meters, is_active, created_at, updated_at)
     VALUES (?,?,?,?,?,34.15,-118.44,8000,1,?,?)`,
  ).bind(newId(), operatorId, name, `${placeSlug}-${operatorId}`, placeSlug, n, n).run();
}

beforeEach(() => { env = makeEnv(ALL_MIGRATIONS) as unknown as Env; });

describe('recent reviews across a whole trade', () => {
  it('reaches across every business doing that work, newest first', async () => {
    await operator('op-a', { name: 'Clear View', slug: 'clear-view' });
    await operator('op-b', { name: 'Sky High', slug: 'sky-high' });
    const t = now();
    await review('op-a', { body: 'Oldest', at: t - 3000 });
    await review('op-b', { body: 'Newest', at: t - 100 });
    await review('op-a', { body: 'Middle', at: t - 1000 });

    const rows = await reviewsForTrade(env, WINDOWS, 10);
    expect(rows.map((r) => r.body)).toEqual(['Newest', 'Middle', 'Oldest']);
    // Each carries the business it belongs to, which is the whole point: a
    // review on a trade page is a way into a profile.
    expect(rows[0]!.business_name).toBe('Sky High');
    expect(rows[0]!.profile_slug).toBe('sky-high');
  });

  it('cuts the customer to a first name and an initial, exactly as the profile does', async () => {
    await operator('op-a', { slug: 'clear-view' });
    await review('op-a', { author: 'Debra Dawson' });
    const [r] = await reviewsForTrade(env, WINDOWS);
    expect(r!.author_name).toBe('Debra D.');
  });

  it('returns an empty list for a trade nobody has reviewed rather than anything made up', async () => {
    await operator('op-a', { slug: 'clear-view', trade: JUNK });
    expect(await reviewsForTrade(env, JUNK)).toEqual([]);
    // And for a trade with no businesses in it at all.
    expect(await reviewsForTrade(env, WINDOWS)).toEqual([]);
  });

  it('leaves out hidden reviews', async () => {
    await operator('op-a', { slug: 'clear-view' });
    await review('op-a', { body: 'Visible' });
    await review('op-a', { body: 'Taken down', hidden: true });
    expect((await reviewsForTrade(env, WINDOWS)).map((r) => r.body)).toEqual(['Visible']);
  });

  it('leaves out a bare star rating, because a strip of words has nothing to show for one', async () => {
    await operator('op-a', { slug: 'clear-view' });
    await review('op-a', { body: null });
    await review('op-a', { body: '   ' });
    await review('op-a', { body: 'Actually said something' });
    const rows = await reviewsForTrade(env, WINDOWS);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe('Actually said something');
  });

  it('leaves out a business with no page to link the review to', async () => {
    // A review pointing at a profile that 404s is worse than one fewer review.
    await operator('op-a', { slug: 'clear-view', published: 0 });
    await review('op-a', { body: 'Unpublished' });
    await operator('op-b', { slug: null });
    await review('op-b', { body: 'No slug at all' });
    expect(await reviewsForTrade(env, WINDOWS)).toEqual([]);
  });

  it('does not mix trades', async () => {
    await operator('op-a', { slug: 'clear-view', trade: WINDOWS });
    await operator('op-b', { slug: 'haul-it', trade: JUNK });
    await review('op-a', { body: 'Windows' });
    await review('op-b', { body: 'Junk' });
    expect((await reviewsForTrade(env, WINDOWS)).map((r) => r.body)).toEqual(['Windows']);
  });

  it('matches the trade the way every other reader of that column does', async () => {
    // trade is free text on the row, so a stored '  Window Cleaning ' is the
    // same trade as 'window cleaning' and has to be found by the same lookup.
    await operator('op-a', { slug: 'clear-view', trade: '  Window Cleaning ' });
    await review('op-a', { body: 'Found anyway' });
    expect((await reviewsForTrade(env, WINDOWS)).map((r) => r.body)).toEqual(['Found anyway']);
  });

  it('serves the same rows over HTTP, and answers a trade we do not have with a 404', async () => {
    await operator('op-a', { name: 'Clear View', slug: 'clear-view' });
    await review('op-a', { body: 'Over the wire' });

    const res = await get(`/api/public/trades/${encodeURIComponent(WINDOWS)}/reviews`);
    expect(res.status).toBe(200);
    const b = await res.json() as any;
    expect(b.trade.slug).toBe(WINDOWS);
    expect(b.trade.label).toBe('Window cleaning');
    expect(b.reviews[0].body).toBe('Over the wire');
    expect(b.reviews[0].business_name).toBe('Clear View');
    // An internal key has no business on a public page, the same rule the
    // profile route applies to its photos.
    expect(b.reviews[0].operator_id).toBeUndefined();

    // An unknown trade is a refusal, not an empty list — which would read as a
    // real trade nobody has ever reviewed.
    expect((await get('/api/public/trades/not-a-trade-at-all/reviews')).status).toBe(404);
  });

  it('honours a limit and caps it', async () => {
    await operator('op-a', { slug: 'clear-view' });
    for (let i = 0; i < 8; i++) await review('op-a', { body: `Review ${i}`, at: now() - i });
    expect(await reviewsForTrade(env, WINDOWS, 3)).toHaveLength(3);
    // The default is a strip, not a page.
    expect(await reviewsForTrade(env, WINDOWS)).toHaveLength(6);
  });
});

describe('other businesses doing the same work nearby', () => {
  it('never includes the business whose page it is', async () => {
    await operator('op-a', { name: 'Clear View', slug: 'clear-view' });
    await operator('op-b', { name: 'Sky High', slug: 'sky-high' });
    const rows = await similarBusinesses(env, 'clear-view');
    expect(rows.map((r) => r.profile_slug)).toEqual(['sky-high']);
  });

  it('puts the businesses that share a neighbourhood first', async () => {
    await operator('op-a', { name: 'Mine', slug: 'mine' });
    await area('op-a', 'Sherman Oaks', 'sherman-oaks');
    await area('op-a', 'Encino', 'encino');

    await operator('op-b', { name: 'Overlaps twice', slug: 'two' });
    await area('op-b', 'Sherman Oaks', 'sherman-oaks');
    await area('op-b', 'Encino', 'encino');

    await operator('op-c', { name: 'Overlaps once', slug: 'one' });
    await area('op-c', 'Encino', 'encino');

    await operator('op-d', { name: 'Elsewhere entirely', slug: 'none' });
    await area('op-d', 'Burbank', 'burbank');

    const rows = await similarBusinesses(env, 'mine', 10);
    expect(rows.map((r) => r.profile_slug)).toEqual(['two', 'one', 'none']);
    expect(rows.map((r) => r.shared_areas)).toEqual([2, 1, 0]);
    // The neighbourhoods are named so the page can show where they work rather
    // than asserting that they are "local".
    expect(rows[0]!.areas).toEqual(['Encino', 'Sherman Oaks']);
  });

  it('makes up no rating for a business nobody has reviewed', async () => {
    await operator('op-a', { slug: 'mine' });
    await operator('op-b', { slug: 'new-one' });
    await operator('op-c', { slug: 'rated-one', rating_sum: 24, rating_count: 5, hired: 12 });

    const rows = await similarBusinesses(env, 'mine', 10);
    const fresh = rows.find((r) => r.profile_slug === 'new-one')!;
    const rated = rows.find((r) => r.profile_slug === 'rated-one')!;

    // Null, not zero and not five: a new business has no rating, it does not
    // have a bad one, and the two have to be distinguishable.
    expect(fresh.rating).toBeNull();
    expect(fresh.review_count).toBe(0);
    expect(fresh.hired_count).toBe(0);
    expect(rated.rating).toBe(4.8);
    expect(rated.review_count).toBe(5);
    expect(rated.hired_count).toBe(12);
  });

  it('only offers businesses a stranger could actually reach', async () => {
    await operator('op-a', { slug: 'mine' });
    await operator('op-sus', { slug: 'suspended', suspended_until: now() + 86400 });
    await operator('op-ban', { slug: 'banned', banned_at: now() - 60 });
    await operator('op-un', { slug: 'unpublished', published: 0 });
    await operator('op-closed', { slug: 'not-public', accepting: 0 });
    await operator('op-other', { slug: 'other-trade', trade: JUNK });
    await operator('op-ok', { slug: 'fine' });

    expect((await similarBusinesses(env, 'mine', 20)).map((r) => r.profile_slug))
      .toEqual(['fine']);
  });

  it('returns nothing rather than padding when a business has no trade set', async () => {
    await operator('op-a', { slug: 'mine', trade: null });
    await operator('op-b', { slug: 'other', trade: null });
    // Two businesses with no trade are not "in the same trade" as each other.
    expect(await similarBusinesses(env, 'mine', 10)).toEqual([]);
  });

  it('rides along on the profile payload, and over its own endpoint', async () => {
    await operator('op-a', { name: 'Mine', slug: 'mine' });
    await operator('op-b', { name: 'Sky High', slug: 'sky-high' });

    const profile = await getPublicProfile(env, 'mine');
    expect(profile!.similar.map((s) => s.business_name)).toEqual(['Sky High']);

    const res = await get('/api/public/profile/mine/similar');
    expect(res.status).toBe(200);
    const b = await res.json() as any;
    expect(b.businesses[0].business_name).toBe('Sky High');
    // An internal key, deliberately absent, exactly as on the photos.
    expect(b.businesses[0].id).toBeUndefined();
    expect(b.businesses[0].operator_id).toBeUndefined();

    // The route the page actually calls carries it too, so the foot of the
    // page costs no second round trip.
    const viaRoute = await (await get('/api/public/profile/mine')).json() as any;
    expect(viaRoute.similar[0].profile_slug).toBe('sky-high');
  });
});

describe('what a crawler sees', () => {
  it('shows the trade page the same review strip a person gets', async () => {
    await operator('op-a', { name: 'Clear View Window Cleaning', slug: 'clear-view' });
    await review('op-a', {
      author: 'Debra Dawson', rating: 5,
      body: 'Second-floor windows and no ladder marks on the flowerbed.',
      details: 'Whole house',
    });

    const html = await tradePage(env, WINDOWS);
    expect(html).toContain('Recent reviews in window cleaning');
    expect(html).toContain('Second-floor windows and no ladder marks');
    expect(html).toContain('Debra D.');
    // Each one links to the business it belongs to.
    expect(html).toContain('href="/p/clear-view"');
    expect(html).toContain('Clear View Window Cleaning');
    // Stars for a reader, and no review markup: a trade page is not about one
    // business, and emitting Review or AggregateRating nodes here would be
    // submitting somebody else's rating as the page's own.
    expect(html).not.toContain('AggregateRating');
    expect(html).not.toMatch(/"@type"\s*:\s*"Review"/);
  });

  it('says nothing at all on a trade page with no reviews', async () => {
    await operator('op-a', { slug: 'clear-view' });
    const html = await tradePage(env, WINDOWS);
    expect(html).not.toContain('Recent reviews in');
    // And nothing invited, invented, or held open for later.
    expect(html).not.toMatch(/be the first to review/i);
  });

  it('escapes a business name that contains markup', async () => {
    await operator('op-a', { name: '<script>alert(1)</script> Glass', slug: 'xss-glass' });
    await review('op-a', { author: '<b>Mallory</b> Smith', body: 'Fine <img src=x onerror=1>' });

    const html = await tradePage(env, WINDOWS);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
  });

  it('ends a profile page with real alternatives and a way to see the rest', async () => {
    await operator('op-a', { name: 'Mine', slug: 'mine' });
    await area('op-a', 'Encino', 'encino');
    await operator('op-b', {
      name: 'Sky High Window Cleaning', slug: 'sky-high',
      rating_sum: 24, rating_count: 5, hired: 31, years: 7,
    });
    await area('op-b', 'Encino', 'encino');

    const html = await profilePage(env, 'mine');
    expect(html).toContain('Other window cleaning businesses');
    expect(html).toContain('href="/p/sky-high"');
    expect(html).toContain('Sky High Window Cleaning');
    // Every line is counted off that business's own row.
    expect(html).toContain('4.8 from 5 reviews');
    expect(html).toContain('hired 31 times');
    expect(html).toContain('1 neighbourhood in common');
    expect(html).toContain('Serves Encino');
    // And a "see all", which is what the section used to be instead of this.
    expect(html).toContain('See all window cleaning');
    // The page never lists itself.
    expect(html).not.toContain('href="/p/mine"');
  });

  it('says a business is alone in its trade rather than showing nobody without explanation', async () => {
    await operator('op-a', { name: 'Only One', slug: 'mine' });
    const html = await profilePage(env, 'mine');
    expect(html).toContain('No other window cleaning business has a');
  });

  it('offers the two profile actions in words a crawler can read', async () => {
    await operator('op-a', { name: 'Clear View', slug: 'mine' });
    const html = await profilePage(env, 'mine');
    expect(html).toContain('You can message Clear View or ask them for a quote');
  });
});
