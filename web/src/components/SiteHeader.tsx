import { useId, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Icon } from './ui';
import '../styles-shell.css';

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

  /**
   * An empty box does nothing rather than navigating to `?q=`, which is a
   * results page for a query nobody typed. The trim is what makes a box holding
   * a single space count as empty, here and on the submit button below.
   */
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const query = q.trim();
    if (!query) return;
    navigate(`/search?q=${encodeURIComponent(query)}`);
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
          <form className="shell-search" role="search" onSubmit={submit}>
            <label className="shell-search-label" htmlFor={fieldId}>
              Search for a service
            </label>
            <span className="shell-search-icon">
              <Icon name="search" size={18} stroke={1.9} />
            </span>
            <input id={fieldId} name="q" type="search" value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="What do you need done?"
              autoComplete="off" enterKeyHint="search" />
            <button className="shell-search-go" type="submit" disabled={!q.trim()}>
              Search
            </button>
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
