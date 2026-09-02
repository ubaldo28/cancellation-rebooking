import type { ReactNode } from 'react';

export function Icon({ name, size = 20, color = 'currentColor', stroke = 1.8 }: {
  name: 'clock' | 'calendar' | 'people' | 'list' | 'cog' | 'pin' | 'arrow' | 'tick' | 'plus' | 'back' | 'send';
  size?: number; color?: string; stroke?: number;
}) {
  const paths: Record<string, ReactNode> = {
    clock: <><path d="M12 2v2" /><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2.5 2" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4M16 3v4M3 11h18" /></>,
    people: <><circle cx="9" cy="8" r="3.5" /><path d="M3 20a6 6 0 0 1 12 0" /><path d="M17 8.5a3 3 0 0 1 0 5" /><path d="M19 20a5 5 0 0 0-2-4" /></>,
    list: <path d="M4 6h16M4 12h16M4 18h10" />,
    cog: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" /></>,
    pin: <><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" /><circle cx="12" cy="10" r="3" /></>,
    arrow: <><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></>,
    tick: <path d="M20 6 9 17l-5-5" />,
    plus: <path d="M12 5v14M5 12h14" />,
    back: <path d="m15 18-6-6 6-6" />,
    send: <><path d="M22 2 11 13" /><path d="M22 2l-7 20-4-9-9-4 20-7z" /></>,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color}
      strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
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

export const initials = (first: string, last?: string | null) =>
  `${first[0] ?? ''}${last?.[0] ?? ''}`.toUpperCase() || first.slice(0, 2).toUpperCase();
