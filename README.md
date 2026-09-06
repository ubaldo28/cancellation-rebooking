# Slotfill

A marketplace for the hours a cancellation leaves empty.

Mobile trades — detailers, bin cleaners, pressure washers, locksmiths — post
the openings a cancellation left in their week. A customer nearby books one,
usually cheaper, because the van is already on that street. Everything runs on
Cloudflare: one Worker serving both the API and the site, D1 for storage, one
Durable Object per van for live position, and R2 for photographs.

The whole product is one origin. The React app in `web/` is built to static
files and served by the same Worker that answers `/api/*`, because a session
cookie across two origins is a third-party cookie and Safari blocks those. The
pages a search engine has to read — `/near`, `/near/*`, `/los-angeles`,
`/browse`, `/browse/:category`, `/cost`, `/cost/:trade`, `/s/:trade` and
`/p/:slug` — are rendered server-side by `src/lib/seo.ts`, and for the six that
are also React routes the app mounts over the result rather than replacing it.

**Payment is not built.** See [Payments](#payments) before writing any copy
that says money moves.

## Layout

| Path            | What it is                                                        |
| --------------- | ----------------------------------------------------------------- |
| `src/index.ts`  | The Worker: router, every route, the cron handler.                |
| `src/lib/`      | One module per subject — offers, chat, refunds, retention, SEO.   |
| `src/do/van.ts` | The `VanTracker` Durable Object holding a van's current position. |
| `migrations/`   | D1 schema, numbered, applied in order.                            |
| `web/`          | The React SPA (Vite). Its own `package.json` and `node_modules`.  |
| `test/`         | Vitest, running the Worker's real code against an in-memory D1.   |
| `scripts/cf.sh` | Wrangler wrapper that refuses to run against the wrong account.   |

`src/` and `web/src/` cannot import each other — different builds, different
runtimes — so a few constants and sentences exist in both. Every one of those
pairs is pinned by a test in `test/two-trees.test.ts`; add the pin when you add
the pair.

## Running it locally

Dependencies install separately for the two trees.

```sh
npm install                 # Worker + tests
npm --prefix web install    # the React app
```

Create the local database and apply every migration to it:

```sh
npx wrangler d1 migrations apply cancellation-rebooking --local
```

Then either run the Worker on its own, or run both and let Vite proxy:

```sh
npx wrangler dev            # Worker on :8787, serving web/dist if it is built
npm --prefix web run dev    # Vite on :5173, proxying /api and /o to :8787
```

Use `:5173` while working on the front end — it hot-reloads and the proxy keeps
the browser on one origin so the session cookie behaves as it will in
production. Use `:8787` to exercise the server-rendered pages and the assets
binding, which means building the app first (`npm run build`).

There is no seed script. `DEMO_MODE=on` is set in `wrangler.toml`, so opening
`/demo` (or `POST /api/auth/demo`) wipes and rebuilds a complete sample
account — businesses, openings, bookings, reviews — and signs you into it. The
public map seeds itself the same way on first load when the database is empty.

Signing in for real needs an email provider. Without one, `POST
/api/auth/request` answers 503 rather than falling back to anything weaker. For
local work set `AUTH_DEBUG_TOKEN` and send it as the `x-auth-debug` header, and
the sign-in link comes back in the response — that only works when `APP_URL` is
localhost.

## Tests

```sh
npx vitest run                        # 44 files
npx tsc -p tsconfig.json --noEmit     # the Worker
cd web && npx tsc --noEmit            # the app
cd web && npx vite build              # the bundle
```

The suite runs the Worker's real modules — and, through `worker.fetch`, its
real routes — against a `node:sqlite` stand-in for D1 (`test/d1.ts`) built by
applying every file in `migrations/` in order. There is no fixture copy of the
schema, so a migration is under test from the moment it exists.

Accessibility is checked with axe (`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`)
across every public and operator route at 1280px and 375px. That is not part of
`vitest run`; it is a browser pass against a running Worker.

## Deploying

```sh
npm run ship    # test, migrate --remote, build the app, deploy
```

or the steps by hand:

```sh
npm test
npm run db:migrate          # wrangler d1 migrations apply --remote
npm run build               # web/dist
npm run deploy
```

Everything goes through `scripts/cf.sh`, which refuses to run if the Cloudflare
account does not match the `account_id` pinned in `wrangler.toml` — `wrangler
login` stores one machine-wide credential and will otherwise happily deploy to
whichever account the browser last used.

Two things are switched off in `wrangler.toml` and need a decision before they
work:

- **R2** is commented out. A binding to a bucket that does not exist fails the
  whole deploy, so it stays out until the account has R2 enabled and
  `npm run r2:create` has been run. Until then `env.PHOTOS` is undefined and the
  photo routes answer 503; nothing else is affected.
- **`/sw.js`** must be served as JavaScript. A service worker delivered as
  `text/html` fails silently and web push never arrives, so check its content
  type after a deploy rather than assuming.

## Secrets

Set with `wrangler secret put NAME`. Nothing sensitive belongs in `[vars]` in
`wrangler.toml` — that block is committed and readable in the dashboard.

| Secret                  | Needed for                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `SESSION_PEPPER`        | **Required.** 32+ random bytes. Every session, guest link, offer token and erasure subject is hashed with it. Rotating it signs everybody out. |
| `EMAIL_API_KEY`         | Required once `EMAIL_PROVIDER` is `resend` or `postmark`. Without it nobody can sign in.                                                     |
| `ADMIN_EMAILS`          | Comma-separated operator emails allowed to work `/api/admin/*` — disputes, suspensions, the flag queue. Unset means nobody, which is the right default. |
| `TURNSTILE_SECRET`      | The bot check in front of the four public forms. **Not set anywhere yet**, and while it is absent the check steps aside: those forms are open. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for `/webhooks/stripe`. **Not set anywhere yet**, and while it is absent that route answers 503 and processes nothing.         |
| `VAPID_PUBLIC_KEY`      | Web Push. Without all three the alerts UI hides itself and nothing throws.                                                                    |
| `VAPID_PRIVATE_KEY`     | Never rotate these once browsers have subscribed — every subscription is bound to the public key and would go silently dead.                  |
| `VAPID_SUBJECT`         | `mailto:` or `https:` URL. Push services reject anything else.                                                                                |
| `AUTH_DEBUG_TOKEN`      | Local development only. Echoes the sign-in link to a caller presenting it. Refused unless `APP_URL` is localhost.                             |
| `DISTANCE_API_KEY`      | Only if `DISTANCE_PROVIDER` is `google` or `mapbox`. The default, `estimate`, needs no key and costs nothing.                                 |
| `TWILIO_ACCOUNT_SID`    | Only if an operator sets `sms_mode = twilio`. The default, `device`, hands the operator a prefilled `sms:` link to tap.                        |
| `TWILIO_AUTH_TOKEN`     | Also validates inbound webhook signatures.                                                                                                    |
| `TWILIO_FROM`           | The sending number.                                                                                                                           |

The front end has one build-time variable, `VITE_TURNSTILE_SITE_KEY` in
`web/.env.production`. A site key is public by design — it is compiled into the
bundle every visitor downloads — and it is the secret half above that must not
be. Setting one without the other is handled but is not a state to sit in.

Turnstile and Stripe fail in opposite directions on purpose. A missing
`TURNSTILE_SECRET` leaves the forms exactly as open as they were before the
check existed, which is what lets this run locally and deploy before a key is
issued. A missing `STRIPE_WEBHOOK_SECRET` fails closed, because the alternative
is an endpoint that will one day move money accepting unsigned instructions.

## Payments

**No money moves through this system.** Nothing takes a card, holds a balance,
or pays anybody out. Every place a charge would happen is an unimplemented seam
and is marked as one in the code:

- `createOrder` (`src/lib/orders.ts`) writes `orders.status = 'pending'`.
- The refund and the operator's lead fee (`src/lib/bypass.ts`) are calculated
  and recorded, and nothing is charged or returned.
- The parts charge (`src/lib/parts.ts`), the estimate that becomes a booking
  (`src/lib/estimates.ts`) and the settlement hold (`src/lib/settlement.ts`) are
  the same.
- `/webhooks/stripe` verifies signatures correctly and then does nothing with
  the event. It answers 503 while `STRIPE_WEBHOOK_SECRET` is unset.

The cancellation ladder, the parts-approval rule and the fee floor are real
rules computed by real code, and a customer is entitled to know them before
booking — so the site states them as the design that takes effect when payment
lands, never as something that happens today. Those sentences live in one place,
`web/src/components/PaymentState.tsx`, and `test/public-payload.test.ts` pins
the server-rendered pages to the same wording. If you change what the product
does with money, change that file and those tests together.

Card data itself is refused structurally rather than by convention. Anything
shaped like a PAN, CVC or bank account is rejected at three points — every
parsed request body, every value bound to a D1 statement, and every JSON
response — so a mis-wired form cannot write a card number into the database
regardless of which route it posts to. See `src/lib/payments.ts`.

## Data and retention

Customers have no account: the secret in their link is their identity, and only
its hash is stored. An operator never receives a platform customer's phone
number, email or surname — those rows are written without them and the
conversation stays in the app. The street address is released to the operator
when a booking exists and withdrawn when it is cancelled.

The cron runs every fifteen minutes (`wrangler.toml`, `[triggers]`) and each
step is independent: expiring offers and quotes, settling holds, reconciling
cadence, and last the retention sweep that deletes old addresses, coordinates,
photographs and conversations. Each step is wrapped so that one failure cannot
stop the ones after it — retention is last and is the one that must still run
when something above it is broken.
