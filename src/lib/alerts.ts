import type { Env, Point } from '../types';
import { hashOfferToken } from './auth';
import { normalisePostcode } from './countries';
import { sendEmail, type Email } from './email';
import { estimateDriveSeconds, geocode } from './geo';
import { slotsNear, type PublicSlot } from './public';
import { sendPush } from './push';
import {
  badRequest, escapeHtml, haversineMeters, newId, newToken, notFound, now,
} from './util';

/**
 * Standing alerts: "tell me when someone who does this comes near my door".
 *
 * The site is otherwise entirely pull -- a stranger has to be looking at the
 * map in the few hours between a cancellation and somebody else taking the
 * slot. Most people are not looking, so the opening expires, the operator eats
 * the empty hour, and the customer who would have taken it never knew.
 *
 * A watch is the push half. It has no account behind it, for the same reason
 * the chat threads do not (migration 0011): asking a stranger to pick a
 * password before they can say "I want detailing near 91403" loses the
 * request. Their identity is the secret in their link and nothing else.
 *
 * The alert travels over two channels, and a watch needs at least one of them.
 * Web Push is the default: free, revocable in one tap, no identifier to leak.
 * An optional email address is the second, and it is here because push does
 * not reach everyone -- a browser permission that was refused is never offered
 * again, and on an iPhone push does not exist at all until the site is on the
 * Home Screen. Those customers used to be told nothing and hear nothing.
 *
 * Still no phone number: none is stored, asked for, or possible.
 */

/** One standing request, as the rest of the code sees it. */
export interface Watch {
  id: string;
  postcode: string;
  lat: number;
  lng: number;
  country: string;
  /** Trades this customer wants. NULL means any trade. */
  trades: string[] | null;
  max_detour_seconds: number;
  max_price_cents: number | null;
  label: string | null;
  /**
   * A single-purpose key that only switches this watch off. Plain text on
   * purpose — it is what puts a working unsubscribe link in every email.
   */
  unsub_token: string | null;
  /**
   * The optional second channel. NULL is the normal state and means push only.
   *
   * Held because the customer typed it into the alert form, and read by
   * nothing except the code that sends the alert they asked for.
   */
  email: string | null;
  /** When the address was confirmed. Nothing sets this yet -- see 0018. */
  email_verified_at: number | null;
  /** Consecutive refusals. At the ceiling the address stops being tried. */
  email_failed_count: number;
  active: number;
  last_notified_at: number | null;
  notify_count: number;
  created_at: number;
  updated_at: number;
}

export interface WatchInput {
  postcode: string;
  /** Optional street address -- sharpens the geocode where a geocoder exists. */
  address_line?: string | null;
  country?: string | null;
  trades?: string[] | null;
  max_detour_seconds?: number | null;
  max_price_cents?: number | null;
  label?: string | null;
  /** Optional. Empty means no address; anything malformed is refused. */
  email?: string | null;
}

/**
 * A browser's PushSubscription, in either shape it arrives in.
 *
 * subscription.toJSON() nests the keys; a hand-built body may not. Accepting
 * both means the front end can post the subscription object straight through
 * without unwrapping it, which is one fewer place to get p256dh and auth the
 * wrong way round.
 */
export interface SubscriptionInput {
  endpoint: string;
  keys?: { p256dh?: string; auth?: string };
  p256dh?: string;
  auth?: string;
}

const hashWatchToken = hashOfferToken;

/** Fifteen minutes, matching the operator-side default in operators. */
const DEFAULT_MAX_DETOUR_SECONDS = 900;

/**
 * An hour is a long way out of anyone's way, and a watch that accepts one is
 * really a watch that accepts everything. The cap is here so a slider set to
 * its maximum still describes a real preference rather than a mailing list.
 */
const MAX_DETOUR_CEILING_SECONDS = 3600;
const MIN_DETOUR_SECONDS = 60;

const MAX_LABEL_CHARS = 60;
const MAX_TRADES = 5;
const MAX_TRADE_CHARS = 60;

/**
 * The rate limits, and why they are not negotiable.
 *
 * A person who is pinged twenty times in a morning does not unsubscribe from
 * the watch -- they deny notification permission for the whole origin, in the
 * browser, permanently. That is a decision we cannot undo from the server and
 * cannot ask them to reconsider. One alert an hour and five a day is the most
 * this feature is allowed to be worth.
 */
const MIN_SECONDS_BETWEEN_NOTIFICATIONS = 3600;
const MAX_NOTIFICATIONS_PER_DAY = 5;

/** How many watches one cron tick will look at. */
const DEFAULT_WATCH_BATCH = 500;

/** How many open slots the single shared fetch pulls. See matchWatches. */
const SLOT_FETCH_LIMIT = 400;

/** Per watch, how many candidate openings are considered before giving up. */
const MAX_CANDIDATES_PER_WATCH = 25;

/**
 * Consecutive failures before an endpoint is treated as dead.
 *
 * A push service that answers 410 says so plainly and is disabled at once.
 * This catches the slower version: an endpoint that times out or 500s forever
 * without ever admitting the subscription is gone.
 */
const MAX_SUBSCRIPTION_FAILURES = 10;

/**
 * Consecutive refusals before an address stops being tried.
 *
 * The mirror of MAX_SUBSCRIPTION_FAILURES, and lower than it. A push endpoint
 * that keeps failing wastes one request a tick. A mailbox that keeps bouncing
 * spends the sending domain's reputation, which is shared with every other
 * customer's alerts, so it is worth giving up on sooner.
 */
const MAX_EMAIL_FAILURES = 5;

/**
 * The same shape check the operator sign-in uses, and deliberately as loose.
 * No regex can tell a real mailbox from a plausible typo, and the strict ones
 * reject addresses that work. This catches the mistake worth catching -- a
 * value that is not an address at all -- and the provider decides the rest.
 */
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_EMAIL_CHARS = 254;

const WATCH_FIELDS =
  `id, postcode, lat, lng, country, trades, max_detour_seconds, max_price_cents,
   label, unsub_token, email, email_verified_at, email_failed_count, active,
   last_notified_at, notify_count, created_at, updated_at`;

type WatchRow = Omit<Watch, 'trades'> & { trades: string | null };

/**
 * Turns a stored row into a Watch.
 *
 * trades is JSON in a TEXT column, so a malformed value is possible in a way a
 * typed column would not allow. It is treated as "any trade" rather than
 * thrown on: a watch that cannot be parsed should quietly match more, not
 * break the cron tick for every other watch behind it.
 */
function toWatch(row: WatchRow): Watch {
  let trades: string[] | null = null;
  if (row.trades) {
    try {
      const parsed = JSON.parse(row.trades);
      if (Array.isArray(parsed) && parsed.length) {
        trades = parsed.map((t: unknown) => String(t)).filter(Boolean);
      }
    } catch {
      trades = null;
    }
  }
  return { ...row, trades };
}

/** Trades as they are stored: a JSON array, or NULL for "any". */
function cleanTrades(raw: string[] | null | undefined): string[] | null {
  if (!raw || !Array.isArray(raw)) return null;
  const list = [...new Set(
    raw.map((t) => String(t ?? '').trim().toLowerCase()).filter(Boolean),
  )].slice(0, MAX_TRADES).map((t) => t.slice(0, MAX_TRADE_CHARS));
  return list.length ? list : null;
}

function cleanDetour(raw: number | null | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return DEFAULT_MAX_DETOUR_SECONDS;
  return Math.min(MAX_DETOUR_CEILING_SECONDS, Math.max(MIN_DETOUR_SECONDS, Math.round(raw)));
}

function cleanPrice(raw: number | null | undefined): number | null {
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return null;
  return Math.round(raw);
}

/**
 * The address as it will be stored, or null for "no address".
 *
 * An empty box is not an error -- the field is optional, and someone clearing
 * it is switching the channel off. Anything that is not empty and not an
 * address is refused here, while the customer is still looking at the form and
 * can fix it. Stored, it would be a channel that silently never delivers,
 * which is the exact failure this file exists to remove.
 *
 * Lower-cased on the way in, as the sign-in route already does, so the same
 * mailbox typed two ways is one address.
 */
function cleanEmail(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const email = String(raw).trim().toLowerCase();
  if (!email) return null;
  if (email.length > MAX_EMAIL_CHARS || !EMAIL_SHAPE.test(email)) {
    throw badRequest('That email address does not look right.', 'bad_email');
  }
  return email;
}

/**
 * Which country to geocode a bare postcode in.
 *
 * A visitor cannot be asked and the browser's guess is worse than reading it
 * off whoever is actually listed -- the same call /api/public/map already
 * makes. This is a country of operation, not of the customer.
 */
async function defaultCountry(env: Env): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT o.country FROM operators o
      WHERE o.accept_public_bookings = 1 AND o.plan IN ('trial','active')
      LIMIT 1`,
  ).first<{ country: string }>();
  return row?.country ?? 'US';
}

/**
 * Creates a watch and returns the RAW token, once.
 *
 * Only the hash is stored, so this return value is the only time the token
 * exists in readable form -- put it in the customer's manage link here or it
 * is gone. Exactly the same contract as startThread, and for the same reason:
 * a leaked database must not be a working set of keys to strangers' home
 * postcodes.
 */
export async function createWatch(
  env: Env, input: WatchInput,
): Promise<{ watch: Watch; token: string }> {
  const postcodeRaw = (input.postcode ?? '').trim();
  if (!postcodeRaw) throw badRequest('We need a postcode to watch near.', 'no_postcode');

  const country = (input.country ?? await defaultCountry(env)).toUpperCase();
  const postcode = normalisePostcode(postcodeRaw);

  // Resolved once, here, and stored. The matcher runs over every watch every
  // fifteen minutes; re-geocoding an address that has not moved, on every
  // tick, forever, is the same lookup repeated until it costs money.
  const at = await geocode(env, input.address_line ?? null, postcode, country);
  if (!at) {
    throw badRequest(
      `We could not place ${postcodeRaw}. Check it, or try a nearby one.`, 'bad_postcode');
  }

  const raw = newToken();
  const t = now();
  const trades = cleanTrades(input.trades);

  // An address here is consent to be emailed about THIS watch and nothing
  // else: the openings it matches, at the rate the caps allow, until the
  // customer turns the watch off. It is not a mailing list, it is never used
  // to reach them about anything else, and it goes when the watch goes.
  const email = cleanEmail(input.email);

  const watch: Watch = {
    id: newId(),
    postcode,
    lat: at.lat,
    lng: at.lng,
    country,
    trades,
    max_detour_seconds: cleanDetour(input.max_detour_seconds),
    max_price_cents: cleanPrice(input.max_price_cents),
    label: (input.label ?? '').trim().slice(0, MAX_LABEL_CHARS) || null,
    unsub_token: null,   // set below; the row that is written carries the real one
    email,
    email_verified_at: null,
    email_failed_count: 0,
    active: 1,
    last_notified_at: null,
    notify_count: 0,
    created_at: t,
    updated_at: t,
  };

  // A second, separate secret whose only power is switching this watch off.
  // Stored in plain text on purpose: the matcher needs to put an unsubscribe
  // link in every email, and it never sees the watch's real token — only the
  // hash of it is kept. See migration 0019.
  const unsub = newToken();
  watch.unsub_token = unsub;

  await env.DB.prepare(
    `INSERT INTO watches (id, token_hash, unsub_token, postcode, lat, lng, country, trades,
       max_detour_seconds, max_price_cents, label, email, email_verified_at,
       email_failed_count, active, last_notified_at, notify_count, created_at,
       updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,0,1,NULL,0,?,?)`,
  ).bind(watch.id, await hashWatchToken(raw, env), unsub, watch.postcode, watch.lat, watch.lng,
    watch.country, trades ? JSON.stringify(trades) : null, watch.max_detour_seconds,
    watch.max_price_cents, watch.label, watch.email,
    watch.created_at, watch.updated_at).run();

  return { watch, token: raw };
}

/**
 * Switches a watch off from an unsubscribe link in an email.
 *
 * Deliberately does nothing else. It cannot read the watch, change the address
 * or reveal who it belongs to — the only outcome is that the alerts stop,
 * which is what the person clicking it asked for.
 */
export async function unsubscribeByToken(env: Env, unsubToken: string): Promise<boolean> {
  const token = (unsubToken ?? '').trim();
  if (!token) return false;
  const res = await env.DB.prepare(
    `UPDATE watches SET active = 0, updated_at = ? WHERE unsub_token = ? AND active = 1`,
  ).bind(now(), token).run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * Resolves a customer's secret link.
 *
 * Returns null for anything that does not match, including a blank token, so a
 * caller cannot accidentally look up "the watch whose hash is the hash of the
 * empty string".
 */
export async function watchByToken(env: Env, rawToken: string): Promise<Watch | null> {
  const raw = (rawToken ?? '').trim();
  if (!raw) return null;
  const row = await env.DB.prepare(
    `SELECT ${WATCH_FIELDS} FROM watches WHERE token_hash = ?`,
  ).bind(await hashWatchToken(raw, env)).first<WatchRow>();
  return row ? toWatch(row) : null;
}

/** Everything a customer is allowed to change about their own watch. */
export interface WatchPatch {
  postcode?: string | null;
  address_line?: string | null;
  country?: string | null;
  trades?: string[] | null;
  max_detour_seconds?: number | null;
  max_price_cents?: number | null;
  label?: string | null;
  /** As on creation: empty clears the address, malformed is refused. */
  email?: string | null;
  active?: boolean;
}

/**
 * Edits a watch, by token.
 *
 * Only fields actually present in the patch move, so a manage page that posts
 * one slider does not silently clear the trade filter. A postcode change is
 * re-geocoded here rather than in the matcher, for the same reason it is
 * geocoded once at creation.
 */
export async function updateWatch(
  env: Env, rawToken: string, patch: WatchPatch,
): Promise<Watch> {
  const watch = await watchByToken(env, rawToken);
  if (!watch) throw notFound('That alert link is not valid any more.');

  const next: Watch = { ...watch };

  if (patch.postcode !== undefined && patch.postcode !== null && patch.postcode.trim()) {
    const country = (patch.country ?? watch.country).toUpperCase();
    const postcode = normalisePostcode(patch.postcode.trim());
    const at = await geocode(env, patch.address_line ?? null, postcode, country);
    if (!at) {
      throw badRequest(
        `We could not place ${patch.postcode.trim()}. Check it, or try a nearby one.`,
        'bad_postcode');
    }
    next.postcode = postcode;
    next.country = country;
    next.lat = at.lat;
    next.lng = at.lng;
  }

  if (patch.trades !== undefined) next.trades = cleanTrades(patch.trades);
  if (patch.max_detour_seconds !== undefined) {
    next.max_detour_seconds = cleanDetour(patch.max_detour_seconds);
  }
  if (patch.max_price_cents !== undefined) {
    next.max_price_cents = cleanPrice(patch.max_price_cents);
  }
  if (patch.label !== undefined) {
    next.label = (patch.label ?? '').trim().slice(0, MAX_LABEL_CHARS) || null;
  }
  if (patch.email !== undefined) {
    // The same consent as on creation, and only for this watch.
    const email = cleanEmail(patch.email);
    // A different address is a different mailbox, so the old one's failures
    // say nothing about it. Carrying the count over would retire a good
    // address on its first send.
    if (email !== next.email) next.email_failed_count = 0;
    next.email = email;
  }
  if (patch.active !== undefined) next.active = patch.active ? 1 : 0;

  next.updated_at = now();

  await env.DB.prepare(
    `UPDATE watches
        SET postcode = ?, lat = ?, lng = ?, country = ?, trades = ?,
            max_detour_seconds = ?, max_price_cents = ?, label = ?, email = ?,
            email_failed_count = ?, active = ?, updated_at = ?
      WHERE id = ?`,
  ).bind(next.postcode, next.lat, next.lng, next.country,
    next.trades ? JSON.stringify(next.trades) : null,
    next.max_detour_seconds, next.max_price_cents, next.label, next.email,
    next.email_failed_count, next.active,
    next.updated_at, next.id).run();

  return next;
}

/**
 * Switches a watch off without deleting it.
 *
 * Deleting loses what they asked for, so someone who turns alerts off while
 * they are away has to describe the whole thing again to get it back -- and
 * most do not bother. Off is also one tap to undo, which an accidental
 * unsubscribe needs to be.
 */
export async function deactivateWatch(env: Env, rawToken: string): Promise<void> {
  const watch = await watchByToken(env, rawToken);
  if (!watch) throw notFound('That alert link is not valid any more.');
  await env.DB.prepare(
    `UPDATE watches SET active = 0, updated_at = ? WHERE id = ?`,
  ).bind(now(), watch.id).run();
}

/** One live delivery address. */
export interface StoredSubscription {
  id: string;
  watch_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  failed_count: number;
  disabled_at: number | null;
  created_at: number;
}

/**
 * Attaches a browser to a watch.
 *
 * The same person on a phone and a laptop is two rows -- a push subscription
 * is per browser, per device, and there is no identity behind it that could
 * join them. A browser that re-subscribes hands back the same endpoint, so the
 * unique index on it turns a repeat visit into an update rather than a
 * duplicate row that would deliver the same alert twice.
 */
export async function addSubscription(
  env: Env, rawToken: string, sub: SubscriptionInput,
): Promise<StoredSubscription> {
  const watch = await watchByToken(env, rawToken);
  if (!watch) throw notFound('That alert link is not valid any more.');

  const endpoint = (sub?.endpoint ?? '').trim();
  const p256dh = (sub?.keys?.p256dh ?? sub?.p256dh ?? '').trim();
  const auth = (sub?.keys?.auth ?? sub?.auth ?? '').trim();

  if (!endpoint || !/^https:\/\//i.test(endpoint)) {
    throw badRequest('That is not a valid push subscription.', 'bad_subscription');
  }
  if (!p256dh || !auth) {
    throw badRequest('That push subscription is missing its keys.', 'bad_subscription');
  }

  const t = now();
  const row: StoredSubscription = {
    id: newId(),
    watch_id: watch.id,
    endpoint,
    p256dh,
    auth,
    failed_count: 0,
    disabled_at: null,
    created_at: t,
  };

  // A re-subscribe re-points the endpoint at whichever watch the customer is
  // looking at now, clears any failure history and un-disables it: the browser
  // has just proved it is alive by handing us the subscription again.
  await env.DB.prepare(
    `INSERT INTO push_subscriptions
       (id, watch_id, endpoint, p256dh, auth, failed_count, disabled_at, created_at)
     VALUES (?,?,?,?,?,0,NULL,?)
     ON CONFLICT(endpoint) DO UPDATE SET
       watch_id = excluded.watch_id,
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       failed_count = 0,
       disabled_at = NULL`,
  ).bind(row.id, row.watch_id, row.endpoint, row.p256dh, row.auth, row.created_at).run();

  const stored = await env.DB.prepare(
    `SELECT id, watch_id, endpoint, p256dh, auth, failed_count, disabled_at, created_at
       FROM push_subscriptions WHERE endpoint = ?`,
  ).bind(endpoint).first<StoredSubscription>();

  return stored ?? row;
}

/**
 * Detaches one browser.
 *
 * Scoped by watch_id as well as endpoint: the endpoint alone is a bearer
 * string that could have been copied from somewhere, and one customer must not
 * be able to silence another's phone with it.
 */
export async function removeSubscription(
  env: Env, rawToken: string, endpoint: string,
): Promise<void> {
  const watch = await watchByToken(env, rawToken);
  if (!watch) throw notFound('That alert link is not valid any more.');
  await env.DB.prepare(
    `DELETE FROM push_subscriptions WHERE watch_id = ? AND endpoint = ?`,
  ).bind(watch.id, (endpoint ?? '').trim()).run();
}

/**
 * What the browser is handed. Kept as a named shape because the service
 * worker reads it field by field and a rename here is a silent no-op there.
 */
interface AlertPayload {
  kind: 'slot_nearby';
  title: string;
  body: string;
  url: string;
  /** So a service worker can replace an older alert instead of stacking it. */
  tag: string;
  gap_id: string;
  starts_at: number;
  watch_label: string | null;
}

/**
 * How far out of their way a van would be, estimated without a round trip.
 *
 * The public listing measures this properly: prev -> customer -> next, minus
 * the drive it would have made anyway. That needs the jobs either side and, in
 * the paid configuration, a distance-matrix call. It is right for one visitor
 * looking at one page.
 *
 * It is the wrong shape for a cron over every watch. With 500 watches and 400
 * open slots that is 200,000 pairs a tick, which is either a bill or a rate
 * limit depending on the provider. So the matcher uses the same free
 * straight-line estimate the ranker falls back to, doubled for the trip back
 * onto the route, against the point where the van already is. It is coarse and
 * it is honest about being coarse: the alert says "about 12 minutes", the slot
 * page the customer taps through to re-measures properly, and a slot that
 * turns out to be too far is filtered there before they can book it.
 */
function estimatedDetourSeconds(anchor: Point, at: Point): number {
  return estimateDriveSeconds(anchor, at) * 2;
}

/**
 * Finds openings for every live watch and tells the people waiting on them.
 *
 * Runs on the cron. The one structural decision worth knowing about: the open
 * slots are fetched ONCE and every watch is matched against that set in
 * memory. The obvious implementation -- slotsNear(env, watchPoint, ...) inside
 * the loop -- is a full listing query per watch per tick, so a hundred
 * customers is a hundred of the heaviest query in the codebase every fifteen
 * minutes, and the D1 free tier is gone long before the feature is popular.
 * One fetch, N cheap comparisons.
 *
 * Returns how many watches an opening was announced to. That is a count of
 * decisions, not of messages that arrived: a watch whose only channel is a
 * push service nobody has configured is still counted, because the opening was
 * spent on it and will not be offered to that watch again. What actually left
 * the building is notify_count on the watch itself.
 */
export async function matchWatches(env: Env, limit = DEFAULT_WATCH_BATCH): Promise<number> {
  const t = now();
  const batch = Math.min(Math.max(1, Math.floor(limit)), 2000);

  const watchRows = await env.DB.prepare(
    `SELECT ${WATCH_FIELDS} FROM watches
      WHERE active = 1
      ORDER BY last_notified_at IS NOT NULL, last_notified_at, created_at
      LIMIT ?`,
  ).bind(batch).all<WatchRow>();

  const watches = (watchRows.results ?? []).map(toWatch);
  if (watches.length === 0) return 0;

  // THE single fetch. at = null on purpose: passing a point would make this
  // one customer's listing, and there is no one customer here. Distance is
  // applied per watch below.
  const slots = await slotsNear(env, null, null, SLOT_FETCH_LIMIT);
  if (slots.length === 0) return 0;

  // Areas, once, for the same reason. Only used for openings that have no
  // location of their own -- see the gate below.
  const areaRows = await env.DB.prepare(
    `SELECT operator_id, lat, lng, radius_meters FROM service_areas WHERE is_active = 1`,
  ).all<{ operator_id: string; lat: number; lng: number; radius_meters: number }>();

  const areasByOperator = new Map<string, Array<{ lat: number; lng: number; radius_meters: number }>>();
  for (const a of areaRows.results ?? []) {
    const list = areasByOperator.get(a.operator_id) ?? [];
    list.push(a);
    areasByOperator.set(a.operator_id, list);
  }

  // The daily cap, as one aggregate rather than a COUNT per watch.
  const dayRows = await env.DB.prepare(
    `SELECT watch_id, COUNT(*) AS n FROM watch_hits
      WHERE created_at >= ? GROUP BY watch_id`,
  ).bind(t - 86400).all<{ watch_id: string; n: number }>();
  const sentToday = new Map<string, number>();
  for (const r of dayRows.results ?? []) sentToday.set(r.watch_id, r.n);

  const subscriptions = await liveSubscriptions(env, watches.map((w) => w.id));

  let notified = 0;

  for (const watch of watches) {
    // Rate limits first, before any work is done for this watch.
    if (watch.last_notified_at != null
        && t - watch.last_notified_at < MIN_SECONDS_BETWEEN_NOTIFICATIONS) continue;
    if ((sentToday.get(watch.id) ?? 0) >= MAX_NOTIFICATIONS_PER_DAY) continue;

    // Nowhere to deliver. Recording a hit here would burn the opening: the
    // watch would never be told about it again, not even after they add a
    // browser tomorrow.
    //
    // A watch in this state is the silent failure the email channel exists to
    // prevent -- somebody asked to be told and nothing can reach them -- so it
    // is skipped rather than treated as an error. The page they made it on is
    // where that gets said, while they can still fix it.
    const targets = subscriptions.get(watch.id) ?? [];
    const hasEmail = Boolean(watch.email) && watch.email_failed_count < MAX_EMAIL_FAILURES;
    if (targets.length === 0 && !hasEmail) continue;

    const at: Point = { lat: watch.lat, lng: watch.lng };
    const candidates = rankForWatch(watch, at, slots, areasByOperator, t);
    if (candidates.length === 0) continue;

    // The first candidate whose hit row is genuinely new is the one announced.
    // The INSERT is the test -- see the unique index in migration 0013. Doing
    // it as a SELECT here instead would leave a window in which two overlapping
    // cron ticks both decide the announcement is theirs and the customer is
    // told twice about the same opening.
    let chosen: { slot: PublicSlot; detour: number | null } | null = null;
    for (const candidate of candidates) {
      const res = await env.DB.prepare(
        `INSERT INTO watch_hits (id, watch_id, gap_id, created_at)
         VALUES (?,?,?,?)
         ON CONFLICT (watch_id, gap_id) DO NOTHING`,
      ).bind(newId(), watch.id, candidate.slot.gap_id, t).run();
      if ((res.meta.changes ?? 0) > 0) { chosen = candidate; break; }
    }
    if (!chosen) continue;      // every match was already announced

    // One alert, over every channel this watch has. Both channels together are
    // one alert, not two: the hit above was recorded once, the stamp below
    // happens once, and a customer who gets an email and a push has used one
    // of their five for the day.
    const delivered = await deliver(env, watch, chosen.slot, chosen.detour, targets);

    // Stamped only if something actually left the building. "At most one an
    // hour" is a promise about what the customer receives, so a tick where
    // every channel refused -- no VAPID keys, no email provider, both failing
    // at once -- must not spend that hour on a message nobody got. The
    // alternative is a system that believes it told them while they sit in
    // silence, which is the whole bug.
    //
    // This does not queue anything up: the hit above is permanent, so an
    // opening announced once is never announced again, and fixing a broken
    // provider tomorrow cannot fire a backlog of slots that were taken hours
    // ago.
    if (delivered) {
      await env.DB.prepare(
        `UPDATE watches SET last_notified_at = ?, notify_count = notify_count + 1,
                updated_at = ? WHERE id = ?`,
      ).bind(t, t, watch.id).run();
    }

    sentToday.set(watch.id, (sentToday.get(watch.id) ?? 0) + 1);
    notified++;
  }

  return notified;
}

/**
 * Every opening this one watch would accept, best first.
 *
 * Pure and in memory: this is the part that runs N times, so it does no I/O.
 */
function rankForWatch(
  watch: Watch,
  at: Point,
  slots: PublicSlot[],
  areasByOperator: Map<string, Array<{ lat: number; lng: number; radius_meters: number }>>,
  t: number,
): Array<{ slot: PublicSlot; detour: number | null }> {
  const out: Array<{ slot: PublicSlot; detour: number | null }> = [];

  for (const slot of slots) {
    if (slot.starts_at <= t) continue;

    if (watch.trades) {
      const trade = (slot.trade ?? '').trim().toLowerCase();
      if (!trade || !watch.trades.includes(trade)) continue;
    }

    if (watch.max_price_cents != null && slot.price_cents > watch.max_price_cents) continue;

    let detour: number | null = null;

    if (slot.anchor_lat != null && slot.anchor_lng != null) {
      // The van has a known position around this gap, so the detour test is
      // available and it is the real one -- the operator's own listing treats
      // it as more authoritative than their declared service areas, and so
      // does this.
      detour = estimatedDetourSeconds(
        { lat: slot.anchor_lat, lng: slot.anchor_lng }, at);
      if (detour > watch.max_detour_seconds) continue;
    } else {
      // No anchor: a whole free day, or premises work. There is no detour to
      // measure, so fall back to the coarse question the public listing asks
      // first -- is this address inside an area the operator actually works.
      // Without this gate a free day would match every watch in the country.
      const areas = areasByOperator.get(slot.operator_id) ?? [];
      const covered = areas.some(
        (a) => haversineMeters(at, { lat: a.lat, lng: a.lng }) <= a.radius_meters);
      if (!covered) continue;
    }

    out.push({ slot, detour });
  }

  out.sort((a, b) =>
    (a.detour ?? Number.MAX_SAFE_INTEGER) - (b.detour ?? Number.MAX_SAFE_INTEGER)
    || a.slot.starts_at - b.slot.starts_at);

  return out.slice(0, MAX_CANDIDATES_PER_WATCH);
}

/** Live delivery addresses for a set of watches, in chunks D1 will accept. */
async function liveSubscriptions(
  env: Env, watchIds: string[],
): Promise<Map<string, StoredSubscription[]>> {
  const byWatch = new Map<string, StoredSubscription[]>();
  // D1 caps bound parameters per statement, the same reason driveSeconds
  // chunks its cache lookup.
  for (let i = 0; i < watchIds.length; i += 90) {
    const chunk = watchIds.slice(i, i + 90);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await env.DB.prepare(
      `SELECT id, watch_id, endpoint, p256dh, auth, failed_count, disabled_at, created_at
         FROM push_subscriptions
        WHERE watch_id IN (${placeholders}) AND disabled_at IS NULL`,
    ).bind(...chunk).all<StoredSubscription>();
    for (const row of rows.results ?? []) {
      const list = byWatch.get(row.watch_id) ?? [];
      list.push(row);
      byWatch.set(row.watch_id, list);
    }
  }
  return byWatch;
}

/**
 * Sends one alert over every channel the watch has, and keeps both delivery
 * tables honest about which addresses still work.
 *
 * Returns true if at least one channel actually accepted the message. False
 * means the customer was told nothing -- no browser took the push, no provider
 * took the email, or neither is configured at all -- and the caller must not
 * record an alert it did not make.
 */
async function deliver(
  env: Env, watch: Watch, slot: PublicSlot, detour: number | null,
  targets: StoredSubscription[],
): Promise<boolean> {
  const minutes = detour == null ? null : Math.round(detour / 60);
  const base = (env.APP_URL ?? '').replace(/\/$/, '');

  const payload: AlertPayload = {
    kind: 'slot_nearby',
    title: `${slot.business_name} has ${slot.when} free`,
    body: [
      slot.service_name,
      slot.price,
      minutes == null ? null
        : minutes <= 5 ? `on their route past ${watch.postcode}`
        : `about ${minutes} min from ${watch.postcode}`,
    ].filter(Boolean).join(' · '),
    url: `${base}/book/${slot.gap_id}`,
    tag: `slot-${slot.gap_id}`,
    gap_id: slot.gap_id,
    starts_at: slot.starts_at,
    watch_label: watch.label,
  };

  const body = JSON.stringify(payload);

  let delivered = false;

  for (const target of targets) {
    const result = await sendPush(env, target, body);

    if (result.gone) {
      // The browser is gone for good. Disabled rather than deleted so the row
      // still explains why nothing is arriving when the customer asks.
      await env.DB.prepare(
        `UPDATE push_subscriptions
            SET disabled_at = ?, failed_count = failed_count + 1
          WHERE id = ?`,
      ).bind(now(), target.id).run();
      continue;
    }

    if (!result.ok) {
      // Count it, and disable only once it has failed often enough to be dead
      // in all but name.
      await env.DB.prepare(
        `UPDATE push_subscriptions
            SET failed_count = failed_count + 1,
                disabled_at = CASE WHEN failed_count + 1 >= ? THEN ? ELSE disabled_at END
          WHERE id = ?`,
      ).bind(MAX_SUBSCRIPTION_FAILURES, now(), target.id).run();
      continue;
    }

    delivered = true;

    if (target.failed_count > 0) {
      await env.DB.prepare(
        `UPDATE push_subscriptions SET failed_count = 0 WHERE id = ?`,
      ).bind(target.id).run();
    }
  }

  if (await deliverEmail(env, watch, slot, detour)) delivered = true;

  return delivered;
}

/**
 * The email half of the same alert.
 *
 * Returns true only when a provider accepted the message. Everything else --
 * no address, an address that has been dropped, no provider configured, a
 * provider that refused -- is false, because none of those reached anybody.
 */
async function deliverEmail(
  env: Env, watch: Watch, slot: PublicSlot, detour: number | null,
): Promise<boolean> {
  if (!watch.email) return false;

  // Past the ceiling this address is done, and the reason is the count itself:
  // five refusals in a row is a mailbox that does not exist, not a bad
  // afternoon. Retrying it every fifteen minutes forever spends the sending
  // domain's reputation on nobody.
  if (watch.email_failed_count >= MAX_EMAIL_FAILURES) return false;

  const result = await sendEmail(env, alertEmail(env, watch.email, watch, slot, detour));

  if (result.sent) {
    if (watch.email_failed_count > 0) {
      await env.DB.prepare(
        `UPDATE watches SET email_failed_count = 0 WHERE id = ?`,
      ).bind(watch.id).run();
    }
    return true;
  }

  // EMAIL_PROVIDER is 'none', or the key and from-address are missing. That is
  // a fact about this deployment, not about the customer's mailbox, so it must
  // not count against the address -- otherwise five ticks with email switched
  // off would silently retire an address that has never been tried.
  if (result.reason === 'not_configured') return false;

  const failures = watch.email_failed_count + 1;
  await env.DB.prepare(
    `UPDATE watches SET email_failed_count = email_failed_count + 1 WHERE id = ?`,
  ).bind(watch.id).run();

  if (failures >= MAX_EMAIL_FAILURES) {
    // The same shape as a push endpoint answering 410: stop, and leave
    // something behind that says why nothing is arriving when they ask.
    console.error(
      `watch ${watch.id}: email dropped after ${failures} refusals`,
      result.detail ?? '');
  }

  return false;
}

/**
 * What the email says.
 *
 * Everything the push notification says, plus the parts that do not fit in a
 * notification: which business, what work, when, what it costs, how far off
 * their route it is, and a link straight to the booking page for this one
 * opening.
 *
 * Unsubscribe is one click, and it does not use the watch's own token. That
 * token grants full control and only its hash is stored, so the matcher could
 * never rebuild it. Instead every watch carries a second, single-purpose key
 * whose only power is switching itself off -- see migration 0019.
 */
function alertEmail(
  env: Env, to: string, watch: Watch, slot: PublicSlot, detour: number | null,
): Email {
  const base = (env.APP_URL ?? '').replace(/\/$/, '');
  const link = `${base}/book/${slot.gap_id}`;
  const minutes = detour == null ? null : Math.round(detour / 60);

  const trade = (slot.trade ?? '').trim();
  const where = watch.label?.trim()
    ? `${watch.postcode} (${watch.label.trim()})`
    : watch.postcode;

  const distance = minutes == null
    ? null
    : minutes <= 5
      ? `On their way past ${watch.postcode}`
      : `About ${minutes} minutes out of their way from ${watch.postcode}`;

  const facts: Array<[string, string]> = [
    ['What', trade ? `${slot.service_name} (${trade})` : slot.service_name],
    ['When', slot.when],
    ['Price', slot.price],
    ...(distance ? [['Distance', distance] as [string, string]] : []),
  ];

  const why =
    `You asked to be told about openings near ${where}. `
    + `At most one of these an hour, and five in a day.`;

  const stopLink = watch.unsub_token ? `${base}/a/stop/${watch.unsub_token}` : null;
  const stop = stopLink
    ? `Stop these emails: ${stopLink}`
    // Only reachable for a watch created before unsubscribe tokens existed.
    : 'To stop these emails, open the alert link you saved and pause the watch.';

  const subject = `${slot.business_name} has ${slot.when} free`;

  const text = [
    `${slot.business_name} has an opening you asked to hear about.`,
    '',
    ...facts.map(([k, v]) => `${k}: ${v}`),
    '',
    `Book it: ${link}`,
    '',
    why,
    '',
    stop,
  ].join('\n');

  const html =
    `<p>${escapeHtml(slot.business_name)} has an opening you asked to hear about.</p>`
    + `<ul>${facts.map(([k, v]) =>
      `<li><strong>${escapeHtml(k)}:</strong> ${escapeHtml(v)}</li>`).join('')}</ul>`
    + `<p><a href="${escapeHtml(link)}">Book this opening</a></p>`
    + `<p style="color:#666;font-size:14px">${escapeHtml(why)}</p>`
    + `<p style="color:#666;font-size:14px">${escapeHtml(stop)}</p>`;

  return { to, subject, text, html };
}
