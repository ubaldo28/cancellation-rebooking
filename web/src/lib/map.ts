import { useEffect, useState } from 'react';

/**
 * The one map style URL, and the one place MapLibre GL is loaded.
 *
 * WHAT THIS FILE USED TO DO, AND WHY IT NO LONGER DOES IT.
 *
 * MapLibre used to arrive as a `<script defer>` in web/index.html pointing at
 * unpkg.com, and this file's whole job was to read the global that script left
 * behind: `window.maplibregl`, declared here so TypeScript would accept it, and
 * handed to both components through a `mapLib()` that returned null when the
 * script had not turned up. It was a reasonable shape for a CDN script. It also
 * meant every visitor to every page fetched 800 kB of map library from a third
 * party before the page could finish parsing — on the front page, on a cost
 * guide, on the terms of service, on the guest booking page, most of which draw
 * no map at all. Their IP address and User-Agent reached unpkg.com either way,
 * which in a GDPR market is a data transfer nobody consented to and nothing on
 * the page needed.
 *
 * The library is a dependency now (`maplibre-gl` in web/package.json, pinned to
 * the same 5.24.0 the CDN URL named), and it is loaded the way a dependency
 * that most pages do not need should be: by a dynamic import, from this origin,
 * the first time a component that actually draws a map asks for it. Nothing is
 * fetched on a page with no map on it. Nothing is fetched from anyone else.
 *
 * WHY THE LOADER LIVES HERE RATHER THAN IN THE TWO COMPONENTS. CityMap.tsx and
 * VanTrack.tsx can both be on screen at once is not the reason — they cannot —
 * but they can both be visited in one session, and a module-level cache is what
 * makes the second one instant instead of a second round trip. Keeping the
 * import in one place is also what keeps the version in one place: a second
 * `import('maplibre-gl')` elsewhere would be a second entry point into the same
 * chunk, which works, and a second copy of the CSS import, which does not.
 *
 * OpenFreeMap serves the tiles: real OpenStreetMap data, no API key, no request
 * cap, commercial use allowed. MapLibre draws the required attribution itself,
 * which is why neither component writes it into the page.
 */

export const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';

/**
 * Where the library has got to, for a component deciding what to render.
 *
 * Three states rather than two, and the third one is the one that matters.
 * Under the old CDN script the library was either there or it was never coming,
 * so `if (!mapLib())` could go straight to the "the map could not load"
 * fallback. A dynamic import is absent for a moment on every single page load,
 * so the same test would flash that sentence at everybody before the map drew.
 * 'loading' is what keeps the fallback for the case it was written for.
 */
export type MapLibState = 'loading' | 'ready' | 'failed';

/** The module once it has arrived. Module scope, so it is fetched once. */
let loaded: any = null;
/** The in-flight import, so two components mounting together share one fetch. */
let inflight: Promise<any> | null = null;

/**
 * Fetch MapLibre and its stylesheet, or hand back the copy already fetched.
 *
 * The CSS is imported here, beside the library, and not by either component and
 * not by web/index.html. That is deliberate: an import in a component that the
 * entry chunk reaches statically — Discover.tsx is a plain import in App.tsx —
 * would put the map's stylesheet into the render-blocking CSS of every page,
 * which is the same bill this change exists to stop paying, only in our own
 * bytes instead of unpkg's. Imported from inside the dynamic import it belongs
 * to the async chunk, and the browser fetches it with the library or not at all.
 *
 * A failed import clears `inflight` so a later mount can try again. Bundle
 * chunks do fail to arrive — a flaky connection, a deploy that rotated the
 * hashed filenames under a tab that has been open for an hour — and one such
 * failure should not mean the map is dead for the rest of the session.
 */
export function loadMapLib(): Promise<any> {
  if (loaded) return Promise.resolve(loaded);
  inflight ??= Promise.all([
    import('maplibre-gl'),
    import('maplibre-gl/dist/maplibre-gl.css'),
  ]).then(([mod]) => {
    // maplibre-gl ships a UMD build, so the namespace object Vite hands back
    // wraps the real export under `default`. What comes out either way is the
    // same object the CDN script used to leave on `window.maplibregl` — the
    // one with .Map, .Marker, .NavigationControl and .LngLatBounds on it — so
    // every call site below reads exactly as it did before.
    loaded = (mod as any).default ?? mod;
    return loaded;
  }).catch((err: unknown) => {
    inflight = null;
    throw err;
  });
  return inflight;
}

/**
 * The library, for a component that draws a map.
 *
 * Returns the module and how the fetch is going. A component renders its map
 * container while this says 'loading' — the container has to be in the document
 * before MapLibre can be pointed at it — and its own fallback only on 'failed'.
 *
 * `gl` is non-null exactly when the state is 'ready', so an effect that needs
 * the library can simply list `gl` in its dependencies and bail while it is
 * null: it will run again, with a real library, the moment the chunk lands.
 */
export function useMapLib(): { gl: any | null; state: MapLibState } {
  // Seeded from the module cache so a second map in the same session renders
  // ready on its first frame rather than flickering through 'loading'.
  const [gl, setGl] = useState<any>(loaded);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (loaded) return;
    let alive = true;
    loadMapLib().then(
      (mod) => { if (alive) setGl(mod); },
      () => { if (alive) setFailed(true); },
    );
    return () => { alive = false; };
  }, []);

  return { gl, state: gl ? 'ready' : failed ? 'failed' : 'loading' };
}
