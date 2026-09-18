/**
 * The vans that drive across the map.
 *
 * WHY THIS EXISTS. Every business on this site drives to the customer -- that
 * is the whole product, and a page of pins does not say it. A pin says "there
 * is something here". A vehicle crossing the map between two neighbourhoods
 * says "somebody comes to you", which is the sentence the front page is trying
 * to get across before anybody reads a word of it.
 *
 * WHAT THESE ARE, AND WHAT THEY ARE NOT. They are NOT live vehicle positions.
 * Nothing on this site tracks a van in real time and no claim anywhere says it
 * does. Each van is drawn from a real fact the page already has -- a
 * neighbourhood with something open in it, and another neighbourhood that same
 * map covers -- and driven between the two. So the motion is an illustration of
 * coverage, built from the coverage itself, and the map carries a line that
 * says as much in plain words. Do not add a count of "vans nearby", a live dot,
 * a driver name, an arrival time, or anything else that turns a drawing into a
 * claim.
 *
 * WHY IT IS A STRAIGHT LINE AND NOT A ROAD. Routing needs a routing service, a
 * key, a request per van and a bill. The vehicle here is a small mark moving at
 * city speed over a city-scale shot; on that shot the difference between a road
 * and the line beside it is a few pixels, and nobody is navigating by it. Buying
 * a routing subscription to make a decoration marginally more accurate is the
 * wrong trade for a business with no money.
 */

/** One end of a trip. */
export interface CarPoint { lng: number; lat: number }

export interface Car {
  /** Stable key, so a re-render moves a van rather than replacing it. */
  id: string;
  /**
   * What to draw: a slug from the Worker's src/lib/vehicles.ts, carried
   * through the map payload. This is the whole point of the fleet being built
   * from the areas rather than invented — a neighbourhood served by junk
   * removal gets a pickup and trailer, one served by a phone repairer gets a
   * car, because that is what those businesses told us they drive.
   */
  kind: string;
  from: CarPoint;
  to: CarPoint;
  /** Seconds for the whole trip. */
  secs: number;
  /** Seconds of stillness at the far end before it turns round. */
  wait: number;
  /** Where in its own cycle it starts, 0..1, so they do not move as a block. */
  phase: number;
}

/**
 * Deterministic pseudo-random, seeded by the pair of slugs.
 *
 * Math.random would give every van a new speed on every React re-render, and
 * this list is rebuilt whenever the areas change. Seeding off the two names
 * means the van between Encino and Reseda always drives at the same speed,
 * which is what stops the whole fleet twitching when a filter changes.
 */
function seeded(s: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const miles = (a: CarPoint, b: CarPoint): number => {
  // Flat-earth is fine over a metro: a degree of latitude is 69 miles and a
  // degree of longitude is that times the cosine of where you are standing.
  const y = (b.lat - a.lat) * 69;
  const x = (b.lng - a.lng) * 69 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(x, y);
};

export interface CarSource {
  slug: string;
  name: string;
  lng: number;
  lat: number;
  metro: string | null;
  slot_count: number;
  /** The kinds registered by the businesses covering this neighbourhood. */
  vehicles?: string[];
}

/**
 * Builds the fleet for one metro.
 *
 * One van per busy neighbourhood, up to `max`, each paired with the nearest
 * OTHER neighbourhood on the map. Nearest rather than random because a van
 * crossing the whole valley in twenty seconds reads as a plane; a short hop
 * between two adjacent places reads as a trade going to the next job, which is
 * the thing that is actually being drawn.
 */
export function buildCars(areas: CarSource[], metro: string | null, max = 7): Car[] {
  const here = areas.filter((a) => a.metro === metro);
  if (here.length < 2) return [];

  const busy = here
    .filter((a) => a.slot_count > 0)
    .sort((a, b) => b.slot_count - a.slot_count)
    .slice(0, max);

  // Nothing open anywhere is still a map worth animating: the businesses cover
  // these streets whether or not today has a cancellation on it.
  const starts = busy.length > 0 ? busy : here.slice(0, max);

  const cars: Car[] = [];
  for (const a of starts) {
    let best: CarSource | null = null;
    let bestD = Infinity;
    for (const b of here) {
      if (b.slug === a.slug) continue;
      const d = miles(a, b);
      if (d > 0.2 && d < bestD) { best = b; bestD = d; }
    }
    if (!best) continue;

    const rnd = seeded(`${a.slug}~${best.slug}`);
    // One of the kinds actually registered here, picked by the same seed so
    // the vehicle leaving Encino is the same vehicle on every render. Falls
    // back to a van, which is what the Worker falls back to as well.
    const kinds = a.vehicles?.length ? a.vehicles : ['van'];
    const kind = kinds[Math.floor(rnd() * kinds.length)] ?? 'van';
    // 22 mph is a reasonable city average and makes a two-mile hop take about
    // five and a half minutes -- far too slow to look alive. The map is a
    // scale drawing of a place, not of a clock, so the trip is compressed to
    // something a person watching for ten seconds can see happen.
    const secs = Math.max(9, Math.min(26, bestD * 5.5)) * (0.85 + rnd() * 0.4);
    cars.push({
      id: `${a.slug}~${best.slug}`,
      kind,
      from: { lng: a.lng, lat: a.lat },
      to: { lng: best.lng, lat: best.lat },
      secs,
      wait: 1.5 + rnd() * 3.5,
      phase: rnd(),
    });
  }
  return cars;
}

/**
 * Where a van is, and which way it is pointing, at a moment in time.
 *
 * The trip is out-and-back with a pause at each end, so a van never
 * teleports home. Eased at both ends because a vehicle that starts and stops
 * at full speed reads as a slide, not a drive.
 */
export function carAt(car: Car, tSecs: number): { lng: number; lat: number; deg: number } {
  const leg = car.secs + car.wait;
  const cycle = leg * 2;
  const t = (((tSecs / cycle) + car.phase) % 1) * cycle;

  const outbound = t < leg;
  const inLeg = outbound ? t : t - leg;
  const raw = Math.min(1, inLeg / car.secs);      // 1 for the whole wait
  const p = raw < 0.5
    ? 2 * raw * raw
    : 1 - Math.pow(-2 * raw + 2, 2) / 2;

  const a = outbound ? car.from : car.to;
  const b = outbound ? car.to : car.from;

  return {
    lng: a.lng + (b.lng - a.lng) * p,
    lat: a.lat + (b.lat - a.lat) * p,
    // Screen bearing: y grows downward on a map canvas, so north is -y.
    deg: (Math.atan2(b.lng - a.lng, b.lat - a.lat) * 180) / Math.PI,
  };
}
