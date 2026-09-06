# What people actually hire, and what this catalogue was missing

Measured 6 September 2026 from Thumbtack's own sitemaps
(`sitemap_services_0..7.xml.gz`), which list every published service page:
**398,860 pages across 530 service categories**. Each URL carries the category
in its path, so counting them gives the number of pros Thumbtack has published
in each category — a supply ranking of the whole US home-services market,
straight from the marketplace rather than from an article about it.

282 categories have 100 or more pros. This is the top of that list.

| Category | Pros | In our catalogue before? |
|---|---:|---|
| house-cleaning | 50,934 | yes |
| handyman | 41,149 | yes |
| general-contractors | 15,733 | no — crew work, deliberately still out |
| interior-painting | 14,810 | **no** |
| lawn-care | 12,366 | partly (landscaping) |
| junk-removal | 10,893 | yes |
| electrical-repairs | 10,077 | **no** |
| moving-companies | 7,880 | **no** |
| roofing | 7,675 | no — crew work, deliberately still out |
| pressure-washing | 5,560 | yes |
| plumbing | 5,112 | **no** |
| central-air-conditioning-repair | 4,659 | **no** |
| hardwood-floor-installation | 4,603 | **no** |
| furniture-assembly | 4,092 | **no** |
| notary-public | 3,931 | yes |
| appliance-repair | 3,723 | yes |
| drywall-repair | 3,157 | **no** |
| tree-trimming | 3,072 | yes |
| tv-mounting | 2,766 | **no** |
| makeup-artists | 2,745 | yes |
| personal-organizers | 2,736 | **no** |
| djs | 2,557 | **no** |
| personal-chefs | 2,297 | **no** |
| carpet-cleaning | 2,042 | yes |
| window-cleaning | 1,783 | yes |
| swimming-pool-maintenance | 1,630 | yes |
| garage-door-repair | 1,584 | **no** |
| locksmiths | 1,343 | yes |
| exterminators | 1,339 | yes |
| pet-sitting | 1,221 | **no** |
| mobile-auto-detailing-services | 1,066 | yes |
| mobile-auto-repair | 932 | yes |
| dog-grooming | 632 | yes |

## What that says

The catalogue was written from the idea of a **van**: detailing, food trucks, a
mobile bookstore, a farmer's market stall. Ranked against real supply, that is a
picture of a niche inside the market rather than the market. Six of the eight
largest categories on Thumbtack were absent, and the pop-up retail category we
did have — bookstore, fashion truck, farmer's market — does not exist on
Thumbtack at all, because it is not a thing people book an appointment for.

Two categories are large and still deliberately excluded. **General contractors**
(15,733) and **roofing** (7,675) are crew work with multi-day jobs and site
visits before a price exists. Nothing about an hourly slot on a route map fits
them, and pretending otherwise would put an operator in front of a customer
expecting a booking they cannot honour.

The pop-up retail trades were kept rather than removed. Removing a slug orphans
every operator already using it, and none of them is doing harm — they are just
not where the demand is.

## Method, so this can be redone

```js
// In a browser on thumbtack.com, because the sitemaps are gzipped:
const grab = async (u) => {
  const r = await fetch(u);
  return new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).text();
};
const urls = new Set();
for (let i = 0; i < 8; i++)
  for (const m of (await grab(`https://www.thumbtack.com/sitemap_services_${i}.xml.gz`))
    .matchAll(/<loc>([^<]+)<\/loc>/g)) urls.add(m[1]);

// /{state}/{city}/{category}/{business}/service/{id}
const counts = new Map();
for (const u of urls) {
  const c = new URL(u).pathname.split('/').filter(Boolean)[2];
  counts.set(c, (counts.get(c) || 0) + 1);
}
[...counts].sort((a, b) => b[1] - a[1]);
```

Worth repeating occasionally. It is a free read of what the largest competitor
has supply in, and supply is the closest public proxy for demand they publish.

## What was added

Thirty-two trades, in `src/lib/trades.ts`, each with its own California
licensing answer in `src/lib/credentials.ts`. A new **Repairs and installation**
category holds the licensed building trades, because their licensing answer has
the same shape and it is the thing an operator most needs to read before taking
a booking.

Three of those answers are not the contractors board at all, and they are the
ones people get wrong:

- **Movers** are licensed by the **CPUC**, not CSLB — a Household Mover Permit,
  required from the first job rather than above a threshold.
- **HVAC** carries **EPA Section 608** certification federally, for anyone
  opening a system with refrigerant in it, at any job value.
- **Painting** in housing built before 1978 requires **lead-safe**
  certification, and most of the housing stock in the coverage area is older
  than that.
