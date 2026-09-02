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
  // ---- Europe -------------------------------------------------------------
  GB: { iso2: 'GB', name: 'United Kingdom', dial: '+44', trunk: '0', minNational: 9, maxNational: 10, currency: 'GBP', defaultTimezone: 'Europe/London', postalPattern: /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/ },
  IE: { iso2: 'IE', name: 'Ireland', dial: '+353', trunk: '0', minNational: 7, maxNational: 9, currency: 'EUR', defaultTimezone: 'Europe/Dublin', postalPattern: /^[A-Z]\d{2}[A-Z\d]{4}$/ },
  FR: { iso2: 'FR', name: 'France', dial: '+33', trunk: '0', minNational: 9, maxNational: 9, currency: 'EUR', defaultTimezone: 'Europe/Paris', postalPattern: /^\d{5}$/ },
  DE: { iso2: 'DE', name: 'Germany', dial: '+49', trunk: '0', minNational: 9, maxNational: 11, currency: 'EUR', defaultTimezone: 'Europe/Berlin', postalPattern: /^\d{5}$/ },
  ES: { iso2: 'ES', name: 'Spain', dial: '+34', trunk: null, minNational: 9, maxNational: 9, currency: 'EUR', defaultTimezone: 'Europe/Madrid', postalPattern: /^\d{5}$/ },
  PT: { iso2: 'PT', name: 'Portugal', dial: '+351', trunk: null, minNational: 9, maxNational: 9, currency: 'EUR', defaultTimezone: 'Europe/Lisbon', postalPattern: /^\d{7}$/ },
  IT: { iso2: 'IT', name: 'Italy', dial: '+39', trunk: null, minNational: 9, maxNational: 11, currency: 'EUR', defaultTimezone: 'Europe/Rome', postalPattern: /^\d{5}$/ },
  NL: { iso2: 'NL', name: 'Netherlands', dial: '+31', trunk: '0', minNational: 9, maxNational: 9, currency: 'EUR', defaultTimezone: 'Europe/Amsterdam', postalPattern: /^\d{4}[A-Z]{2}$/ },
  BE: { iso2: 'BE', name: 'Belgium', dial: '+32', trunk: '0', minNational: 8, maxNational: 9, currency: 'EUR', defaultTimezone: 'Europe/Brussels', postalPattern: /^\d{4}$/ },
  LU: { iso2: 'LU', name: 'Luxembourg', dial: '+352', trunk: null, minNational: 6, maxNational: 9, currency: 'EUR', defaultTimezone: 'Europe/Luxembourg', postalPattern: /^\d{4}$/ },
  CH: { iso2: 'CH', name: 'Switzerland', dial: '+41', trunk: '0', minNational: 9, maxNational: 9, currency: 'CHF', defaultTimezone: 'Europe/Zurich', postalPattern: /^\d{4}$/ },
  AT: { iso2: 'AT', name: 'Austria', dial: '+43', trunk: '0', minNational: 8, maxNational: 13, currency: 'EUR', defaultTimezone: 'Europe/Vienna', postalPattern: /^\d{4}$/ },
  DK: { iso2: 'DK', name: 'Denmark', dial: '+45', trunk: null, minNational: 8, maxNational: 8, currency: 'DKK', defaultTimezone: 'Europe/Copenhagen', postalPattern: /^\d{4}$/ },
  SE: { iso2: 'SE', name: 'Sweden', dial: '+46', trunk: '0', minNational: 7, maxNational: 9, currency: 'SEK', defaultTimezone: 'Europe/Stockholm', postalPattern: /^\d{5}$/ },
  NO: { iso2: 'NO', name: 'Norway', dial: '+47', trunk: null, minNational: 8, maxNational: 8, currency: 'NOK', defaultTimezone: 'Europe/Oslo', postalPattern: /^\d{4}$/ },
  FI: { iso2: 'FI', name: 'Finland', dial: '+358', trunk: '0', minNational: 6, maxNational: 12, currency: 'EUR', defaultTimezone: 'Europe/Helsinki', postalPattern: /^\d{5}$/ },
  IS: { iso2: 'IS', name: 'Iceland', dial: '+354', trunk: null, minNational: 7, maxNational: 9, currency: 'ISK', defaultTimezone: 'Atlantic/Reykjavik', postalPattern: /^\d{3}$/ },
  PL: { iso2: 'PL', name: 'Poland', dial: '+48', trunk: null, minNational: 9, maxNational: 9, currency: 'PLN', defaultTimezone: 'Europe/Warsaw', postalPattern: /^\d{5}$/ },
  CZ: { iso2: 'CZ', name: 'Czechia', dial: '+420', trunk: null, minNational: 9, maxNational: 9, currency: 'CZK', defaultTimezone: 'Europe/Prague', postalPattern: /^\d{5}$/ },
  SK: { iso2: 'SK', name: 'Slovakia', dial: '+421', trunk: '0', minNational: 9, maxNational: 9, currency: 'EUR', defaultTimezone: 'Europe/Bratislava', postalPattern: /^\d{5}$/ },
  HU: { iso2: 'HU', name: 'Hungary', dial: '+36', trunk: '06', minNational: 8, maxNational: 9, currency: 'HUF', defaultTimezone: 'Europe/Budapest', postalPattern: /^\d{4}$/ },
  RO: { iso2: 'RO', name: 'Romania', dial: '+40', trunk: '0', minNational: 9, maxNational: 9, currency: 'RON', defaultTimezone: 'Europe/Bucharest', postalPattern: /^\d{6}$/ },
  BG: { iso2: 'BG', name: 'Bulgaria', dial: '+359', trunk: '0', minNational: 8, maxNational: 9, currency: 'BGN', defaultTimezone: 'Europe/Sofia', postalPattern: /^\d{4}$/ },
  GR: { iso2: 'GR', name: 'Greece', dial: '+30', trunk: null, minNational: 10, maxNational: 10, currency: 'EUR', defaultTimezone: 'Europe/Athens', postalPattern: /^\d{5}$/ },
  HR: { iso2: 'HR', name: 'Croatia', dial: '+385', trunk: '0', minNational: 8, maxNational: 9, currency: 'EUR', defaultTimezone: 'Europe/Zagreb', postalPattern: /^\d{5}$/ },
  SI: { iso2: 'SI', name: 'Slovenia', dial: '+386', trunk: '0', minNational: 8, maxNational: 8, currency: 'EUR', defaultTimezone: 'Europe/Ljubljana', postalPattern: /^\d{4}$/ },
  EE: { iso2: 'EE', name: 'Estonia', dial: '+372', trunk: null, minNational: 7, maxNational: 8, currency: 'EUR', defaultTimezone: 'Europe/Tallinn', postalPattern: /^\d{5}$/ },
  LV: { iso2: 'LV', name: 'Latvia', dial: '+371', trunk: null, minNational: 8, maxNational: 8, currency: 'EUR', defaultTimezone: 'Europe/Riga', postalPattern: /^\d{4}$/ },
  LT: { iso2: 'LT', name: 'Lithuania', dial: '+370', trunk: '8', minNational: 8, maxNational: 8, currency: 'EUR', defaultTimezone: 'Europe/Vilnius', postalPattern: /^\d{5}$/ },

  // ---- North America ------------------------------------------------------
  US: { iso2: 'US', name: 'United States', dial: '+1', trunk: '1', minNational: 10, maxNational: 10, currency: 'USD', defaultTimezone: 'America/New_York', multiTimezone: true, postalPattern: /^\d{5}(\d{4})?$/ },
  CA: { iso2: 'CA', name: 'Canada', dial: '+1', trunk: '1', minNational: 10, maxNational: 10, currency: 'CAD', defaultTimezone: 'America/Toronto', multiTimezone: true, postalPattern: /^[A-Z]\d[A-Z]\d[A-Z]\d$/ },
  MX: { iso2: 'MX', name: 'Mexico', dial: '+52', trunk: '01', minNational: 10, maxNational: 10, currency: 'MXN', defaultTimezone: 'America/Mexico_City', multiTimezone: true, postalPattern: /^\d{5}$/ },

  // ---- Latin America ------------------------------------------------------
  BR: { iso2: 'BR', name: 'Brazil', dial: '+55', trunk: '0', minNational: 10, maxNational: 11, currency: 'BRL', defaultTimezone: 'America/Sao_Paulo', multiTimezone: true, postalPattern: /^\d{8}$/ },
  AR: { iso2: 'AR', name: 'Argentina', dial: '+54', trunk: '0', minNational: 10, maxNational: 11, currency: 'ARS', defaultTimezone: 'America/Argentina/Buenos_Aires', postalPattern: /^[A-Z]?\d{4}[A-Z]{0,3}$/ },
  CL: { iso2: 'CL', name: 'Chile', dial: '+56', trunk: '0', minNational: 8, maxNational: 9, currency: 'CLP', defaultTimezone: 'America/Santiago', postalPattern: /^\d{7}$/ },
  CO: { iso2: 'CO', name: 'Colombia', dial: '+57', trunk: '0', minNational: 10, maxNational: 10, currency: 'COP', defaultTimezone: 'America/Bogota', postalPattern: /^\d{6}$/ },
  PE: { iso2: 'PE', name: 'Peru', dial: '+51', trunk: '0', minNational: 8, maxNational: 9, currency: 'PEN', defaultTimezone: 'America/Lima', postalPattern: /^\d{5}$/ },
  UY: { iso2: 'UY', name: 'Uruguay', dial: '+598', trunk: '0', minNational: 8, maxNational: 8, currency: 'UYU', defaultTimezone: 'America/Montevideo', postalPattern: /^\d{5}$/ },
  CR: { iso2: 'CR', name: 'Costa Rica', dial: '+506', trunk: null, minNational: 8, maxNational: 8, currency: 'CRC', defaultTimezone: 'America/Costa_Rica', postalPattern: /^\d{5}$/ },
  PA: { iso2: 'PA', name: 'Panama', dial: '+507', trunk: null, minNational: 7, maxNational: 8, currency: 'PAB', defaultTimezone: 'America/Panama', postalPattern: /^\d{4}$/ },
  DO: { iso2: 'DO', name: 'Dominican Republic', dial: '+1', trunk: '1', minNational: 10, maxNational: 10, currency: 'DOP', defaultTimezone: 'America/Santo_Domingo', postalPattern: /^\d{5}$/ },

  // ---- Oceania ------------------------------------------------------------
  AU: { iso2: 'AU', name: 'Australia', dial: '+61', trunk: '0', minNational: 9, maxNational: 9, currency: 'AUD', defaultTimezone: 'Australia/Sydney', multiTimezone: true, postalPattern: /^\d{4}$/ },
  NZ: { iso2: 'NZ', name: 'New Zealand', dial: '+64', trunk: '0', minNational: 8, maxNational: 10, currency: 'NZD', defaultTimezone: 'Pacific/Auckland', postalPattern: /^\d{4}$/ },

  // ---- Middle East & Africa ----------------------------------------------
  AE: { iso2: 'AE', name: 'United Arab Emirates', dial: '+971', trunk: '0', minNational: 8, maxNational: 9, currency: 'AED', defaultTimezone: 'Asia/Dubai', noPostalCodes: true },
  SA: { iso2: 'SA', name: 'Saudi Arabia', dial: '+966', trunk: '0', minNational: 9, maxNational: 9, currency: 'SAR', defaultTimezone: 'Asia/Riyadh', postalPattern: /^\d{5}$/ },
  QA: { iso2: 'QA', name: 'Qatar', dial: '+974', trunk: null, minNational: 8, maxNational: 8, currency: 'QAR', defaultTimezone: 'Asia/Qatar', noPostalCodes: true },
  IL: { iso2: 'IL', name: 'Israel', dial: '+972', trunk: '0', minNational: 8, maxNational: 9, currency: 'ILS', defaultTimezone: 'Asia/Jerusalem', postalPattern: /^\d{5,7}$/ },
  TR: { iso2: 'TR', name: 'Türkiye', dial: '+90', trunk: '0', minNational: 10, maxNational: 10, currency: 'TRY', defaultTimezone: 'Europe/Istanbul', postalPattern: /^\d{5}$/ },
  ZA: { iso2: 'ZA', name: 'South Africa', dial: '+27', trunk: '0', minNational: 9, maxNational: 9, currency: 'ZAR', defaultTimezone: 'Africa/Johannesburg', postalPattern: /^\d{4}$/ },
  NG: { iso2: 'NG', name: 'Nigeria', dial: '+234', trunk: '0', minNational: 8, maxNational: 10, currency: 'NGN', defaultTimezone: 'Africa/Lagos', postalPattern: /^\d{6}$/ },
  KE: { iso2: 'KE', name: 'Kenya', dial: '+254', trunk: '0', minNational: 9, maxNational: 9, currency: 'KES', defaultTimezone: 'Africa/Nairobi', postalPattern: /^\d{5}$/ },
  GH: { iso2: 'GH', name: 'Ghana', dial: '+233', trunk: '0', minNational: 9, maxNational: 9, currency: 'GHS', defaultTimezone: 'Africa/Accra', noPostalCodes: true },
  EG: { iso2: 'EG', name: 'Egypt', dial: '+20', trunk: '0', minNational: 9, maxNational: 10, currency: 'EGP', defaultTimezone: 'Africa/Cairo', postalPattern: /^\d{5}$/ },
  MA: { iso2: 'MA', name: 'Morocco', dial: '+212', trunk: '0', minNational: 9, maxNational: 9, currency: 'MAD', defaultTimezone: 'Africa/Casablanca', postalPattern: /^\d{5}$/ },

  // ---- Asia ---------------------------------------------------------------
  IN: { iso2: 'IN', name: 'India', dial: '+91', trunk: '0', minNational: 10, maxNational: 10, currency: 'INR', defaultTimezone: 'Asia/Kolkata', postalPattern: /^\d{6}$/ },
  PK: { iso2: 'PK', name: 'Pakistan', dial: '+92', trunk: '0', minNational: 10, maxNational: 10, currency: 'PKR', defaultTimezone: 'Asia/Karachi', postalPattern: /^\d{5}$/ },
  SG: { iso2: 'SG', name: 'Singapore', dial: '+65', trunk: null, minNational: 8, maxNational: 8, currency: 'SGD', defaultTimezone: 'Asia/Singapore', postalPattern: /^\d{6}$/ },
  MY: { iso2: 'MY', name: 'Malaysia', dial: '+60', trunk: '0', minNational: 9, maxNational: 10, currency: 'MYR', defaultTimezone: 'Asia/Kuala_Lumpur', postalPattern: /^\d{5}$/ },
  PH: { iso2: 'PH', name: 'Philippines', dial: '+63', trunk: '0', minNational: 10, maxNational: 10, currency: 'PHP', defaultTimezone: 'Asia/Manila', postalPattern: /^\d{4}$/ },
  ID: { iso2: 'ID', name: 'Indonesia', dial: '+62', trunk: '0', minNational: 9, maxNational: 12, currency: 'IDR', defaultTimezone: 'Asia/Jakarta', multiTimezone: true, postalPattern: /^\d{5}$/ },
  TH: { iso2: 'TH', name: 'Thailand', dial: '+66', trunk: '0', minNational: 9, maxNational: 9, currency: 'THB', defaultTimezone: 'Asia/Bangkok', postalPattern: /^\d{5}$/ },
  VN: { iso2: 'VN', name: 'Vietnam', dial: '+84', trunk: '0', minNational: 9, maxNational: 10, currency: 'VND', defaultTimezone: 'Asia/Ho_Chi_Minh', postalPattern: /^\d{6}$/ },
  JP: { iso2: 'JP', name: 'Japan', dial: '+81', trunk: '0', minNational: 9, maxNational: 10, currency: 'JPY', defaultTimezone: 'Asia/Tokyo', postalPattern: /^\d{7}$/ },
  KR: { iso2: 'KR', name: 'South Korea', dial: '+82', trunk: '0', minNational: 9, maxNational: 10, currency: 'KRW', defaultTimezone: 'Asia/Seoul', postalPattern: /^\d{5}$/ },
  HK: { iso2: 'HK', name: 'Hong Kong', dial: '+852', trunk: null, minNational: 8, maxNational: 8, currency: 'HKD', defaultTimezone: 'Asia/Hong_Kong', noPostalCodes: true },
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
  GB: 'en-GB', IE: 'en-IE', FR: 'fr-FR', DE: 'de-DE', ES: 'es-ES', PT: 'pt-PT',
  IT: 'it-IT', NL: 'nl-NL', BE: 'nl-BE', LU: 'fr-LU', CH: 'de-CH', AT: 'de-AT',
  DK: 'da-DK', SE: 'sv-SE', NO: 'nb-NO', FI: 'fi-FI', IS: 'is-IS', PL: 'pl-PL',
  CZ: 'cs-CZ', SK: 'sk-SK', HU: 'hu-HU', RO: 'ro-RO', BG: 'bg-BG', GR: 'el-GR',
  HR: 'hr-HR', SI: 'sl-SI', EE: 'et-EE', LV: 'lv-LV', LT: 'lt-LT',
  US: 'en-US', CA: 'en-CA', MX: 'es-MX',
  BR: 'pt-BR', AR: 'es-AR', CL: 'es-CL', CO: 'es-CO', PE: 'es-PE', UY: 'es-UY',
  CR: 'es-CR', PA: 'es-PA', DO: 'es-DO',
  AU: 'en-AU', NZ: 'en-NZ',
  AE: 'ar-AE', SA: 'ar-SA', QA: 'ar-QA', IL: 'he-IL', TR: 'tr-TR',
  ZA: 'en-ZA', NG: 'en-NG', KE: 'en-KE', GH: 'en-GH', EG: 'ar-EG', MA: 'ar-MA',
  IN: 'en-IN', PK: 'en-PK', SG: 'en-SG', MY: 'ms-MY', PH: 'en-PH', ID: 'id-ID',
  TH: 'th-TH', VN: 'vi-VN', JP: 'ja-JP', KR: 'ko-KR', HK: 'zh-HK',
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
