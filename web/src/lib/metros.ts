import { useEffect, useState } from 'react';
import { api, type Metro } from '../api';

/**
 * The places Slotfill serves, on the browser side.
 *
 * The Worker holds the list in src/lib/metros.ts and every server-rendered
 * page reads it from there. The browser cannot import that file — it is
 * Worker code — so it reads the same records over `/api/public/metros`, and
 * this module is the one place that call is made. That is what keeps a metro
 * page, the neighbourhood index and the footer saying what the server-rendered
 * versions of them say instead of drifting apart a sentence at a time.
 *
 * NOTHING IS HARDCODED HERE. No name, no slug, no path, no count. Opening a
 * third place is an entry in the Worker's list and a redeploy; nothing in
 * web/src has to be edited for it to appear on the front page, in the footer,
 * on /near and at its own URL.
 */

/**
 * The request, shared by every component that wants it.
 *
 * The list changes when the product opens a new place rather than through the
 * day, and a page can render its footer, its rail and its headings from one
 * copy — so the promise is held here and handed to whoever asks next. A
 * failure clears it, so a later mount retries rather than inheriting an
 * outcome from a request the visitor never saw.
 */
let inflight: Promise<Metro[]> | null = null;

export function loadMetros(): Promise<Metro[]> {
  if (!inflight) {
    inflight = api.metros().then((r) => r.metros).catch((e) => {
      inflight = null;
      throw e;
    });
  }
  return inflight;
}

/**
 * The metros, for a component that can do something sensible without them.
 *
 * A failure is not reported: every caller of this hook uses the list to group
 * or to label geography it is already showing, so the fallback is the flat
 * ungrouped version of the same content rather than an error message about a
 * request the visitor did not make. A page that cannot be right without the
 * list — the metro page itself, and /near — fetches it alongside its own data
 * instead, so that page fails as one thing.
 */
export function useMetros(): Metro[] {
  const [metros, setMetros] = useState<Metro[]>([]);
  useEffect(() => {
    let live = true;
    void loadMetros().then((m) => { if (live) setMetros(m); }).catch(() => {});
    return () => { live = false; };
  }, []);
  return metros;
}

export const metroBySlug = (metros: Metro[], slug: string | null | undefined): Metro | null =>
  metros.find((m) => m.slug === (slug ?? '').trim().toLowerCase()) ?? null;

/**
 * "Los Angeles and Santa Maria" — the site's footprint in a phrase.
 *
 * Only for a sentence about Slotfill as a whole. A page about one place uses
 * that place's name and never this. Built from the list rather than written
 * out, so it is a list of two today and reads correctly at three.
 */
export function metroNames(metros: Metro[]): string {
  const names = metros.map((m) => m.name);
  if (names.length < 2) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Anything carrying a metro slug, split into the metros it belongs to.
 *
 * Metros with nothing in them are dropped rather than printed as an empty
 * heading, and the rows inside a group keep the order they came in.
 *
 * WHICH METRO COMES FIRST is the `order` argument, and it is a real choice
 * rather than a preference. 'launch' is the order the Worker lists them in and
 * the order every server-rendered page prints them in, so a page that mirrors
 * one of those has to use it. 'nearest' keeps whatever order the rows arrived
 * in, which for the map payload is distance from whatever postcode the visitor
 * gave: a list headed "open near you" that puts eighteen Los Angeles
 * neighbourhoods above the Santa Maria one somebody just searched for is
 * sorted by our launch history rather than by their question.
 *
 * The trailing group with `metro: null` should always be empty: the map
 * resolves every neighbourhood to a listed metro, by name where it knows one
 * and by nearest centre where it does not. It exists so that a row which
 * somehow arrives with an unrecognised slug is still shown to the visitor,
 * ungrouped, rather than vanishing from a page that claims to list everything.
 */
export function groupByMetro<T>(
  metros: Metro[], rows: T[], slugOf: (row: T) => string,
  order: 'launch' | 'nearest' = 'launch',
): Array<{ metro: Metro | null; rows: T[] }> {
  const groups = metros
    .map((metro) => ({ metro, rows: rows.filter((r) => slugOf(r) === metro.slug) }))
    .filter((g) => g.rows.length > 0);
  if (order === 'nearest') {
    groups.sort((a, b) => rows.indexOf(a.rows[0]!) - rows.indexOf(b.rows[0]!));
  }
  const known = new Set(metros.map((m) => m.slug));
  const rest = rows.filter((r) => !known.has(slugOf(r)));
  return rest.length > 0
    ? [...groups, { metro: null as Metro | null, rows: rest }]
    : groups;
}
