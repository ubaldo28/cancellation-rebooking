import { describe, expect, it } from 'vitest';
import {
  emailConfigured, emailProvider, looksLikeEmailAddress, sendEmail,
} from '../src/lib/email';
import type { Email } from '../src/lib/email';
import type { Env } from '../src/types';

/**
 * The rule this file exists to hold: UNCONFIGURED MEANS REFUSED, and a refusal
 * is a result rather than an exception.
 *
 * Email is the only door a business has. /api/auth/request mints a sign-in
 * link and emails it, so a deployment that cannot send is a deployment nobody
 * can sign in to — which is what EMAIL_PROVIDER = "none" made of the live
 * site. Every path that cannot deliver has to come back as `not_configured`,
 * which the route turns into an honest 503, rather than as a success, a throw,
 * or a link handed back to whoever asked for it.
 *
 * The half-configured cases are the ones worth pinning: a named provider with
 * no key is exactly what a real deployment looks like between deciding on
 * Resend and running `wrangler secret put`, and it must be an honest refusal
 * at the door rather than a 502 on the hot path of somebody signing in.
 */

const env = (over: Partial<Env>): Env => ({ ...over } as Env);

const live = env({
  EMAIL_PROVIDER: 'resend',
  EMAIL_API_KEY: 're_test_key',
  EMAIL_FROM: 'Round The Way <hello@roundtheway.app>',
});

const mail = (over: Partial<Email> = {}): Email => ({
  to: 'sam@example.com',
  subject: 'Your sign-in link',
  text: 'Sign in: https://roundtheway.app/auth/verify?token=abc',
  ...over,
});

/** A Resend stub that answers `codes` in order, one per call. */
function stub(codes: number[], body = '{"message":"Too many requests"}') {
  const calls: Array<Record<string, unknown>> = [];
  const headers: Array<Record<string, string>> = [];
  const previous = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    if (url === 'https://api.resend.com/emails') {
      calls.push(JSON.parse(String(init?.body ?? '{}')));
      headers.push({ ...(init?.headers ?? {}) });
      const status = codes[Math.min(i++, codes.length - 1)]!;
      return new Response(
        status === 200 ? JSON.stringify({ id: 'e1' }) : body,
        { status, headers: { 'content-type': 'application/json' } },
      );
    }
    return previous(input, init);
  }) as typeof fetch;
  return { calls, headers, restore: () => { globalThis.fetch = previous; } };
}

describe('which provider sends', () => {
  it('is the one named, not the one whose keys happen to exist', () => {
    // Inferring the provider from whichever secrets are present is how a
    // provider added later takes over silently. The name is the decision.
    const keysOnly = env({ EMAIL_API_KEY: 're_test_key', EMAIL_FROM: 'a@b.com' });
    expect(emailProvider(keysOnly)).toBeNull();
    expect(emailProvider(env({ ...keysOnly, EMAIL_PROVIDER: 'resend' }))).toBe('resend');
    expect(emailProvider(env({ ...keysOnly, EMAIL_PROVIDER: 'postmark' }))).toBe('postmark');
  });

  it('is nobody when unset, and nobody when explicitly none', () => {
    expect(emailProvider(env({}))).toBeNull();
    expect(emailProvider(env({ EMAIL_PROVIDER: 'none' }))).toBeNull();
    // Named "none" with a full set of working keys still sends nothing.
    expect(emailProvider(env({
      EMAIL_PROVIDER: 'none', EMAIL_API_KEY: 're_test_key', EMAIL_FROM: 'a@b.com',
    }))).toBeNull();
  });
});

describe('emailConfigured', () => {
  it('is false for a named provider with nothing behind it', () => {
    // The real halfway state: EMAIL_PROVIDER is committed to wrangler.toml, the
    // key is a secret somebody still has to set.
    expect(emailConfigured(env({ EMAIL_PROVIDER: 'resend' }))).toBe(false);
  });

  it('is false for a key with no from-address, and an address with no key', () => {
    expect(emailConfigured(env({ EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 're_k' }))).toBe(false);
    expect(emailConfigured(env({ EMAIL_PROVIDER: 'resend', EMAIL_FROM: 'a@b.com' }))).toBe(false);
  });

  it('is false when a value is only whitespace, or carries no address at all', () => {
    // An empty var in wrangler.toml arrives as '' and a half-edited one as a
    // display name with the address deleted. Both are a 422 at send time.
    expect(emailConfigured(env({
      EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 're_k', EMAIL_FROM: '   ',
    }))).toBe(false);
    expect(emailConfigured(env({
      EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: '  ', EMAIL_FROM: 'a@b.com',
    }))).toBe(false);
    expect(emailConfigured(env({
      EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 're_k', EMAIL_FROM: 'Round The Way',
    }))).toBe(false);
  });

  it('is true only when the named provider is complete', () => {
    expect(emailConfigured(live)).toBe(true);
  });
});

describe('sendEmail refuses rather than throwing', () => {
  /** Nothing here reaches the network: every case is refused before fetch. */
  const cases: Array<[string, Partial<Env>]> = [
    ['no provider named', {}],
    ['named none', { EMAIL_PROVIDER: 'none' }],
    ['resend with no key or address', { EMAIL_PROVIDER: 'resend' }],
    ['resend key but no from-address', { EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 're_k' }],
    ['postmark named with nothing behind it', { EMAIL_PROVIDER: 'postmark' }],
  ];

  for (const [name, over] of cases) {
    it(name, async () => {
      const s = stub([200]);
      try {
        const res = await sendEmail(env(over), mail());
        expect(res.sent).toBe(false);
        expect(res.sent === false && res.reason).toBe('not_configured');
        expect(s.calls).toHaveLength(0);
      } finally { s.restore(); }
    });
  }

  it('never reports provider_error for a configuration gap', async () => {
    // The distinction both callers depend on: 'not_configured' is our fault and
    // answers 503 with an explanation, while 'provider_error' means the
    // provider was reached and said no. src/lib/alerts.ts also refuses to count
    // 'not_configured' against a customer's address, because email being
    // switched off is a fact about this deployment and not about their mailbox.
    const res = await sendEmail(env({ EMAIL_PROVIDER: 'resend' }), mail());
    expect(res.sent === false && res.reason).not.toBe('provider_error');
  });

  it('turns a thrown network failure into a result', async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error('connection reset'); }) as typeof fetch;
    try {
      const res = await sendEmail(live, mail());
      expect(res.sent).toBe(false);
      expect(res.sent === false && res.reason).toBe('provider_error');
    } finally { globalThis.fetch = previous; }
  });
});

describe('the free-tier ceilings', () => {
  it('retries a 429 once and succeeds', async () => {
    // Resend allows about two requests a second. Two people pressing sign in
    // together is enough to hit it, and a moment later the second one goes.
    const s = stub([429, 200]);
    try {
      const res = await sendEmail(live, mail());
      expect(res.sent).toBe(true);
      expect(s.calls).toHaveLength(2);
    } finally { s.restore(); }
  }, 10_000);

  it('gives up after one retry rather than sleeping in a loop', async () => {
    const s = stub([429, 429]);
    try {
      const res = await sendEmail(live, mail());
      expect(res.sent).toBe(false);
      // Not 'provider_error': "try again in a moment" is true here and
      // "something went wrong" is not.
      expect(res.sent === false && res.reason).toBe('rate_limited');
      expect(s.calls).toHaveLength(2);
    } finally { s.restore(); }
  }, 10_000);

  it('does not retry the 100-a-day cap, which waiting a second cannot fix', async () => {
    // The ceiling that breaks on launch day. Still 'rate_limited' to the
    // caller — the sentence is the same — but a day does not roll over inside
    // a request, so the second attempt would only make the refusal slower.
    const s = stub([429, 200], '{"name":"daily_quota_exceeded","message":"limit reached"}');
    try {
      const res = await sendEmail(live, mail());
      expect(res.sent).toBe(false);
      expect(res.sent === false && res.reason).toBe('rate_limited');
      expect(s.calls).toHaveLength(1);
    } finally { s.restore(); }
  });

  it('does not retry a 403, which is the unverified sending domain', async () => {
    // The single most likely misconfiguration: the key is real, the domain in
    // EMAIL_FROM was never verified in Resend, and every send is refused.
    const s = stub([403, 200], '{"message":"domain is not verified"}');
    try {
      const res = await sendEmail(live, mail());
      expect(res.sent === false && res.reason).toBe('provider_error');
      expect(s.calls).toHaveLength(1);
    } finally { s.restore(); }
  });

  it('keeps the provider text in the log and out of the reason', async () => {
    // `detail` names the account and the sending domain, so the caller gets a
    // reason it can turn into a sentence and nothing it could echo verbatim.
    const s = stub([403, 403], '{"message":"hello@roundtheway.app is not verified"}');
    try {
      const res = await sendEmail(live, mail());
      expect(res.sent === false && res.detail).toContain('roundtheway.app');
      expect(res.sent === false && res.reason).toBe('provider_error');
    } finally { s.restore(); }
  });
});

describe('the destination address', () => {
  it('refuses a malformed address before spending a request on it', async () => {
    const s = stub([200]);
    try {
      const bad = [
        '', ' ', 'sam', 'sam@', '@example.com', 'sam@example',
        'sam @example.com', 'sam@exa mple.com',
        'sam@example.com, eve@evil.example',      // two addresses in a field of one
        'Sam <sam@example.com>',                  // a display name pasted in whole
        `${'a'.repeat(250)}@example.com`,         // past the 254-byte SMTP path
      ];
      for (const to of bad) {
        const res = await sendEmail(live, mail({ to }));
        expect(res.sent, to).toBe(false);
        expect(res.sent === false && res.reason, to).toBe('bad_address');
      }
      expect(s.calls).toHaveLength(0);
    } finally { s.restore(); }
  });

  it('accepts the addresses real people have', () => {
    for (const good of [
      'sam@example.com', 'sam.jones+alerts@example.co.uk',
      'sam_jones@mail.example.com', "o'brien@example.ie",
    ]) expect(looksLikeEmailAddress(good), good).toBe(true);
  });
});

describe('what Resend actually receives', () => {
  it('is the documented body: from, to as an array, subject, text, html', async () => {
    const s = stub([200]);
    try {
      const res = await sendEmail(live, mail({ html: '<p>Sign in</p>' }));
      expect(res).toEqual({ sent: true, provider: 'resend' });
      expect(s.calls[0]).toEqual({
        from: 'Round The Way <hello@roundtheway.app>',
        to: ['sam@example.com'],
        subject: 'Your sign-in link',
        text: 'Sign in: https://roundtheway.app/auth/verify?token=abc',
        html: '<p>Sign in</p>',
      });
      expect(s.headers[0]?.authorization).toBe('Bearer re_test_key');
      expect(s.headers[0]?.['content-type']).toBe('application/json');
    } finally { s.restore(); }
  });

  it('omits html entirely when there is none, rather than sending an empty part', async () => {
    const s = stub([200]);
    try {
      await sendEmail(live, mail());
      expect(s.calls[0]).not.toHaveProperty('html');
    } finally { s.restore(); }
  });
});
