import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import { fakeKV, type FakeKV } from './kv';
import worker from '../src/index';
import type { Env } from '../src/types';
import { attachBooking, startThread, MESSAGE_PHOTO_LIMITS } from '../src/lib/chat';
import { newId, now } from '../src/lib/util';

/**
 * Photographs sent inside the conversation.
 *
 * This is the half of the product's camera that is about TALKING. The staged
 * before/during/after gallery on the booking (proof.ts, covered by
 * upload.test.ts) is the other half and is about arguing; the two must not
 * become each other, which is why almost everything here is an assertion about
 * a boundary rather than about a happy path.
 *
 * What is worth being exact about, and why each one is here:
 *
 *   - BOTH DOORS. The operator posts with a session, the guest posts with
 *     nothing but the secret in their link. Those are two completely different
 *     authorisation stories for one resource, which is how one of them ends up
 *     being the loose one.
 *   - THE PAYLOAD. A photograph that is stored and does not appear in the
 *     transcript has not been sent, it has been swallowed, and the sender is
 *     never told. That is the exact failure the whole messaging feature exists
 *     to prevent.
 *   - AN ID FROM ANOTHER CONVERSATION. A photo id is a small opaque string and
 *     nothing about it says who may see it. If the serve route answered on the
 *     id alone it would be a way to walk through strangers' photographs of the
 *     inside of their own homes, and it would answer differently for an id
 *     that exists than for one that does not, which is the oracle that makes
 *     the walk worth doing.
 *   - NO STORE BOUND. env.PHOTOS is optional and was undefined in production
 *     for the entire life of this codebase. The refusal has to be clean AND
 *     has to write nothing: a message row whose photograph can never exist is
 *     a permanent broken picture in somebody's conversation.
 */

const BASE = 'https://gap.test';
let env: Env;
let photos: FakeKV;
let stored: FakeKV['entries'];

const bytes = (...xs: Array<number | number[] | Uint8Array | string>): Uint8Array => {
  const parts: number[] = [];
  for (const x of xs) {
    if (typeof x === 'number') parts.push(x);
    else if (typeof x === 'string') for (const c of x) parts.push(c.charCodeAt(0));
    else for (const b of x) parts.push(b);
  }
  return new Uint8Array(parts);
};

const has = (d: Uint8Array, needle: Uint8Array | string) => {
  const n = typeof needle === 'string' ? bytes(needle) : needle;
  outer: for (let i = 0; i + n.length <= d.length; i++) {
    for (let j = 0; j < n.length; j++) if (d[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
};

const be16 = (n: number) => [(n >> 8) & 0xFF, n & 0xFF];
const be32 = (n: number) => [(n >>> 24) & 0xFF, (n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF];

/** The marker that says the file still knows which kitchen it was taken in. */
const HOME = bytes('34.1510,-118.4450');

/** A JPEG with an APP1 that carries the address of somebody's house. */
function photoFromAPhone(): Uint8Array {
  const exif = bytes('Exif', 0, 0, 'MM', 0x00, 0x2A, ...be32(8), HOME);
  return bytes(0xFF, 0xD8,
    0xFF, 0xE1, ...be16(exif.length + 2), exif,
    0xFF, 0xDB, ...be16(67), 0, ...new Array(64).fill(16),
    0xFF, 0xDA, ...be16(8), 1, 1, 0x00, 0, 63, 0,
    0x9A, 0x4C,
    0xFF, 0xD9);
}

/**
 * A file that is over the cap, built without spreading two million numbers
 * through a function call. It begins with the JPEG magic so that the only
 * thing wrong with it is its size.
 */
function tooBigAJpeg(): Uint8Array {
  const d = new Uint8Array(MESSAGE_PHOTO_LIMITS.MAX_BYTES + 1);
  d.set([0xFF, 0xD8, 0xFF, 0xE0], 0);
  return d;
}

function form(file: Uint8Array | null, opts: {
  name?: string; type?: string; body?: string; width?: string; height?: string;
} = {}) {
  const fd = new FormData();
  if (file) {
    fd.set('file', new File([file], opts.name ?? 'IMG_0421.JPG', {
      type: opts.type ?? 'image/jpeg',
    }));
  }
  if (opts.body != null) fd.set('body', opts.body);
  if (opts.width) fd.set('width', opts.width);
  if (opts.height) fd.set('height', opts.height);
  return fd;
}

/** An operator with a live session. */
async function signIn(email: string, name = 'Valley Detailing') {
  const t = now();
  const opId = newId();
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,timezone,country,currency,
       location_mode,fill_model,sms_mode,plan,accept_public_bookings,created_at,updated_at)
     VALUES (?,?,?,'America/Los_Angeles','US','USD','mobile','both',
       'device','active',1,?,?)`,
  ).bind(opId, email, name, t, t).run();

  const raw = `sess-${opId}`;
  const digest = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(`${raw}:${env.SESSION_PEPPER}`));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  await env.DB.prepare(
    `INSERT INTO sessions (id,operator_id,token_hash,expires_at,created_at)
     VALUES (?,?,?,?,?)`,
  ).bind(newId(), opId, hash, t + 86400, t).run();

  return { opId, cookie: `__Host-gf_session=${raw}` };
}

const post = (path: string, body: BodyInit, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`${BASE}${path}`, { method: 'POST', body, headers }),
    env, {} as ExecutionContext);

const get = (path: string, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`${BASE}${path}`, { headers }), env, {} as ExecutionContext);

/** How many photo rows exist at all. The "wrote nothing" assertions read this. */
const photoRows = async () => (await env.DB.prepare(
  `SELECT COUNT(*) AS n FROM message_photos`).first<{ n: number }>())!.n;

const messageRows = async () => (await env.DB.prepare(
  `SELECT COUNT(*) AS n FROM chat_messages`).first<{ n: number }>())!.n;

beforeEach(() => {
  photos = fakeKV();
  stored = photos.entries;
  env = { ...makeEnv(ALL_MIGRATIONS), PHOTOS: photos } as unknown as Env;
});

describe('the business sends a photograph', () => {
  it('stores it, strips where it was taken, and returns the message', async () => {
    const { opId, cookie } = await signIn('a@example.com');
    const { thread } = await startThread(env, { operator_id: opId, guest_name: 'Rosa' });

    const original = photoFromAPhone();
    expect(has(original, HOME)).toBe(true);

    const res = await post(`/api/threads/${thread.id}/photos`,
      form(original, { body: 'This is the part you need.', width: '1600', height: '1200' }),
      { cookie });
    expect(res.status).toBe(201);

    const { message } = await res.json() as any;
    expect(message.sender).toBe('operator');
    expect(message.body).toBe('This is the part you need.');
    expect(message.photo).toEqual({
      id: expect.any(String), width: 1600, height: 1200,
    });

    // One value in the store, under the conversation prefix, and the address
    // the picture was taken at is not in it any more.
    expect(stored.size).toBe(1);
    const [key, entry] = [...stored.entries()][0]!;
    expect(key.startsWith(`m/${opId}/${thread.id}/`)).toBe(true);
    expect(entry.contentType).toBe('image/jpeg');
    expect(has(entry.bytes, HOME)).toBe(false);

    // And the row describes the bytes that were actually stored, not the ones
    // that arrived: the strip makes the file smaller.
    const row = await env.DB.prepare(
      `SELECT photo_key, content_type, bytes, width, height, thread_id, operator_id,
              order_item_id FROM message_photos WHERE id = ?`,
    ).bind(message.photo.id).first<any>();
    expect(row.photo_key).toBe(key);
    expect(row.content_type).toBe('image/jpeg');
    expect(row.bytes).toBe(entry.bytes.length);
    expect(row.bytes).toBeLessThan(original.length);
    expect(row.thread_id).toBe(thread.id);
    expect(row.operator_id).toBe(opId);
    // No booking on this conversation yet, which is a real and common state.
    expect(row.order_item_id).toBeNull();
  });

  it('takes a photograph with nothing typed alongside it', async () => {
    const { opId, cookie } = await signIn('a@example.com');
    const { thread } = await startThread(env, { operator_id: opId, guest_name: 'Rosa' });

    // The picture IS the message. Demanding a caption would be the app
    // inventing a requirement the person does not have.
    const res = await post(`/api/threads/${thread.id}/photos`,
      form(photoFromAPhone()), { cookie });
    expect(res.status).toBe(201);
    const { message } = await res.json() as any;
    expect(message.body).toBe('');
    expect(message.photo.id).toEqual(expect.any(String));
  });

  it('refuses a conversation belonging to another business', async () => {
    const { opId } = await signIn('a@example.com');
    const other = await signIn('b@example.com', 'Canyon Detailing');
    const { thread } = await startThread(env, { operator_id: opId, guest_name: 'Rosa' });

    const res = await post(`/api/threads/${thread.id}/photos`,
      form(photoFromAPhone()), { cookie: other.cookie });
    expect(res.status).toBe(404);
    expect(await photoRows()).toBe(0);
    expect(stored.size).toBe(0);
  });
});

describe('the customer sends a photograph, on their link and nothing else', () => {
  it('stores it and tells the operator', async () => {
    const { opId } = await signIn('a@example.com');
    const { thread, token } = await startThread(env, {
      operator_id: opId, guest_name: 'Rosa',
    });

    const res = await post(`/api/public/threads/${token}/photos`,
      form(photoFromAPhone(), { body: 'It is the one by the back door.' }));
    expect(res.status).toBe(201);

    const { message } = await res.json() as any;
    expect(message.sender).toBe('guest');
    expect(message.photo.id).toEqual(expect.any(String));
    expect(stored.size).toBe(1);
    expect([...stored.keys()][0]!.startsWith(`m/${opId}/${thread.id}/`)).toBe(true);

    // The operator has something new to read, in their inbox and on the badge.
    const thr = await env.DB.prepare(
      `SELECT operator_unread FROM threads WHERE id = ?`,
    ).bind(thread.id).first<{ operator_unread: number }>();
    expect(thr!.operator_unread).toBe(1);

    const feed = await env.DB.prepare(
      `SELECT kind, title, body FROM notifications WHERE thread_id = ?`,
    ).bind(thread.id).first<any>();
    expect(feed.kind).toBe('chat_message');
    expect(feed.body).toMatch(/back door/);
  });

  it('names the picture in the feed when nothing was typed with it', async () => {
    const { opId } = await signIn('a@example.com');
    const { thread, token } = await startThread(env, {
      operator_id: opId, guest_name: 'Rosa',
    });

    await post(`/api/public/threads/${token}/photos`, form(photoFromAPhone()));

    // An empty line in the operator's feed reads as a bug rather than as a
    // message, and they would have no idea anything had arrived.
    const feed = await env.DB.prepare(
      `SELECT title, body FROM notifications WHERE thread_id = ?`,
    ).bind(thread.id).first<any>();
    expect(feed.title).toMatch(/sent you a photo/);
    expect(feed.body).toBe('Sent a photo');
  });

  it('refuses a link that is not a conversation', async () => {
    await signIn('a@example.com');
    const res = await post('/api/public/threads/not-a-real-token/photos',
      form(photoFromAPhone()));
    expect(res.status).toBe(404);
    expect(await photoRows()).toBe(0);
    expect(stored.size).toBe(0);
  });
});

describe('the transcript', () => {
  it('carries the photograph to both sides, and an explicit null without one',
    async () => {
      const { opId, cookie } = await signIn('a@example.com');
      const { thread, token } = await startThread(env, {
        operator_id: opId, guest_name: 'Rosa', first_message: 'Can you do Thursday?',
      });

      await post(`/api/threads/${thread.id}/photos`,
        form(photoFromAPhone(), { body: 'Here is the part.', width: '800', height: '600' }),
        { cookie });

      // The guest's view of the conversation.
      const guestRes = await get(`/api/public/threads/${token}`);
      expect(guestRes.status).toBe(200);
      const guestSide = await guestRes.json() as any;
      expect(guestSide.messages).toHaveLength(2);

      // The opening question has no picture, and says so rather than leaving
      // the browser to tell "no photo" apart from "old payload shape".
      expect(guestSide.messages[0].body).toMatch(/Thursday/);
      expect(guestSide.messages[0].photo).toBeNull();

      expect(guestSide.messages[1].body).toBe('Here is the part.');
      expect(guestSide.messages[1].photo).toEqual({
        id: expect.any(String), width: 800, height: 600,
      });

      // And the operator's view of the same conversation, from the other door.
      const opRes = await get(`/api/threads/${thread.id}`, { cookie });
      const opSide = await opRes.json() as any;
      expect(opSide.messages.map((m: any) => m.photo?.id ?? null))
        .toEqual([null, guestSide.messages[1].photo.id]);
    });

  it('reports 0 rather than null for a size the sender never measured', async () => {
    const { opId, cookie } = await signIn('a@example.com');
    const { thread } = await startThread(env, { operator_id: opId, guest_name: 'Rosa' });

    // A caller that is not our app sends neither dimension; so does a browser
    // whose measurement came back as nonsense.
    await post(`/api/threads/${thread.id}/photos`,
      form(photoFromAPhone(), { width: '-4', height: '99999999' }), { cookie });

    const { messages } = await (await get(`/api/threads/${thread.id}`, { cookie })).json() as any;
    expect(messages[0].photo).toEqual({ id: expect.any(String), width: 0, height: 0 });

    // Null in the column, which is the honest thing to store, and 0 in the
    // payload, which is the one state the browser has to handle.
    const row = await env.DB.prepare(
      `SELECT width, height FROM message_photos LIMIT 1`).first<any>();
    expect(row.width).toBeNull();
    expect(row.height).toBeNull();
  });
});

describe('serving one back', () => {
  it('hands the bytes to the two people on the conversation', async () => {
    const { opId, cookie } = await signIn('a@example.com');
    const { thread, token } = await startThread(env, {
      operator_id: opId, guest_name: 'Rosa',
    });

    const posted = await (await post(`/api/public/threads/${token}/photos`,
      form(photoFromAPhone()))).json() as any;
    const photoId = posted.message.photo.id;

    for (const res of [
      await get(`/api/public/threads/${token}/message-photo/${photoId}`),
      await get(`/api/message-photo/${photoId}`, { cookie }),
    ]) {
      expect(res.status).toBe(200);
      // The SNIFFED type, and private caching: the URL only means anything to
      // somebody already holding the session or the link that authorised it.
      expect(res.headers.get('content-type')).toBe('image/jpeg');
      expect(res.headers.get('cache-control')).toBe('private, max-age=3600');
      const back = new Uint8Array(await res.arrayBuffer());
      expect(has(back, HOME)).toBe(false);
      expect(back.length).toBeGreaterThan(0);
    }

    // And it is NOT reachable without either of those. `m/` is deliberately
    // absent from the public prefix allowlist.
    const key = [...stored.keys()][0]!;
    const open = await get(`/api/public/photo/${encodeURIComponent(key)}`);
    expect(open.status).toBe(404);
  });

  it('refuses an id from somebody elseentirely, in the words a made-up id gets',
    async () => {
      const { opId } = await signIn('a@example.com');
      const other = await signIn('b@example.com', 'Canyon Detailing');

      const mine = await startThread(env, { operator_id: opId, guest_name: 'Rosa' });
      const theirs = await startThread(env, { operator_id: opId, guest_name: 'Sam' });

      const posted = await (await post(`/api/public/threads/${mine.token}/photos`,
        form(photoFromAPhone()))).json() as any;
      const photoId = posted.message.photo.id;

      // A guest holding a DIFFERENT link to the same business. Their token
      // resolves to their own conversation, which is not the one this
      // photograph is on.
      const wrongLink = await get(
        `/api/public/threads/${theirs.token}/message-photo/${photoId}`);
      expect(wrongLink.status).toBe(404);

      // Another business, with a real session, using a real photo id.
      const wrongOperator = await get(`/api/message-photo/${photoId}`,
        { cookie: other.cookie });
      expect(wrongOperator.status).toBe(404);

      // An id that names nothing at all answers identically, so neither of the
      // refusals above is an oracle for "this one exists".
      const madeUp = await get(`/api/message-photo/${newId()}`, { cookie: other.cookie });
      expect(await wrongOperator.json()).toEqual(await madeUp.json());
      expect(wrongOperator.status).toBe(madeUp.status);
    });
});

describe('what is refused at the door', () => {
  it('refuses a file over the size cap without storing anything', async () => {
    const { opId, cookie } = await signIn('a@example.com');
    const { thread } = await startThread(env, { operator_id: opId, guest_name: 'Rosa' });

    const res = await post(`/api/threads/${thread.id}/photos`,
      form(tooBigAJpeg()), { cookie });
    expect(res.status).toBe(400);
    expect((await res.json() as any).code).toBe('too_big');

    expect(stored.size).toBe(0);
    expect(await photoRows()).toBe(0);
    expect(await messageRows()).toBe(0);
  });

  it('refuses something that is not a photograph, whatever it says it is', async () => {
    const { opId } = await signIn('a@example.com');
    const { token } = await startThread(env, { operator_id: opId, guest_name: 'Rosa' });

    // Declared image/jpeg, named .jpg, and actually a page of script. Served
    // back with the declared type it would run in the other person's browser.
    const res = await post(`/api/public/threads/${token}/photos`,
      form(bytes('<html><script>alert(1)</script>'), { name: 'photo.jpg' }));
    expect(res.status).toBe(400);
    expect((await res.json() as any).code).toBe('bad_type');

    expect(stored.size).toBe(0);
    expect(await photoRows()).toBe(0);
    expect(await messageRows()).toBe(0);
  });

  it('refuses a HEIC, because the other side has to be able to see it', async () => {
    const { opId } = await signIn('a@example.com');
    const { token } = await startThread(env, { operator_id: opId, guest_name: 'Rosa' });

    // The job-proof gallery takes these: it is a camera roll and refusing the
    // evidence is worse than storing a format some browsers will not draw.
    // A conversation is the opposite -- a picture the other side cannot see
    // has failed at the only thing it was for, and neither of them would ever
    // find out why.
    const heic = bytes(0, 0, 0, 0x18, 'ftyp', 'heic', ...be32(0), 'heic', 'mif1');
    const res = await post(`/api/public/threads/${token}/photos`,
      form(heic, { name: 'IMG_0422.HEIC', type: 'image/heic' }));
    expect(res.status).toBe(400);
    expect((await res.json() as any).code).toBe('bad_type');
    expect(await photoRows()).toBe(0);
  });

  it('stops one conversation from spending the day\'s photographs', async () => {
    const { opId, cookie } = await signIn('a@example.com');
    const { thread } = await startThread(env, { operator_id: opId, guest_name: 'Rosa' });

    const t = now();
    // The ceiling is on the rows and not on the request, which is what makes
    // it a real bound on the photo store rather than a bound on one caller.
    // Seeded directly, because going through the door twenty times is a test
    // of the door and this is a test of the ceiling.
    for (let i = 0; i < MESSAGE_PHOTO_LIMITS.MAX_IN_WINDOW; i++) {
      const messageId = newId();
      await env.DB.prepare(
        `INSERT INTO chat_messages (id, thread_id, sender, body, created_at, redacted)
         VALUES (?,?, 'guest', '', ?, 0)`,
      ).bind(messageId, thread.id, t).run();
      await env.DB.prepare(
        `INSERT INTO message_photos (id, message_id, thread_id, operator_id, order_item_id,
           photo_key, content_type, bytes, width, height, created_at)
         VALUES (?,?,?,?,NULL,?, 'image/jpeg', 100, NULL, NULL, ?)`,
      ).bind(newId(), messageId, thread.id, opId, `m/${opId}/${thread.id}/${i}`, t).run();
    }

    const res = await post(`/api/threads/${thread.id}/photos`,
      form(photoFromAPhone()), { cookie });
    expect(res.status).toBe(409);
    expect((await res.json() as any).code).toBe('too_many_photos');
    // Refused before the bytes were stored, not after.
    expect(stored.size).toBe(0);

    // Words still work. The ceiling is on pictures and never on talking.
    const said = await post(`/api/threads/${thread.id}/messages`,
      JSON.stringify({ body: 'Sending the rest tomorrow.' }),
      { cookie, 'content-type': 'application/json' });
    expect(said.status).toBe(201);
  });
});

describe('with no photo store bound at all', () => {
  /**
   * env.PHOTOS is optional, and it was undefined in production for the entire
   * life of this codebase -- see the top of lib/photostore.ts. The refusal has
   * to be clean, and it has to leave the database exactly as it found it.
   */
  beforeEach(() => {
    env = { ...makeEnv(ALL_MIGRATIONS) } as unknown as Env;
  });

  it('refuses both doors and writes no row', async () => {
    const { opId, cookie } = await signIn('a@example.com');
    const { thread, token } = await startThread(env, {
      operator_id: opId, guest_name: 'Rosa', first_message: 'Can you do Thursday?',
    });
    const before = await messageRows();

    for (const res of [
      await post(`/api/threads/${thread.id}/photos`, form(photoFromAPhone()), { cookie }),
      await post(`/api/public/threads/${token}/photos`, form(photoFromAPhone())),
    ]) {
      expect(res.status).toBe(400);
      expect((await res.json() as any).code).toBe('no_storage');
    }

    // Not one row, of either kind. A message whose photograph can never exist
    // is a permanent broken picture in somebody's conversation.
    expect(await photoRows()).toBe(0);
    expect(await messageRows()).toBe(before);

    // And the conversation is otherwise completely unharmed: this is a photo
    // outage, not a messaging outage.
    const said = await post(`/api/public/threads/${token}/messages`,
      JSON.stringify({ body: 'Thursday works.' }), { 'content-type': 'application/json' });
    expect(said.status).toBe(201);
    expect((await said.json() as any).message.photo).toBeNull();
  });

  it('answers 404 for a photograph it cannot reach', async () => {
    const { opId } = await signIn('a@example.com');
    const { thread } = await startThread(env, { operator_id: opId, guest_name: 'Rosa' });
    // A row from a deployment that DID have a store, being read by one that
    // does not. Nothing here may 500.
    const messageId = newId();
    await env.DB.prepare(
      `INSERT INTO chat_messages (id, thread_id, sender, body, created_at, redacted)
       VALUES (?,?, 'operator', '', ?, 0)`,
    ).bind(messageId, thread.id, now()).run();
    const photoId = newId();
    await env.DB.prepare(
      `INSERT INTO message_photos (id, message_id, thread_id, operator_id, order_item_id,
         photo_key, content_type, bytes, width, height, created_at)
       VALUES (?,?,?,?,NULL,'m/x/y/z','image/jpeg',100,NULL,NULL,?)`,
    ).bind(photoId, messageId, thread.id, opId, now()).run();

    const { cookie } = await signIn('c@example.com');
    const res = await get(`/api/message-photo/${photoId}`, { cookie });
    expect(res.status).toBe(404);
  });
});

describe('Turnstile, which is live in production and is not on these routes', () => {
  /**
   * The decision, asserted rather than only written down.
   *
   * Every route under /api/public/threads/:token is reachable ONLY by holding
   * a token that openEnquiry minted, and openEnquiry challenges before it
   * mints one. The challenge has therefore already been paid by the time
   * anybody can reach this door, which is the same reasoning that keeps it off
   * the guest message route and off reading a conversation. A second challenge
   * mid-conversation would stop nobody who got past the first one and would
   * stop the customer standing in their own kitchen on a weak signal trying to
   * show somebody a leak.
   *
   * The stub throws on ANY outbound fetch, so a siteverify call added here
   * later fails this test loudly rather than quietly costing every customer a
   * captcha.
   */
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    env.TURNSTILE_SECRET = 'test-secret-not-a-real-one';
    globalThis.fetch = vi.fn(async (input: any) => {
      throw new Error(`unexpected outbound fetch: ${String(input?.url ?? input)}`);
    }) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('lets a customer send a photograph with no challenge to solve', async () => {
    const { opId } = await signIn('a@example.com');
    const { token } = await startThread(env, { operator_id: opId, guest_name: 'Rosa' });

    const res = await post(`/api/public/threads/${token}/photos`, form(photoFromAPhone()));
    expect(res.status).toBe(201);
    expect(await photoRows()).toBe(1);
  });
});

describe('the booking a photograph turns out to belong to', () => {
  /**
   * The most useful picture on the job is the one sent BEFORE the booking
   * exists -- a stranger showing what they actually want done. Left with a
   * null booking for ever it would look like an idle enquiry, and anything
   * that keeps photographs longer while a job is disputed would age out the
   * one picture the dispute is about.
   */
  async function bookingOn(operatorId: string, threadId: string, appointmentId: string) {
    const t = now();
    const orderId = newId();
    const itemId = newId();
    await env.DB.prepare(
      `INSERT INTO orders (id, currency, total_cents, created_at, updated_at)
       VALUES (?, 'USD', 0, ?, ?)`,
    ).bind(orderId, t, t).run();
    await env.DB.prepare(
      `INSERT INTO order_items (id, order_id, operator_id, appointment_id, starts_at,
         ends_at, duration_seconds, price_cents, created_at)
       VALUES (?,?,?,?,?,?,3600,0,?)`,
    ).bind(itemId, orderId, operatorId, appointmentId, t, t + 3600, t).run();
    await attachBooking(env, threadId, { appointment_id: appointmentId });
    return itemId;
  }

  it('is filled in once when the conversation finally gets one', async () => {
    const { opId, cookie } = await signIn('a@example.com');
    const { thread } = await startThread(env, { operator_id: opId, guest_name: 'Rosa' });

    const early = await (await post(`/api/threads/${thread.id}/photos`,
      form(photoFromAPhone(), { body: 'Is this the tap you meant?' }), { cookie }))
      .json() as any;

    const before = await env.DB.prepare(
      `SELECT order_item_id FROM message_photos WHERE id = ?`,
    ).bind(early.message.photo.id).first<any>();
    expect(before.order_item_id).toBeNull();

    const firstItem = await bookingOn(opId, thread.id, newId());

    const after = await env.DB.prepare(
      `SELECT order_item_id FROM message_photos WHERE id = ?`,
    ).bind(early.message.photo.id).first<any>();
    expect(after.order_item_id).toBe(firstItem);

    // A photograph sent once the booking exists is attributed at upload, with
    // no backfill needed.
    const later = await (await post(`/api/threads/${thread.id}/photos`,
      form(photoFromAPhone()), { cookie })).json() as any;
    const laterRow = await env.DB.prepare(
      `SELECT order_item_id FROM message_photos WHERE id = ?`,
    ).bind(later.message.photo.id).first<any>();
    expect(laterRow.order_item_id).toBe(firstItem);

    // And when the same customer comes back a year later and the thread is
    // re-pointed at a new job, last year's pictures keep last year's job.
    const secondItem = await bookingOn(opId, thread.id, newId());
    expect(secondItem).not.toBe(firstItem);

    const kept = await env.DB.prepare(
      `SELECT order_item_id FROM message_photos WHERE id IN (?,?)`,
    ).bind(early.message.photo.id, later.message.photo.id).all<any>();
    expect((kept.results ?? []).map((r: any) => r.order_item_id))
      .toEqual([firstItem, firstItem]);
  });
});
