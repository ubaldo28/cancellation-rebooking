import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, type Country } from '../api';
import { useSession } from '../App';
import Crumbs from '../components/Crumbs';
import SiteFooter from '../components/SiteFooter';
import SiteHeader from '../components/SiteHeader';
import { useDocumentTitle } from '../lib/title';

type Stage = 'form' | 'sent' | 'verifying';

/**
 * The frame around the sign-in card.
 *
 * This page had no chrome of any kind: a centred card on an otherwise empty
 * screen, linked from the header of every other page and offering no way back
 * off it except the browser's back button. Signing in is the businesses' door,
 * and most people who open it are customers who took the wrong one — so this
 * is precisely the page that needed a way out and was the only one without it.
 *
 * `.centre` sizes itself with `min-height: 100%`, which resolved against the
 * page when it was the only thing on it and resolves against nothing now that
 * it is a flex item. `flex: 1` is what keeps the card vertically centred in
 * whatever room is left between the header and the footer.
 */
function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="land">
      <SiteHeader />
      <main className="centre" id="main" tabIndex={-1}
        style={{ flex: 1, flexDirection: 'column' }}>
        {/* Wrapped in `.auth` so the trail starts at the same left edge as the
            card below it rather than floating at the centre of the viewport;
            `.auth` is the width the card is. */}
        <div className="auth">
          <Crumbs items={[{ label: 'Sign in' }]} />
        </div>
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}

export default function SignIn() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { operator, refresh } = useSession();
  const token = params.get('token');

  const [stage, setStage] = useState<Stage>(token ? 'verifying' : 'form');
  useDocumentTitle(stage === 'sent' ? 'Check your email' : 'Sign in');
  const [email, setEmail] = useState('');
  const [business, setBusiness] = useState('');
  const [country, setCountry] = useState('US');
  const [timezone, setTimezone] = useState('');
  const [countries, setCountries] = useState<Country[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devLink, setDevLink] = useState<string | null>(null);

  useEffect(() => {
    if (operator) navigate('/app', { replace: true });
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
      .then(async () => {
        await refresh();
        // A brand-new operator has nothing set up yet. Dropping them into an
        // empty dashboard is how someone decides the product does nothing.
        const { services } = await api.services().catch(() => ({ services: [] }));
        navigate(services.length === 0 ? '/join' : '/app', { replace: true });
      })
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

  // Deliberately bare. This is not a page, it is a redirect being carried out:
  // the token is consumed and the browser leaves for /app or /join. Drawing a
  // header and a footer here would flash a whole site's furniture on screen for
  // the half second before it is thrown away, and the footer would fire a
  // catalogue request for a page nobody will still be on when it answers.
  if (stage === 'verifying') {
    return <div className="centre"><div className="auth stack">Signing you in…</div></div>;
  }

  if (stage === 'sent') {
    return (
      <Shell>
        <div className="auth card stack">
          <h1 className="as-h2">Check your email</h1>
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
      </Shell>
    );
  }

  return (
    <Shell>
      <form className="auth card stack" onSubmit={submit}>
        <div>
          <h1 className="as-h2">Sign in</h1>
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

        <div className="rule" />

        <button type="button" className="btn ghost block" disabled={busy}
          onClick={async () => {
            setBusy(true); setError(null);
            try {
              await api.startDemo();
              await refresh();
              navigate('/app', { replace: true });
            } catch (e) {
              setError(e instanceof ApiError ? e.message : 'The demo is not available.');
            } finally {
              setBusy(false);
            }
          }}>
          Look around without signing up
        </button>
        <p className="faint" style={{ textAlign: 'center', margin: 0 }}>
          Opens a sample detailing business in Los Angeles with a cancelled job
          to fill. Nothing you do in it is kept.
        </p>
      </form>
    </Shell>
  );
}
