import { describe, expect, it, beforeEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import worker from '../src/index';
import type { Env } from '../src/types';
import { ENQUIRY_REACH_LIMITS, sweepEnquiryReach } from '../src/lib/chat';
import { estimatesForOperator } from '../src/lib/estimates';
import { newId, now } from '../src/lib/util';

/**
 * Asking a business a question before booking anything.
 *
 * Every assertion in this file fails on the code before it, and most of them
 * fail with a 404: there was no way for a stranger to start a conversation
 * from a profile at all. The one endpoint that minted a guest token wanted an
 * operator id, and the profile route deliberately does not publish one — it is
 * an internal key — so the two ends of the reference marketplace's own profile
 * actions, "Message" and "Request a quote", could not be joined up. Only
 * placing a booking made a link, which put the conversation on the far side of
 * the decision it exists to inform.
 *
 * The other half of this file is what opening that door costs. A booking makes
 * the sender spend a name, a phone number, an address and a geocode; a message
 * costs a sentence. So the tests that matter most here are the ones about
 * breadth: one address must not be able to reach every business in the city,
 * and a customer talking to one business must never be stopped by the thing
 * that prevents it.
 */

const BASE = 'https://gap.test';
let env: Env;

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function call(method: string, path: string, opts: { ip?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.ip) headers['cf-connecting-ip'] = opts.ip;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return worker.fetch(new Request(`${BASE}${path}`, {
    method, headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  }), env, ctx);
}

/**
 * One business, published and taking public bookings.
 *
 * Every column that decides whether a stranger may write to it is a parameter,
 * because that is precisely what several of these tests vary.
 */
async function operator(id: string, opts: {
  name?: string; slug?: string | null; trade?: string | null;
  published?: number; accepting?: number; plan?: string;
  suspended_until?: number | null; banned_at?: number | null;
} = {}) {
  const n = now();
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,trade,timezone,country,currency,language,
       location_mode,fill_model,sms_mode,plan,accept_public_bookings,is_published,
       profile_slug,suspended_until,banned_at,share_location,created_at,updated_at)
     VALUES (?,?,?,?, 'America/Los_Angeles','US','USD','en','mobile','both','device',
       ?,?,?,?,?,?,1,?,?)`,
  ).bind(id, `${id}@x.com`, opts.name ?? id,
    opts.trade === undefined ? 'window cleaning' : opts.trade,
    opts.plan ?? 'active',
    opts.accepting ?? 1, opts.published ?? 1,
    opts.slug === undefined ? id : opts.slug,
    opts.suspended_until ?? null, opts.banned_at ?? null, n, n).run();
  return id;
}

/** Enough businesses to walk the fan-out ceiling and one past it. */
async function manyOperators(howMany: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < howMany; i++) ids.push(await operator(`op-${i}`));
  return ids;
}

const reachRows = async (ip: string) => (await env.DB.prepare(
  `SELECT COUNT(*) AS n FROM enquiry_reach WHERE ip = ?`,
).bind(ip).first<{ n: number }>())?.n ?? 0;

const threadCount = async () => (await env.DB.prepare(
  `SELECT COUNT(*) AS n FROM threads`,
).first<{ n: number }>())?.n ?? 0;

beforeEach(() => { env = makeEnv(ALL_MIGRATIONS) as unknown as Env; });

describe('a stranger writing to a business from its profile', () => {
  it('mints the same guest link a booking mints, so /c/:token needs no changes', async () => {
    await operator('op-a', { name: 'Clear View Window Cleaning', slug: 'clear-view' });

    const res = await call('POST', '/api/public/profile/clear-view/enquiries', {
      ip: '203.0.113.10',
      body: { guest_name: 'Rosa Fuentes', first_message: 'Do you do second-floor windows?' },
    });
    expect(res.status).toBe(201);
    const b = await res.json() as any;

    expect(b.token).toBeTruthy();
    expect(b.link).toBe(`${BASE}/c/${b.token}`);
    expect(b.operator.business_name).toBe('Clear View Window Cleaning');

    // The point of minting the same kind of token: the existing guest page
    // reads it with nothing added for this feature.
    const read = await call('GET', `/api/public/threads/${b.token}`);
    expect(read.status).toBe(200);
    const view = await read.json() as any;
    expect(view.thread.business_name).toBe('Clear View Window Cleaning');
    expect(view.messages).toHaveLength(1);
    expect(view.messages[0].body).toBe('Do you do second-floor windows?');
  });

  it('strips a phone number out of the opening message before it is stored', async () => {
    await operator('op-a', { slug: 'clear-view' });

    const res = await call('POST', '/api/public/profile/clear-view/enquiries', {
      ip: '203.0.113.11',
      body: { guest_name: 'Rosa', first_message: 'Easier to call me on 818 555 0199.' },
    });
    const { token } = await res.json() as any;

    // Read straight out of the row, not off the response: the whole reason
    // redaction happens before the insert is that the number must never be in
    // the database for an export or a support query to carry.
    const stored = await env.DB.prepare(
      `SELECT body, redacted FROM chat_messages`,
    ).first<{ body: string; redacted: number }>();
    expect(stored!.body).not.toMatch(/555/);
    expect(stored!.redacted).toBe(1);
    expect(token).toBeTruthy();
  });

  it('cuts a contact detail out of the name as well as the message', async () => {
    await operator('op-a', { slug: 'clear-view' });
    await call('POST', '/api/public/profile/clear-view/enquiries', {
      ip: '203.0.113.12',
      body: { guest_name: 'Rosa 818 555 0199', first_message: 'Hello' },
    });
    const t = await env.DB.prepare(`SELECT guest_name FROM threads`)
      .first<{ guest_name: string }>();
    expect(t!.guest_name).not.toMatch(/555/);
  });
});

describe('asking for a quote from a profile', () => {
  it('goes through the estimates machinery rather than a parallel one', async () => {
    await operator('op-a', { slug: 'clear-view' });

    const res = await call('POST', '/api/public/profile/clear-view/enquiries', {
      ip: '203.0.113.13',
      body: {
        guest_name: 'Rosa', kind: 'quote',
        request: 'Two storeys, eleven windows, one of them is a skylight.',
      },
    });
    expect(res.status).toBe(201);
    const b = await res.json() as any;

    expect(b.estimate.status).toBe('asked');
    expect(b.estimate.request).toContain('skylight');

    // The same rows the operator's own estimates screen reads. A second table
    // of "profile quotes" would be a second inbox nobody answers.
    const mine = await estimatesForOperator(env, 'op-a', {} as never);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.id).toBe(b.estimate.id);

    // And it is said out loud in the conversation, in the customer's words,
    // because the operator reads a thread and not an estimates panel.
    const read = await call('GET', `/api/public/threads/${b.token}`);
    const view = await read.json() as any;
    expect(view.messages).toHaveLength(1);
    expect(view.messages[0].body).toContain('skylight');
  });

  it('refuses a blank quote request without minting a link nobody asked for', async () => {
    await operator('op-a', { slug: 'clear-view' });

    const res = await call('POST', '/api/public/profile/clear-view/enquiries', {
      ip: '203.0.113.14',
      body: { guest_name: 'Rosa', kind: 'quote', request: '   ' },
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).code).toBe('no_request');

    // Checked before anything was written: an estimate can only hang off a
    // conversation, so a refusal afterwards would have cost the sender the one
    // copy of their link that will ever exist.
    expect(await threadCount()).toBe(0);
    expect(await reachRows('203.0.113.14')).toBe(0);
  });

  it('does not put the request into the thread twice', async () => {
    await operator('op-a', { slug: 'clear-view' });
    const res = await call('POST', '/api/public/profile/clear-view/enquiries', {
      ip: '203.0.113.15',
      body: { guest_name: 'Rosa', kind: 'quote', request: 'Gutters as well?', first_message: 'Gutters as well?' },
    });
    const { token } = await res.json() as any;
    const view = await (await call('GET', `/api/public/threads/${token}`)).json() as any;
    expect(view.messages).toHaveLength(1);
  });
});

describe('which businesses may be written to at all', () => {
  it('refuses a business suspended after a missed appointment', async () => {
    // FAILS ON THE OLD CODE. The thread route checked the plan and the
    // public-bookings flag and nothing else, so a business whose openings had
    // been pulled from the map, who could not post a new one and who could not
    // be sent an instant request still had its inbox open to every stranger on
    // the internet.
    await operator('op-a', { slug: 'clear-view', suspended_until: now() + 86400 });

    const bySlug = await call('POST', '/api/public/profile/clear-view/enquiries', {
      ip: '203.0.113.20', body: { guest_name: 'Rosa', first_message: 'Hello' },
    });
    expect(bySlug.status).toBe(404);

    // And through the older door, which names the same business by id. A gate
    // one of two entrances applies is not a gate.
    const byId = await call('POST', '/api/public/threads', {
      ip: '203.0.113.20',
      body: { operator_id: 'op-a', guest_name: 'Rosa', first_message: 'Hello' },
    });
    expect(byId.status).toBe(404);
    expect(await threadCount()).toBe(0);
  });

  it('refuses a banned business through either door', async () => {
    await operator('op-a', { slug: 'clear-view', banned_at: now() - 60 });
    expect((await call('POST', '/api/public/profile/clear-view/enquiries', {
      ip: '203.0.113.21', body: { guest_name: 'Rosa', first_message: 'Hi' },
    })).status).toBe(404);
    expect((await call('POST', '/api/public/threads', {
      ip: '203.0.113.21',
      body: { operator_id: 'op-a', guest_name: 'Rosa', first_message: 'Hi' },
    })).status).toBe(404);
  });

  it('lets a suspension lapse rather than being permanent', async () => {
    await operator('op-a', { slug: 'clear-view', suspended_until: now() - 60 });
    expect((await call('POST', '/api/public/profile/clear-view/enquiries', {
      ip: '203.0.113.22', body: { guest_name: 'Rosa', first_message: 'Hi' },
    })).status).toBe(201);
  });

  it('refuses a slug whose profile has been taken down', async () => {
    await operator('op-a', { slug: 'clear-view', published: 0 });
    expect((await call('POST', '/api/public/profile/clear-view/enquiries', {
      ip: '203.0.113.23', body: { guest_name: 'Rosa', first_message: 'Hi' },
    })).status).toBe(404);
  });

  it('still lets a customer ask about an open slot from a business with no profile page', async () => {
    // The one place the two spellings differ on purpose. accept_public_bookings
    // is what puts an opening on the map; publishing a profile is a separate
    // decision, and a customer looking at a bookable appointment must be able
    // to ask about it whether or not there is an About section to read first.
    await operator('op-a', { slug: null, published: 0 });
    expect((await call('POST', '/api/public/threads', {
      ip: '203.0.113.24',
      body: { operator_id: 'op-a', guest_name: 'Rosa', first_message: 'Hi' },
    })).status).toBe(201);
  });

  it('refuses a business that is not taking public work', async () => {
    await operator('op-a', { slug: 'clear-view', accepting: 0 });
    expect((await call('POST', '/api/public/profile/clear-view/enquiries', {
      ip: '203.0.113.25', body: { guest_name: 'Rosa', first_message: 'Hi' },
    })).status).toBe(404);
  });

  it('says the same thing about a business that does not exist', async () => {
    const res = await call('POST', '/api/public/profile/nobody-at-all/enquiries', {
      ip: '203.0.113.26', body: { guest_name: 'Rosa', first_message: 'Hi' },
    });
    expect(res.status).toBe(404);
  });
});

describe('one address, and how many businesses it may reach', () => {
  it('stops the eleventh business and says when the sender may start another', async () => {
    // FAILS ON THE OLD CODE, which had no measurement of breadth at all: the
    // ceilings were `thread-ip` (ten requests a quarter hour) and
    // `thread-op` (forty per business), and neither can tell one conversation
    // of ten messages from ten conversations with ten businesses.
    const ip = '198.51.100.5';
    const ids = await manyOperators(ENQUIRY_REACH_LIMITS.MAX_OPERATORS + 1);

    for (let i = 0; i < ENQUIRY_REACH_LIMITS.MAX_OPERATORS; i++) {
      // The volume bucket is cleared between sends so this test measures the
      // thing it is about. In the wild the two compose: the request ceiling
      // holds a burst, and this holds the slow spray underneath it.
      await env.DB.prepare(`DELETE FROM rate_limits`).run();
      const res = await call('POST', `/api/public/profile/${ids[i]}/enquiries`, {
        ip, body: { guest_name: 'Bot', first_message: 'hello' },
      });
      expect(res.status).toBe(201);
    }

    await env.DB.prepare(`DELETE FROM rate_limits`).run();
    const res = await call('POST', `/api/public/profile/${ids[ids.length - 1]}/enquiries`, {
      ip, body: { guest_name: 'Bot', first_message: 'hello' },
    });
    expect(res.status).toBe(429);
    const b = await res.json() as any;
    // Its own code, so this is distinguishable from the ordinary volume limits
    // — which mean something else and are answered differently.
    expect(b.code).toBe('too_many_businesses');
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('never counts a business this address has already written to', async () => {
    // The property that makes the ceiling survivable for a real customer. A
    // person going back and forth with one business must not be spending the
    // allowance that stops a spray.
    const ip = '198.51.100.6';
    const ids = await manyOperators(ENQUIRY_REACH_LIMITS.MAX_OPERATORS);

    for (const id of ids) {
      await env.DB.prepare(`DELETE FROM rate_limits`).run();
      expect((await call('POST', `/api/public/profile/${id}/enquiries`, {
        ip, body: { guest_name: 'Rosa', first_message: 'hello' },
      })).status).toBe(201);
    }

    // At the ceiling, and a business already spoken to still answers.
    for (let i = 0; i < 5; i++) {
      await env.DB.prepare(`DELETE FROM rate_limits`).run();
      expect((await call('POST', `/api/public/profile/${ids[0]}/enquiries`, {
        ip, body: { guest_name: 'Rosa', first_message: 'and another thing' },
      })).status).toBe(201);
    }
    expect(await reachRows(ip)).toBe(ENQUIRY_REACH_LIMITS.MAX_OPERATORS);
  });

  it('counts both doors against one ledger', async () => {
    // Otherwise the newer route is simply the way round the older one's
    // ceiling, which is the failure mode of every second entry point.
    const ip = '198.51.100.7';
    const ids = await manyOperators(ENQUIRY_REACH_LIMITS.MAX_OPERATORS + 1);

    for (let i = 0; i < ENQUIRY_REACH_LIMITS.MAX_OPERATORS; i++) {
      await env.DB.prepare(`DELETE FROM rate_limits`).run();
      await call('POST', `/api/public/profile/${ids[i]}/enquiries`, {
        ip, body: { guest_name: 'Bot', first_message: 'hello' },
      });
    }

    await env.DB.prepare(`DELETE FROM rate_limits`).run();
    const res = await call('POST', '/api/public/threads', {
      ip, body: { operator_id: ids[ids.length - 1], guest_name: 'Bot', first_message: 'hello' },
    });
    expect(res.status).toBe(429);
    expect((await res.json() as any).code).toBe('too_many_businesses');
  });

  it('holds one address only, never the business being written to', async () => {
    // The counter is on the sender. A popular business must not become
    // unreachable because somebody else sprayed the city.
    const ip = '198.51.100.8';
    const ids = await manyOperators(ENQUIRY_REACH_LIMITS.MAX_OPERATORS + 1);
    for (let i = 0; i < ENQUIRY_REACH_LIMITS.MAX_OPERATORS; i++) {
      await env.DB.prepare(`DELETE FROM rate_limits`).run();
      await call('POST', `/api/public/profile/${ids[i]}/enquiries`, {
        ip, body: { guest_name: 'Bot', first_message: 'hello' },
      });
    }
    await env.DB.prepare(`DELETE FROM rate_limits`).run();
    const other = await call('POST', `/api/public/profile/${ids[ids.length - 1]}/enquiries`, {
      ip: '198.51.100.99', body: { guest_name: 'Rosa', first_message: 'hello' },
    });
    expect(other.status).toBe(201);
  });

  it('spends nothing on a request that was refused', async () => {
    await operator('op-a', { slug: 'clear-view' });
    const ip = '198.51.100.9';
    expect((await call('POST', '/api/public/profile/clear-view/enquiries', {
      ip, body: { first_message: 'no name on this one' },
    })).status).toBe(400);
    expect(await reachRows(ip)).toBe(0);
  });

  it('forgets an address once the window it was counting has passed', async () => {
    const ip = '198.51.100.10';
    await operator('op-a', { slug: 'clear-view' });
    await call('POST', '/api/public/profile/clear-view/enquiries', {
      ip, body: { guest_name: 'Rosa', first_message: 'hello' },
    });
    expect(await reachRows(ip)).toBe(1);

    // The sweep drops rows the window has moved past. Kept for ever this table
    // is a permanent record of which businesses each address ever wrote to.
    await env.DB.prepare(
      `UPDATE enquiry_reach SET first_at = ?`,
    ).bind(now() - ENQUIRY_REACH_LIMITS.WINDOW_SECONDS - 60).run();
    await sweepEnquiryReach(env);
    expect(await reachRows(ip)).toBe(0);
  });

  it('leaves a row that is still counting alone', async () => {
    const ip = '198.51.100.11';
    await operator('op-a', { slug: 'clear-view' });
    await call('POST', '/api/public/profile/clear-view/enquiries', {
      ip, body: { guest_name: 'Rosa', first_message: 'hello' },
    });
    await sweepEnquiryReach(env);
    expect(await reachRows(ip)).toBe(1);
  });

  it('keeps the first contact time rather than pushing it forward on every message', async () => {
    // Otherwise one long conversation holds its slot open indefinitely and the
    // window stops being a window.
    const ip = '198.51.100.12';
    await operator('op-a', { slug: 'clear-view' });
    await call('POST', '/api/public/profile/clear-view/enquiries', {
      ip, body: { guest_name: 'Rosa', first_message: 'hello' },
    });
    const first = await env.DB.prepare(`SELECT first_at FROM enquiry_reach`)
      .first<{ first_at: number }>();
    await env.DB.prepare(`UPDATE enquiry_reach SET first_at = ?`)
      .bind(first!.first_at - 1000).run();
    await env.DB.prepare(`DELETE FROM rate_limits`).run();
    await call('POST', '/api/public/profile/clear-view/enquiries', {
      ip, body: { guest_name: 'Rosa', first_message: 'again' },
    });
    const after = await env.DB.prepare(`SELECT first_at FROM enquiry_reach`)
      .first<{ first_at: number }>();
    expect(after!.first_at).toBe(first!.first_at - 1000);
  });
});

describe('the volume ceilings the two doors share', () => {
  it('does not give the newer route its own request budget', async () => {
    // Ten a quarter hour per address, and it has to be one budget: bucketing
    // the profile route separately would have made it the way round the other.
    const ip = '198.51.100.20';
    await operator('op-a', { slug: 'a-one' });
    await operator('op-b', { slug: 'b-two' });

    for (let i = 0; i < 10; i++) {
      const res = i % 2 === 0
        ? await call('POST', '/api/public/profile/a-one/enquiries', {
          ip, body: { guest_name: 'Rosa', first_message: 'hello' },
        })
        : await call('POST', '/api/public/threads', {
          ip, body: { operator_id: 'op-b', guest_name: 'Rosa', first_message: 'hello' },
        });
      expect(res.status).toBe(201);
    }

    const over = await call('POST', '/api/public/profile/a-one/enquiries', {
      ip, body: { guest_name: 'Rosa', first_message: 'hello' },
    });
    expect(over.status).toBe(429);
    expect((await over.json() as any).code).toBe('rate_limited');
  });
});

describe('a claim that arrives with the name box empty', () => {
  it('names the field that is actually missing', async () => {
    // FAILS ON THE OLD CODE, which normalised the number only `if
    // (input.first_name)` and then reported a bad phone number — pointing at
    // the one field the person had filled in correctly.
    const { claimSlot } = await import('../src/lib/public');
    await operator('op-a', { slug: 'clear-view' });
    const n = now();
    const gapId = newId();
    await env.DB.prepare(
      `INSERT INTO gaps (id,operator_id,starts_at,ends_at,is_mobile,status,created_at,updated_at)
       VALUES (?,?,?,?,0,'open',?,?)`,
    ).bind(gapId, 'op-a', n + 7200, n + 14400, n, n).run();

    await expect(claimSlot(env, {
      gapId, first_name: '  ', phone: '(818) 555-0142',
    })).rejects.toMatchObject({ code: 'no_name' });
  });
});
