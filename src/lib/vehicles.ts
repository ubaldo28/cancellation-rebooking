/**
 * WHAT THE BUSINESS DRIVES.
 *
 * Migration 0026 already stored the make, model, colour and plate, because
 * those are what a customer checks against their own eyes before they open the
 * door. None of them says what SHAPE is pulling up: "Ford / Transit / White"
 * is a van and "Ford / F-150 / White" is a pickup, and no amount of string
 * matching on a free-text model field will reliably tell you which — there are
 * tens of thousands of models and people type them however they like.
 *
 * So the kind is asked for directly, as a short list, and it is the one field
 * here that is not free text. Two things depend on it:
 *
 *   1. THE MAP. Vehicles cross the front page, and they are drawn as what the
 *      businesses working that neighbourhood actually drive. A junk removal
 *      firm hauling a trailer and a phone repairer in a hatchback are not the
 *      same picture, and drawing them the same is a small lie in the one place
 *      the product explains itself without words.
 *   2. THE CUSTOMER WAITING AT THE DOOR. "A white van" narrows the street far
 *      faster than "a white Ford", and it is the word a person actually uses.
 *
 * DELIBERATELY SHORT. Five entries, each one a silhouette a person can pick
 * out of a street from a first-floor window. Box lorries, flatbeds, motorbikes
 * and everything else that exists are not here because nobody on this site
 * drives one yet; add an entry when somebody does, not in case they might.
 */

export const VEHICLE_KINDS = [
  {
    slug: 'car',
    label: 'Car',
    /** What the customer is told to look for. Lower case: it is used mid-sentence. */
    noun: 'car',
    hint: 'Hatchback, saloon, estate — anything you would call a car.',
  },
  {
    slug: 'suv',
    label: 'SUV or 4x4',
    noun: 'SUV',
    hint: 'A high-sided car. Not a van: the back is seats or a boot, not a load bay.',
  },
  {
    slug: 'van',
    label: 'Van',
    noun: 'van',
    hint: 'Transit, Sprinter, ProMaster, or a smaller panel van.',
  },
  {
    slug: 'pickup',
    label: 'Pickup truck',
    noun: 'pickup',
    hint: 'An open bed behind the cab, nothing towed.',
  },
  {
    slug: 'pickup_trailer',
    label: 'Pickup and trailer',
    noun: 'pickup and trailer',
    hint: 'What most junk removal turns up in. Pick this if the trailer is normally on.',
  },
] as const;

export type VehicleKind = (typeof VEHICLE_KINDS)[number]['slug'];

const SLUGS = new Set<string>(VEHICLE_KINDS.map((v) => v.slug));

export const isVehicleKind = (x: unknown): x is VehicleKind =>
  typeof x === 'string' && SLUGS.has(x);

/** The word for it, for a sentence a customer reads. Null in, null out. */
export function vehicleNoun(kind: string | null | undefined): string | null {
  return VEHICLE_KINDS.find((v) => v.slug === kind)?.noun ?? null;
}

/**
 * THE FALLBACK, and why it is one value rather than a guess per trade.
 *
 * Every operator who signed up before this column existed has NULL here, and
 * the map still has to draw something for them. The tempting fix is a table of
 * trade to likely vehicle -- junk removal tows, locksmiths drive cars -- but
 * that is the site inventing a fact about a real business and then drawing it
 * on a public map as though the business had said it. It has not.
 *
 * A van is the honest default because it is what this product is: the sign-up
 * button says "List your van", every operator page calls it the van, and a
 * business that drives something else has a one-tap field to say so. The
 * moment they do, the map shows what they said.
 */
export const DEFAULT_VEHICLE_KIND: VehicleKind = 'van';

export const vehicleKindOr = (x: unknown): VehicleKind =>
  (isVehicleKind(x) ? x : DEFAULT_VEHICLE_KIND);
