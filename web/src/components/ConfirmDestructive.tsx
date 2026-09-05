import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import Sheet from './Sheet';

/**
 * The step in front of the two things in this product that cannot be undone.
 *
 * Erasing a customer and closing an account are the only calls here with no
 * grace period, no tombstone and no undo — the Worker really deletes, see
 * src/lib/retention.ts — so both of them get the same shape of question, and
 * getting it wrong once is enough to matter.
 *
 * WHAT MAKES THIS NOT AN "ARE YOU SURE".
 *
 *   The list is specific. The caller passes the actual things that will stop
 *   existing, named as the reader would name them — their photographs, their
 *   address, their licence number — because "this cannot be undone" tells
 *   somebody the weight of the decision and nothing about its content.
 *
 *   A word has to be typed. A confirm button is one mis-tap away from a
 *   scrolling thumb and a sheet that has just appeared under it; a word is
 *   not, and unlike a second confirm dialog it cannot be dismissed by
 *   reflex. The word is the verb — DELETE, CLOSE — so typing it is reading
 *   it.
 *
 *   The button that does it does not look like the buttons that do not. It
 *   carries the alert colour nothing else on these screens uses, it is
 *   labelled with what it destroys rather than "Confirm", and it stays
 *   disabled until the word matches.
 *
 *   Nothing here takes focus on open. Sheet moves focus to the panel, so the
 *   first thing under a returning Enter key is the dialog itself and not the
 *   control that empties the account.
 */
export default function ConfirmDestructive({
  title, word, confirmLabel, busy, error, onConfirm, onClose, children,
}: {
  title: string;
  /** Typed to unlock the button. The verb, in capitals: DELETE, CLOSE. */
  word: string;
  /** Names what stops existing. Never "Confirm", never "Yes". */
  confirmLabel: string;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
  /** What will be destroyed, and what will not. */
  children: ReactNode;
}) {
  const [typed, setTyped] = useState('');
  const fieldId = useId();
  const hintId = useId();
  const armed = typed.trim().toUpperCase() === word;

  return (
    <Sheet title={title} onClose={onClose}>
      <div className="stack">{children}</div>

      {error && <div className="error">{error}</div>}

      <label htmlFor={fieldId}>
        Type {word} to turn the button on
        <input id={fieldId} value={typed} autoComplete="off"
          autoCapitalize="characters" spellCheck={false}
          aria-describedby={hintId}
          onChange={(e) => setTyped(e.target.value)} />
      </label>
      <p className="faint" id={hintId} style={{ margin: 0 }}>
        This is here so the next button cannot be pressed by accident. There is
        no undo and nothing is kept for a few days first.
      </p>

      <div className="field-row">
        {/* The way out comes first, and it is the ordinary-looking one. */}
        <button className="btn quiet" type="button" onClick={onClose} disabled={busy}>
          Leave it as it is
        </button>
        <button className="btn alert" type="button" disabled={!armed || busy}
          onClick={onConfirm}>
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Sheet>
  );
}
