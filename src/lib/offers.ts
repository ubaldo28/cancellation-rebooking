import type { Candidate, Env, Operator } from '../types';
import { hashOfferToken } from './auth';
import { formatMoney, localeFor } from './countries';
import { copy, pickLang } from './messages';
import { formatTimeRange } from './tz';
import { conflict, newId, newToken, notFound, now } from './util';
import type { GapRow } from './rank';

const money = (cents: number, currency: string, locale: string) =>
  formatMoney(cents, currency, locale);

export function buildMessage(
  op: Operator, cand: Candidate, gap: GapRow, url: string,
): string {
  const lang = pickLang(cand.language ?? null, op.language ?? null);
  const t = copy(lang);
  const locale = localeFor(op.country, lang);
  const when = formatTimeRange(gap.starts_at, gap.starts_at + cand.duration_seconds, op.timezone, locale);
  const discounted = op.discount_percent > 0
    ? Math.round(cand.price_cents * (1 - op.discount_percent / 100))
    : cand.price_cents;

  const price = cand.price_cents > 0
    ? op.discount_percent > 0
      ? ` ${money(discounted, op.currency, locale)} (${op.discount_percent}% off)`
      : ` ${money(discounted, op.currency, locale)}`
    : '';

  return t.sms({
    name: cand.first_name,
    business: op.business_name,
    when,
    price: price.trim(),
    service: cand.title,
    url,
  }) + `\n${t.optOut}`;
}

/**
 * Device-send links. The Worker never sends the SMS itself in 'device' mode —
 * it hands the operator a prefilled compose screen on their own phone. No
 * carrier registration, no per-message cost, and the message comes from the
 * number the client already knows.
 *
 * iOS and Android disagree on the separator, so both are returned and the
 * frontend picks by user agent rather than guessing server-side.
 */
export function deviceSendLinks(phone: string, body: string) {
  const encoded = encodeURIComponent(body);
  return {
    ios: `sms:${phone}&body=${encoded}`,
    android: `sms:${phone}?body=${encoded}`,
    body,
  };
}

export interface CreatedOffer {
  offer_id: string;
  client_id: string;
  first_name: string;
  phone_e164: string | null;
  url: string;
  message: string;
  send: { ios: string; android: string; body: string };
  rank: number;
  score: number;
  reasons: string[];
}

/**
 * Persist a wave of offers for a gap and return everything the dashboard needs
 * to actually get them sent. Marks the gap 'offering' so a concurrent
 * detection pass will not expire it out from under the live offers.
 */
export async function createOffers(
  env: Env, op: Operator, gap: GapRow, candidates: Candidate[],
): Promise<CreatedOffer[]> {
  if (candidates.length === 0) return [];
  const t = now();
  const expiresAt = Math.min(t + op.offer_ttl_seconds, gap.starts_at);

  const out: CreatedOffer[] = [];
  const writes: D1PreparedStatement[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    const raw = newToken(24);
    const url = `${env.APP_URL.replace(/\/$/, '')}/o/${raw}`;
    const message = buildMessage(op, c, gap, url);
    const offerId = newId();
    const discounted = op.discount_percent > 0
      ? Math.round(c.price_cents * (1 - op.discount_percent / 100))
      : c.price_cents;

    writes.push(env.DB.prepare(
      `INSERT INTO gap_offers
         (id, operator_id, gap_id, candidate_kind, client_id, lead_id, service_id,
          rank, drive_in_seconds, drive_out_seconds, detour_seconds, overdue_days,
          urgency, score, token_hash, status, sent_at, expires_at,
          quoted_price_cents, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'sent',?,?,?,?,?)
       ON CONFLICT (gap_id, client_id, COALESCE(lead_id, '')) DO UPDATE SET
         rank = excluded.rank, score = excluded.score,
         drive_in_seconds = excluded.drive_in_seconds,
         drive_out_seconds = excluded.drive_out_seconds,
         detour_seconds = excluded.detour_seconds,
         token_hash = excluded.token_hash,
         status = 'sent', sent_at = excluded.sent_at,
         expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
    ).bind(
      offerId, op.id, gap.id, c.kind, c.client_id, c.lead_id, c.service_id,
      i + 1, c.drive_in_seconds, c.drive_out_seconds, c.detour_seconds,
      c.overdue_days, c.urgency, c.score, await hashOfferToken(raw, env),
      t, expiresAt, discounted, t, t,
    ));

    writes.push(env.DB.prepare(
      `UPDATE clients SET last_offered_at = ?, updated_at = ? WHERE id = ? AND operator_id = ?`,
    ).bind(t, t, c.client_id, op.id));

    if (c.lead_id) {
      writes.push(env.DB.prepare(
        `UPDATE job_leads SET status = 'offered', last_offered_at = ?, updated_at = ?
          WHERE id = ? AND operator_id = ? AND status = 'open'`,
      ).bind(t, t, c.lead_id, op.id));
    }

    writes.push(env.DB.prepare(
      `INSERT INTO messages
         (id, operator_id, client_id, offer_id, direction, channel, to_address,
          body, status, created_at, updated_at)
       VALUES (?,?,?,?, 'out', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      newId(), op.id, c.client_id, offerId,
      op.sms_mode === 'device' ? 'device' : 'sms',
      c.phone_e164 ?? '', message,
      op.sms_mode === 'device' ? 'handed_off' : 'queued', t, t,
    ));

    out.push({
      offer_id: offerId,
      client_id: c.client_id,
      first_name: c.first_name,
      phone_e164: c.phone_e164,
      url, message,
      send: deviceSendLinks(c.phone_e164 ?? '', message),
      rank: i + 1,
      score: c.score,
      reasons: c.reasons,
    });
  }

  writes.push(env.DB.prepare(
    `UPDATE gaps SET status = 'offering', updated_at = ? WHERE id = ? AND status = 'open'`,
  ).bind(t, gap.id));

  await env.DB.batch(writes);
  return out;
}

export interface OfferView {
  offer_id: string; gap_id: string; operator_id: string;
  status: string; expires_at: number | null;
  starts_at: number; ends_at: number; gap_status: string;
  first_name: string; client_id: string; lead_id: string | null;
  service_id: string | null; quoted_price_cents: number | null;
  business_name: string; timezone: string; currency: string; country: string;
  duration_seconds: number; title: string;
  lat: number | null; lng: number | null;
  address_line: string | null; postcode: string | null;
}

export async function loadOfferByToken(env: Env, raw: string): Promise<OfferView> {
  const row = await env.DB.prepare(
    `SELECT o.id AS offer_id, o.gap_id, o.operator_id, o.status, o.expires_at,
            o.client_id, o.lead_id, o.service_id, o.quoted_price_cents,
            g.starts_at, g.ends_at, g.status AS gap_status,
            c.first_name,
            COALESCE(l.lat, c.lat) AS lat, COALESCE(l.lng, c.lng) AS lng,
            COALESCE(l.address_line, c.address_line) AS address_line,
            COALESCE(l.postcode, c.postcode) AS postcode,
            COALESCE(l.estimated_duration_seconds, s.duration_seconds, 3600) AS duration_seconds,
            COALESCE(l.title, s.name, 'Appointment') AS title,
            op.business_name, op.timezone, op.currency, op.country
       FROM gap_offers o
       JOIN gaps g      ON g.id = o.gap_id
       JOIN clients c   ON c.id = o.client_id
       JOIN operators op ON op.id = o.operator_id
       LEFT JOIN job_leads l ON l.id = o.lead_id
       LEFT JOIN services s  ON s.id = o.service_id
      WHERE o.token_hash = ?`,
  ).bind(await hashOfferToken(raw, env)).first<OfferView>();
  if (!row) throw notFound('This link is not valid.');
  return row;
}

/**
 * Accept an offer. Safe against two clients tapping at the same instant:
 * the whole thing is one D1 batch (a single transaction), and the partial
 * unique index `idx_offers_one_accept` makes a second accepted row on the same
 * gap impossible. The loser's batch fails and they get told it just went.
 */
export async function acceptOffer(env: Env, raw: string) {
  const t = now();
  const offer = await loadOfferByToken(env, raw);

  if (offer.status === 'accepted') return { alreadyYours: true, offer };
  if (!['sent', 'delivered', 'viewed', 'queued'].includes(offer.status)) {
    throw conflict('This offer is no longer open.', 'offer_closed');
  }
  if (offer.expires_at != null && offer.expires_at <= t) {
    throw conflict('This offer has expired.', 'offer_expired');
  }
  if (offer.gap_status === 'filled') {
    throw conflict('Sorry — that slot has just been taken.', 'slot_taken');
  }
  if (offer.starts_at <= t) {
    throw conflict('That slot has already started.', 'slot_passed');
  }

  const apptId = newId();
  const endsAt = Math.min(offer.starts_at + offer.duration_seconds, offer.ends_at);

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE gap_offers SET status='accepted', responded_at=?, updated_at=?
        WHERE id=? AND status IN ('sent','delivered','viewed','queued')`,
    ).bind(t, t, offer.offer_id),

    env.DB.prepare(
      `INSERT INTO appointments
         (id, operator_id, client_id, service_id, lead_id, starts_at, ends_at,
          is_mobile, address_line, postcode, lat, lng, status, price_cents,
          source, filled_offer_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'scheduled', ?, 'gap_fill', ?, ?, ?)`,
    ).bind(
      apptId, offer.operator_id, offer.client_id, offer.service_id, offer.lead_id,
      offer.starts_at, endsAt, 1, offer.address_line, offer.postcode,
      offer.lat, offer.lng, offer.quoted_price_cents, offer.offer_id, t, t,
    ),

    env.DB.prepare(
      `UPDATE gaps SET status='filled', filled_appointment_id=?, updated_at=?
        WHERE id=? AND status IN ('open','offering')`,
    ).bind(apptId, t, offer.gap_id),

    env.DB.prepare(
      `UPDATE gap_offers SET status='superseded', updated_at=?
        WHERE gap_id=? AND id<>? AND status IN ('candidate','queued','sent','delivered','viewed')`,
    ).bind(t, offer.gap_id, offer.offer_id),
  ];

  if (offer.lead_id) {
    statements.push(env.DB.prepare(
      `UPDATE job_leads SET status='scheduled', updated_at=? WHERE id=?`,
    ).bind(t, offer.lead_id));
  }

  try {
    const res = await env.DB.batch(statements);
    if ((res[0]?.meta.changes ?? 0) === 0) {
      throw conflict('Sorry — that slot has just been taken.', 'slot_taken');
    }
  } catch (err) {
    // The unique index fired: someone else accepted microseconds earlier.
    if (String(err).includes('UNIQUE') || String(err).includes('constraint')) {
      throw conflict('Sorry — that slot has just been taken.', 'slot_taken');
    }
    throw err;
  }

  return { alreadyYours: false, offer, appointment_id: apptId, ends_at: endsAt };
}

export async function declineOffer(env: Env, raw: string, reason: string | null) {
  const t = now();
  const offer = await loadOfferByToken(env, raw);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE gap_offers SET status='declined', responded_at=?, decline_reason=?, updated_at=?
        WHERE id=? AND status IN ('sent','delivered','viewed','queued')`,
    ).bind(t, reason, t, offer.offer_id),
    env.DB.prepare(
      `UPDATE job_leads SET status='open', updated_at=?
        WHERE id=? AND status='offered'`,
    ).bind(t, offer.lead_id ?? ''),
  ]);
  return offer;
}

export async function markViewed(env: Env, offerId: string) {
  await env.DB.prepare(
    `UPDATE gap_offers SET status='viewed', viewed_at=?, updated_at=?
      WHERE id=? AND status IN ('sent','delivered')`,
  ).bind(now(), now(), offerId).run();
}
