import type { Env } from '../types';
import { HttpError, now } from './util';

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

  // Upsert-and-count in one statement so two concurrent requests cannot both
  // read 0 and both write 1.
  await env.DB.prepare(
    `INSERT INTO rate_limits (bucket_key, count, window_start)
     VALUES (?, 1, ?)
     ON CONFLICT(bucket_key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start = excluded.window_start
                    THEN rate_limits.count + 1 ELSE 1 END,
       window_start = excluded.window_start`,
  ).bind(key, windowStart).run();

  const row = await env.DB.prepare(
    `SELECT count FROM rate_limits WHERE bucket_key = ?`,
  ).bind(key).first<{ count: number }>();

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

/** Best-effort client IP. Cloudflare sets CF-Connecting-IP and it cannot be spoofed at the edge. */
export const clientIp = (req: Request): string =>
  req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
