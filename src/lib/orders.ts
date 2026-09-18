import type { Env, Point } from '../types';
import { hashOfferToken } from './auth';
import { attachBooking, startThread, threadByToken } from './chat';
import { formatMoney, getCountry, localeFor, normalisePostcode } from './countries';
import { isDemoOperator } from './demo';
import { notify } from './feed';
import { partsLine, type PartsPolicy } from './parts';
import { driveSeconds, geocode } from './geo';
import { businessBehindAccount, discounted } from './public';
import { claimPhoneHash, firstNameOnly } from './redact';
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

/**
 * The account this order belongs to, resolved by the route before it calls in.
 *
 * Present on every order placed since migration 0037: the checkout confirms a
 * mobile number with a code and hands the account down. It is optional in the
 * TYPE and not in the product, and the distinction is worth being exact about.
 * Whether an account is REQUIRED is decided at the door — in index.ts, where
 * the session and the cookie live — for the same reason requireOperator is a
 * route-level gate and not something every library function re-derives. What
 * this type says is only that placeOrder can still be called without one, and
 * the two callers that do are the ones that must be able to: the tests, and
 * any future path where the customer has been identified some other way.
 */
export interface OrderAccount {
  id: string;
  /** E.164, off the account row. Never off the request body — see below. */
  phone: string;
  /**
   * The account's identity, off the account row and never off the request
   * body. This is what standing is counted against and what claimGuestHistory
   * matches on, so taking it from the body would be taking the one thing that
   * is supposed to be proved from the one place nobody has proved anything.
   */
  login_email: string;
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
  /** Set once the checkout has confirmed a mobile number. */
  account?: OrderAccount | null;
  /**
   * The processor's reference to the card this order would be charged to,
   * copied off the account at checkout.
   *
   * NULL IN EVERY ORDER TODAY, because Stripe is not wired and nothing exists
   * that produces a reference. See the PAYMENT SEAM below.
   */
  card?: { ref: string; brand?: string | null; last4?: string | null } | null;
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
  /** 1 once the business has somewhere its share can actually be sent. */
  stripe_payouts_enabled: number;
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
              o.stripe_payouts_enabled,
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
      message: `An order can hold at most ${MAX_ITEMS} openings.`,
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

    // A BUSINESS WITH NOWHERE TO BE PAID CANNOT BE SOLD.
    //
    // listingBlock refuses to publish an opening for one, but it is only
    // consulted when an opening is posted or a profile is published — and the
    // cron builds gaps for every operator on a live plan, so an opening could
    // reach the map, be booked, and take a real card payment for a business
    // whose share has nowhere to go. The money then sits in the platform
    // balance with no payout and nothing in the product to resolve it.
    //
    // Treated as an unlisted opening rather than as its own refusal, because
    // that is what it is from the customer's side and the alternative is
    // telling a stranger about somebody's bank arrangements. That reasoning
    // holds for a REAL business and only for a real business: there is a person
    // behind it whose banking is nobody else's business, and the vaguer answer
    // is the kind one. The sample check below runs first precisely so this
    // branch is never the thing that answers for a business that does not
    // exist — nothing about invented data is anyone's private affair.
    const unpayable = !!gap && gap.stripe_payouts_enabled !== 1;

    // A SAMPLE BUSINESS SAYS IT IS A SAMPLE BUSINESS, AND SAYS IT FIRST.
    //
    // The seeded businesses in lib/demo.ts exist so the map is not blank before
    // anybody has signed up, and they are deliberately left on the public page
    // with a SAMPLE LISTING badge on them. None of them has a Stripe account,
    // so every one of them is `unpayable` above — which meant that every
    // opening on the map, which before anybody signs up is the whole of what a
    // visitor can see, answered the tap with "That opening is no longer
    // listed."
    //
    // That sentence was false twice over. The opening WAS still listed, on the
    // page the customer was looking at as they read it; and it sent them off to
    // wait for a relisting that is never coming, when the real answer is that
    // there is no business at the other end and there never was. A refusal a
    // customer cannot act on is worse than no listing at all.
    //
    // Checked BEFORE the unlisted branch below, so a sample never reports as
    // gone, and before `barred` too: a suspended sample business is still a
    // sample business, and "this is not real" is the fact the customer needs
    // rather than a disciplinary state invented for data we made up.
    //
    // Not in CONFLICT_CODES, so placeOrder answers 400 rather than 409: nothing
    // raced and nothing changed underneath anybody. The basket is asking for
    // something that was never for sale.
    if (gap && isDemoOperator(gap.operator_id)) {
      priced.push(emptyItem(gapId, [{
        code: 'sample_listing',
        message: `${gap.business_name} is sample data, not a real business, so it `
          + 'cannot be booked. It is listed so the map is not blank before anyone '
          + 'has signed up.',
      }]));
      continue;
    }

    if (!gap || barred || unpayable || gap.accept_public_bookings !== 1
        || !['trial', 'active'].includes(gap.plan)) {
      priced.push(emptyItem(gapId, [{
        code: 'slot_gone', message: 'That opening is no longer listed.',
      }]));
      continue;
    }
    if (seenGaps.has(gapId)) {
      priced.push(emptyItem(gapId, [{
        code: 'duplicate_gap',
        message: `That opening at ${gap.business_name} is already in your basket.`,
      }]));
      continue;
    }
    seenGaps.add(gapId);

    if (!['open', 'offering'].includes(gap.status) || gap.claimed > 0) {
      itemProblems.push({ code: 'slot_taken', message: 'Sorry — that opening has just been taken.' });
    }
    if (gap.starts_at <= t) {
      itemProblems.push({ code: 'slot_passed', message: 'That opening has already started.' });
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
          message: `${svc.name} is not offered in that opening.`,
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
        message: `That is ${Math.ceil((duration - window) / 60)} minutes more than the opening at `
          + `${gap.business_name} can take. Drop a service or pick a longer opening.`,
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

// ---------------------------------------------------------------------------
// The rows a booking is made of
// ---------------------------------------------------------------------------

/**
 * The statements that turn "somebody agreed to this" into a booking, pulled
 * out of placeOrder so there is exactly one of them.
 *
 * WHY THESE ARE NOT SIMPLY INSIDE placeOrder ANY MORE. placeOrder sells a
 * POSTED opening: it prices a basket of gaps, re-checks the drive time, claims
 * each gap against the unique index that decides the race, and marks the gap
 * filled. An accepted estimate (see lib/estimates.ts) has none of that — the
 * whole point of an estimate is that no gap was ever posted — but it needs the
 * identical order, client, appointment, order_item and order_item_services
 * rows, because that is what start codes, photographs, arrival, cancellation,
 * refunds and settlement are all written against.
 *
 * The alternative was a second set of INSERTs in estimates.ts with the same
 * columns in the same tables, and that is the arrangement where the two drift:
 * somebody adds a column here, fixes the bug here, and the other path silently
 * keeps producing bookings that are missing it. A booking that came in through
 * a quote must be indistinguishable, from the row down, from one that came in
 * through a slot — otherwise every feature downstream has to learn about two
 * kinds of booking, and half of them will not.
 *
 * So the gap-specific writes (public_claims, the gaps flip, superseding the
 * offers) stay in placeOrder, where the gap is, and everything that is true of
 * ANY booking lives in the four builders below.
 */

/**
 * A condition every write of one booking is made conditional on.
 *
 * A D1 batch is one transaction, but a transaction commits whatever its
 * statements matched — an unguarded INSERT inside it still lands even when the
 * guarded UPDATE beside it matched nothing. offers.ts learnt that the
 * expensive way (see acceptOffer) and parts.ts carries the same fragment under
 * the name `stillSent`. So a caller that has a race to settle passes the
 * condition in here and it is appended to every row it writes, which makes
 * "all of it or none of it" true of the batch rather than merely intended.
 *
 * Callers with no race to settle — placeOrder, which settles its own on a
 * unique index — pass nothing and get the plain statements.
 */
export interface WriteGuard {
  /** A boolean SQL expression, e.g. `EXISTS (SELECT 1 FROM estimates …)`. */
  sql: string;
  /** Bound after the row's own values, because the guard is always last. */
  args: unknown[];
}

/**
 * `INSERT INTO t (…) SELECT ?,?,?` rather than `VALUES (?,?,?)` throughout, so
 * that a guard is one appended WHERE rather than a second spelling of every
 * statement. SQLite allows a SELECT with no FROM, and the two forms insert the
 * same row; this is the shape offers.ts and parts.ts already use.
 */
const withGuard = (sql: string, guard?: WriteGuard | null): string =>
  (guard ? `${sql} WHERE ${guard.sql}` : sql);

/** The same, for a statement that already has a WHERE clause of its own. */
const andGuard = (sql: string, guard?: WriteGuard | null): string =>
  (guard ? `${sql} AND ${guard.sql}` : sql);

const guardArgs = (guard?: WriteGuard | null): unknown[] => guard?.args ?? [];

/**
 * Where the job happens, snapshotted onto every row that records it.
 *
 * Copied and never joined, for the reason the schema gives in migration 0016:
 * a client edits their address, and a booking that read through to the client
 * row would rewrite where last month's job took place.
 */
export interface BookingPlace {
  address_line: string | null;
  postcode: string | null;
  lat: number | null;
  lng: number | null;
}

/** Nothing known about where. What an estimate has until somebody says. */
export const NOWHERE: BookingPlace = {
  address_line: null, postcode: null, lat: null, lng: null,
};

/** One line of the receipt. Copied, never joined — see migration 0016. */
export interface BookingReceiptLine {
  /** Kept for reporting, and nullable because a bespoke job priced no service. */
  service_id: string | null;
  name: string;
  duration_seconds: number;
  price_cents: number;
  parts_policy: PartsPolicy;
  parts_note: string | null;
  parts_estimate_low_cents: number | null;
  parts_estimate_high_cents: number | null;
}

export interface NewOrderRow {
  id: string;
  account_id: string | null;
  guest_name: string;
  /** E.164. NULL when nobody has ever proved a number for this customer. */
  phone: string | null;
  login_email: string | null;
  email: string | null;
  place: BookingPlace;
  currency: string;
  total_cents: number;
  card: { ref: string; brand?: string | null; last4?: string | null } | null;
  at: number;
}

/**
 * The order itself, always 'pending'.
 *
 * 'pending' is the honest state for a row this function writes: the time is
 * held and no money has moved. startPayment in lib/checkout.ts opens the
 * charge against it and the webhook writes 'confirmed'. Nothing here ever
 * writes a paid state, and nothing that calls it is allowed to either.
 *
 * The card reference is COPIED onto the order rather than read off the account
 * when the charge eventually happens. An account's card changes; what the
 * customer agreed to does not, and a capture that silently followed whichever
 * card is on the account today would charge a card the person never associated
 * with this booking. Only the processor's opaque handle is ever written — see
 * lib/payments.ts, which refuses anything card-shaped at every D1 bind
 * whatever this line says.
 */
export function orderWrite(
  env: Env, o: NewOrderRow, guard?: WriteGuard | null,
): D1PreparedStatement {
  return env.DB.prepare(withGuard(
    `INSERT INTO orders (id, status, customer_account_id, guest_name, phone_e164,
       login_email, email, address_line, postcode, lat, lng, currency, total_cents,
       payment_ref, payment_brand, payment_last4, created_at, updated_at)
     SELECT ?,'pending',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?`, guard),
  ).bind(o.id, o.account_id, o.guest_name, o.phone, o.login_email || null,
    o.email ?? null, o.place.address_line, o.place.postcode, o.place.lat, o.place.lng,
    o.currency, o.total_cents,
    o.card?.ref ?? null, o.card?.brand ?? null, o.card?.last4 ?? null, o.at, o.at,
    ...guardArgs(guard));
}

export interface NewClientRow {
  id: string;
  operator_id: string;
  /** First name only. See firstNameOnly in lib/redact.ts. */
  first_name: string;
  place: BookingPlace;
  /**
   * 'ok' when the address resolved to a point, 'failed' when it was given and
   * did not, 'pending' when none was ever asked for. The third is not the same
   * as the second and must not be written as it: "we could not find it" sends
   * an operator looking for a typo in an address nobody typed.
   */
  geocode_status: 'pending' | 'ok' | 'failed' | 'manual';
  /** What this client came in for, so their next booking pre-fills. */
  default_service_id: string | null;
  at: number;
}

/**
 * The operator's own row for this customer.
 *
 * NO PHONE, NO EMAIL, NO SURNAME on it.
 *
 * This used to write all three and mask them on the way out of the API. That
 * is the wrong place to solve it: a filter over four queries is one forgotten
 * query away from failing, it fails silently, and meanwhile the number sits in
 * the table for every backup and every future endpoint to carry. Not writing
 * it is the only version that stays true when somebody adds a fifth query next
 * year.
 *
 * The address IS written, because the operator has to drive there and a
 * product that hides it does not work. It is cleared when the booking is
 * cancelled — see bypass.ts.
 *
 * The customer's contact details live on the order, which is the platform's
 * record rather than the operator's list. That is what makes "they cannot walk
 * away with your number" a fact about the schema instead of a promise about
 * our query hygiene.
 */
export function clientWrite(
  env: Env, c: NewClientRow, guard?: WriteGuard | null,
): D1PreparedStatement {
  return env.DB.prepare(withGuard(
    `INSERT INTO clients (id, operator_id, first_name, phone_e164, email,
       address_line, postcode, lat, lng, geocode_status, geocoded_at,
       default_service_id, sms_consent, sms_consent_at, acquired,
       platform_introduced, created_at, updated_at)
     SELECT ?,?,?,NULL,NULL,?,?,?,?,?,?,?,0,NULL,'public',1,?,?`, guard),
  ).bind(c.id, c.operator_id, c.first_name,
    c.place.address_line, c.place.postcode, c.place.lat, c.place.lng,
    c.geocode_status, c.geocode_status === 'ok' ? c.at : null,
    c.default_service_id, c.at, c.at, ...guardArgs(guard));
}

export interface NewBookingLine {
  order_id: string;
  operator_id: string;
  client_id: string;
  /**
   * The appointment's id, when the caller needs to know it BEFORE these
   * statements are built rather than after.
   *
   * That is not a convenience. A caller whose guard asks "is this hour still
   * free?" — see decideEstimate — has to exclude the appointment this batch is
   * itself inserting, or every statement after the appointment collides with
   * it and writes nothing, which is a booking that silently loses its order
   * line, its receipt and its acceptance. Excluding it needs the id, and the
   * id has to exist before the guard does. Left out, one is minted here.
   */
  appointment_id?: string;
  /** The posted opening this fills, or NULL when nothing was posted. */
  gap_id: string | null;
  /** The headline job on the calendar row. NULL when no service priced it. */
  service_id: string | null;
  starts_at: number;
  ends_at: number;
  duration_seconds: number;
  price_cents: number;
  is_mobile: number;
  place: BookingPlace;
  services: BookingReceiptLine[];
  at: number;
}

export interface BookingLineWrites {
  appointment_id: string;
  order_item_id: string;
  /** The four digits the customer reads out on the doorstep. */
  start_code: string;
  writes: D1PreparedStatement[];
}

/**
 * One line of a booking: the calendar entry, the order line, and the receipt.
 *
 * These three go together and are never written apart. An appointment with no
 * order_item is work with no money behind it and no start code; an order_item
 * with no appointment is a charge for a job that is on nobody's calendar.
 *
 * source = 'online' on the appointment whether a gap or a quote sold it,
 * because from the operator's calendar both are the same fact: this came in
 * through the public side of the product rather than being typed in or
 * imported. A fifth source value for estimates would mean every query that
 * filters on 'online' — and there are several — quietly stopped covering them.
 */
export function bookingLineWrites(
  env: Env, line: NewBookingLine, guard?: WriteGuard | null,
): BookingLineWrites {
  const appointmentId = line.appointment_id ?? newId();
  const orderItemId = newId();
  const startCode = newStartCode();
  const t = line.at;

  const writes: D1PreparedStatement[] = [
    env.DB.prepare(withGuard(
      `INSERT INTO appointments (id, operator_id, client_id, service_id,
         starts_at, ends_at, is_mobile, address_line, postcode, lat, lng,
         status, price_cents, source, created_at, updated_at)
       SELECT ?,?,?,?,?,?,?,?,?,?,?, 'scheduled', ?, 'online', ?, ?`, guard),
    ).bind(appointmentId, line.operator_id, line.client_id, line.service_id,
      line.starts_at, line.ends_at, line.is_mobile,
      line.place.address_line, line.place.postcode, line.place.lat, line.place.lng,
      line.price_cents, t, t, ...guardArgs(guard)),

    env.DB.prepare(withGuard(
      `INSERT INTO order_items (id, order_id, operator_id, gap_id, appointment_id,
         client_id, starts_at, ends_at, duration_seconds, price_cents, created_at,
         address_released_at, start_code)
       SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?`, guard),
    ).bind(orderItemId, line.order_id, line.operator_id, line.gap_id, appointmentId,
      line.client_id, line.starts_at, line.ends_at, line.duration_seconds,
      line.price_cents, t,
      // The street address is released to the operator HERE and nowhere
      // earlier: before a booking exists they get the neighbourhood, because
      // an operator who can read addresses off unbooked slots has a lead list,
      // not a marketplace. Cancelling clears this again — see bypass.ts.
      t,
      // Generated once, here, so it exists from the moment the booking does
      // and there is never a window where a job can start without one.
      startCode, ...guardArgs(guard)),
  ];

  for (const s of line.services) {
    // Copied, not joined — see migration 0016. The operator may rename or
    // reprice this service tomorrow; the receipt must not change with it.
    writes.push(env.DB.prepare(withGuard(
      `INSERT INTO order_item_services
         (id, order_item_id, service_id, name, duration_seconds, price_cents,
          parts_policy, parts_note, parts_estimate_low_cents, parts_estimate_high_cents)
       SELECT ?,?,?,?,?,?,?,?,?,?`, guard),
    ).bind(newId(), orderItemId, s.service_id, s.name, s.duration_seconds, s.price_cents,
      s.parts_policy, s.parts_note,
      s.parts_estimate_low_cents, s.parts_estimate_high_cents, ...guardArgs(guard)));
  }

  return {
    appointment_id: appointmentId,
    order_item_id: orderItemId,
    start_code: startCode,
    writes,
  };
}

/**
 * Tells the operator's open calendar that something moved under it.
 *
 * In the same batch as the booking, not after it: a calendar that has a new
 * appointment in it and an unchanged version is a screen that will not refresh
 * until something else happens to bump it.
 */
export function calendarBumpWrite(
  env: Env, operatorId: string, at: number, guard?: WriteGuard | null,
): D1PreparedStatement {
  return env.DB.prepare(andGuard(
    `UPDATE operators SET calendar_version = calendar_version + 1, updated_at = ?
      WHERE id = ?`, guard),
  ).bind(at, operatorId, ...guardArgs(guard));
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
  // Only the first word of it, and that is not a tidy-up. This name is written
  // onto the operator's own client row, so "Jane Smith" typed into one box was
  // a surname handed to the business beside a street address -- the exact pair
  // redact.ts deletes last_name to prevent. The checkout now asks for a first
  // name and says why; this is what makes it true of a request the checkout
  // did not send. See firstNameOnly.
  const guestName = firstNameOnly(input?.guest_name);
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

  // THE NUMBER COMES OFF THE ACCOUNT, NOT OUT OF THE FORM.
  //
  // This is the single line that makes the no-show ladder survive accounts
  // existing. The number is what customer_standing is keyed on, so if a
  // signed-in customer could put any number they liked in the checkout, a
  // suspended person would sign in, type a friend's mobile, and book — and
  // every rung of the ladder in standing.ts would be one text box wide. Their
  // account's number is one they have proved they own by receiving a code at
  // it; what is typed into a form is a claim about somebody else's phone.
  //
  // Without an account there is nothing better than the form, and the number
  // is tried against each country in the basket rather than assumed to be the
  // first one's, because a silently mangled number is a booking the business
  // cannot chase.
  let phone: string | null = input.account?.phone ?? null;
  if (!phone) {
    for (const c of [...new Set(rows.map((r) => r.country))]) {
      phone = toE164(input.phone, c);
      if (phone) break;
    }
  }
  if (!phone) throw badRequest('That does not look like a valid mobile number.', 'bad_phone');

  // COUNTED AGAINST THE ADDRESS, NOT THE NUMBER, since migration 0038. The
  // number on this order is whatever was typed into the form and nobody has
  // proved it, so a suspension hung on one would be escapable with the
  // backspace key. The address is the thing somebody has demonstrated they can
  // read mail at, and it is therefore the only thing a sanction can hold on to.
  //
  // A guest checkout has no account and so has no proved address: it reaches
  // here only through checkoutAccount, which refuses without a verified code,
  // so `login_email` below is never empty on a path that books anything.
  const loginEmail = input.account?.login_email ?? '';
  const standing = await customerStanding(env, loginEmail);
  if (standing.blocked) throw conflict(standing.message!, 'suspended');

  // NOBODY BUYS THEIR OWN OPENING.
  //
  // A business can open the customer side of the product and book other trades
  // since migration 0042, which is the first time the person paying for an
  // opening can be the business selling it. That is not a purchase: the price
  // and the platform's fee go out of one pocket and into the same one, the job
  // can be marked complete and reviewed without anybody having done anything —
  // on a marketplace young enough for a handful of invented jobs to change what
  // a stranger sees — and the cancellation, refund and no-show rules all end up
  // with one person on both sides of them.
  //
  // Checked against the whole basket and not line by line, because this
  // function is all or nothing: one line of their own is a basket that cannot
  // be bought, and refusing it here means it is refused before a single row is
  // written rather than half-placed and unpicked afterwards.
  //
  // Leaving these openings off their own map would not be this check — the gap
  // ids are in a POST body — and claimSlot in public.ts makes the same refusal
  // for the form that has no JavaScript behind it.
  const ownBusiness = await businessBehindAccount(env, input.account?.id);
  if (ownBusiness && rows.some((r) => r.operator_id === ownBusiness)) {
    throw conflict(
      'One of those openings is your own — you cannot book yourself. '
      + 'Nothing has been booked. Take that one out and the rest of your basket stands.',
      'own_opening');
  }

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
        `${row.business_name} is now too far from their route for that opening.`, 'too_far');
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
  // WHAT `input.card` IS. The account above is real: the address was proved
  // with a code, and it is what the order is written against. `input.card` is
  // the processor's reference to a card the processor holds — never a card
  // number, which nothing in this codebase may touch — exactly as
  // operators.payment_ref has been since migration 0023, and it is recorded on
  // the order below. It is now populated on every order, because a booking
  // without a card is refused: see checkoutCard in index.ts. The charge itself
  // happens after this, against the order this function writes.
  //
  // Until the seam exists, orders.status stays 'pending': the slots are held
  // and no money has moved, which is the honest description of this state. The
  // payment step is what writes 'confirmed'.
  // ---------------------------------------------------------------------

  const orderId = newId();
  // Computed once for the whole basket, outside the per-item loop below, and
  // before the batch is assembled: a statement list is built synchronously and
  // this is the one value in it that has to be awaited.
  const phoneHash = await claimPhoneHash(env, phone);

  // Where the whole basket happens. One address per order by construction —
  // the checkout asks for exactly one.
  const place: BookingPlace = {
    address_line: input.address_line ?? null,
    postcode,
    lat: at?.lat ?? null,
    lng: at?.lng ?? null,
  };

  const writes: D1PreparedStatement[] = [
    orderWrite(env, {
      id: orderId,
      account_id: input.account?.id ?? null,
      guest_name: guestName,
      phone,
      login_email: loginEmail,
      email: input.email ?? null,
      place,
      currency: priced.currency,
      total_cents: priced.total_cents,
      card: input.card ?? null,
      at: t,
    }),
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
      writes.push(clientWrite(env, {
        id: clientId,
        operator_id: row.operator_id,
        first_name: guestName,
        place,
        // 'failed' and not 'pending', because an address WAS given — the
        // checkout refuses without one for a mobile job — and the geocoder
        // could not place it.
        geocode_status: at ? 'ok' : 'failed',
        default_service_id: primary.service_id,
        at: t,
      }));
    }

    const claimId = newId();

    // The calendar entry, the order line and the receipt, from the one builder
    // every booking on this site goes through. See bookingLineWrites.
    const line = bookingLineWrites(env, {
      order_id: orderId,
      operator_id: row.operator_id,
      client_id: clientId,
      gap_id: item.gap_id,
      service_id: primary.service_id,
      starts_at: row.starts_at,
      ends_at: endsAt,
      duration_seconds: item.duration_seconds,
      price_cents: item.price_cents,
      is_mobile: row.is_mobile,
      place,
      services: item.services,
      at: t,
    });
    const apptId = line.appointment_id;
    const itemId = line.order_item_id;
    writes.push(...line.writes);

    // The row the race is decided on: one confirmed claim per gap, enforced by
    // the partial unique index from migration 0006.
    //
    // No name, no number, no mailbox on it -- see migration 0035. This table
    // carries an operator_id, and the three columns it used to copy them into
    // were read by nothing at all, which made them a leak waiting for the
    // first `SELECT *`. The digest is what erasure still finds the row by.
    writes.push(env.DB.prepare(
      `INSERT INTO public_claims (id, operator_id, gap_id, service_id, client_id,
         appointment_id, phone_hash, address_line, postcode,
         lat, lng, detour_seconds, price_cents, deposit_cents, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'confirmed', ?,?)`,
    ).bind(claimId, row.operator_id, item.gap_id, primary.service_id, clientId, apptId,
      phoneHash, input.address_line ?? null, postcode,
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
    writes.push(calendarBumpWrite(env, operatorId, t));
  }

  let res: D1Result[];
  try {
    res = await env.DB.batch(writes);
  } catch (e) {
    if (String(e).includes('UNIQUE') || String(e).includes('constraint')) {
      throw conflict(
        'One of those openings was taken while you were checking out. '
        + 'Nothing has been booked — please pick again.', 'slot_taken');
    }
    throw e;
  }

  // A gap that changed zero rows was not taken by another claim — that would
  // have hit the unique index and rolled the batch back — it was withdrawn by
  // the operator between pricing and paying. Rare, but it leaves an order
  // pointing at an opening that is no longer for sale, so the order is voided
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
      'One of those openings was withdrawn while you were checking out. '
      + 'Nothing has been booked — please pick again.', 'slot_taken');
  }

  // Everything below this line happens after the money-shaped part is done.
  // The operator hearing about it matters; it does not matter enough to undo a
  // booking that already succeeded, which is why notify swallows its failures.
  for (const p of placed) {
    const row = gaps.get(p.gap_id)!;
    const locale = localeFor(row.country, row.language);
    // Without the doorstep, for the reason given at the same call in public.ts:
    // this row is prose nothing can put a mask in front of, so cancelling the
    // booking would leave the address readable here long after the schedule,
    // the client list and the leads list had all withdrawn it.
    await notify(env, p.operator_id, {
      kind: 'public_booking',
      title: `${guestName} booked ${p.services.map((s) => s.name).join(' + ')}`,
      body: [
        formatTimeRange(p.starts_at, p.ends_at, row.timezone, locale),
        formatMoney(p.price_cents, row.currency, locale),
      ].filter(Boolean).join(' · '),
      appointment_id: p.appointment_id, claim_id: null, starts_at: p.starts_at,
    });
  }

  // One conversation per business, because a basket can span two and there is
  // no shared inbox between them. An existing thread is reused only for the
  // business it already belongs to.
  //
  // EVERY CONVERSATION A BOOKING PRODUCES CARRIES THE ACCOUNT THE ORDER WAS
  // WRITTEN AGAINST, and it is the same value on both branches below — the one
  // that reuses an enquiry thread and the one that mints a new one. Writing it
  // in only one of them is the bug this note exists to prevent: the customer
  // whose conversation started as a question, which is the common way one
  // starts, would be exactly the customer whose conversation never appeared on
  // their account.
  //
  // It is also the ONE place the account and the thread are both in scope
  // without a lookup. The alternative is deriving it afterwards by joining
  // threads to order_items to orders, which is what migration 0052 backfills
  // with and explains at length why it is the wrong thing to run per request.
  //
  // NULL WHEN THE ORDER HAS NO ACCOUNT, and that is left as null rather than
  // guessed at. Booking needs an account today, so this is chiefly the older
  // rows and the operator-side paths; a thread with no account stays reachable
  // on its link, which is what the link is for.
  const accountId = input.account?.id ?? null;
  const existing = input.thread_token ? await threadByToken(env, input.thread_token) : null;
  const threads: Array<{ operator_id: string; business_name: string; token: string }> = [];
  for (const operatorId of new Set(placed.map((p) => p.operator_id))) {
    const mine = placed.filter((p) => p.operator_id === operatorId);
    const row = gaps.get(mine[0]!.gap_id)!;
    if (existing && existing.operator_id === operatorId && input.thread_token) {
      await attachBooking(env, existing.id, {
        appointment_id: mine[0]!.appointment_id, client_id: mine[0]!.client_id,
        customer_account_id: accountId,
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
      customer_account_id: accountId,
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
