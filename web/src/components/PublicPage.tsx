import type { ReactNode } from 'react';
import SiteFooter from './SiteFooter';
import SiteHeader from './SiteHeader';

/**
 * The frame every ordinary public page sits in: the bar, the main landmark the
 * skip link lands on, and the footer.
 *
 * Two things brought this into being. The first is that the wrapper was written
 * out ten times across five files, always the same four tags in the same order
 * with the same `id="main"` and the same `tabIndex={-1}`, and one of them
 * getting the landmark wrong would have been invisible to everybody who can see
 * the page.
 *
 * The second is worse and is what actually needed fixing. The category, trade,
 * cost and profile pages each returned a bare `<div className="main">` while
 * loading and again on error — no wordmark, no search box, no footer. A visitor
 * whose request failed was left holding a page with an error message and
 * literally nowhere to go from it, which is the one moment they most need the
 * way out. Search.tsx had already worked this out and said so in a comment;
 * rendering the shell around every state rather than instead of some of them is
 * now the only shape available.
 *
 * Not used by the front page, the checkout, the guest thread, the wizard or
 * sign-in. Each of those deliberately differs — Discover feeds the footer its
 * own counted columns, the checkout and the private booking record switch the
 * search and the nav off and carry no footer at all — and a prop for every one
 * of those would make this the union of five layouts rather than the one they
 * share.
 */
export default function PublicPage({ className, children }: {
  /** Extra classes for the <main>, on top of the shared `.main`. */
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className="land">
      <SiteHeader />
      <main className={className ? `main ${className}` : 'main'} id="main" tabIndex={-1}>
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
