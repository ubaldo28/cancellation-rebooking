# Round The Way

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

**Money moves.** Cards are charged, funds are held, businesses are paid out and
refunds go back to the card. Read [Payments](#payments) before touching
anything on that path, and before writing any copy that describes it.

Other people's work is in here too, and some of it has to be credited. See
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

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
npx wrangler d1 migrations apply roundtheway --local
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

- **Photo storage (`PHOTOS`)** is commented out. It is a **Workers KV**
  namespace, not an R2 bucket — R2 needs a subscription attached to a card and
  this runs on no budget, so it was never switched on and the photo routes
  answered 503 for the whole life of the deployment. A binding whose namespace
  id does not exist fails the whole deploy, so it stays commented out until
  `npx wrangler kv namespace create PHOTOS` (or `npm run kv:create`) has been
  run and the id it prints has been pasted into the block in `wrangler.toml`.
  Until then `env.PHOTOS` is undefined and the photo routes answer 503 or 404;
  nothing else is affected. The free KV allowance is 1 GB of storage for the
  whole account, 25 MiB per value, and 1,000 writes / 100,000 reads a day —
  `src/lib/photostore.ts` explains what living inside that means.
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
| `STRIPE_SECRET_KEY`     | **Required for payments.** The key that can move money. Absent means every paying path refuses at the door rather than half-working.          |
| `STRIPE_PUBLISHABLE_KEY` | The matching public key. Served to the page rather than compiled into the bundle, so rotating it is a secret change and not a rebuild.       |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for `/webhooks/stripe`. Absent means that route answers 503 — and since the webhook is what confirms a booking, absent means nothing ever gets confirmed. |
| `VAPID_PUBLIC_KEY`      | Web Push. Without all three the alerts UI hides itself and nothing throws.                                                                    |
| `VAPID_PRIVATE_KEY`     | Never rotate these once browsers have subscribed — every subscription is bound to the public key and would go silently dead.                  |
| `VAPID_SUBJECT`         | `mailto:` or `https:` URL. Push services reject anything else.                                                                                |
| `AUTH_DEBUG_TOKEN`      | Local development only. Echoes the sign-in link to a caller presenting it. Refused unless `APP_URL` is localhost.                             |
| `DISTANCE_API_KEY`      | Only if `DISTANCE_PROVIDER` is `google` or `mapbox`. The default, `estimate`, needs no key and costs nothing.                                 |
| `TELNYX_API_KEY`        | Only if `SMS_PROVIDER` is `telnyx`. **Nothing calls it.** No US route exists without a registered campaign behind a published street address, so `src/lib/sms.ts` is a hardened door with nobody on the other side of it. |
| `TELNYX_FROM`           | The sending number, if there ever is one. The customer's sign-in code moved to email in migration 0038 and gap-fill offers moved to the in-app conversation plus the bulk email lane; neither goes near this. |

The front end has one build-time variable, `VITE_TURNSTILE_SITE_KEY` in
`web/.env.production`. A site key is public by design — it is compiled into the
bundle every visitor downloads — and it is the secret half above that must not
be. Setting one without the other is handled but is not a state to sit in.

Turnstile and Stripe fail in opposite directions on purpose. A missing
`TURNSTILE_SECRET` leaves the forms exactly as open as they were before the
check existed, which is what lets this run locally and deploy before a key is
issued. A missing `STRIPE_WEBHOOK_SECRET` fails closed, because the alternative
is an endpoint that moves money accepting unsigned instructions.

## Payments

**Money moves through this system.** A customer's card is charged at booking,
the platform holds the money until the work is behind it, each business is paid
its share afterwards, and a cancelled booking is refunded to the card it was
taken from. This section used to say the opposite, which was true once and is
the most dangerous sentence a README can carry — so if you find yourself about
to write "nothing takes a card" anywhere, read the three files below first.

**Stripe Connect Express.** A business is paid into its own connected account
at Stripe, which Stripe onboards: identity documents and bank details go to the
regulated company on its own page, not onto a form here. That redirect is the
one place in the product where leaving roundtheway.app is correct — customers
never do, and never will. Finishing onboarding is what unlocks listing:
`src/lib/bypass.ts` refuses to publish an opening for a business whose
`stripe_payouts_enabled` is not 1, because money coming in for a job with
nowhere to send the business's share is not a state this product should be able
to reach. See `src/lib/connect.ts`.

**Separate charges and transfers.** One basket can hold work from several
businesses and a single charge can only have one destination, so the customer
pays one PaymentIntent into the platform account and each business is paid by
its own later Transfer. The fee is simply what is not transferred. The card is
taken by Stripe's embedded form on our own page — no Checkout Session, no
redirect — and this Worker never sees a card number. See `src/lib/stripe.ts`.

**The fee: 15% of the job, never more than $150, per business per day.**
`src/lib/fees.ts` is the only place a rate may exist; every figure shown to
anybody is computed from it. The cap is per business per day rather than per
basket or per job — two $600 jobs on the same day are one $150 ceiling, two a
week apart are $90 and $90. Nothing is added on the customer's side: the price
beside an opening is the price on the card.

**The money waits.** Settlement used to run straight off the webhook, so every
business was paid days before anybody drove anywhere — and a customer who
cancelled the next morning was refunded out of the platform's own pocket,
because a Transfer that has landed in a bank account cannot be quietly pulled
back. A line is now paid out only once its appointment is over and the window
in which a cancellation could still claim the money has closed
(`payoutDueAt`, three hours past the slot). The cron's `pay for finished work`
step sweeps for the lines that have reached it.

**Refunds go to the card.** A cancellation writes the refund the ladder in
`src/lib/bypass.ts` decided and freezes it behind a hold, in case the van turns
up anyway. When the hold releases, `refundItem` sends that exact figure back to
the card the money came from — immediately when a customer answers the "did
they come?" question, and otherwise on the cron's `refund released holds` step.
Nothing is refunded by hand.

**What is still a seam, so nobody claims more than is true.** Three payment
paths remain unwired and each one says so where it sits: the second charge for
approved parts (`src/lib/parts.ts`), the accepted estimate that should become a
booking and a charge (`src/lib/estimates.ts`), and the collection of an
operator's lead fee after a cancellation — `lead_fees` rows are raised, shown
to the operator and settled by hand through `settleFee`; nothing nets them off
a payout and no card is charged for one.

**The webhook is the only thing that confirms a booking.** `/webhooks/stripe`
verifies the signature, and on `payment_intent.succeeded` calls `markPaid` —
never the browser, because a customer who pays and closes the tab in the same
second must still end up with a confirmed booking. It also records failed and
cancelled intents, and refreshes a business's payout flags from
`account.updated`. Nothing is paid out here. While `STRIPE_WEBHOOK_SECRET` is
unset the route answers 503, which means no booking is ever confirmed.

Start with `src/lib/fees.ts` (what is charged), `src/lib/checkout.ts` (the four
steps: open the charge, confirm it, settle it, refund it) and
`src/lib/stripe.ts` (how this Worker talks to Stripe without an SDK). Every one
of those steps is idempotent on purpose; the comments say why.

The sentences a customer is shown about all of this live in one place,
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
