import type { Env } from '../types';
import { findCardData } from './cardscan';
import { HttpError, timingSafeEqual } from './util';

/**
 * The line this codebase draws around card data, and the machinery that keeps
 * it drawn.
 *
 * The arrangement is the ordinary one: the processor's own form takes the
 * details in the customer's browser, the card never touches this Worker, and
 * what comes back is an opaque reference — `pm_...`, `cus_...`, `pi_...` — that
 * a later charge is made against. Storing a PAN instead would drag this whole
 * project into PCI DSS scope, turn every backup and every log line into a
 * breach waiting to be announced, and buy nothing at all.
 *
 * The problem with that arrangement is that it was a CONVENTION. Every payment
 * seam in here says the right thing in a comment, and one mis-wired front-end
 * form posting `{ number, cvc, exp_month, exp_year }` at /api/payment-method
 * would have quietly written a card number into D1 with every one of those
 * comments still true. saveOperatorCard checked its own `ref` argument;
 * nothing checked anything else, anywhere.
 *
 * So the guard is structural, and it sits at the three places a value has to
 * cross to do any damage:
 *
 *   INGRESS   every parsed request body, in body() in index.ts. Nothing shaped
 *             like a card gets past the router, on any route, including ones
 *             added next year by somebody who never read this file.
 *   STORAGE   every value bound to a D1 statement, via cardSafeDb() wrapping
 *             env.DB at the entry point. This is the one that matters most: it
 *             does not care how the value arrived — a webhook, an import, a
 *             free-text note somebody typed — only that it is about to be
 *             written down.
 *   EGRESS    every JSON response, in json() in util.ts. Belt and braces on
 *             top of the other two, and the thing that would catch a PAN that
 *             reached the database before any of this existed.
 *
 * All three fail LOUDLY. A refusal is the correct outcome: a request carrying
 * a card number is a bug in whatever sent it, and the alternative to a 400 is
 * silently storing the thing this whole arrangement exists to avoid.
 */

/** What the caller is told. Names the rule, never the value. */
const REFUSAL =
  'That request carried something shaped like card or bank details. This site '
  + 'never takes them: the payment provider\'s own form does, and hands back a '
  + 'reference. Nothing was stored.';

/**
 * Refuses anything carrying card or bank details.
 *
 * `where` is a short label for the log — "a request body", "a database write"
 * — so a developer can find the caller without the log line itself becoming
 * the copy of the card number that the refusal just prevented.
 */
export function assertNoCardData(value: unknown, where: string): void {
  const hit = findCardData(value);
  if (!hit) return;
  // Path and kind only. Logging the value would put the card in the tail,
  // which is exactly the outcome being prevented one line further down.
  console.error(`card data refused in ${where}: ${hit.kind} at ${hit.path}`);
  // 'raw_card' is kept for a PAN because that is the code /api/payment-method
  // already answered with before this check moved upstream, and a front end
  // branching on it should not have to change because the guard got broader.
  throw new HttpError(400, REFUSAL, hit.kind === 'pan' ? 'raw_card' : 'card_data');
}

/**
 * A processor reference, checked to be one.
 *
 * The positive half of the rule: not merely "this is not a card" but "this is
 * the opaque handle the processor gave us". Stripe's are `pm_`, `pi_`, `cus_`,
 * `src_`, `card_`, `ba_`, `tok_` followed by an opaque tail. Rather than pin
 * the prefixes of one provider, the test is that a reference has letters in
 * it: a value made only of digits and separators is not a handle, whatever
 * else it may be, and that is the shape a mis-wired form actually sends.
 */
export function assertPaymentRef(ref: string): string {
  const s = (ref ?? '').trim();
  if (!s) throw new HttpError(400, 'No card was added.', 'no_card');
  assertNoCardData({ ref: s }, 'a payment reference');
  if (!/[A-Za-z]/.test(s)) {
    throw new HttpError(
      400,
      'That is not a payment reference. This endpoint takes the handle the '
      + 'payment provider returns, never the card itself.',
      'not_a_ref',
    );
  }
  if (s.length > 255) {
    throw new HttpError(400, 'That payment reference is too long.', 'bad_ref');
  }
  return s;
}

/**
 * The last four digits, kept to the last four.
 *
 * These come back from the processor alongside the reference and are what
 * lets a person recognise their own card. Four digits are not a card number
 * and are not in PCI scope; sixteen of them are, so the slice is enforced here
 * rather than trusted to the caller.
 */
export function safeLast4(v: string | null | undefined): string | null {
  const digits = (v ?? '').replace(/\D/g, '');
  return digits ? digits.slice(-4) : null;
}

/** The card brand, as a short label and never as free text of any length. */
export function safeBrand(v: string | null | undefined): string | null {
  const s = (v ?? '').trim().slice(0, 20);
  return /^[A-Za-z][A-Za-z _-]*$/.test(s) ? s : null;
}

// ---------------------------------------------------------------------------
// The database wrapper
// ---------------------------------------------------------------------------

/**
 * env.DB, with every bound value checked before it can be written.
 *
 * This is the structural half of the guarantee. The ingress check in body()
 * covers what arrives on a request, but not what a webhook handler builds, or
 * what a library function assembles out of three other values, or a column
 * some future migration adds. Everything that reaches D1 goes through
 * prepare().bind(), so putting the check there means there is no route, no
 * import path and no clever refactor that gets a card number into the database
 * without tripping it.
 *
 * Statements are wrapped rather than proxied so batch() can unwrap them again:
 * D1's batch takes real prepared statements, and handing it ours would fail at
 * runtime in a way no type would have caught.
 */
class GuardedStatement {
  constructor(public readonly inner: D1PreparedStatement) {}

  bind(...args: unknown[]): GuardedStatement {
    assertNoCardData(args, 'a database write');
    return new GuardedStatement(this.inner.bind(...args));
  }

  first(colName?: string) {
    return colName === undefined
      ? this.inner.first()
      : this.inner.first(colName as never);
  }
  run() { return this.inner.run(); }
  all() { return this.inner.all(); }
  raw() { return this.inner.raw(); }
}

const unwrap = (s: unknown): D1PreparedStatement =>
  s instanceof GuardedStatement ? s.inner : (s as D1PreparedStatement);

/**
 * Wraps a D1 binding so nothing card-shaped can be written through it.
 *
 * Applied once, at the Worker's entry point, to both the request path and the
 * cron. A route that reaches for env.DB gets the guarded one because there is
 * no other one to reach for.
 */
export function cardSafeDb(db: D1Database): D1Database {
  const guarded = {
    prepare: (sql: string) =>
      new GuardedStatement(db.prepare(sql)) as unknown as D1PreparedStatement,
    batch: <T = unknown>(statements: D1PreparedStatement[]) =>
      db.batch<T>(statements.map(unwrap)),
    exec: (sql: string) => db.exec(sql),
    dump: () => (db as unknown as { dump(): Promise<ArrayBuffer> }).dump(),
    withSession: (constraint?: string) =>
      (db as unknown as { withSession(c?: string): unknown }).withSession(constraint),
  };
  return guarded as unknown as D1Database;
}

// ---------------------------------------------------------------------------
// Stripe webhooks
// ---------------------------------------------------------------------------

/**
 * Stripe's webhook signature, verified the way Twilio's is in ./twilio.ts.
 *
 * Built now, before a single charge exists, because the alternative is
 * building it on the day money starts moving — which is the day an unsigned
 * endpoint becomes worth forging. Without this, anybody who learns the URL can
 * POST `payment_intent.succeeded` and mark a job paid that nobody paid for, or
 * `charge.refunded` and reverse a fee.
 *
 * Stripe's scheme: the header carries a timestamp and one or more signatures,
 * `t=1699999999,v1=<hex>,v1=<hex>`. The signed payload is `${t}.${rawBody}`,
 * HMAC-SHA256 with the endpoint's signing secret, compared hex to hex.
 *
 * The raw body is passed in rather than read here because it must be the exact
 * bytes Stripe signed: re-serialising parsed JSON reorders keys and changes
 * whitespace, and every signature then fails for reasons that look like a
 * configuration problem.
 */
export const STRIPE_TOLERANCE_SECONDS = 300;

/**
 * Whether webhook verification can run at all.
 *
 * INERT UNTIL CONFIGURED, and it is inert today: STRIPE_WEBHOOK_SECRET is not
 * set in any environment. Unlike Turnstile, which steps aside when its secret
 * is missing, this one FAILS CLOSED — the route answers 503 and processes
 * nothing at all. That difference is deliberate. Turnstile absent means a form
 * is as open as it was before the check existed; this absent would mean an
 * endpoint that moves money accepting unsigned instructions from anybody, and
 * there is no version of that worth shipping "temporarily".
 */
export const stripeWebhooksConfigured = (env: Env): boolean =>
  typeof env.STRIPE_WEBHOOK_SECRET === 'string' && env.STRIPE_WEBHOOK_SECRET.trim() !== '';

/** Pulls `t` and every `v1` out of the Stripe-Signature header. */
export function parseStripeSignature(header: string | null): {
  timestamp: number | null; signatures: string[];
} {
  const out = { timestamp: null as number | null, signatures: [] as string[] };
  for (const part of (header ?? '').split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 't' && /^\d+$/.test(v)) out.timestamp = Number(v);
    // v0 is the test-mode scheme and is not accepted: only v1 is HMAC-SHA256
    // over the payload, and taking anything else would be accepting a weaker
    // signature because the sender asked us to.
    else if (k === 'v1' && v) out.signatures.push(v.toLowerCase());
  }
  return out;
}

const hex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function verifyStripeSignature(
  req: Request, env: Env, rawBody: string, at: number,
): Promise<boolean> {
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return false;                        // unconfigured means untrusted

  const { timestamp, signatures } = parseStripeSignature(req.headers.get('stripe-signature'));
  if (timestamp == null || signatures.length === 0) return false;

  // A replay window. Without it a signature stays valid forever, and one
  // captured webhook can be resent to re-apply whatever it did.
  if (Math.abs(at - timestamp) > STRIPE_TOLERANCE_SECONDS) return false;

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(`${timestamp}.${rawBody}`),
  );
  const expected = hex(mac);

  // Every offered signature is compared, and none of them short-circuits:
  // Stripe sends two during a secret rotation, and stopping at the first match
  // would leak which one matched through timing.
  let ok = false;
  for (const s of signatures) if (timingSafeEqual(expected, s)) ok = true;
  return ok;
}
