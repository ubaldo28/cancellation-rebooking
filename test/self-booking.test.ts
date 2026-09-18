import { beforeEach, describe, expect, it } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import type { Env } from '../src/types';
import { placeOrder, type OrderItemInput } from '../src/lib/orders';
import { claimSlot } from '../src/lib/public';
import { type HttpError, newId, now } from '../src/lib/util';

/**
 * A business cannot book its own openings.
 *
 * Migration 0042 lets somebody who runs a business here open the customer side
 * and book other trades — the mechanic whose own van needs washing. The rope
 * between the two rows is customer_accounts.operator_id, and the moment it
 * exists there is a person who can stand on both sides of one job.
 *
 * WHY THAT IS NOT MERELY POINTLESS. It looks like money going round in a circle
 * and doing no harm. The circle is not closed:
 *
 *   The platform's fee is paid by the person who receives it, so a business can
 *   generate turnover on this site at no cost to itself.
 *
 *   A job booked against yourself is a completed job and a review. On a
 *   marketplace this young, a dozen of either is the difference between a
 *   profile a stranger trusts and one they scroll past, and none of it happened.
 *
 *   Every cancellation, refund and no-show rule becomes theatre when the same
 *   person is on both sides of the booking they are meant to protect.
 *
 * BOTH DOORS, WHICH IS WHY THIS FILE COVERS TWO FUNCTIONS. placeOrder is the
 * JSON checkout and claimSlot is the form for a browser with no JavaScript, and
 * they both turn an opening into an appointment. A refusal on one of them is
 * not a refusal: the gap id travels in a URL and in a POST body, so an opening
 * hidden from somebody's own map is still one request away. That is the shape
 * of bug the customer card check already had, and repeating it here would be
 * repeating it knowingly.
 */

let env: Env;

/** The business that is about to go looking at its own openings. */
const MINE = 'op-mine';
const THEIRS = 'op-theirs';

/** The mailbox behind both of this person's identities — see migration 0042. */
const OWNER_EMAIL = 'rosa@valleydetailing.test';
const OWNER_ACCOUNT = 'acct-rosa';

/** Somebody with no business at all, which is nearly every customer there is. */
const SAM_EMAIL = 'sam@mailbox.test';
const SAM_ACCOUNT = 'acct-sam';

// Sherman Oaks-ish: the jobs either side of each opening, and the address the
// booking is for, all close enough that the drive-time check passes and the
// refusal under test is the only thing that can stop a booking.
const PREV = { lat: 34.1500, lng: -118.4490 };
const NEXT = { lat: 34.1520, lng: -118.4400 };
const NEAR = { lat: 34.1510, lng: -118.4450 };

const WHERE = { address_line: '15200 Ventura Blvd', postcode: '91403' };

const count = async (sql: string, ...args: unknown[]) =>
  (await env.DB.prepare(sql).bind(...args).first<{ n: number }>())!.n;

const appointments = () => count(`SELECT COUNT(*) AS n FROM appointments`);
const orders = () => count(`SELECT COUNT(*) AS n FROM orders`);
const claims = () => count(`SELECT COUNT(*) AS n FROM public_claims WHERE status='confirmed'`);

const gapStatus = async (gapId: string) =>
  (await env.DB.prepare(`SELECT status FROM gaps WHERE id = ?`)
    .bind(gapId).first<{ status: string }>())!.status;

/**
 * The refusal itself, rather than only the fact that something was thrown.
 *
 * The code is what the front end maps to a sentence, so a test that checked the
 * message alone would pass on a refusal the browser could only render as
 * "something went wrong".
 */
async function refusal(p: Promise<unknown>): Promise<HttpError> {
  return p.then(
    () => { throw new Error('that booking was supposed to be refused'); },
    (e: HttpError) => e,
  );
}

/** A business with one service and one open slot, ready to be booked. */
async function seedBusiness(id: string, email: string, name: string): Promise<string> {
  const n = now();
  // stripe_payouts_enabled = 1 is load-bearing, not boilerplate: a business
  // must have somewhere to be paid before its work can be sold, so priceOrder
  // treats an opening for an operator without it as unlisted. Drop it and every
  // booking in this file comes back slot_gone instead of the refusal under test.
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,timezone,country,currency,language,
       max_detour_seconds,plan,accept_public_bookings,created_at,updated_at,
       stripe_payouts_enabled)
     VALUES (?,?,?, 'America/Los_Angeles','US','USD','en', 900,'active',1,?,?,1)`,
  ).bind(id, email, name, n, n).run();

  await env.DB.prepare(
    `INSERT INTO services (id,operator_id,name,duration_seconds,price_cents,
       created_at,updated_at)
     VALUES (?,?,'Full detail',7200,9900,?,?)`,
  ).bind(`sv-${id}`, id, n, n).run();

  const gapId = newId();
  const start = n + 4 * 3600;
  await env.DB.prepare(
    `INSERT INTO gaps (id,operator_id,starts_at,ends_at,prev_lat,prev_lng,next_lat,next_lng,
       baseline_drive_seconds,is_mobile,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,180,1,'open',?,?)`,
  ).bind(gapId, id, start, start + 5 * 3600,
    PREV.lat, PREV.lng, NEXT.lat, NEXT.lng, n, n).run();

  return gapId;
}

/**
 * A customer account, written straight into the table.
 *
 * The row is the shape customerSideOf leaves behind — a verified mailbox, and
 * the business on it when there is one. Making the link through that function
 * instead is what test/operator-as-customer.test.ts is for; what this file is
 * about starts one step later, at the checkout, and hand-writing the row keeps
 * these tests about the refusal rather than about how the rope got tied.
 */
async function seedAccount(id: string, loginEmail: string, operatorId: string | null) {
  const n = now();
  await env.DB.prepare(
    `INSERT INTO customer_accounts (id, login_email, email_verified_at, first_name,
       operator_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(id, loginEmail, n, 'Rosa', operatorId, n, n).run();
}

/** The account as both booking paths receive it, off the session and not the form. */
const asAccount = (id: string, login_email: string) =>
  ({ id, phone: '+18185550142', login_email });

const buy = (account: { id: string; phone: string; login_email: string } | null,
  items: OrderItemInput[]) => placeOrder(env, {
  items,
  guest_name: 'Rosa',
  phone: '(818) 555-0142',
  ...WHERE,
  account,
});

const take = (gapId: string,
  account: { id: string; phone: string; login_email: string } | null) => claimSlot(env, {
  gapId, first_name: 'Rosa', phone: '(818) 555-0142', ...WHERE, account,
});

let myGap: string;
let theirGap: string;

beforeEach(async () => {
  env = makeEnv(ALL_MIGRATIONS) as unknown as Env;
  myGap = await seedBusiness(MINE, OWNER_EMAIL, 'Valley Detailing');
  theirGap = await seedBusiness(THEIRS, 'dan@overthehill.test', 'Over The Hill Auto');

  // The offline geocoder needs the ZIP to exist, exactly as in production.
  await env.DB.prepare(
    `INSERT INTO postal_codes (country_code,postal_code,place_name,lat,lng,accuracy)
     VALUES ('US','91403','Sherman Oaks',?,?,6)`,
  ).bind(NEAR.lat, NEAR.lng).run();

  await seedAccount(OWNER_ACCOUNT, OWNER_EMAIL, MINE);
  await seedAccount(SAM_ACCOUNT, SAM_EMAIL, null);
});

// ---------------------------------------------------------------------------

describe('the checkout, where a basket is bought', () => {
  it('refuses a business its own opening, and writes nothing at all', async () => {
    const e = await refusal(
      buy(asAccount(OWNER_ACCOUNT, OWNER_EMAIL), [{ gap_id: myGap, service_ids: [`sv-${MINE}`] }]));

    expect(e.code).toBe('own_opening');
    expect(e.message).toMatch(/is your own/i);
    // Plain and not an accusation. Nearly everybody who sees this is curious
    // about what their own listing looks like from the other side.
    expect(e.message).toMatch(/cannot book yourself/i);

    expect(await orders()).toBe(0);
    expect(await appointments()).toBe(0);
    expect(await claims()).toBe(0);
    // And the opening is still for sale, to somebody who is not them.
    expect(await gapStatus(myGap)).toBe('open');
  });

  it('sells that same business an opening belonging to another one', async () => {
    // The feature this is protecting, not a side effect of it: booking other
    // trades is the entire reason a business has a customer side.
    const order = await buy(
      asAccount(OWNER_ACCOUNT, OWNER_EMAIL), [{ gap_id: theirGap, service_ids: [`sv-${THEIRS}`] }]);

    expect(order.items).toHaveLength(1);
    expect(order.items[0]!.operator_id).toBe(THEIRS);
    expect(await gapStatus(theirGap)).toBe('filled');
  });

  it('leaves an ordinary customer alone', async () => {
    // The control, and the row almost every customer has: operator_id NULL, so
    // there is no business for any opening to match and nothing changes.
    const order = await buy(
      asAccount(SAM_ACCOUNT, SAM_EMAIL), [{ gap_id: myGap, service_ids: [`sv-${MINE}`] }]);

    expect(order.items[0]!.operator_id).toBe(MINE);
    expect(await gapStatus(myGap)).toBe('filled');
  });

  it('refuses the whole basket over one line of their own', async () => {
    // placeOrder is all or nothing, and this is where that matters most: taking
    // the line they are allowed to buy and dropping the other would leave them
    // with an appointment at a price they never agreed to, and a refusal that
    // reads as though half of it went through.
    const e = await refusal(buy(asAccount(OWNER_ACCOUNT, OWNER_EMAIL), [
      { gap_id: theirGap, service_ids: [`sv-${THEIRS}`] },
      { gap_id: myGap, service_ids: [`sv-${MINE}`] },
    ]));

    expect(e.code).toBe('own_opening');

    expect(await orders()).toBe(0);
    expect(await appointments()).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM order_items`)).toBe(0);
    expect(await claims()).toBe(0);
    // Both openings survive the refusal, including the one they could have had.
    expect(await gapStatus(myGap)).toBe('open');
    expect(await gapStatus(theirGap)).toBe('open');
  });
});

describe('the form for a browser with no JavaScript', () => {
  it('refuses a business its own opening, and writes nothing at all', async () => {
    // The same refusal, and the reason it is tested twice: this path posts a
    // gap id straight from a URL, so it reaches the booking without ever
    // consulting the page that would have hidden the opening.
    const e = await refusal(take(myGap, asAccount(OWNER_ACCOUNT, OWNER_EMAIL)));

    expect(e.code).toBe('own_opening');
    expect(e.message).toMatch(/your own opening/i);
    expect(e.message).toMatch(/cannot book yourself/i);

    expect(await appointments()).toBe(0);
    expect(await claims()).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM clients`)).toBe(0);
    expect(await gapStatus(myGap)).toBe('open');
  });

  it("lets that same business take somebody else's opening", async () => {
    const { appointment_id } = await take(theirGap, asAccount(OWNER_ACCOUNT, OWNER_EMAIL));

    const appt = await env.DB.prepare(`SELECT operator_id FROM appointments WHERE id = ?`)
      .bind(appointment_id).first<{ operator_id: string }>();
    expect(appt!.operator_id).toBe(THEIRS);
    expect(await gapStatus(theirGap)).toBe('filled');
  });

  it('leaves an ordinary customer alone', async () => {
    await take(myGap, asAccount(SAM_ACCOUNT, SAM_EMAIL));
    expect(await gapStatus(myGap)).toBe('filled');
  });

  it('leaves a booking with no account at all alone', async () => {
    // The other control. There is no basket on this path, so the multi-line
    // case above has no twin here; what it has instead is the caller with
    // nothing to check — no account, therefore no business behind one, and a
    // lookup that finds nothing must not turn into a refusal.
    await take(theirGap, null);
    expect(await gapStatus(theirGap)).toBe('filled');
  });
});
