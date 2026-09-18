export interface Env {
  DB: D1Database;
  APP_URL: string;
  DISTANCE_PROVIDER: 'estimate' | 'google' | 'mapbox';
  /** 'auto' also uses the US Census geocoder; 'none' = local table only. */
  GEOCODE_PROVIDER: 'auto' | 'none';
  SESSION_PEPPER: string;
  /** Comma-separated exact origins allowed to call the API with credentials. */
  ALLOWED_ORIGINS?: string;
  /**
   * Who sends the site's transactional email -- today only the sign-in link,
   * which is the ONLY way a business reaches its own account, and the opening
   * alerts customers subscribe to.
   *
   * Named rather than inferred from whichever key happens to be present, for
   * the same reason as SMS_PROVIDER below: a deployment holding a key but no
   * from-address is honestly NOT configured, and a second provider added later
   * cannot silently take over. Absent is 'none', and none means every sign-in
   * is REFUSED with 503 rather than quietly succeeding without the email --
   * see the note at the top of ./lib/email.ts.
   */
  EMAIL_PROVIDER?: 'resend' | 'postmark' | 'brevo' | 'none';
  /**
   * The sending identity, e.g. 'Round The Way <hello@roundtheway.app>'. A var
   * rather than a secret because it appears in the header of every email sent.
   * Its domain must be verified with the provider first: with Resend an
   * unverified domain answers 403 on every send, so sign-in is entirely down
   * until the DNS records are in place.
   */
  EMAIL_FROM?: string;
  /** The provider's API key. Sending stays refused until this AND EMAIL_FROM are set. */
  EMAIL_API_KEY?: string;
  /**
   * THE SECOND SENDER, and why there are two.
   *
   * Two kinds of email leave this site and they fail in opposite directions.
   * A sign-in link is ONE message that has to arrive in seconds, because
   * somebody is staring at a form waiting for it. An opening alert is MANY
   * messages that nobody is waiting on, and one arriving a minute late is
   * still a useful alert.
   *
   * On one provider they share a daily allowance, so the alerts — the side
   * that scales — spend it, and the sign-ins — the side that cannot tolerate
   * being refused — are what breaks. That is exactly backwards, and it breaks
   * on the busiest day rather than the quietest.
   *
   * So alerts get their own provider and their own allowance. Unset means
   * there is no second sender and everything goes through EMAIL_PROVIDER
   * above, which is a smaller site, not a broken one.
   *
   * BULK_EMAIL_FROM is optional even when a bulk provider is named: without it
   * the main EMAIL_FROM is used, which is right whenever both providers are
   * verified for the same domain.
   */
  BULK_EMAIL_PROVIDER?: 'resend' | 'postmark' | 'brevo' | 'none';
  /** The bulk provider's API key. The bulk sender stays off until this is set. */
  BULK_EMAIL_API_KEY?: string;
  /** Optional bulk sending identity. Falls back to EMAIL_FROM. */
  BULK_EMAIL_FROM?: string;
  /**
   * Set ONLY in local development. Lets a caller presenting this value in the
   * x-auth-debug header receive the sign-in link in the response. Refused
   * outright unless APP_URL is localhost or *.workers.dev.
   */
  AUTH_DEBUG_TOKEN?: string;
  /** 'on' enables the no-sign-in demo account at /demo. Anything else hides it. */
  DEMO_MODE?: string;
  /**
   * Comma-separated operator emails allowed to work the moderation queue at
   * /api/admin/*. Unset means nobody, which is the safe default: those routes
   * suspend and ban accounts and have no front end, so an environment that
   * never sets this is not using them. See requireAdmin in lib/auth.ts.
   */
  ADMIN_EMAILS?: string;
  /**
   * Cloudflare Turnstile's secret half, checked against siteverify before the
   * public forms are allowed to do anything.
   *
   * Optional, and UNSET IN EVERY ENVIRONMENT TODAY. While it is absent the
   * check is skipped outright and those endpoints behave exactly as they did
   * before it was added — which is what lets `wrangler dev` and the test suite
   * run without a key, and what makes this deployable before one is issued. It
   * also means the forms are not protected yet: they become protected the day
   * somebody runs `wrangler secret put TURNSTILE_SECRET`, and not before. See
   * src/lib/turnstile.ts; the client's matching switch is the build-time
   * VITE_TURNSTILE_SITE_KEY.
   */
  TURNSTILE_SECRET?: string;
  /**
   * The signing secret for the Stripe webhook endpoint (`whsec_...`).
   *
   * Optional in the type and required in practice: while it is missing
   * nothing can ever confirm a payment, so every booking stays unpaid however
   * many cards clear. Unlike TURNSTILE_SECRET its absence does not step a
   * check aside and
   * let requests through: /webhooks/stripe answers 503 and processes nothing
   * while this is missing. An endpoint that moves money has to fail closed, so
   * there is deliberately no state in which it accepts an unsigned
   * instruction. See src/lib/payments.ts.
   */
  STRIPE_WEBHOOK_SECRET?: string;

  /**
   * The Stripe secret key, as a Worker secret. Never in wrangler.toml, never
   * in the repo, never in the browser — this is the key that can move money.
   * Absent means payments are off and every paying path refuses at the door
   * rather than half-working; see stripeConfigured in lib/stripe.ts.
   */
  STRIPE_SECRET_KEY?: string;

  /**
   * The matching publishable key, which is the opposite kind of secret: it is
   * meant to be in the browser, it is what the embedded payment form
   * identifies itself with, and it can do nothing on its own. Served to the
   * page rather than baked into the bundle so a key rotation is a secret
   * change and not a rebuild.
   */
  STRIPE_PUBLISHABLE_KEY?: string;
  /**
   * Web Push signing keys. Absent means push is simply off: the alerts UI
   * hides itself and nothing throws. Never rotate these once browsers have
   * subscribed — every existing subscription is bound to the public key and
   * would go silently dead.
   */
  /**
   * Live van positions. Optional on purpose: every tracking function degrades
   * to "nothing to show" without it, so the site still boots on a deploy that
   * has not had the Durable Object migration applied.
   */
  /** The built React app. Bound in wrangler.toml; used to hand a route to the SPA. */
  ASSETS?: Fetcher;
  VAN?: DurableObjectNamespace;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  DISTANCE_API_KEY?: string;
  /**
   * Telnyx, which sends the site's own texts -- the sign-in code, and nothing
   * else yet.
   *
   * Named rather than inferred so that a deployment holding a key but no
   * number is honestly NOT configured. Absent means REFUSED: see the note at
   * the top of ./sms.ts for why that is different from Turnstile, which is
   * merely inert without its secret.
   */
  SMS_PROVIDER?: 'telnyx' | 'none';
  TELNYX_API_KEY?: string;
  /** The sending number in E.164, e.g. +18185550142. */
  TELNYX_FROM?: string;
  /**
   * The photo store: profile avatars, portfolio work photos and job proof.
   *
   * A KV namespace and not an R2 bucket. This was typed R2Bucket for the whole
   * life of the codebase and the bucket was never created, because enabling R2
   * needs a subscription attached to a card and this runs on no budget — so
   * the binding stayed commented out in wrangler.toml and every photo route
   * answered 503 in production. KV is free, needs no card, and is therefore
   * the store that actually exists. What it costs — 1 GB for the whole
   * account, 25 MiB per value, 1,000 writes and 100,000 reads a day — is
   * written up in full at the top of ./lib/photostore.ts, which is the only
   * module that touches this binding's read and write paths.
   *
   * STILL OPTIONAL, AND THAT IS LOAD-BEARING. An environment with no namespace
   * bound still boots and serves the whole calendar and booking flow — only
   * the photo endpoints are unavailable, answering 503 or 404. A required
   * binding here would take the Worker down in every environment that has not
   * created the namespace yet, which is exactly what keeping it optional
   * avoided when it was R2 and is exactly what it goes on avoiding now: the
   * namespace does not exist until somebody runs the create command, and the
   * rest of the site must not wait for that.
   */
  PHOTOS?: KVNamespace;
}

export interface Operator {
  id: string;
  email: string;
  business_name: string;
  trade: string | null;
  phone_e164: string | null;
  timezone: string;
  country: string;
  currency: string;
  language: string;
  location_mode: 'mobile' | 'premises' | 'hybrid';
  fill_model: 'clients' | 'leads' | 'both';
  sms_mode: 'device';
  home_lat: number | null;
  home_lng: number | null;
  min_gap_seconds: number;
  max_detour_seconds: number;
  buffer_seconds: number;
  offer_ttl_seconds: number;
  offers_per_wave: number;
  min_notice_seconds: number;
  reoffer_cooldown_seconds: number;
  discount_percent: number;
  plan: string;
  /** Off by default. Only the operator's own action turns this on. */
  share_location: number;

  // Public profile (migration 0008). Every one of these is absent until the
  // operator fills their profile in, and none of it is shown to anyone until
  // is_published flips to 1.
  tagline: string | null;
  bio: string | null;
  years_experience: number | null;
  /** URL segment for their public page; NULL until first published. */
  profile_slug: string | null;
  /** R2 object key, not a URL — the hostname in front of the bucket moves. */
  avatar_key: string | null;
  is_published: number;
}

export interface Point { lat: number; lng: number }

export interface Candidate {
  kind: 'client' | 'lead';
  client_id: string;
  lead_id: string | null;
  service_id: string | null;
  first_name: string;
  /**
   * The conversation the offer is delivered into, and the reason a candidate
   * is a candidate at all.
   *
   * This field replaces `phone_e164`, which was here because offers used to go
   * out as text messages. It could not do that job: a customer this platform
   * introduced is written with no number on purpose — see clientWrite in
   * lib/orders.ts — so the field was null for everyone the operator earned
   * here, and there is no SMS provider to send through in any case. A thread
   * id is the honest version of the same thing: where the message goes.
   *
   * Never null. lib/rank.ts joins on it, so a client with no live conversation
   * is not ranked rather than ranked and then found to be unreachable.
   */
  thread_id: string;
  language: string | null;
  lat: number | null;
  lng: number | null;
  duration_seconds: number;
  price_cents: number;
  title: string;
  overdue_days: number | null;
  urgency: number | null;
  drive_in_seconds: number | null;
  drive_out_seconds: number | null;
  detour_seconds: number | null;
  score: number;
  reasons: string[];
}
