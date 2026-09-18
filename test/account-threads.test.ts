import { beforeEach, describe, expect, it } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import { fakeKV, type FakeKV } from './kv';
import worker from '../src/index';
import type { Env } from '../src/types';
import { signInCustomer } from './customer';
import { newId, now } from '../src/lib/util';

/**
 * A SIGNED-IN CUSTOMER FINDING THEIR OWN CONVERSATIONS, WITHOUT THE LINK.
 *
 * What this file is defending, in the owner's words: "there has to be a way
 * for a business and client to be able to continue a conversation to stay
 * easily available without needing to keep a link."
 *
 * Until migration 0052 there was not one. A customer's conversation lived
 * behind a /c/:token link and nowhere else; only a peppered fingerprint of
 * that token is stored, deliberately, so nobody on this site was able to hand
 * one back. The page even said so — "keep this link, it is the only way to
 * this conversation" — and that sentence was printed to people who had an
 * account, an order against it and a booking listed at /account, while the
 * messages, the photographs of their own kitchen, the four digits their
 * tradesman needs on the doorstep and the card form for a booking nobody had
 * charged them for were all unreachable.
 *
 * THE RISK IN CLOSING THAT GAP IS ENTIRELY AUTHORISATION, which is why most of
 * this file is about refusals rather than about the happy path. A door that
 * reaches a conversation on an account id instead of on a secret is one
 * mistake away from reaching everybody's. So the properties pinned here are:
 *
 *   OWN ONLY. The list is scoped in the WHERE clause, and a thread id from
 *   another account answers 404 in the same words a made-up one gets — never
 *   403, never "that exists but is not yours", because an endpoint that can
 *   tell those apart is a way to count other people's conversations.
 *
 *   THE TOKEN DOOR IS UNCHANGED. It is the only thing a guest with no account
 *   has ever had, and it is what works on a phone that has never been signed
 *   in. Every test here that touches it asserts it still behaves exactly as it
 *   did — including that a valid token needs no session at all.
 *
 *   THE SAME THREAD THROUGH BOTH. Not "a thread": byte-for-byte the same
 *   payload, because the whole point of the design is that there is one
 *   implementation behind both doors rather than two that can drift. The
 *   money on that payload is what makes drift expensive.
 *
 *   THE MONEY AND THE PICTURES GET THROUGH. The unpaid-booking panel and the
 *   photo strip are the two things on the page that are worth most to somebody
 *   who lost their link, so they are asserted through the new door
 *   specifically rather than assumed from the thread read working.
 */

const BASE = 'https://gap.test';
const OP = 'op-acct-threads';
const HERE = { lat: 34.1510, lng: -118.4450 };
const EMAIL = 'rosa@mailbox.test';
const OTHER_EMAIL = 'someone.else@mailbox.test';
/**
 * One contact number per account, because customer_accounts.phone_e164 is
 * UNIQUE — two people cannot share one, and a fixture that tried would fail
 * on the insert rather than on anything this file is about.
 */
const PHONE: Record<string, string> = {
  [EMAIL]: '+18185550142',
  [OTHER_EMAIL]: '+18185550143',
};
const E164 = PHONE[EMAIL]!;

let env: Env;
let photos: FakeKV;

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

beforeEach(() => {
  photos = fakeKV();
  env = { ...makeEnv(ALL_MIGRATIONS), PHOTOS: photos } as unknown as Env;
});

function makeReq(method: string, path: string, opts: {
  body?: unknown; cookie?: string; ip?: string;
} = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = opts.cookie;
  headers['cf-connecting-ip'] = opts.ip ?? '203.0.113.7';
  return new Request(`${BASE}${path}`, {
    method, headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

const call = (method: string, path: string, opts: Parameters<typeof makeReq>[2] = {}) =>
  worker.fetch(makeReq(method, path, opts), env, ctx);

/** A business with one opening a stranger could actually book. */
async function seed(): Promise<{ gapId: string }> {
  const t = now();
  // stripe_payouts_enabled = 1 is load-bearing, not boilerplate: priceOrder
  // treats an opening for a business with nowhere to be paid as unlisted, so
  // without it every booking below comes back slot_gone.
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,profile_slug,timezone,country,currency,
       language,location_mode,fill_model,sms_mode,plan,accept_public_bookings,
       is_published,created_at,updated_at,stripe_payouts_enabled)
     VALUES (?,?,?,?, 'America/Los_Angeles','US','USD','en','mobile','both','device',
       'active',1,1,?,?,1)`,
  ).bind(OP, 'shop@example.com', 'Valley Detailing', 'valley-detailing', t, t).run();

  await env.DB.prepare(
    `INSERT INTO services (id,operator_id,name,duration_seconds,price_cents,created_at,updated_at)
     VALUES ('svc-wash',?,'Wash only',3600,4900,?,?)`,
  ).bind(OP, t, t).run();

  await env.DB.prepare(
    `INSERT INTO postal_codes (country_code,postal_code,place_name,lat,lng,accuracy)
     VALUES ('US','91403','Sherman Oaks',?,?,6)`,
  ).bind(HERE.lat, HERE.lng).run();

  return { gapId: await openGap() };
}

/** One more bookable hour, so a second customer can buy one too. */
async function openGap(): Promise<string> {
  const t = now();
  const gapId = newId();
  await env.DB.prepare(
    `INSERT INTO gaps (id,operator_id,starts_at,ends_at,prev_lat,prev_lng,next_lat,next_lng,
       baseline_drive_seconds,is_mobile,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,180,1,'open',?,?)`,
  ).bind(gapId, OP, t + 4 * 3600, t + 9 * 3600,
    HERE.lat, HERE.lng, HERE.lat, HERE.lng, t, t).run();
  return gapId;
}

const orderBody = (gapId: string, email: string) => ({
  items: [{ gap_id: gapId, service_ids: ['svc-wash'] }],
  guest_name: 'Rosa',
  email,
  phone: PHONE[email] ?? E164,
  address_line: '15200 Ventura Blvd',
  postcode: '91403',
});

/**
 * One real booking, made through the checkout by a signed-in customer.
 *
 * DRIVEN THROUGH THE ROUTES RATHER THAN INSERTED, for the reason signInCustomer
 * gives about codes: a fixture that writes the rows itself keeps passing on the
 * day the real path stops writing one of them. The thing under test here is
 * precisely whether the checkout puts the account on the thread, so writing
 * that column by hand in the fixture would test nothing at all.
 */
async function bookAsCustomer(email: string, gapId: string) {
  const me = await signInCustomer(env, email, { phone: PHONE[email] });
  const res = await call('POST', '/api/public/orders',
    { cookie: me.cookie, body: orderBody(gapId, email) });
  expect(res.status).toBe(201);
  const placed = await res.json() as {
    order_id: string;
    thread_token: string;
    threads: Array<{ token: string }>;
    items: Array<{ order_item_id: string; appointment_id: string }>;
  };
  const thread = await env.DB.prepare(
    `SELECT id, customer_account_id FROM threads WHERE appointment_id = ?`,
  ).bind(placed.items[0]!.appointment_id).first<{
    id: string; customer_account_id: string | null;
  }>();
  return {
    me,
    token: placed.thread_token,
    threadId: thread!.id,
    accountOnThread: thread!.customer_account_id,
    orderId: placed.order_id,
    orderItemId: placed.items[0]!.order_item_id,
  };
}

// ---------------------------------------------------------------------------
describe('the checkout puts the conversation on the account that booked it', () => {
  it('stamps the thread as well as the order', async () => {
    const { gapId } = await seed();
    const booked = await bookAsCustomer(EMAIL, gapId);
    // The column migration 0052 added, written by the real checkout path. If
    // this is null the list below has nothing to list and the whole feature is
    // a page that says "no conversations" to everybody.
    expect(booked.accountOnThread).toBe(booked.me.accountId);
  });
});

describe('a signed-in customer listing their conversations', () => {
  it("sees their own and not another account's", async () => {
    const { gapId } = await seed();
    const mine = await bookAsCustomer(EMAIL, gapId);
    const theirs = await bookAsCustomer(OTHER_EMAIL, await openGap());

    const res = await call('GET', '/api/customer/threads', { cookie: mine.me.cookie });
    expect(res.status).toBe(200);
    const body = await res.json() as { threads: Array<Record<string, unknown>> };

    // Exactly one, and it is theirs. The negative half is the one that matters:
    // two customers of the same business, two conversations in the same table,
    // and the scoping is what keeps them apart.
    expect(body.threads).toHaveLength(1);
    expect(body.threads[0]!.id).toBe(mine.threadId);
    expect(body.threads.map((t) => t.id)).not.toContain(theirs.threadId);

    // And the mirror image, from the other side, so the test cannot pass
    // merely because the first account happened to be the only one with rows.
    const other = await call('GET', '/api/customer/threads', { cookie: theirs.me.cookie });
    const otherBody = await other.json() as { threads: Array<{ id: string }> };
    expect(otherBody.threads).toHaveLength(1);
    expect(otherBody.threads[0]!.id).toBe(theirs.threadId);
  });

  it('names the business and the hour, and carries no token', async () => {
    const { gapId } = await seed();
    const mine = await bookAsCustomer(EMAIL, gapId);
    const res = await call('GET', '/api/customer/threads', { cookie: mine.me.cookie });
    const row = (await res.json() as { threads: Array<Record<string, unknown>> }).threads[0]!;

    // A list of ids would be useless: the reader is choosing which
    // conversation to open, and the only thing they recognise is the business.
    expect(row.business_name).toBe('Valley Detailing');
    expect(row.starts_at).toEqual(expect.any(Number));
    expect(row.ends_at).toEqual(expect.any(Number));

    // THE PROPERTY THAT CANNOT BE COMPROMISED ON. There is no guest token in
    // this payload and there cannot be one — only its hash is stored. The
    // whole design is that the account reaches a conversation by id on its own
    // authority; a token appearing here would mean one had been kept in
    // readable form somewhere, which is the thing the schema refuses to do.
    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain(mine.token);
    expect(row.guest_token_hash).toBeUndefined();
  });

  it('refuses the list outright to somebody with no session', async () => {
    await seed();
    const res = await call('GET', '/api/customer/threads');
    expect(res.status).toBe(401);
  });
});

describe('opening one conversation on account authority', () => {
  it('returns the same thread the token returns', async () => {
    const { gapId } = await seed();
    const mine = await bookAsCustomer(EMAIL, gapId);

    const byToken = await call('GET', `/api/public/threads/${mine.token}`);
    const byAccount = await call('GET', `/api/public/threads/${mine.threadId}`,
      { cookie: mine.me.cookie });
    expect(byToken.status).toBe(200);
    expect(byAccount.status).toBe(200);

    const a = await byToken.json() as { thread: Record<string, unknown> };
    const b = await byAccount.json() as { thread: Record<string, unknown> };

    // NOT "a thread" — the same one, field for field. The point of resolving
    // both doors to one row and running them through one function is that
    // there is no second payload to drift, so this is the assertion that says
    // so rather than spot-checking three fields and hoping.
    //
    // guest_unread is excluded because reading is a WRITE: the first read
    // cleared the badge, so the second necessarily sees a different value.
    // That is the routes behaving identically, not differently.
    const { guest_unread: _a, ...aRest } = a.thread;
    const { guest_unread: _b, ...bRest } = b.thread;
    expect(bRest).toEqual(aRest);
    expect(b.thread.id).toBe(mine.threadId);
  });

  it('never publishes the account id to either door', async () => {
    const { gapId } = await seed();
    const mine = await bookAsCustomer(EMAIL, gapId);
    for (const [path, cookie] of [
      [`/api/public/threads/${mine.token}`, undefined],
      [`/api/public/threads/${mine.threadId}`, mine.me.cookie],
    ] as const) {
      const res = await call('GET', path, cookie ? { cookie } : {});
      const body = await res.text();
      // No screen shows it and nothing in web/ reads it, so it has no business
      // sitting in every browser cache naming whose conversation this is. The
      // page is told `on_account` — a boolean — and nothing more.
      expect(body).not.toContain(mine.me.accountId);
      expect(JSON.parse(body).thread.customer_account_id).toBeUndefined();
      expect(JSON.parse(body).thread.on_account).toBe(true);
    }
  });

  it('404s a thread id belonging to another account', async () => {
    const { gapId } = await seed();
    const mine = await bookAsCustomer(EMAIL, gapId);
    const theirs = await bookAsCustomer(OTHER_EMAIL, await openGap());

    // A real, live conversation — just not this reader's. Every route under
    // the conversation, not only the read: the guard runs in one place for all
    // of them, and this is what proves that one place covers them.
    for (const path of [
      `/api/public/threads/${theirs.threadId}`,
      `/api/public/threads/${theirs.threadId}/estimates`,
      `/api/public/threads/${theirs.threadId}/parts`,
      `/api/public/threads/${theirs.threadId}/code`,
      `/api/public/threads/${theirs.threadId}/track`,
      `/api/public/threads/${theirs.threadId}/proof/${theirs.orderItemId}`,
    ]) {
      const res = await call('GET', path, { cookie: mine.me.cookie, ip: '198.51.100.4' });
      expect(res.status, path).toBe(404);
      // THE SAME WORDS A MADE-UP ID GETS, and no 403 anywhere. A reader who
      // can tell "exists but not yours" from "does not exist" has been handed
      // a way to count other people's conversations.
      const body = await res.json() as { error: string };
      expect(body.error, path).toBe('That link is not valid any more.');
    }

    const nonsense = await call('GET', '/api/public/threads/thr_not_a_real_id',
      { cookie: mine.me.cookie, ip: '198.51.100.5' });
    expect(nonsense.status).toBe(404);
    expect(await nonsense.json()).toMatchObject({
      error: 'That link is not valid any more.',
    });
  });

  it('refuses a thread id with no session behind it', async () => {
    const { gapId } = await seed();
    const mine = await bookAsCustomer(EMAIL, gapId);
    // The id is not a secret and is not meant to be one. Signed out it reaches
    // nothing at all, which is what makes it safe to put in a URL, a browser
    // history and a referrer header where a /c/:token must never go.
    const res = await call('GET', `/api/public/threads/${mine.threadId}`,
      { ip: '198.51.100.6' });
    expect(res.status).toBe(404);
  });

  it('lets the customer reply through the account door', async () => {
    const { gapId } = await seed();
    const mine = await bookAsCustomer(EMAIL, gapId);
    const sent = await call('POST', `/api/public/threads/${mine.threadId}/messages`,
      { cookie: mine.me.cookie, body: { body: 'Is the side gate wide enough?' } });
    expect(sent.status).toBe(201);

    // Continuing the conversation is the whole feature, so the message has to
    // land in the SAME thread the link reads — not a new one beside it.
    const read = await call('GET', `/api/public/threads/${mine.token}`);
    const body = await read.json() as { messages: Array<{ body: string; sender: string }> };
    expect(body.messages.map((m) => m.body))
      .toContain('Is the side gate wide enough?');
    expect(body.messages.at(-1)!.sender).toBe('guest');
  });
});

describe('the money and the photographs come through the new door', () => {
  it('still offers the unpaid-booking panel', async () => {
    const { gapId } = await seed();
    const mine = await bookAsCustomer(EMAIL, gapId);

    // THE FIELD THE CARD FORM IS DRAWN FROM. An order is written before the
    // card is asked for, on purpose, so a customer interrupted at the card
    // step has not lost the slot — and for the person who then closed the tab,
    // this is the only way back to paying. It is also the most expensive thing
    // on the page to get wrong, which is why it is asserted through this door
    // rather than inferred from the thread read returning 200.
    const res = await call('GET', `/api/public/threads/${mine.threadId}`,
      { cookie: mine.me.cookie });
    const body = await res.json() as {
      thread: { booking: { order: { id: string; due: boolean; paid: boolean } } };
    };
    expect(body.thread.booking.order.id).toBe(mine.orderId);
    expect(body.thread.booking.order.due).toBe(true);
    expect(body.thread.booking.order.paid).toBe(false);

    // And identical on the link, because it is one function answering both.
    const viaLink = await call('GET', `/api/public/threads/${mine.token}`);
    const linkBody = await viaLink.json() as {
      thread: { booking: { order: unknown } };
    };
    expect(linkBody.thread.booking.order).toEqual(body.thread.booking.order);
  });

  it("still serves the photo strip, and refuses another account's", async () => {
    const { gapId } = await seed();
    const mine = await bookAsCustomer(EMAIL, gapId);
    const theirs = await bookAsCustomer(OTHER_EMAIL, await openGap());

    const res = await call('GET',
      `/api/public/threads/${mine.threadId}/proof/${mine.orderItemId}`,
      { cookie: mine.me.cookie });
    expect(res.status).toBe(200);
    const summary = await res.json() as {
      before: unknown[]; during: unknown[]; after: unknown[]; total: number;
    };
    // Empty is the right answer for a job nobody has photographed yet. What is
    // being pinned is that the route AUTHORISES through this door at all — an
    // empty gallery and a 404 look the same to a reader and are not the same,
    // and the three stages are the shape the photo strip is drawn from.
    expect(summary.total).toBe(0);
    for (const stage of [summary.before, summary.during, summary.after]) {
      expect(Array.isArray(stage)).toBe(true);
    }

    // The customer's own thread, somebody else's booking line. This is the
    // object-level check inside proof.ts rather than the door, and it has to
    // keep working when the door changes underneath it.
    const crossed = await call('GET',
      `/api/public/threads/${mine.threadId}/proof/${theirs.orderItemId}`,
      { cookie: mine.me.cookie, ip: '198.51.100.7' });
    expect(crossed.status).toBe(404);
  });

  it('serves a conversation photograph through the account door', async () => {
    const { gapId } = await seed();
    const mine = await bookAsCustomer(EMAIL, gapId);

    // A picture sent on the LINK and then read back on the ACCOUNT — which is
    // exactly the sequence somebody who loses their link lives through, and
    // the one that would break if the two doors resolved to different threads.
    const fd = new FormData();
    fd.set('file', new File([new Uint8Array([
      0xFF, 0xD8, 0xFF, 0xDB, 0x00, 0x43, 0, ...new Array(64).fill(16),
      0xFF, 0xDA, 0x00, 0x08, 1, 1, 0x00, 0, 63, 0, 0x9A, 0x4C, 0xFF, 0xD9,
    ])], 'gate.jpg', { type: 'image/jpeg' }));
    fd.set('body', 'This is the gate.');
    const up = await worker.fetch(new Request(
      `${BASE}/api/public/threads/${mine.token}/photos`,
      { method: 'POST', body: fd, headers: { 'cf-connecting-ip': '203.0.113.7' } },
    ), env, ctx);
    expect(up.status).toBe(201);
    const posted = await up.json() as { message: { photo: { id: string } } };
    const photoId = posted.message.photo.id;

    const shown = await call('GET',
      `/api/public/threads/${mine.threadId}/message-photo/${photoId}`,
      { cookie: mine.me.cookie });
    expect(shown.status).toBe(200);
    expect(shown.headers.get('content-type')).toBe('image/jpeg');
    // Private and never shared: the URL is only meaningful to whoever already
    // holds the session or the link that authorised it.
    expect(shown.headers.get('cache-control')).toContain('private');

    // The same id, asked for by a different account. A photo id says nothing
    // about who may see it, so the refusal has to come from the thread.
    const theirs = await bookAsCustomer(OTHER_EMAIL, await openGap());
    const stolen = await call('GET',
      `/api/public/threads/${theirs.threadId}/message-photo/${photoId}`,
      { cookie: theirs.me.cookie, ip: '198.51.100.8' });
    expect(stolen.status).toBe(404);
  });
});

describe('the link still does everything it did, for somebody with no account', () => {
  /**
   * A conversation opened by a stranger from a profile page: no order, no
   * appointment, no account, nothing but a name and a token.
   *
   * THIS IS THE READER THE TOKEN DOOR EXISTS FOR, and every assertion about
   * "unchanged" has to be made with one of these rather than with a booking
   * that happens to also be on an account.
   */
  async function guestEnquiry() {
    const res = await call('POST', '/api/public/threads', {
      body: {
        operator_id: OP, guest_name: 'Sam',
        first_message: 'Does your van fit down a narrow alley?',
      },
      ip: '203.0.113.50',
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { thread: { id: string }; token: string };
    return body;
  }

  it('reads, replies and says the link is the only way back', async () => {
    await seed();
    const guest = await guestEnquiry();

    // No cookie anywhere in this test. That is the point of it.
    const read = await call('GET', `/api/public/threads/${guest.token}`);
    expect(read.status).toBe(200);
    const body = await read.json() as {
      thread: { id: string; on_account: boolean };
      messages: Array<{ body: string }>;
    };
    expect(body.thread.id).toBe(guest.thread.id);
    expect(body.messages[0]!.body).toBe('Does your van fit down a narrow alley?');

    // THE FACT THE "KEEP THIS LINK" NOTICE TURNS ON. False here, so this
    // reader is still told the link is the only way back — because for them it
    // is, and telling them otherwise would be how they lose the conversation.
    expect(body.thread.on_account).toBe(false);

    const sent = await call('POST', `/api/public/threads/${guest.token}/messages`,
      { body: { body: 'It is about two metres.' } });
    expect(sent.status).toBe(201);
  });

  it('is not made to depend on a session by the new door existing', async () => {
    await seed();
    const guest = await guestEnquiry();
    // A signed-in customer holding somebody else's link still gets in on the
    // link, and a signed-out one does too. The token is tried first and a
    // valid one never causes a session to be consulted, so neither the
    // presence nor the absence of a cookie can change the answer.
    const signedIn = await signInCustomer(env, EMAIL, { phone: PHONE[EMAIL] });
    const withCookie = await call('GET', `/api/public/threads/${guest.token}`,
      { cookie: signedIn.cookie });
    const without = await call('GET', `/api/public/threads/${guest.token}`);
    expect(withCookie.status).toBe(200);
    expect(without.status).toBe(200);
  });

  it('keeps a booking-less enquiry off every account, permanently', async () => {
    await seed();
    const guest = await guestEnquiry();
    const signedIn = await signInCustomer(env, EMAIL, { phone: PHONE[EMAIL] });

    // NOT CLAIMABLE, AND THAT IS THE DECISION RATHER THAN AN OVERSIGHT. An
    // anonymous enquiry has no order, no appointment and no client row, so
    // there is nothing tying it to a person — and matching one up later would
    // mean guessing whose it was. Guessing wrong here hands a stranger
    // somebody else's conversation, which is worse than the enquiry staying
    // on its link.
    const list = await call('GET', '/api/customer/threads', { cookie: signedIn.cookie });
    const body = await list.json() as { threads: Array<{ id: string }> };
    expect(body.threads.map((t) => t.id)).not.toContain(guest.thread.id);

    // And it is not reachable by id either, signed in or not.
    const byId = await call('GET', `/api/public/threads/${guest.thread.id}`,
      { cookie: signedIn.cookie, ip: '198.51.100.11' });
    expect(byId.status).toBe(404);
  });
});

describe('an enquiry sent while signed in', () => {
  it('goes onto that account, so the question can be found again', async () => {
    await seed();
    const me = await signInCustomer(env, EMAIL, { phone: PHONE[EMAIL] });

    // THE ONE MOMENT THIS CAN BE CAPTURED. There is no booking to join through
    // and there never will be, so if the session is not read here the question
    // is token-only for ever. Nothing is asked of the sender: no sign-in is
    // required, the cookie is merely noticed if it is there.
    const res = await call('POST', '/api/public/profile/valley-detailing/enquiries', {
      cookie: me.cookie,
      body: { guest_name: 'Rosa', first_message: 'Do you do vans?' },
      ip: '203.0.113.51',
    });
    expect(res.status).toBe(201);
    const opened = await res.json() as { thread: { id: string }; token: string };

    const list = await call('GET', '/api/customer/threads', { cookie: me.cookie });
    const body = await list.json() as { threads: Array<{ id: string; starts_at: number | null }> };
    expect(body.threads.map((t) => t.id)).toContain(opened.thread.id);
    // No booking behind it, and it is still a first-class member of the list.
    // For plenty of people this is the only kind of conversation they have.
    expect(body.threads.find((t) => t.id === opened.thread.id)!.starts_at).toBeNull();

    // Both doors, on a thread that has no booking at all.
    const byAccount = await call('GET', `/api/public/threads/${opened.thread.id}`,
      { cookie: me.cookie });
    const byToken = await call('GET', `/api/public/threads/${opened.token}`);
    expect(byAccount.status).toBe(200);
    expect(byToken.status).toBe(200);
  });

  it('is reached by "delete everything you hold about me"', async () => {
    await seed();
    const me = await signInCustomer(env, EMAIL, { phone: PHONE[EMAIL] });
    const res = await call('POST', '/api/public/profile/valley-detailing/enquiries', {
      cookie: me.cookie,
      body: { guest_name: 'Rosa', first_message: 'The tap by the back door leaks.' },
      ip: '203.0.113.53',
    });
    const opened = await res.json() as { thread: { id: string } };

    // THE OBLIGATION THAT ARRIVED WITH THE COLUMN. Before migration 0052 an
    // anonymous enquiry could not be erased on anybody's behalf because
    // nothing in the database said whose it was — that was correct, not a gap.
    // Attaching it to an account creates a link from this person to a
    // conversation holding their first name and a sentence about their house,
    // and an erasure that cannot follow that link is an erasure whose receipt
    // is a lie. It has no appointment, so the booking-shaped keys the erasure
    // has always used cannot reach it.
    const erased = await call('DELETE', '/api/customer/data', { cookie: me.cookie });
    expect(erased.status).toBe(200);

    const left = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM threads WHERE id = ?`,
    ).bind(opened.thread.id).first<{ n: number }>();
    expect(left!.n).toBe(0);
    // And the sentence inside it, which is the part that was actually about
    // somebody's house.
    const messages = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM chat_messages WHERE thread_id = ?`,
    ).bind(opened.thread.id).first<{ n: number }>();
    expect(messages!.n).toBe(0);
  });

  it("does not attach it to a different account than the sender's", async () => {
    await seed();
    const me = await signInCustomer(env, EMAIL, { phone: PHONE[EMAIL] });
    const other = await signInCustomer(env, OTHER_EMAIL, { phone: PHONE[OTHER_EMAIL] });

    const res = await call('POST', '/api/public/profile/valley-detailing/enquiries', {
      cookie: me.cookie,
      body: { guest_name: 'Rosa', first_message: 'Do you do vans?' },
      ip: '203.0.113.52',
    });
    const opened = await res.json() as { thread: { id: string } };

    const theirList = await call('GET', '/api/customer/threads', { cookie: other.cookie });
    const theirs = await theirList.json() as { threads: Array<{ id: string }> };
    expect(theirs.threads.map((t) => t.id)).not.toContain(opened.thread.id);
  });
});

describe('signing in later picks up a conversation booked as a guest', () => {
  it('claims the thread with the order, on the address that was proved', async () => {
    const { gapId } = await seed();

    // A booking whose order carries the address but no account — the shape
    // claimGuestHistory exists for, and the shape every booking made before
    // migration 0037 has. Written directly because there is no longer a route
    // that produces one: booking requires an account today.
    const t = now();
    const orderId = newId();
    const apptId = newId();
    const clientId = newId();
    // appointments.client_id is a real foreign key, so the operator's own row
    // for this customer has to exist. It is also the column the claim joins
    // through when the appointment has moved on — see migration 0052.
    await env.DB.prepare(
      `INSERT INTO clients (id,operator_id,first_name,geocode_status,created_at,updated_at)
       VALUES (?,?,'Rosa','pending',?,?)`,
    ).bind(clientId, OP, t, t).run();
    await env.DB.prepare(
      `INSERT INTO orders (id,status,login_email,currency,total_cents,created_at,updated_at)
       VALUES (?,'pending',?,'USD',4900,?,?)`,
    ).bind(orderId, EMAIL, t, t).run();
    await env.DB.prepare(
      `INSERT INTO appointments (id,operator_id,service_id,client_id,starts_at,ends_at,
         price_cents,status,source,created_at,updated_at)
       VALUES (?,?,'svc-wash',?,?,?,4900,'scheduled','gap_fill',?,?)`,
    ).bind(apptId, OP, clientId, t + 4 * 3600, t + 5 * 3600, t, t).run();
    await env.DB.prepare(
      `INSERT INTO order_items (id,order_id,operator_id,gap_id,appointment_id,client_id,
         starts_at,ends_at,duration_seconds,price_cents,created_at)
       VALUES (?,?,?,?,?,?,?,?,3600,4900,?)`,
    ).bind(newId(), orderId, OP, gapId, apptId, clientId,
      t + 4 * 3600, t + 5 * 3600, t).run();
    const threadId = newId();
    await env.DB.prepare(
      `INSERT INTO threads (id,operator_id,appointment_id,client_id,guest_name,
         guest_token_hash,last_message_at,status,created_at,updated_at)
       VALUES (?,?,?,?,'Rosa','hash-nobody-can-reverse',?,'open',?,?)`,
    ).bind(threadId, OP, apptId, clientId, t, t, t).run();

    // Nobody's, before the address is proved.
    expect((await env.DB.prepare(
      `SELECT customer_account_id AS a FROM threads WHERE id = ?`,
    ).bind(threadId).first<{ a: string | null }>())!.a).toBeNull();

    const me = await signInCustomer(env, EMAIL, { phone: PHONE[EMAIL] });

    // CLAIMING THE BOOKING AND NOT THE CONVERSATION WAS THE HALF-MEASURE THIS
    // CLOSES. The March booking appeared with its money and its start code,
    // and the messages about it stayed behind a link minted in March that
    // nobody can reissue — while the person stood there having just proved the
    // address it was booked on.
    const list = await call('GET', '/api/customer/threads', { cookie: me.cookie });
    const body = await list.json() as { threads: Array<{ id: string }> };
    expect(body.threads.map((t) => t.id)).toContain(threadId);

    const opened = await call('GET', `/api/public/threads/${threadId}`,
      { cookie: me.cookie });
    expect(opened.status).toBe(200);
  });

  it('never moves a conversation that already belongs to somebody else', async () => {
    const { gapId } = await seed();
    const theirs = await bookAsCustomer(OTHER_EMAIL, gapId);

    // Their booking, with THIS address wrongly on the order — a mistyped
    // address that happens to belong to somebody real, or two people sharing a
    // mailbox. The orders update matches on login_email, so without the
    // `customer_account_id IS NULL` guard on the threads update this would
    // silently hand a stranger's conversation over, which is the one failure
    // in this area that could not be undone.
    await env.DB.prepare(`UPDATE orders SET login_email = ? WHERE id = ?`)
      .bind(EMAIL, theirs.orderId).run();

    const me = await signInCustomer(env, EMAIL, { phone: PHONE[EMAIL] });
    const list = await call('GET', '/api/customer/threads', { cookie: me.cookie });
    const body = await list.json() as { threads: Array<{ id: string }> };
    expect(body.threads.map((t) => t.id)).not.toContain(theirs.threadId);

    // Still the other account's, and still reachable by them.
    const still = await call('GET', `/api/public/threads/${theirs.threadId}`,
      { cookie: theirs.me.cookie });
    expect(still.status).toBe(200);
  });
});
