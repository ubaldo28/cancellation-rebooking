import { useEffect, useRef } from 'react';
import type { MapArea } from '../api';

/**
 * A real map: OpenStreetMap data, rendered by MapLibre GL.
 *
 * Tiles come from OpenFreeMap — no API key, no account, no request cap, and
 * commercial use is allowed, which is what rules out Google and Mapbox at this
 * stage and rules out hammering OSM's own raster tiles at any stage. MapLibre
 * draws the required attribution itself, so it is not duplicated in the page.
 *
 * MapLibre is loaded from a CDN in index.html rather than bundled, so this
 * component reads it off `window` and degrades to a plain list if the script
 * has not arrived.
 */

declare global {
  interface Window { maplibregl?: any }
}

const STYLE = 'https://tiles.openfreemap.org/styles/positron';

/** Framing the corridor leaves room on the right, where the labels hang. */
const FIT = { padding: { top: 60, bottom: 60, left: 50, right: 150 }, maxZoom: 12.4 };

const still = () => typeof window !== 'undefined'
  && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

export interface CityMapProps {
  areas: MapArea[];
  selected: string | null;
  onSelect: (slug: string) => void;
}

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

  // --- create once ---------------------------------------------------------
  useEffect(() => {
    const gl = window.maplibregl;
    if (!gl || !host.current || map.current) return;

    const m = new gl.Map({
      container: host.current,
      style: STYLE,
      // The Valley corridor, Calabasas to Burbank. fitBounds takes over once
      // the areas arrive; this is only what shows during the first paint.
      center: [-118.47, 34.18],
      zoom: 10.2,
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
    const gl = window.maplibregl;
    const m = map.current;
    if (!gl || !m || areas.length === 0) return;

    for (const marker of markers.current.values()) marker.remove();
    markers.current.clear();

    // Labels collide once the corridor is this long. Only the busiest few
    // carry a name and a price; the rest are dots until they are chosen or
    // hovered, which is what a map does when it runs out of room.
    const labelled = new Set(
      [...areas].filter((a) => a.slot_count > 0)
        .sort((a, b) => b.slot_count - a.slot_count)
        .slice(0, 5)
        .map((a) => a.slug),
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

    const b = new gl.LngLatBounds();
    for (const a of areas) b.extend([a.lng, a.lat]);
    shot.current = b;

    // A hidden pane has no width, and fitting to a zero-width canvas produces
    // a zoom nobody asked for. The observer above re-frames it on the way in.
    const el = host.current;
    if (el && el.clientWidth > 0 && el.clientHeight > 0) {
      m.fitBounds(b, { ...FIT, duration: still() ? 0 : 400 });
    }
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
    const area = areas.find((a) => a.slug === selected);
    const el = host.current;
    if (area && map.current && el && el.clientWidth > 0) {
      map.current.easeTo({
        center: [area.lng, area.lat],
        duration: still() ? 0 : 550,
        padding: { right: 120 },
      });
    }
  }, [selected, areas]);

  if (!window.maplibregl) {
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
