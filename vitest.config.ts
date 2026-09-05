import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    server: { deps: { external: [/node:sqlite/] } },
  },
  resolve: {
    alias: {
      // `cloudflare:workers` only exists inside the Workers runtime. Anything
      // importing the Worker entry point — or a Durable Object class — cannot
      // be loaded by Node without a stand-in for it.
      'cloudflare:workers': new URL('./test/cf-workers-shim.ts', import.meta.url).pathname,
    },
  },
  ssr: { external: ['node:sqlite'] },
  optimizeDeps: { exclude: ['node:sqlite'] },
});
