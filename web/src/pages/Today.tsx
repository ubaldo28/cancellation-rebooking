import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api, clockTime, durationLabel, money, timeRange,
  type Appointment, type Gap,
} from '../api';
import { useOperator } from '../App';
import { Empty, ErrorNote, Icon, Spinner } from '../components/ui';

const startOfToday = () => Math.floor(Date.now() / 1000) - 12 * 3600;

export default function Today() {
  const op = useOperator();
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [appts, setAppts] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const from = startOfToday();
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

  // A gap created by a cancellation is the thing the operator opened the app for.
  const urgent = gaps.find((g) => g.created_by_cancellation_of) ?? gaps[0];
  const others = gaps.filter((g) => g.id !== urgent?.id);

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
        {error && <ErrorNote error={error} onRetry={load} />}
        {loading && <Spinner />}

        {!loading && !error && (
          <>
            {urgent ? <GapCard gap={urgent} primary /> : (
              <div className="card stack">
                <h2>No open slots</h2>
                <p className="muted" style={{ margin: 0 }}>
                  Your next few days are either full or outside working hours.
                  Cancel a job and it will appear here straight away.
                </p>
              </div>
            )}

            {others.length > 0 && (
              <section className="stack">
                <span className="eyebrow">Also open</span>
                {others.map((g) => <GapCard key={g.id} gap={g} />)}
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

function GapCard({ gap, primary = false }: { gap: Gap; primary?: boolean }) {
  const op = useOperator();
  const cancelled = Boolean(gap.created_by_cancellation_of);

  if (!primary) {
    return (
      <Link to={`/gaps/${gap.id}`} className="card spread" style={{ color: 'inherit' }}>
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

      <Link to={`/gaps/${gap.id}`} className="btn block">
        {gap.live_offers > 0 ? 'See who you asked' : 'Fill this slot'}
        <Icon name="arrow" size={18} color="#fff" stroke={2} />
      </Link>
    </div>
  );
}
