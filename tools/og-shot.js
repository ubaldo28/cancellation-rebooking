/**
 * Re-renders web/public/og.png from tools/og-card.html.
 *
 * Kept in the repo so the preview image is never a binary nobody can
 * reproduce. Needs playwright-core and a Chromium; point CHROME at one.
 *
 * ESM, BECAUSE THE ROOT package.json SAYS "type": "module". This file was
 * written with require() and could therefore never be run at all: `node
 * tools/og-shot.js` died on the first line with ERR_REQUIRE_ESM, which is a
 * poor way for the one script that reproduces a shipped asset to behave.
 *
 * playwright-core IS NOT A DEPENDENCY OF THIS PROJECT, deliberately. It is a
 * large download in every install of a Worker that never opens a browser, to
 * redraw one 1200x630 PNG about once a year. So it is imported at runtime and
 * its absence is reported as an instruction rather than as a stack trace:
 *
 *   npm i -D playwright-core
 *   CHROME=/path/to/chrome node tools/og-shot.js
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/**
 * Where Chromium is. There is no default that is right on every machine, so
 * the one below is only the path this was last run against — CHROME is the
 * supported way to say it, and a wrong path is named in the error rather than
 * turning into "browser closed unexpectedly".
 */
const CHROME = process.env.CHROME
  || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/** Says what to install, and stops, rather than letting a module error escape. */
function reportMissingPlaywright(err) {
  process.stderr.write(
    'og-shot: playwright-core is not installed.\n'
    + '\n'
    + 'It is not a dependency of this project on purpose — it is a large\n'
    + 'download that only this one script needs. Install it just for this run:\n'
    + '\n'
    + '  npm i -D playwright-core\n'
    + '\n'
    + 'Then point CHROME at a Chromium or Chrome binary and run it again:\n'
    + '\n'
    + '  CHROME=/path/to/chrome node tools/og-shot.js\n'
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
    // The exact size declared in og:image:width / og:image:height.
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
  });
  await page.goto(`file://${resolve(HERE, 'og-card.html')}`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(HERE, '../web/public/og.png') });
} finally {
  // A throw between launch and close otherwise leaves a headless Chromium
  // running after node has exited.
  await browser.close();
}
