import type { Env, Operator } from '../types';
import {
  HttpError, newId, newToken, notFound, now, sessionPepper, sha256, timingSafeEqual,
  unauthorized,
} from './util';

/**
 * The operator session cookie, under the `__Host-` prefix.
 *
 * THE PREFIX IS THE WHOLE POINT AND IT IS NOT DECORATION. A browser will
 * happily hold two cookies of the same name: one for `roundtheway.app`, and
 * one set with `Domain=.roundtheway.app` by ANYTHING on a subdomain. The
 * Cookie header carries no domain, no path and no attributes -- just
 * `name=value; name=value` -- so the server that receives them cannot tell
 * which is which, or that there is more than one. That is the cookie-toss:
 * something on a sibling origin plants a session value, the victim keeps
 * browsing signed in as somebody else, and everything they type lands in the
 * attacker's account. readCookies below describes the partial mitigation that
 * was in place (try every value, revoke every value) and why it is only
 * partial.
 *
 * `__Host-` closes it at the browser instead of guessing at the server. A
 * cookie whose name starts with that prefix is REJECTED OUTRIGHT unless it was
 * set by the exact host, over HTTPS, with `Path=/` and NO `Domain` attribute
 * at all. A subdomain cannot write this name. There is no second value to
 * disambiguate, because no other origin can create one.
 *
 * WHY IT IS SAFE TO DO HERE AND WAS NOT SAFE BEFORE: nothing else changes.
 * `sessionCookie` and `clearCookie` below already emitted `Path=/; Secure`
 * with no `Domain` -- which is exactly the attribute set the prefix demands --
 * so the rename is the entire change and the Set-Cookie lines are already
 * conformant. Verified rather than assumed; if a `Domain=` is ever added to
 * either of them the browser will silently drop the cookie and sign-in will
 * appear to do nothing at all, so that is the one edit to make carefully.
 *
 * WHY NOW, SPECIFICALLY. Renaming the cookie invalidates every live session
 * the instant it deploys, and a magic link is the only way back in -- this
 * deployment can send about a hundred emails a day in total, shared between
 * sign-in links and the codes that let new customers join, so a forced
 * sign-out of a real user base would not be an inconvenience, it would be an
 * outage with a queue. The site went live today and has essentially no real
 * signed-in users. This is the cheapest this change will ever be, and it gets
 * more expensive every day it is deferred.
 *
 * THE CUSTOMER COOKIE MOVED IN THE SAME BREATH. `CUSTOMER_COOKIE` in
 * ./customers.ts carries the other half of the signed-in surface, and a
 * cookie-toss against it reaches somebody's address and booking history.
 * Hardening one and leaving the other is not half the fix, it is the fix
 * applied to half the site. If either is ever renamed back, both go.
 */
const SESSION_COOKIE = '__Host-gf_session';

/**
 * HOW LONG ANYBODY STAYS SIGNED IN. A year, extended on use.
 *
 * EXPORTED, AND ./customers.ts IMPORTS IT rather than keeping its own copy.
 * The two session systems are deliberately separate — separate tables,
 * separate cookies, separate hash domains, all described below and in that
 * file — but the LIFETIME is one decision made once, and it was written out
 * twice with two paragraphs arguing for the same number. Two declarations of a
 * policy that is meant to match is how one of them ends up not matching.
 *
 * It was thirty days as a HARD STOP, which meant every listed business was
 * mailed a fresh sign-in link about once a month whether or not they had been
 * away. That is a cost the customer side had already decided not to pay -- see
 * SESSION_TTL in ./customers.ts -- and paying it here was not a security
 * decision, it was an omission: nothing wrote the extension, so nothing
 * extended.
 *
 * It matters more than a month of convenience. This deployment can send one
 * hundred emails a day in total, shared between sign-in links and the codes
 * that let new customers join, so every avoidable sign-in is a place somebody
 * new could have had.
 *
 * A YEAR RATHER THAN THIRTY DAYS, matching the customer session exactly. An
 * operator session can do more than a customer's -- publish a listing, take
 * bookings, change prices, read a customer's address -- and what makes a year
 * safe is the same thing that makes it safe there: it cannot move money out, it
 * cannot reach another business's account, and it is revoked outright by
 * signing out or by closing the account. Against that, the thing a short
 * session protects is a stolen laptop, which is already behind that laptop's
 * own lock screen.
 */
export const SESSION_TTL = 365 * 86400;

/**
 * How stale a session has to be before using it renews it.
 *
 * Without a floor this is a database write on every single request the
 * dashboard makes. With it, a device in use is written to once a month and one
 * that has been silent for a full year is asked to sign in again -- which is
 * the behaviour the number above describes.
 *
 * Thirty days, and it has to be small enough relative to the window that
 * ordinary use always lands inside it, and large enough that renewal is one
 * cheap write a month per device rather than one per request.
 *
 * Exported and shared with ./customers.ts for the same reason SESSION_TTL is:
 * the customer session applies the identical floor, and it is the same
 * decision rather than a second one that happens to agree.
 */
export const SESSION_EXTEND_AFTER = 30 * 86400;

const LOGIN_TTL = 60 * 15;               // 15 minutes

/**
 * The digest behind every operator session, magic link, offer link and guest
 * link on the site.
 *
 * It used to interpolate `env.SESSION_PEPPER` straight into the template, so a
 * deployment with the secret unset hashed against the literal text "undefined"
 * and nothing said a word -- see sessionPepper in ./util.ts for why an
 * unpeppered digest is a silent, permanent downgrade rather than a missing
 * nicety. Reading it through the guard costs one trim and one length check per
 * hash and turns that into a refusal at the door.
 */
const hashWithPepper = (token: string, env: Env) => sha256(`${token}:${sessionPepper(env)}`);

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

/**
 * Every value this browser is carrying under one cookie name, decodable ones
 * only. Empty when there is nothing here we can make sense of.
 *
 * THE DECODE USED TO BE ABLE TO THROW, AND IT WAS NOT INSIDE ANYTHING.
 * `decodeURIComponent` raises URIError on a malformed escape -- a lone `%`,
 * `%ZZ`, half a multi-byte sequence -- and this ran on the raw bytes of a
 * header, which is to say on a string chosen by whoever is calling. So
 * `Cookie: __Host-gf_session=%` turned every request that consults a session
 * into a 500 rather than a 401: the whole signed-in surface for that browser, plus
 * every public route that merely LOOKS for a session on the way past
 * (/api/public/standing reads the customer one, the checkout reads it before
 * it will write an order), all of them answering "Something went wrong." with
 * nothing anywhere naming a cookie as the cause. A browser that acquired such
 * a value -- a truncated write, a proxy, anything on a sibling origin -- was
 * simply locked out of the site until somebody thought to clear cookies.
 *
 * A value that is not valid percent-encoding is not a token this database has
 * ever issued, so the honest answer is the same one a missing cookie gets.
 * This is exactly the reasoning decodeParams in src/index.ts already applies
 * to path segments, for exactly the same class of input.
 *
 * EVERY MATCHING COOKIE IS RETURNED, NOT THE FIRST, and that is not tidiness.
 * A browser will happily send two cookies of the same name -- one
 * for `roundtheway.app`, one set with `Domain=.roundtheway.app` by anything on
 * a subdomain -- and the header gives no way to tell which is which. Taking
 * the first and stopping meant a value planted by a sibling origin could
 * shadow the real session, which is the classic cookie-toss: the victim keeps
 * browsing, signed in as somebody else, with everything they type landing in
 * the attacker's account. Trying each candidate against the sessions table
 * means a planted value that names no live session is simply skipped and the
 * real one still resolves.
 *
 * THAT WAS ONLY EVER A MITIGATION, AND THE REAL FIX IS NOW IN PLACE ABOVE.
 * Trying every value narrows the attack but does not close it: two values that
 * both resolve to live sessions are still ambiguous, and this code would pick
 * whichever the header happened to list first. `SESSION_COOKIE` now carries
 * the `__Host-` prefix, which forbids `Domain` outright, so a subdomain cannot
 * write this cookie name at all and the ambiguous case can no longer be
 * created -- see the note on the constant for why the rename was affordable
 * today and would not have been next month.
 *
 * THE LOOP STAYS ANYWAY, for two reasons. It costs one extra query only in the
 * case that can no longer happen, so there is nothing to reclaim by removing
 * it; and it is the thing that makes revokeSession's "revoke every value"
 * honest for browsers that are still carrying a pre-rename cookie or any other
 * duplicate a proxy or a truncated write leaves behind. Defence that has
 * stopped being load-bearing is not the same as defence that is in the way.
 */
function readCookies(req: Request, name: string): string[] {
  const header = req.headers.get('cookie');
  if (!header) return [];
  const out: string[] = [];
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k !== name) continue;
    try { out.push(decodeURIComponent(v.join('='))); }
    catch { /* not percent-encoding, so not a token we issued */ }
  }
  return out;
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
  const tokens = readCookies(req, SESSION_COOKIE);
  if (tokens.length === 0) throw unauthorized();
  const t = now();

  // Every value carrying this name is tried, not only the first one in the
  // header. See readCookies for why a browser can be holding more than one and
  // why stopping at the first was a way in.
  let row: (Operator & { session_id: string; session_expires_at: number }) | null = null;
  for (const token of tokens) {
    row = await env.DB.prepare(
      `SELECT o.*, s.id AS session_id, s.expires_at AS session_expires_at
         FROM sessions s
         JOIN operators o ON o.id = s.operator_id
        WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
          AND o.closed_at IS NULL`,
    ).bind(await hashWithPepper(token, env), t).first<Operator & {
      session_id: string; session_expires_at: number;
    }>();
    if (row) break;
  }
  if (!row) throw unauthorized('Your session has expired. Sign in again.');

  // EXTENDED ON USE, at most once a month. See SESSION_EXTEND_AFTER.
  //
  // The whole point of the renewal: a business that opens its dashboard is
  // never mailed another sign-in link, so the year only ever runs out on
  // somebody who has genuinely stopped coming. The clock restarts from now
  // rather than being pushed forward by a fixed amount, so a session cannot
  // creep past a year of actual idleness however often it is renewed.
  if (row.session_expires_at - t < SESSION_TTL - SESSION_EXTEND_AFTER) {
    await env.DB.prepare(`UPDATE sessions SET expires_at = ? WHERE id = ?`)
      .bind(t + SESSION_TTL, row.session_id).run();
  }

  const { session_id: _s, session_expires_at: _e, ...op } = row;
  return op as Operator;
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

/**
 * Signing out.
 *
 * EVERY value under the cookie name is revoked, not just the one that happened
 * to resolve. Signing out has to mean signing out: a browser holding two of
 * these (see readCookies) that revoked only the first would leave the other
 * live, and the person who pressed the button would still be signed in on the
 * next request with no way to tell. Revoking a hash that names no row costs
 * one no-op UPDATE and says nothing to anybody.
 */
export async function revokeSession(req: Request, env: Env): Promise<void> {
  const tokens = readCookies(req, SESSION_COOKIE);
  if (tokens.length === 0) return;
  const t = now();
  for (const token of tokens) {
    await env.DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE token_hash = ?`)
      .bind(t, await hashWithPepper(token, env)).run();
  }
}

/**
 * Public offer links carry a raw token in the URL. We store only the hash, so
 * a leaked database does not hand out working accept links.
 */
export const hashOfferToken = (raw: string, env: Env) => hashWithPepper(raw, env);
