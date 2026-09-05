import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, sentence, type Watch as WatchRow } from '../api';
import Crumbs from '../components/Crumbs';
import SiteFooter from '../components/SiteFooter';
import SiteHeader from '../components/SiteHeader';
import Turnstile, { type TurnstileHandle } from '../components/Turnstile';
import { Icon, Spinner } from '../components/ui';
import {
  PushError, currentSubscription, pushUnavailable, subscribe, unsubscribe,
} from '../lib/push';
import '../styles-alerts.css';
import { useDocumentTitle } from '../lib/title';


/**
 * Standing alerts, at /a and /a/:token.
 *
 * "Tell me when a mobile detailer has an opening near 91403." The whole rest
 * of this site is pull: somebody has to be looking at the map in the couple of
 * hours between a cancellation and someone else taking the slot. Most people
 * are not looking. This is the push half.
 *
 * There is no account, for the same reason the chat threads have none: asking
 * a stranger to choose a password before they can say what they want loses the
 * request. The secret in the link is the whole identity, which makes "keep
 * this link" the most important sentence on the page — it is said on creation,
 * and again every time the page is opened, because nothing here can send a
 * replacement: the address on a watch is used for openings and nothing else.
 *
 * The page has one job beyond collecting the watch: making sure something can
 * actually reach this person. Push is refused, blocked or simply absent often
 * enough that "we will tell you" is a promise the browser alone cannot keep —
 * on an iPhone that has not been added to the Home Screen it does not exist at
 * all. So every dead end below says so, and points at the email field, and a
 * watch with neither channel is called out as the silent failure it is.
 */

/** The five-minute steps a slider offers, and what the server will accept. */
const MIN_DETOUR_MINUTES = 5;
const MAX_DETOUR_MINUTES = 60;
const DEFAULT_DETOUR_MINUTES = 15;

/** The Worker stores at most five trades and a sixty-character label. */
const MAX_TRADES = 5;
const MAX_LABEL_CHARS = 60;
/** And an address no longer than one is allowed to be. */
const MAX_EMAIL_CHARS = 254;

/**
 * Which watches this browser has notifications turned on for.
 *
 * The server has no call that answers "is this browser subscribed to this
 * watch", and one browser holds one push subscription shared across every
 * watch, so the endpoint is remembered here. Cleared storage only costs a
 * second press of a button that does the same thing again.
 */
const regKey = (token: string) => `slotfill.alerts.${token}`;
const readReg = (token: string): string | null => {
  try { return window.localStorage.getItem(regKey(token)); } catch { return null; }
};
const writeReg = (token: string, endpoint: string) => {
  try { window.localStorage.setItem(regKey(token), endpoint); } catch { /* private mode */ }
};
const clearReg = (token: string) => {
  try { window.localStorage.removeItem(regKey(token)); } catch { /* private mode */ }
};

type PushUi =
  | { kind: 'checking' }
  | { kind: 'unavailable'; message: string }
  | { kind: 'blocked' }
  | { kind: 'off' }
  | { kind: 'on' };

/** The server's check, run here first so a typo is caught without a round trip. */
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Why this browser could never show a notification, answered before the person
 * fills anything in.
 *
 * Worth knowing at that moment rather than after: someone who is told up front
 * that their iPhone cannot do this will type an address into the field two
 * inches below, and someone who finds out afterwards has already left.
 */
function pushBlockerNow(): string | null {
  const blocked = pushUnavailable();
  if (blocked) return blocked.message;
  if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
    return 'Notifications are blocked for this site in this browser, and browsers '
      + 'do not ask a second time.';
  }
  return null;
}

export default function WatchPage() {
  const { token } = useParams<{ token?: string }>();
  const navigate = useNavigate();

  const [watch, setWatch] = useState<WatchRow | null>(null);
  // The label a person gave their own watch is not used here: it is private,
  // and the tab strip is the one place on a shared screen it would be read out
  // loud. "Your watch" says which page this is without saying whose.
  useDocumentTitle(token ? 'Your watch' : 'Alert me');
  const [link, setLink] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(token));
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** Created a moment ago, so the link gets the loudest version of the warning. */
  const [fresh, setFresh] = useState(false);

  const [tradeList, setTradeList] = useState<string[] | null>(null);
  const [tradesFailed, setTradesFailed] = useState(false);
  /** undefined while the key is being fetched; null means push is switched off. */
  const [vapid, setVapid] = useState<string | null | undefined>(undefined);

  // Carries a freshly created watch across the navigation to its own URL, so
  // the page does not immediately re-fetch what it was just handed.
  const preloaded = useRef<{ token: string; watch: WatchRow; link: string } | null>(null);

  useEffect(() => {
    let alive = true;
    api.trades()
      .then((r) => { if (alive) setTradeList(r.trades); })
      .catch(() => { if (alive) setTradesFailed(true); });
    api.vapidKey()
      .then((r) => { if (alive) setVapid(r.key); })
      .catch(() => { if (alive) setVapid(null); });
    return () => { alive = false; };
  }, []);

  const load = useCallback(async (t: string) => {
    setLoading(true); setError(null); setMissing(false);
    try {
      const res = await api.watch(t);
      setWatch(res.watch);
      // Only createWatch returns the link. On a later visit we are standing on
      // it, so the address bar is the honest source.
      setLink(window.location.href);
    } catch (e) {
      // A link that was half-copied or has been deleted is an ordinary
      // outcome, not a fault, and gets its own wording.
      if (e instanceof ApiError && e.status === 404) setMissing(true);
      else setError(e instanceof Error ? e.message : 'Could not open this watch.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setEditing(false); setConfirmDelete(false); setSaveError(null);
    if (!token) {
      setWatch(null); setLink(null); setLoading(false); setMissing(false); setError(null);
      return;
    }
    const pre = preloaded.current;
    if (pre && pre.token === token) {
      setWatch(pre.watch); setLink(pre.link);
      setLoading(false); setMissing(false); setError(null);
      return;
    }
    setFresh(false);
    void load(token);
  }, [token, load]);

  // --- notifications, for this browser ------------------------------------
  /** Read once: none of it can change while the page is open. */
  const [pushBlocker] = useState(pushBlockerNow);
  const [push, setPush] = useState<PushUi>({ kind: 'checking' });
  const [pushError, setPushError] = useState<string | null>(null);
  const [pushBusy, setPushBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    let alive = true;
    setPushError(null);
    void (async () => {
      const blocked = pushUnavailable();
      if (blocked) { if (alive) setPush({ kind: 'unavailable', message: blocked.message }); return; }
      if (Notification.permission === 'denied') { if (alive) setPush({ kind: 'blocked' }); return; }
      const sub = await currentSubscription();
      const saved = readReg(token);
      if (!alive) return;
      setPush(sub && saved && sub.endpoint === saved ? { kind: 'on' } : { kind: 'off' });
    })();
    return () => { alive = false; };
  }, [token]);

  const turnOn = async () => {
    if (!token || !vapid) return;
    setPushBusy(true); setPushError(null);
    try {
      const sub = await subscribe(vapid);
      if (!sub.endpoint) throw new PushError('failed', 'The browser returned an empty subscription.');
      await api.addPushSubscription(token, sub);
      writeReg(token, sub.endpoint);
      setPush({ kind: 'on' });
    } catch (e) {
      if (e instanceof PushError) {
        setPushError(e.message);
        if (e.code === 'denied') setPush({ kind: 'blocked' });
        if (e.code === 'unsupported' || e.code === 'ios_home_screen') {
          setPush({ kind: 'unavailable', message: e.message });
        }
      } else {
        setPushError(e instanceof Error ? e.message : 'Notifications could not be turned on.');
      }
    } finally {
      setPushBusy(false);
    }
  };

  const turnOff = async () => {
    if (!token) return;
    setPushBusy(true); setPushError(null);
    try {
      const sub = await currentSubscription();
      if (sub?.endpoint) await api.removePushSubscription(token, sub.endpoint);
      await unsubscribe();
      clearReg(token);
      setPush({ kind: 'off' });
    } catch (e) {
      setPushError(e instanceof Error ? e.message : 'That did not switch off. Try again.');
    } finally {
      setPushBusy(false);
    }
  };

  // --- create, edit, pause, delete ----------------------------------------
  const create = async (v: FormValues, captcha: string | null) => {
    const res = await api.createWatch({
      postcode: v.postcode,
      trades: v.anyTrade || v.trades.length === 0 ? null : v.trades,
      max_detour_seconds: v.detourMinutes * 60,
      max_price_cents: parsePrice(v.priceCap),
      label: v.label.trim(),
      email: v.email.trim(),
      // Only ever present when the widget drew and was solved. Absent is the
      // normal case today and the Worker treats it as it always has.
      ...(captcha ? { turnstile_token: captcha } : {}),
    });
    preloaded.current = { token: res.token, watch: res.watch, link: res.link };
    setFresh(true);
    navigate(`/a/${res.token}`);
  };

  const saveEdit = async (v: FormValues) => {
    if (!token) return;
    const res = await api.updateWatch(token, {
      postcode: v.postcode,
      trades: v.anyTrade || v.trades.length === 0 ? null : v.trades,
      max_detour_seconds: v.detourMinutes * 60,
      max_price_cents: parsePrice(v.priceCap),
      label: v.label.trim(),
      // Empty clears it. Someone deleting the address is switching the channel
      // off, which has to be possible from the same box they typed it into.
      email: v.email.trim(),
    });
    setWatch(res.watch);
    setEditing(false);
  };

  const setActive = async (active: boolean) => {
    if (!token) return;
    setSaving(true); setSaveError(null);
    try {
      const res = await api.updateWatch(token, { active });
      setWatch(res.watch);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'That did not save. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!token) return;
    setSaving(true); setSaveError(null);
    try {
      await api.deleteWatch(token);
      clearReg(token);
      preloaded.current = null;
      navigate('/a', { replace: true });
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'That did not delete. Try again.');
      setSaving(false);
    }
  };

  return (
    <div className="land">
      {/* The bar this replaces held one link, "Book near you", pointing at the
          front page — which is where the wordmark in the shared header goes,
          so nothing is lost by dropping it. What is gained is the search box:
          somebody who lands here and decides they would rather look for an
          opening now than wait to be told about one no longer has to guess
          that the wordmark is a link. */}
      <SiteHeader />

      {/*
        Both blocks below go inside one <main>: the form, and the footnote
        about what this page does with an address. That footnote is a
        <footer>, and a <footer> outside every sectioning element is a
        contentinfo landmark — so out here it was a second "page footer"
        competing with the real one underneath, and anybody cycling
        landmarks met two of them. Inside <main> it is an ordinary block
        again, which is all it ever was on the page.
      */}
      <main id="main" tabIndex={-1}>
      <div className="wrap alerts">
        {/*
          Two shapes, because /a and /a/:token are two different pages behind
          one route. Creating a watch is a top-level page and gets the one-step
          trail every other top-level page has; managing one sits under it, and
          its parent crumb is a real destination — "set up another".

          The watch's own label is deliberately not used as the last crumb. It
          is a name somebody gave a private, secret-token page, and Crumbs
          publishes every crumb into a BreadcrumbList; "Home" or "Mum's house"
          is not something to emit as structured data.
        */}
        <Crumbs items={token
          ? [{ label: 'Alert me', to: '/a' }, { label: 'Your watch' }]
          : [{ label: 'Alert me' }]} />

        {/* --- no token: make one ------------------------------------------ */}
        {!token && (
          <>
            <section className="alert-head">
              <span className="eyebrow">Openings alerts</span>
              <h1>Get told when a van has an hour free near you</h1>
              <p className="alert-lede">
                Say where you are and what you want done. When a job cancels
                near you, your browser tells you — or your email does, if you
                give one. Usually within minutes of the business losing the
                hour, which is when the price is lowest.
              </p>
            </section>

            {vapid === null && (
              <div className="notice" role="status">
                Notifications are switched off on this site at the moment, so
                nothing can be sent to your browser. Fill in the email address
                below and the alerts will go there instead.
              </div>
            )}

            {vapid !== null && pushBlocker && (
              <div className="notice" role="status">
                <strong>This browser cannot show notifications.</strong>{' '}
                {pushBlocker} Fill in the email address below and the alerts
                will go there instead — it is the only way we could reach you
                from here.
              </div>
            )}

            <WatchForm
              key="new"
              initial={emptyForm()}
              trades={tradeList}
              tradesFailed={tradesFailed}
              submitLabel="Create this watch"
              onSubmit={create}
              challenge
            />

            <div className="notice keeper">
              <strong>You already have one?</strong> Open the link you saved when
              you made it. There is no account and no password here, so nobody —
              including us — can look your watch up for you.
            </div>
          </>
        )}

        {/* --- a token: show it -------------------------------------------- */}
        {token && loading && <Spinner label="Opening your watch" />}

        {token && !loading && missing && (
          <div className="blank" style={{ marginTop: 60 }}>
            <p style={{ margin: '0 0 14px' }}>
              There is no watch at this link. Links usually stop working because
              only part of one was copied, or because the watch was deleted.
            </p>
            <p style={{ margin: '0 0 14px' }}>
              If you have the full link saved somewhere, open it from there.
              Otherwise you can set up a new one.
            </p>
            <Link className="btn sm" to="/a">Set up a new watch</Link>
          </div>
        )}

        {token && !loading && !missing && error && (
          <div className="stack" style={{ marginTop: 60 }}>
            <div className="error">{error}</div>
            <button className="btn quiet sm" onClick={() => void load(token)}>Try again</button>
          </div>
        )}

        {token && !loading && watch && (
          <>
            <section className="alert-head">
              <span className="eyebrow">
                {watch.active ? 'Watching' : 'Paused'}
              </span>
              <h1>{watch.label?.trim() || `Openings near ${watch.postcode}`}</h1>
              {!watch.active && (
                <p className="alert-lede">
                  This watch is off. Nothing will be sent until you turn it back on.
                </p>
              )}
            </section>

            {fresh && (
              <div className="notice keeper" role="status">
                <strong>Your watch is set up.</strong> The address of this page is
                the only way back to it. Save it now — bookmark it, or send it to
                yourself — before you close the tab.
              </div>
            )}

            {saveError && <div className="error">{saveError}</div>}

            {/* The point of the whole page. A watch that matches an opening
                and has nowhere to send it is worse than no watch: the person
                believes they are covered. Said before the two panels that
                could fix it, and only once the browser check has finished, so
                it does not flash on every load. */}
            {push.kind !== 'checking' && push.kind !== 'on' && !watch.email && (
              <div className="notice silent" role="alert">
                <strong>Nothing can reach you yet.</strong> Notifications are not
                on in this browser and there is no email address on this watch,
                so when an opening appears there is no way to tell you about it.{' '}
                {/* Only offer the button when there is a button to press: with
                    push switched off on the site, or refused by this browser,
                    the address is the only thing left that can work. */}
                {vapid !== null && push.kind === 'off'
                  ? 'Turn notifications on below, or press Edit and add an email address.'
                  : 'Press Edit below and add an email address — it is the only '
                    + 'thing that can reach you from here.'}
              </div>
            )}

            {/* --- notifications ------------------------------------------ */}
            {vapid !== null && (
              <section className="card alert-card">
                <h2>Notifications</h2>
                {vapid === undefined ? (
                  <p className="muted">Checking whether notifications can be sent…</p>
                ) : (
                  <PushPanel
                    state={push} busy={pushBusy} error={pushError}
                    hasEmail={Boolean(watch.email)}
                    onOn={turnOn} onOff={turnOff}
                  />
                )}
              </section>
            )}

            {vapid === null && (
              <div className="notice" role="status">
                Notifications are switched off on this site at the moment, so
                nothing will be sent to your browser. Your watch is saved.{' '}
                {watch.email
                  ? 'Alerts will go to your email address in the meantime.'
                  : 'Press Edit below and add an email address, or nothing will '
                    + 'reach you until notifications are switched back on.'}
              </div>
            )}

            {/* --- what is being watched ---------------------------------- */}
            <section className="card alert-card">
              <div className="spread">
                <h2>What you asked for</h2>
                {!editing && (
                  <button type="button" className="btn quiet sm"
                    onClick={() => setEditing(true)}>
                    Edit
                  </button>
                )}
              </div>

              {editing ? (
                <WatchForm
                  key={watch.id}
                  initial={formFrom(watch)}
                  trades={tradeList}
                  tradesFailed={tradesFailed}
                  submitLabel="Save changes"
                  onSubmit={saveEdit}
                  onCancel={() => setEditing(false)}
                />
              ) : (
                <dl className="pairs">
                  <dt>Where</dt>
                  <dd>{watch.postcode}</dd>
                  <dt>Trades</dt>
                  <dd>{describeTrades(watch.trades)}</dd>
                  <dt>Detour</dt>
                  <dd>Up to {Math.round(watch.max_detour_seconds / 60)} minutes out of their way</dd>
                  <dt>Price</dt>
                  <dd>
                    {watch.max_price_cents === null
                      ? 'Any price'
                      : `Up to ${priceLabel(watch.max_price_cents)}`}
                  </dd>
                </dl>
              )}
            </section>

            {/* --- the link ------------------------------------------------ */}
            {link && (
              <section className="card alert-card">
                <h2>Keep this link</h2>
                <p className="muted" style={{ marginTop: 0 }}>
                  It is the only way back to this watch. There is no account and
                  no password, and an address on this watch is used for openings
                  and nothing else — it will never be sent this link. Anyone who
                  has the link can change or delete the watch, so keep it to
                  yourself.
                </p>
                <CopyLink link={link} />
              </section>
            )}

            {/* --- off, and gone ------------------------------------------ */}
            <section className="card alert-card">
              <h2>Turn it off</h2>
              <div className="alert-actions">
                <button type="button" className="btn quiet" disabled={saving}
                  onClick={() => void setActive(!watch.active)}>
                  {watch.active ? 'Pause this watch' : 'Turn this watch back on'}
                </button>
                {!confirmDelete ? (
                  <button type="button" className="btn quiet" disabled={saving}
                    onClick={() => setConfirmDelete(true)}>
                    Delete it
                  </button>
                ) : (
                  <span className="alert-confirm">
                    <span>Delete for good?</span>
                    <button type="button" className="btn alert sm" disabled={saving}
                      onClick={() => void remove()}>
                      {saving ? 'Deleting…' : 'Yes, delete'}
                    </button>
                    <button type="button" className="btn quiet sm" disabled={saving}
                      onClick={() => setConfirmDelete(false)}>
                      Keep it
                    </button>
                  </span>
                )}
              </div>
              <p className="muted" style={{ marginBottom: 0 }}>
                Pausing keeps the watch and this link. Deleting throws both away
                and cannot be undone.
              </p>
            </section>
          </>
        )}
      </div>

      {/* This page's own footnote stays above the shared footer: it is what
          this page does with an address and a browser, which is the question a
          person filling the form in is actually asking, and nothing in the
          shared footer answers it. */}
      <div className="wrap">
        <footer className="foot">
          <p>
            No phone number is asked for and none is stored. Alerts go through
            your browser, and to your email address if you gave one — for
            openings this watch matches, and nothing else. You can switch either
            off from this page.
          </p>
        </footer>
      </div>
      </main>

      <SiteFooter />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notifications panel
// ---------------------------------------------------------------------------
/**
 * Whether this browser can be made to work, and what to do when it cannot.
 *
 * Three of the five states are dead ends — unsupported, blocked, and an iPhone
 * that is not on the Home Screen — and a browser is not going to change its
 * mind about any of them. Saying only "not available" there leaves someone
 * with a watch that can never fire, so each one names the other channel and
 * where the field for it is. `hasEmail` decides whether that is an instruction
 * or a reassurance; it must never be silence.
 */
function PushPanel({ state, busy, error, hasEmail, onOn, onOff }: {
  state: PushUi; busy: boolean; error: string | null; hasEmail: boolean;
  onOn: () => Promise<void>; onOff: () => Promise<void>;
}) {
  const fallback = hasEmail
    ? 'Your email address is on this watch, so openings will be emailed to you instead.'
    : 'Press Edit below and add an email address — that is the only other way '
      + 'we can tell you an opening has come up.';

  return (
    <div className="stack">
      {state.kind === 'checking' && <p className="muted">Checking this browser…</p>}

      {state.kind === 'unavailable' && (
        <>
          <p className="push-state off"><i />Not available in this browser</p>
          <p className="muted" style={{ marginBottom: 0 }}>{state.message}</p>
          <p className={hasEmail ? 'muted' : 'field-note bad'} style={{ marginBottom: 0 }}>
            {fallback}
          </p>
        </>
      )}

      {state.kind === 'blocked' && (
        <>
          <p className="push-state off"><i />Blocked for this site</p>
          <p className="muted" style={{ marginBottom: 0 }}>
            Notifications were turned down here at some point, and browsers do
            not ask twice. To let them through, open this site's settings — the
            icon next to the address — allow notifications, then reload this
            page. Your watch is saved either way.
          </p>
          <p className={hasEmail ? 'muted' : 'field-note bad'} style={{ marginBottom: 0 }}>
            {fallback}
          </p>
        </>
      )}

      {state.kind === 'off' && (
        <>
          <p className="push-state off"><i />Off in this browser</p>
          <p className="muted">
            Turning them on asks your browser for permission once.{' '}
            {hasEmail
              ? 'Openings are emailed to you either way; this puts them on this '
                + 'device as well.'
              : 'Until you do — or add an email address below — nothing will '
                + 'reach you.'}
          </p>
          <button type="button" className="btn" disabled={busy} onClick={() => void onOn()}>
            {busy ? 'Turning on…' : 'Turn on notifications'}
          </button>
        </>
      )}

      {state.kind === 'on' && (
        <>
          <p className="push-state on"><Icon name="tick" size={16} />On in this browser</p>
          <p className="muted">
            At most one alert an hour, and five in a day — the same one alert,
            whether it comes by notification, by email, or by both. Notifications
            arrive on this device only; open this link on another one and turn
            them on there too.
          </p>
          <button type="button" className="btn quiet" disabled={busy} onClick={() => void onOff()}>
            {busy ? 'Turning off…' : 'Stop alerts in this browser'}
          </button>
          <p className="faint" style={{ margin: 0 }}>
            That switches this browser off for every watch you have here.
          </p>
        </>
      )}

      {error && <div className="error">{error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The link, and getting it somewhere safe
// ---------------------------------------------------------------------------
function CopyLink({ link }: { link: string }) {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');

  const copy = async () => {
    // The clipboard API is missing on plain http and in some in-app browsers.
    if (!navigator.clipboard) { setCopied('fail'); return; }
    try { await navigator.clipboard.writeText(link); setCopied('ok'); }
    catch { setCopied('fail'); }
  };

  return (
    <div className="stack">
      <div className="link-row">
        <label className="grow">
          <span className="sr-only">Your watch link</span>
          <input className="link-box mono" readOnly value={link}
            onFocus={(e) => e.currentTarget.select()} />
        </label>
        <button type="button" className="btn sm" onClick={() => void copy()}>Copy</button>
      </div>
      <p className="muted" role="status" style={{ margin: 0 }}>
        {copied === 'ok' && 'Copied. Paste it somewhere you will find it again.'}
        {copied === 'fail'
          && 'Copying did not work in this browser. Select the address above and copy it by hand.'}
        {copied === 'idle' && 'Bookmark this page, or send the address to yourself.'}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The form, shared by "create" and "edit"
// ---------------------------------------------------------------------------
interface FormValues {
  postcode: string;
  anyTrade: boolean;
  trades: string[];
  detourMinutes: number;
  priceCap: string;
  email: string;
  label: string;
}

const emptyForm = (): FormValues => ({
  postcode: '', anyTrade: true, trades: [],
  detourMinutes: DEFAULT_DETOUR_MINUTES, priceCap: '', email: '', label: '',
});

const formFrom = (w: WatchRow): FormValues => ({
  postcode: w.postcode,
  anyTrade: w.trades === null || w.trades.length === 0,
  trades: w.trades ?? [],
  detourMinutes: clampMinutes(Math.round(w.max_detour_seconds / 60)),
  priceCap: w.max_price_cents === null ? '' : priceLabel(w.max_price_cents),
  email: w.email ?? '',
  label: w.label ?? '',
});

function WatchForm({
  initial, trades, tradesFailed, submitLabel, onSubmit, onCancel, challenge = false,
}: {
  initial: FormValues;
  trades: string[] | null;
  tradesFailed: boolean;
  submitLabel: string;
  /** The token is null unless a widget drew and was solved. Editing ignores it. */
  onSubmit: (v: FormValues, turnstileToken: string | null) => Promise<void>;
  onCancel?: () => void;
  /**
   * Whether this instance of the form is creating a watch.
   *
   * Only creation is challenged. Editing, pausing and deleting a watch all
   * need the token in the link, so the person doing them has already proved
   * the one thing a challenge could establish — and a bot check standing
   * between somebody and the price cap on their own alert is friction for
   * nothing. Off by default so a future caller has to ask for it deliberately.
   */
  challenge?: boolean;
}) {
  const [v, setV] = useState<FormValues>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [badPostcode, setBadPostcode] = useState(false);
  const [badPrice, setBadPrice] = useState(false);
  const [badEmail, setBadEmail] = useState(false);
  const postcodeRef = useRef<HTMLInputElement | null>(null);
  // A ref, not state: nothing on this form is drawn differently because a
  // challenge has been solved, and putting the token in state would re-render
  // the widget's own parent every time Cloudflare refreshed it.
  const captcha = useRef<string | null>(null);
  const widget = useRef<TurnstileHandle | null>(null);

  const set = <K extends keyof FormValues>(k: K, value: FormValues[K]) =>
    setV((prev) => ({ ...prev, [k]: value }));

  const toggleTrade = (t: string) => setV((prev) => {
    const on = prev.trades.includes(t);
    if (!on && prev.trades.length >= MAX_TRADES) return prev;
    const next = on ? prev.trades.filter((x) => x !== t) : [...prev.trades, t];
    // Picking a trade means you are no longer asking for all of them, and
    // taking the last one back means you are again.
    return { ...prev, trades: next, anyTrade: next.length === 0 };
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const postcode = v.postcode.trim();
    if (!postcode) {
      setBadPostcode(true);
      postcodeRef.current?.focus();
      return;
    }
    if (parsePrice(v.priceCap) === undefined) { setBadPrice(true); return; }
    // Empty is fine — the field is optional. Anything else has to look like an
    // address, because a typo here is a channel that silently never delivers.
    const email = v.email.trim();
    if (email && !EMAIL_SHAPE.test(email)) { setBadEmail(true); return; }
    setBadPostcode(false); setBadPrice(false); setBadEmail(false);
    setBusy(true); setError(null);
    try {
      await onSubmit({ ...v, postcode, email }, captcha.current);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not save. Try again.');
      // Whatever went wrong, the token that was spent on the attempt is gone —
      // they are single-use — so the next press needs a fresh one. Everything
      // typed stays exactly where it is; it is React state and nothing here
      // touches it.
      captcha.current = null;
      widget.current?.reset();
    } finally {
      setBusy(false);
    }
  };

  const full = !v.anyTrade && v.trades.length >= MAX_TRADES;

  return (
    <form className="watch-form" onSubmit={submit} noValidate>
      <label htmlFor="wf-postcode">
        Where are you?
        <input id="wf-postcode" ref={postcodeRef} value={v.postcode}
          onChange={(e) => { set('postcode', e.target.value); setBadPostcode(false); }}
          placeholder="Postcode or ZIP" autoComplete="postal-code" inputMode="text"
          aria-invalid={badPostcode || undefined}
          aria-describedby={badPostcode ? 'wf-postcode-err' : 'wf-postcode-hint'} />
      </label>
      {badPostcode ? (
        <p className="field-note bad" id="wf-postcode-err">
          A postcode is needed. It is how we work out which vans are anywhere near you.
        </p>
      ) : (
        <p className="field-note" id="wf-postcode-hint">
          Only the postcode, never a street address. It is what the distance is measured from.
        </p>
      )}

      <fieldset className="watch-field">
        <legend>What do you want done?</legend>
        {trades === null && !tradesFailed && <p className="field-note">Loading trades…</p>}
        {tradesFailed && (
          <p className="field-note">
            The list of trades could not be loaded, so this watch will cover
            every trade. You can narrow it later.
          </p>
        )}
        {trades !== null && trades.length === 0 && (
          <p className="field-note">
            No trades are listed yet, so this watch will cover every one of them.
          </p>
        )}
        {trades !== null && trades.length > 0 && (
          <>
            <div className="chip-wrap">
              <button type="button" aria-pressed={v.anyTrade}
                className={`trade-chip${v.anyTrade ? ' on' : ''}`}
                onClick={() => setV((prev) => ({ ...prev, anyTrade: true, trades: [] }))}>
                Any trade
              </button>
              {trades.map((t) => {
                const on = v.trades.includes(t);
                return (
                  <button key={t} type="button" aria-pressed={on}
                    className={`trade-chip${on ? ' on' : ''}`}
                    disabled={!on && full}
                    onClick={() => toggleTrade(t)}>
                    {sentence(t)}
                  </button>
                );
              })}
            </div>
            <p className="field-note" aria-live="polite">
              {full
                ? 'Five trades is the most one watch can hold. Unpick one to swap it.'
                : 'Pick as many as you like, up to five.'}
            </p>
          </>
        )}
      </fieldset>

      <label htmlFor="wf-detour">
        How far out of their way?
        <span className="range-row">
          <input id="wf-detour" type="range" className="range"
            min={MIN_DETOUR_MINUTES} max={MAX_DETOUR_MINUTES} step={5}
            value={v.detourMinutes}
            onChange={(e) => set('detourMinutes', Number(e.target.value))}
            aria-describedby="wf-detour-hint" />
          <output className="range-out num" htmlFor="wf-detour">{v.detourMinutes} min</output>
        </span>
      </label>
      <p className="field-note" id="wf-detour-hint">
        An opening only reaches you if the driver is already close. A shorter
        detour means fewer alerts, and a shorter trip for whoever takes it.
      </p>

      <label htmlFor="wf-price">
        Most you would pay <span className="opt">optional</span>
        <input id="wf-price" value={v.priceCap} inputMode="decimal"
          onChange={(e) => { set('priceCap', e.target.value); setBadPrice(false); }}
          placeholder="No limit"
          aria-invalid={badPrice || undefined}
          aria-describedby={badPrice ? 'wf-price-err' : 'wf-price-hint'} />
      </label>
      {badPrice ? (
        <p className="field-note bad" id="wf-price-err">
          Use a plain number, like 60. Leave it empty for no limit.
        </p>
      ) : (
        <p className="field-note" id="wf-price-hint">
          In the currency prices are shown in on this site. Openings priced above
          this will not reach you.
        </p>
      )}

      <label htmlFor="wf-email">
        Email me when something opens <span className="opt">optional</span>
        <input id="wf-email" type="email" value={v.email} inputMode="email"
          autoComplete="email" maxLength={MAX_EMAIL_CHARS}
          onChange={(e) => { set('email', e.target.value); setBadEmail(false); }}
          placeholder="you@example.com"
          aria-invalid={badEmail || undefined}
          aria-describedby={badEmail ? 'wf-email-err' : 'wf-email-hint'} />
      </label>
      {badEmail ? (
        <p className="field-note bad" id="wf-email-err">
          That does not look like an email address. Check it, or clear the box
          to leave it out.
        </p>
      ) : (
        <p className="field-note" id="wf-email-hint">
          Used for one thing only: telling you when an opening near you matches
          this watch. No newsletters, nothing else, ever — and it is deleted
          with the watch. Worth filling in if your browser cannot show
          notifications, or you would rather not turn them on.
        </p>
      )}

      <label htmlFor="wf-label">
        Name this watch <span className="opt">optional</span>
        <input id="wf-label" value={v.label} maxLength={MAX_LABEL_CHARS}
          onChange={(e) => set('label', e.target.value)}
          placeholder="Home" aria-describedby="wf-label-hint" />
      </label>
      <p className="field-note" id="wf-label-hint">
        Only for you, so you can tell two watches apart.
      </p>

      {/* After the last field and before the button, so tabbing through the
          form reaches it in the order it is read. Draws nothing at all until a
          site key is configured, which is every build today. */}
      {challenge && (
        <Turnstile ref={widget} action="watch"
          onToken={(t) => { captcha.current = t; }} />
      )}

      {error && <div className="error">{error}</div>}

      <div className="watch-submit">
        <button type="submit" className="btn" disabled={busy}>
          {busy ? 'Saving…' : submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="btn quiet" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------

const clampMinutes = (m: number) =>
  Math.min(MAX_DETOUR_MINUTES, Math.max(MIN_DETOUR_MINUTES, m));

/**
 * The price cap, from what was typed.
 *
 * `null` is "no limit" and `undefined` is "that is not a number" — two answers
 * the form has to tell apart, because one is a valid choice and the other is a
 * mistake worth pointing at.
 */
function parsePrice(raw: string): number | null | undefined {
  const text = raw.trim().replace(/,/g, '.');
  if (!text) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return undefined;
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  return Math.round(amount * 100);
}

/**
 * Cents back to something readable.
 *
 * No currency symbol: a watch belongs to a postcode, not to a business, so
 * there is no operator record here to take a currency from. Writing one in
 * would be a guess.
 */
const priceLabel = (cents: number) =>
  cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);

const describeTrades = (trades: string[] | null) =>
  trades && trades.length > 0 ? trades.map(sentence).join(', ') : 'Any trade';
