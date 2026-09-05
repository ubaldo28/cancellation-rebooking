import type { Env, Operator } from '../types';
import {
  HttpError, newId, newToken, notFound, now, sha256, timingSafeEqual, unauthorized,
} from './util';

const SESSION_COOKIE = 'gf_session';
const SESSION_TTL = 60 * 60 * 24 * 30;   // 30 days
const LOGIN_TTL = 60 * 15;               // 15 minutes

const hashWithPepper = (token: string, env: Env) => sha256(`${token}:${env.SESSION_PEPPER}`);

/** Issues a magic-link token. Returns the RAW token — email it, never store it. */
export async function createLoginToken(env: Env, operatorId: string): Promise<string> {
  const raw = newToken();
  const t = now();
  await env.DB.prepare(
    `INSERT INTO login_tokens (id, operator_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(newId(), operatorId, await hashWithPepper(raw, env), t + LOGIN_TTL, t).run();
  return raw;
}

/** Consumes a magic-link token and returns a session cookie value. */
export async function consumeLoginToken(env: Env, raw: string, userAgent: string | null) {
  const t = now();
  const hash = await hashWithPepper(raw, env);
  const row = await env.DB.prepare(
    `SELECT id, operator_id FROM login_tokens
     WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
  ).bind(hash, t).first<{ id: string; operator_id: string }>();
  if (!row) throw new HttpError(400, 'That link has expired or was already used.');

  const sessionToken = newToken();
  const sessionHash = await hashWithPepper(sessionToken, env);

  // Single-use enforced by the WHERE clause: a replay finds consumed_at set.
  const res = await env.DB.batch([
    env.DB.prepare(`UPDATE login_tokens SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`)
      .bind(t, row.id),
    env.DB.prepare(
      `INSERT INTO sessions (id, operator_id, token_hash, user_agent, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(newId(), row.operator_id, sessionHash, userAgent, t + SESSION_TTL, t),
  ]);
  if ((res[0]?.meta.changes ?? 0) === 0) throw new HttpError(400, 'That link was already used.');

  return { operatorId: row.operator_id, cookie: sessionCookie(sessionToken) };
}

/**
 * Starts a signed-in session for an operator without a magic link.
 *
 * Only the demo sign-in uses this. Real sign-in still has to prove control of
 * the mailbox; this is deliberately not reachable from any email-based path.
 */
export async function createSession(
  env: Env, operatorId: string, userAgent: string | null, ttl = SESSION_TTL,
): Promise<string> {
  const token = newToken();
  const t = now();
  await env.DB.prepare(
    `INSERT INTO sessions (id, operator_id, token_hash, user_agent, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(newId(), operatorId, await hashWithPepper(token, env), userAgent, t + ttl, t).run();
  return sessionCookie(token, ttl);
}

export function sessionCookie(token: string, maxAge = SESSION_TTL): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
export const clearCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/**
 * Resolves the signed-in operator, or throws 401.
 *
 * `closed_at IS NULL` is in the WHERE clause and not a check afterwards.
 * Closing an account revokes its sessions, but a magic link already sitting in
 * a mailbox would otherwise mint a fresh one and sign somebody straight back
 * into an account whose personal columns have been emptied. Refusing at the
 * lookup closes both doors with one condition.
 */
export async function requireOperator(req: Request, env: Env): Promise<Operator> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) throw unauthorized();
  const op = await env.DB.prepare(
    `SELECT o.* FROM sessions s
       JOIN operators o ON o.id = s.operator_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
        AND o.closed_at IS NULL`,
  ).bind(await hashWithPepper(token, env), now()).first<Operator>();
  if (!op) throw unauthorized('Your session has expired. Sign in again.');
  return op;
}

/**
 * Resolves an operator who is also allowed to act on the whole platform.
 *
 * The no-show queue and the flag report are moderation tools: they read every
 * business's disputes, and confirming one suspends or bans the operator it
 * names. Until now they asked only for a session, which meant every one of the
 * businesses on the site — and anybody at all, because /demo hands out a
 * session with no email and no password — could read other people's customers'
 * phone numbers and ban a competitor in one request.
 *
 * The allowlist is an environment variable rather than a column because there
 * is no admin account in this product and inventing one in a schema migration
 * would be a bigger change than the hole warrants. Unset means nobody is an
 * admin, which is the right default: these routes have no front end, so a
 * deployment that never sets the variable loses nothing it was using.
 *
 * 404 and not 403, matching what a signed-out caller already gets for a
 * nonexistent path: an operator poking at /api/admin should not learn that the
 * queue exists and that they are merely not on the list.
 */
export async function requireAdmin(req: Request, env: Env): Promise<Operator> {
  const op = await requireOperator(req, env);
  const allowed = (env.ADMIN_EMAILS ?? '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const email = (op.email ?? '').trim().toLowerCase();
  // Constant-time per entry: the comparand is an address somebody is trying to
  // guess, and a length-or-prefix signal would narrow that guess for free.
  if (!email || !allowed.some((a) => timingSafeEqual(a, email))) throw notFound();
  return op;
}

export async function revokeSession(req: Request, env: Env): Promise<void> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return;
  await env.DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE token_hash = ?`)
    .bind(now(), await hashWithPepper(token, env)).run();
}

/**
 * Public offer links carry a raw token in the URL. We store only the hash, so
 * a leaked database does not hand out working accept links.
 */
export const hashOfferToken = (raw: string, env: Env) => hashWithPepper(raw, env);
