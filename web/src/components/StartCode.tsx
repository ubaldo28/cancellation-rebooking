import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type JobCode } from '../api';
import '../styles-parts.css';

/**
 * The customer's start code and the van to look for.
 *
 * Two jobs, and the smaller-looking one matters more day to day: somebody is
 * about to open their front door to a stranger, and "a white Ford Transit,
 * plate 8ABC123" is the difference between opening it and standing behind it
 * wondering. Every delivery and ride app landed on this years ago for the same
 * reason.
 *
 * The code itself is not security -- four digits against one live booking is
 * not a threat model anybody needs to design around. It is the one moment the
 * platform knows, rather than guesses, that these two people were standing
 * together. Everything else in the system infers.
 *
 * It disappears once used. A code still on screen after the job started is a
 * number people write down and try to reuse, and it means nothing by then.
 */
export default function StartCode({ token }: { token: string }) {
  const [job, setJob] = useState<JobCode | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [note, setNote] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.jobCode(token);
      setJob(res.job);
    } catch {
      // Not worth an error box on a page whose main job is the conversation.
    } finally { setLoaded(true); }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  // Polled so the code clears itself the moment the operator types it in,
  // rather than sitting there looking live after the job has started.
  useEffect(() => {
    const id = setInterval(() => { void load(); }, 20_000);
    return () => clearInterval(id);
  }, [load]);

  if (!loaded || !job) return null;

  const report = async () => {
    setError(null);
    try {
      await api.reportVehicle(token, job.order_item_id, note.trim() || undefined);
      setSent(true); setReporting(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not send.');
    }
  };

  return (
    <section className="card start-code">
      {job.code ? (
        <>
          <span className="chip neutral">Give them this code</span>
          <div className="code-digits" aria-label={`Your code is ${job.code.split('').join(' ')}`}>
            {job.code.split('').map((d, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <span key={i} className="code-digit">{d}</span>
            ))}
          </div>
          <p className="muted" style={{ margin: 0 }}>
            Read it out when they arrive. The job cannot start until they enter
            it, so nobody can mark your appointment done without seeing you.
          </p>
        </>
      ) : (
        <>
          <span className="chip good">Job started</span>
          <p className="muted" style={{ margin: '10px 0 0' }}>
            Your code has been used, so it is no longer shown.
          </p>
        </>
      )}

      {job.vehicle_label && (
        <div className="van">
          <span className="faint">Look for</span>
          <strong>{job.vehicle_label}</strong>

          {!sent && !job.code && null}

          {!sent && (
            reporting ? (
              <div className="stack" style={{ marginTop: 10 }}>
                <label>
                  What turned up instead? (optional)
                  <input value={note} maxLength={200}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="A silver van, no signage" />
                </label>
                <div className="field-row">
                  <button className="btn quiet sm" type="button"
                    onClick={() => setReporting(false)}>Back</button>
                  <button className="btn sm" type="button" onClick={() => void report()}>
                    Send it
                  </button>
                </div>
              </div>
            ) : (
              // Deliberately quiet and always available. Somebody uneasy on
              // their own doorstep needs something to do other than open the
              // door, and it must not require certainty to use.
              <button className="btn ghost sm" type="button"
                style={{ marginTop: 10 }} onClick={() => setReporting(true)}>
                That is not the van that turned up
              </button>
            )
          )}

          {sent && (
            <p className="faint" style={{ margin: '10px 0 0' }}>
              Thanks — we have logged it and told them to update their details.
              If you are not comfortable, do not let anyone in. Message us here.
            </p>
          )}
        </div>
      )}

      {error && <div className="error" style={{ marginTop: 10 }}>{error}</div>}
    </section>
  );
}
