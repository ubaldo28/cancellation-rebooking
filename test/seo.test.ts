import { describe, expect, it, beforeEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import type { Env } from '../src/types';
import {
  costGuidePage, homePage, neighbourhoodPage, robotsTxt, sitemapXml, tradeFromSlug,
  tradeInPlacePage, tradePage, tradeSlug,
} from '../src/lib/seo';
import { TRADE_RULES } from '../src/lib/credentials';
import { costsFor } from '../src/lib/costfacts';
import { DEMO_OPERATOR_ID } from '../src/lib/demo';
import { newId, now } from '../src/lib/util';

const MIGRATIONS = ALL_MIGRATIONS;

let env: Env;
const t = () => now();

// Sherman Oaks-ish, with Encino a couple of miles west so "nearby" has
// somewhere real to point at.
const OAKS = { lat: 34.1500, lng: -118.4490 };
const ENCINO = { lat: 34.1590, lng: -118.5010 };

async function addOperator(opts: {
  id: string; name: string; trade: string | null;
  place: { name: string; slug: string; lat: number; lng: number };
  priceCents?: number;
  /** Give them an opening in the next few days. */
  open?: boolean;
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
       discount_percent,plan,accept_public_bookings,deposit_cents,created_at,updated_at,
       stripe_payouts_enabled)
     VALUES (?,?,?,?, 'America/Los_Angeles','US','USD','en','mobile','both','device',
       900,3600,900,5400,3,3600,604800,0,'active',1,1000,?,?,1)`,
  ).bind(opts.id, `${opts.id}@x.com`, opts.name, opts.trade, n, n).run();

  await env.DB.prepare(
    `INSERT INTO services (id,operator_id,name,duration_seconds,price_cents,cadence_days,
       created_at,updated_at)
     VALUES (?,?,'Full detail',7200,?,28,?,?)`,
  ).bind(`sv-${opts.id}`, opts.id, opts.priceCents ?? 9900, n, n).run();

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

const SHERMAN_OAKS = { name: 'Sherman Oaks', slug: 'sherman-oaks', ...OAKS };
const ENCINO_PLACE = { name: 'Encino', slug: 'encino', ...ENCINO };

beforeEach(async () => {
  env = makeEnv(MIGRATIONS) as unknown as Env;
  // A real detailer with something open in Sherman Oaks.
  await addOperator({
    id: 'op1', name: 'Valley Detailing', trade: 'mobile car wash and detailing',
    place: SHERMAN_OAKS,
  });
  // The same trade one neighbourhood west, so the cross-links have a target.
  await addOperator({
    id: 'op2', name: 'Encino Auto Care', trade: 'mobile car wash and detailing',
    place: ENCINO_PLACE, priceCents: 12900,
  });
  // A junk hauler who covers Sherman Oaks but has nothing open — the empty
  // combination the sitemap must leave out.
  await addOperator({
    id: 'op3', name: 'Oaks Hauling', trade: 'junk removal',
    place: SHERMAN_OAKS, open: false,
  });
});

describe('trade slugs', () => {
  it('round-trips every trade the app names', () => {
    for (const trade of Object.keys(TRADE_RULES)) {
      expect(tradeFromSlug(tradeSlug(trade))).toBe(trade);
    }
  });

  it('turns a trade into the segment a searcher would type', () => {
    expect(tradeSlug('mobile car wash and detailing')).toBe('mobile-car-wash-and-detailing');
    expect(tradeSlug('tree and shrub trimming')).toBe('tree-and-shrub-trimming');
  });

  it('returns null for a slug nobody works, rather than guessing', () => {
    expect(tradeFromSlug('underwater-basket-weaving')).toBeNull();
    expect(tradeFromSlug('')).toBeNull();
    // Close to a real one, but not one of them.
    expect(tradeFromSlug('mobile-detail')).toBeNull();
  });
});

describe('the neighbourhood page', () => {
  it('names the business, the price and the way to book it', async () => {
    const page = await neighbourhoodPage(env, 'sherman-oaks');
    expect(page).not.toBeNull();
    expect(page!).toContain('Valley Detailing');
    expect(page!).toContain('$99.00');
    expect(page!).toMatch(/href="\/book\//);
    expect(page!).toContain('<h1>Open appointments in Sherman Oaks, California</h1>');
  });

  it('asks to be indexed while something real is open in it', async () => {
    const page = await neighbourhoodPage(env, 'sherman-oaks');
    expect(page!).toContain('<meta name="robots" content="index,follow');
    expect(page!).not.toContain('noindex,nofollow');
    expect(page!).toContain('<link rel="canonical"');
  });

  /**
   * IT USED TO ASK UNCONDITIONALLY, on the ground that a neighbourhood is a
   * real, bounded place. So it is — and a page about one that renders a
   * heading, the sentence "No appointments are open" and two blocks of
   * navigation is still a page with nothing on it, and there are dozens of
   * them. `sitemapXml` applies the same test, so the sitemap and the page
   * agree about which of these are worth fetching.
   */
  it('does not ask to be indexed once nothing real is open in it', async () => {
    await env.DB.prepare(`UPDATE gaps SET status = 'dismissed'`).run();
    const page = await neighbourhoodPage(env, 'sherman-oaks');
    expect(page!).toContain('<meta name="robots" content="noindex');
    expect(await sitemapXml(env, 'https://roundtheway.app'))
      .not.toContain('/near/sherman-oaks');
  });

  it('counts a sample listing as nothing, on the page and in the sitemap', async () => {
    await env.DB.prepare(`UPDATE gaps SET status = 'dismissed'`).run();
    await addOperator({
      id: DEMO_OPERATOR_ID, name: 'Demo Detailing', trade: 'mobile car wash and detailing',
      place: SHERMAN_OAKS, priceCents: 8900,
    });
    const page = await neighbourhoodPage(env, 'sherman-oaks');
    // Visible and labelled for a person; never submitted as inventory.
    expect(page!).toContain('Demo Detailing');
    expect(page!).toContain('<meta name="robots" content="noindex');
    expect(await sitemapXml(env, 'https://roundtheway.app'))
      .not.toContain('/near/sherman-oaks');
  });

  it('links down to the per-trade page and sideways to the next neighbourhood', async () => {
    const page = await neighbourhoodPage(env, 'sherman-oaks');
    expect(page!).toContain('href="/near/sherman-oaks/mobile-car-wash-and-detailing"');
    expect(page!).toContain('href="/near/encino"');
  });

  it('returns null for a place nobody covers', async () => {
    expect(await neighbourhoodPage(env, 'atlantis')).toBeNull();
  });

  it('says what is true when nothing is open, rather than showing an empty shell',
    async () => {
      await env.DB.prepare(`UPDATE gaps SET status = 'dismissed'`).run();
      const page = await neighbourhoodPage(env, 'sherman-oaks');
      expect(page!).toContain('Nothing is open in Sherman Oaks');
      expect(page!).toMatch(/cancelled|gap opens/);
    });

  it('labels a sample business as a sample, visibly', async () => {
    await addOperator({
      id: DEMO_OPERATOR_ID, name: 'Demo Detailing', trade: 'mobile car wash and detailing',
      place: SHERMAN_OAKS, priceCents: 8900,
    });
    const page = await neighbourhoodPage(env, 'sherman-oaks');
    expect(page!).toContain('Demo Detailing');
    expect(page!).toContain('Sample listing');
  });
});

describe('the trade-in-place page', () => {
  it('is the shape of the query, with the count of what is open', async () => {
    const page = await tradeInPlacePage(env, 'sherman-oaks', 'mobile-car-wash-and-detailing');
    expect(page).not.toBeNull();
    expect(page!).toContain('Car wash and detailing in Sherman Oaks');
    expect(page!).toContain('1 open appointment');
    expect(page!).toContain('Valley Detailing');
    expect(page!).toContain('$99.00');
  });

  /**
   * The trade is named once, in the catalogue's words, everywhere on the page.
   *
   * This page used to sentence-case the stored slug — "Mobile car wash and
   * detailing" — while the trade page it links to, the React app that mounts
   * over it, and two of the links in its own last section all used the
   * catalogue label. Asserting the slug spelling is absent is what stops that
   * coming back: getting the heading right while a link below it still reads
   * "Mobile car wash..." would pass the assertion above and still be the bug.
   */
  it('names the trade the same way everywhere on the page', async () => {
    const page = await tradeInPlacePage(env, 'sherman-oaks', 'mobile-car-wash-and-detailing');
    expect(page!).toContain('Car wash and detailing everywhere Round The Way covers');
    expect(page!).toContain('What car wash and detailing costs');
    // Only ever as a URL segment, never as words a reader sees.
    expect(page!.replace(/href="[^"]*"/g, '')).not.toMatch(/mobile car wash and detailing/i);
  });

  it('links to the same trade next door and to the other work here', async () => {
    const page = await tradeInPlacePage(env, 'sherman-oaks', 'mobile-car-wash-and-detailing');
    expect(page!).toContain('href="/near/encino/mobile-car-wash-and-detailing"');
    expect(page!).toContain('href="/near/sherman-oaks"');
  });

  it('returns null for a trade slug nobody works', async () => {
    expect(await tradeInPlacePage(env, 'sherman-oaks', 'dragon-grooming')).toBeNull();
  });

  it('returns null for a place nobody covers', async () => {
    expect(await tradeInPlacePage(env, 'atlantis', 'mobile-car-wash-and-detailing')).toBeNull();
  });

  it('refuses to be indexed when the combination is empty', async () => {
    const page = await tradeInPlacePage(env, 'sherman-oaks', 'junk-removal');
    expect(page).not.toBeNull();
    expect(page!).toContain('noindex');
    expect(page!).toContain('Nothing open right now');
  });
});

describe('structured data', () => {
  function graphOf(page: string): any {
    const m = page.match(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    expect(m).not.toBeNull();
    return JSON.parse(m![1]!);
  }

  it('parses as JSON and describes the opening as an Offer', async () => {
    const page = await tradeInPlacePage(env, 'sherman-oaks', 'mobile-car-wash-and-detailing');
    const data = graphOf(page!);
    expect(data['@context']).toBe('https://schema.org');
    const list = data['@graph'].find((n: any) => n['@type'] === 'ItemList');
    expect(list).toBeTruthy();
    const offer = list.itemListElement[0].item;
    expect(offer['@type']).toBe('Offer');
    expect(offer.price).toBe('99.00');
    expect(offer.priceCurrency).toBe('USD');
    expect(offer.availability).toBe('https://schema.org/InStock');
    expect(typeof offer.validThrough).toBe('string');
    expect(Number.isNaN(Date.parse(offer.validThrough))).toBe(false);
    expect(offer.itemOffered['@type']).toBe('Service');

    /*
      THE SELLER IS A REFERENCE NOW, NOT A COPY, and the assertion changed with
      it rather than around it.

      `offerLd` used to inline `{'@type':'LocalBusiness', name}` twice per
      offer — once as `provider`, once as `seller` — with no `@id`, no
      `address` and no `image`. A busy neighbourhood page was therefore two
      dozen address-less business nodes, several of them the same business,
      none of which could produce a result, and nothing tying any of them to
      the profile page that holds that business's reviews.

      So there is one LocalBusiness node per business in the graph, and the
      offers point at it by `@id`. What is checked here is that the reference
      resolves — an `@id` naming a node the document does not contain is worse
      than the inline copy was.
    */
    expect(Object.keys(offer.seller)).toEqual(['@id']);
    expect(offer.seller).toEqual(offer.itemOffered.provider);

    const business = data['@graph'].find((n: any) => n['@id'] === offer.seller['@id']);
    expect(business, 'the seller @id names no node in the graph').toBeTruthy();
    expect(business['@type']).toBe('LocalBusiness');
    expect(business.name).toBe('Valley Detailing');
    expect(business.address).toEqual({
      '@type': 'PostalAddress',
      addressLocality: 'Sherman Oaks',
      addressRegion: 'California',
      addressCountry: 'US',
    });
    // A van has no premises, so there is no street line to give and none is
    // invented to satisfy a validator.
    expect(JSON.stringify(business)).not.toContain('streetAddress');
  });

  it('describes each business once however many openings it has', async () => {
    // Two openings from one business used to mean four inline copies of that
    // business — a provider and a seller on each offer — which is how one van
    // ends up looking like four.
    await env.DB.prepare(
      `INSERT INTO gaps (id,operator_id,starts_at,ends_at,prev_lat,prev_lng,next_lat,next_lng,
         baseline_drive_seconds,is_mobile,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,180,1,'open',?,?)`,
    ).bind(newId(), 'op1', now() + 26 * 3600, now() + 30 * 3600,
      OAKS.lat, OAKS.lng, OAKS.lat, OAKS.lng, now(), now()).run();

    const page = await tradeInPlacePage(env, 'sherman-oaks', 'mobile-car-wash-and-detailing');
    const graph = graphOf(page!)['@graph'];
    const list = graph.find((n: any) => n['@type'] === 'ItemList');
    expect(list.numberOfItems).toBe(2);
    expect(graph.filter((n: any) => n['@type'] === 'LocalBusiness')).toHaveLength(1);
  });

  it('carries no rating or review property anywhere in the graph', async () => {
    for (const page of [
      await neighbourhoodPage(env, 'sherman-oaks'),
      await tradeInPlacePage(env, 'sherman-oaks', 'mobile-car-wash-and-detailing'),
    ]) {
      const raw = JSON.stringify(graphOf(page!));
      for (const banned of [
        'aggregateRating', 'ratingValue', 'reviewCount', 'ratingCount',
        'review', 'Review', 'bestRating',
      ]) {
        expect(raw).not.toContain(banned);
      }
    }
  });

  it('keeps sample businesses out of the structured data', async () => {
    await addOperator({
      id: DEMO_OPERATOR_ID, name: 'Demo Detailing', trade: 'mobile car wash and detailing',
      place: SHERMAN_OAKS, priceCents: 8900,
    });
    const page = await neighbourhoodPage(env, 'sherman-oaks');
    // Visible on the page, labelled — but never marked up as real inventory.
    expect(page!).toContain('Demo Detailing');
    expect(JSON.stringify(graphOf(page!))).not.toContain('Demo Detailing');
  });
});

describe('the sitemap', () => {
  it('lists a real neighbourhood and its live trade combination', async () => {
    const xml = await sitemapXml(env, 'https://roundtheway.app/');
    expect(xml).toContain('<loc>https://roundtheway.app/near/sherman-oaks</loc>');
    expect(xml).toContain(
      '<loc>https://roundtheway.app/near/sherman-oaks/mobile-car-wash-and-detailing</loc>');
    expect(xml).toContain('<lastmod>');
  });

  it('omits a combination with nothing open', async () => {
    const xml = await sitemapXml(env, 'https://roundtheway.app');
    expect(xml).toContain('/near/sherman-oaks');
    expect(xml).not.toContain('/near/sherman-oaks/junk-removal');
  });

  it('does not submit sample inventory to a search engine', async () => {
    await addOperator({
      id: DEMO_OPERATOR_ID, name: 'Demo Bins', trade: 'bin cleaning',
      place: SHERMAN_OAKS,
    });
    const xml = await sitemapXml(env, 'https://roundtheway.app');
    expect(xml).not.toContain('/near/sherman-oaks/bin-cleaning');
  });
});

/*
  THE SNIPPET IS THE ONE PLACE A SAMPLE CANNOT BE LABELLED.

  Every page in lib/seo.ts that prints a count of openings prints it twice: once
  in the body, where `sampleNote` stands beside it saying how many of the rows
  are seeded, and once in the meta description, which is read in a search result
  with nothing beside it at all. The prices in those descriptions were guarded
  by `cheapestReal` from the beginning and the counts were not, so on the day
  this site went live with sample data as its only inventory the front page
  advertised itself as having real appointments in it.

  These pin the counts to the same rule as the prices. They are deliberately
  about the description rather than about the body: the body counting everything
  is correct and is what the sample note exists for.
*/
describe('a count in a search snippet', () => {
  const description = (html: string): string =>
    html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? '';

  beforeEach(async () => {
    // Nothing genuine anywhere, and one seeded business with an opening — the
    // exact state of the live site on its first day.
    await env.DB.prepare(`UPDATE gaps SET status = 'dismissed'`).run();
    await addOperator({
      id: DEMO_OPERATOR_ID, name: 'Demo Detailing', trade: 'mobile car wash and detailing',
      place: SHERMAN_OAKS, priceCents: 8900,
    });
  });

  it('does not count a seeded opening on the front page', async () => {
    const html = await homePage(env);
    // The body still counts it — in the stat tiles, with the sample note under
    // them saying what the one it counted is.
    expect(html).toContain('appointment open');
    expect(html).toContain('is a sample');
    expect(description(html)).not.toMatch(/\d+ appointments open/);
    expect(description(html)).toContain('An opening appears when a job is cancelled');
  });

  it('does not count a seeded opening on a trade page', async () => {
    const html = await tradePage(env, 'mobile-car-wash-and-detailing');
    expect(html!).toContain('Demo Detailing');
    expect(description(html!)).toContain('Nothing is open right now');
  });

  it('does not count a seeded opening on a neighbourhood page', async () => {
    const html = await neighbourhoodPage(env, 'sherman-oaks');
    expect(html!).toContain('Demo Detailing');
    expect(description(html!)).not.toMatch(/\d+ appointments open/);
  });

  it('does not quote a seeded price as a listed price on a cost guide', async () => {
    const html = await costGuidePage(env, 'mobile-car-wash-and-detailing');
    // The table on the page shows it, labelled. The snippet does not claim it.
    expect(html!).toContain('$89');
    expect(description(html!)).not.toMatch(/\d+ .*prices listed/);
    expect(description(html!)).toContain('Nothing is listed in this trade');
  });
});

/*
  A COST GUIDE IS THE ONE GENERATED PAGE HERE THAT IS NOT ONLY COUNTS.

  Every other shape lib/seo.ts renders is thin without real inventory and says
  so by answering noindex. A cost guide with an entry in lib/costfacts.ts also
  carries several hundred words of hand-written explanation of what makes one
  job of that kind dearer than another, which is unique to the trade and true on
  an empty afternoon — so it is allowed to be indexed on that alone. One without
  such an entry, and with nothing listed, is the shared FAQ and the shared
  three-step band under a different heading, thirty-nine times over.

  The page and the sitemap have to decide this by one rule, because a sitemap
  offering a URL that answers noindex is counted against the whole file and a
  page answering index that the sitemap omits is reachable only by crawl.
*/
describe('an empty cost guide', () => {
  beforeEach(async () => {
    await env.DB.prepare(`UPDATE gaps SET status = 'dismissed'`).run();
  });

  it('asks to be indexed when it has written cost factors', async () => {
    expect(costsFor('house cleaning')).not.toBeNull();
    const html = await costGuidePage(env, 'house-cleaning');
    expect(html!).toContain('<meta name="robots" content="index,follow');
    expect(html!).toContain('What house cleaning prices depend on');
  });

  it('refuses to be indexed when it has neither prices nor cost factors', async () => {
    // The three pop-up retail trades are the only ones with no costfacts entry.
    expect(costsFor('mobile bookstore')).toBeNull();
    const html = await costGuidePage(env, 'mobile-bookstore');
    expect(html!).toContain('<meta name="robots" content="noindex');
  });

  it('is offered in the sitemap on exactly the test the page indexes on', async () => {
    const xml = await sitemapXml(env, 'https://roundtheway.app');
    expect(xml).toContain('<loc>https://roundtheway.app/cost/house-cleaning</loc>');
    expect(xml).not.toContain('/cost/mobile-bookstore');
    // Its trade page is a different question and has nothing open in it.
    expect(xml).not.toContain('/s/house-cleaning');
  });

  it('carries no lastmod rather than a timestamp that moves on every fetch', async () => {
    // Nobody has ever signed up in this trade, so there is no row to read a
    // modification time off and `now()` would restamp it on every crawl.
    const xml = await sitemapXml(env, 'https://roundtheway.app');
    const entry = xml.split('<url>').find((u) => u.includes('/cost/window-cleaning'))!;
    expect(entry).toBeDefined();
    expect(entry).not.toContain('<lastmod>');
    // And a URL that does have a row behind it still carries one.
    expect(xml).toContain('<lastmod>');
  });
});

/*
  THE BRAND MARKUP HAS TO OUTLIVE REACT MOUNTING OVER THE PAGE.

  `intoShell` puts the server's JSON-LD inside #root, where React deletes it on
  mount, and that is right for every node the React page emits again. The
  Organization and WebSite/SearchAction nodes are emitted in homePage and
  nowhere else in the repository, and web/src/pages/Discover.tsx emits no
  structured data at all — so on the front page that arrangement was not a
  handover, it was a deletion, and a crawler that runs JavaScript found no
  Organization on the site's own address.
*/
describe('the front page graph, spliced into the SPA shell', () => {
  const SHELL = '<!doctype html><html lang="en"><head><title>x</title>'
    + '<meta name="description" content="y">'
    + '<meta property="og:title" content="z">'
    + '<meta name="twitter:title" content="z">'
    + '</head><body><div id="root"></div></body></html>';

  it('puts the Organization and WebSite nodes in the head, not inside #root', async () => {
    const html = await homePage(env, { shell: SHELL });
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head).toContain('"@type":"Organization"');
    expect(head).toContain('"@type":"WebSite"');
    expect(head).toContain('"@type":"SearchAction"');
    // One copy of each, so a rendering crawler is not shown two answers.
    expect(html.match(/"@type":"Organization"/g)).toHaveLength(1);
    expect(html.match(/"@type":"WebSite"/g)).toHaveLength(1);
  });

  it('still strips the shell head tags the Worker replaces', async () => {
    const html = await homePage(env, { shell: SHELL });
    expect(html).not.toContain('<title>x</title>');
    expect(html).not.toContain('content="y"');
    expect(html).not.toContain('content="z"');
    expect(html.match(/<title>/g)).toHaveLength(1);
  });
});

describe('robots.txt', () => {
  const txt = robotsTxt('https://roundtheway.app/');

  it('keeps crawlers out of the private surfaces', () => {
    for (const path of ['/c/', '/a/', '/o/', '/api/', '/app/', '/book/']) {
      expect(txt).toContain(`Disallow: ${path}`);
    }
  });

  /*
    /account is "Your bookings" in the header nav of every server-rendered page,
    which makes it the most followed internal link in lib/seo.ts — and it is not
    a page the Worker renders, so the request falls through to the SPA shell and
    a crawler gets an empty #root above a wall it cannot pass. The rest of that
    wall is under /app/ and was already out; this one does not share the prefix.
  */
  it('keeps them off one customer\'s own bookings', () => {
    expect(txt).toContain('Disallow: /account');
  });

  it('lets them into the discovery pages and names the sitemap', () => {
    expect(txt).toContain('Allow: /near/');
    expect(txt).toContain('Sitemap: https://roundtheway.app/sitemap.xml');
  });
});
