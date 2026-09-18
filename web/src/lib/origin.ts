/**
 * The one hostname the structured data in this app is allowed to name.
 *
 * Every graph this app emits has to spell absolute URLs — schema.org asks for
 * them — and the obvious source for one in a browser is
 * `window.location.origin`. That is wrong here, and wrong quietly. Each page
 * the Worker renders carries a `<link rel="canonical">` built from APP_URL, so
 * the moment the site answers on any other host — a preview deployment, the
 * *.workers.dev address, a staging domain, localhost — a breadcrumb built from
 * the live hostname names URLs that contradict the canonical sitting a few
 * lines above it in the same head. A crawler reading both is being told two
 * different things about what this page's address is, and it is under no
 * obligation to guess which of them we meant.
 *
 * So the origin is a constant, and it is production's. A preview deployment
 * then describes production, which is the right answer rather than a
 * shortcoming: a preview is not a site anybody should be indexing, its
 * canonical already says as much, and a graph that agrees with that canonical
 * is worth more than one that faithfully reports a hostname nobody will ever
 * search for.
 *
 * THIS MUST MATCH APP_URL IN wrangler.toml. That single value is where the
 * Worker's canonical, its og:url and its server-rendered breadcrumb URLs all
 * come from, and the two halves of one page must not disagree about the
 * address the page lives at. There is no way to import it across the wire —
 * the Worker's sources are not in the browser bundle — so it is written out
 * twice on purpose, the same way web/src/lib/seo.ts carries `tradeSlug`.
 */
export const SITE_ORIGIN = 'https://roundtheway.app';

/** An in-app path as the absolute URL schema.org asks for. */
export const absoluteUrl = (path: string): string =>
  `${SITE_ORIGIN}${path.startsWith('/') ? path : `/${path}`}`;
