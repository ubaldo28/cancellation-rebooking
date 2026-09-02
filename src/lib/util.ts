import { countryFromE164, getCountry } from './countries';

export const now = () => Math.floor(Date.now() / 1000);

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

export const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });

export const html = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'referrer-policy': 'no-referrer' },
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
