import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
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

/**
 * Where to go once there is a session, when the visitor did not choose to be
 * here.
 *
 * Protected in App.tsx bounces to this page carrying `state.from` — the screen
 * they actually asked for — and nothing read it, so an operator who opened
 * /app/schedule and was sent here landed on /app afterwards and had to find
 * their way back. Only paths inside the operator app are honoured: `state` is
 * router history, which a page can put anything into, and sending somebody to
 * an arbitrary string after a successful sign-in is an open redirect wearing a
 * different hat.
 */
function returnTo(state: unknown): string {
  const from = (state as { from?: unknown } | null)?.from;
  return typeof from === 'string' && /^\/app(\/|$)/.test(from) ? from : '/app';
}

/**
 * The businesses' door, at /signin.
 *
 * WHAT A SIGN-IN PAGE IS, AND WHAT THIS ONE HAD BECOME. The reference
 * marketplace's is one heading, the fewest fields that can identify you, one
 * button, and — underneath — the ways out: what to do when it does not work,
 * and where to go if you have no account. That shape is not an aesthetic. A
 * sign-in is the only page on a site that every returning user meets and that
 * no returning user wants to be on, so every field on it is a toll charged
 * daily to the people who already chose you.
 *
 * This one was charging four. It asked for an email address, a business name,
 * a country and a time zone, of everybody, every time — because the endpoint
 * behind it doubles as sign-up, and the sign-up's questions had been left
 * lying on the sign-in's form. Three of the four did nothing whatsoever for a
 * returning operator: the Worker reads them only on the INSERT that creates a
 * new row, and for an address it already knows it drops them. The fields could
 * not simply be deleted, because somebody who types an unknown address here
 * does get an account, so they moved behind a fold with the one condition
 * under which they matter written on it.
 *
 * The three modules under the button are the ones that page has and this one
 * did not: what happens when the mail does not arrive (there is no password to
 * reset here, so the failure modes are different and are named), the consent
 * being given by pressing the button, and the way to /join for somebody who
 * has not listed yet. The demo, at the foot, has no equivalent anywhere and is
 * the best thing on the page for the visitor who has not decided.
 */
export default function SignIn() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { operator, refresh } = useSession();
  const token = params.get('token');
  const after = returnTo(location.state);

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
    if (operator) navigate(after, { replace: true });
  }, [operator, navigate, after]);

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
        navigate(services.length === 0 ? '/join' : after, { replace: true });
      })
      .catch((e) => {
        setError(e instanceof ApiError ? e.message : 'That link did not work.');
        setStage('form');
      });
  }, [token, refresh, navigate, after]);

  const selected = countries.find((c) => c.iso2 === country);

  /**
   * Ask for a link. Split out of the submit handler so the "check your email"
   * screen can ask for a second one without sending the person back to a form
   * they have already filled in — a resend on that screen is the commonest
   * thing anybody needs there, and making them press "use a different email"
   * to reach a button that says "email me a link" is asking them to undo
   * something in order to repeat it.
   */
  async function send() {
    setBusy(true); setError(null); setDevLink(null);
    try {
      const res = await api.requestSignIn({
        email: email.trim(),
        // All three are read by the Worker ONLY when the address has no
        // account yet; for an existing operator the row already holds them and
        // the request's copies are ignored. That is why they live behind a
        // disclosure below rather than in the middle of the sign-in path.
        business_name: business.trim() || undefined,
        country,
        timezone: timezone || undefined,
      });
      if (res.sign_in_link) setDevLink(res.sign_in_link);  // local development only
      setStage('sent');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong.');
      // Back to the form, so the error is beside the field that caused it. A
      // resend that fails from the "check your email" screen must not leave
      // somebody staring at a screen saying a mail was sent.
      setStage('form');
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await send();
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

          {/*
            THE SCREEN NOBODY DESIGNS AND EVERYBODY GETS STUCK ON. This is a
            dead end by construction — the next step happens in another
            application — so the only thing it can usefully do is answer the
            question somebody has ninety seconds later, which is always the
            same one: it has not arrived.

            The three answers are in the order they are worth trying, and the
            middle one is why the resend button exists at all. It reads "send
            it again" and not "resend link" because a second link invalidates
            the first, and that is worth saying plainly one line down: two
            links in a mailbox and the older one dead is exactly how somebody
            ends up convinced sign-in is broken.
          */}
          <div className="rule" />
          <p className="faint" style={{ margin: 0 }}>
            Not there? Look in spam or promotions first — a link nobody has
            mailed you before lands there often. Then check the address above
            for a typo.
          </p>
          <button className="btn quiet block" disabled={busy}
            onClick={() => { void send(); }}>
            {busy ? 'Sending…' : 'Send it again'}
          </button>
          <p className="faint" style={{ margin: 0 }}>
            A new link kills the one before it, so always open the newest email.
          </p>
          <button className="btn ghost block" disabled={busy}
            onClick={() => setStage('form')}>
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
          <h1 className="as-h2">Sign in to your business</h1>
          <p className="muted" style={{ marginTop: 4, marginBottom: 0 }}>
            No password. We email you a link.
          </p>
        </div>

        {/*
          THE OTHER DOOR, AT THE TOP RATHER THAN THE BOTTOM — AND IT MATTERS
          MORE SINCE MIGRATION 0038 RATHER THAN LESS.
          This file's own note says most people who open this page are
          customers who took the wrong one — it was the businesses' door and
          the only one there was. There are two now, and since 0038 both start
          with an email address: this one emails a sign-in LINK and creates a
          business account, /account emails a six-digit CODE and opens somebody's
          bookings. While the two asked for different things, landing on the
          wrong one corrected itself; now the field looks the same on both, so a
          customer has to be told which page they are on before they submit it.
        */}
        <p className="faint" style={{ margin: 0 }}>
          Booked something and looking for it?{' '}
          <Link to="/account">Your bookings are over here</Link> — that page
          emails you a code. This one is for businesses, and an address that has
          never signed in here gets a business account rather than your
          bookings.
        </p>

        {error && <div className="error">{error}</div>}

        <label>
          Email
          <input type="email" required autoComplete="email" value={email}
            onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          <span className="faint">The address your business is listed under.</span>
        </label>

        {/*
          ONE FIELD IN THE SIGN-IN PATH, AND THREE BEHIND A FOLD.

          This form asked for an email address, a business name, a country and
          a time zone, every time, of everybody — and for the operator it is
          named after, three of those four did nothing at all. The Worker reads
          business name, country and time zone only on the INSERT that creates
          a brand-new operator row; an address that already has an account is
          looked up and the request's copies of them are dropped on the floor.
          So an established business signing in on a Tuesday morning was
          re-declaring their own trading name to a form that would ignore it.

          They cannot simply be deleted, because this endpoint is also the way
          an account comes into existence — somebody who types an unknown
          address here gets one — so the fields have to be reachable. A closed
          <details> is what that is worth: out of the path for the many, one
          press away for the few, and labelled with the only condition under
          which any of it matters.

          The proper front door for a new business is /join, which asks these
          same things in an order built for someone who has never seen the
          product. It is linked at the foot of this card. This disclosure is
          the escape hatch for somebody who ended up on the wrong page, not a
          second sign-up funnel.
        */}
        {/*
          Styled inline rather than by a class, because this page owns no
          stylesheet of its own — it is dressed entirely by styles.css, which
          has no rule for a <details> anywhere in it. A class here would name
          something nothing defines.
        */}
        <details style={{
          borderTop: '1px solid var(--line)',
          borderBottom: '1px solid var(--line)',
          padding: '4px 0',
        }}>
          <summary style={{
            cursor: 'pointer', padding: '10px 2px', fontSize: 13.5,
            fontWeight: 600, color: 'var(--ink-2)',
          }}>
            Setting up a new business here?
          </summary>
          <div className="stack" style={{ paddingTop: 10 }}>
            <p className="faint" style={{ margin: 0 }}>
              These three are used only when the address above has no account
              yet. If you already have one, we ignore them and use what is on
              your account — so there is nothing to change here.
            </p>

            <label>
              Business name
              <input value={business} onChange={(e) => setBusiness(e.target.value)}
                placeholder="Your business" autoComplete="organization" />
              <span className="faint">This is the name customers see.</span>
            </label>

            {/*
              Drawn only where there is a choice to make. The country list is
              one row long today — the United States — and a select with a
              single option is a control that cannot be operated: it takes a
              tap, offers no alternative, and leaves the reader wondering what
              they were meant to do with it. The value is still sent; it is
              simply not asked for when there is nothing to ask.
            */}
            {countries.length > 1 && (
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
            )}

            {selected?.multi_timezone && (
              <label>
                Time zone
                <input value={timezone} onChange={(e) => setTimezone(e.target.value)}
                  placeholder="America/Phoenix" />
                <span className="faint">
                  {selected.name} spans several time zones, so this one matters.
                  We have guessed it from your browser — change it if that is
                  wrong.
                </span>
              </label>
            )}
          </div>
        </details>

        <button className="btn block" type="submit" disabled={busy || !email.trim()}>
          {busy ? 'Sending…' : 'Email me a link'}
        </button>

        {/*
          Beside the button rather than in the footer, which is where the
          reference marketplace puts its own version and is right for the same
          reason: this is the moment consent is actually given, and a link in
          the furniture at the bottom of the page is not where anybody looks
          for it.
        */}
        <p className="faint" style={{ textAlign: 'center', margin: 0 }}>
          By continuing you agree to the <Link to="/terms">terms</Link> and the{' '}
          <Link to="/privacy">privacy notice</Link>.
        </p>

        <p className="faint" style={{ textAlign: 'center', margin: 0 }}>
          Not listed yet? <Link to="/join">List your business</Link> — five
          short screens, and you can stop halfway and finish later.
        </p>

        <div className="rule" />

        <button type="button" className="btn ghost block" disabled={busy}
          onClick={async () => {
            setBusy(true); setError(null);
            try {
              await api.startDemo();
              await refresh();
              navigate(after, { replace: true });
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
