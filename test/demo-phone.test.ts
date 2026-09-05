import { describe, expect, it } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import type { Env } from '../src/types';
import { seedDemoIfEmpty } from '../src/lib/demo';

/**
 * The sample businesses are what a visitor actually sees. A trade that exists
 * in the sign-up list but has nobody working in it is invisible on the site:
 * the public trade list is built from real operators, not from the list of
 * trades the app knows about.
 */
describe('the phone repair sample business', () => {
  it('seeds, and shows up the way a customer would find it', async () => {
    const env = { ...makeEnv(ALL_MIGRATIONS), DEMO_MODE: 'on' } as unknown as Env;
    await seedDemoIfEmpty(env);

    const op = await env.DB.prepare(
      `SELECT id, business_name, trade FROM operators WHERE trade = ?`,
    ).bind('phone and tablet repair').first<{ id: string; business_name: string }>();
    expect(op).not.toBeNull();

    // The public trade list is the thing that was actually missing: it is
    // built from operators with live service areas, so a trade with nobody in
    // it never appears however well it is wired up everywhere else.
    const trades = await env.DB.prepare(
      `SELECT DISTINCT o.trade FROM operators o
         JOIN service_areas a ON a.operator_id = o.id AND a.is_active = 1
        WHERE o.accept_public_bookings = 1 AND o.plan IN ('trial','active')`,
    ).all<{ trade: string }>();
    expect((trades.results ?? []).map((r) => r.trade)).toContain('phone and tablet repair');
  });

  it('carries the parts answer that makes the trade make sense', async () => {
    const env = { ...makeEnv(ALL_MIGRATIONS), DEMO_MODE: 'on' } as unknown as Env;
    await seedDemoIfEmpty(env);

    const rows = await env.DB.prepare(
      `SELECT s.name, s.parts_policy FROM services s
         JOIN operators o ON o.id = s.operator_id
        WHERE o.trade = ?`,
    ).bind('phone and tablet repair').all<{ name: string; parts_policy: string }>();

    const by = Object.fromEntries((rows.results ?? []).map((r) => [r.name, r.parts_policy]));

    // A screen is mostly the part and everybody knows what one costs, so it is
    // priced in. Water damage cannot be priced until the phone is open, which
    // is the entire reason the quote flow exists.
    expect(by['Phone screen replacement']).toBe('included');
    expect(by['Water damage diagnosis']).toBe('quoted');
  });

  it('gives it openings, so it is bookable and not just listed', async () => {
    const env = { ...makeEnv(ALL_MIGRATIONS), DEMO_MODE: 'on' } as unknown as Env;
    await seedDemoIfEmpty(env);

    const gaps = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM gaps g JOIN operators o ON o.id = g.operator_id
        WHERE o.trade = ? AND g.status IN ('open','offering')`,
    ).bind('phone and tablet repair').first<{ n: number }>();
    expect(gaps!.n).toBeGreaterThan(0);
  });
});
