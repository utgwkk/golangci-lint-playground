import { describe, expect, it } from 'vitest';
import { filesFromText, parseTxtar } from '../src/txtar';

describe('txtar', () => {
  it('treats text without headers as main.go', () => {
    expect(parseTxtar('package main\n')).toEqual([{ name: 'main.go', content: 'package main\n', offset: 0 }]);
  });

  it('splits files and records content offsets', () => {
    const text = 'comment\n-- go.mod --\nmodule x\n-- a/b.go --\npackage b\n\nvar X = 1\n';
    const files = parseTxtar(text);
    expect(files).toEqual([
      { name: 'go.mod', content: 'module x\n', offset: 21 },
      { name: 'a/b.go', content: 'package b\n\nvar X = 1\n', offset: 43 },
    ]);
    for (const f of files) expect(text.slice(f.offset, f.offset + f.content.length)).toBe(f.content);
  });

  it('keeps a missing trailing newline', () => {
    expect(filesFromText('-- a.go --\npackage a')).toEqual({ 'a.go': 'package a' });
    expect(filesFromText('-- a.go --\npackage a\n\n')).toEqual({ 'a.go': 'package a\n\n' });
  });
});
