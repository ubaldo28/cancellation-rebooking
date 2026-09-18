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
 *
 * WHERE THIS PAGE DIFFERS IN SHAPE FROM THE REFERENCE'S, AND WHY. Theirs runs:
 * a safety promise, two guarantees, then a three-card module headed
 * "continuous background checks" — we check every account, we uphold our
 * terms, we always follow up — then verified reviews, then badges for licensed
 * and top-rated businesses, then a line advising you to verify licences
 * yourself, then technology-and-humans, then support.
 *
 * Six of those eight are claims this business cannot make. A background check
 * has never been run here. No review exists to verify. There is no badge that
 * means anybody looked. So the modules are kept in their positions and
 * inverted, because the position is the honest part: what a reader wants at the
 * top of a safety page is the answer to "has anyone checked this person", and
 * that answer belongs at the top whether it is yes or no. Ours is no, so it is
 * the first thing under the heading rather than the last thing above the
 * footer, where it used to be.
 *
 * Their one genuinely un-invertable module is the small print under the
 * badges: verify licences and insurance yourself. That is the only advice on
 * their page that survives having nothing to sell, and here it is not a
 * footnote but the largest section — with the boards named and the registers
 * pointed at, because "check it yourself" without an address is a way of
 * sounding careful rather than being useful.
 *
 * THE LICENCE TABLE MIRRORS src/lib/credentials.ts AND MUST BE KEPT IN STEP
 * WITH IT. That module is the one place the app decides what California asks
 * of a trade — TRADE_RULES, its authorities and the $1,000 contractor
 * threshold — and the Worker's own licenceNote() in src/lib/seo.ts already
 * renders those rules onto every server-rendered trade page. This bundle
 * cannot import from the Worker (web/tsconfig.json compiles web/src alone), so
 * the table below is a hand copy, restricted to the trades this site actually
 * lists, and every row of it is that file's rule in that file's words. It is
 * the same arrangement, and the same hazard, as the two footers that
 * test/two-trees.test.ts exists to pin together.
 */

/**
 * Trade, who licenses it in California, and what to ask a business for.
 *
 * NOTHING IN THIS TABLE IS A STATEMENT ABOUT A PARTICULAR BUSINESS. It is the
 * requirement, which is the same for everybody in that trade and is set by the
 * state rather than by us — which is exactly why it is safe to publish and
 * useful to read: a customer who knows a locksmith needs a BSIS licence can
 * find out in a minute whether the one on their driveway holds one, and that
 * is a stronger check than any badge this site could print.
 *
 * The wording of the last column is deliberately "ask for" rather than
 * "verify that they have". A customer standing at their own front door is not
 * running a compliance audit; they are asking one question and listening to
 * the answer.
 */
const LICENCES: Array<{ work: string; who: string; ask: string }> = [
  {
    work: 'Locksmiths',
    who: 'Bureau of Security and Investigative Services (BSIS)',
    ask: 'A licence number. It is required to do the work at all, whatever the '
      + 'job is worth.',
  },
  {
    work: 'Mobile mechanics and oil changes',
    who: 'Bureau of Automotive Repair (BAR)',
    ask: 'Their Automotive Repair Dealer registration number. Anyone repairing '
      + 'vehicles for money in California must hold one.',
  },
  {
    work: 'Phone, tablet and appliance repair',
    who: 'Bureau of Household Goods and Services (BHGS)',
    ask: 'Their service dealer registration. It is a registration rather than a '
      + 'trade licence — a form and a fee, no exam — but it is required before '
      + 'anybody takes money for the work.',
  },
  {
    work: 'Pest control',
    who: 'Structural Pest Control Board',
    ask: 'A licence number. Required for the work itself.',
  },
  {
    work: 'Hair and barbering',
    who: 'Board of Barbering and Cosmetology',
    ask: 'Their own licence number, and — if they work out of a vehicle — the '
      + 'separate licence the Board issues to a mobile unit.',
  },
  {
    work: 'Veterinary work',
    who: 'Veterinary Medical Board',
    ask: 'A licence, and premises registration for the mobile clinic. Grooming '
      + 'and exercise are not veterinary medicine; diagnosis, treatment, '
      + 'vaccination and prescribing are.',
  },
  {
    work: 'Pressure washing, handyman work, gutters, tree work, landscaping, '
      + 'pool repair',
    who: 'Contractors State License Board (CSLB), above $1,000 a job',
    ask: 'A contractor\'s licence number for any single job worth more than '
      + '$1,000 in labour and materials together. Below that a business may '
      + 'work unlicensed, but it has to say so in its advertising.',
  },
  {
    work: 'Detailing, junk removal, window and carpet cleaning, bin cleaning, '
      + 'pet grooming, house cleaning',
    who: 'No state licence is generally required',
    ask: 'Nothing from a board, because there is no board. Insurance and a '
      + 'straight answer about what the price covers are the questions worth '
      + 'asking instead.',
  },
];

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

      {/* --- the answer to the question people came with -------------------
          THE POSITION IS THE REFERENCE'S AND THE ANSWER IS THE OPPOSITE OF
          THEIRS. Their safety page carries a module headed "continuous
          background checks" high up, because that is the question somebody
          opening a safety page has: has anybody checked this person. Here the
          answer is no, and no belongs in the same place yes would have gone.
          It was previously five sections down, under a heading about what we
          do not check, which is where a reader gets to it after forming a view
          from four sections of mechanism — and the mechanisms are real, which
          is precisely what makes them misleading in that order. */}
      <section className="info-sec first" aria-labelledby="s-none">
        <h2 id="s-none">Nobody here has been vetted</h2>
        <p>
          This is the first thing on the page rather than the last, because it
          is the thing most likely to change what you do. Everything further
          down is real and none of it is a substitute for this.
        </p>

        <div className="info-not">
          <h3>Not done, by anybody, ever</h3>
          <ul className="info-list">
            <li>
              <strong>No criminal background checks.</strong> Not at sign-up,
              not annually, not continuously, not through a third party. None
              have ever been run by Round The Way on anybody, on either side of a
              booking.
            </li>
            <li>
              <strong>No identity checks.</strong> Nobody's photo ID is seen or
              matched. A business account is an email address that receives a
              sign-in link; a customer account is an email address that receives
              a six-digit code. Both prove somebody could read mail at that
              address, and neither proves who they are.
            </li>
            <li>
              <strong>No licence is verified.</strong> Nothing on this site
              checks a licence number against the board that issued it. The
              next section is how to check one yourself, which takes about a
              minute and is a real check rather than a badge.
            </li>
            <li>
              <strong>No insurance is confirmed.</strong> Nobody rings an
              insurer. A policy number on a profile is a business telling you
              about itself.
            </li>
            <li>
              <strong>No interviews, no references, no approved list and no
              badge that means we looked.</strong> There is no "top" or
              "verified" marking on this site, because there is no process
              behind one.
            </li>
          </ul>
        </div>

        <p className="note">
          Where a profile shows a background check, that is the business saying
          it had one done, with the provider it names, and it has not been seen
          by us. The same is true of every credential on every profile page.
        </p>
      </section>

      {/* --- how to check it yourself --------------------------------------
          THE SECTION THE REFERENCE HAS AS A SENTENCE. On their page "you
          should independently verify licences and insurance" sits under the
          badges as a disclaimer, in the tone of something a lawyer asked for.
          It is also the only advice on that page that survives having no
          vetting to sell, so here it is the largest section and it is written
          to be acted on: the boards by name, what to ask for, and where the
          registers are.

          Every requirement below is the state's, not ours, and is a copy of
          src/lib/credentials.ts — see the note at the top of this file. */}
      <section className="info-sec" aria-labelledby="s-check">
        <h2 id="s-check">What to ask for, and how to check it yourself</h2>
        <p>
          California licenses some of this work and not other parts of it, and
          the difference is worth knowing before somebody is standing in your
          driveway. All of these registers are public and free, and looking a
          number up takes about a minute.
        </p>

        {/* Scrolls inside its own box at 375px rather than making the page
            scroll sideways, exactly as the cancellation ladder on /covered
            does; tabIndex is what lets a keyboard reach a scrolling region and
            the role and label make it a real one to a screen reader. */}
        <div className="info-scroll" tabIndex={0} role="region"
          aria-label="What California licenses, by trade">
          <table className="info-table">
            <caption>
              The requirement is the state's and is the same for every business
              in that trade. Nothing in this table says anything about any
              particular business, and nothing on this site has checked one.
            </caption>
            <thead>
              <tr>
                <th scope="col">The work</th>
                <th scope="col">Who licenses it in California</th>
                <th scope="col">What to ask for</th>
              </tr>
            </thead>
            <tbody>
              {LICENCES.map((row) => (
                <tr key={row.work}>
                  <th scope="row">{row.work}</th>
                  <td>{row.who}</td>
                  <td>{row.ask}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3>Where the registers are</h3>
        <p>
          Most of these boards sit under the California Department of Consumer
          Affairs, and its licence search at <b>search.dca.ca.gov</b> covers
          them; each board also publishes its own lookup on its own site. Two
          are worth naming separately because they are the ones people ask
          about most: the Contractors State License Board has its own "check a
          licence" search at <b>cslb.ca.gov</b>, and the Bureau of Automotive
          Repair lists registered repair dealers at <b>bar.ca.gov</b>. These
          are addresses rather than links because we would rather you type a
          state address yourself than trust a link on the site you are checking
          up on.
        </p>
        <p className="note">
          If a number does not come back, or comes back in a different name,
          that is worth an answer before anybody starts work — a licence held
          by a different business is a common and entirely innocent thing, and
          it is also what it looks like when a number has been borrowed.
        </p>

        <h3>Insurance</h3>
        <p>
          Ask for a certificate of insurance, issued by the insurer rather than
          typed by the business, and look at two things: the expiry date, and
          whether the work you are booking is the work it covers. Cover lapses
          on its own with nobody doing anything, so a policy that was real last
          year can be worth nothing today. Round The Way does not hold, check,
          renew or stand behind anybody's policy.
        </p>

        <h3>The questions worth asking before they start</h3>
        <ul className="info-list">
          <li>
            <strong>What is the price if it turns out to be worse than it
            looks?</strong> On this site the answer has a mechanism: a part
            that could not be priced in advance is quoted in your messages and
            nothing is fitted until you tap approve. Ask anyway, so you hear
            the answer in their own words.
          </li>
          <li>
            <strong>Who is actually coming?</strong> These are solo businesses
            — one person, one van. If somebody else is turning up, that is
            worth knowing before they do.
          </li>
          <li>
            <strong>Are you licensed for this, and can I have the number?</strong>{' '}
            A business doing licensed work knows its number and will say it.
          </li>
          <li>
            <strong>What happens if something breaks?</strong> A straight
            answer naming an insurer is a different thing from "don't worry
            about it".
          </li>
        </ul>
      </section>

      {/* --- reviews -------------------------------------------------------
          THE REFERENCE'S "VERIFIED REVIEWS" MODULE. Theirs shows a badge that
          means the reviewer hired through the platform, next to a wall of
          reviews. We have the first half — the rule is enforced by a unique
          index on the booking rather than by care — and none of the second,
          because no real booking has completed yet.

          Saying that plainly is the entire module. A marketplace pre-launch
          has exactly two options for this slot: explain the rules and admit
          the count is zero, or put something there. Fabricated or incentivised
          reviews are an FTC matter as well as the fastest way to make every
          other sentence on this site worthless, and the whole product is
          built the other way round — src/lib/reviews.ts refuses to fill an
          empty trade strip with a placeholder for the same reason. */}
      <section className="info-sec" aria-labelledby="s-reviews">
        <h2 id="s-reviews">Reviews, and why there are none yet</h2>
        <p>
          No booking has completed on Round The Way yet, so there is not one real
          review on the site. That is what a marketplace looks like before it
          starts, and it is worth more to you than the alternative: a page of
          five-star reviews on a site where nobody has been anywhere.
        </p>
        <p>
          The sample businesses that exist to show how the pages look carry
          sample reviews. Every one of them is labelled "sample review" where
          it appears, on a page labelled as a sample business, and none of them
          is submitted to a search engine as real.
        </p>

        <h3>How a review gets here when there are some</h3>
        <ul className="info-list">
          <li>
            <strong>Only from a booking that completed on this site</strong>,
            one review per booking, enforced by the database rather than by
            anybody remembering. A cancelled booking cannot be reviewed at all,
            and neither can a job that has not finished yet.
          </li>
          <li>
            <strong>Written by the person who booked it</strong>, shown as a
            first name and a last initial, with any phone number, email address
            or payment handle stripped out of the published words — a review
            sits on a public page for anybody to read, and people sign them out
            of habit.
          </li>
          <li>
            <strong>The business can reply once and cannot edit the reply.</strong>{' '}
            The first answer is the honest one, and a reply that can be
            rewritten later is a reply nobody can trust.
          </li>
          <li>
            <strong>A business cannot take one down.</strong> There is no path
            in this product for the business a review is about to edit, hide or
            delete it; replying is the whole of what it can do. The database
            can mark a review hidden and the public pages honour that, but
            nothing in the product writes it — there is no button, on either
            side. If that ever changes, this sentence changes with it.
          </li>
          <li>
            <strong>Photographs are released one at a time by the customer.</strong>{' '}
            A business has every reason to publish pictures of its best work
            and no way of knowing whether you mind your hallway being on the
            internet, so the only route from a job photograph to a public page
            runs through the person whose house it is.
          </li>
        </ul>
        <p className="note">
          There is no badge on this site for a highly rated business, a busy
          one or a long-standing one. Every one of those would be a claim about
          quality made by somebody who has not checked, and the score and the
          words are the whole of what we have to show you.
        </p>
      </section>

      {/* --- knowing who is at the door ---------------------------------- */}
      <section className="info-sec" aria-labelledby="s-door">
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
            <strong>Nobody ever gets a live map of a NAMED person.</strong>
            {' '}The map on the front page shows vehicles that are out and free
            — no business name on them, no link, no trail, and a position
            rounded to about 110 metres. That is how you find out somebody is
            working near you. The moment a business is booked it comes off that
            map entirely, so nothing on this site can be watched arriving at
            anybody's door. Once you have booked, you see roughly where your
            own van is in a window around your appointment, and only if that
            business has location sharing switched on.
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
            <strong>There is no password to steal on either side.</strong> A
            business signs in with a link emailed to the address on the
            account. A customer signs in with a six-digit code emailed to
            theirs: it lasts ten minutes, works once, and dies after five wrong
            guesses — and asking for a new one kills the one before it, so there
            is never more than one live code for an address.
          </li>
          <li>
            <strong>A customer's account is that address and nothing
            else.</strong>{' '}
            It is also what a suspension is recorded against, which is why
            closing an account does not clear one: signing up again with the
            same address lands back on the same standing. The phone number on a
            booking is a contact detail — nothing sends a code to it and nothing
            is unlocked by it.
          </li>
        </ul>
      </section>

      {/* --- how far the rest of it goes ------------------------------------
          THE SECOND HALF OF THE SECTION THAT USED TO BE HERE. Licences,
          insurance, identity and background moved to the top of the page,
          where the reader meets them before the mechanisms rather than after
          — see the note on that section. What is left is the set of limits
          that only make sense once somebody has read the mechanisms they
          qualify, which is why these stayed at the bottom: each one is the
          honest edge of something described above. */}
      <section className="info-sec" aria-labelledby="s-not">
        <h2 id="s-not">How far the rest of it goes</h2>
        <p>
          The top of this page says what is never checked. This is the section
          about the things that are real: what each of them does not reach.
        </p>

        <div className="info-not">
          <h3>The edges of it</h3>
          <ul className="info-list">
            <li>
              <strong>The quality of anybody's work.</strong> No inspections, no
              approved list, no badge that means we looked. The ratings and
              reviews on a profile come from completed bookings on this site,
              one per booking, and that is the only quality signal here.
            </li>
            <li>
              <strong>Whether a customer is who they say they are.</strong> A
              customer's account is an email address proved by a code sent to
              it, so what is established is that somebody could read mail there
              — not who they are. A fresh mailbox is a clean record, and a
              mailbox costs nothing to open. That is a real limitation and it is
              worth knowing rather than glossing over: what the standing ladder
              deters is casual, not determined. The phone number on a booking
              establishes even less, because nothing checks it at all.
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
          started costs less than the alternative.
        </p>
      </section>

      {/* --- reaching somebody ---------------------------------------------
          THE REFERENCE CLOSES ON "DEDICATED SUPPORT": a phone number, a text
          line, two languages and opening hours. Ours closes on the same slot
          and says what is actually behind it, because a safety page that ends
          by implying somebody is standing by is the single most dangerous
          sentence either version of this page could carry — it is read by
          people deciding whether they can rely on us in the moment something
          goes wrong, and the answer is that they cannot.

          The 911 line was the last sentence of the section above, where it
          read as a sign-off. It is the operative sentence of this one. */}
      <section className="info-sec" aria-labelledby="s-reach">
        <h2 id="s-reach">If you need to reach somebody</h2>
        <p>
          <strong>In an emergency, call 911.</strong> Round The Way is one person
          and a website. There is no support line here, no out-of-hours desk
          and nothing that reaches anybody faster than the emergency services
          do — not for a person at your door, not for a person at an address
          you have driven to.
        </p>
        <p>
          For anything that is not an emergency: the booking's own conversation
          is the fastest way to reach the other side, and{' '}
          <Link to="/help">Help</Link> is where the rest goes. Nothing on this
          site promises a reply within any particular time, and where the
          product does have a clock in it — five minutes to accept an instant
          request, three days for a parts quote — that clock is stated where it
          applies.
        </p>
        <p className="note">
          If somebody on this site frightened you, tell us anyway, even though
          we are slow. A report from a person is the only way an account here
          ever gets looked at — nothing sweeps for bad behaviour on its own —
          and a customer's standing is recorded against their email address, so
          closing the account and signing up again with it lands on the same
          rung.
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
