const SAMPLE_CODE = `package main

import (
	"fmt"
	"net/http"
	"os"
)

func main() {
	f, _ := os.Open("x")
	defer f.Close()

	x := 1
	x = 2
	_ = x

	fmt.Printf("%d\\n", "str")

	resp, err := http.Get("https://example.com")
	if err != nil {
		return
	}
	_ = resp
}
`;

const SAMPLE_CONFIG = `version: "2"
linters:
  default: standard
  enable:
    - bodyclose
    - misspell
`;

const $ = (id) => document.getElementById(id);
const code = $('code');
const config = $('config');
const runBtn = $('run');
const status = $('status');
const results = $('results');
const stderrBox = $('stderr');

function restore(key, el, fallback) {
  try { el.value = localStorage.getItem(key) ?? fallback; } catch { el.value = fallback; }
  el.addEventListener('input', () => { try { localStorage.setItem(key, el.value); } catch {} });
}
restore('glp.code', code, SAMPLE_CODE);
restore('glp.config', config, SAMPLE_CONFIG);

// Tab inserts a tab character in the code editor.
code.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    code.setRangeText('\t', code.selectionStart, code.selectionEnd, 'end');
  }
});

// Parses txtar ("-- name --" headers). Plain text becomes main.go.
function parseFiles(text) {
  if (!/^-- .+ --$/m.test(text)) return { 'main.go': text };
  const files = {};
  let name = null;
  const lines = text.split('\n');
  let buf = [];
  const flush = () => { if (name) files[name] = buf.join('\n'); };
  for (const line of lines) {
    const m = line.match(/^-- (.+) --$/);
    if (m) { flush(); name = m[1].trim(); buf = []; } else if (name) buf.push(line);
  }
  flush();
  return files;
}

// Selects the given line of a file in the code editor.
function reveal(file, line) {
  const text = code.value;
  let base = 0;
  if (/^-- .+ --$/m.test(text)) {
    const header = text.indexOf(`-- ${file} --`);
    if (header < 0) return;
    base = text.indexOf('\n', header) + 1;
  }
  let start = base;
  for (let i = 1; i < line; i++) start = text.indexOf('\n', start) + 1;
  const end = text.indexOf('\n', start);
  code.focus();
  code.setSelectionRange(start, end < 0 ? text.length : end);
  const lineHeight = parseFloat(getComputedStyle(code).lineHeight) || 20;
  code.scrollTop = Math.max(0, (text.slice(0, start).split('\n').length - 5) * lineHeight);
}

const worker = new Worker('worker.js', { type: 'module' });
const progress = {};
let runId = 0;
let runStarted = 0;

function fmtMB(n) { return (n / 1e6).toFixed(1) + ' MB'; }

worker.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'progress': {
      progress[m.name] = m;
      const loaded = Object.values(progress).reduce((s, p) => s + p.loaded, 0);
      const total = Object.values(progress).reduce((s, p) => s + (p.total || p.loaded), 0);
      status.textContent = `ダウンロード中… ${fmtMB(loaded)} / ${fmtMB(total)}`;
      break;
    }
    case 'status':
      status.textContent = m.text;
      break;
    case 'ready':
      status.textContent = `準備完了（${(m.ms / 1000).toFixed(1)} 秒、${m.files} ファイル展開${m.cache ? '' : '、キャッシュなし'}）`;
      runBtn.disabled = false;
      document.body.dataset.ready = 'true';
      break;
    case 'result':
      if (m.id !== runId) return;
      renderResult(m);
      break;
    case 'error':
      results.innerHTML = '';
      results.append(Object.assign(document.createElement('div'), { className: 'error', textContent: m.message }));
      status.textContent = 'エラー';
      runBtn.disabled = !document.body.dataset.ready;
      break;
  }
};

function renderResult(m) {
  const wall = performance.now() - runStarted;
  runBtn.disabled = false;
  status.textContent = `完了: golangci-lint ${(m.ms / 1000).toFixed(2)} 秒（全体 ${(wall / 1000).toFixed(2)} 秒）`;
  stderrBox.textContent = m.stderr;
  results.innerHTML = '';
  if (!m.issues) {
    results.append(Object.assign(document.createElement('div'), {
      className: 'error',
      textContent: `golangci-lint の結果を取得できませんでした (exit ${m.exitCode})\n${m.stderr || m.stdout}`,
    }));
    document.body.dataset.lastRun = 'error';
    return;
  }
  const summary = document.createElement('div');
  summary.className = 'summary' + (m.issues.length ? '' : ' clean');
  summary.textContent = m.issues.length ? `${m.issues.length} 件の指摘` : '指摘はありません';
  results.append(summary);
  const ul = document.createElement('ul');
  for (const it of m.issues) {
    const li = document.createElement('li');
    const pos = Object.assign(document.createElement('span'), { className: 'pos', textContent: `${it.file}:${it.line}:${it.column} ` });
    const linter = Object.assign(document.createElement('span'), { className: `linter ${it.linter}`, textContent: it.linter });
    li.append(pos, linter, document.createTextNode(': ' + it.message));
    li.addEventListener('click', () => reveal(it.file, it.line));
    ul.append(li);
  }
  results.append(ul);
  document.body.dataset.lastRun = 'ok';
}

function run() {
  if (runBtn.disabled) return;
  runBtn.disabled = true;
  status.textContent = '検査中…';
  delete document.body.dataset.lastRun;
  const files = parseFiles(code.value);
  if (config.value.trim()) files['.golangci.yml'] = config.value;
  runStarted = performance.now();
  worker.postMessage({ type: 'run', id: ++runId, files });
}

runBtn.addEventListener('click', run);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); }
});
