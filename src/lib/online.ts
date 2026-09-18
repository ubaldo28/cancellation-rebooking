import type { Env } from '../types';
import { hashOfferToken } from './auth';
import { listingBlock } from './bypass';
import { notify } from './feed';
import { firstNameOnly, maskEmail, maskPhone, redactContact } from './redact';
import { customerStanding } from './standing';
import {
  MAX_DURATION_SECONDS, MAX_NOTE_CHARS, MIN_DURATION_SECONDS,
  badRequest, conflict, haversineMeters, newId, newToken, notFound, now, toE164,
} from './util';

/**
 * Open for work right now.
 *
 * Every other way into this platform asks the same question: who has a gap in
 * their calendar. That question is useless to the person whose boiler is
 * making a noise at eight on a Sunday evening, and it is useless to the
 * operator sitting in a van two streets away with nothing on. Willingness was
 * not something the schema could hold, so an idle business was invisible.
 *
 * This file holds one switch and one offer with a fuse on it. The rules are
 * short enough to say out loud, and they are deliberately weighted towards the
 * operator being in control of their own evening:
 *
 *   - flipping the switch on buys THREE HOURS and nothing more. It never
 *     renews itself. Somebody who has gone to bed goes offline on their own,
 *     with no cron job and no cooperation from them.
 *   - accepting a job turns it off, because they are now busy.
 *   - a request must be ACCEPTED. Nothing here is ever auto-assigned.
 *   - unaccepted after FIVE MINUTES it is dead, and the customer is told to
 *     pick somebody else rather than left watching a spinner.
 *
 * TWO THINGS ARE COMPUTED, NEVER STORED AS A FLAG, and both for the same
 * reason. "Online" is `online_until > now`, and "expired" is
 * `expires_at <= now`. A boolean would need something to come along and turn
 * it off, and would lie every time that something failed to run. The failure
 * mode of a stale boolean here is a customer booking a person who is asleep,
 * or a request accepted twenty minutes after the customer gave up and called
 * somebody else. Neither is a bug you find in a log; both are a phone call.
 *
 * The sweep at the bottom exists to tidy rows and to tell the operator they
 * missed one. Nothing in this file is correct only because it ran.
 */

/** Three hours, then it lapses. Never extended, never renewed automatically. */
export const ONLINE_SECONDS = 3 * 60 * 60;

/**
 * Five minutes to answer, and that is the whole promise on the customer's side.
 *
 * Somebody who wants a job done now cannot be parked on a person who put their
 * phone down. Five minutes is long enough to finish a sentence and short enough
 * that the customer still has the evening to find somebody else.
 */
export const REQUEST_TTL_SECONDS = 5 * 60;

/**
 * How far somebody idle will travel, bounded at both ends.
 *
 * The floor stops a radius of nothing, which would mean going online and never
 * appearing to anyone -- indistinguishable from the switch being broken. The
 * ceiling is not a policy about driving, it is what keeps the candidate query
 * below bounded: the search box is sized from this number, so an unbounded
 * radius would mean an unbounded scan.
 */
export const MIN_ONLINE_RADIUS_METERS = 1_000;
export const MAX_ONLINE_RADIUS_METERS = 80_000;

/**
 * Sanity bounds on what a right-now job can be. Typo guards, not pricing.
 *
 * The two duration bounds are MIN_DURATION_SECONDS / MAX_DURATION_SECONDS in
 * ./util, shared with estimates.ts: a quarter of an hour to twelve hours, and
 * the same decision in both places because both end up as the same kind of row
 * on the same calendar.
 *
 * MAX_PRICE_CENTS IS NOT SHARED, AND THAT IS THE POINT OF THIS NOTE. It sits
 * immediately beside those two in both files and DISAGREES: $10,000 here,
 * $50,000 in estimates.ts. An instant opening is a slot somebody taps to fill
 * this afternoon; a quoted estimate is a bespoke job an operator has thought
 * about and priced, so its typo guard is five times higher.
 *
 * WHETHER THAT GAP IS STILL WANTED HAS NOT BEEN DECIDED — it may be
 * deliberate, or it may be two round numbers chosen a year apart. Until
 * somebody decides, BOTH STAY as they are. Do not unify them on the way past;
 * raising this one quietly raises what a stranger can be asked to pay for a
 * same-day slot. The matching note is at the declaration in estimates.ts.
 */
const MAX_PRICE_CENTS = 10_000_00;

/**
 * Strangers type these into a public form. Bounds, not rules.
 *
 * The note's ceiling is MAX_NOTE_CHARS in ./util, shared with the parts note
 * and the two quote descriptions — four separate declarations of 300 before.
 */
const MAX_NAME_CHARS = 80;
const MAX_ADDRESS_CHARS = 200;
const MAX_POSTCODE_CHARS = 20;

/** Runaway guards on the two list queries. Neither is a ranking decision. */
const CANDIDATE_CAP = 200;
const SWEEP_CAP = 200;

// ---------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------

export interface OnlineStatus {
  online: boolean;
  /** When it lapses. Kept even when offline, so a UI can say "until 9:40pm". */
  until: number | null;
  /** When they flipped it on. Null when they are not on. */
  since: number | null;
  /** Zero when off. The number a countdown renders from. */
  seconds_left: number;
  radius_meters: number;
}

interface OperatorSwitchRow {
  online_until: number | null;
  online_since: number | null;
  online_radius_meters: number;
}

const statusFrom = (row: OperatorSwitchRow, at: number): OnlineStatus => {
  // The one definition of "online" in this file, used by every caller here so
  // that no second, subtly different version of it can appear later.
  const online = row.online_until != null && row.online_until > at;
  return {
    online,
    until: row.online_until,
    since: online ? row.online_since : null,
    seconds_left: online ? row.online_until! - at : 0,
    radius_meters: row.online_radius_meters,
  };
};

const clampRadius = (v: unknown, fallback: number): number => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, MIN_ONLINE_RADIUS_METERS), MAX_ONLINE_RADIUS_METERS);
};

async function readSwitch(env: Env, operatorId: string): Promise<OperatorSwitchRow> {
  const row = await env.DB.prepare(
    `SELECT online_until, online_since, online_radius_meters
       FROM operators WHERE id = ?`,
  ).bind(operatorId).first<OperatorSwitchRow>();
  if (!row) throw notFound('No such business.');
  return row;
}

/** What the switch says right now. Read-only, and safe to poll. */
export async function onlineStatus(env: Env, operatorId: string): Promise<OnlineStatus> {
  return statusFrom(await readSwitch(env, operatorId), now());
}

/**
 * Flip it on for three hours.
 *
 * THREE HOURS FROM NOW, EVERY TIME, AND IT NEVER RENEWS ITSELF. Flipping it on
 * again is a fresh three hours, which is the point: the only thing that keeps
 * a business listed as available is a person deciding, again, that they are.
 * An auto-renewing switch is how a marketplace fills up with businesses that
 * were available last Thursday.
 *
 * Gated by the same listingBlock() every other way of putting work up is gated
 * by. Being switched on IS listing yourself, and an operator who cannot take a
 * booked slot cannot take a right-now job either.
 */
export async function goOnline(
  env: Env, operatorId: string, opts: { radius_meters?: number } = {},
): Promise<OnlineStatus> {
  const blocked = await listingBlock(env, operatorId);
  if (blocked) throw conflict(blocked, 'listing_blocked');

  const current = await readSwitch(env, operatorId);
  const t = now();
  const wasOnline = current.online_until != null && current.online_until > t;

  // online_since is only reset when they were actually off. Flipping on while
  // already on is a top-up, and resetting it would restart "on for 40 minutes"
  // at zero -- which is both wrong on their screen and blind to the pattern
  // this column exists to make visible: flipping on, ignoring requests,
  // flipping on again.
  const since = wasOnline ? (current.online_since ?? t) : t;
  const radius = opts.radius_meters == null
    ? current.online_radius_meters
    : clampRadius(opts.radius_meters, current.online_radius_meters);

  const next: OperatorSwitchRow = {
    online_until: t + ONLINE_SECONDS,
    online_since: since,
    online_radius_meters: radius,
  };

  await env.DB.prepare(
    `UPDATE operators SET online_until = ?, online_since = ?, online_radius_meters = ?,
        updated_at = ? WHERE id = ?`,
  ).bind(next.online_until, next.online_since, next.online_radius_meters, t, operatorId).run();

  return statusFrom(next, t);
}

/**
 * Flip it off.
 *
 * online_since is left where it is rather than nulled. It records the last
 * time they flipped on, which is worth keeping after the fact; whether they
 * are on is answered by online_until and nothing else, so a stale since can
 * never make somebody look available.
 */
export async function goOffline(env: Env, operatorId: string): Promise<OnlineStatus> {
  const t = now();
  const res = await env.DB.prepare(
    `UPDATE operators SET online_until = NULL, updated_at = ? WHERE id = ?`,
  ).bind(t, operatorId).run();
  if ((res.meta.changes ?? 0) === 0) throw notFound('No such business.');
  return statusFrom(await readSwitch(env, operatorId), t);
}

// ---------------------------------------------------------------------------
// Who is on, near here
// ---------------------------------------------------------------------------

export interface OnlineOperator {
  id: string;
  business_name: string;
  trade: string | null;
  avatar_key: string | null;
  profile_slug: string | null;
  currency: string;
  lat: number;
  lng: number;
  distance_meters: number;
  online_until: number;
  seconds_left: number;
  online_radius_meters: number;
}

/**
 * Everyone switched on whose radius reaches this point, nearest first.
 *
 * THE DISTANCE FILTER IS DONE IN JAVASCRIPT, ON PURPOSE. SQLite has no trig
 * functions available here without an extension, so a true radius test in SQL
 * means either hand-rolled arithmetic in the WHERE clause or a bounding box
 * that is then quietly treated as a circle. Instead the query does the one
 * thing SQL is good at -- cut the table down to a small box with an index on
 * it -- and the exact test happens over that handful of rows with the same
 * haversineMeters every other distance in this codebase uses. The box is sized
 * from MAX_ONLINE_RADIUS_METERS, so the candidate set is bounded no matter how
 * many operators exist, and one definition of distance is the only one there
 * is.
 *
 * Each operator is measured against THEIR OWN radius, not a single search
 * radius, because the number means "how far I will come", which is theirs to
 * set and not the customer's to guess.
 */
export async function operatorsOnlineNear(
  env: Env,
  { lat, lng, trade, limit }: { lat: number; lng: number; trade?: string | null; limit?: number },
): Promise<OnlineOperator[]> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw badRequest('We need a location to find anybody near you.', 'no_location');
  }
  const want = Math.min(Math.max(1, Math.floor(limit ?? 20)), 50);
  const t = now();
  const here = { lat, lng };

  // The box, sized from the largest radius anybody is allowed to set. A degree
  // of latitude is a fixed distance; a degree of longitude shrinks towards the
  // poles, hence the cosine. The floor on it stops a division by nearly zero
  // at extreme latitudes turning the box into the whole world.
  const dLat = MAX_ONLINE_RADIUS_METERS / 111_320;
  const dLng = MAX_ONLINE_RADIUS_METERS
    / (111_320 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));

  const rows = await env.DB.prepare(
    `SELECT id, business_name, trade, avatar_key, profile_slug, currency,
            home_lat AS lat, home_lng AS lng,
            online_until, online_radius_meters
       FROM operators
      WHERE online_until > ?
        AND is_published = 1
        AND home_lat IS NOT NULL AND home_lng IS NOT NULL
        AND home_lat BETWEEN ? AND ?
        AND home_lng BETWEEN ? AND ?
        -- Suspended or banned businesses are not shown as available, for the
        -- same reason they cannot list a slot. Their own switch may still say
        -- on; what they cannot do is be offered work.
        AND banned_at IS NULL
        AND (suspended_until IS NULL OR suspended_until <= ?)
        -- trade is free text ('plumbing', 'mobile detailing'), so this is a
        -- contains-match rather than equality. An exact match on a field
        -- people type by hand finds nobody.
        AND (? IS NULL OR lower(trade) LIKE '%' || lower(?) || '%')
      LIMIT ?`,
  ).bind(
    t, lat - dLat, lat + dLat, lng - dLng, lng + dLng, t,
    trade ?? null, trade ?? '', CANDIDATE_CAP,
  ).all<Omit<OnlineOperator, 'distance_meters' | 'seconds_left'>>();

  return (rows.results ?? [])
    .map((o) => ({
      ...o,
      distance_meters: Math.round(haversineMeters(here, { lat: o.lat, lng: o.lng })),
      seconds_left: o.online_until - t,
    }))
    .filter((o) => o.distance_meters <= o.online_radius_meters)
    .sort((a, b) => a.distance_meters - b.distance_meters)
    .slice(0, want);
}

// ---------------------------------------------------------------------------
// The offer, and its fuse
// ---------------------------------------------------------------------------

export type InstantStatus = 'pending' | 'accepted' | 'declined' | 'expired' | 'cancelled';

export interface InstantRequest {
  id: string;
  operator_id: string;
  service_id: string | null;
  starts_at: number;
  duration_seconds: number;
  price_cents: number;
  currency: string;
  guest_name: string;
  phone_e164: string;
  email: string | null;
  address_line: string | null;
  postcode: string | null;
  lat: number | null;
  lng: number | null;
  note: string | null;
  status: InstantStatus;
  expires_at: number;
  decided_at: number | null;
  order_id: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Every column of a request except token_hash, listed once.
 *
 * A list rather than a string because two queries below need the same columns
 * with a table prefix on them, and a hand-maintained second copy of a column
 * list is how a join quietly starts selecting a secret.
 *
 * TWO COLUMNS ARE DELIBERATELY ABSENT AND MUST STAY ABSENT.
 *
 * `token_hash` is the obvious one: it is the digest of the customer's own
 * link, and the whole point of storing a digest is that nothing hands it back.
 *
 * `login_email` is the one that will look like an oversight to whoever reads
 * this next, so it is written down here. Migration 0049 put it on the table so
 * that "delete my data" can find these rows by the person rather than by a
 * phone number two people in a house might share. It is the customer's PROVED
 * mailbox — the account they sign in to — and the operator must never see it:
 * `maskInstantRequest` below masks `email`, which is the contact address the
 * customer typed, and a raw `login_email` arriving on the same row would hand
 * the operator in full the very thing the mask exists to withhold, on a
 * request they have not even accepted. Every query in this file selects this
 * list, and both of the routes that serve one select it through this list, so
 * leaving the column out here is what keeps it out of all of them.
 */
const REQUEST_COLUMNS = [
  'id', 'operator_id', 'service_id', 'starts_at', 'duration_seconds', 'price_cents',
  'currency', 'guest_name', 'phone_e164', 'email', 'address_line', 'postcode',
  'lat', 'lng', 'note', 'status', 'expires_at', 'decided_at', 'order_id',
  'created_at', 'updated_at',
] as const;

const REQUEST_FIELDS = REQUEST_COLUMNS.join(', ');
const REQUEST_FIELDS_R = REQUEST_COLUMNS.map((c) => `r.${c}`).join(', ');

/**
 * A request as the OPERATOR is allowed to see it, before and after they accept.
 *
 * The number and the mailbox were already masked at the route. The doorstep was
 * not, and that is the hole this closes: a pending request handed every online
 * operator within range the street line and five-decimal-place coordinates of a
 * stranger's home for a job NOBODY HAD ACCEPTED. Every other doorstep in this
 * product is governed by the release model — migration 0022 releases the
 * address at the moment a booking exists and withdraws it when the booking goes
 * away, and maskWithdrawnAddress in redact.ts is what enforces it — and the
 * instant path was simply outside it. Five minutes of exposure is still
 * exposure, and an operator who declines has still been handed an address they
 * now hold forever.
 *
 * WHAT IS WITHHELD AND WHAT IS NOT. The postcode stays, because it is what the
 * operator needs in order to decide: "is this within reach of where I am
 * sitting" is the whole question a five-minute fuse asks, and it is the same
 * coarse geography the retention sweep keeps after a job is over. The street
 * line and the coordinates — which are the address, written differently —
 * arrive on acceptance, which is the moment they agreed to drive there.
 *
 * It lives in this module rather than at the route because a mask written at
 * one call site is a mask the second call site forgets: see the paragraph on
 * maskCustomerRow in redact.ts, which is that same lesson learned twice on the
 * schedule and the client list.
 */
export function maskInstantRequest<
  T extends { status?: unknown; phone_e164?: unknown; email?: unknown },
>(r: T): T {
  const out: Record<string, unknown> = {
    ...r,
    phone_e164: maskPhone(r.phone_e164 as string | null),
    email: maskEmail(r.email as string | null),
  };
  if (r.status !== 'accepted') {
    // The coordinates go with the street line. A latitude and longitude to five
    // decimal places is the doorstep, and withholding one without the other
    // withholds nothing.
    out.address_line = null;
    out.lat = null;
    out.lng = null;
  }
  return out as T;
}

/** What the customer's polling screen needs, without a second round trip. */
export interface InstantRequestView extends InstantRequest {
  business_name: string | null;
  trade: string | null;
  /** Zero once the fuse has burned, whatever the stored status says. */
  seconds_left: number;
}

export interface CreateInstantRequestInput {
  operator_id: string;
  /** Optional. With it, duration and price come from the service, not the caller. */
  service_id?: string | null;
  starts_at?: number | null;
  duration_seconds?: number | null;
  price_cents?: number | null;
  guest_name: string;
  phone: string;
  /**
   * The account's proved identity, off the account row and never off the
   * request body. Standing is counted against it, so taking it from the body
   * would be taking the one thing that is supposed to be proved from the one
   * place nobody has proved anything. The route calls checkoutAccount first,
   * which is what makes this present on every path that reaches here.
   */
  login_email: string;
  email?: string | null;
  address_line?: string | null;
  postcode?: string | null;
  lat?: number | null;
  lng?: number | null;
  note?: string | null;
}

const trimTo = (v: unknown, max: number): string | null =>
  typeof v === 'string' ? (v.trim().slice(0, max) || null) : null;

/**
 * The customer's note, cut to length and stripped of contact details.
 *
 * Cleaned before the length cut would be wrong: a number sitting on the 300th
 * character would survive as a fragment, and a fragment of a phone number
 * across two sentences is still most of one. Null when nothing readable is
 * left, so a note that was only a phone number does not become a row saying
 * "[removed]".
 */
const redactedNote = (v: unknown): string | null => {
  const raw = trimTo(v, MAX_NOTE_CHARS);
  return raw == null ? null : (redactContact(raw).body.trim() || null);
};

const coord = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * A customer asks somebody who is switched on to come now.
 *
 * Written as 'pending' with a five-minute fuse and NOTHING ELSE. No
 * appointment, no order, no client row, no slot held. Most of these expire and
 * never become anything, and a table of half-bookings from people who moved on
 * is a table every later query has to be taught to ignore.
 *
 * This route asks for no sign-in, so the raw token returned here is the
 * caller's only way back to the answer. It is returned ONCE, to the caller,
 * and only its hash is stored -- the same rule as every other guest secret in
 * this codebase, so a leaked database hands out no working links. Making the
 * request itself does need an account, since an accepted one becomes a real
 * appointment; the link is how the answer is read, not how it is authorised.
 */
export async function createInstantRequest(
  env: Env, input: CreateInstantRequestInput,
): Promise<{ request: InstantRequest; token: string }> {
  const t = now();
  const operatorId = (input?.operator_id ?? '').trim();

  const op = await env.DB.prepare(
    `SELECT id, business_name, country, currency, online_until
       FROM operators WHERE id = ?`,
  ).bind(operatorId).first<{
    id: string; business_name: string; country: string; currency: string;
    online_until: number | null;
  }>();
  if (!op) throw notFound('No such business.');

  // Computed from the timestamp, never from a flag, and checked here rather
  // than trusted from whatever list the customer tapped. A listing page is
  // seconds or minutes old, and three of those minutes are the difference
  // between somebody idle and somebody who has just taken a job.
  if (op.online_until == null || op.online_until <= t) {
    throw conflict('They are not taking work right now. Pick somebody else who is on.',
      'not_online');
  }

  // The first word of it only. This name is read out to a working operator and
  // written onto the request row beside a street address, which is the pair
  // redact.ts exists to keep apart. See firstNameOnly for why the first word is
  // the honest limit of what a free-text box can be held to.
  const guestName = trimTo(firstNameOnly(input?.guest_name), MAX_NAME_CHARS);
  if (!guestName) throw badRequest('We need a name to give them.', 'no_name');

  const phone = toE164(input?.phone ?? null, op.country);
  if (!phone) throw badRequest('That does not look like a valid mobile number.', 'bad_phone');

  // AGAINST THE ADDRESS, NOT THE NUMBER — the same check the ordinary checkout
  // makes, and for the same reason it moved: nobody proves a number any more,
  // so a suspension hung on one is escapable by typing a different one. See
  // migration 0038.
  const standing = await customerStanding(env, input?.login_email ?? '');
  if (standing.blocked) throw conflict(standing.message!, 'suspended');

  // Duration and price come from the service when there is one, because those
  // are the numbers the operator published and the customer saw. Only a
  // request with no service at all is allowed to name its own, and then it
  // must name both -- a job with a duration and no price is a blank cheque.
  let serviceId: string | null = null;
  let duration: number;
  let price: number;

  const rawServiceId = trimTo(input?.service_id, 64);
  if (rawServiceId) {
    const svc = await env.DB.prepare(
      `SELECT id, duration_seconds, price_cents FROM services
        WHERE id = ? AND operator_id = ? AND is_active = 1`,
    ).bind(rawServiceId, operatorId).first<{
      id: string; duration_seconds: number; price_cents: number;
    }>();
    if (!svc) throw notFound('That service is not one of theirs.');
    serviceId = svc.id;
    duration = svc.duration_seconds;
    price = svc.price_cents;
  } else {
    duration = Math.round(Number(input?.duration_seconds));
    price = Math.round(Number(input?.price_cents));
    if (!Number.isFinite(duration) || !Number.isFinite(price)) {
      throw badRequest('Pick a service, or say how long it is and what it costs.',
        'no_service');
    }
  }

  if (duration < MIN_DURATION_SECONDS || duration > MAX_DURATION_SECONDS) {
    throw badRequest('That job length does not look right.', 'bad_duration');
  }
  if (price < 0 || price > MAX_PRICE_CENTS) {
    throw badRequest('That price looks like a typo.', 'bad_price');
  }

  // Stored rather than assumed to be "now", so an operator accepting three
  // minutes later is agreeing to a time and not to a word. A start in the past
  // is pulled forward instead of rejected: the customer meant now, and the
  // clock on their phone is not the argument to have with them.
  let startsAt = Math.round(Number(input?.starts_at ?? t));
  if (!Number.isFinite(startsAt) || startsAt < t) startsAt = t;
  if (startsAt > t + ONLINE_SECONDS) {
    // Past the switch's own lifetime this is not a right-now job, it is a
    // booking, and it belongs in the ordinary flow where a slot is held.
    throw badRequest('That is too far ahead for a right-now job. Book a slot instead.',
      'not_instant');
  }

  const raw = newToken();
  const request: InstantRequest = {
    id: newId(),
    operator_id: operatorId,
    service_id: serviceId,
    starts_at: startsAt,
    duration_seconds: duration,
    price_cents: price,
    currency: op.currency,
    guest_name: guestName,
    phone_e164: phone,
    email: trimTo(input?.email, 200),
    address_line: trimTo(input?.address_line, MAX_ADDRESS_CHARS),
    postcode: trimTo(input?.postcode, MAX_POSTCODE_CHARS),
    lat: coord(input?.lat),
    lng: coord(input?.lng),
    // Through the same filter as everything else a customer types at a
    // business. This box is the one free-text field on the instant-request
    // form, it is read by the operator and quoted verbatim into the feed row
    // below, and it was the only one of the three going in unfiltered -- so
    // "call me on ..." in a hurry-up note was a number handed over in the
    // product whose whole promise is that no number is.
    note: redactedNote(input?.note),
    status: 'pending',
    expires_at: t + REQUEST_TTL_SECONDS,
    decided_at: null,
    order_id: null,
    created_at: t,
    updated_at: t,
  };

  // login_email is written and never read back out of this table by anything in
  // this file — see the note on REQUEST_COLUMNS, which is why it is not in that
  // list. It exists for one caller: eraseCustomerByPhone in retention.ts.
  //
  // WHAT IT REPLACES. That erasure used to find these rows with
  // `phone_e164 IN (the numbers this person gave)`, and migration 0038 is the
  // reason that was the wrong key: nothing proves a number any more, so the
  // number on this row identifies a handset rather than a person. Two people
  // sharing a household mobile were one subject, so erasing one deleted the
  // other's requests; and a person whose account carries no number at all was
  // no subject, so their own requests — a first name, a street line,
  // coordinates to five decimal places and whatever they typed about their
  // house — survived being told they had been forgotten. The address is what
  // this person proved they can read mail at, and it is what the standing
  // check three blocks up is already counted against, so it is the only thing
  // on this request that is honestly about a person. Migration 0049 has the
  // full version.
  //
  // Normalised on the way in is not needed here: `login_email` arrives off the
  // account row, which customers.ts has already lowercased and trimmed, and
  // taking it off the account rather than off the request body is what stops
  // it being a value somebody typed.
  const loginEmail = (input?.login_email ?? '').trim().toLowerCase() || null;

  await env.DB.prepare(
    `INSERT INTO instant_requests (id, operator_id, service_id, starts_at,
       duration_seconds, price_cents, currency, guest_name, phone_e164,
       login_email, email,
       address_line, postcode, lat, lng, note, status, expires_at, decided_at,
       order_id, token_hash, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,NULL,NULL,?,?,?)`,
  ).bind(
    request.id, request.operator_id, request.service_id, request.starts_at,
    request.duration_seconds, request.price_cents, request.currency,
    request.guest_name, request.phone_e164, loginEmail, request.email,
    request.address_line,
    request.postcode, request.lat, request.lng, request.note, request.expires_at,
    await hashOfferToken(raw, env), t, t,
  ).run();

  // After the insert, never as part of it. notify() swallows its own failures
  // for exactly this reason: a lost notification is bad, a lost request is
  // worse. 'public_booking' is the existing kind for work arriving from the
  // public side -- the CHECK in migration 0021 has a fixed list, and inventing
  // a sixth kind here would fail the insert rather than show anybody anything.
  //
  // "At <street line>" was the fallback body, and it is the one copy of the
  // doorstep this product could never take back: a request that expires in
  // five minutes and is then swept away left its address sitting in a feed row
  // for as long as the feed is kept. Where the job is belongs on the request,
  // which the operator opens from this row and which stops answering once the
  // request is gone. See NotifyInput in feed.ts.
  //
  // THE NAME AND THE NOTE ARE GONE FROM IT NOW, FOR EXACTLY THAT REASON. The
  // paragraph above was right about the address and stopped one field short.
  // A feed row written by an instant request carries no appointment_id and no
  // thread_id, because a request nobody accepted never becomes either — so
  // eraseCustomerByPhone, which finds feed rows by those two keys and nothing
  // else, could not reach one. "Rosa wants somebody now", with whatever Rosa
  // typed about her house quoted underneath it, therefore survived her asking
  // to be forgotten and sat in the operator's feed until the ninety-day sweep
  // happened past. The request row itself holds her name and her words, it is
  // one tap away through this notification, and erasure deletes it outright —
  // so the fix is not to key the copy, it is not to make one.
  await notify(env, operatorId, {
    kind: 'public_booking',
    title: 'Somebody wants a job now',
    body: 'Tap to accept or decline — it expires in five minutes.',
    starts_at: request.starts_at,
  });

  // The only time the raw token exists outside the customer's own link.
  return { request, token: raw };
}

// ---------------------------------------------------------------------------
// The operator answers
// ---------------------------------------------------------------------------

/**
 * Accept it.
 *
 * The status guard is the whole function. `status='pending' AND expires_at > ?`
 * means a tap that arrives a second after the fuse burned changes nothing and
 * says so, instead of booking a customer who has already rung somebody else.
 * A double tap is the same story: the second one matches no row.
 *
 * The switch goes off in a SEPARATE statement AFTER that guard has passed, not
 * alongside it. Batched together, a late or duplicate tap would still switch
 * the operator offline -- punishing them for a request they never got.
 */
export async function acceptRequest(
  env: Env, operatorId: string, requestId: string,
): Promise<InstantRequest> {
  const t = now();

  const res = await env.DB.prepare(
    `UPDATE instant_requests SET status='accepted', decided_at=?, updated_at=?
      WHERE id=? AND operator_id=? AND status='pending' AND expires_at > ?`,
  ).bind(t, t, requestId, operatorId, t).run();

  if ((res.meta.changes ?? 0) === 0) throw await whyNotPending(env, operatorId, requestId, t);

  // Busy now. Accepting is the one thing that turns the switch off by itself,
  // and it happens here rather than being left to the operator to remember --
  // a second customer sent to somebody already driving to the first is exactly
  // the failure this whole file exists to prevent.
  await env.DB.prepare(
    `UPDATE operators SET online_until = NULL, updated_at = ? WHERE id = ?`,
  ).bind(t, operatorId).run();

  const row = (await env.DB.prepare(
    `SELECT ${REQUEST_FIELDS} FROM instant_requests WHERE id = ?`,
  ).bind(requestId).first<InstantRequest>())!;

  // -------------------------------------------------------------------
  // PAYMENT SEAM — the booking and the charge for this job.
  //
  // Nothing above takes any money or creates anything a customer could be
  // charged against. What belongs on this line, once the wiring exists:
  //
  //   1. Create the order and its single order_item from THIS row and only
  //      this row -- row.price_cents, row.duration_seconds, row.starts_at.
  //      Not a re-read of the operator's current price list: the number the
  //      customer agreed to is the one stored here, minutes ago, and it is
  //      the only number they have seen.
  //   2. Charge that amount, the same way checkout does.
  //   3. Write the new order's id back to instant_requests.order_id, which
  //      is the column that exists for it. An 'accepted' request with
  //      order_id still NULL is a job somebody agreed to and nobody billed,
  //      and that is the report to run when this goes wrong.
  //
  // Deliberately NOT done here: this module decides who is available and who
  // said yes. It does not decide money.
  // -------------------------------------------------------------------

  return row;
}

/**
 * Decline it.
 *
 * The switch stays ON. Saying no to one job is not saying no to the evening,
 * and turning them off for it would quietly train operators never to decline.
 *
 * Guarded on the fuse as well as the status, so a decline arriving after
 * expiry leaves the row 'expired'. The customer has already been told it
 * expired and moved on; changing that story afterwards helps nobody.
 */
export async function declineRequest(
  env: Env, operatorId: string, requestId: string,
): Promise<InstantRequest> {
  const t = now();
  const res = await env.DB.prepare(
    `UPDATE instant_requests SET status='declined', decided_at=?, updated_at=?
      WHERE id=? AND operator_id=? AND status='pending' AND expires_at > ?`,
  ).bind(t, t, requestId, operatorId, t).run();

  if ((res.meta.changes ?? 0) === 0) throw await whyNotPending(env, operatorId, requestId, t);

  return (await env.DB.prepare(
    `SELECT ${REQUEST_FIELDS} FROM instant_requests WHERE id = ?`,
  ).bind(requestId).first<InstantRequest>())!;
}

/**
 * Why the guarded update matched nothing, in words the operator can act on.
 *
 * Worth the extra read: "that did not work" on a screen with a countdown on it
 * is the moment somebody taps four more times. A row belonging to another
 * operator gets the same answer as one that does not exist, because which ids
 * are real is not something an API should confirm.
 */
async function whyNotPending(env: Env, operatorId: string, requestId: string, at: number) {
  const row = await env.DB.prepare(
    `SELECT status, expires_at FROM instant_requests WHERE id = ? AND operator_id = ?`,
  ).bind(requestId, operatorId).first<{ status: InstantStatus; expires_at: number }>();

  if (!row) return notFound('That request is not yours.');
  if (row.status === 'pending' && row.expires_at <= at) {
    return conflict('That one timed out. They have been told to find somebody else.',
      'request_expired');
  }
  if (row.status === 'expired') {
    return conflict('That one timed out. They have been told to find somebody else.',
      'request_expired');
  }
  if (row.status === 'cancelled') {
    return conflict('They cancelled that before you answered.', 'request_cancelled');
  }
  return conflict(`That request was already ${row.status}.`, 'request_decided');
}

// ---------------------------------------------------------------------------
// The customer waits
// ---------------------------------------------------------------------------

/**
 * The customer polling for an answer, authorised by their link and nothing else.
 *
 * EXPIRY IS DECIDED HERE, ON READ. A pending row whose fuse has burned comes
 * back as 'expired' whether or not the sweep has ever run, because the sweep
 * is a tidy-up and not the truth. The row is also written back so the
 * operator's screen and the sweep agree with what the customer was just told,
 * but that write is a consequence of the answer rather than the source of it:
 * if it fails, the customer still sees 'expired'.
 *
 * Returns null rather than throwing on an unknown token. This is polled every
 * few seconds from a phone, and a dead link is an answer, not an incident.
 */
export async function requestByToken(
  env: Env, rawToken: string,
): Promise<InstantRequestView | null> {
  if (!rawToken) return null;
  const t = now();

  const row = await env.DB.prepare(
    `SELECT ${REQUEST_FIELDS_R}, o.business_name, o.trade
       FROM instant_requests r
       JOIN operators o ON o.id = r.operator_id
      WHERE r.token_hash = ?`,
  ).bind(await hashOfferToken(rawToken, env))
    .first<InstantRequest & { business_name: string | null; trade: string | null }>();

  if (!row) return null;

  const burned = row.status === 'pending' && row.expires_at <= t;
  if (burned) {
    // Best effort, and guarded so it can never overwrite an answer that landed
    // in the meantime. Told once, so the operator gets one "you missed one"
    // rather than one per poll.
    const res = await env.DB.prepare(
      `UPDATE instant_requests SET status='expired', updated_at=?
        WHERE id=? AND status='pending' AND expires_at <= ?`,
    ).bind(t, row.id, t).run();
    if ((res.meta.changes ?? 0) > 0) await notifyMissed(env, row);
  }

  return {
    ...row,
    status: burned ? 'expired' : row.status,
    seconds_left: row.status === 'pending' ? Math.max(0, row.expires_at - t) : 0,
  };
}

/**
 * The customer changes their mind while it is still pending.
 *
 * Its own status rather than a decline, because who walked away matters: a
 * request the customer withdrew says nothing about the operator, and a
 * response-rate figure that counted it against them would be wrong.
 */
export async function cancelRequest(
  env: Env, rawToken: string,
): Promise<InstantRequestView | null> {
  const view = await requestByToken(env, rawToken);
  if (!view) return null;
  if (view.status !== 'pending') return view;

  const t = now();
  const res = await env.DB.prepare(
    `UPDATE instant_requests SET status='cancelled', decided_at=?, updated_at=?
      WHERE id=? AND status='pending' AND expires_at > ?`,
  ).bind(t, t, view.id, t).run();

  if ((res.meta.changes ?? 0) === 0) return requestByToken(env, rawToken);

  // Without the name, for the reason createInstantRequest gives: a feed row
  // from this path carries no key erasure can find it by, so it must not carry
  // anything erasure would have to come back for.
  await notify(env, view.operator_id, {
    kind: 'booking_cancelled',
    title: 'A right-now request was cancelled',
    body: 'They withdrew it before you answered.',
    starts_at: view.starts_at,
  });

  return { ...view, status: 'cancelled', decided_at: t, seconds_left: 0 };
}

// ---------------------------------------------------------------------------
// Tidying up
// ---------------------------------------------------------------------------

/**
 * One "you missed one", wherever expiry is noticed.
 *
 * The name is deliberately not in it — see createInstantRequest. This row
 * outlives the request it is about by up to ninety days and there is no key on
 * it that an erasure can find, so a customer's first name in the title is a
 * copy of them that "delete my data" cannot reach. Nothing about the operator's
 * missed job needs it: the row that is gone is the point of the message.
 */
async function notifyMissed(
  env: Env, row: { operator_id: string; starts_at: number },
): Promise<void> {
  await notify(env, row.operator_id, {
    kind: 'booking_cancelled',
    title: 'You missed a right-now job',
    body: 'Nobody answered within five minutes, so they were told to find '
      + 'somebody else.',
    starts_at: row.starts_at,
  });
}

/**
 * The sweep. Runs on the existing cron.
 *
 * NOTHING IN THIS FILE IS CORRECT ONLY BECAUSE THIS RAN. Every read already
 * treats a burned fuse as expired, so this exists to do two things a read
 * cannot: settle the rows nobody happens to look at, and tell the operator
 * they missed one while that is still news.
 *
 * Capped per run rather than unbounded. A backlog is drained over several
 * minutes; a single statement over an unbounded set is how a cron job starts
 * timing out on the day it is most needed.
 */
export async function expireRequests(env: Env): Promise<number> {
  const t = now();

  const due = await env.DB.prepare(
    `SELECT id, operator_id, guest_name, starts_at FROM instant_requests
      WHERE status = 'pending' AND expires_at <= ?
      ORDER BY expires_at LIMIT ?`,
  ).bind(t, SWEEP_CAP).all<{
    id: string; operator_id: string; guest_name: string; starts_at: number;
  }>();

  const rows = due.results ?? [];
  if (rows.length === 0) return 0;

  // One guarded statement PER ROW rather than one over the whole set, and that
  // is the point of the batch rather than a style choice: a D1 batch reports
  // the change count of each statement separately, so this can tell which
  // requests it actually expired.
  //
  // The set-wide UPDATE could not. It reported one number for the lot, and the
  // notification loop below then fired for every row it had SELECTED — so an
  // operator who accepted a request in the half second between the select and
  // the update was told they had missed the job they had just taken, while the
  // customer was already being messaged that it was accepted. Two people, two
  // opposite stories, over the same booking.
  const res = await env.DB.batch(rows.map((r) => env.DB.prepare(
    `UPDATE instant_requests SET status='expired', updated_at=?
      WHERE id=? AND status='pending' AND expires_at <= ?`,
  ).bind(t, r.id, t)));

  // After the update, and only for the rows this run actually moved.
  let expired = 0;
  for (let i = 0; i < rows.length; i++) {
    if ((res[i]?.meta.changes ?? 0) === 0) continue;
    expired++;
    await notifyMissed(env, rows[i]!);
  }

  return expired;
}

/**
 * What is waiting on this operator, soonest fuse first.
 *
 * `expires_at > ?` is in the query rather than filtered afterwards, so a row
 * the sweep has not reached yet is simply not on the screen. An operator
 * should never be shown a button that cannot work.
 */
export async function pendingForOperator(
  env: Env, operatorId: string,
): Promise<Array<InstantRequest & { seconds_left: number }>> {
  const t = now();
  const rows = await env.DB.prepare(
    `SELECT ${REQUEST_FIELDS} FROM instant_requests
      WHERE operator_id = ? AND status = 'pending' AND expires_at > ?
      ORDER BY expires_at`,
  ).bind(operatorId, t).all<InstantRequest>();

  return (rows.results ?? []).map((r) => ({ ...r, seconds_left: r.expires_at - t }));
}
