import { describe, expect, it } from 'vitest';
import { makeEnv } from './d1';
import type { Env } from '../src/types';
import {
  COUNTRIES, COUNTRY_LIST, countryFromE164, formatMoney, getCountry, isLaunchArea,
  isValidPostcode, LAUNCH_STATE, normalisePostcode, ZERO_DECIMAL,
} from '../src/lib/countries';
import { LOCALES, localeFor } from '../src/lib/countries';
import { formatTimeRange } from '../src/lib/tz';
import { toE164 } from '../src/lib/util';
import { geocode } from '../src/lib/geo';

const M1 = new URL('../migrations/0001_init.sql', import.meta.url).pathname;
const M2 = new URL('../migrations/0002_postal_codes.sql', import.meta.url).pathname;

describe('country table integrity', () => {
  it('ships exactly the launch markets', () => {
    expect(COUNTRY_LIST.map((c) => c.iso2).sort())
      .toEqual(['US']);
  });

  it('every entry is internally consistent', () => {
    for (const c of COUNTRY_LIST) {
      expect(c.dial, c.iso2).toMatch(/^\+\d{1,4}$/);
      expect(c.iso2, c.iso2).toMatch(/^[A-Z]{2}$/);
      expect(c.currency, c.iso2).toMatch(/^[A-Z]{3}$/);
      expect(c.minNational, c.iso2).toBeLessThanOrEqual(c.maxNational);
      // E.164 caps the whole number at 15 digits including the country code.
      expect(c.dial.length - 1 + c.maxNational, c.iso2).toBeLessThanOrEqual(15);
      // A valid IANA zone, or every gap for that operator lands in the wrong hour.
      expect(() => new Intl.DateTimeFormat('en', { timeZone: c.defaultTimezone })).not.toThrow();
      // A country either has a postal pattern or is flagged as having no codes.
      expect(Boolean(c.postalPattern) || c.noPostalCodes === true, c.iso2).toBe(true);
    }
  });

  it('keys match their iso2 field', () => {
    for (const [k, v] of Object.entries(COUNTRIES)) expect(k).toBe(v.iso2);
  });
});

describe('phone normalisation', () => {
  const cases: Array<[string, string, string | null]> = [
    // Every shape an operator actually types a US number in. A number that
    // fails to normalise is an offer that never arrives.
    ['US', '(818) 555-0123', '+18185550123'],
    ['US', '818-555-0123', '+18185550123'],
    ['US', '818.555.0123', '+18185550123'],
    ['US', '818 555 0123', '+18185550123'],
    ['US', '8185550123', '+18185550123'],
    // Long-distance trunk prefix — how it is dialled, and how CRMs export it.
    ['US', '1-818-555-0123', '+18185550123'],
    ['US', '1 (818) 555-0123', '+18185550123'],
    // Already international, spaced or not.
    ['US', '+1 818 555 0123', '+18185550123'],
    ['US', '+18185550123', '+18185550123'],
    // Rejections. A US national number is exactly ten digits, so one digit
    // short or one digit long is not a number we can text.
    ['US', '818 555 012', null],
    ['US', '818 555 01234', null],
    ['US', '555 0123', null],
    ['US', '12345', null],
    ['US', '818 5XX 0123', null],
    ['US', 'not a phone', null],
    ['US', '', null],
  ];

  for (const [country, input, expected] of cases) {
    it(`${country}: ${input || '(empty)'} -> ${expected ?? 'null'}`, () => {
      expect(toE164(input, country)).toBe(expected);
    });
  }

  it('passes through a valid international number from an unlisted country', () => {
    // +263 (Zimbabwe) is not in the table; the shape is still valid E.164, and
    // a number we cannot check is better sent than silently dropped.
    expect(toE164('+263771234567', 'US')).toBe('+263771234567');
  });

  it('rejects an international number that is too short for its country', () => {
    // Right country code, six national digits: E.164-shaped but undialable.
    expect(toE164('+1818555', 'US')).toBeNull();
  });
});

describe('country from an E.164 number', () => {
  it('identifies a US number', () => {
    expect(countryFromE164('+18185550123')?.iso2).toBe('US');
  });

  it('returns null for a number outside the launch market', () => {
    // Nothing but +1 is in the table now, so there is no country to resolve
    // these to. Null is the honest answer; a wrong guess would pick the
    // currency and date format for someone else's customer.
    expect(countryFromE164('+447700900123')).toBeNull();
    expect(countryFromE164('+61412345678')).toBeNull();
    expect(countryFromE164('+353861234567')).toBeNull();
  });

  it('cannot tell the rest of the +1 plan apart from the US', () => {
    // +1 is shared across the North American plan, so a Vancouver number reads
    // as US. Recorded rather than fixed: nothing downstream branches on it,
    // and guessing by area code would be a worse kind of wrong.
    expect(countryFromE164('+16045550123')?.iso2).toBe('US');
  });
});

describe('postcode validation', () => {
  const valid = ['90210', '94103', '10001', '90210-1234', '902101234', ' 90210 '];
  for (const p of valid) {
    it(`US accepts ${p}`, () => expect(isValidPostcode(p, 'US')).toBe(true));
  }

  // A US ZIP is five digits, or five plus four. Six or seven is a typo, and a
  // typo that geocodes to nothing means no coordinates and no ranking.
  const invalid = ['9021', '902101', '9021012', '90210-12', 'ABCDE', ''];
  for (const p of invalid) {
    it(`US rejects ${p || '(empty)'}`, () => expect(isValidPostcode(p, 'US')).toBe(false));
  }

  it('rejects a missing postcode rather than treating it as valid', () => {
    expect(isValidPostcode(null, 'US')).toBe(false);
  });

  it('rejects a postcode for a country we do not ship to', () => {
    expect(isValidPostcode('75001', 'FR')).toBe(false);
    expect(getCountry('FR')).toBeNull();
    // The UK was a market once. A British postcode left in an imported client
    // row must not still validate against a country we no longer have.
    expect(getCountry('GB')).toBeNull();
    expect(isValidPostcode('SW1A 1AA', 'GB')).toBe(false);
  });

  it('normalises to the shape GeoNames stores', () => {
    expect(normalisePostcode('90210-1234')).toBe('902101234');
    expect(normalisePostcode(' 94103 ')).toBe('94103');
  });
});

describe('the California launch gate', () => {
  it('says which state it gates on', () => {
    expect(LAUNCH_STATE).toBe('California');
  });

  const inside = ['90001', '90210', '92101', '94103', '95814', '96162'];
  for (const z of inside) {
    it(`admits ${z}`, () => expect(isLaunchArea(z)).toBe(true));
  }

  it('admits the exact first and last ZIP of the range', () => {
    // An off-by-one on either edge silently shuts a whole city out of signup,
    // and nothing else in the app would report it.
    expect(isLaunchArea('90001')).toBe(true);
    expect(isLaunchArea('96162')).toBe(true);
  });

  it('refuses the ZIP immediately either side of the range', () => {
    expect(isLaunchArea('89999')).toBe(false);
    expect(isLaunchArea('96163')).toBe(false);
  });

  const outside = ['10001', '00501', '73301', '89999', '96163'];
  for (const z of outside) {
    it(`refuses ${z}`, () => expect(isLaunchArea(z)).toBe(false));
  }

  it('reads the ZIP out of a longer string instead of failing on it', () => {
    // ZIP+4 and 'CA 90210' both turn up in imported rows; only the first five
    // digits decide, so both are Californian.
    expect(isLaunchArea('90210-1234')).toBe(true);
    expect(isLaunchArea('CA 90210')).toBe(true);
  });

  it('refuses anything that is not five digits of ZIP', () => {
    expect(isLaunchArea(null)).toBe(false);
    expect(isLaunchArea(undefined)).toBe(false);
    expect(isLaunchArea('')).toBe(false);
    expect(isLaunchArea('   ')).toBe(false);
    expect(isLaunchArea('9021')).toBe(false);
    expect(isLaunchArea('abcde')).toBe(false);
  });
});

describe('currency formatting', () => {
  it('formats minor units correctly per currency', () => {
    expect(formatMoney(6500, 'USD')).toContain('65');
    // Not a launch currency, but formatMoney is handed whatever the operator
    // row holds and must not assume dollars.
    expect(formatMoney(6500, 'EUR')).toContain('65');
  });

  it('does not divide zero-decimal currencies by 100', () => {
    // ¥4500 must read as 4,500 — not 45.
    const jpy = formatMoney(4500, 'JPY');
    expect(jpy).toContain('4,500');
    expect(jpy).not.toContain('45.00');
    expect(ZERO_DECIMAL.has('JPY')).toBe(true);
    expect(ZERO_DECIMAL.has('USD')).toBe(false);
  });

  it('falls back rather than throwing on an unknown currency', () => {
    expect(() => formatMoney(1000, 'ZZZ')).not.toThrow();
  });
});

describe('offline postal geocoding', () => {
  let env: Env;

  async function seedPostcodes() {
    env = makeEnv([M1, M2]) as unknown as Env;
    const rows: Array<[string, string, string, number, number]> = [
      ['US', '90210', 'Beverly Hills', 34.09010, -118.40650],
      ['US', '94103', 'San Francisco', 37.77280, -122.41060],
      ['US', '95814', 'Sacramento', 38.58160, -121.49440],
      ['US', '10001', 'New York', 40.75080, -73.99700],
    ];
    for (const [cc, pc, place, lat, lng] of rows) {
      await env.DB.prepare(
        `INSERT INTO postal_codes (country_code, postal_code, place_name, lat, lng, accuracy)
         VALUES (?,?,?,?,?,6)`,
      ).bind(cc, pc, place, lat, lng).run();
    }
  }

  it('resolves postcodes with no network call', async () => {
    await seedPostcodes();
    for (const [pc, lat] of [
      ['90210', 34.0901], ['94103', 37.7728], ['95814', 38.5816],
    ] as const) {
      const p = await geocode(env, null, pc, 'US');
      expect(p, pc).toBeTruthy();
      expect(p!.source).toBe('table');
      expect(p!.lat).toBeCloseTo(lat, 3);
    }
  });

  it('falls back to a shorter stored code when the client typed more', async () => {
    await seedPostcodes();
    // The table holds five-digit ZIPs; people write ZIP+4 on a form. Walking
    // the input down still places them in Beverly Hills.
    const p = await geocode(env, null, '90210-1234', 'US');
    expect(p).toBeTruthy();
    expect(p!.lat).toBeCloseTo(34.0901, 3);
  });

  it('returns null rather than guessing when the postcode is unknown', async () => {
    await seedPostcodes();
    expect(await geocode(env, null, '99999', 'US')).toBeNull();
  });

  it('returns nothing for a country we do not ship to', async () => {
    await seedPostcodes();
    expect(await geocode(env, null, '00000', 'FR')).toBeNull();
  });

  it('is insensitive to the spacing people type', async () => {
    await seedPostcodes();
    const a = await geocode(env, null, ' 90210 ', 'US');
    const b = await geocode(env, null, '90210', 'US');
    expect(a!.lat).toBe(b!.lat);
  });
});

describe('partial-postcode matching, both directions', () => {
  it('matches when the operator typed only the five-digit ZIP', async () => {
    const env = makeEnv([M1, M2]) as unknown as Env;
    await env.DB.prepare(
      `INSERT INTO postal_codes (country_code,postal_code,place_name,lat,lng,accuracy)
       VALUES ('US','902101234','Beverly Hills',34.0901,-118.4065,6)`).run();
    const p = await geocode(env, null, '90210', 'US');
    expect(p).toBeTruthy();
    expect(p!.lat).toBeCloseTo(34.0901, 3);
  });

  it('does not match an unrelated code that merely shares two characters', async () => {
    const env = makeEnv([M1, M2]) as unknown as Env;
    await env.DB.prepare(
      `INSERT INTO postal_codes (country_code,postal_code,place_name,lat,lng,accuracy)
       VALUES ('US','902101234','Beverly Hills',34.0901,-118.4065,6)`).run();
    expect(await geocode(env, null, '90', 'US')).toBeNull();
  });
});

describe('formatting follows the operator, never a hardcoded default', () => {
  it('formats the same instant differently in two US timezones', () => {
    // The US is multiTimezone: the default zone is an onboarding starting
    // value, not a truth, and an operator who never picks their own works the
    // wrong hours.
    expect(getCountry('US')!.multiTimezone).toBe(true);
    const t = Date.UTC(2026, 8, 3, 9, 15) / 1000;
    const east = formatTimeRange(t, t + 7200, 'America/New_York', localeFor('US'));
    const west = formatTimeRange(t, t + 7200, 'America/Los_Angeles', localeFor('US'));
    expect(east.length).toBeGreaterThan(0);
    expect(west.length).toBeGreaterThan(0);
    // Identical text for two zones means the zone is being ignored.
    expect(east).not.toBe(west);
  });

  it('keeps US conventions while the language changes the words', () => {
    // A Spanish-speaking client in Phoenix wants es-US: US date order and
    // dollars, Spanish month names. Not es-MX, and not en-US.
    expect(localeFor('US')).toBe('en-US');
    expect(localeFor('US', 'es')).toBe('es-US');
    const t = Date.UTC(2026, 8, 3, 9, 15) / 1000;
    const en = formatTimeRange(t, t + 7200, 'America/Los_Angeles', localeFor('US'));
    const es = formatTimeRange(t, t + 7200, 'America/Los_Angeles', localeFor('US', 'es'));
    expect(es).not.toBe(en);
  });

  it('falls back rather than inventing a locale it does not have', () => {
    expect(localeFor(null)).toBe('en-US');
    expect(localeFor('FR')).toBe('en-US');
    // Every supported country must have one — no silent fallback for a market
    // we claim to support.
    for (const c of COUNTRY_LIST) {
      expect(LOCALES[c.iso2], `${c.iso2} has no locale`).toBeTruthy();
    }
  });

  it('renders money in the operator currency and convention', () => {
    expect(formatMoney(6500, 'USD', localeFor('US'))).toMatch(/\$\s?65/);
    // Japanese yen must not be divided by 100 just because dollars are.
    expect(formatMoney(4500, 'JPY', localeFor('JP'))).toContain('4,500');
  });

  it('the schema refuses an operator with no country, timezone or currency', () => {
    const e = makeEnv([M1, M2]) as unknown as Env;
    expect(() => e.DB.prepare(
      `INSERT INTO operators (id,email,business_name,created_at,updated_at)
       VALUES ('x','a@b.c','No country',1,1)`).run(),
    ).toThrow();
  });
});
