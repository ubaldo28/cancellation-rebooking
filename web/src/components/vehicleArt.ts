/**
 * THE VEHICLES ON THE MAP, DRAWN FROM ABOVE — TO REAL DIMENSIONS.
 *
 * One shape per slug in the Worker's src/lib/vehicles.ts. The business says
 * what it drives; this is where that answer becomes a picture.
 *
 * THESE ARE MEASURED, NOT INVENTED. Two earlier versions were drawn from
 * imagination and both were wrong in ways that were obvious once seen: the
 * first tapered to a point and read as a boat, the second bolted wheels onto
 * the outside and read as a go-kart. The numbers below are from the actual
 * vehicles, and they settle both mistakes.
 *
 *   A Toyota Camry is 4,920 mm long and 1,840 mm wide. LENGTH TO WIDTH IS
 *   2.67 — far longer than it feels. Anything near 2.0 reads as a bar of soap.
 *
 *   Its front track is 1,580-1,590 mm and its rear track 1,600-1,610 mm,
 *   against a body 1,840 mm wide. THE TYRES SIT ABOUT 120 mm INSIDE EACH FLANK,
 *   under the arches. From directly above you do not see wheels on a car at
 *   all, and drawing them proud of the body is what made the last set look like
 *   toys. The only wheels in this file are on the trailer, where they really do
 *   stand outside the box.
 *
 *   With the mirrors out a Camry measures 2,120 mm — so THE MIRRORS ARE THE
 *   WIDEST PART OF THE VEHICLE, about 140 mm proud each side. A Ford Transit is
 *   2,113 mm across the body and 2,474 mm across the mirrors, which is 180 mm
 *   each side. That is the detail that says "vehicle" from above, and it is the
 *   first thing to check if these ever stop reading.
 *
 *   A Ford Transit L2 is 5,981 mm long on a 2,113 mm body: 2.83. A pickup is
 *   near 2.9. So a van is not a longer car, it is a DIFFERENT PROPORTION, which
 *   is what lets them be told apart at a glance on a map.
 *
 * WHAT YOU ACTUALLY SEE looking straight down, and therefore what is drawn:
 * the body outline; the greenhouse — windscreen, painted roof, rear window —
 * as a narrower band down the middle, inset from both flanks; bonnet and boot
 * as plain painted metal at each end; and the mirrors. Nothing else survives at
 * this size, so nothing else is here.
 *
 * OURS, not a borrowed silhouette: the body is the site's blue, where every
 * mapping app draws a plain dark car. On a light map that is what makes these
 * visible as ours from across the room.
 *
 * Every shape is drawn NOSE-UP, because what gets applied to it is a compass
 * bearing. Nothing inside a drawing may carry its own rotate() — it would turn
 * with the vehicle and be right at exactly one heading.
 *
 * Sources for the figures above: CarsGuide and CarExpert (Camry length, width,
 * front and rear track, width including mirrors); VanDimensions and Ford's own
 * Transit specification (body width, length by wheelbase, width with mirrors).
 */

/**
 * FLAT, NOT CARTOON.
 *
 * The version before this had a heavy near-black outline round a bright body,
 * and that combination is what makes a shape look like a children's game: thick
 * keylines are how you draw a toy. Every mapping app draws its vehicles as a
 * flat silhouette with NO outline at all, and lets a soft shadow do the work of
 * separating the shape from the ground.
 *
 * So: one solid body colour, a hairline a shade darker than the body rather
 * than a black keyline, glass a deep navy instead of black, and tighter corner
 * radii. Same drawing, less shouting.
 */
/**
 * A literal, not a CSS variable. The palette's --accent is #005A9C, which is
 * nearly navy: at this size a vehicle in it turns into a dark smudge on a pale
 * map. This is the same blue a step lighter, chosen for a shape 17 pixels wide.
 */
const BODY = '#2E7FC2';
/** A hairline, one step darker than the body. Never black. */
const EDGE = '#1E5F94';
/** Glass. A deep navy, not a black slab. */
const GLASS = '#16344F';
/** The dark inside of an open load bed, and of a trailer. */
const LOAD = '#12293D';
/** Only the trailer's tyres, which really are near-black. */
const INK = '#16344F';

/**
 * The box is 24 units wide and that width is OVERALL, mirrors included —
 * because on a real vehicle the mirrors are the widest point, so they are what
 * sets how much room it takes up. The body is therefore narrower than 24, by
 * however far that vehicle's mirrors stand out.
 */
const W_BOX = 24;

interface Spec {
  /** Body width as a fraction of the overall width across the mirrors. */
  bodyFrac: number;
  /** Length ÷ body width, from the real vehicle. */
  ratio: number;
}

/** Camry: 1840 / 2120 across mirrors, 4920 / 1840 long. */
const CAR_SPEC: Spec = { bodyFrac: 1840 / 2120, ratio: 4920 / 1840 };
/** A mid-size SUV — shorter for its width than a saloon, and squarer. */
const SUV_SPEC: Spec = { bodyFrac: 1865 / 2120, ratio: 4700 / 1865 };
/** Transit L2: 2113 body / 2474 mirrors, 5981 long. */
const VAN_SPEC: Spec = { bodyFrac: 2113 / 2474, ratio: 5981 / 2113 };
/** A full-size pickup, crew cab, standard bed. */
const PICKUP_SPEC: Spec = { bodyFrac: 2029 / 2440, ratio: 5890 / 2029 };

function frame(spec: Spec, extraLength = 0) {
  const bw = W_BOX * spec.bodyFrac;
  const left = (W_BOX - bw) / 2;
  const top = 1.4;
  const len = bw * spec.ratio;
  return {
    bw, left, right: left + bw, top, bottom: top + len, len,
    /** Total box height, including anything towed. */
    box: top * 2 + len + extraLength,
  };
}

/** A body: straight flanks, blunt ends, a radius on each corner. */
function shell(f: ReturnType<typeof frame>, rf: number, rr: number, bottom = f.bottom): string {
  const { left: L, right: R, top: T } = f;
  return `<path d="M${L + rf} ${T}H${R - rf}A${rf} ${rf} 0 0 1 ${R} ${T + rf}`
    + `V${bottom - rr}A${rr} ${rr} 0 0 1 ${R - rr} ${bottom}`
    + `H${L + rr}A${rr} ${rr} 0 0 1 ${L} ${bottom - rr}`
    + `V${T + rf}A${rf} ${rf} 0 0 1 ${L + rf} ${T}Z"`
    + ` fill="${BODY}" stroke="${EDGE}" stroke-width="0.5"/>`;
}

/**
 * The mirrors: the widest point on the vehicle, reaching the edge of the box.
 * `y` is where they sit down the length — at the base of the windscreen, which
 * is where they are.
 */
function mirrors(f: ReturnType<typeof frame>, y: number, h: number): string {
  const w = f.left + 0.6;
  return `<rect x="0" y="${y}" width="${w}" height="${h}" rx="${Math.min(1, w / 2)}"`
    + ` fill="${BODY}" stroke="${EDGE}" stroke-width="0.5"/>`
    + `<rect x="${W_BOX - w}" y="${y}" width="${w}" height="${h}" rx="${Math.min(1, w / 2)}"`
    + ` fill="${BODY}" stroke="${EDGE}" stroke-width="0.5"/>`;
}

/**
 * A window, inset from both flanks because the greenhouse is narrower than the
 * body — that inset is the painted shoulder you see running down each side, and
 * it is most of what stops the shape reading as a slab.
 */
function window_(
  f: ReturnType<typeof frame>, y: number, h: number, inset: number, r = 1.2, o = 1,
): string {
  return `<rect x="${f.left + inset}" y="${y}" width="${f.bw - inset * 2}" height="${h}"`
    + ` rx="${r}" fill="${GLASS}"${o < 1 ? ` opacity="${o}"` : ''}/>`;
}

/** A shut line — bonnet edge, boot edge, roof rib. Barely there on purpose. */
function line(f: ReturnType<typeof frame>, y: number, inset = 1.4, o = 0.28): string {
  return `<path d="M${f.left + inset} ${y}H${f.right - inset}" stroke="${EDGE}"`
    + ` stroke-width="0.7" opacity="${o}"/>`;
}

interface Shape { h: number; svg: string }

/**
 * A car. Bonnet, windscreen, painted roof, rear window, boot — in that order
 * down the shape, because that is the order they are in on the road.
 */
function car(): Shape {
  const f = frame(CAR_SPEC);
  const inset = f.bw * 0.17;      // shoulder each side of the greenhouse
  const screenY = f.top + f.len * 0.30;
  return { h: f.box, svg:
    mirrors(f, screenY - 0.6, f.len * 0.075)
    + shell(f, f.bw * 0.24, f.bw * 0.17)
    + line(f, f.top + f.len * 0.09)
    + window_(f, screenY, f.len * 0.15, inset, 1.6)
    // NO PANEL BETWEEN THE TWO WINDOWS. The roof is painted metal and reads as
    // body colour from above; a tinted rectangle there looked like a sunroof.
    // The side glass is a few millimetres of dark down each flank, which is
    // below a pixel at this size, so it is not drawn at all.
    + window_(f, f.top + f.len * 0.70, f.len * 0.12, inset + f.bw * 0.03, 1.4, 0.92)
    + line(f, f.top + f.len * 0.90),
  };
}

/** An SUV: shorter for its width, squarer corners, a taller glasshouse. */
function suv(): Shape {
  const f = frame(SUV_SPEC);
  const inset = f.bw * 0.15;
  const screenY = f.top + f.len * 0.29;
  return { h: f.box, svg:
    mirrors(f, screenY - 0.6, f.len * 0.08)
    + shell(f, f.bw * 0.18, f.bw * 0.13)
    + line(f, f.top + f.len * 0.10)
    + window_(f, screenY, f.len * 0.15, inset, 1.4)
    + window_(f, f.top + f.len * 0.745, f.len * 0.13, inset + f.bw * 0.02, 1.2, 0.92)
    + line(f, f.top + f.len * 0.93),
  };
}

/**
 * A van. The windscreen is right at the front — a van's screen sits almost over
 * the front axle — and behind it is one long painted roof with no glass at all.
 * The line across the tail is where the back doors meet, and with the rear
 * window gone that line is the whole of what says "van".
 */
function van(): Shape {
  const f = frame(VAN_SPEC);
  const inset = f.bw * 0.09;
  const screenY = f.top + f.len * 0.14;
  return { h: f.box, svg:
    mirrors(f, screenY - 1, f.len * 0.07)
    + shell(f, f.bw * 0.14, f.bw * 0.09)
    + window_(f, screenY, f.len * 0.105, inset, 1.4)
    + line(f, screenY + f.len * 0.125, 1.2, 0.2)
    // Roof ribs. A panel van's roof is ribbed and the shadows are visible from
    // above; two of them is enough to say the roof is long and empty.
    + line(f, f.top + f.len * 0.45, f.bw * 0.16, 0.16)
    + line(f, f.top + f.len * 0.62, f.bw * 0.16, 0.16)
    + line(f, f.top + f.len * 0.905, 0.8, 0.5)
    + `<path d="M12 ${f.top + f.len * 0.905}V${f.bottom - 0.8}" stroke="${EDGE}"`
    + ` stroke-width="0.8" opacity="0.5"/>`,
  };
}

/** A pickup: a cab in the front third, then an open bed drawn as a hole. */
function pickupBody(f: ReturnType<typeof frame>): string {
  const inset = f.bw * 0.11;
  const screenY = f.top + f.len * 0.20;
  const bedTop = f.top + f.len * 0.47;
  return mirrors(f, screenY - 0.8, f.len * 0.095)
    + shell(f, f.bw * 0.16, f.bw * 0.09)
    + line(f, f.top + f.len * 0.08)
    + window_(f, screenY, f.len * 0.12, inset, 1.3)
    + window_(f, f.top + f.len * 0.395, f.len * 0.055, inset + f.bw * 0.02, 1, 0.9)
    // The bed. Inset, so the painted sides frame it — drawn flank to flank it
    // read as the back half of the vehicle simply being black.
    + `<rect x="${f.left + f.bw * 0.09}" y="${bedTop}"`
    + ` width="${f.bw * 0.82}" height="${f.len * 0.475}" rx="1.2" fill="${LOAD}"/>`;
}

function pickup(): Shape {
  const f = frame(PICKUP_SPEC);
  return { h: f.box, svg: pickupBody(f) };
}

/**
 * The pickup and a trailer. The second box IS the message: at this size a
 * person reads "that one is hauling something" before anything else on the map,
 * which is exactly what junk removal is.
 *
 * The trailer is the one thing in this file with wheels outside its body,
 * because that is where a utility trailer's wheels actually are — no arches,
 * the tyre stands proud of the deck under a small mudguard. It is also, at a
 * glance, the difference between "a truck" and "a truck towing".
 */
function pickupTrailer(): Shape {
  const f = frame(PICKUP_SPEC);
  const gap = f.len * 0.045;
  const tTop = f.bottom + gap;
  const tLen = f.len * 0.62;
  const tHalf = f.bw * 0.44;
  const cx = W_BOX / 2;
  const axleY = tTop + tLen * 0.55;
  const tyreH = tLen * 0.2;
  return { h: tTop + tLen + 1.4, svg:
    pickupBody(f)
    // ONE BAR, not an A-frame. Drawn as two converging arms the enclosed
    // triangle read as a hole punched in the map between truck and trailer.
    + `<rect x="${cx - 1.1}" y="${f.bottom - 0.6}" width="2.2"`
    + ` height="${gap + 1.2}" fill="${INK}"/>`
    + `<rect x="${cx - tHalf - 1.5}" y="${axleY}" width="1.9" height="${tyreH}" rx="0.8"`
    + ` fill="${INK}"/>`
    + `<rect x="${cx + tHalf - 0.4}" y="${axleY}" width="1.9" height="${tyreH}" rx="0.8"`
    + ` fill="${INK}"/>`
    + `<rect x="${cx - tHalf}" y="${tTop}" width="${tHalf * 2}" height="${tLen}" rx="1.6"`
    + ` fill="${BODY}" stroke="${EDGE}" stroke-width="0.5"/>`
    + `<rect x="${cx - tHalf + 1.5}" y="${tTop + 1.5}" width="${tHalf * 2 - 3}"`
    + ` height="${tLen - 3}" rx="1" fill="${LOAD}"/>`,
  };
}

export interface VehicleArt {
  /** The full <svg> markup, nose-up. */
  svg: string;
  /** Drawn width in CSS pixels, mirrors included. */
  w: number;
  /** Drawn height in CSS pixels. */
  h: number;
}

/**
 * Drawn width, in CSS pixels, across the mirrors.
 *
 * Seventeen rather than twenty, because these are drawn to real proportion and
 * real proportion is LONG: a car at 2.67 to 1 is already forty pixels of map
 * at this width, and a rig with a trailer is over ninety. Any wider and the
 * vehicles start hiding the neighbourhoods they are driving between.
 */
const W = 17;

const ART: Record<string, VehicleArt> = Object.fromEntries(
  ([
    ['car', car()], ['suv', suv()], ['van', van()],
    ['pickup', pickup()], ['pickup_trailer', pickupTrailer()],
  ] as [string, Shape][]).map(([slug, s]) => [slug, {
    svg: `<svg viewBox="0 0 ${W_BOX} ${round(s.h)}" width="${W}"`
      + ` height="${round((W * s.h) / W_BOX)}" aria-hidden="true">${s.svg}</svg>`,
    w: W,
    h: round((W * s.h) / W_BOX),
  }]),
);

/** Two decimals. Full float tails in path data are bytes nobody can see. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The drawing for a kind.
 *
 * An unknown slug falls back to the van rather than to nothing, for the same
 * reason the Worker's DEFAULT_VEHICLE_KIND is a van: this file ships in a
 * bundle and the Worker's list does not, so a deploy that adds a shape server
 * side before the browser has the matching drawing must still put a vehicle on
 * the map rather than a hole.
 */
export const vehicleArt = (kind: string): VehicleArt => ART[kind] ?? ART.van!;

/** Every slug this file can draw, for the test that pins it against the Worker's. */
export const DRAWN_KINDS = Object.keys(ART);
