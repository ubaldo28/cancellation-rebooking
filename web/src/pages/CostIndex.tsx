import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type PublicSlot, type Trade, type TradeCategory } from '../api';
import Crumbs from '../components/Crumbs';
import PublicPage from '../components/PublicPage';
import { ErrorNote, Spinner } from '../components/ui';
import '../styles-index.css';
import { ENOUGH, formatMoney as money, median } from '../lib/format';
import { useDocumentTitle } from '../lib/title';

/**
 * What every trade is listed at today, and the way into each cost guide.
 * Route /cost.
 *
 * The footer's "Cost guides" link points here. Until this page existed there
 * was no way to reach a cost guide except by already knowing the trade you
 * wanted and typing its address, which made the site's most searchable pages
 * the least reachable ones.
 *
 * IT IS HELD TO THE COST GUIDE'S RULE, because it is the same numbers on one
 * page instead of forty. Every figure is a price a business on Slotfill is
 * asking right now, counted from the rows fetched in this render. There is no
 * national average here, no typical cost and no "expect to pay", because there
 * is no survey behind any of those and we are not going to estimate one.
 *
 * And the rule CostGuide already follows for a thin trade is followed here
 * too: below ENOUGH listed prices there is no spread to report, only two or
 * three businesses' opinions, so the trade is listed with how little is behind
 * it rather than with a range invented out of a coincidence.
 */


const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

interface Priced {
  trade: Trade;
  /** Listings counted, in the currency below and no other. */
  n: number;
  businesses: number;
  samples: number;
  currency: string | null;
  low: number | null;
  mid: number | null;
  high: number | null;
}

export default function CostIndex() {
  const [slots, setSlots] = useState<PublicSlot[]>([]);
  const [cats, setCats] = useState<TradeCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useDocumentTitle('What things cost');

  /**
   * The listings and the whole catalogue together. The catalogue is not
   * decoration here: a trade with nothing listed today still has a cost guide
   * that says so honestly, and leaving it off this page because it is quiet
   * would hide the one page that answers the question truthfully.
   */
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [map, catalog] = await Promise.all([api.publicMap(), api.tradeCatalog()]);
      setSlots(map.slots);
      setCats(catalog.categories);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the listed prices.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /**
   * One row per opening, per trade.
   *
   * The map offers a whole free day in every neighbourhood its owner covers,
   * so counting the rows would count one business's Tuesday once for each area
   * it works in and quietly turn a single listing into a spread. Deduplicating
   * on the opening is what keeps the count here equal to the count the trade's
   * own cost guide reports.
   */
  const byTrade = useMemo(() => {
    const seen = new Set<string>();
    const out = new Map<string, PublicSlot[]>();
    for (const s of slots) {
      if (seen.has(s.gap_id)) continue;
      seen.add(s.gap_id);
      const t = (s.trade ?? '').trim().toLowerCase();
      if (!t) continue;
      const list = out.get(t);
      if (list) list.push(s); else out.set(t, [s]);
    }
    return out;
  }, [slots]);

  /**
   * Every trade the catalogue names, with what is listed under it. The
   * catalogue is the spine rather than the listings, so a quiet trade keeps
   * its proper name and its place instead of vanishing from the index.
   */
  const rows = useMemo<Priced[]>(() => cats.flatMap((c) => c.trades.map((trade) => {
    const mine = byTrade.get(trade.slug) ?? [];

    /*
      One currency only. A median taken across dollars and pounds is not a
      price, it is an average of two different units. In practice everything
      is in one currency, so this is a guard rather than a feature: report on
      whichever currency the most listings are in, so the two figures on a row
      are always comparable with each other.
    */
    const counts = new Map<string, number>();
    for (const s of mine) counts.set(s.currency, (counts.get(s.currency) ?? 0) + 1);
    const currency = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const priced = currency ? mine.filter((s) => s.currency === currency) : [];
    const cents = priced.map((s) => s.price_cents).sort((a, b) => a - b);

    return {
      trade,
      n: cents.length,
      businesses: new Set(priced.map((s) => s.operator_id)).size,
      // Seeded listings are real prices on a real operator record but are not
      // a business trading today, so the page says how many of the rows behind
      // these figures are samples rather than quietly counting them in.
      samples: priced.filter((s) => s.is_sample).length,
      currency,
      low: cents[0] ?? null,
      mid: median(cents),
      high: cents[cents.length - 1] ?? null,
    };
  })), [cats, byTrade]);

  // Cheapest first inside the priced group: this is a page somebody arrived on
  // because they are worried about the price, so the smallest number is the
  // one at the top.
  const ranged = rows.filter((r) => r.n >= ENOUGH)
    .sort((a, b) => (a.low ?? 0) - (b.low ?? 0) || a.trade.label.localeCompare(b.trade.label));
  const thin = rows.filter((r) => r.n > 0 && r.n < ENOUGH)
    .sort((a, b) => a.trade.label.localeCompare(b.trade.label));
  const bare = rows.filter((r) => r.n === 0)
    .sort((a, b) => a.trade.label.localeCompare(b.trade.label));

  const listings = rows.reduce((sum, r) => sum + r.n, 0);
  const samples = rows.reduce((sum, r) => sum + r.samples, 0);

  if (loading) {
    return (
      <PublicPage className="ix-page">
        <Spinner label="Reading listed prices" />
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
      <Crumbs items={[{ label: 'Cost' }]} />

      <header className="ix-head">
        <h1>
          What things cost on Slotfill
          <span className="ix-count">
            {rows.length} {plural(rows.length, 'cost guide', 'cost guides')},{' '}
            {ranged.length} of them with a listed range, {listings}{' '}
            {plural(listings, 'listing', 'listings')} counted
          </span>
        </h1>

        {/*
          THE SENTENCE THAT MAKES THESE PAGES HONEST, above the figures rather
          than in a footnote under them, and in the same words the cost guides
          use. If it is ever softened into "the average cost of X is", this
          page becomes the thing the cost guides were written to avoid.
        */}
        <p className="ix-flag">
          {listings === 0 ? (
            <>
              Nothing is listed on Slotfill at the moment, so there is no price
              for us to report in any trade. We do not have national survey
              figures and we are not going to estimate any.
            </>
          ) : (
            <>
              These are the prices <strong>businesses on Slotfill are asking
              right now</strong> — {listings}{' '}
              {plural(listings, 'listing', 'listings')} counted the moment this
              page loaded. They are not a national average and they are not a
              survey. We do not have either of those, so we do not quote one.
              {samples > 0 && (
                <>
                  {' '}
                  {samples === listings
                    ? (listings === 1
                      ? 'That listing is a sample'
                      : `All ${listings} are sample listings`)
                    : `${samples} of them ${
                      samples === 1 ? 'is a sample listing' : 'are sample listings'}`}
                  {' '}we seeded ourselves rather than a business trading today.
                </>
              )}
            </>
          )}
        </p>

        {/*
          THIS PAGE IS THE HUB, so it has to say what it holds.

          Every cost guide now ends with a block of links into other cost
          guides and a link up to here, which only works if arriving here
          answers "and what else is there?" in one line. There is one guide per
          trade in the catalogue — including the quiet ones, because a page
          that says plainly that nothing is listed today is the honest answer
          to the question and hiding it would leave a link in the block below
          pointing at nothing.
        */}
        {rows.length > 0 && (
          <p className="ix-lede">
            One guide for every trade Slotfill lists, {rows.length} in all,
            grouped by how much is behind the figures rather than
            alphabetically. The quiet trades are here too: their pages say
            nothing is listed today rather than estimating a price.
          </p>
        )}
      </header>

      {/* The three groups below can each be a screen tall, and somebody who
          arrived from a guide's "every cost guide" link is usually after one
          of them in particular. Only the groups that exist are offered. */}
      {rows.length > 0 && (
        <nav className="ix-sec" aria-labelledby="ix-toc">
          <h2 id="ix-toc">On this page</h2>
          <ul className="ix-jump">
            {ranged.length > 0 && (
              <li><a href="#ix-ranged">Listed prices today ({ranged.length})</a></li>
            )}
            {thin.length > 0 && (
              <li><a href="#ix-thin">Too few listings to give a range ({thin.length})</a></li>
            )}
            {bare.length > 0 && (
              <li><a href="#ix-bare">Nothing listed right now ({bare.length})</a></li>
            )}
          </ul>
        </nav>
      )}

      {ranged.length > 0 && (
        <section className="ix-sec" aria-labelledby="ix-ranged">
          <h2 id="ix-ranged">Listed prices today</h2>
          <p className="ix-sec-sub">
            The cheapest and dearest of what is listed in each trade, with the
            one in the middle underneath. Press a trade for every job in it by
            name, and how long each one is listed for.
          </p>
          <ul className="ix-list">
            {ranged.map((r) => (
              <li key={r.trade.slug}>
                <Link className="ix-row ix-row-priced"
                  to={`/cost/${encodeURIComponent(r.trade.slug)}`}>
                  <span className="ix-row-text">
                    <span className="ix-row-name">{r.trade.label}</span>
                    <span className="ix-row-sub">
                      {r.n} {plural(r.n, 'listing', 'listings')} from {r.businesses}{' '}
                      {plural(r.businesses, 'business', 'businesses')}
                    </span>
                  </span>
                  {/* Both figures are counted; neither is rounded, averaged or
                      described as typical. The middle one is the figure a
                      reader should carry away, so it is named rather than left
                      to be guessed at from the range above it. */}
                  {r.currency && r.low !== null && r.high !== null && (
                    <span className="ix-range">
                      <b>
                        {r.low === r.high
                          ? money(r.low, r.currency)
                          : `${money(r.low, r.currency)} – ${money(r.high, r.currency)}`}
                      </b>
                      {r.mid !== null && (
                        <span>middle {money(r.mid, r.currency)}</span>
                      )}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {thin.length > 0 && (
        <section className="ix-sec" aria-labelledby="ix-thin">
          <h2 id="ix-thin">Too few listings to give a range</h2>
          {/*
            Two prices are two prices. Calling them a range, a spread or a
            typical cost would be inventing a pattern out of a coincidence, so
            these trades say how thin the evidence is and send you to the page
            that shows the raw listings instead.
          */}
          <p className="ix-sec-sub">
            Fewer than {ENOUGH} prices are listed in each of these at the
            moment, which is not enough to say what the work usually costs.
            Their pages show exactly what is listed, and nothing more.
          </p>
          <ul className="ix-list">
            {thin.map((r) => (
              <li key={r.trade.slug}>
                <Link className="ix-row" to={`/cost/${encodeURIComponent(r.trade.slug)}`}>
                  <span className="ix-row-text">
                    <span className="ix-row-name">{r.trade.label}</span>
                    <span className="ix-row-sub">
                      {r.n} {plural(r.n, 'price', 'prices')} listed — no range
                    </span>
                  </span>
                  <span className="ix-row-go" aria-hidden="true">›</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {bare.length > 0 && (
        <section className="ix-sec" aria-labelledby="ix-bare">
          <h2 id="ix-bare">Nothing listed right now</h2>
          <p className="ix-sec-sub">
            No prices are listed in these trades at this moment. An opening is
            an hour a business has free, so a trade can be empty one hour and
            full the next — each page below says so plainly rather than
            estimating a price from nothing, and takes an alert for when
            somebody lists one.
          </p>
          <ul className="ix-else">
            {bare.map((r) => (
              <li key={r.trade.slug}>
                <Link to={`/cost/${encodeURIComponent(r.trade.slug)}`}>
                  What {r.trade.label.toLowerCase()} costs
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/*
        Every trade in the catalogue falls into one of the three groups above,
        so this is only reachable when the catalogue itself came back empty —
        which is the catalogue failing rather than a quiet afternoon, and is
        told as that.
      */}
      {rows.length === 0 && (
        <section className="ix-sec">
          <div className="ix-empty">
            <h2>The list of trades is not available</h2>
            <p>
              We could not read the catalogue just now, so there is nothing to
              price. Nothing is wrong with your link.
            </p>
            <div className="ix-empty-do">
              <button className="btn" onClick={() => void load()}>Try again</button>
              <Link className="btn quiet" to="/">See what is open</Link>
            </div>
          </div>
        </section>
      )}

      <footer className="ix-foot">
        <p>
          Every price on this page was listed by the business that would do the
          work, and counted at the moment the page loaded. It is what they are
          asking today, not an average of the trade.
        </p>
        <p>
          <Link to="/browse">Every service</Link>
          {' · '}
          {/* Plain anchors: the Worker renders these two, they are not React
              routes. */}
          <a href="/near">Every neighbourhood</a>
          {' · '}
          <a href="/los-angeles">Mobile services in Los Angeles</a>
        </p>
      </footer>
    </PublicPage>
  );
}
