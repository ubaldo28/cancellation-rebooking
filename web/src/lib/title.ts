import { useEffect } from 'react';

/**
 * The document title, per route.
 *
 * The Worker hands the same index.html to every React route, so every page in
 * the app answered to "Slotfill — book the van that's already coming": the tab
 * strip, the back-button history, a bookmark of a cost guide and a shared link
 * to a business's profile all said the same eleven words. The server-rendered
 * /near pages already title themselves; these are the ones that could not.
 *
 * The site name is appended here rather than written into each caller, so the
 * separator cannot drift and a page cannot forget it. The default is read from
 * the document once at load rather than repeated as a constant, which keeps it
 * the same string index.html ships and means changing it there is enough.
 */
const DEFAULT_TITLE = typeof document === 'undefined' ? '' : document.title;
const SITE = 'Slotfill';

/**
 * Sets the title while the calling page is mounted and puts the default back
 * when it unmounts, so a route that says nothing about itself is not left
 * wearing the last one's name. Pass null for the front page, which is what the
 * default already describes.
 */
export function useDocumentTitle(title: string | null): void {
  useEffect(() => {
    if (title) document.title = `${title} | ${SITE}`;
    return () => { document.title = DEFAULT_TITLE; };
  }, [title]);
}
