import { describe, expect, it } from 'vitest';
import { addToSequence, applyEdits, removeFromSequence, removeKey, setScalar } from '../src/config/yamledit';

const add = (text: string, path: string[], v: string) => applyEdits(text, addToSequence(text, path, v));
const remove = (text: string, path: string[], v: string) => applyEdits(text, removeFromSequence(text, path, v));
const set = (text: string, path: string[], v: string) => applyEdits(text, setScalar(text, path, v));

const CONFIG = `# My config
version: "2"

linters:
  # comment kept
  default: standard
  enable:
    - errcheck # why
    - govet
  settings:
    govet:
      enable-all: true

formatters:
  enable: [gofmt]   # flow style
`;

describe('addToSequence', () => {
  it('appends to block sequences, keeping everything else', () => {
    expect(add(CONFIG, ['linters', 'enable'], 'gocritic')).toBe(CONFIG.replace('    - govet\n', '    - govet\n    - gocritic\n'));
  });

  it('appends to flow sequences', () => {
    expect(add(CONFIG, ['formatters', 'enable'], 'gofumpt')).toBe(CONFIG.replace('[gofmt]', '[gofmt, gofumpt]'));
    expect(add('linters:\n  enable: []\n', ['linters', 'enable'], 'govet')).toBe('linters:\n  enable: [govet]\n');
  });

  it('does nothing when the value is present', () => {
    expect(addToSequence(CONFIG, ['linters', 'enable'], 'govet')).toEqual([]);
  });

  it('creates missing keys under the deepest existing mapping', () => {
    expect(add(CONFIG, ['linters', 'disable'], 'unused')).toBe(
      CONFIG.replace('      enable-all: true\n', '      enable-all: true\n  disable:\n    - unused\n'),
    );
    expect(add('version: "2"\n', ['linters', 'enable'], 'govet')).toBe('version: "2"\nlinters:\n  enable:\n    - govet\n');
    expect(add('version: "2"\nlinters:\n    default: none\n', ['linters', 'enable'], 'govet')).toBe(
      'version: "2"\nlinters:\n    default: none\n    enable:\n        - govet\n',
    );
  });

  it('fills keys without a value and empty documents', () => {
    expect(add('linters:\n  enable:\n', ['linters', 'enable'], 'govet')).toBe('linters:\n  enable:\n    - govet\n');
    expect(add('', ['linters', 'enable'], 'govet')).toBe('linters:\n  enable:\n    - govet\n');
    expect(add('# only a comment', ['formatters', 'enable'], 'gofmt')).toBe('# only a comment\nformatters:\n  enable:\n    - gofmt\n');
  });

  it('handles sequences indented at the key level', () => {
    expect(add('linters:\n  enable:\n  - errcheck\n', ['linters', 'enable'], 'govet')).toBe('linters:\n  enable:\n  - errcheck\n  - govet\n');
  });
});

describe('removeFromSequence', () => {
  it('removes an item line, keeping comments of other lines', () => {
    expect(remove(CONFIG, ['linters', 'enable'], 'govet')).toBe(CONFIG.replace('    - govet\n', ''));
    expect(remove(CONFIG, ['linters', 'enable'], 'errcheck')).toBe(CONFIG.replace('    - errcheck # why\n', ''));
  });

  it('removes the key when the sequence becomes empty', () => {
    // "formatters" would become empty, so it is removed too.
    expect(remove(CONFIG, ['formatters', 'enable'], 'gofmt')).toBe(CONFIG.replace('formatters:\n  enable: [gofmt]   # flow style\n', ''));
    const once = remove(CONFIG, ['linters', 'enable'], 'govet');
    expect(remove(once, ['linters', 'enable'], 'errcheck')).toBe(CONFIG.replace('  enable:\n    - errcheck # why\n    - govet\n', ''));
  });

  it('rewrites flow sequences', () => {
    expect(remove('a:\n  b: [x, "y", z]\n', ['a', 'b'], 'y')).toBe('a:\n  b: [x, z]\n');
  });

  it('does nothing when absent', () => {
    expect(removeFromSequence(CONFIG, ['linters', 'enable'], 'nope')).toEqual([]);
    expect(removeFromSequence(CONFIG, ['linters', 'disable'], 'nope')).toEqual([]);
  });
});

describe('setScalar / removeKey', () => {
  it('replaces existing values only', () => {
    expect(set(CONFIG, ['linters', 'default'], 'all')).toBe(CONFIG.replace('default: standard', 'default: all'));
    expect(setScalar(CONFIG, ['linters', 'default'], 'standard')).toEqual([]);
  });

  it('creates missing keys and quotes when needed', () => {
    expect(set('linters:\n  enable: [govet]\n', ['linters', 'default'], 'none')).toBe('linters:\n  enable: [govet]\n  default: none\n');
    expect(set('linters:\n  default:\n', ['linters', 'default'], 'all')).toBe('linters:\n  default: all\n');
    expect(set('', ['version'], '2')).toBe('version: "2"\n');
  });

  it('removes keys with their nested lines', () => {
    expect(applyEdits(CONFIG, removeKey(CONFIG, ['linters', 'settings']))).toBe(CONFIG.replace('  settings:\n    govet:\n      enable-all: true\n', ''));
  });
});
