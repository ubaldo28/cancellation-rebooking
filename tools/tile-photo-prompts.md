# Tile photos — Round The Way

## The size

**500 × 500 pixels, square.** That is exactly what Thumbtack serves: a 500×500
source cropped by the browser into a tile that measures 225 × 290 CSS pixels.
This site is now built the same way, so a square photo is all you ever have to
make. The site crops it three ways on its own:

| Where | What it shows |
|---|---|
| Front page, /browse, category page | the tall 225×290 tile |
| Top of a category page | a wide band cut out of the middle |

jpg, png or webp all go in. Don't bother resizing or converting — the script
below does it. Just keep the subject near the middle, because every crop is
taken from the centre.

## Getting them onto the site

1. Save each photo into `art-source/` in the project folder, named after the
   tile: `art-source/mobile-locksmith.jpg`, `art-source/cat-auto.jpg`. The
   names are listed below.
2. Run:

```
npm run photos
```

It prints what it replaced, what it skipped because the name was not a tile,
and which tiles are still on the placeholder drawing. Run it as many times as
you like — do five today and five tomorrow.

## The prompts

One per tile. Every one ends with the same style clause so the set looks like
one set:

    photorealistic photograph, square 1:1 framing, subject centred,
    natural daylight, shallow depth of field, clean uncluttered background,
    no text, no logos, no watermark

Shorthand: `+STYLE` means append that clause.

### Services (39)

| Save as | Prompt |
|---|---|
| `appliance-repair` | A technician kneeling beside an open washing machine in a home laundry room, tools on the floor. +STYLE |
| `auto-glass-repair` | Gloved hands fitting a replacement windshield onto a car in a residential driveway. +STYLE |
| `bike-repair-service` | A mobile bike mechanic truing a wheel on a repair stand on a suburban sidewalk. +STYLE |
| `carpet-cleaning` | A carpet cleaning wand leaving a clean stripe across a beige living-room carpet. +STYLE |
| `coffee-and-smoothie-trucks` | A small coffee trailer with its serving window open on a sunny street corner. +STYLE |
| `dessert-trucks` | A pastel dessert truck at a kerb with its hatch open and an ice cream display inside. +STYLE |
| `dryer-vent-cleaning` | A technician feeding a long brush into a dryer vent on the outside wall of a house. +STYLE |
| `fashion-boutique-trucks` | A box truck fitted out as a clothing boutique, a rack of garments through the open back. +STYLE |
| `food-trucks` | A food truck serving a short queue of customers on a city street at golden hour. +STYLE |
| `gutter-cleaning` | A worker on a ladder scooping leaves out of a house gutter against a blue sky. +STYLE |
| `handyman-and-repair-services` | A handyman with a tool belt fixing a cabinet hinge in a bright kitchen. +STYLE |
| `house-cleaning` | A cleaner in an apron wiping a kitchen counter in a tidy sunlit home. +STYLE |
| `junk-removal` | Two workers loading an old sofa and boxes into an open truck bed outside a house. +STYLE |
| `landscaping-and-gardening` | A gardener pushing a mower across a green front lawn, trimmed hedge behind. +STYLE |
| `mobile-bar-service` | A bartender pouring a cocktail at a compact mobile bar set up outdoors. +STYLE |
| `mobile-bookstore` | A small van converted into a bookshop, shelves of books through the open side doors. +STYLE |
| `mobile-car-wash-and-detailing` | A detailer washing a car with a foam-covered mitt in a home driveway. +STYLE |
| `mobile-dog-gym` | A dog mid-stride over a low agility hurdle on a grass lawn. +STYLE |
| `mobile-farmer-s-market` | A produce stall on the back of a truck, crates of vegetables stacked neatly. +STYLE |
| `mobile-hair-salon-or-barbershop` | A barber clipping a client's hair in a fitted-out van, mirror and chair visible. +STYLE |
| `mobile-locksmith` | A locksmith cutting a key on a bench machine inside a service van. +STYLE |
| `mobile-makeup-artist` | A makeup artist applying foundation to a seated client by a window, brushes nearby. +STYLE |
| `mobile-notary` | Two pairs of hands signing a document at a kitchen table, pen and stamp beside it. +STYLE |
| `mobile-oil-change-and-mechanics` | A mechanic draining oil under a car jacked up in a driveway, drain pan in place. +STYLE |
| `mobile-pet-grooming` | A groomer trimming a small fluffy dog on a grooming table inside a van. +STYLE |
| `mobile-photography-and-photo-booths` | A photographer holding a camera to their eye beside a simple backdrop at an event. +STYLE |
| `mobile-pressure-washing` | A worker pressure-washing a concrete driveway, clean strip and spray mist visible. +STYLE |
| `mobile-spa-and-massage` | A folding massage table made up with clean linen, rolled towel and oil bottle. +STYLE |
| `mobile-tyre-fitting` | A technician fitting a new tyre onto a wheel beside a car at the roadside. +STYLE |
| `mobile-veterinary-service` | A vet examining a dog with a stethoscope on a table in a mobile clinic. +STYLE |
| `personal-fitness-training` | A trainer coaching a client through a kettlebell squat in a garage gym. +STYLE |
| `pest-control` | A pest control technician spraying along the skirting board of a kitchen. +STYLE |
| `phone-and-tablet-repair` | Hands replacing a cracked phone screen with tweezers on a repair mat. +STYLE |
| `pool-service` | A pool technician skimming leaves from the surface of a backyard swimming pool. +STYLE |
| `tech-support` | A technician working inside an opened laptop at a desk, small screwdriver in hand. +STYLE |
| `trash-can-cleaning` | A wheelie bin being pressure-washed on a driveway, water and foam draining away. +STYLE |
| `tree-and-shrub-trimming` | An arborist in a harness pruning a branch with a handsaw partway up a tree. +STYLE |
| `tutoring` | A tutor and a teenage student working through a workbook at a dining table. +STYLE |
| `window-cleaning` | A window cleaner drawing a squeegee down a house window, clean glass behind. +STYLE |

### Category tiles (9)

| Save as | Prompt |
|---|---|
| `cat-all` | A clean white service van parked on a quiet residential street, morning light. +STYLE |
| `cat-auto` | A mechanic working on a car with the bonnet up in a bright workshop. +STYLE |
| `cat-beauty` | A stylist finishing a client's hair in a bright salon chair. +STYLE |
| `cat-food` | A street food stall serving fresh food, steam rising from the griddle. +STYLE |
| `cat-home` | A tidy sunlit living room with a cleaning caddy and vacuum in the foreground. +STYLE |
| `cat-pets` | A groomer brushing a happy dog outdoors on a sunny day. +STYLE |
| `cat-retail` | A market stall of goods with a vendor arranging the display. +STYLE |
| `cat-services` | A tradesperson in work clothes loading tools into a van, smiling. +STYLE |
| `cat-tech` | Two technicians repairing laptops at a workbench. +STYLE |
