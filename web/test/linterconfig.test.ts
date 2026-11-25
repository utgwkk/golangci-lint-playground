import { describe, expect, it } from 'vitest';
import type { ToolInfo } from '../src/config/catalog';
import { isLinterEnabled, readToolConfig, setFormatterEnabled, setLinterDefault, setLinterEnabled } from '../src/config/linterconfig';
import { applyEdits } from '../src/config/yamledit';

const errcheck: ToolInfo = { name: 'errcheck', description: '', groups: ['all', 'standard'] };
const gocritic: ToolInfo = { name: 'gocritic', description: '', groups: ['all'] };
const misspell: ToolInfo = { name: 'misspell', description: '', groups: ['all', 'fast'] };

const toggle = (text: string, l: ToolInfo, on: boolean) => applyEdits(text, setLinterEnabled(text, l, on));

describe('linter config', () => {
  it('computes enabled linters like golangci-lint', () => {
    const cfg = readToolConfig('version: "2"\nlinters:\n  enable: [gocritic]\n  disable: [errcheck]\n')!;
    expect(isLinterEnabled(errcheck, cfg)).toBe(false);
    expect(isLinterEnabled(gocritic, cfg)).toBe(true);
    expect(isLinterEnabled(misspell, cfg)).toBe(false);
    expect(isLinterEnabled(misspell, readToolConfig('linters:\n  default: fast\n')!)).toBe(true);
    expect(isLinterEnabled(errcheck, readToolConfig('')!)).toBe(true); // default: standard
    expect(readToolConfig('linters: [')).toBeNull();
  });

  it('enables and disables linters with minimal edits', () => {
    const base = 'version: "2"\n# keep me\nlinters:\n  enable:\n    - gocritic\n';
    expect(toggle(base, errcheck, false)).toBe(base + '  disable:\n    - errcheck\n');
    expect(toggle(base + '  disable:\n    - errcheck\n', errcheck, true)).toBe(base);
    expect(toggle(base, gocritic, false)).toBe('version: "2"\n# keep me\n');
    expect(toggle(base, misspell, true)).toBe(base + '    - misspell\n');
  });

  it('changes the default and formatters', () => {
    const base = 'version: "2"\n';
    expect(applyEdits(base, setLinterDefault(base, 'none'))).toBe('version: "2"\nlinters:\n  default: none\n');
    const withFmt = applyEdits(base, setFormatterEnabled(base, 'gofumpt', true));
    expect(withFmt).toBe('version: "2"\nformatters:\n  enable:\n    - gofumpt\n');
    expect(applyEdits(withFmt, setFormatterEnabled(withFmt, 'gofumpt', false))).toBe(base);
  });
});
