import { describe, expect, it } from 'vitest';
import { clientSource } from './client-source';

/**
 * The site's public address is written down twice, and the two copies have to
 * agree.
 *
 * `routes` in wrangler.toml is the hostname the Worker actually answers on.
 * `APP_URL` is the hostname the Worker *says* it lives at: it goes into every
 * sign-in link, every canonical tag and the sitemap. Nothing at deploy time
 * compares them, so if one is changed and the other is not, the deploy
 * succeeds, the site loads, and the only symptom is that the links people are
 * emailed point at a hostname that does not resolve — discovered by a customer
 * who cannot sign in, not by anybody here.
 *
 * That is exactly what a rename does. This is the check that makes the second
 * half of a rename impossible to forget.
 */
describe('public address', () => {
  const toml = clientSource('wrangler.toml');

  /** The hostname out of `pattern = "..."` in the routes list. */
  const routeHost = toml.match(/pattern\s*=\s*"([^"]+)"/)?.[1];

  /** The hostname out of the production `APP_URL`. */
  const appUrlHost = (() => {
    const raw = toml.match(/^APP_URL\s*=\s*"([^"]+)"/m)?.[1];
    return raw ? new URL(raw).host : undefined;
  })();

  it('declares a custom domain for the Worker', () => {
    expect(routeHost).toBeTruthy();
    expect(toml).toMatch(/custom_domain\s*=\s*true/);
  });

  it('sets APP_URL', () => {
    expect(appUrlHost).toBeTruthy();
  });

  it('serves on the same hostname it tells people about', () => {
    expect(appUrlHost).toBe(routeHost);
  });

  it('uses https for the public address', () => {
    expect(toml).toMatch(/^APP_URL\s*=\s*"https:\/\//m);
  });

  it('allows its own origin through CORS', () => {
    const allowed = toml.match(/^ALLOWED_ORIGINS\s*=\s*"([^"]+)"/m)?.[1] ?? '';
    expect(allowed.split(',').map((s) => s.trim())).toContain(`https://${routeHost}`);
  });
});
