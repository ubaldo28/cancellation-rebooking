/**
 * THE BUSINESS'S SIDE OF THE MONEY: getting them a place to be paid into.
 *
 * A customer pays this platform; this platform pays the business. For the
 * second half to happen at all, each business needs its own connected account
 * at the processor — identity checked, bank details taken, all of it handled
 * by Stripe rather than by this product, which is the entire reason it is
 * Express and not something this codebase builds itself.
 *
 * THE ONE PLACE A REDIRECT IS CORRECT. Everywhere else in this product the
 * rule is that nobody leaves roundtheway.app to do anything with money —
 * customers pay on our own page and always will. Onboarding is different:
 * a self-employed person is handing a regulated company their identity
 * documents and their bank account, and that belongs on the regulated
 * company's page, under their name, with their compliance behind it. Taking
 * those details on our own form would mean holding them.
 *
 * FINISHING THIS IS WHAT UNLOCKS LISTING. bypass.ts refuses to publish an
 * opening for a business whose stripe_payouts_enabled is not 1, because a
 * customer pays this platform first: with no connected account there is money
 * coming in for a job with nowhere to send the business's share, and holding
 * somebody else's money is not a state this product should ever be able to
 * reach. A business that cannot be paid is not ready to be booked.
 *
 * settleOrder still skips an operator with no account and can be run again.
 * That is the safety net for an account that goes bad AFTER a booking — a
 * bank rejecting a payout, say — not the normal path.
 */

import type { Env } from '../types';
import {
  createAccountLink, createConnectAccount, getConnectAccount, stripeConfigured,
} from './stripe';
import { badRequest, now } from './util';

export interface ConnectStatus {
  /** Null until they have started. */
  account_id: string | null;
  /** Can this business be paid right now? */
  payouts_enabled: boolean;
  charges_enabled: boolean;
  /** They began onboarding and stopped partway. */
  started: boolean;
  /** When the two flags above were last refreshed from Stripe. */
  checked_at: number | null;
}

interface Row {
  id: string;
  email: string | null;
  country: string;
  stripe_account_id: string | null;
  stripe_charges_enabled: number;
  stripe_payouts_enabled: number;
  stripe_updated_at: number | null;
}

async function operatorRow(env: Env, operatorId: string): Promise<Row> {
  const row = await env.DB.prepare(
    `SELECT id, email, country, stripe_account_id, stripe_charges_enabled,
            stripe_payouts_enabled, stripe_updated_at
       FROM operators WHERE id = ?`,
  ).bind(operatorId).first<Row>();
  if (!row) throw badRequest('No such business.', 'no_operator');
  return row;
}

const toStatus = (row: Row): ConnectStatus => ({
  account_id: row.stripe_account_id,
  charges_enabled: row.stripe_charges_enabled === 1,
  payouts_enabled: row.stripe_payouts_enabled === 1,
  started: row.stripe_account_id != null && row.stripe_payouts_enabled !== 1,
  checked_at: row.stripe_updated_at,
});

/**
 * What we last heard from Stripe about this business, without asking again.
 *
 * Reads the cached flags. Every screen that merely DISPLAYS whether somebody
 * can be paid uses this; anything that actually moves money re-reads Stripe,
 * because a stale yes here would mean a transfer failing after the customer
 * has already been charged.
 */
export async function connectStatus(env: Env, operatorId: string): Promise<ConnectStatus> {
  return toStatus(await operatorRow(env, operatorId));
}

/** Writes Stripe's answer onto the operator row. */
export async function syncConnectAccount(
  env: Env, accountId: string,
  flags: { charges_enabled: boolean; payouts_enabled: boolean },
): Promise<void> {
  if (!accountId) return;
  await env.DB.prepare(
    `UPDATE operators
        SET stripe_charges_enabled = ?, stripe_payouts_enabled = ?,
            stripe_updated_at = ?, updated_at = ?
      WHERE stripe_account_id = ?`,
  ).bind(
    flags.charges_enabled ? 1 : 0,
    flags.payouts_enabled ? 1 : 0,
    now(), now(), accountId,
  ).run();
}

/** Asks Stripe directly and updates the cache. Used before money moves. */
export async function refreshConnectAccount(
  env: Env, operatorId: string,
): Promise<ConnectStatus> {
  const row = await operatorRow(env, operatorId);
  if (!row.stripe_account_id || !stripeConfigured(env)) return toStatus(row);

  const account = await getConnectAccount(env, row.stripe_account_id);
  await syncConnectAccount(env, account.id, {
    charges_enabled: account.charges_enabled,
    payouts_enabled: account.payouts_enabled,
  });
  return {
    account_id: account.id,
    charges_enabled: account.charges_enabled,
    payouts_enabled: account.payouts_enabled,
    started: !account.payouts_enabled,
    checked_at: now(),
  };
}

/**
 * Starts or resumes onboarding, and hands back the link to send them to.
 *
 * The connected account is created once and kept; the LINK is minted fresh
 * every time. Stripe expires these in minutes by design, so storing one would
 * guarantee a dead link for anybody who came back to it — which is exactly the
 * person most likely to have stopped halfway through.
 *
 * `refresh_url` is where Stripe sends somebody whose link expired mid-way. It
 * points back at the route that mints a new one, so an expired link is a
 * bounce the operator never sees rather than a dead end.
 */
export async function startOnboarding(
  env: Env, operatorId: string,
): Promise<{ url: string; account_id: string }> {
  if (!stripeConfigured(env)) {
    throw badRequest('Payouts are not switched on yet.', 'stripe_unconfigured');
  }
  const row = await operatorRow(env, operatorId);
  let accountId = row.stripe_account_id;

  if (!accountId) {
    const account = await createConnectAccount(env, operatorId, row.email, row.country);
    accountId = account.id;
    // Written before the link is minted. If the link call fails, the account
    // still exists and the unique index means the next attempt reuses it
    // rather than leaving orphaned accounts behind at the processor.
    await env.DB.prepare(
      `UPDATE operators SET stripe_account_id = ?, stripe_updated_at = ?, updated_at = ?
        WHERE id = ? AND stripe_account_id IS NULL`,
    ).bind(accountId, now(), now(), operatorId).run();
  }

  const base = (env.APP_URL ?? '').replace(/\/$/, '');
  const link = await createAccountLink(
    env, accountId,
    `${base}/api/stripe/onboard/refresh`,
    `${base}/app/settings?payouts=done`,
  );
  return { url: link.url, account_id: accountId };
}
