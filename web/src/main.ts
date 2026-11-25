import './style.css';
import type { Diagnostic } from '@codemirror/lint';
import type { EditorView } from '@codemirror/view';
import { fetchCatalog } from './config/catalog';
import { CancelledError, Engine, fetchVersions, type VersionInfo, type VersionsManifest } from './engine/client';
import type { Fix, Issue } from './engine/normalize';
import type { Files, LintResult } from './engine/protocol';
import { CONFIG_FILE } from './engine/runner';
import { applyFix } from './fixes';
import { DEFAULT_CODE, DEFAULT_CONFIG, SAMPLES } from './samples';
import { decodeSnapshot, encodeSnapshot, type Snapshot } from './share';
import { createConfigEditor, createGoEditor, setConfigCatalog, setText } from './ui/editors';
import { FileTabs } from './ui/files';
import { fileRange } from './ui/positions';
import { renderIssues, renderMessage } from './ui/results';
import { LicensesDialog } from './ui/licenses';
import { ToolsPanel } from './ui/toolspanel';

type State = 'loading' | 'ready' | 'running' | 'error';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  version: $<HTMLSelectElement>('version'),
  run: $<HTMLButtonElement>('run'),
  format: $<HTMLButtonElement>('format'),
  fix: $<HTMLButtonElement>('fix'),
  cancel: $<HTMLButtonElement>('cancel'),
  share: $<HTMLButtonElement>('share'),
  progress: $<HTMLProgressElement>('progress'),
  statusText: $('status-text'),
  notice: $('notice'),
  results: $('results'),
  summary: $('summary'),
  logDetails: $<HTMLDetailsElement>('log-details'),
  log: $('log'),
  resetConfig: $<HTMLButtonElement>('reset-config'),
  openTools: $<HTMLButtonElement>('open-tools'),
  openLicenses: $<HTMLButtonElement>('open-licenses'),
  sample: $<HTMLSelectElement>('sample'),
};

const STORAGE_KEY = 'golangci-lint-playground:draft';
const base = new URL('./', document.baseURI);

let engine: Engine | null = null;
let manifest: VersionsManifest | null = null;
let state: State = 'loading';

function setState(s: State): void {
  state = s;
  document.body.dataset.state = s;
  ui.run.disabled = s !== 'ready';
  ui.format.disabled = s !== 'ready';
  ui.fix.disabled = s !== 'ready';
  ui.cancel.hidden = s !== 'running';
  ui.version.disabled = s === 'running' || !manifest || manifest.versions.length < 2;
}

function status(text: string): void {
  ui.statusText.textContent = text;
}

function notice(text: string | null): void {
  ui.notice.hidden = !text;
  ui.notice.textContent = text ?? '';
}

// ---- draft persistence (per browser; shared links take precedence) ----

function loadDraft(): { code: string; config: string } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function saveDraft(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ code: tabs.text(), config: configEditor.state.doc.toString() }));
    } catch {
      // Storage may be unavailable (private mode, blocked site data).
    }
  }, 500);
}

// ---- editors ----

const draft = loadDraft();
const goEditor = createGoEditor($('code'), () => void run(), saveDraft, () => void format());
const tabs = new FileTabs({ view: goEditor.view, container: $('tabs'), createState: goEditor.createState, onChange: saveDraft });
tabs.load(draft?.code ?? DEFAULT_CODE);
const configEditor: EditorView = createConfigEditor($('config'), draft?.config ?? DEFAULT_CONFIG, () => void run(), saveDraft);

const toolsPanel = new ToolsPanel({
  dialog: $<HTMLDialogElement>('tools-dialog'),
  getText: () => configEditor.state.doc.toString(),
  apply: (edits) => configEditor.dispatch({ changes: edits }),
});

/** What was last loaded (draft, sample or shared link), to tell whether the user changed it. */
let baseline = { code: tabs.text(), config: configEditor.state.doc.toString() };
function isModified(): boolean {
  return tabs.text() !== baseline.code || configEditor.state.doc.toString() !== baseline.config;
}

function load(code: string, config: string): void {
  tabs.load(code);
  setText(configEditor, config);
  baseline = { code: tabs.text(), config };
  renderMessage(ui.results, 'Press Run to lint with golangci-lint.');
  ui.summary.textContent = '';
  ui.logDetails.hidden = true;
  saveDraft();
}

function select(issue: Issue): void {
  const content = tabs.content(issue.file);
  if (content === null) return;
  const r = fileRange(content, issue);
  tabs.select(issue.file, r.from, r.to);
}

function showDiagnostics(issues: Issue[]): void {
  const byFile = new Map<string, Diagnostic[]>();
  for (const issue of issues) {
    const content = tabs.content(issue.file);
    if (content === null) continue;
    const r = fileRange(content, issue);
    const list = byFile.get(issue.file) ?? [];
    list.push({
      from: Math.min(r.from, content.length),
      to: Math.min(r.to, content.length),
      severity: issue.linter === 'typecheck' ? 'error' : 'warning',
      source: issue.linter,
      message: issue.message,
      actions: (issue.fixes ?? []).map((fix) => ({ name: fixLabel(fix), apply: () => void quickFix(issue, fix) })),
    });
    byFile.set(issue.file, list);
  }
  tabs.setDiagnostics(byFile);
}

// ---- running ----

/** The code files as they were when the shown results were produced (null if there are no results). */
let lintedContents: Files | null = null;

function codeFiles(files: Files): Files {
  const { [CONFIG_FILE]: _config, ...code } = files;
  return code;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function fixLabel(fix: Fix): string {
  return fix.message ? `Fix: ${fix.message}` : 'Fix';
}

/** Shows a lint report. Returns false if golangci-lint failed before linting. */
function showResult(result: LintResult, linted: Files): boolean {
  ui.log.textContent = result.log;
  ui.logDetails.hidden = !result.log;
  if (result.issues) {
    lintedContents = linted;
    renderIssues(ui.results, result.issues, select, (issue, fix) => void quickFix(issue, fix), fixLabel);
    showDiagnostics(result.issues);
    ui.summary.textContent = result.issues.length ? plural(result.issues.length, 'issue') : '';
    document.body.dataset.lastRun = 'ok';
    return true;
  }
  // No report: golangci-lint failed before linting (e.g. an invalid configuration).
  lintedContents = null;
  renderMessage(ui.results, `golangci-lint failed (exit code ${result.exitCode}).\n${result.log}`, 'error');
  ui.logDetails.hidden = true;
  ui.summary.textContent = '';
  document.body.dataset.lastRun = 'failed';
  return false;
}

function handleRunError(err: unknown): void {
  if (err instanceof CancelledError) {
    status('Cancelled');
    renderMessage(ui.results, 'Cancelled.');
    document.body.dataset.lastRun = 'cancelled';
    // engine.cancel() restarts the worker and sets the state back to ready.
  } else {
    renderMessage(ui.results, String((err as Error).message ?? err), 'error');
    status('Error');
    document.body.dataset.lastRun = 'error';
    setState('ready');
  }
}

function collectFiles(): Files {
  const files = tabs.contents();
  const config = configEditor.state.doc.toString();
  if (config.trim()) files[CONFIG_FILE] = config;
  else delete files[CONFIG_FILE];
  return files;
}

async function run(prefix = ''): Promise<void> {
  if (state !== 'ready' || !engine) return;
  setState('running');
  tabs.setDiagnostics(new Map());
  const started = performance.now();
  const timer = setInterval(() => status(`${prefix}Linting… ${((performance.now() - started) / 1000).toFixed(1)} s`), 100);
  status(`${prefix}Linting…`);
  try {
    const files = collectFiles();
    const result = await engine.lint(files);
    const seconds = ((performance.now() - started) / 1000).toFixed(2);
    status(showResult(result, codeFiles(files)) ? `${prefix}Done (${seconds} s)` : `${prefix}Failed (${seconds} s)`);
    setState('ready');
  } catch (err) {
    handleRunError(err);
  } finally {
    clearInterval(timer);
  }
}

/** Applies all fixes golangci-lint can make (`run --fix`) and shows the remaining issues. */
async function fixAll(): Promise<void> {
  if (state !== 'ready' || !engine) return;
  setState('running');
  tabs.setDiagnostics(new Map());
  status('Fixing…');
  try {
    const result = await engine.fix(collectFiles());
    const changed = Object.entries(result.files)
      .filter(([name, content]) => tabs.replaceContent(name, content))
      .map(([name]) => name);
    if (showResult(result, tabs.contents())) {
      const remaining = result.issues!.length;
      status(
        changed.length
          ? `Fixed ${changed.join(', ')}. Remaining issues: ${remaining}`
          : `Nothing to fix automatically (issues: ${remaining})`,
      );
    } else {
      status('Failed');
    }
    setState('ready');
  } catch (err) {
    handleRunError(err);
  }
}

/** Applies one suggested fix, then lints again. */
async function quickFix(issue: Issue, fix: Fix): Promise<void> {
  if (state !== 'ready') return;
  const current = tabs.content(issue.file);
  // The fix's offsets refer to the linted content.
  if (current === null || lintedContents?.[issue.file] !== current) {
    status('The code changed after the run, so this fix cannot be applied. Run again.');
    return;
  }
  let next: string;
  try {
    next = applyFix(current, fix);
  } catch (err) {
    status(`Could not apply the fix: ${(err as Error).message}`);
    return;
  }
  tabs.replaceContent(issue.file, next);
  await run(`Applied the ${issue.linter} fix. `);
}

/** Formats all Go files with goimports (which also adds missing imports). */
async function format(): Promise<void> {
  if (state !== 'ready' || !engine) return;
  setState('running');
  status('Formatting with goimports…');
  delete document.body.dataset.lastFormat;
  try {
    const result = await engine.format(tabs.contents());
    const changed = Object.entries(result.files)
      .filter(([name, content]) => tabs.replaceContent(name, content))
      .map(([name]) => name);
    // goimports leaves files it cannot parse unchanged and logs
    // `(goimports) formatting file NAME: ...`.
    const failed = [...new Set([...result.log.matchAll(/formatting file (\S+?):/g)].map((m) => m[1]))];
    if (failed.length) {
      status(`Could not format files with syntax errors: ${failed.join(', ')}`);
      ui.log.textContent = result.log;
      ui.logDetails.hidden = false;
    } else if (changed.length) {
      status(`Formatted with goimports: ${changed.join(', ')}`);
    } else {
      status('Formatted with goimports (no changes)');
    }
    document.body.dataset.lastFormat = failed.length ? 'failed' : 'ok';
    setState('ready');
  } catch (err) {
    if (err instanceof CancelledError) {
      status('Cancelled');
      // engine.cancel() restarts the worker and sets the state back to ready.
    } else {
      status(`Formatting failed: ${(err as Error).message ?? err}`);
      document.body.dataset.lastFormat = 'error';
      setState('ready');
    }
  }
}

async function cancel(): Promise<void> {
  if (state !== 'running' || !engine) return;
  ui.cancel.disabled = true;
  status('Cancelling…');
  try {
    await engine.cancel();
    setState('ready');
  } catch (err) {
    status(`Could not restart the engine: ${(err as Error).message}`);
    setState('error');
  } finally {
    ui.cancel.disabled = false;
  }
}

// ---- sharing ----

function snapshot(): Snapshot {
  return {
    schema: 1,
    version: engine?.info.version ?? manifest?.default ?? '',
    code: tabs.text(),
    config: configEditor.state.doc.toString(),
  };
}

async function share(): Promise<void> {
  const hash = await encodeSnapshot(snapshot());
  history.replaceState(null, '', `#${hash}`);
  try {
    await navigator.clipboard.writeText(location.href);
    status('Copied the share URL');
  } catch {
    status('The share URL is in the address bar');
  }
  if (location.href.length > 8000) notice('The share URL is very long. Some environments may not be able to open it.');
}

/** Loads a shared snapshot from the URL fragment. Shared code is never run automatically. */
async function loadFromHash(): Promise<string | null> {
  try {
    const s = await decodeSnapshot(location.hash);
    if (!s) return null;
    load(s.code, s.config);
    return s.version;
  } catch (err) {
    notice(`Could not load the shared link: ${(err as Error).message}`);
    return null;
  }
}

// ---- startup ----

function isChrome(): boolean {
  const brands = (navigator as Navigator & { userAgentData?: { brands: { brand: string }[] } }).userAgentData?.brands;
  if (brands) return brands.some((b) => b.brand === 'Google Chrome' || b.brand === 'Chromium');
  return /Chrome\//.test(navigator.userAgent) && !/Edg\/|OPR\//.test(navigator.userAgent);
}

/** Loads the schema and the lists of linters/formatters of a version (not required to run). */
async function loadCatalog(info: VersionInfo): Promise<void> {
  ui.openTools.disabled = true;
  try {
    const catalog = await fetchCatalog(base, info);
    setConfigCatalog(configEditor, catalog);
    toolsPanel.setCatalog(catalog);
    ui.openTools.disabled = false;
  } catch (err) {
    setConfigCatalog(configEditor, null);
    toolsPanel.setCatalog(null);
    console.warn('could not load the configuration schema', err);
  }
}

async function loadEngine(info: VersionInfo): Promise<void> {
  setState('loading');
  void loadCatalog(info);
  const mb = (n: number) => (n / 1e6).toFixed(1);
  ui.progress.hidden = false;
  engine = new Engine(base, info);
  await engine.load(({ loaded, total }) => {
    ui.progress.max = total || 1;
    ui.progress.value = loaded;
    status(loaded < total ? `Downloading golangci-lint ${info.version}… ${mb(loaded)} / ${mb(total)} MB` : 'Preparing…');
  });
  ui.progress.hidden = true;
  status(`golangci-lint ${info.version} (${info.goVersion}) is ready`);
  setState('ready');
}

async function main(): Promise<void> {
  setState('loading');
  if (!isChrome()) notice('This playground is tested with Google Chrome. It may not work correctly in other browsers.');

  const sharedVersion = await loadFromHash();
  window.addEventListener('hashchange', () => void loadFromHash());

  manifest = await fetchVersions(base);
  for (const v of manifest.versions) ui.version.append(new Option(`${v.version} (${v.goVersion})`, v.version));
  let info = manifest.versions.find((v) => v.version === manifest!.default)!;
  if (sharedVersion) {
    const shared = manifest.versions.find((v) => v.version === sharedVersion);
    if (shared) info = shared;
    else notice(`golangci-lint ${sharedVersion} from the shared link is not available, so it was opened with ${info.version}.`);
  }
  ui.version.value = info.version;
  await loadEngine(info);
}

ui.run.addEventListener('click', () => void run());
ui.format.addEventListener('click', () => void format());
ui.fix.addEventListener('click', () => void fixAll());
ui.cancel.addEventListener('click', () => void cancel());
ui.share.addEventListener('click', () => void share());
ui.resetConfig.addEventListener('click', () => setText(configEditor, DEFAULT_CONFIG));
ui.openTools.addEventListener('click', () => toolsPanel.open());
const licensesDialog = new LicensesDialog($<HTMLDialogElement>('licenses-dialog'), base);
ui.openLicenses.addEventListener('click', () => licensesDialog.open(manifest?.versions.find((v) => v.version === ui.version.value) ?? null));

for (const sample of SAMPLES) ui.sample.append(new Option(sample.title, sample.id));
ui.sample.addEventListener('change', () => {
  const sample = SAMPLES.find((s) => s.id === ui.sample.value);
  ui.sample.value = '';
  if (!sample) return;
  if (isModified() && !confirm(`Replace the current code and configuration with the sample "${sample.title}"?`)) return;
  load(sample.code, sample.config);
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  status(`Sample "${sample.title}": ${sample.description}`);
});
ui.version.addEventListener('change', () => {
  const info = manifest?.versions.find((v) => v.version === ui.version.value);
  if (info) void loadEngine(info).catch(fail);
});

function fail(err: unknown): void {
  ui.progress.hidden = true;
  status(`Failed to load: ${(err as Error).message ?? err}`);
  renderMessage(ui.results, `Could not load golangci-lint.\n${(err as Error).message ?? err}`, 'error');
  setState('error');
}

main().catch(fail);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // Without the service worker, assets are simply downloaded again on the next visit.
  });
}
