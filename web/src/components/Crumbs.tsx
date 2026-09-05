import { Link } from 'react-router-dom';
import '../styles-shell.css';

export interface Crumb {
  label: string;
  /** An in-app route. Omitted on the page you are standing on. */
  to?: string;
}

/**
 * The breadcrumb, and the structured data that goes with it.
 *
 * Two pages had a trail before this — the profile's `.crumbs` and the
 * category page's `.cat-crumbs` — and they were the same eight lines of JSX
 * written twice, neither of them emitting anything a search engine could read.
 * That second half is the point of the component. The reference marketplace
 * emits a BreadcrumbList on every page below the front page, and it is why a
 * result for one of their category pages shows "Thumbtack › Home › Plumbing"
 * instead of a bare URL. A breadcrumb the crawler cannot parse is decoration.
 *
 * SLOTFILL IS ADDED HERE, AND THERE IS NO PROP TO TURN IT OFF.
 * Every caller would otherwise repeat `{ label: 'Slotfill', to: '/' }` as its
 * first item, and the day one of them forgets, the page still looks fine and
 * silently publishes a BreadcrumbList whose root is a category — which is
 * worse than publishing nothing, because it tells a crawler the site is
 * shaped in a way it is not. An opt-out prop is just a slower way to reach
 * the same broken trail, so there is not one.
 */
export default function Crumbs({ items }: { items: Crumb[] }) {
  /**
   * A trail with nothing in it is "Slotfill" on its own, which is not a trail
   * — it is a link to the page the wordmark two inches above already goes to,
   * plus a one-item BreadcrumbList that says nothing. Render neither.
   */
  if (items.length === 0) return null;

  const trail: Crumb[] = [{ label: 'Slotfill', to: '/' }, ...items];

  /**
   * schema.org wants an absolute URL for each step. The origin is read at
   * render rather than hardcoded so a preview deployment describes itself and
   * not production. The guard is for the non-browser case (a test renderer, or
   * the day any of this is pre-rendered); a relative path is still valid JSON,
   * just less useful, so it degrades rather than throwing.
   */
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: c.label,
      // The last step is the current page; schema.org allows it to carry no
      // item, and giving it one would mean inventing a URL for a crumb whose
      // whole meaning is "you are already here".
      ...(c.to ? { item: `${origin}${c.to}` } : {}),
    })),
  };

  return (
    <nav className="shell-crumbs" aria-label="Breadcrumb">
      {trail.map((c, i) => {
        const last = i === trail.length - 1;
        return (
          <span key={`${c.label}-${i}`} className="shell-crumb">
            {i > 0 && <span className="shell-crumb-sep" aria-hidden="true">›</span>}
            {c.to && !last
              ? <Link to={c.to}>{c.label}</Link>
              : <span aria-current={last ? 'page' : undefined}>{c.label}</span>}
          </span>
        );
      })}
      {/*
        dangerouslySetInnerHTML is the only way to put unescaped JSON inside a
        script element — React would otherwise escape the quotes and the
        crawler would read a string of &quot;. That makes the escaping below
        this component's own responsibility rather than React's.
      */}
      <script type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJson(jsonLd) }} />
    </nav>
  );
}

/**
 * JSON for an inline <script>.
 *
 * The parser ends the script at the first literal `</script` in the text,
 * wherever it appears — so a category one day labelled "Repairs </script>"
 * would close the block early and drop whatever followed straight into the
 * page as markup. Rewriting every `<` as a unicode escape prevents that, and
 * `>` and `&` go with it so a comment opener or an entity cannot start
 * anything either.
 * These are ordinary JSON string escapes, so the value a parser gets back is
 * character-for-character what went in.
 */
function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}
