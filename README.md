# Cancellation Rebooking

A scheduling app for small mobile businesses: car detailers, junk removal,
trash-can cleaning, pressure washing. They drive to every job, and they don't
have the margin to buy leads.

React dashboard on Cloudflare Pages, TypeScript API on Cloudflare Workers, D1
for storage.

**Live: [cancellation-rebooking.pages.dev](https://cancellation-rebooking.pages.dev)**

When a client cancels, the operator loses the slot and usually the revenue. The
obvious fix is a waitlist, and every booking platform already has one. That
works when customers come to you. These operators drive, so a waitlist hands
them a fill forty minutes off their route and the slot stays empty anyway.

This ranks who to offer the slot to by **how far out of the operator's way they
are**, using the jobs immediately before and after the gap as anchors.

A client who is six weeks overdue but forty minutes across town is a worse fill
than one who is barely due and three minutes off the route. That trade-off is
the product.

---

## Status

In active development. Both halves are built and deployed: the React operator
dashboard is live at the link above and the Worker API behind it is running.

- **114 tests passing**, run against a real SQLite instance executing the actual
  migrations and queries
- TypeScript `strict` with `noUncheckedIndexedAccess`, zero errors, on both the
  API and the dashboard
- Runs entirely within Cloudflare's free tier

```bash
npm install && npm test                # API, 114 tests
cd web && npm install && npm run dev    # dashboard on :5173
```

---

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Frontend | **React 18 + React Router 6, built with Vite** | Seven screens, real client-side state and routing. The operator uses this on a phone between jobs, in a van, so it had to be an app, not a page. |
| Styling | Plain CSS, one stylesheet | No Tailwind, no component library. Nothing here needed one. |
| API | Cloudflare Workers | Edge-deployed, no servers, generous free tier |
| Database | Cloudflare D1 (SQLite) | Same platform, no connection pooling to manage |
| Hosting | Cloudflare Pages | Dashboard and API on one deploy, same origin |
| Language | TypeScript, strict, both ends | |
| Tests | Vitest + `node:sqlite` | Real SQL execution, not mocks |

No ORM. The queries are the interesting part of the system, and hiding them
behind a query builder would have hidden the cost characteristics that turned
out to matter most (see *Cost engineering* below).

---

## The operator dashboard

`web/` is a React 18 single-page app, seven screens, all TypeScript:

| Screen | What it does |
| --- | --- |
| **Today** | The day's jobs and any gap the cron has detected |
| **FillSlot** | The core flow — ranked candidates for one gap, and the offer that goes out |
| **Schedule** | Working hours, time off, upcoming appointments |
| **Clients** | Recurring clients, their cadence, how overdue each one is |
| **Jobs** | Open leads: quoted work that never got booked |
| **Settings** | Country, timezone, currency, locale, messaging mode |
| **SignIn** | Passwordless — enter an email, get a link |

`src/api.ts` is a hand-written typed client for the Worker. Every route the
dashboard calls is typed against the same shapes the API returns, so a change to
a response is a compile error in the UI rather than `undefined` on a screen in
front of a customer.

Sign-up asks for country **and** timezone separately, with a note under the
field explaining why: several countries span more than one, and picking the
country alone would silently put an operator's whole calendar in the wrong hours.

---

## The problems worth reading about

### Two clients tap "accept" at the same instant

The offer link goes to several clients at once, so a race is guaranteed, not
theoretical. D1 has no interactive transactions, so this is enforced in the
schema:

```sql
CREATE UNIQUE INDEX idx_offers_one_accept ON gap_offers (gap_id)
  WHERE status = 'accepted';
```

A partial unique index makes a second accepted offer on the same gap
*impossible*. The accept path runs as a single `db.batch()` — one transaction —
so the loser's whole batch rolls back and they get "that slot just went" rather
than a double booking. Tested by firing both accepts and asserting exactly one
appointment exists.

### Scheduling across daylight saving

Working hours are wall-clock ("I work 9 to 5"); appointments are epoch seconds.
Converting between them with a fixed offset breaks twice a year. Every
conversion asks `Intl` for the real offset at the real instant:

```ts
export function fromLocal(tz, year, month, day, minuteOfDay): number {
  const naive = Date.UTC(year, month - 1, day) / 1000 + minuteOfDay * 60;
  let guess = naive - offsetSeconds(naive, tz);
  return naive - offsetSeconds(guess, tz);   // two passes settle every real zone
}
```

A test asserts that 09:00 on either side of a spring-forward boundary is
**47 hours apart, not 48**.

### Geocoding without an API bill or a ToS violation

Ranking needs coordinates for every client. The obvious free option — Nominatim's
public API — explicitly forbids this use: distributed scripts are banned (a
Worker is distributed by definition), it's capped at 1 request/second, and
commercial apps that depend on geocoding are told to run their own instance.

Instead, GeoNames postal-code centroids (CC BY 4.0, ~100 countries) load
straight into D1 as a table. Lookups are offline, free and unlimited. Postal
centroid precision is the right resolution here — ranking needs to know whether
someone is eight minutes away or forty, not which side of the road they park on.

### Cost engineering against a free tier

The cron re-detected gaps for every operator every 15 minutes, and the gap upsert
wrote a row whether or not anything had changed:

> **3,840 D1 row-writes per operator per day** against a 100,000/day ceiling.
> The entire free tier consumed by **26 operators**, before a single client is
> texted.

Fixed by giving operators a `calendar_version` that only increments when
something can actually move a gap, having the cron rescan only those, and adding
a `WHERE` clause to the upsert so no-op writes never fire.

**Ceiling: 26 → ~416 operators.** A test asserts a re-detect with no calendar
change writes nothing at all.

### Sending SMS for $0

US A2P 10DLC registration is paid and slow, so the product doesn't depend on it.
The default mode returns a prefilled `sms:` deep link that the operator taps on
their own phone — no carrier registration, no per-message cost, and the text
arrives from the number the client already recognises. Twilio is wired but
optional.

### Internationalisation that isn't just translation

Formatting was hardcoded to one locale, which meant every operator in every
country sent customers foreign-formatted dates. Now derived per operator, with a
test asserting the same instant renders *differently* across markets — if they
ever collapse to one, the locale is being ignored again and the suite fails.

Message language sits on the **client**, not the country: one operator's list
routinely mixes English and Spanish speakers, so a Spanish-speaking client of an
English-speaking operator gets Spanish words with US dates and dollars.

---

## Security

- Passwordless email sign-in; only SHA-256 hashes of tokens are stored
- Sign-in links are never returned in an HTTP response — echoing requires *both*
  a debug secret and a localhost `APP_URL`, because forgetting to unset a flag is
  how this class of hole reaches production
- Twilio webhooks verify HMAC-SHA1 signatures; without it, anyone could POST
  `Body=STOP` and opt a client out
- CORS is an origin allowlist, never a wildcard — wildcard plus credentials would
  let any site drive an operator's account
- Rate limiting per-email and per-IP on auth
- **9 tenant-isolation tests** proving operator A cannot read or mutate operator
  B's clients, appointments, leads or gaps through any route

---

## Schema

15 tables. Design decisions worth noting:

- **Gaps are materialised**, not computed on read — an offer needs a stable
  foreign key, and "gaps detected vs. filled" is the metric that proves the
  product works
- **Two candidate sources in one schema**: overdue recurring clients *and* open
  job leads. Nobody is "overdue" for a leak, so break-fix trades fill gaps from
  quoted work that never got booked
- **Rejected candidates are kept**, with drive time and lateness frozen at rank
  time, so the scoring formula can be tuned later against real accept/decline
  outcomes instead of guesswork
- All timestamps are epoch seconds UTC; wall-clock times are minutes-from-midnight
- No default country, timezone or currency — a silent default is one market's
  assumptions leaking into every other market's operators

---

## Layout

```
web/                    React 18 dashboard, Vite, TypeScript
  src/App.tsx           routes and shell
  src/main.tsx          entry
  src/api.ts            typed Worker client
  src/pages/            Today, FillSlot, Schedule, Clients, Jobs, Settings, SignIn
  src/components/       shared UI
  src/styles.css        all of the styling

migrations/             5 D1 migrations
src/
  index.ts              API routes, cron, public offer page
  lib/
    gaps.ts             gap detection from working hours, appointments, time off
    rank.ts             candidate scoring — proximity 0.50, readiness 0.35, value 0.15
    offers.ts           offer lifecycle and the accept race guard
    geo.ts              offline geocoding + distance cache
    tz.ts               DST-safe timezone conversion
    countries.ts        launch markets: phone, postcode, currency, locale
test/                   114 tests
design/                 operator UI screen flow
```

---

## Attribution

Postal code data © [GeoNames](https://www.geonames.org/), CC BY 4.0. Required
attribution wherever the data is displayed.
