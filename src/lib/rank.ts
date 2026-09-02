import type { Candidate, Env, Operator, Point } from '../types';
import { driveSeconds } from './geo';
import { now } from './util';

export interface GapRow {
  id: string; starts_at: number; ends_at: number;
  prev_lat: number | null; prev_lng: number | null;
  next_lat: number | null; next_lng: number | null;
  baseline_drive_seconds: number | null;
  is_mobile: number; status: string;
}

/**
 * Ranking weights. Deliberately explicit and summing to 1 so the score stays
 * readable, and so the reason strings shown to the operator match the maths.
 */
const W_PROXIMITY = 0.5;   // can I actually get there and back without wrecking the day
const W_READINESS = 0.35;  // how overdue / how urgent
const W_VALUE = 0.15;      // what the job is worth

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * How late a client is, in words an operator would use.
 *
 * `days` is measured from the client's DUE date (last visit + the service's
 * cadence), never from the last visit itself. Weeks use floor so the label
 * never overstates how late someone is.
 */
export function lateLabel(days: number): string {
  if (days < 0) {
    const ahead = -days;
    return ahead === 1 ? 'due tomorrow' : `due in ${ahead} days`;
  }
  if (days === 0) return 'due today';
  if (days < 14) return `${days} days late`;
  const weeks = Math.floor(days / 7);
  return `${weeks} weeks late`;
}

/**
 * Build and score the candidate list for one gap.
 *
 * Two candidate sources, unioned:
 *   clients — recurring trades: someone overdue for their next visit
 *   leads   — break-fix trades: quoted work that never got booked
 *
 * Hard filters run in SQL (consent, opt-out, cooldown, parts, duration fit).
 * Soft ranking runs here. A candidate that fails a hard filter is never scored,
 * so the operator can trust that everything on screen is actually offerable.
 */
export async function rankCandidates(
  env: Env, op: Operator, gap: GapRow, limit = 25,
): Promise<Candidate[]> {
  const t = now();
  const gapSeconds = gap.ends_at - gap.starts_at;
  const cooldownBefore = t - op.reoffer_cooldown_seconds;

  const wantClients = op.fill_model === 'clients' || op.fill_model === 'both';
  const wantLeads = op.fill_model === 'leads' || op.fill_model === 'both';

  const rows: any[] = [];

  if (wantClients) {
    const r = await env.DB.prepare(
      `SELECT 'client' AS kind, c.id AS client_id, NULL AS lead_id,
              s.id AS service_id, c.first_name, c.phone_e164, c.language, c.lat, c.lng,
              COALESCE(s.duration_seconds, 3600) AS duration_seconds,
              COALESCE(s.price_cents, 0)        AS price_cents,
              COALESCE(s.name, 'Appointment')   AS title,
              c.next_due_at, NULL AS urgency, c.no_show_count,
              COALESCE(s.requires_client_present, 1) AS requires_client_present
         FROM clients c
         LEFT JOIN services s ON s.id = c.default_service_id AND s.is_active = 1
        WHERE c.operator_id = ?
          AND c.is_active = 1
          AND c.opted_out_at IS NULL
          AND c.sms_consent = 1
          AND c.phone_e164 IS NOT NULL
          AND (c.last_offered_at IS NULL OR c.last_offered_at < ?)
          AND COALESCE(s.gap_fill_eligible, 1) = 1
          AND COALESCE(s.duration_seconds, 3600) <= ?
          AND (c.next_due_at IS NULL OR c.next_due_at <= ?)
          AND NOT EXISTS (
                SELECT 1 FROM appointments a
                 WHERE a.client_id = c.id AND a.status = 'scheduled' AND a.starts_at > ?)
        LIMIT 400`,
    ).bind(op.id, cooldownBefore, gapSeconds, gap.ends_at, t).all();
    rows.push(...(r.results ?? []));
  }

  if (wantLeads) {
    const r = await env.DB.prepare(
      `SELECT 'lead' AS kind, c.id AS client_id, l.id AS lead_id,
              l.service_id, c.first_name, c.phone_e164, c.language,
              COALESCE(l.lat, c.lat) AS lat, COALESCE(l.lng, c.lng) AS lng,
              COALESCE(l.estimated_duration_seconds, s.duration_seconds, 3600) AS duration_seconds,
              COALESCE(l.quoted_price_cents, s.price_cents, 0) AS price_cents,
              l.title, NULL AS next_due_at, l.urgency, c.no_show_count,
              COALESCE(s.requires_client_present, 1) AS requires_client_present
         FROM job_leads l
         JOIN clients c  ON c.id = l.client_id
         LEFT JOIN services s ON s.id = l.service_id
        WHERE l.operator_id = ?
          AND l.status = 'open'
          AND (l.parts_required = 0 OR l.parts_ready = 1)
          AND (l.expires_at IS NULL OR l.expires_at > ?)
          AND (l.last_offered_at IS NULL OR l.last_offered_at < ?)
          AND c.is_active = 1
          AND c.opted_out_at IS NULL
          AND c.sms_consent = 1
          AND c.phone_e164 IS NOT NULL
          AND COALESCE(l.estimated_duration_seconds, s.duration_seconds, 3600) <= ?
        LIMIT 400`,
    ).bind(op.id, t, cooldownBefore, gapSeconds).all();
    rows.push(...(r.results ?? []));
  }

  if (rows.length === 0) return [];

  // Drive times, but only for mobile gaps with a usable anchor and coordinates.
  const prev: Point | null =
    gap.prev_lat != null && gap.prev_lng != null ? { lat: gap.prev_lat, lng: gap.prev_lng } : null;
  const next: Point | null =
    gap.next_lat != null && gap.next_lng != null ? { lat: gap.next_lat, lng: gap.next_lng } : null;
  const useDriveTime = gap.is_mobile === 1 && (prev !== null || next !== null);

  const pairs: [Point, Point][] = [];
  const pairMap: Array<{ row: number; slot: 'in' | 'out' }> = [];
  if (useDriveTime) {
    rows.forEach((r, i) => {
      if (r.lat == null || r.lng == null) return;
      const p: Point = { lat: r.lat, lng: r.lng };
      if (prev) { pairs.push([prev, p]); pairMap.push({ row: i, slot: 'in' }); }
      if (next) { pairs.push([p, next]); pairMap.push({ row: i, slot: 'out' }); }
    });
  }
  const times = await driveSeconds(env, op.id, pairs);
  const driveIn = new Map<number, number>();
  const driveOut = new Map<number, number>();
  pairMap.forEach((m, n) => {
    (m.slot === 'in' ? driveIn : driveOut).set(m.row, times[n]!);
  });

  const maxPrice = Math.max(1, ...rows.map((r) => Number(r.price_cents) || 0));

  const scored: Candidate[] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const reasons: string[] = [];

    const dIn = driveIn.get(i) ?? null;
    const dOut = driveOut.get(i) ?? null;
    const baseline = gap.baseline_drive_seconds ?? 0;

    let detour: number | null = null;
    let proximity = 0.5;   // neutral when we have no geography to judge on

    if (useDriveTime && (dIn != null || dOut != null)) {
      const travel = (dIn ?? 0) + (dOut ?? 0);
      detour = Math.max(0, travel - baseline);

      // Hard filter: the job plus its travel must physically fit the gap.
      if (r.duration_seconds + travel > gapSeconds) continue;
      // Hard filter: operator's own tolerance for extra driving.
      if (detour > op.max_detour_seconds) continue;

      proximity = clamp01(1 - detour / Math.max(1, op.max_detour_seconds));
      const mins = Math.round(detour / 60);
      reasons.push(mins <= 1 ? 'basically on the way' : `${mins} min extra driving`);
    } else if (gap.is_mobile === 1 && r.lat == null) {
      // Mobile gap, unlocatable client: keep but rank low and say why.
      proximity = 0.15;
      reasons.push('no address on file');
    }

    // Readiness: how overdue (clients) or how urgent (leads).
    let readiness = 0.5;
    let overdueDays: number | null = null;
    if (r.kind === 'client') {
      if (r.next_due_at != null) {
        // Measured from the DUE date, not the last visit. Those differ by the
        // service's cadence, and conflating them is how a client who is
        // actually due next week reads as three weeks overdue.
        overdueDays = Math.floor((t - Number(r.next_due_at)) / 86400);
        readiness = clamp01(overdueDays / 30 + 0.35);
        reasons.push(lateLabel(overdueDays));
      } else {
        // No cadence means "overdue" has no meaning for this client. Say that,
        // rather than inventing a number from the last-visit date.
        readiness = 0.3;
        reasons.push('no repeat set');
      }
    } else {
      const urgency = Number(r.urgency) || 2;
      readiness = clamp01(urgency / 5);
      reasons.push(`open quote, urgency ${urgency}/5`);
    }

    // Short-notice penalty when the customer has to be there in person.
    const noticeSeconds = gap.starts_at - t;
    if (r.requires_client_present === 1 && noticeSeconds < 4 * 3600) {
      readiness *= 0.75;
      reasons.push('short notice, needs them home');
    }

    // Repeat no-shows are a real cost on a slot you are trying to rescue.
    if (Number(r.no_show_count) > 0) {
      readiness *= Math.max(0.4, 1 - Number(r.no_show_count) * 0.2);
      reasons.push(`${r.no_show_count} previous no-show(s)`);
    }

    const value = clamp01(Number(r.price_cents) / maxPrice);

    const score = W_PROXIMITY * proximity + W_READINESS * readiness + W_VALUE * value;

    scored.push({
      kind: r.kind,
      client_id: r.client_id,
      lead_id: r.lead_id ?? null,
      service_id: r.service_id ?? null,
      first_name: r.first_name,
      phone_e164: r.phone_e164,
      language: r.language ?? null,
      lat: r.lat, lng: r.lng,
      duration_seconds: Number(r.duration_seconds),
      price_cents: Number(r.price_cents),
      title: r.title,
      overdue_days: overdueDays,
      urgency: r.urgency != null ? Number(r.urgency) : null,
      drive_in_seconds: dIn,
      drive_out_seconds: dOut,
      detour_seconds: detour,
      score,
      reasons,
    });
  }

  // Never offer the same person twice for one gap; the client row wins over
  // a lead row only if it scores higher.
  const bestPerClient = new Map<string, Candidate>();
  for (const c of scored) {
    const existing = bestPerClient.get(c.client_id);
    if (!existing || c.score > existing.score) bestPerClient.set(c.client_id, c);
  }

  return [...bestPerClient.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
