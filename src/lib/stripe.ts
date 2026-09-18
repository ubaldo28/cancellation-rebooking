/**
 * TALKING TO STRIPE, from a Worker.
 *
 * NO SDK. Stripe's node library assumes Node's http stack and pulls in a few
 * hundred kilobytes; a Worker has fetch and a size budget. Every call this
 * product makes is a form-encoded POST or a GET against api.stripe.com, so
 * that is all this file is.
 *
 * THE PAYMENT NEVER LEAVES THIS SITE. There is no Checkout Session here and
 * there must not be one: Stripe's hosted page redirects the customer off
 * roundtheway.app to pay, and that is explicitly not how this works. What the
 * browser gets instead is a PaymentIntent's client secret, which the embedded
 * payment form on our own page uses to take the card. Stripe sees the card;
 * this Worker never does, and lib/payments.ts enforces that no card data can
 * reach the database.
 *
 * HOW THE MONEY SPLITS. A basket can hold work from several businesses, and a
 * single charge can only have one destination — so this uses SEPARATE CHARGES
 * AND TRANSFERS. One PaymentIntent for the whole basket into the platform
 * account, then one Transfer per business for their share once the money has
 * settled. The fee is simply what is not transferred. That also means a
 * two-business basket is one card entry for the customer, which is the point.
 *
 * IDEMPOTENCY IS NOT OPTIONAL on anything that moves money. Every write below
 * takes a key derived from the thing being paid for, so a retried request — a
 * dropped connection, a webhook delivered twice — cannot charge or transfer
 * twice.
 */

import type { Env } from '../types';
import { badRequest } from './util';

const API = 'https://api.stripe.com/v1';

/**
 * Pinned, not floating. Stripe changes shapes between versions and an account
 * whose default version moves would silently change what this code receives.
 */
const API_VERSION = '2024-06-20';

export const stripeConfigured = (env: Env): boolean =>
  typeof env.STRIPE_SECRET_KEY === 'string' && env.STRIPE_SECRET_KEY.trim() !== '';

/** Stripe wants form encoding, including for nested objects and arrays. */
function form(data: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === 'object') {
          out.push(...form(item as Record<string, unknown>, `${key}[${i}]`));
        } else {
          out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`);
        }
      });
    } else if (typeof v === 'object') {
      out.push(...form(v as Record<string, unknown>, key));
    } else {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return out;
}

export class StripeError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly status: number,
    /**
     * Stripe's own classification of what went wrong: 'card_error',
     * 'invalid_request_error', 'idempotency_error', 'rate_limit_error',
     * 'api_error', 'authentication_error'. Carried because the status code on
     * its own cannot answer the only question that matters to a retry — did
     * Stripe create anything? See stripeRefused below.
     */
    readonly type: string | null = null,
  ) { super(message); }
}

/**
 * Types that mean Stripe read the request, decided against it, and created
 * nothing at all. Only these are safe to count as a definite refusal.
 */
const REFUSAL_TYPES = new Set(['card_error', 'invalid_request_error']);

/**
 * Codes that are a request in flight rather than a request refused, on the
 * rare deployment where Stripe sends them without a type.
 */
const IN_FLIGHT_CODES = new Set(['idempotency_key_in_use', 'lock_timeout', 'rate_limit']);

/**
 * Did Stripe definitely create nothing?
 *
 * THIS IS THE QUESTION THE ATTEMPT COUNTERS TURN ON, and it was being answered
 * with `status >= 400 && status < 500`, which gets two cases exactly backwards
 * and both of them charge somebody twice.
 *
 * A 409 is `idempotency_error`: the SAME key is still in flight, so there is
 * very probably a charge being created for it right now. A 429 is a rate
 * limit: the request never reached the thing that would have created anything,
 * but it may be through on the next attempt. Reading either as "refused" moves
 * the attempt counter, the counter moves the idempotency key, and the next
 * attempt is a brand new request for money that is already moving. A customer
 * double-tapping approve on a $340 part with one bar of signal is exactly how
 * that sequence happens in the real world.
 *
 * So the answer comes from Stripe's own classification. A card declined and a
 * request Stripe rejected as malformed are refusals — it evaluated them and
 * created nothing, and the retry needs a fresh key or it would be handed the
 * stored failure for the next 24 hours. Everything else, including anything
 * with no type at all on a 5xx, leaves the counter where it is so the retry
 * goes out under the same key and Stripe deduplicates it.
 */
export function stripeRefused(err: unknown): boolean {
  if (!(err instanceof StripeError)) return false;
  // Checked before anything else, because these two statuses are the ones the
  // old status-range test got wrong and no classification should be able to
  // talk them back into being refusals.
  if (err.status === 409 || err.status === 429) return false;
  if (err.type) return REFUSAL_TYPES.has(err.type);
  if (err.code && IN_FLIGHT_CODES.has(err.code)) return false;
  // No type at all. Stripe always sends one, so this is a proxy or an error
  // page rather than Stripe itself; the status range is the best left.
  return err.status >= 400 && err.status < 500;
}

/**
 * The one error that means "this key already made something, with different
 * parameters" — which is an answer about an object that EXISTS, not a failure.
 * The caller's job is to go and find it rather than to give up. See
 * findTransferFor and the transfer plan in checkout.ts.
 */
export function isIdempotencyConflict(err: unknown): boolean {
  return err instanceof StripeError
    && (err.type === 'idempotency_error' || err.status === 409);
}

/**
 * The charge id out of whatever Stripe put in `latest_charge`.
 *
 * It is a bare 'ch_...' string normally and a whole expanded charge object
 * when the account, the API version or a dashboard replay says to expand it.
 * `String(obj.latest_charge)` on the second of those writes the literal text
 * "[object Object]" into orders.charge_id — which then reaches createTransfer
 * as source_transaction, where Stripe rejects it, so the transfer silently
 * goes out unfunded instead. That is the one field stopping money moving
 * before the charge behind it has settled.
 */
export function chargeIdOf(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (value && typeof value === 'object') {
    const id = (value as { id?: unknown }).id;
    if (typeof id === 'string' && id.trim()) return id.trim();
  }
  return null;
}

async function call<T>(
  env: Env, method: 'GET' | 'POST', path: string,
  data?: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<T> {
  if (!stripeConfigured(env)) {
    throw badRequest('Payments are not configured on this deployment.', 'stripe_unconfigured');
  }
  const body = data ? form(data).join('&') : undefined;
  const headers: Record<string, string> = {
    authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    'stripe-version': API_VERSION,
  };
  if (body) headers['content-type'] = 'application/x-www-form-urlencoded';
  // Only ever on writes. Stripe rejects the header on GET.
  if (idempotencyKey && method === 'POST') headers['idempotency-key'] = idempotencyKey;

  const res = await fetch(`${API}${path}`, { method, headers, body });
  const json = await res.json().catch(() => ({})) as any;

  if (!res.ok) {
    const err = json?.error ?? {};
    throw new StripeError(
      // Stripe's own message is written for the person who caused the problem
      // and is usually the best one there is. Falls back rather than inventing.
      String(err.message ?? 'The payment provider refused that.'),
      err.code ? String(err.code) : null,
      res.status,
      err.type ? String(err.type) : null,
    );
  }
  return json as T;
}

// ---------------------------------------------------------------------------
// The businesses that get paid
// ---------------------------------------------------------------------------

export interface ConnectAccount {
  id: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
}

/**
 * Creates the connected account a business is paid into.
 *
 * EXPRESS, not Standard. A Standard account makes the operator sign up for
 * their own full Stripe dashboard, which for a solo detailer is a wall. Express
 * is Stripe's own hosted onboarding — identity, bank account, done — and it
 * leaves Stripe holding the compliance obligation rather than this product.
 *
 * The operator id goes in metadata so a connected account found in the Stripe
 * dashboard can always be traced back to a row here.
 *
 * THE IDEMPOTENCY KEY MOVES, and it has to. Stripe caches the response to a
 * key for 24 hours — FAILURES INCLUDED — so a key of nothing but the operator
 * id meant one 400, for any reason at all, was replayed at every later attempt
 * for the rest of the day. The operator sees "something went wrong", the cause
 * gets fixed, they try again, and Stripe hands back the same stored error
 * without the request ever arriving. That is not idempotency protecting
 * anyone; it is a business unable to get paid until tomorrow.
 *
 * A ten-minute bucket keeps what the key is actually for — a double click, or
 * a request retried after a dropped connection, must not create two accounts —
 * while letting a genuine later attempt through. Duplicates outside that
 * window cannot happen anyway: startOnboarding only creates when the row has
 * no account id, the UPDATE that stores it is conditional on the same, and a
 * unique index sits under both.
 */
const IDEMPOTENCY_BUCKET_SECONDS = 600;

export function createConnectAccount(
  env: Env, operatorId: string, email: string | null, country = 'US',
): Promise<ConnectAccount> {
  const bucket = Math.floor(Date.now() / 1000 / IDEMPOTENCY_BUCKET_SECONDS);
  return call<ConnectAccount>(env, 'POST', '/accounts', {
    type: 'express',
    country,
    email: email ?? undefined,
    business_type: 'individual',
    capabilities: {
      transfers: { requested: 'true' },
      card_payments: { requested: 'true' },
    },
    metadata: { operator_id: operatorId },
  }, `connect:${operatorId}:${bucket}`);
}

export function getConnectAccount(env: Env, accountId: string): Promise<ConnectAccount> {
  return call<ConnectAccount>(env, 'GET', `/accounts/${encodeURIComponent(accountId)}`);
}

/**
 * A one-time link into Stripe's hosted onboarding.
 *
 * This IS a redirect off the site, and it is the one place that is correct:
 * it is the business proving its own identity and bank details to a regulated
 * processor, not a customer paying. Short-lived by design — Stripe expires
 * these in minutes — so it is minted per click and never stored.
 */
export function createAccountLink(
  env: Env, accountId: string, refreshUrl: string, returnUrl: string,
): Promise<{ url: string; expires_at: number }> {
  return call(env, 'POST', '/account_links', {
    account: accountId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: 'account_onboarding',
  });
}

// ---------------------------------------------------------------------------
// The customer, and the card they leave on file
// ---------------------------------------------------------------------------

/**
 * Creates the customer a saved card hangs off.
 *
 * A card typed into a form belongs to that form and to nothing afterwards. To
 * charge it a second time — which is the entire reason a card is taken at
 * booking rather than on the doorstep — it has to be attached to something at
 * Stripe that outlives the form, and that something is a Customer: an object
 * with its own id, `cus_...`, which the saved payment method is filed under.
 *
 * ON THE PLATFORM ACCOUNT, NOT ON A BUSINESS'S. The platform is what charges
 * the customer — see the note at the top of this file about separate charges
 * and transfers — so the card has to be saved where the charge is made. A
 * customer created on a connected account would hold a card the account that
 * takes the money cannot use, and a basket spanning two businesses would need
 * the same card saved twice over.
 *
 * The account id goes in metadata for the same reason the operator id does on
 * a connected account: a customer found in the Stripe dashboard can always be
 * traced back to a row here, and nobody has to guess from an email address.
 *
 * The key is bucketed, exactly as createConnectAccount's is and for the reason
 * written out above it: a key of nothing but the account id would replay the
 * day's first failure at every later attempt, and somebody who could not add a
 * card at nine in the morning could not add one at all that day.
 */
export function createStripeCustomer(env: Env, input: {
  accountId: string;
  email: string | null;
  name?: string | null;
}): Promise<{ id: string }> {
  const bucket = Math.floor(Date.now() / 1000 / IDEMPOTENCY_BUCKET_SECONDS);
  return call<{ id: string }>(env, 'POST', '/customers', {
    email: input.email ?? undefined,
    name: input.name ?? undefined,
    metadata: { customer_account_id: input.accountId },
  }, `cus:${input.accountId}:${bucket}`);
}

/**
 * Asks Stripe for permission to keep the card, without charging it.
 *
 * A SetupIntent is the same embedded form as a payment, on the same page, for
 * the other half of the arrangement: the customer's bank is asked to authorise
 * a card being stored and used later rather than to move any money now. The
 * browser gets a client secret and nothing else, the card goes to Stripe, and
 * this Worker never sees it.
 *
 * `usage=off_session` is the part that decides whether the card can ever be
 * used again. It tells the bank the customer will not be sitting at the screen
 * when the charge comes, which is what a European card needs a second factor
 * for AT THIS MOMENT rather than at the moment of the charge — get it wrong and
 * the card saves fine and then declines the first time it is actually needed,
 * with the customer nowhere near their phone.
 *
 * allow_redirects=never for the same reason createPaymentIntent sets it: a
 * method that can only be finished on somebody else's site is not offered at
 * all, and nobody leaves roundtheway.app.
 *
 * NO IDEMPOTENCY KEY, DELIBERATELY, and this is the one write in this file that
 * must not have one. Stripe caches a key's response for 24 hours including its
 * failures — the story is written out above createConnectAccount — and every
 * reason a card form fails is a reason to try again in the next minute: a typo
 * in the number, a bank that declined, a customer who walked away and came
 * back. A key here would hand that person the same stored refusal until
 * tomorrow. Nothing is duplicated by the absence of one either: a setup intent
 * that is never confirmed takes no money, stores no card and costs nothing, so
 * a second one is simply a second attempt at typing a card.
 */
export function createSetupIntent(
  env: Env, customerId: string,
): Promise<{ id: string; client_secret: string }> {
  return call<{ id: string; client_secret: string }>(env, 'POST', '/setup_intents', {
    customer: customerId,
    usage: 'off_session',
    automatic_payment_methods: { enabled: 'true', allow_redirects: 'never' },
  });
}

/**
 * What card was actually saved, asked of Stripe rather than of the browser.
 *
 * The page knows the brand and the last four the moment the form succeeds and
 * could simply post them here — and they would be whatever the page said they
 * were. Nothing about that is checkable, so "Visa ending 4242" on somebody's
 * account would be a claim made by a browser about itself. Asking Stripe costs
 * one GET at the only moment it is needed and makes the two digits a person
 * recognises their card by a fact rather than a message.
 */
export function getPaymentMethod(env: Env, paymentMethodId: string): Promise<{
  id: string;
  card?: { brand?: string; last4?: string };
  /**
   * WHOSE CARD THIS IS: 'cus_...', or null for one attached to nobody.
   *
   * Stripe has always sent this field; only the type was missing, and a field
   * that is not in the type is a field no caller can reach. That is not a
   * cosmetic omission. A payment-method reference is not a secret — it comes
   * back to the browser from Stripe's own form and can be read out of any
   * account's own API response — so the only thing that makes 'pm_...' safe to
   * accept from a caller is checking it belongs to the customer making the
   * request. Without this field there was nothing to check it against, and
   * checkoutCard in index.ts wrote whatever reference it was handed onto the
   * caller's account: the real brand and last four of somebody else's card,
   * readable back out of GET /api/customer/payment-method. Stripe refuses the
   * charge, so no money moves — but the oracle is the leak, not the charge.
   *
   * Typed as a bare id rather than an object because nothing here expands it.
   * Optional because a payment method that has never been attached to a
   * customer has no value for it at all, which is a legitimate state and not
   * an answer we failed to get.
   */
  customer?: string | null;
}> {
  return call(env, 'GET', `/payment_methods/${encodeURIComponent(paymentMethodId)}`);
}

// ---------------------------------------------------------------------------
// Taking the money
// ---------------------------------------------------------------------------

export interface PaymentIntent {
  id: string;
  client_secret: string;
  status: string;
  amount: number;
  currency: string;
  /**
   * The charge this intent produced: 'ch_...'. Only present once the intent has
   * actually taken money, which for the checkout charge is a webhook away and
   * for the parts charge below is immediate, because that one is confirmed in
   * the same request. It is needed by name: a transfer that pays a business out
   * of a specific charge has to name it as source_transaction.
   *
   * Typed as either shape because Stripe sends either: a bare id normally, an
   * expanded charge object when something asked for one. Read it through
   * chargeIdOf and never with String(), which turns the second into the text
   * "[object Object]".
   */
  latest_charge?: string | { id?: string } | null;
  metadata?: Record<string, string> | null;
}

/**
 * The charge for one basket, taken on our own page.
 *
 * No `transfer_data` and no `on_behalf_of`: this is a plain charge into the
 * platform account, and the split happens afterwards as Transfers — see the
 * note at the top of this file about baskets spanning several businesses.
 *
 * automatic_payment_methods lets Stripe decide what to offer the customer
 * (card, Apple Pay, Link) from the embedded form, and `never` for redirects
 * keeps every one of them on this page. A method that can only be completed by
 * sending the customer to somebody else's site is not offered at all.
 */
export function createPaymentIntent(env: Env, input: {
  orderId: string;
  amountCents: number;
  currency: string;
  feeCents: number;
  customerEmail?: string | null;
  /**
   * The customer this charge belongs to at Stripe, when they have one.
   *
   * THIS IS WHAT MAKES THEM NOT TYPE THE CARD TWICE. They added a card at the
   * booking screen and it was filed under this id; naming it here means the
   * embedded form opens with that card already listed and a press of Pay is
   * the whole of what is left. Leave it out and the same person is asked for
   * the same card again, one screen later, which reads as the first attempt
   * having failed.
   */
  customerId?: string | null;
  /**
   * Set when this is the SECOND charge on a booking — the parts quote the
   * customer has just approved — rather than the one at checkout.
   *
   * The difference is that there is no card form in front of anybody. The
   * customer tapped approve in a message thread; the card was saved months or
   * minutes ago and is named here by its own reference, `confirm` takes the
   * money in this one request rather than handing a secret to a browser, and
   * `off_session` tells the bank the cardholder is not sitting at a screen —
   * which is the condition the card was stored under in the first place, see
   * createSetupIntent.
   *
   * THE KEY IS THE QUOTE, not the order: a booking can carry several quotes,
   * and an order-keyed charge would hand the second one a copy of the first —
   * the same bug createRefund was moved off the order for. `attempt` is what
   * gets a card that was DECLINED retried today rather than tomorrow; see the
   * note above createConnectAccount about a key caching its own failure for 24
   * hours, and migration 0046 for why it counts refusals rather than ticking.
   */
  approvedParts?: {
    quoteId: string;
    /** The card on file: 'pm_...', copied onto the order at checkout. */
    paymentMethodId: string;
    /** Definite refusals so far, exactly as createRefund's `attempt`. */
    attempt: number;
  } | null;
}): Promise<PaymentIntent> {
  const parts = input.approvedParts ?? null;
  return call<PaymentIntent>(env, 'POST', '/payment_intents', {
    amount: Math.round(input.amountCents),
    currency: input.currency.toLowerCase(),
    // Set on the intent so a payment found in the dashboard names the order it
    // belongs to, and so the webhook can find the order without a lookup table.
    // The quote id rides along on the second charge for the same reason: a
    // $340 debit next to a $120 one wants to say which part it was for.
    metadata: {
      order_id: input.orderId,
      fee_cents: String(Math.round(input.feeCents)),
      parts_quote_id: parts?.quoteId ?? undefined,
    },
    receipt_email: input.customerEmail ?? undefined,
    customer: input.customerId ?? undefined,
    payment_method: parts?.paymentMethodId ?? undefined,
    confirm: parts ? 'true' : undefined,
    off_session: parts ? 'true' : undefined,
    automatic_payment_methods: { enabled: 'true', allow_redirects: 'never' },
    // THE CHECKOUT KEY IS BUCKETED, exactly as createConnectAccount's and
    // createStripeCustomer's are, and for the story written out above the
    // first of them: Stripe caches a key's response for 24 hours WITH ITS
    // FAILURES, so a key of nothing but the order id meant one transient
    // refusal — a timeout at Stripe, a rate limit, a bad minute — locked that
    // basket out of being paid for until the following day. The customer sees
    // the same error every time they press Pay and there is nothing they can
    // do about it, because their request never leaves this Worker.
    //
    // A bucket is safe HERE in a way it would not be on the parts charge
    // below, and the difference is who confirms. This intent takes no money by
    // existing: it hands a client secret to a browser and the customer's own
    // confirmation is what charges the card. A second intent for one order is
    // therefore an abandoned object, not a second charge — and the order row
    // only ever holds one of them, which is the one the browser is given. The
    // parts charge confirms itself in this same request, so it counts refusals
    // instead; see `attempt` above.
  }, parts
    ? `pq:${parts.quoteId}:${parts.attempt}`
    : `pi:${input.orderId}:${Math.floor(Date.now() / 1000 / IDEMPOTENCY_BUCKET_SECONDS)}`);
}

export function getPaymentIntent(env: Env, id: string): Promise<PaymentIntent> {
  return call<PaymentIntent>(env, 'GET', `/payment_intents/${encodeURIComponent(id)}`);
}

/**
 * Moves an open intent to a different amount.
 *
 * Needed because a basket can shrink between the customer opening the payment
 * page and coming back to it — an operator cancels one of two jobs — and the
 * intent that was created for the old total is the one the browser is holding
 * a secret for. Creating a second intent instead would leave two live claims
 * on one order, so the one that exists is corrected in place.
 *
 * NO IDEMPOTENCY KEY. This is not a create: sending it twice sets the same
 * amount on the same object, and a key would only be able to hand back a
 * stale copy of it.
 */
export function updatePaymentIntent(env: Env, id: string, input: {
  amountCents: number;
  feeCents: number;
  orderId: string;
}): Promise<PaymentIntent> {
  return call<PaymentIntent>(env, 'POST', `/payment_intents/${encodeURIComponent(id)}`, {
    amount: Math.round(input.amountCents),
    metadata: {
      order_id: input.orderId,
      fee_cents: String(Math.round(input.feeCents)),
    },
  });
}

/**
 * The intents Stripe is holding that name this thing in their metadata.
 *
 * THE RECOVERY PATH FOR MONEY THAT MOVED AND WAS NOT WRITTEN DOWN. A parts
 * charge is confirmed inside one request: Stripe takes the money and this
 * Worker then writes the row. Between those two the Worker can be killed, the
 * database can refuse the write, or the isolate can be evicted — and what is
 * left is a customer who has been charged $340 and a quote that still says
 * 'sent', with nothing on it pointing at the charge. Asking Stripe what it
 * holds against the quote id is the only way back from that, and it is why the
 * quote id is put in the intent's metadata in the first place.
 */
export async function paymentIntentsByMetadata(
  env: Env, key: string, value: string,
): Promise<PaymentIntent[]> {
  const query = encodeURIComponent(`metadata['${key}']:'${value}'`);
  const res = await call<{ data?: PaymentIntent[] }>(
    env, 'GET', `/payment_intents/search?query=${query}&limit=10`,
  );
  return res.data ?? [];
}

/**
 * The refunds Stripe already holds against one charge.
 *
 * Read before a refund is RE-sent, never before the first attempt. Stripe's
 * idempotency keys only live for 24 hours, so a refund that succeeded and
 * whose write-back failed is protected by the key for a day and by nothing at
 * all after that — and the sweep runs every quarter of an hour forever. See
 * refundItem.
 */
export async function refundsForIntent(
  env: Env, paymentIntentId: string,
): Promise<Array<{ id: string; amount: number; status: string; metadata?: Record<string, string> }>> {
  const res = await call<{ data?: Array<{
    id: string; amount: number; status: string; metadata?: Record<string, string>;
  }> }>(
    env, 'GET',
    `/refunds?payment_intent=${encodeURIComponent(paymentIntentId)}&limit=100`,
  );
  return res.data ?? [];
}

// ---------------------------------------------------------------------------
// Paying the business
// ---------------------------------------------------------------------------

export interface Transfer { id: string; amount: number; destination: string }

/**
 * Moves one business's share out of the platform account and into theirs.
 *
 * Keyed on the ORDER ITEM, not the order: a basket with three businesses in it
 * makes three transfers, and each one must be independently retryable without
 * any chance of repeating another. `source_transaction` ties the transfer to
 * the charge that funded it, so Stripe will not move money the platform has
 * not actually received yet.
 */
export function createTransfer(env: Env, input: {
  orderItemId: string;
  amountCents: number;
  currency: string;
  destinationAccountId: string;
  chargeId?: string | null;
  /**
   * Set when this transfer is paying a business for an approved parts quote
   * rather than for the booking itself, which makes the QUOTE what the key is
   * built from.
   *
   * Parts cannot ride along inside the line's transfer, and the reason is
   * Stripe's own rule rather than a preference: a transfer naming a
   * source_transaction may not exceed that charge, and the part was paid for by
   * a second charge the labour's transfer knows nothing about. Two charges,
   * two transfers. Migration 0046 has the long version.
   */
  partsQuoteId?: string | null;
  /**
   * The key to send, when the caller has one written down.
   *
   * A labour transfer's amount is not fixed — it is the payout less whatever
   * the business owed at the moment it was worked out — so the key and the
   * amount have to be decided together and kept together, or a retry sends the
   * same key with a different figure and Stripe refuses it forever. checkout.ts
   * stores both on the row before this is called; see the transfer plan there.
   */
  idempotencyKey?: string | null;
}): Promise<Transfer> {
  return call<Transfer>(env, 'POST', '/transfers', {
    amount: Math.round(input.amountCents),
    currency: input.currency.toLowerCase(),
    destination: input.destinationAccountId,
    source_transaction: input.chargeId ?? undefined,
    metadata: {
      order_item_id: input.orderItemId,
      parts_quote_id: input.partsQuoteId ?? undefined,
    },
  }, input.idempotencyKey
    ?? (input.partsQuoteId ? `trp:${input.partsQuoteId}` : `tr:${input.orderItemId}`));
}

/**
 * The transfer Stripe already holds for one line, found by its metadata.
 *
 * The way out of an idempotency conflict. A key that has already made a
 * transfer under different parameters is Stripe telling us the money HAS gone
 * — refusing the new request is it protecting us — so the only correct
 * response is to find what it made and write that down. Sending nothing and
 * skipping, which is what happened before, leaves the payout permanently
 * unrecorded while the business has already been paid, and every later sweep
 * repeats the same refused request.
 *
 * Listed by destination because Stripe's search API does not cover transfers.
 * The window is generous and the match is on metadata, which is exactly the
 * field createTransfer puts the line id in.
 */
export async function findTransferFor(env: Env, input: {
  destinationAccountId: string;
  orderItemId: string;
  partsQuoteId?: string | null;
}): Promise<Transfer | null> {
  const res = await call<{ data?: Array<Transfer & { metadata?: Record<string, string> }> }>(
    env, 'GET',
    `/transfers?destination=${encodeURIComponent(input.destinationAccountId)}&limit=100`,
  );
  const wanted = input.partsQuoteId ?? null;
  return (res.data ?? []).find((t) => t.metadata?.order_item_id === input.orderItemId
    && (t.metadata?.parts_quote_id ?? null) === wanted) ?? null;
}

/**
 * Gives the money back.
 *
 * KEYED ON THE LINE, exactly as createTransfer is, and it used to be keyed on
 * the order and the amount. A basket can hold two jobs at the same price — the
 * same wash at the same business on two mornings is the ordinary case — and
 * cancelling both produced two refunds with identical keys. Stripe answered
 * the second one with a copy of the first instead of making it, so the customer
 * was refunded once for two cancellations and the second line came back
 * carrying a refund id that was already spoken for. A line is the thing that is
 * refunded, so a line is what the key is made of.
 *
 * The amount is out of the key for the same reason it went in: it made the key
 * move. A key that changes when the figure changes is not protecting anything
 * — it is two refunds waiting for somebody to recompute the ladder — and the
 * unique index on order_items.refund_id is what actually holds the line to one.
 *
 * `attempt` is how a refund Stripe REFUSED gets tried again today rather than
 * tomorrow. See the note above createConnectAccount about a key caching its own
 * failure for 24 hours; migration 0043 explains why this counts definite
 * refusals rather than ticking on a clock.
 */
export function createRefund(env: Env, input: {
  orderId: string;
  orderItemId: string;
  paymentIntentId: string;
  amountCents?: number | null;
  attempt?: number;
  reason?: 'requested_by_customer' | 'duplicate' | 'fraudulent';
  /**
   * Set when what is being given back is an approved PART rather than the
   * booking, which makes the QUOTE what the key is built from.
   *
   * A part is its own charge against its own intent, so its refund is its own
   * refund — and a line can carry several parts. Keying those on the line
   * would hand the second quote's refund a copy of the first one's and leave
   * the customer out of pocket for one of them, which is the same bug the
   * order-keyed refund had before it was moved onto the line.
   */
  partsQuoteId?: string | null;
}): Promise<{ id: string; amount: number; status: string }> {
  return call(env, 'POST', '/refunds', {
    payment_intent: input.paymentIntentId,
    amount: input.amountCents == null ? undefined : Math.round(input.amountCents),
    reason: input.reason ?? 'requested_by_customer',
    // So a refund found in the dashboard names the booking it undid, rather
    // than only the basket it was part of.
    metadata: {
      order_id: input.orderId,
      order_item_id: input.orderItemId,
      parts_quote_id: input.partsQuoteId ?? undefined,
    },
  }, input.partsQuoteId
    ? `rfp:${input.partsQuoteId}:${input.attempt ?? 0}`
    : `rf:${input.orderItemId}:${input.attempt ?? 0}`);
}
