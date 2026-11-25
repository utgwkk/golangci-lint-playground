import './style.css';
import type { Diagnostic } from '@codemirror/lint';
import type { EditorView } from '@codemirror/view';
import { fetchCatalog } from './config/catalog';
import { CancelledError, Engine, fetchVersions, type VersionInfo, type VersionsManifest } from './engine/client';
import type { Issue } from './engine/normalize';
import type { Files } from './engine/protocol';
import { CONFIG_FILE } from './engine/runner';
import { DEFAULT_CODE, DEFAULT_CONFIG, SAMPLES } from './samples';
import { decodeSnapshot, encodeSnapshot, type Snapshot } from './share';
import { createConfigEditor, createGoEditor, setConfigCatalog, setText } from './ui/editors';
import { FileTabs } from './ui/files';
import { fileRange } from './ui/positions';
import { renderIssues, renderMessage } from './ui/results';
import { ToolsPanel } from './ui/toolspanel';

type State = 'loading' | 'ready' | 'running' | 'error';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  version: $<HTMLSelectElement>('version'),
  run: $<HTMLButtonElement>('run'),
  format: $<HTMLButtonElement>('format'),
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
  renderMessage(ui.results, 'Run を押すと golangci-lint で検査します。');
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
    });
    byFile.set(issue.file, list);
  }
  tabs.setDiagnostics(byFile);
}

// ---- running ----

function collectFiles(): Files {
  const files = tabs.contents();
  const config = configEditor.state.doc.toString();
  if (config.trim()) files[CONFIG_FILE] = config;
  else delete files[CONFIG_FILE];
  return files;
}

async function run(): Promise<void> {
  if (state !== 'ready' || !engine) return;
  setState('running');
  tabs.setDiagnostics(new Map());
  const started = performance.now();
  const timer = setInterval(() => status(`検査中… ${((performance.now() - started) / 1000).toFixed(1)} 秒`), 100);
  status('検査中…');
  try {
    const result = await engine.lint(collectFiles());
    const seconds = ((performance.now() - started) / 1000).toFixed(2);
    ui.log.textContent = result.log;
    ui.logDetails.hidden = !result.log;
    if (result.issues) {
      renderIssues(ui.results, result.issues, select);
      showDiagnostics(result.issues);
      ui.summary.textContent = result.issues.length ? `${result.issues.length} 件` : '';
      status(`完了（${seconds} 秒）`);
      document.body.dataset.lastRun = 'ok';
    } else {
      // No report: golangci-lint failed before linting (e.g. an invalid configuration).
      renderMessage(ui.results, `golangci-lint が失敗しました（終了コード ${result.exitCode}）。\n${result.log}`, 'error');
      ui.logDetails.hidden = true;
      ui.summary.textContent = '';
      status(`失敗（${seconds} 秒）`);
      document.body.dataset.lastRun = 'failed';
    }
    setState('ready');
  } catch (err) {
    if (err instanceof CancelledError) {
      status('キャンセルしました');
      renderMessage(ui.results, 'キャンセルしました。');
      document.body.dataset.lastRun = 'cancelled';
      // engine.cancel() restarts the worker and sets the state back to ready.
    } else {
      renderMessage(ui.results, String((err as Error).message ?? err), 'error');
      status('エラー');
      document.body.dataset.lastRun = 'error';
      setState('ready');
    }
  } finally {
    clearInterval(timer);
  }
}

/** Formats all Go files with goimports (which also adds missing imports). */
async function format(): Promise<void> {
  if (state !== 'ready' || !engine) return;
  setState('running');
  status('goimports で整形中…');
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
      status(`構文エラーのため整形できなかったファイルがあります: ${failed.join(', ')}`);
      ui.log.textContent = result.log;
      ui.logDetails.hidden = false;
    } else if (changed.length) {
      status(`goimports で整形しました（${changed.join(', ')}）`);
    } else {
      status('goimports で整形しました（変更はありません）');
    }
    document.body.dataset.lastFormat = failed.length ? 'failed' : 'ok';
    setState('ready');
  } catch (err) {
    if (err instanceof CancelledError) {
      status('キャンセルしました');
      // engine.cancel() restarts the worker and sets the state back to ready.
    } else {
      status(`整形に失敗しました: ${(err as Error).message ?? err}`);
      document.body.dataset.lastFormat = 'error';
      setState('ready');
    }
  }
}

async function cancel(): Promise<void> {
  if (state !== 'running' || !engine) return;
  ui.cancel.disabled = true;
  status('キャンセル中…');
  try {
    await engine.cancel();
    setState('ready');
  } catch (err) {
    status(`再起動に失敗しました: ${(err as Error).message}`);
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
    status('共有 URL をコピーしました');
  } catch {
    status('共有 URL をアドレスバーに設定しました');
  }
  if (location.href.length > 8000) notice('共有 URL がとても長くなっています。一部の環境では開けない可能性があります。');
}

/** Loads a shared snapshot from the URL fragment. Shared code is never run automatically. */
async function loadFromHash(): Promise<string | null> {
  try {
    const s = await decodeSnapshot(location.hash);
    if (!s) return null;
    load(s.code, s.config);
    return s.version;
  } catch (err) {
    notice(`共有 URL を読み込めませんでした: ${(err as Error).message}`);
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
    const catalog = await fetchCatalog(new URL(info.path, base));
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
    status(loaded < total ? `golangci-lint ${info.version} をダウンロード中… ${mb(loaded)} / ${mb(total)} MB` : '準備中…');
  });
  ui.progress.hidden = true;
  status(`golangci-lint ${info.version}（${info.goVersion}）の準備ができました`);
  setState('ready');
}

async function main(): Promise<void> {
  setState('loading');
  if (!isChrome()) notice('この playground は Google Chrome で動作確認しています。他のブラウザでは正しく動作しない場合があります。');

  const sharedVersion = await loadFromHash();
  window.addEventListener('hashchange', () => void loadFromHash());

  manifest = await fetchVersions(base);
  for (const v of manifest.versions) ui.version.append(new Option(`${v.version}（${v.goVersion}）`, v.version));
  let info = manifest.versions.find((v) => v.version === manifest!.default)!;
  if (sharedVersion) {
    const shared = manifest.versions.find((v) => v.version === sharedVersion);
    if (shared) info = shared;
    else notice(`共有された golangci-lint ${sharedVersion} は利用できないため、${info.version} で開きました。`);
  }
  ui.version.value = info.version;
  await loadEngine(info);
}

ui.run.addEventListener('click', () => void run());
ui.format.addEventListener('click', () => void format());
ui.cancel.addEventListener('click', () => void cancel());
ui.share.addEventListener('click', () => void share());
ui.resetConfig.addEventListener('click', () => setText(configEditor, DEFAULT_CONFIG));
ui.openTools.addEventListener('click', () => toolsPanel.open());

for (const sample of SAMPLES) ui.sample.append(new Option(sample.title, sample.id));
ui.sample.addEventListener('change', () => {
  const sample = SAMPLES.find((s) => s.id === ui.sample.value);
  ui.sample.value = '';
  if (!sample) return;
  if (isModified() && !confirm(`編集中の内容を「${sample.title}」で置き換えますか？`)) return;
  load(sample.code, sample.config);
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  status(`サンプル「${sample.title}」: ${sample.description}`);
});
ui.version.addEventListener('change', () => {
  const info = manifest?.versions.find((v) => v.version === ui.version.value);
  if (info) void loadEngine(info).catch(fail);
});

function fail(err: unknown): void {
  ui.progress.hidden = true;
  status(`読み込みに失敗しました: ${(err as Error).message ?? err}`);
  renderMessage(ui.results, `golangci-lint を読み込めませんでした。\n${(err as Error).message ?? err}`, 'error');
  setState('error');
}

main().catch(fail);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // Without the service worker, assets are simply downloaded again on the next visit.
  });
}
