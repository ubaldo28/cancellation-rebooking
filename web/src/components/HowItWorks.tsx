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
 * Slotfill sells a specific hour of a specific person's real calendar, paid for
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
      + 'open this week. Every time on Slotfill is a real gap in someone\'s '
      + 'day at a price they have already set.',
  },
  {
    // Paying here is the design and is not built — see PaymentState.tsx — and
    // this step is the front page's own description of what the Book button
    // does, so it is the step that would have been caught out first.
    title: 'Book it in one step',
    body:
      'Take the slot and say what the job is. The time is yours from that '
      + 'moment — there is nothing to confirm and nobody to chase. Nothing is '
      + 'paid on the site yet, so no card is asked for and you settle the '
      + 'listed price with the business directly.',
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

        <p className="hiw-lede">
          Slotfill lists the appointments solo trades in Los Angeles have not
          filled yet. You book one the way you would book a table.
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
 * Those three survive the test because none of them depends on money having
 * moved, which nothing on this site does yet — see PaymentState.tsx.
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
      'Messages and photos go through Slotfill, so you can sort out the '
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
          Why book on Slotfill?
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
