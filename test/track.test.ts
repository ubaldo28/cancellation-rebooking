import { describe, expect, it, beforeEach, vi } from 'vitest';

/**
 * cloudflare:workers only exists inside the Workers runtime; node cannot
 * resolve it. The real DurableObject base class does exactly one thing this
 * suite can observe -- it hands the object its ctx and its env -- so that is
 * what stands in for it. vi.mock is hoisted above the imports below, so
 * src/do/van.ts picks this up the moment it is first evaluated.
 */
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(public ctx: any, public env: any) {}
  },
}));

import { ALL_MIGRATIONS, makeEnv } from './d1';
import type { Env } from '../src/types';
import { startThread } from '../src/lib/chat';
import { VanTracker } from '../src/do/van';
import {
  customerView, operatorPosition, recordPosition, setShareLocation,
  MAX_TRAIL_POINTS, MIN_PING_SECONDS, STALE_AFTER_SECONDS, TRAIL_EVERY_SECONDS,
  WINDOW_AFTER_SECONDS, WINDOW_BEFORE_SECONDS,
} from '../src/lib/track';
import type { PositionPing } from '../src/lib/track';
import { newId, now } from '../src/lib/util';

const MIGRATIONS = ALL_MIGRATIONS;

// ---------------------------------------------------------------------------
// A Durable Object namespace, in a Map.
// ---------------------------------------------------------------------------
//
// Positions no longer touch D1, so there is no table left to assert against.
// What replaces it is this: the real VanTracker class, running in-process,
// behind the same two calls the Worker makes -- idFromName(operator_id) and
// get(id). Every behaviour below is therefore the real object's behaviour,
// not a description of it.

/** The object's own storage. One key, overwritten -- exactly as in production. */
class FakeStorage {
  readonly kv = new Map<string, unknown>();
  alarm: number | null = null;
  /** Counts durable writes, which is the number this whole change is about. */
  writes = 0;

  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.kv.get(key)) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.writes++;
    this.kv.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<boolean> { return this.kv.delete(key); }
  async setAlarm(scheduledTime: number): Promise<void> {
    this.writes++;
    this.alarm = scheduledTime;
  }
  async getAlarm(): Promise<number | null> { return this.alarm; }
  async deleteAlarm(): Promise<void> { this.alarm = null; }
}

class FakeState {
  /** Resolves once the constructor's restore has finished. */
  ready: Promise<unknown> = Promise.resolve();
  constructor(readonly id: { name: string }, readonly storage: FakeStorage) {}
  blockConcurrencyWhile<T>(cb: () => Promise<T>): Promise<T> {
    const p = cb();
    this.ready = p;
    return p;
  }
}

class FakeVanNamespace {
  /** Survives eviction, like the real thing. */
  private readonly storages = new Map<string, FakeStorage>();
  /** The objects currently in memory. */
  private readonly live = new Map<string, { ctx: FakeState; van: VanTracker }>();

  idFromName(name: string) { return { name }; }

  get(id: { name: string }) {
    const o = this.instance(id.name);
    // Awaiting ctx.ready before every call is what blockConcurrencyWhile does
    // for real: no request is delivered until the restore has finished.
    return {
      ping: async (p: PositionPing) => { await o.ctx.ready; return o.van.ping(p); },
      read: async () => { await o.ctx.ready; return o.van.read(); },
      clear: async () => { await o.ctx.ready; return o.van.clear(); },
      alarm: async () => { await o.ctx.ready; return o.van.alarm(); },
    };
  }

  private instance(name: string) {
    let o = this.live.get(name);
    if (!o) {
      let storage = this.storages.get(name);
      if (!storage) {
        storage = new FakeStorage();
        this.storages.set(name, storage);
      }
      const ctx = new FakeState({ name }, storage);
      o = { ctx, van: new VanTracker(ctx as any, {} as any) };
      this.live.set(name, o);
    }
    return o;
  }

  /** How many objects exist: one per operator, never one per ping. */
  get size() { return this.live.size; }

  /** Durable writes one van has made. */
  writes(name: string) { return this.storages.get(name)?.writes ?? 0; }

  /** Evicted from memory. The snapshot in its storage stays. */
  evict(name: string) { this.live.delete(name); }
}

/** The stub the Worker would get, for the two tests that drive it directly. */
const vanStub = (operatorId: string) => vans.get({ name: operatorId });

let env: Env;
let vans: FakeVanNamespace;

// Two businesses. The second exists so the tenant boundary has something to be
// tested against -- a customer of one must never see the other one's van.
const OP = 'op1';
const OTHER = 'op2';

// Sherman Oaks. The van is a few blocks from the job.
const VAN = { lat: 34.1500, lng: -118.4490 };
const JOB = { lat: 34.1520, lng: -118.4400 };
// Where the other business's van is, so a leak would be obvious.
const OTHER_VAN = { lat: 34.1680, lng: -118.6050 };

/**
 * A fixed-offset zone in which it is currently about midday.
 *
 * The window tests move an appointment an hour or two either side of now, and
 * customerView() also requires the appointment to be TODAY in the operator's
 * local time. Pinned to a real zone, those two rules collide for the couple of
 * hours around local midnight and the suite fails depending on what time of
 * day it is run. Anchoring the operator at midday makes every relative offset
 * in this file land on the same local day, whenever the tests run, and a
 * fixed-offset zone has no DST boundary to fall over either.
 */
function middayTimezone(): string {
  const offsetHours = 12 - new Date().getUTCHours();   // local hours ahead of UTC
  if (offsetHours === 0) return 'UTC';
  // POSIX sign convention: Etc/GMT-3 is UTC+3.
  return offsetHours > 0 ? `Etc/GMT-${offsetHours}` : `Etc/GMT+${-offsetHours}`;
}

async function insertOperator(id: string, email: string, name: string) {
  const n = now();
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,timezone,country,currency,language,
       location_mode,fill_model,sms_mode,max_detour_seconds,min_gap_seconds,buffer_seconds,
       offer_ttl_seconds,offers_per_wave,min_notice_seconds,reoffer_cooldown_seconds,
       discount_percent,plan,accept_public_bookings,deposit_cents,created_at,updated_at)
     VALUES (?,?,?,?,'US','USD','en','mobile','both','device',
       900,3600,900,5400,3,3600,604800,0,'active',1,1000,?,?)`,
  ).bind(id, email, name, middayTimezone(), n, n).run();
}

/**
 * An appointment at the job address, plus a chat thread linked to it -- which
 * is the only thing a customer holds. Times are relative to now so the window
 * can be moved around it.
 */
async function bookedThread(opts: {
  operator?: string; startsIn?: number; durationSeconds?: number;
  lat?: number | null; lng?: number | null; status?: string;
} = {}) {
  const operatorId = opts.operator ?? OP;
  const t = now();
  const startsAt = t + (opts.startsIn ?? 1800);
  const endsAt = startsAt + (opts.durationSeconds ?? 3600);
  const apptId = newId();

  await env.DB.prepare(
    `INSERT INTO appointments (id, operator_id, starts_at, ends_at, is_mobile,
       address_line, postcode, lat, lng, status, source, created_at, updated_at)
     VALUES (?,?,?,?,1,'12 Elm St','91403',?,?,?, 'online', ?,?)`,
  ).bind(apptId, operatorId, startsAt, endsAt,
    opts.lat === undefined ? JOB.lat : opts.lat,
    opts.lng === undefined ? JOB.lng : opts.lng,
    opts.status ?? 'scheduled', t, t).run();

  const { token } = await startThread(env, {
    operator_id: operatorId,
    appointment_id: apptId,
    guest_name: 'Rosa',
  });

  return { token, appointmentId: apptId, startsAt, endsAt };
}

beforeEach(async () => {
  vans = new FakeVanNamespace();
  env = { ...makeEnv(MIGRATIONS), VAN: vans } as unknown as Env;
  await insertOperator(OP, 'a@x.com', 'Valley Detailing');
  await insertOperator(OTHER, 'b@x.com', 'Canyon Detailing');
});

describe('a van reporting where it is', () => {
  it('stores a position and reads it back with its trail', async () => {
    const t = now();
    const res = await recordPosition(env, OP, {
      ...VAN, accuracy_meters: 12, heading: 88, speed_mps: 9.4, recorded_at: t,
    });
    expect(res.stored).toBe(true);

    const { position, trail } = await operatorPosition(env, OP);
    expect(position).not.toBeNull();
    expect(position!.operator_id).toBe(OP);
    expect(position!.lat).toBeCloseTo(VAN.lat, 6);
    expect(position!.lng).toBeCloseTo(VAN.lng, 6);
    expect(position!.accuracy_meters).toBe(12);
    expect(position!.heading).toBe(88);
    expect(position!.speed_mps).toBeCloseTo(9.4, 6);
    expect(position!.recorded_at).toBe(t);

    expect(trail).toHaveLength(1);
    expect(trail[0]!.lat).toBeCloseTo(VAN.lat, 6);
  });

  it('overwrites the position rather than collecting one per ping', async () => {
    const t = now();
    await recordPosition(env, OP, { ...VAN, recorded_at: t - TRAIL_EVERY_SECONDS });
    await recordPosition(env, OP, { lat: 34.1550, lng: -118.4450, recorded_at: t });

    // THE point of the design: one object per operator, holding one position.
    // Nothing accumulates as the pings arrive.
    expect(vans.size).toBe(1);

    const { position, trail } = await operatorPosition(env, OP);
    expect(position!.lat).toBeCloseTo(34.1550, 6);
    expect(position!.recorded_at).toBe(t);
    // The trail is the part that accumulates -- that is what draws movement.
    expect(trail).toHaveLength(2);
    expect(trail[0]!.lat).toBeCloseTo(VAN.lat, 6);        // oldest first
    expect(trail[1]!.lat).toBeCloseTo(34.1550, 6);
  });

  it('writes nothing durable on a ping', async () => {
    // The whole reason this moved out of D1. The first ping snapshots the van
    // and arms the alarm; the next two hours of pings cost nothing at all.
    const t = now() - 40 * TRAIL_EVERY_SECONDS;
    for (let i = 0; i < 40; i++) {
      await recordPosition(env, OP, {
        lat: 34.15 + i * 0.0005, lng: -118.449, recorded_at: t + i * TRAIL_EVERY_SECONDS,
      });
    }
    // One put and one setAlarm, both from the first ping. Forty pings, two writes.
    expect(vans.writes(OP)).toBe(2);
    expect((await operatorPosition(env, OP)).position!.lat)
      .toBeCloseTo(34.15 + 39 * 0.0005, 6);
  });

  it('keeps the van across an eviction, which is what the snapshot is for', async () => {
    await recordPosition(env, OP, { ...VAN, recorded_at: now() - 30 });

    // A deploy, a hibernation, a machine going away. The object is gone; its
    // storage is not. A customer watching the van approach should not see it
    // vanish because Cloudflare moved it.
    vans.evict(OP);

    const { position, trail } = await operatorPosition(env, OP);
    expect(position!.lat).toBeCloseTo(VAN.lat, 6);
    expect(trail).toHaveLength(1);
  });

  it('ignores a fix older than the one it already holds', async () => {
    const t = now();
    await recordPosition(env, OP, { ...VAN, recorded_at: t });

    // A queued fix from a dead spot, arriving late. Taking it would drag the
    // van backwards on the customer's screen.
    const late = await recordPosition(env, OP, {
      lat: 34.1000, lng: -118.5000, recorded_at: t - 300,
    });
    expect(late.stored).toBe(false);
    expect(late.reason).toBe('out_of_order');

    const { position, trail } = await operatorPosition(env, OP);
    expect(position!.lat).toBeCloseTo(VAN.lat, 6);
    expect(position!.recorded_at).toBe(t);
    expect(trail).toHaveLength(1);          // nothing changed at all
  });

  it('drops a ping that arrives inside the minimum interval', async () => {
    const t = now() - TRAIL_EVERY_SECONDS;
    await recordPosition(env, OP, { ...VAN, recorded_at: t });

    const tooSoon = await recordPosition(env, OP, {
      lat: 34.1501, lng: -118.4491, recorded_at: t + MIN_PING_SECONDS - 1,
    });
    expect(tooSoon.stored).toBe(false);
    expect(tooSoon.reason).toBe('too_frequent');
    expect((await operatorPosition(env, OP)).position!.lat).toBeCloseTo(VAN.lat, 6);

    // And exactly at the interval it is taken.
    const onTime = await recordPosition(env, OP, {
      lat: 34.1502, lng: -118.4492, recorded_at: t + MIN_PING_SECONDS,
    });
    expect(onTime.stored).toBe(true);
    expect((await operatorPosition(env, OP)).position!.lat).toBeCloseTo(34.1502, 6);
  });

  it('trims the trail to its bound so it can never become a history', async () => {
    const points = MAX_TRAIL_POINTS + 20;
    const t = now() - points * TRAIL_EVERY_SECONDS;
    for (let i = 0; i < points; i++) {
      await recordPosition(env, OP, {
        lat: 34.15 + i * 0.0005, lng: -118.449, recorded_at: t + i * TRAIL_EVERY_SECONDS,
      });
    }

    // The points that survived are the most recent ones, oldest first.
    const { trail } = await operatorPosition(env, OP);
    expect(trail).toHaveLength(MAX_TRAIL_POINTS);
    expect(trail[0]!.lat).toBeCloseTo(34.15 + 20 * 0.0005, 6);
    expect(trail[trail.length - 1]!.lat).toBeCloseTo(34.15 + (points - 1) * 0.0005, 6);
  });

  it('refuses a coordinate that cannot exist', async () => {
    await expect(recordPosition(env, OP, { lat: 91, lng: 0 }))
      .rejects.toThrow(/not a position on earth/i);
    await expect(recordPosition(env, OP, { lat: 0, lng: 200 }))
      .rejects.toThrow(/not a position on earth/i);
    await expect(recordPosition(env, OP, { lat: Number.NaN, lng: 0 }))
      .rejects.toThrow(/not a position on earth/i);
    await expect(recordPosition(env, OP, { lat: 'here' as unknown as number, lng: 0 }))
      .rejects.toThrow(/not a position on earth/i);

    expect((await operatorPosition(env, OP)).position).toBeNull();
  });

  it('does not let a phone with a fast clock lock its own van out', async () => {
    // A fix stamped a day into the future. If it were held as-is, every real
    // ping afterwards would look out of order and the van would freeze.
    await recordPosition(env, OP, { ...VAN, recorded_at: now() + 86400 });
    const next = await recordPosition(env, OP, {
      lat: 34.1550, lng: -118.4450, recorded_at: now() + 60,
    });
    expect(next.stored).toBe(true);
  });

  it('reads a stale fix as no van at all', async () => {
    await recordPosition(env, OP, {
      ...VAN, recorded_at: now() - STALE_AFTER_SECONDS - 60,
    });

    // An old position is worse than none: it says "two streets away" about a
    // van that finished the job and drove home.
    const { position, trail } = await operatorPosition(env, OP);
    expect(position).toBeNull();
    expect(trail).toHaveLength(0);
  });

  it('keeps one business van out of another business dashboard', async () => {
    await recordPosition(env, OP, VAN);
    expect((await operatorPosition(env, OTHER)).position).toBeNull();
    expect((await operatorPosition(env, OTHER)).trail).toHaveLength(0);
  });

  it('no longer has a positions table behind it', async () => {
    // Migration 0015. A table nothing maintains but anything can still read is
    // a trap: the next person to find van_positions would reasonably believe
    // the row in it is where the van is.
    expect(() => env.DB.prepare(`SELECT 1 FROM van_positions`).all())
      .toThrow(/no such table/i);
    expect(() => env.DB.prepare(`SELECT 1 FROM van_trail`).all())
      .toThrow(/no such table/i);
  });
});

describe('what a customer with a booking is allowed to see', () => {
  it('shows nothing until the operator has turned sharing on', async () => {
    const { token } = await bookedThread();
    await recordPosition(env, OP, VAN);

    // share_location defaults to 0 in migration 0014, and that is the point.
    const off = await customerView(env, token);
    expect(off.visible).toBe(false);
    expect(off).toMatchObject({ reason: 'not_sharing' });

    await setShareLocation(env, OP, true);
    expect((await customerView(env, token)).visible).toBe(true);

    // And switching it back off closes the window immediately: consent is read
    // from D1 on every view, and never from the object holding the position.
    await setShareLocation(env, OP, false);
    expect(await customerView(env, token)).toMatchObject({
      visible: false, reason: 'not_sharing',
    });
  });

  it('shows the van inside the window, with an ETA, a distance and the destination', async () => {
    const { token } = await bookedThread({ startsIn: 1800 });
    await setShareLocation(env, OP, true);
    await recordPosition(env, OP, VAN);

    const view = await customerView(env, token);
    expect(view.visible).toBe(true);
    if (!view.visible) throw new Error('unreachable');

    expect(view.eta_seconds).toBeGreaterThan(0);
    expect(view.distance_meters).toBeGreaterThan(0);
    // Under a kilometre: the van is a few blocks away.
    expect(view.distance_meters).toBeLessThan(2000);
    expect(view.distance_meters % 100).toBe(0);
    expect(view.recorded_at).toBeGreaterThan(now() - 10);

    // Their own address, so the dot has something to be near.
    expect(view.dest_lat).toBeCloseTo(JOB.lat, 6);
    expect(view.dest_lng).toBeCloseTo(JOB.lng, 6);
  });

  it('rounds the coordinate it hands over to about a hundred metres', async () => {
    const { token } = await bookedThread();
    await setShareLocation(env, OP, true);
    await recordPosition(env, OP, { lat: 34.1512345, lng: -118.4498765 });

    const view = await customerView(env, token);
    if (!view.visible) throw new Error('the van should be visible here');

    // Three decimals: enough to say "nearly here", not enough to say which house.
    expect(view.lat).toBe(34.151);
    expect(view.lng).toBe(-118.45);
    expect(String(view.lat).split('.')[1]!.length).toBeLessThanOrEqual(3);
    expect(String(view.lng).split('.')[1]!.length).toBeLessThanOrEqual(3);

    // The unrounded fix is still what the operator sees on their own dashboard.
    expect((await operatorPosition(env, OP)).position!.lat).toBeCloseTo(34.1512345, 7);
  });

  it('shows nothing before the window opens or after it closes', async () => {
    await setShareLocation(env, OP, true);
    await recordPosition(env, OP, VAN);

    // Starts in two hours: outside the 90 minutes before.
    const early = await bookedThread({ startsIn: WINDOW_BEFORE_SECONDS + 600 });
    expect(await customerView(env, early.token)).toMatchObject({
      visible: false, reason: 'outside_window',
    });

    // Ended over half an hour ago.
    const over = await bookedThread({
      startsIn: -(WINDOW_AFTER_SECONDS + 3600 + 600), durationSeconds: 3600,
    });
    expect(await customerView(env, over.token)).toMatchObject({
      visible: false, reason: 'outside_window',
    });

    // The edges themselves are inside.
    const edge = await bookedThread({ startsIn: WINDOW_BEFORE_SECONDS - 30 });
    expect((await customerView(env, edge.token)).visible).toBe(true);
  });

  it('shows nothing when the appointment is on another day', async () => {
    await setShareLocation(env, OP, true);
    await recordPosition(env, OP, VAN);

    const tomorrow = await bookedThread({ startsIn: 86400 });
    expect(await customerView(env, tomorrow.token)).toMatchObject({
      visible: false, reason: 'not_today',
    });
  });

  it('goes dark on its own once the fix is stale', async () => {
    const { token } = await bookedThread();
    await setShareLocation(env, OP, true);
    await recordPosition(env, OP, VAN);
    expect((await customerView(env, token)).visible).toBe(true);

    // The phone stopped pinging: a tunnel, a flat battery, or the operator
    // simply finished for the day. Nobody has to press anything -- the fix
    // ages out where it lives. The customer is told which silence this is,
    // which is a different sentence from "the van has not reported yet".
    await vanStub(OP).clear();
    await recordPosition(env, OP, {
      ...VAN, recorded_at: now() - STALE_AFTER_SECONDS - 60,
    });

    expect(await customerView(env, token)).toMatchObject({ visible: false, reason: 'stale' });
  });

  it('shows nothing when the van has never pinged', async () => {
    const { token } = await bookedThread();
    await setShareLocation(env, OP, true);
    expect(await customerView(env, token)).toMatchObject({
      visible: false, reason: 'no_position',
    });
  });

  it('shows nothing for a link with no booking behind it, or no link at all', async () => {
    await setShareLocation(env, OP, true);
    await recordPosition(env, OP, VAN);

    // A question asked from the public slot page, before any booking exists.
    const { token } = await startThread(env, { operator_id: OP, guest_name: 'Rosa' });
    expect(await customerView(env, token)).toMatchObject({
      visible: false, reason: 'no_appointment',
    });

    expect(await customerView(env, 'not-a-real-token'))
      .toMatchObject({ visible: false, reason: 'no_thread' });
    expect(await customerView(env, '')).toMatchObject({ visible: false, reason: 'no_thread' });
  });

  it('shows nothing once the appointment is cancelled', async () => {
    const { token, appointmentId } = await bookedThread();
    await setShareLocation(env, OP, true);
    await recordPosition(env, OP, VAN);

    await env.DB.prepare(`UPDATE appointments SET status = 'cancelled' WHERE id = ?`)
      .bind(appointmentId).run();

    expect(await customerView(env, token)).toMatchObject({
      visible: false, reason: 'cancelled',
    });
  });

  it('shows nothing when the appointment has no coordinates to drive to', async () => {
    const { token } = await bookedThread({ lat: null, lng: null });
    await setShareLocation(env, OP, true);
    await recordPosition(env, OP, VAN);

    expect(await customerView(env, token)).toMatchObject({
      visible: false, reason: 'no_destination',
    });
  });
});

describe('the tenant boundary', () => {
  it('never shows a customer of one business the other business van', async () => {
    // Both businesses share location, both vans are pinging, both have a job
    // on right now. The only thing separating them is the thread token -- and
    // the only van a token can name is its own thread's operator_id.
    await setShareLocation(env, OP, true);
    await setShareLocation(env, OTHER, true);
    await recordPosition(env, OP, VAN);
    await recordPosition(env, OTHER, OTHER_VAN);

    const mine = await bookedThread({ operator: OP });
    const theirs = await bookedThread({ operator: OTHER });

    const a = await customerView(env, mine.token);
    const b = await customerView(env, theirs.token);
    if (!a.visible || !b.visible) throw new Error('both should be visible here');

    expect(a.lat).toBeCloseTo(34.150, 3);
    expect(b.lat).toBeCloseTo(34.168, 3);
    expect(a.lat).not.toBeCloseTo(b.lat, 2);
    expect(a.lng).not.toBeCloseTo(b.lng, 2);

    // And a token for a business whose van holds nothing sees nothing, rather
    // than falling through to somebody else's position.
    await vanStub(OP).clear();
    expect(await customerView(env, mine.token)).toMatchObject({
      visible: false, reason: 'no_position',
    });
    expect((await customerView(env, theirs.token)).visible).toBe(true);
  });
});

describe('an environment with no VAN binding', () => {
  it('boots and answers, with no van anywhere', async () => {
    // A preview that has not had the Durable Object migration applied yet.
    // Losing the map is acceptable; taking the site down over it is not.
    const { token } = await bookedThread();
    await setShareLocation(env, OP, true);

    const bare = { ...(env as unknown as Record<string, unknown>), VAN: undefined } as unknown as Env;

    expect(await recordPosition(bare, OP, VAN)).toEqual({ stored: false });
    expect(await operatorPosition(bare, OP)).toEqual({ position: null, trail: [] });
    expect(await customerView(bare, token)).toMatchObject({
      visible: false, reason: 'no_position',
    });
  });
});
