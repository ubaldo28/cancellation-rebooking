import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api, clockTime, durationLabel, money, timeRange,
  type Appointment, type Gap,
} from '../api';
import { useOperator } from '../App';
import { Empty, ErrorNote, Icon, Spinner } from '../components/ui';
import { useDocumentTitle } from '../lib/title';

/**
 * Where this screen starts looking.
 *
 * Twelve hours back rather than the operator's own midnight, and the name says
 * so now — it was called `startOfToday`, which it has never been. The window is
 * deliberately loose: this page is not a diary for one date, it is "what is in
 * front of me", and a job that started an hour before an operator opened the
 * app at one in the morning still belongs on it. Everything below filters by
 * what has not ended yet, so the slack costs nothing.
 */
const twelveHoursAgo = () => Math.floor(Date.now() / 1000) - 12 * 3600;

export default function Today() {
  useDocumentTitle('Today');
  const op = useOperator();
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [appts, setAppts] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const from = twelveHoursAgo();
      const to = from + 3 * 86400;
      // Detect first so a cancellation made elsewhere shows up immediately.
      await api.detectGaps(14).catch(() => {});
      const [g, a] = await Promise.all([api.gaps(from, to), api.appointments(from, to)]);
      setGaps(g.gaps);
      setAppts(a.appointments.filter((x) => x.status === 'scheduled' || x.status === 'completed'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load today.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const now = Math.floor(Date.now() / 1000);
  const upcoming = appts
    .filter((a) => a.ends_at > now && a.status === 'scheduled')
    .sort((a, b) => a.starts_at - b.starts_at);

  // A whole unbooked day is a different problem from a hole between two jobs.
  // Mixing them buried the gap worth acting on under "10h free" entries.
  const holes = gaps.filter((g) => g.fills_whole_day !== 1);
  const emptyDays = gaps.filter((g) => g.fills_whole_day === 1);

  // A gap created by a cancellation is the thing the operator opened the app for.
  const urgent = holes.find((g) => g.created_by_cancellation_of) ?? holes[0];
  const others = holes.filter((g) => g.id !== urgent?.id);

  const today = new Intl.DateTimeFormat(
    op ? `${op.language}-${op.country}` : 'en-US',
    { timeZone: op?.timezone, weekday: 'long', day: 'numeric', month: 'long' },
  ).format(new Date());

  return (
    <>
      <header className="page-head">
        <span className="eyebrow">{today}</span>
        <h1>Today</h1>
      </header>

      <main className="main stack-lg">
        {/* An operator whose book is already full has no holes for the app to
            find, so nothing below would ever have anything for them. This is
            their way in: one free slot, put up in a few taps, without their
            whole diary being typed in first. */}
        <Link to="/app/post" className="card spread" style={{
          color: 'inherit', background: 'var(--accent-soft)',
          borderColor: 'var(--accent-line)',
        }}>
          <div className="stack" style={{ gap: 3 }}>
            <span className="eyebrow" style={{ color: 'var(--accent-ink)' }}>
              Diary already full?
            </span>
            <span className="name">Post a slot you have free</span>
            <span className="muted">
              One hour, today or any day. You do not have to put your whole
              schedule in here to sell it.
            </span>
          </div>
          <Icon name="arrow" size={18} color="var(--accent-ink)" />
        </Link>

        {error && <ErrorNote error={error} onRetry={load} />}
        {loading && <Spinner />}

        {!loading && !error && (
          <>
            {urgent ? <GapCard gap={urgent} primary /> : (
              <div className="card stack">
                <h2>No gaps to fill</h2>
                <p className="muted" style={{ margin: 0 }}>
                  Nothing has cancelled and there are no holes between your
                  jobs. If a job cancels it shows up here straight away.
                </p>
              </div>
            )}

            {others.length > 0 && (
              <section className="stack">
                <span className="eyebrow">Also open</span>
                {others.map((g) => <GapCard key={g.id} gap={g} />)}
              </section>
            )}

            {emptyDays.length > 0 && (
              <section className="stack">
                <span className="eyebrow">Nothing booked</span>
                <p className="muted" style={{ margin: 0 }}>
                  {emptyDays.length === 1 ? 'One day' : `${emptyDays.length} days`}
                  {' '}with no work at all. That is not a slot to fill — it is a
                  day to sell. Your booking page is where strangers find it.
                </p>
                {emptyDays.map((g) => (
                  <Link key={g.id} to={`/app/gaps/${g.id}`} className="card spread"
                    style={{ color: 'inherit' }}>
                    <div className="stack" style={{ gap: 2 }}>
                      <span className="mono" style={{ fontWeight: 600 }}>{dayLabel(g, op)}</span>
                      <span className="muted">No jobs booked</span>
                    </div>
                    <Icon name="arrow" size={18} color="var(--muted)" />
                  </Link>
                ))}
              </section>
            )}

            <section className="stack">
              <span className="eyebrow">Coming up</span>
              {upcoming.length === 0
                ? <Empty>Nothing else booked.</Empty>
                : upcoming.slice(0, 6).map((a) => (
                  <div className="timeline-row" key={a.id}>
                    <div className="timeline-time">{clockTime(a.starts_at, op)}</div>
                    <div className="timeline-body">
                      <span className="name">
                        {a.first_name ? `${a.first_name} ${a.last_name ?? ''}`.trim() : 'Booked'}
                      </span>
                      <span className="muted">
                        {[a.service_name, a.address_line].filter(Boolean).join(' · ') || 'Appointment'}
                        {a.price_cents ? ` · ${money(a.price_cents, op)}` : ''}
                      </span>
                    </div>
                  </div>
                ))}
            </section>
          </>
        )}
      </main>
    </>
  );
}

/** "Fri, 4 Sep" — an empty day is named by its date, not by a time range. */
function dayLabel(gap: Gap, op: ReturnType<typeof useOperator>): string {
  return new Intl.DateTimeFormat(
    op ? `${op.language}-${op.country}` : 'en-US',
    { timeZone: op?.timezone, weekday: 'short', day: 'numeric', month: 'short' },
  ).format(new Date(gap.starts_at * 1000));
}

function GapCard({ gap, primary = false }: { gap: Gap; primary?: boolean }) {
  const op = useOperator();
  const cancelled = Boolean(gap.created_by_cancellation_of);

  if (!primary) {
    return (
      <Link to={`/app/gaps/${gap.id}`} className="card spread" style={{ color: 'inherit' }}>
        <div className="stack" style={{ gap: 2 }}>
          <span className="mono" style={{ fontWeight: 600 }}>
            {timeRange(gap.starts_at, gap.ends_at, op)}
          </span>
          <span className="muted">{durationLabel(gap.ends_at - gap.starts_at)} free</span>
        </div>
        <Icon name="arrow" size={18} color="var(--muted)" />
      </Link>
    );
  }

  return (
    <div className="card alert stack" style={{ gap: 14 }}>
      <div className="row" style={{ gap: 8 }}>
        <span style={{
          width: 7, height: 7, borderRadius: '50%',
          background: cancelled ? 'var(--alert)' : 'var(--accent)', flexShrink: 0,
        }} />
        <span className="eyebrow" style={{ color: cancelled ? 'var(--alert)' : 'var(--accent)' }}>
          {cancelled ? 'Cancelled' : 'Open slot'}
        </span>
      </div>

      <div className="stack" style={{ gap: 4 }}>
        <div className="slot">{timeRange(gap.starts_at, gap.ends_at, op)}</div>
        <div className="muted">{durationLabel(gap.ends_at - gap.starts_at)} open</div>
      </div>

      {gap.live_offers > 0 && (
        <div className="notice">
          {gap.live_offers} offer{gap.live_offers === 1 ? '' : 's'} sent and waiting on a reply.
        </div>
      )}

      <div className="rule" />

      <Link to={`/app/gaps/${gap.id}`} className="btn block">
        {gap.live_offers > 0 ? 'See who you asked' : 'Fill this slot'}
        <Icon name="arrow" size={18} color="#fff" stroke={2} />
      </Link>
    </div>
  );
}
