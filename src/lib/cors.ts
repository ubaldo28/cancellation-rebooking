import type { Env } from '../types';

/**
 * CORS for the dashboard.
 *
 * The dashboard sends its session as a cookie, so credentials must be allowed,
 * and that means the exact origin has to be echoed — `*` is rejected by every
 * browser when credentials are in play. So this is an allowlist, not a wildcard,
 * which is the correct posture anyway: a wildcard plus credentials would let
 * any site on the internet drive the operator's account.
 *
 * Public routes (the offer page at /o/:token, webhooks) are same-origin or
 * server-to-server and get no CORS headers at all.
 */

function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

export function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('origin');
  if (!origin) return {};
  const allowed = allowedOrigins(env);
  if (!allowed.includes(origin)) return { vary: 'Origin' };
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    vary: 'Origin',
  };
}

/** Preflight. Returns null when this is not an OPTIONS preflight request. */
export function preflight(req: Request, env: Env): Response | null {
  if (req.method !== 'OPTIONS') return null;
  const origin = req.headers.get('origin');
  if (!origin) return null;

  const headers: Record<string, string> = { vary: 'Origin' };
  if (allowedOrigins(env).includes(origin)) {
    Object.assign(headers, {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
      'access-control-allow-headers':
        req.headers.get('access-control-request-headers') ?? 'content-type',
      'access-control-max-age': '86400',
    });
  }
  return new Response(null, { status: 204, headers });
}

export function withCors(res: Response, req: Request, env: Env): Response {
  const extra = corsHeaders(req, env);
  if (Object.keys(extra).length === 0) return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
