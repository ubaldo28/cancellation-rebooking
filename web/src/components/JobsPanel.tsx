import { useCallback, useEffect, useId, useState } from 'react';
import {
  api, ApiError, clockTime, localeFor, shortDate,
  type Appointment, type ConnectStatus, type FeesResponse, type LeadFee,
  type PartsQuote, type QuotableBooking,
} from '../api';
import { useOperator } from '../App';
import { formatMoney } from '../lib/format';
import { onDay } from '../lib/money';
import JobProof from './JobProof';
import { ErrorNote, RedactionNotice } from './ui';
import '../styles-parts.css';

/**
 * How far back the statement of what each job paid reaches.
 *
 * Ninety days rather than the fortnight the appointments route would default
 * to, because the line an operator comes looking for is the one that has NOT
 * been sent yet. A business that never finished its payout setup can have a
 * month of finished work sitting waiting, and a window that drops those off
 * the bottom of the screen is the app quietly telling somebody they were never
 * owed the money.
 */
const STATEMENT_DAYS = 90;

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
  /**
   * Whether this business can actually be paid right now.
   *
   * Part of the money panel rather than decoration: settleOrder skips a
   * business with no connected account and leaves its share sitting in the
   * platform balance, so "payouts are not switched on" is the difference
   * between money that is on its way and money that is stuck waiting on
   * something only the operator can finish.
   */
  const [connect, setConnect] = useState<ConnectStatus | null>(null);
  /**
   * The jobs behind the payouts: everything that has already happened.
   *
   * Null is "this did not load", which is why it is not an empty array. An
   * empty statement and a failed one look the same on the screen and mean
   * opposite things to somebody checking whether they have been paid, so the
   * two have to be tellable apart here in order to be said apart down there.
   */
  const [past, setPast] = useState<Appointment[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const t = Math.floor(Date.now() / 1000);
      const [b, q, f, c, p] = await Promise.all([
        api.quotableBookings(), api.partsQuotes(), api.fees(),
        // Caught on its own, because this one is the least important request
        // on the panel and the other three are what an operator opened it for.
        // A failure here costs one sentence about payouts; failing the whole
        // panel would cost them the buttons they are standing on a driveway to
        // press.
        api.stripeAccount().then((r) => r.connect).catch(() => null),
        // Same bargain, and the same reason. The statement of what each
        // finished job paid is worth a great deal to an operator sitting down
        // on a Sunday and nothing at all to one standing in a driveway, so it
        // must not be able to take the doorstep buttons down with it.
        api.appointments(t - STATEMENT_DAYS * 86400, t)
          .then((r) => r.appointments).catch(() => null),
      ]);
      setJobs(b.bookings); setQuotes(q.quotes); setFees(f); setConnect(c); setPast(p);
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

      {/* Then the money, above the jobs it is made of. An operator's first
          question about this product is "when do I get paid", their second is
          "what is this charge", and until now the app answered neither — the
          only thing it said about money was the fee warning on the cancel
          button, which is a bill with no statement behind it. */}
      {fees && (
        <MoneyPanel fees={fees} connect={connect} locale={localeFor(op)}
          past={past} currency={op?.currency ?? null} />
      )}

      {/* With a retry, like every other failed load in the app: every request
          behind this panel is read-only, so trying again is free and is the
          only thing an operator can usefully do about it. */}
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
 * Why a fee was raised, in words an operator can check against their own week.
 *
 * The rungs are the ones in src/lib/bypass.ts and they are named by what the
 * operator did rather than by the rung's internal label, because a line reading
 * "cancelled_last_hours" beside a charge is a code, and somebody trying to work
 * out what they are being billed for should not have to decode one.
 *
 * Deliberately a plain string map with a fallback rather than a Record keyed on
 * the union: the Worker owns that list and may add to it, and a reason this
 * bundle has not heard of should print something honest instead of nothing at
 * all under a number somebody is being charged.
 */
const FEE_REASONS: Record<string, string> = {
  cancelled_late: 'You cancelled a job 12 to 48 hours before it started',
  cancelled_last_hours: 'You cancelled a job inside the last 12 hours',
  cancelled_on_arrival: 'You cancelled after marking that you had arrived',
  no_show: 'A booking recorded as a no-show',
};

/**
 * WHERE THE BUSINESS'S MONEY IS: when it arrives, and what is coming off it.
 *
 * WHY THIS PANEL EXISTS. Everything about money on this side of the product was
 * a warning until now — the fee sentence on the cancel button — and an operator
 * who only ever hears about money when they are being charged for something
 * concludes the platform is taking their money rather than sending it. The
 * statement has to sit beside the bill.
 *
 * WHAT IT DELIBERATELY DOES NOT DO IS ARITHMETIC. Every figure below is one the
 * Worker sent: `fees.owed.amount` is formatted by the Worker in the operator's
 * own locale and printed exactly as it arrives, and each fee's amount and how
 * much of it a payout has already covered are columns on the row. Nothing here
 * works out a share, a percentage or a payout — a figure quoted by a browser
 * that disagrees with the transfer by a cent is a support ticket that costs
 * more than the cent, which is the same reason splitOrder lives in one file on
 * the Worker.
 *
 * WHAT IT NOW SAYS PER JOB, AND WHERE THAT CAME FROM. The columns recording
 * what Round The Way kept from a finished job and what was sent on to the
 * business — order_items.fee_cents, transfer_id and transferred_at — have been
 * written by settleOrder all along, and for a long time no route handed them to
 * a browser, so this panel could only say when a payout goes in general and
 * sent somebody to their bank statement for the figure. /api/appointments
 * carries them now, so the jobs are listed below with what each one paid. The
 * one piece of arithmetic is the share itself, price minus fee, off a single
 * row — everything else is a field read as it arrived.
 */
function MoneyPanel(
  { fees, connect, locale, past, currency }: {
    fees: FeesResponse;
    connect: ConnectStatus | null;
    locale: string;
    /** Every appointment in the statement window. Null means the read failed. */
    past: Appointment[] | null;
    /**
     * The operator's currency, and the only one there is for these rows.
     *
     * An appointment carries no currency column of its own — the price on it is
     * in the money the business works in — so with no operator loaded there is
     * nothing to print a figure in, and the statement stays off the screen
     * rather than being quoted in a guessed currency.
     */
    currency: string | null;
  },
) {
  const owed = fees.fees.filter((f) => f.status === 'owed');
  const done = fees.fees.filter((f) => f.status !== 'owed');

  return (
    <section className="money-panel">
      <span className="money-head">Your money</span>

      <p className="money-says">
        A booking reaches you already paid for: the customer's card is charged
        when they book and Round The Way holds that payment. Your share goes to
        your own bank account after the job — once the appointment is over and
        the window a late cancellation could still claim it back in has closed —
        so nothing is sent to you before the work has happened.
      </p>

      {/* The one thing on this panel that says whether money can actually
          reach them. A business with no connected account is skipped by every
          payout sweep and its share sits in the platform balance, which is a
          state that looks from here exactly like not having been paid yet. */}
      {connect?.payouts_enabled && (
        <p className="money-says">
          Payouts are switched on for this business, so a finished job goes out
          on its own with nothing further from you. Where it lands is your bank
          statement — this app can see what you are owed and not what your bank
          has received.
        </p>
      )}
      {connect && !connect.payouts_enabled && !fees.blocked && (
        <p className="money-says">
          <strong>Payouts are not switched on yet.</strong> The money for
          anything you finish is collected and held, and it cannot be sent
          anywhere until there is a bank account to send it to. Finish the
          payout setup in your settings and it goes out on the next sweep.
        </p>
      )}

      {fees.owed.cents > 0 && (
        <p className="money-says">
          {/* The Worker's own formatted string, printed exactly as it arrives.
              It is built in the operator's country and language, so formatting
              it again here would be a second opinion about their currency — and
              it is what is LEFT rather than what was raised, which is why an
              operator halfway through paying one off is not shown the whole
              figure as though nothing had been taken. */}
          <strong>
            You owe {fees.owed.amount} from {fees.owed.count === 1
              ? 'a booking you cancelled.'
              : `${fees.owed.count} bookings you cancelled.`}
          </strong>{' '}
          It comes off your next payout before that payout is sent, oldest first,
          and whatever one payout cannot cover stays owed and comes off the one
          after it.
        </p>
      )}

      {owed.length > 0 && (
        <ul className="money-fees">
          {owed.map((f) => <FeeRow key={f.id} fee={f} locale={locale} />)}
        </ul>
      )}

      {/* Fees that are finished with, kept rather than dropped off the screen.
          A fee that was waived because nobody answered the question about it is
          exactly the charge an operator remembers seeing and later cannot find,
          and a debt that vanishes silently is as unsettling as one that
          appears. */}
      {done.length > 0 && (
        <ul className="money-fees quiet">
          {done.map((f) => <FeeRow key={f.id} fee={f} locale={locale} />)}
        </ul>
      )}

      {/* Last, under the bill it is the other half of. An operator reads the
          two together — what was taken and what was sent — and they are one
          statement rather than two screens about money. */}
      {currency && (
        <PaidJobs past={past} currency={currency} locale={locale}
          netting={fees.owed.cents > 0} />
      )}
    </section>
  );
}

/**
 * One lead fee: what it was for, what it costs, and how much of it is left.
 *
 * The locale is threaded down rather than left to default because the total
 * above these rows was formatted by the Worker in the operator's own country
 * and language. A panel that punctuates its total one way and the fees adding
 * up to it another way makes an operator check the arithmetic, which is the
 * opposite of what a statement is for.
 */
function FeeRow({ fee, locale }: { fee: LeadFee; locale: string }) {
  const amount = (cents: number) => formatMoney(cents, fee.currency, locale);
  // A subtraction of two integers off the same row, not a rule being applied.
  // The Worker publishes both halves precisely so a fee being paid down over
  // two payouts does not read as a second bill; see settled_cents in LeadFee.
  const left = Math.max(0, fee.cents - fee.settled_cents);

  return (
    <li className="money-fee">
      <span className="money-fee-top">
        <span>{FEE_REASONS[fee.reason] ?? 'A cancelled booking'}</span>
        <strong className="mono">{amount(fee.cents)}</strong>
      </span>
      <span className="money-fee-note">
        {fee.status === 'waived'
          ? 'Waived. Nothing is being taken for this one.'
          : fee.status === 'paid'
            ? `Settled${fee.settled_at ? ` on ${onDay(fee.settled_at, locale)}` : ''}.`
            : fee.settled_cents > 0
              ? `${amount(fee.settled_cents)} has already come off a payout, `
                + `leaving ${amount(left)} to come off the next one.`
              : 'Comes off your next payout.'}
        {' '}Raised on {onDay(fee.created_at, locale)}.
        {fee.note ? ` ${fee.note}` : ''}
      </span>
    </li>
  );
}

/**
 * A finished job with the platform's money actually behind it.
 *
 * Every money column on an appointment is null when there is no order line —
 * the operator typed that booking into their own diary and was paid for it in
 * whatever way they arrange themselves. Narrowing here rather than defaulting a
 * missing fee to zero is the difference between leaving that job off a
 * statement and inventing a payout for it.
 */
type PaidJob = Appointment & {
  order_item_id: string; price_cents: number; fee_cents: number;
};

const isPaidJob = (a: Appointment): a is PaidJob =>
  a.order_item_id != null && a.price_cents != null && a.fee_cents != null;

/**
 * Whether this job belongs on the statement at all.
 *
 * A job still to come has nothing to report. A cancelled one has nothing
 * either — settleOrder drops a cancelled line for good, so it will never carry
 * a transfer and calling it "waiting" would promise a payout that is never
 * coming — unless money went back to the customer. That is the one thing about
 * a cancelled line this panel can prove, and it is the answer to "why was I not
 * paid for Tuesday", so it is the one cancelled line that stays.
 */
const onStatement = (j: PaidJob, now: number): boolean =>
  j.ends_at <= now && (j.status !== 'cancelled' || (j.refund_cents ?? 0) > 0);

/** Finished with, one way or the other: the share has gone, or the money went back. */
const isSent = (j: PaidJob): boolean =>
  j.transfer_id != null || (j.refund_cents ?? 0) > 0;

/**
 * WHAT EACH FINISHED JOB PAID: the price, the cut, and where the rest of it is.
 *
 * WHY IT IS HERE AND NOT ON THE SCHEDULE. The schedule answers "where am I
 * meant to be", and a payout figure printed beside a job on it is a fact
 * somebody stumbles on. This is the panel an operator opens holding the
 * question, and the sentence above these rows — a payout goes after the job and
 * after the cancellation window — is the general rule these lines are the
 * particular cases of. Split across two screens they would be two different
 * accounts of the same money.
 *
 * THE TWO DISTINCTIONS EVERY LINE HERE TURNS ON. A job with no `paid_at` is not
 * unpaid, it is not yet paid — the customer's card has not cleared and nothing
 * moves until it does. A job with no `transfer_id` is not money withheld from a
 * business, it is money waiting for the job to be safely behind everyone. Get
 * either of them wrong and an operator who believes they have been stiffed
 * phones the customer directly, which is the one thing this product exists to
 * prevent.
 */
function PaidJobs(
  { past, currency, locale, netting }: {
    past: Appointment[] | null;
    currency: string;
    locale: string;
    /** True while a fee is owed, and a payout therefore arrives smaller than the share. */
    netting: boolean;
  },
) {
  // Said out loud rather than rendered as an empty list. A statement that
  // failed to load and a statement with nothing on it look identical on a
  // screen and mean opposite things to somebody checking whether they have
  // been paid.
  if (past === null) {
    return (
      <p className="money-says">
        What your finished jobs paid could not be loaded just now. That is this
        app failing to read them and not money going missing — nothing about a
        payout changes because a screen did not load. Try again in a moment.
      </p>
    );
  }

  const rows = past.filter(isPaidJob)
    .filter((j) => onStatement(j, Math.floor(Date.now() / 1000)))
    .sort((a, b) => b.starts_at - a.starts_at);
  if (rows.length === 0) return null;

  const waiting = rows.filter((j) => !isSent(j));
  const sent = rows.filter(isSent);

  return (
    <>
      <p className="money-says">
        <strong>What your finished jobs paid.</strong> Each one shows the price
        the customer paid, what Round The Way kept out of it, and where the rest
        of it is.
        {netting && ' What you owe comes off a payout before it is sent, so a '
          + 'payout can reach your bank smaller than the share on a job here.'}
      </p>

      {waiting.length > 0 && (
        <ul className="money-fees">
          {waiting.map((j) => (
            <PaidJobRow key={j.id} job={j} currency={currency} locale={locale} />
          ))}
        </ul>
      )}

      {/* Jobs whose money has stopped moving, kept rather than dropped off the
          screen. The same reasoning as the settled fees above: a payout
          somebody half remembers is the one they go looking for. */}
      {sent.length > 0 && (
        <ul className="money-fees quiet">
          {sent.map((j) => (
            <PaidJobRow key={j.id} job={j} currency={currency} locale={locale} />
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * The one true sentence this line gets.
 *
 * Ordered by what outranks what. A refund comes first because a line the
 * customer got their money back on has no payout at all and never will, so
 * every sentence below it would be false. Then the customer's card, because
 * nothing is sent on out of money that has not arrived. Only then the payout
 * itself, which is either gone or waiting — and waiting is spelled out as what
 * it is waiting for, so that it cannot be read as a refusal.
 *
 * `refund_cents` against `refunded_at` is the distinction the customer's side
 * of this product keeps in web/src/lib/money.ts for the same reason: the first
 * is what was decided and the second is what was done, and a screen that reads
 * only the first tells somebody money has moved when it has not.
 */
function payoutSays(
  job: PaidJob, amount: (cents: number) => string, locale: string,
): string {
  const refund = job.refund_cents ?? 0;
  if (refund > 0) {
    const back = job.refunded_at
      ? `${amount(refund)} went back to the customer on ${onDay(job.refunded_at, locale)}.`
      : `${amount(refund)} is going back to the customer.`;
    return `${back} Nothing is sent to you for a job the customer gets their `
      + 'money back on.';
  }

  // Price minus fee, off this one row, and no other arithmetic on this line.
  // Both halves are the Worker's own figures, written when the charge was
  // opened, so the share quoted here is the share that was transferred.
  const share = amount(job.price_cents - job.fee_cents);
  const kept = `Round The Way kept ${amount(job.fee_cents)}.`;

  if (job.paid_at == null) {
    return `${kept} ${share} is yours. The customer's card has not cleared yet, `
      + 'and nothing is sent on until it does.';
  }
  if (job.transfer_id) {
    return job.transferred_at
      ? `${kept} ${share} was sent to you on ${onDay(job.transferred_at, locale)}.`
      : `${kept} ${share} has been sent to you.`;
  }
  return `${kept} ${share} is yours and has not been sent yet. It goes out once `
    + 'the job is over and the window a late cancellation could still claim it '
    + 'back in has closed.';
}

/**
 * One job: what the customer paid, and one sentence about where it went.
 *
 * The price is the figure on the right because it is the number an operator
 * recognises the job by — it is what they quoted and what the customer paid.
 * The share is in the sentence rather than in the column beside it: on a
 * refunded line there is no share, and a column that has to print a dash half
 * the time is a column that invites somebody to read a dash as a zero.
 */
function PaidJobRow(
  { job, currency, locale }: { job: PaidJob; currency: string; locale: string },
) {
  const amount = (cents: number) => formatMoney(cents, currency, locale);

  return (
    <li className="money-fee">
      <span className="money-fee-top">
        <span>{job.service_name ?? 'Finished job'} · {onDay(job.starts_at, locale)}</span>
        <strong className="mono">{amount(job.price_cents)}</strong>
      </span>
      <span className="money-fee-note">{payoutSays(job, amount, locale)}</span>
    </li>
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
