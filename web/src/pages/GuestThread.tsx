import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, type ChatMessage, type ErasureResult, type Thread } from '../api';
import Chat from '../components/Chat';
import DeleteMyData from '../components/DeleteMyData';
import PartsQuotes from '../components/PartsQuotes';
import StartCode from '../components/StartCode';
import WorkQuestion from '../components/WorkQuestion';
import JobProof from '../components/JobProof';
import VanTrack from '../components/VanTrack';
import SiteHeader from '../components/SiteHeader';
import { ErrorNote, Spinner } from '../components/ui';
import { useDocumentTitle } from '../lib/title';


/** Long enough not to hammer the Worker, short enough that a reply feels live. */
const POLL_MS = 15_000;

/**
 * The customer's side of the conversation, at /c/:token.
 *
 * There is no account here and there never will be: the token in the address
 * bar is the whole identity. That makes this page the customer's entire
 * relationship with the business — the confirmation of what they booked, the
 * way back to it, and the only channel to ask a question. It has to say all
 * three plainly, because nobody is going to be sent an email or a text to
 * make up for it.
 */
export default function GuestThread() {
  const { token } = useParams<{ token: string }>();
  const [thread, setThread] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
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

  const load = useCallback(async () => {
    if (!token) { setMissing(true); setLoading(false); return; }
    setLoading(true); setError(null); setMissing(false);
    try {
      const res = await api.guestThread(token);
      setThread(res.thread);
      setMessages(res.messages);
    } catch (e) {
      // A link that has been mistyped or closed is an ordinary outcome, not a
      // fault, and gets its own wording rather than an error box.
      if (e instanceof ApiError && e.status === 404) setMissing(true);
      else setError(e instanceof Error ? e.message : 'Could not open this conversation.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  // A quiet re-read for the poll. It must never blank the page or raise an
  // error: a dropped request while the phone changes cell is not news.
  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const res = await api.guestThread(token);
      setThread(res.thread);
      // A poll that was already in flight when a message was sent comes back
      // without it. Keeping anything the response does not mention stops a
      // sent message vanishing off the screen for fifteen seconds.
      setMessages((prev) => {
        const fetched = new Set(res.messages.map((m) => m.id));
        const missed = prev.filter((m) => !fetched.has(m.id));
        return missed.length ? [...res.messages, ...missed] : res.messages;
      });
    } catch { /* the next poll tries again */ }
  }, [token]);

  // Poll only while the tab is being looked at. A phone left on a table with
  // this page open would otherwise keep asking the Worker for messages all
  // day, and the customer would still read them the moment they came back.
  useEffect(() => {
    if (!token || missing || erased) return;
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
  }, [token, missing, erased, refresh]);

  const send = useCallback(async (body: string) => {
    if (!token) return;
    setSending(true); setSendError(null);
    try {
      const { message } = await api.guestSend(token, body);
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
  }, [token]);

  const business = thread?.business_name ?? 'the business';
  const booking = thread?.booking ?? null;
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
        publishes a BreadcrumbList, and a token-only page that nothing links to
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

        {!erased && !loading && missing && (
          <div className="blank" style={{ marginTop: 60 }}>
            <p style={{ margin: '0 0 14px' }}>
              We could not find a conversation at this link. Links usually stop
              working because only part of one was copied, or because the
              business closed the conversation.
            </p>
            <p style={{ margin: '0 0 14px' }}>
              If you still have the full link somewhere, open it again from
              there. Otherwise the business can send you a new one.
            </p>
            <Link className="btn sm" to="/">See what is open near you</Link>
          </div>
        )}

        {!erased && !loading && !missing && error && (
          <div style={{ marginTop: 60 }}><ErrorNote error={error} onRetry={load} /></div>
        )}

        {!erased && !loading && !missing && thread && (
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
              {booking && token && <VanTrack token={token} />}

              {booking && (
                <div className="card confirm">
                  <div className="spread">
                    <span className="chip good">Booked</span>
                    <span className="price">{booking.price}</span>
                  </div>
                  <div className="name" style={{ marginTop: 10 }}>{booking.service_name}</div>
                  <dl className="pairs" style={{ marginTop: 12 }}>
                    <dt>When</dt>
                    <dd>{bookingWhen(booking.starts_at, booking.ends_at)}</dd>
                    <dt>Where</dt>
                    <dd>
                      {booking.address_line
                        ?? 'No address on the booking. Ask below where to go.'}
                    </dd>
                    <dt>Price</dt>
                    <dd>{booking.price}</dd>
                  </dl>
                  {/* This used to read "nothing to settle at the door", full
                      stop. That is true of the appointment and it was never
                      true of parts: a mechanic who finds you need an
                      alternator has to charge for the alternator. The promise
                      that IS keepable — and the one worth making — is that
                      nothing is added without the customer approving it first,
                      which is what the quote card above does.

                      It also used to open "Paid through this site", which was
                      the strongest single claim on the page and the one that
                      was not true: this booking was never paid for, because
                      nothing on Slotfill takes money yet. The customer holding
                      this link is the person most entitled to know that, so it
                      is the first thing the paragraph says. See
                      PaymentState.tsx. */}
                  <p className="muted" style={{ marginBottom: 0 }}>
                    Nothing has been paid for this booking. Paying on the site
                    is not built yet, so the price above is what you and the
                    business settle between you — and nothing is ever added to
                    it without you approving it here first. Once payment is
                    switched on, how much comes back if you cancel will depend
                    on how close it is: all of it more than 48 hours out, three
                    quarters from 12 to 48, a quarter inside 12, and you will
                    see the amount before you confirm. Message them below if
                    something has changed; moving it is usually fine.
                    Times are shown in your device's timezone.
                  </p>
                </div>
              )}

              {/* The refund question comes first when there is one: the
                  customer's money is sitting still until they answer it. */}
              {token && <WorkQuestion token={token} onAnswered={() => void load()} />}

              {/* The code and the van to look for. Renders only while there is
                  a live booking. */}
              {token && <StartCode token={token} />}

              {/* Only renders when a quote actually exists, so it is invisible
                  for the overwhelming majority of bookings that never involve
                  a part. */}
              {token && <PartsQuotes token={token} />}

              {token && booking?.order_item_id && (
                <JobProof token={token} orderItemId={booking.order_item_id} />
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
                  <a className="btn sm" href={`/book/${thread.gap_id}`}>Book this slot</a>
                </div>
              )}

              <div className="notice keeper">
                <strong>Keep this link.</strong> It is how you get back to this
                conversation{booking ? ' and to your booking' : ''}. There is no
                account and no password, so this page is the only way in.
                Bookmark it now, or save the address somewhere you will find it.
              </div>

              {thread.status === 'closed' && (
                <div className="notice">
                  {business} has closed this conversation. You can still read it,
                  but new messages will not go through.
                </div>
              )}

              {sendError && <div className="error">{sendError}</div>}

              <Chat messages={messages} mySide="guest" onSend={send}
                sending={sending} otherName={business} />

              {/* Last on the page, under the conversation it deletes. This is
                  the only place a customer can ask to be erased — there is no
                  account and no support address — so it has to be here, and it
                  has to be somewhere a thumb reading a booking does not land
                  on. */}
              {token && (
                <DeleteMyData token={token} hasBooking={!!booking}
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
 * When the job is.
 *
 * Rendered in the reader's own timezone. The guest payload carries no
 * timezone and there is no operator record to borrow one from, so the only
 * alternative is UTC — and a confirmation that says 07:00 for an 08:00 job is
 * worse than one that says nothing. The customer and the van are in the same
 * place, so the device clock is the right one far more often than not.
 */
function bookingWhen(startSeconds: number, endSeconds: number): string {
  const day = new Intl.DateTimeFormat(undefined, {
    weekday: 'long', day: 'numeric', month: 'long',
  }).format(new Date(startSeconds * 1000));
  const at = (s: number) => new Intl.DateTimeFormat(undefined, {
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(s * 1000));
  return `${day}, ${at(startSeconds)} to ${at(endSeconds)}`;
}
