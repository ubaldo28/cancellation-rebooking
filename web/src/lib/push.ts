/**
 * Web Push, the browser half.
 *
 * A customer here has no account and no phone number on file — their identity
 * is the secret in their link — so a notification is the only way to tell them
 * an opening appeared while they were doing something else. That makes the
 * permission prompt the single most expensive moment in the product: a denial
 * is permanent, it applies to the whole origin, and nothing we can do from a
 * page will ever ask again. So every function here refuses early and says why
 * in words a person can act on, rather than letting `subscribe()` reject with
 * a DOMException nobody can read.
 */

/** Why push cannot be turned on. Each one needs different words on screen. */
export type PushFailure =
  | 'unsupported'      // no service worker or no PushManager in this browser
  | 'ios_home_screen'  // iOS: only works from the Home Screen, 16.4 and later
  | 'denied'           // blocked for this site, and the browser will not re-ask
  | 'dismissed'        // the prompt was closed without an answer
  | 'no_key'           // the server is not configured to send push at all
  | 'failed';          // the push service refused the subscription

export class PushError extends Error {
  constructor(public code: PushFailure, message: string) {
    super(message);
    this.name = 'PushError';
  }
}

/**
 * Once someone denies, the browser stops asking — forever, for the whole site.
 * The only route back is site settings, so that is what the message has to say
 * instead of "permission denied".
 */
const DENIED_MESSAGE =
  'Notifications are blocked for this site. Your browser will not ask again, '
  + 'so you have to allow them yourself: open the site settings (the icon next '
  + 'to the address) and switch notifications on, then come back here.';

const IOS_MESSAGE =
  'On an iPhone or iPad, notifications only work once this page is on your '
  + 'Home Screen. Tap Share, then "Add to Home Screen", open it from there and '
  + 'turn notifications on again. It needs iOS 16.4 or later.';

const UNSUPPORTED_MESSAGE =
  'This browser cannot show notifications from a website. Opening this link in '
  + 'Chrome, Edge, Firefox or Safari will work.';

export function pushSupported(): boolean {
  return typeof navigator !== 'undefined'
    && 'serviceWorker' in navigator
    && typeof window !== 'undefined'
    && 'PushManager' in window
    && typeof Notification !== 'undefined';
}

/**
 * An iPhone or an iPad.
 *
 * iPadOS 13 and later report themselves as a Mac, so the user agent alone is
 * not enough; a touch-capable "MacIntel" is an iPad.
 */
export function isIosDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) return true;
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

/** Running from the Home Screen rather than inside the browser. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true
    || window.matchMedia?.('(display-mode: standalone)').matches === true;
}

/**
 * What stops this browser subscribing, before anything is asked of the person.
 *
 * iOS is checked first and deliberately. In Safari on iOS the PushManager is
 * simply absent until the site is launched from the Home Screen, so the
 * generic "unsupported browser" answer would be both wrong and useless: the
 * browser is fine, it is the way the page was opened that is not.
 */
export function pushUnavailable(): { code: PushFailure; message: string } | null {
  if (isIosDevice() && !isStandalone()) {
    return { code: 'ios_home_screen', message: IOS_MESSAGE };
  }
  if (!pushSupported()) return { code: 'unsupported', message: UNSUPPORTED_MESSAGE };
  return null;
}

/**
 * Subscribe this browser, returning the subscription in the shape the Worker
 * stores. Must be called from a click: browsers only allow the permission
 * prompt while a gesture is still fresh.
 */
export async function subscribe(vapidPublicKey: string): Promise<PushSubscriptionJSON> {
  const key = vapidPublicKey.trim();
  if (!key) {
    throw new PushError('no_key', 'Notifications are switched off on this site right now.');
  }

  const blocked = pushUnavailable();
  if (blocked) throw new PushError(blocked.code, blocked.message);

  // Asking before registering would spend the prompt on a browser that might
  // then fail to install the worker.
  await navigator.serviceWorker.register('/sw.js');
  // `ready`, not the value register() resolves with: on a first visit that
  // registration is still installing and has no usable pushManager yet.
  const reg = await navigator.serviceWorker.ready;

  if (Notification.permission === 'denied') throw new PushError('denied', DENIED_MESSAGE);
  const permission = await Notification.requestPermission();
  if (permission === 'denied') throw new PushError('denied', DENIED_MESSAGE);
  if (permission !== 'granted') {
    throw new PushError('dismissed',
      'The browser prompt was closed, so nothing was turned on. Press the button '
      + 'again when you are ready to answer it.');
  }

  const existing = await reg.pushManager.getSubscription();
  // A subscription made against a different server key cannot be reused and
  // cannot be re-subscribed over: the push service rejects it. Drop it first.
  if (existing && !matchesKey(existing, key)) await existing.unsubscribe();
  else if (existing) return existing.toJSON();

  try {
    const sub = await reg.pushManager.subscribe({
      // Required by every browser: a push that shows nothing is not allowed.
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToBytes(key),
    });
    return sub.toJSON();
  } catch (e) {
    throw new PushError('failed',
      'The browser could not set up notifications. This is usually a network '
      + 'problem — try again in a moment.'
      + (e instanceof Error && e.message ? ` (${e.message})` : ''));
  }
}

/** What this browser is subscribed with, if anything. */
export async function currentSubscription(): Promise<PushSubscriptionJSON | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  if (!reg) return null;
  const sub = await reg.pushManager.getSubscription();
  return sub ? sub.toJSON() : null;
}

/**
 * Drop this browser's subscription. It is one subscription per browser, not
 * per watch, so this stops every alert that would have arrived here — the
 * caller has to say so before offering it.
 */
export async function unsubscribe(): Promise<boolean> {
  if (!pushSupported()) return false;
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return false;
  return sub.unsubscribe();
}

// ---------------------------------------------------------------------------

/**
 * The VAPID key travels as base64url text and `subscribe` wants raw bytes.
 * There is no built-in that does base64url, so the two swapped characters are
 * put back and the padding the encoder dropped is added again.
 */
// The return type is left to inference on purpose: writing `Uint8Array` here
// widens its buffer to ArrayBufferLike, which `applicationServerKey` refuses.
function urlBase64ToBytes(base64url: string) {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** Whether an existing subscription was made against this server key. */
function matchesKey(sub: PushSubscription, base64url: string): boolean {
  const raw = sub.options.applicationServerKey;
  if (!raw) return false;
  const have = new Uint8Array(raw);
  const want = urlBase64ToBytes(base64url);
  return have.length === want.length && have.every((b, i) => b === want[i]);
}
