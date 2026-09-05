import { api } from '../api';

/**
 * Sends the operator's position while they are working.
 *
 * Deliberately conservative. This is the highest-write path in the product, so
 * it only runs when the operator has switched sharing on, only while the tab
 * is visible, and only once a minute no matter how often the browser offers a
 * new fix — `watchPosition` fires several times a second while moving, and a
 * van cannot travel far enough in a minute to change an ETA measured in
 * minutes. The Worker drops anything faster still, so a bug here costs a read
 * rather than a write.
 *
 * This interval is the single biggest cost lever in the product. It is the
 * only path that writes on a timer rather than when a person does something,
 * so doubling it halves the largest line on the bill.
 */
const EVERY_MS = 60_000;

export function startPinging(): () => void {
  if (!('geolocation' in navigator)) return () => {};

  let watchId: number | null = null;
  let lastSent = 0;
  let stopped = false;

  const send = (pos: GeolocationPosition) => {
    const t = Date.now();
    if (t - lastSent < EVERY_MS) return;
    lastSent = t;
    void api.trackPing({
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracy_meters: pos.coords.accuracy ?? null,
      heading: Number.isFinite(pos.coords.heading) ? pos.coords.heading : null,
      speed_mps: Number.isFinite(pos.coords.speed) ? pos.coords.speed : null,
      recorded_at: Math.floor(pos.timestamp / 1000),
      // A dropped ping is not worth telling anyone about; the next one is 30s away.
    }).catch(() => {});
  };

  const begin = () => {
    if (stopped || watchId !== null) return;
    watchId = navigator.geolocation.watchPosition(send, () => {}, {
      enableHighAccuracy: true,
      maximumAge: 15_000,
      timeout: 20_000,
    });
  };

  const end = () => {
    if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  };

  // A backgrounded tab has no business holding the GPS on.
  const onVisibility = () => (document.visibilityState === 'visible' ? begin() : end());

  document.addEventListener('visibilitychange', onVisibility);
  onVisibility();

  return () => {
    stopped = true;
    document.removeEventListener('visibilitychange', onVisibility);
    end();
  };
}
