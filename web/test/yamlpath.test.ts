import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { completionContext, pathAt, rangeOf } from '../src/config/yamlpath';

// "|" marks the cursor.
function ctx(text: string) {
  const pos = text.indexOf('|');
  return completionContext(text.replace('|', ''), pos);
}

describe('completionContext', () => {
  it('finds top-level and nested keys', () => {
    expect(ctx('ver|')).toMatchObject({ kind: 'key', path: [], prefix: 'ver', inSequence: false });
    expect(ctx('linters:\n  en|')).toMatchObject({ kind: 'key', path: ['linters'], prefix: 'en' });
    expect(ctx('linters:\n  settings:\n    govet:\n      ena|')).toMatchObject({ path: ['linters', 'settings', 'govet'] });
  });

  it('collects sibling keys above and below', () => {
    expect(ctx('version: "2"\nlinters:\n  default: none\n  |\n  enable: []\nrun:\n  timeout: 1m\n')).toMatchObject({
      kind: 'key',
      path: ['linters'],
      siblings: ['default', 'enable'],
    });
  });

  it('finds values', () => {
    expect(ctx('linters:\n  default: st|')).toMatchObject({ kind: 'value', path: ['linters', 'default'], prefix: 'st' });
    expect(ctx('linters:\n  settings:\n    govet:\n      enable-all: |')).toMatchObject({
      kind: 'value',
      path: ['linters', 'settings', 'govet', 'enable-all'],
      prefix: '',
    });
  });

  it('finds sequence items in block and flow style', () => {
    expect(ctx('linters:\n  enable:\n    - errcheck\n    - go|')).toMatchObject({ kind: 'key', path: ['linters', 'enable', 0], prefix: 'go', inSequence: true });
    expect(ctx('linters:\n  enable:\n  - go|')).toMatchObject({ path: ['linters', 'enable', 0], inSequence: true });
    expect(ctx('linters:\n  enable: [errcheck, go|')).toMatchObject({ kind: 'value', path: ['linters', 'enable', 0], prefix: 'go', inSequence: true });
  });

  it('handles mappings inside sequence items', () => {
    const text = 'linters:\n  exclusions:\n    rules:\n      - path: x\n        lin|';
    expect(ctx(text)).toMatchObject({ kind: 'key', path: ['linters', 'exclusions', 'rules', 0], siblings: ['path'] });
    expect(ctx('linters:\n  exclusions:\n    rules:\n      - linters: [err|')).toMatchObject({
      kind: 'value',
      path: ['linters', 'exclusions', 'rules', 0, 'linters', 0],
    });
    expect(ctx('linters:\n  exclusions:\n    rules:\n      - pa|')).toMatchObject({ kind: 'key', path: ['linters', 'exclusions', 'rules', 0], inSequence: true });
  });

  it('ignores comments', () => {
    expect(ctx('# lin|')).toBeNull();
  });
});

describe('pathAt / rangeOf', () => {
  const text = 'version: "2"\nlinters:\n  enable:\n    - errcheck\n  settings:\n    govet: {}\n';
  const doc = parseDocument(text);

  it('finds keys and values under the cursor', () => {
    expect(pathAt(doc, text.indexOf('enable'))).toMatchObject({ path: ['linters', 'enable'], onKey: true });
    expect(pathAt(doc, text.indexOf('errcheck') + 2)).toMatchObject({ path: ['linters', 'enable', 0], onKey: false });
  });

  it('returns ranges of values and keys', () => {
    const r = rangeOf(doc, ['linters', 'enable', 0])!;
    expect(text.slice(r[0], r[1])).toBe('errcheck');
    const k = rangeOf(doc, ['linters', 'settings'], true)!;
    expect(text.slice(k[0], k[1])).toBe('settings');
    expect(rangeOf(doc, ['nope'])).toBeNull();
  });
});
