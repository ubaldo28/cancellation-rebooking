import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, sentence, type MapArea, type Trade, type TradeCategory } from '../api';
import '../styles-shell.css';

/**
 * A link in one of the four columns.
 *
 * `to` is deliberately optional and deliberately not defaulted to '#'. Half
 * the destinations the reference marketplace carries in its footer do not
 * exist here yet, and the two wrong ways to handle that are both tempting:
 * link them at a route that 404s, or link them at '/' so every one of them
 * quietly lies about where it goes. A label with no page is rendered as
 * text — visible, honest, and obvious to whoever builds the page later.
 */
interface FootLink { label: string; to?: string; }

/**
 * WHICH FOOTER DESTINATIONS ARE REAL, AND WHICH ARE STUBS.
 *
 * Most of what this footer used to render as grey text now has a page behind
 * it, so most of it is a link. Real routes: '/', '/a', '/join', '/signin',
 * '/browse', '/cost', '/covered', '/safety', '/pros', '/about', '/help',
 * '/terms', '/privacy'.
 *
 * Still stubs, rendered as plain text until somebody writes the page: Get an
 * estimate, Pricing, Careers, Press, Blog, Contact. Every one of those is a
 * marketing gap rather than a legal one, and a label with no page reads
 * better than a link that 404s.
 *
 * "How it works" points at '/' because the front page's explainer bands are
 * the explanation that exists; there is no separate page for it.
 *
 * Terms and Privacy are deliberately NOT in these columns any more. They are
 * in the legal line under them, which is where the reference marketplace puts
 * them and where anybody looking for them will look first; carrying them in
 * both places made the Support column half legal boilerplate.
 *
 * There is no copy in this file making a claim about the company. Nobody has
 * told us when Slotfill was founded, how many people work on it or who has
 * written about it, so the footer says none of those things.
 */
const COLUMNS: Array<{ heading: string; links: FootLink[] }> = [
  {
    heading: 'For customers',
    links: [
      { label: 'Browse services', to: '/browse' },
      { label: 'Get an estimate' },
      { label: 'How it works', to: '/' },
      { label: 'Cost guides', to: '/cost' },
      { label: 'What is covered', to: '/covered' },
      { label: 'Alert me', to: '/a' },
    ],
  },
  {
    heading: 'For businesses',
    links: [
      { label: 'List your business', to: '/join' },
      { label: 'Sign in', to: '/signin' },
      { label: 'How Slotfill works for pros', to: '/pros' },
      { label: 'Pricing' },
    ],
  },
  {
    heading: 'Company',
    links: [
      { label: 'About', to: '/about' },
      { label: 'Careers' },
      { label: 'Press' },
      { label: 'Blog' },
    ],
  },
  {
    heading: 'Support',
    links: [
      { label: 'Help centre', to: '/help' },
      { label: 'Contact' },
      { label: 'Safety', to: '/safety' },
    ],
  },
];

export interface SiteFooterProps {
  /**
   * Trade slug and how many appointments are open in it. Only the front page
   * has counted these, because only the front page has the whole slot list in
   * hand; every other page omits the prop and gets the uncounted directory
   * built below instead.
   */
  trades?: Array<[string, number]>;
  /**
   * Neighbourhoods, in the order the server returned them (nearest first).
   *
   * An override rather than a requirement: the front page has already loaded
   * the map and knows which neighbourhoods are near this particular visitor,
   * so it hands them over and this component does not fetch them a second
   * time. Every other page omits the prop and gets the fetch below.
   */
  areas?: Array<{ slug: string; name: string; slot_count: number }>;
}

/**
 * The foot of every page.
 *
 * Four columns of plain links, the browse directory underneath, and the two
 * attribution lines at the very bottom. It is deliberately dull. Nobody reads
 * a footer for pleasure — they arrive at one having failed to find something
 * above it — so the only two virtues that count are completeness and
 * scannability, and every ornament costs both.
 *
 * The category catalogue is fetched here rather than passed in, so a page
 * gets the directory by rendering one tag. That is one extra request per page
 * load, and it is a request the Worker answers from cache; the alternative is
 * every page in the app growing a fetch and a piece of state whose only
 * purpose is to feed its own footer.
 *
 * The trade counts come in as a prop for a different reason: they are the
 * front page's own counts, taken against the neighbourhood and trade that
 * visitor is looking at, and nothing this component fetched could reproduce
 * them. Without the prop the services column falls back to the catalogue it
 * already has and prints names with no figures, because a count this
 * component was not given is a number it would have to invent.
 *
 * The neighbourhoods used to be prop-only, and the result was that the front
 * page had a three-column directory and every other page on the site had a
 * two-column one — the whole geography of the product missing from the foot
 * of every trade page, category page and profile, which are exactly the pages
 * a stranger arrives on from a search engine. So this fetches them too when
 * it is not given them. It costs one more request on those pages, and it is
 * the same `/api/public/map` the trade and search pages already ask for — the
 * Worker sends it with `max-age=60`, so on a page that fetched it a moment
 * ago the browser answers this one out of its own cache. The front page still
 * passes the prop and so still makes exactly one.
 */
export default function SiteFooter({ trades, areas }: SiteFooterProps) {
  const [cats, setCats] = useState<TradeCategory[]>([]);
  const [ownAreas, setOwnAreas] = useState<MapArea[]>([]);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        // The whole catalogue, for the reason set out over `cats` in
        // Discover. A footer directory that hid the categories nobody had
        // signed up in yet was the one place on the site guaranteed to be
        // crawled, quietly telling a search engine we cover half of what we do.
        const res = await api.tradeCatalog();
        // The component can unmount during a route change while this is in
        // flight; setting state afterwards is a warning and a leak.
        if (live) setCats(res.categories);
      } catch {
        // A footer is not worth an error message. The four link columns and
        // the attribution below are unaffected, so the page loses one list
        // and nobody is told about a request they did not make.
      }
    })();
    return () => { live = false; };
  }, []);

  /**
   * The neighbourhoods, for every page that did not hand any over.
   *
   * Guarded on the prop rather than fetched unconditionally and then thrown
   * away: the front page passes its own, and firing this there would be a
   * second copy of the heaviest public request on the site for rows it is
   * already holding.
   */
  const givenAreas = areas !== undefined;
  useEffect(() => {
    if (givenAreas) return;
    let live = true;
    void (async () => {
      try {
        const res = await api.publicMap();
        if (live) setOwnAreas(res.areas);
      } catch {
        // Same as the catalogue above: the column omits itself and nobody is
        // told about a request they did not make.
      }
    })();
    return () => { live = false; };
  }, [givenAreas]);

  const shownAreas = areas ?? ownAreas;

  /**
   * The services column for every page that did not count any: names out of
   * the catalogue, taken a trade at a time from each category in turn so the
   * fourteen on show are spread across the site rather than all coming from
   * whichever category is listed first. Each one goes to its own trade page,
   * which does its own counting and says plainly when it has nothing.
   */
  const someTrades = useMemo(() => {
    const rows: Trade[] = [];
    for (let i = 0; rows.length < 14; i += 1) {
      const round = cats.map((c) => c.trades[i]).filter((t): t is Trade => Boolean(t));
      if (round.length === 0) break;
      rows.push(...round);
    }
    return rows.slice(0, 14);
  }, [cats]);

  return (
    <footer className="site-foot">
      <div className="wrap-wide">
        <div className="site-foot-cols">
          {COLUMNS.map((col) => (
            <nav className="foot-col" key={col.heading} aria-label={col.heading}>
              <h2>{col.heading}</h2>
              <ul>
                {col.links.map((l) => (
                  <li key={l.label}>
                    {l.to
                      ? <Link to={l.to}>{l.label}</Link>
                      : <span className="foot-soon">{l.label}</span>}
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        {/*
          THE DIRECTORY.
          Three columns of plain links, which is what the reference
          marketplace puts at the foot of every page. It does two jobs at
          once: a visitor who did not find their thing in the tiles above can
          find it here by name, and a search engine cannot crawl a page that
          nothing links to. Plain <a> for the /near pages because those are
          server-rendered by the Worker and are not React routes; <Link> for
          everything inside the app.
        */}
        <div className="foot-dir">
          {cats.length > 0 && (
            <nav className="foot-col" aria-label="Services by category">
              <h2>Browse by category</h2>
              <ul>
                {cats.map((c) => (
                  <li key={c.key}><Link to={`/browse/${c.key}`}>{c.label}</Link></li>
                ))}
              </ul>
            </nav>
          )}

          {/*
            The front page has counted what is open near the visitor and hands
            it over, so there the column is what is busy and says how busy.
            Everywhere else it is the plain directory below, because three
            headings with nothing under them is not a footer anybody can use.
          */}
          {trades && trades.length > 0 ? (
            <nav className="foot-col" aria-label="Popular services">
              <h2>Popular services near you</h2>
              <ul>
                {trades.slice(0, 14).map(([slug, n]) => (
                  <li key={slug}>
                    {/*
                      reloadDocument, which is not the usual choice and is not
                      free. Discover seeds its trade filter from ?trade= once,
                      in a useState initialiser, so a client-side navigation
                      from the front page back to the front page changes the
                      URL and nothing else — and the front page is exactly
                      where this column appears most. A footer link that
                      silently does nothing on the one page it is most often
                      pressed is worse than paying for a reload.
                    */}
                    <Link reloadDocument to={`/?trade=${encodeURIComponent(slug)}`}>
                      {sentence(slug)}
                      <span className="foot-n">{n}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ) : someTrades.length > 0 && (
            <nav className="foot-col" aria-label="Services">
              <h2>Browse by service</h2>
              <ul>
                {someTrades.map((t) => (
                  <li key={t.slug}>
                    <Link to={`/s/${encodeURIComponent(t.slug)}`}>{t.label}</Link>
                  </li>
                ))}
              </ul>
            </nav>
          )}

          {shownAreas.length > 0 && (
            <nav className="foot-col" aria-label="Areas">
              <h2>Open near you</h2>
              <ul>
                {shownAreas.map((a) => (
                  <li key={a.slug}>
                    <a href={`/near/${a.slug}`}>
                      {a.name}
                      {a.slot_count > 0 && <span className="foot-n">{a.slot_count}</span>}
                    </a>
                  </li>
                ))}
                {/*
                  The two pages above the individual neighbourhoods, at the
                  foot of the list rather than the head of it: somebody
                  scanning this column is looking for their own area first,
                  and the city-wide pages are where they go when it is not
                  here. Plain <a> like the rest of the column, so the visitor
                  gets the Worker's server-rendered /near and /los-angeles.
                  Both are React routes too — App.tsx has to match them so
                  React can mount over that HTML rather than replace it — but
                  a client-side <Link> would skip the render and rebuild the
                  page from the API for no gain.
                */}
                <li><a href="/near">Every neighbourhood</a></li>
                <li><a href="/los-angeles">Slotfill in Los Angeles</a></li>
              </ul>
            </nav>
          )}
        </div>

        {/*
          Verbatim, and not to be reworded: the first line is a condition of
          the OpenStreetMap and GeoNames licences the map is built on, and the
          second is the promise the whole product rests on.
        */}
        <div className="site-foot-legal">
          <p>
            Map data © OpenStreetMap contributors, tiles by OpenFreeMap.
            Postcode centroids from GeoNames, CC BY 4.0.
          </p>
          <p>Prices are set by the business doing the work.</p>

          {/*
            THE LEGAL LINE, which the reference marketplace carries under its
            columns and this footer did not have at all.

            The year comes from the clock rather than being typed in, because
            a copyright line that says the wrong year is the one piece of
            small print everybody notices.

            "Notice at Collection" is the California link that has to be
            reachable from the foot of every page, and it points at the
            privacy page because that is where the notice is.

            THERE IS DELIBERATELY NO "DO NOT SELL OR SHARE MY PERSONAL
            INFORMATION" LINK, and it is not an oversight. That link is an
            opt-out of selling or sharing personal information, and Slotfill
            does neither — so the link would either lead to a page describing
            a choice that does not exist, or lead nowhere and imply a trade in
            data that is not happening. Adding it to look thorough would make
            the footer say something untrue about what the site does with
            people's data, which is the one subject where that is least
            forgivable. If selling or sharing ever starts, this is where the
            link goes and it stops being a lie on the same day.
          */}
          <p className="site-foot-fine">
            <span>© {new Date().getFullYear()} Slotfill</span>
            <Link to="/terms">Terms of service</Link>
            <Link to="/privacy">Privacy policy</Link>
            <Link to="/privacy">Notice at Collection</Link>
          </p>
        </div>
      </div>
    </footer>
  );
}
