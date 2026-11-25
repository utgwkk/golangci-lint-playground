import { describe, expect, it } from 'vitest';
import { applyByteEdits } from '../src/fixes';

// Taken from golangci-lint v2.15.0 (js/wasm) on this file: the edits of each
// suggested fix, and the file after `--fix`. The Japanese comment is deliberate:
// multibyte text before the edits, which use byte offsets.
const SOURCE =
  'package main\n\nimport "fmt"\n\n// 日本語のコメント\nfunc main() {\n\tfor i := 0; i < 3; i++ {\n\t\tfmt.Println(i)\n\t}\n\tfmt.Println("occured")\n\tm := 10\n\tif m > 5 {\n\t\tm = 5\n\t}\n\tfmt.Println(m)\n}\n';
const MISSPELL = [{ start: 130, end: 137, newText: 'occurred' }];
const RANGEINT = [
  { start: 80, end: 87, newText: 'range ' },
  { start: 87, end: 87, newText: '' },
  { start: 88, end: 93, newText: '' },
  { start: 88, end: 88, newText: '' },
];
const MINMAX = [{ start: 141, end: 171, newText: 'm := min(10, 5)' }];
const FIXED =
  'package main\n\nimport "fmt"\n\n// 日本語のコメント\nfunc main() {\n\tfor i := range 3 {\n\t\tfmt.Println(i)\n\t}\n\tfmt.Println("occurred")\n\tm := min(10, 5)\n\tfmt.Println(m)\n}\n';

describe('applyByteEdits', () => {
  it('uses UTF-8 byte offsets', () => {
    expect(applyByteEdits(SOURCE, MISSPELL)).toContain('fmt.Println("occurred")');
    expect(applyByteEdits('é x', [{ start: 3, end: 4, newText: 'y' }])).toBe('é y');
  });

  it('applies several edits, including empty ones at the same position', () => {
    expect(applyByteEdits(SOURCE, RANGEINT)).toContain('\tfor i := range 3 {\n');
  });

  it('gives the same result as golangci-lint --fix when all fixes are combined', () => {
    expect(applyByteEdits(SOURCE, [...MISSPELL, ...RANGEINT, ...MINMAX])).toBe(FIXED);
  });

  it('rejects edits outside the content', () => {
    expect(() => applyByteEdits('abc', [{ start: 2, end: 10, newText: '' }])).toThrow();
  });
});
