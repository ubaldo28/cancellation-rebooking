import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useSession } from '../App';
import ConfirmDestructive from './ConfirmDestructive';
import Sheet from './Sheet';

/**
 * "Close my account", in the operator's settings.
 *
 * The other end of the same promise the customer's erasure keeps. Until this
 * existed an operator could stop using the site and their email, phone number,
 * home address, licence number, insurance policy number, the name a background
 * check was run against and their vehicle's plate all stayed exactly where
 * they were, indefinitely, with no way for them to do anything about it.
 *
 * WHAT THE COPY IS ALLOWED TO SAY. Only what closeOperatorAccount in
 * src/lib/retention.ts does. The three groups below are the three groups in
 * that function: the operator's own columns, which are emptied; other people's
 * data that only existed because this account did, which is deleted; and the
 * settled financial and public records, which are kept describing a business
 * that no longer exists rather than a person.
 *
 * THE REFUSAL IS NOT AN ERROR TO PAPER OVER. The Worker answers 400
 * `live_bookings` while there is still work in the diary, and its message
 * already names the count and the reason — closing deletes the conversations,
 * so a customer with a booking would lose the thread, the address they gave,
 * the photographs and every way of reaching the business, and would find out
 * by nobody arriving. That sentence is shown as it comes back rather than
 * replaced with a shorter one that says less.
 */
export default function CloseAccount() {
  const { isDemo, clearSession } = useSession();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);

  async function close() {
    setBusy(true); setError(null);
    try {
      await api.closeAccount();
      setClosed(true);
    } catch (e) {
      setError(e instanceof Error ? e.message
        : 'That did not go through. The account is still open.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Leaves for the front page, and drops the local operator on the way out.
   *
   * The cookie is already gone — the Worker cleared it on the success response
   * — so this is only the copy React is holding. Without it the app would keep
   * rendering the nav and the business name of an account that no longer
   * exists until something happened to make it ask again.
   */
  function done() {
    clearSession();
    navigate('/', { replace: true });
  }

  return (
    <section className="stack">
      <span className="eyebrow">Closing this account</span>

      {isDemo ? (
        <p className="muted" style={{ margin: 0 }}>
          This is the sample business, and it is rebuilt from scratch every time
          somebody opens the demo — so there is nothing here to close. Sign in
          with your own email to see this on your own account.
        </p>
      ) : (
        <>
          <p className="muted" style={{ margin: 0 }}>
            Empties your email address, phone number, home address, licence and
            insurance numbers, vehicle details and photographs off this site for
            good, and takes your client list and your conversations with it.
          </p>
          <div>
            <button className="btn quiet" type="button" onClick={() => setOpen(true)}>
              Close this account
            </button>
          </div>
        </>
      )}

      {open && !closed && (
        <ConfirmDestructive
          title="Close this account"
          word="CLOSE"
          confirmLabel="Close it and delete my details"
          busy={busy}
          error={error}
          onConfirm={() => void close()}
          onClose={() => { if (!busy) { setOpen(false); setError(null); } }}
        >
          <div className="stack" style={{ gap: 6 }}>
            <strong>Emptied off this site</strong>
            <ul className="erase-list">
              <li>
                The email address you sign in with, your phone number, and your
                home address and its position on the map.
              </li>
              <li>
                Your licence number, your insurer and policy number, and the
                name a background check was run against.
              </li>
              <li>
                Your vehicle — make, model, colour and plate — and your
                Instagram, Facebook and TikTok links.
              </li>
              <li>
                Your business name, trade, tagline and profile text. Your page
                comes down and your card on file is forgotten.
              </li>
            </ul>
          </div>

          <div className="stack" style={{ gap: 6 }}>
            <strong>Deleted</strong>
            <ul className="erase-list">
              <li>Every photograph of your work, and your profile picture.</li>
              <li>
                Your client list, every conversation with a customer, and the
                requests strangers sent you. This is other people's personal
                data that only existed because this account did, so it goes
                with it.
              </li>
              <li>
                Your notification feed and your outgoing message log.
              </li>
              <li>
                Every sign-in. Nobody opens this account again, including you —
                there is no reopening it and no support desk that can.
              </li>
            </ul>
          </div>

          <div className="stack" style={{ gap: 6 }}>
            <strong>Kept</strong>
            <ul className="erase-list">
              <li>
                The jobs that happened, what was paid for them and any lead fees
                — the books, in other words. What is left of your row is
                “Closed business”, a country, a currency and a timezone, which
                is what those records need to still make sense and which names
                nobody.
              </li>
              <li>
                Reviews customers left. Those are theirs and other people rely
                on them.
              </li>
              <li>
                Any suspension on record against this business. Closing is not
                how one of those is cleared.
              </li>
            </ul>
          </div>

          <p style={{ margin: 0 }}>
            There is no undo and nothing is held for a few days first. If you
            still have work in the diary this will be refused until you have
            cancelled or finished it — closing now would leave those customers
            with nobody coming.
          </p>
        </ConfirmDestructive>
      )}

      {closed && (
        <Sheet title="This account is closed" onClose={done}>
          <p style={{ margin: 0 }}>
            Your details are off this site and your page is down. Your client
            list, your conversations and your photographs have been deleted.
          </p>
          <p style={{ margin: 0 }}>
            What is left is the record of the work: the jobs, what was paid, any
            fees and the reviews your customers wrote — under “Closed business”,
            with nothing on it that names you.
          </p>
          <p style={{ margin: 0 }}>
            You are signed out on this device and this account cannot be signed
            in to again.
          </p>
          <div>
            <button className="btn" type="button" onClick={done}>
              Go to the front page
            </button>
          </div>
        </Sheet>
      )}
    </section>
  );
}
