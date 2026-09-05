import { describe, expect, it } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import type { Env } from '../src/types';
import { placeOrder } from '../src/lib/orders';
import {
  cleanPartsFields, decideQuote, partsLine, quotableItems, quotesForGuest,
  quotesForOperator, sendQuote, withdrawQuote, expireQuotes,
} from '../src/lib/parts';
import {
  cancelByCustomer, cancelByOperator, feesOwed, leadFeeCents, listingBlock, markArrived,
  refundFor,
} from '../src/lib/bypass';
import {
  confirmNoShow, customerStanding, operatorStanding, reportNoShow, saveOperatorCard,
} from '../src/lib/standing';
import { saveVehicle, verifyStartCode } from '../src/lib/startcode';
import { postAsGuest, postAsOperator, threadByToken } from '../src/lib/chat';
import { maskClientRow, maskPhone, redactContact } from '../src/lib/redact';
import { newId, now } from '../src/lib/util';

/**
 * Parts, the doorstep bypass, and keeping contact details from crossing.
 *
 * These three ship together because they are one promise seen from three
 * sides: the customer is never charged anything they did not approve, the
 * operator cannot deliver the job and then take it off the platform, and
 * neither side walks away with the other's phone number.
 *
 * The tests that matter most here are the ones about money moving twice.
 * Everything else in this file is a guard rail; those are the feature.
 */

const MIGRATIONS = ALL_MIGRATIONS;

let env: Env;

const MECHANIC = 'op-mech';
const PREV = { lat: 34.1500, lng: -118.4490 };
const NEXT = { lat: 34.1520, lng: -118.4400 };
const NEAR = { lat: 34.1510, lng: -118.4450 };

const BUYER = {
  guest_name: 'Rosa',
  phone: '(818) 555-0142',
  address_line: '15200 Ventura Blvd',
  postcode: '91403',
};

const one = async <T>(sql: string, ...args: unknown[]) =>
  env.DB.prepare(sql).bind(...args).first<T>();

async function seed(opts: { startsInSeconds?: number } = {}) {
  env = makeEnv(MIGRATIONS) as unknown as Env;
  const n = now();

  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,timezone,country,currency,language,
       location_mode,fill_model,sms_mode,max_detour_seconds,min_gap_seconds,buffer_seconds,
       offer_ttl_seconds,offers_per_wave,min_notice_seconds,reoffer_cooldown_seconds,
       discount_percent,plan,accept_public_bookings,deposit_cents,share_location,
       created_at,updated_at)
     VALUES (?,?,?, 'America/Los_Angeles','US','USD','en','mobile','both','device',
       3600,3600,900,5400,3,3600,604800,0,'active',1,0,1,?,?)`,
  ).bind(MECHANIC, 'm@x.com', 'Rosa Mobile Auto', n, n).run();

  // A card on file, because nothing can be listed without one. The value is
  // the processor's reference -- there is no card number anywhere in this
  // codebase, tests included.
  await saveOperatorCard(env, MECHANIC, { ref: 'pm_test_ref', brand: 'visa', last4: '4242' });

  // A van, because an operator cannot list without one: it is what a customer
  // checks before opening the door to somebody they have never met.
  await saveVehicle(env, MECHANIC, {
    make: 'Ford', model: 'Transit', color: 'White', plate: '8ABC123',
  });

  // One service of each policy, because the whole point is that a single price
  // list holds all three: this mechanic carries oil and filters, and cannot
  // price a brake job before they see the car.
  for (const [id, name, secs, cents, policy, note, low, high] of [
    ['s-diag', 'Check-engine diagnosis', 3600, 12000, 'quoted',
      "Covers the diagnosis and the labour. I'll send you the part price before I fit anything.",
      6000, 40000],
    ['s-oil', 'Oil change', 1800, 8000, 'included', 'Oil and filter included.', null, null],
    ['s-wash', 'Wash', 1800, 4000, 'none', null, null, null],
  ] as const) {
    await env.DB.prepare(
      `INSERT INTO services (id,operator_id,name,duration_seconds,price_cents,
         parts_policy,parts_note,parts_estimate_low_cents,parts_estimate_high_cents,
         created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(id, MECHANIC, name, secs, cents, policy, note, low, high, n, n).run();
  }

  await env.DB.prepare(
    `INSERT INTO postal_codes (country_code,postal_code,place_name,lat,lng,accuracy)
     VALUES ('US','91403','Sherman Oaks',?,?,6)`,
  ).bind(NEAR.lat, NEAR.lng).run();

  const gapId = newId();
  const offset = opts.startsInSeconds ?? 30 * 3600;
  await env.DB.prepare(
    `INSERT INTO gaps (id,operator_id,starts_at,ends_at,prev_lat,prev_lng,next_lat,next_lng,
       baseline_drive_seconds,is_mobile,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,180,1,'open',?,?)`,
  ).bind(gapId, MECHANIC, n + offset, n + offset + 5 * 3600,
    PREV.lat, PREV.lng, NEXT.lat, NEXT.lng, n, n).run();

  return { n, gapId };
}

/** Books the diagnosis and hands back the item id and the customer's link. */
async function book(gapId: string, serviceIds = ['s-diag']) {
  const order = await placeOrder(env, {
    ...BUYER, items: [{ gap_id: gapId, service_ids: serviceIds }],
  });
  return {
    order,
    itemId: order.items[0]!.order_item_id,
    token: order.thread_token,
  };
}

// ---------------------------------------------------------------------------

describe('the parts policy on a service', () => {
  it('defaults an unrecognised policy to the one that promises least', () => {
    // 'none' is the safe fallback on purpose: a malformed request must never
    // be able to attach "your bill may go up" to a car wash.
    expect(cleanPartsFields({ parts_policy: 'sometimes' }).parts_policy).toBe('none');
    expect(cleanPartsFields({}).parts_policy).toBe('none');
  });

  it('keeps a range only when both ends are given, and puts them in order', () => {
    const both = cleanPartsFields({
      parts_policy: 'quoted', parts_estimate_low_cents: 40000, parts_estimate_high_cents: 6000,
    });
    expect([both.parts_estimate_low_cents, both.parts_estimate_high_cents]).toEqual([6000, 40000]);

    const half = cleanPartsFields({ parts_policy: 'quoted', parts_estimate_low_cents: 6000 });
    expect(half.parts_estimate_low_cents).toBeNull();
    expect(half.parts_estimate_high_cents).toBeNull();
  });

  it('drops an estimate from a service that has nothing to estimate', () => {
    const f = cleanPartsFields({
      parts_policy: 'none', parts_estimate_low_cents: 6000, parts_estimate_high_cents: 40000,
    });
    expect(f.parts_estimate_low_cents).toBeNull();
  });
});

describe('what the customer is told about parts', () => {
  it('says nothing at all when there are no parts', () => {
    expect(partsLine({
      parts_policy: 'none', parts_estimate_low_cents: null, parts_estimate_high_cents: null,
    }, 'USD')).toBeNull();
  });

  it('says parts are covered when they are', () => {
    expect(partsLine({
      parts_policy: 'included', parts_estimate_low_cents: null, parts_estimate_high_cents: null,
    }, 'USD')).toMatch(/included/i);
  });

  it('promises approval, not merely that parts cost extra', () => {
    const line = partsLine({
      parts_policy: 'quoted', parts_estimate_low_cents: 6000, parts_estimate_high_cents: 40000,
    }, 'USD')!;
    // The whole difference between this product and every shop sign that says
    // "parts extra" is this sentence.
    expect(line).toMatch(/approve/i);
    expect(line).toContain('$60.00');
    expect(line).toContain('$400.00');
  });
});

describe('a booked job carries its parts promise', () => {
  it('copies the policy onto the receipt rather than reading it live', async () => {
    const { gapId } = await seed();
    const { itemId } = await book(gapId);

    // The operator rewrites the service afterwards. The receipt must not move.
    await env.DB.prepare(
      `UPDATE services SET parts_policy='none', parts_note=NULL WHERE id='s-diag'`).run();

    const row = await one<{ parts_policy: string; parts_note: string }>(
      `SELECT parts_policy, parts_note FROM order_item_services WHERE order_item_id = ?`, itemId);
    expect(row!.parts_policy).toBe('quoted');
    expect(row!.parts_note).toMatch(/before I fit anything/);
  });
});

describe('sending a quote', () => {
  it('refuses a quote with no amount on it', async () => {
    const { gapId } = await seed();
    const { itemId } = await book(gapId);
    await expect(sendQuote(env, MECHANIC, {
      order_item_id: itemId, description: 'nothing', parts_cents: 0, labor_cents: 0,
    })).rejects.toThrow(/needs an amount/i);
  });

  it('refuses a price with no description — nobody can agree to a bare number', async () => {
    const { gapId } = await seed();
    const { itemId } = await book(gapId);
    await expect(sendQuote(env, MECHANIC, {
      order_item_id: itemId, description: '  ', parts_cents: 18000,
    })).rejects.toThrow(/what the parts are/i);
  });

  it('never confirms whether another business booking exists', async () => {
    const { gapId } = await seed();
    const { itemId } = await book(gapId);
    await expect(sendQuote(env, 'someone-else', {
      order_item_id: itemId, description: 'pads', parts_cents: 18000,
    })).rejects.toThrow(/not yours/i);
  });

  it('lands in the conversation, not only in a panel', async () => {
    const { gapId } = await seed();
    const { itemId, token } = await book(gapId);
    await sendQuote(env, MECHANIC, {
      order_item_id: itemId, description: 'Front pads and rotors', parts_cents: 18000,
    });

    const msg = await one<{ body: string; sender: string }>(
      `SELECT body, sender FROM chat_messages ORDER BY rowid DESC LIMIT 1`);
    expect(msg!.sender).toBe('operator');
    expect(msg!.body).toContain('$180.00');
    expect(msg!.body).toMatch(/until you approve/i);

    const thread = await threadByToken(env, token);
    expect(thread!.guest_unread).toBeGreaterThan(0);
  });

  it('replaces a live quote instead of leaving two chargeable numbers out', async () => {
    const { gapId } = await seed();
    const { itemId } = await book(gapId);

    const first = await sendQuote(env, MECHANIC, {
      order_item_id: itemId, description: 'pads', parts_cents: 18000,
    });
    const second = await sendQuote(env, MECHANIC, {
      order_item_id: itemId, description: 'pads and rotors', parts_cents: 24000,
    });

    const all = await quotesForOperator(env, MECHANIC, { order_item_id: itemId });
    expect(all.find((q) => q.id === first.id)!.status).toBe('withdrawn');
    expect(all.find((q) => q.id === second.id)!.status).toBe('sent');
    // Exactly one number is chargeable, always.
    expect(all.filter((q) => q.status === 'sent')).toHaveLength(1);
  });
});

describe('the customer answering it', () => {
  it('adds the approved amount once, however many times they tap', async () => {
    const { gapId } = await seed();
    const { itemId, token, order } = await book(gapId);
    const quote = await sendQuote(env, MECHANIC, {
      order_item_id: itemId, description: 'pads', parts_cents: 18000, labor_cents: 3000,
    });

    await decideQuote(env, token, quote.id, 'approved');
    // The double tap: a phone, on a driveway, on one bar of signal.
    await expect(decideQuote(env, token, quote.id, 'approved'))
      .rejects.toThrow(/already/i);

    const item = await one<{ parts_cents: number }>(
      `SELECT parts_cents FROM order_items WHERE id = ?`, itemId);
    const ord = await one<{ parts_cents: number; total_cents: number }>(
      `SELECT parts_cents, total_cents FROM orders WHERE id = ?`, order.order_id);

    expect(item!.parts_cents).toBe(21000);
    expect(ord!.parts_cents).toBe(21000);
    // The amount agreed at checkout is a separate record and does not move.
    expect(ord!.total_cents).toBe(12000);
  });

  it('adds nothing when they decline', async () => {
    const { gapId } = await seed();
    const { itemId, token } = await book(gapId);
    const quote = await sendQuote(env, MECHANIC, {
      order_item_id: itemId, description: 'pads', parts_cents: 18000,
    });

    await decideQuote(env, token, quote.id, 'declined');
    const item = await one<{ parts_cents: number }>(
      `SELECT parts_cents FROM order_items WHERE id = ?`, itemId);
    expect(item!.parts_cents).toBe(0);
  });

  it('will not let a stranger with any other link approve it', async () => {
    const { gapId } = await seed();
    const { itemId } = await book(gapId);
    const quote = await sendQuote(env, MECHANIC, {
      order_item_id: itemId, description: 'pads', parts_cents: 18000,
    });
    await expect(decideQuote(env, 'not-a-real-token', quote.id, 'approved'))
      .rejects.toThrow(/not valid/i);
  });

  it('refuses a withdrawn quote, and says who withdrew it', async () => {
    const { gapId } = await seed();
    const { itemId, token } = await book(gapId);
    const quote = await sendQuote(env, MECHANIC, {
      order_item_id: itemId, description: 'pads', parts_cents: 18000,
    });
    await withdrawQuote(env, MECHANIC, quote.id);
    await expect(decideQuote(env, token, quote.id, 'approved'))
      .rejects.toThrow(/took that quote back/i);
  });

  it('refuses an expired quote — part prices move', async () => {
    const { gapId } = await seed();
    const { itemId, token } = await book(gapId);
    const quote = await sendQuote(env, MECHANIC, {
      order_item_id: itemId, description: 'pads', parts_cents: 18000,
    });
    await env.DB.prepare(`UPDATE parts_quotes SET expires_at = ? WHERE id = ?`)
      .bind(now() - 1, quote.id).run();

    await expect(decideQuote(env, token, quote.id, 'approved'))
      .rejects.toThrow(/expired/i);
  });

  it('is swept to expired on the cron rather than left chargeable forever', async () => {
    const { gapId } = await seed();
    const { itemId } = await book(gapId);
    const quote = await sendQuote(env, MECHANIC, {
      order_item_id: itemId, description: 'pads', parts_cents: 18000,
    });
    await env.DB.prepare(`UPDATE parts_quotes SET expires_at = ? WHERE id = ?`)
      .bind(now() - 1, quote.id).run();

    expect(await expireQuotes(env)).toBe(1);
    const after = await quotesForOperator(env, MECHANIC);
    expect(after[0]!.status).toBe('expired');
  });

  it('shows the customer their own quotes and their approved total', async () => {
    const { gapId } = await seed();
    const { itemId, token } = await book(gapId);
    const quote = await sendQuote(env, MECHANIC, {
      order_item_id: itemId, description: 'pads', parts_cents: 18000,
    });
    await decideQuote(env, token, quote.id, 'approved');

    const view = await quotesForGuest(env, token);
    expect(view.quotes).toHaveLength(1);
    expect(view.parts_cents).toBe(18000);
  });
});

// ---------------------------------------------------------------------------

describe('the doorstep bypass', () => {
  it('charges a lead fee when they cancel after arriving', async () => {
    // Far enough out that the two-hour rule cannot be what raised the fee.
    const { gapId } = await seed({ startsInSeconds: 40 * 3600 });
    const { itemId } = await book(gapId);

    await markArrived(env, MECHANIC, itemId);
    const res = await cancelByOperator(env, MECHANIC, itemId, 'changed my mind');

    expect(res.fee).not.toBeNull();
    expect(res.fee!.reason).toBe('cancelled_on_arrival');
    // The whole $120. Driving there and walking is the worst version of this,
    // and it is the only thing priced at the full job.
    expect(res.fee!.cents).toBe(12000);
  });

  it('charges nothing when they cancel more than 48 hours out', async () => {
    const { gapId } = await seed({ startsInSeconds: 72 * 3600 });
    const { itemId } = await book(gapId);
    const res = await cancelByOperator(env, MECHANIC, itemId, 'van broke down');
    expect(res.fee).toBeNull();
    // And the slot goes back on the market, because somebody can still take it.
    expect(res.relisted).toBe(true);
  });

  it('charges without an arrival when they leave it to the last hours', async () => {
    const { gapId } = await seed({ startsInSeconds: 30 * 60 });
    const { itemId } = await book(gapId);
    const res = await cancelByOperator(env, MECHANIC, itemId);
    expect(res.fee!.reason).toBe('cancelled_last_hours');
    // Nobody can fill a slot starting in half an hour; advertising it would
    // only waste the next customer's time.
    expect(res.relisted).toBe(false);
  });

  it('never raises two fees for one cancellation', async () => {
    const { gapId } = await seed({ startsInSeconds: 60 * 3600 });
    const { itemId } = await book(gapId);
    await markArrived(env, MECHANIC, itemId);
    await cancelByOperator(env, MECHANIC, itemId);
    await expect(cancelByOperator(env, MECHANIC, itemId))
      .rejects.toThrow(/already cancelled/i);

    const owed = await feesOwed(env, MECHANIC);
    expect(owed.count).toBe(1);
  });

  it('stops the account listing until the fee is settled, and says so plainly', async () => {
    const { gapId } = await seed({ startsInSeconds: 60 * 3600 });
    const { itemId } = await book(gapId);

    expect(await listingBlock(env, MECHANIC)).toBeNull();

    await markArrived(env, MECHANIC, itemId);
    await cancelByOperator(env, MECHANIC, itemId);

    const blocked = await listingBlock(env, MECHANIC);
    expect(blocked).toMatch(/\$120\.00/);   // arrived, so the whole job   // arrived, so the whole job
    // The one thing a blocked operator must not fear: that customers already
    // booked have lost their appointment.
    expect(blocked).toMatch(/already booked is unaffected/i);

    await env.DB.prepare(`UPDATE lead_fees SET status='waived' WHERE operator_id = ?`)
      .bind(MECHANIC).run();
    expect(await listingBlock(env, MECHANIC)).toBeNull();
  });

  it('prices the fee on the same three rungs: a quarter, three quarters, all', () => {
    expect(leadFeeCents(20000, 'cancelled_late')).toBe(5000);
    expect(leadFeeCents(20000, 'cancelled_last_hours')).toBe(15000);
    expect(leadFeeCents(20000, 'cancelled_on_arrival')).toBe(20000);

    // A floor, so a tiny job still costs something to walk away from.
    expect(leadFeeCents(2000, 'cancelled_late')).toBe(1500);

    // No ceiling, deliberately. A cap is a price list for bypassing the
    // platform on exactly the jobs worth bypassing it for.
    expect(leadFeeCents(90000, 'cancelled_on_arrival')).toBe(90000);
  });

  it('climbs a quarter, three quarters, all of it', async () => {
    const a = await seed({ startsInSeconds: 30 * 3600 });
    const early = await book(a.gapId);
    const feeEarly = (await cancelByOperator(env, MECHANIC, early.itemId)).fee!;

    const b = await seed({ startsInSeconds: 3 * 3600 });
    const late = await book(b.gapId);
    const feeLate = (await cancelByOperator(env, MECHANIC, late.itemId)).fee!;

    const c = await seed({ startsInSeconds: 3 * 3600 });
    const door = await book(c.gapId);
    await markArrived(env, MECHANIC, door.itemId);
    const feeDoor = (await cancelByOperator(env, MECHANIC, door.itemId)).fee!;

    // The $120 diagnosis, a quarter / three quarters / all.
    expect(feeEarly.cents).toBe(3000);
    expect(feeLate.cents).toBe(9000);
    expect(feeDoor.cents).toBe(12000);
  });

  it('records arrival once and does not let it be walked forward', async () => {
    const { gapId } = await seed();
    const { itemId } = await book(gapId);
    const first = await markArrived(env, MECHANIC, itemId);
    const second = await markArrived(env, MECHANIC, itemId);
    expect(second).toBe(first);
  });

  it('drops a cancelled job off the list an operator can quote against', async () => {
    const { gapId } = await seed({ startsInSeconds: 72 * 3600 });
    const { itemId } = await book(gapId);
    expect(await quotableItems(env, MECHANIC)).toHaveLength(1);
    await cancelByOperator(env, MECHANIC, itemId);
    expect(await quotableItems(env, MECHANIC)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('contact details never cross', () => {
  it('takes a phone number out of what the customer sends', async () => {
    const { gapId } = await seed();
    const { token } = await book(gapId);

    const msg = await postAsGuest(env, token, 'call me on 310-555-0142 when you set off');
    expect(msg.body).not.toContain('310');
    expect(msg.redacted).toBe(1);
    expect(msg.notice).toMatch(/phone number/i);

    // Stored clean, not cleaned on the way out: a query written without the
    // filter would otherwise undo the whole thing.
    const stored = await one<{ body: string }>(
      `SELECT body FROM chat_messages WHERE id = ?`, msg.id);
    expect(stored!.body).not.toContain('0142');
  });

  it('takes one out of what the business sends, too', async () => {
    const { gapId } = await seed();
    const { token } = await book(gapId);
    const thread = await threadByToken(env, token);

    const msg = await postAsOperator(env, MECHANIC, thread!.id,
      'easier to text me: rosa@rosaauto.com');
    expect(msg.body).not.toContain('@');
    expect(msg.redacted).toBe(1);
  });

  it('blocks the sentence that routes around the fee', async () => {
    const { gapId } = await seed();
    const { token } = await book(gapId);
    const thread = await threadByToken(env, token);
    const msg = await postAsOperator(env, MECHANIC, thread!.id,
      "just venmo me and I'll cancel it in the app");
    expect(msg.body.toLowerCase()).not.toContain('venmo');
  });

  it('counts the attempts on the thread, so a habit and a pattern differ', async () => {
    const { gapId } = await seed();
    const { token } = await book(gapId);

    await postAsGuest(env, token, 'my cell is (818) 555 0199');
    await postAsGuest(env, token, 'and my email is rosa@x.com');
    await postAsGuest(env, token, 'the gate code is 4821, see you at 3:30');

    const thread = await threadByToken(env, token);
    expect(thread!.redacted_count).toBe(2);
  });

  it('leaves ordinary sentences completely alone', () => {
    for (const said of [
      'I will be there at 3:30',
      'the gate code is 4821',
      'it came to $1,250.00 last time',
      'my appointment is on 3/14/2026',
      'unit 12B, buzzer 07',
      'it took about 90 minutes',
    ]) {
      const r = redactContact(said);
      expect(r.redacted, said).toBe(false);
      expect(r.body).toBe(said);
    }
  });

  it('never stores the number on the operator client row in the first place', async () => {
    const { gapId } = await seed();
    await book(gapId);

    // The masking helper still exists as a second line of defence, but this is
    // the assertion that matters: there is nothing in the operator's list to
    // mask. A filter can be forgotten by the next query somebody writes; an
    // empty column cannot.
    const client = await one<{
      phone_e164: string | null; email: string | null; last_name: string | null;
      address_line: string | null; acquired: string; platform_introduced: number;
    }>(`SELECT phone_e164, email, last_name, address_line, acquired,
               platform_introduced FROM clients LIMIT 1`);

    expect(client!.acquired).toBe('public');
    expect(client!.platform_introduced).toBe(1);
    expect(client!.phone_e164).toBeNull();
    expect(client!.email).toBeNull();
    expect(client!.last_name).toBeNull();
    // The address stays. They have to drive there.
    expect(client!.address_line).toBe(BUYER.address_line);
  });

  it('keeps the number on the order, which is the platform\'s record', async () => {
    const { gapId } = await seed();
    await book(gapId);
    const order = await one<{ phone_e164: string }>(`SELECT phone_e164 FROM orders LIMIT 1`);
    expect(order!.phone_e164).toBe('+18185550142');
  });

  it('leaves an operator their own imported client list untouched', () => {
    const mine = { phone_e164: '+18185550199', email: 'a@b.com', last_name: 'Ortiz' };
    expect(maskClientRow({ ...mine }, 'manual')).toEqual(mine);
  });

  it('masks a number down to two digits, enough to tell two bookings apart', () => {
    expect(maskPhone('+13105550142')).toBe('•••• 42');
    expect(maskPhone(null)).toBeNull();
  });
});

describe('what the customer gets back', () => {
  // refundFor is pure, so the tiers are checked directly rather than through
  // six bookings. The booking path is exercised separately below.
  const item = (hoursOut: number, minutesSinceBooking = 60, arrived = false) => {
    const t = now();
    return {
      starts_at: t + hoursOut * 3600,
      price_cents: 20000,
      created_at: t - minutesSinceBooking * 60,
      arrived_at: arrived ? t : null,
    };
  };

  it('gives everything back more than 48 hours out', () => {
    const r = refundFor(item(72), now());
    expect(r.reason).toBe('full');
    expect(r.cents).toBe(20000);
  });

  it('gives three quarters back between 12 and 48 hours', () => {
    for (const hours of [47, 24, 13]) {
      const r = refundFor(item(hours), now());
      expect(r.reason, `${hours}h`).toBe('most');
      expect(r.cents).toBe(15000);
    }
  });

  it('gives a quarter back inside 12 hours', () => {
    const r = refundFor(item(6), now());
    expect(r.reason).toBe('some');
    expect(r.cents).toBe(5000);
  });

  it('steps down without a cliff at either boundary', () => {
    // The rule this replaced fell from half to nothing at the twelve-hour
    // mark: cancel at 12h01m and get half back, at 11h59m and get nothing.
    // That is a trapdoor, not a rule, and it is the sort of thing somebody
    // screenshots.
    expect(refundFor(item(48.1), now()).percent).toBe(100);
    expect(refundFor(item(47.9), now()).percent).toBe(75);
    expect(refundFor(item(12.1), now()).percent).toBe(75);
    expect(refundFor(item(11.9), now()).percent).toBe(25);
  });

  it('undoes an obvious mistake caught within half an hour', () => {
    // Wrong day, wrong address, wrong service. Spotted in minutes and it has
    // cost the operator nothing, because they have not moved.
    const r = refundFor(item(24, 10), now());
    expect(r.reason).toBe('grace');
    expect(r.cents).toBe(20000);
  });

  it('will not let grace cover a job the operator is already driving to', () => {
    // THE HOLE THIS CLOSES: book a slot starting in 45 minutes, cancel 25
    // minutes later, and a naive grace window hands back everything while the
    // operator is on the road. Grace needs three hours of runway or it is not
    // grace, it is a free cancellation.
    const r = refundFor(item(0.75, 25), now());
    expect(r.reason).toBe('some');
    expect(r.percent).toBe(25);
  });

  it('holds the floor exactly where it is drawn', () => {
    expect(refundFor(item(3.1, 5), now()).reason).toBe('grace');
    expect(refundFor(item(2.9, 5), now()).reason).toBe('some');
  });

  it('kills grace the moment they have arrived, whatever the clock says', () => {
    // Belt and braces over the three-hour floor: somebody standing on the
    // doorstep has done the driving regardless of what the timestamps claim.
    const r = refundFor(item(24, 5, true), now());
    expect(r.reason).toBe('most');
  });

  it('says what is happening in words, not just a number', () => {
    expect(refundFor(item(6), now()).message).toMatch(/a quarter comes back/i);
    expect(refundFor(item(24), now()).message).toMatch(/three quarters comes back/i);
    expect(refundFor(item(72), now()).message).toMatch(/all of it back/i);
  });

  it('leaves the customer and the operator on the same ladder', () => {
    // The whole point of these numbers: what the customer forfeits at a given
    // moment is what the operator owes at that same moment. One sentence
    // explains the policy to either side.
    const price = 20000;
    for (const [hours, reason] of [
      [24, 'cancelled_late'], [6, 'cancelled_last_hours'],
    ] as const) {
      const kept = price - refundFor(item(hours), now()).cents;
      expect(kept, `${hours}h`).toBe(leadFeeCents(price, reason));
    }
  });
});

describe('the 48-hour line, from the customer side', () => {
  it('lets a late cancellation through, and keeps most of the money', async () => {
    const { gapId } = await seed({ startsInSeconds: 6 * 3600 });
    const { itemId, token } = await book(gapId);
    // Aged past the grace window. A booking made and cancelled in the same
    // breath IS refunded — that is what grace is for, and the first version of
    // this test caught itself on it.
    await env.DB.prepare(`UPDATE order_items SET created_at = ? WHERE id = ?`)
      .bind(now() - 3600, itemId).run();

    // Allowed on purpose. Refusing looked protective and was not: the operator
    // would still drive out to a job nobody wants. This way they keep the
    // whole payment AND get their afternoon back.
    const res = await cancelByCustomer(env, token, itemId);
    expect(res.refund.reason).toBe('some');
    expect(res.refund.cents).toBe(3000);   // a quarter of the $120 diagnosis
    expect(res.fee).toBeNull();

    const item = await one<{ cancelled_at: number | null; refund_cents: number }>(
      `SELECT cancelled_at, refund_cents FROM order_items WHERE id = ?`, itemId);
    expect(item!.cancelled_at).not.toBeNull();
    expect(item!.refund_cents).toBe(3000);
  });

  it('gives half back in the middle band and records which rule applied', async () => {
    const { gapId } = await seed({ startsInSeconds: 30 * 3600 });
    const { itemId, token } = await book(gapId);
    // Past the grace window, so the tier decides.
    await env.DB.prepare(`UPDATE order_items SET created_at = ? WHERE id = ?`)
      .bind(now() - 3600, itemId).run();

    const res = await cancelByCustomer(env, token, itemId);
    expect(res.refund.reason).toBe('most');
    expect(res.refund.cents).toBe(9000);   // three quarters of the $120

    const row = await one<{ refund_reason: string }>(
      `SELECT refund_reason FROM order_items WHERE id = ?`, itemId);
    expect(row!.refund_reason).toBe('most');
  });

  it('lets them cancel free outside it, and never charges them a fee', async () => {
    const { gapId } = await seed({ startsInSeconds: 72 * 3600 });
    const { itemId, token } = await book(gapId);

    const res = await cancelByCustomer(env, token, itemId);
    expect(res.fee).toBeNull();
    expect(res.relisted).toBe(true);
    expect(await feesOwed(env, MECHANIC)).toMatchObject({ cents: 0 });
  });

  it('refunds a customer in full when the business cancels, whatever the clock says', async () => {
    const { gapId } = await seed({ startsInSeconds: 2 * 3600 });
    const { itemId } = await book(gapId);

    const res = await cancelByOperator(env, MECHANIC, itemId);
    expect(res.refund.reason).toBe('operator_cancelled');
    expect(res.refund.cents).toBe(12000);   // all of it
    // And the operator owes on top of that. The refund is the customer's
    // money; the fee is a separate debt to the platform. Two hours out and
    // they never went, so three quarters.
    expect(res.fee!.cents).toBe(9000);
  });

  it('charges the operator exactly what the customer would have forfeited', async () => {
    const { gapId } = await seed({ startsInSeconds: 6 * 3600 });
    const { itemId } = await book(gapId);
    const res = await cancelByOperator(env, MECHANIC, itemId);
    // The symmetry, on one rung: at six hours out the customer would keep a
    // quarter, and the operator owes the other three quarters. Same moment,
    // same number, whichever side broke it.
    expect(res.fee!.cents).toBe(9000);
    expect(res.fee!.reason).toBe('cancelled_last_hours');
  });
});

describe('a card on file', () => {
  it('stops an operator listing until they have one', async () => {
    await seed();
    await env.DB.prepare(`UPDATE operators SET payment_ref = NULL WHERE id = ?`)
      .bind(MECHANIC).run();
    expect(await listingBlock(env, MECHANIC)).toMatch(/Add a card/i);
  });

  it('says what the card is for, and that using the site is not it', async () => {
    await seed();
    await env.DB.prepare(`UPDATE operators SET payment_ref = NULL WHERE id = ?`)
      .bind(MECHANIC).run();
    const msg = (await listingBlock(env, MECHANIC))!;
    expect(msg).toMatch(/Nothing is charged to it for using the site/i);
    expect(msg).toMatch(/48 hours/);
  });

  it('refuses anything shaped like a card number instead of storing it', async () => {
    await seed();
    // If a PAN ever reaches this function the seam is wired up wrong, and
    // failing loudly is enormously better than quietly putting this database
    // inside PCI scope.
    await expect(saveOperatorCard(env, MECHANIC, { ref: '4242 4242 4242 4242' }))
      .rejects.toThrow(/looks like a card number/i);
  });
});

describe('no-shows', () => {
  /**
   * A finished appointment.
   *
   * Booked in the future, because a slot in the past cannot be bought — that
   * is a real rule and the test must not step around it — and then moved
   * backwards, which is what actually happens: every booking becomes a past
   * one by waiting.
   */
  const finished = async (gapId: string) => {
    const booked = await book(gapId);
    const t = now();
    await env.DB.prepare(
      `UPDATE order_items SET starts_at = ?, ends_at = ? WHERE id = ?`,
    ).bind(t - 4 * 3600, t - 3 * 3600, booked.itemId).run();
    return booked;
  };

  it('does nothing to anyone until a person confirms it', async () => {
    const { gapId } = await seed({ startsInSeconds: 72 * 3600 });
    const { itemId } = await finished(gapId);

    await reportNoShow(env, 'operator',
      { order_item_id: itemId, against: 'customer', note: 'nobody home' });

    // An operator who did the job and forgot the button leaves the same trace
    // as one who never went. A filing must not be able to suspend anybody.
    const standing = await customerStanding(env, '+18185550142');
    expect(standing.blocked).toBe(false);
    expect(standing.no_show_strikes).toBe(0);
  });

  it('walks the ladder 3, 7, 30, banned', async () => {
    const { gapId } = await seed({ startsInSeconds: 72 * 3600 });
    const { itemId } = await finished(gapId);
    const phone = '+18185550142';

    const days: Array<number | null> = [];
    for (let i = 0; i < 4; i += 1) {
      // A fresh report each time: one booking gets one report per side.
      const id = newId();
      const t = now();
      await env.DB.prepare(
        `INSERT INTO no_show_reports (id, order_item_id, against, operator_id,
           phone_e164, status, created_at, updated_at)
         VALUES (?,?, 'customer', ?,?, 'open', ?,?)`,
      ).bind(id, itemId + i, MECHANIC, phone, t, t).run();
      days.push((await confirmNoShow(env, id)).days);
    }

    expect(days).toEqual([3, 7, 30, null]);
    const standing = await customerStanding(env, phone);
    expect(standing.banned_at).not.toBeNull();
    expect(standing.blocked).toBe(true);
    expect(standing.message).toMatch(/cannot book here/i);
  });

  it('suspends an operator on the same ladder, without touching booked work', async () => {
    const { gapId } = await seed({ startsInSeconds: 72 * 3600 });
    const { itemId } = await finished(gapId);

    const report = await reportNoShow(env, 'customer',
      { order_item_id: itemId, against: 'operator' });
    const applied = await confirmNoShow(env, report.id);

    expect(applied.days).toBe(3);
    const standing = await operatorStanding(env, MECHANIC);
    expect(standing.blocked).toBe(true);
    expect(await listingBlock(env, MECHANIC)).toMatch(/already booked is unaffected/i);

    // The booking itself is untouched. A customer who paid keeps their
    // appointment whatever their operator has done.
    const item = await one<{ cancelled_at: number | null }>(
      `SELECT cancelled_at FROM order_items WHERE id = ?`, itemId);
    expect(item!.cancelled_at).toBeNull();
  });

  it('gives each side one report per booking, not five', async () => {
    const { gapId } = await seed({ startsInSeconds: 72 * 3600 });
    const { itemId } = await finished(gapId);

    await reportNoShow(env, 'operator', { order_item_id: itemId, against: 'customer' });
    await expect(reportNoShow(env, 'operator',
      { order_item_id: itemId, against: 'customer' }))
      .rejects.toThrow(/already reported/i);

    // But both sides may file on the same booking — each blaming the other is
    // a real outcome, and a schema that allows one story picks a winner before
    // anybody has looked.
    await expect(reportNoShow(env, 'customer',
      { order_item_id: itemId, against: 'operator' })).resolves.toBeTruthy();
  });

  it('refuses a report on a booking that was cancelled', async () => {
    const { gapId } = await seed({ startsInSeconds: 72 * 3600 });
    const { itemId } = await book(gapId);
    await cancelByOperator(env, MECHANIC, itemId);
    // Otherwise an operator cancels on the doorstep, pays the lead fee, and
    // files the customer as a no-show on top of it.
    await expect(reportNoShow(env, 'operator',
      { order_item_id: itemId, against: 'customer' })).rejects.toThrow(/was cancelled/i);
  });

  it('refuses a report before the appointment has even finished', async () => {
    const { gapId } = await seed({ startsInSeconds: 72 * 3600 });
    const { itemId } = await book(gapId);
    await expect(reportNoShow(env, 'operator',
      { order_item_id: itemId, against: 'customer' })).rejects.toThrow(/not finished/i);
  });

  it('stops a suspended number booking again', async () => {
    const { n, gapId } = await seed({ startsInSeconds: 72 * 3600 });
    const { itemId } = await finished(gapId);
    const report = await reportNoShow(env, 'operator',
      { order_item_id: itemId, against: 'customer' });
    await confirmNoShow(env, report.id);

    // A second opening in the SAME database — re-seeding would build a fresh
    // one and quietly throw away the suspension this test is about.
    const fresh = newId();
    await env.DB.prepare(
      `INSERT INTO gaps (id,operator_id,starts_at,ends_at,prev_lat,prev_lng,
         next_lat,next_lng,baseline_drive_seconds,is_mobile,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,180,1,'open',?,?)`,
    ).bind(fresh, MECHANIC, n + 72 * 3600, n + 77 * 3600,
      PREV.lat, PREV.lng, NEXT.lat, NEXT.lng, n, n).run();

    await expect(book(fresh)).rejects.toThrow(/cannot book/i);
  });
});
