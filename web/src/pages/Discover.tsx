import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type MapArea, type PublicSlot, type TradeCategory } from '../api';
import CityMap from '../components/CityMap';
import CategoryArt from '../components/CategoryArt';
import { PAY_TODAY_SHORT } from '../components/PaymentState';
import SiteHeader from '../components/SiteHeader';
import SiteFooter from '../components/SiteFooter';
import SlotCard from '../components/SlotCard';
import SlotFilters, { useSlotFilters } from '../components/SlotFilters';
import { HowItWorks, WhyBook } from '../components/HowItWorks';
import { Icon, Spinner } from '../components/ui';
import '../styles-parts.css';
import '../styles-home.css';

/**
 * The front door.
 *
 * Whoever lands here has never heard of this and has no account. The page has
 * one job: prove that a van is already working near them this week, and show
 * what an hour of it costs — before asking for anything at all.
 *
 * The page is built as bands with different grounds, because the previous
 * version was one white sheet and every section on it weighed the same. A dark
 * hero states the offer and takes a postcode. A light browse band holds the
 * category tiles, the openings and the map. Two explainer bands carry the
 * deal. The shared footer underneath brings its own dark ground and the
 * attribution with it.
 *
 * Everything the page claims is counted from the rows it is about to render;
 * there is no number on this page that is not in the data.
 */

/**
 * How many cards go in before the visitor has to ask for more.
 *
 * The API returns up to two hundred openings and a whole free day is offered
 * in every neighbourhood the business covers, so the list can be several
 * hundred rows. Rendering all of them costs a second of layout on a phone for
 * cards nobody scrolled to.
 */
const PAGE = 24;

/** Live, because the two panes swap at a width, not on a click. */
function useMatches(query: string): boolean {
  const [on, setOn] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const sync = () => setOn(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, [query]);
  return on;
}

export default function Discover() {
  const [areas, setAreas] = useState<MapArea[]>([]);
  const [slots, setSlots] = useState<PublicSlot[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  /**
   * Seeded from ?trade= so a category page can link straight into a filtered
   * list. Read once at mount rather than kept in sync with the URL: this is a
   * starting point somebody then changes by tapping, and writing every tap
   * back into history would fill the back button with filter states.
   */
  const [trade, setTrade] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get('trade'));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);

  // Where the visitor is. Everything the product claims depends on knowing
  // this: without it the page can only list what exists, not what is close.
  const [postcode, setPostcode] = useState('');
  const [located, setLocated] = useState<{ postcode: string; place: string | null } | null>(null);
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);
  // The hero's postcode field, so the prompt at the top of the results can
  // send somebody to the box that already exists rather than growing a second
  // one that asks for the same thing in a different place.
  const postcodeRef = useRef<HTMLInputElement | null>(null);
  /**
   * Whether the visitor has waved away the "tell us where you are" prompt.
   *
   * Kept in memory and never written anywhere. A dismissal is a small thing
   * and storing it would mean asking a stranger's browser to remember a
   * decision they made in one second; the honest cost of not storing it is
   * that a fresh visit asks once more, which is the same thing a shop assistant
   * does. It is also never reset, so somebody who dismisses it, gives a
   * postcode and then clears it again is not asked a second time.
   */
  const [gateOff, setGateOff] = useState(false);

  const wide = useMatches('(min-width: 960px)');
  const [pane, setPane] = useState<'list' | 'map'>('list');
  const browseTop = useRef<HTMLDivElement | null>(null);
  // Swapping panes without this leaves the one that was asked for below the
  // fold, so the control looks like it did nothing.
  const swap = (to: 'list' | 'map') => {
    setPane(to);
    browseTop.current?.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto' : 'smooth',
      block: 'start',
    });
  };

  const load = useCallback(async (pc?: string) => {
    if (pc) { setLocating(true); setLocateError(null); } else { setLoading(true); setError(null); }
    try {
      const res = await api.publicMap(pc);
      setAreas(res.areas);
      setSlots(res.slots);
      setLocated(res.located);
      // Land on wherever is closest to them, not wherever happens to be first.
      setSelected((res.areas.find((a) => a.slot_count > 0) ?? res.areas[0])?.slug ?? null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not load the map.';
      if (pc) setLocateError(msg); else setError(msg);
    } finally {
      setLoading(false); setLocating(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Every trade with something open somewhere, biggest first, so the filter never
  // offers a category that would come back empty and the ones worth tapping
  // are reachable without scrolling.
  const trades = useMemo(() => {
    const n = new Map<string, number>();
    for (const s of slots) if (s.trade) n.set(s.trade, (n.get(s.trade) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [slots]);

  /**
   * THE WHOLE CATALOGUE, NOT THE PART OF IT SOMEBODY HAPPENS TO BE WORKING IN
   * TODAY.
   *
   * This used to fetch the trimmed catalogue -- categories with a live
   * business in them, trades with something open right now -- and the result
   * was a site that showed four categories out of eight and a handful of
   * trades out of forty-three. Half the product was invisible to a visitor and
   * to a search engine, and it went invisible for the worst possible reason:
   * that nobody had signed up in it yet, which is exactly when a marketplace
   * most needs to look like it covers the work.
   *
   * The reference marketplace lists every category and every service it knows
   * about whether or not anybody is free this minute, because the catalogue is
   * a statement of what the site is for, not a report on today's inventory.
   * Ours does the same now. The count on a tile is still the honest number of
   * appointments open in it, including zero -- a category with nothing open
   * says so on the page it leads to rather than being hidden.
   */
  const [cats, setCats] = useState<TradeCategory[]>([]);
  useEffect(() => {
    void (async () => {
      try { setCats((await api.tradeCatalog()).categories); }
      catch { /* the flat tiles below still work without it */ }
    })();
  }, []);

  const grouped = useMemo(() => {
    const n = new Map(trades);
    return cats.map((c) => ({
      ...c,
      trades: c.trades.map((t) => ({ ...t, n: n.get(t.slug) ?? 0 })),
    }));
  }, [cats, trades]);

  const inTrade = useMemo(
    () => (trade ? slots.filter((s) => s.trade === trade) : slots),
    [slots, trade],
  );

  // Areas are recounted against the chosen trade. Showing "3" on a pin and
  // then nothing in the list is the kind of thing that loses a visitor.
  //
  // Deliberately not recounted against the sort-and-filter row below. A chip
  // answers "what is open over there", which is a question about the
  // neighbourhood and not about the filters somebody has set for the one they
  // are standing in; and the effect further down that moves you off an emptied
  // neighbourhood would otherwise teleport you across town the moment you ticked
  // "open now". When a filter does empty the list, the list says so itself and
  // offers the way back.
  const counted = useMemo(() => areas.map((a) => {
    const mine = inTrade.filter((s) => s.area_slug === a.slug);
    const cheapest = mine.reduce<PublicSlot | null>(
      (best, s) => (!best || s.price_cents < best.price_cents ? s : best), null);
    return { ...a, slot_count: mine.length, from_price: cheapest?.price ?? a.from_price };
  }), [areas, inTrade]);

  // The server orders areas by distance once it knows where the visitor is, so
  // that order is kept. Filtering to one trade empties some of them, and an
  // empty chip in the middle of the rail buries the ones worth tapping, so
  // those sink to the end. Sort is stable, so distance survives underneath.
  const shownAreas = useMemo(
    () => (trade
      ? [...counted].sort((a, b) => Number(b.slot_count > 0) - Number(a.slot_count > 0))
      : counted),
    [counted, trade],
  );

  // Picking a trade can empty the neighbourhood the visitor is standing in.
  // Leaving them on it shows an empty list next to a map full of pins.
  useEffect(() => {
    const here = shownAreas.find((a) => a.slug === selected);
    if (!here || here.slot_count > 0) return;
    const next = shownAreas.find((a) => a.slot_count > 0);
    if (next) setSelected(next.slug);
  }, [shownAreas, selected]);

  const area = shownAreas.find((a) => a.slug === selected) ?? null;

  /** Everything open here, before a single filter has had a say. */
  const pool = useMemo(
    () => inTrade.filter((s) => s.area_slug === selected),
    [inTrade, selected],
  );

  /**
   * The sort and the filters, and the list they produce.
   *
   * The state is held here rather than inside SlotFilters because this page
   * does more with the result than render it: the count and the business count
   * in the heading below are taken from `filters.shown`, and so is the paging.
   * The component draws the controls and reports what was pressed; which
   * controls it is allowed to draw is worked out from these rows, and the note
   * on `useSlotFilters` explains why a control that cannot divide them is never
   * drawn at all.
   */
  const filters = useSlotFilters(pool);
  const { shown, sort, filtered } = filters;

  // A new list is a new list. Without this, changing trade — or narrowing the
  // one you are looking at — keeps whatever page depth the last one was
  // scrolled to, and "Show 24 more" ends up offering rows that are already up.
  // Every control the hook offers has to be listed: `filters.day` was added to
  // the row and not to this array, so picking a day left the paging where the
  // whole week had put it while Trade.tsx, which did list it, reset properly.
  useEffect(() => { setLimit(PAGE); },
    [selected, trade, sort, filters.openFilter, filters.priceCap,
      filters.ratingFloor, filters.day]);

  const totalOpen = inTrade.length;

  // Proof, counted from the rows above. Nothing here is written down, so
  // nothing here can be wrong.
  const facts = useMemo(() => {
    const cheapest = inTrade.reduce<PublicSlot | null>(
      (best, s) => (!best || s.price_cents < best.price_cents ? s : best), null);
    const detours = inTrade
      .map((s) => s.detour_minutes)
      .filter((n): n is number => n !== null);
    return {
      places: counted.filter((a) => a.slot_count > 0).length,
      businesses: new Set(inTrade.map((s) => s.operator_id)).size,
      from: cheapest?.price ?? null,
      nearest: detours.length ? Math.min(...detours) : null,
    };
  }, [inTrade, counted]);

  /**
   * The whole city, counted across every trade rather than the one somebody
   * has filtered to.
   *
   * `counted` above is recounted against the chosen trade, which is right for
   * the rail and the map — those answer "what is open over there in the thing
   * I am looking for". The geography band answers a different question, "does
   * this site work where I live", and narrowing it by a filter would tell a
   * visitor who tapped "locksmiths" that Slotfill covers four neighbourhoods.
   * Counted from `slots`, like everything else here; nothing is written down.
   */
  const cityAreas = useMemo(() => {
    const n = new Map<string, number>();
    for (const s of slots) n.set(s.area_slug, (n.get(s.area_slug) ?? 0) + 1);
    return areas.map((a) => ({ slug: a.slug, name: a.name, n: n.get(a.slug) ?? 0 }));
  }, [areas, slots]);

  const near = located?.place ?? located?.postcode ?? null;
  const visible = shown.slice(0, limit);

  // Counted from the filtered list rather than from the trade, because it is
  // printed next to the filtered count and two numbers standing side by side
  // are read as being about the same thing.
  const shownBusinesses = useMemo(
    () => new Set(shown.map((s) => s.operator_id)).size, [shown]);

  /**
   * Sends the visitor to the postcode field in the hero.
   *
   * Focus on its own scrolls the field into view, but the browser puts it
   * wherever it likes — usually jammed against the top of the window under the
   * sticky bar — so the scroll is asked for first and the focus is told not to
   * repeat it.
   */
  const askPostcode = () => {
    const el = postcodeRef.current;
    if (!el) return;
    el.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto' : 'smooth',
      block: 'center',
    });
    el.focus({ preventScroll: true });
  };

  return (
    <div className="land land-home">
      {/* The same bar as every other page, search box and all. It used to be
          written out here and nowhere else, which meant the front page was the
          only page on the site you could start a search from. */}
      <SiteHeader />

      {/*
        The four bands are the page; the bar above and the foot below are the
        furniture. Wrapping them in <main> is what gives the skip link in the
        header somewhere to land, and it is the landmark a screen reader user
        jumps to instead of walking the eight category tiles and the
        neighbourhood rail on every visit. It is a bare wrapper with no styles
        of its own — `.land` is a flex column and none of the bands grow, so
        collecting them into one flex item changes nothing about the layout.
      */}
      <main id="main" tabIndex={-1}>
      {/* --- band one: the offer, on a ground dark enough to be a thing ---- */}
      <section className="hero-band">
        <div className="wrap-wide">
          <div className="hero">
            {/* Two different facts, not the same one twice: once a postcode
                is in, the panel below already counts the hours. */}
            {totalOpen > 0 && (
              <span className="live">
                <i />
                {located
                  ? `${facts.businesses} ${facts.businesses === 1 ? 'business' : 'businesses'}`
                    + ' can reach you'
                  : `${totalOpen} ${totalOpen === 1 ? 'appointment' : 'appointments'} open in `
                    + `${facts.places} ${facts.places === 1 ? 'neighbourhood' : 'neighbourhoods'}`}
              </span>
            )}

            {/* Says only what the data can back. The old headline promised a
                van on your street and a lower price; neither is something we
                know, and a first claim that turns out to be untrue is the one
                thing a stranger will not forgive. */}
            {/* Customer language. "Hours" is how an operator thinks about
                their own day; a customer thinks about getting an appointment. */}
            <h1>Someone is free <em>near you</em> this week.</h1>
            <p className="hero-sub">
              Detailers, junk removal, locksmiths, mobile mechanics, phone repair and more.
              When a job cancels, that appointment opens up — and if they are
              already working nearby, it is a short trip for them. Every price
              here is set by the business doing the work.
            </p>

            {/* One pill, one action: the field and the button share a single
                rounded container so it reads as a search, not a form. */}
            <div className="hero-find">
              <label className="finder-label" htmlFor="postcode">
                Where are you?
              </label>
              <form className="finder" onSubmit={(e) => {
                e.preventDefault();
                const pc = postcode.trim();
                if (pc) void load(pc);
              }}>
                <span className="finder-pin" aria-hidden="true">
                  <Icon name="pin" size={20} />
                </span>
                <input id="postcode" ref={postcodeRef} value={postcode}
                  onChange={(e) => setPostcode(e.target.value)}
                  placeholder="Postcode or ZIP" autoComplete="postal-code"
                  inputMode="text" />
                <button className="finder-go" type="submit"
                  disabled={locating || !postcode.trim()}>
                  {locating ? 'Looking…' : 'Search'}
                </button>
              </form>
              {/* Six words under a search box, so it says the two things that
                  are true and drops the third. "Pay when you book" was a
                  promise about a payment step that does not exist, made in the
                  first thing a stranger reads. */}
              <p className="finder-note">
                No account. No app. No card.
              </p>
            </div>

            {locateError && <p className="hero-warn" role="status">{locateError}</p>}

            {located && (
              // role="status", like the warning above it. A postcode recounts
              // the whole page without navigating, and this is the line that
              // says where it decided "here" is.
              <div className="located" role="status">
                <Icon name="pin" size={16} />
                <span>Near <strong>{near}</strong></span>
                <button type="button" onClick={() => {
                  setPostcode(''); setLocated(null); setLocateError(null); void load();
                }}>
                  Change
                </button>
              </div>
            )}

            {totalOpen > 0 && (
              <div className="facts">
                <div className="fact">
                  <b>{totalOpen}</b>
                  <span>{located ? 'open near you' : 'appointments open'}</span>
                </div>
                {located && facts.nearest !== null ? (
                  <div className="fact">
                    <b>{facts.nearest} min</b>
                    <span>extra driving, closest one</span>
                  </div>
                ) : (
                  <div className="fact">
                    <b>{facts.places}</b>
                    <span>neighbourhoods covered</span>
                  </div>
                )}
                {facts.from && (
                  <div className="fact">
                    <b>{facts.from}</b>
                    <span>lowest price listed</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* --- band two: what is open, and where -------------------------- */}
      <section className="browse-band">
        <div className="wrap-wide">
          {loading && <Spinner label="Finding open appointments" />}
          {error && (
            <div className="blank" style={{ marginTop: 40 }}>
              {error}
              <div style={{ marginTop: 14 }}>
                <button className="btn sm" onClick={() => void load()}>Try again</button>
              </div>
            </div>
          )}

          {!loading && !error && (
            <>
              {/* CATEGORIES, NOT TRADES.
                  This used to render every trade on the site at once, as a
                  wall of expandable groups, and it was a mess: somebody
                  wanting their car washed had to read past mobile bookstores
                  to find it. Pressing a category now takes you to that
                  category's own page -- two clean levels, the way the
                  reference marketplace does it. */}
              {grouped.length > 0 && (
                <section className="tiles-band" aria-labelledby="pick-cat">
                  <h2 className="band-title" id="pick-cat">What do you need doing?</h2>
                  {/* The old line said every tile counts what is open, which
                      stopped being true the moment the tiles became the whole
                      catalogue rather than today's inventory. */}
                  <p className="band-sub">
                    Everything Slotfill covers. The number is what is open right now.
                  </p>
                  <div className="cat-tiles" role="group" aria-label="Browse by category">
                    {grouped.map((c) => {
                      const n = c.trades.reduce((a, t) => a + t.n, 0);
                      return (
                        <Link key={c.key} to={`/browse/${c.key}`} className="cat-tile">
                          <span className="cat-tile-art"><CategoryArt category={c.key} /></span>
                          <span className="cat-tile-body">
                            <span className="cat-tile-name">{c.label}</span>
                            {/* The count is what is open, so a category
                                nobody is working in today prints nothing
                                rather than a nought. The tile still leads
                                somewhere real: the category page lists every
                                service in it and says plainly which ones have
                                nothing open. */}
                            {n > 0 && <span className="cat-tile-n">{n}</span>}
                          </span>
                        </Link>
                      );
                    })}
                    {/* Everything last, not first: it is the fallback for
                        somebody whose job does not fit a heading, not the
                        thing most people want. */}
                    {/* aria-pressed, because this is the one tile in the grid
                        that toggles rather than navigates, and until now the
                        only thing saying it was on was the colour of its
                        border. The other tiles are links and have no state to
                        report. */}
                    <button type="button" aria-pressed={trade === null}
                      className={`cat-tile${trade === null ? ' on' : ''}`}
                      onClick={() => setTrade(null)}>
                      <span className="cat-tile-art"><CategoryArt category={null} /></span>
                      <span className="cat-tile-body">
                        <span className="cat-tile-name">Everything</span>
                        <span className="cat-tile-n">{slots.length}</span>
                      </span>
                    </button>
                  </div>

                  {/* The chosen trade stays visible and clearable, so somebody
                      who arrived from a category page is never stuck looking
                      at a filtered list with no way out of it. */}
                  {trade && (
                    <p className="cat-active">
                      Showing <strong>{trade}</strong>
                      <button type="button" className="linkish"
                        onClick={() => setTrade(null)}>Clear</button>
                    </p>
                  )}
                </section>
              )}

              <section className="browse">
                {shownAreas.length > 1 && (
                  <div className="rail" role="group" aria-label="Filter by neighbourhood">
                    {shownAreas.map((a) => (
                      <button key={a.slug} type="button" aria-pressed={a.slug === selected}
                        className={`area-chip${a.slug === selected ? ' on' : ''}`
                          + (a.slot_count === 0 ? ' none' : '')}
                        onClick={() => setSelected(a.slug)}>
                        {a.name}
                        {a.slot_count > 0 && <span className="area-n">{a.slot_count}</span>}
                      </button>
                    ))}
                  </div>
                )}

                <div className="browse-head" ref={browseTop}>
                  <div>
                    <h2>{area ? area.name : 'Open appointments'}</h2>
                    {/* Counted from the rows immediately below, filters and
                        all, which is why the business count comes from `shown`
                        and not from the whole trade: with a filter on, the two
                        are different numbers and only one of them is about the
                        list the visitor is looking at. */}
                    <p className="browse-sub" aria-live="polite">
                      {shown.length === 0
                        ? (filtered ? 'Nothing here matches those filters' : 'Nothing open here yet')
                        : `${shown.length} ${shown.length === 1 ? 'appointment' : 'appointments'} `
                          + `from ${shownBusinesses} `
                          + `${shownBusinesses === 1 ? 'business' : 'businesses'}`
                          + ` · ${filters.sortSub}`}
                    </p>
                  </div>
                  <div className="seg" role="group" aria-label="Map size">
                    <button type="button" aria-pressed={pane === 'list'}
                      onClick={() => swap('list')}>Small map</button>
                    <button type="button" aria-pressed={pane === 'map'}
                      onClick={() => swap('map')}>Big map</button>
                  </div>
                </div>

                <div className="browse-grid">
                  <div className="list-col">
                    {/* THE ASK FOR A POSTCODE.
                        The reference marketplace stops the visitor at the door
                        and makes them confirm where they are before it will
                        show anybody. We do not: the list works without it, and
                        a wall in front of the one thing this page exists to
                        show is a wall a stranger walks away from. What is
                        worth saying is why the box in the hero is worth
                        filling in, said once, next to the list it would
                        change — and it points at that box rather than adding a
                        second one, because two fields asking the same question
                        is a page arguing with itself. */}
                    {!located && !gateOff && (
                      <div className="gate">
                        <p className="gate-p">
                          <strong>Tell us where you are.</strong> A postcode is what
                          lets this list put the businesses with the shortest trip
                          to you first, and say which of them can reach you at all.
                          Without one, all this page can order by is what starts
                          soonest. No account, and nothing else is asked for.
                        </p>
                        <div className="gate-do">
                          <button type="button" className="btn sm" onClick={askPostcode}>
                            Add a postcode
                          </button>
                          {/* Dismissible without answering, and it stays
                              dismissed. Being asked twice for something you
                              have already declined once is how a site teaches
                              somebody to ignore everything it says. */}
                          <button type="button" className="linkish"
                            onClick={() => setGateOff(true)}>
                            Not now
                          </button>
                        </div>
                      </div>
                    )}

                    {/* SORT AND FILTER.
                        Only the controls this particular set of rows can
                        answer for are drawn; the component renders nothing at
                        all when there is nothing here to sort. */}
                    <SlotFilters filters={filters} />


                    {shown.length === 0 ? (
                      filtered ? (
                        // Not the same dead end as an empty neighbourhood: there
                        // is something here, the filters are simply in front of
                        // it, so the way out is the way back rather than an
                        // email alert weeks from now.
                        <div className="blank">
                          Nothing here matches those filters.
                          {' '}
                          {pool.length} {pool.length === 1 ? 'appointment is' : 'appointments are'}
                          {' '}open in {area ? area.name : 'this neighbourhood'} without them.
                          <div style={{ marginTop: 14 }}>
                            <button className="btn sm" onClick={filters.clear}>
                              Clear filters
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="blank">
                          Nothing open here in the next few days. Openings appear the
                          moment a job cancels.
                          <div style={{ marginTop: 14 }}>
                            <Link className="btn sm" to={located ? `/a?postcode=${encodeURIComponent(located.postcode)}` : '/a'}>
                              Tell me when one appears
                            </Link>
                          </div>
                          {trade && (
                            <div style={{ marginTop: 14 }}>
                              <button className="btn quiet sm" onClick={() => setTrade(null)}>
                                Show every trade
                              </button>
                            </div>
                          )}
                        </div>
                      )
                    ) : (
                      <>
                        <div className="slot-grid">
                          {/* The whole card, rating and review line and all,
                              is SlotCard — the same component the trade page
                              and the search results render, so an appointment
                              is the same object wherever it is found. */}
                          {visible.map((s) => (
                            <SlotCard key={s.gap_id} slot={s} showTrade />
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
                    {area && shown.length > 0 && (
                      <p className="browse-sub" style={{ paddingTop: 14 }}>
                        <a href={`/near/${area.slug}`}>
                          Everything open in {area.name}
                        </a>
                      </p>
                    )}
                  </div>

                  <div className={`map-col${pane === 'map' && !wide ? ' map-big' : ''}`}>
                    {/* Mounted once and never torn down. The Small/Big control
                        above resizes the pane it sits in; unmounting MapLibre to
                        hide it would mean a fresh style download and a fresh
                        fitBounds every time somebody tapped between the two, and
                        hiding the map behind a toggle at all was tried once and
                        read as the map having been removed. The two pieces of
                        state that used to gate this — a `showMap` constant that
                        was always true and a `mapLive` latch that started true
                        and could never be unset — are gone with it. */}
                    <div className="map-shell">
                      <CityMap areas={shownAreas} selected={selected} onSelect={setSelected} />
                      <span className="map-hint">Pick a neighbourhood</span>
                    </div>
                  </div>
                </div>
              </section>
            </>
          )}
        </div>
      </section>

      {/* The three steps and the three promises, in the shape the reference
          marketplace arranged them: a band each, one heading and one short
          paragraph per item, nothing competing for attention. */}
      <HowItWorks />
      <WhyBook />

      {/*
        THE ORDER OF THE FOUR BANDS BELOW is the reference marketplace's, and
        the order is the argument: who these people are, then what the site
        does about it, then whether it reaches your street, then — once a
        customer has been answered — the ask aimed at the other side of the
        market. Moving the pro recruitment up would put a "list your van"
        pitch in front of somebody still deciding whether to book one.
      */}
      <WhoBand />
      <CoveredBand />
      <PlacesBand areas={cityAreas} />
      <ProsBand />

      {/*
        NO TESTIMONIALS BAND, and this is deliberate rather than unfinished.

        The reference marketplace ends its home page with three customer
        quotes, and it is the one band on it we cannot have: Slotfill has no
        customers to quote. Writing three anyway — from an imagined persona,
        from a member of the team, from a seeded listing — would be inventing
        the single piece of evidence a stranger weighs most heavily, on the
        page where they decide whether this is real. It would also contradict
        the rest of this file, where every number is counted from rows fetched
        a moment ago precisely so that nothing here can turn out to be untrue.
        Real reviews already exist in the product and they appear on the
        cards, on the profiles and on the trade pages, written by people who
        booked and paid for that appointment; when there are enough of them to
        show three on a front page, they can be pulled from the database and
        counted like everything else. Until then this space stays empty.
      */}
      </main>

      {/*
        THE THIRD STEPS BAND WAS DELETED HERE, and it is worth saying why so
        nobody puts it back. The page carried two explanations of the same
        thing, one after the other: "How it works" from HowItWorks, and then
        "How this works" saying it again in different words. A visitor who
        reads the first one and then meets a second heading that looks almost
        identical does not read more carefully, they stop reading. The parts
        promise that lived in its third step -- nothing fitted or charged
        until you approve the price -- is already made by HowItWorks' third
        step and by WhyBook's first, so nothing true was lost.
      */}

      {/*
        The foot of every page, and the licence condition at the bottom of it.
        This was forty lines of directory written out inline, which meant the
        only page on the site with a footer was this one; the same markup now
        lives in SiteFooter and every page gets it by rendering one tag. The
        trade counts still come from here, because this is the only page that
        has the whole slot list in hand to count them from. The neighbourhoods
        are passed for a different reason now that SiteFooter can fetch its
        own: this page has already loaded the map, and these rows are ordered
        by distance from whatever postcode the visitor gave, so handing them
        over saves a second copy of the heaviest public request on the site
        and produces a better-ordered column than a fresh fetch would.
      */}
      <SiteFooter trades={trades} areas={areas} />
    </div>
  );
}

/* ==========================================================================
   The four bands under the explainers.
   ========================================================================== */

/**
 * WHO YOU ARE ACTUALLY BOOKING.
 *
 * The reference marketplace puts "Wait, what's a pro?" third on its home
 * page, before it says anything about what it covers, and the sequence is
 * right: a stranger cannot judge a promise about a transaction until they
 * know who is on the other end of it.
 *
 * Ours has to say something less flattering than theirs, and says it: nobody
 * here is vetted. That sentence costs bookings and it is not negotiable —
 * /covered and /safety both say it in as many words, and a front page that
 * implied otherwise would be the one page on the site contradicting the rest.
 * The line about the reviews and the vehicle is what stops the paragraph
 * being only a disclaimer: those are the two things that are checked, and
 * both are enforced in the product rather than promised here.
 */
function WhoBand() {
  return (
    <section className="who-band" aria-labelledby="who-title">
      <div className="band-wrap">
        <h2 className="band-h" id="who-title">Who is on the other end of this?</h2>
        <div className="band-cols">
          <p>
            One person, one van. Every business listed here is a solo trade
            working out of their own vehicle: they set their own prices,
            choose the neighbourhoods they will drive to, and decide which
            hours of their week to put up. There is no shop to visit and
            nobody in the middle taking the job and passing it on — the person
            you book is the person who knocks.
          </p>
          <p>
            Slotfill does not vet them. There is no interview, no reference
            check and no identity check: a business gives an email address, a
            business name, a vehicle and a card, and that is the whole of it.
            What the site does instead is make each one answerable — the
            reviews on a card were written by people who booked that
            appointment and had the work done, and the vehicle that turns up
            has to match the one on the listing.
          </p>
        </div>
        <p className="band-more">
          <Link to="/pros">How Slotfill works for a business</Link>
        </p>
      </div>
    </section>
  );
}

/**
 * WHAT IS COVERED — and not one word of it is a guarantee.
 *
 * The reference marketplace's band here is "The Thumbtack Guarantee", and
 * that is exactly what this one may not be. There is no fund, no claims
 * process and no insurance behind any of this; there are five mechanisms
 * that run in the product, and this band lists those five and nothing else.
 *
 * The wording is deliberately the wording of the FAQ on the trade page
 * (`faqsFor` in Trade.tsx) and of /covered. A visitor who reads this band and
 * then reads either of those must not find the site describing itself two
 * different ways — the moment the same promise is phrased twice, a reader
 * starts working out which version is the true one, and by then it does not
 * matter what the answer is. That is not a hypothetical: the first item here
 * used to be headed "You pay when you book, not at the door" while the
 * checkout it leads to said no money is taken, and the two pages were three
 * clicks apart. The payment item now takes its sentence from PaymentState.tsx
 * so it cannot say anything the checkout does not.
 */
const COVERED = [
  {
    title: 'Nothing is paid on this site yet',
    body:
      `${PAY_TODAY_SHORT} Paying here at the moment you book is the design, `
      + 'and it is not built.',
  },
  {
    title: 'Parts are approved before they are fitted',
    body:
      'If the job turns out to need a part, the business sends you a price '
      + 'for it in your messages, and nothing is fitted until you approve that '
      + 'price.',
  },
  {
    title: 'The van has to match',
    body:
      'The business’s vehicle details are shown to you before anyone '
      + 'sets off, and the vehicle at your door either matches them or it is '
      + 'not the booking you made.',
  },
  {
    title: 'A start code, given by you',
    body:
      'You give them a start code when they arrive, and you both confirm the '
      + 'arrival. The job does not start on somebody’s say-so.',
  },
  {
    title: 'Photographs, before and after',
    body:
      'Photographs are taken before the work starts, while it is going on, '
      + 'and after it is finished, so what was done is a record rather than a '
      + 'disagreement.',
  },
];

function CoveredBand() {
  return (
    <section className="covered-band" aria-labelledby="covered-title">
      <div className="band-wrap">
        <h2 className="band-h" id="covered-title">What is covered</h2>
        {/* The first sentence, before the list, because a band headed "what
            is covered" that opens with five reassuring items reads as a
            guarantee whatever the small print at the bottom says. */}
        <p className="band-lede">
          Slotfill is not an insurer and none of this is a guarantee. It is
          the list of things the site actually does to make a booking between
          two strangers safer to make.
        </p>
        <ul className="covered-list">
          {COVERED.map((item) => (
            <li key={item.title}>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </li>
          ))}
        </ul>
        <p className="band-more">
          <Link to="/covered">What is covered, and what is not</Link>
        </p>
      </div>
    </section>
  );
}

/**
 * WHERE THIS WORKS.
 *
 * The reference marketplace's band in this position is "All 50 states", and
 * the honest version of it for a product that covers one city is one city.
 * The neighbourhoods are the rows this page already fetched and the count is
 * taken from them, so the band shrinks on a quiet day and says so rather than
 * printing a figure somebody typed in last year.
 *
 * The links are plain <a> and not <Link>: /near, /near/:slug and
 * /los-angeles are rendered by the Worker and are not React routes, so
 * routing to them client-side would land on the SPA's catch-all.
 */
function PlacesBand({ areas }: { areas: Array<{ slug: string; name: string; n: number }> }) {
  const open = areas.filter((a) => a.n > 0);
  // Nothing fetched yet, or nothing to say. A band about coverage with no
  // places under it is worse than no band.
  if (areas.length === 0) return null;

  return (
    <section className="places-band" aria-labelledby="places-title">
      <div className="band-wrap">
        <h2 className="band-h" id="places-title">Where this works</h2>
        {/* Three sentences for three states, because "18 of the 18" is not
            how anybody says "all of them" and "0 of the 18" is a way of
            burying the fact that the answer today is none. */}
        <p className="band-lede">
          Los Angeles, a neighbourhood at a time.{' '}
          {open.length === 0
            ? `Slotfill covers ${areas.length}, and none of them has anything `
              + `open this minute — an opening appears the moment a job cancels.`
            : open.length === areas.length
              ? `All ${areas.length} of the neighbourhoods Slotfill covers have `
                + `something open right now.`
              : `${open.length} of the ${areas.length} neighbourhoods Slotfill `
                + `covers ${open.length === 1 ? 'has' : 'have'} something open `
                + `right now.`}
        </p>

        {open.length > 0 && (
          <ul className="places-list">
            {open.map((a) => (
              <li key={a.slug}>
                <a href={`/near/${a.slug}`}>
                  {a.name}
                  <span className="places-n">{a.n}</span>
                </a>
              </li>
            ))}
          </ul>
        )}

        <p className="band-more">
          <a href="/near">Every neighbourhood</a>
          <a href="/los-angeles">Slotfill in Los Angeles</a>
        </p>
      </div>
    </section>
  );
}

/**
 * THE OTHER SIDE OF THE MARKET.
 *
 * Last band before the footer, which is where the reference marketplace puts
 * its "Open for business" pitch, and for the same reason: everything above it
 * is aimed at somebody deciding whether to book, and an ask aimed at the
 * other half of the market has to wait until that question has been answered.
 *
 * There is no figure in it. No average earnings, no "join 2,000 businesses",
 * no worked example of a week — nobody here has measured any of that, and
 * /pros says so in as many words under "What this page is not telling you".
 * A recruitment band is exactly where an invented number is most tempting and
 * most damaging: the person reading it is deciding whether to run their
 * livelihood through this.
 */
function ProsBand() {
  return (
    <section className="pro-band" aria-labelledby="pro-title">
      <div className="band-wrap">
        <h2 className="band-h" id="pro-title">Do you turn up in the van?</h2>
        <p className="band-lede">
          If you work for yourself and your week has holes in it — a job
          cancels, or there is an hour between two of them on the same side of
          town — you can put that time up here at a price you set. You choose
          the trade, the area, the hours and the price. The customer pays on
          the site before you drive anywhere, so there is no cash at the door
          and no invoice to chase.
        </p>
        <p className="band-lede">
          What we will not tell you is what you will earn or that you will be
          booked at all. Nobody has measured either, and a number here would
          be a guess wearing a suit.
        </p>
        <p className="band-do">
          <Link className="btn" to="/join">List your van</Link>
          <Link className="linkish band-do-alt" to="/pros">
            How it works for a business
          </Link>
        </p>
      </div>
    </section>
  );
}
