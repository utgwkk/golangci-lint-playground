// Parity test: lints every testdata/parity/*.txtar and web/examples/*.txtar with the native golangci-lint
// (same version, built by wasm/build.sh) and with the js/wasm build in Node.js,
// and checks that the normalized issues are identical. Each case is checked
// twice: a plain run, and a run with --fix (where the fixed files must be
// identical too).
//
// usage: tsx scripts/parity.ts [versionDir] [nativeBinary]
// (versionDir defaults to the default version in wasm/dist/versions.json)

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { VersionsManifest } from '../src/engine/client';
import { parseReport, type Issue } from '../src/engine/normalize';
import type { Files } from '../src/engine/protocol';
import { CONFIG_FILE, defaultGoMod, FIX_ARGS, LINT_ARGS, readWorkspace } from '../src/engine/runner';
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
// Parity cases and the playground's samples (which must behave like native golangci-lint too).
const caseDirs = [join(root, 'testdata/parity'), join(root, 'web/examples')];
const exec = promisify(execFile);

interface Outcome {
  issues: Issue[] | null;
  /** The code files after the run (changed only with --fix). */
  files: Files;
}

function key(i: Issue): string {
  return JSON.stringify([i.file, i.line, i.column, i.linter, i.message, i.fixes ?? null]);
}

/** Runs the native golangci-lint with the same arguments as the playground (the report path differs). */
async function runNative(files: Files, goVersion: string, fix: boolean): Promise<Outcome> {
  const dir = await mkdtemp(join(tmpdir(), 'parity-'));
  try {
    const all = { 'go.mod': defaultGoMod(goVersion), ...files };
    for (const [name, content] of Object.entries(all)) {
      await mkdir(dirname(join(dir, name)), { recursive: true });
      await writeFile(join(dir, name), content);
    }
    const report = join(dir, 'report.json');
    const args = [...(fix ? FIX_ARGS : LINT_ARGS)];
    args[args.indexOf('--output.json.path') + 1] = report;
    await exec(native, args, {
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
    const out: Files = {};
    for (const name of Object.keys(files)) if (name !== CONFIG_FILE) out[name] = await readFile(join(dir, name), 'utf8');
    return { issues: parseReport(await readFile(report, 'utf8').catch(() => null)), files: out };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const rt = await loadRuntime(versionDir);
async function runWasm(files: Files, fix: boolean): Promise<Outcome> {
  const r = await rt.run(files, fix ? FIX_ARGS : LINT_ARGS);
  return { issues: r.issues, files: readWorkspace(rt.memfs, Object.keys(files).filter((n) => n !== CONFIG_FILE)) };
}

const cases: string[] = [];
for (const dir of caseDirs) {
  for (const name of (await readdir(dir)).filter((n) => n.endsWith('.txtar')).sort()) cases.push(join(dir, name));
}
let failed = 0;
let checks = 0;
for (const path of cases) {
  const name = relative(root, path);
  const files = filesFromText(await readFile(path, 'utf8'));
  for (const fix of [false, true]) {
    checks++;
    const label = `${name}${fix ? ' (--fix)' : ''}`;
    const expected = await runNative(files, rt.goVersion, fix);
    const actual = await runWasm(files, fix);
    const want = new Set((expected.issues ?? []).map(key));
    const got = new Set((actual.issues ?? []).map(key));
    const missing = [...want].filter((k) => !got.has(k));
    const extra = [...got].filter((k) => !want.has(k));
    const changedFiles = Object.keys(expected.files).filter((f) => expected.files[f] !== actual.files[f]);
    const fixedFiles = Object.keys(expected.files).filter((f) => expected.files[f] !== files[f]);
    const ok = expected.issues !== null && actual.issues !== null && !missing.length && !extra.length && !changedFiles.length;
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${label}: native=${expected.issues?.length ?? 'no report'} wasm=${actual.issues?.length ?? 'no report'}` +
        (fix ? ` fixed files=${fixedFiles.length}` : ''),
    );
    for (const k of missing) console.log(`     only native: ${k}`);
    for (const k of extra) console.log(`     only wasm:   ${k}`);
    for (const f of changedFiles) console.log(`     ${f} differs after the run:\n--- native\n${expected.files[f]}\n--- wasm\n${actual.files[f]}`);
    if (!ok) failed++;
  }
}
console.log(failed ? `${failed} of ${checks} checks differ` : `all ${checks} checks match (${cases.length} cases, with and without --fix)`);
process.exit(failed ? 1 : 0);
