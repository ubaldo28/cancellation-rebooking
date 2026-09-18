import { readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ALL_TRADES, TRADE_CATEGORIES } from '../src/lib/trades';
import {
  CATEGORY_ART_H, CATEGORY_ART_W, TRADE_ART_H, TRADE_ART_W,
  catalogPayload, categoryArt, tradeArt, tradeSlug, withArt,
} from '../src/lib/seo';

/**
 * EVERY TILE HAS A PICTURE, AND EVERY PICTURE HAS A TILE.
 *
 * The browse pages and the front page now draw a .webp for every trade and
 * every category. The failure this file exists to prevent is the quiet one: a
 * trade is added to TRADE_CATEGORIES, nobody draws it, and the row ships with
 * an <img> pointing at a 404. Nothing in production would say so — the image
 * is decorative and carries an empty alt, so there is not even a broken-image
 * label to notice. A blank rectangle on the front page of a live marketplace
 * would simply sit there.
 *
 * So the coverage is checked in BOTH directions:
 *
 *   * every trade and every category names a file that is on disk, and
 *   * every file on disk is named by a trade or a category.
 *
 * The second half matters as much as the first. A renamed slug leaves the old
 * drawing behind, and an orphan is how the next person to look concludes that
 * the set is complete when it is not — and how a deleted trade's picture goes
 * on being deployed for years.
 *
 * WHY THIS READS THE FILESYSTEM RATHER THAN RENDERING ANYTHING. The pictures
 * are produced by `npm run art`, which needs playwright-core and a Chromium
 * binary; neither is available in the ordinary test run and neither should be.
 * What is committed is what ships, so what is committed is what is checked.
 */

/** Everything the Worker serves as a static file, relative to this file. */
const PUBLIC = new URL('../web/public/', import.meta.url);

/**
 * A served path, as a file on disk.
 *
 * The leading slash is stripped rather than joined, because '/art/x' resolved
 * against a base URL is an absolute path and lands on the filesystem root.
 */
const fileFor = (path: string): URL => new URL(path.replace(/^\/+/, ''), PUBLIC);

/** The files actually committed, as the paths the two trees would ask for. */
function committed(kind: 'trade' | 'category'): Set<string> {
  return new Set(
    readdirSync(fileFor(`/art/${kind}/`))
      .filter((f) => f.endsWith('.webp'))
      .map((f) => `/art/${kind}/${f}`),
  );
}

/** The bytes of one file, by the path the site would request it at. */
const bytesOf = (path: string): number => statSync(fileFor(path)).size;

describe('every trade has a drawing, and no drawing is orphaned', () => {
  it('has a file on disk for every trade in the catalogue', () => {
    // Guards the assertion itself: an empty catalogue would pass a loop.
    expect(ALL_TRADES.length).toBeGreaterThan(30);
    const have = committed('trade');
    for (const t of ALL_TRADES) {
      expect(have, `no drawing for "${t.slug}" — draw one in tools/trade-art.html `
        + 'and run `npm run art`').toContain(tradeArt(t.slug));
    }
  });

  it('has a file on disk for every category, and for the neutral tile', () => {
    expect(TRADE_CATEGORIES.length).toBeGreaterThan(5);
    const have = committed('category');
    for (const c of TRADE_CATEGORIES) {
      expect(have, `no drawing for category "${c.key}"`).toContain(categoryArt(c.key));
    }
    // The front page's "Everything" tile sits in the same grid as the eight and
    // needs a real picture; it is not a category, so nothing above covers it.
    expect(have).toContain(categoryArt(null));
  });

  it('has no drawing that nothing on the site asks for', () => {
    const wanted = new Set([
      ...ALL_TRADES.map((t) => tradeArt(t.slug)),
      ...TRADE_CATEGORIES.map((c) => categoryArt(c.key)),
      categoryArt(null),
    ]);
    for (const kind of ['trade', 'category'] as const) {
      for (const path of committed(kind)) {
        expect(wanted, `${path} is not named by any trade or category — a trade `
          + 'was probably renamed or removed; delete the file or restore the row')
          .toContain(path);
      }
    }
  });

  it('draws each one at the size both trees claim it is', () => {
    /*
      THE DIMENSIONS ON THE MARKUP HAVE TO BE THE FILE'S REAL ONES.

      Both trees put width and height on every one of these <img> elements, and
      that is what stops a page of forty rows reflowing as the pictures land.
      The numbers only do that job while they match the file: a browser reads
      them as the RATIO to reserve, so a 300x180 attribute pair on a square
      file reserves the wrong box and reintroduces the jump.

      Read out of the WebP container rather than by decoding the image, because
      that needs no image library: the size is in the header of a file format
      we produce ourselves, and reading it is a dozen lines of arithmetic.

      Chromium's canvas writes the EXTENDED container — 'VP8X' rather than a
      bare 'VP8 ' — because it attaches an ICC profile, and the extended header
      is where the canvas size then lives: two 24-bit little-endian fields at
      offset 24, each holding the dimension MINUS ONE. The chunk id is asserted
      rather than assumed, so the day a Chromium writes a plain 'VP8 ' or a
      lossless 'VP8L' instead this fails saying which, rather than quietly
      reading two unrelated bytes and comparing them to 300.
    */
    for (const [path, w, h] of [
      ...ALL_TRADES.map((t) => [tradeArt(t.slug), TRADE_ART_W, TRADE_ART_H] as const),
      ...TRADE_CATEGORIES.map(
        (c) => [categoryArt(c.key), CATEGORY_ART_W, CATEGORY_ART_H] as const),
      [categoryArt(null), CATEGORY_ART_W, CATEGORY_ART_H] as const,
    ]) {
      const buf = readFileSync(fileFor(path));
      expect(buf.subarray(0, 4).toString('latin1'), path).toBe('RIFF');
      expect(buf.subarray(8, 12).toString('latin1'), path).toBe('WEBP');
      expect(buf.subarray(12, 16).toString('latin1'), path).toBe('VP8X');
      expect(buf.readUIntLE(24, 3) + 1, path).toBe(w);
      expect(buf.readUIntLE(27, 3) + 1, path).toBe(h);
    }
  });

  it('keeps the whole set small enough to ship on a front page', () => {
    /*
      A CEILING, NOT A MEASUREMENT.

      These files are fetched by the front page and by both browse pages, so
      "how much do the pictures cost" is the first question anybody should ask
      about them. The ceilings are set for PHOTOGRAPHS at 500x500, which is
      what these are: a well-encoded WebP photograph that size is 30-70 kB, so
      120 kB each catches one that was never re-encoded and 4 MB across the set
      catches somebody dropping in camera originals. They were 20 kB and 400 kB
      when every picture was a flat drawing.
    */
    const all = [
      ...ALL_TRADES.map((t) => tradeArt(t.slug)),
      ...TRADE_CATEGORIES.map((c) => categoryArt(c.key)),
      categoryArt(null),
    ];
    const total = all.reduce((sum, p) => sum + bytesOf(p), 0);
    expect(total).toBeLessThan(4 * 1024 * 1024);
    // And no single one of them is allowed to be the whole budget.
    for (const p of all) expect(bytesOf(p), p).toBeLessThan(120 * 1024);
  });
});

describe('no picture is a binary nobody can reproduce', () => {
  /**
   * The scene ids in tools/trade-art.html, read out of the source.
   *
   * THIS IS THE REASON tools/og-card.html EXISTS, APPLIED TO FORTY-EIGHT MORE
   * FILES. A .webp in web/public that nobody can redraw is a dead end: the
   * next person to want a different stroke weight, a fifth palette or one more
   * trade has to either hand-edit a bitmap or start the whole set again. The
   * check above says the file is there; this one says the DRAWING is there,
   * which is what makes the file replaceable.
   *
   * Read with a regex rather than by running the page, because the page is a
   * browser document: it sets window.artDraw and asks for a canvas, neither of
   * which exists here. The ids are the one thing in it that is machine-readable
   * on its own, and a rename of the `id:` key fails this with that as the
   * message rather than as an empty set that passes every loop.
   */
  function scenes(): Set<string> {
    const src = readFileSync(new URL('../tools/trade-art.html', import.meta.url), 'utf8');
    const ids = [...src.matchAll(/^\s*\{\s*id:\s*'([^']+)'/gm)].map((m) => m[1]!);
    if (ids.length === 0) {
      throw new Error('no scenes found in tools/trade-art.html — has the shape changed?');
    }
    return new Set(ids);
  }

  it('has a drawn scene for every trade and every category', () => {
    const drawn = scenes();
    for (const t of ALL_TRADES) {
      expect(drawn, `tools/trade-art.html has no scene for "${t.slug}"`)
        .toContain(tradeSlug(t.slug));
    }
    for (const c of TRADE_CATEGORIES) {
      expect(drawn, `tools/trade-art.html has no scene for category "${c.key}"`)
        .toContain(c.key);
    }
    expect(drawn).toContain('all');
  });

  it('draws nothing the site does not use', () => {
    const wanted = new Set<string>([
      ...ALL_TRADES.map((t) => tradeSlug(t.slug)),
      ...TRADE_CATEGORIES.map((c) => c.key),
      'all',
    ]);
    for (const id of scenes()) {
      expect(wanted, `tools/trade-art.html draws "${id}", which nothing asks for`)
        .toContain(id);
    }
  });
});

describe('the one mapping both trees read', () => {
  it('names each trade file after that trade’s own URL segment', () => {
    // The path is derived, not tabulated, and this is the derivation: a trade
    // added to the catalogue gets a path for free and nobody has to remember a
    // forty-row table. It is `tradeSlug` so the picture and the page share a
    // spelling and either can be found from the other by eye.
    for (const t of ALL_TRADES) {
      expect(tradeArt(t.slug), t.slug).toBe(`/art/trade/${tradeSlug(t.slug)}.webp`);
    }
    // The two that carry punctuation, because they are where a slugifier that
    // was quietly replaced would show up first.
    expect(tradeArt("mobile farmer's market")).toBe('/art/trade/mobile-farmer-s-market.webp');
    expect(tradeArt('phone and tablet repair')).toBe('/art/trade/phone-and-tablet-repair.webp');
  });

  it('sends the same path to the browser that the Worker renders', () => {
    /*
      THE POINT OF THE WHOLE ARRANGEMENT.

      The React pages do not compute these paths; they read `art` off the
      catalogue the Worker serves them. So the guarantee that a browse row
      drawn by React and the same row drawn by src/lib/seo.ts ask for the same
      file is this equality, and nothing else. If `withArt` ever stopped using
      `tradeArt`, every tile in the app would point somewhere the server-
      rendered twin does not — and both would still render.
    */
    const cats = withArt(TRADE_CATEGORIES);
    expect(cats).toHaveLength(TRADE_CATEGORIES.length);
    for (const c of cats) {
      expect(c.art, c.key).toBe(categoryArt(c.key));
      const here = TRADE_CATEGORIES.find((x) => x.key === c.key)!;
      expect(c.trades.map((t) => t.slug)).toEqual(here.trades.map((t) => t.slug));
      for (const t of c.trades) expect(t.art, t.slug).toBe(tradeArt(t.slug));
    }
  });

  it('keeps the label and the hint on the way through', () => {
    // `withArt` rebuilds the objects rather than mutating the catalogue, which
    // is how a field gets dropped by accident. The sign-up picker and the
    // browse rows both read these.
    const auto = withArt(TRADE_CATEGORIES).find((c) => c.key === 'auto')!;
    expect(auto.label).toBe('Automotive and vehicle');
    expect(auto.trades[0]!.label).toBe('Car wash and detailing');
    const food = withArt(TRADE_CATEGORIES).find((c) => c.key === 'food')!;
    expect(food.trades.find((t) => t.slug === 'food trucks')!.hint)
      .toBe('Private events and catering');
  });

  it('does not write anything onto the catalogue it was handed', () => {
    // TRADE_CATEGORIES is a module constant half this codebase reads, and a
    // request handler writing a field onto it is how a Worker isolate starts
    // serving something that depends on which request warmed it.
    withArt(TRADE_CATEGORIES);
    for (const c of TRADE_CATEGORIES) {
      expect(c, c.key).not.toHaveProperty('art');
      for (const t of c.trades) expect(t, t.slug).not.toHaveProperty('art');
    }
  });

  it('carries the neutral drawing on the payload, for the Everything tile', () => {
    // The front page's last tile is not a category, so it has no row to hang a
    // path off. Without this field Discover.tsx would be the one place in the
    // app that writes out a path to an art file by hand.
    const payload = catalogPayload(TRADE_CATEGORIES);
    expect(payload.everything_art).toBe('/art/category/all.webp');
    expect(payload.categories.map((c) => c.key))
      .toEqual(TRADE_CATEGORIES.map((c) => c.key));
  });
});
