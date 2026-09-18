import { describe, expect, it } from 'vitest';
import {
  clientSource, exportedNumber, exportedString, liftFunction,
} from './client-source';
import { ZERO_DECIMAL, formatMoney } from '../src/lib/countries';
import { REDACTION_NOTICE } from '../src/lib/redact';
import { tradeSlug } from '../src/lib/seo';
import { MAX_MESSAGE_CHARS } from '../src/lib/chat';
import { WEB_IMAGE_TYPES } from '../src/lib/images';
import {
  HALF_REFUND_SECONDS, LEAD_FEE_DOORSTEP_PERCENT, LEAD_FEE_LAST_HOURS_PERCENT,
  LEAD_FEE_LATE_PERCENT, LEAD_FEE_MIN_CENTS, NO_REFUND_SECONDS, leadFeeCents,
} from '../src/lib/bypass';
import { TRADE_CATEGORIES } from '../src/lib/trades';

/**
 * THE FACTS THAT LIVE IN BOTH TREES, PINNED SO THEY CANNOT DRIFT.
 *
 * src/ runs in the Worker and web/ is compiled for the browser. Neither can
 * import the other at runtime, so a handful of constants and sentences are
 * written out twice on purpose. That is legitimate and it is also how a page
 * ends up quoting a fee the Worker does not charge, warning at a length the
 * Worker does not refuse, or linking to a slug the Worker answers 404 for —
 * every one of which has happened in this codebase and is recorded in the
 * comment above the copy that was wrong.
 *
 * Each test below is one pair. It fails the moment either half is edited on
 * its own, which is the whole and only job of this file.
 *
 * The payment sentence has its own pair in public-payload.test.ts, alongside
 * the server-rendered pages that quote it.
 */

// ---------------------------------------------------------------------------
// 1. The rule about contact details
// ---------------------------------------------------------------------------

describe('the contact-details notice, said once', () => {
  it('is the same sentence in the Worker and in the app', () => {
    // The Worker sends this back after it has already removed something from a
    // chat message; the app prints it above the boxes that redact SILENTLY —
    // the parts-quote description, where nothing comes back to say so. Two
    // wordings would read as two different rules about the same behaviour.
    const client = exportedString(
      clientSource('web/src/components/ui.tsx'), 'REDACTION_NOTICE');
    expect(client).toBe(REDACTION_NOTICE);
    // Guards the comparison itself: two empty strings are also equal.
    expect(REDACTION_NOTICE.length).toBeGreaterThan(60);
  });
});

// ---------------------------------------------------------------------------
// 2. Money
// ---------------------------------------------------------------------------

describe('what a price looks like, on either side of the wire', () => {
  it('treats the same currencies as having no minor unit', async () => {
    const { ZERO_DECIMAL: web } = await import('../web/src/lib/format');
    expect([...web].sort()).toEqual([...ZERO_DECIMAL].sort());
    // The list is the reason this pair matters: web's copy in api.ts once had
    // five entries where the others had ten, so a job priced in XAF rendered
    // as two different numbers depending on which screen you were on.
    expect(ZERO_DECIMAL.has('JPY')).toBe(true);
    expect(ZERO_DECIMAL.has('USD')).toBe(false);
  });

  it('renders the same figure, character for character', async () => {
    const { formatMoney: web } = await import('../web/src/lib/format');
    const cases: Array<[number, string]> = [
      [6500, 'USD'],   // an ordinary two-decimal price
      [0, 'USD'],      // free, which the cost pages do show
      [450000, 'JPY'], // zero-decimal: the ¥4,500 job that must not become ¥45
      [123, 'XOF'],
      [19999, 'GBP'],
      [50, 'EUR'],
      [9900, 'ZZZ'],   // not a currency: both fall back the same way or neither
    ];
    for (const [cents, currency] of cases) {
      expect(web(cents, currency), `${cents} ${currency}`)
        .toBe(formatMoney(cents, currency));
    }
  });
});

// ---------------------------------------------------------------------------
// 3. How many listings make a price range
// ---------------------------------------------------------------------------

describe('"too few listings to give a range"', () => {
  it('is the same threshold on the server page and the React page', async () => {
    const { ENOUGH } = await import('../web/src/lib/format');
    // seo.ts keeps its copy unexported, so it is read from the source.
    const worker = exportedNumber(clientSource('src/lib/seo.ts'), 'ENOUGH');
    expect(worker).toBe(ENOUGH);
    // A trade shown with a range on /cost and told "too few listings" on
    // /cost/<trade> makes both pages look wrong, and they are the same URL
    // rendered twice.
    expect(ENOUGH).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// 4. The slugs in the Worker's own URLs
// ---------------------------------------------------------------------------

describe('the slug the Worker mints and the slug the app links to', () => {
  it('agrees on every trade in the catalogue', async () => {
    const { tradeSlug: web } = await import('../web/src/lib/seo');
    const trades = TRADE_CATEGORIES.flatMap((c) => c.trades.map((t) => t.slug));
    expect(trades.length).toBeGreaterThan(5);
    for (const trade of trades) expect(web(trade), trade).toBe(tradeSlug(trade));
  });

  it('agrees on the shapes that produced the 404s', async () => {
    const { tradeSlug: web, nearTradeHref } = await import('../web/src/lib/seo');
    // Trade.tsx used to build these links with encodeURIComponent, so a trade
    // with a space in it pointed at /near/burbank/junk%20removal — which
    // tradeFromSlug does not recognise and the Worker answers 404 for.
    for (const trade of [
      'junk removal', '  Mobile  Detailing  ', 'phone and tablet repair',
      'café & bar cleaning', 'a---b', '',
    ]) {
      expect(web(trade), JSON.stringify(trade)).toBe(tradeSlug(trade));
    }
    expect(nearTradeHref('burbank', 'junk removal')).toBe('/near/burbank/junk-removal');
  });
});

// ---------------------------------------------------------------------------
// 5. The length the enquiry form warns at
// ---------------------------------------------------------------------------

describe('the enquiry form counts down to the length the Worker refuses at', () => {
  const form = clientSource('web/src/components/Enquiry.tsx');

  it('uses the chat message ceiling for a message', () => {
    expect(exportedNumber(form, 'MAX_MESSAGE')).toBe(MAX_MESSAGE_CHARS);
  });

  it('uses the estimate ceiling for a quote request', () => {
    // askForEstimate keeps its copy unexported, so it is read from the source.
    const worker = exportedNumber(clientSource('src/lib/estimates.ts'), 'MAX_REQUEST_CHARS');
    expect(exportedNumber(form, 'MAX_REQUEST')).toBe(worker);
  });

  it('uses the name ceiling the Worker cuts at', () => {
    const worker = exportedNumber(clientSource('src/lib/chat.ts'), 'MAX_NAME_CHARS');
    expect(exportedNumber(form, 'MAX_NAME')).toBe(worker);
  });
});

// ---------------------------------------------------------------------------
// 5a. The one refusal an accepted estimate can come back from
// ---------------------------------------------------------------------------

describe('the estimate card offers a way forward on the refusal that has one', () => {
  it('branches on the code decideEstimate throws when the time has gone', () => {
    // Four things can refuse an accept and three of them end the quote: it was
    // already answered, its start time passed, or the business cannot be paid.
    // A CLASH IS THE ODD ONE. Nothing is written, the estimate row is still
    // 'quoted', and all that is gone is the hour it named — so the customer's
    // move is to ask for another time in the conversation they are already
    // looking at, and the card says so instead of greying out.
    //
    // That branch turns on a string the browser cannot import, so the string is
    // written out in both trees. Renaming it on the Worker would not throw and
    // would not fail to compile: the card would simply stop offering the one
    // way forward that exists, on the one refusal that has one, and nothing
    // anywhere would say so.
    const client = exportedString(
      clientSource('web/src/components/Estimates.tsx'), 'SLOT_TAKEN');
    expect(client).toBe('slot_taken');

    // Both throws inside decideEstimate: the cheap read before the batch, and
    // the one worked out afterwards when the batch matched nothing.
    const worker = clientSource('src/lib/estimates.ts');
    expect(worker).toContain(`if (clash) throw conflict(SLOT_GONE, '${client}');`);
    expect(worker).toContain(`? conflict(SLOT_GONE, '${client}')`);
  });
});

// ---------------------------------------------------------------------------
// 5b. How many photographs a business may show
// ---------------------------------------------------------------------------

describe('the portfolio form offers exactly as many slots as the Worker accepts', () => {
  // THIS NUMBER IS A STORAGE BUDGET NOW, NOT A TASTE JUDGEMENT, which is why it
  // earns a test it never had while it was twelve.
  //
  // Photographs live in a Workers KV namespace whose free allowance is 1 GB for
  // the WHOLE ACCOUNT, standing rather than monthly, shared between every
  // business's portfolio and every photograph taken on every job. Nothing in
  // this project sits behind a card, so a full store is a broken feature rather
  // than a larger bill. Five is the owner's number, set on 13 September 2026.
  //
  // The two halves fail in opposite and equally quiet ways. A bigger number in
  // the browser offers a slot the Worker answers with photo_limit, after the
  // upload, which on a phone is a minute of somebody's life. A smaller one
  // hides a slot they were entitled to, and nobody ever reports that. Neither
  // shows up anywhere else, because each half is self-consistent.
  it('matches MAX_PHOTOS, and is five', () => {
    const worker = exportedNumber(clientSource('src/lib/profile.ts'), 'MAX_PHOTOS');
    const form = exportedNumber(clientSource('web/src/pages/Profile.tsx'), 'PHOTO_MAX_COUNT');
    expect(form).toBe(worker);
    // Pinned to the literal as well as to each other: two halves that agreed on
    // twelve would pass the line above while quietly costing four times as much
    // of the shared gigabyte. Raising it deliberately means editing this line,
    // which is the moment somebody re-reads the paragraph above.
    expect(worker).toBe(5);
  });

  it('names the cap in the refusal rather than spelling a number beside it', () => {
    const src = clientSource('src/lib/profile.ts');
    expect(src).toContain('You can show ${MAX_PHOTOS} photos.');
  });

  // The SIZE cap, for the same reason and with the same failure modes. This
  // one is checked in the browser AFTER shrinkImage has run, so both halves are
  // measuring the ~300 KB that actually gets sent rather than the camera file —
  // which is why two megabytes refuses nothing a real operator does, and why
  // the browser half disagreeing would be invisible in ordinary use and only
  // show up for whoever uploaded something unusual.
  it('uses the same size cap in the browser as the Worker enforces', () => {
    const worker = exportedNumber(clientSource('src/lib/profile.ts'), 'MAX_PHOTO_BYTES');
    const form = exportedNumber(clientSource('web/src/pages/Profile.tsx'), 'PHOTO_MAX_BYTES');
    expect(form).toBe(worker);
    expect(worker).toBe(2_000_000);
  });
});

// ---------------------------------------------------------------------------
// 5c. Photographs sent inside a conversation
// ---------------------------------------------------------------------------

describe('the chat composer refuses what the conversation photo route refuses', () => {
  const chat = clientSource('web/src/components/Chat.tsx');

  it('uses the Worker size cap for a conversation photo', () => {
    const worker = exportedNumber(clientSource('src/lib/chat.ts'), 'MAX_MESSAGE_PHOTO_BYTES');
    expect(exportedNumber(chat, 'MAX_PHOTO_BYTES')).toBe(worker);
    expect(worker).toBe(2_000_000);
  });

  // THE BROWSER'S BUDGET FOR THE FILE IS SMALLER THAN THE CAP, ON PURPOSE, and
  // this is the pair that stops somebody "tidying up" the difference.
  //
  // assertBodyWithin in src/lib/images.ts refuses on the request's declared
  // content-length before the body is read. A multipart request is the file
  // PLUS a caption of up to 2000 characters, the field names, the filename and
  // the boundary lines — so a file of exactly MAX_MESSAGE_PHOTO_BYTES produces
  // a request of more than MAX_MESSAGE_PHOTO_BYTES and is refused for being too
  // big, leaving the sender holding a photo that was exactly on the limit.
  //
  // The slack only has to be bigger than that envelope. It is asserted as a
  // range rather than a number because the exact figure is a judgement, and
  // pinning a judgement to the byte is how a test becomes something people edit
  // without reading.
  it('leaves room for the caption and the multipart framing', () => {
    const cap = exportedNumber(chat, 'MAX_PHOTO_BYTES');
    const envelope = exportedNumber(chat, 'ENVELOPE_BYTES');
    const worker = exportedNumber(clientSource('src/lib/chat.ts'), 'MAX_MESSAGE_CHARS');
    // Four bytes per character is the worst UTF-8 can do, and the framing is a
    // few hundred more on top of it.
    expect(envelope).toBeGreaterThan(worker * 4);
    expect(envelope).toBeLessThan(cap / 10);
  });

  it('warns at the length the Worker refuses a caption at', () => {
    // A caption IS a message body — same column, same filter, same cap — so the
    // composer's counter is the counter for both. This pair was missing while
    // the composer only ever sent words, and it is the same class of bug as the
    // enquiry form's above: a browser that stopped at 1000 would hide a
    // thousand characters somebody was entitled to write, and one that stopped
    // at 4000 would let them write a message the Worker throws away.
    expect(exportedNumber(chat, 'MAX_CHARS')).toBe(MAX_MESSAGE_CHARS);
  });

  it('re-encodes to exactly the formats the Worker stores', () => {
    // exportedString joins every quoted fragment in the declaration, which for
    // an array of string literals is the members run together — so the Worker's
    // list is joined the same way and the two are compared as one string. It
    // catches an added member, a removed one and a reordered one alike.
    //
    // This is the pair that keeps iPhones working. The Worker takes these three
    // and refuses HEIC outright (src/lib/chat.ts says why: nothing on a desktop
    // draws a HEIC, so accepting one is a message that silently does not
    // arrive), and web/src/lib/image.ts is the canvas re-encode that turns an
    // iPhone's HEIC into one of them before it is ever sent. A browser list
    // that grew a format the Worker refuses would hand people an upload that
    // always fails at the very end.
    const browser = exportedString(
      clientSource('web/src/lib/image.ts'), 'WEB_IMAGE_TYPES');
    expect(browser).toBe(WEB_IMAGE_TYPES.join(''));
    expect(WEB_IMAGE_TYPES).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 6. The cancellation fee an operator is shown before they cancel
// ---------------------------------------------------------------------------

/**
 * The panel's own arithmetic, compiled out of JobsPanel.tsx and run here.
 *
 * Comparing the two functions rather than the two sets of numbers is the point
 * of doing it this way. The numbers were right once before while the shape was
 * not: the panel applied the floor to a job with no price and quoted $15 for a
 * cancellation that is never billed, and it worked out half the price for
 * anything inside 48 hours while the sentence beside it said three quarters.
 */
const panel = clientSource('web/src/components/JobsPanel.tsx');
const clientRung = liftFunction<(arrived: boolean, hoursOut: number) => string>(
  panel, 'function cancelRung(', '  return \'none\';\n}', 'cancelRung');
const clientFee = liftFunction<(cents: number, rung: string) => number>(
  panel, 'const LEAD_FEE_MIN_CENTS', 'FEE_PERCENT[rung]) / 100)));\n}', 'leadFeeCents');

describe('the fee the panel quotes is the fee the Worker charges', () => {
  it('puts the same job on the same rung as feeFor', () => {
    // feeFor is not exported, and its two boundaries are: the panel reads
    // hours and the Worker reads seconds, so this is where the units meet.
    const hours = (s: number) => s / 3600;
    expect(clientRung(false, hours(NO_REFUND_SECONDS) - 1)).toBe('last_hours');
    expect(clientRung(false, hours(NO_REFUND_SECONDS))).toBe('last_hours');
    expect(clientRung(false, hours(NO_REFUND_SECONDS) + 1)).toBe('late');
    expect(clientRung(false, hours(HALF_REFUND_SECONDS))).toBe('late');
    expect(clientRung(false, hours(HALF_REFUND_SECONDS) + 1)).toBe('none');
    // Arrival reaches the top rung whatever the clock says, on both sides.
    expect(clientRung(true, 999)).toBe('on_arrival');
    // A job already past its start with nobody having arrived is the
    // twelve-hour rung, which is where a negative hoursOut lands.
    expect(clientRung(false, -3)).toBe('last_hours');
  });

  it('charges the same number of cents on every rung', () => {
    const pairs = [
      ['late', 'cancelled_late'],
      ['last_hours', 'cancelled_last_hours'],
      ['on_arrival', 'cancelled_on_arrival'],
    ] as const;
    // 0 is a free job, 1000 is the case where the floor would exceed the job,
    // 1500 sits on the floor, and the rest are ordinary prices.
    for (const cents of [0, 1000, 1500, 1999, 6500, 12000, 90000]) {
      for (const [rung, reason] of pairs) {
        expect(clientFee(cents, rung), `${cents} on ${rung}`)
          .toBe(leadFeeCents(cents, reason));
      }
    }
    // 'none' is the panel's word for a cancellation with no fee. The Worker
    // says that by returning no reason at all, so there is nothing to compare
    // it against except zero.
    expect(clientFee(6500, 'none')).toBe(0);
  });

  it('is built from the same three percentages and the same floor', () => {
    expect(exportedNumber(panel, 'LEAD_FEE_MIN_CENTS')).toBe(LEAD_FEE_MIN_CENTS);
    const percents = panel.match(/late: (\d+), last_hours: (\d+), on_arrival: (\d+)/);
    expect(percents, 'FEE_PERCENT is no longer written where this test reads it')
      .not.toBeNull();
    expect(Number(percents![1])).toBe(LEAD_FEE_LATE_PERCENT);
    expect(Number(percents![2])).toBe(LEAD_FEE_LAST_HOURS_PERCENT);
    expect(Number(percents![3])).toBe(LEAD_FEE_DOORSTEP_PERCENT);
  });
});

// ---------------------------------------------------------------------------
// 7. The map both maps are drawn on
// ---------------------------------------------------------------------------

describe('the tile host in the CSP is the tile host the app asks for', () => {
  it('names one style URL, and it is the one src/lib/headers.ts allows', async () => {
    const { MAP_STYLE } = await import('../web/src/lib/map');
    const { SECURITY_HEADERS } = await import('../src/lib/headers');
    const host = new URL(MAP_STYLE).origin;
    const csp = SECURITY_HEADERS['content-security-policy']!;
    // The style JSON, the vector tiles and the glyphs are fetches; the sprite
    // sheet is an image. A host allowed in only one of the two directives is
    // the usual way to ship a map that renders roads and no labels.
    expect(csp).toContain(`connect-src 'self' ${host}`);
    expect(csp).toContain(`img-src 'self' data: blob: ${host}`);
  });

  it('names no third-party host at all for the fonts or the map library', async () => {
    const { SECURITY_HEADERS } = await import('../src/lib/headers');
    const csp = SECURITY_HEADERS['content-security-policy']!;

    // THIS TEST USED TO SAY SOMETHING NARROWER AND IT IS WORTH SAYING WHY.
    //
    // It checked that the two Google font hosts stayed OUT of connect-src, and
    // that web/index.html preconnected to neither — because Chromium checks a
    // preconnect against connect-src, so the hints that used to be in that head
    // were a reported violation on every page load. Both halves of that are
    // still true and neither is interesting any more: those hosts are not in
    // connect-src because they are not in the policy at all.
    //
    // The fonts are woff2 files in web/public/fonts and MapLibre is a bundled
    // dependency, so every one of these is now a host this site has no reason
    // to contact. A policy that still permitted them would not break anything,
    // which is exactly why nobody would notice — and a permitted host is where
    // the next accidental third-party request goes.
    for (const host of ['unpkg.com', 'fonts.googleapis.com', 'fonts.gstatic.com']) {
      expect(csp, `${host} is still allowed somewhere in the policy`).not.toContain(host);
    }
    // The three directives those hosts used to sit in, each now 'self' plus
    // only what is genuinely somebody else's service.
    expect(csp).toContain(`script-src 'self' https://challenges.cloudflare.com`);
    expect(csp).toContain(`style-src 'self' 'unsafe-inline'`);
    expect(csp).toContain(`font-src 'self'`);
  });

  it('loads nothing from anybody else out of the SPA shell', () => {
    const shell = clientSource('web/index.html');
    // Tags only, not the file's prose: the comment in that head explains at
    // length what used to be loaded from unpkg and from Google and why it no
    // longer is, and a bare substring search would read that explanation as
    // the problem. What must not come back is a tag that FETCHES from one.
    const tags = [...shell.matchAll(/<(?:link|script|img|iframe)\b[^>]*>/g)].map((m) => m[0]);
    for (const tag of tags) {
      expect(tag, 'the SPA shell is fetching from a third party again')
        .not.toMatch(/unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com/);
      // The two attributes that only ever existed to make a third-party fetch
      // safe or fast. Their absence from every tag is the shape of the fix:
      // nothing is pinned by hash, and nothing is worth a handshake in advance,
      // because nothing in this head comes from a host we do not control.
      // Checked per tag rather than across the file, because the comment above
      // those tags explains at length what integrity= was for.
      expect(tag).not.toContain('integrity=');
      expect(tag).not.toContain('rel="preconnect"');
    }
  });
});

// ---------------------------------------------------------------------------
// 7b. The library the maps are drawn WITH, and the files the text is set in
// ---------------------------------------------------------------------------

describe('MapLibre is a bundled dependency and stays out of the common chunk', () => {
  it('is pinned to one exact version, with no range on it', () => {
    const pkg = JSON.parse(clientSource('web/package.json')) as {
      dependencies: Record<string, string>;
    };
    const pinned = pkg.dependencies['maplibre-gl'];
    // It used to be pinned in a URL — twice, plus an SRI hash beside each —
    // and the note in that head warned that moving one without the others was
    // a map that silently never drew. It is pinned in one place now, and a ^
    // or a ~ here would put it back to being whatever npm felt like that day.
    expect(pinned, 'maplibre-gl is no longer a dependency of the web app').toBeTruthy();
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is reached by a dynamic import, so only a page with a map pays for it', () => {
    const map = clientSource('web/src/lib/map.ts');
    // A STATIC import here would be a silent, total regression. CityMap.tsx is
    // reached from App.tsx by a plain import, so anything this module imports
    // statically lands in the entry chunk — which would put 800 kB of map
    // library back on the front page, every cost guide and the terms of
    // service, the exact bill the CDN script tag used to run up.
    expect(map).toContain(`import('maplibre-gl')`);
    expect(map).not.toMatch(/^import .* from 'maplibre-gl'/m);
    // The stylesheet travels with it, in the same async pair, for the same
    // reason: imported anywhere the entry chunk reaches, it would be inlined
    // into the render-blocking CSS of every page instead.
    expect(map).toContain(`import('maplibre-gl/dist/maplibre-gl.css')`);
  });

  it('is excluded from the vendor chunk every page downloads', () => {
    // `vendor` is a static import of the entry chunk because React is in it,
    // so a rule that sweeps all of node_modules into it would undo the line
    // above without touching it. This exception keeps the dynamic import
    // actually dynamic.
    expect(clientSource('web/vite.config.ts')).toContain('/node_modules/maplibre-gl/');
  });
});

describe('the webfonts are files in this repository', () => {
  it('has every woff2 the stylesheet names, and swaps rather than blocks', () => {
    const css = clientSource('web/src/styles.css');
    const named = [...css.matchAll(/url\('\/fonts\/([^']+\.woff2)'\)/g)].map((m) => m[1]!);
    // Thirteen: Inter at 400/500/600/700/800 in latin and latin-ext, IBM Plex
    // Mono at 500/600 in latin, Saira Stencil One at 400 in latin. Those are
    // the weights the fonts.googleapis.com URL used to request and the ones
    // this stylesheet's own rules resolve to — see the comment above them.
    expect(named.length).toBe(13);
    for (const file of named) {
      // Reading it is the test: a rule pointing at a file that is not in
      // web/public/fonts is a face that silently falls back to the system one
      // on a live page, and nothing else in the build would say so.
      expect(() => clientSource(`web/public/fonts/${file}`), `${file} is missing`).not.toThrow();
    }
    expect((css.match(/font-display: swap;/g) ?? []).length).toBe(13);
  });

  it("ships each family's licence beside the files, as the OFL asks", () => {
    // We are the ones handing these fonts out now, which is the whole reason
    // these three files exist: while Google served them, no condition in the
    // OFL was triggered by anything in this repository.
    for (const name of ['OFL-Inter.txt', 'OFL-IBM-Plex-Mono.txt', 'OFL-Saira-Stencil-One.txt']) {
      const text = clientSource(`web/public/fonts/${name}`);
      expect(text, `${name} is not the OFL`).toContain('SIL OPEN FONT LICENSE Version 1.1');
      expect(text).toContain('Copyright');
    }
  });
});

// ---------------------------------------------------------------------------
// 8. What the privacy page promises about how long things are kept
// ---------------------------------------------------------------------------

describe('the retention table on /privacy', () => {
  const page = clientSource('web/src/pages/Privacy.tsx');

  it('names one row, with the right number of days, for every sweep', async () => {
    const { RETENTION } = await import('../src/lib/retention');
    // Compared as multisets rather than in order: the page groups the rows the
    // way a reader thinks about them — conversations, then the job, then the
    // alerts — and retention.ts declares them in the order the sweeps run. The
    // counts still have to match exactly, so a sweep whose window is changed
    // without the page, or a row on the page with no sweep behind it, fails
    // here. A published promise about how long a stranger's address is kept is
    // the last sentence that should be able to outlive its own constant.
    const rows = [...page.matchAll(/how_long: '(\d+) days?/g)].map((m) => Number(m[1]));
    const asc = (a: number, b: number) => a - b;
    expect([...rows].sort(asc)).toEqual(Object.values(RETENTION).sort(asc));
    expect(rows.length).toBe(Object.keys(RETENTION).length);
  });

  it('quotes the same excerpt length the feed actually stores', async () => {
    const { FEED_EXCERPT_CHARS } = await import('../src/lib/feed');
    // Notification rows outlive the conversation they came from, so how much
    // of a message they copy is a retention fact and is listed as one.
    expect(page).toContain(`the first ${FEED_EXCERPT_CHARS} characters of a message`);
  });

  it('quotes the position precision the Worker actually publishes', async () => {
    const { CUSTOMER_DECIMALS } = await import('../src/lib/track');
    // A degree of latitude is about 111 km, so three decimals is about 110 m.
    // Both /privacy and /safety print that figure at a customer, and it is a
    // claim about how closely a business can be followed.
    const metres = Math.round(111_000 / 10 ** CUSTOMER_DECIMALS / 10) * 10;
    for (const path of ['web/src/pages/Privacy.tsx', 'web/src/pages/Safety.tsx']) {
      expect(clientSource(path), path).toContain(`${metres} metres`);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. The footer at the bottom of both kinds of page
// ---------------------------------------------------------------------------

describe('the footer, drawn twice', () => {
  /**
   * Every entry SiteFooter.tsx carries, in order, as {label, to}.
   *
   * Read off the source rather than imported: SiteFooter is TSX compiled for
   * the browser. Only the two arrays are parsed, and a rename of either fails
   * here rather than silently comparing nothing.
   */
  function clientFooter(source: string, name: string) {
    const start = source.indexOf(`const ${name}`);
    expect(start, `${name} is no longer declared where this test looks`).toBeGreaterThan(-1);
    const end = source.indexOf('\n];', start);
    const region = source.slice(start, end);
    return [...region.matchAll(/\{ label: '([^']+)'(?:, to: '([^']+)')? \}/g)]
      .map((m) => ({ label: m[1]!, href: m[2] ?? null }));
  }

  function workerFooter(source: string, name: string) {
    const start = source.indexOf(`const ${name}`);
    expect(start, `${name} is no longer declared where this test looks`).toBeGreaterThan(-1);
    const end = source.indexOf('\n];', start);
    const region = source.slice(start, end);
    return [...region.matchAll(/\{ label: '([^']+)'(?:, href: '([^']+)')? \}/g)]
      .map((m) => ({ label: m[1]!, href: m[2] ?? null }));
  }

  const client = clientSource('web/src/components/SiteFooter.tsx');
  const worker = clientSource('src/lib/seo.ts');
  const header = clientSource('web/src/components/SiteHeader.tsx');

  it('offers the same links in the same columns', () => {
    // The server-rendered pages are the ones a crawler and a visitor with no
    // JavaScript get, and five entries here were still inert text after their
    // pages existed — About, Help centre, Safety, Terms and Privacy — while
    // "How Round The Way works for pros" pointed at /join, which is a different
    // page. A footer that disagrees with itself about where its own links go
    // is worse on the half that cannot run the app.
    expect(workerFooter(worker, 'FOOT_COLUMNS'))
      .toEqual(clientFooter(client, 'COLUMNS'));
  });

  it('offers the same way out of the page at the top of it', () => {
    // SiteHeader's own note says "Browse" is there for the visitor who landed
    // on a trade page from a search engine — and those pages are rendered by
    // seo.ts, where it was the one link missing. A nav that agrees everywhere
    // except on the pages search traffic actually lands on is the wrong nav in
    // the one place it counts.
    const open = worker.indexOf('<nav class="site-nav"');
    expect(open, 'the server nav has moved').toBeGreaterThan(-1);
    const block = worker.slice(open, worker.indexOf('</nav>', open));
    const nav = [...block.matchAll(/<a(?: class="solid")? href="([^"]+)">([^<]+)<\/a>/g)]
      .map((m) => ({ href: m[1]!, label: m[2]! }));
    expect(nav.map((l) => l.href))
      .toEqual(['/browse', '/cost', '/a', '/account', '/signin', '/join']);
    for (const { href, label } of nav) {
      expect(header, `${label} -> ${href}`)
        .toMatch(new RegExp(`<Link to="${href}"[^>]*>[\\s\\S]{0,200}?${label}`));
    }
  });

  it('puts the legal links at the foot of the Support column, on both', () => {
    // They used to sit in a line of their own under the columns. The
    // reference marketplace keeps Terms of Use, Privacy Policy and CA Notice
    // at Collection at the bottom of its Support column, and both footers
    // were rebuilt to that shape — so this now checks they are IN the column
    // rather than out of it, and that the bottom line under the columns is
    // the copyright and nothing else.
    const legal = workerFooter(worker, 'FOOT_LEGAL');
    expect(legal.map((l) => l.label)).toEqual(
      ['Terms of service', 'Privacy policy', 'Notice at Collection']);

    const cols = workerFooter(worker, 'FOOT_COLUMNS');
    for (const l of legal) {
      expect(cols, `${l.label} is missing from the Worker's columns`)
        .toContainEqual({ label: l.label, href: l.href });
    }

    // The bottom line carries the copyright only — no second copy of these.
    expect(client).not.toContain('<Link to="/terms">Terms of service</Link>');
    expect(worker).not.toContain('FOOT_LEGAL.map(');
  });

  /**
   * The three legal sentences under the columns, as plain text.
   *
   * One side is JSX and the other is an HTML template literal, so neither the
   * tags nor the line wrapping can be compared — only the words. `{' '}` is
   * JSX's way of writing a space that survives formatting and becomes one; the
   * rest is tags, and all of it goes.
   */
  const plain = (markup: string) => markup
    .replace(/\{' '\}/g, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const paragraphs = (region: string) =>
    [...region.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => plain(m[1]!));

  const hrefs = (region: string) =>
    [...region.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);

  /** The block itself, sliced out of each file. */
  function legalBlock(source: string, from: string, to: string) {
    const start = source.indexOf(from);
    expect(start, `the legal block no longer starts with: ${from}`).toBeGreaterThan(-1);
    const end = source.indexOf(to, start);
    expect(end, `the legal block no longer ends before: ${to}`).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it('says the same three legal sentences at the bottom, word for word', () => {
    // WHAT WAS PINNED BEFORE THIS TEST: the links, and only the links. Both
    // footers could carry the same six columns and still say different things
    // in the small print under them, which is where the sentences that are
    // not decoration live.
    //
    // Both files say so themselves. SiteFooter.tsx: "Verbatim, and not to be
    // reworded ... seo.ts draws the same three lines ... change one and change
    // the other in the same commit." seo.ts: "THE ATTRIBUTION AND TRADEMARK
    // LINES BELOW ARE SiteFooter.tsx's, WORD FOR WORD." Two comments asking a
    // future reader to remember is not a mechanism, and the server-rendered
    // half is the half nobody looks at.
    //
    // The first line is a CONDITION of the OpenStreetMap and GeoNames licences
    // the map is built on, the second says who owns the names the vehicle
    // picker prints, and the third is the promise the whole product rests on.
    // A licence credit that is correct on the React page and reworded on the
    // crawled one is not a credit that has been given.
    const clientLegal = legalBlock(
      client, '<div className="site-foot-legal">', '{/*');
    const workerLegal = legalBlock(
      worker, '<p>Map data', '<p class="foot-fine"');

    const said = paragraphs(clientLegal);
    expect(said.length, 'SiteFooter no longer has exactly three legal lines').toBe(3);
    // Guards the comparison itself: three empty strings are also equal.
    for (const line of said) expect(line.length).toBeGreaterThan(40);

    expect(paragraphs(workerLegal)).toEqual(said);

    // AND THE TWO LINKS, which are part of the credit rather than decoration
    // on it — the OSMF asks that the credit point at openstreetmap.org/
    // copyright and CC BY 4.0 asks the same of the licence, both wherever the
    // medium allows a link. `plain` deletes the anchors to compare the words,
    // so without this an href dropped on one side would pass.
    expect(hrefs(workerLegal)).toEqual(hrefs(clientLegal));
    expect(hrefs(clientLegal)).toEqual([
      'https://www.openstreetmap.org/copyright',
      'https://creativecommons.org/licenses/by/4.0/',
    ]);
  });

  it('reaches every one of those pages on a server-rendered page', async () => {
    const { browseIndexPage } = await import('../src/lib/seo');
    const { ALL_MIGRATIONS, makeEnv } = await import('./d1');
    // The browse hub is built from the compiled-in catalogue, so it renders on
    // an empty database and the footer under it is the same footer every
    // server-rendered page gets.
    const page = await browseIndexPage(makeEnv(ALL_MIGRATIONS) as never);
    // The assertion the two above cannot make: that the hrefs survive
    // rendering rather than only sitting in an array.
    for (const href of ['/about', '/help', '/safety', '/covered', '/pros',
      '/terms', '/privacy']) {
      expect(page, href).toContain(`href="${href}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// 10. The written cost-factor table, which is on both cost guides
// ---------------------------------------------------------------------------

describe('what drives the bill in each trade, written down twice', () => {
  /**
   * The body of TRADE_COSTS as it appears in a file, from the opening brace to
   * the closing one.
   *
   * WHY THIS IS COMPARED AS SOURCE TEXT RATHER THAN AS TWO IMPORTED OBJECTS.
   * src/lib/costfacts.ts is a Worker module and the copy it was lifted from
   * lives inside a .tsx page compiled for the browser, which this suite cannot
   * import. The table is several thousand words of prose across some forty
   * trades, printed under "what X prices depend on" on both halves of
   * /cost/<trade> — so a paragraph edited on one side would be invisible to
   * anybody reading either page on its own, and would show up only as the page
   * rewriting itself when React mounted.
   *
   * The right fix is one module both builds import; web/tsconfig.json compiles
   * web/src alone, so until that is widened the duplication is deliberate and
   * this is the pin that keeps it honest.
   */
  function costTable(source: string): string {
    const start = source.indexOf('TRADE_COSTS: Record<string, TradeCosts> = {');
    expect(start, 'TRADE_COSTS is no longer declared where this test looks')
      .toBeGreaterThan(-1);
    const end = source.indexOf('\n};', start);
    expect(end, 'the end of TRADE_COSTS has moved').toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it('is the same table in the Worker module and in the React page', () => {
    const worker = costTable(clientSource('src/lib/costfacts.ts'));
    const client = costTable(clientSource('web/src/pages/CostGuide.tsx'));
    expect(worker).toBe(client);
    // Guards the comparison itself: two empty strings are also equal, and this
    // table is the length of a short book.
    expect(worker.length).toBeGreaterThan(20_000);
  });

  it('carries no figure of any kind, on either side', async () => {
    const { TRADE_COSTS } = await import('../src/lib/costfacts');
    // The rule written over the table, enforced rather than trusted. Every
    // number on a cost guide is counted off the listings in that request; a
    // written one here would sit two sections below those, in the same
    // typeface, with nothing to tell a reader which is which.
    const prose = Object.values(TRADE_COSTS).flatMap((c) => [
      ...c.factors.flatMap((f) => [f.h, f.p]),
      ...(c.diy ? [c.diy.yourself, c.diy.pro] : []),
      ...(c.saving ?? []),
    ]);
    expect(prose.length).toBeGreaterThan(100);
    for (const line of prose) {
      expect(line, line).not.toMatch(/\d/);
      expect(line.toLowerCase(), line).not.toContain('%');
    }
  });
});

// ---------------------------------------------------------------------------
// 11. How long a job takes, said in two places
// ---------------------------------------------------------------------------

describe('a duration, in the app and on the server-rendered page', () => {
  it('never carries sixty minutes past the hour', async () => {
    const { durationLabel } = await import('../web/src/api');
    // The classic rounding bug, and the one OnlineSwitch's own comment names:
    // taking the hours off first and then rounding what is left made 3,599
    // seconds "60m" and 7,199 "1h 60m". Service durations are whole seconds an
    // operator types into a form, so neither value is hypothetical.
    for (let s = 0; s <= 4 * 3600; s += 1) {
      const label = durationLabel(s);
      expect(label, `${s}s`).not.toMatch(/\b60m\b/);
    }
    expect(durationLabel(7199)).toBe('2h');
    expect(durationLabel(3599)).toBe('1h');
    // The ordinary cases are unchanged.
    expect(durationLabel(5400)).toBe('1h 30m');
    expect(durationLabel(1800)).toBe('30m');
    expect(durationLabel(3600)).toBe('1h');
  });

  it('says the same length as the server page does, in its own register', async () => {
    const { durationLabel } = await import('../web/src/api');
    // seo.ts keeps its formatter unexported, so it is lifted out of the source
    // and run here. The two are deliberately NOT the same string — "1h 30m" is
    // read off a dashboard at a glance, "1 hr 30 min" is read inside a
    // sentence, and api.ts says so — but they describe the same job, and a
    // reader who opens the cost guide and then the checkout can catch out any
    // pair that does not.
    const serverDuration = liftFunction<(minutes: number) => string>(
      clientSource('src/lib/seo.ts'),
      'function duration(minutes: number): string {',
      '`${h} hr ${m} min`;\n}',
      'duration');

    const minutesOf = (label: string) =>
      Number(label.match(/(\d+)\s*h(?:r)?/)?.[1] ?? 0) * 60
      + Number(label.match(/(\d+)\s*m(?:in)?\b/)?.[1] ?? 0);

    for (let s = 60; s <= 6 * 3600; s += 60) {
      const mins = s / 60;
      expect(minutesOf(durationLabel(s)), `${mins} min`).toBe(mins);
      expect(minutesOf(serverDuration(mins)), `${mins} min server`).toBe(mins);
    }
  });
});

// ---------------------------------------------------------------------------
// The name on the front of the building
// ---------------------------------------------------------------------------

describe('the wordmark, written in three places', () => {
  it('is spelled the same in the header, the footer and the server twin', () => {
    // This drifted once already. The site was renamed from Slotfill and every
    // CAPITALISED "Roundtheway" was swapped to "Round The Way" — but the two
    // wordmarks are lowercase in the markup, so the header and both footers
    // kept saying "roundtheway" while every sentence around them said the new
    // name. It was live that way, and it was only caught by loading the page.
    //
    // A brand name is exactly the kind of fact that is written out once per
    // tree and changed one tree at a time, so it is pinned here with the rest.
    const NAME = 'Round The Way';

    const header = clientSource('web/src/components/SiteHeader.tsx');
    const footer = clientSource('web/src/components/SiteFooter.tsx');
    const server = clientSource('src/lib/seo.ts');

    expect(header).toContain(`className="wordmark">${NAME}</Link>`);
    expect(footer).toContain(`<span className="foot-mark">${NAME}</span>`);
    expect(server).toContain(`<span class="foot-mark">${NAME}</span>`);

    // And nowhere still says the run-together form where a person reads it.
    // The domain, the storage keys and the Worker's own name legitimately do,
    // so this only looks at the wordmark markup itself.
    for (const [where, src] of [['header', header], ['footer', footer]] as const) {
      expect(src, where).not.toContain('>roundtheway<');
      expect(src, where).not.toContain('/>roundtheway<');
    }
  });

  /*
    THE FOURTH PLACE, AND THE ONE THE RENAME ABOVE MISSED.

    web/public/manifest.webmanifest said "Roundtheway" in both `name` and
    `short_name` long after every other surface had been renamed, and those two
    fields are read by a person: they are the label under the icon on a home
    screen and the name in the browser's own install prompt. They are read by a
    search engine too — a manifest `name` is one of the places a site name is
    taken from, alongside the WebSite node's `name` and og:site_name, both of
    which say "Round The Way" — so the disagreement was the document whose
    whole job is to name the brand naming it differently from everything else.

    It is pinned here rather than left to be noticed, because a JSON file
    carries no comment to explain itself and is the least likely file in the
    repository to be opened during a rename.
  */
  it('is spelled the same in the web app manifest', () => {
    const manifest = JSON.parse(clientSource('web/public/manifest.webmanifest')) as {
      name: string; short_name: string;
    };
    expect(manifest.name).toBe('Round The Way');
    expect(manifest.short_name).toBe('Round The Way');
  });
});

// ---------------------------------------------------------------------------
// The testing cap, said in three places
// ---------------------------------------------------------------------------

describe('the daily intake cap', () => {
  it('is the same number in the band, the server twin, and the code that refuses', () => {
    // THE CAP IS A PROMISE, AND THE WORKER IS WHAT KEEPS IT.
    //
    // Two banners quote a number and one constant enforces it. Change the
    // constant alone and the site advertises places it will not give; change a
    // banner alone and it turns people away it would have let in. Neither
    // failure is visible from the page that got it wrong, which is exactly the
    // shape of thing this file exists for.
    const worker = clientSource('src/index.ts');
    const limit = /const NEW_ACCOUNTS_PER_DAY = (\d+);/.exec(worker)?.[1];
    expect(limit, 'NEW_ACCOUNTS_PER_DAY').toBe('100');

    // Both banners say it in words rather than digits, so the pin is the word.
    // A cap of 250 would need the sentence rewritten anyway — which is the
    // point: this fails and makes somebody read it.
    //
    // ONE HUNDRED SHARED, not one hundred each. It was written as two buckets
    // first, which advertised two hundred emails a day out of an allowance of
    // one hundred — the site would have invited twice as many people as it
    // could send a code to, and the second half of them would have watched a
    // page say "check your email" for a message that was never sent.
    const said = 'A hundred people can join each day';
    const flatten = (v: string) => v.replace(/\s+/g, ' ');

    expect(flatten(clientSource('web/src/components/SiteHeader.tsx'))).toContain(said);
    expect(flatten(clientSource('src/lib/seo.ts'))).toContain(said);

    // And the sentence the Worker gives somebody it turns away names the same
    // two hundreds, so a person who hits the cap is told the rule they hit.
    // Matched short of the line break, because INTAKE_FULL is written as
    // concatenated literals and the join is not part of the sentence.
    expect(flatten(worker)).toContain('a hundred people can join each day');
  });
});

// ---------------------------------------------------------------------------
// What booking asks for, said once per tree
// ---------------------------------------------------------------------------

describe('the sentence about what an account takes', () => {
  it('is identical in the Worker and in the app', async () => {
    // IT DRIFTED, AND THE INDEXED HALF WAS THE WRONG ONE.
    //
    // Migration 0038 moved the sign-in code from a text message to an email.
    // PaymentState.tsx was updated and seo.ts was not, so /s/<trade> and
    // /cost/<trade> — which are rendered twice, once by the Worker for a
    // crawler and once here for a person — disagreed about what booking asks
    // for. The Worker's copy is the one Google reads and it was the one still
    // promising a text message.
    //
    // public-payload.test.ts pins this constant against seo.ts's own FAQ
    // answer, which is a real check and is not this one: both halves of that
    // comparison live in the same file, so it stayed green through the whole
    // drift. This is the pair that actually spans the two trees.
    const { ACCOUNT_TODAY_SHORT: app } = await import('../web/src/components/PaymentState');
    const { ACCOUNT_TODAY_SHORT: worker } = await import('../src/lib/seo');
    expect(app).toBe(worker);
  });
});

// ---------------------------------------------------------------------------
// The days of the week, indexed the same way on both sides
// ---------------------------------------------------------------------------

/**
 * A list of strings declared as `const NAME = [ 'a', 'b' ] as const;`.
 *
 * Read off the source because the Worker's copy is unexported and the app's
 * lives in a .tsx compiled for the browser. A rename or a move fails here with
 * that as the message rather than as a comparison against nothing.
 */
function stringArray(source: string, name: string): string[] {
  const start = source.indexOf(`const ${name} = [`);
  expect(start, `${name} is no longer declared where this test looks`).toBeGreaterThan(-1);
  const end = source.indexOf('\n]', start);
  expect(end, `the end of ${name} has moved`).toBeGreaterThan(start);
  return [...source.slice(start, end).matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

describe('the weekday names', () => {
  it('are the same seven, in the same order, in both trees', () => {
    // THE ORDER IS THE FACT, not the spelling. `weekday` is stored as an
    // integer and SUNDAY IS 0 — both declarations say so in the same sentence
    // — so these arrays are indexed by a number that comes out of the
    // database. Rotate one of them to put Monday first, which is the obvious
    // and tempting edit for a European reader, and the operator's own
    // working-hours editor starts labelling every row with the day before it
    // while the public profile page goes on printing the right one. Nothing
    // errors; the hours are simply wrong on one of the two screens.
    const worker = stringArray(clientSource('src/lib/seo.ts'), 'DAY_NAMES');
    const app = stringArray(
      clientSource('web/src/components/WorkingHours.tsx'), 'DAY_NAMES');

    expect(worker).toEqual(app);
    // Guards the comparison itself: two empty lists are also equal.
    expect(worker.length).toBe(7);
    expect(worker[0]).toBe('Sunday');
  });
});

// ---------------------------------------------------------------------------
// What the alerts form lets somebody ask for
// ---------------------------------------------------------------------------

describe('the ceilings on a watch', () => {
  const worker = clientSource('src/lib/alerts.ts');
  const form = clientSource('web/src/pages/Watch.tsx');

  /**
   * Watch.tsx's own comment above these three is "The Worker stores at most
   * five trades and a sixty-character label" — a claim about another file,
   * made in a comment, with nothing checking it. This is the check.
   *
   * Each of the three fails differently and none of them fails loudly:
   *
   *  - MAX_TRADES is how many chips the form will let somebody tick. Too high
   *    and the extra trades are accepted by the page, dropped by the Worker's
   *    slice(), and never alerted on — a watch that silently covers less than
   *    it says it does.
   *  - MAX_LABEL_CHARS is the maxLength on the label input. Too high and the
   *    label is truncated on the way in, so the name somebody typed for their
   *    own watch comes back cut off.
   *  - MAX_EMAIL_CHARS is the maxLength on the address. This is the worst of
   *    the three: an address the form accepts and the Worker refuses is a
   *    person who fills the form in, is told nothing useful, and never gets an
   *    alert.
   */
  it('agrees on how many trades one watch may name', () => {
    expect(exportedNumber(form, 'MAX_TRADES')).toBe(exportedNumber(worker, 'MAX_TRADES'));
  });

  it('agrees on how long the label may be', () => {
    expect(exportedNumber(form, 'MAX_LABEL_CHARS'))
      .toBe(exportedNumber(worker, 'MAX_LABEL_CHARS'));
  });

  it('agrees on how long an email address may be', () => {
    expect(exportedNumber(form, 'MAX_EMAIL_CHARS'))
      .toBe(exportedNumber(worker, 'MAX_EMAIL_CHARS'));
    // 254 is the longest address RFC 5321 allows in a MAIL FROM path, which is
    // the reason the number is what it is on both sides rather than a
    // preference either side could restate.
    expect(exportedNumber(worker, 'MAX_EMAIL_CHARS')).toBe(254);
  });
});

// ---------------------------------------------------------------------------
// How much a basket holds
// ---------------------------------------------------------------------------

describe('the size of an order', () => {
  const worker = clientSource('src/lib/orders.ts');
  const book = clientSource('web/src/pages/Book.tsx');

  it('agrees on how many openings go in one basket', () => {
    // Book.tsx says "Openings the Worker will take in one order. Its own limit
    // is the same" — again, a claim about another file with nothing behind it.
    //
    // This one has a sentence hanging off it as well. too_many_items reads "A
    // basket holds up to ${MAX_ITEMS} openings", so a drift here does not just
    // let somebody build a basket the Worker refuses: it prints a number the
    // Worker disagrees with in the very message explaining the refusal, and
    // the Worker's own error says a different one.
    expect(exportedNumber(book, 'MAX_ITEMS')).toBe(exportedNumber(worker, 'MAX_ITEMS'));
  });

  it('agrees on how many services go on one opening', () => {
    // Named differently on the two sides — MAX_SERVICES in the page,
    // MAX_SERVICES_PER_ITEM in the Worker — which is part of why nothing
    // connected them. Both are sliced against silently, so the page letting
    // somebody tick an eleventh service means an appointment booked without
    // the work they asked for and without being told.
    expect(exportedNumber(book, 'MAX_SERVICES'))
      .toBe(exportedNumber(worker, 'MAX_SERVICES_PER_ITEM'));
  });
});

// ---------------------------------------------------------------------------
// The length of the code that is emailed
// ---------------------------------------------------------------------------

describe('the sign-in code', () => {
  it('is as many digits as the Worker mints', async () => {
    const { CUSTOMER_AUTH } = await import('../src/lib/customers');
    const app = exportedNumber(
      clientSource('web/src/components/CodeSignIn.tsx'), 'CODE_DIGITS');

    // CodeSignIn's comment says "Its own CODE_DIGITS is the same number", and
    // its own note explains why the app needs the figure at all: the input's
    // maxLength, the sentence "We sent a 6-digit code by email", and — the
    // reason it is exported — the checkout's Book button, which enables itself
    // when this many digits have been typed.
    //
    // So the app's copy being one too LOW is a button that submits a code the
    // Worker cannot match, and one too HIGH is a button that never enables at
    // all: a customer who has typed the whole code correctly, watching a
    // disabled button, with nothing on screen to explain it. Neither shows up
    // anywhere except at the last step of paying.
    expect(app).toBe(CUSTOMER_AUTH.CODE_DIGITS);
    expect(app).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// What a sample listing offers instead of a Book button
// ---------------------------------------------------------------------------

describe('the action on a sample listing', () => {
  it('is the same three words on the card, the server twin and the page it leads to', () => {
    // A SAMPLE LISTING IS NOT OFFERED FOR BOOKING, AND ALL THREE HAVE TO AGREE
    // ON WHAT IT IS OFFERED FOR INSTEAD.
    //
    // Every seeded business in demo.ts used to carry the same Book button as a
    // real opening. It went into the checkout, let the visitor tick services,
    // and refused at the pricing step with `sample_listing` — and before the
    // first real operator signs up those are most of the openings there are, so
    // it was the front door of the product: choose, type, be refused.
    //
    // The same listing is drawn three times by two trees that cannot import
    // each other: the React card, the Worker's server-rendered twin of it for a
    // crawler, and the confirmation the reader lands on. Change the phrase in
    // one and a person who meets two of them thinks they are looking at two
    // different links — which is exactly what the badge-versus-button mismatch
    // did before, on the one card a first-time visitor was most likely to press.
    const card = clientSource('web/src/components/SlotCard.tsx');
    const server = clientSource('src/lib/seo.ts');
    const book = clientSource('web/src/pages/Book.tsx');
    const flatten = (v: string) => v.replace(/\s+/g, ' ');

    const SAID = 'See their page';
    expect(card).toContain(`<span className="slot-go">${SAID}</span>`);
    expect(server).toContain(`">${SAID}</a>`);
    expect(flatten(book)).toContain(`> ${SAID} </Link>`);

    // And all of them send it to the same place, which is the one destination
    // that is honestly there for a business that does not exist: its own page,
    // whose first paragraph says the same thing at greater length.
    /* eslint-disable no-template-curly-in-string */
    expect(card).toContain('`/p/${s.profile_slug}`');
    expect(server).toContain('<a class="book" href="/p/${escapeHtml(s.profile_slug)}">');
    expect(book).toContain('`/p/${menu.profileSlug}`');
    /* eslint-enable no-template-curly-in-string */

    // The word on a REAL listing is deliberately NOT pinned to a single form:
    // the card shows a "Book" pill and the server-rendered twin a "See this
    // opening" link, because one is a button on a card and the other is the
    // most prominent link on an indexed page. Only the sample's action is the
    // same sentence twice, so only it is pinned here.
    expect(card).toContain('<span className="slot-go">Book</span>');
    expect(server).toContain('>See this opening</a>');
  });
});

// ---------------------------------------------------------------------------
// 12. Why nobody can be offered a slot
// ---------------------------------------------------------------------------

describe('the reason an opening has nobody to offer it to', () => {
  it('is the same sentence from the Worker and from the screen', async () => {
    // The operator can reach this fact by two routes. The page asks for
    // candidates, gets none and draws its empty state out of its own bundle;
    // or they press Send and the Worker answers with `reason`, which the same
    // page prints in the error box. Two wordings would be two explanations of
    // one thing, and this is the explanation that has been wrong before: it
    // used to say clients need a mobile number and SMS consent, which is
    // advice that cannot be followed — a customer this site introduces is
    // stored with no number on purpose — for a channel that does not exist.
    const { NOBODY_TO_OFFER } = await import('../src/lib/rank');
    const client = exportedString(
      clientSource('web/src/pages/FillSlot.tsx'), 'NOBODY_TO_OFFER');
    expect(client).toBe(NOBODY_TO_OFFER);

    // Guards the comparison itself: two empty strings are also equal. And
    // guards the failure that made this pair worth pinning — the sentence must
    // not go back to promising anything about phones or texts.
    expect(NOBODY_TO_OFFER.length).toBeGreaterThan(120);
    expect(NOBODY_TO_OFFER).not.toMatch(/SMS|mobile number|text message/i);
  });
});

// ---------------------------------------------------------------------------
// 13. The tile art
// ---------------------------------------------------------------------------

describe('the tile drawings, on the same rows in both trees', () => {
  /*
    THE PATH ITSELF IS NOT PINNED HERE, AND THAT IS THE WHOLE POINT.

    Everything else in this file is a fact written down twice on purpose,
    compared so it cannot drift. The image paths are the one duplicated fact
    that got DELETED instead: `tradeArt` and `categoryArt` in src/lib/seo.ts
    compute them once, the server-rendered pages call those functions, and the
    React pages read the answer off the catalogue payload the Worker already
    serves them. There is no second copy to compare, which is a better
    guarantee than any assertion in this file — see the note over `tradeArt`.

    What IS still duplicated is the pair of numbers on every one of these <img>
    elements, and those cannot travel on the payload: they are attributes the
    markup has to carry before the file arrives, which is the entire reason
    they exist. A disagreement would reserve a box of the wrong shape and
    reintroduce the reflow the attributes are there to prevent. So the sizes
    are pinned, and so is the fact that both trees put a picture on the same
    rows at all — a picture in one tree and a bare row in the other is the
    drift this file exists for.
  */
  const tile = clientSource('web/src/components/TileArt.tsx');

  it('reserves the same box in the app as the Worker writes into the markup', async () => {
    const {
      TRADE_ART_W: tw, TRADE_ART_H: th,
      CATEGORY_ART_W: cw, CATEGORY_ART_H: ch,
    } = await import('../src/lib/seo');
    expect(exportedNumber(tile, 'TRADE_ART_W')).toBe(tw);
    expect(exportedNumber(tile, 'TRADE_ART_H')).toBe(th);
    expect(exportedNumber(tile, 'CATEGORY_ART_W')).toBe(cw);
    expect(exportedNumber(tile, 'CATEGORY_ART_H')).toBe(ch);
    // Guards the comparison: four zeroes are also equal, and an <img> with
    // width="0" is not a reserved box. Both are SQUARE, which is the shape the
    // files are stored in — the tiles crop them to 225x290 and a category
    // header crops the same file to a band, so the stored picture is the one
    // shape that survives both.
    expect(tw).toBe(th);
    expect(cw).toBe(ch);
    expect(tw).toBeGreaterThanOrEqual(450);
    expect(cw).toBeGreaterThanOrEqual(450);
  });

  it('marks the drawing decorative on both sides, and never describes it', () => {
    // The tile already carries its trade's name as text inside the same link,
    // so an alt describing the picture is that name read out twice. Empty and
    // not absent: with no alt at all a screen reader reads the file name.
    const worker = clientSource('src/lib/seo.ts');
    expect(tile).toContain('alt=""');
    expect(worker).toContain('<img class="link-art" src="${escapeHtml(i.img)}" alt=""');
    expect(worker).toContain('<img class="banner-art" src="${escapeHtml(categoryArt(here.key))}" alt=""');
    // Nothing anywhere may put words in an alt on one of these: that is how
    // the same name ends up spoken twice on forty rows.
    expect(tile).not.toMatch(/alt=\{/);
  });

  it('puts a picture on the trade rows of both browse pages, in both trees', async () => {
    const { ALL_MIGRATIONS, makeEnv } = await import('./d1');
    const { browseIndexPage, categoryPage, tradeArt } = await import('../src/lib/seo');
    const env = makeEnv(ALL_MIGRATIONS) as never;

    // The server-rendered halves. Both are built from the compiled-in
    // catalogue, so they render on an empty database.
    const browse = await browseIndexPage(env);
    const category = (await categoryPage(env, 'auto'))!;
    for (const t of TRADE_CATEGORIES.flatMap((c) => c.trades)) {
      expect(browse, t.slug).toContain(`src="${tradeArt(t.slug)}"`);
    }
    expect(category).toContain(`src="${tradeArt('mobile car wash and detailing')}"`);
    expect(category).toContain('class="banner-art"');

    // And the React halves, which read `art` off the payload rather than
    // building a path — so what is checked is that they render the field at
    // all. A row that dropped its <img> would pass every other test here.
    expect(clientSource('web/src/pages/BrowseIndex.tsx'))
      .toContain('<TradeArt className="ix-row-art" src={t.art} />');
    const cat = clientSource('web/src/pages/Category.tsx');
    expect(cat).toContain('<TradeArt className="cat-row-art" src={t.art} />');
    expect(cat).toContain('src={here.art}');
  });

  it('lazy-loads every one of them except the banner above the fold', () => {
    // A browse page shows three or four rows at a time out of thirty-nine, and
    // the front page's tile grid sits under a full-height hero. The one
    // exception is the category banner, which is the first thing under the
    // crumb trail and would otherwise be watched fading in.
    const worker = clientSource('src/lib/seo.ts');
    expect(worker).toContain('loading="lazy" decoding="async">');
    expect(worker).toContain('<img class="banner-art"');
    expect(worker).not.toMatch(/class="banner-art"[\s\S]{0,200}loading="lazy"/);
    expect(tile).toContain("loading={eager ? 'eager' : 'lazy'}");
  });
});
