export interface Env {
  DB: D1Database;
  APP_URL: string;
  DISTANCE_PROVIDER: 'estimate' | 'google' | 'mapbox';
  /** 'auto' also uses the US Census geocoder; 'none' = local table only. */
  GEOCODE_PROVIDER: 'auto' | 'none';
  SESSION_PEPPER: string;
  /** Comma-separated exact origins allowed to call the API with credentials. */
  ALLOWED_ORIGINS?: string;
  EMAIL_PROVIDER?: 'resend' | 'postmark' | 'none';
  EMAIL_FROM?: string;
  EMAIL_API_KEY?: string;
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
   * Optional, and UNSET IN EVERY ENVIRONMENT TODAY, because no charge exists
   * yet. Unlike TURNSTILE_SECRET its absence does not step a check aside and
   * let requests through: /webhooks/stripe answers 503 and processes nothing
   * while this is missing. An endpoint that moves money has to fail closed, so
   * there is deliberately no state in which it accepts an unsigned
   * instruction. See src/lib/payments.ts.
   */
  STRIPE_WEBHOOK_SECRET?: string;
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
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_FROM?: string;
  /**
   * Bucket holding profile avatars and work photos.
   *
   * Optional on purpose: an environment with no bucket bound still boots and
   * serves the whole calendar and booking flow — only the photo endpoints are
   * unavailable. A required binding here would take the Worker down in every
   * preview environment that has not created a bucket yet.
   */
  PHOTOS?: R2Bucket;
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
  sms_mode: 'device' | 'twilio';
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
  phone_e164: string | null;
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
