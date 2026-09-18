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
 * The longest thing that could be a token, and anything longer is refused
 * without leaving this Worker.
 *
 * Cloudflare documents the response as at most 2048 characters. The field was
 * read straight off a JSON body and posted onward with no bound at all, which
 * made every challenged endpoint a free relay: `{"turnstile_token": "<a
 * megabyte of A>"}` is one cheap request in and a megabyte of OUR egress out
 * to siteverify, per attempt, before anything has been rate limited on the
 * result. Amplification aimed at our own bill, on the endpoints that exist to
 * stop people spending it.
 *
 * Doubled from the documented ceiling rather than set at it, so a longer token
 * format does not turn into every booking on the site being refused by a
 * constant in this file.
 */
const MAX_TOKEN_CHARS = 4096;

/**
 * How long siteverify gets to answer before this gives up on it.
 *
 * There was no bound, which is not the same as waiting forever politely: a
 * Worker request has a wall-clock budget and a fetch that never settles spends
 * all of it, so one unreachable-but-not-refusing dependency turns every
 * booking, sign-in code and alert sign-up into a request that hangs and then
 * dies with whatever the runtime chooses to say. Five seconds is far past a
 * normal answer from a Cloudflare endpoint on Cloudflare's own network, and a
 * timeout lands on the same fail-closed path as any other unreachability --
 * `turnstile_unavailable`, a 503, and a sentence the front end can show --
 * which is a refusal somebody can act on rather than a stall.
 */
const VERIFY_TIMEOUT_MS = 5_000;

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
 *
 * WHAT IS ACTUALLY OPEN WHILE IT IS OFF, written out rather than left to be
 * rediscovered. Six call sites, and the rate limit beside each one is the
 * WHOLE defence today. Every ceiling below is per address, so the cost of
 * multiplying it is the cost of renting hosts:
 *
 *   POST /api/customer/auth/code        Sends a six-digit code to any mailbox
 *                                       somebody names. 20 per address per 15
 *                                       minutes, against a provider allowance
 *                                       of ONE HUNDRED EMAILS A DAY shared
 *                                       with operator sign-in. Five hosts can
 *                                       spend the day's entire allowance
 *                                       before lunch, and sign-in then fails
 *                                       for every real customer and every real
 *                                       business. This is the worst of the six.
 *   POST /api/public/orders             A real booking: appointment rows, a
 *                                       conversation, mail, and a geocode of a
 *                                       street address against the US Census
 *                                       service. 10 per address per hour. A
 *                                       booking placed and then cancelled
 *                                       walks the refund ladder at the
 *                                       operator's expense, and enough of them
 *                                       walk a business into the suspension
 *                                       ladder — which is money off a real
 *                                       person, not just noise.
 *   POST /api/public/online/requests    Rings a working operator's phone and
 *                                       lights a five-minute fuse. 6 per
 *                                       address per 15 minutes, 20 per
 *                                       operator per 15 minutes. The per-
 *                                       operator bucket is what stops this
 *                                       being a paging attack on one business;
 *                                       it is also what a spread of hosts
 *                                       cannot get round, so this one degrades
 *                                       least badly.
 *   POST /api/public/watches            Creates a standing instruction to
 *                                       email an address nobody proved they
 *                                       own, and sends a confirmation to it.
 *                                       10 per address per hour, 5 per target
 *                                       mailbox per hour.
 *   POST /api/public/threads            Opens a conversation in a business's
 *   POST /api/public/profile/:slug/…    inbox from nothing but a name. 10 per
 *                                       address per 15 minutes, 40 per
 *                                       business, plus the distinct-businesses
 *                                       ceiling in ./chat.ts. Cheap for us,
 *                                       and an inbox somebody has to read.
 *
 * The ranking is not a suggestion to protect one and not the others — it is
 * what to expect to see first. Setting the secret closes all six at once.
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

  // Refused HERE rather than at siteverify, because the point is not to learn
  // that it is invalid -- it is not to spend our own egress finding out. See
  // MAX_TOKEN_CHARS. The caller gets the same sentence a forged token gets: a
  // prober who can tell "too long" from "wrong" has been handed the shape of
  // the check for free.
  if (token.length > MAX_TOKEN_CHARS) {
    console.error(`turnstile token rejected unsent: ${token.length} chars`);
    throw new HttpError(
      400,
      'That security check did not pass. Try again.',
      'turnstile_failed',
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
    const res = await fetch(SITEVERIFY, {
      method: 'POST',
      body: form,
      // See VERIFY_TIMEOUT_MS. An abort surfaces as a rejected fetch, so it
      // arrives in the same catch as a refused connection and gets the same
      // fail-closed answer -- there is deliberately no separate branch making
      // "slow" mean something different from "unreachable".
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
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
