import {
  forwardRef, useEffect, useImperativeHandle, useRef, useState,
} from 'react';
import { TURNSTILE_SITE_KEY, loadTurnstile, turnstileOn } from '../lib/turnstile';
import '../styles-turnstile.css';

/**
 * The Turnstile widget, as one field on a form.
 *
 * Renders nothing at all when there is no site key, which is every build
 * today — see web/src/lib/turnstile.ts for why that switch exists and what it
 * does and does not mean. "Nothing at all" is literal and load-bearing: no
 * element, so no change to the tab order, no change to what a screen reader
 * walks past, and no change to what axe measures on these pages.
 *
 * THIS COMPONENT NEVER BLOCKS A SUBMISSION. It reports a token when it has
 * one and null when it does not, and the form is expected to send whatever it
 * has and let the Worker decide. That is not laxity — a script attacking the
 * endpoint never runs this code, so refusing to submit here buys no security
 * whatsoever, while a customer stranded behind a widget that could not load is
 * a booking lost to a third party's bad afternoon.
 */

export interface TurnstileHandle {
  /**
   * Throw the solved token away and ask for another.
   *
   * A token is single-use and short-lived, so a form that got a 4xx for any
   * reason — the slot went, the postcode was wrong — is holding one that will
   * not work a second time. The form calls this after every failed submit so
   * the retry has a fresh one, and the customer keeps everything they typed:
   * the inputs are React state and are not touched by any of this.
   */
  reset(): void;
}

interface Props {
  /**
   * Called with the token when the challenge passes, and with null whenever
   * it stops being valid — expiry, timeout, an error, or a reset.
   */
  onToken: (token: string | null) => void;
  /** Labels the challenge in Cloudflare's own analytics. */
  action?: string;
}

/** What the person is told, per failure the widget can have. */
const MESSAGES = {
  load: 'The check that you are a person could not be loaded. You can still '
    + 'send this — if it is refused, reload the page and try again.',
  error: 'The check that you are a person did not complete. It will try again '
    + 'on its own; if it does not, reload the page.',
  expired: 'That check timed out while you were filling this in. It is '
    + 'refreshing itself — nothing you have typed is lost.',
} as const;

const Turnstile = forwardRef<TurnstileHandle, Props>(function Turnstile(
  { onToken, action }, ref,
) {
  const holder = useRef<HTMLDivElement | null>(null);
  const widgetId = useRef<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Kept in a ref so the effect below can call the newest callback without
  // listing it as a dependency. A parent that passes an inline arrow — which
  // every caller does — would otherwise tear the widget down and build a new
  // one on every keystroke in the form around it.
  const report = useRef(onToken);
  report.current = onToken;

  useImperativeHandle(ref, () => ({
    reset() {
      if (!widgetId.current) return;
      report.current(null);
      setNote(null);
      window.turnstile?.reset(widgetId.current);
    },
  }), []);

  useEffect(() => {
    if (!turnstileOn()) return;
    let live = true;

    void loadTurnstile()
      .then((api) => {
        if (!live || !holder.current || widgetId.current) return;
        widgetId.current = api.render(holder.current, {
          sitekey: TURNSTILE_SITE_KEY,
          action,
          theme: 'auto',
          // Let Cloudflare replace an expired token by itself. The callback
          // below still fires, so the form is told the old one is dead the
          // moment it dies rather than finding out from a 400.
          'refresh-expired': 'auto',
          callback: (token) => { setNote(null); report.current(token); },
          'expired-callback': () => { report.current(null); setNote(MESSAGES.expired); },
          'timeout-callback': () => { report.current(null); setNote(MESSAGES.error); },
          'error-callback': () => { report.current(null); setNote(MESSAGES.error); },
        });
      })
      .catch(() => { if (live) setNote(MESSAGES.load); });

    return () => {
      live = false;
      // React 18 StrictMode mounts every effect twice in development. Without
      // this the second mount leaves the first widget's iframe orphaned in the
      // page, which is two challenges where the customer expects one.
      if (widgetId.current) {
        window.turnstile?.remove(widgetId.current);
        widgetId.current = null;
      }
    };
  }, [action]);

  if (!turnstileOn()) return null;

  return (
    <div className="turnstile">
      {/*
        The widget itself is a third-party iframe that Cloudflare drops in
        here. It is focusable and it is the last thing before the submit
        button, which is where it belongs in the tab order: after everything
        the customer types and before the thing that sends it.
      */}
      <div ref={holder} className="turnstile-box" />
      {/*
        Always in the document, empty when there is nothing to say. A live
        region that is added to the page at the same moment it gets its text
        is frequently not announced at all — the browser has nothing to notice
        a change against. This one is there from the start, so expiry mid-form
        is spoken rather than silently disabling the button.
      */}
      <p className="turnstile-note" role="status">{note}</p>
    </div>
  );
});

export default Turnstile;
