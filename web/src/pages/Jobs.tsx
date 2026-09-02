import { useCallback, useEffect, useState } from 'react';
import { api, money, type Client, type Lead } from '../api';
import { useOperator } from '../App';
import { Empty, ErrorNote, Icon, Spinner } from '../components/ui';

const URGENCY = ['', 'Whenever', 'Soon', 'Normal', 'Urgent', 'Urgent'];

export default function Jobs() {
  const op = useOperator();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [l, c] = await Promise.all([api.leads('open'), api.clients()]);
      setLeads(l.leads);
      setClients(c.clients);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load jobs.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const total = leads.reduce((sum, l) => sum + (l.quoted_price_cents ?? 0), 0);

  return (
    <>
      <header className="page-head">
        <div className="spread">
          <h1>Open jobs</h1>
          {total > 0 && (
            <span className="mono" style={{ fontWeight: 600, color: 'var(--accent)' }}>
              {money(total, op)}
            </span>
          )}
        </div>
        <p className="muted" style={{ marginTop: 6 }}>
          Work you quoted that nobody has booked. These fill a slot when no one
          is due a repeat visit.
        </p>
      </header>

      <main className="main stack">
        {error && <ErrorNote error={error} onRetry={load} />}
        {loading && <Spinner />}

        {!loading && leads.length === 0 && !error && (
          <Empty>
            Nothing open. Log a quote whenever someone says "maybe later" — that
            is what you offer when a slot opens up.
          </Empty>
        )}

        {!loading && leads.map((l) => {
          const blocked = l.parts_required === 1 && l.parts_ready === 0;
          return (
            <div className="card stack" key={l.id} style={{ opacity: blocked ? 0.55 : 1, gap: 10 }}>
              <div className="spread" style={{ alignItems: 'flex-start' }}>
                <div className="grow stack" style={{ gap: 3 }}>
                  <span className="name" style={{ fontSize: 15, lineHeight: 1.3 }}>{l.title}</span>
                  <span className="muted" style={{ fontSize: 12.5 }}>
                    {l.first_name} {l.last_name ?? ''}
                  </span>
                </div>
                {l.quoted_price_cents != null && (
                  <span className="price" style={{ fontSize: 15 }}>
                    {money(l.quoted_price_cents, op)}
                  </span>
                )}
              </div>
              <div className="chips">
                <span className={`chip ${l.urgency >= 4 ? 'warn' : 'neutral'}`}>
                  {URGENCY[l.urgency] ?? 'Normal'}
                </span>
                <span className={`chip ${blocked ? 'warn' : 'good'}`}>
                  {blocked ? 'Waiting on parts' : 'Ready to go'}
                </span>
              </div>
            </div>
          );
        })}

        <button className="btn ghost block" onClick={() => setAdding(true)}>
          <Icon name="plus" size={18} stroke={2} /> Log a quote
        </button>
      </main>

      {adding && (
        <AddLead clients={clients} onClose={() => setAdding(false)}
          onDone={async () => { setAdding(false); await load(); }} />
      )}
    </>
  );
}

function AddLead({ clients, onClose, onDone }: {
  clients: Client[]; onClose: () => void; onDone: () => void;
}) {
  const [form, setForm] = useState({
    client_id: clients[0]?.id ?? '', title: '', quoted_price: '',
    hours: '1', urgency: '2', parts_required: false, parts_ready: true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.createLead({
        client_id: form.client_id,
        title: form.title,
        quoted_price_cents: form.quoted_price ? Math.round(Number(form.quoted_price) * 100) : undefined,
        estimated_duration_seconds: Math.round(Number(form.hours) * 3600),
        urgency: Number(form.urgency),
        parts_required: form.parts_required,
        parts_ready: form.parts_ready,
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(28,26,23,0.4)',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 50,
    }} onClick={onClose}>
      <form className="stack" onClick={(e) => e.stopPropagation()} onSubmit={submit}
        style={{
          background: 'var(--bg)', width: '100%', maxWidth: 520,
          borderRadius: '16px 16px 0 0', padding: 20, maxHeight: '90vh', overflowY: 'auto',
        }}>
        <div className="spread">
          <h2>Log a quote</h2>
          <button type="button" className="btn quiet sm" onClick={onClose}>Close</button>
        </div>

        {error && <div className="error">{error}</div>}

        {clients.length === 0 ? (
          <p className="muted">Add a client first — a quote has to belong to someone.</p>
        ) : (
          <>
            <label>Client
              <select value={form.client_id}
                onChange={(e) => setForm({ ...form, client_id: e.target.value })}>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>{c.first_name} {c.last_name ?? ''}</option>
                ))}
              </select>
            </label>

            <label>What is the job
              <input required value={form.title} placeholder="Deep clean two bins"
                onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </label>

            <div className="field-row">
              <label>Price
                <input type="number" step="0.01" value={form.quoted_price}
                  onChange={(e) => setForm({ ...form, quoted_price: e.target.value })} />
              </label>
              <label>Hours
                <input type="number" step="0.25" min="0.25" value={form.hours}
                  onChange={(e) => setForm({ ...form, hours: e.target.value })} />
              </label>
            </div>

            <label>How urgent
              <select value={form.urgency}
                onChange={(e) => setForm({ ...form, urgency: e.target.value })}>
                <option value="1">Whenever</option>
                <option value="2">Soon</option>
                <option value="4">Urgent</option>
              </select>
            </label>

            <label style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <input type="checkbox" checked={form.parts_required} style={{ width: 20, minHeight: 20 }}
                onChange={(e) => setForm({
                  ...form, parts_required: e.target.checked,
                  parts_ready: e.target.checked ? false : true,
                })} />
              <span style={{ color: 'var(--ink)' }}>Needs parts or materials I don't have yet</span>
            </label>

            <button className="btn block" type="submit" disabled={busy || !form.title.trim()}>
              {busy ? 'Saving…' : 'Log it'}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
