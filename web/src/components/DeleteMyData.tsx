import { useState } from 'react';
import { api, type ErasureResult } from '../api';
import ConfirmDestructive from './ConfirmDestructive';

/**
 * "Delete my data", on the customer's own page.
 *
 * The link in the address bar is the whole of a customer's identity here —
 * there is no account and no password to re-enter — so the link is also the
 * authority for this. That is not a weak one for the purpose: whoever holds it
 * can already read the booking, the address, the conversation and the
 * photographs that this removes.
 *
 * WHAT THE COPY IS ALLOWED TO SAY. Only what eraseCustomerByToken in
 * src/lib/retention.ts actually does, in the order it does it. Three
 * categories, because the code has three: rows that are deleted, rows that
 * survive with the personal columns emptied, and the settled money that is
 * kept on purpose. A page that promised "everything about you is gone" would
 * be lying about the third one, and the person who found that out afterwards
 * would be right to think the whole thing was a gesture.
 */
export default function DeleteMyData({ token, hasBooking, onErased }: {
  token: string;
  /**
   * Whether this link has a booking behind it, which decides the SCOPE of the
   * erasure and so decides what the reader has to be told. With one, the
   * Worker follows the phone number on the order and reaches every business
   * this person has booked with; without one there is no number to follow and
   * the conversation is the whole of their footprint.
   */
  hasBooking: boolean;
  onErased: (result: ErasureResult) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function erase() {
    setBusy(true); setError(null);
    try {
      onErased(await api.eraseMyData(token));
    } catch (e) {
      setError(e instanceof Error ? e.message
        : 'That did not go through. Nothing has been deleted.');
      setBusy(false);
    }
  }

  return (
    <>
      {/* Quiet, and at the bottom of the page. It has to be findable by
          somebody looking for it and must not sit next to the controls
          somebody taps while reading their booking. */}
      <div>
        <button className="btn quiet sm" type="button" onClick={() => setOpen(true)}>
          Delete my data
        </button>
      </div>

      {open && (
        <ConfirmDestructive
          title="Delete your data"
          word="DELETE"
          confirmLabel="Delete my messages, photos and contact details"
          busy={busy}
          error={error}
          onConfirm={() => void erase()}
          onClose={() => { if (!busy) { setOpen(false); setError(null); } }}
        >
          {hasBooking ? (
            <p style={{ margin: 0 }}>
              This does not stop at this business. Your bookings are tied
              together by your phone number, so this removes your personal data
              from <strong>every business you have booked through this
              site</strong> with that number.
            </p>
          ) : (
            <p style={{ margin: 0 }}>
              There is no booking on this link, only this conversation — so this
              conversation is what there is to remove.
            </p>
          )}

          <div className="stack" style={{ gap: 6 }}>
            <strong>Deleted, permanently</strong>
            <ul className="erase-list">
              <li>
                This conversation and every message in it
                {hasBooking && ', along with the conversation attached to each '
                  + 'of your other bookings'}.
              </li>
              {hasBooking && (
                <>
                  <li>
                    The photographs taken on those jobs — including any you
                    chose to publish on a review.
                  </li>
                  <li>
                    Your name, phone number, email address, street address and
                    map position, from every booking and every request you made.
                  </li>
                  <li>
                    The customer record each business was given when you booked
                    through this site.
                  </li>
                  <li>
                    Any opening alerts set up with your email address.
                  </li>
                </>
              )}
            </ul>
          </div>

          {hasBooking && (
            <>
              <div className="stack" style={{ gap: 6 }}>
                <strong>Emptied, not removed</strong>
                <ul className="erase-list">
                  <li>
                    Reviews you left keep their rating and their words — other
                    customers rely on them — and the name on them becomes
                    “A customer”.
                  </li>
                  <li>
                    The appointment stays as a record that work happened, with
                    the address and anything written about your home taken out
                    of it.
                  </li>
                </ul>
              </div>

              <div className="stack" style={{ gap: 6 }}>
                <strong>Kept</strong>
                <ul className="erase-list">
                  <li>
                    What was paid: an amount, a currency, a date and which
                    business it was with, with nothing on it that names you.
                    Money that has already moved is a record of a transaction
                    between two parties, and it is not one side's alone to
                    erase.
                  </li>
                </ul>
              </div>
            </>
          )}

          <p style={{ margin: 0 }}>
            There is no undo, no grace period and no copy kept in case you
            change your mind. This link stops opening anything the moment it is
            done.
          </p>
        </ConfirmDestructive>
      )}
    </>
  );
}
