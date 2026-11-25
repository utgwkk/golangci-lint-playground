import { expect, test, type Page } from '@playwright/test';

async function open(page: Page, path = '/'): Promise<void> {
  await page.goto(path);
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 120_000 });
}

async function setEditor(page: Page, pane: 'code' | 'config', text: string): Promise<void> {
  const content = page.locator(`#${pane} .cm-content`);
  await content.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
}

async function run(page: Page): Promise<string[]> {
  await page.evaluate(() => delete document.body.dataset.lastRun);
  await page.click('#run');
  await expect(page.locator('body')).toHaveAttribute('data-last-run', /.+/, { timeout: 120_000 });
  return page.locator('.issue .badge').allTextContents();
}

test.beforeEach(async ({ page }) => {
  // Start every test from the default sample.
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-started')) {
      localStorage.clear();
      sessionStorage.setItem('e2e-started', '1');
    }
  });
});

test('lints the sample and marks issues in the editor', async ({ page }) => {
  await open(page);
  const linters = await run(page);
  expect(linters.sort()).toEqual(['bodyclose', 'errcheck', 'govet', 'ineffassign']);
  await expect(page.locator('#code .cm-lintRange')).toHaveCount(4);

  // Clicking an issue selects its position in the editor.
  await page.locator('.issue', { hasText: 'errcheck' }).click();
  await expect(page.locator('#code .cm-activeLine')).toContainText('defer f.Close()');

  // A second run uses the warm cache.
  expect((await run(page)).sort()).toEqual(['bodyclose', 'errcheck', 'govet', 'ineffassign']);
});

test('uses the free-form .golangci.yml as written', async ({ page }) => {
  await open(page);
  await setEditor(
    page,
    'config',
    'version: "2"\nlinters:\n  default: none\n  enable: [govet]\noutput:\n  formats:\n    text:\n      path: stdout\n',
  );
  expect(await run(page)).toEqual(['govet']);
});

test('warns about unsupported settings without changing them', async ({ page }) => {
  await open(page);
  await setEditor(page, 'config', 'version: "2"\nlinters:\n  enable:\n    - gomoddirectives\n');
  await expect(page.locator('#config .cm-lintRange-warning')).toHaveCount(1);
  await expect(page.locator('#config .cm-content')).toContainText('gomoddirectives');
});

test('reports type errors and imports outside the standard library', async ({ page }) => {
  await open(page);
  await setEditor(page, 'code', 'package main\n\nimport (\n\t"fmt"\n\t"github.com/pkg/errors"\n)\n\nfunc main() {\n\tx := 1\n\tfmt.Println(errors.New("e"))\n}\n');
  await run(page);
  await expect(page.locator('.issue', { hasText: 'not in std' }).locator('.pos')).toHaveText('main.go:5:2');
});

test('maps issues to files of a txtar archive', async ({ page }) => {
  await open(page);
  await setEditor(
    page,
    'code',
    '-- go.mod --\nmodule example.com/app\n\ngo 1.25\n-- main.go --\npackage main\n\nimport "example.com/app/util"\n\nfunc main() { util.Run() }\n-- util/util.go --\npackage util\n\nimport "os"\n\nfunc Run() {\n\tos.Remove("x")\n}\n',
  );
  expect(await run(page)).toEqual(['errcheck']);
  await expect(page.locator('.issue .pos')).toHaveText('util/util.go:6:11');
  await page.locator('.issue').click();
  await expect(page.locator('#code .cm-activeLine')).toContainText('os.Remove("x")');
});

test('shows golangci-lint errors for invalid configurations', async ({ page }) => {
  await open(page);
  await setEditor(page, 'config', 'version: "2"\nlinters:\n  enable: [no-such-linter]\n');
  await run(page);
  await expect(page.locator('body')).toHaveAttribute('data-last-run', 'failed');
  await expect(page.locator('#results .error')).toContainText('no-such-linter');
});

test('shares code and configuration through the URL without running it', async ({ page, context }) => {
  await open(page);
  await setEditor(page, 'code', 'package main\n\n// shared code\nfunc main() {}\n');
  await setEditor(page, 'config', 'version: "2"\n# shared config\n');
  await page.click('#share');
  await expect(page).toHaveURL(/#s=/);

  const other = await context.newPage();
  await open(other, page.url());
  await expect(other.locator('#code .cm-content')).toContainText('// shared code');
  await expect(other.locator('#config .cm-content')).toContainText('# shared config');
  await expect(other.locator('#results .placeholder')).toBeVisible();
});

test('cancels a running lint and can run again', async ({ page }) => {
  await open(page);
  await setEditor(page, 'config', 'version: "2"\nlinters:\n  default: all\n');
  await page.click('#run');
  await expect(page.locator('#cancel')).toBeVisible();
  await page.click('#cancel');
  await expect(page.locator('body')).toHaveAttribute('data-last-run', 'cancelled');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready');
  await setEditor(page, 'config', '');
  expect((await run(page)).sort()).toEqual(['errcheck', 'govet', 'ineffassign']);
});

test('caches the assets with the service worker', async ({ page }) => {
  await open(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 120_000 });
  const cached = await page.evaluate(async () => {
    const cache = await caches.open('golangci-lint-assets-v1');
    return (await cache.keys()).map((r) => new URL(r.url).pathname.split('/').pop()).sort();
  });
  expect(cached).toEqual(['cache.bundle.bin', 'golangci-lint.wasm.bin', 'std.bundle.bin', 'wasm_exec.js']);
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
});
