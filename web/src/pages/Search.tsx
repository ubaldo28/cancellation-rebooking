import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, type PublicSlot, type Trade, type TradeCategory } from '../api';
import Crumbs from '../components/Crumbs';
import PublicPage from '../components/PublicPage';
import SlotCard from '../components/SlotCard';
import { ErrorNote, Spinner } from '../components/ui';
import '../styles-search.css';
import { tradeHref } from '../lib/seo';
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
 *
 * WHAT THE REFERENCE MARKETPLACE PUTS ON THIS PAGE, AND WHICH OF IT IS HONEST
 * HERE. Its results page is, top to bottom: the query still editable in place,
 * a row of filters, a count with a sort control beside it, the cards, and more
 * at the foot. Three of those five were missing here and two of them were
 * missing for a reason.
 *
 *  · The query, still editable. Added, but only on the two screens where
 *    there is nothing else to press — nothing matched, and nothing typed. On a
 *    page that DID find something the site header is already carrying a search
 *    box two inches higher, and a second box under it is two controls fighting
 *    over one job with no way for a reader to know which one they are in.
 *  · A count with a sort beside it. Added. See `sortMode`.
 *  · Filters. Deliberately still absent, and the reason has changed. It used
 *    to be that ranking had already done the narrowing; the real reason now is
 *    that a filter row is a promise about the size of the corpus. A rating
 *    filter, a price band and an availability window are worth the space when
 *    they cut two hundred results to twenty. Against the handful of open hours
 *    this site has on a given afternoon they cut a short list to an empty one,
 *    which is the single worst thing this page can do to somebody.
 *
 * WHICH BRINGS US TO THE THING THIS PAGE IS ACTUALLY FOR TODAY. Nothing has
 * launched. Payment is off, there is no roster of businesses, and the ordinary
 * outcome of a search here is a list of trades with no hours free underneath
 * them — or nothing at all. So the empty states are not an afterthought
 * bolted to the bottom of the file; they are the main screen, and they are
 * built to give the same two real answers every time:
 *
 *   1. WIDEN IT. Their own words, back in a box, plus each single word of a
 *      multi-word query offered as a shorter search. Those suggestions are
 *      derived from what was typed and from nothing else — there is no
 *      "did you mean", because nothing here computes a nearest match and a
 *      guess dressed as one is worse than an honest miss.
 *   2. WAIT TO BE TOLD. A standing alert at /a, which is the only mechanism on
 *      this site that answers "there is nothing today" with anything better
 *      than "come back tomorrow". Where a trade did match, the link carries
 *      that trade so the alert arrives half filled in.
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

/**
 * How the open appointments are ordered, which the reference marketplace calls
 * a sort and puts beside its result count.
 *
 * The note this file used to carry said there would never be one, on the
 * argument that the two-tier ranking had already decided the order and a
 * second control reordering it would be two things fighting with the tier
 * order losing silently. Half of that is still right and it is the half that
 * shaped this: the tiers ARE the answer to "which of these best matches what I
 * typed", so they stay as `match`, and `match` is what the page opens on.
 *
 * The other half was wrong about what somebody wants from a search on this
 * particular site. A person searching a list of hours that are free THIS WEEK
 * is very often not asking which row is most relevant — they are asking which
 * one is soonest, or which one is cheapest, and there is no arrangement of
 * relevance tiers that answers either. Both are computed from fields already
 * on the row, so neither is a claim: `starts_at` and `price_cents`.
 *
 * "Losing silently" is the part that had to be designed away rather than
 * argued away. Picking anything but `match` abandons the tiers completely —
 * a flat list, one order, no hidden grouping — and the page says so in a line
 * under the control while it is doing it. A reader can always tell which of
 * the two arrangements they are looking at.
 */
type SortMode = 'match' | 'soon' | 'price';

const SORTS: { value: SortMode; label: string }[] = [
  { value: 'match', label: 'Best match' },
  { value: 'soon', label: 'Soonest first' },
  { value: 'price', label: 'Lowest price' },
];

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
  const [sort, setSort] = useState<SortMode>('match');

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
  //
  // The sort goes back to `match` with it, which is the less obvious half. A
  // sort is an answer to one question — "of the things that matched THAT, show
  // me the cheapest" — and carrying it into a different question silently
  // re-answers the new one. Somebody who searched "car wash", sorted by price,
  // then searched "locksmith" has not asked for the cheapest locksmith; they
  // have asked for locksmiths.
  useEffect(() => { setLimit(PAGE); setSort('match'); }, [q]);

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

  /**
   * The same rows, in whichever order was asked for.
   *
   * `match` hands back `slotHits` untouched — the tiers, exactly as they were
   * computed above. The other two flatten the list and sort the whole of it,
   * which is the point: a person who asked for the cheapest wants the cheapest
   * of everything that matched, not the cheapest of tier one followed by the
   * cheapest of tier two, which would look like a broken sort.
   *
   * Both tie-break on time, so two identically priced hours come out in the
   * order somebody would actually take them.
   */
  const ordered = useMemo<PublicSlot[]>(() => {
    if (sort === 'soon') {
      return [...slotHits].sort((a, b) => a.starts_at - b.starts_at);
    }
    if (sort === 'price') {
      return [...slotHits].sort(
        (a, b) => a.price_cents - b.price_cents || a.starts_at - b.starts_at);
    }
    return slotHits;
  }, [slotHits, sort]);

  /**
   * Shorter searches, made only out of the words they typed.
   *
   * The one thing a person can do about a miss on a site this small is ask for
   * less, and the words to ask for less with are already in their query: three
   * words that matched nothing together may each match something alone. So a
   * multi-word query offers each of its own words back as a one-word search.
   *
   * Stop words are already gone by the time this runs — `terms` dropped them —
   * so nobody is offered "search for just near". The list is capped at four
   * because this is a row of chips on an empty screen, not a second results
   * page, and `Set` is there because "cleaning cleaning service" would
   * otherwise offer the same chip twice.
   */
  const widenTo = useMemo<string[]>(
    () => (terms.length < 2 ? [] : [...new Set(terms)].slice(0, 4)),
    [terms]);

  const total = tradeHits.length + slotHits.length;
  const visible = ordered.slice(0, limit);

  /**
   * The trade to hand the alert page when the visitor gives up on today.
   *
   * Only when exactly one trade matched. Two trades matched means we do not
   * know which one they meant, and prefilling a watch with a guess is how
   * somebody ends up subscribed to alerts about work they never asked for —
   * an alert being wrong is much more expensive than an alert being empty,
   * because it arrives on their phone at some unrelated hour weeks later.
   */
  const soleTrade = tradeHits.length === 1 ? tradeHits[0] : undefined;
  const alertHref = soleTrade
    ? `/a?trade=${encodeURIComponent(soleTrade.trade.slug)}` : '/a';

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
          <h1>Search Round The Way</h1>
          <p className="sr-blank-p">
            Type what you need doing — a trade, a service, or the name of a
            business. This searches every trade Round The Way covers, and every
            hour that is free right now.
          </p>
          <RefineBox initial="" label="What do you need done?" cta="Search" />
          <div className="sr-blank-do">
            <Link className="btn quiet" to="/">Browse every category</Link>
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
                    <Link className="sr-trade" to={tradeHref(t.trade.slug)}>
                      <span className="sr-trade-text">
                        <span className="sr-trade-name">{t.trade.label}</span>
                        <span className="sr-trade-where">
                          {t.trade.hint ?? t.category.label}
                        </span>
                      </span>
                      {/*
                        Counted from the slots fetched a moment ago, so a
                        trade Round The Way covers but nobody has an hour free in
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

          {/*
            MATCHED, AND NOTHING FREE. The state this whole product spends most
            of its days in, and the one the page used to have no words for: the
            catalogue answered, the list of trades came out, and underneath it
            simply nothing — no heading, no sentence, no explanation of why a
            page that had just said "3 results" was showing three links and no
            hours. Someone reading that concludes the site is broken, which is
            worse than what is actually true and much less useful.

            What is actually true is a sentence long, and it is the sentence
            that makes the alert make sense: these trades exist here, nobody in
            them has an hour free this minute, and the only thing that changes
            that is being told when one appears.
          */}
          {tradeHits.length > 0 && slotHits.length === 0 && (
            <section className="sr-sec" aria-labelledby="sr-shut">
              <h2 id="sr-shut" className="sr-h2">Open appointments</h2>
              <div className="sr-door">
                <h3>Nothing is free right now in {soleTrade
                  ? soleTrade.trade.label
                  : `${tradeHits.length === 2 ? 'either' : 'any'} of these`}</h3>
                <p>
                  Every appointment on this site is an hour a business has
                  actually lost to a cancellation, so what is here changes
                  through the day and there is nothing in{' '}
                  {soleTrade ? 'it' : 'them'} at this moment. An
                  alert is the only thing that answers this properly — it is
                  sent within minutes of the hour opening up, which is the
                  window in which it is still going.
                </p>
                <Link className="btn" to={alertHref}>
                  Tell me when one opens
                </Link>
              </div>
            </section>
          )}

          {slotHits.length > 0 && (
            <section className="sr-sec" aria-labelledby="sr-slots">
              <h2 id="sr-slots" className="sr-h2">Open appointments</h2>

              {/*
                The count and the sort on one line, which is where the
                reference marketplace puts them and is the right place for a
                reason worth writing down: the sort is a statement about the
                list it sits on top of, and a control floating above an
                unlabelled grid does not say which list it governs. There are
                two lists on this page.

                The count is `slotHits.length` and not `visible.length` — it
                counts what matched, not what has been drawn yet, which is what
                makes "Show more" underneath legible rather than alarming.
              */}
              <div className="sr-tools">
                <p className="sr-count">
                  {slotHits.length} open{' '}
                  {slotHits.length === 1 ? 'appointment' : 'appointments'}
                </p>
                <label className="sr-sort">
                  <span>Sort</span>
                  <select value={sort} onChange={(e) => {
                    setSort(e.target.value as SortMode);
                    // A reorder is a new list and the depth goes back with it.
                    // Without this, choosing "Lowest price" on a list already
                    // expanded twice reshuffles seventy-two cards under the
                    // reader's scroll position and nothing appears to change
                    // at the top.
                    setLimit(PAGE);
                  }}>
                    {SORTS.map((s) => (
                      <option key={s.value} value={s.value}>{s.label}</option>
                    ))}
                  </select>
                </label>
              </div>

              {/*
                Said only while it is true, and said as plainly as it can be:
                the grouping the page normally applies is off. See SortMode.

                ALWAYS IN THE DOCUMENT and empty until there is something to
                say, the same arrangement the code field's status line uses. A
                live region that is added to the page at the same moment it
                gets its text is frequently not announced at all — the browser
                has nothing to notice a change against — and this line exists
                precisely for the reader who cannot see that the cards have
                rearranged themselves. `:empty` collapses it so the silent
                case opens no gap.
              */}
              <p className="sr-sorted" aria-live="polite">
                {sort === 'match' ? '' : (
                  `One flat list, ${sort === 'soon' ? 'earliest first' : 'cheapest first'}.`
                  + ` How closely each one matches “${q}” is not being used to`
                  + ' order them.'
                )}
              </p>

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

              {/* At the foot of a list somebody has just read to the end of,
                  which is a different moment from the empty state and wants a
                  much quieter version of the same offer. They found things;
                  none of them were right, or none were at the right hour. */}
              <p className="sr-quiet">
                None of these at a time that suits?{' '}
                <Link to={alertHref}>Set an alert</Link> and you will hear when
                another opens near you.
              </p>
            </section>
          )}

          {total === 0 && (
            /*
              THE MOST IMPORTANT SCREEN ON THIS PAGE, and on most days the
              most-read one. Nothing has launched; a search that finds nothing
              is the ordinary outcome, not the edge case, so this is designed
              rather than left as the absence of a result.

              There is no "did you mean" here because nothing on this page
              computed a nearest match, and a guess dressed as one is a worse
              answer than an honest miss. What it does instead, in order:

                · Says plainly that nothing matched, and quotes back what was
                  searched so it can be checked for a typo by eye.
                · Explains what was actually searched. Somebody who learns the
                  site holds a few dozen trades and that all of them were
                  checked stops retyping synonyms at it.
                · Widens. Their words back in a box, and — for a query of more
                  than one word — each of those words on its own. Nothing in
                  that row is invented; every chip is a word they typed.
                · Offers the alert, described in terms of what it does rather
                  than named as a feature, because nobody has come here wanting
                  a "standing alert".

              The two doors are drawn as panels rather than as a pair of
              buttons under a paragraph. They are not the same kind of thing —
              one is an act you complete now, the other is a thing you set up
              and walk away from — and a row of equal buttons says they are.
            */
            <section className="sr-none">
              <p className="sr-none-p">
                Nothing in the catalogue and nothing open right now matches{' '}
                <strong>{q}</strong>. Round The Way covers a few dozen trades and
                this searches every one of them by name, whether or not anybody
                is free in it — so a miss here usually means the job is filed
                under a word we do not use for it.
              </p>

              <div className="sr-doors">
                <div className="sr-door">
                  <h2>Try it wider</h2>
                  <p>
                    Fewer words, or the plainest word for the job. “Cleaning”
                    finds more than “end of tenancy deep clean”.
                  </p>
                  <RefineBox initial={q} label="Search again" cta="Search" />
                  {widenTo.length > 0 && (
                    <>
                      <p className="sr-widen-lede">
                        Or search for one word of that on its own:
                      </p>
                      <div className="sug">
                        {widenTo.map((w) => (
                          <Link key={w} className="sug-chip"
                            to={`/search?q=${encodeURIComponent(w)}`}>
                            {w}
                          </Link>
                        ))}
                      </div>
                    </>
                  )}
                </div>

                <div className="sr-door">
                  <h2>Or wait to be told</h2>
                  <p>
                    Everything on this site is an hour a business lost to a
                    cancellation, so it comes and goes through the day. Say
                    where you are and what you want done, and you will hear
                    when something near you opens up — usually within minutes
                    of it happening.
                  </p>
                  <Link className="btn" to="/a">Set up an alert</Link>
                  <p className="sr-door-note">
                    No account, and no phone number asked for.
                  </p>
                </div>
              </div>

              <p className="sr-quiet">
                Not sure what to call it?{' '}
                <Link to="/">Browse every category</Link> — the catalogue is
                short enough to read.
              </p>
            </section>
          )}
        </>
      )}
    </PublicPage>
  );
}

/**
 * The query, back in a box, on the two screens where there is nothing else to
 * press.
 *
 * WHY THIS IS NOT DRAWN ON A PAGE THAT FOUND SOMETHING. The site header
 * carries a search box on every page of the site, and on a results page it is
 * a few inches above this one. Two boxes doing the same job, one of which
 * clears itself and one of which does not, is a control a person has to
 * experiment with to understand. On the two screens below there is no result
 * list for the header box to sit above, the reader has scrolled past it, and
 * the whole task in front of them is "type something else" — which is the one
 * case where repeating a control is worth its cost.
 *
 * WHY IT PRE-FILLS WITH THE FAILED QUERY. Widening means taking a word out,
 * and a word cannot be taken out of an empty box. An empty box asks somebody
 * to retype the thing that just failed before they can edit it, which is
 * exactly the friction that makes people leave instead.
 *
 * It navigates rather than submitting to the server. This is the same route
 * the component is already mounted on, so `navigate` re-runs the search
 * without a page load — and the effect over `q` above is what makes that
 * work.
 */
function RefineBox({ initial, label, cta }: {
  initial: string; label: string; cta: string;
}) {
  const navigate = useNavigate();
  const [text, setText] = useState(initial);

  return (
    <form className="sr-refine" onSubmit={(e) => {
      e.preventDefault();
      const next = text.trim();
      // An empty box is not a search. Submitting one would replace a page
      // that at least explains itself with the browse prompt, which reads as
      // the site having thrown their query away.
      if (next) navigate(`/search?q=${encodeURIComponent(next)}`);
    }}>
      <label className="grow">
        <span className="sr-only">{label}</span>
        <input value={text} onChange={(e) => setText(e.target.value)}
          type="search" enterKeyHint="search" autoComplete="off"
          placeholder="Trade, service or business name" />
      </label>
      <button className="btn" type="submit" disabled={!text.trim()}>{cta}</button>
    </form>
  );
}
