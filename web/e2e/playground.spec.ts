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

async function addFile(page: Page, name: string): Promise<void> {
  await page.click('.tab-add');
  await page.fill('.tab-input', name);
  await page.press('.tab-input', 'Enter');
  await expect(page.locator('.tab.active .tab-name')).toHaveText(name);
}

test('edits several files in tabs and maps issues to them', async ({ page }) => {
  await open(page);
  await addFile(page, 'go.mod');
  await setEditor(page, 'code', 'module example.com/app\n\ngo 1.27\n');
  await addFile(page, 'util/util.go');
  await expect(page.locator('#code .cm-content')).toContainText('package util');
  await setEditor(page, 'code', 'package util\n\nimport "os"\n\nfunc Run() {\n\tos.Remove("x")\n}\n');
  await page.locator('.tab-name', { hasText: /^main\.go$/ }).click();
  await setEditor(page, 'code', 'package main\n\nimport "example.com/app/util"\n\nfunc main() { util.Run() }\n');
  await setEditor(page, 'config', '');

  expect(await run(page)).toEqual(['errcheck']);
  await expect(page.locator('.issue .pos')).toHaveText('util/util.go:6:11');
  await expect(page.locator('.tab', { hasText: 'util/util.go' }).locator('.tab-issues')).toHaveText('1');

  // Clicking the issue opens its file.
  await page.locator('.issue').click();
  await expect(page.locator('.tab.active .tab-name')).toHaveText('util/util.go');
  await expect(page.locator('#code .cm-activeLine')).toContainText('os.Remove("x")');

  // Rename and delete tabs.
  await page.locator('.tab-name', { hasText: 'go.mod' }).dblclick();
  await page.fill('.tab-input', 'main.go');
  await page.press('.tab-input', 'Enter');
  await expect(page.locator('.tab-input')).toBeVisible(); // duplicate name is rejected
  await page.press('.tab-input', 'Escape');
  page.once('dialog', (d) => d.accept());
  await page.locator('.tab', { hasText: 'util/util.go' }).locator('.tab-close').click();
  await expect(page.locator('.tab-name')).toHaveText(['main.go', 'go.mod']);
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
  await addFile(page, 'extra.go');
  await setEditor(page, 'code', 'package main\n\n// second file\n');
  await setEditor(page, 'config', 'version: "2"\n# shared config\n');
  await page.click('#share');
  await expect(page).toHaveURL(/#s=/);

  const other = await context.newPage();
  await open(other, page.url());
  await expect(other.locator('.tab-name')).toHaveText(['main.go', 'extra.go']);
  await expect(other.locator('#code .cm-content')).toContainText('// shared code');
  await other.locator('.tab-name', { hasText: 'extra.go' }).click();
  await expect(other.locator('#code .cm-content')).toContainText('// second file');
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
  expect(cached).toEqual([
    'cache.bundle.bin',
    'formatters.json',
    'golangci-lint.wasm.bin',
    'linters.json',
    'schema.json',
    'std.bundle.bin',
    'wasm_exec.js',
  ]);
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
});

test('chooses linters in a dialog with minimal YAML edits', async ({ page }) => {
  await open(page);
  await expect(page.locator('#open-tools')).toBeEnabled();
  const config = 'version: "2"\n# keep this comment\nlinters:\n  enable:\n    - bodyclose # and this one\n';
  await setEditor(page, 'config', config);
  await page.click('#open-tools');
  const dialog = page.locator('.tools-dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('input[type=search]').fill('gocritic');
  await dialog.locator('input[aria-label="gocritic"]').check();
  await dialog.locator('input[type=search]').fill('errcheck');
  await dialog.locator('input[aria-label="errcheck"]').uncheck();
  await dialog.locator('select').selectOption('fast');
  await page.keyboard.press('Escape');
  const text = await page.locator('#config .cm-line').allTextContents();
  expect(text.join('\n')).toBe(
    'version: "2"\n# keep this comment\nlinters:\n  enable:\n    - bodyclose # and this one\n    - gocritic\n  disable:\n    - errcheck\n  default: fast\n',
  );
  // The dialog reflects the YAML.
  await page.click('#open-tools');
  await dialog.locator('input[type=search]').fill('gocritic');
  await expect(dialog.locator('input[aria-label="gocritic"]')).toBeChecked();
  await expect(dialog.locator('select')).toHaveValue('fast');
});

// CodeMirror ignores Enter within 75 ms of the completion list opening
// (interactionDelay), to prevent accidental selection.
async function acceptCompletion(page: Page): Promise<void> {
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
}

test('completes, documents and checks the configuration with the schema', async ({ page }) => {
  await open(page);
  await expect(page.locator('#open-tools')).toBeEnabled(); // schema loaded
  await setEditor(page, 'config', 'version: "2"\nlinters:\n  default: standard\n');
  await page.locator('#config .cm-line').nth(2).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('sett', { delay: 20 });
  await expect(page.locator('.cm-tooltip-autocomplete li')).toHaveText(['settings']);
  await acceptCompletion(page);
  await page.keyboard.type('errch', { delay: 20 });
  await expect(page.locator('.cm-tooltip-autocomplete li').first()).toHaveText('errcheck');
  await acceptCompletion(page);
  await expect(page.locator('#config .cm-content')).toContainText('settings:    errcheck:');

  // Typos get a warning with a suggestion.
  await setEditor(page, 'config', 'version: "2"\nlinters:\n  enable:\n    - errchek\n');
  await page.locator('#config .cm-lintRange-warning').first().hover();
  await expect(page.locator('.cm-tooltip-hover')).toContainText('もしかして: errcheck');

  // Hovering a linter name shows its description.
  await setEditor(page, 'config', 'version: "2"\nlinters:\n  enable:\n    - govet\n');
  await page.locator('#config .cm-line', { hasText: 'govet' }).hover({ position: { x: 50, y: 8 } });
  await expect(page.locator('.cm-schema-hover')).toContainText('govet');
});

test('opens samples', async ({ page }) => {
  await open(page);
  await page.selectOption('#sample', '04-multi-package');
  await expect(page.locator('.tab-name')).toHaveText(['go.mod', 'main.go', 'internal/store/store.go']);
  await expect(page.locator('#config .cm-content')).toContainText('revive');

  // Replacing edited content asks first.
  await setEditor(page, 'code', 'package main\n// edited\n');
  page.once('dialog', (d) => d.dismiss());
  await page.selectOption('#sample', '06-modernize');
  await expect(page.locator('#code .cm-content')).toContainText('// edited');
  page.once('dialog', (d) => d.accept());
  await page.selectOption('#sample', '06-modernize');
  await expect(page.locator('.tab-name')).toHaveText(['main.go']);
  expect(await run(page)).toContain('modernize');
});
