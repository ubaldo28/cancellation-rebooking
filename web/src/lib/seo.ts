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

/**
 * A structured-data payload, safe to drop inside <script type="application/ld+json">.
 *
 * HTML-escaping is wrong in there — `&lt;` is not `<` to a JSON parser — so
 * the three characters that could close the element early are unicode-escaped
 * instead, which leaves the block parseable and inert as markup. A trade or
 * business name containing "</script>" then ends up as text rather than as a
 * way out of the element.
 *
 * Trade.tsx, CostGuide.tsx and Crumbs.tsx each had this — the first two under
 * a comment saying the duplication was the price of not making either page's
 * bundle pull in the other's. There are no separate bundles: App.tsx imports
 * every page eagerly and Vite emits one file, so the three copies bought
 * nothing and could drift.
 */
export function jsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}
