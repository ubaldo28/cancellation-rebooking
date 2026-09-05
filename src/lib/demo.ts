import type { Env, Operator } from '../types';
import { createSession } from './auth';
import { detectGaps } from './gaps';
import { addLocalDays, fromLocal, localDayStart, toLocal } from './tz';
import { newId, now } from './util';

/**
 * Working accounts anyone can open without an email or a password.
 *
 * This exists because the app is unusable to a first-time visitor otherwise:
 * sign-in is a magic link, so with no email provider configured nobody can get
 * in at all — including the person who built it. It is also how the project
 * gets shown to someone who will not sign up to look at it.
 *
 * There are fifteen businesses rather than one because the public map is a
 * map of a neighbourhood, not of a business. Seeded with a single detailer,
 * someone searching their ZIP for junk removal was shown car detailing and
 * left. Thirteen trades over the eighteen neighbourhoods of the San Fernando
 * Valley corridor — Calabasas and Hidden Hills in the west through to Burbank
 * in the east — is the smallest seed where the map answers the question a
 * visitor actually arrived with anywhere along it.
 *
 * Every neighbourhood is worked by at least three of the fifteen and most by
 * four, and no single business claims more than five: a one-van operation
 * does not cover the whole Valley, and a seed that says it does makes the map
 * read as invented.
 *
 * The demo is wiped and rebuilt on every sign-in, so whatever the last visitor
 * did is gone and the accounts always open on the same believable week.
 */
// The detailer. The operator-side story is told from this seat, so it keeps the
// stable id everything else was built against.
export const DEMO_OPERATOR_ID = 'demo-operator';
const TZ = 'America/Los_Angeles';

/** Sessions here are short: a demo does not need a month of access. */
const DEMO_SESSION_TTL = 60 * 60 * 12;

/**
 * The San Fernando Valley corridor, west to east: Calabasas and Hidden Hills
 * out at the Ventura County end, through the mid-Valley, to Burbank.
 *
 * These are approximate neighbourhood centroids, not surveyed points. They are
 * accurate enough to drop a pin on the right neighbourhood and to make a drive
 * time believable to within a few minutes, which is the resolution the ranking
 * works at. Nothing here should be read as a street-level coordinate.
 *
 * Calabasas and Hidden Hills share ZIP 91302. That is a fact about the ZIP,
 * not a mistake here: see the postal_codes insert in seedDemo for what it
 * means for a visitor who searches by ZIP.
 */
const PLACES = {
  calabasas:      { lat: 34.1367, lng: -118.6612, zip: '91302', area: 'Calabasas' },
  hiddenHills:    { lat: 34.1678, lng: -118.6520, zip: '91302', area: 'Hidden Hills' },
  woodlandHills:  { lat: 34.1683, lng: -118.6059, zip: '91367', area: 'Woodland Hills' },
  canogaPark:     { lat: 34.2011, lng: -118.5981, zip: '91303', area: 'Canoga Park' },
  winnetka:       { lat: 34.2133, lng: -118.5711, zip: '91306', area: 'Winnetka' },
  northridge:     { lat: 34.2283, lng: -118.5370, zip: '91325', area: 'Northridge' },
  reseda:         { lat: 34.2011, lng: -118.5364, zip: '91335', area: 'Reseda' },
  tarzana:        { lat: 34.1725, lng: -118.5531, zip: '91356', area: 'Tarzana' },
  encino:         { lat: 34.1590, lng: -118.5010, zip: '91316', area: 'Encino' },
  shermanOaks:    { lat: 34.1512, lng: -118.4492, zip: '91403', area: 'Sherman Oaks' },
  vanNuys:        { lat: 34.1866, lng: -118.4487, zip: '91405', area: 'Van Nuys' },
  panoramaCity:   { lat: 34.2261, lng: -118.4409, zip: '91402', area: 'Panorama City' },
  valleyVillage:  { lat: 34.1670, lng: -118.3960, zip: '91607', area: 'Valley Village' },
  studioCity:     { lat: 34.1395, lng: -118.3870, zip: '91604', area: 'Studio City' },
  northHollywood: { lat: 34.1720, lng: -118.3790, zip: '91601', area: 'North Hollywood' },
  sunValley:      { lat: 34.2183, lng: -118.3700, zip: '91352', area: 'Sun Valley' },
  tolucaLake:     { lat: 34.1500, lng: -118.3600, zip: '91602', area: 'Toluca Lake' },
  burbank:        { lat: 34.1808, lng: -118.3090, zip: '91505', area: 'Burbank' },
};

type PlaceKey = keyof typeof PLACES;

/**
 * The neighbourhood key, shared by every operator who covers it.
 *
 * service_areas.slug has to be unique across the whole table, so the three
 * operators covering Sherman Oaks cannot all write 'sherman-oaks' there. The
 * map groups its pins on place_slug instead, and that value must be identical
 * for all of them — suffix it and Sherman Oaks splits into three pins showing
 * one trade each, which is the failure this whole seed exists to prevent.
 */
const PLACE_SLUGS: Record<PlaceKey, string> = {
  calabasas: 'calabasas',
  hiddenHills: 'hidden-hills',
  woodlandHills: 'woodland-hills',
  canogaPark: 'canoga-park',
  winnetka: 'winnetka',
  northridge: 'northridge',
  reseda: 'reseda',
  tarzana: 'tarzana',
  encino: 'encino',
  shermanOaks: 'sherman-oaks',
  vanNuys: 'van-nuys',
  panoramaCity: 'panorama-city',
  valleyVillage: 'valley-village',
  studioCity: 'studio-city',
  northHollywood: 'north-hollywood',
  sunValley: 'sun-valley',
  tolucaLake: 'toluca-lake',
  burbank: 'burbank',
};

interface DemoService {
  /** Referenced by clients and bookings below; also builds the row id. */
  key: string;
  name: string;
  secs: number;
  cents: number;
  /** NULL for work nobody books twice. Drives the overdue list. */
  cadence: number | null;
  /**
   * Parts, when the trade has any. Omitted means 'none', which is right for
   * every cleaning and detailing business here.
   *
   * It matters most for the trades the sample is meant to demonstrate: a
   * phone screen is 'included' because the price is mostly the part and
   * everybody knows what one costs, while water damage is 'quoted' because
   * nothing can be priced until the phone is open. A sample where all five
   * services say nothing about parts teaches an operator the wrong thing
   * about their own price list.
   */
  parts?: 'none' | 'included' | 'quoted';
  parts_note?: string;
  parts_low?: number;
  parts_high?: number;
}

interface DemoClientSpec {
  first: string; last: string; phone: string;
  place: PlaceKey; address: string;
  /** Days since the last visit. Cadence decides whether that is late. */
  lastVisitDays: number | null;
  service: string;
}

interface DemoBooking {
  /** Days from today. Offsets landing on a Sunday are dropped, not moved. */
  day: number;
  hour: number; minute: number;
  /** Index into the business's own client list. */
  client: number;
  service: string;
  cancelled?: boolean;
}

interface DemoLead {
  client: number; title: string; cents: number; hours: number; urgency: number;
}

/**
 * One review somebody left, written the way a customer of that trade writes.
 *
 * A detailer's reviews talk about the car and a locksmith's talk about the
 * lock: a sample where every business is praised in the same words is a sample
 * that reads as generated, which is the one impression this seed cannot afford
 * on the page a visitor uses to decide whether the site is real.
 *
 * Nothing here is copied from anybody's actual listing, and nothing claims a
 * licence, a certification or an insurance policy on the operator's behalf.
 */
interface DemoReview {
  /**
   * The full name, stored whole. displayName in lib/reviews.ts is what cuts it
   * to "Debra D." at the point it is printed, so storing it short here would
   * put the surname rule in two places and lose the correctable value.
   */
  name: string;
  rating: number;
  /** Days back from the seed, so the newest review is newest whenever it runs. */
  daysAgo: number;
  /** The service they booked, copied into reviews.details like a real one. */
  service: string;
  /**
   * NULL for a bare star rating, which is most of what people actually leave.
   * The card's snippet skips those and falls back to the next one with words,
   * so having some here exercises that rather than assuming it.
   */
  body: string | null;
}

interface DemoBusiness {
  id: string;
  email: string;
  name: string;
  trade: string;
  phone: string;
  slug: string;
  tagline: string;
  bio: string;
  years: number;
  /** Where the van sleeps: the anchor for a gap with no adjacent job. */
  base: PlaceKey;
  /**
   * Deliberately overlapping, so no ZIP shows a single trade. Capped at five:
   * a one-van business that claims eighteen neighbourhoods is not believable,
   * and the whole point of the map is that it looks like real coverage.
   */
  areas: PlaceKey[];
  services: DemoService[];
  clients: DemoClientSpec[];
  bookings: DemoBooking[];
  leads: DemoLead[];

  // ---- What the card and the profile page show about the business itself:
  // the score, the hires, the check and the switch. Migrations 0027 and 0029
  // added all of it and the demo carried none of it, so on a running site
  // every one of those features was invisible.
  //
  // The values below deliberately disagree with each other. A seed where all
  // sixteen are rated 4.9, all have been hired, all have been checked and all
  // are online teaches a visitor nothing: a marker every business carries
  // decorates the list instead of telling anyone apart, and the "this business
  // has nothing to show yet" rendering — no stars, no placeholder — never
  // happens at all, which is how it stays broken until a real operator hits it.

  /** Completed jobs, as the card counts them. Genuinely zero for the newest. */
  hired: number;
  /** Left off where one person works alone, which the column already defaults to. */
  employees?: number;
  /**
   * Years trading, which is not years_experience: somebody can have been in
   * the trade twenty years and had their own van for three. Left off where
   * nobody has filled it in, because a card has to render that too.
   */
  inBusiness?: number;
  /**
   * A background check was RUN on the named person. It is not this platform
   * vouching for the result and it is not a trade licence — see migration
   * 0027 — so nothing here names a screening company: putting a real vendor's
   * name behind a business that does not exist would be inventing exactly the
   * assurance the column is careful not to give.
   */
  check?: { name: string; daysAgo: number };
  /**
   * Hours this business is switched on for, counted from when the seed runs.
   * Absent means offline, which is most of them: see refreshOnline for how the
   * window is kept from lapsing into a demo where nobody is ever open.
   */
  onlineHours?: number;
  /** The reviews themselves. rating_sum and rating_count are derived from these. */
  reviews: DemoReview[];
}

/**
 * The fifteen seeded businesses.
 *
 * Everything a business owns hangs off its entry, so adding another trade is a
 * data edit and not a rewrite of the seeding code. Prices are whole dollars and
 * discount_percent is 0 everywhere: the old 10% turned $189 into $170.10 on the
 * public list, which reads as a rounding bug rather than a deal.
 */
const BUSINESSES: DemoBusiness[] = [
  {
    id: DEMO_OPERATOR_ID,
    email: 'demo@slotfill.app',
    name: 'Valley Shine Mobile Detailing',
    trade: 'mobile car wash and detailing',
    phone: '+18185550100',
    slug: 'valley-shine-mobile-detailing',
    tagline: 'Two-man crew, water and power on board',
    bio: 'We work out of a van across the mid-Valley — Sherman Oaks, Studio '
      + 'City, Valley Village, Encino and Tarzana. Everything is done at your '
      + 'kerb: we bring our own water, power and lighting, so nothing is '
      + 'needed from the house. Most cars take two hours.',
    years: 9,
    base: 'shermanOaks',
    areas: ['shermanOaks', 'studioCity', 'valleyVillage', 'encino', 'tarzana'],
    services: [
      { key: 'detail', name: 'Full detail',         secs: 7200, cents: 18900, cadence: 28 },
      { key: 'wash',   name: 'Wash and wax',        secs: 3600, cents:  8900, cadence: 21 },
      { key: 'seats',  name: 'Interior deep clean', secs: 5400, cents: 13900, cadence: null },
    ],
    clients: [
      { first: 'Dean',    last: 'Alvarez',   phone: '+18185550142', place: 'shermanOaks',   address: '14320 Dickens St',   lastVisitDays: 33,   service: 'detail' },
      { first: 'Marisol', last: 'Ortega',    phone: '+18185550178', place: 'studioCity',    address: '11908 Ventura Blvd', lastVisitDays: 41,   service: 'detail' },
      { first: 'Priya',   last: 'Raman',     phone: '+18185550164', place: 'encino',        address: '17200 Ventura Blvd', lastVisitDays: 55,   service: 'detail' },
      { first: 'Helen',   last: 'Kwon',      phone: '+18185550187', place: 'shermanOaks',   address: '15021 Moorpark St',  lastVisitDays: 60,   service: 'detail' },
      { first: 'Omar',    last: 'Haddad',    phone: '+18185550151', place: 'studioCity',    address: '12240 Moorpark St',  lastVisitDays: 18,   service: 'wash' },
      { first: 'Nadia',   last: 'Sarkis',    phone: '+18185550135', place: 'encino',        address: '17540 Rancho St',    lastVisitDays: null, service: 'wash' },
      { first: 'Gil',     last: 'Marchetti', phone: '+18185550196', place: 'tarzana',       address: '18620 Clark St',     lastVisitDays: 37,   service: 'detail' },
      { first: 'Trish',   last: 'Aldana',    phone: '+18185550129', place: 'valleyVillage', address: '5310 Bellaire Ave',  lastVisitDays: 26,   service: 'wash' },
    ],
    // The busiest of the ten. The story the demo has to tell is a hole in an
    // otherwise full week, and a diary with two days of work and four empty
    // ones says the operator has no business, not that they lost a slot.
    bookings: [
      { day: 0, hour:  8, minute: 30, client: 0, service: 'detail' },
      // The 11:00 job that cancelled — this is what opens the gap the
      // dashboard is pointing at when a visitor first lands.
      { day: 0, hour: 11, minute:  0, client: 1, service: 'detail', cancelled: true },
      { day: 0, hour: 14, minute:  0, client: 4, service: 'wash' },
      { day: 0, hour: 16, minute:  0, client: 3, service: 'seats' },
      { day: 1, hour:  9, minute:  0, client: 2, service: 'detail' },
      { day: 1, hour: 13, minute:  0, client: 0, service: 'wash' },
      { day: 1, hour: 15, minute: 30, client: 5, service: 'wash' },
      { day: 2, hour:  8, minute: 30, client: 3, service: 'detail' },
      { day: 2, hour: 12, minute:  0, client: 1, service: 'seats' },
      { day: 2, hour: 15, minute: 30, client: 4, service: 'wash' },
      { day: 3, hour:  9, minute: 30, client: 5, service: 'wash' },
      { day: 3, hour: 12, minute: 30, client: 0, service: 'detail' },
      { day: 3, hour: 16, minute:  0, client: 2, service: 'wash' },
      { day: 4, hour:  8, minute: 30, client: 4, service: 'detail' },
      { day: 4, hour: 11, minute: 30, client: 2, service: 'seats' },
      { day: 4, hour: 14, minute: 30, client: 3, service: 'wash' },
      { day: 5, hour:  9, minute:  0, client: 5, service: 'detail' },
      { day: 5, hour: 13, minute:  0, client: 1, service: 'wash' },
      { day: 6, hour:  8, minute: 30, client: 1, service: 'detail' },
      { day: 6, hour: 11, minute:  0, client: 3, service: 'wash' },
      { day: 6, hour: 14, minute:  0, client: 0, service: 'seats' },
      // The Tarzana and Valley Village ends of the round, added when the van
      // took on those two neighbourhoods.
      { day: 4, hour: 16, minute:  0, client: 6, service: 'wash' },
      { day: 5, hour: 11, minute: 30, client: 7, service: 'wash' },
      { day: 5, hour: 15, minute:  0, client: 6, service: 'wash' },
      { day: 6, hour: 16, minute:  0, client: 7, service: 'wash' },
    ],
    // Two quotes nobody booked — what the app offers when no one is due.
    leads: [
      { client: 2, title: 'Headlight restoration, both sides', cents: 12000, hours: 1.5, urgency: 2 },
      { client: 3, title: 'Engine bay clean before sale',      cents:  9500, hours: 1,   urgency: 4 },
    ],
    // The most established of the sixteen and the one the walkthrough is seen
    // from, so it is the one carrying a long review history and the switch
    // turned on. Not a clean sweep of fives: the three about the late arrival
    // is the review a reader trusts the other eleven because of.
    hired: 214,
    employees: 2,
    inBusiness: 6,
    check: { name: 'Daniel Ruiz', daysAgo: 300 },
    onlineHours: 3,
    reviews: [
      { name: 'Marguerite Halloway', rating: 5, daysAgo: 6, service: 'detail',
        body: 'Two hours at the kerb and the car came back better than it looked '
          + 'on the forecourt. They brought their own water and I never had to '
          + 'open the garage.' },
      { name: 'Devon Pruitt', rating: 5, daysAgo: 14, service: 'wash',
        body: 'Booked a wash and wax for a Thursday and the van was outside at '
          + 'nine. The wheels are the bit everyone skips and they were spotless.' },
      { name: 'Annika Reyes', rating: 4, daysAgo: 21, service: 'seats',
        body: 'Interior came up well and the dog hair in the back seat is finally '
          + 'gone. It ran a bit past the two hours they quoted.' },
      { name: 'Hollis Barnard',   rating: 5, daysAgo: 27, service: 'detail', body: null },
      { name: 'Sunita Kapoor', rating: 5, daysAgo: 33, service: 'detail',
        body: 'They took the tar spots off the sills without me asking. The car is '
          + 'nine years old and the paint looks even again.' },
      { name: 'Errol Mancini',    rating: 4, daysAgo: 40, service: 'wash',   body: null },
      { name: 'Bianca Trujillo', rating: 5, daysAgo: 52, service: 'detail',
        body: 'Third full detail with them. Same two men, same van, and they text '
          + 'when they are ten minutes out.' },
      { name: 'Roscoe Whitlam', rating: 3, daysAgo: 61, service: 'wash',
        body: 'The wash itself was fine but they turned up an hour and a half late '
          + 'and I had to move my afternoon around it.' },
      { name: 'Delia Ferris',     rating: 5, daysAgo: 70, service: 'seats',  body: null },
      { name: 'Grant Osei', rating: 5, daysAgo: 84, service: 'detail',
        body: 'Sold the car the week after and the buyer asked who had detailed it.' },
      { name: 'Petra Lindgren',   rating: 4, daysAgo: 95, service: 'wash',   body: null },
      { name: 'Marcus Vandenberg', rating: 5, daysAgo: 110, service: 'detail',
        body: 'Water and power both on the van, so nothing came off my tap. A '
          + 'narrow street in Studio City was no trouble for them.' },
    ],
  },

  {
    id: 'demo-operator-junk',
    email: 'demo-junk@slotfill.app',
    name: 'Haul It Away Junk Removal',
    trade: 'junk removal',
    phone: '+18185550200',
    slug: 'haul-it-away-junk-removal',
    tagline: 'Sixteen-foot truck, two loaders, we carry it out',
    bio: 'We run a sixteen-foot dump truck out of Van Nuys and cover Panorama '
      + 'City, North Hollywood, Valley Village and Sherman Oaks. Two of us '
      + 'carry, so nothing has to be dragged to the kerb first. A single item '
      + 'is about forty-five minutes and a garage takes most of a morning. '
      + 'Metal, mattresses and green waste go to the transfer station the '
      + 'same day.',
    years: 6,
    base: 'vanNuys',
    areas: ['vanNuys', 'panoramaCity', 'northHollywood', 'valleyVillage', 'shermanOaks'],
    services: [
      { key: 'single', name: 'Single item pickup', secs: 2700, cents:  9500, cadence: null },
      { key: 'half',   name: 'Half load',          secs: 5400, cents: 28500, cadence: null },
      { key: 'garage', name: 'Garage clear-out',   secs: 10800, cents: 52000, cadence: null },
    ],
    clients: [
      { first: 'Curtis', last: 'Boyle',     phone: '+18185550231', place: 'vanNuys',        address: '14812 Sylvan St',    lastVisitDays: 74,   service: 'half' },
      { first: 'Lupe',   last: 'Serrano',   phone: '+18185550248', place: 'northHollywood', address: '5734 Cahuenga Blvd', lastVisitDays: 21,   service: 'single' },
      { first: 'Barry',  last: 'Nakashima', phone: '+18185550256', place: 'valleyVillage',  address: '12150 Riverside Dr', lastVisitDays: 130,  service: 'garage' },
      { first: 'Sandra', last: 'Poole',     phone: '+18185550263', place: 'vanNuys',        address: '6420 Kester Ave',    lastVisitDays: null, service: 'half' },
      { first: 'Isaac',  last: 'Fenn',      phone: '+18185550274', place: 'valleyVillage',  address: '5218 Whitsett Ave',  lastVisitDays: 46,   service: 'single' },
      { first: 'Ramona', last: 'Diaz',      phone: '+18185550287', place: 'panoramaCity',   address: '14430 Titus St',     lastVisitDays: 58,   service: 'half' },
      { first: 'Glenn',  last: 'Ackroyd',   phone: '+18185550295', place: 'shermanOaks',    address: '13920 Ventura Blvd', lastVisitDays: null, service: 'single' },
    ],
    bookings: [
      { day: 0, hour:  8, minute:  0, client: 0, service: 'half' },
      { day: 0, hour: 13, minute:  0, client: 1, service: 'single' },
      { day: 1, hour:  8, minute: 30, client: 2, service: 'garage' },
      { day: 1, hour: 13, minute: 30, client: 3, service: 'half' },
      { day: 2, hour:  9, minute:  0, client: 4, service: 'single' },
      { day: 2, hour: 11, minute:  0, client: 0, service: 'half' },
      { day: 2, hour: 15, minute:  0, client: 1, service: 'single' },
      { day: 3, hour:  8, minute:  0, client: 3, service: 'garage' },
      { day: 3, hour: 13, minute: 30, client: 4, service: 'half' },
      { day: 4, hour:  9, minute:  0, client: 2, service: 'single' },
      { day: 4, hour: 11, minute:  0, client: 1, service: 'half' },
      { day: 5, hour:  8, minute: 30, client: 3, service: 'single' },
      { day: 5, hour: 10, minute: 30, client: 4, service: 'half' },
      { day: 6, hour:  9, minute:  0, client: 1, service: 'garage' },
      { day: 6, hour: 14, minute:  0, client: 2, service: 'single' },
      { day: 0, hour: 15, minute: 30, client: 5, service: 'single' },
      { day: 2, hour: 13, minute:  0, client: 6, service: 'single' },
      { day: 4, hour: 14, minute:  0, client: 5, service: 'half' },
      { day: 5, hour: 13, minute:  0, client: 6, service: 'single' },
    ],
    // Nothing recurs in this trade, so the backlog of quoted-but-unbooked work
    // is the only thing there is to fill a hole with.
    leads: [
      { client: 2, title: 'Shed teardown and haul, side yard', cents: 34000, hours: 2.5, urgency: 3 },
    ],
    hired: 138,
    employees: 2,
    inBusiness: 6,
    check: { name: 'Terrance Boyd', daysAgo: 420 },
    reviews: [
      { name: 'Yolanda Prentice', rating: 5, daysAgo: 9, service: 'single',
        body: 'Two of them carried a sleeper sofa up from the basement and out to '
          + 'the truck. I could not have got it to the kerb on my own.' },
      { name: 'Ben Sotomayor', rating: 5, daysAgo: 17, service: 'half',
        body: 'Half load quoted on the phone and the price did not move when they '
          + 'saw the pile.' },
      { name: 'Cyril Danforth', rating: 4, daysAgo: 26, service: 'garage',
        body: 'Garage cleared in a morning and they swept after themselves. The '
          + 'mattress was charged separately, which they said up front.' },
      { name: 'Nadine Kessler',  rating: 5, daysAgo: 38, service: 'single', body: null },
      { name: 'Ivor Bramley', rating: 5, daysAgo: 45, service: 'single',
        body: 'Old fence panels and a broken barbecue gone in forty minutes.' },
      { name: 'Rosalind Tuck',   rating: 4, daysAgo: 58, service: 'half',   body: null },
      { name: 'Amos Whitcombe', rating: 5, daysAgo: 72, service: 'half',
        body: 'The metal went to the transfer station the same day and they sent me '
          + 'a photo of the empty side yard.' },
    ],
  },

  {
    id: 'demo-operator-bins',
    email: 'demo-bins@slotfill.app',
    name: 'FreshBin Trash Can Cleaning',
    trade: 'trash can cleaning',
    phone: '+18185550300',
    slug: 'freshbin-trash-can-cleaning',
    tagline: 'Hot-water bin washing at the kerb, the day after collection',
    bio: 'We come the day after your collection day, when the bins are empty. '
      + 'The truck carries its own water and heater and the wash water leaves '
      + 'with us instead of going down the storm drain. Two bins take about '
      + 'half an hour and you do not need to be home. We cover North '
      + 'Hollywood, Valley Village, Studio City, Toluca Lake and Burbank.',
    years: 4,
    base: 'northHollywood',
    areas: ['northHollywood', 'valleyVillage', 'studioCity', 'tolucaLake', 'burbank'],
    services: [
      { key: 'two',  name: 'Two bins',           secs: 1800, cents: 3900, cadence: 28 },
      { key: 'four', name: 'Four bins',          secs: 2700, cents: 5900, cadence: 28 },
      { key: 'deep', name: 'One-off deep clean', secs: 3600, cents: 7900, cadence: null },
    ],
    clients: [
      { first: 'Yvonne', last: 'Traore',      phone: '+18185550312', place: 'northHollywood', address: '11240 Camarillo St',  lastVisitDays: 31, service: 'four' },
      { first: 'Dale',   last: 'Ferraro',     phone: '+18185550327', place: 'valleyVillage',  address: '12008 Magnolia Blvd', lastVisitDays: 24, service: 'two' },
      { first: 'Nina',   last: 'Osei',        phone: '+18185550334', place: 'studioCity',     address: '4155 Whitsett Ave',   lastVisitDays: 35, service: 'two' },
      { first: 'Rudy',   last: 'Castellanos', phone: '+18185550341', place: 'northHollywood', address: '6132 Bellaire Ave',   lastVisitDays: 14, service: 'four' },
      { first: 'Peggy',  last: 'Lindqvist',   phone: '+18185550359', place: 'studioCity',     address: '11710 Moorpark St',   lastVisitDays: 42, service: 'two' },
      { first: 'Marcus', last: 'Delgado',     phone: '+18185550366', place: 'tolucaLake',     address: '4218 Forman Ave',     lastVisitDays: 27, service: 'two' },
      { first: 'Bev',    last: 'Ostrowski',   phone: '+18185550374', place: 'burbank',        address: '1830 Catalina St',    lastVisitDays: 33, service: 'four' },
    ],
    // Short jobs, so the day is a run of them rather than two long ones. A
    // half-hour hole here is only worth offering because the next stop is a
    // street away, which is exactly what the drive-time ranking is for.
    bookings: [
      { day: 0, hour:  8, minute:  0, client: 0, service: 'four' },
      { day: 0, hour:  9, minute: 30, client: 1, service: 'two' },
      { day: 0, hour: 13, minute:  0, client: 2, service: 'two' },
      { day: 1, hour:  8, minute: 30, client: 3, service: 'two' },
      { day: 1, hour: 10, minute:  0, client: 4, service: 'four' },
      { day: 1, hour: 14, minute:  0, client: 0, service: 'deep' },
      { day: 2, hour:  9, minute:  0, client: 1, service: 'two' },
      { day: 2, hour: 11, minute:  0, client: 2, service: 'four' },
      { day: 2, hour: 15, minute:  0, client: 3, service: 'two' },
      { day: 3, hour:  8, minute:  0, client: 4, service: 'four' },
      { day: 3, hour: 10, minute:  0, client: 0, service: 'two' },
      { day: 3, hour: 13, minute: 30, client: 1, service: 'deep' },
      { day: 4, hour:  9, minute:  0, client: 2, service: 'two' },
      { day: 4, hour: 11, minute:  0, client: 4, service: 'two' },
      { day: 4, hour: 14, minute: 30, client: 3, service: 'four' },
      { day: 5, hour:  8, minute: 30, client: 1, service: 'four' },
      { day: 5, hour: 10, minute: 30, client: 0, service: 'two' },
      { day: 6, hour:  9, minute:  0, client: 4, service: 'two' },
      { day: 6, hour: 11, minute:  0, client: 3, service: 'deep' },
      { day: 6, hour: 14, minute:  0, client: 2, service: 'two' },
      // The Toluca Lake and Burbank end of the round, collected on Thursday
      // there rather than Tuesday, so those stops sit later in the week.
      { day: 3, hour: 15, minute: 30, client: 6, service: 'two' },
      { day: 4, hour: 12, minute: 30, client: 5, service: 'two' },
      { day: 5, hour: 13, minute:  0, client: 5, service: 'two' },
      { day: 5, hour: 14, minute: 30, client: 6, service: 'four' },
    ],
    leads: [],
    // Four years old, a short round and a handful of reviews: the small end of
    // the seed, and nobody has run a check on him.
    hired: 52,
    inBusiness: 4,
    reviews: [
      { name: 'Coleen Ashby', rating: 5, daysAgo: 11, service: 'four',
        body: 'They come the day after collection and the bins have stopped '
          + 'smelling in the afternoon sun. I was at work and did not need to be '
          + 'there for it.' },
      { name: 'Dwight Farrar', rating: 4, daysAgo: 24, service: 'two',
        body: 'Two bins done in half an hour. The dirty water leaves on the truck '
          + 'rather than going down the drain, which is why I called them instead '
          + 'of doing it with a hose.' },
      { name: 'Priya Venkataraman', rating: 5, daysAgo: 39, service: 'deep', body: null },
    ],
  },

  {
    id: 'demo-operator-wash',
    email: 'demo-wash@slotfill.app',
    name: 'Hard Rain Pressure Washing',
    trade: 'mobile pressure washing',
    phone: '+18185550400',
    slug: 'hard-rain-pressure-washing',
    tagline: 'Trailer rig and a 200-gallon tank, no tap needed',
    bio: 'We cover Encino, Tarzana, Reseda, Sherman Oaks and Van Nuys with a '
      + 'trailer rig and a 200-gallon tank, so we do not need a hose or an '
      + 'outdoor tap. A two-car driveway takes about an hour and a half and a '
      + 'full house wash takes most of a day. Siding is washed at low '
      + 'pressure from a ladder, not blasted.',
    years: 12,
    base: 'encino',
    areas: ['encino', 'tarzana', 'reseda', 'shermanOaks', 'vanNuys'],
    services: [
      { key: 'driveway', name: 'Driveway',       secs: 5400, cents: 17900, cadence: 180 },
      { key: 'house',    name: 'House wash',     secs: 10800, cents: 42000, cadence: null },
      { key: 'patio',    name: 'Patio and deck', secs: 7200, cents: 23900, cadence: 180 },
    ],
    clients: [
      { first: 'Terrence', last: 'Ng',        phone: '+18185550412', place: 'encino',      address: '16720 Addison St',    lastVisitDays: 210,  service: 'driveway' },
      { first: 'Alma',     last: 'Vidal',     phone: '+18185550427', place: 'shermanOaks', address: '14406 Greenleaf St',  lastVisitDays: 165,  service: 'patio' },
      { first: 'Wes',      last: 'Duffield',  phone: '+18185550433', place: 'vanNuys',     address: '15220 Cohasset St',   lastVisitDays: 92,   service: 'driveway' },
      { first: 'Corinne',  last: 'Baptiste',  phone: '+18185550448', place: 'encino',      address: '17330 Weddington St', lastVisitDays: null, service: 'house' },
      { first: 'Delia',    last: 'Marchbank', phone: '+18185550456', place: 'tarzana',     address: '19240 Wells Dr',      lastVisitDays: 240,  service: 'driveway' },
      { first: 'Hank',     last: 'Ozuna',     phone: '+18185550467', place: 'reseda',      address: '18120 Kittridge St',  lastVisitDays: 130,  service: 'patio' },
    ],
    bookings: [
      { day: 0, hour:  8, minute:  0, client: 0, service: 'driveway' },
      // The second of six cancellations today. One hole could be read as an
      // operator who simply had a quiet morning; six, spread across the trades
      // and along the corridor, is the pattern the map is there to show.
      { day: 0, hour: 10, minute: 30, client: 1, service: 'patio', cancelled: true },
      { day: 0, hour: 14, minute:  0, client: 2, service: 'driveway' },
      { day: 1, hour:  8, minute: 30, client: 3, service: 'house' },
      { day: 2, hour:  9, minute:  0, client: 1, service: 'driveway' },
      { day: 2, hour: 12, minute:  0, client: 2, service: 'patio' },
      { day: 3, hour:  8, minute:  0, client: 0, service: 'house' },
      { day: 4, hour:  9, minute:  0, client: 3, service: 'patio' },
      { day: 4, hour: 13, minute:  0, client: 1, service: 'driveway' },
      { day: 5, hour:  8, minute: 30, client: 2, service: 'driveway' },
      { day: 5, hour: 11, minute:  0, client: 0, service: 'patio' },
      { day: 6, hour:  9, minute:  0, client: 3, service: 'house' },
      { day: 1, hour: 13, minute:  0, client: 4, service: 'driveway' },
      { day: 2, hour: 15, minute:  0, client: 5, service: 'driveway' },
      { day: 3, hour: 13, minute:  0, client: 4, service: 'patio' },
      { day: 5, hour: 14, minute:  0, client: 4, service: 'driveway' },
      { day: 6, hour: 13, minute: 30, client: 5, service: 'driveway' },
    ],
    leads: [],
    // Twelve years, seventy-four jobs and not one review, which is an ordinary
    // thing for a business that has just arrived somewhere its customers do
    // not yet leave reviews. The card has to show the hires and show NOTHING
    // where the stars go — no score, no "new", no five out of five by default
    // — and that path only gets exercised if somebody in the sample is in it.
    hired: 74,
    inBusiness: 12,
    check: { name: 'Alan Whitmore', daysAgo: 190 },
    reviews: [],
  },

  // ---- The west end: Calabasas, Hidden Hills, Woodland Hills, Canoga Park,
  // Winnetka. Three businesses reach into it, which is what stops a visitor
  // out at the county line from seeing an empty map.

  {
    id: 'demo-operator-detail-west',
    email: 'demo-detail-west@slotfill.app',
    name: 'Old Mill Mobile Detailing',
    trade: 'mobile car wash and detailing',
    phone: '+18185550500',
    slug: 'old-mill-mobile-detailing',
    tagline: 'One van, water and a generator on board, west Valley only',
    bio: 'We work the west end of the Valley — Calabasas, Hidden Hills, '
      + 'Woodland Hills, Canoga Park and Winnetka. The van carries its own '
      + 'water and a generator, so we can work on a driveway or in a gated '
      + 'street with no tap to plug into. A full detail is about two hours '
      + 'and a wash and wax is an hour.',
    years: 7,
    base: 'woodlandHills',
    areas: ['calabasas', 'hiddenHills', 'woodlandHills', 'canogaPark', 'winnetka'],
    services: [
      { key: 'detail',   name: 'Full detail',      secs: 7200, cents: 19900, cadence: 28 },
      { key: 'wax',      name: 'Wash and wax',     secs: 3600, cents:  9500, cadence: 21 },
      { key: 'interior', name: 'Interior shampoo', secs: 5400, cents: 14900, cadence: null },
    ],
    clients: [
      { first: 'Rosa',  last: 'Beltran',    phone: '+18185550512', place: 'calabasas',     address: '23540 Park Granada',  lastVisitDays: 39,   service: 'detail' },
      { first: 'Ted',   last: 'Vandermeer', phone: '+18185550524', place: 'hiddenHills',   address: '5820 Jed Smith Rd',   lastVisitDays: 52,   service: 'detail' },
      { first: 'Amara', last: 'Nwosu',      phone: '+18185550533', place: 'woodlandHills', address: '22140 Erwin St',      lastVisitDays: 20,   service: 'wax' },
      { first: 'Louis', last: 'Petrakis',   phone: '+18185550547', place: 'canogaPark',    address: '7418 Owensmouth Ave', lastVisitDays: null, service: 'wax' },
      { first: 'Jen',   last: 'Halloran',   phone: '+18185550558', place: 'winnetka',      address: '20416 Kittridge St',  lastVisitDays: 44,   service: 'detail' },
    ],
    bookings: [
      { day: 0, hour:  8, minute: 30, client: 0, service: 'detail' },
      // The west-end hole. Today's cancellations are deliberately at six
      // different hours and a long drive apart, so the map shows gaps along
      // the corridor rather than one cluster in the middle.
      { day: 0, hour: 13, minute:  0, client: 1, service: 'detail', cancelled: true },
      { day: 0, hour: 15, minute: 30, client: 2, service: 'wax' },
      { day: 1, hour:  9, minute:  0, client: 3, service: 'wax' },
      { day: 1, hour: 11, minute:  0, client: 4, service: 'detail' },
      { day: 1, hour: 14, minute:  0, client: 0, service: 'interior' },
      { day: 2, hour:  8, minute: 30, client: 2, service: 'detail' },
      { day: 2, hour: 12, minute:  0, client: 1, service: 'wax' },
      { day: 2, hour: 14, minute: 30, client: 3, service: 'interior' },
      { day: 3, hour:  9, minute:  0, client: 4, service: 'detail' },
      { day: 3, hour: 13, minute:  0, client: 0, service: 'wax' },
      { day: 3, hour: 15, minute:  0, client: 2, service: 'wax' },
      { day: 4, hour:  8, minute: 30, client: 1, service: 'interior' },
      { day: 4, hour: 11, minute:  0, client: 3, service: 'detail' },
      { day: 4, hour: 14, minute: 30, client: 4, service: 'wax' },
      { day: 5, hour:  9, minute:  0, client: 0, service: 'detail' },
      { day: 5, hour: 12, minute: 30, client: 4, service: 'wax' },
      { day: 5, hour: 15, minute:  0, client: 1, service: 'wax' },
      { day: 6, hour:  8, minute: 30, client: 3, service: 'detail' },
      { day: 6, hour: 11, minute: 30, client: 2, service: 'wax' },
      { day: 6, hour: 13, minute: 30, client: 4, service: 'interior' },
    ],
    leads: [
      { client: 2, title: 'Paint decontamination and machine polish', cents: 32000, hours: 4, urgency: 2 },
    ],
    // The other one switched on, and out at the county line rather than in the
    // middle of the Valley with the detailer: two of sixteen, a long drive
    // apart, is what makes "Open now" read as a fact about a business rather
    // than a badge the map hands to everybody on it.
    hired: 61,
    inBusiness: 7,
    onlineHours: 2,
    reviews: [
      { name: 'Lorna Skerritt', rating: 5, daysAgo: 8, service: 'detail',
        body: 'A gated street in Hidden Hills with no outside tap and it made no '
          + 'difference to them — the van carries its own water and a generator.' },
      { name: 'Franklin Oduya', rating: 4, daysAgo: 19, service: 'wax',
        body: 'Wash and wax on two cars back to back. Good work on the paint, '
          + 'though a door jamb on the second one was missed.' },
      { name: 'Renata Escobar', rating: 5, daysAgo: 30, service: 'interior',
        body: 'The interior shampoo got a coffee spill out of a cream carpet that '
          + 'I had written off two years ago.' },
      { name: 'Curt Bellingham', rating: 5, daysAgo: 44, service: 'wax', body: null },
      { name: 'Halima Sesay', rating: 5, daysAgo: 63, service: 'detail',
        body: 'Arrived in Calabasas at half eight and was finished before lunch. '
          + 'Priced exactly as quoted on the phone.' },
    ],
  },

  {
    id: 'demo-operator-windows',
    email: 'demo-windows@slotfill.app',
    name: 'Clear View Window Cleaning',
    trade: 'window cleaning',
    phone: '+18185550600',
    slug: 'clear-view-window-cleaning',
    tagline: 'Hand-washed downstairs, water-fed pole upstairs',
    bio: 'Window cleaning in Calabasas, Hidden Hills, Woodland Hills, Tarzana '
      + 'and Encino. Ground-floor glass is washed by hand and upper floors '
      + 'from a water-fed pole off the van tank, so no ladder goes against a '
      + 'gutter. Screens come out and the tracks get vacuumed and wiped. A '
      + 'single-storey house inside and out is about two and a half hours; a '
      + 'two-storey is half a day.',
    years: 15,
    base: 'calabasas',
    areas: ['calabasas', 'hiddenHills', 'woodlandHills', 'tarzana', 'encino'],
    services: [
      { key: 'ext',    name: 'Exterior only, single storey',    secs:  5400, cents: 14500, cadence: 120 },
      { key: 'inout1', name: 'Single-storey house, in and out', secs:  9000, cents: 24500, cadence: 180 },
      { key: 'inout2', name: 'Two-storey house, in and out',    secs: 14400, cents: 38500, cadence: 180 },
    ],
    clients: [
      { first: 'Harriet', last: 'Sloane',   phone: '+18185550613', place: 'hiddenHills',   address: '24310 Long Valley Rd', lastVisitDays: 190,  service: 'inout2' },
      { first: 'Vince',   last: 'Okafor',   phone: '+18185550625', place: 'calabasas',     address: '4720 Park Granada',    lastVisitDays: 96,   service: 'ext' },
      { first: 'Simone',  last: 'Barrett',  phone: '+18185550634', place: 'woodlandHills', address: '5240 Dumetz Rd',       lastVisitDays: 210,  service: 'inout1' },
      { first: 'Ravi',    last: 'Chandra',  phone: '+18185550642', place: 'tarzana',       address: '18815 Ventura Blvd',   lastVisitDays: null, service: 'inout1' },
      { first: 'Marge',   last: 'Feldkamp', phone: '+18185550657', place: 'encino',        address: '16240 Weddington St',  lastVisitDays: 155,  service: 'ext' },
    ],
    // Long jobs and few of them: two houses is a full day here, so a
    // cancellation costs the whole afternoon rather than an hour.
    bookings: [
      { day: 0, hour:  8, minute:  0, client: 2, service: 'inout1' },
      { day: 0, hour: 11, minute: 30, client: 1, service: 'ext' },
      { day: 0, hour: 14, minute:  0, client: 4, service: 'ext' },
      { day: 1, hour:  8, minute: 30, client: 0, service: 'inout2' },
      { day: 1, hour: 13, minute: 30, client: 3, service: 'inout1' },
      { day: 2, hour:  8, minute:  0, client: 4, service: 'inout1' },
      { day: 2, hour: 11, minute: 30, client: 2, service: 'ext' },
      { day: 2, hour: 14, minute:  0, client: 3, service: 'ext' },
      { day: 3, hour:  8, minute: 30, client: 2, service: 'inout2' },
      { day: 3, hour: 13, minute: 30, client: 1, service: 'ext' },
      { day: 4, hour:  8, minute:  0, client: 1, service: 'inout1' },
      { day: 4, hour: 11, minute: 30, client: 0, service: 'inout1' },
      { day: 4, hour: 15, minute:  0, client: 3, service: 'ext' },
      { day: 5, hour:  8, minute: 30, client: 0, service: 'ext' },
      { day: 5, hour: 10, minute: 30, client: 4, service: 'ext' },
      { day: 5, hour: 13, minute:  0, client: 2, service: 'inout1' },
      { day: 6, hour:  8, minute:  0, client: 3, service: 'inout2' },
      { day: 6, hour: 13, minute:  0, client: 4, service: 'inout1' },
    ],
    leads: [
      { client: 0, title: 'Skylights and atrium glass, interior side', cents: 18500, hours: 2, urgency: 1 },
    ],
    // The longest established here, and the hire count says so before the
    // score does. Fifteen years on the same streets is the fact a customer
    // weighs against a business with four reviews and a better average.
    hired: 302,
    inBusiness: 15,
    check: { name: 'Vincent Arriaga', daysAgo: 120 },
    reviews: [
      { name: 'Marjorie Kwan', rating: 5, daysAgo: 7, service: 'inout1',
        body: 'Screens came out, the tracks were vacuumed and the upstairs glass '
          + 'was done off the pole instead of a ladder against my gutter.' },
      { name: 'Desmond Falk', rating: 5, daysAgo: 15, service: 'inout2',
        body: 'Two storeys inside and out in half a day, and no streaks in the '
          + 'afternoon sun, which is when I always find them.' },
      { name: 'Nell Thackeray', rating: 4, daysAgo: 23, service: 'inout1',
        body: 'The glass was done properly. They ran an hour over the estimate, '
          + 'which mattered because I had to be somewhere.' },
      { name: 'Ignacio Duarte',   rating: 5, daysAgo: 34, service: 'ext',    body: null },
      { name: 'Beatriz Cardona', rating: 5, daysAgo: 47, service: 'inout1',
        body: 'Hard water spots on the patio doors that two other cleaners had '
          + 'left alone finally came off.' },
      { name: 'Stuart Mellis',    rating: 5, daysAgo: 55, service: 'ext',    body: null },
      { name: 'Winifred Aboagye', rating: 4, daysAgo: 68, service: 'inout2', body: null },
      { name: 'Cal Rutherford', rating: 5, daysAgo: 81, service: 'ext',
        body: 'Fifteen years working the same neighbourhood and it shows — he knew '
          + 'which of my windows has the latch that sticks.' },
      { name: 'Georgia Pemberton', rating: 5, daysAgo: 96, service: 'inout1',
        body: 'Skylights cleaned from the inside with nothing spilt on the floor.' },
    ],
  },

  {
    id: 'demo-operator-lawn',
    email: 'demo-lawn@slotfill.app',
    name: 'Sherman Way Lawn and Garden',
    trade: 'landscaping and gardening',
    phone: '+18185550800',
    slug: 'sherman-way-lawn-and-garden',
    tagline: 'Mow, edge and haul, the clippings leave on the trailer',
    bio: 'Yard work in Canoga Park, Winnetka, Woodland Hills, Reseda and '
      + 'Northridge. A mow, edge and blow on a standard lot is about '
      + 'forty-five minutes and the clippings leave with us rather than '
      + 'filling your green bin. Hedges are cut with hand shears near the '
      + 'house and a trimmer along the fence line. A clean-up on a yard that '
      + 'has been left a season is most of a day.',
    years: 11,
    base: 'winnetka',
    areas: ['canogaPark', 'winnetka', 'woodlandHills', 'reseda', 'northridge'],
    services: [
      { key: 'mow',   name: 'Mow, edge and blow',                 secs:  2700, cents:  6500, cadence: 14 },
      { key: 'hedge', name: 'Hedge and shrub trim',               secs:  5400, cents: 15500, cadence: 90 },
      { key: 'clear', name: 'Yard clean-up and green waste haul', secs: 10800, cents: 38000, cadence: null },
    ],
    clients: [
      { first: 'Bonnie',   last: 'Escalante', phone: '+18185550812', place: 'winnetka',      address: '20330 Vanowen St',  lastVisitDays: 12,   service: 'mow' },
      { first: 'Sal',      last: 'Draeger',   phone: '+18185550824', place: 'canogaPark',    address: '7715 Hart St',      lastVisitDays: 16,   service: 'mow' },
      { first: 'Faye',     last: 'Odom',      phone: '+18185550836', place: 'reseda',        address: '18422 Sherman Way', lastVisitDays: 21,   service: 'mow' },
      { first: 'Hugo',     last: 'Zamarripa', phone: '+18185550845', place: 'northridge',    address: '9130 Zelzah Ave',   lastVisitDays: 88,   service: 'hedge' },
      { first: 'Delphine', last: 'Mbeki',     phone: '+18185550858', place: 'woodlandHills', address: '5715 Alhama Dr',    lastVisitDays: null, service: 'clear' },
      { first: 'Ken',      last: 'Sobczak',   phone: '+18185550867', place: 'winnetka',      address: '7240 Corbin Ave',   lastVisitDays: 13,   service: 'mow' },
    ],
    // A fortnightly round: lots of three-quarter-hour stops, so an hour that
    // opens up is worth two mows on the same street rather than one big job.
    bookings: [
      { day: 0, hour:  8, minute:  0, client: 0, service: 'mow' },
      { day: 0, hour:  9, minute:  0, client: 5, service: 'mow' },
      { day: 0, hour: 10, minute:  0, client: 3, service: 'hedge' },
      { day: 0, hour: 13, minute:  0, client: 1, service: 'mow' },
      { day: 0, hour: 14, minute:  0, client: 4, service: 'clear' },
      { day: 1, hour:  8, minute:  0, client: 2, service: 'mow' },
      { day: 1, hour:  9, minute:  0, client: 1, service: 'mow' },
      { day: 1, hour: 10, minute:  0, client: 0, service: 'mow' },
      { day: 1, hour: 11, minute:  0, client: 4, service: 'hedge' },
      { day: 1, hour: 13, minute: 30, client: 5, service: 'mow' },
      { day: 2, hour:  8, minute: 30, client: 3, service: 'clear' },
      { day: 2, hour: 12, minute: 30, client: 2, service: 'mow' },
      { day: 2, hour: 13, minute: 30, client: 0, service: 'mow' },
      { day: 2, hour: 14, minute: 30, client: 1, service: 'hedge' },
      { day: 3, hour:  8, minute:  0, client: 5, service: 'mow' },
      { day: 3, hour:  9, minute:  0, client: 1, service: 'mow' },
      { day: 3, hour: 10, minute:  0, client: 2, service: 'mow' },
      { day: 3, hour: 11, minute:  0, client: 0, service: 'hedge' },
      { day: 3, hour: 14, minute:  0, client: 3, service: 'mow' },
      { day: 4, hour:  8, minute:  0, client: 0, service: 'mow' },
      { day: 4, hour:  9, minute:  0, client: 5, service: 'mow' },
      { day: 4, hour: 10, minute:  0, client: 1, service: 'clear' },
      { day: 4, hour: 13, minute: 30, client: 2, service: 'mow' },
      { day: 4, hour: 14, minute: 30, client: 3, service: 'hedge' },
      { day: 5, hour:  8, minute: 30, client: 3, service: 'mow' },
      { day: 5, hour:  9, minute: 30, client: 4, service: 'mow' },
      { day: 5, hour: 10, minute: 30, client: 2, service: 'hedge' },
      { day: 5, hour: 13, minute:  0, client: 1, service: 'mow' },
      { day: 5, hour: 14, minute:  0, client: 0, service: 'mow' },
      { day: 6, hour:  8, minute:  0, client: 2, service: 'mow' },
      { day: 6, hour:  9, minute:  0, client: 0, service: 'mow' },
      { day: 6, hour: 10, minute:  0, client: 5, service: 'mow' },
      { day: 6, hour: 11, minute:  0, client: 4, service: 'hedge' },
      { day: 6, hour: 13, minute: 30, client: 3, service: 'clear' },
    ],
    leads: [
      { client: 5, title: 'Replace two sprinkler valves and a broken riser', cents: 24000, hours: 2, urgency: 4 },
    ],
    // No years_in_business at all: it is an optional field on a profile and
    // plenty of people never fill it in, so the row that leaves it null has to
    // exist here or the card is only ever rendered with it present.
    hired: 118,
    employees: 2,
    reviews: [
      { name: 'Antoine Villalobos', rating: 5, daysAgo: 5, service: 'mow',
        body: 'Mow, edge and blow every other Tuesday, and the clippings leave on '
          + 'the trailer instead of filling my green bin for a fortnight.' },
      { name: 'Sheila Nkemdirim', rating: 4, daysAgo: 18, service: 'hedge',
        body: 'The hedges came out square and he used shears near the house rather '
          + 'than a trimmer. A little green waste was left by the fence.' },
      { name: 'Roy Tanaka', rating: 5, daysAgo: 29, service: 'mow', body: null },
      { name: 'Constance Beaulieu', rating: 5, daysAgo: 41, service: 'clear',
        body: 'A yard left the whole of one season, cleared in a day, and every '
          + 'bag of it went with them.' },
    ],
  },

  // ---- The north of the Valley and the east end: Panorama City and
  // Northridge up top, then North Hollywood, Sun Valley, Toluca Lake and
  // Burbank. Four businesses work the east end so a Burbank ZIP search
  // returns as much as a Sherman Oaks one.

  {
    id: 'demo-operator-mechanic',
    email: 'demo-mechanic@slotfill.app',
    name: 'Roscoe Mobile Mechanic',
    trade: 'mobile oil change and mechanics',
    phone: '+18185550900',
    slug: 'roscoe-mobile-mechanic',
    tagline: 'Service van with jack stands, the car stays on the driveway',
    bio: 'Servicing and repairs in Van Nuys, Panorama City, Northridge, '
      + 'Reseda and Sun Valley. The van carries jack stands, a torque wrench '
      + 'and the common filters, so an oil change or a brake job happens '
      + 'where the car is parked. Front pads and rotors take about two hours '
      + 'and an oil change is forty-five minutes. Old oil and filters leave '
      + 'with us for recycling.',
    years: 18,
    base: 'vanNuys',
    areas: ['vanNuys', 'panoramaCity', 'northridge', 'reseda', 'sunValley'],
    services: [
      { key: 'oil',    name: 'Oil and filter change',         secs: 2700, cents: 12500, cadence: 180 },
      { key: 'brakes', name: 'Front brake pads and rotors',   secs: 7200, cents: 44500, cadence: null },
      { key: 'diag',   name: 'Diagnostic scan and road test', secs: 3600, cents: 13500, cadence: null },
    ],
    clients: [
      { first: 'Arturo', last: 'Sifuentes', phone: '+18185550912', place: 'vanNuys',      address: '14640 Hamlin St',   lastVisitDays: 172,  service: 'oil' },
      { first: 'Beth',   last: 'Kilgallen', phone: '+18185550924', place: 'panoramaCity', address: '8815 Cedros Ave',   lastVisitDays: 205,  service: 'oil' },
      { first: 'Nick',   last: 'Vardanyan', phone: '+18185550933', place: 'northridge',   address: '17420 Nordhoff St', lastVisitDays: null, service: 'brakes' },
      { first: 'Elaine', last: 'Boateng',   phone: '+18185550946', place: 'reseda',       address: '7218 Etiwanda Ave', lastVisitDays: 96,   service: 'diag' },
      { first: 'Sam',    last: 'Poulos',    phone: '+18185550955', place: 'sunValley',    address: '11330 Sheldon St',  lastVisitDays: 190,  service: 'oil' },
    ],
    bookings: [
      { day: 0, hour:  8, minute: 30, client: 0, service: 'oil' },
      { day: 0, hour: 10, minute:  0, client: 2, service: 'brakes' },
      { day: 0, hour: 13, minute:  0, client: 1, service: 'oil' },
      { day: 0, hour: 14, minute: 30, client: 3, service: 'diag' },
      { day: 1, hour:  8, minute: 30, client: 4, service: 'brakes' },
      { day: 1, hour: 11, minute:  0, client: 3, service: 'oil' },
      { day: 1, hour: 13, minute:  0, client: 0, service: 'diag' },
      { day: 1, hour: 14, minute: 30, client: 2, service: 'oil' },
      { day: 2, hour:  9, minute:  0, client: 4, service: 'oil' },
      { day: 2, hour: 10, minute: 30, client: 1, service: 'brakes' },
      { day: 2, hour: 14, minute:  0, client: 2, service: 'diag' },
      { day: 3, hour:  8, minute: 30, client: 2, service: 'oil' },
      { day: 3, hour: 10, minute:  0, client: 3, service: 'brakes' },
      { day: 3, hour: 13, minute: 30, client: 4, service: 'oil' },
      { day: 3, hour: 15, minute:  0, client: 1, service: 'diag' },
      { day: 4, hour:  8, minute: 30, client: 0, service: 'diag' },
      { day: 4, hour: 10, minute:  0, client: 1, service: 'brakes' },
      { day: 4, hour: 13, minute:  0, client: 3, service: 'oil' },
      { day: 4, hour: 14, minute: 30, client: 4, service: 'oil' },
      { day: 5, hour:  9, minute:  0, client: 0, service: 'brakes' },
      { day: 5, hour: 11, minute: 30, client: 1, service: 'oil' },
      { day: 5, hour: 13, minute: 30, client: 4, service: 'diag' },
      { day: 6, hour:  8, minute: 30, client: 3, service: 'oil' },
      { day: 6, hour: 10, minute:  0, client: 2, service: 'brakes' },
      { day: 6, hour: 13, minute:  0, client: 0, service: 'oil' },
      { day: 6, hour: 14, minute: 30, client: 1, service: 'diag' },
    ],
    leads: [
      { client: 4, title: 'Alternator and belt replacement, part in the van', cents: 62000, hours: 3, urgency: 4 },
    ],
    hired: 265,
    inBusiness: 12,
    check: { name: 'Roscoe Whitaker', daysAgo: 260 },
    reviews: [
      { name: 'Vernon Idowu', rating: 5, daysAgo: 6, service: 'brakes',
        body: 'Front pads and rotors done on my own driveway in two hours, and he '
          + 'showed me the worn ones before the new ones went on.' },
      { name: 'Lucille Sandoval', rating: 5, daysAgo: 13, service: 'oil',
        body: 'Oil and filter while I carried on working upstairs. The old oil '
          + 'left with him.' },
      { name: 'Hattie Bergstrom', rating: 4, daysAgo: 20, service: 'oil', body: null },
      { name: 'Emeka Nwachukwu', rating: 5, daysAgo: 28, service: 'diag',
        body: 'The scan and road test found a coil, not the transmission another '
          + 'garage had quoted me for.' },
      { name: 'Randall Coombes',  rating: 5, daysAgo: 36, service: 'brakes', body: null },
      { name: 'Yvette Brossard', rating: 3, daysAgo: 44, service: 'oil',
        body: 'The work was fine when he got here. He rescheduled twice first.' },
      { name: 'Nikolai Sarkissian', rating: 5, daysAgo: 55, service: 'brakes',
        body: 'Brakes on two cars in one visit and the price was the one he gave '
          + 'me on the phone.' },
      { name: 'Doreen Whitlock',  rating: 5, daysAgo: 67, service: 'oil',   body: null },
      { name: 'Basil Ferreira',   rating: 4, daysAgo: 79, service: 'diag',  body: null },
      { name: 'Camille Nkosi', rating: 5, daysAgo: 92, service: 'diag',
        body: 'Eighteen years at it and you can hear it: he had the fault named '
          + 'before I had finished describing the noise.' },
      { name: 'Hugh Danvers', rating: 5, daysAgo: 108, service: 'oil',
        body: 'Oil change on the driveway. No waiting room, no list of other things '
          + 'that apparently needed doing.' },
    ],
  },

  {
    id: 'demo-operator-junk-east',
    email: 'demo-junk-east@slotfill.app',
    name: 'Tuxford Junk Removal',
    trade: 'junk removal',
    phone: '+18185550700',
    slug: 'tuxford-junk-removal',
    tagline: 'Fourteen-foot truck out of Sun Valley, two on the crew',
    bio: 'Junk removal in Sun Valley, Burbank, North Hollywood, Toluca Lake '
      + 'and Panorama City. Two of us load, so furniture does not have to be '
      + 'moved to the kerb first. A single item is about forty-five minutes '
      + 'and a full truck takes most of a morning. Metal and green waste go '
      + 'to the transfer station on Sheldon the same day.',
    years: 5,
    base: 'sunValley',
    areas: ['sunValley', 'burbank', 'northHollywood', 'tolucaLake', 'panoramaCity'],
    services: [
      { key: 'single', name: 'Single item pickup', secs: 2700, cents:  9500, cadence: null },
      { key: 'half',   name: 'Half load',          secs: 5400, cents: 29500, cadence: null },
      { key: 'full',   name: 'Full truck load',    secs: 9000, cents: 55000, cadence: null },
    ],
    clients: [
      { first: 'Otis',    last: 'Wrenn', phone: '+18185550712', place: 'sunValley',      address: '8640 Tuxford St',    lastVisitDays: 63,   service: 'half' },
      { first: 'Camille', last: 'Roux',  phone: '+18185550726', place: 'burbank',        address: '2140 Chandler Blvd', lastVisitDays: 28,   service: 'single' },
      { first: 'Dev',     last: 'Bhatt', phone: '+18185550735', place: 'tolucaLake',     address: '4530 Placidia Ave',  lastVisitDays: 112,  service: 'full' },
      { first: 'Renata',  last: 'Pike',  phone: '+18185550744', place: 'northHollywood', address: '6215 Blix St',       lastVisitDays: null, service: 'half' },
      { first: 'Warren',  last: 'Ibe',   phone: '+18185550753', place: 'panoramaCity',   address: '9022 Willis Ave',    lastVisitDays: 41,   service: 'single' },
    ],
    bookings: [
      { day: 0, hour:  8, minute:  0, client: 2, service: 'full' },
      { day: 0, hour: 11, minute: 30, client: 1, service: 'single' },
      { day: 0, hour: 13, minute: 30, client: 0, service: 'half' },
      // The east-end hole, and the latest of today's six. A half load pulled
      // at half past three leaves an afternoon the crew cannot refill by
      // ringing round, which is the case the offer wave exists for.
      { day: 0, hour: 15, minute: 30, client: 4, service: 'half', cancelled: true },
      { day: 1, hour:  8, minute: 30, client: 3, service: 'half' },
      { day: 1, hour: 11, minute:  0, client: 4, service: 'single' },
      { day: 1, hour: 13, minute:  0, client: 0, service: 'full' },
      { day: 2, hour:  8, minute:  0, client: 1, service: 'single' },
      { day: 2, hour:  9, minute: 30, client: 2, service: 'half' },
      { day: 2, hour: 13, minute:  0, client: 3, service: 'full' },
      { day: 3, hour:  8, minute: 30, client: 4, service: 'full' },
      { day: 3, hour: 12, minute:  0, client: 1, service: 'half' },
      { day: 3, hour: 15, minute:  0, client: 0, service: 'single' },
      { day: 4, hour:  9, minute:  0, client: 3, service: 'single' },
      { day: 4, hour: 10, minute: 30, client: 0, service: 'half' },
      { day: 4, hour: 13, minute: 30, client: 2, service: 'half' },
      { day: 5, hour:  8, minute:  0, client: 1, service: 'full' },
      { day: 5, hour: 11, minute: 30, client: 2, service: 'single' },
      { day: 5, hour: 13, minute: 30, client: 4, service: 'half' },
      { day: 6, hour:  8, minute: 30, client: 3, service: 'half' },
      { day: 6, hour: 11, minute:  0, client: 0, service: 'full' },
      { day: 6, hour: 15, minute:  0, client: 1, service: 'single' },
    ],
    leads: [
      { client: 3, title: 'Garage and side-yard clear-out, two truck loads', cents: 98000, hours: 5, urgency: 3 },
    ],
    // On the site but not yet used through it: a check has been run and the
    // years are filled in, and there is nothing else to show. That is what a
    // listing looks like on its first week and the card has to say so plainly
    // rather than dressing the empty half up.
    hired: 0,
    employees: 2,
    inBusiness: 5,
    check: { name: 'Otis Merriweather', daysAgo: 45 },
    reviews: [],
  },

  {
    id: 'demo-operator-carpet',
    email: 'demo-carpet@slotfill.app',
    name: 'Whitsett Carpet and Upholstery',
    trade: 'carpet cleaning',
    phone: '+18185551000',
    slug: 'whitsett-carpet-and-upholstery',
    tagline: 'Truck-mounted extraction, hoses reach a second floor',
    bio: 'Carpet and upholstery cleaning in Studio City, Valley Village, '
      + 'Toluca Lake, Burbank and Sun Valley. The machine stays in the truck '
      + 'and we run hoses in, so the noise and the water stay outside the '
      + 'house. Three rooms take about an hour and a half. Carpet is walkable '
      + 'in two hours and dry overnight with the windows open.',
    years: 8,
    base: 'studioCity',
    areas: ['studioCity', 'valleyVillage', 'tolucaLake', 'burbank', 'sunValley'],
    services: [
      { key: 'three', name: 'Three rooms and a hall',  secs: 5400, cents: 21500, cadence: 365 },
      { key: 'house', name: 'Whole house, five rooms', secs: 9000, cents: 34500, cadence: 365 },
      { key: 'sofa',  name: 'Sofa and two armchairs',  secs: 3600, cents: 16500, cadence: null },
    ],
    clients: [
      { first: 'Gwen',  last: 'Marsalis',  phone: '+18185551012', place: 'studioCity',    address: '4022 Rhodes Ave',      lastVisitDays: 330,  service: 'three' },
      { first: 'Micah', last: 'Oyelaran',  phone: '+18185551024', place: 'valleyVillage', address: '12224 Hesby St',       lastVisitDays: 400,  service: 'house' },
      { first: 'Rhoda', last: 'Lindstrom', phone: '+18185551033', place: 'tolucaLake',    address: '10430 Valleyheart Dr', lastVisitDays: 210,  service: 'three' },
      { first: 'Leon',  last: 'Abramyan',  phone: '+18185551046', place: 'burbank',       address: '2820 Clark Ave',       lastVisitDays: null, service: 'sofa' },
      { first: 'Tammy', last: 'Nussbaum',  phone: '+18185551055', place: 'sunValley',     address: '8215 Vineland Ave',    lastVisitDays: 370,  service: 'three' },
    ],
    // A yearly cadence, so the overdue list here is long and the gap filler
    // has plenty to offer without anything having been cancelled today.
    bookings: [
      { day: 0, hour:  8, minute: 30, client: 0, service: 'three' },
      { day: 0, hour: 11, minute:  0, client: 1, service: 'house' },
      { day: 0, hour: 14, minute: 30, client: 3, service: 'sofa' },
      { day: 1, hour:  8, minute: 30, client: 2, service: 'three' },
      { day: 1, hour: 10, minute: 30, client: 4, service: 'three' },
      { day: 1, hour: 13, minute:  0, client: 3, service: 'house' },
      { day: 2, hour:  9, minute:  0, client: 0, service: 'house' },
      { day: 2, hour: 13, minute:  0, client: 3, service: 'three' },
      { day: 2, hour: 15, minute:  0, client: 2, service: 'sofa' },
      { day: 3, hour:  8, minute: 30, client: 1, service: 'three' },
      { day: 3, hour: 10, minute: 30, client: 4, service: 'sofa' },
      { day: 3, hour: 12, minute: 30, client: 2, service: 'house' },
      { day: 4, hour:  8, minute: 30, client: 4, service: 'house' },
      { day: 4, hour: 11, minute: 30, client: 3, service: 'three' },
      { day: 4, hour: 14, minute:  0, client: 1, service: 'three' },
      { day: 5, hour:  9, minute:  0, client: 2, service: 'three' },
      { day: 5, hour: 11, minute:  0, client: 0, service: 'sofa' },
      { day: 5, hour: 13, minute:  0, client: 4, service: 'house' },
      { day: 6, hour:  8, minute: 30, client: 4, service: 'three' },
      { day: 6, hour: 10, minute: 30, client: 1, service: 'house' },
      { day: 6, hour: 14, minute:  0, client: 0, service: 'sofa' },
    ],
    leads: [
      { client: 1, title: 'Stair runner and landing, wool', cents: 14500, hours: 1.5, urgency: 2 },
    ],
    hired: 90,
    inBusiness: 8,
    check: { name: 'Gwendolyn Mbeki', daysAgo: 610 },
    reviews: [
      { name: 'Isabelle Fontaine', rating: 5, daysAgo: 10, service: 'three',
        body: 'Three rooms and the hall in an hour and a half. The machine stayed '
          + 'in the truck, so the noise and the water stayed outside.' },
      { name: 'Tobias Renner', rating: 5, daysAgo: 22, service: 'house',
        body: 'Walkable the same afternoon and dry by the morning with the windows '
          + 'left open, exactly as he said it would be.' },
      { name: 'Marisa Ocampo', rating: 4, daysAgo: 31, service: 'sofa',
        body: 'The sofa came up well. One mark on an armchair lifted and then came '
          + 'back faintly a week later.' },
      { name: 'Gerald Umeh',      rating: 5, daysAgo: 45, service: 'three', body: null },
      { name: 'Fran Delacroix', rating: 5, daysAgo: 58, service: 'house',
        body: 'Five rooms before a move-out inspection and the carpet was the one '
          + 'thing the landlord had nothing to say about.' },
      { name: 'Hector Balandran', rating: 4, daysAgo: 74, service: 'sofa',  body: null },
    ],
  },

  // ---- Five trades the corridor had no cover for at all: a locksmith, a
  // house cleaner, a pool route, a grooming van and an appliance engineer.
  // All five drive to the customer and all five sell at least one job short
  // enough to drop into an hour that has just come free, which is the only
  // kind of work this product can actually rebook.

  {
    id: 'demo-operator-locksmith',
    email: 'demo-locksmith@slotfill.app',
    name: 'Nordhoff Mobile Locksmith',
    trade: 'mobile locksmith',
    phone: '+18185551100',
    slug: 'nordhoff-mobile-locksmith',
    tagline: 'Rekeys, deadbolts and car keys, booked in advance',
    // Deliberately the planned half of the trade. A locksmith who says he
    // answers a 2am lockout is selling a call-out this product cannot
    // schedule; the work that fits a cancelled hour is the work someone books
    // a day ahead after moving in, changing a tenant or losing a key.
    bio: 'Lock work booked ahead in Northridge, Reseda, Winnetka and Canoga '
      + 'Park. This is the planned side of the trade: rekeys after a move, '
      + 'changing a lock that has stopped turning, fitting a deadbolt, and '
      + 'cutting and programming a spare car key. The van carries pin kits, '
      + 'blanks, a key machine and a programmer, so it is done at your door '
      + 'or on the driveway. Three locks rekeyed is about forty-five minutes '
      + 'and a deadbolt in an existing hole is an hour. We open a lockout '
      + 'when we are already in the area; we do not run a night call-out.',
    years: 14,
    base: 'northridge',
    areas: ['northridge', 'reseda', 'winnetka', 'canogaPark'],
    services: [
      { key: 'rekey',    name: 'Rekey up to three locks',    secs: 2700, cents: 14500, cadence: null },
      { key: 'deadbolt', name: 'Deadbolt fitted',            secs: 3600, cents: 18500, cadence: null },
      { key: 'carkey',   name: 'Car key cut and programmed', secs: 3600, cents: 22500, cadence: null },
      { key: 'lockout',  name: 'Lockout door opened',        secs: 1800, cents:  9500, cadence: null },
    ],
    clients: [
      { first: 'Marguerite', last: 'Selby',      phone: '+18185551112', place: 'northridge', address: '18130 Halsted St',   lastVisitDays: 260,  service: 'rekey' },
      { first: 'Aurelio',    last: 'Pantoja',    phone: '+18185551124', place: 'reseda',     address: '7422 Wilbur Ave',    lastVisitDays: 120,  service: 'deadbolt' },
      { first: 'Kim',        last: 'Ostergaard', phone: '+18185551133', place: 'winnetka',   address: '20124 Saticoy St',   lastVisitDays: null, service: 'carkey' },
      { first: 'Trevor',     last: 'Nunley',     phone: '+18185551145', place: 'canogaPark', address: '22015 Cohasset St',  lastVisitDays: 45,   service: 'lockout' },
      { first: 'Simona',     last: 'Vlahos',     phone: '+18185551156', place: 'northridge', address: '9640 Lindley Ave',   lastVisitDays: 310,  service: 'rekey' },
      { first: 'Everett',    last: 'Ashworth',   phone: '+18185551167', place: 'reseda',     address: '18620 Victory Blvd', lastVisitDays: null, service: 'deadbolt' },
    ],
    bookings: [
      { day: 0, hour:  8, minute: 30, client: 0, service: 'rekey' },
      { day: 0, hour: 10, minute:  0, client: 3, service: 'lockout' },
      // The fifth hole in today's map. No other demo business has a job at
      // noon, so this one sits on an hour of its own.
      { day: 0, hour: 12, minute:  0, client: 1, service: 'deadbolt', cancelled: true },
      { day: 0, hour: 14, minute:  0, client: 2, service: 'carkey' },
      { day: 0, hour: 16, minute:  0, client: 4, service: 'rekey' },
      { day: 1, hour:  8, minute: 30, client: 5, service: 'deadbolt' },
      { day: 1, hour: 10, minute: 30, client: 2, service: 'lockout' },
      { day: 1, hour: 13, minute:  0, client: 1, service: 'rekey' },
      { day: 1, hour: 15, minute:  0, client: 3, service: 'carkey' },
      { day: 2, hour:  9, minute:  0, client: 4, service: 'deadbolt' },
      { day: 2, hour: 11, minute:  0, client: 0, service: 'lockout' },
      { day: 2, hour: 13, minute: 30, client: 5, service: 'rekey' },
      { day: 2, hour: 15, minute: 30, client: 2, service: 'rekey' },
      { day: 3, hour:  8, minute: 30, client: 3, service: 'rekey' },
      { day: 3, hour: 10, minute: 30, client: 1, service: 'carkey' },
      { day: 3, hour: 13, minute:  0, client: 4, service: 'lockout' },
      { day: 3, hour: 15, minute:  0, client: 0, service: 'deadbolt' },
      { day: 4, hour:  9, minute:  0, client: 2, service: 'deadbolt' },
      { day: 4, hour: 11, minute:  0, client: 5, service: 'lockout' },
      { day: 4, hour: 13, minute: 30, client: 3, service: 'rekey' },
      { day: 4, hour: 16, minute:  0, client: 1, service: 'rekey' },
      { day: 5, hour:  8, minute: 30, client: 0, service: 'carkey' },
      { day: 5, hour: 10, minute: 30, client: 4, service: 'rekey' },
      { day: 5, hour: 13, minute:  0, client: 2, service: 'deadbolt' },
      { day: 5, hour: 15, minute:  0, client: 5, service: 'lockout' },
      { day: 6, hour:  9, minute:  0, client: 1, service: 'rekey' },
      { day: 6, hour: 11, minute:  0, client: 3, service: 'deadbolt' },
      { day: 6, hour: 13, minute: 30, client: 0, service: 'lockout' },
      { day: 6, hour: 15, minute:  0, client: 4, service: 'carkey' },
    ],
    // Nothing here recurs, so as with junk removal the quoted-but-unbooked
    // work is the only thing the filler has to offer against a hole.
    leads: [
      { client: 2, title: 'Five exterior locks changed to one key', cents: 42000, hours: 2.5, urgency: 3 },
    ],
    hired: 143,
    inBusiness: 14,
    check: { name: 'Everett Nakamura', daysAgo: 75 },
    reviews: [
      { name: 'Sylvia Renwick', rating: 5, daysAgo: 4, service: 'rekey',
        body: 'Rekeyed three locks to one key the day after I got the keys to the '
          + 'house. Three quarters of an hour and I have one key on the ring now.' },
      { name: 'Emmett Kowalczyk', rating: 5, daysAgo: 12, service: 'carkey',
        body: 'Cut and programmed a spare key on the driveway for less than the '
          + 'dealer wanted to charge me for looking at it.' },
      { name: 'Roberta Nkanga', rating: 4, daysAgo: 25, service: 'deadbolt',
        body: 'Deadbolt fitted into the existing hole and it finally turns without '
          + 'me leaning on the door. Booked a day ahead and he was on time.' },
      { name: 'Perry Delahunt',   rating: 5, daysAgo: 33, service: 'rekey',    body: null },
      { name: 'Anita Faraj', rating: 5, daysAgo: 48, service: 'rekey',
        body: 'A tenant moved out and he changed the front and back locks before '
          + 'the new one moved in.' },
      { name: 'Wallace Osei-Bonsu', rating: 4, daysAgo: 60, service: 'lockout', body: null },
      { name: 'Marion Slocum', rating: 5, daysAgo: 73, service: 'deadbolt',
        body: 'The back door lock had been seizing for months. He had it out and a '
          + 'new one in inside the hour.' },
      { name: 'Rufus Aldridge',   rating: 5, daysAgo: 88, service: 'carkey',   body: null },
    ],
  },

  {
    id: 'demo-operator-cleaning',
    email: 'demo-cleaning@slotfill.app',
    name: 'Las Virgenes House Cleaning',
    trade: 'house cleaning',
    phone: '+18185551200',
    slug: 'las-virgenes-house-cleaning',
    tagline: 'Two cleaners, our own vacuums, cloths and products',
    bio: 'Two of us clean houses in Calabasas, Hidden Hills, Woodland Hills '
      + 'and Tarzana. We bring vacuums, mops, cloths and our own products, so '
      + 'nothing is used from under your sink. A two-bedroom standard clean '
      + 'is about two hours with both of us working, a deep clean that takes '
      + 'in the skirtings, the doors and the inside of the oven is half a '
      + 'day, and a move-out with the cupboards emptied and wiped runs to '
      + 'about five hours.',
    years: 10,
    base: 'calabasas',
    areas: ['calabasas', 'hiddenHills', 'woodlandHills', 'tarzana'],
    services: [
      { key: 'standard', name: 'Standard clean, two bed', secs:  7200, cents: 16000, cadence: 14 },
      { key: 'deep',     name: 'Deep clean',              secs: 14400, cents: 32000, cadence: null },
      { key: 'moveout',  name: 'Move-out clean',          secs: 18000, cents: 42000, cadence: null },
    ],
    clients: [
      { first: 'Adele',    last: 'Fontenot', phone: '+18185551212', place: 'calabasas',     address: '23820 Calabasas Rd',   lastVisitDays: 15,   service: 'standard' },
      { first: 'Rupert',   last: 'Mazzeo',   phone: '+18185551224', place: 'hiddenHills',   address: '5412 Round Meadow Rd', lastVisitDays: 22,   service: 'standard' },
      { first: 'Ingrid',   last: 'Sobol',    phone: '+18185551235', place: 'woodlandHills', address: '21630 Oxnard St',      lastVisitDays: 9,    service: 'standard' },
      { first: 'Bertrand', last: 'Achebe',   phone: '+18185551247', place: 'tarzana',       address: '18440 Collins St',     lastVisitDays: null, service: 'deep' },
      { first: 'Noor',     last: 'Haddadi',  phone: '+18185551258', place: 'woodlandHills', address: '5240 Shoup Ave',       lastVisitDays: 31,   service: 'standard' },
      { first: 'Clifford', last: 'Yeung',    phone: '+18185551269', place: 'calabasas',     address: '4318 Park Milano',     lastVisitDays: 120,  service: 'deep' },
    ],
    // A fortnightly round of two-hour cleans with the odd long job. Three
    // stops fill a day, so an hour that opens up is worth another standard
    // clean on the same street rather than half a deep clean.
    bookings: [
      { day: 0, hour:  8, minute:  0, client: 0, service: 'standard' },
      { day: 0, hour: 11, minute:  0, client: 2, service: 'standard' },
      { day: 0, hour: 14, minute:  0, client: 4, service: 'standard' },
      { day: 1, hour:  8, minute:  0, client: 3, service: 'deep' },
      { day: 1, hour: 13, minute:  0, client: 1, service: 'standard' },
      { day: 2, hour:  8, minute:  0, client: 5, service: 'deep' },
      { day: 2, hour: 13, minute: 30, client: 0, service: 'standard' },
      { day: 3, hour:  8, minute: 30, client: 1, service: 'standard' },
      { day: 3, hour: 11, minute:  0, client: 4, service: 'standard' },
      { day: 3, hour: 14, minute:  0, client: 2, service: 'standard' },
      { day: 4, hour:  8, minute:  0, client: 3, service: 'moveout' },
      { day: 4, hour: 14, minute:  0, client: 0, service: 'standard' },
      { day: 5, hour:  8, minute: 30, client: 2, service: 'standard' },
      { day: 5, hour: 11, minute:  0, client: 5, service: 'standard' },
      { day: 5, hour: 14, minute:  0, client: 1, service: 'standard' },
      { day: 6, hour:  8, minute:  0, client: 4, service: 'deep' },
      { day: 6, hour: 13, minute: 30, client: 3, service: 'standard' },
    ],
    leads: [],
    hired: 77,
    employees: 2,
    inBusiness: 10,
    reviews: [
      { name: 'Odette Mwangi', rating: 5, daysAgo: 9, service: 'standard',
        body: 'Two of them, so the whole two-bed was done in two hours. They bring '
          + 'their own vacuum, cloths and products.' },
      { name: 'Trevor Cadwell', rating: 4, daysAgo: 20, service: 'deep',
        body: 'Deep clean including the inside of the oven. Thorough, though the '
          + 'skirting in the hall was missed until I said.' },
      { name: 'Nkechi Obiora', rating: 5, daysAgo: 35, service: 'moveout',
        body: 'Move-out clean with every cupboard emptied and wiped. The deposit '
          + 'came back in full.' },
      { name: 'Lester Vogel',  rating: 5, daysAgo: 49, service: 'standard', body: null },
      { name: 'Rowena Castellon', rating: 5, daysAgo: 64, service: 'standard',
        body: 'Every other Friday for six months and the house is at the same '
          + 'standard every single time.' },
    ],
  },

  {
    id: 'demo-operator-pool',
    email: 'demo-pool@slotfill.app',
    name: 'Valley Vista Pool Service',
    trade: 'pool service',
    phone: '+18185551300',
    slug: 'valley-vista-pool-service',
    tagline: 'Weekly brush, net and water test, half an hour a stop',
    bio: 'Pool routes in Sherman Oaks, Encino, Studio City and Toluca Lake. '
      + 'Weekly service is brushing the walls and steps, netting the surface, '
      + 'emptying the baskets and testing the water, with chlorine and acid '
      + 'adjusted on the spot. That is about half an hour and the side gate '
      + 'is all we need. Filters come apart and get rinsed twice a year, '
      + 'which takes an hour. A pool that has gone green is a two-hour first '
      + 'visit and a check back later in the week.',
    years: 13,
    base: 'shermanOaks',
    areas: ['shermanOaks', 'encino', 'studioCity', 'tolucaLake'],
    services: [
      { key: 'weekly', name: 'Weekly service',      secs: 1800, cents:  3500, cadence: 7 },
      { key: 'filter', name: 'Filter clean',        secs: 3600, cents: 14500, cadence: 182 },
      { key: 'green',  name: 'Green pool recovery', secs: 7200, cents: 39500, cadence: null },
    ],
    clients: [
      { first: 'Roland',    last: 'Petrosyan',   phone: '+18185551312', place: 'shermanOaks', address: '4238 Valley Vista Blvd', lastVisitDays: 6,    service: 'weekly' },
      { first: 'Marcy',     last: 'Duplessis',   phone: '+18185551324', place: 'encino',      address: '16820 Hayvenhurst Ave',  lastVisitDays: 8,    service: 'weekly' },
      { first: 'Ivan',      last: 'Broussard',   phone: '+18185551335', place: 'studioCity',  address: '3820 Woodbridge St',     lastVisitDays: 5,    service: 'weekly' },
      { first: 'Della',     last: 'Kwiatkowski', phone: '+18185551346', place: 'tolucaLake',  address: '10240 Valley Spring Ln', lastVisitDays: 190,  service: 'filter' },
      { first: 'Hector',    last: 'Salcido',     phone: '+18185551357', place: 'encino',      address: '16430 Louise Ave',       lastVisitDays: 12,   service: 'weekly' },
      { first: 'Priscilla', last: 'Vantongeren', phone: '+18185551368', place: 'shermanOaks', address: '13640 Milbank St',       lastVisitDays: null, service: 'green' },
    ],
    // A weekly route: half-hour stops back to back, then a long job in the
    // afternoon. A seven-day cadence means the overdue list refills every
    // week, which is what the filler wants against a half-hour hole.
    bookings: [
      { day: 0, hour:  8, minute:  0, client: 0, service: 'weekly' },
      { day: 0, hour:  8, minute: 45, client: 5, service: 'weekly' },
      { day: 0, hour:  9, minute: 30, client: 1, service: 'weekly' },
      { day: 0, hour: 11, minute:  0, client: 2, service: 'weekly' },
      // The sixth hole today and the only one at three. A filter clean pulled
      // that late leaves an hour a route of half-hour stops cannot absorb.
      { day: 0, hour: 15, minute:  0, client: 3, service: 'filter', cancelled: true },
      { day: 1, hour:  8, minute:  0, client: 4, service: 'weekly' },
      { day: 1, hour:  8, minute: 45, client: 1, service: 'weekly' },
      { day: 1, hour:  9, minute: 30, client: 3, service: 'weekly' },
      { day: 1, hour: 13, minute:  0, client: 5, service: 'green' },
      { day: 2, hour:  8, minute:  0, client: 2, service: 'weekly' },
      { day: 2, hour:  9, minute:  0, client: 0, service: 'weekly' },
      { day: 2, hour: 10, minute:  0, client: 4, service: 'weekly' },
      { day: 2, hour: 13, minute: 30, client: 1, service: 'filter' },
      { day: 3, hour:  8, minute:  0, client: 3, service: 'weekly' },
      { day: 3, hour:  9, minute:  0, client: 5, service: 'weekly' },
      { day: 3, hour: 10, minute:  0, client: 2, service: 'weekly' },
      { day: 3, hour: 13, minute:  0, client: 0, service: 'filter' },
      { day: 3, hour: 15, minute:  0, client: 4, service: 'weekly' },
      { day: 4, hour:  8, minute:  0, client: 1, service: 'weekly' },
      { day: 4, hour:  8, minute: 45, client: 4, service: 'weekly' },
      { day: 4, hour: 10, minute:  0, client: 0, service: 'weekly' },
      { day: 4, hour: 11, minute:  0, client: 5, service: 'weekly' },
      { day: 4, hour: 14, minute:  0, client: 2, service: 'green' },
      { day: 5, hour:  8, minute:  0, client: 5, service: 'weekly' },
      { day: 5, hour:  8, minute: 45, client: 3, service: 'weekly' },
      { day: 5, hour:  9, minute: 30, client: 2, service: 'weekly' },
      { day: 5, hour: 11, minute:  0, client: 1, service: 'weekly' },
      { day: 5, hour: 14, minute:  0, client: 4, service: 'filter' },
      { day: 6, hour:  8, minute: 30, client: 0, service: 'weekly' },
      { day: 6, hour:  9, minute: 15, client: 4, service: 'weekly' },
      { day: 6, hour: 10, minute:  0, client: 3, service: 'weekly' },
      { day: 6, hour: 11, minute:  0, client: 5, service: 'weekly' },
      { day: 6, hour: 13, minute: 30, client: 2, service: 'weekly' },
    ],
    leads: [],
    // Thirteen years in the trade and no years_in_business filled in, which is
    // the second card that has to render the gap rather than guess at it.
    hired: 46,
    reviews: [
      { name: 'Angus Trewin', rating: 5, daysAgo: 6, service: 'weekly',
        body: 'Brush, net and a water test every week, half an hour, in and out '
          + 'through the side gate. The water has been clear all summer.' },
      { name: 'Delphine Rossi', rating: 4, daysAgo: 21, service: 'filter',
        body: 'Filter stripped and rinsed and the pressure is back down where it '
          + 'should be. They came a day later than booked.' },
      { name: 'Ezra Kaplan', rating: 5, daysAgo: 37, service: 'green',
        body: 'The pool had gone green while we were away and it was swimmable by '
          + 'the weekend.' },
    ],
  },

  {
    id: 'demo-operator-grooming',
    email: 'demo-grooming@slotfill.app',
    name: 'Sylvan Street Mobile Dog Grooming',
    trade: 'mobile pet grooming',
    phone: '+18185551400',
    slug: 'sylvan-street-mobile-dog-grooming',
    tagline: 'Bath, dry and clip in the van at your kerb',
    bio: 'A grooming van with its own water, heater and generator, working '
      + 'Van Nuys, Panorama City, Valley Village and North Hollywood. The dog '
      + 'is bathed, dried and clipped in the van outside the house and goes '
      + 'straight back inside, so there is no drop-off and no waiting in a '
      + 'crate. A bath and tidy on a small dog is an hour, a full groom on a '
      + 'medium dog is an hour and a half, and nails and ears on their own '
      + 'take twenty minutes.',
    years: 7,
    base: 'vanNuys',
    areas: ['vanNuys', 'panoramaCity', 'valleyVillage', 'northHollywood'],
    services: [
      { key: 'bath',  name: 'Bath and tidy, small dog', secs: 3600, cents:  7500, cadence: 42 },
      { key: 'full',  name: 'Full groom, medium dog',   secs: 5400, cents: 11000, cadence: 42 },
      { key: 'nails', name: 'Nails and ears only',      secs: 1200, cents:  3000, cadence: 28 },
    ],
    clients: [
      { first: 'Janine',  last: 'Kobayashi',  phone: '+18185551412', place: 'vanNuys',        address: '6810 Tyrone Ave',     lastVisitDays: 44,   service: 'full' },
      { first: 'Ollie',   last: 'Renfro',     phone: '+18185551424', place: 'panoramaCity',   address: '14210 Chase St',      lastVisitDays: 51,   service: 'bath' },
      { first: 'Sabine',  last: 'Achterberg', phone: '+18185551435', place: 'valleyVillage',  address: '12420 Chandler Blvd', lastVisitDays: 33,   service: 'full' },
      { first: 'Duncan',  last: 'Meraz',      phone: '+18185551446', place: 'northHollywood', address: '5920 Otsego St',      lastVisitDays: 26,   service: 'nails' },
      { first: 'Terri',   last: 'Vaughan',    phone: '+18185551457', place: 'vanNuys',        address: '14320 Delano St',     lastVisitDays: null, service: 'bath' },
      { first: 'Ephraim', last: 'Solis',      phone: '+18185551468', place: 'northHollywood', address: '11015 Magnolia Blvd', lastVisitDays: 60,   service: 'full' },
    ],
    // Six-week cadences on the two grooms, so somebody is always a little
    // overdue: an hour that comes free has a real candidate for it without
    // anything having to be discounted.
    bookings: [
      { day: 0, hour:  8, minute: 30, client: 0, service: 'full' },
      { day: 0, hour: 10, minute: 30, client: 1, service: 'bath' },
      { day: 0, hour: 12, minute:  0, client: 3, service: 'nails' },
      { day: 0, hour: 13, minute: 30, client: 2, service: 'full' },
      { day: 0, hour: 15, minute: 30, client: 4, service: 'bath' },
      { day: 1, hour:  8, minute: 30, client: 5, service: 'full' },
      { day: 1, hour: 10, minute: 30, client: 2, service: 'bath' },
      { day: 1, hour: 12, minute:  0, client: 0, service: 'nails' },
      { day: 1, hour: 13, minute:  0, client: 1, service: 'full' },
      { day: 1, hour: 15, minute:  0, client: 3, service: 'bath' },
      { day: 2, hour:  9, minute:  0, client: 4, service: 'full' },
      { day: 2, hour: 11, minute:  0, client: 3, service: 'full' },
      { day: 2, hour: 13, minute: 30, client: 5, service: 'bath' },
      { day: 2, hour: 15, minute:  0, client: 2, service: 'nails' },
      { day: 2, hour: 16, minute:  0, client: 1, service: 'bath' },
      { day: 3, hour:  8, minute: 30, client: 2, service: 'full' },
      { day: 3, hour: 10, minute: 30, client: 0, service: 'bath' },
      { day: 3, hour: 12, minute:  0, client: 4, service: 'nails' },
      { day: 3, hour: 13, minute:  0, client: 5, service: 'full' },
      { day: 3, hour: 15, minute:  0, client: 1, service: 'bath' },
      { day: 4, hour:  8, minute: 30, client: 1, service: 'full' },
      { day: 4, hour: 10, minute: 30, client: 5, service: 'nails' },
      { day: 4, hour: 11, minute: 30, client: 3, service: 'full' },
      { day: 4, hour: 13, minute: 30, client: 0, service: 'bath' },
      { day: 4, hour: 15, minute:  0, client: 4, service: 'full' },
      { day: 5, hour:  9, minute:  0, client: 3, service: 'bath' },
      { day: 5, hour: 10, minute: 30, client: 2, service: 'full' },
      { day: 5, hour: 13, minute:  0, client: 4, service: 'nails' },
      { day: 5, hour: 14, minute:  0, client: 1, service: 'full' },
      { day: 5, hour: 16, minute:  0, client: 5, service: 'bath' },
      { day: 6, hour:  8, minute: 30, client: 5, service: 'full' },
      { day: 6, hour: 10, minute: 30, client: 4, service: 'bath' },
      { day: 6, hour: 12, minute:  0, client: 2, service: 'nails' },
      { day: 6, hour: 13, minute:  0, client: 3, service: 'full' },
      { day: 6, hour: 15, minute:  0, client: 0, service: 'bath' },
    ],
    leads: [],
    hired: 38,
    inBusiness: 7,
    reviews: [
      { name: 'Marlee Okonjo', rating: 5, daysAgo: 8, service: 'full',
        body: 'Full groom in the van at the kerb and the dog walked straight back '
          + 'indoors. No drop-off and no morning in a crate.' },
      { name: 'Barnaby Kohl', rating: 5, daysAgo: 19, service: 'nails',
        body: 'She is nervous with strangers and they took their time with her. '
          + 'Nails and ears done in twenty minutes without a fuss.' },
      { name: 'Tessa Grimaldi', rating: 4, daysAgo: 34, service: 'bath', body: null },
    ],
  },

  {
    id: 'demo-operator-appliance',
    email: 'demo-appliance@slotfill.app',
    name: 'Verdugo Appliance Repair',
    trade: 'appliance repair',
    phone: '+18185551500',
    slug: 'verdugo-appliance-repair',
    tagline: 'Washers, dryers and fridges fixed where they stand',
    bio: 'Appliance repairs in Burbank, Toluca Lake, North Hollywood and Sun '
      + 'Valley. The van carries a meter, pumps, belts, thermostats, door '
      + 'seals and the common valves, so a lot of jobs finish on the first '
      + 'visit. A diagnostic callout is about forty-five minutes and the fee '
      + 'comes off the repair if you go ahead with it. A washer or dryer '
      + 'repair takes an hour and a half. A fridge takes two hours, because '
      + 'the system has to sit and settle before it can be read.',
    years: 16,
    base: 'burbank',
    areas: ['burbank', 'tolucaLake', 'northHollywood', 'sunValley'],
    services: [
      { key: 'diag',   name: 'Diagnostic callout',     secs: 2700, cents:  8900, cadence: null,
        parts: 'quoted',
        parts_note: 'The callout covers finding the fault. Any part is priced '
          + 'and sent to you before it goes in.',
        parts_low: 2500, parts_high: 30000 },
      { key: 'washer', name: 'Washer or dryer repair', secs: 5400, cents: 24500, cadence: null },
      { key: 'fridge', name: 'Fridge repair',          secs: 7200, cents: 32500, cadence: null },
    ],
    clients: [
      { first: 'Marlene', last: 'Pisarek',   phone: '+18185551512', place: 'burbank',        address: '1240 Verdugo Ave',   lastVisitDays: 95,   service: 'washer' },
      { first: 'Cyrus',   last: 'Tehrani',   phone: '+18185551524', place: 'tolucaLake',     address: '10620 Riverside Dr', lastVisitDays: null, service: 'diag' },
      { first: 'Fatima',  last: 'Ndiaye',    phone: '+18185551535', place: 'northHollywood', address: '7215 Klump Ave',     lastVisitDays: 40,   service: 'fridge' },
      { first: 'Gordon',  last: 'Lachance',  phone: '+18185551546', place: 'sunValley',      address: '9130 Cantara St',    lastVisitDays: 150,  service: 'washer' },
      { first: 'Alicia',  last: 'Verhoeven', phone: '+18185551557', place: 'burbank',        address: '1620 Hollywood Way', lastVisitDays: 210,  service: 'diag' },
    ],
    // Nothing recurs: an appliance is fixed when it breaks. The diary is
    // three or four calls a day and the backlog is a quoted repair waiting on
    // the customer, not a round coming due.
    bookings: [
      { day: 0, hour:  8, minute: 30, client: 0, service: 'washer' },
      { day: 0, hour: 10, minute: 30, client: 1, service: 'diag' },
      { day: 0, hour: 13, minute:  0, client: 2, service: 'fridge' },
      { day: 0, hour: 15, minute: 30, client: 3, service: 'diag' },
      { day: 1, hour:  8, minute:  0, client: 4, service: 'diag' },
      { day: 1, hour:  9, minute: 30, client: 3, service: 'washer' },
      { day: 1, hour: 12, minute:  0, client: 0, service: 'fridge' },
      { day: 1, hour: 15, minute:  0, client: 1, service: 'washer' },
      { day: 2, hour:  8, minute: 30, client: 2, service: 'diag' },
      { day: 2, hour: 10, minute:  0, client: 4, service: 'washer' },
      { day: 2, hour: 13, minute:  0, client: 1, service: 'fridge' },
      { day: 2, hour: 15, minute: 30, client: 0, service: 'diag' },
      { day: 3, hour:  8, minute:  0, client: 3, service: 'fridge' },
      { day: 3, hour: 11, minute:  0, client: 0, service: 'washer' },
      { day: 3, hour: 13, minute: 30, client: 4, service: 'diag' },
      { day: 3, hour: 15, minute:  0, client: 2, service: 'washer' },
      { day: 4, hour:  8, minute: 30, client: 1, service: 'diag' },
      { day: 4, hour: 10, minute:  0, client: 2, service: 'fridge' },
      { day: 4, hour: 13, minute:  0, client: 3, service: 'washer' },
      { day: 4, hour: 15, minute: 30, client: 4, service: 'diag' },
      { day: 5, hour:  8, minute:  0, client: 0, service: 'fridge' },
      { day: 5, hour: 11, minute:  0, client: 4, service: 'washer' },
      { day: 5, hour: 13, minute: 30, client: 2, service: 'diag' },
      { day: 5, hour: 15, minute:  0, client: 3, service: 'fridge' },
      { day: 6, hour:  8, minute: 30, client: 4, service: 'fridge' },
      { day: 6, hour: 11, minute: 30, client: 1, service: 'washer' },
      { day: 6, hour: 14, minute:  0, client: 0, service: 'diag' },
      { day: 6, hour: 15, minute: 30, client: 3, service: 'washer' },
    ],
    leads: [
      { client: 1, title: 'Dishwasher pump replacement', cents: 31000, hours: 1.5, urgency: 2 },
    ],
    // A four and a half average, which is a perfectly good business and looks
    // nothing like the rest of the seed. Two of these six say something a
    // customer would actually weigh, and one of them is not a compliment.
    hired: 158,
    inBusiness: 16,
    check: { name: 'Marlon Esparza', daysAgo: 500 },
    reviews: [
      { name: 'Ilse Brandmeyer', rating: 5, daysAgo: 7, service: 'washer',
        body: 'The washer would not drain and the pump was already in his van. '
          + 'Done on the first visit and the callout came off the price.' },
      { name: 'Sanjay Melwani', rating: 5, daysAgo: 18, service: 'fridge',
        body: 'The fridge took the two hours he warned me about, because the system '
          + 'has to sit before it can be read. Cold again and no guesswork.' },
      { name: 'Norma Petrides', rating: 4, daysAgo: 29, service: 'washer',
        body: 'Dryer belt replaced the same week I rang. He left the laundry room '
          + 'tidier than he found it.' },
      { name: 'Clive Oyeyemi',  rating: 5, daysAgo: 42, service: 'diag', body: null },
      { name: 'Wanda Kirchner', rating: 5, daysAgo: 57, service: 'diag',
        body: 'He told me the dishwasher was not worth repairing instead of selling '
          + 'me the repair, which is why I called him back about the washer.' },
      { name: 'Duane Falkowski', rating: 3, daysAgo: 70, service: 'diag',
        body: 'It is fixed, but the first visit was only the diagnosis and I had '
          + 'assumed it would be sorted that day.' },
    ],
  },

  {
    id: 'demo-operator-phone',
    email: 'demo-phone@slotfill.app',
    name: 'Valley Screen Repair',
    trade: 'phone and tablet repair',
    phone: '+18185551600',
    slug: 'valley-screen-repair',
    tagline: 'Screens and batteries done at your kerb in under an hour',
    bio: 'Phone and tablet repairs across Sherman Oaks, Encino, Van Nuys and '
      + 'Studio City, done in the van outside your door. Screens and batteries '
      + 'for the common iPhone and Samsung models are carried, so those finish '
      + 'in one visit and the part is already in the price. Water damage is the '
      + 'exception: nothing can be quoted until the phone is open, so the '
      + 'callout covers the diagnosis and any part is sent to you for approval '
      + 'before it is fitted. Registered with the Bureau of Household Goods and '
      + 'Services.',
    years: 7,
    base: 'shermanOaks',
    areas: ['shermanOaks', 'encino', 'vanNuys', 'studioCity'],
    services: [
      { key: 'screen',  name: 'Phone screen replacement',   secs: 2700, cents: 15900, cadence: null,
        parts: 'included', parts_note: 'Screen and fitting are both in the price.' },
      { key: 'battery', name: 'Phone battery replacement',  secs: 1800, cents:  8900, cadence: null,
        parts: 'included', parts_note: 'Battery included.' },
      { key: 'tablet',  name: 'Tablet screen replacement',  secs: 3600, cents: 22900, cadence: null,
        parts: 'included', parts_note: 'Screen included.' },
      // The one job nobody can price from the kerb, and the reason the quote
      // flow exists at all.
      { key: 'water',   name: 'Water damage diagnosis',     secs: 2700, cents:  6900, cadence: null,
        parts: 'quoted',
        parts_note: 'This covers opening it up and telling you what is wrong. '
          + 'If it needs a part I will send you the price before I fit anything.',
        parts_low: 3500, parts_high: 18000 },
      { key: 'port',    name: 'Charge port repair',         secs: 2700, cents: 10900, cadence: null,
        parts: 'included', parts_note: 'Port and fitting included.' },
    ],
    clients: [
      { first: 'Nadia',   last: 'Obasanjo',  phone: '+18185551612', place: 'shermanOaks', address: '14320 Ventura Blvd',   lastVisitDays: 120,  service: 'screen' },
      { first: 'Teodoro', last: 'Salcedo',   phone: '+18185551624', place: 'encino',      address: '17200 Ventura Blvd',   lastVisitDays: null, service: 'battery' },
      { first: 'Priya',   last: 'Ramanathan', phone: '+18185551635', place: 'vanNuys',    address: '14650 Sherman Way',    lastVisitDays: 60,   service: 'tablet' },
      { first: 'Callum',  last: 'Whitfield', phone: '+18185551646', place: 'studioCity',  address: '12100 Ventura Blvd',   lastVisitDays: 200,  service: 'screen' },
      { first: 'Yesenia', last: 'Aguirre',   phone: '+18185551657', place: 'shermanOaks', address: '4600 Van Nuys Blvd',   lastVisitDays: 30,   service: 'port' },
    ],
    // Short jobs, a lot of them, and nothing recurs -- a screen is replaced
    // when it breaks. Five or six calls a day with real gaps between them,
    // which is exactly the shape this product is built to sell.
    bookings: [
      { day: 0, hour:  9, minute:  0, client: 0, service: 'screen' },
      { day: 0, hour: 10, minute: 30, client: 1, service: 'battery' },
      { day: 0, hour: 13, minute:  0, client: 2, service: 'tablet' },
      { day: 0, hour: 15, minute:  0, client: 3, service: 'screen' },
      { day: 1, hour:  8, minute: 30, client: 4, service: 'port' },
      { day: 1, hour: 10, minute:  0, client: 0, service: 'battery' },
      { day: 1, hour: 12, minute: 30, client: 3, service: 'water' },
      { day: 1, hour: 15, minute:  0, client: 2, service: 'screen' },
      { day: 2, hour:  9, minute:  0, client: 1, service: 'screen' },
      { day: 2, hour: 11, minute:  0, client: 4, service: 'tablet' },
      { day: 2, hour: 14, minute:  0, client: 0, service: 'port' },
      { day: 3, hour:  8, minute: 30, client: 2, service: 'battery' },
      { day: 3, hour: 10, minute: 30, client: 3, service: 'screen' },
      { day: 3, hour: 13, minute: 30, client: 1, service: 'water' },
      { day: 3, hour: 15, minute: 30, client: 4, service: 'screen' },
      { day: 4, hour:  9, minute:  0, client: 3, service: 'battery' },
      { day: 4, hour: 11, minute:  0, client: 0, service: 'tablet' },
      { day: 4, hour: 14, minute:  0, client: 2, service: 'port' },
      { day: 5, hour:  8, minute: 30, client: 4, service: 'screen' },
      { day: 5, hour: 10, minute: 30, client: 1, service: 'battery' },
      { day: 5, hour: 13, minute:  0, client: 3, service: 'tablet' },
      { day: 5, hour: 15, minute:  0, client: 0, service: 'screen' },
      { day: 6, hour:  9, minute: 30, client: 2, service: 'battery' },
      { day: 6, hour: 12, minute:  0, client: 4, service: 'water' },
      { day: 6, hour: 14, minute: 30, client: 1, service: 'port' },
    ],
    leads: [
      { client: 2, title: 'Tablet digitiser, part on order', cents: 22900, hours: 1, urgency: 2 },
    ],
    // The newest listing on the site and the emptiest card in the seed: no
    // score, no hires, no check and no years. Every one of those is a hole the
    // front end has to leave alone, and the one business that has all four is
    // the one that proves it does.
    hired: 0,
    reviews: [],
  },
];


/** Every id the demo owns. wipe and the seeder both need the whole set. */
const DEMO_OPERATOR_IDS = BUSINESSES.map((b) => b.id);

/** Service row id. Global uniqueness matters: several businesses sell a 'wash'. */
function serviceId(business: DemoBusiness, key: string): string {
  return `${business.id}-sv-${key}`;
}

/**
 * Removes every row the demo owns. Child rows first: D1 does not cascade.
 *
 * Deletes across the whole set of demo operators rather than one id, so a
 * business added to BUSINESSES is not left behind as an orphan the next seed
 * then collides with on profile_slug or email.
 */
async function wipe(env: Env): Promise<void> {
  const ids = DEMO_OPERATOR_IDS;
  const holes = ids.map(() => '?').join(',');
  const stmts = [
    // Reviews go with the rest of it. They outlive the booking they describe
    // by design, so nothing else is ever going to clear them, and a seed that
    // left them behind would hand the rebuilt business a second copy of every
    // review and a rating_count saying twice what its own rows say.
    `DELETE FROM reviews WHERE operator_id IN (${holes})`,
    `DELETE FROM messages WHERE operator_id IN (${holes})`,
    `DELETE FROM gap_offers WHERE operator_id IN (${holes})`,
    `DELETE FROM public_claims WHERE operator_id IN (${holes})`,
    `DELETE FROM gaps WHERE operator_id IN (${holes})`,
    `DELETE FROM appointments WHERE operator_id IN (${holes})`,
    `DELETE FROM job_leads WHERE operator_id IN (${holes})`,
    `DELETE FROM clients WHERE operator_id IN (${holes})`,
    `DELETE FROM services WHERE operator_id IN (${holes})`,
    `DELETE FROM service_areas WHERE operator_id IN (${holes})`,
    `DELETE FROM working_hours WHERE operator_id IN (${holes})`,
    `DELETE FROM time_off WHERE operator_id IN (${holes})`,
    // Photos are R2 keys, not bytes, so dropping the rows is the whole job.
    `DELETE FROM work_photos WHERE operator_id IN (${holes})`,
    `DELETE FROM sessions WHERE operator_id IN (${holes})`,
    `DELETE FROM login_tokens WHERE operator_id IN (${holes})`,
    `DELETE FROM operators WHERE id IN (${holes})`,
  ].map((sql) => env.DB.prepare(sql).bind(...ids));
  await env.DB.batch(stmts);
}

/**
 * Wall-clock helper: an hour and minute on a given local day.
 *
 * Built from the local calendar date rather than by adding seconds to
 * midnight, so a demo generated on a clock-change day still books at 8:30
 * local and not 7:30 or 9:30.
 */
function at(dayStart: number, hour: number, minute = 0): number {
  const p = toLocal(dayStart, TZ);
  return fromLocal(TZ, p.year, p.month, p.day, hour * 60 + minute);
}

/**
 * Rebuilds every demo business and its week of work from scratch.
 *
 * Split from startDemo so the public map can populate itself before anyone has
 * signed up, without also handing out a session.
 */
/**
 * BUMP THIS WHENEVER THE SAMPLE DATA CHANGES IN ANY WAY.
 *
 * A new business, different prices, different reviews, a different rating —
 * anything. `seedDemoIfEmpty` compares this number against the one stored in
 * the database and rebuilds when they differ, and it is the only thing that
 * carries a change in this file to a database that has already been seeded.
 *
 * Version 2 is the release that gave the sample businesses reviews, star
 * ratings, hired counts, background checks, years in business and the
 * open-for-work switch. Version 1 is everything before it, which is what a
 * database seeded before the `demo_seed` table existed is assumed to hold.
 */
export const DEMO_SEED_VERSION = 2;

export async function seedDemo(env: Env): Promise<void> {
  const t = now();
  await wipe(env);

  // Stamped as part of the rebuild rather than after it, so a seed that fails
  // half way does not leave a version claiming data that is not there.
  await env.DB.prepare(
    `INSERT INTO demo_seed (id, version, seeded_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET version = excluded.version,
                                     seeded_at = excluded.seeded_at`,
  ).bind(DEMO_SEED_VERSION, t).run();

  const today = localDayStart(t, TZ);
  const opRows: D1PreparedStatement[] = [];
  const rows: D1PreparedStatement[] = [];

  // Counts how many operators have claimed each neighbourhood so far. The
  // first takes the bare slug and the rest are suffixed, which keeps
  // service_areas.slug unique without touching place_slug.
  const areaSeq = new Map<string, number>();

  for (const b of BUSINESSES) {
    const home = PLACES[b.base];

    // The counters are added up from the review rows that are about to be
    // written, never typed in beside them. They are a cache of that table and
    // nothing keeps the two honest but this: a hand-kept pair drifts the first
    // time somebody edits a rating above, and the business then shows a score
    // its own reviews visibly do not add up to — which is the kind of thing a
    // customer notices and we do not.
    const ratingSum = b.reviews.reduce((n, rv) => n + rv.rating, 0);

    // Absolute, because that is what the column is: "online" is online_until
    // in the future and nothing else, so no sweep can leave somebody
    // advertised after they have gone home. See refreshOnline for what keeps
    // it from lapsing in a demo database nobody has reseeded.
    const onlineUntil = b.onlineHours == null
      ? null : t + Math.round(b.onlineHours * 3600);

    opRows.push(env.DB.prepare(
      `INSERT INTO operators (id,email,business_name,trade,phone_e164,timezone,country,
         currency,language,location_mode,fill_model,sms_mode,home_lat,home_lng,
         min_gap_seconds,max_detour_seconds,buffer_seconds,offer_ttl_seconds,
         offers_per_wave,min_notice_seconds,reoffer_cooldown_seconds,discount_percent,
         plan,accept_public_bookings,deposit_cents,
         tagline,bio,years_experience,profile_slug,is_published,
         employees,years_in_business,background_check_name,background_checked_at,
         rating_sum,rating_count,hired_count,online_until,online_since,
         created_at,updated_at)
       VALUES (?,?,?,?,?,?, 'US','USD','en','mobile','both','device',?,?,
         3600,900,900,5400,3,3600,604800,0,'active',1,2500,?,?,?,?,1,
         ?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(b.id, b.email, b.name, b.trade, b.phone, TZ,
      home.lat, home.lng, b.tagline, b.bio, b.years, b.slug,
      b.employees ?? 1, b.inBusiness ?? null,
      // The name a check was run on, and when. Nothing is asserted about the
      // result and no provider is named: recording that a check happened is
      // the whole of what migration 0027 allows, and a sample listing must not
      // read as this platform having vouched for anybody.
      b.check?.name ?? null, b.check ? t - b.check.daysAgo * 86400 : null,
      ratingSum, b.reviews.length, b.hired,
      onlineUntil, onlineUntil === null ? null : t,
      t, t));

    // Mon-Sat, 8am to 6pm.
    for (const wd of [1, 2, 3, 4, 5, 6]) {
      rows.push(env.DB.prepare(
        `INSERT INTO working_hours (id,operator_id,weekday,start_minute,end_minute,created_at)
         VALUES (?,?,?,?,?,?)`,
      ).bind(newId(), b.id, wd, 8 * 60, 18 * 60, t));
    }

    for (const svc of b.services) {
      rows.push(env.DB.prepare(
        `INSERT INTO services (id,operator_id,name,duration_seconds,price_cents,
           cadence_days,is_mobile,is_active,gap_fill_eligible,
           parts_policy,parts_note,parts_estimate_low_cents,parts_estimate_high_cents,
           created_at,updated_at)
         VALUES (?,?,?,?,?,?,1,1,1,?,?,?,?,?,?)`,
      ).bind(serviceId(b, svc.key), b.id, svc.name, svc.secs, svc.cents,
        svc.cadence, svc.parts ?? 'none', svc.parts_note ?? null,
        svc.parts_low ?? null, svc.parts_high ?? null, t, t));
    }

    for (const placeKey of b.areas) {
      const p = PLACES[placeKey];
      const placeSlug = PLACE_SLUGS[placeKey];
      const n = (areaSeq.get(placeSlug) ?? 0) + 1;
      areaSeq.set(placeSlug, n);
      const rowSlug = n === 1 ? placeSlug : `${placeSlug}-${n}`;
      rows.push(env.DB.prepare(
        `INSERT INTO service_areas (id,operator_id,name,slug,place_slug,lat,lng,
           radius_meters,is_active,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,6000,1,?,?)`,
      ).bind(newId(), b.id, p.area, rowSlug, placeSlug, p.lat, p.lng, t, t));
      // The public page geocodes a visitor's ZIP against this table. Shared
      // across businesses, so it is written once per ZIP and ignored after.
      //
      // OR IGNORE is doing real work for 91302, which is Calabasas AND Hidden
      // Hills. The table's primary key is (country_code, postal_code), so one
      // ZIP can only hold one point: whichever of the two is written first
      // wins and the second is dropped. Someone who types 91302 is therefore
      // placed at a single centroid — no coordinate is corrupted, but the
      // offline geocoder genuinely cannot tell the two neighbourhoods apart.
      // Clients and service areas do not go through it (they carry the PLACES
      // coordinates directly), so only ZIP search is affected, and the two
      // centroids are about a mile and a half apart.
      rows.push(env.DB.prepare(
        `INSERT OR IGNORE INTO postal_codes (country_code,postal_code,place_name,lat,lng,accuracy)
         VALUES ('US',?,?,?,?,6)`,
      ).bind(p.zip, p.area, p.lat, p.lng));
    }

    const svcByKey = new Map(b.services.map((sv) => [sv.key, sv]));
    const clientIds: string[] = [];
    for (const c of b.clients) {
      const id = newId();
      clientIds.push(id);
      const p = PLACES[c.place];
      const svc = svcByKey.get(c.service)!;
      const last = c.lastVisitDays === null ? null : t - c.lastVisitDays * 86400;
      // One-off work has no next visit to be late for, so leaving next_due_at
      // null keeps junk removal and house washes off the overdue list instead
      // of showing every past customer as owing a booking.
      const due = last !== null && svc.cadence ? last + svc.cadence * 86400 : null;
      rows.push(env.DB.prepare(
        `INSERT INTO clients (id,operator_id,first_name,last_name,phone_e164,
           address_line,postcode,lat,lng,geocode_status,geocoded_at,default_service_id,
           last_serviced_at,next_due_at,visit_count,sms_consent,sms_consent_at,
           acquired,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?, 'ok',?,?,?,?,?,1,?, 'operator',?,?)`,
      ).bind(id, b.id, c.first, c.last, c.phone, c.address, p.zip,
        p.lat, p.lng, t, serviceId(b, c.service), last, due,
        c.lastVisitDays === null ? 0 : 4, t, t, t));
    }

    for (const bk of b.bookings) {
      const dayStart = addLocalDays(today, TZ, bk.day);
      // Nobody works Sunday, and a job sitting outside the working window
      // shows on the diary as an appointment the gap detector cannot see.
      // Dropping it costs one day of a seven-day spread; moving it would put
      // four jobs on a Monday.
      if (toLocal(dayStart, TZ).weekday === 0) continue;

      const c = b.clients[bk.client]!;
      const p = PLACES[c.place];
      const svc = svcByKey.get(bk.service)!;
      const start = at(dayStart, bk.hour, bk.minute);
      rows.push(env.DB.prepare(
        `INSERT INTO appointments (id,operator_id,client_id,service_id,starts_at,ends_at,
           is_mobile,address_line,postcode,lat,lng,status,cancelled_at,cancelled_by,
           price_cents,source,created_at,updated_at)
         VALUES (?,?,?,?,?,?,1,?,?,?,?,?,?,?,?, 'manual',?,?)`,
      ).bind(newId(), b.id, clientIds[bk.client]!, serviceId(b, bk.service),
        start, start + svc.secs, c.address, p.zip, p.lat, p.lng,
        bk.cancelled ? 'cancelled' : 'scheduled',
        // Recorded rather than left null: a cancelled row with no cancelled_at
        // is indistinguishable from an import artefact.
        bk.cancelled ? t : null, bk.cancelled ? 'client' : null,
        svc.cents, t, t));
    }

    for (const lead of b.leads) {
      rows.push(env.DB.prepare(
        `INSERT INTO job_leads (id,operator_id,client_id,title,quoted_price_cents,quoted_at,
           estimated_duration_seconds,parts_required,parts_ready,urgency,status,
           created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,0,1,?, 'open',?,?)`,
      ).bind(newId(), b.id, clientIds[lead.client]!, lead.title, lead.cents, t,
        Math.round(lead.hours * 3600), lead.urgency, t, t));
    }

    b.reviews.forEach((rv, i) => {
      // Ids built from the business rather than random, and that matters for
      // order_item_id: it is unique across the table, and it is deliberately
      // not a foreign key, so nothing cleans these up on the way past. A
      // derived id cannot collide with a real order item, and a re-seed
      // rewrites the same row instead of stacking a second review on the same
      // job — the exact duplication the unique index exists to refuse.
      const id = `${b.id}-rv-${i + 1}`;
      const written = t - rv.daysAgo * 86400;
      rows.push(env.DB.prepare(
        `INSERT INTO reviews (id,operator_id,order_item_id,author_name,rating,body,
           details,reply,replied_at,hidden_at,hidden_reason,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,?,?)`,
        // details is the service as it was booked, copied like the price on a
        // receipt: the sample business can be renamed later and the review
        // still describes the job that customer actually had.
      ).bind(id, b.id, `${id}-item`, rv.name, rv.rating, rv.body,
        svcByKey.get(rv.service)!.name, written, written));
    });
  }

  // Operators land first: every row below points at one, and D1 enforces the
  // foreign keys.
  await env.DB.batch(opRows);
  await env.DB.batch(rows);

  // Let the real gap detector find the holes, so the demo shows exactly what
  // production logic produces rather than hand-placed rows. Per operator,
  // because detectGaps reads that operator's own hours and notice window.
  const holes = DEMO_OPERATOR_IDS.map(() => '?').join(',');
  const ops = await env.DB.prepare(
    `SELECT * FROM operators WHERE id IN (${holes})`,
  ).bind(...DEMO_OPERATOR_IDS).all<Operator>();
  for (const op of ops.results ?? []) await detectGaps(env, op, today, 14);
}

/**
 * Rolls the sample "Open now" windows forward once they have lapsed.
 *
 * Everything else in this seed is written as an offset from the day it runs —
 * a booking is "day 3 at half eight", not a date — precisely so the demo is
 * never showing a week that has already happened. online_until cannot be an
 * offset: it is an absolute timestamp by design, because "online" is
 * online_until in the future and a boolean would need a sweep to ever be
 * false. So the same staleness this file avoids everywhere else arrives here
 * on its own: the seed only reruns when the demo is missing or a business has
 * been added, and a database seeded last Tuesday therefore has nobody switched
 * on at all, which quietly deletes the feature from the site rather than
 * breaking it visibly.
 *
 * This is that offset, applied late. It moves the window on only when it has
 * actually run out, so a visitor watching the countdown on a listing does not
 * see it jump, and it costs one read on the map request that finds nothing to
 * do — which is nearly all of them.
 */
async function refreshOnline(env: Env): Promise<void> {
  const on = BUSINESSES.filter((b) => b.onlineHours != null);
  if (on.length === 0) return;

  const t = now();
  const holes = on.map(() => '?').join(',');
  const lapsed = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM operators
      WHERE id IN (${holes}) AND (online_until IS NULL OR online_until <= ?)`,
  ).bind(...on.map((b) => b.id), t).first<{ n: number }>();
  if ((lapsed?.n ?? 0) === 0) return;

  await env.DB.batch(on.map((b) => env.DB.prepare(
    `UPDATE operators SET online_until = ?, online_since = ?, updated_at = ?
      WHERE id = ? AND (online_until IS NULL OR online_until <= ?)`,
  ).bind(t + Math.round(b.onlineHours! * 3600), t, t, b.id, t)));
}

/**
 * Rebuilds every demo business and returns a session cookie for one.
 *
 * The visitor is signed in as the mid-Valley detailer: the operator-side
 * walkthrough is written around its cancelled 11:00 job, and the other fourteen
 * exist so the public map has more than one trade in it at either end of the
 * corridor as well as in the middle.
 */
export async function startDemo(env: Env, userAgent: string | null): Promise<string> {
  await seedDemo(env);
  return createSession(env, DEMO_OPERATOR_ID, userAgent, DEMO_SESSION_TTL);
}

/**
 * Populates the demo only when there is genuinely nothing to show.
 *
 * Before the first real operator signs up the public map would otherwise be a
 * blank page, which tells a visitor the product is broken rather than empty.
 * The zero-areas check means this runs once and never disturbs live data.
 */
/**
 * Is this one of the demo businesses?
 *
 * The sign-up wizard resumes whatever account is signed in. Someone looking at
 * the demo who then clicks "list your van" was being walked through setting up
 * the demo detailer — shown its services while choosing their own trade. The
 * wizard needs to know the difference.
 */
export function isDemoOperator(id: string): boolean {
  return DEMO_OPERATOR_IDS.includes(id);
}

export async function seedDemoIfEmpty(env: Env): Promise<boolean> {
  if (env.DEMO_MODE !== 'on') return false;

  // Never touch a database that has a real operator in it. Everything below
  // wipes and rebuilds, and that must never reach someone's actual business.
  const holes = DEMO_OPERATOR_IDS.map(() => '?').join(',');
  const real = await env.DB.prepare(
    `SELECT 1 FROM operators WHERE id NOT IN (${holes}) LIMIT 1`,
  ).bind(...DEMO_OPERATOR_IDS).first();
  if (real) return false;

  // Reseed when the demo is missing OR out of date.
  //
  // The first version of this only checked for an empty map, so once the demo
  // had ever run, a change to it never reached the site: the database still
  // held one detailer, and a visitor filtering for junk removal was shown a
  // wax service. Counting the demo businesses that exist means adding one to
  // the list is enough to rebuild.
  const have = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM operators WHERE id IN (${holes})`,
  ).bind(...DEMO_OPERATOR_IDS).first<{ n: number }>();
  /**
   * All sixteen present is NOT the same as up to date, and assuming it was
   * cost a whole release.
   *
   * Counting rows only notices a business being added. The release that gave
   * these businesses reviews, ratings, hired counts and the open-for-work
   * switch changed no row count at all, so this check said "nothing to do" and
   * the live site went on serving businesses with no reviews — while every
   * local database, which starts empty and therefore always seeds fresh,
   * showed the new data and looked correct.
   *
   * So the count is now only half the test. The other half is the version the
   * seed carries, which changes whenever the sample data does.
   */
  const stamp = await env.DB.prepare(
    `SELECT version FROM demo_seed WHERE id = 1`,
  ).first<{ version: number }>();

  if ((have?.n ?? 0) === DEMO_OPERATOR_IDS.length
      && (stamp?.version ?? 1) >= DEMO_SEED_VERSION) {
    // Up to date in every way a rebuild would fix, except the one column that
    // measures itself against the clock rather than against this list.
    await refreshOnline(env);
    return false;
  }

  await seedDemo(env);
  return true;
}
