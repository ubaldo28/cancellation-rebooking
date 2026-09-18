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
 * A watch is the push half. It asks for no account, for the same reason the
 * chat threads do not: making somebody prove a phone number before they can
 * say "I want detailing near 91403" loses the request, and unlike a booking
 * there is no money and no appointment on the other side of it. Their identity
 * is the secret in their link and nothing else.
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
   * The optional second channel. NULL is the normal state and means push only.
   *
   * Held because the customer typed it into the alert form, and read by
   * nothing except the code that sends the alert they asked for.
   */
  email: string | null;
  /**
   * When the customer proved this mailbox is theirs, by opening the link in the
   * one confirmation email we send. NULL until then, and NULL is a hard stop:
   * nothing is delivered to an unconfirmed address. See the note above
   * confirmWatchEmail for what that is protecting against.
   */
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

/**
 * THE TWO KEYS A WATCH'S EMAILS CARRY, AND WHY NEITHER IS STORED IN READABLE
 * FORM.
 *
 * Every other bearer token in this codebase -- the session, the sign-in link,
 * the guest link, an offer, the watch's own token -- is random and stored only
 * as a peppered SHA-256, so a read-only copy of the database is a pile of
 * hashes and not a working set of keys. unsub_token was the exception: it was
 * written in plain text (migration 0019 argued for it) AND handed back in the
 * watch payload, so one leak of that table was a working unsubscribe link for
 * every subscriber we have.
 *
 * The argument in 0019 was real, though, and it is why this is a derivation
 * rather than a random string. The matcher sends the alert hours or weeks after
 * the watch was made, and every one of those emails needs a working
 * unsubscribe link in it -- so whatever goes in the link has to be something
 * the matcher can produce from what it holds. A random token cannot be: only
 * its hash was kept, and a hash does not run backwards.
 *
 * So the link token is computed from the watch and the pepper, and only the
 * HASH of it is stored -- which is what the column holds now, exactly like
 * token_hash beside it. A leaked table gives up neither key. Reproducing one
 * needs SESSION_PEPPER, which is a secret and is not in that table.
 *
 * The confirm key is bound to the address as well as the watch, so changing the
 * address invalidates the link that was sent to the old one. Without that, a
 * customer could confirm their own mailbox and then point the watch at a
 * stranger's.
 */
const unsubTokenFor = (env: Env, watchId: string) =>
  hashWatchToken(`watch-unsub:${watchId}`, env);

const confirmTokenFor = (env: Env, watchId: string, email: string) =>
  hashWatchToken(`watch-confirm:${watchId}:${email}`, env);

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

/**
 * What a read of a watch returns, and what it deliberately leaves behind.
 *
 * Neither unsub_token nor email_confirm_hash is in here. Both are stored as
 * hashes now, so neither would be usable by a caller anyway -- but they were
 * also being sent to the browser, and GET /api/public/watches/:token puts this
 * straight into a JSON body. A key that only ever travels in an email has no
 * business in a page's payload: the link in the email is the one place it is
 * supposed to exist.
 */
const WATCH_FIELDS =
  `id, postcode, lat, lng, country, trades, max_detour_seconds, max_price_cents,
   label, email, email_verified_at, email_failed_count, active,
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
    email,
    // Unconfirmed, and therefore not a delivery address yet. The confirmation
    // goes out below and clicking it is what turns this into a channel.
    email_verified_at: null,
    email_failed_count: 0,
    active: 1,
    last_notified_at: null,
    notify_count: 0,
    created_at: t,
    updated_at: t,
  };

  // The two email keys, as hashes. See unsubTokenFor above: the link halves are
  // derived when an email is written and never live in this table.
  const unsubHash = await hashWatchToken(await unsubTokenFor(env, watch.id), env);
  const confirmHash = email
    ? await hashWatchToken(await confirmTokenFor(env, watch.id, email), env)
    : null;

  await env.DB.prepare(
    `INSERT INTO watches (id, token_hash, unsub_token, postcode, lat, lng, country, trades,
       max_detour_seconds, max_price_cents, label, email, email_verified_at,
       email_confirm_hash, email_failed_count, active, last_notified_at,
       notify_count, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,0,1,NULL,0,?,?)`,
  ).bind(watch.id, await hashWatchToken(raw, env), unsubHash, watch.postcode, watch.lat,
    watch.lng, watch.country, trades ? JSON.stringify(trades) : null,
    watch.max_detour_seconds, watch.max_price_cents, watch.label, watch.email,
    confirmHash, watch.created_at, watch.updated_at).run();

  // One email, to ask. Sent after the row exists so a provider that hangs
  // cannot lose a watch the customer has already been told about, and its
  // failure is not the customer's problem to solve on this form: the watch is
  // made either way, the address simply stays unconfirmed and silent until
  // somebody opens the link.
  if (email) await sendConfirmation(env, watch);

  return { watch, token: raw };
}

/**
 * Switches a watch off from an unsubscribe link in an email.
 *
 * Deliberately does nothing else. It cannot read the watch, change the address
 * or reveal who it belongs to — the only outcome is that the alerts stop,
 * which is what the person clicking it asked for.
 *
 * The presented token is hashed and the hash is what is looked up, the same way
 * watchByToken resolves the watch's own token. Nothing readable is compared
 * against anything readable.
 */
export async function unsubscribeByToken(env: Env, unsubToken: string): Promise<boolean> {
  const token = (unsubToken ?? '').trim();
  if (!token) return false;
  const res = await env.DB.prepare(
    `UPDATE watches SET active = 0, updated_at = ? WHERE unsub_token = ? AND active = 1`,
  ).bind(now(), await hashWatchToken(token, env)).run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * Marks the address on a watch as belonging to whoever opened the link.
 *
 * WHY AN ADDRESS HAS TO BE CONFIRMED AT ALL. A watch is created by a stranger,
 * with no account, and the address box takes any address. Without this step,
 * POST /api/public/watches with somebody else's mailbox in it was a standing
 * instruction to mail them five times a day, from our domain, about openings
 * near an address they have never heard of, for as long as the watch lives —
 * and the only way out was a link at the bottom of mail they never asked for.
 * That is a mail-bombing tool with our reputation behind it and a CAN-SPAM
 * problem on top, and the rate limits on the route do not touch it: they slow
 * down making watches, not the sending that one watch goes on doing forever.
 *
 * So an address is a channel only once somebody has opened the one message sent
 * to it. The bounded version of the abuse is what is left: a stranger's mailbox
 * gets a single email, once, saying what was asked for and offering to do
 * nothing, and ignoring it is the correct and complete response. A watch nobody
 * confirms never mails again.
 *
 * Returns whether this click was the one that confirmed it, which is false both
 * for a token that matches nothing and for an address that was already
 * confirmed. The route must answer identically either way: a caller poking at
 * tokens learns nothing, and the person who clicked twice is not shown a
 * failure for an address that is fine.
 */
export async function confirmWatchEmail(env: Env, confirmToken: string): Promise<boolean> {
  const token = (confirmToken ?? '').trim();
  if (!token) return false;
  const t = now();
  const res = await env.DB.prepare(
    `UPDATE watches SET email_verified_at = ?, updated_at = ?
      WHERE email_confirm_hash = ? AND email IS NOT NULL AND email_verified_at IS NULL`,
  ).bind(t, t, await hashWatchToken(token, env)).run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * Asks the mailbox whether it wants any of this.
 *
 * Sent on the 'bulk' lane, with the alerts rather than with the sign-in links,
 * and the reason is the one wrangler.toml sets out: this is the side of the
 * site's email that grows with how popular the feature is, so it must not be
 * able to spend the allowance a business locked out of its own account needs. A
 * confirmation that arrives a minute late is still a confirmation.
 *
 * A provider that refuses is not counted against the address. email_failed_count
 * is for a mailbox that does not exist, and this send happens before we have
 * any reason to think one way or the other — counting it would let a bad
 * afternoon at the provider retire an address that has never been tried.
 *
 * WHAT IS STILL WORTH WATCHING. This is one message per watch created, so what
 * a stranger's mailbox can be made to receive is now bounded by how often a
 * watch can be created for it — which is the per-address bucket in front of
 * POST /api/public/watches and nothing in this file. That bucket was sized when
 * the address bought an endless standing instruction; it is now the whole of
 * the exposure, and it is the number to tighten if this is ever abused.
 */
async function sendConfirmation(env: Env, watch: Watch): Promise<boolean> {
  if (!watch.email) return false;
  const token = await confirmTokenFor(env, watch.id, watch.email);
  const result = await sendEmail(env, confirmEmail(env, watch, watch.email, token), 'bulk');
  if (!result.sent) {
    // Worth a line in the log because the customer is looking at a page that
    // has just told them to check their email.
    //
    // THE REASON ONLY, NEVER `detail`. email.ts builds detail as
    // `${provider} ${status} ${body}`, and a provider's error body routinely
    // quotes the recipient back at us — so this line was printing a stranger's
    // email address into the Worker log. Logs sit outside every sweep in
    // retention.ts and outside every erasure path in it, which makes them the
    // one place in this product that "delete my data" cannot reach. The watch
    // id is already here and is the way back to the row for anybody who needs
    // one.
    console.error(`watch ${watch.id}: confirmation not sent`, result.reason);
  }
  return result.sent;
}

/** What that one message says. */
function confirmEmail(env: Env, watch: Watch, to: string, token: string): Email {
  const base = (env.APP_URL ?? '').replace(/\/$/, '');
  const link = `${base}/a/confirm/${token}`;
  const where = watch.label?.trim()
    ? `${watch.postcode} (${watch.label.trim()})`
    : watch.postcode;

  const why =
    `Somebody asked us to email this address when a trade has an opening near `
    + `${where}. At most one of these an hour, and five in a day.`;

  // The sentence that matters most in the message, and it is addressed to the
  // person who did not ask for it: doing nothing has to be a complete answer,
  // said plainly, above the link rather than under it.
  const notYou =
    `If that was not you, ignore this email. Nothing else will be sent to this `
    + `address, and no alert will ever be, unless the link below is opened.`;

  const subject = `Confirm alerts for ${watch.postcode}`;

  const text = [
    why,
    '',
    notYou,
    '',
    `Turn the alerts on: ${link}`,
  ].join('\n');

  const html =
    `<p>${escapeHtml(why)}</p>`
    + `<p>${escapeHtml(notYou)}</p>`
    + `<p><a href="${escapeHtml(link)}">Turn these alerts on</a></p>`;

  return { to, subject, text, html };
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
  // Whether this edit points the watch at a mailbox it was not pointed at
  // before, which is the thing that has to be re-proved.
  let addressChanged = false;

  if (patch.email !== undefined) {
    // The same consent as on creation, and only for this watch.
    const email = cleanEmail(patch.email);
    // A different address is a different mailbox, so the old one's failures
    // say nothing about it. Carrying the count over would retire a good
    // address on its first send.
    if (email !== next.email) {
      next.email_failed_count = 0;
      addressChanged = true;
      // AND THE CONFIRMATION DOES NOT CARRY OVER EITHER. This is the hole that
      // would otherwise reopen everything confirmWatchEmail exists to close:
      // confirm your own mailbox, then PATCH the watch to a stranger's, and the
      // verified stamp would sit there blessing an address nobody has agreed
      // to. A new address is an unconfirmed address, every time, and it is
      // silent until somebody opens the link sent to it.
      next.email_verified_at = null;
    }
    next.email = email;
  }
  if (patch.active !== undefined) next.active = patch.active ? 1 : 0;

  next.updated_at = now();

  // Bound to the address, so the link mailed to the previous one stops working
  // the moment this row changes. NULL when the box was cleared: there is
  // nothing left to confirm.
  const confirmHash = addressChanged && next.email
    ? await hashWatchToken(await confirmTokenFor(env, next.id, next.email), env)
    : null;

  await env.DB.prepare(
    `UPDATE watches
        SET postcode = ?, lat = ?, lng = ?, country = ?, trades = ?,
            max_detour_seconds = ?, max_price_cents = ?, label = ?, email = ?,
            email_verified_at = ?,
            email_confirm_hash = CASE WHEN ? THEN ? ELSE email_confirm_hash END,
            email_failed_count = ?, active = ?, updated_at = ?
      WHERE id = ?`,
  ).bind(next.postcode, next.lat, next.lng, next.country,
    next.trades ? JSON.stringify(next.trades) : null,
    next.max_detour_seconds, next.max_price_cents, next.label, next.email,
    next.email_verified_at, addressChanged ? 1 : 0, confirmHash,
    next.email_failed_count, next.active,
    next.updated_at, next.id).run();

  // Asked for again, because it is a different mailbox being asked.
  if (addressChanged && next.email) await sendConfirmation(env, next);

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
    // An unconfirmed address is not a channel. It is a box somebody typed
    // something into, and until the link in the confirmation is opened we do
    // not know whether the person who typed it owns the mailbox. Counted as
    // "nowhere to deliver" rather than as a failed send, so the opening is not
    // burned either: if they confirm tomorrow, whatever is open tomorrow is
    // still theirs to be told about.
    const targets = subscriptions.get(watch.id) ?? [];
    const hasEmail = Boolean(watch.email) && watch.email_verified_at != null
      && watch.email_failed_count < MAX_EMAIL_FAILURES;
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

  // THE GATE, said again where the send actually happens.
  //
  // matchWatches already treats an unconfirmed address as no channel at all, so
  // in the ordinary path this is never the thing that stops a message. It is
  // here because this function is what puts mail in somebody's inbox, and the
  // rule -- nothing is delivered to an address that has not been confirmed --
  // has to hold for every future caller of it and not only for the one that
  // exists today. It is two lines; an email bomb sent from our domain because a
  // new caller did not know about the rule is not.
  if (watch.email_verified_at == null) return false;

  // Past the ceiling this address is done, and the reason is the count itself:
  // five refusals in a row is a mailbox that does not exist, not a bad
  // afternoon. Retrying it every fifteen minutes forever spends the sending
  // domain's reputation on nobody.
  if (watch.email_failed_count >= MAX_EMAIL_FAILURES) return false;

  // 'bulk' is what separates these from sign-in links. Alerts are the half of
  // this site's email that grows with how well it is doing, so they get their
  // own provider and their own daily allowance -- otherwise a good afternoon
  // spends the allowance the sign-in links need, and the failure lands on
  // businesses trying to reach their own accounts. See EmailLane in ./email.ts.
  // Worked out here rather than read off the row: only the hash of it is
  // stored. See unsubTokenFor.
  const stopToken = await unsubTokenFor(env, watch.id);

  const result = await sendEmail(
    env, alertEmail(env, watch.email, watch, slot, detour, stopToken), 'bulk');

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

  // NOR DOES BEING THROTTLED, and for exactly the same reason.
  //
  // 'rate_limited' means the provider refused this send because too many went
  // out too quickly, or because the day's free allowance is spent. Both are
  // facts about the sending account on a busy day, not about whether this
  // mailbox exists. Counting them would let one launch afternoon put several
  // ticks against a perfectly good address, and five of those retire it for
  // good -- the failure would be invisible, permanent, and land on whoever
  // happened to be alerted while the site was busiest.
  //
  // The counter is for one thing only: an address that is not there. A refusal
  // that would have been a delivery on a quieter day is not evidence of that.
  if (result.reason === 'rate_limited') return false;

  const failures = watch.email_failed_count + 1;
  await env.DB.prepare(
    `UPDATE watches SET email_failed_count = email_failed_count + 1 WHERE id = ?`,
  ).bind(watch.id).run();

  if (failures >= MAX_EMAIL_FAILURES) {
    // The same shape as a push endpoint answering 410: stop, and leave
    // something behind that says why nothing is arriving when they ask.
    //
    // The reason rather than `detail`, for the reason sendConfirmation gives:
    // the provider's error body usually contains the mailbox it refused, and a
    // Worker log is the one store in this product that no sweep and no erasure
    // can reach.
    console.error(
      `watch ${watch.id}: email dropped after ${failures} refusals`,
      result.reason);
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
 * never rebuild it. Instead every watch has a second, single-purpose key whose
 * only power is switching itself off -- worked out from the watch and the
 * pepper by unsubTokenFor and passed in, because only its hash is kept either.
 */
function alertEmail(
  env: Env, to: string, watch: Watch, slot: PublicSlot, detour: number | null,
  stopToken: string,
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

  // Always present now: the key is derived, so there is no watch this cannot be
  // built for and no email that goes out without a way to stop it.
  const stop = `Stop these emails: ${base}/a/stop/${stopToken}`;

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
