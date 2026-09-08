import {
  useCallback, useEffect, useMemo, useRef, useState, type FormEvent,
} from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ApiError, api, durationLabel,
  type PricedItem, type PricedOrder, type PricedService, type PublicSlot,
} from '../api';
import CodeSignIn, { CODE_DIGITS } from '../components/CodeSignIn';
import PaymentState from '../components/PaymentState';
import SiteHeader from '../components/SiteHeader';
import Turnstile, { type TurnstileHandle } from '../components/Turnstile';
import { Icon, Spinner } from '../components/ui';
import '../styles-book.css';
import '../styles-parts.css';
import { useBookingState, useCustomer } from '../lib/customer';
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
 *
 * WHY IT IS FOUR STEPS RATHER THAN ONE LONG PAGE.
 *
 * The reference marketplace never asks its questions all at once. It opens a
 * modal and asks one thing per screen, and the screen that asks for something
 * it does not strictly need — photographs — is headed "Optional" and carries a
 * Skip. An account is only demanded once every question has been answered.
 * They do that because a checkout is a sequence of small decisions, and a
 * single screen carrying all of them at once reads as a form to be endured
 * rather than a set of questions to be answered.
 *
 * Their questions are not ours and are not copied. Theirs describe a project
 * that does not exist yet — what kind of property, what is wrong with it, when
 * would you like it to start. Ours is a particular hour of a particular
 * business's day that already exists and has a price on it, so the only things
 * left to settle are which of their services to spend it on, where to send
 * them, anything they should know before they set off, and whether the whole
 * thing is right.
 *
 * What the split must not cost:
 *   - the basket. It spans up to ten openings at different businesses on
 *     different days, and it is still one basket priced by one call.
 *   - anything typed. Every field is state on this component, so a step is
 *     only ever a different view of it — going back changes nothing.
 *   - a way forward. No step may be a dead end: where a button is off, the
 *     sentence under it says what to do, and the thing to do is on the same
 *     screen.
 *
 * WHERE THE ACCOUNT COMES IN, AND WHY IT IS NOT A FIFTH STEP.
 *
 * Booking needs an account and, once payment is switched on, a card. The model
 * this page was written on — "no account to create, here or later" — was never
 * the model, and that sentence was on the step below until now.
 *
 * What is true is that neither is asked for until somebody has decided to buy
 * something, which is exactly what arriving at the confirm step means. So the
 * sign-up lives ON that step, in the same action as the card and under the same
 * button: the mobile number was already answered two steps back, so all that is
 * added is the six digits texted to it, and `placeOrder` creates the account
 * and holds the appointments in one request. A fifth step headed "Create an
 * account" would be the separate journey the owner explicitly does not want,
 * and it would put a wall between a decision and the thing it was a decision
 * about.
 *
 * Somebody already signed in is not asked again — a customer's session lasts a
 * year and is extended on use, so the ordinary case for a returning customer is
 * that this step says who they are and moves on.
 *
 * AND TODAY NONE OF IT CAN COMPLETE. No text-message provider is configured on
 * this deployment, so no account can be created and nothing can be booked. That
 * is read off the Worker rather than assumed — see `api.bookingState` — and it
 * is said at the top of this page rather than discovered at the bottom of it,
 * because letting somebody fill a basket in first and then refusing them is the
 * one thing worse than saying so.
 */

/** The four questions, in the order they are asked. */
type Step = 'what' | 'where' | 'extra' | 'confirm';

const STEPS: readonly Step[] = ['what', 'where', 'extra', 'confirm'];

/** What the progress trail calls each step. Short enough to sit on a phone. */
const STEP_LABEL: Record<Step, string> = {
  what: 'What you want',
  where: 'Where you are',
  extra: 'Anything to add',
  confirm: 'Confirm',
};

/** What the step itself is headed, in the words somebody would use out loud. */
const STEP_HEADING: Record<Step, string> = {
  what: 'What would you like done?',
  where: 'Where you are, and how to reach you',
  extra: 'Anything the business should know?',
  confirm: 'Check this over, then book',
};

const STEP_SUB: Record<Step, string> = {
  what: 'Tick what you want from this opening. You can add openings from other '
    + 'businesses and other days before you go on.',
  where: 'Asked once, and it covers every appointment in your basket. The '
    + 'mobile number is also the account you book against — we text a code to '
    + 'it on the last step.',
  extra: 'Optional. Skip it and nothing is lost — you can write to them in your '
    + 'messages the moment this is booked.',
  confirm: 'Nothing is booked until you press the button at the bottom. Every '
    + 'answer above this can still be changed.',
};

const stepAfter = (s: Step): Step => STEPS[STEPS.indexOf(s) + 1] ?? s;
const stepBefore = (s: Step): Step => STEPS[STEPS.indexOf(s) - 1] ?? s;

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
    + 'street address or a postcode.',
  bad_address: 'We could not find that address. Check the street and the postcode.',
  no_name: 'Add the first name this booking should be under.',
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
  // The account, at the moment it is needed. None of these is a dead end: the
  // fields that answer all three are on this same step.
  account_required: 'Type the six digits we texted you, and the account is '
    + 'created as this books. Nothing in your basket has been taken.',
  bad_code: 'That code is wrong or has expired. Ask for a new one — the button '
    + 'above sends another, and nothing you have typed is lost.',
  sms_not_configured: 'We cannot send a text message on this deployment, so an '
    + 'account cannot be created and nothing can be booked yet. That is our end '
    + 'rather than anything you did.',
  card_required: 'A card is needed to finish this, and there is nowhere on this '
    + 'site to add one yet. Nothing in your basket has been taken.',
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
  /**
   * The optional message, sent into the booking's own conversation the moment
   * the order exists.
   *
   * There is no note field on an order and one is not invented here: what a
   * customer writes is a message, so it is posted as one with `guestSend` on
   * the token the order comes back with. That means it lands in the same
   * thread the business reads everything else in, and it means a failure to
   * send it cannot cost anybody a booking that has already been taken.
   */
  const [note, setNote] = useState('');

  const [placing, setPlacing] = useState(false);
  const [placeError, setPlaceError] = useState<string | null>(null);

  /**
   * The account this order is placed against.
   *
   * `customer` is who is already signed in, which is the ordinary case for
   * anybody who has booked here before — a customer session lasts a year and is
   * extended on use. `bookingState` is what this deployment requires and what
   * it can actually do today; both are read from the Worker rather than assumed
   * here, because a bundle that carries its own answer to "does booking need an
   * account" is how this site came to promise one that was never true.
   */
  const { account, standing, loading: sessionLoading, refresh: refreshAccount } = useCustomer();
  const bookingState = useBookingState();
  /**
   * The six digits, when this device is not signed in yet.
   *
   * They are never verified on their own: they go with the order, so the
   * account is created and the appointments held in one request and somebody
   * signing up does not lose the slot to a second round trip.
   */
  const [code, setCode] = useState('');
  /** Whatever the Worker said about those digits, drawn against the field. */
  const [codeError, setCodeError] = useState<string | null>(null);
  /**
   * What the Worker said when the code request itself turned out to be
   * impossible.
   *
   * `bookingState.sms_ready` answers that before anything is pressed, and this
   * is the same answer arriving late — the state request failed, or the
   * provider went away since it was asked. Without it the page would go on
   * telling somebody to type digits that are never going to arrive.
   */
  const [signUpBlocked, setSignUpBlocked] = useState<string | null>(null);

  // --- which question is on screen ------------------------------------------
  const [step, setStep] = useState<Step>('what');
  /** Whatever stopped the step being left, said next to the control. */
  const [stepError, setStepError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const nameField = useRef<HTMLInputElement | null>(null);
  const phoneField = useRef<HTMLInputElement | null>(null);
  /**
   * Whether a step has been changed yet.
   *
   * The focus move below is the whole point of the effect, and it is exactly
   * wrong on the first paint: arriving on a page and having it grab your
   * caret is the behaviour that makes an autofocused search box hated. So the
   * first render is left alone and only a deliberate move is followed.
   */
  const stepped = useRef(false);

  /**
   * The one thing a multi-step form has to get right.
   *
   * Swapping the body of the page under a keyboard or a screen reader leaves
   * focus on a control that no longer exists, and the reader goes quiet — the
   * new question has been asked of somebody who cannot tell it was asked. So
   * every move puts focus on the new step's heading, which is the first thing
   * a sighted person reads too. The scroll is done separately because
   * `preventScroll` keeps the browser from parking the heading halfway up the
   * viewport with the page's own title scrolled off above it.
   */
  useEffect(() => {
    if (!stepped.current) return;
    window.scrollTo(0, 0);
    heading.current?.focus({ preventScroll: true });
  }, [step]);

  const go = useCallback((to: Step) => {
    stepped.current = true;
    setStepError(null);
    setStep(to);
  }, []);

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

  /**
   * An empty basket has nothing to confirm, so nobody is left standing on a
   * step asking where to send a van for no appointments. Removing the last
   * line of a basket from the confirm step is the ordinary way to arrive here,
   * and it must land on the step that can start one again rather than on three
   * questions about nothing.
   */
  useEffect(() => {
    if (wanted.length === 0 && step !== 'what') go('what');
  }, [wanted.length, step, go]);

  /**
   * Leaving a step forwards.
   *
   * Each step is its own form, so Enter in a field does what Enter in a field
   * should do and the browser's own required-field messages appear where the
   * browser puts them. This adds the one check `required` cannot make — a
   * field holding nothing but spaces passes it — and puts focus on the field
   * it is complaining about, because a message about a control the caret is
   * nowhere near is a message nobody acts on.
   */
  const advance = useCallback((e: FormEvent) => {
    e.preventDefault();
    if (step === 'where') {
      if (!name.trim()) {
        setStepError(PROBLEM.no_name!);
        nameField.current?.focus();
        return;
      }
      if (!phone.trim()) {
        setStepError('Add a mobile number, so the business can reach you on the day.');
        phoneField.current?.focus();
        return;
      }
    }
    go(stepAfter(step));
  }, [step, name, phone, go]);

  const submit = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    if (placing || wanted.length === 0) return;
    setPlacing(true);
    setPlaceError(null);
    setCodeError(null);
    try {
      const res = await api.placeOrder({
        items: wanted,
        guest_name: name.trim(),
        phone: phone.trim(),
        ...(address.trim() ? { address_line: address.trim() } : {}),
        ...(zip.trim() ? { postcode: zip.trim() } : {}),
        ...(threadToken ? { thread_token: threadToken } : {}),
        ...(captcha.current ? { turnstile_token: captcha.current } : {}),
        // Only when this device is not signed in. A signed-in caller's order is
        // written against the account and not against anything in this body —
        // which is what stops a suspended customer booking under somebody
        // else's mobile — so sending digits as well would be noise.
        ...(account ? {} : { code, country: 'US' }),
      });
      // The Worker set the session cookie on that response when the account was
      // created here, so this page stops asking for a code the moment it knows
      // — the customer may go straight back for a second opening.
      if (!account) void refreshAccount();
      if (!res.thread_token) {
        // The order exists but there is no conversation to send them to. The
        // account now holds the booking, so it is not lost — but the
        // conversation is where the messages, the start code and the van live,
        // and none of those is reachable without that link.
        setPlaceError('Your booking went through, but we could not open your '
          + `conversation. Keep this reference and contact the business: ${res.order_id}`);
        return;
      }
      // What they wrote on the optional step, posted into the conversation the
      // order just opened. Deliberately after the order and deliberately
      // swallowed on failure: the appointment is booked either way, and
      // showing somebody an error over a courtesy note would tell them the
      // booking failed when it did not. They land in the thread a second
      // later and can see whether it is there.
      const aside = note.trim();
      if (aside) {
        try { await api.guestSend(res.thread_token, aside); } catch { /* see above */ }
      }
      // The basket is spent. Leaving it would re-offer slots that are now
      // theirs the next time they open the site in this tab.
      writeBasket([]);
      setBasket([]);
      navigate(`/c/${res.thread_token}`);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      const fallback = err instanceof Error ? err.message : 'That did not go through.';
      // A refusal about the code goes against the code field and NOWHERE ELSE.
      // CodeSignIn announces it and puts the caret back in the box it is about,
      // so the customer is already looking at it; printing the same sentence a
      // second time under the button is two amber boxes saying one thing, and
      // the "why this button is off" line below already covers the button's
      // own side of it.
      if (code === 'bad_code' || code === 'account_required') {
        setCodeError(say(code, fallback));
      } else {
        setPlaceError(code ? say(code, fallback) : fallback);
      }
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
  }, [placing, wanted, name, phone, address, zip, note, threadToken, navigate,
    account, code, refreshAccount]);

  // Named after the business once we know it. An opening that has gone says so
  // in the tab too, because that is the branch the page renders.
  useDocumentTitle(
    menu ? `Book ${menu.businessName}`
      : menuState === 'gone' ? 'This opening has gone'
        : 'Book an appointment');

  const orderProblems = priced?.problems ?? [];

  /**
   * Whether a code can be sent here at all, and the sentence saying it cannot.
   *
   * Two sources for one fact: what the Worker said before anything was pressed,
   * and what it said when the send was actually tried. The second wins, because
   * it is the newer answer and because the first can be missing — a failed GET
   * leaves `bookingState` null, and null is deliberately not a no.
   */
  const smsOff = signUpBlocked
    ?? (bookingState && !bookingState.sms_ready ? bookingState.sms_note : null);

  /**
   * Why this basket cannot be booked at all right now, or null.
   *
   * SAID BEFORE THE BASKET RATHER THAN UNDER THE BUTTON. Both of these are
   * facts about the deployment or about the reader that no amount of ticking
   * services can change, so meeting one at the bottom of a checkout — after
   * choosing, after typing an address — is meeting it at the worst possible
   * moment. The ordinary sign-up is not in here, because that one IS answerable
   * on the confirm step and belongs beside the field that answers it.
   *
   * Refusing to let somebody book because a GET failed would be worse than
   * letting the Worker refuse the order itself, which it will, so an
   * unanswered question stops nothing.
   */
  const cannotBook: { lead: string; note: string } | null =
    smsOff && !account
      ? { lead: 'Bookings are not open yet.', note: smsOff }
      : standing?.blocked && standing.message
        // A different sentence, because it is a different fact: the site is
        // working and this person in particular is paused. Telling somebody
        // serving a no-show suspension that "bookings are not open yet" would
        // be a lie of exactly the kind this whole change exists to remove.
        ? { lead: 'Booking is paused on this account.', note: standing.message }
        : null;

  /**
   * The digits, when this device is not signed in.
   *
   * Only whole codes turn the button on. A five-digit code is not a code the
   * Worker can do anything with, and spending a press of Book on one costs the
   * customer a round trip to be told what the field already knew.
   */
  const needsCode = !sessionLoading && !account;
  const codeReady = !needsCode || code.length === CODE_DIGITS;

  const ready = Boolean(priced?.ok) && wanted.length > 0
    && !sessionLoading && !cannotBook && codeReady;
  const isSample = menu?.slot?.is_sample ?? false;

  const stepNo = STEPS.indexOf(step) + 1;
  /** The businesses in the basket, by name, from the priced rows and nowhere else. */
  const businesses = [...new Set((priced?.items ?? []).map((i) => i.business_name))];
  /**
   * The wizard is drawn whenever there is anything to book — which includes an
   * opening that has since gone while a basket built somewhere else is still
   * held. Losing the checkout because the one opening in the URL was claimed
   * would strand a customer holding nine other appointments.
   */
  const wizard = menuState === 'ready' || menuState === 'nolist' || basket.length > 0;
  /**
   * Why the first step cannot be left yet, or null when it can.
   *
   * Worked out here rather than in the markup so that the button's disabled
   * state and the sentence explaining it are the same decision and cannot come
   * to disagree. Both of the reasons below are answerable on the step itself:
   * the services are above the button, and every broken basket line carries
   * its own Remove.
   */
  const heldUp: string | null = step !== 'what' ? null
    : wanted.length === 0
      ? 'Tick a service above and this button turns on.'
      : priced !== null && !priced.ok
        ? 'One of the appointments above needs sorting out first. The note is '
          + 'on the line it belongs to, and Remove keeps the rest of the basket.'
        : null;

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

        {/* THE FIRST THING ON THE PAGE WHEN NOTHING HERE CAN COMPLETE.
            No text-message provider is configured on any deployment today, so
            no account can be created and so nothing can be booked; a suspended
            number is the other case. Both are said here, in the Worker's own
            words, rather than left to be discovered by a customer who has
            already chosen three services and typed their address. */}
        {cannotBook && (
          <p className="book-blocked" role="status">
            <strong>{cannotBook.lead}</strong> {cannotBook.note} You can still
            look around, compare prices and message a business, and a booking
            you already have still opens from its own link.
          </p>
        )}

        {menuState === 'loading' && <Spinner label="Opening this appointment" />}

        {/* Both panels below are about the opening in the URL, which is a
            question the first step asks and the later ones have moved past.
            Left on screen at the confirm step they would read as a fresh
            failure of the thing about to be booked. */}
        {menuState === 'error' && step === 'what' && (
          <div className="blank" style={{ marginTop: 20 }}>
            {menuError ?? 'Could not open this opening.'}
            <div style={{ marginTop: 14 }}>
              <button className="btn sm" type="button" onClick={() => void loadMenu()}>
                Try again
              </button>
            </div>
          </div>
        )}

        {menuState === 'gone' && step === 'what' && (
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
            {/* THE TITLE HAS TO SURVIVE A BASKET.
                It named the business in the URL, which was right when this page
                sold one opening and stopped being right the moment a second
                business went into the basket: a confirm step listing two
                companies under one company's name tells the reader the wrong
                thing about what they are buying. Both lines are counted from
                the priced order — the businesses that are actually in it, and
                how many appointments — and fall back to the opening in the URL,
                which is all there is before anything has been ticked. */}
            <section className="book-head">
              <span className="eyebrow">
                {wanted.length > 1 ? `Book ${wanted.length} appointments` : 'Book an appointment'}
              </span>
              <h1>
                {businesses.length > 1 ? 'Your booking' : businesses[0] ?? menu.businessName}
              </h1>
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
          </>
        )}

        {/* --- where you are in the four questions -------------------------
            The trail is a real list of four items rather than four coloured
            dots, so it says what the steps are and not merely how many are
            left. A step already answered is a button back to it — the
            shortest way to change an answer from the confirm step, and a
            second route back beside the Back control on every step. A step
            not yet reached is plain text: it is not a shortcut past the
            question in front of it. */}
        {wizard && (
          <>
            <nav className="book-trail" aria-label="Booking steps">
              <ol>
                {STEPS.map((s, i) => {
                  const done = i < stepNo - 1;
                  const now = s === step;
                  return (
                    <li key={s} className={now ? 'now' : done ? 'done' : ''}>
                      {done ? (
                        <button type="button" onClick={() => go(s)}>
                          <span className="book-trail-i" aria-hidden="true">{i + 1}</span>
                          {STEP_LABEL[s]}
                          <span className="sr-only"> — done, go back to it</span>
                        </button>
                      ) : (
                        <span {...(now ? { 'aria-current': 'step' as const } : {})}>
                          <span className="book-trail-i" aria-hidden="true">{i + 1}</span>
                          {STEP_LABEL[s]}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ol>
            </nav>

            {/* The heading takes focus on every move, so it is the thing a
                screen reader reads when the page changes under it. The count
                beside it is a live region as well as a visible line: the
                heading answers "what am I being asked", and this answers "how
                much of this is left", which is the question a wizard owes
                somebody who cannot see the trail above. */}
            <header className="book-step-head">
              <p className="book-step-n" role="status" aria-live="polite">
                Step {stepNo} of {STEPS.length}
              </p>
              <h2 id="book-step" tabIndex={-1} ref={heading}>{STEP_HEADING[step]}</h2>
              <p className="book-step-sub">{STEP_SUB[step]}</p>
            </header>

            {/* The total, on the two steps that are not about it.
                Splitting a checkout into screens is only worth doing if the
                number the whole thing is for stays in sight; a form that has
                quietly stopped saying what it costs is how somebody arrives at
                a Book button unsure what they are agreeing to. The first step
                prints it in full and the last one itemises it, so this is only
                for the two in between. */}
            {(step === 'where' || step === 'extra') && priced && (
              <p className="book-mini">
                <span className="book-mini-total">{priced.total}</span>
                <span>
                  {wanted.length === 1 ? '1 appointment' : `${wanted.length} appointments`}
                  {' · '}{durationLabel(priced.duration_seconds)} of work
                </span>
              </p>
            )}
          </>
        )}

        {/* --- 1. what you want done --------------------------------------- */}
        {wizard && step === 'what' && (
          <form className="book-step" onSubmit={advance}>
            {menu && (menuState === 'ready' || menuState === 'nolist') && (
              <section className="card book-card" aria-labelledby="pick">
                <h3 id="pick">Services in this opening</h3>
                <p className="book-sub">
                  Tick as many as you want. They are done in the one visit, and
                  the total below updates as you go.
                </p>

                {menuState === 'nolist' ? (
                  <>
                    <p className="book-problem">
                      We could not list what this business does in this opening.
                      That is a gap on our side, not a sign the opening is gone.
                    </p>
                    {/* A step with nothing on it to tick would otherwise be the
                        one place in this flow with no way forward, so the two
                        things that can still be done are put in it. */}
                    <div className="book-nav">
                      <button className="btn quiet sm" type="button"
                        onClick={() => void loadMenu()}>
                        Try again
                      </button>
                      <Link className="btn quiet sm" to="/">Pick another opening</Link>
                    </div>
                  </>
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
            )}

            {full && (
              <p className="book-problem">{PROBLEM.too_many_items}</p>
            )}

            {/* --- the basket ------------------------------------------------ */}
            {basket.length > 0 && (
              <section className="card book-card" aria-labelledby="basket">
                <h3 id="basket">Your basket</h3>
                <p className="book-sub">
                  Openings from different businesses and different days can sit here
                  together. They are held in this tab only, and nothing is booked
                  until you press the button on the last step.
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
                          <h4>{p?.business_name || 'This appointment'}</h4>
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

            <div className="book-nav">
              <button className="btn block" type="submit" disabled={heldUp !== null}>
                Continue
              </button>
              {heldUp && <p className="book-nav-why">{heldUp}</p>}
            </div>
          </form>
        )}

        {/* --- 2. where you are -------------------------------------------
            The same four fields the single page asked for, in the same order,
            with the same rules about which are needed. Nothing here is new;
            it is only no longer sharing a screen with a basket, a price, a
            cancellation policy and a bot check. */}
        {wizard && step === 'where' && (
          <form className="card book-card book-step" onSubmit={advance}>
            <div className="book-fields">
              {/* One box headed "Your name" got a full name from most people,
                  and the surname went to the business beside the street
                  address they are about to be given. Asking for the first name
                  is the fix; the sentence under it is what stops it reading as
                  an odd thing to be asked. The Worker keeps only the first
                  word whatever is typed here — see firstNameOnly. */}
              <div className="book-field">
                <label htmlFor="bk-name">
                  First name
                  <input id="bk-name" name="name" value={name} required
                    ref={nameField} autoComplete="given-name" enterKeyHint="next"
                    aria-describedby="bk-name-hint"
                    onChange={(e) => setName(e.target.value)} />
                </label>
                <p className="book-hint" id="bk-name-hint">
                  First name only. The business gets this and nothing more —
                  no surname, no number, no email address.
                </p>
              </div>

              <div className="book-field">
                <label htmlFor="bk-phone">
                  Mobile number
                  <input id="bk-phone" name="phone" type="tel" value={phone} required
                    ref={phoneField} autoComplete="tel" inputMode="tel" enterKeyHint="next"
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
                Postcode
                <input id="bk-zip" name="postcode" value={zip}
                  autoComplete="postal-code" enterKeyHint="next"
                  onChange={(e) => setZip(e.target.value)} />
              </label>
            </div>

            {stepError && <div className="error">{stepError}</div>}

            <div className="book-nav">
              <button className="btn quiet" type="button" onClick={() => go(stepBefore(step))}>
                Back
              </button>
              <button className="btn" type="submit">Continue</button>
            </div>
          </form>
        )}

        {/* --- 3. anything they should know -------------------------------
            The optional one. It is skippable in a single press and says so on
            the button itself rather than beside it: a customer who has typed
            nothing gets a button that reads Skip, and one who has typed
            something gets Continue. A separate Skip sitting next to a box with
            words in it asks a question nobody should have to answer — whether
            pressing it throws the words away. */}
        {wizard && step === 'extra' && (
          <form className="card book-card book-step" onSubmit={advance}>
            <div className="book-field">
              <label htmlFor="bk-note">
                A message for the business
                <textarea id="bk-note" name="note" rows={5} value={note}
                  aria-describedby="bk-note-hint" maxLength={2000}
                  onChange={(e) => setNote(e.target.value)} />
              </label>
              <p className="book-hint" id="bk-note-hint">
                Where to park, which gate, the dog in the yard, the make of the
                car — whatever saves them a phone call. You do not need to
                include your name or number: they already have both from the
                last step. It is sent as the first message in your booking, and
                you can add to it any time afterwards.
              </p>
            </div>

            <div className="book-nav">
              <button className="btn quiet" type="button" onClick={() => go(stepBefore(step))}>
                Back
              </button>
              <button className="btn" type="submit">
                {note.trim() ? 'Continue' : 'Skip this step'}
              </button>
            </div>
          </form>
        )}

        {/* --- 4. confirm --------------------------------------------------- */}
        {wizard && step === 'confirm' && wanted.length > 0 && (
          <form className="card book-card book-step" onSubmit={submit}
            aria-labelledby="book-step">
            <h3>What you are booking</h3>
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

            {/* The lines themselves, read-only. The basket with its Remove
                buttons is one step back and the trail above reaches it in one
                press, so this is a statement of what is about to happen rather
                than a second place to edit it. Every word of it comes from the
                priced order, so it cannot describe a basket different from the
                one the button sends. */}
            {priced && priced.items.length > 0 && (
              <ul className="book-recap">
                {priced.items.map((it) => (
                  <li key={it.gap_id}>
                    <span className="book-recap-top">
                      <strong>{it.business_name}</strong>
                      <span className="book-recap-price">{it.price}</span>
                    </span>
                    {it.when && <span className="book-recap-when">{it.when}</span>}
                    <span className="book-recap-svc">
                      {it.services.map((s) => s.name).join(' · ')}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {/* The two answers that are not visible anywhere else on this
                step, each with the way back to the step that set it. A confirm
                screen that shows only the price is asking somebody to confirm
                a thing they cannot see. */}
            <dl className="book-answers">
              <div>
                <dt>Booked for</dt>
                <dd>
                  {name.trim() || '—'}
                  {phone.trim() ? ` · ${phone.trim()}` : ''}
                  {address.trim() ? ` · ${address.trim()}` : ''}
                  {zip.trim() ? ` · ${zip.trim()}` : ''}
                  {' '}
                  <button type="button" className="linkish" onClick={() => go('where')}>
                    Change<span className="sr-only"> where you are and how to reach you</span>
                  </button>
                </dd>
              </div>
              <div>
                <dt>Your message</dt>
                <dd>
                  {note.trim() || 'None — you left that step blank.'}
                  {' '}
                  <button type="button" className="linkish" onClick={() => go('extra')}>
                    Change<span className="sr-only"> your message for the business</span>
                  </button>
                </dd>
              </div>
            </dl>

            {/* A slot lost while the last three questions were being answered
                is the common failure on a checkout, and the fix for it is one
                step back rather than a sentence apologising here. */}
            {(orderProblems.length > 0 || (priced !== null && !priced.ok)) && (
              <div className="book-problem">
                {orderProblems.map((x) => (
                  <p key={x.code} style={{ margin: 0 }}>{say(x.code, x.message)}</p>
                ))}
                {/* Not `not_bookable`, whose wording — "check the notes on each
                    opening above" — was written for the page where the basket
                    and the button shared a screen. On this step there are no
                    notes above: the lines they are attached to are a step back,
                    which is what this says and what the button under it does. */}
                <p style={{ margin: orderProblems.length ? '8px 0 0' : 0 }}>
                  One of the appointments in your basket cannot be booked as it
                  stands. The line it is about says why, one step back, and
                  removing it keeps the rest.
                </p>
                <div className="book-nav" style={{ marginTop: 10 }}>
                  <button className="btn quiet sm" type="button" onClick={() => go('what')}>
                    Back to your basket
                  </button>
                </div>
              </div>
            )}

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

            {/* --- the account, and the card --------------------------------
                The sign-up, at the moment it belongs and nowhere else: after
                every question has been answered, in the same action as the
                card, under the same button. The mobile number was answered two
                steps back and is shown here with its own way back to that
                step, so all this adds is the six digits texted to it — and a
                customer who is already signed in is not asked anything at all.
            */}
            <section className="book-account" aria-labelledby="bk-acct">
              <h3 id="bk-acct">Your account</h3>

              {sessionLoading ? (
                <p className="book-hint">Checking whether you are signed in…</p>
              ) : account ? (
                <p className="book-hint">
                  Signed in as <strong>{account.phone_e164}</strong>. Nothing
                  else is asked for — this device stays signed in, so the next
                  booking is one button.
                </p>
              ) : (
                <>
                  <p className="book-hint">
                    Booking needs an account, and this is the whole of making
                    one. We text six digits to{' '}
                    <strong>{phone.trim() || 'the number you gave'}</strong> and
                    you type them in below; the account is created as this books,
                    in the same press.{' '}
                    <button type="button" className="linkish" onClick={() => go('where')}>
                      Use a different number
                      <span className="sr-only"> — go back to where you are</span>
                    </button>
                  </p>
                  <CodeSignIn
                    phone={phone} code={code} onCode={setCode}
                    state={bookingState} codeError={codeError}
                    turnstileToken={() => captcha.current}
                    onTokenSpent={() => {
                      captcha.current = null;
                      widget.current?.reset();
                    }}
                    // A 503 from the send is the same fact the top of this page
                    // states when the deployment is known to be unready, so it
                    // is raised to the same notice rather than left as a line
                    // beside a button that has gone.
                    onBlocked={setSignUpBlocked}
                  />
                </>
              )}

              {/* THE CARD SEAM, and the honest description of it. There is
                  deliberately no card number field here: the processor's own
                  element will own that box, the Worker refuses anything shaped
                  like a card number at ingress, and a dead-looking card form
                  would say the opposite of both. The sentence about what the
                  card is for is the Worker's own, so this page and the account
                  page cannot come to describe it differently. */}
              <p className="book-seam">
                <strong>No card is asked for today, and none can be taken.</strong>
                {' '}
                {bookingState?.card_note
                  ?? 'A card is what you will pay with, and it is not charged '
                    + 'when you add it. Nothing can be taken from one until '
                    + 'payment is switched on.'}
              </p>
            </section>

            {/* Last thing before the button, which is where it belongs: after
                everything the customer types, and in front of the one control
                that spends it. Renders nothing at all until a site key is
                configured, so today this leaves the page exactly as it was. */}
            <Turnstile ref={widget} action="book"
              onToken={(t) => { captcha.current = t; }} />

            {/* Announced rather than merely drawn. A press of Book that comes
                back refused — a lost slot, a wrong code — otherwise leaves
                somebody who cannot see this box with a button that appears to
                have done nothing at all. */}
            {placeError && <div className="error" role="alert">{placeError}</div>}

            <div className="book-nav">
              {/* Back is beside the button that spends the money on every
                  step, this one included. A last screen that can only be gone
                  forward from is the shape that makes people abandon a
                  checkout rather than correct one answer in it. */}
              <button className="btn quiet" type="button" disabled={placing}
                onClick={() => go(stepBefore(step))}>
                Back
              </button>
              <button className="btn" type="submit" disabled={!ready || placing}>
                {placing ? 'Holding your appointments…' : 'Book — no payment taken yet'}
              </button>
            </div>

            {/* One sentence, and it is always the reason that actually applies.
                The order matters: the two the customer can do nothing about
                come first, so nobody is told to type a code on a deployment
                that cannot send one. */}
            {!ready && !placing && (
              <p className="book-nav-why">
                {cannotBook
                  ? 'Nothing can be booked here yet — the note at the top of '
                    + 'this page says why.'
                  : sessionLoading
                    ? 'Checking whether you are already signed in…'
                    : !codeReady
                      ? `Type the ${CODE_DIGITS} digits we texted you and this `
                        + 'button turns on. Ask for the code with the button above.'
                      : pricing
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
