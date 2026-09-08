import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  api, clockTime, durationLabel, localeFor, money,
  type Appointment, type Gap,
} from '../api';
import { useOperator } from '../App';
import { ErrorNote, Icon, Spinner } from '../components/ui';
import { useDocumentTitle } from '../lib/title';
import { addDays, daysBetween, epochInZone, todayIn } from '../lib/zone';

const DAY = 86400;

/** A day this far from today is a mistyped link, not a schedule anybody keeps. */
const MAX_DAYS_AWAY = 366;

export default function Schedule() {
  useDocumentTitle('Schedule');
  const op = useOperator();
  const [search] = useSearchParams();
  const [offset, setOffset] = useState(0);           // days from today
  const [appts, setAppts] = useState<Appointment[]>([]);
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /**
   * The appointment whose cancel is waiting on a second tap.
   *
   * "Done", "Cancelled" and "No-show" were three small buttons in a row, and
   * only one of them frees a customer's slot, puts a hole back in the day and
   * cannot be undone from this screen. On a phone in a moving van the middle
   * one is a mis-tap. The other two are corrections an operator can make again;
   * this one is a job somebody is expecting.
   */
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);

  /**
   * WHOSE MIDNIGHT THIS IS.
   *
   * It used to be the browser's: `new Date()` with the hours zeroed is midnight
   * wherever the phone is standing, and the heading beside it was then formatted
   * in the operator's own zone. For a Los Angeles operator opening the app after
   * five in the afternoon those are different days, so the page fetched one day
   * and named another — and there is no worse screen to be a day out on than the
   * one an operator reads to find out where they are meant to be. Both the
   * window and the label are now built from the same calendar date in the
   * operator's zone.
   */
  const tz = op?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dateFor = useCallback((by: number) => addDays(todayIn(tz), by), [tz]);
  const dayStart = useCallback(
    () => epochInZone(dateFor(offset), '00:00', tz), [dateFor, offset, tz]);

  /**
   * `?on=YYYY-MM-DD` opens the schedule on that day rather than on today.
   *
   * This is what makes a feed row a way back to the booking it is about. A
   * notification is a sentence written at the moment something happened and
   * nothing can afterwards edit it, so the doorstep is no longer in one — the
   * operator comes here to read it off the appointment, where a cancellation
   * withdraws it. That trip has to be one tap or the address goes back in the
   * notification the first time somebody complains.
   *
   * Run once, as the starting point rather than as a lock: the arrows must
   * still work afterwards, and a link that snapped the page back to its own day
   * every time they were pressed would be worse than no link.
   */
  useEffect(() => {
    const on = search.get('on');
    if (!on || !/^\d{4}-\d{2}-\d{2}$/.test(on)) return;
    const away = daysBetween(todayIn(tz), on);
    if (!Number.isFinite(away) || Math.abs(away) > MAX_DAYS_AWAY) return;
    setOffset(away);
    // Deliberately only on arrival. See above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    setBusy(id); setError(null);
    try {
      if (action === 'cancel') await api.cancelAppointment(id, 'client');
      else await api.updateAppointment(id, { status: action });
      setConfirmCancel(null);
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

  /**
   * The day `by` days from today, named. Used by the heading and both arrows.
   *
   * Read back at noon UTC: a calendar date has no time of day, and any other
   * hour rolls it to the day before or after somewhere in the world.
   *
   * The locale comes from localeFor rather than being spelled out again: an
   * operator whose language column is empty would otherwise make "-US", which
   * Intl rejects with a RangeError from inside render and takes the screen
   * with it.
   */
  const dayLabel = (by: number) => new Intl.DateTimeFormat(
    localeFor(op),
    { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'short' },
  ).format(new Date(`${dateFor(by)}T12:00:00Z`));

  const label = dayLabel(offset);

  return (
    <>
      <header className="page-head">
        <h1>Schedule</h1>
      </header>

      <main className="main stack">
        {/* Both arrows are an icon and nothing else, and the icon is
            aria-hidden, so without a label they were announced as "button" —
            two of them, either side of a date, with no way to tell which way
            each one goes. The label names the day it moves to rather than the
            direction, because "previous" is meaningless read on its own. */}
        <div className="spread">
          <button className="btn quiet sm" aria-label={`Go to ${dayLabel(offset - 1)}`}
            onClick={() => setOffset((o) => o - 1)}>
            <Icon name="back" size={16} color="var(--muted)" />
          </button>
          <span style={{ fontWeight: 600 }}>
            {offset === 0 ? 'Today' : label}
          </span>
          <button className="btn quiet sm" aria-label={`Go to ${dayLabel(offset + 1)}`}
            onClick={() => setOffset((o) => o + 1)}>
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
              <Link to={`/app/gaps/${r.gap.id}`} className="btn alert sm block">Fill this slot</Link>
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
                confirmCancel === r.appt.id ? (
                  <div className="stack" style={{ marginTop: 8, gap: 8 }}>
                    <span className="muted">
                      Cancel this appointment? The time goes back into your day
                      as an open slot and this screen cannot put it back.
                    </span>
                    <div className="chips">
                      <button className="btn quiet sm" disabled={busy === r.appt.id}
                        onClick={() => setConfirmCancel(null)}>Keep it</button>
                      <button className="btn quiet sm" disabled={busy === r.appt.id}
                        onClick={() => act(r.appt.id, 'cancel')}>
                        {busy === r.appt.id ? 'Cancelling…' : 'Yes, cancel it'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="chips" style={{ marginTop: 8 }}>
                    <button className="btn quiet sm" disabled={busy === r.appt.id}
                      onClick={() => act(r.appt.id, 'completed')}>Done</button>
                    <button className="btn quiet sm" disabled={busy === r.appt.id}
                      onClick={() => setConfirmCancel(r.appt.id)}>Cancelled</button>
                    <button className="btn quiet sm" disabled={busy === r.appt.id}
                      onClick={() => act(r.appt.id, 'no_show')}>No-show</button>
                  </div>
                )
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
