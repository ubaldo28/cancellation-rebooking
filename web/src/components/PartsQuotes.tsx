import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type PartsQuote } from '../api';
import { formatMoney as money } from '../lib/format';
import { onDay } from '../lib/money';
import '../styles-parts.css';

/**
 * The customer's parts quote card, on their own conversation page.
 *
 * This component is the promise. Everything else about parts — the policy on
 * the service, the sentence on the checkout, the column on the receipt — is
 * setup for the two buttons below, and the rule they exist to make true:
 * nothing is ever charged that the customer has not seen and approved.
 *
 * So the design rules here are narrower than usual and none of them are
 * cosmetic:
 *
 *   - The amount is the largest thing on the card. A quote whose price is
 *     smaller than its description is a quote somebody approves without
 *     reading the number.
 *   - Parts and extra labour are shown separately whenever both exist. A
 *     single blended figure is exactly what makes people distrust a quote,
 *     and California taxes the two differently anyway.
 *   - Approve is NOT the visually dominant button. It is the one that costs
 *     money; making it the obvious tap is a dark pattern.
 *   - Approving asks once more, in words, before it fires. One mis-tap on a
 *     phone held in one hand, standing next to a mechanic, must not be a
 *     purchase.
 */

const STATUS_WORDS: Record<PartsQuote['status'], string> = {
  sent: 'Waiting on you',
  approved: 'You approved this',
  declined: 'You declined this — nothing was charged',
  // "Taken back" rather than "withdrawn": a customer who saw a number and then
  // sees it marked withdrawn will assume something went wrong with their tap.
  withdrawn: 'The business took this back',
  expired: 'Expired — ask them to resend',
};

/**
 * What happened to an answered quote, including whether the money moved.
 *
 * "You approved this" was the whole of what this card said about an approval,
 * and approving is the tap that charges — so the one line on the site about a
 * second payment taken off somebody's card, weeks after the booking, did not
 * mention the payment. Somebody scanning a statement for an unexplained £180
 * had nothing here to match it against.
 *
 * `charged_at` is the only field that means money moved, and it is checked
 * rather than inferred from `status`. An approved quote with it still null is
 * not a slow charge or a pending one: it means this deployment has no Stripe
 * key and nothing was ever taken — see chargeApprovedQuote in src/lib/parts.ts,
 * which returns null rather than refusing the approval. Saying "charged" there
 * would invent a payment, and saying nothing would leave somebody expecting one.
 */
function answeredWords(q: PartsQuote): string {
  if (q.status !== 'approved') return STATUS_WORDS[q.status];
  return q.charged_at
    ? `You approved this, and your card was charged on ${onDay(q.charged_at)}`
    : 'You approved this. Nothing has been charged for it';
}

export default function PartsQuotes({ threadRef }: { threadRef: string }) {
  const [quotes, setQuotes] = useState<PartsQuote[]>([]);
  const [partsCents, setPartsCents] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.guestParts(threadRef);
      setQuotes(res.quotes);
      setPartsCents(res.parts_cents);
    } catch {
      // A quote list that will not load is not worth an error box on a page
      // whose main job is the conversation. The poll will pick it up.
    } finally {
      setLoaded(true);
    }
  }, [threadRef]);

  useEffect(() => { void load(); }, [load]);

  // Same cadence as the conversation itself: a quote arrives while the
  // operator is standing in front of them, so a minute's delay is too long.
  useEffect(() => {
    const id = setInterval(() => { void load(); }, 15_000);
    return () => clearInterval(id);
  }, [load]);

  const decide = async (q: PartsQuote, decision: 'approved' | 'declined') => {
    setBusy(q.id); setError(null);
    try {
      await api.decidePartsQuote(threadRef, q.id, decision);
      setConfirming(null);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message
        : 'That did not go through. Check your signal and try again.');
    } finally {
      setBusy(null);
    }
  };

  if (!loaded || quotes.length === 0) return null;

  const live = quotes.filter((q) => q.status === 'sent');
  const past = quotes.filter((q) => q.status !== 'sent');
  // Whether every approval on this booking actually took money. See the total
  // at the foot of the card: it is the running sum of the approved quotes, and
  // what it may be called depends on this.
  const approved = quotes.filter((q) => q.status === 'approved');
  const allCharged = approved.length > 0 && approved.every((q) => q.charged_at != null);

  return (
    <section className="card parts-card">
      <span className={`chip ${live.length ? 'warn' : 'neutral'}`}>
        {live.length ? 'Needs your answer' : 'Parts'}
      </span>

      {live.map((q) => (
        <div key={q.id} className="quote">
          <div className="quote-desc">{q.description}</div>

          <div className="quote-amount">{money(q.total_cents, q.currency)}</div>

          {/* Split whenever both halves exist. One blended number is the thing
              that makes a quote feel like a guess. */}
          {q.labor_cents > 0 && (
            <div className="quote-split faint">
              {money(q.parts_cents, q.currency)} parts
              {' + '}
              {money(q.labor_cents, q.currency)} extra labour
            </div>
          )}

          {/* The appointment itself was paid for by card at the moment it was
              booked, so this really is on top of what has already been paid —
              and the promise worth making is that nothing happens until this
              is approved, because approving it is the thing that charges. */}
          <p className="quote-note">
            This is on top of the price you already paid for the appointment.
            Nothing is fitted until you approve it, and approving it is what
            charges you for it.
          </p>

          {confirming === q.id ? (
            <div className="quote-confirm">
              <p style={{ margin: '0 0 10px' }}>
                Approve <strong>{money(q.total_cents, q.currency)}</strong> for{' '}
                {q.description}?
              </p>
              <div className="quote-actions">
                <button className="btn" type="button" disabled={busy === q.id}
                  onClick={() => void decide(q, 'approved')}>
                  {busy === q.id ? 'Approving…' : 'Yes, approve it'}
                </button>
                <button className="btn quiet" type="button" disabled={busy === q.id}
                  onClick={() => setConfirming(null)}>
                  Back
                </button>
              </div>
            </div>
          ) : (
            // Decline is the plain button and approve is the quiet one, on
            // purpose. The tap that costs money should never be the easy tap.
            <div className="quote-actions">
              <button className="btn quiet" type="button" disabled={busy === q.id}
                onClick={() => setConfirming(q.id)}>
                Approve {money(q.total_cents, q.currency)}
              </button>
              <button className="btn ghost" type="button" disabled={busy === q.id}
                onClick={() => void decide(q, 'declined')}>
                No thanks
              </button>
            </div>
          )}

          <p className="faint" style={{ margin: '10px 0 0' }}>
            Declining is fine. They will still do the work you booked — talk to
            them below about what happens next.
          </p>
        </div>
      ))}

      {error && <div className="error" style={{ marginTop: 12 }}>{error}</div>}

      {past.length > 0 && (
        <div className="quote-history">
          {past.map((q) => (
            <div key={q.id} className="quote-past">
              <span>{q.description}</span>
              <span className="faint">
                {money(q.total_cents, q.currency)} · {answeredWords(q)}
              </span>
            </div>
          ))}
        </div>
      )}

      {partsCents > 0 && (
        /* The running total, named by what actually happened to it. Every
           approval on this booking carrying a charge date means this whole
           figure has already left the customer's card, and that is a different
           sentence from "you agreed to this" — it is the number to look for on
           a statement. The cautious wording is kept for the case where one of
           them was never charged, because a total described as paid when part
           of it was not is the worse way round to be wrong. */
        <div className="quote-total">
          <span>{allCharged ? 'Parts you approved and paid for' : 'Parts you approved'}</span>
          <strong>{money(partsCents, quotes[0]!.currency)}</strong>
        </div>
      )}
    </section>
  );
}
