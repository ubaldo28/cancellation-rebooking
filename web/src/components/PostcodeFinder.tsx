import { useState, type FormEvent } from 'react';
import { Icon } from './ui';

/**
 * "Where are you?" — the postcode box on the trade page and the cost guide.
 *
 * The two pages had this written out twice, down to the same class names, the
 * same pin, the same `role="status"` on both the warning and the confirmation,
 * and the same Change button that clears everything and reloads. They already
 * differed in the only two places they are allowed to: what the field is asking
 * for, and what the page does with the answer once it has one. Those are the
 * two props; everything else is here once.
 *
 * The typed text is this component's own state because nothing outside needs to
 * read it — the pages take the postcode through `onSearch` and hold only the
 * result. What they do keep is the request state, because a page-wide "looking"
 * flag has to survive this component re-rendering and the pages disable other
 * things on it.
 */
export interface PostcodeFinderProps {
  /** Unique per page: the label points at the field by id. */
  id: string;
  /** What the box is asking for, in this page's terms. */
  label: string;
  /** A request is in flight. The button says so and refuses a second press. */
  locating: boolean;
  /** Why the last postcode did not resolve, if it did not. */
  error: string | null;
  /** The place the page settled on, or null before one is given. */
  near: string | null;
  /** What having a place means on this page — "Showing what can reach". */
  showing: string;
  onSearch: (postcode: string) => void;
  onClear: () => void;
}

export default function PostcodeFinder({
  id, label, locating, error, near, showing, onSearch, onClear,
}: PostcodeFinderProps) {
  const [postcode, setPostcode] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const pc = postcode.trim();
    if (pc) onSearch(pc);
  };

  return (
    <div className="tr-find">
      <label className="tr-find-label" htmlFor={id}>{label}</label>
      <form className="tr-finder" onSubmit={submit}>
        <span className="tr-finder-pin" aria-hidden="true">
          <Icon name="pin" size={19} />
        </span>
        <input id={id} value={postcode} onChange={(e) => setPostcode(e.target.value)}
          placeholder="Postcode or ZIP" autoComplete="postal-code" inputMode="text" />
        <button type="submit" disabled={locating || !postcode.trim()}>
          {locating ? 'Looking…' : 'Search'}
        </button>
      </form>

      {error && <p className="tr-warn" role="status">{error}</p>}

      {/* role="status", to match the error line beside it. Giving a postcode
          rewrites every figure on these pages without navigating anywhere, and
          this sentence is the only thing that says the page has moved. */}
      {near && (
        <p className="tr-located" role="status">
          <Icon name="pin" size={15} />
          <span>{showing} <strong>{near}</strong></span>
          <button type="button" onClick={() => { setPostcode(''); onClear(); }}>
            Change
          </button>
        </p>
      )}
    </div>
  );
}
