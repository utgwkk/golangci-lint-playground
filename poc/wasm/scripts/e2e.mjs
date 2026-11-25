// End-to-end check in headless Chromium: loads the page, runs golangci-lint
// on the sample twice (first run, then with a warm in-memory cache) and
// verifies the reported linters.
// usage: node e2e.mjs [dist] [screenshot.png]
import { createRequire } from 'node:module';
import { serve } from './serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const [dist = 'dist', screenshot] = process.argv.slice(2);
const server = await serve(dist, 0);
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: screenshot ? 2 : 1 });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));

const t0 = Date.now();
await page.goto(url);
await page.waitForSelector('body[data-ready="true"]', { timeout: 120_000 });
console.log(`ready: ${((Date.now() - t0) / 1000).toFixed(1)}s — ${await page.textContent('#status')}`);

async function runOnce(label) {
  await page.click('#run');
  await page.waitForSelector('body[data-last-run]', { timeout: 300_000 });
  const linters = await page.$$eval('#results li .linter', (els) => els.map((e) => e.textContent));
  console.log(`${label}: ${await page.textContent('#status')} — ${linters.join(', ') || '(none)'}`);
  return linters;
}

const first = await runOnce('run 1');
const second = await runOnce('run 2');

const want = ['bodyclose', 'errcheck', 'govet', 'ineffassign'];
const missing = want.filter((l) => !second.includes(l));

// A free-form .golangci.yml must be honored.
const savedConfig = await page.inputValue('#config');
// It also sets output formats, which must not break result collection.
await page.fill('#config', 'version: "2"\nlinters:\n  default: none\n  enable: [govet]\n' +
  'output:\n  formats:\n    text:\n      path: stdout\n    json:\n      path: stderr\n');
const configured = await runOnce('config (govet only)');
await page.fill('#config', savedConfig);

// Type errors must be reported with real positions.
await page.fill('#code', 'package main\n\nfunc main() {\n\tx := 1\n}\n');
const typecheck = await runOnce('typecheck');
const typecheckPos = await page.textContent('#results li .pos').catch(() => '');
console.log(`typecheck position: ${typecheckPos}`);

if (screenshot) {
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('body[data-ready="true"]', { timeout: 120_000 });
  await runOnce('screenshot run');
  await page.screenshot({ path: screenshot, fullPage: true });
}

await browser.close();
server.close();

const ok = missing.length === 0 && JSON.stringify(first) === JSON.stringify(second) &&
  typecheck.includes('typecheck') && typecheckPos.startsWith('main.go:4:2') &&
  JSON.stringify(configured) === JSON.stringify(['govet']) && consoleErrors.length === 0;
if (consoleErrors.length) console.log('console errors:\n  ' + consoleErrors.join('\n  '));
console.log(ok ? 'E2E OK' : `E2E FAILED (missing: ${missing.join(', ')})`);
process.exit(ok ? 0 : 1);
