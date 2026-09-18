import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        /**
         * THE FRAMEWORK AND THE SITE ARE TWO FILES, NOT ONE.
         *
         * React, React DOM and the router are the only things in
         * node_modules that reach the browser, they are roughly a third of
         * what ships, and they change when a dependency is upgraded — which
         * is perhaps twice a year. The rest of this bundle changes every time
         * anybody edits a page. Emitting them together meant every deploy
         * invalidated the framework along with the change, so a returning
         * visitor re-downloaded React because a paragraph on a cost guide had
         * been reworded.
         *
         * Splitting them costs one extra request on a cold visit and both are
         * fetched in parallel from the same origin. It is not a way of sending
         * fewer bytes the first time — the lazy routes in App.tsx are that —
         * it is a way of not sending these bytes again.
         *
         * Matched on the path rather than on a list of package names so that
         * a dependency added later is in the right chunk without anybody
         * having to remember this file exists.
         *
         * MAPLIBRE IS THE ONE EXCEPTION, AND WITHOUT IT THIS RULE WOULD HAVE
         * QUIETLY UNDONE THE CHANGE THAT ADDED IT.
         *
         * "React, React DOM and the router are the only things in node_modules
         * that reach the browser" was true when it was written and stopped
         * being true the day maplibre-gl became a dependency — it used to come
         * from unpkg.com through a script tag in web/index.html, and it now
         * comes from here. The sentence above is the whole problem: `vendor` is
         * a STATIC import of the entry chunk, because React is in it, so every
         * package this predicate sweeps into `vendor` is downloaded on every
         * page. Sweeping in 800 kB of map library would mean the front page,
         * the cost guides, the terms of service and the guest booking page all
         * fetching MapLibre — which is what loading it from a CDN in the shell
         * already did, only from our own origin. The privacy win would have
         * survived; the performance win, which is the larger half, would have
         * been thrown away in one line of build config.
         *
         * Returning undefined for it leaves Rollup to place it by how it is
         * actually reached, and it is reached by exactly one dynamic import —
         * `import('maplibre-gl')` in web/src/lib/map.ts — so it lands in an
         * async chunk of its own that only a page drawing a map ever asks for.
         * Its stylesheet rides along in that chunk's CSS for the same reason.
         *
         * Matched as a path segment, with the slashes, so that some future
         * `maplibre-gl-something` helper is not caught by it by accident.
         */
        manualChunks: (id) => {
          if (id.includes('/node_modules/maplibre-gl/')) return undefined;
          return id.includes('/node_modules/') ? 'vendor' : undefined;
        },
      },
    },
  },
  server: {
    // The Worker runs on 8787 in `wrangler dev`. Proxying in development keeps
    // the browser on one origin, so the session cookie behaves exactly as it
    // will in production and CORS never enters the picture locally.
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
      '/o': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
});
