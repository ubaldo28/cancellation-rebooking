import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type Estimate, type EstimateOrder } from '../api';
import PayPanel from './PayPanel';
import { bookingWhen, formatMoney as money } from '../lib/format';
import { onDay } from '../lib/money';
import '../styles-parts.css';
import '../styles-estimate.css';

/**
 * THE CUSTOMER'S PRICE QUOTES, AND THE ROAD FROM "ACCEPTED" TO "PAID".
 *
 * WHAT THIS REPLACES IS NOTHING, AND THAT IS THE POINT. The estimates
 * machinery has been live on both sides for a long time — a customer asks for
 * a price in the conversation, the operator answers with a description, an
 * amount and a start time, and src/lib/estimates.ts has carried the whole of
 * it — and this bundle drew none of it. `api.decideEstimate` existed in api.ts
 * with no caller anywhere in web/src. There was no button on any page in this
 * product that could accept a quote.
 *
 * Then the Worker's half of accepting landed: an accept now writes a real
 * appointment, a real client row and a real order in one batch, and hands back
 * the order it became. Which turned the missing button into the urgent one —
 * because the state that acceptance produces is an order marked 'pending' with
 * nobody charged for it, and an unpaid order that the customer cannot see and
 * cannot reach is precisely the dead end this whole screen exists to close.
 *
 * SO THIS CARD HAS FOUR JOBS AND THEY ARE ALL ABOUT NOT STRANDING SOMEBODY:
 *
 *   1. Show a quote honestly — the description, the amount, and the window it
 *      is for — and let the customer accept or decline it.
 *
 *   2. On an accept, go straight into paying. The card form opens where the
 *      Accept button was, on this page, against the order the Worker just
 *      made. There is no confirmation screen in between with nothing to do on
 *      it: a booking somebody has agreed to and not paid for is not finished,
 *      and a screen that congratulates them on it is lying by omission.
 *
 *   3. On a refusal, say the Worker's own sentence and leave the conversation
 *      working. Nothing is written on any of the refusals, so the customer is
 *      exactly where they were — and for a clash in particular the quote is
 *      still standing, so the composer below is the answer and this card says
 *      so rather than going grey.
 *
 *   4. Give an accepted-but-unpaid booking a way back. The link is the whole
 *      of a guest's authority and it is the only thing they are ever sent —
 *      there is no email to resend and, for somebody quoted off a profile
 *      page, no account to sign in to — so the conversation page is the only
 *      place a closed tab can be recovered from, and it has to offer that
 *      without being asked.
 *
 * WHAT THIS CARD USED TO SAY IT COULD NOT DO, AND NOW DOES NOT HAVE TO.
 *
 * This comment spent its whole life recording a gap: an order left unpaid by
 * the CHECKOUT is a different order, Book.tsx's pay step already points people
 * here for it — "your booking is held under your conversation and you can pay
 * from there" — and this card could not honour that half, because the guest
 * thread payload carried the booking's `order_item_id` and not its `order_id`,
 * and an order id is what a charge is opened against. The note ended by saying
 * the fix was the Worker putting the order id on the guest payload and was not
 * something this component could work around.
 *
 * THE WORKER DOES THAT NOW. guestView sends `booking.order` — the id, the
 * total, whether it is paid and whether anything is actually owed — so the
 * checkout's unpaid booking is recovered by the page ITSELF, in GuestThread.tsx,
 * one card above this one, using this same PayPanel. That is the right place
 * for it: the booking card up there is what describes that booking, and the
 * Worker has already answered the paid question for it, so that panel needs no
 * probe and no "checking" state at all.
 *
 * WHICH CREATES THE ONE THING THIS CARD NOW HAS TO BE CAREFUL ABOUT: DRAWING
 * THE SAME MONEY TWICE. Accepting a quote points the thread at the appointment
 * it just made (attachBooking, in src/lib/estimates.ts), so for very nearly
 * every accepted quote the booking above IS this estimate's booking and
 * `booking.order.id` IS this estimate's `order_id` — one order, one charge, and
 * two panels offering to take a card for it. Two card forms for one debt is
 * worse than none: whichever one a person uses, the other is still sitting
 * there afterwards saying they owe money.
 *
 * So the page above tells this card which order it is already accounting for —
 * `handledAbove` — and this card leaves that one entirely alone: no panel, no
 * probe, and no line in the history either, because the booking card up there
 * already says what it is, when it is, what it costs and where its money
 * stands. One booking, one place on the page. Everything else an accepted quote
 * can produce is still this card's, and that is not a dead branch: attachBooking
 * is allowed to fail without undoing the acceptance, and a second quote
 * accepted on the same conversation books a second order the thread does not
 * point at. Those are the orders nothing else on the page can reach.
 *
 * WHY IT ASKS THE PAY ROUTE WHETHER AN ACCEPTED ORDER IS PAID, ON MOUNT.
 * Nothing else on this page can answer the question. The guest thread payload
 * carries what was booked and nothing about what happened to the money — no
 * status, no paid date — and the account read GuestThread does for the same
 * purpose needs a session, which a stranger quoted from a profile page does
 * not have and will never have. `startPayment` is the only thing that knows,
 * and asking it is cheap and safe: an order with `paid_at` set returns
 * immediately without touching the processor, and one without reuses the
 * intent it already has rather than opening a second. See src/lib/checkout.ts.
 *
 * The alternative was to draw the card form first and let it correct itself,
 * and that is the version that tells somebody who has already paid that they
 * owe money — briefly, on every page load, for ever. A page about money is
 * allowed to say "checking"; it is not allowed to guess.
 */

/**
 * The refusal code that means the quote is STILL LIVE and the customer should
 * talk to the business rather than give up.
 *
 * A quote is a standing offer against a start time and it can stand for days.
 * In that time the business takes other work, and nothing in this product goes
 * back and withdraws a quote because the morning it names has filled up — so
 * the write that books it is the first thing that can find out, which is
 * exactly what this code comes back from. The estimate row is untouched: it is
 * still 'quoted', it can still be accepted for a different time, and the way
 * to get one is the composer at the foot of this page.
 *
 * Every other refusal ends the quote one way or another, so they get the
 * Worker's sentence and nothing else.
 *
 * WRITTEN OUT HERE AND IN src/lib/estimates.ts, which is a duplicated fact
 * across the two trees and is pinned as one in test/two-trees.test.ts. A
 * renamed code with this copy left behind would not throw or fail to compile;
 * it would quietly stop offering the one way forward on the one refusal that
 * has one.
 */
const SLOT_TAKEN = 'slot_taken';

/** Same cadence as the conversation: a quote arrives while somebody is typing it. */
const POLL_MS = 15_000;

/** What each estimate on this conversation is, for the purpose of drawing it. */
export interface EstimateBuckets<T> {
  /** Accepted, with a booking behind it, and this card's to pay for. */
  booked: T[];
  /** Still waiting on somebody: them to price it, or the customer to answer. */
  open: T[];
  /** Nobody is waiting on these. History, one line each. */
  past: T[];
  /** Accounted for by the booking card above this one. Drawn nowhere here. */
  above: T[];
}

/**
 * WHICH ESTIMATES THIS CARD DRAWS, AND WHICH ONE IT MUST NOT.
 *
 * Pulled out of the component and exported for one reason: the rule that stops
 * this page asking for the same debt twice lives in here, it is three list
 * filters with an order between them, and it is worth being able to run rather
 * than read. test/guest-pay.test.ts lifts this straight out of the file and
 * feeds it the shapes that matter.
 *
 * `handledAbove` is the order the conversation page's own booking card is
 * already accounting for — see the note at the top of this file. Accepting a
 * quote repoints the thread at the appointment it just booked, so that is
 * normally this very estimate's order, and drawing it here as well would put
 * two card forms on one page for one charge.
 *
 * THE ORDER OF THESE FOUR LINES IS THE WHOLE THING. `above` is taken out
 * first and everything else is built from what is left, because `past` is
 * defined as "in neither of the other two" — so an accepted estimate merely
 * dropped from `booked` would land in the history list instead and be printed
 * as "You accepted this — ask them below, we have no booking against it". That
 * sentence is for the genuinely stranded rows, and about this one, whose
 * booking is the card immediately above it, it would be a flat lie.
 */
export function splitEstimates<T extends { status: string; order_id: string | null }>(
  list: T[], handledAbove: string | null,
): EstimateBuckets<T> {
  const above = list.filter((e) => e.order_id != null && e.order_id === handledAbove);
  const mine = list.filter((e) => !above.includes(e));
  const booked = mine.filter((e) => e.status === 'accepted' && e.order_id);
  const open = mine.filter((e) => e.status === 'asked' || e.status === 'quoted');
  const past = mine.filter((e) => !booked.includes(e) && !open.includes(e));
  return { booked, open, past, above };
}

/** What the pay route said about one accepted estimate's order, once asked. */
interface OrderState {
  /**
   * The amount, in cents, AS THE SERVER GAVE IT. Either `total_cents` off the
   * order the accept returned or `amount_cents` off the pay route — which are
   * the same figure by construction — and never anything this file worked out.
   */
  amount_cents: number;
  currency: string;
  /**
   * True when the money is already taken. `startPayment` answers this for an
   * order whose `paid_at` is set and for one whose intent has succeeded, which
   * covers the two ways somebody arrives here having already paid: the webhook
   * landed, or it has not landed yet and the processor says the charge went
   * through anyway.
   */
  paid: boolean;
}

export interface EstimatesProps {
  threadRef: string;
  /** For the sentences. The business is a party to every one of them. */
  business: string;
  /** The business's, off the thread — so the quote and the booking card agree. */
  timezone?: string;
  locale?: string;
  /**
   * The order the page ABOVE this card is already accounting for, when there is
   * one: `thread.booking.order.id` off the guest payload.
   *
   * Not a styling hint and not an optimisation. Accepting a quote repoints the
   * thread at the appointment it just booked, so the conversation page's own
   * booking card is normally describing — and, when money is owed, already
   * taking a card for — the very order an accepted estimate here points at. An
   * estimate whose order id matches this is skipped completely: no payment
   * panel, no pay-route probe, and no history line claiming there is no booking
   * behind it. See the note at the top of this file.
   *
   * Null or absent means nothing is being handled above and this card owns
   * every accepted order it can see, which is how it behaved before this prop
   * existed.
   */
  handledAbove?: string | null;
  /**
   * Fires when something here changed the booking: an accept, which makes an
   * appointment and points the thread at it, and a payment, which moves the
   * money the page prints above. Both leave the rest of this screen stale —
   * the confirmation card, the start code, the money line — so the page reloads
   * itself rather than this card pretending it is the only thing that moved.
   */
  onChanged?: () => void;
}

export default function Estimates({
  threadRef, business, timezone, locale, handledAbove = null, onChanged,
}: EstimatesProps) {
  const [list, setList] = useState<Estimate[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Whether the refusal in `error` is the one that leaves the quote standing.
   * Kept apart from the message because the message is the Worker's and the
   * extra sentence under it is ours — see SLOT_TAKEN.
   */
  const [stillOpen, setStillOpen] = useState(false);
  const [orders, setOrders] = useState<Record<string, OrderState>>({});

  /**
   * Orders the pay route has already been asked about, or whose answer we knew
   * without asking because the accept had just come back with it.
   *
   * A ref rather than state, and read rather than rendered: its only job is to
   * stop the fifteen-second poll asking the same question every fifteen
   * seconds. The pay route is rate limited per address (twenty in ten minutes),
   * and a phone left on a table with this page open would spend that in five.
   */
  const probed = useRef<Set<string>>(new Set());

  /**
   * Whether this card is still on the screen.
   *
   * A ref on the component rather than a flag owned by the effect below, and
   * the difference is a real bug rather than a style preference. That effect
   * re-runs on every poll, because a poll hands back a new array; an
   * effect-scoped flag would therefore be flipped by the NEXT poll while a
   * request from this one was still in the air, the answer would be thrown
   * away — and `probed` has already recorded that the question was asked, so
   * nothing would ever ask again. The order would sit reading "checking where
   * the payment stands" until the page was reloaded, which on the one card
   * whose whole job is to get somebody paid is the worst place to lose an
   * answer. Set on mount as well as cleared on unmount, because StrictMode
   * mounts twice in development and a ref survives between the two.
   */
  const shown = useRef(true);
  useEffect(() => {
    shown.current = true;
    return () => { shown.current = false; };
  }, []);

  /**
   * ONE `onPaid` PER ORDER, MADE ONCE AND KEPT, and this is a bug fix rather
   * than a tidy-up.
   *
   * PayForm re-runs its whole setup whenever the `onPaid` it was handed is a
   * different function from last time — it has to, because that effect is what
   * opens the charge and mounts the processor's fields. A fresh arrow written
   * inline inside the `booked.map` below is a different function on every
   * render, and this card re-renders every fifteen seconds whatever anybody
   * does, because the poll hands `setList` a new array each time. So a customer
   * halfway through typing a card number had the payment route called again,
   * another Payment Element mounted into the same box, and what they had typed
   * thrown away — every fifteen seconds, for as long as they took. On a slow
   * phone that is a form nobody can finish, and it spends the pay route's rate
   * limit (twenty in ten minutes) in five minutes of sitting still.
   *
   * The cache is keyed by order id, so each panel keeps the same function for
   * as long as it is on the screen, and `onChanged` is read through a ref so
   * that a parent passing an inline arrow — which GuestThread.tsx did until
   * this was written — cannot reintroduce the churn from the other side.
   */
  const onChangedRef = useRef(onChanged);
  useEffect(() => { onChangedRef.current = onChanged; }, [onChanged]);

  const paidHandlers = useRef(new Map<string, () => void>());
  const markPaid = useCallback((orderId: string) => {
    const cache = paidHandlers.current;
    let fn = cache.get(orderId);
    if (!fn) {
      fn = () => {
        // Functional, and a no-op when nothing is known about this order: the
        // one state worth protecting is a probe that landed in between, and
        // spreading over a `state` captured at render time would put a stale
        // amount back on the screen a moment after the money moved.
        setOrders((o) => {
          const held = o[orderId];
          return held ? { ...o, [orderId]: { ...held, paid: true } } : o;
        });
        // The money moved, so the confirmation card and its money line on the
        // page above this one are both stale.
        onChangedRef.current?.();
      };
      cache.set(orderId, fn);
    }
    return fn;
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await api.guestEstimates(threadRef);
      setList(res.estimates);
    } catch {
      // A quote list that will not load is not worth an error box on a page
      // whose main job is the conversation. The poll will pick it up.
    } finally {
      setLoaded(true);
    }
  }, [threadRef]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const id = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  /**
   * Find out where the money stands on every accepted booking on this
   * conversation, once each.
   *
   * This is the recovery path and it runs without anybody tapping anything,
   * because the person it exists for is the one who already tapped: they
   * accepted a quote, the appointment was made, and then the tab closed, or
   * the signal went, or the card was declined and they came back later. There
   * is nobody to prompt. The page has to work it out on sight of the link.
   */
  useEffect(() => {
    void (async () => {
      for (const e of list) {
        const orderId = e.order_id;
        if (e.status !== 'accepted' || !orderId) continue;
        // Handled by the booking card above, which was told where its money
        // stands by the Worker and needs nothing from this route. Skipped
        // before `probed` is written rather than after, so that if the page
        // above ever stops covering this order — a prop that goes back to null
        // — the question gets asked then rather than being remembered as
        // already answered. The pay route is rate limited per address and this
        // effect runs on every fifteen-second poll, so a request not spent here
        // is a request the customer still has when they need it.
        if (orderId === handledAbove) continue;
        if (probed.current.has(orderId)) continue;
        probed.current.add(orderId);

        let state: OrderState;
        try {
          const handle = await api.startPayment(orderId);
          state = {
            amount_cents: handle.amount_cents,
            currency: handle.currency,
            paid: handle.paid,
          };
        } catch {
          // Could not find out: payments off on this deployment, a rate limit
          // spent, or a dropped request. Fall back to the figures on the
          // estimate itself — which are still the Worker's numbers, the ones
          // the customer agreed to, and not something worked out here — and
          // let PayForm say what is actually wrong when it tries the same
          // route a moment later. Drawing nothing would be the wrong move: a
          // booking nobody can reach a card form for is the exact state this
          // card exists to end.
          state = {
            amount_cents: e.price_cents ?? 0,
            currency: e.currency ?? 'USD',
            paid: false,
          };
        }

        if (!shown.current) return;
        // Never over the top of an answer already held. The one that matters
        // is a payment that went through WHILE this was in the air: `onPaid`
        // below writes paid:true, and a stale probe saying otherwise would put
        // the card form back in front of somebody who has just used it.
        setOrders((o) => (o[orderId] ? o : { ...o, [orderId]: state }));
      }
    })();
  }, [list, handledAbove]);

  const decide = useCallback(async (
    e: Estimate, decision: 'accepted' | 'declined',
  ) => {
    setBusy(e.id);
    setError(null);
    setStillOpen(false);
    try {
      const res = await api.decideEstimate(threadRef, e.id, decision);
      // Read off the top level, falling back to the copy on the estimate.
      // The Worker mirrors the same object in both places precisely so a page
      // reaching for either spelling finds it rather than tapping pay against
      // undefined; taking both is free and makes this immune to either half
      // being dropped.
      const order: EstimateOrder | null = res.order ?? res.estimate.order ?? null;

      if (order) {
        // Known unpaid without asking: this order was written seconds ago by
        // the batch that answered this request, unpaid and 'pending'. Marking
        // it probed is what keeps the effect above from spending a request to
        // be told what we already know.
        probed.current.add(order.id);
        setOrders((o) => ({
          ...o,
          [order.id]: {
            amount_cents: order.total_cents,
            currency: order.currency,
            paid: false,
          },
        }));
      }

      // The returned row, put straight into the list, so the card form appears
      // under the thumb that pressed Accept rather than after a round trip.
      // `load` still runs underneath to pick up anything else that moved.
      setList((rows) => rows.map((r) => (r.id === res.estimate.id ? res.estimate : r)));
      void load();
      // An accept made an appointment and pointed the thread at it, so the
      // confirmation card above this one is now out of date. A decline moved
      // nothing, but it did write a line into the transcript.
      onChanged?.();
    } catch (err) {
      // THE WORKER'S OWN WORDS, ALWAYS. Every refusal on this route arrives as
      // a sentence written for the person holding the quote — "Sorry, that
      // slot has just been taken", "That time has passed. Ask them for a fresh
      // estimate", and the one naming a business that has not finished setting
      // up payments. Re-writing any of them here would mean two descriptions
      // of one refusal, and the one this page invented would be the vaguer.
      setError(err instanceof ApiError
        ? err.message
        : 'That did not go through. Check your signal and try again.');
      setStillOpen(err instanceof ApiError && err.code === SLOT_TAKEN);
      // Nothing was written on any refusal, so the list is still true — but a
      // quote that was answered in another tab, or expired while this page sat
      // open, has a new status worth showing under the sentence explaining it.
      void load();
    } finally {
      setBusy(null);
    }
  }, [threadRef, load, onChanged]);

  if (!loaded || list.length === 0) return null;

  const { booked, open, past } = splitEstimates(list, handledAbove);

  // Everything this conversation had to say is being said by the booking card
  // above. An empty shell with a chip on it would read as a section that had
  // failed to load.
  if (booked.length === 0 && open.length === 0 && past.length === 0) return null;

  const owing = booked.some((e) => orders[e.order_id!]?.paid === false);
  const waiting = open.some((e) => e.status === 'quoted');

  return (
    <section className="card estimates-card">
      {/* The chip names the most pressing of the three, in that order. Money
          outstanding beats an unanswered price, which beats a card that is
          only history. */}
      <span className={`chip ${owing || waiting ? 'warn' : 'neutral'}`}>
        {owing ? 'Needs paying' : waiting ? 'Needs your answer' : 'Your estimates'}
      </span>

      {/* --- accepted, and where its money stands ---------------------------
          FIRST ON THE CARD, above a quote still waiting to be answered. An
          appointment that is booked and unpaid is somebody's Thursday morning
          held on a promise, and it is the only thing here that gets worse the
          longer it is left. */}
      {booked.map((e) => {
        const orderId = e.order_id!;
        const state = orders[orderId];
        const label = e.description ?? 'the work you agreed';

        if (!state) {
          // Between mount and the pay route's answer. Deliberately says
          // nothing about whether anything is owed — see the note at the top
          // of this file about not guessing.
          return (
            <p key={e.id} className="faint estimate-checking">
              Checking where the payment stands on {label}…
            </p>
          );
        }

        if (state.paid) {
          return (
            <div key={e.id} className="estimate-settled">
              <div className="quote-desc">{label}</div>
              <p style={{ margin: 0 }}>
                <strong>Paid.</strong>{' '}
                {money(state.amount_cents, state.currency, locale)} went through
                on your card, so this booking is confirmed with {business} and
                there is nothing more to pay for it. Round The Way holds that
                payment until the job is done and then pays them.
              </p>
              {e.starts_at != null && e.duration_seconds != null && (
                <p className="faint" style={{ margin: 0 }}>
                  {bookingWhen(e.starts_at, e.starts_at + e.duration_seconds,
                    timezone, locale)}
                </p>
              )}
            </div>
          );
        }

        return (
          <PayPanel
            key={e.id}
            className="estimate-pay"
            orderId={orderId}
            total={money(state.amount_cents, state.currency, locale)}
            title="Pay for this booking"
            lead={<>
              You accepted {label}
              {e.starts_at != null && e.duration_seconds != null && <>
                {' '}for {bookingWhen(e.starts_at, e.starts_at + e.duration_seconds,
                  timezone, locale)}</>}
              {e.decided_at != null && <> on {onDay(e.decided_at, locale)}</>}, and
              the time is held in {business}'s calendar. Paying is what confirms
              it with them.
            </>}
            /* The conversation page IS the link, so this cannot send somebody
               anywhere — it tells them the link they are already on is the way
               back, which is the only thing a guest is ever given. */
            comeBack={<>
              Nothing is lost if you close this page. The booking stays held and
              this link brings you back to exactly here, with the card form
              still waiting. If your card was refused, the booking is still
              yours — try again above, or message {business} below.
            </>}
            /* The cached one for this order, never a fresh arrow — see
               markPaid above for what a fresh one costs a person mid-card. */
            onPaid={markPaid(orderId)}
          />
        );
      })}

      {/* --- a price to answer, or a price still being worked out ----------- */}
      {open.map((e) => {
        if (e.status === 'asked') {
          return (
            <div key={e.id} className="quote estimate-asked">
              <div className="quote-desc">{e.request}</div>
              <p className="quote-note" style={{ margin: 0 }}>
                You asked {business} what this would cost. Nothing is booked and
                nothing is held — they will send a price and a time here, and
                you decide then.
              </p>
            </div>
          );
        }

        const amount = money(e.price_cents ?? 0, e.currency ?? 'USD', locale);
        return (
          <div key={e.id} className="quote">
            <div className="quote-desc">{e.description ?? e.request}</div>

            {/* The number is the largest thing on the card, for the reason
                styles-parts.css gives on this same rule: a quote whose price is
                smaller than its description is a quote somebody accepts without
                reading the number. */}
            <div className="quote-amount">{amount}</div>

            {e.starts_at != null && e.duration_seconds != null && (
              <div className="quote-split faint">
                {bookingWhen(e.starts_at, e.starts_at + e.duration_seconds,
                  timezone, locale)}
              </div>
            )}

            <p className="quote-note">
              Accepting books that time with {business} and opens the card form
              here, on this page. The price above is the price you pay — nothing
              is added to it, and nothing is taken until you put a card in.
            </p>

            {/* Accept is the quiet button and declining is the plain one, the
                same way round as the parts quote beneath this card and for the
                same reason: the tap that commits money should never be styled
                as the obvious tap. The amount is on the button itself, so the
                figure being agreed to is the thing being pressed. */}
            <div className="quote-actions">
              <button className="btn quiet" type="button" disabled={busy === e.id}
                onClick={() => void decide(e, 'accepted')}>
                {busy === e.id ? 'Booking it…' : `Accept ${amount}`}
              </button>
              <button className="btn ghost" type="button" disabled={busy === e.id}
                onClick={() => void decide(e, 'declined')}>
                No thanks
              </button>
            </div>

            <p className="faint" style={{ margin: '10px 0 0' }}>
              Declining costs nothing and does not end the conversation. Ask
              {' '}{business} below if you want it done differently, or at a
              different time.
            </p>
          </div>
        );
      })}

      {error && (
        <div className="error" role="alert" style={{ marginTop: 12 }}>
          {/* The Worker's sentence, verbatim. */}
          {error}
          {stillOpen && (
            // The one refusal with a way forward, and the reason this card
            // does not simply grey out on a 409. The quote is untouched and
            // still standing; all that is gone is the hour it named.
            <>
              {' '}The estimate itself is still open, so nothing is lost — ask
              {' '}{business} in the conversation below for another time and
              they can send it here.
            </>
          )}
        </div>
      )}

      {past.length > 0 && (
        <div className="quote-history">
          {past.map((e) => (
            <div key={e.id} className="quote-past">
              <span>{e.description ?? e.request}</span>
              <span className="faint">
                {e.price_cents != null
                  && `${money(e.price_cents, e.currency ?? 'USD', locale)} · `}
                {PAST_WORDS[e.status]}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * What happened to an estimate nobody is waiting on any more.
 *
 * 'accepted' is in here for the row that has no order behind it, which is the
 * one shape the Worker says is impossible to create today and is exactly why
 * the wording is careful: a handful of rows predate the batch that writes the
 * booking and the acceptance together, and every one of them is a customer who
 * said yes and got nothing. Telling that person "booked" would be the same
 * lie twice; telling them to ask is the only honest thing this page can do,
 * because the booking genuinely does not exist and no button here can make it.
 *
 * "Taken back" rather than "withdrawn", matching the parts card below: a
 * customer who saw a number and then sees it marked withdrawn assumes
 * something went wrong with their own tap.
 */
const PAST_WORDS: Record<Estimate['status'], string> = {
  asked: 'Waiting on a price',
  quoted: 'Waiting on you',
  accepted: 'You accepted this — ask them below, we have no booking against it',
  declined: 'You declined this — nothing was charged',
  withdrawn: 'The business took this back',
  expired: 'The time passed before it was answered — ask them to resend',
};
