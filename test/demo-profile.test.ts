import { describe, expect, it } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import type { Env } from '../src/types';
import { DEMO_SEED_VERSION, seedDemoIfEmpty } from '../src/lib/demo';
import { ratingFor } from '../src/lib/reviews';
import { now } from '../src/lib/util';

/**
 * What the sample businesses claim about themselves.
 *
 * The star rating, the review count and the "Open now" marker are read off the
 * operator's own row on every card, pin and search result. Seeding them wrong
 * is not a cosmetic problem: rating_sum and rating_count are a cache of the
 * reviews table, and a business whose stars disagree with its own reviews is
 * an inconsistency a customer finds before we do.
 */
const seeded = async () => {
  const env = { ...makeEnv(ALL_MIGRATIONS), DEMO_MODE: 'on' } as unknown as Env;
  await seedDemoIfEmpty(env);
  return env;
};

describe('the sample businesses ratings', () => {
  it('counts and sums exactly what its own review rows say', async () => {
    const env = await seeded();

    // Every seeded operator, against the reviews actually written for it. The
    // LEFT JOIN is the point: a business with no reviews has to come out of
    // this at 0 and 0 as well, not be quietly skipped.
    const rows = await env.DB.prepare(
      `SELECT o.id, o.rating_sum, o.rating_count,
              COUNT(r.id) AS n, COALESCE(SUM(r.rating), 0) AS total
         FROM operators o LEFT JOIN reviews r ON r.operator_id = o.id
        GROUP BY o.id`,
    ).all<{ id: string; rating_sum: number; rating_count: number; n: number; total: number }>();

    expect(rows.results!.length).toBeGreaterThan(10);
    for (const r of rows.results!) {
      expect({ id: r.id, sum: r.rating_sum, count: r.rating_count })
        .toEqual({ id: r.id, sum: r.total, count: r.n });
    }
  });

  it('leaves at least two businesses with no rating at all', async () => {
    const env = await seeded();

    const bare = await env.DB.prepare(
      `SELECT id FROM operators WHERE rating_count = 0`,
    ).all<{ id: string }>();
    expect(bare.results!.length).toBeGreaterThanOrEqual(2);

    // No reviews means no score, and no placeholder standing in for one: a
    // business nobody has rated does not have a bad rating, it has none, and
    // the card has to be able to render that.
    for (const b of bare.results!) {
      const summary = await ratingFor(env, b.id);
      expect(summary.average).toBeNull();
      expect(summary.count).toBe(0);
      expect(summary.label).toBeNull();

      const row = await env.DB.prepare(
        `SELECT rating_sum FROM operators WHERE id = ?`,
      ).bind(b.id).first<{ rating_sum: number }>();
      expect(row!.rating_sum).toBe(0);
    }
  });

  it('spreads the scores rather than giving everyone five stars', async () => {
    const env = await seeded();

    // A seed where every business averages the same thing tells a visitor
    // nothing, and the low ratings are the ones that make the high ones worth
    // reading.
    const ratings = await env.DB.prepare(
      `SELECT DISTINCT rating FROM reviews ORDER BY rating`,
    ).all<{ rating: number }>();
    expect(ratings.results!.map((r) => r.rating)).toContain(3);
    expect(ratings.results!.map((r) => r.rating)).toContain(4);

    const scored = await env.DB.prepare(
      `SELECT DISTINCT ROUND(CAST(rating_sum AS REAL) / rating_count, 1) AS avg
         FROM operators WHERE rating_count > 0`,
    ).all<{ avg: number }>();
    expect(scored.results!.length).toBeGreaterThan(2);
  });

  it('writes reviews a card can quote and a reader can attribute', async () => {
    const env = await seeded();

    const rows = await env.DB.prepare(
      `SELECT author_name, body, details FROM reviews WHERE body IS NOT NULL`,
    ).all<{ author_name: string; body: string; details: string | null }>();
    expect(rows.results!.length).toBeGreaterThan(20);

    for (const r of rows.results!) {
      // Stored whole, because displayName is what cuts "Debra Delgado" to
      // "Debra D." at the point it is printed.
      expect(r.author_name.trim().split(/\s+/).length).toBeGreaterThanOrEqual(2);
      expect(r.body.length).toBeGreaterThan(20);
      // The service as it was booked, like the price on a receipt.
      expect(r.details).toBeTruthy();
    }
  });
});

describe('the sample businesses that are open now', () => {
  it('switches a couple on and leaves the rest alone', async () => {
    const env = await seeded();

    const rows = await env.DB.prepare(
      `SELECT id, online_until, online_since FROM operators`,
    ).all<{ id: string; online_until: number | null; online_since: number | null }>();

    const t = now();
    const on = rows.results!.filter((r) => r.online_until !== null);
    expect(on.length).toBeGreaterThanOrEqual(2);
    // Fewer than half, or the marker decorates the map instead of telling two
    // businesses apart from fourteen.
    expect(on.length).toBeLessThan(rows.results!.length / 2);

    for (const r of on) {
      expect(r.online_until).toBeGreaterThan(t);
      // Set together with the window, so the UI can say how long they have
      // been on rather than guessing.
      expect(r.online_since).not.toBeNull();
    }
    for (const r of rows.results!.filter((x) => x.online_until === null)) {
      expect(r.online_until).toBeNull();
    }
  });

  it('moves the window on when it has lapsed rather than going dark', async () => {
    const env = await seeded();

    // A demo database seeded last week: the windows are absolute timestamps,
    // so they have run out, and nothing about the operator list has changed to
    // make the seeder rebuild anything.
    const stale = now() - 7 * 86400;
    await env.DB.prepare(
      `UPDATE operators SET online_until = ?, online_since = ?
        WHERE online_until IS NOT NULL`,
    ).bind(stale, stale).run();

    const rebuilt = await seedDemoIfEmpty(env);
    expect(rebuilt).toBe(false);

    const on = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM operators WHERE online_until > ?`,
    ).bind(now()).first<{ n: number }>();
    expect(on!.n).toBeGreaterThanOrEqual(2);
  });

  it('leaves a window that is still running exactly where it is', async () => {
    const env = await seeded();

    const before = await env.DB.prepare(
      `SELECT id, online_until FROM operators WHERE online_until IS NOT NULL
        ORDER BY id`,
    ).all<{ id: string; online_until: number }>();

    await seedDemoIfEmpty(env);

    const after = await env.DB.prepare(
      `SELECT id, online_until FROM operators WHERE online_until IS NOT NULL
        ORDER BY id`,
    ).all<{ id: string; online_until: number }>();
    expect(after.results).toEqual(before.results);
  });
});

describe('re-seeding the demo', () => {
  it('does not double a business up on its own reviews', async () => {
    const env = await seeded();

    const first = await env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(rating), 0) AS total FROM reviews`,
    ).first<{ n: number; total: number }>();
    expect(first!.n).toBeGreaterThan(0);

    // The live path: the demo is rebuilt whenever a business is added to it,
    // and reviews outlive the bookings they describe, so nothing else is ever
    // going to clear them.
    await env.DB.prepare(`DELETE FROM operators WHERE id = 'demo-operator-phone'`).run();
    expect(await seedDemoIfEmpty(env)).toBe(true);

    const again = await env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(rating), 0) AS total FROM reviews`,
    ).first<{ n: number; total: number }>();
    expect(again).toEqual(first);

    const mismatched = await env.DB.prepare(
      `SELECT o.id FROM operators o
        WHERE o.rating_count <> (SELECT COUNT(*) FROM reviews r WHERE r.operator_id = o.id)
           OR o.rating_sum <> (SELECT COALESCE(SUM(r.rating), 0) FROM reviews r
                                WHERE r.operator_id = o.id)`,
    ).all<{ id: string }>();
    expect(mismatched.results).toEqual([]);
  });
});

/**
 * The bug this file exists to stop coming back.
 *
 * Every sample business already being present is not the same as the sample
 * data being current. A release that changed what those businesses CONTAIN --
 * reviews, ratings, hired counts -- changed no row count, so the freshness
 * check passed and the new data never reached a database that had already been
 * seeded. It looked perfect locally, because a local database starts empty and
 * therefore always seeds fresh, and it was invisible in production.
 */
describe('the sample data reaches a database that was already seeded', () => {
  it('rebuilds when the stored version is behind the code', async () => {
    const env = { ...makeEnv(ALL_MIGRATIONS), DEMO_MODE: 'on' } as unknown as Env;
    await seedDemoIfEmpty(env);

    // Pretend this database was seeded by the release before reviews existed:
    // every business still present, but the stamp left behind.
    await env.DB.prepare(`UPDATE demo_seed SET version = ?`).bind(1).run();
    await env.DB.prepare(`DELETE FROM reviews`).run();
    await env.DB.prepare(`UPDATE operators SET rating_sum = 0, rating_count = 0`).run();

    expect(await seedDemoIfEmpty(env)).toBe(true);

    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM reviews`)
      .first<{ n: number }>();
    expect(n?.n ?? 0).toBeGreaterThan(0);

    const v = await env.DB.prepare(`SELECT version FROM demo_seed WHERE id = 1`)
      .first<{ version: number }>();
    expect(v?.version).toBe(DEMO_SEED_VERSION);
  });

  it('does not rebuild when the stored version is current', async () => {
    const env = { ...makeEnv(ALL_MIGRATIONS), DEMO_MODE: 'on' } as unknown as Env;
    await seedDemoIfEmpty(env);
    expect(await seedDemoIfEmpty(env)).toBe(false);
  });
});
