import { describe, expect, it } from 'vitest';
import { smsConfigured, smsProvider, sendSms } from '../src/lib/sms';
import type { Env } from '../src/types';

/**
 * The rule this file exists to hold: UNCONFIGURED MEANS REFUSED.
 *
 * A sign-in code that is never delivered and a sign-in code that is never
 * checked look identical from outside the product, and one of them lets
 * anybody in. So every path that cannot actually deliver has to come back as
 * `not_configured` — which src/lib/customers.ts turns into a 503 — rather than
 * as a success, an exception, or a silent no-op.
 *
 * The half-configured cases are the ones worth pinning. A key with no number
 * is exactly what a real deployment looks like between buying the key and
 * buying the number, and it must be an honest refusal at the door rather than
 * a 502 on the hot path of somebody trying to sign in.
 */

const env = (over: Partial<Env>): Env => ({ ...over } as Env);

describe('which provider sends', () => {
  it('is the one named, not the one whose keys happen to exist', () => {
    // Keys present but nobody named: nothing sends. Inferring the provider
    // from whichever secrets exist is how a second provider added later takes
    // over silently, so the name is the decision and the keys are not.
    const keysOnly = env({ TELNYX_API_KEY: 'KEYtest', TELNYX_FROM: '+18185550142' });
    expect(smsProvider(keysOnly)).toBeNull();
    expect(smsProvider(env({ ...keysOnly, SMS_PROVIDER: 'telnyx' }))).toBe('telnyx');
  });

  it('is nobody when unset, and nobody when explicitly none', () => {
    expect(smsProvider(env({}))).toBeNull();
    expect(smsProvider(env({ SMS_PROVIDER: 'none' }))).toBeNull();
    // Named "none" with a full set of working keys still sends nothing. The
    // switch is the decision; the keys are not.
    expect(smsProvider(env({
      SMS_PROVIDER: 'none', TELNYX_API_KEY: 'KEYtest', TELNYX_FROM: '+18185550142',
    }))).toBeNull();
  });
});

describe('smsConfigured', () => {
  it('is false for a named provider with nothing behind it', () => {
    expect(smsConfigured(env({ SMS_PROVIDER: 'telnyx' }))).toBe(false);
  });

  it('is false for a Telnyx key with no number, which is the real halfway state', () => {
    expect(smsConfigured(env({ SMS_PROVIDER: 'telnyx', TELNYX_API_KEY: 'KEYtest' }))).toBe(false);
    expect(smsConfigured(env({ SMS_PROVIDER: 'telnyx', TELNYX_FROM: '+18185550142' }))).toBe(false);
  });

  it('is false when a value is only whitespace', () => {
    // An empty var in wrangler.toml arrives as '' and a fat-fingered one as ' '.
    // Neither is a number, and both would produce a provider error at send time.
    expect(smsConfigured(env({
      SMS_PROVIDER: 'telnyx', TELNYX_API_KEY: 'KEYtest', TELNYX_FROM: '   ',
    }))).toBe(false);
  });

  it('is true only when the named provider is complete', () => {
    expect(smsConfigured(env({
      SMS_PROVIDER: 'telnyx', TELNYX_API_KEY: 'KEYtest', TELNYX_FROM: '+18185550142',
    }))).toBe(true);
  });
});

describe('sendSms refuses rather than throwing', () => {
  /** Nothing here reaches the network: every case is refused before fetch. */
  const cases: Array<[string, Partial<Env>]> = [
    ['no provider named', {}],
    ['named none', { SMS_PROVIDER: 'none' }],
    ['telnyx with no key or number', { SMS_PROVIDER: 'telnyx' }],
    ['telnyx key but no number', { SMS_PROVIDER: 'telnyx', TELNYX_API_KEY: 'KEYtest' }],
  ];

  for (const [name, over] of cases) {
    it(name, async () => {
      const res = await sendSms(env(over), '+18185550100', 'test');
      expect(res.sent).toBe(false);
      expect(res.sent === false && res.reason).toBe('not_configured');
    });
  }

  it('never reports provider_error for a configuration gap', async () => {
    // The distinction the caller depends on: 'not_configured' is our fault and
    // answers 503 with an explanation; 'provider_error' means the provider was
    // reached and said no, which is a different message to a different person.
    const res = await sendSms(env({ SMS_PROVIDER: 'telnyx' }), '+18185550100', 'test');
    expect(res.sent === false && res.reason).not.toBe('provider_error');
  });
});

describe('the one-message-per-second ceiling', () => {
  /** A Telnyx stub that answers `codes` in order, one per call. */
  function stub(codes: number[]) {
    const calls: Array<Record<string, unknown>> = [];
    const previous = globalThis.fetch;
    let i = 0;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : String(input?.url ?? input);
      if (url === 'https://api.telnyx.com/v2/messages') {
        calls.push(JSON.parse(String(init?.body ?? '{}')));
        const status = codes[Math.min(i++, codes.length - 1)]!;
        return new Response(
          status === 200 ? JSON.stringify({ data: { id: 'm' } }) : '{"errors":[]}',
          { status, headers: { 'content-type': 'application/json' } },
        );
      }
      return previous(input, init);
    }) as typeof fetch;
    return { calls, restore: () => { globalThis.fetch = previous; } };
  }

  const live = env({
    SMS_PROVIDER: 'telnyx', TELNYX_API_KEY: 'KEYtest', TELNYX_FROM: '+18185550142',
  });

  it('retries a 429 once and succeeds', async () => {
    // The real case this exists for: two people press sign in inside the same
    // second, the second one is refused, and a moment later it goes.
    const s = stub([429, 200]);
    try {
      const res = await sendSms(live, '+18185550100', 'code');
      expect(res.sent).toBe(true);
      expect(s.calls).toHaveLength(2);
    } finally { s.restore(); }
  }, 10_000);

  it('gives up after one retry rather than sleeping in a loop', async () => {
    const s = stub([429, 429]);
    try {
      const res = await sendSms(live, '+18185550100', 'code');
      expect(res.sent).toBe(false);
      expect(res.sent === false && res.reason).toBe('rate_limited');
      expect(s.calls).toHaveLength(2);
    } finally { s.restore(); }
  }, 10_000);

  it('does not retry a 422, which retrying cannot fix', async () => {
    // 422 is the number not being attached to a messaging profile. Sleeping
    // and asking again just makes the failure slower.
    const s = stub([422, 200]);
    try {
      const res = await sendSms(live, '+18185550100', 'code');
      expect(res.sent).toBe(false);
      expect(res.sent === false && res.reason).toBe('provider_error');
      expect(s.calls).toHaveLength(1);
    } finally { s.restore(); }
  });

  it('refuses a malformed number before spending a request on it', async () => {
    const s = stub([200]);
    try {
      for (const bad of ['', '+', '+0123456789', '18185550100', '+1818555010012345']) {
        const res = await sendSms(live, bad, 'code');
        expect(res.sent, bad).toBe(false);
        expect(res.sent === false && res.reason, bad).toBe('bad_number');
      }
      expect(s.calls).toHaveLength(0);
    } finally { s.restore(); }
  });

  it('sends the number and text Telnyx expects', async () => {
    const s = stub([200]);
    try {
      await sendSms(live, '+18185550100', 'your code is 123456');
      expect(s.calls[0]).toEqual({
        from: '+18185550142', to: '+18185550100', text: 'your code is 123456',
      });
    } finally { s.restore(); }
  });
});
