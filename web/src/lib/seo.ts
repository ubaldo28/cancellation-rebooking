/**
 * The URL spellings the Worker's server-rendered pages are minted with.
 *
 * Everything under /near is rendered by the Worker, not by this app, and the
 * Worker builds those addresses from src/lib/seo.ts. A link in the React app
 * that spells one of them differently does not degrade — it 404s, because
 * `tradeFromSlug` returns null for anything it does not recognise rather than
 * coercing it into a trade, which is the right call there and unforgiving
 * here.
 *
 * WHY THIS FILE EXISTS RATHER THAN A COPY PER PAGE. Areas.tsx carried a
 * private copy of `tradeSlug` with a comment explaining that the spelling has
 * to match; Trade.tsx did not, and built its "Where this is open right now"
 * links with `encodeURIComponent(trade)` instead — so every one of the eight
 * neighbourhood links under a busy trade page pointed at
 * /near/burbank/junk%20removal, which answers 404, while Areas.tsx's link to
 * /near/burbank/junk-removal answered 200. One copy, imported, is the only
 * arrangement where that cannot happen again.
 *
 * The Worker's sources are not in the browser bundle, so this is duplicated
 * across the wire rather than imported across it. It is three transformations
 * and they must stay identical to `tradeSlug` in src/lib/seo.ts.
 */

/** 'mobile detailing' -> 'mobile-detailing'. Deterministic, round-trippable. */
export function tradeSlug(trade: string): string {
  return trade
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The Worker's page for one trade in one neighbourhood.
 *
 * The area slug is already a slug and is encoded rather than re-slugged: it
 * comes off a row and is the business's own, and rewriting it here would be
 * this app deciding what somebody else's area is called.
 */
export const nearTradeHref = (areaSlug: string, trade: string): string =>
  `/near/${encodeURIComponent(areaSlug)}/${tradeSlug(trade)}`;
