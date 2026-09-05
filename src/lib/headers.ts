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
 * from a template. In order of how they got here:
 *
 *   unpkg.com            web/index.html loads maplibre-gl 5 (script + css)
 *                        from the CDN instead of bundling it.
 *   fonts.googleapis.com the stylesheet link in web/index.html,
 *   fonts.gstatic.com    and the woff2 files that stylesheet points at.
 *   tiles.openfreemap.org the map's style JSON, vector tiles, glyphs and
 *                        sprites (CityMap.tsx). The style and the .pbf tiles
 *                        and glyphs are fetches, so they need connect-src;
 *                        the sprite sheet is an image, so it needs img-src
 *                        too. Allowing it in only one of the two is the usual
 *                        way to ship a map that renders roads and no labels.
 *   challenges.cloudflare.com
 *                        Turnstile, the bot check in front of the public
 *                        forms. web/src/lib/turnstile.ts injects
 *                        turnstile/v0/api.js on the pages that need it, and
 *                        that script then draws the challenge inside an
 *                        iframe it creates. A script host and a frame host, so
 *                        two directives move and not one.
 *
 * ValleyMap.tsx draws its own SVG from coordinates and loads nothing.
 * Vite's built JS and CSS, the manifest, the service worker and every photo
 * (/api/public/photo/*) are same-origin and covered by 'self'.
 */
const MAPS = 'https://tiles.openfreemap.org';
const CDN = 'https://unpkg.com';
const FONT_CSS = 'https://fonts.googleapis.com';
const FONT_FILES = 'https://fonts.gstatic.com';
const TURNSTILE = 'https://challenges.cloudflare.com';

const CSP = [
  // Everything not named below is same-origin only.
  `default-src 'self'`,

  // Scripts: our own bundle, plus MapLibre from the CDN the page loads it
  // from. No 'unsafe-inline' and no 'unsafe-eval' — the bundle needs neither.
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
  `script-src 'self' ${CDN} ${TURNSTILE}`,

  // Styles are the one place 'unsafe-inline' is allowed, deliberately and
  // narrowly. The /near pages inline their whole stylesheet (seo.ts embeds
  // STYLE in a <style> block, on purpose: a crawler must get the page in one
  // response), the /o/:token offer page does the same, and React writes inline
  // style attributes. It is confined to style-src and never appears in
  // script-src, because injected CSS is a defacement risk and injected script
  // is an account-takeover risk.
  `style-src 'self' ${CDN} ${FONT_CSS} 'unsafe-inline'`,
  `font-src 'self' ${FONT_FILES}`,

  // data: for the inline SVG icons the bundle carries, blob: for images the
  // browser builds locally (map sprites, a photo preview before upload).
  `img-src 'self' data: blob: ${MAPS}`,
  `connect-src 'self' ${MAPS}`,

  // MapLibre runs its tile decoding in a worker it creates from a blob URL.
  // Without this the map renders nothing at all.
  `worker-src 'self' blob:`,

  `manifest-src 'self'`,

  // The one thing this page embeds is the Turnstile challenge, and it has to
  // be an iframe: the whole point of the widget is that its contents are not
  // reachable from the page around it. This used to be 'none' and the host is
  // the only entry — a bare 'none' would let the widget load its script and
  // then render nothing at all, which is the confusing half-broken state
  // rather than a clean failure.
  `frame-src ${TURNSTILE}`,
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
 * Preloading is a submission to a browser-vendor list keyed on the registrable
 * domain, and the registrable domain here is workers.dev — not ours to pin for
 * everybody else on it. The header still does its job for this host.
 */
const HSTS = 'max-age=63072000; includeSubDomains';

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
  'payment=()',
  'usb=()',
].join(', ');

export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-security-policy': CSP,
  'strict-transport-security': HSTS,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': PERMISSIONS_POLICY,
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
