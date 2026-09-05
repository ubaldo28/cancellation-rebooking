import { describe, expect, it, beforeEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import worker from '../src/index';
import type { Env } from '../src/types';
import { addJobPhoto } from '../src/lib/proof';
import { newId, now } from '../src/lib/util';

/**
 * The upload routes, with a bucket behind them.
 *
 * images.test.ts proves the stripper works on bytes. This proves the bytes it
 * works on are the bytes that get stored -- which is the half that was
 * actually missing, because a stripper nothing calls is a comment.
 *
 * R2 is not switched on in production yet, which is why photo upload currently
 * answers 503. That is exactly why this is worth having now: the day the
 * bucket is enabled, whatever the handler does at that moment starts happening
 * to real photographs of the inside of people's houses.
 */

const BASE = 'https://gap.test';
let env: Env;
let stored: Map<string, { bytes: Uint8Array; contentType?: string }>;

/** Enough of an R2 bucket to see what was written to it. */
function fakeBucket() {
  stored = new Map();
  return {
    put: async (key: string, body: unknown, opts?: any) => {
      const bytes = body instanceof Uint8Array ? new Uint8Array(body)
        : new Uint8Array(await new Response(body as any).arrayBuffer());
      stored.set(key, { bytes, contentType: opts?.httpMetadata?.contentType });
      return {};
    },
    get: async () => null,
    delete: async (key: string) => { stored.delete(key); },
  };
}

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

  return { opId, cookie: `gf_session=${raw}` };
}

const post = (path: string, body: BodyInit, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`${BASE}${path}`, { method: 'POST', body, headers }),
    env, {} as ExecutionContext);

beforeEach(() => {
  env = { ...makeEnv(ALL_MIGRATIONS), PHOTOS: fakeBucket() } as unknown as Env;
});

describe('a photo going onto a public profile', () => {
  it('reaches the bucket without the address it was taken at', async () => {
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

    // And the row describes the object it points at, not the file that arrived.
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
    // Not stored and then cleaned up: never put in the bucket at all.
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

  it('refuses bytes that are not an image and leaves the bucket alone', async () => {
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
