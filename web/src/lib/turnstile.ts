/**
 * Cloudflare Turnstile, the client half.
 *
 * Two jobs: say whether the widget should exist at all, and fetch the script
 * exactly once for the whole session no matter how many widgets mount.
 *
 * The site key is public by design — it is baked into the bundle and readable
 * by anybody who views source — so it lives in a build-time variable rather
 * than being fetched. The secret half never leaves the Worker; see
 * src/lib/turnstile.ts.
 *
 * DELIBERATE OFF-SWITCH, CURRENTLY OFF. VITE_TURNSTILE_SITE_KEY is not set in
 * any build yet. With it absent nothing below ever runs: no script is
 * requested, no widget is drawn, no token is sent, and every form behaves
 * exactly as it did before this file existed. That is what lets this ship
 * ahead of the keys and what keeps `vite build` working for anybody who checks
 * the repo out. It is not the same thing as the forms being protected — they
 * are not, in either half, until both keys are configured.
 *
 * The two switches are independent by construction: one is a Worker secret,
 * the other is compiled into the bundle. So they are written to fail in the
 * safe direction on either mismatch. A site key with no secret means widgets
 * that draw and a token nobody checks — friction, no hole. A secret with no
 * site key means submissions refused with `turnstile_missing`, which the forms
 * turn into a readable sentence rather than a dead button. Nothing here ever
 * blocks a submission on its own: the client is best-effort, the Worker
 * decides, and a widget that could not render must never be what stops a real
 * customer from booking.
 */

/** Empty means off, and off is the state of every build today. */
export const TURNSTILE_SITE_KEY: string =
  (import.meta.env.VITE_TURNSTILE_SITE_KEY ?? '').trim();

export const turnstileOn = (): boolean => TURNSTILE_SITE_KEY !== '';

/**
 * What api.js puts on the window. Only the parts used here are declared —
 * writing out the whole surface would be inventing a contract we do not read.
 */
export interface TurnstileApi {
  render(el: HTMLElement, opts: {
    sitekey: string;
    action?: string;
    theme?: 'auto' | 'light' | 'dark';
    appearance?: 'always' | 'execute' | 'interaction-only';
    'refresh-expired'?: 'auto' | 'manual' | 'never';
    callback?: (token: string) => void;
    'error-callback'?: (code?: string) => void;
    'expired-callback'?: () => void;
    'timeout-callback'?: () => void;
  }): string;
  reset(widgetId?: string): void;
  remove(widgetId?: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
    /** Named in the script URL below, so api.js can call back when it is ready. */
    __slotfillTurnstileReady?: () => void;
  }
}

/**
 * The script, loaded lazily and at most once.
 *
 * Lazily because it is a third-party request on a site where most pages have
 * no form to protect — the map, the trade pages, a guest conversation — and
 * none of them should pay for it. At most once because the module-level
 * promise is the memo: two widgets mounting on the same page, or a second
 * visit to /a inside one session, both wait on this same promise rather than
 * appending a second <script> that would re-register the global.
 *
 * `render=explicit` stops api.js hunting the document for elements to fill in
 * by class name and hands that to the component instead, which is what lets a
 * React tree own the widget's lifetime. `onload=` names a function on window
 * rather than an inline handler, because script-src has no 'unsafe-inline' and
 * is not getting one for this.
 */
const SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js'
  + '?render=explicit&onload=__slotfillTurnstileReady';

let loading: Promise<TurnstileApi> | null = null;

export function loadTurnstile(): Promise<TurnstileApi> {
  if (loading) return loading;

  loading = new Promise<TurnstileApi>((resolve, reject) => {
    if (window.turnstile) { resolve(window.turnstile); return; }

    window.__slotfillTurnstileReady = () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error('Turnstile loaded but did not register.'));
    };

    const el = document.createElement('script');
    el.src = SRC;
    el.async = true;
    el.defer = true;
    // A blocked host, an offline phone, an ad blocker that swallows the whole
    // domain. All arrive here, and all mean the same thing to the form above:
    // no widget, carry on, let the Worker have the last word.
    el.onerror = () => {
      // Cleared so a later mount — a customer who comes back to the tab with a
      // connection this time — gets a fresh attempt instead of the old refusal.
      loading = null;
      reject(new Error('The security check could not be loaded.'));
    };
    document.head.appendChild(el);
  });

  return loading;
}
