import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import type { ChatMessage } from '../api';
import { Empty, Icon } from './ui';


/** The server rejects anything longer, so the composer has to stop first. */
const MAX_CHARS = 2000;

/** Below this nobody is near the limit and a counter is only noise. */
const COUNTER_FROM = 1800;

/** Roughly six lines. Past that the log has no room left to read. */
const MAX_BOX_PX = 168;

/**
 * The conversation, as both sides see it.
 *
 * One component for the customer and the business on purpose: a message has
 * to look the same to the person who sent it and the person who reads it, or
 * neither can be sure what the other was shown.
 *
 * Times are rendered in the reader's own timezone. A signed-out customer has
 * no operator record to borrow one from, so the alternative here is UTC, and
 * a reply stamped an hour off is worse than no stamp at all.
 */
export default function Chat({ messages, mySide, onSend, sending, otherName }: {
  messages: ChatMessage[];
  mySide: 'guest' | 'operator';
  /**
   * Rejects when the send failed. The draft is kept on a rejection.
   *
   * Resolves with a notice when the message was changed on the way in -- a
   * phone number or a link taken out. Shown to the sender and nobody else.
   */
  onSend: (body: string) => Promise<string | null | void>;
  sending: boolean;
  otherName: string;
}) {
  const [draft, setDraft] = useState('');
  /**
   * "We took a phone number out of that." Shown to the sender only.
   *
   * A message that silently arrives with a hole in it reads as a bug, and the
   * person's next move is to try again another way -- or to ask for a number,
   * which is the exact outcome the filter exists to prevent. Telling them what
   * happened, and why, is what turns a mangled message into a rule they
   * understand.
   */
  const [notice, setNotice] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  // Whether the reader is already at the newest message. Kept in a ref, not
  // state: it changes on every scroll frame and must not re-render the log.
  const atBottom = useRef(true);

  const trimmed = draft.trim();
  const over = draft.length > MAX_CHARS;

  // Grow the box to fit what has been typed. Without this a long message is
  // composed through a two-line window and cannot be re-read before it goes.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_BOX_PX)}px`;
  }, [draft]);

  // Open on the newest message, and follow new arrivals only when the reader
  // is already at the bottom. Yanking someone away from the older message
  // they are part-way through is worse than making them scroll down once.
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const last = messages[messages.length - 1];
    if (atBottom.current || last?.sender === mySide) el.scrollTop = el.scrollHeight;
  }, [messages, mySide]);

  async function send() {
    if (!trimmed || sending || over) return;
    try {
      const said = await onSend(trimmed);
      setNotice(typeof said === 'string' ? said : null);
      // Cleared only on success. A failed send must not eat what was typed —
      // on a phone, in a hurry, that message does not get written twice.
      setDraft('');
    } catch {
      // The page owns the error message; here the only job is to keep the text.
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // isComposing guards input methods that use Enter to accept a candidate
    // word: without it a Japanese or Chinese sentence sends itself half typed.
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void send();
  }

  return (
    <div className="chat">
      <div className="chat-log" ref={logRef} onScroll={() => {
        const el = logRef.current;
        if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}>
        {messages.length === 0 ? (
          <Empty>
            No messages yet. Anything you write here goes to {otherName} and
            nowhere else.
          </Empty>
        ) : (
          <ul className="chat-msgs" aria-live="polite"
            aria-label={`Conversation with ${otherName}`}>
            {messages.map((m) => (
              <li key={m.id} className={`chat-msg${m.sender === mySide ? ' mine' : ''}`}>
                <div className="bubble">{m.body}</div>
                <time className="chat-at" dateTime={new Date(m.created_at * 1000).toISOString()}>
                  {stamp(m.created_at)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Sits above the box the person just typed into, so it is read as an
          answer to what they did rather than as a banner about the page. */}
      {notice && (
        <div className="notice" role="status" style={{ margin: '0 0 10px' }}>
          {notice}
          <button className="btn ghost sm" type="button" style={{ marginLeft: 8 }}
            onClick={() => setNotice(null)}>
            Got it
          </button>
        </div>
      )}

      <form className={`composer${sending ? ' sending' : ''}`} onSubmit={onSubmit}
        aria-busy={sending}>
        <div className="composer-row">
          <textarea ref={boxRef} rows={1} value={draft}
            onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown}
            placeholder={`Message ${otherName}`}
            aria-label={`Message ${otherName}`} aria-describedby="composer-hint" />
          <button type="submit" className="btn send" aria-label="Send message"
            disabled={sending || !trimmed || over}>
            <Icon name="send" size={19} />
          </button>
        </div>

        {draft.length >= COUNTER_FROM && (
          <div className={`composer-count${over ? ' over' : ''}`} aria-live="polite">
            {over
              ? `${draft.length - MAX_CHARS} characters too long`
              : `${draft.length} of ${MAX_CHARS}`}
          </div>
        )}

        <p className="composer-hint" id="composer-hint">
          {sending ? 'Sending…' : 'Enter sends. Shift and Enter starts a new line.'}
        </p>
      </form>
    </div>
  );
}

/**
 * When a message arrived.
 *
 * Today's messages get a clock, older ones the date as well. A thread read
 * days later otherwise shows a column of times with no day attached to them.
 */
function stamp(seconds: number): string {
  const at = new Date(seconds * 1000);
  const sameDay = at.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(undefined, sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' },
  ).format(at);
}
