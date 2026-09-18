import { Link } from 'react-router-dom';
import Crumbs from '../components/Crumbs';
import PublicPage from '../components/PublicPage';
import { useDocumentTitle } from '../lib/title';
import '../styles-info.css';

/**
 * Privacy. Route /privacy.
 *
 * Written from src/lib/retention.ts, migration 0032 and the routes in
 * src/index.ts rather than from a template, which is why the retention table
 * below has odd-looking numbers in it: 30, 180, 7, 90, 365, 730. Those are the
 * constants in RETENTION, and a page that rounded them to "as long as
 * necessary" would be describing a different product.
 *
 * WHAT THIS PAGE IS ALLOWED TO CLAIM:
 *   Collected      the columns in migrations 0001, 0016, 0017, 0026 and 0032.
 *   Kept           RETENTION in src/lib/retention.ts, one row per sweep.
 *   Deleted        eraseCustomerByToken and closeOperatorAccount in the same
 *                  file, reachable at DELETE /api/public/threads/:token/data
 *                  and POST /api/account/close.
 *   Never held     card details — see src/lib/payments.ts, where a value that
 *                  looks like a PAN is refused at ingress, at every database
 *                  write and at egress.
 *   Seen by        the two people on a booking; an admin reviewing a dispute,
 *                  whose every read is recorded in admin_actions with a
 *                  peppered hash rather than a second copy of the data.
 *
 * The third-party list is read off src/lib/headers.ts (the content-security
 * policy names every origin the site is allowed to talk to) and web/index.html
 * rather than from memory, because a privacy page that omits a recipient is
 * wrong in the one direction that matters. Stripe is on that list now and is
 * named: src/lib/checkout.ts and src/lib/stripe.ts send it a customer's email
 * address, name, amount and order id, and store a Stripe customer id and a
 * payment-method reference against the account.
 *
 * THE CSP IS NOT THE WHOLE LIST, and reading only it is how the geocoder came
 * to be missing for so long. A content-security policy governs what the
 * BROWSER may fetch; it says nothing about what the Worker fetches on the
 * server. src/lib/geo.ts puts the street line and the postcode of every US
 * booking into a query string to geocoding.geo.census.gov, and no header in
 * this repository would ever have mentioned it. Section 5 names it. When
 * anything else in src/ grows a fetch() to an outside host, it belongs there
 * too.
 *
 * CalOPPA (Cal. Bus. & Prof. Code § 22575) applies to any commercial site
 * collecting personal information from Californians, with no size threshold,
 * and asks for four things this page had to be told to say: how a material
 * change is notified (b)(4), how the site responds to a Do Not Track signal
 * (b)(5), whether third parties may collect information across other sites
 * (b)(6), and the categories of third party information is shared with
 * (b)(1). Sections 5 and 9 carry them.
 *
 * THE LAST PLACEHOLDER IS GONE, AND IT WAS NOT FILLED IN. This page used to
 * carry [REGISTERED ADDRESS] in a dashed box under a section 10 headed "What
 * this document is missing", with the paragraph in the header above it
 * counting the same gap a second time. The owner's answer was that there is no
 * registered address to print: Round The Way is one person trading under that
 * name, a sole proprietor, working from a home. Keeping the box would have
 * gone on telling every reader that something was owed to them and withheld,
 * when what is true is both simpler and better for them — the business
 * responsible is named, the mailbox reaches the person who runs it, and a
 * postal address for formal legal notice is sent to anybody who asks.
 *
 * So section 10 became what a privacy page actually needs in that position:
 * who is responsible for this data and how to reach them. It also says plainly
 * why no postal line is printed, which on this page of all pages is the only
 * consistent answer — a page that has a customer's street address deleted 90
 * days after the job cannot publish somebody's home address in its own
 * footer. Terms section 12 is the fuller version of the same clause, and it is
 * also where Terms now says why it names no governing law and no court. That
 * used to be a section 13 naming a state, and this docblock used to send the
 * reader to it; both are gone, and nothing on this page ever depended on one.
 *
 * DO NOT ADD THE ADDRESS HERE if it ever arrives in a ticket: not in this
 * file, not in the head, not in structured data.
 */

const LAST_UPDATED = '12 September 2026';

/** RETENTION in src/lib/retention.ts, one row per sweep. */
const KEPT: Array<{ what: string; how_long: string; then: string }> = [
  {
    what: 'A conversation that never became a booking',
    how_long: '30 days after the last message',
    then: 'Deleted, with every message in it',
  },
  {
    what: 'A conversation attached to a finished job',
    how_long: '180 days after the job',
    then: 'Deleted, with every message in it',
  },
  {
    what: 'Photographs of a job — the before, during and after pictures on the '
      + 'booking, and any photograph sent in the conversation about it',
    how_long: '21 days after the job',
    then: 'Deleted from storage and from the database — except one you '
      + 'published on your own review, which stays',
  },
  {
    what: 'Those same photographs, when somebody has raised a claim about that '
      + 'booking — a report that one of you did not turn up, or a payment '
      + 'frozen while we ask whether the work happened',
    how_long: '30 days after the claim is settled, and never before it is',
    then: 'Deleted the same way',
  },
  // THIS ROW HAS NO NUMBER OF ITS OWN EITHER, for the same reason the doorstep
  // code further down does not. A photograph sent in a conversation that never
  // became a booking has no job to measure against, so it rides on the
  // conversation's own window rather than on a second constant nobody would be
  // able to keep in step with it. Printing a number here would be a copy of
  // the first row in this table that could quietly come apart from it.
  {
    what: 'A photograph you sent in a conversation that never became a booking',
    how_long: 'It goes with the conversation it was part of, on the same clock '
      + 'as the first row in this table',
    then: 'Deleted from storage and from the database',
  },
  {
    what: 'The street address and map position of a finished job — on the '
      + 'booking, the receipt, the business’s customer record, and the '
      + 'openings either side of it, which carry a copy for working out '
      + 'driving time',
    how_long: '90 days after the job',
    then: 'Removed everywhere; the postcode is kept',
  },
  {
    what: 'What you asked for in your own words when you asked for a quote',
    how_long: '180 days, or sooner if the conversation goes first',
    then: 'Deleted',
  },
  {
    what: 'An instant request nobody accepted',
    how_long: '7 days',
    then: 'Deleted',
  },
  {
    what: 'What you wrote if you told us the van that turned up was not the '
      + 'one on the app',
    how_long: '180 days after the job',
    then: 'Deleted from the booking, along with the fact that you reported it',
  },
  {
    what: 'An instant request that became a booking',
    how_long: '30 days',
    then: 'Deleted; the booking holds it now',
  },
  {
    what: 'An opening alert you switched off',
    how_long: '90 days',
    then: 'Deleted, with its postcode and push subscription',
  },
  {
    what: 'An opening alert that never matched anything',
    how_long: '365 days',
    then: 'Deleted',
  },
  // THIS ROW HAS NO NUMBER OF ITS OWN, AND IT USED TO CARRY ONE.
  //
  // sweepStartCodes in src/lib/retention.ts is a real sweep and this is a real
  // promise — the code is cleared off the booking — but it runs on
  // JOB_LOCATION_DAYS rather than on a constant of its own, deliberately: that
  // file says the code and the address are one fact about one doorstep, and a
  // code outliving the address it opens would be the odd thing to keep. So
  // writing "90 days" here was a second copy of another row's number. It read
  // as a window this row could be held to by itself, and the day the address
  // window moved it would have gone on saying 90 while the sweep it actually
  // rides on said something else. Pointing at the row above is the only version
  // of this that cannot come apart.
  {
    what: 'The four-digit code you read out on the doorstep',
    how_long: 'It stops working the moment the job starts, and it is deleted '
      + 'by the same sweep that takes the street address above',
    then: 'Deleted from the booking; the fact that it was used is kept',
  },
  {
    what: 'Notification rows, which quote the first 140 characters of a message',
    how_long: '90 days',
    then: 'Deleted',
  },
  {
    what: 'The outbound message log, which holds a phone number',
    how_long: '180 days',
    then: 'Deleted',
  },
  {
    what: 'A lapsed no-show record against an email address — the standing '
      + 'row, the report it came from and the suspension it produced',
    how_long: '730 days after it last mattered',
    then: 'Deleted. A ban has no end date and is kept',
  },
  {
    what: "A business's last known van position and the short trail behind it",
    how_long: '10 minutes after the last fix from the phone',
    then: 'Deleted from the tracking store, which is the only place it was',
  },
  {
    what: 'The counters that rate-limit a form or a link, which hold a '
      + 'fingerprint rather than the link or the email address itself',
    how_long: 'Up to 48 hours after the window they were counting closed',
    then: 'Deleted',
  },
  // THIS ROW WAS MISSING AND THE ROW ABOVE IT WAS BEING READ AS COVERING IT.
  //
  // "a fingerprint rather than the link or the address itself" is true of
  // rate_limits, which stores a peppered digest of its bucket key. It is not
  // true of the two other counters: enquiry_reach and guest_link_attempts are
  // keyed on the IP address in plain text, because what they count is "this
  // address, across different businesses" and "this address, guessing links",
  // and a digest of the thing being counted still identifies it anyway. A
  // reader who took the row above as the whole answer would conclude that no
  // raw IP address is ever written down, which is not the case.
  //
  // So it is said plainly here instead, with the windows the code actually
  // uses — six hours in chat.ts, fifteen minutes plus a fifteen-minute lockout
  // in guestlink.ts, about seventy minutes in customers.ts for the address a
  // sign-in code was asked from. All three are short and all three are swept
  // on the same cron as everything else in this table.
  {
    what: 'The IP address a message to a business, a wrong booking link or a '
      + 'sign-in code came from, used only to stop one address spraying the '
      + 'site',
    how_long: 'Six hours at the outside, and under an hour in most cases',
    then: 'Deleted',
  },
];

/**
 * The mailbox a privacy question or request goes to, and the address for
 * formal notice. One address, because there is one person reading it.
 */
const PRIVACY_CONTACT = 'weroundtheway@gmail.com';

export default function Privacy() {
  useDocumentTitle('Privacy');

  return (
    <PublicPage className="info-page">
      <Crumbs items={[{ label: 'Privacy' }]} />

      <header className="info-head">
        <h1>Privacy</h1>

        <div className="info-stamp">
          <p>
            <b>Last updated {LAST_UPDATED}.</b> This is a plain-language
            description of what Round The Way collects, why, who sees it and how
            long it is kept, written from the code that does it.{' '}
            <b>It has not been reviewed by a lawyer.</b>
          </p>
          <p>
            Round The Way is the business responsible for the data described
            here, and it is one person trading under that name rather than a
            registered company. A question or a request about it goes to{' '}
            <a href={`mailto:${PRIVACY_CONTACT}`}>{PRIVACY_CONTACT}</a>, which
            is also the address for formal notice.{' '}
            <a href="#p-contact">Section 10</a> says who that reaches, and why
            no postal address is printed on this page.
          </p>
          <p>
            <b>If this page changes in a way that matters, the &ldquo;Last
            updated&rdquo; date above changes with it.</b> That date is the
            notice: there is no separate announcement and no email, so
            comparing it against the date you last read this is how you tell
            whether anything has moved.
          </p>
        </div>

        <nav className="info-toc" aria-label="Contents">
          <h2>Contents</h2>
          <ol>
            <li><a href="#p-short">1. The short version</a></li>
            <li><a href="#p-collect">2. What is collected</a></li>
            <li><a href="#p-card">3. Card details</a></li>
            <li><a href="#p-sees">4. Who can see it</a></li>
            <li><a href="#p-others">5. Companies involved</a></li>
            <li><a href="#p-keep">6. How long it is kept</a></li>
            <li><a href="#p-delete">7. Getting a copy, and deleting your data</a></li>
            <li><a href="#p-ca">8. Where you are, and where the data is</a></li>
            <li><a href="#p-cookies">9. Cookies and tracking</a></li>
            <li><a href="#p-contact">10. Who is responsible, and how to reach them</a></li>
          </ol>
        </nav>
      </header>

      {/* --- 1 ----------------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="p-short">
        <h2 id="p-short">1. The short version</h2>
        <ul className="info-list">
          <li>
            Card details never reach Round The Way's servers. Stripe's own form
            takes them. Stripe is told your email address, your name, what the
            job costs and the order's id, because it is the company taking the
            payment — <a href="#p-others">section 5</a> links its policy.
          </li>
          <li>
            A customer's account is an email address and nothing else — no
            password. Signing in is a six-digit code emailed to that address,
            and the code is stored only as a one-way hash and deleted once it is
            used or has expired.
          </li>
          <li>
            Every booking also has its own secret link. Only a fingerprint of
            that link is stored, so nobody here is able to reissue one or hand
            it to anybody.
          </li>
          <li>
            The two sides of a booking never see each other's phone number or
            email address.
          </li>
          <li>
            Nothing is sold, rented or shared for advertising. There are no
            analytics, no advertising trackers and no third-party cookies on
            this site.
          </li>
          <li>
            Home addresses, coordinates, photographs and conversations are
            deleted on a schedule, and you can delete them sooner yourself —{' '}
            <a href="#p-delete">section 7</a> says where the button is.
          </li>
        </ul>
      </section>

      {/* --- 2 ----------------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="p-collect">
        <h2 id="p-collect">2. What is collected</h2>

        <h3>If you book something</h3>
        <dl className="info-defs">
          <div className="info-def">
            <dt>Your email address, as the account you book against</dt>
            <dd>
              Booking needs an account and the address is the whole of it. It is
              stored in one spelling — trimmed and in lower case — so that one
              mailbox typed four ways is one account rather than four. The
              six-digit code sent to it is never stored as digits, only as a
              one-way hash with the address mixed in, and it is deleted once it
              has been used or has expired. A signed-in device holds a session
              token which is stored the same way. Nothing here is a password and
              none of it can be read back out.
            </dd>
          </div>
          {/* THIS SAID THE BUSINESS COULD "ring you when they are outside",
              and that is not what the code does. Every route that shows a
              platform-introduced customer to an operator puts the number
              through maskPhone in src/lib/redact.ts first — the client list,
              the leads list, the schedule, an instant request, and the
              moderator's no-show queue — so what any of them ever sees is the
              last two digits. Nothing texts it either: the offer path in
              rank.ts requires a number AND sms_consent on an operator's OWN
              imported client, and a platform-introduced client row is written
              with phone_e164 NULL on purpose.

              A privacy page may not state a purpose the product does not
              serve, and this one was stating the single most reassuring
              possible reason for holding the sharpest contact detail we ask
              for. What is true is written below instead, including the part
              that is uncomfortable: today the number is held and not used. The
              honest options are to stop collecting it or to build the thing it
              was collected for, and until one of those happens this says so
              rather than describing the second one as though it existed. */}
          <div className="info-def">
            <dt>Your name and phone number</dt>
            <dd>
              The name is so the business knows who is expecting them. The
              number is asked for so there is a way to reach you on the day if
              something goes wrong — and it is worth being exact about what
              that means today, because the answer is less than it sounds.{' '}
              <strong>The business is never shown your number.</strong> Every
              screen that shows them your booking shows the last two digits and
              nothing else, which is enough to tell two jobs apart on a busy
              morning and not enough to ring or text you. Nothing on this site
              sends you a text message. So the number is currently held and not
              used, and it is deleted along with everything else when you ask
              under <a href="#p-delete">section 7</a>.
            </dd>
          </div>
          <div className="info-def">
            <dt>Why your email address, and not your number, is the account</dt>
            <dd>
              Nothing checks the number — it is a contact detail rather than a
              second way in, and no sign-in code is ever sent to it. Your email
              address is what ties your bookings together across different
              businesses, which is what makes a single deletion request able to
              reach all of them.
            </dd>
          </div>
          <div className="info-def">
            <dt>The address, its postcode and its map position</dt>
            <dd>
              So somebody can drive to it, and so openings within reach of it
              can be found. The coordinates are precise, which is exactly why
              they are removed 90 days after the job.
            </dd>
          </div>
          <div className="info-def">
            <dt>What you booked, when, and what it cost</dt>
            <dd>The record of a transaction, kept as one.</dd>
          </div>
          <div className="info-def">
            <dt>Your payment, and what goes to Stripe with it</dt>
            <dd>
              Booking needs a card as well as an account, and the payment runs
              through Stripe, Inc. The card number, its expiry date and its
              security code go from your browser into Stripe's own form and
              never touch this site. What Stripe is sent with the charge is
              your email address, your name, the amount and the order's id.
              What comes back and is stored against your account is a Stripe
              customer id and a reference to the payment method — neither is a
              card number, and neither can be turned back into one. Stripe
              holds its copy under its own policy, linked in{' '}
              <a href="#p-others">section 5</a>.
            </dd>
          </div>
          <div className="info-def">
            <dt>Your messages, and photographs of the job</dt>
            <dd>
              So the two of you can talk, and so a dispute can be settled on
              pictures rather than on two accounts of the same afternoon.
              Contact details typed into a message are removed before it is
              stored. Every photograph has its metadata taken out on the way
              in, and what that means depends on the format. A JPEG, a PNG or a
              WebP is rebuilt from its picture data alone, so the GPS position,
              the timestamp, the camera details and the embedded thumbnail are
              gone because they were never copied across. An HEIC — which is
              what an iPhone produces by default — is not rebuilt, because
              moving bytes around in one is how a photograph gets silently
              corrupted two years later; instead the location data inside it is
              found and overwritten with zeros where it sits. The position is
              destroyed either way. In an HEIC the empty slot it was in is
              still there, and anything a phone might have buried in the
              compressed image data itself is beyond what this does. Nothing in
              any format touches what is visible in the picture: a photograph
              of a front door with the number on it is still that.
            </dd>
          </div>
          <div className="info-def">
            <dt>An alert postcode, an email address or a push subscription</dt>
            <dd>
              Only if you ask to be told when an opening appears near you.
            </dd>
          </div>
        </dl>

        <h3>If you list a business</h3>
        <dl className="info-defs">
          <div className="info-def">
            <dt>Your email address and business name</dt>
            <dd>
              The email is how you sign in — a link is sent to it — and the
              business name is what customers see.
            </dd>
          </div>
          <div className="info-def">
            <dt>Your phone number, and your base address and its coordinates</dt>
            <dd>
              To work out which openings are near enough to which customers.
            </dd>
          </div>
          <div className="info-def">
            <dt>Your vehicle's make, model, colour and plate</dt>
            <dd>
              Shown to the customer expecting you, so they know what should be
              on the driveway before they open the door.
            </dd>
          </div>
          <div className="info-def">
            <dt>Your services, prices, hours, areas, photographs and profile</dt>
            <dd>Your public page. Most of this is meant to be seen.</dd>
          </div>
          <div className="info-def">
            <dt>The Stripe account your money arrives in</dt>
            <dd>
              You cannot put an opening up until you have connected a Stripe
              account with a bank account on it, because that is where payment
              for the work goes. The identity details and the bank details
              Stripe needs for that are given to Stripe directly, through
              Stripe's own onboarding, and are held by Stripe under its policy
              — Round The Way does not receive or store them. What this site
              holds is the reference to that connected account.
            </dd>
          </div>
          <div className="info-def">
            <dt>
              A licence number and state, an insurer and policy number, and the
              name a background check was run against
            </dt>
            <dd>
              Only if you enter them. None of it is verified by Round The Way, and
              the pages that show it say so.
            </dd>
          </div>
          <div className="info-def">
            <dt>Where your van is, while you are sharing it</dt>
            <dd>
              Only with location sharing switched on. The live position is not a
              row in the database and there is no history table. It is held in
              memory by the tracking service, which also keeps one snapshot of
              it — the last fix and up to twenty sampled points behind it — so
              that the van does not vanish off a customer's screen if that
              service restarts mid-journey. That snapshot is overwritten in
              place rather than added to, and it is deleted ten minutes after
              the last fix arrives, which is the same ten minutes after which
              nothing would show it to anybody anyway. Closing your account
              deletes it immediately.
            </dd>
          </div>
          <div className="info-def">
            <dt>Who sees that position, and how precisely</dt>
            <dd>
              It is rounded to about 110 metres before it leaves us. Two people
              can see it, never at the same time. While you are free, a vehicle
              appears on the map on the front page with no name, no link and no
              trail attached to it — that map is how somebody finds out anybody
              is working near them at all. Once a job is booked you come off
              that map, and the customer whose job it is sees you instead, from
              90 minutes before their slot until 30 after.
            </dd>
          </div>
          <div className="info-def">
            <dt>What that does and does not protect you from</dt>
            <dd>
              Said exactly, because this is the part it would be easy to
              overstate: nothing published on the public map carries your name,
              your business or a link to you; the handle that lets the map draw
              one dot moving is replaced every ten minutes; and those
              replacements are staggered, so the vehicles on screen do not all
              change handle at the same moment. That is not a proof. Somebody
              watching one dot closely on a quiet map may still be able to guess
              that the dot before a change and the dot after it are the same
              vehicle, because they are in the same place. What keeps that from
              being worth doing is the rest of it: you leave the map entirely
              from 90 minutes before a booking, so the drive that ends at
              somebody's front door is never drawn at all, and the map goes dark
              on its own ten minutes after your phone stops reporting.
            </dd>
          </div>
        </dl>

        <h3>Everybody</h3>
        <p>
          Ordinary web-server information — an IP address and the request
          itself — is used to rate-limit abuse and to run the bot check on the
          handful of forms that can cost somebody money. There is no analytics
          product on this site and nothing profiles you.
        </p>
      </section>

      {/* --- 3 ----------------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="p-card">
        <h2 id="p-card">3. Card details</h2>
        <p>
          Card numbers, expiry dates and security codes are typed into Stripe's
          own form and never reach Round The Way's servers. What comes back and
          is stored is Stripe's reference to the card and to you as a Stripe
          customer — opaque strings that a later charge can be made against and
          that are not card numbers.
        </p>
        <p>
          That is enforced rather than promised. A request body, a database
          write or a response that contains something shaped like a card or
          bank number is refused, everywhere in the product, whatever route it
          arrived on.
        </p>
      </section>

      {/* --- 4 ----------------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="p-sees">
        <h2 id="p-sees">4. Who can see it</h2>
        <ul className="info-list">
          <li>
            <strong>The other side of your booking.</strong> A business sees
            your name, your address, what you booked and your messages. You see
            their business name, their vehicle and their messages. Neither of
            you gets the other's phone number or email address.
          </li>
          <li>
            <strong>Anybody holding your booking link.</strong> It is bearer
            authority over that booking, by design, so that a booking can be
            opened on any phone without signing in — including one that has
            never been signed in at all.
          </li>
          {/* WHAT THE AUDIT ROW ACTUALLY HOLDS, checked against the code that
              writes it rather than against what the table can hold. This said
              the row identifies a customer by a hash of their phone number.
              src/lib/audit.ts does have a branch that hashes an identifier, but
              no caller passes one: the row a confirmed no-show writes names the
              REPORT and the strike number, and the person is reachable only by
              opening that report. Naming a mechanism nothing uses is the kind
              of promise a privacy page must not make, and it was doubly wrong
              after migration 0038 moved a customer's identity off the number
              altogether. */}
          <li>
            <strong>Somebody at Round The Way reviewing a dispute.</strong> A
            no-show report or a payment dispute is decided by a person, who can
            read what the report is about. Every one of those reads is recorded
            — who, what, when, and which record — and what the record names is
            the report being decided, not you: your address, your number and
            what anybody wrote about you stay on the report, where a deletion
            request can reach them, so the audit trail cannot become a second
            copy of the thing it is about.
          </li>
          <li>
            <strong>Anybody looking at the map, but only as a vehicle.</strong>
            {' '}While a business is switched on and not booked, a vehicle
            shows on the front page — no name, no business, no link, no trail,
            and a position rounded to about 110 metres. Nothing on it says who
            it is, and it disappears the moment that business is booked.
          </li>
          <li>
            <strong>Nobody else.</strong> Job photographs are never published,
            never put on a profile and never used as advertising; the only way
            one becomes public is you attaching it to your own review. Nothing
            here is sold, rented or handed to an advertiser.
          </li>
        </ul>
      </section>

      {/* --- 5 ----------------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="p-others">
        <h2 id="p-others">5. Companies involved</h2>
        <p>
          The site talks to a short and fixed list of outside services, and the
          browser is instructed to refuse anything not on it.
        </p>
        <ul className="info-list">
          <li>
            <strong>Stripe, Inc.</strong> Takes card details directly, in its
            own form, and is sent your email address, your name, the amount and
            the order's id with each charge. A business connecting its payout
            account gives Stripe its identity and bank details directly. Stripe
            holds all of that under its own policy:{' '}
            <a href="https://stripe.com/privacy" target="_blank" rel="noreferrer">
              stripe.com/privacy
            </a>.
          </li>
          <li>
            <strong>Cloudflare.</strong> Runs the site, stores the database,
            holds the photographs in a separate store of its own that copies
            them around its network, and provides the bot check on the public
            forms.
          </li>
          <li>
            <strong>The United States Census Bureau's geocoder.</strong> When a
            booking or an instant request gives a street address in the United
            States, and the postcode alone is not precise enough to place it,
            that street line and postcode are sent to the Census Bureau's public
            address-lookup service to be turned into a map position. It is a
            federal government service, it is free and it needs no account, so
            nothing identifies this site or you to it beyond the address itself
            and the request. Nothing else about you goes with it — no name, no
            email address, no phone number, no booking. It is how the site knows
            where to send somebody, and it is named here because a list of
            outside services that leaves one out is wrong in the only direction
            that matters.
          </li>
          <li>
            <strong>OpenFreeMap and OpenStreetMap.</strong> Map tiles. Loading a
            map means your browser fetching tiles from them.
          </li>
          {/* TWO ENTRIES USED TO SIT HERE, AND THEIR REMOVAL IS THE POINT.

              This list said "Google Fonts, and unpkg", and said — correctly at
              the time, and only after being made precise once — that both were
              fetched on EVERY page rather than only the ones with a map.
              web/index.html is the shell every app-drawn route is served from,
              and the typefaces and the map library were plain tags in its
              head. So the front page, a cost guide, the terms of service and
              the booking link somebody opens on their own driveway all sent
              that person's IP address and browser string to two companies with
              no part in the booking.

              The fix was not better wording. Both are served from this site
              now: the woff2 files sit in this app's own assets, and the map
              library ships in a chunk the app loads itself, only on a page
              that draws a map. Neither host is named in the
              Content-Security-Policy any more, so a tag that tried to bring
              one back would be refused by the browser rather than quietly
              working.

              Which leaves ONE outside service the browser fetches on this
              whole site, and it is genuinely conditional. That is why the
              paragraph below is now much shorter than it was. */}
          <li>
            <strong>Your browser's push service, and an email provider.</strong>{' '}
            Only if you asked for alerts, or are a business receiving a sign-in
            link.
          </li>
        </ul>
        {/*
          CalOPPA § 22575(b)(6): whether third parties MAY collect personal
          information about a visitor across other sites over time. This used
          to have to account for three browser-fetched services. Two of them
          were removed rather than described better, so the honest answer is
          now about one — and about one that only loads when a map does.
          Answering "no tracking here" and stopping would still be answering a
          different question, so the shape of the paragraph is kept.
        */}
        <p>
          One of those is fetched by your browser rather than by this server,
          which means your IP address reaches it directly: OpenFreeMap, and
          only on a page that draws a map. Round The Way sends it nothing about
          you, asks it for nothing about you and gets nothing back about you.
          But an IP address arriving on a request is something any company
          could in principle record, and that one serves a great many other
          sites, so Round The Way cannot promise on its behalf that nothing
          about a visitor is ever built up over time. What can be promised is
          this side of it: nothing here asks it to identify you, no identifier
          of yours is attached to those requests, and the browser is instructed
          to refuse any origin not on the list above.
        </p>
        <p>
          It was three until recently. The typefaces and the map library used
          to be fetched from Google and from a code CDN on <em>every</em> page,
          map or no map. Both are now served from this site itself, so those
          two requests do not happen at all — which is a better answer than any
          wording on this page could have been.
        </p>
      </section>

      {/* --- 6 ----------------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="p-keep">
        <h2 id="p-keep">6. How long it is kept</h2>
        <p>
          A scheduled job deletes each of these without anybody asking. The
          question behind every row was the same: how long after the job could
          this still answer something somebody is entitled to ask?
        </p>

        <div className="info-scroll" tabIndex={0} role="region"
          aria-label="Retention periods">
          <table className="info-table">
            <thead>
              <tr>
                <th scope="col">What</th>
                <th scope="col">How long</th>
                <th scope="col">Then</th>
              </tr>
            </thead>
            <tbody>
              {KEPT.map((row) => (
                <tr key={row.what}>
                  <th scope="row">{row.what}</th>
                  <td>{row.how_long}</td>
                  <td>{row.then}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p>
          The one exception in that table is a photograph you published on your
          own review. The sweep leaves it alone deliberately: you chose to put
          it there, and taking it down on a timer would be silently editing
          your own review three months later. A deletion request under{' '}
          <a href="#p-delete">section 7</a> still takes it, with everything
          else.
        </p>
        <p>
          The 21 days on a job&rsquo;s photographs is the shortest window in
          that table, and it is short on purpose. A picture of the inside of a
          house is here to settle an argument about whether the work happened,
          and every question this site asks itself about a booking — whether
          the money goes back, whether the business gets paid — has an answer
          within hours of the appointment. What is left is the time it takes a
          person to notice that something was wrong and say so, and three weeks
          is a fortnight away plus a week to get round to it. It used to be 90
          days, which kept a quarter of a year of every job on the site against
          an argument almost none of them will ever have.
        </p>
        <p>
          If somebody does say so, the pictures come off the timer altogether.
          A booking with a claim on it — one of you reporting that the other
          did not turn up, or a payment frozen while we ask whether the work
          happened — keeps its photographs until that is settled, however long
          that takes, and for 30 days afterwards. Thirty is the length of the
          longest suspension a settled report can impose, so if you are
          appealing one the pictures it was based on are still there for the
          whole of it. There is one thing this does not stretch to, and it is
          better said than left implied: a card chargeback is raised at your
          bank and never reaches this site, so nothing here can see one and
          hold the photographs for it.
        </p>
        <p>
          The 180 days on a finished job's conversation is set by that same card
          chargeback, which is the longest thing that can still arrive. Deleting
          it sooner would leave a business unable to show what was agreed at the
          moment it most needs to — and the conversation, not a photograph, is
          what answers that question.
        </p>
        <p>
          What is not on a timer is the record of money that has already moved —
          an amount, a currency, a date and which business it was with. That is
          a record of a transaction between two parties, and a marketplace that
          can be talked into deleting its own books cannot answer a chargeback
          or a tax question.
        </p>
      </section>

      {/* --- 7 ----------------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="p-delete">
        <h2 id="p-delete">7. Getting a copy, and deleting your data</h2>

        {/* THIS SECTION ONLY EVER DESCRIBED DELETION, and deletion is the one
            of the two that is built. Section 8 then said "to know what is
            held — section 2 is that list, in full", which answers a different
            question: section 2 lists the CATEGORIES and their purposes, and a
            person asking for their data is asking for their data — the
            addresses, the messages, the photographs, the bookings. There is no
            button for that and writing the page as though section 2 were one
            would be the same class of claim as a "Do Not Sell" link that does
            nothing.

            So it is said here, first, in the section people arrive at: the
            copy is a manual request to a mailbox, and the deletion below is
            not. Deletion being self-service and access not being is worth
            stating in that order rather than hiding, because it tells somebody
            which of the two they can have in the next ten seconds. */}
        <h3>Asking for a copy of what is held about you</h3>
        <p>
          There is <strong>no download button for this yet</strong>, and
          pretending otherwise would describe a thing that does not exist.
          Write to{' '}
          <a href={`mailto:${PRIVACY_CONTACT}`}>{PRIVACY_CONTACT}</a> from the
          email address on your account — or, if you booked as a guest, with
          the booking link you were sent — and what is held about you will be
          put together by hand and sent back to that address. One person reads
          that mailbox, so allow a few days rather than a few minutes.
        </p>
        <p className="note">
          Deleting is the opposite, and deliberately so: it is a button, it
          needs nobody's approval, and it happens while you are looking at it.
          A deletion right that waits on somebody reading an email is a
          deletion right that fails quietly, which is why that one is not built
          this way.
        </p>

        <h3>If you booked something</h3>
        <p>
          Two doors, and the same erasure behind both. Open your booking from
          the link you were sent and scroll to the bottom, where{' '}
          <strong>Delete my data</strong> is; or sign in to your account with
          the email address you booked on and press it there. You do not have to
          ask anybody and nobody has to approve it. Because your bookings are
          tied together by your email address, it reaches every business you
          have booked with through this site, not just the one whose link you
          are holding.
        </p>
        <p>
          <strong>Close account</strong> is the smaller request beside it, and
          it is on the account page only. It empties the account — the email
          address, the mobile number, the name, any stored card reference and
          the reference to your customer record at Stripe — and ends every
          session on it, and it leaves the bookings and the
          conversations alone: an order is a record of something that happened
          between two people, and one of them does not delete it on their own.
          A live suspension survives it, for the same reason it survives an
          erasure.
        </p>
        <p>What that removes:</p>
        <ul className="info-list">
          <li>
            <strong>Deleted outright:</strong> your conversations and every
            message in them; the photographs from those jobs, including any you
            had chosen to publish on a review; the customer record each
            business was given; requests you sent that never became bookings;
            and any opening alerts on your email address.
          </li>
          <li>
            <strong>Emptied but kept:</strong> the appointment stays as a record
            that work happened, with the address and anything written about your
            home taken out. A review keeps its rating and its words — other
            customers rely on those — and the name on it becomes "A customer".
          </li>
          <li>
            <strong>Kept:</strong> what was paid, with nothing on it that names
            you. And, only if you are under a live suspension or ban, the record
            of that — otherwise "delete my data" would also be the button that
            clears a sanction. It is deleted as soon as the suspension lapses.
          </li>
        </ul>
        <p>
          <strong>What Stripe keeps, which is not ours to delete.</strong>{' '}
          Paying for a booking creates a customer record at Stripe holding your
          name and email address, and the reference to it is stored here against
          your account. That reference is deleted along with everything else
          above, so nothing on this side links you to it any more. The record
          itself stays at Stripe, under{' '}
          <a href="https://stripe.com/privacy" target="_blank" rel="noreferrer">
            its own policy
          </a>{' '}
          and its own retention rules, because a payment processor is required
          to keep a record of payments it has processed and this site cannot
          order it to forget one. There is no button here that reaches into
          Stripe, and saying otherwise would be describing a deletion that does
          not happen. To ask Stripe directly, write to the address on that
          policy — or to{' '}
          <a href={`mailto:${PRIVACY_CONTACT}`}>{PRIVACY_CONTACT}</a> and it
          will be passed on.
        </p>
        <p className="note">
          On this side there is no undo, no grace period and no copy kept in
          case you change your mind, and the link stops working the moment it is
          done.
        </p>

        <h3>If you list a business</h3>
        <p>
          <strong>Close account</strong> is in Settings in the app. It empties
          the personal columns on your account for real — the email you sign in
          with, your phone number, your home address and its coordinates, your
          licence number, your insurance policy number, the name a background
          check was run against, your vehicle's plate, your social handles and
          your avatar — and deletes your client list, your conversations and the
          requests strangers had sent you, because that is other people's
          personal data that only existed because your account did.
        </p>
        <p>
          Work that happened and money that moved survive it, describing a
          business that no longer exists rather than a person. Closing is
          refused while there are still bookings in your diary: it would leave
          those customers with nobody coming and no way to reach you, so cancel
          or finish them first.
        </p>
        {/* THE OPERATOR SIDE HAD NO STRIPE PARAGRAPH AT ALL, while the
            customer side above has a careful one. That asymmetry was the wrong
            way round: a customer's record at Stripe is a name and an email
            address, and a business's is a legal name, a date of birth, an
            identity document and a bank account. Somebody closing a listing is
            entitled to know that closing it here does not close that, and to
            know that the reference is kept rather than being told a general
            "personal columns are emptied" that quietly is not true of it. The
            reason it is kept is money, and saying so is better than either
            hiding it or clearing it and leaving somebody unpaid — see the note
            at closeOperatorAccount in src/lib/retention.ts. */}
        <p>
          <strong>What Stripe keeps, and the one reference that stays
          here.</strong> Connecting a payout account gives Stripe your identity
          details and your bank details directly, and Stripe holds them under{' '}
          <a href="https://stripe.com/privacy" target="_blank" rel="noreferrer">
            its own policy
          </a>. Closing here does not close that, and nothing on this site can:
          a payment processor is required to keep a record of the payments it
          has handled. The reference to your connected account is also kept on
          the closed row rather than emptied with the rest, and the reason is
          money rather than record-keeping — a card can be captured and a
          transfer owed days after your last job, and parts approved at the
          kerb are settled later still, so deleting the only pointer to where
          your money should go would leave you unpaid for work you had already
          done. To ask Stripe directly about what it holds, write to the
          address on that policy, or to{' '}
          <a href={`mailto:${PRIVACY_CONTACT}`}>{PRIVACY_CONTACT}</a> and it
          will be passed on.
        </p>
      </section>

      {/* --- 8 ----------------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="p-ca">
        <h2 id="p-ca">8. Where you are, and where the data is</h2>

        {/* THIS SECTION WAS CALIFORNIA AND NOTHING ELSE, which left the one
            jurisdiction with a paragraph being the one whose law the page then
            explains does not apply, and every reader outside the United States
            with nothing at all.

            WHAT THE PRODUCT ACTUALLY SUPPORTS, checked rather than assumed,
            because the plan and the code disagree and the code is what
            happens. COUNTRIES in src/lib/countries.ts has exactly one entry —
            US — and the comment beside it says Canada, the UK, Ireland,
            Australia and New Zealand were removed deliberately. So there is no
            operator outside the United States, no non-USD currency and no
            non-US postcode this site will accept. A page that had claimed six
            markets would have been describing a roadmap.

            WHICH IS NOT THE SAME AS "ONLY AMERICANS ARE AFFECTED", and that is
            the reason this subsection exists at all. The site is on the open
            internet: anybody anywhere can load it, and opening a page with a
            map on it sends their IP address to the tile service (section 5 —
            the fonts and the map library used to go to two more, and no longer
            leave this site at all). Anybody anywhere can start a conversation with a
            business or leave an email address on an opening alert. So there
            are almost certainly people outside the United States in this
            database, and they are entitled to a paragraph.

            WHAT IT DELIBERATELY DOES NOT DO is tell that reader which statute
            covers them. Nobody here is qualified to decide it, the page says at
            the top that no lawyer has reviewed it, and a confident list of
            rights attributed to named laws would repeat exactly the mistake the
            California paragraph below was corrected for: it invites somebody to
            believe a regulator stands behind a sentence written by the person
            who also wrote the database. Facts about this product are what this
            page can be held to; conclusions about foreign law are not. */}
        <h3>If you are outside the United States</h3>
        <p>
          Every business listed here is in the United States — that is the only
          country the site accepts an operator, a currency or a postcode in
          today. But the site itself is on the open internet, so you can read
          it, message a business or set up an opening alert from anywhere, and
          simply loading a page sends your IP address to the three services in{' '}
          <a href="#p-others">section 5</a> that your browser fetches from
          directly.
        </p>
        <p>
          Which means somebody reading this may be covered by the UK or EU
          General Data Protection Regulation, by PIPEDA in Canada, or by the
          Australian Privacy Principles.{' '}
          <strong>
            Whether any of those actually binds a one-person business of this
            size has not been assessed by a lawyer, and this page does not claim
            an answer.
          </strong>{' '}
          What it can do is be straight about the facts underneath the question,
          so that you — or somebody you ask — can decide.
        </p>
        <ul className="info-list">
          <li>
            <strong>Who holds it.</strong> Round The Way, one person trading
            under that name. Not a company, not a group, and there is no data
            protection officer and no representative in the EU or the UK.{' '}
            <a href="#p-contact">Section 10</a> is the whole of the contact
            route.
          </li>
          <li>
            <strong>Where it physically sits.</strong> On Cloudflare&rsquo;s
            network, in a database whose region is not pinned to any country by
            this site&rsquo;s configuration — so it may well be outside the one
            you are in. Photographs are not in that database: they are held in
            a separate Cloudflare store that copies them around its network, so
            a photograph may sit in more countries than the rest of your
            record, and that is how it works rather than a setting anyone here
            chose. Payments are handled by Stripe, Inc. in the United States.
            Both are named in <a href="#p-others">section 5</a> with everything
            else that is involved.
          </li>
          <li>
            <strong>Why it is held.</strong> To do the thing you asked for — to
            get somebody to your address at the time you booked, to take the
            payment, to carry the messages between you, and to settle a dispute
            if there is one. Plus the narrow exceptions{' '}
            <a href="#p-keep">section 6</a> and{' '}
            <a href="#p-delete">section 7</a> spell out: the record of money
            that moved, and a live suspension. Nothing is held in order to
            advertise to you, profile you, or sell anything about you, and{' '}
            <a href="#p-cookies">section 9</a> is the detail of that.
          </li>
          <li>
            <strong>What you can actually do today.</strong> Delete everything,
            yourself, from a button, with nobody&rsquo;s approval — section 7.
            Ask for a copy of what is held, by email, answered by hand —
            section 7 again. Correct a business account yourself; correct a
            booking by saying so in its conversation. Withdraw an opening alert
            in one click from any alert email. Those are the ones that are
            built and work; the page does not list a right it cannot deliver.
          </li>
          <li>
            <strong>If you are not satisfied.</strong> Write to the mailbox in
            section 10 first, because one person reads it and can actually fix
            things. Many countries also have a national privacy regulator you
            can complain to independently of that, and you do not need this
            site&rsquo;s permission to do so.
          </li>
        </ul>

        <h3>If you are in California</h3>
        {/*
          THE HONEST BASIS FOR THIS SECTION. It used to open "California gives
          residents specific rights over personal information", which reads as
          a claim that the CCPA applies here. Civ. Code § 1798.140(d) says it
          applies to a business over one of three thresholds, and this one is
          over none of them. Reciting the statute as though it bound us would
          be a false statement about our own obligations — and quietly worse,
          it would invite a reader to think a regulator stands behind these
          buttons. The rights stay, because they are all built and all work.
          Only the reason they are here changes.
        */}
        <p>
          California's consumer privacy law applies to a business that crosses
          one of three lines: roughly $26.6 million of annual revenue, personal
          information about 100,000 Californians or households in a year, or
          half its revenue from selling personal information. Round The Way is
          over none of them, so that law does not apply to it and nothing below
          is offered because a statute compels it.
        </p>
        <p>
          The rights below are offered anyway, and every one of them is built
          and works today. Here is how each lands on this product.
        </p>
        <ul className="info-list">
          <li>
            <strong>To know what is held.</strong> Section 2 is that list, in
            full, by category and purpose, and there is no further category
            held back. For an actual copy of your own data rather than the
            categories, <a href="#p-delete">section 7</a> says how to ask —
            that part is a request to a mailbox and not a button.
          </li>
          <li>
            <strong>To delete.</strong> Section 7, and you can exercise it
            yourself without contacting anybody. What is retained afterwards,
            and why, is set out there rather than hidden behind an exemption.
          </li>
          <li>
            <strong>To correct.</strong> A business can edit everything on its
            own account. A customer can correct a booking's details in the
            conversation on that booking — there is no self-service editor for
            a booking's name or address today, and pretending otherwise would
            be a right described but not built.
          </li>
          <li>
            <strong>To opt out of sale or sharing.</strong> Nothing here is
            sold or shared for advertising or for cross-context behavioural
            advertising, so there is nothing to opt out of and no "Do Not Sell
            or Share" link, because a link that did nothing would be worse than
            none.
          </li>
          <li>
            <strong>To limit the use of sensitive information.</strong> Two
            things California counts as sensitive are here, and saying
            otherwise would be the kind of omission this page is written
            against. The address of a job you booked, and — for a business that
            switched location sharing on — its live position, are both precise
            location: California draws that line at 1,850 feet and both sit
            inside it. Neither is used to work out anything about you: no
            profile, no inference, no advertising, nothing sold or shared.
            Beyond those two there are no sensitive categories at all — no
            government identifiers, no health, biometric, racial, religious or
            union information, and no financial account numbers, because the
            card and bank details belong to Stripe and never reach this side of
            it (<a href="#p-card">section 3</a>). To limit either
            one, a business switches location sharing off, and a job address is
            removed 90 days after the job in any case.
          </li>
          <li>
            <strong>Not to be discriminated against for exercising any of the
            above.</strong> Nothing in the product prices or ranks anybody by
            whether they have deleted their data.
          </li>
        </ul>
        <p className="note">
          There is no authorised-agent process and no identity-verification
          process, because there is nothing for either to protect: a customer
          proves who they are by holding their own booking link, and a business
          by being signed in. Neither of those requires anybody at Round The Way to
          check a document.
        </p>
      </section>

      {/* --- 9 ----------------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="p-cookies">
        <h2 id="p-cookies">9. Cookies and tracking</h2>
        <ul className="info-list">
          {/* THIS SAID "There is no cookie for customers at all." It was true
              when a customer had no account to be signed in to, and it stopped
              being true the moment they did. src/lib/customers.ts sets
              __Host-sf_customer on every customer sign-in, with its own name so
              that a browser signed in as both a business and a customer carries
              both credentials without either overwriting the other.

              AND BOTH NAMES PRINTED HERE WERE OUT OF DATE. The two cookies
              were renamed to carry the __Host- prefix — CUSTOMER_COOKIE in
              src/lib/customers.ts is __Host-sf_customer and SESSION_COOKIE in
              src/lib/auth.ts is __Host-gf_session — and this section still told
              a reader to look for `sf_customer`. That is not a stale comment in
              a source file; it is user-facing text making a checkable promise,
              and somebody who opens their browser's cookie list and finds no
              such name has been handed something false by the one page whose
              entire job is being accurate about what this site stores. If
              either constant is renamed again, these two lines move with it.

              The prefix gets a bullet of its own rather than a parenthesis
              because it is the reason for the rename and it is a protection a
              reader benefits from understanding, not punctuation in a name. */}
          <li>
            <strong>One cookie for a business.</strong> Signing in sets{' '}
            <span className="mono">__Host-gf_session</span>. It is HttpOnly,
            sent only over HTTPS, same-site, and it holds a session reference
            and nothing else.
          </li>
          <li>
            <strong>One cookie for a customer.</strong> Signing in as a
            customer sets <span className="mono">__Host-sf_customer</span>. It
            is HttpOnly, so no script on the page can read it; Secure, so it
            only travels over HTTPS; and SameSite=Lax, so another site cannot
            make your browser send it. All it carries is a reference to your
            session, which is what keeps you signed in between visits — no
            name, no address, nothing about what you have booked. It is a
            different cookie from the business one on purpose, so that somebody
            who is both can be signed in as both.
          </li>
          <li>
            <strong>Why both names start with{' '}
            <span className="mono">__Host-</span>.</strong> Those characters are
            part of the cookie's name, and your browser reads them as a rule it
            enforces itself: a cookie named that way is only accepted from this
            exact site, over HTTPS, and is refused outright if anything on a
            subdomain tries to set it. So no other host under this domain can
            plant or overwrite the cookie that keeps you signed in. The browser
            stops it, which is a stronger guarantee than this site checking
            afterwards and noticing.
          </li>
          <li>
            <strong>No analytics and no advertising.</strong> No page-view
            product, no tag manager, no pixel, no third-party cookies, no
            fingerprinting and no advertising identifiers.
          </li>
          <li>
            <strong>Two things stored in your own browser.</strong> The
            appointments in your basket before you check out, which are cleared
            when you close the tab; and, if you have set up an opening alert,
            the address of the push subscription that alert uses. Both stay on
            your device.
          </li>
          <li>
            <strong>Push notifications</strong> are only ever set up by you
            asking for an opening alert, and switching them off deletes the
            subscription.
          </li>
          {/* CalOPPA § 22575(b)(5): a site collecting personal information
              from Californians must say how it responds to a Do Not Track
              signal. There is no size threshold on that, and this page had no
              such statement anywhere. The honest answer is not "we honour it"
              — nothing is being done that honouring it would stop. */}
          <li>
            <strong>Do Not Track.</strong> Some browsers can send a Do Not
            Track signal. This site does not track you across other sites, so
            there is nothing for that signal to switch off and nothing about
            the site changes when it arrives. There is no analytics product
            here, no advertising network, no pixel and no profile built from
            where you have been — and so no behaviour a Do Not Track header
            could turn off, whichever way it is set.
          </li>
        </ul>
        <p className="note">
          Because there is no tracking to consent to, there is no cookie banner
          on this site. That is the reason, not an oversight.
        </p>
      </section>

      {/* --- 10 ----------------------------------------------------------
          WHAT THIS SECTION USED TO BE, and why the shape of it changed rather
          than the last blank being filled. It was "What this document is
          missing": three of four gaps reported as filled, and [REGISTERED
          ADDRESS] left in a dashed box as the fourth. There was never going to
          be a value for that box — no registered company, one person trading
          under a name, working from a home — so a section built to display the
          hole was a section permanently telling the reader that a piece of
          this page was owed to them and being withheld. What replaced it is
          the clause a privacy page needs in that position anyway: the party
          responsible, the mailbox that reaches them, and the reason the postal
          line is absent. -------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="p-contact">
        <h2 id="p-contact">10. Who is responsible, and how to reach them</h2>
        <p>
          The business responsible for everything described on this page is{' '}
          <strong>Round The Way</strong>, which is one person trading under
          that name — a sole proprietor rather than a registered company. There
          is no privacy department and no ticket queue: a question or a request
          goes to{' '}
          <a href={`mailto:${PRIVACY_CONTACT}`}>{PRIVACY_CONTACT}</a> and is
          read by the person who runs the site. That mailbox is also the
          address for formal notice.
        </p>
        <p>
          No postal address is printed here, because the address this business
          is run from is a home. A page that has the street address of a
          finished job deleted 90 days afterwards
          (<a href="#p-keep">section 6</a>) is the last page that should be
          publishing somebody's home address of its own. If you need a postal
          address for formal legal notice, ask at that mailbox and it will be
          given to you — <Link to="/terms">Terms</Link> carries the same clause
          at greater length, along with the law that governs the terms
          themselves.
        </p>
        <p className="note">
          You can write to that mailbox about any of this. You should not have
          to, and that is deliberate: everything
          in <a href="#p-delete">section 7</a> happens at the press of a button
          without anybody answering an email, because a deletion right that
          depends on somebody reading a mailbox is a deletion right that fails
          quietly.
        </p>
      </section>

      <footer className="info-foot">
        <p>
          This describes the service as it behaves on {LAST_UPDATED}. Where this
          page and the site disagree, the site is what happens and this page is
          what is wrong.
        </p>
        <p>
          <Link to="/terms">Terms</Link>
          {' · '}
          <Link to="/safety">Safety</Link>
          {' · '}
          <Link to="/covered">What is covered</Link>
          {' · '}
          <Link to="/help">Help</Link>
        </p>
      </footer>
    </PublicPage>
  );
}
