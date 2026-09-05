import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import Crumbs from '../components/Crumbs';
import PaymentState, { PAY_TODAY_SHORT } from '../components/PaymentState';
import PublicPage from '../components/PublicPage';
import { useDocumentTitle } from '../lib/title';
import '../styles-info.css';

/**
 * Help. Route /help.
 *
 * The footer has carried "Help centre" as inert grey text since it was
 * written. This is it, and it is a list of questions rather than a support
 * portal, because there is no ticket queue behind this product and a page
 * promising one would be the first thing on the site to be caught lying.
 *
 * EVERY ANSWER IS BEHAVIOUR, NOT POLICY. Each one describes something the code
 * does, and where the honest answer is "you cannot do that here" the answer
 * says so and names what you can do instead. The two most important entries
 * are the deletion paths — the customer's "Delete my data" button and the
 * business's "Close account" — because those are rights that are worthless if
 * nobody can find the button.
 *
 * WHY EVERY "HOW DO I CONTACT SUPPORT" ANSWER POINTS AT THE BOOKING. It is the
 * only contact route this product has. There is no support address in the
 * codebase, no phone number and no form; the conversation attached to a
 * booking is where a customer and a business reach each other, and inventing a
 * mailbox on this page would send people somewhere nobody is reading.
 *
 * The structure copies the reference marketplace's help centre in one respect
 * only: two audiences, separately, because a customer scrolling past nine
 * questions about payouts is a customer who stops scrolling.
 */

interface QA { q: string; a: ReactNode }

/** Answers drawn from bypass.ts, parts.ts, startcode.ts, proof.ts, settlement.ts,
 *  standing.ts, redact.ts, retention.ts and the guest booking page. */
const CUSTOMER: QA[] = [
  {
    q: 'What is an "opening"?',
    a: <>
      An hour a local business has free this week — a job that cancelled, or a
      day that did not fill. That is why they appear without warning and do not
      last, and why the price is often lower: the van is already going to be on
      your street.
    </>,
  },
  {
    q: 'Do I need an account?',
    a: <>
      No, and there is not one to create. Your booking lives behind a secret
      link that is emailed to you, and that link is how you open the
      conversation, see the start code, watch for the van and manage the
      booking. Keep it: anybody who has it can see all of that.
    </>,
  },
  {
    q: 'When do I pay, and what for?',
    a: <>
      {PAY_TODAY_SHORT} What you are agreeing to is the price the business
      listed for the labour, which is the figure shown on the opening. The
      design is that you pay that here at the moment you book, with card
      details going into the payment processor's own form and never reaching
      Slotfill — but that part is not built, so today nothing is taken.{' '}
      <Link to="/covered">What is covered</Link> sets out what changes when it
      is.
    </>,
  },
  {
    q: 'What if the job needs a part?',
    a: <>
      Businesses say up front whether a job needs parts, includes them, or
      cannot know until somebody looks. In the last case the business sends you
      a price in your messages and nothing is fitted until you tap approve. A
      quote expires after three days. Once paying on the site is switched on,
      that approval is also what charges you for the part.
    </>,
  },
  {
    q: 'How do I know the right person has turned up?',
    a: <>
      You are shown the make, colour and plate of the vehicle before anyone
      arrives, and it has to match what is on your driveway. You then read out
      a four-digit start code that only you can see, and they type it in to
      start the job. Five wrong tries and the code stops working.
    </>,
  },
  {
    q: 'What does it cost me to cancel?',
    a: <>
      Today, nothing at all: no money has been taken, so there is none to keep
      back. The ladder it will run on once payment is switched on is this. More
      than 48 hours before it starts, everything comes back. Between 12 and 48
      hours, three quarters. Inside 12 hours, a quarter — the business has kept
      that time free and turned other work away for it. Change your mind within
      30 minutes of booking and you get all of it back, as long as the
      appointment is still at least three hours away. You always see the exact
      figure before you confirm.
    </>,
  },
  {
    q: 'Can I move an appointment instead of cancelling it?',
    a: <>
      There is no reschedule button. Message the business on the booking and
      ask — moving it is usually fine and it is theirs to agree to, and it
      costs neither of you anything.
    </>,
  },
  {
    q: 'The business cancelled on me. What happens?',
    a: <>
      You are asked one question: did they do the work anyway? Today that is
      all that happens, because there is no money on either side to move. Once
      payment is switched on, answering that they did not releases your refund
      — in full, always, whatever the business owes. Answering that they did
      means no refund and the business is paid as for a completed job. If
      nobody answers within about three hours of when the appointment was due,
      the money stays where it is and nobody is charged.
    </>,
  },
  {
    q: 'Nobody turned up at all.',
    a: <>
      Report it from that booking once the appointment time has passed. A
      report changes nothing on its own; somebody here looks at it. If it is
      upheld the business is suspended — three days, then seven, then thirty,
      then the account closes to new bookings.
    </>,
  },
  {
    q: 'Can I send my phone number so we can sort it out directly?',
    a: <>
      It will be removed from the message before it is stored, and you will be
      told that it was. Everything about a booking — the payment, the refund
      rules, the photographs, the report route — exists because the booking is
      here. Off the site, none of it does.
    </>,
  },
  {
    q: 'Who can see the photographs of my house?',
    a: <>
      You, the business on that booking, and a dispute review. Nobody else,
      ever — never on a public profile, never in search, never as advertising.
      The only way one becomes public is you choosing to attach it to your own
      review. All of them are deleted 90 days after the job.
    </>,
  },
  {
    q: 'How do I delete my data?',
    a: <>
      Open your booking from the link you were sent, scroll to the bottom, and
      press <strong>Delete my data</strong>. You do not have to ask anybody. It
      reaches every business you have booked with using that phone number, not
      just the one whose link you are holding, and there is no undo.{' '}
      <Link to="/privacy">Privacy</Link> lists exactly what goes, what is
      emptied and what is kept.
    </>,
  },
  {
    q: 'Nothing is open in my area.',
    a: <>
      That happens — an opening only exists when somebody has an hour free.
      Set an alert and you will be told when one appears near your postcode.
      Switching the alert off later deletes it.
    </>,
  },
  {
    q: 'How do I contact somebody about a booking?',
    a: <>
      Through the conversation on that booking. It is the only contact route
      this product has: there is no support phone number and no support
      mailbox, and this page will not pretend otherwise.
    </>,
  },
];

const BUSINESS: QA[] = [
  {
    q: 'What does it take to sign up?',
    a: <>
      An email address, your business name and your country, then four short
      screens: what you do and where, what you sell and for how much, your
      hours, and the jobs already in your diary. There is no password —
      signing in is a link emailed to you. You can stop part way and come back
      to the screen you left. <Link to="/pros">How it works for pros</Link>{' '}
      is the longer version.
    </>,
  },
  {
    q: 'Why will my openings not go up?',
    a: <>
      Four things stop them, and the app names whichever one applies: no card
      on file, location sharing switched off, no vehicle recorded, or an unpaid
      cancellation fee. None of them touches work already booked — those
      customers still get their appointment.
    </>,
  },
  {
    q: 'Why do you want a card if nothing is charged for using the site?',
    a: <>
      It is there for one thing: cancelling a job late. Nothing has ever been
      charged to it and nothing can be yet — no money moves through Slotfill at
      all until payment is switched on. When it is, a fee will come out of your
      next payout where there is one, and the card will be used only where
      there is not.
    </>,
  },
  {
    q: 'Why is location sharing a condition rather than a feature?',
    a: <>
      It shows a waiting customer that the van is coming, and it is what proves
      you were where you said you were if a job is ever disputed. With it off
      there is no way to tell an honest cancellation from a job done off the
      books.
    </>,
  },
  {
    q: 'What does it cost me to cancel?',
    a: <>
      Today nothing, because no fee can be collected until payment is switched
      on. The ladder it will run on is this. Nothing more than 48 hours out.
      Inside 48 hours it is a quarter of the job, inside 12 hours three
      quarters, and the whole job once you have said you arrived. Minimum $15,
      never more than the job itself, and never calculated on parts the
      customer approved. Those are the same amounts a customer forfeits when
      they cancel on you.
    </>,
  },
  {
    q: 'A customer did not answer the door.',
    a: <>
      Report it from that booking once the appointment has finished. If it is
      upheld, that number cannot book here for three days, then seven, then
      thirty, and a fourth stops it entirely. Nothing is applied automatically
      and nothing is charged for a no-show.
    </>,
  },
  {
    q: 'How does the "open right now" switch work?',
    a: <>
      Flip it and nearby customers can send you a job on the spot. It turns
      itself off after three hours, accepting a job turns it off, nothing is
      ever assigned to you, and you have five minutes to answer a request
      before it goes to somebody else.
    </>,
  },
  {
    q: 'I could not price the part until I saw the job.',
    a: <>
      Set that service's parts answer to quoted. You then send the price from
      the driveway, into the booking's own messages, and the customer approves
      it there. Nothing is fitted before that. Once payment is switched on that
      approval is what charges them through the site; until then it is the
      agreed number and you settle it with them yourself.
    </>,
  },
  {
    q: 'Can I ask a customer for the difference in cash?',
    a: <>
      No. There is no path in this product for charging an amount the customer
      has not approved, and asking for one at the door is outside the{' '}
      <Link to="/terms">terms</Link>.
    </>,
  },
  {
    q: 'Do you check my licence or insurance?',
    a: <>
      No. You can record a licence, an insurer and a background check on your
      profile, and the page shows them as your own statement about yourself
      with the issuing authority named next to them. Nothing here verifies any
      of it — which also means nobody else on this site has been vetted.
    </>,
  },
  {
    q: 'Where do reviews come from?',
    a: <>
      Only from a completed booking made through this site, one per booking.
      They cannot be bought, invented or removed on request, and you can reply
      to one.
    </>,
  },
  {
    q: 'How do I close my account?',
    a: <>
      <strong>Close account</strong> in Settings. It really empties your
      personal details rather than flagging a row, and it deletes your client
      list, your conversations and the requests strangers sent you. It is
      refused while you still have bookings in the diary — closing then would
      leave those customers with nobody coming and no way to reach you — so
      cancel or finish those first. <Link to="/privacy">Privacy</Link> lists
      what survives and why.
    </>,
  },
];

/**
 * `intro` sits between the heading and the questions, for the one thing a
 * reader of that half has to know before they open any of them. It is a slot
 * rather than another QA row because a fact that answers nine of the questions
 * is not itself a tenth question, and folding it in would hide it behind a
 * disclosure nobody has a reason to open.
 */
function Group({ id, title, items, intro }: {
  id: string; title: string; items: QA[]; intro?: ReactNode;
}) {
  return (
    <section className="info-sec" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {intro}
      {/* <details> rather than a script-driven accordion: it opens with
          JavaScript off, it is findable by the browser's own find-in-page in
          most engines, and the disclosure semantics come free rather than
          being reimplemented with aria-expanded. */}
      <div className="info-qs">
        {items.map((item) => (
          <details className="info-q" key={item.q}>
            <summary>{item.q}</summary>
            <p className="info-a">{item.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

export default function Help() {
  useDocumentTitle('Help');

  return (
    <PublicPage className="info-page">
      <Crumbs items={[{ label: 'Help' }]} />

      <header className="info-head">
        <h1>Help</h1>
        <p className="info-lede">
          Questions about how Slotfill works, answered from what it actually
          does. If your question is about one particular booking, the
          conversation on that booking is the place to ask it — that is the only
          contact route this product has.
        </p>
      </header>

      {/* Once in each half rather than once at the top, because the two
          audiences need different halves of the same fact: a customer wants to
          know what pressing Book does to their card, and a business wants to
          know whether a booking arrives paid. Both are the answer to several of
          the questions underneath them, which is why neither is a question. */}
      <Group id="h-customers" title="Booking something" items={CUSTOMER}
        intro={<PaymentState />} />
      <Group id="h-business" title="Listing a business" items={BUSINESS}
        intro={<PaymentState audience="pro" />} />

      <section className="info-sec" aria-labelledby="h-more">
        <h2 id="h-more">Longer answers</h2>
        <ul className="info-list">
          <li>
            <Link to="/covered">What is covered, and what is not</Link> — the
            mechanisms in full, with the cancellation ladder and the list of
            things Slotfill does not cover.
          </li>
          <li>
            <Link to="/safety">Safety</Link> — what protects each side, and what
            nobody here checks.
          </li>
          <li>
            <Link to="/pros">How Slotfill works for pros</Link> — the whole of
            the business side before you sign up.
          </li>
          <li>
            <Link to="/privacy">Privacy</Link> — what is collected, how long it
            is kept, and both ways of deleting it.
          </li>
          <li>
            <Link to="/terms">Terms</Link> — the rules, in the same plain words.
          </li>
        </ul>
      </section>

      <footer className="info-foot">
        <p>
          There is no support phone line and no support mailbox. Everything on
          this page can be done from your own booking or from the app.
        </p>
      </footer>
    </PublicPage>
  );
}
