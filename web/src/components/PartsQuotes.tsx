import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type PartsQuote } from '../api';
import { formatMoney as money } from '../lib/format';
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
  declined: 'You declined this',
  // "Taken back" rather than "withdrawn": a customer who saw a number and then
  // sees it marked withdrawn will assume something went wrong with their tap.
  withdrawn: 'The business took this back',
  expired: 'Expired — ask them to resend',
};

export default function PartsQuotes({ token }: { token: string }) {
  const [quotes, setQuotes] = useState<PartsQuote[]>([]);
  const [partsCents, setPartsCents] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.guestParts(token);
      setQuotes(res.quotes);
      setPartsCents(res.parts_cents);
    } catch {
      // A quote list that will not load is not worth an error box on a page
      // whose main job is the conversation. The poll will pick it up.
    } finally {
      setLoaded(true);
    }
  }, [token]);

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
      await api.decidePartsQuote(token, q.id, decision);
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

          {/* "on top of what you already paid" was not true of any booking on
              this site: paying here is not switched on, so nothing has been
              paid for the appointment either. What IS true, and is the promise
              worth making, is that nothing happens until this is approved. */}
          <p className="quote-note">
            This is on top of the price of the appointment. Nothing is fitted
            until you approve it, and nothing is paid on this site yet — once
            paying here is switched on, approving is what charges you.
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
                {money(q.total_cents, q.currency)} · {STATUS_WORDS[q.status]}
              </span>
            </div>
          ))}
        </div>
      )}

      {partsCents > 0 && (
        <div className="quote-total">
          <span>Parts you approved</span>
          <strong>{money(partsCents, quotes[0]!.currency)}</strong>
        </div>
      )}
    </section>
  );
}
