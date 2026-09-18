import { describe, expect, it, beforeEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import { clientSource, liftFunction } from './client-source';
import worker from '../src/index';
import type { Env } from '../src/types';
import { startThread } from '../src/lib/chat';
import { placeOrder } from '../src/lib/orders';
import { saveOperatorCard } from '../src/lib/standing';
import { newId, now } from '../src/lib/util';

/**
 * THE WAY BACK TO A BOOKING NOBODY HAS PAID FOR.
 *
 * This file exists because of a dead end that was live on this site for the
 * whole of its life and that nothing in the product resolved.
 *
 * The checkout holds the appointments and writes the order BEFORE it asks for a
 * card. That is deliberate — somebody interrupted at the card step has not lost
 * the slot — and Book.tsx's pay step promises, in as many words, that "your
 * booking is held under your conversation and you can pay from there". For
 * every customer who closed the tab at that step, the conversation page could
 * not keep that promise: the guest payload carried the booking's
 * `order_item_id` and not its `order_id`, a charge is opened against an ORDER,
 * and nothing in the browser could turn one into the other. The order then sat
 * 'pending' for ever — an hour held in a business's calendar, a customer who
 * believed they had bought something, and no money moved. There is no email to
 * resend and, for a guest, no account to sign in to. The link is the whole of
 * their authority and that page IS the link.
 *
 * So the tests below are about four things, and every one of them is a way that
 * fix can be wrong rather than absent:
 *
 *   1. An unpaid booking carries the order id, and says money is outstanding.
 *   2. A paid one carries the id and does NOT offer to take money again.
 *   3. A booking with no order at all — the single-slot claims that predate
 *      orders — answers null and is not an error. That shape is older than the
 *      orders table and it still resolves through this route every day.
 *   4. A booking that is not going ahead is not asked to pay, whichever of the
 *      three rows recorded that it was called off.
 *
 * And one more, on the browser side, because it is the failure the fix itself
 * creates rather than one it inherited: a conversation can now hold an unpaid
 * booking AND an accepted quote, and for very nearly every accepted quote those
 * are the same order. Two card forms for one debt is worse than none.
 */

const BASE = 'https://gap.test';
let env: Env;

const OP = 'op-guest-pay';
const PREV = { lat: 34.1500, lng: -118.4490 };
const NEXT = { lat: 34.1520, lng: -118.4400 };
const NEAR = { lat: 34.1510, lng: -118.4450 };

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function call(method: string, path: string) {
  return worker.fetch(new Request(`${BASE}${path}`, { method }), env, ctx);
}

/** The guest payload for one link, as the customer's page actually receives it. */
async function view(token: string) {
  const res = await call('GET', `/api/public/threads/${token}`);
  expect(res.status).toBe(200);
  return (await res.json() as any).thread;
}

async function seed() {
  env = makeEnv(ALL_MIGRATIONS) as unknown as Env;
  const n = now();
  // stripe_payouts_enabled = 1 is load-bearing rather than boilerplate: a
  // business must have somewhere to be paid before its work can be sold, so
  // priceOrder treats an opening for an operator without it as unlisted. Drop
  // it and every booking in this file comes back slot_gone.
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,trade,timezone,country,currency,language,
       location_mode,fill_model,sms_mode,plan,accept_public_bookings,share_location,
       created_at,updated_at,stripe_payouts_enabled)
     VALUES (?,?,?, 'mobile car wash and detailing','America/Los_Angeles','US','USD','en',
       'mobile','both','device','active',1,1,?,?,1)`,
  ).bind(OP, 'gp@x.com', 'Valley Detailing', n, n).run();
  await saveOperatorCard(env, OP, { ref: 'pm', brand: 'visa', last4: '4242' });
  await env.DB.prepare(
    `INSERT INTO services (id,operator_id,name,duration_seconds,price_cents,created_at,updated_at)
     VALUES ('s1',?, 'Full detail',3600,20000,?,?)`,
  ).bind(OP, n, n).run();
  await env.DB.prepare(
    `INSERT INTO postal_codes (country_code,postal_code,place_name,lat,lng,accuracy)
     VALUES ('US','91403','Sherman Oaks',?,?,6)`,
  ).bind(NEAR.lat, NEAR.lng).run();
}

/**
 * A real checkout booking: appointments held, order written, card never given.
 *
 * This is the exact state the whole file is about, and it is reached the way a
 * customer reaches it — through placeOrder — rather than by writing the rows by
 * hand, so a change to what a checkout produces shows up here.
 */
async function booking() {
  const n = now();
  const gapId = newId();
  await env.DB.prepare(
    `INSERT INTO gaps (id,operator_id,starts_at,ends_at,prev_lat,prev_lng,next_lat,next_lng,
       baseline_drive_seconds,is_mobile,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,180,1,'open',?,?)`,
  ).bind(gapId, OP, n + 30 * 3600, n + 35 * 3600,
    PREV.lat, PREV.lng, NEXT.lat, NEXT.lng, n, n).run();

  const order = await placeOrder(env, {
    guest_name: 'Debra Dawson', phone: '(818) 555-0142',
    address_line: '15200 Ventura Blvd', postcode: '91403',
    items: [{ gap_id: gapId, service_ids: ['s1'] }],
  });
  return order;
}

beforeEach(seed);

// ---------------------------------------------------------------------------
// 1. The booking the customer walked away from
// ---------------------------------------------------------------------------

describe('a booking that was never paid for', () => {
  it('hands the page the order id a charge is opened against', async () => {
    const order = await booking();
    const thread = await view(order.thread_token);

    // THE FIELD THAT WAS MISSING, and the one line in this file that is the
    // whole bug. Without it the browser holds an order ITEM id and the pay
    // route wants an ORDER id, and there is no way between the two on that
    // side — which is why the card form could not be drawn at all.
    expect(thread.booking.order).not.toBeNull();
    expect(thread.booking.order.id).toBe(order.order_id);
  });

  it('says there is money outstanding, and that none has arrived', async () => {
    const order = await booking();
    const thread = await view(order.thread_token);

    // Both flags, because they are not each other's opposite and the page uses
    // them for different sentences: `paid` is what it says out loud, `due` is
    // whether it puts a card form in front of anybody.
    expect(thread.booking.order.paid).toBe(false);
    expect(thread.booking.order.due).toBe(true);
  });

  it('sends the amount already formatted, and the same one the checkout quoted', async () => {
    const order = await booking();
    const thread = await view(order.thread_token);

    // NOT ARITHMETIC, AND NOT A SECOND OPINION. The figure is the order's own
    // stored total put through the Worker's formatter, which is the same
    // number placeOrder handed the checkout. A browser that worked out its own
    // total and disagreed with the charge by a cent is a support ticket that
    // costs more than the cent.
    expect(thread.booking.order.total).toBe(order.total);
    expect(typeof thread.booking.order.total).toBe('string');
  });

  it('still carries the order item id the photo strip hangs off', async () => {
    // The field that was already here. The proof gallery on the booking is
    // keyed by it, so adding the order must not have cost it.
    const order = await booking();
    const thread = await view(order.thread_token);
    expect(thread.booking.order_item_id).toBeTruthy();

    const item = await env.DB.prepare(
      `SELECT id FROM order_items WHERE order_id = ?`,
    ).bind(order.order_id).first<{ id: string }>();
    expect(thread.booking.order_item_id).toBe(item!.id);
  });
});

// ---------------------------------------------------------------------------
// 2. The booking that was paid for
// ---------------------------------------------------------------------------

describe('a booking whose money has arrived', () => {
  /** What markPaid writes, done directly so no processor is involved. */
  const settle = async (orderId: string) => env.DB.prepare(
    `UPDATE orders SET status='confirmed', paid_at=?, payment_status='succeeded',
       updated_at=? WHERE id=?`,
  ).bind(now(), now(), orderId).run();

  it('does not offer to take the money again', async () => {
    const order = await booking();
    await settle(order.order_id);
    const thread = await view(order.thread_token);

    expect(thread.booking.order.paid).toBe(true);
    // The flag the card form is gated on. A page that drew one here would be
    // asking somebody holding a receipt to pay a second time, which is the one
    // mistake a marketplace does not get a second chance after.
    expect(thread.booking.order.due).toBe(false);
  });

  it('still names the order, so the page can talk about it', async () => {
    const order = await booking();
    await settle(order.order_id);
    const thread = await view(order.thread_token);
    // Paid is not the same as gone. The id stays because the page above still
    // has to be able to tell the quote card which order it is accounting for —
    // see the de-duplication tests further down.
    expect(thread.booking.order.id).toBe(order.order_id);
  });

  it('reads paid_at and not the order status, which is what markPaid means', async () => {
    // A charge that is still going through has a status and no paid_at, and
    // money a bank has not answered on is not money in. Saying "paid" here
    // would be claiming money that may yet be refused.
    const order = await booking();
    await env.DB.prepare(
      `UPDATE orders SET payment_status='processing', updated_at=? WHERE id=?`,
    ).bind(now(), order.order_id).run();

    const thread = await view(order.thread_token);
    expect(thread.booking.order.paid).toBe(false);
    expect(thread.booking.order.due).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. The bookings that are older than orders
// ---------------------------------------------------------------------------

describe('a booking with no order behind it at all', () => {
  /**
   * The shape that predates the orders table: an appointment, a conversation
   * pointing at it, and no order_items row anywhere.
   */
  async function claim() {
    const n = now();
    const apptId = newId();
    await env.DB.prepare(
      `INSERT INTO appointments (id, operator_id, starts_at, ends_at, is_mobile,
         status, source, address_line, price_cents, created_at, updated_at)
       VALUES (?,?,?,?,1,'scheduled','gap_fill','15200 Ventura Blvd',20000,?,?)`,
    ).bind(apptId, OP, n + 30 * 3600, n + 31 * 3600, n, n).run();
    const { token } = await startThread(env, {
      operator_id: OP, appointment_id: apptId, guest_name: 'Ada Early',
    });
    return token;
  }

  it('answers null rather than failing, and still draws the booking', async () => {
    const thread = await view(await claim());

    // NULL IS A NORMAL ANSWER. These rows are real and they still open this
    // page. Turning a booking that predates the payments system into a 500, or
    // into a missing `booking` object, would take the confirmation, the start
    // code and the conversation away from somebody whose only fault is having
    // booked early.
    expect(thread.booking).not.toBeNull();
    expect(thread.booking.order).toBeNull();
    expect(thread.booking.order_item_id).toBeNull();
    // Everything the page has always drawn is still there.
    expect(thread.booking.service_name).toBeTruthy();
    expect(thread.booking.price).toBeTruthy();
    expect(thread.booking.starts_at).toBeGreaterThan(0);
  });

  it('offers no card form, because there is nothing to open a charge against', async () => {
    const thread = await view(await claim());
    // The page reads `booking.order?.due`. Null here has to mean "say nothing
    // new about the money" and never "assume the worst and ask for some" —
    // there is genuinely no order to charge, and guessing on their behalf is
    // the one thing this route must not do.
    expect(thread.booking.order?.due ?? false).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Bookings that are not going ahead
// ---------------------------------------------------------------------------

describe('a booking that has been called off', () => {
  it('is not asked to pay when its line is cancelled', async () => {
    const order = await booking();
    await env.DB.prepare(
      `UPDATE order_items SET cancelled_at=?, cancelled_by='operator' WHERE order_id=?`,
    ).bind(now(), order.order_id).run();

    const thread = await view(order.thread_token);
    expect(thread.booking.order.id).toBe(order.order_id);
    expect(thread.booking.order.paid).toBe(false);
    // Neither paid nor payable, which is exactly the state a single flag gets
    // wrong. The page says "nothing was charged" rather than either claiming a
    // receipt or asking for money towards a job nobody is doing.
    expect(thread.booking.order.due).toBe(false);
  });

  it('is not asked to pay when the whole order is cancelled', async () => {
    const order = await booking();
    await env.DB.prepare(
      `UPDATE orders SET status='cancelled', updated_at=? WHERE id=?`,
    ).bind(now(), order.order_id).run();
    expect((await view(order.thread_token)).booking.order.due).toBe(false);
  });

  it('is not asked to pay when only the appointment was cancelled', async () => {
    // THE ONE THAT IS EASY TO MISS. POST /api/appointments/:id/cancel — the
    // Cancel button on the operator's own schedule — cancels the appointment
    // and deliberately does not touch order_items. Checking only the line
    // would leave a job called off from the screen an operator actually uses
    // still showing its customer a card form.
    const order = await booking();
    await env.DB.prepare(
      `UPDATE appointments SET status='cancelled', cancelled_at=?, updated_at=?
        WHERE operator_id=?`,
    ).bind(now(), now(), OP).run();

    const thread = await view(order.thread_token);
    expect(thread.booking.order.due).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. One debt, one card form
// ---------------------------------------------------------------------------

/**
 * The bucket split out of Estimates.tsx, running here rather than being read.
 *
 * There is no DOM in this test runner, so the alternative was to grep the
 * component for a filter and hope. Lifting the function means the rule is
 * actually executed against the shapes that matter, and a change to it fails
 * here rather than on somebody's phone.
 */
type Row = { status: string; order_id: string | null };
const splitEstimates = liftFunction<(l: Row[], handledAbove: string | null) => {
  booked: Row[]; open: Row[]; past: Row[]; above: Row[];
}>(
  clientSource('web/src/components/Estimates.tsx'),
  'function splitEstimates<',
  '  return { booked, open, past, above };\n}',
  'splitEstimates');

describe('a conversation holding both an unpaid booking and an accepted quote', () => {
  it('draws the quote panel when nothing above is accounting for it', async () => {
    // The plain case, and the one the quote flow shipped with: no booking card
    // is covering this order, so the estimate card owns it entirely.
    const rows: Row[] = [{ status: 'accepted', order_id: 'ord_1' }];
    const { booked, above, past } = splitEstimates(rows, null);
    expect(booked).toHaveLength(1);
    expect(above).toHaveLength(0);
    expect(past).toHaveLength(0);
  });

  it('does not draw a second panel for the order the booking card is paying for', async () => {
    // ACCEPTING A QUOTE POINTS THE THREAD AT THE APPOINTMENT IT JUST BOOKED —
    // attachBooking, in src/lib/estimates.ts — so the guest payload's booking
    // IS this estimate's booking and `booking.order.id` IS its `order_id`. One
    // order, one charge, and without this, two card forms for it. Whichever one
    // a person used, the other would still be sitting there afterwards saying
    // they owed money.
    const rows: Row[] = [{ status: 'accepted', order_id: 'ord_1' }];
    const { booked, above } = splitEstimates(rows, 'ord_1');
    expect(booked).toHaveLength(0);
    expect(above).toHaveLength(1);
  });

  it('does not tip that quote into the history list calling it unbooked', async () => {
    // The failure this is really guarding. `past` is "in neither of the other
    // two", so an estimate merely dropped from `booked` lands there instead and
    // is printed as "You accepted this — ask them below, we have no booking
    // against it". That line is for the genuinely stranded rows; about this one
    // it would be a flat lie, and it would send somebody to chase a booking
    // that is on the screen directly above.
    const rows: Row[] = [{ status: 'accepted', order_id: 'ord_1' }];
    expect(splitEstimates(rows, 'ord_1').past).toHaveLength(0);
  });

  it('still shows a second accepted quote the page above is not covering', async () => {
    // Not a dead branch. attachBooking is allowed to fail without undoing the
    // acceptance, and a second quote accepted on one conversation books an
    // order the thread does not point at. Those are the orders nothing else on
    // the page can reach, and this card is still the only way to them.
    const rows: Row[] = [
      { status: 'accepted', order_id: 'ord_1' },
      { status: 'accepted', order_id: 'ord_2' },
    ];
    const { booked, above } = splitEstimates(rows, 'ord_1');
    expect(booked.map((e) => e.order_id)).toEqual(['ord_2']);
    expect(above.map((e) => e.order_id)).toEqual(['ord_1']);
  });

  it('leaves quotes waiting on an answer alone whatever is being paid above', async () => {
    const rows: Row[] = [
      { status: 'accepted', order_id: 'ord_1' },
      { status: 'quoted', order_id: null },
      { status: 'asked', order_id: null },
    ];
    const { open, booked } = splitEstimates(rows, 'ord_1');
    expect(open).toHaveLength(2);
    expect(booked).toHaveLength(0);
  });

  it('never matches an estimate that has no order on a null handled-above', async () => {
    // `handledAbove` is null for every booking that predates orders, and an
    // estimate with no order id is the stranded shape. null === null must not
    // quietly pair them up and hide the one row that most needs showing.
    const rows: Row[] = [{ status: 'accepted', order_id: null }];
    const { above, past } = splitEstimates(rows, null);
    expect(above).toHaveLength(0);
    expect(past).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 6. The two halves of the browser agreeing about who pays
// ---------------------------------------------------------------------------

describe('the conversation page and the quote card agree on who takes the card', () => {
  /*
    THE PAGE MOVED AND THESE ASSERTIONS FOLLOWED IT, which is worth a note
    because the move is the reason they can still be this short.

    All of this used to be read out of web/src/pages/GuestThread.tsx, when
    /c/:token was the only way to reach a conversation. There are two ways now
    — the link, and a signed-in customer opening it from their own account —
    and every amount on the screen is identical in both, so the page became
    Conversation.tsx with two short route wrappers in front of it.

    THE ALTERNATIVE WAS TWO COPIES OF THIS PANEL, which is the thing this
    describe block exists to prevent. Every rule below is a rule about the code
    and is enforced by reading the code: one card component in the whole
    bundle, one card form per debt, a callback that survives the poll, an
    answer to "what if I close the tab". A second copy of the page would have
    satisfied all four on the day it was written and drifted from the original
    afterwards, and the first divergence in this particular panel is somebody
    charged twice. `wrapper` is asserted at the bottom for exactly that: the
    old path has to stay a wrapper and must never grow money logic of its own
    again.
  */
  const page = clientSource('web/src/pages/Conversation.tsx');
  const wrapper = clientSource('web/src/pages/GuestThread.tsx');
  const card = clientSource('web/src/components/Estimates.tsx');

  it('hands the quote card the order the booking card is accounting for', () => {
    // The one prop the de-duplication above depends on. If this stops being
    // passed, nothing throws and nothing fails to compile — the page simply
    // starts drawing two card forms for one charge again.
    expect(page).toContain('handledAbove={order?.id ?? null}');
    expect(card).toContain('handledAbove');
  });

  it('gates its own card form on the Worker saying money is owed', () => {
    expect(page).toContain('const owes = !!order?.due && order.id !== justPaid;');
    expect(page).toContain('{owes && order && (');
  });

  it('hands the card form a callback that does not change on every poll', () => {
    // NOT A STYLE RULE. PayForm re-opens the charge and re-mounts the
    // processor's fields whenever the `onPaid` it was handed is a different
    // function from last time, and both of these pages re-render every fifteen
    // seconds whatever anybody does — the conversation poll calls setThread
    // with a fresh object, and the estimate poll calls setList with a fresh
    // array. An arrow written at the call site is a different function every
    // time, so a customer halfway through typing a card number would have what
    // they had typed thrown away, over and over, on the one screen where
    // somebody is trying to type a card number.
    expect(page).toContain('onPaid={onBookingPaid}');
    expect(card).toContain('onPaid={markPaid(orderId)}');
  });

  it('has no second card flow of its own', () => {
    // THE PRODUCT RULE, pinned where it can be broken. There is exactly one
    // component in this bundle that may take a card for an order, and the way
    // that stays true is that every page reaches for PayPanel and nothing else
    // — no second PayForm, no hand-mounted Payment Element, and above all no
    // hop to a hosted checkout on somebody else's site.
    //
    // Checked on the IMPORTS rather than on the words, because the words are
    // in this file's comments and ought to be: the reason there is no second
    // card flow is worth writing down next to the one there is.
    expect(page).toContain("import PayPanel from '../components/PayPanel'");
    expect(page).not.toContain("from '../components/PayForm'");
    expect(page).not.toContain("from '../components/CardField'");
    // The product rule itself: nobody is ever sent to a payment site. The only
    // thing in this bundle that touches the processor's script is PayForm, and
    // it mounts it here rather than navigating to it.
    expect(page).not.toContain('js.stripe.com');
    expect(page).not.toContain('checkout.stripe.com');
  });

  it('tells somebody what happens if they close the tab', () => {
    // PayPanel makes `comeBack` required precisely because a panel that takes a
    // card without answering that question is the panel that strands people.
    //
    // AND THE ANSWER IS NOT THE SAME ON BOTH DOORS, which is why the prop is a
    // conditional now. On a link the page they are on IS the way back and
    // nobody can send it to them again, so the sentence has to tell them to
    // keep it. On the account door the way back is the account, and telling
    // that reader to bookmark or lose the card form is false — and a false
    // warning on this screen is how somebody decides to pay now rather than
    // risk losing a booking they were not ready to pay for.
    expect(page).toContain('comeBack={door === ');
    expect(clientSource('web/src/components/PayPanel.tsx')).toContain('comeBack: ReactNode;');
  });

  it('keeps the old link page a wrapper with no money logic in it', () => {
    // THE PROPERTY THE WHOLE MOVE DEPENDS ON. /c/:token must keep working
    // exactly as it did, and the way that is guaranteed is that it runs the
    // same component rather than a copy of it. The moment this file grows an
    // `owes`, a PayPanel or an order of its own, the two doors have two
    // implementations of one charge and every assertion above is checking only
    // one of them.
    expect(wrapper).toContain("import Conversation from './Conversation'");
    expect(wrapper).toContain('door="link"');
    expect(wrapper).not.toContain('PayPanel');
    expect(wrapper).not.toContain('owes');
    // Small enough that nothing can be hiding in it. A wrapper is a wrapper.
    expect(wrapper.split('\n').length).toBeLessThan(60);
  });

  it('opens the account door on the same component, with no copy of it', () => {
    // The other wrapper, held to the same rule. Two thin files in front of one
    // page is the arrangement; two pages is the failure.
    const account = clientSource('web/src/pages/AccountThread.tsx');
    expect(account).toContain("import Conversation from './Conversation'");
    expect(account).toContain('door="account"');
    expect(account).not.toContain('PayPanel');
    expect(account).not.toContain('owes');
    expect(account.split('\n').length).toBeLessThan(60);
  });
});
