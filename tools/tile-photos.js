/**
 * Puts YOUR photographs on the tiles.
 *
 * WHAT THIS IS FOR. Every tile on the front page, on /browse and on a category
 * page is one file under web/public/art. They ship as flat drawings, which is
 * a placeholder; this script is how a real photograph replaces one, without
 * anybody having to know what size or format the site wants.
 *
 *   1. Save a photograph for each service into  art-source/
 *      named after the tile, e.g. art-source/mobile-locksmith.jpg
 *      (tools/tile-photo-prompts.md lists every name.)
 *   2. Run:  npm run photos
 *
 * Any of jpg, jpeg, png or webp goes in. What comes out is always the same:
 * a 500x500 WebP, centre-cropped from whatever shape went in, written over the
 * tile's existing file. 500x500 square is what the tiles are built for — see
 * TRADE_ART_W in src/lib/seo.ts for why that number and not another.
 *
 * IT WILL ONLY OVERWRITE A TILE THAT ALREADY EXISTS. The forty-eight names
 * under web/public/art are the site's own list of tiles, computed from the
 * catalogue; a source file whose name is not one of them is reported and
 * skipped rather than written somewhere nothing reads. That is what stops a
 * typo ("locksmith.jpg") from looking like it worked.
 *
 * Same machinery as tools/art-shot.js beside it, for the same reason: headless
 * Chromium does the decoding, the cropping and the WebP encoding, so this adds
 * no image library to a project that never opens one in production.
 * playwright-core is a devDependency and is imported at runtime, so its
 * absence is an instruction rather than a stack trace.
 *
 *   npm i -D playwright-core
 *   CHROME=/path/to/chrome npm run photos
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SRC = resolve(HERE, '../art-source');
const ART = resolve(HERE, '../web/public/art');

/** The one size the tiles are built for. Keep in step with TRADE_ART_W/H. */
const SIZE = 500;

/**
 * WebP quality.
 *
 * 0.82 is where a photograph at this size stops getting visibly better and
 * starts getting bigger. test/art.test.ts refuses anything over 120 kB a file,
 * which is roughly what quality 0.95 costs on a busy photograph — so if that
 * test starts failing, this number is the first thing to look at.
 */
const QUALITY = 0.82;

const CHROME = process.env.CHROME
  || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const READABLE = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/** Every tile the site has, as `kind/name`, read off the art directory. */
async function tiles() {
  const out = new Map();
  for (const kind of ['trade', 'category']) {
    let names = [];
    try { names = await readdir(resolve(ART, kind)); } catch { names = []; }
    for (const f of names) {
      if (extname(f) !== '.webp') continue;
      out.set(`${kind}/${basename(f, '.webp')}`, resolve(ART, kind, f));
    }
  }
  return out;
}

/**
 * Where a source file belongs.
 *
 * `cat-auto.jpg` is the category tile, `mobile-locksmith.jpg` is the trade.
 * The `cat-` prefix is the one in tools/tile-photo-prompts.md, so the names in
 * that file are the names to save.
 */
function target(name) {
  return name.startsWith('cat-')
    ? `category/${name.slice(4)}`
    : `trade/${name}`;
}

async function main() {
  let sources = [];
  try {
    sources = (await readdir(SRC)).filter((f) => READABLE.has(extname(f).toLowerCase()));
  } catch {
    await mkdir(SRC, { recursive: true });
    console.log(`Made ${SRC}. Put your photographs in there, named after the`);
    console.log('tiles (tools/tile-photo-prompts.md lists every name), and run this again.');
    return;
  }
  if (!sources.length) {
    console.log(`No images in ${SRC}.`);
    console.log('Name each one after its tile — mobile-locksmith.jpg, cat-auto.jpg —');
    console.log('and see tools/tile-photo-prompts.md for the full list.');
    return;
  }

  const known = await tiles();
  const jobs = [];
  const unknown = [];
  for (const f of sources) {
    const key = target(basename(f, extname(f)).trim().toLowerCase());
    if (!known.has(key)) { unknown.push(f); continue; }
    jobs.push({ src: resolve(SRC, f), out: known.get(key), key, from: f });
  }

  if (!jobs.length) {
    console.log('None of those names is a tile on this site:');
    for (const f of unknown) console.log(`  ${f}`);
    console.log('\nThe names are in tools/tile-photo-prompts.md.');
    return;
  }

  let chromium;
  try { ({ chromium } = await import('playwright-core')); } catch {
    console.error('playwright-core is not installed. Run:  npm i -D playwright-core');
    process.exit(1);
  }

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
    .catch((e) => {
      console.error(`Could not start Chromium at ${CHROME}`);
      console.error('Set CHROME to the browser on this machine, e.g.');
      console.error("  CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run photos");
      console.error(String(e.message || e).split('\n')[0]);
      process.exit(1);
    });

  const page = await browser.newPage();
  await page.setContent('<html><body></body></html>');

  let written = 0;
  let bytes = 0;
  for (const job of jobs) {
    const raw = await readFile(job.src);
    const dataUrl = `data:${mime(job.src)};base64,${raw.toString('base64')}`;
    const encoded = await page.evaluate(async ({ url, size, quality }) => {
      const blob = await (await fetch(url)).blob();
      const bmp = await createImageBitmap(blob);
      const cv = document.createElement('canvas');
      cv.width = size;
      cv.height = size;
      const ctx = cv.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      // THE BOTTOM STRIP IS DROPPED FIRST, AND HERE IS WHY.
      //
      // Every image generator stamps its badge into the bottom-right corner —
      // Gemini's sparkle, and the others do the same in the same place. A
      // badge on a tile reads as a broken picture, and painting it out means
      // inventing pixels that were never there. Cutting the strip it sits in
      // costs the bottom tenth of the frame, which a 3:4 tile crops away in
      // any case, and leaves every remaining pixel exactly as it was
      // generated.
      //
      // This only removes the VISIBLE badge. Generators also write an
      // invisible provenance watermark into the pixels themselves, and
      // nothing here touches that: these files still carry it, and still
      // answer honestly to anything that checks where they came from.
      const BADGE = 0.10;
      const usableH = Math.round(bmp.height * (1 - BADGE));
      // Centre crop to a square out of what is left, then down to `size`. A
      // photograph of any shape loses the same amount off each side and keeps
      // its middle, which is where the subject of a tile photograph is.
      const side = Math.min(bmp.width, usableH);
      const sx = (bmp.width - side) / 2;
      const sy = (usableH - side) / 2;
      ctx.drawImage(bmp, sx, sy, side, side, 0, 0, size, size);
      bmp.close();
      return {
        data: cv.toDataURL('image/webp', quality).split(',')[1],
        w: bmp.width,
        h: bmp.height,
      };
    }, { url: dataUrl, size: SIZE, quality: QUALITY });

    const buf = Buffer.from(encoded.data, 'base64');
    await writeFile(job.out, buf);
    written += 1;
    bytes += buf.length;
    console.log(`${job.from.padEnd(42)} -> ${job.key}.webp  ${SIZE}x${SIZE}  ${buf.length} B`);
  }

  await browser.close();

  console.log(`\n${written} tile${written === 1 ? '' : 's'} replaced, ${bytes} bytes written.`);
  if (unknown.length) {
    console.log('\nSkipped — not the name of a tile on this site:');
    for (const f of unknown) console.log(`  ${f}`);
    console.log('The names are in tools/tile-photo-prompts.md.');
  }
  const missing = [...known.keys()].filter(
    (k) => !jobs.some((j) => j.key === k),
  );
  if (missing.length) {
    console.log(`\n${missing.length} tile${missing.length === 1 ? '' : 's'} still on the placeholder drawing:`);
    for (const k of missing) console.log(`  ${k.startsWith('category/') ? `cat-${k.slice(9)}` : k.slice(6)}`);
  }
}

function mime(path) {
  const e = extname(path).toLowerCase();
  if (e === '.png') return 'image/png';
  if (e === '.webp') return 'image/webp';
  return 'image/jpeg';
}

await main();
