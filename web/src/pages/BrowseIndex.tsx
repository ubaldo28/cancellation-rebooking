import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type TradeCategory } from '../api';
import Crumbs from '../components/Crumbs';
import PublicPage from '../components/PublicPage';
import { ErrorNote, Spinner } from '../components/ui';
import '../styles-index.css';
import { useDocumentTitle } from '../lib/title';

/**
 * The whole catalogue: every category and every service under it. Route
 * /browse.
 *
 * This is the level the reference marketplace calls "Explore", and it was the
 * one level of the browse this site did not have. The header's "Browse" and
 * the footer's "Browse services" both point here, and until this page existed
 * they pointed at an address the router answered by redirecting to the front
 * page — which is the front page pretending to be a directory.
 *
 * THE FULL CATALOGUE, NOT THE PART OF IT SOMEBODY HAPPENS TO BE WORKING IN
 * TODAY. Same rule and same reason as `cats` in Discover: the trimmed
 * catalogue hides a category the moment nobody has signed up in it, which is
 * exactly when a marketplace most needs to look like it covers the work. A
 * service is on this page because Slotfill covers that job. What is open in it
 * is a second, smaller fact, printed beside the row only once this page has
 * counted it, and stated in words when the answer is nothing.
 */

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export default function BrowseIndex() {
  const [cats, setCats] = useState<TradeCategory[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Appointments open per trade slug, or null until something has been
   * counted. The two have to stay distinguishable: zero is a fact this page
   * can state, null is a question it has not had an answer to yet, and
   * collapsing them would print "none open right now" over every row for the
   * moment before the map arrives — and for good, if it never does.
   */
  const [open, setOpen] = useState<Map<string, number> | null>(null);

  useDocumentTitle('Every service — browse');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setCats((await api.tradeCatalog()).categories); }
    catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the catalogue.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /**
   * The counts, fetched apart from the catalogue and allowed to fail quietly,
   * the way the category page does it. The list of services is the page; how
   * many hours are free in each of them is a line on a row, and it is not
   * worth holding the page back for or failing it over.
   *
   * Counted one row per opening rather than one per slot. The map deliberately
   * offers a whole free day in every neighbourhood its owner covers, so
   * counting the rows would report that day once for each area the business
   * works in and this page would disagree with the trade page it links to.
   */
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await api.publicMap();
        const seen = new Set<string>();
        const n = new Map<string, number>();
        for (const s of res.slots) {
          if (seen.has(s.gap_id)) continue;
          seen.add(s.gap_id);
          const t = (s.trade ?? '').trim().toLowerCase();
          if (t) n.set(t, (n.get(t) ?? 0) + 1);
        }
        if (live) setOpen(n);
      } catch {
        // Every row still lists and still leads somewhere; they simply carry
        // no count, which is the right way to be wrong about a number.
      }
    })();
    return () => { live = false; };
  }, []);

  const services = useMemo(
    () => (cats ?? []).reduce((sum, c) => sum + c.trades.length, 0),
    [cats],
  );

  if (loading) {
    return (
      <PublicPage className="ix-page">
        <Spinner label="Loading the catalogue" />
      </PublicPage>
    );
  }
  if (error) {
    return (
      <PublicPage className="ix-page">
        <ErrorNote error={error} onRetry={() => void load()} />
      </PublicPage>
    );
  }

  const shown = cats ?? [];

  return (
    <PublicPage className="ix-page">
      <Crumbs items={[{ label: 'Browse' }]} />

      <header className="ix-head">
        <h1>
          Every service Slotfill covers
          {shown.length > 0 && (
            <span className="ix-count">
              {shown.length} {plural(shown.length, 'category', 'categories')},{' '}
              {services} {plural(services, 'service', 'services')}
            </span>
          )}
        </h1>
        <p className="ix-lede">
          Pick the job you need doing. Everything Slotfill covers is listed
          here whether or not somebody has an hour free in it this minute —
          every service has its own page, which counts what is open in it and
          says plainly when the answer is nothing.
        </p>
      </header>

      {/*
        An empty catalogue is not a quiet afternoon, it is the catalogue
        failing to arrive — so it is told as that rather than as "nothing is
        open", which would send somebody away waiting for services that are
        already there.
      */}
      {shown.length === 0 ? (
        <section className="ix-sec">
          <div className="ix-empty">
            <h2>The catalogue is not available</h2>
            <p>
              We could not read the list of services just now. Nothing is wrong
              with your link — try again, or go to the map and see what is open.
            </p>
            <div className="ix-empty-do">
              <button className="btn" onClick={() => void load()}>Try again</button>
              <Link className="btn quiet" to="/">See what is open</Link>
            </div>
          </div>
        </section>
      ) : (
        shown.map((c) => (
          <section className="ix-cat" key={c.key} aria-labelledby={`ix-cat-${c.key}`}>
            {/* The heading is the link to the category's own page, which is
                the middle level of the browse and carries the same services
                with the neighbourhoods underneath them. */}
            <h2 id={`ix-cat-${c.key}`}>
              <Link to={`/browse/${c.key}`}>{c.label}</Link>
            </h2>
            <p className="ix-cat-sub">
              {c.trades.length} {plural(c.trades.length, 'service', 'services')}
            </p>

            {c.trades.length > 0 ? (
              /* Whole-row links, not a label with a link inside it. On a phone
                 the thumb lands anywhere in the row and the row is the
                 target. */
              <ul className="ix-list">
                {c.trades.map((t) => {
                  const n = open ? (open.get(t.slug) ?? 0) : null;
                  return (
                    <li key={t.slug}>
                      <Link className="ix-row" to={`/s/${encodeURIComponent(t.slug)}`}>
                        <span className="ix-row-text">
                          <span className="ix-row-name">{t.label}</span>
                          {t.hint && <span className="ix-row-sub">{t.hint}</span>}
                          {/*
                            A trade with nothing free says so in words. A bare
                            nought sitting where a number usually means "open
                            now" reads as a broken count rather than as an
                            empty week, and the row is worth pressing either
                            way: the trade page names who does this work and
                            takes an alert for when an hour opens up.
                          */}
                          {n !== null && (
                            <span className="ix-row-sub">
                              {n > 0
                                ? `${n} ${plural(n, 'appointment', 'appointments')} open now`
                                : 'None open right now'}
                            </span>
                          )}
                        </span>
                        <span className="ix-row-go" aria-hidden="true">›</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : (
              /* Only reachable if the catalogue itself files no services under
                 this heading, which is a gap in the catalogue rather than a
                 quiet week. */
              <p className="ix-sec-sub">No services are listed in this category yet.</p>
            )}
          </section>
        ))
      )}

      <section className="ix-sec" aria-labelledby="ix-other">
        <h2 id="ix-other">The other way round</h2>
        <p className="ix-sec-sub">
          Slotfill can be read by the job, which is this page, or by where the
          van is.
        </p>
        <ul className="ix-else">
          {/* Plain anchors: these two are server-rendered by the Worker rather
              than being React routes, so a client-side navigation to them
              would land on the catch-all. */}
          <li><a href="/near">Browse by neighbourhood</a></li>
          <li><a href="/los-angeles">Mobile services in Los Angeles</a></li>
          <li><Link to="/cost">What things cost</Link></li>
        </ul>
      </section>

      <footer className="ix-foot">
        <p>
          A service is listed here because Slotfill covers that work. Any count
          beside it was taken from the openings at the moment this page loaded.
        </p>
      </footer>
    </PublicPage>
  );
}
