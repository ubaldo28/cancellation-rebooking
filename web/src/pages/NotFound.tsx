import { Link, useLocation } from 'react-router-dom';
import PublicPage from '../components/PublicPage';
import { useNoIndex } from '../lib/noindex';
import { useDocumentTitle } from '../lib/title';

/**
 * The page an address with nothing behind it gets.
 *
 * WHAT WAS HERE BEFORE, AND WHY IT WAS WORSE THAN NOTHING. The catch-all route
 * and the metro page both answered an unknown URL with
 * `<Navigate to="/" replace />` — a client-side redirect to the front page, on
 * top of the 200 the assets binding had already sent. That is the exact shape
 * Google documents as a soft 404: a request that succeeded, for a URL that does
 * not exist, which then quietly becomes a different page. The site is judged on
 * it twice over — the dead URL gets indexed as a duplicate of the front page,
 * and the front page acquires a crowd of addresses that are not it. It also
 * lied to the reader: somebody who mistyped one character was put on the home
 * page with nothing anywhere saying that the thing they asked for was not
 * found, which reads as the site having lost their page rather than never
 * having had it.
 *
 * The `/:metro` route is what makes this more than a corner case. It matches
 * any single-segment URL, so every typo, every stale link and every path some
 * other site invented for us lands here.
 *
 * SO THIS PAGE SAYS SO, AND STAYS PUT. No redirect: the address in the bar is
 * still the address that was asked for, which is the only way somebody can see
 * what they mistyped or send it to whoever gave them the link. `useNoIndex`
 * keeps it out of the index for as long as it is on screen — read the comment
 * there for the half of the problem a browser cannot fix, which is that the
 * response is still a 200.
 *
 * The ways out are the two a stranger can actually use: what is open near
 * them, and the catalogue. A search box is already in the header above.
 */
export default function NotFound() {
  const { pathname } = useLocation();
  useDocumentTitle('Page not found');
  useNoIndex();

  return (
    <PublicPage className="nf-page">
      <div className="blank" style={{ marginTop: 48 }}>
        <h1 style={{ fontSize: 22, margin: '0 0 10px' }}>Page not found</h1>
        {/*
          The path is printed back rather than described, because the whole
          value of not redirecting is that the reader can see the character
          they got wrong. React escapes it, so a path built to look like markup
          arrives as the text it is.
        */}
        <p style={{ margin: '0 0 14px' }}>
          There is nothing at <code>{pathname}</code>. It has probably been
          mistyped, or it is a link to something that has since been taken down.
        </p>
        <p style={{ margin: '0 0 18px' }}>
          Round The Way is mobile trades that drive to you — detailers,
          locksmiths, mobile mechanics and the rest — listing the appointments a
          cancellation left open.
        </p>
        <p>
          <Link className="btn" to="/">See what is open near you</Link>
          {' '}
          <Link className="btn quiet" to="/browse">Every service</Link>
        </p>
      </div>
    </PublicPage>
  );
}
