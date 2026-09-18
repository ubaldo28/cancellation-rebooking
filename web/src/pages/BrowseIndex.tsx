import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type TradeCategory } from '../api';
import Crumbs from '../components/Crumbs';
// Two import lines from one module, matching Trade.tsx: see the note there.
// test/public-payload.test.ts pins the payment line character for character,
// and folding the account constant into the same braces would break a pin that
// has nothing to do with the account.
import { PAY_TODAY_SHORT } from '../components/PaymentState';
import { ACCOUNT_TODAY_SHORT } from '../components/PaymentState';
import PublicPage from '../components/PublicPage';
import { TradeArt } from '../components/TileArt';
import { ErrorNote, Spinner } from '../components/ui';
import '../styles-index.css';
import { plural } from '../lib/format';
import { useMetros } from '../lib/metros';
import { jsonLd, tradeHref } from '../lib/seo';
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
 * service is on this page because Round The Way covers that job. What is open in it
 * is a second, smaller fact, printed beside the row only once this page has
 * counted it, and stated in words when the answer is nothing.
 *
 * THE TWO MODULES AT THE FOOT, AND WHY THEY ARE ON THIS PAGE OF ALL PAGES.
 * The reference marketplace hangs a strip of steps and a block of questions off
 * every landing page it has, and this one had neither — which mattered more
 * here than anywhere, because /browse is where somebody arrives who has heard
 * of us and does not yet know what the site is. Every other door into
 * Round The Way is a door into one trade, and the trade page answers these
 * questions about that trade; this page is the door into all of them and
 * answered nothing. The words about money and accounts are the same two
 * constants the trade page, the cost guide and /help all print, so a reader
 * comparing four surfaces finds one story rather than four.
 */

/**
 * The questions this page answers, kept out of the markup so the block below
 * and the JSON-LD are built from one array and cannot drift into saying
 * different things — a search engine quoting an answer the page does not
 * contain is worse than no structured data at all. Trade.tsx holds its own
 * copy for the same reason and says so.
 *
 * These four are deliberately about the site rather than about any trade: the
 * per-trade questions belong on the per-trade page, where they can name the
 * work. Every answer is a fact about how Round The Way works today — the
 * payment answer describes the card that is charged at the moment of booking,
 * because that is what the Book button does. Nothing here about vetting,
 * insurance, licensing, guarantees or how fast anybody replies, because none
 * of that is something we could stand behind.
 */
const FAQS: { q: string; a: string }[] = [
  {
    q: 'What is an open appointment?',
    a: `Unbooked working time a local business has this week — a job that `
      + `cancelled, or a day that did not fill. You are picking a particular `
      + `hour from a particular business rather than asking around for quotes, `
      + `which is why every listing carries a time and a price before you `
      + `press anything.`,
  },
  {
    q: 'Do I need an account?',
    a: ACCOUNT_TODAY_SHORT,
  },
  {
    q: 'How do I pay?',
    a: `${PAY_TODAY_SHORT} The labour is paid for here, on the site, at the `
      + `moment you book — with no cash and nothing paid at the door.`,
  },
  {
    q: 'Who sets the prices?',
    a: `The business doing the work sets it, and every price anywhere on `
      + `Round The Way was listed by the business whose name is on the card. We `
      + `do not price anything, mark anything up or recommend a figure.`,
  },
];

export default function BrowseIndex() {
  const metros = useMetros();
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
          Every service Round The Way covers
          {shown.length > 0 && (
            <span className="ix-count">
              {shown.length} {plural(shown.length, 'category', 'categories')},{' '}
              {services} {plural(services, 'service', 'services')}
            </span>
          )}
        </h1>
        <p className="ix-lede">
          Pick the job you need doing. Everything Round The Way covers is listed
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
        shown.map((c) => {
          /*
            Openings across the whole category, added up from the per-trade
            counts the rows below are about to print. It is arithmetic a reader
            could check by hand down the page, which is the only kind of total
            this site prints, and it is null rather than nought while the map
            is still in flight — "nothing open" written over a category whose
            counts have not arrived is a claim rather than a fact.

            It is here because a reader scanning nine category headings for
            somewhere to start was being given only the size of the catalogue,
            which is the one number that never changes. Which categories have
            something in them this afternoon is the question they actually have.
          */
          const catOpen = open
            ? c.trades.reduce((sum, t) => sum + (open.get(t.slug) ?? 0), 0)
            : null;
          return (
          <section className="ix-cat" key={c.key} aria-labelledby={`ix-cat-${c.key}`}>
            {/* The heading is the link to the category's own page, which is
                the middle level of the browse and carries the same services
                with the neighbourhoods underneath them. */}
            <h2 id={`ix-cat-${c.key}`}>
              <Link to={`/browse/${c.key}`}>{c.label}</Link>
            </h2>
            <p className="ix-cat-sub">
              {c.trades.length} {plural(c.trades.length, 'service', 'services')}
              {catOpen !== null && (catOpen > 0
                ? ` · ${catOpen} ${plural(catOpen, 'appointment', 'appointments')} open now`
                : ' · none open right now')}
            </p>

            {c.trades.length > 0 ? (
              /* Whole-card links, not a label with a link inside it. On a
                 phone the thumb lands anywhere on the card and the card is
                 the target.

                 `ix-cards` is what turns this list into the grid of picture
                 tiles the page shows: the markup is the same either way, and
                 the class is what says these rows carry pictures and want to
                 be laid out as tiles rather than as a column. The Worker's
                 twin does the same thing with `class="links cards"` in
                 linkList (src/lib/seo.ts), on these same rows. */
              <ul className="ix-list ix-cards">
                {c.trades.map((t) => (
                    <li key={t.slug}>
                      <Link className="ix-row" to={tradeHref(t.slug)}>
                        {/*
                          THE PICTURE, AND WHY IT IS ON THIS PAGE.

                          This page was thirty-nine names in a column. The
                          owner asked for a picture on every trade tile, and
                          this is where the trades are — the front page has
                          only the eight categories on it. `t.art` is the path
                          the Worker computed and shipped on the catalogue
                          payload, so the same row rendered by browseIndexPage
                          in src/lib/seo.ts asks for the same file.

                          The drawing is DECORATIVE and marked so: the trade's
                          name is right beside it in the same link, and an alt
                          describing the picture would be that name read out
                          twice. TileArt.tsx holds that argument along with the
                          width, the height and the lazy loading.
                        */}
                        <TradeArt className="ix-row-art" src={t.art} />
                        {/*
                          THE NAME, AND NOTHING ELSE ON THE TILE.

                          A tile used to carry the trade's hint and a count of
                          what was free this week under the picture, in a white
                          block. Both are gone from here, deliberately: forty
                          tiles each saying "None open right now" is forty
                          repetitions of the same discouraging sentence, and it
                          is already said once, accurately, in the counted line
                          under the category's own heading. What a tile has to
                          do is name the job and look like it.

                          The name sits ON the picture — white over a gradient
                          at the foot of the tile, which the stylesheet draws.
                          The same count still reaches the trade's own page,
                          which is where somebody who pressed a tile is going.
                        */}
                        <span className="ix-row-text">
                          <span className="ix-row-name">{t.label}</span>
                        </span>
                      </Link>
                    </li>
                ))}
              </ul>
            ) : (
              /* Only reachable if the catalogue itself files no services under
                 this heading, which is a gap in the catalogue rather than a
                 quiet week. */
              <p className="ix-sec-sub">No services are listed in this category yet.</p>
            )}
          </section>
          );
        })
      )}

      {/* --- how booking one works ---------------------------------------
          Their "How it works" band, with our facts in it. Three steps, each
          one something the product does today, and the same three the cost
          guide and the trade page describe in the same words — a reader
          crossing between the three levels of this browse must not find
          booking described three ways.

          It goes after the catalogue rather than before it. Somebody who came
          here from a search for a job wants the list of jobs first and is
          entitled to leave without ever reading this; somebody who came here
          having heard the name of the site has scrolled past nine categories
          by now and is exactly the person the strip is for. */}
      <section className="ix-sec" aria-labelledby="ix-how">
        <h2 id="ix-how">How booking one works</h2>
        <p className="ix-sec-sub">
          Three steps, and nothing between them that needs a phone call.
        </p>
        <ol className="ix-steps">
          <li>
            <h3>Find an hour that is already free</h3>
            <span>
              Everything counted on this page is unbooked working time — a job
              that cancelled, or a day that did not fill. You are choosing a
              particular hour from a particular business, not asking around for
              quotes.
            </span>
          </li>
          <li>
            <h3>Book it, and it is held</h3>
            {/* Deliberately silent about money. What this site claims about
                paying is one answer in the questions below, taken from
                PaymentState so that every surface says it in the same words;
                a second telling of it here is how a page ends up with two
                versions of one promise. */}
            <span>
              The hour comes off that business's day the moment you book it and
              stops being offered to anybody else. What happens about money is
              answered in the questions below.
            </span>
          </li>
          <li>
            <h3>They arrive, and the work is recorded</h3>
            <span>
              The business drives to you. The vehicle at your door has to match
              the details you were shown, you give them a start code, and
              photographs are taken before, during and after the work.
            </span>
          </li>
        </ol>
      </section>

      {/* --- the questions --------------------------------------------- */}
      <section className="ix-sec" aria-labelledby="ix-faq">
        <h2 id="ix-faq">Questions about Round The Way</h2>
        <p className="ix-sec-sub">
          What the site is, and which parts of it are built. Anything about one
          particular job is answered on that service's own page.
        </p>
        <div className="ix-faq">
          {FAQS.map((f) => (
            <details className="ix-q" key={f.q}>
              <summary>{f.q}</summary>
              <p className="ix-a">{f.a}</p>
            </details>
          ))}
        </div>

        {/* The same answers, for a search engine. Built from the array above
            rather than written out again, so the two can never say different
            things. */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: jsonLd({
              '@context': 'https://schema.org',
              '@type': 'FAQPage',
              mainEntity: FAQS.map((f) => ({
                '@type': 'Question',
                name: f.q,
                acceptedAnswer: { '@type': 'Answer', text: f.a },
              })),
            }),
          }}
        />
      </section>

      <section className="ix-sec" aria-labelledby="ix-other">
        <h2 id="ix-other">The other way round</h2>
        <p className="ix-sec-sub">
          Round The Way can be read by the job, which is this page, or by where the
          van is.
        </p>
        <ul className="ix-else">
          {/* Plain anchors: these two are server-rendered by the Worker rather
              than being React routes, so a client-side navigation to them
              would land on the catch-all. */}
          <li><a href="/near">Browse by neighbourhood</a></li>
          {/* One row per place Round The Way serves, from the metro records. A
              literal Los Angeles row here is what silently left Santa Maria
              off every catalogue page the day it opened. */}
          {metros.map((m) => (
            <li key={m.slug}>
              <a href={m.path}>Mobile services in {m.name}</a>
            </li>
          ))}
          <li><Link to="/cost">What things cost</Link></li>
        </ul>
      </section>

      <footer className="ix-foot">
        <p>
          A service is listed here because Round The Way covers that work. Any count
          beside it was taken from the openings at the moment this page loaded.
        </p>
      </footer>
    </PublicPage>
  );
}
