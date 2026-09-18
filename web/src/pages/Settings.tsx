import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, type Service } from '../api';
import { useOperator, useSession } from '../App';
import CloseAccount from '../components/CloseAccount';
import PaymentMethod from '../components/PaymentMethod';
import VehicleForm from '../components/VehicleForm';
import PayoutSetup from '../components/PayoutSetup';
import PartsPolicyField, {
  EMPTY_PARTS, partsPayload, type PartsValue,
} from '../components/PartsPolicyField';
import WorkingHours, {
  DAY_NAMES, blankDay, backwardsDays, hhmm, hoursPayload, type DayHours,
} from '../components/WorkingHours';
import { ErrorNote, Icon, Spinner } from '../components/ui';
import { useDocumentTitle } from '../lib/title';

/**
 * How many people a wave may go to at once.
 *
 * The Worker writes every settable column straight through with no range check
 * of its own, so this is the only guard there is — and the field it guards is
 * an <input type="number"> an operator can empty, which makes Number('') zero.
 * A saved zero is silent and total: FillSlot preselects nobody, the wave button
 * sits disabled, and nothing about the screen says why.
 */
const WAVE_MIN = 1;
const WAVE_MAX = 10;

export default function Settings() {
  useDocumentTitle('Settings');
  const op = useOperator();
  const { refresh, signOut } = useSession();

  const [hours, setHours] = useState<Record<number, DayHours>>({});
  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [savingHours, setSavingHours] = useState(false);

  /**
   * One timer for the "Saved." line, cleared on unmount and before each new
   * message.
   *
   * There were three bare setTimeout calls here. Two saves inside two and a
   * half seconds meant the first one's timer wiped the second one's message
   * early, and leaving Settings while one was pending set state on a screen
   * that no longer existed.
   */
  const flashTimer = useRef<number | undefined>(undefined);
  const flash = useCallback((text: string) => {
    window.clearTimeout(flashTimer.current);
    setSaved(text);
    flashTimer.current = window.setTimeout(() => setSaved(null), 2500);
  }, []);
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [w, s] = await Promise.all([api.workingHours(), api.services()]);
      const map: Record<number, DayHours> = {};
      for (let d = 0; d < 7; d++) map[d] = blankDay();
      for (const h of w.working_hours) {
        map[h.weekday] = { on: true, start: hhmm(h.start_minute), end: hhmm(h.end_minute) };
      }
      setHours(map);
      setServices(s.services);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function saveHours() {
    setError(null);
    // hoursPayload drops any day that ends before it starts rather than sending
    // it, which used to mean an operator who typed Monday 17:00 to 09:00 was
    // told "Working hours saved." and lost Monday. The save is refused instead,
    // naming the day, because a silently missing weekday is a day of openings
    // that never go up.
    const backwards = backwardsDays(hours);
    if (backwards.length > 0) {
      setError(backwards.length === 1
        ? `${backwards[0]} ends before it starts. Fix that time and save again.`
        : `${backwards.join(' and ')} end before they start. Fix those times and `
          + 'save again.');
      return;
    }
    setSavingHours(true);
    try {
      await api.setWorkingHours(hoursPayload(hours));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
      setSavingHours(false);
      return;
    }
    // The hours are saved by this point. A failed re-detect is a stale gap
    // list, not a lost save, and reporting it as "Could not save" sent
    // operators back to retype a week that was already stored.
    try {
      await api.detectGaps(14);
      flash('Working hours saved.');
    } catch {
      flash('Working hours saved. Your open slots will catch up shortly.');
    } finally {
      setSavingHours(false);
    }
  }

  async function saveSetting(patch: Record<string, unknown>, label: string) {
    setError(null);
    try {
      await api.updateSettings(patch);
      await refresh();
      flash(label);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    }
  }

  if (loading) return <><header className="page-head"><h1>Settings</h1></header><Spinner /></>;

  return (
    <>
      <header className="page-head"><h1>Settings</h1></header>

      <main className="main stack-lg">
        {error && <ErrorNote error={error} onRetry={load} />}
        {saved && <div className="notice">{saved}</div>}

        {/* First on the page, because an operator whose openings are down is
            looking for the reason, and this is one of the three things that
            takes them down. */}
        <PayoutSetup />

        {/* Directly under it, and above everything about how the business
            works, for the same reason: an operator hunting for why nobody can
            find them should meet the switch that decides it before they meet
            their own discount settings. It is also the one control here that
            reaches every public page at once, so burying it among the
            preferences would be a lie about its weight. */}
        <TakingBookings />

        <VehicleForm />

        <section className="stack">
          <span className="eyebrow">Working hours</span>
          <p className="muted" style={{ margin: 0 }}>
            Open slots are only ever found inside these hours.
          </p>
          <WorkingHours hours={hours} onChange={setHours} />
          <button className="btn block" onClick={saveHours} disabled={savingHours}>
            {savingHours ? 'Saving…' : 'Save working hours'}
          </button>
        </section>

        <section className="stack">
          <span className="eyebrow">Filling slots</span>

          <label className="card" style={{ padding: 14 }}>
            How many people to ask at once
            {/* min and max on the element alone are decoration: this field is
                in no <form>, so nothing ever validates it, and the value went
                to the Worker exactly as typed. An emptied box saved nought
                people per wave. The value is put back to whatever is stored
                rather than left showing a number that was not accepted. */}
            <input type="number" min={WAVE_MIN} max={WAVE_MAX}
              defaultValue={op?.offers_per_wave ?? 3}
              onBlur={(e) => {
                const current = op?.offers_per_wave ?? 3;
                const typed = Number(e.target.value);
                if (!Number.isFinite(typed) || e.target.value.trim() === ''
                    || typed < WAVE_MIN || typed > WAVE_MAX) {
                  e.target.value = String(current);
                  setError(`Ask between ${WAVE_MIN} and ${WAVE_MAX} people at once.`);
                  return;
                }
                const whole = Math.round(typed);
                e.target.value = String(whole);
                if (whole === current) return;
                setError(null);
                void saveSetting({ offers_per_wave: whole }, 'Saved.');
              }} />
            <span className="faint">First to confirm gets the slot.</span>
          </label>

          <label className="card" style={{ padding: 14 }}>
            Most extra driving you will accept
            <select defaultValue={String(op?.max_detour_seconds ?? 900)}
              onChange={(e) => saveSetting({ max_detour_seconds: Number(e.target.value) }, 'Saved.')}>
              <option value="300">5 minutes</option>
              <option value="600">10 minutes</option>
              <option value="900">15 minutes</option>
              <option value="1800">30 minutes</option>
              <option value="3600">an hour</option>
            </select>
            <span className="faint">
              Anyone further out of your way than this is never offered the slot.
            </span>
          </label>

          <label className="card" style={{ padding: 14 }}>
            Gap in the day worth filling
            <select defaultValue={String(op?.min_gap_seconds ?? 3600)}
              onChange={(e) => saveSetting({ min_gap_seconds: Number(e.target.value) }, 'Saved.')}>
              <option value="1800">30 minutes or more</option>
              <option value="3600">1 hour or more</option>
              <option value="7200">2 hours or more</option>
            </select>
          </label>

          <label className="card" style={{ padding: 14 }}>
            Discount on a last-minute slot
            <select defaultValue={String(op?.discount_percent ?? 0)}
              onChange={(e) => saveSetting({ discount_percent: Number(e.target.value) }, 'Saved.')}>
              <option value="0">No discount</option>
              <option value="10">10% off</option>
              <option value="15">15% off</option>
              <option value="20">20% off</option>
            </select>
            <span className="faint">
              Discounting every time trains people to wait for one.
            </span>
          </label>
        </section>

        <section className="stack">
          <span className="eyebrow">Services</span>
          {services.length === 0 && (
            <p className="muted" style={{ margin: 0 }}>
              No services yet. A service sets how long a job takes and how often
              it repeats — that is what decides who is due.
            </p>
          )}
          {services.map((s) => (
            <div className="card spread" key={s.id}>
              <div className="stack" style={{ gap: 2 }}>
                <span className="name" style={{ fontSize: 15 }}>{s.name}</span>
                <span className="muted">
                  {Math.round(s.duration_seconds / 60)} min
                  {s.cadence_days ? ` · every ${Math.round(s.cadence_days / 7)} weeks` : ' · does not repeat'}
                </span>
              </div>
            </div>
          ))}
          <AddService onDone={load} />
        </section>

        <section className="stack">
          <span className="eyebrow">Your location</span>
          <label className="card row" style={{ padding: 14, gap: 12 }}>
            <input type="checkbox" style={{ width: 20, minHeight: 20 }}
              defaultChecked={op?.share_location === 1}
              onChange={async (e) => {
                try {
                  await api.shareLocation(e.target.checked);
                  await refresh();
                  setSaved(e.target.checked ? 'Sharing on.' : 'Sharing off.');
                  setTimeout(() => setSaved(null), 2500);
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Could not save.');
                }
              }} />
            <span className="stack" style={{ gap: 3 }}>
              <span style={{ color: 'var(--ink)', fontWeight: 600 }}>
                Show that you are out and working
              </span>
              {/* THE CONSENT TEXT, and it has to name BOTH things this switch
                  does. It used to say only the first, which was true until the
                  front page got a map. A person ticking a box is agreeing to
                  what the box says, so the box says all of it. */}
              <span className="faint">
                While you are free, a vehicle shows on the map on the front
                page — no name, no link, no trail, and rounded so nobody can
                tell which street. The moment a job is booked you come off that
                map, and instead the customer whose job it is sees roughly
                where you are, from 90 minutes before their slot until 30
                after. Never both at once. It stops on its own ten minutes
                after you close the app. Off unless you turn it on.
              </span>
            </span>
          </label>
        </section>

        {/* Above the account block because a missing card is one of the three
            things that takes an operator's openings down, and somebody hunting
            for that reason should not have to scroll past "sign out" to find
            it. */}
        <PaymentMethod />

        {/* WHY THESE TWO LINKS ARE HERE.
            /app/profile and /app/credentials both existed as routes with
            nothing in the app pointing at them: the profile was reachable only
            from the last screen of the sign-up wizard, which an operator sees
            once and never again, and the licence page was reachable from
            nowhere at all. Both are settings about the business a customer
            reads before booking, so they belong on the screen an operator opens
            when they want to change one. */}
        <section className="stack">
          <span className="eyebrow">Your public page</span>
          <Link to="/app/profile" className="card spread" style={{ color: 'inherit' }}>
            <div className="stack" style={{ gap: 2 }}>
              <span className="name" style={{ fontSize: 15 }}>Profile and photos</span>
              <span className="muted">
                What a customer reads before they let you onto their drive.
              </span>
            </div>
            <Icon name="arrow" size={18} color="var(--muted)" />
          </Link>
          <Link to="/app/credentials" className="card spread" style={{ color: 'inherit' }}>
            <div className="stack" style={{ gap: 2 }}>
              <span className="name" style={{ fontSize: 15 }}>Licence and insurance</span>
              <span className="muted">
                What your trade requires, and what you hold. Missing details
                keep your page private.
              </span>
            </div>
            <Icon name="arrow" size={18} color="var(--muted)" />
          </Link>
        </section>

        {/* Here, and not up beside the pause switch, although both of them
            send an operator somewhere other than their own dashboard. This one
            is about the person holding the account rather than about the
            business being listed, which is what the two sections under it are
            as well — and a control that opens another identity sitting a
            centimetre from the one that unlists you is two chances to press
            the wrong thing. */}
        <BookSomebody />

        <section className="stack">
          <span className="eyebrow">Account</span>
          <div className="card stack" style={{ gap: 4 }}>
            <span className="name" style={{ fontSize: 15 }}>{op?.business_name}</span>
            <span className="muted">{op?.email}</span>
            <span className="muted">{op?.country} · {op?.timezone} · {op?.currency}</span>
          </div>
          <button className="btn quiet block" onClick={signOut}>Sign out</button>
        </section>

        {/* Last on the page, and in its own section rather than beside "Sign
            out". The two are one tap apart in every settings screen ever
            built, and only one of them can be undone by signing back in. */}
        <CloseAccount />
      </main>
    </>
  );
}

/**
 * Listed, or paused.
 *
 * `accept_public_bookings` has been read by the map, the search pages, the
 * browse lists, the profile pages and the alert sweep since the beginning and
 * settable by nobody, so a business that wanted to stop being found for a
 * fortnight had no way to say so: the only thing left was to delete openings
 * one at a time and hope none went back up. This is that one write.
 *
 * THE SENTENCE ABOUT BOOKED WORK IS THE POINT OF THE WHOLE CARD, not a
 * footnote on it. A switch labelled "stop taking bookings" reads, to somebody
 * with three jobs on Saturday, as though it might cancel them — so it is never
 * pressed by the people who most need it, and the ones who do press it spend
 * the evening wondering what they have just done to a customer. It is said
 * next to the switch, in both states, before the tap.
 *
 * It is a section of its own rather than another row in "Filling slots"
 * because everything in that section changes who gets offered a gap; this
 * changes whether the business exists on the public side at all.
 */
function TakingBookings() {
  const op = useOperator();
  const { refresh } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const on = op?.accept_public_bookings === 1;

  async function flip() {
    setBusy(true);
    setError(null);
    try {
      await api.updateSettings({ accept_public_bookings: !on });
      // The switch is drawn from the stored operator record and from nothing
      // else, so it only moves once the server says it has. Moving it
      // optimistically and putting it back on a failure is how a business ends
      // up reading "Paused" off this screen while the map still has them on it,
      // which is the one wrong answer this control must never give.
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message
        : 'That did not save. Check your signal and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="stack">
      <span className="eyebrow">Your listing</span>
      <div className="card stack">
        <div className="taking-row">
          {/* role="switch" and not a checkbox: this is a thing with two
              settings that takes effect on the tap, not a box that is ticked
              and then saved with everything else on the page, and a screen
              reader says "on"/"off" for one and "ticked"/"unticked" for the
              other. The name comes from the heading beside it rather than from
              the line underneath, which changes with the state — a control
              whose name changes as you use it is a different control every
              time it is announced. */}
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-labelledby="taking-label"
            aria-busy={busy || undefined}
            disabled={busy}
            className={`taking-switch${on ? ' is-on' : ''}`}
            onClick={() => void flip()}
          >
            <span className="taking-track"><span className="taking-knob" /></span>
          </button>
          <span className="stack" style={{ gap: 2 }}>
            <span id="taking-label" className="name" style={{ fontSize: 15 }}>
              Taking bookings
            </span>
            {/* The state in words, not only in the position of the knob and
                certainly not only in its colour. Whether a business is findable
                is the single fact on this screen that has to survive a bad
                screen, a bright windscreen and colour blindness. */}
            <span className="muted">
              {busy ? 'Saving…' : on
                ? 'On. You show on the map, in search and in browse, and your '
                  + 'openings can be booked.'
                : 'Paused. You are off the map, out of search and out of '
                  + 'browse, and nothing new can be booked.'}
            </span>
          </span>
        </div>

        <p className="faint" style={{ margin: 0 }}>
          {on
            ? 'Turn it off while you are away, full up or off the road. Nothing '
              + 'is deleted — your openings, your prices and your page are all '
              + 'still here.'
            : 'Turn it back on and you are listed again straight away.'}
        </p>

        <div className="notice">
          <strong>Work already booked is not affected.</strong> Anybody who has
          already booked and paid keeps their appointment, and you still owe
          them the job. This only stops new bookings coming in.
        </div>

        {error && <div className="error" role="alert">{error}</div>}
      </div>
    </section>
  );
}

/**
 * The business as somebody's customer.
 *
 * A detailer needs a locksmith, and until the Worker grew this route there was
 * nowhere in the product for a business to be the one doing the booking — they
 * would have had to sign up again, at a second mailbox, as a stranger.
 *
 * NOBODY IS SIGNED OUT BY THIS. The two session cookies have different names,
 * so the customer one is set alongside the operator one and both are live
 * afterwards: this browser is a business and a customer at the same time. That
 * is why the copy can promise the way back, and why there is no confirmation
 * step in front of it — nothing here is given up.
 *
 * IT LANDS ON THE PUBLIC SITE AND NOT ON /account. The button's whole promise
 * is booking somebody, and /account is a customer's own bookings — which, the
 * first time this is ever pressed, is an empty page. Sending somebody to an
 * empty page is how a feature gets tried once.
 */
function BookSomebody() {
  const op = useOperator();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openCustomerSide() {
    setBusy(true);
    setError(null);
    try {
      await api.enterCustomerMode();
      navigate('/');
      // `busy` is deliberately not cleared here. The route is already changing
      // and a button that goes back to reading "Open the customer side" in the
      // frame before it does is an invitation to press it twice.
    } catch (e) {
      // The Worker's own sentence, word for word. It refuses for two reasons a
      // browser cannot tell apart — no email address on the business at all, or
      // an address that already belongs to a different business here — and each
      // of those refusals carries the thing to do about it. Writing our own
      // line would throw that away and would guess at which one happened.
      setError(e instanceof ApiError ? e.message
        : 'Could not open the customer side. Check your signal and try again.');
      setBusy(false);
    }
  }

  return (
    <section className="stack">
      <span className="eyebrow">Booking somebody yourself</span>
      <div className="card stack">
        <p style={{ margin: 0 }}>
          <strong>Need a trade yourself?</strong> Trades book other trades — a
          detailer needs a locksmith like anybody else.
        </p>
        <p className="faint" style={{ margin: 0 }}>
          This opens the customer side of the site on{' '}
          {op?.email ?? 'your business email address'}. You are not leaving your
          business account: it stays signed in on this browser, so going to /app
          puts you straight back in it.
        </p>

        {error && <div className="error" role="alert">{error}</div>}

        <div>
          <button className="btn" type="button" disabled={busy}
            onClick={() => void openCustomerSide()}>
            {busy ? 'Opening…' : 'Open the customer side'}
          </button>
        </div>
      </div>
    </section>
  );
}

function AddService({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [mins, setMins] = useState('120');
  const [price, setPrice] = useState('');
  const [weeks, setWeeks] = useState('4');
  const [parts, setParts] = useState<PartsValue>(EMPTY_PARTS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button className="btn ghost block" onClick={() => setOpen(true)}>
        <Icon name="plus" size={18} stroke={2} /> Add a service
      </button>
    );
  }

  return (
    <form className="card stack" onSubmit={async (e) => {
      e.preventDefault();
      // A service with no length fits no gap and is offered to nobody, and an
      // emptied number field is Number('') — nought — not a missing value. The
      // element's own min="15" never runs, because the browser only validates a
      // field a form submit passes through, and this one is checked below
      // before anything is sent.
      const minutes = Number(mins);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        setError('How many minutes does this take? A service with no length is '
          + 'never offered to anybody.');
        return;
      }
      setBusy(true); setError(null);
      try {
        await api.createService({
          name,
          duration_seconds: Math.round(minutes) * 60,
          price_cents: price ? Math.round(Number(price) * 100) : 0,
          cadence_days: weeks ? Number(weeks) * 7 : undefined,
          ...partsPayload(parts),
        });
        setOpen(false); setName(''); setPrice(''); setParts(EMPTY_PARTS);
        onDone();
      } catch (err) {
        // There was no catch here at all: a rejected save left an unhandled
        // promise in the console, the form open with everything still in it,
        // and not one word on screen about why the service had not appeared in
        // the list above. The form keeping what was typed is the right half of
        // that; saying what happened is the half that was missing.
        setError(err instanceof Error ? err.message : 'Could not add that service.');
      } finally { setBusy(false); }
    }}>
      {error && <div className="error">{error}</div>}
      <label>Name<input required value={name} onChange={(e) => setName(e.target.value)}
        placeholder="Full detail" /></label>
      <div className="field-row">
        <label>Minutes<input type="number" min="15" step="15" value={mins}
          onChange={(e) => setMins(e.target.value)} /></label>
        <label>Price<input type="number" step="0.01" value={price}
          onChange={(e) => setPrice(e.target.value)} /></label>
      </div>
      {/* Telling an operator to "include parts in your price" was the whole
          of the old answer, and it is wrong for most of the trades here: a
          mechanic cannot price a part before they see the car. The form now
          asks the question that actually has an answer. */}
      <PartsPolicyField value={parts} onChange={setParts} />
      <label>Repeats every (weeks, blank if never)
        <input type="number" min="0" value={weeks} onChange={(e) => setWeeks(e.target.value)} />
      </label>
      <div className="field-row">
        <button type="button" className="btn quiet" onClick={() => setOpen(false)}>Cancel</button>
        <button className="btn" type="submit" disabled={busy || !name.trim()}>
          {busy ? 'Saving…' : 'Add'}
        </button>
      </div>
    </form>
  );
}
