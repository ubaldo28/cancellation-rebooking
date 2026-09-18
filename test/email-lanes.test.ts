import { describe, expect, it } from 'vitest';
import { emailConfigured, emailProvider, sendEmail } from '../src/lib/email';
import type { Env } from '../src/types';

/**
 * THE RULE THIS FILE EXISTS TO HOLD: ALERTS MUST NEVER SPEND THE SIGN-IN
 * ALLOWANCE.
 *
 * Both halves of this site's email leave through the same function, and on one
 * provider they share one daily quota. The alerts are the half that grows with
 * how well the site is doing; the sign-in link is the ONLY way a business
 * reaches its own account. Sharing a quota means a good afternoon locks
 * businesses out — the failure lands on the wrong people, at the worst
 * possible moment, and looks like the site being broken rather than busy.
 *
 * So the lanes are separate, and the direction of the separation is what
 * matters: alerts may fall back onto the sign-in provider, but a sign-in link
 * must NEVER go out through the bulk one, no matter how it is configured.
 */

const env = (over: Partial<Env>): Env => ({ ...over } as Env);

const SIGNIN = {
  EMAIL_PROVIDER: 'resend',
  EMAIL_API_KEY: 're_test',
  EMAIL_FROM: 'Round The Way <hello@roundtheway.app>',
} as const;

const BULK = {
  BULK_EMAIL_PROVIDER: 'brevo',
  BULK_EMAIL_API_KEY: 'xkeysib-test',
} as const;

const RESEND = 'https://api.resend.com/emails';
const BREVO = 'https://api.brevo.com/v3/smtp/email';
const POSTMARK = 'https://api.postmarkapp.com/email';

/** Records every send and answers each call with the next code in `codes`. */
function stub(codes: number[] = [200]) {
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const previous = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    if (url === RESEND || url === BREVO || url === POSTMARK) {
      calls.push({
        url,
        body: JSON.parse(String(init?.body ?? '{}')),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      const status = codes[Math.min(i++, codes.length - 1)]!;
      return new Response(
        status === 200 ? '{"id":"m"}' : '{"message":"nope"}',
        { status, headers: { 'content-type': 'application/json' } },
      );
    }
    return previous(input, init);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = previous; } };
}

const mail = { to: 'someone@example.com', subject: 's', text: 't' };

describe('which lane sends', () => {
  it('sends alerts through the bulk provider and sign-ins through the other', async () => {
    const s = stub();
    try {
      const e = env({ ...SIGNIN, ...BULK });
      await sendEmail(e, mail, 'bulk');
      await sendEmail(e, mail, 'signin');
      expect(s.calls.map((c) => c.url)).toEqual([BREVO, RESEND]);
    } finally { s.restore(); }
  });

  it('never lets a sign-in link out through the bulk provider', async () => {
    // The one-way rule. Even with the bulk lane fully set up and the default
    // argument left off, the sign-in link goes through EMAIL_PROVIDER.
    const s = stub();
    try {
      await sendEmail(env({ ...SIGNIN, ...BULK }), mail);
      expect(s.calls).toHaveLength(1);
      expect(s.calls[0]!.url).toBe(RESEND);
    } finally { s.restore(); }
  });

  it('falls back to the sign-in provider when the bulk lane is half set up', async () => {
    // What a deployment looks like between signing up for Brevo and putting
    // the key in. Alerts keep going rather than silently stopping.
    const s = stub();
    try {
      const named = env({ ...SIGNIN, BULK_EMAIL_PROVIDER: 'brevo' });   // no key
      await sendEmail(named, mail, 'bulk');

      const keyed = env({ ...SIGNIN, BULK_EMAIL_API_KEY: 'xkeysib' });  // no name
      await sendEmail(keyed, mail, 'bulk');

      expect(s.calls.map((c) => c.url)).toEqual([RESEND, RESEND]);
    } finally { s.restore(); }
  });

  it('refuses both lanes when the sign-in lane is not configured at all', async () => {
    // The bulk lane alone is not enough to make the site able to send: with no
    // sign-in provider there is nothing to fall back to, and an unconfigured
    // send has to be an honest refusal rather than an exception.
    const s = stub();
    try {
      const only = env(BULK);
      expect((await sendEmail(only, mail, 'bulk')).sent).toBe(false);
      expect((await sendEmail(only, mail)).sent).toBe(false);
      expect(s.calls).toHaveLength(0);
    } finally { s.restore(); }
  });

  it('reports who each lane belongs to', () => {
    const both = env({ ...SIGNIN, ...BULK });
    expect(emailProvider(both)).toBe('resend');
    expect(emailProvider(both, 'bulk')).toBe('brevo');

    // Half-configured bulk reports the provider that will ACTUALLY send it,
    // not the one that was hopefully named.
    const half = env({ ...SIGNIN, BULK_EMAIL_PROVIDER: 'brevo' });
    expect(emailProvider(half, 'bulk')).toBe('resend');

    expect(emailConfigured(both, 'bulk')).toBe(true);
    expect(emailConfigured(env(BULK), 'bulk')).toBe(false);
  });
});

describe('the bulk from-address', () => {
  it('uses EMAIL_FROM when BULK_EMAIL_FROM is not given', async () => {
    // Both providers are verified for the same domain, so repeating the
    // address in a second variable is only a second place to get it wrong.
    const s = stub();
    try {
      await sendEmail(env({ ...SIGNIN, ...BULK }), mail, 'bulk');
      expect(s.calls[0]!.body.sender).toEqual(
        { email: 'hello@roundtheway.app', name: 'Round The Way' });
    } finally { s.restore(); }
  });

  it('uses BULK_EMAIL_FROM when it is', async () => {
    const s = stub();
    try {
      await sendEmail(
        env({ ...SIGNIN, ...BULK, BULK_EMAIL_FROM: 'alerts@roundtheway.app' }),
        mail, 'bulk');
      expect(s.calls[0]!.body.sender).toEqual({ email: 'alerts@roundtheway.app' });
    } finally { s.restore(); }
  });
});

describe('what Brevo is actually sent', () => {
  it('uses its own field names and its own header, not a bearer token', async () => {
    // Brevo takes a sender OBJECT, names the parts textContent/htmlContent,
    // and authenticates with an 'api-key' header. Handing it Resend's shape is
    // a 400 on every send, which is exactly the kind of failure that only
    // shows up once alerts are switched on for real.
    const s = stub();
    try {
      await sendEmail(
        env({ ...SIGNIN, ...BULK }),
        { to: 'a@b.com', subject: 'An opening near you', text: 'plain', html: '<p>rich</p>' },
        'bulk');

      const call = s.calls[0]!;
      expect(call.body).toEqual({
        sender: { email: 'hello@roundtheway.app', name: 'Round The Way' },
        to: [{ email: 'a@b.com' }],
        subject: 'An opening near you',
        textContent: 'plain',
        htmlContent: '<p>rich</p>',
      });
      expect(call.headers['api-key']).toBe('xkeysib-test');
      expect(call.headers.authorization).toBeUndefined();
    } finally { s.restore(); }
  });

  it('omits htmlContent rather than sending an empty one', async () => {
    const s = stub();
    try {
      await sendEmail(env({ ...SIGNIN, ...BULK }), mail, 'bulk');
      expect('htmlContent' in s.calls[0]!.body).toBe(false);
    } finally { s.restore(); }
  });
});

describe('being throttled', () => {
  it('does not sleep and retry on the bulk lane', async () => {
    // The alerts sweep is a cron job sending to many people in one invocation.
    // A provider answering 429 will answer it for the next one too, so a retry
    // per alert spends the invocation's time budget on messages that will not
    // go. The sweep runs again in fifteen minutes.
    const s = stub([429, 200]);
    try {
      const res = await sendEmail(env({ ...SIGNIN, ...BULK }), mail, 'bulk');
      expect(res.sent).toBe(false);
      expect(res.sent === false && res.reason).toBe('rate_limited');
      expect(s.calls).toHaveLength(1);
    } finally { s.restore(); }
  });

  it('still retries once on the sign-in lane, where somebody is waiting', async () => {
    const s = stub([429, 200]);
    try {
      const res = await sendEmail(env({ ...SIGNIN, ...BULK }), mail, 'signin');
      expect(res.sent).toBe(true);
      expect(s.calls).toHaveLength(2);
      expect(s.calls.every((c) => c.url === RESEND)).toBe(true);
    } finally { s.restore(); }
  }, 10_000);
});
