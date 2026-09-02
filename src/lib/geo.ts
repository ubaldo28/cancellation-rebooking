import type { Env, Point } from '../types';
import { getCountry, normalisePostcode } from './countries';
import { haversineMeters, newId, now } from './util';

const CACHE_TTL = 60 * 60 * 24 * 30;      // 30 days
const KEY_PRECISION = 4;                   // ~11 m — coarse enough for keys to collide

const round = (n: number) => Number(n.toFixed(KEY_PRECISION));
const cacheKey = (a: Point, b: Point, mode: string) =>
  `${round(a.lat)},${round(a.lng)}|${round(b.lat)},${round(b.lng)}|${mode}`;

async function recordUsage(env: Env, operatorId: string | null, provider: string, units: number) {
  await env.DB.prepare(
    `INSERT INTO api_usage (id, operator_id, provider, units, occurred_at) VALUES (?,?,?,?,?)`,
  ).bind(newId(), operatorId, provider, units, now()).run();
}

/**
 * Straight-line distance turned into a road-time estimate.
 *
 * Costs nothing and needs no API key, which is why it is the default. It is an
 * ESTIMATE: it does not know about rivers, motorways or traffic, and it will be
 * optimistic in dense cities and pessimistic in rural areas. The 1.35 factor is
 * the usual circuity allowance between crow-flight and road distance. Switch
 * DISTANCE_PROVIDER to google/mapbox when ranking accuracy starts costing
 * real bookings — the cache below is what keeps that bill survivable.
 */
export function estimateDriveSeconds(a: Point, b: Point): number {
  const meters = haversineMeters(a, b) * 1.35;
  const kmh = meters < 5000 ? 24 : meters < 25000 ? 40 : 65;   // urban → arterial → open road
  return Math.round((meters / 1000 / kmh) * 3600) + 60;         // + parking/approach
}

async function fetchGoogle(env: Env, pairs: [Point, Point][]): Promise<(number | null)[]> {
  const origins = pairs.map(([o]) => `${o.lat},${o.lng}`).join('|');
  const dests = pairs.map(([, d]) => `${d.lat},${d.lng}`).join('|');
  const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json');
  url.searchParams.set('origins', origins);
  url.searchParams.set('destinations', dests);
  url.searchParams.set('mode', 'driving');
  url.searchParams.set('key', env.DISTANCE_API_KEY ?? '');
  const res = await fetch(url.toString());
  if (!res.ok) return pairs.map(() => null);
  const body = (await res.json()) as any;
  if (body.status !== 'OK') return pairs.map(() => null);
  // Diagonal of the matrix: row i, column i is pair i.
  return pairs.map((_, i) => {
    const el = body.rows?.[i]?.elements?.[i];
    return el?.status === 'OK' ? (el.duration_in_traffic?.value ?? el.duration?.value ?? null) : null;
  });
}

async function fetchMapbox(env: Env, pairs: [Point, Point][]): Promise<(number | null)[]> {
  const out: (number | null)[] = [];
  for (const [o, d] of pairs) {
    const url =
      `https://api.mapbox.com/directions-matrix/v1/mapbox/driving/` +
      `${o.lng},${o.lat};${d.lng},${d.lat}` +
      `?sources=0&destinations=1&annotations=duration&access_token=${env.DISTANCE_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) { out.push(null); continue; }
    const body = (await res.json()) as any;
    out.push(body.durations?.[0]?.[0] != null ? Math.round(body.durations[0][0]) : null);
  }
  return out;
}

/**
 * Drive times for many point pairs, cache-first.
 *
 * Order of the result matches the order of `pairs`. A provider failure falls
 * back to the free estimate rather than dropping the candidate — a ranked list
 * with approximate times beats an empty screen.
 */
export async function driveSeconds(
  env: Env, operatorId: string, pairs: [Point, Point][], mode = 'driving',
): Promise<number[]> {
  if (pairs.length === 0) return [];
  const t = now();
  const keys = pairs.map(([a, b]) => cacheKey(a, b, mode));

  const hits = new Map<string, number>();
  // D1 caps bound parameters per statement; chunk the lookup.
  for (let i = 0; i < keys.length; i += 90) {
    const chunk = keys.slice(i, i + 90);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await env.DB.prepare(
      `SELECT cache_key, duration_seconds FROM distance_cache
        WHERE cache_key IN (${placeholders}) AND expires_at > ?`,
    ).bind(...chunk, t).all<{ cache_key: string; duration_seconds: number }>();
    for (const r of rows.results ?? []) hits.set(r.cache_key, r.duration_seconds);
  }

  const missIdx = keys.map((k, i) => (hits.has(k) ? -1 : i)).filter((i) => i >= 0);
  const provider = env.DISTANCE_PROVIDER ?? 'estimate';

  if (missIdx.length > 0 && provider !== 'estimate' && env.DISTANCE_API_KEY) {
    const missPairs = missIdx.map((i) => pairs[i]!);
    let fetched: (number | null)[] = [];
    try {
      fetched = provider === 'google'
        ? await fetchGoogle(env, missPairs)
        : await fetchMapbox(env, missPairs);
      await recordUsage(env, operatorId, `distance_${provider}`, missPairs.length);
    } catch {
      fetched = missPairs.map(() => null);
    }
    const writes: D1PreparedStatement[] = [];
    fetched.forEach((secs, n) => {
      const i = missIdx[n]!;
      const [a, b] = pairs[i]!;
      const value = secs ?? estimateDriveSeconds(a, b);
      hits.set(keys[i]!, value);
      if (secs != null) {
        writes.push(env.DB.prepare(
          `INSERT INTO distance_cache
             (cache_key, origin_lat, origin_lng, dest_lat, dest_lng, mode,
              duration_seconds, provider, fetched_at, expires_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(cache_key) DO UPDATE SET
             duration_seconds = excluded.duration_seconds,
             fetched_at = excluded.fetched_at,
             expires_at = excluded.expires_at`,
        ).bind(keys[i], round(a.lat), round(a.lng), round(b.lat), round(b.lng), mode,
               value, provider, t, t + CACHE_TTL));
      }
    });
    if (writes.length) await env.DB.batch(writes);
  }

  return keys.map((k, i) => hits.get(k) ?? estimateDriveSeconds(pairs[i]![0], pairs[i]![1]));
}

export type GeocodeResult = Point & { source: 'table' | 'postcodesio' | 'census'; place?: string };

/**
 * Geocoding, in cost order. Works in every country seeded into postal_codes.
 *
 *   1. postal_codes table  — ~100 countries, offline, free, unlimited.
 *   2. postcodes.io        — GB only. Open data, keyless, sharper than a
 *                            centroid, so it is worth the round trip there.
 *   3. US Census           — US only. Keyless, street-level.
 *
 * Deliberately NOT here: Nominatim. Its usage policy bans distributed scripts
 * (a Worker is distributed), caps at 1 req/sec, and tells commercial apps that
 * depend on geocoding to run their own instance. Using it would work right up
 * until the ban. If you want street-level coverage worldwide, either self-host
 * Nominatim or pay for a geocoder — both are real options, neither is free.
 *
 * Returns null rather than guessing. A failed geocode leaves the client marked
 * 'failed' and out of drive-time ranking, which is visible and fixable; a
 * silently wrong coordinate sends someone forty minutes the wrong way.
 */
export async function geocode(
  env: Env, address: string | null, postcode: string | null, country = 'GB',
): Promise<GeocodeResult | null> {
  const c = getCountry(country);
  const iso = c?.iso2 ?? country.toUpperCase();

  // 1. Local table — no network, no cost, no rate limit.
  if (postcode && !c?.noPostalCodes) {
    const norm = normalisePostcode(postcode);
    const exact = await env.DB.prepare(
      `SELECT lat, lng, place_name FROM postal_codes
        WHERE country_code = ? AND postal_code = ?`,
    ).bind(iso, norm).first<{ lat: number; lng: number; place_name: string | null }>();
    if (exact) return { lat: exact.lat, lng: exact.lng, source: 'table', place: exact.place_name ?? undefined };

    // Two different partial-match cases, and they point opposite ways:
    //
    //   a) The DATA is partial. Ireland, Chile, Argentina, Malta and China
    //      publish only the routing key / outward part, so the stored code is
    //      SHORTER than what the client typed: 'D02' vs 'D02AF30'. Walk the
    //      input down, shortest useful prefix last. Each step is an indexed
    //      primary-key hit, so this stays cheap.
    //
    //   b) The INPUT is partial. The operator typed only the outward code
    //      ('SW1A') where the table holds full codes. One LIKE handles it.
    for (let len = norm.length - 1; len >= 3; len--) {
      const hit = await env.DB.prepare(
        `SELECT lat, lng, place_name FROM postal_codes
          WHERE country_code = ? AND postal_code = ?`,
      ).bind(iso, norm.slice(0, len))
        .first<{ lat: number; lng: number; place_name: string | null }>();
      if (hit) {
        return { lat: hit.lat, lng: hit.lng, source: 'table', place: hit.place_name ?? undefined };
      }
    }

    if (norm.length >= 3) {
      const wider = await env.DB.prepare(
        `SELECT lat, lng, place_name FROM postal_codes
          WHERE country_code = ? AND postal_code LIKE ? LIMIT 1`,
      ).bind(iso, `${norm}%`)
        .first<{ lat: number; lng: number; place_name: string | null }>();
      if (wider) {
        return { lat: wider.lat, lng: wider.lng, source: 'table', place: wider.place_name ?? undefined };
      }
    }
  }

  // 2 & 3. Country-specific free services, for sharper-than-centroid results.
  try {
    if (iso === 'GB' && postcode && env.GEOCODE_PROVIDER !== 'none') {
      const res = await fetch(
        `https://api.postcodes.io/postcodes/${encodeURIComponent(postcode.trim())}`);
      if (res.ok) {
        const body = (await res.json()) as any;
        if (body.status === 200 && body.result) {
          return { lat: body.result.latitude, lng: body.result.longitude, source: 'postcodesio' };
        }
      }
    }
    if (iso === 'US' && address && env.GEOCODE_PROVIDER !== 'none') {
      const url = new URL('https://geocoding.geo.census.gov/geocoder/locations/onelineaddress');
      url.searchParams.set('address', [address, postcode].filter(Boolean).join(' '));
      url.searchParams.set('benchmark', 'Public_AR_Current');
      url.searchParams.set('format', 'json');
      const res = await fetch(url.toString());
      if (res.ok) {
        const body = (await res.json()) as any;
        const m = body.result?.addressMatches?.[0];
        if (m) return { lat: m.coordinates.y, lng: m.coordinates.x, source: 'census' };
      }
    }
  } catch {
    return null;
  }
  return null;
}
