import { beforeEach, describe, expect, it } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import type { Env } from '../src/types';
import { costGuidePage, tradePage } from '../src/lib/seo';
import { newId, now } from '../src/lib/util';

/**
 * The blocks the trade page and the cost guide grew to match the reference
 * marketplace's own, and the lines they are not allowed to cross while they do
 * it.
 *
 * The reference builds its cost guides on a national survey: tables of price
 * by bedroom, by square foot, by service type, a national average and a "most
 * common price". We have none of that data. What these pages have instead is
 * every price every business here is asking right now, counted at the moment
 * the page is built — so the assertions below come in two halves. One half
 * checks the new sections exist and are wired to each other; the other half is
 * a standing refusal, and it is the half that matters. If somebody ever adds a
 * survey figure, a rounded "typical" price or a fabricated last-updated date
 * to either page, one of these fails.
 *
 * Everything is checked against rows this file inserted. A test asserting a
 * hardcoded figure would be asserting the one property these pages must never
 * have.
 */

let env: Env;
const t = () => now();

const SHERMAN_OAKS = { name: 'Sherman Oaks', slug: 'sherman-oaks', lat: 34.15, lng: -118.449 };
const ENCINO = { name: 'Encino', slug: 'encino', lat: 34.159, lng: -118.501 };

const DETAILING = 'mobile car wash and detailing';
/** A second trade in the same category, so "related cost information" has something in it. */
const OIL = 'mobile oil change and mechanics';

async function addOperator(opts: {
  id: string; name: string; trade: string;
  place: { name: string; slug: string; lat: number; lng: number };
  priceCents?: number; serviceName?: string; open?: boolean;
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
       900,3600,900,5400,3,3600,604800,0,'active',1,1000,NULL,0,NULL,7,2,4,?,?)`,
  ).bind(opts.id, `${opts.id}@x.com`, opts.name, opts.trade, n, n).run();

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

beforeEach(async () => {
  env = makeEnv(ALL_MIGRATIONS) as unknown as Env;
  // Three detailing listings, which is ENOUGH for a range, in two places.
  await addOperator({ id: 'op1', name: 'Valley Detailing', trade: DETAILING,
    place: SHERMAN_OAKS });
  await addOperator({ id: 'op2', name: 'Encino Auto Care', trade: DETAILING,
    place: ENCINO, priceCents: 12900, serviceName: 'Wash and wax' });
  await addOperator({ id: 'op3', name: 'Oaks Detail Co', trade: DETAILING,
    place: SHERMAN_OAKS, priceCents: 15900 });
  // A neighbour in the same category, so the related-guide block has a link
  // with a live count in it, and one with nothing.
  await addOperator({ id: 'op4', name: 'Valley Oil', trade: OIL, place: ENCINO,
    priceCents: 8900, serviceName: 'Oil and filter' });
});

/**
 * The markup is written with line breaks in it, so every assertion below reads
 * the page with its whitespace flattened. A test that fails because a sentence
 * happens to wrap is a test that will be deleted rather than fixed.
 */
const flat = (s: string) => s.replace(/\s+/g, ' ');

/** Every id a contents list points at has to be an id the page carries. */
function danglingAnchors(html: string): string[] {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!));
  return [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]!).filter((x) => !ids.has(x));
}

describe('the trade page’s onward blocks', () => {
  it('opens with a counted line that names what is behind it', async () => {
    const page = flat((await tradePage(env, DETAILING))!);
    // Three openings from three businesses, all inserted above. The figure is
    // never written down anywhere; it is counted from the rows rendered below.
    expect(page).toContain('3 open appointments, from 3 businesses');
  });

  it('offers the cost guides of the neighbouring trades, with what each has listed',
    async () => {
      const page = flat((await tradePage(env, DETAILING))!);
      expect(page).toContain('Related cost information');
      expect(page).toContain('What oil change and mechanics costs');
      expect(page).toContain('1 price listed');
      // The trades in this category with nothing listed are offered too, and
      // are labelled as having nothing rather than left to look live.
      expect(page).toContain('nothing listed today');
      expect(page).toContain('href="/cost"');
    });

  it('counts what is open instead of calling anything popular or trending', async () => {
    const page = flat((await tradePage(env, DETAILING))!);
    expect(page).toContain('Most appointments open right now');
    expect(page).toContain('not a measure of what is popular');
    expect(page).toContain('href="/s/mobile%20oil%20change%20and%20mechanics"');
    for (const word of ['Trending', 'trending', 'Popular services', 'most booked']) {
      expect(page).not.toContain(word);
    }
  });

  it('says nothing is open rather than borrowing another trade’s numbers', async () => {
    const page = flat((await tradePage(env, 'junk removal'))!);
    expect(page).toContain('Nothing open right now');
    // The blocks that count other trades are still there — they are about the
    // site, not about this trade — but nothing in them is attributed here.
    expect(page).not.toContain('open appointments, from');
  });
});

describe('the cost guide’s new sections', () => {
  it('pins a banner built from the counted range, and only once there is one',
    async () => {
      const page = flat((await costGuidePage(env, DETAILING))!);
      expect(page).toContain('class="pricebar"');
      expect(page).toContain('$99.00 – $159.00');
      expect(page).toContain('middle $129.00');

      // One listing is not a range, so there is no banner to pin: the page
      // says how thin the evidence is instead.
      const thin = flat((await costGuidePage(env, OIL))!);
      expect(thin).not.toContain('class="pricebar"');
      expect(thin).toContain('Too few listings to give a range');
    });

  it('prints no date and no byline, and says why', async () => {
    const page = flat((await costGuidePage(env, DETAILING))!);
    expect(page).toContain('no author and no last-updated date to print');
    for (const claim of ['Last updated', 'Written by', 'Reviewed by']) {
      expect(page).not.toContain(claim);
    }
  });

  it('carries a contents list whose every entry is a heading on the page', async () => {
    const page = flat((await costGuidePage(env, DETAILING))!);
    expect(page).toContain('On this page');
    expect(danglingAnchors(page)).toEqual([]);
    for (const id of ['cg-range', 'cg-svc', 'cg-why', 'cg-hire', 'cg-faq', 'cg-near',
      'cg-how', 'cg-guides']) {
      expect(page).toContain(`id="${id}"`);
    }
  });

  it('tells somebody how to hire without vouching for anybody', async () => {
    const page = flat((await costGuidePage(env, DETAILING))!);
    expect(page).toContain('How to hire car wash and detailing on Slotfill');
    expect(page).toContain("Nothing on a business's page is verified by us");
    for (const claim of ['vetted', 'screened', 'guaranteed', 'trusted pros']) {
      expect(page).not.toContain(claim);
    }
  });

  it('sends the reader to the trade page and to the neighbourhoods it is open in',
    async () => {
      const page = flat((await costGuidePage(env, DETAILING))!);
      expect(page).toContain('Find car wash and detailing near you');
      expect(page).toContain('href="/s/mobile%20car%20wash%20and%20detailing"');
      expect(page).toContain('href="/near/sherman-oaks/mobile-car-wash-and-detailing"');
      expect(page).toContain('href="/near/encino/mobile-car-wash-and-detailing"');
      // Two openings in Sherman Oaks, one in Encino — counted, not written.
      expect(page).toContain('2 open');
    });

  it('offers the other guides in the category and the hub above them', async () => {
    const page = flat((await costGuidePage(env, DETAILING))!);
    expect(page).toContain('Other cost guides');
    expect(page).toContain('What oil change and mechanics costs');
    expect(page).toContain('href="/cost"');
  });

  it('leaves the neighbourhood block out when there is nowhere to send anybody',
    async () => {
      const page = flat((await costGuidePage(env, 'junk removal'))!);
      expect(page).toContain('No prices listed for junk removal today');
      expect(page).not.toContain('The neighbourhood it is open in');
      expect(page).not.toContain('/near/sherman-oaks/junk-removal');
    });
});

describe('the survey we do not have', () => {
  it('quotes no average, no typical price and no per-anything table', async () => {
    for (const page of [flat((await costGuidePage(env, DETAILING))!),
      flat((await tradePage(env, DETAILING))!)]) {
      for (const banned of ['average cost', 'typical cost', 'expect to pay',
        'most common price', 'on average', 'per square foot', 'per bedroom',
        'per bathroom', 'hourly rate', 'national average of']) {
        expect(page.toLowerCase()).not.toContain(banned);
      }
    }

    // And the refusal itself is still on the cost guide, in the words it has
    // always used. It is the only reason the figures above it are allowed to
    // exist, and every new section on that page was written around it.
    const guide = flat((await costGuidePage(env, DETAILING))!);
    expect(guide).toContain('They are not a national average and they are not a survey');
    expect(guide).toContain('not an average of the trade');
  });
});
