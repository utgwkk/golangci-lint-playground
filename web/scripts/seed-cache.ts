// Pre-populates the golangci-lint cache for the whole public standard library
// by linting a program that imports every public std package, then writes the
// cache directory as <versionDir>/cache.bundle.bin.
//
// It runs in the same in-memory filesystem layout as the browser, so the cache
// entries stay valid there.
//
// One pass runs per linter set offered out of the box. WebAssembly runs on a
// single thread, so the passes run in separate processes in parallel and their
// caches (content-addressed files) are merged afterwards.
//
// usage: tsx scripts/seed-cache.ts <versionDir> <warmupDir>

import { fork } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzip, loadBundle, makeBundle } from '../src/engine/bundle';
import { MemFS } from '../src/engine/gofs';
import { LINT_ARGS, PATHS } from '../src/engine/runner';
import { loadRuntime } from './node-runtime';

const PASSES: Record<string, string[]> = {
  standard: [],
  all: ['--default=all'],
};

/** Runs one pass and writes the resulting cache directory as an uncompressed bundle. */
async function runPass(pass: string, out: string, versionDir: string, warmupDir: string): Promise<void> {
  const files = {
    'go.mod': await readFile(join(warmupDir, 'go.mod'), 'utf8'),
    'main.go': await readFile(join(warmupDir, 'main.go'), 'utf8'),
  };
  const rt = await loadRuntime(versionDir, { cache: false });
  const args = [...LINT_ARGS.slice(0, -1), ...PASSES[pass], './...'];
  const r = await rt.run(files, args);
  console.log(`seed ${pass}: ${(r.ms / 1000).toFixed(1)}s, issues=${r.issues?.length ?? 'no report'}`);
  if (!r.issues) throw new Error(`seeding (${pass}) failed:\n${r.log}`);
  if (r.issues.length) throw new Error(`seeding (${pass}) reported issues in std:\n${JSON.stringify(r.issues.slice(0, 5), null, 2)}`);
  await writeFile(out, makeBundle(rt.memfs, [PATHS.cache]));
}

function runChild(args: string[]): Promise<void> {
  return new Promise((ok, fail) => {
    // fork() reuses process.execArgv, so the child also runs under tsx.
    const child = fork(fileURLToPath(import.meta.url), args, { stdio: 'inherit' });
    child.on('error', fail);
    child.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`seeding pass ${args[1]} exited with ${code}`))));
  });
}

const argv = process.argv.slice(2);
if (argv[0] === '--pass') {
  const [, pass, out, versionDir, warmupDir] = argv;
  await runPass(pass, out, versionDir, warmupDir);
} else {
  const [versionDir, warmupDir] = argv.map((p) => resolve(p));
  if (!versionDir || !warmupDir) throw new Error('usage: seed-cache.ts <versionDir> <warmupDir>');
  const tmp = await mkdtemp(join(tmpdir(), 'seed-'));
  try {
    const started = performance.now();
    const outs = Object.keys(PASSES).map((pass) => [pass, join(tmp, `${pass}.bundle`)] as const);
    await Promise.all(outs.map(([pass, out]) => runChild(['--pass', pass, out, versionDir, warmupDir])));

    // Merge: cache entries are content-addressed, so the union of both directories is valid.
    const merged = new MemFS();
    for (const [, out] of outs) await loadBundle(merged, await readFile(out));
    const raw = makeBundle(merged, [PATHS.cache]);
    const gz = await gzip(raw);
    await writeFile(join(versionDir, 'cache.bundle.bin'), gz);
    console.log(
      `cache bundle: ${(raw.length / 1e6).toFixed(1)} MB raw, ${(gz.length / 1e6).toFixed(2)} MB gzip ` +
        `(${((performance.now() - started) / 1000).toFixed(1)}s)`,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
