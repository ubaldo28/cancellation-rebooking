import type { Env, Point } from '../types';
import { driveSeconds } from './geo';
import { addLocalDays, localDayStart } from './tz';
import { badRequest, conflict, newId, notFound, now } from './util';

/**
 * Openings an operator types in by hand.
 *
 * Until now the only way an opening could exist was detectGaps finding a hole
 * between two booked jobs. That means the product does nothing at all until
 * the operator has entered their whole calendar — and the people most worth
 * having here are the ones who already have a full book and no interest in
 * re-typing it. They want to put up the one Thursday afternoon they have free
 * and go back to work.
 *
 * A posted opening is a gap row like any other, so everything downstream —
 * the public listing, claiming, chat, notifications — works on it unchanged.
 * The only difference is gaps.source, which tells detectGaps to keep its hands
 * off (see the expiry pass in ./gaps).
 */

export interface PostOpeningInput {
  starts_at: number;
  ends_at: number;
  /** Empty or omitted means "anything I sell that fits", the existing behaviour. */
  service_ids?: string[];
  is_mobile?: boolean;
  location_id?: string | null;
}

export interface Opening {
  id: string;
  operator_id: string;
  starts_at: number;
  ends_at: number;
  duration_seconds: number;
  is_mobile: number;
  location_id: string | null;
  status: string;
  source: 'detected' | 'posted';
  prev_lat: number | null;
  prev_lng: number | null;
  next_lat: number | null;
  next_lng: number | null;
  baseline_drive_seconds: number | null;
  /** Empty array means every eligible service, not "none". */
  service_ids: string[];
  created_at: number;
  updated_at: number;
}

/** Nobody sells a six-minute slot, and a stray unit slip should not create one. */
const MIN_POSTED_SECONDS = 300;
/** A month-long "opening" is a mistyped year, not an offer. */
const MAX_POSTED_SECONDS = 24 * 3600;

interface OperatorRow {
  id: string; timezone: string; location_mode: string;
  home_lat: number | null; home_lng: number | null;
}

interface AnchorRow {
  id: string; starts_at: number; ends_at: number; lat: number | null; lng: number | null;
}

const GAP_FIELDS =
  `id, operator_id, starts_at, ends_at, is_mobile, location_id, status, source,
   prev_lat, prev_lng, next_lat, next_lng, baseline_drive_seconds,
   created_at, updated_at`;

/** Attach each gap's chosen services in one query, so a list is two reads not N. */
async function withServices(
  env: Env, rows: Array<Record<string, any>>,
): Promise<Opening[]> {
  const openings: Opening[] = rows.map((r) => ({
    id: r.id,
    operator_id: r.operator_id,
    starts_at: r.starts_at,
    ends_at: r.ends_at,
    duration_seconds: r.ends_at - r.starts_at,
    is_mobile: r.is_mobile,
    location_id: r.location_id ?? null,
    status: r.status,
    source: r.source,
    prev_lat: r.prev_lat ?? null,
    prev_lng: r.prev_lng ?? null,
    next_lat: r.next_lat ?? null,
    next_lng: r.next_lng ?? null,
    baseline_drive_seconds: r.baseline_drive_seconds ?? null,
    service_ids: [],
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
  if (openings.length === 0) return openings;

  const byId = new Map(openings.map((o) => [o.id, o]));
  const ids = [...byId.keys()];
  // D1 caps bound parameters per statement, the same reason ./geo chunks its
  // cache lookup.
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const res = await env.DB.prepare(
      `SELECT gap_id, service_id FROM gap_services
        WHERE gap_id IN (${chunk.map(() => '?').join(',')})`,
    ).bind(...chunk).all<{ gap_id: string; service_id: string }>();
    for (const r of res.results ?? []) byId.get(r.gap_id)?.service_ids.push(r.service_id);
  }
  return openings;
}

async function loadOperator(env: Env, operatorId: string): Promise<OperatorRow> {
  const op = await env.DB.prepare(
    `SELECT id, timezone, location_mode, home_lat, home_lng
       FROM operators WHERE id = ?`,
  ).bind(operatorId).first<OperatorRow>();
  if (!op) throw notFound('No such business.');
  return op;
}

/**
 * An operator puts up one slot.
 *
 * Everything here is checked against the operator's own rows — services,
 * locations, appointments, gaps — and every query names operator_id in its
 * WHERE clause, so posting can never touch or read across a tenant boundary.
 */
export async function postOpening(
  env: Env, operatorId: string, input: PostOpeningInput,
): Promise<Opening> {
  const t = now();
  const startsAt = Math.floor(Number(input?.starts_at));
  const endsAt = Math.floor(Number(input?.ends_at));

  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) {
    throw badRequest('Pick a start and an end time for the slot.', 'bad_window');
  }
  if (endsAt <= startsAt) {
    throw badRequest('The slot has to end after it starts.', 'bad_window');
  }
  // "Same day or any future day" — but not this morning. A slot in the past
  // is either a typo or a timezone bug, and either way nobody can book it.
  if (startsAt <= t) {
    throw badRequest('That slot is in the past. Pick a time from now on.', 'past_window');
  }
  const length = endsAt - startsAt;
  if (length < MIN_POSTED_SECONDS) {
    throw badRequest('That slot is too short to book. Give it at least five minutes.',
      'window_too_short');
  }
  if (length > MAX_POSTED_SECONDS) {
    throw badRequest('A single slot cannot be longer than a day. Post one per day.',
      'window_too_long');
  }

  const op = await loadOperator(env, operatorId);

  // Duplicates are a double-tap on a chip, not an intent, and the UNIQUE on
  // (gap_id, service_id) would turn one into a 500.
  const serviceIds = [...new Set((input.service_ids ?? []).map((s) => String(s).trim()).filter(Boolean))];

  if (serviceIds.length) {
    const found = await env.DB.prepare(
      `SELECT id FROM services
        WHERE operator_id = ? AND id IN (${serviceIds.map(() => '?').join(',')})`,
    ).bind(operatorId, ...serviceIds).all<{ id: string }>();
    const owned = new Set((found.results ?? []).map((r) => r.id));
    const missing = serviceIds.filter((id) => !owned.has(id));
    // Deliberately the same message whether the service belongs to someone
    // else or does not exist: which of the two it is, is not this caller's
    // business to learn.
    if (missing.length) {
      throw badRequest('One of those services is not on your price list.', 'bad_service');
    }
  }

  if (input.location_id) {
    const loc = await env.DB.prepare(
      `SELECT id FROM locations WHERE id = ? AND operator_id = ?`,
    ).bind(input.location_id, operatorId).first<{ id: string }>();
    if (!loc) throw badRequest('That is not one of your locations.', 'bad_location');
  }

  // Overlap, not containment: any intersection at all is a double booking.
  const clash = await env.DB.prepare(
    `SELECT id, starts_at, ends_at FROM appointments
      WHERE operator_id = ? AND status = 'scheduled'
        AND starts_at < ? AND ends_at > ?
      ORDER BY starts_at LIMIT 1`,
  ).bind(operatorId, endsAt, startsAt).first<{ starts_at: number; ends_at: number }>();
  if (clash) {
    throw conflict(
      'You already have a job booked in that window. Move the job or pick another time.',
      'appointment_overlap');
  }

  const dupe = await env.DB.prepare(
    `SELECT id FROM gaps
      WHERE operator_id = ? AND status IN ('open','offering')
        AND starts_at < ? AND ends_at > ?
      ORDER BY starts_at LIMIT 1`,
  ).bind(operatorId, endsAt, startsAt).first<{ id: string }>();
  if (dupe) {
    throw conflict(
      'That time is already listed as open. Cancel the existing slot first.',
      'gap_overlap');
  }

  // Anchors, computed the same way detectGaps computes them: the scheduled job
  // that ends before the slot and the one that starts after it, on that local
  // day, falling back to the operator's home when there is nothing either
  // side. Drive-time ranking in ./public reads prev_*/next_* and the baseline
  // and cannot tell where a gap came from, so a posted slot has to carry the
  // same anchors or it ranks as if the van were nowhere.
  const dayStart = localDayStart(startsAt, op.timezone);
  const dayEnd = addLocalDays(dayStart, op.timezone, 1);
  const sameDay = await env.DB.prepare(
    `SELECT id, starts_at, ends_at, lat, lng FROM appointments
      WHERE operator_id = ? AND status = 'scheduled'
        AND ends_at > ? AND starts_at < ?
      ORDER BY starts_at`,
  ).bind(operatorId, dayStart, dayEnd).all<AnchorRow>();

  let prev: AnchorRow | null = null;
  let next: AnchorRow | null = null;
  for (const a of sameDay.results ?? []) {
    if (a.ends_at <= startsAt && (!prev || a.ends_at > prev.ends_at)) prev = a;
    if (a.starts_at >= endsAt && (!next || a.starts_at < next.starts_at)) next = a;
  }

  const home: Point | null =
    op.home_lat != null && op.home_lng != null ? { lat: op.home_lat, lng: op.home_lng } : null;
  const pPoint: Point | null =
    prev?.lat != null && prev.lng != null ? { lat: prev.lat, lng: prev.lng } : home;
  const nPoint: Point | null =
    next?.lat != null && next.lng != null ? { lat: next.lat, lng: next.lng } : home;

  const isMobile = input.is_mobile === undefined
    ? op.location_mode !== 'premises'
    : (input.is_mobile ? 1 : 0) === 1;

  let baseline: number | null = null;
  if (isMobile && pPoint && nPoint) {
    const [secs] = await driveSeconds(env, operatorId, [[pPoint, nPoint]]);
    baseline = secs ?? null;
  }

  const gapId = newId();
  const writes: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO gaps
         (id, operator_id, starts_at, ends_at, prev_appointment_id, next_appointment_id,
          prev_lat, prev_lng, next_lat, next_lng, baseline_drive_seconds,
          is_mobile, location_id, fills_whole_day, status, source, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,'open','posted',?,?)`,
    ).bind(gapId, operatorId, startsAt, endsAt,
      prev?.id ?? null, next?.id ?? null,
      pPoint?.lat ?? null, pPoint?.lng ?? null,
      nPoint?.lat ?? null, nPoint?.lng ?? null,
      baseline, isMobile ? 1 : 0, input.location_id ?? null, t, t),
  ];
  for (const serviceId of serviceIds) {
    writes.push(env.DB.prepare(
      `INSERT INTO gap_services (id, gap_id, service_id, created_at) VALUES (?,?,?,?)`,
    ).bind(newId(), gapId, serviceId, t));
  }

  try {
    // One batch: a gap that exists with none of its chosen services attached
    // reads as "any service", which is the opposite of what was typed.
    await env.DB.batch(writes);
  } catch (e) {
    // The partial unique index on (operator_id, starts_at, ends_at) can still
    // fire if someone posted the identical window a millisecond ago.
    if (String(e).includes('UNIQUE') || String(e).includes('constraint')) {
      throw conflict('That time is already listed as open.', 'gap_overlap');
    }
    throw e;
  }

  const row = await env.DB.prepare(
    `SELECT ${GAP_FIELDS} FROM gaps WHERE id = ? AND operator_id = ?`,
  ).bind(gapId, operatorId).first<any>();
  const [opening] = await withServices(env, row ? [row] : []);
  if (!opening) throw notFound('The slot could not be read back.');
  return opening;
}

/**
 * Everything the operator has open in a window, posted or detected.
 *
 * The operator's own list, so it shows both kinds — the point of the screen is
 * "what am I selling", and where a slot came from is a label on it, not a
 * filter.
 */
export async function listOpenings(
  env: Env, operatorId: string, fromTs: number, toTs: number,
): Promise<Opening[]> {
  const res = await env.DB.prepare(
    `SELECT ${GAP_FIELDS} FROM gaps
      WHERE operator_id = ? AND status IN ('open','offering')
        AND starts_at >= ? AND starts_at < ?
      ORDER BY starts_at`,
  ).bind(operatorId, fromTs, toTs).all<any>();
  return withServices(env, res.results ?? []);
}

/**
 * The operator takes a slot back down.
 *
 * 'dismissed' rather than a delete: the row may already be referenced by an
 * offer or a conversation, and a deleted gap takes those with it. A dismissed
 * gap simply stops being listed.
 */
export async function cancelOpening(
  env: Env, operatorId: string, gapId: string,
): Promise<void> {
  const res = await env.DB.prepare(
    `UPDATE gaps SET status = 'dismissed', updated_at = ?
      WHERE id = ? AND operator_id = ? AND status IN ('open','offering')`,
  ).bind(now(), gapId, operatorId).run();
  if ((res.meta.changes ?? 0) === 0) {
    throw notFound('That slot is not open, or is not yours.');
  }
}
