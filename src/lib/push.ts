import type { Env } from '../types';

/**
 * Web Push, implemented here rather than pulled in.
 *
 * The requirement behind alerts is "tell the customer when a van comes near",
 * and the requirement behind THAT is the same one the chat feature has: no
 * phone numbers, no SMS. Web Push is the only channel that satisfies both --
 * it is free, it needs no provider account, the customer revokes it from their
 * own browser in one tap, and it works in Chrome, Firefox, Edge and, since iOS
 * 16.4, in an installed web app on an iPhone.
 *
 * There is no library because there cannot be one: the published web-push
 * packages are written against Node's crypto module, and a Worker has
 * WebCrypto and nothing else. What follows is the whole protocol -- VAPID
 * (RFC 8292) to prove who is sending, and aes128gcm payload encryption
 * (RFC 8291, framed by RFC 8188) so the push service relays a message it
 * cannot read. It is fiddly, and every step below says what it is doing and
 * why, because the failure mode of getting one byte wrong is a 400 from
 * Google with no explanation.
 */

/**
 * The three secrets this file needs, none of which are in Env.
 *
 * They are declared here instead of in src/types.ts because push is optional:
 * an environment with no VAPID keys still boots, still serves the map, still
 * takes bookings -- alerts just never leave the building. Making them required
 * bindings would take the whole Worker down over a feature nothing else
 * depends on, which is the same call wrangler.toml already makes for R2.
 */
export interface VapidEnv extends Env {
  /** Base64url, raw uncompressed P-256 point (65 bytes, leading 0x04). */
  VAPID_PUBLIC_KEY?: string;
  /** Base64url, either the raw 32-byte scalar or a PKCS8 blob. */
  VAPID_PRIVATE_KEY?: string;
  /** mailto: or https: URL identifying the sender, per RFC 8292. */
  VAPID_SUBJECT?: string;
}

/** A delivery address, exactly as the browser's PushSubscription describes it. */
export interface PushTarget {
  endpoint: string;
  /** The browser's public key, base64url, raw uncompressed P-256 point. */
  p256dh: string;
  /** The browser's auth secret, base64url, 16 bytes. */
  auth: string;
}

export interface PushResult {
  ok: boolean;
  /**
   * The push service says this subscription no longer exists (404 or 410).
   *
   * Distinct from a plain failure on purpose: a transient 500 should be tried
   * again on the next tick, and a 410 never should. Retrying a dead endpoint
   * is a request per watch per tick, forever, that cannot succeed.
   */
  gone: boolean;
}

/** How long a payload may be. Push services reject about 4 KB; leave headroom. */
const MAX_PAYLOAD_BYTES = 3800;

/** How long the browser's push service should hold an undelivered alert. */
const TTL_SECONDS = 6 * 3600;

/**
 * The record size in the aes128gcm header.
 *
 * Everything here fits in one record, so this only has to be larger than the
 * plaintext plus the 16-byte GCM tag. 4096 is the conventional value.
 */
const RECORD_SIZE = 4096;

// ---------------------------------------------------------------------------
// base64url, both directions. Every key, every secret and the JWT itself
// travel in this encoding, and the padding-stripping is not optional -- a
// trailing '=' in an Authorization header is a 401 with no message.
// ---------------------------------------------------------------------------

function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(input: string): Uint8Array {
  // Accept standard base64 too: browsers hand back base64url, but a key pasted
  // out of a generator script may not have been converted.
  const s = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/**
 * The VAPID public key the browser needs before it can subscribe.
 *
 * The browser passes this to pushManager.subscribe() as applicationServerKey,
 * and the push service then refuses any message not signed by the matching
 * private key. Returns null when push is switched off, which the front end
 * reads as "do not offer alerts" rather than as an error.
 */
export function vapidPublicKey(env: Env): string | null {
  const key = (env as VapidEnv).VAPID_PUBLIC_KEY;
  return key && key.trim() ? key.trim() : null;
}

/**
 * Loads the VAPID signing key.
 *
 * Two encodings are accepted because two tools produce them. A 32-byte value
 * is the raw private scalar, which is what the standard generators emit; it
 * cannot be imported on its own, so it is reassembled into a JWK using the x
 * and y coordinates carried in the public key. Anything longer is treated as
 * PKCS8, which is what a plain `openssl` or Node `exportKey('pkcs8')` gives.
 */
async function importVapidKey(publicKey: string, privateKey: string): Promise<CryptoKey> {
  const priv = b64urlDecode(privateKey);

  if (priv.length === 32) {
    const pub = b64urlDecode(publicKey);
    // 0x04 marks an uncompressed point; x and y are the 32 bytes each after it.
    if (pub.length !== 65 || pub[0] !== 0x04) {
      throw new Error('VAPID_PUBLIC_KEY is not a raw uncompressed P-256 point');
    }
    return crypto.subtle.importKey(
      'jwk',
      {
        kty: 'EC',
        crv: 'P-256',
        d: b64urlEncode(priv),
        x: b64urlEncode(pub.slice(1, 33)),
        y: b64urlEncode(pub.slice(33, 65)),
        ext: true,
      },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    );
  }

  return crypto.subtle.importKey(
    'pkcs8',
    priv as unknown as BufferSource,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

/**
 * The VAPID Authorization header: a JWT saying who is sending this.
 *
 * The audience is the ORIGIN of the endpoint, not the endpoint itself -- one
 * token is reusable across every subscription on the same push service, and
 * putting the full URL in there is a 401. The expiry has to be inside 24
 * hours; twelve is the usual choice and leaves room for clock skew at both
 * ends.
 */
async function vapidHeader(env: VapidEnv, endpoint: string): Promise<string> {
  const audience = new URL(endpoint).origin;
  const header = { typ: 'JWT', alg: 'ES256' };
  const claims = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT!,
  };

  const signingInput =
    `${b64urlEncode(utf8(JSON.stringify(header)))}.${b64urlEncode(utf8(JSON.stringify(claims)))}`;

  const key = await importVapidKey(env.VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!);
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    utf8(signingInput) as unknown as BufferSource,
  );

  // WebCrypto already emits the JOSE format -- the raw 64-byte r||s pair of
  // IEEE P1363 -- so there is nothing to convert. This is worth stating
  // because Node's crypto module emits a DER-wrapped signature for the same
  // algorithm, and code ported from a Node web-push library will carry a
  // DER-to-raw step that must be deleted here rather than kept.
  const jwt = `${signingInput}.${b64urlEncode(new Uint8Array(signature))}`;

  return `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY!.trim()}`;
}

/**
 * Encrypts a payload so that only this one browser can read it (RFC 8291).
 *
 * The push service is an untrusted relay -- Google, Mozilla or Apple sees
 * every byte we hand it -- so the message is encrypted to a key that only the
 * subscriber's browser holds. The shape of it:
 *
 *   1. Make a throwaway P-256 key pair for this single message.
 *   2. ECDH it against the browser's public key (p256dh) for a shared secret.
 *   3. Mix in the subscription's auth secret, which the push service never
 *      sees, so possessing the relay traffic is not enough to derive the key.
 *   4. Derive a content encryption key and a nonce from that.
 *   5. AES-128-GCM the payload.
 *   6. Prefix the RFC 8188 header, which carries the salt and our throwaway
 *      public key so the browser can repeat steps 2-4 in reverse.
 */
async function encryptPayload(
  target: PushTarget, payload: string,
): Promise<Uint8Array> {
  const plaintextBody = utf8(payload);
  if (plaintextBody.length > MAX_PAYLOAD_BYTES) {
    throw new Error(`push payload is ${plaintextBody.length} bytes; cap is ${MAX_PAYLOAD_BYTES}`);
  }

  const uaPublicBytes = b64urlDecode(target.p256dh);
  const authSecret = b64urlDecode(target.auth);

  // 1. The single-use key pair. A fresh one per message is what makes the
  //    derived key unique per message; reusing one would reuse the nonce.
  const ephemeral = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  ) as CryptoKeyPair;
  // exportKey is typed as ArrayBuffer | JsonWebKey because the format is a
  // runtime argument; 'raw' always returns the buffer.
  const asPublicBytes = new Uint8Array(
    await crypto.subtle.exportKey('raw', ephemeral.publicKey) as ArrayBuffer,
  );

  // 2. ECDH against the browser's key. Both sides now hold the same 32 bytes
  //    without either having sent them.
  const uaPublicKey = await crypto.subtle.importKey(
    'raw', uaPublicBytes as unknown as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  // The property is `public` on the wire, as WebCrypto specifies it. The cast
  // is because @cloudflare/workers-types calls it `$public` -- its generator
  // escapes names that collide with TypeScript keywords -- and writing that
  // would send the runtime a field it does not know.
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaPublicKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
    ephemeral.privateKey,
    256,
  ));

  // 3. HKDF with the auth secret as the salt, over the shared secret. The info
  //    string binds the result to both public keys, so a derived key from one
  //    conversation cannot be replayed into another. The trailing NUL in
  //    "WebPush: info\0" is part of the spec's info string, not a typo.
  const ikm = await hkdf(
    authSecret,
    sharedSecret,
    concat(utf8('WebPush: info\0'), uaPublicBytes, asPublicBytes),
    32,
  );

  // 4. A random salt per message, then the content encryption key and the
  //    nonce out of the same HKDF. Both info strings are NUL-terminated for
  //    the same reason.
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cekBytes = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);

  // 5. The 0x02 byte is the RFC 8188 padding delimiter marking the LAST
  //    record. Everything fits in one record here, so it is always 0x02; a
  //    0x01 would tell the browser to wait for a record that never comes, and
  //    the notification would silently never fire.
  const plaintext = concat(plaintextBody, new Uint8Array([0x02]));
  const cek = await crypto.subtle.importKey(
    'raw', cekBytes as unknown as BufferSource, { name: 'AES-GCM' }, false, ['encrypt'],
  );
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce as unknown as BufferSource, tagLength: 128 },
    cek,
    plaintext as unknown as BufferSource,
  ));

  // 6. The header block, in the exact order RFC 8188 gives it:
  //    salt (16) | record size (4, big-endian) | key id length (1) | key id.
  //    Our key id is the throwaway public key, which is how the browser gets
  //    it -- there is nowhere else in the message it could travel.
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, RECORD_SIZE, false);

  return concat(
    salt,
    recordSize,
    new Uint8Array([asPublicBytes.length]),
    asPublicBytes,
    ciphertext,
  );
}

/**
 * HKDF (extract-and-expand) in one call.
 *
 * WebCrypto's HKDF does both halves and appends the 0x01 counter byte itself,
 * so the hand-rolled two-step HMAC dance found in older web-push code is not
 * needed -- and reproducing it by hand is where an off-by-one in the info
 * string usually creeps in.
 */
async function hkdf(
  salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, lengthBytes: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw', ikm as unknown as BufferSource, 'HKDF', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt as unknown as BufferSource,
      info: info as unknown as BufferSource,
    },
    key,
    lengthBytes * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Sends one notification.
 *
 * Never throws. Push is a best-effort side channel on top of a booking system
 * that has to keep working: a malformed subscription row, a push service
 * having a bad afternoon, or VAPID simply not being configured must all end up
 * as a false in a log line, not as an exception that aborts the cron tick and
 * takes every other watch down with it.
 *
 * `gone` is the one distinction the caller has to act on: it means disable
 * this subscription, not try again.
 */
export async function sendPush(
  env: Env, sub: PushTarget, payload: string,
): Promise<PushResult> {
  const e = env as VapidEnv;

  // Push switched off. Not an error, and deliberately silent-ish: every
  // preview environment and every test run is in this state, and a throw here
  // would make "alerts are not configured" indistinguishable from "alerts are
  // broken".
  if (!e.VAPID_PUBLIC_KEY?.trim() || !e.VAPID_PRIVATE_KEY?.trim() || !e.VAPID_SUBJECT?.trim()) {
    return { ok: false, gone: false };
  }

  try {
    const [authorization, body] = await Promise.all([
      vapidHeader(e, sub.endpoint),
      encryptPayload(sub, payload),
    ]);

    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(TTL_SECONDS),
        // Below 'normal' a phone may batch the alert until the screen next
        // wakes, which for a slot that expires in four hours is the same as
        // not sending it.
        urgency: 'normal',
      },
      body: body as unknown as BodyInit,
    });

    // 404: the endpoint never existed or the push service dropped it.
    // 410 Gone: the browser unsubscribed or the app was uninstalled.
    // Either way there is nobody on the other end, ever again.
    if (res.status === 404 || res.status === 410) return { ok: false, gone: true };

    return { ok: res.ok, gone: false };
  } catch (err) {
    // A bad key, an unparseable endpoint, a network failure. The watch stays
    // live and the next tick tries again.
    console.error('push failed', err);
    return { ok: false, gone: false };
  }
}
