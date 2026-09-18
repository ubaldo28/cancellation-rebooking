import { describe, expect, it, beforeEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import worker from '../src/index';
import type { Env } from '../src/types';
import {
  ALL_METRO_AREAS, DEFAULT_METRO, METROS, METROS_INCLUDING_HIDDEN, isHiddenPlace,
  metroAreaBySlug, metroBySlug, metroForPlace, metroPath, publicMetro, type Metro,
} from '../src/lib/metros';
import { seedDemo } from '../src/lib/demo';
import { geocode } from '../src/lib/geo';
import { mapData } from '../src/lib/public';
import { newId, now } from '../src/lib/util';
import {
  areaIndexPage, metroPage, neighbourhoodPage, robotsTxt, sitemapXml,
} from '../src/lib/seo';

/**
 * Round The Way has records for more than one place, and this file holds two
 * separate promises about them.
 *
 * THE FIRST is the one this file was written for: every page describes the
 * place it is actually about. The failure it guards against is not a crash but
 * a Santa Maria page that reads perfectly and says Los Angeles somewhere in it
 * — a breadcrumb, a title, a "the whole city" link — which is what the old
 * single `METRO = 'Los Angeles'` constant produced everywhere the moment a
 * second metro existed. So most of the assertions below are about what a page
 * must NOT say.
 *
 * THE SECOND arrived with `Metro.live`. Santa Maria is written, complete and
 * switched off: the site is being tested in Los Angeles only, the front page
 * says so, and every other surface has to agree with the front page. Hidden
 * has to mean hidden — no page, no sitemap entry, no neighbourhood in /near,
 * no postcode, no sample business — and the last section here is what fails if
 * any one of those leaks back.
 *
 * The two promises pull in opposite directions and both are real, so both are
 * tested. Santa Maria is off the site AND the machinery that will serve it on
 * the day it is switched back on still works, which is the whole reason the
 * record was kept rather than deleted.
 */

/**
 * A metro record by slug, live or hidden.
 *
 * `metroBySlug` cannot be used for the hidden one — it reads METROS and
 * answers null for anything not open, which is exactly what it is for. And the
 * hidden record must not be reached by index either: `ALL_METROS[1]` would
 * still typecheck, still pass today, and would silently start testing a
 * different city the day a third place is inserted above it.
 */
function record(slug: string): Metro {
  const m = METROS_INCLUDING_HIDDEN.find((x) => x.slug === slug);
  if (!m) throw new Error(`no metro record for '${slug}' in lib/metros.ts`);
  return m;
}

const LOS_ANGELES = record('los-angeles');
const SANTA_MARIA = record('santa-maria');

/** Every neighbourhood of a metro that is written down but not open. */
const HIDDEN_AREAS = METROS_INCLUDING_HIDDEN
  .filter((m) => !m.live)
  .flatMap((m) => m.areas.map((a) => ({ ...a, metro: m })));

/**
 * The postcodes only a hidden metro claims.
 *
 * Filtered against the live areas rather than assumed disjoint: postcodes are
 * not exclusive to a metro in principle, and a code some live neighbourhood
 * also lists must go on resolving. Today nothing overlaps — the Valley is
 * 90xxx/91xxx and the Santa Maria Valley is 934xx — so this is every hidden
 * code, and it stays correct if that ever stops being true.
 */
const HIDDEN_ONLY_ZIPS = [...new Set(HIDDEN_AREAS.flatMap((a) => a.zips))]
  .filter((z) => !ALL_METRO_AREAS.some((a) => a.zips.includes(z)));

const BASE = 'https://gap.test';

let env: Env;

/** The Worker answering a URL the way a visitor's browser asks for it. */
const get = (path: string) => worker.fetch(new Request(`${BASE}${path}`), env);

/**
 * One GENUINE business, with one genuine opening, in one metro.
 *
 * `seedDemo` creates sample businesses and nothing else, and a sample is not
 * inventory. The sitemap has always excluded sample-only trades and sample-only
 * trade × place squares; it now excludes sample-only METROS and neighbourhoods
 * on exactly the same test, because those pages now answer `noindex` under the
 * same condition and a sitemap that submits a URL answering noindex is a file
 * contradicting itself.
 *
 * So the two sitemap tests below cannot assert a metro page out of a
 * demo-seeded database any more — a demo-seeded site genuinely has nothing
 * worth submitting — and they put a real business in each live metro first
 * instead. That is a truer fixture as well as a working one: it is what the
 * production site looks like the day somebody signs up.
 */
async function addRealBusiness(metro: Metro, n: number): Promise<void> {
  const area = metro.areas[0]!;
  const id = `real-${metro.slug}-${n}`;
  const at = now();
  await env.DB.prepare(
    // stripe_payouts_enabled = 1 is load-bearing, not boilerplate: a business
    // must have somewhere to be paid before its work can be sold, so slotsNear
    // leaves an opening for an operator without it off the public list. Drop it
    // and every metro page here has nothing open on it.
    `INSERT INTO operators (id,email,business_name,trade,timezone,country,currency,language,
       location_mode,fill_model,sms_mode,max_detour_seconds,min_gap_seconds,buffer_seconds,
       offer_ttl_seconds,offers_per_wave,min_notice_seconds,reoffer_cooldown_seconds,
       discount_percent,plan,accept_public_bookings,deposit_cents,created_at,updated_at,
       stripe_payouts_enabled)
     VALUES (?,?,?,'window cleaning','America/Los_Angeles','US','USD','en','mobile','both',
       'device',900,3600,900,5400,3,3600,604800,0,'active',1,1000,?,?,1)`,
  ).bind(id, `${id}@example.com`, `${area.name} Window Co`, at, at).run();

  await env.DB.prepare(
    `INSERT INTO services (id,operator_id,name,duration_seconds,price_cents,cadence_days,
       created_at,updated_at) VALUES (?,?,'Whole house',7200,11900,28,?,?)`,
  ).bind(`sv-${id}`, id, at, at).run();

  await env.DB.prepare(
    `INSERT INTO service_areas (id,operator_id,name,slug,place_slug,lat,lng,radius_meters,
       created_at,updated_at) VALUES (?,?,?,?,?,?,?,8000,?,?)`,
  ).bind(newId(), id, area.name, `${area.slug}-${id}`, area.slug,
    area.lat, area.lng, at, at).run();

  const start = at + 4 * 3600;
  await env.DB.prepare(
    `INSERT INTO gaps (id,operator_id,starts_at,ends_at,prev_lat,prev_lng,next_lat,next_lng,
       baseline_drive_seconds,is_mobile,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,180,1,'open',?,?)`,
  ).bind(newId(), id, start, start + 5 * 3600,
    area.lat, area.lng, area.lat, area.lng, at, at).run();
}

/** A real business in every live metro, so every live metro has a page worth
 *  submitting. */
const seedRealBusinesses = () =>
  Promise.all(METROS.map((m, i) => addRealBusiness(m, i)));

describe('the metro records', () => {
  it('gives every record, live or hidden, a slug that is its own path', () => {
    // Both records are checked, not just the live one. A hidden metro is kept
    // in the file precisely so that it can be switched on without being
    // rewritten, and a record that has quietly rotted while it was off the
    // site — a lost postcode, an empty geography array — would be discovered
    // on the day it goes live, in public, rather than here.
    expect(METROS_INCLUDING_HIDDEN.length).toBeGreaterThanOrEqual(2);
    for (const m of METROS_INCLUDING_HIDDEN) {
      expect(m.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(metroPath(m)).toBe(`/${m.slug}`);
      expect(m.name.trim()).not.toBe('');
      expect(m.state.trim()).not.toBe('');
      expect(m.timezone).toMatch(/^[A-Za-z_]+\/[A-Za-z_]+$/);
      expect(m.areas.length).toBeGreaterThan(0);
      expect(m.geography.length).toBeGreaterThan(0);
    }
  });

  it('gives every neighbourhood a unique slug across every record', () => {
    // The slug is service_areas.place_slug, which is what /near/<x> is keyed
    // on. Two metros claiming one slug would make one neighbourhood page lead
    // up to whichever metro happened to be found first.
    //
    // Counted over the hidden records as well as the live ones, because
    // `metroAreaBySlug` searches all of them: a collision between a live
    // neighbourhood and a hidden one is a collision the demo seed would hit
    // today, not on the day the second metro opens.
    const slugs = METROS_INCLUDING_HIDDEN.flatMap((m) => m.areas.map((a) => a.slug));
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('carries real postcodes: 934xx for Santa Maria, 91xxx for the Valley', () => {
    for (const a of SANTA_MARIA.areas) {
      expect(a.zips.length).toBeGreaterThan(0);
      for (const z of a.zips) expect(z).toMatch(/^934\d\d$/);
    }
    for (const a of LOS_ANGELES.areas) {
      for (const z of a.zips) expect(z).toMatch(/^9[01]\d\d\d$/);
    }
  });

  it('names Orcutt and Tanglewood among the Santa Maria neighbourhoods', () => {
    const names = SANTA_MARIA.areas.map((a) => a.name);
    expect(names).toContain('Orcutt');
    expect(names).toContain('Tanglewood');
    expect(names).toContain('Guadalupe');
  });

  it('places a live neighbourhood by name and anything else by distance', () => {
    expect(metroForPlace('sherman-oaks').slug).toBe('los-angeles');
    for (const m of METROS) {
      for (const a of m.areas) expect(metroForPlace(a.slug).slug, a.slug).toBe(m.slug);
    }

    // A real operator's own service area, in no metro record at all.
    // Coordinates are the only thing to go on and the nearest LIVE centre is
    // the answer.
    //
    // The first point is in the Santa Maria valley and the second is in the
    // Valley, and today they give the same answer, because there is one metro
    // open to give. That is not a weaker rule than it looks: it is what stops
    // a page leading somewhere that 404s. The discrimination between two
    // centres comes back on its own the day a second metro opens and the first
    // point starts resolving to it.
    for (const at of [{ lat: 34.94, lng: -120.44 }, { lat: 34.19, lng: -118.45 }]) {
      const m = metroForPlace('somebodys-own-patch', at);
      expect(METROS.some((x) => x.slug === m.slug)).toBe(true);
    }
    expect(metroForPlace('somebodys-own-patch', { lat: 34.19, lng: -118.45 }).slug)
      .toBe('los-angeles');

    // Nothing to go on at all falls back rather than throwing.
    expect(metroForPlace('nowhere-at-all').slug).toBe(DEFAULT_METRO.slug);
    expect(DEFAULT_METRO.live).toBe(true);
  });

  it('looks a neighbourhood up by slug in a hidden metro as well as a live one', () => {
    // The one lookup that reads every record. It is a dictionary rather than a
    // listing: the demo seed holds these slugs because they are written in
    // lib/metros.ts, and answering "no such place" for one of them would make
    // it throw at module load instead of skipping a business.
    expect(metroAreaBySlug('tanglewood')?.name).toBe('Tanglewood');
    expect(metroAreaBySlug('burbank')?.name).toBe('Burbank');
    expect(metroAreaBySlug('not-a-place')).toBeNull();
  });

  it('publishes the record without any counted figure in it', () => {
    // Every number on a metro page is counted from the rows that built it, so
    // the static payload must not carry a second, staler copy of one.
    const json = JSON.stringify(publicMetro(SANTA_MARIA));
    for (const counted of ['slot_count', 'open', 'businesses', 'appointments']) {
      expect(json).not.toContain(counted);
    }
    expect(publicMetro(SANTA_MARIA).path).toBe('/santa-maria');
    expect(publicMetro(SANTA_MARIA).areas.map((a) => a.slug)).toContain('orcutt');
  });
});

describe('a metro page describes the metro it was handed, and no other', () => {
  beforeEach(async () => {
    env = makeEnv(ALL_MIGRATIONS) as unknown as Env;
    await seedDemo(env);
  });

  /**
   * The page renderer takes a Metro, so the hidden record can be handed to it
   * directly even though no route serves it. That is what keeps this half of
   * the file alive while Santa Maria is off the site.
   *
   * WHAT THIS NO LONGER ASSERTS, and why that is not a weakened test. The
   * earlier version also expected `href="/near/orcutt"` in the body: a Santa
   * Maria page lists Santa Maria's neighbourhoods. Those links are built from
   * the rows the page fetched, and a row reaches this page only if
   * `metroForPlace` maps its neighbourhood to this metro — which it cannot do
   * for a metro that is not in METROS. Seeding a Santa Maria service area here
   * does not bring the link back; it files that row under Los Angeles instead.
   * What is kept is the negative half, and that is the half that was
   * protecting the visitor: the database below is full of Valley rows, and
   * this page shows not one of them.
   */
  it('renders a Santa Maria page that never mentions Los Angeles', async () => {
    const page = await metroPage(env, SANTA_MARIA);
    expect(page).toContain('<title>Mobile services in Santa Maria, California | Round The Way</title>');
    expect(page).toContain('<h1>Mobile services in Santa Maria, California');

    // The body only. The footer directory is site chrome and links to every
    // metro on purpose, so a visitor is never stranded in a quiet one.
    const body = page.slice(page.indexOf('<main'), page.indexOf('</main>'));
    expect(body).not.toContain('Los Angeles');
    expect(body).not.toContain('Sherman Oaks');
    expect(body).not.toContain('/near/burbank');
    for (const a of LOS_ANGELES.areas) {
      expect(body, a.name).not.toContain(`/near/${a.slug}`);
    }
  });

  it('still renders a Los Angeles page that says Los Angeles', async () => {
    const page = await metroPage(env, LOS_ANGELES);
    expect(page).toContain('<title>Mobile services in Los Angeles, California | Round The Way</title>');
    expect(page).toContain('<h1>Mobile services in Los Angeles, California');
    expect(page).toContain('href="/near/sherman-oaks"');

    const body = page.slice(page.indexOf('<main'), page.indexOf('</main>'));
    expect(body).not.toContain('Santa Maria');
    expect(body).not.toContain('/near/orcutt');
  });

  it('does not copy one metro\'s geography onto the other', async () => {
    // The paragraphs come from each metro's own record rather than from a
    // template with the name substituted in, which is the point of keeping
    // them there: Los Angeles has a long dry season and Santa Maria has a
    // marine layer, and a page saying the same thing about both would be
    // inventing about one of them. True of the hidden record too — it is what
    // will be printed on the day it is switched on.
    const sm = await metroPage(env, SANTA_MARIA);
    const la = await metroPage(env, LOS_ANGELES);
    expect(la).toContain('Mediterranean climate');
    expect(sm).not.toContain('Mediterranean climate');
    expect(sm).toContain('Marine air');
    expect(la).not.toContain('Marine air');
  });

  it('counts each metro from its own neighbourhoods and nobody else\'s', async () => {
    const { areas, slots } = await mapData(env, null);
    expect(areas.length).toBeGreaterThan(0);

    // Every neighbourhood on the map belongs to a metro that is open. Written
    // as a rule over the whole payload rather than as "Los Angeles has some
    // and Santa Maria has none", because the rule is what stays true when the
    // second metro comes back and the arithmetic is what changes.
    for (const a of areas) {
      expect(METROS.some((m) => m.slug === a.metro), `${a.slug} -> ${a.metro}`).toBe(true);
    }

    // The figure the page prints is the count of distinct openings in that
    // metro's areas, so recomputing it here from the same read is the only
    // check worth making: a hardcoded number would assert the one thing that
    // must never be true of these pages.
    const distinct = (keep: Set<string>) =>
      new Set(slots.filter((s) => keep.has(s.area_slug)).map((s) => s.gap_id)).size;
    const openIn = (m: Metro) =>
      distinct(new Set(areas.filter((a) => a.metro === m.slug).map((a) => a.slug)));

    for (const m of METROS) {
      const page = await metroPage(env, m);
      expect(page, m.name).toContain(
        `<b>${openIn(m)}</b><span>appointments open</span>`);
    }

    // AND A METRO THAT IS NOT OPEN BORROWS NOBODY'S NUMBERS.
    //
    // This is where the "nobody else's" half of the name is actually earned
    // while one metro is live. Handed the Santa Maria record with a database
    // full of Valley openings, the renderer prints nought: the honest figure
    // for a metro whose neighbourhoods have nothing in them. A page that had
    // quietly counted the whole site — the failure the per-metro filter exists
    // to prevent — would print the total below instead.
    const siteWide = distinct(new Set(areas.map((a) => a.slug)));
    expect(siteWide).toBeGreaterThan(0);
    for (const m of METROS_INCLUDING_HIDDEN.filter((x) => !x.live)) {
      const page = await metroPage(env, m);
      expect(page, m.name).toContain('<b>0</b><span>appointments open</span>');
      expect(page, m.name).toContain('<b>0</b><span>businesses listed</span>');
      expect(page, m.name).not.toContain(`<b>${siteWide}</b><span>appointments open</span>`);
    }
  });

  /**
   * The other direction: a neighbourhood page leads up to its own metro.
   *
   * ITS TWIN IS GONE FOR NOW, and deliberately rather than by neglect. There
   * used to be a Santa Maria version of this — /near/orcutt leads up to
   * /santa-maria and never to /los-angeles — and it cannot be written while
   * Santa Maria is hidden. `neighbourhoodPage` takes a slug, not a Metro, and
   * resolves the metro through `metroForPlace`, which reads the live list; a
   * Santa Maria row seeded by hand here would render a page whose breadcrumb
   * says Los Angeles. What replaces it is in the last section of this file: a
   * Santa Maria neighbourhood has no page at all while the metro is off, which
   * is why nothing ever reaches that breadcrumb.
   */
  it('leads a Valley neighbourhood up to Los Angeles, as it always did', async () => {
    const page = (await neighbourhoodPage(env, 'sherman-oaks'))!;
    expect(page).toContain('<h1>Open appointments in Sherman Oaks, California</h1>');
    const body = page.slice(page.indexOf('<main'), page.indexOf('</main>'));
    expect(body).toContain('href="/los-angeles"');
    expect(body).not.toContain('href="/santa-maria"');
    expect(body).not.toContain('Santa Maria');
  });

  it('groups the neighbourhood index by metro and names every live one', async () => {
    const page = await areaIndexPage(env);
    // The heading is a metro heading rather than a flat run of
    // neighbourhoods, which is the shape that keeps Orcutt and Northridge from
    // reading as if they were down the road from each other. One live metro
    // means one such heading today, and the grouping is what has to survive
    // until there are two again.
    const title = page.slice(page.indexOf('<title>'), page.indexOf('</title>'));
    expect(title).toContain('Every neighbourhood — ');
    for (const m of METROS) {
      expect(title, m.name).toContain(m.name);
      expect(page, m.name).toContain(`<h2><a href="${metroPath(m)}">${m.name}</a>`);
    }
    // A metro that is not open is not part of the site's footprint, so it is
    // not in the phrase describing that footprint either.
    for (const m of METROS_INCLUDING_HIDDEN) {
      if (!m.live) expect(title, m.name).not.toContain(m.name);
    }
    expect(page).toContain('href="/near/sherman-oaks"');

    // The breadcrumb does not run through a metro, because this page is about
    // all of them rather than about one — and that stays true at one metro,
    // where re-hardcoding it would look harmless and be the same mistake.
    expect(page).not.toContain('› <a href="/los-angeles">Los Angeles</a> › Neighbourhoods');
  });

  it('submits and allows every live metro page, not just the first', async () => {
    // A real business in each of them first. The sitemap now leaves out a
    // metro whose every listing is a sample we seeded ourselves, on the same
    // test the page uses to answer noindex — see `addRealBusiness` above.
    await seedRealBusinesses();

    const xml = await sitemapXml(env, BASE);
    for (const m of METROS) expect(xml).toContain(`<loc>${BASE}${metroPath(m)}</loc>`);

    const txt = robotsTxt(BASE);
    for (const m of METROS) expect(txt).toContain(`Allow: ${metroPath(m)}`);
  });

  it('submits no metro page while every listing in it is a sample', async () => {
    // The other half of the rule above, and the state the live site is in
    // until somebody signs up: seedDemo creates sample businesses only, so
    // there is nothing here worth asking a search engine to fetch, and the
    // page itself says so with a noindex rather than being left out silently.
    const xml = await sitemapXml(env, BASE);
    for (const m of METROS) expect(xml, m.name).not.toContain(`<loc>${BASE}${metroPath(m)}</loc>`);
    expect(xml).not.toContain(`<loc>${BASE}/near</loc>`);
    expect(await metroPage(env, LOS_ANGELES)).toContain('content="noindex');

    // The two catalogue hubs stay: both are built from the compiled-in
    // catalogue rather than from today's openings, so both are true on an
    // empty afternoon and they are the crawl path to everything else.
    expect(xml).toContain(`<loc>${BASE}/browse</loc>`);
    expect(xml).toContain(`<loc>${BASE}/cost</loc>`);
    expect(xml).toContain(`<loc>${BASE}/</loc>`);
  });
});

describe('postcode search', () => {
  beforeEach(async () => {
    env = makeEnv(ALL_MIGRATIONS) as unknown as Env;
    await seedDemo(env);
  });

  /**
   * The front page's postcode box geocodes against postal_codes, and in a
   * database that has never loaded the GeoNames extract the demo seed is the
   * only thing that puts rows in it. It used to write one row per covered
   * neighbourhood, so a visitor in a neighbourhood no sample business happened
   * to work got "we could not place that" while the pages about that place
   * worked perfectly.
   */
  it('places every postcode of every live metro area, covered or not', async () => {
    for (const a of ALL_METRO_AREAS) {
      for (const zip of a.zips) {
        const hit = await geocode(env, null, zip, 'US');
        expect(hit, `${zip} (${a.name}) did not resolve`).not.toBeNull();
        expect(hit!.source).toBe('table');
      }
    }
  });

  it('places a postcode on a neighbourhood that actually lists it', async () => {
    // One code can cover several neighbourhoods — 91302 is Calabasas and
    // Hidden Hills — and postal_codes holds one point per code, so the first
    // area listing it wins. Which of them wins is not the guarantee; that the
    // point belongs to one of them IS, because the alternative is a visitor
    // typing their own postcode and being dropped somewhere they have never
    // heard of. Asserting a literal coordinate would only assert the fixture.
    for (const a of ALL_METRO_AREAS) {
      for (const zip of a.zips) {
        const hit = (await geocode(env, null, zip, 'US'))!;
        const listedBy = ALL_METRO_AREAS.filter((x) => x.zips.includes(zip));
        expect(
          listedBy.some((x) => Math.abs(x.lat - hit.lat) < 1e-9
            && Math.abs(x.lng - hit.lng) < 1e-9),
          `${zip} resolved to ${hit.lat},${hit.lng}, which is no area that lists it`,
        ).toBe(true);
      }
    }
  });
});

describe('the sample businesses the demo seed creates', () => {
  beforeEach(async () => {
    env = makeEnv(ALL_MIGRATIONS) as unknown as Env;
    await seedDemo(env);
  });

  it('gives the live metro page something to show, in more than one trade',
    async () => {
      // The public map is a map of a neighbourhood, not of a business. Seeded
      // with a single detailer, somebody searching their postcode for junk
      // removal was shown car detailing and left.
      const { areas, slots } = await mapData(env, null);
      const live = areas.filter((a) => METROS.some((m) => m.slug === a.metro));
      expect(live.length).toBeGreaterThan(0);

      const here = new Set(live.map((a) => a.slug));
      const trades = new Set(
        slots.filter((s) => here.has(s.area_slug)).map((s) => s.trade).filter(Boolean));
      expect(trades.size).toBeGreaterThan(1);
    });

  it('flags every sample opening as a sample', async () => {
    const { slots } = await mapData(env, null);
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) expect(s.is_sample).toBe(true);
  });

  it('keeps every rating cache equal to the reviews the same seed wrote', async () => {
    // rating_sum and rating_count are a cache of the reviews table. A sample
    // business showing a score its own reviews do not add up to is exactly
    // what a visitor checking whether this site is real would notice.
    //
    // Every demo business rather than one metro's worth: the check used to be
    // scoped to the Santa Maria ids, which now match nothing at all, and a
    // seed-wide sweep is both what survives a metro going dark and the
    // stronger assertion it should always have been.
    const rows = await env.DB.prepare(
      `SELECT o.id, o.rating_sum, o.rating_count,
              COALESCE(SUM(r.rating), 0) AS real_sum,
              COUNT(r.id) AS real_count
         FROM operators o
         LEFT JOIN reviews r ON r.operator_id = o.id
        WHERE o.id LIKE 'demo-operator%'
        GROUP BY o.id`,
    ).all<{
      id: string; rating_sum: number; rating_count: number;
      real_sum: number; real_count: number;
    }>();

    expect((rows.results ?? []).length).toBeGreaterThan(0);
    for (const r of rows.results ?? []) {
      expect(r.rating_sum, r.id).toBe(r.real_sum);
      expect(r.rating_count, r.id).toBe(r.real_count);
    }
  });

  it('claims no more than five neighbourhoods for any one van', async () => {
    // A one-van operation does not cover a whole valley, and a seed that says
    // it does makes the map read as invented.
    const rows = await env.DB.prepare(
      `SELECT operator_id, COUNT(*) AS n FROM service_areas
        WHERE operator_id LIKE 'demo-operator%' GROUP BY operator_id`,
    ).all<{ operator_id: string; n: number }>();
    expect((rows.results ?? []).length).toBeGreaterThan(0);
    for (const r of rows.results ?? []) expect(r.n).toBeLessThanOrEqual(5);
  });
});

/**
 * SANTA MARIA IS HIDDEN, AND HIDDEN HAS TO MEAN HIDDEN.
 *
 * The front page says the site is being tested in Los Angeles only. Every
 * surface below is a way that could have been contradicted without anybody
 * noticing, because each one enumerates the metro list separately: a sitemap
 * still submitting /santa-maria, a postcode box still placing 93454, a /near
 * page still offering Orcutt, a seed still filling the map with businesses in
 * a city the product is not open in. A visitor who found any of those would
 * have found a place the front page had just told them did not exist yet.
 *
 * None of this is a test of the flag itself. Each one asks the surface the
 * question a visitor would ask it, which is the only way to catch the surface
 * that was missed when the flag was added.
 */
describe('Santa Maria is hidden, and hidden means hidden', () => {
  beforeEach(async () => {
    env = makeEnv(ALL_MIGRATIONS) as unknown as Env;
    await seedDemo(env);
  });

  it('keeps the record and takes it out of the live list', () => {
    // Stated once so that the loops below — here and in every test after it —
    // cannot pass by having nothing to iterate over.
    expect(HIDDEN_AREAS.length).toBeGreaterThan(0);
    expect(SANTA_MARIA.live).toBe(false);
    expect(METROS.map((m) => m.slug)).not.toContain('santa-maria');
    expect(METROS_INCLUDING_HIDDEN.map((m) => m.slug)).toContain('santa-maria');

    // METROS is the filter and not a second hand-written list, which is what
    // makes opening or closing a place one boolean rather than two edits that
    // can disagree.
    expect(METROS.map((m) => m.slug))
      .toEqual(METROS_INCLUDING_HIDDEN.filter((m) => m.live).map((m) => m.slug));

    // The lookup a page uses to turn a URL into a metro answers null, so the
    // slug is not a page.
    expect(metroBySlug('santa-maria')).toBeNull();
    expect(metroBySlug('los-angeles')?.slug).toBe('los-angeles');

    // And the flattened area list every listing reads is live-only.
    for (const a of HIDDEN_AREAS) {
      expect(ALL_METRO_AREAS.some((x) => x.slug === a.slug), a.slug).toBe(false);
      expect(isHiddenPlace(a.slug), a.slug).toBe(true);

      // A HIDDEN METRO'S OWN NEIGHBOURHOOD IS NOT ATTRIBUTED TO IT, even
      // though the record naming it is right there in the file:
      // `metroForPlace` reads METROS. That is deliberate rather than an
      // oversight. Everything downstream of this answer renders a link, and a
      // breadcrumb pointing at /santa-maria while /santa-maria 404s would be a
      // worse page than one whose geography is off.
      expect(metroForPlace(a.slug).slug, a.slug).not.toBe(a.metro.slug);
      expect(METROS.some((m) => m.slug === metroForPlace(a.slug).slug), a.slug).toBe(true);
    }
    for (const a of LOS_ANGELES.areas) expect(isHiddenPlace(a.slug), a.slug).toBe(false);
    // A slug belonging to no metro at all is not hidden — it is simply not
    // ours, and a real operator's own service area name must not be swept up
    // by a check meant for closed cities.
    expect(isHiddenPlace('somebodys-own-patch')).toBe(false);
  });

  it('does not serve /santa-maria, while /los-angeles is served', async () => {
    // The routes are registered from METROS, so a hidden metro has no route.
    // With no ASSETS binding in a test env the Worker answers its own 404,
    // which is the shape any unrouted path gets here; what matters is that it
    // is not the metro page.
    const hidden = await get('/santa-maria');
    expect(hidden.status).toBe(404);
    expect(await hidden.text()).not.toContain('Mobile services in Santa Maria');

    const live = await get('/los-angeles');
    expect(live.status).toBe(200);
    expect(await live.text()).toContain('Mobile services in Los Angeles, California');
  });

  it('lists no Santa Maria neighbourhood on /near, or on the map', async () => {
    const res = await get('/near');
    expect(res.status).toBe(200);
    const page = await res.text();

    // The page renders — this is not passing because /near is broken.
    expect(page).toContain('href="/near/sherman-oaks"');

    expect(page).not.toContain('Santa Maria');
    expect(page).not.toContain('href="/santa-maria"');
    for (const a of HIDDEN_AREAS) {
      expect(page, a.name).not.toContain(`/near/${a.slug}`);
      expect(page, a.name).not.toContain(a.name);
    }

    // The map payload is the same geography as a set of pins, and it is what
    // the browser draws over. A neighbourhood missing from the page but
    // present here would put Orcutt back on the front page's map.
    const { areas } = await mapData(env, null);
    expect(areas.length).toBeGreaterThan(0);
    const hidden = new Set(HIDDEN_AREAS.map((a) => a.slug));
    for (const a of areas) {
      expect(hidden.has(a.slug), a.slug).toBe(false);
      expect(a.metro, a.slug).not.toBe(SANTA_MARIA.slug);
    }
  });

  it('has no page for a Santa Maria neighbourhood', async () => {
    // /near/<x> is resolved against the service_areas rows that exist, not
    // against the metro records, so this holds because the seed created no
    // business there. It is the same 404 a made-up neighbourhood gets.
    for (const a of HIDDEN_AREAS) {
      expect(await neighbourhoodPage(env, a.slug), a.slug).toBeNull();
    }
    const res = await get('/near/orcutt');
    expect(res.status).toBe(404);
    expect(await neighbourhoodPage(env, 'sherman-oaks')).not.toBeNull();
  });

  it('submits no Santa Maria URL in the sitemap and allows none in robots.txt',
    async () => {
      // A genuine Los Angeles business, so that the assertion below is about
      // Santa Maria being hidden rather than about a demo-seeded site having
      // nothing to submit. See `addRealBusiness`.
      await seedRealBusinesses();

      const xml = await sitemapXml(env, BASE);
      expect(xml).toContain(`<loc>${BASE}/los-angeles</loc>`);
      expect(xml).not.toContain('santa-maria');
      for (const a of HIDDEN_AREAS) expect(xml, a.slug).not.toContain(`/near/${a.slug}`);

      const txt = robotsTxt(BASE);
      expect(txt).toContain('Allow: /los-angeles');
      expect(txt).not.toContain('santa-maria');
    });

  it('does not recognise a Santa Maria postcode', async () => {
    // 93454 is downtown Santa Maria. Somebody typing it is told we cannot
    // place them, and that is the correct answer while the site does not
    // cover them: the alternative is placing them on a map with nothing on it
    // and letting them work out for themselves that nobody is there.
    expect(await geocode(env, null, '93454', 'US')).toBeNull();
    expect(HIDDEN_ONLY_ZIPS.length).toBeGreaterThan(0);
    for (const zip of HIDDEN_ONLY_ZIPS) {
      expect(await geocode(env, null, zip, 'US'), zip).toBeNull();
    }

    // And the live ones still resolve, so this is not passing because the
    // postcode table is empty.
    expect(await geocode(env, null, '91403', 'US')).not.toBeNull();
  });

  it('seeds no business based in a hidden metro', async () => {
    // The demo seed is what actually fills this site: every business, opening
    // and neighbourhood count a visitor sees today comes out of it. Turning
    // the metro off in lib/metros.ts is only half of taking the place off the
    // site — without the skip in seedDemo the metro page would be gone while
    // its businesses carried on appearing in the map, the feed and the
    // neighbourhood rail, which is a worse state than either.
    const ops = await env.DB.prepare(
      `SELECT id, home_lat, home_lng FROM operators`,
    ).all<{ id: string; home_lat: number | null; home_lng: number | null }>();
    expect((ops.results ?? []).length).toBeGreaterThan(0);

    const areas = await env.DB.prepare(
      `SELECT place_slug FROM service_areas`,
    ).all<{ place_slug: string | null }>();
    expect((areas.results ?? []).length).toBeGreaterThan(0);

    const hidden = new Set(HIDDEN_AREAS.map((a) => a.slug));
    for (const r of areas.results ?? []) {
      expect(hidden.has(r.place_slug ?? ''), r.place_slug ?? '(null)').toBe(false);
    }

    // Coordinates as well as slugs. A business whose van is parked in the
    // Santa Maria valley is based there whatever its service areas are
    // called, and a check that reads only the slug would miss the day
    // somebody adds a business by hand.
    for (const r of ops.results ?? []) {
      if (r.home_lat == null || r.home_lng == null) continue;
      const nearest = HIDDEN_AREAS
        .map((a) => Math.hypot(a.lat - r.home_lat!, a.lng - r.home_lng!))
        .sort((x, y) => x - y)[0]!;
      // A degree is roughly 100km here, so a quarter of one is comfortably
      // wider than any of these neighbourhoods and far short of the 240km
      // between the two valleys.
      expect(nearest, r.id).toBeGreaterThan(0.25);
    }

    // Nobody's client is in one either — clients are stamped with the
    // postcode of the neighbourhood they are in.
    const clients = await env.DB.prepare(
      `SELECT id, postcode FROM clients WHERE postcode IS NOT NULL`,
    ).all<{ id: string; postcode: string }>();
    expect((clients.results ?? []).length).toBeGreaterThan(0);
    for (const c of clients.results ?? []) {
      expect(HIDDEN_ONLY_ZIPS, c.id).not.toContain(c.postcode);
    }
  });

  it('publishes only the live metros over the public API', async () => {
    // The browser has no access to lib/metros.ts and reads this instead, so a
    // hidden metro leaking here would put it back in the React footer, in the
    // /near grouping and at its own client-rendered URL.
    const res = await get('/api/public/metros');
    expect(res.status).toBe(200);
    const body = await res.json() as { metros: Array<{ slug: string }> };
    expect(body.metros.map((m) => m.slug)).toContain('los-angeles');
    expect(body.metros.map((m) => m.slug)).not.toContain('santa-maria');
  });
});
