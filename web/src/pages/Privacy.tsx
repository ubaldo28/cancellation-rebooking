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
 * wrong in the one direction that matters.
 *
 * The placeholders are the same four as on Terms and for the same reason: no
 * invented company, address, jurisdiction or mailbox.
 */

const LAST_UPDATED = '5 September 2026';

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
    what: 'Photographs taken on a job',
    how_long: '90 days after the job',
    then: 'Deleted from storage and from the database',
  },
  {
    what: 'The street address and map position of a finished job',
    how_long: '90 days after the job',
    then: 'Removed; the postcode is kept',
  },
  {
    what: 'An instant request nobody accepted',
    how_long: '7 days',
    then: 'Deleted',
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
    what: 'A lapsed no-show record against a phone number',
    how_long: '730 days after it last mattered',
    then: 'Deleted. A ban has no end date and is kept',
  },
];

const UNKNOWNS: Array<{ what: string; why: string }> = [
  { what: '[OPERATING COMPANY NAME]', why: 'the entity responsible for this data' },
  { what: '[REGISTERED ADDRESS]', why: 'where that entity is registered' },
  { what: '[PRIVACY CONTACT]', why: 'the address a privacy request would be sent to' },
  { what: '[PAYMENT PROCESSOR]', why: 'the company whose form takes card details' },
];

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
            description of what Slotfill collects, why, who sees it and how
            long it is kept, written from the code that does it.{' '}
            <b>It has not been reviewed by a lawyer.</b>
          </p>
          <p>
            The company name, address and privacy contact are not stated
            anywhere in this product. They are listed as gaps in{' '}
            <a href="#p-unknown">section 10</a> rather than filled in with
            something plausible.
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
            <li><a href="#p-delete">7. Deleting your data</a></li>
            <li><a href="#p-ca">8. If you are in California</a></li>
            <li><a href="#p-cookies">9. Cookies and tracking</a></li>
            <li><a href="#p-unknown">10. What this document is missing</a></li>
          </ol>
        </nav>
      </header>

      {/* --- 1 ----------------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="p-short">
        <h2 id="p-short">1. The short version</h2>
        <ul className="info-list">
          <li>
            Card details never reach Slotfill's servers. The payment
            processor's own form takes them.
          </li>
          <li>
            Customers have no account. A booking is held together by a secret
            link, and that link is the whole of a customer's identity here.
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
            <dt>Your name, phone number and email address</dt>
            <dd>
              So the business knows who is expecting them, and so the booking
              can be found again. The phone number is also what ties your
              bookings together across different businesses, which is what
              makes a single deletion request able to reach all of them.
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
            <dt>Your messages, and photographs of the job</dt>
            <dd>
              So the two of you can talk, and so a dispute can be settled on
              pictures rather than on two accounts of the same afternoon.
              Contact details typed into a message are removed before it is
              stored. Location metadata is stripped out of every photograph on
              the way in.
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
            <dt>
              A licence number and state, an insurer and policy number, and the
              name a background check was run against
            </dt>
            <dd>
              Only if you enter them. None of it is verified by Slotfill, and
              the pages that show it say so.
            </dd>
          </div>
          <div className="info-def">
            <dt>Where your van is, while you are sharing it</dt>
            <dd>
              Only with location sharing switched on. The live position is held
              in memory rather than written to the database as a trail, and a
              customer sees it rounded to about 110 metres, only around the
              appointment they booked. There is no route history and no way for
              anybody to follow you around a day.
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
          Card numbers, expiry dates and security codes are typed into the
          payment processor's own form and never reach Slotfill's servers. What
          comes back and is stored is the processor's reference — an opaque
          string that a later charge can be made against and that is not a card
          number.
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
            authority over that booking, by design, because there is no account
            to sign in to.
          </li>
          <li>
            <strong>Somebody at Slotfill reviewing a dispute.</strong> A
            no-show report or a payment dispute is decided by a person, who can
            read what the report is about. Every one of those reads is recorded
            — who, what, when, and which record — and the record identifies a
            customer by a hash of their phone number rather than by the number,
            so the audit trail cannot become a second copy of the thing it is
            about.
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
            <strong>The payment processor.</strong> Takes card details directly
            and holds them under its own policy.
          </li>
          <li>
            <strong>Cloudflare.</strong> Runs the site, stores the database and
            the photographs, and provides the bot check on the public forms.
          </li>
          <li>
            <strong>OpenFreeMap and OpenStreetMap.</strong> Map tiles. Loading a
            map means your browser fetching tiles from them.
          </li>
          <li>
            <strong>Google Fonts, and a public code CDN.</strong> The typefaces
            and the map library are fetched from them by your browser.
          </li>
          <li>
            <strong>Your browser's push service, and an email provider.</strong>{' '}
            Only if you asked for alerts, or are a business receiving a sign-in
            link.
          </li>
        </ul>
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
          The 180 days on a finished job's conversation is set by the longest
          thing that can still arrive: a card chargeback. Deleting it sooner
          would leave a business unable to show what was agreed at the moment it
          most needs to.
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
        <h2 id="p-delete">7. Deleting your data</h2>

        <h3>If you booked something</h3>
        <p>
          Open your booking from the link you were sent and scroll to the
          bottom. <strong>Delete my data</strong> is there. You do not have to
          ask anybody and nobody has to approve it. Because your bookings are
          tied together by your phone number, it reaches every business you have
          booked with through this site, not just the one whose link you are
          holding.
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
        <p className="note">
          There is no undo, no grace period and no copy kept in case you change
          your mind, and the link stops working the moment it is done.
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
      </section>

      {/* --- 8 ----------------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="p-ca">
        <h2 id="p-ca">8. If you are in California</h2>
        <p>
          California gives residents specific rights over personal information.
          Here is how each one lands on this product.
        </p>
        <ul className="info-list">
          <li>
            <strong>To know what is held.</strong> Section 2 is that list, in
            full, by category and purpose. There is no further category held
            back.
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
            <strong>To limit the use of sensitive information.</strong> No
            sensitive categories are collected — no government identifiers, no
            financial account numbers, no health, biometric, racial, religious
            or union information, and no precise location beyond the address of
            a job you booked and, for a business, the van position it chose to
            share.
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
          by being signed in. Neither of those requires anybody at Slotfill to
          check a document.
        </p>
      </section>

      {/* --- 9 ----------------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="p-cookies">
        <h2 id="p-cookies">9. Cookies and tracking</h2>
        <ul className="info-list">
          <li>
            <strong>One cookie, and only for businesses.</strong> Signing in
            sets a session cookie. It is HttpOnly, sent only over HTTPS,
            same-site, and it holds a session reference and nothing else. There
            is no cookie for customers at all.
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
        </ul>
        <p className="note">
          Because there is no tracking to consent to, there is no cookie banner
          on this site. That is the reason, not an oversight.
        </p>
      </section>

      {/* --- 10 ---------------------------------------------------------- */}
      <section className="info-sec" aria-labelledby="p-unknown">
        <h2 id="p-unknown">10. What this document is missing</h2>
        <p>
          Each square-bracketed value below is a placeholder, not a name.
          Nobody has supplied these, so they are left visibly blank:
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
          There is no privacy mailbox to write to yet. Everything described in
          section 7 can be done without one, which is deliberate: a deletion
          right that depends on somebody answering an email is a deletion right
          that fails quietly.
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
