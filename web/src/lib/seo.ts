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
 * A TRADE'S TWO PAGES, AND THE ONE SPELLING THEY NOW ANSWER ON.
 *
 * THE STORED SLUG IS NOT A URL. `trades.ts` on the Worker keeps the value
 * already written on live operator rows — 'junk removal', 'mobile car wash and
 * detailing' — with the spaces in it, and that stored value is what the API
 * matches on. It is not what the address bar should hold. Every link in this
 * app used to mint these two paths with `encodeURIComponent(slug)`, which
 * produced /s/junk%20removal: unreadable in a result, unreadable in a pasted
 * link, and a different convention from the one /near/<place>/<trade> has
 * always used.
 *
 * The Worker settled it. `canonicalTradeSegment` in src/lib/seo.ts is
 * `tradeSlug(t.slug)` now and src/index.ts 301s the escaped spelling AT the
 * hyphenated one rather than away from it. So an `encodeURIComponent` link
 * from in here is no longer merely ugly — it is a needless round trip through
 * a redirect and a non-canonical URL sitting in the address bar of anyone who
 * follows it. These two mint the form the Worker canonicalises to; nothing in
 * this app should be spelling either path by hand.
 *
 * Both take the STORED slug, because that is what the catalogue and the
 * operator rows carry. Going the other way — URL segment back to stored slug —
 * is `storedTradeSlug` below.
 */
export const tradeHref = (storedSlug: string) => `/s/${tradeSlug(storedSlug)}`;
export const costHref = (storedSlug: string) => `/cost/${tradeSlug(storedSlug)}`;

/**
 * The stored slug behind a `/s/:trade` or `/cost/:trade` URL segment.
 *
 * The two pages compare the route parameter against `slot.trade`, hand it to
 * `api.tradeReviews` and look it up in the catalogue — all three of which want
 * the STORED value, spaces and all. Since the Worker started canonicalising to
 * the hyphenated form, the parameter usually is not that value, and taking it
 * at face value is why /s/junk-removal rendered "we do not have this trade" on
 * a direct load or a click from a search result while in-app navigation, which
 * happened to pass the stored spelling, kept working.
 *
 * So the segment is resolved THROUGH THE CATALOGUE, which is the only thing
 * either page has that knows the real stored values. Either spelling matches;
 * anything else falls through unchanged, so an actual typo still reaches the
 * "not listed" branch rather than being coerced into some trade near it.
 *
 * `trades` being null or undefined is the catalogue not having answered yet —
 * distinct from a catalogue that answered and does not hold this trade. The
 * segment is returned as-is meanwhile, and callers must key their effects on
 * the RESULT so that the answer re-fires the lookups when it lands.
 */
export function storedTradeSlug(
  segment: string,
  trades: readonly { slug: string }[] | null | undefined,
): string {
  const seg = (segment ?? '').trim().toLowerCase();
  if (!trades) return seg;
  for (const t of trades) {
    const stored = t.slug.trim().toLowerCase();
    if (stored === seg || tradeSlug(stored) === seg) return stored;
  }
  return seg;
}

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
