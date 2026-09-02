export interface Env {
  DB: D1Database;
  APP_URL: string;
  DISTANCE_PROVIDER: 'estimate' | 'google' | 'mapbox';
  /** 'auto' also uses postcodes.io (GB) and US Census; 'none' = table only. */
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
  DISTANCE_API_KEY?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_FROM?: string;
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
