import { describe, expect, it, beforeEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import { fakeKV, type FakeKV } from './kv';
import worker from '../src/index';
import type { Env } from '../src/types';
import { addJobPhoto, readJobPhoto } from '../src/lib/proof';
import { newId, now } from '../src/lib/util';

/**
 * The upload routes, with a photo store behind them.
 *
 * images.test.ts proves the stripper works on bytes. This proves the bytes it
 * works on are the bytes that get stored -- which is the half that was
 * actually missing, because a stripper nothing calls is a comment.
 *
 * The store is a Workers KV namespace and it is commented out in
 * wrangler.toml until somebody creates it, which is why photo upload answers
 * 503 in production today. That is exactly why this is worth having now: the
 * day the namespace is created, whatever these handlers do at that moment
 * starts happening to real photographs of the inside of people's houses.
 */

const BASE = 'https://gap.test';
let env: Env;
let photos: FakeKV;
/** The backing map, named as it was when this was a fake R2 bucket. */
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

/** The marker that says the file still knows where it was taken. */
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

function form(file: Uint8Array, opts: { name?: string; type?: string; stage?: string } = {}) {
  const fd = new FormData();
  fd.set('file', new File([file], opts.name ?? 'IMG_0421.HEIC', {
    type: opts.type ?? 'image/heic',
  }));
  if (opts.stage) fd.set('stage', opts.stage);
  return fd;
}

/** An operator with a live session. */
async function signIn(email: string) {
  const t = now();
  const opId = newId();
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,timezone,country,currency,
       location_mode,fill_model,sms_mode,plan,created_at,updated_at)
     VALUES (?,?, 'Valley Detailing','America/Los_Angeles','US','USD','mobile','both',
       'device','active',?,?)`,
  ).bind(opId, email, t, t).run();

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

/** A PNG a phone would write: an eXIf chunk with the address, then the image. */
function pngFromAPhone(): Uint8Array {
  return bytes(
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
    ...be32(13), 'IHDR', new Array(13).fill(0), 0, 0, 0, 0,
    ...be32(HOME.length), 'eXIf', HOME, 0, 0, 0, 0,
    ...be32(4), 'IDAT', [1, 2, 3, 4], 0, 0, 0, 0,
    ...be32(0), 'IEND', 0, 0, 0, 0,
  );
}

const post = (path: string, body: BodyInit, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`${BASE}${path}`, { method: 'POST', body, headers }),
    env, {} as ExecutionContext);

const get = (path: string, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`${BASE}${path}`, { headers }), env, {} as ExecutionContext);

const photoUrl = (key: string) => `/api/public/photo/${encodeURIComponent(key)}`;

beforeEach(() => {
  photos = fakeKV();
  stored = photos.entries;
  env = { ...makeEnv(ALL_MIGRATIONS), PHOTOS: photos } as unknown as Env;
});

describe('a photo going onto a public profile', () => {
  it('reaches the store without the address it was taken at', async () => {
    const { cookie } = await signIn('a@example.com');
    const original = photoFromAPhone();
    expect(has(original, HOME)).toBe(true);

    const res = await post('/api/profile/photos',
      form(original, { type: 'image/jpeg', name: 'work.jpg' }), { cookie });
    expect(res.status).toBe(201);

    expect(stored.size).toBe(1);
    const object = [...stored.values()][0]!;
    // The whole point, on the only path where it can be checked end to end.
    expect(has(object.bytes, HOME)).toBe(false);
    expect(has(object.bytes, 'Exif')).toBe(false);
    expect(object.contentType).toBe('image/jpeg');

    // And the row describes the bytes it points at, not the file that arrived.
    const row = await env.DB.prepare(`SELECT bytes, content_type FROM work_photos`)
      .first<{ bytes: number; content_type: string }>();
    expect(row!.bytes).toBe(object.bytes.length);
    expect(row!.bytes).toBeLessThan(original.length);
    expect(row!.content_type).toBe('image/jpeg');
  });

  it('refuses a file that is not an image, and stores nothing', async () => {
    const { cookie } = await signIn('b@example.com');
    const res = await post('/api/profile/photos',
      form(bytes('<html><script>alert(1)</script>'), { name: 'photo.jpg', type: 'image/jpeg' }),
      { cookie });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'bad_type' });
    // Not stored and then cleaned up: never put in the store at all.
    expect(stored.size).toBe(0);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM work_photos`)
      .first<{ n: number }>()).toMatchObject({ n: 0 });
  });

  it('will not take a HEIC, which no browser would render', async () => {
    const { cookie } = await signIn('c@example.com');
    const heic = bytes(...be32(24), 'ftyp', 'heic', ...be32(0), 'heic', ...be32(8), 'mdat');
    const res = await post('/api/profile/photos', form(heic), { cookie });
    expect(res.status).toBe(400);
    expect(stored.size).toBe(0);
  });

  it('refuses a body that announces itself as far too big, before reading it', async () => {
    const { cookie } = await signIn('d@example.com');
    // Content-Length is the caller's own claim, and a caller claiming forty
    // megabytes is not worth buffering to disbelieve.
    const res = await post('/api/profile/photos', photoFromAPhone(),
      { cookie, 'content-type': 'multipart/form-data; boundary=x', 'content-length': '40000000' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'too_big' });
    expect(stored.size).toBe(0);
  });
});

describe('a photo of the job itself', () => {
  /** A booking, and the operator it belongs to. */
  async function booking() {
    const { opId } = await signIn('op@example.com');
    const t = now();
    const orderId = newId();
    const itemId = newId();
    await env.DB.prepare(
      `INSERT INTO orders (id,guest_name,status,currency,created_at,updated_at)
       VALUES (?, 'Debra Dawson','pending','USD',?,?)`,
    ).bind(orderId, t, t).run();
    await env.DB.prepare(
      `INSERT INTO order_items (id,order_id,operator_id,starts_at,ends_at,
         duration_seconds,price_cents,created_at)
       VALUES (?,?,?,?,?,3600,20000,?)`,
    ).bind(itemId, orderId, opId, t - 7200, t - 3600, t).run();
    return { opId, itemId };
  }

  it('strips the evidence photo too — it is the one that can end up published', async () => {
    // A job photo is the file a customer can later release onto a public
    // review (migration 0028). If the coordinates are still in it when they
    // do, the strip on the profile path was decoration.
    const { opId, itemId } = await booking();
    const original = photoFromAPhone();

    const photo = await addJobPhoto(env, { operator_id: opId }, {
      order_item_id: itemId, stage: 'after',
      file: new File([original], 'IMG_0421.JPG', { type: 'image/jpeg' }),
    });

    const object = stored.get(photo.r2_key)!;
    expect(has(object.bytes, HOME)).toBe(false);
    expect(object.contentType).toBe('image/jpeg');
    expect(photo.content_type).toBe('image/jpeg');
    expect(photo.bytes).toBe(object.bytes.length);
  });

  it('refuses bytes that are not an image and leaves the store alone', async () => {
    const { opId, itemId } = await booking();
    await expect(addJobPhoto(env, { operator_id: opId }, {
      order_item_id: itemId, stage: 'after',
      file: new File([bytes('PK a zip file')], 'x.jpg', { type: 'image/jpeg' }),
    })).rejects.toThrow(/not a photo we can store/i);
    expect(stored.size).toBe(0);
  });

  it('takes the HEIC an iPhone actually produces', async () => {
    const { opId, itemId } = await booking();
    const heic = bytes(...be32(24), 'ftyp', 'heic', ...be32(0), 'heic', ...be32(8), 'mdat');
    const photo = await addJobPhoto(env, { operator_id: opId }, {
      // Announced as a JPEG, because that is what a browser file picker
      // sometimes calls it. The bytes decide.
      order_item_id: itemId, stage: 'before',
      file: new File([heic], 'IMG_0422.HEIC', { type: 'image/jpeg' }),
    });
    expect(photo.content_type).toBe('image/heic');
    expect(stored.get(photo.r2_key)!.contentType).toBe('image/heic');
  });
});

/**
 * The content type, all the way round.
 *
 * This is the join that the move from R2 to Workers KV broke and had to be
 * rebuilt by hand, so it is the one that has to be pinned. R2 held the content
 * type in `httpMetadata` and stamped it back onto a Response for you through
 * `writeHttpMetadata`; KV has neither. The type now goes out in KV's opaque
 * metadata blob on `put` and comes back only through `getWithMetadata`, and
 * the response header is built by hand from what comes back. Every step of
 * that is invisible to the type checker -- the metadata blob is `any` in
 * Cloudflare's own types -- so a photograph served as the wrong type, or as no
 * type at all, would compile perfectly.
 */
describe('the content type, from the bytes to the browser', () => {
  it('stores the sniffed type and serves that same type back', async () => {
    const { cookie } = await signIn('round@example.com');

    // Declared image/jpeg by the file picker and actually a PNG. The sniffed
    // type is the only one allowed to survive this: what is stored and what is
    // served have to be what the bytes are.
    const res = await post('/api/profile/photos',
      form(pngFromAPhone(), { type: 'image/jpeg', name: 'work.jpg' }), { cookie });
    expect(res.status).toBe(201);
    const { photo } = await res.json() as { photo: { r2_key: string } };

    // Recorded on the way in, in KV's metadata and not in anything HTTP-shaped.
    expect(stored.get(photo.r2_key)!.contentType).toBe('image/png');

    // And handed back on the way out, on the public route, which is the one
    // with no session in front of it.
    const served = await get(photoUrl(photo.r2_key));
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    // nosniff is on every response, so a browser cannot talk itself into
    // treating these bytes as anything else either.
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');

    // The bytes are the stripped ones, not the ones that arrived.
    const back = new Uint8Array(await served.arrayBuffer());
    expect(back).toEqual(stored.get(photo.r2_key)!.bytes);
    expect(has(back, HOME)).toBe(false);
  });

  it('still answers a conditional request without an etag from the store', async () => {
    // R2 gave every object an httpEtag and this route used it. KV has none, so
    // the etag is derived from the key -- sound only because keys here are
    // written once and never overwritten. If that ever stops being true this
    // test keeps passing and the behaviour becomes a stale-content bug, which
    // is why the invariant is written out at the call site as well as here.
    const { cookie } = await signIn('etag@example.com');
    const res = await post('/api/profile/photos',
      form(photoFromAPhone(), { type: 'image/jpeg', name: 'work.jpg' }), { cookie });
    const { photo } = await res.json() as { photo: { r2_key: string } };

    const first = await get(photoUrl(photo.r2_key));
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();

    const again = await get(photoUrl(photo.r2_key), { 'if-none-match': etag! });
    expect(again.status).toBe(304);
    expect(again.headers.get('etag')).toBe(etag);
  });

  it('serves bytes it has no recorded type for as opaque, never as a guess', async () => {
    // A value written by something that is not putPhoto -- an older entry, or
    // a hand-run wrangler command. We do not know what these bytes are, and
    // the honest answer is to say so rather than to assume image/jpeg and hand
    // a stranger something a browser might act on.
    photos.seed('w/op/mystery', undefined, bytes('not really anything'));
    const res = await get(photoUrl('w/op/mystery'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('is a 404 for a key that is not in the store', async () => {
    // getWithMetadata does NOT return null for a missing key, it returns an
    // object whose value is null. A port of the old `if (!object)` check that
    // missed that would answer 200 with an empty body here.
    const res = await get(photoUrl('w/op/never-existed'));
    expect(res.status).toBe(404);
  });

  it('serves a job photo from the row it holds, not from the stored metadata', async () => {
    const { opId } = await signIn('job@example.com');
    const t = now();
    const orderId = newId();
    const itemId = newId();
    await env.DB.prepare(
      `INSERT INTO orders (id,guest_name,status,currency,created_at,updated_at)
       VALUES (?, 'Debra Dawson','pending','USD',?,?)`,
    ).bind(orderId, t, t).run();
    await env.DB.prepare(
      `INSERT INTO order_items (id,order_id,operator_id,starts_at,ends_at,
         duration_seconds,price_cents,created_at)
       VALUES (?,?,?,?,?,3600,20000,?)`,
    ).bind(itemId, orderId, opId, t - 7200, t - 3600, t).run();

    const heic = bytes(...be32(24), 'ftyp', 'heic', ...be32(0), 'heic', ...be32(8), 'mdat');
    const photo = await addJobPhoto(env, { operator_id: opId }, {
      order_item_id: itemId, stage: 'after',
      file: new File([heic], 'IMG_0422.HEIC', { type: 'image/jpeg' }),
    });

    // Both copies agree because both are written from one cleanImageUpload
    // result. The route reads the row's, because it already holds the row.
    expect(stored.get(photo.r2_key)!.contentType).toBe('image/heic');
    const served = await readJobPhoto(env, { operator_id: opId }, photo.id);
    expect(served.headers.get('content-type')).toBe('image/heic');
    expect(served.headers.get('cache-control')).toBe('private, max-age=3600');

    // And it is genuinely streaming the stored bytes back, not an empty body.
    const back = new Uint8Array(await served.arrayBuffer());
    expect(back).toEqual(stored.get(photo.r2_key)!.bytes);
  });
});

/**
 * With no photo store bound at all.
 *
 * The property being pinned is the one that let this ship: env.PHOTOS is
 * OPTIONAL, so a deployment with no namespace created answers 503 or 404 on
 * the photo routes and serves everything else normally. That is what stopped a
 * missing bucket failing the whole deploy for the entire life of the codebase,
 * and it has to go on being true now that the binding is KV -- the namespace
 * does not exist until somebody runs `wrangler kv namespace create PHOTOS`,
 * and until then this is the state production is actually in.
 */
describe('with no photo store bound at all', () => {
  beforeEach(() => {
    env = { ...env, PHOTOS: undefined } as unknown as Env;
  });

  it('refuses a profile upload with 503 and writes no row', async () => {
    const { cookie } = await signIn('none-a@example.com');
    const res = await post('/api/profile/photos',
      form(photoFromAPhone(), { type: 'image/jpeg', name: 'work.jpg' }), { cookie });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'no_storage' });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM work_photos`)
      .first<{ n: number }>()).toMatchObject({ n: 0 });
  });

  it('refuses a job photo and writes no row', async () => {
    const { opId } = await signIn('none-b@example.com');
    const t = now();
    const orderId = newId();
    const itemId = newId();
    await env.DB.prepare(
      `INSERT INTO orders (id,guest_name,status,currency,created_at,updated_at)
       VALUES (?, 'Debra Dawson','pending','USD',?,?)`,
    ).bind(orderId, t, t).run();
    await env.DB.prepare(
      `INSERT INTO order_items (id,order_id,operator_id,starts_at,ends_at,
         duration_seconds,price_cents,created_at)
       VALUES (?,?,?,?,?,3600,20000,?)`,
    ).bind(itemId, orderId, opId, t - 7200, t - 3600, t).run();

    await expect(addJobPhoto(env, { operator_id: opId }, {
      order_item_id: itemId, stage: 'after',
      file: new File([photoFromAPhone()], 'x.jpg', { type: 'image/jpeg' }),
    })).rejects.toThrow(/not switched on/i);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM job_photos`)
      .first<{ n: number }>()).toMatchObject({ n: 0 });
  });

  it('answers 404 on the public photo route rather than throwing', async () => {
    // 404 and not 503: this route is reachable by anybody, and what it tells a
    // stranger about a key must not depend on whether storage is configured.
    const res = await get(photoUrl('w/op/anything'));
    expect(res.status).toBe(404);
  });

  it('answers 404 on a released review photo', async () => {
    const res = await get('/api/public/review-photo/whatever');
    expect(res.status).toBe(404);
  });

  it('leaves the rest of the site working', async () => {
    // The whole reason the binding is optional. Listing photos reads the
    // database and never the store, so it answers normally with an empty list
    // rather than joining the photo routes in refusing.
    const { cookie } = await signIn('none-c@example.com');
    const res = await get('/api/profile/photos', { cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ photos: [] });
  });
});
