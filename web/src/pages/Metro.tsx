import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  api, type MapArea, type Metro as MetroRecord, type PublicSlot, type TradeCategory,
} from '../api';
import Crumbs from '../components/Crumbs';
import { PAY_TODAY_SHORT } from '../components/PaymentState';
import PublicPage from '../components/PublicPage';
import { ErrorNote, Spinner } from '../components/ui';
import '../styles-index.css';
import '../styles-areas.css';
import { ENOUGH, formatMoney as money, median, plural } from '../lib/format';
import { loadMetros, metroBySlug } from '../lib/metros';
import { costHref, jsonLd, tradeHref } from '../lib/seo';
import { distinctGaps } from '../lib/slots';
import { useDocumentTitle } from '../lib/title';
import NotFound from './NotFound';

/**
 * A metro page. Routes /los-angeles, /santa-maria, and whatever opens next.
 *
 * The Worker server-renders each of these URLs from `metroPage` in
 * src/lib/seo.ts and splices the markup into #root before React mounts over
 * it. With no route here the catch-all would send the visitor to the front
 * page a moment after that HTML appeared, taking the page with it — so these
 * routes exist, and this page says what the server-rendered one says.
 *
 * WHICH PLACE IT IS, IS DATA. This file named Los Angeles in nine places and
 * had two paragraphs of Los Angeles weather written into it, which is why
 * /santa-maria could not be served by it: the second metro would have been a
 * second copy of the file with different nouns, and the third a third. The
 * name, the state and the paragraphs now come from the metro's own record over
 * /api/public/metros — the same records src/lib/metros.ts hands the
 * server-rendered version — so a crawler reading the spliced HTML and a person
 * watching React take over are shown one page rather than two.
 *
 * THE RULE FOR THE PROSE ON THIS PAGE, because a city page is where every
 * marketplace starts inventing: the only things it may say are general facts
 * about the place that would be true if this site did not exist, and true
 * statements about how Round The Way works. There is nothing here about how many
 * customers we have, how quickly anybody replies, how much anybody saves, or
 * how well this site is doing. Every number on the page is counted from the
 * openings fetched in this render, and where the count is nothing the page
 * says nothing is open rather than filling the space.
 *
 * EVERY FIGURE IS SCOPED TO THIS METRO. The counts come from the openings in
 * this metro's neighbourhoods and not from every opening on the site — a Santa
 * Maria page reporting the Valley's total would be the most misleading number
 * on the site — which is what `MapArea.metro` is for.
 */

/** How many trades the ranked list shows before it stops being a list. */
const TOP = 12;

/**
 * The questions this page answers, and the answers word for word.
 *
 * WHAT MAY BE IN HERE is the same rule the rest of the page carries, and it is
 * tighter here than anywhere else on the site, because a FAQPage block is a
 * promise to a search engine that the answer it quotes is on the page when
 * somebody arrives. Every answer below is either a general fact about mobile
 * work that would be true if this site did not exist, or a checkable statement
 * about how Round The Way works today. There is no count, no average, no reply
 * time, no vetting, no guarantee and no insurance in any of them.
 *
 * TWO OF THEM SAY WE DO NOT KNOW, and that is the point of having them. "Do
 * they bring their own water?" and "where will they park?" are the two
 * questions a mobile trade raises that a shop does not, they are the reason
 * somebody hesitates before booking, and the honest answer to both is that it
 * depends on the business and the address and you should settle it in messages
 * beforehand. A city page that quietly omitted them would be answering them by
 * implication, wrongly.
 *
 * The vetting answer is the wording on /safety, shortened. It has to keep
 * saying no: this page is where a reader decides whether a stranger comes to
 * their house, and it is the last place to soften it.
 *
 * Anything edited here must be edited in `metroFaqs` in src/lib/seo.ts too —
 * that file renders this same URL for a visitor with no JavaScript, and two
 * copies of an FAQ that drift break the promise above silently.
 */
function faqsFor(metro: { name: string; state: string }): { q: string; a: string }[] {
  const here = metro.name;
  return [
    {
      q: `Does the business come to me in ${here}?`,
      a: `Yes. Every business listed on Round The Way is mobile: it drives to the `
        + `address you give and does the work there. There is no shop to visit `
        + `and nothing to drop off. What each one covers is the list of `
        + `neighbourhoods on its own listing, so a business that has not said `
        + `it works in your neighbourhood will not appear against it.`,
    },
    {
      q: 'Do they bring their own water and power?',
      a: `That depends on the trade and on the business, and Round The Way does `
        + `not record it on the listing, so it is not something this page can `
        + `tell you. Some mobile businesses carry a tank and a generator and `
        + `need nothing from you; others expect an outside tap or an outdoor `
        + `socket. Ask in messages before the appointment rather than on the `
        + `day — it is a one-line question and it is the usual reason a mobile `
        + `job cannot go ahead when the van is already outside.`,
    },
    {
      q: 'Where will they park?',
      a: `At or beside the address you give, for as long as the work takes. `
        + `You know your street and we do not: if parking is permit-only, if `
        + `the only access is through a gate or a shared courtyard, or if a `
        + `garage or car park has a height limit a van will not clear, say so `
        + `in messages when you book. A driveway or a stretch of kerb the van `
        + `can stand on is the whole of what most of this work needs from a `
        + `property.`,
    },
    {
      q: `Why is nothing open near me in ${here} right now?`,
      a: `Because an opening is an hour a real business has free this week, and `
        + `on a busy afternoon there may not be one. This page counts what is `
        + `listed at the moment it loads and does not estimate, so a quiet hour `
        + `makes it a short page rather than a padded one. Openings appear when `
        + `a job is cancelled or a gap opens between two booked jobs, which is `
        + `why the list is different in the afternoon from what it was in the `
        + `morning.`,
    },
    {
      q: 'Who sets the prices on this page?',
      a: `The business doing the work. Every price shown here was typed in by `
        + `the business whose name is on the listing, for that specific hour. `
        + `Round The Way does not set prices, does not suggest them and takes no `
        + `part in agreeing them.`,
    },
    {
      q: 'How do I pay?',
      a: `${PAY_TODAY_SHORT} Nothing is paid at the door and no cash changes `
        + `hands; the business is paid by us after the job is done.`,
    },
    {
      q: `Does Round The Way check the businesses listed in ${here}?`,
      a: `No. There is no identity check, no background check run by us, no `
        + `interview, no licence check and no inspection of anybody's work. `
        + `Where a listing shows a licence, an insurance policy or a background `
        + `check, that is the business saying so about itself. Licensing boards `
        + `keep public registers and they are the place to check one.`,
    },
  ];
}

export default function Metro() {
  const { metro: slug } = useParams<{ metro: string }>();
  const [metros, setMetros] = useState<MetroRecord[] | null>(null);
  const [areas, setAreas] = useState<MapArea[]>([]);
  const [slots, setSlots] = useState<PublicSlot[]>([]);
  const [cats, setCats] = useState<TradeCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const metro = metros ? metroBySlug(metros, slug) : null;

  // Null until the metro is known, so the tab keeps the title the
  // server-rendered page already set rather than flickering through a
  // placeholder on the way to the same words.
  useDocumentTitle(metro ? `Mobile services in ${metro.name}, ${metro.state}` : null);

  /**
   * The metro records, the map and the whole catalogue. The catalogue is not a
   * decoration here — the "every service" section below is the catalogue — and
   * without the records the page does not know which place it is, so all three
   * are loaded together and the page fails as one thing rather than half
   * rendering.
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
      setError(e instanceof Error ? e.message : 'Could not load what is open.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /** This metro's neighbourhoods, and only the openings inside them. */
  const here = useMemo(
    () => (metro ? areas.filter((a) => a.metro === metro.slug) : []),
    [areas, metro],
  );
  const mine = useMemo(() => {
    const inMetro = new Set(here.map((a) => a.slug));
    return slots.filter((s) => inMetro.has(s.area_slug));
  }, [slots, here]);

  const all = useMemo(() => distinctGaps(mine), [mine]);
  const samples = useMemo(() => all.filter((s) => s.is_sample).length, [all]);
  const businesses = useMemo(
    () => new Set(all.map((s) => s.operator_id)).size, [all],
  );
  const withOpenings = useMemo(
    () => here.filter((a) => a.slot_count > 0), [here],
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
   * Every trade with something open here, ranked by how many openings it has
   * and by nothing else. Trades are matched against the catalogue so a row can
   * only ever link to a trade page that exists.
   */
  const ranked = useMemo(() => {
    const bySlug = new Map(cats.flatMap((c) => c.trades.map((t) => [t.slug, t] as const)));
    const counts = new Map<string, number>();
    for (const s of all) {
      const t = (s.trade ?? '').trim().toLowerCase();
      if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()]
      .flatMap(([tradeSlug, n]) => {
        const trade = bySlug.get(tradeSlug);
        return trade ? [{ trade, n }] : [];
      })
      .sort((a, b) => b.n - a.n || a.trade.label.localeCompare(b.trade.label));
  }, [cats, all]);

  /**
   * What businesses are asking for each trade IN THIS METRO, out of what is
   * listed here and out of nothing else.
   *
   * This is the one module on the page a marketplace usually fabricates: a
   * "typical cost in Los Angeles" table is trivial to fill with national
   * averages nobody measured locally. So every figure below is the low, the
   * middle and the high of the actual prices on this metro's own openings, and
   * the section is omitted entirely rather than padded when there are not
   * enough of them.
   *
   * THREE THINGS ARE EXCLUDED AND EACH FOR ITS OWN REASON.
   *
   * Sample listings, because a seeded price is a real number on a real
   * operator record but is not a business trading today, and a price table has
   * no room for the label that would say so — the same call `cheapest` makes
   * above.
   *
   * Trades the catalogue does not name, because a row here links to that
   * trade's page and a link to a page that answers 404 is worse than a missing
   * row.
   *
   * Anything not in the metro's most-listed currency, because a median taken
   * across dollars and pounds is not a price. In practice both metros are
   * priced in one currency and this drops nothing; it is here so that the day
   * a second one appears the table narrows instead of lying.
   *
   * ENOUGH is the cost pages' own threshold, imported rather than repeated: a
   * trade given a range here and told "too few listings to give a range" on
   * the /cost page it links to makes both pages look wrong.
   */
  const prices = useMemo(() => {
    const real = all.filter((s) => !s.is_sample && s.price_cents > 0);
    if (real.length === 0) return { currency: null as string | null, rows: [] };

    const byCurrency = new Map<string, number>();
    for (const s of real) byCurrency.set(s.currency, (byCurrency.get(s.currency) ?? 0) + 1);
    const currency = [...byCurrency.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
    if (!currency) return { currency: null as string | null, rows: [] };

    const bySlug = new Map(cats.flatMap((c) => c.trades.map((t) => [t.slug, t] as const)));
    const buckets = new Map<string, number[]>();
    for (const s of real) {
      if (s.currency !== currency) continue;
      const key = (s.trade ?? '').trim().toLowerCase();
      if (!key || !bySlug.has(key)) continue;
      const bucket = buckets.get(key);
      if (bucket) bucket.push(s.price_cents);
      else buckets.set(key, [s.price_cents]);
    }

    const rows = [...buckets.entries()].flatMap(([key, cents]) => {
      const trade = bySlug.get(key);
      if (!trade || cents.length < ENOUGH) return [];
      const sorted = [...cents].sort((a, b) => a - b);
      const low = sorted[0];
      const high = sorted[sorted.length - 1];
      const mid = median(sorted);
      if (low === undefined || high === undefined || mid === null) return [];
      return [{ trade, n: sorted.length, low, mid, high }];
    }).sort((a, b) => b.n - a.n || a.trade.label.localeCompare(b.trade.label));

    return { currency, rows };
  }, [all, cats]);

  const faqs = useMemo(
    () => (metro ? faqsFor(metro) : []),
    [metro],
  );

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
  /**
   * A URL of one segment that is not a metro. This route matches any single
   * segment, so it is where every typo, every stale link and every path some
   * other site invented for us ends up — which makes what it does with them a
   * site-wide decision rather than a corner case.
   *
   * It used to be `<Navigate to="/" replace />`: a 200 for an address that
   * does not exist, followed by a silent client-side move to the front page.
   * That is a soft 404 by the letter of the definition, and it quietly fed the
   * front page a crowd of URLs that are not it. The not-found page says what
   * happened and stays on the address that was asked for — see NotFound.tsx,
   * including the note on the half of this a browser cannot fix.
   */
  if (!metro) return <NotFound />;

  /**
   * Lifted out of `prices` so the narrowing survives into the row callback: a
   * property read off an object is re-read on every access as far as the
   * compiler is concerned, and `prices.currency &&` in the JSX above the map
   * therefore proves nothing inside it. A local const proves it once.
   */
  const priceCurrency = prices.currency;

  return (
    <PublicPage className="ix-page">
      <Crumbs items={[{ label: metro.name }]} />

      <header className="ix-head">
        <h1>
          Mobile services in {metro.name}, {metro.state}
          <span className="ix-count">
            {all.length} open {plural(all.length, 'appointment', 'appointments')} right now
          </span>
        </h1>
        <p className="ix-lede">
          Every appointment listed here is an hour a {metro.name} business has
          free this week — a job that cancelled, or a day that has not filled.
          The price is the one the business set, and it is what you pay by card
          when you book — nothing is added to it and nothing is paid at the
          door.
        </p>

        {/* Four counts, none of them written down: each is read off the rows
            this page has just fetched for this metro, and the price tile is
            omitted rather than zeroed when there is no genuine listing to
            quote. */}
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
        <h2 id="ix-top">Top services in {metro.name} right now</h2>
        {ranked.length > 0 ? (
          <ul className="ix-list">
            {ranked.slice(0, TOP).map((r) => (
              <li key={r.trade.slug}>
                <Link className="ix-row" to={tradeHref(r.trade.slug)}>
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
            how to read one. The closing sentence is there because these rows
            count one metro and the pages they lead to do not. */}
        <p className="ix-note">
          Ranked by how many appointments each trade has open in {metro.name} at
          this moment, and by nothing else. It is not a popularity list and it
          moves through the day. Each link leads to that trade everywhere
          Round The Way covers, which is more than this one place.
        </p>
      </section>

      {/*
        WHAT IS LISTED HERE COSTS, and only what is listed here.

        A city page on any marketplace of this shape carries a "how much does
        X cost in <city>" module, and it is almost always a national figure
        with a city's name written over it. This one cannot be: every number
        in it was typed in by a business against an hour it is offering in one
        of this metro's neighbourhoods, and the row count is printed beside
        each range so a reader can see how thin the evidence is. Where a trade
        has fewer than ENOUGH listed prices it has no row, and where no trade
        clears that bar the whole section is absent rather than apologetic.

        The rows link to /cost/<trade> rather than /s/<trade>: somebody
        reading a price wants the page about prices, and that page carries the
        working — the median, the spread and where the figures came from.
      */}
      {prices.rows.length > 0 && priceCurrency && (
        <section className="ix-sec" aria-labelledby="ix-prices">
          <h2 id="ix-prices">What businesses are charging in {metro.name}</h2>
          <p className="ix-sec-sub">
            The lowest, middle and highest prices listed against openings in{' '}
            {metro.name} right now. These are asking prices set by the
            businesses themselves, not quotes, not estimates and not an average
            of anything beyond this metro. Sample listings we seeded ourselves
            are left out of every figure here, which is why a range can differ
            from the one on the trade's own cost page.
          </p>
          <ul className="ar-prices">
            {prices.rows.map((r) => (
              <li key={r.trade.slug}>
                <Link className="ar-price" to={costHref(r.trade.slug)}>
                  <span className="ar-price-name">{r.trade.label}</span>
                  <span className="ar-price-fig">
                    <b>
                      {r.low === r.high
                        ? money(r.low, priceCurrency)
                        : `${money(r.low, priceCurrency)} – ${money(r.high, priceCurrency)}`}
                    </b>
                    <span>
                      middle {money(r.mid, priceCurrency)} · from {r.n}{' '}
                      {plural(r.n, 'listing', 'listings')}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <p className="ix-note">
            A trade appears here once at least {ENOUGH} openings in{' '}
            {metro.name} carry a price for it; below that there is no spread to
            report, only two or three opinions — and a run of openings can
            belong to one business, so a narrow range is not proof of a going
            rate. The middle figure is the median. What you actually pay is the
            price on the opening you book.
          </p>
        </section>
      )}

      <section className="ix-sec" aria-labelledby="ix-hoods">
        <h2 id="ix-hoods">Neighbourhoods</h2>
        {here.length > 0 ? (
          <ul className="ix-tiles">
            {here.map((a) => (
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
                  <Link to={tradeHref(t.slug)}>{t.label}</Link>
                </li>
              ))}
            </ul>
          </div>
        )) : (
          <p className="ix-sec-sub">The catalogue could not be read just now.</p>
        )}
      </section>

      {/*
        THE ONLY PROSE ON THE PAGE, and every paragraph of it but the last is a
        general fact about this place that would be true if this site did not
        exist. They come from the metro's own record rather than from a
        template, which is the point of keeping them there: Los Angeles has a
        long dry season and Santa Maria has a marine layer, and a page that
        said the same thing about both would be inventing about one of them.
        The closing paragraph is shared because it is about the product rather
        than the place. Nothing here is a claim about Round The Way's size, its
        popularity or its results, and nothing may be added that is.
      */}
      <section className="ix-sec" aria-labelledby="ix-why">
        <h2 id="ix-why">Why mobile work suits {metro.name}</h2>
        <div className="ix-prose">
          {metro.geography.map((p) => <p key={p}>{p}</p>)}
          <p>
            None of that is a claim about Round The Way. What this site does is
            narrower and easier to check: a business posts the hours it has
            free, at the price it sets, and you book one of them. Openings
            appear when a job is cancelled or a gap opens between two booked
            jobs, so the list on this page is different in the afternoon from
            what it was in the morning.
          </p>
        </div>
      </section>

      {/*
        THE SECTION THIS SITE HAS THAT A DIRECTORY OF SHOPS CANNOT.

        Everywhere else on the page, "mobile" is an adjective. Here it is the
        practical difference: the person doing the work arrives with the water,
        the power and the tools, and what they need back from the address is a
        place to stand the van, something to plug into or a tap, and somewhere
        the run-off can go. Those three are the whole of what turns a booking
        into a job that can actually happen, they are the reason a mobile job
        falls through when it does, and nobody tells a customer about them
        until the van is already outside.

        NONE OF IT IS SPECIFIC TO THIS METRO, and it does not pretend to be —
        the paragraphs above it are the place-specific ones and they come from
        the metro's own record. What this section does is name the metro in the
        sentences that are about arriving at an address in it, because a
        general explanation of mobile work is what a reader of a page about one
        place is entitled to have applied to their place.

        There is no claim in here about what any particular business carries.
        We do not record that on a listing, so the only honest instruction is
        to ask, and it says so.
      */}
      <section className="ix-sec" aria-labelledby="ix-how">
        <h2 id="ix-how">What a mobile appointment in {metro.name} involves</h2>
        <div className="ar-explain">
          <p>
            Booking here is booking a van, not a slot at a unit somebody else
            drives to. The business builds its week out of addresses across{' '}
            {metro.name} and the time between two of them is time it is not
            being paid for, which is why the openings on this page appear in
            runs: an hour that has come free is worth more to a business filled
            by somebody near where it already is.
          </p>
          <p>
            Three things decide whether a job can go ahead once the van
            arrives, and all three are about your address rather than about the
            business. It costs a line in messages to settle them before the
            day, and it costs the appointment to discover them on it.
          </p>
          <dl className="ar-needs">
            <dt>Somewhere to stand the van</dt>
            <dd>
              A driveway, a garage apron or a stretch of kerb the vehicle can
              occupy for the length of the job. Permit parking, gated access, a
              shared courtyard and a height barrier over an underground car
              park are all worth mentioning when you book — a van that cannot
              stop within a hose or cable run of the work is a van that cannot
              do it.
            </dd>
            <dt>Water and power, or the business's own</dt>
            <dd>
              Some mobile businesses carry a tank and a generator and need
              nothing from the property. Others expect an outside tap or an
              outdoor socket. Round The Way does not record which on a listing, so
              this page cannot tell you — ask the business in messages before
              the appointment.
            </dd>
            <dt>Somewhere for the run-off to go</dt>
            <dd>
              Anything washed outdoors leaves water behind it, and where it
              goes depends on the property rather than on the trade: a sloped
              driveway, a gutter, a drain in the wrong place. If you are on a
              shared drive or above a neighbour, say so.
            </dd>
          </dl>
          <p>
            None of that is a rule Round The Way enforces. It is what the work is,
            described plainly, so that the hour you book is an hour that can be
            worked.
          </p>
        </div>
      </section>

      {/*
        The questions, and the same questions again as structured data. Both
        are built from `faqs` so the two cannot say different things — the
        arrangement Trade.tsx and CostGuide.tsx already use, and the only one
        under which a FAQPage block is a promise this page can keep.
      */}
      <section className="ix-sec" aria-labelledby="ix-faq">
        <h2 id="ix-faq">Questions about booking in {metro.name}</h2>
        <p className="ix-sec-sub">
          What is settled before the van arrives, what is settled with the
          business, and what this site does not do.
        </p>
        <div className="ar-faq">
          {faqs.map((f) => (
            <details className="ar-q" key={f.q}>
              <summary>{f.q}</summary>
              <p className="ar-a">{f.a}</p>
            </details>
          ))}
        </div>
        <p className="ix-note">
          <Link to="/safety">What Round The Way checks, and what it does not</Link>
        </p>
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

      {/*
        THE CLOSING ACTION, and it is deliberately not "book now".

        The page may well be listing nothing at all this hour, so a large green
        button promising a transaction would be advertising something that is
        not there to buy. The two
        things a visitor to a quiet metro page can genuinely do are wait for an
        opening and read the catalogue, so those are the two things offered.
        The third link is for the other side of the marketplace and is worded
        as what it is.
      */}
      <section className="ar-cta" aria-labelledby="ix-do">
        <h2 id="ix-do">If nothing here suits today</h2>
        <p>
          Openings in {metro.name} appear through the day as jobs cancel and
          gaps open. You can be told when one appears in your neighbourhood
          instead of checking this page, or read the whole catalogue and come
          back to the trade you want.
        </p>
        <div className="ar-cta-do">
          <Link className="btn" to="/a">Tell me when one appears</Link>
          <Link className="btn quiet" to="/browse">See every service</Link>
          <Link className="btn quiet" to="/pros">List a business here</Link>
        </div>
      </section>

      <footer className="ix-foot">
        <p>
          Every figure on this page was counted from the openings in{' '}
          {metro.name} at the moment the page loaded. Prices are set by the
          business doing the work.
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
