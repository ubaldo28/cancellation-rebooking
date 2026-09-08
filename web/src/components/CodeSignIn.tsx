import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiError, api, type BookingState } from '../api';
import '../styles-account.css';

/**
 * The whole of signing up: a mobile number, and the six digits texted to it.
 *
 * IT IS THE SHAPE A RIDER'S ACCOUNT HAS, deliberately, and the owner asked for
 * that shape by name. No password, no mailbox, no second screen and no
 * separate journey — which is why this is a component that sits inside
 * whatever is already on screen rather than a page somebody is sent to. At the
 * checkout it is the last thing before the button that books; on /account it
 * is the whole of the sign-in.
 *
 * IT DOES NOT VERIFY THE CODE, and that is the point of the split. Whoever
 * renders this decides what the digits are for: the checkout sends them with
 * the order, so the account is created and the appointment held in one
 * request and a customer who signs up never loses the slot to a second round
 * trip; /account sends them to the verify route. Both failures come back
 * through `codeError` and are drawn in the one place a person is looking.
 *
 * WHAT IT DOES OWN is asking for the code, because every real state of that
 * belongs to this box and to nothing else:
 *
 *   sent                three texts to a number in a quarter hour and ten a
 *                       day, so the button says when the next one can go.
 *   not configured      503 on a deployment with no SMS provider. THE STATE OF
 *                       EVERY DEPLOYMENT TODAY: no account can be created, so
 *                       nothing can be booked. It is said in the Worker's own
 *                       words, once, with no retry offered — a button that
 *                       cannot work is worse than no button.
 *   bad number          400, before a text is sent or an allowance is spent.
 *   too many texts      429, whose message carries the wait.
 *
 * THE CODE FIELD IS ONE INPUT AND NOT SIX. Six boxes is the pattern that reads
 * beautifully and is a trap: paste puts one character in the first box, a
 * screen reader announces six unlabelled fields, backspace has to be
 * reimplemented, and the browser's own one-time-code autofill has nowhere to
 * put six digits. One input with `autocomplete="one-time-code"` is what lets
 * iOS and Android offer the code off the notification, which is the whole
 * experience this flow is copied from.
 */

/**
 * How many digits the Worker mints. Its own CODE_DIGITS is the same number.
 *
 * Exported because the checkout's Book button turns on when there are this
 * many, and a second copy of the figure there would be a button that enables
 * itself one digit early the day either number moves.
 */
export const CODE_DIGITS = 6;

export interface CodeSignInProps {
  /** The number, in whatever form it was typed. The Worker normalises it. */
  phone: string;
  /**
   * Editing the number. Omitted where the number is not this box's to change —
   * at the checkout it was answered a step earlier and is shown there with its
   * own way back, so asking for it twice would make the sign-up feel like the
   * separate journey it is not.
   */
  onPhone?: (value: string) => void;
  code: string;
  onCode: (value: string) => void;
  /** Two letters, deciding how a national number is read. */
  country?: string;
  /**
   * This deployment's answer to "can anybody sign up at all". Null while it is
   * still being asked, which is not the same as yes: the button stays on and
   * the Worker has the last word, because refusing to try over a failed GET is
   * a worse outcome than a request that gets a clear refusal.
   */
  state: BookingState | null;
  /**
   * Whatever the CALLER's use of the code came back with — a wrong or expired
   * code from the checkout, or from the verify route. Drawn against the field
   * it is about and announced, and it takes focus back to that field, because
   * a message about a control the caret is nowhere near is a message nobody
   * acts on.
   */
  codeError?: string | null;
  /** A solved challenge to spend on the send, when the build has a widget. */
  turnstileToken?: () => string | null;
  /** Called once a token has been spent, so the caller can ask for another. */
  onTokenSpent?: () => void;
  /**
   * Called with the Worker's sentence when it turns out no text can be sent
   * here at all.
   *
   * `state.sms_ready` is the answer to that question BEFORE anything is
   * pressed, and it can be stale or missing — the request may have failed, or
   * the provider may have gone away since. When the send itself comes back 503
   * the caller has to know, or it goes on telling somebody to type digits that
   * are never going to arrive. The checkout uses it to raise the same notice at
   * the top of the page that a known-unready deployment raises.
   */
  onBlocked?: (message: string) => void;
}

export default function CodeSignIn({
  phone, onPhone, code, onCode, country = 'US', state,
  codeError = null, turnstileToken, onTokenSpent, onBlocked,
}: CodeSignInProps) {
  const phoneId = useId();
  const codeId = useId();
  const codeHintId = useId();
  const codeErrId = useId();

  const codeField = useRef<HTMLInputElement | null>(null);

  const [sending, setSending] = useState(false);
  /** Minutes the code lasts, from the Worker's own `expires_in`. */
  const [minutes, setMinutes] = useState<number | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  /**
   * The refusal there is no point retrying: no text-message provider on this
   * deployment. Separate from `sendError` because it takes the button away
   * rather than sitting beside it.
   */
  const [blocked, setBlocked] = useState<string | null>(null);

  const sent = minutes !== null;

  /**
   * The code field takes focus the moment it appears, and again whenever the
   * caller reports a bad code.
   *
   * This is the move a multi-step form has to get right: a field that is added
   * to the page under a keyboard or a screen reader is a question asked of
   * somebody who cannot tell it was asked. The status line below is announced
   * separately, so what is heard is "we sent a code to that number" followed
   * by the field's own label.
   */
  useEffect(() => { if (sent) codeField.current?.focus(); }, [sent]);
  useEffect(() => { if (codeError) codeField.current?.focus(); }, [codeError]);

  const requestCode = useCallback(async () => {
    if (sending) return;
    setSending(true);
    setSendError(null);
    const token = turnstileToken?.() ?? null;
    try {
      const res = await api.requestCustomerCode({
        phone: phone.trim(),
        country,
        ...(token ? { turnstile_token: token } : {}),
      });
      setMinutes(Math.round(res.expires_in / 60));
      // Cleared rather than kept: a customer who asks for a second code
      // because the first one was wrong should not still be looking at the
      // digits that failed.
      onCode('');
    } catch (e) {
      const code = e instanceof ApiError ? e.code : undefined;
      const message = e instanceof Error ? e.message
        : 'That did not go through. Try again in a moment.';
      // Said in the Worker's own words and with nothing to press afterwards.
      // This is not a fault the customer can retry past and offering them a
      // button implies it is.
      if (code === 'sms_not_configured') { setBlocked(message); onBlocked?.(message); }
      else setSendError(message);
    } finally {
      // The token is single-use whatever happened, so the caller is told it is
      // spent and can put a fresh one in front of whatever it sends next.
      if (token) onTokenSpent?.();
      setSending(false);
    }
  }, [sending, phone, country, onCode, turnstileToken, onTokenSpent, onBlocked]);

  // The Worker refuses before a text is composed, so a deployment with no
  // provider is named up front rather than after somebody has pressed a
  // button. `state` is null until the answer arrives; null is not a no.
  const smsOff = blocked ?? (state && !state.sms_ready ? state.sms_note : null);

  return (
    <div className="signup">
      {onPhone ? (
        <div className="signup-field">
          <label htmlFor={phoneId}>
            Mobile number
            <input id={phoneId} type="tel" value={phone} autoComplete="tel"
              inputMode="tel" enterKeyHint="send" disabled={Boolean(smsOff)}
              onChange={(e) => onPhone(e.target.value)} />
          </label>
          <p className="signup-hint">
            We text a six-digit code to it. That code is the whole of signing
            in — there is no password to choose and none to remember.
          </p>
        </div>
      ) : null}

      {smsOff ? (
        /* No button under it. See the note on `blocked`. */
        <p className="signup-blocked">{smsOff}</p>
      ) : (
        <>
          {/*
            Always in the document and empty until there is something to say. A
            live region added to the page at the same moment it gets its text
            is frequently not announced at all: the browser has nothing to
            notice a change against.
          */}
          <p className="signup-said" role="status">
            {sent
              ? `We sent a ${CODE_DIGITS}-digit code by text. It lasts `
                + `${minutes} minutes and works once.`
              : ''}
          </p>

          {sendError && <p className="signup-error" role="alert">{sendError}</p>}

          {sent && (
            <div className="signup-field">
              <label htmlFor={codeId}>
                The {CODE_DIGITS} digits we texted you
                {/*
                  One field, numeric keypad, and the autofill name that lets a
                  phone offer the code straight off the notification. maxLength
                  rather than a pattern that blocks typing: a customer who
                  pastes the whole message should end up with the digits out of
                  it and not with a refusal.
                */}
                <input id={codeId} ref={codeField} value={code}
                  inputMode="numeric" autoComplete="one-time-code"
                  maxLength={CODE_DIGITS} enterKeyHint="done"
                  aria-invalid={codeError ? true : undefined}
                  aria-describedby={codeError ? `${codeErrId} ${codeHintId}` : codeHintId}
                  onChange={(e) => onCode(
                    e.target.value.replace(/\D/g, '').slice(0, CODE_DIGITS))} />
              </label>
              {codeError && (
                <p className="signup-error" id={codeErrId} role="alert">{codeError}</p>
              )}
              <p className="signup-hint" id={codeHintId}>
                Five wrong tries and that code stops working. Ask for another
                and the one before it dies — the newest text is always the one
                that works.
              </p>
            </div>
          )}

          <div className="signup-do">
            <button className="btn quiet sm" type="button"
              disabled={sending || !phone.trim()}
              onClick={() => void requestCode()}>
              {sending ? 'Sending…' : sent ? 'Send another code' : 'Text me a code'}
            </button>
            {!sent && !phone.trim() && (
              <span className="signup-hint">
                A mobile number is what this button texts.
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
