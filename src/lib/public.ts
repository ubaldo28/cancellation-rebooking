import type { Env, Operator, Point } from '../types';
import { ZERO_DECIMAL, formatMoney, getCountry, localeFor, normalisePostcode } from './countries';
import { driveSeconds, geocode } from './geo';
import { notify } from './feed';
import { isDemoOperator } from './demo';
import { attachBooking, startThread, threadByToken } from './chat';
import { displayName } from './reviews';
import { customerStanding } from './standing';
import { formatTimeRange } from './tz';
import { badRequest, conflict, haversineMeters, newId, notFound, now, toE164 } from './util';

export interface Area {
  id: string; operator_id: string; name: string; slug: string;
  lat: number; lng: number; radius_meters: number;
}

/**
 * The one review a card has room for.
 *
 * Deliberately not a `Review`: a card shows a line of text, who said it and
 * how many stars, and carrying the reply, the photos and the booking details
 * into a listing of six hundred rows would be paying for a profile page nobody
 * asked for.
 */
export interface ReviewSnippet {
  body: string;
  /** "Debra D." — through the same helper the profile page uses. */
  author: string;
  rating: number;
}

/** A slot as a stranger sees it: a time, a price, and how close the van already is. */
export interface PublicSlot {
  gap_id: string;
  operator_id: string;
  business_name: string;
  /** 'mobile detailing', 'junk removal', … — what kind of work this is. */
  trade: string | null;
  profile_slug: string | null;
  /**
   * A sample business, not a real one.
   *
   * The demo data exists so the map is not blank before anyone has signed up.
   * Several of those trades are licensed in California and the sample
   * businesses hold no licence, because inventing a licence number would be
   * fabricating a record. So they say what they are instead.
   */
  is_sample: boolean;
  service_id: string | null;
  service_name: string;
  starts_at: number;
  ends_at: number;
  duration_seconds: number;
  price_cents: number;
  deposit_cents: number;
  currency: string;
  when: string;
  price: string;
  /** Minutes the operator would drive out of their way to reach this address. */
  detour_minutes: number | null;
  /** The line that no directory can write. */
  proximity: string | null;
  /**
   * Roughly where the van is around this gap, snapped to a ~1 km grid. Null
   * for premises work. See `coarsenAnchor` for why it is never the real point.
   */
  anchor_lat: number | null;
  anchor_lng: number | null;

  // -------------------------------------------------------------------------
  // Who this business is, for the card
  // -------------------------------------------------------------------------
  // The reference marketplace answers "should I let this stranger into my
  // house" on the card itself — score, hires, how long they have been at it —
  // and a card carrying only a price and a time asks the visitor to click
  // through to find out whether the business is real. All of it is read
  // straight off the operator's own row, and none of it has a fallback: see
  // the note on cardFacts for why an empty value stays empty.

  /**
   * The score, rounded to one decimal the way a score is read.
   *
   * Null when nobody has reviewed them. That is a different statement from
   * zero, and the front end has to be able to tell the two apart: a new
   * business has no rating, it does not have a bad one.
   */
  rating: number | null;
  review_count: number;
  /** "Hired 314 times." Jobs that actually completed. */
  hired_count: number;
  /**
   * Switched on and working right now — see migration 0029.
   *
   * Derived from online_until rather than read from a flag, so a Worker that
   * never ran its sweep cannot leave somebody advertised as available three
   * hours after they went to bed.
   */
  online: boolean;
  /**
   * A background check was run on this person.
   *
   * Records that a check happened, exactly as migration 0027 describes it. It
   * is not this platform vouching for the result, and it is not a trade
   * licence — the front end must not word it as either.
   */
  background_check: boolean;
  years_in_business: number | null;
  employees: number | null;
  /**
   * The newest review that has words in it, or null when there are none.
   *
   * Null is also the answer when every review is a bare star rating, because a
   * card has one line to give and a review with no text has no line to fill
   * it. The stars are already carried by `rating`, so nothing is lost.
   */
  review_snippet: ReviewSnippet | null;

  // -------------------------------------------------------------------------
  // The two pictures a card can show
  // -------------------------------------------------------------------------
  // Both are R2 object keys, not URLs, because the route that serves them
  // (/api/public/photo/:key) is the one place that decides what may leave the
  // bucket, and it keeps its own prefix allowlist. Null is a real answer here:
  // most businesses have uploaded neither, and a card must show the absence
  // rather than a stock photograph of somebody else's work.

  /** `operators.avatar_key` — the `a/` prefix, which that route serves. */
  avatar_key: string | null;
  /**
   * One photograph from the operator's own portfolio, for the card thumbnail.
   *
   * work_photos ONLY, and this is the whole reason the field names the table
   * it comes from. The other photographs this product holds are job_photos:
   * the inside of a customer's house, taken as evidence for a dispute, and
   * migration 0028 is explicit that one of those becomes public only when the
   * customer who took it releases it onto their own review, one photo at a
   * time. A thumbnail is not that consent, so none of them are read here.
   * work_photos are the operator's own marketing pictures, already on their
   * public profile, and their keys carry the `w/` prefix the public photo
   * route allows.
   */
  work_photo_key: string | null;
}

/**
 * Decimal places kept on an anchor coordinate before it leaves the Worker.
 *
 * The anchor is `gaps.prev_lat/prev_lng`, which detectGaps copies off the
 * appointment either side of the opening — that is the previous customer's
 * front door, and `/api/public/map` is anonymous, so publishing it at full
 * precision hands a stranger a residential address belonging to someone who
 * never used this site.
 *
 * Two decimals at 34°N (Los Angeles) is a cell of 0.01° ≈ 1109 m north-south
 * by ≈ 924 m east-west, so any published point is within about 555 m / 462 m
 * of the truth. That is a neighbourhood — thousands of homes — and cannot be
 * walked back to a house, while still placing the pin in the right part of
 * town, which is all the anchor is for on the map. Three decimals would be a
 * ~111 m by ~92 m cell: a single block face, which is still an address.
 *
 * Nothing that computes a distance uses this. `detour_minutes`, the operator's
 * max_detour_seconds gate and the re-check inside claimSlot all run against
 * the true coordinates on the server, before anything is serialised.
 */
const ANCHOR_DECIMALS = 2;

/** Snap one anchor coordinate to the published grid, preserving null. */
function coarsenAnchor(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  const step = 10 ** ANCHOR_DECIMALS;
  return Math.round(v * step) / step;
}

/** The operator columns every card needs, listed once so both queries agree. */
const CARD_COLUMNS =
  `o.rating_sum, o.rating_count, o.hired_count, o.online_until,
   o.background_checked_at, o.years_in_business, o.employees, o.avatar_key`;

interface CardRow {
  rating_sum: number;
  rating_count: number;
  hired_count: number;
  online_until: number | null;
  background_checked_at: number | null;
  years_in_business: number | null;
  employees: number | null;
  avatar_key: string | null;
}

type CardFacts = Pick<PublicSlot,
  'rating' | 'review_count' | 'hired_count' | 'online'
  | 'background_check' | 'years_in_business' | 'employees' | 'avatar_key'>;

/**
 * The trust block on a card, read off the operator's row.
 *
 * Shared by the listing and by the booking confirmation so the same business
 * cannot show four stars on one screen and nothing on the next.
 *
 * NOTHING HERE HAS A DEFAULT, and that is the point of it being one function.
 * A business nobody has reviewed gets null, not 5.0 and not "new — probably
 * great"; a business nobody has hired gets the 0 its own row holds. Filling
 * those holes would be the platform making a claim about somebody it knows
 * nothing about, to a customer deciding whether to let them through a door.
 * It applies to the sample businesses in exactly the same way: whatever the
 * demo rows say is what shows, which for most of them is nothing at all.
 */
function cardFacts(o: CardRow, t: number): CardFacts {
  return {
    // Rounded the same way ratingFor rounds, so the card and the profile page
    // never print a different number for the same business.
    rating: o.rating_count > 0
      ? Math.round((o.rating_sum / o.rating_count) * 10) / 10
      : null,
    review_count: o.rating_count ?? 0,
    hired_count: o.hired_count ?? 0,
    online: o.online_until != null && o.online_until > t,
    background_check: o.background_checked_at != null,
    years_in_business: o.years_in_business ?? null,
    employees: o.employees ?? null,
    avatar_key: o.avatar_key ?? null,
  };
}

/**
 * The newest review with words in it, for each of these operators, in one query.
 *
 * Batched by operator id and merged in memory for the same reason the service
 * areas below are: anything joined onto the listing query multiplies its rows,
 * and the row cap then eats the tail of the list without saying so.
 *
 * The NOT EXISTS is what makes this one row per operator instead of every
 * review of everybody on the page. A business with four hundred reviews would
 * otherwise cost four hundred rows read to print one line, and it walks the
 * (operator_id, created_at DESC) index that migration 0027 added for exactly
 * this lookup.
 */
async function snippetsFor(
  env: Env, operatorIds: string[],
): Promise<Map<string, ReviewSnippet>> {
  const ids = [...new Set(operatorIds)];
  const out = new Map<string, ReviewSnippet>();
  if (ids.length === 0) return out;

  const rows = await env.DB.prepare(
    `SELECT r.operator_id, r.author_name, r.rating, r.body
       FROM reviews r
      WHERE r.operator_id IN (${ids.map(() => '?').join(',')})
        AND r.hidden_at IS NULL
        AND r.body IS NOT NULL
        AND NOT EXISTS (
              SELECT 1 FROM reviews r2
               WHERE r2.operator_id = r.operator_id
                 AND r2.hidden_at IS NULL
                 AND r2.body IS NOT NULL
                 -- The id breaks a tie on the second, because two reviews can
                 -- land in the same one and a quote that changes on every
                 -- reload reads as the page being broken.
                 AND (r2.created_at > r.created_at
                      OR (r2.created_at = r.created_at AND r2.id > r.id)))`,
  ).bind(...ids).all<{
    operator_id: string; author_name: string; rating: number; body: string;
  }>();

  for (const r of rows.results ?? []) {
    out.set(r.operator_id, {
      body: r.body,
      // The profile page's own helper, so a reviewer is "Debra D." in both
      // places and the rule about surnames lives in exactly one function.
      author: displayName(r.author_name),
      rating: r.rating,
    });
  }
  return out;
}

/**
 * The lead photograph from each of these operators' portfolios, in one query.
 *
 * Batched by operator id for the reason snippetsFor is: a listing is up to six
 * hundred rows and one query per row is six hundred round trips, while joining
 * work_photos onto the listing query would multiply it by however many photos
 * each business has uploaded and let the row cap eat the tail.
 *
 * ONLY work_photos IS READ, AND NO OTHER PHOTO TABLE MAY BE ADDED HERE. See
 * the note on PublicSlot.work_photo_key: job_photos are somebody's home and
 * are released one at a time by the customer who took them, so they are not
 * available to a card whatever the commercial argument for using them.
 *
 * The NOT EXISTS is what makes this one row per operator rather than every
 * photograph belonging to everybody on the page, and it picks the same photo
 * the profile page leads with — first by the operator's own sort_order, which
 * is what that ordering is for, so the picture on the card is the one they
 * chose to put first.
 */
async function workPhotoKeysFor(
  env: Env, operatorIds: string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(operatorIds)];
  const out = new Map<string, string>();
  if (ids.length === 0) return out;

  const rows = await env.DB.prepare(
    `SELECT p.operator_id, p.r2_key
       FROM work_photos p
      WHERE p.operator_id IN (${ids.map(() => '?').join(',')})
        AND NOT EXISTS (
              SELECT 1 FROM work_photos p2
               WHERE p2.operator_id = p.operator_id
                 -- The id breaks a tie on sort_order and created_at together,
                 -- because two photos uploaded in the same second at the same
                 -- position would otherwise give a thumbnail that changes on
                 -- every reload, which reads as the page being broken.
                 AND (p2.sort_order < p.sort_order
                      OR (p2.sort_order = p.sort_order
                          AND (p2.created_at < p.created_at
                               OR (p2.created_at = p.created_at AND p2.id < p.id)))))`,
  ).bind(...ids).all<{ operator_id: string; r2_key: string }>();

  for (const r of rows.results ?? []) out.set(r.operator_id, r.r2_key);
  return out;
}

/**
 * Open slots a stranger could book near a point.
 *
 * Two filters do the work. The area filter is coarse and cheap: is this
 * operator willing to work here at all. The detour filter is the real one and
 * runs per slot: given the jobs either side of the gap, how far out of their
 * way is this address. A slot only appears if the answer is inside the
 * operator's own tolerance, so nothing is ever offered that wrecks their day.
 */
export async function slotsNear(
  env: Env, at: Point | null, slug: string | null, limit = 20,
  gapId: string | null = null,
): Promise<PublicSlot[]> {
  const t = now();

  // Areas are fetched separately, not joined.
  //
  // Joining them returned one row per gap per area the operator covers — up to
  // five copies of every opening — and the row cap then truncated the result.
  // With ten businesses in the data the last ones fell off the end entirely and
  // their whole trade vanished from the site. EXISTS filters without
  // multiplying, and the coarse distance gate is done here instead.
  const [rows, areaRows] = await Promise.all([
    env.DB.prepare(
      `SELECT g.id AS gap_id, g.starts_at, g.ends_at, g.is_mobile,
              g.prev_lat, g.prev_lng, g.next_lat, g.next_lng, g.baseline_drive_seconds,
              o.id AS operator_id, o.business_name, o.trade, o.profile_slug,
              o.timezone, o.country, o.language,
              o.currency, o.deposit_cents, o.max_detour_seconds, o.discount_percent,
              ${CARD_COLUMNS},
              s.id AS service_id, s.name AS service_name,
              s.duration_seconds, s.price_cents
         FROM gaps g
         JOIN operators o ON o.id = g.operator_id
         LEFT JOIN services s ON s.id = (
                SELECT s2.id FROM services s2
                 WHERE s2.operator_id = o.id AND s2.is_active = 1
                   AND s2.gap_fill_eligible = 1
                   AND s2.duration_seconds <= g.ends_at - g.starts_at
                   -- An opening the operator restricted to particular services
                   -- must only ever be advertised as one of those. No rows in
                   -- gap_services means "any of mine", which is how every
                   -- automatically detected gap behaves.
                   AND (NOT EXISTS (SELECT 1 FROM gap_services gs WHERE gs.gap_id = g.id)
                        OR EXISTS (SELECT 1 FROM gap_services gs
                                    WHERE gs.gap_id = g.id AND gs.service_id = s2.id))
                 ORDER BY s2.price_cents DESC LIMIT 1)
        WHERE g.status IN ('open','offering')
          AND g.starts_at > ?
          AND g.starts_at < ?
          AND o.accept_public_bookings = 1
          AND o.plan IN ('trial','active')
          -- A suspended or banned business is not offered new work, exactly as
          -- online.ts refuses to show them as available and listingBlock()
          -- refuses to let them post an opening. Openings they put up before
          -- the suspension used to stay on the map and stay bookable, which
          -- made the whole ladder a suggestion. Nothing here touches work
          -- already booked -- those customers keep their appointment.
          AND o.banned_at IS NULL
          AND (o.suspended_until IS NULL OR o.suspended_until <= ?)
          AND (? IS NULL OR g.id = ?)
          AND EXISTS (SELECT 1 FROM service_areas a
                       WHERE a.operator_id = o.id AND a.is_active = 1
                         AND (? IS NULL OR a.place_slug = ?))
          AND NOT EXISTS (SELECT 1 FROM public_claims c
                           WHERE c.gap_id = g.id AND c.status = 'confirmed')
        ORDER BY g.starts_at
        LIMIT 600`,
      // Ten days. Beyond that every row is an untouched working day and the
      // list becomes the same entry printed over and over.
    ).bind(t + 3600, t + 10 * 86400, t, gapId, gapId, slug, slug).all<any>(),

    env.DB.prepare(
      `SELECT operator_id, lat, lng, radius_meters FROM service_areas
        WHERE is_active = 1`,
    ).all<{ operator_id: string; lat: number; lng: number; radius_meters: number }>(),
  ]);

  const areasByOp = new Map<string, Array<{ lat: number; lng: number; radius_meters: number }>>();
  for (const a of areaRows.results ?? []) {
    const list = areasByOp.get(a.operator_id) ?? [];
    list.push(a);
    areasByOp.set(a.operator_id, list);
  }

  const candidates = (rows.results ?? []).filter((r) => {
    if (!r.service_id) return false;                       // nothing to sell
    if (r.duration_seconds > r.ends_at - r.starts_at) return false;
    if (!at) return true;
    // Coarse gate: is this address inside any area the operator works.
    return (areasByOp.get(r.operator_id) ?? []).some(
      (a) => haversineMeters(at, { lat: a.lat, lng: a.lng }) <= a.radius_meters);
  });

  // Drive time only matters when we know where the customer is.
  const pairs: [Point, Point][] = [];
  const map: Array<{ i: number; slot: 'in' | 'out' }> = [];
  if (at) {
    candidates.forEach((r, i) => {
      if (r.is_mobile !== 1) return;
      if (r.prev_lat != null) { pairs.push([{ lat: r.prev_lat, lng: r.prev_lng }, at]); map.push({ i, slot: 'in' }); }
      if (r.next_lat != null) { pairs.push([at, { lat: r.next_lat, lng: r.next_lng }]); map.push({ i, slot: 'out' }); }
    });
  }
  // The quotes are fetched for the survivors of the coarse filter rather than
  // for every row the query returned, and alongside the drive times rather
  // than after them: neither waits on the other.
  const [times, snippets, photoKeys] = await Promise.all([
    driveSeconds(env, 'public', pairs),
    snippetsFor(env, candidates.map((r) => r.operator_id)),
    workPhotoKeysFor(env, candidates.map((r) => r.operator_id)),
  ]);
  const dIn = new Map<number, number>(), dOut = new Map<number, number>();
  map.forEach((m, n) => (m.slot === 'in' ? dIn : dOut).set(m.i, times[n]!));

  const out: PublicSlot[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const r = candidates[i]!;
    let detour: number | null = null;

    if (at && r.is_mobile === 1 && (dIn.has(i) || dOut.has(i))) {
      const travel = (dIn.get(i) ?? 0) + (dOut.get(i) ?? 0);
      detour = Math.max(0, travel - (r.baseline_drive_seconds ?? 0));
      // The operator's own tolerance decides. Never show a slot that would
      // cost them more driving than they said they would accept.
      if (detour > r.max_detour_seconds) continue;
      if (r.duration_seconds + travel > r.ends_at - r.starts_at) continue;
    }

    const locale = localeFor(r.country, r.language);
    const price = discounted(r.price_cents, r.discount_percent, r.currency);
    const mins = detour === null ? null : Math.round(detour / 60);

    out.push({
      gap_id: r.gap_id,
      operator_id: r.operator_id,
      business_name: r.business_name,
      trade: r.trade ?? null,
      profile_slug: r.profile_slug ?? null,
      is_sample: isDemoOperator(r.operator_id),
      service_id: r.service_id,
      service_name: r.service_name,
      starts_at: r.starts_at,
      ends_at: r.ends_at,
      duration_seconds: r.duration_seconds,
      price_cents: price,
      deposit_cents: r.deposit_cents,
      currency: r.currency,
      when: formatTimeRange(r.starts_at, r.starts_at + r.duration_seconds, r.timezone, locale),
      price: formatMoney(price, r.currency, locale),
      detour_minutes: mins,
      // The detour above was measured against r.prev_lat/r.next_lat at full
      // precision; only the copy handed to the caller is blunted.
      anchor_lat: coarsenAnchor(r.prev_lat ?? r.next_lat),
      anchor_lng: coarsenAnchor(r.prev_lng ?? r.next_lng),
      ...cardFacts(r, t),
      review_snippet: snippets.get(r.operator_id) ?? null,
      work_photo_key: photoKeys.get(r.operator_id) ?? null,
      // Honest about what is actually measured: extra driving, not a street.
      // "Already on your street" was being printed for a van in the next
      // neighbourhood, which is a promise the data cannot keep.
      proximity: mins === null ? null
        : mins === 0 ? 'already on their route'
        : mins <= 5 ? `${mins} min off their route`
        : `${mins} min out of their way`,
    });
  }

  // Closest first — proximity is the reason to book, so it leads.
  out.sort((a, b) =>
    (a.detour_minutes ?? 999) - (b.detour_minutes ?? 999) || a.starts_at - b.starts_at);
  return out.slice(0, limit);
}

/**
 * A discount off a real price, rounded to something a person would write.
 *
 * 10% off $189 is $170.10. Nobody prices a car wash at $170.10, and a price
 * with stray cents on it reads as a bug rather than a deal, so the result is
 * rounded to a whole unit of currency (or to the nearest 10 for zero-decimal
 * currencies, where a single unit is worth very little).
 */
export function discounted(cents: number, percent: number, currency: string): number {
  if (!percent) return cents;
  const raw = cents * (1 - percent / 100);
  const step = ZERO_DECIMAL.has(currency.toUpperCase()) ? 10 : 100;
  return Math.max(0, Math.round(raw / step) * step);
}

export interface MapArea {
  name: string; slug: string; lat: number; lng: number;
  /** Which trades actually have something open here, for the map label. */
  trades: string[];
  slot_count: number;
  /** Cheapest open slot in this area, already formatted. */
  from_price: string | null;
  /** When the next van is free here. */
  next_when: string | null;
}

/**
 * Everything the public map needs, in two queries.
 *
 * The map is the product's actual claim — these businesses have hours free
 * near you this week — so it has to load without a postcode, without an
 * account, and without a round trip per pin.
 */
export async function mapData(
  env: Env, at: Point | null = null,
): Promise<{ areas: MapArea[]; slots: Array<PublicSlot & { area_slug: string }> }> {
  const [areaRows, slots] = await Promise.all([
    env.DB.prepare(
      `SELECT a.name, a.slug, a.place_slug, a.lat, a.lng, a.operator_id
         FROM service_areas a
         JOIN operators o ON o.id = a.operator_id
        WHERE a.is_active = 1
          AND o.accept_public_bookings = 1
          AND o.plan IN ('trial','active')
        ORDER BY a.name`,
    ).all<{
      name: string; slug: string; place_slug: string;
      lat: number; lng: number; operator_id: string;
    }>(),
    slotsNear(env, at, null, 200),
  ]);

  const all = areaRows.results ?? [];

  // A slot is placed by where the van already is. An hour between two jobs
  // belongs to the neighbourhood those jobs are in — nowhere else.
  //
  // A whole free day is different: there is no job either side, so there is no
  // location, and the first version fell back to the operator's first area.
  // That is how eleven of twelve openings ended up stacked on Encino. A free
  // day is genuinely available anywhere that business works, so it is offered
  // in every one of their areas instead of being guessed into one.
  const tagged: Array<PublicSlot & { area_slug: string }> = [];
  for (const s of slots) {
    const mine = all.filter((a) => a.operator_id === s.operator_id);
    if (mine.length === 0) continue;

    // Coarse by the time it reaches here, which does not matter: this only
    // decides which of the operator's own neighbourhoods the pin belongs to,
    // and those are kilometres apart while the coarsening moves a point by at
    // most a few hundred metres.
    const here = s.anchor_lat != null && s.anchor_lng != null
      ? { lat: s.anchor_lat, lng: s.anchor_lng }
      : null;

    if (!here) {
      for (const a of mine) tagged.push({ ...s, area_slug: a.place_slug });
      continue;
    }

    const best = mine.reduce((a, b) =>
      haversineMeters(here, { lat: a.lat, lng: a.lng })
        <= haversineMeters(here, { lat: b.lat, lng: b.lng }) ? a : b);
    tagged.push({ ...s, area_slug: best.place_slug });
  }

  // One pin per neighbourhood, with every trade working there underneath it.
  // Keyed on place_slug because each business has its own service_areas row for
  // the same place, and pinning each one stacks four markers on one spot.
  const byPlace = new Map<string, typeof all>();
  for (const a of all) {
    const list = byPlace.get(a.place_slug) ?? [];
    list.push(a);
    byPlace.set(a.place_slug, list);
  }

  const areas: MapArea[] = [...byPlace.entries()].map(([place, rows]) => {  // eslint-disable-line
    const mine = tagged.filter((s) => s.area_slug === place);
    const cheapest = mine.reduce<PublicSlot | null>(
      (best, s) => (!best || s.price_cents < best.price_cents ? s : best), null);
    const soonest = mine.reduce<PublicSlot | null>(
      (best, s) => (!best || s.starts_at < best.starts_at ? s : best), null);
    const first = rows[0]!;
    return {
      name: first.name, slug: place, lat: first.lat, lng: first.lng,
      trades: [...new Set(mine.map((s) => s.trade).filter(Boolean))] as string[],
      slot_count: mine.length,
      from_price: cheapest?.price ?? null,
      next_when: soonest?.when ?? null,
    };
  }).sort((a, b) => {
    // Once the visitor has told us where they are, distance is the only order
    // that makes sense. Sorting by volume put them in whichever neighbourhood
    // happened to be busiest — Valley Village for someone in Sherman Oaks —
    // which is the exact opposite of what the page promises.
    if (at) {
      const da = haversineMeters(at, { lat: a.lat, lng: a.lng });
      const db = haversineMeters(at, { lat: b.lat, lng: b.lng });
      if (da !== db) return da - db;
    }
    return b.slot_count - a.slot_count || a.name.localeCompare(b.name);
  });

  // The same gap can be offered in several neighbourhoods; de-duplicate per
  // place so one free day is not listed twice on the same page.
  const seen = new Set<string>();
  const slotsOut = tagged.filter((s) =>
    seen.has(`${s.area_slug}:${s.gap_id}`) ? false
      : (seen.add(`${s.area_slug}:${s.gap_id}`), true));

  return { areas, slots: slotsOut };
}

/**
 * One slot by its gap id.
 *
 * The booking page needs exactly one slot. Fetching a page of slots and
 * searching it in memory silently loses any gap past the query's own row cap,
 * which shows a live slot as "gone". This asks the database for the one row.
 */
export async function slotById(env: Env, gapId: string): Promise<PublicSlot | null> {
  const rows = await slotsNear(env, null, null, 1, gapId);
  return rows[0] ?? null;
}

/**
 * A stranger takes a slot.
 *
 * Creates the client and the appointment in one batch, and leans on the same
 * unique index that protects invited offers: one confirmed claim per gap, so
 * two people tapping at once cannot both win.
 */
export async function claimSlot(env: Env, input: {
  gapId: string; first_name: string; phone: string; email?: string | null;
  address_line?: string | null; postcode?: string | null;
  /** Set when they asked a question before booking, so the thread carries on. */
  thread_token?: string | null;
}): Promise<{ appointment_id: string; slot: PublicSlot; thread_token: string }> {
  const t = now();

  const row = await env.DB.prepare(
    `SELECT g.*, o.country, o.currency, o.timezone, o.language, o.deposit_cents,
            o.max_detour_seconds, o.discount_percent, o.business_name,
            o.trade, o.profile_slug, o.accept_public_bookings,
            o.banned_at, o.suspended_until,
            ${CARD_COLUMNS}
       FROM gaps g JOIN operators o ON o.id = g.operator_id
      WHERE g.id = ?`,
  ).bind(input.gapId).first<any>();

  if (!row) throw notFound('That slot is no longer listed.');
  if (row.accept_public_bookings !== 1) throw notFound('That slot is no longer listed.');
  // The listing query already hides these, but the gap id travels in the URL
  // of the no-JavaScript form and a page cached before the suspension still
  // posts to it, so the check has to be here too and not only in the query
  // that stopped showing the slot.
  if (row.banned_at != null || (row.suspended_until != null && row.suspended_until > t)) {
    throw notFound('That slot is no longer listed.');
  }
  if (!['open', 'offering'].includes(row.status)) {
    throw conflict('Sorry — that slot has just been taken.', 'slot_taken');
  }
  if (row.starts_at <= t) throw conflict('That slot has already started.', 'slot_passed');

  const country = getCountry(row.country);
  const phone = toE164(input.first_name ? input.phone : null, row.country);
  if (!phone) throw badRequest('That does not look like a valid mobile number.', 'bad_phone');
  if (!input.first_name?.trim()) throw badRequest('We need a name for the booking.');

  // The same check placeOrder and createInstantRequest make, after the number
  // is normalised so a suspension cannot be stepped around by typing the same
  // number a different way. This path is the no-JavaScript booking form, and
  // without the check it was simply the way round the whole ladder: a customer
  // suspended for missing appointments could keep booking through it.
  const standing = await customerStanding(env, phone);
  if (standing.blocked) throw conflict(standing.message!, 'suspended');

  const postcode = input.postcode ? normalisePostcode(input.postcode) : null;
  if (row.is_mobile === 1 && !postcode && !input.address_line) {
    throw badRequest('We need an address so we know the van can reach you.');
  }

  const at = await geocode(env, input.address_line ?? null, postcode, row.country);
  if (row.is_mobile === 1 && !at) {
    throw badRequest(
      `We could not find that address in ${country?.name ?? row.country}.`, 'bad_address');
  }

  // Re-check the drive time at claim time. The listing may be minutes old and
  // the jobs either side can have moved since.
  let detour: number | null = null;
  const service = await env.DB.prepare(
    `SELECT id, name, duration_seconds, price_cents FROM services
      WHERE operator_id = ? AND is_active = 1 AND gap_fill_eligible = 1
        AND duration_seconds <= ?
        -- The same restriction the listing query applies, and it was missing
        -- here. An opening the operator narrowed to particular services was
        -- advertised correctly and then sold as whichever of their services
        -- was dearest, because this query picked by price alone. No rows in
        -- gap_services still means "any of mine".
        AND (NOT EXISTS (SELECT 1 FROM gap_services gs WHERE gs.gap_id = ?)
             OR EXISTS (SELECT 1 FROM gap_services gs
                         WHERE gs.gap_id = ? AND gs.service_id = services.id))
      ORDER BY price_cents DESC LIMIT 1`,
  ).bind(row.operator_id, row.ends_at - row.starts_at,
    input.gapId, input.gapId).first<any>();
  if (!service) throw conflict('That slot is no longer bookable.', 'no_service');

  if (at && row.is_mobile === 1) {
    const pairs: [Point, Point][] = [];
    if (row.prev_lat != null) pairs.push([{ lat: row.prev_lat, lng: row.prev_lng }, at]);
    if (row.next_lat != null) pairs.push([at, { lat: row.next_lat, lng: row.next_lng }]);
    const secs = await driveSeconds(env, row.operator_id, pairs);
    const travel = secs.reduce((a, b) => a + b, 0);
    detour = Math.max(0, travel - (row.baseline_drive_seconds ?? 0));
    if (detour > row.max_detour_seconds
        || service.duration_seconds + travel > row.ends_at - row.starts_at) {
      throw conflict('That slot is too far from their route now.', 'too_far');
    }
  }

  const price = discounted(service.price_cents, row.discount_percent, row.currency);

  const clientId = newId();
  const apptId = newId();
  const claimId = newId();
  const endsAt = Math.min(row.starts_at + service.duration_seconds, row.ends_at);

  try {
    const res = await env.DB.batch([
      // A public booking creates a real client on the operator's list — that is
      // the thing the platform actually delivered, marked so it can be counted.
      //
      // Without the contact details, and for the same reason as the identical
      // insert in orders.ts: a number the operator never holds is a number
      // they cannot take off the platform, and that has to be true of the
      // stored row rather than of the query that reads it. The address stays,
      // because they have to drive there.
      env.DB.prepare(
        `INSERT INTO clients (id, operator_id, first_name, phone_e164, email,
           address_line, postcode, lat, lng, geocode_status, geocoded_at,
           default_service_id, sms_consent, sms_consent_at, acquired,
           platform_introduced, created_at, updated_at)
         VALUES (?,?,?,NULL,NULL,?,?,?,?,?,?,?,0,NULL, 'public', 1, ?,?)`,
      ).bind(clientId, row.operator_id, input.first_name.trim(),
        input.address_line ?? null, postcode,
        at?.lat ?? null, at?.lng ?? null, at ? 'ok' : 'failed', at ? t : null,
        service.id, t, t),

      env.DB.prepare(
        `INSERT INTO appointments (id, operator_id, client_id, service_id,
           starts_at, ends_at, is_mobile, address_line, postcode, lat, lng,
           status, price_cents, source, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?, 'scheduled', ?, 'online', ?, ?)`,
      ).bind(apptId, row.operator_id, clientId, service.id, row.starts_at, endsAt,
        row.is_mobile, input.address_line ?? null, postcode,
        at?.lat ?? null, at?.lng ?? null, price, t, t),

      env.DB.prepare(
        `INSERT INTO public_claims (id, operator_id, gap_id, service_id, client_id,
           appointment_id, first_name, phone_e164, email, address_line, postcode,
           lat, lng, detour_seconds, price_cents, deposit_cents, status,
           created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'confirmed', ?,?)`,
      ).bind(claimId, row.operator_id, row.gap_id ?? input.gapId, service.id, clientId,
        apptId, input.first_name.trim(), phone, input.email ?? null,
        input.address_line ?? null, postcode, at?.lat ?? null, at?.lng ?? null,
        detour, price, row.deposit_cents, t, t),

      env.DB.prepare(
        `UPDATE gaps SET status='filled', filled_appointment_id=?, updated_at=?
          WHERE id=? AND status IN ('open','offering')`,
      ).bind(apptId, t, input.gapId),

      // Anyone the operator had already invited is told it is gone.
      env.DB.prepare(
        `UPDATE gap_offers SET status='superseded', updated_at=?
          WHERE gap_id=? AND status IN ('candidate','queued','sent','delivered','viewed')`,
      ).bind(t, input.gapId),

      env.DB.prepare(
        `UPDATE operators SET calendar_version = calendar_version + 1, updated_at = ?
          WHERE id = ?`,
      ).bind(t, row.operator_id),
    ]);
    if ((res[3]?.meta.changes ?? 0) === 0) {
      throw conflict('Sorry — that slot has just been taken.', 'slot_taken');
    }
  } catch (e) {
    if (String(e).includes('UNIQUE') || String(e).includes('constraint')) {
      throw conflict('Sorry — that slot has just been taken.', 'slot_taken');
    }
    throw e;
  }

  const locale = localeFor(row.country, row.language);

  // After the batch, never inside it. The operator finding out is important;
  // it is not important enough to roll back a booking that already succeeded,
  // which is why notify swallows its own failures.
  await notify(env, row.operator_id, {
    kind: 'public_booking',
    title: `${input.first_name.trim()} booked ${service.name}`,
    body: [
      formatTimeRange(row.starts_at, endsAt, row.timezone, locale),
      formatMoney(price, row.currency, locale),
      input.address_line ?? postcode,
    ].filter(Boolean).join(' · '),
    appointment_id: apptId, claim_id: claimId, starts_at: row.starts_at,
  });

  // Every booking gets a conversation, whether or not they asked anything
  // first. It is how they reach the business without either side handing over
  // a phone number, and the link is the only way back to this booking — there
  // is no account to sign in to.
  let threadToken = '';
  const existing = input.thread_token
    ? await threadByToken(env, input.thread_token)
    : null;
  if (existing && existing.operator_id === row.operator_id) {
    await attachBooking(env, existing.id, { appointment_id: apptId, client_id: clientId });
    threadToken = input.thread_token ?? '';
  } else {
    const started = await startThread(env, {
      operator_id: row.operator_id,
      gap_id: input.gapId,
      appointment_id: apptId,
      client_id: clientId,
      guest_name: input.first_name.trim(),
      subject: service.name,
    });
    threadToken = started.token;
  }

  // The confirmation screen shows the same card as the listing did, so it
  // carries the same facts. Costing two small reads after a booking that has
  // already succeeded is cheaper than a page where the business a customer
  // just paid suddenly has no rating and no photograph on it.
  const [snippets, photoKeys] = await Promise.all([
    snippetsFor(env, [row.operator_id]),
    workPhotoKeysFor(env, [row.operator_id]),
  ]);
  const snippet = snippets.get(row.operator_id) ?? null;

  return {
    appointment_id: apptId,
    thread_token: threadToken,
    slot: {
      gap_id: input.gapId, operator_id: row.operator_id,
      business_name: row.business_name,
      trade: row.trade ?? null,
      profile_slug: row.profile_slug ?? null,
      is_sample: isDemoOperator(row.operator_id),
      service_id: service.id, service_name: service.name,
      starts_at: row.starts_at, ends_at: endsAt,
      duration_seconds: service.duration_seconds,
      price_cents: price, deposit_cents: row.deposit_cents, currency: row.currency,
      when: formatTimeRange(row.starts_at, endsAt, row.timezone, locale),
      price: formatMoney(price, row.currency, locale),
      detour_minutes: detour === null ? null : Math.round(detour / 60),
      anchor_lat: coarsenAnchor(row.prev_lat ?? row.next_lat),
      anchor_lng: coarsenAnchor(row.prev_lng ?? row.next_lng),
      ...cardFacts(row, t),
      review_snippet: snippet,
      work_photo_key: photoKeys.get(row.operator_id) ?? null,
      proximity: null,
    },
  };
}
