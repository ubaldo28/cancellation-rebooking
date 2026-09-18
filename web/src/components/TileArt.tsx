import type { ReactElement, ReactNode } from 'react';

/**
 * The <img> for a tile drawing, in the app's half of the two trees.
 *
 * THE PICTURES ARE FILES NOW, AND THE PATH IS NOT BUILT HERE. Every trade and
 * every category is drawn once by tools/trade-art.html, rendered to a .webp
 * under web/public/art by tools/art-shot.js (`npm run art`), and the path of
 * each file is computed by `tradeArt` / `categoryArt` in src/lib/seo.ts and
 * SHIPPED ON THE CATALOGUE PAYLOAD as `art`. Nothing in this tree spells one.
 *
 * That is the whole point of the arrangement and the long note over `tradeArt`
 * in the Worker sets out why: a browse row is rendered twice, once by a page in
 * web/src/pages and once by its server-rendered twin in src/lib/seo.ts, and two
 * copies of one path is how one of the two ends up asking for a file that is
 * not there. test/two-trees.test.ts pins the sizes below against the Worker's
 * for the same reason.
 *
 * WHAT THIS COMPONENT EXISTS TO SETTLE, ONCE, FOR ALL THREE PAGES THAT DRAW
 * TILES:
 *
 *  1. THE PICTURE IS DECORATIVE, SO alt IS EMPTY. Every tile already carries
 *     its trade or category name as text, right beside the drawing, inside the
 *     same link. A description in the alt attribute would be that same name
 *     read out twice in a row — "Car wash and detailing, Car wash and
 *     detailing" — which is worse than silence, and this is the case
 *     `alt=""` exists for. It is an empty alt and not a missing one: a missing
 *     alt makes a screen reader read the file name out instead.
 *  2. WIDTH AND HEIGHT ARE ALWAYS ON THE ELEMENT. Without them the row has no
 *     height until the picture arrives, so the page reflows as forty of them
 *     land — and on a browse page that means the row somebody is reaching for
 *     moves out from under their thumb as they tap. The attributes are the
 *     file's real pixel dimensions and CSS scales down from there; what the
 *     browser takes from them is the RATIO, which is what reserves the box.
 *  3. LAZY BY DEFAULT, EAGER WHERE IT IS ASKED FOR. A category page's banner
 *     is the first thing under the heading and must not fade in late, so that
 *     one passes eager. Everything else — the front page's tile grid, which
 *     sits below a full-height hero, and the browse rows, of which only three
 *     or four are ever on screen — is below the fold and lazy.
 *  4. decoding="async", so a picture is never on the critical path of painting
 *     the text of the row it sits in.
 *
 * WHY EVERY CALLER HAS TO PASS A `src` THAT MIGHT BE undefined. /api/trade-catalog
 * is served `public, max-age=3600`. For up to an hour after the deploy that
 * added `art`, a browser can hand one of these pages a catalogue it fetched
 * before the field existed. `<img src={undefined}>` re-requests the current
 * page as an image, so the guard is not politeness — it is the difference
 * between a tile with no picture and a tile with a broken one.
 */

/**
 * The pixel size of the files, which is also what goes on the elements.
 *
 * DUPLICATED FROM src/lib/seo.ts ON PURPOSE, and pinned by
 * test/two-trees.test.ts. The Worker's copies are TRADE_ART_W/H and
 * CATEGORY_ART_W/H; they are the dimensions tools/art-shot.js renders at, and
 * a disagreement here would reserve a box of the wrong shape and reintroduce
 * exactly the jump the attributes are there to prevent.
 */
const TRADE_ART_W = 500;
const TRADE_ART_H = 500;
const CATEGORY_ART_W = 500;
const CATEGORY_ART_H = 500;

export interface TileArtProps {
  /** The path off the catalogue payload, or undefined on an old payload. */
  src: string | undefined;
  /** A class for the <img> itself, so each page can size its own slot. */
  className?: string;
  /**
   * True only where the picture is above the fold on arrival, which today is
   * the category page's banner and nothing else.
   */
  eager?: boolean;
}

/** One trade's drawing, or nothing at all. */
export function TradeArt({ src, className, eager }: TileArtProps): ReactElement | null {
  if (!src) return null;
  return (
    <img
      className={className}
      src={src}
      alt=""
      width={TRADE_ART_W}
      height={TRADE_ART_H}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
    />
  );
}

export interface CategoryArtImgProps extends TileArtProps {
  /**
   * What to draw when the payload carries no path.
   *
   * Only the category tiles have one, and it is CategoryArt.tsx — the inline
   * SVG that drew these eight tiles before they were files. Its scenes and the
   * rendered files are the same coordinates (tools/trade-art.html says so and
   * copies them), so for the hour a stale catalogue can be in play the front
   * page shows the same picture, drawn rather than fetched, instead of eight
   * empty boxes. The trade rows have no equivalent and show nothing, which is
   * the right answer there: a row is a name and a count, and it reads perfectly
   * without a thumbnail.
   */
  fallback: ReactNode;
}

/** One category's drawing, or the drawn version of the same picture. */
export function CategoryArtImg(
  { src, className, eager, fallback }: CategoryArtImgProps,
): ReactElement {
  if (!src) return <>{fallback}</>;
  return (
    <img
      className={className}
      src={src}
      alt=""
      width={CATEGORY_ART_W}
      height={CATEGORY_ART_H}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
    />
  );
}
