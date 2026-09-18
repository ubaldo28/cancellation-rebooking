import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type ConnectStatus } from '../api';

/**
 * GETTING PAID: the business's side of the money.
 *
 * A customer pays Round The Way; Round The Way pays the business. For the
 * second half to happen the business needs an account at the processor with
 * its identity checked and its bank details on file, and that is what this
 * panel starts.
 *
 * THIS IS THE ONE PLACE THE PRODUCT SENDS SOMEBODY AWAY. Customers pay on our
 * own pages and always will. Onboarding is the exception, deliberately: a
 * self-employed person is handing over identity documents and a bank account,
 * and that belongs on the regulated company's own page under their name.
 * Taking those details on a form of ours would mean holding them.
 *
 * THIS IS REQUIRED BEFORE A BUSINESS CAN LIST. src/lib/bypass.ts refuses to
 * publish an opening until stripe_payouts_enabled is 1. The reason is simple:
 * a customer pays on the site, so if there is nowhere to send the business's
 * share, this platform ends up holding somebody else's money with no way to
 * pass it on. Better to say "finish this first" than to take a payment we
 * cannot pay out.
 *
 * The wording below has to be blunt about that, because an operator who posts
 * an opening and gets a refusal with no explanation will leave.
 */
export default function PayoutSetup() {
  const [status, setStatus] = useState<ConnectStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.stripeAccount();
      setStatus(res.connect);
    } catch {
      // A panel that cannot read its own state says nothing rather than
      // claiming the business cannot be paid.
    } finally { setLoaded(true); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Coming back from the processor. They have either finished or given up
  // halfway, and only the processor knows which — so ask it rather than
  // assuming the trip succeeded.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!new URLSearchParams(window.location.search).has('payouts')) return;
    void (async () => {
      try {
        const res = await api.refreshStripeAccount();
        setStatus(res.connect);
      } catch { /* the cached state below is still worth showing */ }
    })();
  }, []);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api.startOnboarding();
      // A full navigation, not a new tab. The link is single-use and expires
      // in minutes, and a background tab is where it goes to die.
      window.location.href = url;
    } catch (err) {
      setError(err instanceof ApiError
        ? err.message
        : 'Could not open the payout setup. Try again in a moment.');
      setBusy(false);
    }
  }, []);

  if (!loaded || !status) return null;

  const done = status.payouts_enabled;

  return (
    <section className="stack">
      <span className="eyebrow">Getting paid</span>

      {done ? (
        <div className="card stack">
          <p style={{ margin: 0 }}>
            <strong>Your payouts are set up.</strong> When somebody books and
            pays on the site, your share lands in your bank account.
          </p>
          <p className="faint" style={{ margin: 0 }}>
            Round The Way keeps 15% of the job, never more than $150 from one
            business in one day.
            Nothing is added to what the customer pays — the price you set is
            the price they see.
          </p>
        </div>
      ) : (
        <div className="card stack">
          <p style={{ margin: 0 }}>
            {status.started
              ? <><strong>You started this and did not finish.</strong> Pick up
                where you left off — it takes a couple of minutes.</>
              : <><strong>Add a bank account so we can pay you.</strong> Our
                payment processor takes your details directly; we never see
                them.</>}
          </p>
          {/* Said plainly and up front, so nobody meets this for the first
              time as a refusal when they try to post an opening. */}
          <p className="faint" style={{ margin: 0 }}>
            Your openings will not go up until this is done. Customers pay on
            the site and your share is sent straight to you, so there has to be
            somewhere to send it. It takes a couple of minutes.
          </p>
          {error && <div className="error">{error}</div>}
          <div>
            <button className="btn" type="button" disabled={busy}
              onClick={() => void start()}>
              {busy ? 'Opening…' : status.started ? 'Finish setup' : 'Set up payouts'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
