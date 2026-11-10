import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The backend (../server.mjs) serves ./public with a narrow content-type map and
// no SPA fallback. The app uses no URL routing, so a standard build into ../public
// serves correctly. During development we run Vite's own server and proxy the API
// (and the design-login redirect) to the running backend on 127.0.0.1:4747 — the
// backend stays untouched.
//
// build.outDir points at ../public and emptyOutDir is false so a build only adds
// index.html + hashed assets alongside manifest.webmanifest / sw.js. Vanilla
// public/app.js is retired manually at cutover (moved to public/legacy/), not by
// the build. Until then, do not run `build` against ../public.
// WB_API overrides the proxy target (used for verification against an isolated
// scratch backend); defaults to the real backend on :4747.
const API_TARGET = process.env.WB_API || 'http://127.0.0.1:4757';

export default defineConfig({
  plugins: [react()],
  base: '/',
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: false },
      '/design-login': { target: API_TARGET, changeOrigin: false },
    },
  },
  build: {
    outDir: '../public',
    emptyOutDir: false,
    assetsDir: 'assets',
    // Fonts come from the Google CDN; icons are inline SVG. Keep assets to the
    // extensions the backend's static handler maps (.js/.css/.svg/.png).
    sourcemap: true,
  },
});
