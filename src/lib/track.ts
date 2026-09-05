import type { Env, Point } from '../types';
import { threadByToken } from './chat';
import { driveSeconds, estimateDriveSeconds } from './geo';
import { localDayStart } from './tz';
import { badRequest, haversineMeters, now } from './util';

/**
 * "Build some sort of tracking so we can see the van moving."
 *
 * Two audiences, and the difference between them is the whole design.
 *
 *   The OPERATOR sees their own van -- position and a short trail -- on their
 *   own dashboard, scoped by operator_id like everything else in this codebase.
 *
 *   A CUSTOMER sees roughly where the van is and an ETA, and only inside a
 *   window around the appointment they actually booked. They never get a live
 *   dot following a self-employed person around all day. That is a safety
 *   problem, not a feature: the operator is one person in their own vehicle,
 *   driving between strangers' homes and eventually to their own, and a bearer
 *   link that tracks them continuously is a stalking tool that we handed out.
 *
 * So the customer read is gated three ways -- consent, time, freshness -- and
 * the coordinate it returns is rounded to about 110 m. See customerView().
 *
 * SCALE. This was the highest-write path in the product by a wide margin, and
 * the only one that wrote on a timer rather than when a person did something.
 * A van pinging every 30 seconds is 2,880 writes per operator per day; ten
 * thousand vans is roughly 150 million D1 writes a month, spent on a value
 * that is overwritten before anyone reads the previous one. That was the
 * single largest cost in the system.
 *
 * So positions are no longer in the database. Each van's live position lives
 * in a Durable Object keyed by operator_id -- src/do/van.ts -- where a ping
 * overwrites a field in memory and writes nothing durable; the object persists
 * a snapshot every few minutes purely so an eviction does not make the van
 * vanish mid-journey. D1 keeps the two things that really are records: the
 * operator's share_location consent, and the appointment the customer booked.
 * Migration 0015 drops the two position tables.
 *
 * From the outside this module has not changed: same exports, same signatures,
 * same gates, same guarantees. Only where the position comes from moved.
 *
 * THE BINDING IS OPTIONAL, on purpose. An environment with no VAN binding --
 * a preview that has not had the Durable Object migration applied yet -- still
 * boots and serves everything else: pings are accepted and discarded, the
 * dashboard shows no van, and the customer view says the van has not reported.
 * A required binding would take the whole site down over one feature.
 */

/** The van's current position, as the operator's dashboard sees it. */
export interface VanPosition {
  operator_id: string;
  lat: number;
  lng: number;
  accuracy_meters: number | null;
  heading: number | null;
  speed_mps: number | null;
  /** When the phone took the fix. */
  recorded_at: number;
  /** When we stored it. Differs from recorded_at by time spent in a dead spot. */
  updated_at: number;
}

/** One point behind the van. Oldest first, so it draws as a line. */
export interface TrailPoint {
  lat: number;
  lng: number;
  recorded_at: number;
}

/** One fix, straight off the phone's Geolocation API. */
export interface PositionPing {
  lat: number;
  lng: number;
  accuracy_meters?: number | null;
  heading?: number | null;
  speed_mps?: number | null;
  /** Position.timestamp, in seconds. Defaults to now. */
  recorded_at?: number | null;
}

/**
 * Why a ping was not written. Never an error: a dropped ping is the normal,
 * expected outcome of a phone doing its job, and turning it into a 4xx would
 * teach the client to retry the one thing we are trying to do less of.
 */
export type PingSkip = 'too_frequent' | 'out_of_order';

/**
 * The smallest gap between two stored pings for one operator.
 *
 * Twenty seconds. Browsers with watchPosition() running fire far more often
 * than that -- every fix the chipset produces, several a second while moving --
 * and a van cannot travel far enough in twenty seconds to change any answer
 * this feature gives: the customer's ETA is in minutes and the trail is drawn
 * at street scale. So anything faster is pure write amplification on the
 * highest-write path in the product, and it is dropped here, before the batch,
 * rather than being written and then ignored.
 *
 * The number is a floor, not a schedule: the client should ping every ~30s.
 * This exists so a buggy or hostile client cannot turn one van into a
 * thousand writes a minute.
 */
export const MIN_PING_SECONDS = 45;

/**
 * How many points the trail keeps.
 *
 * Forty, which at a ping every 30 seconds is the last twenty minutes -- enough
 * to see the shape of the current leg of the journey, which is what "we can
 * see the van moving" actually means. Longer is not more useful (nobody is
 * looking at where the van was an hour ago) and it is worse: it is a record of
 * a named person's movements, kept for no reason anybody asked for.
 */
export const MAX_TRAIL_POINTS = 20;

/**
 * How often the breadcrumb trail gets a new point, and the trim runs.
 *
 * The current position is what the product needs; the trail only exists so the
 * dot reads as moving rather than teleporting. This used to be a write-cost
 * rule -- appending on every ping tripled the cost of the busiest path in the
 * system for a cosmetic detail. In memory an append costs nothing, so the
 * reason is now the other one it always had: with MAX_TRAIL_POINTS fixed, the
 * sampling interval is what decides how far back the line reaches. Every two
 * or three minutes is plenty to draw a leg of a journey with, and it keeps the
 * behaviour on the operator's map exactly what it was before the move.
 */
export const TRAIL_EVERY_SECONDS = 150;

/**
 * How old a fix may be and still be shown to a customer.
 *
 * Ten minutes. A stale position is worse than no position: it says "they are
 * two streets away" about a van that has since finished the job and driven
 * home, and the customer stands at the window. Ten minutes is chosen to
 * survive an ordinary dead spot -- a tunnel, an underground car park, a
 * basement job -- without going blank, while being short enough that the dot
 * cannot be badly wrong about where the van is at street scale.
 *
 * This bound is also the reason we never need a "stop sharing" button that
 * anyone must remember to press: the customer view goes dark on its own ten
 * minutes after the phone stops pinging.
 */
export const STALE_AFTER_SECONDS = 600;

/**
 * How long before the appointment starts the customer may see the van.
 *
 * Ninety minutes. Long enough to be genuinely useful -- "are they coming this
 * morning, should I move the car" is asked well before the hour -- and short
 * enough that it cannot be read as a working day. It is bounded on the other
 * side by the appointment being TODAY, so an appointment at 00:30 does not
 * quietly open a window at 23:00 the night before.
 */
export const WINDOW_BEFORE_SECONDS = 90 * 60;

/**
 * How long after the appointment ends the customer may still see the van.
 *
 * Thirty minutes, and it is short on purpose. The only legitimate use after
 * the end is a job that overran or a van that has not arrived yet; past that
 * the customer has no reason to know where the operator is, and every extra
 * minute is a window into where a self-employed person goes after work. This
 * is the boundary most likely to be argued upwards later, and it should not be.
 */
export const WINDOW_AFTER_SECONDS = 30 * 60;

/**
 * Decimal places on the coordinate a customer receives.
 *
 * Three, which is about 110 m. The question a customer has is "is the van
 * close" and this answers it. Full precision answers a different question --
 * which house the van is outside, right now -- that no customer needs and that
 * we should not be able to be compelled or breached into answering. The
 * rounding happens on the way out, on the server, so no unrounded coordinate
 * ever reaches the browser to be recovered from a network tab.
 */
export const CUSTOMER_DECIMALS = 3;

/**
 * Distance is rounded to the nearest 100 m for the same reason.
 *
 * An exact distance next to a coarse position hands back most of the precision
 * the rounding just removed -- two or three of them over a few minutes narrow
 * it to a point. A hundred metres keeps "they are about a kilometre away"
 * truthful and keeps the trilateration useless.
 */
const CUSTOMER_DISTANCE_STEP = 100;

/**
 * The slice of the Durable Object this module calls.
 *
 * Declared structurally rather than imported, for two reasons. src/types.ts
 * declares the binding as a plain DurableObjectNamespace, whose stubs are
 * typed with no RPC methods on them at all; and importing the class to borrow
 * its type would point this file at src/do/van.ts, which imports this one.
 * A structural type keeps the dependency one-way and the call sites typed.
 */
interface VanStub {
  ping(p: PositionPing): Promise<{ stored: boolean; reason?: PingSkip }>;
  read(): Promise<{
    position: Omit<VanPosition, 'operator_id'> | null;
    trail: TrailPoint[];
    /** A fix is held but is past STALE_AFTER_SECONDS. position is null either way. */
    stale: boolean;
  }>;
  clear(): Promise<void>;
}

interface VanNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): VanStub;
}

/**
 * The object holding one operator's van, or null when the binding is absent.
 *
 * idFromName(operator_id) is the whole tenancy story: one object per operator,
 * named by the same id every other query in this file is scoped by. Nothing
 * can reach another operator's van without holding that operator's id.
 */
function vanFor(env: Env, operatorId: string): VanStub | null {
  // Through unknown so this file does not have to agree with src/types.ts
  // about how the binding is declared there.
  const ns = (env as unknown as { VAN?: VanNamespace }).VAN;
  return ns ? ns.get(ns.idFromName(operatorId)) : null;
}

/** Rounds toward a fixed number of decimals without floating-point tails. */
const roundTo = (n: number, decimals: number) => Number(n.toFixed(decimals));

/**
 * A coordinate that cannot exist is a bug in the client, not a position.
 *
 * Storing it would put the van in the sea, blow up every drive-time estimate
 * that touches it, and -- because the object holds exactly one position --
 * hide the real one until the next ping. Rejected loudly so the client is
 * fixed. Checked here, before the RPC, so a bad fix never crosses into the
 * object that other people's screens read from.
 */
function assertCoordinate(lat: unknown, lng: unknown): void {
  const okLat = typeof lat === 'number' && Number.isFinite(lat) && lat >= -90 && lat <= 90;
  const okLng = typeof lng === 'number' && Number.isFinite(lng) && lng >= -180 && lng <= 180;
  if (!okLat || !okLng) {
    throw badRequest('That is not a position on Earth.', 'bad_coordinate');
  }
}

/** Optional sensor readings: keep a real number, drop anything else. */
const optionalNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * Stores one fix, or decides not to.
 *
 * One RPC to the object that owns this van, and no database write at all. The
 * decisions themselves -- out_of_order, too_frequent, and stamping a
 * future-dated fix with now -- are made inside the object, next to the state
 * they are comparing against, because that is the only place the comparison
 * can be race-free: two Workers can handle two pings for the same van at once,
 * and a Durable Object is single-threaded per van by construction. See
 * src/do/van.ts.
 *
 * Two pings come back stored: false, and neither is an error -- a dropped ping
 * is the normal, expected outcome of a phone doing its job, and turning it
 * into a 4xx would teach the client to retry the one thing we want less of:
 *
 *   out_of_order -- the fix is older than the one the van holds. Phones
 *     deliver fixes out of order routinely (a queued fix from a dead spot
 *     arrives after a fresh one), and taking it would drag the van backwards
 *     on the customer's screen to a place it has already left.
 *
 *   too_frequent -- the fix is inside MIN_PING_SECONDS of the held one. See
 *     the constant.
 */
export async function recordPosition(
  env: Env, operatorId: string, p: PositionPing,
): Promise<{ stored: boolean; reason?: PingSkip }> {
  const id = (operatorId ?? '').trim();
  if (!id) throw badRequest('A position needs an operator.', 'no_operator');

  assertCoordinate(p?.lat, p?.lng);

  const van = vanFor(env, id);
  // No binding: the ping is taken and dropped. Nothing else depends on it, so
  // this degrades to "no van on the map" rather than a 500 on the busiest
  // endpoint in the product.
  if (!van) return { stored: false };

  // Sensor readings are cleaned here, at the edge, so nothing but numbers or
  // nulls crosses the RPC boundary. lat/lng were checked above.
  return van.ping({
    lat: p.lat,
    lng: p.lng,
    accuracy_meters: optionalNumber(p.accuracy_meters),
    heading: optionalNumber(p.heading),
    speed_mps: optionalNumber(p.speed_mps),
    recorded_at: optionalNumber(p.recorded_at),
  });
}

/**
 * The operator's own view of their own van.
 *
 * No consent gate, no time window, no rounding: it is their phone, their van
 * and their dashboard, and the gates in customerView() exist to protect this
 * person, not to keep anything from them.
 *
 * The one thing they do not get is a fix older than STALE_AFTER_SECONDS, which
 * reads as no van rather than as a position -- being shown a dot we already
 * know is wrong is worse than being shown nothing.
 */
export async function operatorPosition(
  env: Env, operatorId: string,
): Promise<{ position: VanPosition | null; trail: TrailPoint[] }> {
  const id = (operatorId ?? '').trim();
  if (!id) return { position: null, trail: [] };

  const van = vanFor(env, id);
  if (!van) return { position: null, trail: [] };

  // The trail comes back oldest first -- a polyline is drawn oldest point to
  // newest, and doing it there means every caller does not.
  const { position, trail } = await van.read();

  // The object is addressed by the operator id, so it does not carry one
  // inside it. Put it back here, where the dashboard expects the full shape.
  return { position: position ? { operator_id: id, ...position } : null, trail };
}

/**
 * Turns location sharing on or off for one operator.
 *
 * The only thing in the codebase that may move share_location. It defaults to
 * 0 in migration 0014 and nothing else -- no admin path, no signup default, no
 * "helpfully enabled for you" -- ever sets it, because a person must switch
 * this on themselves knowing what it does.
 *
 * It stays in D1 because it is a setting, not a position: it changes when a
 * person changes it, it must survive everything, and it is read once per
 * customer view rather than twice a minute per van.
 *
 * Turning it off takes effect on the next customer read, which is immediate.
 * The position is now cached in a Durable Object, but this column is not:
 * customerView() reads it from D1 every time and gives up before it ever asks
 * the object where the van is.
 */
export async function setShareLocation(
  env: Env, operatorId: string, on: boolean,
): Promise<void> {
  const id = (operatorId ?? '').trim();
  if (!id) throw badRequest('A setting needs an operator.', 'no_operator');
  await env.DB.prepare(
    `UPDATE operators SET share_location = ?, updated_at = ? WHERE id = ?`,
  ).bind(on ? 1 : 0, now(), id).run();
}

/** Why a customer is not being shown the van. Every one of these is a normal state. */
export type CustomerHiddenReason =
  | 'no_thread'          // the link does not resolve -- expired, mistyped, revoked
  | 'no_appointment'     // a pre-booking conversation; there is nothing to track to
  | 'cancelled'          // the appointment is off, so nobody is driving to it
  | 'not_sharing'        // the operator has not turned location sharing on
  | 'not_today'          // the appointment is not today
  | 'outside_window'     // today, but not yet / no longer close enough to it
  | 'no_position'        // the van has never pinged
  | 'stale'              // the last fix is older than STALE_AFTER_SECONDS
  | 'no_destination';    // the appointment has no coordinates, so no ETA is possible

export type CustomerView =
  | { visible: false; reason: CustomerHiddenReason }
  | {
      visible: true;
      /** Rounded to CUSTOMER_DECIMALS (~110 m). Never the raw fix. */
      lat: number;
      lng: number;
      /** Drive time from the van to the appointment address. */
      eta_seconds: number;
      /** Rounded to the nearest CUSTOMER_DISTANCE_STEP metres. */
      distance_meters: number;
      recorded_at: number;
      /**
       * The appointment address. Exact on purpose: it is the customer's own
       * address, so it reveals nothing they do not know, and without it the
       * map is a single dot with nothing to be near.
       */
      dest_lat: number;
      dest_lng: number;
    };

/**
 * What a customer holding a chat link may see, which is deliberately very little.
 *
 * The customer has no account -- their identity is the secret in their link,
 * exactly as in migration 0011 -- so this is authorised by the thread token and
 * nothing else, and the thread's own operator_id scopes every query below. A
 * customer of one business cannot reach another business's van: there is no
 * parameter here that could name one.
 *
 * ALL of these must hold, or the answer is { visible: false } with a reason:
 *
 *   1. the operator has share_location = 1        (consent)
 *   2. the appointment is today, and now is between 90 minutes before it
 *      starts and 30 minutes after it ends       (time)
 *   3. the stored fix is fresher than 10 minutes (freshness)
 *
 * Any one of them failing closes the window, and all three close on their own
 * -- nobody has to remember to switch anything off. That is what stops this
 * being a link that follows a person around after the job is done.
 */
export async function customerView(env: Env, threadToken: string): Promise<CustomerView> {
  const thread = await threadByToken(env, threadToken ?? '');
  if (!thread) return { visible: false, reason: 'no_thread' };
  if (!thread.appointment_id) return { visible: false, reason: 'no_appointment' };

  const appointment = await env.DB.prepare(
    `SELECT starts_at, ends_at, lat, lng, status FROM appointments
      WHERE id = ? AND operator_id = ?`,
  ).bind(thread.appointment_id, thread.operator_id)
    .first<{ starts_at: number; ends_at: number; lat: number | null; lng: number | null;
             status: string }>();
  if (!appointment) return { visible: false, reason: 'no_appointment' };
  if (appointment.status !== 'scheduled') return { visible: false, reason: 'cancelled' };

  const operator = await env.DB.prepare(
    `SELECT share_location, timezone FROM operators WHERE id = ?`,
  ).bind(thread.operator_id).first<{ share_location: number; timezone: string }>();
  if (!operator || operator.share_location !== 1) {
    return { visible: false, reason: 'not_sharing' };
  }

  const t = now();

  // "Today" is the operator's local day, not UTC. A 9am job in Los Angeles is
  // tomorrow in UTC for most of the working day, and a UTC comparison would
  // black the map out for the entire west coast every afternoon.
  if (localDayStart(appointment.starts_at, operator.timezone)
      !== localDayStart(t, operator.timezone)) {
    return { visible: false, reason: 'not_today' };
  }

  if (t < appointment.starts_at - WINDOW_BEFORE_SECONDS
      || t > appointment.ends_at + WINDOW_AFTER_SECONDS) {
    return { visible: false, reason: 'outside_window' };
  }

  if (appointment.lat == null || appointment.lng == null) {
    return { visible: false, reason: 'no_destination' };
  }

  // Scoped to the thread's operator, and that is the whole tenant boundary:
  // the object is named by the thread's own operator_id, and there is no
  // parameter on this function a customer could supply to name a different
  // one. This is the only van this token can reach.
  const stub = vanFor(env, thread.operator_id);
  if (!stub) return { visible: false, reason: 'no_position' };

  // read() applies the staleness cut-off itself and returns no position past
  // it -- a ten-minute-old fix says "two streets away" about a van that has
  // finished the job and driven home, and the customer stands at the window.
  // The flag is only so we can tell them which of the two silences this is.
  const { position: van, stale } = await stub.read();
  if (!van) return { visible: false, reason: stale ? 'stale' : 'no_position' };

  const from: Point = { lat: van.lat, lng: van.lng };
  const to: Point = { lat: appointment.lat, lng: appointment.lng };

  // driveSeconds is cache-first and falls back to the free estimate, so this
  // is normally zero network calls and one indexed read. The catch is there
  // because an ETA is a nice-to-have on top of "they are close": a geocoding
  // provider having a bad afternoon must not black out the whole view.
  let eta: number;
  try {
    const [secs] = await driveSeconds(env, thread.operator_id, [[from, to]]);
    eta = secs ?? estimateDriveSeconds(from, to);
  } catch {
    eta = estimateDriveSeconds(from, to);
  }

  const exact = haversineMeters(from, to);

  return {
    visible: true,
    // Rounded HERE, on the way out. The raw fix never leaves the Worker.
    lat: roundTo(van.lat, CUSTOMER_DECIMALS),
    lng: roundTo(van.lng, CUSTOMER_DECIMALS),
    eta_seconds: eta,
    distance_meters: Math.round(exact / CUSTOMER_DISTANCE_STEP) * CUSTOMER_DISTANCE_STEP,
    recorded_at: van.recorded_at,
    // The customer's own address. They already know where they live, so this
    // leaks nothing — and without it the map is a lone dot with no anchor,
    // which tells them the van is somewhere rather than that it is close.
    dest_lat: appointment.lat,
    dest_lng: appointment.lng,
  };
}
