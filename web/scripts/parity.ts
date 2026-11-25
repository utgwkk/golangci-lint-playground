// Parity test: lints every testdata/parity/*.txtar with the native golangci-lint
// (same version, built by wasm/build.sh) and with the js/wasm build in Node.js,
// and checks that the normalized issues are identical.
//
// usage: tsx scripts/parity.ts [versionDir] [nativeBinary]
// (versionDir defaults to the default version in wasm/dist/versions.json)

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { VersionsManifest } from '../src/engine/client';
import { parseReport, type Issue } from '../src/engine/normalize';
import { defaultGoMod } from '../src/engine/runner';
import { filesFromText } from '../src/txtar';
import { loadRuntime } from './node-runtime';

const root = resolve(import.meta.dirname, '../..');
async function defaultVersionDir(): Promise<string> {
  const dist = join(root, 'wasm/dist');
  const manifest = JSON.parse(await readFile(join(dist, 'versions.json'), 'utf8')) as VersionsManifest;
  return join(dist, manifest.versions.find((v) => v.version === manifest.default)!.path);
}

const versionDir = resolve(process.argv[2] ?? (await defaultVersionDir()));
const native = resolve(process.argv[3] ?? join(root, 'wasm/.build/golangci-lint'));
const casesDir = join(root, 'testdata/parity');
const run = promisify(execFile);

function key(i: Issue): string {
  return JSON.stringify([i.file, i.line, i.column, i.linter, i.message, i.fixes ?? null]);
}

async function lintNative(files: Record<string, string>, goVersion: string): Promise<Issue[] | null> {
  const dir = await mkdtemp(join(tmpdir(), 'parity-'));
  try {
    const all = { 'go.mod': defaultGoMod(goVersion), ...files };
    for (const [name, content] of Object.entries(all)) {
      await mkdir(dirname(join(dir, name)), { recursive: true });
      await writeFile(join(dir, name), content);
    }
    const report = join(dir, 'report.json');
    const args = ['run', '--output.json.path', report, '--show-stats=false', './...'];
    await run(native, args, {
      cwd: dir,
      env: {
        ...process.env,
        GOTOOLCHAIN: goVersion,
        GOFLAGS: '-mod=mod',
        GOPROXY: 'off',
        CGO_ENABLED: '0',
        GOOS: 'linux',
        GOARCH: 'amd64',
        GOLANGCI_LINT_CACHE: join(dir, '.cache'),
      },
    }).catch((e: { code?: number }) => {
      if (typeof e.code !== 'number') throw e; // exit codes are expected (issues found)
    });
    return parseReport(await readFile(report, 'utf8').catch(() => null));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const rt = await loadRuntime(versionDir);
let failed = 0;
const names = (await readdir(casesDir)).filter((n) => n.endsWith('.txtar')).sort();
for (const name of names) {
  const files = filesFromText(await readFile(join(casesDir, name), 'utf8'));
  const [expected, actual] = [await lintNative(files, rt.goVersion), (await rt.run(files)).issues];
  const want = new Set((expected ?? []).map(key));
  const got = new Set((actual ?? []).map(key));
  const missing = [...want].filter((k) => !got.has(k));
  const extra = [...got].filter((k) => !want.has(k));
  const ok = expected !== null && actual !== null && !missing.length && !extra.length;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: native=${expected?.length ?? 'no report'} wasm=${actual?.length ?? 'no report'}`);
  for (const k of missing) console.log(`     only native: ${k}`);
  for (const k of extra) console.log(`     only wasm:   ${k}`);
  if (!ok) failed++;
}
console.log(failed ? `${failed} of ${names.length} cases differ` : `all ${names.length} cases match`);
process.exit(failed ? 1 : 0);
