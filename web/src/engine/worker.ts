// Web Worker that owns the in-memory filesystem and runs golangci-lint (js/wasm).
// Assets are downloaded and the WebAssembly module is compiled by the main thread
// (see client.ts), so that a cancelled worker can be replaced without re-downloading.

import { MemFS } from './gofs';
import { loadBundle } from './bundle';
import { cleanLog, parseReport } from './normalize';
import { FORMAT_ARGS, installGlobals, readWorkspace, runGolangciLint, writeWorkspace } from './runner';
import type { FromWorker, ToWorker } from './protocol';

const memfs = new MemFS();
installGlobals(memfs);

let module: WebAssembly.Module | null = null;
let goVersion = '';

function post(msg: FromWorker): void {
  postMessage(msg);
}

async function init(msg: Extract<ToWorker, { type: 'init' }>): Promise<void> {
  await import(/* @vite-ignore */ msg.wasmExecUrl);
  module = msg.module;
  goVersion = msg.goVersion;
  let files = await loadBundle(memfs, msg.std);
  if (msg.cache) files += await loadBundle(memfs, msg.cache);
  post({ type: 'ready', files });
}

async function lint(msg: Extract<ToWorker, { type: 'lint' }>): Promise<void> {
  if (!module) throw new Error('engine is not initialized');
  writeWorkspace(memfs, msg.files, goVersion);
  const r = await runGolangciLint(memfs, module);
  post({
    type: 'result',
    id: msg.id,
    issues: parseReport(r.report),
    log: cleanLog([r.stdout, r.stderr].filter(Boolean).join('\n')),
    exitCode: r.exitCode,
    ms: r.ms,
  });
}

async function format(msg: Extract<ToWorker, { type: 'format' }>): Promise<void> {
  if (!module) throw new Error('engine is not initialized');
  writeWorkspace(memfs, msg.files, goVersion);
  const r = await runGolangciLint(memfs, module, FORMAT_ARGS);
  post({
    type: 'formatted',
    id: msg.id,
    files: readWorkspace(memfs, Object.keys(msg.files)),
    log: cleanLog([r.stdout, r.stderr].filter(Boolean).join('\n')),
    exitCode: r.exitCode,
    ms: r.ms,
  });
}

// Messages are handled one at a time: each run gets a fresh Go instance and
// shares the MemFS (and therefore golangci-lint's cache) with previous runs.
let queue = Promise.resolve();
self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  queue = queue.then(async () => {
    try {
      if (msg.type === 'init') await init(msg);
      else if (msg.type === 'lint') await lint(msg);
      else if (msg.type === 'format') await format(msg);
    } catch (err) {
      post({ type: 'error', id: msg.type === 'init' ? undefined : msg.id, message: String((err as Error)?.message ?? err) });
    }
  });
};
