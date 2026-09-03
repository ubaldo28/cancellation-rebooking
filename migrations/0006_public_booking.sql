-- Public discovery and booking.
--
-- Until now a slot could only be filled by someone already on the operator's
-- client list. This opens slots to people who have never heard of the operator,
-- which is the part that actually grows their business.
--
-- The offer a stranger sees is not "here is a detailer" — every directory has
-- that. It is "a van is already coming to your street on Thursday", which is
-- only possible because we know where the jobs either side of the gap are.

-- Where an operator is willing to work. A gap is only ever shown to someone
-- inside one of these.
CREATE TABLE service_areas (
  id             TEXT PRIMARY KEY,
  operator_id    TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,          -- 'Sherman Oaks'
  slug           TEXT NOT NULL,          -- 'sherman-oaks'
  lat            REAL NOT NULL,
  lng            REAL NOT NULL,
  radius_meters  INTEGER NOT NULL DEFAULT 8000,
  is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_areas_slug ON service_areas (slug, is_active);
CREATE INDEX idx_areas_operator ON service_areas (operator_id, is_active);

-- Operators opt in. Nobody's calendar becomes public by accident.
ALTER TABLE operators ADD COLUMN accept_public_bookings INTEGER NOT NULL DEFAULT 0
  CHECK (accept_public_bookings IN (0,1));

-- What a stranger pays to hold the slot. This is the platform's only fee, and
-- it comes off the job price — the operator collects the balance as usual, so
-- we never hold their money.
ALTER TABLE operators ADD COLUMN deposit_cents INTEGER NOT NULL DEFAULT 1000;

-- Where a client came from. 'public' clients were never on the operator's list;
-- they are the ones the platform actually earned.
ALTER TABLE clients ADD COLUMN acquired TEXT NOT NULL DEFAULT 'operator'
  CHECK (acquired IN ('operator','public'));

CREATE INDEX idx_clients_acquired ON clients (operator_id, acquired);

-- A public claim on a slot, before it becomes an appointment. Kept separate
-- from gap_offers because that table is for people the operator already knows.
CREATE TABLE public_claims (
  id              TEXT PRIMARY KEY,
  operator_id     TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  gap_id          TEXT NOT NULL REFERENCES gaps(id) ON DELETE CASCADE,
  service_id      TEXT REFERENCES services(id) ON DELETE SET NULL,
  client_id       TEXT REFERENCES clients(id) ON DELETE SET NULL,
  appointment_id  TEXT REFERENCES appointments(id) ON DELETE SET NULL,

  first_name      TEXT NOT NULL,
  phone_e164      TEXT NOT NULL,
  email           TEXT,
  address_line    TEXT,
  postcode        TEXT,
  lat             REAL,
  lng             REAL,

  -- Frozen at claim time so the fee can be reconciled later.
  detour_seconds  INTEGER,
  price_cents     INTEGER,
  deposit_cents   INTEGER,

  status          TEXT NOT NULL DEFAULT 'confirmed'
                    CHECK (status IN ('confirmed','cancelled','completed','no_show')),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_claims_operator ON public_claims (operator_id, created_at);
CREATE UNIQUE INDEX idx_claims_gap ON public_claims (gap_id)
  WHERE status = 'confirmed';
