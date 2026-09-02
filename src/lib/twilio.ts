import type { Env } from '../types';
import { timingSafeEqual } from './util';

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
