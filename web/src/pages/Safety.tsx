import { Link } from 'react-router-dom';
import Crumbs from '../components/Crumbs';
import PublicPage from '../components/PublicPage';
import { useDocumentTitle } from '../lib/title';
import '../styles-info.css';

/**
 * Safety. Route /safety.
 *
 * Two audiences at once, and the page is arranged that way on purpose. A
 * customer is opening their front door to a stranger. A business is one
 * self-employed person driving alone to an address they have never been to,
 * and they are at least as exposed — which is the half of "safety" that
 * marketplace pages usually skip, so it gets its own section here.
 *
 * WHERE EVERY CLAIM COMES FROM:
 *   src/lib/startcode.ts  the four-digit code, the vehicle a customer checks.
 *   src/lib/settlement.ts confirmArrival — two-sided, never required.
 *   src/lib/proof.ts      job photographs, private to the two people on the
 *                         booking; work_photos is a different table so a
 *                         customer's hallway cannot reach a public profile.
 *   src/lib/redact.ts     contact details removed from messages, and the
 *                         honest note that it is not unbeatable.
 *   src/lib/images.ts     EXIF/GPS stripped, with the HEIC caveat kept.
 *   src/lib/track.ts      the customer sees a coarse position in a window
 *                         around their own appointment, never a live dot.
 *   src/lib/standing.ts   the suspension ladder, 3/7/30 then a ban.
 *   src/lib/guestlink.ts  ten wrong links and the door shuts for 15 minutes.
 *   src/lib/turnstile.ts  a bot check on the doors, never in the corridor.
 *
 * THE LICENSING SENTENCE IS NOT REWRITTEN HERE. src/lib/seo.ts already says it
 * on every server-rendered page — "Nothing here is verified by us. Licence and
 * insurance details are what a business says about itself; the issuing board's
 * public register is the place to check one." This page says the same thing in
 * the same terms, because two pages of the same site disagreeing about whether
 * anybody checks a licence is worse than either version alone.
 */

export default function Safety() {
  useDocumentTitle('Safety');

  return (
    <PublicPage className="info-page">
      <Crumbs items={[{ label: 'Safety' }]} />

      <header className="info-head">
        <h1>Safety</h1>
        <p className="info-lede">
          A booking here puts a stranger on somebody's driveway and one
          self-employed person at an address they have never been to. These are
          the things the site actually does about that, and the things it does
          not do.
        </p>
      </header>

      {/* --- knowing who is at the door ---------------------------------- */}
      <section className="info-sec first" aria-labelledby="s-door">
        <h2 id="s-door">Knowing who is at your door</h2>
        <ul className="info-list">
          <li>
            <strong>The van, before anyone arrives.</strong> A business cannot
            put openings up at all until it has entered the make, colour and
            plate of its vehicle. You see those details on your booking, so
            what pulls up either matches or it does not — and you decide
            whether to open the door before there is anyone behind it.
          </li>
          <li>
            <strong>A start code only you can see.</strong> Four digits on your
            booking page. They read it out; you do not. The job starts when
            they type it in, and after five wrong tries the code stops working
            and they have to message you.
          </li>
          <li>
            <strong>Arrival, confirmed from both sides.</strong> They mark that
            they are there; you can confirm it from your own page. You never
            have to — the work can start without it — but when you do, the
            record has two people saying it rather than one.
          </li>
          <li>
            <strong>Photographs, before and during and after.</strong> Either
            side can take them, and they are what a dispute is decided on
            instead of two accounts of the same afternoon.
          </li>
        </ul>
      </section>

      {/* --- what stays private ------------------------------------------ */}
      <section className="info-sec" aria-labelledby="s-private">
        <h2 id="s-private">What stays private</h2>
        <ul className="info-list">
          <li>
            <strong>Neither side gets the other's phone number or email
            address.</strong> There is no number exchange and no SMS between
            you. You talk in the booking's own conversation or not at all.
          </li>
          <li>
            <strong>Contact details are removed from messages.</strong> A phone
            number, an email address, a payment-app handle or an outside link
            typed into the chat is stored with that part already taken out, and
            whoever sent it is told. It is removed rather than the message
            being rejected, because bouncing it back only teaches people to try
            again in a form that gets through.
          </li>
          <li>
            <strong>Photographs of the inside of a home are private.</strong>{' '}
            Job photographs are visible to the two people on that booking and
            to a dispute review, and to nobody else — never on a public
            profile, never in search, never reused as advertising. A business's
            portfolio is a different set of pictures kept in a different place
            precisely so the two can never be joined by accident. The only way
            a job photograph becomes public is a customer choosing to attach
            one to their own review, one at a time.
          </li>
          <li>
            <strong>Location data is stripped out of uploads.</strong> Every
            photograph is rebuilt from its image data on the way in, and the
            EXIF, GPS, XMP and IPTC blocks are dropped rather than copied
            across. What that cannot do is change what is visible in the
            picture: a photograph of a front door with the number on it is
            still a photograph of a house number.
          </li>
          <li>
            <strong>A customer never gets a live map of a self-employed
            person.</strong> You see roughly where the van is, rounded to about
            110 metres, only in a window around the appointment you booked, and
            only if that business has location sharing switched on. There is no
            trail, no history and no dot to follow around all day.
          </li>
          <li>
            <strong>Home addresses do not sit here forever.</strong> The street
            line and the map coordinates of a finished job are deleted ninety
            days afterwards; the photographs go at ninety days too, and the
            conversation at a hundred and eighty.{' '}
            <Link to="/privacy">Privacy</Link> sets out all of it, and how to
            delete your data before any of those clocks run out.
          </li>
        </ul>
      </section>

      {/* --- for the person driving --------------------------------------- */}
      <section className="info-sec" aria-labelledby="s-pro">
        <h2 id="s-pro">If you are the one driving to the address</h2>
        <p>
          Most of this page is the same protection read from the other side.
          The parts that are specific to a business:
        </p>
        <ul className="info-list">
          <li>
            The customer has your business name and your van. They do not have
            your phone number, your email address or your home address, and
            nothing on this site gives them any of those.
          </li>
          <li>
            Nothing is ever assigned to you. An instant request is an offer you
            accept or ignore, and it goes to somebody else if you do nothing.
          </li>
          <li>
            The photographs are as much your record as theirs. A job that
            happened leaves pictures, and that is what answers "nobody ever
            came" three weeks later.
          </li>
          <li>
            Location sharing is a switch you own and it is off until you turn
            it on. It is also a condition of listing, and the reason is stated
            plainly rather than buried: with it off there is no way to tell an
            honest cancellation from a job done off the books.
          </li>
          <li>
            The no-show ladder runs in both directions. A customer who does not
            answer the door has cost you an afternoon, and a confirmed report
            suspends their ability to book here on the same three, seven and
            thirty day rungs.
          </li>
        </ul>
      </section>

      {/* --- accounts and abuse ------------------------------------------- */}
      <section className="info-sec" aria-labelledby="s-accounts">
        <h2 id="s-accounts">Accounts, links and abuse</h2>
        <ul className="info-list">
          <li>
            <strong>Suspensions.</strong> A confirmed no-show suspends the
            account for three days, then seven, then thirty; a fourth closes it
            to new bookings. Reports are filed by people and upheld by people —
            nothing on that ladder happens automatically.
          </li>
          <li>
            <strong>Your booking link is the key to your booking.</strong> It
            opens the conversation, the photographs, the address and the start
            code, so treat it the way you would treat a password. Ten wrong
            links from one place and that place is locked out for fifteen
            minutes.
          </li>
          <li>
            <strong>A bot check sits on the forms that can cost somebody
            money</strong> — opening a conversation, placing an order, ringing
            a business's phone, setting up an alert. It is deliberately not in
            the middle of a live job.
          </li>
          <li>
            <strong>There is no password to steal on the business side.</strong>{' '}
            Signing in is a link emailed to the address on the account.
          </li>
        </ul>
      </section>

      {/* --- what we do not check ------------------------------------------ */}
      <section className="info-sec" aria-labelledby="s-not">
        <h2 id="s-not">What we do not check</h2>
        <p>
          This is the section to read before deciding how much of the above to
          rely on.
        </p>

        <div className="info-not">
          <h3>Not checked by us</h3>
          <ul className="info-list">
            <li>
              <strong>Licences.</strong> Nothing on this site verifies a trade
              licence. Licence and insurance details are what a business says
              about itself; the issuing board's public register is the place to
              check one. Where California licenses a trade, our pages name the
              board so you can look it up — the Contractors State License Board
              and the others — and that is as far as it goes.
            </li>
            <li>
              <strong>Insurance.</strong> A business can type its insurer and
              policy number onto its profile. Nobody here rings the insurer, and
              a policy shown on a profile is not cover for you.
            </li>
            <li>
              <strong>Identity and background.</strong> There is no identity
              check, no background check run by us, and no interview. Where a
              profile shows a background check, that is the business telling you
              it had one done, with the provider it names.
            </li>
            <li>
              <strong>The quality of anybody's work.</strong> No inspections, no
              approved list, no badge that means we looked. The ratings and
              reviews on a profile come from completed bookings on this site,
              one per booking, and that is the only quality signal here.
            </li>
            <li>
              <strong>Whether a customer is who they say they are.</strong> A
              customer books with a phone number and no account, and a new
              number is a clean record. That is a real limitation and it is
              worth knowing rather than glossing over: what the standing ladder
              deters is casual, not determined.
            </li>
            <li>
              <strong>Everything typed into a message.</strong> The contact-detail
              filter is not unbeatable and nothing that reads free text ever is.
              Somebody determined will spell a number out in words or split it
              over three messages. It raises the effort and it flags the
              attempts; it is not a sealed wall.
            </li>
          </ul>
        </div>

        <p>
          If something about a booking feels wrong, do not go ahead with it. You
          are never obliged to let anybody in, and cancelling a job you have not
          started costs less than the alternative. In an emergency, call the
          emergency services — Slotfill has no line that reaches anybody faster
          than 911 does.
        </p>
      </section>

      <footer className="info-foot">
        <p>
          <Link to="/covered">What is covered</Link>
          {' · '}
          <Link to="/help">Help</Link>
          {' · '}
          <Link to="/privacy">Privacy</Link>
          {' · '}
          <Link to="/terms">Terms</Link>
        </p>
      </footer>
    </PublicPage>
  );
}
