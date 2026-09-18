import { Link } from 'react-router-dom';
import Crumbs from '../components/Crumbs';
import PaymentState from '../components/PaymentState';
import PublicPage from '../components/PublicPage';
import { useBookingState } from '../lib/customer';
import { useMetros } from '../lib/metros';
import { useDocumentTitle } from '../lib/title';
import '../styles-info.css';

/**
 * How Round The Way works for a business. Route /pros.
 *
 * This is the page the footer's "How Round The Way works for pros" has been
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
 * THE SHAPE IS THE REFERENCE'S TWO RECRUITMENT PAGES, INVERTED WHERE IT HAS
 * TO BE. Theirs runs: a hero promising to send you customers, three numbered
 * steps ending in "pay to send a quote", a band of numbers (200,000 pros, a
 * billion dollars, tens of thousands of requests a day), a personalised
 * "customers requested pros like you last month" figure, success stories from
 * named tradespeople, the app, a community section, and a sign-up button. The
 * companion page is the same pitch made entirely out of testimonials.
 *
 * The ORDER is right and worth copying, because it answers a self-employed
 * person's questions in the order they have them: what is this, how does it
 * work, what does it cost me, is there any work in it, what do I have to give
 * you, what do I get, and where do I sign. What cannot be copied is that four
 * of those modules are numbers nobody here has measured and one is a wall of
 * quotations from people who do not exist.
 *
 * So each of those slots carries the honest answer to the question the module
 * was built to answer:
 *
 *   their three steps        -> three steps, ending in a booking rather than in
 *                               paying to bid on one, because that genuinely is
 *                               how this works and it is the strongest thing
 *                               this page has to say.
 *   their pricing-by-implication -> "What it costs", stated outright, first
 *                               screen. It is the question every one of these
 *                               pages is really being read for.
 *   their stat band          -> "Where a listing actually shows up": the
 *                               distribution mechanics, which are checkable
 *                               facts about pages that exist, instead of demand
 *                               figures, which are not.
 *   their success stories    -> "Who this is not for". A page with no
 *                               testimonials that admits it has none, and then
 *                               argues against itself, is more use to somebody
 *                               deciding than one that quotes a stranger.
 *   their closing CTA        -> a CTA here too, and one after the steps, which
 *                               is the one structural thing the page was
 *                               missing outright.
 *
 * Every mechanism described below is in the product:
 *   web/src/pages/Join.tsx           the five screens and what each asks for.
 *   web/src/components/OnlineSwitch  the availability switch: three hours,
 *                                    five minutes to answer, never assigned.
 *   src/lib/bypass.ts                listingBlock() — location, vehicle, a bank
 *                                    account to be paid into, unpaid fees — and
 *                                    the cancellation ladder itself. A card is
 *                                    NOT one of the gates on a business.
 *   src/lib/fees.ts                  the 15% platform fee and the $150 a day
 *                                    ceiling, taken out of the business's share.
 *   src/lib/standing.ts              CARD_INVITE_OPERATOR, the suspensions.
 *   src/lib/parts.ts                 quoting a part mid-job.
 *   src/lib/startcode.ts             the code and the van.
 *   src/lib/credentials.ts           what a profile can record, and the fact
 *                                    that nothing here verifies any of it.
 */

/**
 * The objections, as an array.
 *
 * WHAT DECIDED THE LIST. Not what a marketplace wants to explain, but what a
 * self-employed person asks when a stranger offers to send them work: am I
 * signing up to be somebody's employee, can I say no, is the customer mine,
 * are you tracking me, and what happens if this turns out to be nothing.
 * Every answer is a fact from the product or a plain no, and none of them is
 * allowed to end with a reason to sign up — a FAQ that closes each answer
 * with a pitch is an advert with a plus sign next to it.
 */
const QUESTIONS: Array<{ q: string; a: string }> = [
  {
    q: 'Am I working for Round The Way?',
    a: 'No. You are not staff, this is not an agency and nobody here is your '
      + 'employer. The work is yours, the customer relationship is yours, the '
      + 'liability is yours and so is your own insurance, licensing and tax. '
      + 'Round The Way holds no insurance that covers you or your work.',
  },
  {
    q: 'Do I have to take a job that comes in?',
    a: 'Never. Nothing on this site is assigned to anybody. An instant request '
      + 'is an offer with a five-minute countdown on it; ignore it and it goes '
      + 'to somebody else, and nothing is recorded against you for that. What '
      + 'is booked is what you listed as available in the first place.',
  },
  {
    q: 'Can I list on other sites at the same time?',
    a: 'Yes. Nothing in the terms asks for exclusivity and nothing in the '
      + 'product enforces any. What does matter practically is keeping your '
      + 'diary here honest: the jobs already in it are what stop an opening '
      + 'being offered on top of work you have taken elsewhere.',
  },
  {
    q: 'Whose customer is it afterwards?',
    a: 'Yours. Round The Way does not sell, rent or market to your customer '
      + 'list, and there is no path in the product for one business to see '
      + 'another\'s. It is fair to say the same rule cuts against you: neither '
      + 'side gets the other\'s phone number or email address, and contact '
      + 'details typed into the chat are stripped out, so a repeat booking '
      + 'arranged on the site is easy and one arranged around it is not.',
  },
  {
    q: 'Are you tracking my van?',
    a: 'Not all day, and never with your name on it. Location sharing is a '
      + 'switch you own and it is off until you turn it on. While you are free '
      + 'and switched on, a vehicle shows on the map on the front page — no '
      + 'name, no link, no trail, rounded to about 110 metres — because that '
      + 'map is how a customer finds out anybody is working near them. The '
      + 'moment you are booked you come off it, and the customer whose job it '
      + 'is sees you instead, in a window around their appointment. Never '
      + 'both, so nobody can watch you arrive at a door. It is a condition of '
      + 'listing, and the reason is stated rather than buried: with it off '
      + 'there is no way to tell an honest cancellation from a job done off '
      + 'the books.',
  },
  {
    q: 'Do you check my licence, and does that mean my competitors are checked?',
    a: 'No, and no. Nothing here verifies a licence, an insurer or anybody\'s '
      + 'identity, on either side. You can record a licence number, an insurer '
      + 'and a background check on your profile and the page names the board '
      + 'so a customer can look it up themselves. Nobody else on this site has '
      + 'been vetted either, which is worth knowing in both directions.',
  },
  {
    q: 'What happens if nobody books anything?',
    a: 'Nothing, and it costs you nothing. There is no listing charge, no '
      + 'subscription and no per-lead fee, so an opening that expires unbooked '
      + 'leaves you exactly where you started. The 15% is a share of a job that '
      + 'was booked, so an opening nobody takes carries none of it. There is no '
      + 'promise anywhere on this site that any particular opening will be '
      + 'booked.',
  },
  {
    q: 'How do I actually get paid?',
    a: 'The customer pays Round The Way by card at the moment they book, and '
      + 'that payment is held until the job is done. Your share then goes to '
      + 'your own bank account. Round The Way keeps 15% of the job, never more '
      + 'than $150 from one business in one day; it comes out of your share and '
      + 'is never added to what the customer pays. It applies to every booking — '
      + 'there is no free tier, no repeat-customer discount and no exemption. '
      + 'Connect a bank account before you list: without one there is nowhere to '
      + 'send your share, so your openings do not go up.',
  },
];

export default function ForPros() {
  useDocumentTitle('How Round The Way works for pros');
  /**
   * Whether a customer can actually complete a booking on this deployment.
   * Read from the Worker, because it turns on a secret this bundle cannot see
   * — and because a business deciding whether to list is entitled to the real
   * answer rather than one written down months ago.
   */
  const bookingState = useBookingState();
  /**
   * The places this site covers, for the distribution section further down.
   * Read from the Worker for the reason web/src/lib/metros.ts sets out: the
   * one previous version of a sentence naming a city on a static page was
   * wrong within a fortnight and nothing about it looked wrong.
   */
  const metros = useMetros();

  return (
    <PublicPage className="info-page">
      <Crumbs items={[{ label: 'For businesses' }]} />

      <header className="info-head">
        <h1>How Round The Way works for a business</h1>
        <p className="info-lede">
          Round The Way sells the hour a cancellation left empty. You post the time
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
        {/* What the other side of the transaction goes through, said on the
            page where a business decides whether to list. It matters to that
            decision in both directions: a customer confirming an address is
            friction on your listing, and it is also the thing that makes the
            no-show ladder mean anything. */}
        <p>
          Taking one means an account on the customer's side: they give an email
          address and type the six digits sent to it, in the same press that
          books the appointment. There is no sign-up screen standing in front of
          your listing and nobody is asked to make an account to look at it.
          That address is also what a no-show is recorded against, which is what
          makes the ladder further down follow a person rather than a browser.
          You still get a phone number to ring on the day — but nothing on this
          site checks that number, so it is a contact detail rather than the
          account.
        </p>
        {/* And the honest state of it, which a business deciding this week is
            entitled to before they spend an evening on the five screens. The
            sentence is the Worker's own rather than written here: whether a
            sign-in code can be sent depends on a Worker secret, and a page
            carrying its own answer to that would be guessing about whether
            anybody can book what it is inviting somebody to list. */}
        {bookingState && !bookingState.sms_ready && bookingState.sms_note && (
          <p className="note">
            <strong>And none of it can happen yet.</strong>{' '}
            {bookingState.sms_note} Your listings, your prices and your diary
            all work; the last step, somebody taking one, does not.
          </p>
        )}
      </section>

      {/* --- the three steps -----------------------------------------------
          THE MODULE THE REFERENCE LEADS WITH, and the one place where copying
          its shape makes this product look better rather than worse. Their
          middle step is "pay to send a quote", and the step after it says a
          customer collects quotes from up to five businesses — so what they
          are selling, stated plainly in their own numbered list, is a lottery
          ticket you buy per entry. Ours is three steps that end in a booking,
          because there is nothing to bid for and nothing to buy. That contrast
          is the whole commercial argument of this page and it needs no figure
          attached to it. */}
      <section className="info-sec" aria-labelledby="p-steps">
        <h2 id="p-steps">How it works, in three steps</h2>
        <ol className="info-steps">
          <li>
            <h3>You list what you do, where, when and for how much</h3>
            <p>
              Your services with your own prices and durations, the areas you
              cover, the hours you work and the jobs already in your diary.
              That is the whole of the set-up, and none of it is decided here.
            </p>
          </li>
          <li>
            <h3>A gap in your day becomes a public opening</h3>
            <p>
              A cancellation, or a day that never filled. The app works out
              what fits the hole and who is near enough to take it, and the
              opening goes up on the pages for that trade and that
              neighbourhood at the price you set.
            </p>
          </li>
          <li>
            <h3>Somebody books it, and it is booked</h3>
            <p>
              No quote to send, no bid to win, no five businesses racing for
              the same job. The customer takes the time and it lands in your
              diary with the address, the job and the start code on it.
            </p>
          </li>
        </ol>
        <div className="info-do">
          <Link className="btn" to="/join">List your business</Link>
          <Link className="btn quiet" to="/">See what is open now</Link>
        </div>
      </section>

      {/* --- what it costs ---------------------------------------------------
          THE QUESTION THE PAGE IS ACTUALLY BEING READ FOR, and the one a
          business who has been charged for leads elsewhere reads the whole
          page looking for. It is answered here, in full, before anything
          further down can look like the catch they were waiting for.

          THIS SECTION ONCE SAID THERE WAS NO COMMISSION AND THAT NO RATE
          EXISTED. There is one, it is 15%, it is in src/lib/fees.ts and it is
          deducted at settlement. Saying otherwise on the page a business reads
          before signing up is a false inducement into a commercial
          relationship, and it is the reason the rate now leads the section
          rather than sitting under it. The rule for anyone editing this: the
          number comes first, in the first sentence, before anything that
          sounds like a benefit. */}
      <section className="info-sec" aria-labelledby="p-cost">
        <h2 id="p-cost">What it costs</h2>
        <p>
          Round The Way keeps 15% of the job, and never more than $150 from one
          business in one day. It comes out of your share and is never added to
          what the customer pays, so the price you list is the price they see.
          It applies to every booking: there is no free tier, no
          repeat-customer discount and no exemption.
        </p>
        <p>
          Nothing else. There is no sign-up fee, no subscription, no charge for
          a listing, no charge for being shown to anybody and no per-lead
          charge — there are no leads here to be charged for. An opening nobody
          books costs you nothing at all.
        </p>
        <p>
          The other figure that exists is the fee for cancelling a job late,
          and it is described in full further down. It is the same amount a
          customer forfeits for cancelling at the same moment.
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

      {/* --- distribution ----------------------------------------------------
          THE SLOT THE REFERENCE FILLS WITH ITS STAT BAND — 200,000 pros, tens
          of thousands of requests a day, a personalised "customers requested
          pros like you last month" figure — and the honest version of that
          module is not a smaller number, it is a different KIND of statement.

          Every figure in their band is demand, and demand is the one thing
          this business genuinely cannot speak to: nobody has measured it,
          there is nothing to measure yet, and any number printed here would be
          read as a forecast by somebody deciding how to spend their week.
          What CAN be stated is supply-side and checkable in thirty seconds by
          the person reading it — these pages exist, a listing appears on them,
          and here is what happens when nobody is looking. A tradesperson
          deciding whether to bother is better served by "here is exactly where
          it goes" than by an average they cannot verify.

          The metros are read from the Worker rather than named here, for the
          reason web/src/lib/metros.ts gives: this page would otherwise be one
          more file to remember on the day a third place opens. */}
      <section className="info-sec" aria-labelledby="p-where">
        <h2 id="p-where">Where a listing actually shows up</h2>
        <p>
          An opening you post is not sitting in a database waiting for somebody
          to search for it. It appears, at the price you set, on:
        </p>
        <ul className="info-list">
          <li>
            the page for your trade, and the page for your trade in that
            neighbourhood — which is the shape of what people actually type
            into a search engine;
          </li>
          <li>
            the neighbourhood's own page, the map, the site search and the
            cost guide for that work;
          </li>
          <li>
            the front page, when it is one of the openings genuinely free right
            now.
          </li>
        </ul>
        <p>
          Those pages are rendered by the server as plain HTML with no
          JavaScript, which is what lets a search engine read the time and the
          price without running anything. And somebody who is not looking today
          can leave a standing alert for their own postcode and the work they
          want; when an opening lands in range, they are pushed or emailed
          about it.
        </p>
        {metros.length > 0 && (
          <p>
            All of it inside the places this site covers:{' '}
            {metros.map((m, i) => (
              <span key={m.slug}>
                {i > 0 ? (i === metros.length - 1 ? ' and ' : ', ') : ''}
                <a href={m.path}>{m.name}</a>
              </span>
            ))}
            . Your own service areas decide which part of that you appear in;
            an opening is never shown to somebody your areas cannot reach.
          </p>
        )}

        <p className="note">
          <strong>What is not on this page, and will not be:</strong> how many
          customers are looking, how many businesses are here, how many
          bookings have been made, or how many of either to expect. Nobody has
          measured any of it, and a figure printed here would be a forecast
          wearing the clothes of a fact. The trade and neighbourhood pages count what is genuinely open
          at the moment you load them and say plainly when the answer is
          nothing — which is the only counting anywhere on this site.
        </p>
      </section>

      {/* --- getting paid --------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="p-paid">
        <h2 id="p-paid">Getting paid</h2>
        <PaymentState audience="pro" />
        <p>
          No cash at the door, no invoice to send and nobody to remind — a
          customer who has already paid in full is a customer who turns up.
          Round The Way holds the money until the job is done, keeps 15% of the
          job out of your share, never more than $150 from one business in one
          day, and sends the rest to your own bank account.
        </p>
        <p>
          Connect that bank account before you list. The payment provider takes
          those details directly and Round The Way never sees them. Without one
          there is nowhere to send your share, so your openings do not go up.
        </p>
        <p>
          A part you could not price in advance is quoted in the booking's own
          messages and nothing is fitted until the customer approves it there.
          It is the conversation that otherwise happens in cash on a driveway,
          and this is where it happens instead.
        </p>
      </section>

      {/* --- what is asked of you -------------------------------------------- */}
      <section className="info-sec" aria-labelledby="p-asked">
        <h2 id="p-asked">What is asked of you</h2>
        <p>
          Three things before your openings go up, each for a reason a customer
          would recognise. The fourth is encouraged rather than required, and
          the last one happens at the door.
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
            <strong>A bank account to be paid into.</strong> Your share of a
            job goes to it after the work is done, so without one there is
            nowhere to send your money and your openings do not go up. The
            payment provider takes those details directly; Round The Way never
            sees them.
          </li>
          <li>
            <strong>A card, if you want to add one.</strong> It is not
            required, and no opening is held back for the want of it. Nothing is
            charged to it for using the site. It is encouraged for one thing:
            cancelling a job late.
          </li>
          <li>
            <strong>The start code, at the door.</strong> The customer reads
            four digits off their phone and you type them in to start the job.
            It is also your record that you were there.
          </li>
        </ul>

        <h3>Cancelling late costs you, on the same ladder it costs them</h3>
        <p>
          More than 48 hours out costs nothing. Inside 48 hours it is a quarter
          of the job, inside 12 hours three quarters, and the whole job once you
          have said you arrived — with a floor of $15 and never more than the
          job itself. Those are the same amounts a customer forfeits when they
          are the one cancelling, which is the point: whatever it would cost
          them, it costs you.
        </p>
        <p>
          An unpaid fee stops new openings going up until it is settled — and it
          never touches work already in the diary. Those customers still get
          their appointment.
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
              so is the liability. Round The Way has no insurance that covers you or
              your work.
            </li>
          </ul>
        </div>
      </section>

      {/* --- who it is not for -------------------------------------------------
          THE SLOT THE REFERENCE FILLS WITH SUCCESS STORIES. Its companion page
          is nothing but those: four tradespeople, photographed, each with a
          sentence about how the platform changed their business. There are
          none of those here and there is no honest way to manufacture one, so
          the module is inverted into the thing a testimonial is pretending to
          be — help deciding whether this suits you.

          It argues against itself on purpose. A marketplace that signs up
          businesses this is wrong for gets a listing that never fills,
          a person who feels misled, and the one review of the platform that
          actually travels: word of mouth in a trade where everybody knows
          everybody. Talking those people out of it now is cheaper. */}
      <section className="info-sec" aria-labelledby="p-notfor">
        <h2 id="p-notfor">Who this is not for</h2>
        <p>
          There are no testimonials on this page. In place of the ones that
          would normally sit here, the honest version: the four kinds of
          business this is a poor fit for.
        </p>
        <ul className="info-list">
          <li>
            <strong>Anyone who needs work this month.</strong> Nobody here can
            tell you how many customers there will be, because nobody has
            measured it. If your diary needs filling now, fill it somewhere
            that already has customers — listing here costs nothing until a job
            is booked and done.
          </li>
          <li>
            <strong>Anyone whose jobs cannot be priced in advance.</strong> The
            whole model is a fixed price on a fixed length of time, listed
            before anybody talks to you. Work that genuinely needs a survey
            first fits badly, and the parts mechanism only covers the part —
            not an hour that turned into four.
          </li>
          <li>
            <strong>Anyone with a shopfront or a fixed premises.</strong> Every
            page here is written for a business that drives to the customer.
            Nothing on this site handles somebody coming to you.
          </li>
          <li>
            <strong>Anyone who does not want their availability public.</strong>{' '}
            An opening is a public page with your business name, your price and
            a neighbourhood on it. That is the product working as intended, and
            for some rounds it is not what you want visible.
          </li>
        </ul>
      </section>

      {/* --- questions -----------------------------------------------------
          The objections a self-employed person actually has, in the order they
          usually arrive, answered without a sales sentence anywhere in them.
          <details> for the reasons Help.tsx gives: it opens with JavaScript
          off and find-in-page reaches inside it. */}
      <section className="info-sec" aria-labelledby="p-qs">
        <h2 id="p-qs">Questions</h2>
        <div className="info-qs">
          {QUESTIONS.map((item) => (
            <details className="info-q" key={item.q}>
              <summary>{item.q}</summary>
              <p className="info-a">{item.a}</p>
            </details>
          ))}
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
