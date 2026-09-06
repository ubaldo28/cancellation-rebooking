import { describe, expect, it } from 'vitest';
import {
  clientSource, exportedNumber, exportedString, liftFunction,
} from './client-source';
import { ZERO_DECIMAL, formatMoney } from '../src/lib/countries';
import { REDACTION_NOTICE } from '../src/lib/redact';
import { tradeSlug } from '../src/lib/seo';
import { MAX_MESSAGE_CHARS } from '../src/lib/chat';
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

  it('leaves both font hosts out of connect-src, and preconnects to neither', async () => {
    const { SECURITY_HEADERS } = await import('../src/lib/headers');
    const csp = SECURITY_HEADERS['content-security-policy']!;
    const connect = csp.split('; ').find((d) => d.startsWith('connect-src '))!;
    // Chromium checks a preconnect against connect-src. The two hints in the
    // page head were therefore a reported violation on every load, and the fix
    // was to drop them rather than to widen the one directive that decides
    // where injected script may send data.
    for (const host of ['fonts.googleapis.com', 'fonts.gstatic.com']) {
      expect(connect).not.toContain(host);
    }
    expect(clientSource('web/index.html')).not.toContain('<link rel="preconnect"');
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
    // "How Slotfill works for pros" pointed at /join, which is a different
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
    expect(nav.map((l) => l.href)).toEqual(['/browse', '/a', '/signin', '/join']);
    for (const { href, label } of nav) {
      expect(header, `${label} -> ${href}`)
        .toMatch(new RegExp(`<Link to="${href}"[^>]*>[\\s\\S]{0,200}?${label}`));
    }
  });

  it('puts the legal links in the line under it, on both', () => {
    const legal = workerFooter(worker, 'FOOT_LEGAL');
    expect(legal.map((l) => l.label)).toEqual(
      ['Terms of service', 'Privacy policy', 'Notice at Collection']);
    for (const l of legal) expect(client).toContain(`<Link to="${l.href}">${l.label}</Link>`);
    // And nowhere else: SiteFooter moved them out of the Support column, and a
    // footer carrying them twice is half legal boilerplate.
    expect(workerFooter(worker, 'FOOT_COLUMNS').some((l) => l.label === 'Terms')).toBe(false);
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
// 10. How long a job takes, said in two places
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
