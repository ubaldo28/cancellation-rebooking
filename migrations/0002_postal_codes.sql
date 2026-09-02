-- Offline postal-code geocoding, ~100 countries.
--
-- Why a table instead of an API:
--   * Nominatim's public API forbids this use outright — 1 req/sec, no
--     distributed scripts (a Worker is distributed by definition), and
--     commercial geocoding-dependent apps are told to run their own service.
--   * Paid geocoders cost per lookup, which breaks the $0 constraint.
--   * GeoNames publishes postal-code centroids for ~100 countries under
--     CC BY 4.0. Loaded here, lookups are free, instant, offline and unlimited.
--
-- Precision is a postal-code centroid, not a street address. That is the right
-- resolution for this product: ranking needs to know whether a client is eight
-- minutes away or forty, not which side of the road they park on.
--
-- ATTRIBUTION REQUIRED: CC BY 4.0 means the app must credit GeoNames visibly.
-- Put "Postcode data © GeoNames (CC BY 4.0)" in the dashboard footer and in
-- any public page that shows a map or distance. This is not optional.
--
-- Populate with: node scripts/build-postal-codes.mjs GB US CA AU ...
-- then:          wrangler d1 execute gapfiller --remote --file=./seed/postal_codes.sql

CREATE TABLE postal_codes (
  country_code   TEXT NOT NULL,     -- ISO-3166-1 alpha-2
  postal_code    TEXT NOT NULL,     -- normalised: uppercase, no spaces or hyphens
  place_name     TEXT,
  admin_name1    TEXT,              -- state / region, for display
  lat            REAL NOT NULL,
  lng            REAL NOT NULL,
  accuracy       INTEGER,           -- GeoNames 1-6; 6 = centroid of the code
  PRIMARY KEY (country_code, postal_code)
) WITHOUT ROWID;

CREATE INDEX idx_postal_country ON postal_codes (country_code);

-- Some countries publish only an outward/partial code (Ireland, Chile, China,
-- Malta, Argentina) or major codes only (Brazil). A prefix lookup still lands
-- a client in the right town, which is enough to rank them.
CREATE INDEX idx_postal_prefix ON postal_codes (country_code, substr(postal_code, 1, 4));
