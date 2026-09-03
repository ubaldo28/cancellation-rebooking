import type { Env, Operator, Point } from '../types';
import { formatMoney, getCountry, localeFor, normalisePostcode } from './countries';
import { driveSeconds, geocode } from './geo';
import { formatTimeRange } from './tz';
import { badRequest, conflict, haversineMeters, newId, notFound, now, toE164 } from './util';

export interface Area {
  id: string; operator_id: string; name: string; slug: string;
  lat: number; lng: number; radius_meters: number;
}

/** A slot as a stranger sees it: a time, a price, and how close the van already is. */
export interface PublicSlot {
  gap_id: string;
  operator_id: string;
  business_name: string;
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
): Promise<PublicSlot[]> {
  const t = now();

  const rows = await env.DB.prepare(
    `SELECT g.id AS gap_id, g.starts_at, g.ends_at, g.is_mobile,
            g.prev_lat, g.prev_lng, g.next_lat, g.next_lng, g.baseline_drive_seconds,
            o.id AS operator_id, o.business_name, o.timezone, o.country, o.language,
            o.currency, o.deposit_cents, o.max_detour_seconds, o.discount_percent,
            a.lat AS area_lat, a.lng AS area_lng, a.radius_meters,
            s.id AS service_id, s.name AS service_name,
            s.duration_seconds, s.price_cents
       FROM gaps g
       JOIN operators o     ON o.id = g.operator_id
       JOIN service_areas a ON a.operator_id = o.id AND a.is_active = 1
       LEFT JOIN services s ON s.operator_id = o.id AND s.is_active = 1
                           AND s.gap_fill_eligible = 1
      WHERE g.status IN ('open','offering')
        AND g.starts_at > ?
        AND o.accept_public_bookings = 1
        AND o.plan IN ('trial','active')
        AND (? IS NULL OR a.slug = ?)
        AND NOT EXISTS (SELECT 1 FROM public_claims c
                         WHERE c.gap_id = g.id AND c.status = 'confirmed')
      ORDER BY g.starts_at
      LIMIT 200`,
  ).bind(t + 3600, slug, slug).all<any>();

  const candidates = (rows.results ?? []).filter((r) => {
    if (!r.service_id) return false;                       // nothing to sell
    if (r.duration_seconds > r.ends_at - r.starts_at) return false;
    if (!at) return true;
    // Coarse gate: inside the operator's stated working area.
    return haversineMeters(at, { lat: r.area_lat, lng: r.area_lng }) <= r.radius_meters;
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
  const times = await driveSeconds(env, 'public', pairs);
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
    const price = r.discount_percent > 0
      ? Math.round(r.price_cents * (1 - r.discount_percent / 100))
      : r.price_cents;
    const mins = detour === null ? null : Math.round(detour / 60);

    out.push({
      gap_id: r.gap_id,
      operator_id: r.operator_id,
      business_name: r.business_name,
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
      proximity: mins === null ? null
        : mins <= 2 ? 'already on your street'
        : mins <= 6 ? `${mins} minutes from their next job`
        : `${mins} minutes out of their way`,
    });
  }

  // Closest first — proximity is the reason to book, so it leads.
  out.sort((a, b) =>
    (a.detour_minutes ?? 999) - (b.detour_minutes ?? 999) || a.starts_at - b.starts_at);
  return out.slice(0, limit);
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
}): Promise<{ appointment_id: string; slot: PublicSlot }> {
  const t = now();

  const row = await env.DB.prepare(
    `SELECT g.*, o.country, o.currency, o.timezone, o.language, o.deposit_cents,
            o.max_detour_seconds, o.discount_percent, o.business_name,
            o.accept_public_bookings
       FROM gaps g JOIN operators o ON o.id = g.operator_id
      WHERE g.id = ?`,
  ).bind(input.gapId).first<any>();

  if (!row) throw notFound('That slot is no longer listed.');
  if (row.accept_public_bookings !== 1) throw notFound('That slot is no longer listed.');
  if (!['open', 'offering'].includes(row.status)) {
    throw conflict('Sorry — that slot has just been taken.', 'slot_taken');
  }
  if (row.starts_at <= t) throw conflict('That slot has already started.', 'slot_passed');

  const country = getCountry(row.country);
  const phone = toE164(input.first_name ? input.phone : null, row.country);
  if (!phone) throw badRequest('That does not look like a valid mobile number.', 'bad_phone');
  if (!input.first_name?.trim()) throw badRequest('We need a name for the booking.');

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
      ORDER BY price_cents DESC LIMIT 1`,
  ).bind(row.operator_id, row.ends_at - row.starts_at).first<any>();
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

  const price = row.discount_percent > 0
    ? Math.round(service.price_cents * (1 - row.discount_percent / 100))
    : service.price_cents;

  const clientId = newId();
  const apptId = newId();
  const claimId = newId();
  const endsAt = Math.min(row.starts_at + service.duration_seconds, row.ends_at);

  try {
    const res = await env.DB.batch([
      // A public booking creates a real client on the operator's list — that is
      // the thing the platform actually delivered, marked so it can be counted.
      env.DB.prepare(
        `INSERT INTO clients (id, operator_id, first_name, phone_e164, email,
           address_line, postcode, lat, lng, geocode_status, geocoded_at,
           default_service_id, sms_consent, sms_consent_at, acquired,
           created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?, 'public', ?,?)`,
      ).bind(clientId, row.operator_id, input.first_name.trim(), phone,
        input.email ?? null, input.address_line ?? null, postcode,
        at?.lat ?? null, at?.lng ?? null, at ? 'ok' : 'failed', at ? t : null,
        service.id, t, t, t),

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
  return {
    appointment_id: apptId,
    slot: {
      gap_id: input.gapId, operator_id: row.operator_id,
      business_name: row.business_name,
      service_id: service.id, service_name: service.name,
      starts_at: row.starts_at, ends_at: endsAt,
      duration_seconds: service.duration_seconds,
      price_cents: price, deposit_cents: row.deposit_cents, currency: row.currency,
      when: formatTimeRange(row.starts_at, endsAt, row.timezone, locale),
      price: formatMoney(price, row.currency, locale),
      detour_minutes: detour === null ? null : Math.round(detour / 60),
      proximity: null,
    },
  };
}
