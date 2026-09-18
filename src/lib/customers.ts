import type { Env } from '../types';
import { SESSION_EXTEND_AFTER, SESSION_TTL } from './auth';
import { copy, isLang, type Lang } from './messages';
import { assertPaymentRef, safeBrand, safeLast4 } from './payments';
import { enforceRateLimit } from './ratelimit';
import { createStripeCustomer, stripeConfigured } from './stripe';
import { emailConfigured, looksLikeEmailAddress, sendEmail } from './email';
import {
  HttpError, badRequest, newId, newToken, now, sessionPepper, sha256, timingSafeEqual,
  unauthorized,
} from './util';

/**
 * A customer account: an email address, proved by a code sent to it.
 *
 * IT WAS A MOBILE NUMBER UNTIL MIGRATION 0038, and that migration is where the
 * reasoning lives rather than here. The short version: there is no way to send
 * a text message from this deployment, so the door that needed one was shut to
 * everybody. Moving the code to email without moving the ACCOUNT would have
 * been worse than a shut door — a person could have typed a stranger's number
 * beside their own address, received the code at the address they control, and
 * been handed the stranger's account. Proof and identity have to be the same
 * thing, so both moved.
 *
 * WHY THE ADDRESS IS THE ACCOUNT. customer_standing is keyed on login_email, so
 * a suspension and the account it belongs to are the same value and there is no
 * second identity for a sanction to fall between. Signing up again after a
 * suspension produces the same standing row, still suspended; closing the
 * account or erasing it leaves a live sanction in place; and a code sent to the
 * address is what proves somebody reads mail there, so a suspended person
 * cannot simply type a different one.
 *
 * The limitation is narrower than the old one rather than gone: a new mailbox
 * is still a clean record, and it costs whoever wants one a new mailbox. That
 * is the honest ceiling of an identity nobody pays to hold.
 *
 * THE NUMBER IS STILL COLLECTED AND IS NOT AN IDENTITY. An operator driving to
 * a stranger's address needs something to ring on arrival. Nothing is looked
 * up by it, no history is claimed by it and no sanction hangs on it.
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

/*
 * HOW LONG A SIGNED-IN DEVICE STAYS SIGNED IN: a year, extended on use, at
 * most once a month. SESSION_TTL and SESSION_EXTEND_AFTER are imported from
 * lib/auth.ts rather than redeclared here.
 *
 * THIS FILE HELD ITS OWN COPY OF BOTH NUMBERS, with its own paragraph arguing
 * for each, and the two declarations had already started to disagree in
 * writing: the note here still said an operator gets thirty days, which
 * stopped being true when auth.ts moved to a year explicitly to match this
 * side. That is the drift, caught on the prose rather than on the arithmetic
 * only because nothing read the prose.
 *
 * WHY A YEAR, on this side, which is the reasoning worth keeping. A customer
 * signs in on the phone in their pocket and then books twice a year; thirty
 * days would mean the account exists only in the sense that they re-create the
 * session every time they use it, which is the friction the owner explicitly
 * does not want and is not how a rider's phone behaves. What makes it safe
 * rather than merely convenient is what the session can do: read this person's
 * own bookings, place another against a card the processor holds, and message
 * a business. It cannot see anybody else, it cannot move money out, and it is
 * revoked outright by closing the account. Against that, the thing a short
 * session protects -- a stolen phone -- is already behind the phone's own lock
 * screen, and a customer who loses one can sign in on the new one and close
 * the account.
 *
 * WHY IT IS EXTENDED rather than a hard stop: a hard stop lands on the
 * customer at the worst possible moment -- mid-checkout, thirteen months after
 * they first booked -- and "stays signed in long-term" would be a promise with
 * an expiry date on it. The once-a-month floor is what keeps the extension one
 * cheap write a month per device rather than one on every request.
 *
 * NONE OF THE REST OF THE SESSION IS SHARED. Separate table, separate cookie,
 * separate hash domain -- see just below. The lifetime is the one piece that
 * is a single decision.
 */

/**
 * A different cookie from the operator's, and that is not cosmetic.
 *
 * Two names mean a browser that is signed in as both -- an operator who is
 * also somebody's customer, which will happen -- carries both and neither
 * overwrites the other. It also means the two credentials never travel in the
 * same header slot, so there is no request in which the wrong one could be
 * picked up by the wrong reader.
 *
 * AND IT CARRIES THE `__Host-` PREFIX, in the same change that moved
 * SESSION_COOKIE in ./auth.ts. Read the long note on that constant for the
 * full reasoning; the short version is that a browser holds two cookies of one
 * name without complaint -- the real one for `roundtheway.app`, and one set
 * with `Domain=.roundtheway.app` by anything on a subdomain -- and the Cookie
 * header carries no attributes, so nothing here can tell them apart. That is a
 * session shadow: a planted value that resolves means a customer browses
 * signed in as somebody else. The prefix makes the browser refuse the cookie
 * outright unless it came from the exact host, over HTTPS, with `Path=/` and
 * no `Domain` at all, so a sibling origin cannot write this name in the first
 * place.
 *
 * BOTH COOKIES MOVED TOGETHER AND THAT IS THE POINT. Hardening the operator
 * session and leaving this one would be the fix applied to half the site: a
 * toss against the customer cookie reaches somebody's home address, their
 * booking history and their saved card handle. `readCookie` below still takes
 * the FIRST match rather than trying every value the way auth.ts does, and
 * with the prefix in place there is no longer a second value for it to have to
 * choose between -- which is why that asymmetry, which was a real gap, does
 * not need a matching loop here.
 *
 * WHAT THE PREFIX REQUIRES IS ALREADY WHAT WE EMIT. `customerCookie` and
 * `clearCustomerCookie` below already wrote `Path=/; Secure` with no `Domain`
 * -- checked, not assumed -- so the rename is the whole change. If a `Domain=`
 * is ever added to either, the browser will discard the cookie silently and
 * signing in will simply appear to do nothing.
 *
 * WHY TODAY: the rename signs out every live session the moment it deploys,
 * and the only way back in is an emailed code. This deployment can send about
 * a hundred emails a day, shared between customer codes and operator sign-in
 * links, so doing this once there are real accounts would be an outage rather
 * than a re-login. The site went live today with essentially nobody signed in.
 */
const CUSTOMER_COOKIE = '__Host-sf_customer';

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
 *
 * BOTH DIGESTS BELOW NOW READ THE PEPPER THROUGH sessionPepper, and until they
 * did, the domain separation above was the only part of this that was actually
 * load-bearing. Both lines interpolated `env.SESSION_PEPPER` directly, and
 * with the secret unset that renders the literal text "undefined" rather than
 * failing, so both digests silently became unpeppered sha256 — and stayed
 * stable, so sessions resolved, codes verified and nothing anywhere said a
 * word. See sessionPepper in ./util.ts for the general shape of that failure.
 * It matters differently in the two cases, which is why the note is here and
 * not only on the second one: a customer session token is 32 random bytes and
 * survives being unpeppered, but the SIGN-IN CODE below is six digits, and an
 * unpeppered hash of six digits bound to a known mailbox is a million-entry
 * lookup table, not a secret. Anybody who could read customer_login_codes
 * could turn it back into live codes.
 */
const hashCustomerToken = (token: string, env: Env) =>
  sha256(`customer-session:${token}:${sessionPepper(env)}`);

/**
 * The code's digest, with the number inside it rather than beside it.
 *
 * Binding the number in means a code minted for one number cannot be accepted
 * against another, even by somebody who can read this table and replay a row.
 * The pepper is what stops six digits being trivially reversed: a bare
 * sha256 of a six-digit number is a lookup table, not a secret.
 *
 * Which is exactly why this one is read through sessionPepper rather than
 * interpolated: the sentence above was only ever true of a deployment that had
 * the secret set, and until now nothing checked. See hashCustomerToken.
 */

const hashCode = (loginEmail: string, code: string, env: Env) =>
  sha256(`customer-code:${loginEmail}:${code}:${sessionPepper(env)}`);

/**
 * The address, in the one spelling the database holds.
 *
 * Lowercased and trimmed before it is stored, looked up, or hashed into a code,
 * so that one mailbox typed four ways is one account and one standing row
 * rather than four of each -- which is the same job toE164 does for a number.
 * Every path in this file goes through it; a raw address must never reach a
 * bind parameter.
 */
export const normaliseLoginEmail = (v: string | null | undefined): string =>
  (v ?? '').trim().toLowerCase();

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
  /** The identity. Lowercased. NULL only on a closed or erased account. */
  login_email: string | null;
  /** Proof that a code sent to login_email was typed back in. */
  email_verified_at: number | null;
  /**
   * A CONTACT DETAIL, NOT AN IDENTITY -- the reverse of what 0037 said, and
   * the reverse of what this field was before 0038. Nobody proves a number any
   * more, because nothing texts one. An operator driving to a stranger's
   * address needs something to ring on arrival and this is it; it unlocks
   * nothing, moves no standing, and cannot be used to reach an account.
   */
  phone_e164: string | null;
  phone_verified_at: number | null;
  first_name: string | null;
  email: string | null;
  payment_ref: string | null;
  payment_brand: string | null;
  payment_last4: string | null;
  payment_added_at: number | null;
  /**
   * Who this person is at Stripe: 'cus_...', or NULL until they first reach a
   * card form. The saved card is filed under it, so this is what makes a card
   * typed in September chargeable in December. Migration 0041 has the why, and
   * ensureStripeCustomer below is the only thing that writes it.
   */
  stripe_customer_id: string | null;
  /**
   * The business this account belongs to, when a business has opened the
   * customer side of the product. NULL for everybody who signed up as a
   * customer, which is almost everybody.
   *
   * IT IS A ROPE BETWEEN TWO ROWS, NOT A MERGE. The two identities keep their
   * own bookings, their own card, their own session and their own standing row;
   * this says they are the same person. What that buys is a checkout that can
   * tell a business is about to book its own opening, and a suspension on the
   * business that lands on the customer side as well instead of being walked
   * around. Migration 0042 has the reasoning, and customerSideOf below is the
   * only thing that writes it.
   */
  operator_id: string | null;
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
 *
 * operator_id is left out under the same rule. Nothing on a customer screen
 * shows it, it is an internal join the Worker makes for itself, and putting it
 * in every account payload would mean handing out the fact that this mailbox
 * also runs a business here -- to anything that ever reads one of these
 * responses, for a screen that does not exist.
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
  /** The mailbox the code is sent to, and the account it will sign in to. */
  email: string;
  ip: string;
  lang?: string | null;
  /**
   * Local development only, and only for a caller who presented the debug
   * secret to a Worker whose APP_URL is localhost -- exactly the condition
   * mayEchoSignInLink already gates the operator's sign-in link on. It is what
   * lets the whole flow be exercised without a carrier account, and it is the
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
export const EMAIL_NOT_CONFIGURED =
  'We cannot send an email right now, so accounts cannot be created and '
  + 'nothing can be booked. This is our end, not yours — no email provider is '
  + 'configured on this deployment yet.';

/**
 * Emails a sign-in code to a mailbox.
 *
 * IT USED TO BE A TEXT MESSAGE. It is not, because there is no way to send one:
 * a US mobile needs a registered 10DLC or toll-free campaign, every route to
 * one needs a rentable street address published on the site, and until that
 * exists sendSms refuses every call. A door that always refuses is a door
 * nobody comes through, so the code moved to the channel that works. Migration
 * 0038 has the full reasoning, including why the ACCOUNT had to move with it
 * rather than the code alone.
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
 * THE THREE CEILINGS, and which attack each one is for. They are unchanged in
 * shape from the texting version, because the attack is unchanged in shape: an
 * inbox can be flooded exactly as a phone could, and it is the mailbox being
 * aimed at that the attacker cannot vary.
 *
 *   per mailbox, short  Three in a quarter hour. This is the one that stops the
 *                       mail cannon aimed at a stranger's inbox. Somebody who
 *                       genuinely did not get the first one asks twice and is
 *                       inside it.
 *   per mailbox, daily  Ten a day, so that patience does not defeat the first
 *                       ceiling, and ten is more than any real person needs.
 *   per address         Ten an hour, which stops one host walking a list of
 *                       mailboxes. Deliberately the weakest of the three and
 *                       not load-bearing: a botnet has ten thousand addresses.
 *                       That is why the per-mailbox ceilings exist and why
 *                       Turnstile sits in front of this route as well.
 *
 * IT ALSO GUARDS THE SENDING ALLOWANCE. Every call here is one of a hundred
 * emails a day this deployment can send, shared with the sign-in links that are
 * the only way a BUSINESS reaches its account. That is why the per-mailbox
 * daily ceiling is not merely an anti-abuse measure any more; see the daily cap
 * in src/index.ts, which is the other half of it.
 *
 * The reply is identical whether or not an account exists for the address. This
 * endpoint must never become the way to ask whether somebody has booked here.
 */
export async function sendSignInCode(env: Env, req: CodeRequest): Promise<CodeSent> {
  const email = normaliseLoginEmail(req.email);
  if (!looksLikeEmailAddress(email)) {
    throw badRequest('Enter an email address we can send a code to.', 'bad_email');
  }

  // Before a row is written and before a limit is spent, so that a deployment
  // with no provider answers the same way on the first request and the
  // hundredth rather than quietly consuming somebody's allowance.
  if (!emailConfigured(env) && !req.echo) {
    throw new HttpError(503, EMAIL_NOT_CONFIGURED, 'email_not_configured');
  }

  await enforceRateLimit(env, `otp-send:${email}`, 3, 900);
  await enforceRateLimit(env, `otp-send-day:${email}`, 10, 86400);
  await enforceRateLimit(env, `otp-send-ip:${req.ip}`, 10, 3600);

  const t = now();
  const code = newSignInCode();

  // The previous code for this mailbox dies the moment a new one is sent.
  //
  // Without this, asking for three codes gives three live codes and fifteen
  // guesses instead of five, and the per-code attempt ceiling stops meaning
  // what it says. It also matches what a person expects: the code in the
  // newest email is the one that works.
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE customer_login_codes SET consumed_at = ?
        WHERE login_email = ? AND consumed_at IS NULL`,
    ).bind(t, email),
    env.DB.prepare(
      `INSERT INTO customer_login_codes
         (id, login_email, code_hash, attempts, expires_at, consumed_at, send_ip, created_at)
       VALUES (?,?,?,0,?,NULL,?,?)`,
    ).bind(newId(), email, await hashCode(email, code, env), t + CODE_TTL, req.ip, t),
  ]);

  const lang: Lang = isLang(req.lang) ? req.lang : 'en';
  const minutes = Math.round(CODE_TTL / 60);
  const line = copy(lang).signInCode({ code, minutes });

  // 'signin', not 'bulk'. Somebody is sitting on a checkout page with this
  // half-finished, so it goes down the lane that retries a throttle rather than
  // the one that shrugs and waits for the next sweep. See EmailLane in
  // ./email.ts.
  const result = await sendEmail(env, {
    to: email,
    subject: `${code} is your code`,
    text: `${line}\n\nIf you didn't ask for this, you can ignore this email.`,
    html:
      `<p style="font-size:15px">Your code is</p>`
      + `<p style="font-size:30px;font-weight:700;letter-spacing:0.12em;margin:6px 0">`
      + `${code}</p>`
      + `<p style="color:#666;font-size:14px">It lasts ${minutes} minutes and works once. `
      + `If you didn't ask for this, you can ignore this email.</p>`,
  }, 'signin');

  // The echo is checked before the delivery result for the same reason the
  // sign-in link is in /api/auth/request: the local-development path has no
  // provider by design and must not be made to look like a provider outage.
  if (req.echo) return { expires_in: CODE_TTL, code };

  if (!result.sent) {
    // THE REASON, AND NOTHING ELSE ON THE RESULT.
    //
    // This logged the whole object, and the comment three lines below claimed
    // `detail` never reaches any of these — which was true of the HTTP
    // responses and false of the line above them. `detail` is built in
    // email.ts as `${provider} ${status} ${body}`, the body being the
    // provider's own response, and providers routinely echo the recipient back
    // in it. So an ordinary send failure printed a customer's email address
    // into the Worker log — which is outside every sweep in retention.ts and
    // outside every erasure, so somebody who asks to be forgotten cannot be
    // forgotten from it. The reason is the whole of what anybody reading this
    // log can act on anyway.
    console.error('sign-in code not sent', result.reason);
    // ONE SENTENCE PER REASON, and only one of them is the person's fault.
    //
    // `detail` never reaches any of these: it carries the provider's own text,
    // which names the account and the sending domain.
    switch (result.reason) {
      case 'not_configured':
        throw new HttpError(503, EMAIL_NOT_CONFIGURED, 'email_not_configured');
      case 'bad_address':
        // The only failure the person typing can do something about.
        throw badRequest(
          'That does not look like an email address we can reach.', 'bad_email');
      case 'rate_limited':
        // Already retried once inside sendEmail, so reaching here means the
        // allowance is genuinely spent -- which on a hundred-a-day free tier is
        // a thing that will happen. 503 rather than 502: this is capacity, it
        // is ours, and it passes on its own.
        throw new HttpError(
          503, 'We have sent as many emails as we can today. Try again tomorrow.',
          'email_busy');
      default:
        throw new HttpError(
          502, 'Could not send that code. Try again in a moment.', 'email_failed');
    }
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
 * Proves control of a mailbox, and consumes the code that proved it.
 *
 * Every failure path costs the caller one of the five attempts on that code,
 * including a correctly-shaped guess against an expired one, because the point
 * of the counter is to bound guessing rather than to be fair to a guesser.
 */
export async function checkSignInCode(
  env: Env, loginEmail: string, code: string,
): Promise<void> {
  const t = now();
  const digits = (code ?? '').trim();

  // The newest live code for this mailbox, which after the supersede in
  // sendSignInCode is the only one there can be. Ordered anyway, because a
  // lookup that depends on there being exactly one row is a lookup that breaks
  // silently the day there are two.
  const row = await env.DB.prepare(
    `SELECT id, code_hash, attempts, expires_at FROM customer_login_codes
      WHERE login_email = ? AND consumed_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
  ).bind(loginEmail).first<{
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
    ? await hashCode(loginEmail, digits, env)
    : await hashCode(loginEmail, `not-a-code:${newId()}`, env);

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
 * Turns a proved mailbox into a session, creating the account if there is none.
 *
 * Find-or-create, and the find is what makes a suspension inescapable: the
 * unique index on customer_accounts.login_email means the address resolves to
 * the row it always resolved to, whatever name or number is offered with it.
 * Signing up again after a ban is not a new account, it is the same mailbox.
 *
 * THE NUMBER IS TAKEN ON TRUST AND ALWAYS WILL BE HERE. It is written to the
 * account as a contact detail and nothing is inferred from it -- no lookup, no
 * standing, no claim of history. See migration 0038 for why the two swapped
 * places, and why emailing a code while keying the account on a number would
 * have been an account takeover rather than a smaller guarantee.
 */
export async function signInWithCode(env: Env, input: {
  email: string; code: string; userAgent: string | null;
  first_name?: string | null; phone?: string | null;
}): Promise<SignedIn> {
  const loginEmail = normaliseLoginEmail(input.email);
  await checkSignInCode(env, loginEmail, input.code);
  return startCustomerSession(env, {
    loginEmail,
    userAgent: input.userAgent,
    first_name: input.first_name ?? null,
    phone: input.phone ?? null,
  });
}

/**
 * The half of signing in that runs AFTER the mailbox is proved.
 *
 * Separate from signInWithCode so that there is exactly one place a session is
 * minted, and so that the only caller which reaches it without a code is the
 * one that has just checked one. Nothing exported from this module signs
 * anybody in without checkSignInCode having succeeded first.
 */
async function startCustomerSession(env: Env, input: {
  loginEmail: string; userAgent: string | null;
  first_name: string | null; phone: string | null;
}): Promise<SignedIn> {
  const t = now();
  const loginEmail = input.loginEmail;

  let account = await accountByEmail(env, loginEmail);
  let created = false;

  if (!account) {
    created = true;
    const id = newId();
    await env.DB.prepare(
      `INSERT INTO customer_accounts
         (id, login_email, email_verified_at, phone_e164, first_name, email,
          created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      // `email` carries the same address as `login_email` on a new row. The
      // column predates this migration and is what every receipt and every
      // profile screen already reads; leaving it null would mean a person who
      // has just typed their address sees a blank where it should be.
    ).bind(id, loginEmail, t, input.phone, input.first_name, loginEmail, t, t).run();
    account = (await accountByEmail(env, loginEmail))!;
  } else {
    // The name and the number are filled in if they are missing and left alone
    // if they are not. A checkout that carries a different spelling of
    // somebody's name must not silently rewrite the account they already have,
    // and a number arriving on one booking is not authority to replace one they
    // set deliberately.
    await env.DB.prepare(
      `UPDATE customer_accounts
          SET email_verified_at = ?,
              first_name = COALESCE(first_name, ?),
              phone_e164 = COALESCE(phone_e164, ?),
              updated_at = ?
        WHERE id = ?`,
    ).bind(t, input.first_name, input.phone, t, account.id).run();
    account = (await accountById(env, account.id))!;
  }

  const claimed = await claimGuestHistory(env, account.id, loginEmail);
  const token = await mintCustomerSession(env, account.id, input.userAgent);

  return { account, cookie: customerCookie(token), created, claimed };
}

/**
 * Writes one customer_sessions row and hands back the token that opens it.
 *
 * THE ONLY PLACE A CUSTOMER SESSION IS MINTED, and it is a function rather than
 * eight lines inside the sign-in path because there is now a second door onto
 * the customer side -- customerSideOf, below. Two copies of this would be two
 * places that have to agree about how long a session lasts and how its token is
 * hashed, and the day they stopped agreeing, one of the doors would be handing
 * out sessions the other one's lookup could not read, or worse, ones hashed in
 * a domain that was never meant to be a customer's.
 *
 * The raw token is returned and never stored: the row holds its digest, so a
 * copy of this table is not a set of working cookies. Callers that are
 * answering a browser wrap it in customerCookie; callers that are not can hold
 * the token itself.
 */
async function mintCustomerSession(
  env: Env, accountId: string, userAgent: string | null,
): Promise<string> {
  const t = now();
  const token = newToken();
  await env.DB.prepare(
    `INSERT INTO customer_sessions
       (id, account_id, token_hash, user_agent, expires_at, created_at)
     VALUES (?,?,?,?,?,?)`,
  ).bind(newId(), accountId, await hashCustomerToken(token, env),
    userAgent, t + SESSION_TTL, t).run();
  return token;
}

export const accountByEmail = (env: Env, loginEmail: string) =>
  env.DB.prepare(
    `SELECT * FROM customer_accounts WHERE login_email = ? AND closed_at IS NULL`,
  ).bind(normaliseLoginEmail(loginEmail)).first<CustomerAccount>();

export const accountById = (env: Env, id: string) =>
  env.DB.prepare(
    `SELECT * FROM customer_accounts WHERE id = ? AND closed_at IS NULL`,
  ).bind(id).first<CustomerAccount>();

/**
 * The customer account a business already has, found by the link and not the
 * address.
 *
 * THE ADDRESS IS NOT THE IDENTITY HERE; the link is. A business that changes
 * its email still has exactly one customer side, and it is the row that names
 * it — filed under whatever address was current the day it was opened, which
 * may be one nobody uses any more. Looking it up by today's address would find
 * nothing and start a second one, and their standing, their past bookings and
 * their saved card would all be on the first.
 */
export const accountByOperator = (env: Env, operatorId: string) =>
  env.DB.prepare(
    `SELECT * FROM customer_accounts WHERE operator_id = ? AND closed_at IS NULL`,
  ).bind(operatorId).first<CustomerAccount>();

/**
 * Attaches everything this mailbox did before it had an account.
 *
 * Somebody books as a guest in March, comes back in June and verifies the same
 * address: the March booking is theirs and has to appear.
 *
 * THE LINK IS THE ADDRESS, NOT THE NUMBER, and that is the whole point of this
 * function since 0038. It used to match on orders.phone_e164, which was safe
 * only for as long as a number was something you had to prove. It is not any
 * more -- a guest types whatever number they like into a booking form -- so
 * matching on it would hand a stranger's bookings, their addresses and their
 * conversations to anybody willing to type their phone number. The address on
 * the order is the one thing on it that somebody has since proved they can
 * read mail at.
 *
 * THE GUEST LINK IS NOT REISSUED AND CANNOT BE. Only the hash of a /c/:token
 * is stored -- orders.thread_token_hash, and the same for threads -- so there
 * is no way to hand back a token that was minted months ago, by design. That
 * costs nothing here: an account reaches its own bookings because they carry
 * its id, not because it can reconstruct a link. The old link keeps working
 * for whoever still has it, which is exactly what /c/:token is for.
 *
 * A conversation that never became a booking carries no address and is
 * therefore not claimable. That is correct rather than a gap: there is nothing
 * tying an anonymous enquiry to a person, and inventing one would mean
 * guessing.
 *
 * THE CONVERSATIONS ABOUT THOSE BOOKINGS ARE CLAIMED TOO, since migration
 * 0052, and it is the second statement below. Claiming the booking and not the
 * conversation is the exact half-measure this whole area was stuck in for
 * months: the March booking would appear in the list at /account with its
 * money and its start code, and the messages agreeing what the work was, the
 * photographs the customer took of their own kitchen and the card form for an
 * unpaid one would all still be behind a link minted in March that nobody can
 * reissue. The person is standing there having just proved the address it was
 * booked on. There is no reason left to withhold it.
 */
export async function claimGuestHistory(
  env: Env, accountId: string, loginEmail: string,
): Promise<{ orders: number }> {
  const email = normaliseLoginEmail(loginEmail);
  if (!email) return { orders: 0 };
  const t = now();
  const res = await env.DB.prepare(
    `UPDATE orders SET customer_account_id = ?, updated_at = ?
      WHERE login_email = ? AND customer_account_id IS NULL`,
  ).bind(accountId, t, email).run();

  // The conversations those orders reach, by the join migration 0052 sets out
  // and backfills with -- appointment_id or client_id on the order's own
  // lines, scoped to the same business.
  //
  // RUN AFTER THE UPDATE ABOVE, NOT BEFORE, so it sees the orders that call
  // has just claimed. Written as a second statement rather than folded into
  // the first because they are updates to two different tables, and D1 has no
  // way to express one statement that is both.
  //
  // `AND threads.customer_account_id IS NULL` IS THE SAFETY PROPERTY, not an
  // optimisation, and it is the same clause the orders update relies on. It
  // means this can only ever fill in a blank: a conversation already attached
  // to some other account is left exactly where it is. Without it, two people
  // sharing a mailbox -- or a mistyped address that happened to belong to
  // somebody real -- would silently move a stranger's conversation onto this
  // account, which is the one failure in this whole area that would be
  // unrecoverable.
  await env.DB.prepare(
    `UPDATE threads SET customer_account_id = ?, updated_at = ?
      WHERE customer_account_id IS NULL
        AND EXISTS (
          SELECT 1 FROM orders o
            JOIN order_items oi ON oi.order_id = o.id
           WHERE o.customer_account_id = ?
             AND oi.operator_id = threads.operator_id
             AND (oi.appointment_id = threads.appointment_id
                  OR oi.client_id = threads.client_id))`,
  ).bind(accountId, t, accountId).run();

  return { orders: res.meta.changes ?? 0 };
}

// ---------------------------------------------------------------------------
// A business, on the customer side
// ---------------------------------------------------------------------------

/**
 * Opens the customer side for a business, creating it the first time.
 *
 * A mechanic's own van needs washing, and until this existed there was nowhere
 * in the product for them to be the one booking. This is that door, and it
 * opens in ONE DIRECTION ONLY: a business may step over to the customer side,
 * and a customer may not step the other way. Becoming a business here means a
 * trade, a vehicle, a bank account and a place in search results -- a sign-up
 * somebody does deliberately, not a toggle on an account they are already
 * holding -- so nothing writes customer_accounts.operator_id from a customer
 * session and nothing should ever be made to.
 *
 * WHY THIS IS SAFE, and it is worth being explicit because on its face this
 * looks like a way into a customer account that skips the six-digit code. It is
 * not a new way in. The customer side asks for a code emailed to an address in
 * order to prove one thing: that whoever is asking can read mail at that
 * address. A business signs in the same way -- a link emailed to the address on
 * its own account, lib/auth.ts -- so an operator session in hand is already
 * that same proof, given at the same mailbox, at least as recently. The proof
 * has not been weakened; it has arrived through a different door. What would be
 * unsafe is the reverse direction, or trusting an address nobody proved, and
 * neither of those happens here.
 *
 * AND IT IS WHY THE EMAIL IS REQUIRED. The address is the whole of the proof,
 * so a business with nothing in that column has proved nothing and gets a
 * refusal rather than an account keyed on an empty string -- which, login_email
 * being what standing and history hang on, would be one shared account for
 * every operator that ever had a blank address.
 *
 * THE LINK IS LOOKED UP BEFORE THE ADDRESS, and that order is the whole of
 * what makes a changed email address a non-event. A business that has been
 * over to the customer side once has a row naming it; that row IS their
 * customer side, whatever address it happens to be filed under. Searching by
 * today's address first would miss it, start a second account, and hand them a
 * clean standing record and none of their own history — and then the unique
 * index would refuse the write anyway, which is a failure where there was no
 * problem to fail about.
 *
 * THE LINK IS NEVER MOVED OFF A ROW THAT HAS ONE. Finding somebody else's
 * business already on this account means something is wrong upstream -- two
 * operator rows cannot hold one address, the unique index in 0001 sees to that
 * -- and the two available responses are to fail or to take the account over.
 * Taking it over is the worst outcome this file can produce: it would hand one
 * business another's bookings, their conversations and their saved card, and it
 * would do it silently. So this refuses, loudly, and no session is minted on
 * the way past.
 */
export async function customerSideOf(env: Env, operator: {
  id: string; email: string | null;
}): Promise<{ account: CustomerAccount; token: string; created: boolean }> {
  const loginEmail = normaliseLoginEmail(operator.email);
  if (!loginEmail) {
    throw badRequest(
      'This business has no email address on it, so there is no customer '
      + 'account to open. Add one in your settings first.', 'no_operator_email');
  }

  // The same lookup the sign-in path does, for the same reason: the unique
  // index on login_email means this address resolves to the row it always
  // resolved to. A business whose owner has already booked somebody else as a
  // customer with this address ADOPTS that account rather than starting a
  // second one beside it -- which matters most for the thing they would not
  // see, their standing, because a second row would be a clean record.
  // THE LINK FIRST. A business that has already been over here has a row
  // naming it, and that row is their customer side no matter which address it
  // was opened under. Only when there is no link at all does the address
  // decide anything — and then it is the ordinary adoption case below.
  let account = await accountByOperator(env, operator.id)
    ?? await accountByEmail(env, loginEmail);
  let created = false;

  if (!account) {
    created = true;
    const t = now();
    await env.DB.prepare(
      `INSERT INTO customer_accounts
         (id, login_email, email_verified_at, operator_id, email,
          created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
      // email_verified_at is set here because the address IS verified -- see
      // the paragraph above -- and a row without it is one nothing can sign in
      // to. `email` carries the same address for the same reason it does on the
      // sign-in path: every receipt and profile screen reads that column.
      //
      // The link is written in the INSERT rather than afterwards so there is
      // never a moment where a customer account exists with no business on it
      // that a racing request could claim. Reaching this INSERT at all means
      // the lookup above found nothing under the link AND nothing under the
      // address, so this really is their first time through.
    ).bind(newId(), loginEmail, t, operator.id, loginEmail, t, t).run();
    account = (await accountByEmail(env, loginEmail))!;
  } else if (!account.operator_id) {
    // CONDITIONAL ON THE COLUMN STILL BEING NULL, exactly as startOnboarding
    // and ensureStripeCustomer are, and for the harder version of the same
    // reason. Two requests for the same business arriving together both read a
    // row with no link on it; one write wins, and the loser must not be able to
    // move the link -- so the loser changes nothing, re-reads, and the check
    // below is what it lands on. Reading and then writing unconditionally would
    // make "which business does this account belong to" the answer of whichever
    // request happened to finish last.
    await env.DB.prepare(
      `UPDATE customer_accounts SET operator_id = ?, updated_at = ?
        WHERE id = ? AND operator_id IS NULL AND closed_at IS NULL`,
    ).bind(operator.id, now(), account.id).run();
    account = (await accountById(env, account.id))!;
  }

  // Covers both ways this can be somebody else's account: a link that was
  // already there when we arrived, and one written by a racing request between
  // the read above and the write. Nothing has been handed out yet at this
  // point, which is the only reason it is safe for this check to be last.
  if (account.operator_id !== operator.id) {
    throw new HttpError(
      409,
      'That email address already belongs to another business here, so we '
      + 'cannot open a customer account on it. Get in touch and we will sort '
      + 'it out.',
      'linked_elsewhere',
    );
  }

  return { account, token: await mintCustomerSession(env, account.id, null), created };
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
    throw unauthorized('Confirm your email address to continue.');
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
 * CARD_INVITE_OPERATOR in standing.ts uses, and for the same reason: every
 * amount in the ladder is real policy and none of it can move a penny yet.
 * Stating the rules anyway is right -- somebody being asked for a card is
 * entitled to know what it is for before they hand one over.
 */
export const CARD_NOTE_CUSTOMER =
  'The full price is taken when you book, and nothing is added to it. The card '
  + 'number goes straight to our payment processor and never touches this '
  + 'site; what we keep is their reference, the brand and the last four '
  + 'digits. Cancelling late costs a quarter of the job inside 48 hours, three '
  + 'quarters inside 12 hours and the whole job once the business has arrived '
  + '— the same amounts a business pays you if they are the one who cancels.';

/**
 * The account's identity at Stripe, made if there is not one yet.
 *
 * A card can only be kept for later if it is filed under something at the
 * processor that outlives the form it was typed into, and that something is a
 * Stripe Customer. This is where a customer_accounts row gets one, and it is
 * the only place: everything that takes a card calls this first and uses what
 * it returns.
 *
 * FIND FIRST, CREATE SECOND, and then let the DATABASE decide. Two requests
 * arriving together — a double-tapped button, a page opened in two tabs — can
 * both read a row with no customer on it and both create one at Stripe, and
 * nothing this code does can stop that: the second create has already happened
 * by the time the first write lands. What can be stopped is a row being moved
 * off a handle that a card has since been saved under, which would leave that
 * card unreachable and the account looking as though it had never added one.
 * So the UPDATE is conditional on the column still being NULL, exactly as
 * startOnboarding's is for an operator, with the unique index from 0041 under
 * it; the loser of the race changes nothing, re-reads the row, and returns the
 * id that won. The cost is an unused customer object at Stripe holding no card
 * and no money, which is cheap and invisible.
 *
 * REFUSES RATHER THAN PRETENDING when Stripe is not configured. Returning
 * something falsy here would push the failure down to whoever tries to take a
 * card with it, where it arrives as a confusing error from the processor
 * instead of the plain fact that this deployment has no payments switched on.
 */
export async function ensureStripeCustomer(
  env: Env, account: CustomerAccount,
): Promise<string> {
  if (account.stripe_customer_id) return account.stripe_customer_id;
  if (!stripeConfigured(env)) {
    throw badRequest('Card payments are not switched on yet.', 'stripe_unconfigured');
  }

  const customer = await createStripeCustomer(env, {
    accountId: account.id,
    // The proved address, falling back to the contact one. It is a convenience
    // for whoever opens the Stripe dashboard and for the receipts Stripe sends;
    // nothing is looked up by it, here or there.
    email: account.login_email ?? account.email,
    name: account.first_name,
  });

  const res = await env.DB.prepare(
    `UPDATE customer_accounts SET stripe_customer_id = ?, updated_at = ?
      WHERE id = ? AND stripe_customer_id IS NULL AND closed_at IS NULL`,
  ).bind(customer.id, now(), account.id).run();

  if ((res.meta.changes ?? 0) > 0) return customer.id;

  // Nothing changed, so either somebody else got there first or the account was
  // closed between the read and the write. The row is the authority in both
  // cases: whatever it holds is what a card will be saved under, and if it
  // holds nothing then there is no account left to save one for.
  const stored = (await accountById(env, account.id))?.stripe_customer_id;
  if (!stored) throw badRequest('That account is closed.', 'account_closed');
  return stored;
}

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
 * address, it lives in a different table, it outlives the account, and proving
 * that address again produces a fresh account row with the same suspension on
 * it. Releasing login_email below is what lets somebody sign up again at all;
 * it is not what lets them escape. lib/retention.ts makes the same exception
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
    // THE ADDRESS IS SET TO NULL, and forgetting to do so was a real bug for
    // exactly as long as 0038 had shipped without this line.
    //
    // login_email carries a unique index, and accountByEmail only ever looks at
    // rows with closed_at IS NULL. So a closed row holding the address is
    // invisible to the lookup and still occupying the index: signing up again
    // found nothing, tried to INSERT, and hit `UNIQUE constraint failed` — a
    // 500 on the sign-in page, and a customer who had closed their account
    // could never come back with any address they had used. Setting it to NULL
    // is what releases it, because SQLite treats NULLs in a unique index as
    // distinct, so any number of closed accounts sit here without colliding.
    //
    // The suspension ladder does not leak through this. A sanction lives in
    // customer_standing, which is a different table and is not touched here —
    // closing an account and signing up again produces a fresh account row and
    // the same standing row, still suspended. That round trip is pinned in
    // test/customer-accounts.test.ts and is the reason this must be a release
    // of the address rather than a delete of the person.
    //
    // stripe_customer_id IS EMPTIED WITH THE REST. It was the one personal
    // column left on the row after a close: a live pointer at a Stripe Customer
    // object holding this person's name and email address, still attached to an
    // account the product describes as emptied. Clearing it here does not
    // delete Stripe's own copy and nothing in this codebase can — see section 7
    // of the privacy page, which says so plainly rather than implying the
    // contrary. It does stop this database being what ties a person to it, and
    // ensureStripeCustomer creates a fresh one if they ever come back.
    env.DB.prepare(
      `UPDATE customer_accounts
          SET login_email = NULL, email_verified_at = NULL,
              phone_e164 = NULL, first_name = NULL, email = NULL,
              payment_ref = NULL, payment_brand = NULL, payment_last4 = NULL,
              payment_added_at = NULL, password_hash = NULL,
              stripe_customer_id = NULL,
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
