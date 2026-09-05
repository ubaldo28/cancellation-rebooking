import { Link } from 'react-router-dom';
import Crumbs from '../components/Crumbs';
import PaymentState from '../components/PaymentState';
import PublicPage from '../components/PublicPage';
import { useDocumentTitle } from '../lib/title';
import '../styles-info.css';

/**
 * Terms. Route /terms.
 *
 * SiteFooter.tsx calls this and Privacy "the only entries here that are a
 * legal gap rather than a marketing one", and it is right: a marketplace that
 * takes card payments and holds home addresses needs both, and had neither.
 *
 * THE RULE THIS FILE IS WRITTEN UNDER. Every clause describes something the
 * code does. There is no clause here inventing a right nobody implemented, no
 * arbitration agreement, no class-action waiver, no limitation-of-liability
 * cap with a number in it, no indemnity and no governing-law clause naming a
 * state — because none of that exists anywhere in this product and writing it
 * here would not create it. What is here instead is the honest thing: how the
 * service behaves, what each side owes, and a visible line at the top saying
 * a lawyer has not been near it.
 *
 * THE PLACEHOLDERS ARE DELIBERATE AND MUST STAY UGLY. Nobody has told this
 * codebase the operating company's name, its address, the state whose law
 * governs this, or an address anybody can be contacted at. Filling those in
 * with something plausible is the one failure this page cannot survive, so
 * they are square-bracketed, monospaced, dashed-outlined and listed together
 * in their own section where whoever knows the answers can find all of them
 * at once.
 *
 * Where a number appears it is read from the Worker, the same set Covered.tsx
 * lists: src/lib/bypass.ts for the ladder and the grace window,
 * src/lib/standing.ts for the suspensions, src/lib/parts.ts for quotes,
 * src/lib/retention.ts for deletion, src/lib/payments.ts for the card seam.
 */

/** The day the wording below was last gone over. Shown, not hidden in a diff. */
const LAST_UPDATED = '5 September 2026';

/** One row per thing nobody has supplied. Rendered as a list and as prose. */
const UNKNOWNS: Array<{ what: string; why: string }> = [
  {
    what: '[OPERATING COMPANY NAME]',
    why: 'the legal entity that runs Slotfill and that you are contracting with',
  },
  {
    what: '[REGISTERED ADDRESS]',
    why: 'where that entity is registered, and where formal notice would be sent',
  },
  {
    what: '[GOVERNING LAW AND VENUE]',
    why: 'which state\'s law applies and where a dispute would be heard',
  },
  {
    what: '[CONTACT ADDRESS]',
    why: 'the email or postal address for questions about these terms',
  },
];

export default function Terms() {
  useDocumentTitle('Terms');

  return (
    <PublicPage className="info-page">
      <Crumbs items={[{ label: 'Terms' }]} />

      <header className="info-head">
        <h1>Terms</h1>

        <div className="info-stamp">
          <p>
            <b>Last updated {LAST_UPDATED}.</b> This is a plain-language
            description of how Slotfill actually works, written from the code
            that runs it. <b>It has not been reviewed by a lawyer</b> and it is
            not a substitute for terms of service that one has drafted.
          </p>
          <p>
            Four things a document like this normally states are not stated
            here, because nobody has supplied them yet. They are listed in{' '}
            <a href="#t-unknown">section 12</a> as gaps rather than filled in
            with something that looks right.
          </p>
        </div>

        <nav className="info-toc" aria-label="Contents">
          <h2>Contents</h2>
          <ol>
            <li><a href="#t-who">1. Who Slotfill is and is not</a></li>
            <li><a href="#t-accounts">2. Accounts and identity</a></li>
            <li><a href="#t-booking">3. Booking and paying</a></li>
            <li><a href="#t-parts">4. Parts</a></li>
            <li><a href="#t-cancel">5. Cancelling</a></li>
            <li><a href="#t-noshow">6. Not turning up</a></li>
            <li><a href="#t-listing">7. Listing, for businesses</a></li>
            <li><a href="#t-messages">8. Messages, photographs and reviews</a></li>
            <li><a href="#t-conduct">9. Things you may not do</a></li>
            <li><a href="#t-ending">10. Ending it</a></li>
            <li><a href="#t-nopromise">11. What Slotfill does not promise</a></li>
            <li><a href="#t-unknown">12. What this document is missing</a></li>
          </ol>
        </nav>
      </header>

      {/* --- 1 ----------------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="t-who">
        <h2 id="t-who">1. Who Slotfill is and is not</h2>
        <p>
          Slotfill is a marketplace. Independent local businesses list
          appointments they have free, at prices they set themselves, and
          customers book them here. The work itself is a contract between the
          customer and that business.
        </p>
        <p>
          Slotfill does not do any of the work, does not employ anybody who
          does, does not supervise it, does not set its price and is not a
          party to it. It runs the listing, carries the payment, carries the
          messages and enforces the rules described below.
        </p>
      </section>

      {/* --- 2 ----------------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="t-accounts">
        <h2 id="t-accounts">2. Accounts and identity</h2>
        <p>
          A business has an account, identified by an email address. There is
          no password: signing in is a link sent to that address, so whoever
          controls the mailbox controls the account.
        </p>
        <p>
          A customer has no account. A booking is held together by a secret
          link, and that link is the whole of a customer's identity here.
          Anybody holding it can read the booking, the address, the
          conversation, the photographs and the start code, and can delete the
          data behind it. Treat it the way you would treat a password. After
          ten invalid links from one place, that place is locked out for
          fifteen minutes.
        </p>
      </section>

      {/* --- 3 ----------------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="t-booking">
        <h2 id="t-booking">3. Booking and paying</h2>
        {/* The first clause, before the ones it governs. Sections 3, 5 and 6
            describe a flow of money that no part of this product performs
            yet, and terms that read as though it did would be the site's most
            consequential untruth rather than merely a marketing one. */}
        <PaymentState />
        <p>
          The price shown on an opening is set by the business that listed it
          and is the price of the labour. Booking holds the appointment. Under
          these terms the customer pays that price at the time of booking
          through this site, with no cash and nothing paid at the door; that
          step is not yet implemented, so no payment is taken, none is held,
          and the price is settled between the customer and the business
          directly. The paragraphs below, and sections 5 and 6, take effect for
          a booking as and when payment through this site is switched on.
        </p>
        <p>
          Card details are entered into the payment processor's own form and
          are never received or stored by Slotfill. What Slotfill holds is the
          processor's reference to that card, which is not a card number. Any
          request or record that looks like it contains card or bank details is
          refused outright rather than stored.
        </p>
        <p>
          Slotfill holds the money between the booking and the job and pays the
          business afterwards. Refunds and fees described below are settled out
          of that.
        </p>
      </section>

      {/* --- 4 ----------------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="t-parts">
        <h2 id="t-parts">4. Parts</h2>
        <p>
          Each service says one of three things: it needs no parts, parts are
          included in the price, or the part cannot be known until somebody
          looks at the job. In the third case the business sends a price into
          the booking's messages and the customer approves or declines it. A
          quote expires three days after it is sent.
        </p>
        <p>
          Nothing is fitted and nothing is charged for a part the customer has
          not approved. There is no path in this product for charging an
          unapproved amount, and a business asking for the difference in cash is
          outside these terms entirely. The approval itself operates now; the
          charge that follows it operates when payment through this site does.
        </p>
      </section>

      {/* --- 5 ----------------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="t-cancel">
        <h2 id="t-cancel">5. Cancelling</h2>
        <p>
          One ladder, applying the same way to both sides, measured from when
          the appointment starts.
        </p>
        <ul className="info-list">
          <li>
            <strong>More than 48 hours before:</strong> the customer is
            refunded in full; a business that cancels owes nothing.
          </li>
          <li>
            <strong>12 to 48 hours before:</strong> the customer gets three
            quarters back; a business that cancels owes a quarter of the job.
          </li>
          <li>
            <strong>Inside 12 hours:</strong> the customer gets a quarter back;
            a business that cancels owes three quarters of the job.
          </li>
          <li>
            <strong>After the business has arrived:</strong> a business that
            cancels then owes the whole job.
          </li>
          <li>
            <strong>Within 30 minutes of booking:</strong> the customer gets
            everything back, provided the appointment is still at least three
            hours away and nobody has arrived.
          </li>
        </ul>
        <p>
          A fee owed by a business is a minimum of $15 and never more than the
          price of the job. It is calculated on the labour only — parts the
          customer approved are money the business laid out on the customer's
          behalf and are not part of it. When a business cancels, the customer
          is refunded in full regardless of what that business owes.
        </p>
        <p>
          After a business cancels, both sides are frozen and the customer is
          asked one question: was the work done anyway? Answering that it was
          not releases the refund and applies the fee. Answering that it was
          done means no refund, the business is paid as for a completed job, and
          the fee is dropped. If nobody answers before the hold expires — about
          three hours after the appointment was due, and at most seven days —
          the money stays where it is and no fee is charged.
        </p>
      </section>

      {/* --- 6 ----------------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="t-noshow">
        <h2 id="t-noshow">6. Not turning up</h2>
        <p>
          Failing to turn up is not charged for. Either side may report the
          other once per booking, after the appointment has finished, and a
          report changes nothing by itself. When a person at Slotfill upholds
          one, the account is suspended for three days, then seven days on a
          second, then thirty days on a third; a fourth closes it to new
          bookings.
        </p>
        <p>
          A suspension stops new bookings only. Appointments already booked are
          unaffected and go ahead. For a customer, standing is recorded against
          the phone number used to book.
        </p>
      </section>

      {/* --- 7 ----------------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="t-listing">
        <h2 id="t-listing">7. Listing, for businesses</h2>
        <p>
          A business may not list openings until it has a card on file, location
          sharing switched on, and its vehicle's make, colour and plate
          recorded. An unpaid cancellation fee also stops new openings until it
          is settled; it never cancels work already booked.
        </p>
        <p>
          A business is responsible for its own licensing, insurance, tax and
          compliance, and for the accuracy of everything on its profile. Where
          California requires a licence for a trade, that requirement is between
          the business and the issuing board.
        </p>
        <p>
          A fee owed is taken from the business's next payout where there is
          one, and charged to the card on file only where there is not.
        </p>
      </section>

      {/* --- 8 ----------------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="t-messages">
        <h2 id="t-messages">8. Messages, photographs and reviews</h2>
        <ul className="info-list">
          <li>
            Messages go through the site. Phone numbers, email addresses,
            payment-app handles and outside links are removed from a message
            before it is stored, and the sender is told. Neither side is given
            the other's phone number or email address.
          </li>
          <li>
            Photographs taken on a job are visible to the two people on that
            booking and to a dispute review. They are not published anywhere,
            and the only way one becomes public is a customer choosing to attach
            it to their own review. Location metadata is stripped from every
            upload.
          </li>
          <li>
            A review can only be left by a customer who completed a booking on
            this site, one review per booking. Slotfill does not write, buy or
            invent reviews. A business can reply to one.
          </li>
          <li>
            You keep whatever rights you have in what you upload, and you give
            Slotfill permission to store it and show it to the people described
            above so that the service can work.
          </li>
        </ul>
      </section>

      {/* --- 9 ----------------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="t-conduct">
        <h2 id="t-conduct">9. Things you may not do</h2>
        <ul className="info-list">
          <li>
            Take a booking off the site — arranging or paying for a job found
            here somewhere else. Doing that removes every protection described
            on <Link to="/covered">what is covered</Link> from both of you.
          </li>
          <li>
            Cancel a booking and then do the job anyway, in cash or otherwise.
          </li>
          <li>
            Ask for money that has not been approved through the site, or ask a
            customer to pay a difference at the door.
          </li>
          <li>
            Work around the contact-detail filter, or use somebody's booking
            link for anything other than their booking.
          </li>
          <li>
            Post anything false, threatening or unlawful, or photographs of a
            person who has not agreed to be photographed.
          </li>
          <li>
            Scrape the site, or automate bookings, sign-ups, alerts or
            messages.
          </li>
        </ul>
      </section>

      {/* --- 10 ---------------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="t-ending">
        <h2 id="t-ending">10. Ending it</h2>
        <p>
          A customer can delete their personal data from the bottom of their own
          booking page, at any time, without asking anybody. It is immediate and
          there is no undo. A business can close its account from{' '}
          <span className="mono">Settings</span> in the app once there is
          nothing left in the diary — closing with live bookings is refused,
          because it would leave those customers with nobody coming and no way
          to make contact.
        </p>
        <p>
          Either deletion keeps the record of money that has already moved: an
          amount, a currency, a date and which business it was with, with
          nothing on it that names a person. A live suspension or ban also
          survives deletion, so that "delete my data" is not also the button
          that clears a sanction. <Link to="/privacy">Privacy</Link> sets out
          both in full.
        </p>
        <p>
          Slotfill can suspend or close an account that breaks these terms.
          Appointments a customer has already booked are honoured either way.
        </p>
      </section>

      {/* --- 11 ---------------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="t-nopromise">
        <h2 id="t-nopromise">11. What Slotfill does not promise</h2>
        <div className="info-not">
          <h3>No promise is made about any of this</h3>
          <ul className="info-list">
            <li>
              <strong>No guarantee on the work.</strong> There is no fund that
              refunds unsatisfactory work and no claims process. The refund
              rules in section 5 are the whole of it.
            </li>
            <li>
              <strong>No insurance and no cover for damage.</strong> Slotfill
              does not insure the work, the payment, your property or you.
            </li>
            <li>
              <strong>No vetting.</strong> Nobody is interviewed,
              identity-checked or background-checked by Slotfill, and no
              licence or insurance policy shown on a profile is verified here.
              The issuing board's public register is where a licence can be
              checked.
            </li>
            <li>
              <strong>No promise that the site is available</strong>, that any
              opening will be booked, or that anyone will reply within any
              particular time.
            </li>
            <li>
              <strong>No warranty of any kind is being given here.</strong>{' '}
              This document has not been drafted by a lawyer and it does not
              attempt to limit anybody's liability, waive anybody's rights or
              take away a right the law gives you.
            </li>
          </ul>
        </div>
      </section>

      {/* --- 12 ---------------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="t-unknown">
        <h2 id="t-unknown">12. What this document is missing</h2>
        <p>
          Four things a terms page normally states are not stated here, because
          nobody has supplied them. They are left visibly blank rather than
          guessed at, and each square-bracketed value below is a placeholder,
          not a name:
        </p>
        <dl className="info-defs">
          {UNKNOWNS.map((u) => (
            <div className="info-def" key={u.what}>
              <dt><span className="info-ph">{u.what}</span></dt>
              <dd>{u.why}</dd>
            </div>
          ))}
        </dl>
        <p className="note">
          Until those are filled in, this page is a description of how the
          service works rather than a contract naming a party you can enforce it
          against. If you need to reach somebody about it, use the messages on
          your own booking — that is the only contact route this product
          actually has.
        </p>
      </section>

      <footer className="info-foot">
        <p>
          These terms describe the service as it behaves on {LAST_UPDATED}. If
          the wording here and the behaviour of the site ever disagree, the site
          is what happens, and the wording is what is wrong.
        </p>
        <p>
          <Link to="/privacy">Privacy</Link>
          {' · '}
          <Link to="/covered">What is covered</Link>
          {' · '}
          <Link to="/safety">Safety</Link>
          {' · '}
          <Link to="/help">Help</Link>
        </p>
      </footer>
    </PublicPage>
  );
}
