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
 * When a job is, in the timezone the van will be standing in.
 *
 * THIS LIVED IN GuestThread.tsx AND NOW HAS TWO READERS, which is the whole
 * reason it moved. The conversation page prints it under a booking that has
 * already been made; the estimate card a few inches above prints it on a quote
 * that has not, and the two are the same appointment described before and
 * after the customer says yes. A quote reading "Thursday, 08:00 to 10:00" over
 * a confirmation reading "Thursday, 07:00 to 09:00" — which is exactly what a
 * second copy drifting onto the device clock would produce — is a customer who
 * cannot tell which of the two times anybody is coming at.
 *
 * It used to use the device clock outright, under a comment saying the guest
 * payload carried no timezone. It does: guestView in src/index.ts puts the
 * business's `timezone` and `locale` on every guest thread for exactly this,
 * and says in as many words that without it an 08:00 job renders as 07:00 and
 * somebody misses it. A customer reading this on a phone still on last week's
 * holiday timezone, or on a laptop set wrong, was being given an hour that
 * nobody is coming at.
 *
 * Both fields stay optional because an older Worker may not send them, so the
 * device's own zone remains the fallback — the customer and the van are
 * usually in the same place, which is what made the old behaviour right far
 * more often than not rather than always.
 */
export function bookingWhen(
  startSeconds: number, endSeconds: number, tz?: string, locale?: string,
): string {
  const opts: Intl.DateTimeFormatOptions = tz ? { timeZone: tz } : {};
  const day = new Intl.DateTimeFormat(locale, {
    ...opts, weekday: 'long', day: 'numeric', month: 'long',
  }).format(new Date(startSeconds * 1000));
  const at = (s: number) => new Intl.DateTimeFormat(locale, {
    ...opts, hour: '2-digit', minute: '2-digit',
  }).format(new Date(s * 1000));
  return `${day}, ${at(startSeconds)} to ${at(endSeconds)}`;
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

/**
 * "1 opening" / "5 openings", chosen by the number in front of it.
 *
 * Areas, BrowseIndex, Metro and CostIndex each carried this line verbatim. It
 * is trivial enough that four copies cost nothing to write and exactly one
 * thing to get wrong — a page that says "1 businesses" is a page a reader
 * stops trusting the arithmetic on.
 */
export const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
