// Takes the screenshot shown in README.md (docs/images/screenshot.png): the
// production build served by `vite preview`, a sample linted, at a fixed
// viewport and scale. See .claude/skills/update-readme-screenshot/SKILL.md.
//
// usage: npm run screenshot [-- --sample <title>] [--tab <file>] [--color-scheme light|dark] [--out <path>]
// Requires `npm run build` (and the golangci-lint assets, see README.md).

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import { preview } from 'vite';

const webDir = fileURLToPath(new URL('..', import.meta.url));
const { values: args } = parseArgs({
  options: {
    // The sample to lint, by its title in the sample menu. "Modernize" shows quick fixes in the results.
    sample: { type: 'string', default: 'Modernize' },
    // The file tab to show (default: the one the sample opens).
    tab: { type: 'string' },
    'color-scheme': { type: 'string', default: 'light' },
    out: { type: 'string', default: resolve(webDir, '../docs/images/screenshot.png') },
  },
});

if (!existsSync(resolve(webDir, 'dist/index.html')) || !existsSync(resolve(webDir, 'dist/versions.json'))) {
  console.error('web/dist is missing or has no golangci-lint assets: run ./scripts/build-assets.sh and npm run build first.');
  process.exit(1);
}

const server = await preview({ root: webDir, logLevel: 'warn', preview: { host: '127.0.0.1', port: 4180 } });
const url = server.resolvedUrls?.local[0];
if (!url) throw new Error('vite preview did not report its URL');

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1360, height: 820 },
    deviceScaleFactor: 2,
    colorScheme: args['color-scheme'] === 'dark' ? 'dark' : 'light',
  });
  page.on('dialog', (d) => void d.accept());
  await page.goto(url);
  await page.waitForSelector('body[data-state=ready]', { timeout: 180_000 });

  await page.locator('#sample').selectOption({ label: args.sample });
  await page.click('#run');
  await page.waitForSelector('body[data-last-run]', { timeout: 180_000 });
  if (args.tab) await page.locator('.tab-name', { hasText: args.tab }).click();

  // No hover effects or focus rings in the picture.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(0, 0);
  await page.screenshot({ path: args.out });
  console.log(`wrote ${args.out}`);
} finally {
  await browser.close();
  await new Promise<void>((done) => server.httpServer.close(() => done()));
}
