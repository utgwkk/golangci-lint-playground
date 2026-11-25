import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';
import { licenses } from './scripts/licenses-plugin';

const REPO_URL = 'https://github.com/utgwkk/golangci-lint-playground';

// licenses.txt of the web app (golangci-lint's files have their own, see wasm/build.sh).
const licenseFiles = licenses({
  header: `golangci-lint playground: licenses
==================================

The golangci-lint playground (this web app) is licensed under the MIT license
below. Its source code is at ${REPO_URL}.

golangci-lint and the other files under v/<version>/ have their own licenses
(golangci-lint is licensed under the GNU GPL version 3): see
v/<version>/licenses.txt, and v/<version>/golangci-lint-source.tar.gz for the
complete source code of the WebAssembly build.

${readFileSync(new URL('../LICENSE', import.meta.url), 'utf8')}`,
});

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
  plugins: [csp(), licenseFiles.main],
  // golangci-lint assets (wasm, bundles, versions.json) built by scripts/build-assets.sh.
  publicDir: '../wasm/dist',
  worker: { format: 'es', plugins: () => [licenseFiles.worker()] },
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
