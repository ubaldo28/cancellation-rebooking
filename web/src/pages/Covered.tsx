import { Link } from 'react-router-dom';
import Crumbs from '../components/Crumbs';
import PaymentState from '../components/PaymentState';
import PublicPage from '../components/PublicPage';
import { useDocumentTitle } from '../lib/title';
import '../styles-info.css';

/**
 * What is covered, and what is not. Route /covered.
 *
 * THE REFERENCE MARKETPLACE CALLS ITS VERSION OF THIS PAGE A GUARANTEE. Ours
 * is not one and this page never uses the word. A guarantee is a promise to
 * make somebody whole out of money set aside for the purpose, and there is no
 * such money here, no insurer behind it and no claims process to run it. What
 * there is instead is a set of mechanisms in the product that make the common
 * ways this goes wrong harder to do and easier to prove — which is a genuinely
 * useful thing and a completely different thing, so it is described as itself.
 *
 * EVERY NUMBER ON THIS PAGE IS READ OUT OF THE WORKER, not invented for the
 * copy:
 *
 *   src/lib/bypass.ts     LEAD_FEE_LATE_PERCENT 25, LEAD_FEE_LAST_HOURS_PERCENT
 *                         75, LEAD_FEE_DOORSTEP_PERCENT 100, LEAD_FEE_MIN_CENTS
 *                         $15, HALF_REFUND_SECONDS 48h, NO_REFUND_SECONDS 12h,
 *                         REFUND_LATE_PERCENT 75, REFUND_LAST_HOURS_PERCENT 25,
 *                         GRACE_SECONDS 30m, GRACE_FLOOR_SECONDS 3h.
 *   src/lib/standing.ts   STRIKE_DAYS [3, 7, 30], then a ban.
 *   src/lib/startcode.ts  four digits, five wrong tries.
 *   src/lib/parts.ts      three policies, a quote good for three days.
 *   src/lib/settlement.ts the hold, the one question, and what silence means.
 *   src/lib/retention.ts  photographs swept 90 days after the job.
 *
 * AND EVERY ONE OF THE MONEY FIGURES IS STILL WAITING ON A SEAM. Nothing in
 * this product charges a card, holds a balance or pays anybody out — see
 * PaymentState.tsx, which carries the one description of that and is rendered
 * at the top of this page. The ladder below is real arithmetic that real code
 * performs; what it cannot yet do is move a penny, and a page reciting refund
 * percentages without saying so is the most misleading page on the site.
 *
 * The last section is the one that earns the page. A page that lists what it
 * covers and stops there is read as covering everything it did not mention,
 * and the person who finds out otherwise finds out at the worst possible
 * moment. So "what this does not do" is a section of the same weight as the
 * rest, and it says the four words nobody wants to write: no guarantee, no
 * insurance, no damage cover, no vetting.
 */

/**
 * The cancellation ladder, as one array, so the table and the prose beneath it
 * cannot drift into saying different things — the same reason Trade.tsx builds
 * its FAQ and its structured data from one list.
 *
 * Read across a row: how far out the cancellation is, what the customer gets
 * back if they are the one cancelling, and what the business owes if they are.
 */
const LADDER: Array<{ when: string; customer: string; business: string }> = [
  {
    when: 'More than 48 hours before it starts',
    customer: 'All of it back',
    business: 'Owes nothing',
  },
  {
    when: '12 to 48 hours before',
    customer: 'Three quarters back',
    business: 'Owes a quarter of the job',
  },
  {
    when: 'Inside 12 hours',
    customer: 'A quarter back',
    business: 'Owes three quarters of the job',
  },
  {
    when: 'After the business has arrived',
    customer: 'Not a rung a customer can be on',
    business: 'Owes the whole job',
  },
];

export default function Covered() {
  useDocumentTitle('What is covered, and what is not');

  return (
    <PublicPage className="info-page">
      <Crumbs items={[{ label: 'What is covered' }]} />

      <header className="info-head">
        <h1>What is covered, and what is not</h1>
        <p className="info-lede">
          Slotfill is not an insurer and this page is not a guarantee. It is a
          list of the things the site actually does to make a booking between
          two strangers safer to make — and, at the bottom, a list of the
          things it does not do, which is the half most sites leave out.
        </p>
      </header>

      {/* --- money ------------------------------------------------------
          The notice comes before the section rather than inside it, because
          the heading below and every figure under it are about money changing
          hands and none of it does yet. A reader who meets the mechanism first
          and the caveat second has already formed the wrong picture. */}
      <PaymentState />

      <section className="info-sec first" aria-labelledby="c-money">
        <h2 id="c-money">How the money is meant to work</h2>
        <p>
          The design is that you pay for the labour when you book, on this
          site: no cash, nothing paid at the door, and the price you agree to
          is the price the business listed. Card details would be taken by the
          payment processor's own form and never reach Slotfill's servers —
          what would be held is the processor's reference, which is not a card
          number and cannot be used as one. That part is already enforced: a
          request, a database write or a response carrying something shaped
          like a card number is refused everywhere in the product, which is why
          no card can be taken by accident before the rest of it is built.
        </p>
        <p>
          Slotfill would then hold that money between the booking and the job
          and pay the business after the work. That is what makes the rest of
          this page work as written: a refund is money already being held
          rather than money somebody has to be persuaded to send back. Until it
          exists, a booking is a held appointment and nothing else, and the
          price is something you and the business settle between you.
        </p>

        <h3>Parts are quoted and approved before anything is fitted</h3>
        <p>
          This half runs today. A business says up front which of three things
          is true of a job: it needs no parts, parts are already inside the
          price, or the part cannot be known until somebody looks. Only the
          third one leaves anything open, and there the rule is absolute: the
          business sends you a price for the part in your messages, and nothing
          is fitted until you tap approve. A quote stays approvable for three
          days and then expires by itself. Once payment is switched on, that
          approval is also what charges you.
        </p>
        <p className="note">
          There is no path in this product for charging a customer an amount
          they have not seen and approved — not a rounding difference, not
          "it came to a bit more", and not cash on the side.
        </p>
      </section>

      {/* --- the door --------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="c-door">
        <h2 id="c-door">At the door</h2>
        <p>
          Three separate things have to line up before work starts, and none of
          them needs you to take anybody's word for anything.
        </p>
        <ul className="info-list">
          <li>
            <strong>The van has to match.</strong> A business cannot list an
            opening until it has entered the make, colour and plate of the
            vehicle it drives. You are shown those details before anyone
            arrives, and the vehicle at your door either matches them or it
            does not.
          </li>
          <li>
            <strong>The start code.</strong> Your booking carries a four-digit
            code that only you can see. You read it out when they arrive and
            they type it in to start the job. Five wrong tries and the code
            stops working and they have to message you instead.
          </li>
          <li>
            <strong>Both sides confirm the arrival.</strong> The business marks
            that they are there, and you can confirm it from your own booking
            page. Confirming is never required to start the work — a phone left
            indoors must not be able to strand an appointment — but when you do
            confirm, the record afterwards has two people saying somebody was
            at the door rather than one.
          </li>
        </ul>
        <p className="note">
          The start code is evidence, not a lock. Four digits against one live
          booking is not a security control and is not offered as one; what it
          gives is a moment the system knows, rather than infers, that the two
          of you met.
        </p>
      </section>

      {/* --- the record -------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="c-record">
        <h2 id="c-record">The photographs</h2>
        <p>
          Photographs are taken before the work starts, while it is going on,
          and after it is finished. Both sides can add them, because both sides
          have something to lose: a business needs a record against "nobody
          ever came" on a job they did, and a customer needs one against "the
          work was done" on a job nobody came to.
        </p>
        <p>
          Those photographs are private. They are visible to the two people on
          that booking and to a dispute review, and to nobody else — never on a
          public profile, never in search results, never used as advertising. A
          photograph of the inside of your home is published only if you choose
          to attach it to your own review. Everything else is deleted ninety
          days after the job ends.
        </p>
      </section>

      {/* --- the ladder --------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="c-cancel">
        <h2 id="c-cancel">If somebody cancels</h2>
        <p>
          One ladder, both directions. What it would cost a business to cancel
          on you is what it would cost you to cancel on them, and the windows
          are the same. Everything is measured from when the appointment
          starts.
        </p>
        <p className="note">
          Every figure in this section is an amount the code already works out
          and nothing yet moves. Until payment is switched on there is nothing
          held to refund and no fee is collected from anybody, so cancelling —
          from either side, at any point on this ladder — costs nothing today.
          The rung you are on is what the notice at the top of your booking
          will show you either way.
        </p>

        {/* The table scrolls inside its own box rather than making the page
            scroll sideways at 375px. tabIndex is what lets a keyboard reach a
            scrolling region; the role and label make it a real one to a
            screen reader rather than a div that happens to move. */}
        <div className="info-scroll" tabIndex={0} role="region"
          aria-label="Cancellation ladder">
          <table className="info-table">
            <caption>
              Percentages are of the price of the job. Parts you approved are
              never part of this arithmetic — that is money the business laid
              out on your behalf.
            </caption>
            <thead>
              <tr>
                <th scope="col">When it is cancelled</th>
                <th scope="col">If you cancel, you get</th>
                <th scope="col">If they cancel, they owe</th>
              </tr>
            </thead>
            <tbody>
              {LADDER.map((row) => (
                <tr key={row.when}>
                  <th scope="row">{row.when}</th>
                  <td>{row.customer}</td>
                  <td>{row.business}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3>The two things the table does not show</h3>
        <ul className="info-list">
          <li>
            <strong>Thirty minutes to undo a mistake.</strong> Cancel within
            half an hour of booking and you get everything back, as long as the
            appointment is still at least three hours away and nobody has
            arrived. That is for the wrong day, the wrong address and the wrong
            service. Book something starting sooner than three hours and it is
            yours from the moment you book it, because you have asked a person
            to drop what they are doing.
          </li>
          <li>
            <strong>When the business cancels, you are refunded in full.</strong>{' '}
            Always, whatever they owe. What they owe is between them and
            Slotfill and never comes out of your refund.
          </li>
          <li>
            <strong>The fee a business owes has a floor of $15 and a ceiling
            of the job.</strong> On a job worth less than $15, the floor is the
            job's own price.
          </li>
          <li>
            <strong>A late cancellation is not a punishment you can appeal to
            us about.</strong> Message the business instead — moving an
            appointment is usually fine and is theirs to agree to.
          </li>
        </ul>

        <h3>The one question after a cancellation</h3>
        <p>
          The question itself is asked today; what it settles is the money, so
          that half waits with the rest. When a business cancels, the money
          freezes on both sides and you are asked one thing: did they do the
          work anyway? If you say they left, your refund goes through and the
          fee applies. If you say they did the job, nobody is refunded, the
          business is paid as though the job completed, and the fee is dropped.
          If nobody answers, the money stays where it is and nobody is charged —
          so neither side gains by staying quiet. The question closes about
          three hours after the appointment was due, and at the outside after
          seven days.
        </p>
      </section>

      {/* --- no-shows ---------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="c-noshow">
        <h2 id="c-noshow">If somebody does not turn up at all</h2>
        <p>
          A no-show is not charged for. Deciding from a database that a person
          did not turn up means reading the absence of a tap, and a business
          that did the job and forgot to press a button leaves exactly the same
          trace as one that never left the house. So the answer is time rather
          than money.
        </p>
        <p>
          Either side can report the other after the appointment has finished,
          once each. A report does nothing on its own. When a person here
          upholds one, the account is suspended: three days for the first,
          seven for the second, thirty for the third, and a fourth closes it to
          new bookings. The ladder is the same on both sides, and a suspension
          never touches work already booked — those customers still get their
          appointment.
        </p>
        <p className="note">
          Nothing on that ladder is automatic and nothing on it is a sweep for
          bookings nobody marked as arrived. That shortcut punishes the
          business that was working and hands anyone who wants a customer gone
          a one-tap weapon, so it is not built.
        </p>
      </section>

      {/* --- what this is not -------------------------------------------- */}
      <section className="info-sec" aria-labelledby="c-not">
        <h2 id="c-not">What this does not do</h2>
        <p>
          All of the above is what the product does. Here is what it does not,
          in the same plain words, because a page that only lists the first
          half reads as a promise about the second.
        </p>

        <div className="info-not">
          <h3>Not covered</h3>
          <ul className="info-list">
            <li>
              <strong>There is no money-back guarantee.</strong> If work is
              done and you are unhappy with it, there is no fund here that
              refunds you and no claims process to open. Your refund rights are
              the ones in the ladder above and nothing more.
            </li>
            <li>
              <strong>There is no cover for damage to your property.</strong>{' '}
              Slotfill does not pay for a scratched car, a cracked tile or a
              flooded floor, and there is no mechanism in the product that
              could. That is between you and the business, and it is what the
              business's own insurance is for.
            </li>
            <li>
              <strong>There is no insurance of any kind.</strong> Not on the
              work, not on the payment, not on you. A business can enter its
              insurer and policy number on its profile; that is the business
              telling you about itself, and it is not a policy that covers you
              through us.
            </li>
            <li>
              <strong>We do not verify licences, insurance or background
              checks.</strong> Nothing on this site checks a licence number
              against the board that issued it. What a business says about its
              own licensing or insurance is its own claim; the issuing board's
              public register is the place to check one. See{' '}
              <Link to="/safety">Safety</Link> for what we do and do not look at.
            </li>
            <li>
              <strong>We do not vet the people who sign up.</strong> There is
              no interview, no reference check and no identity check. A
              business gives an email address, a business name, a vehicle and a
              card before its openings go up, and that is the whole of it.
            </li>
            <li>
              <strong>We do not promise a response time.</strong> Not for a
              message, not for a report, not for anything. Where the product
              has a clock in it — five minutes to accept an instant request,
              three days for a parts quote — that clock is described where it
              applies and there is no other one.
            </li>
            <li>
              <strong>Nothing above applies off the site.</strong> Cash at the
              door, a job arranged in a phone call, a payment sent through an
              app: none of it has a booking behind it, so none of the
              mechanisms on this page exist for it. That is the real reason
              contact details are removed from messages, not a commercial one.
            </li>
          </ul>
        </div>
      </section>

      <footer className="info-foot">
        <p>
          Every figure on this page comes from the code that enforces it. If
          one of them is ever wrong here, the code is what happens.
        </p>
        <p>
          <Link to="/safety">Safety</Link>
          {' · '}
          <Link to="/help">Help</Link>
          {' · '}
          <Link to="/terms">Terms</Link>
          {' · '}
          <Link to="/privacy">Privacy</Link>
        </p>
      </footer>
    </PublicPage>
  );
}
