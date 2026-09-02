import type { Env } from '../types';

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
 */

export type EmailResult =
  | { sent: true; provider: string }
  | { sent: false; reason: 'not_configured' | 'provider_error'; detail?: string };

export interface Email {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

async function sendResend(env: Env, m: Email): Promise<EmailResult> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.EMAIL_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM, to: [m.to], subject: m.subject,
      text: m.text, html: m.html ?? undefined,
    }),
  });
  if (!res.ok) {
    return { sent: false, reason: 'provider_error', detail: `resend ${res.status}` };
  }
  return { sent: true, provider: 'resend' };
}

async function sendPostmark(env: Env, m: Email): Promise<EmailResult> {
  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'X-Postmark-Server-Token': env.EMAIL_API_KEY ?? '',
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      From: env.EMAIL_FROM, To: m.to, Subject: m.subject,
      TextBody: m.text, HtmlBody: m.html ?? undefined,
      MessageStream: 'outbound',
    }),
  });
  if (!res.ok) {
    return { sent: false, reason: 'provider_error', detail: `postmark ${res.status}` };
  }
  return { sent: true, provider: 'postmark' };
}

export async function sendEmail(env: Env, m: Email): Promise<EmailResult> {
  const provider = env.EMAIL_PROVIDER ?? 'none';
  if (provider === 'none' || !env.EMAIL_API_KEY || !env.EMAIL_FROM) {
    return { sent: false, reason: 'not_configured' };
  }
  try {
    if (provider === 'resend') return await sendResend(env, m);
    if (provider === 'postmark') return await sendPostmark(env, m);
    return { sent: false, reason: 'not_configured' };
  } catch (e) {
    return { sent: false, reason: 'provider_error', detail: String(e) };
  }
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
  if (presentedToken !== debugToken) return false;

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
