import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api, type CustomerBooking, type CustomerSignedIn, type CustomerThread,
  type CustomerThreadBusiness, type ErasureResult,
} from '../api';
import CodeSignIn from '../components/CodeSignIn';
import ConfirmDestructive from '../components/ConfirmDestructive';
import Crumbs from '../components/Crumbs';
import PublicPage from '../components/PublicPage';
import Turnstile, { type TurnstileHandle } from '../components/Turnstile';
import { ErrorNote, Spinner } from '../components/ui';
import { formatMoney, plural } from '../lib/format';
import { bookingMoney } from '../lib/money';
import { useBookingState, useCustomer } from '../lib/customer';
import { useDocumentTitle } from '../lib/title';
import '../styles-account.css';

/**
 * The customer's account, at /account.
 *
 * WHAT IT IS FOR, AND WHAT IT DELIBERATELY IS NOT. A customer signs up at the
 * moment they book and then does not think about the account again, so this is
 * the page for the things that cannot be done from a booking link: signing in
 * on a new phone, seeing every booking at every business in one list, seeing
 * every conversation in another, the card, and getting rid of the account. It
 * is not a dashboard. There is no feed, no settings screen and no profile to
 * fill in, because none of those would be doing anything for the person
 * reading them.
 *
 * THE CONVERSATIONS LIST IS THE NEWEST OF THOSE AND THE MOST OVERDUE. Until
 * migration 0052 this page listed bookings and then told the reader, in as
 * many words, that to message the business or see the photographs they had to
 * open the link in their confirmation — "that link is the only copy there is".
 * Which was a true sentence about the link and a dead end for the reader,
 * printed on the one page somebody reaches precisely because they have lost
 * it. Only a fingerprint of a /c/:token is stored, deliberately, so nobody
 * here could hand one back. Now the conversation is listed like the booking
 * and opened on this account's own authority at /account/messages/:id.
 *
 * THE GUEST LINK STILL DOES ALL OF IT, TOO, and was not narrowed to make room.
 * Reading a booking, messaging the business, the start code, the van,
 * cancelling and erasing all work on /c/:token with no account and no sign-in,
 * which is what somebody has on a phone they have never signed in on and all
 * a guest has ever had. What an account buys is the thing a link cannot: a
 * customer who lost the confirmation gets both lists back by proving the same
 * address again.
 *
 * SIGNING IN IS THE SAME TWO FIELDS THE CHECKOUT USES — the same component,
 * with the same failure copy — because it is the same act. The only difference
 * is what the digits are spent on: there they go with the order, here they go
 * to the verify route.
 */

/** Times come off the row as epoch seconds and are printed in the reader's own zone. */
const when = (startS: number, endS: number): string => {
  const day = new Intl.DateTimeFormat(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  }).format(new Date(startS * 1000));
  const clock = (s: number) => new Intl.DateTimeFormat(undefined, {
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(s * 1000));
  return `${day}, ${clock(startS)}–${clock(endS)}`;
};

export default function Account() {
  useDocumentTitle('Your account');

  const { account, standing, cardNote, loading, refresh, clear } = useCustomer();
  const state = useBookingState();

  // --- signing in ----------------------------------------------------------
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  /** What the sign-in attached to this account, said once and only when it did. */
  const [claimed, setClaimed] = useState<CustomerSignedIn['claimed'] | null>(null);

  const captcha = useRef<string | null>(null);
  const widget = useRef<TurnstileHandle | null>(null);

  const verify = useCallback(async () => {
    if (verifying) return;
    setVerifying(true);
    setCodeError(null);
    try {
      // The address and the digits, and nothing else. A number is not asked for
      // here: this page is somebody coming back to an account that already
      // exists, and the Worker leaves a number already on the account alone.
      // Sending a blank one would be noise on every sign-in.
      const res = await api.verifyCustomerCode({
        email: email.trim(), code,
      });
      setClaimed(res.claimed);
      setCode('');
      await refresh();
    } catch (e) {
      // A wrong, expired, used or never-sent code all answer with one sentence
      // on purpose — see the Worker's BAD_CODE — so it is shown as it comes
      // back rather than guessed at here.
      setCodeError(e instanceof Error ? e.message
        : 'That code did not work. Ask for a new one.');
    } finally {
      setVerifying(false);
    }
  }, [verifying, email, code, refresh]);

  // --- the bookings --------------------------------------------------------
  const [bookings, setBookings] = useState<CustomerBooking[] | null>(null);
  const [bookingsError, setBookingsError] = useState<string | null>(null);

  const loadBookings = useCallback(async () => {
    setBookingsError(null);
    try {
      setBookings((await api.customerBookings()).bookings);
    } catch (e) {
      setBookingsError(e instanceof Error ? e.message : 'Could not read your bookings.');
    }
  }, []);

  // --- the conversations ---------------------------------------------------
  /**
   * Every conversation on this account, at every business.
   *
   * THE HALF THIS PAGE WAS MISSING, and the paragraph that used to sit under
   * the bookings list is the record of it: "to message a business, see the
   * photographs or cancel, open that booking from the link in its confirmation
   * — that link is the only copy there is." For anybody who had lost the link
   * that was the end of the road, and losing a link is an ordinary thing to
   * do. Migration 0052 put the account on the thread so that this list could
   * exist.
   *
   * A SEPARATE READ FROM THE BOOKINGS, deliberately, and not folded into one
   * payload. They are different lists of different things — a conversation
   * outlives the job and can exist with no booking behind it at all, which is
   * what an enquiry from a profile page is — and joining them server side
   * would mean a booking with two conversations or a conversation with two
   * bookings had to be flattened into rows that are neither. Two reads also
   * means the bookings list still draws when this one fails.
   */
  const [threads, setThreads] = useState<CustomerThread[] | null>(null);
  const [threadsError, setThreadsError] = useState<string | null>(null);
  /**
   * The narrowings, the page and the totals.
   *
   * WHY THIS SECTION GREW A FILTER BAR AT ALL. It shipped as "every
   * conversation on this account", unpaged, which is exactly right for the
   * person it was written for — somebody with one booking — and wrong for the
   * person it exists for. The owner's words: "customers will be messaging
   * multiple [businesses]". Five trades out is five rows that differ only by
   * which business is on them; two years of using this site is fifty, of which
   * the fiftieth was simply unreachable. And the one question a reader
   * actually has — has anybody answered me — was answerable only by opening
   * every row.
   *
   * `unread` and `businesses` come from the Worker rather than being counted
   * off the rows on screen, and that is the point of both: a total counted
   * from twenty-five rows is not a total, and a filter offering only the
   * businesses on this page could not offer the one whose conversation is the
   * reason somebody is paging.
   */
  const [threadCursor, setThreadCursor] = useState<string | null>(null);
  const [threadsUnread, setThreadsUnread] = useState(0);
  const [threadBusinesses, setThreadBusinesses] =
    useState<CustomerThreadBusiness[]>([]);
  const [threadBusiness, setThreadBusiness] = useState('');
  const [threadUnreadOnly, setThreadUnreadOnly] = useState(false);
  const [threadSearch, setThreadSearch] = useState('');
  const [threadQuery, setThreadQuery] = useState('');
  const [threadsPaging, setThreadsPaging] = useState(false);

  /**
   * A third of a second after the last keystroke, not on every one.
   *
   * The search reaches the text of the messages as well as the names, which on
   * the Worker's side is the one query behind this page that is not a plain
   * index seek. A request per character would be eight of them to type
   * "kitchen", seven for a prefix nobody wanted.
   */
  useEffect(() => {
    const timer = window.setTimeout(() => setThreadQuery(threadSearch.trim()), 350);
    return () => window.clearTimeout(timer);
  }, [threadSearch]);

  const loadThreads = useCallback(async () => {
    setThreadsError(null);
    try {
      const res = await api.customerThreads({
        unreadOnly: threadUnreadOnly,
        business: threadBusiness || null,
        q: threadQuery,
      });
      setThreads(res.threads);
      setThreadCursor(res.next_cursor);
      setThreadsUnread(res.unread);
      setThreadBusinesses(res.businesses);
    } catch (e) {
      setThreadsError(e instanceof Error ? e.message
        : 'Could not read your conversations.');
    }
  }, [threadUnreadOnly, threadBusiness, threadQuery]);

  /**
   * The next page, appended.
   *
   * Keyset and not a page number, for the reason the operator's inbox gives at
   * length: this list MOVES while it is being read, because a business
   * replying bumps that conversation to the top. With an offset, a
   * conversation jumping up while somebody was on page two would push a
   * different one across the boundary and that one would never be seen at all.
   *
   * De-duplicated on id anyway. The ordering is read in two segments — unread
   * first — so a conversation the reader opened in another tab between two
   * pages could otherwise arrive in both and be drawn twice.
   */
  const moreThreads = useCallback(async () => {
    if (!threadCursor || threadsPaging) return;
    setThreadsPaging(true);
    try {
      const res = await api.customerThreads({
        unreadOnly: threadUnreadOnly,
        business: threadBusiness || null,
        q: threadQuery,
        cursor: threadCursor,
      });
      setThreads((rows) => {
        const have = new Set((rows ?? []).map((r) => r.id));
        return [...(rows ?? []), ...res.threads.filter((r) => !have.has(r.id))];
      });
      setThreadCursor(res.next_cursor);
    } catch (e) {
      setThreadsError(e instanceof Error ? e.message : 'Could not load any more.');
    } finally {
      setThreadsPaging(false);
    }
  }, [threadCursor, threadsPaging, threadUnreadOnly, threadBusiness, threadQuery]);

  // --- the card ------------------------------------------------------------
  const [card, setCard] = useState<
    { payment_brand: string | null; payment_last4: string | null } | null>(null);
  /** The Worker's own sentence about what the card is for. Never written here. */
  const [cardSays, setCardSays] = useState<string | null>(null);

  const loadCard = useCallback(async () => {
    try {
      const res = await api.customerCard();
      setCard(res.card);
      setCardSays(res.note);
    } catch { /* the account panel still stands; the card line is simply absent */ }
  }, []);

  useEffect(() => {
    if (!account) { setBookings(null); setCard(null); return; }
    void loadBookings();
    void loadCard();
  }, [account, loadBookings, loadCard]);

  /**
   * The conversations, on their own effect rather than with the two above.
   *
   * loadThreads changes whenever a filter or the search box does, and the
   * three reads used to share one effect keyed on all of them — so typing a
   * letter in the search box re-fetched the bookings and the saved card as
   * well, three requests where one was wanted, on a page a phone may be
   * loading over a bad connection. Separate effects because they now have
   * genuinely different reasons to run.
   */
  useEffect(() => {
    if (!account) { setThreads(null); setThreadCursor(null); return; }
    void loadThreads();
  }, [account, loadThreads]);

  // --- leaving -------------------------------------------------------------
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [erasing, setErasing] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [gone, setGone] = useState<'closed' | 'erased' | null>(null);
  const [erased, setErased] = useState<ErasureResult | null>(null);

  const signOut = useCallback(async () => {
    setBusy(true);
    try { await api.customerLogout(); } catch { /* the cookie is dropped below anyway */ }
    clear();
    setBusy(false);
  }, [clear]);

  async function closeAccount() {
    setBusy(true); setLeaveError(null);
    try {
      await api.closeCustomerAccount();
      // The Worker revoked every session and cleared the cookie on its own
      // success response, so there is nothing left to sign out of — only the
      // local copy React is holding.
      clear();
      setClosing(false);
      setGone('closed');
    } catch (e) {
      setLeaveError(e instanceof Error ? e.message
        : 'That did not go through. The account is still open.');
    } finally {
      setBusy(false);
    }
  }

  async function eraseAccount() {
    setBusy(true); setLeaveError(null);
    try {
      setErased(await api.eraseCustomerAccount());
      clear();
      setErasing(false);
      setGone('erased');
    } catch (e) {
      setLeaveError(e instanceof Error ? e.message
        : 'That did not go through. Nothing has been deleted.');
    } finally {
      setBusy(false);
    }
  }

  // ---------------------------------------------------------------------
  if (loading) {
    return <PublicPage><Spinner label="Opening your account" /></PublicPage>;
  }

  if (gone) {
    return (
      <PublicPage>
        <div className="acct">
          <Crumbs items={[{ label: 'Your account' }]} />
          <header className="acct-head">
            <h1>{gone === 'closed' ? 'This account is closed' : 'Your data is deleted'}</h1>
            <p className="acct-lede">
              {gone === 'closed'
                ? 'Your address, your number, your name and your card are off '
                  + 'this account and every device signed in to it has been '
                  + 'signed out. The bookings themselves stay — an order is a '
                  + 'record between you and a business, and one side does not '
                  + 'delete it alone. Signing up again with the same email '
                  + 'address starts a new account.'
                : 'Your messages, photographs, addresses and contact details are '
                  + 'gone from every business you booked with using that email '
                  + 'address. What is left is what was paid — an amount, a '
                  + 'currency and a date, with nothing on it that names you.'}
            </p>
          </header>
          {erased?.standing_retained && (
            <p className="acct-seam">
              One thing was deliberately kept: any suspension on record against
              that email address. Erasing is not how one of those is cleared, or
              it would be the way round it.
            </p>
          )}
          <div className="acct-do">
            <Link className="btn" to="/">See what is open</Link>
          </div>
        </div>
      </PublicPage>
    );
  }

  // --- signed out ----------------------------------------------------------
  if (!account) {
    /**
     * WHETHER ANYBODY CAN SIGN IN HERE AT ALL, decided before a single word of
     * the page is written.
     *
     * `sms_ready` is the Worker's answer to "can a sign-in code be delivered",
     * and since migration 0038 it asks that of the EMAIL provider — the name is
     * a leftover and is kept because both trees read it. False means the code
     * endpoint answers 503, so no account can be created and no existing one
     * can be opened. That is not a detail to leave to the form to discover —
     * the sentence this page led with promised "type the six digits we send
     * back" above a form that cannot send anybody anything, and a promise broken
     * two inches lower down is worse than no promise at all.
     *
     * Null is deliberately not treated as a no. It means the question has not
     * been answered — still in flight, or the request failed — and refusing to
     * draw a working sign-in over a failed GET would lock somebody out of an
     * account that works. Null gets the ordinary page and lets the Worker have
     * the last word.
     */
    const smsOff = state !== null && !state.sms_ready;

    return (
      <PublicPage>
        <div className="acct">
          <Crumbs items={[{ label: 'Your account' }]} />
          <header className="acct-head">
            <h1>Your bookings</h1>
            <p className="acct-lede">
              Every appointment you have booked here, at every business, in one
              list. Your account is your email address: there is no password to
              choose and none to remember.
            </p>
          </header>

          {smsOff && (
            /*
              Said first, in the Worker's own words, and with nothing to press.
              The wording after it is ours and it is the part that matters: a
              refusal that does not say what still works reads as the site
              being broken, and the guest link genuinely is not affected by
              any of this — it never needed an account.
            */
            <div className="signup-blocked" role="status">
              <strong>Signing in is not working yet.</strong>{' '}
              {state?.sms_note ?? 'No email can be sent from this site at the '
                + 'moment, so no code can reach you.'}{' '}
              Nothing below will work until that is fixed, and there is no way
              round it — a code is the whole of signing in. If you already have
              a booking, the link in its confirmation still opens it; that link
              never needed an account.
            </div>
          )}

          {/*
            WHAT THIS PAGE IS FOR, above the form rather than below it.

            Somebody standing on a signed-out page is being asked for an email
            address by a site they may have arrived at ten seconds ago. The
            question in their head is "what do I get, and what happens to the
            address" — and until this existed the page answered neither, opening
            instead with the mechanics of the code. The list is short and every
            line is a thing this page actually does today; there is nothing in
            it about offers, saved searches or a profile, because none of those
            exist and a value list padded with intentions is a lie with bullet
            points.
          */}
          <section className="acct-sec" aria-labelledby="acct-why">
            <h2 id="acct-why">What an account is for</h2>
            <ul className="acct-list">
              <li>
                <strong>Every booking in one place.</strong> Bookings are tied
                together by your email address, so one list covers every
                business you have used — including anything booked before the
                account existed.
              </li>
              <li>
                <strong>Getting back in on a new phone.</strong> Prove the same
                address and your bookings come back. This is the one thing a
                confirmation link cannot do for you.
              </li>
              <li>
                <strong>Booking without typing it all again.</strong> Once this
                phone is signed in it stays signed in, so you are not asked for
                a code every time.
              </li>
              <li>
                <strong>Leaving.</strong> Closing the account, and deleting
                what every business you booked with holds about you, are both
                buttons on this page once you are in.
              </li>
            </ul>
            <p>
              You do not need any of this to open a booking you already have.
              The link in your confirmation works on any phone, signed in or
              not, and it is the only place messages, photographs, the start
              code and cancelling live.
            </p>
          </section>

          <section className="acct-sec" aria-labelledby="acct-in">
            <h2 id="acct-in">Sign in</h2>
            <CodeSignIn
              email={email} onEmail={setEmail}
              code={code} onCode={setCode}
              state={state}
              codeError={codeError}
              turnstileToken={() => captcha.current}
              onTokenSpent={() => { captcha.current = null; widget.current?.reset(); }}
            />
            {/* The bot check in front of the one button here that spends
                something — every code is one of the hundred emails a day this
                deployment can send, shared with the businesses' own sign-in
                links. Not drawn when no code can be sent at all: a challenge in
                front of a form that has no button is a puzzle set for nothing. */}
            {(!state || state.sms_ready) && (
              <Turnstile ref={widget} action="customer-signin"
                onToken={(t) => { captcha.current = t; }} />
            )}
            {code.length > 0 && (
              <div className="acct-do">
                <button className="btn" type="button" disabled={verifying}
                  onClick={() => void verify()}>
                  {verifying ? 'Checking…' : 'Sign in'}
                </button>
              </div>
            )}
          </section>

          {/*
            The equivalent of the "forgot your password" link every other
            sign-in page carries, and the answers are different here because
            the failure modes are: there is no password to forget, so the ways
            this goes wrong are a code that did not arrive, an address that is
            not the one you booked with, and — today — a site that cannot send
            one at all. Drawn only while signing in is actually possible; under
            the refusal above it would be advice for a form nobody can use.
          */}
          {!smsOff && (
            <section className="acct-sec" aria-labelledby="acct-help">
              <h2 id="acct-help">If the code does not arrive</h2>
              <p>
                Give it a minute, then look in your spam or junk folder — that
                is where a first email from a site you have not written to
                before often lands. After that, ask for another: the newest
                email is always the one that works, and asking again kills the
                code before it.
              </p>
              <p>
                If nothing arrives at all, check the address is the one you
                booked with. Bookings hang off the address that made them, so a
                second address is a second, empty account rather than a way in
                to the first.
              </p>
            </section>
          )}

          <section className="acct-sec" aria-labelledby="acct-pro">
            <h2 id="acct-pro">Are you a business?</h2>
            <p>
              This page is for people who book. Both sides sign in with an email
              address, but they are separate accounts and separate doors: if you
              list your van here,{' '}
              <Link to="/signin">sign in over there</Link> — that one emails you
              a link rather than a code. If you have not listed yet,{' '}
              <Link to="/join">start here</Link>.
            </p>
          </section>
        </div>
      </PublicPage>
    );
  }

  // --- signed in -----------------------------------------------------------
  const live = bookings ?? [];
  return (
    <PublicPage>
      <div className="acct">
        <Crumbs items={[{ label: 'Your account' }]} />

        <header className="acct-head">
          <h1>Your account</h1>
          <p className="acct-lede">
            {account.first_name ? `${account.first_name} · ` : ''}
            {account.email ?? 'this address'}. You stay signed in on this phone,
            so you will not be asked for a code again the next time you book.
          </p>
          {claimed && claimed.orders > 0 && (
            <p className="acct-lede">
              {claimed.orders} {plural(claimed.orders, 'booking', 'bookings')} you
              made before this account existed {plural(claimed.orders, 'has', 'have')}{' '}
              been attached to it.
            </p>
          )}
          {standing?.blocked && standing.message && (
            <p className="signup-blocked">{standing.message}</p>
          )}
        </header>

        <section className="acct-sec" aria-labelledby="acct-bk">
          <h2 id="acct-bk">Your bookings</h2>
          {bookingsError && <ErrorNote error={bookingsError} onRetry={loadBookings} />}
          {!bookings && !bookingsError && <Spinner label="Reading your bookings" />}
          {bookings && live.length === 0 && (
            /*
              THE SCREEN ALMOST EVERYBODY WHO SIGNS IN TODAY SEES, and until
              now it was one grey sentence with nothing to press.

              A list with nothing in it is not an error and must not be dressed
              as one, but it is also not finished at "nothing yet": the reader
              has just proved an email address to reach a page that is blank,
              and the only useful thing this page can do is say plainly why, and
              point at the two things that genuinely change it.

              It gives the same two answers the search page gives — look at
              what is open, or set a standing alert — because they are the same
              two answers. There is no third. What it deliberately does not do
              is apologise, promise that bookings are coming, or estimate when:
              nobody here can honestly say either.
            */
            <div className="acct-none">
              <h3>No bookings on this account yet</h3>
              <p>
                Every appointment you book with this address lands here, at
                every business you use — including anything you booked before
                this account existed. There is nothing under it because this
                address has not booked anything.
              </p>
              <p>
                Everything on this site is an hour a business has lost to a
                cancellation, so what is available changes through the day.
                Have a look at what is open now, or say what you want and be
                told when it comes up.
              </p>
              <div className="acct-do">
                <Link className="btn" to="/">See what is open now</Link>
                <Link className="btn quiet" to="/a">Set up an alert</Link>
              </div>
            </div>
          )}
          {live.length > 0 && (
            <>
              {/* Counted from the rows this render fetched, and from nowhere
                  else. There is no total on the payload to quote instead. */}
              <p>
                {live.length} {plural(live.length, 'booking', 'bookings')}. Times
                are shown in your own time zone, and each one says where its
                money is.
              </p>
              <ul className="acct-rows">
                {live.map((b) => {
                  /*
                    THE PART OF THIS ROW THAT IS ABOUT MONEY, and the reason it
                    is not written inline here.

                    A customer cannot tell "you are owed $240" from "your $240
                    went back on Tuesday" by looking at a booking marked
                    cancelled, and for a long time that was the whole of what
                    this row said — who cancelled, and nothing at all about the
                    payment. The sentence comes from lib/money.ts so that this
                    page and the conversation page cannot come to describe the
                    same refund differently.
                  */
                  const paid = bookingMoney(b);
                  return (
                    <li className="acct-row" key={b.order_item_id}>
                      <span className="acct-row-top">
                        <strong>{b.business_name ?? 'A business that has since closed'}</strong>
                        <span className="acct-row-price">
                          {formatMoney(b.price_cents, b.currency)}
                        </span>
                      </span>
                      <span className="acct-row-when">{when(b.starts_at, b.ends_at)}</span>
                      {/* Only while the booking is live. This line used to open
                          "Cancelled by the business", which the money sentence
                          below now says properly and with the refund attached —
                          and a row that states the cancellation twice, once
                          bare and once with the money, reads as two different
                          cancellations. */}
                      {!b.cancelled_at && (
                        <span className="acct-row-note">
                          {b.arrived_at
                            ? 'The business marked itself as arrived.'
                            : 'Booked.'}
                          {b.start_code && ` Your start code is ${b.start_code}.`}
                        </span>
                      )}
                      <span className={`acct-money acct-money-${paid.tone}`}>
                        <span className="acct-money-label">{paid.label}</span>
                        <span className="acct-money-says">{paid.says}</span>
                        {paid.parts && <span className="acct-money-says">{paid.parts}</span>}
                      </span>
                      {b.profile_slug && (
                        <span className="acct-row-note">
                          <Link to={`/p/${b.profile_slug}`}>See their page</Link>
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
              {/*
                WHAT THIS PARAGRAPH USED TO SAY, AND WHY IT HAD TO GO.

                "To message a business, see the photographs or cancel, open
                that booking from the link in its confirmation. That link is
                the only copy there is." Every word of the second sentence was
                true about the LINK and false about the conversation from the
                moment a customer account existed — and it was printed on the
                one page a person reaches precisely because they have lost the
                link. It sent them away from the answer.

                It now points at the list below it, which is the answer, and it
                keeps the one part of the old sentence that is still a fact and
                still worth saying: the link itself cannot be reissued, because
                only a fingerprint of it is stored, and that is deliberate
                rather than a limitation to apologise for.
              */}
              <p>
                To message a business, see the photographs, pay for a booking
                nobody has charged you for or cancel, open the conversation for
                it under <a href="#acct-msg">your conversations</a> below — or
                the link in its confirmation, which works on any phone whether
                or not you are signed in. The link cannot be reissued if you
                lose it: only a fingerprint of it is stored, which is what stops
                anybody else opening your conversation. That is what this list
                is for.
              </p>
            </>
          )}
        </section>

        {/*
          THE SECTION THAT ANSWERS THE QUESTION THIS PAGE EXISTS TO ANSWER.

          "There has to be a way for a business and client to be able to
          continue a conversation to stay easily available without needing to
          keep a link." Until migration 0052 there was not one. A customer's
          conversation lived behind a /c/:token link and nowhere else, only a
          fingerprint of that token is stored on purpose, and so the site was
          genuinely unable to give anybody their own conversation back. This is
          it, and it is the same shape the business's own inbox at
          /app/messages has always had: scoped by whose it is, in the WHERE
          clause, rather than filtered afterwards.

          DIRECTLY UNDER THE BOOKINGS AND ABOVE THE CARD, because that is the
          order somebody needs them in: they came here looking for a booking,
          and the thing they actually want to do with it — ask when, send a
          photograph, finish paying — is in the conversation.
        */}
        <section className="acct-sec" aria-labelledby="acct-msg">
          <h2 id="acct-msg">Your conversations</h2>

          {/*
            WHICH BUSINESS, AND WHAT WAS SAID.

            Drawn only once there is more than one business to choose between,
            because a filter with one option in it is furniture. The reason
            this exists at all is the shape of this list rather than its
            length: an operator's inbox is many different people writing to one
            business, so a name tells the rows apart, and this list is the
            other way round — somebody who has had five trades out has five
            rows differing only by who is on them.

            "Only the ones waiting on me" is the other question, and it is the
            one a reader opens this page with: which of the five has answered.
            The count beside it is the whole account's, not this page's.
          */}
          {threads && threadBusinesses.length > 1 && (
            <div className="acct-msg-filters">
              <label>
                <span className="sr-only">Which business</span>
                <select value={threadBusiness}
                  onChange={(e) => setThreadBusiness(e.target.value)}>
                  <option value="">Every business</option>
                  {threadBusinesses.map((b) => (
                    <option key={b.operator_id} value={b.operator_id}>
                      {b.business_name || 'A business that has since closed'}
                      {b.threads > 1 ? ` (${b.threads})` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="acct-msg-search">
                <span className="sr-only">Search your conversations</span>
                <input type="search" value={threadSearch}
                  placeholder="Search business or message"
                  onChange={(e) => setThreadSearch(e.target.value)} />
              </label>
              {/* The pressed state is drawn off aria-pressed rather than off a
                  class of its own, so the thing a screen reader is told and
                  the thing an eye sees are the same one attribute and cannot
                  disagree. See .acct-msg-filters in styles-account.css. */}
              <button type="button" className="btn quiet sm"
                aria-pressed={threadUnreadOnly}
                onClick={() => setThreadUnreadOnly((v) => !v)}>
                {threadsUnread > 0 ? `Unread (${threadsUnread})` : 'Unread'}
              </button>
            </div>
          )}

          {threadsError && <ErrorNote error={threadsError} onRetry={loadThreads} />}
          {!threads && !threadsError && <Spinner label="Reading your conversations" />}
          {threads && threads.length === 0 && (threadQuery !== '' || threadUnreadOnly
            || threadBusiness !== '') && (
            /*
              Empty because of a filter, which is a completely different
              sentence from having no conversations. The paragraph below is
              about somebody whose messages are only on their links, and
              printing it to somebody who has simply typed a word that matches
              nothing would tell them their conversations are gone.
            */
            <div className="acct-none">
              <h3>Nothing matches</h3>
              <p>
                {threadUnreadOnly && threadQuery === '' && threadBusiness === ''
                  ? 'Nobody is waiting on you — you have read everything every '
                    + 'business has sent you.'
                  : 'No conversation here matches that. The search looks at the '
                    + 'business, what the conversation was about and the '
                    + 'messages themselves.'}
              </p>
              <button type="button" className="btn quiet sm" onClick={() => {
                setThreadBusiness(''); setThreadUnreadOnly(false);
                setThreadSearch(''); setThreadQuery('');
              }}>Show all my conversations</button>
            </div>
          )}
          {threads && threads.length === 0 && threadQuery === '' && !threadUnreadOnly
            && threadBusiness === '' && (
            /*
              Empty, and it is not an error. Two genuinely different people see
              this: somebody with no bookings at all, and — the case worth
              wording carefully — somebody whose bookings predate this being
              recorded and whose conversations are therefore still only on their
              links. Saying "you have no conversations" flatly to the second
              would be telling them their messages are gone. They are not.
            */
            <div className="acct-none">
              <h3>No conversations on this account yet</h3>
              <p>
                Every conversation you have with a business here is listed on
                this page, so you can pick it up again without keeping a link.
                {live.length > 0
                  ? ' The bookings above were made before conversations were '
                    + 'recorded against an account, so theirs are still only '
                    + 'reachable from the link in each confirmation.'
                  : ' There is nothing here because this address has not '
                    + 'messaged anybody yet.'}
              </p>
            </div>
          )}
          {threads && threads.length > 0 && (
            <>
              <p>
                {/*
                  THE COUNT USED TO CLAIM TO BE THE TOTAL AND IS NOW HONEST
                  ABOUT BEING A PAGE. It said "{threads.length}
                  conversations" full stop, which was true while the list was
                  every row on the account and became a lie the moment the
                  list was paged: "25 conversations" to somebody who has had
                  forty. So it only states a total when this page IS all of
                  them — next_cursor null — and otherwise counts what is on
                  screen and says there is more.

                  The unread line comes before either, because it is the
                  reason somebody opened this page: which of the businesses
                  they are waiting on has answered. It is the whole account's
                  number, not this page's, so it stays right while somebody
                  searches or filters.
                */}
                {threadsUnread > 0 && (
                  <><strong>
                    {threadsUnread === 1
                      ? '1 conversation has something new in it.'
                      : `${threadsUnread} conversations have something new in them.`}
                  </strong>{' '}</>
                )}
                {threadCursor
                  ? `${threads.length} shown, and there are more below.`
                  : `${threads.length} ${plural(threads.length, 'conversation', 'conversations')}.`}
                {' '}Open one to read it, reply, send a photograph or deal with
                the money on it — no link needed.
              </p>
              <ul className="acct-rows">
                {threads.map((t) => (
                  <li className="acct-row" key={t.id}>
                    <span className="acct-row-top">
                      {/*
                        THE LINK IS THE WHOLE POINT OF THE ROW, so it is the
                        business's name rather than a "view" button off to one
                        side: the name is what somebody is looking for and it
                        is the biggest thing to press on a phone.

                        The id goes in the path and the session cookie is the
                        authority. An id belonging to another account answers
                        404 in the same words a made-up one gets, so this is
                        not a secret in a URL the way a /c/:token is.
                      */}
                      <strong>
                        <Link to={`/account/messages/${t.id}`}>
                          {t.business_name || 'A business that has since closed'}
                        </Link>
                      </strong>
                      {/* Unread messages waiting for THIS reader. Drawn only
                          when there are some: a "0" on every row is noise, and
                          the one thing this list has to do at a glance is say
                          which conversation somebody is being waited on in. */}
                      {t.guest_unread > 0 && (
                        <span className="acct-row-price">
                          {t.guest_unread} new
                        </span>
                      )}
                    </span>
                    {/* The subject is what the conversation was opened about —
                        the services booked, or "Quote request". Null on an old
                        thread, and then the row simply has one line fewer
                        rather than a made-up one. */}
                    {t.subject && (
                      <span className="acct-row-when">{t.subject}</span>
                    )}
                    <span className="acct-row-note">
                      {/* Times in the reader's own zone, the same as the
                          bookings above, using the same helper so one page
                          cannot print two different hours for one job. */}
                      {t.starts_at != null && t.ends_at != null
                        ? `Booked for ${when(t.starts_at, t.ends_at)}.`
                        : 'A question, with no booking on it.'}
                      {/*
                        CLOSED IS SAID ON THE ROW AND THE ROW STAYS.

                        There is now a button on the business's side that sets
                        this — until it landed, threads.status was a column
                        nothing had ever written, so this sentence was
                        unreachable. The temptation once it exists is to drop
                        closed conversations out of this list the way the
                        operator's own inbox does, and that would be the worst
                        thing this page could do: a business closing a
                        conversation would make it VANISH off the customer's
                        account, with the messages agreeing what the work was,
                        the photographs and the price they paid. Nobody told
                        them, and they did nothing. So it is listed, it still
                        opens, and the row says who closed it.
                      */}
                      {t.status === 'closed'
                        && ' The business has closed this conversation; you can still read it.'}
                    </span>
                    {t.profile_slug && (
                      <span className="acct-row-note">
                        <Link to={`/p/${t.profile_slug}`}>See their page</Link>
                      </span>
                    )}
                  </li>
                ))}
              </ul>

              {/*
                THE END OF THE LIST, SAID ONE WAY OR THE OTHER, NEVER SILENCE.

                This list used to hand back every row on the account with no
                cursor at all, which meant it could not say anything about its
                own end because it had no end to speak of. Paged, the thing
                that must not happen is a list that simply stops: somebody with
                forty conversations seeing twenty-five and no indication that
                the other fifteen exist is back in the dead end migration 0052
                was written to close, by a different route.
              */}
              {threadCursor && (
                <button type="button" className="btn quiet sm acct-msg-more"
                  disabled={threadsPaging} onClick={() => { void moreThreads(); }}>
                  {threadsPaging ? 'Loading…' : 'Show more conversations'}
                </button>
              )}

              <p>
                A conversation that started as a question before you had an
                account is not on this list, and cannot be put on it: there is
                nothing tying an anonymous message to a person, and guessing
                would mean handing somebody else's conversation to whoever
                guessed closest. Those stay on their own link.
              </p>
            </>
          )}
        </section>

        <section className="acct-sec" aria-labelledby="acct-card">
          <h2 id="acct-card">Your card</h2>
          {card ? (
            <p>
              {card.payment_brand ?? 'A card'}
              {card.payment_last4 ? ` ending ${card.payment_last4}` : ''} is on
              this account.
            </p>
          ) : (
            /* WHERE THE CARD IS ADDED, AND WHY NOT HERE. This paragraph used
               to say there was nowhere on the site to add a card. There is:
               the booking screen, where the payment provider's own embedded
               box takes the number. That box is not drawn on this page on
               purpose — there is no card number field here or anywhere outside
               that form, the Worker refuses anything shaped like a card
               number, and a second place to type one would be a second place
               to get it wrong. */
            <p className="acct-seam">
              There is no card on this account. A card is required to book, and
              it is added on the booking screen, in the payment provider's own
              box — the number never reaches Round The Way. What is kept here is
              the provider's reference to it, the brand and the last four
              digits.
            </p>
          )}
          <p>{cardSays ?? cardNote}</p>
        </section>

        <section className="acct-sec" aria-labelledby="acct-out">
          <h2 id="acct-out">Signing out and getting rid of this</h2>
          {leaveError && <p className="signup-error" role="alert">{leaveError}</p>}
          <p>
            Signing out ends this device's session and nothing else — the
            account, the bookings and the address all stay exactly as they are,
            and the same address signs back in.
          </p>
          <div className="acct-do">
            <button className="btn quiet" type="button" disabled={busy}
              onClick={() => void signOut()}>
              Sign out on this phone
            </button>
            <button className="btn quiet" type="button" disabled={busy}
              onClick={() => { setLeaveError(null); setClosing(true); }}>
              Close this account
            </button>
            <button className="btn quiet" type="button" disabled={busy}
              onClick={() => { setLeaveError(null); setErasing(true); }}>
              Delete my data
            </button>
          </div>
          <p>
            The two are different and the difference matters. Closing empties
            the account and leaves the bookings; deleting removes what every
            business you have used holds about you. Each one says exactly what
            it does before it runs, and neither can be undone.
          </p>
        </section>

        {closing && (
          <ConfirmDestructive
            title="Close this account"
            word="CLOSE"
            confirmLabel="Close it and empty my details"
            busy={busy}
            error={leaveError}
            onConfirm={() => void closeAccount()}
            onClose={() => { if (!busy) { setClosing(false); setLeaveError(null); } }}
          >
            <div className="stack" style={{ gap: 6 }}>
              <strong>Emptied off this account</strong>
              <ul className="erase-list">
                <li>
                  Your email address, which is the account itself, along with
                  your mobile number and your first name.
                </li>
                <li>
                  The payment provider's reference to your card, if there is
                  one on here.
                </li>
                <li>
                  Every device signed in to this account, including this one.
                </li>
              </ul>
            </div>
            <div className="stack" style={{ gap: 6 }}>
              <strong>Kept</strong>
              <ul className="erase-list">
                <li>
                  Your bookings, and the conversations attached to them. An
                  order is a record of something that happened between two
                  people, and one of them does not delete it on their own —
                  “Delete my data” is the request that removes those.
                </li>
                <li>
                  Any suspension on record against this email address. Closing
                  is not how one of those is cleared: signing up again with the
                  same address lands back on it.
                </li>
              </ul>
            </div>
            <p style={{ margin: 0 }}>
              There is no undo and no grace period. Signing up again with the
              same address makes a new account with nothing in it.
            </p>
          </ConfirmDestructive>
        )}

        {erasing && (
          <ConfirmDestructive
            title="Delete your data"
            word="DELETE"
            confirmLabel="Delete my messages, photos and contact details"
            busy={busy}
            error={leaveError}
            onConfirm={() => void eraseAccount()}
            onClose={() => { if (!busy) { setErasing(false); setLeaveError(null); } }}
          >
            <p style={{ margin: 0 }}>
              This does not stop at one business. Your bookings are tied together
              by your email address, so this removes your personal data from{' '}
              <strong>every business you have booked with</strong> using it, and
              it takes this account with it.
            </p>
            <div className="stack" style={{ gap: 6 }}>
              <strong>Deleted, permanently</strong>
              <ul className="erase-list">
                <li>Every conversation you have had here, and every message in it.</li>
                <li>
                  The photographs taken on those jobs — including any you chose
                  to publish on a review.
                </li>
                <li>
                  Your name, number, email address, street address and map
                  position, from every booking and every request you made.
                </li>
                <li>
                  The customer record each business was given when you booked.
                </li>
              </ul>
            </div>
            <div className="stack" style={{ gap: 6 }}>
              <strong>Kept</strong>
              <ul className="erase-list">
                <li>
                  What was paid: an amount, a currency, a date and which
                  business it was with, with nothing on it that names you.
                </li>
                <li>
                  Reviews you left keep their rating and their words — other
                  customers rely on them — and the name on them becomes
                  “A customer”.
                </li>
                <li>
                  Any suspension on record against this email address, for the
                  same reason closing does not clear one.
                </li>
              </ul>
            </div>
            <p style={{ margin: 0 }}>
              There is no undo, no grace period and no copy kept in case you
              change your mind.
            </p>
          </ConfirmDestructive>
        )}
      </div>
    </PublicPage>
  );
}
