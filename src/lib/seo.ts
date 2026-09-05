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
import { isDemoOperator } from './demo';
import { getPublicProfile } from './profile';
import { mapData, type MapArea, type PublicSlot } from './public';
import {
  ALL_TRADES, TRADE_CATEGORIES, categoryOf, tradeBySlug,
  tradeLabel as catalogueLabel,
  type Trade, type TradeCategory,
} from './trades';
import { formatLocal } from './tz';
import { escapeHtml, haversineMeters, now } from './util';

/** Used in <title>, og:site_name and the breadcrumb root. */
const SITE_NAME = 'Slotfill';

/**
 * The metro the product launched in, alongside LAUNCH_STATE.
 *
 * Named here rather than derived from the rows because it is a fact about
 * where Slotfill operates, not a count of anything. Every page that prints it
 * prints it as the name of the launch area and never as a claim about how much
 * of the city is covered — that number is always counted from the rows in
 * hand, and it is usually small.
 */
const METRO = 'Los Angeles';

/** The metro page's own URL, linked from the geographic pages below. */
const METRO_PATH = '/los-angeles';

/** A slot as mapData hands it back: placed in the neighbourhood it belongs to. */
type PlacedSlot = PublicSlot & { area_slug: string };

interface LiveIndex {
  areas: MapArea[];
  slots: PlacedSlot[];
}

const trimSlash = (u: string) => u.replace(/\/+$/, '');

/**
 * Base URL for canonicals and absolute links.
 *
 * Falls back to path-only URLs rather than guessing a hostname — a canonical
 * pointing at the wrong domain is worse than a relative one, which is legal.
 */
const baseUrlOf = (env: Env): string => trimSlash(env.APP_URL ?? '');

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
// real search form, the three nav links, the four footer columns and the
// directory. Written out here rather than imported because those are React
// components compiled into the browser bundle and this file runs in the
// Worker — but the contents are theirs, and the two are meant to say the same
// things.
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
 */
function siteHeader(): string {
  return `<a class="skip" href="#main">Skip to main content</a>
<header class="head"><div class="head-in">
<a class="wordmark" href="/">${escapeHtml(SITE_NAME)}</a>
<form class="site-search" role="search" method="get" action="/search">
<label class="skip" for="sf-q">Search for a service</label>
<input id="sf-q" name="q" type="search" placeholder="What do you need done?"
 autocomplete="off" enterkeyhint="search">
<button type="submit">Search</button>
</form>
<nav class="site-nav" aria-label="Main">
<a href="/a">Alert me</a>
<a href="/signin">Sign in</a>
<a class="solid" href="/join">List your van</a>
</nav>
</div></header>`;
}

/**
 * The four columns, with the same entries SiteFooter carries.
 *
 * A label with no page behind it is rendered as text, exactly as the React
 * footer renders it: linking those at `/` would be a footer quietly lying
 * about where a dozen of its own links go.
 */
const FOOT_COLUMNS: Array<{ heading: string; links: Array<{ label: string; href?: string }> }> = [
  {
    heading: 'For customers',
    links: [
      { label: 'Browse services', href: '/browse' },
      { label: 'Get an estimate' },
      { label: 'How it works', href: '/' },
      // Both of these are rendered by this file now — see browseIndexPage and
      // costIndexPage — so they are links here as they are in SiteFooter. They
      // were plain text while the only thing behind them was the SPA shell.
      { label: 'Cost guides', href: '/cost' },
      { label: 'Alert me', href: '/a' },
    ],
  },
  {
    heading: 'For businesses',
    links: [
      { label: 'List your business', href: '/join' },
      { label: 'Sign in', href: '/signin' },
      { label: 'How Slotfill works for pros', href: '/join' },
      { label: 'Pricing' },
    ],
  },
  {
    heading: 'Company',
    links: [{ label: 'About' }, { label: 'Careers' }, { label: 'Press' }, { label: 'Blog' }],
  },
  {
    heading: 'Support',
    links: [
      { label: 'Help centre' }, { label: 'Contact' }, { label: 'Safety' },
      { label: 'Terms' }, { label: 'Privacy' },
    ],
  },
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
  return rows.slice(0, 14);
}

/** The path the React app links a trade with: the stored slug, encoded. */
const tradePath = (slug: string) => `/s/${encodeURIComponent(slug)}`;
const costPath = (slug: string) => `/cost/${encodeURIComponent(slug)}`;

function siteFooter(areas?: MapArea[]): string {
  const cols = FOOT_COLUMNS.map((c) => `<nav class="foot-col" aria-label="${
    escapeHtml(c.heading)}"><h2>${escapeHtml(c.heading)}</h2><ul>${
    c.links.map((l) => `<li>${l.href
      ? `<a href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a>`
      : `<span class="foot-soon">${escapeHtml(l.label)}</span>`}</li>`).join('')
  }</ul></nav>`).join('');

  const categories = `<nav class="foot-col" aria-label="Services by category">
<h2>Browse by category</h2><ul>${TRADE_CATEGORIES.map((c) =>
    `<li><a href="/browse/${escapeHtml(c.key)}">${escapeHtml(c.label)}</a></li>`).join('')
}</ul></nav>`;

  const services = `<nav class="foot-col" aria-label="Services">
<h2>Browse by service</h2><ul>${footerTrades().map((t) =>
    `<li><a href="${escapeHtml(tradePath(t.slug))}">${escapeHtml(t.label)}</a></li>`).join('')
}</ul></nav>`;

  // Counted in this request or absent entirely. A count this function was not
  // given is a number it would have to invent.
  const places = areas?.length
    ? `<nav class="foot-col" aria-label="Areas"><h2>Open near you</h2><ul>${
      areas.map((a) => `<li><a href="/near/${escapeHtml(a.slug)}">${escapeHtml(a.name)}${
        a.slot_count > 0 ? `<span class="foot-n">${a.slot_count}</span>` : ''
      }</a></li>`).join('')
    }<li><a href="/near">Every neighbourhood</a></li>
<li><a href="${escapeHtml(METRO_PATH)}">${escapeHtml(METRO)}</a></li></ul></nav>`
    : '';

  return `<footer class="site-foot"><div class="foot-in">
<div class="foot-cols">${cols}</div>
<div class="foot-dir">${categories}${services}${places}</div>
<div class="foot-legal">
<p><a href="/">${escapeHtml(SITE_NAME)}</a> lists appointments that local
businesses have free this week, at the price each one set. Openings appear when
a job is cancelled or a gap opens between two booked jobs, so these pages change
through the day.</p>
<p>Nothing here is verified by us. Licence and insurance details are what a
business says about itself; the issuing board's public register is the place to
check one.</p>
<p>Map data © OpenStreetMap contributors, tiles by OpenFreeMap.
Postcode centroids from GeoNames, CC BY 4.0.</p>
<p>Prices are set by the business doing the work.</p>
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
 * WHY THIS IS A FUNCTION RATHER THAN A CONSTANT. Four of these pages are also
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
--accent:#00875a;--accent-ink:#006644;--accent-soft:#e8f7f0;--accent-line:#a8e3ca}
@media(prefers-color-scheme:dark){${root}{
--bg:#0b0f14;--surface:#131a22;--ink:#eef2f7;--ink-2:#c6ceda;--muted:#8d97a5;
--line:#1e2833;--line-2:#2b3846;
--accent:#16e08e;--accent-ink:#7cefc0;--accent-soft:#0f2a20;--accent-line:#1d5741}}
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
${s} .head{background:var(--surface);border-bottom:1px solid var(--line)}
${s} .head-in{max-width:60rem;margin:0 auto;padding:10px 16px;display:flex;
flex-wrap:wrap;align-items:center;gap:10px}
${s} .wordmark{font-weight:800;letter-spacing:-.03em;font-size:1.14rem;
text-decoration:none;color:var(--ink)}
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
border:1px solid var(--line-2);border-radius:999px;padding:7px 12px;color:var(--ink-2)}
${s} .site-nav a.solid{background:var(--accent);border-color:var(--accent);color:#fff}
@media(prefers-color-scheme:dark){${s} .site-nav a.solid{color:#04140d}}
${s} .skip{position:absolute;left:-9999px}
${s} .skip:focus{position:static;display:inline-block;padding:8px 12px}
${s} .site-foot{background:var(--surface);border-top:1px solid var(--line);
margin-top:48px;padding:28px 0 40px}
${s} .foot-in{max-width:60rem;margin:0 auto;padding:0 16px}
${s} .foot-cols{display:grid;gap:20px;grid-template-columns:repeat(2,minmax(0,1fr))}
@media(min-width:760px){${s} .foot-cols{grid-template-columns:repeat(4,minmax(0,1fr))}}
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
${s} .foot{margin-top:40px;padding-top:16px;border-top:1px solid var(--line);
color:var(--muted);font-size:.85rem}
${s} :focus-visible{outline:3px solid var(--accent);outline-offset:2px;border-radius:4px}
@media(prefers-reduced-motion:reduce){${s} *{animation-duration:.001ms!important;
animation-iteration-count:1!important;transition-duration:.001ms!important;
scroll-behavior:auto!important}}
`;
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

  return `<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(desc)}">
<meta name="robots" content="${robots}">
<link rel="canonical" href="${escapeHtml(opts.canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}">
<meta property="og:title" content="${escapeHtml(opts.title)}">
<meta property="og:description" content="${escapeHtml(desc)}">
<meta property="og:url" content="${escapeHtml(opts.canonical)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${escapeHtml(opts.title)}">
<meta name="twitter:description" content="${escapeHtml(desc)}">`;
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
    .replace(/<title>[\s\S]*?<\/title>/i, '')
    .replace(/<meta\s+name="description"[^>]*>/i, '')
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
  const inner = `${siteHeader()}<div class="wrap"><main id="main">${opts.body}</main></div>${
    siteFooter(opts.areas)}`;

  if (opts.shell) {
    const merged = intoShell(
      opts.shell,
      `${head}\n<style>${styleSheet('.sf-ssr')}</style>`,
      `<div class="sf-ssr">${inner}${jsonLd}</div>`,
    );
    if (merged) return merged;
  }

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${head}
<style>${styleSheet()}</style>
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

function offerLd(s: PlacedSlot, placeName: string, pageUrl: string, base: string): unknown {
  const provider: Record<string, unknown> = {
    '@type': 'LocalBusiness',
    name: s.business_name,
    areaServed: { '@type': 'Place', name: `${placeName}, ${LAUNCH_STATE}` },
  };
  // Only when they have actually published a profile page to point at.
  if (s.profile_slug) provider.url = `${base}/p/${s.profile_slug}`;

  const service: Record<string, unknown> = {
    '@type': 'Service',
    name: s.service_name,
    provider,
    areaServed: { '@type': 'Place', name: `${placeName}, ${LAUNCH_STATE}` },
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
  placeName: string,
  pageUrl: string,
): unknown {
  const real = slots.filter((s) => !s.is_sample);
  const graph: unknown[] = [breadcrumbLd(base, trail)];
  if (real.length) {
    graph.push({
      '@type': 'ItemList',
      numberOfItems: real.length,
      itemListElement: real.map((s, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        item: offerLd(s, placeName, pageUrl, base),
      })),
    });
  }
  return { '@context': 'https://schema.org', '@graph': graph };
}

// ---------------------------------------------------------------------------
// Shared rendering
// ---------------------------------------------------------------------------

function slotItem(s: PlacedSlot): string {
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
<a class="book" href="/book/${escapeHtml(s.gap_id)}">See this opening</a>
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

const slotList = (slots: PlacedSlot[]) =>
  `<ul class="slots">${slots.map(slotItem).join('')}</ul>`;

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
 */
async function lastOpeningIn(env: Env, placeSlug: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT g.starts_at AS starts_at, o.timezone AS timezone,
            o.country AS country, o.language AS language
       FROM gaps g
       JOIN operators o ON o.id = g.operator_id
       JOIN service_areas a ON a.operator_id = o.id AND a.is_active = 1
      WHERE a.place_slug = ? AND g.starts_at < ?
      ORDER BY g.starts_at DESC
      LIMIT 1`,
  ).bind(placeSlug, now()).first<{
    starts_at: number; timezone: string; country: string; language: string | null;
  }>();
  if (!row) return null;
  return formatLocal(row.starts_at, row.timezone, localeFor(row.country, row.language));
}

/**
 * A public URL may be either the shared neighbourhood key or one business's
 * own area slug ('sherman-oaks-2'), because /near/:slug has always accepted
 * both. Everything here canonicalises to the neighbourhood key.
 */
async function resolvePlace(env: Env, idx: LiveIndex, slug: string): Promise<MapArea | null> {
  const direct = idx.areas.find((a) => a.slug === slug);
  if (direct) return direct;
  const row = await env.DB.prepare(
    `SELECT place_slug FROM service_areas
      WHERE (place_slug = ? OR slug = ?) AND is_active = 1 LIMIT 1`,
  ).bind(slug, slug).first<{ place_slug: string | null }>();
  const key = row?.place_slug ?? null;
  if (!key) return null;
  return idx.areas.find((a) => a.slug === key) ?? null;
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

function linkList(items: Array<{ href: string; text: string; sub?: string }>): string {
  if (!items.length) return '';
  return `<ul class="links">${items.map((i) => `<li><a href="${escapeHtml(i.href)}">${
    escapeHtml(i.text)}</a>${i.sub ? ` <span class="note">${escapeHtml(i.sub)}</span>` : ''}</li>`)
    .join('')}</ul>`;
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
  const where = `${place.name}, ${LAUNCH_STATE}`;
  const whereSafe = escapeHtml(where);

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

  const description = mine.length
    ? `${mine.length} appointments open in ${where}: ${
        tradeNames.slice(0, 3).map(tradeLabel).join(', ') || 'local services'}. `
      + `Real times and real prices, ${fromPrice ? `from ${fromPrice}, ` : ''}`
      + `booked without a phone call.`
    : `What is open in ${where} right now, with the time and the price. `
      + `Openings appear when a job is cancelled or a gap opens in the day.`;

  // The other half of the cross-link the brief asks for: a place page names
  // the trades open in it, and each of those names goes to that trade's own
  // city-wide page as well as to the trade-in-this-place one above. Only
  // trades in the catalogue, because only those have a /s/ page to reach.
  const cityWide = linkList(jump
    .map((t) => ({ t, cat: tradeBySlug(t.trade) }))
    .filter((x): x is { t: { trade: string; n: number }; cat: Trade } => x.cat !== null)
    .map((x) => ({
      href: tradePath(x.cat.slug),
      text: `${x.cat.label} across ${METRO}`,
      sub: `${x.t.n} of them here`,
    })));

  const body = `
<p class="crumb"><a href="/">${escapeHtml(SITE_NAME)}</a> › <a href="${
    escapeHtml(METRO_PATH)}">${escapeHtml(METRO)}</a> › ${escapeHtml(place.name)}</p>
<h1>Open appointments in ${escapeHtml(where)}</h1>
<p class="lede">${lede}</p>
${jumpNav}
${empty}
${sections}
<section>
<h2>Nearby</h2>
${nearbyLinks || '<p class="note">No other neighbourhoods are covered yet.</p>'}
<p class="note"><a href="/near">Every neighbourhood Slotfill covers</a> ·
<a href="${escapeHtml(METRO_PATH)}">${escapeHtml(METRO)}</a></p>
</section>
${cityWide ? `<section>
<h2>The same work elsewhere in ${escapeHtml(METRO)}</h2>
${cityWide}
</section>` : ''}`;

  return seoPage({
    title: `Open appointments in ${where}`,
    description,
    canonical: url,
    // A neighbourhood is a real, bounded place with a page that says something
    // true whether or not it is busy, so it stays indexable when quiet. The
    // trade × place grid below is the one that gets the empty-page treatment.
    noindex: false,
    jsonLd: pageLd(base, [
      { name: SITE_NAME, url: '/' },
      { name: place.name, url: `/near/${place.slug}` },
    ], mine, place.name, url),
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
the price the business set for that piece of work, and the time is a real slot
in a real calendar.</p>
</section>`;

  const licence = `<section>
<h2>Licensing for ${escapeHtml(label.toLowerCase())} in ${escapeHtml(LAUNCH_STATE)}</h2>
<p class="note">${licenceNote(trade)}</p>
</section>`;

  const body = `
<p class="crumb"><a href="/">${escapeHtml(SITE_NAME)}</a> › <a href="/near/${
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
      text: `${label} across ${METRO}`,
    },
    {
      href: costPath(tradeBySlug(trade)!.slug),
      text: `What ${label.toLowerCase()} costs`,
    },
  ])}
</section>` : ''}`;

  const description = empty
    ? `${label} in ${place.name}, ${LAUNCH_STATE}. Nothing is open right now — `
      + `openings appear when a job is cancelled or a gap opens in the day.`
    : `${mine.length} ${label.toLowerCase()} appointment${mine.length === 1 ? '' : 's'} `
      + `open in ${place.name}, ${LAUNCH_STATE}`
      + `${cheapest ? `, from ${cheapest.price}` : ''}`
      + `${soonest ? `, next ${soonest.when}` : ''}. Real times, real prices.`;

  return seoPage({
    title: `${label} in ${place.name}, ${LAUNCH_STATE}`,
    description,
    canonical: url,
    // Index only when there is something real to rank. An empty square of the
    // trade × place grid, or one holding nothing but sample data, is thin
    // content asking to be judged as thin content.
    noindex: real.length === 0,
    jsonLd: pageLd(base, [
      { name: SITE_NAME, url: '/' },
      { name: place.name, url: `/near/${place.slug}` },
      { name: label, url: `/near/${place.slug}/${slug}` },
    ], mine, place.name, url),
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
 * Every answer below that touches money opens with this and then says which
 * half of paying is designed and not yet built, exactly as Trade.tsx and
 * CostGuide.tsx do. When the seam lands, PaymentState.tsx changes, this fails,
 * and both surfaces move together.
 */
export const PAY_TODAY_SHORT =
  'Nothing is paid on this site yet. Booking holds the appointment, asks for '
  + 'no card and takes no money, and you settle the price with the business '
  + 'directly.';

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
 */
export const canonicalTradeSegment = (t: Trade) => encodeURIComponent(t.slug);

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
 * The six answers the React trade page carries, kept in one array so the
 * visible block and the FAQPage below it are built from the same words. Every
 * one of them describes something this product actually does; there is nothing
 * here about vetting, insurance, licensing or response times.
 */
function faqsFor(tradeName: string): Array<{ q: string; a: string }> {
  return [
    {
      q: 'How do I pay?',
      a: `${PAY_TODAY_SHORT} The design is that the labour is paid for here, on `
        + 'the site, at the moment you book — with no cash and nothing paid at '
        + 'the door — but that part is not built yet.',
    },
    {
      q: 'What happens if the job needs a part?',
      a: 'The business sends you a price for the part in your messages. Nothing '
        + 'is fitted until you approve that price, and once paying on the site '
        + 'is switched on that approval is also what charges you for it.',
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
      a: 'Nothing today, because nothing has been paid. Once paying on the site '
        + 'is switched on, cancelling close to the appointment will cost a '
        + 'graduated fee: a quarter of the job inside 48 hours, three quarters '
        + 'inside 12 hours, and the whole amount once they have arrived. It '
        + 'works the same way in both directions — a business that cancels on '
        + 'you pays the same.',
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

export async function tradePage(
  env: Env, segment: string, opts: PageOptions = {},
): Promise<string | null> {
  const entry = tradeFromPathSegment(segment);
  if (!entry) return null;                      // the SPA says "we do not have this trade"

  const base = baseUrlOf(env);
  const idx = await liveIndex(env);
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
       business doing the work. Booking one holds it; nothing is paid on this
       site yet, so you settle the price with the business directly.`
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
<p class="note"><a href="/near">Every neighbourhood ${escapeHtml(SITE_NAME)} covers</a> ·
<a href="${escapeHtml(METRO_PATH)}">${escapeHtml(METRO)}</a></p>
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

  const description = mine.length
    ? `${mine.length} ${lower} ${plural(mine.length, 'appointment', 'appointments')} open on `
      + `${SITE_NAME}${claimable ? `, from ${claimable.price}` : ''}, `
      + `from ${businesses} ${plural(businesses, 'business', 'businesses')}. `
      + `Real times, real prices, booked without a phone call.`
    : `${label} on ${SITE_NAME}. Nothing is open right now — openings appear when `
      + `a job is cancelled or a day does not fill.`;

  return seoPage({
    title: `${label} — what is open now`,
    description,
    canonical: url,
    // Indexable whether or not it is busy. This is one page per trade in a
    // catalogue of thirty-nine, not a square of the combinatorial trade ×
    // place grid, and it says something true — what the work is, what it costs
    // here, how booking it works — on the quietest day of the year.
    noindex: false,
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
 * The six answers the React cost page carries, word for word.
 *
 * This file and web/src/pages/CostGuide.tsx render the same route — one for a
 * visitor with no JavaScript and for crawlers, one for a visitor with it — and
 * a FAQPage block is a promise that the answer quoted in a search result is on
 * the page when somebody arrives. Two copies that drift break that promise
 * silently, so any edit here has to be made in that file's faqsFor as well.
 * The trade page keeps its own set: those answers are about booking a job,
 * these are about where a price on this page came from.
 */
function costFaqsFor(tradeName: string): Array<{ q: string; a: string }> {
  return [
    {
      q: `Are these average prices for ${tradeName}?`,
      a: 'No. Every figure on this page is a price a business on Slotfill is '
        + 'asking today for an appointment it has open, counted at the moment '
        + 'the page loaded. We have no national survey for this trade and we '
        + 'do not estimate one.',
    },
    {
      q: 'Who sets these prices?',
      a: 'The business doing the work. Every price here was listed by the '
        + 'business whose name is on the appointment, and Slotfill does not '
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
      a: `${PAY_TODAY_SHORT} The design is that the labour is paid for here, `
        + 'on the site, at the moment you book, with no cash and nothing paid '
        + 'at the door — but that part is not built yet.',
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
      a: 'Nothing today, because nothing has been paid. Once paying on the '
        + 'site is switched on, cancelling close to the appointment will cost '
        + 'a graduated fee: a quarter of the job inside 48 hours, three '
        + 'quarters inside 12 hours, and the whole amount once they have '
        + 'arrived. It works the same way in both directions — a business that '
        + 'cancels on you pays the same.',
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
    ...(services.length && currency
      ? [{ id: 'cg-svc', label: 'What each job is listed at' }] : []),
    { id: 'cg-why', label: 'What changes the price' },
    { id: 'cg-hire', label: `How to hire ${lower} on ${SITE_NAME}` },
    { id: 'cg-faq', label: `Questions about what ${lower} costs` },
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
${tocBlock}
${table}
<section>
<h2 id="cg-why">What changes the price</h2>
<p class="note">Three things, and only three, because these are the only ones we
can actually stand behind.</p>
<h3>How long the job takes</h3>
<p>Every listing above is a block of a business's day with a length on it. A
longer block is more of their day, and it is priced that way by the person whose
day it is.</p>
<h3>Whether it needs parts</h3>
<p>Parts are handled apart from the price on the card, and the booking page says
which way round it is for the service you are looking at: either parts are
included in that price, or they are quoted separately. Where they are quoted the
price on the card is the labour, the business sends you a price for the part in
your messages once they can see what is needed, and nothing is fitted until you
approve that price.</p>
<h3>How far they have to come</h3>
<p>Each business sets its own prices and lists only the areas it covers, so the
same job can be listed at different prices by businesses working in different
parts of the city.</p>
</section>
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
<section>
<h2 id="cg-near">Find ${escapeHtml(lower)} near you</h2>
${linkList([
    {
      href: tradePath(entry.slug),
      text: mine.length
        ? `${mine.length} ${plural(mine.length, 'appointment', 'appointments')} open right now`
        : `The listing page for ${lower}`,
    },
    ...(cheapest && currency ? [{
      href: `/book/${cheapest.gap_id}`,
      text: `Book the cheapest one: ${money(cheapest.price_cents, currency)}`,
      sub: `${cheapest.service_name} with ${cheapest.business_name}, ${cheapest.when}`,
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
<p class="note"><a href="/near">Every neighbourhood ${escapeHtml(SITE_NAME)} covers</a> ·
<a href="${escapeHtml(METRO_PATH)}">${escapeHtml(METRO)}</a></p>` : ''}
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

  const description = n === 0
    ? `What ${lower} costs on ${SITE_NAME}. Nothing is listed in this trade right now, `
      + `and we do not estimate a price we cannot count.`
    : `${n} ${lower} ${plural(n, 'price', 'prices')} listed on ${SITE_NAME} right now`
      + `${realLow !== null && currency ? `, from ${money(realLow, currency)}` : ''}`
      + `${realMid !== null && currency ? `, middle ${money(realMid, currency)}` : ''}. `
      + `Asking prices counted off the listings, not a survey and not an average.`;

  return seoPage({
    title: `What does ${lower} cost?`,
    description,
    canonical: url,
    noindex: false,
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
// Each guide above closes with "Every cost guide on Slotfill" pointing here,
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
<section>
<h2>The other ways in</h2>
${linkList([
    { href: '/browse', text: `Every service ${SITE_NAME} covers` },
    { href: '/near', text: 'Every neighbourhood' },
    { href: METRO_PATH, text: `Mobile services in ${METRO}` },
  ])}
<p class="note">Every price on this page was listed by the business that would
do the work, and counted at the moment the page was built. It is what they are
asking today, not an average of the trade.</p>
</section>`;

  return seoPage({
    title: 'What things cost — every cost guide',
    description: listings > 0
      ? `${rows.length} cost ${plural(rows.length, 'guide', 'guides')} on ${SITE_NAME}, `
        + `priced from the ${listings} ${plural(listings, 'listing', 'listings')} businesses `
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

  const sections = TRADE_CATEGORIES.map((c) => `<section>
<h2><a href="/browse/${escapeHtml(c.key)}">${escapeHtml(c.label)}</a> <span class="note">${
    c.trades.length} ${plural(c.trades.length, 'service', 'services')}</span></h2>
${c.trades.length
    ? linkList(c.trades.map((t) => {
      const n = open.get(t.slug) ?? 0;
      return {
        href: tradePath(t.slug),
        text: t.label,
        sub: [t.hint, n > 0
          ? `${n} ${plural(n, 'appointment', 'appointments')} open now`
          : 'None open right now'].filter(Boolean).join(' · '),
      };
    }))
    // Only reachable if the catalogue files no services under this heading,
    // which is a gap in the catalogue rather than a quiet week.
    : '<p class="note">No services are listed in this category yet.</p>'}
</section>`).join('');

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
<h2>The other way round</h2>
<p class="note">${escapeHtml(SITE_NAME)} can be read by the job, which is this
page, or by where the van is.</p>
${linkList([
    { href: '/near', text: 'Browse by neighbourhood' },
    { href: METRO_PATH, text: `Mobile services in ${METRO}` },
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
      '@graph': [breadcrumbLd(base, [
        { name: SITE_NAME, url: '/' },
        { name: 'Browse', url: '/browse' },
      ])],
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

  const rows = linkList(here.trades.map((t) => {
    const n = open.get(t.slug) ?? 0;
    return {
      href: tradePath(t.slug),
      text: t.label,
      sub: [t.hint, n > 0
        ? `${n} ${plural(n, 'appointment', 'appointments')} open now`
        : 'None open right now'].filter(Boolean).join(' · '),
    };
  }));

  const others = TRADE_CATEGORIES.filter((c) => c.key !== here.key);

  const body = `
<p class="crumb"><a href="/">${escapeHtml(SITE_NAME)}</a> › ${escapeHtml(here.label)}</p>
<h1>${escapeHtml(here.label)}<span class="count">${total > 0
    ? `${total} open ${plural(total, 'appointment', 'appointments')} in this category`
    : 'Nothing open in this category right now'}</span></h1>
<p class="lede">Pick the job you need doing. Every service below has its own
page, which counts what is open in it and says plainly when the answer is
nothing.</p>
${rows || '<p class="note">No services are listed in this category yet.</p>'}
<section>
<h2>Looking for something else?</h2>
${linkList(others.map((c) => ({ href: `/browse/${c.key}`, text: c.label })))}
</section>
<section>
<h2>By neighbourhood</h2>
${linkList(idx.areas.slice(0, 12).map((a) => ({
    href: `/near/${a.slug}`,
    text: `Open appointments in ${a.name}`,
    sub: a.slot_count ? `${a.slot_count} open` : undefined,
  })))}
<p class="note"><a href="/near">Every neighbourhood</a> ·
<a href="${escapeHtml(METRO_PATH)}">${escapeHtml(METRO)}</a></p>
</section>`;

  return seoPage({
    title: `${here.label} — mobile services`,
    description: total > 0
      ? `${here.label} on ${SITE_NAME}: ${here.trades.length} services and ${total} `
        + `${plural(total, 'appointment', 'appointments')} open right now, counted live.`
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
// 3f. /p/:slug — one business's page
// ---------------------------------------------------------------------------

const WORK_LOCATION: Record<string, string[]> = {
  i_travel: ['I travel to my customers'],
  they_travel: ['My customers travel to me'],
  both: ['My customers travel to me', 'I travel to my customers'],
};

const STARS = (n: number) => '★★★★★'.slice(0, Math.max(0, Math.min(5, n)));

const reviewDate = (epochSeconds: number) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    .format(new Date(epochSeconds * 1000));

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
  const { operator: o, photos, rating, reviews, faqs, areas } = data;
  const path = `/p/${slug}`;
  const url = `${base}${path}`;
  const entry = tradeBySlug(o.trade);

  // What this business has open, counted from the same read every other page
  // here counts from. Matched on profile_slug rather than on the business
  // name, which is neither unique nor stable.
  const theirs = distinctGaps(idx.slots.filter((s) => s.profile_slug === slug));

  const overview = [
    ...(o.hired_count > 0 ? [`Hired ${o.hired_count} times`] : []),
    ...(o.background_checked_at ? ['Background checked'] : []),
    o.employees === 1 ? 'Solo operator' : `${o.employees} employees`,
    ...(o.years_in_business != null ? [`${o.years_in_business} years in business`] : []),
    ...(o.years_experience != null ? [`${o.years_experience} years in the trade`] : []),
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
<p class="note">Messages go through the app. No phone numbers are exchanged.</p>
${o.bio ? `<section><h2>About</h2><p>${escapeHtml(o.bio)}</p></section>` : ''}
<section>
<h2>Overview</h2>
<ul class="links">${overview.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>
${areas.length ? `<h3>Serves</h3><p>${escapeHtml(areas.join(', '))}</p>` : ''}
${o.payment_methods
    ? `<h3>Payment methods</h3><p>This business accepts payments via ${
      escapeHtml(o.payment_methods)}.</p>`
    : ''}
${social.length ? `<h3>Social media</h3><p>${social.map((x) =>
    `<a href="${escapeHtml(x.href)}" rel="noreferrer noopener nofollow">${
      escapeHtml(x.name)}</a>`).join(', ')}</p>` : ''}
</section>
<section>
<h2>Services offered</h2>
<h3>Work location</h3>
<ul class="links">${(WORK_LOCATION[o.work_location] ?? WORK_LOCATION.i_travel!)
    .map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
</section>
${photos.length ? `<section>
<h2>Photos <span class="note">(${photos.length})</span></h2>
<p>${photos.map((p) => `<a href="/api/public/photo/${escapeHtml(p.r2_key)}"><img
 src="/api/public/photo/${escapeHtml(p.r2_key)}" width="160" loading="lazy" alt="${
    escapeHtml(p.caption ?? `Work by ${o.business_name}`)}"></a>`).join(' ')}</p>
</section>` : ''}
${theirs.length ? `<section>
<h2>Open right now</h2>
${slotList(theirs)}
</section>` : ''}
<section>
<h2>Reviews</h2>
${reviewBlock}
</section>
<section>
<h2>Credentials</h2>
${o.background_checked_at
    ? `<p><strong>Background check</strong><br>${escapeHtml(o.background_check_name ?? '')}${
      o.background_check_provider
        ? `<br><span class="note">Checked by ${
          escapeHtml(o.background_check_provider)}</span>` : ''}</p>`
    : '<p class="note">This business has not been background checked yet.</p>'}
<p class="note">Nothing on this site verifies a trade licence or insurance. What
a business says about its own licensing is its own claim; the issuing board's
public register is the place to check one.</p>
</section>
${faqs.length ? `<section><h2>FAQs</h2>${faqs.map((f) => `<details>
<summary>${escapeHtml(f.question)}</summary><p class="note">${
    escapeHtml(f.answer)}</p></details>`).join('')}</section>` : ''}
${entry ? `<section>
<h2>Other ${escapeHtml(entry.label.toLowerCase())} businesses</h2>
${linkList([
    { href: tradePath(entry.slug), text: `${entry.label} — what is open now` },
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
   * The node is typed as both Product and LocalBusiness rather than duplicated
   * as two nodes carrying the same figures: it is one thing — a business you
   * can book — and two nodes with one aggregateRating between them would be
   * inviting a search engine to count the reviews twice.
   */
  const businessLd: Record<string, unknown> = {
    '@type': ['Product', 'LocalBusiness'],
    name: o.business_name,
    url,
    areaServed: areas.map((a) => ({ '@type': 'Place', name: `${a}, ${LAUNCH_STATE}` })),
  };
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
      entry ? `${entry.label} in ${METRO}, ${LAUNCH_STATE}.` : null,
      rating.count > 0
        ? `${rating.average} from ${rating.count} ${plural(rating.count, 'review', 'reviews')}.`
        : 'No reviews yet.',
      theirs.length
        ? `${theirs.length} ${plural(theirs.length, 'appointment', 'appointments')} open now.`
        : null,
    ].filter(Boolean).join(' ');

  return seoPage({
    title: o.business_name,
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
    return { area: a, n: mine.length, trades: linkableTrades(mine) };
  }).sort((x, y) => y.n - x.n || x.area.name.localeCompare(y.area.name));

  const live = rows.filter((r) => r.n > 0);
  const quiet = rows.filter((r) => r.n === 0);
  // Counted over the whole index rather than by adding the per-area figures
  // up: a whole free day is genuinely offered in every neighbourhood its owner
  // covers, so it is right on each of those pages and would be counted several
  // times over in a total.
  const openings = distinctGaps(idx.slots).length;

  const section = (list: typeof rows) => list.map((r) => `<section>
<h2><a href="/near/${escapeHtml(r.area.slug)}">${escapeHtml(r.area.name)}</a>${r.n
    ? ` <span class="note">${r.n} open</span>` : ''}</h2>
${r.trades.length
    ? `<ul class="jump">${r.trades.map((t) => `<li><a href="/near/${
      escapeHtml(r.area.slug)}/${escapeHtml(tradeSlug(t.trade))}">${
      escapeHtml(tradeLabel(t.trade))} (${t.n})</a></li>`).join('')}</ul>`
    : '<p class="note">Nothing open here at the moment.</p>'}
</section>`).join('');

  const body = `
<p class="crumb"><a href="/">${escapeHtml(SITE_NAME)}</a> › <a href="${
    escapeHtml(METRO_PATH)}">${escapeHtml(METRO)}</a> › Neighbourhoods</p>
<h1>Every neighbourhood ${escapeHtml(SITE_NAME)} covers<span class="count">${
    idx.areas.length} ${plural(idx.areas.length, 'neighbourhood', 'neighbourhoods')}, ${
    openings} open ${plural(openings, 'appointment', 'appointments')}</span></h1>
<p class="lede">A neighbourhood is on this list because a business has told us it
works there. What is open in each one is counted from the openings live, and it
changes through the day — an opening appears when a job is cancelled or a gap
opens between two booked jobs.</p>
${live.length
    ? `<h2>Open now</h2>${section(live)}`
    : '<div class="box"><p>Nothing is open in any neighbourhood at the moment.</p></div>'}
${quiet.length ? `<section><h2>Quiet right now</h2>
${linkList(quiet.map((r) => ({
    href: `/near/${r.area.slug}`,
    text: `Open appointments in ${r.area.name}`,
  })))}
</section>` : ''}
<section>
<h2>The whole city</h2>
${linkList([{ href: METRO_PATH, text: `Mobile services in ${METRO}` }])}
</section>`;

  return seoPage({
    title: `Every neighbourhood — ${METRO}, ${LAUNCH_STATE}`,
    description: `${idx.areas.length} ${METRO} ${plural(idx.areas.length,
      'neighbourhood', 'neighbourhoods')} with mobile businesses listed, and ${openings} `
      + `${plural(openings, 'appointment', 'appointments')} open across them right now.`,
    canonical: url,
    noindex: false,
    jsonLd: {
      '@context': 'https://schema.org',
      '@graph': [breadcrumbLd(base, [
        { name: SITE_NAME, url: '/' },
        { name: METRO, url: METRO_PATH },
        { name: 'Neighbourhoods', url: '/near' },
      ])],
    },
    body,
    areas: idx.areas,
  });
}

/**
 * /los-angeles — the metro page.
 *
 * THE RULE FOR THE PROSE ON THIS PAGE, because a city page is where every
 * marketplace starts inventing: the only things it may say are general facts
 * about Los Angeles that would be true if this site did not exist, and true
 * statements about how Slotfill works. There is nothing here about how many
 * customers we have, how quickly anybody replies, how much anybody saves, or
 * how well this site is doing. Every number is counted from the openings.
 */
export async function metroPage(env: Env): Promise<string> {
  const base = baseUrlOf(env);
  const idx = await liveIndex(env);
  const url = `${base}${METRO_PATH}`;

  const all = distinctGaps(idx.slots);
  const real = all.filter((s) => !s.is_sample);
  const businesses = new Set(all.map((s) => s.operator_id)).size;
  const ranked = tradesByOpenings(idx.slots);
  const cheapest = cheapestReal(all);
  const withOpenings = idx.areas.filter((a) => a.slot_count > 0);

  const body = `
<p class="crumb"><a href="/">${escapeHtml(SITE_NAME)}</a> › ${escapeHtml(METRO)}</p>
<h1>Mobile services in ${escapeHtml(METRO)}, ${escapeHtml(LAUNCH_STATE)}<span class="count">${
    all.length} open ${plural(all.length, 'appointment', 'appointments')} right now</span></h1>
<p class="lede">Every appointment listed here is an hour a ${escapeHtml(METRO)}
business has free this week — a job that cancelled, or a day that has not
filled. The price is the one the business set. Booking one holds it; nothing is
paid on this site yet, so you settle that price with the business directly.</p>
${statList([
    { n: String(all.length), of: plural(all.length, 'appointment open', 'appointments open') },
    { n: String(businesses), of: plural(businesses, 'business listed', 'businesses listed') },
    { n: String(withOpenings.length),
      of: plural(withOpenings.length, 'neighbourhood', 'neighbourhoods') },
    ...(cheapest ? [{ n: cheapest.price, of: 'lowest price listed' }] : []),
  ])}
${sampleNote(all.length - real.length, all.length)}
<section>
<h2>Top services in ${escapeHtml(METRO)} right now</h2>
${linkList(ranked.slice(0, 12).map((r) => ({
    href: tradePath(r.trade.slug),
    text: r.trade.label,
    sub: `${r.n} open`,
  }))) || `<p class="note">Nothing is open in any trade at the moment. This page
counts what is listed and does not estimate, so on a quiet hour it is a short
page.</p>`}
<p class="note">Ranked by how many appointments each trade has open at this
moment, and by nothing else. It is not a popularity list and it moves through
the day.</p>
</section>
<section>
<h2>Neighbourhoods</h2>
${linkList(idx.areas.map((a) => ({
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
<h2>Why mobile work suits ${escapeHtml(METRO)}</h2>
<p>Los Angeles has a Mediterranean climate: a long dry season from roughly May
to October and most of the year's rain in a handful of winter months. Dust and
pollen settle on cars, windows and solar panels through the dry months, and the
first rains wash them into gutters and drains — which is why so much of the work
listed here is cleaning of one kind or another, and why it clusters seasonally.</p>
<p>Most of the housing in the city is low-rise, with driveways, yards and street
parking rather than loading bays. That is what makes a van practical: the person
doing the work can bring water, power and tools to the address instead of the
address coming to a shop.</p>
<p>None of that is a claim about ${escapeHtml(SITE_NAME)}. What this site does is
narrower and easier to check: a business posts the hours it has free, at the
price it sets, and you book one of them. Openings appear when a job is cancelled
or a gap opens between two booked jobs, so the list on this page is different in
the afternoon from what it was in the morning.</p>
</section>`;

  return seoPage({
    title: `Mobile services in ${METRO}, ${LAUNCH_STATE}`,
    description: all.length
      ? `${all.length} mobile appointments open across ${withOpenings.length} ${METRO} `
        + `${plural(withOpenings.length, 'neighbourhood', 'neighbourhoods')} right now`
        + `${cheapest ? `, from ${cheapest.price}` : ''}. Real times and real prices.`
      : `Mobile trades across ${METRO}, ${LAUNCH_STATE}. Nothing is open at this moment — `
        + `openings appear when a job is cancelled or a gap opens in the day.`,
    canonical: url,
    noindex: false,
    jsonLd: {
      '@context': 'https://schema.org',
      '@graph': [breadcrumbLd(base, [
        { name: SITE_NAME, url: '/' },
        { name: METRO, url: METRO_PATH },
      ])],
    },
    body,
    areas: idx.areas,
  });
}

// ---------------------------------------------------------------------------
// 5. Sitemap
// ---------------------------------------------------------------------------

/**
 * When each neighbourhood's page last changed.
 *
 * The gap rows are what the page is made of, so their updated_at is the real
 * answer; the service area's own timestamp is the fallback for a place that
 * has never had a gap. Stamping every URL with "now" is the common shortcut
 * and search engines discount it, correctly.
 */
async function placeLastmod(env: Env): Promise<Map<string, number>> {
  const rows = await env.DB.prepare(
    `SELECT a.place_slug AS place_slug,
            MAX(a.updated_at) AS area_updated,
            MAX(COALESCE(g.updated_at, 0)) AS gap_updated
       FROM service_areas a
       LEFT JOIN gaps g ON g.operator_id = a.operator_id
      WHERE a.is_active = 1 AND a.place_slug IS NOT NULL AND a.place_slug <> ''
      GROUP BY a.place_slug`,
  ).all<{ place_slug: string; area_updated: number | null; gap_updated: number | null }>();

  const out = new Map<string, number>();
  for (const r of rows.results ?? []) {
    out.set(r.place_slug, Math.max(r.area_updated ?? 0, r.gap_updated ?? 0));
  }
  return out;
}

/**
 * When each trade's own pages last changed.
 *
 * Same reasoning as placeLastmod: /s/<trade> and /cost/<trade> are made of the
 * gap and service rows belonging to the businesses in that trade, so the
 * newest of those timestamps is when the page last said something different.
 * The operator row is the fallback for a trade somebody has signed up in and
 * not yet posted an opening for.
 */
async function tradeLastmod(env: Env): Promise<Map<string, number>> {
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

  const out = new Map<string, number>();
  for (const r of rows.results ?? []) {
    out.set(r.trade.trim().toLowerCase(), Math.max(r.op_updated ?? 0, r.gap_updated ?? 0));
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
 *   /los-angeles, /near    always: both are true and useful on the quietest
 *                          hour, and they are what makes everything else
 *                          reachable in two hops
 *   /browse, /cost         always, and for the same reason: both are built
 *                          from the catalogue rather than from today's
 *                          openings, so both say something true on an empty
 *                          afternoon, and they are the two hubs every trade
 *                          page and cost guide links up to
 *   /near/<place>          every covered neighbourhood, quiet or not
 *   /near/<place>/<trade>  only with a genuine opening in that square
 *   /s/<trade>             only with a genuine opening somewhere in the city
 *   /cost/<trade>          the same test: no listings, no prices, no page
 *                          worth crawling
 *   /browse/<category>     only where one of its trades passed that test, so a
 *                          category page is never submitted as a list of
 *                          fourteen dead ends
 *   /p/<business>          every published profile
 *
 * lastmod is the newest row the page is built from in every case — the gap,
 * the service area, the operator record. Stamping every URL with "now" is the
 * common shortcut and search engines discount it, correctly.
 */
export async function sitemapXml(env: Env, baseUrl: string): Promise<string> {
  const base = trimSlash(baseUrl);
  const idx = await liveIndex(env);
  const [stamps, tradeStamps, profiles] = await Promise.all([
    placeLastmod(env), tradeLastmod(env), profileLastmod(env),
  ]);
  const t = now();

  type Url = { loc: string; lastmod: number; priority: string; changefreq: string };
  const urls: Url[] = [{ loc: `${base}/`, lastmod: t, priority: '1.0', changefreq: 'hourly' }];

  // The freshest thing anywhere on the site, for the two pages that are made
  // of everything. Falls back to now only when there is no row at all.
  const newest = Math.max(0, ...stamps.values(), ...tradeStamps.values()) || t;

  urls.push({ loc: `${base}${METRO_PATH}`, lastmod: newest, priority: '0.9', changefreq: 'hourly' });
  urls.push({ loc: `${base}/near`, lastmod: newest, priority: '0.7', changefreq: 'hourly' });

  // The two catalogue hubs. They enumerate every trade page and every cost
  // guide, including the quiet ones the loops below deliberately leave out, so
  // they are the crawl path to a trade that has nothing open this hour.
  urls.push({ loc: `${base}/browse`, lastmod: newest, priority: '0.7', changefreq: 'daily' });
  urls.push({ loc: `${base}/cost`, lastmod: newest, priority: '0.7', changefreq: 'daily' });

  for (const area of idx.areas) {
    const stamp = stamps.get(area.slug) ?? t;
    urls.push({
      loc: `${base}/near/${area.slug}`, lastmod: stamp, priority: '0.8', changefreq: 'hourly',
    });

    const mine = idx.slots.filter((s) => s.area_slug === area.slug && !s.is_sample);
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
    idx.slots.filter((s) => !s.is_sample)
      .map((s) => (s.trade ?? '').trim().toLowerCase())
      .filter((slug) => slug && tradeBySlug(slug) !== null),
  );

  for (const entry of ALL_TRADES) {
    if (!liveTrades.has(entry.slug)) continue;
    const stamp = tradeStamps.get(entry.slug) ?? t;
    const seg = canonicalTradeSegment(entry);
    urls.push({
      loc: `${base}/s/${seg}`, lastmod: stamp, priority: '0.9', changefreq: 'hourly',
    });
    urls.push({
      loc: `${base}/cost/${seg}`, lastmod: stamp, priority: '0.8', changefreq: 'daily',
    });
  }

  for (const c of TRADE_CATEGORIES) {
    const live = c.trades.filter((t2) => liveTrades.has(t2.slug));
    if (!live.length) continue;
    const stamp = Math.max(...live.map((t2) => tradeStamps.get(t2.slug) ?? 0)) || t;
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
    <lastmod>${isoAt(u.lastmod)}</lastmod>
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
 *
 * Disallow is not a security control — those tokens are secret because they
 * are unguessable, not because of this file.
 */
export function robotsTxt(baseUrl: string): string {
  const base = trimSlash(baseUrl);
  return `User-agent: *
Allow: /
Allow: /near/
Allow: /los-angeles
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
Disallow: /demo
Disallow: /signin
Disallow: /auth/

Sitemap: ${base}/sitemap.xml
`;
}
