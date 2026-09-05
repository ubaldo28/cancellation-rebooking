import { useCallback, useEffect, useState } from 'react';
import { api, lateLabel, shortDate, type Client, type Service } from '../api';
import { useOperator } from '../App';
import Sheet from '../components/Sheet';
import { Empty, ErrorNote, Icon, Spinner, initials } from '../components/ui';
import { useDocumentTitle } from '../lib/title';

type Filter = 'late' | 'all' | 'no_consent';

export default function Clients() {
  useDocumentTitle('Clients');
  const op = useOperator();
  const [filter, setFilter] = useState<Filter>('late');
  const [clients, setClients] = useState<Client[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [c, s] = await Promise.all([api.clients(), api.services()]);
      setClients(c.clients);
      setServices(s.services);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load clients.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const now = Math.floor(Date.now() / 1000);
  const days = (c: Client) =>
    c.next_due_at === null ? null : Math.floor((now - c.next_due_at) / 86400);

  const shown = clients.filter((c) => {
    if (filter === 'no_consent') return c.sms_consent === 0 || c.opted_out_at !== null;
    if (filter === 'late') {
      const d = days(c);
      return d !== null && d >= 0;
    }
    return true;
  });

  const lateCount = clients.filter((c) => { const d = days(c); return d !== null && d >= 0; }).length;
  const noConsent = clients.filter((c) => c.sms_consent === 0 || c.opted_out_at !== null).length;

  return (
    <>
      <header className="page-head">
        <div className="spread">
          <h1>Clients</h1>
          <span className="muted">{clients.length}</span>
        </div>
      </header>

      <main className="main stack">
        <div className="chips">
          <Tab on={filter === 'late'} onClick={() => setFilter('late')}>Late {lateCount}</Tab>
          <Tab on={filter === 'all'} onClick={() => setFilter('all')}>All</Tab>
          <Tab on={filter === 'no_consent'} onClick={() => setFilter('no_consent')}>
            No consent {noConsent}
          </Tab>
        </div>

        {error && <ErrorNote error={error} onRetry={load} />}
        {loading && <Spinner />}

        {!loading && shown.length === 0 && (
          <Empty>
            {clients.length === 0
              ? 'No clients yet. Add the people you already work for — that list is what fills your empty slots.'
              : 'Nobody in this group.'}
          </Empty>
        )}

        {!loading && shown.map((c) => {
          const d = days(c);
          const late = lateLabel(d);
          const hot = d !== null && d >= 14;
          const blocked = c.sms_consent === 0 || c.opted_out_at !== null;
          const service = services.find((s) => s.id === c.default_service_id);
          return (
            <div className="card row" key={c.id} style={{ opacity: blocked ? 0.6 : 1 }}>
              <span className={`avatar${hot ? ' hot' : ''}`}>
                {initials(c.first_name, c.last_name)}
              </span>
              <div className="grow stack" style={{ gap: 3 }}>
                <span className="name" style={{ fontSize: 15 }}>
                  {c.first_name} {c.last_name ?? ''}
                </span>
                <span className="muted" style={{ fontSize: 12.5 }}>
                  {service
                    ? `${service.name}${service.cadence_days ? `, every ${Math.round(service.cadence_days / 7)} wks` : ''}`
                    : 'No repeat set'}
                  {c.last_serviced_at ? ` · last done ${shortDate(c.last_serviced_at, op)}` : ''}
                </span>
              </div>
              {blocked
                ? <span className="chip neutral">{c.opted_out_at ? 'opted out' : 'no consent'}</span>
                : late && <span className={`chip ${hot ? 'warn' : 'neutral'}`}>{late}</span>}
            </div>
          );
        })}

        <button className="btn ghost block" onClick={() => setAdding(true)}>
          <Icon name="plus" size={18} stroke={2} /> Add a client
        </button>
      </main>

      {adding && (
        <AddClient services={services} onClose={() => setAdding(false)}
          onDone={async () => { setAdding(false); await load(); }} />
      )}
    </>
  );
}

const Tab = ({ on, onClick, children }: {
  on: boolean; onClick: () => void; children: React.ReactNode;
}) => (
  <button onClick={onClick} className="chip"
    style={{
      minHeight: 44, padding: '0 14px', cursor: 'pointer', border: 0,
      background: on ? 'var(--ink)' : 'var(--surface)',
      color: on ? '#fff' : 'var(--muted)',
      boxShadow: on ? 'none' : 'inset 0 0 0 1px var(--line)',
      fontWeight: on ? 600 : 500,
    }}>
    {children}
  </button>
);

function AddClient({ services, onClose, onDone }: {
  services: Service[]; onClose: () => void; onDone: () => void;
}) {
  const [form, setForm] = useState({
    first_name: '', last_name: '', phone_e164: '', postcode: '',
    address_line: '', default_service_id: services[0]?.id ?? '', language: '',
    sms_consent: true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.createClient({
        ...form,
        default_service_id: form.default_service_id || undefined,
        language: form.language || undefined,
        sms_consent: form.sms_consent,
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Add a client" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {error && <div className="error">{error}</div>}

        <div className="field-row">
          <label>First name<input required value={form.first_name} onChange={set('first_name')} /></label>
          <label>Last name<input value={form.last_name} onChange={set('last_name')} /></label>
        </div>

        <label>Mobile number
          <input type="tel" value={form.phone_e164} onChange={set('phone_e164')}
            placeholder="Their mobile" />
        </label>

        <div className="field-row">
          <label>Postcode<input value={form.postcode} onChange={set('postcode')} /></label>
          <label>Address<input value={form.address_line} onChange={set('address_line')} /></label>
        </div>

        <label>Usual service
          <select value={form.default_service_id} onChange={set('default_service_id')}>
            <option value="">None</option>
            {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>

        <label>Language for their texts
          <select value={form.language} onChange={set('language')}>
            <option value="">Same as yours</option>
            <option value="en">English</option>
            <option value="es">Spanish</option>
          </select>
        </label>

        <label style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <input type="checkbox" checked={form.sms_consent} style={{ width: 20, minHeight: 20 }}
            onChange={(e) => setForm({ ...form, sms_consent: e.target.checked })} />
          <span style={{ color: 'var(--ink)' }}>They agreed to receive texts</span>
        </label>
        <p className="faint" style={{ margin: 0 }}>
          Without this they will never be offered a slot. Texting people who did
          not agree is what gets your number blocked.
        </p>

        <button className="btn block" type="submit" disabled={busy || !form.first_name.trim()}>
          {busy ? 'Saving…' : 'Add client'}
        </button>
      </form>
    </Sheet>
  );
}
