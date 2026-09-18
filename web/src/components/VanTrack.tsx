import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type TrackView } from '../api';
// Imported here as well as in Watch.tsx: this component is meant to sit inside
// the guest thread page, which knows nothing about the alerts stylesheet.
import '../styles-alerts.css';
import { prefersReducedMotion } from '../lib/motion';
import { MAP_STYLE, useMapLib } from '../lib/map';


/**
 * Where the van is, for the customer waiting on it.
 *
 * Nearly every state of this component is "nothing to show", and that is the
 * normal case, not a fault: the window only opens on the day, shortly before
 * the appointment, and only if the business chose to share its position at
 * all. So each reason gets its own sentence. A map that is blank, or a spinner
 * that never resolves, tells a person waiting on their driveway nothing.
 */

/** Frequent enough to feel live, cheap enough to leave open on a phone. */
const POLL_MS = 30_000;

/**
 * Why the van is not on screen, in words.
 *
 * The windows quoted here are the ones the Worker actually enforces in
 * src/lib/track.ts: ninety minutes before the start, thirty minutes after the
 * end, and a fix older than ten minutes counts as stale.
 */
const REASONS: Record<string, string> = {
  no_thread: 'This link no longer opens a booking, so there is nothing to follow.',
  no_appointment: 'Nothing is booked yet. Tracking starts once a time is confirmed.',
  cancelled: 'This appointment was cancelled, so nobody is on the way.',
  not_sharing: 'This business does not share their location.',
  not_today: 'Your appointment is not today. Open this page on the day to follow the van.',
  outside_window:
    'Tracking starts about ninety minutes before your appointment and stops half '
    + 'an hour after it ends.',
  no_position: 'The van has not sent its position yet today.',
  stale: 'The last position is more than ten minutes old, so it is not worth showing. '
    + 'Phone signal is usually the reason.',
  no_destination: 'There is no address on this booking, so there is nothing to measure to.',
};

const UNKNOWN_REASON = 'The van cannot be shown right now.';

export interface VanTrackProps {
  /**
   * Which conversation this van is coming to, in the form the Worker's path
   * wants: the token out of a /c/:token link, or the thread id when a
   * signed-in customer opened it from their account. See the long note on
   * `ref` above guestMessagePhotoUrl in api.ts for why one parameter carries
   * both and why it is not called `token` any more.
   */
  threadRef: string;
}

export default function VanTrack({ threadRef }: VanTrackProps) {
  const [view, setView] = useState<TrackView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback(async (quiet: boolean) => {
    if (!quiet) { setLoading(true); setError(null); }
    try {
      setView(await api.trackCustomer(threadRef));
      setError(null);
    } catch (e) {
      // A dropped poll while the phone changes cell is not news. Only the
      // first read is allowed to put an error on screen; after that the last
      // known answer stays up and the next poll tries again.
      if (!quiet) setError(e instanceof Error ? e.message : 'Could not check where the van is.');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [threadRef]);

  useEffect(() => { void read(false); }, [read]);

  // Polling only while the tab is being looked at. This page sits open on a
  // phone on a kitchen counter for an hour; a timer that keeps running there
  // costs the Worker a request every thirty seconds for nobody.
  useEffect(() => {
    let timer: number | undefined;
    const stop = () => {
      if (timer !== undefined) { window.clearInterval(timer); timer = undefined; }
    };
    const start = () => { stop(); timer = window.setInterval(() => { void read(true); }, POLL_MS); };
    const onVisibility = () => {
      // Coming back, the position on screen may be minutes old, so read at
      // once rather than waiting out the rest of an interval.
      if (document.visibilityState === 'visible') { void read(true); start(); } else stop();
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [read]);

  if (loading && !view) {
    return (
      <section className="card vt" aria-busy="true">
        <h3 className="vt-title">On the way</h3>
        <p className="vt-quiet">Checking where the van is…</p>
      </section>
    );
  }

  if (error && !view) {
    return (
      <section className="card vt">
        <h3 className="vt-title">On the way</h3>
        <p className="vt-quiet">{error}</p>
        <button type="button" className="btn quiet sm" onClick={() => void read(false)}>
          Try again
        </button>
      </section>
    );
  }

  if (!view || !view.visible) {
    return (
      <section className="card vt">
        <h3 className="vt-title">On the way</h3>
        <p className="vt-quiet">{(view && REASONS[view.reason]) ?? UNKNOWN_REASON}</p>
      </section>
    );
  }

  return (
    <section className="card vt">
      <div className="spread">
        <h3 className="vt-title">On the way</h3>
        <span className="chip good">Moving</span>
      </div>

      <div className="vt-figures">
        <div className="vt-figure">
          <b className="num">{etaLabel(view.eta_seconds)}</b>
          <span>until they reach you</span>
        </div>
        <div className="vt-figure">
          <b className="num">{distanceLabel(view.distance_meters)}</b>
          <span>away right now</span>
        </div>
      </div>

      <VanMap lat={view.lat} lng={view.lng} />

      <p className="vt-quiet" aria-live="polite">
        Moving, {agoLabel(view.recorded_at)}. The position is rounded to about
        110 metres and only shows while they are on their way to you.
      </p>
    </section>
  );
}

/**
 * The van, on a map.
 *
 * Only the van. The tracking payload carries the van's position, the driving
 * time and the distance, but not the coordinates of the address it is heading
 * to, so there is no honest way to draw the destination pin — see the note in
 * the report. The figures above the map carry the "how far" half instead.
 *
 * MapLibre is a dependency fetched in a chunk of its own, exactly as the
 * discover map's is, so this reaches it through `useMapLib()` and renders
 * nothing at all until the chunk lands — the figures above carry the page on
 * their own, which is why there is no fallback sentence here.
 *
 * IT USED TO COME FROM unpkg.com, as a script in the SPA shell, which meant
 * this page — the one a customer opens on their driveway, on a phone, on
 * whatever signal the street has — paid for it in the head before it could
 * paint, and so did every page that has no map on it at all. Now nothing is
 * fetched until a van is actually being shown, and what is fetched comes from
 * this origin. See web/src/lib/map.ts.
 */
function VanMap({ lat, lng }: { lat: number; lng: number }) {
  const host = useRef<HTMLDivElement | null>(null);
  const map = useRef<any>(null);
  const marker = useRef<any>(null);
  // Null until the map chunk has arrived, so it is a dependency of the effect
  // that builds the map and the gate on rendering the element at all.
  const { gl } = useMapLib();

  useEffect(() => {
    if (!gl || !host.current || map.current) return;

    const m = new gl.Map({
      container: host.current,
      style: MAP_STYLE,
      center: [lng, lat],
      zoom: 13.5,
      attributionControl: { compact: true },
      // Nobody is exploring on this map; they are glancing at it. Keeping it
      // still also stops it swallowing the page scroll on a phone.
      interactive: false,
    });
    map.current = m;

    const el = document.createElement('div');
    el.className = 'vt-van';
    el.setAttribute('aria-hidden', 'true');
    marker.current = new gl.Marker({ element: el }).setLngLat([lng, lat]).addTo(m);

    // Created once, on purpose: the effect below moves the marker instead.
    // Re-running this on every new fix would re-download the map style twice a
    // minute. lat/lng are read here only for the first frame.
    return () => { m.remove(); map.current = null; marker.current = null; };
    // `gl` is the one dependency, and it changes at most once: null on the
    // first pass, the library on the second. lat and lng are deliberately not
    // here — see above.
  }, [gl]);

  // A new fix moves the marker and the frame; it does not rebuild anything.
  useEffect(() => {
    if (!marker.current || !map.current) return;
    marker.current.setLngLat([lng, lat]);
    map.current.easeTo({ center: [lng, lat], duration: prefersReducedMotion() ? 0 : 700 });
  }, [lat, lng]);

  // MapLibre measures its container once. Mounted inside a card that is itself
  // revealed by a poll, that measurement can happen at zero width.
  //
  // `gl` is a dependency because the element this observes does not exist until
  // the library has arrived — the component renders null before that. Run once
  // on mount and it would find no element, bail, and never look again, leaving
  // a map that keeps whatever size the card happened to have when it appeared.
  useEffect(() => {
    const el = host.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => map.current?.resize());
    ro.observe(el);
    return () => ro.disconnect();
  }, [gl]);

  // Nothing while the chunk is still coming, and nothing if it never does. The
  // figures above the map already say how far away the van is and how long it
  // will be, so an empty frame or an apology would add nothing a person waiting
  // on their driveway can use.
  if (!gl) return null;
  return (
    <div className="vt-map" ref={host}
      role="img" aria-label="Map showing where the van is now" />
  );
}

// ---------------------------------------------------------------------------

/** Drive time, in the words a person would use for it. */
function etaLabel(seconds: number): string {
  if (seconds < 90) return 'A minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** The Worker already rounds this to the nearest hundred metres. */
function distanceLabel(meters: number): string {
  if (meters < 1000) return `${meters} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

/** How old the fix is. Anything over ten minutes never reaches this. */
function agoLabel(recordedAt: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - recordedAt);
  if (seconds < 45) return 'a moment ago';
  const minutes = Math.round(seconds / 60);
  return minutes <= 1 ? '1 minute ago' : `${minutes} minutes ago`;
}
