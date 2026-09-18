import { Link } from 'react-router-dom';
import Crumbs from '../components/Crumbs';
import PublicPage from '../components/PublicPage';
import { useMetros } from '../lib/metros';
import { useDocumentTitle } from '../lib/title';
import '../styles-info.css';

/**
 * About. Route /about.
 *
 * Short on purpose, and the shortness is the content. Nobody has told this
 * codebase when Round The Way was founded, who works on it, how it is funded
 * or how many people use it — SiteFooter.tsx says exactly that in the note
 * over its Company column, which is why Careers, Press and Blog are still
 * inert text there. Where it is registered is no longer on that list, and the
 * answer is that it is not: one person trading under the name, which Terms
 * section 12 and Privacy section 10 now state outright. So this page states
 * what the product is, who it is for and where it runs, and stops.
 *
 * WHAT IS DELIBERATELY ABSENT: a founding story, a mission paragraph, a team,
 * an office, an investor, a headcount, a customer count, a booking count, a
 * "we believe" sentence and a photograph of anybody. Every one of those is
 * either unknown here or unverifiable, and an About page is the last place a
 * marketplace can afford to be caught making something up.
 *
 * The geography is read rather than assumed. COUNTRIES in
 * src/lib/countries.ts holds the United States and nothing else; the places
 * are the metro records, fetched here rather than written down, because this
 * page said "Los Angeles, California. That is the only metro" on the day a
 * second one opened and nothing about the sentence looked wrong.
 *
 * THE REFERENCE'S ABOUT PAGE IS FOUR MODULES AND THREE OF THEM ARE NUMBERS.
 * A mission sentence; "who we serve", split into customers, pros and
 * community, each carrying a quotation from a named person; a band of eight
 * figures — half a billion raised, a six-hundred-billion-dollar industry,
 * 300,000 pros, 90 million projects, 12 million five-star reviews, a thousand
 * employees; then links to how-it-works, careers and press.
 *
 * Every single figure in that band is a thing this business does not have, and
 * an About page is the last place on a site where a made-up number can be
 * forgiven — it is the page somebody opens specifically to find out who they
 * are dealing with. So the band is kept as a position and filled with the only
 * numbers that are true here, which are zeroes and a one: no completed jobs,
 * no reviews, one person. "Where it stands today" is that module.
 * A visitor deciding whether to trust this site is better served by it than by
 * anything a mission statement could have said, and it is the section that
 * would be quietly deleted first if this page ever started drifting.
 *
 * "Who we serve" keeps its shape as the two sides of the market, and their
 * quotations are simply absent: there is nobody to quote and a composite
 * customer is a fabricated testimonial with the serial number filed off.
 * Careers, press and a leadership grid have no honest counterpart at all, so
 * they have none here — SiteFooter.tsx leaves the same three as inert text for
 * the same reason.
 */

export default function About() {
  useDocumentTitle('About Round The Way');
  const metros = useMetros();

  return (
    <PublicPage className="info-page">
      <Crumbs items={[{ label: 'About' }]} />

      <header className="info-head">
        <h1>About Round The Way</h1>
        <p className="info-lede">
          Round The Way is a place to book the hour a cancellation left empty in a
          local trade business's day.
        </p>
      </header>

      <section className="info-sec first" aria-labelledby="a-what">
        <h2 id="a-what">What it is</h2>
        <p>
          Mobile trade businesses — one person, one van, no shopfront — lose
          money to holes in the diary. A job cancels on Thursday morning and
          the two hours it was going to take cannot be sold to anybody, because
          nobody knows they exist. Round The Way is where those hours are listed, at
          the price the business set, for whoever is nearby and wants one.
        </p>
        <p>
          Everything on the site is a real opening in a real diary. Openings
          appear when a job cancels or a day does not fill, so they arrive
          without warning and they do not last. Prices are set by the business
          doing the work. Booking one holds it and pays for it: the customer
          pays the listed price by card there and then, and Round The Way holds
          that money until the job is done and then pays the business. See{' '}
          <Link to="/covered">what is covered</Link> for how much comes back if
          somebody cancels.
        </p>
      </section>

      {/* --- why -----------------------------------------------------------
          THE MISSION SLOT, WITHOUT A MISSION SENTENCE IN IT. What goes here on
          the reference's page is a claim about helping millions of people
          confidently care for their homes, which is a sentence no reader can
          check and no company can be held to. What can go here instead is the
          argument the product is actually making — an argument about the
          alternatives, which anybody who has used one can check against their
          own experience. It is also the only part of this page that explains
          why the site behaves the way it does everywhere else. */}
      <section className="info-sec" aria-labelledby="a-why">
        <h2 id="a-why">Why it works this way</h2>
        <p>
          The usual way to find a mobile trade online is a lead board: you
          describe the job, the site sells your details to several businesses,
          and you wait to be rung by people bidding for the work. It is a
          reasonable model and it has two costs. The customer gets a queue of
          phone calls instead of an appointment. The business pays for the
          privilege of entering a lottery, whether or not it wins, and prices
          that cost back into the job.
        </p>
        <p>
          Round The Way is the other arrangement: no bidding, no leads and no
          quotes to buy. A business publishes an hour it genuinely has free at
          a price it has already decided on, and somebody takes it. That single
          choice is why there is no lead fee on the business side, why prices
          are visible before anybody talks to anybody, and why an opening
          disappears when it is booked rather than sitting there collecting
          enquiries.
        </p>
        <p className="note">
          The trade-off is stated rather than hidden: this only works for jobs
          that can be priced and timed in advance, which is why the site asks
          every business how long a service takes and what happens about parts,
          and why work that genuinely needs a survey first fits it badly.
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
          On the other, anybody in range of one of those vans. Looking around
          asks for nothing at all. Booking needs an account and a card, and an
          account here is an email address and the six digits we send to it —
          no password to choose and none to remember. It is made at the moment
          somebody books rather than before they have decided to, which is the
          only part of “no account needed” that was ever true. Every booking
          also gets its own link, and that link opens it on any phone whether
          or not anybody is signed in.
        </p>
      </section>

      <section className="info-sec" aria-labelledby="a-where">
        <h2 id="a-where">Where it operates</h2>
        {/* Listed from the metro records rather than written into the
            sentence. Each one names its own state, so a place opened outside
            California would read correctly here without this page being
            edited — which is the mistake the previous version of it made. */}
        {metros.length > 0 && (
          <ul className="info-list">
            {metros.map((m) => (
              <li key={m.slug}>
                <a href={m.path}>{m.name}, {m.state}</a>
              </li>
            ))}
          </ul>
        )}
        <p>
          Those are the places with neighbourhood pages, and the United States
          is the only country the sign-up accepts. Other countries were
          deliberately taken out rather than left in: each one carries its own
          licensing, consumer-protection and data rules, and being properly
          usable where the vans actually are is worth more than being
          nominally available in six countries nobody has checked.
        </p>
      </section>

      {/* --- the stat band, inverted ----------------------------------------
          See the note at the top of this file: this is the position the
          reference gives to eight figures about its size, and the only honest
          figures here are zeroes. They are stated as facts rather than as
          apologies, because for the person reading this page they are the most
          decision-relevant thing on it — somebody is about to consider letting
          a stranger from this site into their house, or spending an evening
          listing their business on it, and "nobody has done either yet" is
          what they need before anything else on the site can be weighed. */}
      <section className="info-sec" aria-labelledby="a-now">
        <h2 id="a-now">Where it stands today</h2>
        <p>
          This is a marketplace before it has started, and the specifics matter
          more than the word:
        </p>
        <ul className="info-list">
          <li>
            <strong>No job has been completed through this site.</strong> Not
            one, in either city.
          </li>
          <li>
            <strong>There are no real reviews, and no ratings behind them.</strong>{' '}
            A review can only come from a booking that completed here, so there
            are none. The sample businesses used to show how the pages look
            carry sample reviews, and every one of them is labelled as a sample
            where it appears.
          </li>
          <li>
            <strong>Payments are real, and so are the cancellation
            charges.</strong> Booking charges the full listed price to a card
            at that moment. Round The Way holds it and pays the business after
            the job, and cancelling inside 12 hours gets you a quarter of it
            back;{' '}
            <Link to="/covered">what is covered</Link> sets out every rung of
            that.
          </li>
          <li>
            <strong>Nobody is background-checked, identity-checked or
            verified.</strong> No licence is checked against the board that
            issued it and no insurer is ever rung.{' '}
            <Link to="/safety">Safety</Link> says what that means and how to
            check a business yourself, which takes about a minute.
          </li>
          <li>
            <strong>It is run by one person.</strong> There is no support desk,
            no out-of-hours line and no promised reply time, here or anywhere
            else on the site.
          </li>
        </ul>
        <p className="note">
          None of that is a coming-soon notice. It is what the site is this
          week, and every page that would otherwise imply differently — the
          checkout, the pricing pages, the page a business reads before signing
          up — says the same thing in the same words.
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
        {/* THIS NOTE USED TO SAY THE OPPOSITE, and had to move the day the
            answer arrived. It read "The registered company name, address and
            contact details are not set out anywhere in this product yet. They
            are marked as missing on Terms and Privacy" — which was true while
            both pages carried a [REGISTERED ADDRESS] placeholder, and false
            the moment they stopped. There is no registered company name to
            print, the contact address has been on both pages for a while, and
            the postal address is deliberately withheld rather than unknown.
            An About page caught still reporting a gap that has been closed is
            making exactly the kind of stale claim this page exists to avoid. */}
        <p className="note">
          There is no registered company name or number to print here, and no
          office address: Round The Way is one person trading under that name,
          working from home. <Link to="/terms">Terms</Link> and{' '}
          <Link to="/privacy">Privacy</Link> both say so, give the mailbox that
          reaches that person, and explain why a home address is not published
          on a page anybody can read. There is no team page, no careers page
          and no press page for the same reason there is no founding date: one
          person, and nothing to put on them.
        </p>

        {/* The reference ends on three link cards — how it works, careers,
            press. Two of those three have nothing behind them here, so the
            slot keeps the shape and carries the two ways in that are real. */}
        <div className="info-do">
          <Link className="btn" to="/">Browse what is open</Link>
          <Link className="btn quiet" to="/pros">List your business</Link>
        </div>
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
