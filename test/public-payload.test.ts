import { readFileSync } from 'node:fs';
import { describe, expect, it, beforeEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import worker from '../src/index';
import type { Env } from '../src/types';
import { claimSlot, slotsNear } from '../src/lib/public';
import { getPublicProfile } from '../src/lib/profile';
import {
  PAY_TODAY_SHORT, browseIndexPage, costGuidePage, costIndexPage, metroPage, tradePage,
} from '../src/lib/seo';
import { newId, now } from '../src/lib/util';

/**
 * The three things a card, a profile and a cost page carry that they did not.
 *
 * Grouped in one file because they are one change: the public payload grew a
 * photograph, a service list and a working week, and every one of those is a
 * place where the wrong row would be published to a stranger. The assertions
 * are written against the field names the front end reads, not against a
 * paraphrase of them, so a rename that breaks the page breaks this too.
 */

const BASE = 'https://gap.test';
let env: Env;

/**
 * `caches` is a Workers global that Node does not have, and both public routes
 * exercised here are on the entry point's edge-cache list, so it is reached for
 * before any handler runs.
 *
 * The stand-in never stores anything on purpose: a real hit would answer some
 * of these assertions from before the rows they depend on were written, and
 * they would pass without ever reaching the code under test.
 */
(globalThis as any).caches ??= {
  default: { match: async () => undefined, put: async () => {} },
};

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

const OP = 'op-payload';
const OTHER = 'op-other';
const PREV = { lat: 34.1500, lng: -118.4490 };
const NEXT = { lat: 34.1520, lng: -118.4400 };
const NEAR = { lat: 34.1510, lng: -118.4450 };
const t = () => now();

async function addOperator(id: string, name: string, opts: {
  avatarKey?: string | null; slug?: string | null;
} = {}) {
  const n = t();
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,trade,timezone,country,currency,language,
       location_mode,fill_model,sms_mode,max_detour_seconds,min_gap_seconds,buffer_seconds,
       offer_ttl_seconds,offers_per_wave,min_notice_seconds,reoffer_cooldown_seconds,
       discount_percent,plan,accept_public_bookings,deposit_cents,avatar_key,
       profile_slug,is_published,created_at,updated_at)
     VALUES (?,?,?, 'mobile car wash and detailing','America/Los_Angeles','US','USD','en',
       'mobile','both','device',900,3600,900,5400,3,3600,604800,0,'active',1,1000,?,?,?,?,?)`,
  ).bind(id, `${id}@x.com`, name, opts.avatarKey ?? null,
    opts.slug ?? null, opts.slug ? 1 : 0, n, n).run();

  await env.DB.prepare(
    `INSERT INTO services (id,operator_id,name,duration_seconds,price_cents,cadence_days,
       created_at,updated_at)
     VALUES (?,?,'Full detail',7200,9900,28,?,?)`,
  ).bind(`sv-${id}`, id, n, n).run();

  await env.DB.prepare(
    `INSERT INTO service_areas (id,operator_id,name,slug,place_slug,lat,lng,radius_meters,
       created_at,updated_at)
     VALUES (?,?,'Sherman Oaks',?, 'sherman-oaks',?,?,8000,?,?)`,
  ).bind(newId(), id, `sherman-oaks-${id}`, PREV.lat, PREV.lng, n, n).run();

  const gapId = newId();
  const start = n + 4 * 3600;
  await env.DB.prepare(
    `INSERT INTO gaps (id,operator_id,starts_at,ends_at,prev_lat,prev_lng,next_lat,next_lng,
       baseline_drive_seconds,is_mobile,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,180,1,'open',?,?)`,
  ).bind(gapId, id, start, start + 5 * 3600,
    PREV.lat, PREV.lng, NEXT.lat, NEXT.lng, n, n).run();
  return gapId;
}

/** A photograph the operator uploaded to their own portfolio. */
async function addWorkPhoto(
  operatorId: string, key: string, sortOrder: number, createdAt = t(),
) {
  await env.DB.prepare(
    `INSERT INTO work_photos (id,operator_id,r2_key,content_type,sort_order,
       created_at,updated_at) VALUES (?,?,?, 'image/jpeg',?,?,?)`,
  ).bind(newId(), operatorId, key, sortOrder, createdAt, createdAt).run();
}

/**
 * A photograph taken inside a customer's home during a job.
 *
 * `released` is migration 0028's public_on_review, which only the customer who
 * took the photo can set, and only onto their own review. Even set, it does
 * not make the photo a marketing image — which is what the tests below check.
 */
async function addJobPhoto(operatorId: string, key: string, released: boolean) {
  const n = t();
  await env.DB.prepare(
    `INSERT INTO job_photos (id,order_item_id,operator_id,uploaded_by,stage,r2_key,
       content_type,public_on_review,created_at)
     VALUES (?, 'item-1', ?, 'customer','after',?, 'image/jpeg',?,?)`,
  ).bind(newId(), operatorId, key, released ? 1 : 0, n).run();
}

async function seedPostcodes() {
  await env.DB.prepare(
    `INSERT INTO postal_codes (country_code,postal_code,place_name,lat,lng,accuracy)
     VALUES ('US','91403','Sherman Oaks',?,?,6)`,
  ).bind(NEAR.lat, NEAR.lng).run();
}

beforeEach(() => { env = makeEnv(ALL_MIGRATIONS) as unknown as Env; });

// ---------------------------------------------------------------------------
// 1. The picture on the card
// ---------------------------------------------------------------------------

describe('the photographs a listing card is given', () => {
  it('carries the operator’s avatar and one of their own work photos', async () => {
    await addOperator(OP, 'Valley Detailing', { avatarKey: 'a/op-payload/face' });
    await addWorkPhoto(OP, 'w/op-payload/first', 0);

    const [slot] = await slotsNear(env, NEAR, 'sherman-oaks');
    expect(slot!.avatar_key).toBe('a/op-payload/face');
    expect(slot!.work_photo_key).toBe('w/op-payload/first');
  });

  it('leaves both null for a business that has uploaded neither', async () => {
    await addOperator(OP, 'Valley Detailing');

    const [slot] = await slotsNear(env, NEAR, 'sherman-oaks');
    // Null, and not a placeholder key: a card has to be able to render the
    // absence of a photograph rather than show a stranger somebody else's van.
    expect(slot!.avatar_key).toBeNull();
    expect(slot!.work_photo_key).toBeNull();
  });

  it('NEVER publishes a job photo, released onto a review or not', async () => {
    await addOperator(OP, 'Valley Detailing');
    // The inside of a customer's house, taken as evidence. The second one the
    // customer has released onto their own review, which publishes it beside
    // that review and nowhere else -- it is not consent to be a thumbnail on
    // a marketplace card, and this operator has no work photos at all, so if
    // either could leak into the card it would be here.
    await addJobPhoto(OP, 'j/op-payload/hallway', false);
    await addJobPhoto(OP, 'j/op-payload/kitchen', true);

    const [slot] = await slotsNear(env, NEAR, 'sherman-oaks');
    expect(slot!.work_photo_key).toBeNull();
    expect(JSON.stringify(slot)).not.toContain('j/');
  });

  it('publishes only keys the public photo route will serve', async () => {
    await addOperator(OP, 'Valley Detailing', { avatarKey: 'a/op-payload/face' });
    await addWorkPhoto(OP, 'w/op-payload/first', 0);
    await addJobPhoto(OP, 'j/op-payload/hallway', true);

    const [slot] = await slotsNear(env, NEAR, 'sherman-oaks');
    // The same allowlist src/index.ts enforces on /api/public/photo/:key. A
    // key this payload carries that the route refuses is a broken image; a
    // key the route would serve that should never have been offered is worse.
    for (const key of [slot!.avatar_key, slot!.work_photo_key]) {
      expect(key).toBeTruthy();
      expect(key!.startsWith('w/') || key!.startsWith('a/')).toBe(true);
    }
  });

  it('shows the photo the operator put first, and the same one every time',
    async () => {
      await addOperator(OP, 'Valley Detailing');
      // Uploaded last, dragged to the front. sort_order is the operator's own
      // choice and it has to beat upload order, or the card shows whatever
      // they happened to add most recently.
      await addWorkPhoto(OP, 'w/op-payload/older', 2, t() - 900);
      await addWorkPhoto(OP, 'w/op-payload/chosen', 0, t());

      const first = await slotsNear(env, NEAR, 'sherman-oaks');
      const again = await slotsNear(env, NEAR, 'sherman-oaks');
      expect(first[0]!.work_photo_key).toBe('w/op-payload/chosen');
      expect(again[0]!.work_photo_key).toBe('w/op-payload/chosen');
    });

  it('gives each business its own photo when several are listed', async () => {
    await addOperator(OP, 'Valley Detailing');
    await addOperator(OTHER, 'Oaks Mobile Wash');
    await addWorkPhoto(OP, 'w/op-payload/mine', 0);
    await addWorkPhoto(OTHER, 'w/op-other/theirs', 0);

    const slots = await slotsNear(env, NEAR, 'sherman-oaks');
    expect(slots).toHaveLength(2);
    const byOp = new Map(slots.map((s) => [s.operator_id, s.work_photo_key]));
    // The batched lookup returns one row per operator for all of them at once;
    // handing every card the same picture would be the way that goes wrong.
    expect(byOp.get(OP)).toBe('w/op-payload/mine');
    expect(byOp.get(OTHER)).toBe('w/op-other/theirs');
  });

  it('carries them onto the booking confirmation as well as the listing',
    async () => {
      const gapId = await addOperator(OP, 'Valley Detailing',
        { avatarKey: 'a/op-payload/face' });
      await addWorkPhoto(OP, 'w/op-payload/first', 0);
      await seedPostcodes();

      const { slot } = await claimSlot(env, {
        gapId, first_name: 'Debra', phone: '(818) 555-0142',
        address_line: '15200 Ventura Blvd', postcode: '91403',
      });
      // The card on the confirmation screen is the card from the listing. A
      // business that had a photograph a moment ago must not lose it at the
      // point somebody has just paid them.
      expect(slot.avatar_key).toBe('a/op-payload/face');
      expect(slot.work_photo_key).toBe('w/op-payload/first');
    });

  it('reaches the map endpoint the landing page reads', async () => {
    await addOperator(OP, 'Valley Detailing', { avatarKey: 'a/op-payload/face' });
    await addWorkPhoto(OP, 'w/op-payload/first', 0);

    const res = await worker.fetch(new Request(`${BASE}/api/public/map`), env, ctx);
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.slots[0].avatar_key).toBe('a/op-payload/face');
    expect(body.slots[0].work_photo_key).toBe('w/op-payload/first');
  });
});

// ---------------------------------------------------------------------------
// 2. The services and the working week on a profile
// ---------------------------------------------------------------------------

describe('what the public profile says a business does and when', () => {
  const SLUG = 'valley-detailing';

  async function withServices() {
    await addOperator(OP, 'Valley Detailing', { slug: SLUG });
    const n = t();
    await env.DB.prepare(
      `INSERT INTO services (id,operator_id,name,duration_seconds,price_cents,
         gap_fill_eligible,is_active,created_at,updated_at)
       VALUES ('sv-wax',?,'Wash and wax',3600,4900,0,1,?,?)`,
    ).bind(OP, n, n).run();
    await env.DB.prepare(
      `INSERT INTO services (id,operator_id,name,duration_seconds,price_cents,
         is_active,created_at,updated_at)
       VALUES ('sv-retired',?,'Engine bay clean',5400,7900,0,?,?)`,
    ).bind(OP, n, n).run();
    for (const [weekday, start, end] of [[1, 540, 1020], [1, 1080, 1200], [2, 540, 1020]]) {
      await env.DB.prepare(
        `INSERT INTO working_hours (id,operator_id,weekday,start_minute,end_minute,created_at)
         VALUES (?,?,?,?,?,?)`,
      ).bind(newId(), OP, weekday, start, end, n).run();
    }
  }

  it('lists every active service, not only the ones a gap can take', async () => {
    await withServices();
    const profile = (await getPublicProfile(env, SLUG))!;

    // 'Wash and wax' is gap_fill_eligible = 0, so it can never appear on an
    // opening and the listing side of the site cannot see it. It is still one
    // of the things this business does, which is what a profile is for.
    expect(profile.services.map((s) => s.name).sort())
      .toEqual(['Full detail', 'Wash and wax']);
  });

  it('leaves out a service the operator retired', async () => {
    await withServices();
    const profile = (await getPublicProfile(env, SLUG))!;
    expect(profile.services.map((s) => s.name)).not.toContain('Engine bay clean');
  });

  it('gives each service its id, duration and price and nothing else', async () => {
    await withServices();
    const profile = (await getPublicProfile(env, SLUG))!;
    const detail = profile.services.find((s) => s.name === 'Full detail')!;
    expect(detail).toEqual({
      id: 'sv-op-payload', name: 'Full detail',
      duration_seconds: 7200, price_cents: 9900,
    });
    // The operator's working notes -- what a job needs on the van, whether it
    // can fill a gap at two hours' notice -- are how they run their week, not
    // something a stranger reads off a menu.
    for (const banned of ['gap_fill_eligible', 'requires_parts', 'is_active',
      'requires_client_present', 'cadence_days', 'operator_id']) {
      expect(JSON.stringify(profile.services)).not.toContain(banned);
    }
  });

  it('returns the working week in weekday and start order', async () => {
    await withServices();
    const profile = (await getPublicProfile(env, SLUG))!;
    expect(profile.working_hours).toEqual([
      { weekday: 1, start_minute: 540, end_minute: 1020 },
      { weekday: 1, start_minute: 1080, end_minute: 1200 },
      { weekday: 2, start_minute: 540, end_minute: 1020 },
    ]);
    // location_id would say how many premises this business has and let two
    // operators be tied together through a shared address.
    expect(JSON.stringify(profile.working_hours)).not.toContain('location_id');
  });

  it('returns no hours at all for a business that has never set any', async () => {
    await addOperator(OP, 'Valley Detailing', { slug: SLUG });
    const profile = (await getPublicProfile(env, SLUG))!;
    // Empty, and not a week of invented nine-to-fives. "They have not said" is
    // the true answer and the page has to be able to tell it apart from
    // "closed", which a fabricated row would make impossible.
    expect(profile.working_hours).toEqual([]);
  });

  it('never carries another business’s services or hours', async () => {
    await withServices();
    await addOperator(OTHER, 'Oaks Mobile Wash', { slug: 'oaks-mobile-wash' });
    const n = t();
    await env.DB.prepare(
      `INSERT INTO working_hours (id,operator_id,weekday,start_minute,end_minute,created_at)
       VALUES (?,?,6,600,660,?)`,
    ).bind(newId(), OTHER, n).run();

    const profile = (await getPublicProfile(env, SLUG))!;
    expect(profile.services.map((s) => s.id)).not.toContain(`sv-${OTHER}`);
    expect(profile.services).toHaveLength(2);
    expect(profile.working_hours.some((h) => h.weekday === 6)).toBe(false);
  });

  it('reaches the page through the route, with the timezone that reads them',
    async () => {
      await withServices();
      const res = await worker.fetch(
        new Request(`${BASE}/api/public/profile/${SLUG}`), env, ctx);
      const body = await res.json() as any;

      expect(res.status).toBe(200);
      // start_minute is minutes from midnight WHERE THE BUSINESS IS. Without
      // the timezone beside it the page would render 09:00 in Los Angeles as
      // whatever the reader's own clock makes of 540.
      expect(body.operator.timezone).toBe('America/Los_Angeles');
      expect(body.services).toHaveLength(2);
      expect(body.working_hours).toHaveLength(3);
    });

  it('still tells a stranger nothing private', async () => {
    await withServices();
    const res = await worker.fetch(
      new Request(`${BASE}/api/public/profile/${SLUG}`), env, ctx);
    const raw = await res.text();
    // The two new lists travel with the rest of the payload, so they are two
    // more chances for a column that was never meant to leave the Worker.
    for (const banned of ['op-payload@x.com', 'max_detour_seconds', 'plan',
      'accept_public_bookings', 'phone_e164']) {
      expect(raw).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The cost guide's structured data
// ---------------------------------------------------------------------------

/** The JSON-LD the server page emits, parsed back out of the markup. */
function graphOf(html: string): any {
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  return JSON.parse(m![1]!);
}

describe('the cost guide’s FAQ markup', () => {
  // The stored slug. The catalogue's label for it -- the words that reach the
  // question below -- is "Car wash and detailing".
  const DETAILING = 'mobile car wash and detailing';

  it('emits a FAQPage with the six answers the React page carries', async () => {
    const page = (await costGuidePage(env, DETAILING))!;
    const faq = graphOf(page)['@graph'].find((n: any) => n['@type'] === 'FAQPage');

    expect(faq).toBeTruthy();
    expect(faq.mainEntity).toHaveLength(6);
    // Word for word from web/src/pages/CostGuide.tsx. These are the strings a
    // search engine may quote, so a paraphrase here would pass the test while
    // publishing an answer the page does not contain.
    expect(faq.mainEntity.map((q: any) => q.name)).toEqual([
      'Are these average prices for car wash and detailing?',
      'Who sets these prices?',
      'Does the price include parts?',
      'When do I pay?',
      'Why is the same job listed at two different prices?',
      'What does it cost to cancel?',
    ]);
    // The payment seam is not built, so the answer says so first and calls the
    // rest a design. It used to say "You pay for the labour when you book,
    // here on the site", which was a claim about money the Worker has never
    // been able to move -- and it was the version a crawler indexed, because
    // the React page rendering this same URL had already been corrected.
    expect(faq.mainEntity[3].acceptedAnswer.text).toBe(
      `${PAY_TODAY_SHORT} The design is that the labour is paid for here, `
      + 'on the site, at the moment you book, with no cash and nothing paid '
      + 'at the door — but that part is not built yet.');
  });

  it('shows a person every answer it shows a crawler', async () => {
    const page = (await costGuidePage(env, DETAILING))!;
    const faq = graphOf(page)['@graph'].find((n: any) => n['@type'] === 'FAQPage');

    for (const q of faq.mainEntity) {
      // The visible block and the markup are built from one array, and this is
      // the assertion that keeps them that way: structured data describing
      // answers a reader cannot find on the page is a bait search result.
      expect(page).toContain(q.name.replace(/'/g, '&#39;'));
      expect(page).toContain(q.acceptedAnswer.text.replace(/'/g, '&#39;'));
    }
  });

  it('quotes no price in the markup, on a trade with prices or without',
    async () => {
      const raw = JSON.stringify(graphOf((await costGuidePage(env, DETAILING))!));
      // The answers are about how the product works and are true on an empty
      // day. A figure counted off today's listings would not be, and a stale
      // price in a search result is a price somebody arrives expecting.
      expect(raw).not.toContain('$');
      expect(raw).not.toContain('aggregateRating');
    });
});

// ---------------------------------------------------------------------------
// 4. One statement about money, on both halves of the same URL
// ---------------------------------------------------------------------------

/**
 * THE DEFECT THESE TESTS EXIST FOR IS THE DRIFT, NOT THE WORDING.
 *
 * /s/<trade> and /cost/<trade> are rendered twice: by src/lib/seo.ts for a
 * crawler and a visitor with no JavaScript, and by the React page that mounts
 * over it. The React pages were rewritten to say that payment is not built;
 * the Worker's were not, so for a while the same URL answered "When do I pay?"
 * with "You pay for the labour when you book" or with "Nothing is paid on this
 * site yet" depending on whether a script ran — and the false one was the one
 * indexed.
 *
 * The Worker cannot import PaymentState.tsx (different build, different
 * runtime), so the sentence is written out in both trees and pinned here by
 * reading the React source off disk. Change one and this fails.
 */

const CLIENT = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/**
 * The value of `export const NAME = 'a' + 'b';` in a source file this test
 * cannot import — PaymentState.tsx is TSX compiled for the browser, and
 * importing it here would drag the React runtime into a Worker test.
 */
function exportedString(source: string, name: string): string {
  const decl = source.match(new RegExp(`export const ${name}\\s*=([\\s\\S]*?);`));
  expect(decl, `${name} is no longer declared where this test looks for it`).not.toBeNull();
  const parts = [...decl![1]!.matchAll(/'((?:[^'\\]|\\.)*)'/g)]
    .map((m) => m[1]!.replace(/\\(['\\])/g, '$1'));
  expect(parts.length).toBeGreaterThan(0);
  return parts.join('');
}

describe('what the site says about money, said once', () => {
  const DETAILING = 'mobile car wash and detailing';

  it('gives the Worker and the React app the same sentence, character for character',
    () => {
      const client = exportedString(
        CLIENT('web/src/components/PaymentState.tsx'), 'PAY_TODAY_SHORT');
      expect(PAY_TODAY_SHORT).toBe(client);
    });

  it('has both React pages build their payment answers out of that constant', () => {
    // If either page inlines its own wording again, the constant above stops
    // being the single statement and this pin stops meaning anything.
    for (const page of ['web/src/pages/Trade.tsx', 'web/src/pages/CostGuide.tsx']) {
      const src = CLIENT(page);
      expect(src).toContain("import { PAY_TODAY_SHORT } from '../components/PaymentState'");
      expect(src).toContain('${PAY_TODAY_SHORT}');
    }
  });

  it('opens every server answer about paying with it, word for word', async () => {
    for (const page of [
      (await tradePage(env, DETAILING))!,
      (await costGuidePage(env, DETAILING))!,
    ]) {
      expect(page).toContain(PAY_TODAY_SHORT);
    }
  });

  it('claims nowhere on a server-rendered page that money moves today',
    async () => {
      const pages = [
        (await tradePage(env, DETAILING))!,
        (await costGuidePage(env, DETAILING))!,
        await costIndexPage(env),
        await browseIndexPage(env),
        await metroPage(env),
      ];
      // Every sentence the Worker used to carry that said a card is taken, or
      // that a fee or a refund is collected today. All of them are now stated
      // as the design that takes effect when the seam lands, never as
      // something the product does.
      for (const lie of [
        'You pay for the labour when you book',
        'you pay for the labour when you book',
        'nothing is paid at the door',
        'never\n       at the door',
        'Cancelling close to the appointment costs a graduated fee',
        'nothing is charged until you approve',
        'nothing is fitted or charged',
      ]) {
        for (const page of pages) expect(page).not.toContain(lie);
      }
    });
});
