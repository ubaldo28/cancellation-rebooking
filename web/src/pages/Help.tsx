import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import Crumbs from '../components/Crumbs';
import PaymentState, { AccountState, PAY_TODAY_SHORT } from '../components/PaymentState';
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
      To book, yes. To look, no. Nothing here asks who you are until you press
      Book, and at that moment you give an email address and type the six digits
      we send to it. That is the whole of it: no password and nothing to
      remember. The account is made in the same press that books the
      appointment, so it is not a screen standing in front of one. You give a
      phone number as well, so the business can ring you on the day, but that is
      not what signs you in. You add a card on the same screen, because that
      press is also what pays for the appointment.
    </>,
  },
  {
    q: 'I have booked before. How do I get back to it?',
    a: <>
      Either the link in your confirmation, which opens that booking on any
      phone whether or not you are signed in, or{' '}
      <Link to="/account">your account</Link>, where the same email address
      lists every booking you have made — including the ones from before there
      was an account — and every conversation you have had, with the messages,
      the photographs, the start code and the van inside it. The link is
      quicker because it needs no sign-in; the account is what still works when
      the link is gone.
    </>,
  },
  {
    /*
      THIS ANSWER WAS HALF AN ANSWER AND THE MISSING HALF WAS THE ONE ASKED
      FOR. It said the booking is listed at your account and the link cannot be
      reissued — both true — and left out what to do about the conversation,
      which is what somebody who has lost a link actually wants: the messages
      agreeing the work, the photographs, the four digits for the doorstep, and
      the card form if nobody has charged them yet. All of that used to be
      behind the link and nowhere else, so there was nothing better to say. The
      conversation is on the account now; this says so.
    */
    q: 'I lost the link to my booking.',
    a: <>
      Sign in at <Link to="/account">your account</Link> with the email address
      you booked on. The booking is listed there and so is the conversation
      about it, which you can open and carry on from — the messages, the
      photographs, your start code and the card form if it is not paid for yet.
      You do not need the link for any of it. The link itself cannot be sent
      again: only a fingerprint of it is stored, on purpose, so that nobody
      here is able to hand anybody a way into your conversation.
    </>,
  },
  {
    /*
      Asked because the answer above invites it, and because the honest answer
      is "not always". A conversation is put on an account when the person was
      signed in at the time or when it became a booking made on that account.
      An anonymous question from a profile page has no order, no appointment
      and no client row behind it, so there is nothing tying it to anybody —
      and matching one up later would mean guessing whose it was, which is how
      a stranger ends up reading somebody else's messages. Better to say so
      here than to leave somebody hunting for a conversation this site is
      never going to be able to show them.
    */
    q: 'A question I asked is not in my conversations.',
    a: <>
      Asking a business a question needs no account, so a question sent while
      you were signed out is not attached to one — the private page you were
      taken to is the only way back to it, which is why that page says to save
      the address. Anything you ask while signed in, and every conversation
      about a booking, is listed at <Link to="/account">your account</Link>.
      We will not guess which account an anonymous message belonged to: that
      guess going wrong means showing your conversation to somebody else.
    </>,
  },
  {
    q: 'When do I pay, and what for?',
    a: <>
      {PAY_TODAY_SHORT} What you pay for is the price the business listed for
      the labour, which is the figure shown on the opening. The card goes into
      the payment processor's own form, on this site — you are never sent
      somewhere else to pay.{' '}
      <Link to="/covered">What is covered</Link> sets out how much comes back
      if it is cancelled.
    </>,
  },
  {
    q: 'What if the job needs a part?',
    a: <>
      Businesses say up front whether a job needs parts, includes them, or
      cannot know until somebody looks. In the last case the business sends you
      a price in your messages and nothing is fitted until you tap approve. A
      quote expires after three days. Tapping approve is also what charges you
      for the part.
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
      You paid when you booked, so this is real money and some of it can stay
      with the business. More than 48 hours before it starts, everything comes
      back. Inside 48 hours, three quarters. Inside 12 hours, a quarter — the
      business has kept that time free and turned other work away for it.
      Change your mind within 30 minutes of booking and you get all of it back,
      as long as the appointment is still at least three hours away. You always
      see the exact figure before you confirm.
    </>,
  },
  {
    q: 'Can I move an appointment instead of cancelling it?',
    a: <>
      There is no reschedule button. Message the business on the booking and
      ask — moving it is usually fine and it is theirs to agree to.
    </>,
  },
  {
    q: 'The business cancelled on me. What happens?',
    a: <>
      Your money freezes and you are asked one question: did they do the work
      anyway? Answering that they did not releases your refund — in full,
      always, whatever the business owes. Answering that they did means no
      refund and the business is paid as for a completed job. If nobody answers
      within about three hours of when the appointment was due, the money stays
      where it is and nobody is charged.
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
      Two doors onto the same thing, and both run the same code. Open your
      booking from the link you were sent, scroll to the bottom, and press{' '}
      <strong>Delete my data</strong>; or sign in at{' '}
      <Link to="/account">your account</Link> and press it there, which also
      offers <strong>Close this account</strong> — that one empties the account
      and leaves the bookings, which is a smaller request. You do not have to
      ask anybody. Deleting reaches every business you have booked with using
      that email address, not just the one whose link you are holding, and there
      is no undo.{' '}
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
      Four things stop them, and the app names whichever one applies: no bank
      account to be paid into, location sharing switched off, no vehicle
      recorded, or an unpaid cancellation fee. None of them touches work
      already booked — those customers still get their appointment.
    </>,
  },
  {
    q: 'Do I have to give a card?',
    a: <>
      No. What has to be there before your openings go up is a bank account to
      be paid into: the customer pays on the site at the moment they book, we
      hold it, and your share is sent to that account after the job is done.
      Nothing is charged to you for using the site — no subscription and no
      listing fee. Round The Way keeps 15% of the job, never more than $150
      from one business in one day, and it comes out of your share rather than
      being added to the customer's.
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
      Nothing more than 48 hours out. Inside 48 hours it is a quarter of the
      job, inside 12 hours three quarters, and the whole job once you have said
      you arrived. Minimum $15,
      never more than the job itself, and never calculated on parts the
      customer approved. Those are the same amounts a customer forfeits when
      they cancel on you.
    </>,
  },
  {
    q: 'A customer did not answer the door.',
    a: <>
      Report it from that booking once the appointment has finished. If it is
      upheld, that customer's account cannot book here for three days, then
      seven, then thirty, and a fourth stops it entirely. The record hangs off
      the email address they book with, so closing the account and signing up
      again with it does not clear it. Nothing is applied automatically and
      nothing is charged for a no-show.
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
      it there. Nothing is fitted before that. Their approval is what charges
      them for the part.
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
 * THE TOPICS, and which question goes in which.
 *
 * Grouped by the question text rather than by moving the questions, so the
 * answers above are untouched and a question can never quietly end up in two
 * places or in none — test/help-topics.test.ts fails on either.
 *
 * The reference marketplace's help centre is topic tiles, not one long list:
 * a reader arrives knowing roughly what their problem is about and wants the
 * four questions near it, not the twenty-eight that are not.
 */
const CUSTOMER_TOPICS: Array<{ title: string; qs: string[] }> = [
  {
    title: 'Booking something',
    qs: [
      'What is an "opening"?',
      'Do I need an account?',
      'Nothing is open in my area.',
    ],
  },
  {
    title: 'Getting back to a booking',
    qs: [
      'I have booked before. How do I get back to it?',
      'I lost the link to my booking.',
      'A question I asked is not in my conversations.',
      'Can I move an appointment instead of cancelling it?',
    ],
  },
  {
    title: 'Paying, and what things cost',
    qs: [
      'When do I pay, and what for?',
      'What if the job needs a part?',
      'What does it cost me to cancel?',
    ],
  },
  {
    title: 'On the day',
    qs: [
      'How do I know the right person has turned up?',
      'The business cancelled on me. What happens?',
      'Nobody turned up at all.',
    ],
  },
  {
    title: 'Privacy, safety and getting hold of somebody',
    qs: [
      'Can I send my phone number so we can sort it out directly?',
      'Who can see the photographs of my house?',
      'How do I delete my data?',
      'How do I contact somebody about a booking?',
    ],
  },
];

const BUSINESS_TOPICS: Array<{ title: string; qs: string[] }> = [
  {
    title: 'Getting set up',
    qs: [
      'What does it take to sign up?',
      'Why will my openings not go up?',
      'Do I have to give a card?',
      'Why is location sharing a condition rather than a feature?',
    ],
  },
  {
    title: 'Working a job',
    qs: [
      'How does the "open right now" switch work?',
      'I could not price the part until I saw the job.',
      'A customer did not answer the door.',
    ],
  },
  {
    title: 'Money',
    qs: [
      'What does it cost me to cancel?',
      'Can I ask a customer for the difference in cash?',
    ],
  },
  {
    title: 'Your account and your profile',
    qs: [
      'Do you check my licence or insurance?',
      'Where do reviews come from?',
      'How do I close my account?',
    ],
  },
];

/** One topic's worth of questions, resolved out of the arrays above. */
function pick(all: QA[], qs: string[]): QA[] {
  return qs.map((q) => all.find((x) => x.q === q)).filter((x): x is QA => Boolean(x));
}

function Topic({ title, items }: { title: string; items: QA[] }) {
  if (items.length === 0) return null;
  return (
    <section className="help-topic">
      <h3>{title}</h3>
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

  /**
   * WHICH HALF OF THE PRODUCT YOU ARE ASKING ABOUT.
   *
   * The reference marketplace splits its help centre this way and it is right
   * to: a customer scrolling past twelve questions about payouts and location
   * sharing is a customer who stops scrolling. Both halves stay in the DOM
   * when a search is running, because somebody typing "cancel" wants the
   * answer whichever side they are on.
   */
  const [side, setSide] = useState<'customer' | 'pro'>('customer');
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const searching = query.length > 1;

  /** Matches on the question only. The answers are React nodes, and a search
   *  that claimed to read them would silently miss half of what is in them. */
  const match = (items: QA[]) =>
    (searching ? items.filter((i) => i.q.toLowerCase().includes(query)) : items);

  const cust = useMemo(
    () => CUSTOMER_TOPICS.map((t) => ({ ...t, items: match(pick(CUSTOMER, t.qs)) })),
    [query],
  );
  const biz = useMemo(
    () => BUSINESS_TOPICS.map((t) => ({ ...t, items: match(pick(BUSINESS, t.qs)) })),
    [query],
  );
  const hits = [...cust, ...biz].reduce((n, t) => n + t.items.length, 0);

  return (
    <PublicPage className="info-page help-page">
      <Crumbs items={[{ label: 'Help' }]} />

      <header className="help-hero">
        <h1>How can we help?</h1>
        <p className="info-lede">
          Questions about how Round The Way works, answered from what it actually
          does. If your question is about one particular booking, the
          conversation on that booking is the place to ask it.
        </p>
        {/* A real search over the questions, done in the page. There is no
            search service behind this and there does not need to be: the whole
            help centre is twenty-eight questions, and filtering them in the
            browser is instant and works offline. */}
        <div className="help-find">
          <label className="sr-only" htmlFor="help-q">Search help</label>
          <input
            id="help-q" type="search" value={q} autoComplete="off"
            placeholder="Search help"
            onChange={(e) => setQ(e.target.value)} />
        </div>
        {searching && (
          <p className="help-count" role="status">
            {hits === 0
              ? 'Nothing matches that. Try a shorter word — “cancel”, “card”, “photo”.'
              : `${hits} ${hits === 1 ? 'question' : 'questions'} match “${q.trim()}”.`}
          </p>
        )}
      </header>

      {/* THE QUICK ACTIONS, which the reference help centre puts above its
          topics: the four things somebody arrives wanting to DO rather than
          read about. Every one is a real route. */}
      <nav className="help-quick" aria-label="Quick actions">
        <Link to="/account"><b>Your bookings</b><span>Get back into a booking you already made</span></Link>
        <Link to="/covered"><b>What is covered</b><span>Cancelling, no-shows and what nobody checks</span></Link>
        <Link to="/join"><b>List your business</b><span>Put an opening up</span></Link>
        <Link to="/safety"><b>Safety</b><span>What protects each side</span></Link>
      </nav>

      {/* The audience switch. Hidden while a search is running, because a
          search that only looked at half the questions would be answering a
          question nobody asked. */}
      {!searching && (
        <div className="help-side" role="tablist" aria-label="Who are you?">
          <button type="button" role="tab" aria-selected={side === 'customer'}
            className={side === 'customer' ? 'on' : undefined}
            onClick={() => setSide('customer')}>Help for customers</button>
          <button type="button" role="tab" aria-selected={side === 'pro'}
            className={side === 'pro' ? 'on' : undefined}
            onClick={() => setSide('pro')}>Help for pros</button>
        </div>
      )}

      {(searching || side === 'customer') && (
        <section className="help-half" aria-labelledby="h-customers">
          <h2 id="h-customers">For customers</h2>
          {!searching && <><PaymentState /><AccountState /></>}
          {cust.map((t) => <Topic key={t.title} title={t.title} items={t.items} />)}
        </section>
      )}

      {(searching || side === 'pro') && (
        <section className="help-half" aria-labelledby="h-business">
          <h2 id="h-business">For pros</h2>
          {!searching && <PaymentState audience="pro" />}
          {biz.map((t) => <Topic key={t.title} title={t.title} items={t.items} />)}
        </section>
      )}

      <section className="info-sec" aria-labelledby="h-more">
        <h2 id="h-more">Longer answers</h2>
        <ul className="info-list">
          <li>
            <Link to="/covered">What is covered, and what is not</Link> — the
            mechanisms in full, with the cancellation ladder and the list of
            things Round The Way does not cover.
          </li>
          <li>
            <Link to="/safety">Safety</Link> — what protects each side, and what
            nobody here checks.
          </li>
          <li>
            <Link to="/pros">How Round The Way works for pros</Link> — the whole of
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

      {/* "Still need help?" — the band their help centre closes on. Ours says
          the true thing rather than offering a queue that does not exist. */}
      <section className="help-still" aria-labelledby="h-still">
        <h2 id="h-still">Still need help?</h2>
        <p>
          There is no support phone line and no support mailbox. If it is about
          one booking, the conversation on that booking reaches the business
          directly and is the fastest route there is.
        </p>
        <p className="help-still-do">
          <Link className="btn" to="/account">Open your bookings</Link>
        </p>
      </section>
    </PublicPage>
  );
}
