import worker from '../src/index';
import type { Env } from '../src/types';

/**
 * Signs a customer in the way a customer actually signs in.
 *
 * DELIBERATELY NOT A ROW INSERTED BY HAND. A helper that writes a
 * customer_sessions row directly would have to know how the token is hashed,
 * which means every test using it would keep passing on the day that hashing
 * changed and the real flow broke. This drives the two real endpoints instead:
 * POST /api/customer/auth/code, then POST /api/customer/auth/verify with the
 * six digits taken out of the text message the Worker tried to send.
 *
 * The text message is read out of a stubbed fetch rather than out of the
 * database, and that is the point: the code is only ever stored as a peppered
 * digest, so the ONLY way to learn it is to be the thing that receives the
 * message. Every test that signs somebody in therefore also proves that a code
 * was really sent, to the right number, containing the digits that then work.
 *
 * Turnstile is switched off for the duration and put back afterwards. Whether
 * the challenge covers this route is tested where challenges are tested; a
 * test about bookings should not have to solve one to get a customer.
 */
export interface SignedInCustomer {
  /** Ready to use as a Cookie request header. */
  cookie: string;
  accountId: string;
  phone: string;
  /** The six digits, for tests that want to try replaying them. */
  code: string;
  /** The text message the Worker sent, exactly as Twilio would have had it. */
  sms: string;
}

const BASE = 'https://gap.test';

/** Twilio credentials good enough for smsConfigured() to say yes. */
export function configureSms(env: Env): void {
  env.TWILIO_ACCOUNT_SID = 'ACtestaccountsid';
  env.TWILIO_AUTH_TOKEN = 'test-auth-token';
  env.TWILIO_FROM = '+15550000000';
}

/**
 * Captures every outbound text message while `fn` runs.
 *
 * Anything that is not a Twilio send is handed to whatever stub was already in
 * place, so a test that is also stubbing siteverify keeps its own behaviour.
 */
export async function captureSms<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; messages: Array<{ to: string; body: string }> }> {
  const messages: Array<{ to: string; body: string }> = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    if (url.startsWith('https://api.twilio.com/')) {
      const form = new URLSearchParams(String(init?.body ?? ''));
      messages.push({ to: form.get('To') ?? '', body: form.get('Body') ?? '' });
      return new Response(JSON.stringify({ sid: 'SMtest' }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return previous(input, init);
  }) as typeof fetch;
  try {
    return { result: await fn(), messages };
  } finally {
    globalThis.fetch = previous;
  }
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

const post = (env: Env, path: string, body: unknown, cookie?: string) =>
  worker.fetch(new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': '203.0.113.99',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  }), env, ctx);

export async function signInCustomer(
  env: Env, phone: string, opts: { first_name?: string; email?: string } = {},
): Promise<SignedInCustomer> {
  configureSms(env);
  const secret = env.TURNSTILE_SECRET;
  env.TURNSTILE_SECRET = undefined;

  try {
    const { messages } = await captureSms(async () => {
      const res = await post(env, '/api/customer/auth/code', { phone, country: 'US' });
      if (res.status !== 200) {
        throw new Error(`code request failed: ${res.status} ${await res.text()}`);
      }
    });

    const sms = messages[0]?.body ?? '';
    const code = /(\d{6})/.exec(sms)?.[1];
    if (!code) throw new Error(`no code in the text message: ${JSON.stringify(messages)}`);

    const verify = await post(env, '/api/customer/auth/verify', {
      phone, country: 'US', code, first_name: opts.first_name, email: opts.email,
    });
    if (verify.status !== 200) {
      throw new Error(`verify failed: ${verify.status} ${await verify.text()}`);
    }
    const setCookie = verify.headers.get('set-cookie') ?? '';
    const token = /sf_customer=([^;]+)/.exec(setCookie)?.[1];
    if (!token) throw new Error(`no session cookie: ${setCookie}`);

    const payload = await verify.json() as { account: { id: string; phone_e164: string } };
    return {
      cookie: `sf_customer=${token}`,
      accountId: payload.account.id,
      phone: payload.account.phone_e164,
      code,
      sms,
    };
  } finally {
    env.TURNSTILE_SECRET = secret;
  }
}
