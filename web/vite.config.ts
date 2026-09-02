import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
