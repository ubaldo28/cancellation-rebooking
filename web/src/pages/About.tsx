import { Link } from 'react-router-dom';
import Crumbs from '../components/Crumbs';
import PublicPage from '../components/PublicPage';
import { useDocumentTitle } from '../lib/title';
import '../styles-info.css';

/**
 * About. Route /about.
 *
 * Short on purpose, and the shortness is the content. Nobody has told this
 * codebase when Slotfill was founded, who works on it, where it is registered,
 * how it is funded or how many people use it — SiteFooter.tsx says exactly
 * that in the note over its Company column, which is why Careers, Press and
 * Blog are still inert text there. So this page states what the product is,
 * who it is for and where it runs, and stops.
 *
 * WHAT IS DELIBERATELY ABSENT: a founding story, a mission paragraph, a team,
 * an office, an investor, a headcount, a customer count, a booking count, a
 * "we believe" sentence and a photograph of anybody. Every one of those is
 * either unknown here or unverifiable, and an About page is the last place a
 * marketplace can afford to be caught making something up.
 *
 * The geography is read from the code rather than assumed: COUNTRIES in
 * src/lib/countries.ts holds the United States and nothing else, LAUNCH_STATE
 * is California and the metro in src/lib/seo.ts is Los Angeles.
 */

export default function About() {
  useDocumentTitle('About Slotfill');

  return (
    <PublicPage className="info-page">
      <Crumbs items={[{ label: 'About' }]} />

      <header className="info-head">
        <h1>About Slotfill</h1>
        <p className="info-lede">
          Slotfill is a place to book the hour a cancellation left empty in a
          local trade business's day.
        </p>
      </header>

      <section className="info-sec first" aria-labelledby="a-what">
        <h2 id="a-what">What it is</h2>
        <p>
          Mobile trade businesses — one person, one van, no shopfront — lose
          money to holes in the diary. A job cancels on Thursday morning and
          the two hours it was going to take cannot be sold to anybody, because
          nobody knows they exist. Slotfill is where those hours are listed, at
          the price the business set, for whoever is nearby and wants one.
        </p>
        <p>
          Everything on the site is a real opening in a real diary. Openings
          appear when a job cancels or a day does not fill, so they arrive
          without warning and they do not last. Prices are set by the business
          doing the work. Booking one holds it and takes no money: paying on
          the site is designed and not yet built, so the price is settled
          between the customer and the business. See{' '}
          <Link to="/covered">what is covered</Link> for what changes when it
          is.
        </p>
      </section>

      <section className="info-sec" aria-labelledby="a-who">
        <h2 id="a-who">Who it is for</h2>
        <p>
          On one side, solo mobile trades: detailers, pressure washers, mobile
          mechanics, locksmiths, window and carpet cleaners, gardeners, pool
          and bin services, and the rest of the work that arrives in a van.
          Businesses list their own services, their own hours and their own
          areas, and nothing here sets a price for them.
        </p>
        <p>
          On the other, anybody in range of one of those vans. There is no
          account to create and no password to remember: a booking is held
          together by a link, and that link is the whole of a customer's
          identity here.
        </p>
      </section>

      <section className="info-sec" aria-labelledby="a-where">
        <h2 id="a-where">Where it operates</h2>
        <p>
          Los Angeles, California. That is the only metro with neighbourhood
          pages, and the United States is the only country the sign-up accepts.
          Other countries were deliberately taken out rather than left in:
          each one carries its own licensing, consumer-protection and data
          rules, and being properly usable in one city is worth more than being
          nominally available in six countries nobody has checked.
        </p>
      </section>

      <section className="info-sec" aria-labelledby="a-say">
        <h2 id="a-say">What this page does not say</h2>
        <div className="info-not">
          <h3>Not stated, because it is not known here</h3>
          <ul className="info-list">
            <li>
              No founding date, no founding story and no team page. Nothing in
              this product records any of that, so nothing on this page invents
              it.
            </li>
            <li>
              No count of businesses, customers or bookings. The front page and
              each trade page count what is genuinely open at the moment you
              load them and print that figure; a page like this one cannot
              count anything, so it does not try.
            </li>
            <li>
              No press coverage, no investors and no awards.
            </li>
          </ul>
        </div>
        <p className="note">
          The registered company name, address and contact details are not set
          out anywhere in this product yet. They are marked as missing on{' '}
          <Link to="/terms">Terms</Link> and <Link to="/privacy">Privacy</Link>{' '}
          rather than filled in with something plausible.
        </p>
      </section>

      <footer className="info-foot">
        <p>
          <Link to="/">Browse what is open</Link>
          {' · '}
          <Link to="/pros">For businesses</Link>
          {' · '}
          <Link to="/covered">What is covered</Link>
          {' · '}
          <Link to="/help">Help</Link>
        </p>
      </footer>
    </PublicPage>
  );
}
