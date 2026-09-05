import { useCallback, useEffect, useId, useState } from 'react';
import {
  api, ApiError, clockTime, shortDate,
  type FeesResponse, type PartsQuote, type QuotableBooking,
} from '../api';
import { useOperator } from '../App';
import { formatMoney } from '../lib/format';
import JobProof from './JobProof';
import { ErrorNote, RedactionNotice } from './ui';
import '../styles-parts.css';

/**
 * The operator's booked jobs, and the three things they do to one.
 *
 * "I'm here", "send a parts quote" and "cancel" live together on purpose. They
 * are the three taps that happen on a doorstep, in that order or instead of
 * each other, and splitting them across screens is what makes an operator
 * standing in a driveway give up and phone the customer instead — which is the
 * exact behaviour this product cannot allow.
 */

export default function JobsPanel() {
  const op = useOperator();
  const [jobs, setJobs] = useState<QuotableBooking[]>([]);
  const [quotes, setQuotes] = useState<PartsQuote[]>([]);
  const [fees, setFees] = useState<FeesResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [b, q, f] = await Promise.all([
        api.quotableBookings(), api.partsQuotes(), api.fees(),
      ]);
      setJobs(b.bookings); setQuotes(q.quotes); setFees(f);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your jobs.');
    } finally { setLoaded(true); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (!loaded) return null;

  const upcoming = jobs.filter((j) => j.starts_at > Math.floor(Date.now() / 1000) - 86400);

  return (
    <section className="stack">
      {/* The block comes first because it is the answer to "why are my
          openings gone", and an operator who has to hunt for that answer
          decides the platform is broken rather than that they owe money. */}
      {fees?.blocked && (
        <div className="notice warn">
          <strong>Your openings are paused.</strong> {fees.blocked}
        </div>
      )}

      {/* With a retry, like every other failed load in the app: all three
          requests behind this panel are read-only, so trying again is free
          and is the only thing an operator can usefully do about it. */}
      {error && <ErrorNote error={error} onRetry={load} />}

      {upcoming.length > 0 && (
        <>
          <div className="feed-head">
            <span className="muted">Your booked jobs</span>
          </div>
          {upcoming.map((j) => (
            <JobRow key={j.id} job={j} op={op} onChange={load}
              quotes={quotes.filter((q) => q.order_item_id === j.id)} />
          ))}
        </>
      )}
    </section>
  );
}

function JobRow(
  { job, op, quotes, onChange }: {
    job: QuotableBooking;
    op: ReturnType<typeof useOperator>;
    quotes: PartsQuote[];
    onChange: () => void;
  },
) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  // Every booked job renders one of these forms, so the id the description
  // field points at has to be unique per row rather than a constant.
  const redactionId = useId();

  const [desc, setDesc] = useState('');
  const [parts, setParts] = useState('');
  const [labour, setLabour] = useState('');
  const [code, setCode] = useState('');
  const started = job.code_verified_at != null;

  const live = quotes.find((q) => q.status === 'sent') ?? null;
  const arrived = job.arrived_at != null;

  // The same ladder the Worker applies, so the warning and the charge agree.
  // Half inside 48 hours; all of it once they have marked that they arrived.
  const hoursOut = (job.starts_at - Date.now() / 1000) / 3600;
  const cancelFee = arrived
    ? Math.max(1500, job.price_cents)
    : hoursOut <= 48
      ? Math.max(1500, Math.round(job.price_cents / 2))
      : 0;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(null);
    try { await fn(); onChange(); }
    catch (e) {
      setErr(e instanceof ApiError ? e.message : 'That did not go through.');
    } finally { setBusy(false); }
  };

  return (
    <article className="feed-row">
      <div className="feed-top">
        <span className="chip good">{job.guest_name ?? 'Customer'}</span>
        <span className="feed-ago mono">
          {shortDate(job.starts_at, op)} · {clockTime(job.starts_at, op)}
        </span>
      </div>

      <div className="name">{job.services ?? 'Booked job'}</div>
      <div className="muted">
        {formatMoney(job.price_cents, job.currency)}
        {job.parts_cents > 0
          && <> · {formatMoney(job.parts_cents, job.currency)} parts approved</>}
      </div>

      {live && (
        <div className="muted" style={{ marginTop: 6 }}>
          Waiting on them: {live.description} — {formatMoney(live.total_cents, live.currency)}
          {' '}
          <button className="btn ghost sm" type="button" disabled={busy}
            onClick={() => void run(() => api.withdrawPartsQuote(live.id))}>
            Take it back
          </button>
        </div>
      )}

      {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}

      {/* The code the customer reads out. This is the only moment the platform
          knows these two people are standing together, so it is the first
          thing on the row once the operator is on site — not buried behind a
          menu they will skip. */}
      {!started && !confirmCancel && (
        <form className="code-entry" onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api.verifyStartCode(job.id, code);
            setCode('');
          });
        }}>
          <label>
            Their 4-digit code
            <input inputMode="numeric" pattern="[0-9]*" maxLength={4} value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
              placeholder="••••" />
          </label>
          <button className="btn sm" type="submit" disabled={busy || code.length !== 4}>
            {busy ? 'Checking…' : 'Start job'}
          </button>
        </form>
      )}

      {started && (
        <div className="muted" style={{ marginTop: 6 }}>
          Started {clockTime(job.code_verified_at!, op)} — code checked.
        </div>
      )}

      {!quoting && !confirmCancel && (
        <div className="field-row" style={{ marginTop: 10 }}>
          {/* "I'm here" is the same tap that tells the customer the van
              arrived, so it is not a button an operator can quietly skip
              without the customer noticing and asking. Entering the code sets
              it too, so this is only for arriving before they answer. */}
          <button className="btn sm" type="button" disabled={busy || arrived}
            onClick={() => void run(() => api.markArrived(job.id))}>
            {arrived ? `Arrived ${clockTime(job.arrived_at!, op)}` : "I'm here"}
          </button>
          <button className="btn quiet sm" type="button" disabled={busy || !!live}
            onClick={() => setQuoting(true)}>
            {live ? 'Quote sent' : 'Send a parts quote'}
          </button>
          <button className="btn ghost sm" type="button" disabled={busy}
            onClick={() => setConfirmCancel(true)}>
            Cancel
          </button>
        </div>
      )}

      {quoting && (
        <form className="stack" style={{ marginTop: 10 }} onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api.sendPartsQuote({
              order_item_id: job.id,
              description: desc.trim(),
              parts_cents: parts ? Math.round(Number(parts) * 100) : 0,
              labor_cents: labour ? Math.round(Number(labour) * 100) : 0,
            });
            setQuoting(false); setDesc(''); setParts(''); setLabour('');
          });
        }}>
          {/* Before the box, not after the send. The Worker runs the chat
              filter over this description and says nothing when it takes
              something out, so an operator who types "call me on ..." here
              would watch it arrive at the customer with a hole in it and no
              explanation. */}
          <RedactionNotice id={redactionId} />
          <label>
            What the parts are
            <input required value={desc} maxLength={300}
              onChange={(e) => setDesc(e.target.value)}
              aria-describedby={redactionId}
              placeholder="Front pads and rotors, ceramic" />
          </label>
          <div className="field-row">
            <label>
              Parts
              <input type="number" min="0" step="0.01" value={parts}
                onChange={(e) => setParts(e.target.value)} placeholder="180.00" />
            </label>
            <label>
              Extra labour (optional)
              <input type="number" min="0" step="0.01" value={labour}
                onChange={(e) => setLabour(e.target.value)} placeholder="0.00" />
            </label>
          </div>
          <p className="faint" style={{ margin: 0 }}>
            They see this in their messages and nothing is charged until they
            approve it. Sending a new quote replaces any you have waiting.
          </p>
          <div className="field-row">
            <button className="btn quiet sm" type="button"
              onClick={() => setQuoting(false)}>Back</button>
            <button className="btn sm" type="submit" disabled={busy || !desc.trim()}>
              {busy ? 'Sending…' : 'Send it'}
            </button>
          </div>
        </form>
      )}

      {/* Photos live on the row itself. An operator who has to go and find a
          different screen to take a "before" shot does not take one. */}
      {(arrived || started) && !confirmCancel && (
        <JobProof orderItemId={job.id} />
      )}

      {confirmCancel && (
        <div className="stack" style={{ marginTop: 10 }}>
          {/* Said before the tap, not after. An operator who finds out about
              the fee from a charge rather than from a warning is right to be
              angry, and the fee only works if it changes behaviour — which it
              cannot do if nobody knows about it until afterwards. */}
          {/* The actual number for this job at this moment, not the rule that
              produces it. An operator doing percentage arithmetic on a
              driveway is an operator who taps the button and finds out
              afterwards. */}
          <p style={{ margin: 0 }}>
            Cancel this job? The customer is refunded in full, whenever it
            happens.{' '}
            {cancelFee > 0 ? (
              <>
                <strong>This one costs you {formatMoney(cancelFee, job.currency)}</strong>
                {arrived
                  ? ' — you have already marked that you arrived, so it is the '
                    + 'whole job'
                  : hoursOut <= 12
                    ? ' — it starts within 12 hours, so it is three quarters of it'
                    : ' — it starts within 48 hours, so it is a quarter of it'}
                . It comes out of your next payout, and your openings stay down
                until it is settled.
              </>
            ) : (
              <>
                <strong>This one is free.</strong> It is more than 48 hours away,
                so there is nothing to pay.
              </>
            )}
          </p>
          <div className="field-row">
            <button className="btn quiet sm" type="button"
              onClick={() => setConfirmCancel(false)}>Keep it</button>
            <button className="btn ghost sm" type="button" disabled={busy}
              onClick={() => void run(async () => {
                await api.cancelBooking(job.id);
                setConfirmCancel(false);
              })}>
              {busy ? 'Cancelling…' : 'Cancel the job'}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}
