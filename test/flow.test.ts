import { describe, expect, it, beforeEach } from 'vitest';
import { makeEnv } from './d1';
import type { Env, Operator } from '../src/types';
import { detectGaps } from '../src/lib/gaps';
import { lateLabel, rankCandidates, type GapRow } from '../src/lib/rank';
import { acceptOffer, createOffers } from '../src/lib/offers';
import { fromLocal, toLocal, localDayStart } from '../src/lib/tz';
import { pickLang, STOP_WORDS, START_WORDS } from '../src/lib/messages';
import { buildMessage } from '../src/lib/offers';
import { newId, now, toE164 } from '../src/lib/util';

const MIGRATION = [
  new URL('../migrations/0001_init.sql', import.meta.url).pathname,
  new URL('../migrations/0005_language.sql', import.meta.url).pathname,
];
const TZ = 'Europe/London';

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
    id, 'a@x.com', 'Shine Mobile', TZ, 'GB', 'GBP',
    opts.location_mode ?? 'mobile', opts.fill_model ?? 'both', 'device',
    51.5074, -0.1278,
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

async function addClient(o: {
  id: string; name: string; phone: string; lat?: number; lng?: number;
  dueDaysAgo?: number; consent?: boolean; service?: string; noShows?: number;
}) {
  const t = now();
  await env.DB.prepare(
    `INSERT INTO clients (id,operator_id,first_name,phone_e164,lat,lng,geocode_status,
       default_service_id,last_serviced_at,next_due_at,no_show_count,sms_consent,sms_consent_at,
       created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    o.id, op.id, o.name, o.phone, o.lat ?? null, o.lng ?? null,
    o.lat != null ? 'ok' : 'failed',
    o.service ?? 'sv_detail', null,
    o.dueDaysAgo != null ? now() - o.dueDaysAgo * 86400 : null,
    o.noShows ?? 0,
    o.consent === false ? 0 : 1, o.consent === false ? null : t, t, t,
  ).run();
}

async function openGap(): Promise<GapRow> {
  const rows = await env.DB.prepare(
    `SELECT * FROM gaps WHERE operator_id=? AND status IN ('open','offering') ORDER BY starts_at`,
  ).bind(op.id).all<GapRow>();
  return rows.results![0]!;
}

describe('gap detection', () => {
  beforeEach(async () => { await seed(); });

  it('finds the hole between two jobs, with buffers applied', async () => {
    const nine = futureLocal(9);
    await addAppt(nine, nine + 3600, 51.50, -0.12);              // 09:00–10:00
    await addAppt(nine + 6 * 3600, nine + 7 * 3600, 51.52, -0.10); // 15:00–16:00

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
    expect(mid!.prev_lat).toBeCloseTo(51.50, 4);
    expect(mid!.next_lat).toBeCloseTo(51.52, 4);
    expect(mid!.baseline_drive_seconds).toBeGreaterThan(0);
  });

  it('ignores holes shorter than min_gap_seconds', async () => {
    const nine = futureLocal(9);
    await addAppt(nine, nine + 3600, 51.5, -0.12);
    await addAppt(nine + 4600, nine + 8200, 51.5, -0.12);   // only ~17 min apart
    await detectGaps(env, op, nine, 1);
    const gaps = await env.DB.prepare(
      `SELECT * FROM gaps WHERE operator_id=? AND starts_at > ? AND ends_at < ?`,
    ).bind(op.id, nine + 3600, nine + 4600).all();
    expect(gaps.results!.length).toBe(0);
  });

  it('is idempotent — re-running does not duplicate gaps', async () => {
    const nine = futureLocal(9);
    await addAppt(nine, nine + 3600, 51.5, -0.12);
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
    await addAppt(nine, nine + 3600, 51.5074, -0.1278);
    await addAppt(nine + 6 * 3600, nine + 7 * 3600, 51.5100, -0.1200);
    await addClient({ id: 'near', name: 'Nina', phone: '+447700900001', lat: 51.5090, lng: -0.1240, dueDaysAgo: 10 });
    await addClient({ id: 'far', name: 'Fred', phone: '+447700900002', lat: 51.7000, lng: -0.4000, dueDaysAgo: 40 });

    await detectGaps(env, op, nine, 1);
    const gap = await openGap();
    const ranked = await rankCandidates(env, op, gap);

    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0]!.client_id).toBe('near');
    // Fred is more overdue but too far — proximity is weighted heavier on purpose.
    const fred = ranked.find((c) => c.client_id === 'far');
    if (fred) expect(fred.score).toBeLessThan(ranked[0]!.score);
  });

  it('excludes clients without consent, opted out, or already booked', async () => {
    const nine = futureLocal(9);
    await addAppt(nine, nine + 3600, 51.5074, -0.1278);
    await addAppt(nine + 6 * 3600, nine + 7 * 3600, 51.5100, -0.1200);

    await addClient({ id: 'ok', name: 'Ok', phone: '+447700900010', lat: 51.509, lng: -0.124, dueDaysAgo: 5 });
    await addClient({ id: 'noconsent', name: 'No', phone: '+447700900011', lat: 51.509, lng: -0.124, dueDaysAgo: 5, consent: false });
    await addClient({ id: 'optout', name: 'Out', phone: '+447700900012', lat: 51.509, lng: -0.124, dueDaysAgo: 5 });
    await env.DB.prepare(`UPDATE clients SET opted_out_at=? WHERE id='optout'`).bind(now()).run();
    await addClient({ id: 'booked', name: 'Booked', phone: '+447700900013', lat: 51.509, lng: -0.124, dueDaysAgo: 5 });
    await addAppt(nine + 30 * 86400, nine + 30 * 86400 + 3600, 51.509, -0.124, 'booked');

    await detectGaps(env, op, nine, 1);
    const ranked = await rankCandidates(env, op, await openGap());
    const ids = ranked.map((c) => c.client_id);
    expect(ids).toContain('ok');
    expect(ids).not.toContain('noconsent');
    expect(ids).not.toContain('optout');
    expect(ids).not.toContain('booked');
  });

  it('drops candidates whose job plus travel will not fit the gap', async () => {
    const nine = futureLocal(9);
    await addAppt(nine, nine + 3600, 51.5074, -0.1278);
    await addAppt(nine + 3600 + 900 + 5400 + 900, nine + 3600 + 900 + 5400 + 1800, 51.5074, -0.1278);
    await addClient({ id: 'toolong', name: 'Long', phone: '+447700900020', lat: 51.5074, lng: -0.1278, dueDaysAgo: 5 });
    await detectGaps(env, op, nine, 1);
    const gap = await openGap();
    const ranked = await rankCandidates(env, op, gap);
    // Full detail is 7200s; the hole is 5400s. It cannot fit.
    expect(ranked.find((c) => c.client_id === 'toolong')).toBeUndefined();
  });

  it('surfaces open job leads for break-fix trades', async () => {
    const nine = futureLocal(9);
    await addAppt(nine, nine + 3600, 51.5074, -0.1278);
    await addAppt(nine + 6 * 3600, nine + 7 * 3600, 51.5100, -0.1200);
    await addClient({ id: 'lead_client', name: 'Priya', phone: '+447700900030', lat: 51.509, lng: -0.124 });

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
    await addAppt(nine, nine + 3600, 51.5074, -0.1278);
    await addAppt(nine + 6 * 3600, nine + 7 * 3600, 51.5100, -0.1200);
    await addClient({ id: 'lc', name: 'Sam', phone: '+447700900031', lat: 51.509, lng: -0.124 });
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
    await addAppt(nine, nine + 3600, 51.5074, -0.1278);
    await addAppt(nine + 6 * 3600, nine + 7 * 3600, 51.51, -0.12);
    await addClient({ id: 'a', name: 'A', phone: '+447700900040', lat: 51.509, lng: -0.124, dueDaysAgo: 2 });
    await addClient({ id: 'b', name: 'B', phone: '+447700900041', lat: 55.9, lng: -3.2, dueDaysAgo: 60 });

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
    await addAppt(nine, nine + 3600, 51.5074, -0.1278);
    await addAppt(nine + 6 * 3600, nine + 7 * 3600, 51.5100, -0.1200);
    for (let i = 0; i < count; i++) {
      await addClient({
        id: `c${i}`, name: `C${i}`, phone: `+44770090010${i}`,
        lat: 51.509 + i * 0.001, lng: -0.124, dueDaysAgo: 10 - i,
      });
    }
    await detectGaps(env, op, nine, 1);
    const gap = await openGap();
    const ranked = await rankCandidates(env, op, gap);
    const offers = await createOffers(env, op, gap, ranked.slice(0, count));
    return { gap, offers };
  }

  it('creates offers, marks the gap offering, and logs a message each', async () => {
    const { gap, offers } = await setupOffers(2);
    expect(offers.length).toBe(2);
    expect(offers[0]!.send.ios).toMatch(/^sms:\+44/);
    expect(offers[0]!.message).toContain('Reply STOP');
    expect(offers[0]!.url).toContain('/o/');

    const g = await env.DB.prepare(`SELECT status FROM gaps WHERE id=?`).bind(gap.id).first<any>();
    expect(g.status).toBe('offering');
    const msgs = await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages`).first<{ n: number }>();
    expect(msgs!.n).toBe(2);
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

describe('timezone handling', () => {
  it('keeps 09:00 local at 09:00 across a DST boundary', () => {
    // 2027-03-28 is the UK spring-forward date.
    const before = fromLocal(TZ, 2027, 3, 27, 9 * 60);
    const after = fromLocal(TZ, 2027, 3, 29, 9 * 60);
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
  it('normalises UK numbers and rejects rubbish', () => {
    expect(toE164('07700 900123', 'GB')).toBe('+447700900123');
    expect(toE164('+44 7700 900123', 'GB')).toBe('+447700900123');
    expect(toE164('(555) 010-1234', 'US')).toBe('+15550101234');
    expect(toE164('12345', 'GB')).toBeNull();
    expect(toE164('not a phone', 'GB')).toBeNull();
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
    await addAppt(nine, nine + 3600, 51.5074, -0.1278);
    await addAppt(nine + 6 * 3600, nine + 7 * 3600, 51.51, -0.12);
    // No default_service_id, so no cadence, so no due date.
    await env.DB.prepare(
      `INSERT INTO clients (id,operator_id,first_name,phone_e164,lat,lng,sms_consent,sms_consent_at,created_at,updated_at)
       VALUES ('nocad',?,'Owen','+447700900500',51.509,-0.124,1,?,?,?)`,
    ).bind(op.id, now(), now(), now()).run();
    await detectGaps(env, op, nine, 1);
    const ranked = await rankCandidates(env, op, await openGap());
    const owen = ranked.find((c) => c.client_id === 'nocad');
    expect(owen).toBeTruthy();
    expect(owen!.overdue_days).toBeNull();
    expect(owen!.reasons).toContain('no repeat set');
    expect(owen!.reasons.join(' ')).not.toMatch(/late|overdue/);
  });
});

describe('the customer is texted in their own language, not the country default', () => {
  it('picks the client language over the operator language', () => {
    expect(pickLang('es', 'en')).toBe('es');
    expect(pickLang(null, 'en')).toBe('en');
    expect(pickLang(null, null)).toBe('en');
    expect(pickLang('fr', 'en')).toBe('en');   // unsupported falls back, never guesses
  });

  it('writes a Spanish SMS for a Spanish-speaking client of an English operator', () => {
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
    expect(es).toContain('PARE');
    expect(es).not.toContain('Reply STOP to opt out.');

    const en = buildMessage(op, { ...base, first_name: 'Dan', language: null } as any, gap, 'https://x.test/o/b');
    expect(en).toContain('Hi Dan');
    expect(en).toContain('Reply STOP');
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

  it('honours Spanish and English opt-out words alike', () => {
    for (const w of ['STOP', 'PARE', 'CANCELAR', 'BAJA', 'UNSUBSCRIBE']) {
      expect(STOP_WORDS.has(w), w).toBe(true);
    }
    for (const w of ['START', 'ALTA', 'SI']) {
      expect(START_WORDS.has(w), w).toBe(true);
    }
  });
});
