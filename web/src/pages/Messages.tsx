import { useCallback, useEffect, useRef, useState } from 'react';
import { api, clockTime, shortDate, type ChatMessage, type Thread } from '../api';
import { useOperator } from '../App';
import Chat from '../components/Chat';
import { Empty, ErrorNote, Icon, Spinner } from '../components/ui';
import { useDocumentTitle } from '../lib/title';


/**
 * The operator's inbox, at /app/messages.
 *
 * Customers here have no account and no phone number the operator can see —
 * "no number exchange, no sms" was the requirement — so this screen is the
 * only place a question from a stranger can be answered. Missing one means
 * losing the job, which is why unread has to be visible at arm's length.
 */

/**
 * How often the inbox re-reads itself while it is being looked at.
 *
 * The same fifteen seconds the customer's side of the conversation uses in
 * GuestThread, and for the same reason: the two people are often typing at each
 * other in real time. This screen used to load once and never again, so an
 * operator with the inbox open watched a customer's question not arrive — the
 * one screen in the product where that costs the job.
 */
const POLL_MS = 15_000;
export default function Messages() {
  useDocumentTitle('Messages');
  const op = useOperator();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.threads();
      setThreads(res.threads);
      setUnread(res.unread);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your messages.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /**
   * A quiet re-read for the poll: it must never blank the list, move the row
   * under a thumb, or raise an error box. A dropped request in a van is not
   * news, and the next one is fifteen seconds away.
   *
   * The open thread's own unread count is forced back to zero because this
   * operator is looking at it — the Worker's copy may not have caught up with
   * the mark-read yet, and a dot reappearing on the row you are reading is
   * worse than no dot at all.
   */
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;

  const refreshList = useCallback(async () => {
    try {
      const res = await api.threads();
      const here = selectedRef.current;
      const rows = here
        ? res.threads.map((t) => (t.id === here ? { ...t, operator_unread: 0 } : t))
        : res.threads;
      setThreads(rows);
      // Counted from the rows this render is drawing, not taken from
      // res.unread, because the open thread has just been zeroed above and the
      // Worker's number does not know that yet.
      setUnread(rows.filter((t) => t.operator_unread > 0).length);
    } catch { /* the next poll tries again */ }
  }, []);

  const refreshOpen = useCallback(async () => {
    const id = selectedRef.current;
    if (!id) return;
    try {
      const res = await api.thread(id);
      // Checked again on the way back: a poll that started before the operator
      // tapped a different row would otherwise drop one customer's transcript
      // into the other customer's conversation.
      if (selectedRef.current !== id) return;
      setDetail(res.thread);
      // Anything this response does not mention is kept: a poll already in
      // flight when the operator pressed send comes back without their own
      // message, and it must not disappear off the screen for fifteen seconds.
      setMessages((prev) => {
        const fetched = new Set(res.messages.map((m) => m.id));
        const missed = prev.filter((m) => !fetched.has(m.id));
        return missed.length ? [...res.messages, ...missed] : res.messages;
      });
      if (res.thread.operator_unread > 0) await api.markThreadRead(id).catch(() => {});
    } catch { /* the next poll tries again */ }
  }, []);

  // Only while the tab is being looked at. This page sits open on a phone on a
  // dashboard for hours, and a timer that keeps running there is a request
  // every fifteen seconds for nobody.
  useEffect(() => {
    let timer: number | undefined;
    const stop = () => {
      if (timer !== undefined) { window.clearInterval(timer); timer = undefined; }
    };
    const tick = () => { void refreshList(); void refreshOpen(); };
    const start = () => { stop(); timer = window.setInterval(tick, POLL_MS); };
    const onVisibility = () => {
      // Coming back, what is on screen may be an hour old, so read at once
      // rather than waiting out the rest of an interval.
      if (document.visibilityState === 'visible') { tick(); start(); } else stop();
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [refreshList, refreshOpen]);

  const open = useCallback(async (id: string) => {
    setSelected(id); setDetail(null); setMessages([]);
    setThreadError(null); setLoadingThread(true);
    try {
      const res = await api.thread(id);
      setDetail(res.thread);
      setMessages(res.messages);

      if (res.thread.operator_unread > 0) {
        // Cleared here rather than by reloading the list: the row must not
        // move or restyle under the finger that just tapped it.
        setThreads((rows) => rows.map(
          (r) => (r.id === id ? { ...r, operator_unread: 0 } : r)));
        // One, not the thread's unread message count. `unread` is how many
        // CONVERSATIONS have something in them — unreadThreadCount in
        // src/lib/chat.ts counts rows, not messages — so subtracting three
        // messages took the header from "2 unread" to "Up to date" while
        // another customer was still waiting.
        setUnread((n) => Math.max(0, n - 1));
        // A failed mark-read is not worth an error box — the thread is open on
        // screen and is being read. The next load will show the dot again.
        await api.markThreadRead(id).catch(() => {});
      }
    } catch (e) {
      setThreadError(e instanceof Error ? e.message : 'Could not open that conversation.');
    } finally {
      setLoadingThread(false);
    }
  }, []);

  const send = useCallback(async (body: string) => {
    if (!selected) return;
    setSending(true); setThreadError(null);
    try {
      const { message } = await api.threadSend(selected, body);
      setMessages((rows) => [...rows, message]);
      setThreads((rows) => rows.map(
        (r) => (r.id === selected ? { ...r, last_message_at: message.created_at } : r)));
      // Handed back so the composer can tell the sender what was taken out.
      // Never stored and never shown to the customer.
      return message.notice ?? null;
    } catch (e) {
      setThreadError(e instanceof Error ? e.message : 'That did not send. Try again.');
      throw e;  // rethrown so the composer keeps the typed text
    } finally {
      setSending(false);
    }
  }, [selected]);

  // Newest conversation first: the one somebody is waiting on is the one that
  // has to be at the top of the list.
  const ordered = [...threads].sort((a, b) => b.last_message_at - a.last_message_at);
  const current = detail ?? threads.find((t) => t.id === selected) ?? null;

  return (
    <>
      <header className="page-head">
        {/* Conversations, not messages — see the note in open() below. A bare
            "3 unread" over a list of conversations is read as three messages,
            which is a different and usually smaller number. */}
        <span className="eyebrow">
          {unread === 0 ? 'Up to date'
            : unread === 1 ? '1 unread conversation'
              : `${unread} unread conversations`}
        </span>
        <h1>Messages</h1>
      </header>

      <main className="main stack-lg">
        {error && <ErrorNote error={error} onRetry={load} />}
        {loading && <Spinner label="Loading your messages" />}

        {!loading && !error && threads.length === 0 && (
          <Empty>
            No conversations yet. This fills up when a customer asks about one
            of your openings or books one. They have no account and no number
            for you, so they reply here.
          </Empty>
        )}

        {!loading && !error && threads.length > 0 && (
          <div className={`msgs${selected ? ' open' : ''}`}>
            <div className="msgs-list">
              {ordered.map((t) => (
                <button key={t.id} type="button"
                  className={`thread-row${t.operator_unread > 0 ? ' unread' : ''}`
                    + (t.id === selected ? ' on' : '')}
                  aria-current={t.id === selected ? 'true' : undefined}
                  onClick={() => { void open(t.id); }}>
                  <div className="thread-top">
                    <span className="thread-name">
                      {t.operator_unread > 0 && (
                        <i className="thread-dot" aria-label="Unread" role="img" />
                      )}
                      {t.guest_name}
                    </span>
                    <span className="thread-at">{stamp(t.last_message_at, op)}</span>
                  </div>
                  <span className="thread-about">{about(t)}</span>
                </button>
              ))}
            </div>

            <div className="msgs-pane">
              {!current && (
                <Empty>Pick a conversation to read it.</Empty>
              )}

              {current && (
                <>
                  <div className="msgs-pane-head">
                    <button type="button" className="msgs-back"
                      onClick={() => { setSelected(null); setDetail(null); setMessages([]); }}>
                      <Icon name="back" size={18} color="var(--muted)" />
                      All messages
                    </button>
                    <div className="grow">
                      <div className="name">{current.guest_name}</div>
                      <div className="muted">{about(current)}</div>
                    </div>
                  </div>

                  {current.status === 'closed' && (
                    <div className="notice">
                      This conversation is closed. New messages will not go through.
                    </div>
                  )}

                  {threadError && <div className="error">{threadError}</div>}
                  {loadingThread && <Spinner label="Loading the conversation" />}

                  {!loadingThread && (
                    <Chat messages={messages} mySide="operator" onSend={send}
                      sending={sending} otherName={current.guest_name} />
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </main>
    </>
  );
}

/**
 * What a conversation is about, in the list.
 *
 * A name and a time alone are not enough to choose between two rows: "is this
 * the person who booked Tuesday, or someone asking a price" decides which one
 * gets answered first.
 */
function about(t: Thread): string {
  if (t.subject) return t.subject;
  if (t.appointment_id) return 'About a booking';
  if (t.gap_id) return 'Asking about an opening';
  return 'General question';
}

/**
 * When the last message landed.
 *
 * Today's threads get a clock and older ones a date, both in the operator's
 * own timezone — the same comparison the rest of the app uses, so a thread
 * cannot read as "today" here and yesterday on the schedule.
 */
function stamp(seconds: number, op: ReturnType<typeof useOperator>): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return shortDate(seconds, op) === shortDate(nowSeconds, op)
    ? clockTime(seconds, op)
    : shortDate(seconds, op);
}
