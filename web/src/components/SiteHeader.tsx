import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type Trade, type TradeCategory } from '../api';
import { Icon } from './ui';
import '../styles-shell.css';

/**
 * How many trades the box offers at once.
 *
 * The catalogue is about forty trades and a broad word ("mobile", "cleaning")
 * matches a third of them. A list that long under a sticky bar covers the page
 * on a phone and stops being a shortcut; six is what fits above the fold at
 * 375px with every row a 44px target. Nothing is hidden by the cut — the box
 * still searches everything the moment somebody presses enter, and that page
 * ranks the whole catalogue and the open appointments together.
 */
const HINTS = 6;

/**
 * Lower case, punctuation gone, split on anything that is not a letter or a
 * digit — the same normalisation the search page does to a query, for the same
 * reason: the catalogue holds "mobile farmer's market" and people type "farmers
 * market".
 */
const norm = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** A trade the box is offering, and the category it is filed under. */
interface Hint { trade: Trade; category: string }

/**
 * The bar at the top of every page.
 *
 * Until now this markup lived inline in Discover and nowhere else, so the
 * whole site apart from the front page had no way back to the front page and
 * no way to sign in. The reference marketplace puts the same three things in
 * the same order on every single page — wordmark, search, account links — and
 * the reason is not consistency for its own sake: a visitor who lands on a
 * category or a profile from a search engine has to be able to start a search
 * without first working out that the wordmark is a link home.
 *
 * The search box suggests trades out of the catalogue as somebody types and is
 * a combobox in the ARIA sense; the notes on the state below say what it will
 * and will not do with a keypress. Nothing it draws takes part in the bar's
 * layout — the list is positioned out of the flow — so the collapse described
 * further down happens at the same two widths it always did.
 *
 * The class is still `.topbar`, which is the shared bar the profile, join,
 * watch and guest pages already sit under, and which Discover already darkens
 * through `.land-home .topbar`. Renaming it would have meant re-deriving that
 * dark treatment here; the extra `.site-head` class is only there so this
 * file's rules can beat `.topbar`'s on specificity where they need to.
 */
/**
 * `nav` exists for the two pages a customer is in the middle of something on:
 * the checkout and the private booking record behind a token. On those,
 * "Alert me / Sign in / List your van" are three ways to leave a page nobody
 * should be leaving, and on the booking record they also re-frame somebody's
 * private job as a marketplace page with their job printed on it. Turning
 * them off leaves the wordmark, which is the one link that page should have.
 */
export default function SiteHeader(
  { search = true, nav = true }: { search?: boolean; nav?: boolean },
) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  /**
   * The label is tied to the field by id, and the header can legitimately
   * appear twice on one document (a page that renders it and a page that is
   * being previewed inside another). A hardcoded id would silently point the
   * second label at the first field, which is exactly the failure a screen
   * reader user cannot see.
   */
  const fieldId = useId();
  const listId = useId();
  const optionId = (i: number) => `${listId}-o${i}`;

  /*
    THE TRADES THE BOX CAN SUGGEST.

    Typing into this field used to be a guess with one attempt: the box takes
    free text, the search page matches words, and "lawnmowing" or "plumer"
    lands on a results page with nothing on it and no way to tell whether the
    site has no gardeners or the word was wrong. The catalogue is the list of
    things this site actually sells, it is forty rows long, and the browser
    already has it — so a name being typed can be finished from it instead.

    Fetched on the first interaction with the field rather than on mount. Every
    page's footer already asks for this catalogue, the Worker serves it with a
    long cache-control, and a visitor who never touches the box should not be
    paying even a cache lookup for a feature they did not use.

    A failure is not reported anywhere and clears the flag so a later focus can
    try again: suggestions are help on top of a box that already works, and a
    header that starts announcing network errors over the top of somebody's
    page has made a fetch it did not need into their problem.
  */
  const [cats, setCats] = useState<TradeCategory[]>([]);
  const asked = useRef(false);
  const wantCatalog = useCallback(() => {
    if (asked.current) return;
    asked.current = true;
    void api.tradeCatalog()
      .then((r) => setCats(r.categories))
      .catch(() => { asked.current = false; });
  }, []);

  /** Whether the list is being offered, and which row the keyboard is on. */
  const [listOpen, setListOpen] = useState(false);
  const [active, setActive] = useState(-1);

  /**
   * The trades matching what has been typed so far.
   *
   * Every typed word has to be the start of some word in the trade's own name,
   * its slug, its hint or its category — so "car wash" finds "Car wash and
   * detailing", "pet" finds everything filed under pet care, and a word that is
   * the beginning of nothing finds nothing at all rather than something loosely
   * adjacent. A suggestion list that answers a typo with a confident wrong
   * trade is worse than one that stays out of the way, and pressing enter on
   * the typed words still runs the full search, which is the place that knows
   * about aliases ("fridge", "windscreen") and about what is open today.
   *
   * One letter is not a query — it matches most of the catalogue, and the list
   * would then open under the first keystroke of every search anybody starts —
   * so the box stays quiet until there are two.
   */
  const hints = useMemo<Hint[]>(() => {
    const query = norm(q);
    if (query.length < 2) return [];
    const words = query.split(' ');
    const first = words[0] ?? query;
    const found: Array<Hint & { rank: number }> = [];
    for (const category of cats) {
      for (const trade of category.trades) {
        const name = norm(trade.label);
        const searchable = [name, norm(trade.slug), norm(trade.hint ?? ''),
          norm(category.label)].join(' ').split(' ');
        if (!words.every((w) => searchable.some((word) => word.startsWith(w)))) continue;
        // A trade whose own name starts with what was typed is the one the
        // typist is most likely reaching for, then one that has the words
        // somewhere in its name, then one matched through its category or its
        // hint. Ties are alphabetical so the order never depends on how the
        // catalogue happens to be grouped.
        const rank = name.startsWith(query) ? 0
          : name.split(' ').some((word) => word.startsWith(first)) ? 1 : 2;
        found.push({ trade, category: category.label, rank });
      }
    }
    return found
      .sort((a, b) => a.rank - b.rank || a.trade.label.localeCompare(b.trade.label))
      .slice(0, HINTS);
  }, [q, cats]);

  /** Open only when there is something in it: an empty popup is not a popup. */
  const shown = listOpen && hints.length > 0;

  const close = () => { setListOpen(false); setActive(-1); };

  /** Straight to the trade's own page, which is what the suggestion promised. */
  const choose = (hint: Hint) => {
    close();
    setQ('');
    navigate(`/s/${encodeURIComponent(hint.trade.slug)}`);
  };

  /**
   * An empty box does nothing rather than navigating to `?q=`, which is a
   * results page for a query nobody typed. The trim is what makes a box holding
   * a single space count as empty, here and on the submit button below.
   */
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    close();
    const query = q.trim();
    if (!query) return;
    navigate(`/search?q=${encodeURIComponent(query)}`);
  };

  /**
   * THE KEYBOARD, AND THE ONE KEY THIS MUST NOT TAKE.
   *
   * Enter is only intercepted when a suggestion is actually highlighted — that
   * is, when somebody has arrowed onto one. Plain enter on typed text falls
   * through to the form and runs the search, which is the behaviour this box
   * had before there was a list and the behaviour every search field on the
   * internet has. A combobox that swallows enter because a list happens to be
   * on screen is the single most common way this pattern strands somebody:
   * they type a phrase, press enter, and the page does not move.
   *
   * The arrows open the list if it is closed and wrap at both ends. Escape
   * closes it and keeps the typed text, and does nothing at all when the list
   * is already closed, so the browser's own "clear the search field" is left
   * intact for a second press.
   */
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (hints.length === 0) return;
      e.preventDefault();
      const down = e.key === 'ArrowDown';
      if (!shown) { setListOpen(true); setActive(down ? 0 : hints.length - 1); return; }
      setActive((i) => {
        const next = i + (down ? 1 : -1);
        return next < 0 ? hints.length - 1 : next >= hints.length ? 0 : next;
      });
      return;
    }
    if (e.key === 'Escape' && shown) { e.preventDefault(); close(); return; }
    const picked = shown && active >= 0 ? hints[active] : undefined;
    if (e.key === 'Enter' && picked) {
      e.preventDefault();
      choose(picked);
    }
  };

  return (
    <>
      {/*
        First in the tab order on every page, because this component is first
        on every page. A plain <a> to a fragment rather than a <Link>: the
        target is a spot in the document that is already loaded, and routing
        to it would push a history entry for "the top of the page I am on".
      */}
      <a className="skip-link" href="#main">Skip to main content</a>

      <header className="topbar site-head">
        <Link to="/" className="wordmark"><i />slotfill</Link>

        {/*
          A real <form>, not an input with a keydown handler, so Enter submits,
          so the field gets the browser's search affordances, and so a submit
          with an empty box does nothing rather than navigating to `?q=`.
        */}
        {search && (
          /*
            The blur closes the list rather than a click somewhere on the
            document doing it: the options below cancel their own mousedown so
            the field never loses focus to a press on one, which means the only
            way focus leaves this form is on the way to somewhere else — and
            that is exactly when the list should go.
          */
          <form className="shell-search" role="search" onSubmit={submit}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget)) close();
            }}>
            <label className="shell-search-label" htmlFor={fieldId}>
              Search for a service
            </label>
            <span className="shell-search-icon">
              <Icon name="search" size={18} stroke={1.9} />
            </span>
            {/*
              The field is the combobox and the list below is its popup. The
              browser's own history dropdown is still off — two lists over one
              box, one of them covering the other, is worse than either — and
              `aria-activedescendant` is what moves the announcement down the
              options while the text cursor stays in the field, which is the
              whole reason typing keeps working while the list is open.
            */}
            <input id={fieldId} name="q" type="search" value={q}
              role="combobox" aria-expanded={shown} aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={shown && active >= 0 ? optionId(active) : undefined}
              onFocus={wantCatalog}
              onChange={(e) => {
                wantCatalog();
                setQ(e.target.value);
                setListOpen(true);
                // The highlight is dropped on every keystroke, so enter after
                // typing always means "search for what I typed" and never
                // "open whatever happens to be under the cursor now".
                setActive(-1);
              }}
              onKeyDown={onKeyDown}
              placeholder="What do you need done?"
              autoComplete="off" enterKeyHint="search" />
            <button className="shell-search-go" type="submit" disabled={!q.trim()}>
              Search
            </button>

            {/* Said once, quietly, for somebody who cannot see the list arrive.
                Without it the only evidence that six trades are now on offer is
                a box that has appeared on screen. */}
            <span className="shell-search-label" role="status">
              {shown ? `${hints.length} ${hints.length === 1 ? 'suggestion' : 'suggestions'}, `
                + 'use the down arrow to review them' : ''}
            </span>

            {/*
              Rendered whether or not it is open, and hidden with the attribute
              when it is not: `aria-controls` above points at this id at all
              times, and an id that only exists half the time is a reference
              into nothing for whatever is reading the field.
            */}
            <ul className="shell-sug" id={listId} role="listbox"
              aria-label="Services" hidden={!shown}>
              {hints.map((hint, i) => (
                <li key={hint.trade.slug} id={optionId(i)} role="option"
                  aria-selected={i === active}
                  className="shell-sug-opt"
                  // The press must not take focus out of the field before the
                  // click lands, which is what would close the list underneath
                  // the finger and cancel the click.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(hint)}>
                  <span className="shell-sug-name">{hint.trade.label}</span>
                  {/* Which part of the catalogue it came out of. Two trades can
                      read almost identically on their own — "Bar service",
                      "Spa and massage" — and the category is what says whether
                      this is the one being reached for. */}
                  <span className="shell-sug-cat">{hint.category}</span>
                </li>
              ))}
            </ul>
          </form>
        )}

        {/*
          HOW THIS COLLAPSES, AND WHY.

          Three things want the same row and on a 360px phone they do not fit:
          the wordmark is ~90px, the pills are ~300px, and a search box
          narrow enough to squeeze between them would be too short to read a
          placeholder in. Rather than shrink all three into uselessness, the
          search drops onto its own full-width row underneath (see
          `.shell-search` in styles-shell.css, which is `flex: 1 0 100%` until
          760px). Two full-size rows beat one row of three cramped controls: the
          wordmark stays legible, every pill stays a real tap target, and the
          search — the thing the visitor came to use — gets the whole width.

          The bar is sticky, so two rows is two rows of screen permanently gone
          on a phone. That is bought back at 430px, where "Sign in" is dropped
          from the bar: it is the businesses' door, businesses arrive through
          "List your van" anyway, and the same link is in the footer of every
          page. Nothing a customer needs is ever hidden.

          "Browse" is the fourth thing in that row and it does not drop at
          430px, because a phone is exactly where a visitor who arrived on a
          trade page most needs a way into the catalogue. It pays for its
          place by shedding its icon at that width instead, keeping the word
          and its 44px target. Below 360px there is no room even for that and
          it does go — the only control here with the same directory waiting
          for it in the footer of every page.
        */}
        {nav && (
          <nav className="shell-nav" aria-label="Main">
            {/*
              THE WAY BACK TO THE CATALOGUE.

              Every page but the front one was a dead end for browsing: a
              visitor who landed on a trade page from a search engine could
              search for a phrase or go home, and going home is not something
              a stranger thinks to do to find a list of categories. The
              reference marketplace carries the same affordance in the same
              place for the same reason.

              First in the nav, because it is the only one of the four that a
              customer who has not decided anything yet needs, and because the
              two on its right are both about committing to something.

              The icon is dropped below 430px and the word carries it alone —
              see `.shell-browse` in styles-shell.css for why it shrinks
              rather than dropping out of the bar the way "Sign in" does, and
              for the one width where it does have to go.
            */}
            <Link to="/browse" className="tlink shell-browse">
              <Icon name="list" size={17} stroke={2} />
              <span className="shell-browse-label">Browse</span>
            </Link>
            <Link to="/a" className="tlink">Alert me</Link>
            <Link to="/signin" className="tlink shell-nav-drop">Sign in</Link>
            <Link to="/join" className="tlink solid">List your van</Link>
          </nav>
        )}
      </header>
    </>
  );
}
