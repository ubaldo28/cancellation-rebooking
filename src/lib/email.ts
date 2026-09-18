import type { Env } from '../types';
import { RATE_LIMIT_BACKOFF_MS, timingSafeEqual } from './util';

/**
 * Transactional email.
 *
 * The only thing this file has to get right is that a sign-in link NEVER
 * reaches anyone but the mailbox owner. The previous version returned the link
 * in the HTTP response so the flow could be exercised without a provider —
 * which meant anyone could type any email address and receive a working
 * session. That is an account takeover, not a placeholder, so the debug echo
 * now requires an explicitly set secret and is refused whenever APP_URL looks
 * like production.
 *
 * UNCONFIGURED MEANS REFUSED, and email is the one place where that is not a
 * merely defensive posture: /api/auth/request is the ONLY way a business signs
 * in. With EMAIL_PROVIDER = "none" nobody can reach their own account at all,
 * which is how this site shipped. The switch now names a real provider, and
 * every path that cannot actually deliver comes back as `not_configured` — a
 * result the caller turns into an honest 503 — rather than as a success, an
 * exception, or a silent no-op.
 *
 * Shaped deliberately like sendSms in ./sms.ts, which was hardened first: same
 * typed failure union, same retry-once-on-429, same cheap validation of the
 * destination before a request is spent on it, same rule that `detail` is for
 * the log and never for a caller.
 */

export type EmailProvider = 'resend' | 'postmark' | 'brevo';

/**
 * WHICH OF THE TWO SENDERS A MESSAGE GOES THROUGH.
 *
 * 'signin' is one message somebody is waiting on with a form open. 'bulk' is
 * the opening alerts, which are many and which nobody is watching for.
 *
 * They are separated because on a single provider they share one daily
 * allowance, and the alerts are the half that scales — so the alerts spend the
 * allowance and the sign-ins are what start failing. That is the wrong way
 * round: an alert that does not arrive is a missed opening, a sign-in that
 * does not arrive is a business locked out of its own account, on the day the
 * site is busiest.
 *
 * The default is 'signin' deliberately. A caller that has not thought about
 * which lane it wants is far more likely to be sending something a person is
 * waiting for than a mass mailing, and getting that wrong in this direction
 * costs an allowance rather than an account.
 */
export type EmailLane = 'signin' | 'bulk';

export type EmailResult =
  | { sent: true; provider: EmailProvider }
  | { sent: false; reason: EmailFailure; detail?: string };

/**
 * WHY THERE ARE FOUR OF THESE AND NOT ONE.
 *
 * The old union had two — 'not_configured' and 'provider_error' — so a
 * throttled send and a rejected send were the same word, and the caller's only
 * truthful sentence was "something went wrong". They are four different
 * sentences to two different people. 'not_configured' is our fault and nobody
 * outside should ever see the reason. 'bad_address' is the only one the person
 * typing can do anything about. 'rate_limited' means try again in a moment and
 * is TRUE, where "something went wrong" is not. 'provider_error' is everything
 * else and is the one that has to stay opaque, because Resend's own text names
 * the account and the sending domain.
 */
export type EmailFailure =
  | 'not_configured' | 'bad_address' | 'rate_limited' | 'provider_error';

/*
 * THE FREE-TIER CEILINGS, and why this file knows about them.
 *
 * Resend's free tier is 3,000 emails a month AND 100 A DAY, and the daily one
 * is the cap that breaks on the day the site is promoted rather than in some
 * distant month. On top of both sits a request-rate limit of about two a
 * second. All three answer 429, and only the last of them is fixed by waiting
 * a moment — so a 429 is retried ONCE, after slightly more than a second,
 * which is exactly long enough for a per-second window to roll over. Once, not
 * in a loop: if the ceiling is genuinely saturated, sleeping repeatedly inside
 * a request turns one person's slow sign-in into everybody's.
 *
 * A 429 that names the daily quota is not retried at all, because a day does
 * not roll over inside a request and the second attempt would only make the
 * refusal a second slower. Either way the caller gets 'rate_limited' and can
 * say something true — "we are over today's sending limit, try shortly" — in
 * place of a generic failure.
 *
 * The number itself is RATE_LIMIT_BACKOFF_MS in ./util, shared with sms.ts,
 * which sleeps for the same reason against Telnyx's own per-second window.
 * Both files used to declare it, with this paragraph written out twice.
 */

const trimmed = (v: string | undefined): string => (v ?? '').trim();

export interface Email {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** One attempt, plus whether sleeping and asking again could change the answer. */
interface Attempt { result: EmailResult; retryable: boolean }

const isProvider = (v: string | undefined): v is EmailProvider =>
  v === 'resend' || v === 'postmark' || v === 'brevo';

/**
 * Everything one lane needs to send: who, with which key, as which address.
 *
 * Resolved together rather than read one variable at a time, because the
 * failure this file exists to prevent is a HALF-configured lane — a key with
 * no from-address, a provider named with no key — reaching the network and
 * answering 422 on the hot path of a sign-in instead of refusing at the door.
 */
interface Lane { provider: EmailProvider; key: string; from: string }

/**
 * The bulk lane falls back to the sign-in lane whenever it is not COMPLETELY
 * set up — not named, no key, either one blank.
 *
 * Falling back rather than refusing, because a half-finished second provider
 * is what this looks like between signing up for Brevo and pasting its key in,
 * and alerts silently stopping during that window is a worse outcome than
 * alerts spending the sign-in allowance for an afternoon. One is invisible;
 * the other shows up as a quota and gets fixed.
 *
 * BULK_EMAIL_FROM is the one part that may be omitted on purpose: with both
 * providers verified for roundtheway.app, both send as the same address, and
 * repeating it in two variables is just a second place to get it wrong.
 */
function bulkLane(env: Env): Lane | null {
  const provider = env.BULK_EMAIL_PROVIDER;
  const key = trimmed(env.BULK_EMAIL_API_KEY);
  const from = trimmed(env.BULK_EMAIL_FROM) || trimmed(env.EMAIL_FROM);
  if (isProvider(provider) && key && from.includes('@')) return { provider, key, from };
  return null;
}

function signInLane(env: Env): Lane | null {
  const provider = env.EMAIL_PROVIDER;
  const key = trimmed(env.EMAIL_API_KEY);
  const from = trimmed(env.EMAIL_FROM);
  if (isProvider(provider) && key && from.includes('@')) return { provider, key, from };
  return null;
}

function lane(env: Env, which: EmailLane): Lane | null {
  return (which === 'bulk' ? bulkLane(env) : null) ?? signInLane(env);
}

/**
 * The provider this environment NAMES for a lane, or null for "do not send".
 *
 * Deliberately separate from emailConfigured below: this answers "who", and
 * that answers "can it actually deliver". A deployment naming Resend with no
 * key yet is a real state — it is what every deployment looks like between the
 * name being set and the secret being put — and the two questions have
 * different answers in it.
 *
 * The bulk lane is the exception, and it has to be: the second sender is USED
 * only when it is completely set up, so the honest answer to "who sends the
 * alerts" is the sign-in provider until Brevo's key is actually in place.
 */
export function emailProvider(env: Env, which: EmailLane = 'signin'): EmailProvider | null {
  if (which === 'bulk') {
    const bulk = bulkLane(env);
    if (bulk) return bulk.provider;
  }
  return isProvider(env.EMAIL_PROVIDER) ? env.EMAIL_PROVIDER : null;
}

/**
 * Whether an email can actually be delivered.
 *
 * Every field the provider needs, because it rejects a send that is missing
 * any of them, and a half-configured provider is the state that produces a 502
 * on the hot path of a sign-in rather than an honest refusal at the door. A
 * named provider with nothing behind it is NOT configured — that is the case
 * this returns false for, and the reason it checks the key rather than
 * trusting the name.
 *
 * EMAIL_FROM has to contain an address, not just be non-empty: it is a var in
 * wrangler.toml, an unset one arrives as '' and a half-edited one as a display
 * name with no address in it, and both of those are a 422 from the provider on
 * the sign-in path instead of a 503 at the door.
 */
export function emailConfigured(env: Env, which: EmailLane = 'signin'): boolean {
  return lane(env, which) !== null;
}

/**
 * An address worth spending a request on, checked before one is spent.
 *
 * Deliberately cheap and deliberately not RFC 5322: that grammar accepts
 * quoted local parts and bare hostnames that no mailbox in this product will
 * ever use, and every regex claiming to implement it is either wrong or
 * unreadable. This rejects the things that are certainly not deliverable —
 * nothing either side of the '@', whitespace, a comma or semicolon (two
 * addresses in a field that takes one), angle brackets (a display name that
 * was pasted into the address), a domain with no dot, and anything past the
 * 254-byte limit an SMTP path has anyway.
 *
 * Checking here rather than only at the door means a malformed address costs
 * one cheap comparison instead of a round trip, and it comes back as
 * 'bad_address' — the one failure the person typing can actually fix. It also
 * keeps a mistyped address in a watch from spending the sending domain's
 * reputation on a bounce.
 */
export function looksLikeEmailAddress(v: string): boolean {
  const s = v.trim();
  if (s.length < 6 || s.length > 254) return false;
  return /^[^\s@,;<>"]+@[^\s@,;<>".]+(\.[^\s@,;<>".]+)+$/.test(s);
}

/**
 * Sends one email.
 *
 * Never throws: a delivery failure is an answer the caller has to make a
 * decision about, not an exception to be caught three frames up by something
 * that will log it and carry on. Both callers depend on that — the sign-in
 * route turns the result into a 503 or a 502, and the alerts sweep counts
 * refusals against an address, so an exception thrown from here would abandon
 * the rest of the sweep.
 *
 * `detail` is for the log and is deliberately never returned to a caller.
 * Resend's error text names the account and the sending domain, and neither
 * belongs in a response to whoever typed an address into a form.
 */
export async function sendEmail(
  env: Env, m: Email, which: EmailLane = 'signin',
): Promise<EmailResult> {
  const l = lane(env, which);
  if (!l) return { sent: false, reason: 'not_configured' };
  if (!looksLikeEmailAddress(m.to)) return { sent: false, reason: 'bad_address' };

  const first = await attempt(l, m);
  if (!first.retryable) return first.result;

  // THE BULK LANE DOES NOT SLEEP.
  //
  // Retrying costs a second of wall time, which is worth spending when one
  // person is watching a form. The alerts sweep is a cron job sending to many
  // people in one invocation: a provider that has started answering 429 will
  // answer it for the next one too, so this would add a second per alert to a
  // run that is already refused, and burn the invocation's time budget on
  // messages that will not go. The sweep runs again in fifteen minutes, and
  // alerts.ts deliberately does not count 'rate_limited' against an address.
  if (which === 'bulk') return first.result;

  await new Promise((r) => setTimeout(r, RATE_LIMIT_BACKOFF_MS));
  return (await attempt(l, m)).result;
}

async function attempt(l: Lane, m: Email): Promise<Attempt> {
  const { provider } = l;
  try {
    const res = provider === 'resend' ? await postResend(l, m)
      : provider === 'brevo' ? await postBrevo(l, m)
      : await postPostmark(l, m);
    if (res.ok) return { result: { sent: true, provider }, retryable: false };

    // The body carries the provider's own reason — a domain that was never
    // verified, a key that belongs to another account, a quota that ran out.
    // Worth having in the log, because the status alone does not separate
    // those, and worth reading here because it is what tells a per-second
    // throttle apart from the daily cap.
    let body = '';
    try { body = (await res.text()).slice(0, 300); } catch { /* body already read */ }
    const detail = `${provider} ${res.status}${body ? ` ${body}` : ''}`;

    if (res.status !== 429) {
      return { result: { sent: false, reason: 'provider_error', detail }, retryable: false };
    }
    // 'daily_quota_exceeded' is Resend's name for the 100-a-day ceiling and
    // Brevo says the day's allowance is spent in words of its own. Either is
    // still 'rate_limited' to the caller — "try again shortly" is true of both
    // — but retrying inside this request cannot help, because a day does not
    // roll over in a second.
    const daily = /daily_quota|quota_exceeded|daily limit|plan limit/i.test(body);
    return { result: { sent: false, reason: 'rate_limited', detail }, retryable: !daily };
  } catch (e) {
    // A network failure, not a refusal. Retrying it here would double the time
    // a sign-in takes to fail, and the caller can already say "try again".
    return {
      result: { sent: false, reason: 'provider_error', detail: String(e) },
      retryable: false,
    };
  }
}

/**
 * Resend.
 *
 * One JSON POST with a bearer key, which is what its current API takes:
 * POST https://api.resend.com/emails with {from, to, subject, html|text}.
 * `to` is an array — a single string is accepted too, but the array is the
 * documented shape and is what a second recipient would need.
 *
 * The address inside EMAIL_FROM has to sit on a domain VERIFIED in the Resend
 * dashboard. An unverified domain does not fail quietly or partially: every
 * send answers 403, so the whole of sign-in is down until the DNS records are
 * in place. That is the single most likely way this is misconfigured.
 */
function postResend(l: Lane, m: Email): Promise<Response> {
  const body: Record<string, unknown> = {
    from: l.from,
    to: [m.to.trim()],
    subject: m.subject,
    text: m.text,
  };
  // Only when there is one. JSON.stringify already drops an undefined value,
  // but Resend rejects an explicit null, and an empty html part is worse than
  // none: some clients render the empty part and show a blank message.
  if (m.html) body.html = m.html;

  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${l.key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

/**
 * Splits 'Round The Way <hello@roundtheway.app>' into its two halves.
 *
 * Resend and Postmark take that one string as-is. Brevo does not: its sender
 * is an object with separate name and email fields, and handing it the whole
 * string as an address is a 400 on every send. A bare address with no display
 * name is fine and comes back with the name omitted.
 */
function splitFrom(from: string): { email: string; name?: string } {
  const m = /^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/.exec(from);
  if (!m) return { email: from.trim() };
  const name = m[1]!.replace(/^"|"$/g, '').trim();
  const email = m[2]!.trim();
  return name ? { email, name } : { email };
}

/**
 * Brevo, which carries the opening alerts.
 *
 * Chosen for this lane and not the sign-in lane for one reason: its free
 * allowance is 300 a day rather than 100, and alerts are the half of this
 * site's email that scales with how well it is doing.
 *
 * The reason it is NOT the sign-in sender is the other half of the same fact.
 * Past the daily allowance Brevo does not refuse a transactional message
 * outright, it QUEUES it — which is the right behaviour for an alert about an
 * opening and the wrong behaviour for a sign-in link, where a message that
 * arrives late is a person who has already given up and a link that may have
 * expired before it landed.
 *
 * Its key goes in an 'api-key' header rather than a bearer, and its fields are
 * named unlike either of the others.
 */
function postBrevo(l: Lane, m: Email): Promise<Response> {
  const body: Record<string, unknown> = {
    sender: splitFrom(l.from),
    to: [{ email: m.to.trim() }],
    subject: m.subject,
    textContent: m.text,
  };
  if (m.html) body.htmlContent = m.html;

  return fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': l.key,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
}

/**
 * Postmark, kept as the second option rather than the one in use.
 *
 * Its token is a header of its own rather than a bearer, and its fields are
 * capitalised. MessageStream 'outbound' is the transactional stream every
 * server has by default; sending sign-in links down a broadcast stream is how
 * they end up filtered as marketing.
 */
function postPostmark(l: Lane, m: Email): Promise<Response> {
  const body: Record<string, unknown> = {
    From: l.from,
    To: m.to.trim(),
    Subject: m.subject,
    TextBody: m.text,
    MessageStream: 'outbound',
  };
  if (m.html) body.HtmlBody = m.html;

  return fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'X-Postmark-Server-Token': l.key,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
}

/**
 * Whether it is safe to hand the caller a sign-in link directly.
 *
 * Two independent conditions, both required:
 *   1. AUTH_DEBUG_TOKEN is set as a secret AND the caller presented it.
 *   2. APP_URL is localhost. NOT *.workers.dev — that used to be treated as a
 *      preview host, but a workers.dev address is a real, publicly reachable
 *      deployment. Allowing the echo there would mean anyone who learned the
 *      debug secret could sign in as any operator on the live site.
 *
 * Either one alone is not enough. Forgetting to unset a flag is the normal
 * way this kind of hole reaches production, so production is identified by
 * the URL the app actually runs on, not by a flag someone has to remember.
 */
export function mayEchoSignInLink(env: Env, presentedToken: string | null): boolean {
  const debugToken = env.AUTH_DEBUG_TOKEN;
  if (!debugToken || !presentedToken) return false;
  if (debugToken.length < 16) return false;         // refuse a guessable token
  // Constant time: `!==` on a secret returns as soon as it finds a differing
  // byte, so the time it takes to say no measures how much of the token the
  // caller already has, and a caller who can measure that can extend a guess
  // one character at a time until it is the whole secret.
  if (!timingSafeEqual(presentedToken, debugToken)) return false;

  let host: string;
  try { host = new URL(env.APP_URL).hostname; } catch { return false; }
  const isLocal =
    host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost');
  return isLocal;
}

export function signInEmail(link: string, businessName: string | null): Email {
  const who = businessName ? ` for ${businessName}` : '';
  return {
    to: '',   // filled by the caller
    subject: 'Your sign-in link',
    text:
      `Sign in${who}:\n\n${link}\n\n` +
      `This link works once and expires in 15 minutes.\n` +
      `If you didn't ask for it, you can ignore this email.`,
    html:
      `<p>Sign in${who}:</p>` +
      `<p><a href="${link}">Sign in</a></p>` +
      `<p style="color:#666;font-size:14px">This link works once and expires in 15 minutes. ` +
      `If you didn't ask for it, you can ignore this email.</p>`,
  };
}
