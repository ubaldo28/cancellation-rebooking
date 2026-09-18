/**
 * The search-acquisition surface: pages that answer the query itself.
 *
 * Someone types "mobile detailing near me" or "junk removal Sherman Oaks".
 * Every competitor answers that with a lead form or a phone number. This site
 * can answer it with what is actually open, when, and what it costs — and that
 * is the only durable advantage it has. So these pages are built for that job
 * and nothing else: server-rendered, no JavaScript, no external requests, and
 * marked up so a crawler can read the availability and the price without
 * running anything.
 *
 * Two rules run through the whole file.
 *
 * 1. Nothing is invented. There are no reviews, no ratings, no customer
 *    counts, and no structured-data property that would imply any of them.
 *    Fabricated review markup is both a lie to the reader and a manual
 *    penalty, so the JSON-LD below carries only fields backed by a row in the
 *    database.
 * 2. A page with nothing on it does not ask to be indexed. The trade × place
 *    grid is combinatorially large and mostly empty; publishing the empty
 *    squares is how a new site gets classified as thin or doorway content.
 *    Empty combinations are noindex and are left out of the sitemap.
 *
 * This file renders. It does not route: index.ts wires every URL.
 */

import type { Env } from '../types';
import { LAUNCH_STATE, ZERO_DECIMAL, formatMoney, localeFor } from './countries';
import { CONTRACTOR_THRESHOLD_LABEL, TRADE_RULES, rulesFor } from './credentials';
import { costsFor } from './costfacts';
import { isDemoOperator } from './demo';
import { METROS, metroForPlace, metroPath, type Metro } from './metros';
import { getPublicProfile, type SimilarBusiness } from './profile';
import { mapData, type MapArea, type PublicSlot } from './public';
import { reviewsForTrade, type TradeReview } from './reviews';
import {
  ALL_TRADES, TRADE_CATEGORIES, categoryOf, tradeBySlug,
  tradeLabel as catalogueLabel,
  type Trade, type TradeCategory,
} from './trades';
import { formatLocal } from './tz';
import { escapeHtml, haversineMeters, now } from './util';

/** Used in <title>, og:site_name and the breadcrumb root. */
const SITE_NAME = 'Round The Way';

/**
 * The metros live in lib/metros.ts, and every page below reads that list.
 *
 * There used to be one name and one path here — `METRO = 'Los Angeles'` and
 * `METRO_PATH = '/los-angeles'` — read by about twenty call sites. That was
 * honest while the product was one city and wrong the instant it was two: a
 * Santa Maria neighbourhood page led up to a Los Angeles breadcrumb, and every
 * "the whole city" link pointed at the wrong city.
 *
 * So the rule now is: a page that describes ONE place takes its metro as an
 * argument, or resolves it from the neighbourhood it is about. A page that
 * describes the SITE enumerates METROS. Nothing in this file names a city.
 */

/** The metro links a site-wide "other ways in" list carries, in launch order. */
const metroLinks = (): Array<{ href: string; text: string }> =>
  METROS.map((m) => ({ href: metroPath(m), text: `Mobile services in ${m.name}` }));

/**
 * "Los Angeles and Santa Maria" — the site's footprint in a phrase.
 *
 * Only for pages describing Round The Way as a whole. A page about one place uses
 * that place's name and never this.
 */
function metroNames(): string {
  const names = METROS.map((m) => m.name);
  if (names.length < 2) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The metro a neighbourhood belongs to, given what the map already knows.
 *
 * The area carries coordinates, so a place lib/metros.ts has never heard of —
 * a real operator's own service area — still resolves to the nearest metro
 * rather than falling back to the launch one.
 */
const metroOf = (area: { slug: string; lat: number; lng: number }): Metro =>
  metroForPlace(area.slug, { lat: area.lat, lng: area.lng });

/**
 * The metro one business works in, decided by where most of its round is.
 *
 * A round that straddles two metros has to resolve to one of them for the
 * breadcrumb and the description, and the majority of its own service areas is
 * the only answer that is not a guess. An operator with no areas at all — or
 * none this file can place — falls back to whatever metroForPlace does, which
 * is the launch metro.
 */
export async function metroForOperator(env: Env, operatorId: string | null): Promise<Metro> {
  if (!operatorId) return metroForPlace('');
  const rows = await env.DB.prepare(
    `SELECT place_slug, lat, lng FROM service_areas
      WHERE operator_id = ? AND is_active = 1`,
  ).bind(operatorId).all<{ place_slug: string | null; lat: number; lng: number }>();

  const tally = new Map<string, { metro: Metro; n: number }>();
  for (const r of rows.results ?? []) {
    const m = metroForPlace(r.place_slug ?? '', { lat: r.lat, lng: r.lng });
    const seen = tally.get(m.slug);
    if (seen) seen.n += 1;
    else tally.set(m.slug, { metro: m, n: 1 });
  }
  const winner = [...tally.values()].sort((a, b) => b.n - a.n)[0];
  return winner?.metro ?? metroForPlace('');
}

/** A slot as mapData hands it back: placed in the neighbourhood it belongs to. */
type PlacedSlot = PublicSlot & { area_slug: string };

interface LiveIndex {
  areas: MapArea[];
  slots: PlacedSlot[];
}

const trimSlash = (u: string) => u.replace(/\/+$/, '');

/**
 * The env, plus the one thing about the request this file is allowed to know.
 *
 * src/index.ts puts the origin of the request being served on the env for the
 * length of that request. It is deliberately a field of its own rather than a
 * default for APP_URL, because APP_URL is what a sign-in link, an offer link
 * and the email gate are built from and those must never be assembled out of
 * a Host header somebody else typed. Nothing outside this file reads it.
 */
type SeoEnv = Env & { REQUEST_ORIGIN?: string };

/**
 * Base URL for canonicals and absolute links.
 *
 * APP_URL first, because it is the one hostname the deployment has been told
 * is its own. Where it is unset the request's own origin is used, and the
 * reason that beats the old behaviour is that the old behaviour was a RELATIVE
 * URL. A path-only canonical is legal; `Sitemap: /sitemap.xml` is not — the
 * sitemap protocol requires an absolute URL and consumers discard a line that
 * is not one — so a deploy without APP_URL published a sitemap reference
 * nothing could follow and a set of canonicals that said nothing on the day
 * the same content answered on two hostnames.
 *
 * The empty string remains the last resort, for a caller with neither.
 */
const baseUrlOf = (env: Env): string =>
  trimSlash(env.APP_URL?.trim() || (env as SeoEnv).REQUEST_ORIGIN?.trim() || '');

/** The same answer, for src/index.ts's sitemap and robots.txt routes. */
export const siteBase = (env: Env): string => baseUrlOf(env);

/**
 * One read of what is genuinely open, shared by every page here.
 *
 * mapData is the same call the public map makes, which is the point: the
 * sitemap, these pages and the map can never disagree about what exists. It
 * also places each opening in the neighbourhood the van is actually in, rather
 * than in every area its owner happens to cover.
 */
async function liveIndex(env: Env): Promise<LiveIndex> {
  const { areas, slots } = await mapData(env, null);
  return { areas, slots };
}

// ---------------------------------------------------------------------------
// Trade slugs
//
// Trade is free text on the operator record, so the canonical list is
// TRADE_RULES — the trades the app itself names. A slug that is not in it
// returns null instead of being coerced into a trade string, because guessing
// mints a URL for work nobody does, and a crawler will happily ask for a
// million of them.
// ---------------------------------------------------------------------------

/** 'mobile detailing' -> 'mobile-detailing'. Deterministic, round-trippable. */
export function tradeSlug(trade: string): string {
  return trade
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const TRADE_BY_SLUG = new Map<string, string>(
  Object.keys(TRADE_RULES).map((t) => [tradeSlug(t), t]),
);

/** 'mobile-detailing' -> 'mobile detailing'. null for anything unrecognised. */
export function tradeFromSlug(slug: string): string | null {
  return TRADE_BY_SLUG.get(slug.trim().toLowerCase()) ?? null;
}

/**
 * A trade in the words a customer is shown, sentence-cased.
 *
 * The words come from the catalogue in trades.ts, which is the one place that
 * decides what a trade is called: 'mobile car wash and detailing' is a stored
 * slug nobody should ever have to read, and it is shown as "Car wash and
 * detailing".
 *
 * This used to sentence-case the raw slug instead. That made the trade page
 * say "Car wash and detailing" — it goes through the catalogue — while the
 * trade-in-place page said "Mobile car wash and detailing", once inside the
 * same <section>, under a heading naming the trade one way and above two links
 * naming it the other. React then mounts over this HTML and renders the
 * catalogue label, so the words also changed under the reader on hydration.
 *
 * The sentence-casing stays on top, because a trade that is not in the
 * catalogue falls back to the stored string and that is lowercase.
 */
export function tradeLabel(trade: string): string {
  const t = catalogueLabel(trade);
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// ---------------------------------------------------------------------------
// Tile art
//
// THE ONE MAPPING FROM A TRADE TO ITS PICTURE, AND WHY IT IS HERE.
//
// Every tile that names a trade or a category now carries a drawing, and the
// tiles are rendered twice: by the React pages in web/src/pages and again by
// the server-rendered twins further down this file. A path built in each tree
// separately is exactly the drift test/two-trees.test.ts exists to catch --
// worse here than usual, because a wrong path is not a wrong sentence, it is a
// broken image on the front page and nothing at all in the logs.
//
// So the mapping is written ONCE, below, and both trees read this one copy:
//
//   * The Worker reads it directly. The pages in this file call `tradeArt` and
//     `categoryArt` where they render a row or a banner.
//   * The BROWSER reads it over the wire. `withArt` decorates the catalogue
//     that /api/trade-catalog and /api/public/trade-catalog already serve, so
//     every trade and every category arrives at the React pages carrying its
//     own image path, computed here, by the same function the server pages
//     used. No page under web/ spells one of these paths, and none could.
//
// That is the arrangement trades.ts already argues for over TRADE_CATEGORIES
// itself: "The Worker serves it to the browser rather than the browser holding
// its own copy, for the same reason." A picture is one more fact about a trade,
// so it travels the way the label and the hint already travel.
//
// The path is DERIVED, NOT TABULATED. It is `tradeSlug` of the stored slug --
// the same spelling that trade's own URL uses -- so there is no forty-row table
// for anybody to forget to add a row to. A trade added to the catalogue gets a
// path for free and immediately. What it does not get for free is a drawing,
// and test/art.test.ts fails loudly until somebody draws one, rather than
// letting a blank tile ship.
// ---------------------------------------------------------------------------

/**
 * The pixel size each picture is stored at.
 *
 * These are in the markup rather than only in a stylesheet because that is
 * where they do their job: an <img> with no width and height makes the page
 * reflow when the picture lands, which on a browse page of forty tiles means
 * the tile somebody is reaching for moves out from under their thumb. Both
 * trees put these two numbers on the element and let CSS scale it down.
 *
 * 500x500, SQUARE, WHICH IS THE SIZE AND SHAPE THE TILES ARE MADE FOR. The
 * reference marketplace serves a 500x500 source into a tile that measures
 * 225x290 CSS pixels and lets the browser crop it, and this site now does
 * exactly that: one square file per service, cropped to the tall tile by
 * `object-fit: cover`, and cropped again to a wide band where a category page
 * uses the same file as its header. One shape to produce, three places it
 * fits.
 *
 * Both pairs are the same number on purpose. A category's picture and a
 * trade's picture are the same kind of thing and are shown in the same tile;
 * the two pairs of constants stay separate only because both trees name them
 * separately and test/two-trees.test.ts pins them that way.
 */
export const TRADE_ART_W = 500;
export const TRADE_ART_H = 500;
export const CATEGORY_ART_W = 500;
export const CATEGORY_ART_H = 500;

/**
 * The drawing for one trade, by its STORED slug.
 *
 * Same input as `tradePath`: the value on operators.trade, spaces and all.
 * Nothing in either tree should be handing this a URL segment.
 */
export const tradeArt = (storedSlug: string): string =>
  `/art/trade/${tradeSlug(storedSlug)}.webp`;

/**
 * The drawing for one category, by its `key` -- or the neutral one, for null.
 *
 * Null is the front page's "Everything" tile, which is a real tile in the same
 * grid and needs a real picture. It is drawn as four blank cards rather than as
 * a pile of the other eight motifs, so that it says "all of it" without
 * claiming to be any one of them. The file is category/all.webp, and 'all' is
 * not a category key, so nothing can collide with it.
 */
export const categoryArt = (key: string | null): string =>
  `/art/category/${key === null ? 'all' : key.trim().toLowerCase()}.webp`;

/** One trade as the browser receives it: the catalogue's fields, plus the art. */
export interface ArtTrade extends Trade { art: string }

/** One category as the browser receives it. */
export interface ArtCategory {
  key: string;
  label: string;
  art: string;
  trades: ArtTrade[];
}

/**
 * The catalogue with every picture named on it, for the two endpoints that
 * serve it to the browser.
 *
 * New objects rather than a mutation. TRADE_CATEGORIES is a module-level
 * constant that half this codebase reads, and writing a field onto it from
 * inside a request handler is how a Worker isolate ends up serving something
 * that depends on which request happened to warm it.
 */
export function withArt(categories: readonly TradeCategory[]): ArtCategory[] {
  return categories.map((c) => ({
    key: c.key,
    label: c.label,
    art: categoryArt(c.key),
    trades: c.trades.map((t) => ({ ...t, art: tradeArt(t.slug) })),
  }));
}

/** What the two catalogue endpoints answer with. */
export interface CatalogPayload {
  categories: ArtCategory[];
  /**
   * The neutral drawing, which belongs to no category.
   *
   * The front page's tile grid ends with an "Everything" tile, and it is a real
   * tile in the same grid that needs a real picture. It has no row in the
   * catalogue to hang a path off, so the path travels here instead of being
   * written out in the React page — which would have been the one place in
   * either tree where a path to one of these files was spelled by hand, and
   * therefore the one place that could be wrong without anything noticing.
   */
  everything_art: string;
}

/** Both catalogue endpoints answer with exactly this, so their shapes match. */
export const catalogPayload = (categories: readonly TradeCategory[]): CatalogPayload => ({
  categories: withArt(categories),
  everything_art: categoryArt(null),
});

// ---------------------------------------------------------------------------
// The page shell
// ---------------------------------------------------------------------------

export interface SeoPageOptions {
  /** Goes in <title> verbatim; the site name is appended. */
  title: string;
  /** <meta name="description">. Clamped to a length a result snippet keeps. */
  description: string;
  /** Absolute where APP_URL is set, path-only otherwise. */
  canonical: string;
  /** Anything JSON-serialisable; emitted as one application/ld+json block. */
  jsonLd?: unknown;
  /**
   * Structured data that must survive React mounting over this page.
   *
   * `jsonLd` above is placed INSIDE `#root` on every route that is also a React
   * route, and that is deliberate: React empties the container on mount, so the
   * server's block is thrown away and the React page's own BreadcrumbList,
   * FAQPage and LocalBusiness nodes stand alone. Two of each would be worse
   * than one. See `intoShell`.
   *
   * THAT ARRANGEMENT SILENTLY DELETED THE BRAND, and the front page was the one
   * page it happened to. `homePage` is the only place the Organization and the
   * WebSite/SearchAction nodes are emitted anywhere in this repository, and
   * web/src/pages/Discover.tsx — the React half of `/` — emits no structured
   * data at all: no Crumbs, no graph, nothing. So the rule that protects the
   * other five spliced routes destroyed these two. A crawler that runs
   * JavaScript, which is the one that decides whether a brand gets a knowledge
   * panel or a sitelinks searchbox, found a front page with an empty head and
   * an empty `#root` graph.
   *
   * The fix is not to move every block back into the head — that would restore
   * the duplicate FAQPage and BreadcrumbList problem on the five routes where
   * React genuinely does re-emit them. It is to split the graph by who owns the
   * node: anything React re-emits stays in `#root` and is meant to be replaced,
   * and anything React does NOT re-emit goes here, into the head, where nothing
   * removes it. Adding a node here for a route whose React page also emits it
   * would put two of that node on the page, which is the defect this field is
   * carefully on the other side of.
   */
  headJsonLd?: unknown;
  /**
   * Defaults to FALSE — the opposite of page() in index.ts, which hardcodes
   * noindex,nofollow on everything it renders. That is correct for a one-time
   * offer link sent by SMS and fatal for a page whose whole purpose is to be
   * found. Callers opt out per page; nothing here opts out by accident.
   */
  noindex?: boolean;
  /** Rendered inside <main>. Already-escaped HTML. */
  body: string;
  /**
   * Neighbourhoods for the footer directory, counted in the same request that
   * rendered the body. Omitted where a page has not read the map, in which
   * case that column omits itself rather than printing a heading over nothing.
   */
  areas?: MapArea[];
  /**
   * The SPA's index.html, when this URL is also a React route.
   *
   * See `intoShell` for what is done with it and why.
   */
  shell?: string | null;
}

// ---------------------------------------------------------------------------
// Site chrome
//
// A static equivalent of SiteHeader.tsx and SiteFooter.tsx: the wordmark, a
// real search form, the four nav links, the four footer columns, the
// directory and the legal line. Written out here rather than imported because
// those are React components compiled into the browser bundle and this file
// runs in the Worker — but the contents are theirs, and the two are meant to
// say the same things. test/two-trees.test.ts holds them to it.
//
// Before this existed a visitor who arrived on a /near page from a search
// engine could leave it by exactly one link in the middle of a sentence. That
// is not a page belonging to a site; it is a leaflet.
// ---------------------------------------------------------------------------

/**
 * The bar at the top.
 *
 * The search box is a plain GET form at /search with one field named `q`,
 * which produces precisely the `/search?q=…` URL SiteHeader navigates to — so
 * it works with no JavaScript at all and lands on the same page it would have.
 *
 * "Browse" leads, as it does in SiteHeader, and it was missing here for longer
 * than anywhere else it could have been. These pages are the ones a stranger
 * arrives on from a search engine, which is the exact visitor SiteHeader's own
 * note says it exists for: without it a trade page offers a search box and a
 * way home, and going home is not what somebody does to find a list of
 * categories.
 */
/**
 * The bar, and the testing band above it.
 *
 * THE BAND IS THE SERVER-RENDERED TWIN of the one in SiteHeader.tsx and the
 * sentence is deliberately identical: these pages are what a crawler and a
 * person with no JavaScript get, and a cap that only the React tree admits to
 * is a cap that is hidden from exactly the visitors least able to find out any
 * other way. test/two-trees.test.ts pins the pair.
 *
 * The number in it is NEW_ACCOUNTS_PER_DAY in src/index.ts, which is what
 * actually refuses, and it is ONE bucket shared by both sides rather than one
 * each. Changing either without the other makes this a promise the Worker does
 * not keep.
 */
function siteHeader(): string {
  return `<a class="skip" href="#main">Skip to main content</a>
<p class="testing-band" role="note"><strong>In testing.</strong> A hundred
people can join each day — customers and businesses together. Once a day is
full, joining reopens the next morning.</p>
<header class="head"><div class="head-in">
<a class="wordmark" href="/">${escapeHtml(SITE_NAME)}</a>
<nav class="site-nav" aria-label="Main">
<a href="/browse">Browse</a>
<a href="/cost">Prices</a>
<a href="/a">Alert me</a>
<a href="/account">Your bookings</a>
<a href="/signin">Sign in</a>
<a class="solid" href="/join">List your van</a>
</nav>
</div></header>`;
}

/**
 * The four columns, with the same entries SiteFooter.tsx carries.
 *
 * A label with no page behind it is rendered as text, exactly as the React
 * footer renders it: linking those at `/` would be a footer quietly lying
 * about where a dozen of its own links go.
 *
 * FIVE OF THEM WERE STILL TEXT AFTER THE PAGES ARRIVED. About, Help centre,
 * Safety, Terms and Privacy all exist as React routes and are all links in
 * SiteFooter; here they stayed inert, so the surface a crawler and a visitor
 * with no JavaScript actually get was the one surface from which the legal
 * pages could not be reached at all. "How Round The Way works for pros" was worse
 * than inert — it pointed at /join, which is a different page.
 *
 * Terms and Privacy are deliberately not in a column: they are in the legal
 * line under the directory, which is where SiteFooter moved them and where
 * anybody looking for them looks first. test/two-trees.test.ts pins the two
 * footers together, because this is the second time they have drifted.
 */
const FOOT_COLUMNS: Array<{ heading: string; links: Array<{ label: string; href?: string }> }> = [
  {
    heading: 'Customers',
    links: [
      { label: 'How it works', href: '/' },
      { label: 'Browse services', href: '/browse' },
      { label: 'Cost guides', href: '/cost' },
      { label: 'Your bookings', href: '/account' },
      { label: 'Services near you', href: '/near' },
      { label: 'What is covered', href: '/covered' },
      { label: 'Alert me', href: '/a' },
    ],
  },
  {
    heading: 'Pros',
    links: [
      { label: 'How Round The Way works for pros', href: '/pros' },
      { label: 'List your business', href: '/join' },
      { label: 'Sign in', href: '/signin' },
    ],
  },
  {
    heading: 'Support',
    links: [
      { label: 'Help centre', href: '/help' },
      { label: 'Safety', href: '/safety' },
      { label: 'Terms of service', href: '/terms' },
      { label: 'Privacy policy', href: '/privacy' },
      { label: 'Notice at Collection', href: '/privacy' },
    ],
  },
];

/**
 * The line under the directory, the same one SiteFooter draws.
 *
 * The year is read off the clock rather than typed in, and "Notice at
 * Collection" points at the privacy page because that is where the notice is.
 * There is deliberately no "Do not sell or share my personal information":
 * Round The Way does neither, so the link would describe a choice that does not
 * exist. See the note in SiteFooter.tsx.
 */
/**
 * The three legal links, which live at the FOOT OF THE SUPPORT COLUMN rather
 * than in a line of their own — the shape the reference marketplace uses, and
 * the shape both footers were rebuilt to. Kept as its own constant because
 * test/two-trees.test.ts pins the pair of footers against it.
 */
const FOOT_LEGAL: Array<{ label: string; href: string }> = [
  { label: 'Terms of service', href: '/terms' },
  { label: 'Privacy policy', href: '/privacy' },
  { label: 'Notice at Collection', href: '/privacy' },
];

/**
 * Fourteen trades taken a row at a time across the categories, so the sample
 * in the footer is spread over the whole catalogue rather than being the first
 * category twice. Same rule as SiteFooter's `someTrades`, and deterministic,
 * so every page and every crawl sees the same fourteen links.
 */
function footerTrades(): Trade[] {
  const rows: Trade[] = [];
  for (let i = 0; rows.length < 14; i += 1) {
    const round = TRADE_CATEGORIES
      .map((c) => c.trades[i])
      .filter((t): t is Trade => Boolean(t));
    if (round.length === 0) break;
    rows.push(...round);
  }
  return rows.slice(0, 8);
}

/**
 * A trade's two pages, spelled the way a person would type them.
 *
 * THE STORED SLUG IS NOT A URL. `trades.ts` keeps the value already written on
 * live operator rows — 'mobile car wash and detailing', 'junk removal' — with
 * the spaces in it, and these paths used to be built with encodeURIComponent.
 * That made the canonical, the sitemap entry and every internal link to the
 * seventy-six highest-intent pages on the site read
 * /s/mobile%20car%20wash%20and%20detailing: unreadable in a result, unreadable
 * in a shared link, and a different convention from the one /near/<place>/
 * <trade> has always used. The site ran both at once and 301'd the readable
 * form away.
 *
 * So the hyphenated form is the canonical everywhere now, `tradeSlug` mints
 * it, and src/index.ts redirects the escaped spelling here rather than the
 * other way round. `tradeFromPathSegment` still accepts both, because the
 * escaped one is in the wild.
 */
const tradePath = (slug: string) => `/s/${tradeSlug(slug)}`;
const costPath = (slug: string) => `/cost/${tradeSlug(slug)}`;

function siteFooter(areas?: MapArea[]): string {
  const cols = FOOT_COLUMNS.map((c) => `<nav class="foot-col" aria-label="${
    escapeHtml(c.heading)}"><h2>${escapeHtml(c.heading)}</h2><ul>${
    c.links.map((l) => `<li>${l.href
      ? `<a href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a>`
      : `<span class="foot-soon">${escapeHtml(l.label)}</span>`}</li>`).join('')
  }</ul></nav>`).join('');

  /*
    THE DIRECTORY IS GONE, AND ON PURPOSE.

    It was three more columns under the four above: every category, eight
    trades and a dozen neighbourhoods, forty-odd links whose job was to give a
    crawler a path to the server-rendered pages. It did that, and it also made
    the foot of every page a wall nobody could read.

    Nothing became unreachable. /browse lists every category and every trade
    under it, /near lists every neighbourhood in every metro, and both are
    links in the columns above — so each of those pages is two hops from
    anywhere on the site rather than one, which is well inside what a crawler
    follows. The hubs carry the linking now, which is what hubs are for.

    `areas` is still taken as an argument because the callers pass it and the
    signature is pinned by test/two-trees.test.ts against SiteFooter's props.
  */
  void areas;

  /*
    THE ATTRIBUTION AND TRADEMARK LINES BELOW ARE SiteFooter.tsx's, WORD FOR
    WORD. The two trees cannot import each other, so they are written out
    twice; change one and change the other in the same commit.

    The two links in the attribution are part of the credit rather than
    decoration on it. The OpenStreetMap Foundation asks that the credit point
    at openstreetmap.org/copyright wherever the medium allows a link, and
    CC BY 4.0 asks the same of the licence itself — both only so far as it is
    reasonably practicable, which on an HTML page is entirely. What was here
    before said the right words and led nowhere, and these pages are the half
    of the site a visitor with no JavaScript gets, so it was the half where a
    reader had no other way to reach either licence.

    The trademark line is a notice and not a disclaimer: the vehicle picker
    prints Transit, Sprinter and ProMaster because those are what a van is
    called, and naming a product to say which product you mean is the ordinary
    use of somebody's mark. One sentence acknowledging who owns the names is
    the whole of what was missing.
  */
  return `<footer class="site-foot"><div class="foot-in">
<div class="foot-cols"><div class="foot-brand"><span class="foot-mark">Round The Way</span><p>Book someone round the way.</p><ul><li><a href="/about">About</a></li></ul></div>${cols}</div>
<div class="foot-legal">
<p><a href="/">${escapeHtml(SITE_NAME)}</a> lists appointments that local
businesses have free this week, at the price each one set. Openings appear when
a job is cancelled or a gap opens between two booked jobs, so these pages change
through the day.</p>
<p>Nothing here is verified by us. Licence and insurance details are what a
business says about itself; the issuing board's public register is the place to
check one.</p>
<p>Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors, tiles by OpenFreeMap.
Postcode centroids from GeoNames, <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>.</p>
<p>Vehicle makes and models named on this site are the trademarks of their
respective owners, and are used here only to describe vehicles.</p>
<p>Prices are set by the business doing the work.</p>
<p class="foot-fine"><span>© ${new Date().getFullYear()} ${escapeHtml(SITE_NAME)}</span><a href="/covered">What is covered</a></p>
</div>
</div></footer>`;
}

/**
 * Compact, self-contained CSS.
 *
 * Inline because an external stylesheet is a second request before the page
 * paints, and these pages are frequently a stranger's first impression over a
 * phone connection. Mobile first: everything reads at 320px, nothing scrolls
 * sideways. The palette is the React site's, restated rather than imported —
 * light ground, near-black ink with a blue cast, one green for what is open.
 *
 * WHY THIS IS A FUNCTION RATHER THAN A CONSTANT. Six of these pages are also
 * React routes, so their markup is delivered inside the SPA's own document
 * (see `intoShell`) and this sheet lands in a head that already holds the
 * app's stylesheet. Loose `body`, `h1` and `:root` rules there would outlive
 * the server markup they were written for — React replaces the content, not
 * the stylesheet — and would go on restyling the running app. Passing a scope
 * selector confines every rule, custom properties included, to the server
 * block. The empty scope is the standalone document, where the bare selectors
 * are the correct ones and nothing else is on the page to disturb.
 */
function styleSheet(scope = ''): string {
  const s = scope;                 // '' or '.sf-ssr'
  const root = s || ':root';
  const page = s || 'body';
  return `
${root}{color-scheme:light dark;
--bg:#f6f7f9;--surface:#fff;--ink:#0d1117;--ink-2:#2c3440;--muted:#5c6572;
--line:#e3e7ec;--line-2:#cdd4dd;
--accent:#005A9C;--accent-ink:#00477B;--accent-soft:#E3EFFA;--accent-line:#B4D2EC}
@media(prefers-color-scheme:dark){${root}{
--bg:#0b0f14;--surface:#131a22;--ink:#eef2f7;--ink-2:#c6ceda;--muted:#8d97a5;
--line:#1e2833;--line-2:#2b3846;
--accent:#4CB3F0;--accent-ink:#9FD5F7;--accent-soft:#0B2436;--accent-line:#1E4763}}
${s} *{box-sizing:border-box}
${s ? '' : 'html{-webkit-text-size-adjust:100%}'}
${page}{margin:0;background:var(--bg);color:var(--ink);
font:16px/1.6 'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
-webkit-font-smoothing:antialiased}
${s} .wrap{max-width:44rem;margin:0 auto;padding:20px 16px 64px}
${s} a{color:var(--accent-ink);text-underline-offset:2px}
@media(prefers-color-scheme:dark){${s} a{color:var(--accent)}}
${s} img{max-width:100%;height:auto}
${s} h1{font-size:1.55rem;line-height:1.22;letter-spacing:-.02em;margin:0 0 10px;
font-weight:700}
${s} h1 .count{display:block;font-size:1rem;font-weight:600;color:var(--accent-ink);
letter-spacing:0;margin-top:6px}
@media(prefers-color-scheme:dark){${s} h1 .count{color:var(--accent)}}
${s} h2{font-size:1.08rem;letter-spacing:-.01em;margin:32px 0 10px;font-weight:650}
${s} h3{font-size:.98rem;margin:18px 0 6px;font-weight:650}
${s} p{margin:0 0 12px}
${s} .crumb{font-size:.82rem;color:var(--muted);margin:0 0 14px}
${s} .crumb a{color:var(--muted)}
${s} .lede{color:var(--ink-2);font-size:1.02rem;margin-bottom:18px}
${s} .note{color:var(--muted);font-size:.9rem}
${s} .jump{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 8px;padding:0;list-style:none}
${s} .jump a{display:inline-block;padding:7px 12px;border:1px solid var(--line-2);
border-radius:999px;font-size:.86rem;text-decoration:none;background:var(--surface);
color:var(--ink-2)}
${s} .pricebar{margin:0 0 14px;padding:11px 14px;border:1px solid var(--accent-line);
border-radius:10px;background:var(--accent-soft)}
${s} .pricebar p{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 14px;margin:0}
${s} .pricebar b{font-size:1.2rem;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
${s} .pricebar-mid{font-weight:650;font-size:.9rem;color:var(--accent-ink)}
@media(prefers-color-scheme:dark){${s} .pricebar-mid{color:var(--accent)}}
${s} .pricebar-where{flex:1 1 100%;font-size:.84rem;color:var(--ink-2)}
/* Pinned only where the bar above it is a single row of known height. On a
   narrow screen it scrolls away with the rest of the page rather than sitting
   over the words on the screen with the least room to spare. */
@media(min-width:760px){${s} .pricebar{position:sticky;top:0;z-index:5}
${s} .pricebar-where{flex:0 1 auto}
${s} h2[id],${s} h3[id]{scroll-margin-top:8rem}}
/* The steps in "how booking one works". The number is drawn by the list's own
   counter rather than typed into the heading, so the words in the markup are
   the words a reader would say. */
${s} .steps{list-style:none;margin:0;padding:0;counter-reset:step;display:grid;
gap:16px}
${s} .steps li{counter-increment:step}
${s} .steps h3{margin:0 0 4px}
${s} .steps h3::before{content:counter(step);display:inline-flex;
align-items:center;justify-content:center;width:22px;height:22px;margin-right:8px;
border-radius:999px;background:var(--accent-soft);border:1px solid var(--accent-line);
color:var(--accent-ink);font-size:.78rem;font-weight:700;vertical-align:1px}
@media(prefers-color-scheme:dark){${s} .steps h3::before{color:var(--accent)}}
${s} .steps p{margin:0}
${s} .slots{list-style:none;margin:0 0 8px;padding:0;display:grid;gap:12px}
${s} .slot{background:var(--surface);border:1px solid var(--line);border-radius:12px;
padding:14px}
${s} .slot-top{display:flex;justify-content:space-between;align-items:baseline;gap:10px;
flex-wrap:wrap}
${s} .biz{font-weight:650}
${s} .price{font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
${s} .when{font-size:1.08rem;font-weight:650;letter-spacing:-.01em;margin:6px 0 2px}
${s} .what{color:var(--muted);font-size:.92rem;margin:0 0 10px}
${s} .near{display:inline-block;font-size:.82rem;font-weight:600;color:var(--accent-ink);
background:var(--accent-soft);border:1px solid var(--accent-line);
padding:3px 9px;border-radius:999px;margin:0 0 10px}
@media(prefers-color-scheme:dark){${s} .near{color:var(--accent)}}
${s} .sample{font-size:.82rem;color:var(--muted);border:1px dashed var(--line-2);
border-radius:8px;padding:7px 9px;margin:0 0 10px}
${s} .book{display:block;text-align:center;background:var(--accent);color:#fff;
text-decoration:none;font-weight:650;padding:11px 14px;border-radius:9px;min-height:44px}
@media(prefers-color-scheme:dark){${s} .book{color:#04140d}}
${s} .box{background:var(--surface);border:1px solid var(--line);border-radius:12px;
padding:16px;margin:0 0 8px}
${s} .links{list-style:none;margin:0;padding:0;display:grid;gap:2px}
${s} .links li{padding:2px 0}
/* A LINK ROW THAT CARRIES ITS TRADE'S DRAWING.
   Only the trade rows on /browse and /browse/:category get one; every other
   link list on every other page is untouched, which is why this is scoped to
   li.has-art rather than to .links li. The React pages draw the same rows
   with the same 75x45 slot and the same 8px corner, because a reader crossing
   from the crawler's copy of a page to the app's must not find the pictures a
   different size.

   The anchor becomes a flex row so the name sits beside its own picture rather
   than under it, and the picture never shrinks: below about 340px the space has
   to come out of the words, because a squeezed thumbnail is a coloured sliver
   and worse than either a full one or none at all. The width and height
   attributes on the element are what stop the page reflowing as the files
   land. */
${s} .links li.has-art a{display:flex;align-items:center;gap:12px}
${s} .link-art{flex:0 0 auto;width:75px;height:45px;border-radius:8px;
object-fit:cover}
/* The name, with its count stacked under it rather than trailing off the end
   of a row 45px tall. min-width:0 so a long trade name wraps inside the row
   instead of pushing the picture off the left edge.

   The UNDERLINE IS ON THE NAME AND NOT ON THE ANCHOR, which is why the name
   has a span of its own. A text-decoration set on the anchor propagates to
   everything inside it and cannot be cancelled further down, so the count
   under the name would be underlined too — and a count is not a second link.
   Every other row in every other link list on the site is an underlined name,
   so the name keeps its underline here: the picture beside it is decorative
   and is not what tells a reader that the row leads somewhere. */
${s} .links li.has-art a{text-decoration:none}
${s} .link-text{display:grid;gap:2px;min-width:0}
${s} .link-name{text-decoration:underline;text-underline-offset:2px}
${s} .link-text .note{font-size:.85rem}
/* THE CARD GRID, WHICH IS WHAT A LIST OF PICTURES ACTUALLY WANTS TO BE.
   Rules above draw one picture beside one name, which is a row; these turn the
   same markup into a grid of tiles, each with its picture across the top and
   its name under it, and the page scrolls down through them. That is the shape
   of every marketplace people already use, and it is what the owner asked for.

   Scoped to .links.cards — set by linkList only when every row has a picture
   — so the plain link lists on every other page are untouched. These come
   AFTER the row rules on purpose: same specificity, later wins, so the anchor
   goes from flex to block and the picture from a fixed 75x45 to the full width
   of its card. The ratio does not change, because the ratio is the file's.

   210px is the narrowest a tile gets before the names start wrapping to three
   lines; auto-fill takes the column count from the width, so a phone gets one
   or two and a desktop four or five, with no breakpoint to maintain. */
${s} .links.cards{display:flex;gap:14px;overflow-x:auto;padding:0 0 8px;
overscroll-behavior-x:contain;scroll-snap-type:x proximity;scrollbar-width:thin}
${s} .links.cards li{flex:0 0 200px;padding:0;scroll-snap-align:start}
${s} .links.cards li.has-art a{position:relative;display:block;width:100%;
aspect-ratio:225/290;overflow:hidden;border-radius:10px;background:var(--surface-2);
text-decoration:none}
${s} .links.cards .link-art{position:absolute;inset:0;width:100%;height:100%;
border-radius:0;object-fit:cover}
${s} .links.cards .link-text{position:absolute;inset:auto 0 0 0;display:block;
padding:44px 14px 13px;color:#fff;
background:linear-gradient(to top,rgba(0,0,0,.78),rgba(0,0,0,.42) 42%,rgba(0,0,0,0))}
${s} .links.cards .link-name{display:block;color:#fff;font-weight:700;
text-decoration:none;text-shadow:0 1px 3px rgba(0,0,0,.45)}
/* Two across on a phone rather than one: a 210px floor gives a single column
   at 375px, and one column of picture tiles is twice the scrolling for the
   same list. The app's sheets say the same thing at the same width. */
@media(max-width:560px){${s} .links.cards{gap:10px}
${s} .links.cards li{flex:0 0 43%}
${s} .links.cards .link-text{padding:36px 11px 11px}}
/* The category's own drawing, at the top of its page: the same picture as that
   category's tile on the front page, so pressing a tile lands somewhere that
   confirms it. Full width now rather than capped at 320px: the cards below it
   are pictures too, and a banner narrower than the grid under it reads as a
   badge that someone forgot to finish. */
${s} .banner-art{display:block;width:100%;height:auto;
aspect-ratio:3/1;max-height:240px;object-fit:cover;border-radius:14px;margin:0 0 14px}
/* THE PLAIN BULLETS, AND WHY THEY ARE NOT THE TICKS BELOW.
   Used for the self-reported facts on a profile, the questions to ask before a
   van arrives, and the ways a price can come down. A disc is a list marker and
   says nothing; a tick is an assertion that somebody checked, and every one of
   these is either the business's own claim or a question nobody here can
   answer. The distinction is the whole point of the pair. */
${s} .said{margin:0 0 12px;padding:0 0 0 20px;display:grid;gap:4px}
${s} .said li{padding:1px 0}
/* The counted facts, and the operator's own answer to their own work-location
   form. The mark is drawn by CSS rather than typed into the markup so that it
   never reaches a search result, a read-aloud pass or a copied paragraph as a
   character claiming something the words do not. */
${s} .ticks{list-style:none;margin:0 0 12px;padding:0;display:grid;gap:4px}
${s} .ticks li{padding-left:20px;position:relative}
${s} .ticks li::before{content:"";position:absolute;left:2px;top:.45em;width:9px;height:5px;
border-left:2px solid var(--accent-ink);border-bottom:2px solid var(--accent-ink);
transform:rotate(-45deg)}
@media(prefers-color-scheme:dark){${s} .ticks li::before{border-color:var(--accent)}}
/* Business hours, the three things a kerb has to have, and the cost factors:
   all three are a term and its answer, which is what a description list is. */
${s} .deflist{margin:0 0 14px;padding:0;display:grid;gap:8px}
${s} .deflist dt{font-weight:650}
${s} .deflist dd{margin:2px 0 0;color:var(--ink-2)}
/* The short answer at the top of a cost guide: the same figures as the page,
   restated in a box somebody can read in three seconds. */
${s} .key{background:var(--accent-soft);border:1px solid var(--accent-line);
border-radius:12px;padding:14px 16px 14px 18px;margin:0 0 14px}
${s} .key h2{margin:0 0 8px;font-size:1rem}
${s} .key ul{margin:0;padding-left:18px;display:grid;gap:6px}
/* A whole-row link into another page, with a sentence saying what is behind it
   rather than making somebody press it to find out. */
${s} .tile{display:flex;align-items:baseline;gap:10px;justify-content:space-between;
background:var(--surface);border:1px solid var(--line);border-radius:12px;
padding:14px;margin:14px 0;text-decoration:none;color:var(--ink)}
${s} .tile b{display:block;margin-bottom:2px}
${s} .tile span{color:var(--muted);font-size:.9rem}
/* The closing band on a page somebody has read to the bottom of. Not a "book
   now": on a quiet hour there is nothing to book, and the two things offered
   are the two that exist either way. */
${s} .cta{background:var(--surface);border:1px solid var(--line);border-radius:12px;
padding:16px;margin:24px 0 0}
${s} .cta h2{margin:0 0 8px}
${s} .stats{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 18px;padding:0;list-style:none}
${s} .stats li{background:var(--surface);border:1px solid var(--line);border-radius:10px;
padding:9px 13px;min-width:7.5rem}
${s} .stats b{display:block;font-size:1.2rem;letter-spacing:-.02em}
${s} .stats span{color:var(--muted);font-size:.82rem}
${s} .tbl-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:12px;
background:var(--surface);margin:0 0 12px}
${s} table{border-collapse:collapse;width:100%;min-width:28rem;font-size:.93rem}
${s} th,${s} td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);
vertical-align:top}
${s} tbody tr:last-child th,${s} tbody tr:last-child td{border-bottom:0}
${s} td.num,${s} th.num{text-align:right;font-variant-numeric:tabular-nums}
${s} details{background:var(--surface);border:1px solid var(--line);border-radius:10px;
padding:10px 13px;margin:0 0 8px}
${s} summary{font-weight:650;cursor:pointer}
${s} .testing-band{margin:0;padding:8px 20px;background:var(--accent-soft);
color:var(--accent-ink);border-bottom:1px solid var(--accent-line);
font-size:13px;line-height:1.45;text-align:center}
${s} .testing-band strong{font-weight:650}
${s} .head{background:#A5ACAF;border-bottom:1px solid rgba(0,0,0,.16)}
${s} .head-in{max-width:60rem;margin:0 auto;padding:10px 16px;display:flex;
flex-wrap:wrap;align-items:center;gap:10px}
${s} .wordmark{font-family:"Saira Stencil One",Impact,"Haettenschweiler",
"Arial Narrow Bold",sans-serif;font-weight:400;letter-spacing:.005em;
font-size:1.94rem;line-height:1;text-decoration:none;color:#005A9C}
${s} .site-search{display:flex;flex:1 0 100%;gap:6px;order:3}
@media(min-width:760px){${s} .site-search{flex:1 1 auto;order:0}}
${s} .site-search input{flex:1;min-width:0;padding:9px 12px;border-radius:9px;
border:1px solid var(--line-2);background:var(--bg);color:var(--ink);font:inherit;
font-size:.95rem}
${s} .site-search button{padding:9px 14px;border-radius:9px;border:1px solid var(--accent);
background:var(--accent);color:#fff;font:inherit;font-weight:650;cursor:pointer}
@media(prefers-color-scheme:dark){${s} .site-search button{color:#04140d}}
${s} .site-nav{display:flex;gap:8px;margin-left:auto;flex-wrap:wrap}
${s} .site-nav a{text-decoration:none;font-size:.9rem;font-weight:600;
border:1px solid rgba(0,0,0,.2);border-radius:999px;padding:7px 12px;color:#0E1A24}
${s} .site-nav a.solid{background:var(--accent);border-color:var(--accent);color:#fff}
@media(prefers-color-scheme:dark){${s} .site-nav a.solid{color:#04140d}}
${s} .skip{position:absolute;left:-9999px}
${s} .skip:focus{position:static;display:inline-block;padding:8px 12px}
${s} .site-foot{background:var(--surface);border-top:1px solid var(--line);
margin-top:48px;padding:28px 0 40px}
${s} .foot-in{max-width:60rem;margin:0 auto;padding:0 16px}
${s} .foot-cols{display:grid;gap:20px;grid-template-columns:repeat(2,minmax(0,1fr))}
@media(min-width:760px){${s} .foot-cols{grid-template-columns:repeat(4,minmax(0,1fr))}}
${s} .foot-brand{min-width:0}
${s} .foot-mark{display:block;font-weight:700;font-size:1.15rem;letter-spacing:-.01em;color:var(--ink)}
${s} .foot-brand p{margin:.25rem 0 0;color:var(--muted);font-size:.95rem}
${s} .foot-dir{display:grid;gap:20px;grid-template-columns:repeat(2,minmax(0,1fr));
margin-top:26px;padding-top:20px;border-top:1px solid var(--line)}
@media(min-width:760px){${s} .foot-dir{grid-template-columns:repeat(3,minmax(0,1fr))}}
${s} .foot-col h2{font-size:.82rem;text-transform:uppercase;letter-spacing:.06em;
color:var(--muted);margin:0 0 8px}
${s} .foot-col ul{list-style:none;margin:0;padding:0;display:grid;gap:5px}
${s} .foot-col a{font-size:.9rem;text-decoration:none;color:var(--ink-2)}
${s} .foot-soon{font-size:.9rem;color:var(--muted)}
${s} .foot-n{color:var(--muted);font-size:.8rem;margin-left:5px}
${s} .foot-legal{margin-top:24px;padding-top:16px;border-top:1px solid var(--line);
color:var(--muted);font-size:.82rem}
/* The legal line, as SiteFooter draws it. Underlined rather than merely
   coloured, because these sit on the same muted ink as the sentences around
   them; and 44px tall without a 44px pill, so the target extends above and
   below the text rather than boxing it. */
${s} .foot-fine{display:flex;flex-wrap:wrap;align-items:center;gap:2px 20px;margin:10px 0 0}
${s} .foot-fine a{display:inline-flex;align-items:center;min-height:44px;color:inherit;
text-decoration:underline;text-underline-offset:2px}
${s} .foot{margin-top:40px;padding-top:16px;border-top:1px solid var(--line);
color:var(--muted);font-size:.85rem}
${s} :focus-visible{outline:3px solid var(--accent);outline-offset:2px;border-radius:4px}
@media(prefers-reduced-motion:reduce){${s} *{animation-duration:.001ms!important;
animation-iteration-count:1!important;transition-duration:.001ms!important;
scroll-behavior:auto!important}}
`;
}

/**
 * How much of a <title> a result actually shows, site name included.
 *
 * Roughly sixty characters on a desktop result and less on a phone; past it
 * the tail is replaced with an ellipsis. The number is a guide rather than a
 * rule, which is why it is used to CHOOSE BETWEEN WORDINGS below rather than
 * to chop one.
 */
const TITLE_MAX = 60;

/**
 * The first of these titles that survives a result page whole.
 *
 * Every title here has ` | Round The Way` appended by `headTags`, and three
 * pages were writing one long enough that the truncation ate the words they
 * exist to rank for: "Car wash and detailing in Sherman Oaks, California"
 * lost the state and most of the site name, /near's title grew by the length
 * of a city name every time one opened, and a business page's title was the
 * business name alone with nothing in it a searcher could have typed.
 *
 * So each of those passes its preferred wording first and a shorter true one
 * after it. Nothing is invented to pad a short title and nothing is cut
 * mid-word: the last candidate is used whatever its length, because a title
 * that is too long is better than no title at all.
 */
function fitTitle(...candidates: string[]): string {
  const usable = candidates.filter((c) => c.trim() !== '');
  const fits = usable.find((c) => `${c} | ${SITE_NAME}`.length <= TITLE_MAX);
  return fits ?? usable[usable.length - 1] ?? SITE_NAME;
}

/** Keeps a description inside the length a result snippet actually shows. */
function clamp(s: string, n = 155): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n - 1).replace(/[\s,;:.\-]+$/, '')}…`;
}

/**
 * JSON-LD, escaped so page data can never close the script element.
 *
 * escapeHtml is wrong inside a script: &lt; is not < to a JSON parser, so the
 * block would fail to parse. Unicode-escaping the three dangerous characters
 * keeps it valid JSON and inert as markup.
 */
function jsonLdBlock(data: unknown): string {
  const s = JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
  return `<script type="application/ld+json">${s}</script>`;
}

/**
 * The head every page here shares, minus the stylesheet and the JSON-LD, which
 * are placed differently in the two modes below.
 */
function headTags(opts: SeoPageOptions): string {
  const title = `${opts.title} | ${SITE_NAME}`;
  const desc = clamp(opts.description);
  const robots = opts.noindex
    ? 'noindex,follow'
    : 'index,follow,max-image-preview:large,max-snippet:-1';
  const image = ogImageFrom(opts.canonical);

  return `<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(desc)}">
<meta name="robots" content="${robots}">
<link rel="canonical" href="${escapeHtml(opts.canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}">
<meta property="og:title" content="${escapeHtml(opts.title)}">
<meta property="og:description" content="${escapeHtml(desc)}">
<meta property="og:url" content="${escapeHtml(opts.canonical)}">
<meta property="og:image" content="${escapeHtml(image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${escapeHtml(SITE_NAME)} — trades that come to you">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(opts.title)}">
<meta name="twitter:description" content="${escapeHtml(desc)}">
<meta name="twitter:image" content="${escapeHtml(image)}">`;
}

/**
 * The picture a pasted link draws, as an absolute URL.
 *
 * Taken from the canonical rather than from a constant, because the canonical
 * is the one string here that already knows the real hostname. Where APP_URL
 * is unset the canonical is path-only by design (see baseUrlOf), and this
 * degrades to a path-only image with it — legal, ignored by some unfurlers,
 * and confined to a deployment that has not been told its own address.
 *
 * SUMMARY_LARGE_IMAGE, NOT SUMMARY. The card was the small variant with no
 * image at all, which is how a link to this site arrived in a text message as
 * a line of grey text beside a globe icon.
 */
function ogImageFrom(canonical: string): string {
  try {
    return new URL('/og.png', canonical).toString();
  } catch {
    return '/og.png';
  }
}

/**
 * PROGRESSIVE ENHANCEMENT, AND WHY IT RATHER THAN THE ALTERNATIVE.
 *
 * /s/:trade, /cost/:trade, /browse/:category and /p/:slug are React routes as
 * well as pages rendered here, so there are two ways to serve them: sniff the
 * user agent and hand a crawler the rendered page while a browser gets the SPA
 * shell, or send one document to everybody. The first is cloaking in the
 * literal sense — two different responses for one URL, chosen by who is
 * asking — and it is indefensible even when the two happen to say the same
 * thing today, because nothing keeps them saying it tomorrow and nobody would
 * notice if they diverged.
 *
 * So: one document, the same bytes for every request. The server-rendered
 * content goes inside the SPA's own `#root`, ahead of the app's script. A
 * crawler that runs no JavaScript reads it and stops there. A browser paints
 * it, then React mounts — `createRoot().render()` clears the container — and
 * the interactive page takes over from markup that already said the same
 * thing. Nobody is shown anything anybody else is not.
 *
 * Two placement details follow from that. The stylesheet is scoped to the
 * server block (see `styleSheet`) because it outlives the markup it styles.
 * The JSON-LD goes INSIDE `#root` rather than in the head, so that React
 * removes it on mount: the React pages emit their own FAQPage and
 * BreadcrumbList, and a head-mounted copy would leave a rendering crawler
 * looking at two of each.
 *
 * If the shell is not what we expect — no `#root`, or no assets binding at
 * all — this returns null and the caller falls back to the standalone
 * document, which is a page that works rather than a page that is blank.
 */
function intoShell(shell: string, head: string, content: string): string | null {
  const rootTag = /<div id="root">\s*<\/div>/;
  if (!rootTag.test(shell)) return null;

  const withHead = shell
    // The SPA's own title and description describe the front page. Two of
    // either is a page that answers "what is this" twice, differently.
    //
    // EVERY PATTERN HERE MATCHES THE ATTRIBUTE WHEREVER IT SITS IN THE TAG.
    // They used to require `name=` or `property=` to be the FIRST attribute —
    // `<meta\s+name="description"` — which is true of web/index.html as it is
    // written today and is not a property of HTML. Reordering one attribute in
    // that file, or a build step that rewrites these tags, would have left the
    // shell's own description or og:title in place with the Worker's appended
    // underneath it, which is exactly the duplicate this strip exists to stop
    // and would have failed silently. `\b` before the attribute name keeps
    // `property="og:…"` from matching something ending in it.
    .replace(/<title>[\s\S]*?<\/title>/i, '')
    .replace(/<meta\b[^>]*\bname="description"[^>]*>\s*/i, '')
    // AND THE SOCIAL TAGS, FOR THE SAME REASON AND A WORSE OUTCOME. Only the
    // title and the description used to be taken out, so the shell's og: and
    // twitter: tags survived and `headTags` appended a second set underneath
    // them. Every unfurler on the internet takes the FIRST of a duplicated
    // property, which is the shell's — so a link to /s/house-cleaning pasted
    // into a message drew the front page's title, the front page's
    // description and the front page's picture, on every one of the six
    // routes rendered into this document. Stripping them here is what makes
    // the Worker's the only ones on a page the Worker rendered.
    .replace(/<meta\b[^>]*\bproperty="og:[^"]*"[^>]*>\s*/gi, '')
    .replace(/<meta\b[^>]*\bname="twitter:[^"]*"[^>]*>\s*/gi, '')
    .replace(/<\/head>/i, `${head}\n</head>`);

  return withHead.replace(rootTag, `<div id="root">${content}</div>`);
}

/**
 * The shell every indexable page here uses.
 *
 * Standalone, this is one self-contained document: no script, no font request,
 * no image host, everything a crawler and a person need in the first response.
 * Given `shell`, the same content is delivered inside the SPA's document
 * instead — see `intoShell`.
 */
export function seoPage(opts: SeoPageOptions): string {
  const head = headTags(opts);
  const jsonLd = opts.jsonLd ? jsonLdBlock(opts.jsonLd) : '';
  // The nodes React does not re-emit, which therefore may not be inside #root.
  // See `headJsonLd` on SeoPageOptions for which nodes those are and why the
  // graph is split at all rather than placed in one block.
  const headLd = opts.headJsonLd ? jsonLdBlock(opts.headJsonLd) : '';
  const inner = `${siteHeader()}<div class="wrap"><main id="main">${opts.body}</main></div>${
    siteFooter(opts.areas)}`;

  if (opts.shell) {
    const merged = intoShell(
      opts.shell,
      `${head}${headLd ? `\n${headLd}` : ''}\n<style>${styleSheet('.sf-ssr')}</style>`,
      `<div class="sf-ssr">${inner}${jsonLd}</div>`,
    );
    if (merged) return merged;
  }

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
${/*
  NO FONT REQUEST, WHICH IS WHAT THE NOTE OVER seoPage HAS ALWAYS CLAIMED.

  There was a stylesheet link to fonts.googleapis.com here, four lines under a
  comment promising "no script, no font request, no image host". It cost these
  pages the one thing they have: a render-blocking request to a third party,
  on a document that is otherwise complete in the first response, so the
  fastest pages on the site waited on a DNS lookup, a TLS handshake and a
  redirect to fonts.gstatic.com before painting a single word — over a phone
  connection, for a stranger arriving from a search result.

  Nothing is lost but the exact face. The .wordmark rule in `styleSheet`
  already names Impact and two condensed fallbacks after "Saira Stencil One",
  so these pages draw the wordmark in a face that is already on the device.
  The React tree still loads the real one, and the pages spliced into its
  document (see `intoShell`) still get it — this branch is the standalone
  document, where there is nothing else on the page to wait for.
*/''}${head}
<style>${styleSheet()}</style>
${headLd}
${jsonLd}
</head><body>${inner}</body></html>`;
}

// ---------------------------------------------------------------------------
// Structured data
//
// Only properties with a row behind them. In particular: no aggregateRating,
// no review, no ratingValue, no reviewCount. There are no reviews on this
// platform, and marking up ratings that do not exist is a lie to the reader
// and a manual action waiting to happen.
//
// Sample listings are excluded from every graph below. They are labelled on
// the page so a person is not misled, but a demo business marked up as a
// LocalBusiness with a live Offer is fabricated inventory submitted to a
// search engine, which is a different and worse thing.
// ---------------------------------------------------------------------------

/** Major units for schema.org `price`, which is not denominated in cents. */
function priceAmount(cents: number, currency: string): string {
  const zero = ZERO_DECIMAL.has(currency.toUpperCase());
  return zero ? String(Math.round(cents)) : (cents / 100).toFixed(2);
}

const isoAt = (epochSeconds: number) => new Date(epochSeconds * 1000).toISOString();

/**
 * Where a page is about, in the three parts a PostalAddress needs.
 *
 * Joined into "Sherman Oaks, California" wherever a sentence needs it. The
 * region comes off the place's own metro record rather than out of
 * LAUNCH_STATE, which is the launch gate and not a fact about a neighbourhood.
 */
interface Locality {
  locality: string;
  region: string;
  /** ISO 3166-1 alpha-2, off the metro record. */
  country: string;
}

const localityName = (p: Locality) => `${p.locality}, ${p.region}`;

/**
 * A LOCALITY, A REGION AND A COUNTRY — AND NEVER A STREET LINE.
 *
 * Google will not produce a LocalBusiness rich result for a node with no
 * `address`, which is the single reason none of these pages could ever have
 * produced one. But a business on this site is a van: it has no premises, and
 * it has never given this product a street address for one. Inventing a
 * `streetAddress` to satisfy a validator would be filing a fact about
 * somebody's business that nobody here knows — the one thing this file refuses
 * everywhere else — so the address says exactly as much as is true, which is
 * the town, the state and the country the work happens in.
 */
function postalAddress(p: Locality): Record<string, unknown> {
  return {
    '@type': 'PostalAddress',
    addressLocality: p.locality,
    addressRegion: p.region,
    addressCountry: p.country,
  };
}

/**
 * The one name a business is known by across the whole graph.
 *
 * A published business is its own profile URL, which is the address a search
 * engine can fetch and reconcile with the LocalBusiness node rendered there.
 * One that has not published a page has no URL of its own, so it is named
 * against the page it appears on — still stable within the document, which is
 * all an `@id` has to be for `provider` and `seller` to resolve.
 */
function businessIdOf(
  s: Pick<PlacedSlot, 'profile_slug' | 'operator_id'>, pageUrl: string, base: string,
): string {
  return s.profile_slug ? `${base}/p/${s.profile_slug}` : `${pageUrl}#business-${s.operator_id}`;
}

/**
 * One business, as the graph node every offer of theirs points at.
 *
 * WHAT THIS REPLACES AND WHY IT WAS WORTH REPLACING. `offerLd` used to build an
 * anonymous `{'@type':'LocalBusiness', name}` twice per offer — once as
 * `provider`, once as `seller` — with no `@id`, no `address` and no `image`. On
 * a busy neighbourhood page that was two dozen address-less business nodes,
 * none of which could produce a result, several of them describing the same
 * business, and nothing in the document tying any of them to the profile page
 * that carries that business's reviews. One node per business, named by `@id`
 * and referenced from both places, is the same information a search engine can
 * actually use.
 */
function slotBusinessLd(
  s: PlacedSlot, place: Locality, pageUrl: string, base: string,
): Record<string, unknown> {
  const node: Record<string, unknown> = {
    '@type': 'LocalBusiness',
    '@id': businessIdOf(s, pageUrl, base),
    name: s.business_name,
    address: postalAddress(place),
    areaServed: { '@type': 'Place', name: localityName(place) },
  };
  if (s.profile_slug) node.url = `${base}/p/${s.profile_slug}`;
  // Their own picture or their own work, never a stand-in: a Product result
  // needs an image and an invented one would be a photograph of somebody
  // else's van.
  const key = s.avatar_key ?? s.work_photo_key;
  if (key) node.image = `${base}/api/public/photo/${encodeURIComponent(key)}`;
  return node;
}

function offerLd(s: PlacedSlot, place: Locality, pageUrl: string, base: string): unknown {
  // The business itself is a node of its own in the graph; this is a reference
  // to it. Two copies of the same business inline is how one business ends up
  // looking like several.
  const provider = { '@id': businessIdOf(s, pageUrl, base) };

  const service: Record<string, unknown> = {
    '@type': 'Service',
    name: s.service_name,
    provider,
    areaServed: { '@type': 'Place', name: localityName(place) },
  };
  if (s.trade) service.serviceType = tradeLabel(s.trade);

  return {
    '@type': 'Offer',
    name: `${s.service_name} — ${s.when}`,
    // The page, anchored at this opening: the booking URL is disallowed in
    // robots.txt (see robotsTxt below), so pointing the offer at it would name
    // a URL no crawler is allowed to fetch.
    url: `${pageUrl}#slot-${s.gap_id}`,
    price: priceAmount(s.price_cents, s.currency),
    priceCurrency: s.currency,
    availability: 'https://schema.org/InStock',
    // The offer stops being real the moment the slot starts.
    validThrough: isoAt(s.starts_at),
    itemOffered: service,
    seller: provider,
  };
}

function breadcrumbLd(base: string, trail: Array<{ name: string; url: string }>): unknown {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((t, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: t.name,
      item: `${base}${t.url}`,
    })),
  };
}

function pageLd(
  base: string,
  trail: Array<{ name: string; url: string }>,
  slots: PlacedSlot[],
  place: Locality,
  pageUrl: string,
): unknown {
  const real = slots.filter((s) => !s.is_sample);
  const graph: unknown[] = [breadcrumbLd(base, trail)];

  // Each business once, in the order it first appears, ahead of the offers
  // that reference it. A page listing four openings from one business used to
  // describe that business eight times over.
  const seen = new Set<string>();
  for (const s of real) {
    const id = businessIdOf(s, pageUrl, base);
    if (seen.has(id)) continue;
    seen.add(id);
    graph.push(slotBusinessLd(s, place, pageUrl, base));
  }

  if (real.length) {
    graph.push({
      '@type': 'ItemList',
      numberOfItems: real.length,
      itemListElement: real.map((s, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        item: offerLd(s, place, pageUrl, base),
      })),
    });
  }
  return { '@context': 'https://schema.org', '@graph': graph };
}

// ---------------------------------------------------------------------------
// Shared rendering
// ---------------------------------------------------------------------------

/**
 * One opening, as a list item. The server-rendered twin of
 * web/src/components/SlotCard.tsx, and every word a reader sees has to match
 * the word that card uses.
 *
 * `onTheirPage` says this list is on the business's own profile page. It
 * changes one thing and only for a sample: a sample's action is a link to that
 * profile, which on the profile itself is a link to the page you are reading.
 * SlotCard takes a prop of the same name for the same reason.
 */
function slotItem(s: PlacedSlot, onTheirPage = false): string {
  const who = s.profile_slug
    ? `<a href="/p/${escapeHtml(s.profile_slug)}">${escapeHtml(s.business_name)}</a>`
    : escapeHtml(s.business_name);
  const what = [s.service_name, s.trade ? tradeLabel(s.trade) : null]
    .filter((x): x is string => Boolean(x))
    .map((x) => escapeHtml(x))
    .join(' · ');

  return `<li class="slot" id="slot-${escapeHtml(s.gap_id)}">
<div class="slot-top"><span class="biz">${who}</span><span class="price">${escapeHtml(s.price)}</span></div>
<p class="when">${escapeHtml(s.when)}</p>
<p class="what">${what}</p>
${s.proximity ? `<p class="near">${escapeHtml(s.proximity)}</p>` : ''}
${s.is_sample ? `<p class="sample">Sample listing. This is example data used to show how the
page works, not a real business.</p>` : ''}
${s.is_sample
    ? /*
  A SAMPLE LISTING IS NOT OFFERED FOR BOOKING, HERE OR IN THE APP.

  The seeded businesses in src/lib/demo.ts are on the map so it is not blank
  before anybody has signed up, and until now every one of them carried the
  same button as a real opening. It went to the checkout, which ran to the
  pricing step and refused — priceOrder answers `sample_listing` for a gap
  belonging to a seeded operator. The paragraph directly above said the listing
  was not a real business while the button under it said See this opening, and
  a button beats a paragraph every time, because the button is the thing being
  pressed.

  So the action becomes the one destination that is honestly there: the
  business's own page, whose first paragraph says the same thing at greater
  length. There is no rel="nofollow" on it — /p/ is explicitly Allowed in
  `robotsTxt` below, unlike /book/ — and the sample profile pages are already
  kept out of the sitemap by the rules further down this file, so this link
  neither leads a crawler anywhere it may not go nor submits anything as
  inventory.

  A sample with no published page gets no action at all rather than a button
  that goes nowhere. Every business in demo.ts is seeded published and with a
  slug, so that branch guards against a shape we have not seen rather than
  anything a reader meets today.

  "See their page" is the phrase SlotCard.tsx uses in the same place, and the
  two have to stay identical: they are the same listing rendered twice and a
  reader who meets both must not think they are looking at two things.
*/
      (s.profile_slug && !onTheirPage
        ? `<a class="book" href="/p/${escapeHtml(s.profile_slug)}">See their page</a>`
        : '')
    : /*
  rel="nofollow" BECAUSE robots.txt DISALLOWS THIS EXACT PATH.

  /book/ is Disallowed in `robotsTxt` below, for good reasons set out there:
  the checkout needs JavaScript and the slot is gone the moment somebody takes
  it. But this is the most prominent link on every listing, and a page whose
  strongest internal links all point into a disallowed directory is a page
  spending its whole crawl allowance on addresses no crawler may fetch —
  Search Console reports them as "blocked by robots.txt" and the link equity
  they carry goes nowhere. The offer markup already avoids naming this URL for
  the same reason. This is the other half of that.

  It stays a plain, working link for a person; nofollow is a statement to a
  crawler and nothing else.
*/
      `<a class="book" rel="nofollow" href="/book/${escapeHtml(s.gap_id)}">See this opening</a>`}
</li>`;
}

/**
 * The cheapest genuine opening.
 *
 * "From $89" in a title tag is a claim, so it may never come from a sample
 * listing. MapArea.from_price is the cheapest of everything on the map,
 * samples included — right for a map pin, wrong for a search snippet.
 */
function cheapestReal(slots: PlacedSlot[]): PlacedSlot | null {
  return slots.filter((s) => !s.is_sample)
    .reduce<PlacedSlot | null>((b, s) => (!b || s.price_cents < b.price_cents ? s : b), null);
}

/** The genuine opening that comes first. Same reason as cheapestReal. */
function soonestReal(slots: PlacedSlot[]): PlacedSlot | null {
  return slots.filter((s) => !s.is_sample)
    .reduce<PlacedSlot | null>((b, s) => (!b || s.starts_at < b.starts_at ? s : b), null);
}

/**
 * The arrow is not decoration. `slots.map(slotItem)` would hand `slotItem` the
 * array index as its second argument, so every item after the first would be
 * rendered as though it were on the business's own page — which is exactly the
 * sort of thing a second parameter with a default quietly does to a `.map`.
 */
const slotList = (slots: PlacedSlot[], onTheirPage = false) =>
  `<ul class="slots">${slots.map((s) => slotItem(s, onTheirPage)).join('')}</ul>`;

/** Groups by trade, most-open first, so the busiest work leads the page. */
function byTrade(slots: PlacedSlot[]): Array<{ trade: string | null; slots: PlacedSlot[] }> {
  const groups = new Map<string, PlacedSlot[]>();
  for (const s of slots) {
    const key = (s.trade ?? '').trim().toLowerCase();
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .map(([trade, list]) => ({ trade: trade === '' ? null : trade, slots: list }))
    .sort((a, b) => b.slots.length - a.slots.length
      || (a.trade ?? '').localeCompare(b.trade ?? ''));
}

/**
 * Neighbouring places, nearest first.
 *
 * Distance from the area's own pin, not from the visitor — this is a link
 * graph, not a search result, and it has to be the same for everyone so a
 * crawler sees a stable page.
 */
function nearbyAreas(all: MapArea[], here: MapArea, limit = 8): MapArea[] {
  return all
    .filter((a) => a.slug !== here.slug)
    .map((a) => ({ a, d: haversineMeters(here, a) }))
    .sort((x, y) => x.d - y.d)
    .slice(0, limit)
    .map((x) => x.a);
}

/**
 * When a place is empty, say when it last had something.
 *
 * The alternative — an empty shell that says "no results" — tells a visitor
 * the site is broken rather than that the neighbourhood is quiet, and gives a
 * crawler a page with nothing on it.
 *
 * THE DATE IS WRITTEN IN THE PAGE'S LANGUAGE, NOT THE OPERATOR'S, and that is
 * a correction rather than a preference. This selected `o.language` and passed
 * it to `localeFor`, so the month name came out in whatever language the
 * business that last had an opening here works in. `operators.language` is a
 * real column with a real job — lib/messages.ts texts and emails a client in
 * the language their business chose, and 'es' is one of two supported values —
 * so on a page reading "The most recent opening here was" the sentence would
 * have finished "sáb, 6 sept, 09:00", inside a document this file serves as
 * `<html lang="en">`, in a paragraph whose every other word is English.
 *
 * That is worse here than it looks. There are no translated URLs on this site
 * and so no hreflang to declare: every indexable page is the English one, and
 * a stray Spanish fragment in it is not a Spanish page a Spanish-speaking
 * searcher could be sent to — it is a language signal contradicting the
 * document's own declaration, in the one sentence a quiet neighbourhood page
 * has. The country still decides the conventions, because the date order and
 * the clock are facts about where the work happens; only the words follow the
 * page.
 *
 * The `when` on every slot card has the same shape of problem and is NOT fixed
 * here: lib/public.ts formats it once for the map, the JSON API and these
 * pages together, and changing it for all three from inside this file is not
 * this function's call to make.
 */
async function lastOpeningIn(env: Env, placeSlug: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT g.starts_at AS starts_at, o.timezone AS timezone,
            o.country AS country
       FROM gaps g
       JOIN operators o ON o.id = g.operator_id
       JOIN service_areas a ON a.operator_id = o.id AND a.is_active = 1
      WHERE a.place_slug = ? AND g.starts_at < ?
      ORDER BY g.starts_at DESC
      LIMIT 1`,
  ).bind(placeSlug, now()).first<{
    starts_at: number; timezone: string; country: string;
  }>();
  if (!row) return null;
  return formatLocal(row.starts_at, row.timezone, localeFor(row.country, 'en'));
}

/**
 * A public URL may be either the shared neighbourhood key or one business's
 * own area slug ('sherman-oaks-2'), because /near/:slug has always accepted
 * both. Everything here canonicalises to the neighbourhood key.
 */
async function resolvePlace(env: Env, idx: LiveIndex, slug: string): Promise<MapArea | null> {
  const key = await canonicalPlaceSlug(env, slug);
  if (!key) return null;
  return idx.areas.find((a) => a.slug === key) ?? null;
}

/**
 * The one address a neighbourhood's pages answer on.
 *
 * FOUR LIVE COPIES OF ONE PAGE, AND THAT IS BEFORE THE TRADES. `resolvePlace`
 * accepts the shared neighbourhood key AND one business's own area slug, and
 * the router's pattern allows a trailing slash — so /near/sherman-oaks,
 * /near/sherman-oaks/, /near/sherman-oaks-2 and /near/sherman-oaks-2/ were
 * four 200s of the same content, multiplied by every trade open there. Every
 * one of them carried the same canonical, which is the tag's job and is also
 * the weakest form of it: a canonical is a hint a search engine may ignore,
 * and until it is believed the crawl budget is being spent four times over on
 * one page. /s/<trade> already 301s its second spelling; this is what lets
 * src/index.ts do the same here.
 *
 * The slug is lower-cased on the way in because place slugs are lower case and
 * SQLite's `=` is not: /near/Sherman-Oaks used to find nothing and answer 404
 * with a JSON body.
 */
export async function canonicalPlaceSlug(env: Env, slug: string): Promise<string | null> {
  const want = (slug ?? '').trim().toLowerCase();
  if (!want) return null;
  const row = await env.DB.prepare(
    // The ORDER BY is what makes a slug that is ALREADY the neighbourhood key
    // resolve to itself. Without it, an operator whose own area slug happens
    // to equal another neighbourhood's key could win the LIMIT 1 and send
    // /near/encino off to somewhere else entirely.
    `SELECT place_slug FROM service_areas
      WHERE (place_slug = ? OR slug = ?) AND is_active = 1
      ORDER BY (place_slug = ?) DESC
      LIMIT 1`,
  ).bind(want, want, want).first<{ place_slug: string | null }>();
  return row?.place_slug ?? null;
}

// ---------------------------------------------------------------------------
// Internal linking
//
// This is most of what makes a set of pages rank, and it is deliberate rather
// than decorative. The shape is a hub and spoke, built twice over:
//
//   /near/<place>                    the hub for a neighbourhood
//     -> /near/<place>/<trade>       every trade with something open here
//     -> /near/<other place>         the nearest neighbourhoods
//
//   /near/<place>/<trade>            the spoke, and the page a query matches
//     -> /near/<place>               back to its hub
//     -> /near/<other>/<trade>       the same trade either side of it
//     -> /near/<place>/<other trade> the other work open here
//     -> /p/<business>               the business's own page, when published
//
// Three consequences are the whole reason for it. Every page is reachable from
// every other in two hops, so a crawler that finds one finds all of them. The
// anchor text is the query — "Mobile detailing in Encino" — rather than "click
// here". And a page that has nothing on it is never linked to from a page that
// does, so the crawl budget lands on the pages worth ranking.
// ---------------------------------------------------------------------------

/**
 * A list of links, optionally with a tile drawing at the head of each row.
 *
 * `img` IS THE PATH FROM `tradeArt`, AND IT IS ONLY EVER PASSED ON THE TRADE
 * ROWS OF THE TWO BROWSE PAGES. Those are the rows the React pages in
 * web/src/pages draw with a picture, and this is their server-rendered twin —
 * a picture in one tree and a bare row in the other is precisely the drift
 * test/two-trees.test.ts exists to catch. Every other caller passes no `img`
 * and emits exactly the markup it always did, because a neighbourhood, a metro
 * and a legal page have no drawing and are not getting one.
 *
 * The <img> goes INSIDE the anchor, so the picture is part of the same tap
 * target as the name — outside it, the one part of the row a thumb is most
 * likely to land on would be the one part that does not navigate. The `sub`
 * name comes inside the anchor on these rows and only these, so it can be
 * written across the foot of the picture: one picture, one name, and nothing
 * else on the tile. That is also the shape web/src/pages/BrowseIndex.tsx
 * renders, where the whole tile has always been the link. Rows with no picture
 * are untouched and keep the plain anchor-then-note they have always had.
 *
 * alt IS EMPTY, DELIBERATELY. The row's own text is the trade's name, right
 * beside the drawing and inside the same link; a description in the alt would
 * be that name read out twice in a row. Empty and not absent: with no alt at
 * all a screen reader falls back to reading out the file name.
 *
 * width and height are always set, from TRADE_ART_W/H, so the row has its
 * final height before the file arrives. Without them a page of forty rows
 * grows as the pictures land, and the row somebody is reaching for moves out
 * from under their thumb mid-tap. Lazy because only three or four of these
 * rows are on screen at once, wherever the reader is on the page.
 */
function linkList(
  items: Array<{ href: string; text: string; sub?: string; rel?: string; img?: string }>,
): string {
  if (!items.length) return '';
  // A LIST WHERE EVERY ROW HAS A PICTURE IS A GRID OF CARDS, NOT A COLUMN OF
  // ROWS. That is /browse and /browse/:category and nothing else here: every
  // other link list on the site is names without pictures, and keeps the
  // column it has always had. The class is decided from the items rather than
  // passed in, so the two pages that carry pictures cannot end up disagreeing
  // about whether they are cards, and a caller that starts passing `img` gets
  // the cards with it. web/src/styles-index.css (.ix-cards) and
  // web/src/styles-category.css (.cat-cards) are the app's copy of the same
  // decision, on the same rows.
  const cards = items.every((i) => i.img);
  return `<ul class="links${cards ? ' cards' : ''}">${items.map((i) => {
    const open = `<li${i.img ? ' class="has-art"' : ''}><a href="${escapeHtml(i.href)}"${
      i.rel ? ` rel="${escapeHtml(i.rel)}"` : ''}>`;
    const note = i.sub ? `<span class="note">${escapeHtml(i.sub)}</span>` : '';
    if (!i.img) return `${open}${escapeHtml(i.text)}</a>${i.sub ? ` ${note}` : ''}</li>`;
    // A TILE CARRIES THE NAME AND NOTHING ELSE, so `sub` is dropped here even
    // when a caller passes one. The count it used to print sat under the
    // picture on every tile, which made a page of forty tiles repeat "None
    // open right now" forty times; the same count is still printed once per
    // category in the heading above the grid, and per trade on the trade's own
    // page. The plain branch above still prints it, because a plain row is a
    // line of text and a note beside it reads as part of that line.
    return `${open}<img class="link-art" src="${escapeHtml(i.img)}" alt="" width="${
      TRADE_ART_W}" height="${TRADE_ART_H}" loading="lazy" decoding="async"><span class="link-text">`
      + `<span class="link-name">${escapeHtml(i.text)}</span></span></a></li>`;
  }).join('')}</ul>`;
}

/** The trades open in one place that have a canonical page to link to. */
function linkableTrades(slots: PlacedSlot[]): Array<{ trade: string; n: number }> {
  return byTrade(slots)
    .filter((g): g is { trade: string; slots: PlacedSlot[] } =>
      g.trade !== null && tradeFromSlug(tradeSlug(g.trade)) !== null)
    .map((g) => ({ trade: g.trade, n: g.slots.length }));
}

// ---------------------------------------------------------------------------
// 1. Everything open in one neighbourhood
// ---------------------------------------------------------------------------

export async function neighbourhoodPage(env: Env, placeSlug: string): Promise<string | null> {
  const base = baseUrlOf(env);
  const idx = await liveIndex(env);
  const place = await resolvePlace(env, idx, placeSlug);
  if (!place) return null;                       // caller 404s; nothing is minted

  const url = `${base}/near/${place.slug}`;
  const mine = idx.slots.filter((s) => s.area_slug === place.slug);
  const groups = byTrade(mine);
  // The state comes off the neighbourhood's own metro rather than off
  // LAUNCH_STATE, which is a launch gate and not a fact about this place.
  const metro = metroOf(place);
  const locality: Locality = {
    locality: place.name, region: metro.state, country: metro.country,
  };
  const where = localityName(locality);
  const whereSafe = escapeHtml(where);
  // What is genuinely on this page, as opposed to what is on it to show a
  // visitor the shape of the thing. It decides whether this asks to be indexed
  // and whether the sitemap offers it; see the note over `noindex` below.
  const realHere = mine.filter((s) => !s.is_sample);

  const jump = linkableTrades(mine);
  const jumpNav = jump.length
    ? `<ul class="jump">${jump.map((t) => `<li><a href="/near/${
        escapeHtml(place.slug)}/${escapeHtml(tradeSlug(t.trade))}">${
        escapeHtml(tradeLabel(t.trade))} (${t.n})</a></li>`).join('')}</ul>`
    : '';

  const sections = groups.map((g) => {
    const label = g.trade ? tradeLabel(g.trade) : 'Other work';
    const anchor = g.trade ? tradeSlug(g.trade) : 'other';
    const canonicalTrade = g.trade ? tradeFromSlug(tradeSlug(g.trade)) : null;
    const more = canonicalTrade
      ? `<p class="note"><a href="/near/${escapeHtml(place.slug)}/${
          escapeHtml(tradeSlug(canonicalTrade))}">${escapeHtml(label)} in ${
          escapeHtml(place.name)}</a> — prices, times and how these open up.</p>`
      : '';
    return `<section><h2 id="${escapeHtml(anchor)}">${escapeHtml(label)} in ${
      escapeHtml(place.name)}</h2>${slotList(g.slots)}${more}</section>`;
  }).join('');

  // Nothing open. Say what is true, not "no results".
  let empty = '';
  if (!mine.length) {
    const last = await lastOpeningIn(env, place.slug);
    empty = `<div class="box">
<p>${last
      ? `Nothing is open in ${escapeHtml(place.name)} right now. The most recent
         opening here was ${escapeHtml(last)}.`
      : `Nothing is open in ${escapeHtml(place.name)} yet.`}</p>
<p class="note">Openings appear when a job is cancelled or a gap opens between
two booked jobs, so this page is worth checking again later in the day. It is
not a waiting list and there is nothing to sign up for here.</p>
</div>`;
  }

  const nearby = nearbyAreas(idx.areas, place);
  const nearbyLinks = linkList(nearby.map((a) => ({
    href: `/near/${a.slug}`,
    text: `Open appointments in ${a.name}`,
    sub: a.slot_count ? `${a.slot_count} open` : undefined,
  })));

  const tradeNames = jump.map((t) => t.trade);
  const fromPrice = cheapestReal(mine)?.price ?? null;
  const lede = mine.length
    ? `${mine.length} appointment${mine.length === 1 ? '' : 's'} open in ${whereSafe} over
       the next ten days${tradeNames.length
         ? `, across ${tradeNames.length} kind${tradeNames.length === 1 ? '' : 's'} of work`
         : ''}. Each one is a real gap in a working day, at the price the
       business set for it.${fromPrice
         ? ` From ${escapeHtml(fromPrice)}.`
         : ''}`
    : `No appointments are open in ${whereSafe} at the moment.`;

  /*
    THE SNIPPET COUNTS REAL OPENINGS ONLY, for the reason `cheapestReal` gives
    two hundred lines up: a figure in a meta description is a claim made
    outside the page, where the "sample listing" label sitting beside it on the
    card cannot follow. `mine.length` is every opening including the seeded
    ones, so a neighbourhood holding nothing but demo data advertised itself in
    a search result as "6 appointments open in Encino, California".

    That mattered less while this page was the only surface with the problem —
    it is noindex with no real inventory, so the description was rarely used —
    and it matters now, because the same sentence is written the moment one
    genuine opening appears beside five seeded ones and the count would still
    have been six. The lede on the page keeps counting everything; each card
    below it carries its own label.
  */
  const description = realHere.length
    ? `${realHere.length} appointments open in ${where}: ${
        tradeNames.slice(0, 3).map(tradeLabel).join(', ') || 'local services'}. `
      + `Real times and real prices, ${fromPrice ? `from ${fromPrice}, ` : ''}`
      + `booked without a phone call.`
    : `What is open in ${where} right now, with the time and the price. `
      + `Openings appear when a job is cancelled or a gap opens in the day.`;

  // The other half of the cross-link the brief asks for: a place page names
  // the trades open in it, and each of those names goes to that trade's own
  // page as well as to the trade-in-this-place one above. Only trades in the
  // catalogue, because only those have a /s/ page to reach.
  //
  // The anchor says "everywhere Round The Way covers" rather than naming this
  // metro, because that is what a /s/ page is: it counts every opening on the
  // site, in both metros. Naming one of them here would have been the same
  // untruth the METRO constant used to tell.
  const siteWide = linkList(jump
    .map((t) => ({ t, cat: tradeBySlug(t.trade) }))
    .filter((x): x is { t: { trade: string; n: number }; cat: Trade } => x.cat !== null)
    .map((x) => ({
      href: tradePath(x.cat.slug),
      text: `${x.cat.label} everywhere ${SITE_NAME} covers`,
      sub: `${x.t.n} of them here`,
    })));

  const body = `
<p class="crumb"><a href="/">${escapeHtml(SITE_NAME)}</a> › <a href="${
    escapeHtml(metroPath(metro))}">${escapeHtml(metro.name)}</a> › ${escapeHtml(place.name)}</p>
<h1>Open appointments in ${escapeHtml(where)}</h1>
<p class="lede">${lede}</p>
${jumpNav}
${empty}
${sections}
<section>
<h2>Nearby</h2>
${nearbyLinks || '<p class="note">No other neighbourhoods are covered yet.</p>'}
<p class="note"><a href="/near">Every neighbourhood Round The Way covers</a> ·
<a href="${escapeHtml(metroPath(metro))}">${escapeHtml(metro.name)}</a></p>
</section>
${siteWide ? `<section>
<h2>The same work elsewhere</h2>
${siteWide}
</section>` : ''}`;

  return seoPage({
    // "Open appointments in Sherman Oaks, California" and the site name still
    // fit; the county-long names are what the shorter candidate is for.
    title: fitTitle(`Open appointments in ${where}`, `Open appointments in ${place.name}`),
    description,
    canonical: url,
    /*
      INDEXABLE ONLY WHILE THERE IS SOMETHING REAL ON IT.

      This used to be a flat `false`, defended as "a neighbourhood is a real,
      bounded place". So it is — and a page about it that renders a heading,
      the sentence "No appointments are open", and two blocks of navigation is
      still a page with nothing on it, and there are dozens of them. Worse, a
      neighbourhood holding nothing but seeded sample listings declared itself
      indexable while every business named on it was one we invented.

      The test is the same one /near/<place>/<trade> and /p/<slug> have always
      used: real, non-sample inventory. `sitemapXml` applies it too, so the
      sitemap and the page agree about which of these are worth fetching —
      submitting a URL that answers noindex is a contradiction a search engine
      counts against the whole file.
    */
    noindex: realHere.length === 0,
    jsonLd: pageLd(base, [
      { name: SITE_NAME, url: '/' },
      { name: metro.name, url: metroPath(metro) },
      { name: place.name, url: `/near/${place.slug}` },
    ], mine, locality, url),
    body,
    areas: idx.areas,
  });
}

// ---------------------------------------------------------------------------
// 2. One trade, one neighbourhood — the shape of the query itself
// ---------------------------------------------------------------------------

/** Customer-facing licensing, derived from the same rules the operator sees. */
function licenceNote(trade: string): string {
  const rule = rulesFor(trade);
  if (rule.license === 'required') {
    return `California licenses this work through the ${
      escapeHtml(rule.authority_name ?? 'relevant state board')}. Ask for a licence
      number and check it in that board's public register — nothing on this site
      verifies one.`;
  }
  if (rule.license === 'over_threshold') {
    return `In California this is contractor work once a single job is worth more
      than ${escapeHtml(CONTRACTOR_THRESHOLD_LABEL)} in labour and materials
      together, and a contractor's licence is required above that. Below it a
      business may work unlicensed but has to say so. Nothing on this site
      verifies a licence.`;
  }
  return `No California state licence is generally required for this work.
    Anything a business tells you about its own licensing or insurance is its
    own claim; nothing on this site verifies it.`;
}

export async function tradeInPlacePage(
  env: Env, placeSlug: string, tradeSlugIn: string,
): Promise<string | null> {
  const trade = tradeFromSlug(tradeSlugIn);
  if (!trade) return null;                       // unknown slug: never guessed

  const base = baseUrlOf(env);
  const idx = await liveIndex(env);
  const place = await resolvePlace(env, idx, placeSlug);
  if (!place) return null;

  const slug = tradeSlug(trade);
  const url = `${base}/near/${place.slug}/${slug}`;
  const label = tradeLabel(trade);
  const metro = metroOf(place);
  const locality: Locality = {
    locality: place.name, region: metro.state, country: metro.country,
  };
  const where = localityName(locality);
  const here = idx.slots.filter((s) => s.area_slug === place.slug);
  const mine = here.filter((s) => (s.trade ?? '').trim().toLowerCase() === trade);
  const real = mine.filter((s) => !s.is_sample);

  const cheapest = cheapestReal(mine);
  const soonest = soonestReal(mine);

  // The same trade either side of here. Only places that actually have it
  // open: linking to an empty page spends crawl budget on nothing.
  const sameTradeNearby = nearbyAreas(idx.areas, place, 30)
    .map((a) => ({
      area: a,
      n: idx.slots.filter((s) =>
        s.area_slug === a.slug && (s.trade ?? '').trim().toLowerCase() === trade).length,
    }))
    .filter((x) => x.n > 0)
    .slice(0, 8);

  const otherTrades = linkableTrades(here).filter((t) => t.trade !== trade).slice(0, 10);

  const empty = !mine.length;
  const last = empty ? await lastOpeningIn(env, place.slug) : null;

  const lede = empty
    ? `No ${escapeHtml(label.toLowerCase())} appointments are open in ${
        escapeHtml(place.name)} at the moment.${last
        ? ` The most recent opening in ${escapeHtml(place.name)} was ${escapeHtml(last)}.`
        : ''}`
    : `${mine.length} opening${mine.length === 1 ? '' : 's'} in ${escapeHtml(place.name)}${
        soonest ? `, the next on ${escapeHtml(soonest.when)}` : ''}${
        cheapest ? `, from ${escapeHtml(cheapest.price)}` : ''}. Every time and
        price below is the one the business set.`;

  const why = `<section>
<h2>Why these are open</h2>
<p>Each of these is a gap in a working day: a job that was cancelled, or an hour
between two that are booked. The business is already going to be in
${escapeHtml(place.name)}, so the alternative is driving past the time empty.
That is the whole reason it is listed.</p>
<p class="note">There is no bidding and no quote to wait for. The price shown is
the price the business set for that piece of work, and the time is a real opening
in a real calendar.</p>
</section>`;

  const licence = `<section>
<h2>Licensing for ${escapeHtml(label.toLowerCase())} in ${escapeHtml(LAUNCH_STATE)}</h2>
<p class="note">${licenceNote(trade)}</p>
</section>`;

  const body = `
<p class="crumb"><a href="/">${escapeHtml(SITE_NAME)}</a> › <a href="${
    escapeHtml(metroPath(metro))}">${escapeHtml(metro.name)}</a> › <a href="/near/${
    escapeHtml(place.slug)}">${escapeHtml(place.name)}</a> › ${escapeHtml(label)}</p>
<h1>${escapeHtml(label)} in ${escapeHtml(place.name)}<span class="count">${
    empty ? 'Nothing open right now'
      : `${mine.length} open appointment${mine.length === 1 ? '' : 's'}`}</span></h1>
<p class="lede">${lede}</p>
${empty ? `<div class="box"><p class="note">Openings appear here when a
${escapeHtml(label.toLowerCase())} job is cancelled or a gap opens between two
booked ones, usually the same week and often the same day. Nothing is listed in
advance, so this page is worth checking again later.</p></div>` : slotList(mine)}
${why}
${licence}
<section>
<h2>${escapeHtml(label)} nearby</h2>
${linkList(sameTradeNearby.map((x) => ({
    href: `/near/${x.area.slug}/${slug}`,
    text: `${label} in ${x.area.name}`,
    sub: `${x.n} open`,
  }))) || `<p class="note">Nothing else is open in this trade near
    ${escapeHtml(place.name)} right now.</p>`}
</section>
<section>
<h2>Other work open in ${escapeHtml(place.name)}</h2>
${linkList(otherTrades.map((t) => ({
    href: `/near/${place.slug}/${tradeSlug(t.trade)}`,
    text: `${tradeLabel(t.trade)} in ${place.name}`,
    sub: `${t.n} open`,
  }))) || ''}
<p class="note"><a href="/near/${escapeHtml(place.slug)}">Everything open in ${
    escapeHtml(place.name)}</a></p>
</section>
${tradeBySlug(trade) ? `<section>
<h2>${escapeHtml(label)} beyond ${escapeHtml(place.name)}</h2>
${linkList([
    {
      href: tradePath(tradeBySlug(trade)!.slug),
      // The trade page counts every opening on the site, in both metros, so it
      // is not "across Los Angeles" and never was once there were two.
      text: `${label} everywhere ${SITE_NAME} covers`,
    },
    {
      href: costPath(tradeBySlug(trade)!.slug),
      text: `What ${label.toLowerCase()} costs`,
    },
  ])}
</section>` : ''}`;

  /*
    COUNTED OVER `real` AND BRANCHED ON `real`, NOT ON `empty`.

    `empty` is "this page lists nothing at all", which is the right test for the
    copy on the page — a square of the grid holding six seeded listings is not
    blank and must not tell a reader it is. It is the wrong test for the
    snippet, twice over. It counted `mine.length`, so a square holding nothing
    but demo data described itself to a search engine as six real appointments;
    and had the count alone been swapped for `real.length`, a square in exactly
    that state would have advertised "0 appointments open", which is a worse
    sentence than the one it replaced.

    So the description asks the question the snippet is actually making a claim
    about — is there anything here a stranger could book — and answers it in the
    wording the empty page already uses. `cheapest` and `soonest` were already
    real-only; this is the count catching up with them.
  */
  const description = real.length === 0
    ? `${label} in ${where}. Nothing is open right now — `
      + `openings appear when a job is cancelled or a gap opens in the day.`
    : `${real.length} ${label.toLowerCase()} appointment${real.length === 1 ? '' : 's'} `
      + `open in ${where}`
      + `${cheapest ? `, from ${cheapest.price}` : ''}`
      + `${soonest ? `, next ${soonest.when}` : ''}. Real times, real prices.`;

  return seoPage({
    /*
      THE NEIGHBOURHOOD IS THE WORD THIS PAGE EXISTS FOR, so it must survive.

      "Car wash and detailing in Sherman Oaks, California | Round The Way" is
      sixty-six characters and a result shows about sixty — the state and the
      site name go, and with a longer trade or a longer neighbourhood the
      neighbourhood goes with them. That is the whole query this page was
      built to answer, truncated out of its own title. The state is the part
      worth losing: it is in the description, in the H1's own sentence and in
      the breadcrumb, and nobody searching for a car wash in Sherman Oaks
      needs telling which state it is in.
    */
    title: fitTitle(`${label} in ${where}`, `${label} in ${place.name}`),
    description,
    canonical: url,
    // Index only when there is something real to rank. An empty square of the
    // trade × place grid, or one holding nothing but sample data, is thin
    // content asking to be judged as thin content.
    noindex: real.length === 0,
    jsonLd: pageLd(base, [
      { name: SITE_NAME, url: '/' },
      { name: metro.name, url: metroPath(metro) },
      { name: place.name, url: `/near/${place.slug}` },
      { name: label, url: `/near/${place.slug}/${slug}` },
    ], mine, locality, url),
    body,
    areas: idx.areas,
  });
}

// ---------------------------------------------------------------------------
// 3. The pages that are also React routes
//
// /s/:trade, /cost/:trade, /cost, /browse, /browse/:category and /p/:slug
// existed only as React routes, which meant a crawler asking for any of them
// got an empty document with a script tag in it. Everything below renders the
// same facts
// the React page renders, from the same rows, and is spliced into the SPA's
// own document so that the person and the crawler get one page — see
// `intoShell` for why that rather than serving two.
//
// THE COUNTING RULE, which is the whole reason these pages are allowed to
// carry numbers at all: every figure is counted from rows fetched in this
// request and rendered underneath. Nothing is stored, averaged from history,
// rounded up or estimated. A trade with nothing open says so.
// ---------------------------------------------------------------------------

/** How this file spells "and optionally deliver inside the SPA document". */
export interface PageOptions {
  /** The SPA's index.html. Omitted or null renders the standalone document. */
  shell?: string | null;
}

/**
 * What this site claims about money, in the one sentence the app claims it in.
 *
 * THE DEFECT THIS EXISTS TO CLOSE. The payment seam is not implemented —
 * createOrder in lib/orders.ts writes 'pending' and says so, and the refund,
 * the operator fee, the parts charge and the settlement are all the same kind
 * of unwritten. The React pages were rewritten to say that; these pages were
 * not, so /cost/<trade> answered "When do I pay?" with "You pay for the labour
 * when you book" while the React page rendering the same URL answered "Nothing
 * is paid on this site yet". One document, two claims, and the one a crawler
 * indexed was the untrue one.
 *
 * WHY IT IS COPIED RATHER THAN IMPORTED. This module runs in the Worker;
 * web/src/components/PaymentState.tsx is compiled into the browser bundle, and
 * neither build can reach the other's tree. So the string is written out here
 * a second time, and test/public-payload.test.ts reads PaymentState.tsx off
 * disk and fails if the two stop being the same words — the drift is the
 * defect, so the drift is what is pinned, not the wording.
 *
 * Every answer below that touches money opens with this, exactly as Trade.tsx
 * and CostGuide.tsx do. Change PaymentState.tsx without changing this and the
 * pin fails, which is the only reason the crawler's copy and the browser's
 * copy cannot come to say different things about somebody's money.
 */
export const PAY_TODAY_SHORT =
  'You pay on this site when you book, by card, and the price you see is the '
  + 'price you pay — nothing is added at checkout. Round The Way holds that '
  + 'payment until the job is done and then pays the business.';

/**
 * What booking actually requires of a customer, in one sentence.
 *
 * SEPARATE FROM PAY_TODAY_SHORT ON PURPOSE, and not because the two describe
 * different moments — they describe the same one. PAY_TODAY_SHORT is pinned
 * character for character against web/src/components/PaymentState.tsx by
 * test/public-payload.test.ts, so that the crawler's copy of a page and the
 * React copy of the same URL cannot say different things about money. This
 * sentence is about the ACCOUNT rather than the money; folding it into the
 * pinned constant would break that pin for a reason that has nothing to do
 * with what the pin protects.
 *
 * THE CORRECTION IT EXISTS TO MAKE. Every page this module renders was written
 * on "no account is ever required, here or later". That was never the model.
 * A customer needs an account and a card to book; what is true is only that
 * neither is asked for until they have decided to buy something. So the
 * Both halves are facts and both are enforced at the checkout: an order
 * without an account is refused, and checkoutCard in index.ts refuses one
 * without a card with 402 card_required.
 */
export const ACCOUNT_TODAY_SHORT =
  'Booking needs an account and a card. Making the account is an email: you '
  + 'give an email address at the moment you book and type the six digits we '
  + 'send to it, then add a card on the same screen. Looking, comparing prices '
  + 'and messaging a business need no account at all, and neither does opening '
  + 'a booking you already have — the link in your confirmation still works on '
  + 'any phone.';

/**
 * One opening per gap, whatever it is tagged with.
 *
 * mapData offers a whole free day in every neighbourhood the business covers,
 * because it genuinely is available in all of them — right for a map, and
 * double counting the moment a page adds up the whole city rather than one
 * pin. The React pages count the tagged rows and so overstate a free day by
 * however many areas its owner works; these pages count the openings.
 */
function distinctGaps(slots: PlacedSlot[]): PlacedSlot[] {
  const seen = new Set<string>();
  const out: PlacedSlot[] = [];
  for (const s of slots) {
    if (seen.has(s.gap_id)) continue;
    seen.add(s.gap_id);
    out.push(s);
  }
  return out;
}

/**
 * The catalogue entry for a URL segment.
 *
 * Accepts the stored slug the React app links with ('junk removal', encoded)
 * and the hyphenated form the /near pages use ('junk-removal'), because both
 * are forms a person or a crawler will arrive with. Anything else is null —
 * a guessed trade mints a URL for work nobody does.
 */
export function tradeFromPathSegment(segment: string): Trade | null {
  const raw = (segment ?? '').trim().toLowerCase();
  const direct = tradeBySlug(raw);
  if (direct) return direct;
  const stored = tradeFromSlug(tradeSlug(raw));
  return stored ? tradeBySlug(stored) : null;
}

/**
 * The canonical URL segment for a trade, so index.ts can redirect the other
 * spelling at it rather than letting one page answer on two addresses.
 *
 * It is the hyphenated form — see `tradePath` for why, and note that the
 * redirect in src/index.ts now points THIS way: /s/junk%20removal is the one
 * that moves, and /s/junk-removal is where it moves to.
 */
export const canonicalTradeSegment = (t: Trade) => tradeSlug(t.slug);

/** Major units, formatted the way the React pages format them. */
const money = (cents: number, currency: string) => formatMoney(cents, currency, 'en-US');

/** "1 hr 30 min", because "90 min" makes a reader do the arithmetic. */
function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

/**
 * The middle listed price. Median rather than mean, for the reason CostGuide
 * gives: one full-day job at ten times everything else drags an average
 * somewhere no real job sits.
 */
function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  if (lo === undefined || hi === undefined) return null;
  return Math.round((lo + hi) / 2);
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** A stat tile: a counted number and the noun it counts. */
const statList = (stats: Array<{ n: string; of: string }>) =>
  (stats.length
    ? `<ul class="stats">${stats.map((s) => `<li><b>${escapeHtml(s.n)}</b><span>${
      escapeHtml(s.of)}</span></li>`).join('')}</ul>`
    : '');

/**
 * How many of the rows behind a figure are seeded samples.
 *
 * CostGuide says this in words and so does every page here that prints a
 * price, because a sample listing is a real price on a real operator record
 * and is not a business trading today. Silence would let a demo row be read as
 * evidence of a market.
 */
function sampleNote(sampleCount: number, total: number): string {
  if (sampleCount === 0) return '';
  const what = sampleCount === total
    ? (total === 1 ? 'That listing is a sample' : `All ${total} are sample listings`)
    : `${sampleCount} of them ${plural(sampleCount, 'is a sample listing', 'are sample listings')}`;
  return `<p class="note">${escapeHtml(what)} we seeded ourselves rather than a
business trading today. Each one is labelled where it appears.</p>`;
}

/**
 * The answers the React trade page carries, kept in one array so the visible
 * block and the FAQPage below it are built from the same words. Every one of
 * them describes something this product actually does; there is nothing here
 * about vetting, insurance, licensing or response times.
 *
 * "Do I need an account?" was added when the model was corrected. It is the
 * first thing a stranger wants to know before they start filling anything in,
 * these pages used to answer it wrongly by implication, and an FAQ that
 * carefully explains cancellation fees while leaving out the one requirement
 * for booking at all is not a complete answer to anything.
 */
function faqsFor(tradeName: string): Array<{ q: string; a: string }> {
  return [
    {
      q: 'Do I need an account?',
      a: ACCOUNT_TODAY_SHORT,
    },
    {
      q: 'How do I pay?',
      a: `${PAY_TODAY_SHORT} The labour is paid for here, on the site, at the `
        + 'moment you book — with no cash and nothing paid at the door.',
    },
    {
      q: 'What happens if the job needs a part?',
      a: 'The business sends you a price for the part in your messages. Nothing '
        + 'is fitted until you approve that price, and approving it is also '
        + 'what charges you for it.',
    },
    {
      q: `Who sets the price for ${tradeName}?`,
      a: 'The business doing the work sets it. Every price on this page was '
        + 'listed by the business whose name is on the card.',
    },
    {
      q: 'How do I know the right person has turned up?',
      a: "The business's vehicle details are shown to you in the app and the "
        + 'vehicle at your door has to match them. You give them a start code '
        + 'when they arrive, and you both confirm the arrival.',
    },
    {
      q: 'Is there a record of the work?',
      a: 'Photographs are taken before the work starts, while it is going on, '
        + 'and after it is finished.',
    },
    {
      q: 'What does it cost to cancel?',
      a: 'It depends how close to the appointment you are. More than 48 hours '
        + 'away, all of it comes back. Inside 48 hours, three quarters comes '
        + 'back. Inside 12 hours, a quarter — the business has kept that time '
        + 'free and turned other work away for it. Change your mind within 30 '
        + 'minutes of booking and you get all of it back, as long as the '
        + 'appointment is still at least three hours away. It works the same '
        + 'way in both directions: a business that cancels on you pays the '
        + 'same.',
    },
  ];
}

/** The trades open somewhere, ranked by how many openings they have. */
function tradesByOpenings(slots: PlacedSlot[]): Array<{ trade: Trade; n: number }> {
  const counts = new Map<string, number>();
  for (const s of distinctGaps(slots)) {
    const key = (s.trade ?? '').trim().toLowerCase();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([slug, n]) => ({ trade: tradeBySlug(slug), n }))
    .filter((x): x is { trade: Trade; n: number } => x.trade !== null)
    .sort((a, b) => b.n - a.n || a.trade.label.localeCompare(b.trade.label));
}

// ---------------------------------------------------------------------------
// 3a. /s/:trade — one trade, everything open in it
// ---------------------------------------------------------------------------

/**
 * The strip of recent reviews a trade page carries, or nothing at all.
 *
 * Every row is a real review of a real business in this trade, linked to the
 * page it belongs to, and a trade nobody has reviewed renders NOTHING — not a
 * placeholder, not "be the first", not an average of something else. That is
 * the first rule at the top of this file applied to the one kind of content
 * most worth faking, and it is why there is no fallback branch below.
 *
 * The stars are drawn for a reader and are deliberately not marked up. Emitting
 * Review or AggregateRating nodes on a page that is not about one business is
 * how a site ends up submitting somebody else's rating as its own, and the
 * per-business markup on /p/:slug already carries these same rows once.
 */
function tradeReviewStrip(reviews: TradeReview[], label: string): string {
  if (reviews.length === 0) return '';

  const samples = reviews.filter((r) => r.is_sample).length;

  // Its own sentence rather than sampleNote, which says "sample listings" —
  // correct for an opening and wrong for a review, and on this of all blocks
  // the words have to say exactly what the thing is.
  const sampleLine = samples === 0 ? '' : `<p class="note">${escapeHtml(
    samples === reviews.length
      ? (reviews.length === 1
        ? 'That review belongs to a sample business we seeded ourselves'
        : `All ${reviews.length} belong to sample businesses we seeded ourselves`)
      : `${samples} of them ${plural(samples, 'belongs', 'belong')} to a sample business `
        + 'we seeded ourselves')} rather than a business trading today. Each one is
labelled where it appears.</p>`;

  return `<section>
<h2>Recent reviews in ${escapeHtml(label.toLowerCase())}</h2>
<p class="note">The ${reviews.length} most recent ${plural(reviews.length, 'review', 'reviews')}
left for ${escapeHtml(label.toLowerCase())} on ${escapeHtml(SITE_NAME)}. Only somebody
who booked here and had the work done can leave one, and each is signed with a
first name and an initial.</p>
${sampleLine}
${reviews.map((r) => `<div class="box">
<p><strong>${escapeHtml(r.author_name)}</strong>
<span class="note">${escapeHtml(reviewDate(r.created_at))}</span></p>
<p><span aria-hidden="true">${STARS(r.rating)}</span>
<span class="note">${r.rating} out of 5${r.is_sample ? ' · sample review' : ''}</span></p>
<p>${escapeHtml(r.body)}</p>
${r.details ? `<p class="note">Booked: ${escapeHtml(r.details)}</p>` : ''}
<p><a href="/p/${escapeHtml(r.profile_slug)}">${escapeHtml(r.business_name)}</a></p>
</div>`).join('')}
</section>`;
}

export async function tradePage(
  env: Env, segment: string, opts: PageOptions = {},
): Promise<string | null> {
  const entry = tradeFromPathSegment(segment);
  if (!entry) return null;                      // the SPA says "we do not have this trade"

  const base = baseUrlOf(env);
  // Fetched alongside the live index rather than after it: neither reads the
  // other, and this page is built on every crawl of every trade.
  const [idx, tradeReviews] = await Promise.all([
    liveIndex(env),
    reviewsForTrade(env, entry.slug, 6),
  ]);
  const path = tradePath(entry.slug);
  const url = `${base}${path}`;
  const label = entry.label;
  const lower = label.toLowerCase();
  const category = categoryOf(entry.slug);

  const tagged = idx.slots.filter((s) => (s.trade ?? '').trim().toLowerCase() === entry.slug);
  const mine = distinctGaps(tagged);
  const real = mine.filter((s) => !s.is_sample);

  // Every one of these is counted from the rows immediately below and nothing
  // else. The cheapest is the cheapest of everything listed, because every
  // listing is on the page; the description's price is the cheapest genuine
  // one, for the reason set out over cheapestReal.
  const businesses = new Set(mine.map((s) => s.operator_id)).size;
  const places = new Set(tagged.map((s) => s.area_slug)).size;
  const cheapest = mine.reduce<PlacedSlot | null>(
    (b, s) => (!b || s.price_cents < b.price_cents ? s : b), null);
  const claimable = cheapestReal(mine);

  const stats = mine.length
    ? statList([
      { n: String(businesses), of: plural(businesses, 'business listed', 'businesses listed') },
      { n: String(mine.length), of: plural(mine.length, 'appointment open', 'appointments open') },
      ...(cheapest ? [{ n: cheapest.price, of: 'lowest price listed' }] : []),
      ...(places ? [{ n: String(places), of: plural(places, 'neighbourhood', 'neighbourhoods') }]
        : []),
    ])
    : '';

  // Where this trade is actually open, from the area_slug on the rows. This is
  // the geographic cross-link: a trade page names its places, a place page
  // names its trades.
  const here = idx.areas
    .map((a) => ({
      area: a,
      n: distinctGaps(tagged.filter((s) => s.area_slug === a.slug)).length,
    }))
    .filter((x) => x.n > 0)
    .sort((x, y) => y.n - x.n || x.area.name.localeCompare(y.area.name));

  const faqs = faqsFor(lower);
  const faqBlock = faqs.map((f) => `<details><summary>${escapeHtml(f.q)}</summary>
<p class="note">${escapeHtml(f.a)}</p></details>`).join('');

  // Openings per trade, counted once each: `tradesByOpenings` deduplicates on
  // the gap for the reason `distinctGaps` exists, so a business's whole free
  // day is one appointment however many of its neighbourhoods it is offered
  // in.
  const openByTrade = new Map(tradesByOpenings(idx.slots).map((x) => [x.trade.slug, x.n]));

  // Busiest first, so both of the blocks built from this list lead with the
  // trade that has something in it. web/src/pages/Trade.tsx orders its copy the
  // same way — the two render the same URL and must not disagree about which
  // neighbour is worth looking at first.
  const siblings = (category?.trades ?? [])
    .filter((t) => t.slug !== entry.slug)
    .map((t) => ({ t, n: openByTrade.get(t.slug) ?? 0 }))
    .sort((a, b) => b.n - a.n || a.t.label.localeCompare(b.t.label));

  /**
   * The trades with the most free hours right now.
   *
   * The reference marketplace ends this page with "Trending on Thumbtack",
   * which is popularity data drawn from what people search for and book. We
   * have none of that. What can be counted is how many appointments each trade
   * has open at this moment, so that is what the heading below says, and it is
   * the only claim the numbers make.
   */
  const busiest = tradesByOpenings(idx.slots)
    .filter((x) => x.trade.slug !== entry.slug)
    .slice(0, 6);

  /**
   * The cost guides worth offering from here: the neighbouring trades in this
   * category, or the busiest on the site where the catalogue has no category
   * for this one. The count is openings, and every opening carries a price, so
   * it is a count of what the guide behind the link will actually show.
   */
  const guides = (category
    ? siblings.map((s) => ({ trade: s.t, n: s.n }))
    : busiest).slice(0, 6);

  const lede = mine.length
    ? `These are hours a local business has free this week — a job that
       cancelled, or a day that is not full yet. Every price is set by the
       business doing the work, and you pay it here when you book.`
    : `No one working in this trade has an appointment free at the moment. An
       opening appears when a job cancels or a day does not fill, so it arrives
       without warning.`;

  const body = `
<p class="crumb"><a href="/">${escapeHtml(SITE_NAME)}</a> › ${category
    ? `<a href="/browse/${escapeHtml(category.key)}">${escapeHtml(category.label)}</a> › `
    : ''}${escapeHtml(label)}</p>
<h1>${escapeHtml(label)} near you<span class="count">${mine.length
    // The counted line the reference marketplace puts above its H1 — theirs is
    // marked up as an h2 standing before the h1, which is a hole in the
    // document outline and is not copied. React renders these same words as a
    // paragraph above the heading; the words have to match, because the two
    // render the same URL and one replaces the other under the reader.
    ? `${mine.length} open ${plural(mine.length, 'appointment', 'appointments')}, from ${
      businesses} ${plural(businesses, 'business', 'businesses')}`
    : 'Nothing open right now'}</span></h1>
<p class="lede">${lede}</p>
${stats}
${sampleNote(mine.length - real.length, mine.length)}
<section>
<h2>${mine.length
    ? `${mine.length} ${plural(mine.length, 'appointment', 'appointments')} open`
    : 'Open appointments'}</h2>
${mine.length
    ? slotList(mine)
    : `<div class="box"><p>Nothing open in ${escapeHtml(lower)} right now.</p>
<p class="note">Openings appear when a job is cancelled or a day does not fill.
There is nothing to sign up for on this page — <a href="/a">a standing alert</a>
is the one thing we can offer, and it is the only thing that will tell you.</p>
</div>`}
</section>
${tradeReviewStrip(tradeReviews, label)}
<section>
<h2>What does ${escapeHtml(lower)} cost?</h2>
<p class="note">Every price listed for this trade right now — the lowest, the
highest and the middle — counted from the businesses on ${escapeHtml(SITE_NAME)}.</p>
${linkList([{ href: costPath(entry.slug), text: `${label} prices` }])}
</section>
<section>
<h2>Booking ${escapeHtml(lower)} on ${escapeHtml(SITE_NAME)}</h2>
<p class="note">What happens after you press book, and what it costs if plans
change.</p>
${/*
  THE "HOW IT WORKS" BAND, AND WHY IT PAIRS WITH THE QUESTIONS UNDER IT.

  The strip is what somebody reads; the disclosures underneath are what they
  open when one of the three steps is the one they are unsure about. This page
  had the questions and not the strip, so a visitor who had never booked
  anything here had to open seven <details> to work out what pressing the button
  does — and the React copy of this URL grew the strip first, so for a while the
  two halves of one address answered that at different lengths.

  The words are the cost guide's below, word for word, and the class is the one
  its band already uses: /s/<trade> and /cost/<trade> are two halves of one
  visit and a reader crossing between them must not find booking described two
  ways. The single difference is the last clause of step two, because on this
  page the questions are below the band and on that one they are above it.

  Nothing here about vetting, insurance or how fast anybody replies. The band is
  the most confident-looking thing on the page, which is exactly where an untrue
  claim would do the most damage.
*/''}<ol class="steps">
<li><h3>Find an hour that is already free</h3>
<p>Every listing on ${escapeHtml(SITE_NAME)} is unbooked working time — a job
that cancelled, or a day that did not fill. You are choosing a particular hour
from a particular business, not asking around for quotes.</p></li>
<li><h3>Book it, and it is held</h3>
<p>The hour comes off that business's day the moment you book it and stops
being offered to anybody else. What happens about money is answered in the
questions below.</p></li>
<li><h3>They arrive, and the work is recorded</h3>
<p>The vehicle at your door has to match the details you were shown, you give
them a start code, and photographs are taken before, during and after the
work.</p></li>
</ol>
${/*
  A heading over the disclosures, because the band above is now the first thing
  under this section's h2 and an unlabelled run of <details> after it reads as a
  continuation of the third step.
*/''}<h3>Questions about booking ${escapeHtml(lower)}</h3>
${faqBlock}
</section>
<section>
<h2>Where ${escapeHtml(lower)} is open</h2>
${linkList(here.map((x) => ({
    href: `/near/${x.area.slug}/${tradeSlug(entry.slug)}`,
    text: `${label} in ${x.area.name}`,
    sub: `${x.n} open`,
  }))) || `<p class="note">Nothing in this trade is open in any neighbourhood
right now, so there is nowhere to send you that would have something on it.</p>`}
<p class="note"><a href="/near">Every neighbourhood ${escapeHtml(SITE_NAME)} covers</a>${
    METROS.map((m) => ` · <a href="${escapeHtml(metroPath(m))}">${escapeHtml(m.name)}</a>`).join('')
}</p>
</section>
${guides.length ? `<section>
<h2>Related cost information</h2>
<p class="note">What the work next to this one is listed at today. Every one of
these pages counts its figures off the businesses on ${escapeHtml(SITE_NAME)} the
moment it is opened — none of them quotes an average or a survey.</p>
${linkList(guides.map((g) => ({
    href: costPath(g.trade.slug),
    text: `What ${g.trade.label.toLowerCase()} costs`,
    sub: g.n > 0 ? `${g.n} ${plural(g.n, 'price', 'prices')} listed` : 'nothing listed today',
  })))}
<p class="note"><a href="/cost">Every cost guide on ${escapeHtml(SITE_NAME)}</a></p>
</section>` : ''}
${siblings.length && category ? `<section>
<h2>More in ${escapeHtml(category.label.toLowerCase())}</h2>
${linkList(siblings.map((s) => ({
    href: tradePath(s.t.slug),
    text: s.t.label,
    sub: s.n > 0 ? `${s.n} open` : undefined,
  })))}
</section>` : ''}
${busiest.length ? `<section>
<h2>Most appointments open right now</h2>
<p class="note">The trades with the most free hours on ${escapeHtml(SITE_NAME)} at
this moment, counted from the same rows as everything else on this page. It is a
count of what is open today, not a measure of what is popular — we do not have
one of those.</p>
${linkList(busiest.map((x) => ({
    href: tradePath(x.trade.slug),
    text: x.trade.label,
    // "N open" rather than "N appointments open": the same wording the
    // neighbourhood list above uses, and short enough that a run of six of
    // them can be compared down the page.
    sub: `${x.n} open`,
  })))}
<p class="note"><a href="/browse">Every service ${escapeHtml(SITE_NAME)} lists</a></p>
</section>` : ''}
<p class="foot">Every figure on this page is counted from the appointments this
trade had open at the moment the page was built. Prices are set by the business
doing the work.</p>`;

  /*
    BOTH FIGURES IN THE SNIPPET ARE COUNTED OVER `real`.

    `claimable` is already `cheapestReal`, and the note over that function says
    why in one line: "From $89" in a snippet is a claim, so it may never come
    from a sample listing. The count of appointments and the count of
    businesses beside it are the same kind of claim and were counted over
    everything — so a trade whose every listing is seeded advertised itself as
    "6 house cleaning appointments open on Round The Way, from 3 businesses",
    none of which trade. The tiles and the list on the page still count
    everything; `sampleNote` stands directly above them saying how many are
    seeded, and a search result has nowhere to put that sentence.
  */
  const realBusinesses = new Set(real.map((s) => s.operator_id)).size;
  const description = real.length
    ? `${real.length} ${lower} ${plural(real.length, 'appointment', 'appointments')} open on `
      + `${SITE_NAME}${claimable ? `, from ${claimable.price}` : ''}, `
      + `from ${realBusinesses} ${plural(realBusinesses, 'business', 'businesses')}. `
      + `Real times, real prices, booked without a phone call.`
    : `${label} on ${SITE_NAME}. Nothing is open right now — openings appear when `
      + `a job is cancelled or a day does not fill.`;

  return seoPage({
    title: `${label} — what is open now`,
    description,
    canonical: url,
    /*
      NOT INDEXABLE WITH NOTHING REAL IN IT, WHICH IS A CHANGE OF MIND.

      The defence written here was that this is one page per trade rather than
      a square of the combinatorial grid, and that it says something true on a
      quiet day. The first half is right and the second half is the problem:
      what it says on a quiet day is the SAME thing all thirty-eight of these
      pages say. The seven questions are identical, the three-step band is
      identical, the closing paragraph is identical, and on a trade with
      nothing open that boilerplate is the entire page with a different
      heading on it. Submitting thirty-eight of those is the textbook shape of
      a doorway set, and it is judged as one.

      The moment a real opening exists the page is about that opening and asks
      to be indexed again. Nothing has to be republished for that to happen —
      it is counted per request, like every other number here — and
      `sitemapXml` already applies the same test, so the two agree.
    */
    noindex: real.length === 0,
    jsonLd: {
      '@context': 'https://schema.org',
      '@graph': [
        breadcrumbLd(base, [
          { name: SITE_NAME, url: '/' },
          ...(category ? [{ name: category.label, url: `/browse/${category.key}` }] : []),
          { name: label, url: path },
        ]),
        {
          '@type': 'FAQPage',
          mainEntity: faqs.map((f) => ({
            '@type': 'Question',
            name: f.q,
            acceptedAnswer: { '@type': 'Answer', text: f.a },
          })),
        },
      ],
    },
    body,
    areas: idx.areas,
    shell: opts.shell,
  });
}

// ---------------------------------------------------------------------------
// 3b. /cost/:trade — what one trade costs, out of what is listed and nothing
// else
// ---------------------------------------------------------------------------

/**
 * Below this many listed prices there is no spread to report, only two or
 * three businesses' opinions. Same figure as CostGuide's ENOUGH.
 */
const ENOUGH = 3;

/**
 * The answers the React cost page carries, word for word.
 *
 * This file and web/src/pages/CostGuide.tsx render the same route — one for a
 * visitor with no JavaScript and for crawlers, one for a visitor with it — and
 * a FAQPage block is a promise that the answer quoted in a search result is on
 * the page when somebody arrives. Two copies that drift break that promise
 * silently, so any edit here has to be made in that file's faqsFor as well.
 * The trade page keeps its own set: those answers are about booking a job,
 * these are about where a price on this page came from.
 *
 * "Do I need an account?" is the one answer both sets carry, in the same
 * words, because it is the same question wherever it is asked and because
 * these pages spent their whole existence implying the opposite answer.
 */
function costFaqsFor(tradeName: string): Array<{ q: string; a: string }> {
  return [
    {
      q: 'Do I need an account?',
      a: ACCOUNT_TODAY_SHORT,
    },
    {
      q: `Are these average prices for ${tradeName}?`,
      a: 'No. Every figure on this page is a price a business on Round The Way is '
        + 'asking today for an appointment it has open, counted at the moment '
        + 'the page loaded. We have no national survey for this trade and we '
        + 'do not estimate one.',
    },
    {
      q: 'Who sets these prices?',
      a: 'The business doing the work. Every price here was listed by the '
        + 'business whose name is on the appointment, and Round The Way does not '
        + 'set or suggest any of them.',
    },
    {
      q: 'Does the price include parts?',
      a: 'It depends on the service, and the booking page says which before '
        + 'you book: parts are either included in the price or quoted '
        + 'separately. Where they are quoted, the business sends you a price '
        + 'in your messages once they can see what is needed, and nothing is '
        + 'fitted until you approve that price.',
    },
    {
      q: 'When do I pay?',
      a: `${PAY_TODAY_SHORT} The labour is paid for here, on the site, at the `
        + 'moment you book, with no cash and nothing paid at the door.',
    },
    {
      q: 'Why is the same job listed at two different prices?',
      a: 'Because two different businesses listed it. Each one sets its own '
        + 'prices, sets aside its own amount of time for the work, and covers '
        + 'its own part of the city, so the same job name can be worth '
        + 'different amounts to each of them.',
    },
    {
      q: 'What does it cost to cancel?',
      a: 'It depends how close to the appointment you are. More than 48 hours '
        + 'away, all of it comes back. Inside 48 hours, three quarters comes '
        + 'back. Inside 12 hours, a quarter — the business has kept that time '
        + 'free and turned other work away for it. Change your mind within 30 '
        + 'minutes of booking and you get all of it back, as long as the '
        + 'appointment is still at least three hours away. It works the same '
        + 'way in both directions: a business that cancels on you pays the '
        + 'same.',
    },
  ];
}

export async function costGuidePage(
  env: Env, segment: string, opts: PageOptions = {},
): Promise<string | null> {
  const entry = tradeFromPathSegment(segment);
  if (!entry) return null;

  const base = baseUrlOf(env);
  const idx = await liveIndex(env);
  const path = costPath(entry.slug);
  const url = `${base}${path}`;
  const label = entry.label;
  const lower = label.toLowerCase();
  const category = categoryOf(entry.slug);

  // `tagged` keeps one row per neighbourhood the opening is offered in, which
  // is what the "find it near you" block at the foot of the page counts;
  // `mine` is one row per opening, which is what every price on the page is
  // counted from.
  const tagged = idx.slots.filter((s) => (s.trade ?? '').trim().toLowerCase() === entry.slug);
  const mine = distinctGaps(tagged);

  // Where this trade is actually open, from the area_slug on those rows. A
  // neighbourhood is listed because an appointment is open in it right now, so
  // every link here lands on a page with something on it.
  const here = idx.areas
    .map((a) => ({ area: a, n: distinctGaps(tagged.filter((s) => s.area_slug === a.slug)).length }))
    .filter((x) => x.n > 0)
    .sort((x, y) => y.n - x.n || x.area.name.localeCompare(y.area.name));

  /**
   * The other cost guides worth offering, with what each has listed.
   *
   * The reference marketplace closes its cost guide with a block of a dozen
   * links into other cost guides, which is the most useful thing on the page
   * for somebody who arrived on the wrong one. Ours comes off the catalogue:
   * the trades in the same category, busiest first, or the busiest on the site
   * where there is no category. The count is openings — deduplicated on the
   * gap, so it matches what the guide behind the link will report — and every
   * opening carries a price.
   */
  const openByTrade = new Map(tradesByOpenings(idx.slots).map((x) => [x.trade.slug, x.n]));
  const related = (category
    ? category.trades.filter((t) => t.slug !== entry.slug)
      .map((t) => ({ trade: t, n: openByTrade.get(t.slug) ?? 0 }))
    : tradesByOpenings(idx.slots).filter((x) => x.trade.slug !== entry.slug))
    .sort((a, b) => b.n - a.n || a.trade.label.localeCompare(b.trade.label))
    .slice(0, 8);

  // One currency only. A median taken across dollars and pounds is not a
  // price, it is an average of two different units.
  const counts = new Map<string, number>();
  for (const s of mine) counts.set(s.currency, (counts.get(s.currency) ?? 0) + 1);
  const currency = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const priced = currency ? mine.filter((s) => s.currency === currency) : [];

  const cents = priced.map((s) => s.price_cents).sort((a, b) => a - b);
  const n = cents.length;
  const low = cents[0] ?? null;
  const high = cents[cents.length - 1] ?? null;
  const mid = median(cents);
  const businesses = new Set(priced.map((s) => s.operator_id)).size;
  const samples = priced.filter((s) => s.is_sample).length;

  // One row per service name: five businesses listing "Full valet" is one row
  // a reader can use and five rows they have to reconcile themselves.
  const byService = new Map<string, PlacedSlot[]>();
  for (const s of priced) {
    const list = byService.get(s.service_name);
    if (list) list.push(s); else byService.set(s.service_name, [s]);
  }
  const services = [...byService.entries()].map(([name, rows]) => {
    const p = rows.map((r) => r.price_cents).sort((a, b) => a - b);
    const mins = rows.map((r) => Math.round(r.duration_seconds / 60)).sort((a, b) => a - b);
    return {
      name,
      n: rows.length,
      low: p[0] ?? 0,
      high: p[p.length - 1] ?? 0,
      minMinutes: mins[0] ?? 0,
      maxMinutes: mins[mins.length - 1] ?? 0,
    };
  }).sort((a, b) => a.low - b.low || a.name.localeCompare(b.name));

  /**
   * The two things the sections below assert, counted rather than asserted.
   *
   * "A longer job costs more" and "every business sets its own price" are the
   * sort of sentence a cost guide writes whether or not its own data shows it.
   * These are the same two claims read off the rows: the shortest and longest
   * blocks anybody has set aside for this trade, and how many job names two or
   * more businesses list at prices that are not the same. Where a count comes
   * back at nothing, the sentence it would have supported is not printed.
   */
  const shared = services.filter((s) => s.n > 1);
  const evidence = {
    shortest: services.reduce<number | null>(
      (m, s) => (m === null || s.minMinutes < m ? s.minMinutes : m), null),
    longest: services.reduce<number | null>(
      (m, s) => (m === null || s.maxMinutes > m ? s.maxMinutes : m), null),
    differing: shared.filter((s) => s.low !== s.high).length,
  };

  /**
   * WHAT IT IS LISTED AT IN EACH PLACE.
   *
   * The module a cost page most obviously owes its reader: "what does it cost"
   * nearly always means "what does it cost here". The reference marketplace
   * answers it with a national figure adjusted per city. These rows are not
   * modelled at all — each is the listings actually open in that metro, counted
   * the same way the headline figures above are counted.
   *
   * SO ENOUGH APPLIES PER ROW, NOT ONLY TO THE PAGE. A trade can clear the bar
   * across both metros and be a single listing in one of them, and printing a
   * range beside a place with two prices in it would be exactly the invented
   * spread this page refuses at the top. A thin row says how thin it is and
   * keeps its link; a place with nothing listed is left off entirely, because a
   * row of dashes implies we looked and found the trade expensive there rather
   * than absent.
   *
   * THE DEDUPLICATION IS PER METRO AND THAT IS DELIBERATE. `tagged` carries one
   * row per neighbourhood, so a business's whole free day appears once for each
   * area it covers; each metro's count therefore dedupes on the opening within
   * itself, which makes every row correct on its own terms. An opening offered
   * across two metros is counted in both, so the rows do not sum to the page
   * total — which is why nothing below adds them up, and why the note says so.
   */
  const byMetro = (() => {
    const metroSlugOf = new Map(idx.areas.map((a) => [a.slug, metroOf(a).slug] as const));
    const acc = new Map<string, { seen: Set<string>; cents: number[]; ops: Set<string> }>();
    for (const s of tagged) {
      if (currency && s.currency !== currency) continue;
      const m = metroSlugOf.get(s.area_slug);
      if (!m) continue;
      let row = acc.get(m);
      if (!row) { row = { seen: new Set(), cents: [], ops: new Set() }; acc.set(m, row); }
      if (row.seen.has(s.gap_id)) continue;
      row.seen.add(s.gap_id);
      row.cents.push(s.price_cents);
      row.ops.add(s.operator_id);
    }
    // Ordered by the metro list rather than by price or by size, so the table
    // reads the same way on every cost guide on the site.
    return METROS.flatMap((m) => {
      const row = acc.get(m.slug);
      if (!row || row.cents.length === 0) return [];
      const cents = row.cents.sort((a, b) => a - b);
      return [{
        metro: m,
        n: cents.length,
        businesses: row.ops.size,
        low: cents[0] ?? null,
        mid: median(cents),
        high: cents[cents.length - 1] ?? null,
      }];
    });
  })();

  /** The written cost factors for this trade, or nothing. See lib/costfacts.ts. */
  const costs = costsFor(entry.slug);

  // THE SENTENCE THAT MAKES THIS PAGE HONEST, above the figures rather than in
  // a footnote under them. If it is ever softened into "the average cost of X
  // is", the page becomes the thing it was written to avoid.
  const integrity = n === 0
    ? `<p class="note">Nothing in this trade is listed on ${escapeHtml(SITE_NAME)} at the
moment, so there is no price for us to report. We do not have national survey
figures and we are not going to estimate any.</p>`
    : `<p class="note">These are the prices <strong>${businesses} ${
      plural(businesses, 'business', 'businesses')} on ${escapeHtml(SITE_NAME)} are asking
right now</strong> for ${escapeHtml(lower)} — ${n} ${plural(n, 'listing', 'listings')}
counted the moment this page was built. They are not a national average and
they are not a survey. We do not have either of those, so we do not quote
one.</p>${sampleNote(samples, n)}`;

  const headline = n === 0
    ? `<div class="box"><p>No prices listed for ${escapeHtml(lower)} today.</p>
<p class="note">An opening here is an hour a business has free, so a trade can be
empty one hour and full the next. Rather than estimate a price from nothing, we
will tell you when somebody lists one — <a href="/a">a standing alert</a> is the
only thing this page can honestly offer.</p></div>`
    : n < ENOUGH
      // Two prices are two prices. Calling them a range would be inventing a
      // pattern out of a coincidence.
      ? `<h2 id="cg-thin">Too few listings to give a range</h2>
<p class="note">Only ${n} ${plural(n, 'price is', 'prices are')} listed for ${
  escapeHtml(lower)} at the moment. That is not enough to say what the work usually
costs, so below is exactly what is listed, and nothing more.</p>`
      : `<h2 id="cg-range">Listed prices today</h2>
<p class="note">The cheapest and dearest of the ${n} listings, and the one in the
middle.</p>
${statList([
  ...(low !== null && currency ? [{ n: money(low, currency), of: 'lowest listed' }] : []),
  ...(mid !== null && currency ? [{ n: money(mid, currency), of: 'middle of the listings' }] : []),
  ...(high !== null && currency
    ? [{ n: money(high, currency), of: 'highest listed' }] : []),
])}`;

  const table = services.length && currency
    ? `<section>
<h2 id="cg-svc">What each job is listed at</h2>
<p class="note">One row per service name, with what it is listed at and how long
the business has set aside for it. Where more than one business lists the same
job, the row shows the spread between them.</p>
<div class="tbl-wrap" tabindex="0" role="group" aria-label="What each ${
      escapeHtml(lower)} job is listed at">
<table><thead><tr><th scope="col">Service</th><th scope="col">How long</th>
<th scope="col" class="num">Listed price</th></tr></thead><tbody>${
      // The count is listings, not businesses: one business can list the same
      // service in several of its free hours, and calling five of those "five
      // businesses" would turn a repeated row into a market.
      services.map((s) => `<tr><th scope="row">${escapeHtml(s.name)}${s.n > 1
        ? `<span class="note"> — ${s.n} listings</span>` : ''}</th>
<td>${escapeHtml(s.minMinutes === s.maxMinutes
        ? duration(s.minMinutes)
        : `${duration(s.minMinutes)} – ${duration(s.maxMinutes)}`)}</td>
<td class="num">${escapeHtml(s.low === s.high
        ? money(s.low, currency)
        : `${money(s.low, currency)} – ${money(s.high, currency)}`)}</td></tr>`).join('')
    }</tbody></table></div>
</section>`
    : '';

  const cheapest = priced.reduce<PlacedSlot | null>(
    (b, s) => (!b || s.price_cents < b.price_cents ? s : b), null);

  /**
   * The cheapest one a reader can actually book, which is not always the
   * cheapest one listed.
   *
   * `cheapest` above counts every row, samples included, and that is right for
   * the summary line: it reports what is listed, and the summary says in its
   * own bullet how many of the rows are seeded. It was also wired to the Book
   * button at the bottom of this page, which is a different kind of statement
   * — the button is an offer, and an offer to book a business that does not
   * exist ends at the pricing step with `sample_listing`. On a deployment
   * whose listings are still mostly seeded that was the likeliest press on the
   * whole page.
   *
   * So the button follows `cheapestReal` and the figures carry on counting
   * everything. Where every listing in the trade is a sample this is null and
   * the button is simply not drawn — there is nothing to book, and a page with
   * no button says that more honestly than a button that refuses.
   */
  const bookable = cheapestReal(priced);

  // Rendered into the page as well as into the structured data below, and
  // built from the one array so they cannot disagree. A FAQPage describing
  // answers a reader cannot find on the page is the search-result equivalent
  // of a bait headline, whatever it does for the ranking.
  const faqs = costFaqsFor(lower);
  const faqBlock = faqs.map((f) => `<details><summary>${escapeHtml(f.q)}</summary>
<p class="note">${escapeHtml(f.a)}</p></details>`).join('');

  /**
   * THE PINNED PRICE BANNER.
   *
   * The reference marketplace opens its cost guide with the range and the
   * place it is for, and keeps it in view while the page is read. It only
   * appears once there are enough listings to have a range at all: below that
   * the page says so instead, and a banner would be two prices dressed up as a
   * market. It carries no link, button or field, so there is nothing in it for
   * a keyboard to get caught on, and it stops pinning itself on a narrow
   * screen — see the stylesheet.
   */
  const priceBar = n >= ENOUGH && currency && low !== null && high !== null
    ? `<div class="pricebar"><p><b>${escapeHtml(low === high
      ? money(low, currency)
      : `${money(low, currency)} – ${money(high, currency)}`)}</b>${mid !== null
      ? `<span class="pricebar-mid">middle ${escapeHtml(money(mid, currency))}</span>` : ''
    }<span class="pricebar-where">${n} ${plural(n, 'price', 'prices')} listed for ${
      escapeHtml(lower)}, everywhere ${escapeHtml(SITE_NAME)} covers</span></p></div>`
    : '';

  /**
   * THE SHORT ANSWER, WITH NOTHING IN IT THAT WAS NOT COUNTED.
   *
   * The reader typed a question and the page is five screens long, so the
   * reference marketplace opens with four or five highlight bullets. Theirs
   * summarise a survey; these summarise the listings, which is the only thing
   * this page has. Every figure below is one of the numbers already worked out
   * above, restated in a line somebody can read in three seconds, and there is
   * nothing here that is not repeated in full further down — that last part
   * matters, because a summary is allowed to be shorter than the page and is
   * not allowed to be the only place a claim appears.
   */
  const keyBox = n > 0 && currency
    ? `<section class="key">
<h2 id="cg-key-h">The short answer</h2>
<ul>
<li>${n >= ENOUGH && low !== null && high !== null
      ? (low === high
        ? `Every one of the ${n} listings for ${escapeHtml(lower)} is at <b>${
          escapeHtml(money(low, currency))}</b> right now.`
        : `Listed prices for ${escapeHtml(lower)} run from <b>${
          escapeHtml(money(low, currency))}</b> to <b>${
          escapeHtml(money(high, currency))}</b>${mid !== null
          ? `, with the middle listing at <b>${escapeHtml(money(mid, currency))}</b>` : ''}.`)
      : `Only ${n} ${plural(n, 'price is', 'prices are')} listed for ${escapeHtml(lower)} at
the moment, which is too few to give a range. What is listed is shown below
exactly as it stands.`}</li>
<li>That is ${n} ${plural(n, 'listing', 'listings')} from ${businesses} ${
      plural(businesses, 'business', 'businesses')}${services.length
      ? ` under ${services.length} ${plural(services.length, 'job name', 'different job names')}`
      : ''}.</li>
${cheapest ? `<li>The cheapest open right now is <b>${
      escapeHtml(money(cheapest.price_cents, currency))}</b> for ${
      escapeHtml(cheapest.service_name.toLowerCase())}, ${escapeHtml(cheapest.when)}.</li>` : ''}
${here.length ? `<li>It is open in ${here.length} ${
      plural(here.length, 'neighbourhood', 'neighbourhoods')}${byMetro.length > 1
      ? ` across ${escapeHtml(byMetro.map((m) => m.metro.name).join(' and '))}` : ''
    } at this moment.</li>` : ''}
${/*
  The caveat rides in the summary as well as in the note above it. A reader who
  only reads the box has to meet it too.
*/''}${samples > 0 ? `<li>${escapeHtml(samples === n
      ? (n === 1 ? 'That listing is a sample' : `All ${n} are sample listings`)
      : `${samples} of them ${plural(samples, 'is a sample listing', 'are sample listings')}`)
    } we seeded ourselves rather than a business trading today.</li>` : ''}
<li>There is no national average on this page, because we have not measured
one.</li>
</ul>
</section>`
    : '';

  const metroTable = byMetro.length > 1 && currency
    ? `<section>
<h2 id="cg-metro">What it is listed at in each place</h2>
<p class="note">The same count as above, taken one place at a time. A place with
fewer than ${ENOUGH} listings gets no range, for the same reason the page as a
whole would not. The rows are counted separately and are not meant to be added
together.</p>
<div class="tbl-wrap" tabindex="0" role="group" aria-label="What ${
      escapeHtml(lower)} is listed at in each place">
<table><thead><tr><th scope="col">Place</th><th scope="col">Listed</th>
<th scope="col" class="num">Listed prices</th><th scope="col" class="num">Middle</th>
</tr></thead><tbody>${byMetro.map((m) => `<tr><th scope="row"><a href="${
      escapeHtml(metroPath(m.metro))}">${escapeHtml(m.metro.name)}</a></th>
<td>${m.n} ${plural(m.n, 'listing', 'listings')} from ${m.businesses} ${
      plural(m.businesses, 'business', 'businesses')}</td>
${m.n >= ENOUGH && m.low !== null && m.high !== null
      ? `<td class="num"><b>${escapeHtml(m.low === m.high
        ? money(m.low, currency)
        : `${money(m.low, currency)} – ${money(m.high, currency)}`)}</b></td>
<td class="num">${m.mid !== null ? escapeHtml(money(m.mid, currency)) : '—'}</td>`
      // One cell across both price columns rather than a range and a dash. The
      // sentence is the answer here, and splitting it would leave a gap in a
      // column of numbers that reads as missing data rather than as data we
      // decline to invent.
      : '<td colspan="2">too few listed for a range</td>'}</tr>`).join('')
    }</tbody></table></div>
</section>`
    : '';

  /*
    THE COST-FACTOR LIST, WHICH IS KNOWLEDGE RATHER THAN A CLAIM.

    This page went without one for longest because the rule it is built on —
    print only what you counted — was read as forbidding anything written down.
    It does not. "A double-coated dog takes longer to groom than a short-haired
    one" is not a claim about Round The Way, it is not a claim about a business on
    it, and it needs no survey behind it: it is how the trade works, and a page
    called "what does X cost" that cannot say why one X costs more than another
    is a price list wearing a guide's title.

    What keeps it inside the rule is the constraint written over TRADE_COSTS in
    lib/costfacts.ts: nothing in any entry carries a number. A trade with no
    entry gets no section at all rather than a paragraph of filler.
  */
  const factorBlock = costs
    ? `<section>
<h2 id="cg-factors">What ${escapeHtml(lower)} prices depend on</h2>
<p class="note">Why two jobs with the same name are not the same job. This part
is about the work rather than about this site, so there are no figures in it —
the figures on this page are all above, and all counted.</p>
<dl class="deflist">${costs.factors.map((f) => `<dt>${escapeHtml(f.h)}</dt>
<dd>${escapeHtml(f.p)}</dd>`).join('')}</dl>
</section>`
    : '';

  /*
    THE MODULE A MARKETPLACE HAS EVERY COMMERCIAL REASON TO LEAVE OUT.

    Somebody who came to a cost page and left having decided to wash the car
    themselves was given the right answer, and a page that cannot say so is an
    advert. Written per trade and only where there genuinely is an amateur
    version: work where the honest answer is "do not" carries no `diy` entry and
    this section does not appear, rather than appearing with a discouraging
    paragraph in it.
  */
  const diyBlock = costs?.diy
    ? `<section>
<h2 id="cg-diy">Doing it yourself, or booking someone</h2>
<p class="note">The cheapest version of this job is sometimes not booking it at
all, and a page about what it costs should say where that line falls.</p>
<h3>Doing it yourself</h3>
<p>${escapeHtml(costs.diy.yourself)}</p>
<h3>Worth booking someone for</h3>
<p>${escapeHtml(costs.diy.pro)}</p>
</section>`
    : '';

  /*
    Every line here is something the reader does — clearing the space, grouping
    the jobs, saying what is in the load before the van arrives — rather than
    anything about our pricing, because we do not set the prices and have no
    discount to offer. Several of these cost the businesses on this site money,
    which is the test of whether the section is advice or marketing.
  */
  const saveBlock = costs?.saving?.length
    ? `<section>
<h2 id="cg-save">Where the price can come down</h2>
<p class="note">Things that genuinely make this job smaller or quicker. None of
them is a discount from us — we do not set these prices and have none to
give.</p>
<ul class="said">${costs.saving.map((sv) => `<li>${escapeHtml(sv)}</li>`).join('')}</ul>
</section>`
    : '';

  /*
    THE METHOD, WRITTEN OUT — and it was the one section on this page that the
    React copy carried and this one did not.

    A page of numbers that never says where they came from is asking to be
    trusted on its typography. The reference marketplace answers it with a
    survey of jobs booked through them; this cannot and does not. Every sentence
    below describes the arithmetic performed a few hundred lines up in this
    function, and every figure in it is one this render counted.

    WHAT MUST NEVER APPEAR HERE: a national average, a typical cost, a "most
    people pay", or any figure standing in for the trade at large. A method
    section is exactly where somebody would be tempted to smuggle one in as
    context, which is why the third heading below exists to say plainly that
    this page does not have one.
  */
  const methodBlock = n > 0 && currency
    ? `<section>
<h2 id="cg-method">How we worked these figures out</h2>
<p class="note">There is no survey behind this page and no editor. Here is the
whole method, and what it is and is not good for.</p>
<h3>Where the numbers come from</h3>
<p>Every figure above is a price a business on ${escapeHtml(SITE_NAME)} set on an
appointment it has free right now. When this page was built we read ${n} of them,
listed by ${businesses} ${plural(businesses, 'business', 'businesses')} under ${
      services.length} ${plural(services.length, 'job name', 'different job names')}.
Nothing is stored or carried over: open it again tomorrow and a business that has
since filled its Tuesday is no longer in the count.</p>
${mid !== null && n >= ENOUGH
      // The one piece of arithmetic on this page that is not simply a minimum
      // or a maximum, so it is the one that has to be spelled out. Calling a
      // median an average is how a single very large job ends up quietly
      // describing a whole trade.
      ? `<p>The middle figure is the median: line all ${n} prices up in order and it is
the one in the centre, or the midpoint of the two in the centre when there is an
even number of them. It is not an average, which one unusually big job would
drag.</p>` : ''}
<p>A business that covers five neighbourhoods offers the same free hour in all
five, and this page counts that hour once.</p>
${samples > 0 ? `<p>${escapeHtml(samples === n
      ? (n === 1
        ? 'The one listing behind these figures is a sample'
        : `All ${n} listings behind these figures are samples`)
      : `${samples} of the ${n} listings behind these figures ${
        plural(samples, 'is a sample', 'are samples')}`)} we seeded ourselves so the map
is not blank, rather than a business trading today.</p>` : ''}
<h3>What that tells you</h3>
<p>What this work is being asked for on this site today, by the people who would
do it. Every price above is attached to a particular hour of a particular
business's week, which is why the cheapest of them has a link straight to it
rather than a phone number.</p>
${evidence.differing > 0
      // Only where the rows can carry the claim. On a trade where no job name is
      // listed twice there is no spread to point at, and the sentence would be
      // describing a table the reader can see does not contain it.
      ? `<p>And where two businesses list the same job name, it tells you how far apart
they are on it: ${evidence.differing} ${
        plural(evidence.differing, 'job name', 'job names')} in the table above ${
        plural(evidence.differing, 'is', 'are')} listed by more than one business at more
than one price.</p>` : ''}
<h3>What it does not tell you</h3>
<p>What ${escapeHtml(lower)} costs in general. ${n} ${
      plural(n, 'listing', 'listings')} from ${businesses} ${
      plural(businesses, 'business', 'businesses')} is not the trade — it is the part of
the trade that is on ${escapeHtml(SITE_NAME)} and has an hour free this week.</p>
<p>So there is no typical price on this page and no average for the work at
large, because we have not measured one and we are not going to guess. If that is
the figure you came for, this is not the page that has it.</p>
<p>A listed price is also what the business is asking for the labour, not
necessarily the final bill: where a job needs a part that has to be seen first,
that price is quoted to you separately and nothing is fitted until you approve
it.</p>
</section>`
    : '';

  /**
   * The contents list, assembled from the sections this render actually
   * produces.
   *
   * The page is long enough to need one, which is why the reference
   * marketplace carries one. A contents list offering a heading the page does
   * not contain is worse than none, so the entries are built here beside the
   * conditions that decide whether each section is drawn, and the ids are the
   * ones those sections carry. web/src/pages/CostGuide.tsx builds the same
   * list against the same ids.
   */
  const toc: Array<{ id: string; label: string }> = [
    ...(n >= ENOUGH ? [{ id: 'cg-range', label: 'Listed prices today' }] : []),
    ...(n > 0 && n < ENOUGH
      ? [{ id: 'cg-thin', label: 'Too few listings to give a range' }] : []),
    // Only worth offering when there is more than one place to compare. On a
    // single-metro render the table would be one row restating the headline.
    ...(byMetro.length > 1 && currency
      ? [{ id: 'cg-metro', label: 'What it is listed at in each place' }] : []),
    ...(services.length && currency
      ? [{ id: 'cg-svc', label: 'What each job is listed at' }] : []),
    ...(costs ? [{ id: 'cg-factors', label: `What ${lower} prices depend on` }] : []),
    // NARROWED WHEN THE SECTION ABOVE ARRIVED. This was "What changes the
    // price", written when it was the only such section on the page; with a
    // cost-factor list now standing above it, that title claimed the whole
    // subject while covering only the part of it that is about this
    // marketplace. The two answer different questions — what the work costs by,
    // and what these particular listings differ by — and the headings now say
    // which is which. web/src/pages/CostGuide.tsx made the same change.
    { id: 'cg-why', label: `What changes the price on ${SITE_NAME}` },
    ...(costs?.diy ? [{ id: 'cg-diy', label: 'Doing it yourself, or booking someone' }] : []),
    ...(costs?.saving?.length ? [{ id: 'cg-save', label: 'Where the price can come down' }] : []),
    { id: 'cg-hire', label: `How to hire ${lower} on ${SITE_NAME}` },
    { id: 'cg-faq', label: `Questions about what ${lower} costs` },
    ...(n > 0 && currency
      ? [{ id: 'cg-method', label: 'How we worked these figures out' }] : []),
    { id: 'cg-near', label: `Find ${lower} near you` },
    { id: 'cg-how', label: 'How booking one works' },
    ...(related.length ? [{ id: 'cg-guides', label: 'Other cost guides' }] : []),
  ];
  const tocBlock = n > 0
    ? `<nav aria-labelledby="cg-toc"><h2 id="cg-toc">On this page</h2>
<ul class="jump">${toc.map((x) => `<li><a href="#${escapeHtml(x.id)}">${
      escapeHtml(x.label)}</a></li>`).join('')}</ul></nav>`
    : '';

  const body = `${priceBar}
<p class="crumb"><a href="/">${escapeHtml(SITE_NAME)}</a> › <a href="${
    escapeHtml(tradePath(entry.slug))}">${escapeHtml(label)}</a> › Cost</p>
<h1>What does ${escapeHtml(lower)} cost?</h1>
${/*
  WHERE THE REFERENCE MARKETPLACE'S BYLINE AND "LAST UPDATED" GO.

  They sign their cost guides with an author and a date, which is right for a
  piece of writing somebody edits. Nobody edits this: it is a count taken off
  the listings while the reader waits. A date here would be a claim about a
  document that does not exist, so what stands in its place is the true version
  of the same promise.
*/''}<p class="note">Counted live. These figures are read off the listings each
time the page is built, so there is no author and no last-updated date to
print.</p>
${integrity}
<section>${headline}</section>
${keyBox}
${tocBlock}
${metroTable}
${table}
${factorBlock}
<section>
<h2 id="cg-why">What changes the price on ${escapeHtml(SITE_NAME)}</h2>
<p class="note">Three things about the listings above in particular, as against
the trade in general. Only three, because these are the only ones we can actually
stand behind.</p>
<h3>How long the job takes</h3>
<p>Every listing above is a block of a business's day with a length on it, set by
the business rather than by us. A longer block is more of their day, and it is
priced that way by the person whose day it is.</p>
${evidence.shortest !== null && evidence.longest !== null
    && evidence.shortest !== evidence.longest
  // Only when the two ends are genuinely different: printing "between 90 min
  // and 90 min" to illustrate a spread would be using a number to say the
  // opposite of what it says.
  ? `<p>The jobs listed above run from ${escapeHtml(duration(evidence.shortest))} to ${
    escapeHtml(duration(evidence.longest))}, which is most of why the prices beside them
are as far apart as they are.</p>` : ''}
<h3>Whether it needs parts</h3>
<p>Parts are handled apart from the price on the card, and the booking page says
which way round it is for the service you are looking at: either parts are
included in that price, or they are quoted separately. Where they are quoted the
price on the card is the labour, the business sends you a price for the part in
your messages once they can see what is needed, and nothing is fitted until you
approve that price.</p>
<h3>Who you are booking</h3>
<p>Every business on ${escapeHtml(SITE_NAME)} sets its own prices, sets aside its own
amount of time, and lists only the parts of the city it covers. There is no rate
card here and no suggested price: two businesses can list the same job for
different amounts and both of them are right about their own work.</p>
${evidence.differing > 0
  // A sentence that opens on a digit reads as a caption rather than as prose,
  // so the count is moved off the front of it.
  ? `<p>In the table above, ${evidence.differing} ${
    plural(evidence.differing, 'job name is', 'job names are')} listed by more than one
business at more than one price, which is what that looks like in practice.</p>`
  : ''}
</section>
${diyBlock}
${saveBlock}
<section>
${/*
  HOW TO HIRE, WITHOUT THE PART WE CANNOT SAY.

  The reference marketplace's "how to hire a reliable X" is half advice and
  half a claim that its people have been checked. We check nobody, so every
  line here is a fact about what this site puts in front of a reader — and two
  of them are the places where the honest answer is that we do not know.
*/''}<h2 id="cg-hire">How to hire ${escapeHtml(lower)} on ${escapeHtml(SITE_NAME)}</h2>
<p class="note">What there is to go on before you book, and what there is not.</p>
<h3>Read the price and the length together</h3>
${/*
  Deliberately not "the table above": on a trade with nothing listed there is no
  table, and this section is drawn either way because it is about how to choose
  rather than about today's rows.
*/''}<p>Every listing is a block of one business's day: a price, and the time
they have set aside for the work. The cheapest is not always the same job — a
shorter block is less of their day — so every listing carries both, and the
booking page shows both again before you commit to anything.</p>
<h3>Check what the price covers</h3>
<p>The booking page says whether parts are included in the price or quoted
separately. Where they are quoted, the price is the labour, and the business
sends you a price for the part in your messages once they can see what is
needed.</p>
<h3>Take the card at face value</h3>
<p>A business is shown with a rating, a review and a count of completed jobs
only where it has them, and with none of those where it has none. Nothing on a
business's page is verified by us: a licence or an insurance detail is what that
business says about itself, and the issuing board's public register is the place
to check one.</p>
<h3>Check who turns up</h3>
<p>The business's vehicle details are shown to you and the vehicle at your door
has to match them. You give them a start code when they arrive, and photographs
are taken before the work starts, while it is going on, and after it is
finished.</p>
</section>
<section>
<h2 id="cg-faq">Questions about what ${escapeHtml(lower)} costs</h2>
<p class="note">Where these figures come from, and what you are actually paying
for.</p>
${faqBlock}
</section>
${methodBlock}
<section>
<h2 id="cg-near">Find ${escapeHtml(lower)} near you</h2>
${linkList([
    {
      href: tradePath(entry.slug),
      text: mine.length
        ? `${mine.length} ${plural(mine.length, 'appointment', 'appointments')} open right now`
        : `The listing page for ${lower}`,
    },
    ...(bookable && currency ? [{
      href: `/book/${bookable.gap_id}`,
      text: `Book the cheapest one: ${money(bookable.price_cents, currency)}`,
      // The second sentence only exists when the two differ — that is, when a
      // seeded listing is undercutting every real one. Without it the summary
      // box above reports a lower "cheapest open right now" than the button
      // down here charges, and the reader is left to work out which of the two
      // numbers on one page is lying to them. It is the same sentence in
      // web/src/pages/CostGuide.tsx.
      sub: `${bookable.service_name} with ${bookable.business_name}, ${bookable.when}${
        cheapest && cheapest.gap_id !== bookable.gap_id
          ? '. The cheapest listing on this page is a sample, so this is the '
            + 'cheapest one that can be booked.'
          : ''}`,
      // /book/ is Disallowed in robots.txt — see the note over the same
      // attribute in `slotItem`.
      rel: 'nofollow',
    }] : []),
    ...(category
      ? [{ href: `/browse/${category.key}`, text: category.label }] : []),
  ])}
${here.length ? `<h3>${here.length === 1
      ? 'The neighbourhood it is open in'
      : `The ${here.length} neighbourhoods it is open in`}</h3>
${linkList(here.map((x) => ({
        href: `/near/${x.area.slug}/${tradeSlug(entry.slug)}`,
        text: `${label} in ${x.area.name}`,
        sub: `${x.n} open`,
      })))}
<p class="note"><a href="/near">Every neighbourhood ${escapeHtml(SITE_NAME)} covers</a>${
    METROS.map((m) => ` · <a href="${escapeHtml(metroPath(m))}">${escapeHtml(m.name)}</a>`).join('')
}</p>` : ''}
</section>
<section>
${/*
  Their "How it works" band, with our facts in it. Three steps, each one
  something the product does today, and the second says which half of paying is
  built — the same sentence every other surface here gives.
*/''}<h2 id="cg-how">How booking one works</h2>
<p class="note">Three steps, and nothing between them that needs a phone
call.</p>
${/*
  A real ordered list, because these are three steps in an order — the same
  markup web/src/pages/CostGuide.tsx renders, so the two versions of this URL
  are the same document and not merely the same words.
*/''}<ol class="steps">
<li><h3>Find an hour that is already free</h3>
<p>Every listing on ${escapeHtml(SITE_NAME)} is unbooked working time — a job
that cancelled, or a day that did not fill. You are choosing a particular hour
from a particular business, not asking around for quotes.</p></li>
${/*
  This band says nothing about money on purpose. What the site claims about
  paying is one answer in the FAQ above and it is written in one place; a
  second telling of it here is how a page ends up with two versions of the same
  promise, which is exactly what PaymentState.tsx in the app exists to stop.
*/''}<li><h3>Book it, and it is held</h3>
<p>The hour comes off that business's day the moment you book it and stops
being offered to anybody else. What happens about money is answered in the
questions above.</p></li>
<li><h3>They arrive, and the work is recorded</h3>
<p>The vehicle at your door has to match the details you were shown, you give
them a start code, and photographs are taken before, during and after the
work.</p></li>
</ol>
</section>
${related.length ? `<section>
<h2 id="cg-guides">Other cost guides</h2>
<p class="note">${category
      ? `The rest of ${escapeHtml(category.label.toLowerCase())}, priced the same way
this page is.`
      : `The trades with the most listed on ${escapeHtml(SITE_NAME)} right now, priced
the same way this page is.`} Each one counts its own figures off the businesses
on ${escapeHtml(SITE_NAME)} the moment it is opened.</p>
${linkList(related.map((r) => ({
        href: costPath(r.trade.slug),
        text: `What ${r.trade.label.toLowerCase()} costs`,
        sub: r.n > 0
          ? `${r.n} ${plural(r.n, 'price', 'prices')} listed`
          : 'nothing listed today',
      })))}
<p class="note"><a href="/cost">Every cost guide on ${escapeHtml(SITE_NAME)}</a></p>
</section>` : ''}
<p class="foot">Every price on this page was listed by the business that would do
the work, and counted at the moment the page was built. It is what they are
asking today, not an average of the trade.</p>`;

  // A figure in a search snippet is a claim made outside the page, where the
  // "sample listing" label beside it cannot follow — so the snippet quotes
  // only prices a trading business is asking. Same rule as cheapestReal.
  const realCents = priced.filter((s) => !s.is_sample)
    .map((s) => s.price_cents).sort((a, b) => a - b);
  const realLow = realCents[0] ?? null;
  const realMid = median(realCents);

  /*
    THE COUNT IN THE SNIPPET HAD TO JOIN THE PRICES IN IT.

    The two prices above were already real-only and carefully commented as such,
    and the sentence they sat in opened `${n} ... prices listed on Round The Way
    right now` — `n` being every listing, seeded ones included. So on the day
    this site went live with sample inventory and nothing else, twenty-two of
    these thirty-nine guides published a search snippet reading "6 house
    cleaning prices listed on Round The Way right now. Asking prices counted off
    the listings, not a survey and not an average." Every one of those six was a
    business we invented, and the two clauses that would have been caught by the
    real-only rule — the from and the middle — simply dropped out, leaving the
    fabricated part of the sentence standing alone and sounding more confident
    for having lost its qualifications.

    So the branch is on the real count now, and where there are none the
    description says what the page says. A guide that still has its written
    cost factors says so, because that is what a reader arriving on it will
    actually find and it is the reason such a guide is still allowed to be
    indexed at all — see `noindex` below.
  */
  const description = realCents.length === 0
    ? (costs
      ? `What ${lower} costs, and what makes one job dearer than another. Nothing is `
        + `listed in this trade on ${SITE_NAME} right now, and we do not estimate a `
        + `price we cannot count.`
      : `What ${lower} costs on ${SITE_NAME}. Nothing is listed in this trade right now, `
        + `and we do not estimate a price we cannot count.`)
    : `${realCents.length} ${lower} ${plural(realCents.length, 'price', 'prices')} listed `
      + `on ${SITE_NAME} right now`
      + `${realLow !== null && currency ? `, from ${money(realLow, currency)}` : ''}`
      + `${realMid !== null && currency ? `, middle ${money(realMid, currency)}` : ''}. `
      + `Asking prices counted off the listings, not a survey and not an average.`;

  return seoPage({
    title: `What does ${lower} cost?`,
    description,
    canonical: url,
    /*
      THIRTY-NINE OF THESE ASKED TO BE INDEXED ON A SITE WITH NO REAL PRICES ON
      IT, AND THAT WAS THE WHOLE SEARCH SURFACE.

      This was a flat `false`, and it was the last flat `false` left on a page
      built out of a slug. Every other generated shape on this site — the
      neighbourhood, the trade, the trade-in-a-place square, the metro, the
      geography hub, the business profile — decides by whether it has real,
      non-seeded inventory behind it. The cost guides did not, so on the morning
      the site went live with sample data as its only inventory these were
      thirty-nine of the roughly fifty indexable URLs the whole site had. That
      is the shape of a doorway set: one template, one slug substituted through
      it, submitted in bulk, with nothing counted behind any of it.

      THE TEST IS NOT "REAL INVENTORY" THOUGH, AND THAT IS THE ONE PLACE THIS
      PAGE DIFFERS FROM THE OTHERS. A trade page with nothing open is its own
      boilerplate with a heading changed, because everything on it is a count.
      A cost guide is not only counts: `costsFor` in lib/costfacts.ts carries
      several hundred words per trade of written, hand-authored explanation of
      what makes one job of this kind dearer than another, plus where the
      do-it-yourself line falls, and none of it is generated, templated or
      shared between trades. A page carrying that answers the question in its
      own title whether or not anybody has an hour free this afternoon, and
      taking it out of the index would be hiding the only genuinely unique
      writing on the site.

      So a guide is indexable when it has something that is neither fabricated
      nor boilerplate: real listed prices, or the written cost factors. Thirty-
      six of the thirty-nine trades have an entry in costfacts.ts. The three
      that do not are the pop-up retail trades — the boutique truck, the
      bookstore and the farmer's market stall — and with no real listings their
      pages are the FAQ, the three-step band and the closing paragraph that
      thirty-eight other pages carry word for word, under a different heading.
      Those three go noindex until either half of the test passes, and the
      honest way to fix them is to write their cost factors rather than to
      loosen this.

      `sitemapXml` submits cost guides on the same test, because a file that
      offers a URL answering noindex is counted against the whole file.
    */
    noindex: realCents.length === 0 && !costs,
    jsonLd: {
      '@context': 'https://schema.org',
      '@graph': [
        breadcrumbLd(base, [
          { name: SITE_NAME, url: '/' },
          { name: label, url: tradePath(entry.slug) },
          { name: 'Cost', url: path },
        ]),
        // The same six the block above renders. Emitted whether or not this
        // trade has anything listed today: these answers are about how the
        // page and the product work, and they are as true on an empty day as
        // on a busy one -- unlike the figures, which is why none of them are
        // in here.
        {
          '@type': 'FAQPage',
          mainEntity: faqs.map((f) => ({
            '@type': 'Question',
            name: f.q,
            acceptedAnswer: { '@type': 'Answer', text: f.a },
          })),
        },
      ],
    },
    body,
    areas: idx.areas,
    shell: opts.shell,
  });
}

// ---------------------------------------------------------------------------
// 3c. /cost — the hub every cost guide links up to
//
// Each guide above closes with "Every cost guide on Round The Way" pointing here,
// and until now that link landed a crawler on the empty SPA shell: the one
// page that enumerates the forty guides was the one page with nothing in it to
// read. web/src/pages/CostIndex.tsx is what a visitor with JavaScript sees,
// and this renders the same sections from the same rows.
//
// THE COUNTING RULE, which this page inherits from the guides it indexes:
// every figure is a price a business is asking, counted from the rows fetched
// in this request. No national average, no typical cost, no "expect to pay".
// And below ENOUGH listed prices a trade gets no range at all — two prices are
// two prices, and calling them a spread invents a pattern out of a
// coincidence.
// ---------------------------------------------------------------------------

/** One row of the index: a trade, and what is listed under it right now. */
interface PricedTrade {
  trade: Trade;
  /** Listings counted, in `currency` and no other. */
  n: number;
  businesses: number;
  samples: number;
  currency: string | null;
  low: number | null;
  mid: number | null;
  high: number | null;
}

export async function costIndexPage(env: Env, opts: PageOptions = {}): Promise<string> {
  const base = baseUrlOf(env);
  const idx = await liveIndex(env);
  const url = `${base}/cost`;

  // One row per opening, per trade. mapData offers a whole free day in every
  // neighbourhood its owner covers, so counting the tagged rows would turn one
  // business's Tuesday into a spread and make this page disagree with the
  // guide it links to.
  const byTradeSlug = new Map<string, PlacedSlot[]>();
  for (const s of distinctGaps(idx.slots)) {
    const key = (s.trade ?? '').trim().toLowerCase();
    if (!key) continue;
    const list = byTradeSlug.get(key);
    if (list) list.push(s); else byTradeSlug.set(key, [s]);
  }

  // The catalogue is the spine, not the listings: a quiet trade keeps its name
  // and its place here, because its guide says plainly that nothing is listed
  // and hiding it would leave the links in every guide's closing block
  // pointing at a page this index denies exists.
  const rows: PricedTrade[] = TRADE_CATEGORIES.flatMap((c) => c.trades.map((trade) => {
    const mine = byTradeSlug.get(trade.slug) ?? [];

    // One currency only, for the reason the guides give: a median taken across
    // dollars and pounds is not a price, it is an average of two units.
    const counts = new Map<string, number>();
    for (const s of mine) counts.set(s.currency, (counts.get(s.currency) ?? 0) + 1);
    const currency = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const priced = currency ? mine.filter((s) => s.currency === currency) : [];
    const cents = priced.map((s) => s.price_cents).sort((a, b) => a - b);

    return {
      trade,
      n: cents.length,
      businesses: new Set(priced.map((s) => s.operator_id)).size,
      samples: priced.filter((s) => s.is_sample).length,
      currency,
      low: cents[0] ?? null,
      mid: median(cents),
      high: cents[cents.length - 1] ?? null,
    };
  }));

  // Cheapest first inside the priced group: somebody who arrived here is
  // worried about the price, so the smallest number goes at the top.
  const ranged = rows.filter((r) => r.n >= ENOUGH)
    .sort((a, b) => (a.low ?? 0) - (b.low ?? 0) || a.trade.label.localeCompare(b.trade.label));
  const thin = rows.filter((r) => r.n > 0 && r.n < ENOUGH)
    .sort((a, b) => a.trade.label.localeCompare(b.trade.label));
  const bare = rows.filter((r) => r.n === 0)
    .sort((a, b) => a.trade.label.localeCompare(b.trade.label));

  const listings = rows.reduce((sum, r) => sum + r.n, 0);
  const samples = rows.reduce((sum, r) => sum + r.samples, 0);

  /**
   * THE SAME GUIDES, GROUPED THE WAY A PERSON LOOKS FOR ONE.
   *
   * A price index grouped under headings a reader recognises — the things you
   * would want done to a car, to a house, to yourself — is the better way in
   * for somebody who knows the kind of thing they want without knowing what
   * this catalogue calls it.
   *
   * IT IS THE SECOND WAY IN RATHER THAN THE FIRST, and that ordering is the
   * whole argument of these pages. The three groups above are cut by how much
   * is actually listed, which is the cut that decides whether a figure here can
   * be trusted at all; burying that under eight friendly category headings
   * would let a trade with two listings sit in a tidy row beside one with
   * thirty and look identical. So the honest cut leads and this repeats the
   * same guides underneath it for browsing.
   *
   * Every trade appears here exactly once and every one is a link, including
   * the ones with nothing listed — their pages say so plainly, which is the
   * honest answer to "what does this cost" on a quiet afternoon.
   */
  const bySlug = new Map(rows.map((r) => [r.trade.slug, r] as const));
  const grouped = TRADE_CATEGORIES
    .map((c) => ({
      label: c.label,
      trades: c.trades.flatMap((t) => {
        const row = bySlug.get(t.slug);
        return row ? [row] : [];
      }),
    }))
    .filter((c) => c.trades.length > 0);

  const sampleClause = samples === 0 ? '' : ` ${samples === listings
    ? (listings === 1 ? 'That listing is a sample' : `All ${listings} are sample listings`)
    : `${samples} of them ${plural(samples, 'is a sample listing', 'are sample listings')}`
  } we seeded ourselves rather than a business trading today.`;

  // The sentence that makes these pages honest, above the figures rather than
  // in a footnote under them. Softened into "the average cost of X is", this
  // page becomes the thing the cost guides were written to avoid.
  const flag = listings === 0
    ? `Nothing is listed on ${escapeHtml(SITE_NAME)} at the moment, so there is no
price for us to report in any trade. We do not have national survey figures and
we are not going to estimate any.`
    : `These are the prices <b>businesses on ${escapeHtml(SITE_NAME)} are asking right
now</b> — ${listings} ${plural(listings, 'listing', 'listings')} counted the moment
this page loaded. They are not a national average and they are not a survey. We
do not have either of those, so we do not quote one.${escapeHtml(sampleClause)}`;

  // Each of the three groups can be a screen tall, and somebody arriving from
  // a guide's closing block is usually after one of them in particular.
  const jumps = [
    ranged.length ? `<li><a href="#ix-ranged">Listed prices today (${ranged.length})</a></li>` : '',
    thin.length
      ? `<li><a href="#ix-thin">Too few listings to give a range (${thin.length})</a></li>` : '',
    bare.length ? `<li><a href="#ix-bare">Nothing listed right now (${bare.length})</a></li>` : '',
    grouped.length
      ? `<li><a href="#ix-cats">Every guide by category (${grouped.length})</a></li>` : '',
    listings > 0 ? '<li><a href="#ix-method">How these figures are worked out</a></li>' : '',
  ].join('');

  const rangedRows = linkList(ranged.map((r) => ({
    href: costPath(r.trade.slug),
    text: r.trade.label,
    // Both figures are counted and neither is rounded, averaged or called
    // typical. The middle one is what a reader should carry away, so it is
    // named rather than left to be guessed at from the two ends.
    sub: `${r.n} ${plural(r.n, 'listing', 'listings')} from ${r.businesses} ${
      plural(r.businesses, 'business', 'businesses')} · ${
      r.currency && r.low !== null && r.high !== null
        ? (r.low === r.high
          ? money(r.low, r.currency)
          : `${money(r.low, r.currency)} – ${money(r.high, r.currency)}`)
        : ''}${r.currency && r.mid !== null ? `, middle ${money(r.mid, r.currency)}` : ''}`,
  })));

  const body = `
<p class="crumb"><a href="/">${escapeHtml(SITE_NAME)}</a> › Cost</p>
<h1>What things cost on ${escapeHtml(SITE_NAME)}<span class="count">${rows.length} ${
    plural(rows.length, 'cost guide', 'cost guides')}, ${ranged.length} of them with a
listed range, ${listings} ${plural(listings, 'listing', 'listings')} counted</span></h1>
<p class="lede">${flag}</p>
${rows.length ? `<p class="note">One guide for every trade ${escapeHtml(SITE_NAME)}
lists, ${rows.length} in all, grouped by how much is behind the figures rather
than alphabetically. The quiet trades are here too: their pages say nothing is
listed today rather than estimating a price.</p>` : ''}
${jumps ? `<nav class="toc" aria-label="On this page"><h2>On this page</h2>
<ul>${jumps}</ul></nav>` : ''}
${ranged.length ? `<section>
<h2 id="ix-ranged">Listed prices today</h2>
<p class="note">The cheapest and dearest of what is listed in each trade, with
the one in the middle beside them. Open a trade for every job in it by name, and
how long each one is listed for.</p>
${rangedRows}
</section>` : ''}
${thin.length ? `<section>
<h2 id="ix-thin">Too few listings to give a range</h2>
<p class="note">Fewer than ${ENOUGH} prices are listed in each of these at the
moment, which is not enough to say what the work usually costs. Their pages show
exactly what is listed, and nothing more.</p>
${linkList(thin.map((r) => ({
    href: costPath(r.trade.slug),
    text: r.trade.label,
    sub: `${r.n} ${plural(r.n, 'price', 'prices')} listed — no range`,
  })))}
</section>` : ''}
${bare.length ? `<section>
<h2 id="ix-bare">Nothing listed right now</h2>
<p class="note">No prices are listed in these trades at this moment. An opening
is an hour a business has free, so a trade can be empty one hour and full the
next — each page below says so plainly rather than estimating a price from
nothing, and takes an alert for when somebody lists one.</p>
${linkList(bare.map((r) => ({
    href: costPath(r.trade.slug),
    text: `What ${r.trade.label.toLowerCase()} costs`,
  })))}
</section>` : ''}
${grouped.length ? `<section>
<h2 id="ix-cats">Every guide by category</h2>
<p class="note">The same ${rows.length} guides again, grouped the way somebody
looks for one rather than by how much is behind the figures. The price beside a
trade is the range listed in it right now; a trade with too little listed for a
range, or with nothing listed, says so instead.</p>
${grouped.map((c) => {
    // Counted per category so the line under the heading is a fact about this
    // render rather than a fixed description of the catalogue. A category where
    // nothing is listed says that plainly instead of printing "0 with a listed
    // range".
    const withRange = c.trades.filter((t) => t.n >= ENOUGH).length;
    return `<h3>${escapeHtml(c.label)}</h3>
<p class="note">${c.trades.length} ${plural(c.trades.length, 'guide', 'guides')}${
      withRange > 0
        ? `, ${withRange} with a listed range today`
        : ', none with enough listed for a range today'}</p>
${linkList(c.trades.map((t) => ({
      href: costPath(t.trade.slug),
      text: t.trade.label,
      sub: t.n >= ENOUGH && t.currency && t.low !== null && t.high !== null
        ? (t.low === t.high
          ? money(t.low, t.currency)
          : `${money(t.low, t.currency)} – ${money(t.high, t.currency)}`)
        : t.n > 0 ? `${t.n} listed, no range` : 'nothing listed',
    })))}`;
  }).join('')}
</section>` : ''}
${listings > 0 ? `<section>
${/*
  THE METHOD, ON THE HUB AS WELL AS ON EACH GUIDE.

  A page of prices that never says where they came from is asking to be trusted
  on its typography. The reference marketplace answers that with millions of
  estimates and hundreds of thousands of professionals; we have no survey and no
  estimates database, so what goes here is the arithmetic this render actually
  performed and the plain statement of what it does not cover. Each guide
  repeats it for its own trade in more detail; this is the version for the page
  that links to all of them.
*/''}<h2 id="ix-method">How these figures are worked out</h2>
<p class="note">There is no survey behind this page and no editor. Here is the
whole method.</p>
<p class="note">Every figure above is a price a business on ${escapeHtml(SITE_NAME)} set
on an appointment it has free right now. When this page was built we read ${
  listings} of them across ${ranged.length + thin.length} ${
  plural(ranged.length + thin.length, 'trade', 'trades')} that have something listed.
Nothing is stored or carried over: open it again tomorrow and a business that has
since filled its Tuesday is no longer in the count. A business that covers five
neighbourhoods offers the same free hour in all five, and this page counts that
hour once.</p>
<p class="note">The middle figure on a row is the median — line that trade's
prices up in order and it is the one in the centre, or the midpoint of the two in
the centre. It is not an average, which one unusually large job would drag. Below
${ENOUGH} listed prices there is no middle worth reporting and no range, so those
trades are grouped separately above rather than given one.</p>
<p class="note">What this does not tell you is what any of these trades costs in
general. It is the part of each trade that is on ${escapeHtml(SITE_NAME)} and has an
hour free this week, which is not the same thing — so there is no typical price
anywhere on this page and no average for any of the work at large. If that is the
figure you came for, this is not the page that has it.</p>
</section>` : ''}
<section>
<h2>The other ways in</h2>
${linkList([
    { href: '/browse', text: `Every service ${SITE_NAME} covers` },
    { href: '/near', text: 'Every neighbourhood' },
    ...metroLinks(),
  ])}
<p class="note">Every price on this page was listed by the business that would
do the work, and counted at the moment the page was built. It is what they are
asking today, not an average of the trade.</p>
</section>`;

  return seoPage({
    title: 'What things cost — every cost guide',
    /*
      `listings` COUNTS THE SEEDED ROWS AND `listings - samples` DOES NOT.

      Both figures are already worked out above for the page's own use, and the
      page prints the sample count in words directly under the table. A meta
      description has nowhere to put that sentence, so the number it quotes has
      to be the one that needs no qualification — the same rule `cheapestReal`
      applies to every price quoted in a snippet on this site. Before this, the
      one hub page that is indexable on a completely empty site advertised
      itself as "priced from the 43 listings businesses have open right now"
      when all forty-three were ours.
    */
    description: listings - samples > 0
      ? `${rows.length} cost ${plural(rows.length, 'guide', 'guides')} on ${SITE_NAME}, `
        + `priced from the ${listings - samples} `
        + `${plural(listings - samples, 'listing', 'listings')} businesses `
        + 'have open right now. Counted live, not surveyed.'
      : `${rows.length} cost ${plural(rows.length, 'guide', 'guides')} on ${SITE_NAME}, one `
        + 'for every trade listed. Each one counts what is listed the moment you ask it.',
    canonical: url,
    noindex: false,
    jsonLd: {
      '@context': 'https://schema.org',
      '@graph': [breadcrumbLd(base, [
        { name: SITE_NAME, url: '/' },
        { name: 'Cost', url: '/cost' },
      ])],
    },
    body,
    areas: idx.areas,
    shell: opts.shell,
  });
}

// ---------------------------------------------------------------------------
// 3d. /browse — the whole catalogue, and the top of the two-step browse
//
// Left behind for the same reason /cost was: the category pages under it were
// given a server twin and the index above them was not, so the header's
// "Browse" and the footer's "Browse services" — the two links on every page of
// this site that mean "show me everything" — landed a crawler on the empty
// shell. web/src/pages/BrowseIndex.tsx is the React half.
// ---------------------------------------------------------------------------

/**
 * The four questions the browse hub answers, and the answers word for word.
 *
 * Mirrors FAQS in web/src/pages/BrowseIndex.tsx, which renders this same URL
 * for a visitor with JavaScript. A FAQPage block is a promise that the answer
 * quoted in a search result is on the page when somebody arrives, so two copies
 * that drift break that promise silently: any edit here has to be made there,
 * and the two payment answers are built out of this file's own copies of
 * PAY_TODAY_SHORT and ACCOUNT_TODAY_SHORT, which test/public-payload.test.ts
 * already pins against the React tree.
 *
 * These four are deliberately about the SITE rather than about any trade — the
 * per-trade questions belong on the per-trade page, where they can name the
 * work. Nothing here about vetting, insurance, licensing, guarantees or how
 * fast anybody replies, because none of that is something we could stand
 * behind.
 */
function browseFaqs(): Array<{ q: string; a: string }> {
  return [
    {
      q: 'What is an open appointment?',
      a: 'Unbooked working time a local business has this week — a job that '
        + 'cancelled, or a day that did not fill. You are picking a particular '
        + 'hour from a particular business rather than asking around for quotes, '
        + 'which is why every listing carries a time and a price before you '
        + 'press anything.',
    },
    {
      q: 'Do I need an account?',
      a: ACCOUNT_TODAY_SHORT,
    },
    {
      q: 'How do I pay?',
      a: `${PAY_TODAY_SHORT} The labour is paid for here, on the site, at the `
        + 'moment you book — with no cash and nothing paid at the door.',
    },
    {
      q: 'Who sets the prices?',
      a: 'The business doing the work sets it, and every price anywhere on '
        + 'Round The Way was listed by the business whose name is on the card. We '
        + 'do not price anything, mark anything up or recommend a figure.',
    },
  ];
}

export async function browseIndexPage(env: Env, opts: PageOptions = {}): Promise<string> {
  const base = baseUrlOf(env);
  const idx = await liveIndex(env);
  const url = `${base}/browse`;

  // Openings per trade, one row per opening. Zero is a fact this page states
  // in words, exactly as the category page does: a bare nought where a number
  // usually means "open now" reads as a broken count rather than a quiet week.
  const open = new Map<string, number>();
  for (const s of distinctGaps(idx.slots)) {
    const t = (s.trade ?? '').trim().toLowerCase();
    if (t) open.set(t, (open.get(t) ?? 0) + 1);
  }

  const services = TRADE_CATEGORIES.reduce((sum, c) => sum + c.trades.length, 0);

  const sections = TRADE_CATEGORIES.map((c) => {
    /*
      Openings across the whole category, added up from the per-trade counts the
      rows below are about to print. It is arithmetic a reader could check by
      hand down the page, which is the only kind of total this site prints.

      The heading used to carry the size of the catalogue alone, which is the
      one number that never changes. A reader scanning nine category headings
      for somewhere to start is asking which of them has something in it this
      afternoon, and that question went unanswered until they opened one.
      web/src/pages/BrowseIndex.tsx prints the same clause in the same words.
    */
    const catOpen = c.trades.reduce((sum, t) => sum + (open.get(t.slug) ?? 0), 0);
    return `<section>
<h2><a href="/browse/${escapeHtml(c.key)}">${escapeHtml(c.label)}</a> <span class="note">${
      c.trades.length} ${plural(c.trades.length, 'service', 'services')}${catOpen > 0
      ? ` · ${catOpen} ${plural(catOpen, 'appointment', 'appointments')} open now`
      : ' · none open right now'}</span></h2>
${c.trades.length
    ? linkList(c.trades.map((t) => {
      const n = open.get(t.slug) ?? 0;
      return {
        href: tradePath(t.slug),
        text: t.label,
        // The trade's drawing, from the one mapping at the top of this file.
        // web/src/pages/BrowseIndex.tsx renders the same picture on the same
        // row, from `art` on the catalogue payload, which `tradeArt` also
        // computed — so the two halves of this URL cannot ask for different
        // files, and neither can show a row the other does not.
        img: tradeArt(t.slug),
        sub: [t.hint, n > 0
          ? `${n} ${plural(n, 'appointment', 'appointments')} open now`
          : 'None open right now'].filter(Boolean).join(' · '),
      };
    }))
    // Only reachable if the catalogue files no services under this heading,
    // which is a gap in the catalogue rather than a quiet week.
    : '<p class="note">No services are listed in this category yet.</p>'}
</section>`;
  }).join('');

  // Rendered into the page and into the structured data below out of the one
  // array, so a search engine can never be shown an answer this page does not
  // contain. Same arrangement the trade page and the cost guide already use.
  const faqs = browseFaqs();
  const faqBlock = faqs.map((f) => `<details><summary>${escapeHtml(f.q)}</summary>
<p class="note">${escapeHtml(f.a)}</p></details>`).join('');

  const body = `
<p class="crumb"><a href="/">${escapeHtml(SITE_NAME)}</a> › Browse</p>
<h1>Every service ${escapeHtml(SITE_NAME)} covers<span class="count">${
    TRADE_CATEGORIES.length} ${plural(TRADE_CATEGORIES.length, 'category', 'categories')}, ${
    services} ${plural(services, 'service', 'services')}</span></h1>
<p class="lede">Pick the job you need doing. Everything ${escapeHtml(SITE_NAME)}
covers is listed here whether or not somebody has an hour free in it this minute
— every service has its own page, which counts what is open in it and says
plainly when the answer is nothing.</p>
${sections}
<section>
${/*
  THE "HOW IT WORKS" BAND, WITH OUR FACTS IN IT.

  It goes after the catalogue rather than before it. Somebody who came here from
  a search for a job wants the list of jobs first and is entitled to leave
  without ever reading this; somebody who came here having heard the name of the
  site has scrolled past nine categories by now and is exactly the person the
  band is for. Three steps, each one something the product does today, and the
  same three the cost guide and the trade page describe in the same words — a
  reader crossing between the three levels of this browse must not find booking
  described three ways.
*/''}<h2>How booking one works</h2>
<p class="note">Three steps, and nothing between them that needs a phone
call.</p>
<ol class="steps">
<li><h3>Find an hour that is already free</h3>
<p>Everything counted on this page is unbooked working time — a job that
cancelled, or a day that did not fill. You are choosing a particular hour from a
particular business, not asking around for quotes.</p></li>
${/*
  Deliberately silent about money. What this site claims about paying is one
  answer in the questions below, taken from the two constants every other
  surface prints; a second telling of it here is how a page ends up with two
  versions of one promise.
*/''}<li><h3>Book it, and it is held</h3>
<p>The hour comes off that business's day the moment you book it and stops being
offered to anybody else. What happens about money is answered in the questions
below.</p></li>
<li><h3>They arrive, and the work is recorded</h3>
<p>The business drives to you. The vehicle at your door has to match the details
you were shown, you give them a start code, and photographs are taken before,
during and after the work.</p></li>
</ol>
</section>
<section>
<h2>Questions about ${escapeHtml(SITE_NAME)}</h2>
<p class="note">What the site is, and which parts of it are built. Anything about
one particular job is answered on that service's own page.</p>
${faqBlock}
</section>
<section>
<h2>The other way round</h2>
<p class="note">${escapeHtml(SITE_NAME)} can be read by the job, which is this
page, or by where the van is.</p>
${linkList([
    { href: '/near', text: 'Browse by neighbourhood' },
    ...metroLinks(),
    { href: '/cost', text: 'What things cost' },
  ])}
<p class="note">A service is listed here because ${escapeHtml(SITE_NAME)} covers
that work. Any count beside it was taken from the openings at the moment this
page was built.</p>
</section>`;

  return seoPage({
    title: `Every service — browse ${SITE_NAME}`,
    description: `The whole ${SITE_NAME} catalogue: ${services} services across `
      + `${TRADE_CATEGORIES.length} ${plural(TRADE_CATEGORIES.length, 'category', 'categories')}, `
      + 'each with what it has open counted the moment you ask.',
    canonical: url,
    noindex: false,
    jsonLd: {
      '@context': 'https://schema.org',
      '@graph': [
        breadcrumbLd(base, [
          { name: SITE_NAME, url: '/' },
          { name: 'Browse', url: '/browse' },
        ]),
        // The same four the block above renders, built from the same array, in
        // the shape tradePage emits. These answers are about how the product
        // works rather than about today's openings, so they are as true on an
        // empty afternoon as on a busy one — unlike the counts, none of which
        // are in here.
        {
          '@type': 'FAQPage',
          mainEntity: faqs.map((f) => ({
            '@type': 'Question',
            name: f.q,
            acceptedAnswer: { '@type': 'Answer', text: f.a },
          })),
        },
      ],
    },
    body,
    areas: idx.areas,
    shell: opts.shell,
  });
}

// ---------------------------------------------------------------------------
// 3e. /browse/:category — the middle level of the two-step browse
// ---------------------------------------------------------------------------

export async function categoryPage(
  env: Env, key: string, opts: PageOptions = {},
): Promise<string | null> {
  const here = TRADE_CATEGORIES.find((c) => c.key === (key ?? '').trim().toLowerCase());
  if (!here) return null;                       // the SPA says "no such category"

  const base = baseUrlOf(env);
  const idx = await liveIndex(env);
  const path = `/browse/${here.key}`;
  const url = `${base}${path}`;

  // Counted per trade from the rows in hand. Zero is a fact this page states
  // in words: a bare nought where a number usually means "open now" reads as a
  // broken count rather than as a quiet week.
  const open = new Map<string, number>();
  for (const s of distinctGaps(idx.slots)) {
    const t = (s.trade ?? '').trim().toLowerCase();
    if (t) open.set(t, (open.get(t) ?? 0) + 1);
  }
  const total = here.trades.reduce((sum, t) => sum + (open.get(t.slug) ?? 0), 0);

  /*
    THE SAME TOTAL WITH THE SEEDED LISTINGS TAKEN OUT, FOR THE SNIPPET ALONE.

    `total` is what the page prints, and it counts everything because every row
    it is printed beside links through to a page that labels its samples. The
    meta description is read in a search result, where nothing beside the
    number can say that six of the six are businesses we invented, so the
    sentence out there quotes this instead. It is the rule `cheapestReal`
    already applies to every price in a snippet, applied to a count.
  */
  const realOpen = new Map<string, number>();
  for (const s of distinctGaps(idx.slots.filter((x) => !x.is_sample))) {
    const t = (s.trade ?? '').trim().toLowerCase();
    if (t) realOpen.set(t, (realOpen.get(t) ?? 0) + 1);
  }
  const realTotal = here.trades.reduce((sum, t) => sum + (realOpen.get(t.slug) ?? 0), 0);

  const rows = linkList(here.trades.map((t) => {
    const n = open.get(t.slug) ?? 0;
    return {
      href: tradePath(t.slug),
      text: t.label,
      // The same drawing web/src/pages/Category.tsx puts on this same row,
      // from the same `tradeArt`. See the note over the mapping at the top of
      // this file for why the path is computed once rather than in each tree.
      img: tradeArt(t.slug),
      sub: [t.hint, n > 0
        ? `${n} ${plural(n, 'appointment', 'appointments')} open now`
        : 'None open right now'].filter(Boolean).join(' · '),
    };
  }));

  const others = TRADE_CATEGORIES.filter((c) => c.key !== here.key);

  /**
   * WHERE THE VANS ARE, as the twelve busiest neighbourhoods.
   *
   * This took `idx.areas.slice(0, 12)` — unfiltered and unsorted — which is the
   * one thing a block of links at the foot of a page must never do: the slice
   * is in whatever order mapData happened to return, so twelve of them could be
   * neighbourhoods with nothing open at all and every link would land on a page
   * with nothing on it. Somewhere quiet is dropped rather than listed at
   * nought, and the rest are busiest first then alphabetical.
   *
   * web/src/pages/Category.tsx picks the same twelve by the same rule and
   * prints the same "N appointments" beside each, because it renders this same
   * URL a moment after this markup is painted.
   */
  const places = idx.areas
    .filter((a) => a.slot_count > 0)
    .sort((a, b) => b.slot_count - a.slot_count || a.name.localeCompare(b.name))
    .slice(0, 12);

  const body = `
<p class="crumb"><a href="/">${escapeHtml(SITE_NAME)}</a> › ${escapeHtml(here.label)}</p>
${/*
  THE CATEGORY'S OWN DRAWING, AS A BANNER OVER THE HEADING.

  The same picture as that category's tile on the front page, so somebody who
  pressed a tile arrives at a page showing the thing they pressed.

  NOT lazy and this is the one image on the site that is not: it is the first
  thing under the crumb trail, so it is on screen the moment the page is, and
  `loading="lazy"` on something already in the viewport only costs a round of
  layout. Its width and height are on the element so the heading under it does
  not move when the file lands. web/src/pages/Category.tsx renders the same
  banner in the same place.
*/''}<img class="banner-art" src="${escapeHtml(categoryArt(here.key))}" alt=""
width="${CATEGORY_ART_W}" height="${CATEGORY_ART_H}" decoding="async">
<h1>${escapeHtml(here.label)}<span class="count">${total > 0
    ? `${total} open ${plural(total, 'appointment', 'appointments')} in this category`
    : 'Nothing open in this category right now'}</span></h1>
<p class="lede">Pick the job you need doing. Every service below has its own
page, which counts what is open in it and says plainly when the answer is
nothing.</p>
${rows || '<p class="note">No services are listed in this category yet.</p>'}
${/*
  THE COST BAND, AS ONE TILE RATHER THAN THIRTEEN.

  The obvious version of this is a second column of this category's services
  with "What X costs" in front of each name — the same labels the reader has
  just finished scanning, doubling the page to add one word to each. So it is
  one tile into the cost index, and the per-trade guide is offered from the
  trade page, where the page is already about that one trade and the count of
  listed prices can be printed beside the link.

  NO FIGURE ON IT. This page has counted openings, not prices, and a number here
  would be either the wrong one or an invented one. web/src/pages/Category.tsx
  puts the same tile in the same place, in these words.
*/''}<a class="tile" href="/cost"><b>What these jobs cost</b>
<span>Every price listed on ${escapeHtml(SITE_NAME)} right now, by trade — the lowest,
the highest and the middle, counted from the businesses themselves rather than
quoted from a survey.</span></a>
<section>
<h2>By neighbourhood</h2>
${places.length
    ? `<p class="note">The ${places.length === 1
      ? 'neighbourhood' : `${places.length} neighbourhoods`} with the most open right
now, across every trade rather than only this category.</p>
${linkList(places.map((a) => ({
      href: `/near/${a.slug}`,
      text: `Open appointments in ${a.name}`,
      sub: `${a.slot_count} ${plural(a.slot_count, 'appointment', 'appointments')}`,
    })))}`
    : `<p class="note">Nothing is open in any neighbourhood at the moment. The index
below lists every one ${escapeHtml(SITE_NAME)} covers, and each takes an alert for when
an hour appears in it.</p>`}
<p class="note"><a href="/near">Every neighbourhood</a>${
    METROS.map((m) => ` · <a href="${escapeHtml(metroPath(m))}">${escapeHtml(m.name)}</a>`).join('')
}</p>
</section>
<section>
<h2>Looking for something else?</h2>
${linkList(others.map((c) => ({ href: `/browse/${c.key}`, text: c.label })))}
</section>`;

  return seoPage({
    title: `${here.label} — mobile services`,
    description: realTotal > 0
      ? `${here.label} on ${SITE_NAME}: ${here.trades.length} services and ${realTotal} `
        + `${plural(realTotal, 'appointment', 'appointments')} open right now, counted live.`
      : `${here.label} on ${SITE_NAME}. ${here.trades.length} services, with what each one `
        + `has open counted the moment you ask.`,
    canonical: url,
    noindex: false,
    jsonLd: {
      '@context': 'https://schema.org',
      '@graph': [breadcrumbLd(base, [
        { name: SITE_NAME, url: '/' },
        { name: here.label, url: path },
      ])],
    },
    body,
    areas: idx.areas,
    shell: opts.shell,
  });
}

// ---------------------------------------------------------------------------
// 3e. / — the front door
//
// IT WAS NOT SERVED BY THIS FILE AT ALL, and that is the single largest hole
// the search surface had. `/` matched no pattern in WORKER_PATHS and had no
// route, so the assets binding answered it directly with the SPA shell: an
// empty <div id="root">, no canonical, no heading, no sentence and no link. A
// crawler that runs no JavaScript — and every crawler that is not Googlebot,
// and Googlebot on its first pass — found a document with nothing in it at the
// one address every external link to this site points at.
//
// The cost is not one page. Click depth is measured from the root, and a root
// with no links has no depth to anything: every /near page, every trade page
// and every profile was reachable only from the sitemap, which is a hint and
// not a path. A site whose home page links to nothing is a site whose home
// page passes nothing on.
// ---------------------------------------------------------------------------

/**
 * WHO THIS SITE IS, said once, where a search engine looks for it.
 *
 * There was no Organization node anywhere in the repository, and no WebSite
 * node either — so nothing on the site said what the brand is called, what its
 * logo is, or that it has a search page, and a query for the brand name had
 * nothing to attach a knowledge panel to.
 *
 * The two nodes are joined by `@id` rather than nested, because everything
 * else the site emits can then point at the same organisation instead of
 * describing it again. The SearchAction names the real GET form at /search?q=
 * — the one in SiteHeader.tsx, which navigates to exactly that URL — and
 * nothing else: a searchbox template pointing at an endpoint that does not
 * exist is the most common way this node is got wrong.
 *
 * /search is Disallowed in robots.txt and that is not a contradiction. The
 * Disallow keeps a crawler out of an unbounded set of thin results pages; the
 * SearchAction tells a search engine where to send a PERSON who wants to
 * search this site. They are instructions to two different readers.
 */
function brandLd(base: string): unknown[] {
  return [
    {
      '@type': 'Organization',
      '@id': `${base}/#organization`,
      name: SITE_NAME,
      url: `${base}/`,
      logo: `${base}/icon.svg`,
      image: `${base}/og.png`,
      description: `${SITE_NAME} lists appointments that local mobile businesses have `
        + 'free this week, at the price each one set.',
      areaServed: METROS.map((m) => ({
        '@type': 'City', name: m.name, address: postalAddress({
          locality: m.name, region: m.state, country: m.country,
        }),
      })),
    },
    {
      '@type': 'WebSite',
      '@id': `${base}/#website`,
      url: `${base}/`,
      name: SITE_NAME,
      publisher: { '@id': `${base}/#organization` },
      potentialAction: {
        '@type': 'SearchAction',
        target: {
          '@type': 'EntryPoint',
          urlTemplate: `${base}/search?q={search_term_string}`,
        },
        'query-input': 'required name=search_term_string',
      },
    },
  ];
}

export async function homePage(env: Env, opts: PageOptions = {}): Promise<string> {
  const base = baseUrlOf(env);
  const idx = await liveIndex(env);
  const url = `${base}/`;

  const all = distinctGaps(idx.slots);
  const real = all.filter((s) => !s.is_sample);
  const businesses = new Set(all.map((s) => s.operator_id)).size;
  const cheapest = cheapestReal(all);
  const ranked = tradesByOpenings(idx.slots);
  const covered = idx.areas.filter((a) => a.slot_count > 0);

  // Busiest neighbourhoods first, capped: this is a front page rather than the
  // directory, and /near carries the whole list one link away.
  const places = [...idx.areas]
    .map((a) => ({ a, n: distinctGaps(idx.slots.filter((s) => s.area_slug === a.slug)).length }))
    .sort((x, y) => y.n - x.n || x.a.name.localeCompare(y.a.name))
    .slice(0, 12);

  const body = `
<h1>Book someone round the way<span class="count">${all.length
    ? `${all.length} open ${plural(all.length, 'appointment', 'appointments')} right now`
    : 'Nothing open at this moment'}</span></h1>
<p class="lede">Every listing on ${escapeHtml(SITE_NAME)} is an hour a local mobile
business already has free this week — a job that cancelled, or a day that did not
fill. The business drives to your address, the price is the one they set for that
hour, and you book it without a phone call or a quote.</p>
${statList([
    { n: String(all.length), of: plural(all.length, 'appointment open', 'appointments open') },
    { n: String(businesses), of: plural(businesses, 'business listed', 'businesses listed') },
    { n: String(covered.length),
      of: plural(covered.length, 'neighbourhood', 'neighbourhoods') },
    ...(cheapest ? [{ n: cheapest.price, of: 'lowest price listed' }] : []),
  ])}
${sampleNote(all.length - real.length, all.length)}
<section>
<h2>What is open right now</h2>
${linkList(ranked.slice(0, 12).map((r) => ({
    href: tradePath(r.trade.slug),
    text: r.trade.label,
    sub: `${r.n} open`,
  }))) || `<p class="note">Nothing is open in any trade at this moment. This page
counts what is listed and does not estimate, so on a quiet hour it is a short
page. <a href="/a">A standing alert</a> is the one thing that will tell you when
an hour appears.</p>`}
<p class="note">Counted from the openings live, and it changes through the day.
<a href="/browse">Every service ${escapeHtml(SITE_NAME)} lists</a> is the list that
does not move.</p>
</section>
<section>
<h2>Where ${escapeHtml(SITE_NAME)} works</h2>
${linkList(metroLinks())}
${places.length ? `<h3>Neighbourhoods</h3>
${linkList(places.map((p) => ({
    href: `/near/${p.a.slug}`,
    text: `Open appointments in ${p.a.name}`,
    sub: p.n ? `${p.n} open` : undefined,
  })))}
<p class="note"><a href="/near">Every neighbourhood, with what is open in it</a></p>` : ''}
</section>
<section>
<h2>Every kind of work</h2>
<p class="note">The catalogue, by category. Each one lists the trades under it and
what each has open at the moment you open the page.</p>
${TRADE_CATEGORIES.map((c) => `<h3><a href="/browse/${escapeHtml(c.key)}">${
    escapeHtml(c.label)}</a></h3>${linkList(c.trades.map((t) => ({
    href: tradePath(t.slug),
    text: t.label,
  })))}`).join('')}
</section>
<section>
<h2>How it works</h2>
<ol class="steps">
<li><h3>Find an hour that is already free</h3>
<p>You are choosing a particular hour from a particular business, not asking
around for quotes. Nothing is listed in advance — an opening appears when a job
is cancelled or a gap opens between two booked jobs.</p></li>
<li><h3>Book it, and it is held</h3>
<p>The hour comes off that business's day the moment you book it and stops being
offered to anybody else. ${escapeHtml(PAY_TODAY_SHORT)}</p></li>
<li><h3>They arrive, and the work is recorded</h3>
<p>The vehicle at your door has to match the details you were shown, you give
them a start code, and photographs are taken before, during and after the
work.</p></li>
</ol>
<p class="note">${escapeHtml(ACCOUNT_TODAY_SHORT)}</p>
</section>
<section>
<h2>What ${escapeHtml(SITE_NAME)} does not do</h2>
<p>Nothing here is verified by us. There is no identity check, no background
check run by us, no interview, no licence check and no inspection of anybody's
work. Where a listing shows a licence, an insurance policy or a background
check, that is the business saying so about itself, and the issuing board's
public register is the place to check one.</p>
${linkList([
    { href: '/covered', text: 'What is covered, and what is not' },
    { href: '/safety', text: `What ${SITE_NAME} checks, and what it does not` },
    { href: '/cost', text: 'What things cost, counted from what is listed' },
  ])}
</section>
<section class="cta">
<h2>If nothing here suits today</h2>
<p>Openings appear through the day as jobs cancel and gaps open. You can be told
when one appears in your neighbourhood instead of checking, or list a business of
your own.</p>
${linkList([
    { href: '/a', text: 'Tell me when one appears' },
    { href: '/pros', text: `How ${SITE_NAME} works for pros` },
    { href: '/join', text: 'List your van' },
  ])}
</section>`;

  return seoPage({
    // The front page is the one title on the site that does not need the brand
    // spelled twice, so it says what the site is instead. `headTags` appends
    // the name.
    title: 'Mobile trades that come to you',
    /*
      THE COUNT IN A SNIPPET IS A CLAIM, SO IT COUNTS ONLY REAL OPENINGS.

      This said `${all.length} appointments open`, and `all` is every opening
      including the seeded ones. On the day this site went live with nothing but
      sample inventory that sentence was the front page's search snippet:
      "43 appointments open with mobile businesses across Los Angeles right
      now", every one of them a business we invented. The page itself is honest
      — `sampleNote` prints how many of the figures above it are seeded, right
      under the stat tiles — but a meta description is read in a result, where
      no label beside the number can follow it.

      This is the rule `cheapestReal` has always applied to the price in this
      same sentence, applied to the count as well. Prices were guarded and
      counts were not, which is an odd place for the line to have been drawn.
      The on-page figures are unchanged and still count everything, because on
      the page the sample note is two lines below them.
    */
    description: real.length
      ? `${real.length} appointments open with mobile businesses across ${metroNames()} `
        + `right now${cheapest ? `, from ${cheapest.price}` : ''}. Real times and real `
        + `prices, booked without a phone call.`
      : `Mobile trades across ${metroNames()} that come to your address. An opening `
        + `appears when a job is cancelled or a gap opens in the day.`,
    canonical: url,
    // The root is the one page on the site that is indexable whatever the hour.
    // It is the brand's own address and it says what the product is on the
    // quietest afternoon of the year.
    noindex: false,
    /*
      IN THE HEAD, NOT IN `#root`, AND THIS IS THE ONE PAGE WHERE THAT IS RIGHT.

      Everything else this file splices into the SPA document puts its graph
      inside `#root` so that React deletes it and the React page's own copy
      stands alone. `/` is the exception, because web/src/pages/Discover.tsx
      emits no structured data whatever — no breadcrumb, no graph — so there is
      no copy to stand alone and "React replaces it" meant "React deletes it".

      What was being deleted is the whole of the site's brand markup: the
      Organization node and the WebSite node with the SearchAction on it are
      emitted HERE AND NOWHERE ELSE in the repository. A crawler that runs
      JavaScript — the one that decides whether a query for the brand name has
      anything to attach a knowledge panel to — was reading the front page of
      this site and finding no Organization at all.

      If Discover.tsx ever grows a Crumbs or a graph of its own, the node it
      duplicates has to move back out of here into `jsonLd`. See `headJsonLd`.
    */
    headJsonLd: {
      '@context': 'https://schema.org',
      '@graph': [
        ...brandLd(base),
        breadcrumbLd(base, [{ name: SITE_NAME, url: '/' }]),
      ],
    },
    body,
    areas: idx.areas,
    shell: opts.shell,
  });
}

// ---------------------------------------------------------------------------
// 3f. An address with nothing behind it
// ---------------------------------------------------------------------------

/**
 * A page for a URL that names nothing, in HTML, with a real 404 on it.
 *
 * WHAT A PERSON USED TO GET. `/near/Sherman-Oaks` reached the Worker, found no
 * such area and threw `notFound('No such area.')` — which is `json()`, so a
 * human who mistyped one character was shown `{"error":"No such area."}` as an
 * application/json download prompt or a line of monospace, with no heading, no
 * link and no way back. Everywhere else an unknown address is at least a page.
 *
 * It is deliberately noindex rather than merely 404: the two say the same thing
 * to a crawler that reads the status, and the tag is what a rendering crawler
 * and a cached copy see. Nothing here is a redirect — the visitor stays on the
 * address they asked for, because moving them to the front page is how a dead
 * URL gets judged as a duplicate of the front page.
 */
export function notFoundPage(env: Env, what: string): string {
  const base = baseUrlOf(env);
  return seoPage({
    title: 'Page not found',
    description: 'That address has nothing behind it.',
    // Self-referencing would be a canonical for a page that does not exist, so
    // the front page is named instead: it is where the content a lost visitor
    // is looking for actually starts.
    canonical: `${base}/`,
    noindex: true,
    body: `
<h1>Nothing here</h1>
<p class="lede">${escapeHtml(what)}</p>
<p class="note">It may have been a typing slip, or the address may have been
right once — a neighbourhood stops being listed when the last business covering
it stops covering it, and a business's page goes when they unpublish it.</p>
<section>
<h2>Where to start instead</h2>
${linkList([
    { href: '/near', text: `Every neighbourhood ${SITE_NAME} covers` },
    { href: '/browse', text: 'Every service, by category' },
    { href: '/cost', text: 'What things cost' },
    ...METROS.map((m) => ({ href: metroPath(m), text: `Mobile services in ${m.name}` })),
  ])}
</section>`,
  });
}

// ---------------------------------------------------------------------------
// 3g. /p/:slug — one business's page
// ---------------------------------------------------------------------------

const WORK_LOCATION: Record<string, string[]> = {
  i_travel: ['I travel to my customers'],
  they_travel: ['My customers travel to me'],
  both: ['My customers travel to me', 'I travel to my customers'],
};

/**
 * The same three values again, as a sentence rather than a tick.
 *
 * Copied word for word from TRAVEL_PROSE in web/src/pages/PublicProfile.tsx,
 * which renders this same URL for a visitor with JavaScript. The tick list
 * above is the operator's own answer to their own form; this is what that
 * answer means for the person reading it, written from the customer's side.
 */
const TRAVEL_PROSE: Record<string, string> = {
  i_travel: 'They drive to you. The work happens wherever you are — your drive, '
    + 'your kerb, your car park — and there is nowhere for you to bring anything to.',
  they_travel: 'You go to them. This business does not drive out to customers, '
    + 'so the job happens at a place they will arrange with you.',
  both: 'Either way round. They will drive out to you, and they also take work '
    + 'at a place of their own — agree which one before the day.',
};

/**
 * WHAT A MOBILE TRADE NEEDS FROM THE KERB, PUT AS QUESTIONS.
 *
 * The reference marketplace has a requirements module here, filled in by the
 * pro. This product has no such column: nothing anywhere records whether a
 * particular business needs an outside tap or a 13-amp socket, and writing one
 * in from the trade name would be inventing a fact about a person. So the block
 * these five build asks them instead, and says out loud that the site collects
 * no answers to them.
 *
 * Word for word from ON_SITE_QUESTIONS in web/src/pages/PublicProfile.tsx: the
 * two halves of /p/<slug> must not offer a reader two different lists of things
 * to settle before the van arrives.
 */
const ON_SITE_QUESTIONS = [
  'Where do they need to park, and for how long? Permit bays, gated drives and '
    + 'narrow kerbs are worth mentioning before the day rather than on it.',
  'Do they need water from your outside tap, or do they carry their own?',
  'Do they need mains power, or does everything run off the van?',
  'How do they get to the work — a gate code, a lift, a flight of stairs, a dog '
    + 'in the garden?',
  'Does somebody need to be in, and for the whole job or only to let them in?',
];

/** Weekday index to name. Sunday is 0, which is what the Worker stores. */
const DAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const;

/**
 * Minutes from midnight as the business's own wall clock.
 *
 * ARITHMETIC ON THE NUMBER RATHER THAN A DATE, DELIBERATELY, and it is the
 * whole reason this function exists rather than a call to formatLocal.
 * `start_minute` is minutes past midnight where the business is: 540 is 09:00
 * in Los Angeles on every day of the year, including the two the clocks change.
 * Building a Date from it means choosing an instant, and an instant projected
 * into any zone can be an hour out twice a year for no reason at all. Same
 * function, same reasoning, as `wallClock` in web/src/pages/PublicProfile.tsx.
 */
const wallClock = (minutes: number) => {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/**
 * The short name of a zone as it is right now — "PDT" — for the line that says
 * whose clock the times above it are on.
 *
 * Falls back to the IANA name, which is what the operator row carries and is
 * never wrong even when it is ugly. A zone this runtime has never heard of
 * throws rather than returning nothing, hence the catch.
 */
function zoneLabel(timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, timeZoneName: 'short',
    }).formatToParts(new Date());
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? timezone;
  } catch {
    return timezone;
  }
}

/**
 * "1h 30m" — how long a service takes, in the app's own register.
 *
 * NOT `duration` above, and the difference is deliberate rather than an
 * oversight. `duration` prints "1 hr 30 min", which is what the cost guide's
 * prose needs because the figure sits inside a sentence. This one is the string
 * web/src/api.ts's `durationLabel` produces, and it is used in exactly one
 * place: the service list on a profile, where React renders that same list over
 * this markup a moment later. Two different spellings of the same length in the
 * same faint span is the page visibly rewriting itself under the reader.
 *
 * Rounded to the minute ONCE, before the hours are taken off, for the reason
 * api.ts gives: rounding the remainder on its own turned 3,599 seconds into
 * "60m" and 7,199 into "1h 60m".
 */
function durationLabel(seconds: number): string {
  const total = Math.round(seconds / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
}

const STARS = (n: number) => '★★★★★'.slice(0, Math.max(0, Math.min(5, n)));

const reviewDate = (epochSeconds: number) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    .format(new Date(epochSeconds * 1000));

/**
 * The three alternatives the foot of a profile page offers.
 *
 * The reference ends a profile with three other businesses and a "see all",
 * and this page ended with two links to itself — a visitor who had decided
 * against this business had nowhere to go but back to a search.
 *
 * EVERY LINE IS COUNTED OFF THE OTHER BUSINESS'S OWN ROW and nothing is filled
 * in: a business nobody has reviewed says nothing about a score rather than
 * being described as new-and-probably-fine, and one that shares no
 * neighbourhood says so instead of being called nearby. `shared_areas` is
 * printed rather than turned into a word like "local", because it is the whole
 * basis on which these three were picked and a reader is entitled to see it.
 */
function similarBlock(similar: SimilarBusiness[], label: string): string {
  if (similar.length === 0) {
    return `<p class="note">No other ${escapeHtml(label.toLowerCase())} business has a
page on ${escapeHtml(SITE_NAME)} yet.</p>`;
  }

  const samples = similar.filter((s) => s.is_sample).length;

  // Its own sentence rather than sampleNote, which counts listings. These are
  // businesses, and calling a seeded business a "sample listing" is the kind of
  // near-miss that lets a reader take it for a real one.
  const sampleLine = samples === 0 ? '' : `<p class="note">${escapeHtml(
    samples === similar.length
      ? (similar.length === 1
        ? 'That is a sample business we seeded ourselves'
        : `All ${similar.length} are sample businesses we seeded ourselves`)
      : `${samples} of them ${plural(samples, 'is a sample business', 'are sample businesses')} `
        + 'we seeded ourselves')} rather than a business trading today. Each one is
labelled where it appears.</p>`;

  return `${sampleLine}
<ul class="links">${similar.map((s) => {
    const facts = [
      s.rating != null
        ? `${s.rating.toFixed(1)} from ${s.review_count} ${
          plural(s.review_count, 'review', 'reviews')}`
        : 'no reviews yet',
      ...(s.hired_count > 0 ? [`hired ${s.hired_count} times`] : []),
      ...(s.years_in_business != null
        ? [`${s.years_in_business} ${plural(s.years_in_business, 'year', 'years')} in business`]
        : []),
      ...(s.shared_areas > 0
        ? [`${s.shared_areas} ${plural(s.shared_areas, 'neighbourhood', 'neighbourhoods')} in common`]
        : []),
      ...(s.is_sample ? ['sample business'] : []),
    ];
    return `<li><a href="/p/${escapeHtml(s.profile_slug)}">${escapeHtml(s.business_name)}</a>
<span class="note">${escapeHtml(facts.join(' · '))}</span>${s.areas.length
      ? `<br><span class="note">Serves ${escapeHtml(s.areas.join(', '))}</span>` : ''}</li>`;
  }).join('')}</ul>`;
}

export async function profilePage(
  env: Env, slug: string, opts: PageOptions = {},
): Promise<string | null> {
  const data = await getPublicProfile(env, (slug ?? '').trim());
  if (!data) return null;                       // unpublished or mistyped: the SPA says so

  /**
   * Whether this page belongs to a seeded sample business.
   *
   * It decides three things, and it has to, because a sample business has
   * sample reviews attached to it. Marking those up as an AggregateRating
   * would be submitting a rating we invented to a search engine — the one
   * thing this file exists to refuse — so a sample gets no business node at
   * all, is not asked to be indexed, and says on the page what it is.
   */
  const idRow = await env.DB.prepare(
    `SELECT id FROM operators WHERE profile_slug = ? AND is_published = 1`,
  ).bind((slug ?? '').trim()).first<{ id: string }>();
  const isSample = idRow ? isDemoOperator(idRow.id) : false;

  const base = baseUrlOf(env);
  const idx = await liveIndex(env);
  // `services` and `working_hours` are returned by getPublicProfile and were
  // simply not destructured here, so the server copy of this page silently
  // omitted both — a business's whole menu and its whole week — while the React
  // copy of the same URL drew them. That is the worst shape this split can
  // take: not two pages that disagree, but one page that appears to gain two
  // sections the instant a script runs.
  const {
    operator: o, photos, rating, reviews, faqs, areas, services, working_hours: hours,
  } = data;
  const path = `/p/${slug}`;
  const url = `${base}${path}`;
  const entry = tradeBySlug(o.trade);

  // What this business has open, counted from the same read every other page
  // here counts from. Matched on profile_slug rather than on the business
  // name, which is neither unique nor stable.
  const theirs = distinctGaps(idx.slots.filter((s) => s.profile_slug === slug));

  /**
   * Which metro this business works in, read off its own service areas.
   *
   * A profile is one business on one patch, so the description names that
   * patch. It used to name the launch metro, which was the same sentence for
   * everybody and became wrong the moment a business outside Los Angeles
   * published a page. The areas themselves are listed in full on the page.
   */
  const metro = await metroForOperator(env, idRow?.id ?? null);

  /**
   * THE OVERVIEW IS TWO LISTS, BECAUSE IT WAS TWO KINDS OF FACT PRETENDING TO
   * BE ONE.
   *
   * It used to be a single run of lines: hired N times, BACKGROUND CHECKED,
   * solo operator, N years in business. Read at scanning speed that is four
   * things somebody confirmed — which is the entire argument a list like that
   * makes — and only the first of them is counted by anything here. The rest
   * are typed into a settings form by the person they flatter.
   *
   * "Background checked" is gone from this list entirely, and that is the
   * defect this split exists to close rather than a tidy-up. NOBODY ON THIS
   * SITE RUNS OR READS A BACKGROUND CHECK: the column records what a business
   * says about itself, and rendering it here as an unqualified line put a
   * platform endorsement Round The Way has no right to make into indexable HTML,
   * beside a business's name, above the fold. It survives once, in Credentials
   * at the foot, where there is room to say what it is and is not. A line in a
   * scan list has no room to say anything.
   *
   * So: the counted fact keeps its tick, under a heading naming who counted it.
   * The self-reported ones are plain bullets under a heading that says, in
   * words, whose claim they are. web/src/pages/PublicProfile.tsx draws the same
   * two lists under the same two headings.
   */
  const counted = [
    ...(o.hired_count > 0
      ? [`Hired ${o.hired_count} ${plural(o.hired_count, 'time', 'times')} through this site`]
      : []),
  ];
  // `employees` always has a value — every business is at least one person — so
  // this list is never empty and its heading never stands over nothing.
  const said = [
    o.employees === 1 ? 'Solo operator' : `${o.employees} employees`,
    ...(o.years_in_business != null
      ? [`${o.years_in_business} ${plural(o.years_in_business, 'year', 'years')} in business`]
      : []),
    ...(o.years_experience != null
      ? [`${o.years_experience} ${plural(o.years_experience, 'year', 'years')} in the trade`]
      : []),
  ];

  const social: Array<{ name: string; href: string }> = [
    ...(o.social_facebook ? [{ name: 'Facebook', href: o.social_facebook }] : []),
    ...(o.social_instagram ? [{ name: 'Instagram', href: o.social_instagram }] : []),
    ...(o.social_tiktok ? [{ name: 'TikTok', href: o.social_tiktok }] : []),
  ];

  const scoreLine = rating.count > 0
    ? `<p class="lede"><strong>${escapeHtml(rating.label ?? '')}</strong>
${escapeHtml((rating.average ?? 0).toFixed(1))}
<span aria-hidden="true">${STARS(Math.round(rating.average ?? 0))}</span>
<span class="note">(${rating.count} ${plural(rating.count, 'review', 'reviews')})</span></p>`
    // Said in words rather than as five grey stars. A new business is not a
    // bad one, and empty stars read like a bad one.
    : '<p class="lede note">New — no reviews yet.</p>';

  const bars = rating.count > 0
    ? `<div class="tbl-wrap"><table><tbody>${([5, 4, 3, 2, 1] as const).map((star) => {
      const k = rating.distribution[star] ?? 0;
      const pct = rating.count ? Math.round((k / rating.count) * 100) : 0;
      return `<tr><th scope="row">${star} ${plural(star, 'star', 'stars')}</th>
<td class="num">${k}</td><td class="num">${pct}%</td></tr>`;
    }).join('')}</tbody></table></div>`
    : '';

  const reviewBlock = rating.count === 0
    ? `<p class="note">No reviews yet. Only somebody who booked here and had the
work done can leave one, so they take a while to arrive — and they mean
something when they do.</p>`
    : `${bars}${reviews.map((r) => `<div class="box">
<p><strong>${escapeHtml(r.author_name)}</strong> <span class="note">${
      escapeHtml(reviewDate(r.created_at))}</span></p>
<p><span aria-hidden="true">${STARS(r.rating)}</span>
<span class="note">${r.rating} out of 5 · Booked on ${escapeHtml(SITE_NAME)}</span></p>
${r.body ? `<p>${escapeHtml(r.body)}</p>` : ''}
${r.details ? `<p class="note">Details: ${escapeHtml(r.details)}</p>` : ''}
${r.reply ? `<p class="note"><strong>Response from ${escapeHtml(o.business_name)}</strong><br>${
      escapeHtml(r.reply)}</p>` : ''}
</div>`).join('')}`;

  /**
   * What each service is listed at in this business's own open appointments,
   * keyed by service id.
   *
   * THE PRICE IS THE STRING THE WORKER ALREADY FORMATTED and never a number
   * reassembled here. `PublicService` carries `price_cents` and no currency at
   * all, so pricing the full menu would mean this page picking a symbol — from
   * the country, from a default, from anywhere — which is this page deciding
   * what a number means. An open gap carries `price`, already formatted by the
   * code that knows the currency, so a service with an opening shows what that
   * opening is listed at and a service without one shows only how long it
   * takes. The note under the list says which is which.
   *
   * Keyed on `service_id` rather than on the name, because the menu is joined
   * to it by id and two services can share a name across a rename.
   */
  const priceByService = new Map<string, string>();
  {
    const rows = new Map<string, PlacedSlot[]>();
    for (const s of theirs) {
      if (!s.service_id) continue;
      const list = rows.get(s.service_id);
      if (list) list.push(s); else rows.set(s.service_id, [s]);
    }
    for (const [id, list] of rows) {
      const sorted = [...list].sort((a, b) => a.price_cents - b.price_cents);
      const low = sorted[0]!;
      const high = sorted[sorted.length - 1]!;
      priceByService.set(id, low.price_cents === high.price_cents
        ? low.price : `${low.price} – ${high.price}`);
    }
  }

  const serviceList = services.length
    ? `<ul class="ticks">${services.map((sv) => {
      const price = priceByService.get(sv.id);
      return `<li>${escapeHtml(sv.name)} <span class="note">${
        escapeHtml(durationLabel(sv.duration_seconds))}${
        price ? ` · ${escapeHtml(price)}` : ''}</span></li>`;
    }).join('')}</ul>
<p class="note">${escapeHtml(priceByService.size > 0
      ? `Everything ${o.business_name} does, with how long they set aside for it. `
        + 'A price is shown where they have an opening for that work at the '
        + 'moment; the others are priced when they list one.'
      : `Everything ${o.business_name} does, with how long they set aside for it. `
        + 'Prices appear against these when they list an opening.')}</p>`
    : '';

  /**
   * The week, one entry per weekday, Monday first.
   *
   * Monday rather than Sunday because a week of business hours is read Monday
   * to Sunday, even though the rows are indexed 0 = Sunday — which is what the
   * column stores. Every weekday gets a line, INCLUDING THE CLOSED ONES:
   * leaving Sunday out makes a reader work out its absence, and a reader who
   * does not work it out assumes the business is open.
   *
   * No rows at all is a different statement from a week of closed days — it is
   * "they have not said" — so the whole block is omitted rather than drawing a
   * business that is shut seven days a week. Same rule the React page follows.
   *
   * The times are printed as they arrive and are never fed through a Date: see
   * `wallClock`. The zone under the list is named off the operator's own row.
   */
  const hoursBlock = hours.length
    ? `<section>
<h2>Business hours</h2>
<dl class="deflist">${[1, 2, 3, 4, 5, 6, 0].map((weekday) => {
      const bands = hours.filter((h) => h.weekday === weekday)
        .sort((a, b) => a.start_minute - b.start_minute);
      return `<dt>${escapeHtml(DAY_NAMES[weekday] ?? `Day ${weekday}`)}</dt><dd>${
        bands.length === 0
          ? 'Closed'
          : escapeHtml(bands
            .map((b) => `${wallClock(b.start_minute)}–${wallClock(b.end_minute)}`)
            .join(', '))}</dd>`;
    }).join('')}</dl>
<p class="note">Shown in ${escapeHtml(o.business_name)}'s own time (${
      escapeHtml(zoneLabel(o.timezone))}), not yours. These are the hours they work; an
opening only appears inside them when a job cancels or a day does not fill.</p>
</section>`
    : '';

  /**
   * WHERE THEY GO, AND — THE HALF EVERY DIRECTORY LEAVES OUT — WHERE THEY DO
   * NOT.
   *
   * A neighbourhood missing from a service-area list is not a neighbourhood the
   * business refuses; it is one they have not said anything about, and those
   * are different things that a reader hunting for their own street has no way
   * to tell apart. Every directory silently lets them assume the generous
   * reading. A business that has drawn no areas at all gets the same treatment:
   * an empty list is "they have not said", NEVER "they go everywhere".
   *
   * `<h3>Serves</h3>` used to sit inside Overview, which put the single most
   * decisive fact on the page — can this van physically reach my street — in a
   * list of employee counts. The prose is web/src/pages/PublicProfile.tsx's.
   */
  const whereBlock = `<section>
<h2>Where ${escapeHtml(o.business_name)} works</h2>
<p>${escapeHtml(TRAVEL_PROSE[o.work_location] ?? TRAVEL_PROSE.i_travel!)}</p>
${areas.length
    ? `<h3>${areas.length === 1
      ? 'The area they have listed'
      : `The ${areas.length} areas they have listed`}</h3>
<p>${escapeHtml(areas.join(', '))}</p>
<p class="note">These are the neighbourhoods ${escapeHtml(o.business_name)} has drawn on
their own map, so it is where their openings appear. It is not a limit anyone
enforces and it is not a refusal of anywhere else: a street that is not on this
list is somewhere they have simply not said either way. If yours is not here,
ask them before you book.</p>`
    : `<p class="note">${escapeHtml(o.business_name)} has not listed any neighbourhoods
yet, so there is nothing here to tell you how far they will drive. Ask them
where they go before you book — messaging them needs no account.</p>`}
</section>`;

  /**
   * The five questions, and the sentence saying why they are questions.
   *
   * Unconditional, and it depends on no row, which is exactly why it can be:
   * there is no state in which it is empty or misleading. It is the same five
   * for a locksmith and a dog groomer because they are the five things a kerb
   * either has or has not got — and the site records none of the answers, which
   * the block says rather than implying by omission.
   */
  const onSiteBlock = `<section>
<h2>Before they arrive</h2>
<p>${escapeHtml(o.business_name)} works out of a vehicle, so the job happens wherever
you are and whatever is there is what they have to work with. These are worth
settling in a message first — none of them is on this page because Round The Way
does not ask businesses to record them, so the only person who can answer is
${escapeHtml(o.business_name)}, and the only person who knows your kerb is you.</p>
<ul class="said">${ON_SITE_QUESTIONS.map((qn) => `<li>${escapeHtml(qn)}</li>`).join('')}</ul>
<p class="note">Ask any of these before you book. It costs nothing and does not
book anything.</p>
</section>`;

  const body = `
<p class="crumb"><a href="/">${escapeHtml(SITE_NAME)}</a> › ${entry
    ? `<a href="${escapeHtml(tradePath(entry.slug))}">${escapeHtml(entry.label)}</a> › `
    : ''}${escapeHtml(o.business_name)}</p>
<h1>${escapeHtml(o.business_name)}</h1>
${isSample ? `<p class="sample">Sample business. Everything on this page —
the openings, the reviews, the score — is example data we seeded to show how a
business page works. It is not a real business and nothing here can be
booked with anyone.</p>` : ''}
${scoreLine}
${o.tagline ? `<p class="lede">${escapeHtml(o.tagline)}</p>` : ''}
${entry
    ? `<p><a class="book" href="${escapeHtml(tradePath(entry.slug))}">See what is open in ${
      escapeHtml(entry.label.toLowerCase())}</a></p>`
    : '<p><a class="book" href="/">See what is open near you</a></p>'}
<p class="note">You can message ${escapeHtml(o.business_name)} or ask them for a quote
without booking anything first — both are on this page, and neither needs an
account. Booking does: a mobile number and the six-digit code we text back,
given at the moment you book. Messages go through the app. No phone numbers are
exchanged.</p>
${o.bio ? `<section><h2>About</h2><p>${escapeHtml(o.bio)}</p></section>` : ''}
<section>
<h2>Overview</h2>
${counted.length ? `<h3>Counted by ${escapeHtml(SITE_NAME)}</h3>
<ul class="ticks">${counted.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : ''}
<h3>What ${escapeHtml(o.business_name)} says about themselves</h3>
<ul class="said">${said.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>
<p class="note">Self-reported. ${escapeHtml(o.business_name)} entered these themselves
and ${escapeHtml(SITE_NAME)} has not checked any of them.</p>
${o.payment_methods
    // Also self-reported, and worth saying so for a different reason from the
    // years above: this is the one the reader acts on at the kerb with a wallet
    // in their hand. "They say they take cash" and "they take cash" are the
    // same sentence right up until somebody turns up with only cash.
    ? `<h3>Payment methods</h3><p>${escapeHtml(o.business_name)} says they take ${
      escapeHtml(o.payment_methods)}. Worth confirming with them before the day — this
is their own description and nobody here has tested it.</p>`
    : ''}
${social.length ? `<h3>Social media</h3><p>${social.map((x) =>
    `<a href="${escapeHtml(x.href)}" rel="noreferrer noopener nofollow">${
      escapeHtml(x.name)}</a>`).join(', ')}</p>` : ''}
</section>
<section>
<h2>Services offered</h2>
${serviceList}
<h3>Work location</h3>
<ul class="ticks">${(WORK_LOCATION[o.work_location] ?? WORK_LOCATION.i_travel!)
    .map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
</section>
${whereBlock}
${hoursBlock}
${photos.length ? `<section>
<h2>Photos <span class="note">(${photos.length})</span></h2>
${/*
  EVERY <img> CARRIES A HEIGHT, AND THE FIRST ONE IS NOT LAZY.

  These were `width="160" loading="lazy"` with no height at all. A browser
  cannot reserve space for a box whose height it does not know, so it lays the
  page out with the pictures collapsed and reflows it as each one lands — the
  photo strip of a business with eight pictures shoved everything under it
  down the page eight times, which is both the worst thing a reader can be
  doing when it happens and a Cumulative Layout Shift score on the one page
  somebody reads before deciding to let a stranger into their house.

  The height is the STORED one, scaled: work_photos records the real pixel
  dimensions at upload, so the box is the shape the picture actually is rather
  than a square guessed here. Where a row predates those columns there is
  nothing honest to say, so that image keeps its old behaviour rather than
  being given a made-up ratio that would shift the page the other way.

  The first photograph is this page's avatar — it is what a reader sees above
  the fold and it is the one the business is judged on — so it is fetched
  eagerly and at high priority, and only the ones below it are deferred.
  Lazily loading the image that is already on screen is the common way of
  making a page slower with an attribute that is meant to make it faster.
*/''}<p>${photos.map((p, i) => {
    const h = p.width && p.height && p.width > 0
      ? Math.max(1, Math.round((160 * p.height) / p.width))
      : null;
    return `<a href="/api/public/photo/${escapeHtml(p.r2_key)}"><img
 src="/api/public/photo/${escapeHtml(p.r2_key)}" width="160"${h ? ` height="${h}"` : ''} ${
      i === 0 ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"'} alt="${
      escapeHtml(p.caption ?? `Work by ${o.business_name}`)}"></a>`;
  }).join(' ')}</p>
</section>` : ''}
${theirs.length ? `<section>
<h2>Open right now</h2>
${/*
  `true` because this IS their page. It matters for a seeded business only: a
  sample opening's action is a link to the business's profile, and on the
  profile that would be a link back to the page being read. The paragraph under
  the heading at the top of this page has already said everything that link
  was going to say, so the listing carries no action instead. A real business's
  openings are unaffected and still say See this opening.
*/''}${slotList(theirs, true)}
</section>` : ''}
${onSiteBlock}
<section>
<h2>Reviews</h2>
${reviewBlock}
</section>
<section>
<h2>Credentials</h2>
${o.background_checked_at
    // THE LABEL CARRIES THE QUALIFICATION rather than leaving it to the
    // paragraph underneath. A reader scanning headings takes "Background check"
    // as a heading this site is standing behind, and by the time they reach the
    // small print they have already decided. Two words in the label cost
    // nothing and cannot be scrolled past.
    ? `<p><strong>Background check — self-reported</strong><br>${
      escapeHtml(o.background_check_name ?? '')}${
      o.background_check_provider
        ? `<br><span class="note">Checked by ${
          escapeHtml(o.background_check_provider)}</span>` : ''}</p>
<p class="note">This is what ${escapeHtml(o.business_name)} has recorded about
themselves. ${escapeHtml(SITE_NAME)} does not run the check and does not verify it —
see <a href="/covered">what is covered</a>.</p>`
    : `<p class="note">This business has not recorded a background check.
${escapeHtml(SITE_NAME)} does not run one either way — see <a href="/covered">what is
covered</a>.</p>`}
<h3>Licences and insurance</h3>
<p class="note">${escapeHtml(SITE_NAME)} holds nothing about either. We do not collect
licence numbers, we do not see certificates of insurance, and we verify neither —
for this business or any other. Where ${escapeHtml(LAUNCH_STATE)} requires a licence for
this trade it is between ${escapeHtml(o.business_name)} and the issuing board, and that
board's public register is the place to check it. Ask them directly for a licence
number and an insurer, and check what you are told. See <a href="/covered">what is
covered</a>.</p>
</section>
${faqs.length ? `<section><h2>FAQs</h2>${faqs.map((f) => `<details>
<summary>${escapeHtml(f.question)}</summary><p class="note">${
    escapeHtml(f.answer)}</p></details>`).join('')}</section>` : ''}
${entry ? `<section>
<h2>Other ${escapeHtml(entry.label.toLowerCase())} businesses</h2>
${similarBlock(data.similar, entry.label)}
${linkList([
    { href: tradePath(entry.slug), text: `See all ${entry.label.toLowerCase()} — what is open now` },
    { href: costPath(entry.slug), text: `What ${entry.label.toLowerCase()} costs` },
  ])}
</section>` : ''}`;

  /**
   * The business, and its score only when there is one.
   *
   * A rating is emitted if and only if a review row exists — no default, no
   * placeholder, no "5.0 (0)". Fabricated review markup is a lie to the reader
   * and a manual action waiting to happen, and a business with no reviews is
   * new rather than unrated.
   *
   * WHAT THIS NODE WAS, AND WHY NONE OF IT COULD EVER HAVE FIRED. It was typed
   * `['Product','LocalBusiness']` with a name, a URL and a list of areas — no
   * `address`, no `image`, no `@id`. Google requires `address` on a
   * LocalBusiness and `image` on a Product before either can produce a rich
   * result, so this was a node that satisfied neither type it claimed while
   * carrying an aggregateRating for the benefit of nothing. The stars this
   * page exists to win were never available to it.
   *
   * So it is ONE LocalBusiness now, with the three things that make it real:
   *
   *  - `@id`, the profile URL, which is what lets the offers on every /near
   *    page reference this same business rather than each minting an anonymous
   *    copy of it (see `slotBusinessLd`).
   *  - `address`, a locality and region off the metro this business's own
   *    service areas put it in, and never a street line — see `postalAddress`.
   *  - `image`, their avatar or one of their own work photographs, and nothing
   *    at all when they have neither.
   *
   * Product is gone. This is a business somebody books, not a thing somebody
   * buys, and claiming both types while satisfying neither was the whole
   * defect. web/src/pages/PublicProfile.tsx emits a copy of this node for the
   * React half of the same URL and has to be changed to match.
   */
  const businessLd: Record<string, unknown> = {
    '@type': 'LocalBusiness',
    '@id': url,
    name: o.business_name,
    url,
    address: postalAddress({
      locality: metro.name, region: metro.state, country: o.country || metro.country,
    }),
    areaServed: areas.map((a) => ({ '@type': 'Place', name: `${a}, ${metro.state}` })),
  };
  // Their own face or their own work. A business with neither gets no `image`
  // rather than a stock photograph, which costs the rich result and is the
  // only honest answer.
  const imageKey = o.avatar_key ?? photos[0]?.r2_key ?? null;
  if (imageKey) businessLd.image = `${base}/api/public/photo/${encodeURIComponent(imageKey)}`;
  if (o.tagline) businessLd.description = o.tagline;
  if (entry) businessLd.category = entry.label;
  if (!isSample && rating.count > 0 && rating.average != null) {
    businessLd.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: rating.average,
      reviewCount: rating.count,
      bestRating: 5,
      worstRating: 1,
    };
  }

  const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);
  const description = isSample
    ? `Sample business page on ${SITE_NAME}. The openings, reviews and score on it are `
      + `example data, not a real business.`
    : [
      o.tagline?.trim() ? sentence(o.tagline.trim()) : null,
      entry ? `${entry.label} in ${metro.name}, ${metro.state}.` : null,
      rating.count > 0
        ? `${rating.average} from ${rating.count} ${plural(rating.count, 'review', 'reviews')}.`
        : 'No reviews yet.',
      theirs.length
        ? `${theirs.length} ${plural(theirs.length, 'appointment', 'appointments')} open now.`
        : null,
    ].filter(Boolean).join(' ');

  return seoPage({
    /*
      A BUSINESS NAME ON ITS OWN IS NOT A TITLE, and it was the whole of this
      one. Three things were wrong with it at once: nobody searching for a
      mobile detailer types a business name they have never heard of, so the
      title held not one word of the query it could win; the length was
      whatever the owner typed into a form, so a long one pushed the site name
      off the end of a result; and a business_name that is blank or whitespace
      produced a title of " | Round The Way", which is an empty title on a live
      page.

      So the name is joined to the trade and the metro while all three fit,
      falls back to the trade alone, and falls back again to the name. The
      guard above it is for the empty name: there is no candidate containing
      it worth printing, so the page is titled by what it is instead.
    */
    title: (() => {
      const name = o.business_name.trim();
      if (!name) {
        return fitTitle(
          entry ? `${entry.label} in ${metro.name}, ${metro.state}` : '',
          entry ? `${entry.label} in ${metro.name}` : '',
          'Business profile',
        );
      }
      return fitTitle(
        entry ? `${name} — ${entry.label} in ${metro.name}` : '',
        entry ? `${name} — ${entry.label}` : '',
        name,
      );
    })(),
    description,
    canonical: url,
    // A seeded business is not inventory to submit to a search engine, however
    // useful it is for showing a visitor what a business page looks like.
    noindex: isSample,
    jsonLd: {
      '@context': 'https://schema.org',
      '@graph': [
        breadcrumbLd(base, [
          { name: SITE_NAME, url: '/' },
          ...(entry ? [{ name: entry.label, url: tradePath(entry.slug) }] : []),
          { name: o.business_name, url: path },
        ]),
        ...(isSample ? [] : [businessLd]),
      ],
    },
    body,
    areas: idx.areas,
    shell: opts.shell,
  });
}

// ---------------------------------------------------------------------------
// 4. The two pages that make the geography reachable
// ---------------------------------------------------------------------------

/**
 * /near — every service area, with what is open in it.
 *
 * Nothing enumerated these before. /near/<place> pages were reachable from
 * each other by proximity and from the front page's footer, which means a
 * neighbourhood nobody happened to be near was reachable from nothing at all.
 * This is the page that closes the graph.
 */
export async function areaIndexPage(env: Env): Promise<string> {
  const base = baseUrlOf(env);
  const idx = await liveIndex(env);
  const url = `${base}/near`;

  const rows = idx.areas.map((a) => {
    const mine = distinctGaps(idx.slots.filter((s) => s.area_slug === a.slug));
    return { area: a, metro: metroOf(a), n: mine.length, trades: linkableTrades(mine) };
  }).sort((x, y) => y.n - x.n || x.area.name.localeCompare(y.area.name));

  // Counted over the whole index rather than by adding the per-area figures
  // up: a whole free day is genuinely offered in every neighbourhood its owner
  // covers, so it is right on each of those pages and would be counted several
  // times over in a total.
  const openings = distinctGaps(idx.slots).length;
  // The same count with the seeded listings taken out, which is what decides
  // whether this page asks to be indexed. See `noindex` below.
  const realOpenings = distinctGaps(idx.slots.filter((s) => !s.is_sample)).length;
  // How many neighbourhoods have something in them a stranger could actually
  // book, as opposed to how many are on the map at all. Only the meta
  // description uses it, and metroPage works the identical figure out under
  // the identical name for the identical sentence; see the note over
  // `description` below for why that one sentence counts differently from the
  // page it describes.
  const realWhere = new Set(
    idx.slots.filter((s) => !s.is_sample).map((s) => s.area_slug),
  ).size;

  // Grouped by metro, because this page is now a list of neighbourhoods in two
  // different places and an undifferentiated run of them says Orcutt and
  // Northridge are down the road from each other. Metros with nothing listed
  // are dropped rather than printed as an empty heading.
  const grouped = METROS
    .map((m) => ({ metro: m, rows: rows.filter((r) => r.metro.slug === m.slug) }))
    .filter((g) => g.rows.length > 0);

  const areaBlock = (list: typeof rows) => list.map((r) => `<section>
<h3><a href="/near/${escapeHtml(r.area.slug)}">${escapeHtml(r.area.name)}</a>${r.n
    ? ` <span class="note">${r.n} open</span>` : ''}</h3>
${r.trades.length
    ? `<ul class="jump">${r.trades.map((t) => `<li><a href="/near/${
      escapeHtml(r.area.slug)}/${escapeHtml(tradeSlug(t.trade))}">${
      escapeHtml(tradeLabel(t.trade))} (${t.n})</a></li>`).join('')}</ul>`
    : '<p class="note">Nothing open here at the moment.</p>'}
</section>`).join('');

  const metroBlock = grouped.map((g) => {
    const live = g.rows.filter((r) => r.n > 0);
    const quiet = g.rows.filter((r) => r.n === 0);
    const open = distinctGaps(idx.slots.filter(
      (s) => g.rows.some((r) => r.area.slug === s.area_slug))).length;
    return `<section>
<h2><a href="${escapeHtml(metroPath(g.metro))}">${escapeHtml(g.metro.name)}</a><span class="count">${
      g.rows.length} ${plural(g.rows.length, 'neighbourhood', 'neighbourhoods')}, ${
      open} open ${plural(open, 'appointment', 'appointments')}</span></h2>
${live.length ? areaBlock(live) : '<p class="note">Nothing is open here at the moment.</p>'}
${quiet.length ? `<h3>Quiet right now</h3>
${linkList(quiet.map((r) => ({
    href: `/near/${r.area.slug}`,
    text: `Open appointments in ${r.area.name}`,
  })))}` : ''}
</section>`;
  }).join('');

  /**
   * WHICH TRADES ACTUALLY WORK THESE NEIGHBOURHOODS, counted the other way
   * round from everything else on the page.
   *
   * The blocks above are neighbourhood-first: pick a place, see what is in it.
   * That answers the question of a reader who already knows where they live and
   * is the right default. It does not answer the other half of the traffic —
   * somebody who knows they want a locksmith and wants to know whether this
   * site has locksmiths at all — and until now the only way to find that out
   * was to open neighbourhoods one at a time until one had the word in it.
   *
   * THE FIGURE IS HOW MANY NEIGHBOURHOODS A TRADE IS OPEN IN, NOT HOW MANY
   * OPENINGS IT HAS. "Eleven openings" on this page could be one business
   * having a slow week, and the question being asked here is one of coverage.
   * It is counted off the same rows the metro blocks are built from, so the two
   * cannot disagree. web/src/pages/Areas.tsx counts it the same way.
   */
  const tradeCoverage = (() => {
    const areasPerTrade = new Map<string, number>();
    for (const r of rows) {
      for (const t of r.trades) {
        areasPerTrade.set(t.trade, (areasPerTrade.get(t.trade) ?? 0) + 1);
      }
    }
    return [...areasPerTrade.entries()]
      .flatMap(([slug, n]) => {
        const trade = tradeBySlug(slug);
        return trade ? [{ trade, n }] : [];
      })
      .sort((a, b) => b.n - a.n || a.trade.label.localeCompare(b.trade.label));
  })();

  const body = `
<p class="crumb"><a href="/">${escapeHtml(SITE_NAME)}</a> › Neighbourhoods</p>
<h1>Every neighbourhood ${escapeHtml(SITE_NAME)} covers<span class="count">${
    idx.areas.length} ${plural(idx.areas.length, 'neighbourhood', 'neighbourhoods')}, ${
    openings} open ${plural(openings, 'appointment', 'appointments')}</span></h1>
<p class="lede">A neighbourhood is on this list because a business has told us it
works there. What is open in each one is counted from the openings live, and it
changes through the day — an opening appears when a job is cancelled or a gap
opens between two booked jobs.</p>
${metroBlock
    || '<div class="box"><p>No neighbourhoods are covered yet.</p></div>'}
${tradeCoverage.length ? `<section>
<h2>Which trades work these neighbourhoods</h2>
<p class="note">Every trade with an opening somewhere on this page right now, and
how many of the neighbourhoods it is open in. Each one leads to that trade's own
page, which counts what is open across everywhere ${escapeHtml(SITE_NAME)} covers.</p>
${linkList(tradeCoverage.map((t) => ({
    href: tradePath(t.trade.slug),
    text: t.trade.label,
    sub: `${t.n} ${plural(t.n, 'neighbourhood', 'neighbourhoods')}`,
  })))}
<p class="note">Counted from what is open at this moment, so a trade with a quiet
morning is not on this list and is not therefore absent from the site.
<a href="/browse">The full catalogue</a> is the list that does not move.</p>
</section>` : ''}
<section>
${/*
  WHAT "COVERED" ACTUALLY MEANS, which this page has always assumed the reader
  knew. Every neighbourhood above is a place a business drives to, and the two
  things that follow from that are worth a paragraph each rather than a
  footnote: a boundary on this site is a business's own answer about how far it
  will drive, and an address has to be able to receive a van. A reader who has
  just found their neighbourhood on this page is about to book one, and this is
  the last point at which either fact is cheap to learn.

  Nothing here is a claim about how many businesses cover anywhere or how far
  any of them will go. Where the honest answer is that it depends on the
  business, it says so.
*/''}<h2>What it means for a neighbourhood to be on this list</h2>
<p>A neighbourhood is here because at least one business told us it works there.
That is a business's own statement about how far it is willing to drive, and it
is the only thing that puts a name on this page — not a population, not a
boundary drawn by a council, and not an area we have decided to expand into.
When a business changes the list of places it covers, this page changes with
it.</p>
<p>Which also means a neighbourhood being listed does not tell you every trade is
available in it. The counts beside each name are openings from the businesses
that happen to cover it, and a place covered by two businesses will look thinner
than one covered by twelve however similar the two streets are.</p>
<p>Because the work comes to the address, what matters at your end is whether a
van can arrive and work. Somewhere to stand the vehicle for the length of the
job, access that is not gated or height-limited past what a van will clear,
and — for anything involving water or power — either an outside tap and socket or
a business that carries its own. ${escapeHtml(SITE_NAME)} does not record which
businesses carry their own, so that last one is a question for messages before
the day rather than something this page can answer.</p>
</section>
<section>
<h2>The places ${escapeHtml(SITE_NAME)} serves</h2>
${linkList(metroLinks())}
</section>
<section class="cta">
${/*
  The same closing action the metro pages carry, and the same reasoning: the
  honest thing to offer on a coverage page is a way to be told when something
  opens, because on a quiet hour there is nothing else to do here. Written out
  rather than shared with metroPage because the two say different sentences —
  that one names a place and this one cannot.
*/''}<h2>If your neighbourhood is quiet</h2>
<p>Openings appear through the day as jobs cancel and gaps open between booked
ones, so a neighbourhood with nothing in it this morning may have something by
the afternoon. You can be told when one appears rather than checking, or look
through the catalogue and start from the work instead of the place.</p>
${linkList([
    { href: '/a', text: 'Tell me when one appears' },
    { href: '/browse', text: 'See every service' },
    { href: '/pros', text: 'Cover a neighbourhood' },
  ])}
</section>`;

  return seoPage({
    /*
      THE TITLE GREW BY A CITY EVERY TIME ONE OPENED.

      `metroNames()` is "Los Angeles and Santa Maria" today and is the joined
      list of every live metro, so the fourth city put this title past what a
      result shows and the seventh made it absurd. It reads as written while
      the list is short, which is now, and falls back to a count that is just
      as true and does not move.
    */
    title: fitTitle(
      `Every neighbourhood — ${metroNames()}`,
      `Every neighbourhood — ${METROS.length} ${plural(METROS.length, 'metro', 'metros')}`,
    ),
    /*
      BOTH NUMBERS IN THIS SENTENCE ARE REAL-ONLY, AND ONLY ONE OF THEM WAS.

      The appointment count was already `realOpenings` rather than `openings`,
      for the reason this page goes noindex without one: a count in a snippet
      is read where no sample label can follow it. The count of neighbourhoods
      beside it was `idx.areas.length` and was not, and that is the half of the
      sentence a search result would have quoted hardest — "with mobile
      businesses listed" is a claim about the businesses, and a neighbourhood
      is in `idx.areas` as soon as ANY operator covers it, sample operators
      included. mapData exempts the seeded businesses from the payouts test on
      purpose, so every neighbourhood a demo van works is on that list.

      The state that made it wrong is not the empty site, where this page is
      noindex anyway and nobody reads the sentence. It is one genuine opening
      landing beside the seeded ones: the page becomes indexable that minute
      and the snippet then says twelve neighbourhoods have businesses listed in
      them when eleven of the twelve are ours. Same shape as the trade page's
      count, the metro page's count and the front page's count, all three of
      which were fixed; this one was missed, and metroPage had already worked
      out the identical figure under the identical name for the identical
      sentence.

      The sentence is also built the way metroPage's is — the appointment count
      first, the neighbourhood count as the span it is spread over — rather
      than the other way round as it used to be. That is not a preference: with
      the counts real-only they can both reach one, and "1 neighbourhood ...
      open in them, and 1 appointment across them" was what the old shape then
      wrote. `plural` fixes the nouns and cannot fix the pronouns, so the
      pronouns are gone.

      The H1 above keeps `idx.areas.length` and `openings` and is right to: a
      reader of the page can see every count broken down by neighbourhood
      underneath it, and the cards carry their own labels.
    */
    description: realOpenings
      ? `${realOpenings} ${plural(realOpenings, 'appointment', 'appointments')} open across `
        + `${realWhere} ${plural(realWhere, 'neighbourhood', 'neighbourhoods')} in `
        + `${metroNames()} right now. Every neighbourhood ${SITE_NAME} covers, with what `
        + `is open in each.`
      : `Every neighbourhood ${SITE_NAME} covers across ${metroNames()}, and what is open `
        + `in each. An opening appears when a job is cancelled or a gap opens in the day.`,
    canonical: url,
    // The geography hub with nothing genuine under it anywhere is a directory
    // of empty directories — every link on it leads to a page that has just
    // been marked noindex for the same reason. `sitemapXml` drops it on the
    // same test rather than submitting a URL that answers noindex.
    noindex: realOpenings === 0,
    jsonLd: {
      '@context': 'https://schema.org',
      '@graph': [breadcrumbLd(base, [
        { name: SITE_NAME, url: '/' },
        { name: 'Neighbourhoods', url: '/near' },
      ])],
    },
    body,
    areas: idx.areas,
  });
}

/**
 * /los-angeles, /santa-maria — one page per metro, from the same code.
 *
 * THE RULE FOR THE PROSE ON THIS PAGE, because a city page is where every
 * marketplace starts inventing: the only things it may say are general facts
 * about the place that would be true if this site did not exist, and true
 * statements about how Round The Way works. There is nothing here about how many
 * customers we have, how quickly anybody replies, how much anybody saves, or
 * how well this site is doing. Every number is counted from the openings.
 *
 * The facts about the place come from the metro's own record and NOT from a
 * template, which is the point of keeping them there: Los Angeles has a long
 * dry season and Santa Maria has a marine layer, and a page that said the same
 * thing about both would be inventing about one of them. The closing paragraph
 * is shared because it is about the product rather than the place.
 *
 * EVERY FIGURE IS SCOPED TO THIS METRO. The counts come from the openings in
 * this metro's neighbourhoods, not from every opening on the site — a Santa
 * Maria page reporting the Valley's total would be the most misleading number
 * on the site.
 */
/**
 * The seven questions a metro page answers, and the answers word for word.
 *
 * WHAT MAY BE IN HERE is the rule the rest of the page carries, and it is
 * tighter here than anywhere else on the site, because a FAQPage block is a
 * promise to a search engine that the answer it quotes is on the page when
 * somebody arrives. Every answer below is either a general fact about mobile
 * work that would be true if this site did not exist, or a checkable statement
 * about how Round The Way works today. There is no count, no average, no reply
 * time, no vetting, no guarantee and no insurance in any of them.
 *
 * TWO OF THEM SAY WE DO NOT KNOW, and that is the point of having them. Water
 * and power, and parking, are the two questions a mobile trade raises that a
 * shop does not; the honest answer to both is that it depends on the business
 * and the address. A city page that quietly omitted them would be answering
 * them by implication, wrongly.
 *
 * Copied from `faqsFor` in web/src/pages/Metro.tsx, which renders this same URL
 * for a visitor with JavaScript, and anything edited here has to be edited
 * there: two copies of an FAQ that drift break the promise above silently.
 */
function metroFaqs(metro: Metro): Array<{ q: string; a: string }> {
  const here = metro.name;
  return [
    {
      q: `Does the business come to me in ${here}?`,
      a: 'Yes. Every business listed on Round The Way is mobile: it drives to the '
        + 'address you give and does the work there. There is no shop to visit '
        + 'and nothing to drop off. What each one covers is the list of '
        + 'neighbourhoods on its own listing, so a business that has not said '
        + 'it works in your neighbourhood will not appear against it.',
    },
    {
      q: 'Do they bring their own water and power?',
      a: 'That depends on the trade and on the business, and Round The Way does '
        + 'not record it on the listing, so it is not something this page can '
        + 'tell you. Some mobile businesses carry a tank and a generator and '
        + 'need nothing from you; others expect an outside tap or an outdoor '
        + 'socket. Ask in messages before the appointment rather than on the '
        + 'day — it is a one-line question and it is the usual reason a mobile '
        + 'job cannot go ahead when the van is already outside.',
    },
    {
      q: 'Where will they park?',
      a: 'At or beside the address you give, for as long as the work takes. '
        + 'You know your street and we do not: if parking is permit-only, if '
        + 'the only access is through a gate or a shared courtyard, or if a '
        + 'garage or car park has a height limit a van will not clear, say so '
        + 'in messages when you book. A driveway or a stretch of kerb the van '
        + 'can stand on is the whole of what most of this work needs from a '
        + 'property.',
    },
    {
      q: `Why is nothing open near me in ${here} right now?`,
      a: 'Because an opening is an hour a real business has free this week, and '
        + 'on a busy afternoon there may not be one. This page counts what is '
        + 'listed at the moment it loads and does not estimate, so a quiet hour '
        + 'makes it a short page rather than a padded one. Openings appear when '
        + 'a job is cancelled or a gap opens between two booked jobs, which is '
        + 'why the list is different in the afternoon from what it was in the '
        + 'morning.',
    },
    {
      q: 'Who sets the prices on this page?',
      a: 'The business doing the work. Every price shown here was typed in by '
        + 'the business whose name is on the listing, for that specific hour. '
        + 'Round The Way does not set prices, does not suggest them and takes no '
        + 'part in agreeing them.',
    },
    {
      q: 'How do I pay?',
      a: `${PAY_TODAY_SHORT} Nothing is paid at the door and no cash changes `
        + 'hands; the business is paid by us after the job is done.',
    },
    {
      q: `Does Round The Way check the businesses listed in ${here}?`,
      a: 'No. There is no identity check, no background check run by us, no '
        + 'interview, no licence check and no inspection of anybody\'s work. '
        + 'Where a listing shows a licence, an insurance policy or a background '
        + 'check, that is the business saying so about itself. Licensing boards '
        + 'keep public registers and they are the place to check one.',
    },
  ];
}

export async function metroPage(env: Env, metro: Metro): Promise<string> {
  const base = baseUrlOf(env);
  const idx = await liveIndex(env);
  const url = `${base}${metroPath(metro)}`;

  const areas = idx.areas.filter((a) => metroOf(a).slug === metro.slug);
  const here = new Set(areas.map((a) => a.slug));
  const slots = idx.slots.filter((s) => here.has(s.area_slug));

  const all = distinctGaps(slots);
  const real = all.filter((s) => !s.is_sample);
  const businesses = new Set(all.map((s) => s.operator_id)).size;
  const ranked = tradesByOpenings(slots);
  const cheapest = cheapestReal(all);
  const withOpenings = areas.filter((a) => a.slot_count > 0);
  // How many of this metro's neighbourhoods have something a stranger could
  // actually book, as opposed to something seeded. Only the meta description
  // uses it; see the note over `description` below for why that one sentence
  // counts differently from the page it describes.
  const realWhere = new Set(
    slots.filter((s) => !s.is_sample).map((s) => s.area_slug),
  ).size;
  const name = escapeHtml(metro.name);

  /**
   * WHAT IS LISTED HERE COSTS, and only what is listed here.
   *
   * A city page on any marketplace of this shape carries a "how much does X
   * cost in <city>" module, and it is almost always a national figure with a
   * city's name written over it. This one cannot be: every number below was
   * typed in by a business against an hour it is offering in one of THIS
   * metro's neighbourhoods, and the count is printed beside each range so a
   * reader can see how thin the evidence is.
   *
   * THREE THINGS ARE EXCLUDED, EACH FOR ITS OWN REASON. Sample listings,
   * because a seeded price is a real number on a real operator record and is
   * not a business trading today, and a price row has no room for the label
   * that would say so — the same call `cheapestReal` makes. Trades the
   * catalogue does not name, because each row links to that trade's cost guide
   * and a link to a page that answers 404 is worse than a missing row. And
   * anything outside the metro's most-listed currency, because a median taken
   * across dollars and pounds is not a price.
   *
   * ENOUGH is the cost pages' own threshold rather than a second one: a trade
   * given a range here and told "too few listings to give a range" on the
   * /cost page it links to would make both pages look wrong.
   * web/src/pages/Metro.tsx builds this same table the same way.
   */
  const priced = all.filter((s) => !s.is_sample && s.price_cents > 0);
  const currencyCounts = new Map<string, number>();
  for (const s of priced) currencyCounts.set(s.currency, (currencyCounts.get(s.currency) ?? 0) + 1);
  const priceCurrency = [...currencyCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;

  const priceRows = (() => {
    if (!priceCurrency) return [];
    const buckets = new Map<string, number[]>();
    for (const s of priced) {
      if (s.currency !== priceCurrency) continue;
      const key = (s.trade ?? '').trim().toLowerCase();
      if (!key || !tradeBySlug(key)) continue;
      const bucket = buckets.get(key);
      if (bucket) bucket.push(s.price_cents); else buckets.set(key, [s.price_cents]);
    }
    return [...buckets.entries()].flatMap(([key, cents]) => {
      const trade = tradeBySlug(key);
      if (!trade || cents.length < ENOUGH) return [];
      const sorted = [...cents].sort((a, b) => a - b);
      const low = sorted[0];
      const high = sorted[sorted.length - 1];
      const mid = median(sorted);
      if (low === undefined || high === undefined || mid === null) return [];
      return [{ trade, n: sorted.length, low, mid, high }];
    }).sort((a, b) => b.n - a.n || a.trade.label.localeCompare(b.trade.label));
  })();

  const faqs = metroFaqs(metro);
  const faqBlock = faqs.map((f) => `<details><summary>${escapeHtml(f.q)}</summary>
<p class="note">${escapeHtml(f.a)}</p></details>`).join('');

  const body = `
<p class="crumb"><a href="/">${escapeHtml(SITE_NAME)}</a> › ${name}</p>
<h1>Mobile services in ${name}, ${escapeHtml(metro.state)}<span class="count">${
    all.length} open ${plural(all.length, 'appointment', 'appointments')} right now</span></h1>
<p class="lede">Every appointment listed here is an hour a ${name}
business has free this week — a job that cancelled, or a day that has not
filled. The price is the one the business set, and it is what you pay here
when you book — nothing is added at checkout and nothing is paid at the
door.</p>
${statList([
    { n: String(all.length), of: plural(all.length, 'appointment open', 'appointments open') },
    { n: String(businesses), of: plural(businesses, 'business listed', 'businesses listed') },
    { n: String(withOpenings.length),
      of: plural(withOpenings.length, 'neighbourhood', 'neighbourhoods') },
    ...(cheapest ? [{ n: cheapest.price, of: 'lowest price listed' }] : []),
  ])}
${sampleNote(all.length - real.length, all.length)}
<section>
<h2>Top services in ${name} right now</h2>
${linkList(ranked.slice(0, 12).map((r) => ({
    href: tradePath(r.trade.slug),
    text: r.trade.label,
    sub: `${r.n} open`,
  }))) || `<p class="note">Nothing is open in any trade at the moment. This page
counts what is listed and does not estimate, so on a quiet hour it is a short
page.</p>`}
<p class="note">Ranked by how many appointments each trade has open in ${name} at
this moment, and by nothing else. It is not a popularity list and it moves
through the day. Each link leads to that trade everywhere ${escapeHtml(SITE_NAME)}
covers, which is more than this one place.</p>
</section>
${priceRows.length && priceCurrency ? `<section>
<h2>What businesses are charging in ${name}</h2>
<p class="note">The lowest, middle and highest prices listed against openings in
${name} right now. These are asking prices set by the businesses themselves, not
quotes, not estimates and not an average of anything beyond this metro. Sample
listings we seeded ourselves are left out of every figure here, which is why a
range can differ from the one on the trade's own cost page.</p>
${linkList(priceRows.map((r) => ({
    href: costPath(r.trade.slug),
    text: r.trade.label,
    sub: `${r.low === r.high
      ? money(r.low, priceCurrency)
      : `${money(r.low, priceCurrency)} – ${money(r.high, priceCurrency)}`} · middle ${
      money(r.mid, priceCurrency)} · from ${r.n} ${plural(r.n, 'listing', 'listings')}`,
  })))}
<p class="note">A trade appears here once at least ${ENOUGH} openings in ${name}
carry a price for it; below that there is no spread to report, only two or three
opinions — and a run of openings can belong to one business, so a narrow range is
not proof of a going rate. The middle figure is the median. What you actually pay
is agreed with the business.</p>
</section>` : ''}
<section>
<h2>Neighbourhoods</h2>
${linkList(areas.map((a) => ({
    href: `/near/${a.slug}`,
    text: a.name,
    sub: a.slot_count ? `${a.slot_count} open` : undefined,
  }))) || '<p class="note">No neighbourhoods are covered yet.</p>'}
<p class="note"><a href="/near">Every neighbourhood, with what is open in it</a></p>
</section>
<section>
<h2>Every service</h2>
${TRADE_CATEGORIES.map((c) => `<h3><a href="/browse/${escapeHtml(c.key)}">${
    escapeHtml(c.label)}</a></h3>${linkList(c.trades.map((t) => ({
    href: tradePath(t.slug),
    text: t.label,
  })))}`).join('')}
</section>
<section>
<h2>Why mobile work suits ${name}</h2>
${metro.geography.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n')}
<p>None of that is a claim about ${escapeHtml(SITE_NAME)}. What this site does is
narrower and easier to check: a business posts the hours it has free, at the
price it sets, and you book one of them. Openings appear when a job is cancelled
or a gap opens between two booked jobs, so the list on this page is different in
the afternoon from what it was in the morning.</p>
</section>
<section>
${/*
  THE SECTION THIS SITE HAS THAT A DIRECTORY OF SHOPS CANNOT.

  Everywhere else on the page "mobile" is an adjective. Here it is the practical
  difference: the person doing the work arrives with the water, the power and
  the tools, and what they need back from the address is a place to stand the
  van, something to plug into or a tap, and somewhere the run-off can go. Those
  three are the whole of what turns a booking into a job that can happen, and
  nobody tells a customer about them until the van is already outside.

  NONE OF IT IS SPECIFIC TO THIS METRO and it does not pretend to be — the
  paragraphs above are the place-specific ones and they come from the metro's
  own record. What this does is name the metro in the sentences that are about
  arriving at an address in it. There is no claim in here about what any
  particular business carries, because we do not record that on a listing, so
  the only honest instruction is to ask, and it says so.
*/''}<h2>What a mobile appointment in ${name} involves</h2>
<p>Booking here is booking a van, not a slot at a unit somebody else drives to.
The business builds its week out of addresses across ${name} and the time between
two of them is time it is not being paid for, which is why the openings on this
page appear in runs: an hour that has come free is worth more to a business
filled by somebody near where it already is.</p>
<p>Three things decide whether a job can go ahead once the van arrives, and all
three are about your address rather than about the business. It costs a line in
messages to settle them before the day, and it costs the appointment to discover
them on it.</p>
<dl class="deflist">
<dt>Somewhere to stand the van</dt>
<dd>A driveway, a garage apron or a stretch of kerb the vehicle can occupy for
the length of the job. Permit parking, gated access, a shared courtyard and a
height barrier over an underground car park are all worth mentioning when you
book — a van that cannot stop within a hose or cable run of the work is a van
that cannot do it.</dd>
<dt>Water and power, or the business's own</dt>
<dd>Some mobile businesses carry a tank and a generator and need nothing from the
property. Others expect an outside tap or an outdoor socket. ${escapeHtml(SITE_NAME)}
does not record which on a listing, so this page cannot tell you — ask the
business in messages before the appointment.</dd>
<dt>Somewhere for the run-off to go</dt>
<dd>Anything washed outdoors leaves water behind it, and where it goes depends on
the property rather than on the trade: a sloped driveway, a gutter, a drain in
the wrong place. If you are on a shared drive or above a neighbour, say so.</dd>
</dl>
<p>None of that is a rule ${escapeHtml(SITE_NAME)} enforces. It is what the work is,
described plainly, so that the hour you book is an hour that can be worked.</p>
</section>
<section>
<h2>Questions about booking in ${name}</h2>
<p class="note">What is settled before the van arrives, what is settled with the
business, and what this site does not do.</p>
${faqBlock}
<p class="note"><a href="/safety">What ${escapeHtml(SITE_NAME)} checks, and what it does
not</a></p>
</section>
<section class="cta">
${/*
  THE CLOSING ACTION, AND IT IS DELIBERATELY NOT "BOOK NOW".

  There is nothing to buy on this site yet and this page may well be listing
  nothing at all this hour, so a button promising a transaction would be
  advertising a product that does not exist. The two things a visitor to a quiet
  metro page can genuinely do are wait for an opening and read the catalogue, so
  those are the two things offered; the third is for the other side of the
  marketplace and is worded as what it is.
*/''}<h2>If nothing here suits today</h2>
<p>Openings in ${name} appear through the day as jobs cancel and gaps open. You
can be told when one appears in your neighbourhood instead of checking this page,
or read the whole catalogue and come back to the trade you want.</p>
${linkList([
    { href: '/a', text: 'Tell me when one appears' },
    { href: '/browse', text: 'See every service' },
    { href: '/pros', text: 'List a business here' },
  ])}
</section>`;

  /*
    There is deliberately no "our other cities" block in the body. This page is
    about one place, and a reader on it is looking for work near them rather
    than for a directory of everywhere else.

    THE REASON WRITTEN HERE BEFORE WAS THAT THE FOOTER CARRIES EVERY METRO ON
    EVERY PAGE. It used to, in the directory `siteFooter` had under its four
    columns, and that directory was deliberately removed — so the sentence went
    on justifying this omission with something that had stopped being true. Read
    the footer above: there is no metro link in it.

    The omission is still right, and it is `/near` that makes it so rather than
    the footer. That hub is in the Customers column of every page as "Services
    near you", it groups its neighbourhoods under a linked heading per metro,
    and it is what the closing block below points at. So every metro is two hops
    from every other one, which is well inside what a crawler walks and is the
    right distance for a reader who is not looking for another city.

    If a second metro ever goes live and `/near` stops being reachable from a
    metro page, these pages become an island each and this note is wrong again.
  */

  return seoPage({
    title: `Mobile services in ${metro.name}, ${metro.state}`,
    /*
      BOTH COUNTS IN THIS SENTENCE ARE OVER `real`, AND `cheapest` ALREADY WAS.

      The price was guarded by `cheapestReal` and the two counts beside it were
      not, so a metro page whose every listing is seeded described itself in a
      result as "43 mobile appointments open across 11 Los Angeles
      neighbourhoods right now" — and then, because the guarded half of the
      sentence had nothing real to quote, dropped the "from $x" and read as a
      flat statement of fact. The page cannot say that of itself for long, since
      it goes noindex in exactly that state; the description is written anyway
      because it is what the snippet becomes the minute one genuine opening
      lands beside forty-two seeded ones.
    */
    description: real.length
      ? `${real.length} mobile appointments open across ${realWhere} ${metro.name} `
        + `${plural(realWhere, 'neighbourhood', 'neighbourhoods')} right now`
        + `${cheapest ? `, from ${cheapest.price}` : ''}. Real times and real prices.`
      : `Mobile trades across ${metro.name}, ${metro.state}. Nothing is open at this moment — `
        + `openings appear when a job is cancelled or a gap opens in the day.`,
    canonical: url,
    // `real` is `all` with the seeded listings taken out. A metro page whose
    // every listing is demo data is a city page about businesses we invented,
    // and one with no listings at all is prose about the weather with a
    // catalogue under it. Neither asks to be indexed, and `sitemapXml` leaves
    // both out so the sitemap and the page agree.
    noindex: real.length === 0,
    jsonLd: {
      '@context': 'https://schema.org',
      '@graph': [
        breadcrumbLd(base, [
          { name: SITE_NAME, url: '/' },
          { name: metro.name, url: metroPath(metro) },
        ]),
        // The same seven the block above renders, out of the same array. Not a
        // figure among them: the counts on this page are true for the minute
        // they were taken and a search result quoting one would outlive it,
        // whereas these answers are as true on a quiet hour as on a busy one.
        {
          '@type': 'FAQPage',
          mainEntity: faqs.map((f) => ({
            '@type': 'Question',
            name: f.q,
            acceptedAnswer: { '@type': 'Answer', text: f.a },
          })),
        },
      ],
    },
    body,
    // The footer directory stays site-wide: it is chrome, and cutting it to
    // this metro would leave a visitor no way out of a quiet one.
    areas: idx.areas,
  });
}

// ---------------------------------------------------------------------------
// 5. Sitemap
// ---------------------------------------------------------------------------

/**
 * When each neighbourhood's page last changed.
 *
 * THE GAP HAS TO BE ONE THAT IS ACTUALLY ON THAT PAGE. This used to be a
 * `LEFT JOIN gaps g ON g.operator_id = a.operator_id` — every gap belonging to
 * every business covering the place, with nothing tying the gap to the place —
 * so one operator posting an opening in Encino restamped all eighteen
 * neighbourhoods that operator happens to cover, most of whose pages had not
 * changed by a character. A lastmod that moves when the page did not is worse
 * than none: a crawler that refetches on it and finds the same bytes learns to
 * stop believing the file, and it discounts the whole file rather than the one
 * URL.
 *
 * So the placement is read off the live index instead of guessed in SQL, which
 * also makes it the SAME placement the page itself uses — `mapData` puts an
 * anchored gap in the one neighbourhood the van is in and a whole free day in
 * every neighbourhood its owner covers, and no join can reproduce that. The
 * service area's own timestamp is the floor, for a place whose openings have
 * all been taken.
 */
async function placeLastmod(env: Env, idx: LiveIndex): Promise<Map<string, number>> {
  const [areaRows, gapRows] = await Promise.all([
    env.DB.prepare(
      `SELECT place_slug AS place_slug, MAX(updated_at) AS updated
         FROM service_areas
        WHERE is_active = 1 AND place_slug IS NOT NULL AND place_slug <> ''
        GROUP BY place_slug`,
    ).all<{ place_slug: string; updated: number | null }>(),
    env.DB.prepare(
      `SELECT id, updated_at FROM gaps WHERE status IN ('open','offering')`,
    ).all<{ id: string; updated_at: number | null }>(),
  ]);

  const gapAt = new Map<string, number>();
  for (const g of gapRows.results ?? []) gapAt.set(g.id, g.updated_at ?? 0);

  const out = new Map<string, number>();
  for (const r of areaRows.results ?? []) out.set(r.place_slug, r.updated ?? 0);
  for (const s of idx.slots) {
    const at = gapAt.get(s.gap_id);
    if (at === undefined) continue;
    out.set(s.area_slug, Math.max(out.get(s.area_slug) ?? 0, at));
  }
  return out;
}

/**
 * When each trade's pages last changed, kept as the two halves they are.
 *
 * `gap` is the newest opening in that trade and `op` is the newest operator
 * row, and the split matters because the pages built from them are built from
 * different things. /s/<trade> and /cost/<trade> list the openings, so a gap
 * posted this minute genuinely changes them. /browse and /cost list the
 * CATALOGUE — every trade whether or not anything is open in it, out of a
 * compiled-in array — so an opening changes a count on them and nothing else,
 * and stamping them with it is what makes a crawler fetch two pages an hour
 * to find the same list of thirty-eight names. See `sitemapXml`.
 */
interface TradeStamp { op: number; gap: number }

async function tradeLastmod(env: Env): Promise<Map<string, TradeStamp>> {
  const rows = await env.DB.prepare(
    `SELECT o.trade AS trade,
            MAX(o.updated_at) AS op_updated,
            MAX(COALESCE(g.updated_at, 0)) AS gap_updated
       FROM operators o
       LEFT JOIN gaps g ON g.operator_id = o.id
      WHERE o.trade IS NOT NULL AND o.trade <> ''
        AND o.accept_public_bookings = 1 AND o.plan IN ('trial','active')
      GROUP BY o.trade`,
  ).all<{ trade: string; op_updated: number | null; gap_updated: number | null }>();

  const out = new Map<string, TradeStamp>();
  for (const r of rows.results ?? []) {
    out.set(r.trade.trim().toLowerCase(), {
      op: r.op_updated ?? 0,
      gap: Math.max(r.op_updated ?? 0, r.gap_updated ?? 0),
    });
  }
  return out;
}

/**
 * Published business pages, and when each was last edited.
 *
 * Seeded businesses are dropped here rather than filtered by the caller,
 * because a sample profile is the same kind of thing as a sample opening: fine
 * to show a person, labelled, and not something to submit to a search engine.
 * profilePage marks those noindex for the same reason.
 */
async function profileLastmod(env: Env): Promise<Array<{ slug: string; lastmod: number }>> {
  const rows = await env.DB.prepare(
    `SELECT id, profile_slug AS slug, updated_at AS lastmod
       FROM operators
      WHERE is_published = 1 AND profile_slug IS NOT NULL AND profile_slug <> ''
      ORDER BY profile_slug`,
  ).all<{ id: string; slug: string; lastmod: number | null }>();
  return (rows.results ?? [])
    .filter((r) => !isDemoOperator(r.id))
    .map((r) => ({ slug: r.slug, lastmod: r.lastmod ?? 0 }));
}

/**
 * Every page here that is worth fetching, and nothing else.
 *
 * Empty combinations are left out on purpose. A sitemap is a claim that these
 * URLs are worth fetching; filling it with pages that say "nothing open" burns
 * the crawl budget on the pages least likely to rank and teaches the crawler
 * to come back less often. Sample listings do not count towards a combination
 * being live — demo data is fine to show a person, and is not something to
 * submit to a search engine as inventory.
 *
 * WHAT GOES IN, AND ON WHAT TEST:
 *   /                      always
 *   /browse, /cost         always: both are built from the catalogue rather
 *                          than from today's openings, so both say something
 *                          true on an empty afternoon, and they are the two
 *                          hubs every trade page and cost guide links up to
 *   /<metro>               only with a genuine opening somewhere in it
 *   /near                  only with a genuine opening somewhere at all
 *   /near/<place>          only with a genuine opening in that neighbourhood
 *   /near/<place>/<trade>  only with a genuine opening in that square
 *   /s/<trade>             only with a genuine opening somewhere on the site
 *   /cost/<trade>          a genuine opening in the trade, OR written cost
 *                          factors in lib/costfacts.ts. This is the one test
 *                          here that is not "real inventory", and it is not
 *                          because the page is not only counts: a guide with a
 *                          costfacts entry carries several hundred words of
 *                          hand-written explanation of what makes one job of
 *                          this kind dearer than another, which answers the
 *                          question in its own title on the quietest day of the
 *                          year. `costGuidePage` decides indexability by
 *                          exactly this test; the two are one rule written
 *                          twice, and they must stay so.
 *   /browse/<category>     only where one of its trades passed that test, so a
 *                          category page is never submitted as a list of
 *                          fourteen dead ends
 *   /p/<business>          every published profile
 *
 * THE FOUR TESTS IN THE MIDDLE ARE THE SAME TEST THE PAGES THEMSELVES APPLY,
 * and that is the point of them rather than tidiness. A metro page, the
 * geography hub, a neighbourhood page and a trade page all answer `noindex`
 * when their real inventory is empty; submitting a URL that answers noindex is
 * a file contradicting itself, and it is counted against the file. The two
 * have to be decided by one rule, so they are.
 *
 * lastmod is the newest row the page is built from IN EVERY CASE, and each of
 * the three below is a different set of rows. Stamping every URL with "now" is
 * the common shortcut; stamping unrelated URLs with the freshest row anywhere
 * on the site is the subtler version of it, and search engines discount both.
 */
export async function sitemapXml(env: Env, baseUrl: string): Promise<string> {
  const base = trimSlash(baseUrl);
  const idx = await liveIndex(env);
  const [stamps, tradeStamps, profiles] = await Promise.all([
    placeLastmod(env, idx), tradeLastmod(env), profileLastmod(env),
  ]);
  const t = now();

  /*
    `lastmod` IS NULLABLE, AND NULL IS THE HONEST ANSWER SOMETIMES.

    Every other URL below is stamped with the newest row the page is built
    from, which is the whole doctrine of this function. A cost guide for a
    trade nobody has signed up in yet is built from no row at all: its content
    is the written cost factors compiled into lib/costfacts.ts, and the only
    thing that changes it is a deploy, which nothing here can see. Stamping it
    `now` would move its timestamp on every single fetch — the exact shortcut
    the note below is about, in its purest form, and the crawler's correct
    response is to stop believing the timestamps in this file generally rather
    than only that URL's.

    The sitemap protocol makes <lastmod> optional, and a consumer that finds
    none does what it would have done anyway: decides for itself when to come
    back. So the element is simply not emitted. No timestamp beats a false one.
  */
  type Url = { loc: string; lastmod: number | null; priority: string; changefreq: string };

  /** Genuine openings only. Demo rows are not inventory to submit. */
  const realSlots = idx.slots.filter((s) => !s.is_sample);
  const liveAreas = new Set(realSlots.map((s) => s.area_slug));

  /*
    THE THREE STAMPS, AND WHY THEY ARE NOT ONE.

    `newest` used to be the maximum of everything and was written onto the
    front page, every metro page, /near, /browse and /cost alike — so an
    operator in Burbank posting one opening moved the lastmod of the cost hub,
    which is a compiled-in list of thirty-eight trade names and had not
    changed. A file where most timestamps move for reasons unrelated to the
    URL they are on is a file whose timestamps a crawler stops reading.

    So: `catalogue` is the newest OPERATOR row, which is what actually changes
    /browse and /cost — a business joining, changing trade or being published
    changes the counts on them, and a gap does not. `geography` is the newest
    of the neighbourhood stamps, which is exactly what /near is made of. The
    front page is made of both.
  */
  const catalogue = Math.max(0, ...[...tradeStamps.values()].map((s) => s.op)) || t;
  const geography = Math.max(0, ...stamps.values()) || t;

  const urls: Url[] = [{
    loc: `${base}/`,
    lastmod: Math.max(catalogue, geography),
    priority: '1.0',
    changefreq: 'hourly',
  }];

  for (const m of METROS) {
    const mine = idx.areas.filter((a) => metroOf(a).slug === m.slug);
    if (!mine.some((a) => liveAreas.has(a.slug))) continue;
    urls.push({
      loc: `${base}${metroPath(m)}`,
      lastmod: Math.max(0, ...mine.map((a) => stamps.get(a.slug) ?? 0)) || t,
      priority: '0.9',
      changefreq: 'hourly',
    });
  }

  if (liveAreas.size > 0) {
    urls.push({
      loc: `${base}/near`, lastmod: geography, priority: '0.7', changefreq: 'hourly',
    });
  }

  // The two catalogue hubs. They enumerate every trade page and every cost
  // guide, including the quiet ones the loops below deliberately leave out, so
  // they are the crawl path to a trade that has nothing open this hour.
  urls.push({ loc: `${base}/browse`, lastmod: catalogue, priority: '0.7', changefreq: 'daily' });
  urls.push({ loc: `${base}/cost`, lastmod: catalogue, priority: '0.7', changefreq: 'daily' });

  for (const area of idx.areas) {
    if (!liveAreas.has(area.slug)) continue;
    const stamp = stamps.get(area.slug) ?? t;
    urls.push({
      loc: `${base}/near/${area.slug}`, lastmod: stamp, priority: '0.8', changefreq: 'hourly',
    });

    const mine = realSlots.filter((s) => s.area_slug === area.slug);
    for (const g of byTrade(mine)) {
      if (!g.trade) continue;
      const slug = tradeSlug(g.trade);
      if (!tradeFromSlug(slug)) continue;        // not a page we can render
      urls.push({
        loc: `${base}/near/${area.slug}/${slug}`,
        lastmod: stamp,
        priority: '0.9',                         // the money page outranks its hub
        changefreq: 'hourly',
      });
    }
  }

  // One entry per trade with a genuine opening in it, and its cost guide.
  const liveTrades = new Set(
    realSlots
      .map((s) => (s.trade ?? '').trim().toLowerCase())
      .filter((slug) => slug && tradeBySlug(slug) !== null),
  );

  for (const entry of ALL_TRADES) {
    const live = liveTrades.has(entry.slug);
    /*
      A COST GUIDE IS SUBMITTED ON THE TEST ITS OWN PAGE INDEXES ON, which is
      not the trade page's test. Both used to hang off `live` alone, so a guide
      carrying several hundred words of written cost factors was left out of
      the sitemap on every quiet afternoon while answering `index,follow` — the
      mirror image of the contradiction the note over this function is about,
      and the more expensive direction of it: the only route to those
      thirty-five pages was a crawl of /cost.

      `costsFor` is the same call `costGuidePage` makes to decide `noindex`.
      The two have to agree; they are one rule spelled twice because the page
      and the file are built in different places. See the `noindex` note there.
    */
    const guide = live || costsFor(entry.slug) !== null;
    if (!live && !guide) continue;
    // Null where this trade has no operator row at all, which is the only case
    // in this function with no row to read a timestamp off. See the note over
    // `Url` for why that is left empty rather than filled in with the clock.
    const stamp = tradeStamps.get(entry.slug)?.gap ?? null;
    const seg = canonicalTradeSegment(entry);
    if (live) {
      urls.push({
        loc: `${base}/s/${seg}`, lastmod: stamp ?? t, priority: '0.9', changefreq: 'hourly',
      });
    }
    if (guide) {
      urls.push({
        loc: `${base}/cost/${seg}`,
        lastmod: stamp,
        priority: '0.8',
        // A guide with nothing listed in its trade changes only when its
        // written factors are edited, which is a commit rather than an hour.
        changefreq: live ? 'daily' : 'monthly',
      });
    }
  }

  for (const c of TRADE_CATEGORIES) {
    const live = c.trades.filter((t2) => liveTrades.has(t2.slug));
    if (!live.length) continue;
    const stamp = Math.max(...live.map((t2) => tradeStamps.get(t2.slug)?.gap ?? 0)) || t;
    urls.push({
      loc: `${base}/browse/${c.key}`, lastmod: stamp, priority: '0.6', changefreq: 'daily',
    });
  }

  for (const p of profiles) {
    urls.push({
      loc: `${base}/p/${encodeURIComponent(p.slug)}`,
      lastmod: p.lastmod || t,
      priority: '0.6',
      // A profile changes when its owner edits it or a review lands, which is
      // not an hourly event and saying otherwise wastes the crawl.
      changefreq: 'weekly',
    });
  }

  const body = urls.map((u) => `  <url>
    <loc>${escapeHtml(u.loc)}</loc>
${u.lastmod === null ? '' : `    <lastmod>${isoAt(u.lastmod)}</lastmod>\n`}\
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`;
}

// ---------------------------------------------------------------------------
// 6. robots.txt
// ---------------------------------------------------------------------------

/**
 * What may be crawled.
 *
 * Allowed: the discovery pages, which is everything this file renders.
 *
 * Disallowed, and each for a reason rather than out of habit:
 *   /c/    one guest's conversation, reachable by an unguessable token
 *   /o/    one client's SMS offer link, same
 *   /a/    one visitor's alert settings, same
 *   /api/  JSON, never a search result
 *   /app/  the signed-in operator app; a crawler only ever sees a login wall
 *   /book/ one slot's checkout: it needs JavaScript, it is gone the moment the
 *          slot is taken, and a search result pointing at a dead slot is worse
 *          than no result. The pages here carry the same openings in a form
 *          that is worth indexing.
 *   /search a query page, and the query is whatever anybody types. That makes
 *          it an unbounded set of addresses, each one a thin list of whatever
 *          matched, all of them duplicating the browse and trade pages that are
 *          built to rank for the same words. Crawled, it would spend the budget
 *          for the whole site on results pages and teach a search engine that
 *          this site is mostly near-duplicates.
 *   /account one customer's own bookings, and the most linked-to page on the
 *          site that has nothing on it for anybody else. It is "Your bookings"
 *          in the header nav of every page this file renders, so it is the most
 *          followed internal link here — and it is not a page this Worker
 *          renders at all: the request falls through to the assets binding and
 *          answers with the SPA shell, which to a crawler that runs no
 *          JavaScript is an empty #root with the site's default head on it.
 *          That is a thin near-duplicate of every other shell-only route,
 *          reached from every page, above a signed-in wall it could never get
 *          through. The other pages behind that wall, under /app/, were already
 *          out; this one was missed because it does not share their prefix.
 *
 * Disallow is not a security control — those tokens are secret because they
 * are unguessable, not because of this file.
 *
 * WHAT IS DELIBERATELY NOT DISALLOWED, because the reasoning is the same
 * shape and lands the other way: /about, /help, /safety, /terms, /privacy,
 * /pros, /covered and /join are also served as the bare SPA shell, and they
 * are also thin to a crawler that runs no JavaScript. They are real pages with
 * real writing on them for anybody who does, which is the case /account cannot
 * make, and blocking a page a search engine could read properly in order to
 * tidy up how it looks to one that cannot would be the wrong trade. The right
 * fix for those is to give them server-rendered twins the way every page in
 * this file has one; until then they stay crawlable.
 */
export function robotsTxt(baseUrl: string): string {
  const base = trimSlash(baseUrl);
  return `User-agent: *
Allow: /
Allow: /near/
${METROS.map((m) => `Allow: ${metroPath(m)}`).join('\n')}
Allow: /s/
Allow: /cost/
Allow: /browse/
Allow: /p/
Disallow: /c/
Disallow: /a/
Disallow: /o/
Disallow: /api/
Disallow: /app/
Disallow: /book/
Disallow: /search
Disallow: /account
Disallow: /demo
Disallow: /signin
Disallow: /auth/

Sitemap: ${base}/sitemap.xml
`;
}
