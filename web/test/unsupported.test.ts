import { describe, expect, it } from 'vitest';
import { checkConfig } from '../src/config/unsupported';

const at = (text: string, d: { from: number; to: number }) => text.slice(d.from, d.to);

describe('checkConfig', () => {
  it('accepts empty and supported configurations', () => {
    expect(checkConfig('')).toEqual([]);
    expect(checkConfig('version: "2"\nlinters:\n  enable: [gocritic, gosec]\nformatters:\n  enable: [goimports]\n')).toEqual([]);
  });

  it('flags unsupported linters at their position', () => {
    const text = 'version: "2"\nlinters:\n  enable:\n    - errcheck\n    - gomoddirectives\n';
    const [d] = checkConfig(text);
    expect(d.severity).toBe('warning');
    expect(at(text, d)).toBe('gomoddirectives');
  });

  it('explains which linters do not work with default: all', () => {
    const text = 'version: "2"\nlinters:\n  default: all\n  disable: [gomodguard, gomodguard_v2]\n';
    const [d] = checkConfig(text);
    expect(d.severity).toBe('info');
    expect(d.message).toContain('gomoddirectives');
    expect(d.message).not.toContain('gomodguard');
    expect(checkConfig('version: "2"\nlinters:\n  default: all\n  disable: [gomodguard, gomodguard_v2, gomoddirectives]\n')).toEqual([]);
  });

  it('flags plugins, ruleguard, v1 configurations and YAML errors', () => {
    const plugins = 'version: "2"\nlinters:\n  settings:\n    custom:\n      foo: {}\n';
    expect(at(plugins, checkConfig(plugins)[0])).toBe('custom');
    const ruleguard = 'version: "2"\nlinters:\n  settings:\n    gocritic:\n      settings:\n        ruleguard:\n          rules: r.go\n';
    expect(at(ruleguard, checkConfig(ruleguard)[0])).toBe('ruleguard');
    expect(checkConfig('linters:\n  enable: [errcheck]\n')[0].message).toContain('version: "2"');
    expect(checkConfig('linters: [\n')[0].severity).toBe('error');
  });
});
