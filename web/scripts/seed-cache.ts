// Pre-populates the golangci-lint cache for the whole public standard library
// by linting a program that imports every public std package, then writes the
// cache directory as <versionDir>/cache.bundle.bin.
//
// It runs in the same in-memory filesystem layout as the browser, so the cache
// entries stay valid there.
//
// usage: tsx scripts/seed-cache.ts <versionDir> <warmupDir>

import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gzip, makeBundle } from '../src/engine/bundle';
import { LINT_ARGS, PATHS } from '../src/engine/runner';
import { loadRuntime } from './node-runtime';

const [versionDir, warmupDir] = process.argv.slice(2).map((p) => resolve(p));
if (!versionDir || !warmupDir) throw new Error('usage: seed-cache.ts <versionDir> <warmupDir>');

const files = {
  'go.mod': await readFile(join(warmupDir, 'go.mod'), 'utf8'),
  'main.go': await readFile(join(warmupDir, 'main.go'), 'utf8'),
};
const rt = await loadRuntime(versionDir, { cache: false });

// One pass per linter set offered out of the box.
for (const extra of [[], ['--default=all']]) {
  const args = [...LINT_ARGS.slice(0, -1), ...extra, './...'];
  const r = await rt.run(files, args);
  console.log(`seed ${extra.join(' ') || '(standard)'}: ${(r.ms / 1000).toFixed(1)}s, issues=${r.issues?.length ?? 'no report'}`);
  if (!r.issues) throw new Error(`seeding failed:\n${r.log}`);
}

const raw = makeBundle(rt.memfs, [PATHS.cache]);
const gz = await gzip(raw);
await writeFile(join(versionDir, 'cache.bundle.bin'), gz);
console.log(`cache bundle: ${(raw.length / 1e6).toFixed(1)} MB raw, ${(gz.length / 1e6).toFixed(2)} MB gzip`);
