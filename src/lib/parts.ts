import type { Env } from '../types';
import { threadByToken, threadForOperator, type ThreadRef } from './chat';
import { formatMoney, localeFor } from './countries';
import { notify } from './feed';
import { redactContact } from './redact';
import {
  chargeIdOf, createPaymentIntent, paymentIntentsByMetadata, stripeConfigured,
  StripeError, stripeRefused,
} from './stripe';
import {
  HttpError, MAX_NOTE_CHARS, badRequest, conflict, newId, notFound, now,
} from './util';

/**
 * Parts.
 *
 * The problem this solves, in one sentence: a mobile mechanic does not know
 * whether your car needs a $40 sensor or a $400 alternator until they are
 * under the hood, so asking them to name one price at checkout either prices
 * them out of the job or forces them to collect the difference in cash at the
 * door — off the platform, in exactly the conversation this product exists to
 * keep on the platform.
 *
 * Three policies, because there are only three honest shapes (see migration
 * 0020): 'none' (no parts, the price is the price), 'included' (parts are
 * already in the price, and we say so instead of leaving the customer to
 * guess), and 'quoted' (the part is not knowable in advance).
 *
 * For 'quoted', the flow is: the customer pays the labour in full at checkout,
 * the operator arrives and finds out what is needed, sends a quote into the
 * conversation that already exists for that booking, and the customer taps
 * approve or decline in the app. An approved quote is a second payment through
 * the site.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: nothing is ever charged that the
 * customer has not seen and approved. Not a rounding difference, not "it came
 * to a bit more", not cash at the door. Every function below is written to
 * make the unapproved charge impossible rather than merely discouraged.
 */

export const PARTS_POLICIES = ['none', 'included', 'quoted'] as const;
export type PartsPolicy = (typeof PARTS_POLICIES)[number];

export const isPartsPolicy = (v: unknown): v is PartsPolicy =>
  typeof v === 'string' && (PARTS_POLICIES as readonly string[]).includes(v);

/*
 * The two short free-text boxes in this file: the parts note, which sits in a
 * booking summary and is a contract if it runs longer than this, and the quote
 * description, where "front pads and rotors, ceramic" is the job and a parts
 * list is not.
 *
 * Both were declared here at 300, estimates.ts declared its description at 300,
 * online.ts declared its note at 300, and none of the four knew about the
 * others. They are MAX_NOTE_CHARS in ./util now — one number, one decision:
 * a sentence or two of context, not a document.
 */

/**
 * How long a quote stays approvable: three days.
 *
 * Not open-ended, because a live quote is a standing authorisation to charge
 * somebody and part prices move. Not an hour either: the customer may be at
 * work while their car is being looked at, and a quote that dies before they
 * read it means the operator sits there resending it.
 */
const QUOTE_TTL_SECONDS = 3 * 24 * 60 * 60;

/**
 * Nobody quotes a part costing more than this on a mobile job. It is a typo
 * guard, and it is a guard on THE WHOLE QUOTE — see sendQuote.
 */
const MAX_QUOTE_CENTS = 5_000_00;

export interface PartsFields {
  parts_policy: PartsPolicy;
  parts_note: string | null;
  parts_estimate_low_cents: number | null;
  parts_estimate_high_cents: number | null;
}

export interface PartsQuote {
  id: string;
  order_item_id: string;
  operator_id: string;
  thread_id: string | null;
  description: string;
  parts_cents: number;
  labor_cents: number;
  total_cents: number;
  currency: string;
  status: 'sent' | 'approved' | 'declined' | 'withdrawn' | 'expired';
  expires_at: number | null;
  decided_at: number | null;
  /** When the card was actually charged for it. NULL means no money has moved. */
  charged_at: number | null;
  /**
   * How many times Stripe has received this charge and refused it, and what it
   * said the last time. Both are on the row both sides read, because the
   * alternative is a quote stuck at 'sent' that looks exactly like one the
   * customer has not got round to answering — while the operator stands next to
   * the car wondering whether to fit the part. See migration 0046.
   */
  charge_attempts: number;
  charge_error: string | null;
  /**
   * The Refund that gave this part's money back: 're_...'. A part is its own
   * charge against its own intent, so undoing one is its own refund and cannot
   * ride along inside the booking's. See sweepPartsRefunds in checkout.ts.
   */
  refund_id: string | null;
  refunded_at: number | null;
  refund_attempts: number;
  refund_error: string | null;
  created_at: number;
  updated_at: number;
}

const QUOTE_FIELDS =
  `id, order_item_id, operator_id, thread_id, description, parts_cents, labor_cents,
   currency, status, expires_at, decided_at, charged_at, charge_attempts, charge_error,
   refund_id, refunded_at, refund_attempts, refund_error,
   created_at, updated_at`;

const withTotal = (r: Omit<PartsQuote, 'total_cents'>): PartsQuote =>
  ({ ...r, total_cents: r.parts_cents + r.labor_cents });

/**
 * Reads the parts half of a service form.
 *
 * One place, used by both the create and the update path, so an operator
 * cannot end up with a service whose policy was validated one way on Tuesday
 * and another way on Thursday.
 */
export function cleanPartsFields(b: Record<string, unknown>): PartsFields {
  const raw = b.parts_policy;
  // An unrecognised value falls back to 'none' rather than throwing. 'none' is
  // the policy that promises the customer the least, so a malformed request
  // can never accidentally attach "your bill may go up" to a car wash.
  const policy: PartsPolicy = isPartsPolicy(raw) ? raw : 'none';

  const note = typeof b.parts_note === 'string'
    ? b.parts_note.trim().slice(0, MAX_NOTE_CHARS) || null
    : null;

  const cents = (v: unknown): number | null => {
    if (v == null || v === '') return null;
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 0 && n <= MAX_QUOTE_CENTS ? n : null;
  };

  let low = cents(b.parts_estimate_low_cents);
  let high = cents(b.parts_estimate_high_cents);

  // A range is both numbers or neither. One alone renders as "$60–" and reads
  // as a broken page, which is worse than no estimate at all.
  if (low == null || high == null) { low = null; high = null; }
  // Swapped rather than rejected: somebody typing 400 then 40 meant a range,
  // and bouncing their form over field order helps nobody.
  if (low != null && high != null && low > high) { const t = low; low = high; high = t; }

  // An estimate only means anything when the part is the unknown. Carrying one
  // on a 'none' service would print a parts range under a car wash.
  if (policy !== 'quoted') { low = null; high = null; }

  return {
    parts_policy: policy,
    parts_note: note,
    parts_estimate_low_cents: low,
    parts_estimate_high_cents: high,
  };
}

/**
 * The single sentence a customer reads about parts, wherever they read it.
 *
 * Every surface — the slot page, the basket, the confirmation, the receipt —
 * calls this. Three different hand-written versions of "will my bill go up"
 * is three chances for one of them to be wrong, and the wrong one is the one
 * that gets screenshotted.
 */
export function partsLine(
  f: Pick<PartsFields, 'parts_policy' | 'parts_estimate_low_cents' | 'parts_estimate_high_cents'>,
  currency: string,
  locale = 'en-US',
): string | null {
  if (f.parts_policy === 'none') return null;
  if (f.parts_policy === 'included') return 'Parts are included in this price.';

  const range = f.parts_estimate_low_cents != null && f.parts_estimate_high_cents != null
    ? ` Most jobs land between ${formatMoney(f.parts_estimate_low_cents, currency, locale)}`
      + ` and ${formatMoney(f.parts_estimate_high_cents, currency, locale)} in parts.`
    : '';

  // Deliberately says what the money does, not just that parts exist. "Parts
  // extra" is what every shop sign says and it is why nobody trusts one.
  //
  // IT SAYS THE CHARGE HAPPENS, because it now does. This sentence used to end
  // "nothing is paid on this site yet, so you settle the price with them
  // directly" — which was the honest description of a product where approving
  // a quote moved no money at all and the operator had to ask for cash at the
  // door. decideQuote takes the approved amount off the card the booking was
  // made with, so the old wording would now be the dangerous kind of wrong: a
  // customer told they would settle up in person, whose card is then debited.
  return 'This price covers the labour. If the job needs a part, they will send you '
    + 'the price here and nothing is fitted until you approve it. Approving it '
    + 'charges the card you booked with, for that amount and nothing else.'
    + range;
}

// ---------------------------------------------------------------------------
// Who is allowed to touch a quote
// ---------------------------------------------------------------------------

interface ScopeItem {
  id: string;
  order_id: string;
  operator_id: string;
  appointment_id: string | null;
  starts_at: number;
  price_cents: number;
  parts_cents: number;
  cancelled_at: number | null;
  currency: string;
}

/**
 * Everything the holder of this guest link is allowed to see and answer.
 *
 * The secret in the link is the identity here, the same as on every other
 * guest route: approving a part is answering a question about a booking you
 * already have, and that never asks for a sign-in. That link points at a
 * thread, the thread
 * points at one appointment, and that appointment is one item in an order —
 * so the scope is every item in THAT order belonging to THAT thread's
 * operator. Scoping to the single appointment instead would look right and
 * quietly break the real case: two slots at the same business in one basket
 * share one conversation, and a quote raised on the second one would be
 * unanswerable.
 */
async function guestScope(env: Env, ref: ThreadRef) {
  const thread = await threadByToken(env, ref);
  if (!thread) return null;
  if (!thread.appointment_id) return { thread, items: [] as ScopeItem[] };

  const rows = await env.DB.prepare(
    `SELECT oi.id, oi.order_id, oi.operator_id, oi.appointment_id, oi.starts_at,
            oi.price_cents, oi.parts_cents, oi.cancelled_at, o.currency
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE oi.order_id = (SELECT order_id FROM order_items WHERE appointment_id = ? LIMIT 1)
        AND oi.operator_id = ?`,
  ).bind(thread.appointment_id, thread.operator_id).all<ScopeItem>();

  return { thread, items: rows.results ?? [] };
}

// ---------------------------------------------------------------------------
// The operator sends one
// ---------------------------------------------------------------------------

export interface SendQuoteInput {
  order_item_id: string;
  description: string;
  parts_cents: number;
  labor_cents?: number;
}

/**
 * Send a parts quote to the customer.
 *
 * Any live quote on the same booking is withdrawn in the same batch, which is
 * the whole reason this is a batch. Migration 0020 puts a unique index over
 * live quotes so only one can exist, but an insert that fails on that index
 * leaves the operator staring at an error with a stale number still live on
 * the customer's phone. Replacing it is what they meant: the corrected quote
 * is the one that counts, and the customer can only ever approve the number
 * currently on their screen.
 */
export async function sendQuote(
  env: Env, operatorId: string, input: SendQuoteInput,
): Promise<PartsQuote> {
  // Filtered like a chat message, because that is what it is: free text the
  // operator writes and the customer reads on their phone. It had no filter at
  // all, which made it the operator's own way out of the conversation the rest
  // of this product works to keep on the platform -- "the alternator is $340,
  // call me on 818 555 0199 and I'll do it cash on Saturday" arrived intact.
  const description = redactContact(
    (input?.description ?? '').trim().slice(0, MAX_NOTE_CHARS),
  ).body.trim();
  if (!description) {
    throw badRequest('Say what the parts are. A price on its own is not something '
      + 'anyone can agree to.', 'no_description');
  }

  const money = (v: unknown, label: string): number => {
    const n = Math.round(Number(v ?? 0));
    if (!Number.isFinite(n) || n < 0) throw badRequest(`That ${label} is not a number.`, 'bad_amount');
    if (n > MAX_QUOTE_CENTS) throw badRequest(`That ${label} looks like a typo.`, 'bad_amount');
    return n;
  };
  const parts = money(input?.parts_cents, 'parts price');
  const labor = money(input?.labor_cents, 'extra labour');
  if (parts + labor <= 0) {
    throw badRequest('A quote needs an amount. If there is nothing extra to pay, '
      + 'just send them a message.', 'empty_quote');
  }
  // ON THE SUM, because the sum is what gets charged. Checking each field on
  // its own made the ceiling $10,000 rather than $5,000 — a fat finger in both
  // boxes, or a decimal point in the wrong place twice, walked straight
  // through it. This is an off-session charge against a card nobody is looking
  // at, so the only thing standing between a typo and a five-figure debit is
  // this line.
  if (parts + labor > MAX_QUOTE_CENTS) {
    throw badRequest('That total looks like a typo. Check the figures and send '
      + 'it again.', 'bad_amount');
  }

  const itemId = (input?.order_item_id ?? '').trim();
  const item = await env.DB.prepare(
    `SELECT oi.id, oi.order_id, oi.operator_id, oi.appointment_id, oi.starts_at,
            oi.price_cents, oi.parts_cents, oi.cancelled_at, o.currency, o.guest_name
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE oi.id = ? AND oi.operator_id = ?`,
  ).bind(itemId, operatorId).first<ScopeItem & { guest_name: string | null }>();
  // Same answer for somebody else's booking as for one that does not exist.
  // Which order ids are real is not something an API should confirm.
  if (!item) throw notFound('That booking is not yours.');
  // quotableItems already excludes these, so the operator's own screen never
  // offers the button — but the screen is not the guard, and a quote raised
  // against a cancelled job is a live authorisation to charge somebody for
  // work nobody is going to do.
  if (item.cancelled_at) {
    throw conflict('That booking was cancelled, so there is nothing to quote for.',
      'was_cancelled');
  }

  const thread = await env.DB.prepare(
    `SELECT id FROM threads WHERE operator_id = ? AND appointment_id = ? LIMIT 1`,
  ).bind(operatorId, item.appointment_id).first<{ id: string }>();

  const op = await env.DB.prepare(
    `SELECT country, language, business_name FROM operators WHERE id = ?`,
  ).bind(operatorId).first<{ country: string; language: string; business_name: string }>();
  const locale = localeFor(op?.country ?? 'US', op?.language ?? 'en');

  const t = now();
  const quote: PartsQuote = {
    id: newId(),
    order_item_id: item.id,
    operator_id: operatorId,
    thread_id: thread?.id ?? null,
    description,
    parts_cents: parts,
    labor_cents: labor,
    total_cents: parts + labor,
    currency: item.currency,
    status: 'sent',
    expires_at: t + QUOTE_TTL_SECONDS,
    decided_at: null,
    charged_at: null,
    charge_attempts: 0,
    charge_error: null,
    refund_id: null,
    refunded_at: null,
    refund_attempts: 0,
    refund_error: null,
    created_at: t,
    updated_at: t,
  };

  const total = formatMoney(quote.total_cents, quote.currency, locale);
  const body = labor > 0
    ? `${op?.business_name ?? 'The business'} sent a quote: ${description} — `
      + `${formatMoney(parts, quote.currency, locale)} parts and `
      + `${formatMoney(labor, quote.currency, locale)} extra labour, ${total} in total. `
      + 'Nothing is fitted or charged until you approve it.'
    : `${op?.business_name ?? 'The business'} sent a quote: ${description} — ${total}. `
      + 'Nothing is fitted or charged until you approve it.';

  const writes = [
    // Withdrawn, not deleted. The customer may already have seen the old
    // number and asked about it, and a row that vanished cannot answer that.
    env.DB.prepare(
      `UPDATE parts_quotes SET status='withdrawn', decided_at=?, updated_at=?
        WHERE order_item_id=? AND status='sent'`,
    ).bind(t, t, item.id),
    env.DB.prepare(
      `INSERT INTO parts_quotes (id, order_item_id, operator_id, thread_id, description,
         parts_cents, labor_cents, currency, status, expires_at, decided_at, charged_at,
         created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,'sent',?,NULL,NULL,?,?)`,
    ).bind(quote.id, quote.order_item_id, quote.operator_id, quote.thread_id,
      quote.description, quote.parts_cents, quote.labor_cents, quote.currency,
      quote.expires_at, t, t),
  ];

  // The quote lands in the conversation as a message too, not only as a row.
  // The customer is not watching a bookings screen; they are looking at the
  // thread they have been using, and a quote that only exists in a panel they
  // have to go find is a quote nobody answers.
  if (quote.thread_id) {
    writes.push(env.DB.prepare(
      `INSERT INTO chat_messages (id, thread_id, sender, body, created_at)
       VALUES (?,?,'operator',?,?)`,
    ).bind(newId(), quote.thread_id, body, t));
    writes.push(env.DB.prepare(
      `UPDATE threads SET last_message_at=?, guest_unread = guest_unread + 1, updated_at=?
        WHERE id=? AND operator_id=?`,
    ).bind(t, t, quote.thread_id, operatorId));
  }

  await env.DB.batch(writes);
  return quote;
}

/** The operator takes a quote back before it is answered. */
export async function withdrawQuote(
  env: Env, operatorId: string, quoteId: string,
): Promise<void> {
  const t = now();
  const res = await env.DB.prepare(
    `UPDATE parts_quotes SET status='withdrawn', decided_at=?, updated_at=?
      WHERE id=? AND operator_id=? AND status='sent'`,
  ).bind(t, t, quoteId, operatorId).run();
  if ((res.meta.changes ?? 0) === 0) {
    throw conflict('That quote has already been answered.', 'quote_decided');
  }
}

// ---------------------------------------------------------------------------
// The customer answers it
// ---------------------------------------------------------------------------

/** Who the second charge is made against, and with what. */
interface Payer {
  /** The card copied onto the order at checkout: 'pm_...'. See orders.ts. */
  payment_ref: string | null;
  /** Who they are at Stripe: 'cus_...'. A saved card can only be used with it. */
  stripe_customer_id: string | null;
  email: string | null;
}

/** What the second charge produced, once it has actually taken the money. */
interface Charged {
  payment_intent_id: string;
  charge_id: string | null;
}

/**
 * Records a charge Stripe refused, so a quote that did not go through looks
 * like one.
 *
 * The operator is standing next to the car deciding whether to fit the part.
 * "Their card was declined" is the only sentence that helps them, and a quote
 * that silently stayed 'sent' tells them nothing at all — it looks identical to
 * a customer who has not got round to answering.
 *
 * THE ATTEMPT COUNTER ONLY MOVES ON A DEFINITE REFUSAL, exactly as
 * recordRefundFailure's does and for the same reason: a refusal means Stripe
 * read the request and created nothing, so the next attempt is safe under a
 * fresh idempotency key — which is what stops a nine-in-the-morning decline
 * being replayed at somebody who has since fixed their card. Anything else is
 * an outcome nobody knows, so the counter stays put and the retry goes out
 * under the SAME key, where Stripe deduplicates it instead of charging one
 * alternator twice. Migration 0046 has the long version.
 *
 * WHICH FAILURES ARE REFUSALS IS STRIPE'S ANSWER, NOT THE STATUS CODE'S, and
 * reading the status range got the two most dangerous cases exactly backwards.
 * A 409 is Stripe saying the same idempotency key is STILL IN FLIGHT and a 429
 * is a rate limit — neither is a decline, and counting either as one moves the
 * key so the next tap is a brand new charge for money that is already moving.
 * A customer double-tapping approve on a $340 part with one bar of signal is
 * precisely the sequence that produces a 409, and it produced two charges. See
 * stripeRefused in stripe.ts.
 */
async function recordChargeFailure(
  env: Env, quoteId: string, err: unknown,
): Promise<void> {
  const refused = stripeRefused(err);
  const message = `${(err as Error)?.message ?? 'The card was refused.'}`.slice(0, 300);
  console.error('parts charge failed', quoteId, message);
  await env.DB.prepare(
    `UPDATE parts_quotes SET charge_error = ?, charge_attempts = charge_attempts + ?,
       updated_at = ?
      WHERE id = ? AND charged_at IS NULL AND status = 'sent'`,
  ).bind(message, refused ? 1 : 0, now(), quoteId).run();
}

/**
 * Takes the approved amount off the card the booking was made with.
 *
 * FOR EXACTLY `amount`, WHICH IS READ OFF THE ROW THE CUSTOMER TAPPED. Not a
 * recalculated figure, not the operator's current price list, not a total with
 * anything else folded into it. That is the one promise this whole file exists
 * to keep, and it is the reason the amount is passed in from the row rather
 * than worked out again here.
 *
 * THE CARD IS THE ORDER'S, NOT THE ACCOUNT'S. orders.payment_ref was copied at
 * checkout precisely so a later charge cannot quietly follow whichever card is
 * on the account today — see the note above the INSERT in placeOrder. The
 * Stripe customer does come off the account, because that is the only place it
 * lives and it is the filing cabinet the card sits in rather than the card.
 *
 * RETURNS NULL WHEN THIS DEPLOYMENT CANNOT CHARGE AT ALL. With no Stripe key
 * nothing on the site takes money — the booking itself cannot be paid for
 * either — so refusing the approval would break the flow for a deployment that
 * was never charging anybody, rather than protect somebody. On a deployment
 * that CAN charge, a booking with no card on it is refused instead: the
 * operator is about to fit a part on the platform's word that it will be paid
 * for, and recording an approval nothing can collect is how that promise gets
 * broken quietly.
 *
 * NO PLATFORM FEE ON PARTS. The fee is for the introduction, and a part is
 * money the operator laid out on the customer's behalf — the same reason
 * leadFeeCents refuses to read the parts total.
 */
async function chargeApprovedQuote(
  env: Env, quote: Omit<PartsQuote, 'total_cents'>, orderId: string, amount: number,
): Promise<Charged | null> {
  if (!stripeConfigured(env)) return null;

  const payer = await env.DB.prepare(
    `SELECT o.payment_ref, o.email, a.stripe_customer_id
       FROM orders o
       LEFT JOIN customer_accounts a ON a.id = o.customer_account_id
      WHERE o.id = ?`,
  ).bind(orderId).first<Payer>();

  if (!payer?.payment_ref || !payer.stripe_customer_id) {
    throw conflict(
      'We cannot charge a card for this booking, so there is nothing to approve '
      + 'here. Add a card to your account and ask them to send the quote again.',
      'no_card_on_file',
    );
  }

  let intent;
  try {
    intent = await createPaymentIntent(env, {
      orderId,
      amountCents: amount,
      currency: quote.currency,
      feeCents: 0,
      customerEmail: payer.email,
      customerId: payer.stripe_customer_id,
      approvedParts: {
        quoteId: quote.id,
        paymentMethodId: payer.payment_ref,
        attempt: quote.charge_attempts,
      },
    });
  } catch (err) {
    await recordChargeFailure(env, quote.id, err);
    // STRIPE'S OWN SENTENCE, HANDED STRAIGHT ON. Left as a StripeError this
    // leaves the router at a 500 reading "Something went wrong." — to a
    // customer whose bank has just declined a card, which is both untrue and
    // unactionable. Stripe writes these messages for the person who caused the
    // problem ("Your card was declined", "Your card has insufficient funds")
    // and they are the best sentence available. 402 because that is the status
    // this product already uses when a card is what is missing; see
    // CARD_REQUIRED in index.ts.
    if (err instanceof StripeError) {
      throw new HttpError(402,
        `${err.message} Nothing has been approved and nothing has been fitted. `
        + 'Try another card on your account and tap approve again.',
        err.code ?? 'charge_failed');
    }
    throw err;
  }

  // ANYTHING BUT 'succeeded' IS A FAILURE HERE, and that is stricter than the
  // checkout charge on purpose. This one is confirmed in the same request, with
  // nobody at a card form: a card that comes back wanting a second factor has
  // no screen to show it on, and there is no webhook that would ever finish it
  // — /webhooks/stripe resolves an intent to an ORDER, and this intent belongs
  // to a quote. Treating 'requires_action' as done would write charged_at
  // against money that never moved and pay the business out of a charge that
  // does not exist.
  //
  // The attempt counter deliberately does NOT move for this one. Stripe made an
  // intent and is holding it under that key, so a fresh key here would mean two
  // live intents for one part and a chance of both landing. The way out is a
  // new quote, which carries a new id and therefore a new key — which is what
  // the message asks for.
  if (intent.status !== 'succeeded') {
    await recordChargeFailure(env, quote.id, new Error(
      `The bank did not complete that payment (${intent.status}).`));
    throw conflict(
      'Your bank did not let that payment through. Nothing has been charged and '
      + 'nothing has been fitted — ask them to send the quote again, and it will '
      + 'go to whichever card is on your account then.',
      'charge_not_completed',
    );
  }

  // chargeIdOf, never String(). Stripe sends latest_charge as a bare id
  // normally and as an expanded charge object when anything asks it to, and
  // the string form of that object is the literal text "[object Object]" —
  // which reaches createTransfer as source_transaction and stops the business
  // being paid for the part at all. See stripe.ts.
  return { payment_intent_id: intent.id, charge_id: chargeIdOf(intent.latest_charge) };
}

/**
 * Approve or decline, authorised by nothing but the guest link.
 *
 * The status change is the money, and EVERY statement in the batch carries the
 * same `status='sent'` guard rather than only the one that flips it. That is
 * the whole correctness argument here and it used to be wrong: the flip was
 * first and guarded, the two `parts_cents = parts_cents + ?` statements
 * followed it unguarded, and a D1 batch is one transaction that commits
 * whatever its statements matched. So a customer double-tapping approve — on a
 * phone, on site, with one bar of signal — had the second tap add the parts a
 * second time and then be told the quote was already answered. That is the
 * difference between charging somebody $240 and charging them $480.
 *
 * The flip is therefore LAST. Every statement before it tests the row while it
 * still says 'sent'; the flip is what changes that, and its own change count
 * is what decides whether this call did anything at all.
 */
export async function decideQuote(
  env: Env, ref: ThreadRef, quoteId: string, decision: 'approved' | 'declined',
): Promise<PartsQuote> {
  if (decision !== 'approved' && decision !== 'declined') {
    throw badRequest('Approve it or decline it.', 'bad_decision');
  }

  const scope = await guestScope(env, ref);
  if (!scope) throw notFound('That link is not valid any more.');

  const row = await env.DB.prepare(
    `SELECT ${QUOTE_FIELDS} FROM parts_quotes WHERE id = ?`,
  ).bind(quoteId).first<Omit<PartsQuote, 'total_cents'>>();
  if (!row || !scope.items.some((i) => i.id === row.order_item_id)) {
    throw notFound('That quote is not on your booking.');
  }

  const t = now();
  if (row.status !== 'sent') {
    throw conflict(
      row.status === 'withdrawn'
        ? 'The business took that quote back. They will send a new one.'
        : `That quote was already ${row.status}.`,
      'quote_decided',
    );
  }
  if (row.expires_at != null && row.expires_at <= t) {
    throw conflict('That quote has expired. Ask them to send a fresh one — '
      + 'part prices move.', 'quote_expired');
  }

  const item = scope.items.find((i) => i.id === row.order_item_id)!;
  // Approving parts for a job that was cancelled underneath the quote would
  // put money owed on a booking nobody is going to do. Declining is still
  // allowed: closing a stale quote is always safe.
  if (decision === 'approved' && item.cancelled_at) {
    throw conflict('That booking was cancelled, so there is nothing to approve.',
      'was_cancelled');
  }
  const amount = row.parts_cents + row.labor_cents;

  /** "…and only while that quote still says 'sent'." Appended to every write. */
  const stillSent = `EXISTS (SELECT 1 FROM parts_quotes q WHERE q.id = ? AND q.status = 'sent')`;

  const writes: D1PreparedStatement[] = [];
  let charged: Charged | null = null;

  if (decision === 'approved') {
    // -------------------------------------------------------------------
    // THE SECOND CHARGE. The first is at checkout, for the labour the
    // customer agreed to then; this is the other one, and it is the only
    // other one.
    //
    // BEFORE THE BATCH, DELIBERATELY. If the card is refused, nothing below
    // this line runs: the quote stays 'sent', the parts are not added to
    // anybody's total, and the customer is told their bank said no rather
    // than being shown an approval that quietly collected nothing. An
    // approval that looks identical whether or not the money arrived is the
    // exact state this is replacing.
    //
    // A DOUBLE TAP CANNOT CHARGE TWICE even though this runs before the
    // status guard has had its say. Both taps read the same row, so both
    // send the same idempotency key — `pq:<quote>:<attempts>` — and Stripe
    // answers the second with the first one's intent rather than making
    // another. Only one of them then wins the guarded flip at the bottom;
    // the loser is told the quote was already answered, which it was.
    //
    // AND IF THE BATCH FAILS AFTER THE MONEY MOVED, the quote is still
    // 'sent' with the same attempt count, so the next tap sends the same key
    // and Stripe hands back the charge that already happened. It is recorded
    // on the second attempt instead of the first, and nobody pays twice.
    // -------------------------------------------------------------------
    charged = await chargeApprovedQuote(env, row, item.order_id, amount);

    writes.push(env.DB.prepare(
      `UPDATE order_items SET parts_cents = parts_cents + ?
        WHERE id = ? AND ${stillSent}`,
    ).bind(amount, item.id, quoteId));
    writes.push(env.DB.prepare(
      `UPDATE orders SET parts_cents = parts_cents + ?, updated_at = ?
        WHERE id = ? AND ${stillSent}`,
    ).bind(amount, t, item.order_id, quoteId));
  }

  const op = await env.DB.prepare(
    `SELECT country, language FROM operators WHERE id = ?`,
  ).bind(scope.thread.operator_id).first<{ country: string; language: string }>();
  const locale = localeFor(op?.country ?? 'US', op?.language ?? 'en');
  const money = formatMoney(amount, row.currency, locale);

  // Written into the transcript as the customer, because the customer is who
  // decided. An operator scrolling back is reading a conversation, and "you
  // said yes on the 3rd" has to be visible in it.
  if (row.thread_id) {
    writes.push(env.DB.prepare(
      `INSERT INTO chat_messages (id, thread_id, sender, body, created_at)
       SELECT ?,?,'guest',?,? WHERE ${stillSent}`,
    ).bind(newId(), row.thread_id,
      decision === 'approved'
        ? `Approved: ${row.description} — ${money}.`
        : `Declined: ${row.description} — ${money}.`,
      t, quoteId));
    writes.push(env.DB.prepare(
      `UPDATE threads SET last_message_at=?, operator_unread = operator_unread + 1,
         updated_at=? WHERE id=? AND ${stillSent}`,
    ).bind(t, t, row.thread_id, quoteId));
  }

  // Last, so everything above it saw the row as it was before the decision.
  //
  // The charge is written down in the same statement that records the decision,
  // because they are one fact: the customer said yes AND this is the money that
  // moved for it. An approved quote with charged_at still NULL means exactly one
  // thing — that this deployment cannot take cards at all — and that is the
  // report an operator can act on rather than a column they have to interpret.
  writes.push(env.DB.prepare(
    `UPDATE parts_quotes SET status=?, decided_at=?, updated_at=?,
       payment_intent_id=?, charge_id=?, charged_at=?, charge_error=NULL
      WHERE id=? AND status='sent'`,
  ).bind(decision, t, t, charged?.payment_intent_id ?? null,
    charged?.charge_id ?? null, charged ? t : null, quoteId));

  const res = await env.DB.batch(writes);
  if ((res[writes.length - 1]?.meta.changes ?? 0) === 0) {
    throw conflict('That quote was already answered.', 'quote_decided');
  }

  // After the batch. A notification that will not insert must never undo a
  // decision the customer already made — same rule as everywhere else here.
  await notify(env, row.operator_id, {
    kind: 'parts_quote',
    title: decision === 'approved'
      ? `${scope.thread.guest_name} approved ${money} of parts`
      : `${scope.thread.guest_name} declined the ${money} quote`,
    body: row.description,
    appointment_id: item.appointment_id,
    thread_id: row.thread_id,
    starts_at: item.starts_at,
  });

  return withTotal({
    ...row,
    status: decision,
    decided_at: t,
    updated_at: t,
    // The screen that showed the approve button is the one place a customer
    // looks for "did that just take my money", so the answer comes back with
    // the decision rather than a refresh later.
    charged_at: charged ? t : row.charged_at,
    charge_error: null,
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Every quote on this guest's booking, newest first, plus what is still answerable. */
export async function quotesForGuest(
  env: Env, ref: ThreadRef,
): Promise<{ quotes: PartsQuote[]; parts_cents: number }> {
  const scope = await guestScope(env, ref);
  if (!scope || scope.items.length === 0) return { quotes: [], parts_cents: 0 };

  const ids = scope.items.map((i) => i.id);
  const rows = await env.DB.prepare(
    `SELECT ${QUOTE_FIELDS} FROM parts_quotes
      WHERE order_item_id IN (${ids.map(() => '?').join(',')})
      ORDER BY created_at DESC, rowid DESC`,
  ).bind(...ids).all<Omit<PartsQuote, 'total_cents'>>();

  return {
    quotes: (rows.results ?? []).map(withTotal),
    parts_cents: scope.items.reduce((a, i) => a + i.parts_cents, 0),
  };
}

/** The operator's quotes, newest first. Scoped by operator_id, always. */
export async function quotesForOperator(
  env: Env, operatorId: string, opts: { order_item_id?: string; limit?: number } = {},
): Promise<PartsQuote[]> {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 100)), 200);
  const rows = opts.order_item_id
    ? await env.DB.prepare(
        `SELECT ${QUOTE_FIELDS} FROM parts_quotes
          WHERE operator_id = ? AND order_item_id = ?
          ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      ).bind(operatorId, opts.order_item_id, limit).all<Omit<PartsQuote, 'total_cents'>>()
    : await env.DB.prepare(
        `SELECT ${QUOTE_FIELDS} FROM parts_quotes
          WHERE operator_id = ?
          ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      ).bind(operatorId, limit).all<Omit<PartsQuote, 'total_cents'>>();
  return (rows.results ?? []).map(withTotal);
}

/**
 * The bookings an operator can raise a quote against.
 *
 * Every booked item, not only the ones whose services were marked 'quoted'.
 * Restricting it would look tidier and break the real case: a pressure washer
 * quoted 'none' finds the spigot is cracked. The promise to the customer is
 * not "we will never ask for more" — it is that they see and approve anything
 * extra before it happens, and that holds whatever the service said.
 */
export async function quotableItems(env: Env, operatorId: string, limit = 50) {
  const rows = await env.DB.prepare(
    `SELECT oi.id, oi.appointment_id, oi.starts_at, oi.ends_at, oi.price_cents,
            oi.parts_cents, oi.arrived_at, oi.code_verified_at, oi.cancelled_at,
            o.currency, o.guest_name,
            (SELECT GROUP_CONCAT(s.name, ' + ') FROM order_item_services s
              WHERE s.order_item_id = oi.id) AS services,
            (SELECT COUNT(*) FROM parts_quotes q
              WHERE q.order_item_id = oi.id AND q.status = 'sent') AS live_quotes,
            (SELECT t.id FROM threads t
              WHERE t.operator_id = oi.operator_id
                AND t.appointment_id = oi.appointment_id LIMIT 1) AS thread_id
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE oi.operator_id = ? AND o.status IN ('pending','confirmed')
        AND oi.cancelled_at IS NULL
      ORDER BY oi.starts_at DESC
      LIMIT ?`,
  ).bind(operatorId, Math.min(Math.max(1, Math.floor(limit)), 200)).all();
  return rows.results ?? [];
}

/**
 * Expires quotes nobody answered. Runs on the existing cron.
 *
 * A quote left 'sent' forever is a live authorisation to charge somebody for
 * parts priced weeks ago. Expiring it costs the operator one tap to resend and
 * removes a whole class of "I approved that ages ago, why is it different now".
 *
 * A QUOTE THAT HAS TOUCHED MONEY IS NEVER EXPIRED HERE. The approval takes the
 * money before the batch that records it — see decideQuote — so there is a
 * window, small but entirely real, where the customer's card has been charged
 * $340 and the row still says 'sent'. This sweep used to walk into that window
 * three days later and write 'expired' over it, and at that point the money
 * was unreachable: no approved quote to transfer, no charged_at to notice, and
 * a status that means "nothing happened". The two conditions below make that
 * impossible, and reconcileSentQuotes is what actually goes and finds the
 * charge rather than merely refusing to bury it.
 */
export async function expireQuotes(env: Env): Promise<number> {
  const t = now();
  const res = await env.DB.prepare(
    `UPDATE parts_quotes SET status='expired', updated_at=?
      WHERE status='sent' AND expires_at IS NOT NULL AND expires_at <= ?
        AND charged_at IS NULL AND payment_intent_id IS NULL`,
  ).bind(t, t).run();
  return res.meta.changes ?? 0;
}

/**
 * Finds the money for a quote that was charged and never written down.
 *
 * THE FAILURE THIS RECOVERS FROM IS ONE REQUEST LONG. chargeApprovedQuote
 * confirms the PaymentIntent in the same call that creates it, so Stripe has
 * the customer's $340 the instant it answers — and everything that records
 * that fact happens afterwards, in a batch that a killed isolate, an evicted
 * worker or a second of D1 being unavailable can lose. What is left is a
 * customer who has been charged and a quote that looks exactly like one nobody
 * got round to answering. Neither side of the conversation can tell.
 *
 * Nothing on the row can answer it, because the row is the thing that was not
 * written. So Stripe is asked, by the quote id that createPaymentIntent puts
 * into the intent's metadata for exactly this purpose, and an intent that says
 * 'succeeded' is recorded as the approval it always was — parts added to the
 * booking, the quote marked approved and charged, and the payout sweep free to
 * pay the business for it.
 *
 * Runs just before expireQuotes on the cron and looks only at quotes about to
 * be expired, which bounds it: a quote passes through this set once and then
 * leaves it in one direction or the other.
 */
export async function reconcileSentQuotes(env: Env, limit = 25): Promise<{
  checked: number; recovered: number;
}> {
  if (!stripeConfigured(env)) return { checked: 0, recovered: 0 };
  const t = now();
  const rows = await env.DB.prepare(
    `SELECT q.id, q.order_item_id, q.parts_cents + q.labor_cents AS amount_cents,
            i.order_id
       FROM parts_quotes q
       JOIN order_items i ON i.id = q.order_item_id
      WHERE q.status = 'sent' AND q.charged_at IS NULL AND q.payment_intent_id IS NULL
        AND q.expires_at IS NOT NULL AND q.expires_at <= ?
      ORDER BY q.expires_at
      LIMIT ?`,
  ).bind(t, Math.min(Math.max(1, Math.floor(limit)), 200)).all<{
    id: string; order_item_id: string; amount_cents: number; order_id: string;
  }>();

  let recovered = 0;
  const quotes = rows.results ?? [];
  for (const quote of quotes) {
    try {
      const intents = await paymentIntentsByMetadata(env, 'parts_quote_id', quote.id);
      const paid = intents.find((i) => i.status === 'succeeded');
      if (!paid) continue;

      // The same writes decideQuote makes, in the same order and under the
      // same guard: everything reads the row while it still says 'sent', and
      // the flip is last and is what decides whether this changed anything.
      const stillSent =
        `EXISTS (SELECT 1 FROM parts_quotes q WHERE q.id = ? AND q.status = 'sent')`;
      const res = await env.DB.batch([
        env.DB.prepare(
          `UPDATE order_items SET parts_cents = parts_cents + ?
            WHERE id = ? AND ${stillSent}`,
        ).bind(quote.amount_cents, quote.order_item_id, quote.id),
        env.DB.prepare(
          `UPDATE orders SET parts_cents = parts_cents + ?, updated_at = ?
            WHERE id = ? AND ${stillSent}`,
        ).bind(quote.amount_cents, t, quote.order_id, quote.id),
        env.DB.prepare(
          `UPDATE parts_quotes SET status='approved', decided_at=COALESCE(decided_at, ?),
             updated_at=?, payment_intent_id=?, charge_id=?, charged_at=?,
             charge_error=NULL
            WHERE id=? AND status='sent'`,
        ).bind(t, t, paid.id, chargeIdOf(paid.latest_charge), t, quote.id),
      ]);
      if ((res[2]?.meta?.changes ?? 0) > 0) {
        recovered += 1;
        console.warn(`recovered a parts charge nothing had written down: ${quote.id}`);
      }
    } catch (err) {
      // One quote Stripe will not answer about must not stop the rest, and it
      // must not be expired either — which is what the guard in expireQuotes
      // above is for.
      console.error('parts reconcile failed', quote.id, (err as Error).message);
    }
  }
  return { checked: quotes.length, recovered };
}

/** Re-exported so callers importing from here do not reach past this module. */
export { threadForOperator };
