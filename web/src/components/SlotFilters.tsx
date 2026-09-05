import { useMemo, useState } from 'react';
import type { PublicSlot } from '../api';
import '../styles-slotcard.css';

/**
 * The row of sort and filter controls that sits above a grid of `SlotCard`s.
 *
 * THE PROPERTY WORTH PROTECTING IN HERE: a control is not rendered at all
 * unless it can genuinely divide the rows it is sitting above. Something has to
 * pass it and something has to fail it. A "4.5 and up" filter over a list where
 * nobody has been reviewed is a button whose only possible outcome is an empty
 * page, and a visitor who presses it does not conclude that the filter was
 * pointless — they conclude the site has nothing. Equally, a ceiling that keeps
 * every row is a promise of choice the data cannot pay out. Every option below
 * is derived from the rows about to be rendered, which is also why there is no
 * disabled state anywhere in the stylesheet: a control this list cannot answer
 * for is absent, and an absent control is better than a dead one.
 *
 * WHY A HOOK AND A COMPONENT RATHER THAN ONE COMPONENT.
 * A page does more with its filtered list than render cards from it: the front
 * page counts businesses in it, both pages page through it, and both print how
 * many rows survived in a heading somewhere above these controls. If the
 * filtering lived inside the component, every one of those would need the
 * result handed back out again through a callback, and the page's own list
 * would be a copy of state that lives somewhere else. So `useSlotFilters` is
 * called by the page — the state is the page's, the filtered and sorted array
 * is the page's — and the component is given that state to draw and to change.
 * It reports, it does not own.
 */

/**
 * What the list can be ordered by.
 *
 * 'near' is the one that is not always on offer: `detour_minutes` is null on
 * every row until a postcode has been given, so before that the option would be
 * a control that reorders nothing.
 */
export type Sort = 'soon' | 'price' | 'rating' | 'near';

const SORT_LABEL: Record<Sort, string> = {
  soon: 'Soonest',
  price: 'Lowest price',
  rating: 'Highest rated',
  near: 'Closest',
};

/** How a result line describes the order the list is in. */
const SORT_SUB: Record<Sort, string> = {
  soon: 'soonest first',
  price: 'cheapest first',
  rating: 'highest rated first',
  near: 'closest first',
};

/**
 * The rating floors worth offering, before the data gets a say.
 *
 * Any one of them is dropped below if it would not divide the current list into
 * two non-empty halves — a filter that changes nothing is noise, and one that
 * empties the page is worse than no filter at all.
 */
const RATING_FLOORS = [3, 3.5, 4, 4.5];

/**
 * The day a row falls on, taken from the words the card itself prints.
 *
 * There is a `starts_at` on every row and it would be easy to bucket by it,
 * but the epoch second has to be turned into a calendar day in some timezone
 * before it is a day at all, and the only timezone the browser has is the
 * visitor's. The card's `when` was formatted by the Worker in the timezone of
 * the business doing the work, so an evening appointment can genuinely be
 * "Sat, Sep 5" on the card and Sunday to a browser three hours east of it.
 * Filtering by the card's own words cannot disagree with the card: pick
 * "Sat, Sep 5" and every row left says Sat, Sep 5 on it.
 *
 * `formatTimeRange` builds the string as `<day>, <start>–<end>`, and the day
 * part may itself contain a comma, so the split is on the last one.
 */
const dayOf = (s: PublicSlot): string => {
  const cut = s.when.lastIndexOf(', ');
  return cut === -1 ? s.when : s.when.slice(0, cut);
};

/**
 * A day the list actually contains, and how many rows fall on it.
 *
 * `key` is the day exactly as the cards print it, which is what the filter
 * compares against. `label` is what the control says, which is the same text
 * unless it is today or tomorrow — see `nicknames` for why those two are only
 * ever offered when they can be proved.
 */
export interface DayOption { key: string; label: string; n: number }

/**
 * "Today" and "Tomorrow", but only when they are demonstrably right.
 *
 * These are built by formatting the visitor's own clock the same way the
 * Worker formatted `when`, and then matched against the day strings the rows
 * carry. If the visitor is in a timezone where the two disagree, no key
 * matches and neither nickname is offered — the days keep their dates and
 * nothing false is ever printed. That failure is the point: a filter labelled
 * "Today" that hands back tomorrow is worse than one labelled "Sun, Sep 6".
 */
function nicknames(): Map<string, string> {
  const fmt = new Intl.DateTimeFormat('en-US',
    { weekday: 'short', day: 'numeric', month: 'short' });
  // Calendar arithmetic rather than adding 86,400,000 milliseconds, which
  // lands on the same date twice a year on the day the clocks go back.
  const at = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return fmt.format(d);
  };
  return new Map([[at(0), 'Today'], [at(1), 'Tomorrow']]);
}

/**
 * "a", "a and b", "a, b and c".
 *
 * The line describing the filters in force is read by somebody checking why the
 * list looks thin, and a machine-punctuated "a, b, c" reads as a label rather
 * than as an answer to that question.
 */
const andList = (parts: string[]): string =>
  parts.length < 2
    ? (parts[0] ?? '')
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;

/** A price ceiling, carrying the string the server already formatted. */
export interface PriceCap { cents: number; label: string }

/** Which controls the current rows can honestly offer. */
export interface FilterOffer {
  sorts: Sort[];
  openNow: boolean;
  caps: PriceCap[];
  floors: number[];
  /** Empty whenever the list is one day long — see the note in the memo. */
  days: DayOption[];
}

export interface SlotFilterState {
  /** The rows, filtered and ordered. This is the list the page renders. */
  shown: PublicSlot[];
  /** How many rows there were before any filter had a say. */
  total: number;
  /** Which controls the current rows can support. */
  offer: FilterOffer;
  /** The order in force, and the words a result line uses for it. */
  sort: Sort;
  sortSub: string;
  /** The filters actually applied — see the note on `SlotFilterState` below. */
  openFilter: boolean;
  priceCap: PriceCap | null;
  ratingFloor: number | null;
  day: DayOption | null;
  /** Whether anything is narrowing the list right now. */
  filtered: boolean;
  setSort: (sort: Sort) => void;
  toggleOpenNow: () => void;
  setPriceCap: (cents: number | null) => void;
  setRatingFloor: (value: number | null) => void;
  setDay: (key: string | null) => void;
  clear: () => void;
}

/**
 * The filter state for one list of appointments.
 *
 * `sort`, `openFilter`, `priceCap` and `ratingFloor` on the returned object are
 * the settings *in force*, which is not always the settings that were chosen. A
 * choice made in one neighbourhood can be meaningless in the next: the cheap end
 * of one is not the cheap end of another, and changing trade can take every
 * reviewed business off the list at once. Rather than reaching in and clearing
 * the controls out from under somebody's hands, a setting the current rows
 * cannot support is simply not applied — so the list is never emptied by a
 * filter the page has stopped offering, and the setting comes back the moment it
 * means something again.
 *
 * All four are stable between renders for as long as `pool` is, so a page can
 * use them as effect dependencies to reset its own paging when the list changes
 * underneath it.
 */
export function useSlotFilters(pool: PublicSlot[]): SlotFilterState {
  /**
   * Null until somebody chooses, and null means "whatever suits the data":
   * closest once we know where they are, soonest before that. Storing the
   * default as a real value instead would freeze it — a visitor who arrived
   * before giving a postcode would still be on 'soonest' afterwards, and the
   * whole point of the postcode is that distance becomes the better order.
   */
  const [sortPick, setSortPick] = useState<Sort | null>(null);
  const [openOnly, setOpenOnly] = useState(false);
  /** A ceiling in cents, always one of the prices actually on offer. */
  const [pricePick, setPricePick] = useState<number | null>(null);
  const [ratingPick, setRatingPick] = useState<number | null>(null);
  /** A day as the cards print it, always one of the days actually listed. */
  const [dayPick, setDayPick] = useState<string | null>(null);

  const offer = useMemo<FilterOffer>(() => {
    const rated = pool.filter((s) => s.rating !== null);

    // Distinct prices, cheapest first, each carrying the string the server
    // already formatted. The currency belongs to the business doing the work,
    // so the label is never assembled here out of a number and a symbol.
    const prices = [...new Map(pool.map((s) => [s.price_cents, s.price] as const)).entries()]
      .sort((a, b) => a[0] - b[0]);

    // Three ceilings drawn from the prices on offer rather than round numbers
    // pulled out of the air: a "$50 or less" that nothing costs is a dead end,
    // and each of these is a price something is actually listed at. The last
    // distinct price is never a ceiling, because a ceiling that keeps
    // everything is a control that does nothing.
    const caps = new Map<number, string>();
    if (prices.length > 1) {
      for (const fraction of [0.25, 0.5, 0.75]) {
        const at = prices[Math.min(prices.length - 2,
          Math.max(0, Math.round(fraction * (prices.length - 1))))];
        if (at) caps.set(at[0], at[1]);
      }
    }

    const sorts: Sort[] = ['soon', 'price'];
    if (rated.length > 0) sorts.push('rating');
    if (pool.some((s) => s.detour_minutes !== null)) sorts.push('near');

    /*
      THE DAYS, AND WHY THERE ARE SOMETIMES NONE.

      These are dated openings — an hour on a particular afternoon, not a
      standing availability — so "when" is the question the rest of this row
      could not answer. Each option is a day something is actually listed on,
      and picking one leaves that day's rows and drops the others, so both
      halves of the split exist by construction.

      Below two distinct days there is no split to make: with everything on
      one day the only option would keep the whole list, which is the dead
      control this file exists to refuse. There is deliberately no "this week"
      either. The listing runs ten days out, so "this week" would either mean
      "up to Sunday" — a boundary that keeps shrinking until it holds nothing
      on a Saturday — or "the next seven days", which is not what the words
      say. A named day is unambiguous and it is what the card prints.
    */
    const named = nicknames();
    const byDay = new Map<string, { first: number; n: number }>();
    for (const s of pool) {
      const key = dayOf(s);
      const seen = byDay.get(key);
      if (seen) { seen.n += 1; seen.first = Math.min(seen.first, s.starts_at); }
      else byDay.set(key, { first: s.starts_at, n: 1 });
    }
    // Chronological by the first opening on each day rather than by the day
    // string, which sorts "Sat, Sep 5" after "Mon, Sep 7" alphabetically and
    // would put next week above tomorrow.
    const days: DayOption[] = byDay.size < 2 ? [] : [...byDay.entries()]
      .sort((a, b) => a[1].first - b[1].first)
      .map(([key, v]) => ({ key, label: named.get(key) ?? key, n: v.n }));

    return {
      sorts,
      days,
      // Both halves have to exist: if every business here is switched on, the
      // toggle is a light switch in a room with no dark.
      openNow: pool.some((s) => s.online) && pool.some((s) => !s.online),
      caps: [...caps.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([cents, label]) => ({ cents, label })),
      floors: RATING_FLOORS.filter((v) =>
        rated.some((s) => (s.rating ?? 0) >= v)
        && pool.some((s) => s.rating === null || s.rating < v)),
    };
  }, [pool]);

  const sort: Sort = sortPick && offer.sorts.includes(sortPick)
    ? sortPick
    : (offer.sorts.includes('near') ? 'near' : 'soon');
  const openFilter = openOnly && offer.openNow;
  const priceCap = offer.caps.find((c) => c.cents === pricePick) ?? null;
  const ratingFloor = ratingPick !== null && offer.floors.includes(ratingPick)
    ? ratingPick : null;
  const day = offer.days.find((d) => d.key === dayPick) ?? null;
  const filtered = openFilter || priceCap !== null || ratingFloor !== null
    || day !== null;

  const shown = useMemo(() => {
    const kept = pool.filter((s) => {
      if (openFilter && !s.online) return false;
      if (priceCap && s.price_cents > priceCap.cents) return false;
      if (day && dayOf(s) !== day.key) return false;
      // A minimum rating hides everyone nobody has reviewed. That is the only
      // defensible reading of "4 and up" — an unrated business has not scored
      // 4, it has not scored anything — but it is a real consequence and the
      // line under the controls says so out loud.
      if (ratingFloor !== null && (s.rating === null || s.rating < ratingFloor)) return false;
      return true;
    });
    return kept.sort((a, b) => {
      switch (sort) {
        case 'price':
          return a.price_cents - b.price_cents || a.starts_at - b.starts_at;
        case 'rating': {
          // Unrated sinks rather than counting as zero: no reviews is not a bad
          // score, but it is not evidence either, and this is the order somebody
          // chose in order to see the evidence first.
          const ar = a.rating ?? -1;
          const br = b.rating ?? -1;
          if (ar !== br) return br - ar;
          return b.review_count - a.review_count || a.starts_at - b.starts_at;
        }
        case 'near': {
          // Once we know where they are, how far the van has to come off its
          // route is the reason to book. A row we have no distance for cannot
          // be claimed to be close, so it goes last.
          const ad = a.detour_minutes ?? Infinity;
          const bd = b.detour_minutes ?? Infinity;
          if (ad !== bd) return ad - bd;
          return a.starts_at - b.starts_at;
        }
        default:
          return a.starts_at - b.starts_at;
      }
    });
  }, [pool, openFilter, priceCap, ratingFloor, day, sort]);

  return {
    shown,
    total: pool.length,
    offer,
    sort,
    sortSub: SORT_SUB[sort],
    openFilter,
    priceCap,
    ratingFloor,
    day,
    filtered,
    setSort: setSortPick,
    toggleOpenNow: () => setOpenOnly((v) => !v),
    setPriceCap: setPricePick,
    setRatingFloor: setRatingPick,
    setDay: setDayPick,
    clear: () => {
      setOpenOnly(false); setPricePick(null);
      setRatingPick(null); setDayPick(null);
    },
  };
}

export default function SlotFilters({ filters }: { filters: SlotFilterState }) {
  const { offer, sort, openFilter, priceCap, ratingFloor, day, filtered } = filters;

  // Nothing to sort and nothing to narrow. The controls are about the rows, so
  // with no rows there is nothing for them to be about.
  if (filters.total === 0) return null;

  /** The filters in force, in the words the line under the controls uses. */
  const applied = [
    // "on Today" is not a sentence. A nicknamed day is an adverb and goes in
    // lower case; a dated one is a place in the calendar and takes "on".
    day ? (day.label === day.key ? `on ${day.key}` : day.label.toLowerCase()) : null,
    openFilter ? 'that are open right now' : null,
    priceCap ? `at ${priceCap.label} or less` : null,
    ratingFloor !== null ? `rated ${ratingFloor.toFixed(1)} and up` : null,
  ].filter((w): w is string => w !== null);

  return (
    <>
      <div className="filters">
        <label className="filt">
          <span className="filt-lab">Sort by</span>
          <select value={sort}
            onChange={(e) => filters.setSort(e.target.value as Sort)}>
            {offer.sorts.map((k) => (
              <option key={k} value={k}>{SORT_LABEL[k]}</option>
            ))}
          </select>
        </label>

        {/* Directly after the order, because on a page of dated openings
            "when" is the first thing narrowed and the last thing the row
            used to be able to say. The count rides along in the option: it
            is counted from the rows below and it is what tells somebody
            which day is worth choosing before they choose it. */}
        {offer.days.length > 0 && (
          <label className="filt">
            <span className="filt-lab">Day</span>
            <select value={day?.key ?? ''}
              onChange={(e) => filters.setDay(e.target.value || null)}>
              <option value="">Any day</option>
              {offer.days.map((d) => (
                <option key={d.key} value={d.key}>{d.label} ({d.n})</option>
              ))}
            </select>
          </label>
        )}

        {offer.openNow && (
          <button type="button" aria-pressed={openFilter}
            className={`filt-toggle${openFilter ? ' on' : ''}`}
            onClick={filters.toggleOpenNow}>
            Open now
          </button>
        )}

        {offer.caps.length > 0 && (
          <label className="filt">
            <span className="filt-lab">Price</span>
            <select value={priceCap ? String(priceCap.cents) : ''}
              onChange={(e) => filters.setPriceCap(
                e.target.value ? Number(e.target.value) : null)}>
              <option value="">Any price</option>
              {offer.caps.map((c) => (
                <option key={c.cents} value={c.cents}>
                  {c.label} or less
                </option>
              ))}
            </select>
          </label>
        )}

        {offer.floors.length > 0 && (
          <label className="filt">
            <span className="filt-lab">Rating</span>
            <select value={ratingFloor === null ? '' : String(ratingFloor)}
              onChange={(e) => filters.setRatingFloor(
                e.target.value ? Number(e.target.value) : null)}>
              <option value="">Any rating</option>
              {offer.floors.map((v) => (
                <option key={v} value={v}>{v.toFixed(1)} and up</option>
              ))}
            </select>
          </label>
        )}

        {filtered && (
          <button type="button" className="filt-clear" onClick={filters.clear}>
            Clear filters
          </button>
        )}
      </div>

      {/* What is on, in words. A row of controls tells you what you could do;
          this tells you what you did, which is the thing somebody who scrolled
          back up after two minutes of reading cards needs. */}
      {filtered && (
        <p className="filt-applied">
          Showing only appointments {andList(applied)}
          {ratingFloor !== null
            && ', which leaves out every business nobody has reviewed yet'}.
        </p>
      )}
    </>
  );
}
