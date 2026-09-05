-- One pin per neighbourhood, not one per business.
--
-- service_areas.slug has to be globally unique because it is a public URL, so
-- the second detailer to cover Sherman Oaks gets "sherman-oaks-2". Grouping the
-- public map on that column put a separate pin on the map for every business,
-- stacked on the same spot, each claiming to be a different place.
--
-- place_slug is the shared neighbourhood key: every business covering Sherman
-- Oaks stores "sherman-oaks" here. The map groups on it, so a visitor sees one
-- Sherman Oaks pin with every trade working there underneath it.
ALTER TABLE service_areas ADD COLUMN place_slug TEXT;

-- Backfill from the name, matching the slug rules used when an area is created.
UPDATE service_areas
   SET place_slug = trim(
         replace(replace(replace(replace(replace(replace(replace(replace(
           lower(name),
           ' ', '-'), '.', ''), ',', ''), '''', ''), '/', '-'), '(', ''), ')', ''), '--', '-'),
         '-')
 WHERE place_slug IS NULL;

CREATE INDEX idx_areas_place ON service_areas (place_slug, is_active);
