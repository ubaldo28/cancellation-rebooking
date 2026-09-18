import type { Env } from '../types';
import { pepperedHash } from './redact';
import { DAY, HttpError, now } from './util';

/**
 * The longest window any caller of this module asks for, in seconds.
 *
 * A day, which is `otp-send-day:` and the new-accounts-per-day ceiling. The
 * sweep below leans on this number: a row older than the longest window in use
 * cannot belong to a window that is still counting, so deleting it can never
 * hand somebody back an allowance they had already spent.
 */
const MAX_WINDOW_SECONDS = DAY;

/**
 * How long past that a spent window is left alone before it is deleted.
 *
 * A day again, purely as slack. There is nothing to be gained by deleting a
 * dead counter at the earliest possible second, and a margin means a window
 * opened a moment before the sweep runs is never the one that gets cut short
 * if MAX_WINDOW_SECONDS is ever raised without this file being reread.
 */
const SWEEP_GRACE_SECONDS = DAY;

/**
 * Fixed-window rate limit backed by D1.
 *
 * Fixed windows allow a burst at a boundary — up to 2x the limit across two
 * adjacent windows. That is fine for what this guards (sign-in emails, offer
 * waves); it is not fine for anything metered by cost. Swap in Cloudflare's
 * rate-limiting binding or a Durable Object if that changes.
 *
 * This now guards the whole public surface, and the sentence above still holds
 * for almost all of it: twice as many map reads or guest polls in one unlucky
 * half-minute costs a few D1 reads and nothing else. The one place it does not
 * hold is address geocoding — a booking or an instant request with a street
 * address calls the US Census geocoder, which is somebody else's quota, and a
 * doubled burst there is a doubled bill against a service that can answer by
 * cutting us off. If that path ever gets hot, it is the one to move to a
 * Durable Object, not this whole file.
 */
export async function rateLimit(
  env: Env, key: string, limit: number, windowSeconds: number,
): Promise<{ ok: boolean; remaining: number; retryAfter: number }> {
  const t = now();
  const windowStart = t - (t % windowSeconds);

  // THE KEY IS NOT WHAT GOES IN THE TABLE, and it used to be.
  //
  // Look at what callers pass. `erase:<token>`, `thread-read:<token>`,
  // `guest-msg:<token>`, `offer-view:<token>`, `review:<token>`,
  // `watch-edit:<token>` and the rest are RAW BEARER SECRETS — the link that
  // opens a booking, which carries the address, the conversation, the
  // photographs and the door code. `auth:<email>`, `otp-send:<email>` and
  // `watch-email:<email>` are somebody's mailbox. Stored verbatim, and nothing
  // in this product ever deleted a row, that table was a plaintext list of
  // every working guest link whose page had been opened and every address that
  // had ever tried to sign in — readable from any copy of the database, and
  // flatly contrary to what the privacy page says about a booking link.
  //
  // Hashing here costs one digest per request and changes nothing about the
  // counting: the digest is stable, so the same caller lands in the same
  // bucket, and two different keys still cannot collide. What it removes is the
  // ability to read anything back out.
  const bucket = await pepperedHash(env, key);

  // Upsert-and-count in one statement so two concurrent requests cannot both
  // read 0 and both write 1.
  await env.DB.prepare(
    `INSERT INTO rate_limits (bucket_key, count, window_start)
     VALUES (?, 1, ?)
     ON CONFLICT(bucket_key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start = excluded.window_start
                    THEN rate_limits.count + 1 ELSE 1 END,
       window_start = excluded.window_start`,
  ).bind(bucket, windowStart).run();

  const row = await env.DB.prepare(
    `SELECT count FROM rate_limits WHERE bucket_key = ?`,
  ).bind(bucket).first<{ count: number }>();

  const count = row?.count ?? 1;
  return {
    ok: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfter: windowStart + windowSeconds - t,
  };
}

/**
 * A refusal that knows when the caller may come back.
 *
 * The number is already computed here and thrown away everywhere else, which
 * left a 429 with nothing but prose in it: a browser or a retrying client has
 * to guess, and guessing means hammering. Carrying it on the error is what
 * lets the entry point put a real Retry-After on the response.
 */
export class RateLimitedError extends HttpError {
  constructor(message: string, public readonly retryAfter: number) {
    super(429, message, 'rate_limited');
  }
}

export async function enforceRateLimit(
  env: Env, key: string, limit: number, windowSeconds: number,
): Promise<void> {
  const r = await rateLimit(env, key, limit, windowSeconds);
  if (!r.ok) {
    throw new RateLimitedError(`Too many attempts. Try again in ${r.retryAfter}s.`, r.retryAfter);
  }
}

/**
 * Counters whose window has long since closed.
 *
 * Nothing deleted from this table for the whole life of the product, so it grew
 * one permanent row per bucket key that had ever been used — which, with the
 * keys above, meant a permanent record that a particular mailbox tried to sign
 * in and that a particular booking link was opened, kept for no purpose at all
 * once the window it was counting had passed. Hashing the key stops it being
 * readable; this is what stops it being kept.
 *
 * Safe because of MAX_WINDOW_SECONDS: a row whose window began more than the
 * longest window ago cannot be one that is still counting, so this can never
 * hand a caller back an allowance they had already spent. The index on
 * window_start from migration 0003 is what makes it one scan of the tail
 * rather than of the table.
 */
export async function sweepRateLimits(env: Env): Promise<number> {
  const res = await env.DB.prepare(
    `DELETE FROM rate_limits WHERE window_start < ?`,
  ).bind(now() - MAX_WINDOW_SECONDS - SWEEP_GRACE_SECONDS).run();
  return res.meta?.changes ?? 0;
}

/**
 * The caller's address, as the edge saw it. ONE HEADER, AND NOT THE OBVIOUS ONE.
 *
 * THERE WAS A FALLBACK HERE AND IT WAS THE WHOLE DEFENCE WRITTEN IN PENCIL. It
 * read `cf-connecting-ip ?? x-forwarded-for.split(',')[0] ?? 'unknown'`, and the
 * middle term is a header the CALLER SENDS. Cloudflare does not replace
 * X-Forwarded-For, it APPENDS to whatever arrived — so the first comma-separated
 * entry, which is exactly the one that was being read, is a string the client
 * typed. Anywhere CF-Connecting-IP was missing for even one request shape, the
 * value returned here was chosen by the person being limited.
 *
 * What that is worth to an attacker is not "a slightly looser limit". Every
 * bucket in this product that is meant to bound an anonymous stranger is keyed
 * on this string — `order:`, `thread-ip:`, `otp-send-ip:`, `verify:`, `demo:`,
 * `map-postcode:`, `instant-ip:`, `watch-ip:`, `erase-ip:`, `link:watch:`,
 * `link:instant:` — and so is the wrong-guest-link lockout in ./guestlink.ts,
 * which is the only thing counting somebody walking the /c/:token space. A
 * caller who picks their own key has no ceiling at all on any of them: send a
 * fresh X-Forwarded-For per request and every request opens a brand new window
 * with a brand new allowance. The lockout in particular stops existing.
 *
 * So there is no fallback. CF-Connecting-IP is set by the edge on every request
 * that reaches a Worker through a route, it is stripped-and-rewritten rather
 * than trusted from the client, and it is the only header here that is evidence
 * of anything. Nothing else in this codebase reads X-Forwarded-For.
 *
 * WHEN IT IS ABSENT — a direct dispatch, a service binding, a unit test — this
 * returns the literal 'unknown', and every such caller therefore shares ONE
 * bucket. That is the safe direction and it is deliberate: a shared budget is a
 * ceiling that still exists, where an attacker-chosen key is no ceiling. It
 * fails closed on a caller we cannot identify rather than open.
 */
export const clientIp = (req: Request): string =>
  req.headers.get('cf-connecting-ip')?.trim() || 'unknown';
