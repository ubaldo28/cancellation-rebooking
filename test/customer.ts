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
 * six digits taken out of the EMAIL the Worker tried to send. It was a text
 * message until migration 0038; the channel moved because nothing could send
 * one, and the account key moved with it.
 *
 * The email is read out of a stubbed fetch rather than out of the database,
 * and that is the point: the code is only ever stored as a peppered digest, so
 * the ONLY way to learn it is to be the thing that receives the message. Every
 * test that signs somebody in therefore also proves that a code was really
 * sent, to the right mailbox, containing the digits that then work.
 *
 * Turnstile is switched off for the duration and put back afterwards. Whether
 * the challenge covers this route is tested where challenges are tested; a
 * test about bookings should not have to solve one to get a customer.
 */
export interface SignedInCustomer {
  /** Ready to use as a Cookie request header. */
  cookie: string;
  accountId: string;
  /** The account's identity — what standing and history hang on. */
  email: string;
  /** The contact number on the account. Taken on trust, proves nothing. */
  phone: string | null;
  /** The six digits, for tests that want to try replaying them. */
  code: string;
  /** The body of the email the Worker sent. */
  sms: string;
}

const BASE = 'https://gap.test';

/**
 * Credentials good enough for emailConfigured() to say yes.
 *
 * EMAIL_PROVIDER is set explicitly and that is not a formality. The Worker
 * sends through the provider this names, so a set of keys with no name is
 * deliberately NOT configured. Leaving the name out is exactly the mistake a
 * real deployment makes, and it is the one this line exists to have already
 * made once, in a test, rather than on a live sign-in page.
 */
export function configureSms(env: Env): void {
  env.EMAIL_PROVIDER = 'resend';
  env.EMAIL_API_KEY = 're_testapikey';
  env.EMAIL_FROM = 'Round The Way <hello@roundtheway.app>';
}

/**
 * Captures every outbound email while `fn` runs.
 *
 * Anything that is not a Resend send is handed to whatever stub was already in
 * place, so a test that is also stubbing siteverify keeps its own behaviour.
 */
export async function captureSms<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; messages: Array<{ to: string; body: string }> }> {
  const messages: Array<{ to: string; body: string }> = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    if (url === 'https://api.resend.com/emails') {
      const sent = JSON.parse(String(init?.body ?? '{}'));
      const to = Array.isArray(sent.to) ? String(sent.to[0] ?? '') : String(sent.to ?? '');
      messages.push({
        to,
        body: `${String(sent.subject ?? '')}\n${String(sent.text ?? '')}`,
      });
      return new Response(JSON.stringify({ id: 'msgtest' }), {
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
  env: Env, email: string, opts: { first_name?: string; phone?: string } = {},
): Promise<SignedInCustomer> {
  configureSms(env);
  const secret = env.TURNSTILE_SECRET;
  env.TURNSTILE_SECRET = undefined;

  try {
    const { messages } = await captureSms(async () => {
      const res = await post(env, '/api/customer/auth/code', { email });
      if (res.status !== 200) {
        throw new Error(`code request failed: ${res.status} ${await res.text()}`);
      }
    });

    const sms = messages[0]?.body ?? '';
    const code = /(\d{6})/.exec(sms)?.[1];
    if (!code) throw new Error(`no code in the email: ${JSON.stringify(messages)}`);

    const verify = await post(env, '/api/customer/auth/verify', {
      email, code, country: 'US',
      first_name: opts.first_name,
      phone: opts.phone ?? '+15551230000',
    });
    if (verify.status !== 200) {
      throw new Error(`verify failed: ${verify.status} ${await verify.text()}`);
    }
    const setCookie = verify.headers.get('set-cookie') ?? '';
    const token = /__Host-sf_customer=([^;]+)/.exec(setCookie)?.[1];
    if (!token) throw new Error(`no session cookie: ${setCookie}`);

    const payload = await verify.json() as {
      account: { id: string; phone_e164: string | null; email: string | null };
    };
    return {
      cookie: `__Host-sf_customer=${token}`,
      accountId: payload.account.id,
      email,
      phone: payload.account.phone_e164,
      code,
      sms,
    };
  } finally {
    env.TURNSTILE_SECRET = secret;
  }
}
