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
      // Cleared on the way through, not only set on the way out: this reloads
      // after every action on a row, and without this a failure from an hour
      // ago sat above a panel that had since loaded perfectly well.
      setError(null);
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

/**
 * The three rungs of the cancellation ladder, and which one this job is on.
 *
 * These mirror leadFeeCents and feeFor in src/lib/bypass.ts exactly, because
 * the number below the warning is a number the operator is about to be charged
 * and the two must be the same. Before this the panel worked out half the price
 * for anything inside 48 hours while the sentence beside it said "three
 * quarters" under twelve hours and "a quarter" over — so whichever the operator
 * read, one of the two was wrong, and neither matched the charge.
 *
 * Arrival first and it is the only rung that reaches the whole job: somebody
 * who drove there and left has done the worst version of this, whatever the
 * clock says. A job already past its start with nobody having arrived falls
 * through to the twelve-hour rung, which is where a negative hoursOut lands.
 */
type CancelRung = 'none' | 'late' | 'last_hours' | 'on_arrival';

function cancelRung(arrived: boolean, hoursOut: number): CancelRung {
  if (arrived) return 'on_arrival';
  if (hoursOut <= 12) return 'last_hours';
  if (hoursOut <= 48) return 'late';
  return 'none';
}

/**
 * What that rung costs, in cents.
 *
 * The floor lifts a small fee to something worth collecting and is capped at
 * the job, so a $10 job cancelled on the doorstep costs $10 rather than the $15
 * the floor alone would make of it — and a job with no price costs nothing at
 * all, because there is no introduction to charge for. All three of those are
 * the Worker's rules; the panel used to apply the floor to a free job and quote
 * $15 for a cancellation that is never billed.
 */
const LEAD_FEE_MIN_CENTS = 15_00;
const FEE_PERCENT: Record<Exclude<CancelRung, 'none'>, number> = {
  late: 25, last_hours: 75, on_arrival: 100,
};

function leadFeeCents(jobCents: number, rung: CancelRung): number {
  if (rung === 'none') return 0;
  const job = Math.max(0, Math.round(jobCents));
  if (job === 0) return 0;
  return Math.min(job, Math.max(
    LEAD_FEE_MIN_CENTS, Math.round((job * FEE_PERCENT[rung]) / 100)));
}

/**
 * Why the fee is the number it is, in one clause that continues "This one costs
 * you £x".
 *
 * The fraction is only ever named when the fraction is what produced the
 * figure. On a small job it is not: three quarters of a $10 job is $7.50, the
 * floor lifts it to $15 and the cap brings it back to $10 — so the operator was
 * being shown the whole price of the job under a sentence saying it was three
 * quarters of it. An operator who does that arithmetic and finds it does not
 * work stops believing the rest of the warning, which is the part that is
 * meant to change what they do.
 */
function whyThisFee(
  rung: Exclude<CancelRung, 'none'>, jobCents: number, feeCents: number,
  currency: string,
): string {
  if (rung === 'on_arrival') {
    return 'you have already marked that you arrived, so it is the whole job';
  }
  const share = Math.round((jobCents * FEE_PERCENT[rung]) / 100);
  const when = rung === 'last_hours' ? 'within 12 hours' : 'within 48 hours';
  const fraction = rung === 'last_hours' ? 'three quarters' : 'a quarter';
  if (feeCents === share) return `it starts ${when}, so it is ${fraction} of it`;
  if (feeCents === jobCents) {
    return `it starts ${when}, and ${fraction} of this job is under the `
      + `${formatMoney(LEAD_FEE_MIN_CENTS, currency)} minimum — a fee never goes `
      + 'above the job itself, so it is the whole of it';
  }
  return `it starts ${when}, and ${fraction} of this job is under the `
    + `${formatMoney(LEAD_FEE_MIN_CENTS, currency)} minimum fee`;
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

  const hoursOut = (job.starts_at - Date.now() / 1000) / 3600;
  const rung = cancelRung(arrived, hoursOut);
  const cancelFee = leadFeeCents(job.price_cents, rung);

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
            {cancelFee > 0 && rung !== 'none' ? (
              <>
                <strong>This one costs you {formatMoney(cancelFee, job.currency)}</strong>
                {` — ${whyThisFee(rung, job.price_cents, cancelFee, job.currency)}`}
                . It comes out of your next payout, and your openings stay down
                until it is settled.
              </>
            ) : rung === 'none' ? (
              <>
                <strong>This one is free.</strong> It is more than 48 hours away,
                so there is nothing to pay.
              </>
            ) : (
              // A job with no price on it. The rung is a charging one and the
              // fee is still nothing, so saying "more than 48 hours away" here
              // would be plainly false to an operator cancelling on a doorstep.
              <>
                <strong>This one is free.</strong> There is no price on this
                job, so there is nothing to take a share of.
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
