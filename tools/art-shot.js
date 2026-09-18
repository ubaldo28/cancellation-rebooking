/**
 * Re-renders every file under web/public/art from tools/trade-art.html.
 *
 * Forty-seven tile pictures — one per trade in TRADE_CATEGORIES, one per
 * category — plus the neutral one the "Everything" tile uses. Same pattern as
 * tools/og-shot.js beside it, deliberately: HTML and inline SVG loaded from
 * disk in headless Chromium and photographed, so the thing in the repository
 * is the DRAWING and the .webp files are output. Nothing on the front page of
 * this site is a binary nobody can reproduce.
 *
 * ESM, because the root package.json says "type": "module" — the same trap
 * og-shot.js fell into once and records in its own header.
 *
 * playwright-core IS NOT A RUNTIME DEPENDENCY OF THIS PROJECT AND MUST NOT
 * BECOME ONE. It is a large download in every install of a Worker that never
 * opens a browser, to redraw forty-eight small pictures perhaps twice a year.
 * So it is a devDependency, it is imported at runtime rather than at the top,
 * and its absence is reported as an instruction rather than as a stack trace.
 *
 *   npm i -D playwright-core
 *   CHROME=/path/to/chrome node tools/art-shot.js
 *
 * TWO SIZES, AND WHY EACH IS THE SIZE IT IS. Both are 5:3, the ratio of the
 * box every scene is drawn in, so nothing is ever cropped or letterboxed.
 *
 *   category  600x360  The front-page tiles are a grid of
 *                      `minmax(150px, 1fr)` in a 1240px column, so the widest
 *                      a tile ever gets is a little under 300 CSS pixels. 600
 *                      is exactly twice that: crisp on a 2x phone screen and
 *                      not one pixel wider than the widest place it is shown.
 *   trade     300x180  A browse row shows one at 75 CSS pixels wide. 300 is 4x
 *                      that, which is more than any screen needs today and is
 *                      the headroom for showing one larger later without
 *                      re-rendering the set. It is also the point where these
 *                      stop getting smaller: a flat drawing at 300x180 is
 *                      about 3 kB, and half the size saves under a kilobyte.
 *
 * WEBP, AND NOTHING ELSE. Stated in full over `artWebp` in trade-art.html: the
 * scenes have a gradient ground, PNG measured about eight times the size for
 * the same picture, and JPEG rings along the hard edges the style is made of. No
 * PNG fallback is shipped, because every browser that can run this site's
 * bundle has decoded WebP since 2020 and a second copy of forty-eight images
 * nobody would ever fetch is not a fallback, it is dead weight in the deploy.
 * src/lib/images.ts already lists image/webp in WEB_IMAGE_TYPES — "everything
 * a browser will render" — so this is the decision this codebase has already
 * made about WebP, applied to our own art.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const OUT = resolve(HERE, '../web/public/art');

/**
 * Where Chromium is. There is no default that is right on every machine, so
 * the one below is only the path this was last run against — CHROME is the
 * supported way to say it, and a wrong path is named in the error rather than
 * turning into "browser closed unexpectedly". Same default as og-shot.js.
 */
const CHROME = process.env.CHROME
  || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/**
 * The pixel size of each kind of picture. See the note at the top of the file
 * for why these two numbers and not others.
 */
const SIZES = {
  category: { w: 500, h: 500 },
  trade: { w: 500, h: 500 },
};

/**
 * WebP quality.
 *
 * 0.92 rather than 1. These are flat shapes over a smooth gradient, which is
 * the easiest thing in the world for this encoder: at 0.92 the difference from
 * lossless is invisible at any size these are shown at, and dropping from 1 to
 * 0.92 roughly halves the file. Raising it is the first thing to try if a
 * gradient ever bands visibly on a wide screen.
 */
const QUALITY = 0.92;

/** Says what to install, and stops, rather than letting a module error escape. */
function reportMissingPlaywright(err) {
  process.stderr.write(
    'art-shot: playwright-core is not installed.\n'
    + '\n'
    + 'It is not a runtime dependency of this project on purpose — it is a\n'
    + 'large download that only the two tools/ scripts need. Install it as a\n'
    + 'dev dependency just for this run:\n'
    + '\n'
    + '  npm i -D playwright-core\n'
    + '\n'
    + 'Then point CHROME at a Chromium or Chrome binary and run it again:\n'
    + '\n'
    + '  CHROME=/path/to/chrome node tools/art-shot.js\n'
    + '\n'
    + (process.env.CHROME
      ? `CHROME is currently "${CHROME}".\n`
      : `CHROME is unset, so it would fall back to "${CHROME}".\n`)
    + '\n'
    + `Underlying error: ${err && err.message ? err.message : String(err)}\n`,
  );
  process.exit(1);
}

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch (err) {
  // Only "it is not installed" gets the instruction. Anything else is a real
  // fault inside a package that IS there, and hiding that behind an install
  // step would send the reader off to fix the wrong thing.
  if (err && (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND')) {
    reportMissingPlaywright(err);
  }
  throw err;
}

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({
    // Big enough that no plate is ever clipped by the viewport; the screenshot
    // is of the plate element, not of the viewport, so this only has to be
    // larger than the largest picture.
    viewport: { width: 900, height: 700 },
    // ONE. The plate is sized in CSS pixels and the file is the screenshot, so
    // at 1 the number in SIZES above is the number of pixels written to disk.
    // At 2 every file would silently be twice the size that was argued for.
    deviceScaleFactor: 1,
  });

  // A failure inside the page — a scene with a typo in it, a Chromium without
  // a WebP encoder — otherwise surfaces as a timeout with nothing to read.
  page.on('pageerror', (err) => process.stderr.write(`art-shot: page error: ${err}\n`));

  await page.goto(`file://${resolve(HERE, 'trade-art.html')}`);

  /*
    THE LIST COMES OUT OF THE ARTWORK, NOT OUT OF THE CATALOGUE.

    This script cannot read src/lib/trades.ts: it is TypeScript and this is
    plain node with no build step, and adding one to a script that draws
    pictures would be the tail wagging the dog. So the scenes in trade-art.html
    are the list, which means the only thing this script can get wrong is
    rendering a drawing nothing uses — never shipping a trade with no drawing.

    Whether the drawings COVER the catalogue is pinned by test/art.test.ts,
    which reads both and fails in either direction. That is the right place for
    it: a trade added to the catalogue with no art must break the test suite,
    not merely produce a quiet gap the next time somebody happens to run this.
  */
  const scenes = await page.evaluate(() => window.artList());
  if (!Array.isArray(scenes) || scenes.length === 0) {
    throw new Error('trade-art.html listed no scenes');
  }

  for (const kind of Object.keys(SIZES)) {
    await mkdir(resolve(OUT, kind), { recursive: true });
  }

  let bytes = 0;
  for (const scene of scenes) {
    const size = SIZES[scene.kind];
    if (!size) throw new Error(`scene "${scene.id}" has an unknown kind "${scene.kind}"`);

    const drawn = await page.evaluate(
      ([id, w, h]) => window.artDraw(id, w, h), [scene.id, size.w, size.h],
    );
    if (!drawn) throw new Error(`trade-art.html would not draw "${scene.id}"`);

    // The plate, not the viewport: the page around it is white and would
    // otherwise be in every picture.
    const png = await page.locator('#plate').screenshot({ type: 'png' });
    const webp = await page.evaluate(
      ([dataUrl, q]) => window.artWebp(dataUrl, q),
      [`data:image/png;base64,${png.toString('base64')}`, QUALITY],
    );

    const data = Buffer.from(webp.slice(webp.indexOf(',') + 1), 'base64');
    await writeFile(resolve(OUT, scene.kind, `${scene.id}.webp`), data);
    bytes += data.length;
    process.stdout.write(
      `${scene.kind}/${scene.id}.webp  ${size.w}x${size.h}  ${data.length} B\n`,
    );
  }

  // Printed because it is the number that has to be argued for: these ship on
  // the front page and on both browse pages, and "how much did the pictures
  // cost" is the first question anybody should ask about them.
  process.stdout.write(
    `\n${scenes.length} files, ${bytes} bytes (${(bytes / 1024).toFixed(1)} kB) total\n`,
  );
} finally {
  // A throw between launch and close otherwise leaves a headless Chromium
  // running after node has exited.
  await browser.close();
}
