// Web Worker that owns the in-memory filesystem and runs golangci-lint (js/wasm).
//
// Messages from the page:
//   { type: 'run', id, files: { name: content } }
// Messages to the page:
//   { type: 'progress', name, loaded, total }
//   { type: 'status', text }
//   { type: 'ready', ms, files }
//   { type: 'result', id, issues, stderr, exitCode, ms }
//   { type: 'error', id?, message }

import { MemFS } from './gofs.js';
import { gunzip, loadBundle } from './bundle.js';
import { installGlobals, LINT_ARGS, parseIssues, runGolangciLint, writeWorkspace } from './runner.js';

const memfs = new MemFS();
installGlobals(memfs);
globalThis.process.umask ??= () => 0o022;
globalThis.process.getgroups ??= () => [];
await import('./wasm_exec.js');

let module = null;

async function fetchWithProgress(name) {
  const res = await fetch(name);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const total = Number(res.headers.get('Content-Length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    postMessage({ type: 'progress', name, loaded, total });
  }
  const buf = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  postMessage({ type: 'progress', name, loaded, total: loaded });
  return buf;
}

async function init() {
  const t0 = performance.now();
  const [wasmGz, std, cache] = await Promise.all([
    fetchWithProgress('golangci-lint.wasm.gz'),
    fetchWithProgress('std.bundle.gz'),
    fetchWithProgress('cache.bundle.gz').catch(() => null),
  ]);
  postMessage({ type: 'status', text: 'WASM をコンパイル中…' });
  module = await WebAssembly.compile(await gunzip(wasmGz));
  postMessage({ type: 'status', text: '標準ライブラリを展開中…' });
  let files = await loadBundle(memfs, std);
  if (cache) files += await loadBundle(memfs, cache);
  postMessage({ type: 'ready', ms: performance.now() - t0, files, cache: !!cache });
}

const ready = init().catch((e) => {
  postMessage({ type: 'error', message: `初期化に失敗しました: ${e.message}` });
  throw e;
});

// Runs are serialized: each one gets a fresh Go instance, sharing the MemFS
// (and therefore the golangci-lint cache) with previous runs.
let queue = Promise.resolve();
self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type !== 'run') return;
  queue = queue.then(async () => {
    try {
      await ready;
      writeWorkspace(memfs, msg.files);
      const r = await runGolangciLint(memfs, module, LINT_ARGS);
      postMessage({
        type: 'result',
        id: msg.id,
        issues: parseIssues(r.result),
        stdout: r.stdout,
        stderr: r.stderr,
        exitCode: r.exitCode,
        ms: r.ms,
      });
    } catch (err) {
      postMessage({ type: 'error', id: msg.id, message: String(err?.message ?? err) });
    }
  });
};
