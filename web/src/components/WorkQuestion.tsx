import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type PendingQuestion } from '../api';
import '../styles-parts.css';

/**
 * The one question, on the customer's own page.
 *
 * A business cancelled a job. Before this existed the refund went back
 * automatically, and that is exactly what made the doorstep bypass safe: an
 * operator could say "cancel it and pay me cash", the platform would refund,
 * and everyone was better off except the platform that found the job and held
 * the slot.
 *
 * NO MONEY HAS ACTUALLY MOVED FOR ANY OF THIS YET — see PaymentState.tsx —
 * which is why the copy below asks the question and describes what the answer
 * settles, rather than telling a customer a refund is on its way. The answer
 * is recorded either way and it is what the refund will follow when there is
 * one; a button reading "refund me $95" to somebody who was never charged $95
 * is the same lie the rest of the site has just stopped telling.
 *
 * So the money waits, and the customer is asked one thing. The question is
 * deliberately not framed as an accusation or an investigation — most of the
 * time the honest answer is "they never came", it takes one tap, and the
 * refund is immediate. The people it is really aimed at are the ones for whom
 * answering honestly is inconvenient.
 *
 * The wording matters more than usual here. "Did they do the work anyway?" is
 * a neutral question with an obvious honest answer. Anything that sounded like
 * "are you helping them cheat us?" would make an honest customer feel accused
 * over a refund they are plainly owed.
 */
export default function WorkQuestion({ token, onAnswered }: {
  token: string;
  onAnswered?: () => void;
}) {
  const [q, setQ] = useState<PendingQuestion | null>(null);
  const [busy, setBusy] = useState<'done' | 'not_done' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.pendingQuestion(token);
      setQ(res.question);
    } catch {
      // Nothing useful to show if this will not load; the poll retries.
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const answer = async (a: 'done' | 'not_done') => {
    if (!q) return;
    setBusy(a); setError(null);
    try {
      await api.answerWork(token, q.order_item_id, a);
      setQ(null);
      onAnswered?.();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not go through.');
    } finally { setBusy(null); }
  };

  if (!q) return null;

  return (
    <section className="card work-q">
      <span className="chip warn">Waiting on your answer</span>

      <div className="name" style={{ marginTop: 10 }}>
        {q.business_name} cancelled {q.services ? `your ${q.services}` : 'your booking'}
      </div>

      <p className="work-q-ask">
        Did they do the work anyway?
      </p>

      {confirming ? (
        <div className="work-q-confirm">
          <p style={{ margin: '0 0 10px' }}>
            Just to be sure — <strong>they did the job</strong>, so you keep the
            service and the business is treated as having completed it. Nothing
            comes back to you, and the price is between the two of you as it
            was.
          </p>
          <div className="quote-actions">
            <button className="btn" type="button" disabled={busy !== null}
              onClick={() => void answer('done')}>
              {busy === 'done' ? 'Saving…' : 'Yes, they did it'}
            </button>
            <button className="btn quiet" type="button" disabled={busy !== null}
              onClick={() => setConfirming(false)}>
              Back
            </button>
          </div>
        </div>
      ) : (
        <div className="quote-actions">
          {/* The honest-and-common answer is the plain button and comes
              first. Somebody who was stood up should not have to hunt. */}
          <button className="btn" type="button" disabled={busy !== null}
            onClick={() => void answer('not_done')}>
            {busy === 'not_done' ? 'Saving…' : 'No, they left'}
          </button>
          <button className="btn quiet" type="button" disabled={busy !== null}
            onClick={() => setConfirming(true)}>
            Yes, they did the work
          </button>
        </div>
      )}

      {error && <div className="error" style={{ marginTop: 12 }}>{error}</div>}

      {/* Said plainly, because the alternative is somebody assuming silence is
          the safe option. It is not: it is the one outcome where nobody gets
          anything, which is deliberate — it stops the two sides simply
          agreeing to say nothing. */}
      <p className="faint" style={{ margin: '12px 0 0' }}>
        Answer either way and it is settled straight away. Nothing was paid for
        this booking — paying on the site is not switched on yet — so today the
        answer settles the record rather than any money. Once it is switched
        on, "they left" is what releases {q.refund} back to you and "they did
        the work" is what pays the business; if nobody answers, the payment
        stays where it is either way, so tell us even if the answer is
        awkward.
      </p>
    </section>
  );
}
