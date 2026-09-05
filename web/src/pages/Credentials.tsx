import { useCallback, useEffect, useState } from 'react';
import { api, type Credentials as CredentialsRow, type TradeRule } from '../api';
import { useOperator } from '../App';
import { ErrorNote, Spinner } from '../components/ui';
import '../styles-credentials.css';
import { useDocumentTitle } from '../lib/title';

/**
 * Licence and insurance, at /app/credentials.
 *
 * California licenses a lot of the work this site lists, and the operator is
 * the one who has to hold the licence. This page tells them what their trade
 * needs, in the words the requirement is actually written in, names the
 * authority that sets it, and takes down what they say they hold.
 *
 * It records a claim. It does not check one — nothing here is looked up
 * against a state register, and the page says so where they can see it rather
 * than in a footer.
 */



/** The same figure as CONTRACTOR_THRESHOLD_LABEL on the Worker. */
const THRESHOLD = '$1,000';

/** Only California is open, so a licence has one issuer. */
const DEFAULT_STATE = 'CA';

const KINDS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Not answered yet' },
  { value: 'none', label: 'No state licence for this work' },
  { value: 'cslb', label: 'Contractor — CSLB' },
  { value: 'bsis', label: 'Locksmith — BSIS' },
  { value: 'bar', label: 'Automotive Repair Dealer — BAR' },
  { value: 'spcb', label: 'Pest control — Structural Pest Control Board' },
  // A registration, and the label says so: an operator hunting this list for
  // the thing they hold will not find "licence" on their BHGS paperwork.
  { value: 'bhgs', label: 'Electronic / appliance service dealer — BHGS registration' },
  { value: 'bbc', label: 'Barbering / cosmetology — Board of Barbering and Cosmetology' },
  { value: 'vmb', label: 'Veterinary — Veterinary Medical Board' },
];

/**
 * An expiry is a day, not a moment. It goes up as the last second of that day
 * in UTC, because a licence is good for the whole of the date printed on it and
 * sending midnight would make today's date read as already expired.
 */
const toEpoch = (day: string): number | null => {
  if (!day) return null;
  const t = Date.parse(`${day}T23:59:59Z`);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
};

const toDay = (seconds: number | null): string =>
  (seconds === null ? '' : new Date(seconds * 1000).toISOString().slice(0, 10));

const message = (e: unknown, fallback: string) =>
  (e instanceof Error ? e.message : fallback);

export default function CredentialsPage() {
  useDocumentTitle('Licence and insurance');
  const op = useOperator();
  const trade = op?.trade ?? null;

  const [rule, setRule] = useState<TradeRule | null>(null);
  const [blockers, setBlockers] = useState<string[]>([]);
  const [saved, setSaved] = useState<CredentialsRow | null>(null);

  const [kind, setKind] = useState('');
  const [number, setNumber] = useState('');
  const [state, setState] = useState(DEFAULT_STATE);
  const [expires, setExpires] = useState('');
  const [ack, setAck] = useState(false);

  const [insurer, setInsurer] = useState('');
  const [policy, setPolicy] = useState('');
  const [insuranceExpires, setInsuranceExpires] = useState('');
  const [insuredAck, setInsuredAck] = useState(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.credentials();
      const c = res.credentials;
      setSaved(c);
      setRule(res.rule);
      setBlockers(res.blockers);
      setKind(c.license_kind ?? '');
      setNumber(c.license_number ?? '');
      setState(c.license_state ?? DEFAULT_STATE);
      setExpires(toDay(c.license_expires_at));
      setAck(c.unlicensed_ack === 1);
      setInsurer(c.insurer ?? '');
      setPolicy(c.policy_number ?? '');
      setInsuranceExpires(toDay(c.insurance_expires_at));
      setInsuredAck(c.insured_ack === 1);
    } catch (e) {
      setError(message(e, 'Could not load your licence details.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const flash = (text: string) => {
    setNotice(text);
    setTimeout(() => setNotice(null), 2500);
  };

  /** A licence is claimed. 'none' and an unanswered field are both not that. */
  const holdsLicence = kind !== '' && kind !== 'none';

  async function save() {
    setSaving(true); setError(null);
    try {
      const res = await api.saveCredentials({
        license_kind: kind === '' ? null : kind,
        license_number: holdsLicence ? number.trim() : null,
        license_state: holdsLicence ? (state.trim() || DEFAULT_STATE) : null,
        license_expires_at: holdsLicence ? toEpoch(expires) : null,
        unlicensed_ack: ack ? 1 : 0,
        insurer: insurer.trim() || null,
        policy_number: policy.trim() || null,
        insurance_expires_at: toEpoch(insuranceExpires),
        insured_ack: insuredAck ? 1 : 0,
      });
      setSaved(res.credentials);
      setBlockers(res.blockers);
      flash('Saved.');
    } catch (e) {
      setError(message(e, 'Could not save that.'));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <>
        <header className="page-head"><h1>Licence and insurance</h1></header>
        <Spinner label="Loading your licence details" />
      </>
    );
  }

  // A load that failed leaves nothing to fill in, so the form is not shown at
  // all rather than shown empty over stale state.
  if (error && !saved) {
    return (
      <>
        <header className="page-head"><h1>Licence and insurance</h1></header>
        <main className="main stack-lg"><ErrorNote error={error} onRetry={load} /></main>
      </>
    );
  }

  const nothingRecorded = saved !== null
    && saved.license_kind === null && saved.license_number === null
    && saved.insurer === null && saved.policy_number === null
    && saved.unlicensed_ack === 0 && saved.insured_ack === 0;

  const needsAck = rule?.license === 'over_threshold' && !holdsLicence;

  return (
    <>
      <header className="page-head">
        <h1>Licence and insurance</h1>
        <span className="muted">
          What your work requires, and what you hold.
        </span>
      </header>

      <main className="main stack-lg">
        {error && <div className="error">{error}</div>}
        {notice && <div className="notice">{notice}</div>}

        {blockers.length > 0 && (
          <section className="card cred-blockers">
            <span className="cred-blockers-head">
              {blockers.length === 1
                ? 'One thing to sort out before you publish'
                : `${blockers.length} things to sort out before you publish`}
            </span>
            <ul>{blockers.map((b) => <li key={b}>{b}</li>)}</ul>
          </section>
        )}

        {blockers.length === 0 && !nothingRecorded && (
          <div className="notice">Nothing here is stopping your page going public.</div>
        )}

        {rule && (
          <section className="card cred-rule">
            {rule.authority_name && (
              <span className="cred-authority">{rule.authority_name}</span>
            )}
            <h2>
              {rule.license === 'required'
                ? 'This work is licensed in California'
                : rule.license === 'over_threshold'
                  ? `This work is licensed above ${THRESHOLD} a job`
                  : 'No state licence is recorded for this work'}
            </h2>
            {trade && <span className="muted">Your trade: {trade}</span>}
            <p>{rule.why}</p>
            <p className="cred-disclaimer">
              Holding whatever your work requires is your responsibility. This
              page records what you tell us and shows it to customers with the
              authority named; it is not checked against any state register, and
              nothing here is legal advice.
            </p>
          </section>
        )}

        {nothingRecorded && (
          <div className="blank">
            Nothing recorded yet. Fill in what you hold below — a customer
            deciding between two businesses can see it, and it is what lets your
            page go public.
          </div>
        )}

        <section className="stack cred-form">
          <span className="eyebrow">Your licence</span>

          <label className="card" style={{ padding: 14 }}>
            What you hold
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
          </label>

          {holdsLicence && (
            <>
              <label className="card" style={{ padding: 14 }}>
                Licence number
                <input value={number} onChange={(e) => setNumber(e.target.value)}
                  placeholder="1084433" inputMode="text" autoComplete="off" />
                <span className="faint">
                  Exactly as it is printed on the licence, so a customer can look
                  it up themselves.
                </span>
              </label>

              <div className="cred-pair">
                <label className="card" style={{ padding: 14 }}>
                  Issued by
                  <input value={state} maxLength={2}
                    onChange={(e) => setState(e.target.value.toUpperCase())} />
                  <span className="faint">California only, for now.</span>
                </label>

                <label className="card" style={{ padding: 14 }}>
                  Expires
                  <input type="date" value={expires}
                    onChange={(e) => setExpires(e.target.value)} />
                  <span className="faint">Leave blank if it does not expire.</span>
                </label>
              </div>
            </>
          )}

          {needsAck && (
            <label className={`card cred-ack${ack ? ' on' : ''}`}>
              <input type="checkbox" checked={ack}
                onChange={(e) => setAck(e.target.checked)} />
              <span className="cred-ack-text">
                <strong>
                  I will state that I am unlicensed wherever I advertise this
                  work, and I will not take a single job worth more than
                  {' '}{THRESHOLD} in labour and materials together.
                </strong>
                <span>
                  This is the obligation that comes with doing this work without
                  a contractor&rsquo;s licence, not a box to clear. Tick it only
                  if you will keep to it. Add your licence number above instead
                  and it goes away.
                </span>
              </span>
            </label>
          )}

          {/* The one tax fact an operator here actually needs. California does
              not tax labour, so most of these trades charge none at all — but
              a mechanic fitting a battery or a locksmith supplying a deadbolt
              is selling a part, and that part is taxable. The platform adds
              nothing to a price, so it has to be in the number they set. */}
          <span className="eyebrow">Sales tax</span>
          <p className="cred-hint">
            California does not tax labour, so most of the work listed here
            carries no sales tax at all. If you supply parts as part of a job —
            a battery, a windscreen, a lock, a filter — those parts are
            taxable, and the price you set has to already include it. We never
            add anything to your price, and the customer pays exactly the
            figure you listed.
          </p>

          <span className="eyebrow">Your insurance</span>
          <p className="cred-hint">
            Not required by the state for any of this, and not checked here. It
            is the first thing most customers ask a stranger working on their
            property.
          </p>

          <label className="card" style={{ padding: 14 }}>
            Insurer
            <input value={insurer} onChange={(e) => setInsurer(e.target.value)}
              placeholder="Who wrote the policy" autoComplete="off" />
          </label>

          <div className="cred-pair">
            <label className="card" style={{ padding: 14 }}>
              Policy number
              <input value={policy} onChange={(e) => setPolicy(e.target.value)}
                autoComplete="off" />
            </label>

            <label className="card" style={{ padding: 14 }}>
              Cover expires
              <input type="date" value={insuranceExpires}
                onChange={(e) => setInsuranceExpires(e.target.value)} />
            </label>
          </div>

          <label className={`card cred-ack${insuredAck ? ' on' : ''}`}>
            <input type="checkbox" checked={insuredAck}
              onChange={(e) => setInsuredAck(e.target.checked)} />
            <span className="cred-ack-text">
              <strong>The cover above is mine and it is current.</strong>
              <span>
                Shown to customers as your own statement, dated from when you
                save it.
              </span>
            </span>
          </label>

          <button className="btn block" onClick={() => { void save(); }} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </section>
      </main>
    </>
  );
}
