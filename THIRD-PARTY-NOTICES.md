# Third-party notices

Other people's work is in this product, and some of them ask to be named for
it. This file is where that happens.

It is organised by **what the obligation actually is**, not by what looks
thorough, because a notices file that credits everything equally is one nobody
can use: the reader cannot tell which line is a licence condition and which is
a courtesy, so the first person to tidy it deletes the wrong one. Each entry
below says plainly which it is.

Two of these are also printed in the site's own footer — the OpenStreetMap and
GeoNames credits — because a notice in a repository file is not a notice to a
visitor. The footer is written out twice, in `web/src/components/SiteFooter.tsx`
and in `src/lib/seo.ts`; both say the same words and both link the licences.

---

## Required: code this site redistributes

The React app in `web/` is bundled by Vite into `web/dist/assets/*.js`, and
those files are served from roundtheway.app by the same Worker that answers
`/api/*`. Serving them is redistribution, so the notices below travel with them
and are reproduced here.

The bundle keeps each library's own `@license` banner — esbuild preserves legal
comments — so the copyright lines are already inside the file a visitor
downloads. What the banners do not carry is the text of the licence itself:
each one points at a `LICENSE` file in a source tree the visitor does not have.
This file is that text.

**This section grew, and why it grew is the point of the change that grew it.**
MapLibre GL JS and the three typefaces used to be somebody else's CDN problem,
listed further down under "not redistributed here" — the visitor's browser
fetched them from unpkg.com and from Google, and no condition in their licences
was triggered by anything in this repository. That arrangement was also a
third-party request on every single page load, handing the visitor's IP address
and User-Agent to two companies with nothing to do with the page being asked
for. They are served from this origin now. Taking on the redistribution
condition is the price of that, and it is a cheap one: it costs two entries in
this file and three licence files in `web/public/fonts`.

### React — MIT

React, React DOM, the JSX runtime and the scheduler, version 18.3.1.

```
Copyright (c) Facebook, Inc. and its affiliates.
```

### React Router — MIT

React Router 6.30.6, React Router DOM 6.30.6 and `@remix-run/router` 1.23.4.

```
Copyright (c) Remix Software Inc.
```

### The MIT licence, for both React entries above

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### MapLibre GL JS — BSD-3-Clause

MapLibre GL JS 5.24.0 draws both maps. It used to be fetched by the visitor's
browser from `https://unpkg.com/maplibre-gl@5.24.0/dist/`, which is why it was
listed further down this file as something not redistributed here. **That is no
longer true.** It is a dependency in `web/package.json`, Vite bundles it into
`web/dist/assets/maplibre-gl-*.js` and `maplibre-gl-*.css`, and the Worker
serves both from roundtheway.app. Serving it is redistribution, so the licence
travels with it and is reproduced here.

```
Copyright (c) 2023, MapLibre contributors

All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright notice,
      this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright notice,
      this list of conditions and the following disclaimer in the documentation
      and/or other materials provided with the distribution.
    * Neither the name of MapLibre GL JS nor the names of its contributors
      may be used to endorse or promote products derived from this software
      without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR
CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

MapLibre's own `LICENSE.txt` carries three further notices for code it
contains — mapbox-gl-js v1.13 and earlier (BSD-3-Clause, Copyright (c) 2020,
Mapbox), glfx.js (MIT, Copyright (C) 2011 by Evan Wallace) and a portion of
d3-color (BSD-3-Clause, Copyright 2010-2016 Mike Bostock). They are reproduced
in full in that file, which is now in this tree at
`web/node_modules/maplibre-gl/dist/LICENSE.txt` and is the copy that governs.

### Inter, IBM Plex Mono, Saira Stencil One — SIL OFL 1.1

The three typefaces the site sets text in. They used to be requested from
Google Fonts by a stylesheet link in `web/index.html`; the woff2 files are in
`web/public/fonts` now, served from roundtheway.app, and the `@font-face` rules
that name them are at the top of `web/src/styles.css`. Thirteen files, being
only the weights and subsets the stylesheets actually render:

| Family | Weights | Subsets |
| --- | --- | --- |
| Inter | 400, 500, 600, 700, 800 | latin, latin-ext |
| IBM Plex Mono | 500, 600 | latin |
| Saira Stencil One | 400 | latin |

They are the woff2 subset files Google Fonts itself serves, taken from the
`@fontsource` packages on npm, which repackage them unmodified from
<https://github.com/google/fonts>. Nothing here has been subsetted, renamed or
otherwise altered by this project.

**The OFL's condition bites here in a way it did not before.** While Google
served the files, this repository redistributed nothing and the licence asked
nothing of it. Serving them ourselves is redistribution of the Font Software,
so each family's licence travels with it: the full OFL 1.1 text, carrying that
family's own copyright line, sits beside the fonts and is served alongside them
as

- `web/public/fonts/OFL-Inter.txt`
- `web/public/fonts/OFL-IBM-Plex-Mono.txt`
- `web/public/fonts/OFL-Saira-Stencil-One.txt`

Those three files are the notice. The copyright lines they open with are, in
order, `Copyright 2016 The Inter Project Authors`, `Copyright 2017 IBM Corp.`
and `Copyright 2019 The Saira Stencil Project Authors` — each reproduced there
exactly as it ships, with the per-file detail that follows it. No Reserved Font
Name is used, and none of the three faces is sold, on its own or otherwise.


---

## Required: data the site shows

### OpenStreetMap, through OpenFreeMap — ODbL

Every map on the site is OpenStreetMap data. The vector tiles come from
OpenFreeMap (`https://tiles.openfreemap.org/styles/positron`, see
`web/src/lib/map.ts`), which needs no key and no account; the underlying data
is licensed by the OpenStreetMap Foundation under the Open Database License,
and the ODbL requires that the source be credited wherever the data is shown.

The credit is `Map data © OpenStreetMap contributors`, linking to
<https://www.openstreetmap.org/copyright>, and it appears in two places: in the
site footer on every page, and on the map itself, which MapLibre draws from the
style's own attribution field without either map component writing it.

This project does not host or redistribute the tiles. A visitor's browser
fetches them from OpenFreeMap directly, which is also why OpenFreeMap is named
in the privacy policy's list of companies a visitor's browser talks to.

### GeoNames postcode centroids — CC BY 4.0

Postcodes are resolved to a point using GeoNames' postal-code extract
(<https://download.geonames.org/export/zip/>), built into the `postal_codes`
table by `scripts/build-postal-codes.mjs` and defined in
`migrations/0002_postal_codes.sql`. Both files already carry the same warning
this section does.

CC BY 4.0 requires the creator to be named and requires a link to the licence
where that is reasonably practicable. On an HTML page it is entirely
practicable, so the footer credits GeoNames and links
<https://creativecommons.org/licenses/by/4.0/>. The centroids are used as
supplied; nothing here alters them.

---

## Not redistributed here, named anyway

None of these is served from roundtheway.app. A visitor's browser fetches each
one from somebody else's CDN, so the redistribution conditions in their
licences are not triggered by anything this repository does. They are listed
because they are part of the product a visitor runs, and because the next
person to ask "what is in this thing?" should not have to read the CSP to find
out.

**There used to be three entries here and now there is one.** MapLibre GL JS
and the three typefaces have moved up into "code this site redistributes",
because that is what they are now: the CDN fetches that put them in this
section were removed, and with them the third-party request every visitor was
making on every page in order to satisfy them. What is left is the one that
cannot move — Stripe.js is not open source and may only be loaded from
Stripe's own origin.

### Stripe.js

The payment form and the card-capture form load `https://js.stripe.com/v3/`
(`web/src/components/PayForm.tsx` and `CardField.tsx`). Card details are typed
into Stripe's own iframe and reach Stripe directly; this Worker never sees
them. Stripe.js is not open source and is not redistributed — it is used under
Stripe's terms of service, and it may only be loaded from `js.stripe.com`,
which is why `src/lib/headers.ts` allows that origin and no copy is vendored.

---

## Courtesy, not obligation

### Pirata One — SIL OFL 1.1

The `RTW` mark in `web/public/icon.svg` is the real outlines of Pirata One,
converted to paths once because a favicon cannot load a webfont and text set in
an SVG icon renders in whatever the operating system feels like. The comment
inside that file says the same thing.

**The OFL does not require this credit.** Outlines embedded in a piece of
artwork are not a redistribution of the Font Software: the OFL FAQ says so
directly at questions 1.10 and 1.11, which deal with exactly this case — using
a font to create a logo and then distributing that logo. No reserved font name
is being used, no font file is being passed on, and nothing in the licence
attaches to the resulting drawing.

It is credited here anyway, because somebody drew that face and the mark is
their letterforms. That is the whole reason for the entry, and it should not be
rewritten into a claim that the licence demanded it.

---

## Build-time tools

The root `package.json` has four devDependencies and `web/package.json` has
five; none of them appears in anything served to a visitor. A compiler, a test
runner, a bundler and a deployment CLI are tools used to make the product, not
parts of it, and their licences ask nothing of a project that merely runs them.
They are deliberately not listed. The FOUR runtime dependencies in
`web/package.json` do ship, and they are the React, React Router and MapLibre
entries at the top of this file. It was three until MapLibre stopped being a
CDN URL and became one of them.

---

## Trademarks

Vehicle makes and models are named throughout the product — `Transit`,
`Sprinter` and `ProMaster` in the vehicle picker's hint text
(`src/lib/vehicles.ts`), and `Ford` and `Transit` as placeholders in the
vehicle form (`web/src/components/VehicleForm.tsx`).

They are used to describe vehicles, which is what those words are for: naming
somebody's product in order to say which product you mean is the ordinary,
permitted use of a mark. No affiliation, sponsorship or endorsement is claimed
or implied by any of them, and none of these companies has anything to do with
this site.

Those marks belong to their respective owners. The site footer says so in one
line, and this is the longer version of that line.
