import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api, ApiError, guestMessagePhotoUrl,
  type ChatMessage, type CustomerBooking, type ErasureResult, type Thread,
} from '../api';
import Chat from '../components/Chat';
import DeleteMyData from '../components/DeleteMyData';
import Estimates from '../components/Estimates';
import PartsQuotes from '../components/PartsQuotes';
import StartCode from '../components/StartCode';
import WorkQuestion from '../components/WorkQuestion';
import JobProof from '../components/JobProof';
import PayPanel from '../components/PayPanel';
import VanTrack from '../components/VanTrack';
import SiteHeader from '../components/SiteHeader';
import { ErrorNote, Spinner } from '../components/ui';
import { bookingWhen } from '../lib/format';
import { bookingMoney, type MoneyTone } from '../lib/money';
import { useDocumentTitle } from '../lib/title';


/** Long enough not to hammer the Worker, short enough that a reply feels live. */
const POLL_MS = 15_000;

/**
 * WHICH DOOR THE READER CAME THROUGH, which is the only thing this page needs
 * to branch on.
 *
 * It comes from the ROUTE rather than from the payload, deliberately. The page
 * has to say something correct while the first read is still in flight and
 * again if that read 404s, and in both of those states there is no payload to
 * ask — so a `via` field on the response would arrive too late to be used for
 * either. The route is known on the first render: /c/:token is `link` and
 * /account/messages/:id is `account`, and nothing else can reach this file.
 */
export type ConversationDoor = 'link' | 'account';

export interface ConversationProps {
  /**
   * Which conversation, in the form the Worker's paths want: the token out of
   * a /c/:token link, or the thread id when the reader is signed in. See the
   * long note on `ref` above guestMessagePhotoUrl in api.ts.
   */
  threadRef: string;
  door: ConversationDoor;
}

/**
 * The customer's side of one conversation — everything on it, both ways in.
 *
 * WHY THIS IS A COMPONENT AND NOT TWO PAGES. It used to be GuestThread.tsx and
 * nothing else, because there was only one way to reach a conversation. There
 * are two now, and every single thing on the screen is the same in both: the
 * booking card, the money line, the card form for a booking nobody has paid
 * for, the quotes, the refund question, the start code, the parts approval, the
 * photo strip, the transcript, the composer, the erasure. A second copy of this
 * file would have been a second copy of the unpaid-booking panel and the refund
 * arithmetic around it, and the first divergence in either of those is a
 * customer charged twice or told they were paid when they were not. So: one
 * component, two five-line route wrappers, and a prop saying which door.
 *
 * THE TWO DOORS, AND WHY BOTH HAVE TO EXIST.
 *
 * The link: /c/:token, where the secret in the address bar is the whole
 * authority. It works on a phone that has never been signed in, which is how
 * somebody reads a message from the business while standing in their own
 * driveway, and it is all a guest who never made an account has ever had. That
 * is not legacy and it is not going away.
 *
 * The account: /account/messages/:id, where the authority is the session
 * cookie and the id is merely which conversation is meant. This is what did
 * not exist, and the owner's description of the gap is the whole of the
 * reason: "there has to be a way for a business and client to continue a
 * conversation without needing to keep a link." Booking has created an account
 * since migration 0037, so somebody who lost the link had a proved email
 * address, an account, and a booking listed at /account — and still no way
 * back to the messages, the photographs they had sent of their own kitchen,
 * the start code, or the card form for a booking nobody had been charged for.
 * Only a fingerprint of the token is stored, on purpose, so nobody could hand
 * it back to them. Migration 0052 put the account on the thread; this page is
 * the other end of that.
 *
 * WHAT THE `door` PROP IS ACTUALLY USED FOR, and it is less than a reader
 * might expect: two pieces of copy and nothing else. The "keep this link"
 * notice, which is a true sentence on one door and a false one on the other;
 * and what to say when the conversation cannot be found, where the advice for
 * a mistyped link ("open your full link again") is the wrong advice for a
 * signed-out account holder ("sign in") and vice versa. Everything else on
 * this page — every fetch, every panel, every amount — is identical, because
 * the Worker resolves both doors to the same thread on the same routes.
 */
export default function Conversation({ threadRef, door }: ConversationProps) {
  const [thread, setThread] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  /**
   * The guest-link guard on the Worker is already counting this connection.
   *
   * Kept apart from `missing` because the two need opposite advice and the
   * wrong one makes things worse. `missing` says the conversation is gone and
   * tells the reader to open their full link again from wherever they saved it
   * — which is the correct thing to say about a mistyped link and the exact
   * wrong thing to say to somebody who is locked out, because opening it again
   * is what renews the lock. See guardGuestLink in src/lib/guestlink.ts: ten
   * failed reads in fifteen minutes, then a fifteen-minute lock on the IP.
   *
   * Holds the Worker's own sentence rather than one written here, because the
   * Worker knows how long is left and this page does not.
   */
  const [lockedOut, setLockedOut] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  /**
   * Set once the erasure has come back, and never cleared.
   *
   * The thread this page is built on is one of the rows the Worker deletes, so
   * the moment this is set there is nothing behind the link any more. Every
   * read of it has to stop — the poll included, which would otherwise turn the
   * page into "we could not find a conversation at this link" fifteen seconds
   * after somebody deliberately deleted it, as though something had gone
   * wrong.
   */
  const [erased, setErased] = useState<ErasureResult | null>(null);
  /**
   * This booking's row off the reader's own account, when they have one open on
   * this device. Null the rest of the time, and that is not a failure.
   *
   * WHY THE MONEY COMES FROM HERE RATHER THAN OFF THE THREAD. The guest payload
   * carries what was booked — the service, the time, the address, the price —
   * and nothing at all about what happened to the payment afterwards: no
   * cancellation, no refund figure, no date one went out. So the only honest
   * source for "your £240 went back on the 12th" on this page is
   * /api/customer/bookings, which carries all of it, and the two payloads share
   * `order_item_id` so the right row can be picked out of the list.
   *
   * NOTHING IS SHOWN THAT THE READER DOES NOT ALREADY OWN. The match is on an
   * id inside their own account's bookings, so somebody signed in to a
   * different account gets no match and the page falls back to exactly what it
   * said before — the link is still the whole authority for everything else on
   * this screen, and none of that depends on being signed in.
   */
  const [paid, setPaid] = useState<CustomerBooking | null>(null);
  /**
   * The order that was paid for IN THIS TAB, in the seconds before the Worker
   * has caught up.
   *
   * Paying does not make `booking.order.due` false. What clears that is
   * `paid_at`, and `paid_at` is written when the processor tells the Worker
   * server to server — which is the right way round, because a customer whose
   * phone dies the instant after they press Pay must still end up with a
   * booking. But it is usually a second or two behind, and the reload this page
   * does on a successful payment therefore comes back still saying money is
   * owed. Without this, the card form would reappear underneath somebody who
   * had just used it, which on a page about money reads as "that did not work,
   * do it again" — and the second attempt is the one that frightens people.
   *
   * Never cleared. It only ever means "do not ask this person for this money
   * again on this screen", and the confirmation it is replaced by comes from
   * the Worker the moment the webhook lands.
   */
  const [justPaid, setJustPaid] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!threadRef) { setMissing(true); setLoading(false); return; }
    setLoading(true); setError(null); setMissing(false);
    try {
      const res = await api.guestThread(threadRef);
      setThread(res.thread);
      setMessages(res.messages);
    } catch (e) {
      // A link that has been mistyped or closed is an ordinary outcome, not a
      // fault, and gets its own wording rather than an error box.
      if (e instanceof ApiError && e.status === 404) setMissing(true);
      // Same reasoning as the poll below: a lock is not a missing link, and the
      // advice for one is the opposite of the advice for the other.
      else if (e instanceof ApiError && e.status === 429) setLockedOut(e.message);
      else setError(e instanceof Error ? e.message : 'Could not open this conversation.');
    } finally {
      setLoading(false);
    }
  }, [threadRef]);

  useEffect(() => { void load(); }, [load]);

  // A quiet re-read for the poll. It must never blank the page or raise an
  // error: a dropped request while the phone changes cell is not news.
  //
  // BUT IT MUST STOP WHEN THE ANSWER IS FINAL, AND IT USED NOT TO. This catch
  // swallowed everything and the loop ran on regardless, which is fine for a
  // dropped request and was a trap for the two answers that will never change.
  //
  // What it cost, in the order it happens. A conversation can go away UNDER an
  // open tab — retention sweeps a thread 30 days after the last message and 180
  // days after the job, and the demo rebuilds itself from scratch on every
  // visit. The page then polls a conversation that is permanently gone, every
  // fifteen seconds, silently. `load` gets this right and sets `missing` on a
  // 404; only the poll did not, so whether the loop stopped came down to
  // whether the tab happened to be open when the thread died.
  //
  // Ten failed reads inside fifteen minutes is what the guest-link guard on the
  // Worker treats as somebody walking the token space, and it answers with a
  // fifteen-minute lock ON THE IP — see guardGuestLink in lib/guestlink.ts,
  // which cannot tell a deleted link from a guessed one and must not try. A
  // polling tab reaches ten in two and a half minutes. So a customer who opened
  // their own link ONCE, and left it open, locked themselves and everybody else
  // on their connection out of every conversation link on the site, and the
  // loop kept going and kept renewing it. This is exactly what happened here,
  // and the person it happened to was told they must have opened the link ten
  // times. They had not.
  //
  // 404 means the conversation is gone; 429 means the guard is already counting
  // and every further poll makes it worse. Both stop the loop, through the same
  // `missing` flag the effect below already reads. Everything else — a dropped
  // connection, a cell handover, a Worker blip — still goes by in silence and
  // the next poll tries again.
  const refresh = useCallback(async () => {
    if (!threadRef) return;
    try {
      const res = await api.guestThread(threadRef);
      setThread(res.thread);
      // A poll that was already in flight when a message was sent comes back
      // without it. Keeping anything the response does not mention stops a
      // sent message vanishing off the screen for fifteen seconds.
      setMessages((prev) => {
        const fetched = new Set(res.messages.map((m) => m.id));
        const missed = prev.filter((m) => !fetched.has(m.id));
        return missed.length ? [...res.messages, ...missed] : res.messages;
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setMissing(true);
      else if (e instanceof ApiError && e.status === 429) setLockedOut(e.message);
      // Anything else: the next poll tries again.
    }
  }, [threadRef]);

  // Poll only while the tab is being looked at. A phone left on a table with
  // this page open would otherwise keep asking the Worker for messages all
  // day, and the customer would still read them the moment they came back.
  useEffect(() => {
    if (!threadRef || missing || erased || lockedOut) return;
    let timer: number | undefined;
    const stop = () => {
      if (timer !== undefined) { window.clearInterval(timer); timer = undefined; }
    };
    const start = () => { stop(); timer = window.setInterval(() => { void refresh(); }, POLL_MS); };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') { void refresh(); start(); } else stop();
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [threadRef, missing, erased, lockedOut, refresh]);

  const send = useCallback(async (body: string) => {
    if (!threadRef) return;
    setSending(true); setSendError(null);
    try {
      const { message } = await api.guestSend(threadRef, body);
      setMessages((rows) => [...rows, message]);
      // Handed back so the composer can tell the sender what was taken out.
      // Never stored and never shown to the business.
      return message.notice ?? null;
    } catch (e) {
      setSendError(e instanceof Error ? e.message : 'That did not send. Try again.');
      throw e;  // rethrown so the composer keeps the typed text
    } finally {
      setSending(false);
    }
  }, [threadRef]);

  /**
   * The same send, with a photograph on it.
   *
   * The customer's half of this matters as much as the operator's and for the
   * mirror-image reason: somebody standing in their own kitchen photographing
   * the leak is not going to create an account first, and the link in the
   * address bar is the whole of their authority here exactly as it is for
   * everything else on this page.
   *
   * Neither `sending` nor `sendError` is touched. The composer runs the upload,
   * shows the progress and owns the refusal — see the matching note in
   * Messages.tsx. Setting the page's error box as well would say the same thing
   * twice, in two places, about one photograph.
   */
  const sendPhoto = useCallback(async (
    form: FormData, onProgress: (fraction: number) => void,
  ) => {
    if (!threadRef) return;
    const { message } = await api.guestSendPhoto(threadRef, form, onProgress);
    setMessages((rows) => [...rows, message]);
    // A caption is an ordinary message body and is redacted like one, so the
    // same notice has to come back to the same sender.
    return message.notice ?? null;
  }, [threadRef]);

  /**
   * Where one photograph in this conversation is fetched from.
   *
   * NESTED UNDER THE CONVERSATION BECAUSE THE CONVERSATION IS THE
   * AUTHORISATION, whichever door the reader came through. On a link there is
   * no session on the device and there is not meant to be one, so the token in
   * the path is the whole of it; on an account the cookie the browser already
   * sends is the whole of it and the id in the path is only which conversation
   * is meant. Either way the Worker checks on every single read that the photo
   * belongs to the thread that path resolves to, so an id copied out of
   * somebody else's conversation answers "no such photo" in the same words a
   * made-up one gets.
   *
   * THIS ONLY WORKS SAME-ORIGIN and that is why the URL has no host on it. It
   * ends up in an `<img src>` rather than in a fetch, and a browser sends
   * neither the cookie nor a header to another origin — so the account door's
   * pictures would silently 404 if this were ever made absolute.
   */
  const photoSrc = useCallback(
    (photoId: string) => guestMessagePhotoUrl(threadRef ?? '', photoId), [threadRef]);

  const business = thread?.business_name ?? 'the business';
  const booking = thread?.booking ?? null;

  // Read when the booking is known, and again the moment something happens that
  // moves the money — not on the fifteen-second poll. Signed out is the
  // ordinary state of this page, so a 401 here is the common answer rather than
  // a fault, and asking again every fifteen seconds would spend a request
  // repeating a question already answered no.
  const orderItemId = booking?.order_item_id ?? null;
  const loadPaid = useCallback(async () => {
    if (!orderItemId) { setPaid(null); return; }
    try {
      const res = await api.customerBookings();
      setPaid(res.bookings.find((b) => b.order_item_id === orderItemId) ?? null);
    } catch {
      // Signed out, or the read failed. Either way the page says less rather
      // than saying something is wrong: nothing else on it needs an account.
    }
  }, [orderItemId]);

  useEffect(() => {
    if (erased) { setPaid(null); return; }
    void loadPaid();
  }, [loadPaid, erased]);

  /**
   * Both reads, as ONE function that keeps its identity between renders.
   *
   * The identity is the load-bearing half. PayForm re-opens the charge and
   * re-mounts the processor's card fields whenever the `onPaid` it was handed
   * is a different function from last time, and this page re-renders every
   * fifteen seconds whatever anybody does, because the poll calls `setThread`
   * with a fresh object. An arrow written inline at the call site would
   * therefore wipe a half-typed card number every fifteen seconds — see the
   * matching note on markPaid in Estimates.tsx, which had the same defect.
   *
   * Why both reads and not one, for every caller of it: whatever moved here
   * moved the money, and the money is printed by the conversation payload (the
   * price, the booking card) AND by the reader's own account row (the refund,
   * the settlement). Reloading one would leave half this screen describing the
   * state before the tap.
   */
  const refreshBooking = useCallback(() => {
    void load();
    void loadPaid();
  }, [load, loadPaid]);

  /**
   * Where this booking's order stands, as the Worker sees it: the id a charge
   * is opened against, the total, whether it is paid, and whether anything is
   * still owed.
   *
   * Null for a booking with no order behind it at all. A handful genuinely have
   * none — the single-slot claims that predate orders — and that is an ordinary
   * answer rather than a fault: the page simply says nothing new about the
   * money and offers no card form, which is exactly what it did before this
   * field existed. Guessing on their behalf is the one thing it must not do.
   */
  const order = booking?.order ?? null;

  /**
   * Whether to put a card form in front of the reader for this booking.
   *
   * The Worker's answer, minus anything paid on this device in the last few
   * seconds. Nothing here decides for itself whether money is owed — see
   * `justPaid` for why the local half exists at all.
   */
  const owes = !!order?.due && order.id !== justPaid;

  /**
   * What the card form calls when the charge clears, as ONE function that
   * keeps its identity between renders.
   *
   * Keyed on the order id rather than on the order object, and that is the
   * whole reason this is a `useCallback` and not the arrow it reads like: the
   * poll hands `setThread` a brand new object every fifteen seconds, so the
   * order object is never the same twice, while the id inside it does not move
   * for the life of the booking. PayForm re-opens the charge and re-mounts the
   * processor's fields whenever this changes — so an arrow written at the call
   * site would throw away a half-typed card number every fifteen seconds, on
   * the one screen where somebody is trying to type a card number.
   */
  const orderId = order?.id ?? null;
  const onBookingPaid = useCallback(() => {
    // Local first, then both reads. The local half is what stops the form
    // reappearing underneath somebody who has just used it: the Worker's `due`
    // does not go false until the processor's webhook lands, which is a second
    // or two behind this. See `justPaid`.
    if (orderId) setJustPaid(orderId);
    refreshBooking();
  }, [orderId, refreshBooking]);

  /*
    Where this booking's money is, in the business's own locale.

    The locale is passed through rather than left to default so that the two
    amounts on this one card — the price the Worker formatted, and the refund
    this formats — are punctuated the same way. A card reading "$240.00" above
    "240,00 $ went back to your card" looks like two different sums.

    SUPPRESSED ENTIRELY WHILE MONEY IS OWED, and that is not a display
    preference. bookingMoney reads the ACCOUNT row, whose order is still
    'pending' for a booking nobody has paid for, and 'pending' there is written
    up as "£240 is going through on your card now… usually a few seconds" —
    a sentence about a charge that is genuinely in flight. For somebody who
    closed the tab before ever reaching the card form there is no charge in
    flight and there never was, so that line would sit directly above a panel
    asking them to pay, telling them the payment was already happening. The
    Worker has just answered the same question with `due`, from the order
    itself, and it is the better-informed of the two — so it wins, and the card
    says the plain thing instead.
  */
  const money = paid && !owes ? bookingMoney(paid, thread?.locale) : null;

  useDocumentTitle(erased
    ? 'Your data has been deleted'
    : thread
      ? `${booking ? 'Your booking with' : 'Your messages with'} ${business}`
      : 'Your conversation');

  return (
    <div className="land">
      {/*
        WHY THIS PAGE GETS LESS CHROME THAN A MARKETING PAGE.
        Nothing is being sold here — the money is already committed — so the
        checkout's argument about not inviting somebody out mid-purchase does
        not apply. A different one does. This is a private page reached by a
        secret link, and everything on it belongs to one booking: the
        confirmation, the start code, the van on its way, the parts quote
        waiting for an answer, and a conversation with a named person. Wrapping
        that in a search box and a four-column directory of every trade in the
        city changes what the page is — from somebody's record of a job into a
        marketplace page with their booking printed on it — and it puts a
        general-purpose search field on the one screen where every question the
        reader has is about this job and is answered by the composer at the
        bottom.

        So: the shared header with its search switched off, and no site footer.
        No breadcrumb either, and that one is not a matter of taste — Crumbs
        publishes a BreadcrumbList, and a private page that nothing links to
        has no place in a site hierarchy and no business describing itself to a
        crawler.

        The three nav pills — Alert me, Sign in, List your van — are off too.
        They are the part that turns a private booking record back into a
        marketplace page, and `nav={false}` drops them in the shared component
        rather than by forking a second header into this file.
      */}
      <SiteHeader search={false} nav={false} />

      <main className="wrap" id="main" tabIndex={-1}>
        {/*
          The page after the erasure, and the reason it exists.

          The thread this page reads is one of the rows that has just been
          deleted, so every other branch below is now a lie: the loader would
          spin, the fetch would 404, and the reader would be handed "we could
          not find a conversation at this link" — the wording for a mistyped
          link — one second after deliberately deleting it. This is the state
          that says what happened instead, and it comes first because nothing
          else on this page has anything left to render.
        */}
        {erased && (
          <div className="stack" style={{ marginTop: 60, maxWidth: 560 }}>
            <h1 style={{ margin: 0 }}>Your data has been deleted.</h1>
            {/* "Removed from your bookings", not "gone from this site": when a
                sanction is in force the number survives on the standing row,
                and the box below is the only honest place to say so. A first
                sentence that overclaimed would make that box read as a
                correction. */}
            <p style={{ margin: 0 }}>
              Your messages and the photographs from your jobs are deleted, and
              your name, phone number, email address and address have been
              taken off every booking and every request you made here. Nothing
              was kept in case you change your mind.
            </p>
            <p style={{ margin: 0 }}>
              What is left of your bookings is what was paid for them — an
              amount, a currency, a date and which business it was with — with
              nothing on it that names you. Any review you left keeps its
              rating and its words under “A customer”.
            </p>
            {/*
              The single exception the Worker makes, and the only part of this
              result a person has to be told about. Said in the words of the
              reason for it: without this, "delete my data" would also be the
              button that lifts a booking pause.
            */}
            {erased.standing_retained && (
              <div className="notice">
                <strong>One thing was kept.</strong> There is a pause or a block
                on bookings from your phone number in force right now. The
                record holding it stays, with the reports behind it, because
                deleting it would lift the pause — asking to be forgotten is not
                also how a pause is cleared. That record is your phone number
                and the reports the pause was based on.
              </div>
            )}
            <p style={{ margin: 0 }}>
              This link no longer opens anything, so there is no reason to keep
              it. If you book again, you will be sent a new one.
            </p>
            <div>
              <Link className="btn sm" to="/">See what is open near you</Link>
            </div>
          </div>
        )}

        {!erased && loading && <Spinner label="Opening your conversation" />}

        {!erased && !loading && lockedOut && (
          <div className="blank" style={{ marginTop: 60 }}>
            {/* The Worker's own sentence, which carries how long is left. */}
            <p style={{ margin: '0 0 14px' }}>{lockedOut}</p>
            <p style={{ margin: '0 0 14px' }}>
              This page has stopped checking for new messages so that opening it
              again does not start the wait over. Nothing is wrong with your
              conversation and nothing has been lost — come back to this page
              when the time is up and it will open normally.
            </p>
            <Link className="btn sm" to="/">See what is open near you</Link>
          </div>
        )}

        {/*
          NOT FOUND, AND THE ADVICE IS OPPOSITE ON THE TWO DOORS — which is one
          of only two places on this page that cares which one it is.

          On a link, the usual cause is a link: half of one was copied, or the
          business closed the conversation, and the thing to do is open the
          full one again from wherever it was saved.

          On the account door there is no link involved at all, so every word
          of that is misleading. The overwhelmingly likely cause is that the
          session has expired or this is a different browser — the id in the
          address is fine, it is the cookie that is missing — and the thing to
          do is sign in again. Telling that reader to "open your full link
          again from wherever you saved it" sends somebody hunting through
          their email for a link they do not need and will not find, which is
          precisely the dead end this whole change exists to remove.
        */}
        {!erased && !loading && !lockedOut && missing && (
          <div className="blank" style={{ marginTop: 60 }}>
            {door === 'account' ? (
              <>
                <p style={{ margin: '0 0 14px' }}>
                  We could not open this conversation. That usually means you
                  are signed out on this device, or it belongs to a different
                  account — conversations are only shown to the account that
                  booked them.
                </p>
                <p style={{ margin: '0 0 14px' }}>
                  Sign in with the email address you booked on and your
                  conversations are listed there. You do not need a link for
                  this.
                </p>
                <Link className="btn sm" to="/account">Go to your account</Link>
              </>
            ) : (
              <>
                <p style={{ margin: '0 0 14px' }}>
                  We could not find a conversation at this link. Links usually
                  stop working because only part of one was copied, or because
                  the business closed the conversation.
                </p>
                <p style={{ margin: '0 0 14px' }}>
                  If you still have the full link somewhere, open it again from
                  there. Otherwise sign in at{' '}
                  <Link to="/account">your account</Link> with the email
                  address you booked on — every conversation on that account is
                  listed there, and reaching one that way needs no link at all.
                </p>
                <Link className="btn sm" to="/">See what is open near you</Link>
              </>
            )}
          </div>
        )}

        {!erased && !loading && !lockedOut && !missing && error && (
          <div style={{ marginTop: 60 }}><ErrorNote error={error} onRetry={load} /></div>
        )}

        {!erased && !loading && !lockedOut && !missing && thread && (
          <>
            <section className="guest-head">
              <span className="eyebrow">
                {booking ? 'Your booking' : 'Your question'}
              </span>
              <h1>{business}</h1>
              {thread.profile_slug && (
                <Link className="tlink" to={`/p/${thread.profile_slug}`}
                  style={{ alignSelf: 'flex-start', paddingLeft: 0 }}>
                  See their page and their work
                </Link>
              )}
            </section>

            <div className="guest-body">
              {/* Handles its own "nothing to show yet" states, so it needs no
                  guard here — a booking with no tracking still renders a
                  sentence rather than a hole in the page. */}
              {booking && threadRef && <VanTrack threadRef={threadRef} />}

              {booking && (
                <div className="card confirm">
                  <div className="spread">
                    {/* "Booked" was printed here whatever had happened since,
                        including on a booking the business had cancelled and
                        refunded a week ago — the guest payload carries no
                        status, so the chip was a constant wearing the colour of
                        a fact. It says what the money says when the money is
                        known, and falls back to the old constant when it is
                        not.

                        "BOOKED" IS THE WORST OF THOSE FALLBACKS ON AN UNPAID
                        BOOKING, and it was the one every signed-out customer
                        who abandoned the checkout saw: the word they were
                        waiting for, in the confident colour, over a booking
                        nobody had been charged for and nothing was going to
                        happen to. The Worker now answers that question for
                        every reader, account or no account, so the chip can
                        say it. */}
                    <span className={`chip ${chipTone(money?.tone ?? (owes ? 'unpaid' : undefined))}`}>
                      {money?.label ?? (owes ? 'Not paid yet' : 'Booked')}
                    </span>
                    <span className="price">{booking.price}</span>
                  </div>
                  <div className="name" style={{ marginTop: 10 }}>{booking.service_name}</div>
                  <dl className="pairs" style={{ marginTop: 12 }}>
                    <dt>When</dt>
                    <dd>
                      {bookingWhen(booking.starts_at, booking.ends_at,
                        thread.timezone, thread.locale)}
                    </dd>
                    <dt>Where</dt>
                    <dd>
                      {booking.address_line
                        ?? 'No address on the booking. Ask below where to go.'}
                    </dd>
                    <dt>Price</dt>
                    <dd>{booking.price}</dd>
                  </dl>

                  {/* WHERE THE MONEY IS, on the page the customer actually
                      opens. The paragraph below it describes how paying works
                      in general; this one is about this booking and this
                      person's card, and it is the only thing on the page that
                      can tell "you are owed £240" apart from "your £240 went
                      back on the 12th". It is drawn only when the reader's own
                      account has this booking on it — see `paid` above — so a
                      signed-out reader gets the page exactly as it was. */}
                  {money && (
                    <p className={`guest-money guest-money-${money.tone}`}>
                      <strong>{money.label}.</strong> {money.says}
                      {money.parts && <> {money.parts}</>}
                    </p>
                  )}

                  {/* This used to read "nothing to settle at the door", full
                      stop. That is true of the appointment and it was never
                      true of parts: a mechanic who finds you need an
                      alternator has to charge for the alternator. The promise
                      that IS keepable — and the one worth making — is that
                      nothing is added without the customer approving it first,
                      which is what the quote card above does.

                      It then spent months opening "Nothing has been paid for
                      this booking", which was written when that was true and
                      was still here after the card form went live — so the one
                      person holding a receipt was told they had not paid. The
                      paragraph now says what happened to their money, because
                      they are the person most entitled to know it. See
                      PaymentState.tsx. */}
                  <p className="muted" style={{ marginBottom: 0 }}>
                    {paid?.cancelled_at ? (
                      /* The cancellation ladder is advice about a decision
                         this reader has already made, and reciting it under a
                         refund makes somebody go back and check whether they
                         were given the right share. What is still worth saying
                         is that this is over: nobody is coming, and no further
                         money moves on it either way. */
                      <>
                        This booking is cancelled, so nobody is coming for it
                        and nothing more is charged on it. Message {business}
                        below if you want another time — that would be a new
                        booking, paid for when you make it.
                      </>
                    ) : owes ? (
                      /* THE SENTENCE THAT WAS FLATLY UNTRUE FOR THE PEOPLE THIS
                         WHOLE CHANGE IS FOR. "Paid through this site, by card,
                         when you booked" was printed under every booking on
                         this page, including the ones nobody had ever been
                         charged for, because the payload had no way of saying
                         otherwise. Somebody who left the checkout at the card
                         step read it, believed they had paid, and waited for a
                         van that was never coming — and the next thing they
                         heard about it was a business asking where they were.

                         What it says instead is short on purpose: the panel
                         below it is the thing to do, and a paragraph reciting
                         the cancellation ladder above an unpaid booking is
                         answering a question nobody has got to yet. */
                      <>
                        Nothing has been paid for this booking yet. The time is
                        held in {business}'s calendar and paying is what
                        confirms it with them — the card form is just below.
                        Nothing has been taken from your card so far, and the
                        price above is the price: nothing is added to it here.
                      </>
                    ) : order && !order.paid ? (
                      /* Not paid, and not something to ask for money for
                         either: the order or its line has been cancelled or
                         failed somewhere along the way. This reader may be
                         signed out, in which case the money paragraph above is
                         not drawn and this is the only thing on the page that
                         can say so. It does not guess at WHY — the Worker sent
                         a state, not a reason — but "nothing was charged" is
                         certainly true and is the fact somebody watching their
                         bank account actually wants. */
                      <>
                        Nothing was charged for this booking and there is
                        nothing to pay here. If you were expecting it to go
                        ahead, message {business} below and they can sort it
                        out or send you a new time.
                      </>
                    ) : (
                      <>
                        Paid through this site, by card, when you booked.
                        Round The Way holds that payment until the job is done
                        and then pays {business}, and nothing is ever added to
                        it without you approving it here first. If you cancel,
                        how much comes back depends on how close it is: all of
                        it more than 48 hours out, three quarters inside 48
                        hours, a quarter inside 12. Message them below if
                        something has changed; moving it is usually fine.
                      </>
                    )}
                    {thread.timezone
                      ? ` The time above is local to ${business}.`
                      : " The time above is in your device's timezone."}
                  </p>
                </div>
              )}

              {/*
                THE CARD FORM FOR A BOOKING NOBODY HAS PAID FOR, AND THE END OF
                THE LAST DEAD END ON THIS SITE.

                The checkout holds the appointments and writes the order BEFORE
                it asks for a card — on purpose, so somebody interrupted at the
                card step has not lost the slot — and Book.tsx's pay step tells
                them so in as many words: "your booking is held under your
                conversation and you can pay from there." For every customer who
                closed that tab, and there are always some, this page could not
                keep that promise. It drew the booking, the start code, the van
                and the conversation, said "Paid through this site, by card,
                when you booked" underneath, and offered no way whatever to
                finish paying. The order sat 'pending' for ever: an hour held in
                a business's calendar, a customer who believed they had bought
                something, and no money moved. Nothing in the product resolved
                it — no email, no reminder, no sweep — because the link is the
                whole of a guest's authority and this page is the link.

                It could not be built here before because the payload carried
                `order_item_id` and not the order id, and a charge is opened
                against an ORDER. guestView sends `booking.order` now.

                THE PANEL IS PayPanel AND THERE IS NO SECOND CARD FLOW. The same
                component the checkout uses and the same one the quote card
                below uses: the processor's own fields embedded on this page,
                the intent created allow_redirects=never and confirmed
                redirect:'if_required'. Nobody is ever sent to a payment site.

                NO PROBE AND NO "CHECKING" STATE, unlike the quote card, and the
                difference is worth naming. That card has to ask the pay route
                whether an accepted order is settled, because the estimates
                payload says nothing about money. This one does not: the Worker
                answered it on the thread read this page was already doing, so
                the panel is either there on the first paint or it is not. A
                page about money is allowed to say "checking"; it is better not
                to have to.

                ALREADY PAID IS HANDLED TWICE OVER, which is the right number
                for money. `due` is false the moment the order has a paid_at, so
                this is not drawn at all for a settled booking; and if the
                webhook lands in the seconds between this page loading and the
                form opening, PayForm's own startPayment comes back `paid: true`
                and it goes straight to `onPaid` without charging anything. Two
                independent answers, and no path where a card is taken twice.
              */}
              {owes && order && (
                <PayPanel
                  className="card"
                  orderId={order.id}
                  total={order.total}
                  title="Finish paying for this booking"
                  lead={<>
                    Your appointment with {business} is held and has not been
                    paid for. Paying is what confirms it with them — nothing has
                    been taken from your card so far.
                  </>}
                  /* THE HONEST ANSWER FOR THIS PAGE, which is not the
                     checkout's. Book.tsx can point somebody at their
                     conversation link; this IS that page, so there is nowhere
                     further to send them and it has to say plainly how to get
                     back to it.

                     WHICH IS A DIFFERENT SENTENCE ON EACH DOOR, and this is the
                     one screen where getting it wrong costs money rather than
                     patience. "Bookmark this link or you cannot come back to
                     the card form" was printed to everybody, including the
                     reader who arrived here from their own account and for whom
                     it is simply false — and the cost of a false one here is
                     somebody deciding they had better pay now rather than risk
                     losing a booking they were not ready to pay for. On the
                     account door the way back is the account; on a link it is
                     the link, and for a guest with no account it is genuinely
                     the only copy, because only a fingerprint of it is stored. */
                  comeBack={door === 'account' ? <>
                    Nothing is lost if you close this page. The booking stays
                    held, and this conversation is listed under your account —
                    open it again from there whenever you are ready and the card
                    form will still be waiting. If your card was refused, the
                    booking is still yours: try again above, or message
                    {' '}{business} below.
                  </> : <>
                    Nothing is lost if you close this page. The booking stays
                    held and this same link brings you back to exactly here,
                    with the card form still waiting — so bookmark it if you are
                    not paying now{thread.on_account
                      ? ', or sign in at your account, where this conversation '
                        + 'is listed without needing the link'
                      : ''}. If your card was refused, the booking is
                    still yours: try again above, or message {business} below.
                  </>}
                  /* The stable one, never a fresh arrow — see onBookingPaid
                     for what a fresh one costs somebody mid-card. */
                  onPaid={onBookingPaid}
                />
              )}

              {/* The gap between the card clearing and the Worker hearing about
                  it. Seconds, normally — but they are seconds in which this
                  page would otherwise have nothing at all to say to somebody
                  who has just handed over money, and silence there is what
                  makes a person pay a second time. It says what is true and
                  what is already safe: the charge is in, the confirmation is on
                  its way, and closing the page does not undo either, because
                  what confirms the booking is the processor telling the Worker
                  rather than anything this browser does. */}
              {order && order.id === justPaid && !order.paid && (
                <div className="notice">
                  <strong>Your card was accepted.</strong> We are waiting for
                  your bank to confirm it, which usually takes a few seconds —
                  this page will show the booking as paid as soon as it does.
                  You can close this page; the payment is not waiting on it, and
                  this link brings you back.
                </div>
              )}

              {/*
                THE PRICE QUOTES, AND THE ONE UNFINISHED PIECE OF MONEY ON THIS
                SITE.

                DIRECTLY UNDER THE BOOKING CARD AND ABOVE EVERYTHING ELSE, on
                the same reasoning the refund question below is given. Two of
                the states this card draws are money standing still: a price
                waiting to be answered, and — far worse — a booking the customer
                accepted that nobody has been charged for.

                THAT SECOND STATE WAS ONCE EVERY ACCEPTANCE ON THE SITE, which
                is why it is the loudest thing on this page. Accepting a quote
                recorded the acceptance and did nothing else: no appointment, no
                order, no charge. The operator was told somebody had said yes to
                $240 of work and had no job to do it against, and the customer
                had agreed to a price and was never asked for money. The Worker
                now writes the booking, and this card is the half that carries
                them from there to paid — and, for anybody who closed the tab in
                between, the only way back to the card form. The link is all a
                guest is ever sent; there is no email and no account behind it.

                `onChanged` reloads BOTH reads, and not as a precaution.
                Accepting writes an appointment and points this thread at it, so
                the confirmation card above appears for the first time on that
                tap; paying moves the money the same card prints. Reloading only
                the conversation would leave somebody who has just booked and
                paid looking at a page that still shows neither.

                `handledAbove` IS WHAT STOPS THIS PAGE ASKING FOR ONE DEBT
                TWICE. Accepting a quote points the thread at the appointment it
                just booked, so for very nearly every accepted quote the booking
                card above and the estimate below are the SAME order — and once
                this page grew a card form of its own, that meant two panels
                offering to take a card for one charge. Two forms for one debt
                is worse than none: whichever a person used, the other would sit
                there afterwards still saying they owed money, and on a page
                about money the natural response to that is to pay again.

                THE CARD ABOVE WINS, and not arbitrarily. Its answer comes from
                the Worker on the read this page was already doing, so it is
                right on the first paint; the estimate card has to go and ask
                the pay route, which costs a request against a rate limit and a
                "checking where the payment stands" state in between. Telling it
                which order is already spoken for saves it both, and it keeps
                everything else — a second quote accepted on the same
                conversation, or one whose booking the thread never came to
                point at. Those are the orders nothing else on this page can
                reach, and it is still the only way to them.
              */}
              {threadRef && (
                <Estimates threadRef={threadRef} business={business}
                  timezone={thread.timezone} locale={thread.locale}
                  handledAbove={order?.id ?? null}
                  onChanged={refreshBooking} />
              )}

              {/* The refund question comes first when there is one: the
                  customer's money is sitting still until they answer it.

                  Both reads are redone on the answer, because answering is what
                  releases the refund and issues it in the same request — so the
                  box above this one goes from "on hold" to "£240 went back to
                  your card" on that tap. Reloading only the conversation would
                  leave somebody who just freed their own money looking at a
                  screen still saying it was frozen. */}
              {threadRef && (
                <WorkQuestion threadRef={threadRef}
                  onAnswered={() => { void load(); void loadPaid(); }} />
              )}

              {/* The code and the van to look for. Renders only while there is
                  a live booking. */}
              {threadRef && <StartCode threadRef={threadRef} />}

              {/* Only renders when a quote actually exists, so it is invisible
                  for the overwhelming majority of bookings that never involve
                  a part. */}
              {threadRef && <PartsQuotes threadRef={threadRef} />}

              {threadRef && booking?.order_item_id && (
                <JobProof threadRef={threadRef} orderItemId={booking.order_item_id} />
              )}

              {!booking && thread.gap_id && (
                <div className="card">
                  <span className="chip neutral">Question about an opening</span>
                  <div className="name" style={{ marginTop: 10 }}>
                    {thread.subject ?? 'An open appointment with this business'}
                  </div>
                  <p className="muted">
                    Nothing is booked yet. Asking here does not hold the time,
                    so book it when you are ready.
                  </p>
                  <a className="btn sm" href={`/book/${thread.gap_id}`}>Book this opening</a>
                </div>
              )}

              {/*
                "KEEP THIS LINK… IT IS THE ONLY WAY TO THIS CONVERSATION."

                That sentence sat here for months and it was true when it was
                written. It stopped being true at migration 0037, when booking
                started creating an account, and it went on being printed —
                unconditionally, to everybody — until 0052 gave a conversation
                a way onto that account. What it cost was not a wrong word. It
                was people taking it at face value: somebody who had lost the
                confirmation believed they had lost the messages, the
                photographs of their own kitchen, the start code and the card
                form for a booking nobody had charged them for, because the
                page had told them plainly that there was nothing else. There
                WAS something else for most of them, and nothing on this screen
                said so.

                It cannot be replaced with "you do not need this link" either,
                because for a guest with no account that is the same lie the
                other way round and the consequence is worse — they close the
                tab and the conversation is genuinely unreachable.

                So there are three states and each one says only what is true
                of the reader in it:

                  ACCOUNT DOOR. They are reading this because they signed in,
                  so the proof is already in front of them. No link needed, and
                  the link still works for anybody who has one.

                  LINK DOOR, CONVERSATION ON AN ACCOUNT. Keep it because it is
                  convenient — it needs no sign-in, which is the whole point of
                  it — but losing it is no longer losing the conversation.

                  LINK DOOR, NO ACCOUNT BEHIND IT. The original sentence,
                  unchanged, because for this reader it is still exactly right:
                  a guest booking or an anonymous enquiry has nothing else, and
                  this is the one case where "the only way" is a fact.

                `on_account` is the Worker's answer, not a guess made here —
                see guestView in src/index.ts. Absent is read as false, which
                errs towards telling somebody to keep their link.
              */}
              <div className="notice keeper">
                {door === 'account' ? (
                  <>
                    <strong>There is no link to keep.</strong> You opened this
                    from your account, and that is how to get back to it: sign
                    in with your email address and every conversation you have
                    had here is listed under{' '}
                    <Link to="/account">your account</Link>, on any device.
                    {booking && ' The link in your confirmation still opens '
                      + 'this too, and that one needs no sign-in at all — '
                      + 'which is what makes it the useful one on a phone you '
                      + 'have never signed in on.'}
                  </>
                ) : thread.on_account ? (
                  <>
                    <strong>Keep this link — but it is not the only way
                    back.</strong> It opens this conversation
                    {booking ? ' and your booking' : ''} on any phone, signed
                    in or not, so it is worth bookmarking. If you lose it,
                    sign in at <Link to="/account">your account</Link> with the
                    email address you booked on: this conversation is listed
                    there, {booking ? 'along with what happened to the money' : 'with every other one you have had here'}.
                    Nobody can send you this link again — only a fingerprint of
                    it is kept, which is what stops anybody else opening your
                    conversation — and the account is the way in that does not
                    depend on it.
                  </>
                ) : (
                  <>
                    <strong>Keep this link. It is the only way back to this
                    conversation.</strong> It opens
                    {booking ? ' it and your booking' : ' it'} on any phone,
                    signed in or not. Bookmark it now, or save the address
                    somewhere you will find it: there is no account behind this
                    conversation, so there is nothing else that can reach it,
                    and it cannot be sent to you again — only a fingerprint of
                    it is kept, which is what stops anybody else opening it.{' '}
                    {/* Said as the general rule rather than as a promise about
                        THIS conversation. An account is claimed by proving the
                        email address a booking was made on, and the bookings
                        that reach this branch are largely the old ones with no
                        address on them at all — so "sign in and it will appear"
                        is a sentence that would be false for exactly the people
                        reading it. */}
                    An account is what makes a conversation findable without a
                    link: it is an email address and six digits at the moment
                    you book, and everything booked on it is then listed at{' '}
                    <Link to="/account">your account</Link>.
                  </>
                )}
              </div>

              {thread.status === 'closed' && (
                <div className="notice">
                  {business} has closed this conversation. You can still read it,
                  but new messages will not go through.
                </div>
              )}

              {sendError && <div className="error">{sendError}</div>}

              <Chat messages={messages} mySide="guest" onSend={send}
                sending={sending} otherName={business}
                onSendPhoto={sendPhoto} photoSrc={photoSrc} />

              {/* Last on the page, under the conversation it deletes. This is
                  the only place a customer can ask to be erased — there is no
                  account and no support address — so it has to be here, and it
                  has to be somewhere a thumb reading a booking does not land
                  on. */}
              {threadRef && (
                <DeleteMyData threadRef={threadRef} hasBooking={!!booking}
                  onErased={setErased} />
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

/**
 * Which colour the chip at the top of the booking card wears.
 *
 * Warm only for the two states that are waiting on the reader to do something:
 * a payment still going through, and money frozen until somebody answers
 * whether the work happened. A refund on its way is good news and a refund that
 * has landed is better news, so neither of those is coloured like a problem —
 * an orange chip over "your money went back on the 12th" reads as a warning
 * about the refund rather than as the refund.
 *
 * Grey for a cancellation with nothing owed, because there is nothing to
 * celebrate and nothing to act on.
 */
function chipTone(tone: MoneyTone | undefined): string {
  if (tone === 'held' || tone === 'unpaid') return 'warn';
  if (tone === 'nothing') return 'neutral';
  return 'good';
}

/*
 * `bookingWhen` used to live here. It moved to lib/format.ts the moment the
 * estimate card above this booking needed the same answer: a quote and the
 * confirmation it becomes are the same appointment described either side of
 * one tap, and two copies of the formatter — one of which would inevitably
 * fall back to the device clock — is how a customer ends up with two different
 * hours for one job and no way to tell which one anybody is coming at.
 */
