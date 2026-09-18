import { useEffect, useRef } from 'react';
import { api, type LiveVan, type MapArea } from '../api';
import { prefersReducedMotion } from '../lib/motion';
import { MAP_STYLE, useMapLib } from '../lib/map';
import { buildCars, carAt, type Car } from '../lib/cars';
import { vehicleArt } from './vehicleArt';

/**
 * A real map: OpenStreetMap data, rendered by MapLibre GL.
 *
 * Tiles come from OpenFreeMap — no API key, no account, no request cap, and
 * commercial use is allowed, which is what rules out Google and Mapbox at this
 * stage and rules out hammering OSM's own raster tiles at any stage. MapLibre
 * draws the required attribution itself, so it is not duplicated in the page.
 *
 * WHERE MAPLIBRE COMES FROM, AND WHY THE ANSWER CHANGED. It used to be a
 * `<script defer>` in index.html pointing at unpkg.com, and this component read
 * the `window.maplibregl` that script left behind. Because the tag lived in the
 * SPA shell, that 800 kB fetch — and the visitor's IP and User-Agent reaching a
 * third party with it — was paid on every route, including the majority that
 * never draw a map. The library is a dependency now and `useMapLib()` fetches
 * it from this origin, in a chunk of its own, the first time this component is
 * mounted. See web/src/lib/map.ts.
 *
 * The practical difference inside this file is one of timing rather than of
 * shape: `gl` is null for a beat on a cold visit, so every effect that touches
 * the library lists it as a dependency and bails while it is null, and runs
 * again — properly, once — when the chunk lands.
 */

/** Framing a corridor leaves room on the right, where the labels hang. */
const FIT = { padding: { top: 60, bottom: 60, left: 50, right: 150 }, maxZoom: 12.4 };

/** How many pins in a metro carry a name and a price before labels collide. */
const LABELS = 5;

/**
 * How often the map asks who is out.
 *
 * Twenty seconds. A van in traffic moves a couple of hundred metres in that
 * time, which at this zoom is a visible slide rather than a jump, and the ease
 * between fixes covers the gap. Faster buys nothing a viewer can see: the
 * position it would be asking for is itself only refreshed every
 * MIN_PING_SECONDS at the other end, so most extra polls would return the same
 * fix and spend a request finding that out.
 */
const LIVE_EVERY_MS = 20_000;

/**
 * How long the ease between two fixes takes.
 *
 * Slightly longer than the poll, so a vehicle is still moving when the next
 * fix lands and the motion never visibly stops and restarts. Overshoot is
 * impossible because the ease is clamped at the destination.
 */
const EASE_MS = 22_000;

/** Where a live vehicle should be drawn right now, between its last two fixes. */
function easeNow(
  v: { fromLng: number; fromLat: number; toLng: number; toLat: number; at: number },
  t: number,
): { lng: number; lat: number } {
  const raw = Math.min(1, Math.max(0, (t - v.at) / EASE_MS));
  // Eased out only. A vehicle that is already moving should not appear to
  // start from rest every twenty seconds, but it should settle rather than
  // slam into the new fix.
  const p = 1 - (1 - raw) * (1 - raw);
  return {
    lng: v.fromLng + (v.toLng - v.fromLng) * p,
    lat: v.fromLat + (v.toLat - v.fromLat) * p,
  };
}

/** Compass bearing from one point to another, or null if they are the same. */
function bearing(
  fromLat: number, fromLng: number, toLat: number, toLng: number,
): number | null {
  const dLng = toLng - fromLng;
  const dLat = toLat - fromLat;
  if (Math.abs(dLng) < 1e-9 && Math.abs(dLat) < 1e-9) return null;
  return (Math.atan2(dLng, dLat) * 180) / Math.PI;
}

export interface CityMapProps {
  areas: MapArea[];
  selected: string | null;
  onSelect: (slug: string) => void;
  /**
   * Show vehicles on this map. Off by default: a small locator map does not
   * need them and a polling request behind one nobody is looking at is waste.
   * On for the big map on the front page, where the vehicles are the point.
   */
  cars?: boolean;
  /**
   * Called with true while the map is showing the ILLUSTRATED fleet rather
   * than live vehicles, so the page can put up the line that says so — and
   * take it down the moment somebody real is out.
   *
   * Lifted to the page rather than drawn here because the note belongs over
   * the map's frame, which is the page's element, not the canvas.
   */
  onIllustrated?: (on: boolean) => void;
}


/**
 * THE MAP FRAMES ONE METRO AT A TIME, and this is the part of the component
 * the second place broke.
 *
 * Fitting the bounds of every pin was right while every pin was in one valley.
 * Round The Way now covers two places a hundred and fifty miles apart, and a shot
 * wide enough to hold both is a shot of the Central Coast with two specks on
 * it: no street, no neighbourhood, nothing a visitor can act on. So the camera
 * frames the metro the chosen neighbourhood is in, and choosing one in the
 * other metro re-frames onto that one. The pins for the rest are still on the
 * map for anybody who pans there; they are simply not what the shot is of.
 */
const metroOf = (areas: MapArea[], slug: string | null): string | null =>
  (areas.find((a) => a.slug === slug) ?? areas[0])?.metro ?? null;

export default function CityMap({
  areas, selected, onSelect, cars = false, onIllustrated,
}: CityMapProps) {
  // Held in a ref so the effect below does not tear down and rebuild the whole
  // vehicle layer every time the page passes a new closure.
  const noteCb = useRef(onIllustrated);
  noteCb.current = onIllustrated;
  const setNote = useRef((on: boolean) => noteCb.current?.(on)).current;

  // The library, and how its fetch is going. `gl` is null until the chunk has
  // arrived, which on a cold visit is a beat after the first render, so it is a
  // dependency of every effect below that builds anything with it.
  const { gl, state: glState } = useMapLib();

  const host = useRef<HTMLDivElement | null>(null);
  const map = useRef<any>(null);
  const markers = useRef<Map<string, any>>(new Map());
  // Kept in a ref so the marker click handlers never close over a stale prop.
  const pick = useRef(onSelect);
  pick.current = onSelect;

  // What the map should be framing. Held so the pane can be hidden, resized
  // and shown again without losing the shot.
  const shot = useRef<any>(null);
  const sized = useRef(false);
  /**
   * The metro the current shot is of, so a selection inside it can be an
   * ease across a few miles while one in another metro is a re-frame. Null
   * until something has been framed, which is what makes the first pass a
   * frame rather than an ease.
   */
  const framed = useRef<string | null>(null);

  const focus = metroOf(areas, selected);

  /**
   * The areas as of this render, for the one effect that runs before any
   * dependency of it can have changed. MapLibre wants a centre at
   * construction and the honest one is wherever the first shot is going to
   * be; a hardcoded pair of coordinates here is a second place that has to be
   * edited when the product opens somewhere new.
   */
  const latest = useRef(areas);
  latest.current = areas;

  // --- create once ---------------------------------------------------------
  useEffect(() => {
    if (!gl || !host.current || map.current) return;

    // The nearest neighbourhood the page has, which is the first row the map
    // request returns and is in the metro that is about to be framed.
    // fitBounds takes over in the same commit, so this is only what shows
    // during the first paint — but it is a point in the right place rather
    // than a pair of coordinates that would have to be edited the next time
    // the product opens somewhere new.
    const first = latest.current[0];

    const m = new gl.Map({
      container: host.current,
      style: MAP_STYLE,
      center: first ? [first.lng, first.lat] : [0, 0],
      zoom: first ? 10.2 : 1,
      attributionControl: { compact: true },
    });
    m.addControl(new gl.NavigationControl({ showCompass: false }), 'top-right');
    m.scrollZoom.disable();          // a map that eats the page scroll is a menace
    map.current = m;

    return () => { m.remove(); map.current = null; markers.current.clear(); };
    // Created once — but `gl` is null on the first pass of a cold visit, so
    // this has to be allowed to run a second time, when there is a library to
    // build with. `map.current` above is what keeps it to one map either way.
  }, [gl]);

  // --- the pane it lives in changes width, and disappears entirely ---------
  //
  // On a phone the list and the map swap places, and on a desktop the map is a
  // column that resizes with the window. MapLibre measures its container once
  // and never again, so without this the canvas keeps whatever size it had the
  // first time it was painted — which, coming back from the list, is nothing.
  useEffect(() => {
    const el = host.current;
    if (!el || typeof ResizeObserver === 'undefined') return;

    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      const m = map.current;
      if (!m || !box) return;

      if (box.width < 1 || box.height < 1) { sized.current = false; return; }
      m.resize();
      // Only when it has just come back from nothing. Re-framing on every
      // window resize would throw away a pan the visitor had made on purpose.
      if (!sized.current && shot.current) {
        m.fitBounds(shot.current, { ...FIT, duration: 0 });
      }
      sized.current = true;
    });

    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // --- markers follow the data --------------------------------------------
  useEffect(() => {
    const m = map.current;
    if (!gl || !m || areas.length === 0) return;

    for (const marker of markers.current.values()) marker.remove();
    markers.current.clear();

    // Labels collide once a corridor is this long. Only the busiest few carry
    // a name and a price; the rest are dots until they are chosen or hovered,
    // which is what a map does when it runs out of room.
    //
    // Counted per metro rather than across the whole map. The busiest five
    // anywhere can all be in one place, and the shot is of one metro at a
    // time, so a site-wide top five would leave the other metro's pins
    // unlabelled on the one screen where they are the only thing visible.
    const labelled = new Set(
      [...new Set(areas.map((a) => a.metro))].flatMap((metro) =>
        areas.filter((a) => a.metro === metro && a.slot_count > 0)
          .sort((a, b) => b.slot_count - a.slot_count)
          .slice(0, LABELS)
          .map((a) => a.slug)),
    );

    for (const area of areas) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `mk${area.slot_count > 0 ? '' : ' mk-quiet'}`;
      el.setAttribute('aria-label',
        `${area.name}, ${area.slot_count} open ${area.slot_count === 1 ? 'slot' : 'slots'}`);
      el.title = area.slot_count > 0
        ? `${area.name} · ${area.slot_count} open${area.from_price ? ` · from ${area.from_price}` : ''}`
        : `${area.name} · nothing open`;
      // Remembered so selection can reveal a label without losing which ones
      // were meant to be hidden.
      el.dataset.labelled = labelled.has(area.slug) ? '1' : '0';
      el.innerHTML = `
        <span class="mk-dot">${area.slot_count > 0 ? area.slot_count : ''}</span>
        <span class="mk-text${labelled.has(area.slug) ? '' : ' mk-hide'}">
          <span class="mk-name">${escapeHtml(area.name)}</span>
          ${area.from_price ? `<span class="mk-price">from ${escapeHtml(area.from_price)}</span>` : ''}
        </span>`;
      el.addEventListener('click', (e) => { e.stopPropagation(); pick.current(area.slug); });

      const marker = new gl.Marker({ element: el, anchor: 'left' })
        .setLngLat([area.lng, area.lat])
        .addTo(m);
      markers.current.set(area.slug, marker);
    }

    // A new set of pins is a new shot, whichever metro it turns out to be of.
    framed.current = null;
  }, [areas, gl]);

  // --- the vehicles --------------------------------------------------------
  //
  // TWO SOURCES, AND THE MAP IS ALWAYS EXPLICIT ABOUT WHICH IT IS SHOWING.
  //
  //   LIVE, and this is the real thing: /api/public/live returns the actual
  //   position of every operator who has switched location sharing on and is
  //   out working. Real fixes from real phones, coarsened server side to about
  //   110 m and carrying no identity — a rotating handle so the browser can
  //   move a dot rather than replace it, and nothing else. Polled, and eased
  //   between fixes so a vehicle drives across the map instead of jumping.
  //
  //   ILLUSTRATED, only while this deployment is still showing sample
  //   businesses. Sample businesses have no phones, so nothing can ping and
  //   the live list is always empty; drawing nothing would say "nobody works
  //   here" about a demonstration. So the drawn fleet runs instead, and the
  //   map says in plain words that is what it is.
  //
  // The moment one real operator is out, the drawn fleet stops and the map is
  // showing people. The note goes with it, because it is no longer true.
  useEffect(() => {
    const m = map.current;
    const el = host.current;
    // No vehicles asked for means no markers AND no polling. A locator map in
    // a sidebar must not put a request on the wire every twenty seconds.
    if (!gl || !m || !el || !cars) return;

    let dead = false;
    let poll = 0;
    let frame = 0;
    let running = false;
    const started = performance.now();

    /** Live vans, keyed by the rotating handle, holding where to ease from. */
    const live = new Map<string, {
      marker: any; el: HTMLElement; kind: string;
      fromLng: number; fromLat: number; toLng: number; toLat: number;
      deg: number; at: number;
    }>();
    /** The drawn fleet, when there is nothing live to show. */
    let drawn: { car: Car; marker: any; el: HTMLElement }[] = [];

    const node = (kind: string) => {
      const art = vehicleArt(kind);
      const d = document.createElement('div');
      d.className = 'van';
      d.setAttribute('aria-hidden', 'true');
      // Sized to the drawing. Every vehicle is the same WIDTH — a car and a
      // van are the same across on a real road — and it is the height that
      // differs, which is the whole of what tells them apart at this size.
      d.style.width = `${art.w}px`;
      d.style.height = `${art.h}px`;
      d.innerHTML = art.svg;
      return d;
    };
    const turn = (host: HTMLElement, deg: number) =>
      (host.firstElementChild as HTMLElement | null)
        ?.style.setProperty('transform', `rotate(${deg}deg)`);

    const clearDrawn = () => {
      for (const d of drawn) d.marker.remove();
      drawn = [];
    };

    /** Put the illustrated fleet up. Only ever called on a sample deployment. */
    const showDrawn = () => {
      if (drawn.length > 0 || prefersReducedMotion() || areas.length < 2) return;
      for (const car of buildCars(areas, focus)) {
        const d = node(car.kind);
        const at = carAt(car, 0);
        const marker = new gl.Marker({ element: d, anchor: 'center' })
          .setLngLat([at.lng, at.lat]).addTo(m);
        drawn.push({ car, marker, el: d });
      }
      setNote(drawn.length > 0);
    };

    /** Reconcile the live set against a fresh poll. */
    const apply = (list: LiveVan[]) => {
      const seen = new Set<string>();
      for (const v of list) {
        seen.add(v.ref);
        const held = live.get(v.ref);
        if (held) {
          // Ease from wherever it is being drawn right now, not from the last
          // fix — otherwise a poll that lands mid-ease snaps the vehicle back.
          const p = easeNow(held, performance.now());
          held.fromLng = p.lng; held.fromLat = p.lat;
          held.toLng = v.lng; held.toLat = v.lat;
          held.at = performance.now();
          // A phone that reports a heading is believed. One that does not gets
          // the bearing of the leg it is driving, which is the same answer for
          // anything that is actually moving.
          held.deg = v.heading ?? bearing(p.lat, p.lng, v.lat, v.lng) ?? held.deg;
          continue;
        }
        const d = node(v.kind);
        const marker = new gl.Marker({ element: d, anchor: 'center' })
          .setLngLat([v.lng, v.lat]).addTo(m);
        live.set(v.ref, {
          marker, el: d, kind: v.kind,
          fromLng: v.lng, fromLat: v.lat, toLng: v.lng, toLat: v.lat,
          deg: v.heading ?? 0, at: performance.now(),
        });
        turn(d, v.heading ?? 0);
      }
      // Gone: switched off, went offline, stopped pinging, or the handle
      // rotated. All four mean the same thing here — that dot is not a claim
      // we can still make.
      for (const [ref, held] of live) {
        if (seen.has(ref)) continue;
        held.marker.remove();
        live.delete(ref);
      }
      if (live.size > 0) { clearDrawn(); setNote(false); }
    };

    const tick = (t: number) => {
      if (live.size > 0) {
        for (const v of live.values()) {
          const p = easeNow(v, t);
          v.marker.setLngLat([p.lng, p.lat]);
          turn(v.el, v.deg);
        }
      } else {
        const secs = (t - started) / 1000;
        for (const d of drawn) {
          const p = carAt(d.car, secs);
          d.marker.setLngLat([p.lng, p.lat]);
          turn(d.el, p.deg);
        }
      }
      frame = requestAnimationFrame(tick);
    };

    const start = () => {
      if (running) return;
      running = true;
      frame = requestAnimationFrame(tick);
    };
    const stop = () => {
      if (!running) return;
      running = false;
      cancelAnimationFrame(frame);
    };

    const read = async () => {
      if (dead) return;
      try {
        const res = await api.live();
        if (dead) return;
        apply(res.vans);
        // Nothing live. On a real deployment that is the honest picture and
        // the map stays empty; on the sample one it means no phone exists to
        // ping, so the drawn fleet stands in and says so.
        if (res.vans.length === 0) {
          if (res.demo) showDrawn(); else { clearDrawn(); setNote(false); }
        }
      } catch {
        // A failed poll changes nothing: the vehicles already on the map keep
        // easing to their last known fix and the next poll corrects them.
      }
    };

    // Off screen or in a background tab is nobody watching: no animation frame
    // and no request. A map nobody is looking at should cost nothing.
    let onScreen = typeof IntersectionObserver === 'undefined';
    const settle = () => {
      const watching = onScreen && !document.hidden;
      if (watching) {
        start();
        if (!poll) {
          void read();
          poll = window.setInterval(() => void read(), LIVE_EVERY_MS);
        }
      } else {
        stop();
        if (poll) { clearInterval(poll); poll = 0; }
      }
    };

    const io = onScreen ? null : new IntersectionObserver(
      (e) => { onScreen = !!e[0]?.isIntersecting; settle(); },
      { threshold: 0.01 },
    );
    io?.observe(el);
    document.addEventListener('visibilitychange', settle);
    settle();

    return () => {
      dead = true;
      stop();
      if (poll) clearInterval(poll);
      io?.disconnect();
      document.removeEventListener('visibilitychange', settle);
      for (const v of live.values()) v.marker.remove();
      live.clear();
      clearDrawn();
    };
  }, [areas, focus, cars, setNote, gl]);

  // --- selection is a class, not a rebuild --------------------------------
  useEffect(() => {
    for (const [slug, marker] of markers.current) {
      const el = marker.getElement() as HTMLElement;
      const on = slug === selected;
      el.classList.toggle('on', on);
      // The chosen neighbourhood shows its name even if it was too quiet to
      // earn a permanent label; every other pin goes back to how it started.
      const keepHidden = el.dataset.labelled !== '1' && !on;
      el.querySelector('.mk-text')?.classList.toggle('mk-hide', keepHidden);
      el.style.zIndex = on ? '5' : '';
    }
    const m = map.current;
    const el = host.current;
    if (!gl || !m) return;
    // A hidden pane has no width, and fitting or easing on a zero-width canvas
    // produces a zoom nobody asked for. The shot is still worked out and
    // remembered; the observer above applies it on the way back in.
    const visible = !!el && el.clientWidth > 0 && el.clientHeight > 0;

    if (focus !== framed.current) {
      // A different metro, so what changes is the shot and not the centre:
      // easing to a pin a hundred and fifty miles away at neighbourhood zoom
      // is a long slide over farmland ending on a map of the wrong scale.
      framed.current = focus;
      const here = areas.filter((a) => a.metro === focus);
      if (here.length > 0) {
        const b = new gl.LngLatBounds();
        for (const a of here) b.extend([a.lng, a.lat]);
        shot.current = b;
        if (visible) m.fitBounds(b, { ...FIT, duration: prefersReducedMotion() ? 0 : 400 });
      }
      return;
    }

    const area = areas.find((a) => a.slug === selected);
    if (area && visible) {
      m.easeTo({
        center: [area.lng, area.lat],
        duration: prefersReducedMotion() ? 0 : 550,
        padding: { right: 120 },
      });
    }
  }, [selected, areas, focus, gl]);

  // ONLY ON 'failed', AND THAT IS THE WHOLE POINT OF THE THIRD STATE.
  //
  // This used to read `if (!mapLib())`, which was right while the library was a
  // CDN script that had either already run or was never going to: by the time
  // React rendered anything, the answer was final. A dynamic import is absent
  // for a moment on every cold visit, so the same test would put "The map could
  // not load" in front of every single visitor for a frame before the map drew.
  // While it is still coming, the canvas below renders instead — which it has
  // to anyway, because MapLibre needs that element in the document before it
  // can be pointed at it.
  if (glState === 'failed') {
    return (
      // Every opening the map would have pinned is already on the page as a
      // card — beside this column on a desktop, above it on a phone — so the
      // sentence says the list exists without claiming a direction it only
      // has at one width.
      <div className="map-fallback">
        <p>The map could not load. Every opening it would show is in the list
          of cards on this page.</p>
      </div>
    );
  }

  return <div className="map-canvas" ref={host} />;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
  ));
}
