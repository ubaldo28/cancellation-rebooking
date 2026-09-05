import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, sentence, type MapArea, type PublicSlot, type TradeCategory } from '../api';
import Crumbs from '../components/Crumbs';
import { PAY_TODAY_SHORT } from '../components/PaymentState';
import PublicPage from '../components/PublicPage';
import PostcodeFinder from '../components/PostcodeFinder';
import SlotCard from '../components/SlotCard';
import SlotFilters, { useSlotFilters } from '../components/SlotFilters';
import { ErrorNote, Spinner } from '../components/ui';
import '../styles-trade.css';
import { nearTradeHref } from '../lib/seo';
import { useDocumentTitle } from '../lib/title';

/**
 * One trade, everything open in it, and how booking it works. Route /s/:trade.
 *
 * This is the bottom level of the reference marketplace's browse — they give
 * every trade its own landing page and it is where most of their traffic
 * arrives, because it is the page that matches what somebody actually typed
 * into a search engine. We had a front page and a category page and then
 * nothing, so a person searching for a mobile locksmith had no door into this
 * site at all. This is that door.
 *
 * THE RULE THIS PAGE IS BUILT AROUND: no number on it is written down. The
 * business count, the number of open appointments and the lowest price are all
 * counted from the rows fetched a moment ago and about to be rendered
 * underneath, exactly the way the front page counts its facts. A landing page
 * is the first thing a stranger sees, and a first claim that turns out to be
 * untrue is the one thing they will not forgive — so there is no "over 10,000
 * happy customers" here and there never will be. When a trade is empty the
 * page says it is empty and offers the alert instead, which is a worse-looking
 * page and a better one.
 *
 * The FAQ answers are held to the same standard. Every one of them describes
 * something this product actually does — the parts quote, the start code, the
 * vehicle check, the photographs — or says plainly which part of it is not
 * built yet, which is the case for everything to do with money. See
 * PaymentState.tsx: the two answers here that touch payment take their first
 * sentence from it, so a visitor comparing this FAQ with /help or /covered
 * finds the same words rather than three versions of the same claim. Nothing
 * about insurance, licensing, vetting or response times, because none of that
 * is something we could stand behind.
 */

/**
 * How many cards go in before the visitor has to ask for more. Same figure as
 * the front page: a busy trade can be a hundred rows across the whole city,
 * and laying all of them out costs a phone a second for cards nobody reaches.
 */
const PAGE = 24;

/**
 * The FAQ copy, kept out of the markup so the block below and the JSON-LD are
 * built from one array and cannot drift into saying different things — a
 * search engine quoting an answer the page does not contain is worse than no
 * structured data at all.
 *
 * Every answer here is a fact about how Slotfill works, and each one is
 * checkable against the product. There is deliberately nothing about vetting,
 * insurance, licensing, guarantees or how fast anyone replies.
 */
function faqsFor(tradeName: string): { q: string; a: string }[] {
  return [
    {
      q: 'How do I pay?',
      a: `${PAY_TODAY_SHORT} The design is that the labour is paid for here, on `
        + `the site, at the moment you book — with no cash and nothing paid at `
        + `the door — but that part is not built yet.`,
    },
    {
      q: 'What happens if the job needs a part?',
      a: `The business sends you a price for the part in your messages. Nothing `
        + `is fitted until you approve that price, and once paying on the site `
        + `is switched on that approval is also what charges you for it.`,
    },
    {
      q: `Who sets the price for ${tradeName}?`,
      a: `The business doing the work sets it. Every price on this page was `
        + `listed by the business whose name is on the card.`,
    },
    {
      q: 'How do I know the right person has turned up?',
      a: `The business's vehicle details are shown to you in the app and the `
        + `vehicle at your door has to match them. You give them a start code `
        + `when they arrive, and you both confirm the arrival.`,
    },
    {
      q: 'Is there a record of the work?',
      a: `Photographs are taken before the work starts, while it is going on, `
        + `and after it is finished.`,
    },
    {
      q: 'What does it cost to cancel?',
      a: `Nothing today, because nothing has been paid. Once paying on the site `
        + `is switched on, cancelling close to the appointment will cost a `
        + `graduated fee: a quarter of the job inside 48 hours, three quarters `
        + `inside 12 hours, and the whole amount once they have arrived. It `
        + `works the same way in both directions — a business that cancels on `
        + `you pays the same.`,
    },
  ];
}

/**
 * JSON-LD, escaped so page data can never close the script element.
 *
 * HTML-escaping is wrong inside a script: &lt; is not < to a JSON parser, so
 * the block would stop being valid JSON. Unicode-escaping the three dangerous
 * characters keeps it parseable and inert as markup, which means a trade or
 * service name containing "</script>" ends up as text rather than as a way out
 * of the element. React would in fact set this as a text node client-side, but
 * the escape has to hold if these pages are ever pre-rendered, and a rule that
 * only holds in one rendering mode is not a rule.
 */
function jsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

export default function Trade() {
  const { trade } = useParams<{ trade: string }>();
  // The stored value on an operator row is lower case and the slug in the URL
  // may not be, so everything downstream compares against this and never the
  // raw parameter.
  const slug = (trade ?? '').trim().toLowerCase();

  const [slots, setSlots] = useState<PublicSlot[]>([]);
  /**
   * The neighbourhoods the same fetch returned, kept for their names.
   *
   * A row's `area_slug` is a slug, and a slug is not a place name. The names
   * a business wrote for its own service areas come back in `areas`, keyed by
   * that slug, so this page holds on to them rather than title-casing
   * "north-hollywood" and hoping.
   */
  const [areas, setAreas] = useState<MapArea[]>([]);
  const [located, setLocated] = useState<{ postcode: string; place: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);

  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);

  /**
   * The whole catalogue, not the cut-down public one.
   *
   * The public endpoint drops any trade nobody is currently working in, which
   * is right for a browse page that must never offer a dead end — but this
   * page has to be able to name a trade that is empty right now and still say
   * so honestly. Loading the full catalogue means an empty trade gets its
   * proper name and its proper category breadcrumb instead of being treated as
   * a typo.
   */
  const [cats, setCats] = useState<TradeCategory[] | null>(null);

  const load = useCallback(async (pc?: string) => {
    if (pc) { setLocating(true); setLocateError(null); } else { setLoading(true); setError(null); }
    try {
      const res = await api.publicMap(pc);
      setSlots(res.slots);
      setAreas(res.areas);
      setLocated(res.located);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not load what is open.';
      if (pc) setLocateError(msg); else setError(msg);
    } finally {
      setLoading(false); setLocating(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    void (async () => {
      // A failure here costs the friendly name and the breadcrumb, not the
      // page: the listing below is built from the slots, not the catalogue.
      try { setCats((await api.tradeCatalog()).categories); }
      catch { setCats([]); }
    })();
  }, []);

  // Where this trade sits in the catalogue, so the breadcrumb and the sibling
  // links at the bottom know which category they belong to.
  const placeInCatalog = useMemo(() => {
    for (const c of cats ?? []) {
      const t = c.trades.find((x) => x.slug === slug);
      if (t) return { category: c, trade: t };
    }
    return null;
  }, [cats, slug]);

  const inTrade = useMemo(() => slots.filter((s) => s.trade === slug), [slots, slug]);

  /**
   * One row per opening, whatever trade it is tagged with.
   *
   * The map offers a whole free day in every neighbourhood its owner covers,
   * because it genuinely is available in all of them — right for a map pin,
   * and double counting the moment a block on this page adds up a trade across
   * the city. So everything below that counts another trade counts openings
   * rather than rows. The Worker's copy of this page (seo.ts, `distinctGaps`)
   * has always counted them this way, and these blocks are rendered on both
   * sides of the same URL, so they have to agree.
   */
  const openings = useMemo(() => {
    const seen = new Set<string>();
    return slots.filter((s) => (seen.has(s.gap_id) ? false : (seen.add(s.gap_id), true)));
  }, [slots]);

  /** How many openings each trade has right now, by slug. */
  const openByTrade = useMemo(() => {
    const n = new Map<string, number>();
    for (const s of openings) {
      const t = (s.trade ?? '').trim().toLowerCase();
      if (t) n.set(t, (n.get(t) ?? 0) + 1);
    }
    return n;
  }, [openings]);

  /** Slug to the name the business wrote, for the cards and the block below. */
  const areaName = useMemo(
    () => new Map(areas.map((a) => [a.slug, a.name] as const)), [areas]);

  /**
   * WHERE THIS TRADE IS OPEN, counted rather than listed.
   *
   * The page could already send somebody sideways to another trade and down
   * to the cost guide, but never across to a neighbourhood — so "mobile
   * detailing in Encino", which is the thing people actually type, had no
   * page on this site to point at. These are built from the `area_slug` on
   * the rows already fetched: a neighbourhood appears here because an
   * appointment in this trade is open in it right now, and the number beside
   * it is that count and nothing else. Nowhere with nothing open is listed,
   * because the link would land on a page with nothing on it.
   *
   * A neighbourhood whose name we did not get back is dropped rather than
   * shown as its slug. There is only one source for these names and if it is
   * missing the honest thing is a shorter list, not a guessed one.
   */
  const openWhere = useMemo(() => {
    const n = new Map<string, number>();
    for (const s of inTrade) n.set(s.area_slug, (n.get(s.area_slug) ?? 0) + 1);
    return [...n.entries()]
      .flatMap(([areaSlug, count]) => {
        const name = areaName.get(areaSlug);
        return name ? [{ slug: areaSlug, name, n: count }] : [];
      })
      // Busiest first, then alphabetically, so the list reads the same way
      // twice running for two neighbourhoods with the same count.
      .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  }, [inTrade, areaName]);

  /**
   * The tab says what the page says. A slug nobody's catalogue holds and that
   * nothing is listed under renders the "we do not have this trade" branch
   * below, so titling that tab "No-such-trade openings" would promise a listing
   * page that is not there — in a bookmark or a history entry, which is exactly
   * where nobody can see the page to know better. `cats` being null means the
   * catalogue has not answered yet and neither has this.
   */
  useDocumentTitle(
    placeInCatalog ? `${placeInCatalog.trade.label} openings`
      : cats === null ? null
        : inTrade.length > 0 ? `${sentence(slug)} openings`
          : 'Trade not listed');

  /**
   * The evidence, counted from the rows about to be rendered. Nothing here is
   * a stored figure, so nothing here can be out of date or overstated.
   */
  const facts = useMemo(() => {
    const cheapest = inTrade.reduce<PublicSlot | null>(
      (best, s) => (!best || s.price_cents < best.price_cents ? s : best), null);
    return {
      open: inTrade.length,
      businesses: new Set(inTrade.map((s) => s.operator_id)).size,
      places: new Set(inTrade.map((s) => s.area_slug)).size,
      from: cheapest?.price ?? null,
    };
  }, [inTrade]);

  /**
   * The sort, the filters, and the list they produce.
   *
   * The reference marketplace's trade pages carry the same controls its browse
   * pages do, and for the same reason: this is the page most people land on, so
   * it is where somebody first wants to say "only the ones that are open" or
   * "nothing above this price". The default order is the one this page has
   * always had — closest once a postcode is in, soonest before that — because
   * that is what the hook falls back to when nobody has chosen.
   *
   * The state lives here rather than in the component so this page keeps
   * counting and paging its own list; see the note on `useSlotFilters` for why
   * a control the rows cannot answer for is never drawn.
   */
  const filters = useSlotFilters(inTrade);
  const shown = filters.shown;

  // A located list is a new list, and so is a narrowed one; without this either
  // keeps whatever page depth the previous list was scrolled to.
  useEffect(() => { setLimit(PAGE); },
    [located, filters.sort, filters.openFilter, filters.priceCap,
      filters.ratingFloor, filters.day]);

  if (loading) {
    return <PublicPage className="tr-page"><Spinner label="Finding open appointments" /></PublicPage>;
  }
  if (error) {
    return (
      <PublicPage className="tr-page">
      <ErrorNote error={error} onRetry={() => void load()} />
      </PublicPage>
    );
  }

  /**
   * ONE NAME FOR THE TRADE ON THIS PAGE.
   *
   * The breadcrumb has always used the catalogue's label and the heading used
   * the slug, so a page could open with "Car wash and detailing" in the trail
   * and "Mobile car wash and detailing" as its title — the same trade named two
   * ways, three inches apart. The label wins: it is what the category page, the
   * search results and the footer directory all print. The slug is the fallback
   * for a trade the catalogue has never heard of, which is the only case where
   * it is all we have.
   */
  const name = placeInCatalog ? placeInCatalog.trade.label : sentence(slug);
  // The same words, for the middle of a sentence.
  const lower = name.toLowerCase();
  const near = located?.place ?? located?.postcode ?? null;
  const alertHref = located ? `/a?postcode=${encodeURIComponent(located.postcode)}` : '/a';
  const faqs = faqsFor(lower);
  const visible = shown.slice(0, limit);
  // Counted from the filtered list, because it is printed next to the filtered
  // count and two numbers standing side by side are read as being about the
  // same thing.
  const shownBusinesses = new Set(shown.map((s) => s.operator_id)).size;

  // Siblings, with a live count where we have one. The count comes from the
  // same fetch as everything else, so a trade shown with a number really does
  // have that many appointments open right now. Busiest first, so the two
  // blocks built from this list lead with the trade that has something in it.
  const siblings = (placeInCatalog?.category.trades ?? [])
    .filter((t) => t.slug !== slug)
    .map((t) => ({ ...t, n: openByTrade.get(t.slug) ?? 0 }))
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));

  /**
   * The cost guides worth offering from here.
   *
   * The reference marketplace ends a trade page with a block of links into
   * five related cost guides, and it is the right idea: somebody reading a
   * listing page is one question away from "what should this cost", and the
   * neighbouring trades are the ones they are actually weighing up. Siblings
   * in the same category are that set. For a trade the catalogue has never
   * heard of there is no category to draw siblings from, so the busiest trades
   * stand in rather than the block disappearing.
   *
   * The number beside each is openings in that trade counted from the rows
   * fetched a moment ago, and every opening carries a price — so it is a count
   * of prices that guide has to show, not an estimate of anything.
   */
  const busiest = (cats ?? [])
    .flatMap((c) => c.trades)
    .filter((t) => t.slug !== slug)
    .map((t) => ({ ...t, n: openByTrade.get(t.slug) ?? 0 }))
    .filter((t) => t.n > 0)
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));

  const guides = (placeInCatalog ? siblings : busiest).slice(0, 6);
  const popular = busiest.slice(0, 6);

  /**
   * A slug that is in nobody's catalogue is an ordinary miss, not an error —
   * an old link, a guess, a typo in an email. It gets a sentence and a way
   * out, the same as an unknown category does, and never a blank page.
   */
  if (cats !== null && !placeInCatalog && facts.open === 0) {
    return (
      <PublicPage className="tr-page">
        {/*
          No breadcrumb on this branch. The trail this page used to draw here
          was the word "Slotfill" and nothing else, which is a second link to
          the page the wordmark two inches above already goes to; Crumbs
          renders nothing for an empty list for exactly that reason, so there
          is no call to make.
        */}
        <section className="tr-empty">
          <h1>We do not have this trade</h1>
          <p>
            Nothing on Slotfill is listed under that name. Everything that is
            open right now is on the front page, grouped by the kind of job
            it is.
          </p>
          <div className="tr-empty-do">
            <Link className="btn" to="/">See what is open</Link>
          </div>
        </section>
      </PublicPage>
    );
  }

  return (
    <PublicPage className="tr-page">
      {/* Crumbs prepends Slotfill itself, so the trail starts at the
          category. It also emits the BreadcrumbList the hand-rolled markup
          never did, which is the point: this is the page most search traffic
          lands on, and a trail a crawler cannot read is decoration. */}
      <Crumbs items={placeInCatalog
        ? [
          {
            label: placeInCatalog.category.label,
            to: `/browse/${placeInCatalog.category.key}`,
          },
          { label: placeInCatalog.trade.label },
        ]
        : [{ label: name }]} />

      <header className="tr-head">
        {/*
          THE COUNTED LINE ABOVE THE HEADING.

          The reference marketplace opens this page with a counted sentence
          sitting above the title — "Check out 75 house cleaners in your area"
          — and it works because the first thing on the page is evidence rather
          than a slogan. Theirs is marked up as an h2 standing above the h1,
          which puts the document's second-level heading before its first; that
          part is a mistake and is not copied. A paragraph in the same place
          looks identical and leaves the outline of the page correct.

          It is only drawn when there is something to count. On an empty trade
          the heading stands alone rather than over a nought.
        */}
        {facts.open > 0 && (
          <p className="tr-eyebrow">
            {facts.open} open {facts.open === 1 ? 'appointment' : 'appointments'}
            {near ? ` near ${near}` : ''}, from {facts.businesses}{' '}
            {facts.businesses === 1 ? 'business' : 'businesses'}
          </p>
        )}
        {/* The heading names the place the moment we know it, and says "you"
            until then. It never says a city we have not been told. */}
        <h1>{name} near <em>{near ?? 'you'}</em></h1>
        {/* Openings are unbooked working time, which arrives two ways: a job
            cancelled, or the day never filled. The sentence names both
            rather than picking the more dramatic one. */}
        <p className="tr-sub">
          These are hours a local business has free this week — a job that
          cancelled, or a day that is not full yet. Every price is set by the
          business doing the work. Booking one holds it; nothing is paid on
          this site yet, so you settle the price with the business directly.
        </p>

        {facts.open > 0 && (
          <div className="tr-stats">
            <div className="tr-stat">
              <b>{facts.businesses}</b>
              <span>{facts.businesses === 1 ? 'business listed' : 'businesses listed'}</span>
            </div>
            <div className="tr-stat">
              <b>{facts.open}</b>
              <span>
                {facts.open === 1 ? 'appointment open' : 'appointments open'}
                {located ? ' near you' : ''}
              </span>
            </div>
            {facts.from && (
              <div className="tr-stat">
                <b>{facts.from}</b>
                <span>lowest price listed</span>
              </div>
            )}
            {!located && facts.places > 0 && (
              <div className="tr-stat">
                <b>{facts.places}</b>
                <span>{facts.places === 1 ? 'neighbourhood' : 'neighbourhoods'}</span>
              </div>
            )}
          </div>
        )}

        <PostcodeFinder id="tr-postcode" label="Where are you?"
          locating={locating} error={locateError} near={near}
          showing="Showing what can reach"
          onSearch={(pc) => void load(pc)}
          onClear={() => { setLocated(null); setLocateError(null); void load(); }} />
      </header>

      {/* --- the listing ------------------------------------------------ */}
      <section className="tr-sec" aria-labelledby="tr-open">
        <h2 id="tr-open">
          {facts.open > 0
            ? `${facts.open} ${facts.open === 1 ? 'appointment' : 'appointments'} open`
            : 'Open appointments'}
        </h2>
        {/*
          THE ONE LINE ON THIS PAGE THAT FOLLOWS THE FILTERS.

          The figures in the header above describe the trade — how many
          businesses are listed in it, how many appointments it has open, what
          the cheapest of them costs — and they go on describing the trade
          whatever is set down here, because they are the claim the page makes
          to somebody who has just arrived and has touched nothing. This line
          is the other thing: it stands immediately above the cards, so it has
          to be about the cards. With a filter on it says how many of the
          trade's appointments survived it, which is why the two numbers can
          differ and why the footnote at the bottom of the page now says which
          of them is counting what.
        */}
        <p className="tr-sec-sub" aria-live="polite">
          {facts.open === 0
            ? 'Openings appear as soon as a business has an hour free.'
            : filters.filtered
              ? `Showing ${shown.length} of them, from ${shownBusinesses} `
                + `${shownBusinesses === 1 ? 'business' : 'businesses'}`
                + ` · ${filters.sortSub}.`
              : `From ${facts.businesses} `
                + `${facts.businesses === 1 ? 'business' : 'businesses'}`
                + ` · ${filters.sortSub}.`}
        </p>

        {/*
          THE HONEST EMPTY STATE. A trade with nothing in it says nothing is
          in it. There is no seeded card, no "prices from" invented out of a
          different trade, and no promise about when something will appear.
          The one useful thing we can offer is the standing alert, so that is
          what it offers.
        */}
        {facts.open === 0 ? (
          <div className="tr-empty">
            <h2>Nothing open in {lower} right now</h2>
            <p>
              {located
                ? `No one working in this trade has an appointment free near `
                  + `${near} at the moment.`
                : 'No one working in this trade has an appointment free at the moment.'}
              {' '}
              An opening appears when a job cancels or a day does not fill,
              so it arrives without warning. We can tell you when one does.
            </p>
            <div className="tr-empty-do">
              <Link className="btn" to={alertHref}>Tell me when one appears</Link>
              <Link className="btn quiet" to="/">See every trade</Link>
            </div>
          </div>
        ) : (
          <>
            <SlotFilters filters={filters} />

            {shown.length === 0 ? (
              /*
                Not the empty trade above — there is work open in this trade,
                the filters are simply standing in front of it. So the way out
                is the way back rather than an alert weeks from now, and the
                page says how much is behind them.
              */
              <div className="tr-empty">
                <h2>Nothing here matches those filters</h2>
                <p>
                  {facts.open}{' '}
                  {facts.open === 1 ? 'appointment is' : 'appointments are'} open
                  in {lower} without them.
                </p>
                <div className="tr-empty-do">
                  <button className="btn" type="button" onClick={filters.clear}>
                    Clear filters
                  </button>
                </div>
              </div>
            ) : (
              <>
                {/* The same card component the front page renders, which is
                    what the copy that used to sit here was trying to be: an
                    appointment must not look like a different object
                    depending on which page you found it on. The trade is not
                    named on it, because every card on this page is this trade
                    and the heading has already said so — thirty repetitions
                    of it would be the noisiest line on the card. */}
                <div className="slot-grid">
                  {visible.map((s) => (
                    <SlotCard key={s.gap_id} slot={s} showTrade={false}
                      area={areaName.get(s.area_slug) ?? null} />
                  ))}
                </div>
                {shown.length > limit && (
                  <div className="more">
                    <button className="btn quiet" onClick={() => setLimit((n) => n + PAGE)}>
                      Show {Math.min(PAGE, shown.length - limit)} more
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </section>

      {/* --- where this trade is open ----------------------------------- */}
      {openWhere.length > 0 && (
        <section className="tr-sec" aria-labelledby="tr-where">
          <h2 id="tr-where">Where {lower} is open right now</h2>
          <p className="tr-sec-sub">
            {openWhere.length === 1
              ? `Every appointment above is in ${openWhere[0]!.name}.`
              : `The ${openWhere.length} neighbourhoods with an appointment `
                + `open in this trade, and how many each has.`}
          </p>
          {/* Names and counts, not cards. This is a page of links out to
              somewhere narrower, and the appointments themselves are already
              laid out above — repeating them here would double the length of
              the page to say the same thing twice.

              THESE LINKS WERE BROKEN TWO SEPARATE WAYS.

              They were <Link>s. Everything under /near is rendered by the
              Worker and none of it is a React route, so a client-side
              navigation to one landed on the SPA's catch-all and bounced the
              visitor to the front page. /near itself does have a route, which
              was worse than having none: the same link rendered a different
              page depending on whether it was clicked here or in the footer.
              Discover.tsx and SiteFooter already use plain anchors and say why.

              And the address was wrong underneath that. The Worker mints
              /near/<place>/<trade> with the trade hyphenated and resolves it
              through `tradeFromSlug`, which returns null rather than guessing
              — so `encodeURIComponent('junk removal')` produced
              /near/burbank/junk%20removal, and all eight links under a busy
              trade page answered 404 to anyone who reached them. That is what
              `nearTradeHref` is for, and Areas.tsx now builds its copies of
              these same links from it too. */}
          <ul className="tr-areas">
            {openWhere.map((a) => (
              <li key={a.slug}>
                <a href={nearTradeHref(a.slug, slug)}>
                  <span className="tr-area-name">{a.name}</span>
                  <span className="tr-area-n">
                    {a.n} {a.n === 1 ? 'appointment' : 'appointments'}
                  </span>
                </a>
              </li>
            ))}
          </ul>
          <p className="tr-areas-foot">
            <a href="/near">Every neighbourhood Slotfill covers</a>
          </p>
        </section>
      )}

      {/* --- the cost guide --------------------------------------------- */}
      <Link className="tr-cross" to={`/cost/${encodeURIComponent(slug)}`}>
        <span className="tr-cross-t">
          <b>What does {lower} cost?</b>
          <span>
            Every price listed for this trade right now — the lowest, the
            highest and the middle — counted from the businesses on Slotfill.
          </span>
        </span>
        <span className="tr-cross-go" aria-hidden="true">›</span>
      </Link>

      {/* --- how booking this works ------------------------------------- */}
      <section className="tr-sec" aria-labelledby="tr-faq">
        <h2 id="tr-faq">Booking {lower} on Slotfill</h2>
        <p className="tr-sec-sub">
          What happens after you press book, and what it costs if plans change.
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
          The same six answers, for a search engine. Built from the array
          above rather than written out again, so the two can never say
          different things.
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

      {/* --- related cost information ------------------------------------
          Their block of five links into neighbouring cost guides, built from
          the catalogue rather than from an editor's list. The count beside
          each one is openings in that trade, which is also the number of
          prices the guide behind the link has to show. */}
      {guides.length > 0 && (
        <section className="tr-sec" aria-labelledby="tr-guides">
          <h2 id="tr-guides">Related cost information</h2>
          <p className="tr-sec-sub">
            What the work next to this one is listed at today. Every one of
            these pages counts its figures off the businesses on Slotfill the
            moment you open it — none of them quotes an average or a survey.
          </p>
          <ul className="tr-tiles">
            {guides.map((t) => (
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

      {/* --- the rest of the category ----------------------------------- */}
      {siblings.length > 0 && placeInCatalog && (
        <section className="tr-else">
          <h2>More in {placeInCatalog.category.label.toLowerCase()}</h2>
          <ul className="tr-else-list">
            {siblings.map((t) => (
              <li key={t.slug}>
                <Link to={`/s/${encodeURIComponent(t.slug)}`}>
                  {t.label}
                  {t.n > 0 && <span className="tr-n">{t.n}</span>}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* --- what else is open across the site ---------------------------
          THE HONEST VERSION OF "TRENDING".

          The reference marketplace ends this page with "Trending on
          Thumbtack", which is popularity data taken from what people search
          for and book. We have no such data. What we can count is how many
          appointments each trade has free at this moment, so that is what the
          heading says and that is the only claim the numbers make. Calling it
          trending, or popular, would be putting a word in front of a number
          that does not support it. */}
      {popular.length > 0 && (
        <section className="tr-sec" aria-labelledby="tr-busy">
          <h2 id="tr-busy">Most appointments open right now</h2>
          <p className="tr-sec-sub">
            The trades with the most free hours on Slotfill at this moment,
            counted from the same rows as everything else on this page. It is a
            count of what is open today, not a measure of what is popular — we
            do not have one of those.
          </p>
          <ul className="tr-tiles">
            {popular.map((t) => (
              <li key={t.slug}>
                <Link to={`/s/${encodeURIComponent(t.slug)}`}>
                  <span className="tr-tile-name">{t.label}</span>
                  <span className="tr-tile-n">
                    {t.n} {t.n === 1 ? 'appointment open' : 'appointments open'}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <p className="tr-sec-foot">
            <Link to="/browse">Every service Slotfill lists</Link>
          </p>
        </section>
      )}

      <footer className="tr-foot">
        <p>
          Every figure on this page is counted from the appointments this
          trade had open at the moment the page loaded. The figures at the top
          describe the whole trade and do not move when you sort or filter;
          the line directly above the list counts the appointments the filters
          left, which is why the two differ while one is set. Prices are set by
          the business doing the work.
        </p>
        <p>
          <Link to="/">All trades</Link>
          {placeInCatalog && (
            <>
              {' · '}
              <Link to={`/browse/${placeInCatalog.category.key}`}>
                {placeInCatalog.category.label}
              </Link>
            </>
          )}
          {' · '}
          <Link to={`/cost/${encodeURIComponent(slug)}`}>{name} prices</Link>
        </p>
      </footer>
    </PublicPage>
  );
}
