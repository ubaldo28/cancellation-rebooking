import { DurableObject } from 'cloudflare:workers';

import type { Env } from '../types';
import {
  MAX_TRAIL_POINTS, MIN_PING_SECONDS, STALE_AFTER_SECONDS, TRAIL_EVERY_SECONDS,
} from '../lib/track';
import type { PingSkip, PositionPing, TrailPoint, VanPosition } from '../lib/track';
import { now } from '../lib/util';

/**
 * One van, in memory.
 *
 * WHY THIS EXISTS. Position pings were the highest-write path in the product
 * by a wide margin, and the only one that writes on a timer rather than when a
 * person does something. A van pinging every 30 seconds is ~2,880 writes a day;
 * ten thousand vans is roughly 150 million database writes a month, for a value
 * that is overwritten before anybody reads the previous one. That was the
 * largest single cost in the system, and it was being paid to store a number
 * that is stale in half a minute.
 *
 * So the live position no longer goes in the database. It lives here, as an
 * ordinary field on an object that Cloudflare keeps in memory, keyed by the
 * operator: one Durable Object per van, and a ping overwrites a field instead
 * of writing a row. This is the same shape every live-vehicle system converges
 * on -- the current position is mutable state read far more often than it needs
 * to be durable -- and it takes the whole timer-driven write load off D1.
 *
 *   MEMORY IS THE HOT PATH. ping() assigns two fields and returns. In the
 *   normal case it performs no I/O at all, durable or otherwise.
 *
 *   STORAGE IS A CUSHION, NOT A RECORD. A Durable Object can be evicted from
 *   memory at any moment -- ordinary hibernation, a deploy, a machine going
 *   away -- and a customer watching the van approach should not see it vanish
 *   because of that. So we keep a snapshot, written at most once every
 *   PERSIST_EVERY_SECONDS, plus a final flush on an alarm after the van goes
 *   quiet. Losing up to five minutes of it costs one stale-looking dot until
 *   the next ping, which is a fair trade for writing ~1/300th as often.
 *   Nothing here is history: the snapshot is one position and a short trail,
 *   overwritten in place, exactly as van_positions was.
 *
 * The drop rules are unchanged from the D1 implementation, because they were
 * never really about write cost -- they are about what is true. See the
 * comments on each one below, and on MIN_PING_SECONDS in ../lib/track.
 *
 * The customer-facing gates -- consent, time window, rounding -- are NOT here.
 * They live in customerView() in ../lib/track, which is the only thing a
 * customer link can reach. This object holds the raw fix and answers the
 * Worker; it is not addressable from outside.
 */

/**
 * How often the in-memory state is copied to durable storage.
 *
 * Five minutes. This is the entire durable write cost of tracking: one small
 * put per active van per five minutes, instead of one row per ping. It is set
 * by what an eviction may cost us, not by what is accurate -- a snapshot five
 * minutes behind the phone is still well inside STALE_AFTER_SECONDS, so a van
 * that comes back from an eviction reads as a slightly old position rather
 * than as no van at all, and the next ping corrects it.
 */
const PERSIST_EVERY_SECONDS = 300;

/**
 * When the alarm fires to write the last state after the van stops pinging.
 *
 * A minute past the next snapshot's due time. If pings are still arriving the
 * alarm finds unsaved state, flushes it and re-arms -- which is how an active
 * van gets its five-minute snapshot without ping() ever having to touch the
 * alarm. If the van has gone quiet the alarm finds nothing to write and stops
 * re-arming, so an idle object costs nothing at all.
 *
 * Setting an alarm is itself a storage write, which is why it is only ever
 * done as part of a flush we had already decided to perform.
 */
const QUIET_FLUSH_SECONDS = PERSIST_EVERY_SECONDS + 60;

/**
 * A phone whose clock is ahead cannot lock its own van out.
 *
 * recorded_at comes from the handset, and handset clocks are wrong. Without
 * this, one fix stamped a day into the future would be the position we hold,
 * and every real ping afterwards would look out of order -- the van would
 * freeze until the object was evicted. Anything more than a minute ahead is
 * treated as "now", which is the only honest reading of it.
 */
const MAX_CLOCK_SKEW_SECONDS = 60;

/** The single storage key. One snapshot, overwritten -- never a log. */
const SNAPSHOT_KEY = 'snapshot';

/**
 * The position without the operator id.
 *
 * The object IS the operator -- it is addressed by idFromName(operator_id) --
 * so carrying the id inside the value would be storing the key in the row.
 * operatorPosition() puts it back on the way out, where callers expect it.
 */
export type VanFix = Omit<VanPosition, 'operator_id'>;

/** What read() answers. `stale` is the difference between "too old" and "never". */
export interface VanRead {
  position: VanFix | null;
  trail: TrailPoint[];
  /**
   * True when a fix is held but is older than STALE_AFTER_SECONDS. position is
   * null either way -- an old position is worse than none, because it says
   * "two streets away" about a van that has driven home. The flag exists only
   * so customerView() can say `stale` rather than `no_position`, which are
   * different sentences to a customer standing at a window.
   */
  stale: boolean;
}

/** Exactly what is persisted: the current state, nothing accumulated. */
interface VanSnapshot {
  position: VanFix | null;
  trail: TrailPoint[];
}

/** Optional sensor readings: keep a real number, drop anything else. */
const optionalNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

export class VanTracker extends DurableObject<Env> {
  /** The live position. This field is the product. */
  private position: VanFix | null = null;

  /** Oldest first, so it draws straight into a polyline. Capped at MAX_TRAIL_POINTS. */
  private trail: TrailPoint[] = [];

  /** Unix seconds of the last snapshot. 0 means "not since this object woke". */
  private flushedAt = 0;

  /** Set by a ping that changed something, cleared by a flush. */
  private dirty = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Restore before anything can call in. blockConcurrencyWhile is what makes
    // the fields safe to read synchronously everywhere else in this class: no
    // request is delivered until this has finished.
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<VanSnapshot>(SNAPSHOT_KEY);
      if (saved) {
        this.position = saved.position ?? null;
        this.trail = saved.trail ?? [];
      }
      // flushedAt stays 0 on purpose: the first ping after waking writes a
      // snapshot and arms the alarm, so a freshly restored object is never
      // left holding state with no alarm to flush it.
    });
  }

  /**
   * One fix off a phone. The hot path, and it does no durable I/O.
   *
   * Three pings are refused, and none of them is an error -- a dropped ping is
   * the normal outcome of a phone doing its job:
   *
   *   out_of_order -- older than the fix we hold. Phones deliver fixes out of
   *     order routinely (a queued fix from a dead spot arrives after a fresh
   *     one), and taking it would drag the van backwards on the customer's
   *     screen to a place it has already left.
   *
   *   too_frequent -- inside MIN_PING_SECONDS of the fix we hold. A van cannot
   *     travel far enough in that time to change any answer this feature
   *     gives. Writes are no longer the reason to drop these, but the fix is
   *     still noise, and the floor stops a buggy client turning one van into
   *     thousands of RPC calls a minute.
   *
   *   a clock in the future -- stamped with now instead of refused, see
   *     MAX_CLOCK_SKEW_SECONDS.
   */
  async ping(p: PositionPing): Promise<{ stored: boolean; reason?: PingSkip }> {
    const t = now();
    const claimed = optionalNumber(p?.recorded_at) ?? t;
    const recordedAt = claimed > t + MAX_CLOCK_SKEW_SECONDS ? t : Math.floor(claimed);

    const held = this.position;
    if (held) {
      if (recordedAt <= held.recorded_at) return { stored: false, reason: 'out_of_order' };
      if (recordedAt - held.recorded_at < MIN_PING_SECONDS) {
        return { stored: false, reason: 'too_frequent' };
      }
    }

    this.position = {
      lat: p.lat,
      lng: p.lng,
      accuracy_meters: optionalNumber(p.accuracy_meters),
      heading: optionalNumber(p.heading),
      speed_mps: optionalNumber(p.speed_mps),
      recorded_at: recordedAt,
      // When we took it, not when the phone did. The two differ by however
      // long the van spent in a dead spot, and that difference is exactly what
      // the staleness gate measures.
      updated_at: t,
    };

    // The trail is a display detail: a single pin cannot tell a parked van
    // from one doing 50 along the ring road. Sampled at TRAIL_EVERY_SECONDS
    // rather than kept per ping so it spans a leg of the journey rather than
    // the last few minutes, and capped so it can never become a history of a
    // named person's movements.
    const last = this.trail[this.trail.length - 1];
    if (!last || recordedAt - last.recorded_at >= TRAIL_EVERY_SECONDS) {
      this.trail.push({ lat: p.lat, lng: p.lng, recorded_at: recordedAt });
      if (this.trail.length > MAX_TRAIL_POINTS) {
        this.trail.splice(0, this.trail.length - MAX_TRAIL_POINTS);
      }
    }

    this.dirty = true;

    // The only durable write in this method, and only once every five minutes.
    if (t - this.flushedAt >= PERSIST_EVERY_SECONDS) await this.flush(t);

    return { stored: true };
  }

  /**
   * The current position and trail, or nothing.
   *
   * A fix older than STALE_AFTER_SECONDS reads as absent rather than as an old
   * position: ten minutes is chosen to survive an ordinary dead spot -- a
   * tunnel, an underground car park, a basement job -- and past it the honest
   * answer is that we do not know where the van is. The trail goes with it,
   * because a trail with no van on the end of it is a line to nowhere.
   *
   * This is also why nothing needs a "stop sharing" button that somebody must
   * remember to press: the view goes dark on its own ten minutes after the
   * phone stops pinging.
   */
  async read(): Promise<VanRead> {
    const p = this.position;
    if (!p) return { position: null, trail: [], stale: false };
    if (now() - p.recorded_at > STALE_AFTER_SECONDS) {
      return { position: null, trail: [], stale: true };
    }
    return { position: { ...p }, trail: this.trail.slice(), stale: false };
  }

  /** Forget this van entirely -- memory, snapshot and alarm. */
  async clear(): Promise<void> {
    this.position = null;
    this.trail = [];
    this.dirty = false;
    this.flushedAt = 0;
    await this.ctx.storage.delete(SNAPSHOT_KEY);
    await this.ctx.storage.deleteAlarm();
  }

  /**
   * The final flush after the van goes quiet.
   *
   * If there is unsaved state the van was still moving recently: write it and
   * arm the next alarm. If there is not, the van has stopped and this object
   * stops costing anything -- no re-arm, no further writes, and eviction is
   * then free because the snapshot is already current.
   */
  override async alarm(): Promise<void> {
    if (this.dirty) await this.flush(now());
  }

  /** One put and one alarm, together, because both are storage writes. */
  private async flush(t: number): Promise<void> {
    const snapshot: VanSnapshot = { position: this.position, trail: this.trail };
    await this.ctx.storage.put(SNAPSHOT_KEY, snapshot);
    this.flushedAt = t;
    this.dirty = false;
    await this.ctx.storage.setAlarm(Date.now() + QUIET_FLUSH_SECONDS * 1000);
  }
}
