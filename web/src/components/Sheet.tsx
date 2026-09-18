import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * Everything the Tab key can stop on, for the loop below. `[disabled]` is
 * excluded in the selector rather than filtered afterwards because a disabled
 * Save button is exactly what sits at the end of these forms while they are
 * still being filled in, and treating it as the last stop would bounce focus
 * off a control nothing can reach.
 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

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
 * WHY TAB IS HELD INSIDE. `aria-modal="true"` tells a screen reader that
 * everything behind this panel is not there, and the reader believes it: it
 * stops offering that content at all. Nothing was stopping the Tab key from
 * walking out into it anyway, so a keyboard user could leave the dialog and
 * land among links their own software had just been told did not exist — no
 * announcement, nothing read out, and no obvious way back. That is WCAG 2.1 AA
 * 2.4.3 Focus Order: the order focus moves in has to preserve meaning, and an
 * order that leads somewhere the user has been told is empty does not.
 *
 * There were two honest ways to fix it — hold focus inside, or drop the
 * aria-modal so the outside stays real and described. Holding it is the right
 * one here because the page behind genuinely is inert while this is open: it
 * cannot even scroll, and the only thing to do with it is close this. A reader
 * that ignores it is telling the truth, so the markup should stay and the
 * keyboard should match it.
 *
 * A trap is only safe with a way out, and both of the ones this already had
 * still work: Escape, and the Close button that is the first thing in the
 * panel either way round the loop.
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

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key !== 'Tab') return;
      const box = panel.current;
      if (!box) return;

      // Worked out on every press rather than once on open. The forms in here
      // grow and shrink as they are filled in — an error line appears, a Save
      // button stops being disabled, a whole section unfolds — so a list taken
      // at open time starts sending focus to a control that has since gone.
      // getClientRects() is how a field inside a collapsed section is told
      // apart from one that is merely off to the side.
      const stops = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((el) => el.getClientRects().length > 0);
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (!first || !last) {
        // A sheet with nothing tabbable in it still must not hand the page
        // behind to a reader that has been told it is not there.
        e.preventDefault();
        box.focus();
        return;
      }

      const here = document.activeElement;
      // The panel itself holds focus on open and is not in the list, so a
      // Shift+Tab from it is a step backwards out of the dialog.
      const leavingBackwards = e.shiftKey && (here === first || here === box);
      const leavingForwards = !e.shiftKey && here === last;
      if (leavingBackwards || leavingForwards || !box.contains(here)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
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
