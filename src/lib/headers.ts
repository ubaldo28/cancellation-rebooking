/**
 * The security headers every response leaves with.
 *
 * There were none before this. Anything served from this origin — the built
 * React app, the server-rendered /near pages, the JSON API, an error — could
 * be framed by any site on the internet, which is all a phishing page needs:
 * the real product in an invisible iframe with the attacker's chrome around
 * it. So this is stamped in one place, at the entry point, rather than being
 * remembered route by route.
 *
 * Nothing here needs a paid plan or a zone setting. These are response headers
 * a Worker sets by itself, which is the whole point — this deploys to a
 * workers.dev subdomain today.
 */

/**
 * Where the front end actually loads from, read off the app rather than copied
 * from a template.
 *
 * THREE ENTRIES USED TO BE HERE AND ARE NOW GONE, WHICH IS THE MOST IMPORTANT
 * THING THIS COMMENT HAS TO SAY:
 *
 *   unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js  (was in script-src)
 *   unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css (was in style-src)
 *   fonts.googleapis.com                              (was in style-src)
 *   fonts.gstatic.com                                 (was in font-src)
 *
 * The two unpkg entries were as tight as a CDN source can be made: pinned to
 * one exact version, named down to the individual file rather than to the
 * host, and backed by a matching integrity= on the tag in web/index.html, for
 * the sound reason that unpkg serves every package ever published to npm — so
 * allowing the bare host would have turned "no inline script, no eval" into
 * "any package on npm, at any version". All of that care was answering the
 * wrong question. The tags lived in the SPA SHELL, which is the document every
 * app-drawn route is served from, so the REQUEST happened on every page
 * whatever the policy said about its contents: every visitor's IP address and
 * User-Agent reached unpkg.com and Google on the front page, on a cost guide,
 * on the terms of service, on the guest booking page — most of which have no
 * map on them and never did. A pinned URL and a hash protect against a
 * tampered file. Nothing in this file could protect against the fetch itself,
 * and in a GDPR market the fetch itself is the problem.
 *
 * So both are self-hosted now. MapLibre is `maplibre-gl` in web/package.json,
 * pinned to the same 5.24.0, dynamically imported by web/src/lib/map.ts so it
 * ships in a chunk only the two map components pull; the fonts are woff2 files
 * in web/public/fonts with @font-face rules at the top of web/src/styles.css.
 * Both are same-origin, so both are covered by 'self' and neither needs a
 * source of its own. THERE IS NOTHING LEFT TO KEEP IN STEP: the version that
 * used to be written in three places — this file, the src in web/index.html
 * and the hash beside it — is now written once, in a package.json, where a
 * dependency version belongs.
 *
 * What is genuinely somebody else's, and still named:
 *
 *   tiles.openfreemap.org the map's style JSON, vector tiles, glyphs and
 *                        sprites. MAP_STYLE in web/src/lib/map.ts is the one
 *                        URL both maps are built from — CityMap.tsx for the
 *                        city view, VanTrack.tsx for the van on its way. The
 *                        style and the .pbf tiles and glyphs are fetches, so
 *                        they need connect-src; the sprite sheet is an image,
 *                        so it needs img-src too. Allowing it in only one of
 *                        the two is the usual way to ship a map that renders
 *                        roads and no labels. This one is fetched only by a
 *                        page that is actually drawing a map, because the
 *                        library that fetches it is no longer on every page.
 *   challenges.cloudflare.com
 *                        Turnstile, the bot check in front of the public
 *                        forms. web/src/lib/turnstile.ts injects
 *                        turnstile/v0/api.js on the pages that need it, and
 *                        that script then draws the challenge inside an
 *                        iframe it creates. A script host and a frame host, so
 *                        two directives move and not one.
 *
 * CategoryArt.tsx draws its own SVG from coordinates and loads nothing; the
 * tile art it is now the fallback for is forty-eight .webp files under
 * web/public/art, drawn by tools/trade-art.html and rendered by `npm run art`,
 * so those are same-origin too. Vite's built JS and CSS, the fonts, the
 * manifest, the service worker and every photo (/api/public/photo/*) are
 * same-origin and covered by 'self'.
 */
const MAPS = 'https://tiles.openfreemap.org';
const TURNSTILE = 'https://challenges.cloudflare.com';

/**
 * Stripe, for the card form that runs ON THIS SITE.
 *
 * Three directives, and each one is load-bearing:
 *
 *   script-src  — js.stripe.com serves the loader the payment form needs.
 *   frame-src   — the card fields themselves are iframes served by Stripe, on
 *                 Stripe's origin, so the page around them never touches a
 *                 card number and could not read one if it tried. That
 *                 isolation is the entire reason this is safe to embed.
 *   connect-src — the fields talk to api.stripe.com directly. Without it the
 *                 form renders and the payment silently never completes.
 *
 * hooks.stripe.com is the third host and it was missing, which meant this
 * policy refused the bank's own authentication step. When a card needs 3-D
 * Secure, Stripe.js does not leave the page — it opens the issuer's challenge
 * in an iframe served from hooks.stripe.com, and frame-src is what decides
 * whether that iframe is allowed to exist. Without it the browser blocks the
 * frame, the customer sees the card form sit there, and the payment cannot be
 * completed by any route: the intents are created with
 * allow_redirects: 'never', so there is no redirect fallback to catch it. Every
 * customer whose bank asks — which in the UK and the EU is most of them — was
 * losing the sale at the last step, and nothing in our logs would say why.
 *
 * Note what is still NOT here: nothing that would let the browser be sent to a
 * hosted checkout page. The customer pays on roundtheway.app.
 */
const STRIPE_JS = 'https://js.stripe.com';
const STRIPE_API = 'https://api.stripe.com';
const STRIPE_3DS = 'https://hooks.stripe.com';

const CSP = [
  // Everything not named below is same-origin only.
  `default-src 'self'`,

  // Scripts: our own bundle, and nothing else of ours. MapLibre used to be
  // named here as one exact unpkg URL; it is bundled now, so it is covered by
  // 'self' along with every other chunk Vite emits — including the async one
  // the map components pull in, which is fetched from this origin like any
  // other. No 'unsafe-inline' and no 'unsafe-eval' — the bundle needs neither,
  // MapLibre included: it decodes tiles in a worker built from a blob URL
  // (see worker-src below), not by eval-ing anything.
  //
  // Crumbs.tsx and Trade.tsx do emit inline <script type="application/ld+json">
  // blocks. A data block like that is never executed, so the HTML spec stops
  // preparing it before the inline-script check runs and browsers do not
  // report it — verified in Chromium against the real pages before this was
  // written. That matters because the alternatives are all bad: the JSON is
  // built in the browser from the current origin and the page's own labels, so
  // there is no hash to pin, and a nonce cannot be minted for markup React
  // renders client-side. Turning on 'unsafe-inline' to bless a block that is
  // inert would hand every real XSS a way in to pay for structured data.
  //
  // The Turnstile host is here for api.js, the loader the booking and alert
  // forms pull in. Nothing else about it needs widening: the challenge's own
  // traffic is made by the document inside the iframe, which is served by
  // Cloudflare on its own origin under its own policy, so connect-src stays as
  // it is. If a future version of the widget ever fetches from the top
  // document, connect-src is the one to add and the symptom is a challenge
  // that renders and never resolves.
  `script-src 'self' ${TURNSTILE} ${STRIPE_JS}`,

  // Styles are the one place 'unsafe-inline' is allowed, deliberately and
  // narrowly. The /near pages inline their whole stylesheet (seo.ts embeds
  // STYLE in a <style> block, on purpose: a crawler must get the page in one
  // response), the /o/:token offer page does the same, and React writes inline
  // style attributes. It is confined to style-src and never appears in
  // script-src, because injected CSS is a defacement risk and injected script
  // is an account-takeover risk.
  //
  // Two third-party sources came out of this line: the pinned MapLibre
  // stylesheet on unpkg and fonts.googleapis.com. MapLibre's CSS is imported
  // by web/src/lib/map.ts and emitted by Vite as part of the map's own async
  // chunk; the @font-face rules are in web/src/styles.css. Both are ours now.
  `style-src 'self' 'unsafe-inline'`,
  // 'self' ALONE, AND THE WORD THAT IS MISSING IS fonts.gstatic.com. The woff2
  // files are in web/public/fonts and served from this origin, so a request to
  // any other font host is now, by definition, not something this site meant
  // to do — which is exactly what a directive this narrow is for.
  `font-src 'self'`,

  // data: for the inline SVG icons the bundle carries, blob: for images the
  // browser builds locally (map sprites, a photo preview before upload).
  //
  // 'self' ALREADY COVERS THE TILE ART, AND THAT IS WHY THIS LINE DID NOT
  // CHANGE WHEN IT LANDED. The forty-eight drawings under /art are .webp files
  // in web/public, served by this Worker from this origin alongside the fonts
  // and the bundle, exactly like every job photo at /api/public/photo/*. No
  // image host, no CDN, nothing generated at request time, and nothing that
  // needs a source of its own — which is the entire reason the pictures are
  // drawn here and committed rather than fetched from somewhere that would
  // have to be named on this line and trusted for the life of the site.
  `img-src 'self' data: blob: ${MAPS}`,
  `connect-src 'self' ${MAPS} ${STRIPE_API} ${STRIPE_JS}`,

  // MapLibre runs its tile decoding in a worker it creates from a blob URL.
  // Without this the map renders nothing at all.
  `worker-src 'self' blob:`,

  `manifest-src 'self'`,

  // What this page embeds, all of it somebody else's document on somebody
  // else's origin, and all of it deliberately unreachable from the page around
  // it: the Turnstile challenge, Stripe's card fields, and the bank's 3-D
  // Secure challenge that hooks.stripe.com serves when an issuer asks for one.
  // This used to be 'none' and every host here earned its place by something
  // breaking without it — a bare 'none' lets the widget load its script and
  // then render nothing at all, which is the confusing half-broken state
  // rather than a clean failure, and a missing hooks.stripe.com is the same
  // failure with money attached.
  `frame-src ${TURNSTILE} ${STRIPE_JS} ${STRIPE_3DS}`,
  // Nothing may embed us. Untouched by the line above and not to be confused
  // with it: frame-src is what this page is allowed to put in a frame,
  // frame-ancestors is who is allowed to put this page in one, and the second
  // is the phishing fix. X-Frame-Options below says the same thing again for
  // anything that predates frame-ancestors.
  `frame-ancestors 'none'`,
  `object-src 'none'`,

  // Forms post to this origin: the booking form on /near, the accept/decline
  // buttons on an offer link. A <base> tag would let injected markup redirect
  // every relative URL on the page, and nothing here sets one.
  `form-action 'self'`,
  `base-uri 'none'`,

  // Deliberately not here: upgrade-insecure-requests. Every URL the app builds
  // is already https or same-origin, and it would only get in the way of
  // running this on http://localhost.
].join('; ');

/**
 * Two years, subdomains included, no preload.
 *
 * THE REASON WRITTEN HERE BEFORE WAS TRUE AND IS NOT ANY MORE, which is worth
 * saying rather than quietly editing. It read: preloading is a submission to a
 * browser-vendor list keyed on the registrable domain, the registrable domain
 * here is workers.dev, and that is not ours to pin for everybody else sharing
 * it. Correct while this deployed to a workers.dev subdomain. It does not:
 * wrangler.toml routes roundtheway.app as a custom domain, so the registrable
 * domain IS ours and that objection has gone.
 *
 * Still no `preload`, for a different and smaller reason: it is close to a
 * one-way door. Submission asks that every host under roundtheway.app be
 * reachable over HTTPS forever, browsers ship the list in the binary, and
 * removal takes months to propagate — so it is a commitment about subdomains
 * this product has not created yet, made by a header. Two years of
 * includeSubDomains already gives every returning browser the guarantee; the
 * only thing preload adds is the very first request from a browser that has
 * never been here. That is a real gap and it is a deliberate trade, not an
 * oversight: add `; preload` and submit the domain the day somebody is
 * prepared to own every future subdomain being HTTPS-only.
 */
const HSTS = 'max-age=63072000; includeSubDomains';

/**
 * What may share a browsing-context group with this page.
 *
 * There was nothing here, which meant a page that opened this one — or that
 * this one opened — kept a live cross-origin `window` handle to it. That
 * handle is not nothing: it is what `window.opener` navigation abuse needs
 * (the opener is silently replaced with a copy of the sign-in page while the
 * person is looking at the popup), and it is the reference the whole XS-Leaks
 * family is built on — counting frames, watching navigations, timing a
 * response to tell "this business exists" from "it does not" through a window
 * that is not otherwise readable.
 *
 * `same-origin-allow-popups` rather than a bare `same-origin`, and the
 * difference is the half that matters here: bare `same-origin` also severs
 * popups THIS page opens, and `same-origin-allow-popups` keeps those working
 * while still refusing the relationship to anything that opened us. Nothing in
 * this product is meant to be opened as a cross-origin popup and talked to —
 * Turnstile draws in an iframe, Stripe's card fields and the bank's 3-D Secure
 * challenge are iframes under frame-src, and Connect onboarding is a full-page
 * redirect that comes back to /api/stripe/onboard/refresh — so nothing legible
 * is lost.
 *
 * Deliberately NOT joined by Cross-Origin-Embedder-Policy. COEP requires every
 * cross-origin subresource to opt in with CORP or CORS, and the page still has
 * three of those: tiles, glyphs and sprites from OpenFreeMap, Stripe's script,
 * and Turnstile's. We control none of their headers, so turning COEP on would
 * not harden the page — it would blank the map and the card form.
 *
 * That list is shorter than it was. MapLibre from unpkg, and the stylesheet
 * and woff2 files from Google, used to be on it; they are served from this
 * origin now, so they would satisfy COEP without anyone's cooperation. Three
 * remain, every one of them a service doing something we cannot do ourselves,
 * which is the bar a cross-origin subresource should have to clear.
 */
const COOP = 'same-origin-allow-popups';

/**
 * Powerful features are off unless the site uses them.
 *
 * geolocation is the exception and it is load-bearing: an operator's van sends
 * its position from navigator.geolocation.watchPosition (web/src/lib/ping.ts)
 * and the customer side asks for a fix to find who is working nearby. `(self)`
 * keeps it working on this origin and denies it to anything embedded. Denying
 * it outright would break tracking silently — the browser rejects the request
 * with no visible error and the van simply never moves on the map.
 *
 * payment is the other exception, and it was switched off while the checkout
 * depended on it. `payment=()` turns off the Payment Request API for this
 * document AND for everything it frames, which is precisely how Apple Pay and
 * Google Pay are offered: the wallet button is drawn inside Stripe's iframe and
 * that frame inherits this policy from us. So the intents ask Stripe for
 * automatic_payment_methods, Stripe offers the wallets, and the browser
 * refuses to let them exist — the buttons either never paint or fail on tap,
 * with no error anywhere that names the cause. `(self "https://js.stripe.com")`
 * grants it to this origin and to Stripe's frames and to nobody else, which is
 * the narrowest form that still lets a customer pay with the wallet they
 * already have.
 *
 * Photo upload is a file input, not a camera stream, so camera=() does not
 * touch it: capture= hands off to the OS picker and never calls getUserMedia.
 */
const PERMISSIONS_POLICY = [
  'geolocation=(self)',
  'accelerometer=()',
  'autoplay=()',
  'camera=()',
  'display-capture=()',
  'encrypted-media=()',
  'fullscreen=(self)',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'midi=()',
  `payment=(self "${STRIPE_JS}")`,
  'usb=()',
].join(', ');

export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-security-policy': CSP,
  'strict-transport-security': HSTS,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': PERMISSIONS_POLICY,
  'cross-origin-opener-policy': COOP,
});

/**
 * Stamp the headers on a response.
 *
 * A header already on the response wins. That is not politeness: the offer
 * page and the guest links send `referrer-policy: no-referrer` because the
 * URL itself is the secret, and quietly relaxing that to
 * strict-origin-when-cross-origin would leak a booking token to every host a
 * customer's page ever links out to.
 *
 * The response is rebuilt rather than mutated because responses that come back
 * from the assets binding or from the cache have immutable headers, and
 * set() on those throws.
 */
export function withSecurityHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
