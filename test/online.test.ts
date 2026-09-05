import { describe, expect, it } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import type { Env } from '../src/types';
import {
  ONLINE_SECONDS, REQUEST_TTL_SECONDS, acceptRequest, createInstantRequest,
  declineRequest, expireRequests, goOffline, goOnline, onlineStatus,
  operatorsOnlineNear, pendingForOperator, requestByToken,
} from '../src/lib/online';
import { saveOperatorCard } from '../src/lib/standing';
import { saveVehicle } from '../src/lib/startcode';
import { now } from '../src/lib/util';

/**
 * The switch, and the four rules the product owner set for it:
 *
 *   it turns itself off after 3 hours and must be flipped on again
 *   accepting a job turns it off
 *   a job must be ACCEPTED, never auto-assigned
 *   unanswered for 5 minutes it is cancelled and the customer moves on
 *
 * Almost everything below is about the two clocks. Both are evaluated on READ
 * rather than trusted to a sweep, because the failure mode of the alternative
 * is a customer booking somebody who went to bed three hours ago.
 */

let env: Env;
const OP = 'op-on';
const NEAR = { lat: 34.1512, lng: -118.4492 };

const one = async <T>(sql: string, ...args: unknown[]) =>
  env.DB.prepare(sql).bind(...args).first<T>();

async function seed(opts: { lat?: number; lng?: number } = {}) {
  env = makeEnv(ALL_MIGRATIONS) as unknown as Env;
  const n = now();
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,trade,timezone,country,currency,language,
       location_mode,fill_model,sms_mode,max_detour_seconds,min_gap_seconds,buffer_seconds,
       offer_ttl_seconds,offers_per_wave,min_notice_seconds,reoffer_cooldown_seconds,
       discount_percent,plan,accept_public_bookings,deposit_cents,share_location,
       home_lat,home_lng,is_published,profile_slug,created_at,updated_at)
     VALUES (?,?,?, 'mobile car wash and detailing','America/Los_Angeles','US','USD','en',
       'mobile','both','device',3600,3600,900,5400,3,3600,604800,0,'active',1,0,1,?,?,1,'x',?,?)`,
  ).bind(OP, 'on@x.com', 'Valley Detailing',
    opts.lat ?? NEAR.lat, opts.lng ?? NEAR.lng, n, n).run();

  await saveOperatorCard(env, OP, { ref: 'pm', brand: 'visa', last4: '4242' });
  await saveVehicle(env, OP, { make: 'Ford', model: 'Transit', color: 'White', plate: '8ABC' });

  await env.DB.prepare(
    `INSERT INTO services (id,operator_id,name,duration_seconds,price_cents,created_at,updated_at)
     VALUES ('s1',?, 'Full detail',3600,20000,?,?)`,
  ).bind(OP, n, n).run();
  return n;
}

const ask = () => createInstantRequest(env, {
  operator_id: OP, service_id: 's1',
  guest_name: 'Rosa', phone: '(818) 555-0142',
  address_line: '15200 Ventura Blvd', postcode: '91403',
} as never);

describe('the switch', () => {
  it('goes on for three hours and never renews itself', async () => {
    await seed();
    const on = await goOnline(env, OP);
    expect(on.online).toBe(true);
    expect(on.seconds_left).toBeGreaterThan(ONLINE_SECONDS - 10);
    expect(on.seconds_left).toBeLessThanOrEqual(ONLINE_SECONDS);
  });

  it('reads as off the moment its own clock runs out, with no sweep', async () => {
    await seed();
    await goOnline(env, OP);
    // Nothing runs. The status is derived from the timestamp, so it cannot get
    // stuck on — which is the whole reason it is not a boolean.
    await env.DB.prepare(`UPDATE operators SET online_until = ? WHERE id = ?`)
      .bind(now() - 1, OP).run();
    expect((await onlineStatus(env, OP)).online).toBe(false);
  });

  it('goes off when they say so', async () => {
    await seed();
    await goOnline(env, OP);
    expect((await goOffline(env, OP)).online).toBe(false);
  });

  it('will not take a job for somebody who is switched off', async () => {
    await seed();
    await expect(ask()).rejects.toThrow();
  });
});

describe('a job offered to somebody who is on', () => {
  it('waits for them and is not assigned', async () => {
    await seed();
    await goOnline(env, OP);
    const { request } = await ask();

    expect(request.status).toBe('pending');
    expect(await pendingForOperator(env, OP)).toHaveLength(1);
    // Nothing has been booked. Until they tap accept, there is no appointment.
    expect(await one<{ n: number }>(`SELECT COUNT(*) AS n FROM appointments`))
      .toMatchObject({ n: 0 });
  });

  it('gives them five minutes', async () => {
    await seed();
    await goOnline(env, OP);
    const { request } = await ask();
    expect(request.expires_at - request.created_at).toBe(REQUEST_TTL_SECONDS);
  });

  it('turns the switch off when they accept', async () => {
    await seed();
    await goOnline(env, OP);
    const { request } = await ask();

    await acceptRequest(env, OP, request.id);
    // They are busy now. Leaving them online would send a second job to
    // somebody already driving to the first.
    expect((await onlineStatus(env, OP)).online).toBe(false);
  });

  it('leaves the switch on when they decline', async () => {
    await seed();
    await goOnline(env, OP);
    const { request } = await ask();

    await declineRequest(env, OP, request.id);
    // Saying no to one job is not saying no to the evening.
    expect((await onlineStatus(env, OP)).online).toBe(true);
  });

  it('cannot be accepted twice', async () => {
    await seed();
    await goOnline(env, OP);
    const { request } = await ask();
    await acceptRequest(env, OP, request.id);
    await expect(acceptRequest(env, OP, request.id)).rejects.toThrow();
  });

  it('cannot be accepted late, even a second late', async () => {
    await seed();
    await goOnline(env, OP);
    const { request } = await ask();
    await env.DB.prepare(`UPDATE instant_requests SET expires_at = ? WHERE id = ?`)
      .bind(now() - 1, request.id).run();

    // The guard is in the WHERE clause, so a tap that arrives after the fuse
    // fails cleanly rather than booking somebody who has moved on.
    await expect(acceptRequest(env, OP, request.id)).rejects.toThrow();
  });

  it('is not another business\'s to accept', async () => {
    await seed();
    await goOnline(env, OP);
    const { request } = await ask();
    await expect(acceptRequest(env, 'someone-else', request.id)).rejects.toThrow();
  });

  it('reads as expired to the customer without the sweep having run', async () => {
    await seed();
    await goOnline(env, OP);
    const { request, token } = await ask();
    await env.DB.prepare(`UPDATE instant_requests SET expires_at = ? WHERE id = ?`)
      .bind(now() - 1, request.id).run();

    // The customer is polling from a phone. They must be told to move on the
    // moment the fuse burns, not whenever the cron next fires.
    const seen = await requestByToken(env, token);
    expect(seen!.status).toBe('expired');
  });

  it('is swept up so the operator screen does not carry corpses', async () => {
    await seed();
    await goOnline(env, OP);
    const { request } = await ask();
    await env.DB.prepare(`UPDATE instant_requests SET expires_at = ? WHERE id = ?`)
      .bind(now() - 1, request.id).run();

    expect(await expireRequests(env)).toBe(1);
    expect(await pendingForOperator(env, OP)).toHaveLength(0);
  });

  it('never shows an operator a button that cannot work', async () => {
    await seed();
    await goOnline(env, OP);
    const { request } = await ask();
    await env.DB.prepare(`UPDATE instant_requests SET expires_at = ? WHERE id = ?`)
      .bind(now() - 1, request.id).run();
    // Even before the sweep runs.
    expect(await pendingForOperator(env, OP)).toHaveLength(0);
  });
});

describe('who is on near me', () => {
  it('finds somebody switched on close by', async () => {
    await seed();
    await goOnline(env, OP);
    const found = await operatorsOnlineNear(env, { lat: NEAR.lat, lng: NEAR.lng });
    expect(found.map((o) => o.id)).toContain(OP);
  });

  it('does not find somebody who is switched off', async () => {
    await seed();
    const found = await operatorsOnlineNear(env, { lat: NEAR.lat, lng: NEAR.lng });
    expect(found).toHaveLength(0);
  });

  it('does not find somebody whose three hours ran out', async () => {
    await seed();
    await goOnline(env, OP);
    await env.DB.prepare(`UPDATE operators SET online_until = ? WHERE id = ?`)
      .bind(now() - 1, OP).run();
    expect(await operatorsOnlineNear(env, { lat: NEAR.lat, lng: NEAR.lng })).toHaveLength(0);
  });

  it('does not reach across the county', async () => {
    // Far outside any sane radius: somebody in San Diego is not "near" a
    // Sherman Oaks driveway however willing they are.
    await seed();
    await goOnline(env, OP);
    const found = await operatorsOnlineNear(env, { lat: 32.7157, lng: -117.1611 });
    expect(found).toHaveLength(0);
  });
});
