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
import { mayEchoSignInLink, sendEmail, signInEmail, emailConfigured} from './lib/email';
import { detectGaps } from './lib/gaps';
import { geocode } from './lib/geo';
import {
  guardGuestLink, sweepGuestLinkAttempts, type ThreadDoor,
} from './lib/guestlink';
import { WEB_IMAGE_TYPES, assertBodyWithin, cleanImageUpload } from './lib/images';
import { RateLimitedError, clientIp, enforceRateLimit, rateLimit } from './lib/ratelimit';
import { withSecurityHeaders } from './lib/headers';
import { requireTurnstile, tokenFromBody } from './lib/turnstile';
import { START_WORDS, STOP_WORDS, SUPPORTED_LANGUAGES, isLang } from './lib/messages';
import {
  CARD_NOTE_CUSTOMER, EMAIL_NOT_CONFIGURED, clearCustomerCookie, closeCustomerAccount,
  accountByEmail, currentCustomer, customerCookie, customerSideOf,
  ensureStripeCustomer, normaliseLoginEmail, publicAccount, requireCustomer,
  revokeCustomerSession, saveCustomerCard, sendSignInCode, signInWithCode,
  sweepCustomerAuth, type CustomerAccount,
} from './lib/customers';
import {
  acceptOffer, createOffers, declineOffer, loadOfferByToken, markViewed,
  stopOffersByToken,
} from './lib/offers';
import { claimSlot, discounted, mapData } from './lib/public';
import { isDemoOperator, seedDemoIfEmpty, startDemo } from './lib/demo';
import { METROS, metroPath, publicMetro } from './lib/metros';
import { listNotifications, markAllRead, markRead, unreadCount } from './lib/feed';
import {
  MAX_MESSAGE_PHOTO_BYTES,
  assertEnquiryReachAllowed, listMessages, listThreads, markThreadRead, operatorForEnquiry,
  postAsGuest, postAsOperator, postPhotoAsGuest, postPhotoAsOperator, readMessagePhoto,
  recordEnquiryReach, setThreadStatus, startThread, sweepEnquiryReach,
  threadByToken, threadForOperator, unreadThreadCount,
  businessesInCustomerThreads, listThreadsForCustomer, unreadThreadCountForCustomer,
  type ThreadRef,
} from './lib/chat';
import {
  addSubscription, confirmWatchEmail, createWatch, deactivateWatch, matchWatches,
  removeSubscription, unsubscribeByToken, updateWatch, watchByToken,
} from './lib/alerts';
import { vapidPublicKey } from './lib/push';
import { cancelOpening, listOpenings, postOpening } from './lib/openings';
import { placeOrder, priceOrder } from './lib/orders';
import {
  cleanPartsFields, decideQuote, partsLine, quotableItems, quotesForGuest,
  quotesForOperator, reconcileSentQuotes, sendQuote, withdrawQuote, expireQuotes,
} from './lib/parts';
import {
  cancelByCustomer, cancelByOperator, feesOwed, listFees, listingBlock, markArrived,
  quoteRefund,
} from './lib/bypass';
import {
  addressReleaseColumns, firstNameOnly, maskCustomerRow, maskEmail, maskPhone,
} from './lib/redact';
import {
  assertNoCardData, assertPaymentRef, cardSafeDb, customerCardRequired, paymentsLive,
  safeBrand, safeLast4, stripeWebhooksConfigured, verifyStripeSignature,
} from './lib/payments';
import { listAdminActions, recordAdminAction } from './lib/audit';
import {
  closeOperatorAccount, eraseCustomerByPhone, eraseCustomerByToken, forgetVan, sweepRetention,
} from './lib/retention';
import { catalogFor, TRADE_CATEGORIES } from './lib/trades';
import { deleteFaq, listFaqs, saveFaq } from './lib/profile';
import {
  acceptRequest, cancelRequest, createInstantRequest, declineRequest, expireRequests,
  goOffline, goOnline, maskInstantRequest, onlineStatus, operatorsOnlineNear,
  pendingForOperator, requestByToken,
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
import { VEHICLE_KINDS } from './lib/vehicles';
import {
  markPaid, markPaymentFailed, reconcileUnpaidOrders, refundItem, settleDueWork,
  startPayment, sweepPartsRefunds, sweepRefunds,
} from './lib/checkout';
import {
  connectStatus, refreshConnectAccount, startOnboarding, syncConnectAccount,
} from './lib/connect';
import {
  chargeIdOf, createSetupIntent, getPaymentMethod, stripeConfigured,
} from './lib/stripe';
import { feeSentence } from './lib/fees';
import {
  confirmNoShow, customerStanding, hasOperatorCard, openReports, operatorStanding,
  provedCustomerStanding, rejectNoShow, reportNoShow, saveOperatorCard,
} from './lib/standing';
import {
  areaIndexPage, browseIndexPage, canonicalPlaceSlug, canonicalTradeSegment, catalogPayload,
  categoryPage, costGuidePage, costIndexPage, homePage, metroForOperator, metroPage,
  neighbourhoodPage, notFoundPage, profilePage, robotsTxt, siteBase, sitemapXml,
  tradeFromPathSegment, tradeFromSlug, tradeInPlacePage, tradePage, tradeSlug,
} from './lib/seo';
import {
  getCredentials, publishBlockers, rulesFor, saveCredentials,
} from './lib/credentials';
import {
  customerView, livePositions, operatorPosition, recordPosition, setShareLocation,
} from './lib/track';
import {
  MAX_PHOTO_BYTES, addPhoto, deletePhoto, ensureProfileSlug, getPublicProfile,
  listPhotos, reorderPhotos, similarBusinesses,
} from './lib/profile';
import { getPhoto, putPhoto } from './lib/photostore';
import { NOBODY_TO_OFFER, rankCandidates, type GapRow } from './lib/rank';
import { formatTimeRange, localDayStart } from './lib/tz';
import {
  HttpError, badRequest, conflict, escapeHtml, html, json, newId, notFound, now, toE164,
} from './lib/util';

// ---------------------------------------------------------------------------
// Tiny router
// ---------------------------------------------------------------------------
type Handler = (ctx: {
  req: Request; env: Env; params: Record<string, string>; url: URL;
  /**
   * The conversation this request is about, in the form every guest-side
   * library function takes. Only meaningful on the routes GUEST_LINK_PATHS
   * matches; an empty string on every other route, which none of them read.
   *
   * ON THE TOKEN DOOR IT IS THE RAW SEGMENT, exactly what `params.token` has
   * always been, so those handlers do precisely what they did before: the
   * library resolves the secret itself and refuses an unknown one in its own
   * words. On the account door it is the row guardGuestLink has already proved
   * belongs to the signed-in customer. See ThreadRef in lib/chat.ts for why
   * this is one union rather than thirty twinned routes.
   */
  ref: ThreadRef;
  /**
   * Which authority opened it. `{ via: 'link' }` on every route that has no
   * token segment, which is the honest default: nothing was opened on an
   * account, so nothing may claim it was.
   */
  door: ThreadDoor;
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

/**
 * The `status=` filter on either conversation list, or the caller's default.
 *
 * AN ALLOW-LIST AND NOT A PASS-THROUGH, and the default is an argument rather
 * than a constant because the two lists genuinely want different ones: the
 * operator's inbox hides closed conversations, because closing is the only way
 * a business gets a finished job off that screen, and the customer's list
 * shows them, because a business closing a conversation must not make it
 * vanish off the customer's own account. lib/chat.ts has the long version
 * above each list.
 *
 * Anything that is not one of the three spellings is the default rather than
 * an error. This is a filter on a list in a query string — a stale bookmark or
 * a typo should draw the list, not an error page over a list the reader can
 * see perfectly well by pressing reload.
 */
const threadStatusFilter = (
  raw: string | null, fallback: 'open' | 'closed' | 'all',
): 'open' | 'closed' | 'all' =>
  (raw === 'open' || raw === 'closed' || raw === 'all' ? raw : fallback);

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
    // A NEW BUSINESS, so this counts against the day's places — the same
    // hundred a new customer comes out of. Deliberately inside the branch: an
    // operator who already has a row is signing in, not joining, and must be
    // able to reach their account whatever the day's intake has been. See
    // NEW_ACCOUNTS_PER_DAY.
    await enforceDailyIntake(env, 'business');

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
    // THE REASON, AND NOTHING ELSE ON THE RESULT.
    //
    // This logged the whole object, which carries `detail` — built in email.ts
    // as `${provider} ${status} ${body}`, the body being the provider's own
    // response, and providers routinely quote the recipient back inside it. So
    // an ordinary send failure printed an operator's email address into the
    // Worker log, and a Worker log is the one store in this product that is
    // outside every sweep in retention.ts and outside every erasure path in
    // it: somebody who asks to be forgotten cannot be forgotten from there.
    // The reason is the whole of what anybody reading this line can act on
    // anyway. The same cut was already made in customers.ts and alerts.ts.
    console.error('sign-in email not sent', result.reason);
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

  // A REAL SESSION IS NEVER REPLACED BY THE DEMO ONE.
  //
  // This is a GET that sets the operator session cookie — `__Host-gf_session`,
  // which this comment called `gf_session` until the `__Host-` prefix was
  // added to it, and a cookie name that is nearly right is worse than none
  // when somebody is grepping for the thing that gets overwritten here. A
  // browser sends cookies on a cross-site top-level navigation, so any page
  // anywhere could point a signed-in operator's browser at /demo and silently
  // swap them out of their own business into a shared throwaway account, on
  // the same cookie name and the same path. They would still appear signed in,
  // at somebody else's diary, with no sign anything had happened.
  //
  // Refusing cross-site navigation outright would break the legitimate case,
  // which is somebody clicking a link to the demo from somewhere else. So the
  // narrow thing is done instead: if this browser already holds a working
  // operator session, it keeps it and is simply sent to the app.
  const alreadyIn = await requireOperator(req, env).then(() => true).catch(() => false);
  if (alreadyIn) {
    return new Response(null, {
      status: 302,
      headers: { location: '/app', 'cache-control': 'no-store' },
    });
  }

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

// ---------------------------------------------------------------------------
// The customer's account
//
// A mobile number, proved by a code sent to it in a text message. No password,
// no mailbox, no separate journey: the account is created at the confirm step
// of the checkout, in the same action that would take the card. See
// lib/customers.ts for why each number below is what it is, and migration 0037
// for why this exists at all when thirty comments in this codebase say a
// customer never has an account.
//
// THESE ROUTES AND THE OPERATOR'S ARE DISJOINT, and not by convention. A
// customer's cookie has a different name, its digest is computed in a
// different domain, and it names a row in a different table — so there is no
// value that satisfies both requireOperator and requireCustomer, and no
// refactor of one lookup that could make one appear.
//
// /c/:token is untouched by every line of this. It is how somebody opens their
// booking on a phone that has never been signed in, and it does not ask for an
// account before, during or after.
// ---------------------------------------------------------------------------

/** The sentence a caller gets when a booking needs an account and has none. */
const ACCOUNT_REQUIRED =
  'Booking needs an account, and making one takes one email: give us your '
  + 'email address, type the six digits we send back, and the account is '
  + 'created as you book. Reading a booking you already have never needs one — '
  + 'the link in your confirmation still opens it.';

// ---------------------------------------------------------------------------
// THE TESTING CAP
// ---------------------------------------------------------------------------
//
// A HUNDRED NEW ACCOUNTS A DAY, SHARED, AND IT IS NOT AN ARBITRARY NUMBER.
//
// Every account made here costs exactly one email — a six-digit code to a
// customer, a sign-in link to a business — and the provider's free tier is one
// hundred emails a day for the whole deployment. ONE HUNDRED IN TOTAL, not one
// hundred of each: two buckets of a hundred would be a promise of two hundred
// emails from an allowance that stops at one hundred, and the second half of
// that promise fails as a code that is never sent.
//
// So the two sides share one bucket, and that is the honest shape of the
// constraint. A day with eighty new customers leaves room for twenty new
// businesses, because that is literally what is left.
//
// COUNTED ON INTAKE, NOT ON SUCCESS. It sits in front of the code being minted
// rather than after the account row is written, because the email is spent at
// the send and not at the sign-in — somebody who asks for a code and never
// types it has still used one of the hundred.
//
// SIGNING IN AGAIN IS NOT CAPPED, and must not be. This bounds how many people
// can start; a business already listed here has to be able to reach its
// account on the hundred-and-first day as much as on the first. The ceiling
// that bounds a returning person is the per-mailbox one in sendSignInCode.
//
// The honest caveat, written down rather than discovered: a returning person's
// sign-in comes out of the same hundred and is not counted here, so a busy day
// of sign-ins can exhaust the allowance before the intake bucket is full. This
// cap is what stops the site INVITING more people than it can serve; it is not
// a guarantee that the hundredth will get through.
const NEW_ACCOUNTS_PER_DAY = 100;

/** The sentence somebody gets when today's places are gone. */
const INTAKE_FULL =
  'Round The Way is in testing, and a hundred people can join each day — '
  + 'customers and businesses together. Today is full. Come back tomorrow: '
  + 'nothing you have already done here is affected, and a booking you have '
  + 'made still opens from the link in your confirmation.';

/**
 * Refuses once today's places are gone.
 *
 * Fixed-window and therefore capable of letting through up to twice the number
 * across a midnight boundary — which is the documented behaviour of rateLimit
 * and is fine here for once. The ceiling exists to keep the day's email spend
 * near a hundred; the per-mailbox and per-address limits are what stand
 * between this and abuse, and they are not fixed to the same window.
 *
 * `side` is taken and deliberately not used in the key. It is here because the
 * call sites read better naming which door they are, and because the day
 * somebody wants to know which side filled the bucket, the argument is already
 * threaded through — but ONE key is the whole point of this function.
 */
async function enforceDailyIntake(
  env: Env, _side: 'customer' | 'business',
): Promise<void> {
  const r = await rateLimit(env, 'intake:all', NEW_ACCOUNTS_PER_DAY, 86400);
  if (!r.ok) throw new RateLimitedError(INTAKE_FULL, r.retryAfter);
}

route('POST', '/api/customer/auth/code', async ({ req, env }) => {
  const b = await body(req);
  const email = normaliseLoginEmail(str(b.email));
  if (!email) throw badRequest('Enter an email address we can send a code to.', 'bad_email');

  // A door, and one that costs money to open: every call spends one of a
  // hundred emails a day, aimed at a mailbox the caller has merely named. That
  // is the exact shape the rate limits cannot see — ten thousand hosts sending
  // one each — so the challenge belongs here, and it runs before a message is
  // composed and before an allowance is spent.
  await requireTurnstile(env, req, tokenFromBody(b));

  // PER-CALLER CEILINGS FIRST, THE GLOBAL ONE LAST. The order matters more
  // than it looks: enforceDailyIntake spends from ONE bucket shared by the
  // whole platform, so putting it in front of the per-IP and per-mailbox
  // limits meant a hundred unauthenticated requests from one machine could
  // close sign-in for every customer on the site for a day. The narrow limits
  // stop that caller long before the shared allowance notices them.
  await enforceRateLimit(env, `otp-send-ip:${clientIp(req)}`, 20, 900);

  // AND NOT AT ALL FOR SOMEBODY WHO ALREADY HAS AN ACCOUNT. The cap exists to
  // bound how many NEW people can be signed up in a day while this is being
  // tested; an existing customer signing in again is not a new account, and
  // locking them out of their own bookings because a hundred strangers looked
  // at the site that morning is not what it was for. /api/auth/request has
  // made the same distinction on the operator side from the start.
  if (!(await accountByEmail(env, email))) {
    await enforceDailyIntake(env, 'customer');
  }

  // Fails closed with no provider configured. The volume ceilings, the reasons
  // for each of them and the refusal all live in sendSignInCode.
  const sent = await sendSignInCode(env, {
    email,
    ip: clientIp(req),
    lang: str(b.language),
    // Local development only: AUTH_DEBUG_TOKEN set as a secret, presented by
    // the caller, and APP_URL on localhost. The same gate the operator's
    // sign-in link is echoed behind, and the only path on which a code is ever
    // returned to whoever asked for it.
    echo: mayEchoSignInLink(env, req.headers.get('x-auth-debug')),
  });
  // The same answer whether or not an account exists for that address. This
  // must never become the way to ask whether somebody has booked here.
  return json({ ok: true, ...sent }, 200, { 'cache-control': 'no-store' });
});

route('POST', '/api/customer/auth/verify', async ({ req, env }) => {
  const b = await body(req);
  const email = normaliseLoginEmail(str(b.email));
  if (!email) throw badRequest('Enter an email address we can send a code to.', 'bad_email');
  const country = (str(b.country) ?? 'US').toUpperCase();
  // Taken on trust from here on: nothing proves it, and nothing may be
  // unlocked by it. See migration 0038.
  const phone = toE164(str(b.phone), country);

  // A SECOND CEILING ON TOP OF THE PER-CODE ATTEMPT COUNTER, and it is not
  // redundant with it. Five wrong guesses kill one code; this bounds how fast
  // somebody can cycle "ask for a code, guess five times" against a number,
  // and it counts a caller who is guessing at codes that were never sent —
  // which reaches no row and so increments no counter at all.
  await enforceRateLimit(env, `otp-verify:${email}`, 10, 900);
  await enforceRateLimit(env, `otp-verify-ip:${clientIp(req)}`, 30, 900);

  const signed = await signInWithCode(env, {
    email,
    code: String(b.code ?? ''),
    userAgent: req.headers.get('user-agent'),
    // Only the first word of it, the same rule the checkout applies, because
    // this name becomes the default on a booking and a booking's name is
    // written onto the operator's own client row. See firstNameOnly.
    first_name: firstNameOnly(str(b.first_name)) || null,
    phone,
  });

  return json({
    account: publicAccount(signed.account),
    created: signed.created,
    claimed: signed.claimed,
    // Told at sign-in rather than discovered at checkout. Somebody serving a
    // suspension can still read their bookings and message a business; what
    // they cannot do is book, and finding that out after filling in a basket
    // is a worse way to learn it.
    standing: await customerStanding(env, email),
    card_note: CARD_NOTE_CUSTOMER,
  }, 200, { 'set-cookie': signed.cookie, 'cache-control': 'no-store' });
});

route('POST', '/api/customer/logout', async ({ req, env }) => {
  await revokeCustomerSession(req, env);
  return json({ ok: true }, 200, { 'set-cookie': clearCustomerCookie() });
});

route('GET', '/api/customer/me', async ({ req, env }) => {
  const account = await requireCustomer(req, env);
  return json({
    account: publicAccount(account),
    standing: await customerStanding(env, account.login_email ?? ''),
    /** True once the webhook secret is set. See paymentsLive in lib/payments.ts. */
    payments_live: paymentsLive(env),
    card_note: CARD_NOTE_CUSTOMER,
  }, 200, { 'cache-control': 'no-store' });
});

/**
 * This person's bookings, across every business they have used.
 *
 * The thing an account buys a customer that a link never could: one place
 * showing all of it, including the bookings they made before they had an
 * account, which were attached to it the first time they verified the number.
 *
 * The guest link is NOT in this payload and cannot be. Only its hash is stored
 * — see claimGuestHistory — so there is nothing to hand back; an account
 * reaches its own bookings by id instead, and whoever still has an old link
 * keeps using it.
 */
route('GET', '/api/customer/bookings', async ({ req, env }) => {
  const account = await requireCustomer(req, env);
  const rows = await env.DB.prepare(
    `SELECT o.id AS order_id, o.status, o.currency, o.total_cents, o.created_at,
            o.payment_brand, o.payment_last4,
            oi.id AS order_item_id, oi.operator_id, oi.starts_at, oi.ends_at,
            oi.price_cents, oi.parts_cents, oi.cancelled_at, oi.cancelled_by,
            -- refund_cents is what was decided and refunded_at is what was
            -- done, and the customer is owed both. "Cancelled, you get $240
            -- back" and "cancelled, your $240 went back on Tuesday" are
            -- different sentences to somebody watching their bank account,
            -- and showing only the first is how a refund that never left
            -- looks exactly like one that did.
            oi.arrived_at, oi.settlement, oi.refund_cents, oi.refunded_at,
            oi.start_code,
            op.business_name, op.profile_slug, op.trade
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       LEFT JOIN operators op ON op.id = oi.operator_id
      WHERE o.customer_account_id = ?
      ORDER BY oi.starts_at DESC
      LIMIT 200`,
  ).bind(account.id).all<Record<string, unknown>>();
  return json({ bookings: rows.results ?? [] }, 200, { 'cache-control': 'no-store' });
});

/**
 * This person's conversations, across every business they have written to.
 *
 * THE SECOND HALF OF WHAT AN ACCOUNT IS FOR, and until migration 0052 it did
 * not exist. The list above has shown somebody every booking they have made
 * since 0037, and the paragraph underneath it on /account had to say: to
 * message the business, see the photographs or cancel, open the booking from
 * the link in its confirmation — that link is the only copy there is. For
 * anybody who had lost it that was the end of the road, and the owner's
 * description of the problem is exactly right: "there has to be a way for a
 * business and client to continue a conversation without needing to keep a
 * link." The business side never had this problem, because /app/messages has
 * been scoped by operator_id since 0011.
 *
 * SCOPED IN THE WHERE CLAUSE, NOT FILTERED AFTERWARDS. listThreadsForCustomer
 * takes the account id and puts it in the query, the same shape
 * /api/customer/bookings above uses and the same shape the operator's own
 * inbox uses. There is no path by which this can return a row belonging to
 * another account, because no row that does not match is ever read.
 *
 * NO MESSAGES IN THIS PAYLOAD, only the conversations. A list is for choosing
 * which one to open; sending the transcripts of fifty conversations to draw a
 * list of fifty names would be most of a customer's whole history in one
 * response, on a route a page may poll. The transcript comes from opening one.
 *
 * NO GUEST TOKEN IN IT EITHER, and there cannot be one — only the hash is
 * stored. That is the point of the whole change rather than a shortcoming of
 * it: the account reaches a conversation by its id, on its own authority, and
 * whoever still holds an old link goes on using it.
 *
 * ---------------------------------------------------------------------------
 * PAGED, SEARCHED AND COUNTED, WHICH IT WAS NOT WHEN IT LANDED
 * ---------------------------------------------------------------------------
 * The first version of this route returned the account's conversations with no
 * limit the caller could move and no cursor at all, which was fine for the
 * person it was written for — somebody with one booking — and wrong for the
 * person it exists for. The owner's words: "customers will be messaging
 * multiple [businesses]". Somebody who has had five trades out has five rows
 * that differ only by which business is on them, and somebody who has used
 * this site for two years has fifty; the fiftieth was simply unreachable, and
 * which of them had replied was answerable only by opening each one.
 *
 * So: `cursor`/`limit` for the page, `unread=1`, `business=<operator id>` and
 * `status=` for the narrowing, `q=` for the search, and an `unread` total
 * beside the rows. `businesses` is the list the filter is drawn from and is
 * its own query — a filter built from the twenty-five rows on this page could
 * not offer the business whose conversation is the reason somebody is paging.
 *
 * EVERY ONE OF THOSE NARROWS AND NONE OF THEM WIDENS. They are read off the
 * query string and passed as filters into a statement whose WHERE clause
 * already carries `customer_account_id = ?` from the session; nothing here
 * touches that scope, and `business` in particular is an operator id compared
 * INSIDE it, so naming a business this account has never written to returns an
 * empty page rather than that business's other customers.
 */
route('GET', '/api/customer/threads', async ({ req, env, url }) => {
  const account = await requireCustomer(req, env);
  const q = url.searchParams;
  const [page, unread, businesses] = await Promise.all([
    listThreadsForCustomer(env, account.id, {
      unreadOnly: q.get('unread') === '1',
      operatorId: q.get('business'),
      status: threadStatusFilter(q.get('status'), 'all'),
      q: q.get('q'),
      limit: int(q.get('limit')) ?? undefined,
      cursor: q.get('cursor'),
    }),
    unreadThreadCountForCustomer(env, account.id),
    businessesInCustomerThreads(env, account.id),
  ]);
  return json(
    { threads: page.threads, next_cursor: page.next_cursor, unread, businesses },
    200, { 'cache-control': 'no-store' },
  );
});

// ---------------------------------------------------------------------------
// The customer's card
//
// NO CARD NUMBER EVER REACHES THIS WORKER, on this side of the market any more
// than on the operator's. The processor's own form takes the details in the
// customer's browser and hands back an opaque reference; that reference is all
// these two routes carry, and lib/payments.ts refuses anything card-shaped at
// ingress, at every database bind and at egress whatever a handler intends.
//
// NOTHING PRODUCES SUCH A REFERENCE TODAY. Stripe is not wired, so the POST
// below is reachable and unused: it is the seam, not a claim that a card has
// been taken. paymentsLive() is false everywhere, so no booking is refused for
// want of a card and no card is charged.
// ---------------------------------------------------------------------------
route('GET', '/api/customer/payment-method', async ({ req, env }) => {
  const account = await requireCustomer(req, env);
  return json({
    // The reference itself is deliberately absent — see publicAccount. The
    // brand, the last four and the date are what lets a person recognise
    // their own card, and they are the whole of what any screen needs.
    card: account.payment_ref
      ? {
          payment_brand: account.payment_brand,
          payment_last4: account.payment_last4,
          payment_added_at: account.payment_added_at,
        }
      : null,
    payments_live: paymentsLive(env),
    note: CARD_NOTE_CUSTOMER,
  }, 200, { 'cache-control': 'no-store' });
});

route('POST', '/api/customer/payment-method', async ({ req, env }) => {
  const account = await requireCustomer(req, env);
  const b = await body(req);
  // PAYMENT SEAM. assertPaymentRef is the same check the operator's card goes
  // through: a value with no letters in it is not a processor handle whatever
  // else it may be, and that is the shape a mis-wired form actually sends.
  await saveCustomerCard(env, account.id, {
    ref: String(b.ref ?? ''), brand: str(b.brand), last4: str(b.last4),
  });
  return json({ ok: true }, 200, { 'cache-control': 'no-store' });
});

/**
 * Closing a customer account.
 *
 * The number, the name, the mailbox and the card reference are emptied and
 * every session on it dies. The bookings stay: an order is a record of
 * something that happened between two people and one of them does not get to
 * delete it unilaterally. Somebody who wants the bookings gone as well asks
 * for the erasure below, which says what it is before it runs.
 *
 * A LIVE SUSPENSION IS NOT CLEARED BY THIS. Standing is keyed on the address
 * and outlives the account, so "close it and sign up again" is not the way
 * round the no-show ladder — proving the same address produces an account
 * that is still suspended.
 */
route('POST', '/api/customer/close', async ({ req, env }) => {
  const account = await requireCustomer(req, env);
  const result = await closeCustomerAccount(env, account.id);
  return json(result, 200, {
    'set-cookie': clearCustomerCookie(), 'cache-control': 'no-store',
  });
});

/**
 * "Delete everything you hold about me", from the account rather than a link.
 *
 * The same erasure DELETE /api/public/threads/:token/data performs and the same
 * function underneath it — see eraseCustomerByPhone. Two doors, one
 * implementation, because a customer who is erased through their account and
 * finds the link version went further has not been erased.
 *
 * DELETE rather than POST because it is a deletion, and it is deliberately not
 * reversible: no undo, no grace period, no tombstone. The front end must say
 * so before it calls this.
 */
route('DELETE', '/api/customer/data', async ({ req, env }) => {
  const account = await requireCustomer(req, env);
  const subject = account.login_email;
  if (!subject) throw badRequest('This account has nothing left to erase.', 'no_subject');
  await enforceRateLimit(env, `erase-account:${account.id}`, 3, 3600);
  const result = await eraseCustomerByPhone(env, subject);
  // The account went with it, so the cookie in this browser now names a closed
  // row. Cleared here rather than left to fail silently on the next request.
  return json(result, 200, {
    'set-cookie': clearCustomerCookie(), 'cache-control': 'no-store',
  });
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
  | { kind: 'timezone' }
  | { kind: 'flag' };

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
  /**
   * TAKING BOOKINGS, OR PAUSED.
   *
   * Read in a dozen places and, until now, settable in none of them — a
   * business that wanted to stop being listed for a fortnight had no way to
   * say so, and the only thing left to do was delete openings one at a time
   * and hope. Every public query already respects it, so turning it off
   * removes the business from the map, the search pages and the browse lists
   * in one write.
   *
   * IT DOES NOT TOUCH WORK ALREADY BOOKED. Somebody who has paid keeps their
   * appointment whatever this says — pausing is about new work, and a switch
   * that quietly cancelled a customer's Saturday would be the worst button in
   * the product. The copy beside it says so.
   */
  accept_public_bookings: { kind: 'flag' },
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
    // Stored as 0 or 1 because that is what the column is and what every
    // query comparing against it expects. Anything JSON can carry as a yes is
    // accepted — true, 1, "1", "true" — because a front end sending the
    // string "false" and getting a truthy row back is a bug that hides for
    // months.
    case 'flag': {
      if (raw === true || raw === 1 || raw === '1' || raw === 'true') return 1;
      if (raw === false || raw === 0 || raw === '0' || raw === 'false') return 0;
      throw badRequest(`${key} must be true or false.`, 'bad_setting');
    }
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
            oi.address_released_at,
            -- WHAT THE OPERATOR WAS ACTUALLY PAID, which until now this route
            -- did not carry at all. Every one of these columns was already
            -- being written by settleOrder and markPaid, and none of them was
            -- readable by the app -- so a business could see the price of a
            -- job it had finished and had no way to find out what reached its
            -- bank, what was kept, or whether the payout had even gone yet.
            -- Sent from the server rather than worked out in the browser,
            -- because a payout the page calculates and the transfer disagree
            -- about by one cent is a support ticket that costs more than the
            -- cent.
            oi.fee_cents, oi.transfer_id, oi.transferred_at,
            oi.refund_cents, oi.refunded_at,
            o.paid_at, o.payment_status
       FROM appointments a
       LEFT JOIN clients c  ON c.id = a.client_id
       LEFT JOIN services s ON s.id = a.service_id
       LEFT JOIN order_items oi ON oi.appointment_id = a.id
       LEFT JOIN orders o ON o.id = oi.order_id
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
 * The columns PATCH /api/appointments/:id is allowed to set, and the reader
 * each one has to survive on the way in.
 *
 * IT USED TO BE A LIST OF NAMES AND `vals.push(b[k])`. The list bounded WHICH
 * columns could be written, which is why this was never an injection — and it
 * said nothing whatever about what was written into them. `price_cents: "abc"`
 * and `lat: {}` went into the database verbatim, and every other update path
 * in this file puts its values through `int`, `num` or `str` first.
 *
 * WHAT THAT COST, AND IT IS NOT COSMETIC. These are not display fields.
 * price_cents is money: it is summed for an operator's takings, compared
 * against a fee, and read by the ranking that decides whose opening is shown
 * first — and SQLite will happily compare a text 'abc' against a number, with
 * text sorting after every integer, so one bad row does not fail, it quietly
 * outranks every real one. lat and lng are what every distance in the product
 * is computed from; an object stored there becomes the string
 * "[object Object]", and the haversine that reads it produces NaN, which
 * propagates through the detour calculation and takes an opening out of every
 * customer's results without erroring anywhere. Nothing in the write path
 * complains, so the row is wrong from then on and the report of it arrives as
 * "this job is missing from the map".
 *
 * So each column names its reader, and a value the reader cannot make sense of
 * is refused at the door rather than mangled into the row. The readers are the
 * same ones POST /api/appointments uses for the same columns — `num` for the
 * coordinates because they keep their fraction, `int` for the money because it
 * is cents, `str` for the text.
 *
 * EXPLICIT NULL IS STILL "CLEAR THIS", on every one of them. That is the whole
 * reason the check is not simply "the reader returned null": a caller emptying
 * the notes or removing a price is doing something ordinary and must keep
 * working. An empty string does the same for the text columns, which is what
 * `str` already means everywhere else in this file. It is only a value that is
 * neither of those and still cannot be read that is an error.
 */
const APPOINTMENT_PATCH_FIELDS: ReadonlyArray<
  readonly [column: string, read: (column: string, raw: unknown) => unknown]
> = [
  ['price_cents', (k, v) => patchNumber(k, v, int)],
  ['notes', patchText],
  ['address_line', patchText],
  ['postcode', patchText],
  ['lat', (k, v) => patchNumber(k, v, num)],
  ['lng', (k, v) => patchNumber(k, v, num)],
  // Text like the rest, and the refusal does a second job here: the ownership
  // check further down is `str(b.service_id)` and skips anything that is not a
  // string, so a service_id arriving as a number or an object was written onto
  // the row without ever being proved to belong to this operator.
  ['service_id', patchText],
];

/** A text column: null or blank clears it, and only a string is text. */
function patchText(column: string, raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== 'string') throw badRequest(`${column} has to be text.`, 'bad_field');
  return str(raw);
}

/** A number column: null clears it, and anything unreadable is refused. */
function patchNumber(
  column: string, raw: unknown, read: (v: unknown) => number | null,
): number | null {
  if (raw === null) return null;
  const n = read(raw);
  if (n === null) throw badRequest(`${column} has to be a number.`, 'bad_field');
  return n;
}

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
  // Absent means "leave it alone" and is the only thing that skips a column;
  // everything present goes through its reader. See APPOINTMENT_PATCH_FIELDS.
  for (const [k, read] of APPOINTMENT_PATCH_FIELDS) {
    if (b[k] !== undefined) { sets.push(`${k} = ?`); vals.push(read(k, b[k])); }
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
 * `offers_per_wave` by score.
 *
 * THE SERVER SENDS THEM NOW. This used to answer with prefilled `sms:` links
 * for the operator to tap on their own handset, which was the only delivery
 * this feature had and could never work: the customers this site introduces
 * are written with no phone number on purpose, and there is no SMS provider to
 * send through in any case. Each offer now lands in the conversation that
 * customer already has with this business, with an email nudge behind it — see
 * lib/offers.ts. There is nothing left for the operator to do after this call,
 * which is why `sms_mode` is gone from the response; the column stays on the
 * operator row and this path no longer reads it.
 */
route('POST', '/api/gaps/:id/offers', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  const gap = await loadGap(env, op, params.id!);

  if (gap.status === 'filled') throw new HttpError(409, 'That gap is already filled.', 'gap_filled');

  const ranked = await rankCandidates(env, op, gap);
  if (ranked.length === 0) {
    return json({ offers: [], reason: NOBODY_TO_OFFER });
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
  // An empty wave off a non-empty selection means every one of them stopped
  // being reachable between the ranking and the send -- an account closed, a
  // conversation closed. Answered as the same "nobody to offer" sentence
  // rather than as a success with no offers in it, because from the operator's
  // side those are the same fact and only one of them has a next step.
  if (offers.length === 0) return json({ offers: [], reason: NOBODY_TO_OFFER });
  return json({ offers }, 201);
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
  // token is the right bucket: one offer, one customer refreshing it. Ten a
  // minute leaves room for someone tapping back and forth between this and the
  // conversation or the email the link arrived in.
  await enforceRateLimit(env, `offer-view:${params.token!}`, 60, 600);
  let offer;
  try {
    offer = await loadOfferByToken(env, params.token!);
  } catch {
    // "Check the text message" is what this said, and there is no text
    // message: an offer arrives in the conversation the customer already has
    // with that business, with an email behind it. Telling somebody to go and
    // look at something that does not exist is how a dead link turns into a
    // person who thinks they have lost something.
    return html(page('Link not found',
      `<p class="big">🔗</p><h1>This link isn't valid</h1>
       <p class="meta">Check the link they sent you, or message them in the app
       and we'll sort it out.</p>`), 404);
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
      <p class="meta">Message them in the app if you'd still like the slot.</p>`), 410);
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
      <p class="note">See you then. Message them in the app if anything changes.</p>`));
  } catch (e) {
    const code = e instanceof HttpError ? e.code : undefined;
    if (code === 'slot_taken') {
      return html(page('Slot taken', `<p class="big">😕</p><h1>That slot just went</h1>
        <p class="meta">Someone confirmed a moment before you. We'll let you know next time.</p>`), 410);
    }
    return html(page('No longer available', `<p class="big">⌛</p><h1>This offer has closed</h1>
      <p class="meta">Message them in the app if you'd still like a slot.</p>`), 410);
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
  // Signed in, so the operator is the rate-limit bucket rather than the
  // address. This one is about storage that never expires: sixty an hour is a
  // long afternoon of uploading a portfolio, and it caps what a stolen session
  // can leave behind in the photo store.
  //
  // Worth knowing what this limit now sits in front of. It was written when
  // the store was going to be R2, where an upload spent storage billed by the
  // gigabyte and nothing else. The store is Workers KV, whose free allowance
  // is 1 GB for the whole account and 1,000 writes a day for the whole
  // account, so an upload now spends a shared, finite, daily thing. This
  // number was deliberately not tightened for that, and the reasoning is
  // written out in full at the top of lib/photostore.ts: MAX_PHOTOS caps a
  // portfolio at five rows, which bounds the realistic daily total far below
  // what sixty an hour would allow, and a global counter would turn one busy
  // day into an upload outage for everybody at once.
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

  // Written once and never overwritten: newId() is unique per upload, and a
  // replacement photograph is a new key and a new row. The GET route below
  // leans on that to answer 304s without an etag of its own.
  const key = `w/${op.id}/${newId()}`;
  // The sniffed content type rides along in KV's metadata, which is the only
  // place to put it -- KV has no httpMetadata and no writeHttpMetadata, so the
  // GET route builds the headers by hand from exactly this. See
  // lib/photostore.ts.
  await putPhoto(env.PHOTOS, key, bytes, contentType);

  try {
    // `r2_key` is the column's name and there is no R2 bucket behind it; see
    // the note at the top of lib/photostore.ts for why it kept the name.
    const photo = await addPhoto(env, op.id, {
      r2_key: key,
      content_type: contentType,
      bytes: bytes.length,
      caption: str(form.get('caption')),
    });
    return json({ photo }, 201);
  } catch (e) {
    // The row is the record of truth. If it was refused, the value it points
    // at must not be left behind eating the account's 1 GB of KV for something
    // nobody can reach.
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
  /*
    WHERE THIS BUSINESS WORKS, as the three parts an address is made of.

    A schema.org LocalBusiness cannot produce a rich result without an
    `address`, and web/src/pages/PublicProfile.tsx emits a LocalBusiness node
    for this business — it has to, because React throws away the Worker's copy
    when it mounts over the rendered page. It had no address to give: `areas`
    is a list of neighbourhood names and nothing in this payload said which
    town or state they are in. So the metro is sent, resolved the same way
    lib/seo.ts resolves it for the server-rendered half — by where the majority
    of this business's round is — and the two halves of one URL can then say
    the same thing.

    No street line, here or there. These are vans; they have no premises, and
    this product has never been given an address for one.
  */
  const metro = await metroForOperator(env, row?.id ?? null);

  return json({
    ...profile,
    operator: { ...profile.operator, is_sample: isDemoOperator(row?.id ?? '') },
    photos,
    metro: {
      slug: metro.slug,
      name: metro.name,
      state: metro.state,
      country: metro.country,
      path: metroPath(metro),
    },
  }, 200, { 'cache-control': 'public, max-age=300' });
});

/**
 * Photo-store keys this route is allowed to hand to a stranger.
 *
 * One namespace holds two completely different kinds of picture. `w/` is an
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
 *
 * `m/` is a photograph sent inside a conversation, added with migration 0051,
 * and it is absent from this list on purpose — which is the allowlist doing
 * exactly the job it was made an allowlist for. These are the same kind of
 * picture `j/` is, often literally the same picture: somebody's kitchen, their
 * car, the inside of their garage, sent to one business by one customer. Every
 * read of one goes through readMessagePhoto in lib/chat.ts, which proves the
 * caller is on that conversation before it hands over a byte. A new prefix
 * arriving here private-by-default, rather than public until somebody
 * remembers to block it, is the whole reason this is a list of what may be
 * served instead of a list of what may not.
 */
const PUBLIC_PHOTO_PREFIXES = ['w/', 'a/'];

route('GET', '/api/public/photo/:key', async ({ env, params, req }) => {
  if (!env.PHOTOS) throw notFound();
  // The key arrives URL-encoded because it contains slashes.
  const key = decodeURIComponent(params.key ?? '');
  // Checked before the store is touched, and answering exactly as a missing
  // key does: a private key must not be distinguishable from a wrong one.
  if (!PUBLIC_PHOTO_PREFIXES.some((p) => key.startsWith(p))) throw notFound();
  const photo = await getPhoto(env.PHOTOS, key);
  if (!photo) throw notFound();

  const headers = new Headers();
  // BUILT BY HAND, BECAUSE THERE IS NOTHING TO BUILD IT FOR US. R2 had
  // `writeHttpMetadata`, which stamped the stored content type onto a Headers
  // for you; KV has no equivalent, so the header is set here from the one
  // thing putPhoto recorded. That is the type images.ts sniffed out of the
  // bytes and never the one the uploader declared -- which matters most on
  // this route of all of them, because this is the one with no session in
  // front of it.
  //
  // No stored type means the entry was written by something other than
  // putPhoto, and the honest answer is that we do not know what these bytes
  // are. It is served as opaque bytes rather than guessed at; combined with
  // the nosniff that withSecurityHeaders puts on every response, a browser
  // will download it and will not run it.
  headers.set('content-type', photo.contentType ?? 'application/octet-stream');

  // AN ETAG DERIVED FROM THE KEY, NOT FROM THE BYTES.
  //
  // R2 gave every object an `httpEtag` and this route answered conditional
  // requests with it. KV has nothing of the kind, and the choice was between
  // dropping 304s -- which would re-send every portfolio photograph on every
  // revalidation, on a page whose entire purpose is photographs -- or deriving
  // one. Deriving one is sound here for a reason specific to this store: keys
  // are write-once. Both writers mint `${prefix}/${id}/${newId()}` and never
  // put to an existing key, a replacement photograph is a new key and a new
  // row, and a deleted key is gone rather than reused. The bytes at a given
  // key therefore cannot change, which is the same promise the immutable
  // cache-control below has always made. If a writer that overwrites a key is
  // ever added, this line becomes a stale-content bug and must go with it.
  //
  // encodeURIComponent and not the raw key: the key is a path segment a
  // stranger controls, and a quote or a newline in it would either corrupt the
  // header or throw. The encoding is injective, so two different keys cannot
  // collide on one etag.
  const etag = `"${encodeURIComponent(key)}"`;
  headers.set('etag', etag);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  if (req.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(photo.body, { headers });
});

// The map the landing page draws. Public on purpose: no sign-in, no postcode.
// Looking is free and always will be — an account is asked for at the moment
// somebody books and not one step earlier.
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
// number. A guest's identity on these routes is the secret in their link,
// which is also how they get back to their booking — no sign-in is asked for
// here even though customers have accounts since migration 0037, because
// answering a business about a booking you already have is not the moment to
// stop somebody and ask who they are.
// ---------------------------------------------------------------------------

/**
 * Everything the guest page needs, without leaking anything the operator owns.
 *
 * WHY THE BOOKING NOW CARRIES ITS ORDER, WHICH IS THE WHOLE OF A REAL BUG.
 *
 * For most of this product's life the booking object here said what was bought
 * — the service, the hour, the address, the price — and nothing whatever about
 * whether it had been paid for. The only order field on it was
 * `order_item_id`, put there so the photo strip could be hung off the right
 * line, and an order ITEM is not something a charge can be opened against: the
 * pay route takes an ORDER id, and nothing in the browser could turn one into
 * the other.
 *
 * What that cost is a dead end, and it is the ordinary one rather than an
 * exotic one. The checkout holds the appointments and writes the order BEFORE
 * it asks for a card — deliberately, so a customer who is interrupted has not
 * lost the slot — and Book.tsx's pay step promises in as many words that "your
 * booking is held under your conversation and you can pay from there". Somebody
 * who closed the tab at that step, and there are always some, came back to this
 * page and found the confirmation card, the start code, the conversation, and
 * no way at all to finish paying. The booking then sat unpaid for ever: the
 * operator's calendar said a job was happening, the customer believed they had
 * bought something, and no money had moved.
 *
 * The fix is two joins, because the order id and the order's state were always
 * one hop from the sub-select that was already being run for `order_item_id`.
 *
 * WHY `paid` AND `due` RATHER THAN AN AMOUNT OUTSTANDING. The figure that will
 * actually be charged is worked out in src/lib/checkout.ts, from the lines that
 * are still happening, and it is written back onto the order every time the
 * intent is opened or moved. Deriving a second "amount still owed" here would
 * be that same money computed twice in two files, and the copy in this one
 * would be the one that had never heard of a cancelled line. So this sends the
 * two things the page cannot work out for itself — the id to charge against,
 * and whether there is anything left to charge — and the amount stays where it
 * is computed once. `total` below is not arithmetic: it is `orders.total_cents`
 * formatted, the same stored figure a support person is read back when somebody
 * asks what they were charged.
 *
 * WHY BOTH FLAGS, GIVEN ONE LOOKS LIKE THE OTHER'S OPPOSITE. They are not.
 * `paid` answers "has the money arrived", which is what the page says out loud.
 * `due` answers "should this page put a card form in front of them", which is a
 * narrower question: a booking cancelled before anybody paid for it is neither
 * paid nor due, and a page carrying only one of these flags gets that case
 * wrong in one direction or the other — either claiming a cancelled booking was
 * paid for, or asking somebody to pay for a job that is not going to happen.
 *
 * NULL IS A NORMAL ANSWER AND MUST STAY ONE. A handful of bookings predate
 * orders entirely — the older single-slot claims the comment below has always
 * mentioned — and they have no order row to join to. That is not an error and
 * not a missing field: `order` is null, the page draws no card form and says
 * nothing new about the money, exactly as it did before this existed.
 */
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
      // The order_item sub-select is the one that was already here, kept
      // exactly as it was — LIMIT 1 and all — and merely joined to rather than
      // selected, so `order_item_id` is still the same line it has always
      // been. The order hangs off that line, which is the only reason this was
      // ever one hop away.
      `SELECT a.starts_at, a.ends_at, a.address_line, a.price_cents,
              a.status AS appointment_status, s.name AS service_name,
              oi.id AS order_item_id, oi.cancelled_at AS item_cancelled_at,
              o.id AS order_id, o.status AS order_status, o.paid_at AS order_paid_at,
              o.total_cents AS order_total_cents, o.currency AS order_currency
         FROM appointments a
         LEFT JOIN services s ON s.id = a.service_id
         LEFT JOIN order_items oi
                ON oi.id = (SELECT x.id FROM order_items x
                             WHERE x.appointment_id = a.id LIMIT 1)
         LEFT JOIN orders o ON o.id = oi.order_id
        WHERE a.id = ? AND a.operator_id = ?`,
    ).bind(thread.appointment_id, thread.operator_id).first<any>();
    if (a) {
      // `paid_at` and nothing else, because that is the column the rest of this
      // codebase treats as the line between claimed and paid — migration 0040
      // says so where it adds it, and markPaid is the only thing that writes
      // it. An intent that is still going through has no paid_at, which is the
      // honest answer: money a bank has not answered on is not money in.
      const paid = a.order_paid_at != null;
      booking = {
        service_name: a.service_name ?? 'Booking',
        starts_at: a.starts_at, ends_at: a.ends_at,
        address_line: a.address_line ?? null,
        // So the customer's page can hang the photo strip off the right
        // booking. Null for the older single-slot claims that predate orders.
        order_item_id: a.order_item_id ?? null,
        price: formatMoney(a.price_cents ?? 0, op?.currency ?? 'USD', locale),
        order: a.order_id == null ? null : {
          id: a.order_id,
          // The order's own currency, not the operator's. An order carries one
          // currency by construction and it is the one the charge is in; using
          // the business's would print the right number with the wrong symbol
          // on any booking taken before a business changed it.
          total: formatMoney(a.order_total_cents ?? 0,
            a.order_currency ?? op?.currency ?? 'USD', locale),
          paid,
          // THREE WAYS A BOOKING STOPS BEING WORTH ASKING MONEY FOR, and all
          // three have to be checked here because they are written by
          // different paths and none of them implies the others.
          //
          //   The order itself is cancelled or failed — bypass.ts writes the
          //   first when every line on it has gone, orders.ts the second when
          //   a placement could not be completed.
          //
          //   This particular LINE is cancelled while the rest of the basket
          //   stands, which is what a single job being called off looks like
          //   on an order holding two.
          //
          //   The APPOINTMENT is cancelled and the line is not. That is not a
          //   hypothetical: the Cancel button on the operator's own schedule
          //   (POST /api/appointments/:id/cancel) cancels the appointment and
          //   deliberately does not touch order_items, so a booking called off
          //   from the screen an operator actually uses would otherwise still
          //   be offering the customer a card form for it.
          due: !paid
            && a.order_status !== 'cancelled' && a.order_status !== 'failed'
            && a.item_cancelled_at == null
            && a.appointment_status !== 'cancelled',
        },
      };
    }
  }

  // customer_account_id IS DELIBERATELY NOT IN THIS PAYLOAD, which is why the
  // row is taken apart rather than spread whole.
  //
  // Migration 0052 put the column on the thread and the spread below would
  // have published it to every reader of this route, including the signed-out
  // one on a link. It is not a secret — holding an account id proves nothing
  // and grants nothing, and no comparison anywhere in this Worker trusts a
  // value that came from a request — but there is no screen that shows it and
  // nothing in web/ reads it, and a field nothing reads is a field that only
  // travels. It would sit in every browser cache and every proxy log naming
  // which account a conversation belongs to, for no purpose at all. Same
  // reasoning as OPERATOR_PRIVATE further down this file.
  const { customer_account_id: _account, ...rest } = thread;

  return {
    ...rest,
    /**
     * WHETHER THIS CONVERSATION IS REACHABLE FROM AN ACCOUNT — a boolean, not
     * the account id, and it exists for exactly one sentence on one page.
     *
     * The "keep this link" notice used to state flatly that the link was the
     * only way to this conversation. Since migration 0052 that is true for
     * some readers and false for others, and a page cannot say either
     * confidently without being told: the browser holding a token has no way
     * to know whether the customer who booked ever proved an email address,
     * and the two halves of that need opposite advice. A guest with no account
     * genuinely must keep the link or lose the conversation; somebody with one
     * should be told they can sign in instead, because otherwise they spend an
     * evening hunting for a link they do not need.
     *
     * A BOOLEAN AND NEVER THE ID. See the note above on why the id itself is
     * stripped. This answers the only question a page has, adds nothing a
     * reader could use, and tells a link-holder who is not the customer
     * nothing they could not already infer — booking requires an account, and
     * whoever holds the link already has the whole conversation.
     *
     * It costs no extra read: the column is on the row this function already
     * fetched.
     */
    on_account: thread.customer_account_id != null,
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

  /*
    THE ONE MOMENT A BOOKING-LESS ENQUIRY CAN BE PUT ON AN ACCOUNT.

    An enquiry has no order, no appointment and no client row — that is what
    makes it an enquiry — so there is nothing to join it to an account
    afterwards and there never will be. Migration 0052 spells the join out and
    all three of its hops start at a booking. Whoever asked "does your van fit
    down my alley" is, to every query in this codebase, a first name and a
    secret in a link.

    So it is captured HERE or it is not captured at all, and the choice was
    between two honest answers rather than between a good one and a bad one:

      READ THE SESSION IF THERE IS ONE. Somebody who happens to be signed in
      when they send the message gets the conversation on their account, and
      can find it again from /account with no link. It costs one indexed read
      on a route that already spends a Turnstile verification, three rate-limit
      writes and an operator lookup.

      LEAVE EVERY ENQUIRY TOKEN-ONLY. Simpler, and it abandons the people the
      feature is for: the signed-in customer who messaged three businesses
      about the same job and closed the tabs.

    The first, plainly. And NOTHING IS INFERRED BEYOND IT — no matching on a
    name, an address or an IP, and no attempt to reconcile it later when the
    same person signs in. claimGuestHistory can rescue a booking made as a
    guest because the ORDER carries the email address that was proved; an
    enquiry carries no address at all, so the only way to claim one later would
    be to guess whose it was. Guessing here hands a stranger's conversation to
    whoever guessed closest, so an anonymous enquiry stays reachable on its
    link and only on its link — permanently, not until something better comes
    along — and Enquiry.tsx says so before the message is sent rather than
    after.

    WHY THIS DOES NOT WEAKEN THE ROUTE. No sign-in is asked for and none is
    required: a null here is the ordinary outcome and changes nothing about
    what gets written. The session is read, never trusted for anything else —
    the name still comes out of the form and through the redactor, the
    challenge still has to be solved, and the rate limits are still bucketed on
    the address rather than on the account.
  */
  const enquirer = await currentCustomer(req, env);

  const { thread, token } = await startThread(env, {
    operator_id: op.id,
    gap_id: str(b.gap_id),
    customer_account_id: enquirer?.id ?? null,
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

route('GET', '/api/public/threads/:token', async ({ env, params, ref }) => {
  // The guest page polls this every 15 seconds (GuestThread.tsx), so an open
  // tab spends 20 of these per five minutes. The ceiling is seven times that
  // on purpose: two tabs, a reconnect and a few manual refreshes must all fit
  // under it, because the person tripping this is the customer whose booking
  // it is.
  await enforceRateLimit(env, `thread-read:${params.token ?? ''}`, 150, 300);
  const thread = await threadByToken(env, ref);
  const view = await guestView(env, thread);
  const messages = await listMessages(env, view.id);
  await markThreadRead(env, 'guest', { token: ref });
  return json({ thread: view, messages }, 200, { 'cache-control': 'no-store' });
});

route('POST', '/api/public/threads/:token/messages', async ({ req, env, params, ref }) => {
  // Bucketed on the token rather than the IP: this route asks for no sign-in,
  // the link is who they are, and a family on one connection must not share a
  // budget. Thirty a minute is roughly one message every two seconds — well
  // past how fast anybody types and slow enough that a script cannot fill an
  // operator's inbox.
  await enforceRateLimit(env, `guest-msg:${params.token ?? ''}`, 30, 60);
  const b = await body(req);
  const message = await postAsGuest(env, ref, String(b.body ?? ''));
  return json({ message }, 201);
});

/**
 * The operator's inbox: one page of it, unanswered questions first.
 *
 * WHAT THIS ROUTE WAS. `?unread=1` or nothing, a hard fifty rows, and no way
 * to ask for the fifty-first. That is the whole of it, and for a business with
 * a handful of conversations it was enough. The owner's description of why it
 * stopped being enough — "business will have more messages by customers asking
 * questions" — names three separate failures, and lib/chat.ts sets them out
 * above listThreads: no way past the last row, no way to find one row, and an
 * ordering under which an unanswered question sinks for every message anybody
 * else sends.
 *
 * `cursor`/`limit` page it, `unread=1` and `booked=1` and `status=` narrow it,
 * `q=` searches the name, the subject and what was said. Every one of those is
 * a filter inside a statement already scoped by `operator_id = ?`; none of
 * them can widen it, and the search in particular reads message bodies only
 * through an EXISTS correlated to a thread this operator owns.
 *
 * `unread` stays beside the rows and is deliberately NOT derived from them:
 * it is how many conversations are waiting in total, which is a different
 * number from how many are on this page and is the one the header prints.
 */
route('GET', '/api/threads', async ({ req, env, url }) => {
  const op = await requireOperator(req, env);
  const q = url.searchParams;
  const [page, unread] = await Promise.all([
    listThreads(env, op.id, {
      unreadOnly: q.get('unread') === '1',
      bookedOnly: q.get('booked') === '1',
      status: threadStatusFilter(q.get('status'), 'open'),
      q: q.get('q'),
      limit: int(q.get('limit')) ?? undefined,
      cursor: q.get('cursor'),
    }),
    unreadThreadCount(env, op.id),
  ]);
  return json({ threads: page.threads, next_cursor: page.next_cursor, unread });
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

/**
 * Closing a conversation, and opening it again.
 *
 * THE PRODUCER FOR A COLUMN THAT HAS HAD NONE SINCE 0011. threads.status has
 * existed, been CHECK-constrained, refused new messages through assertOpen,
 * been excluded from the offer fan-out by lib/rank.ts, drawn a notice in the
 * operator's inbox and had a sentence waiting for it on the customer's account
 * page — and nothing anywhere ever wrote it. Every row was 'open' for ever, so
 * an inbox could only grow: March's finished job sat between two live
 * conversations permanently, and the answer to "more messages by customers
 * asking questions" was to scroll past the ones already dealt with.
 *
 * ONE ROUTE FOR BOTH DIRECTIONS rather than /close and /reopen. It is one
 * decision with two values, the body carries which, and two routes would be
 * two authorisation checks and two chances for them to differ. The default is
 * `closed` because that is the button; `{"open": true}` is the way back.
 *
 * THE CUSTOMER HAS NO EQUIVALENT ROUTE AND IS NOT GETTING ONE — see
 * setThreadStatus in lib/chat.ts for why closing is the business's call about
 * its own queue. What the customer gets is honesty: their list keeps showing a
 * closed conversation, says on the row that the business has closed it, and
 * still opens it to read.
 *
 * Scoped by operator_id inside setThreadStatus, so a thread id copied out of
 * another business's inbox reports the same "not yours" a made-up one does and
 * changes nothing.
 */
route('POST', '/api/threads/:id/status', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  const thread = await setThreadStatus(
    env, op.id, params.id ?? '', b.open === true ? 'open' : 'closed',
  );
  return json({ thread });
});

// ---------------------------------------------------------------------------
// A photograph, inside the conversation
// ---------------------------------------------------------------------------
//
// Four routes: one upload door per side, one serve door per side. The split
// between this and the proof gallery further down is the product's, not an
// accident of where the code went: routine photographs are shared here, where
// they are part of what was said, and the staged before/during/after gallery
// on the booking stays what it is, which is the record a claim is settled
// from. lib/chat.ts has the long version.
//
// ON TURNSTILE, WHICH IS LIVE IN PRODUCTION AND IS DELIBERATELY NOT ON THESE.
//
// The guest upload is the only one of the four where the question even
// arises -- the other three are behind an operator session, and no
// session-authenticated route in this file has ever carried a challenge.
// It is not here for two reasons, and the first is the one that decides it.
//
// THE CHALLENGE WAS ALREADY SPENT TO GET THE LINK. Every route under
// /api/public/threads/:token is reachable only by holding a token minted by
// openEnquiry above, and openEnquiry calls requireTurnstile before it mints
// one. That is stated there in as many words: "a challenge here is a challenge
// on all of them, and none of those has to ask for one again mid-
// conversation." A guest photo upload is not a new door into the product, it
// is the thirtieth thing you can do once you are already through the one door
// that is challenged. Adding a second challenge here would not stop anybody
// who got past the first, and it would stop the customer standing in their own
// kitchen on a weak signal trying to show somebody a leak -- which is the one
// person this feature exists for.
//
// THE SECOND REASON IS MECHANICAL AND WOULD MATTER EVEN IF THE FIRST DID NOT.
// requireTurnstile takes its token from tokenFromBody, a parsed JSON body.
// These two routes are multipart, because they carry a file. Wiring a
// challenge in would mean a second way of finding the token -- a form field --
// and therefore two code paths through the check, which is how one of them
// ends up being the one that does not really check.
//
// What IS on the guest door instead is the same shape every other guest route
// carries: guardGuestLink in handle() below counts wrong tokens per address
// and locks out a walk (a per-token limit cannot see one, because every guess
// carries a different token -- see lib/guestlink.ts), a per-token volume
// ceiling here, a declared-length refusal before the body is read, and the
// per-conversation daily ceiling on the rows themselves inside lib/chat.ts.

route('POST', '/api/threads/:id/photos', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  // Sixty an hour, which is the number the portfolio upload uses and for the
  // same reason: it is set where a busy real day fits comfortably under it and
  // a script does not. One upload is one write against the 1,000 a day the
  // whole account gets from Workers KV, and what actually bounds the daily
  // total is not this -- it is the per-conversation ceiling enforced on the
  // rows in lib/chat.ts, which is the argument lib/photostore.ts makes about
  // why there is no account-wide counter sitting on top of any of these.
  await enforceRateLimit(env, `photo-msg:${op.id}`, 60, 3600);
  // Refused on the caller's own declared length, before the multipart body is
  // read at all. It proves nothing -- cleanImageUpload measures the real bytes
  // -- but a request announcing forty megabytes is usually telling the truth.
  assertBodyWithin(req, MAX_MESSAGE_PHOTO_BYTES);
  const form = await req.formData();
  const message = await postPhotoAsOperator(env, op.id, params.id ?? '', {
    file: form.get('file'),
    // The caption is an ordinary message body: same length cap, same
    // contact-detail filter, same column. It may be empty, because a
    // photograph sent on its own is a complete thing to say.
    body: str(form.get('body')),
    width: int(form.get('width')), height: int(form.get('height')),
  });
  return json({ message }, 201);
});

route('POST', '/api/public/threads/:token/photos', async ({ req, env, params, ref }) => {
  // Bucketed on the token and not the IP, the same way the guest message route
  // is: this asks for no sign-in, the link is who they are, and a family
  // behind one address must not share one budget. Twenty an hour is well past
  // documenting one problem from several angles, and it is deliberately below
  // the operator's sixty -- an operator's threads are many conversations and a
  // guest's token is exactly one.
  await enforceRateLimit(env, `photo-msg-guest:${params.token ?? ''}`, 20, 3600);
  assertBodyWithin(req, MAX_MESSAGE_PHOTO_BYTES);
  const form = await req.formData();
  const message = await postPhotoAsGuest(env, ref, {
    file: form.get('file'),
    body: str(form.get('body')),
    width: int(form.get('width')), height: int(form.get('height')),
  });
  return json({ message }, 201);
});

// Serving one. Authorised on every single read, both sides, exactly as the
// proof photos are -- there is no public URL for one of these and there must
// never be one. readMessagePhoto answers "no such photo" for an id belonging
// to somebody else's conversation, in the same words a made-up id gets, so
// neither door can be walked to count other people's pictures.
route('GET', '/api/message-photo/:id', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  return readMessagePhoto(env, { operator_id: op.id }, params.id!);
});

route('GET', '/api/public/threads/:token/message-photo/:id',
  async ({ env, params, ref }) => readMessagePhoto(env, { token: ref }, params.id!));

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

route('GET', '/api/public/threads/:token/parts', async ({ env, params, ref }) => {
  return json(await quotesForGuest(env, ref));
});

route('POST', '/api/public/threads/:token/parts/:id', async ({ req, env, params, ref }) => {
  const b = await body(req);
  const decision = str(b.decision);
  if (decision !== 'approved' && decision !== 'declined') {
    throw badRequest('Approve it or decline it.', 'bad_decision');
  }
  return json({ quote: await decideQuote(env, ref, params.id!, decision) });
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
route('GET', '/api/public/threads/:token/refund/:id', async ({ env, params, ref }) => {
  return json({ refund: await quoteRefund(env, ref, params.id!) });
});

route('POST', '/api/public/threads/:token/cancel/:id', async ({ req, env, params, ref }) => {
  const b = await body(req);
  return json(await cancelByCustomer(env, ref, params.id!, str(b.reason)));
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
  /*
    A CEILING BEFORE THE BODY IS READ, NOT AFTER.

    This route is unauthenticated until the signature is checked, and the
    signature cannot be checked without the bytes — which is exactly the right
    order and also means the endpoint was willing to buffer a body of any size
    from any caller on the internet before deciding it was a forgery. A Worker
    that reads a hundred megabytes into memory to then throw it away is a way
    of spending this deployment's CPU and memory limits that costs the sender
    nothing but bandwidth, and it needs no secret at all.

    256 KB, which is not a tight fit. A Stripe event is a few kilobytes; the
    largest anything here reads is a payment intent with an expanded charge
    on it, and that is still well inside one. Anything an order of magnitude
    past that is not an event this switch has an arm for.

    Content-Length is the caller's own claim and proves nothing — the same
    point assertBodyWithin makes about photographs — so this is not a limit, it
    is refusing the ones that announce themselves. A caller who lies downwards
    is not stopped here and gains nothing by it: the signature still has to
    verify, and a body that does not match the header it was signed with does
    not. The same sentence as a malformed payload gets, because a caller who
    cannot produce a signature must not be able to tell the two refusals apart.
  */
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > 256 * 1024) {
    throw badRequest('That is not a Stripe event.', 'bad_event');
  }

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

  /*
    ONCE, AND ONLY ONCE — because a verified signature does not mean a first
    delivery.

    verifyStripeSignature accepts any timestamp inside a 300-second tolerance,
    which is correct and is also the exact size of the window in which a signed
    event is a replayable bearer token. One captured copy of a real event — out
    of a proxy log, a debugging dump, a paste in a support thread — can be
    re-POSTed unchanged for five minutes and every check above it passes,
    because everything above it is asking whether Stripe sent this, not whether
    we have already acted on it. Stripe also re-sends events on its own: any
    delivery that does not answer 2xx is retried, so a handler that did all its
    work and then failed on the way out arrives again as a matter of routine.

    THE ROUTE LOOKED IDEMPOTENT AND ONLY ONE ARM OF IT WAS. markPaid is written
    to survive a second delivery, and it is the arm anybody checking would have
    looked at first. The other two do not survive one: markPaymentFailed writes
    a failure against an order, so a replay lands a stale decline on a booking
    the customer has since paid for with another card, and syncConnectAccount
    overwrites an operator's cached charges_enabled and payouts_enabled from
    the event body — so a five-minute-old "payouts disabled" replayed over the
    newer "payouts enabled" leaves a business Stripe is perfectly happy with
    unpayable, silently, because those two flags are exactly what the payout
    step reads and nothing else contradicts them.

    The primary key does the work rather than a SELECT then an INSERT: two
    concurrent deliveries of the same event both read "not seen" in the gap
    between the two statements, and INSERT OR IGNORE has no gap. Nought rows
    changed means somebody else has this one.

    200 AND NOT AN ERROR on the duplicate. Anything other than a 2xx makes
    Stripe retry for days over an event that was received and handled
    perfectly well the first time, which is how a dedupe check turns into the
    retry storm it was added to stop.

    An event with no id cannot be deduplicated and is processed anyway. Stripe
    always sends one; if a signed payload somehow lacks it, dropping a real
    event is the worse of the two failures, and keying an empty string would be
    worse still — the first id-less event would then dedupe every later one
    against itself.

    THIS TABLE IS SWEPT, which it was not when it was added and which this
    note used to say was still outstanding. Left alone it only grows: one row
    per event this deployment has ever been sent, kept forever to answer a
    question that stops being askable days after the event, once Stripe's
    retries are finished. `sweepStripeEvents` in lib/retention.ts is the
    DELETE on received_at and it runs from the cron with the other passes.

    The age it sweeps on has a FLOOR under it rather than being as small as it
    could be, and that floor is this route's problem rather than that file's:
    deleting a row while Stripe may still retry the event makes the retry look
    like a first delivery and re-runs everything below. See STRIPE_EVENT_DAYS,
    which is written against the 300-second signature tolerance above and
    against a retry schedule measured in days. Not personal data — an opaque
    event id and a timestamp — so it is housekeeping in the sweeps, it is in no
    erasure path, and it is not one of the published windows in RETENTION.
  */
  const eventId = String(event.id ?? '');
  if (eventId) {
    const seen = await env.DB.prepare(
      `INSERT OR IGNORE INTO stripe_events (id, received_at) VALUES (?,?)`,
    ).bind(eventId, now()).run();
    if ((seen.meta?.changes ?? 0) === 0) {
      // The id and nothing else. It is Stripe's own opaque identifier, so it
      // is both safe to write down and the only thing that makes this line
      // actionable — it is what somebody pastes into the dashboard to see what
      // the event was.
      console.log('stripe webhook already handled', eventId);
      return json({ received: true });
    }
  }

  const obj = (event as any)?.data?.object ?? {};

  switch (event.type) {
    // THE ONE THAT MATTERS. The money arrived. Confirming the order here and
    // not in the browser is deliberate: a customer who pays and closes the tab
    // in the same second must still end up with a confirmed booking, and an
    // operator must never be left holding an appointment marked unpaid for
    // money that was taken.
    case 'payment_intent.succeeded': {
      const intentId = String(obj.id ?? '');
      // NOT String(). Stripe sends latest_charge as a bare 'ch_...' normally
      // and as the whole expanded charge object whenever anything asks it to —
      // an account default, a dashboard replay, a version change — and
      // String() turns that into the literal text "[object Object]". That text
      // then goes into orders.charge_id, reaches createTransfer as
      // source_transaction, and Stripe rejects it: the one field whose job is
      // to stop a business being paid out of a charge that has not settled.
      await markPaid(env, intentId, chargeIdOf(obj.latest_charge));
      // AND NOTHING IS PAID OUT HERE, which is the change worth explaining.
      // This used to call settleOrder the moment the card cleared, so every
      // business had its share days before the job — and a customer cancelling
      // the next morning for a full refund was refunded out of the platform's
      // own money, because a Transfer that has landed in somebody's bank is not
      // something this product can take back. The money now stays in the
      // platform balance until each job is behind it and its cancellation
      // window has closed, and the cron's 'pay for finished work' step is what
      // moves it. See settleDueWork in lib/checkout.ts.
      break;
    }

    // Recorded, and the claim is NOT thrown away. A declined card is somebody
    // trying again in thirty seconds with a different one, not somebody who
    // has changed their mind about the appointment.
    case 'payment_intent.payment_failed':
    case 'payment_intent.canceled':
      await markPaymentFailed(env, String(obj.id ?? ''), String(obj.status ?? event.type));
      break;

    // A business finished onboarding, or Stripe changed its mind about one.
    // The cached flags on the operator row are refreshed from the event rather
    // than polled, so somebody who finishes at midnight can be paid at 00:01.
    case 'account.updated':
      await syncConnectAccount(env, String(obj.id ?? ''), {
        charges_enabled: !!obj.charges_enabled,
        payouts_enabled: !!obj.payouts_enabled,
      });
      break;

    default:
      // Everything else is acknowledged and ignored. Returning anything but a
      // 200 makes Stripe retry for days over an event nothing reads.
      break;
  }

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
route('POST', '/api/public/threads/:token/no-show/:id', async ({ req, env, params, ref }) => {
  const b = await body(req);
  const thread = await threadByToken(env, ref);
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
  // answers a yes/no question about any address anybody cares to type. A walk
  // over a list turns it into "has this person been reported for missing
  // appointments", which is a fact about them and not about us. The checkout
  // asks once, when the email field loses focus.
  //
  // It asks about the ADDRESS now rather than the number, because that is what
  // standing hangs on since 0038. A probe against the old parameter would have
  // quietly answered "not blocked" for everybody, forever.
  await enforceRateLimit(env, `standing:${clientIp(req)}`, 30, 300);
  const email = normaliseLoginEmail(url.searchParams.get('email'));
  if (!email) return json({ blocked: false, message: null });
  // ONLY ABOUT AN ADDRESS THE CALLER HAS PROVED.
  //
  // This answered for ANY address anybody typed, which turned a courtesy into
  // a lookup service: walk a list of mailboxes and learn which of those named
  // people have been reported for missing appointments. That is a fact about
  // them, published by us, to a stranger. The sign-in route two screens away
  // deliberately answers identically whether an account exists; this one gave
  // the game away for free.
  //
  // A caller who has not signed in now gets the same answer a clean address
  // gets. Nothing is weakened: the real gate is customerStanding inside the
  // checkout and inside createInstantRequest, both of which run against the
  // account the person actually proved.
  const me = await currentCustomer(req, env);
  const standing = await provedCustomerStanding(env, email, me?.login_email ?? null);
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
  //
  // The highest of the three photo ceilings, and the one worth checking
  // against the store underneath: the photo store is a Workers KV namespace
  // whose free allowance is 1,000 writes a day for the whole account, and one
  // upload is one write. What keeps this number honest is MAX_PER_ITEM in
  // lib/proof.ts — twenty-four photographs per booking, enforced on the row —
  // so the real daily total is bounded by how many jobs happened rather than
  // by this. lib/photostore.ts has the full argument for why there is no
  // account-wide counter on top of these.
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

route('GET', '/api/public/threads/:token/proof/:id', async ({ env, params, ref }) => {
  return json(await proofSummary(env, { token: ref }, params.id!));
});

route('POST', '/api/public/threads/:token/proof/:id', async ({ req, env, params, ref }) => {
  // The customer's own photos of the work, from a phone, on their link. Forty
  // an hour is well past documenting one job and stops a leaked link being
  // used to fill a photo store somebody else is accountable for. Nobody pays
  // for it in money any more — it is Workers KV on the free allowance — which
  // makes it worse rather than better: what a leaked link can spend is the
  // 1 GB the whole account gets and the 1,000 writes a day it shares with
  // every other operator, and none of that can be topped up.
  await enforceRateLimit(env, `photo-guest:${params.token!}`, 40, 3600);
  assertBodyWithin(req, MAX_PROOF_BYTES);
  const form = await req.formData();
  const stage = form.get('stage');
  if (!isStage(stage)) throw badRequest('Say whether this is before, during or after.');
  const photo = await addJobPhoto(env, { token: ref }, {
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

route('GET', '/api/public/threads/:token/photo/:id', async ({ env, params, ref }) => {
  return readJobPhoto(env, { token: ref }, params.id!);
});

route('DELETE', '/api/proof/:id', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  await deleteJobPhoto(env, { operator_id: op.id }, params.id!);
  return json({ ok: true });
});

route('DELETE', '/api/public/threads/:token/photo/:id', async ({ env, params, ref }) => {
  await deleteJobPhoto(env, { token: ref }, params.id!);
  return json({ ok: true });
});

// ---------------------------------------------------------------------------
// Two-sided arrival, and settling what was frozen
// ---------------------------------------------------------------------------

route('POST', '/api/public/threads/:token/arrived/:id', async ({ env, params, ref }) => {
  // The customer's half of arrival. Never required to start the job -- a phone
  // left indoors must not be able to strand an appointment -- but it is what
  // turns one person's claim that they were there into a fact.
  return json(await confirmArrival(env, ref, params.id!));
});

route('GET', '/api/public/threads/:token/pending', async ({ env, params, ref }) => {
  // The one question, if there is one waiting: did they do the work anyway?
  return json({ question: await pendingQuestion(env, ref) });
});

route('POST', '/api/public/threads/:token/answer/:id', async ({ req, env, params, ref }) => {
  const b = await body(req);
  const answer = str(b.answer);
  if (answer !== 'done' && answer !== 'not_done') {
    throw badRequest('Tell us whether the work happened.', 'bad_answer');
  }
  const settled = await answerWork(env, ref, params.id!, answer);

  // The answer is what unfreezes the money, so the refund goes out here rather
  // than waiting up to a quarter of an hour for the sweep to notice. Somebody
  // who has just told us their van never turned up should not then watch a
  // screen that says they are owed three hundred dollars do nothing until the
  // next cron tick.
  //
  // Never allowed to fail the request, and this is the important half. The
  // answer is already committed and cannot be given again — answerWork refuses
  // a second one — so a 500 raised by Stripe here would tell the customer
  // their answer did not register when it did, and leave them with no way to
  // send it. The failure is written onto the row instead and the sweep that
  // runs every fifteen minutes picks it up.
  if (settled.settlement === 'released' && settled.refund_cents > 0) {
    try {
      await refundItem(env, params.id!);
    } catch (err) {
      console.error('refund on answer failed', params.id, (err as Error).message);
    }
  }

  return json(settled);
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
      // Validated inside saveVehicle rather than here: this string ends up
      // drawn on a public map, and the one place that decides what is a real
      // kind should be the one place that writes it.
      kind: str(b.kind) as never,
    }),
  });
});

/**
 * The list of vehicle shapes, served rather than compiled into the bundle.
 *
 * Same rule as /api/public/metros: the Worker holds the list, the browser
 * reads it. The operator's form and the labels beside it are then built from
 * whatever the Worker actually accepts, so adding a shape is one edit in
 * src/lib/vehicles.ts and a redeploy — not an edit there plus a matching edit
 * in a form that will be forgotten and drift.
 */
route('GET', '/api/public/vehicle-kinds', async () =>
  json({ kinds: VEHICLE_KINDS }, 200, {
    // It changes when the code changes, which is when the bundle changes.
    'cache-control': 'public, max-age=3600, s-maxage=3600',
  }));

route('POST', '/api/bookings/:id/code', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  return json(await verifyStartCode(env, op.id, params.id!, str(b.code) ?? ''));
});

route('GET', '/api/public/threads/:token/code', async ({ env, params, ref }) => {
  // The customer's copy, plus the van to look for. Withheld once used.
  return json({ job: await jobCodeForGuest(env, ref) });
});

route('POST', '/api/public/threads/:token/vehicle/:id', async ({ req, env, params, ref }) => {
  const b = await body(req);
  await reportVehicle(env, ref, params.id!, str(b.note));
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

route('GET', '/api/public/threads/:token/reviewable', async ({ env, params, ref }) => {
  return json({ bookings: await reviewableFor(env, ref) });
});

route('POST', '/api/public/threads/:token/review', async ({ req, env, params, ref }) => {
  // A review is public and permanent, and the rules about who may leave one
  // live in leaveReview. This is only the volume ceiling: ten an hour is more
  // than a customer with several jobs on one link will ever write.
  await enforceRateLimit(env, `review:${params.token!}`, 10, 3600);
  const b = await body(req);
  return json({
    review: await leaveReview(env, ref, {
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

  // `r2_key` names a key in the KV photo store, not an R2 object; see the top
  // of lib/photostore.ts for why the column kept the name.
  const stored = await getPhoto(env.PHOTOS, photo.r2_key);
  if (!stored) throw notFound('No such photo.');
  return new Response(stored.body, {
    headers: {
      // The row's own content_type, exactly as before. It is the same sniffed
      // value putPhoto stored in the KV metadata -- both are written from the
      // one cleanImageUpload result -- and this route already holds the row,
      // so there is no reason to prefer the copy that travelled with the
      // bytes. Neither one is anything the uploader declared.
      'content-type': photo.content_type ?? 'image/jpeg',
      'cache-control': 'public, max-age=86400',
    },
  });
});

route('POST', '/api/public/threads/:token/review-photo/:id', async ({ req, env, params, ref }) => {
  const b = await body(req);
  await releasePhoto(env, ref, params.id!, b.public !== false);
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
/**
 * THE DOORSTEP IS NOT HANDED OUT BEFORE SOMEBODY HAS TAKEN THE JOB.
 *
 * This used to mask the number and the mailbox and leave the street line, the
 * postcode and the coordinates untouched on a request NOBODY HAS ACCEPTED --
 * so every operator who happened to be switched on received a stranger's exact
 * address for a job they were about to decline. The release model that governs
 * every other doorstep in this product did not apply here at all, because a
 * pending request has no order item and therefore no address_released_at.
 *
 * The rule now lives in lib/online.ts beside the request itself, so a second
 * route returning one cannot forget it.
 */
const maskRequest = maskInstantRequest;

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
  // AN ACCOUNT, FOR THE SAME REASON THE CHECKOUT NEEDS ONE. An accepted
  // instant request becomes an appointment: somebody is driving to a house at
  // an agreed price, which is a booking whatever the route is called. Leaving
  // this door open would have made "an account is needed to book" true of one
  // path and false of the other, and the number typed into the form would once
  // again be the way past a suspension. The number used below is the account's.
  const { account, cookie } = await checkoutAccount(req, env, b);
  const made = await createInstantRequest(env, {
    operator_id: str(b.operator_id) ?? '',
    service_id: str(b.service_id),
    guest_name: str(b.guest_name) ?? account.first_name ?? '',
    phone: account.phone_e164 ?? '',
    login_email: account.login_email ?? '',
    email: str(b.email),
    address_line: str(b.address_line),
    postcode: str(b.postcode),
    note: str(b.note),
    duration_seconds: int(b.duration_seconds) ?? undefined,
    price_cents: int(b.price_cents) ?? undefined,
  } as never);
  return json(made, 201, cookie ? { 'set-cookie': cookie } : {});
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

route('POST', '/api/public/threads/:token/estimates', async ({ req, env, params, ref }) => {
  // Each of these is a job of work for the business at the other end. Twenty
  // an hour is far past asking about a second vehicle or a rewritten
  // description, and stops one link generating a day's admin in a minute.
  await enforceRateLimit(env, `estimate-ask:${params.token!}`, 20, 3600);
  const b = await body(req);
  return json({ estimate: await askForEstimate(env, ref, str(b.request) ?? '') }, 201);
});

route('GET', '/api/public/threads/:token/estimates', async ({ env, params, ref }) => {
  return json({ estimates: await estimatesForGuest(env, ref) });
});

/**
 * The customer's yes or no, and — since the payment seam was closed — the
 * booking their yes became.
 *
 * WHAT THE BROWSER GETS BACK, because the guest page is written against
 * exactly this and it must not move underneath it:
 *
 *   { estimate: { …the estimate row…, order_id, order } }
 *
 * `order` is `{ id, total_cents, currency }` on a successful accept and NULL
 * on a decline. It is never NULL on a 200 for an accept: decideEstimate books
 * and returns an order, or it throws, so the page has two cases and not three.
 * `order.id` is what the card form is opened against — POST
 * /api/public/orders/:id/pay — and `total_cents`/`currency` are the figures
 * the customer already agreed to, repeated so the page can show what it is
 * about to charge without a second round trip.
 *
 * A refused accept is a 409 with a sentence in `error`: the quoted time has
 * been taken since ('slot_taken'), the estimate was already answered
 * ('estimate_decided'), its start has passed ('estimate_expired'), or the
 * business cannot be paid ('operator_cannot_be_paid'). Nothing is written on
 * any of them, so the customer can be shown the message and left where they
 * are.
 *
 * `order` is mirrored at the top level as well as inside `estimate`. It is the
 * same object; the duplication is so a page reaching for either spelling finds
 * it, rather than tapping pay against `undefined`.
 */
route('POST', '/api/public/threads/:token/estimates/:id', async ({ req, env, params, ref }) => {
  // Accepting turns into a booking; declining is cheap. Thirty an hour on the
  // link covers a customer changing their mind about several quotes.
  await enforceRateLimit(env, `estimate-decide:${params.token!}`, 30, 3600);
  const b = await body(req);
  const decision = str(b.decision);
  if (decision !== 'accepted' && decision !== 'declined') {
    throw badRequest('Accept it or decline it.', 'bad_decision');
  }
  const estimate = await decideEstimate(env, ref, params.id!, decision);
  return json({ estimate, order: estimate.order });
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
//
// THE CONFIRM STEP IS ALSO WHERE THE ACCOUNT IS MADE. Pricing a basket needs
// nobody to be signed in and never will: browsing, comparing and changing your
// mind are the whole of what this product is for, and a sign-in wall in front
// of them is the friction the owner explicitly does not want. Placing the
// order is the moment somebody has decided to buy, and that is the moment they
// confirm a mobile number — one text, six digits, account created, order
// placed, all in the same action.
// ---------------------------------------------------------------------------

/**
 * The account a booking is placed against.
 *
 * Two ways in and no third. Either this device is already signed in — which is
 * the ordinary case, because a customer's session lasts a year and is extended
 * on use — or the request carries an email address and the code that was sent
 * to it, and verifying the code creates the account and the session in the same
 * breath. Anything else is refused with `account_required`, which is a 401 the
 * front end turns into the two-field step rather than a dead end.
 *
 * The cookie comes back so the caller can put it on the response: a customer
 * who has just signed up must not have to do it again for the next thing they
 * do, and a session minted and then dropped is worse than none.
 */
async function checkoutAccount(
  req: Request, env: Env, b: Record<string, unknown>,
): Promise<{ account: CustomerAccount; cookie: string | null }> {
  const existing = await currentCustomer(req, env);
  if (existing) return { account: existing, cookie: null };

  const email = normaliseLoginEmail(str(b.email));
  const code = str(b.code);
  if (!email || !code) throw new HttpError(401, ACCOUNT_REQUIRED, 'account_required');

  // Taken on trust and used for nothing but filling in the account's contact
  // detail. It is not looked up, nothing is claimed by it, and no standing
  // hangs on it — see migration 0038.
  const country = (str(b.country) ?? 'US').toUpperCase();
  const phone = toE164(str(b.phone), country);

  // The same two ceilings the standalone verify route applies, because this is
  // the same act and a second door onto it must not be the cheap one.
  await enforceRateLimit(env, `otp-verify:${email}`, 10, 900);
  await enforceRateLimit(env, `otp-verify-ip:${clientIp(req)}`, 30, 900);

  const signed = await signInWithCode(env, {
    email, code,
    userAgent: req.headers.get('user-agent'),
    first_name: firstNameOnly(str(b.guest_name) ?? str(b.first_name)) || null,
    phone,
  });
  return { account: signed.account, cookie: signed.cookie };
}

/** What a customer is told when a card is required and there is not one. */
const CARD_REQUIRED =
  'Add a card to finish booking. It is what the job is paid with, and it is '
  + 'the same card a late cancellation is charged against — see the amounts on '
  + 'your account.';

/**
 * The card this order would be charged to, saved onto the account on the way.
 *
 * Stripe IS wired now — keys, webhook, connected accounts, all of it. What is
 * still missing is the one thing this function needs: a field a customer can
 * type a card into. So the third branch is the only one anything reaches, and
 * it lets the booking through.
 *
 * It let the booking through by accident for about an hour, which is the
 * reason customerCardRequired exists rather than paymentsLive alone here. See
 * CARD_CAPTURE_SHIPPED in lib/payments.ts before touching this line.
 */
async function checkoutCard(
  env: Env, account: CustomerAccount, b: Record<string, unknown>,
): Promise<{ ref: string; brand: string | null; last4: string | null } | null> {
  const ref = str(b.card_ref);
  if (ref) {
    // THE BROWSER IS NOT ASKED WHAT CARD IT JUST SAVED.
    //
    // It sends a reference, and the brand and last four are read back from
    // Stripe against that reference. The browser has no reason to lie, but it
    // is the one part of this exchange a person can edit, and "Visa ending
    // 4242" is what a customer later reads to decide whether the charge they
    // are looking at is theirs. That sentence has to come from the processor.
    //
    // Failing to read them is not failing to book: a card whose brand we could
    // not fetch is still a valid card, and refusing the whole booking over a
    // cosmetic label would be the worse trade.
    let brand = safeBrand(str(b.card_brand));
    let last4 = safeLast4(str(b.card_last4));
    try {
      const pm = await getPaymentMethod(env, assertPaymentRef(ref));

      /*
        AND WHOSE CARD IT IS, WHICH NOTHING WAS ASKING.

        `card_ref` arrived off the request body, was checked for the shape of a
        processor reference, and was then saved onto whichever account was
        making the call. A payment-method id is not a secret: Stripe's own form
        hands it to the browser, and any account can read its own back out of
        GET /api/customer/payment-method. So the shape check was the whole of
        the check, and it does not establish the one thing that matters — that
        this card belongs to this customer.

        NO MONEY MOVED, AND THAT IS NOT THE PROBLEM. A payment intent naming a
        payment method attached to a different customer is refused by Stripe,
        so the charge never happens. What did happen is that the real brand and
        real last four of any 'pm_...' in this Stripe account were fetched here
        and written onto the caller's own row, and that row is readable back:
        an attacker who could guess or collect somebody else's payment-method
        id got "Visa ending 4242" confirmed for it, on demand, from our own
        API. An oracle that turns a reference into a real card's identifying
        digits is the leak; the declined charge is just what stopped it being
        worse.

        `pm.customer` is null for a payment method attached to nobody yet,
        which is the ordinary state for a card the customer typed a second ago
        and is explicitly allowed — a setup intent attaches it and the check
        below has nothing to compare. The refusal is only for one that is
        attached to a DIFFERENT customer, which no honest browser can produce.
      */
      if (pm.customer && pm.customer !== account.stripe_customer_id) {
        throw new HttpError(400, 'That card is not on this account.', 'not_your_card');
      }

      brand = safeBrand(pm.card?.brand ?? null) ?? brand;
      last4 = safeLast4(pm.card?.last4 ?? null) ?? last4;
    } catch (e) {
      /*
        THE REFUSAL IS NOT A LOOKUP FAILURE AND MUST NOT BE SWALLOWED WITH ONE.

        This catch exists for the reason given above — a card whose brand we
        could not read is still a valid card, and Stripe being slow or down is
        not a reason to refuse somebody's booking. It swallows everything, on
        purpose, and the check above is thrown from inside it. Left as it was,
        the one error that means "this card is somebody else's" would have been
        caught, discarded, and the booking would have gone on to save the
        stranger's card onto this account exactly as before: the fix would have
        read as applied and done nothing.

        So this one code is re-thrown by name and every other failure keeps the
        old behaviour. Named rather than matched on the message, because the
        message is a sentence shown to a customer and will be reworded.
      */
      if (e instanceof HttpError && e.code === 'not_your_card') throw e;
      /* otherwise keep whatever the browser offered; see above */
    }

    // Stored before the order, so that a customer who adds a card and then
    // loses the race for a slot still has the card they added.
    await saveCustomerCard(env, account.id, { ref, brand, last4 });
    return { ref: assertPaymentRef(ref), brand, last4 };
  }
  if (account.payment_ref) {
    return {
      ref: account.payment_ref,
      brand: account.payment_brand,
      last4: account.payment_last4,
    };
  }
  // BOTH HALVES, not just "can money move". See CARD_CAPTURE_SHIPPED in
  // payments.ts: this line used to read paymentsLive(env) alone, and the day
  // the webhook secret was set it began refusing every booking on the site for
  // want of a card no page could take.
  if (customerCardRequired(env)) throw new HttpError(402, CARD_REQUIRED, 'card_required');
  return null;
}
/**
 * What booking actually requires on this deployment, said once by the server.
 *
 * THE POINT OF THIS ROUTE IS THAT THE ANSWER IS NOT A CONSTANT IN A BUNDLE.
 * Whether a card is needed depends on a Worker secret, and whether an account
 * can be created at all depends on whether an email can be delivered —
 * neither of which the browser can know, and both of which a page has to state
 * correctly or it is lying to somebody about to spend money. A build with a
 * hard-coded "no account needed" is exactly how the whole site came to say a
 * thing that was never the model.
 *
 * `sms_ready` false is the honest description of every deployment today: no
 * email provider is configured, so no account can be created and
 * nothing can be booked. That is a refusal rather than a fallback — see
 * sendSignInCode — and a page that knows it can say so before somebody fills
 * in a basket.
 */
route('GET', '/api/public/booking-state', async ({ env }) => {
  return json({
    /** Always true since migration 0037. Booking is what needs one. */
    account_required: true,
    /** Reading a booking you already have never needs one. */
    guest_link_works: true,
    /**
     * WHETHER THE DOOR OPENS, asked of the provider that actually opens it.
     *
     * This read smsConfigured() until 0038 moved the code to email, and the
     * answer was then false on every correctly-configured deployment: no
     * Telnyx key exists anywhere any more. The page told every visitor that
     * nothing could be booked, with a note saying no email provider was set
     * up, while booking worked perfectly. A readiness flag that is wrong in
     * the safe-looking direction is worse than none — it turns people away
     * from a working checkout.
     *
     * The name is kept because the front end reads it, and because what it
     * answers is unchanged: can a sign-in code be delivered at all.
     */
    sms_ready: emailConfigured(env),
    payments_live: paymentsLive(env),
    /**
     * A card is asked for once money can move AND there is a field to type one
     * into. The browser is told the same thing the Worker enforces, because
     * the two disagreeing is how a booking form asks for nothing and then gets
     * a 402 back.
     */
    card_required: customerCardRequired(env),
    account_note: ACCOUNT_REQUIRED,
    card_note: CARD_NOTE_CUSTOMER,
    sms_note: emailConfigured(env) ? null : EMAIL_NOT_CONFIGURED,
  }, 200, { 'cache-control': 'no-store' });
});

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
  // Before placeOrder and after the challenge. An account is what the booking
  // is written against — the number on the order comes off it and not out of
  // this body, which is what stops a suspended customer booking under somebody
  // else's mobile — so it has to be resolved before a single row is written.
  const { account, cookie } = await checkoutAccount(req, env, b);
  const card = await checkoutCard(env, account, b);
  const placed = await placeOrder(env, {
    items: Array.isArray(b.items) ? b.items as any : [],
    guest_name: String(b.guest_name ?? account.first_name ?? ''),
    phone: String(b.phone ?? ''),
    email: str(b.email) ?? account.email ?? undefined,
    address_line: str(b.address_line) ?? undefined,
    postcode: str(b.postcode) ?? undefined,
    thread_token: str(b.thread_token) ?? undefined,
    account: {
      id: account.id,
      phone: account.phone_e164 ?? '',
      login_email: account.login_email ?? '',
    },
    card,
  });
  const base = env.APP_URL.replace(/\/$/, '');
  return json(
    { ...placed, account: publicAccount(account), link: `${base}/c/${placed.thread_token}` },
    201,
    // Only when this request is what created the session. A customer who was
    // already signed in gets no Set-Cookie, so their session is not silently
    // replaced by a shorter one on every booking.
    cookie ? { 'set-cookie': cookie } : {},
  );
});

// ---------------------------------------------------------------------------
// Paying, and being paid
// ---------------------------------------------------------------------------

/**
 * What the browser needs to draw the card form ON THIS SITE.
 *
 * The publishable key is served rather than baked into the bundle so rotating
 * it is a secret change and not a rebuild. It is public by design — it
 * identifies the account to Stripe's own script and can do nothing on its own.
 */
route('GET', '/api/public/payment-config', async ({ env }) => {
  return json({
    enabled: stripeConfigured(env) && !!env.STRIPE_PUBLISHABLE_KEY,
    publishable_key: env.STRIPE_PUBLISHABLE_KEY ?? null,
    fee_note: feeSentence(),
  }, 200, { 'cache-control': 'public, max-age=300' });
});

/**
 * A BUSINESS STEPPING OVER TO THE CUSTOMER SIDE.
 *
 * A detailer needs a locksmith. A junk hauler needs a mobile mechanic. Solo
 * trades are each other's customers, and until now a business that wanted to
 * book one had to make a second account by hand with a second mailbox.
 *
 * ONE DIRECTION ONLY. There is no matching route the other way, deliberately.
 * Becoming a business means a bank account, a vehicle, location sharing and
 * working hours — minutes of real onboarding — and a control that calls that a
 * toggle promises instant and delivers a form.
 *
 * WHY THIS IS NOT A HOLE. It looks like a way into a customer account without
 * the six-digit code, and it is the opposite: the caller is holding a live
 * operator session, which was itself opened by proving that same mailbox. The
 * proof is the same, arriving through a different door — and customerSideOf
 * refuses outright if the mailbox already belongs to a different business.
 *
 * BOTH COOKIES LIVE AT ONCE, which is the whole reason this is cheap. They
 * have different names and different digests, so setting the customer one
 * leaves the operator session untouched: switching back is a link, not a
 * sign-in. See the comment above the customer's routes for why the two
 * identities are disjoint in the first place.
 */
route('POST', '/api/operator/customer-mode', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  await enforceRateLimit(env, `customer-mode:${op.id}`, 20, 600);
  const { account, token, created } = await customerSideOf(env, op);
  return json(
    { account: publicAccount(account), created },
    200,
    { 'set-cookie': customerCookie(token), 'cache-control': 'no-store' },
  );
});

/**
 * Opens a card-on-file setup for the signed-in customer.
 *
 * NO CHARGE. A SetupIntent only stores a card for later; the amount for the
 * job is taken separately at /api/public/orders/:id/pay. The two are different
 * on purpose — a customer agrees to keep a card on file once, and is charged
 * per booking.
 *
 * SIGNED IN, unlike the pay route below. A card saved against the wrong
 * account is a card charged to the wrong person later, and there is no
 * one-time id here standing in for a session the way an order id does.
 *
 * The publishable key rides along so the browser makes one request rather than
 * two — it is public by definition and is already served by payment-config.
 */
route('POST', '/api/public/setup-intent', async ({ req, env }) => {
  const account = await requireCustomer(req, env);
  await enforceRateLimit(env, `setup:${account.id}`, 10, 600);
  const customerId = await ensureStripeCustomer(env, account);
  const intent = await createSetupIntent(env, customerId);
  return json({
    client_secret: intent.client_secret,
    publishable_key: env.STRIPE_PUBLISHABLE_KEY ?? null,
  }, 200, { 'cache-control': 'no-store' });
});

/**
 * Opens the charge for an order and returns the secret the embedded form uses.
 *
 * NO REDIRECT ANYWHERE. This hands back a client secret; the payment happens
 * inside our own page. See lib/stripe.ts for why there is no Checkout Session.
 *
 * Deliberately reachable without a session. The order id was minted seconds
 * ago by the checkout that created it and is a random id nobody can guess, the
 * amount comes off the stored order rather than the request, and the only
 * thing this can do is open a charge against a basket that already exists.
 * Requiring a sign-in here would break the one case that matters most: a
 * customer coming back to a half-finished payment from their own link.
 */
route('POST', '/api/public/orders/:id/pay', async ({ req, env, params }) => {
  await enforceRateLimit(env, `pay:${clientIp(req)}`, 20, 600);
  return json(await startPayment(env, params.id ?? ''), 200,
    { 'cache-control': 'no-store' });
});

/** Where a business stands on getting paid. */
route('GET', '/api/stripe/account', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  return json({ connect: await connectStatus(env, op.id) }, 200,
    { 'cache-control': 'no-store' });
});

/** Asks Stripe directly rather than reading the cache. */
route('POST', '/api/stripe/account/refresh', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  return json({ connect: await refreshConnectAccount(env, op.id) }, 200,
    { 'cache-control': 'no-store' });
});

/**
 * Starts or resumes onboarding and returns the link to send them to.
 *
 * The one redirect in the product, and it is the right one: a self-employed
 * person hands their identity and bank details to the regulated company that
 * needs them, on that company's own page. See lib/connect.ts.
 */
route('POST', '/api/stripe/onboard', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  await enforceRateLimit(env, `onboard:${op.id}`, 10, 600);
  return json(await startOnboarding(env, op.id), 200, { 'cache-control': 'no-store' });
});

/**
 * Where Stripe sends somebody whose onboarding link expired mid-way.
 *
 * Mints a fresh one and bounces them straight back in, so an expired link is
 * something the operator never sees rather than a dead end for the person most
 * likely to have stopped halfway through.
 *
 * IT RESUMES, IT DOES NOT START. Stripe sends the browser here itself, which
 * is a cross-site top-level navigation carrying the operator's cookie — so any
 * page on the internet can do the same. When this called startOnboarding
 * unconditionally, that meant a link on an attacker's page could make a
 * signed-in operator's browser open a real connected account at Stripe and
 * land them in an identity-verification flow they never asked for.
 *
 * An operator who has already begun has an account id on their row, and
 * minting a link against it creates nothing. One who has not is sent to their
 * own settings page to press the button themselves, which is the only place
 * starting should ever begin.
 */
route('GET', '/api/stripe/onboard/refresh', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const { account_id } = await connectStatus(env, op.id);
  if (!account_id) {
    return new Response(null, {
      status: 302,
      headers: { location: '/app/settings?payouts=start', 'cache-control': 'no-store' },
    });
  }
  const { url } = await startOnboarding(env, op.id);
  return new Response(null, { status: 302, headers: { location: url } });
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
  //
  // `catalogPayload` is the same rule applied to the tile drawings: every trade
  // and every category goes out carrying the path of its own picture, computed
  // by the one function in lib/seo.ts that the server-rendered pages also call.
  // The React pages read the field off this payload rather than building a
  // path of their own, so a browse row drawn by React and the same row drawn
  // by the Worker cannot point at different files. See the note over `tradeArt`.
  return json(catalogPayload(TRADE_CATEGORIES),
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
  // The same payload shape as the full catalogue above, tile art and all: one
  // mapping, in lib/seo.ts, read by both trees. Two endpoints serving the same
  // thing in two shapes is how a page that switches between them breaks.
  return json(catalogPayload(catalogFor((rows.results ?? []).map((r) => r.trade))),
    200, { 'cache-control': 'public, max-age=300' });
});

/**
 * The places Round The Way serves, so the front end renders a metro list and a
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
  // setting-up of it.
  //
  // DELETE on the same watch is deliberately not challenged: it needs the
  // token, which means holding the link this response is the only place to
  // get, and it sends nothing. PATCH used to be excused on that same reasoning
  // AND THE REASONING WAS WRONG — a token is something the attacker mints, and
  // moving the email on a watch they own re-sends a confirmation to whatever
  // address they name. It now carries both of these guards for exactly that
  // edit; see the note on the PATCH route.
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

/**
 * One-click "stop offering me your spare hours", straight from an offer email.
 *
 * THE REPLACEMENT FOR SMS CONSENT, which was the permission and the way to
 * withdraw it in one column and is gone from the candidate queries along with
 * the texts nobody could send. Same shape as the watch unsubscribe above and
 * for the same reasons: a GET on a link in an email, working with no session,
 * no JavaScript and no form, answering identically whether or not the token
 * matched so that a stranger poking at it learns nothing and the person who
 * clicked gets the outcome they wanted either way.
 *
 * A DIFFERENT SPACE FROM /a/stop, and not merely a different token. That one
 * switches off a `watches` row — a standing request somebody made for
 * themselves — and this one sets `clients.opted_out_at`, which is one
 * business's list. Sharing the route would mean one link that could do either
 * depending on which table happened to match, and the rate-limit bucket is
 * named separately for the same reason.
 */
route('GET', '/a/stop-offers/:token', async ({ req, env, params }) => {
  await guardTokenGuessing(env, req, 'offer-stop');
  await stopOffersByToken(env, params.token ?? '');
  return html(page('Offers stopped', `<p class="big">✅</p>
    <h1>Offers stopped</h1>
    <p class="meta">They will not offer you any more of their spare hours.
    Your bookings and your conversation with them are not affected.</p>
    <a href="/" class="note">See what is open</a>`));
});

/**
 * The click that turns an alert on.
 *
 * NOTHING IS SENT TO AN ADDRESS UNTIL SOMEBODY AT IT PRESSES THIS. Creating a
 * watch used to be enough on its own, so anyone could type a stranger's
 * address into a public form and buy them five emails a day, from our domain,
 * for as long as they cared to ignore it. Now creation sends exactly one
 * message — this link — and an address that never confirms never hears from
 * us again.
 *
 * Answers identically for a good token, an unknown one and one that was
 * already used, for the same reason /a/stop does: a stranger poking at it
 * learns nothing about whose address is on file, and the person who actually
 * clicked gets the outcome they wanted either way.
 */
route('GET', '/a/confirm/:token', async ({ req, env, params }) => {
  await guardTokenGuessing(env, req, 'watch');
  await confirmWatchEmail(env, params.token ?? '');
  return html(page('Alerts on', `<p class="big">✅</p>
    <h1>Alerts on</h1>
    <p class="meta">We will email you when a trade has an opening near here.</p>
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

  /*
    POINTING A WATCH AT A NEW ADDRESS IS A SEND, AND IT WAS THE CHEAPEST SEND
    ON THE SITE.

    Creating a watch is guarded twice over: POST /api/public/watches carries a
    per-mailbox ceiling of five an hour and a Turnstile challenge, both for the
    reason written out beside them — a watch is a standing instruction to email
    somebody at an address the sender never had to prove they own, so creating
    one is a mail-bombing primitive and is treated as one.

    Changing the email on an existing watch does exactly the same thing.
    updateWatch clears email_verified_at and calls sendConfirmation, so the new
    address gets a message from our domain, and nobody at it agreed to
    anything. This route had neither of the creation guards: the only ceiling
    was `watch-edit:<token>` at sixty an hour, bucketed on the token, and the
    token is the one thing an attacker can mint more of — one POST buys a watch
    and then sixty PATCHes an hour aimed at any address they like. Ten watches
    is six hundred messages an hour at one mailbox, and they leave on the bulk
    lane, which is the lane the opening alerts share: the sender's reputation
    that gets burned is the one the product depends on.

    So the two guards that protect creation now protect this, and only in the
    case that actually sends: a new address that is not the one already on the
    row. The narrower condition matters in both directions.

      NOT EVERY PATCH. Editing the trades, the detour, the price ceiling or the
      label sends nothing, and the person doing it is the holder of the link.
      Challenging those would put a CAPTCHA in front of a settings toggle for
      no gain.

      NOT CLEARING IT EITHER, and not merely because it is harmless. The
      per-mailbox bucket is keyed on the address being mailed; a clear has no
      address, so it would either need a key of its own or would share one
      global "null" bucket — which would mean the fifth person to switch their
      alert emails off in an hour could not. Clearing sends nothing at all
      (updateWatch guards sendConfirmation on `addressChanged && next.email`),
      so it is left exactly as open as it was.

    Lower-cased before the comparison because cleanEmail in alerts.ts
    lower-cases before its own, so the same mailbox typed two ways is one
    address here too — otherwise re-saving your own address with a capital
    letter would spend a challenge and a fifth of the hour's allowance on a
    write that sends nothing.
  */
  const target = 'email' in b ? str(b.email)?.toLowerCase() ?? null : null;
  if (target) {
    // Unknown tokens are deliberately not distinguished here: watchByToken
    // gives null, nothing is charged, and updateWatch below throws the same
    // 404 it always did. The walk that would look for those is what
    // guardTokenGuessing above is for.
    const current = await watchByToken(env, params.token ?? '');
    if (current && current.email !== target) {
      await enforceRateLimit(env, `watch-email:${target}`, 5, 3600);
      await requireTurnstile(env, req, tokenFromBody(b));
    }
  }

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
  // THE ONE DOOR IN THIS TOKEN SPACE THAT WAS NOT WATCHED.
  //
  // Every other route on /api/public/watches/:token and on /a/* runs this
  // first, and a walk through the token space only has to find the cheapest
  // one: an attacker guessing tokens does not care which verb tells them a
  // token is real, only that something does. This route answers a 404 from
  // removeSubscription for a token that does not exist and a 200 for one that
  // does, so it distinguishes them exactly as the GET beside it does — and it
  // was the only member of the space with no ceiling at all, which made the
  // sibling routes' ceilings decorative. Bucketed on the address rather than
  // the token, for the reason written out over guardTokenGuessing: every guess
  // carries a different token, so a per-token bucket never fills.
  await guardTokenGuessing(env, req, 'watch');
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

/**
 * WHO IS ACTUALLY OUT, for the map on the front page.
 *
 * Real fixes from real phones, coarsened to about a kilometre and carrying no
 * identity at all -- no operator id, no business name, no link. See
 * livePositions: the four gates are consent, being listed, being switched on,
 * and the fix being fresh, and every one of them closes by itself.
 *
 * NOT CACHED AT THE EDGE. The whole value of this response is that it is true
 * right now; a cached copy is a van drawn where it was rather than where it
 * is, which is the one thing this endpoint must never be. The cost of that is
 * one fan-out of memory reads per request, which is why the ceiling below is
 * per-IP and low: a person watching the map polls this every twenty seconds.
 */
route('GET', '/api/public/live', async ({ req, env }) => {
  await enforceRateLimit(env, `live:${clientIp(req)}`, 30, 60);
  return json({
    vans: await livePositions(env),
    // Whether this deployment is still showing sample businesses. The map uses
    // it to decide what an EMPTY list means: with real businesses on the site,
    // nobody out right now is the truth and the map shows no vehicles. In the
    // sample deployment there are no phones to ping, so an empty list means
    // "this part cannot work yet" -- and the map draws its illustrated fleet
    // instead, with the line that says so. One flag, so the browser never has
    // to guess which silence it is looking at.
    demo: env.DEMO_MODE === 'on',
  }, 200, { 'cache-control': 'no-store' });
});

route('GET', '/api/public/threads/:token/track', async ({ env, params, ref }) => {
  return json(await customerView(env, ref), 200, { 'cache-control': 'no-store' });
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
 * ONE PAGE, ONE ADDRESS — the 301 that makes that true.
 *
 * Several of the pages below answer on more than one spelling of their own
 * URL, and every one of those spellings used to be a 200. The router's pattern
 * ends `/?$`, so a trailing slash is a second address; `resolvePlace` accepts a
 * business's own area slug as well as the shared neighbourhood key, so
 * /near/sherman-oaks-2 is a third and /near/sherman-oaks-2/ a fourth — times
 * every trade open there. Mixed case is another, and the escaped spelling of a
 * trade slug another still.
 *
 * A canonical tag was the only thing pointing at the right one, and a canonical
 * is a hint. Until it is believed the crawl budget is being spent several times
 * over on one page and the signals are split between the copies. A 301 is not a
 * hint.
 *
 * The query string is carried across, because `?ref=` on a link somebody
 * shared is not a reason to drop them somewhere different from where they were
 * going.
 */
function toCanonical(url: URL, want: string): Response | null {
  if (url.pathname === want) return null;
  return new Response(null, {
    status: 301,
    headers: {
      location: `${want}${url.search}`,
      'cache-control': 'public, max-age=3600',
    },
  });
}

/**
 * An address with nothing behind it, as a page rather than as JSON.
 *
 * `throw notFound('No such area.')` goes out through `json()`, so a person who
 * mistyped one character of a neighbourhood name was shown
 * `{"error":"No such area."}` with an application/json content type. These are
 * the pages strangers arrive on from a search engine; an unknown one has to be
 * a page they can leave by.
 */
const htmlNotFound = (env: Env, what: string) =>
  html(notFoundPage(env, what), 404, { 'cache-control': 'public, max-age=300, s-maxage=300' });

/**
 * The pages a stranger arrives on from a search engine.
 *
 * A neighbourhood page, and a page per trade in that neighbourhood — which is
 * the exact shape of "junk removal sherman oaks". Every competitor answers
 * that query with a lead form; this answers it with what is open, when, and
 * what it costs. That is the only advantage here that compounds.
 */
route('GET', '/near/:slug', async ({ env, params, url }) => {
  const place = await canonicalPlaceSlug(env, params.slug ?? '');
  if (!place) return htmlNotFound(env, 'No business has listed that neighbourhood.');
  const moved = toCanonical(url, `/near/${place}`);
  if (moved) return moved;
  const body = await neighbourhoodPage(env, place);
  if (!body) return htmlNotFound(env, 'No business has listed that neighbourhood.');
  return html(body, 200, { 'cache-control': 'public, max-age=120, s-maxage=300' });
});

route('GET', '/near/:slug/:trade', async ({ env, params, url }) => {
  // Both halves are canonicalised before anything is rendered: the place to
  // the shared neighbourhood key, and the trade to the hyphenated slug, so
  // /near/sherman-oaks-2/junk%20removal lands on one address rather than
  // being a fifth live copy of it.
  const trade = tradeFromSlug(tradeSlug(params.trade ?? ''));
  const place = await canonicalPlaceSlug(env, params.slug ?? '');
  if (!trade || !place) {
    return htmlNotFound(env, 'That is not a trade, or nobody has listed that neighbourhood.');
  }
  const slug = tradeSlug(trade);
  const moved = toCanonical(url, `/near/${place}/${slug}`);
  if (moved) return moved;
  const body = await tradeInPlacePage(env, place, slug);
  if (!body) return htmlNotFound(env, 'Nobody has listed that neighbourhood.');
  return html(body, 200, { 'cache-control': 'public, max-age=120, s-maxage=300' });
});

/**
 * Everything above enumerated, so that the geographic layer is reachable
 * rather than only linkable from whichever page happens to be nearby.
 */
route('GET', '/near', async ({ env, url }) => toCanonical(url, '/near') ?? html(
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
  route('GET', metroPath(metro), async ({ env, url }) =>
    toCanonical(url, metroPath(metro)) ?? html(
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

/**
 * The SPA shell, with the status the address deserves on it.
 *
 * A 200 FOR A URL THAT NAMES NOTHING IS THE DEFECT THIS EXISTS TO CLOSE. This
 * used to be `assets.fetch(req)` returned verbatim, and the assets binding is
 * configured single-page-application, so "no such trade", "no such cost
 * guide", "no such category" and "no such business" all answered 200 with the
 * app in them — and the app then drew its not-found page. Google documents
 * exactly that as a soft 404: a successful response for an address that does
 * not exist. The namespaces are unbounded — anybody can ask for /p/<anything>
 * — so it is an unbounded supply of them, each one judged as a thin duplicate
 * of everything else that answers the same way.
 *
 * The bytes are unchanged: the same shell, the same React app, the same
 * not-found page drawn over it. Only the status line is different, which is
 * the half a crawler reads and the half a person never sees.
 */
async function toSpa(req: Request, env: Env, status = 404): Promise<Response> {
  const assets = (env as unknown as {
    ASSETS?: { fetch: (r: Request) => Promise<Response> };
  }).ASSETS;
  if (!assets) throw notFound('No such page.');
  const res = await assets.fetch(req);
  if (res.status !== 200 || status === 200) return res;
  return new Response(res.body, { status, headers: res.headers });
}

route('GET', '/s/:trade', async ({ req, env, params, url }) => {
  const segment = params.trade ?? '';
  const entry = tradeFromPathSegment(segment);
  if (!entry) return toSpa(req, env);
  /*
    THE REDIRECT USED TO POINT THE OTHER WAY, AND THAT WAS THE BUG.

    `canonicalTradeSegment` was `encodeURIComponent(entry.slug)`, so this sent
    the readable /s/junk-removal to /s/junk%20removal — an escaped space in the
    canonical, in the sitemap, in every internal link and in every result
    snippet, on the highest-intent pages the site has. It is the hyphenated
    form now (see `tradePath` in lib/seo.ts) and the escaped spelling is what
    moves. Comparing the whole pathname rather than just the segment also
    catches the trailing slash and the mixed-case spelling in the same 301.
  */
  const moved = toCanonical(url, `/s/${canonicalTradeSegment(entry)}`);
  if (moved) return moved;
  const body = await tradePage(env, segment, { shell: await spaShell(req, env) });
  if (!body) return toSpa(req, env);
  return html(body, 200, { 'cache-control': 'public, max-age=120, s-maxage=300' });
});

route('GET', '/cost/:trade', async ({ req, env, params, url }) => {
  const segment = params.trade ?? '';
  const entry = tradeFromPathSegment(segment);
  if (!entry) return toSpa(req, env);
  const moved = toCanonical(url, `/cost/${canonicalTradeSegment(entry)}`);
  if (moved) return moved;
  const body = await costGuidePage(env, segment, { shell: await spaShell(req, env) });
  if (!body) return toSpa(req, env);
  return html(body, 200, { 'cache-control': 'public, max-age=120, s-maxage=300' });
});

/**
 * The front door, server-rendered like everything else here.
 *
 * IT WAS THE ONE PAGE THE WORKER NEVER SAW. `/` matched nothing in
 * WORKER_PATHS and had no route, so the assets binding answered it with the
 * SPA shell — an empty #root, no canonical, no heading and no link — which is
 * what a crawler that runs no JavaScript found at the address every external
 * link to this site points at. See `homePage` in lib/seo.ts for what that cost
 * beyond the one page.
 */
route('GET', '/', async ({ req, env, url }) => toCanonical(url, '/') ?? html(
  await homePage(env, { shell: await spaShell(req, env) }),
  200, { 'cache-control': 'public, max-age=120, s-maxage=300' },
));

/**
 * The two hubs those pages link up to.
 *
 * Neither can fail the way the four above can: both are built from the
 * compiled-in catalogue rather than from a slug in the URL, so there is no
 * "no such thing" branch to fall through to the SPA with — every trade has a
 * row on both of them, quiet or not.
 */
route('GET', '/browse', async ({ req, env, url }) => toCanonical(url, '/browse') ?? html(
  await browseIndexPage(env, { shell: await spaShell(req, env) }),
  200, { 'cache-control': 'public, max-age=300, s-maxage=600' },
));

route('GET', '/cost', async ({ req, env, url }) => toCanonical(url, '/cost') ?? html(
  await costIndexPage(env, { shell: await spaShell(req, env) }),
  200, { 'cache-control': 'public, max-age=300, s-maxage=600' },
));

route('GET', '/browse/:category', async ({ req, env, params, url }) => {
  const key = (params.category ?? '').trim().toLowerCase();
  const moved = toCanonical(url, `/browse/${key}`);
  if (moved) return moved;
  const body = await categoryPage(env, key, { shell: await spaShell(req, env) });
  if (!body) return toSpa(req, env);
  return html(body, 200, { 'cache-control': 'public, max-age=300, s-maxage=600' });
});

route('GET', '/p/:slug', async ({ req, env, params, url }) => {
  // Profile slugs are minted lower case by `slugify`, so an upper-case one in
  // a URL is the same business asked for in a different spelling.
  const slug = (params.slug ?? '').trim().toLowerCase();
  const moved = toCanonical(url, `/p/${slug}`);
  if (moved) return moved;
  const body = await profilePage(env, slug, { shell: await spaShell(req, env) });
  if (!body) return toSpa(req, env);
  return html(body, 200, { 'cache-control': 'public, max-age=300, s-maxage=600' });
});

route('GET', '/sitemap.xml', async ({ env }) => {
  const xml = await sitemapXml(env, siteBase(env));
  return new Response(xml, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      /*
        THE SAME LIFETIME AS THE PAGES IT ADVERTISES, which it was twelve times
        longer than.

        This file was cached for an hour while /near/<place>/<trade> is cached
        for five minutes — and that page goes noindex the moment its last
        opening is booked. So for up to an hour a crawler could be handed a
        sitemap promising URLs that had already stopped asking to be indexed,
        which is the same file-level contradiction the noindex rules above
        exist to avoid, arriving by a slower route. A sitemap of openings is
        worth exactly as much as the openings are fresh.
      */
      'cache-control': 'public, max-age=120, s-maxage=300',
    },
  });
});

route('GET', '/robots.txt', async ({ env }) => {
  // `siteBase` falls back to the request's own origin, because
  // `Sitemap: /sitemap.xml` — which is what an unset APP_URL used to emit — is
  // a relative URL, and the sitemap protocol requires an absolute one.
  // Consumers discard the line rather than resolving it.
  return new Response(robotsTxt(siteBase(env)), {
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

/**
 * The fields the no-JavaScript booking form carries, put back into the page as
 * hidden inputs while the customer types the code we just texted them.
 *
 * Without this the code step would lose the address and the name and the whole
 * form would have to be filled in twice. Every value is escaped on the way
 * back out: these are strings a stranger typed and they are about to be
 * rendered into a document.
 */
const rebookFields = (b: Record<string, unknown>, keys: string[]): string =>
  keys.map((k) => {
    const v = str(b[k]);
    return v ? `<input type="hidden" name="${k}" value="${escapeHtml(v)}">` : '';
  }).join('');

route('POST', '/book/:gapId', async ({ req, env, params }) => {
  const b = await body(req);
  // The no-JavaScript booking form, so the same reasoning as /api/public/orders
  // with one addition: the slot itself is a bucket. Only one person can have a
  // given gap, and repeatedly posting at one gap is either a race against
  // whoever is mid-booking or an attempt to guess the state of it.
  await enforceRateLimit(env, `order:${clientIp(req)}`, 10, 3600);
  await enforceRateLimit(env, `book-gap:${params.gapId ?? ''}`, 20, 3600);
  try {
    // THE SAME ACCOUNT RULE AS THE JSON CHECKOUT, IN THE ONLY SHAPE A FORM CAN
    // TAKE IT. A page with no JavaScript cannot call one endpoint for a code
    // and another for the booking, so the one form posts twice: the first post
    // sends the code and comes back as this page with everything typed so far
    // held in hidden fields, and the second carries the code and books. It is
    // the same two steps the React checkout does, drawn in HTML.
    let account = await currentCustomer(req, env);
    let cookie: string | null = null;

    if (!account) {
      const gap = await env.DB.prepare(
        `SELECT o.country FROM gaps g JOIN operators o ON o.id = g.operator_id
          WHERE g.id = ?`,
      ).bind(params.gapId ?? '').first<{ country: string }>();
      const email = normaliseLoginEmail(str(b.email));
      if (!email) {
        throw badRequest('Enter an email address we can send a code to.', 'bad_email');
      }
      // Still asked for, still written to the account, still never proved: the
      // operator is driving to a stranger's address and needs something to ring
      // on arrival. It unlocks nothing. See migration 0038.
      const phone = toE164(str(b.phone), gap?.country ?? 'US');
      if (!phone) {
        throw badRequest('That does not look like a valid mobile number.', 'bad_phone');
      }

      const code = str(b.code);
      if (!code) {
        // Step one. Nothing is booked and nothing is written except the code
        // row; the opening is still there for this person to come back to.
        await enforceDailyIntake(env, 'customer');
        const sent = await sendSignInCode(env, {
          email, ip: clientIp(req), lang: str(b.language),
          echo: mayEchoSignInLink(env, req.headers.get('x-auth-debug')),
        });
        return html(page('Confirm your email', `<h1>Confirm your email</h1>
<p class="meta">We have emailed a six-digit code to ${escapeHtml(email)}. It lasts
${Math.round(sent.expires_in / 60)} minutes and works once. Typing it in creates your
account and books the slot — there is nothing else to fill in.</p>
<form method="post" action="/book/${encodeURIComponent(params.gapId ?? '')}">
${rebookFields(b, ['first_name', 'phone', 'email', 'address_line', 'postcode', 'thread_token', 'language'])}
<div class="find"><label>Code<input name="code" inputmode="numeric" autocomplete="one-time-code"
 pattern="[0-9]*" maxlength="6" required></label></div>
<button class="yes" type="submit">Confirm and book</button>
</form>
<p class="note">Nothing there? Look in spam or promotions first.</p>
<p class="note">Already have a booking? The link in your confirmation opens it without
signing in.</p>`));
      }

      await enforceRateLimit(env, `otp-verify:${email}`, 10, 900);
      await enforceRateLimit(env, `otp-verify-ip:${clientIp(req)}`, 30, 900);
      const signed = await signInWithCode(env, {
        email, code,
        userAgent: req.headers.get('user-agent'),
        first_name: firstNameOnly(str(b.first_name)) || null,
        phone,
      });
      account = signed.account;
      cookie = signed.cookie;
    }

    const { thread_token } = await claimSlot(env, {
      gapId: params.gapId ?? '',
      first_name: String(b.first_name ?? account.first_name ?? ''),
      phone: String(b.phone ?? ''),
      email: str(b.email),
      address_line: str(b.address_line),
      postcode: str(b.postcode),
      thread_token: str(b.thread_token),
      account: {
        id: account.id,
        phone: account.phone_e164 ?? '',
        login_email: account.login_email ?? '',
      },
    });
    // Straight to their conversation. That page is the confirmation and the
    // way to reach the business, and it keeps working on any phone with the
    // link in it — signed in or not.
    return new Response(null, {
      status: 303,
      headers: {
        location: `/c/${thread_token}`,
        'cache-control': 'no-store',
        ...(cookie ? { 'set-cookie': cookie } : {}),
      },
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
// No inbound SMS webhooks.
// ---------------------------------------------------------------------------
// /webhooks/twilio/inbound (STOP and START from a client's handset) and
// /webhooks/twilio/status (delivery receipts) used to sit here. Both existed
// only to serve Twilio and both are gone with it. sms_mode is 'device': the
// app hands the operator a message to send from their own handset, which needs
// no carrier account and no webhook. The site's own texts -- the sign-in code
// -- go out through src/lib/sms.ts, which is a separate path and always was.

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
 * THIS ROUTE IS UNCHANGED BY ACCOUNTS EXISTING, and it stays that way. The
 * link is not a weak authority for this purpose: whoever holds it can already
 * read the booking, the address, the conversation and the photographs, so
 * asking them to prove a mobile number first would add a step and no security.
 * More to the point, somebody who wants to be forgotten should not have to
 * make an account in order to be forgotten -- and a customer who booked before
 * migration 0037 has none to sign in with.
 *
 * A customer who does have one reaches the identical erasure at
 * DELETE /api/customer/data, behind their session. Both call the same function
 * and remove the same rows -- see eraseCustomerByPhone.
 *
 * DELETE rather than POST because it is a deletion, and it is deliberately not
 * reversible: there is no undo, no thirty-day grace period and no tombstone
 * holding the data in case they change their mind. The front end must say so
 * before it calls this.
 */
route('DELETE', '/api/public/threads/:token/data', async ({ req, env, params, ref }) => {
  // Each call walks several tables and deletes photographs out of the photo
  // store. Three in an
  // hour covers somebody tapping twice because the first response was slow;
  // nothing legitimate needs more.
  await enforceRateLimit(env, `erase:${params.token!}`, 3, 3600);
  await enforceRateLimit(env, `erase-ip:${clientIp(req)}`, 10, 3600);
  const result = await eraseCustomerByToken(env, ref);
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

  /*
    THE ORIGIN THE PAGES MAY FALL BACK TO, AND WHY IT IS NOT A DEFAULT FOR
    APP_URL.

    A deploy with no APP_URL used to publish `Sitemap: /sitemap.xml` — which
    the sitemap protocol forbids and consumers discard — and a path-only
    canonical on every page. The request knows its own origin, so lib/seo.ts
    falls back to it.

    It is a separate field rather than `env.APP_URL ??= url.origin` because
    APP_URL is what a sign-in link, an offer link, a guest-thread link and the
    email gate in lib/email.ts are all built from. Those must never be
    assembled out of a Host header the caller typed: that turns a mistyped host
    into a sign-in link pointing at somebody else's domain. Only the canonical
    and the sitemap line read this, and neither is a credential.
  */
  const site: Env = { ...env, REQUEST_ORIGIN: url.origin } as Env & { REQUEST_ORIGIN: string };

  const pre = preflight(req, env);
  if (pre) return pre;

  /*
    THE SECOND COPY OF THIS ENTIRE SITE, AND THE ONE HEADER THAT SAYS WHICH
    COPY IS THE REAL ONE.

    wrangler.toml routes roundtheway.app and never sets `workers_dev`, which
    defaults to true — so this same Worker also answers on its
    <name>.<subdomain>.workers.dev address, off the same database, with the
    same routes and the same server-rendered pages. That is not a staging copy
    with different content; it is the same site on a second hostname, and
    nothing about it is private: a workers.dev address is guessable from the
    Worker's own name and turns up on its own the moment anything links to it
    once.

    WHAT IT COST. Every page lib/seo.ts renders carries a canonical built from
    APP_URL, which is the right half of the answer and not the whole of it. A
    canonical is a hint a search engine may disregard, and for as long as it is
    disregarded the duplicate competes with the real site for the same queries
    — the openings, the cost guides, the trade pages, every profile, all of it
    twice, each copy splitting the other's standing. Worse than the ranking is
    what happens to a person who lands on the duplicate and tries to use it:
    lib/email.ts builds a sign-in link from APP_URL and deliberately never from
    the Host header, so the link they are emailed points at roundtheway.app
    while the page they were reading is on workers.dev. The cookie is set on
    the origin they were sent to and not the one they came from, and signing in
    appears to do nothing at all.

    A HEADER, NEVER A REDIRECT, and that is the load-bearing part. POSTs arrive
    here too: /webhooks/stripe and the whole of /api. A redirect is a request
    the sender is not obliged to repeat, and Stripe does not repeat one — it
    records the delivery as a 3xx and moves on, so an event that says money
    arrived would never reach markPaid and the job would sit unpaid for a
    payment that cleared. `x-robots-tag` is advice to a crawler and invisible
    to every other caller, so the duplicate keeps behaving exactly as it does
    today for anything that is not a search engine.

    AN UNSET OR UNPARSEABLE APP_URL DISABLES THE CHECK INSTEAD OF STAMPING
    EVERYTHING. There is no honest guess available at this point: the only
    other thing this code knows about its own address is the Host header the
    caller typed, and comparing that with itself is a test that can never fire.
    So if the comparison cannot be made truthfully it is not made — because the
    failure in the other direction is the live site telling every crawler not
    to index it, which is silent, total, and invisible until the traffic has
    already gone.
  */
  const canonicalHost = (() => {
    try { return new URL(env.APP_URL).host; } catch { return null; }
  })();
  const offCanonical = canonicalHost !== null && url.host !== canonicalHost;

  /**
   * The stamp, applied at each of the three ways out below rather than at one
   * of them.
   *
   * A fresh Response rather than `res.headers.set`, for the same reason
   * withSecurityHeaders builds one: a response handed back by the cache or by
   * the assets binding has immutable headers and mutating it throws. Copying
   * the headers works on every response, whatever produced it.
   *
   * On the canonical host this is the identity function and allocates nothing,
   * which is what every real request gets.
   */
  const stamp = (res: Response): Response => {
    if (!offCanonical) return res;
    const headers = new Headers(res.headers);
    headers.set('x-robots-tag', 'noindex, nofollow');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };

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
    if (hit) return stamp(hit);

    const res = await handle(req, site, url);
    const cc = res.headers.get('cache-control') ?? '';
    if (res.status === 200 && cc.includes('s-maxage')) {
      // waitUntil so the caller is not made to wait on the cache write.
      //
      // The UNSTAMPED response is what goes in, and the stamp is re-decided on
      // every read above. The cache is keyed by full URL, so the two hostnames
      // never share an entry and storing the stamped copy would work too — but
      // it would mean the header depended on which host happened to warm the
      // entry, which is the kind of thing that is true until somebody changes
      // the cache key.
      ctx.waitUntil(cache.put(req, res.clone()));
    }
    return stamp(res);
  }

  return stamp(await handle(req, site, url));
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
  // THE FRONT DOOR. Without this the assets binding answered `/` with the bare
  // SPA shell before the Worker was ever asked — no canonical, no heading and
  // no link — at the address every external link to this site points at.
  /^\/$/,
  /^\/near\//,
  /^\/near$/,
  // One pattern per metro, built from the same list the routes above are
  // built from. A literal /los-angeles here is what would silently hand a new
  // metro's URL to the assets binding — the SPA shell, with a 200 on it.
  ...METROS.map((m) => new RegExp(`^${metroPath(m).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)),
  /^\/book\//,
  /^\/webhooks\//,
  /^\/a\/stop\//,
  // The confirmation click from an alert email. Left out of this list the
  // assets binding answers it with the React shell and a 200, the address is
  // never confirmed, and the person who did exactly what the email asked never
  // hears from us again -- with nothing anywhere saying why.
  /^\/a\/confirm\//,
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
 * THE REACT APP'S OWN ROUTES — the ones the Worker does not render but the
 * app does draw a real page for.
 *
 * It exists to tell two kinds of unmatched path apart, because the fallback
 * below used to treat them identically and answer both with 200.
 *
 *   /about, /help, /account…   a page. The app renders it; 200 is correct.
 *   /aboot, /p/nobody, /xyzzy  nothing. The app renders NotFound; 404 is
 *                              correct, and 200 is a soft 404.
 *
 * The second set is unbounded — `<Route path="/:metro">` in web/src/App.tsx
 * matches ANY single segment, so every misspelling of every URL on the site
 * landed in it — and Google judges each one as a thin duplicate of everything
 * else answering the same way. The list below is read off App.tsx and has to
 * be kept beside it: a route added there and missed here is a real page
 * answering 404, which is the failure worth being loud about, and it is why
 * /app is matched by prefix rather than by its eleven separate routes.
 *
 * `/` and every path the Worker renders are absent on purpose: those are in
 * WORKER_PATHS above and never reach the fallback.
 */
const SPA_PATHS = [
  /^\/join\/?$/,
  /^\/covered\/?$/,
  /^\/safety\/?$/,
  /^\/pros\/?$/,
  /^\/about\/?$/,
  /^\/terms\/?$/,
  /^\/privacy\/?$/,
  /^\/help\/?$/,
  /^\/search\/?$/,
  /^\/signin\/?$/,
  /^\/auth\/verify\/?$/,
  /^\/account\/?$/,
  // One conversation, opened on the account rather than on a link. Behind a
  // customer session and listed nowhere public, so — exactly like /app above —
  // which ids exist is nobody's business but that customer's. The pattern is
  // deliberately one segment and not a prefix: /account itself is a real page
  // above, and a bare prefix would hand the SPA shell a 200 for every
  // misspelling of every future path under it, which is the soft-404 supply
  // the restamping below exists to stop.
  /^\/account\/messages\/[^/]+\/?$/,
  /^\/c\/[^/]+\/?$/,
  /^\/a\/?$/,
  /^\/a\/[^/]+\/?$/,
  // The signed-in operator app. Every path under it is behind a login wall and
  // Disallowed in robots.txt, so which of them exist is nobody's business but
  // the operator's and a prefix is the honest granularity.
  /^\/app(\/|$)/,
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
    /*
      THE SAME PATH IN LOWER CASE, TRIED SECOND.

      The patterns this router builds are case-sensitive, so `/Near/Sherman-
      Oaks` matched no route at all and fell through to the assets binding: the
      SPA shell, with a 200 on it, for an address that is a real page one
      capital letter away. `/near/Sherman-Oaks` was worse — it reached the
      route, found no such area, and answered a human with
      `{"error":"No such area."}` and a JSON content type.

      Exact case is tried FIRST and only then the lowered spelling, and that
      order is the whole safety of this. Half the path segments in this file
      are secrets — /o/:token, /c/:token, /a/:token, a guest thread, a photo
      store key — and lowering one of those is destroying it. A token in a URL
      whose STATIC prefix was typed in the wrong case is already not a link
      anybody was given, so the worst this can do to one is answer 404 where it
      answered 404 before.

      The pages then 301 to their own canonical spelling (see `toCanonical`),
      so the lowered match is a way in rather than a second address.
    */
    const lowered = url.pathname.toLowerCase();
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(url.pathname)
        ?? (lowered === url.pathname ? null : r.pattern.exec(lowered));
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
        //
        // IT ALSO DECIDES WHICH OF THE TWO DOORS THIS REQUEST CAME THROUGH,
        // and that is deliberately the same one place. A conversation is
        // reachable by the secret in the link OR, since migration 0052, by a
        // signed-in customer who owns it — and the second of those is worth
        // nothing if it has to be remembered on each of thirty routes. The
        // guard already resolved the segment to answer its own question, so
        // the answer is carried forward here instead of being recomputed.
        //
        // `{ via: 'link' }` is the default for every route with no token
        // segment, which is the only honest default: no account authorised
        // anything, so nothing downstream may claim one did.
        let door: ThreadDoor = { via: 'link' };
        if (params.token && GUEST_LINK_PATHS.test(url.pathname)) {
          door = await guardGuestLink(env, req, clientIp(req), params.token);
        }
        // The raw segment on the token door — so those handlers are unchanged,
        // duplicate lookup and all — and the already-authorised row on the
        // account door, which is the only thing the libraries cannot work out
        // for themselves from a URL.
        const ref: ThreadRef = door.via === 'account' ? door.thread : (params.token ?? '');
        return withCors(await r.handler({ req, env, params, url, ref, door }), req, env);
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

    /*
      Not a Worker route. If it is not in the Worker's own territory either, it
      belongs to the assets binding — either as a real file, or as the SPA
      shell, because not_found_handling is single-page-application and a path
      with no file behind it returns index.html.

      AND THAT LAST CASE IS WHERE THE STATUS HAS TO CHANGE. This used to return
      the assets response verbatim, so every address the site does not have
      answered 200 with the app in it: /xyzzy, /aboot, /p/nobody, and — because
      `<Route path="/:metro">` in App.tsx swallows any single segment — every
      misspelling of every URL on the site. Google calls a 200 for a page that
      does not exist a soft 404, judges each one as a thin duplicate of the
      others, and this was an unbounded supply of them.

      A real file keeps its own answer: only the SPA fallback — an HTML
      response for a path with no file — is restamped, and only when the path
      is not one of the app's own routes. The bytes are identical either way;
      the React app draws its not-found page over them, as it already does.
    */
    if (env.ASSETS && !WORKER_PATHS.some((p) => p.test(lowered))) {
      const res = await env.ASSETS.fetch(req);
      const isShell = res.status === 200
        && (res.headers.get('content-type') ?? '').includes('text/html');
      if (isShell && !SPA_PATHS.some((p) => p.test(lowered))) {
        return new Response(res.body, { status: 404, headers: res.headers });
      }
      return res;
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

    // BEFORE the expiry below, and that order is the whole point of it. A
    // parts charge is taken in the same request that records it, so a worker
    // killed in between leaves a customer charged $340 against a quote that
    // still reads 'sent'. Expiring that row makes the money unreachable, so
    // Stripe is asked about every quote about to expire first. See parts.ts.
    await step('reconcile parts charges', () => reconcileSentQuotes(env));

    // A quote left 'sent' forever is a live authorisation to charge somebody
    // for parts priced weeks ago. Expiring it costs the operator one tap to
    // resend. See parts.ts.
    await step('expire quotes', () => expireQuotes(env));

    // Orders whose money arrived and whose webhook did not. markPaid was
    // reachable from the webhook alone, so one failed delivery window — an
    // outage, a rotated signing secret — left a real charge with paid_at NULL
    // forever: nothing pays the business, nothing can refund the customer, and
    // no screen anywhere says so. See reconcileUnpaidOrders in checkout.ts.
    await step('reconcile unpaid orders', () => reconcileUnpaidOrders(env));

    // Money frozen by a cancellation, settled once its hold runs out. Silence
    // resolves to keeping the money and charging nobody, so that no pair of
    // people can profit by agreeing to say nothing. See settlement.ts.
    await step('settle holds', () => settleExpiredHolds(env));

    // And then the money actually moves, which for most of this product's life
    // it did not: refund_cents was decided at cancellation, shown to the
    // customer, written down, and never sent anywhere. This runs immediately
    // after the holds settle so a refund released on one tick is on its way
    // back on the same tick, and it is kept as a separate step because a
    // failure at Stripe must not be able to leave a hold unsettled.
    await step('refund released holds', () => sweepRefunds(env));

    // And the parts on those same cancellations, which are a SECOND charge
    // against a second intent and so need a second refund — the labour sweep
    // above works off orders.payment_intent_id and cannot reach them. Without
    // this a customer whose operator cancelled after they had approved a $340
    // alternator got the labour back and not the part. See sweepPartsRefunds.
    await step('refund parts on cancelled work', () => sweepPartsRefunds(env));

    // Businesses paid for work that has now happened. This used to run off the
    // payment webhook, which paid everybody days before the job and left the
    // platform refunding cancellations out of its own pocket. A line becomes
    // payable once its appointment is over and the window a cancellation could
    // still claim it in has closed. See settleDueWork in lib/checkout.ts.
    await step('pay for finished work', () => settleDueWork(env));

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

    // Sign-in codes and dead customer sessions. A used or expired code is a
    // permanent record that a particular number once signed in, held for no
    // purpose whatsoever, and a revoked session is the same. Both age out an
    // hour and a day past the point anything could accept them, so that a
    // request in flight when this runs still gets the refusal it would have
    // got rather than a different one.
    await step('sweep customer auth', () => sweepCustomerAuth(env));

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
