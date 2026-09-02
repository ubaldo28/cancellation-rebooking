import { useCallback, useEffect, useState } from 'react';
import { api, type Service, type WorkingHour } from '../api';
import { useOperator, useSession } from '../App';
import { ErrorNote, Icon, Spinner } from '../components/ui';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const toMin = (v: string) => {
  const [h = '0', m = '0'] = v.split(':');
  return Number(h) * 60 + Number(m);
};

export default function Settings() {
  const op = useOperator();
  const { refresh, signOut } = useSession();

  const [hours, setHours] = useState<Record<number, { on: boolean; start: string; end: string }>>({});
  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [w, s] = await Promise.all([api.workingHours(), api.services()]);
      const map: Record<number, { on: boolean; start: string; end: string }> = {};
      for (let d = 0; d < 7; d++) map[d] = { on: false, start: '09:00', end: '17:00' };
      for (const h of w.working_hours as WorkingHour[]) {
        map[h.weekday] = { on: true, start: hhmm(h.start_minute), end: hhmm(h.end_minute) };
      }
      setHours(map);
      setServices(s.services);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function saveHours() {
    setError(null);
    try {
      const list = Object.entries(hours)
        .filter(([, v]) => v.on)
        .map(([d, v]) => ({
          weekday: Number(d), start_minute: toMin(v.start), end_minute: toMin(v.end),
        }))
        .filter((h) => h.end_minute > h.start_minute);
      await api.setWorkingHours(list);
      await api.detectGaps(14);
      setSaved('Working hours saved.');
      setTimeout(() => setSaved(null), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    }
  }

  async function saveSetting(patch: Record<string, unknown>, label: string) {
    setError(null);
    try {
      await api.updateSettings(patch);
      await refresh();
      setSaved(label);
      setTimeout(() => setSaved(null), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    }
  }

  if (loading) return <><header className="page-head"><h1>Settings</h1></header><Spinner /></>;

  return (
    <>
      <header className="page-head"><h1>Settings</h1></header>

      <main className="main stack-lg">
        {error && <ErrorNote error={error} onRetry={load} />}
        {saved && <div className="notice">{saved}</div>}

        <section className="stack">
          <span className="eyebrow">Working hours</span>
          <p className="muted" style={{ margin: 0 }}>
            Open slots are only ever found inside these hours.
          </p>
          {DAYS.map((name, d) => {
            const h = hours[d] ?? { on: false, start: '09:00', end: '17:00' };
            return (
              <div className="card row" key={d} style={{ gap: 10, padding: 12 }}>
                <input type="checkbox" checked={h.on} style={{ width: 20, minHeight: 20 }}
                  onChange={(e) => setHours({ ...hours, [d]: { ...h, on: e.target.checked } })} />
                <span style={{ width: 38, fontWeight: 600 }}>{name}</span>
                <input type="time" value={h.start} disabled={!h.on} style={{ minHeight: 40, padding: '8px 10px' }}
                  onChange={(e) => setHours({ ...hours, [d]: { ...h, start: e.target.value } })} />
                <input type="time" value={h.end} disabled={!h.on} style={{ minHeight: 40, padding: '8px 10px' }}
                  onChange={(e) => setHours({ ...hours, [d]: { ...h, end: e.target.value } })} />
              </div>
            );
          })}
          <button className="btn block" onClick={saveHours}>Save working hours</button>
        </section>

        <section className="stack">
          <span className="eyebrow">Filling slots</span>

          <label className="card" style={{ padding: 14 }}>
            How many people to ask at once
            <input type="number" min={1} max={10} defaultValue={op?.offers_per_wave ?? 3}
              onBlur={(e) => saveSetting({ offers_per_wave: Number(e.target.value) }, 'Saved.')} />
            <span className="faint">First to confirm gets the slot.</span>
          </label>

          <label className="card" style={{ padding: 14 }}>
            Most extra driving you will accept
            <select defaultValue={String(op?.max_detour_seconds ?? 900)}
              onChange={(e) => saveSetting({ max_detour_seconds: Number(e.target.value) }, 'Saved.')}>
              <option value="300">5 minutes</option>
              <option value="600">10 minutes</option>
              <option value="900">15 minutes</option>
              <option value="1800">30 minutes</option>
              <option value="3600">an hour</option>
            </select>
            <span className="faint">
              Anyone further out of your way than this is never offered the slot.
            </span>
          </label>

          <label className="card" style={{ padding: 14 }}>
            Gap in the day worth filling
            <select defaultValue={String(op?.min_gap_seconds ?? 3600)}
              onChange={(e) => saveSetting({ min_gap_seconds: Number(e.target.value) }, 'Saved.')}>
              <option value="1800">30 minutes or more</option>
              <option value="3600">1 hour or more</option>
              <option value="7200">2 hours or more</option>
            </select>
          </label>

          <label className="card" style={{ padding: 14 }}>
            Discount on a last-minute slot
            <select defaultValue={String(op?.discount_percent ?? 0)}
              onChange={(e) => saveSetting({ discount_percent: Number(e.target.value) }, 'Saved.')}>
              <option value="0">No discount</option>
              <option value="10">10% off</option>
              <option value="15">15% off</option>
              <option value="20">20% off</option>
            </select>
            <span className="faint">
              Discounting every time trains people to wait for one.
            </span>
          </label>
        </section>

        <section className="stack">
          <span className="eyebrow">Services</span>
          {services.length === 0 && (
            <p className="muted" style={{ margin: 0 }}>
              No services yet. A service sets how long a job takes and how often
              it repeats — that is what decides who is due.
            </p>
          )}
          {services.map((s) => (
            <div className="card spread" key={s.id}>
              <div className="stack" style={{ gap: 2 }}>
                <span className="name" style={{ fontSize: 15 }}>{s.name}</span>
                <span className="muted">
                  {Math.round(s.duration_seconds / 60)} min
                  {s.cadence_days ? ` · every ${Math.round(s.cadence_days / 7)} weeks` : ' · does not repeat'}
                </span>
              </div>
            </div>
          ))}
          <AddService onDone={load} />
        </section>

        <section className="stack">
          <span className="eyebrow">Account</span>
          <div className="card stack" style={{ gap: 4 }}>
            <span className="name" style={{ fontSize: 15 }}>{op?.business_name}</span>
            <span className="muted">{op?.email}</span>
            <span className="muted">{op?.country} · {op?.timezone} · {op?.currency}</span>
          </div>
          <button className="btn quiet block" onClick={signOut}>Sign out</button>
        </section>
      </main>
    </>
  );
}

function AddService({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [mins, setMins] = useState('120');
  const [price, setPrice] = useState('');
  const [weeks, setWeeks] = useState('4');
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button className="btn ghost block" onClick={() => setOpen(true)}>
        <Icon name="plus" size={18} stroke={2} /> Add a service
      </button>
    );
  }

  return (
    <form className="card stack" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      try {
        await api.createService({
          name,
          duration_seconds: Number(mins) * 60,
          price_cents: price ? Math.round(Number(price) * 100) : 0,
          cadence_days: weeks ? Number(weeks) * 7 : undefined,
        });
        setOpen(false); setName(''); setPrice('');
        onDone();
      } finally { setBusy(false); }
    }}>
      <label>Name<input required value={name} onChange={(e) => setName(e.target.value)}
        placeholder="Full detail" /></label>
      <div className="field-row">
        <label>Minutes<input type="number" min="15" step="15" value={mins}
          onChange={(e) => setMins(e.target.value)} /></label>
        <label>Price<input type="number" step="0.01" value={price}
          onChange={(e) => setPrice(e.target.value)} /></label>
      </div>
      <label>Repeats every (weeks, blank if never)
        <input type="number" min="0" value={weeks} onChange={(e) => setWeeks(e.target.value)} />
      </label>
      <div className="field-row">
        <button type="button" className="btn quiet" onClick={() => setOpen(false)}>Cancel</button>
        <button className="btn" type="submit" disabled={busy || !name.trim()}>
          {busy ? 'Saving…' : 'Add'}
        </button>
      </div>
    </form>
  );
}
