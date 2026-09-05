import { describe, expect, it, beforeEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import worker from '../src/index';
import type { Env } from '../src/types';
import { startThread as newThread } from '../src/lib/chat';
import { newId, now } from '../src/lib/util';

const BASE = 'https://gap.test';
let env: Env;

/**
 * The assets binding, stubbed.
 *
 * The real one serves web/dist. All these tests need is a response that came
 * from somewhere other than a route handler, with immutable headers like the
 * real binding returns, so that "every response" can be shown to mean the SPA
 * as well as the API.
 */
const spaAssets = {
  fetch: async () =>
    new Response('<!doctype html><html><body><div id="root"></div></body></html>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
};

function makeReq(method: string, path: string, opts: {
  body?: unknown; ip?: string; headers?: Record<string, string>;
} = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.ip) headers['cf-connecting-ip'] = opts.ip;
  return new Request(`${BASE}${path}`, {
    method, headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

const call = (method: string, path: string, opts?: Parameters<typeof makeReq>[2]) =>
  worker.fetch(makeReq(method, path, opts), env, {} as ExecutionContext);

beforeEach(() => {
  env = { ...makeEnv(ALL_MIGRATIONS), ASSETS: spaAssets } as unknown as Env;
});

// ---------------------------------------------------------------------------
describe('security headers are on everything, not on the API alone', () => {
  const expectStamped = (res: Response) => {
    expect(res.headers.get('content-security-policy')).toContain(`frame-ancestors 'none'`);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('strict-transport-security')).toMatch(/max-age=\d{7,}/);
    expect(res.headers.get('strict-transport-security')).toContain('includeSubDomains');
    expect(res.headers.get('permissions-policy')).toContain('geolocation=(self)');
  };

  it('stamps an API JSON response', async () => {
    expectStamped(await call('GET', '/health'));
  });

  it('stamps the SPA that comes back from the assets binding', async () => {
    const res = await call('GET', '/browse/home');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="root"');
    expectStamped(res);
  });

  it('stamps an error response', async () => {
    const res = await call('GET', '/api/public/watches/not-a-real-token');
    expect(res.status).toBe(404);
    expectStamped(res);
  });

  it('stamps a server-rendered page', async () => {
    const res = await call('GET', '/o/no-such-offer-token');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('text/html');
    expectStamped(res);
  });

  it('keeps a route that already sends a stricter header', async () => {
    // The offer page sets referrer-policy: no-referrer because its URL is the
    // secret. Blanket headers must not quietly relax that.
    const offer = await call('GET', '/o/no-such-offer-token');
    expect(offer.headers.get('referrer-policy')).toBe('no-referrer');
    expect((await call('GET', '/health')).headers.get('referrer-policy'))
      .toBe('strict-origin-when-cross-origin');
  });

  it('hands unknown app paths to the SPA but never an unknown API path', async () => {
    expect((await call('GET', '/some/deep/react/route')).status).toBe(200);

    const missing = await call('GET', '/api/does-not-exist');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toContain('application/json');
  });
});

describe('the policy allows what the app actually loads', () => {
  it('allows the map, the font CDN and the maplibre CDN in the right directives',
    async () => {
      const csp = (await call('GET', '/health')).headers.get('content-security-policy')!;
      const directive = (name: string) =>
        csp.split('; ').find((d) => d.startsWith(`${name} `)) ?? '';

      // Tiles and glyphs are fetched; the sprite sheet is an image. Allowing
      // the host in only one of the two renders a map with no labels.
      expect(directive('connect-src')).toContain('https://tiles.openfreemap.org');
      expect(directive('img-src')).toContain('https://tiles.openfreemap.org');
      // MapLibre decodes tiles in a worker it builds from a blob URL.
      expect(directive('worker-src')).toContain('blob:');
      expect(directive('script-src')).toContain('https://unpkg.com');
      expect(directive('style-src')).toContain('https://fonts.googleapis.com');
      expect(directive('font-src')).toContain('https://fonts.gstatic.com');
    });

  it('never allows inline or eval-ed script, whatever the styles need', async () => {
    const csp = (await call('GET', '/health')).headers.get('content-security-policy')!;
    const scriptSrc = csp.split('; ').find((d) => d.startsWith('script-src '))!;
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(scriptSrc).not.toContain('unsafe-eval');
    expect(csp).toContain(`object-src 'none'`);
    expect(csp).toContain(`base-uri 'none'`);
  });
});

// ---------------------------------------------------------------------------
describe('public endpoints are rate limited', () => {
  /** A business, so a conversation can be hung off it. */
  async function pollableOperator(email: string) {
    const t = now();
    const opId = newId();
    await env.DB.prepare(
      `INSERT INTO operators (id,email,business_name,timezone,country,currency,
         location_mode,fill_model,sms_mode,plan,created_at,updated_at)
       VALUES (?,?,?, 'America/Los_Angeles','US','USD','mobile','both','device','active',?,?)`,
    ).bind(opId, email, 'Polled Detailing', t, t).run();
    return opId;
  }

  /** A conversation and the raw token its customer would have been sent. */
  async function realGuestLink(operatorId: string) {
    const { token } = await newThread(env, { operator_id: operatorId, guest_name: 'Sam' });
    return token;
  }

  /** A conversation opened against a business that does not exist: 404 until the wall. */
  const startThread = (ip: string, operatorId = 'no-such-operator') =>
    call('POST', '/api/public/threads', {
      ip, body: { operator_id: operatorId, guest_name: 'Sam' },
    });

  it('refuses the eleventh conversation from one address, with a Retry-After', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await startThread('203.0.113.7')).status).toBe(404);
    }
    const stopped = await startThread('203.0.113.7');
    expect(stopped.status).toBe(429);
    expect(await stopped.json()).toMatchObject({ code: 'rate_limited' });

    const retryAfter = Number(stopped.headers.get('retry-after'));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
  });

  it('leaves a different address alone', async () => {
    for (let i = 0; i < 11; i++) await startThread('203.0.113.7');
    expect((await startThread('198.51.100.4')).status).toBe(404);
  });

  it('leaves other endpoints alone when one bucket is full', async () => {
    for (let i = 0; i < 11; i++) await startThread('203.0.113.7');
    // Same caller, different bucket. A full conversation budget must not take
    // the rest of the site down with it.
    expect((await call('GET', '/health', { ip: '203.0.113.7' })).status).toBe(200);
    expect((await call('GET', '/api/trade-catalog', { ip: '203.0.113.7' })).status).toBe(200);
  });

  it('buckets guest chat on the link rather than the address', async () => {
    // Two customers behind one office connection must not share a budget, so
    // the token is the bucket: a full one leaves the other link untouched.
    //
    // Both links are real ones now. They used to be invented strings, which
    // read the same and was fine while an unknown token meant nothing in
    // particular — but a wrong link is now counted against the caller (see
    // guestlink.ts), so a fixture made of thirty-one wrong ones was testing
    // the wrong wall. The claim here is about two VALID links not sharing a
    // budget, so the fixture has to be two valid links.
    const opId = await pollableOperator('buckets@example.com');
    const one = await realGuestLink(opId);
    const two = await realGuestLink(opId);
    for (let i = 0; i < 31; i++) {
      await call('POST', `/api/public/threads/${one}/messages`, {
        ip: '203.0.113.9', body: { body: 'hello' },
      });
    }
    const blocked = await call('POST', `/api/public/threads/${one}/messages`, {
      ip: '203.0.113.9', body: { body: 'hello' },
    });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();

    const other = await call('POST', `/api/public/threads/${two}/messages`, {
      ip: '203.0.113.9', body: { body: 'hello' },
    });
    expect(other.status).not.toBe(429);
  });

  it('a 429 carries the security headers too', async () => {
    for (let i = 0; i < 11; i++) await startThread('203.0.113.7');
    const stopped = await startThread('203.0.113.7');
    expect(stopped.status).toBe(429);
    expect(stopped.headers.get('content-security-policy')).toBeTruthy();
    expect(stopped.headers.get('x-frame-options')).toBe('DENY');
  });

  it('does not fire on an ordinary customer reading their own booking', async () => {
    // The guest page polls every 15 seconds. An hour of that is 240 reads, and
    // the ceiling is per five minutes — so twenty in a row, which is what a
    // tab open for five minutes does, must not be near it.
    // Their OWN booking, on a link that resolves. It used to be a made-up
    // token, which no ordinary customer has ever held — and now that a link
    // which resolves to nothing is counted against the caller, the difference
    // is the whole point of the test rather than a detail of the fixture.
    const opId = await pollableOperator('poll@example.com');
    const token = await realGuestLink(opId);

    for (let i = 0; i < 20; i++) {
      const res = await call('GET', `/api/public/threads/${token}`, {
        ip: '203.0.113.11',
      });
      expect(res.status).not.toBe(429);
    }
  });
});
