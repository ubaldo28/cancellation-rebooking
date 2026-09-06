import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import type { Candidate, Env, Operator } from '../src/types';
import { detectGaps } from '../src/lib/gaps';
import { buildMessage, createOffers } from '../src/lib/offers';
import { discounted } from '../src/lib/countries';
import { expireRequests } from '../src/lib/online';
import type { GapRow } from '../src/lib/rank';
import { fromLocal, localDayStart, toLocal } from '../src/lib/tz';
import { newId, now } from '../src/lib/util';

/**
 * Round two: the things a first correctness pass did not reach.
 *
 * Each block below is a defect that shipped, written so it fails against the
 * code as it was rather than merely describing the fix.
 */

const TZ = 'America/Los_Angeles';

async function seedOperator(env: Env, overrides: Partial<Operator> = {}): Promise<Operator> {
  const t = now();
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,timezone,country,currency,location_mode,
       fill_model,sms_mode,home_lat,home_lng,min_gap_seconds,max_detour_seconds,buffer_seconds,
       offer_ttl_seconds,offers_per_wave,min_notice_seconds,reoffer_cooldown_seconds,
       discount_percent,plan,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind('op1', 'a@x.com', 'Shine Mobile', TZ, 'US', 'USD', 'mobile', 'both', 'device',
    34.05, -118.24, 3600, 900, 900, 5400, 3,
    overrides.min_notice_seconds ?? 7200, 604800,
    overrides.discount_percent ?? 0, 'active', t, t).run();
  return (await env.DB.prepare(`SELECT * FROM operators WHERE id='op1'`).first()) as Operator;
}

afterEach(() => vi.useRealTimers());

// ---------------------------------------------------------------------------

describe('an opening keeps its identity while the notice window walks past it', () => {
  /**
   * A fixed instant: nine in the morning, in the operator's own zone.
   *
   * Every test in this block detects gaps in "today" and then walks the clock
   * forward by up to three quarters of an hour. Taken off the real clock, that
   * made all three a function of what time of day the suite happened to run.
   * Past about eight in the evening Pacific the two-hour notice window pushed
   * what was left of the day under min_gap_seconds, the opening expired, and
   * the assertions here failed against a Worker nobody had touched — which is
   * a test that reports the hour rather than the code.
   */
  const ANCHOR_MS = fromLocal(TZ, 2026, 6, 15, 9 * 60) * 1000;

  /**
   * The clamp that keeps a detected gap bookable moves its start forward by
   * whatever the clock has done since the last run. That made the upsert key
   * different on every cron tick, so the same free afternoon was re-inserted as
   * a new row and the previous one expired -- four times an hour, for as long
   * as it stayed open.
   */
  async function detectAcross(ticks: number) {
    vi.useFakeTimers();
    vi.setSystemTime(ANCHOR_MS);
    const env = makeEnv(ALL_MIGRATIONS) as unknown as Env;
    const op = await seedOperator(env);
    const t = now();

    // Working hours covering the whole day, so today's remaining hours are one
    // free window whose natural start is already in the past.
    for (let wd = 0; wd <= 6; wd++) {
      await env.DB.prepare(
        `INSERT INTO working_hours (id,operator_id,weekday,start_minute,end_minute,created_at)
         VALUES (?,?,?,0,1439,?)`,
      ).bind(newId(), 'op1', wd, t).run();
    }

    const base = ANCHOR_MS;
    const day = localDayStart(Math.floor(base / 1000), TZ);
    for (let i = 0; i < ticks; i++) {
      vi.setSystemTime(base + i * 15 * 60 * 1000);
      await detectGaps(env, op, day, 1);
    }
    vi.useRealTimers();
    return env;
  }

  it('does not mint a new gap row on every quarter-hourly run', async () => {
    const env = await detectAcross(4);
    const all = await env.DB.prepare(`SELECT id, status FROM gaps`).all<any>();
    expect(all.results!.length).toBe(1);
    expect(all.results![0]!.status).toBe('open');
  });

  it('keeps the id that is already in links and in watch_hits', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(ANCHOR_MS);
    const env = makeEnv(ALL_MIGRATIONS) as unknown as Env;
    const op = await seedOperator(env);
    const t = now();
    for (let wd = 0; wd <= 6; wd++) {
      await env.DB.prepare(
        `INSERT INTO working_hours (id,operator_id,weekday,start_minute,end_minute,created_at)
         VALUES (?,?,?,0,1439,?)`,
      ).bind(newId(), 'op1', wd, t).run();
    }

    const base = ANCHOR_MS;
    const day = localDayStart(Math.floor(base / 1000), TZ);

    await detectGaps(env, op, day, 1);
    const first = await env.DB.prepare(
      `SELECT id, starts_at FROM gaps WHERE status='open'`).first<any>();

    vi.setSystemTime(base + 30 * 60 * 1000);
    await detectGaps(env, op, day, 1);
    vi.useRealTimers();

    const after = await env.DB.prepare(
      `SELECT id, starts_at FROM gaps WHERE status='open'`).all<any>();

    expect(after.results!.length).toBe(1);
    // Same row. Its start has legitimately moved with the notice window; the
    // opening a customer was told about has not become a different opening.
    expect(after.results![0]!.id).toBe(first!.id);
    expect(after.results![0]!.starts_at).toBeGreaterThan(first!.starts_at);
  });

  it('still withdraws a window that genuinely stopped being free', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(ANCHOR_MS);
    const env = makeEnv(ALL_MIGRATIONS) as unknown as Env;
    const op = await seedOperator(env);
    const t = now();
    for (let wd = 0; wd <= 6; wd++) {
      await env.DB.prepare(
        `INSERT INTO working_hours (id,operator_id,weekday,start_minute,end_minute,created_at)
         VALUES (?,?,?,0,1439,?)`,
      ).bind(newId(), 'op1', wd, t).run();
    }
    const day = localDayStart(t, TZ);
    await detectGaps(env, op, day, 1);
    const before = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM gaps WHERE status='open'`).first<any>();
    expect(before!.n).toBeGreaterThan(0);

    // Book the whole rest of the day out.
    await env.DB.prepare(
      `INSERT INTO appointments (id,operator_id,starts_at,ends_at,is_mobile,status,source,
         created_at,updated_at) VALUES (?,?,?,?,1,'scheduled','manual',?,?)`,
    ).bind(newId(), 'op1', t, t + 3 * 86400, t, t).run();

    await detectGaps(env, op, day, 1);
    const after = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM gaps WHERE status='open'`).first<any>();
    expect(after!.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('the hour that does not exist on the March Sunday', () => {
  /**
   * 2026-03-08 02:00 America/Los_Angeles is skipped: the clock goes straight
   * from 01:59 to 03:00. fromLocal settled on an instant an HOUR EARLIER than
   * the wall time asked for, so 02:00 and 01:00 returned the same second and a
   * window typed as starting at 02:00 was detected as starting at 01:00.
   */
  const at = (min: number) => fromLocal(TZ, 2026, 3, 8, min);

  it('never answers a wall time with an instant before it', () => {
    expect(at(120)).toBeGreaterThan(at(60));
    expect(at(150)).toBeGreaterThan(at(90));
  });

  it('does not collapse two different wall times onto one instant', () => {
    expect(at(120)).not.toBe(at(60));
    expect(at(150)).not.toBe(at(90));
  });

  it('returns the instant the clock jumps to, as the contract says', () => {
    // 03:00 PDT is the first moment that exists after the skipped hour.
    expect(at(120)).toBe(at(180));
    expect(toLocal(at(120), TZ).minuteOfDay).toBe(180);
  });

  it('leaves every ordinary wall time on that day exactly where it was', () => {
    for (const min of [0, 30, 60, 90, 180, 240, 600, 1020, 1439]) {
      expect(toLocal(at(min), TZ).minuteOfDay).toBe(min);
    }
  });

  it('still picks the first of the two 01:30s on the November Sunday', () => {
    // The autumn boundary repeats 01:00-01:59. The earlier (PDT) one is the
    // answer, and the second pass is what finds it.
    const ambiguous = fromLocal(TZ, 2026, 11, 1, 90);
    expect(toLocal(ambiguous, TZ).minuteOfDay).toBe(90);
    expect(fromLocal(TZ, 2026, 11, 1, 120) - ambiguous).toBe(5400);  // 01:30 -> 02:00 is 90 min
  });
});

// ---------------------------------------------------------------------------

describe('a second wave of offers on the same opening', () => {
  async function setup(discountPercent = 0) {
    const env = makeEnv(ALL_MIGRATIONS) as unknown as Env;
    const op = await seedOperator(env, { discount_percent: discountPercent } as Partial<Operator>);
    const t = now();
    await env.DB.prepare(
      `INSERT INTO clients (id,operator_id,first_name,phone_e164,sms_consent,sms_consent_at,
         created_at,updated_at) VALUES ('c1','op1','Rosa','+13105550101',1,?,?,?)`,
    ).bind(t, t, t).run();
    await env.DB.prepare(
      `INSERT INTO gaps (id,operator_id,starts_at,ends_at,is_mobile,status,created_at,updated_at)
       VALUES ('g1','op1',?,?,1,'open',?,?)`,
    ).bind(t + 86400, t + 86400 + 7200, t, t).run();
    const gap = (await env.DB.prepare(`SELECT * FROM gaps WHERE id='g1'`).first()) as GapRow;
    const cand = [{
      kind: 'client', client_id: 'c1', lead_id: null, service_id: null,
      first_name: 'Rosa', phone_e164: '+13105550101', language: null,
      title: 'Full detail', duration_seconds: 3600, price_cents: 6500,
      drive_in_seconds: 0, drive_out_seconds: 0, detour_seconds: 0,
      overdue_days: 3, urgency: 1, score: 1, reasons: [],
    } as unknown as Candidate];
    return { env, op, gap, cand };
  }

  it('goes out instead of failing the whole batch on a foreign key', async () => {
    const { env, op, gap, cand } = await setup();
    await createOffers(env, op, gap, cand);
    // The upsert keeps the first row's id; the message row used to be bound to
    // a freshly minted one that names no offer, and messages.offer_id is a
    // foreign key -- so the second wave threw and nobody was texted at all.
    const second = await createOffers(env, op, gap, cand);
    expect(second.length).toBe(1);

    const offers = await env.DB.prepare(`SELECT id FROM gap_offers`).all<any>();
    expect(offers.results!.length).toBe(1);
    // The id handed back is a row that exists, so a caller can act on it.
    expect(second[0]!.offer_id).toBe(offers.results![0]!.id);

    const messages = await env.DB.prepare(
      `SELECT offer_id FROM messages ORDER BY created_at`).all<any>();
    expect(messages.results!.length).toBe(2);
    for (const m of messages.results!) expect(m.offer_id).toBe(offers.results![0]!.id);
  });

  it('re-quotes at the price the new message actually names', async () => {
    const { env, op, gap, cand } = await setup(10);
    await createOffers(env, op, gap, cand);
    const dearer = [{ ...cand[0]!, price_cents: 9000 }] as Candidate[];
    await createOffers(env, op, gap, dearer);
    const row = await env.DB.prepare(
      `SELECT quoted_price_cents FROM gap_offers WHERE gap_id='g1'`).first<any>();
    expect(row!.quoted_price_cents).toBe(discounted(9000, 10, 'USD'));
  });
});

describe('a discount is the same number wherever it is read', () => {
  it('quotes an invited client what the public listing would quote a stranger', async () => {
    const env = makeEnv(ALL_MIGRATIONS) as unknown as Env;
    const op = await seedOperator(env, { discount_percent: 10 } as Partial<Operator>);
    const t = now();
    await env.DB.prepare(
      `INSERT INTO clients (id,operator_id,first_name,phone_e164,sms_consent,sms_consent_at,
         created_at,updated_at) VALUES ('c1','op1','Rosa','+13105550101',1,?,?,?)`,
    ).bind(t, t, t).run();
    await env.DB.prepare(
      `INSERT INTO gaps (id,operator_id,starts_at,ends_at,is_mobile,status,created_at,updated_at)
       VALUES ('g1','op1',?,?,1,'open',?,?)`,
    ).bind(t + 86400, t + 86400 + 7200, t, t).run();
    const gap = (await env.DB.prepare(`SELECT * FROM gaps WHERE id='g1'`).first()) as GapRow;
    const cand = {
      kind: 'client', client_id: 'c1', lead_id: null, service_id: null,
      first_name: 'Rosa', phone_e164: '+13105550101', language: null,
      title: 'Full detail', duration_seconds: 3600, price_cents: 6500,
      drive_in_seconds: 0, drive_out_seconds: 0, detour_seconds: 0,
      overdue_days: 3, urgency: 1, score: 1, reasons: [],
    } as unknown as Candidate;

    // 10% off $65.00 is $58.50 as a bare percentage, and $59.00 once the
    // shared rounding is applied. The listing has always said $59.00.
    const expected = discounted(6500, 10, 'USD');
    expect(expected).toBe(5900);

    expect(buildMessage(op, cand, gap, 'https://gap.test/o/x')).toContain('$59.00');

    const [offer] = await createOffers(env, op, gap, [cand]);
    const row = await env.DB.prepare(
      `SELECT quoted_price_cents FROM gap_offers WHERE id=?`).bind(offer!.offer_id).first<any>();
    // This is the figure acceptOffer copies onto the appointment.
    expect(row!.quoted_price_cents).toBe(expected);
  });
});

// ---------------------------------------------------------------------------

describe('the missed-job sweep speaks only about the jobs it actually expired', () => {
  it('does not tell an operator they missed the request they just accepted', async () => {
    const env = makeEnv(ALL_MIGRATIONS) as unknown as Env;
    await seedOperator(env);
    const t = now();

    const add = async (id: string, name: string) => {
      await env.DB.prepare(
        `INSERT INTO instant_requests (id,operator_id,starts_at,duration_seconds,price_cents,
           currency,guest_name,phone_e164,status,expires_at,token_hash,created_at,updated_at)
         VALUES (?,?,?,3600,5000,'USD',?,'+13105550101','pending',?,?,?,?)`,
      ).bind(id, 'op1', t, name, t - 10, `hash-${id}`, t, t).run();
    };
    await add('r_missed', 'Missed');
    await add('r_taken', 'Taken');

    // The race the sweep is written around: the operator accepts between the
    // select that found the row and the update that expires it. Hooked at the
    // one seam where that can happen, so it is deterministic rather than lucky.
    const realPrepare = (env.DB as any).prepare.bind(env.DB);
    let raced = false;
    (env.DB as any).prepare = (sql: string) => {
      if (!raced && /UPDATE instant_requests SET status='expired'/.test(sql)) {
        raced = true;
        realPrepare(
          `UPDATE instant_requests SET status='accepted' WHERE id='r_taken'`,
        ).run();
      }
      return realPrepare(sql);
    };

    const expired = await expireRequests(env);
    (env.DB as any).prepare = realPrepare;

    expect(expired).toBe(1);

    const notes = await env.DB.prepare(`SELECT title FROM notifications`).all<any>();
    const titles = notes.results!.map((n: any) => n.title);
    expect(titles).toContain('You missed a job from Missed');
    expect(titles).not.toContain('You missed a job from Taken');

    // And the accepted request is left accepted.
    const taken = await env.DB.prepare(
      `SELECT status FROM instant_requests WHERE id='r_taken'`).first<any>();
    expect(taken!.status).toBe('accepted');
  });
});

// ---------------------------------------------------------------------------

describe('the cron sweeps seek instead of reading a whole table', () => {
  /**
   * Both of these run with no operator_id in the WHERE clause, so the existing
   * indexes -- which all lead with operator_id -- cannot serve them, and both
   * answered a bare SCAN. Every other table swept on the tick already had a
   * (status, <time>) index; these two did not.
   */
  const planFor = async (env: Env, sql: string) => {
    const rows = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<any>();
    return rows.results!.map((r: any) => r.detail).join(' | ');
  };

  it('does not read every offer ever sent to expire the lapsed ones', async () => {
    const env = makeEnv(ALL_MIGRATIONS) as unknown as Env;
    const plan = await planFor(env,
      `SELECT id FROM gap_offers
        WHERE status IN ('sent','delivered','viewed','queued')
          AND expires_at IS NOT NULL AND expires_at <= 1`);
    expect(plan).toMatch(/SEARCH gap_offers USING INDEX/);
  });

  it('does not read every gap ever detected to release the offering ones', async () => {
    const env = makeEnv(ALL_MIGRATIONS) as unknown as Env;
    const plan = await planFor(env, `SELECT id FROM gaps WHERE status = 'offering'`);
    expect(plan).toMatch(/SEARCH gaps USING INDEX/);
  });

  it('seeks rather than scans the live gaps for the listing range', async () => {
    const env = makeEnv(ALL_MIGRATIONS) as unknown as Env;
    const plan = await planFor(env,
      `SELECT id FROM gaps WHERE status IN ('open','offering')
         AND starts_at > 1 AND starts_at < 2`);
    expect(plan).toMatch(/SEARCH gaps USING INDEX/);
  });
});
