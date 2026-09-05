/**
 * Turning numbers into the words a person reads, for the browser bundle.
 *
 * This exists because the same three things had been written out five and six
 * times over: a currency formatter in CostGuide, CostIndex, JobsPanel,
 * OnlineSwitch and PartsQuotes, a median in two of them, and the zero-decimal
 * currency list in three. Two of those copies carried a comment saying the
 * duplication was forced because "the browser bundle does not compile the
 * Worker's sources". That is true of the Worker, and it was never true of each
 * other — every file listed above is compiled into this same bundle, so
 * sharing between them costs nothing and drift between them costs a page that
 * quotes a different price from the page linking to it. It had already begun:
 * api.ts's copy of the zero-decimal list had five entries where the others had
 * ten, so a job priced in XAF rendered as two different numbers depending on
 * which screen you were looking at.
 *
 * The one duplication that IS forced is against src/lib/countries.ts, which
 * runs in the Worker. `formatMoney` here mirrors `formatMoney` there — same
 * name, same signature, same output — and the two have to be changed together.
 */

/**
 * Currencies with no minor unit. Storing these as "cents" and dividing by a
 * hundred would quote a ¥4,500 job as ¥45.
 *
 * Mirrors ZERO_DECIMAL in src/lib/countries.ts. HUF, IDR and COP are often
 * treated as zero-decimal by payment processors but ISO 4217 gives them two
 * minor digits, so they stay off this list on both sides.
 */
export const ZERO_DECIMAL = new Set([
  'JPY', 'KRW', 'CLP', 'ISK', 'VND', 'PYG', 'RWF', 'UGX', 'XAF', 'XOF',
]);

/**
 * Money, in the currency the row was priced in.
 *
 * The locale argument is the reader's, not the money's: it decides where the
 * separators and the symbol go, while `currency` decides which symbol and
 * whether there are minor units at all. Callers inside the operator app pass
 * the operator's locale through api.ts's `money`; the public pages take the
 * default, because a cost guide is read by strangers whose locale we have no
 * business guessing from the price they are looking at.
 */
export function formatMoney(cents: number, currency: string, locale = 'en-US'): string {
  const zero = ZERO_DECIMAL.has(currency);
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency', currency,
      minimumFractionDigits: zero ? 0 : 2,
      maximumFractionDigits: zero ? 0 : 2,
    }).format(zero ? cents : cents / 100);
  } catch {
    // An unknown currency code is still a number somebody needs to read.
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/**
 * The middle listed price, from an already-sorted array.
 *
 * Median rather than mean: one full-day job listed at ten times everything
 * else would drag an average somewhere no real job sits, and the figure a
 * reader carries away has to be a price they could actually pay.
 */
export function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  if (lo === undefined || hi === undefined) return null;
  return Math.round((lo + hi) / 2);
}

/**
 * Below this many listed prices there is no useful spread to report, only two
 * or three businesses' opinions. The cost pages show them as what they are — a
 * couple of listings — instead of dressing them up as a range.
 *
 * seo.ts has its own ENOUGH for the server-rendered cost pages and it must
 * carry the same value: a trade shown with a range on one page and told "too
 * few listings to give a range" on the page it links to makes both look wrong.
 */
export const ENOUGH = 3;
