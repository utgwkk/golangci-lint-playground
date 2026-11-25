// Main-thread side of the engine: downloads and verifies the assets of a
// golangci-lint version, compiles the WebAssembly module, and drives the worker.

import type { FixResult, Files, FormatResult, FromWorker, LintResult, ToWorker } from './protocol';

export interface AssetInfo {
  size: number;
  sha256: string;
}

export interface VersionInfo {
  version: string;
  goVersion: string;
  /** Directory of the version's assets, relative to the site root (e.g. "v/v2.5.0/"). */
  path: string;
  /** Every file in the directory. */
  files: Record<string, AssetInfo>;
}

/**
 * URL of a file of a version, with its content hash as "?v=...". Files of a
 * version can be rebuilt under the same path, so the hash makes the URL change
 * with the content: browser and service worker caches never serve a stale file.
 */
export function assetUrl(base: URL, info: VersionInfo, name: string): URL {
  const url = new URL(name, new URL(info.path, base));
  const sha = info.files[name]?.sha256;
  if (sha) url.searchParams.set('v', sha.slice(0, 16));
  return url;
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

async function download(url: URL, onChunk: (n: number) => void, init?: RequestInit): Promise<Uint8Array> {
  const res = await fetch(url, init);
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
  private pending = new Map<number, { resolve: (r: never) => void; reject: (e: Error) => void }>();

  constructor(
    private readonly base: URL,
    readonly info: VersionInfo,
  ) {}

  /** Downloads, verifies and compiles the assets, then starts the worker. */
  async load(onProgress: (p: Progress) => void): Promise<void> {
    const total = ASSETS.reduce((s, name) => s + (this.info.files[name]?.size ?? 0), 0);
    let loaded = 0;
    onProgress({ loaded, total });
    const [wasm, std, cache] = await Promise.all(
      ASSETS.map(async (name) => {
        const url = assetUrl(this.base, this.info, name);
        const expected = this.info.files[name]?.sha256;
        let counted = 0;
        const fetchOnce = async (init?: RequestInit) => {
          loaded -= counted; // a retry starts over
          counted = 0;
          return download(url, (n) => {
            counted += n;
            loaded += n;
            onProgress({ loaded, total });
          }, init);
        };
        let bytes = await fetchOnce();
        if (expected && (await sha256Hex(bytes)) !== expected) {
          // Stale copy somewhere (e.g. a CDN still serving the previous deploy): retry once, bypassing caches.
          bytes = await fetchOnce({ cache: 'reload' });
          if ((await sha256Hex(bytes)) !== expected) {
            throw new Error(`${name}: checksum mismatch (the site may have just been deployed; reload in a moment)`);
          }
        }
        return bytes;
      }),
    );
    const { gunzip } = await import('./bundle');
    const module = await WebAssembly.compile(await gunzip(wasm));
    this.init = {
      type: 'init',
      module,
      wasmExecUrl: assetUrl(this.base, this.info, 'wasm_exec.js').href,
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
        } else if (msg.type === 'result' || msg.type === 'formatted' || msg.type === 'fixed') {
          const { type: _type, id, ...result } = msg;
          this.pending.get(id)?.resolve(result as never);
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

  private request<T>(type: 'lint' | 'format' | 'fix', files: Files): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: never) => void, reject });
      this.worker!.postMessage({ type, id, files } satisfies ToWorker);
    });
  }

  async lint(files: Files): Promise<LintResult> {
    await this.ready;
    return this.request<LintResult>('lint', files);
  }

  /** Lints with --fix: returns the fixed files and the issues that remain. */
  async fix(files: Files): Promise<FixResult> {
    await this.ready;
    return this.request<FixResult>('fix', files);
  }

  /** Formats the Go files with goimports (see FORMAT_ARGS). */
  async format(files: Files): Promise<FormatResult> {
    await this.ready;
    return this.request<FormatResult>('format', files);
  }

  /** Stops the running lint (if any) by replacing the worker. The analysis cache built so far is lost. */
  async cancel(): Promise<void> {
    this.worker?.terminate();
    for (const p of this.pending.values()) p.reject(new CancelledError());
    this.pending.clear();
    await this.start();
  }
}
