import '../styles-home.css';

/**
 * The two explainer bands on the front door: how it works, and why book here.
 *
 * The shape is borrowed from the reference marketplace — a numbered three-step
 * module, a three-up strip of value props, a localised social-proof sentence —
 * because that sequence answers, in order, the three questions a stranger
 * actually has: what happens if I do this, why here rather than a phone call,
 * and is anyone else doing it near me.
 *
 * The shape is borrowed. The claims are not, and this is the line that matters:
 * the reference is a lead board — you describe a job, businesses bid, you pick.
 * Round The Way sells a specific hour of a specific person's real calendar, paid for
 * in full at the moment you take it. So nothing in this file may say estimate,
 * bid, lead, or "compare prices" — every one of those would describe a product
 * this site does not have, and the first thing a visitor would notice is that
 * the site does not behave the way the front page said it would.
 *
 * Two separate exports rather than one <Explainer />, because the bands
 * alternate grounds and the page decides that order.
 *
 * A third export lived here — a "there are N appointments open in your
 * neighbourhood" line — and no page ever rendered it, so it and its two
 * stylesheet rules have gone. There is nothing left here that fetches or
 * counts: this file is copy, and it can be rendered in a test with no network
 * and no router at all.
 */

/* --------------------------------------------------------------------------
 * How it works
 * ----------------------------------------------------------------------- */

/**
 * Kept out of the JSX so the three steps can be read as one paragraph while
 * editing them. The copy is the point of this component; the markup is four
 * lines and needs no attention.
 *
 * Each step is written from the visitor's side of the transaction — what they
 * do, then what happens to them — because the version written from ours ("we
 * verify", "we hold funds") reads as a company describing its own plumbing.
 */
const STEPS = [
  {
    title: 'Find an hour that is genuinely free',
    body:
      'Search your neighbourhood and see the appointments local trades have '
      + 'open this week. Every time on Round The Way is a real gap in someone\'s '
      + 'day at a price they have already set.',
  },
  {
    // Paying here is what the Book button does — see PaymentState.tsx — and
    // this step is the front page's own description of that button, so it is
    // the step that would be caught out first.
    //
    // It once said no card was asked for and left the account out entirely,
    // which was the front page repeating the site's central mistake in the one
    // place a stranger reads before deciding whether to start. Booking needs
    // both an account and a card; the honest thing is that making the account
    // is the same press as booking, which is what this step now describes.
    title: 'Book it in the same press you sign up in',
    body:
      'Take the opening and say what the job is. Making an account is part of '
      + 'that press and not a screen before it: you give an email address, type '
      + 'the six digits we send to it, and add a card on the same screen. No '
      + 'password, and nothing to confirm afterwards. You pay the listed price '
      + 'by card there and then — nothing is added at checkout — and the time '
      + 'is yours from that moment.',
  },
  {
    title: 'They turn up, you approve anything extra',
    body:
      'They arrive in the window you booked. If the job turns out to need a '
      + 'part or more time, the price for it comes to you first, and nothing '
      + 'is added until you say yes.',
  },
];

export function HowItWorks() {
  return (
    <section className="hiw" aria-labelledby="hiw-title">
      <div className="hiw-wrap">
        <h2 className="hiw-title" id="hiw-title">How it works</h2>

        {/* No place is named here. This band said "solo trades in Los
            Angeles" while that was the whole product, and it is now one of
            two; naming the places would mean fetching them, and the note at
            the top of this file is the reason not to. The bands above and
            below this one name them from the data they already hold. */}
        <p className="hiw-lede">
          Round The Way lists the appointments solo trades have not filled yet. You
          book one the way you would book a table.
        </p>

        {/*
          An ordered list, not a row of divs. The steps only make sense in
          sequence, and <ol> is the one way to say so that survives a screen
          reader, a reader-mode view and a stylesheet that failed to load. The
          drawn numbers are decoration on top of that, so they are hidden from
          the accessibility tree rather than read out twice.
        */}
        <ol className="hiw-steps">
          {STEPS.map((step, i) => (
            <li className="hiw-step" key={step.title}>
              <span className="hiw-num" aria-hidden="true">{i + 1}</span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------------------
 * Why book here
 * ----------------------------------------------------------------------- */

/**
 * Three promises, and the test applied to each was the same: could a customer
 * catch us out on it within one booking?
 *
 * That test threw out most of the obvious copy. "Free to use" is not ours to
 * say — the price on the card is what the customer pays, but there is a fee
 * inside it, and a visitor who reads "free" and later reads a fee line has
 * been lied to over something that did not need lying about. "Vetted pros"
 * goes the same way until every operator is checked. What is left is three
 * things the product actually enforces in code: the parts approval, the
 * relayed messages, and reviews that only a completed booking can create.
 * What the site says about the money itself is kept in one place rather than
 * repeated here — see PaymentState.tsx.
 *
 * No prop takes an argument. If one of these ever needs a number in it, the
 * number belongs in a prop rather than in this file.
 */
const REASONS = [
  {
    title: 'You approve anything on top',
    body:
      'The price you agree to is the one you saw when you booked. If anything '
      + 'is needed on top of it, it reaches you as a price with a yes and a no '
      + 'next to it, and declining still leaves you the appointment.',
  },
  {
    title: 'Your number stays private',
    body:
      'Messages and photos go through Round The Way, so you can sort out the '
      + 'details of the job — the gate code, the make of the boiler — without '
      + 'either of you handing over a phone number.',
  },
  {
    title: 'Reviews come from real jobs',
    body:
      'Every review here was written by someone who booked that appointment '
      + 'and had the work done. There is no other way to leave one, which is '
      + 'why the scores are worth reading.',
  },
];

export function WhyBook() {
  return (
    <section className="why-book" aria-labelledby="why-book-title">
      <div className="why-book-wrap">
        <h2 className="why-book-title" id="why-book-title">
          Why book on Round The Way?
        </h2>

        {/*
          Unordered, unlike the steps above: these are three independent
          promises and putting a 1, 2, 3 on them would invite the reader to
          look for a sequence that is not there. Same reason there is no
          button under this strip — the band above already asked for the tap,
          and a second ask twenty pixels later reads as a page that wants
          something rather than one that is explaining itself.
        */}
        <ul className="why-book-grid">
          {REASONS.map((reason) => (
            <li className="why-book-item" key={reason.title}>
              <h3>{reason.title}</h3>
              <p>{reason.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
