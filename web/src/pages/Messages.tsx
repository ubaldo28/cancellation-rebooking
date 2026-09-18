import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api, clockTime, messagePhotoUrl, shortDate, type ChatMessage, type Thread,
} from '../api';
import { useOperator } from '../App';
import Chat from '../components/Chat';
import { Empty, ErrorNote, Icon, Spinner } from '../components/ui';
import { useDocumentTitle } from '../lib/title';


/**
 * The operator's inbox, at /app/messages.
 *
 * A customer's phone number is never shown to the operator — "no number
 * exchange, no sms" was the requirement, and it is unchanged by customers
 * having accounts now — so this screen is the only place a question from a
 * stranger can be answered. Missing one means losing the job, which is why
 * unread has to be visible at arm's length.
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

/**
 * How long after the last keystroke the search actually runs.
 *
 * A request per character would be eight requests to type "sherman", seven of
 * them for a prefix nobody wanted, and each one carries a LIKE over the
 * message bodies of every conversation in range — the one query on this screen
 * that is not a plain index seek. A third of a second is past the gap between
 * keystrokes of somebody typing and short enough that the list feels like it
 * is answering rather than catching up.
 */
const SEARCH_DEBOUNCE_MS = 350;

/**
 * Which rows the list is showing, as one value rather than four booleans.
 *
 * The four states are exclusive by construction and a set of flags would allow
 * combinations that mean nothing — "unread and closed" is a conversation the
 * business finished with and never read, which is not a thing anybody is
 * looking for, and "booked and closed" is a job that is done. One value cannot
 * be in an impossible combination, and it is what the tab strip is drawn from.
 */
type Filter = 'all' | 'unread' | 'booked' | 'closed';

/** The filter, as the query the Worker understands. */
function filterQuery(f: Filter) {
  return {
    unreadOnly: f === 'unread',
    bookedOnly: f === 'booked',
    status: (f === 'closed' ? 'closed' : 'open') as 'open' | 'closed',
  };
}

export default function Messages() {
  useDocumentTitle('Messages');
  const op = useOperator();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Where the next page starts, and null for "there is no next page".
   *
   * Straight from the Worker and never taken apart here — see api.threads. It
   * is what replaced the silent lid on this list: the inbox used to stop at
   * fifty rows with nothing on the screen to say that it had, so a business
   * with three hundred conversations had a hundred of them unreachable from
   * the one screen where a customer's question can be answered.
   */
  const [cursor, setCursor] = useState<string | null>(null);
  const [paging, setPaging] = useState(false);

  const [filter, setFilter] = useState<Filter>('all');
  /**
   * Two states for one box: what is in it, and what the list was read with.
   *
   * They differ for a third of a second while somebody is typing, and keeping
   * them apart is what lets the input stay responsive without a request per
   * keystroke. `query` is also what the poll uses, so a refresh landing
   * mid-word cannot reorder the list under the reader's thumb.
   */
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');

  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.threads({ ...filterQuery(filter), q: query });
      setThreads(res.threads);
      setCursor(res.next_cursor);
      setUnread(res.unread);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your messages.');
    } finally {
      setLoading(false);
    }
  }, [filter, query]);

  useEffect(() => { void load(); }, [load]);

  /**
   * The next page, appended.
   *
   * KEYSET AND NOT A PAGE NUMBER, which matters on this screen more than most:
   * this list moves while it is being read, because a message arriving bumps
   * the conversation it arrived in to the top. With an offset, a conversation
   * jumping to the top while the operator was on page two would push a
   * different one across the boundary and that one would never be seen at all.
   * The cursor names the row this page ended on, so the next page starts where
   * the last one stopped whatever has moved in between.
   *
   * De-duplicated on id on the way in anyway. The two segments of the ordering
   * are read separately (see pageOfThreads in the Worker), and a conversation
   * that the operator read in another tab between two pages would otherwise be
   * capable of appearing in both — React would then warn about duplicate keys
   * and draw the row twice.
   */
  const more = useCallback(async () => {
    if (!cursor || paging) return;
    setPaging(true);
    try {
      const res = await api.threads({ ...filterQuery(filter), q: query, cursor });
      setThreads((rows) => {
        const have = new Set(rows.map((r) => r.id));
        return [...rows, ...res.threads.filter((r) => !have.has(r.id))];
      });
      setCursor(res.next_cursor);
      setUnread(res.unread);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load any more.');
    } finally {
      setPaging(false);
    }
  }, [cursor, paging, filter, query]);

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

  /**
   * How many rows are on screen, so the poll can re-read exactly those.
   *
   * A REF AND NOT THE STATE, because refreshList is handed to an interval that
   * is set up once: reading `threads.length` inside it would close over the
   * length at the moment the timer was created and go on asking for that many
   * rows for ever. Every "Load more" writes here as well as into the list.
   */
  const shownRef = useRef(0);
  shownRef.current = threads.length;

  const refreshList = useCallback(async () => {
    try {
      /*
        THE POLL RE-READS WHAT IS ON SCREEN, NOT THE FIRST PAGE.

        This is the one thing paging broke and it is not obvious. The poll used
        to re-read the whole list because the whole list was one response; now
        it is pages, and a poll that asked for the first page would have thrown
        away everything an operator had pressed "Load more" for — every fifteen
        seconds, silently, while they were reading it. So it asks for as many
        rows as are being drawn.

        Capped at the ceiling the Worker enforces anyway, so an operator who
        has paged further than that keeps the first hundred rather than getting
        an error. Paging on from there still works: the cursor comes back with
        this response.
      */
      const res = await api.threads({
        ...filterQuery(filter), q: query,
        limit: Math.min(100, Math.max(25, shownRef.current)),
      });
      const here = selectedRef.current;
      const rows = here
        ? res.threads.map((t) => (t.id === here ? { ...t, operator_unread: 0 } : t))
        : res.threads;
      setThreads(rows);
      setCursor(res.next_cursor);
      /*
        THE WORKER'S TOTAL, LESS THE ONE BEING READ.

        This used to count the rows on screen, which was right when every
        conversation was on screen and is wrong now. `unread` is how many of
        this business's conversations are waiting in total — across every page
        and regardless of the filter — so counting the visible rows would say
        "1 unread" to somebody on the booked-only tab with nine questions
        waiting on the other one.

        The open thread is still subtracted, because this operator is reading
        it and the Worker's count may not have caught up with the mark-read
        yet; a badge reappearing on the row you are looking at is worse than no
        badge. Subtracted only when the Worker still thinks it is unread, or
        the number would go one too low on every poll after the first.
      */
      const openStillUnread = here != null
        && res.threads.some((t) => t.id === here && t.operator_unread > 0);
      setUnread(Math.max(0, res.unread - (openStillUnread ? 1 : 0)));
    } catch { /* the next poll tries again */ }
  }, [filter, query]);

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

  /**
   * The same send, with a photograph on it.
   *
   * This is the operator's half of the feature the whole thing exists for: the
   * job is finished, the customer is not there, and the picture of the finished
   * work goes to them in the conversation rather than to a phone number neither
   * side has. It lands in the transcript as an ordinary message, because that
   * is what the Worker makes of it — the caption, if there is one, is an
   * ordinary message body in the ordinary column.
   *
   * `setSending` is deliberately NOT touched, and neither is `threadError`. The
   * composer runs the whole upload — it owns the progress this reports and the
   * photo sitting in it, so it owns the state and the refusal too. Raising the
   * page's error box as well would print the same sentence twice, once beside
   * the photo it is about and once above the conversation.
   */
  const sendPhoto = useCallback(async (
    form: FormData, onProgress: (fraction: number) => void,
  ) => {
    if (!selected) return;
    const { message } = await api.threadSendPhoto(selected, form, onProgress);
    setMessages((rows) => [...rows, message]);
    setThreads((rows) => rows.map(
      (r) => (r.id === selected ? { ...r, last_message_at: message.created_at } : r)));
    // A caption is redacted exactly as a typed message is, so the same notice
    // has to come back to the same sender.
    return message.notice ?? null;
  }, [selected]);

  /**
   * Finishes with a conversation, or picks it up again.
   *
   * THE BUTTON FOR A COLUMN NOTHING HAS EVER WRITTEN. threads.status has been
   * in the schema since the chat shipped and this page has drawn a "this
   * conversation is closed" notice for it all along — against a value no route
   * anywhere could set. So an inbox could only grow: the conversation about a
   * job finished in March sat between two live ones for ever, and the answer
   * to a busy season was to scroll past the rows already dealt with.
   *
   * THE ROW LEAVES THE LIST WHEN IT IS CLOSED, because the default filter is
   * open conversations, so it is taken out here rather than waiting for the
   * poll: a row that stays put after being archived reads as a button that did
   * nothing. The pane is cleared with it for the same reason. Reopening from
   * the Closed tab is the mirror image.
   *
   * The unread total is left alone. The Worker zeroes operator_unread when it
   * closes a conversation — see setThreadStatus, and the reason is that a
   * badge counting rows the default list hides is a badge nobody can clear —
   * and the next poll brings the corrected number back. Guessing at it here
   * would mean this page and the Worker each doing their own arithmetic on the
   * same figure.
   */
  const toggleClosed = useCallback(async (id: string, open: boolean) => {
    setClosing(true); setThreadError(null);
    try {
      await api.setThreadStatus(id, open);
      setThreads((rows) => rows.filter((r) => r.id !== id));
      setSelected(null); setDetail(null); setMessages([]);
    } catch (e) {
      setThreadError(e instanceof Error ? e.message
        : 'Could not change that conversation. Try again.');
    } finally {
      setClosing(false);
    }
  }, []);

  /*
    THE ROWS ARE DRAWN IN THE ORDER THEY ARRIVED IN, AND THE RE-SORT IS GONE.

    This page used to re-sort the list by last_message_at before drawing it,
    which was harmless when the ordering it was copying was the Worker's own.
    It is not any more: the Worker now puts the conversations waiting on this
    operator first and orders by recency only inside that group, so sorting by
    recency here would undo the one thing that stops an unanswered question
    sinking out of sight. The server decides the order; this file draws it.
  */
  const current = detail ?? threads.find((t) => t.id === selected) ?? null;
  const searching = query !== '';

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
        {/*
          THE FILTERS AND THE SEARCH, WHICH DID NOT EXIST.

          A name, a time and a subject line per row was the whole of this
          screen, so "the woman in Van Nuys who asked about the arches" was
          findable by scrolling and by nothing else. Two narrowings and a box:

          WAITING is the one that matters most and is why the tab is first
          after All — it is the same set the list already puts at the top, on
          its own, for a business working through a backlog.

          BOOKED separates two different obligations the list drew
          identically: somebody asking a price, and somebody who has paid and
          is expecting a van on Tuesday.

          CLOSED is the archive, and it is a tab rather than a checkbox
          because it is the only place closed conversations appear — the other
          three hide them, which is the entire point of being able to close
          one.

          The box searches the customer's name, what the conversation is
          about, and the text of the messages. That last one is the expensive
          part of this screen and runs only when somebody has typed — never on
          the fifteen-second poll.
        */}
        <div className="msgs-filters">
          {/* Its own class and NOT the shared `.seg` pill strip, which is
              display:none above 960px — it was written for the browse page,
              where a map/list toggle stops being needed once both fit. These
              tabs are needed at every width. */}
          <div className="msgs-tabs" role="group" aria-label="Which conversations">
            {([
              ['all', 'All'], ['unread', 'Waiting'],
              ['booked', 'Booked'], ['closed', 'Closed'],
            ] as const).map(([value, label]) => (
              <button key={value} type="button" className="msgs-tab"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}>
                {label}
                {value === 'unread' && unread > 0 ? ` (${unread})` : ''}
              </button>
            ))}
          </div>
          <label className="msgs-search">
            <span className="sr-only">Search your conversations</span>
            <input type="search" value={search} placeholder="Search name or message"
              onChange={(e) => setSearch(e.target.value)} />
          </label>
        </div>

        {error && <ErrorNote error={error} onRetry={load} />}
        {loading && <Spinner label="Loading your messages" />}

        {!loading && !error && threads.length === 0 && (
          <Empty>
            {/*
              A SEARCH THAT FOUND NOTHING IS A DIFFERENT SENTENCE FROM AN
              EMPTY INBOX, and on the three live tabs it has to name the one
              place the search did not look. The tab decides which statuses
              are in range — that is the whole point of being able to close a
              conversation — so a search on All genuinely does not see the
              archive, and an operator hunting for a conversation they
              finished with would otherwise conclude it had been deleted.
            */}
            {searching
              ? 'Nothing matches that here. It looks at the name, what the '
                + 'conversation is about and the messages themselves. '
                + (filter === 'closed'
                  ? 'Try a shorter word, or clear the box to see everything again.'
                  : 'If you have already closed that conversation, search again '
                    + 'on the Closed tab — closing one takes it off this list '
                    + 'without deleting anything.')
              : filter === 'unread'
                ? 'Nothing is waiting on you. Every customer who has written '
                  + 'to you has had an answer.'
                : filter === 'booked'
                  ? 'No conversations about a booking yet. One opens whenever '
                    + 'somebody books an opening of yours.'
                  : filter === 'closed'
                    ? 'Nothing closed. When you finish with a conversation, '
                      + 'closing it moves it here and takes it off the list '
                      + 'above without deleting anything.'
                    : 'No conversations yet. This fills up when a customer asks '
                      + 'about one of your openings or books one. They have no '
                      + 'number for you and you have none for them, so this is '
                      + 'where both of you reply.'}
          </Empty>
        )}

        {!loading && !error && threads.length > 0 && (
          <div className={`msgs${selected ? ' open' : ''}`}>
            <div className="msgs-list">
              {threads.map((t) => (
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

              {/*
                THE END OF THE LIST, SAID OUT LOUD ONE WAY OR THE OTHER.

                A list that simply stopped is what was wrong here: fifty rows,
                no more, and nothing on the screen to say that row fifty-one
                existed. So either there is a button or there is a sentence
                saying that was all of them — and never silence.
              */}
              {cursor ? (
                <button type="button" className="btn quiet sm msgs-more"
                  disabled={paging} onClick={() => { void more(); }}>
                  {paging ? 'Loading…' : 'Load more conversations'}
                </button>
              ) : (
                <p className="muted msgs-more">
                  That is all {threads.length === 1 ? 'of it' : `${threads.length} of them`}.
                </p>
              )}
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
                    {/*
                      CLOSE IS HERE AND NOT ON THE ROW, deliberately. The rows
                      are the thing an operator taps to read a conversation,
                      and a second control inside each one is a way to archive
                      somebody's question by mishitting it on a phone in a van.
                      It lives beside the name of the conversation that is
                      actually open, where the operator can see what they are
                      finishing with.
                    */}
                    <button type="button" className="btn quiet sm"
                      disabled={closing}
                      onClick={() => { void toggleClosed(current.id, current.status === 'closed'); }}>
                      {current.status === 'closed' ? 'Reopen' : 'Close'}
                    </button>
                  </div>

                  {current.status === 'closed' && (
                    <div className="notice">
                      This conversation is closed. New messages will not go through,
                      and it is not offered a cancelled hour. The customer can still
                      read it from their account, and it says there that you closed
                      it. Reopen it to carry on.
                    </div>
                  )}

                  {threadError && <div className="error">{threadError}</div>}
                  {loadingThread && <Spinner label="Loading the conversation" />}

                  {!loadingThread && (
                    /* `messagePhotoUrl` and not a nested one: the Worker serves
                       an operator's conversation photos from a flat
                       /api/message-photo/:id, matching GET /api/proof/:id,
                       because the row is fetched first and the caller is then
                       made to prove they are on that conversation. */
                    <Chat messages={messages} mySide="operator" onSend={send}
                      sending={sending} otherName={current.guest_name}
                      onSendPhoto={sendPhoto} photoSrc={messagePhotoUrl} />
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
