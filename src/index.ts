import type { Candidate, Env, Operator } from './types';
import {
  clearCookie, consumeLoginToken, createLoginToken, requireAdmin, requireOperator,
  revokeSession,
} from './lib/auth';
import {
  COUNTRY_LIST, LAUNCH_STATE, formatMoney, getCountry, isLaunchArea, isValidPostcode,
  localeFor, normalisePostcode,
} from './lib/countries';
import { preflight, withCors } from './lib/cors';
import { mayEchoSignInLink, sendEmail, signInEmail } from './lib/email';
import { detectGaps } from './lib/gaps';
import { geocode } from './lib/geo';
import { guardGuestLink, sweepGuestLinkAttempts } from './lib/guestlink';
import { WEB_IMAGE_TYPES, assertBodyWithin, cleanImageUpload } from './lib/images';
import { RateLimitedError, clientIp, enforceRateLimit } from './lib/ratelimit';
import { withSecurityHeaders } from './lib/headers';
import { requireTurnstile, tokenFromBody } from './lib/turnstile';
import { START_WORDS, STOP_WORDS, SUPPORTED_LANGUAGES, isLang } from './lib/messages';
import { verifyTwilioSignature } from './lib/twilio';
import {
  acceptOffer, createOffers, declineOffer, loadOfferByToken, markViewed,
} from './lib/offers';
import { claimSlot, discounted, mapData } from './lib/public';
import { isDemoOperator, seedDemoIfEmpty, startDemo } from './lib/demo';
import { METROS, metroPath, publicMetro } from './lib/metros';
import { listNotifications, markAllRead, markRead, unreadCount } from './lib/feed';
import {
  assertEnquiryReachAllowed, listMessages, listThreads, markThreadRead, operatorForEnquiry,
  postAsGuest, postAsOperator, recordEnquiryReach, startThread, sweepEnquiryReach,
  threadByToken, threadForOperator, unreadThreadCount,
} from './lib/chat';
import {
  addSubscription, createWatch, deactivateWatch, matchWatches, removeSubscription,
  unsubscribeByToken, updateWatch, watchByToken,
} from './lib/alerts';
import { vapidPublicKey } from './lib/push';
import { cancelOpening, listOpenings, postOpening } from './lib/openings';
import { placeOrder, priceOrder } from './lib/orders';
import {
  cleanPartsFields, decideQuote, partsLine, quotableItems, quotesForGuest,
  quotesForOperator, sendQuote, withdrawQuote, expireQuotes,
} from './lib/parts';
import {
  cancelByCustomer, cancelByOperator, feesOwed, listFees, listingBlock, markArrived,
  quoteRefund,
} from './lib/bypass';
import { addressReleaseColumns, maskCustomerRow, maskEmail, maskPhone } from './lib/redact';
import {
  assertNoCardData, assertPaymentRef, cardSafeDb, safeBrand, safeLast4,
  stripeWebhooksConfigured, verifyStripeSignature,
} from './lib/payments';
import { listAdminActions, recordAdminAction } from './lib/audit';
import {
  closeOperatorAccount, eraseCustomerByToken, forgetVan, sweepRetention,
} from './lib/retention';
import { catalogFor, TRADE_CATEGORIES } from './lib/trades';
import { deleteFaq, listFaqs, saveFaq } from './lib/profile';
import {
  acceptRequest, cancelRequest, createInstantRequest, declineRequest, expireRequests,
  goOffline, goOnline, onlineStatus, operatorsOnlineNear, pendingForOperator,
  requestByToken,
} from './lib/online';
import {
  askForEstimate, decideEstimate, estimatesForGuest, estimatesForOperator,
  expireEstimates, quoteEstimate, withdrawEstimate,
} from './lib/estimates';
import {
  displayName, leaveReview, listReviews, ratingFor, releasePhoto, replyToReview,
  reviewableFor, reviewsForTrade,
} from './lib/reviews';
import {
  answerWork, confirmArrival, flaggedOperators, flagSummary, pendingQuestion,
  settleExpiredHolds,
} from './lib/settlement';
import {
  MAX_BYTES as MAX_PROOF_BYTES,
  addJobPhoto, deleteJobPhoto, isStage, proofSummary, readJobPhoto,
} from './lib/proof';
import {
  getVehicle, jobCodeForGuest, reportVehicle, saveVehicle, vehicleReports,
  verifyStartCode,
} from './lib/startcode';
import {
  confirmNoShow, customerStanding, hasOperatorCard, openReports, operatorStanding,
  rejectNoShow, reportNoShow, saveOperatorCard,
} from './lib/standing';
import {
  areaIndexPage, browseIndexPage, canonicalTradeSegment, categoryPage, costGuidePage,
  costIndexPage, metroPage, neighbourhoodPage, profilePage, robotsTxt, sitemapXml,
  tradeFromPathSegment, tradeInPlacePage, tradePage,
} from './lib/seo';
import {
  getCredentials, publishBlockers, rulesFor, saveCredentials,
} from './lib/credentials';
import {
  customerView, operatorPosition, recordPosition, setShareLocation,
} from './lib/track';
import {
  MAX_PHOTO_BYTES, addPhoto, deletePhoto, ensureProfileSlug, getPublicProfile,
  listPhotos, reorderPhotos, similarBusinesses,
} from './lib/profile';
import { rankCandidates, type GapRow } from './lib/rank';
import { formatTimeRange, localDayStart } from './lib/tz';
import {
  HttpError, badRequest, conflict, escapeHtml, html, json, newId, notFound, now, toE164,
} from './lib/util';

// ---------------------------------------------------------------------------
// Tiny router
// ---------------------------------------------------------------------------
type Handler = (ctx: {
  req: Request; env: Env; params: Record<string, string>; url: URL;
}) => Promise<Response>;

const routes: Array<{ method: string; pattern: RegExp; keys: string[]; handler: Handler }> = [];

function route(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp(
    '^' + path.replace(/:[A-Za-z_]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '/?$',
  );
  routes.push({ method, pattern, keys, handler });
}

/**
 * The captured path segments, or null when one of them is not decodable.
 *
 * decodeURIComponent throws on a malformed escape — a lone `%`, `%ZZ`, half a
 * multi-byte sequence — and every token, slug and object key in this file
 * arrives through it. Returning null instead of throwing is what lets the
 * router treat that as "no such path", which is what it is: a segment that
 * cannot be decoded is not a name any row in this database has.
 */
function decodeParams(keys: string[], m: RegExpExecArray): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (let i = 0; i < keys.length; i++) {
    try { params[keys[i]!] = decodeURIComponent(m[i + 1]!); }
    catch { return null; }
  }
  return params;
}

/**
 * Every request body in the product is parsed here, which is what makes this
 * the right place for the card check rather than one more thing each handler
 * has to remember.
 *
 * A route added next year gets it without knowing it exists. See
 * lib/payments.ts for the other two halves of the same guarantee — the
 * database wrapper, and the check on the way back out in json().
 */
async function body<T = any>(req: Request): Promise<T> {
  const ct = req.headers.get('content-type') ?? '';
  let parsed: unknown = {};
  try {
    if (ct.includes('application/json')) parsed = await req.json();
    else if (ct.includes('form')) parsed = Object.fromEntries(await req.formData());
  } catch { /* fall through with the empty object */ }
  assertNoCardData(parsed, 'a request body');
  return parsed as T;
}

/**
 * Mark an operator's calendar as moved.
 *
 * The cron uses this to decide who actually needs rescanning. Anything that
 * can change where a gap starts or ends must call it: bookings, completions,
 * cancellations, working hours, time off. Missing a call means stale gaps;
 * calling it too often just costs one cheap write.
 */
const touchCalendar = (env: Env, operatorId: string) =>
  env.DB.prepare(
    `UPDATE operators SET calendar_version = calendar_version + 1, updated_at = ? WHERE id = ?`,
  ).bind(now(), operatorId).run();

// ---------------------------------------------------------------------------
// Rate limiting
//
// There is no table of limits: each route below passes its own bucket and
// numbers to enforceRateLimit. This is the reasoning behind those numbers, so
// that they read as decisions rather than as taste.
//
// Bucket by the thing being protected, which is rarely the same as the caller:
//   - IP for anonymous abuse, where there is nothing else to hold on to.
//   - The guest token or the operator id wherever one exists, because a whole
//     office behind one address is one IP and must not be one budget.
//   - The target — a business, a slot, a mailbox — wherever hammering one
//     thing is the attack rather than making many requests in general.
//
// Writes are tighter than reads: a customer legitimately sends a dozen chat
// messages in a minute, and nobody legitimately creates forty bookings. Reads
// that the front end polls (a guest thread every 15s, the van every 30s) get
// several times the traffic a real page produces, because a limit that fires
// on a real customer is a bug and not a defence. Where the honest answer was
// "I do not know", the number errs loose and says so.
//
// The /near pages, the metro pages, the sitemap and robots.txt are deliberately
// not limited: they exist to be crawled, they are the same answer for
// everybody, and throttling Googlebot to slow down a scraper trades the entire
// point of those pages for nothing.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Reading values off a parsed body
// ---------------------------------------------------------------------------
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null;

/**
 * A whole number out of a body field or a query parameter, or null for the
 * absence of one.
 *
 * The null is the entire value of this helper and it used to be unreachable
 * for the callers that needed it most. `Number(null)` is 0 and `Number('')` is
 * 0, so an absent query parameter — which `URLSearchParams.get` returns as
 * null — arrived here as a perfectly finite zero and every `int(...) ?? now()`
 * in the file silently defaulted to the epoch instead. GET /api/appointments
 * and GET /api/gaps both window on those values, so a call with no explicit
 * window asked for the first fortnight of 1970 and answered `[]` — and so did
 * a call that named only `from`, because the `to` beside it collapsed to 0 and
 * closed the window before it opened. Neither failed; both simply reported
 * that the operator had nothing on.
 *
 * So only a number or a string is a number here. Everything else — null,
 * undefined, a blank or whitespace string, a boolean, an array, an object — is
 * the absence of a value, which is what makes `?? fallback` mean what every
 * caller in this file already reads it to mean.
 */
const int = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

/** The same rule as `int`, keeping the fraction: coordinates and nothing else. */
const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/**
 * An id out of a request body, proved to belong to the operator making it.
 *
 * Every foreign key on this API arrives as a string a caller typed, and a
 * scoped UPDATE is not enough on its own: `WHERE id = ? AND operator_id = ?`
 * protects the row being written, and says nothing about a row this one now
 * POINTS AT. POST /api/appointments took client_id, lead_id and service_id
 * straight off the body, so one business could file an appointment against
 * another business's client — and then read that customer's first name,
 * surname and phone number straight back out of GET /api/appointments, which
 * joins clients to show exactly those columns. The same handle also drove a
 * write: marking it a no-show incremented a stranger's no_show_count, which is
 * what ranks that customer down for the business that actually has them.
 *
 * Returns null for an absent id, so an optional column stays optional; throws
 * 404 — the same answer as an id that does not exist anywhere — for one that
 * belongs to somebody else, because "wrong owner" and "no such row" must not
 * be distinguishable to a caller probing with ids.
 */
async function ownedId(
  env: Env, table: 'clients' | 'services' | 'job_leads' | 'locations',
  raw: unknown, operatorId: string, label: string,
): Promise<string | null> {
  const id = str(raw);
  if (!id) return null;
  const row = await env.DB.prepare(
    `SELECT id FROM ${table} WHERE id = ? AND operator_id = ?`,
  ).bind(id, operatorId).first();
  if (!row) throw notFound(`${label} not found.`);
  return id;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
route('POST', '/api/auth/request', async ({ req, env }) => {
  const b = await body(req);
  const email = str(b.email)?.toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('Enter a valid email.');

  // Two buckets: one stops someone hammering a single mailbox, the other stops
  // one host mass-creating operator rows.
  //
  // Deliberately NOT behind Turnstile, unlike the four public forms in this
  // file. The per-address bucket is the one that matters here and it is
  // already IP-independent, so a botnet buys nothing: twenty mails an hour to
  // a given mailbox is the ceiling however many hosts are asking. What is on
  // the other side is also worth less than on those forms — a junk operator
  // row is unpublished, unlisted and unbookable until somebody signs in and
  // fills in a profile, and none of it touches the refund or suspension
  // ladders. Against that, this is the front door for the businesses the
  // product needs, and a challenge on a sign-in box is friction paid by every
  // one of them, forever, to slow an attack the limits already bound. Worth
  // revisiting the day the email bill or the operators table says otherwise.
  await enforceRateLimit(env, `auth:${email}`, 5, 900);
  await enforceRateLimit(env, `auth-ip:${clientIp(req)}`, 20, 900);

  let op = await env.DB.prepare(`SELECT * FROM operators WHERE lower(email) = ?`)
    .bind(email).first<Operator>();

  if (!op) {
    const t = now();
    const id = newId();
    // Country drives the sensible defaults for timezone and currency, but the
    // caller can override both — and MUST, in a multi-timezone country.
    // Was 'GB'. With the country list cut to the United States that default
    // no longer resolved, so anyone who signed up without naming a country was
    // rejected outright — the whole signup path, not an edge case.
    const iso = (str(b.country) ?? 'US').toUpperCase();
    const c = getCountry(iso);
    if (!c) throw badRequest(`Country "${iso}" is not supported yet.`, 'unsupported_country');

    await env.DB.prepare(
      // share_location defaults to 0 on the column, from when tracking was a
      // nicety. It is now required to list, so a new operator defaulting to 0
      // would sign up and immediately be told they cannot put work up, for a
      // setting they have never seen. New accounts start switched on and the
      // browser still asks its own permission before any fix is sent -- this
      // flag is consent to share, not access to the device.
      `INSERT INTO operators (id, email, business_name, trade, timezone, country, currency,
                              location_mode, fill_model, share_location,
                              trial_ends_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?)`,
    ).bind(
      id, email, str(b.business_name) ?? 'My business', str(b.trade),
      str(b.timezone) ?? c.defaultTimezone, c.iso2, str(b.currency) ?? c.currency,
      str(b.location_mode) ?? 'mobile', str(b.fill_model) ?? 'both',
      t + 60 * 60 * 24 * 14, t, t,
    ).run();
    op = await env.DB.prepare(`SELECT * FROM operators WHERE id = ?`).bind(id).first<Operator>();
  }

  const token = await createLoginToken(env, op!.id);
  const link = `${env.APP_URL.replace(/\/$/, '')}/auth/verify?token=${token}`;

  const mail = signInEmail(link, op!.business_name);
  mail.to = op!.email;
  const result = await sendEmail(env, mail);

  // The link is echoed ONLY for local development, and only to a caller that
  // presented the debug secret. Anything else gets the same opaque response
  // whether or not the address exists, so this endpoint cannot be used to
  // enumerate operators — or, as it previously could, to sign in as one.
  if (mayEchoSignInLink(env, req.headers.get('x-auth-debug'))) {
    return json({ ok: true, sign_in_link: link, email: result });
  }

  if (!result.sent) {
    console.error('sign-in email not sent', result);
    if (result.reason === 'not_configured') {
      throw new HttpError(
        503,
        'Email delivery is not configured, so sign-in links cannot be sent.',
        'email_not_configured',
      );
    }
    throw new HttpError(502, 'Could not send the sign-in email. Try again.', 'email_failed');
  }

  return json({ ok: true });
});

/**
 * Supported countries, for the onboarding dropdown. `multi_timezone` marks the
 * ones where the default zone is a coin flip and the operator must pick — get
 * this wrong and every working day lands in the wrong hour.
 */
route('GET', '/api/countries', async () =>
  json({
    countries: COUNTRY_LIST.map((c) => ({
      iso2: c.iso2, name: c.name, dial: c.dial, currency: c.currency,
      default_timezone: c.defaultTimezone,
      multi_timezone: c.multiTimezone === true,
      has_postal_codes: c.noPostalCodes !== true,
    })),
  }));

route('POST', '/api/auth/verify', async ({ req, env }) => {
  // The one endpoint in the file that turns a secret into a session, and the
  // only credential check that had no ceiling at all. The token is 32 random
  // bytes, so this is not what makes guessing hopeless — but an unbounded
  // guess loop against the session issuer is a thing to be able to see and
  // stop, and a person clicking the link in their email does it once.
  await enforceRateLimit(env, `verify:${clientIp(req)}`, 30, 900);
  const b = await body(req);
  const token = str(b.token);
  if (!token) throw badRequest('Missing token.');
  const { cookie } = await consumeLoginToken(env, token, req.headers.get('user-agent'));
  return json({ ok: true }, 200, { 'set-cookie': cookie });
});

/**
 * Open the app with no email and no password.
 *
 * Sign-in is a magic link, so with no email provider configured nobody can get
 * in at all. This hands out a short session on a throwaway account that is
 * wiped and rebuilt on every use, so it exposes nothing real.
 */
route('GET', '/demo', async ({ req, env }) => {
  if (env.DEMO_MODE !== 'on') throw notFound();
  // Every visit wipes and rebuilds a whole account — dozens of writes, the
  // most expensive thing an anonymous caller can ask for. Six in a quarter
  // hour is more than anyone kicking the tyres needs and far less than a loop.
  await enforceRateLimit(env, `demo:${clientIp(req)}`, 6, 900);
  const cookie = await startDemo(env, req.headers.get('user-agent'));
  return new Response(null, {
    status: 302,
    headers: { location: '/app', 'set-cookie': cookie, 'cache-control': 'no-store' },
  });
});

route('POST', '/api/auth/demo', async ({ req, env }) => {
  if (env.DEMO_MODE !== 'on') throw notFound();
  // Same rebuild, same bucket as GET /demo: two doors into one expensive room.
  await enforceRateLimit(env, `demo:${clientIp(req)}`, 6, 900);
  const cookie = await startDemo(env, req.headers.get('user-agent'));
  return json({ ok: true }, 200, { 'set-cookie': cookie });
});

route('POST', '/api/auth/logout', async ({ req, env }) => {
  await revokeSession(req, env);
  return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
});

/**
 * Columns of an operator's row that must not leave in a response, even to the
 * operator themselves.
 *
 * `payment_ref` is the processor's handle on their card and is what a charge
 * is made against. There is no screen that shows it and nothing in web/ reads
 * it, so putting it in the body of /api/me only meant it sat in every browser
 * cache, every HAR file attached to a support ticket and every error reporter
 * that captures a response — for no benefit at all. The brand, the last four
 * and the date are what a person needs to recognise their own card, and
 * /api/payment-method already returns exactly those three.
 */
const PRIVATE_OPERATOR_FIELDS = ['payment_ref'] as const;

function withoutPrivateFields<T extends Record<string, unknown> | null>(row: T): T {
  if (!row) return row;
  const out = { ...row };
  for (const k of PRIVATE_OPERATOR_FIELDS) delete out[k];
  return out as T;
}

route('GET', '/api/me', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  return json({
    operator: withoutPrivateFields(op as unknown as Record<string, unknown>),
    is_demo: isDemoOperator(op.id),
  }, 200, { 'cache-control': 'no-store' });
});

/**
 * Every column PATCH /api/settings may write, and what each one will accept.
 *
 * The list used to be names alone and the handler bound whatever arrived under
 * one straight into the UPDATE. That is not a small gap in a form validator:
 * these columns are the operating parameters of the business, and the values
 * that break them look ordinary.
 *
 *   - `offers_per_wave: 0` is a business that has switched itself off. The
 *     wave takes the top nought candidates, every offer wave goes out empty,
 *     and the only symptom is gaps that quietly never fill.
 *   - `discount_percent` outside 0..100 is caught by a CHECK on the column,
 *     which means the caller got a 500 and an unhandled SQLite error rather
 *     than a sentence naming the field.
 *   - `min_gap_seconds: "abc"` is stored verbatim. SQLite has no opinion about
 *     what goes in an INTEGER column, so the string sits there and every
 *     comparison gaps.ts makes against it silently stops being arithmetic.
 *   - an empty or unknown `language` becomes part of a locale string that Intl
 *     refuses, and that throws inside a render, a long way from here.
 *
 * The front end checks four of these on the way out. That is a convenience for
 * the person typing, not a guard: it is one client of an API that anybody can
 * call, and a Worker that trusts its client is not guarded at all.
 *
 * The bounds are set past anything a real business would choose rather than
 * anywhere near it — the job is to catch a wrong unit, a typo and a hostile
 * caller, not to have an opinion about how somebody runs their diary. Each
 * range covers everything web/src/pages/Settings.tsx can produce.
 *
 * `language` is on the list because migration 0005 says the operator picks
 * their own interface language and nothing had ever let them: the column was
 * read on six paths and settable on none.
 */
type Rule =
  | { kind: 'text'; max: number; nullable?: boolean }
  | { kind: 'int'; min: number; max: number }
  | { kind: 'coord'; min: number; max: number }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'country' }
  | { kind: 'currency' }
  | { kind: 'language' }
  | { kind: 'phone' }
  | { kind: 'timezone' };

const SETTABLE: Record<string, Rule> = {
  business_name: { kind: 'text', max: 120 },
  trade: { kind: 'text', max: 80 },
  phone_e164: { kind: 'phone' },
  timezone: { kind: 'timezone' },
  country: { kind: 'country' },
  currency: { kind: 'currency' },
  language: { kind: 'language' },
  location_mode: { kind: 'enum', values: ['mobile', 'premises', 'hybrid'] },
  fill_model: { kind: 'enum', values: ['clients', 'leads', 'both'] },
  sms_mode: { kind: 'enum', values: ['device', 'twilio'] },
  home_address: { kind: 'text', max: 200, nullable: true },
  home_lat: { kind: 'coord', min: -90, max: 90 },
  home_lng: { kind: 'coord', min: -180, max: 180 },
  // Half an hour is the shortest gap the app offers to fill; a working day is
  // past the point where the setting means anything.
  min_gap_seconds: { kind: 'int', min: 300, max: 8 * 3600 },
  max_detour_seconds: { kind: 'int', min: 0, max: 4 * 3600 },
  buffer_seconds: { kind: 'int', min: 0, max: 4 * 3600 },
  // An offer nobody can answer inside five minutes is not an offer; one that
  // outlives a fortnight outlives the slot it is for.
  offer_ttl_seconds: { kind: 'int', min: 300, max: 14 * 86400 },
  offers_per_wave: { kind: 'int', min: 1, max: 10 },
  min_notice_seconds: { kind: 'int', min: 0, max: 30 * 86400 },
  reoffer_cooldown_seconds: { kind: 'int', min: 0, max: 365 * 86400 },
  discount_percent: { kind: 'int', min: 0, max: 100 },
};

/**
 * One settable value, checked and converted, or a 400 naming the field.
 *
 * The message always names the column the caller sent, because the whole
 * reason this exists is that the previous answer to a bad value was either a
 * silent success or "Something went wrong."
 */
function checkSetting(key: string, rule: Rule, raw: unknown, country: string): unknown {
  switch (rule.kind) {
    case 'text': {
      // A column that is NOT NULL cannot be cleared, and clearing it by
      // sending "" used to store a blank business name on a public profile.
      const v = str(raw);
      if (v === null) {
        if (rule.nullable && (raw === null || raw === '')) return null;
        throw badRequest(`${key} needs some text.`, 'bad_setting');
      }
      if (v.length > rule.max) {
        throw badRequest(`${key} must be ${rule.max} characters or fewer.`, 'bad_setting');
      }
      return v;
    }
    case 'int': {
      const v = int(raw);
      if (v === null) throw badRequest(`${key} must be a whole number.`, 'bad_setting');
      if (v < rule.min || v > rule.max) {
        throw badRequest(`${key} must be between ${rule.min} and ${rule.max}.`, 'bad_setting');
      }
      return v;
    }
    case 'coord': {
      // Null is meaningful here: it is "I have no fixed home base", which is
      // the state a mobile operator who cleared the address is in.
      if (raw === null || raw === '') return null;
      const v = num(raw);
      if (v === null || v < rule.min || v > rule.max) {
        throw badRequest(`${key} must be between ${rule.min} and ${rule.max}.`, 'bad_setting');
      }
      return v;
    }
    case 'enum': {
      const v = str(raw);
      if (v === null || !rule.values.includes(v)) {
        throw badRequest(`${key} must be one of: ${rule.values.join(', ')}.`, 'bad_setting');
      }
      return v;
    }
    case 'country': {
      const v = str(raw);
      const c = v ? getCountry(v) : null;
      if (!c) throw badRequest(`Country "${raw}" is not supported yet.`, 'unsupported_country');
      // Stored as the canonical ISO-3166 pair, so 'us' and 'US' cannot become
      // two different countries in the same column.
      return c.iso2;
    }
    case 'currency': {
      // ISO-4217 is three letters, and Intl.NumberFormat throws on anything
      // else — inside formatMoney, on a page, rather than here.
      const v = str(raw)?.toUpperCase() ?? '';
      if (!/^[A-Z]{3}$/.test(v)) {
        throw badRequest(`currency must be a three-letter code such as USD.`, 'bad_setting');
      }
      return v;
    }
    case 'language': {
      const v = str(raw);
      if (!isLang(v)) {
        throw badRequest(
          `language must be one of: ${SUPPORTED_LANGUAGES.join(', ')}.`, 'bad_setting');
      }
      return v;
    }
    case 'phone': {
      // Cleared deliberately, or normalised the same way a client's number is.
      // Stored raw, this column held whatever anybody typed while every other
      // number in the database was E.164, so the two could never be compared.
      if (raw === null || raw === '') return null;
      const v = toE164(str(raw), country);
      if (!v) {
        throw badRequest('That phone number is not valid for your country.', 'bad_phone');
      }
      return v;
    }
    case 'timezone': {
      // An invalid IANA name would silently poison every gap this operator has.
      const v = str(raw);
      try { new Intl.DateTimeFormat('en', { timeZone: v ?? '' }); }
      catch { throw badRequest(`"${raw}" is not a valid timezone.`, 'bad_timezone'); }
      return v;
    }
  }
}

route('PATCH', '/api/settings', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);

  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, rule] of Object.entries(SETTABLE)) {
    if (b[k] === undefined) continue;
    // The country in the same request wins over the stored one, so an operator
    // moving country and giving their new number in one call is not told their
    // own number is invalid for the country they just left.
    const country = str(b.country) ?? op.country;
    sets.push(`${k} = ?`);
    vals.push(checkSetting(k, rule, b[k], country));
  }
  if (!sets.length) throw badRequest('Nothing to update.');
  vals.push(now(), op.id);
  await env.DB.prepare(`UPDATE operators SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`)
    .bind(...vals).run();
  const fresh = await env.DB.prepare(`SELECT * FROM operators WHERE id = ?`).bind(op.id).first();
  return json({ operator: withoutPrivateFields(fresh) }, 200, { 'cache-control': 'no-store' });
});

// ---------------------------------------------------------------------------
// Working hours & time off
// ---------------------------------------------------------------------------
route('GET', '/api/working-hours', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const rows = await env.DB.prepare(
    `SELECT * FROM working_hours WHERE operator_id = ? ORDER BY weekday, start_minute`,
  ).bind(op.id).all();
  return json({ working_hours: rows.results ?? [] });
});

/** Replaces the whole week in one call — simpler than diffing on the client. */
route('PUT', '/api/working-hours', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  const list = Array.isArray(b.working_hours) ? b.working_hours : null;
  if (!list) throw badRequest('Expected { working_hours: [...] }.');
  const t = now();
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(`DELETE FROM working_hours WHERE operator_id = ?`).bind(op.id),
  ];
  for (const h of list) {
    const wd = int(h.weekday), s = int(h.start_minute), e = int(h.end_minute);
    if (wd === null || s === null || e === null) throw badRequest('Bad working hours entry.');
    if (wd < 0 || wd > 6 || s < 0 || e > 1440 || e <= s) throw badRequest('Bad working hours range.');
    // A week of hours pinned to somebody else's premises. Same class as every
    // other foreign key on this API — see ownedId — and worth the extra read
    // here because gaps.ts reads this column back to decide where a van is.
    const locationId = await ownedId(env, 'locations', h.location_id, op.id, 'Location');
    stmts.push(env.DB.prepare(
      `INSERT INTO working_hours (id, operator_id, location_id, weekday, start_minute, end_minute, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(newId(), op.id, locationId, wd, s, e, t));
  }
  await env.DB.batch(stmts);
  await touchCalendar(env, op.id);
  return json({ ok: true, count: list.length });
});

route('POST', '/api/time-off', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  const s = int(b.starts_at), e = int(b.ends_at);
  if (s === null || e === null || e <= s) throw badRequest('starts_at must be before ends_at.');
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO time_off (id, operator_id, starts_at, ends_at, reason, created_at)
     VALUES (?,?,?,?,?,?)`,
  ).bind(id, op.id, s, e, str(b.reason), now()).run();
  await touchCalendar(env, op.id);
  return json({ id }, 201);
});

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------
route('GET', '/api/services', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const rows = await env.DB.prepare(
    `SELECT * FROM services WHERE operator_id = ? ORDER BY is_active DESC, name`,
  ).bind(op.id).all();
  return json({ services: rows.results ?? [] });
});

route('POST', '/api/services', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  const name = str(b.name);
  const duration = int(b.duration_seconds);
  if (!name) throw badRequest('Service needs a name.');
  if (!duration || duration <= 0) throw badRequest('Service needs a duration in seconds.');
  const id = newId(), t = now();
  // parts_policy is NOT requires_parts. The old flag is a scheduling gate --
  // "this job needs parts on hand, so it cannot fill a slot two hours from
  // now". The new one is about who pays for them and when the customer finds
  // out. Both are written here and they are independent.
  const parts = cleanPartsFields(b);
  await env.DB.prepare(
    `INSERT INTO services
       (id, operator_id, name, duration_seconds, min_duration_seconds, max_duration_seconds,
        price_cents, cadence_days, requires_parts, requires_client_present,
        gap_fill_eligible, is_mobile, parts_policy, parts_note,
        parts_estimate_low_cents, parts_estimate_high_cents, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    id, op.id, name, duration, int(b.min_duration_seconds), int(b.max_duration_seconds),
    int(b.price_cents) ?? 0, int(b.cadence_days),
    b.requires_parts ? 1 : 0,
    b.requires_client_present === false ? 0 : 1,
    b.gap_fill_eligible === false ? 0 : 1,
    b.is_mobile === false ? 0 : 1,
    parts.parts_policy, parts.parts_note,
    parts.parts_estimate_low_cents, parts.parts_estimate_high_cents, t, t,
  ).run();
  return json({ id }, 201);
});

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------
route('DELETE', '/api/services/:id', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  // Soft delete: past appointments point at this row and must keep their name
  // and price. Deactivating stops it being sold without rewriting history.
  const res = await env.DB.prepare(
    `UPDATE services SET is_active = 0, updated_at = ?
      WHERE id = ? AND operator_id = ? AND is_active = 1`,
  ).bind(now(), params.id, op.id).run();
  if ((res.meta.changes ?? 0) === 0) throw notFound('No such service.');
  return json({ ok: true });
});

route('GET', '/api/clients', async ({ req, env, url }) => {
  const op = await requireOperator(req, env);
  const q = url.searchParams.get('q');
  const overdue = url.searchParams.get('overdue') === '1';
  const rows = await env.DB.prepare(
    `SELECT clients.*, ${addressReleaseColumns('clients.id')}
       FROM clients
      WHERE operator_id = ? AND is_active = 1
        AND (? IS NULL OR (first_name || ' ' || COALESCE(last_name,'')) LIKE ?)
        AND (? = 0 OR (next_due_at IS NOT NULL AND next_due_at <= ?))
      ORDER BY (next_due_at IS NULL), next_due_at ASC
      LIMIT 500`,
  ).bind(op.id, q, q ? `%${q}%` : null, overdue ? 1 : 0, now()).all();
  // Masked on the way out for clients the PLATFORM introduced. An operator's
  // own imported list is untouched -- they typed those numbers in themselves.
  //
  // The address is on the same footing as the number and was not being treated
  // that way here: a customer who booked and cancelled had their street line
  // and coordinates withdrawn from the schedule and left sitting on this list.
  // The two columns joined above are what let maskCustomerRow answer that, and
  // without them it withholds the address rather than guessing.
  return json({
    clients: (rows.results ?? []).map((r) => maskCustomerRow(r as Record<string, unknown>)),
  });
});

route('POST', '/api/clients', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  const first = str(b.first_name);
  if (!first) throw badRequest('Client needs a first name.');

  const phone = toE164(str(b.phone_e164), op.country);
  if (str(b.phone_e164) && !phone) {
    throw badRequest('That phone number is not a valid number for your country.', 'bad_phone');
  }
  const consent = b.sms_consent ? 1 : 0;
  if (consent && !phone) throw badRequest('Can not record SMS consent without a phone number.');

  const postcode = str(b.postcode);
  if (postcode && !isValidPostcode(postcode, op.country)) {
    throw badRequest(
      `That does not look like a valid postcode for ${getCountry(op.country)?.name ?? op.country}.`,
      'bad_postcode',
    );
  }

  // Their own service, not any service. rank.ts joins this column with no
  // operator of its own to scope by, so a foreign id here would put another
  // business's service name and price on a candidate card. See ownedId.
  const defaultServiceId = await ownedId(env, 'services', b.default_service_id, op.id, 'Service');

  let lat = b.lat != null ? Number(b.lat) : null;
  let lng = b.lng != null ? Number(b.lng) : null;
  let status: 'pending' | 'ok' | 'failed' | 'manual' = lat != null ? 'manual' : 'pending';
  if (lat == null && (postcode || str(b.address_line))) {
    const p = await geocode(env, str(b.address_line), postcode, op.country);
    if (p) { lat = p.lat; lng = p.lng; status = 'ok'; } else { status = 'failed'; }
  }

  const id = newId(), t = now();
  try {
    await env.DB.prepare(
      `INSERT INTO clients
         (id, operator_id, first_name, last_name, phone_e164, email, address_line, postcode,
          lat, lng, geocode_status, geocoded_at, default_service_id, last_serviced_at,
          next_due_at, sms_consent, sms_consent_at, notes, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      id, op.id, first, str(b.last_name), phone, str(b.email),
      str(b.address_line), postcode, lat, lng, status, lat != null ? t : null,
      defaultServiceId, int(b.last_serviced_at), int(b.next_due_at),
      consent, consent ? t : null, str(b.notes), t, t,
    ).run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) {
      throw new HttpError(409, 'You already have a client with that phone number.', 'duplicate_phone');
    }
    throw e;
  }
  return json({ id, geocode_status: status }, 201);
});

/**
 * How each editable client column is read off the body.
 *
 * The list used to be names alone, bound straight into the UPDATE, and the
 * result was a PATCH that accepted things its own POST refuses. SQLite does
 * not enforce column types, so `lat: "over there"` was stored as text in a
 * REAL column and every distance rank.ts computes from it stopped being
 * arithmetic without anything failing; `next_due_at: "soon"` did the same to
 * the overdue list. Where a value could not be stored at all — an object bound
 * to a column — the caller got "Something went wrong." and a 500.
 *
 * `soft` marks the columns that mean something as NULL: an address that has
 * been cleared, a customer with no next visit planned. The rest must be given
 * a value if they are named at all.
 */
const CLIENT_FIELDS: Record<string, (v: unknown) => unknown> = {
  first_name: (v) => str(v) ?? badThrow('A client needs a first name.'),
  last_name: (v) => str(v),
  email: (v) => str(v),
  address_line: (v) => str(v),
  notes: (v) => str(v),
  lat: (v) => coord(v, 90, 'lat'),
  lng: (v) => coord(v, 180, 'lng'),
  last_serviced_at: (v) => stamp(v, 'last_serviced_at'),
  next_due_at: (v) => stamp(v, 'next_due_at'),
  is_active: (v) => (v ? 1 : 0),
};

const badThrow = (m: string): never => { throw badRequest(m); };

/** A coordinate, null to clear it, and nothing else. */
const coord = (v: unknown, limit: number, name: string): number | null => {
  if (v === null || v === '') return null;
  const n = num(v);
  if (n === null || n < -limit || n > limit) {
    throw badRequest(`${name} must be a number between ${-limit} and ${limit}.`, 'bad_field');
  }
  return n;
};

/** A unix timestamp, null to clear it, and nothing else. */
const stamp = (v: unknown, name: string): number | null => {
  if (v === null || v === '') return null;
  const n = int(v);
  if (n === null || n < 0) throw badRequest(`${name} must be a unix timestamp.`, 'bad_field');
  return n;
};

route('PATCH', '/api/clients/:id', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  const sets: string[] = [], vals: unknown[] = [];
  for (const [k, read] of Object.entries(CLIENT_FIELDS)) {
    if (b[k] !== undefined) { sets.push(`${k} = ?`); vals.push(read(b[k])); }
  }

  // Checked here the same way the create path checks it, rather than written
  // through with the rest: a postcode that is not one geocodes to nothing, and
  // a client with no coordinates is a client no gap can ever rank.
  if (b.postcode !== undefined) {
    const postcode = str(b.postcode);
    if (postcode && !isValidPostcode(postcode, op.country)) {
      throw badRequest(
        `That does not look like a valid postcode for ${getCountry(op.country)?.name ?? op.country}.`,
        'bad_postcode',
      );
    }
    sets.push('postcode = ?'); vals.push(postcode);
  }
  if (b.phone_e164 !== undefined) {
    const phone = toE164(str(b.phone_e164), op.country);
    if (str(b.phone_e164) && !phone) throw badRequest('Invalid phone number.', 'bad_phone');
    sets.push('phone_e164 = ?'); vals.push(phone);
  }
  if (b.sms_consent !== undefined) {
    sets.push('sms_consent = ?', 'sms_consent_at = ?');
    vals.push(b.sms_consent ? 1 : 0, b.sms_consent ? now() : null);
  }
  // The same check the create path makes, for the same reason: the row is
  // scoped to this operator, and what it points at was not. See ownedId.
  //
  // The write is what ownedId returned rather than the raw body value, so
  // clearing the column goes through as NULL. Sending `""` used to skip the
  // check — str() gives null for a blank string — and then store that blank
  // string as a service id nothing joins to.
  if (b.default_service_id !== undefined) {
    const serviceId = await ownedId(env, 'services', b.default_service_id, op.id, 'Service');
    sets.push('default_service_id = ?'); vals.push(serviceId);
  }
  if (!sets.length) throw badRequest('Nothing to update.');
  vals.push(now(), params.id, op.id);
  const res = await env.DB.prepare(
    `UPDATE clients SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND operator_id = ?`,
  ).bind(...vals).run();
  if (res.meta.changes === 0) throw notFound('Client not found.');
  return json({ ok: true });
});

// ---------------------------------------------------------------------------
// Job leads — the break-fix fill source
// ---------------------------------------------------------------------------
route('GET', '/api/leads', async ({ req, env, url }) => {
  const op = await requireOperator(req, env);
  const status = url.searchParams.get('status') ?? 'open';
  const rows = await env.DB.prepare(
    `SELECT l.*, c.first_name, c.last_name, c.phone_e164, c.acquired,
            ${addressReleaseColumns('l.client_id')}
       FROM job_leads l JOIN clients c ON c.id = l.client_id
      WHERE l.operator_id = ? AND l.status = ?
      ORDER BY l.urgency DESC, l.created_at ASC LIMIT 500`,
  ).bind(op.id, status).all();
  // The same masking the client list and the appointment list apply. This
  // query joins the same clients table by a different route and did not, which
  // is precisely the failure maskClientRow was written as a whitelist-by-
  // deletion to avoid: one query out of four that nobody updated.
  //
  // A lead carries its own copy of the address rather than the client's, and
  // that copy needed withdrawing too: a cancelled booking left the street line
  // on the leads list long after the schedule had stopped showing it. The
  // release is asked about by client and not by lead because that is where the
  // release lives -- a lead is the operator's note about a job, and the
  // permission to know where the job is belongs to the booking underneath it.
  return json({
    leads: (rows.results ?? []).map((r) => maskCustomerRow(r as Record<string, unknown>)),
  });
});

route('POST', '/api/leads', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  const title = str(b.title), clientId = str(b.client_id);
  if (!title) throw badRequest('Lead needs a title.');
  if (!clientId) throw badRequest('Lead needs a client_id.');
  const owned = await env.DB.prepare(`SELECT id FROM clients WHERE id=? AND operator_id=?`)
    .bind(clientId, op.id).first();
  if (!owned) throw notFound('Client not found.');
  // client_id was already proved to be theirs; service_id was not, and rank.ts
  // joins it to put a name and a price on the offer. See ownedId.
  const serviceId = await ownedId(env, 'services', b.service_id, op.id, 'Service');

  const id = newId(), t = now();
  await env.DB.prepare(
    `INSERT INTO job_leads
       (id, operator_id, client_id, service_id, title, description, quoted_price_cents,
        quoted_at, estimated_duration_seconds, address_line, postcode, lat, lng,
        parts_required, parts_ready, urgency, status, expires_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'open', ?,?,?)`,
  ).bind(
    id, op.id, clientId, serviceId, title, str(b.description),
    int(b.quoted_price_cents), int(b.quoted_at) ?? t, int(b.estimated_duration_seconds),
    str(b.address_line), str(b.postcode),
    b.lat != null ? Number(b.lat) : null, b.lng != null ? Number(b.lng) : null,
    b.parts_required ? 1 : 0, b.parts_ready === false ? 0 : 1,
    int(b.urgency) ?? 2, int(b.expires_at), t, t,
  ).run();
  return json({ id }, 201);
});

/** The statuses a lead may be moved between — the CHECK on the column, in code. */
const LEAD_STATUSES = ['open', 'offered', 'scheduled', 'won', 'lost', 'expired'] as const;

/**
 * How each editable lead column is read off the body.
 *
 * Three of these columns carry a CHECK constraint, and writing the body value
 * through untouched meant the database was the only thing enforcing them —
 * which it does by throwing, past every catch in this file, so `status:
 * "bogus"` answered 500 "Something went wrong." to a caller whose only mistake
 * was a typo. The two that carry no constraint were worse off: a lead's
 * `urgency` sorts the offer queue and `quoted_price_cents` is the price a
 * customer is shown, and either would accept a string and keep it.
 */
const LEAD_FIELDS: Record<string, (v: unknown) => unknown> = {
  title: (v) => str(v) ?? badThrow('A lead needs a title.'),
  description: (v) => str(v),
  address_line: (v) => str(v),
  lost_reason: (v) => str(v),
  lat: (v) => coord(v, 90, 'lat'),
  lng: (v) => coord(v, 180, 'lng'),
  expires_at: (v) => stamp(v, 'expires_at'),
  quoted_price_cents: (v) => money(v, 'quoted_price_cents'),
  estimated_duration_seconds: (v) => {
    if (v === null || v === '') return null;
    const n = int(v);
    if (n === null || n <= 0 || n > 30 * 86400) {
      throw badRequest('estimated_duration_seconds must be a positive number of seconds.', 'bad_field');
    }
    return n;
  },
  urgency: (v) => {
    const n = int(v);
    if (n === null || n < 1 || n > 5) throw badRequest('urgency must be 1 to 5.', 'bad_field');
    return n;
  },
  status: (v) => {
    const s = str(v);
    if (!s || !(LEAD_STATUSES as readonly string[]).includes(s)) {
      throw badRequest(`status must be one of: ${LEAD_STATUSES.join(', ')}.`, 'bad_field');
    }
    return s;
  },
  parts_required: (v) => (v ? 1 : 0),
  parts_ready: (v) => (v ? 1 : 0),
};

/** A price in cents. Null clears it; negative is not a price. */
const money = (v: unknown, name: string): number | null => {
  if (v === null || v === '') return null;
  const n = int(v);
  if (n === null || n < 0) throw badRequest(`${name} must be zero or more cents.`, 'bad_field');
  return n;
};

route('PATCH', '/api/leads/:id', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  const sets: string[] = [], vals: unknown[] = [];
  for (const [k, read] of Object.entries(LEAD_FIELDS)) {
    if (b[k] !== undefined) { sets.push(`${k} = ?`); vals.push(read(b[k])); }
  }
  // Same reasoning as on a client: an unusable postcode is a lead that can
  // never be placed, and the create path already refuses one.
  if (b.postcode !== undefined) {
    const postcode = str(b.postcode);
    if (postcode && !isValidPostcode(postcode, op.country)) {
      throw badRequest(
        `That does not look like a valid postcode for ${getCountry(op.country)?.name ?? op.country}.`,
        'bad_postcode',
      );
    }
    sets.push('postcode = ?'); vals.push(postcode);
  }
  if (!sets.length) throw badRequest('Nothing to update.');
  vals.push(now(), params.id, op.id);
  const res = await env.DB.prepare(
    `UPDATE job_leads SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND operator_id = ?`,
  ).bind(...vals).run();
  if (res.meta.changes === 0) throw notFound('Lead not found.');
  return json({ ok: true });
});

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------
route('GET', '/api/appointments', async ({ req, env, url }) => {
  const op = await requireOperator(req, env);
  const from = int(url.searchParams.get('from')) ?? now();
  const to = int(url.searchParams.get('to')) ?? from + 60 * 60 * 24 * 14;
  const rows = await env.DB.prepare(
    `SELECT a.*, c.first_name, c.last_name, c.phone_e164, c.acquired,
            s.name AS service_name,
            oi.id AS order_item_id, oi.arrived_at, oi.cancelled_at, oi.parts_cents,
            oi.address_released_at
       FROM appointments a
       LEFT JOIN clients c  ON c.id = a.client_id
       LEFT JOIN services s ON s.id = a.service_id
       LEFT JOIN order_items oi ON oi.appointment_id = a.id
      WHERE a.operator_id = ? AND a.ends_at > ? AND a.starts_at < ?
      ORDER BY a.starts_at`,
  ).bind(op.id, from, to).all();
  // The customer's phone and surname never reach the operator for a booking
  // the platform introduced. They get the address -- they have to drive there
  // -- and the app carries the messages. A number handed over once is handed
  // over forever, and every booking after the first one then happens somewhere
  // this product cannot see or stand behind. See redact.ts.
  //
  // And they get the address only while the booking is live. Cancelling
  // withdraws the release, and from that moment the row leaves here with no
  // street line and no coordinates on it.
  //
  // The release is read off this appointment's own order item rather than
  // through addressReleaseColumns, which asks the question per client. Here
  // there is a particular booking to ask about and its own row is the sharper
  // answer; the columns are named the same, so maskCustomerRow reads either.
  return json({
    appointments: (rows.results ?? []).map((r) => maskCustomerRow(r as Record<string, unknown>)),
  });
});

route('POST', '/api/appointments', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  const s = int(b.starts_at), e = int(b.ends_at);
  if (s === null || e === null || e <= s) throw badRequest('starts_at must be before ends_at.');

  // Overlap guard: the app owns the calendar, so it must refuse double-booking.
  const clash = await env.DB.prepare(
    `SELECT id FROM appointments
      WHERE operator_id = ? AND status = 'scheduled' AND starts_at < ? AND ends_at > ? LIMIT 1`,
  ).bind(op.id, e, s).first();
  if (clash) throw new HttpError(409, 'That overlaps an existing appointment.', 'overlap');

  // Every id on this row is checked to be one of theirs before it is written.
  // See ownedId: the appointment itself was always scoped to the operator, and
  // that was mistaken for the whole tenancy check — it is not, because what
  // the row points at is what the calendar then joins and displays.
  const clientId = await ownedId(env, 'clients', b.client_id, op.id, 'Client');
  const serviceId = await ownedId(env, 'services', b.service_id, op.id, 'Service');
  const leadId = await ownedId(env, 'job_leads', b.lead_id, op.id, 'Lead');
  const locationId = await ownedId(env, 'locations', b.location_id, op.id, 'Location');

  const id = newId(), t = now();
  await env.DB.prepare(
    `INSERT INTO appointments
       (id, operator_id, client_id, service_id, lead_id, location_id, starts_at, ends_at,
        is_mobile, address_line, postcode, lat, lng, status, price_cents, source, notes,
        created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'scheduled', ?, ?, ?, ?, ?)`,
  ).bind(
    id, op.id, clientId, serviceId, leadId, locationId,
    s, e, b.is_mobile === false ? 0 : 1, str(b.address_line), str(b.postcode),
    b.lat != null ? Number(b.lat) : null, b.lng != null ? Number(b.lng) : null,
    int(b.price_cents), str(b.source) ?? 'manual', str(b.notes), t, t,
  ).run();
  await touchCalendar(env, op.id);
  return json({ id }, 201);
});

/**
 * Update an appointment: reschedule it, or mark it done.
 *
 * Marking it 'completed' is the event the whole recurring-trade side of the
 * product hangs on. It advances last_serviced_at and recomputes next_due_at
 * from the service cadence, which is what puts the client back into the
 * overdue pool. Without this route the cadence logic in the cron can never
 * fire and the overdue list stays permanently empty.
 */
route('PATCH', '/api/appointments/:id', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  const t = now();

  const appt = await env.DB.prepare(
    `SELECT * FROM appointments WHERE id = ? AND operator_id = ?`,
  ).bind(params.id, op.id).first<any>();
  if (!appt) throw notFound('Appointment not found.');

  const starts = b.starts_at !== undefined ? int(b.starts_at) : appt.starts_at;
  const ends = b.ends_at !== undefined ? int(b.ends_at) : appt.ends_at;
  if (starts === null || ends === null || ends <= starts) {
    throw badRequest('starts_at must be before ends_at.');
  }

  const status = str(b.status) ?? appt.status;
  if (!['scheduled', 'completed', 'cancelled', 'no_show'].includes(status)) {
    throw badRequest('Unknown status.');
  }

  // Rescheduling must not land on top of another job.
  if (starts !== appt.starts_at || ends !== appt.ends_at) {
    const clash = await env.DB.prepare(
      `SELECT id FROM appointments
        WHERE operator_id = ? AND status = 'scheduled' AND id <> ?
          AND starts_at < ? AND ends_at > ? LIMIT 1`,
    ).bind(op.id, params.id, ends, starts).first();
    if (clash) throw new HttpError(409, 'That overlaps an existing appointment.', 'overlap');
  }

  // Moving the booking onto a service belongs to somebody else is the same
  // hole as naming their client on the way in, and the row's own operator_id
  // scope does nothing about it. See ownedId.
  if (b.service_id !== undefined && str(b.service_id)) {
    await ownedId(env, 'services', b.service_id, op.id, 'Service');
  }

  const sets: string[] = ['starts_at = ?', 'ends_at = ?', 'status = ?'];
  const vals: unknown[] = [starts, ends, status];
  for (const k of ['price_cents', 'notes', 'address_line', 'postcode', 'lat', 'lng', 'service_id']) {
    if (b[k] !== undefined) { sets.push(`${k} = ?`); vals.push(b[k]); }
  }
  if (status === 'no_show' && appt.status !== 'no_show' && appt.client_id) {
    // Counted here, and used to rank a repeat no-show down for future gaps.
    //
    // Scoped to the operator like every other write to this table, and not as
    // a formality: appointments created before this route began checking
    // client_id can still name a client row belonging to another business, and
    // an unscoped increment would let this hand a stranger's customer a
    // permanent strike on somebody else's list. The counter is only ever about
    // the relationship between THIS operator and THIS client.
    await env.DB.prepare(
      `UPDATE clients SET no_show_count = no_show_count + 1, updated_at = ?
        WHERE id = ? AND operator_id = ?`,
    ).bind(t, appt.client_id, op.id).run();
  }
  vals.push(t, params.id, op.id);

  await env.DB.prepare(
    `UPDATE appointments SET ${sets.join(', ')}, updated_at = ?
      WHERE id = ? AND operator_id = ?`,
  ).bind(...vals).run();

  // Recompute cadence immediately rather than waiting for the cron, so the
  // operator sees the client leave the overdue list the moment they tap done.
  let nextDue: number | null = null;
  if (status === 'completed' && appt.client_id) {
    const client = await env.DB.prepare(
      `SELECT c.id, c.default_service_id,
              COALESCE(s1.cadence_days, s2.cadence_days) AS cadence_days
         FROM clients c
         LEFT JOIN services s1 ON s1.id = ?
         LEFT JOIN services s2 ON s2.id = c.default_service_id
        WHERE c.id = ? AND c.operator_id = ?`,
    ).bind(appt.service_id, appt.client_id, op.id)
      .first<{ id: string; cadence_days: number | null }>();

    if (client) {
      nextDue = client.cadence_days ? ends + client.cadence_days * 86400 : null;
      await env.DB.prepare(
        `UPDATE clients SET
           last_serviced_at = MAX(COALESCE(last_serviced_at, 0), ?),
           next_due_at = COALESCE(?, next_due_at),
           visit_count = visit_count + 1,
           updated_at = ?
         WHERE id = ? AND operator_id = ?`,
      ).bind(ends, nextDue, t, appt.client_id, op.id).run();
    }
  }

  /**
   * THE COUNTER NOTHING WAS WRITING.
   *
   * Migration 0027 introduced `hired_count` and described it as jobs counted
   * as they complete; the listing card and the profile both print "Hired N
   * times" from it. Nothing ever incremented it. Every real business showed
   * nought forever while the sample businesses showed seeded figures, so the
   * one number meant to say "other people have used this business" said the
   * opposite about everybody who actually had customers.
   *
   * Two things this deliberately does not share with the cadence block above.
   * It is guarded on the TRANSITION into completed rather than merely on the
   * new status, because an operator who saves a finished job twice must not
   * add two to their own public count. And it does not require a client row,
   * since a job booked by a stranger off the public map is exactly the kind of
   * hire this number exists to advertise.
   */
  if (status === 'completed' && appt.status !== 'completed') {
    await env.DB.prepare(
      `UPDATE operators SET hired_count = hired_count + 1, updated_at = ?
        WHERE id = ?`,
    ).bind(t, op.id).run();
  }

  // Completing or cancelling frees time; a reschedule moves it. Either way the
  // gap picture for that day is now stale.
  await touchCalendar(env, op.id);
  if (status !== 'scheduled' || starts !== appt.starts_at) {
    try { await detectGaps(env, op, Math.min(starts, appt.starts_at), 1); }
    catch (e) { console.error('gap refresh after appointment update failed', e); }
  }

  return json({ ok: true, next_due_at: nextDue });
});

/**
 * Cancel an appointment and immediately turn the hole into a gap.
 * This is the moment the whole product exists for, so detection runs inline
 * rather than waiting for the next cron tick.
 */
route('POST', '/api/appointments/:id/cancel', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  const t = now();

  const appt = await env.DB.prepare(
    `SELECT * FROM appointments WHERE id = ? AND operator_id = ?`,
  ).bind(params.id, op.id).first<{ id: string; starts_at: number; ends_at: number; status: string }>();
  if (!appt) throw notFound('Appointment not found.');
  if (appt.status === 'cancelled') return json({ ok: true, already: true });

  await env.DB.prepare(
    `UPDATE appointments SET status='cancelled', cancelled_at=?, cancelled_by=?, updated_at=?
      WHERE id=? AND operator_id=?`,
  ).bind(t, str(b.cancelled_by) ?? 'client', t, params.id, op.id).run();

  // The release of the doorstep goes with the booking it was granted for.
  //
  // cancelByOperator and cancelByCustomer in bypass.ts both clear this column,
  // and this route -- the one behind the Cancel button on the operator's own
  // schedule -- did not, so cancelling a platform booking from the screen an
  // operator actually uses left address_released_at standing and the street
  // line served on for ever. Scoped by operator_id like the update above it:
  // an appointment id from somebody else's book releases nothing here.
  await env.DB.prepare(
    `UPDATE order_items SET address_released_at = NULL
      WHERE appointment_id = ? AND operator_id = ? AND address_released_at IS NOT NULL`,
  ).bind(params.id, op.id).run();

  await touchCalendar(env, op.id);

  const result = await detectGaps(env, op, appt.starts_at, 1);

  // Tag the gap this cancellation opened, so the dashboard can lead with it.
  await env.DB.prepare(
    `UPDATE gaps SET created_by_cancellation_of = ?, updated_at = ?
      WHERE operator_id = ? AND status = 'open'
        AND starts_at < ? AND ends_at > ?`,
  ).bind(params.id, t, op.id, appt.ends_at, appt.starts_at).run();

  const gaps = await env.DB.prepare(
    `SELECT * FROM gaps
      WHERE operator_id = ? AND status = 'open' AND starts_at < ? AND ends_at > ?`,
  ).bind(op.id, appt.ends_at, appt.starts_at).all();

  return json({ ok: true, detected: result.created, gaps: gaps.results ?? [] });
});

// ---------------------------------------------------------------------------
// Gaps
// ---------------------------------------------------------------------------
route('POST', '/api/gaps/detect', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  const from = int(b.from) ?? now();
  const days = Math.min(Math.max(int(b.days) ?? 14, 1), 60);
  const res = await detectGaps(env, op, from, days);
  return json({ ok: true, ...res });
});

route('GET', '/api/gaps', async ({ req, env, url }) => {
  const op = await requireOperator(req, env);
  const from = int(url.searchParams.get('from')) ?? now();
  const to = int(url.searchParams.get('to')) ?? from + 60 * 60 * 24 * 14;
  const rows = await env.DB.prepare(
    `SELECT g.*,
            (SELECT COUNT(*) FROM gap_offers o
              WHERE o.gap_id = g.id AND o.status IN ('sent','delivered','viewed')) AS live_offers
       FROM gaps g
      WHERE g.operator_id = ? AND g.status IN ('open','offering')
        AND g.starts_at >= ? AND g.starts_at < ?
      ORDER BY (g.created_by_cancellation_of IS NULL), g.starts_at`,
  ).bind(op.id, from, to).all<any>();

  const gaps = (rows.results ?? []).map((g) => ({
    ...g,
    label: formatTimeRange(g.starts_at, g.ends_at, op.timezone, localeFor(op.country)),
    duration_minutes: Math.round((g.ends_at - g.starts_at) / 60),
  }));
  return json({ gaps });
});

async function loadGap(env: Env, op: Operator, id: string): Promise<GapRow> {
  const gap = await env.DB.prepare(
    `SELECT * FROM gaps WHERE id = ? AND operator_id = ?`,
  ).bind(id, op.id).first<GapRow>();
  if (!gap) throw notFound('Gap not found.');
  return gap;
}

route('GET', '/api/gaps/:id/candidates', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  const gap = await loadGap(env, op, params.id!);
  const candidates = await rankCandidates(env, op, gap);
  return json({
    gap: { ...gap, label: formatTimeRange(gap.starts_at, gap.ends_at, op.timezone, localeFor(op.country)) },
    candidates,
  });
});

/**
 * Send a wave of offers. The operator picks candidate_ids, or we take the top
 * `offers_per_wave` by score. In 'device' mode the response carries prefilled
 * sms: links for the operator to tap — nothing is sent from the server.
 */
route('POST', '/api/gaps/:id/offers', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  const gap = await loadGap(env, op, params.id!);

  if (gap.status === 'filled') throw new HttpError(409, 'That gap is already filled.', 'gap_filled');

  const ranked = await rankCandidates(env, op, gap);
  if (ranked.length === 0) {
    return json({ offers: [], reason: 'No eligible clients or open jobs fit this gap.' });
  }

  let chosen: Candidate[];
  if (Array.isArray(b.candidates) && b.candidates.length) {
    const wanted = new Set<string>(
      b.candidates.map((c: any) => `${c.kind}:${c.client_id}:${c.lead_id ?? ''}`),
    );
    chosen = ranked.filter((c) => wanted.has(`${c.kind}:${c.client_id}:${c.lead_id ?? ''}`));
  } else {
    chosen = ranked.slice(0, op.offers_per_wave);
  }
  if (!chosen.length) throw badRequest('None of those candidates are eligible for this gap.');

  const offers = await createOffers(env, op, gap, chosen);
  return json({ offers, sms_mode: op.sms_mode }, 201);
});

route('POST', '/api/gaps/:id/dismiss', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  const res = await env.DB.prepare(
    `UPDATE gaps SET status='dismissed', updated_at=?
      WHERE id=? AND operator_id=? AND status IN ('open','offering')`,
  ).bind(now(), params.id, op.id).run();
  if (res.meta.changes === 0) throw notFound('Gap not found or already closed.');
  return json({ ok: true });
});

// ---------------------------------------------------------------------------
// Public offer page — plain server-rendered HTML, no React, no login
// ---------------------------------------------------------------------------
function page(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#fbfaf9;--fg:#1c1a17;--mut:#6b6560;--line:#e5e0da;--accent:#1b6b4a}
@media(prefers-color-scheme:dark){:root{--bg:#171513;--fg:#f2efec;--mut:#a49d96;--line:#302b27;--accent:#4ec08b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
.card{width:100%;max-width:30rem;background:color-mix(in srgb,var(--bg) 92%,#fff);
border:1px solid var(--line);border-radius:14px;padding:28px}
h1{font-size:1.35rem;margin:0 0 4px;letter-spacing:-.01em}
.biz{color:var(--mut);font-size:.9rem;margin:0 0 20px}
.slot{font-size:1.5rem;font-weight:650;margin:0 0 6px;letter-spacing:-.02em}
.meta{color:var(--mut);margin:0 0 22px;font-size:.95rem}
form{margin:0}
button{width:100%;padding:14px;border-radius:10px;border:0;font:inherit;font-weight:600;cursor:pointer}
.yes{background:var(--accent);color:#fff;margin-bottom:10px}
.no{background:transparent;color:var(--mut);border:1px solid var(--line)}
.note{color:var(--mut);font-size:.82rem;margin-top:18px;text-align:center}
.big{font-size:2.4rem;margin:0 0 10px}
.find{display:flex;flex-direction:column;gap:12px;margin:18px 0}
.find label{display:flex;flex-direction:column;gap:6px;font-size:.85rem;color:var(--mut)}
.find input{font:inherit;font-size:16px;color:var(--fg);background:var(--bg);
border:1px solid var(--line);border-radius:9px;padding:12px 13px;min-height:48px}
.slotcard{border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:12px;
display:flex;flex-direction:column;gap:8px}
.slotcard-top{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
.who{font-weight:600}
.cost{font-weight:650}
.slotwhen{font-size:1.15rem;font-weight:650;letter-spacing:-.01em}
.near{font-size:.85rem;font-weight:600;color:var(--accent);
background:color-mix(in srgb,var(--accent) 12%,transparent);
padding:5px 10px;border-radius:20px;align-self:flex-start}
.rule{height:1px;background:var(--line);margin:20px 0}
</style></head><body><div class="card">${inner}</div></body></html>`;
}

route('GET', '/o/:token', async ({ env, params }) => {
  // Every view of this page writes (markViewed), so it is not a free read. The
  // token is the right bucket: one text message, one offer, one customer
  // refreshing it. Ten a minute leaves room for someone tapping back and forth
  // between this and the message it came in.
  await enforceRateLimit(env, `offer-view:${params.token!}`, 60, 600);
  let offer;
  try {
    offer = await loadOfferByToken(env, params.token!);
  } catch {
    return html(page('Link not found',
      `<p class="big">🔗</p><h1>This link isn't valid</h1>
       <p class="meta">Check the text message, or reply to it and we'll sort it out.</p>`), 404);
  }

  const t = now();
  const dead =
    offer.gap_status === 'filled' && offer.status !== 'accepted' ? 'taken'
    : offer.status === 'accepted' ? 'accepted'
    : offer.status === 'declined' ? 'declined'
    : (offer.expires_at != null && offer.expires_at <= t) || offer.starts_at <= t ? 'expired'
    : offer.status === 'superseded' ? 'taken'
    : null;

  const when = formatTimeRange(offer.starts_at, offer.starts_at + offer.duration_seconds,
    offer.timezone, localeFor(offer.country));
  const biz = escapeHtml(offer.business_name);

  if (dead === 'accepted') {
    return html(page('Booked', `<p class="big">✅</p><h1>You're booked in</h1>
      <p class="biz">${biz}</p><p class="slot">${escapeHtml(when)}</p>
      <p class="meta">${escapeHtml(offer.title)}</p>`));
  }
  if (dead === 'taken') {
    return html(page('Slot taken', `<p class="big">😕</p><h1>That slot just went</h1>
      <p class="biz">${biz}</p>
      <p class="meta">Someone took it a moment ago. We'll let you know next time one opens up.</p>`), 410);
  }
  if (dead === 'declined') {
    return html(page('No problem', `<h1>No problem</h1><p class="biz">${biz}</p>
      <p class="meta">We've taken you off this one. You'll hear about the next slot.</p>`));
  }
  if (dead === 'expired') {
    return html(page('Expired', `<p class="big">⌛</p><h1>This offer has expired</h1>
      <p class="biz">${biz}</p>
      <p class="meta">Reply to the text if you'd still like the slot.</p>`), 410);
  }

  await markViewed(env, offer.offer_id);

  const price = offer.quoted_price_cents && offer.quoted_price_cents > 0
    ? `<p class="meta">${escapeHtml(offer.title)} · ${escapeHtml(
        formatMoney(offer.quoted_price_cents, offer.currency, localeFor(offer.country)))}</p>`
    : `<p class="meta">${escapeHtml(offer.title)}</p>`;

  const tok = escapeHtml(params.token!);
  return html(page(`Slot available — ${offer.business_name}`, `
    <h1>Hi ${escapeHtml(offer.first_name)} 👋</h1>
    <p class="biz">${biz} has a slot free</p>
    <p class="slot">${escapeHtml(when)}</p>
    ${price}
    <form method="POST" action="/o/${tok}/accept">
      <button class="yes" type="submit">Yes, book me in</button>
    </form>
    <form method="POST" action="/o/${tok}/decline">
      <button class="no" type="submit">Not this time</button>
    </form>
    <p class="note">First to confirm gets the slot.</p>`));
});

route('POST', '/o/:token/accept', async ({ env, params }) => {
  // Accepting is first-past-the-post and takes a slot. The race is decided in
  // the database, so this is only here to stop one link being used as a
  // free-running retry loop against that race.
  await enforceRateLimit(env, `offer-decide:${params.token!}`, 20, 600);
  try {
    const res = await acceptOffer(env, params.token!);
    const o = res.offer;
    const when = formatTimeRange(o.starts_at, o.starts_at + o.duration_seconds,
      o.timezone, localeFor(o.country));
    return html(page('Booked', `<p class="big">✅</p><h1>You're booked in</h1>
      <p class="biz">${escapeHtml(o.business_name)}</p>
      <p class="slot">${escapeHtml(when)}</p>
      <p class="meta">${escapeHtml(o.title)}</p>
      <p class="note">See you then. Reply to the text if anything changes.</p>`));
  } catch (e) {
    const code = e instanceof HttpError ? e.code : undefined;
    if (code === 'slot_taken') {
      return html(page('Slot taken', `<p class="big">😕</p><h1>That slot just went</h1>
        <p class="meta">Someone confirmed a moment before you. We'll let you know next time.</p>`), 410);
    }
    return html(page('No longer available', `<p class="big">⌛</p><h1>This offer has closed</h1>
      <p class="meta">Reply to the text if you'd still like a slot.</p>`), 410);
  }
});

route('POST', '/o/:token/decline', async ({ req, env, params }) => {
  await enforceRateLimit(env, `offer-decide:${params.token!}`, 20, 600);
  const b = await body(req);
  await declineOffer(env, params.token!, str(b.reason));
  return html(page('No problem', `<h1>No problem</h1>
    <p class="meta">We've taken you off this one. You'll hear about the next slot.</p>`));
});


// ---------------------------------------------------------------------------
// Service areas — where an operator is willing to work.
//
// These are what put a pin on the public map, so an operator with none is
// invisible to strangers no matter how many slots they have open.
// ---------------------------------------------------------------------------
route('GET', '/api/service-areas', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const rows = await env.DB.prepare(
    `SELECT id, name, slug, lat, lng, radius_meters FROM service_areas
      WHERE operator_id = ? AND is_active = 1 ORDER BY name`,
  ).bind(op.id).all();
  return json({ areas: rows.results ?? [] });
});

route('POST', '/api/service-areas', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  const name = str(b.name);
  const postcode = str(b.postcode);
  if (!name) throw badRequest('Give the area a name people would recognise.');
  if (!postcode) throw badRequest('A postcode is needed to place it on the map.');

  // While this is being tested, service areas are California only. Checked
  // here because this is the one place an operator declares where they work.
  if (!isLaunchArea(postcode)) {
    throw badRequest(
      `We are only open in ${LAUNCH_STATE} while we are testing. `
      + `${postcode} is outside it.`, 'outside_launch_area');
  }

  const at = await geocode(env, null, postcode, op.country);
  if (!at) {
    throw badRequest(
      `We could not find ${postcode}. Check it, or try a nearby one.`, 'bad_postcode');
  }

  const km = Number(b.radius_km ?? 5);
  const radius = Math.round(Math.min(Math.max(km, 1), 40) * 1000);

  // The slug is the public URL for this area, so it has to be unique across
  // every operator — two detailers both covering Encino cannot share /near/encino.
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 50) || 'area';
  let slug = base;
  for (let n = 2; n < 60; n++) {
    const taken = await env.DB.prepare(`SELECT 1 FROM service_areas WHERE slug = ?`)
      .bind(slug).first();
    if (!taken) break;
    slug = `${base}-${n}`;
  }

  const id = newId(), t = now();
  await env.DB.prepare(
    `INSERT INTO service_areas (id, operator_id, name, slug, place_slug, lat, lng,
       radius_meters, is_active, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,1,?,?)`,
  ).bind(id, op.id, name, slug, base, at.lat, at.lng, radius, t, t).run();

  return json({ area: { id, name, slug, lat: at.lat, lng: at.lng, radius_meters: radius } }, 201);
});

route('DELETE', '/api/service-areas/:id', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  await env.DB.prepare(
    `UPDATE service_areas SET is_active = 0, updated_at = ?
      WHERE id = ? AND operator_id = ?`,
  ).bind(now(), params.id, op.id).run();
  return json({ ok: true });
});

// ---------------------------------------------------------------------------
// Operator profile and photos of their work.
// ---------------------------------------------------------------------------
const PROFILE_FIELDS =
  `id, email, business_name, trade, timezone, country, currency, language,
   location_mode, fill_model, sms_mode, min_gap_seconds, max_detour_seconds,
   buffer_seconds, offers_per_wave, discount_percent, plan, share_location,
   tagline, bio, years_experience, profile_slug, is_published, avatar_key`;

route('GET', '/api/profile', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const row = await env.DB.prepare(
    `SELECT ${PROFILE_FIELDS} FROM operators WHERE id = ?`,
  ).bind(op.id).first();
  return json({ operator: row, photos: await listPhotos(env, op.id) });
});

route('PATCH', '/api/profile', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  const sets: string[] = [];
  const vals: unknown[] = [];
  if ('tagline' in b) { sets.push('tagline = ?'); vals.push(str(b.tagline)); }
  if ('bio' in b) { sets.push('bio = ?'); vals.push(str(b.bio)); }
  if ('years_experience' in b) {
    const y = int(b.years_experience);
    if (y !== null && (y < 0 || y > 80)) throw badRequest('That does not look right.');
    sets.push('years_experience = ?'); vals.push(y);
  }
  if (sets.length === 0) throw badRequest('Nothing to save.');
  vals.push(now(), op.id);
  await env.DB.prepare(
    `UPDATE operators SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`,
  ).bind(...vals).run();
  const row = await env.DB.prepare(
    `SELECT ${PROFILE_FIELDS} FROM operators WHERE id = ?`,
  ).bind(op.id).first();
  return json({ operator: row });
});

route('GET', '/api/credentials', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  return json({
    credentials: await getCredentials(env, op.id),
    rule: rulesFor(op.trade),
    blockers: await publishBlockers(env, op.id),
  });
});

route('PATCH', '/api/credentials', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const credentials = await saveCredentials(env, op.id, await body(req));
  return json({ credentials, blockers: await publishBlockers(env, op.id) });
});

route('POST', '/api/profile/publish', async ({ req, env }) => {
  const op = await requireOperator(req, env);

  // A business cannot go on the public map without what California requires
  // it to hold. Checked here rather than in the page, because the page is not
  // the thing anyone would have to answer for.
  const feeBlock = await listingBlock(env, op.id);
  if (feeBlock) throw conflict(feeBlock, 'fees_owed');
  const blockers = await publishBlockers(env, op.id);
  if (blockers.length > 0) {
    throw new HttpError(409, blockers[0]!, 'not_publishable');
  }

  const slug = await ensureProfileSlug(env, op.id, op.business_name);
  await env.DB.prepare(`UPDATE operators SET is_published = 1, updated_at = ? WHERE id = ?`)
    .bind(now(), op.id).run();
  return json({ slug });
});

route('POST', '/api/profile/unpublish', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  // The slug is kept: it may already be printed on the side of their van.
  await env.DB.prepare(`UPDATE operators SET is_published = 0, updated_at = ? WHERE id = ?`)
    .bind(now(), op.id).run();
  return json({ ok: true });
});

route('GET', '/api/profile/photos', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  return json({ photos: await listPhotos(env, op.id) });
});

route('POST', '/api/profile/photos', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  if (!env.PHOTOS) throw new HttpError(503, 'Photo storage is not set up yet.', 'no_storage');
  // Signed in, so the operator is the bucket rather than the address. This one
  // is about storage that is paid for and never expires: sixty an hour is a
  // long afternoon of uploading a portfolio, and it caps what a stolen session
  // can leave behind in the bucket.
  await enforceRateLimit(env, `photo-profile:${op.id}`, 60, 3600);

  // Refused on the caller's own declared length, before the multipart body is
  // read at all. It proves nothing -- cleanImageUpload measures the real bytes
  // -- but a request that announces forty megabytes is usually telling the
  // truth, and there is no reason to buffer it to find out.
  assertBodyWithin(req, MAX_PHOTO_BYTES);

  const form = await req.formData();
  // WEB_IMAGE_TYPES and not the camera list: these go on a public page with no
  // session in front of them, and a browser will not render a HEIC.
  const { bytes, contentType } = await cleanImageUpload(form.get('file'), {
    maxBytes: MAX_PHOTO_BYTES, allowed: WEB_IMAGE_TYPES,
  });

  const key = `w/${op.id}/${newId()}`;
  await env.PHOTOS.put(key, bytes, {
    httpMetadata: { contentType, cacheControl: 'public, max-age=31536000, immutable' },
  });

  try {
    const photo = await addPhoto(env, op.id, {
      r2_key: key,
      content_type: contentType,
      bytes: bytes.length,
      caption: str(form.get('caption')),
    });
    return json({ photo }, 201);
  } catch (e) {
    // The row is the record of truth. If it was refused, the object it points
    // at must not be left behind paying for storage nobody can reach.
    await env.PHOTOS.delete(key).catch(() => {});
    throw e;
  }
});

route('DELETE', '/api/profile/photos/:id', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  const { r2_key } = await deletePhoto(env, op.id, params.id ?? '');
  await env.PHOTOS?.delete(r2_key).catch(() => {});
  return json({ ok: true });
});

route('POST', '/api/profile/photos/order', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  const ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
  return json({ photos: await reorderPhotos(env, op.id, ids) });
});

route('GET', '/api/public/profile/:slug', async ({ env, params }) => {
  const profile = await getPublicProfile(env, params.slug ?? '');
  if (!profile) throw notFound('No such profile.');
  // operator_id is an internal key; it has no business on a public page.
  const photos = profile.photos.map(({ operator_id, ...rest }) => { void operator_id; return rest; });
  // A sample business has to say so. Several of these trades are licensed in
  // California and the samples hold no licence.
  const row = await env.DB.prepare(
    `SELECT id FROM operators WHERE profile_slug = ?`,
  ).bind(params.slug).first<{ id: string }>();
  // Spread the whole profile rather than naming the keys the page happens to
  // need today. This endpoint previously listed `operator` and `photos` and
  // nothing else, so the rating, the reviews, the mentioned words, the FAQs
  // and the service areas -- all of which getPublicProfile had already
  // fetched -- were computed and then dropped on the floor, and the page threw
  // on `rating.count` and rendered blank for every business on the site.
  // Spreading means a field added to PublicProfile reaches the page instead of
  // waiting for somebody to notice it is missing.
  return json({
    ...profile,
    operator: { ...profile.operator, is_sample: isDemoOperator(row?.id ?? '') },
    photos,
  }, 200, { 'cache-control': 'public, max-age=300' });
});

/**
 * Object keys this route is allowed to hand to a stranger.
 *
 * One bucket holds two completely different kinds of picture. `w/` is an
 * operator's portfolio: they chose it, it is already on their public profile,
 * and serving it to anybody is the point. `j/` is proof of a job — the inside
 * of somebody's house, their car, their driveway — and proof.ts is explicit
 * that there must be no public URL for one, which is why every read of those
 * goes through readJobPhoto and is authorised every time.
 *
 * This route took a raw key and fetched it, so a `j/` key reached it as
 * happily as a `w/` one. Those keys are not secret either: job_photos.r2_key
 * is returned in the proof summary to BOTH sides of a booking, so an operator
 * held a permanent, unauthenticated, immutable-cached link to a customer's
 * hallway, and the customer held one to every photo the operator took inside
 * it. An allowlist rather than a `j/` block, so a third kind of photo added
 * later is private until somebody says otherwise.
 *
 * `a/` is reserved for operators.avatar_key, which nothing writes yet.
 */
const PUBLIC_PHOTO_PREFIXES = ['w/', 'a/'];

route('GET', '/api/public/photo/:key', async ({ env, params, req }) => {
  if (!env.PHOTOS) throw notFound();
  // The key arrives URL-encoded because it contains slashes.
  const key = decodeURIComponent(params.key ?? '');
  // Checked before the bucket is touched, and answering exactly as a missing
  // object does: a private key must not be distinguishable from a wrong one.
  if (!PUBLIC_PHOTO_PREFIXES.some((p) => key.startsWith(p))) throw notFound();
  const object = await env.PHOTOS.get(key);
  if (!object) throw notFound();
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  if (req.headers.get('if-none-match') === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(object.body, { headers });
});

// The map the landing page draws. Public on purpose: no account, no postcode.
/**
 * How long an anonymous map response is reused at the edge.
 *
 * This is the busiest read in the product: every visitor loads it before they
 * do anything else, and without a postcode every one of them gets an identical
 * answer. Serving it from Cloudflare's cache turns ten thousand visitors into
 * one database read per minute per location rather than ten thousand.
 *
 * A minute is short enough that an opening posted now is visible almost
 * immediately, and the number is deliberately small for that reason rather
 * than tuned for cost.
 */
const MAP_CACHE_SECONDS = 60;

route('GET', '/api/public/map', async ({ req, env, url }) => {
  // The busiest read in the product, and the edge cache already absorbs the
  // anonymous version of it — so this ceiling is only ever reached by someone
  // who is not being served from cache, which in practice means a scraper or a
  // postcode being walked. A visitor changing the postcode field a few times a
  // minute is nowhere near sixty.
  await enforceRateLimit(env, `map:${clientIp(req)}`, 60, 60);

  // Nothing to show at all means nobody has signed up yet, not that the
  // product is broken. In demo mode, fill it in once so the map has content.
  const seeded = await seedDemoIfEmpty(env);

  // A postcode is what makes this product different from a directory: it turns
  // "here is who works nearby" into "this van is eleven minutes from your
  // door". Without it the page can only show what exists, not what is close.
  const postcode = url.searchParams.get('postcode');
  let at = null;
  let located: { postcode: string; place: string | null } | null = null;

  if (postcode) {
    // A postcode makes this a lookup rather than a cached page: it misses the
    // edge cache by definition and runs the geocoder, and a postcode walk is
    // how someone maps every operator in the country. Twenty in five minutes
    // is far more than a person types and far less than a list of 40,000 ZIPs
    // is worth. Deliberately loose — this is the one bucket most likely to be
    // wrong, and the failure that matters is a customer who cannot search.
    await enforceRateLimit(env, `map-postcode:${clientIp(req)}`, 20, 300);

    // Country comes from whoever is actually listed, since a visitor cannot be
    // asked to pick one and guessing from the browser is worse than reading it.
    const row = await env.DB.prepare(
      `SELECT o.country FROM operators o
        WHERE o.accept_public_bookings = 1 AND o.plan IN ('trial','active')
        LIMIT 1`,
    ).first<{ country: string }>();
    at = await geocode(env, null, postcode, row?.country ?? 'US');
    if (!at) {
      throw badRequest(
        `We could not place ${postcode}. Check it, or try a nearby one.`, 'bad_postcode');
    }
    const place = await env.DB.prepare(
      `SELECT place_name FROM postal_codes WHERE postal_code = ? LIMIT 1`,
    ).bind(normalisePostcode(postcode)).first<{ place_name: string }>();
    located = { postcode: normalisePostcode(postcode), place: place?.place_name ?? null };
  }

  const data = await mapData(env, at);
  return json({ ...data, located }, 200, {
    // A result computed for one person's postcode is not shared cache material.
    'cache-control': seeded || at
      ? 'no-store'
      : `public, max-age=${MAP_CACHE_SECONDS}, s-maxage=${MAP_CACHE_SECONDS}`,
  });
});

// ---------------------------------------------------------------------------
// Messages.
//
// A customer talks to a business without either side handing over a phone
// number. The customer has no account: their identity is the secret in their
// link, which is also how they get back to their booking.
// ---------------------------------------------------------------------------

/** Everything the guest page needs, without leaking anything the operator owns. */
async function guestView(env: Env, thread: Awaited<ReturnType<typeof threadByToken>>) {
  if (!thread) throw notFound('That conversation link is not valid any more.');
  const op = await env.DB.prepare(
    `SELECT business_name, profile_slug, timezone, country, language, currency
       FROM operators WHERE id = ?`,
  ).bind(thread.operator_id).first<{
    business_name: string; profile_slug: string | null; timezone: string;
    country: string; language: string; currency: string;
  }>();

  const locale = op ? localeFor(op.country, op.language) : 'en-US';

  let booking = null;
  if (thread.appointment_id) {
    const a = await env.DB.prepare(
      `SELECT a.starts_at, a.ends_at, a.address_line, a.price_cents, s.name AS service_name,
              (SELECT oi.id FROM order_items oi WHERE oi.appointment_id = a.id LIMIT 1)
                AS order_item_id
         FROM appointments a LEFT JOIN services s ON s.id = a.service_id
        WHERE a.id = ? AND a.operator_id = ?`,
    ).bind(thread.appointment_id, thread.operator_id).first<any>();
    if (a) {
      booking = {
        service_name: a.service_name ?? 'Booking',
        starts_at: a.starts_at, ends_at: a.ends_at,
        address_line: a.address_line ?? null,
        // So the customer's page can hang the photo strip off the right
        // booking. Null for the older single-slot claims that predate orders.
        order_item_id: a.order_item_id ?? null,
        price: formatMoney(a.price_cents ?? 0, op?.currency ?? 'USD', locale),
      };
    }
  }

  return {
    ...thread,
    business_name: op?.business_name ?? '',
    profile_slug: op?.profile_slug ?? null,
    // The guest is signed out and has no operator record, so without this the
    // confirmation would render an 08:00 job as 07:00 UTC and somebody would
    // miss it.
    timezone: op?.timezone ?? 'UTC',
    locale,
    booking,
  };
}

/**
 * Everything that has to be true before a stranger gets a guest link.
 *
 * Both doors into a conversation go through this — the slot page, which knows
 * an operator id, and the profile page, which knows only a slug — because the
 * whole value of a gate is that it cannot be walked round. A second entry
 * point with nine tenths of the checks is not a second entry point, it is the
 * hole.
 *
 * The order is deliberate. The volume ceilings come first because they are two
 * cheap writes and everything after them is not; the challenge is next,
 * because a check that runs after the row is written is a log line rather than
 * a gate; the business is resolved before the fan-out is counted because the
 * count is of businesses; and the fan-out is spent only once the conversation
 * actually exists, so a blank name does not cost somebody an allowance.
 */
async function openEnquiry(
  req: Request, env: Env, b: Record<string, unknown>, target: { slug?: string; id?: string },
): Promise<{ thread: Awaited<ReturnType<typeof startThread>>['thread']; token: string;
  link: string; operator: { business_name: string; profile_slug: string | null } }> {
  const guestName = str(b.guest_name);
  if (!guestName) throw badRequest('We need a name to put on the message.');

  const ip = clientIp(req);

  // Two buckets, because there are two different abuses. One host opening
  // conversations everywhere is the first; ten a quarter hour still lets a
  // customer message several businesses about the same job. One business
  // buried under new conversations is the second, and forty is well above a
  // busy day's real enquiries for a single van.
  //
  // The keys are shared by both doors on purpose: bucketing the profile route
  // separately would have made it the way round the ceiling on the other one.
  await enforceRateLimit(env, `thread-ip:${ip}`, 10, 900);
  if (target.id) await enforceRateLimit(env, `thread-op:${target.id}`, 40, 900);

  // The door into every other guest route. Everything under
  // /api/public/threads/:token is reachable only by holding a token this
  // endpoint minted, so a challenge here is a challenge on all of them, and
  // none of those has to ask for one again mid-conversation.
  await requireTurnstile(env, req, tokenFromBody(b));

  const op = await operatorForEnquiry(env, target);
  if (!op) throw notFound('That business is not taking messages.');

  // Bucketed here too when the caller named a slug, because the ceiling above
  // could only be applied to a target already known by id.
  if (!target.id) await enforceRateLimit(env, `thread-op:${op.id}`, 40, 900);

  // The one thing a rate limit cannot see: how many DIFFERENT businesses this
  // address has opened a conversation with. See chat.ts for why that is a
  // separate measurement rather than a tighter number on the buckets above.
  await assertEnquiryReachAllowed(env, ip, op.id);

  const kind = str(b.kind) === 'quote' ? 'quote' : 'message';

  const { thread, token } = await startThread(env, {
    operator_id: op.id,
    gap_id: str(b.gap_id),
    guest_name: guestName,
    // A quote request writes its own line into the conversation, from
    // estimates.ts, in the customer's own words. Passing the same text as an
    // opening message as well would put it in the thread twice.
    subject: str(b.subject) ?? (kind === 'quote' ? 'Quote request' : null),
    first_message: kind === 'quote' ? undefined : str(b.first_message) ?? undefined,
  });

  await recordEnquiryReach(env, ip, op.id);

  return {
    thread, token,
    link: `${env.APP_URL.replace(/\/$/, '')}/c/${token}`,
    operator: { business_name: op.business_name, profile_slug: op.profile_slug },
  };
}

route('POST', '/api/public/threads', async ({ req, env }) => {
  const b = await body(req);
  const operatorId = str(b.operator_id);
  if (!operatorId) throw badRequest('Which business are you writing to?');

  const opened = await openEnquiry(req, env, b, { id: operatorId });
  // The only response that may ever carry the raw token.
  return json({ thread: opened.thread, token: opened.token, link: opened.link }, 201);
});

/**
 * "Message" and "Request a quote", from a business's profile page.
 *
 * The reference marketplace puts both on a profile as first-class actions,
 * usable when nothing is scheduled. This site had neither, and could not have
 * had them: the profile route deliberately does not publish an operator id —
 * it is an internal key — so the page had no way to name the business it was
 * looking at to the one endpoint that mints a guest link. That is what the
 * slug is for.
 *
 * It mints exactly the same token every booking mints, so /c/:token and the
 * whole guest surface behind it work unchanged and this adds no second kind of
 * conversation to maintain. `kind: 'quote'` hands the request straight to
 * askForEstimate — the estimates machinery already models a question, an
 * answer with a price and a time, and an acceptance that becomes a booking, so
 * there is nothing here to reinvent.
 */
route('POST', '/api/public/profile/:slug/enquiries', async ({ req, env, params }) => {
  const b = await body(req);
  const wantsQuote = str(b.kind) === 'quote';

  // Checked before anything is written, because an estimate can only be
  // attached to a conversation that already exists — so a refusal after the
  // mint would cost the sender the one copy of their link that will ever
  // exist. The rest of the rules about what may be asked stay in estimates.ts,
  // which owns them; this is only the case a form produces by being submitted
  // empty.
  if (wantsQuote && !str(b.request)) {
    throw badRequest('Say what you would like doing. They cannot price a blank.',
      'no_request');
  }

  const opened = await openEnquiry(req, env, b, { slug: params.slug ?? '' });

  // Handed straight to the estimates machinery, which writes the request into
  // the conversation in the customer's own words and tells the business. There
  // is deliberately no second path: a quote asked for from a profile and one
  // asked for mid-conversation are the same thing and have to stay the same
  // rows, or the business ends up with two inboxes.
  const estimate = wantsQuote
    ? await askForEstimate(env, opened.token, str(b.request) ?? '')
    : null;

  return json({
    thread: opened.thread, token: opened.token, link: opened.link,
    operator: opened.operator, estimate,
  }, 201);
});

route('GET', '/api/public/threads/:token', async ({ env, params }) => {
  // The guest page polls this every 15 seconds (GuestThread.tsx), so an open
  // tab spends 20 of these per five minutes. The ceiling is seven times that
  // on purpose: two tabs, a reconnect and a few manual refreshes must all fit
  // under it, because the person tripping this is the customer whose booking
  // it is.
  await enforceRateLimit(env, `thread-read:${params.token ?? ''}`, 150, 300);
  const thread = await threadByToken(env, params.token ?? '');
  const view = await guestView(env, thread);
  const messages = await listMessages(env, view.id);
  await markThreadRead(env, 'guest', { token: params.token ?? '' });
  return json({ thread: view, messages }, 200, { 'cache-control': 'no-store' });
});

route('POST', '/api/public/threads/:token/messages', async ({ req, env, params }) => {
  // Bucketed on the token rather than the IP: the guest has no account, the
  // link is who they are, and a family on one connection must not share a
  // budget. Thirty a minute is roughly one message every two seconds — well
  // past how fast anybody types and slow enough that a script cannot fill an
  // operator's inbox.
  await enforceRateLimit(env, `guest-msg:${params.token ?? ''}`, 30, 60);
  const b = await body(req);
  const message = await postAsGuest(env, params.token ?? '', String(b.body ?? ''));
  return json({ message }, 201);
});

route('GET', '/api/threads', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const unreadOnly = new URL(req.url).searchParams.get('unread') === '1';
  const [threads, unread] = await Promise.all([
    listThreads(env, op.id, { unreadOnly }),
    unreadThreadCount(env, op.id),
  ]);
  return json({ threads, unread });
});

route('GET', '/api/threads/:id', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  const thread = await threadForOperator(env, op.id, params.id ?? '');
  if (!thread) throw notFound('No such conversation.');
  return json({ thread, messages: await listMessages(env, thread.id) });
});

route('POST', '/api/threads/:id/messages', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  const message = await postAsOperator(env, op.id, params.id ?? '', String(b.body ?? ''));
  return json({ message }, 201);
});

route('POST', '/api/threads/:id/read', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  await markThreadRead(env, 'operator', { operator_id: op.id, thread_id: params.id ?? '' });
  return json({ ok: true });
});

// ---------------------------------------------------------------------------
// Openings an operator posts by hand.
//
// Someone who already has a full book will not type their whole diary in to
// sell one free Thursday. This is the path that does not require them to.
// ---------------------------------------------------------------------------
route('POST', '/api/openings', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  // An unpaid lead fee stops new listings and nothing else. It never touches a
  // job already booked -- a customer who has paid gets their appointment
  // whatever their operator owes us. See bypass.ts.
  const blocked = await listingBlock(env, op.id);
  if (blocked) throw conflict(blocked, 'fees_owed');
  const b = await body(req);
  const opening = await postOpening(env, op.id, {
    starts_at: int(b.starts_at) ?? 0,
    ends_at: int(b.ends_at) ?? 0,
    service_ids: Array.isArray(b.service_ids) ? b.service_ids.map(String) : undefined,
  });
  return json({ opening }, 201);
});

route('GET', '/api/openings', async ({ req, env, url }) => {
  const op = await requireOperator(req, env);
  const t = now();
  const from = int(url.searchParams.get('from')) ?? t;
  const to = int(url.searchParams.get('to')) ?? t + 60 * 86400;
  return json({ openings: await listOpenings(env, op.id, from, to) });
});

route('DELETE', '/api/openings/:id', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  await cancelOpening(env, op.id, params.id ?? '');
  return json({ ok: true });
});

// ---------------------------------------------------------------------------
// Parts quotes
// ---------------------------------------------------------------------------
// The operator side. Every one of these is scoped by op.id inside the library,
// not here, so a booking id copied from somewhere else answers "not yours".

route('GET', '/api/parts/bookings', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  return json({ bookings: await quotableItems(env, op.id) });
});

route('GET', '/api/parts/quotes', async ({ req, env, url }) => {
  const op = await requireOperator(req, env);
  return json({
    quotes: await quotesForOperator(env, op.id, {
      order_item_id: url.searchParams.get('order_item_id') ?? undefined,
    }),
  });
});

route('POST', '/api/parts/quotes', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  const quote = await sendQuote(env, op.id, {
    order_item_id: str(b.order_item_id) ?? '',
    description: str(b.description) ?? '',
    parts_cents: int(b.parts_cents) ?? 0,
    labor_cents: int(b.labor_cents) ?? 0,
  });
  return json({ quote }, 201);
});

route('DELETE', '/api/parts/quotes/:id', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  await withdrawQuote(env, op.id, params.id!);
  return json({ ok: true });
});

// The customer side, authorised by their link and nothing else.

route('GET', '/api/public/threads/:token/parts', async ({ env, params }) => {
  return json(await quotesForGuest(env, params.token!));
});

route('POST', '/api/public/threads/:token/parts/:id', async ({ req, env, params }) => {
  const b = await body(req);
  const decision = str(b.decision);
  if (decision !== 'approved' && decision !== 'declined') {
    throw badRequest('Approve it or decline it.', 'bad_decision');
  }
  return json({ quote: await decideQuote(env, params.token!, params.id!, decision) });
});

// ---------------------------------------------------------------------------
// Arrival, cancellation and lead fees
// ---------------------------------------------------------------------------

route('POST', '/api/bookings/:id/arrived', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  return json({ arrived_at: await markArrived(env, op.id, params.id!) });
});

route('POST', '/api/bookings/:id/cancel', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  return json(await cancelByOperator(env, op.id, params.id!, str(b.reason)));
});

// What they would get back, before they decide. Same function the cancel
// itself uses, so the number shown and the number refunded cannot disagree.
route('GET', '/api/public/threads/:token/refund/:id', async ({ env, params }) => {
  return json({ refund: await quoteRefund(env, params.token!, params.id!) });
});

route('POST', '/api/public/threads/:token/cancel/:id', async ({ req, env, params }) => {
  const b = await body(req);
  return json(await cancelByCustomer(env, params.token!, params.id!, str(b.reason)));
});

route('GET', '/api/fees', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  return json({
    owed: await feesOwed(env, op.id),
    fees: await listFees(env, op.id),
    blocked: await listingBlock(env, op.id),
  });
});


// ---------------------------------------------------------------------------
// Card on file
// ---------------------------------------------------------------------------
// NO CARD NUMBER EVER REACHES THIS WORKER. The processor's own form takes the
// details in the browser and hands back a reference; that reference is what
// arrives here and what a fee is charged against later. saveOperatorCard
// refuses anything shaped like a PAN rather than storing it, so a seam wired
// up wrongly fails loudly instead of quietly putting this project inside PCI
// scope.

route('GET', '/api/payment-method', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const row = await env.DB.prepare(
    `SELECT payment_brand, payment_last4, payment_added_at FROM operators WHERE id = ?`,
  ).bind(op.id).first();
  return json({ card: row?.payment_added_at ? row : null });
});

/**
 * The seam itself, now that the shape check is structural.
 *
 * The per-route scan that used to live here has moved into body() and into the
 * D1 wrapper, so a card number in ANY field of this request — or of any other
 * request, on any route — is refused before this handler runs. What is left
 * here is the positive half: `ref` has to actually be a processor reference,
 * `brand` has to be a short label, and `last4` is cut to four digits on the
 * way in rather than trusted to be four already.
 */
route('POST', '/api/payment-method', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  await saveOperatorCard(env, op.id, {
    ref: assertPaymentRef(str(b.ref) ?? ''),
    brand: safeBrand(str(b.brand)),
    last4: safeLast4(str(b.last4)),
  });
  return json({ ok: true });
});

/**
 * Stripe's webhook, verified before it is believed.
 *
 * Nothing charges anybody yet, so this handler does not act on an event; it
 * exists so the seam is already safe on the day something does. The order is
 * the whole point — configured, then signed, then parsed, then acted on — and
 * building it later, on the day money starts moving, means building it on the
 * day an unsigned endpoint is worth forging.
 *
 * 503 while STRIPE_WEBHOOK_SECRET is unset, which it is in every environment
 * today. That is a deliberate difference from Turnstile, which steps aside
 * when its secret is missing: an endpoint that will one day mark jobs paid
 * must never have a mode in which it accepts unsigned instructions. See
 * lib/payments.ts.
 */
route('POST', '/webhooks/stripe', async ({ req, env }) => {
  // The exact bytes, because that is what the signature covers. Re-serialising
  // parsed JSON reorders keys and every signature then fails for reasons that
  // look like a configuration problem.
  const raw = await req.text();

  if (!stripeWebhooksConfigured(env)) {
    throw new HttpError(
      503,
      'Payment webhooks are not configured on this deployment.',
      'stripe_unconfigured',
    );
  }
  if (!await verifyStripeSignature(req, env, raw, now())) {
    // No detail about which check failed. A forger who can tell a stale
    // timestamp from a wrong key has been handed half the answer.
    console.error('stripe webhook signature rejected');
    throw badRequest('Signature check failed.', 'bad_signature');
  }

  let event: { id?: string; type?: string } = {};
  try {
    event = JSON.parse(raw) as { id?: string; type?: string };
  } catch {
    throw badRequest('That is not a Stripe event.', 'bad_event');
  }

  // Stripe never sends a PAN, and if one ever appears in a payload it is not
  // going anywhere near this database. Checked rather than assumed, because
  // "the processor would never" is how card data ends up in a log.
  assertNoCardData(event, 'a Stripe webhook');

  // Only the type, never the payload: an event body carries names, addresses
  // and amounts, and a log line is a copy of all of it that nothing erases.
  console.log('stripe webhook', event.type ?? 'unknown');

  // 200 with nothing done. Stripe retries anything else for days, and there
  // is no handler yet for it to retry into.
  return json({ received: true });
});

// ---------------------------------------------------------------------------
// Standing: suspensions and no-shows
// ---------------------------------------------------------------------------

route('GET', '/api/standing', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  return json({
    standing: await operatorStanding(env, op.id),
    has_card: await hasOperatorCard(env, op.id),
    blocked: await listingBlock(env, op.id),
  });
});

// The operator says the customer was not there.
route('POST', '/api/bookings/:id/no-show', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  const item = await env.DB.prepare(
    `SELECT id FROM order_items WHERE id = ? AND operator_id = ?`,
  ).bind(params.id, op.id).first();
  if (!item) throw notFound('That booking is not yours.');
  return json(await reportNoShow(env, 'operator',
    { order_item_id: params.id!, against: 'customer', note: str(b.note) }), 201);
});

// The customer says the operator never came. Authorised by their link.
route('POST', '/api/public/threads/:token/no-show/:id', async ({ req, env, params }) => {
  const b = await body(req);
  const thread = await threadByToken(env, params.token ?? '');
  if (!thread) throw notFound('That link is not valid any more.');
  const mine = await env.DB.prepare(
    `SELECT oi.id FROM order_items oi
      WHERE oi.id = ? AND oi.operator_id = ?
        AND oi.order_id = (SELECT order_id FROM order_items WHERE appointment_id = ? LIMIT 1)`,
  ).bind(params.id, thread.operator_id, thread.appointment_id).first();
  if (!mine) throw notFound('That booking is not on your order.');
  return json(await reportNoShow(env, 'customer',
    { order_item_id: params.id!, against: 'operator', note: str(b.note) }), 201);
});

// Where a person decides. There is no admin UI yet, so this is the queue and
// the two verbs that act on it; nothing else in the codebase moves the ladder.
//
// requireAdmin, not requireOperator. The queue carries other people's
// customers by name and phone number, and the verb below suspends or bans the
// business the report names — neither of which is a thing one operator on this
// marketplace may do to another.
// Every use of the admin surface leaves a line in admin_actions, INCLUDING the
// reads. The queue is where the personal data actually is -- other people's
// customers, by name and number, with what each side said happened inside
// somebody's home -- so opening it is the act most likely to be misused and
// the one least likely to leave any other trace. See lib/audit.ts for why the
// log holds a hash of the number rather than the number.
route('GET', '/api/admin/no-shows', async ({ req, env }) => {
  const admin = await requireAdmin(req, env);
  const reports = await openReports(env);
  await recordAdminAction(env, admin.id, {
    action: 'read_no_show_queue', subject_kind: 'queue',
    detail: `rows_${reports.length}`,
  });
  return json({ reports }, 200, { 'cache-control': 'no-store' });
});

route('POST', '/api/admin/no-shows/:id', async ({ req, env, params }) => {
  const admin = await requireAdmin(req, env);
  const b = await body(req);
  const decision = str(b.decision);
  if (decision === 'confirmed') {
    const applied = await confirmNoShow(env, params.id!, str(b.note));
    await recordAdminAction(env, admin.id, {
      action: 'confirm_no_show', subject_kind: 'report', subject_ref: params.id!,
      // Structural, never the admin's prose about a person: the note itself
      // lives on the report, where an erasure can reach it.
      detail: `strike_${(applied as { strike_number?: number } | null)?.strike_number ?? '?'}`,
    });
    return json({ applied });
  }
  if (decision === 'rejected') {
    await rejectNoShow(env, params.id!, str(b.note));
    await recordAdminAction(env, admin.id, {
      action: 'reject_no_show', subject_kind: 'report', subject_ref: params.id!,
    });
    return json({ ok: true });
  }
  throw badRequest('Uphold it or throw it out.', 'bad_decision');
});

/**
 * What the admin surface has been used for.
 *
 * Reading the log is itself an admin action and is logged like any other:
 * without that, the one query nobody can see is the one that finds out how
 * closely anybody is watching.
 */
route('GET', '/api/admin/audit', async ({ req, env, url }) => {
  const admin = await requireAdmin(req, env);
  const limit = Number(url.searchParams.get('limit') ?? 100);
  const actions = await listAdminActions(env, Number.isFinite(limit) ? limit : 100);
  await recordAdminAction(env, admin.id, {
    action: 'read_flags', subject_kind: 'queue', detail: 'audit',
  });
  return json({ actions }, 200, { 'cache-control': 'no-store' });
});

route('GET', '/api/public/standing', async ({ req, env, url }) => {
  // Used by the checkout so a suspended number finds out before typing an
  // address, not after. Answers only about the number that was asked about.
  //
  // Which is exactly why it needs a ceiling it did not have: anonymous, and it
  // answers a yes/no question about any phone number anybody cares to type. A
  // walk over a list of numbers turns it into "has this person been reported
  // for missing appointments", which is a fact about them and not about us.
  // The checkout asks once, when the number field loses focus.
  await enforceRateLimit(env, `standing:${clientIp(req)}`, 30, 300);
  const phone = url.searchParams.get('phone') ?? '';
  const e164 = toE164(phone, 'US');
  if (!e164) return json({ blocked: false, message: null });
  const standing = await customerStanding(env, e164);
  return json({ blocked: standing.blocked, message: standing.message });
});


// ---------------------------------------------------------------------------
// Proof of the job
// ---------------------------------------------------------------------------
// Both sides upload, because both sides have something to lose: the operator
// against "they never came" on a job they did, the customer against "the work
// was done" on a job nobody turned up to. Every read is authorised -- these
// are photographs of people's homes and there is no public URL for one.

route('GET', '/api/bookings/:id/proof', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  return json(await proofSummary(env, { operator_id: op.id }, params.id!));
});

route('POST', '/api/bookings/:id/proof', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  // Before, during and after, on every job of a full day, with retries for the
  // ones that came out blurred. That is what the ceiling has to clear, so it
  // is set at roughly ten jobs an hour's worth and no tighter.
  await enforceRateLimit(env, `photo-proof:${op.id}`, 120, 3600);
  assertBodyWithin(req, MAX_PROOF_BYTES);
  const form = await req.formData();
  const stage = form.get('stage');
  if (!isStage(stage)) throw badRequest('Say whether this is before, during or after.');
  const photo = await addJobPhoto(env, { operator_id: op.id }, {
    order_item_id: params.id!, stage, file: form.get('file') as File,
    caption: str(form.get('caption')),
    width: int(form.get('width')), height: int(form.get('height')),
  });
  return json({ photo }, 201);
});

route('GET', '/api/public/threads/:token/proof/:id', async ({ env, params }) => {
  return json(await proofSummary(env, { token: params.token! }, params.id!));
});

route('POST', '/api/public/threads/:token/proof/:id', async ({ req, env, params }) => {
  // The customer's own photos of the work, from a phone, on their link. Forty
  // an hour is well past documenting one job and stops a leaked link being
  // used to fill a bucket somebody else pays for.
  await enforceRateLimit(env, `photo-guest:${params.token!}`, 40, 3600);
  assertBodyWithin(req, MAX_PROOF_BYTES);
  const form = await req.formData();
  const stage = form.get('stage');
  if (!isStage(stage)) throw badRequest('Say whether this is before, during or after.');
  const photo = await addJobPhoto(env, { token: params.token! }, {
    order_item_id: params.id!, stage, file: form.get('file') as File,
    caption: str(form.get('caption')),
    width: int(form.get('width')), height: int(form.get('height')),
  });
  return json({ photo }, 201);
});

route('GET', '/api/proof/:id', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  return readJobPhoto(env, { operator_id: op.id }, params.id!);
});

route('GET', '/api/public/threads/:token/photo/:id', async ({ env, params }) => {
  return readJobPhoto(env, { token: params.token! }, params.id!);
});

route('DELETE', '/api/proof/:id', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  await deleteJobPhoto(env, { operator_id: op.id }, params.id!);
  return json({ ok: true });
});

route('DELETE', '/api/public/threads/:token/photo/:id', async ({ env, params }) => {
  await deleteJobPhoto(env, { token: params.token! }, params.id!);
  return json({ ok: true });
});

// ---------------------------------------------------------------------------
// Two-sided arrival, and settling what was frozen
// ---------------------------------------------------------------------------

route('POST', '/api/public/threads/:token/arrived/:id', async ({ env, params }) => {
  // The customer's half of arrival. Never required to start the job -- a phone
  // left indoors must not be able to strand an appointment -- but it is what
  // turns one person's claim that they were there into a fact.
  return json(await confirmArrival(env, params.token!, params.id!));
});

route('GET', '/api/public/threads/:token/pending', async ({ env, params }) => {
  // The one question, if there is one waiting: did they do the work anyway?
  return json({ question: await pendingQuestion(env, params.token!) });
});

route('POST', '/api/public/threads/:token/answer/:id', async ({ req, env, params }) => {
  const b = await body(req);
  const answer = str(b.answer);
  if (answer !== 'done' && answer !== 'not_done') {
    throw badRequest('Tell us whether the work happened.', 'bad_answer');
  }
  return json(await answerWork(env, params.token!, params.id!, answer));
});

route('GET', '/api/flags', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  return json({ summary: await flagSummary(env, op.id) });
});

// Every business on the site ranked by how many bypass flags it has collected,
// and beside it every booking where a customer said the van was not the one on
// the account. GET /api/flags above is the operator's own, and is what an
// operator gets.
//
// The vehicle reports travel here rather than in the ranking because they are
// not bypass evidence and must not be counted as any: a hire van is the
// ordinary explanation, and the point of showing them is that a person reads
// what the customer wrote. See vehicleReports in lib/startcode.ts.
route('GET', '/api/admin/flags', async ({ req, env }) => {
  const admin = await requireAdmin(req, env);
  const operators = await flaggedOperators(env);
  const vehicles = await vehicleReports(env);
  await recordAdminAction(env, admin.id, {
    action: 'read_flags', subject_kind: 'queue',
    detail: `rows_${operators.length}_vehicles_${vehicles.length}`,
  });
  return json({ operators, vehicle_reports: vehicles },
    200, { 'cache-control': 'no-store' });
});


// ---------------------------------------------------------------------------
// The start code, and the van
// ---------------------------------------------------------------------------
// The code is the one moment the platform KNOWS these two people met, rather
// than inferring it. Typing it requires standing next to the person holding
// it, which is what makes cancelling afterwards so hard to explain.

route('GET', '/api/vehicle', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  return json({ vehicle: await getVehicle(env, op.id) });
});

route('PUT', '/api/vehicle', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  return json({
    vehicle: await saveVehicle(env, op.id, {
      make: str(b.make), model: str(b.model),
      color: str(b.color), plate: str(b.plate),
    }),
  });
});

route('POST', '/api/bookings/:id/code', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  return json(await verifyStartCode(env, op.id, params.id!, str(b.code) ?? ''));
});

route('GET', '/api/public/threads/:token/code', async ({ env, params }) => {
  // The customer's copy, plus the van to look for. Withheld once used.
  return json({ job: await jobCodeForGuest(env, params.token!) });
});

route('POST', '/api/public/threads/:token/vehicle/:id', async ({ req, env, params }) => {
  const b = await body(req);
  await reportVehicle(env, params.token!, params.id!, str(b.note));
  return json({ ok: true });
});


// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------
// Only a finished booking can leave one, and one booking leaves at most one.
// That is what makes the number worth reading; see reviews.ts.

route('GET', '/api/public/reviews/:operatorId', async ({ req, env, params, url }) => {
  // Unauthenticated, and it reads and sorts the whole review table for one
  // business on every call. The profile page it feeds asks once when it opens.
  await enforceRateLimit(env, `reviews:${clientIp(req)}`, 120, 60);
  const reviews = await listReviews(env, params.operatorId!, {
    sort: url.searchParams.get('sort') ?? undefined,
  });
  return json({
    rating: await ratingFor(env, params.operatorId!),
    // Through the same helper the profile page uses. author_name is stored
    // whole so a correction stays possible, and every other public path cuts
    // it to "Debra H." on the way out — this one did not, and published the
    // full name of every customer who has had somebody in their home next to
    // the business that went there. See displayName in reviews.ts.
    reviews: reviews.map((r) => ({ ...r, author_name: displayName(r.author_name) })),
  }, 200, { 'cache-control': 'public, max-age=120' });
});

route('GET', '/api/public/threads/:token/reviewable', async ({ env, params }) => {
  return json({ bookings: await reviewableFor(env, params.token!) });
});

route('POST', '/api/public/threads/:token/review', async ({ req, env, params }) => {
  // A review is public and permanent, and the rules about who may leave one
  // live in leaveReview. This is only the volume ceiling: ten an hour is more
  // than a customer with several jobs on one link will ever write.
  await enforceRateLimit(env, `review:${params.token!}`, 10, 3600);
  const b = await body(req);
  return json({
    review: await leaveReview(env, params.token!, {
      order_item_id: str(b.order_item_id) ?? '',
      rating: int(b.rating) ?? 0,
      body: str(b.body),
    }),
  }, 201);
});

// A released review photo, served to anybody. The only ones reachable here
// are the ones a customer explicitly published on their own review.
route('GET', '/api/public/review-photo/:id', async ({ env, params }) => {
  if (!env.PHOTOS) throw notFound('No such photo.');
  const photo = await env.DB.prepare(
    `SELECT r2_key, content_type FROM job_photos
      WHERE id = ? AND public_on_review = 1`,
  ).bind(params.id).first<{ r2_key: string; content_type: string | null }>();
  if (!photo) throw notFound('No such photo.');

  const object = await env.PHOTOS.get(photo.r2_key);
  if (!object) throw notFound('No such photo.');
  return new Response(object.body, {
    headers: {
      'content-type': photo.content_type ?? 'image/jpeg',
      'cache-control': 'public, max-age=86400',
    },
  });
});

route('POST', '/api/public/threads/:token/review-photo/:id', async ({ req, env, params }) => {
  const b = await body(req);
  await releasePhoto(env, params.token!, params.id!, b.public !== false);
  return json({ ok: true });
});

route('POST', '/api/reviews/:id/reply', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  await replyToReview(env, op.id, params.id!, str(b.text) ?? '');
  return json({ ok: true });
});

// The questions everybody asks, answered in the operator's own words. Some of
// the most useful text on the reference profile.
route('GET', '/api/faqs', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  return json({ faqs: await listFaqs(env, op.id) });
});

route('PUT', '/api/faqs', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  return json(await saveFaq(env, op.id, {
    id: str(b.id), question: str(b.question) ?? '', answer: str(b.answer) ?? '',
    position: int(b.position) ?? 0,
  }));
});

route('DELETE', '/api/faqs/:id', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  await deleteFaq(env, op.id, params.id!);
  return json({ ok: true });
});


// ---------------------------------------------------------------------------
// Open for work right now
// ---------------------------------------------------------------------------
// The switch. Three hours, then it turns itself off; accepting a job turns it
// off; a job must be accepted within five minutes or it goes to somebody else.
// Online is always computed as online_until > now, never stored as a flag --
// see online.ts for why that matters.

route('GET', '/api/online', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  return json(await onlineStatus(env, op.id));
});

route('POST', '/api/online', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  return json(await goOnline(env, op.id, { radius_meters: int(b.radius_meters) ?? undefined }));
});

route('DELETE', '/api/online', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  return json(await goOffline(env, op.id));
});

/**
 * An instant request is a platform-introduced customer, so the same rule
 * applies to it as to every other one: the operator gets the address, because
 * they have to drive there, and never the number or the mailbox.
 *
 * instant_requests stores both — the checkout needs them, and the customer's
 * own polling page reads its own row back through their link — and the two
 * routes below were handing the whole row to the operator. Nothing in the app
 * ever displayed them (web/src/components/OnlineSwitch.tsx does not carry the
 * fields), so this is only closing the leak. See redact.ts for why holding a
 * number once is holding it forever.
 */
const maskRequest = <T extends { phone_e164?: unknown; email?: unknown }>(r: T): T => ({
  ...r,
  phone_e164: maskPhone(r.phone_e164 as string | null),
  email: maskEmail(r.email as string | null),
});

route('GET', '/api/online/requests', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  return json({ requests: (await pendingForOperator(env, op.id)).map(maskRequest) });
});

route('POST', '/api/online/requests/:id/accept', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  return json(maskRequest(await acceptRequest(env, op.id, params.id!)));
});

route('POST', '/api/online/requests/:id/decline', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  await declineRequest(env, op.id, params.id!);
  return json({ ok: true });
});

// Who is switched on near this address right now. The customer's side of the
// whole feature: not "who has a gap on Thursday" but "who is working now".
route('GET', '/api/public/online', async ({ req, env, url }) => {
  // Never cached (it is "right now") and it takes arbitrary coordinates, so it
  // is the cheapest way to enumerate who is working across a whole city. Sixty
  // a minute is generous for a page that asks once when it opens.
  await enforceRateLimit(env, `online-near:${clientIp(req)}`, 60, 60);
  const lat = Number(url.searchParams.get('lat'));
  const lng = Number(url.searchParams.get('lng'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw badRequest('We need a location to find anyone.', 'no_location');
  }
  return json({
    operators: await operatorsOnlineNear(env, {
      lat, lng, trade: url.searchParams.get('trade') ?? undefined,
    }),
  }, 200, { 'cache-control': 'no-store' });
});

route('POST', '/api/public/online/requests', async ({ req, env }) => {
  const b = await body(req);
  // This rings a working operator's phone and starts a five-minute fuse, and
  // it geocodes an address on the way. Six in a quarter hour covers a customer
  // who tries two or three vans and gets no answer; forty is somebody using
  // the product as a paging system against a business they dislike. The second
  // bucket is that business: whoever is aiming at them, it is their phone.
  await enforceRateLimit(env, `instant-ip:${clientIp(req)}`, 6, 900);
  if (str(b.operator_id)) {
    await enforceRateLimit(env, `instant-op:${str(b.operator_id)}`, 20, 900);
  }
  // Before the fuse is lit. This one rings a working operator's phone, so the
  // cost of a scripted request is paid by a person mid-job — and it geocodes
  // an address against somebody else's quota on the way.
  await requireTurnstile(env, req, tokenFromBody(b));
  const made = await createInstantRequest(env, {
    operator_id: str(b.operator_id) ?? '',
    service_id: str(b.service_id),
    guest_name: str(b.guest_name) ?? '',
    phone: str(b.phone) ?? '',
    email: str(b.email),
    address_line: str(b.address_line),
    postcode: str(b.postcode),
    note: str(b.note),
    duration_seconds: int(b.duration_seconds) ?? undefined,
    price_cents: int(b.price_cents) ?? undefined,
  } as never);
  return json(made, 201);
});

// Polled by the customer while the fuse burns. Expiry is decided on read, so
// this is correct even if the sweep has not run.
route('GET', '/api/public/online/requests/:token', async ({ req, env, params }) => {
  // The answer is a name, a phone number, a street address and coordinates.
  // The page holding the link polls it while the five-minute fuse burns, which
  // is why the ceiling is set where it is rather than tight.
  await guardTokenGuessing(env, req, 'instant');
  const found = await requestByToken(env, params.token!);
  if (!found) throw notFound('That request is not valid any more.');
  return json({ request: found });
});

route('DELETE', '/api/public/online/requests/:token', async ({ req, env, params }) => {
  await guardTokenGuessing(env, req, 'instant');
  await cancelRequest(env, params.token!);
  return json({ ok: true });
});

// ---------------------------------------------------------------------------
// Estimates, asked for in the chat
// ---------------------------------------------------------------------------
// Somebody wants a job that is not on the price list, or wants it next
// Thursday. They ask in the conversation they already have; the business
// answers with a price and a time; accepting makes it an ordinary booking.

route('POST', '/api/public/threads/:token/estimates', async ({ req, env, params }) => {
  // Each of these is a job of work for the business at the other end. Twenty
  // an hour is far past asking about a second vehicle or a rewritten
  // description, and stops one link generating a day's admin in a minute.
  await enforceRateLimit(env, `estimate-ask:${params.token!}`, 20, 3600);
  const b = await body(req);
  return json({ estimate: await askForEstimate(env, params.token!, str(b.request) ?? '') }, 201);
});

route('GET', '/api/public/threads/:token/estimates', async ({ env, params }) => {
  return json({ estimates: await estimatesForGuest(env, params.token!) });
});

route('POST', '/api/public/threads/:token/estimates/:id', async ({ req, env, params }) => {
  // Accepting turns into a booking; declining is cheap. Thirty an hour on the
  // link covers a customer changing their mind about several quotes.
  await enforceRateLimit(env, `estimate-decide:${params.token!}`, 30, 3600);
  const b = await body(req);
  const decision = str(b.decision);
  if (decision !== 'accepted' && decision !== 'declined') {
    throw badRequest('Accept it or decline it.', 'bad_decision');
  }
  return json({ estimate: await decideEstimate(env, params.token!, params.id!, decision) });
});

route('GET', '/api/estimates', async ({ req, env, url }) => {
  const op = await requireOperator(req, env);
  return json({
    estimates: await estimatesForOperator(env, op.id, {
      status: url.searchParams.get('status') ?? undefined,
    } as never),
  });
});

route('POST', '/api/estimates/:id/quote', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  return json({
    estimate: await quoteEstimate(env, op.id, params.id!, {
      description: str(b.description) ?? '',
      price_cents: int(b.price_cents) ?? 0,
      duration_seconds: int(b.duration_seconds) ?? 0,
      starts_at: int(b.starts_at) ?? 0,
    }),
  });
});

route('DELETE', '/api/estimates/:id', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  await withdrawEstimate(env, op.id, params.id!);
  return json({ ok: true });
});

// ---------------------------------------------------------------------------
// Checkout. A customer may take several services, across several businesses
// and several dates, in one basket.
//
// "and pay for the lot once" is what this will be. Nothing here takes money —
// placeOrder writes the order as 'pending' and says so — so the two routes
// below price the basket and hold the appointments. See lib/payments.ts.
// ---------------------------------------------------------------------------
route('POST', '/api/public/orders/price', async ({ req, env }) => {
  const b = await body(req);
  const items = Array.isArray(b.items) ? b.items : [];
  // Read-only, so it is safe to call on every checkbox — and because the page
  // does exactly that, the ceiling has to sit above human tapping speed rather
  // than near it. Two a second, per address, writes nothing.
  await enforceRateLimit(env, `price:${clientIp(req)}`, 120, 60);
  return json(await priceOrder(env, items as any), 200, { 'cache-control': 'no-store' });
});

route('POST', '/api/public/orders', async ({ req, env }) => {
  const b = await body(req);
  // A real booking. It writes appointments, opens a conversation, may send
  // mail and geocodes the address against somebody else's quota. Ten an hour
  // per address is more than a household or a small office ever books and
  // makes bulk slot-squatting pointless.
  await enforceRateLimit(env, `order:${clientIp(req)}`, 10, 3600);
  // Ahead of placeOrder, which is where the appointment rows, the conversation
  // and the mail all happen. This is the endpoint the whole Turnstile change
  // exists for: a booking a script placed and then cancelled walks the refund
  // ladder at the operator's expense, and enough of them walk the business
  // into the suspension ladder. Nothing above this line has written anything.
  await requireTurnstile(env, req, tokenFromBody(b));
  const placed = await placeOrder(env, {
    items: Array.isArray(b.items) ? b.items as any : [],
    guest_name: String(b.guest_name ?? ''),
    phone: String(b.phone ?? ''),
    email: str(b.email) ?? undefined,
    address_line: str(b.address_line) ?? undefined,
    postcode: str(b.postcode) ?? undefined,
    thread_token: str(b.thread_token) ?? undefined,
  });
  const base = env.APP_URL.replace(/\/$/, '');
  return json({ ...placed, link: `${base}/c/${placed.thread_token}` }, 201);
});

// ---------------------------------------------------------------------------
// Openings alerts, and where the van is.
// ---------------------------------------------------------------------------

/** Null means push is not configured, and the front end hides the whole panel. */
route('GET', '/api/public/vapid-key', async ({ env }) => {
  return json({ key: vapidPublicKey(env) }, 200, { 'cache-control': 'public, max-age=3600' });
});

/** Every trade with a business actually listed, so a filter can never be empty. */
route('GET', '/api/trade-catalog', async () => {
  // The whole catalogue, grouped, for the sign-up picker. Served rather than
  // duplicated in the browser so the two can never drift -- which is exactly
  // how a trade ended up pickable at sign-up and invisible to customers.
  return json({ categories: TRADE_CATEGORIES },
    200, { 'cache-control': 'public, max-age=3600' });
});

route('GET', '/api/public/trade-catalog', async ({ env }) => {
  // The same catalogue, cut down to trades somebody is actually working in.
  // A category where nothing is bookable is a dead end, and a browse page made
  // of dead ends does not look like a marketplace.
  const rows = await env.DB.prepare(
    `SELECT DISTINCT o.trade FROM operators o
       JOIN service_areas a ON a.operator_id = o.id AND a.is_active = 1
      WHERE o.trade IS NOT NULL AND o.trade <> ''
        AND o.accept_public_bookings = 1 AND o.plan IN ('trial','active')`,
  ).all<{ trade: string }>();
  return json({ categories: catalogFor((rows.results ?? []).map((r) => r.trade)) },
    200, { 'cache-control': 'public, max-age=300' });
});

/**
 * The places Slotfill serves, so the front end renders a metro list and a
 * metro page from data rather than from a name compiled into the bundle.
 *
 * Static: the record in lib/metros.ts and nothing counted. What is OPEN in a
 * metro belongs to /api/public/map, which counts it in the request that asks,
 * and answering it here as well would be two numbers for one question that can
 * disagree. Every area in the payload carries its slug, which is the same key
 * `areas[].slug` in the map payload uses, so the browser groups one against
 * the other without a second round trip.
 *
 * Unauthenticated, identical for everybody, and it changes when the code
 * changes — so it caches like the country list beside it and is not rate
 * limited.
 */
route('GET', '/api/public/metros', async () => json(
  { metros: METROS.map(publicMetro) }, 200, { 'cache-control': 'public, max-age=3600' },
));

route('GET', '/api/public/trades', async ({ env }) => {
  const rows = await env.DB.prepare(
    `SELECT DISTINCT o.trade FROM operators o
       JOIN service_areas a ON a.operator_id = o.id AND a.is_active = 1
      WHERE o.trade IS NOT NULL AND o.trade <> ''
        AND o.accept_public_bookings = 1 AND o.plan IN ('trial','active')
      ORDER BY o.trade`,
  ).all<{ trade: string }>();
  return json({ trades: (rows.results ?? []).map((r) => r.trade) },
    200, { 'cache-control': 'public, max-age=300' });
});

/**
 * Recent reviews from every business doing one kind of work.
 *
 * The reference marketplace's service page carries this strip; ours had the
 * rows and no way to read them except one business at a time, so a visitor who
 * had not already chosen a business could not see that anybody had ever been
 * reviewed at all.
 *
 * Same rules as the profile route, and they are the point of it: real rows
 * only, the customer's name cut to a first name and an initial, and a trade
 * nobody has reviewed answers with an empty list rather than anything invented.
 */
route('GET', '/api/public/trades/:slug/reviews', async ({ req, env, params, url }) => {
  // Unauthenticated, and it reads across the whole review table. The same
  // ceiling the per-business route carries, for the same reason: the page it
  // feeds asks once when it opens.
  await enforceRateLimit(env, `trade-reviews:${clientIp(req)}`, 120, 60);

  // The path segment is the catalogue's own slug — the one /s/:trade uses —
  // and it is resolved against the catalogue rather than passed to the query,
  // so an unknown trade is a 404 and not an empty list that reads like a trade
  // nobody has ever reviewed.
  const entry = tradeFromPathSegment(params.slug ?? '');
  if (!entry) throw notFound('We do not have that trade.');

  const limit = int(url.searchParams.get('limit')) ?? undefined;
  const reviews = await reviewsForTrade(env, entry.slug, limit);

  return json({
    trade: { slug: entry.slug, label: entry.label },
    reviews,
  }, 200, { 'cache-control': 'public, max-age=300' });
});

/**
 * Other businesses doing the same work on the same patch.
 *
 * The profile page's own payload already carries three of these; this is the
 * "see all" behind them, so a visitor who has decided against one business is
 * not sent back to a search to find the next. The business whose page it is is
 * excluded by the query, not by the caller.
 */
route('GET', '/api/public/profile/:slug/similar', async ({ req, env, params, url }) => {
  await enforceRateLimit(env, `similar:${clientIp(req)}`, 120, 60);
  const businesses = await similarBusinesses(env, params.slug ?? '',
    int(url.searchParams.get('limit')) ?? 12);
  return json({ businesses }, 200, { 'cache-control': 'public, max-age=300' });
});

route('POST', '/api/public/watches', async ({ req, env }) => {
  const b = await body(req);
  // A watch is a standing instruction to email somebody, so the address is a
  // bucket in its own right: without it, anyone can point this at a stranger's
  // mailbox and have us do the sending. Ten an hour per host still lets a
  // person set alerts for home, work and a parent's house.
  await enforceRateLimit(env, `watch-ip:${clientIp(req)}`, 10, 3600);
  const watchEmail = str(b.email)?.toLowerCase();
  if (watchEmail) await enforceRateLimit(env, `watch-email:${watchEmail}`, 5, 3600);
  // A watch is not one email, it is a standing instruction to keep sending
  // them to an address the sender never had to prove they own. That is a
  // mail-bombing primitive, and the per-address bucket above only slows the
  // setting-up of it. PATCH and DELETE on the same watch are deliberately not
  // challenged: those need the token, which means holding the link this
  // response is the only place to get it.
  await requireTurnstile(env, req, tokenFromBody(b));
  const { watch, token } = await createWatch(env, {
    postcode: String(b.postcode ?? ''),
    email: str(b.email),
    trades: Array.isArray(b.trades) ? b.trades.map(String) : null,
    max_detour_seconds: b.max_detour_seconds == null ? undefined : int(b.max_detour_seconds),
    max_price_cents: b.max_price_cents == null ? null : int(b.max_price_cents),
    label: str(b.label),
  });
  // The only response that may ever carry the raw token.
  return json({ watch, token, link: `${env.APP_URL.replace(/\/$/, '')}/a/${token}` }, 201);
});

/**
 * The ceiling on presenting a secret link that turns out to be wrong.
 *
 * Bucketed on the address and NOT on the token, which is the whole point and
 * is the same reasoning guestlink.ts sets out at length: every guess carries a
 * different token, so a per-token bucket opens a fresh allowance for each one
 * and no ceiling is ever reached. The address is the only thing a walk through
 * the token space has in common with itself.
 *
 * The first pass put a ceiling on the session issuer and a failure lockout on
 * /c/:token, and left the two token spaces beside them untouched — an alert
 * link, which answers with the postcode and the mailbox somebody asked to be
 * emailed at, and an instant request, which answers with a stranger's name,
 * phone number, street address and coordinates. Both are 32 random bytes, so
 * this is not what makes guessing hopeless; it is what makes an unbounded
 * attempt at it visible and stoppable, and what bounds the damage if a shorter
 * token is ever introduced by accident.
 *
 * Every route in both spaces goes through this, PATCH on a watch included. That
 * one already carried a per-token ceiling of its own for the geocode behind it,
 * and a per-token ceiling is exactly the shape that cannot see a walk: it is
 * the address, here, that the walk has in common with itself.
 *
 * Two hundred an hour, which is loose on purpose. A real holder of one of
 * these links opens it, reloads it, and edits their filters a few times; the
 * number is set well above that because the person a tight limit catches is
 * the customer whose link it is, and a whole street behind one CGNAT address
 * is one row here.
 */
const guardTokenGuessing = (env: Env, req: Request, space: string) =>
  enforceRateLimit(env, `link:${space}:${clientIp(req)}`, 200, 3600);

/**
 * One-click unsubscribe, straight from an email.
 *
 * A GET on a link in an email, so it must work with no session, no
 * JavaScript and no form. Answers the same way whether or not the token
 * matched: a stranger poking at it learns nothing, and the person who
 * clicked it gets the outcome they wanted either way.
 */
route('GET', '/a/stop/:token', async ({ req, env, params }) => {
  await guardTokenGuessing(env, req, 'watch');
  await unsubscribeByToken(env, params.token ?? '');
  return html(page('Alerts stopped', `<p class="big">✅</p>
    <h1>Alerts stopped</h1>
    <p class="meta">You will not get any more emails about openings near you.</p>
    <a href="/" class="note">See what is open</a>`));
});

route('GET', '/api/public/watches/:token', async ({ req, env, params }) => {
  // The answer carries the postcode and the mailbox behind this alert.
  await guardTokenGuessing(env, req, 'watch');
  const watch = await watchByToken(env, params.token ?? '');
  if (!watch) throw notFound('That alert link is not valid any more.');
  return json({ watch }, 200, { 'cache-control': 'no-store' });
});

route('PATCH', '/api/public/watches/:token', async ({ req, env, params }) => {
  // Answers differently for a token that exists, exactly as the GET beside it
  // does, so it is walkable in the same way and gets the same address-bucketed
  // ceiling.
  await guardTokenGuessing(env, req, 'watch');
  // And its own, on the token: editing the alert re-places its postcode, so it
  // is a write with a geocode behind it rather than a settings toggle. Sixty an
  // hour is a person fiddling with the filters for as long as anyone ever does.
  await enforceRateLimit(env, `watch-edit:${params.token ?? ''}`, 60, 3600);
  const b = await body(req);
  const patch: Record<string, unknown> = {};
  if ('postcode' in b) patch.postcode = String(b.postcode ?? '');
  if ('trades' in b) patch.trades = Array.isArray(b.trades) ? b.trades.map(String) : null;
  if ('max_detour_seconds' in b) patch.max_detour_seconds = int(b.max_detour_seconds);
  if ('max_price_cents' in b) patch.max_price_cents = b.max_price_cents == null ? null : int(b.max_price_cents);
  if ('label' in b) patch.label = str(b.label);
  // str() gives null for an empty string, which is exactly "clear it".
  if ('email' in b) patch.email = str(b.email);
  if ('active' in b) patch.active = Boolean(b.active);
  return json({ watch: await updateWatch(env, params.token ?? '', patch) });
});

route('DELETE', '/api/public/watches/:token', async ({ req, env, params }) => {
  await guardTokenGuessing(env, req, 'watch');
  await deactivateWatch(env, params.token ?? '');
  return json({ ok: true });
});

/**
 * The push services a browser can actually hand us a subscription for.
 *
 * The endpoint stored here is a URL the cron later POSTs to, with a VAPID JWT
 * signed by this deployment in the Authorization header. It arrives from the
 * public, and until now anything beginning `https://` was accepted and stored,
 * so a caller with a throwaway watch token could point it at an address of
 * their choosing and make the Worker fetch it on a schedule — and read our
 * signed header when it landed.
 *
 * A real subscription endpoint is minted by the browser's own push service, so
 * the honest check is against the list of those. Suffix-matched on a dotted
 * boundary rather than with `includes`, because `push.services.mozilla.com`
 * inside a hostname an attacker owns is not Mozilla.
 */
const PUSH_HOSTS = [
  'fcm.googleapis.com',           // Chrome, Edge, and everything Chromium
  'push.services.mozilla.com',    // Firefox
  'notify.windows.com',           // Edge legacy / WNS
  'push.apple.com',               // Safari, iOS
];

const isPushEndpoint = (raw: string): boolean => {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
};

route('POST', '/api/public/watches/:token/subscriptions', async ({ req, env, params }) => {
  // One row per browser that agreed to notifications. A handful is normal —
  // phone, laptop, a reinstall — and twenty an hour is none of those.
  await enforceRateLimit(env, `watch-sub:${params.token ?? ''}`, 20, 3600);
  const b = await body(req);
  if (!isPushEndpoint(String((b as { endpoint?: unknown }).endpoint ?? ''))) {
    throw badRequest('That is not a valid push subscription.', 'bad_subscription');
  }
  await addSubscription(env, params.token ?? '', b as any);
  return json({ ok: true }, 201);
});

route('DELETE', '/api/public/watches/:token/subscriptions', async ({ req, env, params }) => {
  const b = await body(req);
  await removeSubscription(env, params.token ?? '', String(b.endpoint ?? ''));
  return json({ ok: true });
});

/**
 * The highest-write endpoint in the product.
 *
 * recordPosition drops anything arriving faster than its own floor, so a
 * misbehaving client costs one indexed read rather than a write.
 */
route('POST', '/api/track/ping', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  // watchPosition fires about once a second at its fastest, so this ceiling is
  // four times what a van driving all day produces. It is deliberately far
  // above normal: the endpoint already drops pings below its own floor, and a
  // tracking limit that fires mid-journey makes a customer watch a van that
  // has stopped moving for no reason they can see.
  await enforceRateLimit(env, `ping:${op.id}`, 240, 60);
  const b = await body(req);
  const res = await recordPosition(env, op.id, {
    lat: Number(b.lat), lng: Number(b.lng),
    accuracy_meters: b.accuracy_meters == null ? null : Number(b.accuracy_meters),
    heading: b.heading == null ? null : Number(b.heading),
    speed_mps: b.speed_mps == null ? null : Number(b.speed_mps),
    recorded_at: b.recorded_at == null ? null : int(b.recorded_at),
  });
  return json(res, 200, { 'cache-control': 'no-store' });
});

route('GET', '/api/track/me', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  return json(await operatorPosition(env, op.id), 200, { 'cache-control': 'no-store' });
});

route('POST', '/api/track/share', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  const on = Boolean(b.share_location);
  // Only ever from the operator's own explicit action. Never a signup default.
  await setShareLocation(env, op.id, on);
  // Switching it off means stop holding where I am, and until now it only meant
  // stop showing it: the flag hid the van from every customer view while the
  // last fix and the trail of where this person drove stayed on the Durable
  // Object, indefinitely, because nothing in the product had ever called
  // clear(). The flag is checked first on every read, so this is not what makes
  // the view go dark -- it is what makes the data actually go. See forgetVan.
  if (!on) await forgetVan(env, op.id);
  return json({ ok: true });
});

route('GET', '/api/public/threads/:token/track', async ({ env, params }) => {
  return json(await customerView(env, params.token ?? ''), 200, { 'cache-control': 'no-store' });
});

route('GET', '/api/notifications', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const unreadOnly = new URL(req.url).searchParams.get('unread') === '1';
  const [notifications, unread] = await Promise.all([
    listNotifications(env, op.id, { unreadOnly }),
    unreadCount(env, op.id),
  ]);
  return json({ notifications, unread });
});

route('POST', '/api/notifications/read', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  const ids = Array.isArray(b.ids) ? b.ids.map(String) : null;
  // No ids means "mark everything read" — that is what the button sends.
  if (ids) await markRead(env, op.id, ids); else await markAllRead(env, op.id);
  return json({ ok: true });
});

/**
 * What a business will actually do in one opening.
 *
 * The map only ever carries a single headline service per opening — the
 * dearest one that fits — so a customer choosing several had nothing to choose
 * from. Without this the booking page had to guess by reading back whatever
 * services the map happened to have surfaced elsewhere, which silently hides
 * anything that never headlines.
 */
route('GET', '/api/public/gaps/:gapId/services', async ({ req, env, params }) => {
  // The booking page's own read, so the ceiling is set for someone opening
  // several openings in tabs rather than for the one page in front of them.
  await enforceRateLimit(env, `gap-services:${clientIp(req)}`, 120, 60);
  const gap = await env.DB.prepare(
    `SELECT g.id, g.starts_at, g.ends_at, g.is_mobile, g.operator_id,
            o.business_name, o.trade, o.profile_slug, o.currency, o.country,
            o.language, o.timezone, o.discount_percent
       FROM gaps g JOIN operators o ON o.id = g.operator_id
      WHERE g.id = ? AND g.status IN ('open','offering')
        AND o.accept_public_bookings = 1 AND o.plan IN ('trial','active')
        AND NOT EXISTS (SELECT 1 FROM public_claims c
                         WHERE c.gap_id = g.id AND c.status = 'confirmed')`,
  ).bind(params.gapId).first<any>();
  if (!gap) throw notFound('That opening is no longer available.');

  const window = gap.ends_at - gap.starts_at;
  const rows = await env.DB.prepare(
    `SELECT s.id, s.name, s.duration_seconds, s.price_cents,
            s.parts_policy, s.parts_note,
            s.parts_estimate_low_cents, s.parts_estimate_high_cents
       FROM services s
      WHERE s.operator_id = ? AND s.is_active = 1 AND s.gap_fill_eligible = 1
        AND s.duration_seconds <= ?
        AND (NOT EXISTS (SELECT 1 FROM gap_services gs WHERE gs.gap_id = ?)
             OR EXISTS (SELECT 1 FROM gap_services gs
                         WHERE gs.gap_id = ? AND gs.service_id = s.id))
      ORDER BY s.price_cents DESC`,
  ).bind(gap.operator_id, window, params.gapId, params.gapId)
    .all<{
      id: string; name: string; duration_seconds: number; price_cents: number;
      parts_policy: 'none' | 'included' | 'quoted'; parts_note: string | null;
      parts_estimate_low_cents: number | null; parts_estimate_high_cents: number | null;
    }>();

  const locale = localeFor(gap.country, gap.language);
  const services = (rows.results ?? []).map((r) => {
    const cents = discounted(r.price_cents, gap.discount_percent, gap.currency);
    return {
      service_id: r.id,
      name: r.name,
      duration_seconds: r.duration_seconds,
      price_cents: cents,
      price: formatMoney(cents, gap.currency, locale),
      // Carried here as well as through pricing, because this is the list the
      // customer ticks from. Finding out a job involves parts only after
      // choosing it is the version of this feature that annoys people.
      parts_policy: r.parts_policy,
      parts_note: r.parts_note,
      parts_estimate_low_cents: r.parts_estimate_low_cents,
      parts_estimate_high_cents: r.parts_estimate_high_cents,
      parts_line: partsLine(r, gap.currency, locale),
    };
  });

  return json({
    gap_id: gap.id,
    operator_id: gap.operator_id,
    business_name: gap.business_name,
    trade: gap.trade ?? null,
    profile_slug: gap.profile_slug ?? null,
    is_sample: isDemoOperator(gap.operator_id),
    is_mobile: gap.is_mobile,
    starts_at: gap.starts_at,
    ends_at: gap.ends_at,
    window_seconds: window,
    currency: gap.currency,
    when: formatTimeRange(gap.starts_at, gap.ends_at, gap.timezone, locale),
    services,
  }, 200, { 'cache-control': 'no-store' });
});

/**
 * The pages a stranger arrives on from a search engine.
 *
 * A neighbourhood page, and a page per trade in that neighbourhood — which is
 * the exact shape of "junk removal sherman oaks". Every competitor answers
 * that query with a lead form; this answers it with what is open, when, and
 * what it costs. That is the only advantage here that compounds.
 */
route('GET', '/near/:slug', async ({ env, params }) => {
  const body = await neighbourhoodPage(env, params.slug ?? '');
  if (!body) throw notFound('No such area.');
  return html(body, 200, { 'cache-control': 'public, max-age=120, s-maxage=300' });
});

route('GET', '/near/:slug/:trade', async ({ env, params }) => {
  const body = await tradeInPlacePage(env, params.slug ?? '', params.trade ?? '');
  if (!body) throw notFound('No such area or trade.');
  return html(body, 200, { 'cache-control': 'public, max-age=120, s-maxage=300' });
});

/**
 * Everything above enumerated, so that the geographic layer is reachable
 * rather than only linkable from whichever page happens to be nearby.
 */
route('GET', '/near', async ({ env }) => html(
  await areaIndexPage(env), 200, { 'cache-control': 'public, max-age=300, s-maxage=600' },
));

/**
 * One route per metro, registered from the list rather than written out.
 *
 * A literal '/los-angeles' route was fine while there was one metro and is the
 * thing that would have to be copied for every place opened after this. The
 * metro is captured per iteration, so each route serves its own page and
 * adding a third city touches lib/metros.ts and nothing here.
 */
for (const metro of METROS) {
  route('GET', metroPath(metro), async ({ env }) => html(
    await metroPage(env, metro), 200, { 'cache-control': 'public, max-age=300, s-maxage=600' },
  ));
}

// ---------------------------------------------------------------------------
// The pages that are React routes AND server-rendered.
//
// /s/:trade, /cost/:trade, /browse/:category and /p/:slug are the surfaces
// most search traffic lands on, and until now a crawler asking for one got the
// empty SPA shell: a document with a script tag and nothing to read. /browse
// and /cost joined them because the site's own "every cost guide" link pointed
// at one of them, and a hub that answers with an empty shell is a dead end
// wherever it was linked from.
//
// ONE DOCUMENT FOR EVERYBODY, not two. The renderers below build the page and
// splice it into the SPA's own index.html, inside #root and ahead of the app's
// script — so a crawler that runs no JavaScript reads the content, a browser
// paints it and then React mounts over it, and the bytes are identical either
// way. The alternative, sniffing the user agent to send a crawler the rendered
// page and a person the shell, is cloaking whatever its intent: two responses
// for one URL, picked by who is asking, with nothing keeping them in step.
// See intoShell in lib/seo.ts.
//
// A renderer returning null means the trade, category or profile does not
// exist. That is not a 404 here — it is exactly the case the React page
// already handles with its own "we do not have this trade" copy — so the
// request falls through to the SPA untouched.
// ---------------------------------------------------------------------------

/** The SPA's index.html, or null when there is no assets binding to ask. */
async function spaShell(req: Request, env: Env): Promise<string | null> {
  const assets = (env as unknown as {
    ASSETS?: { fetch: (r: Request) => Promise<Response> };
  }).ASSETS;
  if (!assets) return null;
  try {
    const res = await assets.fetch(new Request(new URL('/index.html', req.url), {
      headers: { accept: 'text/html' },
    }));
    if (!res.ok) return null;
    return await res.text();
  } catch {
    // The standalone document is a page that works. A failed shell fetch is
    // not a reason to serve nothing.
    return null;
  }
}

/** Hands the request back to the SPA, exactly as the fallback in handle does. */
async function toSpa(req: Request, env: Env): Promise<Response> {
  const assets = (env as unknown as {
    ASSETS?: { fetch: (r: Request) => Promise<Response> };
  }).ASSETS;
  if (!assets) throw notFound('No such page.');
  return assets.fetch(req);
}

route('GET', '/s/:trade', async ({ req, env, params }) => {
  const segment = params.trade ?? '';
  const entry = tradeFromPathSegment(segment);
  if (!entry) return toSpa(req, env);
  // /s/junk-removal and /s/junk%20removal are the same page, and the React app
  // only understands the second. One 301 rather than two indexable copies of
  // one page, one of which the app cannot render.
  if (segment !== entry.slug) {
    return new Response(null, {
      status: 301,
      headers: { location: `/s/${canonicalTradeSegment(entry)}` },
    });
  }
  const body = await tradePage(env, segment, { shell: await spaShell(req, env) });
  if (!body) return toSpa(req, env);
  return html(body, 200, { 'cache-control': 'public, max-age=120, s-maxage=300' });
});

route('GET', '/cost/:trade', async ({ req, env, params }) => {
  const segment = params.trade ?? '';
  const entry = tradeFromPathSegment(segment);
  if (!entry) return toSpa(req, env);
  if (segment !== entry.slug) {
    return new Response(null, {
      status: 301,
      headers: { location: `/cost/${canonicalTradeSegment(entry)}` },
    });
  }
  const body = await costGuidePage(env, segment, { shell: await spaShell(req, env) });
  if (!body) return toSpa(req, env);
  return html(body, 200, { 'cache-control': 'public, max-age=120, s-maxage=300' });
});

/**
 * The two hubs those pages link up to.
 *
 * Neither can fail the way the four above can: both are built from the
 * compiled-in catalogue rather than from a slug in the URL, so there is no
 * "no such thing" branch to fall through to the SPA with — every trade has a
 * row on both of them, quiet or not.
 */
route('GET', '/browse', async ({ req, env }) => html(
  await browseIndexPage(env, { shell: await spaShell(req, env) }),
  200, { 'cache-control': 'public, max-age=300, s-maxage=600' },
));

route('GET', '/cost', async ({ req, env }) => html(
  await costIndexPage(env, { shell: await spaShell(req, env) }),
  200, { 'cache-control': 'public, max-age=300, s-maxage=600' },
));

route('GET', '/browse/:category', async ({ req, env, params }) => {
  const body = await categoryPage(env, params.category ?? '', { shell: await spaShell(req, env) });
  if (!body) return toSpa(req, env);
  return html(body, 200, { 'cache-control': 'public, max-age=300, s-maxage=600' });
});

route('GET', '/p/:slug', async ({ req, env, params }) => {
  const body = await profilePage(env, params.slug ?? '', { shell: await spaShell(req, env) });
  if (!body) return toSpa(req, env);
  return html(body, 200, { 'cache-control': 'public, max-age=300, s-maxage=600' });
});

route('GET', '/sitemap.xml', async ({ env }) => {
  const xml = await sitemapXml(env, (env.APP_URL ?? '').replace(/\/$/, ''));
  return new Response(xml, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=600, s-maxage=3600',
    },
  });
});

route('GET', '/robots.txt', async ({ env }) => {
  return new Response(robotsTxt((env.APP_URL ?? '').replace(/\/$/, '')), {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600, s-maxage=86400',
    },
  });
});

route('GET', '/book/:gapId', async ({ req, env }) => {
  const assets = (env as unknown as {
    ASSETS?: { fetch: (r: Request) => Promise<Response> };
  }).ASSETS;
  if (!assets) {
    // No front end to hand this to. Say so plainly rather than bringing the
    // old page back to life as a fallback.
    return new Response('Booking is temporarily unavailable. Please try again shortly.', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  // not_found_handling is single-page-application, so a path with no matching
  // file returns index.html and React Router takes it from there.
  return assets.fetch(req);
});

route('POST', '/book/:gapId', async ({ req, env, params }) => {
  const b = await body(req);
  // The no-JavaScript booking form, so the same reasoning as /api/public/orders
  // with one addition: the slot itself is a bucket. Only one person can have a
  // given gap, and repeatedly posting at one gap is either a race against
  // whoever is mid-booking or an attempt to guess the state of it.
  await enforceRateLimit(env, `order:${clientIp(req)}`, 10, 3600);
  await enforceRateLimit(env, `book-gap:${params.gapId ?? ''}`, 20, 3600);
  try {
    const { slot, thread_token } = await claimSlot(env, {
      gapId: params.gapId ?? '',
      first_name: String(b.first_name ?? ''),
      phone: String(b.phone ?? ''),
      email: str(b.email),
      address_line: str(b.address_line),
      postcode: str(b.postcode),
      thread_token: str(b.thread_token),
    });
    // Straight to their conversation. That page is the confirmation, the way
    // to reach the business, and the only way back — there is no account.
    return new Response(null, {
      status: 303,
      headers: { location: `/c/${thread_token}`, 'cache-control': 'no-store' },
    });
  } catch (e) {
    const msg = e instanceof HttpError ? e.message : 'Could not book that slot.';
    const code = e instanceof HttpError ? e.status : 400;
    // Send them back to the area this gap is actually in. "/near/" on its own
    // matches no route and would hand them a JSON 404.
    const back = await env.DB.prepare(
      `SELECT a.place_slug AS slug FROM gaps g
         JOIN service_areas a ON a.operator_id = g.operator_id AND a.is_active = 1
        WHERE g.id = ? LIMIT 1`,
    ).bind(params.gapId ?? '').first<{ slug: string }>();
    return html(page('Could not book', `<h1>Could not book</h1>
      <p class="meta">${escapeHtml(msg)}</p>
      ${back ? `<a href="/near/${escapeHtml(back.slug)}" class="note">See other slots</a>` : ''}`), code);
  }
});

// ---------------------------------------------------------------------------
// Twilio webhooks (only used when an operator sets sms_mode = 'twilio')
// ---------------------------------------------------------------------------
route('POST', '/webhooks/twilio/inbound', async ({ req, env }) => {
  const form = await req.formData();
  if (!(await verifyTwilioSignature(req, env, form))) {
    // Unsigned means anyone could opt a client out by guessing this URL.
    throw new HttpError(403, 'Invalid signature.', 'bad_signature');
  }
  const from = String(form.get('From') ?? '');
  const text = String(form.get('Body') ?? '').trim().toUpperCase();
  const t = now();

  if (STOP_WORDS.has(text)) {
    await env.DB.prepare(
      `UPDATE clients SET opted_out_at = ?, sms_consent = 0, updated_at = ? WHERE phone_e164 = ?`,
    ).bind(t, t, from).run();
  } else if (START_WORDS.has(text)) {
    await env.DB.prepare(
      `UPDATE clients SET opted_out_at = NULL, sms_consent = 1, sms_consent_at = ?, updated_at = ?
        WHERE phone_e164 = ?`,
    ).bind(t, t, from).run();
  }

  await env.DB.prepare(
    `INSERT INTO messages (id, operator_id, client_id, direction, channel, to_address,
                           from_address, body, status, provider, created_at, updated_at)
     SELECT ?, c.operator_id, c.id, 'in', 'sms', '', ?, ?, 'received', 'twilio', ?, ?
       FROM clients c WHERE c.phone_e164 = ? LIMIT 1`,
  ).bind(newId(), from, String(form.get('Body') ?? ''), t, t, from).run();

  return new Response('<Response></Response>', { headers: { 'content-type': 'text/xml' } });
});

route('POST', '/webhooks/twilio/status', async ({ req, env }) => {
  const form = await req.formData();
  if (!(await verifyTwilioSignature(req, env, form))) {
    throw new HttpError(403, 'Invalid signature.', 'bad_signature');
  }
  const sid = String(form.get('MessageSid') ?? '');
  const status = String(form.get('MessageStatus') ?? '');
  const map: Record<string, string> = {
    sent: 'sent', delivered: 'delivered', undelivered: 'failed', failed: 'failed',
  };
  if (sid && map[status]) {
    // Twilio only sends ErrorCode on a failure, and it is the whole difference
    // between "this number is unreachable, stop offering to them" (30003,
    // 30005) and "we are rate limited, it will go next time" (30001). The
    // column has been there since the first migration and nothing was writing
    // it, so every failed offer looked identical in the log. Stored as text
    // because the column is TEXT and the code is an identifier, not a number
    // anything does arithmetic on.
    const errorCode = map[status] === 'failed'
      ? String(form.get('ErrorCode') ?? '').trim() || null
      : null;
    await env.DB.prepare(
      `UPDATE messages SET status=?, error_code=?, updated_at=? WHERE provider_sid=?`,
    ).bind(map[status], errorCode, now(), sid).run();
    if (map[status] === 'delivered') {
      await env.DB.prepare(
        `UPDATE gap_offers SET status='delivered', updated_at=?
          WHERE id = (SELECT offer_id FROM messages WHERE provider_sid=?) AND status='sent'`,
      ).bind(now(), sid).run();
    }
  }
  // null, not ''. 204 is a null-body status, and constructing a Response with
  // any body at all — the empty string included — throws in workerd and in
  // undici alike. This route therefore answered 500 to every status callback
  // Twilio ever sent it, which Twilio treats as a failure and retries.
  return new Response(null, { status: 204 });
});

// ---------------------------------------------------------------------------
// Getting rid of things
// ---------------------------------------------------------------------------
// Until these two routes there was no way to delete anything in this product.
// A customer could ask and there was nothing to do about it; an operator could
// stop using the site and their email, phone, home address, licence number and
// vehicle plate stayed exactly where they were. See lib/retention.ts for what
// each of these actually removes and for the two things they deliberately keep
// -- settled money, and a live suspension.

/**
 * A customer erasing themselves, authorised by their own link.
 *
 * The link is the only identity a customer has here -- migration 0011 -- and
 * it is not a weak one for this purpose: whoever holds it can already read the
 * booking, the address, the conversation and the photographs. Asking for
 * anything more would mean building the account this product deliberately does
 * not make people create, and the practical result of that is a "delete my
 * data" button nobody can use.
 *
 * DELETE rather than POST because it is a deletion, and it is deliberately not
 * reversible: there is no undo, no thirty-day grace period and no tombstone
 * holding the data in case they change their mind. The front end must say so
 * before it calls this.
 */
route('DELETE', '/api/public/threads/:token/data', async ({ req, env, params }) => {
  // Each call walks several tables and deletes objects out of R2. Three in an
  // hour covers somebody tapping twice because the first response was slow;
  // nothing legitimate needs more.
  await enforceRateLimit(env, `erase:${params.token!}`, 3, 3600);
  await enforceRateLimit(env, `erase-ip:${clientIp(req)}`, 10, 3600);
  const result = await eraseCustomerByToken(env, params.token!);
  return json(result, 200, { 'cache-control': 'no-store' });
});

/**
 * An operator closing their account.
 *
 * Behind their own session, which is the right authority: it is their account.
 * The demo account is refused because it is rebuilt on every visit to /demo
 * and closing it would break that page for everybody, not because closing is
 * dangerous.
 */
route('POST', '/api/account/close', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  if (isDemoOperator(op.id)) {
    throw badRequest(
      'The demo account cannot be closed -- it is rebuilt on every visit.',
      'demo_account');
  }
  const result = await closeOperatorAccount(env, op.id);
  // The session that made this call is revoked along with the rest, so the
  // cookie is cleared here too rather than leaving a browser holding one that
  // now fails on every request without saying why.
  return json(result, 200, { 'set-cookie': clearCookie(), 'cache-control': 'no-store' });
});

route('GET', '/health', async ({ env }) => {
  const r = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
  return json({ ok: r?.ok === 1, time: now() });
});

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------
export default {
  /**
   * One door in, one door out.
   *
   * Everything the site serves leaves through here — API JSON, the /near
   * pages, the offer page, an error, and the built React app the assets
   * binding hands back — so this is the only place the security headers have
   * to be remembered. A route added next month gets them without knowing they
   * exist, which is the only version of this that stays true.
   */
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // The catch is the door staying shut, not politeness about tidy errors.
    // Everything below this line is inside a try in one place or another, but
    // "everything" is a claim about code that has not been written yet, and the
    // cost of it being wrong once is a response that leaves without passing
    // through withSecurityHeaders at all — no CSP, no nosniff, no frame
    // refusal — carrying whatever the runtime chooses to say about the
    // failure. One backstop here is cheaper than being right forever, and the
    // caller gets the same opaque sentence every other 500 in the file gives.
    try {
      return withSecurityHeaders(await respond(req, cardSafe(env), ctx));
    } catch (err) {
      console.error('unhandled at the entry point', err);
      return withSecurityHeaders(json({ error: 'Something went wrong.' }, 500));
    }
  },

  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    return runScheduled(cardSafe(env));
  },
};

/**
 * The env every handler and every cron pass actually gets.
 *
 * env.DB is replaced with a wrapper that checks each bound value before the
 * statement can run, so there is no route, no library function and no future
 * refactor that can write a card number into D1 — because there is no
 * unguarded binding left to reach for. Done once, here, for the same reason
 * the security headers are: a defence applied at the door cannot be forgotten
 * by something added later. See lib/payments.ts.
 */
const cardSafe = (env: Env): Env => ({ ...env, DB: cardSafeDb(env.DB) });

async function respond(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);

  const pre = preflight(req, env);
  if (pre) return pre;

  // Serve the busiest public reads from Cloudflare's cache before any
  // handler runs. Only GETs, only routes that opt in by returning a
  // shareable cache-control, and never anything carrying a session cookie —
  // a cached response is shared with everyone who asks for that URL, so a
  // signed-in answer must never reach it.
  const cacheable = req.method === 'GET'
    && !req.headers.get('cookie')
    && CACHEABLE_PATHS.some((p) => p.test(url.pathname));

  if (cacheable) {
    const cache = (caches as unknown as { default: Cache }).default;
    const hit = await cache.match(req);
    if (hit) return hit;

    const res = await handle(req, env, url);
    const cc = res.headers.get('cache-control') ?? '';
    if (res.status === 200 && cc.includes('s-maxage')) {
      // waitUntil so the caller is not made to wait on the cache write.
      ctx.waitUntil(cache.put(req, res.clone()));
    }
    return res;
  }

  return handle(req, env, url);
}

/** Public GETs whose answer is identical for everybody who asks. */
const CACHEABLE_PATHS = [
  /^\/api\/public\/map$/,
  /^\/api\/public\/trades$/,
  /^\/api\/public\/vapid-key$/,
  /^\/api\/countries$/,
  /^\/api\/public\/profile\//,
];

/**
 * The path prefixes this Worker owns, and the reason the Worker now sees every
 * request at all.
 *
 * The assets binding used to answer /, /browse/* and every other React route
 * without waking the Worker, which meant no response header the Worker sets
 * could ever reach the page a person actually looks at — the framing fix would
 * have covered the API and missed the site. wrangler.toml therefore sends
 * everything here first (run_worker_first = true) and the fallback below hands
 * the rest straight back to the assets binding, so a deep link still loads the
 * SPA exactly as it did.
 *
 * The list is the same one that used to live in wrangler.toml, and it is what
 * keeps a mistyped /api/thing answering with JSON instead of quietly returning
 * the React app with a 200 on it.
 */
const WORKER_PATHS = [
  /^\/api\//,
  /^\/o\//,
  /^\/near\//,
  /^\/near$/,
  // One pattern per metro, built from the same list the routes above are
  // built from. A literal /los-angeles here is what would silently hand a new
  // metro's URL to the assets binding — the SPA shell, with a 200 on it.
  ...METROS.map((m) => new RegExp(`^${metroPath(m).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)),
  /^\/book\//,
  /^\/webhooks\//,
  /^\/a\/stop\//,
  /^\/health$/,
  /^\/demo$/,
  /^\/sitemap\.xml$/,
  /^\/robots\.txt$/,
  // The SPA routes the Worker now renders into as well. Each pattern insists
  // on exactly one segment after the prefix, because that is what the route
  // above matches: /s/ or /browse/x/y is nobody's page here, and it should go
  // on reaching the React app's own catch-all rather than a JSON 404 the
  // visitor cannot act on.
  /^\/s\/[^/]+\/?$/,
  /^\/cost\/[^/]+\/?$/,
  /^\/browse\/[^/]+\/?$/,
  /^\/p\/[^/]+\/?$/,
  // The two catalogue hubs. Without these the assets binding answers /browse
  // and /cost with the bare SPA shell before the Worker is ever asked, which
  // is the state that left the site's own "every cost guide" link pointing at
  // a document with nothing in it.
  /^\/browse$/,
  /^\/cost$/,
];

/**
 * The routes a customer reaches with nothing but the secret in their link.
 *
 * `POST /api/public/threads` — starting a conversation — has no token segment
 * and deliberately does not match: there is no link to be wrong about yet.
 */
const GUEST_LINK_PATHS = /^\/api\/public\/threads\/[^/]+/;

async function handle(req: Request, env: Env, url: URL): Promise<Response> {
  {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      const params = decodeParams(r.keys, m);
      // A segment that is not valid percent-encoding names no resource, so it
      // is answered the way any other unknown path is.
      //
      // It matters that this is a refusal and not an exception. The decode
      // used to happen here, outside the try below, so `/o/%FF` — three
      // characters, no session, no body — threw a URIError past every catch in
      // this file and out of fetch() itself. What the caller got back was the
      // runtime's own error response: no CORS, not the JSON error shape every
      // client parses, and none of the headers withSecurityHeaders exists to
      // put on everything — no CSP, no nosniff, no frame refusal — on a
      // document a browser will happily render. On a preview deployment it
      // carried a stack trace naming the source tree as well.
      if (!params) return withCors(json({ error: 'Not found' }, 404), req, env);
      try {
        // Every route behind a customer's /c/:token link, gated in one place.
        // Put here rather than on each of the thirty routes because the whole
        // value of it is that it cannot be forgotten: the next guest endpoint
        // somebody adds is covered by existing, and a defence you have to
        // remember to apply is a defence with a hole in it already. See
        // guestlink.ts for why the token-bucketed rate limits on these same
        // routes cannot see what this sees.
        if (params.token && GUEST_LINK_PATHS.test(url.pathname)) {
          await guardGuestLink(env, clientIp(req), params.token);
        }
        return withCors(await r.handler({ req, env, params, url }), req, env);
      } catch (err) {
        // A rate limit knows how long the caller has to wait, and saying so is
        // the difference between a client backing off and a client retrying in
        // a tight loop against the wall that just stopped it.
        if (err instanceof RateLimitedError) {
          return withCors(json({ error: err.message, code: err.code }, 429, {
            'retry-after': String(Math.max(1, err.retryAfter)),
          }), req, env);
        }
        if (err instanceof HttpError) {
          return withCors(json({ error: err.message, code: err.code }, err.status), req, env);
        }
        console.error('unhandled', err);
        return withCors(json({ error: 'Something went wrong.' }, 500), req, env);
      }
    }

    // Not a Worker route. If it is not in the Worker's own territory either,
    // it belongs to the React app: not_found_handling is
    // single-page-application, so the assets binding answers a path with no
    // file by returning index.html.
    if (env.ASSETS && !WORKER_PATHS.some((p) => p.test(url.pathname))) {
      return env.ASSETS.fetch(req);
    }
    return withCors(json({ error: 'Not found' }, 404), req, env);
  }
}

/**
 * One piece of cron work, which cannot take the rest of the tick with it.
 *
 * The pass used to be a straight run of awaits with a try around only the last
 * two, so any one of them throwing ended the whole tick where it stood. That
 * ordering quietly made the most important sweep the most fragile: retention
 * is deliberately last, because everything above it keeps the product working
 * — which meant a failure anywhere in expiring a quote, settling a hold or
 * reconciling cadence stopped this deployment deleting home addresses, phone
 * numbers and photographs of people's houses, on every tick, until somebody
 * noticed. The same throw also skipped the expired login tokens and sessions,
 * so credentials that should have been swept outlived the failure too.
 *
 * These steps are genuinely independent — each one is idempotent and reads
 * only what it writes — so there is no ordering to preserve by stopping, and
 * "one query is broken" is not a reason to also stop erasing data.
 */
async function step(name: string, run: () => Promise<unknown>): Promise<void> {
  try { await run(); } catch (e) { console.error(`cron step failed: ${name}`, e); }
}

/**
 * One tick. Every fifteen minutes — `crons` in wrangler.toml's `[triggers]`.
 *
 * The order below is the order things depend on each other in, and retention is
 * last on purpose: everything above it keeps the product working, and none of
 * it is a reason to stop deleting people's addresses.
 */
async function runScheduled(env: Env): Promise<void> {
  {
    const t = now();

    // Expire offers whose window has closed, and release their gaps.
    await step('expire offers', () => env.DB.prepare(
      `UPDATE gap_offers SET status='expired', updated_at=?
        WHERE status IN ('sent','delivered','viewed','queued') AND expires_at IS NOT NULL
          AND expires_at <= ?`,
    ).bind(t, t).run());

    await step('release gaps', () => env.DB.prepare(
      `UPDATE gaps SET status='open', updated_at=?
        WHERE status='offering'
          AND NOT EXISTS (SELECT 1 FROM gap_offers o
                           WHERE o.gap_id = gaps.id
                             AND o.status IN ('sent','delivered','viewed','queued'))`,
    ).bind(t).run());

    // A quote left 'sent' forever is a live authorisation to charge somebody
    // for parts priced weeks ago. Expiring it costs the operator one tap to
    // resend. See parts.ts.
    await step('expire quotes', () => expireQuotes(env));

    // Money frozen by a cancellation, settled once its hold runs out. Silence
    // resolves to keeping the money and charging nobody, so that no pair of
    // people can profit by agreeing to say nothing. See settlement.ts.
    await step('settle holds', () => settleExpiredHolds(env));

    // The five-minute fuse on an instant request, and quotes whose start time
    // came and went. Both are also evaluated on read, so these sweeps only
    // tidy the rows -- they are not what makes the rules true.
    await step('expire requests', () => expireRequests(env));
    await step('expire estimates', () => expireEstimates(env));

    // Wrong-link counters whose window and lockout have both run out. Purely
    // housekeeping: the lockout expires by comparing timestamps on read, so
    // deleting the row late changes nothing except how big the table is.
    await step('sweep guest link attempts', () => sweepGuestLinkAttempts(env));

    // Which businesses each address has written to, once the window that was
    // counting them has passed. Housekeeping in the same sense — the count is
    // taken by comparing timestamps on read, so a late delete changes nothing
    // except the size of the table — but this one is also a record of who
    // contacted whom, and there is no reason to keep one of those a minute
    // longer than the thing it exists to measure.
    await step('sweep enquiry reach', () => sweepEnquiryReach(env));

    // Gaps whose start time has passed are dead.
    await step('expire gaps', () => env.DB.prepare(
      `UPDATE gaps SET status='expired', updated_at=?
        WHERE status IN ('open','offering') AND starts_at <= ?`,
    ).bind(t, t).run());

    // Cadence is recomputed inline when a job is marked completed, so this is
    // only a reconciliation for rows that reached 'completed' another way
    // (an import, a direct edit). Scoped to the last day rather than the whole
    // client table, which used to be rewritten on every tick.
    //
    // THIS SWEEP AND THE INLINE PATH MUST AGREE, and for a while they did not.
    // Two differences, and both of them dropped customers out of the overdue
    // pool that rank.ts feeds on — silently, a day late, so the operator saw a
    // list that had simply gone quiet.
    //
    // The first was where cadence comes from. PATCH /api/appointments takes it
    // from the service on the APPOINTMENT and falls back to the client's
    // default; this took it from the client's default alone. A business whose
    // clients have no default service — every break-fix trade — got a due date
    // inline and had it recomputed here from nothing.
    //
    // The second was what to do when there is no cadence to apply. The inline
    // write says `COALESCE(?, next_due_at)`: a job whose service does not
    // repeat leaves an existing due date alone, because "this visit does not
    // set a new due date" is not the same statement as "this customer is not
    // due again". This wrote `MAX(...) + COALESCE(x, NULL)` — a COALESCE with
    // nothing to fall back to, which is the value it was given — so the
    // addition met NULL and the whole expression became NULL. Within 24 hours
    // of an inline completion, that overwrote a perfectly good due date with
    // nothing.
    //
    // The inline behaviour is the correct one and this now matches it: cadence
    // off the most recent completed appointment's service, falling back to the
    // client's default, and the existing next_due_at kept when neither yields
    // one. Written as a correlated subquery per client rather than a join so
    // that "the most recent completed job" is picked once and its service, its
    // end time and the fallback all come from that same row.
    await step('reconcile cadence', () => env.DB.prepare(
      `UPDATE clients SET
         last_serviced_at = (SELECT MAX(a.ends_at) FROM appointments a
                              WHERE a.client_id = clients.id AND a.status = 'completed'),
         visit_count = (SELECT COUNT(*) FROM appointments a
                         WHERE a.client_id = clients.id AND a.status = 'completed'),
         next_due_at = COALESCE(
           (SELECT a.ends_at + COALESCE(s1.cadence_days, s2.cadence_days) * 86400
              FROM appointments a
              LEFT JOIN services s1 ON s1.id = a.service_id
              LEFT JOIN services s2 ON s2.id = clients.default_service_id
             WHERE a.client_id = clients.id AND a.status = 'completed'
             ORDER BY a.ends_at DESC LIMIT 1),
           next_due_at),
         updated_at = ?
       WHERE id IN (
         SELECT DISTINCT a.client_id FROM appointments a
          WHERE a.status = 'completed' AND a.updated_at > ? AND a.client_id IS NOT NULL
       )`,
    ).bind(t, t - 86400).run());

    // Rescan only operators whose calendar actually moved since their last
    // scan, plus anyone not scanned in 24h so the 14-day window rolls forward.
    // Scanning everyone unconditionally is what put the free-tier D1 write
    // ceiling at ~26 operators; this puts it in the hundreds.
    // The batch cap keeps one tick inside the scheduled-worker time limit —
    // whatever it does not reach is still pending on the next tick.
    await step('rescan calendars', async () => {
      const ops = await env.DB.prepare(
        `SELECT * FROM operators
          WHERE plan IN ('trial','active')
            AND (scanned_version <> calendar_version
                 OR last_scan_at IS NULL
                 OR last_scan_at < ?)
          ORDER BY last_scan_at IS NOT NULL, last_scan_at
          LIMIT 200`,
      ).bind(t - 86400).all<Operator & { calendar_version: number }>();

      for (const op of ops.results ?? []) {
        try {
          await detectGaps(env, op, localDayStart(t, op.timezone), 14);
          await env.DB.prepare(
            `UPDATE operators SET scanned_version = ?, last_scan_at = ? WHERE id = ?`,
          ).bind(op.calendar_version, t, op.id).run();
        } catch (e) {
          // Leave scanned_version alone so a failure retries on the next tick.
          console.error('detect failed for', op.id, e);
        }
      }
    });

    // Openings alerts. Runs after the rescan so it sees the gaps this tick
    // just found — a customer who asked to be told about a cancellation
    // should hear about it in the same quarter hour, not the next one.
    await step('match watches', () => matchWatches(env));

    // Cache hygiene. The last two are credential hygiene as much as cache:
    // a consumed magic link and a lapsed session have no reason to still be
    // rows, and the sweep that removes them is the one most easily lost when
    // something earlier in the tick throws.
    await step('sweep distance cache', () =>
      env.DB.prepare(`DELETE FROM distance_cache WHERE expires_at < ?`).bind(t).run());
    await step('sweep login tokens', () =>
      env.DB.prepare(`DELETE FROM login_tokens WHERE expires_at < ?`).bind(t - 86400).run());
    await step('sweep sessions', () =>
      env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(t - 86400).run());

    // Retention. Everything above this line keeps the product working; this
    // is the pass that stops it accumulating people's home addresses,
    // coordinates, phone numbers and photographs of their houses forever
    // because nothing ever deleted anything. Each sweep catches its own
    // failure, so one broken query cannot quietly switch the rest off — see
    // lib/retention.ts, where all the intervals are gathered and argued.
    await step('retention', async () => {
      const swept = await sweepRetention(env);
      const moved = Object.entries(swept).filter(([, n]) => n !== 0);
      if (moved.length) console.log('retention', JSON.stringify(Object.fromEntries(moved)));
    });
  }
}


// Cloudflare finds a Durable Object class by its export from the entry module.
export { VanTracker } from './do/van';
