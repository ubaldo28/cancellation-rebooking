import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type TradeCategory } from '../api';
import { ErrorNote, Spinner } from '../components/ui';
import Crumbs from '../components/Crumbs';
import PublicPage from '../components/PublicPage';
import '../styles-category.css';
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
 *  1. No artwork on these rows. The tiles on the landing page are pictures
 *     because a picture says "marketplace"; this page is a list of names
 *     somebody is reading top to bottom, and thirteen illustrations beside
 *     thirteen words slow that reading down. Restraint is the whole point of
 *     the redesign.
 *  2. The other categories go at the bottom, as names only. Somebody who
 *     pressed the wrong tile needs one tap back to the right one, but
 *     reprinting the entire catalogue underneath would rebuild the mess this
 *     page exists to replace.
 *
 * It lists the whole catalogue, for the reason set out over `cats` in
 * Discover: a service is on this page because Slotfill covers that job, not
 * because somebody happens to have an hour free in it this afternoon. What is
 * open is a second, smaller fact, and it is printed beside a row only when
 * this page has counted it.
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
  const here = (cats ?? []).find((c) => c.key === category) ?? null;
  /**
   * `cats` is null until the catalogue answers, and a category that is missing
   * is not the same thing as one we have not looked up yet — titling the tab
   * "No such category" for the second of those calls the page broken while it
   * is still loading. Null keeps the site's own title until there is an answer.
   */
  useDocumentTitle(cats === null ? null : here ? here.label : 'No such category');

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
   */
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await api.publicMap();
        const n = new Map<string, number>();
        for (const s of res.slots) if (s.trade) n.set(s.trade, (n.get(s.trade) ?? 0) + 1);
        if (live) setOpen(n);
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

  return (
    <PublicPage className="cat-page">
      {/* The hand-rolled trail this replaced emitted no structured data, so
          a search result for this page was a bare URL. Crumbs prepends
          Slotfill itself. */}
      <Crumbs items={here ? [{ label: here.label }] : []} />

      {/*
        The catalogue holds every category Slotfill has ever defined, so a key
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
            mistyped or renamed. Every category Slotfill covers is on the
            front page.
          </p>
          <Link className="btn" to="/">Browse every category</Link>
        </section>
      ) : (
        <>
          <header className="cat-head">
            <h1>{here.label}</h1>
            <p className="cat-head-p">Pick the job you need doing.</p>
          </header>

          {/*
            Whole-row links, not a label with a link inside it. On a phone the
            thumb lands anywhere in the row and the row is the target, which
            is why the height floor lives on the anchor itself.
          */}
          <ul className="cat-list">
            {here.trades.map((t) => {
              const n = open ? (open.get(t.slug) ?? 0) : null;
              return (
                <li key={t.slug}>
                  {/*
                    Straight to the trade's own page, not back to the front
                    page with a filter on it. That was the shape before the
                    trade pages existed and it undid the whole point of the
                    split: pressing a service sent you back to the screen you
                    had just left, scrolled somewhere else. Three levels now,
                    each of which is a page somebody can link to.
                  */}
                  <Link className="cat-row" to={`/s/${encodeURIComponent(t.slug)}`}>
                    <span className="cat-row-text">
                      <span className="cat-row-name">{t.label}</span>
                      {t.hint && <span className="cat-row-hint">{t.hint}</span>}
                      {/*
                        A trade with nothing free says so in words. A bare
                        nought sitting where a number usually means "open
                        now" reads as a broken count rather than as an empty
                        week, and the row is worth pressing either way: the
                        trade page names who does this work and takes an
                        alert for when an hour opens up.
                      */}
                      {n !== null && (
                        <span className="cat-row-hint">
                          {n > 0
                            ? `${n} ${n === 1 ? 'appointment' : 'appointments'} open now`
                            : 'None open right now'}
                        </span>
                      )}
                    </span>
                    <span className="cat-row-go" aria-hidden="true">›</span>
                  </Link>
                </li>
              );
            })}
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

            Slotfill can now be read two ways — by the job, which is this
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
          {/* A plain anchor: /near is the Worker's page, not this app's, and
              routing to it client-side would render a different one. */}
          <p className="cat-geo">
            <a href="/near">Browse by neighbourhood instead</a>
          </p>

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
