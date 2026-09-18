import { describe, expect, it, beforeEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import worker from '../src/index';
import type { Env } from '../src/types';
import {
  areaIndexPage, browseIndexPage, canonicalTradeSegment, categoryPage, costGuidePage,
  costIndexPage, homePage, metroPage, neighbourhoodPage, profilePage, robotsTxt, sitemapXml,
  tradeFromPathSegment, tradePage,
} from '../src/lib/seo';
import { ALL_TRADES, TRADE_CATEGORIES } from '../src/lib/trades';
import { DEMO_OPERATOR_ID } from '../src/lib/demo';
import { METROS, METROS_INCLUDING_HIDDEN, metroBySlug } from '../src/lib/metros';
import { newId, now } from '../src/lib/util';

/**
 * The pages that used to be React routes and nothing else, plus the two index
 * pages that make the geography reachable.
 *
 * Everything here is checked against rows this file inserted, because that is
 * the property the pages are built around: every number on them is counted
 * from what was fetched, so a test that asserts a hardcoded figure would be
 * asserting the one thing that must never be true of them.
 */

const MIGRATIONS = ALL_MIGRATIONS;

// The live metro, looked up rather than built here. `metroBySlug` reads the
// live list, so this is also the assertion that Los Angeles is open: it
// answers null for a metro that is not, which is why the Santa Maria record
// that used to sit on the next line is gone. What that record still
// guarantees, and what its being hidden guarantees, is in test/metros.test.ts.
const LOS_ANGELES = metroBySlug('los-angeles')!;

let env: Env;
const t = () => now();

const OAKS = { lat: 34.1500, lng: -118.4490 };
const ENCINO = { lat: 34.1590, lng: -118.5010 };
const SHERMAN_OAKS = { name: 'Sherman Oaks', slug: 'sherman-oaks', ...OAKS };
const ENCINO_PLACE = { name: 'Encino', slug: 'encino', ...ENCINO };

/** The stored trade slug — the value on the operator row, spaces and all. */
const DETAILING = 'mobile car wash and detailing';

/**
 * The segment that trade's pages are ADDRESSED by, which is a different thing.
 *
 * This used to be `encodeURIComponent(DETAILING)`, and that spelling was the
 * defect rather than the fixture: the canonical, the sitemap entry and every
 * internal link to /s/ and /cost/ read
 * /s/mobile%20car%20wash%20and%20detailing, while /near/<place>/<trade> next
 * door had always used the hyphenated form — two conventions on one site,
 * with the Worker 301ing the readable one away. The hyphenated spelling is
 * the canonical everywhere now and the escaped one is what redirects, so
 * every expectation below moved with it.
 */
const DETAILING_SEG = 'mobile-car-wash-and-detailing';

/** The same transformation the Worker applies, for building expected hrefs. */
const seg = (storedSlug: string) => storedSlug.replace(/[^a-z0-9]+/g, '-');

async function addOperator(opts: {
  id: string; name: string; trade: string | null;
  place: { name: string; slug: string; lat: number; lng: number };
  priceCents?: number;
  serviceName?: string;
  open?: boolean;
  profileSlug?: string;
  tagline?: string;
}) {
  const n = t();
  await env.DB.prepare(
    // stripe_payouts_enabled = 1 is load-bearing, not boilerplate: a business
    // must have somewhere to be paid before its work can be sold, so slotsNear
    // leaves an opening for an operator without it off the public list. Drop it
    // and every page built here renders as "nothing open".
    `INSERT INTO operators (id,email,business_name,trade,timezone,country,currency,language,
       location_mode,fill_model,sms_mode,max_detour_seconds,min_gap_seconds,buffer_seconds,
       offer_ttl_seconds,offers_per_wave,min_notice_seconds,reoffer_cooldown_seconds,
       discount_percent,plan,accept_public_bookings,deposit_cents,
       profile_slug,is_published,tagline,hired_count,employees,years_in_business,
       created_at,updated_at,stripe_payouts_enabled)
     VALUES (?,?,?,?, 'America/Los_Angeles','US','USD','en','mobile','both','device',
       900,3600,900,5400,3,3600,604800,0,'active',1,1000,?,?,?,7,2,4,?,?,1)`,
  ).bind(
    opts.id, `${opts.id}@x.com`, opts.name, opts.trade,
    opts.profileSlug ?? null, opts.profileSlug ? 1 : 0, opts.tagline ?? null, n, n,
  ).run();

  await env.DB.prepare(
    `INSERT INTO services (id,operator_id,name,duration_seconds,price_cents,cadence_days,
       created_at,updated_at)
     VALUES (?,?,?,7200,?,28,?,?)`,
  ).bind(`sv-${opts.id}`, opts.id, opts.serviceName ?? 'Full detail',
    opts.priceCents ?? 9900, n, n).run();

  await env.DB.prepare(
    `INSERT INTO service_areas (id,operator_id,name,slug,place_slug,lat,lng,radius_meters,
       created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,8000,?,?)`,
  ).bind(newId(), opts.id, opts.place.name, `${opts.place.slug}-${opts.id}`,
    opts.place.slug, opts.place.lat, opts.place.lng, n, n).run();

  if (opts.open !== false) {
    const start = n + 4 * 3600;
    await env.DB.prepare(
      `INSERT INTO gaps (id,operator_id,starts_at,ends_at,prev_lat,prev_lng,next_lat,next_lng,
         baseline_drive_seconds,is_mobile,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,180,1,'open',?,?)`,
    ).bind(newId(), opts.id, start, start + 5 * 3600,
      opts.place.lat, opts.place.lng, opts.place.lat, opts.place.lng, n, n).run();
  }
}

async function addReview(operatorId: string, rating: number, body: string) {
  const n = t();
  await env.DB.prepare(
    `INSERT INTO reviews (id,operator_id,order_item_id,author_name,rating,body,
       created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`,
  ).bind(newId(), operatorId, newId(), 'Debra Ochoa', rating, body, n, n).run();
}

beforeEach(async () => {
  env = makeEnv(MIGRATIONS) as unknown as Env;
  await addOperator({
    id: 'op1', name: 'Valley Detailing', trade: DETAILING, place: SHERMAN_OAKS,
    profileSlug: 'valley-detailing', tagline: 'Water and power on board',
  });
  await addOperator({
    id: 'op2', name: 'Encino Auto Care', trade: DETAILING, place: ENCINO_PLACE,
    priceCents: 12900, serviceName: 'Wash and wax',
  });
  // Covers Sherman Oaks and has nothing open: the empty trade the pages have
  // to be honest about and the sitemap has to leave out.
  await addOperator({
    id: 'op3', name: 'Oaks Hauling', trade: 'junk removal',
    place: SHERMAN_OAKS, open: false,
  });
});

// ---------------------------------------------------------------------------

describe('trade path segments', () => {
  it('accepts the stored slug the React app links with', () => {
    expect(tradeFromPathSegment(DETAILING)?.slug).toBe(DETAILING);
  });

  it('accepts the hyphenated form the /near pages use', () => {
    expect(tradeFromPathSegment('mobile-car-wash-and-detailing')?.slug).toBe(DETAILING);
    expect(tradeFromPathSegment('junk-removal')?.slug).toBe('junk removal');
  });

  it('refuses anything that is not a trade in the catalogue', () => {
    expect(tradeFromPathSegment('dragon-grooming')).toBeNull();
    expect(tradeFromPathSegment('')).toBeNull();
  });

  /**
   * THIS TEST PINNED THE BUG, and it is worth saying which way round.
   *
   * It asserted `'junk%20removal'` — an escaped space as the canonical URL
   * segment for the highest-intent pages on the site — under the heading "the
   * segment the app itself links with". The app linking with it was true and
   * was not a reason: seventy-six canonicals, seventy-six sitemap entries and
   * every internal link read /s/mobile%20car%20wash%20and%20detailing, and
   * src/index.ts 301'd the readable /s/junk-removal away to reach them.
   *
   * The canonical is the hyphenated form now — the same `tradeSlug` spelling
   * /near/<place>/<trade> has always used — and the redirect points the other
   * way. web/ still links with the escaped form and now takes a 301 for it;
   * those links want updating.
   */
  it('canonicalises to the readable, hyphenated segment', () => {
    expect(canonicalTradeSegment(tradeFromPathSegment('junk-removal')!)).toBe('junk-removal');
    expect(canonicalTradeSegment(tradeFromPathSegment('junk removal')!)).toBe('junk-removal');
    expect(canonicalTradeSegment(tradeFromPathSegment(DETAILING)!)).toBe(DETAILING_SEG);
    // Nothing that has to be escaped survives it, which is the whole point.
    for (const t of ALL_TRADES) {
      expect(canonicalTradeSegment(t), t.slug).toBe(encodeURIComponent(canonicalTradeSegment(t)));
    }
  });
});

describe('the trade page', () => {
  it('has a title, a heading and the count it is about to show', async () => {
    const page = await tradePage(env, DETAILING);
    expect(page).not.toBeNull();
    expect(page!).toContain('<title>Car wash and detailing — what is open now | Round The Way</title>');
    expect(page!).toContain('<h1>Car wash and detailing near you');
    expect(page!).toContain('2 open appointments');
    expect(page!).toContain('Valley Detailing');
    expect(page!).toContain('$99.00');
    expect(page!).toMatch(/href="\/book\//);
  });

  it('counts businesses, openings and neighbourhoods from the rows it renders',
    async () => {
      const page = await tradePage(env, DETAILING);
      expect(page!).toContain('<b>2</b><span>businesses listed</span>');
      expect(page!).toContain('<b>2</b><span>appointments open</span>');
      expect(page!).toContain('<b>2</b><span>neighbourhoods</span>');
      expect(page!).toContain('<b>$99.00</b><span>lowest price listed</span>');
    });

  it('names the places the trade is open in, and the cost guide', async () => {
    const page = await tradePage(env, DETAILING);
    expect(page!).toContain('href="/near/sherman-oaks/mobile-car-wash-and-detailing"');
    expect(page!).toContain('href="/near/encino/mobile-car-wash-and-detailing"');
    expect(page!).toContain(`href="/cost/${DETAILING_SEG}"`);
    expect(page!).toContain('href="/browse/auto"');
  });

  it('says a trade is empty rather than borrowing a number from another one',
    async () => {
      const page = await tradePage(env, 'junk removal');
      expect(page!).toContain('Nothing open in junk removal right now');
      expect(page!).not.toContain('appointments open</span>');
      // Nothing invented to fill the gap, and no price at all.
      expect(page!).not.toContain('lowest price listed');
    });

  it('returns null for a trade nobody names, so the SPA answers instead', async () => {
    expect(await tradePage(env, 'dragon-grooming')).toBeNull();
  });

  /**
   * ALL THIRTY-EIGHT OF THESE PAGES CARRY THE SAME SEVEN QUESTIONS, the same
   * three-step band and the same closing paragraph, and on a trade with
   * nothing open that boilerplate IS the page with a different heading on it.
   * This used to be a hardcoded `noindex: false`, defended on the ground that
   * a trade page says something true on a quiet day — which is right, and is
   * also true of the thirty-seven identical ones beside it. Submitting the set
   * is the textbook shape of a doorway group.
   */
  it('refuses to be indexed while nothing real is open in the trade', async () => {
    const quiet = (await tradePage(env, 'junk removal'))!;
    expect(quiet).toContain('<meta name="robots" content="noindex');

    // And the moment there is a genuine opening it asks to be indexed again,
    // counted per request like every other figure on it.
    const busy = (await tradePage(env, DETAILING))!;
    expect(busy).toContain('<meta name="robots" content="index,follow');
  });

  it('counts a sample listing as nothing, here as everywhere else', async () => {
    await addOperator({
      id: DEMO_OPERATOR_ID, name: 'Demo Bins', trade: 'trash can cleaning',
      place: SHERMAN_OAKS,
    });
    const page = (await tradePage(env, 'trash can cleaning'))!;
    // Shown to a person, labelled, and never submitted as inventory.
    expect(page).toContain('Demo Bins');
    expect(page).toContain('Sample listing');
    expect(page).toContain('<meta name="robots" content="noindex');
    expect(await sitemapXml(env, 'https://gap.test')).not.toContain('/s/trash-can-cleaning');
  });

  it('emits the FAQPage and the BreadcrumbList the React page emits', async () => {
    const page = await tradePage(env, DETAILING);
    const graph = graphOf(page!)['@graph'];
    const types = graph.map((n: any) => n['@type']);
    expect(types).toContain('BreadcrumbList');
    expect(types).toContain('FAQPage');
    const faq = graph.find((n: any) => n['@type'] === 'FAQPage');
    // Seven since the model was corrected. "Do I need an account?" leads,
    // because it is the first thing a stranger has to know before they start
    // filling anything in, and this page spent its whole existence answering
    // it wrongly by implication.
    expect(faq.mainEntity).toHaveLength(7);
    expect(faq.mainEntity[0].name).toBe('Do I need an account?');
    expect(faq.mainEntity[0].acceptedAnswer.text).toContain('Booking needs an account');
    // Every answer in the markup is on the page itself.
    for (const q of faq.mainEntity) expect(page!).toContain(escapeish(q.name));
  });

  it('never marks up a rating anywhere', async () => {
    const raw = JSON.stringify(graphOf((await tradePage(env, DETAILING))!));
    for (const banned of ['aggregateRating', 'ratingValue', 'reviewCount']) {
      expect(raw).not.toContain(banned);
    }
  });
});

describe('the cost guide', () => {
  it('reports the listed prices and says exactly what they are', async () => {
    const page = await costGuidePage(env, DETAILING);
    expect(page!).toContain('<title>What does car wash and detailing cost? | Round The Way</title>');
    expect(page!).toContain('<h1>What does car wash and detailing cost?</h1>');
    expect(page!).toContain('are asking');
    expect(page!).toContain('not a national average');
  });

  it('refuses to call two prices a range', async () => {
    const page = await costGuidePage(env, DETAILING);
    expect(page!).toContain('Too few listings to give a range');
    expect(page!).not.toContain('middle of the listings');
  });

  it('gives a low, a middle and a high once there are enough listings', async () => {
    await addOperator({ id: 'op4', name: 'Third Detailer', trade: DETAILING,
      place: ENCINO_PLACE, priceCents: 15900 });
    const page = await costGuidePage(env, DETAILING);
    expect(page!).toContain('<b>$99.00</b><span>lowest listed</span>');
    expect(page!).toContain('<b>$129.00</b><span>middle of the listings</span>');
    expect(page!).toContain('<b>$159.00</b><span>highest listed</span>');
  });

  it('lists each service by name with its duration', async () => {
    const page = await costGuidePage(env, DETAILING);
    expect(page!).toContain('Full detail');
    expect(page!).toContain('Wash and wax');
    expect(page!).toContain('2 hr');
  });

  it('says there is no price rather than estimating one', async () => {
    const page = await costGuidePage(env, 'junk removal');
    expect(page!).toContain('No prices listed for junk removal today');
    expect(page!).toContain('we are not going to estimate any');
  });

  it('carries the BreadcrumbList and nothing about ratings', async () => {
    const graph = graphOf((await costGuidePage(env, DETAILING))!)['@graph'];
    // The FAQPage joined it: this page emitted none while the React page it
    // shares a route with emitted six, so a crawler and a person reading the
    // same URL were being shown different amounts. See the assertions below
    // for the part that matters, which is that the two agree.
    expect(graph.map((n: any) => n['@type'])).toEqual(['BreadcrumbList', 'FAQPage']);
    expect(JSON.stringify(graph)).not.toContain('aggregateRating');
  });
});

describe('the category page', () => {
  it('lists the category’s services with what each has open', async () => {
    const page = await categoryPage(env, 'auto');
    expect(page!).toContain('<title>Automotive and vehicle — mobile services | Round The Way</title>');
    expect(page!).toContain('<h1>Automotive and vehicle');
    expect(page!).toContain(`href="/s/${DETAILING_SEG}"`);
    // THE COUNT IS ON THE HEADING, NOT ON EVERY TILE. A tile is a picture with
    // the service's name across it and nothing else, so what is open is
    // counted once for the whole category in the H1 — printing it under all
    // thirteen pictures made the page repeat "None open right now" thirteen
    // times. Per-trade counts are on the trade's own page.
    expect(page!).toContain('open appointments in this category');
    expect(page!).not.toContain('None open right now');
  });

  it('offers the other categories and the neighbourhoods', async () => {
    const page = await categoryPage(env, 'auto');
    expect(page!).toContain('href="/browse/home"');
    expect(page!).toContain('href="/near/sherman-oaks"');
  });

  it('returns null for a category that does not exist', async () => {
    expect(await categoryPage(env, 'submarines')).toBeNull();
  });
});

describe('the business profile', () => {
  it('has the name, the overview facts and what they have open', async () => {
    const page = await profilePage(env, 'valley-detailing');
    expect(page!).not.toBeNull();
    // THE TITLE WAS THE BUSINESS NAME AND NOTHING ELSE, which held not one
    // word anybody searches with, grew to whatever length the owner typed,
    // and became " | Round The Way" — an empty title — when the name was
    // blank. It carries the trade now, and the metro too where all three fit
    // inside what a result shows.
    expect(page!).toContain(
      '<title>Valley Detailing — Car wash and detailing | Round The Way</title>');
    expect(page!).toContain('<h1>Valley Detailing</h1>');
    expect(page!).toContain('Water and power on board');
    expect(page!).toContain('Hired 7 times');
    expect(page!).toContain('2 employees');
    expect(page!).toContain('Sherman Oaks');
    expect(page!).toContain('href="/book/');
  });

  it('says "no reviews yet" in words, and marks up no rating at all', async () => {
    const page = await profilePage(env, 'valley-detailing');
    expect(page!).toContain('New — no reviews yet');
    expect(JSON.stringify(graphOf(page!))).not.toContain('aggregateRating');
  });

  /**
   * THE NODE WAS `['Product','LocalBusiness']` AND COULD SATISFY NEITHER.
   *
   * It carried a name, a URL and a list of areas — no `address`, which Google
   * requires before a LocalBusiness can produce a result, and no `image`,
   * which it requires for a Product. So this aggregateRating, the stars this
   * page exists to win, was being emitted for the benefit of nothing. The
   * assertion below changed with the node: one LocalBusiness, identified by
   * `@id` so the offers on every /near page can point at this same business,
   * with an address that says the town, the region and the country and never
   * a street line — these businesses are vans and have no premises, and
   * inventing one would be filing a fact nobody here knows.
   */
  it('marks up an AggregateRating only once real reviews exist', async () => {
    await addReview('op1', 5, 'Spotless, and on time.');
    await addReview('op1', 4, 'Good work.');
    const page = await profilePage(env, 'valley-detailing');
    const node = graphOf(page!)['@graph']
      .find((n: any) => n['@type'] === 'LocalBusiness');
    expect(node.aggregateRating).toEqual({
      '@type': 'AggregateRating',
      ratingValue: 4.5,
      reviewCount: 2,
      bestRating: 5,
      worstRating: 1,
    });
    expect(node['@id']).toBe('https://gap.test/p/valley-detailing');
    expect(node.address).toEqual({
      '@type': 'PostalAddress',
      addressLocality: 'Los Angeles',
      addressRegion: 'California',
      addressCountry: 'US',
    });
    // A van has no street address, and one would have to be invented.
    expect(JSON.stringify(node)).not.toContain('streetAddress');
    // Product is gone: it was the half that needed an image and never had one.
    expect(JSON.stringify(graphOf(page!))).not.toContain('Product');
    // The figure in the markup is the figure on the page.
    expect(page!).toContain('4.5');
    expect(page!).toContain('Spotless, and on time.');
  });

  it('refuses to publish a rating for a seeded sample business', async () => {
    await addOperator({
      id: DEMO_OPERATOR_ID, name: 'Demo Detailing', trade: DETAILING,
      place: SHERMAN_OAKS, profileSlug: 'demo-detailing', priceCents: 8900,
    });
    await addReview(DEMO_OPERATOR_ID, 5, 'Seeded praise.');
    const page = await profilePage(env, 'demo-detailing');
    expect(page!).toContain('Sample business.');
    expect(page!).toContain('noindex');
    expect(JSON.stringify(graphOf(page!))).not.toContain('aggregateRating');
  });

  it('returns null for a slug nobody has published', async () => {
    expect(await profilePage(env, 'nobody-at-all')).toBeNull();
  });

  /**
   * Migration 0008 records width and height on work_photos and says why in a
   * comment: "so the public page can reserve the right box before the image
   * arrives. Without them the profile reflows as each photo loads." This page
   * then rendered `width="160" loading="lazy"` and no height at all, so it
   * reflowed exactly as the comment describes — on the one page somebody reads
   * before deciding to let a stranger into their house.
   */
  it('reserves a box for every photo and does not defer the first one', async () => {
    const n = t();
    for (const [i, size] of [[1200, 900], [1000, 1500]].entries()) {
      await env.DB.prepare(
        `INSERT INTO work_photos (id,operator_id,r2_key,caption,width,height,bytes,
           content_type,sort_order,created_at,updated_at)
         VALUES (?,'op1',?,?,?,?,120000,'image/jpeg',?,?,?)`,
      ).bind(newId(), `w/op1/photo-${i}`, `Photo ${i}`, size[0], size[1], i, n, n).run();
    }

    const page = (await profilePage(env, 'valley-detailing'))!;
    // 160 × 900/1200 and 160 × 1500/1000, so the box is the shape the picture
    // actually is rather than a square guessed here.
    expect(page).toContain('width="160" height="120"');
    expect(page).toContain('width="160" height="240"');
    // The first is what a reader sees above the fold, so it is not deferred.
    expect(page).toContain('loading="eager" fetchpriority="high"');
    expect(page.match(/fetchpriority="high"/g)).toHaveLength(1);
    expect(page.match(/loading="lazy"/g)).toHaveLength(1);
  });
});

describe('the /near index', () => {
  it('enumerates every covered neighbourhood with what is open in it', async () => {
    const page = await areaIndexPage(env);
    // The title is the site's footprint in a phrase, built from the live metro
    // list rather than written out. It read "Los Angeles and Santa Maria" for
    // as long as both places were open and reads "Los Angeles" while the site
    // is being tested in Los Angeles only — so the literal below is expected
    // to change again on the day a second metro opens, and the two lines after
    // it are the rule that does not: every live metro is named here and
    // nothing else is.
    const title = page.slice(page.indexOf('<title>'), page.indexOf('</title>'));
    expect(page).toContain('<title>Every neighbourhood — Los Angeles | Round The Way</title>');
    for (const m of METROS) expect(title, m.name).toContain(m.name);
    for (const m of METROS_INCLUDING_HIDDEN) {
      if (!m.live) expect(title, m.name).not.toContain(m.name);
    }
    expect(page).toContain('href="/near/sherman-oaks"');
    expect(page).toContain('href="/near/encino"');
    expect(page).toContain('href="/near/sherman-oaks/mobile-car-wash-and-detailing"');
    expect(page).toContain('2 neighbourhoods, 2 open appointments');
  });

  it('links on to the metro page', async () => {
    expect(await areaIndexPage(env)).toContain('href="/los-angeles"');
  });
});

describe('the /cost index', () => {
  it('carries one row for every trade in the catalogue, quiet ones included',
    async () => {
      const page = await costIndexPage(env);
      expect(page).toContain('<title>What things cost — every cost guide | Round The Way</title>');
      expect(page).toContain('<h1>What things cost on Round The Way');
      // The catalogue is the spine, not today's listings: the guide for a
      // trade with nothing listed is the page that answers the question
      // honestly, so leaving it off would hide the honest answer.
      for (const trade of ALL_TRADES) {
        expect(page).toContain(`href="/cost/${seg(trade.slug)}"`);
      }
      expect(page).toContain(`${ALL_TRADES.length} cost guides`);
    });

  it('counts the listings it is about to show, and says they are asking prices',
    async () => {
      const page = await costIndexPage(env);
      // Two operators, one opening each, both in detailing.
      expect(page).toContain('2 listings counted');
      expect(page).toContain('businesses on Round The Way are asking right\nnow');
      expect(page).not.toMatch(/average cost|typical cost|expect to pay/i);
    });

  it('refuses to call two prices a range', async () => {
    const page = await costIndexPage(env);
    // ENOUGH is 3 and detailing has 2, so it belongs in the thin group with
    // how little is behind it stated, and in no group that carries a spread.
    expect(page).toContain('Too few listings to give a range');
    expect(page).toContain('2 prices listed — no range');
    expect(page).not.toContain('$99.00 – $129.00');
  });

  it('gives a low, a middle and a high once there are enough listings',
    async () => {
      await addOperator({
        id: 'op4', name: 'Tarzana Shine', trade: DETAILING,
        place: SHERMAN_OAKS, priceCents: 15900,
      });
      const page = await costIndexPage(env);
      expect(page).toContain('Listed prices today');
      expect(page).toContain('$99.00 – $159.00, middle $129.00');
      expect(page).toContain('3 listings from 3 businesses');
    });

  it('offers the trades with nothing listed as their own group', async () => {
    const page = await costIndexPage(env);
    expect(page).toContain('Nothing listed right now');
    expect(page).toContain('What junk removal costs');
  });

  it('links back to the other two hubs and the metro page', async () => {
    const page = await costIndexPage(env);
    expect(page).toContain('href="/browse"');
    expect(page).toContain('href="/near"');
    expect(page).toContain('href="/los-angeles"');
  });
});

describe('the /browse index', () => {
  it('lists every category and every service under it', async () => {
    const page = await browseIndexPage(env);
    expect(page).toContain('<title>Every service — browse Round The Way | Round The Way</title>');
    expect(page).toContain('<h1>Every service Round The Way covers');
    for (const c of TRADE_CATEGORIES) {
      expect(page).toContain(`href="/browse/${c.key}"`);
    }
    for (const trade of ALL_TRADES) {
      expect(page).toContain(`href="/s/${seg(trade.slug)}"`);
    }
  });

  it('counts what is open per category, once, and never on a tile', async () => {
    const page = await browseIndexPage(env);
    // One count per category, in the heading over its grid of tiles. The
    // tiles carry a picture and a name and nothing else, so a category with
    // nothing free says so once rather than forty times.
    expect(page).toContain('2 appointments open now');
    expect(page).toContain('none open right now');
    expect(page).not.toContain('None open right now');
    expect(page).not.toContain('0 appointments open now');
  });

  it('offers the geography and the cost hub as the other ways in', async () => {
    const page = await browseIndexPage(env);
    expect(page).toContain('href="/near"');
    expect(page).toContain('href="/los-angeles"');
    expect(page).toContain('href="/cost"');
  });
});

describe('the metro page', () => {
  it('counts the city from the rows and ranks the trades by what is open', async () => {
    const page = await metroPage(env, LOS_ANGELES);
    expect(page).toContain('<title>Mobile services in Los Angeles, California | Round The Way</title>');
    expect(page).toContain('<h1>Mobile services in Los Angeles, California');
    expect(page).toContain('<b>2</b><span>appointments open</span>');
    expect(page).toContain('<b>2</b><span>businesses listed</span>');
    expect(page).toContain(`href="/s/${DETAILING_SEG}"`);
    expect(page).toContain('href="/near/sherman-oaks"');
    expect(page).toContain('href="/browse/auto"');
  });

  it('makes no claim about Round The Way beyond how it works', async () => {
    const page = await metroPage(env, LOS_ANGELES);
    for (const boast of [
      'most popular', 'trusted by', 'thousands', 'best in', 'top rated',
      'happy customers', 'save up to', 'fastest',
    ]) {
      expect(page.toLowerCase()).not.toContain(boast);
    }
  });

  it('links to every trade in the catalogue, so nothing is orphaned', async () => {
    const page = await metroPage(env, LOS_ANGELES);
    expect(page).toContain('href="/s/mobile-notary"');
    expect(page).toContain('href="/s/tutoring"');
  });
});

describe('site chrome', () => {
  it('puts the wordmark and the nav on every page, and no search box',
    async () => {
      for (const page of [
        (await tradePage(env, DETAILING))!,
        (await costGuidePage(env, DETAILING))!,
        (await categoryPage(env, 'auto'))!,
        (await profilePage(env, 'valley-detailing'))!,
        (await neighbourhoodPage(env, 'sherman-oaks'))!,
        await areaIndexPage(env),
        await costIndexPage(env),
        await browseIndexPage(env),
        await metroPage(env, LOS_ANGELES),
      ]) {
        expect(page).toContain('class="wordmark" href="/"');
        expect(page).toContain('href="/join"');
        expect(page).toContain('href="/a"');

        // THE SEARCH BOX WAS REMOVED FROM THE BAR, and it has to be gone from
        // BOTH trees or the bar changes shape when React mounts over the
        // server-rendered page — a field that is there for a moment and then
        // vanishes under somebody's finger. SiteHeader.tsx now defaults
        // `search` to false; this is the other half of that pair.
        //
        // /search itself is untouched and is still a page. What is asserted
        // here is only that no page puts a box for it in the header.
        expect(page).not.toContain('action="/search"');
      }
    });

  it('puts the three footer columns on every page, and no directory', async () => {
    const page = (await tradePage(env, DETAILING))!;
    for (const heading of ['Customers', 'Pros', 'Support']) {
      expect(page).toContain(`<h2>${heading}</h2>`);
    }
    // The brand block above them.
    expect(page).toContain('class="foot-mark"');

    // NO DIRECTORY. It used to be three more columns under those three —
    // every category, eight trades and a dozen neighbourhoods — and it made
    // the foot of every page a wall of forty-odd links. The reference
    // marketplace's own footer carries thirty-two links in three columns and
    // no directory at all, which is the shape this now matches.
    //
    // Nothing became unreachable by dropping it: /browse and /near are links
    // in the Customers column and each lists everything under it, so a deep
    // page is two hops from here instead of one.
    for (const gone of ['Browse by category', 'Browse by service', 'Open near you']) {
      expect(page, gone).not.toContain(gone);
    }
    expect(page).toContain('href="/browse"');
    expect(page).toContain('href="/near"');
    // EVERY LABEL IN THE COLUMNS NOW GOES SOMEWHERE.
    //
    // The footer used to print six labels with no page behind them — Get an
    // estimate, Pricing, Careers, Press, Blog and Contact — as plain grey
    // text. That was defended as more honest than a link that 404s, and it
    // is; but leaving them out is equally honest and does not make the foot
    // of every page look half-built. They come back as links on the day the
    // pages exist, and this is what fails if one is put back as text.
    expect(page).not.toContain('class="foot-soon"');
    expect(page).toContain('<a href="/terms">Terms of service</a>');
  });
});

describe('progressive enhancement', () => {
  const SHELL = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<title>Round The Way — front page</title>'
    + '<meta name="description" content="the front page">'
    + '<script type="module" src="/assets/app.js"></script>'
    + '</head><body><div id="root"></div></body></html>';

  it('delivers the rendered page inside the SPA document, script and all',
    async () => {
      const page = (await tradePage(env, DETAILING, { shell: SHELL }))!;
      expect(page).toContain('src="/assets/app.js"');
      expect(page).toContain('<div id="root"><div class="sf-ssr">');
      expect(page).toContain('Valley Detailing');
      // One title and one description, and they are this page's.
      expect(page).not.toContain('Round The Way — front page');
      expect(page).not.toContain('content="the front page"');
      expect(page.match(/<title>/g)).toHaveLength(1);
    });

  it('scopes its stylesheet so it cannot restyle the app that replaces it',
    async () => {
      const page = (await tradePage(env, DETAILING, { shell: SHELL }))!;
      const css = page.slice(page.indexOf('<style>'), page.indexOf('</style>'));
      expect(css).toContain('.sf-ssr');
      // No bare body or :root rule left to outlive the markup it styles.
      expect(css).not.toMatch(/(^|\n|})body\{/);
      expect(css).not.toMatch(/(^|\n|}):root\{/);
    });

  it('puts the structured data where React will remove it, not in the head',
    async () => {
      const page = (await tradePage(env, DETAILING, { shell: SHELL }))!;
      const head = page.slice(0, page.indexOf('</head>'));
      expect(head).not.toContain('application/ld+json');
      expect(page.slice(page.indexOf('<div id="root">')))
        .toContain('application/ld+json');
    });

  it('falls back to a standalone document when the shell is not what we expect',
    async () => {
      const page = (await tradePage(env, DETAILING, { shell: '<html><body></body></html>' }))!;
      expect(page.startsWith('<!doctype html>')).toBe(true);
      expect(page).toContain('Valley Detailing');
      expect(page).not.toContain('sf-ssr');
    });
});

describe('the sitemap', () => {
  const BASE = 'https://roundtheway.app';

  it('carries the metro page and the neighbourhood index', async () => {
    const xml = await sitemapXml(env, BASE);
    expect(xml).toContain(`<loc>${BASE}/los-angeles</loc>`);
    expect(xml).toContain(`<loc>${BASE}/near</loc>`);
  });

  it('carries the two catalogue hubs, which are true on an empty afternoon',
    async () => {
      const xml = await sitemapXml(env, BASE);
      expect(xml).toContain(`<loc>${BASE}/browse</loc>`);
      expect(xml).toContain(`<loc>${BASE}/cost</loc>`);
    });

  it('carries a trade with something open, and its cost guide', async () => {
    const xml = await sitemapXml(env, BASE);
    expect(xml).toContain(`<loc>${BASE}/s/${DETAILING_SEG}</loc>`);
    expect(xml).toContain(`<loc>${BASE}/cost/${DETAILING_SEG}</loc>`);
  });

  it('leaves out a trade with nothing open, and its cost guide with it', async () => {
    const xml = await sitemapXml(env, BASE);
    expect(xml).not.toContain(`${BASE}/s/junk%20removal`);
    expect(xml).not.toContain(`${BASE}/cost/junk%20removal`);
  });

  it('carries a category only when one of its trades is live', async () => {
    const xml = await sitemapXml(env, BASE);
    expect(xml).toContain(`<loc>${BASE}/browse/auto</loc>`);
    // Every 'home' trade here is empty, so the category page would be a list
    // of dead ends.
    expect(xml).not.toContain(`<loc>${BASE}/browse/home</loc>`);
    expect(xml).not.toContain(`<loc>${BASE}/browse/pets</loc>`);
  });

  it('carries a published profile', async () => {
    const xml = await sitemapXml(env, BASE);
    expect(xml).toContain(`<loc>${BASE}/p/valley-detailing</loc>`);
  });

  /*
    THE ASSERTION IS THAT A SAMPLE BUSINESS CHANGES NOTHING ABOUT WHAT IS
    SUBMITTED, which is a different sentence from the one this test used to
    make and is the sentence its name has always meant.

    It used to end on `expect(xml).not.toContain(seg('trash can cleaning'))` —
    no URL anywhere in the file may carry that trade's segment — and that
    stopped being true for a reason with nothing to do with sample data.
    /cost/<trade> is now submitted on the test its own page indexes on, which
    is "a genuine opening in the trade, OR written cost factors in
    lib/costfacts.ts", and 'trash can cleaning' has had a costfacts entry the
    whole time. So /cost/trash-can-cleaning is in this file on an empty
    database with no operator of any kind in that trade, sample or otherwise —
    the `livesWithoutAnyOperator` expectation below is that fact, asserted
    before the demo row is inserted so it cannot be mistaken for its doing.
    The blanket string match was reading a written guide's presence as a
    sample business leaking into the file, which is why it failed on a sitemap
    that was behaving exactly as `sitemapXml` and `costGuidePage` both
    document.

    Comparing the two URL sets is what closes the hole the old line was aiming
    at, and it closes it wider: every route a demo operator could reach the
    file by — its profile, its trade page, its neighbourhood square, its
    category — is covered at once by the set being unchanged, rather than by
    the one spelling of one segment that happened to be checked.
  */
  it('never submits a sample business or its trade', async () => {
    const locs = (xml: string) =>
      [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!).sort();

    const before = locs(await sitemapXml(env, BASE));
    const livesWithoutAnyOperator = `${BASE}/cost/${seg('trash can cleaning')}`;
    expect(before).toContain(livesWithoutAnyOperator);

    await addOperator({
      id: DEMO_OPERATOR_ID, name: 'Demo Bins', trade: 'trash can cleaning',
      place: SHERMAN_OAKS, profileSlug: 'demo-bins',
    });
    const xml = await sitemapXml(env, BASE);

    expect(xml).not.toContain('/p/demo-bins');
    // Its trade page and its neighbourhood square are inventory claims, and a
    // sample opening is not inventory. The cost guide is not one of those: it
    // is several hundred words of written explanation that were already there.
    expect(xml).not.toContain(`${BASE}/s/${seg('trash can cleaning')}`);
    expect(xml).not.toContain(`/near/${SHERMAN_OAKS.slug}/${seg('trash can cleaning')}`);
    expect(locs(xml)).toEqual(before);
  });

  it('stamps every URL with a lastmod taken from a real row', async () => {
    const xml = await sitemapXml(env, BASE);
    const stamps = [...xml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1]!);
    expect(stamps.length).toBeGreaterThan(0);
    for (const s of stamps) expect(Number.isNaN(Date.parse(s))).toBe(false);
    // Nothing is stamped in the future, which is what a made-up value looks like.
    const cutoff = (now() + 60) * 1000;
    for (const s of stamps) expect(Date.parse(s)).toBeLessThanOrEqual(cutoff);
  });

  /** Every entry, as loc → lastmod in epoch seconds. */
  function lastmods(xml: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g)) {
      out[m[1]!] = Math.round(Date.parse(m[2]!) / 1000);
    }
    return out;
  }

  /**
   * `/` WAS STAMPED `now()` ON EVERY FETCH, whatever the rows said — the
   * textbook untrustworthy lastmod, on the single most important URL in the
   * file. A crawler that refetches on a timestamp and finds the same bytes
   * learns to stop believing the file, and it discounts the whole file rather
   * than the one URL.
   */
  it('takes every lastmod off a row, the front page included', async () => {
    const old = now() - 40 * 86400;
    await env.DB.prepare('UPDATE operators SET updated_at = ?').bind(old).run();
    await env.DB.prepare('UPDATE gaps SET updated_at = ?').bind(old).run();
    await env.DB.prepare('UPDATE service_areas SET updated_at = ?').bind(old).run();

    const stamps = lastmods(await sitemapXml(env, BASE));
    expect(Object.keys(stamps).length).toBeGreaterThan(5);
    for (const [loc, at] of Object.entries(stamps)) expect(at, loc).toBe(old);
  });

  /**
   * The two catalogue hubs are built from the compiled-in array in trades.ts.
   * They used to carry "the freshest row anywhere on the site", so an operator
   * in Burbank posting one opening restamped a list of thirty-eight trade
   * names that had not changed by a character.
   */
  it('does not restamp the catalogue hubs when somebody posts an opening', async () => {
    const before = lastmods(await sitemapXml(env, BASE));
    await env.DB.prepare(
      `UPDATE gaps SET updated_at = ? WHERE operator_id = 'op1'`,
    ).bind(now() + 5000).run();
    const after = lastmods(await sitemapXml(env, BASE));

    expect(after[`${BASE}/browse`]).toBe(before[`${BASE}/browse`]);
    expect(after[`${BASE}/cost`]).toBe(before[`${BASE}/cost`]);
    // The pages the opening IS on do move, so this is not passing because
    // nothing moved.
    expect(after[`${BASE}/near/sherman-oaks`])
      .toBeGreaterThan(before[`${BASE}/near/sherman-oaks`]!);
  });

  /**
   * `placeLastmod` joined gaps on `operator_id` alone, with nothing tying the
   * gap to the place — so one business posting an opening in one of its
   * neighbourhoods restamped every OTHER neighbourhood it covers, none of
   * whose pages had changed.
   */
  it('does not restamp a neighbourhood for an opening in a different one', async () => {
    const old = now() - 40 * 86400;
    // op1 now covers Encino as well. Its only opening is anchored in Sherman
    // Oaks, so mapData places it there and the Encino page does not show it.
    await env.DB.prepare(
      `INSERT INTO service_areas (id,operator_id,name,slug,place_slug,lat,lng,radius_meters,
         created_at,updated_at) VALUES (?,'op1','Encino','encino-op1','encino',?,?,8000,?,?)`,
    ).bind(newId(), ENCINO.lat, ENCINO.lng, old, old).run();

    await env.DB.prepare('UPDATE service_areas SET updated_at = ?').bind(old).run();
    await env.DB.prepare(
      `UPDATE gaps SET updated_at = ? WHERE operator_id <> 'op1'`,
    ).bind(old).run();
    await env.DB.prepare(
      `UPDATE gaps SET updated_at = ? WHERE operator_id = 'op1'`,
    ).bind(now()).run();

    const stamps = lastmods(await sitemapXml(env, BASE));
    expect(stamps[`${BASE}/near/sherman-oaks`]).toBe(now());
    expect(stamps[`${BASE}/near/encino`]).toBe(old);
  });
});

describe('robots.txt', () => {
  it('lets crawlers into the new surfaces', () => {
    const txt = robotsTxt('https://roundtheway.app');
    for (const path of ['/s/', '/cost/', '/browse/', '/los-angeles', '/p/']) {
      expect(txt).toContain(`Allow: ${path}`);
    }
  });

  it('names the sitemap absolutely even where APP_URL is unset', () => {
    // `Sitemap: /sitemap.xml` is what an unset APP_URL used to produce. The
    // protocol requires an absolute URL and consumers discard a relative one,
    // so the line was there and did nothing. src/index.ts falls back to the
    // request's own origin, which is what this receives.
    expect(robotsTxt('https://gap.test')).toContain('Sitemap: https://gap.test/sitemap.xml');
    expect(robotsTxt('https://gap.test')).not.toContain('Sitemap: /sitemap.xml');
  });
});

// ---------------------------------------------------------------------------

/**
 * THE FRONT PAGE, which this file could not have tested before because there
 * was no front page to test.
 *
 * `/` had no route and no WORKER_PATHS entry, so the assets binding answered
 * it with the SPA shell: an empty #root, no canonical, no heading, no
 * sentence and no link, at the address every external link to this site points
 * at. Click depth is measured from the root, so a root linking to nothing gave
 * every other page on the site no depth at all.
 */
describe('the front page', () => {
  it('renders real content, with a canonical pointing at itself', async () => {
    const page = await homePage(env);
    expect(page).toContain('<link rel="canonical" href="https://gap.test/">');
    expect(page).toContain('<h1>Book someone round the way');
    expect(page).toContain('<meta name="robots" content="index,follow');
    // Counted from the rows, like everything else here.
    expect(page).toContain('<b>2</b><span>appointments open</span>');
  });

  it('links down into every layer of the site', async () => {
    const page = await homePage(env);
    for (const href of [
      '/browse', '/cost', '/near', '/los-angeles', '/a', '/join', '/pros', '/covered',
      `/s/${DETAILING_SEG}`, '/browse/auto', '/near/sherman-oaks', '/near/encino',
    ]) {
      expect(page, href).toContain(`href="${href}"`);
    }
    // Every trade in the catalogue, so nothing in it is orphaned from the root.
    for (const trade of ALL_TRADES) {
      expect(page, trade.slug).toContain(`href="/s/${seg(trade.slug)}"`);
    }
  });

  /**
   * There was no Organization node anywhere in the repository and no WebSite
   * node either, so nothing on the site said what the brand is called or that
   * it has a search page — and a query for the brand name had nothing to
   * attach to.
   */
  it('states the brand and the site search, which nothing did before', async () => {
    const graph = graphOf(await homePage(env))['@graph'];
    const org = graph.find((n: any) => n['@type'] === 'Organization');
    const site = graph.find((n: any) => n['@type'] === 'WebSite');

    expect(org.name).toBe('Round The Way');
    expect(org['@id']).toBe('https://gap.test/#organization');
    expect(org.url).toBe('https://gap.test/');
    // Joined by @id rather than nested, so anything else can point at the same
    // organisation instead of describing it a second time.
    expect(site.publisher['@id']).toBe(org['@id']);
    expect(site.potentialAction['@type']).toBe('SearchAction');
    expect(site.potentialAction.target.urlTemplate)
      .toBe('https://gap.test/search?q={search_term_string}');
    expect(site.potentialAction['query-input']).toBe('required name=search_term_string');
  });
});

// ---------------------------------------------------------------------------

/**
 * WHAT THE WORKER ANSWERS, as opposed to what the renderers return.
 *
 * Everything in here is a status code or a Location header, which is the half
 * of these pages no renderer can get right on its own.
 */
describe('the addresses the pages answer on', () => {
  const SHELL = '<!doctype html><html lang="en"><head>'
    + '<title>Round The Way — front page</title>'
    + '<meta name="description" content="the front page">'
    + '<meta property="og:title" content="the front page">'
    + '<meta property="og:image" content="/front.png">'
    + '<meta name="twitter:title" content="the front page">'
    + '<script type="module" src="/assets/app.js"></script>'
    + '</head><body><div id="root"></div></body></html>';

  const ASSETS = {
    fetch: async () => new Response(SHELL, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
  };

  const call = (path: string) => worker.fetch(
    new Request(`https://gap.test${path}`),
    { ...env, ASSETS } as unknown as Env,
    {} as ExecutionContext,
  );

  /**
   * THE 301 USED TO POINT THE OTHER WAY, which is the whole of defect one:
   * /s/junk-removal was redirected to /s/junk%20removal, so the readable
   * spelling was the one being thrown away.
   */
  it('sends the escaped spelling of a trade to the readable one', async () => {
    const res = await call(`/s/${encodeURIComponent(DETAILING)}`);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(`/s/${DETAILING_SEG}`);

    const cost = await call(`/cost/${encodeURIComponent(DETAILING)}`);
    expect(cost.status).toBe(301);
    expect(cost.headers.get('location')).toBe(`/cost/${DETAILING_SEG}`);

    // And the readable one is the page.
    expect((await call(`/s/${DETAILING_SEG}`)).status).toBe(200);
  });

  it('sends a trailing slash and a capital letter to the one address', async () => {
    for (const [asked, want] of [
      [`/s/${DETAILING_SEG}/`, `/s/${DETAILING_SEG}`],
      ['/S/Mobile-Car-Wash-And-Detailing', `/s/${DETAILING_SEG}`],
      ['/near/sherman-oaks/', '/near/sherman-oaks'],
      ['/near/Sherman-Oaks', '/near/sherman-oaks'],
      ['/Near/Sherman-Oaks', '/near/sherman-oaks'],
      // An operator's own area slug, which /near has always accepted as well
      // as the shared neighbourhood key — four live copies of one page before
      // this, times every trade.
      ['/near/sherman-oaks-op1', '/near/sherman-oaks'],
      ['/near/sherman-oaks-op1/', '/near/sherman-oaks'],
      ['/near/sherman-oaks-op1/mobile-car-wash-and-detailing',
        '/near/sherman-oaks/mobile-car-wash-and-detailing'],
      [`/near/sherman-oaks/${encodeURIComponent(DETAILING)}`,
        '/near/sherman-oaks/mobile-car-wash-and-detailing'],
      ['/browse/AUTO', '/browse/auto'],
      ['/p/Valley-Detailing', '/p/valley-detailing'],
      ['/near/', '/near'],
      ['/browse/', '/browse'],
      ['/Los-Angeles', '/los-angeles'],
    ] as const) {
      const res = await call(asked);
      expect(res.status, asked).toBe(301);
      expect(res.headers.get('location'), asked).toBe(want);
    }
  });

  it('keeps the query string across the redirect', async () => {
    const res = await call('/near/sherman-oaks/?ref=newsletter');
    expect(res.headers.get('location')).toBe('/near/sherman-oaks?ref=newsletter');
  });

  /**
   * A 200 FOR AN ADDRESS THAT DOES NOT EXIST is what Google calls a soft 404,
   * and every one of these used to be one.
   */
  it('answers 404 for an address the site does not have', async () => {
    for (const path of [
      '/s/dragon-grooming', '/cost/dragon-grooming', '/browse/submarines',
      '/p/nobody-at-all', '/not-a-metro-at-all', '/some/deep/route',
    ]) {
      const res = await call(path);
      expect(res.status, path).toBe(404);
      // The app still gets its document, so a person sees the site's own
      // not-found page rather than a JSON error.
      expect(res.headers.get('content-type'), path).toContain('text/html');
    }
  });

  /**
   * `/near/Sherman-Oaks` reached the Worker, found no such area and answered a
   * person with `{"error":"No such area."}` under an application/json content
   * type. An unknown neighbourhood is a page now, with a way out of it.
   */
  it('answers an unknown neighbourhood with an HTML page, not JSON', async () => {
    const res = await call('/near/atlantis');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('<h1>Nothing here</h1>');
    expect(body).toContain('content="noindex');
    expect(body).toContain('href="/near"');
    expect(body).toContain('href="/browse"');

    const trade = await call('/near/atlantis/mobile-car-wash-and-detailing');
    expect(trade.status).toBe(404);
    expect(trade.headers.get('content-type')).toContain('text/html');
  });

  it('serves the front page through the Worker, inside the SPA document', async () => {
    const res = await call('/');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('src="/assets/app.js"');
    expect(body).toContain('<div id="root"><div class="sf-ssr">');
    expect(body).toContain('<h1>Book someone round the way');
    expect(body).toContain('<link rel="canonical" href="https://gap.test/">');
  });

  /**
   * THE SHELL'S OWN SOCIAL TAGS SURVIVED AND WON. `intoShell` stripped the
   * title and the description and nothing else, so every page rendered into
   * the SPA document carried two og:title tags — and every unfurler takes the
   * first, which was the shell's. A link to any of the six routes pasted into
   * a message drew the front page's title, description and picture.
   */
  it('leaves only its own og and twitter tags on a page it rendered', async () => {
    const body = await (await call('/')).text();
    expect(body).not.toContain('content="the front page"');
    expect(body.match(/property="og:title"/g)).toHaveLength(1);
    expect(body.match(/name="twitter:title"/g)).toHaveLength(1);
    expect(body).not.toContain('/front.png');
    expect(body.match(/<title>/g)).toHaveLength(1);
  });

  it('asks for no font from another host on a standalone page', async () => {
    // The standalone documents carried a render-blocking stylesheet link to
    // fonts.googleapis.com, four lines under a comment promising "no script,
    // no font request, no image host". These are the fastest pages on the
    // site and that was the only thing they waited for.
    const body = await (await call('/near/sherman-oaks')).text();
    expect(body).not.toContain('fonts.googleapis.com');
    expect(body).not.toContain('fonts.gstatic.com');
  });

  it('caches the sitemap no longer than the pages it advertises', async () => {
    // The sitemap was cached for an hour while /near/<place>/<trade> is cached
    // for five minutes — and that page goes noindex the moment its last
    // opening is booked. So for up to an hour a crawler could be handed a file
    // promising URLs that had already stopped asking to be indexed.
    const sMaxAge = (res: Response) =>
      Number(/s-maxage=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1] ?? NaN);

    const page = sMaxAge(await call('/near/sherman-oaks/mobile-car-wash-and-detailing'));
    const map = sMaxAge(await call('/sitemap.xml'));
    expect(Number.isNaN(page)).toBe(false);
    expect(Number.isNaN(map)).toBe(false);
    expect(map).toBeLessThanOrEqual(page);
  });

  it('tells a crawler not to follow the link into the disallowed checkout', async () => {
    // /book/ is Disallowed in robots.txt, and it is the most prominent link on
    // every listing on the site.
    const body = await (await call('/near/sherman-oaks')).text();
    expect(body).toMatch(/<a class="book" rel="nofollow" href="\/book\//);
  });
});

// ---------------------------------------------------------------------------

function graphOf(page: string): any {
  const m = page.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  expect(m).not.toBeNull();
  return JSON.parse(m![1]!
    .replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&'));
}

/** The same escaping the page applies, so a question can be looked for in it. */
function escapeish(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
