import { describe, expect, it, beforeEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import type { Env } from '../src/types';
import {
  areaIndexPage, browseIndexPage, canonicalTradeSegment, categoryPage, costGuidePage,
  costIndexPage, metroPage, neighbourhoodPage, profilePage, robotsTxt, sitemapXml,
  tradeFromPathSegment, tradePage,
} from '../src/lib/seo';
import { ALL_TRADES, TRADE_CATEGORIES } from '../src/lib/trades';
import { DEMO_OPERATOR_ID } from '../src/lib/demo';
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

let env: Env;
const t = () => now();

const OAKS = { lat: 34.1500, lng: -118.4490 };
const ENCINO = { lat: 34.1590, lng: -118.5010 };
const SHERMAN_OAKS = { name: 'Sherman Oaks', slug: 'sherman-oaks', ...OAKS };
const ENCINO_PLACE = { name: 'Encino', slug: 'encino', ...ENCINO };

/** The stored trade slug, which is also the segment the React app links with. */
const DETAILING = 'mobile car wash and detailing';
const DETAILING_SEG = encodeURIComponent(DETAILING);

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
    `INSERT INTO operators (id,email,business_name,trade,timezone,country,currency,language,
       location_mode,fill_model,sms_mode,max_detour_seconds,min_gap_seconds,buffer_seconds,
       offer_ttl_seconds,offers_per_wave,min_notice_seconds,reoffer_cooldown_seconds,
       discount_percent,plan,accept_public_bookings,deposit_cents,
       profile_slug,is_published,tagline,hired_count,employees,years_in_business,
       created_at,updated_at)
     VALUES (?,?,?,?, 'America/Los_Angeles','US','USD','en','mobile','both','device',
       900,3600,900,5400,3,3600,604800,0,'active',1,1000,?,?,?,7,2,4,?,?)`,
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

  it('canonicalises to the segment the app itself links with', () => {
    expect(canonicalTradeSegment(tradeFromPathSegment('junk-removal')!)).toBe('junk%20removal');
  });
});

describe('the trade page', () => {
  it('has a title, a heading and the count it is about to show', async () => {
    const page = await tradePage(env, DETAILING);
    expect(page).not.toBeNull();
    expect(page!).toContain('<title>Car wash and detailing — what is open now | Slotfill</title>');
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

  it('emits the FAQPage and the BreadcrumbList the React page emits', async () => {
    const page = await tradePage(env, DETAILING);
    const graph = graphOf(page!)['@graph'];
    const types = graph.map((n: any) => n['@type']);
    expect(types).toContain('BreadcrumbList');
    expect(types).toContain('FAQPage');
    const faq = graph.find((n: any) => n['@type'] === 'FAQPage');
    expect(faq.mainEntity).toHaveLength(6);
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
    expect(page!).toContain('<title>What does car wash and detailing cost? | Slotfill</title>');
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
    expect(page!).toContain('<title>Automotive and vehicle — mobile services | Slotfill</title>');
    expect(page!).toContain('<h1>Automotive and vehicle');
    expect(page!).toContain(`href="/s/${DETAILING_SEG}"`);
    expect(page!).toContain('2 appointments open now');
    // A trade with nothing in it says so in words rather than showing a nought.
    expect(page!).toContain('None open right now');
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
    expect(page!).toContain('<title>Valley Detailing | Slotfill</title>');
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

  it('marks up an AggregateRating only once real reviews exist', async () => {
    await addReview('op1', 5, 'Spotless, and on time.');
    await addReview('op1', 4, 'Good work.');
    const page = await profilePage(env, 'valley-detailing');
    const node = graphOf(page!)['@graph']
      .find((n: any) => Array.isArray(n['@type']) && n['@type'].includes('Product'));
    expect(node.aggregateRating).toEqual({
      '@type': 'AggregateRating',
      ratingValue: 4.5,
      reviewCount: 2,
      bestRating: 5,
      worstRating: 1,
    });
    expect(node['@type']).toContain('LocalBusiness');
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
});

describe('the /near index', () => {
  it('enumerates every covered neighbourhood with what is open in it', async () => {
    const page = await areaIndexPage(env);
    expect(page).toContain('<title>Every neighbourhood — Los Angeles, California | Slotfill</title>');
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
      expect(page).toContain('<title>What things cost — every cost guide | Slotfill</title>');
      expect(page).toContain('<h1>What things cost on Slotfill');
      // The catalogue is the spine, not today's listings: the guide for a
      // trade with nothing listed is the page that answers the question
      // honestly, so leaving it off would hide the honest answer.
      for (const trade of ALL_TRADES) {
        expect(page).toContain(`href="/cost/${escapeish(encodeURIComponent(trade.slug))}"`);
      }
      expect(page).toContain(`${ALL_TRADES.length} cost guides`);
    });

  it('counts the listings it is about to show, and says they are asking prices',
    async () => {
      const page = await costIndexPage(env);
      // Two operators, one opening each, both in detailing.
      expect(page).toContain('2 listings counted');
      expect(page).toContain('businesses on Slotfill are asking right\nnow');
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
    expect(page).toContain('<title>Every service — browse Slotfill | Slotfill</title>');
    expect(page).toContain('<h1>Every service Slotfill covers');
    for (const c of TRADE_CATEGORIES) {
      expect(page).toContain(`href="/browse/${c.key}"`);
    }
    for (const trade of ALL_TRADES) {
      expect(page).toContain(`href="/s/${escapeish(encodeURIComponent(trade.slug))}"`);
    }
  });

  it('counts what is open per service and says so in words when it is nothing',
    async () => {
      const page = await browseIndexPage(env);
      expect(page).toContain('2 appointments open now');
      // A bare nought where a number usually means "open now" reads as a
      // broken count rather than as a quiet week.
      expect(page).toContain('None open right now');
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
    const page = await metroPage(env);
    expect(page).toContain('<title>Mobile services in Los Angeles, California | Slotfill</title>');
    expect(page).toContain('<h1>Mobile services in Los Angeles, California');
    expect(page).toContain('<b>2</b><span>appointments open</span>');
    expect(page).toContain('<b>2</b><span>businesses listed</span>');
    expect(page).toContain(`href="/s/${DETAILING_SEG}"`);
    expect(page).toContain('href="/near/sherman-oaks"');
    expect(page).toContain('href="/browse/auto"');
  });

  it('makes no claim about Slotfill beyond how it works', async () => {
    const page = await metroPage(env);
    for (const boast of [
      'most popular', 'trusted by', 'thousands', 'best in', 'top rated',
      'happy customers', 'save up to', 'fastest',
    ]) {
      expect(page.toLowerCase()).not.toContain(boast);
    }
  });

  it('links to every trade in the catalogue, so nothing is orphaned', async () => {
    const page = await metroPage(env);
    expect(page).toContain(`href="/s/${encodeURIComponent('mobile notary')}"`);
    expect(page).toContain(`href="/s/${encodeURIComponent('tutoring')}"`);
  });
});

describe('site chrome', () => {
  it('puts the wordmark, a working search form and the nav on every page',
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
        await metroPage(env),
      ]) {
        expect(page).toContain('class="wordmark" href="/"');
        expect(page).toContain('method="get" action="/search"');
        expect(page).toContain('name="q"');
        expect(page).toContain('href="/join"');
        expect(page).toContain('href="/a"');
      }
    });

  it('puts the four footer columns and the directory on every page', async () => {
    const page = (await tradePage(env, DETAILING))!;
    for (const heading of ['For customers', 'For businesses', 'Company', 'Support']) {
      expect(page).toContain(`<h2>${heading}</h2>`);
    }
    expect(page).toContain('Browse by category');
    expect(page).toContain('Browse by service');
    expect(page).toContain('Open near you');
    // A label with no page behind it is text, not a link that lies.
    expect(page).toContain('<span class="foot-soon">Terms</span>');
  });
});

describe('progressive enhancement', () => {
  const SHELL = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<title>Slotfill — front page</title>'
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
      expect(page).not.toContain('Slotfill — front page');
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
  const BASE = 'https://app.slotfill.workers.dev';

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

  it('never submits a sample business or its trade', async () => {
    await addOperator({
      id: DEMO_OPERATOR_ID, name: 'Demo Bins', trade: 'trash can cleaning',
      place: SHERMAN_OAKS, profileSlug: 'demo-bins',
    });
    const xml = await sitemapXml(env, BASE);
    expect(xml).not.toContain('/p/demo-bins');
    expect(xml).not.toContain(encodeURIComponent('trash can cleaning'));
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
});

describe('robots.txt', () => {
  it('lets crawlers into the new surfaces', () => {
    const txt = robotsTxt('https://app.slotfill.workers.dev');
    for (const path of ['/s/', '/cost/', '/browse/', '/los-angeles', '/p/']) {
      expect(txt).toContain(`Allow: ${path}`);
    }
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
