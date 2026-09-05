import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * The bottom sheet the two "add a thing" forms in the operator app open in.
 *
 * Clients and Jobs each had this written out: the same fixed overlay, the same
 * `rgba(28,26,23,0.4)`, the same 16px top corners, the same `stopPropagation`
 * on the form so a click inside does not close it. Two copies of a modal is two
 * places for the parts a modal needs and neither of them had: Escape did
 * nothing, focus stayed behind on the page that opened it, and nothing told an
 * assistive technology that a dialog had appeared at all — so the sheet was
 * invisible to anybody not looking at the screen.
 *
 * WHAT THIS DOES NOT DO. There is no focus trap. A trap is only correct with a
 * reliable way out, and the two ways out here — Escape and the Close button —
 * both exist and are both reachable; a half-built trap that can strand somebody
 * inside a form is worse than no trap. Focus moves in on open and back to
 * whatever opened it on close, which is the part that actually gets somebody
 * from the button they pressed into the fields and back out again.
 */
export default function Sheet({ title, onClose, children }: {
  /** Names the dialog, and is rendered as its heading. */
  title: string;
  onClose: () => void;
  /** The form. It is rendered inside a <form>-less panel; bring your own. */
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    // Where focus goes back to. Read before anything is moved.
    const opener = document.activeElement as HTMLElement | null;
    panel.current?.focus();

    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    // The page behind must not scroll under a sheet that covers it.
    const scroll = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = scroll;
      opener?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}
        ref={panel} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="spread">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="btn quiet sm" onClick={onClose}>Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}
