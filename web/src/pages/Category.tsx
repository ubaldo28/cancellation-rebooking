import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type MapArea, type TradeCategory } from '../api';
import { ErrorNote, Spinner } from '../components/ui';
import Crumbs from '../components/Crumbs';
import MetroLinks from '../components/MetroLinks';
import PublicPage from '../components/PublicPage';
import { CategoryArtImg, TradeArt } from '../components/TileArt';
import '../styles-category.css';
import { plural } from '../lib/format';
import { useNoIndex } from '../lib/noindex';
import { tradeHref } from '../lib/seo';
import { distinctGaps } from '../lib/slots';
import { useDocumentTitle } from '../lib/title';

/**
 * One category, and the services inside it.
 *
 * This is the middle level of the reference marketplace's two-step browse:
 * you press a category, you land here on a plain list of that category's
 * services, you press a service and you get listings. The landing page used
 * to try to be all three levels at once — every trade on one screen inside
 * expanding accordions — and it read as a database dump. Splitting it costs
 * one extra tap and buys a page somebody can actually scan.
 *
 * Two arguments settled here by looking at the reference:
 *
 *  1. ARTWORK ON THESE ROWS AFTER ALL — and this note used to say the
 *     opposite, so it is worth saying why it turned over rather than quietly
 *     editing it out. It read: "No artwork on these rows. The tiles on the
 *     landing page are pictures because a picture says marketplace; this page
 *     is a list of names somebody is reading top to bottom, and thirteen
 *     illustrations beside thirteen words slow that reading down."
 *
 *     The owner asked for a picture on every trade tile, and the front page
 *     carries only the eight categories, so /browse and this page are where
 *     the trades actually are. What makes it work rather than clutter is the
 *     SIZE: a 75px thumbnail at the head of a 56px row, drawn from the same
 *     eight-hue set as the category tiles, so a column of them reads as one
 *     rail of colour down the left edge rather than as thirteen competing
 *     pictures. The old argument was against illustrations the width of the
 *     column, and it still holds against those.
 *  2. The other categories go at the bottom, as names only. Somebody who
 *     pressed the wrong tile needs one tap back to the right one, but
 *     reprinting the entire catalogue underneath would rebuild the mess this
 *     page exists to replace.
 *
 * It lists the whole catalogue, for the reason set out over `cats` in
 * Discover: a service is on this page because Round The Way covers that job, not
 * because somebody happens to have an hour free in it this afternoon. What is
 * open is a second, smaller fact, and it is printed beside a row only when
 * this page has counted it.
 *
 * WHAT THIS PAGE DELIBERATELY DOES NOT CARRY. The reference marketplace hangs
 * a "how it works" band and a long FAQ off every level of its browse. Both of
 * those live on the trade page here, one level down, and the two arguments at
 * the top of this file are the reason they are not repeated: this is a 640px
 * column somebody scans for the name of a job, and a three-step band plus
 * seven disclosures underneath it is the wall of everything that the split
 * exists to break up. Every row above leads to a page that answers those
 * questions about the one trade the reader actually came for, which is a
 * better answer than a generic one three inches sooner.
 *
 * WHAT IT NOW CARRIES INSTEAD, and why each is here rather than there:
 *
 *  - The counted line under the heading. src/lib/seo.ts renders the crawler's
 *    copy of this same URL and has always printed an open count in its H1
 *    while this page printed none, so the two halves of one address disagreed
 *    about whether anything was happening in the category.
 *  - The neighbourhoods. Same story: the server's copy has ended with a list
 *    of places since it was written and this page offered a single bare link
 *    to /near. Somebody who knows the job and only wants it near them had one
 *    undifferentiated door out of here.
 *  - One cost link, not thirteen. See the note above it.
 */
export default function Category() {
  const { category } = useParams<{ category: string }>();
  const [cats, setCats] = useState<TradeCategory[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /**
   * Appointments open per trade slug, or null until something has been
   * counted. The two have to stay distinguishable: zero is a fact this page
   * can state, null is a question it has not had an answer to yet, and
   * collapsing them would print "none open" over every row for the moment
   * before the map arrives — and for good, if it never does.
   */
  const [open, setOpen] = useState<Map<string, number> | null>(null);
  /**
   * The neighbourhoods the same fetch returned, for the block at the foot.
   *
   * They arrive on the map payload this page was already asking for, so the
   * list below costs no extra request — it was thrown away here for as long as
   * this page had nowhere to put it.
   */
  const [areas, setAreas] = useState<MapArea[]>([]);
  const here = (cats ?? []).find((c) => c.key === category) ?? null;
  /**
   * `cats` is null until the catalogue answers, and a category that is missing
   * is not the same thing as one we have not looked up yet — titling the tab
   * "No such category" for the second of those calls the page broken while it
   * is still loading. Null keeps the site's own title until there is an answer.
   */
  useDocumentTitle(cats === null ? null : here ? here.label : 'No such category');

  /**
   * A key that is in no category is answered by the Worker with the plain SPA
   * shell and a 200 (`toSpa` in src/index.ts), so "No such category" below is
   * a soft 404 unless something says otherwise. Only once the catalogue has
   * actually answered: while `cats` is null this is a page that has not looked
   * yet, and asking for noindex on the strength of an unfinished request would
   * tar every real category with it for as long as the fetch takes.
   */
  useNoIndex(cats !== null && here === null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setCats((await api.tradeCatalog()).categories); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load the categories.'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /**
   * The counts, fetched apart from the catalogue and allowed to fail quietly.
   * The list of services is the page; how many hours are free in each of them
   * is a line on a row, and it is not worth holding the page back for or
   * failing it over. Counted the same way the front page counts, from the
   * slots actually returned.
   *
   * ONE ROW PER OPENING, NOT ONE PER SLOT. This counted raw rows until now,
   * and the public map deliberately offers a business's whole free day in
   * every neighbourhood that business covers — so a detailer working eight
   * areas had one free Tuesday reported here as eight appointments. The trade
   * page each of these rows links to has always deduplicated on the gap, and
   * so has the Worker's copy of this page, which meant pressing a row could
   * take a reader from "8 appointments open now" to "1 appointment open"
   * without anything having changed. `distinctGaps` is the shared answer.
   */
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await api.publicMap();
        const n = new Map<string, number>();
        for (const s of distinctGaps(res.slots)) {
          const t = (s.trade ?? '').trim().toLowerCase();
          if (t) n.set(t, (n.get(t) ?? 0) + 1);
        }
        if (live) { setOpen(n); setAreas(res.areas); }
      } catch {
        // Every row still lists and still leads somewhere; they simply carry
        // no count, which is the right way to be wrong about a number.
      }
    })();
    return () => { live = false; };
  }, []);

  if (loading) {
    return <PublicPage className="cat-page"><Spinner label="Loading services" /></PublicPage>;
  }
  if (error) {
    return <PublicPage className="cat-page"><ErrorNote error={error} onRetry={load} /></PublicPage>;
  }

  const others = (cats ?? []).filter((c) => c.key !== category);

  /**
   * Every opening in this category, added up from the per-trade counts the
   * rows below are already printing. It is the same arithmetic a reader could
   * do down the page by hand, which is the only kind of total this site prints
   * — and it is nought whenever the map has not answered, which is why the
   * line that shows it is drawn on `open !== null` rather than on this.
   */
  const total = (here?.trades ?? [])
    .reduce((sum, t) => sum + (open?.get(t.slug) ?? 0), 0);

  /**
   * WHERE THE VANS ARE, as the twelve busiest neighbourhoods.
   *
   * The Worker's copy of this page ends with this block and this page ended
   * with a single unlabelled link to /near, so the two halves of one address
   * offered different ways out of it. Same slice the Worker takes, so the two
   * lists lead with the same places.
   *
   * Somewhere with nothing open is dropped rather than listed at nought: the
   * link would land on a neighbourhood page with nothing on it, which is the
   * one thing a block of links at the foot of a page must never do.
   */
  const places = areas
    .filter((a) => a.slot_count > 0)
    .sort((a, b) => b.slot_count - a.slot_count || a.name.localeCompare(b.name))
    .slice(0, 12);

  return (
    <PublicPage className="cat-page">
      {/* The hand-rolled trail this replaced emitted no structured data, so
          a search result for this page was a bare URL. Crumbs prepends
          Round The Way itself.

          THIS IS ALSO THE ONLY STRUCTURED DATA THIS URL HAS ONCE THE BUNDLE
          RUNS, and that is the whole reason it has to stay here. The Worker
          renders /browse/:category too, and the BreadcrumbList it emits sits
          inside #root where React destroys it on mount — see main.tsx. The
          Worker's graph for this page is a BreadcrumbList and nothing else, so
          the trail below is not decoration that happens to carry markup, it is
          the page's replacement for what the server said. */}
      <Crumbs items={here ? [{ label: here.label }] : []} />

      {/*
        The catalogue holds every category Round The Way has ever defined, so a key
        that is not in it is not a quiet category — it is an address that does
        not exist, mistyped or left over from a rename. It is told as that,
        because "nobody is working here today" would send somebody away
        waiting for a category that is never coming back.
      */}
      {!here ? (
        <section className="cat-none">
          <h1>No such category</h1>
          <p className="cat-none-p">
            There is no category at this address. It has probably been
            mistyped or renamed. Every category Round The Way covers is on the
            front page.
          </p>
          <Link className="btn" to="/">Browse every category</Link>
        </section>
      ) : (
        <>
          <header className="cat-head">
            {/*
              THE CATEGORY'S OWN DRAWING, AS A BANNER.

              The same picture the front-page tile for this category shows, at
              the one size it was rendered for. It is here because this is the
              only page on the site that is about exactly one category, so it
              is the only place the category picture can be shown at the size
              it was drawn rather than as a thumbnail — and because a reader
              who pressed a tile on the front page arrives here and sees the
              thing they pressed, which is how a page says "yes, this one".

              Eager, alone among the art on this site: it is the first thing
              under the crumb trail and above the fold on arrival, so lazy
              would mean watching it appear. src/lib/seo.ts renders the same
              banner on the crawler's copy of this URL.
            */}
            <CategoryArtImg className="cat-banner" src={here.art} eager fallback={null} />
            <h1>{here.label}</h1>
            {/*
              THE COUNTED LINE UNDER THE HEADING.

              The reference marketplace opens every level of its browse with a
              counted sentence beside the title, and the crawler's copy of this
              exact URL has carried one since it was written — "13 open
              appointments in this category" — while this page carried nothing.
              A visitor and a search engine were being told different things
              about whether the category had anything in it.

              Null and nought are kept apart here for the same reason they are
              kept apart on the rows: null means the map has not answered yet,
              and printing "nothing open" over a category while its counts are
              still in flight is a claim rather than a fact. The line simply
              does not exist until there is something to put in it.
            */}
            {open !== null && (
              <p className="cat-head-n">
                {total > 0
                  ? `${total} open ${plural(total, 'appointment', 'appointments')} `
                    + 'in this category'
                  : 'Nothing open in this category right now'}
              </p>
            )}
            <p className="cat-head-p">Pick the job you need doing.</p>
          </header>

          {/*
            Whole-card links, not a label with a link inside it. On a phone the
            thumb lands anywhere on the card and the card is the target.

            `cat-cards` is what turns this list into the grid of picture tiles:
            same markup either way, and the class says these rows carry
            pictures and want to be tiles rather than a column. The Worker's
            twin says it with `class="links cards"` in linkList
            (src/lib/seo.ts), on these same rows.
          */}
          <ul className="cat-list cat-cards">
            {here.trades.map((t) => (
                <li key={t.slug}>
                  {/*
                    Straight to the trade's own page, not back to the front
                    page with a filter on it. That was the shape before the
                    trade pages existed and it undid the whole point of the
                    split: pressing a service sent you back to the screen you
                    had just left, scrolled somewhere else. Three levels now,
                    each of which is a page somebody can link to.
                  */}
                  <Link className="cat-row" to={tradeHref(t.slug)}>
                    {/*
                      The trade's drawing, from `t.art` on the catalogue
                      payload — the path the Worker computed, which is the same
                      path categoryPage in src/lib/seo.ts puts on this same row.
                      Decorative, because the name is beside it; see
                      TileArt.tsx for that and for the width, height and lazy
                      loading. Note 1 at the top of this file is what changed.
                    */}
                    <TradeArt className="cat-row-art" src={t.art} />
                    {/*
                      THE NAME, AND NOTHING ELSE ON THE TILE. The hint and the
                      count that used to sit under the picture are gone: a grid
                      of tiles each repeating "None open right now" says the
                      same discouraging thing thirteen times, and the counted
                      line in this page's own heading already says it once and
                      accurately. The name sits on the picture, white over a
                      gradient at the foot of the tile, drawn by the
                      stylesheet.
                    */}
                    <span className="cat-row-text">
                      <span className="cat-row-name">{t.label}</span>
                    </span>
                  </Link>
                </li>
            ))}
          </ul>

          {/* Only reachable if the catalogue itself files no services under
              this heading, which is a gap in the catalogue rather than a
              quiet week. */}
          {here.trades.length === 0 && (
            <p className="cat-none-p">
              No services are listed in this category yet.
            </p>
          )}

          {/*
            THE OTHER AXIS, AS ONE LINK.

            Round The Way can now be read two ways — by the job, which is this
            page, and by where the van is, which is /near. Somebody who
            already knows the job and only wants it near them has had no way
            across from here, and every trade row above leads to a page that
            offers the neighbourhoods for that one trade.

            So exactly one link, and deliberately not a matrix. Printing this
            category's thirteen services against eighteen neighbourhoods
            would put two hundred rows on the page and rebuild the wall of
            everything the two-level split exists to break up — and most of
            those rows would lead somewhere with nothing open in it. The
            neighbourhood-by-trade links are made where the counts to justify
            them exist, which is the trade page.
          */}
          {/*
            THE COST BAND, AS ONE LINK RATHER THAN THIRTEEN.

            The reference marketplace puts a price module on every browse page,
            and the obvious version of it here would be a second column of this
            category's services with "What X costs" in front of each name — the
            same thirteen labels the reader has just finished scanning, doubling
            the page to add one word to each. So it is one tile into the cost
            index instead, and the per-trade guide is offered from the trade
            page, where the page is already about that one trade and the count
            of listed prices can be printed beside the link.

            No figure on it. This page has counted openings, not prices, and a
            number here would either be the wrong one or an invented one.
          */}
          <Link className="cat-cross" to="/cost">
            <span className="cat-cross-t">
              <b>What these jobs cost</b>
              <span>
                Every price listed on Round The Way right now, by trade — the
                lowest, the highest and the middle, counted from the businesses
                themselves rather than quoted from a survey.
              </span>
            </span>
            <span className="cat-cross-go" aria-hidden="true">›</span>
          </Link>

          {/*
            THE OTHER AXIS, NOW AS PLACES RATHER THAN AS ONE WORD.

            This was a single link reading "Browse by neighbourhood instead",
            which asks somebody to press it and find out. Naming the twelve
            busiest neighbourhoods with what each has open says what is behind
            the door before they open it, and it is the block the Worker's copy
            of this URL has always ended with.

            Still deliberately not a matrix. Printing this category's thirteen
            services against eighteen neighbourhoods would put two hundred rows
            on the page and rebuild the wall of everything the two-level split
            exists to break up, and most of those rows would lead somewhere with
            nothing open in it. The neighbourhood-by-trade links are made where
            the counts to justify them exist, which is the trade page.

            Plain anchors: everything under /near is the Worker's page, not this
            app's, and routing to one client-side lands on the SPA's catch-all.
          */}
          <section className="cat-geo-sec" aria-labelledby="cat-geo">
            <h2 id="cat-geo">By neighbourhood</h2>
            {places.length > 0 ? (
              <>
                <p className="cat-geo-sub">
                  The {places.length === 1 ? 'neighbourhood' : `${places.length} neighbourhoods`}
                  {' '}with the most open right now, across every trade rather
                  than only this category.
                </p>
                <ul className="cat-geo-list">
                  {places.map((a) => (
                    <li key={a.slug}>
                      <a href={`/near/${encodeURIComponent(a.slug)}`}>
                        <span className="cat-geo-name">{a.name}</span>
                        <span className="cat-geo-n">
                          {a.slot_count}{' '}
                          {plural(a.slot_count, 'appointment', 'appointments')}
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              /* No counted line at all when nothing is open anywhere, because
                 the honest sentence is short and a heading over an empty list
                 is worse than a heading over a sentence saying so. */
              <p className="cat-geo-sub">
                Nothing is open in any neighbourhood at the moment. The index
                below lists every one Round The Way covers, and each takes an
                alert for when an hour appears in it.
              </p>
            )}
            <p className="cat-geo-foot">
              <a href="/near">Every neighbourhood Round The Way covers</a><MetroLinks />
            </p>
          </section>

          {others.length > 0 && (
            <section className="cat-else">
              <h2>Looking for something else?</h2>
              <ul className="cat-else-list">
                {others.map((c) => (
                  <li key={c.key}>
                    <Link to={`/browse/${c.key}`}>{c.label}</Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </PublicPage>
  );
}
