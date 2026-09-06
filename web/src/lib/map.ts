/**
 * The one map style URL, and the one declaration of the global it needs.
 *
 * MapLibre is loaded from a CDN in web/index.html rather than bundled, so both
 * maps reach it through `window` and both have to cope with it not being
 * there. CityMap.tsx and VanTrack.tsx each carried their own copy of this URL
 * and their own `declare global`, which is a copy of a host name that
 * src/lib/headers.ts has to allow in two CSP directives — drift here would
 * show up as a map that silently renders nothing on one page and fine on the
 * other, with the reason in a console message nobody is watching.
 *
 * OpenFreeMap serves the tiles: real OpenStreetMap data, no API key, no
 * request cap, commercial use allowed. MapLibre draws the required attribution
 * itself, which is why neither component writes it into the page.
 */

declare global {
  interface Window { maplibregl?: any }
}

export const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';

/** The library, or null when the CDN script never arrived. */
export const mapLib = (): any => (typeof window === 'undefined' ? null : window.maplibregl ?? null);
