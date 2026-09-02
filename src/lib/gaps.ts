import type { Env, Operator, Point } from '../types';
import { newId, now } from './util';
import { addLocalDays, fromLocal, localDayStart, toLocal } from './tz';
import { driveSeconds } from './geo';

interface Interval { start: number; end: number }

interface ApptRow {
  id: string; starts_at: number; ends_at: number;
  lat: number | null; lng: number | null; is_mobile: number;
}

/** Subtract a set of busy intervals from one free window. */
function subtract(window: Interval, busy: Interval[]): Interval[] {
  let free: Interval[] = [window];
  for (const b of busy) {
    const next: Interval[] = [];
    for (const f of free) {
      if (b.end <= f.start || b.start >= f.end) { next.push(f); continue; }
      if (b.start > f.start) next.push({ start: f.start, end: b.start });
      if (b.end < f.end) next.push({ start: b.end, end: f.end });
    }
    free = next;
  }
  return free;
}

/**
 * Recompute open gaps for an operator over a window of local days.
 *
 * Idempotent: re-running produces the same rows. Gaps already in 'offering'
 * are left alone so a live offer never loses the record it points at. Open
 * gaps whose window no longer exists (because the slot got booked) are expired.
 */
export async function detectGaps(
  env: Env, op: Operator, fromDay: number, days = 14,
): Promise<{ created: number; expired: number; gaps: Interval[] }> {
  const tz = op.timezone;
  const t = now();
  const earliest = t + op.min_notice_seconds;

  const rangeStart = localDayStart(fromDay, tz);
  const rangeEnd = addLocalDays(rangeStart, tz, days);

  const [hoursRes, apptRes, offRes] = await Promise.all([
    env.DB.prepare(
      `SELECT weekday, start_minute, end_minute, location_id
         FROM working_hours WHERE operator_id = ? ORDER BY weekday, start_minute`,
    ).bind(op.id).all<{ weekday: number; start_minute: number; end_minute: number; location_id: string | null }>(),
    env.DB.prepare(
      `SELECT id, starts_at, ends_at, lat, lng, is_mobile
         FROM appointments
        WHERE operator_id = ? AND status = 'scheduled'
          AND ends_at > ? AND starts_at < ?
        ORDER BY starts_at`,
    ).bind(op.id, rangeStart, rangeEnd).all<ApptRow>(),
    env.DB.prepare(
      `SELECT starts_at, ends_at FROM time_off
        WHERE operator_id = ? AND ends_at > ? AND starts_at < ?`,
    ).bind(op.id, rangeStart, rangeEnd).all<{ starts_at: number; ends_at: number }>(),
  ]);

  const hours = hoursRes.results ?? [];
  const appts = apptRes.results ?? [];
  const timeOff = (offRes.results ?? []).map((r) => ({ start: r.starts_at, end: r.ends_at }));

  if (hours.length === 0) return { created: 0, expired: 0, gaps: [] };

  // Buffered busy blocks. The buffer is why a 30-minute hole between two jobs
  // does not get offered as bookable time.
  const busy: Interval[] = [
    ...appts.map((a) => ({
      start: a.starts_at - op.buffer_seconds,
      end: a.ends_at + op.buffer_seconds,
    })),
    ...timeOff,
  ].sort((x, y) => x.start - y.start);

  const found: Array<Interval & { locationId: string | null }> = [];

  for (let d = 0; d < days; d++) {
    const dayStart = addLocalDays(rangeStart, tz, d);
    const local = toLocal(dayStart, tz);
    for (const h of hours) {
      if (h.weekday !== local.weekday) continue;
      const winStart = fromLocal(tz, local.year, local.month, local.day, h.start_minute);
      const winEnd = fromLocal(tz, local.year, local.month, local.day, h.end_minute);
      for (const f of subtract({ start: winStart, end: winEnd }, busy)) {
        const start = Math.max(f.start, earliest);
        if (f.end - start >= op.min_gap_seconds) {
          found.push({ start, end: f.end, locationId: h.location_id });
        }
      }
    }
  }

  // Anchors: the job before and after each gap, for drive-time ranking.
  const anchorFor = (gap: Interval) => {
    let prev: ApptRow | null = null;
    let next: ApptRow | null = null;
    for (const a of appts) {
      if (a.ends_at <= gap.start && (!prev || a.ends_at > prev.ends_at)) prev = a;
      if (a.starts_at >= gap.end && (!next || a.starts_at < next.starts_at)) next = a;
    }
    return { prev, next };
  };

  const home: Point | null =
    op.home_lat != null && op.home_lng != null ? { lat: op.home_lat, lng: op.home_lng } : null;

  const isMobileOperator = op.location_mode !== 'premises';

  // Baseline drive prev -> next, so a candidate's detour cost is measurable.
  const baselinePairs: [Point, Point][] = [];
  const baselineIdx: number[] = [];
  const anchors = found.map((g, i) => {
    const { prev, next } = anchorFor(g);
    const pPoint: Point | null =
      prev?.lat != null && prev.lng != null ? { lat: prev.lat, lng: prev.lng } : home;
    const nPoint: Point | null =
      next?.lat != null && next.lng != null ? { lat: next.lat, lng: next.lng } : home;
    if (isMobileOperator && pPoint && nPoint) {
      baselineIdx.push(i);
      baselinePairs.push([pPoint, nPoint]);
    }
    return { prev, next, pPoint, nPoint };
  });

  const baselines = await driveSeconds(env, op.id, baselinePairs);
  const baselineByGap = new Map<number, number>();
  baselineIdx.forEach((gapIdx, n) => baselineByGap.set(gapIdx, baselines[n]!));

  const writes: D1PreparedStatement[] = [];
  for (let i = 0; i < found.length; i++) {
    const g = found[i]!;
    const a = anchors[i]!;
    writes.push(env.DB.prepare(
      `INSERT INTO gaps
         (id, operator_id, starts_at, ends_at, prev_appointment_id, next_appointment_id,
          prev_lat, prev_lng, next_lat, next_lng, baseline_drive_seconds,
          is_mobile, location_id, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?)
       ON CONFLICT (operator_id, starts_at, ends_at) WHERE status IN ('open','offering')
       DO UPDATE SET
         prev_appointment_id = excluded.prev_appointment_id,
         next_appointment_id = excluded.next_appointment_id,
         prev_lat = excluded.prev_lat, prev_lng = excluded.prev_lng,
         next_lat = excluded.next_lat, next_lng = excluded.next_lng,
         baseline_drive_seconds = excluded.baseline_drive_seconds,
         updated_at = excluded.updated_at
       WHERE gaps.prev_appointment_id IS NOT excluded.prev_appointment_id
          OR gaps.next_appointment_id IS NOT excluded.next_appointment_id
          OR gaps.baseline_drive_seconds IS NOT excluded.baseline_drive_seconds
          OR gaps.prev_lat IS NOT excluded.prev_lat
          OR gaps.next_lat IS NOT excluded.next_lat`,
    ).bind(
      newId(), op.id, g.start, g.end,
      a.prev?.id ?? null, a.next?.id ?? null,
      a.pPoint?.lat ?? null, a.pPoint?.lng ?? null,
      a.nPoint?.lat ?? null, a.nPoint?.lng ?? null,
      baselineByGap.get(i) ?? null,
      isMobileOperator ? 1 : 0, g.locationId, t, t,
    ));
  }
  if (writes.length) await env.DB.batch(writes);

  // Expire open gaps in range that no longer correspond to free time.
  // 'offering' rows are deliberately spared — a live offer still needs its gap.
  const keep = new Set(found.map((g) => `${g.start}:${g.end}`));
  const stale = await env.DB.prepare(
    `SELECT id, starts_at, ends_at FROM gaps
      WHERE operator_id = ? AND status = 'open' AND starts_at >= ? AND starts_at < ?`,
  ).bind(op.id, rangeStart, rangeEnd).all<{ id: string; starts_at: number; ends_at: number }>();

  const expiring = (stale.results ?? []).filter((r) => !keep.has(`${r.starts_at}:${r.ends_at}`));
  if (expiring.length) {
    await env.DB.batch(expiring.map((r) =>
      env.DB.prepare(`UPDATE gaps SET status='expired', updated_at=? WHERE id=? AND status='open'`)
        .bind(t, r.id)));
  }

  return {
    created: writes.length,
    expired: expiring.length,
    gaps: found.map((g) => ({ start: g.start, end: g.end })),
  };
}
