import type { Env } from '../types';
import { copy, isLang, type Lang } from './messages';
import { assertPaymentRef, safeBrand, safeLast4 } from './payments';
import { enforceRateLimit } from './ratelimit';
import { sendSms, smsConfigured } from './twilio';
import {
  HttpError, badRequest, newId, newToken, now, sha256, timingSafeEqual, unauthorized,
} from './util';

/**
 * A customer account: a mobile number, proved by a code sent to it.
 *
 * THE MODEL, WHICH IS NOT WHAT THE REST OF THIS CODEBASE WAS BUILT ON. Until
 * now a customer had no account and the comments said so in about thirty
 * places. They were wrong, and migration 0037 explains the correction in full.
 * The short version: an account and a card are needed to book, but nobody is
 * asked to sign up before they have decided to buy anything, so the account is
 * created at the confirm step of the checkout in the same action that would
 * take the card.
 *
 * IT IS THE SHAPE A RIDER'S ACCOUNT HAS, deliberately. No password, no mailbox,
 * no second screen: type a mobile number, type the six digits that arrive,
 * you are in and you stay in on that device. Everything below exists to make
 * that both true and safe, and the two halves of that pull in opposite
 * directions -- an account nobody has to think about is also an account nobody
 * is protecting with attention, so the protection has to be structural.
 *
 * WHY THE NUMBER IS THE ACCOUNT. customer_standing has been keyed on
 * phone_e164 since migration 0023 and is what makes the no-show ladder work.
 * An account keyed on anything else would be a second identity beside the
 * first, and the gap between the two is exactly where a suspended person walks
 * free. Keying on the same column means a sanction follows the person: a new
 * account for a suspended number IS that number, still suspended, and the
 * standing row is never written to, cleared or shortened by anything in this
 * file.
 */

// ---------------------------------------------------------------------------
// The code
// ---------------------------------------------------------------------------

/**
 * Six digits.
 *
 * Not four and not eight, and the reason is that the code's strength does not
 * come from its length -- it comes from the ceilings below. A million
 * possibilities with five guesses per code and ten codes a day is fifty
 * chances in a million, which is a worse bet than guessing a bank card's PIN.
 * Making it eight digits would buy nothing against a guessing attack that is
 * already bounded at fifty tries, and would cost every customer the two extra
 * digits to read off a lock screen and type. Four would be the same arithmetic
 * with ten thousand possibilities, which is close enough to worth trying that
 * somebody would.
 */
const CODE_DIGITS = 6;

/**
 * Ten minutes.
 *
 * Long enough for a text to arrive on a bad network and be typed by somebody
 * who put their phone down first; short enough that a code read off a lock
 * screen by whoever picks the phone up later is dead. The lifetime is in the
 * message itself, so the failure at eleven minutes is explicable rather than
 * mysterious.
 */
const CODE_TTL = 600;

/**
 * Five wrong guesses and the code is dead -- not the account, and not the
 * number.
 *
 * This is the counter that actually stops guessing, and it is deliberately
 * counted against the CODE rather than against the caller's address. A wrong
 * guest link has nothing to be counted against but the caller, which is why
 * guestlink.ts counts addresses and accepts that a café shares one budget.
 * A wrong sign-in code is the opposite case: there is a row, it belongs to one
 * number, and counting there means a customer on hotel wifi is unaffected by
 * whatever anybody else on that wifi is doing.
 *
 * Killing the code rather than locking the number is also the choice that
 * cannot be turned into a denial of service. If a wrong guess locked the
 * NUMBER, anybody could lock a stranger out of their own account by guessing
 * at it five times; as it is, the worst an attacker achieves is destroying a
 * code the victim was not going to use anyway, and the remedy -- ask for
 * another -- is one tap and is what the refusal already tells them to do.
 */
const MAX_CODE_ATTEMPTS = 5;

/**
 * How long a signed-in device stays signed in: a year, against an operator's
 * thirty days in lib/auth.ts.
 *
 * DECIDED, NOT INHERITED. An operator signs in to a dashboard they work in
 * every day, so thirty days costs them one sign-in a month and bounds the
 * damage of a laptop left in a taxi. A customer signs in on the phone in their
 * pocket and then books twice a year, and the same thirty days would mean the
 * account exists only in the sense that they re-create the session every time
 * they use it -- which is the friction the owner explicitly does not want, and
 * it is not how a rider's phone behaves.
 *
 * What makes a year safe rather than merely convenient is what the session can
 * do: read this person's own bookings, place another one against a card the
 * processor holds, and message a business. It cannot see anybody else, it
 * cannot move money out, and it is revoked outright by closing the account.
 * Against that, the thing a short session protects -- a stolen phone -- is
 * already protected by the phone's own lock screen, and a customer who loses
 * one can sign in on the new one and close the account.
 */
const SESSION_TTL = 365 * 86400;

/**
 * Sessions are extended on use, at most once a month.
 *
 * Without this a year is a hard stop that lands on the customer at the worst
 * possible moment -- mid-checkout, thirteen months after they first booked --
 * and "stays signed in long-term" would be a promise with an expiry date on
 * it. With it, a device that is used stays signed in indefinitely and only one
 * that has been silent for a full year is asked for the number again. The
 * once-a-month floor is what keeps this one cheap write a month per device
 * rather than one on every request.
 */
const SESSION_EXTEND_AFTER = 30 * 86400;

/**
 * A different cookie from the operator's, and that is not cosmetic.
 *
 * Two names mean a browser that is signed in as both -- an operator who is
 * also somebody's customer, which will happen -- carries both and neither
 * overwrites the other. It also means the two credentials never travel in the
 * same header slot, so there is no request in which the wrong one could be
 * picked up by the wrong reader.
 */
const CUSTOMER_COOKIE = 'sf_customer';

/**
 * The digests, in two domains that cannot collide.
 *
 * An operator's session token hashes as `${token}:${pepper}` (lib/auth.ts).
 * A customer's hashes with a prefix, so the same 32 random bytes produce two
 * unrelated digests. This is what makes "an operator session can never satisfy
 * a customer route, or the reverse" a property of the arithmetic rather than
 * of the fact that the two lookups currently happen to read different tables:
 * paste an operator's cookie value into the customer cookie and the digest
 * matches nothing in customer_sessions, because it is not the digest that
 * table stores. The separate tables are the first wall and this is the second,
 * and the reason for two is that the first one is a fact about queries
 * somebody could rewrite.
 */
const hashCustomerToken = (token: string, env: Env) =>
  sha256(`customer-session:${token}:${env.SESSION_PEPPER}`);

/**
 * The code's digest, with the number inside it rather than beside it.
 *
 * Binding the number in means a code minted for one number cannot be accepted
 * against another, even by somebody who can read this table and replay a row.
 * The pepper is what stops six digits being trivially reversed: a bare
 * sha256 of a six-digit number is a lookup table, not a secret.
 */
const hashCode = (phone: string, code: string, env: Env) =>
  sha256(`customer-code:${phone}:${code}:${env.SESSION_PEPPER}`);

/**
 * A uniformly random code.
 *
 * Rejection sampling rather than `% 1000000`, because the modulo of a 32-bit
 * value by a million is biased towards the low codes -- slightly, and enough
 * that the bias is a free advantage to somebody guessing. Costing an extra
 * draw once in about four thousand is a better trade than explaining later
 * why some codes are likelier than others.
 */
export function newSignInCode(): string {
  const span = 10 ** CODE_DIGITS;
  const limit = Math.floor(0xffffffff / span) * span;
  const buf = new Uint32Array(1);
  let n: number;
  do {
    crypto.getRandomValues(buf);
    n = buf[0]!;
  } while (n >= limit);
  return String(n % span).padStart(CODE_DIGITS, '0');
}

// ---------------------------------------------------------------------------
// The account row
// ---------------------------------------------------------------------------

export interface CustomerAccount {
  id: string;
  phone_e164: string | null;
  phone_verified_at: number | null;
  first_name: string | null;
  email: string | null;
  payment_ref: string | null;
  payment_brand: string | null;
  payment_last4: string | null;
  payment_added_at: number | null;
  closed_at: number | null;
  created_at: number;
  updated_at: number;
}

/**
 * The account as it may leave the Worker.
 *
 * payment_ref is the handle a charge is made against and password_hash is a
 * credential; neither has a screen that shows it and neither would be anything
 * but a copy sitting in a browser cache, a HAR file attached to a support
 * ticket and every error reporter that captures a response. The same rule and
 * the same reasoning as PRIVATE_OPERATOR_FIELDS in index.ts -- the brand, the
 * last four and the date are what a person needs to recognise their own card.
 */
export interface PublicCustomerAccount {
  id: string;
  phone_e164: string | null;
  first_name: string | null;
  email: string | null;
  /** True when a card reference is on file. Never the reference itself. */
  has_card: boolean;
  payment_brand: string | null;
  payment_last4: string | null;
  payment_added_at: number | null;
  created_at: number;
}

export const publicAccount = (a: CustomerAccount): PublicCustomerAccount => ({
  id: a.id,
  phone_e164: a.phone_e164,
  first_name: a.first_name,
  email: a.email,
  has_card: !!a.payment_ref,
  payment_brand: a.payment_brand,
  payment_last4: a.payment_last4,
  payment_added_at: a.payment_added_at,
  created_at: a.created_at,
});

// ---------------------------------------------------------------------------
// Sending a code
// ---------------------------------------------------------------------------

export interface CodeRequest {
  /** Already normalised to E.164 by the caller, which is where the country is. */
  phone: string;
  ip: string;
  lang?: string | null;
  /**
   * Local development only, and only for a caller who presented the debug
   * secret to a Worker whose APP_URL is localhost -- exactly the condition
   * mayEchoSignInLink already gates the operator's sign-in link on. It is what
   * lets the whole flow be exercised without a Twilio account, and it is the
   * ONLY path on which a code is returned to the caller who asked for it.
   */
  echo?: boolean;
}

export interface CodeSent {
  /** Seconds the code lasts, so the page can say so without a second constant. */
  expires_in: number;
  /** Present only on the local-development echo path described above. */
  code?: string;
}

/** What the customer is told when delivery is not set up. Names the state exactly. */
export const SMS_NOT_CONFIGURED =
  'We cannot send a text message right now, so accounts cannot be created and '
  + 'nothing can be booked. This is our end, not yours — no text message '
  + 'provider is configured on this deployment yet.';

/**
 * Texts a sign-in code to a number.
 *
 * FAILS CLOSED WHEN THERE IS NO PROVIDER, and that is the whole reason this
 * function refuses rather than degrading. The alternative -- mint the code,
 * fail to send it, and let the flow carry on -- is a state in which a code
 * exists that nobody received, and the only people who can complete a sign-in
 * are the ones who can read the database or guess. lib/turnstile.ts steps
 * aside when its secret is missing and says loudly that this leaves the forms
 * unprotected; that is a defensible trade for a bot check and it is not one
 * for the credential that creates an account and holds a card, so this one
 * behaves like the Stripe webhook instead: unconfigured means 503 and nothing
 * happens at all.
 *
 * THE THREE CEILINGS, and which attack each one is for.
 *
 *   per number, short   Three texts to one number in a quarter hour. This is
 *                       the one that stops the SMS cannon: the attack is
 *                       aiming a stranger's phone at a repeat send, and the
 *                       number being aimed at is the one thing the attacker
 *                       cannot vary. A customer who genuinely did not get the
 *                       first text asks twice and is inside it.
 *   per number, daily   Ten a day, so that patience does not defeat the first
 *                       ceiling. Somebody who wants to make a stranger's phone
 *                       buzz all night gets ten and then nothing, and ten is
 *                       still more than any real person needs in a day.
 *   per address         Ten an hour, which stops one host walking a list of
 *                       numbers. It is deliberately the weakest of the three
 *                       and it is not load-bearing: a botnet has ten thousand
 *                       addresses and one per host would sail past it. That is
 *                       precisely why the per-number ceilings exist and why
 *                       Turnstile sits in front of this route as well -- a
 *                       limit counted per address cannot tell ten thousand
 *                       hosts doing something once from a good day.
 *
 * The reply is identical whether or not an account exists for the number. This
 * endpoint must never become the way to ask whether somebody's mobile has ever
 * booked here.
 */
export async function sendSignInCode(env: Env, req: CodeRequest): Promise<CodeSent> {
  const phone = (req.phone ?? '').trim();
  if (!phone.startsWith('+')) {
    throw badRequest('That does not look like a valid mobile number.', 'bad_phone');
  }

  // Before a row is written and before a limit is spent, so that a deployment
  // with no provider answers the same way on the first request and the
  // hundredth rather than quietly consuming somebody's allowance.
  if (!smsConfigured(env) && !req.echo) {
    throw new HttpError(503, SMS_NOT_CONFIGURED, 'sms_not_configured');
  }

  await enforceRateLimit(env, `otp-send:${phone}`, 3, 900);
  await enforceRateLimit(env, `otp-send-day:${phone}`, 10, 86400);
  await enforceRateLimit(env, `otp-send-ip:${req.ip}`, 10, 3600);

  const t = now();
  const code = newSignInCode();

  // The previous code for this number dies the moment a new one is sent.
  //
  // Without this, asking for three codes gives three live codes and fifteen
  // guesses instead of five, and the per-code attempt ceiling stops meaning
  // what it says. It also matches what a person expects: the code in the
  // newest message is the one that works.
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE customer_login_codes SET consumed_at = ?
        WHERE phone_e164 = ? AND consumed_at IS NULL`,
    ).bind(t, phone),
    env.DB.prepare(
      `INSERT INTO customer_login_codes
         (id, phone_e164, code_hash, attempts, expires_at, consumed_at, send_ip, created_at)
       VALUES (?,?,?,0,?,NULL,?,?)`,
    ).bind(newId(), phone, await hashCode(phone, code, env), t + CODE_TTL, req.ip, t),
  ]);

  const lang: Lang = isLang(req.lang) ? req.lang : 'en';
  const result = await sendSms(
    env, phone, copy(lang).signInCode({ code, minutes: Math.round(CODE_TTL / 60) }));

  // The echo is checked before the delivery result for the same reason the
  // sign-in link is in /api/auth/request: the local-development path has no
  // provider by design and must not be made to look like a provider outage.
  if (req.echo) return { expires_in: CODE_TTL, code };

  if (!result.sent) {
    console.error('sign-in code not sent', result);
    if (result.reason === 'not_configured') {
      throw new HttpError(503, SMS_NOT_CONFIGURED, 'sms_not_configured');
    }
    throw new HttpError(
      502, 'Could not send that code. Try again in a moment.', 'sms_failed');
  }
  return { expires_in: CODE_TTL };
}

// ---------------------------------------------------------------------------
// Checking one
// ---------------------------------------------------------------------------

/**
 * ONE SENTENCE FOR EVERY WAY A CODE CAN FAIL.
 *
 * Wrong digits, a code that expired, a code already used, a code killed by
 * somebody else's guessing, and a number nobody has ever sent a code to all
 * get this and nothing else. A caller who can tell "wrong" from "wrong, and
 * that number has no code outstanding" has been handed both an oracle for
 * guessing and a way to ask which numbers are in the middle of signing in.
 */
const BAD_CODE = 'That code is wrong or has expired. Ask for a new one.';

/**
 * Proves control of a number, and consumes the code that proved it.
 *
 * Every failure path costs the caller one of the five attempts on that code,
 * including a correctly-shaped guess against an expired one, because the point
 * of the counter is to bound guessing rather than to be fair to a guesser.
 */
export async function checkSignInCode(env: Env, phone: string, code: string): Promise<void> {
  const t = now();
  const digits = (code ?? '').trim();

  // The newest live code for this number, which after the supersede in
  // sendSignInCode is the only one there can be. Ordered anyway, because a
  // lookup that depends on there being exactly one row is a lookup that breaks
  // silently the day there are two.
  const row = await env.DB.prepare(
    `SELECT id, code_hash, attempts, expires_at FROM customer_login_codes
      WHERE phone_e164 = ? AND consumed_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
  ).bind(phone).first<{
    id: string; code_hash: string; attempts: number; expires_at: number;
  }>();

  if (!row) throw badRequest(BAD_CODE, 'bad_code');

  if (row.expires_at <= t || row.attempts >= MAX_CODE_ATTEMPTS) {
    // Killed rather than left to age out, so a stale row cannot be probed
    // again and again for free.
    await env.DB.prepare(`UPDATE customer_login_codes SET consumed_at=? WHERE id=?`)
      .bind(t, row.id).run();
    throw badRequest(BAD_CODE, 'bad_code');
  }

  // Compared as digests and in constant time. `!==` on a secret returns as
  // soon as it finds a differing byte, and a caller who can measure that can
  // extend a guess one character at a time -- which against six digits is a
  // few dozen requests rather than a million. A code of the wrong shape is
  // given a digest that cannot match rather than being rejected early, so that
  // "wrong length" and "wrong digits" take the same path and cost the same
  // attempt.
  const offered = /^\d+$/.test(digits) && digits.length === CODE_DIGITS
    ? await hashCode(phone, digits, env)
    : await hashCode(phone, `not-a-code:${newId()}`, env);

  if (!timingSafeEqual(offered, row.code_hash)) {
    // Counted in one statement, so two guesses arriving together cannot both
    // read the same count and both write count+1 -- the same reason rateLimit
    // upserts rather than reads and writes. The row is killed on the way past
    // the ceiling in the same statement, which is what makes the fifth wrong
    // guess the last one rather than the first of another five.
    await env.DB.prepare(
      `UPDATE customer_login_codes
          SET attempts = attempts + 1,
              consumed_at = CASE WHEN attempts + 1 >= ? THEN ? ELSE consumed_at END
        WHERE id = ?`,
    ).bind(MAX_CODE_ATTEMPTS, t, row.id).run();
    throw badRequest(BAD_CODE, 'bad_code');
  }

  // Single use, enforced by the WHERE clause rather than by having just read
  // the row: two requests carrying the same correct code race here, and
  // exactly one of them changes a row.
  const used = await env.DB.prepare(
    `UPDATE customer_login_codes SET consumed_at=? WHERE id=? AND consumed_at IS NULL`,
  ).bind(t, row.id).run();
  if ((used.meta.changes ?? 0) === 0) throw badRequest(BAD_CODE, 'bad_code');
}

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------

export interface SignedIn {
  account: CustomerAccount;
  cookie: string;
  /** True when this call created the account rather than finding it. */
  created: boolean;
  /** Bookings and conversations that predated the account, now attached to it. */
  claimed: { orders: number };
}

/**
 * Turns a proved number into a session, creating the account if there is none.
 *
 * Find-or-create, and the find is what makes a suspension inescapable: the
 * unique index on customer_accounts.phone_e164 means the number resolves to
 * the row it always resolved to, whatever name or mailbox is offered with it.
 * Signing up again after a ban is not a new account, it is the same number.
 */
export async function signInWithCode(env: Env, input: {
  phone: string; code: string; userAgent: string | null;
  first_name?: string | null; email?: string | null;
}): Promise<SignedIn> {
  await checkSignInCode(env, input.phone, input.code);
  return startCustomerSession(env, {
    phone: input.phone,
    userAgent: input.userAgent,
    first_name: input.first_name ?? null,
    email: input.email ?? null,
  });
}

/**
 * The half of signing in that runs AFTER the number is proved.
 *
 * Separate from signInWithCode so that there is exactly one place a session is
 * minted, and so that the only caller which reaches it without a code is the
 * one that has just checked one. Nothing exported from this module signs
 * anybody in without checkSignInCode having succeeded first.
 */
async function startCustomerSession(env: Env, input: {
  phone: string; userAgent: string | null;
  first_name: string | null; email: string | null;
}): Promise<SignedIn> {
  const t = now();
  const phone = input.phone;

  let account = await accountByPhone(env, phone);
  let created = false;

  if (!account) {
    created = true;
    const id = newId();
    await env.DB.prepare(
      `INSERT INTO customer_accounts
         (id, phone_e164, phone_verified_at, first_name, email, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(id, phone, t, input.first_name, input.email, t, t).run();
    account = (await accountByPhone(env, phone))!;
  } else {
    // The name and the mailbox are filled in if they are missing and left
    // alone if they are not. A checkout that carries a different spelling of
    // somebody's name must not silently rewrite the account they already have,
    // and an email arriving on one booking is not authority to replace one
    // they set deliberately.
    await env.DB.prepare(
      `UPDATE customer_accounts
          SET phone_verified_at = ?,
              first_name = COALESCE(first_name, ?),
              email = COALESCE(email, ?),
              updated_at = ?
        WHERE id = ?`,
    ).bind(t, input.first_name, input.email, t, account.id).run();
    account = (await accountById(env, account.id))!;
  }

  const claimed = await claimGuestHistory(env, account.id, phone);

  const token = newToken();
  await env.DB.prepare(
    `INSERT INTO customer_sessions
       (id, account_id, token_hash, user_agent, expires_at, created_at)
     VALUES (?,?,?,?,?,?)`,
  ).bind(newId(), account.id, await hashCustomerToken(token, env),
    input.userAgent, t + SESSION_TTL, t).run();

  return { account, cookie: customerCookie(token), created, claimed };
}

export const accountByPhone = (env: Env, phone: string) =>
  env.DB.prepare(
    `SELECT * FROM customer_accounts WHERE phone_e164 = ? AND closed_at IS NULL`,
  ).bind(phone).first<CustomerAccount>();

export const accountById = (env: Env, id: string) =>
  env.DB.prepare(
    `SELECT * FROM customer_accounts WHERE id = ? AND closed_at IS NULL`,
  ).bind(id).first<CustomerAccount>();

/**
 * Attaches everything this number did before it had an account.
 *
 * Somebody books as a guest in March, comes back in June and verifies the same
 * number: the March booking is theirs and has to appear. The link is the
 * number on the order, which has been there since migration 0016 and is the
 * same column customer_standing and erasure already work from.
 *
 * THE GUEST LINK IS NOT REISSUED AND CANNOT BE. Only the hash of a /c/:token
 * is stored -- orders.thread_token_hash, and the same for threads -- so there
 * is no way to hand back a token that was minted months ago, by design. That
 * costs nothing here: an account reaches its own bookings because they carry
 * its id, not because it can reconstruct a link. The old link keeps working
 * for whoever still has it, which is exactly what /c/:token is for.
 *
 * A conversation that never became a booking carries no number and is
 * therefore not claimable. That is correct rather than a gap: there is nothing
 * tying an anonymous enquiry to a person, and inventing one would mean
 * guessing.
 */
export async function claimGuestHistory(
  env: Env, accountId: string, phone: string,
): Promise<{ orders: number }> {
  const res = await env.DB.prepare(
    `UPDATE orders SET customer_account_id = ?, updated_at = ?
      WHERE phone_e164 = ? AND customer_account_id IS NULL`,
  ).bind(accountId, now(), phone).run();
  return { orders: res.meta.changes ?? 0 };
}

// ---------------------------------------------------------------------------
// Cookies, and reading one back
// ---------------------------------------------------------------------------

export function customerCookie(token: string, maxAge = SESSION_TTL): string {
  return `${CUSTOMER_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export const clearCustomerCookie = () =>
  `${CUSTOMER_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/**
 * The signed-in customer, or null.
 *
 * `closed_at IS NULL` is in the WHERE clause and not a check afterwards, the
 * same as requireOperator: closing an account revokes its sessions, and a
 * cookie already in a browser must not be able to reach a row whose personal
 * columns have been emptied.
 *
 * AN OPERATOR SESSION CANNOT ARRIVE HERE. It is a different cookie, in a
 * different table, hashed in a different domain -- three independent reasons,
 * and the third is the one that survives somebody changing the first two.
 */
export async function currentCustomer(
  req: Request, env: Env,
): Promise<CustomerAccount | null> {
  const token = readCookie(req, CUSTOMER_COOKIE);
  if (!token) return null;
  const hash = await hashCustomerToken(token, env);
  const t = now();

  const row = await env.DB.prepare(
    `SELECT a.*, s.id AS session_id, s.expires_at AS session_expires_at
       FROM customer_sessions s
       JOIN customer_accounts a ON a.id = s.account_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
        AND a.closed_at IS NULL`,
  ).bind(hash, t).first<CustomerAccount & {
    session_id: string; session_expires_at: number;
  }>();
  if (!row) return null;

  // Extended on use, at most once a month. See SESSION_EXTEND_AFTER.
  if (row.session_expires_at - t < SESSION_TTL - SESSION_EXTEND_AFTER) {
    await env.DB.prepare(`UPDATE customer_sessions SET expires_at = ? WHERE id = ?`)
      .bind(t + SESSION_TTL, row.session_id).run();
  }

  const { session_id: _s, session_expires_at: _e, ...account } = row;
  return account as CustomerAccount;
}

/** The same lookup, as a gate. 401 with a code the front end can act on. */
export async function requireCustomer(req: Request, env: Env): Promise<CustomerAccount> {
  const account = await currentCustomer(req, env);
  if (!account) {
    throw unauthorized('Confirm your mobile number to continue.');
  }
  return account;
}

export async function revokeCustomerSession(req: Request, env: Env): Promise<void> {
  const token = readCookie(req, CUSTOMER_COOKIE);
  if (!token) return;
  await env.DB.prepare(`UPDATE customer_sessions SET revoked_at = ? WHERE token_hash = ?`)
    .bind(now(), await hashCustomerToken(token, env)).run();
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

/**
 * The sentence a customer is shown about their card, today.
 *
 * Written as the design rather than as something that happens, the same tense
 * NEEDS_CARD_OPERATOR in standing.ts uses, and for the same reason: every
 * amount in the ladder is real policy and none of it can move a penny yet.
 * Stating the rules anyway is right -- somebody being asked for a card is
 * entitled to know what it is for before they hand one over.
 */
export const CARD_NOTE_CUSTOMER =
  'A card is what you will pay with, and it is not charged when you add it. '
  + 'No money moves through Slotfill yet: bookings are held, not paid for, and '
  + 'nothing can be taken from a card until payment is switched on. When it is, '
  + 'the full price is taken at the moment you book, and cancelling late costs '
  + 'a quarter of the job inside 48 hours, three quarters inside 12 hours and '
  + 'the whole job once the business has arrived — the same amounts a business '
  + 'pays you if they are the one who cancels.';

/**
 * Records the processor's reference to a customer's card. Never the card.
 *
 * PAYMENT SEAM: called after the processor's own form has taken the details in
 * the customer's browser and handed back a reference. There is deliberately no
 * path in this codebase that accepts a card number, on either side of the
 * market -- see lib/payments.ts, which enforces that at ingress, at every
 * database bind and at egress. assertPaymentRef is the same check
 * /api/payment-method already makes for an operator, so a mis-wired form gets
 * the same refusal whichever side of the product it is on.
 *
 * NOTHING PRODUCES A REFERENCE TO PUT HERE TODAY. Stripe is not wired, so in
 * practice this function is reachable and unused, and that is the honest state
 * of it: the column, the validation and the route are real, and the moment a
 * card would be taken is the moment Stripe is switched on.
 */
export async function saveCustomerCard(
  env: Env, accountId: string,
  card: { ref: string; brand?: string | null; last4?: string | null },
): Promise<void> {
  const ref = assertPaymentRef(card?.ref ?? '');
  const t = now();
  await env.DB.prepare(
    `UPDATE customer_accounts SET payment_ref=?, payment_brand=?, payment_last4=?,
       payment_added_at=?, updated_at=? WHERE id=? AND closed_at IS NULL`,
  ).bind(ref, safeBrand(card.brand), safeLast4(card.last4), t, t, accountId).run();
}

// ---------------------------------------------------------------------------
// Closing an account
// ---------------------------------------------------------------------------

/**
 * Closes an account: the personal columns are emptied and every session dies.
 *
 * NOT AN ERASURE, and the difference is deliberate. This removes the account
 * -- the number, the name, the mailbox, the card reference -- and leaves the
 * bookings alone, because an order is a record of something that happened
 * between two people and one of them cannot delete it unilaterally. Erasing
 * the bookings as well is a different and larger request, it has its own route
 * (DELETE /api/customer/data), and it says so before it runs.
 *
 * NOTHING HERE TOUCHES customer_standing, and that is the point rather than an
 * omission. If closing an account cleared a suspension, then "close and sign
 * up again" would be the way round the no-show ladder and every suspended
 * customer would find that out within a week. The standing row is keyed on the
 * number, it outlives the account, and verifying that number again produces an
 * account that is still suspended. lib/retention.ts makes the same exception
 * for erasure, for the same reason.
 */
export async function closeCustomerAccount(
  env: Env, accountId: string,
): Promise<{ closed: true; sessions_revoked: number }> {
  const t = now();
  const res = await env.DB.batch([
    env.DB.prepare(
      `UPDATE customer_sessions SET revoked_at = ?
        WHERE account_id = ? AND revoked_at IS NULL`,
    ).bind(t, accountId),
    // The number is set to NULL rather than kept, which is what releases it:
    // the unique index treats NULLs as distinct, so any number of closed
    // accounts sit here without colliding and the person can start again.
    env.DB.prepare(
      `UPDATE customer_accounts
          SET phone_e164 = NULL, first_name = NULL, email = NULL,
              payment_ref = NULL, payment_brand = NULL, payment_last4 = NULL,
              payment_added_at = NULL, password_hash = NULL,
              closed_at = ?, updated_at = ?
        WHERE id = ? AND closed_at IS NULL`,
    ).bind(t, t, accountId),
  ]);
  return { closed: true, sessions_revoked: res[0]?.meta.changes ?? 0 };
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

/**
 * Drops codes and sessions nothing can use any more, on the cron.
 *
 * A consumed or expired code is a permanent record that a number once signed
 * in, which is a fact about a person kept for no purpose. An hour of slack
 * past expiry so that a request in flight when the sweep runs still gets the
 * refusal it would have got rather than a different one.
 */
export async function sweepCustomerAuth(env: Env): Promise<number> {
  const t = now();
  const codes = await env.DB.prepare(
    `DELETE FROM customer_login_codes
      WHERE expires_at < ? OR (consumed_at IS NOT NULL AND consumed_at < ?)`,
  ).bind(t - 3600, t - 3600).run();
  const sessions = await env.DB.prepare(
    `DELETE FROM customer_sessions
      WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)`,
  ).bind(t - 86400, t - 86400).run();
  return (codes.meta.changes ?? 0) + (sessions.meta.changes ?? 0);
}

/** Exported for the tests, so the numbers above are asserted rather than retyped. */
export const CUSTOMER_AUTH = {
  CODE_DIGITS, CODE_TTL, MAX_CODE_ATTEMPTS, SESSION_TTL, SESSION_EXTEND_AFTER,
  CUSTOMER_COOKIE,
} as const;
