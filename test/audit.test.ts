import { describe, expect, it } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import type { Env } from '../src/types';
import { placeOrder, priceOrder } from '../src/lib/orders';
import { claimSlot, slotsNear } from '../src/lib/public';
import {
  DOORSTEP_WINDOW_SECONDS, LEAD_FEE_MIN_CENTS, NO_REFUND_SECONDS,
  cancelByCustomer, cancelByOperator, leadFeeCents, markArrived, refundFor,
} from '../src/lib/bypass';
import { answerWork, confirmArrival, settleExpiredHolds } from '../src/lib/settlement';
import { decideQuote, sendQuote } from '../src/lib/parts';
import {
  confirmNoShow, customerStanding, operatorStanding, reportNoShow, saveOperatorCard,
} from '../src/lib/standing';
import { saveVehicle, verifyStartCode } from '../src/lib/startcode';
import { acceptOffer, createOffers } from '../src/lib/offers';
import { mayEchoSignInLink } from '../src/lib/email';
import { newId, now } from '../src/lib/util';

/**
 * The audit: money that could come out wrong, and guards that did not guard.
 *
 * Every test here is written against a specific defect and fails on the code
 * as it was. They are grouped by the thing that could go wrong rather than by
 * the file it lives in, because several of these are the same mistake made in
 * two places -- a guarded first statement followed by unguarded ones in the
 * same batch, or a read and a write that are two round trips apart.
 */

const MIGRATIONS = ALL_MIGRATIONS;
let env: Env;

const OP = 'op-audit';
const PREV = { lat: 34.1500, lng: -118.4490 };
const NEXT = { lat: 34.1520, lng: -118.4400 };
const NEAR = { lat: 34.1510, lng: -118.4450 };

const BUYER = {
  guest_name: 'Rosa', phone: '(818) 555-0142',
  address_line: '15200 Ventura Blvd', postcode: '91403',
};

const one = async <T>(sql: string, ...args: unknown[]) =>
  env.DB.prepare(sql).bind(...args).first<T>();

/**
 * One operator, one $200 service, one open gap `hoursOut` hours from now.
 *
 * Deliberately not shared with the other suites: these tests move prices,
 * standings and gap restrictions around, and a fixture that other files also
 * depend on is a fixture nobody can change.
 */
async function seed(opts: { hoursOut?: number; priceCents?: number } = {}) {
  const hoursOut = opts.hoursOut ?? 30;
  env = makeEnv(MIGRATIONS) as unknown as Env;
  const n = now();

  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,trade,timezone,country,currency,language,
       location_mode,fill_model,sms_mode,max_detour_seconds,min_gap_seconds,buffer_seconds,
       offer_ttl_seconds,offers_per_wave,min_notice_seconds,reoffer_cooldown_seconds,
       discount_percent,plan,accept_public_bookings,deposit_cents,share_location,
       is_published,created_at,updated_at)
     VALUES (?,?,?, 'mobile car wash and detailing','America/Los_Angeles','US','USD','en',
       'mobile','both','device',3600,3600,900,5400,3,3600,604800,0,'active',1,0,1,1,?,?)`,
  ).bind(OP, 'o@x.com', 'Valley Detailing', n, n).run();

  await saveOperatorCard(env, OP, { ref: 'pm_test', brand: 'visa', last4: '4242' });
  await saveVehicle(env, OP, {
    make: 'Ford', model: 'Transit', color: 'White', plate: '8ABC123',
  });

  await env.DB.prepare(
    `INSERT INTO services (id,operator_id,name,duration_seconds,price_cents,created_at,updated_at)
     VALUES ('s1',?, 'Full detail',3600,?,?,?)`,
  ).bind(OP, opts.priceCents ?? 20000, n, n).run();

  await env.DB.prepare(
    `INSERT INTO service_areas (id,operator_id,name,slug,place_slug,lat,lng,radius_meters,
       created_at,updated_at)
     VALUES (?,?,'Sherman Oaks','sherman-oaks','sherman-oaks',?,?,8000,?,?)`,
  ).bind(newId(), OP, PREV.lat, PREV.lng, n, n).run();

  await env.DB.prepare(
    `INSERT INTO postal_codes (country_code,postal_code,place_name,lat,lng,accuracy)
     VALUES ('US','91403','Sherman Oaks',?,?,6)`,
  ).bind(NEAR.lat, NEAR.lng).run();

  const gapId = newId();
  await env.DB.prepare(
    `INSERT INTO gaps (id,operator_id,starts_at,ends_at,prev_lat,prev_lng,next_lat,next_lng,
       baseline_drive_seconds,is_mobile,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,180,1,'open',?,?)`,
  ).bind(gapId, OP, n + hoursOut * 3600, n + (hoursOut + 5) * 3600,
    PREV.lat, PREV.lng, NEXT.lat, NEXT.lng, n, n).run();

  return { n, gapId };
}

async function book(gapId: string) {
  const order = await placeOrder(env, {
    ...BUYER, items: [{ gap_id: gapId, service_ids: ['s1'] }],
  });
  return { itemId: order.items[0]!.order_item_id, token: order.thread_token };
}


/**
 * Runs `interfere` in the window between one read and the write that follows it.
 *
 * Racing two calls with Promise.all only proves whatever the microtask queue
 * happened to do that run. These defects are all the same shape -- a row is
 * read, a decision is made from it, and the write lands on a later round trip
 * -- so the window is opened deliberately: the next statement whose SQL
 * matches gets its result back, and something else commits before the caller
 * can act on it. Returns a function that puts the database back.
 */
function interfereAfterRead(match: string, interfere: () => void) {
  const db = env.DB as any;
  const realPrepare = db.prepare.bind(db);
  let fired = false;
  db.prepare = (sql: string) => {
    const stmt = realPrepare(sql);
    if (fired || !sql.includes(match)) return stmt;
    const realBind = stmt.bind.bind(stmt);
    stmt.bind = (...args: unknown[]) => {
      const bound = realBind(...args);
      const realFirst = bound.first.bind(bound);
      bound.first = () => {
        const row = realFirst();
        if (!fired) { fired = true; interfere(); }
        return row;
      };
      return bound;
    };
    return stmt;
  };
  return () => { db.prepare = realPrepare; };
}

const run = (sql: string, ...args: unknown[]) =>
  (env.DB as any).prepare(sql).bind(...args).run();

// ---------------------------------------------------------------------------
// The ladder, at the boundaries themselves rather than near them
// ---------------------------------------------------------------------------

describe('the fee ladder at its exact boundaries', () => {
  const JOB = 20000;
  const item = (untilStart: number, arrived: number | null = null) => ({
    starts_at: now() + untilStart,
    price_cents: JOB,
    created_at: now() - 86400,
    arrived_at: arrived,
  });

  it('splits the job exactly at 48 hours', () => {
    // Exactly on the line, not a second either side of it. 48h counts as
    // inside: three quarters back, a quarter owed, and they sum to the job.
    const at = now();
    const r = refundFor(item(DOORSTEP_WINDOW_SECONDS), at);
    expect(r.percent).toBe(75);
    expect(r.cents + leadFeeCents(JOB, 'cancelled_late')).toBe(JOB);
  });

  it('splits the job exactly at 12 hours', () => {
    const at = now();
    const r = refundFor(item(NO_REFUND_SECONDS), at);
    expect(r.percent).toBe(25);
    expect(r.cents + leadFeeCents(JOB, 'cancelled_last_hours')).toBe(JOB);
  });

  it('refunds everything one second outside 48 hours', () => {
    expect(refundFor(item(DOORSTEP_WINDOW_SECONDS + 1), now()).percent).toBe(100);
  });

  it('never refunds more than was paid, at any rung', () => {
    for (const until of [-1, 0, 1, NO_REFUND_SECONDS, NO_REFUND_SECONDS + 1,
      DOORSTEP_WINDOW_SECONDS, DOORSTEP_WINDOW_SECONDS + 1, 30 * 86400]) {
      const r = refundFor(item(until), now());
      expect(r.cents).toBeGreaterThanOrEqual(0);
      expect(r.cents).toBeLessThanOrEqual(JOB);
    }
  });

  it('charges nothing for cancelling a job with no price', () => {
    // The floor used to apply here, so a service given away cost $15 to
    // cancel: a charge with no job behind it at all.
    for (const reason of
      ['cancelled_late', 'cancelled_last_hours', 'cancelled_on_arrival'] as const) {
      expect(leadFeeCents(0, reason)).toBe(0);
    }
  });

  it('never charges more than the whole job, floor or not', () => {
    // A $10 job on the top rung is $10, not the $15 the floor would make of
    // it. 'Owes all of it' is the top of the ladder; nothing is above it.
    const cheap = 10_00;
    expect(cheap).toBeLessThan(LEAD_FEE_MIN_CENTS);
    for (const reason of
      ['cancelled_late', 'cancelled_last_hours', 'cancelled_on_arrival'] as const) {
      expect(leadFeeCents(cheap, reason)).toBe(cheap);
    }
    // And the floor still does its job on anything above it.
    expect(leadFeeCents(20000, 'cancelled_late')).toBe(5000);
    expect(leadFeeCents(100_00, 'cancelled_late')).toBe(LEAD_FEE_MIN_CENTS + 10_00);
  });

  it('keeps a booking made ten minutes before it starts out of the grace window', async () => {
    // Grace is for the wrong-day mistake, which costs the operator nothing
    // because they have not moved. Ten minutes out, they have.
    const at = now();
    const r = refundFor(
      { starts_at: at + 600, price_cents: JOB, created_at: at - 60, arrived_at: null }, at);
    expect(r.reason).not.toBe('grace');
    expect(r.percent).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// Two round trips where one decision was meant
// ---------------------------------------------------------------------------

describe('a cancellation that did not happen never reports a refund', () => {
  it('refuses the operator\'s second cancel instead of returning a second refund', async () => {
    const { gapId } = await seed({ hoursOut: 30 });
    const { itemId } = await book(gapId);

    // The other tab's cancellation commits while this one is still holding the
    // row it read. Its own guarded UPDATE then matches nothing -- and the
    // change count was never looked at, so it returned a full RefundDecision
    // for a cancellation that did not happen. The payment seam pays out
    // against exactly this return value, so that is one booking refunded twice.
    const restore = interfereAfterRead('FROM order_items oi JOIN orders o', () => {
      // Five seconds ago, because that is what the other tab winning looks
      // like and it keeps the two cancellations distinguishable by timestamp.
      run(`UPDATE order_items SET cancelled_at=?, cancelled_by='operator',
             refund_cents=? WHERE id=?`, now() - 5, 20000, itemId);
    });

    await expect(cancelByOperator(env, OP, itemId))
      .rejects.toThrow(/already cancelled/i);
    restore();

    // And no fee, because no cancellation was made here to charge for.
    const fees = await one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM lead_fees WHERE order_item_id = ?`, itemId);
    expect(fees!.n).toBe(0);
  });

  it('refuses the customer\'s second cancel the same way', async () => {
    const { gapId } = await seed({ hoursOut: 72 });
    const { itemId, token } = await book(gapId);

    const restore = interfereAfterRead('FROM order_items oi JOIN orders o', () => {
      run(`UPDATE order_items SET cancelled_at=?, cancelled_by='customer',
             refund_cents=? WHERE id=?`, now() - 5, 20000, itemId);
    });

    await expect(cancelByCustomer(env, token, itemId))
      .rejects.toThrow(/already cancelled/i);
    restore();
  });

  it('does not double the parts total when approve is tapped twice', async () => {
    const { gapId } = await seed({ hoursOut: 4 });
    const { itemId, token } = await book(gapId);

    const quote = await sendQuote(env, OP, {
      order_item_id: itemId, description: 'Alternator', parts_cents: 24000,
    });

    // The first tap lands in full -- status flipped, parts added -- while the
    // second is still holding the row it read as 'sent'. The status flip was
    // guarded, and the two `parts_cents = parts_cents + ?` statements that
    // followed it in the same batch were not; a D1 batch is a transaction and
    // a transaction commits whatever its statements matched, so the losing tap
    // added the parts a second time and then said "already answered".
    const restore = interfereAfterRead('FROM parts_quotes WHERE id = ?', () => {
      run(`UPDATE parts_quotes SET status='approved', decided_at=? WHERE id=?`,
        now(), quote.id);
      run(`UPDATE order_items SET parts_cents = parts_cents + ? WHERE id = ?`, 24000, itemId);
      run(`UPDATE orders SET parts_cents = parts_cents + ? WHERE id =
             (SELECT order_id FROM order_items WHERE id = ?)`, 24000, itemId);
    });

    await expect(decideQuote(env, token, quote.id, 'approved'))
      .rejects.toThrow(/already answered/i);
    restore();

    const item = await one<{ parts_cents: number }>(
      `SELECT parts_cents FROM order_items WHERE id = ?`, itemId);
    expect(item!.parts_cents).toBe(24000);

    const order = await one<{ parts_cents: number }>(
      `SELECT o.parts_cents FROM orders o
         JOIN order_items oi ON oi.order_id = o.id WHERE oi.id = ?`, itemId);
    expect(order!.parts_cents).toBe(24000);

    // One decision, one line in the transcript.
    const said = await one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM chat_messages WHERE body LIKE 'Approved:%'`);
    expect(said!.n).toBe(0);
  });

  it('cannot stamp a start code onto a booking cancelled underneath it', async () => {
    const { gapId } = await seed({ hoursOut: 2 });
    const { itemId } = await book(gapId);
    const code = (await one<{ start_code: string }>(
      `SELECT start_code FROM order_items WHERE id = ?`, itemId))!.start_code;

    // verifyStartCode reads the row, finds it live, and writes on a LATER
    // round trip. A cancellation landing in that window used to produce the
    // one combination this system treats as proof of a doorstep bypass: a job
    // cancelled with the customer's own code recorded against it.
    const restore = interfereAfterRead('start_code, code_verified_at', () => {
      run(`UPDATE order_items SET cancelled_at=?, cancelled_by='operator' WHERE id=?`,
        now(), itemId);
    });

    await expect(verifyStartCode(env, OP, itemId, code)).rejects.toThrow(/cancelled/i);
    restore();

    const row = await one<{ cancelled_at: number | null; code_verified_at: number | null }>(
      `SELECT cancelled_at, code_verified_at FROM order_items WHERE id = ?`, itemId);
    expect(row!.cancelled_at).not.toBeNull();
    expect(row!.code_verified_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Money on a booking that no longer exists
// ---------------------------------------------------------------------------

describe('a cancelled booking cannot be charged for', () => {
  it('refuses a quote raised against it', async () => {
    const { gapId } = await seed({ hoursOut: 30 });
    const { itemId } = await book(gapId);
    await cancelByOperator(env, OP, itemId);

    await expect(sendQuote(env, OP, {
      order_item_id: itemId, description: 'Alternator', parts_cents: 24000,
    })).rejects.toThrow(/cancelled/i);
  });

  it('refuses approval of a quote sent before the cancellation', async () => {
    const { gapId } = await seed({ hoursOut: 30 });
    const { itemId, token } = await book(gapId);
    const quote = await sendQuote(env, OP, {
      order_item_id: itemId, description: 'Alternator', parts_cents: 24000,
    });

    await cancelByOperator(env, OP, itemId);

    await expect(decideQuote(env, token, quote.id, 'approved'))
      .rejects.toThrow(/cancelled/i);
    const item = await one<{ parts_cents: number }>(
      `SELECT parts_cents FROM order_items WHERE id = ?`, itemId);
    expect(item!.parts_cents).toBe(0);

    // Declining a stale quote is still allowed: closing one is always safe.
    const closed = await decideQuote(env, token, quote.id, 'declined');
    expect(closed.status).toBe('declined');
  });
});

// ---------------------------------------------------------------------------
// Silence
// ---------------------------------------------------------------------------

describe('nobody profits from nobody answering', () => {
  it('waives the fee when the hold expires unanswered', async () => {
    // Withheld means the money stays with the operator, exactly as an answer
    // of 'done' does. The fee used to be left owed on top of that, so the
    // operator was billed for cancelling a job they were simultaneously being
    // paid for -- and the platform was the only party that gained from
    // silence, keeping the customer's money AND collecting the fee.
    const { gapId } = await seed({ hoursOut: 30 });
    const { itemId } = await book(gapId);
    await cancelByOperator(env, OP, itemId);

    const owed = await one<{ status: string }>(
      `SELECT status FROM lead_fees WHERE order_item_id = ?`, itemId);
    expect(owed!.status).toBe('owed');

    await env.DB.prepare(`UPDATE order_items SET hold_until = ? WHERE id = ?`)
      .bind(now() - 1, itemId).run();
    await settleExpiredHolds(env);

    const row = await one<{ settlement: string; refund_cents: number }>(
      `SELECT settlement, refund_cents FROM order_items WHERE id = ?`, itemId);
    expect(row!.settlement).toBe('withheld');
    expect(row!.refund_cents).toBe(0);

    const fee = await one<{ status: string }>(
      `SELECT status FROM lead_fees WHERE order_item_id = ?`, itemId);
    expect(fee!.status).toBe('waived');
  });

  it('still charges the fee when the customer says the operator left', async () => {
    // The other half of the same rule, unchanged: an answer costs somebody.
    const { gapId } = await seed({ hoursOut: 30 });
    const { itemId, token } = await book(gapId);
    await markArrived(env, OP, itemId);
    await cancelByOperator(env, OP, itemId);

    await answerWork(env, token, itemId, 'not_done');
    const fee = await one<{ status: string; cents: number }>(
      `SELECT status, cents FROM lead_fees WHERE order_item_id = ?`, itemId);
    expect(fee!.status).toBe('owed');
    expect(fee!.cents).toBe(20000);
  });
});

// ---------------------------------------------------------------------------
// The no-JavaScript booking form
// ---------------------------------------------------------------------------

describe('the single-slot claim path holds the same lines as checkout', () => {
  it('sells only a service the operator allowed in that opening', async () => {
    const { n, gapId } = await seed({ hoursOut: 30 });
    // A cheap service the operator restricted this opening to, alongside the
    // dearer one. The claim query picked purely by price and ignored the
    // restriction, so the opening advertised as a wash sold as a full detail.
    await env.DB.prepare(
      `INSERT INTO services (id,operator_id,name,duration_seconds,price_cents,
         created_at,updated_at)
       VALUES ('s-wash',?, 'Quick wash',1800,4000,?,?)`,
    ).bind(OP, n, n).run();
    await env.DB.prepare(
      `INSERT INTO gap_services (id, gap_id, service_id, created_at) VALUES (?,?, 's-wash', ?)`,
    ).bind(newId(), gapId, n).run();

    const { slot } = await claimSlot(env, {
      gapId, first_name: 'Rosa', phone: '(818) 555-0142', postcode: '91403',
    });
    expect(slot.service_id).toBe('s-wash');
    expect(slot.price_cents).toBe(4000);
  });

  it('refuses a suspended customer', async () => {
    const { gapId } = await seed({ hoursOut: 30 });
    const t = now();
    await env.DB.prepare(
      `INSERT INTO customer_standing
         (phone_e164,no_show_strikes,suspended_until,banned_at,created_at,updated_at)
       VALUES ('+18185550142',1,?,NULL,?,?)`,
    ).bind(t + 3 * 86400, t, t).run();

    expect((await customerStanding(env, '+18185550142')).blocked).toBe(true);
    // Checkout already refused this. The no-JavaScript form did not, which
    // made it simply the way round the whole suspension ladder.
    await expect(claimSlot(env, {
      gapId, first_name: 'Rosa', phone: '(818) 555-0142', postcode: '91403',
    })).rejects.toThrow(/cannot book/i);
  });
});

// ---------------------------------------------------------------------------
// A suspension that suspends
// ---------------------------------------------------------------------------

describe('a suspended business stops being sold', () => {
  it('drops their openings off the public listing and out of a basket', async () => {
    const { gapId } = await seed({ hoursOut: 30 });
    expect(await slotsNear(env, NEAR, 'sherman-oaks')).toHaveLength(1);

    await env.DB.prepare(`UPDATE operators SET suspended_until = ? WHERE id = ?`)
      .bind(now() + 3 * 86400, OP).run();

    // listingBlock stops them POSTING an opening. Openings already up stayed
    // on the map and stayed bookable, which made the ladder a suggestion.
    expect(await slotsNear(env, NEAR, 'sherman-oaks')).toHaveLength(0);

    const priced = await priceOrder(env, [{ gap_id: gapId, service_ids: ['s1'] }]);
    expect(priced.ok).toBe(false);
    expect(priced.items[0]!.problems[0]!.code).toBe('slot_gone');

    await expect(claimSlot(env, {
      gapId, first_name: 'Rosa', phone: '(818) 555-0142', postcode: '91403',
    })).rejects.toThrow(/no longer listed/i);
  });

  it('leaves work already booked alone', async () => {
    // The promise every message in listingBlock makes out loud.
    const { gapId } = await seed({ hoursOut: 30 });
    const { itemId } = await book(gapId);
    await env.DB.prepare(`UPDATE operators SET suspended_until = ? WHERE id = ?`)
      .bind(now() + 3 * 86400, OP).run();

    const row = await one<{ cancelled_at: number | null }>(
      `SELECT cancelled_at FROM order_items WHERE id = ?`, itemId);
    expect(row!.cancelled_at).toBeNull();
  });
});

describe('the ban ladder only ever goes up', () => {
  async function reportable() {
    const { gapId } = await seed({ hoursOut: 30 });
    const { itemId } = await book(gapId);
    // The appointment has to be over before anybody can be reported for it.
    await env.DB.prepare(
      `UPDATE order_items SET starts_at = ?, ends_at = ? WHERE id = ?`,
    ).bind(now() - 7200, now() - 3600, itemId).run();
    return itemId;
  }

  it('does not lift a ban when an older report is upheld', async () => {
    const itemId = await reportable();
    const { id } = await reportNoShow(env, 'customer',
      { order_item_id: itemId, against: 'operator' });

    const bannedAt = now() - 86400;
    await env.DB.prepare(`UPDATE operators SET banned_at = ? WHERE id = ?`)
      .bind(bannedAt, OP).run();

    // A first strike writes a three-day suspension. It used to assign
    // banned_at = NULL alongside it, so deciding an unrelated report let a
    // banned business straight back onto the site.
    await confirmNoShow(env, id, 'upheld');

    const standing = await operatorStanding(env, OP);
    expect(standing.banned_at).toBe(bannedAt);
    expect(standing.blocked).toBe(true);
  });

  it('does not shorten a longer suspension already in force', async () => {
    const itemId = await reportable();
    const { id } = await reportNoShow(env, 'customer',
      { order_item_id: itemId, against: 'operator' });

    const longer = now() + 30 * 86400;
    await env.DB.prepare(`UPDATE operators SET suspended_until = ? WHERE id = ?`)
      .bind(longer, OP).run();

    await confirmNoShow(env, id, 'upheld');   // strike one: three days
    expect((await operatorStanding(env, OP)).suspended_until).toBe(longer);
  });
});

// ---------------------------------------------------------------------------
// An offer accepted against an opening that is gone
// ---------------------------------------------------------------------------

describe('an invited offer cannot book an opening that has been withdrawn', () => {
  it('refuses, and writes no appointment', async () => {
    const { n } = await seed({ hoursOut: 30 });
    const op = (await one<any>(`SELECT * FROM operators WHERE id = ?`, OP))!;

    const clientId = newId();
    await env.DB.prepare(
      `INSERT INTO clients (id,operator_id,first_name,phone_e164,lat,lng,
         default_service_id,geocode_status,created_at,updated_at)
       VALUES (?,?,'Dee','+18185550188',?,?,'s1','ok',?,?)`,
    ).bind(clientId, OP, NEAR.lat, NEAR.lng, n, n).run();

    const gap = (await one<any>(
      `SELECT id, starts_at, ends_at, prev_lat, prev_lng, next_lat, next_lng,
              baseline_drive_seconds, is_mobile, status
         FROM gaps WHERE operator_id = ?`, OP))!;

    // The candidate is built by hand rather than ranked, because what is
    // under test is what accepting does, not who gets asked.
    const offers = await createOffers(env, op, gap, [{
      kind: 'client', client_id: clientId, lead_id: null, service_id: 's1',
      first_name: 'Dee', phone_e164: '+18185550188', language: 'en',
      lat: NEAR.lat, lng: NEAR.lng, duration_seconds: 3600, price_cents: 20000,
      title: 'Full detail', overdue_days: 10, urgency: null,
      drive_in_seconds: 300, drive_out_seconds: 300, detour_seconds: 420,
      score: 0.9, reasons: ['nearby'],
    }]);
    expect(offers).toHaveLength(1);
    const raw = offers[0]!.url.split('/o/')[1]!;

    // The operator withdrew the opening -- or a detection pass expired it --
    // between the offer going out and the customer tapping. Only 'filled' was
    // checked, so 'expired' sailed through and booked an appointment on an
    // hour the calendar no longer had free.
    await env.DB.prepare(`UPDATE gaps SET status = 'expired' WHERE id = ?`)
      .bind(gap.id).run();

    await expect(acceptOffer(env, raw)).rejects.toThrow(/just been taken/i);
    const appts = await one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM appointments WHERE source = 'gap_fill'`);
    expect(appts!.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// What leaves the Worker
// ---------------------------------------------------------------------------

describe('the previous customer\'s address does not leave the building', () => {
  it('publishes the anchor on a ~1 km grid, not the house it came from', async () => {
    await seed({ hoursOut: 30 });
    // A real front door, to seven decimals, exactly as the geocoder would
    // have written it onto the previous customer's appointment.
    const HOUSE = { lat: 34.1487213, lng: -118.4461907 };
    await env.DB.prepare(`UPDATE gaps SET prev_lat = ?, prev_lng = ? WHERE operator_id = ?`)
      .bind(HOUSE.lat, HOUSE.lng, OP).run();

    const [slot] = await slotsNear(env, NEAR, 'sherman-oaks');

    expect(slot!.anchor_lat).not.toBe(HOUSE.lat);
    expect(slot!.anchor_lng).not.toBe(HOUSE.lng);
    // Two decimals: 0.01 degrees is about 1109 m of latitude and 924 m of
    // longitude at 34 N, so the published point is a neighbourhood and the
    // rounding is exact rather than merely fuzzy.
    expect(slot!.anchor_lat).toBe(Math.round(HOUSE.lat * 100) / 100);
    expect(slot!.anchor_lng).toBe(Math.round(HOUSE.lng * 100) / 100);
  });

  it('still measures the detour against the real coordinates', async () => {
    // The feature the anchor exists for has to survive the coarsening, and it
    // does because nothing that measures a distance reads the published copy.
    await seed({ hoursOut: 30 });
    const [slot] = await slotsNear(env, NEAR, 'sherman-oaks');
    expect(slot!.detour_minutes).not.toBeNull();
    expect(slot!.proximity).toBeTruthy();
  });
});

describe('the sign-in debug echo', () => {
  const base = {
    APP_URL: 'http://localhost:8788',
    AUTH_DEBUG_TOKEN: 'a-long-enough-debug-token',
  } as unknown as Env;

  it('accepts the right token and refuses everything else', () => {
    expect(mayEchoSignInLink(base, 'a-long-enough-debug-token')).toBe(true);
    expect(mayEchoSignInLink(base, 'a-long-enough-debug-tokeX')).toBe(false);
    // A prefix of the secret: the comparison must not answer faster for this
    // one than for a string that differs in the first byte.
    expect(mayEchoSignInLink(base, 'a-long-enough-debug-toke')).toBe(false);
    expect(mayEchoSignInLink(base, null)).toBe(false);
    expect(mayEchoSignInLink(
      { ...base, APP_URL: 'https://slotfill.workers.dev' } as unknown as Env,
      'a-long-enough-debug-token')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Answering about somebody else's booking
// ---------------------------------------------------------------------------

describe('a guest link answers only about its own order', () => {
  it('does not confirm arrival on an item from another order', async () => {
    const { gapId, n } = await seed({ hoursOut: 30 });
    const mine = await book(gapId);

    const otherGap = newId();
    await env.DB.prepare(
      `INSERT INTO gaps (id,operator_id,starts_at,ends_at,prev_lat,prev_lng,next_lat,next_lng,
         baseline_drive_seconds,is_mobile,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,180,1,'open',?,?)`,
    ).bind(otherGap, OP, n + 50 * 3600, n + 55 * 3600,
      PREV.lat, PREV.lng, NEXT.lat, NEXT.lng, n, n).run();
    const theirs = await placeOrder(env, {
      guest_name: 'Sam', phone: '(818) 555-0199',
      address_line: '15201 Ventura Blvd', postcode: '91403',
      items: [{ gap_id: otherGap, service_ids: ['s1'] }],
    });
    const theirItem = theirs.items[0]!.order_item_id;

    // Already confirmed on their booking. The fallback read was scoped by id
    // alone, so somebody else's link got a success and a timestamp back --
    // a fact about a stranger's appointment.
    await confirmArrival(env, theirs.thread_token, theirItem);

    await expect(confirmArrival(env, mine.token, theirItem))
      .rejects.toThrow(/not on your order/i);
  });
});
