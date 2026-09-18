/**
 * WHAT ROUND THE WAY CHARGES.
 *
 * THIS FILE IS THE ONLY PLACE A RATE MAY EXIST. Not in a route, not in a
 * component, not in a page of copy, not in the database. Every figure a
 * customer or a business is ever shown comes from here, so there is exactly
 * one line to change and no second copy to drift away from it.
 *
 * THE RULE, and it has no exceptions:
 *
 *   A FEE IS CHARGED ON EVERY BOOKING. Every one. There is no free tier, no
 *   free first booking, no reduced rate, and no repeat-customer discount.
 *
 * That last one is worth stating because an earlier version of this product
 * had it and it was wrong. The idea was that a business filling a slot from
 * its own client list would pay nothing, and only a customer the site
 * introduced would carry a fee. It does not survive contact with the product:
 * there is no client list here, nobody can import one, and there is no way to
 * tell an "own" customer from a new one without inventing a distinction the
 * data cannot support. A booking is a booking. Do not reintroduce it.
 *
 * HOW THE MONEY MOVES. The customer pays the full price on this site — never
 * on a page belonging to the processor — into the platform's own account. The
 * fee below stays behind and the remainder is transferred to the business that
 * does the work. See lib/stripe.ts for the mechanics and migration 0040 for
 * the columns.
 */

/** The fee, in basis points of the job's price. 1500 is 15%. */
export const FEE_BASIS_POINTS = 1500;

/**
 * THE CEILING. $150, and it is the part worth protecting.
 *
 * A straight percentage is fair at the bottom of the range and absurd at the
 * top. Processing a $2,000 clearance costs this platform exactly what
 * processing a $65 phone screen costs, so past a point the percentage stops
 * being a fee and becomes a tax on the operator's best day. At 15% the cap is
 * reached at a job of exactly $1,000, so:
 *
 *   everything under $1,000 pays the plain 15%;
 *   everything over $1,000 pays $150 and not a cent more.
 *
 * Almost nothing listed today reaches it. That is the point — it costs nothing
 * now and it is the sentence that keeps a big operator: fifteen per cent,
 * never more than $150.
 */
export const FEE_CAP_CENTS = 15_000;

/**
 * NOTHING IS ADDED FOR THE CUSTOMER. The price shown is the price paid.
 *
 * Every marketplace tacks a service fee on at checkout and it is the single
 * biggest reason a booking is abandoned at the last screen. The whole fee is
 * taken from the business side, which means the number beside an opening is
 * the number on the card, and this constant exists so that stays deliberate
 * rather than becoming an oversight somebody 'fixes' later.
 */
export const CUSTOMER_FEE_BASIS_POINTS = 0;

/** Kept so callers read the same way whether or not a rate has been set. */
export const feeConfigured = (): boolean => true;

/**
 * The platform's cut, in cents, on ONE BUSINESS'S WORK ON ONE DAY.
 *
 * THE CEILING IS PER BUSINESS, PER DAY, and both halves matter.
 *
 *   Not per basket. A basket can hold work from three businesses that have
 *   never met, each paid into its own account. Capping the basket would make
 *   what one operator is charged depend on what the customer happened to buy
 *   from somebody else, and would leave $150 to be divided between strangers.
 *
 *   Not per job. If one business has two $600 jobs on the SAME DAY, that is
 *   $1,200 of work that day and the ceiling is reached — $150, not two
 *   separate fees of $90. Charging per line would let the cap be walked round
 *   by splitting one piece of work into two.
 *
 *   But not across days either. Two $600 jobs a week apart are two days'
 *   work, and they get a ceiling each: $90 and $90. The cap is a limit on
 *   what a single day can cost a business, not a bulk discount for booking
 *   far ahead — otherwise somebody filling a whole month in one checkout
 *   would pay the same $150 as somebody filling one afternoon.
 *
 * So: add up what one business is doing on one day, take 15% of that, and stop
 * at $150. Rounded DOWN, so the odd cent is always the platform's and never
 * the operator's.
 */
export function feeFor(priceCents: number): number {
  const price = Math.max(0, Math.floor(priceCents));
  const pct = Math.floor((price * FEE_BASIS_POINTS) / 10_000);
  // min(price) as well as the cap: a fee may never exceed the work itself,
  // which would mean charging somebody to do a job.
  return Math.min(price, FEE_CAP_CENTS, pct);
}

/** What a business actually receives for the work it did in one order. */
export const payoutFor = (priceCents: number): number =>
  Math.max(0, Math.floor(priceCents)) - feeFor(priceCents);

/** One line of an order, as the fee calculation needs to see it. */
export interface FeeLine {
  operator_id: string;
  price_cents: number;
  /**
   * Which day this job is ON — not when it was booked.
   *
   * A stable key for the operator's own local day, so an evening job and the
   * following morning's are two days even though they are twelve hours apart,
   * and two jobs on the same afternoon are one day even if the customer booked
   * them a week apart. The caller derives it, because working out an
   * operator's local midnight needs their timezone and this module has no
   * business knowing about timezones.
   */
  day: string;
}

/**
 * The key a fee is actually calculated on: one business, one of its own days.
 *
 * Exported so that anything having to spread a fee back over the lines that
 * earned it groups by the same key this module grouped by, rather than by a
 * second spelling of it that agrees until somebody changes one of them.
 */
export const feeGroupKey = (operatorId: string, day: string): string =>
  `${operatorId}\u0000${day}`;

/**
 * The fee across a whole basket: grouped by business AND by day, then capped.
 *
 * `byOperator` is keyed by business so the caller can build one transfer per
 * business, which is what actually moves the money — a business with work on
 * three days gets three capped fees and one transfer for the remainder.
 *
 * `byGroup` is the same money at the granularity it was WORKED OUT at, and it
 * exists because a fee summed across days cannot be spread back over lines
 * afterwards. $600 and $600 on Monday are capped at $150 between them while
 * $600 on Wednesday is $90 on its own; adding those to $240 and dividing by
 * price gives every line $80 — right in total and wrong on all three rows.
 * Those rows are what a business is shown, what a cancelled line's payout is
 * computed from, and what survives a line being cancelled. See splitOrder.
 */
export function feeForOrder(items: FeeLine[]): {
  total: number;
  byOperator: Map<string, number>;
  byGroup: Map<string, number>;
} {
  // operator + day -> what that business is being paid that day
  const gross = new Map<string, { operator: string; sum: number }>();
  for (const it of items) {
    const key = feeGroupKey(it.operator_id, it.day);
    const held = gross.get(key);
    if (held) held.sum += Math.max(0, it.price_cents);
    else gross.set(key, { operator: it.operator_id, sum: Math.max(0, it.price_cents) });
  }

  const byOperator = new Map<string, number>();
  const byGroup = new Map<string, number>();
  let total = 0;
  for (const [key, { operator, sum }] of gross) {
    const fee = feeFor(sum);
    byGroup.set(key, fee);
    byOperator.set(operator, (byOperator.get(operator) ?? 0) + fee);
    total += fee;
  }
  return { total, byOperator, byGroup };
}

/**
 * How the fee is described to a business, built from the same constants so a
 * page can never quote a rate the code does not charge.
 */
export function feeSentence(currencySymbol = '$'): string {
  const pct = (FEE_BASIS_POINTS / 100).toFixed(FEE_BASIS_POINTS % 100 === 0 ? 0 : 2);
  const cap = `${currencySymbol}${Math.round(FEE_CAP_CENTS / 100)}`;
  // THE CAP IS PER BUSINESS PER DAY, AND THE SENTENCE HAS TO SAY SO.
  // "never more than $150" on its own reads as a ceiling on one job, which
  // overstates the fee on a single big job and understates how far the cap
  // reaches: two $600 jobs for one business on one day are capped at $150
  // between them, not $90 and $90. feeForOrder groups on operator and local
  // day; this sentence is the only description of that a person ever sees.
  return `${pct}% of the job, never more than ${cap} from one business in one day`;
}
