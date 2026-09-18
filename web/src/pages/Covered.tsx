import { Link } from 'react-router-dom';
import Crumbs from '../components/Crumbs';
import PaymentState, { AccountState } from '../components/PaymentState';
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
 * AND EVERY ONE OF THE MONEY FIGURES MOVES REAL MONEY. The customer pays the
 * full listed price by card at the moment they book, Round The Way holds it
 * until the job is done and then pays the business — see PaymentState.tsx,
 * which carries the one description of that and is rendered at the top of this
 * page. The ladder below is arithmetic real code performs on money that has
 * already left somebody's card, so a rung on it is an amount a reader is about
 * to lose. For months this file said the opposite, in a paragraph that stayed
 * put after the switch was thrown; that is why the ladder is stated in the
 * present tense and never softened.
 *
 * The last section is the one that earns the page. A page that lists what it
 * covers and stops there is read as covering everything it did not mention,
 * and the person who finds out otherwise finds out at the worst possible
 * moment. So "what this does not do" is a section of the same weight as the
 * rest, and it says the four words nobody wants to write: no guarantee, no
 * insurance, no damage cover, no vetting.
 *
 * THE SHAPE IS THE REFERENCE'S AND THE CONTENT IS ITS OPPOSITE. Their page
 * runs: a band saying they will help, two guarantees with a figure and a
 * deadline each, numbered steps for claiming, questions, then the eligibility
 * fine print. Every one of those slots is the right slot — a reader wants to
 * know what they are getting, then what to do, then the edges of it, in that
 * order — and the money in three of them does not exist here. So the slots are
 * kept and filled with the honest answer to the same question:
 *
 *   their guarantee band      -> "What a booking is", both halves of it, first
 *                                screen, before any mechanism is described.
 *   their claims process      -> "If something goes wrong", which has to be
 *                                written from the fact that the money is held
 *                                only between the booking and the job and
 *                                there is no fund to pay a claim out of, so
 *                                most of its steps are about the record and
 *                                the last one is about the routes that are
 *                                not us.
 *   their FAQs                -> the questions somebody in trouble actually
 *                                types, answered without a fund to point at.
 *   their terms of eligibility -> "The limits on all of this", which is fine
 *                                print in the sense of being exact, not in the
 *                                sense of being where the bad news is hidden.
 *
 * NOTHING IN THE NEW SECTIONS PROMISES A HUMAN RESPONSE, A TIMESCALE OR AN
 * OUTCOME. A page telling somebody what to do when a job has gone wrong is
 * read by somebody angry, and the one thing that would make it worse is a
 * process that sounds like a claim and settles nothing.
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

/**
 * The questions, as an array for the same reason the ladder is one.
 *
 * THESE ARE THE QUESTIONS SOMEBODY IN TROUBLE TYPES, not the questions a
 * marketing page wishes they would ask. The reference's FAQ block is where it
 * explains its claim windows and its evidence requirements; ours is where the
 * six most likely versions of "so what happens to me" get an answer that does
 * not end in a fund. Each answer is a fact from the product or a plain "no".
 *
 * DELIBERATELY NOT EMITTED AS FAQPage STRUCTURED DATA. Trade.tsx marks its
 * questions up because those pages are built to be found by somebody searching
 * for the trade; this one would be asking a search engine to feature "can you
 * refund me" against a page whose answer is no, which serves nobody, and the
 * server does not render this route anyway.
 */
const QUESTIONS: Array<{ q: string; a: string }> = [
  {
    q: 'The work was bad and the job is finished. Can you get my money back?',
    a: 'No. Your payment is held between the booking and the job and then goes '
      + 'to the business, and there is no fund here that buys back work you '
      + 'are unhappy with and no claims process to open. The refunds this site '
      + 'makes are the ones on the cancellation ladder above and nothing more. '
      + 'What this site holds besides is the record — the messages, the '
      + 'photographs, the times both sides marked — and that record is what is '
      + 'worth something to their insurer, to the board that licenses them, or '
      + 'in small claims.',
  },
  {
    q: 'They damaged something. Who pays for it?',
    a: 'Not Round The Way: there is no damage cover here, of any amount, and no '
      + 'mechanism in the product that could pay one. It is the business\'s '
      + 'liability and their insurance is what it is for. Ask them for their '
      + 'certificate of insurance and claim against it. A policy number typed '
      + 'onto a profile page is that business telling you about itself and was '
      + 'never checked by anybody here.',
  },
  {
    q: 'Can a business get a bad review taken down?',
    a: 'There is no path in this product for the business a review is about '
      + 'to edit, hide or delete it, and nothing in the product writes the '
      + 'flag that would hide one from anybody else either. A business can '
      + 'reply, once, and the reply cannot be edited afterwards. A review can '
      + 'only come from a booking that actually completed on this site, one '
      + 'per booking.',
  },
  {
    q: 'How long do I have?',
    a: 'For the product\'s own clocks: a no-show report can be filed once the '
      + 'appointment has finished, and the question after a business cancels '
      + 'closes about three hours after the appointment was due and at the '
      + 'outside after seven days. For evidence: job photographs and the map '
      + 'coordinates are deleted ninety days after the job and the '
      + 'conversation at a hundred and eighty. Nothing outside this site — a '
      + 'claim, a complaint, a court — runs on our clocks, and those deadlines '
      + 'are usually much longer.',
  },
  {
    q: 'The business asked me to pay in cash, or to book directly next time. Is that a problem?',
    a: 'It is your money and your decision, and this is not a rule being '
      + 'enforced at you. What is worth knowing is what it costs you: a job '
      + 'arranged off the site has no booking behind it, so it has no held '
      + 'time, no start code, no photographs, no record of what was agreed and '
      + 'no review at the end. Every mechanism on this page stops existing. '
      + 'That is the real reason contact details are stripped out of messages.',
  },
  {
    q: 'Do you check that the business is licensed or insured?',
    a: 'No. Nothing on this site verifies a licence number against the board '
      + 'that issued it, and nobody rings an insurer. Where California '
      + 'licenses a trade, our pages name the board so you can look the number '
      + 'up yourself, and the Safety page sets out what to ask for and where '
      + 'to check it.',
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
          Round The Way is not an insurer and this page is not a guarantee. It is a
          list of the things the site actually does to make a booking between
          two strangers safer to make — and, at the bottom, a list of the
          things it does not do, which is the half most sites leave out.
        </p>
      </header>

      {/* --- money ------------------------------------------------------
          The notice comes before the section rather than inside it, because
          every figure under it is a share of money the reader has already
          paid, and somebody who meets the percentages before they know they
          paid anything has formed the wrong picture of both. */}
      <PaymentState />

      {/* And what booking asks of the reader, beside what it costs them. This
          page described a cancellation ladder in detail while never mentioning
          that booking needs an account at all, which is a strange thing for the
          page somebody reads to find out what they are getting into. */}
      <AccountState />

      {/* --- what a booking is --------------------------------------------
          THE SLOT THE REFERENCE FILLS WITH ITS TWO GUARANTEES. Theirs are the
          first thing under the heading — a figure, a deadline, a promise — for
          a good reason: it is the question the visitor came with. The question
          is the same here and the answer is different, so the answer goes in
          the same place rather than being left to be inferred from six
          sections of mechanism and one warning at the bottom.

          Both halves are stated together, deliberately. A list of what a
          booking does, standing alone, is read as a list of everything a
          booking does. */}
      <section className="info-sec first" aria-labelledby="c-booking">
        <h2 id="c-booking">What a booking is</h2>
        <p>
          It is an appointment held in one person's diary, and a record of what
          the two of you agreed. That is a smaller thing than the word
          "guarantee" on a competitor's page, and it is worth being exact about
          in both directions.
        </p>

        <h3>What booking one does</h3>
        <ul className="info-list">
          <li>
            <strong>Holds one specific hour</strong> in the diary of the person
            who will do the work. Not a request, not a quote, not a lead sent
            to five businesses to bid on — the time is yours from the moment
            you take it.
          </li>
          <li>
            <strong>Takes the money and holds it.</strong> You pay the listed
            price by card as you book. Round The Way holds it until the job is
            done and then pays the business, which is what makes a refund
            something already in hand rather than something somebody has to be
            persuaded to send back.
          </li>
          <li>
            <strong>Fixes the price at the one you were shown.</strong> The
            business sets it; nothing here marks it up, adds a booking fee or a
            service charge, or lets the price move afterwards. The only thing
            that can be added later is a part you approve first.
          </li>
          <li>
            <strong>Puts the two of you on a record neither side owns.</strong>{' '}
            The vehicle before they arrive, the start code at the door,
            photographs from both sides, and one conversation kept in one
            place. If it is ever disputed, that is what it is disputed on.
          </li>
          <li>
            <strong>Applies the same cancellation ladder to both of you.</strong>{' '}
            The rungs below cost a business exactly what they cost a customer.
          </li>
          <li>
            <strong>Earns you a review the business cannot take down.</strong>{' '}
            One per completed booking, from the person who paid for it, and
            there is no path in this product for a business to edit, hide or
            delete one.
          </li>
        </ul>

        <h3>What booking one does not do</h3>
        <ul className="info-list">
          <li>
            <strong>It does not hold the money once the job is done.</strong>{' '}
            Round The Way holds your payment between the booking and the job and
            then pays the business. After that there is nothing here to refund
            from.
          </li>
          <li>
            <strong>It does not put anybody between you and the business if
            the work is bad.</strong> There is no fund, no adjudicator and no
            claim to open. What there is is the record above, which is yours to
            use wherever it is worth using.
          </li>
          <li>
            <strong>It does not mean anybody has been checked.</strong> No
            background check, no identity check, no licence verified against
            the board that issued it.
          </li>
          <li>
            <strong>It does not insure you, your home or your car.</strong>
          </li>
        </ul>

        <p className="note">
          That second list is the short version, put here rather than only at
          the bottom because a page that saves its limits for the end is a page
          most people never read the limits of.{' '}
          <a href="#c-not">What this does not do</a> sets out all of them.
        </p>
      </section>

      <section className="info-sec" aria-labelledby="c-money">
        <h2 id="c-money">How the money works</h2>
        <p>
          You pay for the labour when you book, on this site: no cash, nothing
          paid at the door, and the price you agree to is the price the
          business listed. Nothing is added at checkout. The card goes into the
          payment processor's own form and never reaches Round The Way's
          servers — what is held here is the processor's reference, which is
          not a card number and cannot be used as one. That is enforced rather
          than promised: a request, a database write or a response carrying
          something shaped like a card number is refused everywhere in the
          product.
        </p>
        <p>
          Round The Way holds that money between the booking and the job and
          pays the business after the work. That is what makes the rest of this
          page work as written: a refund is money already being held rather
          than money somebody has to be persuaded to send back.
        </p>
        <p>
          What Round The Way takes is 15% of the job, never more than $150 from
          one business in one day. It comes out of the business's share and is
          never added to yours, and there is no subscription and nothing
          charged to either side for using the site.
        </p>

        <h3>Parts are quoted and approved before anything is fitted</h3>
        <p>
          A business says up front which of three things is true of a job: it
          needs no parts, parts are already inside the price, or the part
          cannot be known until somebody looks. Only the third one leaves
          anything open, and there the rule is absolute: the business sends you
          a price for the part in your messages, and nothing is fitted until
          you tap approve. A quote stays approvable for three days and then
          expires by itself. Tapping approve is also what charges you for it.
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
          One ladder, both directions. What it costs a business to cancel on
          you is what it costs you to cancel on them, and the windows are the
          same. Everything is measured from when the appointment starts.
        </p>
        <p className="note">
          Every figure in this section is money. You paid the full price by
          card when you booked, so a rung on this ladder is what you get back
          and what you do not — inside 12 hours that is a quarter of what you
          paid. The rung you are on is what the notice at the top of your
          booking shows you before you confirm, either way.
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
            Round The Way and never comes out of your refund.
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
          When a business cancels, the money freezes on both sides and you are
          asked one thing: did they do the
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

      {/* --- when it goes wrong -------------------------------------------
          THE REFERENCE'S CLAIMS PROCESS, WHICH IS THE HARDEST SLOT ON THE PAGE
          TO FILL HONESTLY. Theirs is four steps ending in a payment: get it in
          writing, tell us inside the window, send proof that you hired them,
          and they assess it. Ours cannot end in a payment: the money is held
          only between the booking and the job, and once the work is done it
          has gone to the business and there is no fund to pay a claim out of —
          so writing four steps in that shape would be describing a claims
          process that resolves nothing, which is worse than describing none.

          What it ends in instead is the truthful thing: a record, and the list
          of places where a record is worth something. Steps one to three are
          the ones that decide whether anybody can ever tell what happened, and
          they are the steps that stop being possible if you leave them a
          month; step five is the only part of this page with any actual force
          behind it, and none of that force is ours. Saying so is the point. */}
      <section className="info-sec" aria-labelledby="c-wrong">
        <h2 id="c-wrong">If something goes wrong</h2>
        <p>
          In order, and the order matters — the first three are about making
          sure it is still possible to tell what happened, and they get harder
          every day you leave them.
        </p>

        <ol className="info-steps">
          <li>
            <h3>Say it in the booking, not on the phone</h3>
            <p>
              The booking's own conversation is the record, it is timestamped,
              and neither of you can edit it afterwards. A call is not a
              record, and an argument settled by two people's memory of a phone
              call is not settled. Write what happened while it is fresh, even
              if you also ring them.
            </p>
          </li>
          <li>
            <h3>Photograph it today</h3>
            <p>
              Both sides can add photographs to a booking, before, during and
              after. Take them now: the whole set is deleted ninety days after
              the job, so the evidence has a clock on it whether or not the
              argument does.
            </p>
          </li>
          <li>
            <h3>Use the buttons that exist for it</h3>
            <p>
              A cancellation is a cancellation, and the ladder above decides it
              from the time it happens. Somebody not turning up at all is a
              report, once per booking, from either side. Neither is a message
              asking somebody to look into it — they are the two events this
              product can actually act on.
            </p>
          </li>
          <li>
            <h3>Tell us, knowing what that can and cannot do</h3>
            <p>
              A person here reads it. What that can do: uphold a no-show report
              and suspend an account on the three, seven and thirty day ladder,
              take a listing down, close an account to new bookings, and settle
              the one question asked after a business cancels. What it cannot
              do is refund you outside the ladder above, because the ladder is
              the whole of the refund rules and the money goes to the business
              once the job is done; pay for damage, because there is no cover
              behind it; or make anybody come back and finish a job.
            </p>
            <p className="note">
              There is no promised response time for this, here or anywhere
              else on the site, and no case number to quote at anybody.
            </p>
          </li>
          <li>
            <h3>Then use the routes that do have teeth</h3>
            <p>
              These are the ones that can actually cost the business something,
              and none of them is us. The record from steps one and two is what
              you take to them.
            </p>
            <ul className="info-list">
              <li>
                <strong>Their insurer.</strong> If a business listed an insurer
                and a policy number on its profile, that is the policy damage
                would be claimed against — by you, against them, in the
                ordinary way. Ask them for the certificate. Nothing here
                verified it and it is not cover arranged through us.
              </li>
              <li>
                <strong>The board that licenses the trade.</strong> Where
                California licenses the work, that board takes consumer
                complaints and it is the same board that can act on the
                licence.{' '}
                <Link to="/safety">Safety</Link> names the board for each trade
                and where to look a licence up.
              </li>
              <li>
                <strong>Your bank, if you paid the business anything
                directly.</strong> Money that went to the business rather than
                through this site is between you, them and your card issuer,
                and a chargeback is that issuer's process rather than ours. We
                have no visibility of it and cannot start, stop or evidence
                one.
              </li>
              <li>
                <strong>Small claims.</strong> California's small claims court
                is built for disputes this size and does not need a lawyer. The
                court's own site sets out the current limit and how to file.
              </li>
            </ul>
          </li>
        </ol>
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
              Round The Way does not pay for a scratched car, a cracked tile or a
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
              bank account to be paid into before its openings go up, and that
              is the whole of it.
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

      {/* --- questions ---------------------------------------------------
          <details> rather than a scripted accordion, for the reasons Help.tsx
          gives where the same markup first appeared: it opens with JavaScript
          off, browser find-in-page reaches inside it in most engines, and the
          disclosure semantics come free instead of being rebuilt out of
          aria-expanded. */}
      <section className="info-sec" aria-labelledby="c-qs">
        <h2 id="c-qs">Questions</h2>
        <div className="info-qs">
          {QUESTIONS.map((item) => (
            <details className="info-q" key={item.q}>
              <summary>{item.q}</summary>
              <p className="info-a">{item.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* --- the edges ----------------------------------------------------
          THE REFERENCE ENDS ON EIGHT NUMBERED CONDITIONS OF ELIGIBILITY, and
          the shape is worth keeping even though we have nothing to be eligible
          for: a page of general statements needs one place that says exactly
          where each of them stops. The difference is what fine print is FOR
          here. Theirs narrows a promise. This narrows a description, and every
          line of it is something the reader would rather know now. */}
      <section className="info-sec" aria-labelledby="c-limits">
        <h2 id="c-limits">The limits on all of this</h2>
        <ol className="info-list">
          <li>
            Everything on this page applies to a booking made on this site and
            to nothing else. A job arranged in a phone call, a text or cash at
            the door has no booking behind it and none of these mechanisms
            exist for it.
          </li>
          <li>
            Every window is measured from the moment the appointment is due to
            start, not from when it was booked and not from when anybody
            noticed.
          </li>
          <li>
            Every percentage on this page is worked out on the price of the job
            you paid when you booked. Parts you approved are outside all of it.
          </li>
          <li>
            The evidence expires before most disputes do: photographs and map
            coordinates at ninety days after the job, the conversation at a
            hundred and eighty. Save anything you may need before then.
          </li>
          <li>
            A no-show report and the suspension that can follow it are filed by
            a person and upheld by a person. Nothing on that ladder is
            automatic, and nothing about it is promised to happen within any
            particular time.
          </li>
          <li>
            Suspensions and unpaid fees never touch work already in a diary.
            Those customers keep their appointments.
          </li>
          <li>
            This page describes how the product behaves. It is not legal
            advice, and — as <Link to="/terms">Terms</Link> says in its own
            words — nothing here attempts to waive anybody's rights or take
            away a right the law gives you.
          </li>
        </ol>
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
