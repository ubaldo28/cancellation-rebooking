import { afterEach, describe, expect, it } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import type { Env } from '../src/types';
import {
  confirmWatchEmail, createWatch, matchWatches, unsubscribeByToken, updateWatch,
  watchByToken,
} from '../src/lib/alerts';
import { newId, now } from '../src/lib/util';

/**
 * WHO AN ALERT EMAIL IS ALLOWED TO REACH.
 *
 * A watch asks for no account and no proof of anything, and it is not one
 * email — it is a standing instruction to keep sending them, five a day, for as
 * long as the watch lives. Pointed at a mailbox the person filling in the form
 * does not own, that is a mail bomb with our sending domain on it, and the rate
 * limits in front of the route do not touch it: they slow down the making of
 * watches, not the sending one watch goes on doing by itself.
 *
 * So: one confirmation, and silence until somebody opens it. These tests are
 * the gate itself (nothing is delivered to an unconfirmed address, and the
 * opening is not spent pretending otherwise), the bounded abuse that is left
 * (exactly one message to a stranger, ever), and the two keys those emails
 * carry — neither of which may be stored or returned in readable form, because
 * a read-only leak of the watches table was a working unsubscribe link for
 * every subscriber the site has.
 */

let env: Env;
const OP = 'op1';
const t = () => now();

const PREV = { lat: 34.1500, lng: -118.4490 };
const NEXT = { lat: 34.1520, lng: -118.4400 };
const NEAR = { lat: 34.1510, lng: -118.4450 };

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

async function seed() {
  env = makeEnv(ALL_MIGRATIONS) as unknown as Env;
  const n = t();

  await env.DB.prepare(
    // stripe_payouts_enabled = 1 is load-bearing, not boilerplate: a business
    // must have somewhere to be paid before its work can be sold, so slotsNear
    // leaves an opening for an operator without it off the public list — and
    // matchWatches reads that same list. Drop it and no watch ever matches.
    `INSERT INTO operators (id,email,business_name,trade,timezone,country,currency,language,
       location_mode,fill_model,sms_mode,max_detour_seconds,min_gap_seconds,buffer_seconds,
       offer_ttl_seconds,offers_per_wave,min_notice_seconds,reoffer_cooldown_seconds,
       discount_percent,plan,accept_public_bookings,deposit_cents,created_at,updated_at,
       stripe_payouts_enabled)
     VALUES (?,?,?,?, 'America/Los_Angeles','US','USD','en','mobile','both','device',
       900,3600,900,5400,3,3600,604800,0,'active',1,1000,?,?,1)`,
  ).bind(OP, 'a@x.com', 'Valley Detailing', 'mobile car wash and detailing', n, n).run();

  await env.DB.prepare(
    `INSERT INTO services (id,operator_id,name,duration_seconds,price_cents,cadence_days,
       created_at,updated_at)
     VALUES ('sv',?,'Full detail',7200,9900,28,?,?)`,
  ).bind(OP, n, n).run();

  await env.DB.prepare(
    `INSERT INTO service_areas (id,operator_id,name,slug,place_slug,lat,lng,radius_meters,
       created_at,updated_at)
     VALUES (?,?,'Sherman Oaks','sherman-oaks','sherman-oaks',?,?,8000,?,?)`,
  ).bind(newId(), OP, PREV.lat, PREV.lng, n, n).run();

  await env.DB.prepare(
    `INSERT INTO postal_codes (country_code,postal_code,place_name,lat,lng,accuracy)
     VALUES ('US','91403','Sherman Oaks',?,?,6)`,
  ).bind(NEAR.lat, NEAR.lng).run();
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

/**
 * A working email provider, and every message it was handed.
 *
 * The bodies are kept rather than counted because the two links are the point:
 * the confirmation key and the unsubscribe key only ever exist inside a
 * message, so reading them back out of one is the only way to click them — and
 * is also how these tests check that neither is sitting in the database.
 */
function stubEmail(): string[] {
  Object.assign(env as unknown as Record<string, unknown>, {
    EMAIL_PROVIDER: 'resend',
    EMAIL_API_KEY: 'test-key',
    EMAIL_FROM: 'alerts@example.com',
  });
  const bodies: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String((input as Request)?.url ?? input);
    if (url.includes('api.resend.com')) {
      bodies.push(String(init?.body ?? ''));
      return new Response('{}', { status: 200 });
    }
    return new Response('', { status: 201 });
  }) as never;
  return bodies;
}

const linkIn = (body: string, kind: 'confirm' | 'stop') =>
  new RegExp(`/a/${kind}/([A-Za-z0-9_-]+)`).exec(body)?.[1] ?? null;

const rowOf = (watchId: string) => env.DB.prepare(
  `SELECT email, email_verified_at, unsub_token, email_confirm_hash
     FROM watches WHERE id = ?`,
).bind(watchId).first<{
  email: string | null; email_verified_at: number | null;
  unsub_token: string | null; email_confirm_hash: string | null;
}>();

describe('an address nobody has confirmed', () => {
  it('is asked once, and only once, however long the watch lives', async () => {
    await seed();
    const sent = stubEmail();
    const { watch } = await createWatch(env, {
      postcode: '91403', email: 'stranger@example.com',
    });

    // The one message a mailbox that never asked for any of this receives.
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain('stranger@example.com');
    expect(linkIn(sent[0]!, 'confirm')).toBeTruthy();

    // Openings keep appearing and every tick decides the same thing. This is
    // the whole defect in one assertion: before the gate, five of these a day
    // went to an address whose owner was never asked.
    for (const h of [4, 6, 8]) await addGap(h);
    expect(await matchWatches(env)).toBe(0);
    expect(sent.length).toBe(1);

    const after = (await rowOf(watch.id))!;
    expect(after.email_verified_at).toBeNull();
  });

  it('leaves the opening unspent, so confirming later is not too late', async () => {
    await seed();
    stubEmail();
    const gap = await addGap();
    const { watch } = await createWatch(env, {
      postcode: '91403', email: 'sam@example.com',
    });

    // Nowhere to deliver is not the same as a delivery that failed: recording
    // a hit here would burn this opening for good.
    expect(await matchWatches(env)).toBe(0);
    const hits = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM watch_hits WHERE watch_id = ?`,
    ).bind(watch.id).first<{ n: number }>();
    expect(hits!.n).toBe(0);
    expect(gap).toBeTruthy();
  });
});

describe('the link in that one email', () => {
  it('turns the address into a channel, and the alerts start', async () => {
    await seed();
    const sent = stubEmail();
    await addGap();
    const { watch } = await createWatch(env, {
      postcode: '91403', email: 'sam@example.com',
    });

    const token = linkIn(sent[0]!, 'confirm')!;
    expect(await confirmWatchEmail(env, token)).toBe(true);
    expect((await rowOf(watch.id))!.email_verified_at).not.toBeNull();

    // And now the same watch, the same opening, is told about it.
    expect(await matchWatches(env)).toBe(1);
    expect(sent.length).toBe(2);
    expect(sent[1]).toContain('Valley Detailing');
  });

  it('answers the same way twice, and to a token that was never issued', async () => {
    await seed();
    const sent = stubEmail();
    const { watch } = await createWatch(env, {
      postcode: '91403', email: 'sam@example.com',
    });
    const token = linkIn(sent[0]!, 'confirm')!;

    expect(await confirmWatchEmail(env, token)).toBe(true);
    // A second click — a mail client prefetching the link, a person opening it
    // twice — is not a failure to show anybody. It changed nothing, which is
    // what false means here, and the address stays confirmed.
    expect(await confirmWatchEmail(env, token)).toBe(false);
    expect((await rowOf(watch.id))!.email_verified_at).not.toBeNull();

    expect(await confirmWatchEmail(env, 'not-a-real-token')).toBe(false);
    expect(await confirmWatchEmail(env, '')).toBe(false);
  });

  it('stops working when the watch is pointed at a different mailbox', async () => {
    await seed();
    const sent = stubEmail();
    const { watch, token } = await createWatch(env, {
      postcode: '91403', email: 'sam@example.com',
    });
    const first = linkIn(sent[0]!, 'confirm')!;
    expect(await confirmWatchEmail(env, first)).toBe(true);

    // THE HOLE THIS CLOSES: confirm your own mailbox, then re-point the watch
    // at a stranger's and let the old stamp bless it.
    const moved = await updateWatch(env, token, { email: 'victim@example.com' });
    expect(moved.email).toBe('victim@example.com');
    expect(moved.email_verified_at).toBeNull();
    expect((await rowOf(watch.id))!.email_verified_at).toBeNull();

    // The link mailed to the first address cannot confirm the second one.
    expect(await confirmWatchEmail(env, first)).toBe(false);
    expect((await rowOf(watch.id))!.email_verified_at).toBeNull();

    // The new mailbox got its own ask, and its own link works.
    expect(sent.length).toBe(2);
    expect(sent[1]).toContain('victim@example.com');
    const second = linkIn(sent[1]!, 'confirm')!;
    expect(second).not.toBe(first);
    expect(await confirmWatchEmail(env, second)).toBe(true);
  });
});

describe('the two keys an alert email carries', () => {
  it('are stored as hashes and never handed back in the payload', async () => {
    await seed();
    const sent = stubEmail();
    await addGap();
    const { watch, token } = await createWatch(env, {
      postcode: '91403', email: 'sam@example.com',
    });
    const confirm = linkIn(sent[0]!, 'confirm')!;
    await confirmWatchEmail(env, confirm);
    expect(await matchWatches(env)).toBe(1);
    const stop = linkIn(sent[1]!, 'stop')!;

    const row = (await rowOf(watch.id))!;
    // A leaked copy of this table is a column of hashes. Neither link can be
    // rebuilt from it: both are peppered SHA-256, exactly like token_hash.
    expect(row.unsub_token).toMatch(/^[0-9a-f]{64}$/);
    expect(row.email_confirm_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.unsub_token).not.toBe(stop);
    expect(row.email_confirm_hash).not.toBe(confirm);

    // And neither leaves through the front door either. This is the payload
    // GET /api/public/watches/:token answers with, and unsub_token used to be
    // in it.
    const payload = (await watchByToken(env, token))!;
    expect(Object.keys(payload)).not.toContain('unsub_token');
    expect(Object.keys(payload)).not.toContain('email_confirm_hash');
    expect(JSON.stringify(payload)).not.toContain(stop);
    expect(JSON.stringify(payload)).not.toContain(confirm);
  });

  it('still stops the emails when the one in the message is clicked', async () => {
    await seed();
    const sent = stubEmail();
    await addGap();
    const { watch } = await createWatch(env, {
      postcode: '91403', email: 'sam@example.com',
    });
    await confirmWatchEmail(env, linkIn(sent[0]!, 'confirm')!);
    expect(await matchWatches(env)).toBe(1);

    // The point of deriving the key rather than storing one: the matcher sends
    // this email weeks after the watch was made and still puts a working
    // unsubscribe link in it. An email nobody can stop is not a product
    // decision, it is a legal problem.
    const stop = linkIn(sent[1]!, 'stop')!;
    expect(await unsubscribeByToken(env, stop)).toBe(true);
    const off = await env.DB.prepare(`SELECT active FROM watches WHERE id = ?`)
      .bind(watch.id).first<{ active: number }>();
    expect(off!.active).toBe(0);

    // Hashed both ways, so a guess is a guess: presenting the stored value
    // does not unsubscribe anybody.
    const row = (await rowOf(watch.id))!;
    expect(await unsubscribeByToken(env, row.unsub_token!)).toBe(false);
    expect(await unsubscribeByToken(env, '')).toBe(false);
  });
});
