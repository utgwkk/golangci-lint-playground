import { describe, expect, it } from 'vitest';
import { byteColumnToIndex, issueRange } from '../src/ui/positions';

describe('positions', () => {
  it('converts UTF-8 byte columns to character indexes', () => {
    expect(byteColumnToIndex('abc', 1)).toBe(0);
    expect(byteColumnToIndex('abc', 3)).toBe(2);
    // "ä" is 2 bytes, "日" is 3 bytes, "😀" is 4 bytes and 2 UTF-16 units.
    expect(byteColumnToIndex('äx', 3)).toBe(1);
    expect(byteColumnToIndex('日x', 4)).toBe(1);
    expect(byteColumnToIndex('😀x', 5)).toBe(2);
  });

  it('maps issues to editor ranges, word by word', () => {
    const text = 'package main\n\nfunc main() {\n\tcount := 1\n}\n';
    const r = issueRange(text, { file: 'main.go', line: 4, column: 2 })!;
    expect(text.slice(r.from, r.to)).toBe('count');
    const whole = issueRange(text, { file: 'main.go', line: 4, column: 0 })!;
    expect(text.slice(whole.from, whole.to)).toBe('count := 1');
  });

  it('maps issues in txtar files', () => {
    const text = '-- go.mod --\nmodule x\n-- util.go --\npackage x\n\nvar unused = 1\n';
    const r = issueRange(text, { file: 'util.go', line: 3, column: 5 })!;
    expect(text.slice(r.from, r.to)).toBe('unused');
    expect(issueRange(text, { file: 'other.go', line: 1, column: 1 })).toBeNull();
  });
});
