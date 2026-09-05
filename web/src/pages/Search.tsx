import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type PublicSlot, type Trade, type TradeCategory } from '../api';
import Crumbs from '../components/Crumbs';
import PublicPage from '../components/PublicPage';
import SlotCard from '../components/SlotCard';
import { ErrorNote, Spinner } from '../components/ui';
import '../styles-search.css';
import { useDocumentTitle } from '../lib/title';

/**
 * What somebody typed into the bar at the top. Route /search?q=…
 *
 * WHY THIS SEARCHES IN THE BROWSER.
 * There is no search endpoint on the Worker and this page does not invent one.
 * That sounds like a compromise and here it is not: the whole searchable
 * corpus is a catalogue of a few dozen trades and the appointments that are
 * open right now, and `api.publicMap()` already returns the second of those in
 * one request — the same request the front page makes. A server round trip per
 * keystroke would buy nothing over matching a few hundred rows in memory, and
 * it would mean two different definitions of "matches" to keep in step.
 *
 * WHAT IT MATCHES, IN ORDER OF CONFIDENCE.
 *  1. Trades and categories. A trade is matched on its slug, its label, its
 *     hint and the label of the category it sits in, weighted in that order of
 *     usefulness. This is the confident half: a trade is a page we can send
 *     somebody to that will still be there tomorrow.
 *  2. Services and businesses, matched on the `service_name` and
 *     `business_name` of appointments that are open right now. Weaker, because
 *     a service name is one business's wording of one job, and the row is gone
 *     the moment it is booked.
 *
 * WHAT IT DOES NOT DO. There is no edit-distance library here and there should
 * not be. Word-prefix and substring matching is something a person can read
 * and predict — when a search returns a surprising row you can point at the
 * word that did it — and a scoring function nobody can explain is how a search
 * quietly starts putting the wrong thing first. The one thing prefixes cannot
 * do is connect words that share no letters ("lawn" and "landscaping"), and
 * that gap is closed by an explicit alias list below rather than by loosening
 * the matcher until it hits by accident.
 *
 * THE RULE THIS PAGE INHERITS FROM THE FRONT PAGE: no number on it is written
 * down. Every count here — results, appointments, what is open in a trade — is
 * counted from rows fetched a moment ago and rendered underneath.
 */

/**
 * How many cards go in before the visitor has to ask for more. Same figure as
 * the front page and the trade page: a broad query ("cleaning") can match
 * several hundred open appointments, and laying all of them out costs a phone
 * a second for cards nobody scrolls to.
 */
const PAGE = 24;

/**
 * Lower case, punctuation gone, split on anything that is not a letter or a
 * digit. The apostrophe is what this is really for: the catalogue contains
 * "mobile farmer's market", people type "farmers market", and the two have to
 * come out of here as the same words.
 */
const wordsOf = (s: string): string[] =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

/**
 * Words that carry no information about which trade is wanted.
 *
 * They are dropped because the matcher below rewards a row for every query
 * word it hits, and "and" hits two thirds of the catalogue on the strength of
 * being in "landscaping and gardening". Leaving them in does not add matches,
 * it flattens the ranking.
 */
const STOP = new Set([
  'a', 'an', 'and', 'at', 'for', 'in', 'me', 'my', 'near', 'of', 'on', 'or',
  'the', 'to', 'with', 'i', 'need', 'want', 'looking', 'someone', 'some',
]);

/**
 * Words a customer uses that share no letters with the trade we file the job
 * under, mapped to the slug they mean.
 *
 * This list exists because prefix matching cannot get from "lawn" to
 * "landscaping and gardening" or from "fridge" to "appliance repair", and the
 * alternative — a fuzzy distance that is loose enough to bridge those — is
 * loose enough to match things nobody asked for. An explicit list is longer to
 * read and impossible to be surprised by.
 *
 * The keys are trade slugs and nothing checks them at build time, so a slug
 * that is renamed or dropped leaves an alias that silently matches nothing.
 * That is the safe direction to fail in: a missing alias costs one search a
 * good result, where an alias pointing at a slug that no longer exists would
 * offer a link to a trade page that has nothing on it.
 */
const ALIAS_SOURCE: Record<string, string> = {
  'landscaping and gardening': 'lawn lawns grass mow mowing yard yards weeds weeding hedge hedges borders overgrown',
  'tree and shrub trimming': 'branches stump stumps pruning prune shrubs bushes',
  'mobile hair salon or barbershop': 'haircut haircuts barber barbers shave shaving braids blowdry colour color trim',
  'mobile spa and massage': 'facial facials nails manicure pedicure',
  'mobile makeup artist': 'mua bridal',
  'mobile locksmith': 'key keys locked lockout lock locks deadbolt rekey',
  'junk removal': 'rubbish garbage waste dump hauling haul clearance mattress sofa couch declutter',
  'trash can cleaning': 'bins wheelie dustbin smelly',
  'house cleaning': 'maid cleaner tidy tidying housekeeping deep',
  'carpet cleaning': 'rug rugs stains upholstery',
  'mobile pressure washing': 'jetwash jetwashing driveway patio decking siding',
  'appliance repair': 'fridge freezer washer washing dishwasher oven cooker microwave dryer tumble',
  'phone and tablet repair': 'iphone ipad android screen cracked battery samsung',
  'tech support': 'laptop computer pc wifi printer virus router setup',
  'pest control': 'ants roaches cockroach fleas mice rodents rats termites wasps bedbugs infestation',
  'auto glass repair': 'windscreen windshield chip crack window',
  'mobile tyre fitting': 'tire tires tyres puncture flat wheel wheels',
  'mobile oil change and mechanics': 'mechanic mechanics service servicing brakes battery breakdown engine',
  'mobile car wash and detailing': 'valet valeting wash polish waxing',
  'bike repair service': 'bicycle cycle cycling ebike puncture gears',
  'mobile pet grooming': 'groom grooming clip clipping nails dog dogs cat cats puppy',
  'mobile veterinary service': 'vet vets vaccination jab checkup',
  'mobile dog gym': 'walker walking training obedience puppy',
  'personal fitness training': 'trainer workout exercise gym pt strength',
  'tutoring': 'tutor lessons homework maths math english exam revision',
  'mobile photography and photo booths': 'photographer photos headshots portraits shoot',
  'mobile notary': 'notarise notarize notarized signing witness affidavit',
  'food trucks': 'catering caterer caterers party event lunch',
  'coffee and smoothie trucks': 'espresso latte barista juice',
  'dessert trucks': 'icecream cake cakes cupcakes doughnuts',
  'mobile bar service': 'bartender cocktails drinks wedding',
  'mobile bookstore': 'books book reading',
  'fashion boutique trucks': 'clothes clothing boutique',
  "mobile farmer's market": 'produce vegetables veg fruit farmers',
  'pool service': 'pools hottub spa chlorine',
  'gutter cleaning': 'gutters downpipe leaves',
  'window cleaning': 'windows glass panes',
  'dryer vent cleaning': 'lint vents duct',
  'handyman and repair services': 'handyman shelves shelf mounting flatpack assembly',
};

/**
 * The same list, split into words once at module load, so the matcher can
 * treat a trade's aliases as one more field of the trade rather than as a
 * special case with its own scoring path. A second scoring path is a second
 * place for the counting of hits to go wrong.
 */
const ALIAS_WORDS = new Map<string, string[]>(
  Object.entries(ALIAS_SOURCE).map(([slug, list]) => [slug, wordsOf(list)]),
);

/**
 * How well one query word matches one field's worth of words.
 *
 * The four tiers, in the order they are tried:
 *
 *   6  the same word          "locksmith" in "mobile locksmith"
 *   4  the field word starts with the query word
 *                             "car" finds "car wash", and also "carpet" — a
 *                             prefix is what somebody typing half a word
 *                             means, and the cost of it is a second result
 *                             ranked below the one they wanted
 *   3  the query word starts with the field word
 *                             "haircut" finds "hair". The field word has to be
 *                             four letters for this, because three-letter
 *                             prefixes match a lot of English by accident
 *   2  the query word appears inside the field word
 *                             the last resort, and only for words long enough
 *                             that appearing inside another word means
 *                             something
 *
 * Zero means no match, and zero is load-bearing: a row that scores zero on a
 * word is a row that did not match that word, which is what decides whether it
 * appears at all.
 */
function termScore(term: string, fieldWords: string[]): number {
  let best = 0;
  for (const w of fieldWords) {
    if (w === term) return 6;
    if (term.length >= 3 && w.startsWith(term)) best = Math.max(best, 4);
    else if (w.length >= 4 && term.startsWith(w)) best = Math.max(best, 3);
    else if (term.length >= 4 && w.includes(term)) best = Math.max(best, 2);
  }
  return best;
}

/** A field, and how much a hit in it is worth relative to the others. */
interface Field { words: string[]; weight: number }

/**
 * Score a row against every query word: the total, and how many of the words
 * were hit at all.
 *
 * The count matters more than the total downstream. Somebody who types three
 * words means all three, so a row that answers all three beats a row that
 * answers one of them very strongly — see `bestHits` below.
 */
function scoreRow(terms: string[], fields: Field[]): { score: number; hits: number } {
  let score = 0;
  let hits = 0;
  for (const term of terms) {
    let best = 0;
    for (const f of fields) best = Math.max(best, termScore(term, f.words) * f.weight);
    if (best > 0) { score += best; hits += 1; }
  }
  return { score, hits };
}

/**
 * Keep only the rows that answered the most of the query, and drop the rest.
 *
 * This is the whole precision story of the page. "mobile phone repair" hits
 * three words on phone repair and one on every other trade with "mobile" in
 * its slug, which is most of them; without this the right answer arrives at
 * the top of a list of twenty wrong ones. Taking the best count rather than
 * demanding every word also means a query with a word we know nothing about
 * ("cheap car wash") still finds the car washes instead of nothing.
 */
function bestHits<T extends { hits: number }>(rows: T[]): T[] {
  const most = rows.reduce((n, r) => Math.max(n, r.hits), 0);
  return most === 0 ? [] : rows.filter((r) => r.hits === most);
}

interface TradeHit {
  trade: Trade;
  category: TradeCategory;
  /** Appointments open in this trade, counted from the slots below. */
  open: number;
  score: number;
  hits: number;
}

interface SlotHit { slot: PublicSlot; score: number; hits: number }

export default function Search() {
  const [params] = useSearchParams();
  const q = (params.get('q') ?? '').trim();
  // The query itself, because a tab strip with four searches open in it is
  // exactly where this matters and "Search" four times answers nothing.
  useDocumentTitle(q ? `${q} — search` : 'Search');

  const [slots, setSlots] = useState<PublicSlot[]>([]);
  const [cats, setCats] = useState<TradeCategory[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);

  /**
   * Both requests together, and both required.
   *
   * They answer different halves of the page — the catalogue is what the trade
   * list is matched against, the map is what the appointment cards are made of
   * and where every count in the trade list comes from — so a page that got
   * one of them would have to show a result set it knows is incomplete without
   * being able to say which half is missing. One error and one retry is the
   * honest shape. `Promise.all` rejects on the first failure, which is what we
   * want: the retry re-runs both.
   */
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [map, catalog] = await Promise.all([
        api.publicMap(),
        api.tradeCatalog(),
      ]);
      setSlots(map.slots);
      setCats(catalog.categories);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not run that search.');
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * No query, no request. An empty `?q=` is somebody who pressed enter on an
   * empty box or followed a truncated link, and the page they get is a browse
   * prompt that needs neither the map nor the catalogue.
   *
   * The header submits to this same route while this component is mounted, so
   * a second search changes the URL without remounting: the effect depends on
   * `q` so that the second search actually runs.
   */
  useEffect(() => {
    if (!q) { setSlots([]); setCats([]); setError(null); setLoading(false); return; }
    void load();
  }, [q, load]);

  // A new query is a new list. Without this, searching again keeps whatever
  // page depth the previous result set had been expanded to.
  useEffect(() => { setLimit(PAGE); }, [q]);

  const terms = useMemo(() => {
    const all = wordsOf(q);
    const kept = all.filter((w) => !STOP.has(w));
    // Somebody who searched for nothing but stop words ("for me") still gets
    // the words they typed matched, rather than an empty term list that would
    // silently match everything.
    return kept.length > 0 ? kept : all;
  }, [q]);

  /**
   * How many appointments are open in each trade, counted from the rows this
   * page just fetched. Every number beside a trade name comes from here, so
   * none of them can be a figure that was true last week.
   */
  const openBySlug = useMemo(() => {
    const n = new Map<string, number>();
    for (const s of slots) if (s.trade) n.set(s.trade, (n.get(s.trade) ?? 0) + 1);
    return n;
  }, [slots]);

  /**
   * The confident half of the results.
   *
   * Matched against the whole catalogue, for the reason set out over `cats` in
   * Discover. It used to search the trimmed one on the argument that a result
   * leading to a trade nobody works in is a dead end; the dead end was the
   * search itself, which answered "barber" with nothing at all on any day the
   * barbers were busy. The trade page a result leads to says honestly when it
   * has no hours free and takes an alert for the next one, which is a better
   * answer to a real question than silence.
   *
   * The category label is scored as a field of the trade, weighted below the
   * trade's own words, so a search for "automotive" surfaces the trades inside
   * that category rather than needing a separate kind of result the visitor
   * then has to choose between.
   */
  const tradeHits = useMemo<TradeHit[]>(() => {
    if (terms.length === 0) return [];
    const rows: TradeHit[] = [];
    for (const category of cats) {
      const categoryWords = wordsOf(category.label);
      for (const trade of category.trades) {
        const { score, hits } = scoreRow(terms, [
          { words: [...wordsOf(trade.slug), ...wordsOf(trade.label)], weight: 3 },
          // Aliases carry the hint's weight and not the name's: somebody who
          // types "lawn" means the landscaper as surely as somebody who types
          // "landscaping", but where both trades are in the running the one
          // whose actual name was typed has to come first.
          { words: ALIAS_WORDS.get(trade.slug) ?? [], weight: 2 },
          { words: wordsOf(trade.hint ?? ''), weight: 2 },
          { words: categoryWords, weight: 1 },
        ]);
        if (hits > 0) {
          rows.push({ trade, category, open: openBySlug.get(trade.slug) ?? 0, score, hits });
        }
      }
    }
    return bestHits(rows).sort((a, b) => b.score - a.score || b.open - a.open
      || a.trade.label.localeCompare(b.trade.label));
  }, [cats, terms, openBySlug]);

  const matchedSlugs = useMemo(
    () => new Set(tradeHits.map((t) => t.trade.slug)), [tradeHits]);

  /**
   * The appointments, in two tiers that are deliberately not mixed.
   *
   * A card whose own service or business name contains what was typed is a
   * direct answer. A card that is only here because it belongs to a trade that
   * matched is a weaker answer — true, useful, and not the words they typed.
   * Inside each tier the order is the front page's: soonest first, because
   * time is the only thing we can sort on without knowing where the visitor is
   * standing.
   *
   * WHICH TIER GOES FIRST IS DECIDED BY HOW MUCH OF THE QUERY EACH ANSWERED,
   * and that is not a refinement — without it the page was embarrassing.
   * "car wash" matched the trade on both words, but no single service is
   * called "car wash": the services in it are "Wash and wax" and "Interior
   * deep clean". So the best any slot could do on its own name was one word
   * out of two — and a locksmith's "Car key cut" and a pressure washer's
   * "House wash" scored exactly the same one word. Putting direct matches
   * first unconditionally therefore answered "car wash" with a locksmith.
   *
   * Comparing the two tiers by word count instead is the honest comparison:
   * whichever tier answered more of what was typed leads, and where they tie
   * the literal name match keeps its place at the front.
   */
  const slotHits = useMemo<PublicSlot[]>(() => {
    if (terms.length === 0) return [];
    const scored: SlotHit[] = [];
    for (const slot of slots) {
      const { score, hits } = scoreRow(terms, [
        { words: wordsOf(slot.service_name), weight: 3 },
        { words: wordsOf(slot.business_name), weight: 2 },
      ]);
      if (hits > 0) scored.push({ slot, score, hits });
    }
    const kept = bestHits(scored);
    const directHits = kept.reduce((n, r) => Math.max(n, r.hits), 0);
    const direct = kept
      .sort((a, b) => b.score - a.score || a.slot.starts_at - b.slot.starts_at)
      .map((r) => r.slot);

    const seen = new Set(direct.map((s) => s.gap_id));
    const byTrade = slots
      .filter((s) => s.trade !== null && matchedSlugs.has(s.trade) && !seen.has(s.gap_id))
      .sort((a, b) => a.starts_at - b.starts_at);

    const tradeHitWords = tradeHits.reduce((n, t) => Math.max(n, t.hits), 0);
    return tradeHitWords > directHits ? [...byTrade, ...direct] : [...direct, ...byTrade];
  }, [slots, terms, matchedSlugs, tradeHits]);

  const total = tradeHits.length + slotHits.length;
  const visible = slotHits.slice(0, limit);

  /**
   * The shell is rendered around the loading and error states rather than
   * instead of them, which is the one place this page departs from the shape
   * the category page uses. That page predates the shared header; this one is
   * reached from a search box that lives in that header, and a visitor who
   * mistyped needs the box back on the screen to correct it — not after the
   * request finishes, which is exactly when they have stopped waiting.
   */
  return (
    <PublicPage className="sr-page">
      <Crumbs items={[{ label: 'Search' }]} />

      {loading && <Spinner label="Searching" />}
      {error && <ErrorNote error={error} onRetry={() => void load()} />}

      {!loading && !error && !q && (
        /*
         * An empty query is not a failed search and must not read like one.
         * Nobody typed anything, so there is nothing to be sorry about and
         * no query to quote back — just the two doors this page can open.
         */
        <section className="sr-blank">
          <h1>Search Slotfill</h1>
          <p className="sr-blank-p">
            Type what you need doing into the box at the top of the page — a
            trade, a service or the name of a business. Or start from the
            categories.
          </p>
          <div className="sr-blank-do">
            <Link className="btn" to="/">Browse every category</Link>
            <Link className="btn quiet" to="/a">Get told when something opens</Link>
          </div>
        </section>
      )}

      {!loading && !error && q && (
        <>
          <header className="sr-head">
            {/*
              The count is the sum of the two lists printed below it and
              nothing else, and the line under it says which is which so the
              number can be checked against the page by eye. The two halves
              are named separately because they are counted from different
              things — services from the catalogue, appointments from what is
              open this minute — and one sentence covering both would have to
              describe one of them wrongly. Where there is nothing, the
              heading says so in the heading rather than leaving a visitor to
              work it out from an empty page.
            */}
            <h1>
              {total > 0
                ? `${total} ${total === 1 ? 'result' : 'results'} for “${q}”`
                : `Nothing matches “${q}”`}
            </h1>
            {total > 0 && (
              // aria-live, so this page's result count behaves the way the
              // front page's and the trade page's already do. Searching again
              // from the header in the bar above rewrites this line without a
              // page load, and a heading quietly changing its own text is not
              // something a screen reader announces by itself.
              <p className="sr-sub" aria-live="polite">
                {tradeHits.length > 0 && (
                  `${tradeHits.length} ${tradeHits.length === 1 ? 'service' : 'services'}`
                  + ' in the catalogue'
                )}
                {tradeHits.length > 0 && slotHits.length > 0 && ' and '}
                {slotHits.length > 0 && (
                  `${slotHits.length} open ${slotHits.length === 1 ? 'appointment' : 'appointments'}`
                  + ' right now'
                )}
                .
              </p>
            )}
          </header>

          {tradeHits.length > 0 && (
            <section className="sr-sec" aria-labelledby="sr-trades">
              <h2 id="sr-trades" className="sr-h2">Services</h2>
              <ul className="sr-trades">
                {tradeHits.map((t) => (
                  <li key={t.trade.slug}>
                    <Link className="sr-trade" to={`/s/${encodeURIComponent(t.trade.slug)}`}>
                      <span className="sr-trade-text">
                        <span className="sr-trade-name">{t.trade.label}</span>
                        <span className="sr-trade-where">
                          {t.trade.hint ?? t.category.label}
                        </span>
                      </span>
                      {/*
                        Counted from the slots fetched a moment ago, so a
                        trade Slotfill covers but nobody has an hour free in
                        lands here at zero. That says so in words rather than
                        showing a nought, because a nought in the position a
                        number normally means "open now" reads as a broken
                        count.
                      */}
                      <span className={`sr-trade-n${t.open === 0 ? ' none' : ''}`}>
                        {t.open > 0
                          ? `${t.open} open`
                          : 'None open right now'}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {slotHits.length > 0 && (
            <section className="sr-sec" aria-labelledby="sr-slots">
              <h2 id="sr-slots" className="sr-h2">Open appointments</h2>
              {/*
                The same card component the front page and the trade page
                render, which is what this block used to say in a comment and
                could not enforce: it was a copy, and the copy had already
                fallen a rating, a hired count and a review line behind the
                original. The trade is named on these cards, because a result
                set can hold six trades at once and the trade is the thing
                that says which of them you are looking at.

                There are deliberately no filters above this list. The
                ranking has already done the narrowing — two tiers, ordered by
                how much of the query each row answered — and a second set of
                controls reordering that would be two things fighting over the
                same list, with the tier order losing silently.
              */}
              <div className="slot-grid">
                {visible.map((s) => (
                  <SlotCard key={s.gap_id} slot={s} showTrade />
                ))}
              </div>
              {slotHits.length > limit && (
                <div className="more">
                  <button className="btn quiet" onClick={() => setLimit((n) => n + PAGE)}>
                    Show {Math.min(PAGE, slotHits.length - limit)} more
                  </button>
                </div>
              )}
            </section>
          )}

          {total === 0 && (
            /*
              Nothing was found and the page says nothing was found.
              There is no "did you mean" here because nothing on this page
              computed a nearest match, and a guess dressed as one is a
              worse answer than an honest miss. What it does instead is
              explain what was actually searched — a person who knows the
              site only holds a few dozen trades stops retyping synonyms —
              and offer the two things that are genuinely useful next: the
              whole catalogue, and being told when something appears.
            */
            <section className="sr-none">
              <p className="sr-none-p">
                Nothing in the catalogue and nothing open right now matches{' '}
                <strong>{q}</strong>. Slotfill covers a few dozen trades and
                this searches every one of them by name, whether or not
                anybody is free in it — so a miss here usually means the job
                is filed under a word we do not use for it.
              </p>
              <div className="sr-none-do">
                <Link className="btn" to="/">Browse every category</Link>
                <Link className="btn quiet" to="/a">
                  Tell me when something opens
                </Link>
              </div>
            </section>
          )}
        </>
      )}
    </PublicPage>
  );
}
