import { useCallback, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api } from '../api';
import Sheet from './Sheet';
import Turnstile, { type TurnstileHandle } from './Turnstile';
import { RedactionNotice } from './ui';
import '../styles-profile.css';

/**
 * "Message" and "Ask for a quote", on a business's profile.
 *
 * Until this existed the only way to reach a business here was to book an hour
 * they had already listed, so somebody who wanted something next Tuesday — or
 * who only wanted to ask whether the van fits down their alley — had nowhere to
 * ask. Both actions work with nothing scheduled, which is the whole point of
 * them.
 *
 * ONE COMPONENT FOR BOTH, and one dialog rendered at a time. The two differ in
 * three places — the heading, the label on the box, and how long that box may
 * be — and in nothing else: the same name, the same challenge, the same rule
 * about contact details, the same endpoint, the same landing page. Writing them
 * as two forms would have meant two of everything else as well, and the copy
 * would have drifted the first time either was touched.
 *
 * THE DRAFTS OUTLIVE THE DIALOG, which is why this is rendered unconditionally
 * by the page and decides for itself whether to put a sheet up. A stray tap on
 * the backdrop — which is how Sheet closes, and which is easy to do one-handed
 * — then costs nobody the paragraph they just typed, and reopening finds it
 * exactly as it was. Nothing is written to storage of any kind: it lives as
 * long as the page does and no longer.
 */

/**
 * The two length ceilings, mirrored from the Worker so the counter can warn
 * before a submission is refused rather than after.
 *
 * `cleanBody` in src/lib/chat.ts caps a message at 2000 characters and
 * `askForEstimate` in src/lib/estimates.ts caps a quote request at 600. They
 * are the authority — a submission over either is still refused server-side
 * with a sentence of its own, which is what these numbers being wrong one day
 * would look like.
 */
const MAX_MESSAGE = 2000;
const MAX_REQUEST = 600;

/** Long enough that a name is a name; the Worker cuts at the same point. */
const MAX_NAME = 80;

/** Within this many characters of the ceiling, the count is worth showing. */
const COUNTER_WITHIN = 200;

export type EnquiryKind = 'message' | 'quote';

/**
 * What the Worker can refuse with, as sentences somebody can act on.
 *
 * Only the codes this form can actually provoke. Anything else falls through to
 * the Worker's own message, which is written for a person in every case that
 * reaches here — including the plain volume limits, whose text carries the
 * number of seconds and so cannot be improved on from out here.
 */
const PROBLEM: Record<string, string> = {
  no_name: 'Add the first name this should come from, so they know who is writing.',
  no_request: 'Say what you would like done. They cannot price a blank.',
  empty_message: 'Write your message first.',
  message_too_long:
    `That message is longer than ${MAX_MESSAGE} characters. Shorten it, and `
    + 'you can send the rest once the conversation is open.',
  request_too_long:
    `That is longer than ${MAX_REQUEST} characters. Say what you want priced in `
    + 'short, and the detail can follow in the conversation.',
  // Nothing the sender did wrong and nothing they can correct, so all three say
  // the same thing: press it again. The widget has already reset itself by the
  // time this is read, and everything typed is still on screen.
  turnstile_missing: 'The check that you are a person did not come through. '
    + 'Nothing is lost — send it again, and reload the page if it happens twice.',
  turnstile_failed: 'That check did not pass. Nothing is lost — it has reset '
    + 'itself, so send it again.',
  turnstile_unavailable: 'The security check is not answering at the moment. '
    + 'Nothing is lost — wait a few seconds and send it again.',
};

/**
 * The fan-out ceiling, in words.
 *
 * The Worker counts how many DIFFERENT businesses one address has opened a
 * conversation with, refuses past a ceiling, and sends back a sentence that
 * already names the wait — a real number worked out from the oldest of those
 * conversations, which cannot be recomputed out here and must not be guessed
 * at. So its own words are kept, and the only thing added is the part a person
 * cannot infer from them: this counts businesses rather than messages, and the
 * thing being counted is a network address, which a household, an office or a
 * mobile network may well share.
 */
const reachRefusal = (fromWorker: string) =>
  `${fromWorker} This counts how many separate businesses have been written to `
  + 'from your internet connection, not how much has been written to any of '
  + 'them — so a connection you share with other people can reach it without '
  + 'you having sent much at all. Conversations you have already opened carry '
  + 'on as normal.';

export default function Enquiry({ slug, businessName, kind, onClose }: {
  /** The profile slug in the address bar. The only name for the business a
      profile page has: the operator id is internal and is never published. */
  slug: string;
  businessName: string;
  /** Which of the two is being asked for, or null for no dialog at all. */
  kind: EnquiryKind | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  // Two drafts, because switching between the two actions must not silently
  // paste an opening message into a box that is going to be priced.
  const [message, setMessage] = useState('');
  const [request, setRequest] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const widget = useRef<TurnstileHandle | null>(null);
  const captcha = useRef<string | null>(null);

  const ids = useId();
  const nameId = `${ids}-name`;
  const nameHintId = `${ids}-name-hint`;
  const bodyId = `${ids}-body`;
  const noticeId = `${ids}-notice`;
  const countId = `${ids}-count`;

  // The refusal from the last attempt is about a submission, not about the
  // page, so it is dropped when the dialog is closed rather than being left to
  // greet whoever opens it next.
  const close = useCallback(() => { setError(null); onClose(); }, [onClose]);

  const isQuote = kind === 'quote';
  const text = isQuote ? request : message;
  const setText = isQuote ? setRequest : setMessage;
  const limit = isQuote ? MAX_REQUEST : MAX_MESSAGE;
  const over = text.length > limit;

  const submit = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    if (!kind || busy) return;

    const who = name.trim();
    const said = (kind === 'quote' ? request : message).trim();
    if (!who) { setError(PROBLEM.no_name!); return; }
    if (!said) {
      setError(kind === 'quote' ? PROBLEM.no_request! : PROBLEM.empty_message!);
      return;
    }
    if (said.length > (kind === 'quote' ? MAX_REQUEST : MAX_MESSAGE)) {
      setError(kind === 'quote' ? PROBLEM.request_too_long! : PROBLEM.message_too_long!);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const res = await api.startProfileEnquiry(slug, {
        guest_name: who,
        kind,
        ...(kind === 'quote' ? { request: said } : { first_message: said }),
        ...(captcha.current ? { turnstile_token: captcha.current } : {}),
      });
      // The link this mints is the only copy that will ever exist — nothing is
      // emailed and there is no account to find it from later — so the page is
      // handed straight to it rather than reporting success and waiting to be
      // clicked.
      navigate(`/c/${res.token}`);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      const fromWorker = err instanceof Error
        ? err.message : 'That did not go through.';
      setError(code === 'too_many_businesses'
        ? reachRefusal(fromWorker)
        : (code && PROBLEM[code]) ?? fromWorker);
      // A Turnstile token is single-use and short-lived, so whatever the
      // refusal was, the one just spent is dead. Resetting on every failure is
      // what makes the second press work; the fields are React state and keep
      // everything typed.
      captcha.current = null;
      widget.current?.reset();
    } finally {
      setBusy(false);
    }
  }, [kind, busy, name, message, request, slug, navigate]);

  if (!kind) return null;

  return (
    <Sheet
      title={isQuote ? `Ask ${businessName} for a quote` : `Message ${businessName}`}
      onClose={close}>
      <form className="enq-form" onSubmit={submit} noValidate>
        <p className="enq-lead">
          {isQuote
            ? 'Describe the job and they can come back with a price and a '
              + 'time. Nothing is booked and no time is held by asking.'
            : 'Ask them anything about the work. Nothing is booked and no '
              + 'time is held by writing.'}
        </p>

        {/* "Your name" with "a first name is enough" under it was an
            invitation, and most people typed both names anyway -- which handed
            the business a surname it never needed. The field asks for the one
            thing it wants, and the Worker keeps only the first word of
            whatever arrives. See firstNameOnly. */}
        <label htmlFor={nameId}>
          First name
          <input id={nameId} value={name} maxLength={MAX_NAME}
            onChange={(e) => setName(e.target.value)}
            aria-describedby={nameHintId}
            autoComplete="given-name" enterKeyHint="next" />
        </label>
        <p className="field-note" id={nameHintId}>
          First name only. It is all they see this come from, and all they
          ever get — there is no surname, number or email address behind it.
        </p>

        <label htmlFor={bodyId}>
          {isQuote ? 'What would you like done?' : 'Your message'}
          <textarea id={bodyId} value={text} rows={5}
            onChange={(e) => setText(e.target.value)}
            aria-describedby={`${noticeId} ${countId}`}
            placeholder={isQuote
              ? 'What needs doing, and roughly where and when'
              : `Your question for ${businessName}`} />
        </label>
        {/*
          Always in the document, empty until there is something to say. A
          live region added to the page at the same moment it gets its text
          is often not announced at all, so the count over the limit —
          which is the one that matters — would be silent.
        */}
        <p className={`field-note${over ? ' bad' : ''}`} id={countId} role="status">
          {over
            ? `${text.length - limit} characters too long.`
            : text.length >= limit - COUNTER_WITHIN
              ? `${text.length} of ${limit} characters.`
              : ''}
        </p>

        <RedactionNotice id={noticeId} />

        {/* Last thing before the button, which is where it belongs: after
            everything typed, in front of the control that spends it.
            Renders nothing at all until a site key is configured. */}
        <Turnstile ref={widget} action="enquiry"
          onToken={(t) => { captcha.current = t; }} />

        {error && <div className="error">{error}</div>}

        <div className="enq-actions">
          <button type="button" className="btn quiet" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={busy || over}>
            {busy
              ? 'Sending…'
              : isQuote ? 'Ask for a quote' : 'Send message'}
          </button>
        </div>

        <p className="field-note">
          Sending this opens a private conversation page and takes you
          straight to it. There is no account and no password, so that page
          is the only way back — bookmark it when you land on it.
        </p>
      </form>
    </Sheet>
  );
}
