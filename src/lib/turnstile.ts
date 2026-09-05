import type { Env } from '../types';
import { HttpError } from './util';
import { clientIp } from './ratelimit';

/**
 * Cloudflare Turnstile, in front of the handful of public forms a script can
 * use to cost somebody money.
 *
 * The rate limits in ratelimit.ts stop one host doing a thing ten thousand
 * times. They do not stop ten thousand hosts doing it once each, and on this
 * product that is the attack that matters: a fake booking followed by a
 * cancellation walks the refund ladder and takes real money off the operator,
 * and a wave of them walks the business itself into the suspension ladder. A
 * limit counted per address cannot tell that story apart from a good day.
 *
 * Turnstile answers a different question — "was there a browser here" — which
 * is the question a rate limit cannot ask. It is free, it is native to
 * Workers, and it costs a real customer nothing they will notice.
 *
 * Which forms are behind this is decided in index.ts, not here. The rule used
 * there: a challenge belongs on the door, never in the corridor. Opening a
 * conversation, placing an order, ringing an operator's phone and creating a
 * standing instruction to send email are all doors. Sending the next chat
 * message on a job already paid for, polling for the van, confirming the
 * engineer arrived — those are the corridor, and a challenge in the middle of
 * a live job is worse than the abuse it prevents.
 */

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * The field name the client puts the token in.
 *
 * Turnstile's own widget names its hidden input `cf-turnstile-response`, which
 * is what arrives if a form is ever posted as multipart rather than JSON. Both
 * spellings are read so the two ways of sending it cannot drift apart.
 */
export const TOKEN_FIELDS = ['turnstile_token', 'cf-turnstile-response'] as const;

/** Pull the token out of a parsed body, whichever of the two names it used. */
export function tokenFromBody(b: Record<string, unknown> | null | undefined): string | null {
  if (!b) return null;
  for (const f of TOKEN_FIELDS) {
    const v = b[f];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return null;
}

/**
 * Is the protection actually on?
 *
 * DELIBERATE OFF-SWITCH, AND IT IS OFF RIGHT NOW. `TURNSTILE_SECRET` is not
 * set in any environment yet, and with it unset every call below returns
 * without contacting anybody: the endpoints behave exactly as they did before
 * this file existed, and the forms are as open to a script today as they were
 * yesterday. That is on purpose — it is what lets this ship before the key is
 * issued, and what keeps `wrangler dev` and the test suite working without one
 * — but nobody should read the existence of this module as the forms being
 * protected. They are not protected until somebody runs
 * `wrangler secret put TURNSTILE_SECRET`. Until then the only thing standing
 * in front of them is the rate limiting, which is the situation this was
 * written to fix.
 *
 * The client half has the matching switch (VITE_TURNSTILE_SITE_KEY in
 * web/src/lib/turnstile.ts). The two are independent by necessity — one is a
 * Worker secret, the other is baked into the bundle at build time — so they
 * are written to fail in the safe direction on either mismatch: no secret and
 * a site key means widgets that render and a token nobody checks, and a secret
 * with no site key means every submission is refused with a code the front end
 * turns into a sentence rather than a dead form.
 */
export const turnstileOn = (env: Env): boolean =>
  typeof env.TURNSTILE_SECRET === 'string' && env.TURNSTILE_SECRET.trim() !== '';

/** Cloudflare's answer, cut down to the parts anything here reads. */
interface SiteverifyResult {
  success: boolean;
  'error-codes'?: string[];
}

/**
 * Refuse the request unless a browser really did solve the challenge.
 *
 * Call this FIRST in a handler, before the row is written, the mail is queued
 * or the charge seam is touched. A verification that runs after the side
 * effect is not a gate, it is a log line.
 *
 * Throws 400 with a code the front end can act on:
 *   turnstile_missing      nothing was sent — the widget did not render, or
 *                          the caller is not a browser at all
 *   turnstile_failed       Cloudflare says no. Tokens are single-use and
 *                          short-lived, so a replayed or stale one lands here
 *                          as well as an outright forgery
 *   turnstile_unavailable  we could not reach siteverify
 *
 * That last one fails closed, which is a choice worth naming: an outage at
 * Cloudflare stops bookings rather than letting them through unchecked. The
 * alternative is a window where the protection is off precisely when somebody
 * watching would notice, and the thing being protected is money. If that
 * trade ever needs reversing in a hurry the lever is the off-switch above —
 * delete the secret and the whole check steps aside.
 */
export async function requireTurnstile(
  env: Env, req: Request, token: string | null,
): Promise<void> {
  if (!turnstileOn(env)) return;

  if (!token) {
    throw new HttpError(
      400,
      'We could not check that you are a person. Reload the page and try again.',
      'turnstile_missing',
    );
  }

  // The client IP is sent because Cloudflare scores the token against it.
  // Omitting it does not fail the check, it just makes it a weaker one.
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET!.trim());
  form.append('response', token);
  const ip = clientIp(req);
  if (ip !== 'unknown') form.append('remoteip', ip);

  let result: SiteverifyResult;
  try {
    const res = await fetch(SITEVERIFY, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`siteverify ${res.status}`);
    result = (await res.json()) as SiteverifyResult;
  } catch (err) {
    console.error('turnstile siteverify unreachable', err);
    throw new HttpError(
      503,
      'The security check is not answering right now. Try again in a moment.',
      'turnstile_unavailable',
    );
  }

  if (!result.success) {
    // Logged, never returned. The error codes name whether the secret is wrong
    // or the token was reused, which is an operator's problem to read in the
    // tail and not something to hand to whoever is probing the form.
    console.error('turnstile rejected', result['error-codes'] ?? []);
    throw new HttpError(
      400,
      'That security check did not pass. Try again.',
      'turnstile_failed',
    );
  }
}
