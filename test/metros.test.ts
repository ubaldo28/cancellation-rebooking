import { describe, expect, it, beforeEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import type { Env } from '../src/types';
import {
  ALL_METRO_AREAS, DEFAULT_METRO, METROS, metroAreaBySlug, metroBySlug, metroForPlace,
  metroPath, publicMetro,
} from '../src/lib/metros';
import { seedDemo } from '../src/lib/demo';
import { geocode } from '../src/lib/geo';
import { mapData } from '../src/lib/public';
import {
  areaIndexPage, metroPage, neighbourhoodPage, robotsTxt, sitemapXml,
} from '../src/lib/seo';

/**
 * Slotfill serves more than one place now, and this file is what holds every
 * page to describing the place it is actually about.
 *
 * The failure this guards against is not a crash. It is a Santa Maria page
 * that reads perfectly and says Los Angeles somewhere in it — a breadcrumb, a
 * title, a "the whole city" link — which is what the old single METRO constant
 * produced everywhere the moment a second metro existed. So the assertions
 * below are mostly about what a page must NOT say.
 */

const LOS_ANGELES = metroBySlug('los-angeles')!;
const SANTA_MARIA = metroBySlug('santa-maria')!;

let env: Env;

describe('the metro records', () => {
  it('names two metros, each with a slug that is its own path', () => {
    expect(METROS.length).toBeGreaterThanOrEqual(2);
    for (const m of METROS) {
      expect(m.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(metroPath(m)).toBe(`/${m.slug}`);
      expect(m.name.trim()).not.toBe('');
      expect(m.state.trim()).not.toBe('');
      expect(m.timezone).toMatch(/^[A-Za-z_]+\/[A-Za-z_]+$/);
      expect(m.areas.length).toBeGreaterThan(0);
      expect(m.geography.length).toBeGreaterThan(0);
    }
  });

  it('gives every neighbourhood a unique slug across the whole list', () => {
    // The slug is service_areas.place_slug, which is what /near/<x> is keyed
    // on. Two metros claiming one slug would make one neighbourhood page lead
    // up to whichever metro happened to be found first.
    const slugs = ALL_METRO_AREAS.map((a) => a.slug);
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

  it('places a listed neighbourhood by name and an unlisted one by distance', () => {
    expect(metroForPlace('orcutt').slug).toBe('santa-maria');
    expect(metroForPlace('sherman-oaks').slug).toBe('los-angeles');

    // A real operator's own service area, in no metro record. Coordinates are
    // all there is to go on, and the nearest metro centre is the answer.
    expect(metroForPlace('somebodys-own-patch', { lat: 34.94, lng: -120.44 }).slug)
      .toBe('santa-maria');
    expect(metroForPlace('somebodys-own-patch', { lat: 34.19, lng: -118.45 }).slug)
      .toBe('los-angeles');

    // Nothing to go on at all falls back rather than throwing.
    expect(metroForPlace('nowhere-at-all').slug).toBe(DEFAULT_METRO.slug);
  });

  it('looks a neighbourhood up by slug in either metro', () => {
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

describe('the pages, once there are two metros', () => {
  beforeEach(async () => {
    env = makeEnv(ALL_MIGRATIONS) as unknown as Env;
    await seedDemo(env);
  });

  it('renders a Santa Maria page that never mentions Los Angeles', async () => {
    const page = await metroPage(env, SANTA_MARIA);
    expect(page).toContain('<title>Mobile services in Santa Maria, California | Slotfill</title>');
    expect(page).toContain('<h1>Mobile services in Santa Maria, California');
    expect(page).toContain('href="/near/orcutt"');

    // The body only. The footer directory is site chrome and links to every
    // metro on purpose, so a visitor is never stranded in a quiet one.
    const body = page.slice(page.indexOf('<main'), page.indexOf('</main>'));
    expect(body).not.toContain('Los Angeles');
    expect(body).not.toContain('Sherman Oaks');
    expect(body).not.toContain('/near/burbank');
  });

  it('still renders a Los Angeles page that says Los Angeles', async () => {
    const page = await metroPage(env, LOS_ANGELES);
    expect(page).toContain('<title>Mobile services in Los Angeles, California | Slotfill</title>');
    expect(page).toContain('<h1>Mobile services in Los Angeles, California');
    expect(page).toContain('href="/near/sherman-oaks"');

    const body = page.slice(page.indexOf('<main'), page.indexOf('</main>'));
    expect(body).not.toContain('Santa Maria');
    expect(body).not.toContain('/near/orcutt');
  });

  it('does not copy one metro\'s geography onto the other', async () => {
    const sm = await metroPage(env, SANTA_MARIA);
    const la = await metroPage(env, LOS_ANGELES);
    expect(la).toContain('Mediterranean climate');
    expect(sm).not.toContain('Mediterranean climate');
    expect(sm).toContain('Marine air');
    expect(la).not.toContain('Marine air');
  });

  it('counts each metro from its own neighbourhoods and nobody else\'s', async () => {
    const { areas, slots } = await mapData(env, null);
    const smAreas = new Set(areas.filter((a) => a.metro === 'santa-maria').map((a) => a.slug));
    const laAreas = new Set(areas.filter((a) => a.metro === 'los-angeles').map((a) => a.slug));
    expect(smAreas.size).toBeGreaterThan(0);
    expect(laAreas.size).toBeGreaterThan(0);

    // The figure the page prints is the count of distinct openings in that
    // metro's areas, so recomputing it here from the same read is the only
    // check worth making: a hardcoded number would assert the one thing that
    // must never be true of these pages.
    const distinct = (keep: Set<string>) =>
      new Set(slots.filter((s) => keep.has(s.area_slug)).map((s) => s.gap_id)).size;

    const sm = await metroPage(env, SANTA_MARIA);
    const la = await metroPage(env, LOS_ANGELES);
    expect(sm).toContain(`<b>${distinct(smAreas)}</b><span>appointments open</span>`);
    expect(la).toContain(`<b>${distinct(laAreas)}</b><span>appointments open</span>`);
    expect(distinct(smAreas)).toBeLessThan(distinct(smAreas) + distinct(laAreas));
  });

  it('leads a Santa Maria neighbourhood up to Santa Maria, not to Los Angeles',
    async () => {
      const page = (await neighbourhoodPage(env, 'orcutt'))!;
      expect(page).toContain('<h1>Open appointments in Orcutt, California</h1>');
      const body = page.slice(page.indexOf('<main'), page.indexOf('</main>'));
      expect(body).toContain('href="/santa-maria"');
      expect(body).not.toContain('href="/los-angeles"');
      expect(body).not.toContain('Los Angeles');
    });

  it('leads a Valley neighbourhood up to Los Angeles, as it always did', async () => {
    const page = (await neighbourhoodPage(env, 'sherman-oaks'))!;
    const body = page.slice(page.indexOf('<main'), page.indexOf('</main>'));
    expect(body).toContain('href="/los-angeles"');
    expect(body).not.toContain('href="/santa-maria"');
    expect(body).not.toContain('Santa Maria');
  });

  it('groups the neighbourhood index by metro and names both', async () => {
    const page = await areaIndexPage(env);
    expect(page).toContain('<title>Every neighbourhood — Los Angeles and Santa Maria | Slotfill</title>');
    expect(page).toContain('href="/los-angeles"');
    expect(page).toContain('href="/santa-maria"');
    expect(page).toContain('href="/near/orcutt"');
    expect(page).toContain('href="/near/sherman-oaks"');
    // The breadcrumb no longer runs through one metro, because this page is
    // about both of them.
    expect(page).not.toContain('› <a href="/los-angeles">Los Angeles</a> › Neighbourhoods');
  });

  it('submits and allows every metro page, not just the first', async () => {
    const xml = await sitemapXml(env, 'https://gap.test');
    for (const m of METROS) expect(xml).toContain(`<loc>https://gap.test${metroPath(m)}</loc>`);

    const txt = robotsTxt('https://gap.test');
    for (const m of METROS) expect(txt).toContain(`Allow: ${metroPath(m)}`);
  });
});

describe('postcode search in the second metro', () => {
  beforeEach(async () => {
    env = makeEnv(ALL_MIGRATIONS) as unknown as Env;
    await seedDemo(env);
  });

  /**
   * The front page's postcode box geocodes against postal_codes, and in a
   * database that has never loaded the GeoNames extract the demo seed is the
   * only thing that puts rows in it. It used to write one row per covered
   * neighbourhood, so a Santa Maria visitor got "we could not place that"
   * while the Santa Maria pages worked perfectly.
   */
  it('places every postcode of every metro area, covered or not', async () => {
    for (const a of ALL_METRO_AREAS) {
      for (const zip of a.zips) {
        const hit = await geocode(env, null, zip, 'US');
        expect(hit, `${zip} (${a.name}) did not resolve`).not.toBeNull();
        expect(hit!.source).toBe('table');
      }
    }
  });

  it('places a Santa Maria postcode in the Santa Maria valley', async () => {
    const hit = await geocode(env, null, '93455', 'US');
    expect(hit).not.toBeNull();
    // Within the valley rather than at an exact point: these are neighbourhood
    // centroids, and asserting a coordinate would be asserting the fixture.
    expect(hit!.lat).toBeGreaterThan(34.7);
    expect(hit!.lat).toBeLessThan(35.1);
    expect(hit!.lng).toBeLessThan(-120.2);
    expect(hit!.lng).toBeGreaterThan(-120.7);
  });
});

describe('the sample businesses in Santa Maria', () => {
  beforeEach(async () => {
    env = makeEnv(ALL_MIGRATIONS) as unknown as Env;
    await seedDemo(env);
  });

  it('gives the Santa Maria page something to show, in more than one trade',
    async () => {
      const { areas, slots } = await mapData(env, null);
      const sm = areas.filter((a) => a.metro === 'santa-maria');
      expect(sm.length).toBeGreaterThan(0);

      const here = new Set(sm.map((a) => a.slug));
      const trades = new Set(
        slots.filter((s) => here.has(s.area_slug)).map((s) => s.trade).filter(Boolean));
      expect(trades.size).toBeGreaterThan(1);
    });

  it('flags every sample opening as a sample', async () => {
    const { areas, slots } = await mapData(env, null);
    const here = new Set(areas.filter((a) => a.metro === 'santa-maria').map((a) => a.slug));
    const mine = slots.filter((s) => here.has(s.area_slug));
    expect(mine.length).toBeGreaterThan(0);
    for (const s of mine) expect(s.is_sample).toBe(true);
  });

  it('keeps every rating cache equal to the reviews the same seed wrote', async () => {
    // rating_sum and rating_count are a cache of the reviews table. A sample
    // business showing a score its own reviews do not add up to is exactly
    // what a visitor checking whether this site is real would notice.
    const rows = await env.DB.prepare(
      `SELECT o.id, o.rating_sum, o.rating_count,
              COALESCE(SUM(r.rating), 0) AS real_sum,
              COUNT(r.id) AS real_count
         FROM operators o
         LEFT JOIN reviews r ON r.operator_id = o.id
        WHERE o.id LIKE 'demo-operator-sm-%'
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
    const rows = await env.DB.prepare(
      `SELECT operator_id, COUNT(*) AS n FROM service_areas
        WHERE operator_id LIKE 'demo-operator-sm-%' GROUP BY operator_id`,
    ).all<{ operator_id: string; n: number }>();
    expect((rows.results ?? []).length).toBeGreaterThan(0);
    for (const r of rows.results ?? []) expect(r.n).toBeLessThanOrEqual(5);
  });
});
