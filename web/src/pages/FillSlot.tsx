import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  api, durationLabel, lateLabel, money, timeRange,
  type Candidate, type CreatedOffer, type Gap,
} from '../api';
import { useOperator } from '../App';
import { Empty, ErrorNote, Icon, Spinner } from '../components/ui';
import { useDocumentTitle } from '../lib/title';

const key = (c: Candidate) => `${c.kind}:${c.client_id}:${c.lead_id ?? ''}`;

export default function FillSlot() {
  useDocumentTitle('Fill this slot');
  const { gapId = '' } = useParams();
  const op = useOperator();
  const navigate = useNavigate();

  const [gap, setGap] = useState<Gap | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [offers, setOffers] = useState<CreatedOffer[] | null>(null);
  const [sent, setSent] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const { gap, candidates } = await api.candidates(gapId);
      setGap(gap);
      setCandidates(candidates);
      // Preselect the operator's wave size — the ranking already put the best first.
      setPicked(new Set(candidates.slice(0, op?.offers_per_wave ?? 3).map(key)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this slot.');
    } finally {
      setLoading(false);
    }
  }, [gapId, op?.offers_per_wave]);

  useEffect(() => { void load(); }, [load]);

  const chosen = useMemo(
    () => candidates.filter((c) => picked.has(key(c))),
    [candidates, picked],
  );

  function toggle(c: Candidate) {
    const k = key(c);
    setPicked((prev) => {
      const next = new Set(prev);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });
  }

  async function send() {
    setSending(true); setError(null);
    try {
      const res = await api.sendOffers(gapId, chosen.map((c) => ({
        kind: c.kind, client_id: c.client_id, lead_id: c.lead_id,
      })));
      if (res.offers.length === 0) {
        setError(res.reason ?? 'Nobody eligible for this slot.');
      } else {
        setOffers(res.offers);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send.');
    } finally {
      setSending(false);
    }
  }

  if (offers) {
    return <SendWave offers={offers} sent={sent} setSent={setSent} gap={gap} />;
  }

  return (
    <>
      <header className="page-head">
        <Link to="/app" className="row" style={{ gap: 8, color: 'var(--ink)', marginBottom: 8 }}>
          <Icon name="back" size={20} stroke={1.9} />
          <span style={{ fontWeight: 500 }}>Fill this slot</span>
        </Link>
        {gap && (
          <>
            <div className="slot" style={{ fontSize: 22 }}>
              {timeRange(gap.starts_at, gap.ends_at, op)}
            </div>
            <span className="muted">{durationLabel(gap.ends_at - gap.starts_at)} open</span>
          </>
        )}
      </header>

      <main className="main stack">
        {error && <ErrorNote error={error} onRetry={load} />}
        {loading && <Spinner label="Ranking your clients" />}

        {!loading && candidates.length === 0 && !error && (
          <Empty>
            Nobody fits this slot. Clients need a mobile number and SMS consent,
            and the job has to fit the time available.
          </Empty>
        )}

        {!loading && candidates.length > 0 && (
          <>
            <div className="spread">
              <span className="eyebrow">Best fits</span>
              <span className="muted">{picked.size} of {candidates.length} selected</span>
            </div>

            {candidates.map((c) => {
              const on = picked.has(key(c));
              const late = lateLabel(c.overdue_days);
              return (
                <button key={key(c)} className={`pick${on ? ' on' : ''}`} onClick={() => toggle(c)}>
                  <span className="box">
                    {on && <Icon name="tick" size={13} color="#fff" stroke={3.2} />}
                  </span>
                  <span className="grow stack" style={{ gap: 7 }}>
                    <span className="spread">
                      <span className="name">{c.first_name}</span>
                      <span className="price" style={{ color: on ? 'var(--accent)' : 'var(--muted)' }}>
                        {c.price_cents > 0 ? money(c.price_cents, op) : ''}
                      </span>
                    </span>
                    <span className="muted">{c.title}</span>
                    <span className="chips">
                      {c.reasons.map((r, i) => (
                        <span key={i} className={`chip ${chipTone(r)}`}>{r}</span>
                      ))}
                      {late && !c.reasons.some((r) => r.includes('late') || r.includes('due')) && (
                        <span className="chip neutral">{late}</span>
                      )}
                    </span>
                  </span>
                </button>
              );
            })}

            <div className="stack" style={{ marginTop: 6 }}>
              <button className="btn block" disabled={picked.size === 0 || sending} onClick={send}>
                {sending ? 'Preparing…'
                  : picked.size === 0 ? 'Select someone to send to'
                  : `Send to ${picked.size}`}
              </button>
              <p className="faint" style={{ textAlign: 'center', margin: 0 }}>
                First to confirm gets it. The rest are told it's gone.
              </p>
              {/* Nothing caught the rejection here, so a dismiss that failed
                  left an unhandled promise in the console and the operator on
                  a page that had not changed and had not said why. The error
                  box above already has a Try again next to it. */}
              <button className="btn quiet block sm" disabled={sending}
                onClick={() => {
                  void (async () => {
                    try {
                      await api.dismissGap(gapId);
                      navigate('/app');
                    } catch (e) {
                      setError(e instanceof Error ? e.message
                        : 'Could not leave this slot empty.');
                    }
                  })();
                }}>
                Leave this slot empty
              </button>
            </div>
          </>
        )}
      </main>
    </>
  );
}

function chipTone(reason: string): 'good' | 'neutral' | 'warn' {
  if (/no address|no repeat|short notice|no-show/i.test(reason)) return 'warn';
  if (/on the way|weeks late|days late|due today/i.test(reason)) return 'good';
  const mins = reason.match(/^(\d+) min extra/);
  if (mins) return Number(mins[1]) <= 8 ? 'good' : 'warn';
  return 'neutral';
}

// ---------------------------------------------------------------------------
// Handing the messages to the operator's own phone.
// ---------------------------------------------------------------------------
function SendWave({ offers, sent, setSent, gap }: {
  offers: CreatedOffer[];
  sent: Set<string>;
  setSent: (s: Set<string>) => void;
  gap: Gap | null;
}) {
  const op = useOperator();
  const isIOS = /iPad|iPhone|iPod|Macintosh/.test(navigator.userAgent);

  return (
    <>
      <header className="page-head">
        <h1 style={{ fontSize: 21 }}>Send from your phone</h1>
        <p className="muted" style={{ marginTop: 6 }}>
          Each one opens your messages app with the text ready. It arrives from
          your own number, so they know it's you.
        </p>
      </header>

      <main className="main stack">
        <div className="spread">
          <span className="eyebrow">{sent.size} of {offers.length} sent</span>
          {/* The slot these messages are about. It used to read "Expires" and
              then the second comma-separated field of a time range whose two
              ends were the same instant — which came out as a bare date and
              was not an expiry of anything. Nothing in the offer payload
              carries an expiry, so the honest thing to print is the slot. */}
          {gap && <span className="muted">{timeRange(gap.starts_at, gap.ends_at, op)}</span>}
        </div>

        {offers.map((o) => {
          const done = sent.has(o.offer_id);
          const href = isIOS ? o.send.ios : o.send.android;
          return (
            <div key={o.offer_id} className="card stack" style={{ opacity: done ? 0.72 : 1 }}>
              <div className="row">
                <div className="grow stack" style={{ gap: 2 }}>
                  <span className="name" style={{ fontSize: 15 }}>{o.first_name}</span>
                  <span className="mono muted" style={{ fontSize: 12 }}>{o.phone_e164}</span>
                </div>
                <a href={href} className={`btn sm${done ? ' quiet' : ''}`}
                  onClick={() => setSent(new Set([...sent, o.offer_id]))}>
                  {done && <Icon name="tick" size={15} color="var(--accent)" stroke={2.6} />}
                  {done ? 'Sent' : 'Send'}
                </a>
              </div>
              <div className="sms">{o.message}</div>
            </div>
          );
        })}

        <div className="notice">
          Sending this way costs you nothing and needs no setup. You can switch
          to automatic sending later in Settings.
        </div>

        <Link to="/app" className="btn ghost block">Done</Link>
      </main>
    </>
  );
}
