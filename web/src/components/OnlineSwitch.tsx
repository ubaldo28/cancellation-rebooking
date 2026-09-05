import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, clockTime, shortDate } from '../api';
import { useOperator } from '../App';
import { formatMoney } from '../lib/format';
import '../styles-online.css';

/**
 * "I'm open for work right now" — the switch, and the jobs it brings in.
 *
 * This is not the working-hours calendar and it must never read like one. It
 * is the operator standing in a van at 20:40 with a free hour, saying so out
 * loud. Everything below follows from four rules the product owner set, and
 * every one of them is a promise to somebody:
 *
 *   - It turns itself off after three hours. An operator who forgets they are
 *     live and gets a job while asleep stops trusting the switch, and a switch
 *     nobody trusts gets left off. So the countdown is on screen the whole
 *     time and the rule is stated BEFORE the flip, not discovered after it.
 *   - Accepting a job turns it off. One job at a time; they are now driving.
 *   - Nothing is ever auto-assigned. A job that lands on somebody without
 *     their tap is a job that gets abandoned on a doorstep.
 *   - Five minutes to answer, then it goes to somebody else. That is short,
 *     so the countdown — not the price, not the name — is the biggest thing
 *     on a pending card.
 *
 * Two structural decisions worth knowing before editing:
 *
 *   - Every countdown is anchored to the moment we FETCHED it, using the
 *     server's seconds_left, never to an absolute timestamp compared against
 *     the device clock. A van phone with a clock ten minutes out would
 *     otherwise show a five-minute window as already dead, or as fifteen
 *     minutes long. The server owns the clock; we only decrement.
 *   - Every interval is cleared in its effect's return. This component polls
 *     on a timer, so a leaked interval is not untidiness — it is a background
 *     request loop running on a phone that has navigated away.
 */

/* The shapes the Worker returns. Declared locally rather than imported so this
   file leans on the api surface only, and structurally identical either way. */
interface OnlineStatus {
  online: boolean;
  until: number | null;
  since: number | null;
  seconds_left: number;
  radius_meters: number;
}

interface PendingRequest {
  id: string;
  guest_name: string;
  service_name: string | null;
  starts_at: number;
  duration_seconds: number;
  price_cents: number;
  currency: string;
  address_line: string | null;
  note: string | null;
  seconds_left: number;
}

/* How often we ask for new work while live. Ten seconds is the cost of the
   five-minute rule: a request that arrives just after a poll already loses a
   sixth of its life before the operator ever sees it, and anything slower eats
   more of a window they cannot get back. */
const POLL_MS = 10_000;

/* The last minute is the urgent one. Below this a card changes colour and the
   clock counts alone — an operator glancing at a phone on a passenger seat
   has to feel the difference without reading it. */
const URGENT_S = 60;

/* m:ss, always two digits on the seconds. A request window is measured in
   minutes and read at arm's length, so this is the clock face people already
   know from a microwave rather than a prose duration. */
const mmss = (seconds: number) => {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/*
 * How long the switch has left. Coarse while there is plenty — nobody needs
 * seconds at two hours out — and m:ss under five minutes, because that is the
 * point where "do I flip it on again" becomes a decision rather than trivia.
 * Minutes are floored, not rounded: "1h 60m" is the classic rounding bug and
 * it makes the whole readout look broken.
 */
const switchLeft = (seconds: number) => {
  const s = Math.max(0, Math.ceil(seconds));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 300) return `${Math.floor(s / 60)}m`;
  return mmss(s);
};

export default function OnlineSwitch() {
  const op = useOperator();

  const [status, setStatus] = useState<OnlineStatus | null>(null);
  const [requests, setRequests] = useState<PendingRequest[]>([]);
  // Anchors: wall-clock ms at the moment each seconds_left was true.
  const [statusAt, setStatusAt] = useState(() => Date.now());
  const [requestsAt, setRequestsAt] = useState(() => Date.now());
  // Requests that ran out while the operator was looking at them. Kept on
  // screen deliberately — a card that silently vanishes reads as a bug, and
  // the operator needs to know the job existed and why they lost it.
  const [gone, setGone] = useState<Array<{ id: string; name: string }>>([]);
  const [now, setNow] = useState(() => Date.now());
  const [toggling, setToggling] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Polls in flight outlive the screen: an operator taps through to a job and
  // the response lands on an unmounted component. Guarded rather than
  // cancelled because the request itself is harmless — only the setState is.
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  // Read inside a fetch callback, so it has to be a ref: a poll that started
  // before a request expired would otherwise resurrect the card it belongs to.
  const goneIds = useRef<Set<string>>(new Set());

  const loadStatus = useCallback(async () => {
    try {
      const s = await api.onlineStatus();
      if (!mounted.current) return;
      setStatus(s);
      setStatusAt(Date.now());
      setError(null);
    } catch (e) {
      if (!mounted.current) return;
      setError(e instanceof ApiError ? e.message
        : 'Could not check whether you are online. Check your signal and try again.');
    } finally {
      if (mounted.current) setLoaded(true);
    }
  }, []);

  const loadRequests = useCallback(async () => {
    try {
      const res = await api.pendingRequests();
      if (!mounted.current) return;
      // Drop anything already dead on arrival as well as anything we have
      // buried. Rendering a card with a countdown at zero would give the
      // operator an Accept button that cannot possibly work.
      setRequests(res.requests.filter(
        (r: PendingRequest) => r.seconds_left > 0 && !goneIds.current.has(r.id),
      ));
      setRequestsAt(Date.now());
    } catch {
      // A failed poll is not worth an error box: the next one is ten seconds
      // away, and a red banner blinking on and off in a moving van is worse
      // than nothing. Failures that matter are the ones on a tap, below.
    }
  }, []);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  const online = status?.online === true;

  /* Seconds remaining, derived from the anchor rather than stored, so there is
     exactly one clock in this component and nothing can drift out of step. */
  const secondsOnline = status ? status.seconds_left - (now - statusAt) / 1000 : 0;
  const leftFor = (r: PendingRequest) => r.seconds_left - (now - requestsAt) / 1000;

  // The one-second heartbeat that makes every countdown move. Only runs when
  // something is actually counting: re-rendering this screen once a second
  // while the operator is off is a battery cost with nothing on the other side.
  const counting = online || requests.length > 0;
  useEffect(() => {
    if (!counting) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [counting]);

  // The work poll. Starts with an immediate fetch because the gap between
  // flipping the switch and the first tick is otherwise ten dead seconds on a
  // screen that has just promised to show incoming jobs.
  useEffect(() => {
    if (!online) { setRequests([]); return; }
    void loadRequests();
    const id = setInterval(() => { void loadRequests(); }, POLL_MS);
    return () => clearInterval(id);
  }, [online, loadRequests]);

  // Our local countdown hitting zero is a prediction, not a fact — the server
  // owns the three hours. So we re-ask instead of flipping ourselves off, and
  // the ref stops that becoming one request per second on a bad connection.
  const expiryAsked = useRef(false);
  useEffect(() => {
    if (!online || secondsOnline > 0) { expiryAsked.current = false; return; }
    if (expiryAsked.current) return;
    expiryAsked.current = true;
    void loadStatus();
  }, [online, secondsOnline, loadStatus]);

  // Bury requests whose five minutes ran out while they were on screen. Done
  // in an effect rather than during render because it moves state, but the
  // list rendered below filters on the same clock, so a card is never drawn
  // with a countdown at zero even for the one frame before this runs.
  useEffect(() => {
    const dead = requests.filter((r) => leftFor(r) <= 0);
    if (dead.length === 0) return;
    for (const d of dead) goneIds.current.add(d.id);
    setGone((g) => [
      ...dead.map((d) => ({ id: d.id, name: d.guest_name })),
      ...g.filter((x) => !dead.some((d) => d.id === x.id)),
    ]);
    setRequests((rs) => rs.filter((r) => !dead.some((d) => d.id === r.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, requests]);

  const toggle = async () => {
    setToggling(true); setError(null);
    try {
      const s = online ? await api.goOffline() : await api.goOnline();
      if (!mounted.current) return;
      setStatus(s);
      setStatusAt(Date.now());
      // Flipping on is a fresh start: yesterday's misses are not news.
      if (s.online) { setGone([]); goneIds.current.clear(); }
    } catch (e) {
      if (mounted.current) {
        setError(e instanceof ApiError ? e.message
          : 'That did not go through. Check your signal and try again.');
      }
    } finally {
      if (mounted.current) setToggling(false);
    }
  };

  /*
   * Accept and decline share one busy flag across the whole list, not one per
   * card. A double tap on Accept is the obvious hazard, but so is accepting
   * one job and declining another in the same second on a bouncing phone —
   * and since accepting takes the operator offline, the second tap would be
   * answering a job they can no longer take.
   */
  const answer = async (r: PendingRequest, accept: boolean) => {
    if (busy) return;
    setBusy(r.id); setError(null);
    try {
      if (accept) await api.acceptRequest(r.id); else await api.declineRequest(r.id);
      // Off the list immediately, whichever way it went: this one is decided,
      // and leaving it up for another poll cycle invites a second tap.
      goneIds.current.add(r.id);
      if (mounted.current) setRequests((rs) => rs.filter((x) => x.id !== r.id));
      // Re-fetch rather than assume. Accepting turns the switch off server
      // side, and the switch on screen has to agree with that within a second
      // or the operator is left thinking they are still taking work.
      await loadStatus();
      await loadRequests();
    } catch (e) {
      if (mounted.current) {
        setError(e instanceof ApiError ? e.message
          : 'That did not go through. Check your signal and try again.');
      }
      // Let it come back on the next poll if the tap never landed — better a
      // reappearing card than a job silently dropped.
      goneIds.current.delete(r.id);
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  if (!loaded) return null;

  const live = requests.filter((r) => leftFor(r) > 0);

  return (
    <section className="online">
      <div className={`online-panel${online ? ' is-on' : ''}`}>
        <div className="online-state">
          {online ? 'You are open for work' : 'You are off right now'}
        </div>

        {online ? (
          <>
            {/* The whole reason this screen exists: never let an operator be
                unsure whether they are live, or for how much longer. */}
            <div className="online-left mono">On for {switchLeft(secondsOnline)}</div>
            <p className="online-sub">
              Jobs near you can reach you now.
              {status?.until != null && <> It switches itself off at {clockTime(status.until, op)}.</>}
            </p>
          </>
        ) : (
          <>
            <p className="online-sub">
              Nothing can reach you until you turn this on. It has nothing to do
              with your opening hours — this is just for right now.
            </p>
            {/* The rules are stated before the flip. An operator who learns
                about the three hours by going quiet at 23:00 blames us, and
                they would be right to. */}
            <ul className="online-rules">
              <li>
                <strong>It turns itself off after 3 hours.</strong> If you are
                still free then, turn it on again.
              </li>
              <li>
                <strong>Nothing lands on you by itself.</strong> A job shows up
                here and you tap Accept, or it does not happen.
              </li>
              <li>
                <strong>You get 5 minutes to answer each one.</strong> After
                that it goes to somebody else.
              </li>
            </ul>
          </>
        )}

        <button
          className={`btn block online-toggle${online ? ' quiet' : ''}`}
          type="button"
          disabled={toggling}
          onClick={() => void toggle()}
        >
          {toggling
            ? (online ? 'Turning off…' : 'Turning on…')
            : (online ? 'Turn it off' : "I'm open for work right now")}
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      {/* Said plainly, and kept until they dismiss it. "It vanished" is what
          an operator remembers; "it went to somebody else because I had five
          minutes" is what changes what they do next time. */}
      {gone.map((g) => (
        <div key={g.id} className="online-gone">
          <p>
            <strong>{g.name}’s job went to somebody else.</strong>{' '}
            The 5 minutes ran out before it was accepted.
          </p>
          <button className="btn quiet sm" type="button"
            onClick={() => setGone((rest) => rest.filter((x) => x.id !== g.id))}>
            Got it
          </button>
        </div>
      ))}

      {online && live.length === 0 && (
        <p className="online-waiting">
          Nothing yet. Leave this page open — a job will show up here the moment
          one comes in near you.
        </p>
      )}

      {live.map((r) => {
        const left = leftFor(r);
        const urgent = left <= URGENT_S;
        // Every button in the list locks while any answer is in flight; this
        // card also shows which one is being answered.
        const acting = busy === r.id;
        return (
          <article key={r.id} className={`req${urgent ? ' is-urgent' : ''}`}>
            <div className="req-top">
              <span className={`chip ${urgent ? 'warn' : 'good'}`}>Needs your answer</span>
            </div>

            {/* Countdown first and biggest. Price and name matter, but a job
                answered at 5:01 is worth nothing at all. */}
            <div className={`req-clock mono${urgent ? ' is-urgent' : ''}`}>{mmss(left)}</div>
            <div className="req-clock-label">
              {urgent
                ? 'Under a minute left — answer now or it goes to somebody else.'
                : 'left to accept before it goes to somebody else'}
            </div>

            <div className="req-who">{r.guest_name}</div>
            <div className="req-what">{r.service_name ?? 'Job'}</div>

            <dl className="req-facts">
              <dt>When</dt>
              <dd>
                {shortDate(r.starts_at, op)} · {clockTime(r.starts_at, op)} ·{' '}
                {Math.max(1, Math.round(r.duration_seconds / 60))} min
              </dd>
              <dt>Where</dt>
              <dd>{r.address_line ?? 'Address comes through once you accept'}</dd>
              <dt>Pays</dt>
              <dd className="req-price">{formatMoney(r.price_cents, r.currency)}</dd>
            </dl>

            {r.note && <p className="req-note">“{r.note}”</p>}

            <div className="req-actions">
              <button className="btn" type="button" disabled={busy !== null}
                onClick={() => void answer(r, true)}>
                {acting ? 'Accepting…' : 'Accept this job'}
              </button>
              <button className="btn quiet" type="button" disabled={busy !== null}
                onClick={() => void answer(r, false)}>
                Not this one
              </button>
            </div>

            <p className="req-foot">
              Accepting turns your switch off — one job at a time. Declining
              costs you nothing.
            </p>
          </article>
        );
      })}
    </section>
  );
}
