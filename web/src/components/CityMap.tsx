import { useEffect, useRef } from 'react';
import type { MapArea } from '../api';
import { prefersReducedMotion } from '../lib/motion';
import { MAP_STYLE, mapLib } from '../lib/map';

/**
 * A real map: OpenStreetMap data, rendered by MapLibre GL.
 *
 * Tiles come from OpenFreeMap — no API key, no account, no request cap, and
 * commercial use is allowed, which is what rules out Google and Mapbox at this
 * stage and rules out hammering OSM's own raster tiles at any stage. MapLibre
 * draws the required attribution itself, so it is not duplicated in the page.
 *
 * MapLibre is loaded from a CDN in index.html rather than bundled, so this
 * component reaches it through `mapLib()` and degrades to a plain list if the
 * script has not arrived.
 */

/** Framing a corridor leaves room on the right, where the labels hang. */
const FIT = { padding: { top: 60, bottom: 60, left: 50, right: 150 }, maxZoom: 12.4 };

/** How many pins in a metro carry a name and a price before labels collide. */
const LABELS = 5;

export interface CityMapProps {
  areas: MapArea[];
  selected: string | null;
  onSelect: (slug: string) => void;
}

/**
 * THE MAP FRAMES ONE METRO AT A TIME, and this is the part of the component
 * the second place broke.
 *
 * Fitting the bounds of every pin was right while every pin was in one valley.
 * Slotfill now covers two places a hundred and fifty miles apart, and a shot
 * wide enough to hold both is a shot of the Central Coast with two specks on
 * it: no street, no neighbourhood, nothing a visitor can act on. So the camera
 * frames the metro the chosen neighbourhood is in, and choosing one in the
 * other metro re-frames onto that one. The pins for the rest are still on the
 * map for anybody who pans there; they are simply not what the shot is of.
 */
const metroOf = (areas: MapArea[], slug: string | null): string | null =>
  (areas.find((a) => a.slug === slug) ?? areas[0])?.metro ?? null;

export default function CityMap({ areas, selected, onSelect }: CityMapProps) {
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
    const gl = mapLib();
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
  }, []);

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
    const gl = mapLib();
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
  }, [areas]);

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
    const gl = mapLib();
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
  }, [selected, areas, focus]);

  if (!mapLib()) {
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
