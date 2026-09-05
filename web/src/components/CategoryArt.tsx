import { memo, type ReactElement, type ReactNode } from 'react';

/**
 * Drawn artwork for a category tile.
 *
 * A sibling component drew one scene per trade rather than per category, and
 * nothing rendered it once the front page went from a wall of trades to eight
 * category tiles; it has been deleted, so this is the only tile art there is.
 *
 * The tiles are large -- roughly 300x180 on the landing page, half that on a
 * phone -- so every scene is drawn calm and empty. A tile that big invites
 * detail, and detail is exactly what kills it at 150px wide, so each one is a
 * single subject on open ground and nothing else.
 *
 * Three rules hold across all of them:
 *
 *  1. Nothing is built per render. Every scene is created once at module load
 *     and handed back by reference; the component is memoised on top of that.
 *  2. The svg covers its box with `slice`, so the tile treats it as a
 *     background layer and real photography could drop into the same slot.
 *  3. One ground gradient, one soft disc, one motif, one floor band, so eight
 *     tiles side by side read as one set.
 *
 * Each category gets a hue of its own, spread around the wheel: the eight are
 * seen all at once in a grid, and the grid has to read as eight different
 * things before anyone reads a single label.
 */

/**
 * Every scene is drawn in this box.
 *
 * 5:3, the same ratio as the tile, so `slice` crops nothing: a motif drawn near
 * the left edge, like the wash bucket, survives instead of being sliced off.
 */
const BOX = '0 0 200 120';

/** Consistent across all scenes: the light disc that sits behind the motif. */
const DISC = <circle cx="166" cy="22" r="40" fill="#fff" opacity="0.08" />;

/** Consistent across all scenes: the ground the motif stands on. */
const FLOOR = <rect y="94" width="200" height="26" fill="#000" opacity="0.16" />;

/**
 * One scene: a two-stop ground and the shapes on it.
 *
 * The gradient ids are prefixed, because svg ids are document-global and nine
 * of these scenes render on the front page at once.
 */
function scene(id: string, top: string, bottom: string, motif: ReactNode): ReactElement {
  return (
    <svg viewBox={BOX} preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`ca-${id}`} x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0" stopColor={top} />
          <stop offset="1" stopColor={bottom} />
        </linearGradient>
      </defs>
      <rect width="200" height="120" fill={`url(#ca-${id})`} />
      {DISC}
      {motif}
      {FLOOR}
    </svg>
  );
}

// --- the scenes ------------------------------------------------------------

/**
 * Automotive: a car in profile with a bucket set down beside it.
 *
 * The car alone would be a dealership or a rental firm. The bucket is what
 * turns it into somebody's van pulling up to work on it, and it survives the
 * shrink to 150px because it is a single silhouette with suds over it, not a
 * detail on the car.
 */
const AUTO = scene('auto', '#2f6fb5', '#14375e', (
  <>
    <path d="M72 54l16-20h44l16 20z" fill="#a8cdf2" />
    <rect x="50" y="52" width="120" height="28" rx="13" fill="#f2f8fe" />
    <circle cx="80" cy="82" r="12" fill="#0e2a48" />
    <circle cx="142" cy="82" r="12" fill="#0e2a48" />
    <circle cx="80" cy="82" r="4.5" fill="#a8cdf2" />
    <circle cx="142" cy="82" r="4.5" fill="#a8cdf2" />
    <path d="M16 64h30l-4 28H20z" fill="#dcebfa" />
    <rect x="14" y="57" width="34" height="8" rx="4" fill="#ffd257" />
    <circle cx="24" cy="44" r="6" fill="#fff" opacity="0.85" />
    <circle cx="39" cy="37" r="4.5" fill="#fff" opacity="0.7" />
    <circle cx="12" cy="34" r="3.5" fill="#fff" opacity="0.55" />
  </>
));

/**
 * Home: a house with a spanner leaning past it.
 *
 * A house on its own is an estate agent. The spanner is deliberately oversized
 * and set clear of the roofline rather than tucked against the wall, because
 * at tile size anything overlapping the house edge just reads as a bump on the
 * house.
 */
const HOME = scene('home', '#2c7f5c', '#0f4030', (
  <>
    <path d="M52 58L100 22l48 36z" fill="#bfe8d0" />
    <rect x="64" y="56" width="72" height="38" fill="#f2fbf6" />
    <rect x="70" y="63" width="15" height="13" rx="2" fill="#8fd9b4" />
    <rect x="115" y="63" width="15" height="13" rx="2" fill="#8fd9b4" />
    <rect x="88" y="70" width="24" height="24" rx="3" fill="#2c7f5c" />
    <g transform="rotate(-38 168 62)">
      <rect x="146" y="56" width="44" height="12" rx="6" fill="#ffd257" />
      <circle cx="148" cy="62" r="11.5" fill="#ffd257" />
      <circle cx="148" cy="62" r="5" fill="#0f4030" />
    </g>
  </>
));

/**
 * Pets: a dog in profile with a grooming brush held over its back.
 *
 * Side-on rather than the trade tile's face-on dog, so the two never look like
 * the same drawing at different sizes. The brush hovers with clear air under
 * it -- resting it on the coat merged the two shapes into one blob when this
 * was checked small.
 */
const PETS = scene('pets', '#a9603a', '#52280e', (
  <>
    <path d="M56 58q-18-6-18-24" stroke="#f7e3cd" strokeWidth="9" strokeLinecap="round" fill="none" />
    <rect x="52" y="54" width="82" height="34" rx="17" fill="#f7e3cd" />
    <rect x="66" y="80" width="13" height="14" rx="6" fill="#f7e3cd" />
    <rect x="108" y="80" width="13" height="14" rx="6" fill="#f7e3cd" />
    <path d="M134 40q13-11 21 2l-10 13z" fill="#d9a678" />
    <circle cx="148" cy="58" r="21" fill="#f7e3cd" />
    <rect x="158" y="60" width="26" height="16" rx="8" fill="#ffeed8" />
    <ellipse cx="181" cy="66" rx="5" ry="4" fill="#43220a" />
    <circle cx="152" cy="51" r="3.5" fill="#43220a" />
    <rect x="70" y="26" width="46" height="12" rx="5" fill="#ffd257" />
    <path d="M78 38v9M89 38v9M100 38v9M110 38v9" stroke="#ffd257" strokeWidth="4" strokeLinecap="round" />
  </>
));

/**
 * Beauty: a salon chair with a round mirror behind it.
 *
 * Brushes and bottles were tried first and read as "shop" rather than "someone
 * comes to you". The chair plus mirror is the one arrangement everybody has
 * sat in, and it holds its shape when the tile shrinks.
 */
const BEAUTY = scene('beauty', '#a8407e', '#4c1739', (
  <>
    <circle cx="160" cy="46" r="25" fill="#fde4f1" />
    <circle cx="160" cy="46" r="18" fill="#f2b8d8" />
    <rect x="44" y="30" width="22" height="46" rx="10" fill="#fde4f1" />
    <rect x="66" y="52" width="58" height="8" rx="4" fill="#f2b8d8" />
    <rect x="44" y="62" width="86" height="16" rx="8" fill="#fde4f1" />
    <rect x="80" y="78" width="14" height="10" fill="#fde4f1" />
    <rect x="66" y="86" width="42" height="8" rx="4" fill="#fde4f1" />
  </>
));

/**
 * Food: a truck with the serving hatch open.
 *
 * The hatch is cut dark and the awning above it is the brightest thing in the
 * scene, because the hatch is the whole difference between this and any other
 * van in the set. Everything else -- cab, wheels, shelf -- is deliberately
 * plain so the eye goes straight to the opening.
 */
const FOOD = scene('food', '#cf4634', '#6b1c16', (
  <>
    <rect x="26" y="34" width="112" height="46" rx="7" fill="#fff3e6" />
    <path d="M138 46h22l16 20v14h-38z" fill="#ffd9bd" />
    <rect x="146" y="51" width="18" height="12" rx="3" fill="#6b1c16" />
    <rect x="42" y="44" width="64" height="24" rx="3" fill="#6b1c16" />
    <path d="M36 44l8-13h60l8 13z" fill="#ffd257" />
    <rect x="36" y="68" width="76" height="6" rx="3" fill="#ffd9bd" />
    <circle cx="56" cy="86" r="8" fill="#4a120e" />
    <circle cx="152" cy="86" r="8" fill="#4a120e" />
  </>
));

/**
 * Tech: an open laptop with a driver at the hinge.
 *
 * The trade tile already owns the lifted phone screen, so this takes the other
 * half of the category. A closed laptop is a shop window; open, with a driver
 * angled into the seam, it can only be a repair.
 */
const TECH = scene('tech', '#5b46b8', '#241a5c', (
  <>
    <rect x="54" y="24" width="92" height="56" rx="5" fill="#e9e6fb" />
    <rect x="60" y="30" width="80" height="44" rx="3" fill="#3a2f8f" />
    <path d="M66 74l34-44h16L82 74z" fill="#8f86e8" opacity="0.45" />
    <path d="M42 80h116l12 12H30z" fill="#e9e6fb" />
    <rect x="88" y="84" width="24" height="4" rx="2" fill="#b9b2ee" />
    <g transform="rotate(40 168 70)">
      <rect x="163" y="34" width="10" height="30" rx="5" fill="#ffd257" />
      <rect x="166" y="62" width="4" height="20" rx="2" fill="#cfd4e4" />
    </g>
  </>
));

/**
 * Professional and personal: a clipboard with a tick and a pen.
 *
 * This category is notaries, tutors, trainers and photographers, which have no
 * shared object between them. A camera would have named one of the four and
 * quietly hidden the rest, so the scene stands for the appointment itself.
 * The bars are bars, not lettering -- nothing in here is text.
 */
const SERVICES = scene('svc', '#4a5567', '#212832', (
  <>
    <rect x="62" y="22" width="76" height="72" rx="8" fill="#eef2f7" />
    <rect x="94" y="10" width="12" height="9" rx="3" fill="#9fb0c6" />
    <rect x="86" y="15" width="28" height="14" rx="5" fill="#9fb0c6" />
    <rect x="76" y="40" width="48" height="7" rx="3.5" fill="#c9d4e2" />
    <rect x="76" y="54" width="26" height="7" rx="3.5" fill="#c9d4e2" />
    <path
      d="M76 74l12 12 26-28"
      stroke="#16e08e"
      strokeWidth="9"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <g transform="rotate(30 150 60)">
      <rect x="145" y="26" width="10" height="42" rx="5" fill="#ffd257" />
      <path d="M145 68h10l-5 12z" fill="#eef2f7" />
    </g>
  </>
));

/**
 * Pop-up retail: a scalloped awning over a rail of clothes.
 *
 * Drawn as a stall rather than a boutique truck on purpose. A truck here would
 * have shared a silhouette with the food truck, and two tiles in one grid that
 * both say "van" is the one mistake this set cannot afford. Awning plus rail
 * has no overlap with anything else in the eight.
 */
const RETAIL = scene('retail', '#0d7f89', '#06424b', (
  <>
    <path d="M24 26h152l14 24H10z" fill="#e6f7f9" />
    <path
      d="M10 50q10 14 20 0 10 14 20 0 10 14 20 0 10 14 20 0 10 14 20 0 10 14 20 0 10 14 20 0 10 14 20 0 10 14 20 0z"
      fill="#7fdce4"
    />
    <rect x="44" y="72" width="6" height="22" fill="#cfeff2" />
    <rect x="150" y="72" width="6" height="22" fill="#cfeff2" />
    <rect x="40" y="66" width="120" height="6" rx="3" fill="#cfeff2" />
    <path d="M70 74l12-6 12 6-3 16H73z" fill="#ffd257" />
    <path d="M106 74l12-6 12 6-3 16h-18z" fill="#e6f7f9" />
  </>
));

/**
 * The neutral scene, for the "Everything" tile and for anything unrecognised.
 *
 * Four blank tiles rather than a pile of the other eight motifs: it has to say
 * "all of it" without claiming to be any one of them, and it has to stay quiet
 * enough that the labelled tiles beside it still win the eye.
 */
const NEUTRAL = scene('all', '#3d4757', '#1c222b', (
  <>
    <rect x="56" y="26" width="40" height="32" rx="7" fill="#eef2f7" />
    <rect x="104" y="26" width="40" height="32" rx="7" fill="#c7d2e0" />
    <rect x="56" y="62" width="40" height="32" rx="7" fill="#c7d2e0" />
    <rect x="104" y="62" width="40" height="32" rx="7" fill="#eef2f7" />
    <circle cx="168" cy="74" r="8" fill="#16e08e" />
    <circle cx="30" cy="46" r="5" fill="#16e08e" opacity="0.7" />
  </>
));

/**
 * Category key to scene.
 *
 * Keys are the `key` values on TRADE_CATEGORIES, which are ours and fixed --
 * unlike the trade slugs, which are free text on operator records and need
 * aliases. Anything not listed gets the neutral scene, never a wrong picture.
 */
const ART: Record<string, ReactElement> = {
  auto: AUTO,
  home: HOME,
  pets: PETS,
  beauty: BEAUTY,
  food: FOOD,
  tech: TECH,
  services: SERVICES,
  retail: RETAIL,
};

export interface CategoryArtProps {
  /** The category to draw, or null for the "Everything" tile. */
  category: string | null;
}

/**
 * Returns a pre-built element, so this never allocates and never re-renders
 * meaningfully. Wrapped in memo anyway because it sits inside a grid that
 * re-renders on every filter change.
 */
function CategoryArtBase({ category }: CategoryArtProps): ReactElement {
  if (category === null) return NEUTRAL;
  return ART[category.trim().toLowerCase()] ?? NEUTRAL;
}

export const CategoryArt = memo(CategoryArtBase);

export default CategoryArt;
