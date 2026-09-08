import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api, type CustomerBooking, type CustomerSignedIn, type ErasureResult,
} from '../api';
import CodeSignIn from '../components/CodeSignIn';
import ConfirmDestructive from '../components/ConfirmDestructive';
import Crumbs from '../components/Crumbs';
import PublicPage from '../components/PublicPage';
import Turnstile, { type TurnstileHandle } from '../components/Turnstile';
import { ErrorNote, Spinner } from '../components/ui';
import { formatMoney, plural } from '../lib/format';
import { useBookingState, useCustomer } from '../lib/customer';
import { useDocumentTitle } from '../lib/title';
import '../styles-account.css';

/**
 * The customer's account, at /account.
 *
 * WHAT IT IS FOR, AND WHAT IT DELIBERATELY IS NOT. A customer signs up at the
 * moment they book and then does not think about the account again, so this is
 * the page for the four things that cannot be done from a booking link: signing
 * in on a new phone, seeing every booking at every business in one list, the
 * card, and getting rid of the account. It is not a dashboard. There is no
 * feed, no settings screen and no profile to fill in, because none of those
 * would be doing anything for the person reading them.
 *
 * THE GUEST LINK STILL DOES EVERYTHING ELSE. Reading a booking, messaging the
 * business, the start code, the van, cancelling and erasing all live on
 * /c/:token and none of them need this page or an account at all. What an
 * account buys is the one thing a link cannot: a customer who lost the email
 * gets their bookings back by proving the same number again.
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
  const [phone, setPhone] = useState('');
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
      const res = await api.verifyCustomerCode({
        phone: phone.trim(), code, country: 'US',
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
  }, [verifying, phone, code, refresh]);

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
                ? 'Your number, your name and your card are off this account and '
                  + 'every device signed in to it has been signed out. The '
                  + 'bookings themselves stay — an order is a record between you '
                  + 'and a business, and one side does not delete it alone. '
                  + 'Signing up again with the same number starts a new account.'
                : 'Your messages, photographs, addresses and contact details are '
                  + 'gone from every business you booked with using that number. '
                  + 'What is left is what was paid — an amount, a currency and a '
                  + 'date, with nothing on it that names you.'}
            </p>
          </header>
          {erased?.standing_retained && (
            <p className="acct-seam">
              One thing was deliberately kept: any suspension on record against
              that number. Erasing is not how one of those is cleared, or it
              would be the way round it.
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
    return (
      <PublicPage>
        <div className="acct">
          <Crumbs items={[{ label: 'Your account' }]} />
          <header className="acct-head">
            <h1>Your bookings</h1>
            <p className="acct-lede">
              Your account is your mobile number. Give it here and type the six
              digits we text back, and every booking you have made with that
              number is on this page — including the ones you made before there
              was an account.
            </p>
            <p className="acct-lede">
              You do not need this to open a booking you already have: the link
              in your confirmation still works on any phone, signed in or not.
            </p>
          </header>

          <section className="acct-sec" aria-labelledby="acct-in">
            <h2 id="acct-in">Sign in</h2>
            <CodeSignIn
              phone={phone} onPhone={setPhone}
              code={code} onCode={setCode}
              state={state}
              codeError={codeError}
              turnstileToken={() => captcha.current}
              onTokenSpent={() => { captcha.current = null; widget.current?.reset(); }}
            />
            {/* The bot check in front of the one button here that costs money
                to press — every code is a text message somebody pays for. Not
                drawn when no text can be sent at all: a challenge in front of a
                form that has no button is a puzzle set for nothing. */}
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

          <section className="acct-sec" aria-labelledby="acct-pro">
            <h2 id="acct-pro">Are you a business?</h2>
            <p>
              This page is for people who book. If you list your van here, your
              account is an email address instead —{' '}
              <Link to="/signin">sign in over there</Link>.
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
            {account.phone_e164 ?? 'this number'}. You stay signed in on this
            phone, so you will not be asked for a code again the next time you
            book.
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
            <p>
              Nothing yet. Every appointment you book with this number appears
              here, at every business you use.
            </p>
          )}
          {live.length > 0 && (
            <>
              {/* Counted from the rows this render fetched, and from nowhere
                  else. There is no total on the payload to quote instead. */}
              <p>
                {live.length} {plural(live.length, 'booking', 'bookings')}. Times
                are shown in your own time zone.
              </p>
              <ul className="acct-rows">
                {live.map((b) => (
                  <li className="acct-row" key={b.order_item_id}>
                    <span className="acct-row-top">
                      <strong>{b.business_name ?? 'A business that has since closed'}</strong>
                      <span className="acct-row-price">
                        {formatMoney(b.price_cents, b.currency)}
                      </span>
                    </span>
                    <span className="acct-row-when">{when(b.starts_at, b.ends_at)}</span>
                    <span className="acct-row-note">
                      {b.cancelled_at
                        ? `Cancelled by the ${b.cancelled_by === 'operator' ? 'business' : 'customer'}.`
                        : b.arrived_at ? 'The business marked itself as arrived.'
                        : 'Booked.'}
                      {b.start_code && !b.cancelled_at
                        && ` Your start code is ${b.start_code}.`}
                    </span>
                    {b.profile_slug && (
                      <span className="acct-row-note">
                        <Link to={`/p/${b.profile_slug}`}>See their page</Link>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              <p>
                To message a business, see the photographs or cancel, open that
                booking from the link in its confirmation. That link is the only
                copy there is — it is not stored here and cannot be reissued,
                which is what stops anybody else reaching your conversation.
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
            /* THE SEAM, described as what it is. There is deliberately no card
               number field here or anywhere else on this site: the processor's
               own element owns that box, the Worker refuses anything shaped
               like a card number, and drawing a dead form would say the
               opposite of both. */
            <p className="acct-seam">
              There is no card on this account, and there is nowhere on this
              site to add one yet. When payment is switched on, the card is
              typed into the payment provider's own box — it never reaches
              Slotfill — and what is kept here is the provider's reference to
              it, the brand and the last four digits.
            </p>
          )}
          <p>{cardSays ?? cardNote}</p>
        </section>

        <section className="acct-sec" aria-labelledby="acct-out">
          <h2 id="acct-out">Signing out and getting rid of this</h2>
          {leaveError && <p className="signup-error" role="alert">{leaveError}</p>}
          <p>
            Signing out ends this device's session and nothing else — the
            account, the bookings and the number all stay exactly as they are,
            and the same number signs back in.
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
                <li>Your mobile number, your first name and your email address.</li>
                <li>
                  The payment provider's reference to your card, if there is
                  ever one on here.
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
                  Any suspension on record against this number. Closing is not
                  how one of those is cleared: signing up again with the same
                  number lands back on it.
                </li>
              </ul>
            </div>
            <p style={{ margin: 0 }}>
              There is no undo and no grace period. Signing up again with the
              same number makes a new account with nothing in it.
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
              by your mobile number, so this removes your personal data from{' '}
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
                  Any suspension on record against this number, for the same
                  reason closing does not clear one.
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
