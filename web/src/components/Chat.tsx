import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { ApiError, type ChatMessage, type MessagePhoto } from '../api';
import { UnusableImage, shrinkImage } from '../lib/image';
import { Empty, Icon } from './ui';


/** The server rejects anything longer, so the composer has to stop first. */
const MAX_CHARS = 2000;

/** Below this nobody is near the limit and a counter is only noise. */
const COUNTER_FROM = 1800;

/** Roughly six lines. Past that the log has no room left to read. */
const MAX_BOX_PX = 168;

/**
 * The most one conversation photograph may weigh.
 *
 * MAX_MESSAGE_PHOTO_BYTES in src/lib/chat.ts, written out again because the two
 * trees cannot import each other, and pinned against it by
 * test/two-trees.test.ts. A looser number here only moves the refusal to after
 * the upload, which on a van's signal is a minute of somebody's life spent
 * learning something this browser already knew.
 */
const MAX_PHOTO_BYTES = 2_000_000;

/**
 * Room left for everything in the request that is not the photograph itself.
 *
 * THE CONTRACT SAYS "2 MB" AND THE WORKER MEASURES SOMETHING SLIGHTLY LARGER.
 * assertBodyWithin in src/lib/images.ts refuses on the request's declared
 * content-length before the body is read at all, and a multipart request is the
 * file PLUS the caption, the field names, the filename and the boundary lines
 * around each of them. A file of exactly 2,000,000 bytes therefore produces a
 * request of rather more than 2,000,000 and is refused for being too big —
 * with, from the sender's point of view, a photo that was exactly on the limit.
 *
 * A caption can be 2000 characters, which is up to 8000 bytes once it is UTF-8,
 * and the framing is a few hundred more. Twelve kilobytes covers the worst case
 * with room to spare, and costs a photograph nothing: after the re-encode these
 * files are around 300 KB.
 */
const ENVELOPE_BYTES = 12_000;
const MAX_FILE_BYTES = MAX_PHOTO_BYTES - ENVELOPE_BYTES;

/**
 * How tall a picture whose size nobody measured is assumed to be, in pixels,
 * while it loads. See `photoBox` below for why this number exists at all.
 */
const UNSIZED_PLACEHOLDER_PX = 120;

/** What the composer is busy doing, when it is busy. */
type PhotoStage = 'preparing' | 'sending';

/** A photo chosen but not yet sent, with the preview URL that has to be freed. */
interface Attachment {
  file: File;
  width: number;
  height: number;
  /** An object URL. Revoked the moment this attachment stops being the one. */
  preview: string;
}

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
 *
 * PHOTOGRAPHS GO THROUGH THE SAME COMPOSER AS WORDS, on both sides, for the
 * same reason the component is shared at all. The owner's description of what
 * this is for is "proof that a job was done, sent in the messages" — so the
 * picture is not a decoration hung off a message, it IS a message, and a
 * separate upload panel beside the chat would have made it look like an
 * attachment to something rather than the thing itself. One box, one send
 * button, and a caption that is optional because a photograph of the finished
 * work often has nothing to add to it.
 */
export default function Chat({
  messages, mySide, onSend, sending, otherName, onSendPhoto, photoSrc,
}: {
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
  /**
   * Posts a photograph, with the caption already in the form.
   *
   * The form is built here — `file`, `body`, `width`, `height` — because this
   * is where the caption and the shrunk file are. WHICH DOOR IT GOES THROUGH is
   * the page's business and not this component's: the operator's route is
   * authorised by a session and keyed on a thread id, the customer's by the
   * secret in their link, and neither of those two things exists in here.
   *
   * Rejects on failure, exactly as `onSend` does, and for the same reason: the
   * attachment and the typed caption are both kept so the person can try again
   * without re-choosing the photo.
   *
   * Optional. A conversation rendered without it simply has no attach control,
   * which is the correct behaviour for any caller that cannot post one.
   */
  onSendPhoto?: (
    form: FormData, onProgress: (fraction: number) => void,
  ) => Promise<string | null | void>;
  /**
   * Where to fetch one photograph from, for the side that is looking.
   *
   * Passed in rather than worked out here for the same reason as above — the
   * operator's URL needs nothing but the photo id, the customer's needs their
   * token — and both are authorised on every read, so neither is a link that
   * means anything to anybody else.
   *
   * REQUIRED, WHERE `onSendPhoto` IS NOT, and the asymmetry is deliberate.
   * Whether this caller can POST a photograph depends on it having a door to
   * post through; whether a photograph already in the transcript can be READ
   * does not depend on anything, and every thread payload can carry one. Made
   * optional, a caller that forgot it would render a photo-only message — a
   * complete message, with an empty body — as absolutely nothing on the screen,
   * which is the one failure this whole conversation exists to prevent.
   */
  photoSrc: (photoId: string) => string;
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
  const fileRef = useRef<HTMLInputElement>(null);

  const [attached, setAttached] = useState<Attachment | null>(null);
  const [stage, setStage] = useState<PhotoStage | null>(null);
  /** 0 to 1 while the bytes are going out. Null before there is anything to say. */
  const [progress, setProgress] = useState<number | null>(null);
  /**
   * Kept apart from the page's own error line on purpose. A photo that was too
   * big is a fact about the file sitting in the composer, so it belongs beside
   * the file — above the page-level box that says the last SEND failed, which
   * is a different sentence about a different thing.
   */
  const [photoError, setPhotoError] = useState<string | null>(null);

  // Whether the reader is already at the newest message. Kept in a ref, not
  // state: it changes on every scroll frame and must not re-render the log.
  const atBottom = useRef(true);

  const trimmed = draft.trim();
  const over = draft.length > MAX_CHARS;
  const busy = stage !== null;
  const canAttach = !!onSendPhoto;

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

  /**
   * Every object URL this composer makes has to be handed back.
   *
   * A preview is a live reference to the whole file, so an operator who picks
   * six photos in a row and sends none of them has pinned however many
   * megabytes in this tab until it is closed.
   *
   * THE REF IS NOT DECORATION AND THE EMPTY DEPENDENCY LIST IS NOT A MISTAKE.
   * The obvious version of this — depend on `attached`, revoke it in the
   * cleanup — is broken under StrictMode, which main.tsx turns on: React mounts
   * a component, immediately unmounts it and mounts it again, running every
   * cleanup in between. That cleanup would revoke the URL of the attachment
   * that is still sitting in the composer, and the preview would render as a
   * broken image in development only, which is the worst place for a bug to
   * live. Revoking on real unmount only, and revoking the OLD url wherever the
   * attachment is replaced, is the version that survives it.
   */
  const attachedRef = useRef<Attachment | null>(null);
  attachedRef.current = attached;
  useEffect(() => () => {
    if (attachedRef.current) URL.revokeObjectURL(attachedRef.current.preview);
  }, []);

  /** Replaces the attachment, freeing whatever the last one was holding. */
  function replaceAttachment(next: Attachment | null) {
    const old = attachedRef.current;
    if (old && old.preview !== next?.preview) URL.revokeObjectURL(old.preview);
    attachedRef.current = next;
    setAttached(next);
  }

  function clearAttachment() {
    replaceAttachment(null);
    setPhotoError(null);
    setProgress(null);
  }

  /**
   * Takes what the picker handed over and gets it ready to send.
   *
   * The shrink is the load-bearing step and it is not an optimisation. An
   * iPhone photographs in HEIC by default and the Worker refuses HEIC outright
   * — deliberately, because half the browsers on the other side of the
   * conversation would draw it as a broken-image icon — so without the canvas
   * re-encode in lib/image.ts every iPhone user in the product would get
   * `bad_type` and no idea why. It also turns a 9 MB camera original into
   * roughly 300 KB, which is the difference between an upload that finishes on
   * a driveway and one that does not.
   */
  async function pick(file: File) {
    setPhotoError(null);
    setStage('preparing');
    try {
      const shrunk = await shrinkImage(file, { maxBytes: MAX_FILE_BYTES });
      if (shrunk.file.size > MAX_FILE_BYTES) {
        // Almost unreachable after a re-encode, and worth saying properly for
        // the rare picture that survives one — an enormous screenshot, or an
        // image the canvas could not improve on. A megabyte figure rather than
        // a limit, because "yours is 4.1 MB" is something a person can act on
        // and "the limit is 2 MB" leaves them guessing which of their photos
        // might be under it.
        setPhotoError(
          `That picture is still ${(shrunk.file.size / 1_000_000).toFixed(1)} MB after `
          + 'shrinking it, which is too big to send. A photo taken with the camera '
          + 'will go through.');
        return;
      }
      replaceAttachment({
        file: shrunk.file,
        width: shrunk.width,
        height: shrunk.height,
        preview: URL.createObjectURL(shrunk.file),
      });
    } catch (e) {
      setPhotoError(photoProblem(e));
    } finally {
      setStage(null);
    }
  }

  async function sendPhoto() {
    if (!attached || !onSendPhoto) return;
    setStage('sending');
    setProgress(0);
    setPhotoError(null);
    try {
      const form = new FormData();
      form.append('file', attached.file);
      // An ordinary message body, and allowed to be empty: the Worker says so
      // in as many words, because demanding a caption for a photograph would be
      // the app inventing a requirement the person does not have.
      form.append('body', trimmed);
      // Only sent when this browser actually measured them. A zero would be
      // stored as "nobody knows", which is true, but sending a made-up number
      // would have the far side reserve a box of the wrong shape and then jump.
      if (attached.width > 0 && attached.height > 0) {
        form.append('width', String(attached.width));
        form.append('height', String(attached.height));
      }

      const said = await onSendPhoto(form, setProgress);
      setNotice(typeof said === 'string' ? said : null);
      setDraft('');
      clearAttachment();
    } catch (e) {
      // Neither the caption nor the photo is thrown away. Re-choosing a picture
      // on a phone is four taps and a scroll through a camera roll, and the
      // person has already done it once.
      setPhotoError(photoProblem(e));
    } finally {
      setStage(null);
      setProgress(null);
    }
  }

  async function send() {
    if (busy || over) return;
    if (attached) { await sendPhoto(); return; }
    if (!trimmed || sending) return;
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

  // Empty is a complete message when a photograph is attached, and is not one
  // otherwise. The length cap still applies either way: a caption lands in the
  // same column a message does.
  const nothingToSend = !trimmed && !attached;

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
                {/*
                  OPENED IN A NEW TAB RATHER THAN IN A LIGHTBOX, and that is a
                  decision rather than a shortcut.

                  What somebody does with one of these full size is pinch into
                  it — to read a meter, a serial number, a part number off the
                  side of a boiler. A browser's own image view gives that for
                  free, on every phone, with the platform's own gestures and the
                  back button everyone already knows. A lightbox would mean
                  writing pinch-zoom, a focus trap, an Escape handler and a
                  scroll lock, and getting any one of them slightly wrong on a
                  phone is worse than not having built it.

                  rel="noreferrer" because the address of a private conversation
                  is not something to hand to anything downstream, and the
                  customer's form of these URLs carries their link token.
                */}
                {m.photo && (
                  <a
                    className={`chat-photo${sized(m.photo) ? ' sized' : ' unsized'}`}
                    href={photoSrc(m.photo.id)} target="_blank" rel="noreferrer"
                    style={photoBox(m.photo)}
                  >
                    <img src={photoSrc(m.photo.id)} alt={photoAlt(m, mySide, otherName)}
                      loading="lazy" />
                  </a>
                )}

                {/* Guarded, because a photograph on its own is a whole message
                    and its body is the empty string. Unguarded this drew an
                    empty coloured pill under every picture. */}
                {m.body && <div className="bubble">{withLinks(m.body)}</div>}

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

      <form className={`composer${sending || busy ? ' sending' : ''}`} onSubmit={onSubmit}
        aria-busy={sending || busy}>

        {/*
          The photo waiting to go, above the box its caption is typed into.

          Deliberately not a thumbnail tucked inside the text area. This is the
          message now — the words are the optional part — so it gets the room
          that says so, and the progress of its upload has somewhere to live
          where a thumb is already looking.
        */}
        {attached && (
          <div className="composer-photo">
            {/* alt="" on purpose: this is the picture the person in front of
                the screen just chose seconds ago, and it is described by the
                text beside it. A screen reader announcing a filename here would
                be noise, and there is nothing truthful to say about the content
                of a photograph nobody has described. */}
            <img src={attached.preview} alt="" />
            <div className="composer-photo-say">
              {/* The heading changes with the stage rather than staying
                  "ready to send" throughout. A line still claiming the photo is
                  waiting to go, above a bar showing it going, is the small
                  contradiction that makes somebody press the button again. */}
              <strong>{stage === 'sending' ? 'Sending your photo' : 'Photo ready to send'}</strong>
              <span className="faint">
                {stage === 'sending'
                  ? 'Keep this page open until it finishes.'
                  : 'Add a note if you want to, then send.'}
              </span>
              {stage === 'sending' && (
                <>
                  {/* Decorative. The sentence under it is what actually gets
                      announced, so the bar is not read out twice. */}
                  <div className="composer-progress" aria-hidden="true">
                    <span style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
                  </div>
                  {/*
                    Polite rather than assertive, and worded around the one lie
                    a progress bar always tells: the browser reports bytes handed
                    to the network, so it reaches 100% while the Worker is still
                    storing the picture and answering. Saying "almost there"
                    for that last stretch is true; leaving "100%" on the screen
                    for three more seconds is how a finished upload looks stuck.
                  */}
                  <span className="faint" aria-live="polite">
                    {progress !== null && progress < 1
                      ? `Sending… ${Math.round(progress * 100)}%`
                      : 'Almost there…'}
                  </span>
                </>
              )}
            </div>
            <button type="button" className="btn ghost sm" disabled={busy}
              onClick={clearAttachment}>
              Remove
            </button>
          </div>
        )}

        {photoError && <div className="error" style={{ margin: 0 }}>{photoError}</div>}

        <div className="composer-row">
          {canAttach && (
            <>
              {/*
                accept="image/*" and NO capture attribute, which is the opposite
                of what JobProof.tsx does and is right for a different reason.
                There, the operator is working through before/during/after on a
                job and the next thing they want is the camera, so one tap
                straight to it saves three. Here the photograph being sent is as
                often one already taken — the thing that broke, shot ten minutes
                ago; the finished work, photographed before the van was packed —
                and `capture` on iOS does not add the camera to the sheet, it
                REPLACES the sheet with the camera and removes the camera roll
                as an option entirely. Leaving it off gives both.
              */}
              <input ref={fileRef} type="file" accept="image/*" hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  // Cleared immediately so that picking the same file twice —
                  // after a failed send, which is exactly when somebody would —
                  // still fires a change event.
                  e.target.value = '';
                  if (f) void pick(f);
                }} />
              {/* The name changes when there is already one attached, because
                  pressing it then REPLACES that photo rather than adding a
                  second — only one goes with a message — and somebody who
                  cannot see the thumbnail beside it has no other way to know. */}
              <button type="button" className="btn quiet composer-attach"
                aria-label={attached ? 'Choose a different photo' : 'Attach a photo'}
                disabled={busy || sending}
                onClick={() => fileRef.current?.click()}>
                <Icon name="camera" size={19} color="var(--muted)" />
              </button>
            </>
          )}

          <textarea ref={boxRef} rows={1} value={draft}
            onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown}
            placeholder={attached ? 'Say something about it (optional)' : `Message ${otherName}`}
            aria-label={`Message ${otherName}`} aria-describedby="composer-hint" />
          <button type="submit" className="btn send" aria-label="Send message"
            disabled={sending || busy || nothingToSend || over}>
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
          {stage === 'preparing' ? 'Getting that photo ready…'
            : stage === 'sending' ? 'Sending your photo…'
              : sending ? 'Sending…'
                : canAttach
                  ? 'Enter sends. Shift and Enter starts a new line. The camera button attaches a photo.'
                  : 'Enter sends. Shift and Enter starts a new line.'}
        </p>
      </form>
    </div>
  );
}

/** Whether the sender's browser told us the shape of this picture. */
const sized = (photo: MessagePhoto): boolean => photo.width > 0 && photo.height > 0;

/**
 * Holds the space a picture is about to occupy, before it has loaded.
 *
 * A thread that reflows as each image arrives is a thread where the message
 * somebody is half-way through reading jumps off the screen, and on a phone
 * with several photos in view it does it several times. `aspect-ratio` takes
 * the two numbers as a ratio, so nothing here divides by anything — which
 * matters, because zero is a value both of them really take.
 *
 * ZERO IS A REAL STATE AND NOT AN ERROR. It means the sending browser never
 * measured the picture: an upload that did not come through this app, or one
 * where the canvas could not decode it. There is no honest box to reserve in
 * that case, so none is — the `unsized` class gives it a small minimum height
 * so the slot is not literally nothing while it loads, and the image then
 * settles at whatever height it turns out to be. That is one small reflow for
 * an unusual message, against a guessed aspect ratio that would be wrong for
 * every message and would reflow anyway when it was.
 */
function photoBox(photo: MessagePhoto): { aspectRatio?: string; minHeight?: number } {
  return sized(photo)
    ? { aspectRatio: `${photo.width} / ${photo.height}` }
    : { minHeight: UNSIZED_PLACEHOLDER_PX };
}

/**
 * What a screen reader says about a photograph in the thread.
 *
 * "Image" would be worse than nothing — it describes the HTML, not the
 * conversation. Nobody has captioned these pictures and nothing here can see
 * what is in one, so what is left that is TRUE is who sent it and when, which
 * is also what a reader needs in order to follow a conversation: "photo sent by
 * you, 09:12" and "photo sent by Ace Plumbing, 14 Sept, 08:58" are two
 * different messages, and a caption underneath one of them belongs to exactly
 * one of them.
 */
function photoAlt(
  m: ChatMessage, mySide: 'guest' | 'operator', otherName: string,
): string {
  return `Photo sent by ${m.sender === mySide ? 'you' : otherName}, ${stamp(m.created_at)}`;
}

/**
 * Why a photograph did not go, in words.
 *
 * The Worker writes its refusals as finished English — "that is a lot of photos
 * for one conversation today, carry on in words and you can send more tomorrow"
 * — so where it has bothered to say something, that sentence is what gets
 * shown. `code` is the test for whether it bothered: an ApiError with no code
 * on it is a 500 or a gateway, and its message is `Request failed (502)`, which
 * is the exact kind of string this function exists to keep off the screen.
 *
 * Two of the coded ones are overridden anyway, because the Worker's wording is
 * aimed at a caller that is not this app. "Try again from the app" is no help
 * to somebody who is in the app, and "that is not a photo we can store" does
 * not tell an iPhone owner what to do about it.
 */
function photoProblem(e: unknown): string {
  if (e instanceof UnusableImage) return e.message;

  if (e instanceof ApiError) {
    if (e.code === 'too_big') {
      return 'That photo is too big to send. A photo taken with the camera will go through.';
    }
    if (e.code === 'bad_type') {
      return 'That file is not a kind of picture we can send. A photo from your '
        + 'camera or camera roll will work.';
    }
    if (e.code === 'no_file') {
      return 'That photo did not make it out of this device. Pick it again.';
    }
    if (e.code) return e.message;
    if (e.status === 0) {
      return 'That photo did not send. Check your signal and try again — nothing '
        + 'was lost, it is still attached below.';
    }
    return 'That photo did not send. Try again in a moment.';
  }

  return 'That photo did not send. Try again in a moment.';
}

/**
 * The one kind of link a message body is allowed to carry, and the reason this
 * function exists at all.
 *
 * Bubbles are plain text and were right to be: a conversation between two
 * strangers is the last place to start interpreting what either of them typed.
 * What changed is that the site itself now writes into these threads. An offer
 * on a slot the business cannot fill arrives here — see lib/offers.ts in the
 * Worker — and it is useless without its link: the customer would have had to
 * select a URL out of a coloured pill on a phone and paste it into a browser,
 * which in practice means the offer is never answered and the hour goes empty.
 * The same is true of anything else the platform posts into a thread later.
 *
 * ONLY http(s), and that is the whole of the safety argument. React escapes
 * the text either way, so the risk in linkifying is not injected markup — it is
 * a `javascript:` or `data:` href built out of something a stranger typed. The
 * pattern cannot match either. Trailing punctuation is left out of the link so
 * that a URL at the end of a sentence does not swallow the full stop.
 *
 * The split keeps its capturing group, so the odd-numbered pieces are the
 * matches and the even ones are the text between them.
 */
const LINK_IN_TEXT = /(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])/g;

function withLinks(body: string) {
  return body.split(LINK_IN_TEXT).map((piece, i) => (i % 2 === 1
    ? (
      <a key={i} href={piece} rel="noreferrer"
        style={{ color: 'inherit', textDecoration: 'underline' }}>
        {piece}
      </a>
    )
    : piece));
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
