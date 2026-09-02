/**
 * Country metadata.
 *
 * Three things vary by country and all three break silently if guessed:
 *   1. phone format      — a bad number means the offer never arrives
 *   2. postal code shape — a bad postcode means no coordinates, no ranking
 *   3. currency          — a wrong symbol on a price is a trust problem
 *
 * On phone validation: this is a pragmatic length/prefix check, NOT
 * libphonenumber. It accepts some numbers that are not assigned and rejects
 * almost nothing valid. If you ever need real validation (porting, landline vs
 * mobile detection, carrier lookup), swap in libphonenumber-js — it is ~150 kB
 * and would need bundling into the Worker, which is why it is not here yet.
 *
 * On timezone: `defaultTimezone` is a sensible starting value for onboarding,
 * not a truth. Countries marked multiTimezone MUST have the operator pick
 * their own zone or their working hours land in the wrong hour.
 */

export interface CountryInfo {
  iso2: string;
  name: string;
  dial: string;            // E.164 country calling code, with +
  trunk: string | null;    // national trunk prefix stripped before dialling
  minNational: number;     // shortest national significant number
  maxNational: number;     // longest
  currency: string;        // ISO-4217
  defaultTimezone: string; // IANA
  multiTimezone?: true;    // operator must choose; do not trust the default
  /** Uppercase + strip spaces/hyphens is the right normalisation for these. */
  postalPattern?: RegExp;
  /** No national postal code system worth geocoding against. */
  noPostalCodes?: true;
}

export const COUNTRIES: Record<string, CountryInfo> = {
  // Launch markets only. Adding a country back means adding its row here and
  // its locale below — nothing else in the app is country-specific.
  US: { iso2: 'US', name: 'United States', dial: '+1', trunk: '1', minNational: 10, maxNational: 10, currency: 'USD', defaultTimezone: 'America/New_York', multiTimezone: true, postalPattern: /^\d{5}(\d{4})?$/ },
  CA: { iso2: 'CA', name: 'Canada', dial: '+1', trunk: '1', minNational: 10, maxNational: 10, currency: 'CAD', defaultTimezone: 'America/Toronto', multiTimezone: true, postalPattern: /^[A-Z]\d[A-Z]\d[A-Z]\d$/ },
  GB: { iso2: 'GB', name: 'United Kingdom', dial: '+44', trunk: '0', minNational: 9, maxNational: 10, currency: 'GBP', defaultTimezone: 'Europe/London', postalPattern: /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/ },
  IE: { iso2: 'IE', name: 'Ireland', dial: '+353', trunk: '0', minNational: 7, maxNational: 9, currency: 'EUR', defaultTimezone: 'Europe/Dublin', postalPattern: /^[A-Z]\d{2}[A-Z\d]{4}$/ },
  AU: { iso2: 'AU', name: 'Australia', dial: '+61', trunk: '0', minNational: 9, maxNational: 9, currency: 'AUD', defaultTimezone: 'Australia/Sydney', multiTimezone: true, postalPattern: /^\d{4}$/ },
  NZ: { iso2: 'NZ', name: 'New Zealand', dial: '+64', trunk: '0', minNational: 8, maxNational: 10, currency: 'NZD', defaultTimezone: 'Pacific/Auckland', postalPattern: /^\d{4}$/ },
};

export const COUNTRY_LIST = Object.values(COUNTRIES)
  .sort((a, b) => a.name.localeCompare(b.name));

export const getCountry = (iso2: string | null | undefined): CountryInfo | null =>
  iso2 ? (COUNTRIES[iso2.toUpperCase()] ?? null) : null;

/** Longest dial code first, so +1 never shadows +1876 style matches. */
const BY_DIAL = Object.values(COUNTRIES).sort((a, b) => b.dial.length - a.dial.length);

/** Best-effort country guess from an E.164 number. Ambiguous +1 resolves to US. */
export function countryFromE164(e164: string): CountryInfo | null {
  return BY_DIAL.find((c) => e164.startsWith(c.dial)) ?? null;
}

/** Uppercase, strip spaces and hyphens — the shape GeoNames stores. */
export const normalisePostcode = (raw: string): string =>
  raw.toUpperCase().replace(/[\s-]/g, '');

export function isValidPostcode(raw: string | null, iso2: string): boolean {
  const c = getCountry(iso2);
  if (!c || !raw) return false;
  if (c.noPostalCodes) return false;
  if (!c.postalPattern) return true;
  return c.postalPattern.test(normalisePostcode(raw));
}

/**
 * The formatting locale for a country.
 *
 * This is not cosmetic. Dates, number separators and currency placement all
 * come from it, and every one of them reaches the customer in the offer SMS.
 * Defaulting the whole product to one country's locale means everyone else's
 * customers read a foreign date format — which was the bug this replaces.
 */
export const LOCALES: Record<string, string> = {
  US: 'en-US', CA: 'en-CA', GB: 'en-GB', IE: 'en-IE', AU: 'en-AU', NZ: 'en-NZ',
};

/**
 * Formatting locale. Country decides the conventions; language, when known,
 * decides the words. A Spanish-speaking client in Phoenix wants es-US — US
 * date and dollar conventions, Spanish month names — not es-MX and not en-US.
 */
export const localeFor = (
  iso2: string | null | undefined, lang?: string | null,
): string => {
  const country = iso2?.toUpperCase();
  if (lang && country) return `${lang}-${country}`;
  return (country && LOCALES[country]) || 'en-US';
};

/** Locale-correct money without a hand-maintained symbol table. */
export function formatMoney(cents: number, currency: string, locale = 'en-US'): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency', currency,
      minimumFractionDigits: ZERO_DECIMAL.has(currency) ? 0 : 2,
      maximumFractionDigits: ZERO_DECIMAL.has(currency) ? 0 : 2,
    }).format(ZERO_DECIMAL.has(currency) ? cents : cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/**
 * Currencies with no minor unit. Storing these as "cents" would divide by 100
 * and quote a plumber ¥45 for a ¥4,500 job — so the minor unit is 1 here.
 */
export const ZERO_DECIMAL = new Set([
  'JPY', 'KRW', 'CLP', 'ISK', 'VND', 'PYG', 'RWF', 'UGX', 'XAF', 'XOF',
]);
// Note: HUF, IDR and COP are often treated as zero-decimal by payment
// processors but ISO 4217 gives them two minor digits, so they stay off this
// list. If you later take payments through one of those processors, reconcile
// against ITS list, not this one.
