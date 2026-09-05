import type { Env } from '../types';
import { threadByToken } from './chat';
import { RateLimitedError } from './ratelimit';
import { notFound, now } from './util';

/**
 * The lockout on guest links.
 *
 * /c/:token is bearer authority over a whole booking -- the address, the
 * conversation, the photographs taken inside somebody's house, the code that
 * gets a stranger through their front door -- held by a person with no account
 * and no password. The token is hashed in the database, which is right, and
 * until now it was also the entire defence: nothing counted a caller who tried
 * one token, then another, then another.
 *
 * This is order_items.code_attempts from 0026 wearing different clothes. A
 * wrong start code has a booking to be counted against. A wrong guest token
 * matches no row at all -- that is what makes it wrong -- so the only thing
 * left to count it against is where it came from.
 *
 * WHY THIS IS NOT THE RATE LIMIT THAT IS ALREADY HERE. The guest routes are
 * rate limited on the token: `thread-read:<token>` at 150 per five minutes,
 * `guest-msg:<token>` at 30 a minute. That is the right bucket for what those
 * were built to stop, because a whole household behind one address must not
 * share one budget and the link is the only identity a guest has. It is also
 * exactly why they cannot see a walk: every guess carries a different token,
 * so every guess opens a fresh bucket with a fresh allowance and no ceiling is
 * ever reached. A rate limit counts requests. This counts FAILURES, which is a
 * different measurement of a different thing, and a caller doing nothing wrong
 * never registers on it at all.
 */

/**
 * Wrong links before the door shuts.
 *
 * Ten, and it is deliberately generous rather than tight. The token is 32
 * random bytes, so this number is not what makes guessing hopeless -- the
 * arithmetic already did that -- it is what stops somebody spending a machine
 * on trying anyway, and what puts a bound on the damage if a shorter or
 * predictable token is ever introduced by accident. Set against that, the
 * people who legitimately present a link that does not resolve are customers
 * whose booking was cleaned up, or who copied half a URL out of an email, and
 * ten tries is well past where any of them would stop and ask.
 */
const MAX_FAILURES = 10;

/** Failures older than this are forgotten. Fifteen minutes. */
const WINDOW_SECONDS = 900;

/**
 * How long the door stays shut. Fifteen minutes, not an hour and not forever.
 *
 * The counter is keyed on an address, and an address is not a person: a café,
 * an office and anything behind CGNAT are all one row here. So the penalty is
 * set at the length that makes a walk pointless and a wrongly-caught bystander
 * merely annoyed, and it releases on its own with nobody having to ask.
 */
const LOCKOUT_SECONDS = 900;

interface AttemptRow {
  failures: number;
  window_started_at: number;
  locked_until: number | null;
}

/**
 * Refuses before anything is looked up, when this caller has been locked out.
 *
 * Before, deliberately. A lockout that still performs the lookup has made the
 * guess free again, and the whole point is that a guess has to cost the person
 * making it more than it costs us.
 */
export async function assertGuestLinkAllowed(env: Env, ip: string): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT failures, window_started_at, locked_until FROM guest_link_attempts WHERE ip = ?`,
  ).bind(ip).first<AttemptRow>();

  const t = now();
  if (row?.locked_until != null && row.locked_until > t) {
    const retryAfter = row.locked_until - t;
    // 429 with a Retry-After rather than a bare refusal, so a customer caught
    // by somebody else on their address is told when to come back instead of
    // reloading into the wall. The code is its own so this is distinguishable
    // in a log from the ordinary volume limits, which mean something else.
    const err = new RateLimitedError(
      'Too many links that did not work. Open the link from your confirmation '
      + `again in ${Math.ceil(retryAfter / 60)} minutes.`,
      retryAfter,
    );
    err.code = 'link_locked';
    throw err;
  }
}

/**
 * Counts one wrong link against this caller.
 *
 * Called only when a token resolved to nothing. A valid link never reaches
 * here, which is the property the guest page depends on: it polls its own
 * token every fifteen seconds for as long as the tab is open, and if success
 * counted for anything at all a customer sitting on their own booking would
 * eventually lock themselves out of it.
 */
export async function recordGuestLinkFailure(env: Env, ip: string): Promise<void> {
  const t = now();

  // One statement, so two requests arriving together cannot both read the same
  // count and both write count+1 -- the same reason rateLimit() upserts rather
  // than reads and writes.
  await env.DB.prepare(
    `INSERT INTO guest_link_attempts (ip, failures, window_started_at, locked_until)
     VALUES (?, 1, ?, NULL)
     ON CONFLICT(ip) DO UPDATE SET
       failures = CASE
         WHEN guest_link_attempts.window_started_at <= ? THEN 1
         ELSE guest_link_attempts.failures + 1 END,
       window_started_at = CASE
         WHEN guest_link_attempts.window_started_at <= ? THEN excluded.window_started_at
         ELSE guest_link_attempts.window_started_at END,
       -- An existing lockout is left alone rather than pushed further out on
       -- every request that arrives during it. Otherwise a script that keeps
       -- hammering after being stopped extends its own punishment without
       -- limit, which sounds satisfying and in practice only guarantees that
       -- the address it is sharing with a real customer never comes back.
       locked_until = CASE
         WHEN guest_link_attempts.locked_until IS NOT NULL
              AND guest_link_attempts.locked_until > ? THEN guest_link_attempts.locked_until
         WHEN (CASE WHEN guest_link_attempts.window_started_at <= ? THEN 1
                    ELSE guest_link_attempts.failures + 1 END) >= ? THEN ?
         ELSE NULL END`,
  ).bind(ip, t, t - WINDOW_SECONDS, t - WINDOW_SECONDS, t, t - WINDOW_SECONDS,
    MAX_FAILURES, t + LOCKOUT_SECONDS).run();
}

/**
 * The one gate every guest-link route goes through.
 *
 * It resolves the token itself rather than waiting to see what the handler
 * makes of it, because the handlers disagree about what an unknown token
 * means: some throw "that link is not valid any more", some return null and
 * some return an empty list, and a defence that has to recognise all three by
 * reading responses is a defence that quietly stops working the next time one
 * of them is reworded. The cost is one indexed existence check per guest
 * request, on top of the lookup the handler then does for itself. That is a
 * real duplicate and it is worth it: the alternative is threading a request
 * through every library function that takes a token.
 */
export async function guardGuestLink(env: Env, ip: string, rawToken: string): Promise<void> {
  await assertGuestLinkAllowed(env, ip);

  if (await threadByToken(env, rawToken)) return;

  await recordGuestLinkFailure(env, ip);
  // The same words an unknown token has always produced, and no hint that
  // anything is being counted. A walker who can tell "wrong" from "wrong, and
  // you have three left" has been handed the oracle this is meant to deny
  // them.
  throw notFound('That link is not valid any more.');
}

/**
 * Drops rows the window has moved past, on the cron.
 *
 * A row is only interesting while it is counting or while it is locking, and
 * once both have expired it is a permanent record that an address once
 * mistyped a link. There is no reason to keep that.
 */
export async function sweepGuestLinkAttempts(env: Env): Promise<void> {
  const t = now();
  await env.DB.prepare(
    `DELETE FROM guest_link_attempts
      WHERE window_started_at <= ? AND (locked_until IS NULL OR locked_until <= ?)`,
  ).bind(t - WINDOW_SECONDS, t).run();
}

/** Exported for the tests, so the numbers above are asserted rather than retyped. */
export const GUEST_LINK_LIMITS = {
  MAX_FAILURES, WINDOW_SECONDS, LOCKOUT_SECONDS,
} as const;
