import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_FEE_BASIS_POINTS, FEE_BASIS_POINTS, FEE_CAP_CENTS,
  feeFor, feeForOrder, feeSentence, payoutFor,
} from '../src/lib/fees';

/**
 * WHAT ROUND THE WAY CHARGES.
 *
 * This is the file that decides how much of somebody's money the platform
 * keeps, so every figure in it is pinned rather than described. A change to
 * the rate should have to break a test with a number in it — not slip through
 * because the arithmetic still runs.
 */

const $ = (dollars: number) => Math.round(dollars * 100);

describe('the rate', () => {
  it('is fifteen per cent, capped at $150', () => {
    expect(FEE_BASIS_POINTS).toBe(1500);
    expect(FEE_CAP_CENTS).toBe(15_000);
  });

  it('adds nothing for the customer', () => {
    // The price beside an opening is the price on the card. A service fee
    // appearing at the last screen is the main reason a booking is abandoned,
    // and the whole fee is taken from the business side instead.
    expect(CUSTOMER_FEE_BASIS_POINTS).toBe(0);
  });
});

describe('the fee on one job', () => {
  it('is 15% under the cap', () => {
    expect(feeFor($(65))).toBe($(9.75));
    expect(feeFor($(89))).toBe($(13.35));
    expect(feeFor($(150))).toBe($(22.50));
    expect(feeFor($(300))).toBe($(45));
    expect(feeFor($(500))).toBe($(75));
  });

  it('reaches the cap at exactly $1,000 and never passes it', () => {
    expect(feeFor($(999))).toBe($(149.85));
    expect(feeFor($(1000))).toBe($(150));
    expect(feeFor($(1001))).toBe($(150));
    expect(feeFor($(2000))).toBe($(150));
    expect(feeFor($(50_000))).toBe($(150));
  });

  it('rounds down, so the odd cent is the platform’s and not the operator’s', () => {
    // 15% of $9.99 is 149.85 cents. The operator keeps the .85.
    expect(feeFor(999)).toBe(149);
    expect(payoutFor(999)).toBe(850);
  });

  it('never charges more than the job is worth', () => {
    expect(feeFor(0)).toBe(0);
    expect(feeFor(1)).toBe(0);
    for (const p of [0, 1, 7, 100, 12_345, 999_999]) {
      expect(feeFor(p)).toBeLessThanOrEqual(p);
      expect(payoutFor(p)).toBeGreaterThanOrEqual(0);
    }
  });

  it('never returns a negative or a fraction of a cent', () => {
    for (const p of [-500, -1, 0, 3, 6_667, 100_001]) {
      const f = feeFor(p);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(f)).toBe(true);
    }
  });

  it('leaves the operator everything it does not take', () => {
    for (const p of [$(65), $(300), $(1000), $(4000)]) {
      expect(feeFor(p) + payoutFor(p)).toBe(p);
    }
  });

  it('gets cheaper as a share once the cap bites', () => {
    // The whole argument for the ceiling: a big job costs the platform no more
    // to process than a small one, so past $1,000 the effective rate falls.
    const rate = (p: number) => feeFor(p) / p;
    expect(rate($(500))).toBeCloseTo(0.15, 5);
    expect(rate($(2000))).toBeCloseTo(0.075, 5);
    expect(rate($(5000))).toBeCloseTo(0.03, 5);
  });
});

describe('a basket with several businesses and several days in it', () => {
  const item = (operator_id: string, dollars: number, day = 'mon') =>
    ({ operator_id, price_cents: $(dollars), day });

  it('caps each BUSINESS on its own, never the whole basket', () => {
    // Three $800 jobs from three different businesses. Each is under the cap
    // on its own, so each pays the full 15% — $360 in total. A basket-level
    // cap would charge $150 and leave it to be divided between three
    // strangers, with each one's fee depending on what the others charged.
    const { total, byOperator } = feeForOrder([
      item('a', 800), item('b', 800), item('c', 800),
    ]);
    expect(total).toBe($(360));
    expect(byOperator.get('a')).toBe($(120));
    expect(byOperator.get('b')).toBe($(120));
  });

  it('adds one business’s jobs together when they are on the SAME day', () => {
    // Two $600 jobs from the same business on one day is $1,200 of work that
    // day, which is the ceiling — $150, not two fees of $90. Charging per line
    // would let the cap be walked round by splitting one job into two.
    const { total, byOperator } = feeForOrder([
      item('a', 600, 'mon'), item('a', 600, 'mon'),
    ]);
    expect(total).toBe($(150));
    expect(byOperator.get('a')).toBe($(150));
  });

  it('gives the same business a fresh ceiling on a DIFFERENT day', () => {
    // THE OTHER HALF OF THE RULE. The same two $600 jobs a week apart are two
    // days' work and get a cap each: $90 and $90. Otherwise somebody filling a
    // whole month in one checkout would pay the same $150 as somebody filling
    // one afternoon.
    const { total, byOperator } = feeForOrder([
      item('a', 600, 'mon'), item('a', 600, 'tue'),
    ]);
    expect(total).toBe($(180));
    expect(byOperator.get('a')).toBe($(180));
  });

  it('caps each day separately for a business working several big days', () => {
    const { byOperator } = feeForOrder([
      item('a', 2000, 'mon'), item('a', 2000, 'tue'), item('a', 65, 'wed'),
    ]);
    // $150 + $150 + $9.75 — not one $150 for the lot.
    expect(byOperator.get('a')).toBe($(150) + $(150) + $(9.75));
  });

  it('caps the business that reaches it and nobody else', () => {
    const { total, byOperator } = feeForOrder([item('a', 65), item('b', 2000)]);
    expect(byOperator.get('a')).toBe($(9.75));
    expect(byOperator.get('b')).toBe($(150));
    expect(total).toBe($(9.75) + $(150));
  });

  it('keeps two businesses working the same day apart', () => {
    const { byOperator } = feeForOrder([
      item('a', 700, 'mon'), item('b', 700, 'mon'),
    ]);
    expect(byOperator.get('a')).toBe($(105));
    expect(byOperator.get('b')).toBe($(105));
  });

  it('is empty for an empty basket', () => {
    const { total, byOperator } = feeForOrder([]);
    expect(total).toBe(0);
    expect(byOperator.size).toBe(0);
  });
});

describe('how it is described', () => {
  it('quotes the rate the code actually charges', () => {
    // A page that states a rate must build the sentence from the constants,
    // so a figure in copy can never drift away from the figure in the maths.
    expect(feeSentence()).toBe(
      '15% of the job, never more than $150 from one business in one day');
  });

  it('says who the cap belongs to, because the cap is not per job', () => {
    // The sentence used to stop at "never more than $150", which reads as a
    // ceiling on a single job. It is not: feeForOrder groups by operator AND
    // by that operator's own local day, so two $600 jobs for one business on
    // one afternoon are capped at $150 between them rather than charged $90
    // each. Somebody reading the short version would under-quote the cap's
    // reach on a busy day and over-quote the fee on one big job.
    expect(feeSentence()).toContain('from one business in one day');
    const day = '2026-09-11';
    const two = feeForOrder([
      { operator_id: 'op', price_cents: 60_000, day },
      { operator_id: 'op', price_cents: 60_000, day },
    ]);
    expect(two.total).toBe(FEE_CAP_CENTS);
  });
});
