import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  api, ApiError, type Country, type PartsPolicy, type Service, type ServiceArea,
  type TradeCategory,
} from '../api';
import { useSession } from '../App';
import Crumbs from '../components/Crumbs';
import PartsPolicyField, {
  EMPTY_PARTS, partsPayload, type PartsValue,
} from '../components/PartsPolicyField';
import SiteFooter from '../components/SiteFooter';
import SiteHeader from '../components/SiteHeader';
import WorkingHours, {
  hhmm, hoursPayload, type DayHours,
} from '../components/WorkingHours';
import { Icon, Spinner } from '../components/ui';
import { addDays, epochInZone, todayIn } from '../lib/zone';
import { useDocumentTitle } from '../lib/title';

/**
 * Operator sign-up and setup, at /join.
 *
 * Five short screens, not a settings page. Someone deciding whether this is
 * worth their evening gives it about a minute, so each screen asks one thing
 * and says how far along they are.
 *
 * Anyone who drops out halfway and comes back lands on the first screen they
 * have not finished. That is worked out by reading the account — areas,
 * services, hours — because the browser they come back on is often not the
 * one they started on.
 */

/**
 * Starter services, by trade.
 *
 * The first version put a single hardcoded example — "Full detail" — on the
 * service form for everybody, so a mechanic setting up was shown a detailer's
 * work. These are typical jobs for each trade with realistic durations, there
 * to be tapped and edited. Duration is the part that matters: it decides which
 * cancelled slots a job can be dropped into.
 *
 * `weeks` is how often the work repeats; null means a one-off.
 */
interface Starter {
  name: string; mins: number; weeks: number | null;
  /**
   * The parts answer for this job, pre-filled when the operator taps it.
   *
   * Added for phone repair, where the part IS the job -- a screen is most of
   * what the customer pays -- and getting that wrong at sign-up means every
   * booking afterwards carries the wrong promise. Left off everywhere else, so
   * those starters keep the 'none' default they have always had.
   */
  parts?: PartsPolicy;
}

const TRADE_SERVICES: Record<string, Starter[]> = {
  'mobile car wash and detailing': [
    { name: 'Full detail', mins: 120, weeks: 4 },
    { name: 'Wash and wax', mins: 60, weeks: 3 },
    { name: 'Interior deep clean', mins: 90, weeks: null },
    { name: 'Headlight restoration', mins: 45, weeks: null },
  ],
  'junk removal': [
    { name: 'Single item pickup', mins: 45, weeks: null },
    { name: 'Half load', mins: 90, weeks: null },
    { name: 'Full load', mins: 150, weeks: null },
    { name: 'Garage clear-out', mins: 180, weeks: null },
  ],
  // Keyed by catalogue slug, not by the label. The catalogue calls this trade
  // "trash can cleaning" and shows it as "Bin cleaning"; keying it by the label
  // meant a bin cleaner signing up was the one trade offered no starter jobs.
  'trash can cleaning': [
    { name: 'Two bins', mins: 30, weeks: 4 },
    { name: 'Four bins', mins: 45, weeks: 4 },
    { name: 'One-off deep clean', mins: 60, weeks: null },
  ],
  'mobile pressure washing': [
    { name: 'Driveway', mins: 90, weeks: 26 },
    { name: 'Patio and deck', mins: 120, weeks: 26 },
    { name: 'House wash', mins: 180, weeks: null },
    { name: 'Gutter clean', mins: 90, weeks: 26 },
  ],
  'mobile oil change and mechanics': [
    { name: 'Oil and filter change', mins: 60, weeks: 26 },
    { name: 'Brake pads, one axle', mins: 120, weeks: null },
    { name: 'Battery replacement', mins: 45, weeks: null },
    { name: 'Diagnostic check', mins: 60, weeks: null },
  ],
  'window cleaning': [
    { name: 'Outside only', mins: 45, weeks: 8 },
    { name: 'Inside and out', mins: 90, weeks: 8 },
  ],
  'landscaping and gardening': [
    { name: 'Mow and edge', mins: 45, weeks: 2 },
    { name: 'Full tidy-up', mins: 120, weeks: 4 },
    { name: 'Hedge trim', mins: 90, weeks: 12 },
  ],
  'carpet cleaning': [
    { name: 'Two rooms', mins: 90, weeks: null },
    { name: 'Whole house', mins: 180, weeks: null },
    { name: 'Rug, per piece', mins: 45, weeks: null },
  ],
  'mobile locksmith': [
    { name: 'Rekey, up to three locks', mins: 45, weeks: null },
    { name: 'Deadbolt fitted', mins: 60, weeks: null },
    { name: 'Car key cut and programmed', mins: 60, weeks: null },
    { name: 'Lockout, door opened', mins: 30, weeks: null },
  ],
  'house cleaning': [
    { name: 'Standard clean, two bed', mins: 120, weeks: 2 },
    { name: 'Deep clean', mins: 240, weeks: null },
    { name: 'Move-out clean', mins: 300, weeks: null },
  ],
  'pool service': [
    { name: 'Weekly service', mins: 30, weeks: 1 },
    { name: 'Filter clean', mins: 60, weeks: 26 },
    { name: 'Green pool recovery', mins: 120, weeks: null },
  ],
  'pest control': [
    { name: 'General treatment', mins: 45, weeks: 8 },
    { name: 'Rodent inspection', mins: 60, weeks: null },
    { name: 'Ant or roach callout', mins: 45, weeks: null },
  ],
  'mobile pet grooming': [
    { name: 'Bath and tidy, small dog', mins: 60, weeks: 6 },
    { name: 'Full groom, medium dog', mins: 90, weeks: 6 },
    { name: 'Nails and ears only', mins: 20, weeks: 4 },
  ],
  'bike repair service': [
    { name: 'Tune-up', mins: 60, weeks: 26 },
    { name: 'Flat repair', mins: 30, weeks: null },
    { name: 'Brake and gear service', mins: 60, weeks: null },
    { name: 'Full strip and rebuild', mins: 180, weeks: null, parts: 'quoted' },
  ],
  'mobile dog gym': [
    { name: 'One-to-one session', mins: 45, weeks: 1 },
    { name: 'Puppy basics', mins: 60, weeks: 1 },
    { name: 'Reactivity session', mins: 60, weeks: 2 },
  ],
  'mobile veterinary service': [
    { name: 'Wellness exam', mins: 45, weeks: 52 },
    { name: 'Vaccinations', mins: 30, weeks: 52 },
    { name: 'Sick visit', mins: 45, weeks: null, parts: 'quoted' },
    { name: 'End of life visit', mins: 90, weeks: null },
  ],
  'mobile hair salon or barbershop': [
    { name: 'Cut', mins: 45, weeks: 4 },
    { name: 'Cut and beard', mins: 60, weeks: 3 },
    { name: 'Colour', mins: 120, weeks: 6, parts: 'included' },
    { name: 'Blow dry', mins: 45, weeks: 2 },
  ],
  'mobile spa and massage': [
    { name: 'Massage, 60 minutes', mins: 75, weeks: 4 },
    { name: 'Massage, 90 minutes', mins: 105, weeks: 4 },
    { name: 'Facial', mins: 60, weeks: 6 },
  ],
  'mobile makeup artist': [
    { name: 'Event makeup', mins: 60, weeks: null },
    { name: 'Bridal trial', mins: 90, weeks: null },
    { name: 'Bridal party, per face', mins: 45, weeks: null },
  ],
  'food trucks': [
    { name: 'Private event, 2 hours', mins: 120, weeks: null },
    { name: 'Private event, 4 hours', mins: 240, weeks: null },
    { name: 'Office lunch service', mins: 120, weeks: 4 },
  ],
  'coffee and smoothie trucks': [
    { name: 'Morning service, 2 hours', mins: 120, weeks: null },
    { name: 'Office coffee round', mins: 120, weeks: 1 },
    { name: 'Event service, 4 hours', mins: 240, weeks: null },
  ],
  'dessert trucks': [
    { name: 'Party service, 2 hours', mins: 120, weeks: null },
    { name: 'Event service, 3 hours', mins: 180, weeks: null },
  ],
  'mobile bar service': [
    { name: 'Bar service, 3 hours', mins: 180, weeks: null },
    { name: 'Bar service, 5 hours', mins: 300, weeks: null },
    { name: 'Cocktail package', mins: 240, weeks: null, parts: 'included' },
  ],
  'tech support': [
    { name: 'Callout, first hour', mins: 60, weeks: null },
    { name: 'New computer setup', mins: 90, weeks: null },
    { name: 'Wi-Fi and network fix', mins: 90, weeks: null, parts: 'quoted' },
    { name: 'Virus and slowdown clean-up', mins: 120, weeks: null },
  ],
  'personal fitness training': [
    { name: 'One-to-one session', mins: 60, weeks: 1 },
    { name: 'Two-person session', mins: 60, weeks: 1 },
    { name: 'Assessment and plan', mins: 90, weeks: null },
  ],
  'mobile photography and photo booths': [
    { name: 'Portrait session', mins: 90, weeks: null },
    { name: 'Event coverage, 2 hours', mins: 120, weeks: null },
    { name: 'Photo booth, 3 hours', mins: 180, weeks: null },
  ],
  'tutoring': [
    { name: 'One hour session', mins: 60, weeks: 1 },
    { name: 'Ninety minute session', mins: 90, weeks: 1 },
    { name: 'Exam intensive', mins: 120, weeks: null },
  ],
  'fashion boutique trucks': [
    { name: 'Private shopping, 2 hours', mins: 120, weeks: null },
    { name: 'Party pop-up, 3 hours', mins: 180, weeks: null },
  ],
  'mobile bookstore': [
    { name: 'School visit', mins: 120, weeks: null },
    { name: 'Event pop-up, 3 hours', mins: 180, weeks: null },
  ],
  "mobile farmer's market": [
    { name: 'Market stall, half day', mins: 240, weeks: 1 },
    { name: 'Private delivery round', mins: 120, weeks: 1 },
  ],
  'phone and tablet repair': [
    // Screen and battery are the two jobs, and both are almost entirely part
    // cost, so they ship as 'included' -- the operator carries the screen and
    // prices it in. A customer being quoted for a screen after the tech
    // arrives would be absurd; everybody knows what an iPhone screen costs.
    { name: 'Phone screen replacement', mins: 45, weeks: null, parts: 'included' },
    { name: 'Phone battery replacement', mins: 30, weeks: null, parts: 'included' },
    { name: 'Tablet screen replacement', mins: 60, weeks: null, parts: 'included' },
    // Water damage is the opposite: nobody knows what is dead until it is
    // open. This is exactly the case parts quotes were built for.
    { name: 'Water damage diagnosis', mins: 45, weeks: null, parts: 'quoted' },
    { name: 'Charge port repair', mins: 45, weeks: null, parts: 'included' },
  ],
  'appliance repair': [
    { name: 'Diagnostic callout', mins: 45, weeks: null, parts: 'quoted' },
    { name: 'Washer or dryer repair', mins: 90, weeks: null },
    { name: 'Fridge repair', mins: 120, weeks: null },
  ],
  // Keyed by catalogue slug for the same reason "trash can cleaning" above is:
  // the catalogue calls this trade "handyman and repair services", and the key
  // here was the bare word, so every handyman who signed up was shown no
  // starter jobs at all. Every key in this object has now been checked against
  // src/lib/trades.ts one at a time — all thirty-nine of them match a
  // catalogue slug, and every catalogue slug has a list.
  'handyman and repair services': [
    { name: 'Small jobs, hourly', mins: 60, weeks: null },
    { name: 'TV mounted', mins: 60, weeks: null },
    { name: 'Flat-pack assembly', mins: 90, weeks: null },
    { name: 'Door or lock adjustment', mins: 45, weeks: null },
  ],
  'gutter cleaning': [
    { name: 'Single storey', mins: 60, weeks: 26 },
    { name: 'Two storey', mins: 120, weeks: 26 },
  ],
  'auto glass repair': [
    { name: 'Chip repair', mins: 30, weeks: null },
    { name: 'Windscreen replacement', mins: 120, weeks: null },
  ],
  'dryer vent cleaning': [
    { name: 'Standard vent', mins: 45, weeks: 52 },
    { name: 'Long or roof run', mins: 90, weeks: 52 },
  ],
  'mobile notary': [
    { name: 'General notarisation', mins: 30, weeks: null },
    { name: 'Loan signing', mins: 60, weeks: null },
  ],
  'tree and shrub trimming': [
    { name: 'Shrub and hedge trim', mins: 120, weeks: 12 },
    { name: 'Small tree trim', mins: 180, weeks: 26 },
  ],
  'mobile tyre fitting': [
    { name: 'One tyre fitted', mins: 30, weeks: null },
    { name: 'Full set of four', mins: 90, weeks: null },
    { name: 'Puncture repair', mins: 30, weeks: null },
  ],
};

/**
 * The trade picker, grouped.
 *
 * A flat run of forty chips is a wall nobody reads. The categories come from
 * the Worker so there is one catalogue rather than a copy here that quietly
 * falls behind — which is how a trade ended up pickable at sign-up and
 * invisible to every customer.
 */
function TradePicker({ value, onPick }: { value: string; onPick: (slug: string) => void }) {
  const [cats, setCats] = useState<TradeCategory[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.tradeCatalog();
        setCats(res.categories);
        // Opened on whichever category holds what they already picked, so
        // coming back to this step does not hide their own answer.
        setOpen(res.categories.find(
          (c) => c.trades.some((t) => t.slug === value))?.key ?? null);
      } catch { /* the free-text field still works without the list */ }
    })();
  }, [value]);

  if (cats.length === 0) return null;

  return (
    <div className="trade-cats">
      {cats.map((c) => {
        const isOpen = open === c.key;
        const picked = c.trades.find((t) => t.slug === value);
        return (
          <div key={c.key} className={`trade-cat${isOpen ? ' open' : ''}`}>
            <button type="button" className="trade-cat-head"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : c.key)}>
              <span>{c.label}</span>
              {/* The chosen trade stays visible on a closed category, so the
                  answer is never hidden behind a fold. */}
              <span className="faint">{picked ? picked.label : `${c.trades.length}`}</span>
            </button>

            {isOpen && (
              <div className="sug">
                {c.trades.map((t) => (
                  <button key={t.slug} type="button"
                    className={`sug-chip${value === t.slug ? ' on' : ''}`}
                    onClick={() => onPick(t.slug)}>
                    {t.label}
                    {t.hint && <span className="sug-min">{t.hint}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The starter jobs for one trade, keyed by catalogue slug.
 *
 * A trade with no list gets nothing rather than another trade's work: offering
 * a locksmith "Full detail" is worse than offering them nothing, and the form
 * below reads perfectly well with no chip row above it.
 */
const startersFor = (trade: string | null | undefined): Starter[] =>
  TRADE_SERVICES[(trade ?? '').trim().toLowerCase()] ?? [];

const STEPS = [
  'Where you work',
  'What you charge',
  'When you work',
  'Your first jobs',
];

/** A day nobody has answered for yet: closed, and the hours a van usually runs. */
const vanDay = (): DayHours => ({ on: false, start: '08:00', end: '18:00' });

/** Mon–Sat, 8 to 6. Most vans already run this, so most people change nothing. */
function defaultHours(): Record<number, DayHours> {
  const map: Record<number, DayHours> = {};
  for (let d = 0; d < 7; d++) map[d] = { ...vanDay(), on: d >= 1 && d <= 6 };
  return map;
}

const message = (e: unknown, fallback: string) =>
  e instanceof ApiError || e instanceof Error ? e.message : fallback;

// ---------------------------------------------------------------------------

/**
 * The frame every screen of the wizard sits in.
 *
 * The bar this replaced held one link, which was "Sign in" for a stranger and
 * "Open the app" for somebody already signed in. The shared header carries
 * "Sign in" itself, so that half is covered. "Open the app" is not in it and
 * is not something to lose: an operator who is three screens into setup and
 * decides to finish tomorrow is going to their dashboard, and this is the only
 * page that offers it. It is kept as `appLink`, below the shared header rather
 * than inside it, because it belongs to this page and not to the site.
 *
 * `appLink` is asked for by the middle screens and not by the last one, which
 * already ends on "Open the app" as its main button — the same link twice on
 * one screen, once as a whisper above the fold and once as the thing the whole
 * screen is pointing at, only makes the button look less final.
 *
 * `crumbs` is asked for by the first screen and no other. A breadcrumb is for
 * somebody who arrived from outside and may want to walk back up, which
 * describes the sign-up screen a stranger lands on and not somebody standing
 * on step three of five with half a business filled in. It is also the only
 * screen a crawler ever reaches, so it is the only one where the
 * BreadcrumbList is worth emitting at all.
 */
function Shell({ appLink, crumbs, children }: {
  appLink?: boolean; crumbs?: boolean; children: ReactNode;
}) {
  return (
    <div className="land">
      <SiteHeader />
      <main className="wrap" id="main" tabIndex={-1}>
        {crumbs && <Crumbs items={[{ label: 'List your business' }]} />}
        {appLink && (
          <p className="faint" style={{ margin: '0 0 12px' }}>
            <Link to="/app">Open the app</Link>
          </p>
        )}
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}

export default function Join() {
  useDocumentTitle('List your business');
  const { operator, isDemo, loading: sessionLoading, refresh } = useSession();

  // null until we know which screen this person belongs on.
  const [step, setStep] = useState<number | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [business, setBusiness] = useState('');
  const [country, setCountry] = useState('US');
  const [timezone, setTimezone] = useState('');
  const [countries, setCountries] = useState<Country[]>([]);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [devLink, setDevLink] = useState<string | null>(null);

  const [trade, setTrade] = useState('');
  const [areas, setAreas] = useState<ServiceArea[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [hours, setHours] = useState<Record<number, DayHours>>(defaultHours);
  const [booked, setBooked] = useState<string[]>([]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [slug, setSlug] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);

  const tz = operator?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  useEffect(() => {
    api.countries()
      .then(({ countries }) => {
        setCountries(countries);
        // Guess from the browser, so most people never touch this field.
        const guessed = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const match = countries.find((c) => c.default_timezone === guessed);
        if (match) setCountry(match.iso2);
        setTimezone(guessed);
      })
      .catch(() => { /* the list stays empty; the field still works */ });
  }, []);

  /** Read the account and open the first screen that is not finished yet. */
  const resume = useCallback(async () => {
    setBootError(null);
    try {
      const [a, s, w] = await Promise.all([
        api.serviceAreas(), api.services(), api.workingHours(),
      ]);
      setAreas(a.areas);
      setServices(s.services);
      if (w.working_hours.length > 0) {
        const map = defaultHours();
        for (let d = 0; d < 7; d++) map[d] = { on: false, start: '08:00', end: '18:00' };
        for (const h of w.working_hours) {
          map[h.weekday] = { on: true, start: hhmm(h.start_minute), end: hhmm(h.end_minute) };
        }
        setHours(map);
      }
      setStep(
        a.areas.length === 0 ? 1
          : s.services.length === 0 ? 2
            : w.working_hours.length === 0 ? 3
              : 4,
      );
    } catch (e) {
      setBootError(message(e, 'Could not load your setup.'));
      setStep(1);
    }
  }, []);

  useEffect(() => {
    if (sessionLoading) return;

    // Someone browsing the demo who clicks "list your van" is signed in as a
    // sample business. Resuming that account walked them through setting up
    // the demo detailer — its services listed as theirs while they picked
    // their own trade. Start a fresh sign-up instead.
    //
    // The demo session is deliberately left alone: signing them out here would
    // lock them out of the app they were just looking at, and they have not
    // asked to leave it — they asked to create their own.
    if (isDemo) { setStep((st) => (st === null || st > 0 ? 0 : st)); return; }

    if (!operator) { setStep((s) => (s === null ? 0 : s)); return; }
    setTrade((t) => t || operator.trade || '');
    if (step === null || step === 0) void resume();
  }, [sessionLoading, operator, isDemo, step, resume]);

  // Publishing is what turns the account into a page a customer can open, so
  // it happens on the last screen rather than being another thing to remember.
  useEffect(() => {
    if (step !== 5) return;
    let live = true;
    api.publishProfile()
      .then(({ slug }) => { if (live) setSlug(slug); })
      .catch((e) => { if (live) setPublishError(message(e, 'Could not publish your page.')); });
    return () => { live = false; };
  }, [step]);

  async function signUp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setDevLink(null);
    try {
      const res = await api.requestSignIn({
        email: email.trim(),
        business_name: business.trim() || undefined,
        country,
        timezone: timezone || undefined,
      });
      if (res.sign_in_link) setDevLink(res.sign_in_link);   // local development only
      setSentTo(email.trim());
    } catch (e) {
      setError(message(e, 'Could not send the link.'));
    } finally {
      setBusy(false);
    }
  }

  async function next() {
    setBusy(true); setError(null);
    try {
      if (step === 1) {
        if (areas.length === 0) { setError('Add at least one area you cover.'); return; }
        if (trade.trim() && trade.trim() !== operator?.trade) {
          await api.updateSettings({ trade: trade.trim() });
          await refresh();
        }
        setStep(2);
      } else if (step === 2) {
        if (services.length === 0) { setError('Add at least one service.'); return; }
        setStep(3);
      } else if (step === 3) {
        const list = hoursPayload(hours);
        if (list.length === 0) { setError('Turn on at least one working day.'); return; }
        await api.setWorkingHours(list);
        setStep(4);
      } else if (step === 4) {
        // Finding the holes is the whole point, so do it before they ever
        // open the app — an empty Today screen on day one reads as broken.
        await api.detectGaps(14).catch(() => { /* not worth blocking on */ });
        setStep(5);
      }
    } catch (e) {
      setError(message(e, 'Could not save that.'));
    } finally {
      setBusy(false);
    }
  }

  async function removeArea(id: string) {
    setError(null);
    const before = areas;
    setAreas(areas.filter((a) => a.id !== id));   // the chip goes now, not in 300ms
    try {
      await api.deleteServiceArea(id);
    } catch (e) {
      setAreas(before);
      setError(message(e, 'Could not remove that area.'));
    }
  }

  if (sessionLoading || step === null) {
    return <Shell><div className="wiz"><Spinner label="Getting things ready" /></div></Shell>;
  }

  // --- step 0: sign up ---------------------------------------------------
  if (step === 0) {
    if (sentTo) {
      return (
        <Shell>
          <div className="wiz">
            <div className="card stack">
              <h1 className="as-h2">Check your email</h1>
              <p className="muted" style={{ margin: 0 }}>
                We sent a sign-in link to <strong>{sentTo}</strong>. It works
                once and expires in 15 minutes. Open it, then come back here and
                we pick up where you left off.
              </p>
              {devLink && (
                <>
                  <div className="rule" />
                  <p className="faint" style={{ margin: 0 }}>Local development link:</p>
                  <a href={devLink} className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>
                    {devLink}
                  </a>
                </>
              )}
              <button className="btn block" onClick={() => { void refresh(); }}>
                I have clicked the link
              </button>
              <button className="btn quiet block" onClick={() => setSentTo(null)}>
                Use a different email
              </button>
            </div>
          </div>
        </Shell>
      );
    }

    const selected = countries.find((c) => c.iso2 === country);
    return (
      <Shell crumbs>
        <div className="wiz">
          <div className="wiz-head">
            <span className="wiz-count">Step 1 of 5 · Your account</span>
            <WizBar at={0} />
          </div>

          <h1 className="wiz-q">Put your van on the map.</h1>
          <p className="wiz-sub">
            Three fields now, four short screens after. You can stop at any
            point and finish later.
          </p>

          <form className="card stack" onSubmit={signUp}>
            {error && <div className="error">{error}</div>}

            <label>
              Email
              <input type="email" required autoComplete="email" value={email}
                onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
              <span className="faint">No password. We email you a link.</span>
            </label>

            <label>
              Business name
              <input required value={business} onChange={(e) => setBusiness(e.target.value)}
                placeholder="Your business" autoComplete="organization" />
              <span className="faint">This is the name customers see.</span>
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

            <button className="btn block" type="submit"
              disabled={busy || !email.trim() || !business.trim()}>
              {busy ? 'Sending…' : 'Email me a link'}
            </button>
          </form>

          <p className="faint" style={{ textAlign: 'center' }}>
            Already have an account? <Link to="/signin">Sign in</Link>
          </p>
        </div>
      </Shell>
    );
  }

  // --- step 5: done ------------------------------------------------------
  if (step === 5) {
    const publicUrl = slug ? `${window.location.origin}/p/${slug}` : null;
    return (
      <Shell>
        <div className="wiz">
          <div className="wiz-done"><Icon name="tick" size={30} stroke={2.4} /></div>
          <h1 className="wiz-q">You are live.</h1>
          <p className="wiz-sub">
            From now on, when a job cancels the app works out what fits the hole
            and who is nearby, and gives you the message to send.
          </p>

          <div className="card stack">
            <span className="eyebrow">Your public page</span>
            {publishError && <div className="error">{publishError}</div>}
            {!publishError && !publicUrl && <Spinner label="Publishing" />}
            {publicUrl && (
              <>
                <a href={publicUrl} className="mono" style={{ wordBreak: 'break-all' }}>
                  {publicUrl}
                </a>
                <p className="faint" style={{ margin: 0 }}>
                  Send this to anyone who asks what you do. Add photos of
                  finished work in the app and this page gets a lot stronger.
                </p>
              </>
            )}
          </div>

          <Link className="btn block" to="/app">Open the app</Link>
          <Link className="btn quiet block" to="/app/profile">Add photos of your work</Link>
        </div>
      </Shell>
    );
  }

  // --- steps 1 to 4 ------------------------------------------------------
  return (
    <Shell appLink>
      <div className="wiz">
        <div className="wiz-head">
          <span className="wiz-count">Step {step + 1} of 5 · {STEPS[step - 1]}</span>
          <WizBar at={step} />
        </div>

        {bootError && <div className="error">{bootError}</div>}
        {error && <div className="error">{error}</div>}

        {step === 1 && (
          <>
            <h1 className="wiz-q">What do you do, and where?</h1>
            <p className="wiz-sub">
              Areas decide who gets offered a cancelled slot. Someone outside
              them is never asked, however keen they are.
            </p>

            <div className="card stack">
              <label>
                Your trade
                <input value={trade} onChange={(e) => setTrade(e.target.value)}
                  placeholder="mobile car wash and detailing" />
              </label>
              <TradePicker value={trade} onPick={setTrade} />
            </div>

            {areas.length > 0 && (
              <div className="chips">
                {areas.map((a) => (
                  <span className="chip-x" key={a.id}>
                    {a.name}
                    <button type="button" aria-label={`Remove ${a.name}`}
                      onClick={() => { void removeArea(a.id); }}>×</button>
                  </span>
                ))}
              </div>
            )}

            <AddArea onAdded={(a) => setAreas((list) => [...list, a])} />
          </>
        )}

        {step === 2 && (
          <>
            <h1 className="wiz-q">What do you sell, and for how much?</h1>
            <p className="wiz-sub">
              How long a job takes is the important part: it decides which gaps
              that job can fill.
            </p>

            {services.map((s) => (
              <div className="card spread" key={s.id}>
                <div className="stack" style={{ gap: 2 }}>
                  <span className="name" style={{ fontSize: 15 }}>{s.name}</span>
                  <span className="muted">
                    {Math.round(s.duration_seconds / 60)} min
                    {s.cadence_days
                      ? ` · every ${Math.round(s.cadence_days / 7)} weeks`
                      : ' · one-off'}
                  </span>
                </div>
                <button type="button" className="btn quiet sm"
                  onClick={async () => {
                    try {
                      await api.deleteService(s.id);
                      setServices((list) => list.filter((x) => x.id !== s.id));
                    } catch (err) {
                      setError(message(err, 'Could not remove that.'));
                    }
                  }}>
                  Remove
                </button>
              </div>
            ))}

            <AddService trade={trade}
              existing={services.map((s) => s.name.toLowerCase())}
              onAdded={(s) => setServices((list) => [...list, s])} />
          </>
        )}

        {step === 3 && (
          <>
            <h1 className="wiz-q">When are you working?</h1>
            <p className="wiz-sub">
              Open slots are only ever found inside these hours, so nothing is
              ever offered on your day off.
            </p>
            <WorkingHours hours={hours} onChange={setHours} fallback={vanDay} />
          </>
        )}

        {step === 4 && (
          <>
            <h1 className="wiz-q">Put in the jobs you already have.</h1>
            <p className="wiz-sub">
              Two or three is enough to start. The app looks at the space
              between them and tells you which holes are worth filling.
            </p>

            {booked.length > 0 && (
              <div className="card stack" style={{ gap: 6 }}>
                <span className="eyebrow">Booked</span>
                {booked.map((b, i) => (
                  <span className="row" key={i} style={{ gap: 8 }}>
                    <Icon name="tick" size={16} stroke={2.4} />{b}
                  </span>
                ))}
              </div>
            )}

            <AddBooking services={services} tz={tz}
              onAdded={(label) => setBooked((list) => [...list, label])} />

            <p className="faint" style={{ margin: 0 }}>
              You can add the rest in the app later. Nothing here is final.
            </p>
          </>
        )}

        <div className="wiz-nav">
          {step > 1 && (
            <button className="btn quiet" onClick={() => { setError(null); setStep(step - 1); }}>
              <Icon name="back" size={18} /> Back
            </button>
          )}
          <button className="btn grow" onClick={() => { void next(); }} disabled={busy}>
            {busy ? 'Saving…' : step === 4 ? (booked.length === 0 ? 'Skip for now' : 'Finish') : 'Next'}
            <Icon name="arrow" size={18} />
          </button>
        </div>
      </div>
    </Shell>
  );
}

const WizBar = ({ at }: { at: number }) => (
  <div className="wiz-bar" role="presentation">
    {[0, 1, 2, 3, 4].map((i) => <i key={i} className={i <= at ? 'on' : undefined} />)}
  </div>
);

// ---------------------------------------------------------------------------

function AddArea({ onAdded }: { onAdded: (a: ServiceArea) => void }) {
  const [name, setName] = useState('');
  const [postcode, setPostcode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form className="card stack" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true); setError(null);
      try {
        const { area } = await api.createServiceArea({
          name: name.trim(), postcode: postcode.trim(),
        });
        onAdded(area);
        setName(''); setPostcode('');
      } catch (err) {
        setError(message(err, 'Could not add that area.'));
      } finally {
        setBusy(false);
      }
    }}>
      <span className="eyebrow">Add an area you cover</span>
      {error && <div className="error">{error}</div>}
      <div className="field-row">
        <label>Area name<input required value={name}
          onChange={(e) => setName(e.target.value)} placeholder="Santa Monica" /></label>
        <label>Postcode<input required value={postcode}
          onChange={(e) => setPostcode(e.target.value)} placeholder="90401" /></label>
      </div>
      <button className="btn ghost block" type="submit"
        disabled={busy || !name.trim() || !postcode.trim()}>
        <Icon name="plus" size={18} stroke={2} /> {busy ? 'Adding…' : 'Add area'}
      </button>
    </form>
  );
}

function AddService({ trade, existing, onAdded }: {
  trade: string | null;
  existing: string[];
  onAdded: (s: Service) => void;
}) {
  const [name, setName] = useState('');
  const [mins, setMins] = useState('120');
  const [price, setPrice] = useState('');
  const [weeks, setWeeks] = useState('');
  const [parts, setParts] = useState<PartsValue>(EMPTY_PARTS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only the jobs this trade actually does, minus anything already added.
  const starters = startersFor(trade).filter((x) => !existing.includes(x.name.toLowerCase()));

  return (
    <form className="card stack" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true); setError(null);
      const duration_seconds = Number(mins) * 60;
      const price_cents = price ? Math.round(Number(price) * 100) : 0;
      const cadence_days = weeks ? Number(weeks) * 7 : undefined;
      try {
        const { id } = await api.createService({
          name: name.trim(), duration_seconds, price_cents, cadence_days,
          ...partsPayload(parts),
        });
        onAdded({
          id, name: name.trim(), duration_seconds, price_cents,
          cadence_days: cadence_days ?? null, is_active: 1,
        });
        setName(''); setPrice(''); setParts(EMPTY_PARTS);
      } catch (err) {
        setError(message(err, 'Could not add that service.'));
      } finally {
        setBusy(false);
      }
    }}>
      <span className="eyebrow">Add a service</span>
      {error && <div className="error">{error}</div>}

      {starters.length > 0 && (
        <>
          <p className="muted" style={{ margin: 0 }}>
            Common {trade} jobs — tap one to fill it in, then set your price.
          </p>
          <div className="sug">
            {starters.map((x) => (
              <button key={x.name} type="button" className="sug-chip"
                onClick={() => {
                  setName(x.name);
                  setMins(String(x.mins));
                  setWeeks(x.weeks ? String(x.weeks) : '');
                  // Reset to the default rather than leaving the last tap's
                  // answer behind: filling in "Wash" after tapping "Screen
                  // replacement" must not quietly carry 'included' with it.
                  setParts({ ...EMPTY_PARTS, parts_policy: x.parts ?? 'none' });
                }}>
                {x.name}
                <span className="sug-min">{x.mins}m</span>
              </button>
            ))}
          </div>
        </>
      )}

      <label>Name<input required value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={starters[0]?.name ?? 'What you call this job'} /></label>
      <div className="field-row">
        <label>Minutes<input type="number" min="15" step="15" required value={mins}
          onChange={(e) => setMins(e.target.value)} /></label>
        <label>Price<input type="number" step="0.01" min="0" value={price}
          onChange={(e) => setPrice(e.target.value)} placeholder="0.00" /></label>
      </div>
      {/* "Include parts in your price" was the whole of the old answer, and it
          is wrong for most of the trades here: a mechanic cannot price a part
          before they see the car. The form now asks the question that has an
          answer, and the tax note lives inside it. */}
      <PartsPolicyField value={parts} onChange={setParts} />
      <label>Repeats every (weeks, blank for a one-off)
        <input type="number" min="1" value={weeks}
          onChange={(e) => setWeeks(e.target.value)} placeholder="4" />
      </label>
      <button className="btn ghost block" type="submit" disabled={busy || !name.trim() || !mins}>
        <Icon name="plus" size={18} stroke={2} /> {busy ? 'Adding…' : 'Add service'}
      </button>
    </form>
  );
}

function AddBooking({ services, tz, onAdded }: {
  services: Service[]; tz: string; onAdded: (label: string) => void;
}) {
  const [first, setFirst] = useState('');
  const [phone, setPhone] = useState('');
  const [postcode, setPostcode] = useState('');
  const [serviceId, setServiceId] = useState(services[0]?.id ?? '');
  const [date, setDate] = useState(() => addDays(todayIn(tz), 1));
  const [time, setTime] = useState('09:00');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const service = services.find((s) => s.id === serviceId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!service) { setError('Pick a service.'); return; }
    const starts_at = epochInZone(date, time, tz);
    if (Number.isNaN(starts_at)) { setError('That date and time did not make sense.'); return; }

    setBusy(true); setError(null);
    try {
      // Client first: the appointment has to hang off somebody, and the same
      // record is what later gets offered a cancelled slot.
      const { id: client_id } = await api.createClient({
        first_name: first.trim(),
        phone_e164: phone.trim() || undefined,
        postcode: postcode.trim() || undefined,
        default_service_id: serviceId,
        sms_consent: consent,
      });
      await api.createAppointment({
        client_id, service_id: serviceId,
        starts_at, ends_at: starts_at + service.duration_seconds,
        postcode: postcode.trim() || undefined,
      });
      onAdded(`${first.trim()} · ${service.name} · ${date} ${time}`);
      setFirst(''); setPhone(''); setPostcode(''); setConsent(false);
    } catch (err) {
      setError(message(err, 'Could not save that booking.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack" onSubmit={submit}>
      <span className="eyebrow">Add a booking</span>
      {error && <div className="error">{error}</div>}

      <div className="field-row">
        <label>First name<input required value={first}
          onChange={(e) => setFirst(e.target.value)} placeholder="Dana" /></label>
        <label>Mobile<input type="tel" value={phone}
          onChange={(e) => setPhone(e.target.value)} placeholder="Their mobile" /></label>
      </div>

      <label>Postcode
        <input value={postcode} onChange={(e) => setPostcode(e.target.value)} placeholder="90401" />
        <span className="faint">Used to work out the drive between jobs.</span>
      </label>

      <label>Service
        <select value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {Math.round(s.duration_seconds / 60)} min
            </option>
          ))}
        </select>
      </label>

      <div className="field-row">
        <label>Date<input type="date" required value={date}
          onChange={(e) => setDate(e.target.value)} /></label>
        <label>Start time<input type="time" required value={time}
          onChange={(e) => setTime(e.target.value)} /></label>
      </div>

      <label style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
        <input type="checkbox" checked={consent} style={{ width: 20, minHeight: 20 }}
          onChange={(e) => setConsent(e.target.checked)} />
        <span style={{ color: 'var(--ink)' }}>They agreed to receive texts</span>
      </label>
      <p className="faint" style={{ margin: 0 }}>
        Only tick that if they actually said yes. Without it they are never
        texted about an open slot.
      </p>

      <button className="btn ghost block" type="submit"
        disabled={busy || !first.trim() || !service}>
        <Icon name="plus" size={18} stroke={2} /> {busy ? 'Saving…' : 'Add booking'}
      </button>
    </form>
  );
}
