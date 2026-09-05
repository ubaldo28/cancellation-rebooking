/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  /**
   * Turnstile's public half, baked into the bundle at build time. Set for
   * production builds by web/.env.production, and absent from a plain `vite`
   * dev run — absent means no widget is drawn and no token is sent, and the
   * forms behave exactly as they did before the check existed.
   *
   * Drawing the widget is not the same as the check being enforced: that is
   * the Worker's TURNSTILE_SECRET, a separate value which is not set anywhere
   * yet. See web/src/lib/turnstile.ts and src/lib/turnstile.ts.
   */
  readonly VITE_TURNSTILE_SITE_KEY?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
