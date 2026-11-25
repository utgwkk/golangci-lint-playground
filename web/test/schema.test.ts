import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { schemaDiagnostics } from '../src/config/assist';
import { SchemaTree, suggest, type JsonValue, type Schema } from '../src/config/schema';
import schema from './fixtures/schema.json';

const tree = new SchemaTree(schema as Schema);
const validate = (yaml: string) => tree.validate(parseDocument(yaml).toJS() as JsonValue);

describe('SchemaTree navigation', () => {
  it('follows nested $refs and lists keys and values', () => {
    expect(tree.keys(['linters']).map((k) => k.name)).toEqual(['default', 'enable', 'settings', 'exclusions']);
    expect(tree.keys(['linters', 'settings', 'govet'])).toEqual([
      { name: 'enable-all', description: 'Enable all analyzers.' },
      { name: 'enable', description: undefined },
    ]);
    expect(tree.values(['linters', 'enable', 0]).map((v) => v.value)).toEqual(['errcheck', 'govet', 'gocritic', 'staticcheck']);
    expect(tree.values(['linters', 'settings', 'govet', 'enable-all']).map((v) => v.value)).toEqual([true, false]);
    expect(tree.values(['severity', 'default']).map((v) => v.value)).toEqual(['error', 'warning']);
    expect(tree.description(['run', 'timeout'])).toBe('Timeout for total work.');
    expect(tree.keys(['linters', 'exclusions', 'rules', 0]).map((k) => k.name)).toEqual(['path', 'linters', 'text']);
    expect(tree.at(['severity', 'x-custom'])).toHaveLength(1);
    expect(tree.at(['nope'])).toEqual([]);
  });
});

describe('SchemaTree validation', () => {
  it('accepts valid configurations', () => {
    expect(
      validate(
        'version: "2"\nrun:\n  timeout: 5m\nlinters:\n  enable: [errcheck]\n  settings:\n    govet:\n      enable-all: true\n  exclusions:\n    rules:\n      - path: x\nseverity:\n  default: 3\n  x-a: b\n',
      ),
    ).toEqual([]);
  });

  it('reports unknown keys with suggestions', () => {
    expect(validate('version: "2"\nlinters:\n  enabel: [errcheck]\n')).toEqual([
      { path: ['linters', 'enabel'], atKey: true, message: '不明なキーです: enabel。もしかして: enable' },
    ]);
  });

  it('reports wrong values', () => {
    const issues = validate('version: "2"\nrun:\n  timeout: soon\n  concurrency: -1\nlinters:\n  default: everything\n  enable: [errchek, govet, govet]\n');
    expect(issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['run.timeout', '形式が正しくありません（パターン: ^\\d+[smh]$）'],
      ['run.concurrency', '0 以上の値にしてください'],
      ['linters.default', '使えない値です: "everything"（使える値: "standard", "all", "none", "fast"）'],
      ['linters.enable.0', '使えない値です: "errchek"。もしかして: errcheck'],
    ]);
    expect(validate('version: "2"\nlinters:\n  settings:\n    govet:\n      enable: [printf, printf]\n')[0].message).toBe('重複しています: "printf"');
  });

  it('checks types, required keys and anyOf', () => {
    expect(validate('run:\n  concurrency: many\n').map((i) => i.message)).toEqual([
      '必須のキーがありません: version',
      '型が違います（期待: integer、実際: string）',
    ]);
    expect(validate('version: "2"\nlinters:\n  exclusions:\n    rules:\n      - text: x\n')[0].message).toBe('必須のキーがありません: path');
  });

  it('suggests close words only', () => {
    expect(suggest('errchek', ['errcheck', 'govet'])).toBe('errcheck');
    expect(suggest('zzz', ['errcheck', 'govet'])).toBeNull();
  });
});

describe('schemaDiagnostics', () => {
  it('maps issues to the text, at the key for unknown keys', () => {
    const text = 'version: "2"\nlinters:\n  enabel: [errcheck]\n  enable:\n    - govet\n    - nope\n';
    const ds = schemaDiagnostics(tree, text);
    expect(ds.map((d) => [text.slice(d.from, d.to), d.severity])).toEqual([
      ['enabel', 'warning'],
      ['nope', 'warning'],
    ]);
  });

  it('leaves YAML syntax errors and the version to checkConfig', () => {
    expect(schemaDiagnostics(tree, 'linters: [\n')).toEqual([]);
    expect(schemaDiagnostics(tree, 'linters:\n  enable: [errcheck]\n')).toEqual([]);
  });
});

describe('SchemaTree value kinds', () => {
  it('tells objects and arrays apart', () => {
    expect(tree.expectsObject(['linters', 'settings'])).toBe(true);
    expect(tree.expectsArray(['linters', 'enable'])).toBe(true);
    expect(tree.expectsArray(['linters', 'settings'])).toBe(false);
    expect(tree.expectsObject(['run', 'timeout'])).toBe(false);
    expect(tree.expectsArray(['run', 'timeout'])).toBe(false);
  });
});

describe('unknown linter names', () => {
  const catalog = {
    schema: schema as Schema,
    linters: [{ name: 'errcheck', description: '' }, { name: 'govet', description: '' }],
    formatters: [],
  };

  it('warns about names golangci-lint does not know, with suggestions', () => {
    const text = 'version: "2"\nlinters:\n  enable: [errchek, govet]\n  disable:\n    - nosuch\n  exclusions:\n    rules:\n      - path: x\n        linters: [gvet]\n';
    const ds = schemaDiagnostics(new SchemaTree({}), text, catalog);
    expect(ds.map((d) => [text.slice(d.from, d.to), d.message])).toEqual([
      ['errchek', '不明なリンターです: errchek。もしかして: errcheck'],
      ['nosuch', '不明なリンターです: nosuch'],
      ['gvet', '不明なリンターです: gvet。もしかして: govet'],
    ]);
  });
});
