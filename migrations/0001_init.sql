-- Gap Filler — initial schema (rev 2)
-- Target: Cloudflare D1 (SQLite)
--
-- Rev 2 changes from rev 1:
--   * Two fill models in one schema: overdue recurring clients AND open job
--     leads (quotes/deferred work) for break-fix trades. gap_offers points at
--     either via candidate_kind.
--   * The app OWNS the calendar, so working_hours + time_off + locations exist
--     and appointments are source of truth, not a mirror.
--   * Operators can be mobile, fixed-premises, or hybrid. Drive-time ranking
--     applies only to mobile jobs; premises jobs rank on cadence alone.
--   * SMS defaults to 'device' — a prefilled sms: link the operator taps on
--     their own phone. Zero cost, zero carrier registration. Twilio optional.
--
-- Conventions:
--   * ids are TEXT (UUIDv7/nanoid) minted in the Worker.
--   * timestamps are INTEGER epoch SECONDS UTC. Wall-clock times of day are
--     INTEGER minutes-from-midnight in the operator's own timezone.
--   * money is INTEGER minor units; durations INTEGER seconds.
--   * booleans are INTEGER 0/1 with a CHECK.
--   * every tenant row carries operator_id explicitly.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 1. Operators
-- ---------------------------------------------------------------------------
CREATE TABLE operators (
  id                   TEXT PRIMARY KEY,
  email                TEXT NOT NULL,
  business_name        TEXT NOT NULL,
  trade                TEXT,                 -- free text: 'mobile detailing', 'plumbing'
  phone_e164           TEXT,
  -- No defaults on these three: a silent default is one country's
  -- assumptions leaking into every other country's operators.
  timezone             TEXT NOT NULL,        -- IANA name, set from the chosen country
  country              TEXT NOT NULL,        -- ISO-3166-1 alpha-2
  currency             TEXT NOT NULL,        -- ISO-4217

  -- mobile  : travels to every job, drive-time ranking always on
  -- premises: works from a fixed location, drive-time irrelevant
  -- hybrid  : both; per-appointment is_mobile decides
  location_mode        TEXT NOT NULL DEFAULT 'mobile'
                         CHECK (location_mode IN ('mobile','premises','hybrid')),

  -- Which candidate sources feed gap ranking.
  fill_model           TEXT NOT NULL DEFAULT 'both'
                         CHECK (fill_model IN ('clients','leads','both')),

  -- How offers physically go out.
  -- device: Worker returns a prefilled sms: deep link, operator taps send.
  --         Costs nothing and needs no carrier registration. Default.
  -- twilio: automated send. Requires sender registration in most markets.
  sms_mode             TEXT NOT NULL DEFAULT 'device'
                         CHECK (sms_mode IN ('device','twilio')),

  -- Fallback anchor when a gap has no adjacent job.
  home_address         TEXT,
  home_lat             REAL,
  home_lng             REAL,

  min_gap_seconds      INTEGER NOT NULL DEFAULT 3600,
  max_detour_seconds   INTEGER NOT NULL DEFAULT 900,
  buffer_seconds       INTEGER NOT NULL DEFAULT 900,
  offer_ttl_seconds    INTEGER NOT NULL DEFAULT 5400,
  offers_per_wave      INTEGER NOT NULL DEFAULT 3,
  min_notice_seconds   INTEGER NOT NULL DEFAULT 3600,  -- don't offer a slot sooner than this
  reoffer_cooldown_seconds INTEGER NOT NULL DEFAULT 604800, -- don't re-pester a client
  discount_percent     INTEGER NOT NULL DEFAULT 0
                         CHECK (discount_percent BETWEEN 0 AND 100),

  plan                 TEXT NOT NULL DEFAULT 'trial'
                         CHECK (plan IN ('trial','active','past_due','cancelled')),
  trial_ends_at        INTEGER,

  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_operators_email ON operators (lower(email));

-- ---------------------------------------------------------------------------
-- 2. Auth
-- ---------------------------------------------------------------------------
CREATE TABLE login_tokens (
  id            TEXT PRIMARY KEY,
  operator_id   TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  consumed_at   INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_login_tokens_hash   ON login_tokens (token_hash);
CREATE INDEX        idx_login_tokens_expiry ON login_tokens (expires_at);

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  operator_id   TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL,
  user_agent    TEXT,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_sessions_hash     ON sessions (token_hash);
CREATE INDEX        idx_sessions_operator ON sessions (operator_id, expires_at);

-- ---------------------------------------------------------------------------
-- 3. Locations — for premises and hybrid operators
-- ---------------------------------------------------------------------------
CREATE TABLE locations (
  id           TEXT PRIMARY KEY,
  operator_id  TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  address_line TEXT,
  postcode     TEXT,
  lat          REAL,
  lng          REAL,
  is_primary   INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_locations_operator ON locations (operator_id, is_active);
CREATE UNIQUE INDEX idx_locations_primary ON locations (operator_id)
  WHERE is_primary = 1;

-- ---------------------------------------------------------------------------
-- 4. Availability — the app owns the calendar, so it owns the working week
--    Minutes from midnight in the operator's timezone. 540 = 09:00.
-- ---------------------------------------------------------------------------
CREATE TABLE working_hours (
  id            TEXT PRIMARY KEY,
  operator_id   TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  location_id   TEXT REFERENCES locations(id) ON DELETE CASCADE,
  weekday       INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),  -- 0 = Sunday
  start_minute  INTEGER NOT NULL CHECK (start_minute BETWEEN 0 AND 1440),
  end_minute    INTEGER NOT NULL CHECK (end_minute   BETWEEN 0 AND 1440),
  created_at    INTEGER NOT NULL,
  CHECK (end_minute > start_minute)
);
CREATE INDEX idx_working_hours ON working_hours (operator_id, weekday);

CREATE TABLE time_off (
  id           TEXT PRIMARY KEY,
  operator_id  TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  starts_at    INTEGER NOT NULL,
  ends_at      INTEGER NOT NULL,
  reason       TEXT,
  created_at   INTEGER NOT NULL,
  CHECK (ends_at > starts_at)
);
CREATE INDEX idx_time_off ON time_off (operator_id, starts_at, ends_at);

-- ---------------------------------------------------------------------------
-- 5. Services
-- ---------------------------------------------------------------------------
CREATE TABLE services (
  id                    TEXT PRIMARY KEY,
  operator_id           TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,

  -- Break-fix work has variable duration; recurring work usually doesn't.
  -- duration_seconds is the planning default; min/max bound what will fit a gap.
  duration_seconds      INTEGER NOT NULL,
  min_duration_seconds  INTEGER,
  max_duration_seconds  INTEGER,

  price_cents           INTEGER NOT NULL DEFAULT 0,
  is_price_from         INTEGER NOT NULL DEFAULT 0 CHECK (is_price_from IN (0,1)),

  -- NULL cadence = non-recurring (break-fix). Drives the overdue list.
  cadence_days          INTEGER,

  -- Gap-fill eligibility gates. A job needing parts on hand or the client
  -- physically present can't always take a slot two hours from now.
  requires_parts        INTEGER NOT NULL DEFAULT 0 CHECK (requires_parts IN (0,1)),
  requires_client_present INTEGER NOT NULL DEFAULT 1 CHECK (requires_client_present IN (0,1)),
  gap_fill_eligible     INTEGER NOT NULL DEFAULT 1 CHECK (gap_fill_eligible IN (0,1)),

  is_mobile             INTEGER NOT NULL DEFAULT 1 CHECK (is_mobile IN (0,1)),
  is_active             INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,

  CHECK (min_duration_seconds IS NULL OR min_duration_seconds <= duration_seconds),
  CHECK (max_duration_seconds IS NULL OR max_duration_seconds >= duration_seconds)
);
CREATE INDEX idx_services_operator ON services (operator_id, is_active);

-- ---------------------------------------------------------------------------
-- 6. Clients
-- ---------------------------------------------------------------------------
CREATE TABLE clients (
  id                 TEXT PRIMARY KEY,
  operator_id        TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,

  first_name         TEXT NOT NULL,
  last_name          TEXT,
  phone_e164         TEXT,
  email              TEXT,

  address_line       TEXT,
  postcode           TEXT,
  lat                REAL,
  lng                REAL,
  geocode_status     TEXT NOT NULL DEFAULT 'pending'
                       CHECK (geocode_status IN ('pending','ok','failed','manual')),
  geocoded_at        INTEGER,

  default_service_id TEXT REFERENCES services(id) ON DELETE SET NULL,

  last_serviced_at   INTEGER,
  next_due_at        INTEGER,
  visit_count        INTEGER NOT NULL DEFAULT 0,
  no_show_count      INTEGER NOT NULL DEFAULT 0,

  sms_consent        INTEGER NOT NULL DEFAULT 0 CHECK (sms_consent IN (0,1)),
  sms_consent_at     INTEGER,
  opted_out_at       INTEGER,
  last_offered_at    INTEGER,

  notes              TEXT,
  is_active          INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,

  CHECK (sms_consent = 0 OR phone_e164 IS NOT NULL)
);
CREATE INDEX idx_clients_operator  ON clients (operator_id, is_active);
CREATE INDEX idx_clients_due       ON clients (operator_id, next_due_at);
CREATE INDEX idx_clients_offerable ON clients (operator_id, sms_consent, opted_out_at, last_offered_at);
CREATE UNIQUE INDEX idx_clients_phone ON clients (operator_id, phone_e164)
  WHERE phone_e164 IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 7. Job leads — the break-fix fill source.
--    A plumber has no "overdue" clients. What they have is work that was
--    quoted and never booked, or a repair the customer deferred. That backlog
--    is the thing that fills a Tuesday hole. Without this table the product
--    only works for recurring trades.
-- ---------------------------------------------------------------------------
CREATE TABLE job_leads (
  id                  TEXT PRIMARY KEY,
  operator_id         TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  client_id           TEXT REFERENCES clients(id) ON DELETE CASCADE,
  service_id          TEXT REFERENCES services(id) ON DELETE SET NULL,

  title               TEXT NOT NULL,          -- 'Replace kitchen mixer tap'
  description         TEXT,

  quoted_price_cents  INTEGER,
  quoted_at           INTEGER,
  estimated_duration_seconds INTEGER,

  -- Where the work is. Falls back to the client's address when null.
  address_line        TEXT,
  postcode            TEXT,
  lat                 REAL,
  lng                 REAL,

  -- Readiness gates: a lead that needs an ordered part can't fill today's gap.
  parts_required      INTEGER NOT NULL DEFAULT 0 CHECK (parts_required IN (0,1)),
  parts_ready         INTEGER NOT NULL DEFAULT 1 CHECK (parts_ready IN (0,1)),
  urgency             INTEGER NOT NULL DEFAULT 2 CHECK (urgency BETWEEN 1 AND 5),

  status              TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','offered','scheduled','won','lost','expired')),
  lost_reason         TEXT,
  expires_at          INTEGER,
  last_offered_at     INTEGER,

  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX idx_leads_operator ON job_leads (operator_id, status);
CREATE INDEX idx_leads_fillable ON job_leads (operator_id, status, parts_ready, urgency);
CREATE INDEX idx_leads_client   ON job_leads (client_id, status);

-- ---------------------------------------------------------------------------
-- 8. Appointments — source of truth, because the app owns the calendar
-- ---------------------------------------------------------------------------
CREATE TABLE appointments (
  id             TEXT PRIMARY KEY,
  operator_id    TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  client_id      TEXT REFERENCES clients(id) ON DELETE SET NULL,
  service_id     TEXT REFERENCES services(id) ON DELETE SET NULL,
  lead_id        TEXT REFERENCES job_leads(id) ON DELETE SET NULL,
  location_id    TEXT REFERENCES locations(id) ON DELETE SET NULL,

  starts_at      INTEGER NOT NULL,
  ends_at        INTEGER NOT NULL,

  -- 1 = operator travels to the address below. 0 = client comes to location_id.
  is_mobile      INTEGER NOT NULL DEFAULT 1 CHECK (is_mobile IN (0,1)),

  -- Snapshot of where the job happens, so later client edits don't rewrite history.
  address_line   TEXT,
  postcode       TEXT,
  lat            REAL,
  lng            REAL,

  status         TEXT NOT NULL DEFAULT 'scheduled'
                   CHECK (status IN ('scheduled','completed','cancelled','no_show')),
  cancelled_at   INTEGER,
  cancelled_by   TEXT CHECK (cancelled_by IN ('operator','client',NULL)),
  price_cents    INTEGER,

  source         TEXT NOT NULL DEFAULT 'manual'
                   CHECK (source IN ('manual','import','gap_fill','online')),
  filled_offer_id TEXT,      -- integrity enforced in the Worker (circular FK)

  external_id    TEXT,
  notes          TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,

  CHECK (ends_at > starts_at),
  CHECK (is_mobile = 0 OR location_id IS NULL OR 1)
);
CREATE INDEX idx_appts_operator_time ON appointments (operator_id, starts_at);
CREATE INDEX idx_appts_live_time     ON appointments (operator_id, status, starts_at);
CREATE INDEX idx_appts_client        ON appointments (client_id, starts_at);
CREATE INDEX idx_appts_filled_offer  ON appointments (filled_offer_id)
  WHERE filled_offer_id IS NOT NULL;
CREATE UNIQUE INDEX idx_appts_external ON appointments (operator_id, external_id)
  WHERE external_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 9. Gaps
-- ---------------------------------------------------------------------------
CREATE TABLE gaps (
  id                   TEXT PRIMARY KEY,
  operator_id          TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,

  starts_at            INTEGER NOT NULL,
  ends_at              INTEGER NOT NULL,

  prev_appointment_id  TEXT REFERENCES appointments(id) ON DELETE SET NULL,
  next_appointment_id  TEXT REFERENCES appointments(id) ON DELETE SET NULL,
  prev_lat             REAL,
  prev_lng             REAL,
  next_lat             REAL,
  next_lng             REAL,

  -- Drive time prev -> next if the gap stays empty. A candidate's detour is
  -- (prev->job + job->next) - baseline. NULL for premises-only gaps.
  baseline_drive_seconds INTEGER,

  -- 1 = fillable by mobile work (drive-time ranking applies)
  -- 0 = premises gap; rank on cadence/urgency only
  is_mobile            INTEGER NOT NULL DEFAULT 1 CHECK (is_mobile IN (0,1)),
  location_id          TEXT REFERENCES locations(id) ON DELETE SET NULL,

  status               TEXT NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open','offering','filled','expired','dismissed')),
  filled_appointment_id TEXT REFERENCES appointments(id) ON DELETE SET NULL,
  created_by_cancellation_of TEXT REFERENCES appointments(id) ON DELETE SET NULL,

  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,

  CHECK (ends_at > starts_at)
);
CREATE INDEX idx_gaps_operator_time ON gaps (operator_id, starts_at);
CREATE INDEX idx_gaps_open          ON gaps (operator_id, status, starts_at);
CREATE UNIQUE INDEX idx_gaps_window ON gaps (operator_id, starts_at, ends_at)
  WHERE status IN ('open','offering');

-- ---------------------------------------------------------------------------
-- 10. Offers — one row per ranked candidate. Candidate is EITHER an overdue
--     client or an open job lead; candidate_kind says which.
-- ---------------------------------------------------------------------------
CREATE TABLE gap_offers (
  id                   TEXT PRIMARY KEY,
  operator_id          TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  gap_id               TEXT NOT NULL REFERENCES gaps(id) ON DELETE CASCADE,

  candidate_kind       TEXT NOT NULL CHECK (candidate_kind IN ('client','lead')),
  client_id            TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  lead_id              TEXT REFERENCES job_leads(id) ON DELETE CASCADE,
  service_id           TEXT REFERENCES services(id) ON DELETE SET NULL,

  rank                 INTEGER NOT NULL,
  drive_in_seconds     INTEGER,
  drive_out_seconds    INTEGER,
  detour_seconds       INTEGER,
  overdue_days         INTEGER,
  urgency              INTEGER,
  score                REAL,

  token_hash           TEXT NOT NULL,

  status               TEXT NOT NULL DEFAULT 'candidate'
                         CHECK (status IN ('candidate','queued','sent','delivered',
                                           'viewed','accepted','declined',
                                           'expired','failed','superseded')),
  sent_at              INTEGER,
  viewed_at            INTEGER,
  responded_at         INTEGER,
  expires_at           INTEGER,

  quoted_price_cents   INTEGER,
  decline_reason       TEXT,

  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,

  CHECK (candidate_kind = 'client' OR lead_id IS NOT NULL)
);
CREATE UNIQUE INDEX idx_offers_token   ON gap_offers (token_hash);
CREATE INDEX idx_offers_gap_rank       ON gap_offers (gap_id, rank);
CREATE INDEX idx_offers_live           ON gap_offers (operator_id, status, expires_at);
CREATE INDEX idx_offers_client         ON gap_offers (client_id, created_at);
CREATE INDEX idx_offers_lead           ON gap_offers (lead_id);
-- One candidate row per (gap, client, lead). COALESCE keeps client-kind rows
-- unique too, since lead_id is NULL there and NULLs don't collide otherwise.
CREATE UNIQUE INDEX idx_offers_gap_cand
  ON gap_offers (gap_id, client_id, COALESCE(lead_id, ''));
-- The double-booking guard: at most one accepted offer per gap.
CREATE UNIQUE INDEX idx_offers_one_accept ON gap_offers (gap_id)
  WHERE status = 'accepted';

-- ---------------------------------------------------------------------------
-- 11. Messages
-- ---------------------------------------------------------------------------
CREATE TABLE messages (
  id             TEXT PRIMARY KEY,
  operator_id    TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  client_id      TEXT REFERENCES clients(id) ON DELETE SET NULL,
  offer_id       TEXT REFERENCES gap_offers(id) ON DELETE SET NULL,

  direction      TEXT NOT NULL CHECK (direction IN ('out','in')),
  -- 'device' = handed to the operator's own phone as an sms: link. We record
  -- that we generated it, not that a carrier delivered it.
  channel        TEXT NOT NULL DEFAULT 'device'
                   CHECK (channel IN ('device','sms','email','whatsapp')),
  to_address     TEXT NOT NULL,
  from_address   TEXT,
  body           TEXT NOT NULL,

  provider       TEXT,
  provider_sid   TEXT,
  status         TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','handed_off','sent','delivered','failed','received')),
  error_code     TEXT,
  cost_cents     INTEGER NOT NULL DEFAULT 0,

  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_messages_sid ON messages (provider_sid)
  WHERE provider_sid IS NOT NULL;
CREATE INDEX idx_messages_offer  ON messages (offer_id);
CREATE INDEX idx_messages_client ON messages (client_id, created_at);

-- ---------------------------------------------------------------------------
-- 12. Distance cache — cost control on the drive-time API
-- ---------------------------------------------------------------------------
CREATE TABLE distance_cache (
  cache_key        TEXT PRIMARY KEY,
  origin_lat       REAL NOT NULL,
  origin_lng       REAL NOT NULL,
  dest_lat         REAL NOT NULL,
  dest_lng         REAL NOT NULL,
  mode             TEXT NOT NULL DEFAULT 'driving',
  duration_seconds INTEGER NOT NULL,
  distance_meters  INTEGER,
  provider         TEXT NOT NULL,
  fetched_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL
);
CREATE INDEX idx_distance_expiry ON distance_cache (expires_at);

-- ---------------------------------------------------------------------------
-- 13. API usage audit
-- ---------------------------------------------------------------------------
CREATE TABLE api_usage (
  id           TEXT PRIMARY KEY,
  operator_id  TEXT REFERENCES operators(id) ON DELETE SET NULL,
  provider     TEXT NOT NULL,
  units        INTEGER NOT NULL DEFAULT 1,
  occurred_at  INTEGER NOT NULL
);
CREATE INDEX idx_api_usage_window ON api_usage (provider, occurred_at);
