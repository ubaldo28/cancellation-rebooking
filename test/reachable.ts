import type { Env } from '../src/types';
import { newId, now } from '../src/lib/util';

/**
 * Makes one of an operator's client rows REACHABLE, the way a real booking
 * does.
 *
 * WHY EVERY RANKING TEST NEEDS THIS NOW. A candidate used to be a client row
 * with a phone number and a consent flag on it, which a fixture could write in
 * one INSERT. It cannot be that any more: a customer this platform introduces
 * is stored with no number and no mailbox on purpose, so lib/rank.ts asks the
 * question that can actually be answered — is there a conversation to put an
 * offer in, and an account with a proved address to email about it. Those two
 * facts live in four other tables, and a fixture that skips them is a fixture
 * describing a customer this product cannot reach.
 *
 * WRITTEN AS ROWS RATHER THAN BY DRIVING THE CHECKOUT, unlike signInCustomer in
 * ./customer.ts, and the trade is deliberate. The checkout wants a gap, a
 * service, a card, an address that geocodes and a Turnstile secret out of the
 * way; a test about which of five people is offered a Tuesday afternoon should
 * not have to sell them all something first. What this does have to match is
 * the SHAPE the real path leaves behind — see the end of placeOrder in
 * src/lib/orders.ts — because that shape is what the queries join on.
 *
 * The four rows, and why each one is here:
 *
 *   customer_accounts  the person. `login_email` IS the account since
 *                      migration 0038 and `email_verified_at` is the proof
 *                      somebody typed a code back in; rank.ts refuses an
 *                      unverified address, so leaving it null is how you
 *                      write "this mailbox was never confirmed".
 *   orders             what ties that account to this operator's client row.
 *   order_items        the line carrying `client_id`, which is the only key
 *                      that leads from a client row back to the account. The
 *                      erasure sweep in lib/retention.ts uses the same one.
 *   threads            the conversation. An offer is a message in it, so a
 *                      client with no thread is not a candidate at all.
 */
export async function makeReachable(env: Env, o: {
  operator_id: string;
  client_id: string;
  /** The address the offer email goes to. One per person, not per booking. */
  email?: string;
  guest_name?: string;
  /** Leave the address unproved, the way an account that never verified is. */
  verified?: boolean;
  /** Skip the conversation, to test a client who has no channel. */
  thread?: boolean;
  at?: number;
}): Promise<{ account_id: string; thread_id: string; order_id: string; email: string }> {
  const t = o.at ?? now();
  const email = (o.email ?? `${o.client_id}@example.test`).toLowerCase();
  const name = o.guest_name ?? 'Customer';

  const existing = await env.DB.prepare(
    `SELECT id FROM customer_accounts WHERE login_email = ?`,
  ).bind(email).first<{ id: string }>();

  const accountId = existing?.id ?? newId();
  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO customer_accounts
         (id, login_email, email_verified_at, phone_e164, first_name, email,
          created_at, updated_at)
       VALUES (?,?,?,NULL,?,?,?,?)`,
    ).bind(accountId, email, o.verified === false ? null : t, name, email, t, t).run();
  }

  const orderId = newId();
  await env.DB.prepare(
    `INSERT INTO orders (id, status, customer_account_id, guest_name, login_email,
       currency, total_cents, created_at, updated_at)
     VALUES (?, 'confirmed', ?, ?, ?, 'USD', 0, ?, ?)`,
  ).bind(orderId, accountId, name, email, t, t).run();

  await env.DB.prepare(
    `INSERT INTO order_items (id, order_id, operator_id, client_id,
       starts_at, ends_at, duration_seconds, price_cents, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(newId(), orderId, o.operator_id, o.client_id,
    t - 86400, t - 86400 + 3600, 3600, 0, t).run();

  const threadId = newId();
  if (o.thread !== false) {
    await env.DB.prepare(
      `INSERT INTO threads (id, operator_id, client_id, guest_name, guest_token_hash,
         last_message_at, operator_unread, guest_unread, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,0,0,'open',?,?)`,
    ).bind(threadId, o.operator_id, o.client_id, name, `hash-${threadId}`, t, t, t).run();
  }

  return { account_id: accountId, thread_id: threadId, order_id: orderId, email };
}

/**
 * Captures every email the bulk lane sends while `fn` runs, and answers 200.
 *
 * Brevo rather than Resend, because that is the provider an offer's nudge goes
 * through: BULK_EMAIL_PROVIDER is what carries the mail nobody is sitting
 * waiting for, and a test that let these out through the sign-in provider
 * would pass while the rule the two lanes exist to enforce was broken.
 *
 * Anything that is not a Brevo send is handed to whatever stub was already in
 * place, so a test also stubbing something else keeps its own behaviour.
 */
export async function captureBulkEmail<T>(
  env: Env, fn: () => Promise<T>,
): Promise<{ result: T; sent: Array<{ to: string; subject: string; text: string }> }> {
  env.BULK_EMAIL_PROVIDER = 'brevo';
  env.BULK_EMAIL_API_KEY = 'xkeysib-test';
  env.BULK_EMAIL_FROM = 'Round The Way <hello@roundtheway.app>';

  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    if (url === 'https://api.brevo.com/v3/smtp/email') {
      const body = JSON.parse(String(init?.body ?? '{}'));
      sent.push({
        to: String(body?.to?.[0]?.email ?? ''),
        subject: String(body.subject ?? ''),
        text: String(body.textContent ?? ''),
      });
      return new Response('{"messageId":"m"}', {
        headers: { 'content-type': 'application/json' },
      });
    }
    return previous(input, init);
  }) as typeof fetch;

  try {
    return { result: await fn(), sent };
  } finally {
    globalThis.fetch = previous;
  }
}
