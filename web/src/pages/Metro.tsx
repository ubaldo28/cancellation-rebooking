import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type MapArea, type PublicSlot, type TradeCategory } from '../api';
import Crumbs from '../components/Crumbs';
import PublicPage from '../components/PublicPage';
import { ErrorNote, Spinner } from '../components/ui';
import '../styles-index.css';
import { useDocumentTitle } from '../lib/title';

/**
 * The metro page. Route /los-angeles.
 *
 * The Worker server-renders this URL from `metroPage` in src/lib/seo.ts and
 * splices the markup into #root before React mounts over it. With no route
 * here the catch-all would send the visitor to the front page a moment after
 * that HTML appeared, taking the page with it — so this route exists, and it
 * says what the server-rendered page says.
 *
 * THE RULE FOR THE PROSE ON THIS PAGE, because a city page is where every
 * marketplace starts inventing: the only things it may say are general facts
 * about Los Angeles that would be true if this site did not exist, and true
 * statements about how Slotfill works. There is nothing here about how many
 * customers we have, how quickly anybody replies, how much anybody saves, or
 * how well this site is doing. Every number on the page is counted from the
 * openings fetched in this render, and where the count is nothing the page
 * says nothing is open rather than filling the space.
 */

/** The metro this product launched in, and the state it is in. Facts, not counts. */
const METRO = 'Los Angeles';
const LAUNCH_STATE = 'California';

/**
 * One row per genuine opening.
 *
 * The map offers a whole free day in every neighbourhood its owner covers,
 * because it genuinely is available in all of them — right for a pin, and
 * double counting the moment a page adds the whole city up. Every total on
 * this page is over the openings, not over the rows.
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

/** How many trades the ranked list shows before it stops being a list. */
const TOP = 12;

export default function Metro() {
  const [areas, setAreas] = useState<MapArea[]>([]);
  const [slots, setSlots] = useState<PublicSlot[]>([]);
  const [cats, setCats] = useState<TradeCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useDocumentTitle(`Mobile services in ${METRO}, ${LAUNCH_STATE}`);

  /**
   * The map and the whole catalogue. The catalogue is not a decoration here —
   * the "every service" section below is the catalogue — so both are loaded
   * together and the page fails as one thing rather than half rendering.
   */
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [map, catalog] = await Promise.all([api.publicMap(), api.tradeCatalog()]);
      setAreas(map.areas);
      setSlots(map.slots);
      setCats(catalog.categories);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load what is open.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const all = useMemo(() => distinctGaps(slots), [slots]);
  const samples = useMemo(() => all.filter((s) => s.is_sample).length, [all]);
  const businesses = useMemo(
    () => new Set(all.map((s) => s.operator_id)).size, [all],
  );
  const withOpenings = useMemo(
    () => areas.filter((a) => a.slot_count > 0), [areas],
  );

  /**
   * The cheapest genuine listing, which is the only one whose price may be
   * printed as a headline figure: a seeded sample is a real price on a real
   * operator record but is not a business trading today, and a stat tile has
   * no room for the label that would say so.
   */
  const cheapest = useMemo(() => all
    .filter((s) => !s.is_sample)
    .reduce<PublicSlot | null>(
      (best, s) => (!best || s.price_cents < best.price_cents ? s : best), null),
  [all]);

  /**
   * Every trade with something open, ranked by how many openings it has and by
   * nothing else. Trades are matched against the catalogue so a row can only
   * ever link to a trade page that exists.
   */
  const ranked = useMemo(() => {
    const bySlug = new Map(cats.flatMap((c) => c.trades.map((t) => [t.slug, t] as const)));
    const counts = new Map<string, number>();
    for (const s of all) {
      const t = (s.trade ?? '').trim().toLowerCase();
      if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()]
      .flatMap(([slug, n]) => {
        const trade = bySlug.get(slug);
        return trade ? [{ trade, n }] : [];
      })
      .sort((a, b) => b.n - a.n || a.trade.label.localeCompare(b.trade.label));
  }, [cats, all]);

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
      <Crumbs items={[{ label: METRO }]} />

      <header className="ix-head">
        <h1>
          Mobile services in {METRO}, {LAUNCH_STATE}
          <span className="ix-count">
            {all.length} open {plural(all.length, 'appointment', 'appointments')} right now
          </span>
        </h1>
        <p className="ix-lede">
          Every appointment listed here is an hour a {METRO} business has free
          this week — a job that cancelled, or a day that has not filled. The
          price is the one the business set. Booking one holds it; nothing is
          paid on this site yet, so you settle that price with the business
          directly.
        </p>

        {/* Four counts, none of them written down: each is read off the rows
            this page has just fetched, and the price tile is omitted rather
            than zeroed when there is no genuine listing to quote. */}
        <ul className="ix-stats">
          <li className="ix-stat">
            <b>{all.length}</b>
            <span>{plural(all.length, 'appointment open', 'appointments open')}</span>
          </li>
          <li className="ix-stat">
            <b>{businesses}</b>
            <span>{plural(businesses, 'business listed', 'businesses listed')}</span>
          </li>
          <li className="ix-stat">
            <b>{withOpenings.length}</b>
            <span>{plural(withOpenings.length, 'neighbourhood', 'neighbourhoods')}</span>
          </li>
          {cheapest && (
            <li className="ix-stat">
              <b>{cheapest.price}</b>
              <span>lowest price listed</span>
            </li>
          )}
        </ul>

        {/*
          How many of the rows behind those figures are seeded samples. A
          sample is a real price on a real operator record and is not a
          business trading today, and silence would let one be read as evidence
          of a market. "25 of the 25 are samples" is not a sentence anybody
          writes, so when every listing is seeded the page says that instead.
        */}
        {samples > 0 && (
          <p className="ix-flag">
            {samples === all.length
              ? (all.length === 1
                ? 'That listing is a sample'
                : `All ${all.length} are sample listings`)
              : `${samples} of them ${
                samples === 1 ? 'is a sample listing' : 'are sample listings'}`}
            {' '}we seeded ourselves rather than a business trading today. Each
            one is labelled where it appears.
          </p>
        )}
      </header>

      <section className="ix-sec" aria-labelledby="ix-top">
        <h2 id="ix-top">Top services in {METRO} right now</h2>
        {ranked.length > 0 ? (
          <ul className="ix-list">
            {ranked.slice(0, TOP).map((r) => (
              <li key={r.trade.slug}>
                <Link className="ix-row" to={`/s/${encodeURIComponent(r.trade.slug)}`}>
                  <span className="ix-row-text">
                    <span className="ix-row-name">{r.trade.label}</span>
                    {r.trade.hint && <span className="ix-row-sub">{r.trade.hint}</span>}
                  </span>
                  <span className="ix-row-n">{r.n} open</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="ix-sec-sub">
            Nothing is open in any trade at the moment. This page counts what is
            listed and does not estimate, so on a quiet hour it is a short page.
          </p>
        )}
        {/* Said under the list rather than above it, because it is a caveat on
            an ordering somebody has already read and not an instruction for
            how to read one. */}
        <p className="ix-note">
          Ranked by how many appointments each trade has open at this moment,
          and by nothing else. It is not a popularity list and it moves through
          the day.
        </p>
      </section>

      <section className="ix-sec" aria-labelledby="ix-hoods">
        <h2 id="ix-hoods">Neighbourhoods</h2>
        {areas.length > 0 ? (
          <ul className="ix-tiles">
            {areas.map((a) => (
              <li key={a.slug}>
                {/* Plain anchors: /near/<place> is server-rendered by the
                    Worker and is not a React route, so a client-side
                    navigation would land on the catch-all. */}
                <a className="ix-tile" href={`/near/${encodeURIComponent(a.slug)}`}>
                  <span className="ix-tile-name">{a.name}</span>
                  {a.slot_count > 0 && <span className="ix-tile-n">{a.slot_count} open</span>}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="ix-sec-sub">No neighbourhoods are covered yet.</p>
        )}
        <p className="ix-note">
          <a href="/near">Every neighbourhood, with what is open in it</a>
        </p>
      </section>

      <section className="ix-sec" aria-labelledby="ix-every">
        <h2 id="ix-every">Every service</h2>
        <p className="ix-sec-sub">
          The whole catalogue, whether or not somebody happens to have an hour
          free in it this minute. Each service has a page that counts what is
          open in it and says plainly when the answer is nothing.
        </p>
        {cats.length > 0 ? cats.map((c) => (
          <div className="ix-cat" key={c.key}>
            <h3><Link to={`/browse/${c.key}`}>{c.label}</Link></h3>
            <ul className="ix-else">
              {c.trades.map((t) => (
                <li key={t.slug}>
                  <Link to={`/s/${encodeURIComponent(t.slug)}`}>{t.label}</Link>
                </li>
              ))}
            </ul>
          </div>
        )) : (
          <p className="ix-sec-sub">The catalogue could not be read just now.</p>
        )}
      </section>

      {/*
        THE ONLY PROSE ON THE PAGE, and both paragraphs of it are general facts
        about Los Angeles that would be true if this site did not exist. The
        third says what this site does, which is checkable. Nothing here is a
        claim about Slotfill's size, its popularity or its results, and nothing
        may be added that is.
      */}
      <section className="ix-sec" aria-labelledby="ix-why">
        <h2 id="ix-why">Why mobile work suits {METRO}</h2>
        <div className="ix-prose">
          <p>
            Los Angeles has a Mediterranean climate: a long dry season from
            roughly May to October and most of the year's rain in a handful of
            winter months. Dust and pollen settle on cars, windows and solar
            panels through the dry months, and the first rains wash them into
            gutters and drains — which is why so much of the work listed here
            is cleaning of one kind or another, and why it clusters seasonally.
          </p>
          <p>
            Most of the housing in the city is low-rise, with driveways, yards
            and street parking rather than loading bays. That is what makes a
            van practical: the person doing the work can bring water, power and
            tools to the address instead of the address coming to a shop.
          </p>
          <p>
            None of that is a claim about Slotfill. What this site does is
            narrower and easier to check: a business posts the hours it has
            free, at the price it sets, and you book one of them. Openings
            appear when a job is cancelled or a gap opens between two booked
            jobs, so the list on this page is different in the afternoon from
            what it was in the morning.
          </p>
        </div>
      </section>

      <footer className="ix-foot">
        <p>
          Every figure on this page was counted from the openings at the moment
          the page loaded. Prices are set by the business doing the work.
        </p>
        <p>
          <a href="/near">Every neighbourhood</a>
          {' · '}
          <Link to="/browse">Every service</Link>
          {' · '}
          <Link to="/cost">What things cost</Link>
        </p>
      </footer>
    </PublicPage>
  );
}
