import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api, clockTime, durationLabel, money,
  type Appointment, type Gap,
} from '../api';
import { useOperator } from '../App';
import { ErrorNote, Icon, Spinner } from '../components/ui';

const DAY = 86400;

export default function Schedule() {
  const op = useOperator();
  const [offset, setOffset] = useState(0);           // days from today
  const [appts, setAppts] = useState<Appointment[]>([]);
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const dayStart = useCallback(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000) + offset * DAY;
  }, [offset]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const from = dayStart();
      const [a, g] = await Promise.all([
        api.appointments(from, from + DAY),
        api.gaps(from, from + DAY),
      ]);
      setAppts(a.appointments);
      setGaps(g.gaps);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the schedule.');
    } finally {
      setLoading(false);
    }
  }, [dayStart]);

  useEffect(() => { void load(); }, [load]);

  async function act(id: string, action: 'completed' | 'no_show' | 'cancel') {
    setBusy(id);
    try {
      if (action === 'cancel') await api.cancelAppointment(id, 'client');
      else await api.updateAppointment(id, { status: action });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  }

  const scheduled = appts.filter((a) => a.status !== 'cancelled');
  const rows = [
    ...scheduled.map((a) => ({ kind: 'appt' as const, at: a.starts_at, appt: a })),
    ...gaps.map((g) => ({ kind: 'gap' as const, at: g.starts_at, gap: g })),
  ].sort((x, y) => x.at - y.at);

  const label = new Intl.DateTimeFormat(
    op ? `${op.language}-${op.country}` : 'en-US',
    { timeZone: op?.timezone, weekday: 'long', day: 'numeric', month: 'short' },
  ).format(new Date(dayStart() * 1000));

  return (
    <>
      <header className="page-head">
        <h1>Schedule</h1>
      </header>

      <main className="main stack">
        <div className="spread">
          <button className="btn quiet sm" onClick={() => setOffset((o) => o - 1)}>
            <Icon name="back" size={16} color="var(--muted)" />
          </button>
          <span style={{ fontWeight: 600 }}>
            {offset === 0 ? 'Today' : label}
          </span>
          <button className="btn quiet sm" onClick={() => setOffset((o) => o + 1)}>
            <Icon name="arrow" size={16} color="var(--muted)" />
          </button>
        </div>

        {error && <ErrorNote error={error} onRetry={load} />}
        {loading && <Spinner />}

        {!loading && rows.length === 0 && (
          <div className="empty">Nothing booked, and no open slots inside your working hours.</div>
        )}

        {!loading && rows.map((r) => r.kind === 'gap' ? (
          <div className="timeline-row" key={r.gap.id}>
            <div className="timeline-time" style={{ color: 'var(--alert)' }}>
              {clockTime(r.gap.starts_at, op)}
            </div>
            <div className="gap-open grow">
              <div className="stack" style={{ gap: 4 }}>
                <span className="mono" style={{ fontSize: 17, fontWeight: 600, color: 'var(--alert)' }}>
                  {durationLabel(r.gap.ends_at - r.gap.starts_at)} free
                </span>
                {r.gap.created_by_cancellation_of && (
                  <span style={{ fontSize: 13, color: '#8a6a4d' }}>Someone cancelled</span>
                )}
              </div>
              <Link to={`/gaps/${r.gap.id}`} className="btn alert sm block">Fill this slot</Link>
            </div>
          </div>
        ) : (
          <div className="timeline-row" key={r.appt.id}>
            <div className="timeline-time">{clockTime(r.appt.starts_at, op)}</div>
            <div className={`timeline-body${r.appt.status !== 'scheduled' ? ' done' : ''}`}>
              <span className="name" style={{ fontSize: 15 }}>
                {r.appt.first_name
                  ? `${r.appt.first_name} ${r.appt.last_name ?? ''}`.trim()
                  : 'Appointment'}
              </span>
              <span className="muted">
                {[r.appt.service_name, r.appt.address_line].filter(Boolean).join(' · ') || '—'}
                {r.appt.price_cents ? ` · ${money(r.appt.price_cents, op)}` : ''}
              </span>

              {r.appt.status === 'scheduled' ? (
                <div className="chips" style={{ marginTop: 8 }}>
                  <button className="btn quiet sm" disabled={busy === r.appt.id}
                    onClick={() => act(r.appt.id, 'completed')}>Done</button>
                  <button className="btn quiet sm" disabled={busy === r.appt.id}
                    onClick={() => act(r.appt.id, 'cancel')}>Cancelled</button>
                  <button className="btn quiet sm" disabled={busy === r.appt.id}
                    onClick={() => act(r.appt.id, 'no_show')}>No-show</button>
                </div>
              ) : (
                <span className="chip neutral" style={{ marginTop: 6, alignSelf: 'flex-start' }}>
                  {r.appt.status.replace('_', ' ')}
                </span>
              )}
            </div>
          </div>
        ))}
      </main>
    </>
  );
}
