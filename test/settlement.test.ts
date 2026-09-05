import { describe, expect, it } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import type { Env } from '../src/types';
import { placeOrder } from '../src/lib/orders';
import { cancelByCustomer, cancelByOperator, markArrived } from '../src/lib/bypass';
import {
  answerWork, confirmArrival, flag, flagSummary, pendingQuestion, settleExpiredHolds,
} from '../src/lib/settlement';
import { saveOperatorCard } from '../src/lib/standing';
import { saveVehicle, verifyStartCode } from '../src/lib/startcode';
import { newId, now } from '../src/lib/util';

/**
 * Money that waits, and the one question that decides where it goes.
 *
 * The scheme these tests exist to defeat: an operator stands on the doorstep
 * and says "cancel it in the app and pay me cash". Before this, the platform
 * refunded instantly and everybody won except the platform.
 *
 * The defence is not detection -- an operator about to do a cash job turns
 * location off first. It is that the operator has to TRUST the customer. If
 * they do the work for cash and the customer then says "no, they left", the
 * customer keeps the discount and the refund, and the operator has worked for
 * nothing and owes the fee. The tests below are mostly about making sure that
 * asymmetry actually holds in the data.
 */

const MIGRATIONS = ALL_MIGRATIONS;
let env: Env;

const OP = 'op-set';
const PREV = { lat: 34.1500, lng: -118.4490 };
const NEXT = { lat: 34.1520, lng: -118.4400 };
const NEAR = { lat: 34.1510, lng: -118.4450 };

const BUYER = {
  guest_name: 'Rosa', phone: '(818) 555-0142',
  address_line: '15200 Ventura Blvd', postcode: '91403',
};

const one = async <T>(sql: string, ...args: unknown[]) =>
  env.DB.prepare(sql).bind(...args).first<T>();

async function seed(hoursOut = 30) {
  env = makeEnv(MIGRATIONS) as unknown as Env;
  const n = now();

  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,trade,timezone,country,currency,language,
       location_mode,fill_model,sms_mode,max_detour_seconds,min_gap_seconds,buffer_seconds,
       offer_ttl_seconds,offers_per_wave,min_notice_seconds,reoffer_cooldown_seconds,
       discount_percent,plan,accept_public_bookings,deposit_cents,share_location,
       created_at,updated_at)
     VALUES (?,?,?, 'mobile car wash and detailing','America/Los_Angeles','US','USD','en','mobile','both',
       'device',3600,3600,900,5400,3,3600,604800,0,'active',1,0,1,?,?)`,
  ).bind(OP, 'o@x.com', 'Valley Detailing', n, n).run();

  await saveOperatorCard(env, OP, { ref: 'pm_test', brand: 'visa', last4: '4242' });
  await saveVehicle(env, OP, {
    make: 'Ford', model: 'Transit', color: 'White', plate: '8ABC123',
  });

  await env.DB.prepare(
    `INSERT INTO services (id,operator_id,name,duration_seconds,price_cents,created_at,updated_at)
     VALUES ('s1',?, 'Full detail',3600,20000,?,?)`,
  ).bind(OP, n, n).run();

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

  const order = await placeOrder(env, {
    ...BUYER, items: [{ gap_id: gapId, service_ids: ['s1'] }],
  });
  return { n, itemId: order.items[0]!.order_item_id, token: order.thread_token };
}

const settlement = (id: string) =>
  one<{ settlement: string; refund_cents: number | null; hold_until: number | null }>(
    `SELECT settlement, refund_cents, hold_until FROM order_items WHERE id = ?`, id);

// ---------------------------------------------------------------------------

describe('nothing settles the moment somebody cancels', () => {
  it('freezes both sides when the operator cancels', async () => {
    const { itemId } = await seed(30);
    await cancelByOperator(env, OP, itemId);

    const row = await settlement(itemId);
    expect(row!.settlement).toBe('held');
    expect(row!.hold_until).toBeGreaterThan(now());
  });

  it('freezes the customer side too', async () => {
    // The other direction: cancel for a full refund and have them come anyway
    // for cash. It cannot be answered until the original slot has passed.
    const { itemId, token } = await seed(72);
    await cancelByCustomer(env, token, itemId);
    expect((await settlement(itemId))!.settlement).toBe('held');
  });

  it('does not hold the money for a week when the answer arrives sooner', async () => {
    // Seven days is the ceiling, not the wait. Somebody cancelling a job two
    // days out should not be waiting a week for their own money.
    const { itemId, token } = await seed(30);
    await cancelByCustomer(env, token, itemId);
    const row = await settlement(itemId);
    expect(row!.hold_until! - now()).toBeLessThan(7 * 24 * 3600);
  });
});

describe('the one question', () => {
  it('is asked only when the operator cancelled', async () => {
    const { itemId, token } = await seed(30);
    expect(await pendingQuestion(env, token)).toBeNull();

    await cancelByOperator(env, OP, itemId);
    const q = await pendingQuestion(env, token);
    expect(q).not.toBeNull();
    expect(q!.order_item_id).toBe(itemId);
  });

  it('refunds them when they say the operator left', async () => {
    const { itemId, token } = await seed(30);
    await cancelByOperator(env, OP, itemId);

    const res = await answerWork(env, token, itemId, 'not_done');
    expect(res.settlement).toBe('released');
    expect(res.refund_cents).toBe(20000);
  });

  it('keeps the money and waives the fee when they say the work happened', async () => {
    const { itemId, token } = await seed(30);
    await cancelByOperator(env, OP, itemId);

    const res = await answerWork(env, token, itemId, 'done');
    expect(res.settlement).toBe('withheld');
    expect(res.refund_cents).toBe(0);

    // The work was done, so somebody has to be paid for it and the fee does
    // not apply. Waived rather than deleted: the record that this happened is
    // worth keeping even when nothing is charged.
    const fee = await one<{ status: string }>(
      `SELECT status FROM lead_fees WHERE order_item_id = ?`, itemId);
    expect(fee!.status).toBe('waived');
  });

  it('cannot be answered twice', async () => {
    const { itemId, token } = await seed(30);
    await cancelByOperator(env, OP, itemId);
    await answerWork(env, token, itemId, 'not_done');
    await expect(answerWork(env, token, itemId, 'done'))
      .rejects.toThrow(/already settled/i);
  });

  it('cannot be answered by somebody else\'s link', async () => {
    const { itemId } = await seed(30);
    await cancelByOperator(env, OP, itemId);
    await expect(answerWork(env, 'not-a-token', itemId, 'not_done'))
      .rejects.toThrow(/not valid/i);
  });

  it('leaves the operator unable to rely on the answer', async () => {
    // The whole deterrent, stated as a test. An operator who does the job for
    // cash is betting the customer will not simply claim the refund -- and
    // nothing stops them, which is exactly the point.
    const { itemId, token } = await seed(30);
    await markArrived(env, OP, itemId);
    await cancelByOperator(env, OP, itemId);

    const res = await answerWork(env, token, itemId, 'not_done');
    expect(res.refund_cents).toBe(20000);            // customer made whole
    const fee = await one<{ status: string; cents: number }>(
      `SELECT status, cents FROM lead_fees WHERE order_item_id = ?`, itemId);
    expect(fee!.status).toBe('owed');                 // and the operator pays
    expect(fee!.cents).toBe(20000);                   // the whole job, on arrival
  });
});

describe('when nobody answers', () => {
  it('keeps the money, charges nobody, and flags it', async () => {
    // Chosen so no pair of people can profit by agreeing to say nothing: the
    // customer does not get refunded and the operator does not get paid.
    const { itemId } = await seed(30);
    await cancelByOperator(env, OP, itemId);
    await env.DB.prepare(`UPDATE order_items SET hold_until = ? WHERE id = ?`)
      .bind(now() - 1, itemId).run();

    expect(await settleExpiredHolds(env)).toBe(1);

    const row = await settlement(itemId);
    expect(row!.settlement).toBe('withheld');
    expect(row!.refund_cents).toBe(0);

    const flagged = await one<{ kind: string }>(
      `SELECT kind FROM bypass_flags WHERE order_item_id = ?`, itemId);
    expect(flagged!.kind).toBe('silence');
  });

  it('releases a customer cancellation when no van ever turned up', async () => {
    const { itemId, token } = await seed(72);
    await cancelByCustomer(env, token, itemId);
    await env.DB.prepare(`UPDATE order_items SET hold_until = ? WHERE id = ?`)
      .bind(now() - 1, itemId).run();

    await settleExpiredHolds(env);
    const row = await settlement(itemId);
    expect(row!.settlement).toBe('released');
    expect(row!.refund_cents).toBe(20000);
  });

  it('withholds a customer cancellation when the van showed up anyway', async () => {
    const { itemId, token } = await seed(72);
    await cancelByCustomer(env, token, itemId);
    await flag(env, OP, itemId, 'visit_after', 'Van was at the address.');
    await env.DB.prepare(`UPDATE order_items SET hold_until = ? WHERE id = ?`)
      .bind(now() - 1, itemId).run();

    await settleExpiredHolds(env);
    expect((await settlement(itemId))!.settlement).toBe('withheld');
  });

  it('settles a held row once and leaves it alone after', async () => {
    const { itemId } = await seed(30);
    await cancelByOperator(env, OP, itemId);
    await env.DB.prepare(`UPDATE order_items SET hold_until = ? WHERE id = ?`)
      .bind(now() - 1, itemId).run();

    await settleExpiredHolds(env);
    expect(await settleExpiredHolds(env)).toBe(0);
  });
});

describe('both sides mark arrival', () => {
  it('records the customer confirming, and only once', async () => {
    const { itemId, token } = await seed(30);
    await markArrived(env, OP, itemId);

    const first = await confirmArrival(env, token, itemId);
    const again = await confirmArrival(env, token, itemId);
    expect(again.arrival_confirmed_at).toBe(first.arrival_confirmed_at);
  });

  it('raises the strongest flag when they confirmed and the operator then walked', async () => {
    // Two people with opposite incentives both saying somebody was at the
    // door, followed by that person cancelling the job.
    const { itemId, token } = await seed(30);
    await markArrived(env, OP, itemId);
    await confirmArrival(env, token, itemId);
    await cancelByOperator(env, OP, itemId);

    const flagged = await one<{ kind: string }>(
      `SELECT kind FROM bypass_flags WHERE order_item_id = ?`, itemId);
    expect(flagged!.kind).toBe('confirmed_then_cancelled');
  });
});

describe('the start code', () => {
  const codeFor = async (itemId: string) =>
    (await one<{ start_code: string }>(
      `SELECT start_code FROM order_items WHERE id = ?`, itemId))!.start_code;

  it('is four digits and exists from the moment the booking does', async () => {
    const { itemId } = await seed(30);
    expect(await codeFor(itemId)).toMatch(/^\d{4}$/);
  });

  it('starts the job, and records arrival from both sides at once', async () => {
    // Typing a code the customer just read out is a stronger arrival record
    // than either side's button, so it sets both.
    const { itemId } = await seed(30);
    await verifyStartCode(env, OP, itemId, await codeFor(itemId));

    const row = await one<{
      code_verified_at: number | null; arrived_at: number | null;
      arrival_confirmed_at: number | null;
    }>(`SELECT code_verified_at, arrived_at, arrival_confirmed_at
          FROM order_items WHERE id = ?`, itemId);
    expect(row!.code_verified_at).not.toBeNull();
    expect(row!.arrived_at).not.toBeNull();
    expect(row!.arrival_confirmed_at).not.toBeNull();
  });

  it('refuses the wrong code and says how many tries are left', async () => {
    const { itemId } = await seed(30);
    const right = await codeFor(itemId);
    const wrong = right === '0000' ? '1111' : '0000';
    await expect(verifyStartCode(env, OP, itemId, wrong)).rejects.toThrow(/tries left/i);
  });

  it('stops accepting guesses after five', async () => {
    const { itemId } = await seed(30);
    const right = await codeFor(itemId);
    const wrong = right === '0000' ? '1111' : '0000';
    for (let i = 0; i < 5; i += 1) {
      await expect(verifyStartCode(env, OP, itemId, wrong)).rejects.toThrow();
    }
    // Even the correct code stops working: a run of failures means the wrong
    // booking is open or somebody is trying numbers, and both want a human.
    await expect(verifyStartCode(env, OP, itemId, right))
      .rejects.toThrow(/too many wrong codes/i);
  });

  it('is not another business\'s to use', async () => {
    const { itemId } = await seed(30);
    await expect(verifyStartCode(env, 'someone-else', itemId, await codeFor(itemId)))
      .rejects.toThrow(/not yours/i);
  });

  it('raises the strongest flag of all when the code was used and then cancelled', async () => {
    // To have typed that code they stood next to the customer and read it off
    // their phone. Cancelling afterwards says the job never happened, which
    // cannot also be true of work that was actually done.
    const { itemId } = await seed(30);
    await verifyStartCode(env, OP, itemId, await codeFor(itemId));
    await cancelByOperator(env, OP, itemId);

    const flagged = await one<{ kind: string; detail: string }>(
      `SELECT kind, detail FROM bypass_flags WHERE order_item_id = ?`, itemId);
    expect(flagged!.kind).toBe('confirmed_then_cancelled');
    expect(flagged!.detail).toMatch(/start code/i);
  });

  it('flags a doorstep cancellation made with location switched off', async () => {
    const { itemId } = await seed(30);
    await markArrived(env, OP, itemId);
    await env.DB.prepare(`UPDATE operators SET share_location = 0 WHERE id = ?`)
      .bind(OP).run();
    await cancelByOperator(env, OP, itemId);

    const flagged = await one<{ kind: string }>(
      `SELECT kind FROM bypass_flags WHERE order_item_id = ?`, itemId);
    expect(flagged!.kind).toBe('location_dark');
  });

  it('does not confirm arrival on a cancelled booking', async () => {
    const { itemId, token } = await seed(30);
    await cancelByOperator(env, OP, itemId);
    await expect(confirmArrival(env, token, itemId)).rejects.toThrow(/not on your order/i);
  });
});

describe('flags are observations, not verdicts', () => {
  it('records one of each kind per booking however many times it is seen', async () => {
    const { itemId } = await seed(30);
    await flag(env, OP, itemId, 'dwell', 'first');
    await flag(env, OP, itemId, 'dwell', 'second');
    const n = await one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM bypass_flags WHERE order_item_id = ?`, itemId);
    expect(n!.n).toBe(1);
  });

  it('reports a rate rather than a count', async () => {
    // A busy operator collects the odd flag honestly. Judging on raw counts
    // punishes them for being busy, which is the opposite of the intent.
    const { itemId } = await seed(30);
    await flag(env, OP, itemId, 'dwell', 'x');
    const s = await flagSummary(env, OP);
    expect(s.jobs).toBe(1);
    expect(s.flags).toBe(1);
    expect(s.rate).toBe(1);
  });

  it('never suspends anybody on its own', async () => {
    const { itemId } = await seed(30);
    for (const kind of ['dwell', 'location_dark', 'silence'] as const) {
      await flag(env, OP, itemId, kind, 'x');
    }
    const op = await one<{ suspended_until: number | null; banned_at: number | null }>(
      `SELECT suspended_until, banned_at FROM operators WHERE id = ?`, OP);
    expect(op!.suspended_until).toBeNull();
    expect(op!.banned_at).toBeNull();
  });
});
