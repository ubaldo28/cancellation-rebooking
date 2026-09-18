import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api, ApiError } from '../api';

/**
 * PUTTING A CARD ON FILE, ON OUR OWN PAGE.
 *
 * The sibling of PayForm.tsx, and deliberately shaped like it. The difference
 * is what is being asked for: PayForm asks the bank to move an amount now,
 * this asks the bank for permission to keep the card and use it later. No
 * amount is named here and nothing is charged — a customer who fills this in
 * and walks away has spent nothing.
 *
 * The same isolation applies and is the whole reason this is safe to embed.
 * The fields are iframes served from Stripe's own origin, so a card number is
 * typed into Stripe and this page never sees it, cannot read it, and could not
 * leak it if the surrounding code were compromised tomorrow. It is also why
 * src/lib/headers.ts allows js.stripe.com in exactly three places and nothing
 * more.
 *
 * NO REDIRECT, ANYWHERE. The setup intent is created with allow_redirects=never
 * on the Worker, so Stripe only offers ways of storing a card that can be
 * finished on this page. `redirect: 'if_required'` on confirm is the matching
 * half: this code never hands the browser to another site, and a method that
 * somehow demanded one would surface as an error rather than as a page leaving.
 *
 * THE BRAND AND THE LAST FOUR ARE NOT THIS COMPONENT'S TO DECIDE. Stripe.js
 * hands back a reference to the stored card and usually nothing else, so what
 * goes up to `onSaved` is normally a reference and two nulls. The Worker asks
 * Stripe what card that reference actually names. Anything this browser
 * claimed about the card would be a claim a browser made about itself, and
 * "Visa ending 4242" on somebody's account has to be a fact — so the nulls are
 * passed through honestly rather than filled in with a guess.
 *
 * NOTHING IS KEPT IN THE BROWSER. No localStorage, no sessionStorage, no
 * copy of the secret anywhere it outlives this mount. There is nothing here
 * worth storing: the intent is single use, and the card belongs to Stripe.
 *
 * Stripe.js is loaded on demand rather than in index.html. It is a large
 * script that only matters on the one screen that collects a card, and every
 * other page on this site would be paying for it.
 */

declare global {
  interface Window { Stripe?: (key: string) => any }
}

const SDK = 'https://js.stripe.com/v3/';

/**
 * Loads Stripe.js once per document, however many times this mounts.
 *
 * A second copy of PayForm's loader rather than a shared one, because the two
 * components are owned separately and a shared module between them does not
 * exist yet. It costs nothing: whichever of the two runs first puts
 * `window.Stripe` on the page, and the check below means the other returns
 * immediately without asking the network for a script it already has.
 */
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
      reject(new Error('Could not load the card form.'));
    };
    document.head.appendChild(el);
  });
  return loading;
}

/**
 * How Stripe's own fields are painted so they look like the rest of the site.
 *
 * THE COLOURS ARE WRITTEN OUT IN FULL HERE AND THAT IS NOT DRIFT. This object
 * is serialised and handed to Stripe's iframe, which is a different document
 * on a different origin: it cannot see styles.css and `var(--accent)` would
 * resolve to nothing inside it. Every value below is the token of the same
 * name, and the section at the foot of styles.css names the pairs so a change
 * to one is a change to both.
 *
 * The focus treatment is a border plus a soft halo rather than an `outline`,
 * because Stripe accepts a short list of properties in these rules and quietly
 * warns about the rest — a focus ring that only appears in some builds is
 * worse than one drawn a slightly different way everywhere.
 */
const APPEARANCE = {
  theme: 'stripe',
  variables: {
    colorPrimary: '#005A9C',            // --accent
    colorBackground: '#ffffff',         // --surface
    colorText: '#0d1117',               // --ink
    colorTextSecondary: '#5c6572',      // --muted
    colorTextPlaceholder: '#666f7c',    // --faint
    colorDanger: '#96504a',             // the ink inside .error
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    fontSizeBase: '16px',
    borderRadius: '12px',               // --r-md
    spacingUnit: '4px',
  },
  rules: {
    // --control-line, not --line, and for the reason the token itself gives:
    // this edge is the only thing saying "there is a box here to type in", and
    // the hairline used between things you merely read is too faint to say it.
    '.Input': {
      border: '1px solid #828c9a',
      boxShadow: 'none',
      padding: '12px 13px',
    },
    '.Input:focus': {
      border: '1px solid #005A9C',
      boxShadow: '0 0 0 2px #B4D2EC',   // --accent-line
    },
    '.Input--invalid': { border: '1px solid #96504a', boxShadow: 'none' },
    '.Label': { color: '#5c6572', fontSize: '13px', fontWeight: '500' },
    '.Error': { color: '#96504a', fontSize: '13px' },
    '.Tab': { border: '1px solid #828c9a', boxShadow: 'none' },
    '.Tab--selected': { border: '1px solid #005A9C', color: '#005A9C', boxShadow: 'none' },
  },
};

export interface CardFieldProps {
  onSaved: (card: { ref: string; brand: string | null; last4: string | null }) => void;
  /** Shown above the field. Defaults to something sensible. */
  label?: string;
}

export default function CardField({ onSaved, label = 'Card details' }: CardFieldProps) {
  const mount = useRef<HTMLDivElement | null>(null);
  const stripe = useRef<any>(null);
  const elements = useRef<any>(null);
  const labelId = useId();

  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Off when this deployment has no keys — the panel says so rather than hanging. */
  const [off, setOff] = useState(false);

  useEffect(() => {
    let dead = false;

    void (async () => {
      try {
        // One call, unlike PayForm's two. Asking for the intent is itself the
        // question "are cards switched on here": a deployment with no keys
        // cannot mint one and refuses below, and one that can hands back the
        // key in the same breath. A separate config call would only be a
        // second chance for the two answers to disagree.
        const handle = await api.setupIntent();
        if (dead) return;
        if (!handle.publishable_key) { setOff(true); return; }

        await loadStripeJs();
        if (dead || !mount.current) return;

        const s = window.Stripe!(handle.publishable_key);
        const el = s.elements({ clientSecret: handle.client_secret, appearance: APPEARANCE });
        el.create('payment', { layout: 'tabs' }).mount(mount.current);
        stripe.current = s;
        elements.current = el;
        setReady(true);
      } catch (err) {
        if (dead) return;
        // The Worker's own word for "this deployment has no Stripe keys". It is
        // not a fault and there is nothing to retry, so it gets the plain note
        // rather than the red box — a card form that cannot work must not be
        // drawn as one that is merely broken this minute.
        if (err instanceof ApiError && err.code === 'stripe_unconfigured') { setOff(true); return; }
        setError(err instanceof ApiError
          ? err.message
          : 'The card form could not be loaded. Refresh and try again.');
      }
    })();

    return () => { dead = true; };
  }, []);

  const save = useCallback(async () => {
    if (!stripe.current || !elements.current || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await stripe.current.confirmSetup({
        elements: elements.current,
        // The half of "no redirect" that lives on this side. Stripe only sends
        // the browser away when a method demands it; with the intent created as
        // allow_redirects=never none can, so this never fires and anything that
        // tried would come back as an error instead.
        redirect: 'if_required',
      });

      if (res.error) {
        // Stripe's own message is written for the person holding the card and
        // is nearly always better than anything this code could say.
        setError(res.error.message ?? 'That card was declined.');
        setBusy(false);
        return;
      }

      // `payment_method` is the reference to the stored card. It arrives as a
      // plain id in the ordinary case and as the whole object when something
      // upstream asked Stripe to expand it, so both are read rather than one
      // being assumed — the version that is assumed is the one that turns up
      // in production.
      const method = res.setupIntent?.payment_method;
      const ref: string | undefined = typeof method === 'string' ? method : method?.id;
      if (!ref) {
        // The card was stored and we came away without the reference to it, so
        // there is nothing to send up. Saying so is the honest answer; a silent
        // success would leave somebody believing they had a card on file.
        setError('The card was accepted but we did not get a reference for it. Try again.');
        setBusy(false);
        return;
      }

      const card = typeof method === 'string' ? undefined : method?.card;
      // Still busy on purpose, and not reset from here. A setup intent can be
      // confirmed exactly once, so a second press would fail against a spent
      // one; the parent decides what this screen becomes next.
      onSaved({ ref, brand: card?.brand ?? null, last4: card?.last4 ?? null });
    } catch {
      setError('Something went wrong saving the card. Nothing was charged.');
      setBusy(false);
    }
  }, [busy, onSaved]);

  if (off) {
    return (
      <div className="notice">
        Card payments are not switched on yet, so there is no card to put on
        file. Nothing is held up by that — while payments are off, no card is
        asked for at the booking.
      </div>
    );
  }

  return (
    <section className="stack card-field">
      {/*
        A real <label>, with no `htmlFor`. There is no control on this page to
        point one at: the input a person types into lives inside Stripe's
        iframe and has no id this document can name, and a `for` naming an id
        that does not exist is worse than none — it tells a screen reader to go
        somewhere and then leaves it nowhere. `aria-labelledby` on the region
        holding the fields is what actually ties the two together.
      */}
      <label className="card-field-label" id={labelId}>{label}</label>
      <div ref={mount} className="card-field-el" role="group" aria-labelledby={labelId} />
      {!ready && !error && <p className="faint card-field-line">Loading the card form…</p>}
      {error && <div className="error" role="alert">{error}</div>}
      <button className="btn" type="button" disabled={!ready || busy} onClick={() => void save()}>
        {busy && <span className="card-field-spin" aria-hidden="true" />}
        {busy ? 'Saving your card…' : 'Save this card'}
      </button>
      {/* The two facts a person wants at this exact moment, and no more. */}
      <p className="faint card-field-line">
        Nothing is charged now. Your card details go straight to our payment
        processor and never touch this site, and you can remove the card at any
        time from your account.
      </p>
    </section>
  );
}
