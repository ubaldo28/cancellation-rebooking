import type { ReactNode } from 'react';

export function Icon({ name, size = 20, color = 'currentColor', stroke = 1.8 }: {
  name: 'clock' | 'calendar' | 'people' | 'list' | 'chat' | 'cog' | 'pin' | 'arrow'
    | 'tick' | 'plus' | 'back' | 'send' | 'search' | 'camera';
  size?: number; color?: string; stroke?: number;
}) {
  const paths: Record<string, ReactNode> = {
    clock: <><path d="M12 2v2" /><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2.5 2" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4M16 3v4M3 11h18" /></>,
    people: <><circle cx="9" cy="8" r="3.5" /><path d="M3 20a6 6 0 0 1 12 0" /><path d="M17 8.5a3 3 0 0 1 0 5" /><path d="M19 20a5 5 0 0 0-2-4" /></>,
    list: <path d="M4 6h16M4 12h16M4 18h10" />,
    /* Messages. `list` was standing in for this in the bottom bar, and three
       stacked lines is the universal glyph for a MENU — the one icon on that
       bar that told the operator the wrong thing about where a tap goes. */
    chat: <path d="M21 12a8 8 0 0 1-8 8H4l2.2-2.9A8 8 0 1 1 21 12Z" />,
    cog: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" /></>,
    pin: <><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" /><circle cx="12" cy="10" r="3" /></>,
    arrow: <><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></>,
    tick: <path d="M20 6 9 17l-5-5" />,
    plus: <path d="M12 5v14M5 12h14" />,
    back: <path d="m15 18-6-6 6-6" />,
    send: <><path d="M22 2 11 13" /><path d="M22 2l-7 20-4-9-9-4 20-7z" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" /></>,
    /* Attaching a photo to a message. A camera and not a paperclip: the thing
       on the other side of this button is only ever a photograph — the Worker
       stores three image formats and nothing else — and a paperclip promises
       documents, which would make every refused PDF the app's fault rather
       than an expectation it should never have set. */
    camera: <><path d="M3 8.5A2 2 0 0 1 5 6.5h2L8.5 4h7L17 6.5h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><circle cx="12" cy="13" r="3.5" /></>,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color}
      strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

/**
 * A rating as five glyphs: one object, one name.
 *
 * `role="img"` is what makes the `aria-label` legal. ARIA will not name a bare
 * <span>, so without the role the label is dropped and what gets read is the
 * characters themselves — "black star black star black star white star white
 * star", or in some voices nothing at all. It also collapses the run into a
 * single object, which is what it already looks like to anybody who can see it.
 *
 * The profile page and the trade page both draw this and want it in different
 * colours and sizes, so the class is the caller's; the `-off` half is derived
 * from it, so a caller only names one thing. Both had their own copy of the
 * component, each with its own copy of the reasoning above.
 */
export function Stars({ n, className = 'stars' }: { n: number; className?: string }) {
  return (
    <span className={className} role="img" aria-label={`${n} out of 5 stars`}>
      <span aria-hidden="true">
        {'\u2605\u2605\u2605\u2605\u2605'.slice(0, n)}
        <span className={`${className}-off`}>
          {'\u2605\u2605\u2605\u2605\u2605'.slice(0, 5 - n)}
        </span>
      </span>
    </span>
  );
}

export const Spinner = ({ label = 'Loading' }: { label?: string }) => (
  <div className="empty">{label}…</div>
);

export const Empty = ({ children }: { children: ReactNode }) => (
  <div className="empty">{children}</div>
);

export function ErrorNote({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="stack">
      <div className="error">{error}</div>
      {onRetry && <button className="btn quiet sm" onClick={onRetry}>Try again</button>}
    </div>
  );
}

/**
 * The rule about contact details, said before somebody types rather than after.
 *
 * Word for word what the Worker sends back when it has already taken something
 * out of a chat message — REDACTION_NOTICE in src/lib/redact.ts. The same
 * filter now runs over the operator's parts-quote description, and it runs
 * SILENTLY there: no notice comes back, so a description that loses a phone
 * number loses it with nobody told. Saying it up front is the only warning
 * those boxes can give, and saying it in different words from chat would read
 * as a different rule.
 */
export const REDACTION_NOTICE =
  'Contact details are removed from messages. Keep everything here and you are '
  + 'covered if anything goes wrong — off the app, neither of you is.';

/**
 * Rendered above the box it applies to, and wired to it with aria-describedby
 * so it is read out as part of the field rather than sitting nearby unheard.
 */
export const RedactionNotice = ({ id }: { id: string }) => (
  <p className="faint" id={id} style={{ margin: 0 }}>{REDACTION_NOTICE}</p>
);

export const initials = (first: string, last?: string | null) =>
  `${first[0] ?? ''}${last?.[0] ?? ''}`.toUpperCase() || first.slice(0, 2).toUpperCase();
