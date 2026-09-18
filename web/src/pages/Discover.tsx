import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type MapArea, type Metro, type PublicSlot, type TradeCategory } from '../api';
import CityMap from '../components/CityMap';
import CategoryArt from '../components/CategoryArt';
import { CategoryArtImg } from '../components/TileArt';
import { PAY_TODAY_SHORT } from '../components/PaymentState';
import SiteHeader from '../components/SiteHeader';
import SiteFooter from '../components/SiteFooter';
import SlotCard from '../components/SlotCard';
import { useSlotFilters } from '../components/SlotFilters';
import { HowItWorks, WhyBook } from '../components/HowItWorks';
import { Icon, Spinner } from '../components/ui';
import { useBookingState } from '../lib/customer';
import '../styles-parts.css';
import '../styles-home.css';

/**
 * The front door.
 *
 * Whoever lands here has never heard of this and is not signed in. The page
 * has one job: prove that a van is already working near them this week, and
 * show what an hour of it costs — before asking for anything at all. That is
 * the true version of the promise this page used to make in six words at the
 * top of it; see the note on the hero line for what was wrong with them.
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

export default function Discover() {
  /**
   * What booking requires on this deployment, and whether it is possible at
   * all today. Read from the Worker because neither answer is a constant a
   * bundle can hold — see the note on the hero line below, which is where the
   * whole "no account is ever required" mistake was most visible.
   */
  const bookingState = useBookingState();
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

  // Kept as a scroll target: choosing a neighbourhood on the map above sends
  // the visitor to the list it just changed.
  const browseTop = useRef<HTMLDivElement | null>(null);

  /**
   * True while the map is drawing vehicles rather than showing live ones. Owned
   * here because the line that says so sits on the map's frame, which is this
   * page's element. The map reports it; the page prints it.
   */
  const [illustrated, setIllustrated] = useState(false);

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
  /**
   * The picture for the "Everything" tile, which is not a category and so has
   * no row in `cats` to carry one.
   *
   * It comes off the catalogue payload beside the categories rather than being
   * written out here, for the reason set out over `everything_art` in api.ts:
   * this would otherwise be the only place in this tree that spells a path to
   * one of the art files, and therefore the only one that could be wrong
   * without the Worker or a test disagreeing with it.
   */
  const [allArt, setAllArt] = useState<string | undefined>(undefined);
  useEffect(() => {
    void (async () => {
      try {
        const res = await api.tradeCatalog();
        setCats(res.categories);
        setAllArt(res.everything_art);
      } catch { /* the flat tiles below still work without it */ }
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
  /**
   * Choosing a neighbourhood on the map, which is now above the list rather
   * than beside it. Beside it, changing the selection visibly changed the
   * column next door and needed nothing else; above it, the thing that
   * changed is off the bottom of the screen, so a tap would look like it did
   * nothing at all.
   */
  const pickArea = (slug: string) => {
    setSelected(slug);
    browseTop.current?.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto' : 'smooth',
      block: 'start',
    });
  };

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

            {/* Says only what the data can back. An earlier headline promised a
                van on your street and a lower price; neither is something we
                know, and a first claim that turns out to be untrue is the one
                thing a stranger will not forgive.

                The one it replaced — "Someone is free near you this week" —
                was honest about distance but not about supply: it asserts
                somebody is available, which is false on any day with an empty
                map, and the first day is always an empty map. An instruction
                promises nothing, so it cannot be contradicted by the page
                underneath it.

                "Round the way" is the name doing its own explaining. It means
                LOCAL — someone from your own streets — not "already on the
                way". The distinction matters: local is a thing this product
                can stand behind, and imminence is not.

                Customer language throughout. "Hours" is how an operator thinks
                about their own day; a customer thinks about getting an
                appointment. */}
            <h1>Book someone <em>round the way</em>.</h1>
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
                  placeholder="Postcode" autoComplete="postal-code"
                  inputMode="text" />
                <button className="finder-go" type="submit"
                  disabled={locating || !postcode.trim()}>
                  {locating ? 'Looking…' : 'Search'}
                </button>
              </form>
              {/*
                WHAT THIS LINE IS FOR, and what it stopped being.

                It has been three things. It said "No account. No app. No card."
                and all three were wrong, in the first sentence a stranger
                reads. It then said what booking costs and what it asks for —
                true, but it explained the sign-up mechanics to somebody who has
                not decided to sign up, which is a defence against a question
                nobody has asked yet.

                It now says the two things that are TRUE AND ONLY TRUE HERE.
                Los Angeles, because that is the whole of it and a visitor from
                anywhere else should find that out in one line rather than after
                typing a postcode. And that nobody paid to be listed, because
                that is the actual difference from every directory this will be
                compared to: on those, position is bought. Here a business pays
                only when the site brings them a customer they did not have.

                Both are checkable, which is the test a sentence in this
                position has to pass. Neither is a promise about the future.

                THE ACCOUNT MECHANICS MOVED to the point somebody actually
                books, which is where the question gets asked.
              */}
              <p className="finder-note">
                Testing in LA. Real businesses, and none of them paid to be here.
              </p>
            </div>

            {/* AND TODAY IT CANNOT BE DONE AT ALL, which the hero is the right
                place to say and the checkout is the wrong place to discover.
                The sentence is the Worker's own: whether a sign-in code can be
                sent depends on a Worker secret, so a bundle carrying its own
                answer would be guessing about the one thing this band is
                inviting somebody to start. */}
            {bookingState && !bookingState.sms_ready && bookingState.sms_note && (
              <p className="hero-warn" role="status">
                <strong>Bookings are not open yet.</strong>{' '}
                {bookingState.sms_note}
                {' '}
                {/* THE DOOR THAT IS STILL OPEN, and the reason this notice is
                    not just an apology.

                    A standing alert runs over web push, with email as an
                    optional second channel — see src/lib/alerts.ts — so setting
                    one up does not turn on the provider this notice is about.
                    Until migration 0038 this said the alert was fine because it
                    "is not a text message"; that stopped being the distinction
                    that matters the day the sign-in code became an email
                    itself, and claiming the alert definitely arrives would now
                    be claiming something this page cannot know.

                    Without this sentence the notice is a dead end: somebody
                    who arrived wanting a detailer reads that they cannot have
                    one and leaves, and nothing is kept. With it they can ask
                    to be told, which is the only thing worth capturing on a
                    day when nothing can be booked. */}
                <Link to="/a">Ask to be told when something opens near you</Link>
                {' — an alert goes out over web push, so setting one up does '
                 + 'not wait on this.'}
              </p>
            )}

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

            {/* THE THREE COUNTS ARE GONE from under the postcode box.

                They said how many appointments were open, how many
                neighbourhoods were covered and the lowest price on the site —
                all true, all counted from the rows on the page, and all wrong
                in this position. A number under a search box is read as a
                promise about what the search will return, and on a site this
                new the honest figures are small enough to argue against
                looking. The openings themselves are one scroll down and they
                are the answer.

                Nothing is hidden by this: `facts` is still computed and the
                same figures still appear where they belong — on a trade page,
                against that trade. */}
          </div>
        </div>
      </section>

      {/*
        --- band two: the map, and why it is here rather than in a sidebar ---

        It used to be a 430px column beside the list, four screens down, under
        eight category tiles and a rail of neighbourhood names. That is where a
        directory puts a map, because on a directory the map is a locator: you
        already know what you want and it tells you how far away it is.

        Here the map is the pitch. Every business on this site drives to the
        customer, and a wide shot of your own streets with vans moving across it
        says that in the second before anybody reads a word. So it comes second,
        full width, and the list of appointments follows it — the picture first,
        the inventory after.
      */}
      <section className="map-band" aria-labelledby="map-head">
        <div className="wrap-wide">
          <div className="map-band-head">
            <h2 id="map-head">They come to you.</h2>
            <p>
              Every business here is mobile — they drive to your kerb, your
              driveway, your car park. Tap a neighbourhood to see what is open
              in it.
            </p>
          </div>

          <div className="map-shell map-stage">
            <CityMap areas={shownAreas} selected={selected} onSelect={pickArea}
              cars onIllustrated={setIllustrated} />
            <span className="map-hint">Tap a neighbourhood</span>
            {/* THE HONEST LINE, and it is shown exactly when it is true.
                The map draws real positions from real phones whenever anybody
                is out. While nobody is — which is every minute of a deployment
                that is still showing sample businesses, because sample
                businesses have no phone to ping — it draws vehicles instead,
                and says so. A moving vehicle on a marketplace map is read as a
                real one, so the page has to be straight about which it is.
                Do not make this permanent and do not delete it: it is wired to
                what the map is actually doing. */}
            {illustrated && (
              <span className="map-note">
                Sample vehicles. Real ones appear here as businesses go out.
              </span>
            )}
          </div>
        </div>
      </section>

      {/* --- band three: what is open ------------------------------------ */}
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
                    Everything Round The Way covers. The number is what is open right now.
                  </p>
                  <div className="cat-tiles" role="group" aria-label="Browse by category">
                    {grouped.map((c) => (
                        <Link key={c.key} to={`/browse/${c.key}`} className="cat-tile">
                          {/*
                            THE TILE PICTURES ARE RENDERED FILES NOW.

                            These eight were inline SVG, drawn from coordinates
                            in CategoryArt.tsx, and the argument for that was a
                            good one: no request, no decode, nothing to go
                            wrong. What changed is that the owner asked for a
                            picture on every TRADE tile as well, and thirty-nine
                            of those cannot be inline SVG in a bundle every
                            visitor downloads. Once the trades are files, the
                            categories being the one set drawn a different way
                            is how a grid stops looking like one set: the .webp
                            files and CategoryArt's scenes are the same
                            coordinates for exactly that reason — see the note
                            at the top of tools/trade-art.html.

                            `c.art` is the path the Worker computed and put on
                            the catalogue payload; CategoryArt is what draws
                            when an hour-old cached payload has no such field.
                            See TileArt.tsx for the empty alt, the width and
                            height, and why these are lazy.
                          */}
                          <span className="cat-tile-art">
                            <CategoryArtImg
                              src={c.art}
                              fallback={<CategoryArt category={c.key} />}
                            />
                          </span>
                          {/* THE NAME, AND NOTHING ELSE ON THE TILE. The
                              count that used to sit beside it is gone from
                              here: a tile is a picture of the work with its
                              name written across the foot of it, which is what
                              the grid has to say at a glance. What is open is
                              said in words on the category page each tile
                              leads to, and per trade on the trade's own page,
                              where somebody is close enough to the decision
                              for a number to mean something. */}
                          <span className="cat-tile-body">
                            <span className="cat-tile-name">{c.label}</span>
                          </span>
                        </Link>
                    ))}
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
                      <span className="cat-tile-art">
                        <CategoryArtImg
                          src={allArt}
                          fallback={<CategoryArt category={null} />}
                        />
                      </span>
                      <span className="cat-tile-body">
                        <span className="cat-tile-name">Everything</span>
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
                {/* THE NEIGHBOURHOOD RAIL IS GONE. It printed every covered
                    neighbourhood with a count against each, which is the
                    postcode box's job said a second, longer way. The map below
                    is the thing that answers "who is near me", so the map is
                    what gets the room. */}

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
                  {/* THE SMALL/BIG MAP TOGGLE IS GONE with the sidebar map it
                      resized. There is one map now, it is the size it should
                      be, and it is above this list rather than beside it. */}
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
                          soonest. Nothing else is asked for, and looking around
                          needs no account.
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

                    {/* THE FILTER ROW IS GONE, and the filtering under it is
                        not. `filters` still narrows and sorts `shown`; what
                        was removed is the row of Job / Day / Price / Rating
                        controls above the results.

                        They were four dropdowns over a handful of rows. A
                        control that offers to divide six results into six
                        groups of one is not helping anybody choose — it is
                        four decisions asked before the first useful one, at
                        the exact moment somebody wants to see what is
                        available. The hook stays because the page still needs
                        its ordering, and because putting the row back is one
                        line rather than a rebuild. */}


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
      {/* THE NEIGHBOURHOOD BAND IS GONE.

          It printed every open neighbourhood in both metros with a count
          against each — Studio City 18, Encino 14, and on down to places with
          three. Two problems with it, and the second is the one that matters.

          It answered a question the page already answers better: somebody who
          wants to know whether this reaches their street types their postcode
          into the box at the top, and gets their own street rather than a list
          of twenty-five names to scan for it.

          And the counts were the wrong thing to lead with on a quiet day. A
          band whose job is "we cover your area" that opens with a column of
          single digits argues against itself.

          /near still exists and is still linked from the footer and from every
          category page, so nothing is unreachable — it is just no longer the
          thing between somebody and the search box. */}
      <ProsBand />

      {/*
        NO TESTIMONIALS BAND, and this is deliberate rather than unfinished.

        The reference marketplace ends its home page with three customer
        quotes, and it is the one band on it we cannot have: Round The Way has no
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
            Round The Way does not vet them. There is no interview, no reference
            check and no identity check: a business gives an email address, a
            business name, a vehicle and a bank account to be paid into, and
            that is the whole of it.
            What the site does instead is make each one answerable — the
            reviews on a card were written by people who booked that
            appointment and had the work done, and the vehicle that turns up
            has to match the one on the listing.
          </p>
        </div>
        <p className="band-more">
          <Link to="/pros">How Round The Way works for a business</Link>
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
 * matter what the answer is. That is not a hypothetical: this band's payment
 * item spent months headed "Nothing is paid on this site yet" while the
 * checkout three clicks away was charging real cards. The payment item now
 * takes its sentence from PaymentState.tsx so it cannot say anything the
 * checkout does not.
 */
const COVERED = [
  {
    title: 'You pay when you book, not at the door',
    body:
      `${PAY_TODAY_SHORT} If it is cancelled, what comes back depends on how `
      + 'close to the appointment it is: all of it more than 48 hours out, '
      + 'three quarters inside 48 hours, a quarter inside 12.',
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
          Round The Way is not an insurer and none of this is a guarantee. It is
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
