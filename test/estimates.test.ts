import { describe, expect, it, beforeEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import type { Env } from '../src/types';
import { startThread, threadByToken } from '../src/lib/chat';
import {
  askForEstimate, decideEstimate, estimatesForGuest, estimatesForOperator,
  expireEstimates, quoteEstimate, withdrawEstimate,
} from '../src/lib/estimates';
import { now } from '../src/lib/util';

/**
 * Estimates: the price a business names for a job nobody posted.
 *
 * This file exists because there was none. Seven hundred lines that put a
 * number in front of a stranger, take their yes, and are the front door to
 * charging them had no test at all — so the two rules the module is written
 * around were only claims in a comment.
 *
 * Those two rules are what this file is mostly about:
 *
 *   1. Nobody is charged for a number they have not seen. The price and the
 *      time on the row the customer tapped are the only ones that can bind,
 *      a second tap decides nothing twice, and a quote whose start time has
 *      gone cannot be accepted however late the sweep ran.
 *   2. Neither side is trusted with an id. An estimate id lifted from another
 *      customer's link, or another operator's account, is answered exactly as
 *      an id that was never real.
 *
 * The acceptance path deliberately moves no money yet — decideEstimate carries
 * a PAYMENT SEAM comment saying so — so the test below asserts what is true
 * today: `order_id` stays NULL and no order row appears. That is the assertion
 * that will fail, loudly and in the right place, on the day somebody wires the
 * charge up without wiring the booking to go with it.
 */

const MIGRATIONS = ALL_MIGRATIONS;

let env: Env;

const OP = 'op-estimates';
const OTHER_OP = 'op-someone-else';

const HOUR = 3600;

const one = async <T>(sql: string, ...args: unknown[]) =>
  env.DB.prepare(sql).bind(...args).first<T>();

async function addOperator(id: string, name: string, email: string) {
  const n = now();
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,trade,timezone,country,currency,language,
       location_mode,fill_model,sms_mode,max_detour_seconds,min_gap_seconds,buffer_seconds,
       offer_ttl_seconds,offers_per_wave,min_notice_seconds,reoffer_cooldown_seconds,
       discount_percent,plan,accept_public_bookings,deposit_cents,created_at,updated_at)
     VALUES (?,?,?, 'house cleaning','America/Los_Angeles','US','USD','en','mobile','both',
       'device',900,3600,900,5400,3,3600,604800,0,'active',1,1000,?,?)`,
  ).bind(id, email, name, n, n).run();
}

/** A conversation with a customer, and the raw guest token that reaches it. */
async function conversation(operatorId = OP, guestName = 'Rosa') {
  const { thread, token } = await startThread(env, {
    operator_id: operatorId,
    guest_name: guestName,
    first_message: 'Hello',
  });
  return { thread, token };
}

/** A sane set of numbers to quote with: half a day, starting tomorrow. */
const goodQuote = (overrides: Partial<{
  description: string; price_cents: number; duration_seconds: number; starts_at: number;
}> = {}) => ({
  description: 'Whole house, three bedrooms and the conservatory',
  price_cents: 24000,
  duration_seconds: 4 * HOUR,
  starts_at: now() + 24 * HOUR,
  ...overrides,
});

beforeEach(async () => {
  env = makeEnv(MIGRATIONS) as unknown as Env;
  await addOperator(OP, 'Valley Cleaning', 'valley@example.com');
  await addOperator(OTHER_OP, 'Someone Else Cleaning', 'else@example.com');
});

// ---------------------------------------------------------------------------

describe('asking for an estimate', () => {
  it('records the question and puts it in the conversation the operator reads', async () => {
    const { thread, token } = await conversation();
    const e = await askForEstimate(env, token, 'Can you do the whole house next Thursday?');

    expect(e.status).toBe('asked');
    expect(e.thread_id).toBe(thread.id);
    expect(e.operator_id).toBe(OP);
    // Nothing about money exists until the business answers.
    expect(e.price_cents).toBeNull();
    expect(e.starts_at).toBeNull();
    expect(e.currency).toBeNull();
    // An unanswered question has no fuse: expiring it would only delete the
    // evidence that the business never replied.
    expect(e.expires_at).toBeNull();

    const msg = await one<{ body: string }>(
      `SELECT body FROM chat_messages WHERE thread_id = ? AND body LIKE 'Asked for an estimate%'`,
      thread.id,
    );
    expect(msg?.body).toContain('whole house');
  });

  /**
   * The most tempting box on the site: the person typing it is describing a
   * job and reaching for "just call me about it". If the filter is ever
   * dropped here it is dropped on the one text box where a phone number is
   * most likely to be typed.
   */
  it('strips a phone number out of the request before it is stored', async () => {
    const { token } = await conversation();
    const e = await askForEstimate(
      env, token, 'Whole house please, just call me on (818) 555-0142',
    );
    expect(e.request).not.toContain('555-0142');
    expect(e.request).not.toMatch(/\d{3}[-\s]?\d{4}/);

    // And not by way of the row either — the redaction happens before insert.
    const row = await one<{ request: string }>(
      `SELECT request FROM estimates WHERE id = ?`, e.id,
    );
    expect(row!.request).not.toContain('555-0142');
  });

  it('refuses a blank, and refuses more than a phone screen of text', async () => {
    const { token } = await conversation();
    await expect(askForEstimate(env, token, '   ')).rejects.toThrow(/blank/i);
    await expect(askForEstimate(env, token, 'x'.repeat(601))).rejects.toThrow(/600/);
  });

  it('caps how many unanswered questions one conversation may carry', async () => {
    const { token } = await conversation();
    for (let i = 0; i < 3; i++) await askForEstimate(env, token, `Job number ${i}`);
    await expect(askForEstimate(env, token, 'And one more'))
      .rejects.toThrow(/questions waiting/i);
  });

  it('is not reachable with a token that resolves to nothing', async () => {
    await expect(askForEstimate(env, 'not-a-real-token', 'Anything'))
      .rejects.toThrow(/not valid/i);
  });
});

// ---------------------------------------------------------------------------

describe('quoting a price', () => {
  it('puts a price, a length and a start on the row, and says so in the thread', async () => {
    const { thread, token } = await conversation();
    const asked = await askForEstimate(env, token, 'Whole house');
    const q = await quoteEstimate(env, OP, asked.id, goodQuote());

    expect(q.status).toBe('quoted');
    expect(q.price_cents).toBe(24000);
    expect(q.currency).toBe('USD');
    // The job itself is the deadline. A separate TTL would either kill a quote
    // the customer was still thinking about, or leave one answerable after the
    // morning it was for.
    expect(q.expires_at).toBe(q.starts_at);

    const msg = await one<{ body: string }>(
      `SELECT body FROM chat_messages WHERE thread_id = ? AND body LIKE '%sent an estimate%'`,
      thread.id,
    );
    // The customer is told, in the same breath as the number, that tapping is
    // still required. This sentence is the promise the feature rests on.
    expect(msg?.body).toContain('Nothing is booked or charged until you accept it');
    expect(msg?.body).toContain('$240.00');
  });

  it('refuses prices, durations and start times that are somebody mistyping', async () => {
    const { token } = await conversation();
    const asked = await askForEstimate(env, token, 'Whole house');

    // Zero is a message, not something to accept; the ceiling is a typo guard.
    await expect(quoteEstimate(env, OP, asked.id, goodQuote({ price_cents: 0 })))
      .rejects.toThrow(/needs a price/i);
    await expect(quoteEstimate(env, OP, asked.id, goodQuote({ price_cents: 50_000_01 })))
      .rejects.toThrow(/typo/i);

    // Seconds typed where minutes were meant, at both ends.
    await expect(quoteEstimate(env, OP, asked.id, goodQuote({ duration_seconds: 60 })))
      .rejects.toThrow(/how long/i);
    await expect(quoteEstimate(env, OP, asked.id, goodQuote({ duration_seconds: 13 * HOUR })))
      .rejects.toThrow(/how long/i);

    // A start in the past, and one so close the customer could not read it in
    // time — which would be swept to expired almost at once and read to both
    // of them as the site losing the job.
    await expect(quoteEstimate(env, OP, asked.id, goodQuote({ starts_at: now() - 60 })))
      .rejects.toThrow(/future/i);
    await expect(quoteEstimate(env, OP, asked.id, goodQuote({ starts_at: now() + 5 * 60 })))
      .rejects.toThrow(/half an hour/i);

    // Nothing above got as far as the row.
    const still = await one<{ status: string }>(
      `SELECT status FROM estimates WHERE id = ?`, asked.id,
    );
    expect(still!.status).toBe('asked');
  });

  it('refuses a price with no description of what it buys', async () => {
    const { token } = await conversation();
    const asked = await askForEstimate(env, token, 'Whole house');
    await expect(quoteEstimate(env, OP, asked.id, goodQuote({ description: '   ' })))
      .rejects.toThrow(/what you would be doing/i);
  });

  it('filters contact details out of the operator\'s answer too', async () => {
    const { token } = await conversation();
    const asked = await askForEstimate(env, token, 'Whole house');
    const q = await quoteEstimate(env, OP, asked.id, goodQuote({
      description: 'Whole house — ring me on (818) 555-0199 to arrange',
    }));
    expect(q.description).not.toContain('555-0199');
  });

  /**
   * An operator who typed 300 meaning 3000 has to be able to fix it, and the
   * corrected row must be the only number the customer can ever tap.
   */
  it('lets a live quote be re-quoted, and the new number is the only one', async () => {
    const { token } = await conversation();
    const asked = await askForEstimate(env, token, 'Whole house');
    await quoteEstimate(env, OP, asked.id, goodQuote({ price_cents: 300 }));
    const fixed = await quoteEstimate(env, OP, asked.id, goodQuote({ price_cents: 30000 }));

    expect(fixed.price_cents).toBe(30000);
    const row = await one<{ price_cents: number }>(
      `SELECT price_cents FROM estimates WHERE id = ?`, asked.id,
    );
    expect(row!.price_cents).toBe(30000);
  });

  /**
   * operator_id is in the WHERE clause rather than checked after the read, so
   * which estimate ids exist is not something this API confirms.
   */
  it('will not let one business price another business\'s estimate', async () => {
    const { token } = await conversation();
    const asked = await askForEstimate(env, token, 'Whole house');

    await expect(quoteEstimate(env, OTHER_OP, asked.id, goodQuote()))
      .rejects.toThrow(/not yours/i);

    const row = await one<{ status: string; price_cents: number | null }>(
      `SELECT status, price_cents FROM estimates WHERE id = ?`, asked.id,
    );
    expect(row!.status).toBe('asked');
    expect(row!.price_cents).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('the customer deciding', () => {
  /** Ask, quote, and hand back everything a decision needs. */
  async function quoted(opts: { price?: number; startsAt?: number } = {}) {
    const { thread, token } = await conversation();
    const asked = await askForEstimate(env, token, 'Whole house');
    const q = await quoteEstimate(env, OP, asked.id, goodQuote({
      price_cents: opts.price ?? 24000,
      ...(opts.startsAt ? { starts_at: opts.startsAt } : {}),
    }));
    return { thread, token, estimate: q };
  }

  it('records an acceptance once, against the numbers the customer saw', async () => {
    const { token, estimate } = await quoted();
    const accepted = await decideEstimate(env, token, estimate.id, 'accepted');

    expect(accepted.status).toBe('accepted');
    // The figures are the ones on the row that was tapped, never recalculated.
    expect(accepted.price_cents).toBe(24000);
    expect(accepted.starts_at).toBe(estimate.starts_at);

    const row = await one<{ status: string; decided_at: number | null }>(
      `SELECT status, decided_at FROM estimates WHERE id = ?`, estimate.id,
    );
    expect(row!.status).toBe('accepted');
    expect(row!.decided_at).not.toBeNull();
  });

  /**
   * The payment seam in decideEstimate is deliberately not wired: accepting
   * records the yes and moves no money. This pins that down both ways round —
   * order_id NULL AND no order row — so that wiring the charge without wiring
   * the booking, or the other way about, fails here rather than in front of a
   * customer. Change this test when the seam is closed; do not delete it.
   */
  it('moves no money and books nothing yet, and leaves order_id null', async () => {
    const { token, estimate } = await quoted();
    const accepted = await decideEstimate(env, token, estimate.id, 'accepted');

    expect(accepted.order_id).toBeNull();
    const row = await one<{ order_id: string | null }>(
      `SELECT order_id FROM estimates WHERE id = ?`, estimate.id,
    );
    expect(row!.order_id).toBeNull();

    const orders = await one<{ n: number }>(`SELECT COUNT(*) AS n FROM orders`);
    expect(orders!.n).toBe(0);
    const appts = await one<{ n: number }>(`SELECT COUNT(*) AS n FROM appointments`);
    expect(appts!.n).toBe(0);
  });

  /**
   * A customer double-tapping accept on a phone, one-handed, on a bad
   * connection. The second tap matches no row and must not become a second
   * booking or a second charge.
   */
  it('cannot be decided twice, whichever way the second tap goes', async () => {
    const { token, estimate } = await quoted();
    await decideEstimate(env, token, estimate.id, 'accepted');

    await expect(decideEstimate(env, token, estimate.id, 'accepted'))
      .rejects.toThrow(/already|accepted/i);
    await expect(decideEstimate(env, token, estimate.id, 'declined'))
      .rejects.toThrow(/already|accepted/i);

    const row = await one<{ status: string }>(
      `SELECT status FROM estimates WHERE id = ?`, estimate.id,
    );
    expect(row!.status).toBe('accepted');
  });

  it('records a decline, and says so in the conversation', async () => {
    const { thread, token, estimate } = await quoted();
    const declined = await decideEstimate(env, token, estimate.id, 'declined');
    expect(declined.status).toBe('declined');

    const msg = await one<{ body: string }>(
      `SELECT body FROM chat_messages WHERE thread_id = ? AND body LIKE 'Declined:%'`,
      thread.id,
    );
    expect(msg?.body).toContain('$240.00');
  });

  it('will not accept a question that has never been priced', async () => {
    const { token } = await conversation();
    const asked = await askForEstimate(env, token, 'Whole house');
    await expect(decideEstimate(env, token, asked.id, 'accepted'))
      .rejects.toThrow(/not sent a price/i);
  });

  /**
   * A row is only still 'quoted' because nothing has expired it yet. A
   * customer must never be able to accept a start time that has already gone
   * because the cron was late.
   */
  it('refuses a quote whose start time has passed, even before the sweep runs', async () => {
    const { token, estimate } = await quoted();
    // Move the deadline into the past without touching status, which is
    // exactly the state a late cron leaves behind.
    await env.DB.prepare(
      `UPDATE estimates SET expires_at = ?, starts_at = ? WHERE id = ?`,
    ).bind(now() - 60, now() - 60, estimate.id).run();

    await expect(decideEstimate(env, token, estimate.id, 'accepted'))
      .rejects.toThrow(/passed/i);

    const row = await one<{ status: string }>(
      `SELECT status FROM estimates WHERE id = ?`, estimate.id,
    );
    expect(row!.status).toBe('quoted');
  });

  /**
   * The estimate is fetched by id AND the thread the token resolved to, so an
   * id lifted from somebody else's link is answered as one that never existed.
   */
  it('will not let one customer decide another customer\'s estimate', async () => {
    const { estimate } = await quoted();
    const { token: strangerToken } = await conversation(OP, 'Someone Else');

    await expect(decideEstimate(env, strangerToken, estimate.id, 'accepted'))
      .rejects.toThrow(/not on your conversation/i);

    const row = await one<{ status: string }>(
      `SELECT status FROM estimates WHERE id = ?`, estimate.id,
    );
    expect(row!.status).toBe('quoted');
  });

  it('refuses a decision that is neither accept nor decline', async () => {
    const { token, estimate } = await quoted();
    await expect(
      decideEstimate(env, token, estimate.id, 'maybe' as 'accepted'),
    ).rejects.toThrow(/accept it or decline it/i);
  });
});

// ---------------------------------------------------------------------------

describe('withdrawing and expiring', () => {
  it('withdraws a live quote and tells the customer, rather than deleting it', async () => {
    const { thread, token } = await conversation();
    const asked = await askForEstimate(env, token, 'Whole house');
    const q = await quoteEstimate(env, OP, asked.id, goodQuote());

    const w = await withdrawEstimate(env, OP, q.id);
    expect(w.status).toBe('withdrawn');

    const msg = await one<{ body: string }>(
      `SELECT body FROM chat_messages WHERE thread_id = ? AND body LIKE '%withdrew%'`,
      thread.id,
    );
    expect(msg?.body).toContain('withdrew their estimate');
  });

  /**
   * Pretending a price was pulled when none was ever sent would leave the
   * customer waiting for one that is not coming.
   */
  it('says something different when there was never a price', async () => {
    const { thread, token } = await conversation();
    const asked = await askForEstimate(env, token, 'Whole house');
    await withdrawEstimate(env, OP, asked.id);

    const msg = await one<{ body: string }>(
      `SELECT body FROM chat_messages WHERE thread_id = ? AND body LIKE '%cannot take%'`,
      thread.id,
    );
    expect(msg?.body).toContain('cannot take that one on');
  });

  it('cannot withdraw something the customer has already accepted', async () => {
    const { token } = await conversation();
    const asked = await askForEstimate(env, token, 'Whole house');
    const q = await quoteEstimate(env, OP, asked.id, goodQuote());
    await decideEstimate(env, token, q.id, 'accepted');

    await expect(withdrawEstimate(env, OP, q.id)).rejects.toThrow(/accepted/i);
  });

  it('will not let one business withdraw another\'s estimate', async () => {
    const { token } = await conversation();
    const asked = await askForEstimate(env, token, 'Whole house');
    await expect(withdrawEstimate(env, OTHER_OP, asked.id)).rejects.toThrow(/not yours/i);
  });

  /**
   * A quote left 'quoted' forever is a standing offer to book a morning that
   * has already happened. An 'asked' row has no time and no number in it, so
   * expiring one would erase the evidence that nobody answered.
   */
  it('sweeps quotes whose time has gone, and leaves unanswered questions alone', async () => {
    const { token } = await conversation();

    const stale = await askForEstimate(env, token, 'Job one');
    await quoteEstimate(env, OP, stale.id, goodQuote());
    await env.DB.prepare(
      `UPDATE estimates SET expires_at = ?, starts_at = ? WHERE id = ?`,
    ).bind(now() - HOUR, now() - HOUR, stale.id).run();

    const live = await askForEstimate(env, token, 'Job two');
    await quoteEstimate(env, OP, live.id, goodQuote());

    const unanswered = await askForEstimate(env, token, 'Job three');

    expect(await expireEstimates(env)).toBe(1);

    const status = async (id: string) => (await one<{ status: string }>(
      `SELECT status FROM estimates WHERE id = ?`, id,
    ))!.status;
    expect(await status(stale.id)).toBe('expired');
    expect(await status(live.id)).toBe('quoted');
    expect(await status(unanswered.id)).toBe('asked');
  });

  /**
   * expires_at is only set when the quote is sent; a row written by anything
   * else may carry only a start time, and the job starting is the deadline
   * either way.
   */
  it('falls back to the start time when a quote carries no expiry', async () => {
    const { token } = await conversation();
    const e = await askForEstimate(env, token, 'Whole house');
    await quoteEstimate(env, OP, e.id, goodQuote());
    await env.DB.prepare(
      `UPDATE estimates SET expires_at = NULL, starts_at = ? WHERE id = ?`,
    ).bind(now() - HOUR, e.id).run();

    expect(await expireEstimates(env)).toBe(1);
    const row = await one<{ status: string }>(
      `SELECT status FROM estimates WHERE id = ?`, e.id,
    );
    expect(row!.status).toBe('expired');
  });
});

// ---------------------------------------------------------------------------

describe('reading estimates back', () => {
  it('gives a customer only what is on their own conversation', async () => {
    const { token: mine } = await conversation(OP, 'Rosa');
    const { token: theirs } = await conversation(OP, 'Someone Else');
    await askForEstimate(env, mine, 'My job');
    await askForEstimate(env, theirs, 'Their job');

    const forMe = await estimatesForGuest(env, mine);
    expect(forMe).toHaveLength(1);
    expect(forMe[0]!.request).toContain('My job');

    // A token that resolves to nothing gets an empty list, not somebody else's.
    expect(await estimatesForGuest(env, 'not-a-token')).toEqual([]);
  });

  it('scopes an operator to their own, and filters by status and thread', async () => {
    const { thread: t1, token: k1 } = await conversation(OP, 'Rosa');
    const { token: k2 } = await conversation(OP, 'Dev');
    const a1 = await askForEstimate(env, k1, 'Job one');
    await askForEstimate(env, k2, 'Job two');
    await quoteEstimate(env, OP, a1.id, goodQuote());

    // Another business's conversation must not appear in this one's list.
    const { token: other } = await conversation(OTHER_OP, 'Not mine');
    await askForEstimate(env, other, 'Somebody else entirely');

    const all = await estimatesForOperator(env, OP);
    expect(all).toHaveLength(2);
    expect(all.every((e) => e.operator_id === OP)).toBe(true);

    const onlyQuoted = await estimatesForOperator(env, OP, { status: 'quoted' });
    expect(onlyQuoted.map((e) => e.id)).toEqual([a1.id]);

    const onlyThread = await estimatesForOperator(env, OP, { thread_id: t1.id });
    expect(onlyThread.map((e) => e.id)).toEqual([a1.id]);

    expect(await estimatesForOperator(env, OTHER_OP)).toHaveLength(1);
  });

  it('holds the guest link to one thread, so a stale token reads nothing', async () => {
    const { token } = await conversation();
    await askForEstimate(env, token, 'Whole house');
    // The token is the only credential; resolving it is what scopes the read.
    const thread = await threadByToken(env, token);
    expect(thread).not.toBeNull();
    expect((await estimatesForGuest(env, token))[0]!.thread_id).toBe(thread!.id);
  });
});
