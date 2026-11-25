// Runs the playground engine (MemFS + wasm_exec.js + golangci-lint.wasm) in
// Node.js, exactly as the browser worker does. Used for cache seeding and
// parity tests.

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzip, loadBundle } from '../src/engine/bundle';
import { MemFS } from '../src/engine/gofs';
import { cleanLog, parseReport, type Issue } from '../src/engine/normalize';
import type { Files } from '../src/engine/protocol';
import { installGlobals, LINT_ARGS, runGolangciLint, writeWorkspace, type RunOutput } from '../src/engine/runner';

export interface NodeRuntime {
  memfs: MemFS;
  goVersion: string;
  version: string;
  run(files: Files, args?: string[]): Promise<RunOutput & { issues: Issue[] | null; log: string }>;
}

export async function loadRuntime(versionDir: string, { cache = true } = {}): Promise<NodeRuntime> {
  const dir = resolve(versionDir); // resolve before process.cwd is redirected to the MemFS
  const build = JSON.parse(await readFile(join(dir, 'build.json'), 'utf8')) as { version: string; goVersion: string };
  const memfs = new MemFS();
  installGlobals(memfs);
  await import(pathToFileURL(join(dir, 'wasm_exec.js')).href);

  const module = await WebAssembly.compile(await gunzip(await readFile(join(dir, 'golangci-lint.wasm.bin'))));
  await loadBundle(memfs, await readFile(join(dir, 'std.bundle.bin')));
  if (cache) await loadBundle(memfs, await readFile(join(dir, 'cache.bundle.bin')));

  return {
    memfs,
    goVersion: build.goVersion,
    version: build.version,
    async run(files, args = LINT_ARGS) {
      writeWorkspace(memfs, files, build.goVersion);
      const r = await runGolangciLint(memfs, module, args);
      return { ...r, issues: parseReport(r.report), log: cleanLog([r.stdout, r.stderr].filter(Boolean).join('\n')) };
    },
  };
}
