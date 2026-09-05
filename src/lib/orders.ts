import type { Env, Point } from '../types';
import { hashOfferToken } from './auth';
import { attachBooking, startThread, threadByToken } from './chat';
import { formatMoney, getCountry, localeFor, normalisePostcode } from './countries';
import { notify } from './feed';
import { partsLine, type PartsPolicy } from './parts';
import { driveSeconds, geocode } from './geo';
import { discounted } from './public';
import { customerStanding } from './standing';
import { newStartCode } from './startcode';
import { formatTimeRange } from './tz';
import { badRequest, conflict, newId, now, toE164 } from './util';

/**
 * Checkout for a basket of openings.
 *
 * The old public flow sold exactly one thing: one gap, one service, and the
 * server picked the service — the most expensive one that fit. A customer who
 * wants a wash and an interior clean, or a slot today and another next week,
 * had no way to say so and no way to pay for it in one go.
 *
 * An order is the customer's side of that transaction. It is not scoped to an
 * operator on purpose: a basket may hold Thursday at one business and Saturday
 * at another, and splitting it into two checkouts is two address forms and two
 * chances to give up.
 */

export interface OrderItemInput {
  gap_id: string;
  service_ids: string[];
}

/** Why an item (or the order) cannot be bought, in words a customer can act on. */
export interface OrderProblem {
  code: string;
  message: string;
}

export interface PricedService {
  service_id: string;
  name: string;
  duration_seconds: number;
  price_cents: number;
  price: string;
  /** 'none' | 'included' | 'quoted' -- see parts.ts and migration 0020. */
  parts_policy: PartsPolicy;
  parts_note: string | null;
  parts_estimate_low_cents: number | null;
  parts_estimate_high_cents: number | null;
  /**
   * The one sentence the customer reads about parts, built in parts.ts so the
   * slot page, the basket, the confirmation and the receipt cannot drift into
   * four different answers to "will my bill go up".
   */
  parts_line: string | null;
}

export interface PricedItem {
  gap_id: string;
  operator_id: string | null;
  business_name: string | null;
  currency: string | null;
  /** When the work would start, and when it would end given everything chosen. */
  starts_at: number | null;
  ends_at: number | null;
  /** The far edge of the opening, so the UI can show the headroom left. */
  gap_ends_at: number | null;
  when: string | null;
  services: PricedService[];
  duration_seconds: number;
  price_cents: number;
  price: string;
  /** False when the chosen services are longer than the opening. */
  fits: boolean;
  problems: OrderProblem[];
}

export interface PricedOrder {
  items: PricedItem[];
  currency: string | null;
  duration_seconds: number;
  total_cents: number;
  total: string;
  /** True only when every item is buyable right now. */
  ok: boolean;
  problems: OrderProblem[];
}

export interface PlaceOrderInput {
  items: OrderItemInput[];
  guest_name: string;
  phone: string;
  email?: string | null;
  address_line?: string | null;
  postcode?: string | null;
  /** Set when they asked a question before booking, so the thread carries on. */
  thread_token?: string | null;
}

export interface PlacedOrderItem {
  order_item_id: string;
  gap_id: string;
  operator_id: string;
  business_name: string;
  appointment_id: string;
  client_id: string;
  starts_at: number;
  ends_at: number;
  price_cents: number;
  services: PricedService[];
}

export interface PlacedOrder {
  order_id: string;
  status: 'pending';
  currency: string;
  total_cents: number;
  total: string;
  items: PlacedOrderItem[];
  /** One conversation per business in the order — a basket can span several. */
  threads: Array<{ operator_id: string; business_name: string; token: string }>;
  /** The first thread's token, for the confirmation link. */
  thread_token: string;
}

/** A basket larger than this is a script, not a customer. */
const MAX_ITEMS = 10;
/** Nobody picks eleven services for one appointment. */
const MAX_SERVICES_PER_ITEM = 10;

interface GapRow {
  gap_id: string; operator_id: string; starts_at: number; ends_at: number;
  is_mobile: number; status: string;
  prev_lat: number | null; prev_lng: number | null;
  next_lat: number | null; next_lng: number | null;
  baseline_drive_seconds: number | null;
  business_name: string; country: string; currency: string; timezone: string;
  language: string; deposit_cents: number; max_detour_seconds: number;
  discount_percent: number; accept_public_bookings: number; plan: string;
  banned_at: number | null; suspended_until: number | null;
  claimed: number;
}

interface ServiceRow {
  id: string; operator_id: string; name: string;
  duration_seconds: number; price_cents: number;
  is_active: number; gap_fill_eligible: number;
  parts_policy: PartsPolicy; parts_note: string | null;
  parts_estimate_low_cents: number | null; parts_estimate_high_cents: number | null;
}

/** Reads every row priceOrder and placeOrder both need, in three queries. */
async function loadContext(env: Env, items: OrderItemInput[]) {
  const gapIds = [...new Set(items.map((i) => String(i?.gap_id ?? '').trim()).filter(Boolean))];
  const serviceIds = [...new Set(items.flatMap((i) =>
    (i?.service_ids ?? []).map((s) => String(s).trim()).filter(Boolean)))];

  const q = (n: number) => new Array(n).fill('?').join(',');

  const [gapRes, svcRes, allowRes] = await Promise.all([
    gapIds.length ? env.DB.prepare(
      `SELECT g.id AS gap_id, g.operator_id, g.starts_at, g.ends_at, g.is_mobile, g.status,
              g.prev_lat, g.prev_lng, g.next_lat, g.next_lng, g.baseline_drive_seconds,
              o.business_name, o.country, o.currency, o.timezone, o.language,
              o.deposit_cents, o.max_detour_seconds, o.discount_percent,
              o.accept_public_bookings, o.plan, o.banned_at, o.suspended_until,
              (SELECT COUNT(*) FROM public_claims c
                WHERE c.gap_id = g.id AND c.status = 'confirmed') AS claimed
         FROM gaps g JOIN operators o ON o.id = g.operator_id
        WHERE g.id IN (${q(gapIds.length)})`,
    ).bind(...gapIds).all<GapRow>() : { results: [] as GapRow[] },

    serviceIds.length ? env.DB.prepare(
      `SELECT id, operator_id, name, duration_seconds, price_cents,
              is_active, gap_fill_eligible, parts_policy, parts_note,
              parts_estimate_low_cents, parts_estimate_high_cents
         FROM services WHERE id IN (${q(serviceIds.length)})`,
    ).bind(...serviceIds).all<ServiceRow>() : { results: [] as ServiceRow[] },

    gapIds.length ? env.DB.prepare(
      `SELECT gap_id, service_id FROM gap_services
        WHERE gap_id IN (${q(gapIds.length)})`,
    ).bind(...gapIds).all<{ gap_id: string; service_id: string }>()
      : { results: [] as Array<{ gap_id: string; service_id: string }> },
  ]);

  const gaps = new Map((gapRes.results ?? []).map((r) => [r.gap_id, r]));
  const services = new Map((svcRes.results ?? []).map((r) => [r.id, r]));

  // A gap with NO rows here means "any eligible service" — see migration 0016.
  // An empty allow-list must never be read as "nothing is bookable", or every
  // gap that existed before this feature stops selling.
  const allowed = new Map<string, Set<string>>();
  for (const r of allowRes.results ?? []) {
    const set = allowed.get(r.gap_id) ?? new Set<string>();
    set.add(r.service_id);
    allowed.set(r.gap_id, set);
  }

  return { gaps, services, allowed };
}

/**
 * What this basket would cost, and what is wrong with it.
 *
 * Writes nothing. The customer sees this before they commit to anything, so it
 * has to be safe to call on every checkbox they tick — a pricing call that had
 * side effects would be claiming slots as people browsed.
 */
export async function priceOrder(
  env: Env, items: Array<OrderItemInput>,
): Promise<PricedOrder> {
  const t = now();
  const list = Array.isArray(items) ? items : [];
  const problems: OrderProblem[] = [];

  if (list.length === 0) {
    problems.push({ code: 'empty_order', message: 'Your basket is empty.' });
  }
  if (list.length > MAX_ITEMS) {
    problems.push({
      code: 'too_many_items',
      message: `An order can hold at most ${MAX_ITEMS} slots.`,
    });
  }

  const { gaps, services, allowed } = await loadContext(env, list.slice(0, MAX_ITEMS));

  const seenGaps = new Set<string>();
  const priced: PricedItem[] = [];

  for (const raw of list.slice(0, MAX_ITEMS)) {
    const gapId = String(raw?.gap_id ?? '').trim();
    const itemProblems: OrderProblem[] = [];
    const gap = gaps.get(gapId);

    // A suspended or banned business is treated exactly as an unlisted one:
    // the same answer a basket assembled before the suspension gets, and the
    // same rule slotsNear, goOnline and listingBlock already apply. Work they
    // have already sold is untouched — this only refuses to sell more.
    const barred = !!gap
      && (gap.banned_at != null
        || (gap.suspended_until != null && gap.suspended_until > t));

    if (!gap || barred || gap.accept_public_bookings !== 1
        || !['trial', 'active'].includes(gap.plan)) {
      priced.push(emptyItem(gapId, [{
        code: 'slot_gone', message: 'That slot is no longer listed.',
      }]));
      continue;
    }
    if (seenGaps.has(gapId)) {
      priced.push(emptyItem(gapId, [{
        code: 'duplicate_gap',
        message: `That slot at ${gap.business_name} is already in your basket.`,
      }]));
      continue;
    }
    seenGaps.add(gapId);

    if (!['open', 'offering'].includes(gap.status) || gap.claimed > 0) {
      itemProblems.push({ code: 'slot_taken', message: 'Sorry — that slot has just been taken.' });
    }
    if (gap.starts_at <= t) {
      itemProblems.push({ code: 'slot_passed', message: 'That slot has already started.' });
    }

    const locale = localeFor(gap.country, gap.language);
    const wanted = [...new Set((raw?.service_ids ?? [])
      .map((s) => String(s).trim()).filter(Boolean))].slice(0, MAX_SERVICES_PER_ITEM);

    if (wanted.length === 0) {
      itemProblems.push({
        code: 'no_service',
        message: `Choose at least one service at ${gap.business_name}.`,
      });
    }

    const allow = allowed.get(gapId);
    const chosen: PricedService[] = [];
    for (const id of wanted) {
      const svc = services.get(id);
      // Same message whichever way it is wrong. Which business owns a service
      // id is not something a checkout form should be able to probe.
      if (!svc || svc.operator_id !== gap.operator_id
          || svc.is_active !== 1 || svc.gap_fill_eligible !== 1) {
        itemProblems.push({
          code: 'bad_service',
          message: `${gap.business_name} does not offer one of the services you picked.`,
        });
        continue;
      }
      // Only when the operator narrowed this opening. No rows = anything goes.
      if (allow && !allow.has(id)) {
        itemProblems.push({
          code: 'service_not_in_slot',
          message: `${svc.name} is not offered in that slot.`,
        });
        continue;
      }
      const price = discounted(svc.price_cents, gap.discount_percent, gap.currency);
      chosen.push({
        service_id: svc.id,
        name: svc.name,
        duration_seconds: svc.duration_seconds,
        price_cents: price,
        price: formatMoney(price, gap.currency, locale),
        parts_policy: svc.parts_policy,
        parts_note: svc.parts_note,
        parts_estimate_low_cents: svc.parts_estimate_low_cents,
        parts_estimate_high_cents: svc.parts_estimate_high_cents,
        parts_line: partsLine(svc, gap.currency, locale),
      });
    }

    const duration = chosen.reduce((a, s) => a + s.duration_seconds, 0);
    const cents = chosen.reduce((a, s) => a + s.price_cents, 0);
    const window = gap.ends_at - gap.starts_at;
    const fits = chosen.length > 0 && duration <= window;
    if (chosen.length > 0 && !fits) {
      itemProblems.push({
        code: 'too_long',
        message: `That is ${Math.ceil((duration - window) / 60)} minutes more than the slot at `
          + `${gap.business_name} can take. Drop a service or pick a longer slot.`,
      });
    }

    priced.push({
      gap_id: gapId,
      operator_id: gap.operator_id,
      business_name: gap.business_name,
      currency: gap.currency,
      starts_at: gap.starts_at,
      ends_at: gap.starts_at + duration,
      gap_ends_at: gap.ends_at,
      when: duration > 0
        ? formatTimeRange(gap.starts_at, gap.starts_at + duration, gap.timezone, locale)
        : null,
      services: chosen,
      duration_seconds: duration,
      price_cents: cents,
      price: formatMoney(cents, gap.currency, locale),
      fits,
      problems: itemProblems,
    });
  }

  // One currency per order. Adding 50 USD to 50 GBP is not a total, it is a
  // number that happens to be 100, and nobody would notice until the refund.
  const currencies = [...new Set(priced.map((i) => i.currency).filter(Boolean))] as string[];
  if (currencies.length > 1) {
    problems.push({
      code: 'mixed_currency',
      message: `These businesses bill in ${currencies.join(' and ')}. `
        + 'Check out one currency at a time.',
    });
  }

  const currency = currencies.length === 1 ? currencies[0]! : null;
  const totalCents = currencies.length === 1
    ? priced.reduce((a, i) => a + i.price_cents, 0)
    : 0;
  const localeRow = priced.find((i) => i.operator_id);
  const gapForLocale = localeRow ? gaps.get(localeRow.gap_id) : undefined;
  const locale = gapForLocale
    ? localeFor(gapForLocale.country, gapForLocale.language) : 'en-US';

  const ok = problems.length === 0 && priced.length > 0
    && priced.every((i) => i.fits && i.problems.length === 0);

  return {
    items: priced,
    currency,
    duration_seconds: priced.reduce((a, i) => a + i.duration_seconds, 0),
    total_cents: totalCents,
    total: formatMoney(totalCents, currency ?? 'USD', locale),
    ok,
    problems,
  };
}

function emptyItem(gapId: string, problems: OrderProblem[]): PricedItem {
  return {
    gap_id: gapId, operator_id: null, business_name: null, currency: null,
    starts_at: null, ends_at: null, gap_ends_at: null, when: null,
    services: [], duration_seconds: 0, price_cents: 0, price: '',
    fits: false, problems,
  };
}

/** 'slot_taken' and friends are a 409; everything else the customer typed is a 400. */
const CONFLICT_CODES = new Set(['slot_gone', 'slot_taken', 'slot_passed', 'too_far']);

function raise(problems: OrderProblem[]): never {
  const first = problems[0]!;
  throw CONFLICT_CODES.has(first.code)
    ? conflict(first.message, first.code)
    : badRequest(first.message, first.code);
}

/**
 * Take the whole basket.
 *
 * ALL OR NOTHING, and that is the entire design of this function.
 *
 * Somebody who chose a wash and an interior clean, or a slot today and another
 * on Saturday, agreed to one thing. Booking two of the three and telling them
 * the rest failed leaves them with a half-day they did not want, at a price
 * they did not agree to, and a cancellation they now have to arrange by hand —
 * for a business they have never dealt with. There is no partial version of
 * this purchase that is better than no purchase, so if any item's gap has gone
 * the whole order fails and not one row is written.
 *
 * That is why every statement for every item goes into ONE db.batch. Claiming
 * item by item — a batch each, as the single-slot claimSlot does — would leave
 * the earlier items committed when a later one hits the unique index, and no
 * amount of compensating writes afterwards makes that invisible to the
 * operator whose calendar already changed. The race guarantee itself is
 * unchanged and comes from the same place claimSlot gets it: the partial
 * unique index of one confirmed claim per gap. Losing that race now rolls the
 * batch back instead of just one claim.
 */
export async function placeOrder(env: Env, input: PlaceOrderInput): Promise<PlacedOrder> {
  const t = now();
  const guestName = (input?.guest_name ?? '').trim();
  if (!guestName) throw badRequest('We need a name for the booking.', 'no_name');

  const priced = await priceOrder(env, input?.items ?? []);
  if (priced.problems.length) raise(priced.problems);
  const firstBad = priced.items.find((i) => i.problems.length);
  if (firstBad) raise(firstBad.problems);
  if (!priced.ok || !priced.currency) {
    raise([{ code: 'not_bookable', message: 'That basket cannot be booked right now.' }]);
  }

  const { gaps } = await loadContext(env, input.items);
  const rows = priced.items.map((i) => gaps.get(i.gap_id)!);

  // The phone is one number and the basket may span countries, so it is tried
  // against each country in the order rather than assumed to be the first
  // one's. A silently mangled number is a booking the business cannot chase.
  let phone: string | null = null;
  for (const c of [...new Set(rows.map((r) => r.country))]) {
    phone = toE164(input.phone, c);
    if (phone) break;
  }
  if (!phone) throw badRequest('That does not look like a valid mobile number.', 'bad_phone');

  // Checked after the number is normalised, so a suspension cannot be stepped
  // around by typing the same number a different way.
  const standing = await customerStanding(env, phone);
  if (standing.blocked) throw conflict(standing.message!, 'suspended');

  const postcode = input.postcode ? normalisePostcode(input.postcode) : null;
  const needsAddress = rows.some((r) => r.is_mobile === 1);
  if (needsAddress && !postcode && !input.address_line) {
    throw badRequest('We need an address so we know they can reach you.', 'no_address');
  }

  const home = rows[0]!;
  const at = await geocode(env, input.address_line ?? null, postcode, home.country);
  if (needsAddress && !at) {
    const country = getCountry(home.country);
    throw badRequest(
      `We could not find that address in ${country?.name ?? home.country}.`, 'bad_address');
  }

  // Re-check the drive time per item, the same check claimSlot makes. A basket
  // is assembled over minutes and the jobs either side of each gap can move
  // while it is being filled.
  const detours = new Map<string, number | null>();
  for (const item of priced.items) {
    const row = gaps.get(item.gap_id)!;
    if (!at || row.is_mobile !== 1) { detours.set(item.gap_id, null); continue; }
    const pairs: [Point, Point][] = [];
    if (row.prev_lat != null) pairs.push([{ lat: row.prev_lat, lng: row.prev_lng! }, at]);
    if (row.next_lat != null) pairs.push([at, { lat: row.next_lat, lng: row.next_lng! }]);
    const secs = await driveSeconds(env, row.operator_id, pairs);
    const travel = secs.reduce((a, b) => a + b, 0);
    const detour = Math.max(0, travel - (row.baseline_drive_seconds ?? 0));
    if (detour > row.max_detour_seconds
        || item.duration_seconds + travel > row.ends_at - row.starts_at) {
      throw conflict(
        `${row.business_name} is now too far from their route for that slot.`, 'too_far');
    }
    detours.set(item.gap_id, detour);
  }

  // ---------------------------------------------------------------------
  // PAYMENT SEAM — nothing is charged here yet.
  //
  // The intent is that the FULL price of the order is taken at checkout, not
  // a deposit: this basket may be three services across two businesses, and
  // a customer who has paid in full does not casually not show up. The
  // authorisation belongs on this line, before the claims are written, and
  // the capture belongs immediately after the batch below commits — so a
  // customer is never charged for slots the batch then failed to claim.
  //
  // Until that exists, orders.status stays 'pending': the slots are held and
  // no money has moved, which is the honest description of this state. The
  // payment step is what writes 'confirmed'.
  // ---------------------------------------------------------------------

  const orderId = newId();
  const writes: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO orders (id, status, guest_name, phone_e164, email, address_line,
         postcode, lat, lng, currency, total_cents, created_at, updated_at)
       VALUES (?,'pending',?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(orderId, guestName, phone, input.email ?? null, input.address_line ?? null,
      postcode, at?.lat ?? null, at?.lng ?? null, priced.currency, priced.total_cents, t, t),
  ];

  // One client row per business in the order, not one per item. Two slots at
  // the same salon are one person on that salon's list; a row each would show
  // the operator two customers with the same phone number and split their
  // history in half. A second business in the basket does need its own row —
  // clients are the operator's, and there is no shared customer table.
  const clientByOperator = new Map<string, string>();
  const gapUpdateIndex = new Map<string, number>();
  const placed: PlacedOrderItem[] = [];

  for (const item of priced.items) {
    const row = gaps.get(item.gap_id)!;

    // The most valuable service leads, matching how the single-slot path picks
    // one, so appointments.service_id and public_claims.service_id name the
    // headline job. The full list is on order_item_services, which is the
    // record of what was actually bought.
    const primary = item.services.reduce((a, b) => (b.price_cents > a.price_cents ? b : a));
    const endsAt = Math.min(row.starts_at + item.duration_seconds, row.ends_at);

    let clientId = clientByOperator.get(row.operator_id);
    if (!clientId) {
      clientId = newId();
      clientByOperator.set(row.operator_id, clientId);
      // NO PHONE, NO EMAIL, NO SURNAME on the operator's client row.
      //
      // This used to write all three and mask them on the way out of the API.
      // That is the wrong place to solve it: a filter over four queries is one
      // forgotten query away from failing, it fails silently, and meanwhile
      // the number sits in the table for every backup and every future
      // endpoint to carry. Not writing it is the only version that stays true
      // when somebody adds a fifth query next year.
      //
      // The address IS written, because the operator has to drive there and a
      // product that hides it does not work. It is cleared when the booking is
      // cancelled -- see bypass.ts.
      //
      // The customer's contact details live on the order, which is the
      // platform's record rather than the operator's list. That is what makes
      // "they cannot walk away with your number" a fact about the schema
      // instead of a promise about our query hygiene.
      writes.push(env.DB.prepare(
        `INSERT INTO clients (id, operator_id, first_name, phone_e164, email,
           address_line, postcode, lat, lng, geocode_status, geocoded_at,
           default_service_id, sms_consent, sms_consent_at, acquired,
           platform_introduced, created_at, updated_at)
         VALUES (?,?,?,NULL,NULL,?,?,?,?,?,?,?,0,NULL, 'public', 1, ?,?)`,
      ).bind(clientId, row.operator_id, guestName,
        input.address_line ?? null, postcode, at?.lat ?? null, at?.lng ?? null,
        at ? 'ok' : 'failed', at ? t : null, primary.service_id, t, t));
    }

    const apptId = newId();
    const claimId = newId();
    const itemId = newId();

    writes.push(env.DB.prepare(
      `INSERT INTO appointments (id, operator_id, client_id, service_id,
         starts_at, ends_at, is_mobile, address_line, postcode, lat, lng,
         status, price_cents, source, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, 'scheduled', ?, 'online', ?, ?)`,
    ).bind(apptId, row.operator_id, clientId, primary.service_id, row.starts_at, endsAt,
      row.is_mobile, input.address_line ?? null, postcode,
      at?.lat ?? null, at?.lng ?? null, item.price_cents, t, t));

    // The row the race is decided on: one confirmed claim per gap, enforced by
    // the partial unique index from migration 0006.
    writes.push(env.DB.prepare(
      `INSERT INTO public_claims (id, operator_id, gap_id, service_id, client_id,
         appointment_id, first_name, phone_e164, email, address_line, postcode,
         lat, lng, detour_seconds, price_cents, deposit_cents, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'confirmed', ?,?)`,
    ).bind(claimId, row.operator_id, item.gap_id, primary.service_id, clientId, apptId,
      guestName, phone, input.email ?? null, input.address_line ?? null, postcode,
      at?.lat ?? null, at?.lng ?? null, detours.get(item.gap_id) ?? null,
      item.price_cents, row.deposit_cents, t, t));

    gapUpdateIndex.set(item.gap_id, writes.length);
    writes.push(env.DB.prepare(
      `UPDATE gaps SET status='filled', filled_appointment_id=?, updated_at=?
        WHERE id=? AND status IN ('open','offering')`,
    ).bind(apptId, t, item.gap_id));

    writes.push(env.DB.prepare(
      `UPDATE gap_offers SET status='superseded', updated_at=?
        WHERE gap_id=? AND status IN ('candidate','queued','sent','delivered','viewed')`,
    ).bind(t, item.gap_id));

    writes.push(env.DB.prepare(
      `INSERT INTO order_items (id, order_id, operator_id, gap_id, appointment_id,
         client_id, starts_at, ends_at, duration_seconds, price_cents, created_at,
         address_released_at, start_code)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(itemId, orderId, row.operator_id, item.gap_id, apptId, clientId,
      row.starts_at, endsAt, item.duration_seconds, item.price_cents, t,
      // The street address is released to the operator HERE and nowhere
      // earlier: before a booking exists they get the neighbourhood, because
      // an operator who can read addresses off unbooked slots has a lead list,
      // not a marketplace. Cancelling clears this again -- see bypass.ts.
      t,
      // The four digits the customer reads out on the doorstep. Generated
      // once, here, so it exists from the moment the booking does and there
      // is never a window where a job can start without one.
      newStartCode()));

    for (const s of item.services) {
      // Copied, not joined — see migration 0016. The operator may rename or
      // reprice this service tomorrow; the receipt must not change with it.
      writes.push(env.DB.prepare(
        `INSERT INTO order_item_services
           (id, order_item_id, service_id, name, duration_seconds, price_cents,
            parts_policy, parts_note, parts_estimate_low_cents, parts_estimate_high_cents)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).bind(newId(), itemId, s.service_id, s.name, s.duration_seconds, s.price_cents,
        s.parts_policy, s.parts_note,
        s.parts_estimate_low_cents, s.parts_estimate_high_cents));
    }

    placed.push({
      order_item_id: itemId,
      gap_id: item.gap_id,
      operator_id: row.operator_id,
      business_name: row.business_name,
      appointment_id: apptId,
      client_id: clientId,
      starts_at: row.starts_at,
      ends_at: endsAt,
      price_cents: item.price_cents,
      services: item.services,
    });
  }

  for (const operatorId of new Set(rows.map((r) => r.operator_id))) {
    writes.push(env.DB.prepare(
      `UPDATE operators SET calendar_version = calendar_version + 1, updated_at = ?
        WHERE id = ?`,
    ).bind(t, operatorId));
  }

  let res: D1Result[];
  try {
    res = await env.DB.batch(writes);
  } catch (e) {
    if (String(e).includes('UNIQUE') || String(e).includes('constraint')) {
      throw conflict(
        'One of those slots was taken while you were checking out. '
        + 'Nothing has been booked — please pick again.', 'slot_taken');
    }
    throw e;
  }

  // A gap that changed zero rows was not taken by another claim — that would
  // have hit the unique index and rolled the batch back — it was withdrawn by
  // the operator between pricing and paying. Rare, but it leaves an order
  // pointing at a slot that is no longer for sale, so the order is voided
  // rather than left looking successful.
  const stolen = [...gapUpdateIndex.entries()]
    .filter(([, i]) => (res[i]?.meta.changes ?? 0) === 0);
  if (stolen.length) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE orders SET status='failed', updated_at=? WHERE id=?`)
        .bind(t, orderId),
      ...placed.map((p) => env.DB.prepare(
        `UPDATE public_claims SET status='cancelled', updated_at=? WHERE appointment_id=?`,
      ).bind(t, p.appointment_id)),
      ...placed.map((p) => env.DB.prepare(
        `UPDATE appointments SET status='cancelled', cancelled_at=?, cancelled_by='operator',
           updated_at=? WHERE id=?`,
      ).bind(t, t, p.appointment_id)),
    ]);
    throw conflict(
      'One of those slots was withdrawn while you were checking out. '
      + 'Nothing has been booked — please pick again.', 'slot_taken');
  }

  // Everything below this line happens after the money-shaped part is done.
  // The operator hearing about it matters; it does not matter enough to undo a
  // booking that already succeeded, which is why notify swallows its failures.
  for (const p of placed) {
    const row = gaps.get(p.gap_id)!;
    const locale = localeFor(row.country, row.language);
    await notify(env, p.operator_id, {
      kind: 'public_booking',
      title: `${guestName} booked ${p.services.map((s) => s.name).join(' + ')}`,
      body: [
        formatTimeRange(p.starts_at, p.ends_at, row.timezone, locale),
        formatMoney(p.price_cents, row.currency, locale),
        input.address_line ?? postcode,
      ].filter(Boolean).join(' · '),
      appointment_id: p.appointment_id, claim_id: null, starts_at: p.starts_at,
    });
  }

  // One conversation per business, because a basket can span two and there is
  // no shared inbox between them. An existing thread is reused only for the
  // business it already belongs to.
  const existing = input.thread_token ? await threadByToken(env, input.thread_token) : null;
  const threads: Array<{ operator_id: string; business_name: string; token: string }> = [];
  for (const operatorId of new Set(placed.map((p) => p.operator_id))) {
    const mine = placed.filter((p) => p.operator_id === operatorId);
    const row = gaps.get(mine[0]!.gap_id)!;
    if (existing && existing.operator_id === operatorId && input.thread_token) {
      await attachBooking(env, existing.id, {
        appointment_id: mine[0]!.appointment_id, client_id: mine[0]!.client_id,
      });
      threads.push({ operator_id: operatorId, business_name: row.business_name,
        token: input.thread_token });
      continue;
    }
    const started = await startThread(env, {
      operator_id: operatorId,
      gap_id: mine[0]!.gap_id,
      appointment_id: mine[0]!.appointment_id,
      client_id: mine[0]!.client_id,
      guest_name: guestName,
      subject: mine.flatMap((p) => p.services.map((s) => s.name)).join(' + '),
    });
    threads.push({ operator_id: operatorId, business_name: row.business_name,
      token: started.token });
  }

  // Only the hash is stored, the same as every other guest secret here.
  if (threads.length) {
    await env.DB.prepare(`UPDATE orders SET thread_token_hash=?, updated_at=? WHERE id=?`)
      .bind(await hashOfferToken(threads[0]!.token, env), t, orderId).run();
  }

  return {
    order_id: orderId,
    status: 'pending',
    currency: priced.currency,
    total_cents: priced.total_cents,
    total: priced.total,
    items: placed,
    threads,
    thread_token: threads[0]?.token ?? '',
  };
}
