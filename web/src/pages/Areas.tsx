import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api, sentence,
  type MapArea, type Metro, type PublicSlot, type TradeCategory,
} from '../api';
import Crumbs from '../components/Crumbs';
import PublicPage from '../components/PublicPage';
import { ErrorNote, Spinner } from '../components/ui';
import '../styles-index.css';
import '../styles-areas.css';
import { plural } from '../lib/format';
import { groupByMetro, loadMetros, metroNames } from '../lib/metros';
import { distinctGaps } from '../lib/slots';
import { nearTradeHref, tradeHref } from '../lib/seo';
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
 *
 * IT IS GROUPED BY METRO, and that is not decoration. This was one run of
 * neighbourhoods while the product was one city; now that it is two, an
 * undifferentiated list puts Orcutt next to Northridge and tells the reader
 * they are down the road from each other when they are a hundred and fifty
 * miles apart. `MapArea.metro` says which place each one is in, and the metro
 * records name it.
 */


export default function Areas() {
  const [metros, setMetros] = useState<Metro[]>([]);
  const [areas, setAreas] = useState<MapArea[]>([]);
  const [slots, setSlots] = useState<PublicSlot[]>([]);
  const [cats, setCats] = useState<TradeCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Named from the list rather than written out, so the tab says what the
  // server-rendered page's <title> says at two places and at three.
  useDocumentTitle(metros.length ? `Every neighbourhood — ${metroNames(metros)}` : null);

  /**
   * The metro records, the map and the catalogue together, because this page
   * needs all three to be right and none is worth showing without the others:
   * the map is what is open, the metro records are what each neighbourhood is
   * filed under, and the catalogue is the only way to know which of the trades
   * has a page of its own to link to. One failure, one message, one retry.
   */
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [list, map, catalog] = await Promise.all([
        loadMetros(), api.publicMap(), api.tradeCatalog(),
      ]);
      setMetros(list);
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

  /**
   * The same rows, in metro order, with each metro's own totals beside it.
   *
   * The per-metro count of openings is counted over that metro's slots for the
   * reason the site-wide one below is counted over all of them: adding the
   * per-area figures up would count a whole free day once for every
   * neighbourhood its owner covers.
   */
  const grouped = useMemo(() => groupByMetro(metros, rows, (r) => r.area.metro)
    .map((g) => {
      const here = new Set(g.rows.map((r) => r.area.slug));
      return {
        ...g,
        open: distinctGaps(slots.filter((s) => here.has(s.area_slug))).length,
        live: g.rows.filter((r) => r.n > 0),
        quiet: g.rows.filter((r) => r.n === 0),
      };
    }), [metros, rows, slots]);

  const anyLive = rows.some((r) => r.n > 0);

  /**
   * WHICH TRADES ACTUALLY WORK THESE NEIGHBOURHOODS, counted the other way
   * round from everything else on the page.
   *
   * The sections above are neighbourhood-first: pick a place, see what is in
   * it. That answers the question of a reader who already knows where they
   * live and is the right default. It does not answer the other half of the
   * traffic — somebody who knows they want a locksmith and wants to know
   * whether this site has locksmiths at all — and until now the only way to
   * find that out was to open neighbourhoods one at a time until one had the
   * word in it.
   *
   * The figure beside each trade is HOW MANY NEIGHBOURHOODS IT IS OPEN IN and
   * not how many openings it has, because "eleven openings" on this page could
   * be one business having a slow week and the question being asked is one of
   * coverage. It is counted off the same rows the metro blocks are built from,
   * so the two cannot disagree.
   *
   * Labels come from the catalogue rather than from `sentence(slug)`: the
   * catalogue is where a trade's name is written properly, and it is also the
   * only guarantee that /s/<slug> is a page rather than a 404. `rows` has
   * already dropped anything the catalogue does not name.
   */
  const tradeCoverage = useMemo(() => {
    const bySlug = new Map(cats.flatMap((c) => c.trades.map((t) => [t.slug, t] as const)));
    const areasPerTrade = new Map<string, number>();
    for (const r of rows) {
      for (const t of r.trades) {
        areasPerTrade.set(t.trade, (areasPerTrade.get(t.trade) ?? 0) + 1);
      }
    }
    return [...areasPerTrade.entries()]
      .flatMap(([slug, n]) => {
        const trade = bySlug.get(slug);
        return trade ? [{ trade, n }] : [];
      })
      .sort((a, b) => b.n - a.n || a.trade.label.localeCompare(b.trade.label));
  }, [cats, rows]);

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
          Round The Way itself. This page is under no one metro — it lists them
          all — so there is no metro step in it. */}
      <Crumbs items={[{ label: 'Neighbourhoods' }]} />

      <header className="ix-head">
        <h1>
          Every neighbourhood Round The Way covers
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
        Everywhere being quiet at once is ordinary traffic rather than a
        failure, and it is a sentence rather than an empty page. The
        neighbourhoods are still listed underneath, metro by metro, because a
        place being quiet this hour is not a reason to hide that it is covered.
      */}
      {!anyLive && (
        <section className="ix-sec">
          <div className="ix-empty">
            <h2>Nothing is open in any neighbourhood at the moment</h2>
            <p>
              An opening is an hour a business has free, so everywhere Round The Way
              covers can be quiet for an hour and full by the afternoon. Rather
              than show you a listing that is not there, we will tell you when
              one appears.
            </p>
            <div className="ix-empty-do">
              <Link className="btn" to="/a">Tell me when one appears</Link>
              <Link className="btn quiet" to="/browse">See every service</Link>
            </div>
          </div>
        </section>
      )}

      {/*
        ONE BLOCK PER METRO, which is the shape the server-rendered page has
        and the only shape that answers the question a reader of this page is
        actually asking. The metro is the h2 and each neighbourhood in it is an
        h3 underneath, so the index can be walked by heading and the nesting
        says which place each name belongs to without anybody having to know
        the geography. A metro with nothing listed in it is not printed as an
        empty heading; it is simply not here.
      */}
      {grouped.map((g) => (
        <section className="ix-sec" key={g.metro?.slug ?? 'unfiled'}
          aria-labelledby={`ix-m-${g.metro?.slug ?? 'unfiled'}`}>
          <h2 id={`ix-m-${g.metro?.slug ?? 'unfiled'}`}>
            {/* A plain anchor: the metro page is server-rendered by the
                Worker. It is a React route too, so React can mount over that
                HTML, but a client-side navigation would skip the render. */}
            {g.metro ? <a href={g.metro.path}>{g.metro.name}</a> : 'Elsewhere'}
            <span className="ix-count">
              {g.rows.length} {plural(g.rows.length, 'neighbourhood', 'neighbourhoods')},{' '}
              {g.open} open {plural(g.open, 'appointment', 'appointments')}
            </span>
          </h2>

          {g.live.length > 0 ? g.live.map((r) => (
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
          )) : (
            <p className="ix-note">Nothing is open here at the moment.</p>
          )}

          {g.quiet.length > 0 && (
            <>
              <h3 className="ix-sub-h">Quiet right now</h3>
              <p className="ix-sec-sub">
                Businesses cover these neighbourhoods and none of them has an
                hour free in one at this moment. Each page says so itself, and
                takes an alert for when that changes.
              </p>
              <ul className="ix-tiles">
                {g.quiet.map((r) => (
                  <li key={r.area.slug}>
                    <a className="ix-tile" href={`/near/${encodeURIComponent(r.area.slug)}`}>
                      <span className="ix-tile-name">
                        Open appointments in {r.area.name}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      ))}

      {/*
        The trade-first way into the same set of links, for the reader who
        knows what they want and not where it is. Omitted rather than shown
        empty: on an hour when nothing is open anywhere this list would be a
        heading over nothing, and the empty state above has already said so
        once.
      */}
      {tradeCoverage.length > 0 && (
        <section className="ix-sec" aria-labelledby="ix-trades">
          <h2 id="ix-trades">Which trades work these neighbourhoods</h2>
          <p className="ix-sec-sub">
            Every trade with an opening somewhere on this page right now, and
            how many of the neighbourhoods it is open in. Each one leads to that
            trade's own page, which counts what is open across everywhere
            Round The Way covers.
          </p>
          <ul className="ar-trades">
            {tradeCoverage.map((t) => (
              <li key={t.trade.slug}>
                <Link className="ar-trade" to={tradeHref(t.trade.slug)}>
                  {t.trade.label}
                  <span className="ar-trade-n">
                    {t.n} {plural(t.n, 'neighbourhood', 'neighbourhoods')}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <p className="ix-note">
            Counted from what is open at this moment, so a trade with a quiet
            morning is not on this list and is not therefore absent from the
            site. <Link to="/browse">The full catalogue</Link> is the list that
            does not move.
          </p>
        </section>
      )}

      {/*
        WHAT "COVERED" ACTUALLY MEANS, which this page has always assumed the
        reader knew.

        Every neighbourhood above is a place a business drives to, and the two
        things that follow from that are worth a paragraph each rather than a
        footnote: a boundary on this site is a business's own answer about how
        far it will drive, and an address has to be able to receive a van. A
        reader who has just found their neighbourhood on this page is about to
        book one, and this is the last point at which either fact is cheap to
        learn.

        Nothing here is a claim about how many businesses cover anywhere or how
        far any of them will go. Where the honest answer is that it depends on
        the business, it says so.
      */}
      <section className="ix-sec" aria-labelledby="ix-mean">
        <h2 id="ix-mean">What it means for a neighbourhood to be on this list</h2>
        <div className="ar-explain">
          <p>
            A neighbourhood is here because at least one business told us it
            works there. That is a business's own statement about how far it is
            willing to drive, and it is the only thing that puts a name on this
            page — not a population, not a boundary drawn by a council, and not
            an area we have decided to expand into. When a business changes the
            list of places it covers, this page changes with it.
          </p>
          <p>
            Which also means a neighbourhood being listed does not tell you
            every trade is available in it. The counts beside each name are
            openings from the businesses that happen to cover it, and a place
            covered by two businesses will look thinner than one covered by
            twelve however similar the two streets are.
          </p>
          <p>
            Because the work comes to the address, what matters at your end is
            whether a van can arrive and work. Somewhere to stand the vehicle
            for the length of the job, access that is not gated or height-
            limited past what a van will clear, and — for anything involving
            water or power — either an outside tap and socket or a business
            that carries its own. Round The Way does not record which businesses
            carry their own, so that last one is a question for messages before
            the day rather than something this page can answer.
          </p>
        </div>
      </section>

      <section className="ix-sec" aria-labelledby="ix-places">
        <h2 id="ix-places">The places Round The Way serves</h2>
        <ul className="ix-else">
          {metros.map((m) => (
            <li key={m.slug}>
              <a href={m.path}>Mobile services in {m.name}</a>
            </li>
          ))}
          <li><Link to="/browse">Every service, by category</Link></li>
        </ul>
      </section>

      {/*
        The same closing action the metro pages carry, and the same reasoning:
        the honest thing to offer on a coverage page is a way to be told when
        something opens, because on a quiet hour there is nothing else to do
        here. It is repeated on the metro page rather than shared as a
        component because the two say different sentences — that one names a
        place and this one cannot.
      */}
      <section className="ar-cta" aria-labelledby="ix-do">
        <h2 id="ix-do">If your neighbourhood is quiet</h2>
        <p>
          Openings appear through the day as jobs cancel and gaps open between
          booked ones, so a neighbourhood with nothing in it this morning may
          have something by the afternoon. You can be told when one appears
          rather than checking, or look through the catalogue and start from
          the work instead of the place.
        </p>
        <div className="ar-cta-do">
          <Link className="btn" to="/a">Tell me when one appears</Link>
          <Link className="btn quiet" to="/browse">See every service</Link>
          <Link className="btn quiet" to="/pros">Cover a neighbourhood</Link>
        </div>
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
