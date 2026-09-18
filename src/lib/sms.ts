import type { Env } from '../types';
import { RATE_LIMIT_BACKOFF_MS } from './util';

/**
 * Sending one text message. Telnyx.
 *
 * UNCONFIGURED MEANS REFUSED. Shaped exactly like sendEmail in ./email.ts — a
 * result, never an exception, with 'not_configured' as its own reason — and
 * the caller that mints a session is required to treat that reason as a
 * refusal rather than a warning. ./turnstile.ts is inert when its secret is
 * missing and the forms behind it are merely as open as they were before,
 * which is a defensible trade for a bot check. It is not a defensible trade
 * for the credential that creates an account and holds a card: a code that is
 * never delivered and a code that is never checked look identical from
 * outside, and one of them lets anybody in.
 *
 * THE PROVIDER IS NAMED, NOT GUESSED. `SMS_PROVIDER` picks it, so a
 * deployment carrying a key but no number is honestly unconfigured rather than
 * half-live, and adding a second provider later cannot silently take over by
 * having its keys present.
 */

export type SmsProvider = 'telnyx';

export type SmsResult =
  | { sent: true; provider: SmsProvider }
  | { sent: false; reason: SmsFailure; detail?: string };

/**
 * WHY THERE ARE FOUR OF THESE AND NOT ONE.
 *
 * They are four different sentences to two different people. 'not_configured'
 * is our fault and nobody outside should ever see the reason. 'bad_number' is
 * the only one the person typing can do anything about. 'rate_limited' means
 * try again in a moment and is TRUE, where "something went wrong" is not.
 * 'provider_error' is everything else and is the one that has to stay opaque,
 * because Telnyx's own text names the account and the sending number.
 */
export type SmsFailure =
  | 'not_configured' | 'bad_number' | 'rate_limited' | 'provider_error';

/*
 * THE SOLE-PROPRIETOR THROUGHPUT CEILING, and why this file knows about it.
 *
 * A Sole Proprietor 10DLC campaign is capped at ONE MESSAGE PER SECOND. That
 * is not a queue that fills up, it is a hard refusal: the second send inside
 * the same second comes back 429 and is not delivered. Two people reaching the
 * sign-in page together is enough, and on the day the site is promoted it is
 * the normal case rather than the unlucky one.
 *
 * So a 429 is retried once, after slightly more than a second, which is
 * exactly long enough for a one-per-second window to roll over. Once, not in a
 * loop: if the cap is genuinely saturated, sleeping repeatedly inside a
 * request turns one person's slow sign-in into everybody's.
 *
 * The number itself is RATE_LIMIT_BACKOFF_MS in ./util, shared with email.ts,
 * which sleeps for the same reason against Resend's per-second window. Both
 * files used to declare it, with this paragraph written out twice.
 */

const trimmed = (v: string | undefined): string => (v ?? '').trim();

/** The provider this environment names, or null for "do not send". */
export function smsProvider(env: Env): SmsProvider | null {
  const named = env.SMS_PROVIDER;
  if (named === 'none') return null;
  if (named === 'telnyx') return named;
  return null;
}

/**
 * Whether a text message can actually be delivered.
 *
 * Every field Telnyx needs, because it rejects a send that is missing any of
 * them, and a half-configured provider is the state that
 * produces a 502 on the hot path of a sign-in rather than an honest refusal at
 * the door. A named provider with nothing behind it is NOT configured — that
 * is the case this returns false for and the reason it checks the keys rather
 * than trusting the name.
 */
export function smsConfigured(env: Env): boolean {
  if (smsProvider(env) !== 'telnyx') return false;
  return !!trimmed(env.TELNYX_API_KEY) && !!trimmed(env.TELNYX_FROM);
}

/**
 * Sends one text message.
 *
 * Never throws: a delivery failure is an answer the caller has to make a
 * decision about, not an exception to be caught three frames up by something
 * that will log it and carry on.
 *
 * `detail` is for the log and is deliberately never returned to a caller.
 * Telnyx's error text names the account and the from-number, and neither
 * belongs in a response to whoever typed a phone number into a form.
 */
export async function sendSms(env: Env, to: string, textBody: string): Promise<SmsResult> {
  if (!smsProvider(env) || !smsConfigured(env)) {
    return { sent: false, reason: 'not_configured' };
  }
  if (!looksLikeE164(to)) return { sent: false, reason: 'bad_number' };

  const first = await sendTelnyx(env, to, textBody);
  if (first.sent || (first as { reason: SmsFailure }).reason !== 'rate_limited') return first;

  await new Promise((r) => setTimeout(r, RATE_LIMIT_BACKOFF_MS));
  return sendTelnyx(env, to, textBody);
}

/**
 * A number Telnyx will accept, checked before it is spent on a request.
 *
 * The route above this already refuses anything without a leading '+', which
 * is most of the job. This is the rest of it: E.164 is a plus, a country code
 * that cannot start with a zero, and up to fifteen digits in total. Checking
 * here rather than only at the door means a malformed number costs one cheap
 * comparison instead of a round trip to a carrier, and it comes back as
 * 'bad_number' — the one failure the person typing can actually fix.
 */
export const looksLikeE164 = (v: string): boolean => /^\+[1-9]\d{6,14}$/.test(v.trim());

/**
 * Telnyx.
 *
 * One JSON POST with a bearer key. The number in TELNYX_FROM has to be one
 * this account owns AND has to sit on a messaging profile — a number bought
 * but never attached to a profile answers 422 here, which is the single most
 * likely way this is misconfigured.
 */
async function sendTelnyx(env: Env, to: string, textBody: string): Promise<SmsResult> {
  try {
    const res = await fetch('https://api.telnyx.com/v2/messages', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${trimmed(env.TELNYX_API_KEY)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ from: trimmed(env.TELNYX_FROM), to, text: textBody }),
    });
    if (!res.ok) {
      // The body carries Telnyx's own reason — a suspended number, a profile
      // that is not attached, a campaign that is not registered. Worth having
      // in the log, because the status alone does not separate those.
      let detail = `telnyx ${res.status}`;
      try { detail += ` ${(await res.text()).slice(0, 300)}`; } catch { /* body already read */ }
      // 429 is the throughput ceiling and is worth retrying; 422 usually means
      // the number is not on a messaging profile, which retrying cannot fix.
      const reason: SmsFailure = res.status === 429 ? 'rate_limited' : 'provider_error';
      return { sent: false, reason, detail };
    }
    return { sent: true, provider: 'telnyx' };
  } catch (e) {
    return { sent: false, reason: 'provider_error', detail: String(e) };
  }
}
