import type { Env } from '../types';
import { HttpError, now } from './util';

/**
 * Fixed-window rate limit backed by D1.
 *
 * Fixed windows allow a burst at a boundary — up to 2x the limit across two
 * adjacent windows. That is fine for what this guards (sign-in emails, offer
 * waves); it is not fine for anything metered by cost. Swap in Cloudflare's
 * rate-limiting binding or a Durable Object if that changes.
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

export async function enforceRateLimit(
  env: Env, key: string, limit: number, windowSeconds: number,
): Promise<void> {
  const r = await rateLimit(env, key, limit, windowSeconds);
  if (!r.ok) {
    throw new HttpError(429, `Too many attempts. Try again in ${r.retryAfter}s.`, 'rate_limited');
  }
}

/** Best-effort client IP. Cloudflare sets CF-Connecting-IP and it cannot be spoofed at the edge. */
export const clientIp = (req: Request): string =>
  req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
