import { describe, expect, it, beforeEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import type { Env } from '../src/types';
import {
  neighbourhoodPage, robotsTxt, sitemapXml, tradeFromSlug, tradeInPlacePage, tradeSlug,
} from '../src/lib/seo';
import { TRADE_RULES } from '../src/lib/credentials';
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
    `INSERT INTO operators (id,email,business_name,trade,timezone,country,currency,language,
       location_mode,fill_model,sms_mode,max_detour_seconds,min_gap_seconds,buffer_seconds,
       offer_ttl_seconds,offers_per_wave,min_notice_seconds,reoffer_cooldown_seconds,
       discount_percent,plan,accept_public_bookings,deposit_cents,created_at,updated_at)
     VALUES (?,?,?,?, 'America/Los_Angeles','US','USD','en','mobile','both','device',
       900,3600,900,5400,3,3600,604800,0,'active',1,1000,?,?)`,
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

  it('asks to be indexed, unlike every other server-rendered page here', async () => {
    const page = await neighbourhoodPage(env, 'sherman-oaks');
    expect(page!).toContain('<meta name="robots" content="index,follow');
    expect(page!).not.toContain('noindex,nofollow');
    expect(page!).toContain('<link rel="canonical"');
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
    expect(page!).toContain('Car wash and detailing across Los Angeles');
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
    expect(offer.seller['@type']).toBe('LocalBusiness');
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
    const xml = await sitemapXml(env, 'https://app.slotfill.workers.dev/');
    expect(xml).toContain('<loc>https://app.slotfill.workers.dev/near/sherman-oaks</loc>');
    expect(xml).toContain(
      '<loc>https://app.slotfill.workers.dev/near/sherman-oaks/mobile-car-wash-and-detailing</loc>');
    expect(xml).toContain('<lastmod>');
  });

  it('omits a combination with nothing open', async () => {
    const xml = await sitemapXml(env, 'https://app.slotfill.workers.dev');
    expect(xml).toContain('/near/sherman-oaks');
    expect(xml).not.toContain('/near/sherman-oaks/junk-removal');
  });

  it('does not submit sample inventory to a search engine', async () => {
    await addOperator({
      id: DEMO_OPERATOR_ID, name: 'Demo Bins', trade: 'bin cleaning',
      place: SHERMAN_OAKS,
    });
    const xml = await sitemapXml(env, 'https://app.slotfill.workers.dev');
    expect(xml).not.toContain('/near/sherman-oaks/bin-cleaning');
  });
});

describe('robots.txt', () => {
  const txt = robotsTxt('https://app.slotfill.workers.dev/');

  it('keeps crawlers out of the private surfaces', () => {
    for (const path of ['/c/', '/a/', '/o/', '/api/', '/app/', '/book/']) {
      expect(txt).toContain(`Disallow: ${path}`);
    }
  });

  it('lets them into the discovery pages and names the sitemap', () => {
    expect(txt).toContain('Allow: /near/');
    expect(txt).toContain('Sitemap: https://app.slotfill.workers.dev/sitemap.xml');
  });
});
