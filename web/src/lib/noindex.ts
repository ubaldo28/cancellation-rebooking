import { useEffect } from 'react';

/**
 * Keeps the page out of the index for as long as the calling component is
 * mounted.
 *
 * THE PROBLEM THIS ONLY HALF SOLVES, said plainly so nobody thinks it is
 * solved. An address this app cannot resolve — a mistyped metro, a category
 * that was renamed, a profile whose business took their page down, anything at
 * all that reaches the catch-all — is still answered with HTTP 200, because
 * the status code is decided in the Worker (src/index.ts) and by the assets
 * binding behind it, and a React component cannot reach either. A page that
 * says "there is nothing here" under a 200 is the textbook soft 404: a search
 * engine is being told the request succeeded and then shown an apology, and it
 * responds by distrusting the site's status codes generally rather than only
 * this URL's.
 *
 * `noindex,follow` is the part the browser can still do. It keeps the dead
 * address out of the index and lets the crawler keep walking the links out of
 * it, which are the only useful thing on such a page. It does not, and cannot,
 * turn the 200 into a 404 — that fix lives in the Worker.
 *
 * The tag is appended rather than written over any existing one. The Worker's
 * own head already carries a robots meta on every page it renders, and when
 * two are present a search engine takes the most restrictive of them, so
 * appending gives the right answer without this hook having to know what the
 * server said. Removing it when the condition goes away matters just as much:
 * a page that retries its request and succeeds, or a client-side navigation
 * off a dead address onto a real one, must not leave the real page wearing the
 * apology's robots tag.
 *
 * `on` is an argument rather than a reason not to call the hook, because the
 * pages that need this decide between "not found", "failed" and "here it is"
 * in branches that return early — and a hook called in one branch and not
 * another is the classic way to break the order React relies on.
 */
export function useNoIndex(on = true): void {
  useEffect(() => {
    if (!on) return;
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex,follow';
    document.head.appendChild(meta);
    return () => { meta.remove(); };
  }, [on]);
}
