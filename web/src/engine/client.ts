// Main-thread side of the engine: downloads and verifies the assets of a
// golangci-lint version, compiles the WebAssembly module, and drives the worker.

import type { Files, FromWorker, LintResult, ToWorker } from './protocol';

export interface AssetInfo {
  size: number;
  sha256: string;
}

export interface VersionInfo {
  version: string;
  goVersion: string;
  /** Directory of the version's assets, relative to the site root (e.g. "v/v2.5.0/"). */
  path: string;
  files: Record<string, AssetInfo>;
}

export interface VersionsManifest {
  default: string;
  versions: VersionInfo[];
}

export interface Progress {
  loaded: number;
  total: number;
}

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

const ASSETS = ['golangci-lint.wasm.bin', 'std.bundle.bin', 'cache.bundle.bin'] as const;

export async function fetchVersions(base: URL): Promise<VersionsManifest> {
  const res = await fetch(new URL('versions.json', base), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`versions.json: HTTP ${res.status}`);
  return res.json();
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function download(url: URL, onChunk: (n: number) => void): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url.pathname}: HTTP ${res.status}`);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    onChunk(value.length);
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export class Engine {
  private worker: Worker | null = null;
  private init: Extract<ToWorker, { type: 'init' }> | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: LintResult) => void; reject: (e: Error) => void }>();

  constructor(
    private readonly base: URL,
    readonly info: VersionInfo,
  ) {}

  /** Downloads, verifies and compiles the assets, then starts the worker. */
  async load(onProgress: (p: Progress) => void): Promise<void> {
    const dir = new URL(this.info.path, this.base);
    const total = ASSETS.reduce((s, name) => s + (this.info.files[name]?.size ?? 0), 0);
    let loaded = 0;
    onProgress({ loaded, total });
    const [wasm, std, cache] = await Promise.all(
      ASSETS.map(async (name) => {
        const bytes = await download(new URL(name, dir), (n) => {
          loaded += n;
          onProgress({ loaded, total });
        });
        const expected = this.info.files[name]?.sha256;
        if (expected && (await sha256Hex(bytes)) !== expected) throw new Error(`${name}: checksum mismatch`);
        return bytes;
      }),
    );
    const { gunzip } = await import('./bundle');
    const module = await WebAssembly.compile(await gunzip(wasm));
    this.init = {
      type: 'init',
      module,
      wasmExecUrl: new URL('wasm_exec.js', dir).href,
      std,
      cache,
      goVersion: this.info.goVersion,
    };
    await this.start();
  }

  private start(): Promise<void> {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    this.ready = new Promise((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<FromWorker>) => {
        const msg = e.data;
        if (msg.type === 'ready') {
          resolve();
        } else if (msg.type === 'result') {
          const { type: _type, id, ...result } = msg;
          this.pending.get(id)?.resolve(result);
          this.pending.delete(id);
        } else if (msg.type === 'error') {
          if (msg.id === undefined) {
            reject(new Error(msg.message));
          } else {
            this.pending.get(msg.id)?.reject(new Error(msg.message));
            this.pending.delete(msg.id);
          }
        }
      };
      worker.onerror = (e) => reject(new Error(e.message || 'worker error'));
    });
    // The bundles are copied (not transferred) so that the worker can be restarted.
    worker.postMessage(this.init!);
    return this.ready;
  }

  async lint(files: Files): Promise<LintResult> {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ type: 'lint', id, files } satisfies ToWorker);
    });
  }

  /** Stops the running lint (if any) by replacing the worker. The analysis cache built so far is lost. */
  async cancel(): Promise<void> {
    this.worker?.terminate();
    for (const p of this.pending.values()) p.reject(new CancelledError());
    this.pending.clear();
    await this.start();
  }
}
