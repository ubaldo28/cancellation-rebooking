import { useCallback, useEffect, useState } from 'react';
import { api, type BookingState, type CustomerAccount, type Standing } from '../api';

/**
 * The signed-in customer, and what this deployment lets anybody book today.
 *
 * TWO HOOKS RATHER THAN A CONTEXT, and that is deliberate. The operator's
 * session in App.tsx is a provider wrapping the whole router because every
 * screen inside /app depends on it; a customer's session is needed on exactly
 * two pages — the checkout and their own account — and a provider around the
 * front door would mean every visitor to a cost guide paying for a request
 * about an account they do not have. Browsing is the thing this product is
 * for, and it must not carry the weight of a login.
 *
 * NEITHER HOOK EVER THROWS AND NEITHER TREATS A 401 AS A FAULT. Signed out is
 * the ordinary state of this session, so it is a null account rather than an
 * error; a call that fails for any other reason lands in the same place, which
 * is right here — the worst it costs is that somebody who is signed in is
 * asked for their email address again, and the Worker will still recognise the
 * cookie when the order is placed.
 */

export interface CustomerSession {
  /** Null while loading and null when signed out. `loading` tells them apart. */
  account: CustomerAccount | null;
  /**
   * Their no-show standing, so a suspension is met before a basket is filled.
   * Keyed on the account's email address since migration 0038, which is what
   * stops a second account walking away from a strike.
   */
  standing: Standing | null;
  /** The Worker's own sentence about what the card is for. Never written here. */
  cardNote: string | null;
  loading: boolean;
  /** Re-reads the session — after signing in, or after the card changes. */
  refresh: () => Promise<void>;
  /**
   * Drops the local copy without asking the Worker to do anything, for the two
   * calls that revoke the session on their own success response: closing the
   * account and erasing the data behind it.
   */
  clear: () => void;
}

export function useCustomer(): CustomerSession {
  const [account, setAccount] = useState<CustomerAccount | null>(null);
  const [standing, setStanding] = useState<Standing | null>(null);
  const [cardNote, setCardNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const me = await api.customerMe();
      setAccount(me.account);
      setStanding(me.standing);
      setCardNote(me.card_note);
    } catch {
      // 401 is the normal signed-out case and is not worth distinguishing from
      // a network failure: both mean this page cannot say who is reading it.
      setAccount(null); setStanding(null); setCardNote(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const clear = useCallback(() => {
    setAccount(null); setStanding(null); setCardNote(null);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return { account, standing, cardNote, loading, refresh, clear };
}

/**
 * What booking requires on this deployment, from the server.
 *
 * NOT A CONSTANT, which is the whole reason it is a request. Whether a card is
 * needed depends on a Worker secret and whether an account can be created at
 * all depends on whether the sign-in code can be emailed — neither of which a
 * bundle can know, and both of which a page has to state correctly or it is
 * lying to somebody about to spend money. A hard-coded answer to this question
 * is exactly how the site came to promise a thing that was never the model.
 *
 * Null means the question has not been answered yet — either still in flight
 * or refused — and a caller must not read that as "everything is fine". The
 * checkout treats null as "we cannot say", which leaves the button on and lets
 * the Worker have the last word, rather than blocking a booking over a failed
 * GET.
 */
export function useBookingState(): BookingState | null {
  const [state, setState] = useState<BookingState | null>(null);
  useEffect(() => {
    let live = true;
    api.bookingState()
      .then((s) => { if (live) setState(s); })
      .catch(() => { /* see above: null is "we could not ask" */ });
    return () => { live = false; };
  }, []);
  return state;
}
