import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    server: { deps: { external: [/node:sqlite/] } },
  },
  ssr: { external: ['node:sqlite'] },
  optimizeDeps: { exclude: ['node:sqlite'] },
});
