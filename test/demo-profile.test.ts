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

// ---------------------------------------------------------------------------
// Seeding once, and only once
// ---------------------------------------------------------------------------

describe('seedDemoIfEmpty knows when it has already run', () => {
  /**
   * THIS WENT WRONG THE DAY A METRO WAS HIDDEN, and nothing failed loudly.
   *
   * The freshness check compares the operator rows in the database against a
   * length. It compared against DEMO_OPERATOR_IDS — every business the demo
   * OWNS — while the seeder had started skipping the six based in a metro that
   * is no longer open. Sixteen measured against twenty-two is never equal, so
   * the branch that says "already seeded" became unreachable and every call
   * fell through to a full wipe and rebuild.
   *
   * The caller is GET /api/public/map, described in its own comment as the
   * busiest read in the product. So in demo mode every uncached map request was
   * deleting and re-inserting several hundred rows and re-randomising which
   * vans were online, under whoever was looking at the page.
   *
   * The cost was invisible: the site looked right, because a rebuild produces
   * the same data. What is pinned here is that the SECOND call does nothing,
   * which is the only symptom the bug ever had.
   */
  it('rebuilds on the first call and leaves it alone on the second', async () => {
    const env = { ...makeEnv(ALL_MIGRATIONS), DEMO_MODE: 'on' } as unknown as Env;
    expect(await seedDemoIfEmpty(env)).toBe(true);
    expect(await seedDemoIfEmpty(env)).toBe(false);
    expect(await seedDemoIfEmpty(env)).toBe(false);
  });

  it('counts what the seeder creates, not what the demo owns', async () => {
    // The two numbers differ whenever a metro is hidden, and the check has to
    // use the smaller one. Asserted against the database rather than against a
    // constant, so it stays true whichever metros are open.
    const env = await seeded();
    const n = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM operators WHERE id LIKE 'demo-operator%'`,
    ).first<{ n: number }>();
    expect(n!.n).toBeGreaterThan(0);
    expect(await seedDemoIfEmpty(env)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A real business in the table must not stop the demo maintaining itself
// ---------------------------------------------------------------------------

describe('the demo lives alongside real businesses', () => {
  /**
   * THE GUARD THAT FROZE THE LIVE SITE.
   *
   * seedDemoIfEmpty used to refuse outright if any operator existed whose id
   * was not a demo id. The intent was that a rebuild must never reach somebody's
   * actual business, which is right — but the effect was that the FIRST REAL
   * BUSINESS TO SIGN UP froze the demo permanently. Every later change to the
   * sample data looked correct on every developer's machine, which starts empty
   * and always seeds fresh, and reached the live site never.
   *
   * It was found by accident: a sign-in test put one operator row on the
   * production database, and six sample businesses that had just been taken off
   * the site went on being served for hours, by code that was correct and
   * could not run.
   *
   * The protection is structural instead, and these tests are what say so:
   * every statement in the seeder is scoped to the ids it owns, so a real
   * business's rows are untouched by a rebuild that happens right beside them.
   */
  const realOperator = async (env: Env, id = 'op-a-real-business') => {
    const t = now();
    await env.DB.prepare(
      `INSERT INTO operators (id,email,business_name,timezone,country,currency,
         location_mode,fill_model,sms_mode,plan,created_at,updated_at)
       VALUES (?,?,?, 'America/Los_Angeles','US','USD','mobile','both','device','active',?,?)`,
    ).bind(id, `${id}@example.com`, 'A Real Business', t, t).run();
    return id;
  };

  it('still seeds when somebody has signed up', async () => {
    const env = { ...makeEnv(ALL_MIGRATIONS), DEMO_MODE: 'on' } as unknown as Env;
    await realOperator(env);

    expect(await seedDemoIfEmpty(env)).toBe(true);
    const n = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM operators WHERE id LIKE 'demo-operator%'`,
    ).first<{ n: number }>();
    expect(n!.n).toBeGreaterThan(0);
  });

  it('leaves the real business exactly where it was', async () => {
    // The whole reason the guard existed. It has to be true without it.
    const env = { ...makeEnv(ALL_MIGRATIONS), DEMO_MODE: 'on' } as unknown as Env;
    const id = await realOperator(env);
    await seedDemoIfEmpty(env);

    const before = await env.DB.prepare(
      `SELECT business_name, plan FROM operators WHERE id = ?`,
    ).bind(id).first<{ business_name: string; plan: string }>();
    expect(before).toMatchObject({ business_name: 'A Real Business', plan: 'active' });

    // And again through a rebuild, which is the dangerous one: this call finds
    // the demo present but out of date and wipes it.
    await env.DB.prepare(`UPDATE demo_seed SET version = 1 WHERE id = 1`).run();
    expect(await seedDemoIfEmpty(env)).toBe(true);

    const after = await env.DB.prepare(
      `SELECT business_name, plan FROM operators WHERE id = ?`,
    ).bind(id).first<{ business_name: string; plan: string }>();
    expect(after).toMatchObject({ business_name: 'A Real Business', plan: 'active' });
  });
});

// ---------------------------------------------------------------------------
// A hidden metro's postcodes are removed, not merely left unwritten
// ---------------------------------------------------------------------------

describe('postcodes of a metro that is not open', () => {
  it('are deleted from a database that was seeded while it was open', async () => {
    // WIPE CANNOT DO THIS AND THAT IS THE POINT. Every delete in wipe is keyed
    // on operator_id, and a postcode belongs to no operator — so a code seeded
    // while Santa Maria was live survived every rebuild, INSERT OR IGNORE never
    // overwrote it, and somebody in Santa Maria typing 93454 was placed in a
    // neighbourhood with nothing in it on a site that says it is testing in
    // Los Angeles.
    const env = { ...makeEnv(ALL_MIGRATIONS), DEMO_MODE: 'on' } as unknown as Env;
    await env.DB.prepare(
      `INSERT INTO postal_codes (country_code,postal_code,place_name,lat,lng,accuracy)
       VALUES ('US','93454','Downtown Santa Maria',34.95,-120.43,6)`,
    ).run();

    await seedDemoIfEmpty(env);

    const left = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM postal_codes WHERE postal_code = '93454'`,
    ).first<{ n: number }>();
    expect(left!.n).toBe(0);
  });

  it('does not take a live metro\'s codes with them', async () => {
    // A code can cover neighbourhoods in more than one place. Deleting a live
    // one because a hidden area happens to share it would break postcode search
    // for somebody we do serve.
    const env = await seeded();
    const la = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM postal_codes WHERE postal_code = '91403'`,
    ).first<{ n: number }>();
    expect(la!.n).toBe(1);
  });
});
