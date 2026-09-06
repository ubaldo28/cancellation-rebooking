import type { PublicSlot } from '../api';

/**
 * One row per genuine opening.
 *
 * The public map deliberately offers a whole free day in every neighbourhood
 * its owner covers, because it genuinely is available in all of them. That is
 * right for a pin and it is double counting the moment a page adds a trade, a
 * city or one business up — so every total a reader could check by hand is
 * taken over openings rather than over rows.
 *
 * Areas, Metro, Trade, CostGuide and the profile page each had their own
 * version of this, three of them written as a filter with a side effect in the
 * predicate. Order is preserved, so a caller that has already sorted by start
 * time keeps its sort.
 */
export function distinctGaps(slots: PublicSlot[]): PublicSlot[] {
  const seen = new Set<string>();
  const out: PublicSlot[] = [];
  for (const s of slots) {
    if (seen.has(s.gap_id)) continue;
    seen.add(s.gap_id);
    out.push(s);
  }
  return out;
}
