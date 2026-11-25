// Files of the Go editor, shown as tabs. Each file keeps its own EditorState
// (undo history, selection, lint markers); one EditorView shows the active one.
// The files are exchanged with the rest of the app as txtar text.

import { setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { EditorSelection, type EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { CONFIG_FILE, isValidFileName } from '../engine/runner';
import { diff } from '../textdiff';
import { formatTxtar, parseTxtar } from '../txtar';

interface FileEntry {
  name: string;
  state: EditorState;
  issues: number;
}

export interface FileTabsOptions {
  view: EditorView;
  container: HTMLElement;
  createState: (doc: string) => EditorState;
  onChange: () => void;
}

/** Why a file name cannot be used, or null if it can. */
export function fileNameError(name: string, existing: string[]): string | null {
  if (!name) return 'ファイル名を入力してください';
  if (name === CONFIG_FILE) return '.golangci.yml は右側の設定エディタで編集してください';
  if (!isValidFileName(name)) return '使えない文字が含まれています（英数字と _ . - / のみ）';
  if (existing.includes(name)) return '同じ名前のファイルがあります';
  return null;
}

export class FileTabs {
  private files: FileEntry[] = [];
  private active = 0;
  private editing: { index: number | null } | null = null;

  constructor(private readonly opts: FileTabsOptions) {}

  get activeName(): string {
    return this.files[this.active]?.name ?? '';
  }

  names(): string[] {
    return this.files.map((f) => f.name);
  }

  private sync(): void {
    if (this.files[this.active]) this.files[this.active].state = this.opts.view.state;
  }

  /** Replaces all files with the files of a txtar text (plain text is main.go). */
  load(text: string): void {
    const parsed = parseTxtar(text).filter((f) => f.name !== CONFIG_FILE);
    if (!parsed.length) parsed.push({ name: 'main.go', content: '', offset: 0 });
    this.files = parsed.map((f) => ({ name: f.name, state: this.opts.createState(f.content), issues: 0 }));
    const main = this.files.findIndex((f) => f.name === 'main.go');
    this.active = main >= 0 ? main : 0;
    this.opts.view.setState(this.files[this.active].state);
    this.editing = null;
    this.render();
  }

  /** The files as txtar text (plain Go source for a lone main.go). */
  text(): string {
    this.sync();
    return formatTxtar(this.files.map((f) => ({ name: f.name, content: f.state.doc.toString() })));
  }

  contents(): Record<string, string> {
    this.sync();
    return Object.fromEntries(this.files.map((f) => [f.name, f.state.doc.toString()]));
  }

  content(name: string): string | null {
    this.sync();
    return this.files.find((f) => f.name === name)?.state.doc.toString() ?? null;
  }

  activate(name: string): boolean {
    const index = this.files.findIndex((f) => f.name === name);
    if (index < 0) return false;
    if (index !== this.active) {
      this.sync();
      this.active = index;
      this.opts.view.setState(this.files[index].state);
      this.render();
    }
    return true;
  }

  /**
   * Replaces the content of a file with a minimal edit (an undoable change; the
   * cursor and lint markers outside the changed part stay where they are).
   * Returns whether the file changed.
   */
  replaceContent(name: string, content: string): boolean {
    this.sync();
    const index = this.files.findIndex((f) => f.name === name);
    if (index < 0) return false;
    const changes = diff(this.files[index].state.doc.toString(), content);
    if (!changes.length) return false;
    if (index === this.active) {
      this.opts.view.dispatch({ changes, userEvent: 'format' });
      this.files[index].state = this.opts.view.state;
    } else {
      this.files[index].state = this.files[index].state.update({ changes, userEvent: 'format' }).state;
      this.opts.onChange();
    }
    return true;
  }

  /** Selects a range in a file (switching to its tab). */
  select(name: string, from: number, to: number): void {
    if (!this.activate(name)) return;
    const view = this.opts.view;
    const len = view.state.doc.length;
    view.dispatch({ selection: EditorSelection.range(Math.min(from, len), Math.min(to, len)), scrollIntoView: true });
    view.focus();
  }

  /** Sets lint markers of every file (files missing from the map are cleared). */
  setDiagnostics(byFile: Map<string, Diagnostic[]>): void {
    this.sync();
    this.files.forEach((f, i) => {
      const ds = byFile.get(f.name) ?? [];
      f.issues = ds.length;
      if (i === this.active) {
        this.opts.view.dispatch(setDiagnostics(this.opts.view.state, ds));
        f.state = this.opts.view.state;
      } else {
        f.state = f.state.update(setDiagnostics(f.state, ds)).state;
      }
    });
    this.render();
  }

  private add(name: string): void {
    this.sync();
    // A new Go file starts with a package clause named after its directory.
    const dir = name.split('/').slice(0, -1).pop();
    const pkg = dir ? dir.replace(/\W/g, '') || 'main' : 'main';
    const content = name.endsWith('.go') ? `package ${pkg}\n` : '';
    this.files.push({ name, state: this.opts.createState(content), issues: 0 });
    this.active = this.files.length - 1;
    this.opts.view.setState(this.files[this.active].state);
    this.opts.onChange();
  }

  private rename(index: number, name: string): void {
    this.files[index].name = name;
    this.opts.onChange();
  }

  private remove(index: number): void {
    if (this.files.length <= 1) return;
    const file = this.files[index];
    const hasContent = (index === this.active ? this.opts.view.state : file.state).doc.length > 0;
    if (hasContent && !confirm(`${file.name} を削除しますか？`)) return;
    this.sync();
    this.files.splice(index, 1);
    if (index < this.active) this.active--;
    this.active = Math.min(this.active, this.files.length - 1);
    this.opts.view.setState(this.files[this.active].state);
    this.render();
    this.opts.onChange();
  }

  private startEditing(index: number | null): void {
    this.editing = { index };
    this.render();
  }

  private nameInput(initial: string, index: number | null): HTMLInputElement {
    const input = document.createElement('input');
    input.className = 'tab-input';
    input.value = initial;
    input.setAttribute('aria-label', index === null ? '新しいファイルの名前' : 'ファイル名');
    input.spellcheck = false;
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      const name = input.value.trim();
      const others = this.files.filter((_, i) => i !== index).map((f) => f.name);
      if (commit) {
        const error = fileNameError(name, others);
        if (error && !(index !== null && name === this.files[index].name)) {
          input.setCustomValidity(error);
          input.reportValidity();
          return;
        }
      }
      done = true;
      this.editing = null;
      if (commit && index === null) this.add(name);
      else if (commit && index !== null && name !== this.files[index].name) this.rename(index, name);
      this.render();
      this.opts.view.focus();
    };
    input.addEventListener('input', () => input.setCustomValidity(''));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(input.value.trim() !== '' && input.value.trim() !== initial));
    queueMicrotask(() => {
      input.focus();
      const dot = input.value.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
    });
    return input;
  }

  render(): void {
    const c = this.opts.container;
    c.replaceChildren();
    this.files.forEach((f, i) => {
      if (this.editing?.index === i) {
        c.append(this.nameInput(f.name, i));
        return;
      }
      const tab = document.createElement('div');
      tab.className = 'tab' + (i === this.active ? ' active' : '');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tab-name';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(i === this.active));
      button.title = 'クリックで切り替え、ダブルクリックで名前を変更';
      button.textContent = f.name;
      button.addEventListener('click', () => this.activate(f.name));
      button.addEventListener('dblclick', () => this.startEditing(i));
      tab.append(button);
      if (f.issues) {
        const badge = document.createElement('span');
        badge.className = 'tab-issues';
        badge.textContent = String(f.issues);
        badge.title = `${f.issues} 件の指摘`;
        tab.append(badge);
      }
      if (this.files.length > 1) {
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'tab-close';
        close.textContent = '×';
        close.setAttribute('aria-label', `${f.name} を削除`);
        close.addEventListener('click', () => this.remove(i));
        tab.append(close);
      }
      c.append(tab);
    });
    if (this.editing?.index === null) {
      c.append(this.nameInput('', null));
    } else {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'tab-add';
      add.textContent = '+';
      add.title = 'ファイルを追加（go.mod も追加できます）';
      add.setAttribute('aria-label', 'ファイルを追加');
      add.addEventListener('click', () => this.startEditing(null));
      c.append(add);
    }
  }
}
