import {
  useCallback, useEffect, useMemo, useRef, useState, type FormEvent,
} from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ApiError, api, durationLabel,
  type PricedItem, type PricedOrder, type PricedService, type PublicSlot,
} from '../api';
import PaymentState from '../components/PaymentState';
import SiteHeader from '../components/SiteHeader';
import Turnstile, { type TurnstileHandle } from '../components/Turnstile';
import { Icon, Spinner } from '../components/ui';
import '../styles-book.css';
import '../styles-parts.css';
import { useDocumentTitle } from '../lib/title';

/**
 * Checkout, at /book/:gapId.
 *
 * This replaces a server-rendered page that sold exactly one thing: one
 * opening, one service, chosen for the customer. Somebody who wanted a wash
 * and an interior clean, or a slot today and another on Saturday, had no way
 * to say so.
 *
 * So this is a basket, not a form. You land on one opening, tick the services
 * you want from it, and can go back to the map and add another — at a
 * different business, on a different day. The basket lives in sessionStorage
 * because leaving this page to fetch a second opening is a full navigation and
 * would otherwise empty it.
 *
 * Nothing on this page is calculated in the browser. Every price, length and
 * time comes back from the Worker's priceOrder, which is read-only and safe to
 * call on every tick; the browser only decides when to ask.
 */

/** Openings the Worker will take in one order. Its own limit is the same. */
const MAX_ITEMS = 10;
/** Services the Worker will price for one opening. Its own limit is the same. */
const MAX_SERVICES = 10;
/** Long enough that a fast clicker fires one request, short enough to feel live. */
const DEBOUNCE_MS = 350;

const KEY = 'slotfill.basket';

interface BasketItem { gap_id: string; service_ids: string[] }

/**
 * Every problem code priceOrder and placeOrder can return, in words that say
 * what to do next.
 *
 * The Worker sends a message with each one and it is a good message. These are
 * written anyway because the Worker's copy has to work for an API caller,
 * while this page knows there is a basket on screen with a Remove button next
 * to the offending line. An unrecognised code falls back to the server's text
 * rather than to something vague.
 */
const PROBLEM: Record<string, string> = {
  slot_gone: 'This opening is not listed any more. The business withdrew it.',
  slot_taken: 'Somebody else booked this opening while you were choosing. '
    + 'Nothing of yours has been booked — remove it and the rest of your basket stands.',
  slot_passed: 'This opening has already started, so it can no longer be booked.',
  too_long: 'The services ticked for this opening run past the end of it. '
    + 'Untick one, or use a longer opening.',
  mixed_currency: 'The businesses in your basket bill in different currencies. '
    + 'Book one currency at a time.',
  too_far: 'This business cannot reach your address and still keep the rest of '
    + 'their day. Try an opening closer to you.',
  bad_phone: 'That mobile number does not look right. Include the area code.',
  no_address: 'At least one of these businesses comes to you, so they need a '
    + 'street address or a ZIP.',
  bad_address: 'We could not find that address. Check the street and the ZIP.',
  no_name: 'Add the name this booking should be under.',
  no_service: 'Tick at least one service for this opening.',
  service_not_in_slot: 'One of the services ticked is not offered in this '
    + 'particular opening.',
  bad_service: 'This business does not offer one of the services ticked here.',
  duplicate_gap: 'This opening is already in your basket further up.',
  empty_order: 'Your basket is empty. Tick a service to start one.',
  too_many_items: `A basket holds up to ${MAX_ITEMS} openings. Remove one before adding another.`,
  not_bookable: 'This basket cannot be booked as it stands. Check the notes on '
    + 'each opening above.',
  // The three the Worker's Turnstile check can send back. All of them say the
  // same thing to the customer — nothing you did was wrong, press it again —
  // because none of them is a mistake they can correct, and the widget below
  // has already been reset by the time they read this. Everything typed is
  // still on screen; that is the point of saying so.
  turnstile_missing: 'The check that you are a person did not come through. '
    + 'Nothing is lost — press Book again, and reload the page if it happens twice.',
  turnstile_failed: 'That check did not pass. Nothing is lost — it has reset '
    + 'itself, so press Book again.',
  turnstile_unavailable: 'The security check is not answering at the moment. '
    + 'Nothing is lost — wait a few seconds and press Book again.',
};

const say = (code: string, fallback: string) => PROBLEM[code] ?? fallback;

/** Codes nothing on this page can fix. The only way forward is to drop the item. */
const FATAL = new Set(['slot_gone', 'slot_taken', 'slot_passed', 'duplicate_gap', 'too_far']);

// --- the basket, kept across a trip back to the map -------------------------
// sessionStorage, not localStorage: a basket is one visit's worth of intent.
// Finding last week's half-finished order waiting is worse than starting again.
function readBasket(): BasketItem[] {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((row): BasketItem[] => {
      if (typeof row !== 'object' || row === null) return [];
      const r = row as Record<string, unknown>;
      const gap = typeof r.gap_id === 'string' ? r.gap_id : '';
      const ids = Array.isArray(r.service_ids)
        ? r.service_ids.filter((s): s is string => typeof s === 'string') : [];
      return gap && ids.length ? [{ gap_id: gap, service_ids: ids }] : [];
    }).slice(0, MAX_ITEMS);
  } catch {
    return [];                                  // private mode, or someone's edit
  }
}

function writeBasket(rows: BasketItem[]) {
  try {
    if (rows.length) window.sessionStorage.setItem(KEY, JSON.stringify(rows));
    else window.sessionStorage.removeItem(KEY);
  } catch { /* private mode: the basket just does not survive the trip */ }
}

/** What this business will actually do in this opening. */
interface Menu {
  gapId: string;
  businessName: string;
  services: PricedService[];
  /** The whole opening, start to far edge. What "does it still fit" is measured against. */
  windowSeconds: number;
  slot: PublicSlot | null;
}

type MenuState = 'loading' | 'ready' | 'nolist' | 'gone' | 'error';

export default function Book() {
  const { gapId } = useParams<{ gapId: string }>();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // Carried through from the old flow: /book/:id?t=<thread token> keeps a
  // booking attached to the conversation the customer already started.
  const threadToken = params.get('t');

  const [basket, setBasket] = useState<BasketItem[]>(readBasket);
  useEffect(() => { writeBasket(basket); }, [basket]);

  const [menu, setMenu] = useState<Menu | null>(null);
  const [menuState, setMenuState] = useState<MenuState>('loading');
  const [menuError, setMenuError] = useState<string | null>(null);
  /** Why this opening cannot be booked, when the Worker gave a reason. */
  const [goneWhy, setGoneWhy] = useState<string | null>(null);

  const [priced, setPriced] = useState<PricedOrder | null>(null);
  const [pricing, setPricing] = useState(false);
  const [priceError, setPriceError] = useState<string | null>(null);
  /** Bumped to re-price after a checkout conflict, so the bad line names itself. */
  const [recheck, setRecheck] = useState(0);

  /**
   * Every service in the basket that has something to say about parts, once
   * each. De-duplicated on the sentence rather than on the service, because a
   * customer taking the same job at two different times does not need to read
   * the same warning twice — and because the whole point of building the
   * sentence on the server is that identical situations produce identical
   * words.
   */
  const partsLines = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ key: string; name: string; line: string; note: string | null }> = [];
    for (const item of priced?.items ?? []) {
      for (const svc of item.services) {
        if (!svc.parts_line) continue;
        const key = `${svc.name}|${svc.parts_line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ key, name: svc.name, line: svc.parts_line, note: svc.parts_note });
      }
    }
    return out;
  }, [priced]);

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [zip, setZip] = useState(params.get('postcode') ?? '');

  const [placing, setPlacing] = useState(false);
  const [placeError, setPlaceError] = useState<string | null>(null);

  /**
   * The bot check, when there is one.
   *
   * Held in a ref rather than in state on purpose: this page re-prices the
   * basket on a debounce while somebody ticks services, and putting the token
   * in state would re-render the form — and the widget with it — for a value
   * nothing on screen depends on. The ref is read once, at submit.
   *
   * Null covers three cases that are all the same to this page: no site key
   * so no widget exists, a widget that could not load, and a token that
   * expired while the address was being typed. In every one of them the order
   * is sent anyway and the Worker has the last word, because a customer
   * stranded behind a third party's bad afternoon is a worse outcome than a
   * scripted order the Worker was going to refuse regardless.
   */
  const captcha = useRef<string | null>(null);
  const widget = useRef<TurnstileHandle | null>(null);

  // ---------------------------------------------------------------------
  // What this opening can do
  //
  // One request, answered by the Worker: every service this business will do
  // in THIS opening, already filtered to what fits the window and to whatever
  // the operator restricted the opening to.
  //
  // This used to be inferred from the public map, which only ever carries one
  // headline service per opening — so a business with six services whose short
  // openings only ever advertised two showed a customer two.
  // ---------------------------------------------------------------------
  const loadMenu = useCallback(async () => {
    if (!gapId) { setMenuState('gone'); return; }
    setMenuState('loading');
    setMenuError(null);
    setGoneWhy(null);
    try {
      const detail = await api.gapServices(gapId);

      // Priced with everything ticked, purely to catch a slot that is already
      // claimed. Hearing that on arrival is bad; hearing it after picking
      // three services and typing an address is worse.
      const probe = await api.priceOrder([
        { gap_id: gapId, service_ids: detail.services.slice(0, 1).map((x) => x.service_id) },
      ]);
      const item = probe.items[0];
      const dead = item?.problems.find((p) => FATAL.has(p.code)) ?? null;
      if (dead) {
        setGoneWhy(say(dead.code, dead.message));
        setMenuState('gone');
        return;
      }

      setMenu({
        gapId,
        businessName: detail.business_name,
        services: detail.services,
        windowSeconds: detail.window_seconds,
        slot: null,
      });
      // The opening is real but the business has nothing that fits it. Said
      // plainly rather than shown as an empty list that looks broken.
      setMenuState(detail.services.length ? 'ready' : 'nolist');
    } catch (e) {
      // A 404 is not a fault to retry — the opening is not there, and offering
      // a Try again button against a URL that will never resolve is a loop.
      // It gets the same "this has gone" page a claimed slot gets, which is
      // the one with a way out of it.
      if (e instanceof ApiError && e.status === 404) {
        setGoneWhy(e.message);
        setMenuState('gone');
        return;
      }
      setMenuState('error');
      setMenuError(e instanceof Error ? e.message : 'Could not open this opening.');
    }
  }, [gapId]);

  useEffect(() => { void loadMenu(); }, [loadMenu]);

  // ---------------------------------------------------------------------
  // The running total
  //
  // Debounced, because ticking four services in two seconds is one question,
  // not four. The sequence guard drops a slow answer that lands after a newer
  // one, which is what otherwise makes a total flick back to a stale number.
  // ---------------------------------------------------------------------
  const seq = useRef(0);
  const wanted = useMemo(
    () => basket.filter((b) => b.service_ids.length > 0), [basket],
  );

  useEffect(() => {
    if (wanted.length === 0) {
      seq.current += 1;                          // cancel whatever is in flight
      setPriced(null); setPriceError(null); setPricing(false);
      return;
    }
    setPricing(true);
    const mine = ++seq.current;
    const timer = window.setTimeout(() => {
      api.priceOrder(wanted)
        .then((res) => {
          if (seq.current !== mine) return;
          setPriced(res); setPriceError(null);
        })
        .catch((e) => {
          if (seq.current !== mine) return;
          setPriceError(e instanceof Error ? e.message : 'Could not price your basket.');
        })
        .finally(() => { if (seq.current === mine) setPricing(false); });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [wanted, recheck]);

  // Priced rows are returned in the order they were sent, but looking them up
  // by gap id survives the Worker dropping or reordering one.
  const byGap = useMemo(() => {
    const m = new Map<string, PricedItem>();
    for (const i of priced?.items ?? []) m.set(i.gap_id, i);
    return m;
  }, [priced]);

  const mine = basket.find((b) => b.gap_id === gapId) ?? null;
  const chosen = mine?.service_ids ?? [];
  const full = basket.length >= MAX_ITEMS && !mine;

  const toggle = useCallback((serviceId: string) => {
    if (!gapId) return;
    setBasket((prev) => {
      const at = prev.findIndex((b) => b.gap_id === gapId);
      if (at === -1) {
        if (prev.length >= MAX_ITEMS) return prev;
        return [...prev, { gap_id: gapId, service_ids: [serviceId] }];
      }
      const row = prev[at]!;
      const ids = row.service_ids.includes(serviceId)
        ? row.service_ids.filter((s) => s !== serviceId)
        : [...row.service_ids, serviceId].slice(0, MAX_SERVICES);
      const next = [...prev];
      // An opening with nothing ticked is not in the basket. Leaving the empty
      // row would price as no_service and block a checkout over an opening the
      // customer has already changed their mind about.
      if (ids.length === 0) next.splice(at, 1);
      else next[at] = { gap_id: row.gap_id, service_ids: ids };
      return next;
    });
  }, [gapId]);

  const remove = useCallback((id: string) => {
    setBasket((prev) => prev.filter((b) => b.gap_id !== id));
    setPlaceError(null);
  }, []);

  const submit = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    if (placing || wanted.length === 0) return;
    setPlacing(true);
    setPlaceError(null);
    try {
      const res = await api.placeOrder({
        items: wanted,
        guest_name: name.trim(),
        phone: phone.trim(),
        ...(address.trim() ? { address_line: address.trim() } : {}),
        ...(zip.trim() ? { postcode: zip.trim() } : {}),
        ...(threadToken ? { thread_token: threadToken } : {}),
        ...(captcha.current ? { turnstile_token: captcha.current } : {}),
      });
      if (!res.thread_token) {
        // The order exists but there is no conversation to send them to, and
        // that page is the only record a customer without an account gets.
        setPlaceError('Your booking went through, but we could not open your '
          + `conversation. Keep this reference and contact the business: ${res.order_id}`);
        return;
      }
      // The basket is spent. Leaving it would re-offer slots that are now
      // theirs the next time they open the site in this tab.
      writeBasket([]);
      setBasket([]);
      navigate(`/c/${res.thread_token}`);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      const fallback = err instanceof Error ? err.message : 'That did not go through.';
      setPlaceError(code ? say(code, fallback) : fallback);
      // A Turnstile token is single-use and short-lived, so the one just spent
      // is dead whatever the failure was — a lost slot as much as a refused
      // challenge. Resetting on every failure is what makes the second press
      // of the button work; the fields keep their values because they are
      // React state and nothing here touches them.
      captcha.current = null;
      widget.current?.reset();
      // A slot lost during checkout is the common failure and must not be a
      // dead end. Re-pricing makes the offending line name itself, with its
      // own Remove next to it, instead of leaving one sentence at the bottom.
      if (code && FATAL.has(code)) setRecheck((n) => n + 1);
    } finally {
      setPlacing(false);
    }
  }, [placing, wanted, name, phone, address, zip, threadToken, navigate]);

  // Named after the business once we know it. An opening that has gone says so
  // in the tab too, because that is the branch the page renders.
  useDocumentTitle(
    menu ? `Book ${menu.businessName}`
      : menuState === 'gone' ? 'This opening has gone'
        : 'Book an appointment');

  const orderProblems = priced?.problems ?? [];
  const ready = Boolean(priced?.ok) && wanted.length > 0;
  const isSample = menu?.slot?.is_sample ?? false;

  return (
    <div className="land">
      {/*
        WHY THE CHROME ON THIS PAGE IS DELIBERATELY THIN.
        This is the checkout. Somebody is on it having decided to spend money,
        and every additional door out of it is a chance for that decision to
        come apart — which is why the reference marketplace strips its own
        checkout down to a wordmark and why the search box is switched off
        here. A "what do you need done?" box beside a basket is an invitation
        to start looking for something else, and the basket does not survive
        that in any state the customer would recognise.

        For the same reason there is no breadcrumb and no site footer below.
        A breadcrumb is a trail back up a hierarchy this page does not sit in —
        a basket can hold openings from three businesses in three trades — and
        twenty footer links under a payment step are twenty ways to leave. The
        two links this page does keep both point back into the flow: the "All
        open appointments" back link below, which is how you add a second
        opening, and "Add another appointment" inside the basket.

        The header's three nav pills — Alert me, Sign in, List your van — are
        off for the same reason: on a checkout they are three more ways out.
        What is left is the wordmark, which is the one link a page like this
        should have.
      */}
      <SiteHeader search={false} nav={false} />

      <main className="wrap book" id="main" tabIndex={-1}>
        <Link to="/" className="book-back">
          <Icon name="back" size={16} />
          All open appointments
        </Link>

        {menuState === 'loading' && <Spinner label="Opening this appointment" />}

        {menuState === 'error' && (
          <div className="blank" style={{ marginTop: 20 }}>
            {menuError ?? 'Could not open this opening.'}
            <div style={{ marginTop: 14 }}>
              <button className="btn sm" type="button" onClick={() => void loadMenu()}>
                Try again
              </button>
            </div>
          </div>
        )}

        {menuState === 'gone' && (
          <div className="blank" style={{ marginTop: 20 }}>
            <p style={{ margin: '0 0 14px' }}>
              {goneWhy
                ?? 'This opening has gone. Somebody took it, or the business put '
                  + 'the time back into their day.'}
            </p>
            <p style={{ margin: '0 0 14px' }}>
              {basket.length > 0
                ? 'Everything else in your basket is still held below.'
                : 'New openings appear the moment a job cancels.'}
            </p>
            <Link className="btn sm" to="/">See what else is open</Link>
          </div>
        )}

        {menu && (menuState === 'ready' || menuState === 'nolist') && (
          <>
            <section className="book-head">
              <span className="eyebrow">Book an appointment</span>
              <h1>{menu.businessName}</h1>
              {menu.slot && (
                <p className="book-when">
                  Listed as {menu.slot.when}. The opening runs for up to{' '}
                  {durationLabel(menu.windowSeconds)}, so what you pick decides
                  when it finishes.
                </p>
              )}
              <div className="book-meta">
                {menu.slot?.proximity && <span className="tag">{menu.slot.proximity}</span>}
                {menu.slot?.profile_slug && (
                  <Link className="tlink" to={`/p/${menu.slot.profile_slug}`}
                    style={{ paddingLeft: 0 }}>
                    See their page and their work
                  </Link>
                )}
              </div>
            </section>

            {isSample && (
              <p className="sample-note">
                <strong>This is sample data.</strong> This business was seeded so
                the map is not blank before anyone has signed up. It is not a
                real company, nobody will arrive, and it holds no licence.
              </p>
            )}

            <section className="card book-card" aria-labelledby="pick">
              <h2 id="pick">What would you like?</h2>
              <p className="book-sub">
                Tick as many as you want. They are done in the one visit, and
                the total below updates as you go.
              </p>

              {menuState === 'nolist' ? (
                <p className="book-problem">
                  We could not list what this business does in this opening.
                  That is a gap on our side, not a sign the opening is gone.
                  Try again, or pick another opening from the map.
                </p>
              ) : (
                <div className="book-svcs">
                  {menu.services.map((s) => {
                    const on = chosen.includes(s.service_id);
                    // A service longer than the whole opening can never be
                    // bought here. Showing it greyed out with the reason beats
                    // letting somebody tick it and meet too_long.
                    const overruns = s.duration_seconds > menu.windowSeconds;
                    const blocked = (!on && full) || (!on && overruns);
                    return (
                      <button key={s.service_id} type="button" className="book-svc"
                        aria-pressed={on} disabled={blocked}
                        onClick={() => toggle(s.service_id)}>
                        <span className="book-tick" aria-hidden="true">
                          <Icon name="tick" size={15} stroke={2.6} />
                        </span>
                        <span className="book-svc-name">{s.name}</span>
                        <span className="book-svc-price">{s.price}</span>
                        <span className="book-svc-len">
                          {durationLabel(s.duration_seconds)}
                          {overruns && ' · longer than this opening'}
                          {!overruns && blocked && ' · basket is full'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* The one number the whole page is about, announced when it
                  changes rather than only redrawn. */}
              <div className={`book-sum${priced && !priced.ok ? ' tight' : ''}`}
                role="status" aria-live="polite">
                <div className="book-sum-row">
                  <span className="book-sum-label">
                    {wanted.length > 1 ? `Total · ${wanted.length} appointments` : 'Total'}
                  </span>
                  <span className="book-sum-total">
                    {pricing && !priced ? '—' : priced?.total ?? '—'}
                  </span>
                </div>
                <span className="book-sum-note">
                  {pricing ? 'Working out your total…'
                    : priceError ? priceError
                    : !priced ? 'Nothing ticked yet.'
                    : `${durationLabel(priced.duration_seconds)} of work in total`
                      + `${priced.ok ? ' · everything fits' : ''}`}
                </span>
                {/* This used to read "This is the full price. Nothing is
                    added on top." for every basket, which was simply false for
                    half the trades on the site: a mobile mechanic cannot know
                    whether your car needs a $40 sensor or a $400 alternator
                    until they are under the hood. So the promise is now made
                    per basket and only where it is true, and where it is not
                    true the customer is told exactly what happens instead —
                    which is a better promise anyway, because it is one that
                    can be kept. */}
                {priced && priced.items.length > 0 && (
                  partsLines.length === 0 ? (
                    <span className="book-sum-note">
                      This is the full price. Nothing is added on top.
                    </span>
                  ) : (
                    <span className="book-sum-note">
                      This covers the work itself. Nothing else is ever charged
                      unless you approve it first — see below.
                    </span>
                  )
                )}
              </div>

              {/* Parts, said plainly, once per service that has anything to
                  say. Nobody reads a disclaimer at the bottom of a checkout;
                  they read the line attached to the thing they just ticked. */}
              {partsLines.length > 0 && (
                <div className="book-parts">
                  {partsLines.map((p) => (
                    <p key={p.key} className="book-parts-row">
                      <strong>{p.name}</strong> — {p.line}
                      {p.note && <><br /><span className="faint">“{p.note}”</span></>}
                    </p>
                  ))}
                </div>
              )}

              {priceError && (
                <button className="btn quiet sm" type="button"
                  onClick={() => setRecheck((n) => n + 1)}>
                  Try again
                </button>
              )}
            </section>

            {full && (
              <p className="book-problem">{PROBLEM.too_many_items}</p>
            )}
          </>
        )}

        {/* --- the basket ------------------------------------------------ */}
        {basket.length > 0 && (
          <section className="card book-card" aria-labelledby="basket">
            <h2 id="basket">Your basket</h2>
            <p className="book-sub">
              Openings from different businesses and different days can sit here
              together. They are held in this tab only, and nothing is booked
              until you finish below.
            </p>

            <div className="book-items">
              {basket.map((row) => {
                const p = byGap.get(row.gap_id) ?? null;
                const problems = p?.problems ?? [];
                const broken = problems.some((x) => FATAL.has(x.code));
                const here = row.gap_id === gapId;
                return (
                  <article key={row.gap_id}
                    className={`book-item${broken ? ' bad' : here ? ' here' : ''}`}>
                    <div className="book-item-top">
                      <h3>{p?.business_name || 'This appointment'}</h3>
                      {p && !broken && <span className="book-item-price">{p.price}</span>}
                    </div>

                    {p?.when && !broken && <p className="book-item-when">{p.when}</p>}

                    {p && p.services.length > 0 && (
                      <ul>
                        {p.services.map((s) => (
                          <li key={s.service_id}>
                            {s.name} · {durationLabel(s.duration_seconds)} · {s.price}
                          </li>
                        ))}
                      </ul>
                    )}

                    {!p && pricing && <p className="book-item-when">Checking this one…</p>}

                    {problems.map((x) => (
                      <p key={x.code} className="book-problem">{say(x.code, x.message)}</p>
                    ))}

                    <div className="book-item-ops">
                      <button className="btn quiet sm" type="button"
                        onClick={() => remove(row.gap_id)}>
                        Remove{broken ? ' and keep the rest' : ''}
                      </button>
                      {!here && (
                        <Link className="btn quiet sm" to={`/book/${row.gap_id}`}>
                          Change services
                        </Link>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>

            {orderProblems.map((x) => (
              <p key={x.code} className="book-problem">{say(x.code, x.message)}</p>
            ))}

            {!full && (
              <Link className="btn ghost" to="/">
                <Icon name="plus" size={18} />
                Add another appointment
              </Link>
            )}
          </section>
        )}

        {basket.length === 0 && menuState === 'ready' && (
          <div className="blank">
            Your basket is empty. Tick a service above to start one.
          </div>
        )}

        {/* --- details, then the review ---------------------------------- */}
        {wanted.length > 0 && (
          <form className="card book-card" onSubmit={submit} aria-labelledby="details">
            <h2 id="details">Your details</h2>
            <p className="book-sub">
              Asked once, and it covers every appointment in the basket. There is
              no account to create.
            </p>

            <div className="book-fields">
              <label htmlFor="bk-name">
                Your name
                <input id="bk-name" name="name" value={name} required
                  autoComplete="given-name" enterKeyHint="next"
                  onChange={(e) => setName(e.target.value)} />
              </label>

              <div className="book-field">
                <label htmlFor="bk-phone">
                  Mobile number
                  <input id="bk-phone" name="phone" type="tel" value={phone} required
                    autoComplete="tel" inputMode="tel" enterKeyHint="next"
                    aria-describedby="bk-phone-hint"
                    onChange={(e) => setPhone(e.target.value)} />
                </label>
                <p className="book-hint" id="bk-phone-hint">
                  How the business reaches you on the day.
                </p>
              </div>

              <div className="book-field">
                <label htmlFor="bk-address">
                  Address
                  <input id="bk-address" name="address" value={address}
                    autoComplete="street-address" enterKeyHint="next"
                    aria-describedby="bk-address-hint"
                    onChange={(e) => setAddress(e.target.value)} />
                </label>
                <p className="book-hint" id="bk-address-hint">
                  Needed when the business comes to you. Leave it blank if you
                  are going to them.
                </p>
              </div>

              <label htmlFor="bk-zip">
                Postcode or ZIP
                <input id="bk-zip" name="postcode" value={zip}
                  autoComplete="postal-code" enterKeyHint="done"
                  onChange={(e) => setZip(e.target.value)} />
              </label>
            </div>

            <h2>Before you book</h2>
            <div className="book-sum">
              <div className="book-sum-row">
                <span className="book-sum-label">
                  {wanted.length === 1 ? '1 appointment' : `${wanted.length} appointments`}
                </span>
                <span className="book-sum-total">{priced?.total ?? '—'}</span>
              </div>
              <span className="book-sum-note">
                {priced
                  ? `${durationLabel(priced.duration_seconds)} of work in total`
                  : 'Working out your total…'}
              </span>
            </div>

            {/* Says what the button does, FIRST, and before the rules rather
                than after them. The old page promised money changes hands
                here; none does, and a customer who reads that and then gets no
                receipt has been misled about the one thing that matters most on
                a checkout. It used to sit below the cancellation box, which
                meant the false sentence — "Your card is charged for the
                appointment when you book" — was read first and the correction
                second. */}
            <PaymentState className="at-checkout" />

            {/* The cancellation rule, stated before the button and not after
                it. A no-refund window a customer discovers at the moment they
                need it is a rule they never agreed to, however true it is —
                and it is the single most predictable complaint this product
                can generate. Said plainly here, it is a deal; said later, it
                is a trap.
                Every line is future tense, because that is what it is: these
                are the amounts the code in src/lib/bypass.ts computes, and none
                of them can move a penny until the payment seam above is built.
                A customer is told them now anyway — agreeing to an appointment
                under rules nobody mentioned is the thing this box exists to
                prevent, and they do not become fairer for being sprung later. */}
            <div className="book-terms">
              <strong>How cancelling will work, once payment is switched on</strong>
              <ul>
                <li>
                  The price above is what will be taken when you book, and the
                  amounts below are worked out from it.
                </li>
                <li>
                  <strong>Changed your mind in the first 30 minutes?</strong>{' '}
                  Full refund — as long as the appointment is still at least
                  three hours away.
                </li>
                <li>
                  After that, how much comes back depends on how close it is:{' '}
                  <strong>more than 48 hours, all of it</strong>;{' '}
                  <strong>12 to 48 hours, three quarters</strong>;{' '}
                  <strong>inside 12 hours, a quarter</strong> — the business has
                  kept that time free and turned other work away for it.
                </li>
                <li>
                  The business is held to the same three steps. Whatever a
                  cancellation would cost you at a given moment, it costs them
                  the same if they are the one who cancels.
                </li>
                <li>
                  You will always see the exact amount before you confirm a
                  cancellation.
                </li>
                <li>
                  If the business cancels, you get everything back, whenever it
                  happens.
                </li>
                <li>
                  Not being there when they arrive pauses this number from
                  booking — 3 days the first time, then 7, then 30. That one
                  applies today: it is a suspension rather than a charge, and
                  nothing about it needs money to have moved.
                </li>
              </ul>
            </div>

            {/* Parts, at the checkout, only for a basket that has a job in it
                whose part cannot be priced until somebody looks. The approval
                rule is real and runs today — the quote card in the booking's
                own messages exists — but the charge at the end of it is the
                same unbuilt seam as the one above, so the sentence says which
                half happens now. */}
            {partsLines.length > 0 && (
              <p className="book-pay">
                <strong>If the job needs a part.</strong> The business sends you
                the price in your messages, and nothing is fitted until you tap
                approve. Once payment is switched on that approval is also what
                charges you for the part, and it is the only thing you can ever
                be charged for beyond the price above — either way you will have
                seen the number first.
              </p>
            )}

            {/* Last thing before the button, which is where it belongs: after
                everything the customer types, and in front of the one control
                that spends it. Renders nothing at all until a site key is
                configured, so today this leaves the page exactly as it was. */}
            <Turnstile ref={widget} action="book"
              onToken={(t) => { captcha.current = t; }} />

            {placeError && <div className="error">{placeError}</div>}

            <button className="btn block" type="submit" disabled={!ready || placing}>
              {placing ? 'Holding your appointments…' : 'Book — no payment taken yet'}
            </button>

            {!ready && !placing && (
              <p className="book-sub" style={{ marginTop: 0 }}>
                {pricing
                  ? 'Checking your basket is still bookable…'
                  : 'Sort out the notes above and this button turns on.'}
              </p>
            )}
          </form>
        )}
      </main>
    </div>
  );
}
