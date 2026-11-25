import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';

// Content Security Policy for the production build (the dev server needs inline scripts and websockets).
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self'",
  "style-src 'self' 'unsafe-inline'", // CodeMirror injects <style> elements
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ');

function csp(): Plugin {
  return {
    name: 'csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<head>', `<head>\n  <meta http-equiv="Content-Security-Policy" content="${CSP}">`),
  };
}

export default defineConfig({
  // Relative base so that the site works under any path (e.g. GitHub Pages project sites).
  base: './',
  plugins: [csp()],
  // golangci-lint assets (wasm, bundles, versions.json) built by scripts/build-assets.sh.
  publicDir: '../wasm/dist',
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    // CodeMirror + yaml; small compared with the ~24 MB of golangci-lint assets.
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      input: { main: 'index.html', sw: 'src/sw.ts' },
      output: {
        // The service worker must have a stable URL.
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
