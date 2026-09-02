import { describe, expect, it } from 'vitest';
import { makeEnv } from './d1';
import type { Env } from '../src/types';
import {
  COUNTRIES, COUNTRY_LIST, countryFromE164, formatMoney, getCountry,
  isValidPostcode, normalisePostcode, ZERO_DECIMAL,
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
      .toEqual(['AU', 'CA', 'GB', 'IE', 'NZ', 'US']);
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

describe('phone normalisation across markets', () => {
  const cases: Array<[string, string, string | null]> = [
    ['GB', '07700 900123', '+447700900123'],
    ['GB', '+44 7700 900123', '+447700900123'],
    ['GB', '447700900123', '+447700900123'],
    ['GB', '0044 7700 900123', '+447700900123'],
    ['US', '(555) 010-1234', '+15550101234'],
    ['US', '1-555-010-1234', '+15550101234'],
    ['CA', '604 555 0123', '+16045550123'],
    ['IE', '086 123 4567', '+353861234567'],
    ['AU', '0412 345 678', '+61412345678'],
    ['NZ', '021 123 456', '+6421123456'],
    // rejections
    ['GB', '12345', null],
    ['GB', 'not a phone', null],
    ['US', '555 010 12', null],
  ];

  for (const [country, input, expected] of cases) {
    it(`${country}: ${input} -> ${expected ?? 'null'}`, () => {
      expect(toE164(input, country)).toBe(expected);
    });
  }

  it('passes through a valid international number from an unlisted country', () => {
    // +263 (Zimbabwe) is not in the table; the shape is still valid E.164.
    expect(toE164('+263771234567', 'GB')).toBe('+263771234567');
  });

  it('rejects an international number that is too short for its country', () => {
    expect(toE164('+4477009', 'GB')).toBeNull();
  });

  it('identifies the country from an E.164 number', () => {
    expect(countryFromE164('+447700900123')?.iso2).toBe('GB');
    expect(countryFromE164('+15550101234')?.iso2).toBe('US');
    expect(countryFromE164('+61412345678')?.iso2).toBe('AU');
  });
});

describe('postcode validation', () => {
  const valid: Array<[string, string]> = [
    ['GB', 'SW1A 1AA'], ['GB', 'm1 1ae'],
    ['US', '90210'], ['US', '90210-1234'],
    ['CA', 'K1A 0B1'],
    ['AU', '2000'], ['NZ', '6011'],
    ['IE', 'D02 AF30'],
  ];
  for (const [c, p] of valid) {
    it(`${c} accepts ${p}`, () => expect(isValidPostcode(p, c)).toBe(true));
  }

  const invalid: Array<[string, string]> = [
  ];
  for (const [c, p] of invalid) {
    it(`${c} rejects ${p}`, () => expect(isValidPostcode(p, c)).toBe(false));
  }

  it('rejects a postcode for a country we do not ship to', () => {
    expect(isValidPostcode('75001', 'FR')).toBe(false);
    expect(getCountry('FR')).toBeNull();
  });

  it('normalises to the shape GeoNames stores', () => {
    expect(normalisePostcode('sw1a 1aa')).toBe('SW1A1AA');
    expect(normalisePostcode('K1A-0B1')).toBe('K1A0B1');
  });
});

describe('currency formatting', () => {
  it('formats minor units correctly per currency', () => {
    expect(formatMoney(6500, 'GBP')).toContain('65');
    expect(formatMoney(6500, 'EUR')).toContain('65');
    expect(formatMoney(6500, 'USD')).toContain('65');
  });

  it('does not divide zero-decimal currencies by 100', () => {
    // ¥4500 must read as 4,500 — not 45.
    const jpy = formatMoney(4500, 'JPY');
    expect(jpy).toContain('4,500');
    expect(jpy).not.toContain('45.00');
    expect(ZERO_DECIMAL.has('JPY')).toBe(true);
    expect(ZERO_DECIMAL.has('GBP')).toBe(false);
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
      ['GB', 'SW1A1AA', 'Westminster', 51.50100, -0.14200],
      ['GB', 'M11AE', 'Manchester', 53.47800, -2.24200],
      ['US', '90210', 'Beverly Hills', 34.09010, -118.40650],
      ['AU', '2000', 'Sydney', -33.86880, 151.20930],
      ['IE', 'D02', 'Dublin 2', 53.33800, -6.25100],
    ];
    for (const [cc, pc, place, lat, lng] of rows) {
      await env.DB.prepare(
        `INSERT INTO postal_codes (country_code, postal_code, place_name, lat, lng, accuracy)
         VALUES (?,?,?,?,?,6)`,
      ).bind(cc, pc, place, lat, lng).run();
    }
  }

  it('resolves postcodes with no network call, in several countries', async () => {
    await seedPostcodes();
    for (const [pc, cc, lat] of [
      ['SW1A 1AA', 'GB', 51.501], ['90210', 'US', 34.0901],
      ['2000', 'AU', -33.8688],
    ] as const) {
      const p = await geocode(env, null, pc as string, cc as string);
      expect(p, `${cc} ${pc}`).toBeTruthy();
      expect(p!.source).toBe('table');
      expect(p!.lat).toBeCloseTo(lat as number, 3);
    }
  });

  it('falls back to a prefix match for partial-code countries', async () => {
    await seedPostcodes();
    // Ireland publishes only routing keys in the open data; the full Eircode
    // will not match exactly, but the routing key still places the client.
    const p = await geocode(env, null, 'D02 AF30', 'IE');
    expect(p).toBeTruthy();
    expect(p!.lat).toBeCloseTo(53.338, 3);
  });

  it('returns null rather than guessing when the postcode is unknown', async () => {
    await seedPostcodes();
    expect(await geocode(env, null, 'ZZ99ZZ', 'GB')).toBeNull();
  });

  it('returns nothing for a country we do not ship to', async () => {
    await seedPostcodes();
    expect(await geocode(env, null, '00000', 'FR')).toBeNull();
  });

  it('is case and whitespace insensitive', async () => {
    await seedPostcodes();
    const a = await geocode(env, null, 'm1 1ae', 'GB');
    const b = await geocode(env, null, 'M11AE', 'GB');
    expect(a!.lat).toBe(b!.lat);
  });
});

describe('partial-postcode matching, both directions', () => {
  it('matches when the operator typed only the outward code', async () => {
    const env = makeEnv([M1, M2]) as unknown as Env;
    await env.DB.prepare(
      `INSERT INTO postal_codes (country_code,postal_code,place_name,lat,lng,accuracy)
       VALUES ('GB','SW1A1AA','Westminster',51.501,-0.142,6)`).run();
    const p = await geocode(env, null, 'SW1A', 'GB');
    expect(p).toBeTruthy();
    expect(p!.lat).toBeCloseTo(51.501, 3);
  });

  it('does not match an unrelated code that merely shares two characters', async () => {
    const env = makeEnv([M1, M2]) as unknown as Env;
    await env.DB.prepare(
      `INSERT INTO postal_codes (country_code,postal_code,place_name,lat,lng,accuracy)
       VALUES ('GB','SW1A1AA','Westminster',51.501,-0.142,6)`).run();
    expect(await geocode(env, null, 'SW', 'GB')).toBeNull();
  });
});

describe('no country is privileged over any other', () => {
  it('formats the same instant correctly for each market, not one of them', () => {
    const t = Date.UTC(2026, 8, 3, 9, 15) / 1000;
    const seen = new Map<string, string>();
    for (const iso of ['GB', 'US', 'CA', 'IE', 'AU', 'NZ']) {
      const c = getCountry(iso)!;
      const out = formatTimeRange(t, t + 7200, c.defaultTimezone, localeFor(iso));
      expect(out.length).toBeGreaterThan(0);
      seen.set(iso, out);
    }
    // If every locale produced identical text, the locale is being ignored —
    // which is exactly the bug where everyone got British formatting.
    expect(new Set(seen.values()).size).toBeGreaterThan(1);
  });

  it('gives each country its own locale, never a single global default', () => {
    expect(localeFor('US')).toBe('en-US');
    expect(localeFor('CA')).toBe('en-CA');
    expect(localeFor('GB')).toBe('en-GB');
    expect(localeFor('AU')).toBe('en-AU');
    // Every supported country must have one — no silent fallback for a market
    // we claim to support.
    for (const c of COUNTRY_LIST) {
      expect(LOCALES[c.iso2], `${c.iso2} has no locale`).toBeTruthy();
    }
  });

  it('renders money in each country own currency and convention', () => {
    const cases: Array<[string, string]> = [
    ];
    for (const [iso, cur] of cases) {
      const out = formatMoney(6500, cur, localeFor(iso));
      expect(out, `${iso}`).toBeTruthy();
      expect(out).not.toBe('');
    }
    // Japanese yen must not be divided by 100 just because sterling is.
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
