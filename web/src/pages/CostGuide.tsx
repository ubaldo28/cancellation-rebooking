import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, sentence, type MapArea, type PublicSlot, type TradeCategory } from '../api';
import Crumbs from '../components/Crumbs';
import { PAY_TODAY_SHORT } from '../components/PaymentState';
import PublicPage from '../components/PublicPage';
import PostcodeFinder from '../components/PostcodeFinder';
import { ErrorNote, Spinner } from '../components/ui';
import '../styles-trade.css';
import { ENOUGH, formatMoney as money, median } from '../lib/format';
import { nearTradeHref } from '../lib/seo';
import { useDocumentTitle } from '../lib/title';

/**
 * What one trade costs, built only out of what is actually listed.
 * Route /cost/:trade.
 *
 * The reference marketplace's cost guides are the single biggest source of
 * their search traffic, and the reason is obvious: "what does X cost" is what
 * people type. Theirs are built on a national survey of jobs booked through
 * them. We do not have a national survey, we do not have national coverage,
 * and we are not going to invent either.
 *
 * What we do have is every price every business on this site is asking for
 * this trade, live, right now. So that is the whole page. The lowest, the
 * highest and the middle of the listed prices; then each service by name with
 * what it is listed at and how long it is listed for; then the three things
 * that genuinely change what you pay here, and the questions people ask about
 * where these figures came from.
 *
 * THE SENTENCE THAT MAKES THIS PAGE HONEST is the note near the top: these are
 * asking prices from businesses on Slotfill today, not an average of the trade.
 * It is set apart from the prose so it cannot be skimmed past, and it is the
 * only reason this page is allowed to exist at all. If that sentence ever gets
 * softened into "the average cost of X is", this page becomes the thing it was
 * written to avoid.
 *
 * When there is almost nothing listed, it says so rather than computing a
 * range out of two numbers and calling it typical. Two prices are two prices.
 */

/**
 * "1 hr 30 min", because "90 min" makes a reader do the arithmetic.
 *
 * Spelled out rather than api.ts's terse "1h 30m": this is prose in a sentence
 * on a page a stranger is reading, not a figure glanced at on a dashboard.
 * seo.ts renders the server side of this page and carries the same wording.
 */
function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

/**
 * The questions a cost page gets asked, and the answers this product can
 * actually stand behind.
 *
 * Kept in one array so the block on the page and the structured data below it
 * are built from the same words — a search engine quoting an answer the page
 * does not contain is worse than emitting no structured data at all, which is
 * what this page did until now.
 *
 * WHAT IS NOT IN HERE, and must not be added: a national average, a typical
 * cost, a price range for the trade at large, or anything phrased as "expect
 * to pay". Every answer below is either a fact about how Slotfill works — the
 * up-front labour payment, the parts quote, the cancellation ladder — or a
 * statement about where the figures on this page came from. Both are
 * checkable. A survey figure would not be, because there is no survey.
 */
function faqsFor(tradeName: string): { q: string; a: string }[] {
  return [
    {
      q: `Are these average prices for ${tradeName}?`,
      a: `No. Every figure on this page is a price a business on Slotfill is `
        + `asking today for an appointment it has open, counted at the moment `
        + `the page loaded. We have no national survey for this trade and we `
        + `do not estimate one.`,
    },
    {
      q: 'Who sets these prices?',
      a: `The business doing the work. Every price here was listed by the `
        + `business whose name is on the appointment, and Slotfill does not `
        + `set or suggest any of them.`,
    },
    {
      q: 'Does the price include parts?',
      a: `It depends on the service, and the booking page says which before `
        + `you book: parts are either included in the price or quoted `
        + `separately. Where they are quoted, the business sends you a price `
        + `in your messages once they can see what is needed, and nothing is `
        + `fitted until you approve that price.`,
    },
    {
      q: 'When do I pay?',
      a: `${PAY_TODAY_SHORT} The design is that the labour is paid for here, `
        + `on the site, at the moment you book, with no cash and nothing paid `
        + `at the door — but that part is not built yet.`,
    },
    {
      q: 'Why is the same job listed at two different prices?',
      a: `Because two different businesses listed it. Each one sets its own `
        + `prices, sets aside its own amount of time for the work, and covers `
        + `its own part of the city, so the same job name can be worth `
        + `different amounts to each of them.`,
    },
    {
      q: 'What does it cost to cancel?',
      a: `Nothing today, because nothing has been paid. Once paying on the `
        + `site is switched on, cancelling close to the appointment will cost `
        + `a graduated fee: a quarter of the job inside 48 hours, three `
        + `quarters inside 12 hours, and the whole amount once they have `
        + `arrived. It works the same way in both directions — a business that `
        + `cancels on you pays the same.`,
    },
  ];
}

/**
 * JSON-LD, escaped so page data can never close the script element.
 *
 * The same four lines as the trade page's, deliberately copied rather than
 * shared. Putting it in a module both pages import would make one page's
 * bundle pull in the other's, and a five-line escape is a cheaper thing to
 * have twice than a page's worth of code to download once. HTML-escaping is
 * wrong inside a script — `&lt;` is not `<` to a JSON parser — so the three
 * dangerous characters are unicode-escaped instead, which keeps the block
 * parseable and inert as markup.
 */
function jsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

export default function CostGuide() {
  const { trade } = useParams<{ trade: string }>();
  const slug = (trade ?? '').trim().toLowerCase();

  const [slots, setSlots] = useState<PublicSlot[]>([]);
  /**
   * The neighbourhoods the same fetch returned, kept for their names.
   *
   * A row's `area_slug` is a slug and a slug is not a place name, so the block
   * at the foot of this page that sends somebody to "car wash and detailing in
   * Encino" needs the names the businesses themselves wrote. This page used to
   * throw them away because it had nowhere to put them.
   */
  const [areas, setAreas] = useState<MapArea[]>([]);
  const [located, setLocated] = useState<{ postcode: string; place: string | null } | null>(null);
  const [cats, setCats] = useState<TradeCategory[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);

  const load = useCallback(async (pc?: string) => {
    if (pc) { setLocating(true); setLocateError(null); } else { setLoading(true); setError(null); }
    try {
      const res = await api.publicMap(pc);
      setSlots(res.slots);
      setAreas(res.areas);
      setLocated(res.located);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not load the prices.';
      if (pc) setLocateError(msg); else setError(msg);
    } finally {
      setLoading(false); setLocating(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    void (async () => {
      // The full catalogue, not the public cut-down one: a trade with nothing
      // listed today still deserves its proper name and breadcrumb rather than
      // being treated as a bad link.
      try { setCats((await api.tradeCatalog()).categories); }
      catch { setCats([]); }
    })();
  }, []);

  const placeInCatalog = useMemo(() => {
    for (const c of cats ?? []) {
      const t = c.trades.find((x) => x.slug === slug);
      if (t) return { category: c, trade: t };
    }
    return null;
  }, [cats, slug]);

  /**
   * The rows in this trade as the map hands them over: one per neighbourhood
   * the opening is offered in. Only the "where is it open" block below wants
   * them that way, because that block is counting per neighbourhood.
   */
  const tagged = useMemo(() => slots.filter((s) => s.trade === slug), [slots, slug]);

  /**
   * The same trade, one row per opening.
   *
   * EVERY PRICE ON THIS PAGE IS COUNTED FROM THIS LIST AND NOT FROM `tagged`.
   * A business's whole free day has no location, so the map offers it in every
   * neighbourhood that business covers — genuinely true, and double counting
   * the moment a page adds prices up across the city. Counting the rows would
   * have said "11 businesses list this" beside a job two businesses list in
   * five areas each, and the Worker's copy of this page (seo.ts, via
   * `distinctGaps`) would have said something different on the same URL.
   */
  const inTrade = useMemo(() => {
    const seen = new Set<string>();
    return tagged.filter((s) => (seen.has(s.gap_id) ? false : (seen.add(s.gap_id), true)));
  }, [tagged]);

  // Same rule as Trade's: a slug in no catalogue with nothing listed under it
  // gets the "we do not have this trade" page, so the tab must not promise a
  // price guide that does not exist.
  useDocumentTitle(
    placeInCatalog ? `What ${placeInCatalog.trade.label.toLowerCase()} costs`
      : cats === null ? null
        : inTrade.length > 0 ? `What ${slug} costs`
          : 'Trade not listed');

  /**
   * One currency only.
   *
   * A median taken across dollars and pounds is not a price, it is an average
   * of two different units. In practice everything listed here is in one
   * currency, so this is a guard rather than a feature: take whichever
   * currency the most listings are in and report on those, so the figures at
   * the top of the page are always comparable with each other.
   */
  const currency = useMemo(() => {
    const n = new Map<string, number>();
    for (const s of inTrade) n.set(s.currency, (n.get(s.currency) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }, [inTrade]);

  const priced = useMemo(
    () => (currency ? inTrade.filter((s) => s.currency === currency) : []),
    [inTrade, currency],
  );

  const stats = useMemo(() => {
    const cents = priced.map((s) => s.price_cents).sort((a, b) => a - b);
    return {
      n: cents.length,
      low: cents[0] ?? null,
      high: cents[cents.length - 1] ?? null,
      mid: median(cents),
      businesses: new Set(priced.map((s) => s.operator_id)).size,
      // Seeded listings are real prices set by a real operator record, but they
      // are not a real business trading, so the page says how many of the rows
      // behind these figures are samples rather than quietly counting them in.
      samples: priced.filter((s) => s.is_sample).length,
    };
  }, [priced]);

  /**
   * The individual services, which is what somebody actually wants to compare.
   * Grouped by name because five businesses all listing "Full valet" is one
   * row a reader can use, and five rows they have to reconcile themselves.
   */
  const services = useMemo(() => {
    const by = new Map<string, PublicSlot[]>();
    for (const s of priced) {
      const list = by.get(s.service_name);
      if (list) list.push(s); else by.set(s.service_name, [s]);
    }
    return [...by.entries()]
      .map(([serviceName, rows]) => {
        const cents = rows.map((r) => r.price_cents).sort((a, b) => a - b);
        const mins = rows.map((r) => Math.round(r.duration_seconds / 60)).sort((a, b) => a - b);
        return {
          serviceName,
          n: rows.length,
          low: cents[0] ?? 0,
          high: cents[cents.length - 1] ?? 0,
          minMinutes: mins[0] ?? 0,
          maxMinutes: mins[mins.length - 1] ?? 0,
        };
      })
      // Cheapest first: this is a page somebody arrived on because they are
      // worried about the price, so the smallest number goes at the top.
      .sort((a, b) => a.low - b.low || a.serviceName.localeCompare(b.serviceName));
  }, [priced]);

  /**
   * The two things the sections below assert, counted rather than asserted.
   *
   * "A longer job costs more" and "every business sets its own price" are the
   * sort of sentence a cost guide writes whether or not its data shows it.
   * These are the same two claims read off the rows: the shortest and longest
   * blocks anybody has set aside for this trade, and how many job names two or
   * more businesses list at prices that are not the same. Where a count comes
   * back at nothing the sentence it would have supported is not printed.
   */
  const evidence = useMemo(() => {
    const shared = services.filter((s) => s.n > 1);
    return {
      shortest: services.reduce<number | null>(
        (m, s) => (m === null || s.minMinutes < m ? s.minMinutes : m), null),
      longest: services.reduce<number | null>(
        (m, s) => (m === null || s.maxMinutes > m ? s.maxMinutes : m), null),
      differing: shared.filter((s) => s.low !== s.high).length,
    };
  }, [services]);

  /**
   * WHERE THIS TRADE IS OPEN, counted rather than listed.
   *
   * The reference marketplace ends its cost guide with "find <trade> near
   * you", and the honest version of that here is not a promise of coverage but
   * the list of neighbourhoods that actually have an appointment open in this
   * trade at this moment, each with its own count. A neighbourhood is on the
   * list because a row said so; nowhere with nothing open is listed, because
   * the link would land on a page with nothing on it.
   *
   * A neighbourhood whose name did not come back is dropped rather than shown
   * as its slug: there is one source for these names and a shorter list is
   * better than a guessed one. Trade.tsx builds the same block the same way.
   */
  const openWhere = useMemo(() => {
    const names = new Map(areas.map((a) => [a.slug, a.name] as const));
    const n = new Map<string, number>();
    for (const s of tagged) n.set(s.area_slug, (n.get(s.area_slug) ?? 0) + 1);
    return [...n.entries()]
      .flatMap(([areaSlug, count]) => {
        const nm = names.get(areaSlug);
        return nm ? [{ slug: areaSlug, name: nm, n: count }] : [];
      })
      .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  }, [tagged, areas]);

  /**
   * How many openings each trade has, by slug, for the block of other cost
   * guides at the foot of the page.
   *
   * Deduplicated on the opening: the map offers a whole free day in every
   * neighbourhood its owner covers, so counting rows would count one
   * business's Tuesday once per area and put a number beside another trade's
   * guide that its own page would contradict. seo.ts counts the same way.
   */
  const openByTrade = useMemo(() => {
    const seen = new Set<string>();
    const n = new Map<string, number>();
    for (const s of slots) {
      if (seen.has(s.gap_id)) continue;
      seen.add(s.gap_id);
      const t = (s.trade ?? '').trim().toLowerCase();
      if (t) n.set(t, (n.get(t) ?? 0) + 1);
    }
    return n;
  }, [slots]);

  if (loading) {
    return <PublicPage className="tr-page"><Spinner label="Reading listed prices" /></PublicPage>;
  }
  if (error) {
    return (
      <PublicPage className="tr-page">
      <ErrorNote error={error} onRetry={() => void load()} />
      </PublicPage>
    );
  }

  // The catalogue's label, for the reason set out over `name` in Trade: the
  // trail, the heading and the prose all have to call this the same thing.
  const name = placeInCatalog ? placeInCatalog.trade.label : sentence(slug);
  const lower = name.toLowerCase();
  const near = located?.place ?? located?.postcode ?? null;
  const alertHref = located ? `/a?postcode=${encodeURIComponent(located.postcode)}` : '/a';
  const tradeHref = `/s/${encodeURIComponent(slug)}`;
  const cheapest = priced.reduce<PublicSlot | null>(
    (best, s) => (!best || s.price_cents < best.price_cents ? s : best), null);
  const faqs = faqsFor(lower);

  // A slug nobody lists under, and which is in no catalogue, is an old link or
  // a typo. A sentence and a way out, never a blank page.
  if (cats !== null && !placeInCatalog && inTrade.length === 0) {
    return (
      <PublicPage className="tr-page">
        {/* Nothing to put in a trail here: it would be "Slotfill" alone,
            which is the link the wordmark already is. Crumbs renders nothing
            for an empty list, so there is no call to make. */}
        <section className="tr-empty">
          <h1>We do not have this trade</h1>
          <p>
            Nothing on Slotfill is listed under that name, so there are no
            prices to report for it. Everything that is open is on the front
            page.
          </p>
          <div className="tr-empty-do">
            <Link className="btn" to="/">See what is open</Link>
          </div>
        </section>
      </PublicPage>
    );
  }

  /**
   * The other cost guides worth offering, and the counts beside them.
   *
   * The reference marketplace closes its cost guide with a block of a dozen
   * links into other cost guides, which is the single most useful thing on the
   * page for somebody who arrived on the wrong one. Ours is built from the
   * catalogue: the trades in the same category, busiest first, and the busiest
   * trades on the site for a slug the catalogue has never heard of. The number
   * is openings counted from the rows fetched a moment ago, and every opening
   * carries a price, so it is a count of what that guide will actually show.
   */
  const related = (placeInCatalog
    ? placeInCatalog.category.trades.filter((t) => t.slug !== slug)
    : (cats ?? []).flatMap((c) => c.trades).filter((t) => t.slug !== slug))
    .map((t) => ({ ...t, n: openByTrade.get(t.slug) ?? 0 }))
    .filter((t) => placeInCatalog !== null || t.n > 0)
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label))
    .slice(0, 8);

  /**
   * The table of contents, built from the sections this render actually
   * produces rather than from a written-down list.
   *
   * The page got long enough to need one — that is the whole reason the
   * reference marketplace carries one — and a contents list that offers a
   * heading the page does not contain is worse than none at all. So the
   * entries are assembled here, beside the conditions that decide whether each
   * section is drawn, and the ids are the ones those sections carry.
   */
  const toc: Array<{ id: string; label: string }> = [
    ...(stats.n >= ENOUGH ? [{ id: 'cg-range', label: 'Listed prices today' }] : []),
    ...(stats.n > 0 && stats.n < ENOUGH
      ? [{ id: 'cg-thin', label: 'Too few listings to give a range' }] : []),
    ...(services.length > 0 && currency
      ? [{ id: 'cg-svc', label: 'What each job is listed at' }] : []),
    { id: 'cg-why', label: 'What changes the price' },
    { id: 'cg-hire', label: `How to hire ${lower} on Slotfill` },
    { id: 'cg-faq', label: `Questions about what ${lower} costs` },
    { id: 'cg-near', label: `Find ${lower} near you` },
    { id: 'cg-how', label: 'How booking one works' },
    ...(related.length > 0 ? [{ id: 'cg-guides', label: 'Other cost guides' }] : []),
  ];

  return (
    <PublicPage className="tr-page">
      {/*
        THE PINNED PRICE BANNER.

        The reference marketplace opens its cost guide with the range and the
        place it is for, and keeps it in view as you read down. It is worth
        copying: the number is what the visitor came for, and the page below it
        is long. Two things are different here. It only appears once there are
        enough listings to have a range at all — under that, the page says so
        instead, and a banner would be dressing two prices up as a market. And
        it only pins itself at 760px and up, where the site bar is a single row
        of known height; below that the header wraps to two rows and a bar
        pinned under a moving target would sit over the page's own words on the
        screen with the least room to spare. It holds no control of any kind,
        so there is nothing in it for the keyboard to get caught on.
      */}
      {stats.n >= ENOUGH && currency && stats.low !== null && stats.high !== null && (
        <div className="tr-pricebar">
          <p className="tr-pricebar-in">
            <b>
              {stats.low === stats.high
                ? money(stats.low, currency)
                : `${money(stats.low, currency)} – ${money(stats.high, currency)}`}
            </b>
            {stats.mid !== null && (
              <span className="tr-pricebar-mid">middle {money(stats.mid, currency)}</span>
            )}
            <span className="tr-pricebar-where">
              {stats.n} {stats.n === 1 ? 'price' : 'prices'} listed for {lower}
              {located
                ? `, from businesses that can reach ${near}`
                : ', everywhere Slotfill covers'}
            </span>
          </p>
        </div>
      )}

      {/* One step shorter than the trail this replaced, which also carried
          the category. The parent of a cost guide is the trade it prices,
          and that page carries the category crumb itself — repeating it here
          makes the reader walk two levels to reach a page that is one link
          away. Crumbs prepends Slotfill, and emits the BreadcrumbList the
          hand-rolled markup never did. */}
      <Crumbs items={[
        { label: placeInCatalog?.trade.label ?? name, to: tradeHref },
        { label: 'Cost' },
      ]} />

      <header className="tr-head">
        <h1>
          What does {lower} cost{near ? <> near <em>{near}</em></> : null}?
        </h1>

        {/*
          WHERE THEIR BYLINE AND "LAST UPDATED" GO.

          The reference marketplace signs its cost guides with an author and a
          date, which is the right thing to do for a piece of writing somebody
          edits. Nobody edits this: it is a count taken off the listings while
          you wait. A date here would be a claim about a document that does not
          exist, so what stands in its place is the true version of the same
          promise — that the figures were fetched a second ago rather than
          filed away last winter.
        */}
        <p className="tr-asof">
          Counted live. These figures are read off the listings each time the
          page opens, so there is no author and no last-updated date to print.
        </p>

        {/*
          THE WHOLE INTEGRITY OF THE PAGE, in one paragraph, above the
          figures rather than in a footnote under them. It says exactly what
          these numbers are and exactly what they are not.
        */}
        <p className="tr-note">
          {stats.n === 0 ? (
            <>
              Nothing in this trade is listed on Slotfill at the moment, so
              there is no price for us to report. We do not have national
              survey figures and we are not going to estimate any.
            </>
          ) : (
            <>
              These are the prices <strong>{stats.businesses}{' '}
              {stats.businesses === 1 ? 'business' : 'businesses'} on Slotfill
              are asking right now</strong> for {lower} — {stats.n}{' '}
              {stats.n === 1 ? 'listing' : 'listings'} counted the moment this
              page loaded{located ? `, from businesses that can reach ${near}` : ''}.
              They are not a national average and they are not a survey. We do
              not have either of those, so we do not quote one.
              {/* "25 of the 25 are sample listings" is not a sentence
                  anybody writes. When every listing is seeded the honest and
                  shorter thing to say is that every listing is seeded. */}
              {stats.samples > 0 && (
                <>
                  {' '}
                  {stats.samples === stats.n
                    ? (stats.n === 1
                      ? 'That listing is a sample'
                      : `All ${stats.n} are sample listings`)
                    : `${stats.samples} of them ${
                      stats.samples === 1 ? 'is a sample listing' : 'are sample listings'}`}
                  {' '}we seeded ourselves rather than a business trading today.
                </>
              )}
            </>
          )}
        </p>

        <PostcodeFinder id="cg-postcode"
          label="Prices from businesses who can reach"
          locating={locating} error={locateError} near={near}
          showing="Counting only what can reach"
          onSearch={(pc) => void load(pc)}
          onClear={() => { setLocated(null); setLocateError(null); void load(); }} />
      </header>

      {/* --- the headline figures --------------------------------------- */}
      {stats.n === 0 ? (
        <section className="tr-sec">
          <div className="tr-empty">
            <h2>No prices listed for {lower} today</h2>
            <p>
              An opening here is an hour a business has free, so a trade can
              be empty one hour and full the next. Rather than estimate a
              price from nothing, we will tell you when somebody lists one.
            </p>
            <div className="tr-empty-do">
              <Link className="btn" to={alertHref}>Tell me when one appears</Link>
              <Link className="btn quiet" to="/">See every trade</Link>
            </div>
          </div>
        </section>
      ) : stats.n < ENOUGH ? (
        /*
          Two prices are two prices. Calling them a range, a spread or a
          typical cost would be inventing a pattern out of a coincidence, so
          the page says how thin the evidence is and shows the raw listings
          underneath instead.
        */
        <section className="tr-sec" aria-labelledby="cg-thin">
          <h2 id="cg-thin">Too few listings to give a range</h2>
          <p className="tr-sec-sub">
            Only {stats.n} {stats.n === 1 ? 'price is' : 'prices are'} listed for{' '}
            {lower} at the moment. That is not enough to say what the work
            usually costs, so here is exactly what is listed, and nothing more.
          </p>
        </section>
      ) : (
        <section className="tr-sec" aria-labelledby="cg-range">
          <h2 id="cg-range">Listed prices today</h2>
          <p className="tr-sec-sub">
            The cheapest and dearest of the {stats.n} listings, and the one in
            the middle.
          </p>
          <div className="tr-prices">
            {stats.low !== null && currency && (
              <div className="tr-price">
                <b>{money(stats.low, currency)}</b>
                <span>lowest listed</span>
              </div>
            )}
            {stats.mid !== null && currency && (
              <div className="tr-price mid">
                <b>{money(stats.mid, currency)}</b>
                <span>middle of the listings</span>
              </div>
            )}
            {stats.high !== null && currency && (
              <div className="tr-price">
                <b>{money(stats.high, currency)}</b>
                <span>highest listed</span>
              </div>
            )}
          </div>
        </section>
      )}

      {/* --- what is on this page ---------------------------------------
          A contents list, because the page is now long enough that the thing
          somebody came for can be three screens down. Built from `toc`, which
          is assembled next to the conditions that decide which sections exist,
          so it can never offer a heading that is not there. */}
      {stats.n > 0 && (
        <nav className="tr-sec tr-toc" aria-labelledby="cg-toc">
          <h2 id="cg-toc">On this page</h2>
          <ul>
            {toc.map((t) => (
              <li key={t.id}><a href={`#${t.id}`}>{t.label}</a></li>
            ))}
          </ul>
        </nav>
      )}

      {/* --- every service, by name ------------------------------------- */}
      {services.length > 0 && currency && (
        <section className="tr-sec" aria-labelledby="cg-svc">
          <h2 id="cg-svc">What each job is listed at</h2>
          <p className="tr-sec-sub">
            One row per service name, with what it is listed at and how long
            the business has set aside for it. Where more than one business
            lists the same job, the row shows the spread between them.
          </p>
          {/* The table has a minimum width and scrolls inside this box on a
              phone. A scroll container that only a mouse or a finger can
              reach strands anybody driving the page from the keyboard on the
              first column, so the box takes focus and says what it is. */}
          <div className="tr-table-wrap" tabIndex={0} role="group"
            aria-label={`What each ${lower} job is listed at`}>
            <table className="tr-table">
              <thead>
                <tr>
                  <th scope="col">Service</th>
                  <th scope="col">How long</th>
                  <th scope="col" className="tr-num">Listed price</th>
                </tr>
              </thead>
              <tbody>
                {services.map((s) => (
                  <tr key={s.serviceName}>
                    <th scope="row">
                      {s.serviceName}
                      {s.n > 1 && (
                        // Listings, not businesses. One business can list the
                        // same service in several of its free hours, and
                        // calling five of those "five businesses" turns a
                        // repeated row into a market. seo.ts words the same
                        // cell the same way, and this said "businesses" until
                        // the two were read side by side.
                        <span className="tr-svc-n">
                          {s.n} listings
                        </span>
                      )}
                    </th>
                    <td>
                      {s.minMinutes === s.maxMinutes
                        ? duration(s.minMinutes)
                        : `${duration(s.minMinutes)} – ${duration(s.maxMinutes)}`}
                    </td>
                    <td className="tr-num">
                      {s.low === s.high
                        ? money(s.low, currency)
                        : `${money(s.low, currency)} – ${money(s.high, currency)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* --- what actually changes the number ---------------------------
          Three things, and all three are structural facts about how this
          product works rather than received wisdom about the trade. There is
          no "expect to pay 20% more at weekends" here, because we have not
          measured that and neither has anybody else we could cite. Where the
          rows on this page can show the claim rather than only state it, the
          figure is printed and it is counted from those rows. */}
      <section className="tr-sec" aria-labelledby="cg-why">
        <h2 id="cg-why">What changes the price</h2>
        <p className="tr-sec-sub">
          Three things, and only three, because these are the only ones we can
          actually stand behind.
        </p>
        <div className="tr-drivers">
          <div className="tr-driver">
            <h3>How long the job takes</h3>
            <p>
              Every listing above is a block of a business's day with a length
              on it, set by the business rather than by us. A longer block is
              more of their day, and it is priced that way by the person whose
              day it is.
            </p>
            {/* Only when the two ends are genuinely different: printing
                "between 90 min and 90 min" to illustrate a spread would be
                using a number to say the opposite of what it says. */}
            {evidence.shortest !== null && evidence.longest !== null
              && evidence.shortest !== evidence.longest && (
              <p>
                The jobs listed above run from {duration(evidence.shortest)}{' '}
                to {duration(evidence.longest)}, which is most of why the
                prices beside them are as far apart as they are.
              </p>
            )}
            <p>
              What makes one job longer than another is the state of the thing
              being worked on, and the business is the only one who can judge
              that. So the length is part of what they listed, and you can see
              it beside every price above before you choose one.
            </p>
          </div>
          <div className="tr-driver">
            <h3>Whether it needs parts</h3>
            <p>
              Parts are handled apart from the price on the card, and the
              booking page says which way round it is for the service you are
              looking at: either parts are included in that price, or they are
              quoted separately.
            </p>
            <p>
              Where they are quoted, the price on the card is the labour, and
              the business sends you a price for the part in your messages
              once they can see what is needed. Nothing is fitted and nothing
              is ever added until you approve that price — not a rounding
              difference, and never cash at the door.
            </p>
          </div>
          <div className="tr-driver">
            <h3>Who you are booking</h3>
            <p>
              Every business on Slotfill sets its own prices, sets aside its
              own amount of time, and lists only the parts of the city it
              covers. There is no rate card here and no suggested price: two
              businesses can list the same job for different amounts and both
              of them are right about their own work.
            </p>
            {/* A sentence that opens on a digit reads as a caption rather
                than as prose, so the count is moved off the front of it. */}
            {evidence.differing > 0 && (
              <p>
                In the table above, {evidence.differing}{' '}
                {evidence.differing === 1 ? 'job name is' : 'job names are'}{' '}
                listed by more than one business at more than one price, which
                is what that looks like in practice.
              </p>
            )}
          </div>
        </div>
      </section>

      {/* --- how to hire ------------------------------------------------
          The reference marketplace's "how to hire a reliable X" is half advice
          and half a claim that its people have been checked. We check nobody,
          so every line below is a fact about what this site puts in front of
          you and what it does not — including the two places where the answer
          is that we do not know. A page whose whole argument is that its
          numbers are counted cannot then hand out advice it made up. */}
      <section className="tr-sec" aria-labelledby="cg-hire">
        <h2 id="cg-hire">How to hire {lower} on Slotfill</h2>
        <p className="tr-sec-sub">
          What there is to go on before you book, and what there is not.
        </p>
        <div className="tr-drivers">
          <div className="tr-driver">
            <h3>Read the price and the length together</h3>
            <p>
              Every listing is a block of one business's day: a price, and the
              time they have set aside for the work. The cheapest is not always
              the same job — a shorter block is less of their day — so every
              listing carries both, and the booking page shows both again
              before you commit to anything.
              {/* Deliberately not "the table above": on a trade with nothing
                  listed there is no table, and this section is drawn either
                  way because it is about how to choose rather than about
                  today's rows. */}
            </p>
          </div>
          <div className="tr-driver">
            <h3>Check what the price covers</h3>
            <p>
              The booking page says whether parts are included in the price or
              quoted separately. Where they are quoted, the price is the labour
              and the business sends you a price for the part in your messages
              once they can see what is needed; nothing is fitted until you
              approve it.
            </p>
          </div>
          <div className="tr-driver">
            <h3>Take the card at face value</h3>
            <p>
              A business is shown with a rating, a review and a count of
              completed jobs only where it has them. There is no placeholder
              for a business that has none — no stars greyed out, no "new" —
              because at scanning speed a placeholder is indistinguishable from
              a fact.
            </p>
            <p>
              Nothing on a business's page is verified by us. A licence or an
              insurance detail is what that business says about itself, and the
              issuing board's public register is the place to check one — so
              nothing here should be read as Slotfill vouching for anybody.
            </p>
          </div>
          <div className="tr-driver">
            <h3>Check who turns up</h3>
            <p>
              The business's vehicle details are shown to you in the app and the
              vehicle at your door has to match them. You give them a start code
              when they arrive, you both confirm the arrival, and photographs
              are taken before the work starts, while it is going on, and after
              it is finished.
            </p>
          </div>
        </div>
      </section>

      {/* --- the questions this page gets ------------------------------- */}
      <section className="tr-sec" aria-labelledby="cg-faq">
        <h2 id="cg-faq">Questions about what {lower} costs</h2>
        <p className="tr-sec-sub">
          Where these figures come from, and what you are actually paying for.
        </p>
        <div className="tr-faq">
          {faqs.map((f) => (
            <details className="tr-q" key={f.q}>
              <summary>{f.q}</summary>
              <p className="tr-a">{f.a}</p>
            </details>
          ))}
        </div>

        {/*
          The same six answers, for a search engine. The trade page has
          carried this since it was written and this one emitted nothing,
          which on the page most likely to be found by somebody typing "what
          does X cost" was the wrong way round. Built from the array above so
          the two can never come to say different things.
        */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: jsonLd({
              '@context': 'https://schema.org',
              '@type': 'FAQPage',
              mainEntity: faqs.map((f) => ({
                '@type': 'Question',
                name: f.q,
                acceptedAnswer: { '@type': 'Answer', text: f.a },
              })),
            }),
          }}
        />
      </section>

      {/* --- back to the listing, to a booking, and out to the map -------
          The two cross-links have always been here; what is new is the
          neighbourhood list under them, which is the thing a page called "what
          does X cost" most obviously owes the reader — a way through to the
          same trade somewhere they can name. Every one of those links goes to
          a page that has something on it, because a neighbourhood is only on
          the list if a row said an appointment is open in it. */}
      <section className="tr-sec" aria-labelledby="cg-near">
        <h2 id="cg-near">Find {lower} near you</h2>
        <p className="tr-sec-sub">
          {inTrade.length > 0
            ? 'The listing itself, and the neighbourhoods this trade is open in '
              + 'right now.'
            : 'Nothing is open in this trade at the moment, so there is one '
              + 'link here rather than a list of places with nothing in them.'}
        </p>

        <Link className="tr-cross" to={tradeHref}>
          <span className="tr-cross-t">
            <b>{name} near you</b>
            <span>
              {inTrade.length > 0
                ? `${inTrade.length} ${inTrade.length === 1 ? 'appointment' : 'appointments'}`
                  + ' open right now, with the times and the businesses.'
                : 'The listing page for this trade, and the alert if nothing is open.'}
            </span>
          </span>
          <span className="tr-cross-go" aria-hidden="true">›</span>
        </Link>

        {cheapest && currency && (
          <a className="tr-cross" href={`/book/${cheapest.gap_id}`}>
            <span className="tr-cross-t">
              <b>Book the cheapest one: {money(cheapest.price_cents, currency)}</b>
              <span>
                {cheapest.service_name} with {cheapest.business_name}, {cheapest.when}.
              </span>
            </span>
            <span className="tr-cross-go" aria-hidden="true">›</span>
          </a>
        )}

        {openWhere.length > 0 && (
          <>
            <h3 className="tr-sub-h">
              {openWhere.length === 1
                ? 'The neighbourhood it is open in'
                : `The ${openWhere.length} neighbourhoods it is open in`}
            </h3>
            {/* Plain anchors, not <Link>s: everything under /near is rendered
                by the Worker and is not a React route, so a client-side
                navigation would land on the SPA's catch-all. `nearTradeHref`
                is what mints the spelling the Worker actually answers to;
                Trade.tsx and Areas.tsx build the same links from it. */}
            <ul className="tr-tiles">
              {openWhere.map((a) => (
                <li key={a.slug}>
                  <a href={nearTradeHref(a.slug, slug)}>
                    <span className="tr-tile-name">{a.name}</span>
                    <span className="tr-tile-n">
                      {a.n} {a.n === 1 ? 'appointment' : 'appointments'}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
            <p className="tr-sec-foot">
              <a href="/near">Every neighbourhood Slotfill covers</a>
            </p>
          </>
        )}
      </section>

      {/* --- how booking one works ---------------------------------------
          Their "How it works" band, with our facts in it. Three steps, each
          one something the product does today, and the third says plainly
          which half of paying is built and which is not — the same sentence
          PaymentState hands every other page, so a reader comparing this with
          the checkout finds one story rather than two. */}
      <section className="tr-sec" aria-labelledby="cg-how">
        <h2 id="cg-how">How booking one works</h2>
        <p className="tr-sec-sub">
          Three steps, and nothing between them that needs a phone call.
        </p>
        <ol className="tr-steps">
          <li>
            <h3>Find an hour that is already free</h3>
            <span>
              Every listing on Slotfill is unbooked working time — a job that
              cancelled, or a day that did not fill. You are choosing a
              particular hour from a particular business, not asking around for
              quotes.
            </span>
          </li>
          <li>
            <h3>Book it, and it is held</h3>
            {/* This band says nothing about money on purpose. What the site
                claims about paying is one answer in the FAQ above, taken from
                PaymentState so that every surface says it in the same words; a
                second telling of it here is how a page ends up with two
                versions of one promise. */}
            <span>
              The hour comes off that business's day the moment you book it and
              stops being offered to anybody else. What happens about money is
              answered in the questions above.
            </span>
          </li>
          <li>
            <h3>They arrive, and the work is recorded</h3>
            <span>
              The vehicle at your door has to match the details you were shown,
              you give them a start code, and photographs are taken before,
              during and after the work.
            </span>
          </li>
        </ol>
      </section>

      {/* --- other cost guides ------------------------------------------- */}
      {related.length > 0 && (
        <section className="tr-sec" aria-labelledby="cg-guides">
          <h2 id="cg-guides">Other cost guides</h2>
          <p className="tr-sec-sub">
            {placeInCatalog
              ? `The rest of ${placeInCatalog.category.label.toLowerCase()}, `
                + 'priced the same way this page is.'
              : 'The trades with the most listed on Slotfill right now, priced '
                + 'the same way this page is.'}
            {' '}
            Each one counts its own figures off the businesses on Slotfill the
            moment you open it.
          </p>
          <ul className="tr-tiles">
            {related.map((t) => (
              <li key={t.slug}>
                <Link to={`/cost/${encodeURIComponent(t.slug)}`}>
                  <span className="tr-tile-name">What {t.label.toLowerCase()} costs</span>
                  <span className="tr-tile-n">
                    {t.n > 0
                      ? `${t.n} ${t.n === 1 ? 'price' : 'prices'} listed`
                      : 'nothing listed today'}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <p className="tr-sec-foot">
            <Link to="/cost">Every cost guide on Slotfill</Link>
          </p>
        </section>
      )}

      <footer className="tr-foot">
        <p>
          Every price on this page was listed by the business that would do
          the work, and counted at the moment the page loaded. It is what they
          are asking today, not an average of the trade.
        </p>
        <p>
          <Link to={tradeHref}>{name}</Link>
          {placeInCatalog && (
            <>
              {' · '}
              <Link to={`/browse/${placeInCatalog.category.key}`}>
                {placeInCatalog.category.label}
              </Link>
            </>
          )}
          {' · '}
          <Link to="/cost">Every cost guide</Link>
          {' · '}
          <Link to="/">All trades</Link>
        </p>
      </footer>
    </PublicPage>
  );
}
