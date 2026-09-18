import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { api, sentence, type MapArea, type Trade, type TradeCategory } from '../api';
import { groupByMetro, useMetros } from '../lib/metros';
import '../styles-shell.css';

/** A link in one of the columns. */
interface FootLink { label: string; to?: string; }

/**
 * THE FOOTER, REBUILT TO THE SHAPE OF THE REFERENCE MARKETPLACE.
 *
 * Measured off theirs at 1440px: a flex row of four columns — the mark and a
 * one-line promise in the first, then Customers, Pros and Support — thirty-odd
 * links in total, and NO directory of services or places. Terms, Privacy and
 * the California notice sit at the foot of Support, not in a line of their
 * own. The line under the row is the copyright and one link.
 *
 * What this replaced: four columns, six labels with no page behind them
 * rendered as grey text, and three further columns listing every category,
 * eight trades and a dozen neighbourhoods — sixty-odd links, most of them
 * unreadable, at the foot of every page.
 *
 * EVERY LABEL HERE GOES SOMEWHERE. A destination with no page is left out
 * rather than printed as text; test/seo-pages.test.ts fails if one comes
 * back. Nothing became unreachable when the directory went: /browse lists
 * every category and trade, /near lists every neighbourhood, and both are in
 * the Customers column, so a deep page is two hops from here.
 *
 * "How it works" points at '/' because the front page's explainer bands are
 * the explanation that exists; there is no separate page for it.
 *
 * No copy here makes a claim about the company. Nobody has said when
 * Round The Way was founded or who works on it, so the footer says neither.
 */
const COLUMNS: Array<{ heading: string; links: FootLink[] }> = [
  {
    heading: 'Customers',
    links: [
      { label: 'How it works', to: '/' },
      { label: 'Browse services', to: '/browse' },
      { label: 'Cost guides', to: '/cost' },
      { label: 'Your bookings', to: '/account' },
      { label: 'Services near you', to: '/near' },
      { label: 'What is covered', to: '/covered' },
      { label: 'Alert me', to: '/a' },
    ],
  },
  {
    heading: 'Pros',
    links: [
      { label: 'How Round The Way works for pros', to: '/pros' },
      { label: 'List your business', to: '/join' },
      { label: 'Sign in', to: '/signin' },
    ],
  },
  {
    heading: 'Support',
    links: [
      { label: 'Help centre', to: '/help' },
      { label: 'Safety', to: '/safety' },
      { label: 'Terms of service', to: '/terms' },
      { label: 'Privacy policy', to: '/privacy' },
      { label: 'Notice at Collection', to: '/privacy' },
    ],
  },
];

/**
 * The underline on the two licence links in the attribution line, written
 * here rather than left to a stylesheet.
 *
 * styles.css turns the underline off on every anchor on the site, and the
 * comment over its own `.muted a` rule already worked out why that is a
 * problem in a block like this one: --accent-ink on --muted is 1.19:1, so a
 * link sitting in this sentence would be told apart from the words around it
 * by colour alone, which at that contrast is not being told apart at all.
 * These are the two links a licence asks for by name, so they are the last
 * ones on the page that may be invisible.
 */
const ATTRIB_LINK: CSSProperties = { textDecoration: 'underline', textUnderlineOffset: 2 };

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
   *
   * `metro` is on the row because the column is grouped by it: a flat run of
   * names puts Orcutt under Encino and says nothing about the hundred and
   * fifty miles between them.
   */
  areas?: Array<{ slug: string; name: string; slot_count: number; metro: string }>;
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
   * The neighbourhoods, split into the places they are in.
   *
   * The metro records come from the hook rather than from this component's
   * own fetch, so several footers on one visit share one request. A visit
   * where that request failed falls back to one ungrouped run of names, which
   * is what this column was before there were two places to tell apart — a
   * worse footer, not a broken one.
   */
  const metros = useMetros();
  const areaGroups = useMemo(
    () => groupByMetro(metros, shownAreas, (a) => a.metro, 'nearest'),
    [metros, shownAreas],
  );

  /**
   * The services column for every page that did not count any: names out of
   * the catalogue, taken a trade at a time from each category in turn so the
   * fourteen on show are spread across the site rather than all coming from
   * whichever category is listed first. Each one goes to its own trade page,
   * which does its own counting and says plainly when it has nothing.
   */
  const someTrades = useMemo(() => {
    const rows: Trade[] = [];
    for (let i = 0; rows.length < 8; i += 1) {
      const round = cats.map((c) => c.trades[i]).filter((t): t is Trade => Boolean(t));
      if (round.length === 0) break;
      rows.push(...round);
    }
    return rows.slice(0, 8);
  }, [cats]);

  return (
    <footer className="site-foot">
      <div className="wrap-wide">
        <div className="site-foot-cols">
          {/* The first COLUMN, not a banner above the row: the reference
              marketplace opens its footer with the mark and a one-line
              promise in the leftmost column, with the link columns beside
              it. */}
          <div className="foot-brand">
            <span className="foot-mark">Round The Way</span>
            <p>Book someone round the way.</p>
            <ul><li><Link to="/about">About</Link></li></ul>
          </div>
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
          THE DIRECTORY IS GONE, AND ON PURPOSE.

          It was three more columns under the four above — every category,
          eight trades and a dozen neighbourhoods — forty-odd links whose job
          was to give a crawler a path to the server-rendered pages. It did
          that, and it also made the foot of every page a wall nobody could
          read past.

          Nothing became unreachable. /browse lists every category and every
          trade under it, /near lists every neighbourhood in every metro, and
          both are links in the columns above, so each deep page is two hops
          from anywhere rather than one. The hubs carry the linking now, which
          is what hubs are for.
        */}

        {/*
          Verbatim, and not to be reworded: the first line is a condition of
          the OpenStreetMap and GeoNames licences the map is built on, the
          second says who owns the names the vehicle picker prints, and the
          third is the promise the whole product rests on.

          seo.ts draws the same three lines for the server-rendered pages, in
          the same order and the same words. They are written out twice
          because the two trees cannot import each other; change one and
          change the other in the same commit.

          THE TWO LINKS ARE PART OF THE CREDIT RATHER THAN DECORATION ON IT,
          and for a while they were missing. The OpenStreetMap Foundation asks
          that the credit point at openstreetmap.org/copyright wherever the
          medium allows a link, and CC BY 4.0 asks the same of the licence
          itself — both of them only so far as it is reasonably practicable,
          which on an HTML page is entirely. What was here before said the
          right words and led nowhere, which is a credit naming a licence the
          reader has no way to go and read.

          THE TRADEMARK LINE IS A NOTICE AND NOT A DISCLAIMER. The vehicle
          picker prints Transit, Sprinter and ProMaster because those are what
          a van is called, and naming somebody's product to say which product
          you mean is the ordinary, permitted use of their mark. Nothing here
          is in any doubt. What was missing was the plain acknowledgement that
          the names belong to the companies that own them, so it is one
          sentence in the same small type as the rest of this block. Anything
          longer would read as a claim that there is something to answer for.
        */}
        <div className="site-foot-legal">
          <p>
            Map data ©{' '}
            <a
              href="https://www.openstreetmap.org/copyright"
              target="_blank" rel="noreferrer" style={ATTRIB_LINK}
            >OpenStreetMap</a>{' '}
            contributors, tiles by OpenFreeMap. Postcode centroids from
            GeoNames,{' '}
            <a
              href="https://creativecommons.org/licenses/by/4.0/"
              target="_blank" rel="noreferrer" style={ATTRIB_LINK}
            >CC BY 4.0</a>.
          </p>
          <p>
            Vehicle makes and models named on this site are the trademarks of
            their respective owners, and are used here only to describe
            vehicles.
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
            opt-out of selling or sharing personal information, and Round The Way
            does neither — so the link would either lead to a page describing
            a choice that does not exist, or lead nowhere and imply a trade in
            data that is not happening. Adding it to look thorough would make
            the footer say something untrue about what the site does with
            people's data, which is the one subject where that is least
            forgivable. If selling or sharing ever starts, this is where the
            link goes and it stops being a lie on the same day.
          */}
          {/* The three legal links moved UP into the Support column, which is
              where the reference marketplace keeps Terms of Use, Privacy
              Policy and CA Notice at Collection. What is left here is the
              copyright, which is all its own bottom line carries. */}
          <p className="site-foot-fine">
            <span>© {new Date().getFullYear()} Round The Way</span>
            <Link to="/covered">What is covered</Link>
          </p>
        </div>
      </div>
    </footer>
  );
}
