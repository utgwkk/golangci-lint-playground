// Dialog for choosing linters and formatters. The YAML stays the source of
// truth: the dialog reads the current configuration and every change is a
// minimal edit of the configuration text (see config/linterconfig.ts).

import type { Catalog, ToolInfo } from '../config/catalog';
import {
  isLinterEnabled,
  LINTER_DEFAULTS,
  readToolConfig,
  setFormatterEnabled,
  setLinterDefault,
  setLinterEnabled,
  type LinterDefault,
  type ToolConfig,
} from '../config/linterconfig';
import { UNSUPPORTED_LINTERS } from '../config/unsupported';
import type { TextEdit } from '../config/yamledit';

export interface ToolsPanelOptions {
  dialog: HTMLDialogElement;
  getText: () => string;
  apply: (edits: TextEdit[]) => void;
}

const DEFAULT_LABELS: Record<LinterDefault, string> = {
  standard: 'standard (golangci-lint default)',
  all: 'all',
  fast: 'fast (fast linters only)',
  none: 'none (only those in enable)',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...children);
  return e;
}

export class ToolsPanel {
  private catalog: Catalog | null = null;
  private query = '';
  private onlyEnabled = false;
  private readonly body: HTMLElement;

  constructor(private readonly opts: ToolsPanelOptions) {
    const d = opts.dialog;
    d.replaceChildren();
    const close = el('button', { type: 'button', className: 'dialog-close', textContent: '×' });
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => d.close());
    this.body = el('div', { className: 'tools-body' });
    d.append(el('div', { className: 'dialog-header' }, el('h2', { textContent: 'Linters and formatters' }), close), this.body);
    d.addEventListener('click', (e) => {
      if (e.target === d) d.close(); // click on the backdrop
    });
  }

  setCatalog(catalog: Catalog | null): void {
    this.catalog = catalog;
    if (this.opts.dialog.open) this.render();
  }

  open(): void {
    this.render();
    this.opts.dialog.showModal();
    this.body.querySelector<HTMLInputElement>('input[type=search]')?.focus();
  }

  private edit(make: (text: string) => TextEdit[]): void {
    try {
      this.opts.apply(make(this.opts.getText()));
    } catch (err) {
      alert(`Could not change the configuration: ${(err as Error).message}`);
    }
    this.render();
  }

  private row(tool: ToolInfo, enabled: boolean, kind: 'linter' | 'formatter', cfg: ToolConfig): HTMLElement {
    const checkbox = el('input', { type: 'checkbox', checked: enabled });
    checkbox.setAttribute('aria-label', tool.name);
    checkbox.addEventListener('change', () =>
      this.edit((text) => (kind === 'linter' ? setLinterEnabled(text, tool, checkbox.checked) : setFormatterEnabled(text, tool.name, checkbox.checked))),
    );
    const name = tool.originalURL
      ? el('a', { href: tool.originalURL, target: '_blank', rel: 'noopener noreferrer', textContent: tool.name })
      : el('span', { textContent: tool.name });
    const badges = el('span', { className: 'badges' });
    const badge = (text: string, cls = '', title = '') => badges.append(el('span', { className: `tool-badge ${cls}`, textContent: text, title }));
    if (kind === 'linter') {
      if (tool.groups?.includes('standard')) badge('standard', '', 'Included in linters.default: standard');
      if (tool.fast) badge('fast', '', 'Included in linters.default: fast');
      if (cfg.enable.includes(tool.name)) badge('enable', 'set', 'Listed in linters.enable');
      if (cfg.disable.includes(tool.name)) badge('disable', 'set', 'Listed in linters.disable');
    }
    if (tool.autoFix) badge('autofix', '', 'Supports auto-fix');
    if (tool.deprecated) badge('deprecated', 'warn', 'Deprecated');
    if (UNSUPPORTED_LINTERS[tool.name]) badge('unsupported in browser', 'warn', UNSUPPORTED_LINTERS[tool.name]);
    return el(
      'li',
      { className: 'tool' + (enabled ? ' enabled' : '') },
      el('label', {}, checkbox, el('span', { className: 'tool-main' }, el('span', { className: 'tool-name' }, name, badges), el('span', { className: 'tool-desc', textContent: tool.description }))),
    );
  }

  private section(title: string, tools: ToolInfo[], isEnabled: (t: ToolInfo) => boolean, kind: 'linter' | 'formatter', cfg: ToolConfig): HTMLElement {
    const q = this.query.toLowerCase();
    const shown = tools
      .filter((t) => !q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))
      .filter((t) => !this.onlyEnabled || isEnabled(t));
    const enabled = tools.filter(isEnabled).length;
    const list = el('ul', { className: 'tools' }, ...shown.map((t) => this.row(t, isEnabled(t), kind, cfg)));
    if (!shown.length) list.append(el('li', { className: 'tool-empty', textContent: 'No matches' }));
    return el('section', {}, el('h3', { textContent: `${title} (${enabled} of ${tools.length} enabled)` }), list);
  }

  private render(): void {
    const b = this.body;
    b.replaceChildren();
    if (!this.catalog) {
      b.append(el('p', { textContent: 'Loading golangci-lint…' }));
      return;
    }
    const cfg = readToolConfig(this.opts.getText());
    if (!cfg) {
      b.append(el('p', { className: 'error', textContent: '.golangci.yml has a YAML syntax error. Fix it, then open this dialog again.' }));
      return;
    }

    const def = el('select', {}, ...LINTER_DEFAULTS.map((v) => new Option(DEFAULT_LABELS[v], v, false, v === cfg.default)));
    def.setAttribute('aria-label', 'linters.default');
    def.addEventListener('change', () => this.edit((text) => setLinterDefault(text, def.value as LinterDefault)));

    const search = el('input', { type: 'search', placeholder: 'Filter by name or description', value: this.query });
    search.setAttribute('aria-label', 'Filter');
    search.addEventListener('input', () => {
      this.query = search.value;
      this.renderLists(cfg);
    });
    const only = el('input', { type: 'checkbox', checked: this.onlyEnabled });
    only.addEventListener('change', () => {
      this.onlyEnabled = only.checked;
      this.renderLists(cfg);
    });

    b.append(
      el('p', { className: 'tools-note', textContent: 'Changes rewrite only the affected part of .golangci.yml (comments and ordering are kept).' }),
      el('div', { className: 'tools-controls' },
        el('label', {}, 'linters.default ', def),
        search,
        el('label', { className: 'only-enabled' }, only, ' Enabled only'),
      ),
      el('div', { className: 'tools-lists' }),
    );
    this.renderLists(cfg);
  }

  private renderLists(cfg: ToolConfig): void {
    const lists = this.body.querySelector('.tools-lists');
    if (!lists || !this.catalog) return;
    lists.replaceChildren(
      this.section('Formatters', this.catalog.formatters, (t) => cfg.formatters.includes(t.name), 'formatter', cfg),
      this.section('Linters', this.catalog.linters, (t) => isLinterEnabled(t, cfg), 'linter', cfg),
    );
  }
}
