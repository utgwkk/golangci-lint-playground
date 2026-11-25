// Loads the PoC runtime (MemFS + wasm_exec.js + golangci-lint.wasm) in Node.js,
// exactly as the browser worker does.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadRuntime(dist, { cache = true } = {}) {
  dist = resolve(dist); // before process.cwd is redirected to MemFS
  const { MemFS } = await import(pathToFileURL(join(dist, 'gofs.js')));
  const bundle = await import(pathToFileURL(join(dist, 'bundle.js')));
  const runner = await import(pathToFileURL(join(dist, 'runner.js')));

  const memfs = new MemFS();
  runner.installGlobals(memfs);
  await import(pathToFileURL(join(dist, 'wasm_exec.js')));

  const wasm = await bundle.gunzip(await readFile(join(dist, 'golangci-lint.wasm.gz')));
  const module = await WebAssembly.compile(wasm);
  await bundle.loadBundle(memfs, await readFile(join(dist, 'std.bundle.gz')));
  if (cache) {
    try {
      await bundle.loadBundle(memfs, await readFile(join(dist, 'cache.bundle.gz')));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  return { memfs, module, bundle, runner };
}
