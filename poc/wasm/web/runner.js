// Runs the js/wasm build of golangci-lint against files in a MemFS.
// Shared by the browser Web Worker and the Node.js scripts.
// Requires Go's wasm_exec.js to be loaded (it defines globalThis.Go).

export const PATHS = {
  goroot: '/goroot',
  exportDir: '/stdexport',
  manifest: '/stdmanifest.json',
  cache: '/cache/golangci-lint',
  home: '/home/user',
  work: '/work',
};

export const DEFAULT_GO_MOD = 'module playground\n\ngo 1.24\n';

// Installs memfs as globalThis.fs and a minimal process object whose cwd
// follows memfs. Must be called before running any Go instance.
export function installGlobals(memfs) {
  globalThis.fs = memfs;
  const proc = globalThis.process ?? (globalThis.process = {});
  proc.cwd = () => memfs.cwd;
  proc.chdir = (dir) => {
    const st = (() => { let s; memfs.stat(dir, (e, r) => { if (e) throw e; s = r; }); return s; })();
    if (!st.isDirectory()) throw Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' });
    memfs.cwd = memfs._abs(dir);
  };
  for (const k of ['getuid', 'getgid', 'geteuid', 'getegid']) proc[k] ??= () => -1;
  proc.pid ??= -1;
  proc.ppid ??= -1;
}

// Runs golangci-lint with args in cwd. Returns { exitCode, stdout, stderr, ms }.
export async function runGolangciLint(memfs, module, args, { cwd = PATHS.work, env = {} } = {}) {
  const out = { 1: [], 2: [] };
  memfs.onOutput = (fd, bytes) => out[fd].push(bytes);
  memfs.cwd = cwd;

  const go = new globalThis.Go();
  go.argv = ['golangci-lint', ...args];
  go.env = {
    HOME: PATHS.home,
    PATH: '',
    GOROOT: PATHS.goroot,
    GOOS: 'linux',
    GOARCH: 'amd64',
    CGO_ENABLED: '0',
    GOTOOLCHAIN: 'local',
    GOLANGCI_LINT_CACHE: PATHS.cache,
    GOCACHE: PATHS.home + '/.cache/go-build',
    WASM_STD_MANIFEST: PATHS.manifest,
    WASM_EXPORT_DIR: PATHS.exportDir,
    ...env,
  };
  let exitCode = 0;
  go.exit = (code) => { exitCode = code; };

  const started = performance.now();
  const instance = await WebAssembly.instantiate(module, go.importObject);
  await go.run(instance);
  const ms = performance.now() - started;
  // Timers the Go runtime scheduled before exiting would otherwise fire and
  // throw "Go program has already exited".
  for (const id of go._scheduledTimeouts?.values() ?? []) clearTimeout(id);
  go._scheduledTimeouts?.clear();

  const text = (chunks) => new TextDecoder().decode(concat(chunks));
  return { exitCode, stdout: text(out[1]), stderr: text(out[2]), ms };
}

function concat(chunks) {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  return buf;
}

// Replaces the contents of the work directory with the given files
// ({ name: content }). Adds a default go.mod when missing.
export function writeWorkspace(memfs, files) {
  memfs.removeAll(PATHS.work);
  memfs.mkdirAll(PATHS.work);
  if (!('go.mod' in files)) files = { 'go.mod': DEFAULT_GO_MOD, ...files };
  for (const [name, content] of Object.entries(files)) {
    if (!/^[A-Za-z0-9_.\-/]+$/.test(name) || name.split('/').includes('..')) {
      throw new Error(`invalid file name: ${name}`);
    }
    memfs.writeFile(`${PATHS.work}/${name}`, content);
  }
}

export const LINT_ARGS = [
  'run',
  '--allow-parallel-runners', // flock is unavailable on js/wasm
  '--output.json.path', 'stdout',
  '--show-stats=false',
  './...',
];

// Parses golangci-lint JSON output into a normalized issue list.
export function parseIssues(stdout) {
  const start = stdout.indexOf('{"Issues"');
  if (start < 0) return null;
  const report = JSON.parse(stdout.slice(start, stdout.lastIndexOf('}') + 1));
  const issues = [];
  for (const it of report.Issues ?? []) {
    if (it.FromLinter === 'typecheck') {
      // Type errors carry their real positions inside Text.
      let matched = false;
      for (const line of it.Text.split('\n')) {
        const m = line.match(/^(?:: )?(?:# \S+)?\s*\.?\/?([^:\s]+\.go):(\d+):(\d+): (.*)$/);
        if (m) {
          matched = true;
          issues.push({ linter: 'typecheck', file: m[1], line: +m[2], column: +m[3], message: m[4] });
        }
      }
      if (matched) continue;
    }
    issues.push({
      linter: it.FromLinter,
      file: it.Pos.Filename,
      line: it.Pos.Line,
      column: it.Pos.Column,
      message: it.Text,
      severity: it.Severity || undefined,
    });
  }
  return issues;
}
