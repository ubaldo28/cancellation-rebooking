/**
 * Every trade the site knows about, grouped the way a customer looks for one.
 *
 * The grouping is the point. A flat list of forty trades is a list nobody
 * reads: somebody who wants their car washed does not scan alphabetically past
 * "mobile bookstore" to find it. Categories are how every marketplace that
 * works presents this, and it is what the references for this project showed.
 *
 * ONE SOURCE OF TRUTH, HERE. The sign-up picker, the customer's browse page,
 * the licensing rules and the sample businesses all read this list. It lived
 * in three places before -- a web constant, a credentials map and the demo
 * seeds -- and they had already drifted: a trade could be pickable at sign-up
 * and invisible to customers, which is exactly what happened to phone repair.
 *
 * The Worker serves it to the browser rather than the browser holding its own
 * copy, for the same reason.
 */

export interface Trade {
  /** The stored value on operators.trade. Lower case, and never changed once shipped. */
  slug: string;
  /** What a person calls it. */
  label: string;
  /** Shown under the label when the name alone is ambiguous. */
  hint?: string;
}

export interface TradeCategory {
  key: string;
  label: string;
  trades: Trade[];
}

/**
 * The catalogue.
 *
 * Slugs are the values already stored on live operator rows, so the ones that
 * existed before keep their exact spelling -- 'mobile car wash and detailing',
 * not the shorter 'car wash and detailing' a person would write -- and carry
 * the friendlier wording in `label` instead.
 * Renaming a slug would orphan every business already using it.
 */
export const TRADE_CATEGORIES: TradeCategory[] = [
  {
    key: 'auto',
    label: 'Automotive and vehicle',
    trades: [
      { slug: 'mobile car wash and detailing', label: 'Car wash and detailing' },
      { slug: 'mobile oil change and mechanics', label: 'Oil change and mechanics' },
      { slug: 'auto glass repair', label: 'Auto glass' },
      { slug: 'mobile tyre fitting', label: 'Tyre fitting' },
      { slug: 'bike repair service', label: 'Bike repair' },
    ],
  },
  {
    key: 'home',
    label: 'Home and property',
    trades: [
      { slug: 'handyman and repair services', label: 'Handyman and repairs' },
      { slug: 'mobile pressure washing', label: 'Pressure washing' },
      { slug: 'junk removal', label: 'Junk removal' },
      { slug: 'landscaping and gardening', label: 'Landscaping and gardening' },
      { slug: 'tree and shrub trimming', label: 'Tree and shrub trimming' },
      { slug: 'gutter cleaning', label: 'Gutter cleaning' },
      { slug: 'window cleaning', label: 'Window cleaning' },
      { slug: 'house cleaning', label: 'House cleaning' },
      { slug: 'carpet cleaning', label: 'Carpet cleaning' },
      { slug: 'trash can cleaning', label: 'Bin cleaning' },
      { slug: 'dryer vent cleaning', label: 'Dryer vent cleaning' },
      { slug: 'pool service', label: 'Pool service' },
      { slug: 'pest control', label: 'Pest control' },
      { slug: 'mobile locksmith', label: 'Locksmith' },
      { slug: 'appliance repair', label: 'Appliance repair' },
    ],
  },
  {
    key: 'pets',
    label: 'Pet care',
    trades: [
      { slug: 'mobile pet grooming', label: 'Pet grooming' },
      { slug: 'mobile dog gym', label: 'Dog exercise and training' },
      { slug: 'mobile veterinary service', label: 'Veterinary visits' },
    ],
  },
  {
    key: 'beauty',
    label: 'Personal care and beauty',
    trades: [
      { slug: 'mobile hair salon or barbershop', label: 'Hair salon or barbershop' },
      { slug: 'mobile spa and massage', label: 'Spa and massage' },
      { slug: 'mobile makeup artist', label: 'Makeup artistry' },
    ],
  },
  {
    key: 'food',
    label: 'Food and drink',
    trades: [
      { slug: 'food trucks', label: 'Food truck', hint: 'Private events and catering' },
      { slug: 'coffee and smoothie trucks', label: 'Coffee and smoothie truck' },
      { slug: 'dessert trucks', label: 'Dessert truck' },
      { slug: 'mobile bar service', label: 'Bar service' },
    ],
  },
  {
    key: 'tech',
    label: 'Tech and repair',
    trades: [
      { slug: 'phone and tablet repair', label: 'Phone and tablet repair' },
      { slug: 'tech support', label: 'Computer and tech support' },
    ],
  },
  {
    key: 'services',
    label: 'Professional and personal',
    trades: [
      { slug: 'mobile notary', label: 'Notary' },
      { slug: 'personal fitness training', label: 'Personal training' },
      { slug: 'mobile photography and photo booths', label: 'Photography and photo booths' },
      { slug: 'tutoring', label: 'Tutoring' },
    ],
  },
  {
    key: 'retail',
    label: 'Pop-up retail',
    trades: [
      { slug: 'fashion boutique trucks', label: 'Fashion boutique truck' },
      { slug: 'mobile bookstore', label: 'Bookstore' },
      { slug: "mobile farmer's market", label: "Farmer's market stall" },
    ],
  },
];

/** Flat, for anything that just needs to know whether a slug is real. */
export const ALL_TRADES: Trade[] = TRADE_CATEGORIES.flatMap((c) => c.trades);

const BY_SLUG = new Map(ALL_TRADES.map((t) => [t.slug, t]));

/** Case- and whitespace-insensitive, because trade is free text on the row. */
export const tradeBySlug = (slug: string | null | undefined): Trade | null =>
  BY_SLUG.get((slug ?? '').trim().toLowerCase()) ?? null;

/** The friendly name, falling back to whatever was stored. */
export const tradeLabel = (slug: string | null | undefined): string =>
  tradeBySlug(slug)?.label ?? (slug ?? '').trim();

export const categoryOf = (slug: string | null | undefined): TradeCategory | null =>
  TRADE_CATEGORIES.find((c) => c.trades.some((t) => t.slug === (slug ?? '').trim().toLowerCase()))
  ?? null;

/**
 * The catalogue, with only the trades somebody is actually working in.
 *
 * The browse page shows categories a customer can book from. A category whose
 * every trade is empty is a dead end, and a marketplace whose front page is
 * mostly dead ends does not look like a marketplace -- so empty ones are
 * dropped rather than shown greyed out.
 */
export function catalogFor(live: Iterable<string>): TradeCategory[] {
  const have = new Set([...live].map((t) => t.trim().toLowerCase()));
  return TRADE_CATEGORIES
    .map((c) => ({ ...c, trades: c.trades.filter((t) => have.has(t.slug)) }))
    .filter((c) => c.trades.length > 0);
}
