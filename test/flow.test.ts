import { describe, expect, it, beforeEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import { captureBulkEmail, makeReachable } from './reachable';
import type { Env, Operator } from '../src/types';
import { detectGaps } from '../src/lib/gaps';
import { lateLabel, rankCandidates, type GapRow } from '../src/lib/rank';
import { acceptOffer, createOffers, offerStopToken, stopOffersByToken } from '../src/lib/offers';
import { fromLocal, toLocal, localDayStart } from '../src/lib/tz';
import { pickLang, STOP_WORDS, START_WORDS } from '../src/lib/messages';
import { buildMessage } from '../src/lib/offers';
import { newId, now, toE164 } from '../src/lib/util';

const MIGRATION = ALL_MIGRATIONS;
const TZ = 'America/Los_Angeles';

let env: Env;
let op: Operator;

/** Build a fixture day: Wednesday 09:00–17:00, two jobs, a real hole between. */
async function seed(opts: Partial<Operator> = {}) {
  env = makeEnv(MIGRATION) as unknown as Env;
  const t = now();
  const id = 'op1';
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,timezone,country,currency,location_mode,
       fill_model,sms_mode,home_lat,home_lng,min_gap_seconds,max_detour_seconds,buffer_seconds,
       offer_ttl_seconds,offers_per_wave,min_notice_seconds,reoffer_cooldown_seconds,
       discount_percent,plan,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    id, 'a@x.com', 'Shine Mobile', TZ, 'US', 'USD',
    opts.location_mode ?? 'mobile', opts.fill_model ?? 'both', 'device',
    34.0522, -118.2437,
    opts.min_gap_seconds ?? 3600, opts.max_detour_seconds ?? 900, opts.buffer_seconds ?? 900,
    5400, 3, opts.min_notice_seconds ?? 3600, 604800, 0, 'active', t, t,
  ).run();
  op = (await env.DB.prepare(`SELECT * FROM operators WHERE id=?`).bind(id).first()) as Operator;

  for (let wd = 1; wd <= 5; wd++) {
    await env.DB.prepare(
      `INSERT INTO working_hours (id,operator_id,weekday,start_minute,end_minute,created_at)
       VALUES (?,?,?,?,?,?)`,
    ).bind(newId(), id, wd, 540, 1020, t).run();
  }

  await env.DB.prepare(
    `INSERT INTO services (id,operator_id,name,duration_seconds,price_cents,cadence_days,created_at,updated_at)
     VALUES ('sv_detail',?,'Full detail',7200,6500,28,?,?)`,
  ).bind(id, t, t).run();
  await env.DB.prepare(
    `INSERT INTO services (id,operator_id,name,duration_seconds,price_cents,cadence_days,requires_client_present,created_at,updated_at)
     VALUES ('sv_repair',?,'Repair',5400,12000,NULL,1,?,?)`,
  ).bind(id, t, t).run();
}

/** Next weekday at a given local hour, at least `minDays` out. */
function futureLocal(hour: number, minDays = 2): number {
  let probe = localDayStart(now() + minDays * 86400, TZ);
  for (let i = 0; i < 10; i++) {
    const p = toLocal(probe, TZ);
    if (p.weekday >= 1 && p.weekday <= 5) return fromLocal(TZ, p.year, p.month, p.day, hour * 60);
    probe += 86400;
  }
  throw new Error('no weekday found');
}

async function addAppt(startS: number, endS: number, lat: number, lng: number, clientId?: string) {
  const t = now();
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO appointments (id,operator_id,client_id,starts_at,ends_at,is_mobile,lat,lng,
       status,source,created_at,updated_at)
     VALUES (?,?,?,?,?,1,?,?, 'scheduled','manual',?,?)`,
  ).bind(id, op.id, clientId ?? null, startS, endS, lat, lng, t, t).run();
  return id;
}

/**
 * A customer this platform introduced, exactly as the booking paths write one.
 *
 * NO PHONE NUMBER AND NO CONSENT FLAG, which is the whole point and not a
 * shortcut in the fixture: clientWrite in src/lib/orders.ts and the identical
 * insert in src/lib/public.ts spell out `phone_e164 NULL, email NULL,
 * sms_consent 0` on purpose, because no contact details are exchanged here.
 * These fixtures used to set a number and tick consent, which meant every
 * ranking test in this file was describing a customer the product does not
 * create — and the two queries under test happily returned them while
 * returning nobody at all on the live site.
 *
 * `reachable: false` writes the row and stops there: a client with no
 * conversation and no account behind them, which is what an operator's own
 * imported client looks like and is now the honest definition of somebody this
 * deployment cannot offer anything to.
 */
async function addClient(o: {
  id: string; name: string; lat?: number; lng?: number;
  dueDaysAgo?: number; reachable?: boolean; email?: string;
  service?: string; noShows?: number;
}) {
  const t = now();
  await env.DB.prepare(
    `INSERT INTO clients (id,operator_id,first_name,phone_e164,email,lat,lng,geocode_status,
       default_service_id,last_serviced_at,next_due_at,no_show_count,sms_consent,sms_consent_at,
       acquired,platform_introduced,created_at,updated_at)
     VALUES (?,?,?,NULL,NULL,?,?,?,?,?,?,?,0,NULL,'public',1,?,?)`,
  ).bind(
    o.id, op.id, o.name, o.lat ?? null, o.lng ?? null,
    o.lat != null ? 'ok' : 'failed',
    o.service ?? 'sv_detail', null,
    o.dueDaysAgo != null ? now() - o.dueDaysAgo * 86400 : null,
    o.noShows ?? 0, t, t,
  ).run();

  if (o.reachable === false) return null;
  return makeReachable(env, {
    operator_id: op.id, client_id: o.id, guest_name: o.name, email: o.email, at: t,
  });
}

async function openGap(): Promise<GapRow> {
  const rows = await env.DB.prepare(
    `SELECT * FROM gaps WHERE operator_id=? AND status IN ('open','offering') ORDER BY starts_at`,
  ).bind(op.id).all<GapRow>();
  return rows.results![0]!;
}

describe('an empty day is not a gap to fill', () => {
  it('flags a day with no jobs, and does not flag a hole between jobs', async () => {
    await seed();
    // One working day with two jobs and a real hole between them. Every other
    // day in range stays empty, which is the case being separated out.
    const dayStart = futureLocal(9);
    await addAppt(dayStart, dayStart + 2 * 3600, 34.0548, -118.2378);
    await addAppt(dayStart + 6 * 3600, dayStart + 8 * 3600, 34.0648, -118.2454);

    await detectGaps(env, op, now(), 7);
    const rows = await env.DB.prepare(
      `SELECT starts_at, ends_at, fills_whole_day FROM gaps
        WHERE operator_id = ? AND status = 'open' ORDER BY starts_at`,
    ).bind(op.id).all<{ starts_at: number; ends_at: number; fills_whole_day: number }>();

    const all = rows.results ?? [];
    const holes = all.filter((r) => r.fills_whole_day === 0);
    const emptyDays = all.filter((r) => r.fills_whole_day === 1);

    expect(holes.length).toBeGreaterThan(0);
    expect(emptyDays.length).toBeGreaterThan(0);

    // The hole sits inside the day that has jobs, and never spans the whole
    // 09:00-17:00 window.
    for (const h of holes) {
      expect(h.starts_at).toBeGreaterThanOrEqual(dayStart);
      expect(h.ends_at - h.starts_at).toBeLessThan(8 * 3600);
    }
    // No flagged day overlaps the day that has jobs.
    for (const e of emptyDays) {
      expect(e.starts_at >= dayStart + 8 * 3600 || e.ends_at <= dayStart).toBe(true);
    }
  });
});

describe('gap detection', () => {
  beforeEach(async () => { await seed(); });

  it('finds the hole between two jobs, with buffers applied', async () => {
    const nine = futureLocal(9);
    await addAppt(nine, nine + 3600, 34.0448, -118.2378);              // 09:00–10:00
    await addAppt(nine + 6 * 3600, nine + 7 * 3600, 34.0648, -118.2228); // 15:00–16:00

    const res = await detectGaps(env, op, nine, 1);
    expect(res.created).toBeGreaterThan(0);

    const gaps = await env.DB.prepare(
      `SELECT * FROM gaps WHERE operator_id=? ORDER BY starts_at`,
    ).bind(op.id).all<GapRow>();
    const mid = gaps.results!.find((g) => g.starts_at >= nine + 3600 && g.ends_at <= nine + 6 * 3600);
    expect(mid).toBeTruthy();
    // 10:00 job end + 15 min buffer = 10:15 ; 15:00 job start - 15 min = 14:45
    expect(mid!.starts_at).toBe(nine + 3600 + 900);
    expect(mid!.ends_at).toBe(nine + 6 * 3600 - 900);
    expect(mid!.prev_lat).toBeCloseTo(34.0448, 4);
    expect(mid!.next_lat).toBeCloseTo(34.0648, 4);
    expect(mid!.baseline_drive_seconds).toBeGreaterThan(0);
  });

  it('ignores holes shorter than min_gap_seconds', async () => {
    const nine = futureLocal(9);
    await addAppt(nine, nine + 3600, 34.0448, -118.2378);
    await addAppt(nine + 4600, nine + 8200, 34.0448, -118.2378);   // only ~17 min apart
    await detectGaps(env, op, nine, 1);
    const gaps = await env.DB.prepare(
      `SELECT * FROM gaps WHERE operator_id=? AND starts_at > ? AND ends_at < ?`,
    ).bind(op.id, nine + 3600, nine + 4600).all();
    expect(gaps.results!.length).toBe(0);
  });

  it('is idempotent — re-running does not duplicate gaps', async () => {
    const nine = futureLocal(9);
    await addAppt(nine, nine + 3600, 34.0448, -118.2378);
    await detectGaps(env, op, nine, 3);
    const first = await env.DB.prepare(`SELECT COUNT(*) AS n FROM gaps`).first<{ n: number }>();
    await detectGaps(env, op, nine, 3);
    const second = await env.DB.prepare(`SELECT COUNT(*) AS n FROM gaps`).first<{ n: number }>();
    expect(second!.n).toBe(first!.n);
  });

  it('respects time off', async () => {
    const nine = futureLocal(9);
    await env.DB.prepare(
      `INSERT INTO time_off (id,operator_id,starts_at,ends_at,created_at) VALUES (?,?,?,?,?)`,
    ).bind(newId(), op.id, nine, nine + 8 * 3600, now()).run();
    await detectGaps(env, op, nine, 1);
    const gaps = await env.DB.prepare(
      `SELECT * FROM gaps WHERE operator_id=? AND starts_at >= ? AND starts_at < ?`,
    ).bind(op.id, nine, nine + 8 * 3600).all();
    expect(gaps.results!.length).toBe(0);
  });

  it('produces no gaps when no working hours are set', async () => {
    await env.DB.prepare(`DELETE FROM working_hours WHERE operator_id=?`).bind(op.id).run();
    const res = await detectGaps(env, op, futureLocal(9), 5);
    expect(res.created).toBe(0);
  });
});

describe('candidate ranking', () => {
  beforeEach(async () => { await seed(); });

  it('prefers the nearby overdue client over the distant one', async () => {
    const nine = futureLocal(9);
    await addAppt(nine, nine + 3600, 34.0522, -118.2437);
    await addAppt(nine + 6 * 3600, nine + 7 * 3600, 34.0548, -118.2378);
    await addClient({ id: 'near', name: 'Nina', lat: 34.0538, lng: -118.2408, dueDaysAgo: 10 });
    await addClient({ id: 'far', name: 'Fred', lat: 34.2448, lng: -118.4482, dueDaysAgo: 40 });

    await detectGaps(env, op, nine, 1);
    const gap = await openGap();
    const ranked = await rankCandidates(env, op, gap);

    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0]!.client_id).toBe('near');
    // Fred is more overdue but too far — proximity is weighted heavier on purpose.
    const fred = ranked.find((c) => c.client_id === 'far');
    if (fred) expect(fred.score).toBeLessThan(ranked[0]!.score);
  });

  /**
   * THE TEST THAT WOULD HAVE CAUGHT THE WHOLE THING.
   *
   * A customer who booked through this site has no phone number and no SMS
   * consent on their row, by design, and every one of them was therefore
   * excluded by the old queries — which is to say the feature returned nobody
   * on a live marketplace and the dashboard told the operator their clients
   * needed mobile numbers they are never allowed to hold.
   */
  it('offers the platform-introduced customer who has no phone at all', async () => {
    const nine = futureLocal(9);
    await addAppt(nine, nine + 3600, 34.0522, -118.2437);
    await addAppt(nine + 6 * 3600, nine + 7 * 3600, 34.0548, -118.2378);
    const made = await addClient({
      id: 'rosa', name: 'Rosa', lat: 34.0538, lng: -118.2408, dueDaysAgo: 5,
    });

    const stored = await env.DB.prepare(
      `SELECT phone_e164, sms_consent FROM clients WHERE id='rosa'`,
    ).first<{ phone_e164: string | null; sms_consent: number }>();
    expect(stored!.phone_e164).toBeNull();
    expect(stored!.sms_consent).toBe(0);

    await detectGaps(env, op, nine, 1);
    const ranked = await rankCandidates(env, op, await openGap());
    const rosa = ranked.find((c) => c.client_id === 'rosa');
    expect(rosa).toBeTruthy();
    // The conversation is on the candidate, because it is what makes them one.
    expect(rosa!.thread_id).toBe(made!.thread_id);
    // And no contact detail travels with them. A number the operator never
    // holds cannot be in a payload their browser receives.
    expect(Object.keys(rosa!)).not.toContain('phone_e164');
    expect(JSON.stringify(rosa)).not.toContain(made!.email);
  });

  it('excludes the unreachable, the opted out, and the already booked', async () => {
    const nine = futureLocal(9);
    await addAppt(nine, nine + 3600, 34.0522, -118.2437);
    await addAppt(nine + 6 * 3600, nine + 7 * 3600, 34.0548, -118.2378);

    await addClient({ id: 'ok', name: 'Ok', lat: 34.0538, lng: -118.2408, dueDaysAgo: 5 });
    // The operator's own imported client: a row on their list with no
    // conversation and no account behind it. Nothing this deployment can send
    // reaches them, so they are not offered anything.
    await addClient({
      id: 'noreach', name: 'No', lat: 34.0538, lng: -118.2408, dueDaysAgo: 5,
      reachable: false,
    });
    // Booked here, but the conversation is closed: an offer posted into it
    // would be a message into a room with the door shut.
    await addClient({ id: 'shut', name: 'Shut', lat: 34.0538, lng: -118.2408, dueDaysAgo: 5 });
    await env.DB.prepare(`UPDATE threads SET status='closed' WHERE client_id='shut'`).run();
    // Booked here, but never proved the mailbox, so there is nowhere to send
    // the nudge and no way for them to press stop.
    await addClient({ id: 'unproved', name: 'Un', lat: 34.0538, lng: -118.2408, dueDaysAgo: 5 });
    await env.DB.prepare(
      `UPDATE customer_accounts SET email_verified_at=NULL WHERE login_email='unproved@example.test'`,
    ).run();
    await addClient({ id: 'optout', name: 'Out', lat: 34.0538, lng: -118.2408, dueDaysAgo: 5 });
    await env.DB.prepare(`UPDATE clients SET opted_out_at=? WHERE id='optout'`).bind(now()).run();
    await addClient({ id: 'booked', name: 'Booked', lat: 34.0538, lng: -118.2408, dueDaysAgo: 5 });
    await addAppt(nine + 30 * 86400, nine + 30 * 86400 + 3600, 34.0538, -118.2408, 'booked');

    await detectGaps(env, op, nine, 1);
    const ranked = await rankCandidates(env, op, await openGap());
    const ids = ranked.map((c) => c.client_id);
    expect(ids).toContain('ok');
    expect(ids).not.toContain('noreach');
    expect(ids).not.toContain('shut');
    expect(ids).not.toContain('unproved');
    expect(ids).not.toContain('optout');
    expect(ids).not.toContain('booked');
  });

  /**
   * One person, four bookings, four client rows — because placeOrder mints a
   * fresh one per basket and never looks for an existing row. Keyed on the
   * client row this would put the same person on the screen four times and
   * send them four offers for one hour, each with its own accept link racing
   * the others.
   */
  it('counts a repeat customer once, however many client rows they have', async () => {
    const nine = futureLocal(9);
    await addAppt(nine, nine + 3600, 34.0522, -118.2437);
    await addAppt(nine + 6 * 3600, nine + 7 * 3600, 34.0548, -118.2378);
    for (const id of ['visit1', 'visit2', 'visit3']) {
      await addClient({
        id, name: 'Dee', lat: 34.0538, lng: -118.2408, dueDaysAgo: 5,
        email: 'dee@example.test',
      });
    }

    await detectGaps(env, op, nine, 1);
    const ranked = await rankCandidates(env, op, await openGap());
    expect(ranked.filter((c) => c.first_name === 'Dee')).toHaveLength(1);
  });

  it('drops candidates whose job plus travel will not fit the gap', async () => {
    const nine = futureLocal(9);
    await addAppt(nine, nine + 3600, 34.0522, -118.2437);
    await addAppt(nine + 3600 + 900 + 5400 + 900, nine + 3600 + 900 + 5400 + 1800, 34.0522, -118.2437);
    await addClient({ id: 'toolong', name: 'Long', lat: 34.0522, lng: -118.2437, dueDaysAgo: 5 });
    await detectGaps(env, op, nine, 1);
    const gap = await openGap();
    const ranked = await rankCandidates(env, op, gap);
    // Full detail is 7200s; the hole is 5400s. It cannot fit.
    expect(ranked.find((c) => c.client_id === 'toolong')).toBeUndefined();
  });

  it('surfaces open job leads for break-fix trades', async () => {
    const nine = futureLocal(9);
    await addAppt(nine, nine + 3600, 34.0522, -118.2437);
    await addAppt(nine + 6 * 3600, nine + 7 * 3600, 34.0548, -118.2378);
    await addClient({ id: 'lead_client', name: 'Priya', lat: 34.0538, lng: -118.2408 });

    await env.DB.prepare(
      `INSERT INTO job_leads (id,operator_id,client_id,service_id,title,quoted_price_cents,
         estimated_duration_seconds,parts_required,parts_ready,urgency,status,created_at,updated_at)
       VALUES ('ld1',?,'lead_client','sv_repair','Replace mixer tap',12000,5400,0,1,5,'open',?,?)`,
    ).bind(op.id, now(), now()).run();

    await detectGaps(env, op, nine, 1);
    const ranked = await rankCandidates(env, op, await openGap());
    const lead = ranked.find((c) => c.kind === 'lead');
    expect(lead).toBeTruthy();
    expect(lead!.lead_id).toBe('ld1');
  });

  it('hides leads that are waiting on parts', async () => {
    const nine = futureLocal(9);
    await addAppt(nine, nine + 3600, 34.0522, -118.2437);
    await addAppt(nine + 6 * 3600, nine + 7 * 3600, 34.0548, -118.2378);
    await addClient({ id: 'lc', name: 'Sam', lat: 34.0538, lng: -118.2408 });
    await env.DB.prepare(
      `INSERT INTO job_leads (id,operator_id,client_id,service_id,title,estimated_duration_seconds,
         parts_required,parts_ready,urgency,status,created_at,updated_at)
       VALUES ('ld2',?,'lc','sv_repair','Boiler part',5400,1,0,5,'open',?,?)`,
    ).bind(op.id, now(), now()).run();

    await detectGaps(env, op, nine, 1);
    const ranked = await rankCandidates(env, op, await openGap());
    expect(ranked.find((c) => c.lead_id === 'ld2')).toBeUndefined();
  });

  it('ranks a premises operator on cadence alone, ignoring geography', async () => {
    await seed({ location_mode: 'premises' });
    const nine = futureLocal(9);
    await addAppt(nine, nine + 3600, 34.0522, -118.2437);
    await addAppt(nine + 6 * 3600, nine + 7 * 3600, 34.0548, -118.2378);
    await addClient({ id: 'a', name: 'A', lat: 34.0538, lng: -118.2408, dueDaysAgo: 2 });
    await addClient({ id: 'b', name: 'B', lat: 37.7749, lng: -122.4194, dueDaysAgo: 60 });

    await detectGaps(env, op, nine, 1);
    const gap = await openGap();
    expect(gap.is_mobile).toBe(0);
    const ranked = await rankCandidates(env, op, gap);
    // Distance must not decide it here; the far-but-very-overdue client wins.
    expect(ranked[0]!.client_id).toBe('b');
  });
});

describe('offer lifecycle', () => {
  beforeEach(async () => { await seed(); });

  async function setupOffers(count = 2) {
    const nine = futureLocal(9);
    await addAppt(nine, nine + 3600, 34.0522, -118.2437);
    await addAppt(nine + 6 * 3600, nine + 7 * 3600, 34.0548, -118.2378);
    const made = [];
    for (let i = 0; i < count; i++) {
      made.push(await addClient({
        id: `c${i}`, name: `C${i}`,
        lat: 34.0538 + i * 0.001, lng: -118.2408, dueDaysAgo: 10 - i,
      }));
    }
    await detectGaps(env, op, nine, 1);
    const gap = await openGap();
    const ranked = await rankCandidates(env, op, gap);
    const { result: offers, sent } = await captureBulkEmail(
      env, () => createOffers(env, op, gap, ranked.slice(0, count)));
    return { gap, offers, sent, made };
  }

  /**
   * THE DELIVERY, WHICH IS THE PART THAT DID NOT EXIST.
   *
   * Every offer this feature had ever written said 'sent' and nothing had been
   * sent: the Worker built an `sms:` link out of a phone number that is never
   * stored for a platform customer, handed it to the operator's browser, and
   * logged a row in `messages` — the SMS pipeline's billing table — as the
   * record. What is checked here is that the offer is now a real message in
   * the customer's own conversation, that the SMS table is untouched, and that
   * the nudge left through the BULK lane rather than the one the sign-in links
   * depend on.
   */
  it('lands each offer in that customer conversation and emails about it', async () => {
    const { gap, offers, sent, made } = await setupOffers(2);
    expect(offers.length).toBe(2);
    expect(offers[0]!.url).toContain('/o/');
    expect(offers[0]!.message).not.toMatch(/STOP/i);

    // The message is in the thread that belongs to that client row, from the
    // operator's side, and the customer has an unread waiting.
    for (const o of offers) {
      const mine = made.find((m) => m!.thread_id === o.thread_id)!;
      expect(mine).toBeTruthy();
      const msg = await env.DB.prepare(
        `SELECT sender, body FROM chat_messages WHERE thread_id = ?`,
      ).bind(o.thread_id).first<{ sender: string; body: string }>();
      expect(msg!.sender).toBe('operator');
      expect(msg!.body).toBe(o.message);
      expect(msg!.body).toContain(o.url);
      const th = await env.DB.prepare(
        `SELECT guest_unread FROM threads WHERE id = ?`,
      ).bind(o.thread_id).first<{ guest_unread: number }>();
      expect(th!.guest_unread).toBe(1);
    }

    // Nothing at all in the SMS table. A row there is a message somebody was
    // charged to send, and none was.
    const msgs = await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages`).first<{ n: number }>();
    expect(msgs!.n).toBe(0);

    // One email each, to the address on their account, carrying the offer link
    // and a way to stop being offered things.
    expect(sent.map((s) => s.to).sort()).toEqual(made.map((m) => m!.email).sort());
    for (const o of offers) {
      const mine = sent.find((s) => s.text.includes(o.url))!;
      expect(mine).toBeTruthy();
      expect(mine.text).toContain('/a/stop-offers/');
      expect(offers.every((x) => x.emailed)).toBe(true);
    }

    const g = await env.DB.prepare(`SELECT status FROM gaps WHERE id=?`).bind(gap.id).first<any>();
    expect(g.status).toBe('offering');
  });

  /**
   * The nudge is a nudge. It is sent after the transaction and cannot be part
   * of one, so a provider that refuses must not unmake an offer that is
   * already sitting in somebody's conversation — but the operator is told,
   * rather than shown a screen that says an email went when none did.
   */
  it('keeps the offer when the email is refused, and says so', async () => {
    const nine = futureLocal(9);
    await addAppt(nine, nine + 3600, 34.0522, -118.2437);
    await addAppt(nine + 6 * 3600, nine + 7 * 3600, 34.0548, -118.2378);
    await addClient({ id: 'c0', name: 'C0', lat: 34.0538, lng: -118.2408, dueDaysAgo: 10 });
    await detectGaps(env, op, nine, 1);
    const gap = await openGap();
    const ranked = await rankCandidates(env, op, gap);

    // No provider named at all, which is what this deployment looks like until
    // somebody sets BULK_EMAIL_PROVIDER.
    const offers = await createOffers(env, op, gap, ranked.slice(0, 1));
    expect(offers).toHaveLength(1);
    expect(offers[0]!.emailed).toBe(false);

    const msg = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM chat_messages WHERE thread_id = ?`,
    ).bind(offers[0]!.thread_id).first<{ n: number }>();
    expect(msg!.n).toBe(1);
  });

  it('stores only the hash of the offer token', async () => {
    const { offers } = await setupOffers(1);
    const raw = offers[0]!.url.split('/o/')[1]!;
    const row = await env.DB.prepare(`SELECT token_hash FROM gap_offers LIMIT 1`).first<any>();
    expect(row.token_hash).not.toBe(raw);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepting books the appointment and fills the gap', async () => {
    const { gap, offers } = await setupOffers(2);
    const raw = offers[0]!.url.split('/o/')[1]!;
    const res = await acceptOffer(env, raw);
    expect(res.alreadyYours).toBe(false);

    const appt = await env.DB.prepare(
      `SELECT * FROM appointments WHERE source='gap_fill'`).first<any>();
    expect(appt).toBeTruthy();
    expect(appt.starts_at).toBe(gap.starts_at);
    expect(appt.filled_offer_id).toBe(offers[0]!.offer_id);

    const g = await env.DB.prepare(`SELECT * FROM gaps WHERE id=?`).bind(gap.id).first<any>();
    expect(g.status).toBe('filled');
    expect(g.filled_appointment_id).toBe(appt.id);

    const other = await env.DB.prepare(
      `SELECT status FROM gap_offers WHERE id=?`).bind(offers[1]!.offer_id).first<any>();
    expect(other.status).toBe('superseded');
  });

  it('refuses the second accept on the same gap — no double booking', async () => {
    const { offers } = await setupOffers(2);
    const a = offers[0]!.url.split('/o/')[1]!;
    const b = offers[1]!.url.split('/o/')[1]!;
    await acceptOffer(env, a);
    await expect(acceptOffer(env, b)).rejects.toThrow(/just been taken|no longer open/i);

    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM gap_offers WHERE status='accepted'`).first<{ n: number }>();
    expect(count!.n).toBe(1);
    const appts = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM appointments WHERE source='gap_fill'`).first<{ n: number }>();
    expect(appts!.n).toBe(1);
  });

  it('is idempotent when the same person taps accept twice', async () => {
    const { offers } = await setupOffers(1);
    const raw = offers[0]!.url.split('/o/')[1]!;
    await acceptOffer(env, raw);
    const again = await acceptOffer(env, raw);
    expect(again.alreadyYours).toBe(true);
    const appts = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM appointments WHERE source='gap_fill'`).first<{ n: number }>();
    expect(appts!.n).toBe(1);
  });

  it('rejects an expired offer', async () => {
    const { offers } = await setupOffers(1);
    const raw = offers[0]!.url.split('/o/')[1]!;
    await env.DB.prepare(`UPDATE gap_offers SET expires_at=? WHERE id=?`)
      .bind(now() - 60, offers[0]!.offer_id).run();
    await expect(acceptOffer(env, raw)).rejects.toThrow(/expired/i);
  });

  it('does not re-offer to a client inside the cooldown window', async () => {
    const { gap } = await setupOffers(2);
    const ranked = await rankCandidates(env, op, gap);
    expect(ranked.length).toBe(0);
  });
});

/**
 * THE WAY OUT, which sms_consent used to be and which had to be replaced along
 * with it. A customer who is offered spare hours has to be able to stop being
 * offered them, and the only place that can happen now is the link at the
 * bottom of the email — there is no keyword to reply to and no carrier to
 * honour one.
 */
describe('stopping the offers', () => {
  beforeEach(async () => { await seed(); });

  async function offerOnce() {
    const nine = futureLocal(9);
    await addAppt(nine, nine + 3600, 34.0522, -118.2437);
    await addAppt(nine + 6 * 3600, nine + 7 * 3600, 34.0548, -118.2378);
    await addClient({ id: 'c0', name: 'C0', lat: 34.0538, lng: -118.2408, dueDaysAgo: 10 });
    await detectGaps(env, op, nine, 1);
    const gap = await openGap();
    const ranked = await rankCandidates(env, op, gap);
    const { sent } = await captureBulkEmail(
      env, () => createOffers(env, op, gap, ranked.slice(0, 1)));
    return { gap, sent };
  }

  it('takes them out of the ranking from the link in the email', async () => {
    const { sent } = await offerOnce();
    const link = /\/a\/stop-offers\/(\S+)/.exec(sent[0]!.text)?.[1];
    expect(link).toBeTruthy();

    expect(await stopOffersByToken(env, link!)).toBe(true);
    const row = await env.DB.prepare(
      `SELECT opted_out_at FROM clients WHERE id='c0'`,
    ).first<{ opted_out_at: number | null }>();
    expect(row!.opted_out_at).not.toBeNull();

    // Past the cooldown they would be a candidate again; opted out they never
    // are, which is the whole job of the link.
    await env.DB.prepare(`UPDATE clients SET last_offered_at=NULL WHERE id='c0'`).run();
    const ranked = await rankCandidates(env, op, await openGap());
    expect(ranked.map((c) => c.client_id)).not.toContain('c0');
  });

  it('refuses a token that was not derived from the pepper', async () => {
    await offerOnce();
    // The client id on its own, a digest of the wrong thing, and rubbish.
    expect(await stopOffersByToken(env, 'c0')).toBe(false);
    expect(await stopOffersByToken(env, `c0.${'a'.repeat(64)}`)).toBe(false);
    expect(await stopOffersByToken(env, '')).toBe(false);
    expect(await stopOffersByToken(env, '.')).toBe(false);

    const row = await env.DB.prepare(
      `SELECT opted_out_at FROM clients WHERE id='c0'`,
    ).first<{ opted_out_at: number | null }>();
    expect(row!.opted_out_at).toBeNull();
  });

  it('stores nothing that could be turned back into a stop link', async () => {
    await offerOnce();
    const token = await offerStopToken(env, 'c0');
    const dump = JSON.stringify(
      (await env.DB.prepare(`SELECT * FROM clients WHERE id='c0'`).first<any>()));
    // The link is worked out from the row and the pepper, exactly like the
    // watch unsubscribe in lib/alerts.ts, so a read-only copy of this table is
    // not a working set of them.
    expect(dump).not.toContain(token.split('.')[1]);
  });
});

describe('timezone handling', () => {
  it('keeps 09:00 local at 09:00 across a DST boundary', () => {
    // 2027-03-14 is the US spring-forward date.
    const before = fromLocal(TZ, 2027, 3, 13, 9 * 60);
    const after = fromLocal(TZ, 2027, 3, 15, 9 * 60);
    expect(toLocal(before, TZ).minuteOfDay).toBe(540);
    expect(toLocal(after, TZ).minuteOfDay).toBe(540);
    // 47 hours of real time, not 48 — the clock lost an hour in between.
    expect(after - before).toBe(47 * 3600);
  });

  it('round-trips local wall clock through epoch', () => {
    for (const [m, d] of [[1, 15], [6, 15], [10, 30], [12, 25]] as const) {
      const e = fromLocal(TZ, 2027, m, d, 14 * 60 + 30);
      const p = toLocal(e, TZ);
      expect(p.minuteOfDay).toBe(14 * 60 + 30);
      expect(p.day).toBe(d);
    }
  });
});

describe('phone normalisation', () => {
  it('normalises US numbers and rejects rubbish', () => {
    expect(toE164('(818) 555-0123', 'US')).toBe('+18185550123');
    expect(toE164('1-818-555-0123', 'US')).toBe('+18185550123');
    expect(toE164('+1 818 555 0123', 'US')).toBe('+18185550123');
    expect(toE164('12345', 'US')).toBeNull();
    expect(toE164('not a phone', 'US')).toBeNull();
  });
});

describe('late labels are measured from the due date, not the last visit', () => {
  it('never calls a client late when they are not yet due', () => {
    expect(lateLabel(-5)).toBe('due in 5 days');
    expect(lateLabel(-1)).toBe('due tomorrow');
    expect(lateLabel(0)).toBe('due today');
  });

  it('reads in days under a fortnight and whole weeks beyond', () => {
    expect(lateLabel(9)).toBe('9 days late');
    expect(lateLabel(13)).toBe('13 days late');
    expect(lateLabel(14)).toBe('2 weeks late');
    expect(lateLabel(19)).toBe('2 weeks late');
    expect(lateLabel(23)).toBe('3 weeks late');
    expect(lateLabel(31)).toBe('4 weeks late');
  });

  it('never overstates: the weeks shown are always fully elapsed', () => {
    for (let d = 14; d < 200; d++) {
      const weeks = Number(lateLabel(d).split(' ')[0]);
      expect(weeks * 7).toBeLessThanOrEqual(d);
      expect((weeks + 1) * 7).toBeGreaterThan(d);
    }
  });

  it('says so plainly when a client has no repeat cadence at all', async () => {
    await seed();
    const nine = futureLocal(9);
    await addAppt(nine, nine + 3600, 34.0522, -118.2437);
    await addAppt(nine + 6 * 3600, nine + 7 * 3600, 34.0548, -118.2378);
    // No default_service_id, so no cadence, so no due date.
    await env.DB.prepare(
      `INSERT INTO clients (id,operator_id,first_name,phone_e164,lat,lng,
         acquired,platform_introduced,created_at,updated_at)
       VALUES ('nocad',?,'Owen',NULL,34.0538,-118.2408,'public',1,?,?)`,
    ).bind(op.id, now(), now()).run();
    await makeReachable(env, { operator_id: op.id, client_id: 'nocad', guest_name: 'Owen' });
    await detectGaps(env, op, nine, 1);
    const ranked = await rankCandidates(env, op, await openGap());
    const owen = ranked.find((c) => c.client_id === 'nocad');
    expect(owen).toBeTruthy();
    expect(owen!.overdue_days).toBeNull();
    expect(owen!.reasons).toContain('no repeat set');
    expect(owen!.reasons.join(' ')).not.toMatch(/late|overdue/);
  });
});

describe('the customer is written to in their own language, not the country default', () => {
  it('picks the client language over the operator language', () => {
    expect(pickLang('es', 'en')).toBe('es');
    expect(pickLang(null, 'en')).toBe('en');
    expect(pickLang(null, null)).toBe('en');
    expect(pickLang('fr', 'en')).toBe('en');   // unsupported falls back, never guesses
  });

  it('writes a Spanish offer for a Spanish-speaking client of an English operator', () => {
    const op: any = {
      business_name: 'Ash Detailing', timezone: 'America/Phoenix',
      country: 'US', currency: 'USD', language: 'en', discount_percent: 0,
    };
    const gap: any = { starts_at: Date.UTC(2026, 8, 3, 17) / 1000 };
    const base = {
      first_name: 'Rosa', duration_seconds: 7200, price_cents: 6500,
      title: 'Detallado completo',
    };

    const es = buildMessage(op, { ...base, language: 'es' } as any, gap, 'https://x.test/o/a');
    expect(es).toContain('Hola Rosa');
    expect(es).toContain('Se me desocupó un horario');
    expect(es).toContain('https://x.test/o/a');

    const en = buildMessage(op, { ...base, first_name: 'Dan', language: null } as any, gap, 'https://x.test/o/b');
    expect(en).toContain('Hi Dan');
    expect(en).toContain('https://x.test/o/b');

    // NEITHER OF THEM MENTIONS A TEXT MESSAGE OR A KEYWORD. This lands in a
    // chat bubble and in an inbox; "Reply STOP" there is an instruction to a
    // carrier that never sees it, which is worse than saying nothing because
    // somebody will try it and believe they have opted out.
    for (const line of [es, en]) {
      expect(line).not.toMatch(/\bSTOP\b|\bPARE\b/);
    }
  });

  it('prices in the operator country currency regardless of the client language', () => {
    const op: any = {
      business_name: 'Ash', timezone: 'America/Phoenix', country: 'US',
      currency: 'USD', language: 'en', discount_percent: 0,
    };
    const gap: any = { starts_at: Date.UTC(2026, 8, 3, 17) / 1000 };
    const msg = buildMessage(op, {
      first_name: 'Rosa', duration_seconds: 7200, price_cents: 6500,
      title: 'Detallado', language: 'es',
    } as any, gap, 'https://x.test/o/a');
    // Spanish words, US dollars — not pesos, not pounds.
    expect(msg).toContain('Hola');
    expect(msg).toMatch(/\$\s?65/);
  });

  // Read by nothing today — the inbound webhook went with the carrier account
  // and offers carry a link instead of a keyword — and kept for the day
  // anything inbound exists again. See the note above STOP_WORDS.
  it('still knows Spanish and English opt-out words alike', () => {
    for (const w of ['STOP', 'PARE', 'CANCELAR', 'BAJA', 'UNSUBSCRIBE']) {
      expect(STOP_WORDS.has(w), w).toBe(true);
    }
    for (const w of ['START', 'ALTA', 'SI']) {
      expect(START_WORDS.has(w), w).toBe(true);
    }
  });
});
