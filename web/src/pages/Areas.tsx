import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, sentence, type MapArea, type PublicSlot, type TradeCategory } from '../api';
import Crumbs from '../components/Crumbs';
import PublicPage from '../components/PublicPage';
import { ErrorNote, Spinner } from '../components/ui';
import '../styles-index.css';
import { nearTradeHref } from '../lib/seo';
import { useDocumentTitle } from '../lib/title';

/**
 * Every service area, and what is open in each. Route /near.
 *
 * THIS ROUTE EXISTS BECAUSE THE WORKER ALREADY ANSWERS THIS URL. It
 * server-renders /near from `areaIndexPage` in src/lib/seo.ts and splices that
 * markup into #root, and React then mounts over it. Without a route here the
 * catch-all would redirect a visitor to the front page the instant the bundle
 * booted — the server-rendered page would appear for a moment and then be
 * thrown away, which is worse than never having rendered it. So this page has
 * to exist, and it has to say what the server-rendered one says: a crawler
 * reading the spliced HTML and a person watching React take over must not be
 * shown two different pages.
 *
 * What it is for is the same either way. /near/<place> pages were reachable
 * from each other by proximity and from the footer, which meant a
 * neighbourhood nobody happened to be near was reachable from nothing at all.
 * This is the page that closes that graph.
 *
 * Every number here is counted from the rows fetched in this render. There is
 * nothing on this page about how many neighbourhoods we wish we covered.
 */

/**
 * One row per genuine opening.
 *
 * The map deliberately offers a whole free day in every neighbourhood its
 * owner covers, because it genuinely is available in all of them — right for a
 * pin, and double counting the moment a page adds the city up rather than one
 * place. Counting the openings instead of the rows is what makes the total in
 * the heading agree with the sum a reader could do themselves.
 */
function distinctGaps(slots: PublicSlot[]): PublicSlot[] {
  const seen = new Set<string>();
  const out: PublicSlot[] = [];
  for (const s of slots) {
    if (seen.has(s.gap_id)) continue;
    seen.add(s.gap_id);
    out.push(s);
  }
  return out;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export default function Areas() {
  const [areas, setAreas] = useState<MapArea[]>([]);
  const [slots, setSlots] = useState<PublicSlot[]>([]);
  const [cats, setCats] = useState<TradeCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useDocumentTitle('Every neighbourhood — Los Angeles, California');

  /**
   * The map and the catalogue together, because this page needs both to be
   * right and neither is worth showing without the other: the map is what is
   * open, and the catalogue is the only way to know which of the trades in it
   * has a page of its own to link to. One failure, one message, one retry.
   */
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [map, catalog] = await Promise.all([api.publicMap(), api.tradeCatalog()]);
      setAreas(map.areas);
      setSlots(map.slots);
      setCats(catalog.categories);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the neighbourhoods.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /**
   * The trades the catalogue names, so a link is only ever made to a trade
   * page that exists. An operator's trade is free text on their record, and
   * minting /near/encino/<whatever-they-typed> would publish an address that
   * answers nothing.
   */
  const known = useMemo(
    () => new Set(cats.flatMap((c) => c.trades.map((t) => t.slug))),
    [cats],
  );

  /**
   * One row per neighbourhood: its openings, and the trades inside them.
   * Busiest first, then alphabetically, which is the order the server-rendered
   * page puts them in — a visitor who arrived on that HTML must not watch the
   * list reshuffle itself when React mounts.
   */
  const rows = useMemo(() => areas.map((area) => {
    const mine = distinctGaps(slots.filter((s) => s.area_slug === area.slug));
    const counts = new Map<string, number>();
    for (const s of mine) {
      const t = (s.trade ?? '').trim().toLowerCase();
      if (t && known.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    const trades = [...counts.entries()]
      .map(([trade, n]) => ({ trade, n }))
      .sort((a, b) => b.n - a.n || a.trade.localeCompare(b.trade));
    return { area, n: mine.length, trades };
  }).sort((x, y) => y.n - x.n || x.area.name.localeCompare(y.area.name)),
  [areas, slots, known]);

  const live = rows.filter((r) => r.n > 0);
  const quiet = rows.filter((r) => r.n === 0);

  /**
   * Counted over the whole map rather than by adding the per-area figures up.
   * A whole free day is genuinely offered in every neighbourhood its owner
   * covers, so it is right on each of those rows and would be counted several
   * times over in a total.
   */
  const openings = useMemo(() => distinctGaps(slots).length, [slots]);

  if (loading) {
    return (
      <PublicPage className="ix-page">
        <Spinner label="Counting what is open" />
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

  return (
    <PublicPage className="ix-page">
      {/* The same trail the server-rendered page prints, and Crumbs emits the
          BreadcrumbList that markup carries in its JSON-LD. Crumbs prepends
          Slotfill itself. */}
      <Crumbs items={[
        { label: 'Los Angeles', to: '/los-angeles' },
        { label: 'Neighbourhoods' },
      ]} />

      <header className="ix-head">
        <h1>
          Every neighbourhood Slotfill covers
          <span className="ix-count">
            {areas.length} {plural(areas.length, 'neighbourhood', 'neighbourhoods')},{' '}
            {openings} open {plural(openings, 'appointment', 'appointments')}
          </span>
        </h1>
        <p className="ix-lede">
          A neighbourhood is on this list because a business has told us it
          works there. What is open in each one is counted from the openings
          live, and it changes through the day — an opening appears when a job
          is cancelled or a gap opens between two booked jobs.
        </p>
      </header>

      {/*
        A city with nothing open in it is ordinary traffic rather than a
        failure, and it is a sentence rather than an empty page. The
        neighbourhoods are still listed underneath, because a place being quiet
        this hour is not a reason to hide that it is covered.
      */}
      {live.length === 0 ? (
        <section className="ix-sec">
          <div className="ix-empty">
            <h2>Nothing is open in any neighbourhood at the moment</h2>
            <p>
              An opening is an hour a business has free, so the whole city can
              be quiet for an hour and full by the afternoon. Rather than show
              you a listing that is not there, we will tell you when one
              appears.
            </p>
            <div className="ix-empty-do">
              <Link className="btn" to="/a">Tell me when one appears</Link>
              <Link className="btn quiet" to="/browse">See every service</Link>
            </div>
          </div>
        </section>
      ) : (
        <section className="ix-sec" aria-labelledby="ix-live">
          <h2 id="ix-live">Open now</h2>
          {live.map((r) => (
            /*
              The place name is a heading and a link at once, the way the
              server-rendered page has it, so the index can be walked by
              heading as well as read. It is an h3 rather than the h2 that
              markup uses: these neighbourhoods sit under "Open now", and
              making them siblings of it would say they were not.
            */
            <div className="ix-area" key={r.area.slug}>
              <h3>
                {/* A plain anchor, not a Link: /near/<place> is rendered by
                    the Worker and is not a React route, so a client-side
                    navigation to it would land on the catch-all. */}
                <a href={`/near/${encodeURIComponent(r.area.slug)}`}>{r.area.name}</a>
                <span className="ix-area-n">{r.n} open</span>
              </h3>
              {r.trades.length > 0 ? (
                <ul className="ix-jump">
                  {r.trades.map((t) => (
                    <li key={t.trade}>
                      <a href={nearTradeHref(r.area.slug, t.trade)}>
                        {sentence(t.trade)} ({t.n})
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                /* Openings here, but none of them under a trade this site has
                   a page for. Saying so is better than a heading with an
                   empty list under it. */
                <p className="ix-note">Nothing open here at the moment.</p>
              )}
            </div>
          ))}
        </section>
      )}

      {quiet.length > 0 && (
        <section className="ix-sec" aria-labelledby="ix-quiet">
          <h2 id="ix-quiet">Quiet right now</h2>
          <p className="ix-sec-sub">
            Businesses cover these neighbourhoods and none of them has an hour
            free in one at this moment. Each page says so itself, and takes an
            alert for when that changes.
          </p>
          <ul className="ix-tiles">
            {quiet.map((r) => (
              <li key={r.area.slug}>
                <a className="ix-tile" href={`/near/${encodeURIComponent(r.area.slug)}`}>
                  <span className="ix-tile-name">Open appointments in {r.area.name}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="ix-sec" aria-labelledby="ix-city">
        <h2 id="ix-city">The whole city</h2>
        <ul className="ix-else">
          <li><a href="/los-angeles">Mobile services in Los Angeles</a></li>
          <li><Link to="/browse">Every service, by category</Link></li>
        </ul>
      </section>

      <footer className="ix-foot">
        <p>
          Every figure on this page was counted from the openings at the moment
          the page loaded. A neighbourhood is listed because a business said it
          works there, and for no other reason.
        </p>
      </footer>
    </PublicPage>
  );
}
