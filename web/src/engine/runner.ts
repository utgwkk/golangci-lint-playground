// Runs the js/wasm build of golangci-lint against files in a MemFS.
// Shared by the browser worker and the Node.js scripts (cache seeding, parity tests).
// Requires Go's wasm_exec.js to be loaded (it defines globalThis.Go).

import './go.d';
import type { MemFS } from './gofs';
import type { Files } from './protocol';

export const PATHS = {
  goroot: '/goroot',
  exportDir: '/stdexport',
  manifest: '/stdmanifest.json',
  cache: '/cache/golangci-lint',
  home: '/home/user',
  work: '/work',
  /** The JSON report is written here (see LINT_ARGS). */
  report: '/tmp/report.json',
} as const;

export const CONFIG_FILE = '.golangci.yml';

export const LINT_ARGS = [
  'run',
  // flock is unavailable on js/wasm.
  '--allow-parallel-runners',
  // The JSON report goes to a file so that output settings in the user's
  // .golangci.yml cannot interfere with it (flags take precedence over the config).
  '--output.json.path', PATHS.report,
  '--show-stats=false',
  './...',
];

/** Like LINT_ARGS, but applies the fixes of auto-fixable issues to the files. */
export const FIX_ARGS = [...LINT_ARGS.slice(0, -1), '--fix', './...'];

/** Adds --verbose to LINT_ARGS or FIX_ARGS: the log then has timings and other statistics (see stats.ts). */
export function verboseArgs(args: string[]): string[] {
  return [...args.slice(0, -1), '--verbose', ...args.slice(-1)];
}

/**
 * Formats with goimports only (also adds missing and removes unused imports).
 * The user's configuration is not read, so that the result does not depend on
 * other formatters enabled there. Without paths, fmt walks the working directory.
 */
export const FORMAT_ARGS = ['fmt', '--no-config', '-E', 'goimports'];

/**
 * Installs memfs as globalThis.fs and makes process.cwd follow memfs.
 * Must be called before wasm_exec.js is loaded and before running Go.
 */
export function installGlobals(memfs: MemFS): void {
  (globalThis as { fs?: unknown }).fs = memfs;
  const g = globalThis as unknown as { process?: Record<string, unknown> };
  const proc = g.process ?? (g.process = {});
  proc.cwd = () => memfs.cwd;
  proc.chdir = (dir: string) => {
    const abs = memfs.abs(dir);
    if (!memfs.exists(abs)) throw Object.assign(new Error(`ENOENT: chdir ${dir}`), { code: 'ENOENT' });
    memfs.cwd = abs;
  };
  for (const k of ['getuid', 'getgid', 'geteuid', 'getegid']) proc[k] ??= () => -1;
  proc.getgroups ??= () => [];
  proc.umask ??= () => 0o022;
  proc.pid ??= -1;
  proc.ppid ??= -1;
}

export interface RunOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Content of PATHS.report, or null if golangci-lint did not write it. */
  report: string | null;
  ms: number;
}

/** Runs golangci-lint once in a fresh Go instance. The MemFS (and its cache) is shared between runs. */
export async function runGolangciLint(memfs: MemFS, module: WebAssembly.Module, args: string[] = LINT_ARGS): Promise<RunOutput> {
  const out: Record<number, Uint8Array[]> = { 1: [], 2: [] };
  memfs.onOutput = (fd, bytes) => out[fd].push(bytes);
  memfs.cwd = PATHS.work;
  memfs.mkdirAll('/tmp');
  memfs.removeAll(PATHS.report);

  const go = new Go();
  go.argv = ['golangci-lint', ...args];
  go.env = {
    HOME: PATHS.home,
    PATH: '',
    GOROOT: PATHS.goroot,
    GOOS: 'linux',
    GOARCH: 'amd64',
    CGO_ENABLED: '0',
    GOTOOLCHAIN: 'local',
    GOFLAGS: '',
    GOLANGCI_LINT_CACHE: PATHS.cache,
    GOCACHE: PATHS.home + '/.cache/go-build',
    WASM_STD_MANIFEST: PATHS.manifest,
    WASM_EXPORT_DIR: PATHS.exportDir,
  };
  let exitCode = 0;
  go.exit = (code) => {
    exitCode = code;
  };

  const started = performance.now();
  const instance = await WebAssembly.instantiate(module, go.importObject);
  await go.run(instance);
  const ms = performance.now() - started;
  // Timers the Go runtime scheduled before exiting would otherwise fire later
  // and throw "Go program has already exited".
  for (const handle of go._scheduledTimeouts?.values() ?? []) clearTimeout(handle);
  go._scheduledTimeouts?.clear();

  const text = (chunks: Uint8Array[]) => chunks.map((c) => new TextDecoder().decode(c)).join('');
  let report: string | null = null;
  if (memfs.exists(PATHS.report)) report = new TextDecoder().decode(memfs.readFile(PATHS.report));
  return { exitCode, stdout: text(out[1]), stderr: text(out[2]), report, ms };
}

/** "go1.27.4" -> "1.27" */
export function goLanguageVersion(goVersion: string): string {
  const m = goVersion.match(/^go(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : '1.25';
}

export function defaultGoMod(goVersion: string): string {
  return `module playground\n\ngo ${goLanguageVersion(goVersion)}\n`;
}

const FILE_NAME = /^[A-Za-z0-9_.\-]+(\/[A-Za-z0-9_.\-]+)*$/;

export function isValidFileName(name: string): boolean {
  return FILE_NAME.test(name) && !name.split('/').some((p) => p === '..' || p === '.');
}

/** Replaces the workspace with the given files. Adds a default go.mod when missing. */
export function writeWorkspace(memfs: MemFS, files: Files, goVersion: string): void {
  memfs.removeAll(PATHS.work);
  memfs.mkdirAll(PATHS.work);
  const all: Files = { 'go.mod': defaultGoMod(goVersion), ...files };
  for (const [name, content] of Object.entries(all)) {
    if (!isValidFileName(name)) throw new Error(`invalid file name: ${name}`);
    memfs.writeFile(`${PATHS.work}/${name}`, content);
  }
}

/** Reads files back from the workspace (e.g. after formatting). Missing files are skipped. */
export function readWorkspace(memfs: MemFS, names: string[]): Files {
  const out: Files = {};
  for (const name of names) {
    const path = `${PATHS.work}/${name}`;
    if (memfs.exists(path)) out[name] = new TextDecoder().decode(memfs.readFile(path));
  }
  return out;
}
