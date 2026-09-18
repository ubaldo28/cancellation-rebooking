import { beforeEach, describe, expect, it } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import type { Env } from '../src/types';
import {
  currentCustomer, customerCookie, customerSideOf, sendSignInCode, signInWithCode,
} from '../src/lib/customers';
import { customerStanding } from '../src/lib/standing';
import { now } from '../src/lib/util';

/**
 * A business booking other trades, without becoming a second person.
 *
 * The mechanic's own van needs washing. Until migration 0042 there was nowhere
 * in the product for that to happen: a business and a customer are two rows in
 * two tables reached by two cookies, deliberately, and nothing joined them. The
 * column joins them in ONE DIRECTION — a business may open the customer side,
 * and a customer may not become a business by tapping anything — so every test
 * here is written from the operator's side, because that is the only side the
 * link can be made from.
 *
 * WHAT THESE TESTS ARE ACTUALLY DEFENDING is not the convenience. It is the two
 * things the link exists to make possible, and the one thing it must never do:
 *
 *   A suspension follows the person. A business struck off on Monday must not
 *   be booking as a customer on Monday afternoon, which is what the last group
 *   in this file is about.
 *
 *   One business is one customer account. Two would be a second, clean standing
 *   record — the escape hatch rebuilt by accident — so the adopting and the
 *   refusing tests matter more than they look.
 *
 *   Nobody is ever handed somebody else's account. A mailbox whose customer
 *   account already belongs to another business is a refusal and not a takeover,
 *   and no session is minted on the way past it.
 */

const OP = 'op-switcher';
const OTHER = 'op-somebody-else';
/** The address on the business's own account, which is what it proved to sign in. */
const EMAIL = 'rosa@valleydetailing.test';

const DAY = 86_400;

let env: Env;

beforeEach(async () => {
  env = makeEnv(ALL_MIGRATIONS) as unknown as Env;
});

/** A business row, with only the columns that have no default of their own. */
async function seedOperator(id: string, email: string): Promise<void> {
  const t = now();
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,timezone,country,currency,
       created_at,updated_at)
     VALUES (?,?,?, 'America/Los_Angeles','US','USD',?,?)`,
  ).bind(id, email, 'Valley Detailing', t, t).run();
}

const count = async (sql: string, ...args: unknown[]) =>
  (await env.DB.prepare(sql).bind(...args).first<{ n: number }>())!.n;

const accounts = () => count(`SELECT COUNT(*) AS n FROM customer_accounts`);
const sessions = () => count(`SELECT COUNT(*) AS n FROM customer_sessions`);

/**
 * Signs somebody in as an ORDINARY customer, through the real code flow.
 *
 * Not a hand-written row: the point of the adoption test below is that the
 * account a business finds is the same one a customer would have made, so it
 * has to be made the way a customer makes one. The echo is the local-only path
 * that hands the code back to the caller, which is what makes this possible
 * without an email provider.
 */
async function signUpAsCustomer(email: string, first_name: string): Promise<string> {
  const sent = await sendSignInCode(env, { email, ip: '203.0.113.7', echo: true });
  const { account } = await signInWithCode(env, {
    email, code: sent.code!, userAgent: null, first_name, phone: '+18185550142',
  });
  return account.id;
}

/** Reads the account a token actually opens, the way a request would. */
const whoIs = (token: string) => currentCustomer(
  new Request('https://gap.test/api/customer/me', {
    headers: { cookie: customerCookie(token) },
  }),
  env,
);

// ---------------------------------------------------------------------------

describe('a business opening the customer side', () => {
  it('creates the account, links it, and hands back a session that works', async () => {
    await seedOperator(OP, EMAIL);

    // Deliberately in the spelling somebody typed rather than the one the
    // database holds: the address is normalised on the way in, exactly as it is
    // at sign-in, or one mailbox becomes two accounts and two standing rows.
    const { account, token, created } = await customerSideOf(
      env, { id: OP, email: '  Rosa@ValleyDetailing.test ' });

    expect(created).toBe(true);
    expect(account.login_email).toBe(EMAIL);
    expect(account.operator_id).toBe(OP);
    // Verified without a code, because the business proved this same mailbox to
    // sign in to its own account. An account row without this cannot be signed
    // in to at all.
    expect(account.email_verified_at).not.toBeNull();

    // The token is a real customer session and not a value that merely looks
    // like one — hashed in the customer domain, in the customer table.
    expect((await whoIs(token))?.id).toBe(account.id);
    expect(await accounts()).toBe(1);
  });

  it('hands the same account back the second time, and never a second account', async () => {
    await seedOperator(OP, EMAIL);

    const first = await customerSideOf(env, { id: OP, email: EMAIL });
    const second = await customerSideOf(env, { id: OP, email: EMAIL });

    expect(second.created).toBe(false);
    expect(second.account.id).toBe(first.account.id);
    expect(await accounts()).toBe(1);

    // A second switch is a second sign-in, so it is a second session and a
    // different token: signing in on the laptop must not end the session on the
    // phone.
    expect(second.token).not.toBe(first.token);
    expect(await sessions()).toBe(2);
    expect((await whoIs(first.token))?.id).toBe(first.account.id);
  });

  it('adopts the customer account this mailbox already has', async () => {
    await seedOperator(OP, EMAIL);
    // Somebody booked a car wash with this address long before they ever put
    // their own business on the site.
    const existingId = await signUpAsCustomer(EMAIL, 'Rosa');

    const { account, created } = await customerSideOf(env, { id: OP, email: EMAIL });

    expect(created).toBe(false);
    expect(account.id).toBe(existingId);
    expect(account.operator_id).toBe(OP);
    // ONE ROW, which is the whole point. A second account for the same mailbox
    // would carry a standing record with nothing on it, and the no-show ladder
    // would start again from zero for anybody who happened to run a business.
    expect(await accounts()).toBe(1);
    // Adopted, not rebuilt: what was already on the account is left alone.
    expect(account.first_name).toBe('Rosa');
  });
});

describe('what a business is refused', () => {
  it('refuses one with no email address, and writes nothing', async () => {
    // The address is the whole of the proof — a business signs in by a link
    // emailed to it — so a business with nothing in that column has proved
    // nothing. An account keyed on an empty string would be one shared account
    // for every such business, carrying one shared standing row.
    await expect(customerSideOf(env, { id: OP, email: null }))
      .rejects.toThrow(/no email address/i);
    await expect(customerSideOf(env, { id: OP, email: '   ' }))
      .rejects.toThrow(/no email address/i);

    expect(await accounts()).toBe(0);
    expect(await sessions()).toBe(0);
  });

  it('refuses a mailbox whose account belongs to another business', async () => {
    await seedOperator(OP, EMAIL);
    const mine = await customerSideOf(env, { id: OP, email: EMAIL });

    // Two operator rows cannot hold one address, so reaching this state means
    // something upstream is wrong. The two available answers are to fail or to
    // take the account over, and taking it over would hand one business
    // another's bookings, their conversations and their saved card, silently.
    await expect(customerSideOf(env, { id: OTHER, email: EMAIL }))
      .rejects.toThrow(/another business/i);

    const row = await env.DB.prepare(
      `SELECT operator_id FROM customer_accounts WHERE id = ?`,
    ).bind(mine.account.id).first<{ operator_id: string | null }>();
    expect(row!.operator_id).toBe(OP);

    // And nothing was handed out on the way to the refusal. One switch, one
    // session: the business that was turned away holds no token at all.
    expect(await sessions()).toBe(1);
  });
});

describe('a sanction on the business', () => {
  const suspend = (id: string, until: number) => env.DB.prepare(
    `UPDATE operators SET suspended_until = ? WHERE id = ?`,
  ).bind(until, id).run();

  it('leaves an ordinary customer alone', async () => {
    // The control. A mailbox with no business behind it must be unaffected by
    // this join existing at all, which is almost every customer there is.
    await signUpAsCustomer('nobody@mailbox.test', 'Sam');
    const standing = await customerStanding(env, 'nobody@mailbox.test');
    expect(standing.blocked).toBe(false);
    expect(standing.message).toBeNull();
  });

  it('follows the person onto the customer side', async () => {
    await seedOperator(OP, EMAIL);
    await customerSideOf(env, { id: OP, email: EMAIL });

    const until = now() + 3 * DAY;
    await suspend(OP, until);

    // Without this, the customer side is the way out of every suspension the
    // product issues: struck off as a business on Monday, booking as a customer
    // on Monday afternoon, on the same mailbox.
    const standing = await customerStanding(env, EMAIL);
    expect(standing.blocked).toBe(true);
    expect(standing.suspended_until).toBe(until);
    // And it says where it comes from. "This account cannot book" on an account
    // with a spotless record is a support ticket nobody can answer from the
    // screen in front of them.
    expect(standing.message).toMatch(/business account/i);
    expect(standing.message).toMatch(/in 3 days/);

    // The customer's own ladder is untouched. confirmNoShow reads this to price
    // the next strike, so folding the business's strikes in here would charge a
    // customer's first no-show as their fourth.
    expect(standing.no_show_strikes).toBe(0);
  });

  it('carries a ban across, and cannot be shortened by one', async () => {
    await seedOperator(OP, EMAIL);
    await customerSideOf(env, { id: OP, email: EMAIL });

    const banned = now();
    await env.DB.prepare(`UPDATE operators SET banned_at = ? WHERE id = ?`)
      .bind(banned, OP).run();

    const standing = await customerStanding(env, EMAIL);
    expect(standing.banned_at).toBe(banned);
    expect(standing.blocked).toBe(true);
    expect(standing.message).toMatch(/business account/i);
  });

  it('does not shorten a suspension the customer is already serving', async () => {
    await seedOperator(OP, EMAIL);
    await customerSideOf(env, { id: OP, email: EMAIL });

    const t = now();
    await env.DB.prepare(
      `INSERT INTO customer_standing
         (login_email, no_show_strikes, suspended_until, banned_at, created_at, updated_at)
       VALUES (?,3,?,NULL,?,?)`,
    ).bind(EMAIL, t + 30 * DAY, t, t).run();
    await suspend(OP, t + 3 * DAY);

    // The heavier of the two, never the newer one — the same rule confirmNoShow
    // applies when two rungs land on one account. A three-day suspension on the
    // business must not be able to end a thirty-day one early.
    const standing = await customerStanding(env, EMAIL);
    expect(standing.suspended_until).toBe(t + 30 * DAY);
    expect(standing.no_show_strikes).toBe(3);
  });
});

describe('a business that changed its email address', () => {
  /**
   * THE CASE THAT USED TO BE A RAW FAILURE.
   *
   * The lookup went by email. A business that opened its customer side, then
   * changed the address on its business account, came back to find nothing
   * under the new address — so a second account was started, the unique index
   * on the link refused it, and the switch simply broke. Both accounts were
   * obviously theirs; there was never a question of whose they were. The
   * lookup was just asking the wrong question.
   */
  it('keeps the customer side it already had', async () => {
    await seedOperator(OP, 'old@mailbox.test');
    const first = await customerSideOf(env, { id: OP, email: 'old@mailbox.test' });

    await env.DB.prepare(`UPDATE operators SET email = ? WHERE id = ?`)
      .bind('new@mailbox.test', OP).run();

    const again = await customerSideOf(env, { id: OP, email: 'new@mailbox.test' });

    // The same account, not a second one — so their standing, their past
    // bookings and their saved card all still belong to them.
    expect(again.account.id).toBe(first.account.id);
    expect(again.created).toBe(false);
    expect(again.token).toBeTruthy();

    const n = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM customer_accounts`,
    ).first<{ n: number }>();
    expect(n?.n).toBe(1);
  });
});
