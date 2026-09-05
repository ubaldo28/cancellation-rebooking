import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import type { Env } from '../src/types';
import {
  addSubscription, createWatch, deactivateWatch, matchWatches, removeSubscription,
  updateWatch, watchByToken,
} from '../src/lib/alerts';
import { sendPush, vapidPublicKey } from '../src/lib/push';
import { newId, now } from '../src/lib/util';

const MIGRATIONS = ALL_MIGRATIONS;

let env: Env;
const OP = 'op1';
const t = () => now();

// Sherman Oaks. The van works between two jobs a few blocks apart; the watch
// address sits between them. Woodland Hills is over the hill, and is the one
// that has to NOT match.
const PREV = { lat: 34.1500, lng: -118.4490 };
const NEXT = { lat: 34.1520, lng: -118.4400 };
const NEAR = { lat: 34.1510, lng: -118.4450 };
const FAR = { lat: 34.1680, lng: -118.6050 };

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

async function seed(opts: { trade?: string; priceCents?: number } = {}) {
  env = makeEnv(MIGRATIONS) as unknown as Env;
  const n = t();

  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,trade,timezone,country,currency,language,
       location_mode,fill_model,sms_mode,max_detour_seconds,min_gap_seconds,buffer_seconds,
       offer_ttl_seconds,offers_per_wave,min_notice_seconds,reoffer_cooldown_seconds,
       discount_percent,plan,accept_public_bookings,deposit_cents,created_at,updated_at)
     VALUES (?,?,?,?, 'America/Los_Angeles','US','USD','en','mobile','both','device',
       900,3600,900,5400,3,3600,604800,0,'active',1,1000,?,?)`,
  ).bind(OP, 'a@x.com', 'Valley Detailing', opts.trade ?? 'mobile car wash and detailing', n, n).run();

  await env.DB.prepare(
    `INSERT INTO services (id,operator_id,name,duration_seconds,price_cents,cadence_days,
       created_at,updated_at)
     VALUES ('sv',?,'Full detail',7200,?,28,?,?)`,
  ).bind(OP, opts.priceCents ?? 9900, n, n).run();

  await env.DB.prepare(
    `INSERT INTO service_areas (id,operator_id,name,slug,place_slug,lat,lng,radius_meters,
       created_at,updated_at)
     VALUES (?,?,'Sherman Oaks','sherman-oaks','sherman-oaks',?,?,8000,?,?)`,
  ).bind(newId(), OP, PREV.lat, PREV.lng, n, n).run();

  // The offline geocoder needs the ZIP in the table, same as in production.
  await env.DB.prepare(
    `INSERT INTO postal_codes (country_code,postal_code,place_name,lat,lng,accuracy)
     VALUES ('US','91403','Sherman Oaks',?,?,6)`,
  ).bind(NEAR.lat, NEAR.lng).run();
  await env.DB.prepare(
    `INSERT INTO postal_codes (country_code,postal_code,place_name,lat,lng,accuracy)
     VALUES ('US','91367','Woodland Hills',?,?,6)`,
  ).bind(FAR.lat, FAR.lng).run();
}

/** One open gap with the van parked either side of it. */
async function addGap(hoursFromNow = 4): Promise<string> {
  const n = t();
  const id = newId();
  const start = n + hoursFromNow * 3600;
  await env.DB.prepare(
    `INSERT INTO gaps (id,operator_id,starts_at,ends_at,prev_lat,prev_lng,next_lat,next_lng,
       baseline_drive_seconds,is_mobile,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,1,'open',?,?)`,
  ).bind(id, OP, start, start + 5 * 3600,
    PREV.lat, PREV.lng, NEXT.lat, NEXT.lng, 180, n, n).run();
  return id;
}

const b64u = (b: ArrayBuffer | Uint8Array) => {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
  let out = '';
  for (const x of bytes) out += String.fromCharCode(x);
  return btoa(out).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/**
 * A real browser subscription, not a placeholder.
 *
 * p256dh has to be an actual P-256 point: the payload is encrypted to it, and
 * a made-up string would fail inside sendPush and turn every delivery test
 * into a test of the same error path.
 */
const browserKeys = await crypto.subtle.generateKey(
  { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;

const SUB = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/aaa',
  keys: {
    p256dh: b64u(await crypto.subtle.exportKey('raw', browserKeys.publicKey) as ArrayBuffer),
    auth: b64u(crypto.getRandomValues(new Uint8Array(16))),
  },
};

const hitCount = async (watchId: string) => (await env.DB.prepare(
  `SELECT COUNT(*) AS n FROM watch_hits WHERE watch_id = ?`,
).bind(watchId).first<{ n: number }>())!.n;

/** What the watches table itself says was delivered. */
const stateOf = (watchId: string) => env.DB.prepare(
  `SELECT email, email_failed_count, last_notified_at, notify_count
     FROM watches WHERE id = ?`,
).bind(watchId).first<{
  email: string | null; email_failed_count: number;
  last_notified_at: number | null; notify_count: number;
}>();

/**
 * A push service and an email provider that both answer, and a tally of what
 * each was asked to send.
 *
 * Needed by any test about the caps: an alert only spends the customer's one
 * an hour if it actually reached them, so a test that wants the limiter to
 * bite has to deliver something first.
 */
async function stubDelivery(
  opts: { email?: boolean; emailStatus?: number } = {},
): Promise<{ push: number; email: number }> {
  Object.assign(env as unknown as Record<string, unknown>, await vapidKeyPair());
  if (opts.email !== false) {
    Object.assign(env as unknown as Record<string, unknown>, {
      EMAIL_PROVIDER: 'resend',
      EMAIL_API_KEY: 'test-key',
      EMAIL_FROM: 'alerts@example.com',
    });
  }

  const sent = { push: 0, email: 0 };
  globalThis.fetch = (async (input: unknown) => {
    const url = String((input as Request)?.url ?? input);
    if (url.includes('api.resend.com')) {
      sent.email++;
      return new Response('{}', { status: opts.emailStatus ?? 200 });
    }
    sent.push++;
    return new Response('', { status: 201 });
  }) as any;
  return sent;
}

/** Pretend the last alert went out over an hour ago, without touching the hits. */
const forgetLastNotification = (watchId: string) => env.DB.prepare(
  `UPDATE watches SET last_notified_at = NULL WHERE id = ?`,
).bind(watchId).run();

describe('the secret link is the customer identity', () => {
  it('creates a watch, geocodes it, and resolves it from the raw token', async () => {
    await seed();
    const { watch, token } = await createWatch(env, {
      postcode: '91403', trades: ['Mobile Car Wash And Detailing'], label: 'home',
      max_detour_seconds: 1200,
    });

    expect(watch.lat).toBeCloseTo(NEAR.lat, 3);
    expect(watch.lng).toBeCloseTo(NEAR.lng, 3);
    expect(watch.trades).toEqual(['mobile car wash and detailing']);   // normalised for matching
    expect(watch.label).toBe('home');
    expect(watch.max_detour_seconds).toBe(1200);
    expect(watch.active).toBe(1);

    const found = await watchByToken(env, token);
    expect(found!.id).toBe(watch.id);
    expect(found!.postcode).toBe('91403');
  });

  it('never stores the raw token, only its hash', async () => {
    await seed();
    const { watch, token } = await createWatch(env, { postcode: '91403' });
    const row = await env.DB.prepare(
      `SELECT token_hash FROM watches WHERE id = ?`,
    ).bind(watch.id).first<{ token_hash: string }>();

    expect(row!.token_hash).not.toBe(token);
    expect(row!.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('resolves nothing for a token that was never issued', async () => {
    await seed();
    await createWatch(env, { postcode: '91403' });
    expect(await watchByToken(env, 'not-a-real-token')).toBeNull();
    expect(await watchByToken(env, '')).toBeNull();
  });

  it('refuses an address it cannot place', async () => {
    await seed();
    await expect(createWatch(env, { postcode: 'ZZ999' }))
      .rejects.toThrow(/could not place/i);
  });

  it('edits and switches off by token, and nothing else', async () => {
    await seed();
    const { watch, token } = await createWatch(env, { postcode: '91403', label: 'home' });

    const edited = await updateWatch(env, token, { max_price_cents: 5000, trades: null });
    expect(edited.max_price_cents).toBe(5000);
    expect(edited.trades).toBeNull();
    expect(edited.label).toBe('home');          // untouched fields stay put

    await deactivateWatch(env, token);
    expect((await watchByToken(env, token))!.active).toBe(0);

    await expect(updateWatch(env, 'not-a-real-token', { label: 'x' }))
      .rejects.toThrow(/not valid/i);
    await expect(deactivateWatch(env, 'not-a-real-token')).rejects.toThrow(/not valid/i);
    expect(watch.id).toBeTruthy();
  });
});

describe('an opening near the address they gave', () => {
  it('announces it once, and never again', async () => {
    await seed();
    await addGap();
    const { watch, token } = await createWatch(env, { postcode: '91403' });
    await addSubscription(env, token, SUB);

    expect(await matchWatches(env)).toBe(1);
    expect(await hitCount(watch.id)).toBe(1);

    // An hour later, with the same opening still standing. The rate limit is
    // out of the way, so the only thing stopping a second alert is the unique
    // index on (watch_id, gap_id) -- which is the point.
    await forgetLastNotification(watch.id);
    expect(await matchWatches(env)).toBe(0);
    expect(await hitCount(watch.id)).toBe(1);
  });

  it('says nothing to a watch with no browser attached', async () => {
    await seed();
    await addGap();
    const { watch } = await createWatch(env, { postcode: '91403' });

    // Nothing to deliver to, so nothing is burned: the opening is still
    // unannounced and will be waiting when they do subscribe.
    expect(await matchWatches(env)).toBe(0);
    expect(await hitCount(watch.id)).toBe(0);
  });

  it('says nothing to a watch that has been switched off', async () => {
    await seed();
    await addGap();
    const { token } = await createWatch(env, { postcode: '91403' });
    await addSubscription(env, token, SUB);
    await deactivateWatch(env, token);

    expect(await matchWatches(env)).toBe(0);
  });
});

describe('what does not count as near', () => {
  it('ignores an opening further out of the van way than they accepted', async () => {
    await seed();
    await addGap();
    // Woodland Hills, with five minutes of tolerance. The van is over the hill.
    const { watch, token } = await createWatch(env, {
      postcode: '91367', max_detour_seconds: 300,
    });
    await addSubscription(env, token, SUB);

    expect(await matchWatches(env)).toBe(0);
    expect(await hitCount(watch.id)).toBe(0);
  });

  it('ignores a trade the customer did not ask for', async () => {
    await seed({ trade: 'junk removal' });
    await addGap();
    const { watch, token } = await createWatch(env, {
      postcode: '91403', trades: ['mobile car wash and detailing'],
    });
    await addSubscription(env, token, SUB);

    expect(await matchWatches(env)).toBe(0);
    expect(await hitCount(watch.id)).toBe(0);

    // Widened to any trade, the same opening is a match.
    await updateWatch(env, token, { trades: null });
    expect(await matchWatches(env)).toBe(1);
  });

  it('ignores an opening priced above the ceiling they set', async () => {
    await seed({ priceCents: 19900 });
    await addGap();
    const { token } = await createWatch(env, { postcode: '91403', max_price_cents: 9900 });
    await addSubscription(env, token, SUB);

    expect(await matchWatches(env)).toBe(0);

    await updateWatch(env, token, { max_price_cents: 25000 });
    expect(await matchWatches(env)).toBe(1);
  });
});

describe('the rate limits, which are what keep the permission', () => {
  it('never sends twice inside an hour, however many openings appear', async () => {
    await seed();
    await addGap(4);
    const { watch, token } = await createWatch(env, { postcode: '91403' });
    await addSubscription(env, token, SUB);
    // The hour is spent on a message that arrived, so one has to arrive.
    await stubDelivery({ email: false });

    expect(await matchWatches(env)).toBe(1);

    // A second, different opening, minutes later. It matches, it has never
    // been announced -- and it still waits.
    await addGap(7);
    expect(await matchWatches(env)).toBe(0);
    expect(await hitCount(watch.id)).toBe(1);

    // Once the hour is up it goes out.
    await env.DB.prepare(`UPDATE watches SET last_notified_at = ? WHERE id = ?`)
      .bind(t() - 3700, watch.id).run();
    expect(await matchWatches(env)).toBe(1);
    expect(await hitCount(watch.id)).toBe(2);
  });

  it('stops at five in a day', async () => {
    await seed();
    const { watch, token } = await createWatch(env, { postcode: '91403' });
    await addSubscription(env, token, SUB);

    // Five alerts already sent today, spread over the last few hours.
    for (let i = 0; i < 5; i++) {
      await env.DB.prepare(
        `INSERT INTO watch_hits (id, watch_id, gap_id, created_at) VALUES (?,?,?,?)`,
      ).bind(newId(), watch.id, `old-gap-${i}`, t() - (i + 1) * 3600).run();
    }
    await forgetLastNotification(watch.id);

    // A genuinely new opening, an hour clear of the last alert, and it still
    // waits until tomorrow.
    await addGap();
    expect(await matchWatches(env)).toBe(0);
    expect(await hitCount(watch.id)).toBe(5);

    // Age those five out of the window and the sixth is allowed through.
    await env.DB.prepare(`UPDATE watch_hits SET created_at = ? WHERE watch_id = ?`)
      .bind(t() - 90000, watch.id).run();
    expect(await matchWatches(env)).toBe(1);
    expect(await hitCount(watch.id)).toBe(6);
  });
});

describe('delivery', () => {
  it('disables a subscription the push service says is gone, instead of retrying it', async () => {
    await seed();
    await addGap();
    const { token } = await createWatch(env, { postcode: '91403' });
    const sub = await addSubscription(env, token, SUB);

    // Real VAPID keys, so sendPush gets as far as the network, and a push
    // service that answers 410: this browser is gone for good.
    Object.assign(env as unknown as Record<string, unknown>, await vapidKeyPair());
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response('', { status: 410 }); }) as any;

    expect(await matchWatches(env)).toBe(1);
    expect(calls).toBe(1);

    const row = await env.DB.prepare(
      `SELECT disabled_at, failed_count FROM push_subscriptions WHERE id = ?`,
    ).bind(sub.id).first<{ disabled_at: number | null; failed_count: number }>();
    expect(row!.disabled_at).not.toBeNull();
    expect(row!.failed_count).toBe(1);

    // And it is never called again: a dead endpoint is a request per tick,
    // forever, that cannot succeed.
    await addGap(9);
    await forgetLastNotification((await watchByToken(env, token))!.id);
    calls = 0;
    expect(await matchWatches(env)).toBe(0);
    expect(calls).toBe(0);
  });

  it('lets the customer detach one browser by token', async () => {
    await seed();
    const { token } = await createWatch(env, { postcode: '91403' });
    await addSubscription(env, token, SUB);
    await removeSubscription(env, token, SUB.endpoint);

    const left = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM push_subscriptions`,
    ).first<{ n: number }>();
    expect(left!.n).toBe(0);
  });

  it('does not stack a duplicate row when the same browser re-subscribes', async () => {
    await seed();
    const { token } = await createWatch(env, { postcode: '91403' });
    await addSubscription(env, token, SUB);
    await addSubscription(env, token, SUB);

    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM push_subscriptions`,
    ).first<{ n: number }>();
    expect(rows!.n).toBe(1);
  });
});

describe('push with nothing configured', () => {
  it('returns a plain false, touches no network, and never throws', async () => {
    await seed();
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response('', { status: 201 }); }) as any;

    const result = await sendPush(
      env, { endpoint: SUB.endpoint, p256dh: SUB.keys.p256dh, auth: SUB.keys.auth }, 'hello');

    expect(result).toEqual({ ok: false, gone: false });
    expect(called).toBe(false);
    expect(vapidPublicKey(env)).toBeNull();
  });

  it('leaves the rest of the alert working -- the hit is still recorded', async () => {
    await seed();
    await addGap();
    const { watch, token } = await createWatch(env, { postcode: '91403' });
    await addSubscription(env, token, SUB);

    // No VAPID keys anywhere in env. The match still happens and is still
    // recorded, so switching push on later does not fire a backlog of alerts
    // for openings that were taken hours ago.
    expect(await matchWatches(env)).toBe(1);
    expect(await hitCount(watch.id)).toBe(1);
  });
});

describe('the second channel, for the browsers push cannot reach', () => {
  it('stores an address and hands it back', async () => {
    await seed();
    const { watch, token } = await createWatch(env, {
      postcode: '91403', email: '  Sam@Example.COM ',
    });

    // Trimmed and lower-cased on the way in, so the same mailbox typed two
    // ways is one address.
    expect(watch.email).toBe('sam@example.com');
    expect(watch.email_failed_count).toBe(0);
    expect(watch.email_verified_at).toBeNull();
    expect((await watchByToken(env, token))!.email).toBe('sam@example.com');

    // And it can be changed, or cleared, from the same box it was typed into.
    expect((await updateWatch(env, token, { email: 'other@example.com' })).email)
      .toBe('other@example.com');
    expect((await updateWatch(env, token, { email: '' })).email).toBeNull();
    expect((await watchByToken(env, token))!.email).toBeNull();
  });

  it('refuses an address that is not one, on create and on edit', async () => {
    await seed();
    await expect(createWatch(env, { postcode: '91403', email: 'sam at example' }))
      .rejects.toThrow(/email address/i);

    // Nothing was written, so a rejected address cannot leave a half-made
    // watch behind.
    const left = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM watches`).first<{ n: number }>();
    expect(left!.n).toBe(0);

    const { token } = await createWatch(env, { postcode: '91403' });
    await expect(updateWatch(env, token, { email: 'nope@' })).rejects.toThrow(/email address/i);
    expect((await watchByToken(env, token))!.email).toBeNull();
  });

  it('is a channel of its own: an address alone is enough to be told', async () => {
    await seed();
    await addGap();
    const { watch } = await createWatch(env, {
      postcode: '91403', email: 'sam@example.com',
    });
    const sent = await stubDelivery();

    // No browser attached at all. Before this the watch was skipped and the
    // opening was lost.
    expect(await matchWatches(env)).toBe(1);
    expect(sent.email).toBe(1);
    expect(sent.push).toBe(0);
    expect(await hitCount(watch.id)).toBe(1);
    expect((await stateOf(watch.id))!.notify_count).toBe(1);
  });

  it('sends one email and one push for one opening, and counts them once', async () => {
    await seed();
    await addGap(4);
    const { watch, token } = await createWatch(env, {
      postcode: '91403', email: 'sam@example.com',
    });
    await addSubscription(env, token, SUB);
    const sent = await stubDelivery();

    expect(await matchWatches(env)).toBe(1);
    expect(sent.push).toBe(1);
    expect(sent.email).toBe(1);

    // Two messages, one alert. The hit, the stamp and the day's tally all move
    // exactly once -- a customer who gets both must not have spent two of
    // their five.
    const after = (await stateOf(watch.id))!;
    expect(after.notify_count).toBe(1);
    expect(after.last_notified_at).not.toBeNull();
    expect(await hitCount(watch.id)).toBe(1);

    // And the hour applies to the whole alert, not to either channel.
    await addGap(7);
    expect(await matchWatches(env)).toBe(0);
    expect(sent.push).toBe(1);
    expect(sent.email).toBe(1);
  });
});

describe('with email switched off, which is how it ships', () => {
  it('does not record an alert it never sent', async () => {
    await seed();
    await addGap();
    const { watch } = await createWatch(env, {
      postcode: '91403', email: 'sam@example.com',
    });

    // EMAIL_PROVIDER is unset, so sendEmail refuses before it reaches a
    // network. No VAPID either: this watch has two channels on paper and
    // neither of them can deliver anything.
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response('', { status: 200 }); }) as any;

    expect(await matchWatches(env)).toBe(1);
    expect(called).toBe(false);

    // The opening is spent -- the hit stops it being announced again when the
    // provider is switched on hours later. What must NOT move is the record of
    // having told them: the hour is theirs until something arrives, and
    // notify_count is the number that answers "is this feature delivering".
    expect(await hitCount(watch.id)).toBe(1);
    const after = (await stateOf(watch.id))!;
    expect(after.last_notified_at).toBeNull();
    expect(after.notify_count).toBe(0);
    expect(after.email_failed_count).toBe(0);   // not the mailbox's fault
  });

  it('says nothing, and throws nothing, for a watch with no channel at all', async () => {
    await seed();
    await addGap();
    const { watch, token } = await createWatch(env, { postcode: '91403' });

    // No browser, no address. Skipped rather than treated as an error, and the
    // opening is left unannounced so it is still there when a channel appears.
    expect(await matchWatches(env)).toBe(0);
    expect(await hitCount(watch.id)).toBe(0);

    await updateWatch(env, token, { email: 'sam@example.com' });
    await stubDelivery();
    expect(await matchWatches(env)).toBe(1);
    expect(await hitCount(watch.id)).toBe(1);
  });
});

describe('an address that keeps bouncing', () => {
  it('stops being tried after five refusals in a row', async () => {
    await seed();
    for (const h of [4, 5, 6, 7, 8, 9]) await addGap(h);
    const { watch } = await createWatch(env, {
      postcode: '91403', email: 'gone@example.com',
    });

    // The provider is configured and answers 500 every time: this is a real
    // refusal, not "email is switched off", so it counts against the address.
    const sent = await stubDelivery({ emailStatus: 500 });

    for (let i = 1; i <= 5; i++) {
      expect(await matchWatches(env)).toBe(1);
      const after = (await stateOf(watch.id))!;
      expect(after.email_failed_count).toBe(i);
      // Nothing was delivered, so nothing is recorded as delivered.
      expect(after.notify_count).toBe(0);
      expect(after.last_notified_at).toBeNull();
    }
    expect(sent.email).toBe(5);

    // Clear the day's tally so the daily cap is not what stops the sixth try.
    await env.DB.prepare(`UPDATE watch_hits SET created_at = ? WHERE watch_id = ?`)
      .bind(t() - 90000, watch.id).run();

    // Sixth tick: the address is done, and it is the watch's only channel, so
    // the watch is skipped entirely. No request, and the opening is not burned.
    expect(await matchWatches(env)).toBe(0);
    expect(sent.email).toBe(5);
    expect(await hitCount(watch.id)).toBe(5);
  });

  it('forgets the failures when the customer types a different address', async () => {
    await seed();
    const { watch, token } = await createWatch(env, {
      postcode: '91403', email: 'gone@example.com',
    });
    await env.DB.prepare(`UPDATE watches SET email_failed_count = 5 WHERE id = ?`)
      .bind(watch.id).run();

    const fixed = await updateWatch(env, token, { email: 'sam@example.com' });
    expect(fixed.email_failed_count).toBe(0);
    expect((await stateOf(watch.id))!.email_failed_count).toBe(0);
  });
});

/**
 * A throwaway VAPID pair, generated the same way the operator will generate
 * theirs: a P-256 key, public half as a raw point, private half as the scalar.
 */
async function vapidKeyPair() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey) as JsonWebKey;
  return {
    VAPID_PUBLIC_KEY: b64u(await crypto.subtle.exportKey('raw', pair.publicKey) as ArrayBuffer),
    VAPID_PRIVATE_KEY: jwk.d!,
    VAPID_SUBJECT: 'mailto:ops@example.com',
  };
}
