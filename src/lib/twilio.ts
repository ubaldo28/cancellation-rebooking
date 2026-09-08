import type { Env } from '../types';
import { timingSafeEqual } from './util';

/**
 * Twilio: the inbound half was here already, and now the outbound half is too.
 *
 * WHAT WAS ACTUALLY CONFIGURED, BECAUSE IT IS WORTH SAYING PLAINLY. Nothing.
 * This file verified the signature on Twilio's webhooks and there was no code
 * anywhere in the Worker that sent a message. An offer to a client is written
 * to message_log with status 'queued' or 'handed_off' and waits for something
 * that does not exist to pick it up, which is fine for an offer -- it is a
 * nicety that degrades to the operator texting somebody themselves. It is not
 * fine for a sign-in code, because a code that is never delivered and a code
 * that is never checked look identical from outside, and one of them lets
 * anybody in.
 *
 * So sendSms is shaped exactly like sendEmail in ./email.ts -- a result, never
 * an exception, with 'not_configured' as a distinct reason -- and the caller
 * that mints a session is required to treat 'not_configured' as a refusal.
 * That is the difference this file is careful about: ./turnstile.ts is inert
 * when its secret is missing and the forms behind it are simply as open as
 * they were before, which is a defensible trade for a bot check. It is not a
 * defensible trade for the credential that creates an account and holds a
 * card. Unconfigured here means REFUSED, in the same way an unsigned Stripe
 * webhook means 503 rather than "process it anyway for now".
 */

/**
 * Whether a text message can actually be delivered.
 *
 * All three, because Twilio rejects a send that is missing any of them and a
 * half-configured provider is the state that produces a 502 on the hot path of
 * a sign-in rather than an honest refusal at the door.
 */
export const smsConfigured = (env: Env): boolean =>
  !!env.TWILIO_ACCOUNT_SID?.trim()
  && !!env.TWILIO_AUTH_TOKEN?.trim()
  && !!env.TWILIO_FROM?.trim();

export type SmsResult =
  | { sent: true; provider: 'twilio' }
  | { sent: false; reason: 'not_configured' | 'provider_error'; detail?: string };

/**
 * Sends one text message.
 *
 * Never throws: a delivery failure is an answer the caller has to make a
 * decision about, not an exception to be caught three frames up by something
 * that will log it and carry on. The detail is for the log and is deliberately
 * never returned to a caller -- Twilio's error text names the account and the
 * from-number, and neither belongs in a response to whoever typed a phone
 * number into a form.
 */
export async function sendSms(env: Env, to: string, textBody: string): Promise<SmsResult> {
  if (!smsConfigured(env)) return { sent: false, reason: 'not_configured' };

  const sid = env.TWILIO_ACCOUNT_SID!.trim();
  const form = new URLSearchParams({
    To: to, From: env.TWILIO_FROM!.trim(), Body: textBody,
  });

  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${btoa(`${sid}:${env.TWILIO_AUTH_TOKEN!.trim()}`)}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      },
    );
    if (!res.ok) {
      return { sent: false, reason: 'provider_error', detail: `twilio ${res.status}` };
    }
    return { sent: true, provider: 'twilio' };
  } catch (e) {
    return { sent: false, reason: 'provider_error', detail: String(e) };
  }
}

/**
 * Twilio webhook signature validation.
 *
 * Without this, the inbound webhook is an open endpoint: anyone who guesses the
 * URL can POST `From=<a client's number>&Body=STOP` and silently opt that
 * client out of every future offer, or forge delivery receipts.
 *
 * Twilio's scheme: take the full request URL, append each POST parameter's
 * name and value in alphabetical order by name with no separators, HMAC-SHA1
 * with the account auth token, base64 the result, compare to X-Twilio-Signature.
 */
export async function verifyTwilioSignature(
  req: Request, env: Env, form: FormData,
): Promise<boolean> {
  const token = env.TWILIO_AUTH_TOKEN;
  if (!token) return false;                       // unconfigured means untrusted

  const provided = req.headers.get('x-twilio-signature');
  if (!provided) return false;

  // Twilio signs the URL it was configured with. Behind Cloudflare the request
  // URL should already be the public https:// one, but force the scheme so a
  // proxy that hands us http:// does not silently break every signature.
  const url = new URL(req.url);
  url.protocol = 'https:';
  url.port = '';

  const params: Array<[string, string]> = [];
  for (const [k, v] of form.entries()) params.push([k, typeof v === 'string' ? v : '']);
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const payload = url.toString() + params.map(([k, v]) => k + v).join('');

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(token),
    { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));

  return timingSafeEqual(expected, provided);
}
