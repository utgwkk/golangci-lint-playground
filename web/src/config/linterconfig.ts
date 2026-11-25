// Reads and changes which linters and formatters are enabled in .golangci.yml,
// following golangci-lint's rules:
//   enabled = (in linters.default's set && not in linters.disable) || in linters.enable
// Changes are minimal text edits (see yamledit.ts).

import { parseDocument } from 'yaml';
import type { ToolInfo } from './catalog';
import { addToSequence, removeFromSequence, setScalar, type TextEdit } from './yamledit';

export type LinterDefault = 'standard' | 'all' | 'fast' | 'none';
export const LINTER_DEFAULTS: LinterDefault[] = ['standard', 'all', 'fast', 'none'];

export interface ToolConfig {
  default: LinterDefault;
  enable: string[];
  disable: string[];
  formatters: string[];
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Returns null if the text is not valid YAML. */
export function readToolConfig(text: string): ToolConfig | null {
  const doc = parseDocument(text);
  if (doc.errors.length) return null;
  const js = (doc.toJS() ?? {}) as { linters?: Record<string, unknown>; formatters?: Record<string, unknown> };
  const def = js.linters?.default;
  return {
    default: LINTER_DEFAULTS.includes(def as LinterDefault) ? (def as LinterDefault) : 'standard',
    enable: strings(js.linters?.enable),
    disable: strings(js.linters?.disable),
    formatters: strings(js.formatters?.enable),
  };
}

export function inDefaultSet(linter: ToolInfo, def: LinterDefault): boolean {
  if (def === 'none') return false;
  return (linter.groups ?? []).includes(def);
}

export function isLinterEnabled(linter: ToolInfo, cfg: ToolConfig): boolean {
  if (cfg.enable.includes(linter.name)) return true;
  return inDefaultSet(linter, cfg.default) && !cfg.disable.includes(linter.name);
}

export function setLinterEnabled(text: string, linter: ToolInfo, on: boolean): TextEdit[] {
  const cfg = readToolConfig(text);
  if (!cfg) throw new Error('invalid YAML');
  const name = linter.name;
  const byDefault = inDefaultSet(linter, cfg.default);
  // Apply one edit at a time on the updated text, then return a single replacement.
  let next = text;
  const apply = (edits: TextEdit[]) => {
    next = [...edits].sort((a, b) => b.from - a.from).reduce((t, e) => t.slice(0, e.from) + e.insert + t.slice(e.to), next);
  };
  if (on) {
    if (cfg.disable.includes(name)) apply(removeFromSequence(next, ['linters', 'disable'], name));
    if (!byDefault) apply(addToSequence(next, ['linters', 'enable'], name));
  } else {
    if (cfg.enable.includes(name)) apply(removeFromSequence(next, ['linters', 'enable'], name));
    if (byDefault) apply(addToSequence(next, ['linters', 'disable'], name));
  }
  return diff(text, next);
}

export function setFormatterEnabled(text: string, name: string, on: boolean): TextEdit[] {
  return on ? addToSequence(text, ['formatters', 'enable'], name) : removeFromSequence(text, ['formatters', 'enable'], name);
}

export function setLinterDefault(text: string, value: LinterDefault): TextEdit[] {
  // "standard" is golangci-lint's default; still written explicitly so that the choice is visible.
  return setScalar(text, ['linters', 'default'], value);
}

/** A single edit replacing the changed middle part of the text. */
export function diff(a: string, b: string): TextEdit[] {
  if (a === b) return [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return [{ from: start, to: endA, insert: b.slice(start, endB) }];
}
