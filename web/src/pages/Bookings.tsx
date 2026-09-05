import { useCallback, useEffect, useState } from 'react';
import { api, clockTime, shortDate, type Notification } from '../api';
import { useOperator } from '../App';
import OnlineSwitch from '../components/OnlineSwitch';
import JobsPanel from '../components/JobsPanel';
import { Empty, ErrorNote, Icon, Spinner } from '../components/ui';
import { useDocumentTitle } from '../lib/title';

/** What each kind is called, and whether it is good news. */
const KINDS: Record<string, { label: string; tone: 'good' | 'alert' }> = {
  public_booking: { label: 'New booking', tone: 'good' },
  offer_accepted: { label: 'Offer accepted', tone: 'good' },
  booking_cancelled: { label: 'Cancelled', tone: 'alert' },
  chat_message: { label: 'Message', tone: 'good' },
  // Its own label: an operator standing next to a car waiting on this answer
  // must not have to find it behind a generic "Update".
  parts_quote: { label: 'Parts answer', tone: 'good' },
};

export default function Bookings() {
  useDocumentTitle('Bookings');
  const op = useOperator();
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [marking, setMarking] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.notifications();
      setItems(res.notifications);
      setUnread(res.unread);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your bookings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const markAll = useCallback(async () => {
    setMarking(true);
    const at = Math.floor(Date.now() / 1000);
    try {
      await api.markNotificationsRead();
      // Applied here rather than by reloading: the list must not reorder or
      // jump under the thumb that just tapped it.
      setItems((rows) => rows.map((r) => (r.read_at ? r : { ...r, read_at: at })));
      setUnread(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not mark those as read.');
    } finally {
      setMarking(false);
    }
  }, []);

  return (
    <>
      <header className="page-head">
        <span className="eyebrow">
          {unread > 0 ? `${unread} unread` : 'Up to date'}
        </span>
        <h1>Bookings</h1>
      </header>

      <main className="main stack-lg">
        {/* The switch is first: it is the decision an operator makes before
            anything else on this page matters. */}
        <OnlineSwitch />

        {/* Then the jobs, then the news about the jobs. An operator opening
            this page on a doorstep needs the buttons, not the history. */}
        <JobsPanel />

        {error && <ErrorNote error={error} onRetry={load} />}
        {loading && <Spinner />}

        {!loading && !error && (
          <>
            {items.length === 0 ? (
              <Empty>
                Nothing here yet. When someone books an open slot from your
                public page, it shows up here.
              </Empty>
            ) : (
              <section className="stack">
                {unread > 0 && (
                  <div className="feed-head">
                    <span className="muted">
                      {unread === 1 ? '1 you have not seen' : `${unread} you have not seen`}
                    </span>
                    <button className="btn quiet sm" onClick={markAll} disabled={marking}>
                      {marking ? 'Marking…' : 'Mark all read'}
                    </button>
                  </div>
                )}

                {items.map((n) => <Row key={n.id} n={n} op={op} />)}
              </section>
            )}
          </>
        )}
      </main>
    </>
  );
}

function Row({ n, op }: { n: Notification; op: ReturnType<typeof useOperator> }) {
  const kind = KINDS[n.kind] ?? { label: 'Update', tone: 'good' as const };
  const unread = n.read_at === null;

  return (
    <article className={`feed-row${unread ? ' unread' : ''}`}>
      <div className="feed-top">
        <span className={`chip ${kind.tone === 'alert' ? 'warn' : 'good'}`}>{kind.label}</span>
        <span className="feed-ago">{ago(n.created_at)}</span>
      </div>

      <div className="name">{n.title}</div>
      {n.body && <div className="muted">{n.body}</div>}

      {n.starts_at !== null && (
        <div className="feed-when">
          <Icon name="clock" size={15} color="var(--muted)" />
          <span className="mono">
            {shortDate(n.starts_at, op)} · {clockTime(n.starts_at, op)}
          </span>
        </div>
      )}
    </article>
  );
}

/**
 * How long ago the news arrived.
 *
 * Deliberately coarse. The operator is asking "did this happen while I was
 * asleep", not what minute it was, and an exact timestamp on every row reads
 * as a log file rather than as their day.
 */
function ago(created: number): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - created);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}
