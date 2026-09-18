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
 * THE RULE THIS FILE IS WRITTEN UNDER. Every clause describes something that
 * is true — either something the code does, or a plain fact about who runs
 * this site. There is no clause here inventing a right nobody implemented, no
 * arbitration agreement, no class-action waiver, no limitation-of-liability
 * cap with a number in it and no indemnity, because none of that exists
 * anywhere in this product and writing it here would not create it. What is
 * here instead is the honest thing: how the service behaves, what each side
 * owes, and a visible line at the top saying a lawyer has not been near it.
 *
 * THE PLACEHOLDERS ARE GONE, AND NEITHER WAS FILLED IN WITH A GUESS. This file
 * used to carry two square-bracketed values — [REGISTERED ADDRESS] and
 * [GOVERNING LAW AND VENUE] — in a section 12 headed "What this document is
 * missing", with three more paragraphs elsewhere counting the gaps for the
 * reader. The owner has now answered both, and the answers are not the shape
 * the placeholders were cut for, which is why the whole apparatus went instead
 * of being completed:
 *
 *   THERE IS NO REGISTERED ADDRESS, because there is no registered company.
 *   Round The Way is one person trading under that name — a sole proprietor —
 *   and the place it is run from is a home. Printing a home address on a
 *   public page is the one thing this site spends the rest of its time not
 *   doing: Privacy takes a customer's street address off the record 90 days
 *   after the job. So section 12 designates the contact mailbox as the address
 *   for notice and says a postal address for formal legal notice is sent on
 *   request. That is a real answer, not a gap — and the address itself must
 *   not appear in this file, in src/lib/seo.ts, in structured data or in an
 *   email footer, however it arrives.
 *
 *   NO GOVERNING LAW IS NAMED, AND CALIFORNIA WAS THE WRONG ANSWER RATHER
 *   THAN A ROUGH ONE. This file spent a while with GOVERNING_LAW =
 *   'California' held on one line and a section 13 built out of it, on the
 *   reasoning that the owner worked in that state and so that is where a
 *   dispute would land. Both halves of that have stopped being true: there is
 *   no registered entity in California or anywhere else, the owner is not
 *   registering in California, and he is in the middle of moving with no
 *   jurisdiction chosen. A choice-of-law clause naming a state nobody is
 *   registered in and nobody is going to be in is not a working assumption —
 *   it is a sentence that is wrong in a specific, checkable way, and it is the
 *   sentence on the page a reader is most likely to take at face value,
 *   because it looks like the one part of a terms document somebody must have
 *   looked up.
 *
 *   So the clause went and the constant with it, and the last paragraph of
 *   section 12 says instead that no law and no court are named here, and what
 *   decides it in their absence. That is not the bracketed placeholder back in different
 *   clothes: nothing is owed to the reader and withheld, because there is no
 *   answer being kept from them — the answer is that this document does not
 *   supply one. Section 7's licensing sentence and the money-transmission note
 *   in section 3 still name California and both stay: they are statements
 *   about US trade regulation, not about which law governs this document.
 *
 * WHY THE COUNTING PARAGRAPHS HAD TO MOVE IN THE SAME COMMIT. "Two of the four
 * gaps that used to be here are filled", "two things a terms page normally
 * states are still not stated here, because nobody has supplied them", and a
 * note opening "What those two gaps cost you" were each true of the old page
 * and each false the moment the values arrived. A document whose whole claim
 * is that it does not overstate itself cannot be caught understating itself
 * either: a reader sent to section 12 to see what is missing, who finds both
 * things stated plainly when they get there, has been told something untrue on
 * the way.
 *
 * Where a number appears it is read from the Worker, the same set Covered.tsx
 * lists: src/lib/bypass.ts for the ladder and the grace window,
 * src/lib/standing.ts for the suspensions, src/lib/parts.ts for quotes,
 * src/lib/retention.ts for deletion, src/lib/fees.ts for what the platform
 * keeps, src/lib/checkout.ts and src/lib/stripe.ts for the card itself.
 *
 * PAYMENT IS LIVE. This page once suspended sections 5 and 6 "until payment
 * through this site is switched on", said no card was asked for and said a
 * booking without one was accepted. All three were true once and none of them
 * is true now. A customer charged a cancellation fee could have pointed at
 * that suspension and said they never agreed to the ladder, which is why copy
 * describing a switchable state has to move in the same commit as the switch.
 */

/** The day the wording below was last gone over. Shown, not hidden in a diff. */
const LAST_UPDATED = '12 September 2026';

/**
 * The mailbox for questions about these terms, and the designated address for
 * notice under them. One address doing both jobs is deliberate: there is one
 * person reading it, and inventing a second, more official-looking mailbox
 * would only mean notice arriving somewhere nobody checks.
 */
const CONTACT = 'weroundtheway@gmail.com';

/*
 * THERE IS NO GOVERNING_LAW CONSTANT HERE ANY MORE, AND THAT IS THE POINT.
 *
 * One line holding a state name was the right shape for a fact that needed
 * correcting cheaply; it was the wrong shape for a fact nobody has. Reaching
 * for it again means somebody has decided to name a jurisdiction, and that is
 * a decision for a person with a registered business and preferably a lawyer,
 * not a default to be restored because a page looks bare without one. What the
 * page says instead is at the end of section 12.
 */

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
            description of how Round The Way actually works, written from the code
            that runs it. <b>It has not been reviewed by a lawyer</b> and it is
            not a substitute for terms of service that one has drafted.
          </p>
          <p>
            These terms are between you and Round The Way, the business that
            runs this site. Questions about them go to{' '}
            <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
          </p>
          <p>
            Round The Way is one person trading under that name rather than a
            registered company. <a href="#t-notice">Section 12</a> says how
            notice is given, why no postal address is printed on this page, and
            why these terms name no governing law and no court.
          </p>
        </div>

        <nav className="info-toc" aria-label="Contents">
          <h2>Contents</h2>
          <ol>
            <li><a href="#t-who">1. Who Round The Way is and is not</a></li>
            <li><a href="#t-accounts">2. Accounts and identity</a></li>
            <li><a href="#t-booking">3. Booking and paying</a></li>
            <li><a href="#t-parts">4. Parts</a></li>
            <li><a href="#t-cancel">5. Cancelling</a></li>
            <li><a href="#t-noshow">6. Not turning up</a></li>
            <li><a href="#t-listing">7. Listing, for businesses</a></li>
            <li><a href="#t-messages">8. Messages, photographs and reviews</a></li>
            <li><a href="#t-conduct">9. Things you may not do</a></li>
            <li><a href="#t-ending">10. Ending it</a></li>
            <li><a href="#t-nopromise">11. What Round The Way does not promise</a></li>
            <li><a href="#t-notice">12. Notice, who Round The Way is, and which law applies</a></li>
          </ol>
        </nav>
      </header>

      {/* --- 1 ----------------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="t-who">
        <h2 id="t-who">1. Who Round The Way is and is not</h2>
        <p>
          Round The Way is a marketplace. Independent local businesses list
          appointments they have free, at prices they set themselves, and
          customers book them here. The work itself is a contract between the
          customer and that business.
        </p>
        <p>
          Round The Way does not do any of the work, does not employ anybody who
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
          A customer has an account, identified by an email address. There is no
          password: signing in is a six-digit code emailed to that address, so
          whoever controls the mailbox controls the account. The code lasts ten
          minutes, can be used once, and stops working after five wrong
          attempts. An account is required to book and is created at the moment
          of booking; browsing, comparing prices and messaging a business do
          not require one.
        </p>
        <p>
          A phone number is also collected when a booking is made, so that the
          business can reach the customer on the day. It is not verified, it
          does not identify the account, and nothing on the account can be
          reached or unlocked with it.
        </p>
        <p>
          Every booking also has its own secret link. Anybody holding it can
          read the booking, the address, the conversation, the photographs and
          the start code, and can delete the data behind it, whether or not
          they are signed in to the account that made it. Treat it the way you
          would treat a password. After ten invalid links from one place, that
          place is locked out for fifteen minutes.
        </p>
        <p>
          A customer may close their account, which empties the email address,
          the phone number, the name and any stored card reference and ends
          every session on it; the bookings themselves remain, and deleting
          those is the separate request described in section 10. Closing an
          account does not clear a suspension recorded against that email
          address.
        </p>
      </section>

      {/* --- 3 ----------------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="t-booking">
        <h2 id="t-booking">3. Booking and paying</h2>
        {/* The first clause, before the ones it governs. This block used to
            say the opposite of everything below it, because for months no part
            of the product moved money. It does now, and the sentences that
            described the old state were the site's most consequential untruth
            rather than merely a marketing one. */}
        <PaymentState />
        <p>
          Booking requires a customer account and a card on it. The account is
          created at the moment of booking by confirming an email address as
          described in section 2, and the card goes on at the same time. An
          order placed without a card is refused.
        </p>
        <p>
          The price shown on an opening is set by the business that listed it
          and is the price of the labour. The customer pays that price in full
          at the time of booking, by card, on this site. Nothing is added at
          checkout, there is no fee on the customer's side, no cash changes
          hands at the door, and nothing is left over to settle with the
          business afterwards. The paragraphs below, and{' '}
          <a href="#t-cancel">section 5</a> and{' '}
          <a href="#t-noshow">section 6</a>, are in force and apply to every
          booking: the refunds described there are real money going back to the
          card it came from, and so are the fees.
        </p>
        <p>
          Card details are entered into Stripe's own form and are never
          received or stored by Round The Way. What Round The Way holds is
          Stripe's reference to that card, which is not a card number. Any
          request or record that looks like it contains card or bank details is
          refused outright rather than stored.
        </p>
        <p>
          Round The Way holds the money between the booking and the job and pays the
          business afterwards. Refunds and fees described below are settled out
          of that. Round The Way keeps a share of the job out of what the
          business is paid — <a href="#t-listing">section 7</a> says how much —
          and that share is never added to what the customer pays.
        </p>
        {/*
          THE AGENT-OF-PAYEE CLAUSE. Do not remove or weaken either half of it
          without a lawyer saying so.

          Taking a customer's money and passing it on to a third party is, on
          its face, money transmission, and money transmission in California
          requires a licence from the Department of Financial Protection and
          Innovation. What an online marketplace relies on instead is the
          agent-of-payee exemption, and it has two conditions. The marketplace
          must be the business's agent under a written contract that already
          existed when the money moved — that is section 7, which every
          business accepts before it can list. And the customer's debt to the
          business must be discharged the moment the customer pays the
          marketplace — that is the paragraph below.

          Both must be in force from the very first payment taken. A payment
          already collected without them cannot be fixed afterwards, which is
          why this was written into the terms before payments were switched on
          rather than added alongside them. Payments are live now, so neither
          half may be weakened by so much as a word.
        */}
        <p>
          Round The Way takes the customer's payment as the business's appointed
          agent, under the agreement in <a href="#t-listing">section 7</a> that
          the business accepted before it listed anything. Paying Round The Way
          therefore settles the customer's obligation to the business in full,
          at the moment the payment is made. If Round The Way then fails to pay the
          business, that is Round The Way's failure and Round The Way's liability, and the
          business has no claim against the customer for the same money.
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
          outside these terms entirely.
        </p>
        {/*
          THE PARTS SEAM, SAID AS IT IS. This paragraph used to read "the
          charge that follows it operates when payment through this site
          does", which now reads as a promise that an approved part is charged
          automatically. It is not: src/lib/parts.ts adds the approved figure
          to the order's parts_cents and leaves charged_at NULL, with a comment
          marking the line where the second charge would go. When that charge
          is wired up, this paragraph moves in the same commit.
        */}
        <p>
          The card charge taken at booking is for the labour, which is the
          price that was on the opening. A part the customer approves later is
          added to what the booking comes to and is recorded against it as
          owed; no second charge for it is taken through this site today. The
          amount that can ever be owed for a part is the exact figure on the
          quote the customer approved, and nothing else.
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
          report changes nothing by itself. When a person at Round The Way upholds
          one, the account is suspended for three days, then seven days on a
          second, then thirty days on a third; a fourth closes it to new
          bookings.
        </p>
        <p>
          A suspension stops new bookings only. Appointments already booked are
          unaffected and go ahead. For a customer, standing is recorded against
          the email address the account is identified by, not against the phone
          number on the booking.
        </p>
      </section>

      {/* --- 7 ----------------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="t-listing">
        <h2 id="t-listing">7. Listing, for businesses</h2>
        <p>
          A business may not list openings until it has a Stripe account
          connected with a bank account on it, location sharing switched on,
          and its vehicle's make, colour and plate recorded. The Stripe account
          is where the money for the work arrives, which is why no opening goes
          up before it exists. A card is <em>not</em> required of a business —
          it is offered, and a business that does not add one still lists and
          still gets paid. An unpaid cancellation fee does stop new openings
          until it is settled; it never cancels work already booked.
        </p>
        {/*
          THE COMMISSION, IN THE SECTION A BUSINESS ACTUALLY READS.

          This section described the agent appointment and the cancellation fee
          and never once stated what the platform charges, so a business was
          agreeing to terms that omitted the principal charge against it. The
          figures are src/lib/fees.ts — FEE_BASIS_POINTS and FEE_CAP_CENTS —
          and the rule in that file has no exceptions: a fee is charged on
          every booking, with no free tier and no reduced rate.
        */}
        <p>
          <strong>What Round The Way charges.</strong> Round The Way keeps 15%
          of every job booked through this site, and never more than $150 from
          one business in one day. It comes out of the business's share of the
          customer's payment; it is never added to the price the customer pays,
          so the number beside an opening is the number on the customer's card.
          It applies to every booking — there is no free tier, no free first
          booking, no reduced rate and no exemption for a customer the business
          brought itself. Apart from a cancellation fee under{' '}
          <a href="#t-cancel">section 5</a>, nothing else is charged to a
          business: no subscription and no fee for listing.
        </p>
        {/*
          The other half of the agent-of-payee clause in section 3. This is the
          written appointment, and it has to be accepted BEFORE any money is
          collected for that business — which it is, because a business accepts
          these terms before it can list an opening at all.
        */}
        <p>
          By listing, a business appoints Round The Way as its agent to receive
          payment from customers on its behalf for anything booked through this
          site, and agrees that a customer who pays Round The Way has paid the
          business. The business's claim for that money is then against Round The Way
          and not against the customer. This appointment is in force from the
          moment these terms are accepted, which is before any opening can be
          listed and so before any payment can be taken.
        </p>
        <p>
          A business is responsible for its own licensing, insurance, tax and
          compliance, and for the accuracy of everything on its profile. Where
          California requires a licence for a trade, that requirement is between
          the business and the issuing board.
        </p>
        <p>
          A fee owed is settled against the business's next payout. Where a
          business has added a card, it may be charged to that instead. Where
          there is neither, the fee is recorded as owed and new openings stop
          until it is settled.
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
            this site, one review per booking. Round The Way does not write, buy or
            invent reviews. A business can reply to one.
          </li>
          <li>
            You keep whatever rights you have in what you upload, and you give
            Round The Way permission to store it and show it to the people described
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
          booking page or from their account, at any time, without asking
          anybody; both run the same erasure. It is immediate and there is no
          undo. Closing the account instead is the smaller request and is
          described in section 2. A business can close its account from{' '}
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
          Round The Way can suspend or close an account that breaks these terms.
          Appointments a customer has already booked are honoured either way.
        </p>
      </section>

      {/* --- 11 ---------------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="t-nopromise">
        <h2 id="t-nopromise">11. What Round The Way does not promise</h2>
        <div className="info-not">
          <h3>No promise is made about any of this</h3>
          <ul className="info-list">
            <li>
              <strong>No guarantee on the work.</strong> There is no fund that
              refunds unsatisfactory work and no claims process. The refund
              rules in section 5 are the whole of it.
            </li>
            <li>
              <strong>No insurance and no cover for damage.</strong> Round The Way
              does not insure the work, the payment, your property or you.
            </li>
            <li>
              <strong>No vetting.</strong> Nobody is interviewed,
              identity-checked or background-checked by Round The Way, and no
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

      {/* --- 12 ----------------------------------------------------------
          THE NOTICE CLAUSE, AND WHY THERE IS NO ADDRESS IN IT.

          What stood here was a section headed "What this document is missing"
          with [REGISTERED ADDRESS] in a dashed box, on the reasoning that an
          invented company address would be worse than a visible hole. The
          owner's answer, when it came, was that there is nothing to put in the
          box: no registered company, one person trading under a name, working
          from a home. So this section states the two things a notice provision
          is actually for — where notice goes and who it reaches — and then
          says outright why the postal line is absent, because a reader who is
          not told assumes it was forgotten.

          THE ADDRESS DOES NOT GO IN HERE. Not in this file, not in
          src/lib/seo.ts's server-rendered chrome, not in structured data, not
          in an email footer, whatever ticket it arrives in. It is a home
          address, and "on request" is the entire design: somebody with a real
          need for it asks a person and gets it, and it is never on a page a
          crawler can read.

          AND THE LAW PARAGRAPH IS AT THE BOTTOM OF THIS SECTION, where a
          section 13 headed "Which law applies" used to be. It is the same fact
          as the two above it — nobody is registered anywhere — so it belongs
          beside them rather than in a clause of its own that reads as though a
          state had been chosen. ----------------------------------------- */}
      <section className="info-sec" aria-labelledby="t-notice">
        <h2 id="t-notice">12. Notice, who Round The Way is, and which law applies</h2>
        <p>
          Round The Way is not a registered company. It is one person working
          for themselves — a sole proprietor — trading under the name Round The
          Way. That is why there is no company number anywhere on this site, no
          registered office and no corporate "we" in this document: there is one
          person behind it, and the page says so rather than dressing it up as
          something larger.
        </p>
        <p>
          <strong>Notice to Round The Way is given by email to{' '}
          <a href={`mailto:${CONTACT}`}>{CONTACT}</a></strong>, which is
          designated as the address for notice under these terms. It is the
          same mailbox as the one at the top of this page — there is no second,
          more official one — and it is read by the person who runs the site.
        </p>
        <p>
          No postal address is printed here, because the address this business
          is run from is a home. Publishing it would sit badly beside
          everything else this site does: <Link to="/privacy">Privacy</Link>{' '}
          has the street address of a finished job removed 90 days after it, and
          a site that deletes a customer's address on a timer should not be
          printing somebody's home address of its own. If you need a postal
          address for formal legal notice, ask at{' '}
          <a href={`mailto:${CONTACT}`}>{CONTACT}</a> and it will be given to
          you.
        </p>
        <p>
          <strong>These terms do not name a governing law and they do not name
          a court.</strong> There is no registered business and so no state it
          is registered in, which means there is nothing to write down here
          that would be a fact rather than a preference — and a state put in
          for the look of the thing is worth less than the line it takes up.
          Which law applies is decided the ordinary way instead: by where each
          side actually is, where the work was done, and the rules a court
          applies when it is asked to take a case. A clause in this document
          would not settle that, and leaving it out takes nothing away from
          you. <a href="#t-nopromise">Section 11</a> stands either way: nothing
          on this page signs away a right the law gives you, and there is no
          arbitration agreement and no class-action waiver in it.
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
