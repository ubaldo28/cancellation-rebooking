import { describe, expect, it } from 'vitest';
import {
  ALL_TRADES, catalogFor, categoryOf, tradeBySlug, tradeLabel,
} from '../src/lib/trades';
import { rulesFor } from '../src/lib/credentials';

/**
 * The catalogue is the one place trades are defined, and the tests below are
 * mostly about keeping it that way. Before it existed the same list lived in a
 * web constant, a licensing map and the sample seeds, and they had already
 * drifted far enough that a trade could be pickable at sign-up and invisible
 * to every customer.
 */
describe('the trade catalogue', () => {
  it('has no duplicate slugs across categories', () => {
    const slugs = ALL_TRADES.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('keeps every slug lower case, because trade is matched that way', () => {
    for (const t of ALL_TRADES) expect(t.slug, t.slug).toBe(t.slug.toLowerCase());
  });

  it('has a licensing answer for every trade it offers', () => {
    // A trade somebody can pick with no rule behind it silently falls through
    // to "nothing recorded", which is the safe default but a poor one to reach
    // by accident on a trade we chose to list.
    for (const t of ALL_TRADES) {
      expect(rulesFor(t.slug).why, t.slug).toBeTruthy();
    }
  });

  it('keeps the slugs that were already live, so nobody is orphaned', () => {
    // Renaming a slug would strand every operator already using it. The
    // friendlier wording goes on the label instead.
    for (const slug of ['mobile car wash and detailing', 'mobile oil change and mechanics', 'mobile notary',
      'junk removal', 'phone and tablet repair', 'mobile pet grooming']) {
      expect(tradeBySlug(slug), slug).not.toBeNull();
    }
  });

  it('gives a friendly label and falls back to whatever was stored', () => {
    expect(tradeLabel('mobile car wash and detailing')).toBe('Car wash and detailing');
    expect(tradeLabel('something nobody added')).toBe('something nobody added');
  });

  it('puts every trade in exactly one category', () => {
    for (const t of ALL_TRADES) expect(categoryOf(t.slug), t.slug).not.toBeNull();
  });

  it('drops categories nobody is working in', () => {
    // A heading that opens onto nothing is a dead end, and a browse page made
    // of dead ends does not look like a marketplace.
    const cats = catalogFor(['mobile car wash and detailing', 'mobile oil change and mechanics']);
    expect(cats).toHaveLength(1);
    expect(cats[0]!.key).toBe('auto');
    expect(cats[0]!.trades.map((t) => t.slug))
      .toEqual(['mobile car wash and detailing', 'mobile oil change and mechanics']);
    expect(catalogFor([])).toEqual([]);
  });

  it('matches however the trade was typed', () => {
    expect(tradeBySlug('  Mobile Car Wash And Detailing ')?.slug).toBe('mobile car wash and detailing');
  });
});

describe('the trades a real customer actually searches for', () => {
  /**
   * Sanity from outside the building.
   *
   * The catalogue was written from the idea of a van — detailing, food trucks,
   * a pop-up bookstore — and it showed. Ranking Thumbtack's own service
   * taxonomy by how many pros are listed in each category puts house cleaning
   * and handyman first by a wide margin, then painting, lawn care, junk
   * removal, electrical, plumbing and HVAC. Six of those eight were missing
   * here, in a catalogue that had a mobile bookstore and a farmer's market
   * stall.
   *
   * These are not a wish list. Each one is a category with thousands of
   * independent operators in it, doing the work at the customer's address,
   * which is the whole premise of this product.
   */
  const MUST_EXIST = [
    'plumbing', 'electrical', 'heating and air conditioning',
    'painting and decorating', 'lawn care', 'furniture assembly',
    'tv mounting', 'moving and delivery', 'flooring installation',
    'drywall and plastering', 'garage door repair', 'home organising',
    'dog walking and pet sitting', 'personal chef', 'music lessons',
  ];

  it.each(MUST_EXIST)('offers %s', (slug) => {
    expect(tradeBySlug(slug), slug).not.toBeNull();
  });

  it('gives every one of them a licensing answer of its own', () => {
    // Falling through to UNLISTED would tell a plumber that California asks
    // nothing of them, which is the single most expensive thing this file
    // could say.
    for (const slug of MUST_EXIST) {
      expect(rulesFor(slug).why, slug).toBeTruthy();
      expect(rulesFor(slug).why, slug).not.toBe(rulesFor('a trade nobody added').why);
    }
  });

  it('tells the licensed building trades that they are contractor work', () => {
    for (const slug of ['plumbing', 'electrical', 'heating and air conditioning',
      'painting and decorating', 'flooring installation', 'drywall and plastering']) {
      expect(rulesFor(slug).license, slug).toBe('over_threshold');
      expect(rulesFor(slug).authority, slug).toBe('cslb');
    }
  });

  it('does not file movers under the contractors board', () => {
    // Household movers in California are licensed by the CPUC, not CSLB, and
    // the permit is required from the first job rather than above a threshold.
    // Getting this wrong would have a mover reading a rule that does not
    // apply to them and missing the one that does.
    const mover = rulesFor('moving and delivery');
    expect(mover.license).toBe('required');
    expect(mover.authority).toBe('cpuc');
    expect(mover.why).toMatch(/CPUC/);
  });

  it('names the requirements that are not CSLB at all', () => {
    // Each of these is enforced by somebody who does not care whether the
    // contractors board was satisfied, and each is easy to not know about.
    expect(rulesFor('heating and air conditioning').why).toMatch(/608/);
    expect(rulesFor('painting and decorating').why).toMatch(/lead-safe/i);
    expect(rulesFor('electrical').why).toMatch(/certified as an electrician/i);
    expect(rulesFor('smart home and security install').why).toMatch(/Alarm Company Operator/i);
  });

  it('licenses nail technicians, who are cosmetologists', () => {
    expect(rulesFor('mobile nail technician').license).toBe('required');
    expect(rulesFor('mobile nail technician').authority).toBe('bbc');
  });

  it('keeps every new trade inside a category the browse page can draw', () => {
    for (const slug of MUST_EXIST) expect(categoryOf(slug), slug).not.toBeNull();
  });
});

describe('the licensing answers that would hurt to get wrong', () => {
  it('asks a barber for their licence number without lecturing them', () => {
    // The module records what a business asserts; it does not police where
    // the work happens. An earlier version editorialised about that and it was
    // not the platform's call to make.
    const r = rulesFor('mobile hair salon or barbershop');
    expect(r.license).toBe('required');
    expect(r.authority).toBe('bbc');
    expect(r.why).toMatch(/add your/i);
    expect(r.why).not.toMatch(/does not permit|not allow|citation/i);
  });

  it('says veterinary work is licensed', () => {
    expect(rulesFor('mobile veterinary service').license).toBe('required');
    expect(rulesFor('mobile veterinary service').authority).toBe('vmb');
    // Grooming is not veterinary medicine and must not be caught by it.
    expect(rulesFor('mobile pet grooming').license).toBe('none');
  });

  it('does not pretend food trucks need nothing just because no board licenses them', () => {
    // The rule only records STATE trade licences, and food is permitted by the
    // county instead. Reporting "nothing required" would be true of the field
    // and catastrophically misleading to the person reading it.
    const r = rulesFor('food trucks');
    expect(r.license).toBe('none');
    expect(r.why).toMatch(/health permit/i);
    expect(r.why).toMatch(/commissary/i);
  });

  it('is honest that massage is a city question, not a state one', () => {
    const r = rulesFor('mobile spa and massage');
    expect(r.license).toBe('none');
    expect(r.why).toMatch(/voluntary/i);
    expect(r.why).toMatch(/city/i);
  });

  it('never invents a licence for a trade nobody looked at', () => {
    expect(rulesFor('sword sharpening').license).toBe('none');
    expect(rulesFor('sword sharpening').authority).toBeUndefined();
  });
});
