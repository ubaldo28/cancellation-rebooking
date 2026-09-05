import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api, durationLabel, localeFor, money,
  type Opening, type Operator, type Service,
} from '../api';
import { useOperator } from '../App';
import { Empty, ErrorNote, Icon, Spinner } from '../components/ui';
import { addDays, epochInZone, hhmm, nowMinutesIn, todayIn } from '../lib/zone';
import '../styles-openings.css';
import { useDocumentTitle } from '../lib/title';

/**
 * Post an opening — /app/post
 *
 * Everywhere else in the app an opening is something the app *found*: a hole
 * between two jobs the operator typed in. Someone who signs up with a full
 * book and keeps their diary somewhere else has no holes to find, and no
 * reason to enter a month of work before selling one free Thursday afternoon.
 *
 * This is the short way round. Say when you are free, say what you will do,
 * post it. One slot is a complete answer; nothing here asks for a schedule.
 */

/**
 * The latest start worth offering as "today". Past this there is not enough
 * evening left to sell, so the page opens on tomorrow instead of on a day
 * that is already over.
 */
const LAST_USEFUL_START = 20 * 60;   // 20:00

function openingDay(tz: string): { date: string; start: string } {
  const today = todayIn(tz);
  // Round up to the next quarter hour, with five minutes of slack, so the
  // suggested start is not already in the past by the time they tap Post.
  const next = Math.ceil((nowMinutesIn(tz) + 5) / 15) * 15;
  return next <= LAST_USEFUL_START
    ? { date: today, start: hhmm(next) }
    : { date: addDays(today, 1), start: '09:00' };
}

// --- words -----------------------------------------------------------------

/**
 * Times are formatted by the operator's own locale rather than forced to the
 * 24-hour clock the compact rows elsewhere use. This sentence is meant to be
 * read aloud in your head before you commit a slot, and a US operator does
 * not read 14:00 that way.
 */
function clock(epochS: number, op: Operator | null): string {
  return new Intl.DateTimeFormat(localeFor(op), {
    timeZone: op?.timezone ?? 'UTC', hour: 'numeric', minute: '2-digit',
  }).format(new Date(epochS * 1000));
}

function dayOf(epochS: number, op: Operator | null): string {
  return new Intl.DateTimeFormat(localeFor(op), {
    timeZone: op?.timezone ?? 'UTC', weekday: 'short', day: 'numeric', month: 'short',
  }).format(new Date(epochS * 1000));
}

/** "Sun 6" — the label on a day button. */
function dayChipLabel(iso: string, op: Operator | null): string {
  // A calendar date has no time of day, so it is read back at noon UTC: any
  // other hour can roll it to the day before somewhere in the world.
  const at = new Date(`${iso}T12:00:00Z`);
  const part = (opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(localeFor(op), { timeZone: 'UTC', ...opts }).format(at);
  // Composed by hand: asking Intl for weekday and day together gives "6 Sun"
  // in US English, which is not how anyone writes a date.
  return `${part({ weekday: 'short' })} ${part({ day: 'numeric' })}`;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** "2 hours", "1 hour 30 minutes", "45 minutes". */
function spellDuration(seconds: number): string {
  const mins = Math.max(0, Math.round(seconds / 60));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h && m) return `${plural(h, 'hour')} ${plural(m, 'minute')}`;
  if (h) return plural(h, 'hour');
  return plural(m, 'minute');
}

/** "Thu 4 Sep, 2:00 PM – 4:00 PM, 2 hours" */
function windowWords(startS: number, endS: number, op: Operator | null): string {
  return `${dayOf(startS, op)}, ${clock(startS, op)} – ${clock(endS, op)}, ${spellDuration(endS - startS)}`;
}

function serviceWords(ids: string[], services: Service[]): string {
  if (ids.length === 0) return 'Any of your services';
  const names = ids
    .map((id) => services.find((s) => s.id === id)?.name)
    .filter((n): n is string => Boolean(n));
  // A service deleted since the slot went up leaves an id with no name.
  return names.length > 0 ? names.join(', ') : plural(ids.length, 'service');
}

const message = (e: unknown, fallback: string) =>
  e instanceof Error ? e.message : fallback;

// Taps cover nearly every slot anyone posts. Anything else is an exact end time.
const LENGTHS: Array<{ mins: number; label: string }> = [
  { mins: 60, label: '1 hour' },
  { mins: 90, label: '90 min' },
  { mins: 120, label: '2 hours' },
  { mins: 180, label: '3 hours' },
  { mins: 240, label: 'Half day' },
];

const DAYS_AHEAD = 7;          // today plus six, then the date field
const LIST_DAYS = 60;          // how far ahead the posted list looks

// ---------------------------------------------------------------------------

export default function PostOpening() {
  useDocumentTitle('Post an opening');
  const op = useOperator();
  const tz = op?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  const initial = useMemo(() => openingDay(tz), [tz]);

  const [date, setDate] = useState(initial.date);
  const [start, setStart] = useState(initial.start);
  const [lengthMins, setLengthMins] = useState(60);
  const [endTime, setEndTime] = useState('');
  const [useEndTime, setUseEndTime] = useState(false);

  const [services, setServices] = useState<Service[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [servicesLoading, setServicesLoading] = useState(true);
  const [servicesError, setServicesError] = useState<string | null>(null);

  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [posted, setPosted] = useState<Opening | null>(null);

  const [list, setList] = useState<Opening[] | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const startRef = useRef<HTMLInputElement>(null);

  const loadServices = useCallback(async () => {
    setServicesLoading(true); setServicesError(null);
    try {
      const { services } = await api.services();
      setServices(services.filter((s) => s.is_active !== 0));
    } catch (e) {
      setServicesError(message(e, 'Could not load your services.'));
    } finally {
      setServicesLoading(false);
    }
  }, []);

  const loadList = useCallback(async () => {
    setListLoading(true); setListError(null);
    try {
      const now = Math.floor(Date.now() / 1000);
      const { openings } = await api.openings(now, now + LIST_DAYS * 86400);
      // Only the ones put up by hand: the holes the app found belong to Today,
      // and removing one there means something different.
      setList(openings
        .filter((o) => o.source === 'posted' && o.ends_at > now)
        .sort((a, b) => a.starts_at - b.starts_at));
    } catch (e) {
      setListError(message(e, 'Could not load your posted openings.'));
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => { void loadServices(); }, [loadServices]);
  useEffect(() => { void loadList(); }, [loadList]);

  // --- the window being described ------------------------------------------
  const startsAt = start ? epochInZone(date, start, tz) : NaN;
  const endsAt = useEndTime && endTime
    ? epochInZone(date, endTime, tz)
    : startsAt + lengthMins * 60;

  const hasWindow = Number.isFinite(startsAt) && Number.isFinite(endsAt);
  const backwards = hasWindow && endsAt <= startsAt;
  const inThePast = hasWindow && startsAt < Math.floor(Date.now() / 1000);
  const windowSeconds = hasWindow && !backwards ? endsAt - startsAt : 0;

  const chosen = services.filter((s) => picked.has(s.id));
  // With nothing picked the slot is offered for any service, so the same
  // question — does anything actually fit? — is asked of the whole list.
  const against = chosen.length > 0 ? chosen : services;
  const shortest = against.length > 0
    ? against.reduce((a, b) => (a.duration_seconds <= b.duration_seconds ? a : b))
    : null;
  const tooShort = Boolean(
    windowSeconds > 0 && shortest && shortest.duration_seconds > windowSeconds,
  );

  const canPost = hasWindow && !backwards && !inThePast && !posting;

  function toggleService(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function pickLength(mins: number) {
    setLengthMins(mins);
    // The exact end time is cleared, not just ignored: leaving a stale time
    // sitting in that field while a length is selected says two things at once.
    setUseEndTime(false);
    setEndTime('');
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canPost) return;
    setPosting(true); setPostError(null);
    try {
      const ids = [...picked];
      const { opening } = await api.postOpening({
        starts_at: startsAt,
        ends_at: endsAt,
        // Left off entirely when nothing is picked: that is the "any of my
        // services" case, not an empty list of services.
        ...(ids.length > 0 ? { service_ids: ids } : {}),
      });
      setPosted(opening);
      void loadList();
    } catch (err) {
      // The server's own sentence — an overlap with a job or another opening
      // comes back as something the operator can act on. Do not paper over it.
      setPostError(message(err, 'Could not post that opening.'));
    } finally {
      setPosting(false);
    }
  }

  /** Same day, blank time: the next slot on a free afternoon is the common case. */
  function postAnother() {
    setPosted(null);
    setPostError(null);
    setStart('');
    setUseEndTime(false);
    setEndTime('');
    // The field they have to fill in is the one that gets the cursor.
    window.setTimeout(() => startRef.current?.focus(), 0);
  }

  async function remove(id: string) {
    setRemoving(id); setRemoveError(null);
    try {
      await api.cancelOpening(id);
      setList((prev) => (prev ? prev.filter((o) => o.id !== id) : prev));
      if (posted?.id === id) setPosted(null);
    } catch (e) {
      setRemoveError(message(e, 'Could not remove that opening.'));
    } finally {
      setRemoving(null);
    }
  }

  const today = todayIn(tz);
  const dayChoices = Array.from({ length: DAYS_AHEAD }, (_, i) => addDays(today, i));

  return (
    <>
      <header className="page-head">
        <Link to="/app" className="row po-back">
          <Icon name="back" size={20} stroke={1.9} />
          <span>Today</span>
        </Link>
        <h1>Post an opening</h1>
        <p className="muted po-lede">
          Put up one slot you have free. You do not need your whole schedule in
          here — a single afternoon is enough.
        </p>
      </header>

      <main className="main stack-lg">
        {posted ? (
          <Posted opening={posted} services={services} op={op}
            onAnother={postAnother} />
        ) : (
          <form className="stack-lg" onSubmit={submit}>
            {/* --- when ---------------------------------------------------- */}
            <section className="stack">
              <h2 className="po-h2">When are you free?</h2>

              <fieldset className="po-set">
                <legend className="po-legend">Day</legend>
                <div className="po-chips">
                  {dayChoices.map((iso, i) => (
                    <button key={iso} type="button" className="po-chip"
                      aria-pressed={date === iso} onClick={() => setDate(iso)}>
                      {i === 0 ? 'Today'
                        : i === 1 ? 'Tomorrow'
                          : dayChipLabel(iso, op)}
                    </button>
                  ))}
                </div>
                <label className="po-inline">
                  Another date
                  <input type="date" value={date} min={today}
                    onChange={(e) => setDate(e.target.value)} />
                </label>
              </fieldset>

              <fieldset className="po-set">
                <legend className="po-legend">Time</legend>
                <label className="po-inline">
                  Start time
                  <input type="time" required ref={startRef} value={start}
                    onChange={(e) => setStart(e.target.value)} />
                </label>

                <span className="po-sublabel" id="po-length-label">How long</span>
                <div className="po-chips" role="group" aria-labelledby="po-length-label">
                  {LENGTHS.map((l) => (
                    <button key={l.mins} type="button" className="po-chip"
                      aria-pressed={!useEndTime && lengthMins === l.mins}
                      onClick={() => pickLength(l.mins)}>
                      {l.label}
                    </button>
                  ))}
                </div>

                <label className="po-inline">
                  Or end at
                  <input type="time" value={endTime}
                    onChange={(e) => {
                      setEndTime(e.target.value);
                      setUseEndTime(Boolean(e.target.value));
                    }} />
                </label>
              </fieldset>

              <p className="po-window" aria-live="polite">
                {!hasWindow ? 'Pick a start time.'
                  : backwards ? 'That ends before it starts.'
                    : windowWords(startsAt, endsAt, op)}
              </p>
              {inThePast && !backwards && hasWindow && (
                <p className="po-warn">That time has already gone. Pick a later one.</p>
              )}
            </section>

            {/* --- services ------------------------------------------------ */}
            <section className="stack">
              <h2 className="po-h2">What you will do</h2>

              {servicesLoading && <Spinner label="Loading your services" />}
              {servicesError && <ErrorNote error={servicesError} onRetry={loadServices} />}

              {!servicesLoading && !servicesError && services.length === 0 && (
                <Empty>
                  You have no services yet. You can still post the slot — it goes
                  up as any work you do. Add services in Settings and they show up
                  here.
                </Empty>
              )}

              {!servicesLoading && !servicesError && services.length > 0 && (
                <>
                  <p className="muted po-note">
                    Pick nothing and the slot goes up for any of your services.
                  </p>
                  {services.map((s) => {
                    const on = picked.has(s.id);
                    const fits = windowSeconds === 0 || s.duration_seconds <= windowSeconds;
                    return (
                      <button key={s.id} type="button"
                        className={`pick${on ? ' on' : ''}`}
                        aria-pressed={on} onClick={() => toggleService(s.id)}>
                        <span className="box">
                          {on && <Icon name="tick" size={13} color="#fff" stroke={3.2} />}
                        </span>
                        <span className="grow stack" style={{ gap: 4 }}>
                          <span className="spread">
                            <span className="name">{s.name}</span>
                            <span className="price">
                              {s.price_cents > 0 ? money(s.price_cents, op) : ''}
                            </span>
                          </span>
                          <span className="muted">
                            {durationLabel(s.duration_seconds)}
                            {!fits && ' · longer than this slot'}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                  <p className="po-picked">
                    {chosen.length === 0
                      ? 'Nothing picked: any of your services.'
                      : `${plural(chosen.length, 'service')} picked.`}
                  </p>
                  {tooShort && shortest && (
                    <p className="po-warn">
                      {chosen.length > 0
                        ? `The shortest thing you picked, ${shortest.name}, takes ${durationLabel(shortest.duration_seconds)} — longer than this slot. You can still post it.`
                        : `Everything you offer takes longer than this slot. The shortest, ${shortest.name}, is ${durationLabel(shortest.duration_seconds)}. You can still post it.`}
                    </p>
                  )}
                </>
              )}
            </section>

            {/* --- post ---------------------------------------------------- */}
            <section className="stack">
              {postError && <div className="error">{postError}</div>}
              <button className="btn block" type="submit" disabled={!canPost}>
                {posting ? 'Posting…' : 'Post it'}
              </button>
              <p className="faint po-foot">
                It goes up straight away. You can take it down again below.
              </p>
            </section>
          </form>
        )}

        {/* --- what is already up ------------------------------------------ */}
        <section className="stack">
          <h2 className="po-h2">Your posted openings</h2>

          {listLoading && <Spinner label="Loading your openings" />}
          {listError && <ErrorNote error={listError} onRetry={loadList} />}
          {removeError && <div className="error">{removeError}</div>}

          {!listLoading && !listError && list?.length === 0 && (
            <Empty>Nothing posted yet. Anything you put up shows here.</Empty>
          )}

          {!listLoading && !listError && list && list.length > 0 && (
            <ul className="po-list">
              {list.map((o) => (
                <li key={o.id} className="po-row">
                  <div className="stack po-row-body">
                    <span className="po-row-when">{windowWords(o.starts_at, o.ends_at, op)}</span>
                    <span className="muted">
                      {serviceWords(o.service_ids, services)}
                      {o.status !== 'open' && ` · ${o.status}`}
                    </span>
                  </div>
                  <button type="button" className="btn quiet sm"
                    disabled={removing === o.id}
                    onClick={() => { void remove(o.id); }}>
                    {removing === o.id ? 'Removing…' : 'Remove'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}

// ---------------------------------------------------------------------------

/** What just went up, and the three things anyone wants next. */
function Posted({ opening, services, op, onAnother }: {
  opening: Opening;
  services: Service[];
  op: Operator | null;
  onAnother: () => void;
}) {
  const link = `/book/${opening.id}`;
  return (
    <section className="card stack po-done">
      <div className="row po-done-head">
        <span className="po-tick"><Icon name="tick" size={18} stroke={2.6} /></span>
        <h2 className="po-h2">Posted</h2>
      </div>

      <div className="stack" style={{ gap: 3 }}>
        <span className="po-row-when">{windowWords(opening.starts_at, opening.ends_at, op)}</span>
        <span className="muted">{serviceWords(opening.service_ids, services)}</span>
      </div>

      <div className="rule" />

      <div className="stack" style={{ gap: 6 }}>
        <span className="eyebrow">The page a customer books on</span>
        {/* A plain <a> carrying the whole address, not a <Link>. This is a
            link the operator is about to copy and send to somebody, so it
            has to read as the address it is — and following it leaves the
            operator shell for the customer's checkout, which is a full
            navigation either way. */}
        <a href={link} className="mono po-link">{window.location.origin}{link}</a>
        <span className="faint">Send this to anyone asking if you have anything free.</span>
      </div>

      <button type="button" className="btn ghost block" onClick={onAnother}>
        <Icon name="plus" size={18} stroke={2} /> Post another
      </button>
      <Link to="/app" className="btn quiet block">Back to Today</Link>
    </section>
  );
}
