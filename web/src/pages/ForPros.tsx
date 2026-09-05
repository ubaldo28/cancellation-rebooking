import { Link } from 'react-router-dom';
import Crumbs from '../components/Crumbs';
import PaymentState from '../components/PaymentState';
import PublicPage from '../components/PublicPage';
import { useDocumentTitle } from '../lib/title';
import '../styles-info.css';

/**
 * How Slotfill works for a business. Route /pros.
 *
 * This is the page the footer's "How Slotfill works for pros" has been
 * pointing at /join for want of anywhere better. /join is a five-screen
 * wizard: it is where somebody goes once they have decided, and it is a poor
 * place to decide. This page is the deciding.
 *
 * WHAT IT IS NOT ALLOWED TO SAY, and this is the whole discipline of the file:
 *
 *   No earnings. Not "£800 a month", not "fill 3 more slots a week", not a
 *   range, not an average, not an example calculation with plausible numbers
 *   in it. Nobody has measured any of that and a number on a sign-up page is
 *   read as a promise.
 *   No counts. Not how many businesses are here, not how many customers, not
 *   how many bookings. The front page and the trade pages count what they can
 *   see and print that; a static page cannot see anything, so it counts
 *   nothing.
 *   No testimonials. There are none, and inventing one is the single fastest
 *   way to make everything else on the site unbelievable.
 *   No response-time or lead-volume promise of any kind.
 *
 * Every mechanism described below is in the product:
 *   web/src/pages/Join.tsx           the five screens and what each asks for.
 *   web/src/components/OnlineSwitch  the availability switch: three hours,
 *                                    five minutes to answer, never assigned.
 *   src/lib/bypass.ts                listingBlock() — card, location, vehicle,
 *                                    unpaid fees — and the fee ladder itself.
 *   src/lib/standing.ts              NEEDS_CARD_OPERATOR, the suspensions.
 *   src/lib/parts.ts                 quoting a part mid-job.
 *   src/lib/startcode.ts             the code and the van.
 *   src/lib/credentials.ts           what a profile can record, and the fact
 *                                    that nothing here verifies any of it.
 */

export default function ForPros() {
  useDocumentTitle('How Slotfill works for pros');

  return (
    <PublicPage className="info-page">
      <Crumbs items={[{ label: 'For businesses' }]} />

      <header className="info-head">
        <h1>How Slotfill works for a business</h1>
        <p className="info-lede">
          Slotfill sells the hour a cancellation left empty. You post the time
          you have free, at a price you set, and somebody nearby books it before
          you drive anywhere.
        </p>
      </header>

      {/* --- the idea ----------------------------------------------------- */}
      <section className="info-sec first" aria-labelledby="p-idea">
        <h2 id="p-idea">The hole in the day</h2>
        <p>
          A Thursday job cancels at nine in the morning. The van is already
          out, the route is already planned, and there is now a two-hour gap in
          the middle of it that will earn nothing. That gap is what this site
          is for.
        </p>
        <p>
          When a job cancels, the app works out what fits the hole and who is
          near enough to take it, and the opening goes up on the public pages
          for that trade and that neighbourhood. An empty day that never filled
          works the same way. Somebody books the slot and it lands in your
          diary.
        </p>
      </section>

      {/* --- what you control --------------------------------------------- */}
      <section className="info-sec" aria-labelledby="p-control">
        <h2 id="p-control">What you decide</h2>
        <ul className="info-list">
          <li>
            <strong>Your prices.</strong> You list your own services with your
            own price and your own duration, and that price is what the
            customer pays. Nothing here discounts your work for you or prices
            it against anybody else.
          </li>
          <li>
            <strong>Where you work.</strong> Service areas by name and
            postcode. Openings are only ever shown to people those areas can
            reach.
          </li>
          <li>
            <strong>When you work.</strong> Working hours per day, and the jobs
            already in your diary so nothing is offered on top of them.
          </li>
          <li>
            <strong>How long a job takes.</strong> Duration is what decides
            which cancelled slot a job can be dropped into, so it is asked for
            on every service rather than guessed at.
          </li>
          <li>
            <strong>What happens about parts.</strong> Three answers per job:
            no parts, parts already in the price, or the part cannot be known
            until you look. Pick the third and you send the customer a price
            from the driveway, and they approve it in the app before anything
            is fitted.
          </li>
        </ul>
      </section>

      {/* --- open right now ------------------------------------------------ */}
      <section className="info-sec" aria-labelledby="p-now">
        <h2 id="p-now">The "open right now" switch</h2>
        <p>
          Separate from your working hours, and it is for the hour you are
          standing in a van with nothing to do. Flip it and nearby customers
          can send you a job on the spot. Four rules, all of them stated before
          you flip it rather than discovered afterwards:
        </p>
        <ul className="info-list">
          <li>It turns itself off after three hours.</li>
          <li>Accepting a job turns it off — you are driving now.</li>
          <li>
            Nothing is ever assigned to you. Every request is an offer you tap
            or ignore.
          </li>
          <li>
            You have five minutes to answer one, then it goes to somebody else.
            The countdown is the biggest thing on the card for that reason.
          </li>
        </ul>
      </section>

      {/* --- getting paid --------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="p-paid">
        <h2 id="p-paid">Getting paid</h2>
        <PaymentState audience="pro" />
        <p>
          What is designed, and what the rest of this page assumes: the customer
          pays for the labour when they book, on the site; Slotfill holds it and
          you are paid after the job. No cash at the door, no invoice to send
          and nobody to remind — and a customer who has already paid in full is
          a customer who turns up. None of that runs yet, so today a booking
          reaches you with the price agreed and the settling of it between the
          two of you.
        </p>
        <p>
          A part you could not price in advance is quoted in the booking's own
          messages and nothing is fitted until the customer approves it there.
          That much happens now; the charge that will follow the approval is
          waiting on the same thing everything else here is. It is the
          conversation that otherwise happens in cash on a driveway, and this is
          where it happens instead.
        </p>
      </section>

      {/* --- what is asked of you -------------------------------------------- */}
      <section className="info-sec" aria-labelledby="p-asked">
        <h2 id="p-asked">What is asked of you</h2>
        <p>
          Four things before your openings go up, and each one exists for a
          reason a customer would recognise.
        </p>
        <ul className="info-list">
          <li>
            <strong>Your vehicle: make, colour and plate.</strong> It is what
            somebody standing behind their own front door checks before opening
            it. About twenty seconds.
          </li>
          <li>
            <strong>Location sharing on.</strong> It shows a waiting customer
            that the van is coming, and it is what proves you were where you
            said you were if a job is ever disputed. With it off there is no
            way to tell an honest cancellation from a job done off the books,
            so openings do not go up.
          </li>
          <li>
            <strong>A card on file.</strong> Nothing is charged to it for using
            the site, and nothing has ever been charged to it at all — no money
            moves through Slotfill yet. It is there for one thing: cancelling a
            job late.
          </li>
          <li>
            <strong>The start code, at the door.</strong> The customer reads
            four digits off their phone and you type them in to start the job.
            It is also your record that you were there.
          </li>
        </ul>

        <h3>Cancelling late will cost you, on the same ladder it costs them</h3>
        <p>
          No fee is collected today; this is the ladder it will run on. More
          than 48 hours out costs nothing. Inside 48 hours it is a quarter of
          the job, inside 12 hours three quarters, and the whole job once you
          have said you arrived — with a floor of $15 and never more than the
          job itself. Those are the same amounts a customer forfeits when they
          are the one cancelling, which is the point: whatever it would cost
          them, it costs you.
        </p>
        <p>
          A fee will be taken out of your next payout rather than charged to
          your card, because that is money already being held for you. The card
          is only used when there is no payout to take it from. An unpaid fee
          stops new openings going up until it is settled — and it never touches
          work already in the diary. Those customers still get their
          appointment.
        </p>
        <p className="note">
          A no-show is not billed. It is a suspension: three days, then seven,
          then thirty, then the account closes to new bookings — and only ever
          after a customer files a report and a person here upholds it. Nothing
          on that ladder is applied by a sweep looking for jobs nobody marked as
          arrived.
        </p>
      </section>

      {/* --- your page ------------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="p-page">
        <h2 id="p-page">Your page, and what is on it</h2>
        <p>
          Signing up gives you a public profile with your services, your prices,
          your areas and the photographs of finished work you add. Reviews can
          only come from a completed booking made through this site, one per
          booking — which is why there are not many of them and why the ones
          there are mean something.
        </p>
        <p>
          You can record a licence, an insurer and a background check on that
          page. Nothing here verifies any of it, and the page says so next to
          the details: what a business states about its own licensing is its own
          claim, and the issuing board's public register is where a customer can
          check it. That cuts both ways — nobody else on this site has been
          vetted either.
        </p>
      </section>

      {/* --- what we do not offer --------------------------------------------- */}
      <section className="info-sec" aria-labelledby="p-not">
        <h2 id="p-not">What this page is not telling you</h2>
        <div className="info-not">
          <h3>Not promised</h3>
          <ul className="info-list">
            <li>
              <strong>We do not tell you what you will earn.</strong> No
              figures, no averages, no worked example. Nobody has measured it,
              and a number here would be a guess wearing a suit.
            </li>
            <li>
              <strong>We do not promise you any bookings at all.</strong> An
              opening is shown to whoever is looking at that trade in that
              neighbourhood, and some of them will not be booked.
            </li>
            <li>
              <strong>There are no testimonials on this page</strong> and no
              count of how many businesses are here. The trade and
              neighbourhood pages count what is actually open right now and
              print that; they say plainly when the answer is nothing.
            </li>
            <li>
              <strong>We are not an employer or an agency.</strong> You are not
              staff, the work is yours, the customer relationship is yours and
              so is the liability. Slotfill has no insurance that covers you or
              your work.
            </li>
          </ul>
        </div>
      </section>

      {/* --- the way in --------------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="p-start">
        <h2 id="p-start">Signing up</h2>
        <p>
          Five short screens. The first asks for three things — an email
          address, your business name and the country you work in. There is no
          password: signing in is a link emailed to that address. The four after
          it are what you do and where, what you sell and for how much, the
          hours you work, and the jobs already in your diary. You can stop
          part way through and come back to the screen you left.
        </p>
        <div className="info-do">
          <Link className="btn" to="/join">List your business</Link>
          <Link className="btn quiet" to="/signin">Sign in</Link>
        </div>
      </section>

      <footer className="info-foot">
        <p>
          <Link to="/covered">What is covered</Link>
          {' · '}
          <Link to="/safety">Safety</Link>
          {' · '}
          <Link to="/help">Help</Link>
          {' · '}
          <Link to="/terms">Terms</Link>
        </p>
      </footer>
    </PublicPage>
  );
}
