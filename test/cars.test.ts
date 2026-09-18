import { describe, expect, it } from 'vitest';
import { buildCars, carAt, type CarSource } from '../web/src/lib/cars';
import { DRAWN_KINDS, vehicleArt } from '../web/src/components/vehicleArt';
import { VEHICLE_KINDS, DEFAULT_VEHICLE_KIND, isVehicleKind } from '../src/lib/vehicles';

/**
 * THE VANS ON THE FRONT PAGE.
 *
 * These are a drawing, not a feed — see web/src/lib/cars.ts — so what is worth
 * pinning is not "is the position right" but the three things that would make
 * the drawing embarrassing: a fleet that jumps to a new speed on every render,
 * a van that flies off the map and never returns, and a van that sits still.
 */

const area = (
  slug: string, lng: number, lat: number, slot_count = 3, metro: string | null = 'la',
  vehicles: string[] = ['van'],
): CarSource => ({ slug, name: slug, lng, lat, metro, slot_count, vehicles });

// Four neighbourhoods roughly two miles apart, plus one in another metro.
const LA = [
  area('encino', -118.50, 34.16),
  area('reseda', -118.53, 34.20),
  area('tarzana', -118.55, 34.16),
  area('sherman-oaks', -118.45, 34.15),
];

describe('the fleet', () => {
  it('needs two places to drive between', () => {
    expect(buildCars([area('encino', -118.5, 34.16)], 'la')).toEqual([]);
    expect(buildCars([], 'la')).toEqual([]);
  });

  it('only builds vans for the metro being framed', () => {
    const withOther = [...LA, area('orcutt', -120.43, 34.86, 5, 'sm')];
    const cars = buildCars(withOther, 'la');
    // Every endpoint is an LA coordinate, so nothing drives to the Central Coast.
    for (const c of cars) {
      expect(c.from.lng).toBeLessThan(-118);
      expect(c.to.lng).toBeLessThan(-118);
      expect(c.from.lng).toBeGreaterThan(-119);
      expect(c.to.lng).toBeGreaterThan(-119);
    }
    expect(cars.length).toBeGreaterThan(0);
  });

  it('caps the fleet', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      area(`n${i}`, -118.5 + i * 0.01, 34.16 + i * 0.004));
    expect(buildCars(many, 'la').length).toBeLessThanOrEqual(7);
  });

  it('still draws vans on a day with nothing open', () => {
    // The businesses cover these streets whether or not today has a
    // cancellation on it, so an empty day is not an empty map.
    const quiet = LA.map((a) => ({ ...a, slot_count: 0 }));
    expect(buildCars(quiet, 'la').length).toBeGreaterThan(0);
  });

  it('is identical on every rebuild, so the fleet does not twitch', () => {
    // React rebuilds this list whenever the areas change. Math.random here
    // would give every van a new speed each time, which reads as a glitch.
    expect(buildCars(LA, 'la')).toEqual(buildCars(LA, 'la'));
  });

  it('pairs each van with a near neighbour, not a random one', () => {
    // A van crossing the whole valley reads as a plane. Nothing here should be
    // driving further than a few miles.
    for (const c of buildCars(LA, 'la')) {
      const dx = Math.abs(c.to.lng - c.from.lng);
      const dy = Math.abs(c.to.lat - c.from.lat);
      expect(dx).toBeLessThan(0.12);
      expect(dy).toBeLessThan(0.12);
    }
  });
});

describe('a van in motion', () => {
  const car = buildCars(LA, 'la')[0]!;

  it('moves', () => {
    const a = carAt(car, 0);
    const b = carAt(car, car.secs * 0.5);
    expect(a.lng === b.lng && a.lat === b.lat).toBe(false);
  });

  it('never leaves the line between its two ends', () => {
    // The bug this catches is an easing curve that overshoots: a van that
    // sails past the neighbourhood it was driving to and off the map.
    const loLng = Math.min(car.from.lng, car.to.lng);
    const hiLng = Math.max(car.from.lng, car.to.lng);
    const loLat = Math.min(car.from.lat, car.to.lat);
    const hiLat = Math.max(car.from.lat, car.to.lat);
    for (let t = 0; t < 400; t += 0.37) {
      const p = carAt(car, t);
      expect(p.lng).toBeGreaterThanOrEqual(loLng - 1e-9);
      expect(p.lng).toBeLessThanOrEqual(hiLng + 1e-9);
      expect(p.lat).toBeGreaterThanOrEqual(loLat - 1e-9);
      expect(p.lat).toBeLessThanOrEqual(hiLat + 1e-9);
      expect(Number.isFinite(p.deg)).toBe(true);
    }
  });

  it('turns round rather than teleporting home', () => {
    // Out, pause, back, pause. Sampled across two full cycles, consecutive
    // steps are always small: a jump means it snapped back to the start.
    const step = 0.25;
    let prev = carAt(car, 0);
    const span = Math.hypot(car.to.lng - car.from.lng, car.to.lat - car.from.lat);
    for (let t = step; t < (car.secs + car.wait) * 4; t += step) {
      const p = carAt(car, t);
      const moved = Math.hypot(p.lng - prev.lng, p.lat - prev.lat);
      expect(moved).toBeLessThan(span * 0.35);
      prev = p;
    }
  });

  it('waits at the end of a leg', () => {
    // Arrival is at car.secs INTO ITS OWN CYCLE, and every van starts at a
    // different point in that cycle so they do not move as a block — so the
    // clock time that lands inside the wait has to be worked back through the
    // phase rather than read straight off car.secs.
    const cycle = (car.secs + car.wait) * 2;
    const clockFor = (inCycle: number) =>
      ((inCycle / cycle - car.phase) % 1 + 1) % 1 * cycle;

    const a = carAt(car, clockFor(car.secs + car.wait * 0.5));
    const b = carAt(car, clockFor(car.secs + car.wait * 0.9));
    expect(Math.abs(a.lng - b.lng)).toBeLessThan(1e-9);
    expect(Math.abs(a.lat - b.lat)).toBeLessThan(1e-9);

    // And it is parked on the far end, not somewhere in the middle of the road.
    expect(Math.abs(a.lng - car.to.lng)).toBeLessThan(1e-9);
    expect(Math.abs(a.lat - car.to.lat)).toBeLessThan(1e-9);
  });
});


/**
 * THE TWO LISTS THAT HAVE TO AGREE.
 *
 * The Worker decides what a business can say it drives; the browser decides
 * what that becomes on the map. They are in different bundles and neither can
 * import the other at runtime, so nothing but this file stops somebody adding
 * a shape server side and shipping a map with a hole in it — or drawing one
 * the operator's form can never produce.
 */
describe('what the map can draw', () => {
  it('draws every kind an operator can choose', () => {
    for (const k of VEHICLE_KINDS) {
      expect(DRAWN_KINDS, `no drawing for '${k.slug}'`).toContain(k.slug);
    }
  });

  it('draws nothing the operator cannot choose', () => {
    for (const slug of DRAWN_KINDS) {
      expect(isVehicleKind(slug), `'${slug}' is drawn but not a real kind`).toBe(true);
    }
  });

  it('falls back to a vehicle rather than to a hole', () => {
    // A deploy can put a new kind in the Worker before the browser bundle has
    // the matching drawing. That must still put something on the map.
    const art = vehicleArt('hovercraft');
    expect(art.svg).toContain('<svg');
    expect(art).toEqual(vehicleArt(DEFAULT_VEHICLE_KIND));
  });

  it('gives the pickup and trailer a longer box than the car', () => {
    // The whole point of the trailer is that it reads as longer at a glance.
    expect(vehicleArt('pickup_trailer').h).toBeGreaterThan(vehicleArt('van').h);
    expect(vehicleArt('van').h).toBeGreaterThan(vehicleArt('car').h);
  });

  it('draws every vehicle the same width', () => {
    // Length is the only thing separating these on the map. If the widths
    // drift apart, a van reads as a bigger car rather than as a van.
    const widths = new Set(DRAWN_KINDS.map((k) => vehicleArt(k).w));
    expect(widths.size).toBe(1);
  });

  it('gives every vehicle its mirrors, at the widest point', () => {
    // On a real vehicle the mirrors ARE the widest part — a Camry is 1,840 mm
    // across the body and 2,120 mm across the mirrors — so they touch both
    // edges of the box. They are also the detail that says "vehicle" from
    // above, and the first thing to check if these stop reading as one.
    for (const slug of DRAWN_KINDS) {
      const svg = vehicleArt(slug).svg;
      expect(svg, `'${slug}' has no left mirror`).toMatch(/<rect x="0" y=/);
      expect(svg, `'${slug}' has no right mirror`)
        .toMatch(/<rect x="2[0-3](\.\d+)?" y=/);
    }
  });

  it('does not put wheels outside the body of anything that is not a trailer', () => {
    // A Camry's track is 1,580-1,610 mm inside a body 1,840 mm wide: the tyres
    // sit about 120 mm in from each flank, under the arches, and are simply not
    // visible from directly above. Drawing them proud is what made an earlier
    // set look like toys. A trailer is the exception — its wheels really do
    // stand outside the deck — so it is allowed one axle and nothing else is.
    const axles = (slug: string) =>
      (vehicleArt(slug).svg.match(/<rect x="-?\d/g) ?? []).length;
    for (const slug of DRAWN_KINDS.filter((k) => k !== 'pickup_trailer')) {
      // Only the two mirrors may sit at or beyond the body edge.
      const outside = vehicleArt(slug).svg.match(/<rect x="(0|2[0-3][\d.]*)"/g) ?? [];
      expect(outside.length, `'${slug}' has something outside its body`).toBe(2);
    }
    expect(axles('pickup_trailer')).toBeGreaterThan(0);
  });

  it('keeps every vehicle longer than three halves of its width', () => {
    // Real proportions: a saloon is 2.67 long to 1 wide, a van 2.83, a pickup
    // 2.9. An earlier set was drawn near 2.0 and read as a bar of soap. The
    // drawn box adds the mirrors to the width, so the pinned floor is lower
    // than the true ratio — what it catches is a drawing that has gone stubby.
    for (const slug of DRAWN_KINDS) {
      const { w, h } = vehicleArt(slug);
      expect(h / w, `'${slug}' is too stubby to read as a vehicle`)
        .toBeGreaterThan(1.9);
    }
  });

  it('keeps the flanks straight, so nothing reads as a hull', () => {
    // The body is a rounded rectangle: straight runs down both sides with an
    // arc only at the four corners. A body drawn with long curves is the boat
    // this replaced, so the shape is pinned rather than described.
    for (const slug of DRAWN_KINDS) {
      const svg = vehicleArt(slug).svg;
      expect(svg, `'${slug}' has curved flanks`).not.toMatch(/[dD]="[^"]*[cC]\d/);
      expect(svg).toMatch(/V\d/);
    }
  });

  it('every drawing is nose-up in its own box', () => {
    for (const slug of DRAWN_KINDS) {
      const { svg, h, w } = vehicleArt(slug);
      expect(svg).toMatch(/viewBox="0 0 24 [\d.]+"/);
      expect(h).toBeGreaterThan(0);
      expect(w).toBeGreaterThan(0);
      // Longer than it is wide, always. A vehicle from above that is not is a
      // drawing that has lost its proportions.
      expect(h).toBeGreaterThan(w);
      // Rotation is applied to the whole svg, so a stray transform inside it
      // would turn with the vehicle and be wrong at every bearing but one.
      expect(svg).not.toContain('rotate(');
    }
  });
});

describe('which vehicle drives out of a neighbourhood', () => {
  it('is one the businesses there actually registered', () => {
    const junk = [
      area('encino', -118.50, 34.16, 4, 'la', ['pickup_trailer']),
      area('reseda', -118.53, 34.20, 4, 'la', ['pickup_trailer']),
    ];
    for (const c of buildCars(junk, 'la')) expect(c.kind).toBe('pickup_trailer');

    const phones = [
      area('encino', -118.50, 34.16, 4, 'la', ['car']),
      area('reseda', -118.53, 34.20, 4, 'la', ['car']),
    ];
    for (const c of buildCars(phones, 'la')) expect(c.kind).toBe('car');
  });

  it('never invents one when the area lists none', () => {
    const bare: CarSource[] = [
      { slug: 'a', name: 'a', lng: -118.50, lat: 34.16, metro: 'la', slot_count: 2 },
      { slug: 'b', name: 'b', lng: -118.53, lat: 34.20, metro: 'la', slot_count: 2 },
    ];
    for (const c of buildCars(bare, 'la')) expect(c.kind).toBe(DEFAULT_VEHICLE_KIND);
  });

  it('picks the same one on every rebuild', () => {
    const mixed = [
      area('encino', -118.50, 34.16, 4, 'la', ['van', 'car', 'pickup_trailer']),
      area('reseda', -118.53, 34.20, 4, 'la', ['van', 'car', 'pickup_trailer']),
      area('tarzana', -118.55, 34.16, 4, 'la', ['van', 'car', 'pickup_trailer']),
    ];
    expect(buildCars(mixed, 'la').map((c) => c.kind))
      .toEqual(buildCars(mixed, 'la').map((c) => c.kind));
  });
});
