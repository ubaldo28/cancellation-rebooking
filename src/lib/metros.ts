import type { Point } from '../types';
import { haversineMeters } from './util';

/**
 * The places Slotfill serves, as data.
 *
 * This started as two constants in lib/seo.ts — `METRO = 'Los Angeles'` and
 * `METRO_PATH = '/los-angeles'` — read by about twenty call sites. That was
 * honest while the product was one city and wrong the moment it was two: every
 * page said "Los Angeles" whether or not it was describing Los Angeles, and
 * opening a second place meant editing all twenty again.
 *
 * So the metro is a list now, and the rest of the code reads the list. Adding a
 * third place is an entry in METROS below and nothing else: the metro page, the
 * neighbourhood index, the sitemap, robots.txt, the breadcrumbs, the header
 * nav, the ZIP seed and the public API all enumerate this array.
 *
 * WHAT MAY GO IN A RECORD, and this is the same rule the metro page has always
 * carried: `geography` may state general facts about the place that would be
 * true if this site did not exist, and nothing else. No claim about how many
 * customers are there, how fast anybody replies, or how well Slotfill is doing
 * — every number on a metro page is counted from the rows fetched to build it.
 */

/** One neighbourhood, district or town inside a metro. */
export interface MetroArea {
  /**
   * The value businesses share in `service_areas.place_slug`, which is what
   * groups several operators' pins into one neighbourhood and what /near/<x>
   * is keyed on. It is the join between this file and the database.
   */
  slug: string;
  name: string;
  /**
   * An approximate centroid, not a surveyed point. Accurate enough to drop a
   * pin on the right neighbourhood and to make a drive time believable to
   * within a few minutes, which is the resolution the ranking works at.
   */
  lat: number;
  lng: number;
  /**
   * Every postcode that delivers to this area, most central first.
   *
   * A neighbourhood can have several, and one postcode can cover several
   * neighbourhoods — 91302 is both Calabasas and Hidden Hills, and 93454 is
   * downtown Santa Maria as well as Sisquoc and Garey out to the east. The
   * postal_codes table holds one point per code, so the first area listing a
   * code is the one a visitor typing it is placed at; see the postal_codes
   * insert in lib/demo.ts for what that costs.
   */
  zips: string[];
}

export interface Metro {
  /** Also the URL: '/santa-maria'. Use `metroPath` rather than building it. */
  slug: string;
  /** As a person writes it. Goes in titles, headings and breadcrumbs. */
  name: string;
  /** Printed beside the name, so a metro outside California still reads right. */
  state: string;
  /** IANA zone. Both current metros are Pacific; a third need not be. */
  timezone: string;
  /** Roughly the middle of the served area, for the nearest-metro fallback. */
  centre: Point;
  /** The neighbourhoods, districts and towns inside it. */
  areas: MetroArea[];
  /**
   * The "Why mobile work suits here" paragraphs, one per element.
   *
   * General facts about the place only — climate, terrain, what is built there
   * and how it is laid out. The metro page adds its own closing paragraph
   * about what Slotfill actually does, which is the same everywhere because it
   * is a fact about the product rather than about the place.
   */
  geography: string[];
}

/**
 * Los Angeles: the San Fernando Valley corridor the product launched on.
 *
 * West to east, Calabasas and Hidden Hills out at the Ventura County end
 * through the mid-Valley to Burbank. Calabasas and Hidden Hills are their own
 * incorporated cities rather than parts of Los Angeles, and they are here for
 * the same reason Guadalupe and Nipomo are in the Santa Maria record: a metro
 * on this site is the patch a mobile business drives, not a city boundary.
 */
const LOS_ANGELES: Metro = {
  slug: 'los-angeles',
  name: 'Los Angeles',
  state: 'California',
  timezone: 'America/Los_Angeles',
  centre: { lat: 34.1808, lng: -118.4487 },
  areas: [
    { slug: 'calabasas',       name: 'Calabasas',       lat: 34.1367, lng: -118.6612, zips: ['91302'] },
    { slug: 'hidden-hills',    name: 'Hidden Hills',    lat: 34.1678, lng: -118.6520, zips: ['91302'] },
    { slug: 'woodland-hills',  name: 'Woodland Hills',  lat: 34.1683, lng: -118.6059, zips: ['91367', '91364'] },
    { slug: 'canoga-park',     name: 'Canoga Park',     lat: 34.2011, lng: -118.5981, zips: ['91303', '91304'] },
    { slug: 'winnetka',        name: 'Winnetka',        lat: 34.2133, lng: -118.5711, zips: ['91306'] },
    { slug: 'northridge',      name: 'Northridge',      lat: 34.2283, lng: -118.5370, zips: ['91325', '91324', '91326'] },
    { slug: 'reseda',          name: 'Reseda',          lat: 34.2011, lng: -118.5364, zips: ['91335'] },
    { slug: 'tarzana',         name: 'Tarzana',         lat: 34.1725, lng: -118.5531, zips: ['91356'] },
    { slug: 'encino',          name: 'Encino',          lat: 34.1590, lng: -118.5010, zips: ['91316', '91436'] },
    { slug: 'sherman-oaks',    name: 'Sherman Oaks',    lat: 34.1512, lng: -118.4492, zips: ['91403', '91423'] },
    { slug: 'van-nuys',        name: 'Van Nuys',        lat: 34.1866, lng: -118.4487, zips: ['91405', '91401', '91406'] },
    { slug: 'panorama-city',   name: 'Panorama City',   lat: 34.2261, lng: -118.4409, zips: ['91402'] },
    { slug: 'valley-village',  name: 'Valley Village',  lat: 34.1670, lng: -118.3960, zips: ['91607'] },
    { slug: 'studio-city',     name: 'Studio City',     lat: 34.1395, lng: -118.3870, zips: ['91604'] },
    { slug: 'north-hollywood', name: 'North Hollywood', lat: 34.1720, lng: -118.3790, zips: ['91601', '91605', '91606'] },
    { slug: 'sun-valley',      name: 'Sun Valley',      lat: 34.2183, lng: -118.3700, zips: ['91352'] },
    { slug: 'toluca-lake',     name: 'Toluca Lake',     lat: 34.1500, lng: -118.3600, zips: ['91602'] },
    { slug: 'burbank',         name: 'Burbank',         lat: 34.1808, lng: -118.3090, zips: ['91505', '91501', '91502', '91504', '91506'] },
  ],
  geography: [
    `Los Angeles has a Mediterranean climate: a long dry season from roughly May
to October and most of the year's rain in a handful of winter months. Dust and
pollen settle on cars, windows and solar panels through the dry months, and the
first rains wash them into gutters and drains — which is why so much of the work
listed here is cleaning of one kind or another, and why it clusters seasonally.`,
    `Most of the housing in the city is low-rise, with driveways, yards and street
parking rather than loading bays. That is what makes a van practical: the person
doing the work can bring water, power and tools to the address instead of the
address coming to a shop.`,
  ],
};

/**
 * Santa Maria: the Santa Maria Valley, on the Central Coast.
 *
 * The city itself is the largest in Santa Barbara County; Orcutt sits directly
 * south of it, Guadalupe west towards the dunes, Nipomo north across the Santa
 * Maria River in San Luis Obispo County, and Sisquoc, Garey, Los Alamos and
 * Casmalia are the small outlying communities a valley business drives to. All
 * of them are places, not inventions — none is a subdivision name made up to
 * fill the list — and the postcodes are the real 934xx ones.
 */
const SANTA_MARIA: Metro = {
  slug: 'santa-maria',
  name: 'Santa Maria',
  state: 'California',
  timezone: 'America/Los_Angeles',
  centre: { lat: 34.9530, lng: -120.4357 },
  areas: [
    // 93456 and 93457 are Santa Maria's post-office-box ranges rather than
    // street delivery. They are listed so that somebody typing the code off
    // their own mail is placed downtown instead of being told we cannot find
    // them, which is the whole job of the postcode box on the front page.
    { slug: 'downtown-santa-maria', name: 'Downtown Santa Maria', lat: 34.9530, lng: -120.4357, zips: ['93454', '93456', '93457'] },
    { slug: 'tanglewood',           name: 'Tanglewood',           lat: 34.9592, lng: -120.4588, zips: ['93458'] },
    { slug: 'orcutt',               name: 'Orcutt',               lat: 34.8631, lng: -120.4358, zips: ['93455'] },
    { slug: 'rice-ranch',           name: 'Rice Ranch',           lat: 34.8551, lng: -120.4136, zips: ['93455'] },
    { slug: 'guadalupe',            name: 'Guadalupe',            lat: 34.9714, lng: -120.5719, zips: ['93434'] },
    { slug: 'nipomo',               name: 'Nipomo',               lat: 35.0428, lng: -120.4760, zips: ['93444'] },
    { slug: 'sisquoc',              name: 'Sisquoc',              lat: 34.8617, lng: -120.2903, zips: ['93454'] },
    { slug: 'garey',                name: 'Garey',                lat: 34.8880, lng: -120.3200, zips: ['93454'] },
    { slug: 'los-alamos',           name: 'Los Alamos',           lat: 34.7447, lng: -120.2777, zips: ['93440'] },
    { slug: 'casmalia',             name: 'Casmalia',             lat: 34.8842, lng: -120.5342, zips: ['93429'] },
  ],
  geography: [
    `Santa Maria sits on the floor of its own valley about ten miles inland from
the Pacific, and the ocean is what sets the weather. Marine air comes up the
valley on most mornings from late spring into summer and burns off around
midday, so summers here are cool and grey early rather than hot, and nearly all
of the year's rain falls between November and March. What settles on cars,
windows and outdoor metal in this valley is fog and damp far more often than
it is dust.`,
    `The valley floor is farmed — strawberries, broccoli and wine grapes — and the
places in it are strung out along it with fields in between: Orcutt and Rice
Ranch to the south, Guadalupe west towards the dunes, Nipomo across the river,
and Sisquoc and Garey up the valley to the east. Housing is mostly low and
detached, off a driveway rather than a shared entrance. Covering this valley
means driving it, which is what a van is for: the water, the power and the
tools arrive at the address instead of the address travelling to a shop.`,
  ],
};

/**
 * Every metro, in the order they are listed to a visitor.
 *
 * Launch order rather than alphabetical: the first entry is the fallback for a
 * neighbourhood that cannot be placed any other way, and that should be the
 * densest one rather than whichever name sorts first.
 */
export const METROS: readonly Metro[] = [LOS_ANGELES, SANTA_MARIA];

/**
 * The metro a page falls back to when there is genuinely nothing to go on.
 *
 * Reached only by a service area with no coordinates whose place_slug is in no
 * metro — a hand-inserted row, in practice. Everything else is either listed
 * or resolved by distance below.
 */
export const DEFAULT_METRO: Metro = METROS[0]!;

/** '/santa-maria'. Built here so no caller ever hardcodes the leading slash. */
export const metroPath = (m: Metro): string => `/${m.slug}`;

export const metroBySlug = (slug: string | null | undefined): Metro | null =>
  METROS.find((m) => m.slug === (slug ?? '').trim().toLowerCase()) ?? null;

/** Every area of every metro, flattened. Used by the postcode seed. */
export const ALL_METRO_AREAS: ReadonlyArray<MetroArea & { metro: Metro }> =
  METROS.flatMap((m) => m.areas.map((a) => ({ ...a, metro: m })));

const BY_PLACE_SLUG = new Map<string, Metro>(
  METROS.flatMap((m) => m.areas.map((a) => [a.slug, m] as const)),
);

export const metroAreaBySlug = (placeSlug: string): MetroArea | null => {
  const key = (placeSlug ?? '').trim().toLowerCase();
  for (const m of METROS) {
    const a = m.areas.find((x) => x.slug === key);
    if (a) return a;
  }
  return null;
};

/**
 * Which metro a neighbourhood belongs to.
 *
 * Listed areas answer by name, which is exact and free. Anything else — a real
 * operator who named a service area this file has never heard of — is answered
 * by whichever metro centre is nearest, because a neighbourhood page has to
 * lead up to SOME metro and the nearest one is the only defensible guess. That
 * fallback is why `at` is worth passing wherever the caller has coordinates.
 */
export function metroForPlace(placeSlug: string, at?: Point | null): Metro {
  const listed = BY_PLACE_SLUG.get((placeSlug ?? '').trim().toLowerCase());
  if (listed) return listed;
  if (!at) return DEFAULT_METRO;
  return METROS.reduce((best, m) =>
    (haversineMeters(at, m.centre) < haversineMeters(at, best.centre) ? m : best), DEFAULT_METRO);
}

/**
 * How a metro is described to the browser: everything static about it.
 *
 * The live figures are deliberately absent. A count of what is open belongs to
 * the request that counted it — /api/public/map — and duplicating it here would
 * be two answers to one question that can disagree.
 */
export interface PublicMetro {
  slug: string;
  name: string;
  path: string;
  state: string;
  timezone: string;
  lat: number;
  lng: number;
  areas: Array<{ slug: string; name: string; lat: number; lng: number }>;
  geography: string[];
}

export const publicMetro = (m: Metro): PublicMetro => ({
  slug: m.slug,
  name: m.name,
  path: metroPath(m),
  state: m.state,
  timezone: m.timezone,
  lat: m.centre.lat,
  lng: m.centre.lng,
  areas: m.areas.map((a) => ({ slug: a.slug, name: a.name, lat: a.lat, lng: a.lng })),
  geography: m.geography,
});
