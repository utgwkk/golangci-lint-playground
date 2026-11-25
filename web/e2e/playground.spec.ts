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

async function formatCode(page: Page, how: 'button' | 'shortcut' = 'button'): Promise<string> {
  await page.evaluate(() => delete document.body.dataset.lastFormat);
  if (how === 'button') {
    await page.click('#format');
  } else {
    await page.locator('#code .cm-content').click();
    await page.keyboard.press('Shift+Alt+F');
  }
  await expect(page.locator('body')).toHaveAttribute('data-last-format', /.+/, { timeout: 120_000 });
  return (await page.locator('body').getAttribute('data-last-format'))!;
}

async function codeText(page: Page): Promise<string> {
  return (await page.locator('#code .cm-line').allTextContents()).join('\n');
}

test('formats with goimports and adds missing imports in every file', async ({ page }) => {
  await open(page);
  const original = 'package main\nimport "os"\nfunc main() {\n  fmt.Println(strings.ToUpper(os.Args[0]), util.F())\n}\n';
  await setEditor(page, 'code', original);
  await addFile(page, 'util/util.go');
  await setEditor(page, 'code', 'package util\n\nfunc F() string { return strconv.Itoa(1) }\n');
  await page.locator('.tab-name', { hasText: /^main\.go$/ }).click();

  expect(await formatCode(page)).toBe('ok');
  expect(await codeText(page)).toBe(
    'package main\n\nimport (\n\t"fmt"\n\t"os"\n\t"strings"\n)\n\nfunc main() {\n\tfmt.Println(strings.ToUpper(os.Args[0]), util.F())\n}\n',
  );
  await expect(page.locator('#status-text')).toContainText('main.go, util/util.go');

  // The other tab was formatted too.
  await page.locator('.tab-name', { hasText: 'util/util.go' }).click();
  await expect(page.locator('#code .cm-content')).toContainText('import "strconv"');

  // Formatting is an undoable edit.
  await page.locator('.tab-name', { hasText: /^main\.go$/ }).click();
  await page.locator('#code .cm-content').click();
  await page.keyboard.press('ControlOrMeta+Z');
  expect(await codeText(page)).toBe(original);
});

test('formats with the keyboard shortcut and reports files it cannot parse', async ({ page }) => {
  await open(page);
  await setEditor(page, 'code', 'package main\nfunc main() { fmt.Println(1) }\n');
  expect(await formatCode(page, 'shortcut')).toBe('ok');
  await expect(page.locator('#code .cm-content')).toContainText('import "fmt"');

  const broken = 'package main\n\nfunc broken( {\n';
  await setEditor(page, 'code', broken);
  expect(await formatCode(page)).toBe('failed');
  await expect(page.locator('#status-text')).toContainText('構文エラーのため整形できなかったファイルがあります: main.go');
  expect(await codeText(page)).toBe(broken);
});

// CodeMirror draws the selection in a layer behind the text, so the active
// line's background must be translucent or it hides the selection on the
// cursor's line.
for (const colorScheme of ['light', 'dark'] as const) {
  test(`keeps the selection visible on the cursor's line (${colorScheme})`, async ({ browser }) => {
    const page = await browser.newPage({ colorScheme });
    await open(page);
    const line = page.locator('#code .cm-line', { hasText: 'os.Open' });
    await line.locator('text=config.txt').dblclick();
    await expect(line).toHaveClass(/cm-activeLine/);

    const selection = page.locator('#code .cm-selectionBackground').first();
    await expect(selection).toBeVisible();
    expect((await selection.boundingBox())!.width).toBeGreaterThan(0);

    const alpha = await line.evaluate((el) => {
      const m = getComputedStyle(el).backgroundColor.match(/rgba?\(([^)]+)\)/);
      const parts = m ? m[1].split(/[\s,/]+/).filter(Boolean) : [];
      return parts.length === 4 ? Number(parts[3]) : 1;
    });
    expect(alpha).toBeLessThan(0.5);
    await page.close();
  });
}

// Assets of a version can be rebuilt and redeployed under the same path (e.g.
// the seeded cache contains timestamps). A normal reload must pick them up.
test('picks up redeployed assets without a forced reload', async ({ page }) => {
  const { readFile, writeFile } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const dist = new URL('../dist/', import.meta.url);
  const manifestPath = new URL('versions.json', dist);
  const manifestText = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  const info = manifest.versions[0];
  const assetPath = new URL(`${info.path}cache.bundle.bin`, dist);
  const original = await readFile(assetPath);

  await open(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 120_000 });

  // "Redeploy": same content, different bytes (the gzip header's mtime) and checksum.
  const rebuilt = Buffer.from(original);
  rebuilt.writeUInt32LE((rebuilt.readUInt32LE(4) + 1) >>> 0, 4);
  info.files['cache.bundle.bin'].sha256 = createHash('sha256').update(rebuilt).digest('hex');
  try {
    await writeFile(assetPath, rebuilt);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    await page.reload();
    await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 120_000 });
    expect(await run(page)).toContain('errcheck');
    // Only the new copy stays in the service worker's cache.
    const hash = info.files['cache.bundle.bin'].sha256.slice(0, 16);
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const cache = await caches.open('golangci-lint-assets-v1');
          return (await cache.keys()).map((r) => new URL(r.url)).filter((u) => u.pathname.endsWith('/cache.bundle.bin')).map((u) => u.search);
        }),
      )
      .toEqual([`?v=${hash}`]);
  } finally {
    await writeFile(assetPath, original);
    await writeFile(manifestPath, manifestText);
  }
});

const FIXABLE_CODE =
  'package main\n\nimport "fmt"\n\n// 日本語のコメント\nfunc main() {\n\tfor i := 0; i < 3; i++ {\n\t\tfmt.Println(i)\n\t}\n\tfmt.Println("occured")\n\tm := 10\n\tif m > 5 {\n\t\tm = 5\n\t}\n\tfmt.Println(m)\n}\n';
const FIXABLE_CONFIG = 'version: "2"\nlinters:\n  default: none\n  enable: [modernize, misspell, errcheck]\n';

async function waitForRun(page: Page, action: () => Promise<void>): Promise<string[]> {
  await page.evaluate(() => delete document.body.dataset.lastRun);
  await action();
  await expect(page.locator('body')).toHaveAttribute('data-last-run', /.+/, { timeout: 120_000 });
  return page.locator('.issue .badge').allTextContents();
}

test('fixes all auto-fixable issues with the Fix button', async ({ page }) => {
  await open(page);
  await setEditor(page, 'code', FIXABLE_CODE);
  await setEditor(page, 'config', FIXABLE_CONFIG);
  expect(await waitForRun(page, () => page.click('#fix'))).toEqual([]);
  // Same result as golangci-lint --fix (see test/fixes.test.ts).
  expect(await codeText(page)).toBe(
    'package main\n\nimport "fmt"\n\n// 日本語のコメント\nfunc main() {\n\tfor i := range 3 {\n\t\tfmt.Println(i)\n\t}\n\tfmt.Println("occurred")\n\tm := min(10, 5)\n\tfmt.Println(m)\n}\n',
  );
  await expect(page.locator('#status-text')).toHaveText('自動修正しました（main.go）。残りの指摘: 0 件');

  // Undoable.
  await page.locator('#code .cm-content').click();
  await page.keyboard.press('ControlOrMeta+Z');
  expect(await codeText(page)).toBe(FIXABLE_CODE);
});

test('applies quick fixes from the results and the editor, then lints again', async ({ page }) => {
  await open(page);
  await setEditor(page, 'code', FIXABLE_CODE);
  await setEditor(page, 'config', FIXABLE_CONFIG);
  expect((await run(page)).sort()).toEqual(['misspell', 'modernize', 'modernize']);

  // From the results list.
  const misspell = page.locator('.issues li', { has: page.locator('.badge', { hasText: 'misspell' }) });
  expect((await waitForRun(page, () => misspell.locator('.quick-fix').click())).sort()).toEqual(['modernize', 'modernize']);
  await expect(page.locator('#code .cm-content')).toContainText('fmt.Println("occurred")');
  await expect(page.locator('#status-text')).toContainText('misspell の修正を適用しました。再完了');

  // From the diagnostic in the editor.
  await page.locator('#code .cm-line', { hasText: 'for i := 0' }).locator('.cm-lintRange').first().hover();
  const action = page.locator('.cm-tooltip-hover .cm-diagnosticAction', { hasText: 'range' });
  expect(await waitForRun(page, () => action.click())).toEqual(['modernize']);
  await expect(page.locator('#code .cm-content')).toContainText('for i := range 3 {');
});

test('refuses quick fixes for code changed after the run', async ({ page }) => {
  await open(page);
  await setEditor(page, 'code', FIXABLE_CODE);
  await setEditor(page, 'config', FIXABLE_CONFIG);
  await run(page);
  await page.locator('#code .cm-line').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' // edited');
  await page.locator('.issues li', { has: page.locator('.badge', { hasText: 'misspell' }) }).locator('.quick-fix').click();
  await expect(page.locator('#status-text')).toContainText('もう一度 Run してください');
  await expect(page.locator('#code .cm-content')).toContainText('fmt.Println("occured")');
});
