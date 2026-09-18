import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';

/**
 * THE CARD FORM, ON OUR OWN PAGE.
 *
 * The customer never goes to the processor's website to pay. What loads here
 * is Stripe's Payment Element: the fields themselves are iframes served from
 * Stripe's own origin, so a card number is typed into Stripe and this page
 * never sees it, cannot read it, and could not leak it if the surrounding code
 * were compromised tomorrow. That isolation is what makes embedding safe, and
 * it is why src/lib/headers.ts allows js.stripe.com in exactly three places
 * and nothing more.
 *
 * NO REDIRECT, ANYWHERE. The intent is created with allow_redirects=never, so
 * Stripe offers only methods that can be completed here — card, Apple Pay,
 * Link. `redirect: 'if_required'` on confirm is the matching half: it means
 * this code never hands the browser to another site, and if a method somehow
 * demanded one it would surface as an error rather than as a page leaving.
 *
 * THE BOOKING IS CONFIRMED BY THE WEBHOOK, NOT BY THIS COMPONENT. What happens
 * here when the card succeeds is that the customer is shown their
 * confirmation. What makes the order real is Stripe telling the Worker, server
 * to server — because a customer who pays and closes the tab in the same
 * second must still end up with a booking, and this component cannot promise
 * that. `onPaid` is a screen transition, never a source of truth.
 *
 * Stripe.js is loaded on demand rather than in index.html. It is a large
 * script that only matters on the last screen of a checkout, and every other
 * page on this site would be paying for it.
 */

declare global {
  interface Window { Stripe?: (key: string) => any }
}

const SDK = 'https://js.stripe.com/v3/';

/** Loads Stripe.js once per document, however many times this mounts. */
let loading: Promise<void> | null = null;
function loadStripeJs(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.Stripe) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = SDK;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => {
      // Let a later attempt try again rather than caching the failure forever —
      // this is usually a flaky network, not a missing script.
      loading = null;
      reject(new Error('Could not load the payment form.'));
    };
    document.head.appendChild(el);
  });
  return loading;
}

export interface PayFormProps {
  orderId: string;
  /** Shown on the button, already formatted by the server. */
  total: string;
  /** Called once the card has been accepted. A screen change, not a receipt. */
  onPaid: () => void;
}

export default function PayForm({ orderId, total, onPaid }: PayFormProps) {
  const mount = useRef<HTMLDivElement | null>(null);
  const stripe = useRef<any>(null);
  const elements = useRef<any>(null);

  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Off when this deployment has no keys — the panel says so rather than hanging. */
  const [off, setOff] = useState(false);

  useEffect(() => {
    let dead = false;

    void (async () => {
      try {
        // Two calls, in this order on purpose. The config says whether payments
        // are even switched on here; the intent is what opening one costs. No
        // point asking for a charge on a deployment with no keys.
        const config = await api.paymentConfig();
        if (dead) return;
        if (!config.enabled || !config.publishable_key) { setOff(true); return; }

        const handle = await api.startPayment(orderId);
        if (dead) return;
        // Already paid — a customer who came back to a link after the webhook
        // landed. Straight to the confirmation; do not draw a card form for
        // money that has already been taken.
        if (handle.paid) { onPaid(); return; }

        await loadStripeJs();
        if (dead || !mount.current) return;

        const s = window.Stripe!(config.publishable_key);
        const el = s.elements({
          clientSecret: handle.client_secret,
          appearance: {
            theme: 'stripe',
            variables: {
              colorPrimary: '#005A9C',
              colorText: '#0E1A24',
              fontFamily: 'Inter, system-ui, sans-serif',
              borderRadius: '12px',
            },
          },
        });
        el.create('payment', { layout: 'tabs' }).mount(mount.current);
        stripe.current = s;
        elements.current = el;
        setReady(true);
      } catch (err) {
        if (dead) return;
        setError(err instanceof ApiError
          ? err.message
          : 'The payment form could not be loaded. Refresh and try again.');
      }
    })();

    return () => { dead = true; };
  }, [orderId, onPaid]);

  const pay = useCallback(async () => {
    if (!stripe.current || !elements.current || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await stripe.current.confirmPayment({
        elements: elements.current,
        // The half of "no redirect" that lives on this side. Stripe only
        // sends the browser away when a method demands it; with the intent
        // created as allow_redirects=never, none can, so this never fires and
        // anything that tried would come back as an error instead.
        redirect: 'if_required',
      });

      if (res.error) {
        // Stripe's own message is written for the person holding the card and
        // is nearly always better than anything this code could say.
        setError(res.error.message ?? 'That card was declined.');
        setBusy(false);
        return;
      }
      onPaid();
    } catch {
      setError('Something went wrong taking the payment. Nothing was charged.');
      setBusy(false);
    }
  }, [busy, onPaid]);

  if (off) {
    return (
      <div className="notice">
        Card payment is not switched on yet. Your appointment is held — the
        business will be in touch through the conversation on this booking.
      </div>
    );
  }

  return (
    <section className="stack pay">
      <div ref={mount} className="pay-fields" />
      {!ready && !error && <p className="faint">Loading the payment form…</p>}
      {error && <div className="error" role="alert">{error}</div>}
      <button className="btn" type="button" disabled={!ready || busy} onClick={() => void pay()}>
        {busy ? 'Taking payment…' : `Pay ${total}`}
      </button>
      {/* The two facts a person wants at this exact moment, and no more. */}
      <p className="faint" style={{ margin: 0 }}>
        The price you see is the price you pay — nothing is added here. Your
        card details go straight to our payment processor and never touch this
        site.
      </p>
    </section>
  );
}
