import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, type Country } from '../api';
import { useSession } from '../App';

type Stage = 'form' | 'sent' | 'verifying';

export default function SignIn() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { operator, refresh } = useSession();
  const token = params.get('token');

  const [stage, setStage] = useState<Stage>(token ? 'verifying' : 'form');
  const [email, setEmail] = useState('');
  const [business, setBusiness] = useState('');
  const [country, setCountry] = useState('US');
  const [timezone, setTimezone] = useState('');
  const [countries, setCountries] = useState<Country[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devLink, setDevLink] = useState<string | null>(null);

  useEffect(() => {
    if (operator) navigate('/', { replace: true });
  }, [operator, navigate]);

  useEffect(() => {
    api.countries()
      .then(({ countries }) => {
        setCountries(countries);
        // Guess from the browser so the operator usually does not have to touch it.
        const guessed = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const match = countries.find((c) => c.default_timezone === guessed);
        if (match) setCountry(match.iso2);
        setTimezone(guessed);
      })
      .catch(() => { /* the dropdown just stays empty */ });
  }, []);

  // Magic-link landing: consume the token, then go to the dashboard.
  useEffect(() => {
    if (!token) return;
    api.verify(token)
      .then(async () => { await refresh(); navigate('/', { replace: true }); })
      .catch((e) => {
        setError(e instanceof ApiError ? e.message : 'That link did not work.');
        setStage('form');
      });
  }, [token, refresh, navigate]);

  const selected = countries.find((c) => c.iso2 === country);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setDevLink(null);
    try {
      const res = await api.requestSignIn({
        email: email.trim(),
        business_name: business.trim() || undefined,
        country,
        timezone: timezone || undefined,
      });
      if (res.sign_in_link) setDevLink(res.sign_in_link);  // local development only
      setStage('sent');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  if (stage === 'verifying') {
    return <div className="centre"><div className="auth stack">Signing you in…</div></div>;
  }

  if (stage === 'sent') {
    return (
      <div className="centre">
        <div className="auth card stack">
          <h2>Check your email</h2>
          <p className="muted">
            We sent a sign-in link to <strong>{email}</strong>. It works once and
            expires in 15 minutes.
          </p>
          {devLink && (
            <>
              <div className="rule" />
              <p className="faint">Local development link:</p>
              <a href={devLink} className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>
                {devLink}
              </a>
            </>
          )}
          <button className="btn quiet block" onClick={() => setStage('form')}>
            Use a different email
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="centre">
      <form className="auth card stack" onSubmit={submit}>
        <div>
          <h2>Sign in</h2>
          <p className="muted" style={{ marginTop: 4, marginBottom: 0 }}>
            No password. We email you a link.
          </p>
        </div>

        {error && <div className="error">{error}</div>}

        <label>
          Email
          <input type="email" required autoComplete="email" value={email}
            onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        </label>

        <label>
          Business name
          <input value={business} onChange={(e) => setBusiness(e.target.value)}
            placeholder="Your business" />
        </label>

        <label>
          Country
          <select value={country} onChange={(e) => {
            setCountry(e.target.value);
            const c = countries.find((x) => x.iso2 === e.target.value);
            if (c && !c.multi_timezone) setTimezone(c.default_timezone);
          }}>
            {countries.map((c) => <option key={c.iso2} value={c.iso2}>{c.name}</option>)}
          </select>
        </label>

        {selected?.multi_timezone && (
          <label>
            Time zone
            <input value={timezone} onChange={(e) => setTimezone(e.target.value)}
              placeholder="America/Phoenix" />
            <span className="faint">
              {selected.name} spans several time zones, so this one matters.
            </span>
          </label>
        )}

        <button className="btn block" type="submit" disabled={busy || !email.trim()}>
          {busy ? 'Sending…' : 'Email me a link'}
        </button>
      </form>
    </div>
  );
}
