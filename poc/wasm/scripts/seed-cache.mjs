// Pre-populates the golangci-lint cache for the whole standard library by
// linting a program that imports every public std package, then writes the
// cache directory as dist/cache.bundle.gz.
//
// It runs in the same in-memory filesystem (same paths) as the browser, so the
// cache entries are valid there.
//
// usage: node seed-cache.mjs <dist> <warmup dir>
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadRuntime } from './node-env.mjs';

const [dist, warmupDir] = process.argv.slice(2).map((p) => resolve(p));
const { memfs, module, bundle, runner } = await loadRuntime(dist, { cache: false });

const files = {
  'go.mod': await readFile(join(warmupDir, 'go.mod'), 'utf8'),
  'main.go': await readFile(join(warmupDir, 'main.go'), 'utf8'),
};

// One pass per linter set that the playground offers out of the box.
for (const extra of [[], ['--default=all']]) {
  runner.writeWorkspace(memfs, files);
  const r = await runner.runGolangciLint(memfs, module, [...runner.LINT_ARGS.slice(0, -1), ...extra, './...']);
  const issues = runner.parseIssues(r.stdout);
  console.log(`seed ${extra.join(' ') || '(standard)'}: exit=${r.exitCode} ${(r.ms / 1000).toFixed(1)}s issues=${issues?.length ?? 'n/a'}`);
  if (!issues) console.log(r.stderr.slice(0, 4000));
}

const raw = bundle.makeBundle(memfs, [runner.PATHS.cache]);
const gz = await bundle.gzip(raw);
await writeFile(join(dist, 'cache.bundle.gz'), gz);
console.log(`cache bundle: ${(raw.length / 1e6).toFixed(1)} MB raw, ${(gz.length / 1e6).toFixed(1)} MB gzip`);
