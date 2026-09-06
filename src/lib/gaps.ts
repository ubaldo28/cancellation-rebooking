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

  const found: Array<Interval & {
    locationId: string | null; wholeDay: boolean;
    /** The free window before the notice clamp below moved its start. */
    windowStart: number;
  }> = [];

  for (let d = 0; d < days; d++) {
    const dayStart = addLocalDays(rangeStart, tz, d);
    const local = toLocal(dayStart, tz);
    for (const h of hours) {
      if (h.weekday !== local.weekday) continue;
      const winStart = fromLocal(tz, local.year, local.month, local.day, h.start_minute);
      const winEnd = fromLocal(tz, local.year, local.month, local.day, h.end_minute);
      const free = subtract({ start: winStart, end: winEnd }, busy);
      // Nothing was subtracted, so nothing is booked in this window. That is an
      // empty day, not a hole to fill, and the app has to say so differently.
      const wholeDay = free.length === 1
        && free[0]!.start <= winStart && free[0]!.end >= winEnd;
      for (const f of free) {
        const start = Math.max(f.start, earliest);
        if (f.end - start >= op.min_gap_seconds) {
          found.push({
            start, end: f.end, locationId: h.location_id, wholeDay, windowStart: f.start,
          });
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

  /**
   * The rows this operator already has for these days, read before anything is
   * written, so a free window that has only moved its start can be recognised
   * as the SAME opening rather than replaced by a new one.
   *
   * WHY THIS EXISTS. A detected gap's start is clamped to `earliest` above,
   * and `earliest` is now + the notice period -- it moves forward on every
   * single run. So for any window whose natural start has already passed, the
   * (starts_at, ends_at) key the INSERT conflicts on was different every time,
   * and a quarter-hourly cron therefore minted a brand new gap row every
   * quarter hour and expired the one before it. That is not a tidy-up cost:
   *
   *   - the gaps table grew by ~96 rows per operator per open window per day,
   *     with nothing that ever deletes them;
   *   - watch_hits de-duplicates alerts on (watch_id, gap_id), so the same
   *     customer was told about the same opening again on the next tick, as
   *     though it were a new one, until their daily cap ran out;
   *   - and every link already sent -- /book/<gap_id> in an alert email, an
   *     invited offer's page -- pointed at a row that was 'expired' fifteen
   *     minutes later, so the opening read as gone while it was still free.
   *
   * A free window is identified by where it ENDS and which location it is at.
   * Its end is a boundary of the calendar -- the next job's start, or the end
   * of working hours -- so it does not drift the way the clamped start does,
   * and two free windows inside one day cannot share one. Only 'open' rows are
   * adopted: an 'offering' gap has live offers quoting its start time, and
   * moving that under them would change what somebody was invited to.
   */
  const existing = await env.DB.prepare(
    `SELECT id, starts_at, ends_at, location_id FROM gaps
      WHERE operator_id = ? AND status = 'open' AND source = 'detected'
        AND starts_at >= ? AND starts_at < ?`,
  ).bind(op.id, rangeStart, rangeEnd)
    .all<{ id: string; starts_at: number; ends_at: number; location_id: string | null }>();

  /** Rows adopted by the loop below, which the expiry pass must therefore keep. */
  const keptIds = new Set<string>();

  const byWindow = new Map<string, { id: string; starts_at: number }>();
  for (const r of existing.results ?? []) {
    byWindow.set(`${r.ends_at}:${r.location_id ?? ''}`, { id: r.id, starts_at: r.starts_at });
  }

  const writes: D1PreparedStatement[] = [];
  for (let i = 0; i < found.length; i++) {
    const g = found[i]!;
    const a = anchors[i]!;

    // The same window, still open, whose start has only been walked forward by
    // the notice clamp. Slide the row rather than replacing it, so its id --
    // which is in links and in watch_hits -- survives.
    const held = byWindow.get(`${g.end}:${g.locationId ?? ''}`);
    if (held && held.starts_at >= g.windowStart && held.starts_at <= g.start) {
      byWindow.delete(`${g.end}:${g.locationId ?? ''}`);
      keptIds.add(held.id);
      writes.push(env.DB.prepare(
        `UPDATE gaps SET starts_at = ?,
           prev_appointment_id = ?, next_appointment_id = ?,
           prev_lat = ?, prev_lng = ?, next_lat = ?, next_lng = ?,
           baseline_drive_seconds = ?, fills_whole_day = ?, updated_at = ?
          WHERE id = ? AND status = 'open' AND source = 'detected'`,
      ).bind(
        g.start,
        a.prev?.id ?? null, a.next?.id ?? null,
        a.pPoint?.lat ?? null, a.pPoint?.lng ?? null,
        a.nPoint?.lat ?? null, a.nPoint?.lng ?? null,
        baselineByGap.get(i) ?? null, g.wholeDay ? 1 : 0, t, held.id,
      ));
      continue;
    }

    writes.push(env.DB.prepare(
      `INSERT INTO gaps
         (id, operator_id, starts_at, ends_at, prev_appointment_id, next_appointment_id,
          prev_lat, prev_lng, next_lat, next_lng, baseline_drive_seconds,
          is_mobile, location_id, fills_whole_day, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?)
       ON CONFLICT (operator_id, starts_at, ends_at) WHERE status IN ('open','offering')
       DO UPDATE SET
         prev_appointment_id = excluded.prev_appointment_id,
         next_appointment_id = excluded.next_appointment_id,
         prev_lat = excluded.prev_lat, prev_lng = excluded.prev_lng,
         next_lat = excluded.next_lat, next_lng = excluded.next_lng,
         baseline_drive_seconds = excluded.baseline_drive_seconds,
         fills_whole_day = excluded.fills_whole_day,
         updated_at = excluded.updated_at
       -- Same reason the expiry below skips posted rows: an operator's typed
       -- opening is not this function's to rewrite. Where a posted row already
       -- holds the window, the conflict is left alone rather than being
       -- restamped with detected anchors.
       WHERE gaps.source = 'detected'
         AND (gaps.prev_appointment_id IS NOT excluded.prev_appointment_id
           OR gaps.next_appointment_id IS NOT excluded.next_appointment_id
           OR gaps.baseline_drive_seconds IS NOT excluded.baseline_drive_seconds
           OR gaps.prev_lat IS NOT excluded.prev_lat
           OR gaps.next_lat IS NOT excluded.next_lat
           OR gaps.fills_whole_day IS NOT excluded.fills_whole_day)`,
    ).bind(
      newId(), op.id, g.start, g.end,
      a.prev?.id ?? null, a.next?.id ?? null,
      a.pPoint?.lat ?? null, a.pPoint?.lng ?? null,
      a.nPoint?.lat ?? null, a.nPoint?.lng ?? null,
      baselineByGap.get(i) ?? null,
      isMobileOperator ? 1 : 0, g.locationId, g.wholeDay ? 1 : 0, t, t,
    ));
  }
  if (writes.length) await env.DB.batch(writes);

  // Expire open gaps in range that no longer correspond to free time.
  // 'offering' rows are deliberately spared — a live offer still needs its gap.
  //
  // Posted gaps are spared too, and for a different reason. A detected gap is
  // derived state: this function computes it from the calendar, so this
  // function is entitled to withdraw it. A posted gap was typed by the
  // operator and is not derived from anything — there is no calendar hole for
  // it to stop matching — so every run would find it unaccounted for and
  // expire it. An operator who put up their one free Thursday would watch it
  // vanish the next time detection ran, which is the entire feature.
  const keep = new Set(found.map((g) => `${g.start}:${g.end}`));
  const stale = await env.DB.prepare(
    `SELECT id, starts_at, ends_at FROM gaps
      WHERE operator_id = ? AND status = 'open' AND source = 'detected'
        AND starts_at >= ? AND starts_at < ?`,
  ).bind(op.id, rangeStart, rangeEnd).all<{ id: string; starts_at: number; ends_at: number }>();

  // Matched by id as well as by window. A row that was slid forward above is
  // still the window it always was, and reading it back by its new coordinates
  // would work -- but only as long as the slide landed, and a row that is kept
  // deliberately must not depend on a second query agreeing about it.
  const expiring = (stale.results ?? []).filter(
    (r) => !keptIds.has(r.id) && !keep.has(`${r.starts_at}:${r.ends_at}`));
  if (expiring.length) {
    await env.DB.batch(expiring.map((r) =>
      env.DB.prepare(
        `UPDATE gaps SET status='expired', updated_at=?
          WHERE id=? AND status='open' AND source='detected'`)
        .bind(t, r.id)));
  }

  return {
    created: writes.length,
    expired: expiring.length,
    gaps: found.map((g) => ({ start: g.start, end: g.end })),
  };
}
