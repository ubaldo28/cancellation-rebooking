import type { Env } from '../types';
import { countryFromE164, getCountry } from './countries';
import { findCardData, mayContainPan } from './cardscan';

export const now = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// Numbers that were written out in more than one module
// ---------------------------------------------------------------------------
//
// Each of these was defined identically in two or more files with nothing
// importing anything, which is the shape a constant drifts in: somebody edits
// the copy in front of them and the other one goes on saying the old number.
// They live here because every module that needs one already imports this file
// and this file imports almost nothing, so there is no cycle to arrange.
//
// A constant belongs here only when the DUPLICATION was the accident. Numbers
// that are deliberately different in different places — MAX_PRICE_CENTS in
// online.ts and estimates.ts, for instance — stay where they are, next to the
// reasoning that makes them different.

/**
 * A day in seconds, for windows measured in days.
 *
 * Was written three times: retention.ts, standing.ts and, in the other tree,
 * web/src/pages/Schedule.tsx. The browser copy stays a copy — web/ is a
 * separate build that cannot import a Worker module — and says so where it is
 * declared. These two are one line.
 */
export const DAY = 86_400;

/**
 * How long to sleep before retrying a provider that answered 429.
 *
 * email.ts and sms.ts each had their own copy, with the same number and the
 * same paragraph of reasoning above it: a per-second send ceiling needs
 * slightly more than a second to roll over, and the retry happens ONCE rather
 * than in a loop, because sleeping repeatedly inside a request turns one
 * person's slow sign-in into everybody's. The reasoning stays at both call
 * sites; only the number is shared.
 */
export const RATE_LIMIT_BACKOFF_MS = 1_100;

/**
 * The ceiling on a short free-text box somebody types into a form.
 *
 * Four copies: a parts note and a parts-quote description in parts.ts, an
 * estimate description in estimates.ts, and an opening's note in online.ts.
 * Three hundred characters in every one of them, and all four are the same
 * decision — a sentence or two of context, not a document — so they are one
 * number. The description fields import this under this name rather than
 * keeping a MAX_DESCRIPTION_CHARS alias, because two names for one value is
 * how four copies happened in the first place.
 */
export const MAX_NOTE_CHARS = 300;

/**
 * How long a single job may be booked for, in seconds.
 *
 * A quarter of an hour to twelve hours, identical in online.ts (an operator
 * posting an opening) and estimates.ts (an operator quoting for one), because
 * both of them end up as the same kind of row on the same calendar.
 *
 * NOTE FOR ANYONE TIDYING NEARBY: the MAX_PRICE_CENTS beside these two in both
 * files is NOT the same number in both, and is deliberately not here. See the
 * comment at either declaration.
 */
export const MIN_DURATION_SECONDS = 15 * 60;
export const MAX_DURATION_SECONDS = 12 * 60 * 60;

/** UUIDv7-ish: time-ordered so D1 primary-key inserts stay sequential. */
export function newId(): string {
  const ts = Date.now();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[0] = (ts / 2 ** 40) & 0xff;
  bytes[1] = (ts / 2 ** 32) & 0xff;
  bytes[2] = (ts / 2 ** 24) & 0xff;
  bytes[3] = (ts / 2 ** 16) & 0xff;
  bytes[4] = (ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const h = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** URL-safe random token for magic links, sessions and public offer links. */
export function newToken(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The pepper, or a refusal. EVERY PEPPERED DIGEST IN THIS CODEBASE GOES
 * THROUGH HERE -- or should; see the note at the bottom.
 *
 * `SESSION_PEPPER` is typed as required on Env and the README calls it
 * required, and neither of those is a runtime check. What the code actually
 * did was interpolate it: `sha256(\`${token}:${env.SESSION_PEPPER}\`)`. With
 * the secret unset that template renders the literal text "undefined", so
 * every hash in the product silently became an UNPEPPERED sha256 of its input
 * -- and nothing anywhere failed, because an unpeppered digest is stable, so
 * sessions still resolved, guest links still opened and the tests still
 * passed. The only observable difference is in the one scenario the pepper
 * exists for.
 *
 * WHY THAT IS WORTH A HARD FAILURE. The pepper is what makes a stolen copy of
 * this database not also a stolen contact list. Sessions and guest links are
 * 32 random bytes, so their digests are out of reach either way -- but
 * `pepperedHash` in ./redact.ts is also used on PHONE NUMBERS and EMAIL
 * ADDRESSES (claim hashes, erasure receipts, the audit log, and the
 * rate-limit bucket keys, which are raw mailboxes and raw booking links on
 * sixteen routes). Those spaces are small enough to enumerate on a laptop:
 * unpeppered, every one of those digests is reversible by brute force, and
 * the table that was hashed specifically so it could not be read back becomes
 * readable again. A deployment can be in that state for its whole life with
 * no symptom, which is precisely the kind of failure that has to be made
 * noisy at the point of use rather than left to a checklist.
 *
 * Sixteen characters, not thirty-two, because this is a floor against the
 * genuinely broken cases -- unset, empty, or a placeholder somebody typed to
 * get a local run working -- and not an attempt to enforce the README's
 * recommendation. A deployment that clears this bar is making a deliberate
 * choice; one that does not has made a mistake.
 *
 * NOW CALLED FROM EVERY HASH SITE, which is what makes the sentence at the top
 * of this block true rather than aspirational. ./redact.ts (`pepperedHash`),
 * ./customers.ts (the customer session and code digests), ./audit.ts (the
 * subject hash) and ./track.ts (the van reference) each used to interpolate
 * `env.SESSION_PEPPER` straight into their own template and each carried the
 * identical silent downgrade -- this note used to list them as outstanding
 * work, and a reader arriving after they were converted would have gone
 * looking for four one-line changes that were already made. All four read the
 * pepper through this function now, so there is one place that decides whether
 * a deployment is peppered and one place to change if that decision ever moves.
 *
 * KEEP IT THAT WAY: a new digest that interpolates `env.SESSION_PEPPER` itself
 * compiles, passes its tests and is indistinguishable from a correct one until
 * the day the database is stolen. The check is worth nothing in the one file
 * that skips it.
 */
export function sessionPepper(env: Env): string {
  const pepper = typeof env.SESSION_PEPPER === 'string' ? env.SESSION_PEPPER.trim() : '';
  if (pepper.length < 16) {
    // The length, never the value, and only ever to the log: this line is the
    // one place that would otherwise be tempted to print the secret it is
    // complaining about.
    console.error(
      `SESSION_PEPPER is missing or too short (${pepper.length} chars). `
      + 'Every peppered digest would be an unpeppered one. Refusing.',
    );
    throw new HttpError(500, 'This deployment is misconfigured.', 'no_session_pepper');
  }
  return pepper;
}

/** Constant-time string compare, for anything derived from a secret. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

/**
 * The last gate a card number would have to pass to reach a browser.
 *
 * Every JSON response in the product is built here, which is the only reason
 * this is worth doing at all: a check on one endpoint is a check somebody has
 * to remember, and this one cannot be forgotten by a route that has not been
 * written yet. It is the third of the three guards described in
 * ./payments.ts — ingress, storage, egress — and the only one that would catch
 * a value that got into the database before any of them existed.
 *
 * Two stages, because this runs on every response and the fast one has to be
 * fast: a single regex pass over the string JSON.stringify has already
 * produced, and only on a hit does the full field-aware walk run to tell a
 * card apart from a long phone number. In the ordinary case that is one regex
 * over a string that had to be built anyway.
 *
 * A hit is a 500 and not a redaction. Quietly masking it would leave whatever
 * put a PAN in the database sitting there, working, with nobody told.
 */
export const json = (data: unknown, status = 200, headers: HeadersInit = {}) => {
  const serialised = JSON.stringify(data);
  if (serialised !== undefined && mayContainPan(serialised)) {
    const hit = findCardData(data);
    if (hit) {
      // The path, never the value: a log line holding the card would be the
      // same leak in a different place.
      console.error(`card data blocked from a response: ${hit.kind} at ${hit.path}`);
      return new Response(
        JSON.stringify({
          error: 'Something went wrong.', code: 'card_data_blocked',
        }),
        { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } },
      );
    }
  }
  return new Response(serialised, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
};

export const html = (body: string, status = 200, headers: HeadersInit = {}) =>
  new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'referrer-policy': 'no-referrer',
      ...headers,
    },
  });

export const badRequest = (m: string, code?: string) => new HttpError(400, m, code);
export const unauthorized = (m = 'Not signed in') => new HttpError(401, m);
export const notFound = (m = 'Not found') => new HttpError(404, m);
export const conflict = (m: string, code?: string) => new HttpError(409, m, code);

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * E.164 normaliser, driven by the country table in ./countries.
 *
 * Accepts a number already in international form, or a national number for the
 * operator's country. Returns null rather than guessing — a silently mangled
 * number means an offer that never arrives, which is worse than a form error.
 */
export function toE164(raw: string | null | undefined, country: string): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d+]/g, '');

  // Already international.
  if (cleaned.startsWith('+')) {
    if (!/^\+[1-9]\d{6,14}$/.test(cleaned)) return null;
    const c = countryFromE164(cleaned);
    if (!c) return cleaned;   // valid E.164 shape, country not in our table
    const national = cleaned.slice(c.dial.length);
    return national.length >= c.minNational && national.length <= c.maxNational
      ? cleaned : null;
  }

  // 00 international prefix, used across most of Europe and beyond.
  if (cleaned.startsWith('00')) return toE164('+' + cleaned.slice(2), country);

  const c = getCountry(country);
  if (!c) return null;

  let n = cleaned;
  if (c.trunk && n.startsWith(c.trunk) && n.length > c.trunk.length) {
    n = n.slice(c.trunk.length);
  }
  // Some people type the country code with no plus (447700900123).
  const bare = c.dial.slice(1);
  if (n.startsWith(bare) && n.length - bare.length >= c.minNational) n = n.slice(bare.length);

  if (n.length < c.minNational || n.length > c.maxNational) return null;
  return c.dial + n;
}

export function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
