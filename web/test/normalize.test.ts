import { describe, expect, it } from 'vitest';
import { cleanLog, parseReport } from '../src/engine/normalize';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('parseReport', () => {
  it('returns null without a report', () => {
    expect(parseReport(null)).toBeNull();
  });

  it('normalizes issues and decodes suggested fixes', () => {
    const json = JSON.stringify({
      Issues: [
        {
          FromLinter: 'gofmt',
          Text: 'File is not properly formatted',
          Severity: '',
          SourceLines: ['package main'],
          Pos: { Filename: 'main.go', Offset: 0, Line: 1, Column: 1 },
          SuggestedFixes: [{ Message: '', TextEdits: [{ Pos: 0, End: 12, NewText: b64('package main\n\n// ä\n') }] }],
        },
      ],
      Report: {},
    });
    expect(parseReport(json)).toEqual([
      {
        linter: 'gofmt',
        message: 'File is not properly formatted',
        file: 'main.go',
        line: 1,
        column: 1,
        sourceLines: ['package main'],
        fixes: [{ message: '', edits: [{ start: 0, end: 12, newText: 'package main\n\n// ä\n' }] }],
      },
    ]);
  });

  it('extracts real positions of type errors', () => {
    const json = JSON.stringify({
      Issues: [
        {
          FromLinter: 'typecheck',
          Text: ': # playground\n./main.go:4:2: declared and not used: x\n./util.go:10:5: undefined: y',
          Pos: { Filename: 'main.go', Line: 1, Column: 0 },
        },
        {
          FromLinter: 'typecheck',
          Text: 'package github.com/pkg/errors is not in std',
          Pos: { Filename: 'main.go', Line: 5, Column: 2 },
        },
      ],
    });
    expect(parseReport(json)).toEqual([
      { linter: 'typecheck', file: 'main.go', line: 4, column: 2, message: 'declared and not used: x' },
      { linter: 'typecheck', file: 'util.go', line: 10, column: 5, message: 'undefined: y' },
      { linter: 'typecheck', file: 'main.go', line: 5, column: 2, message: 'package github.com/pkg/errors is not in std' },
    ]);
  });

  it('accepts reports without issues', () => {
    expect(parseReport('{"Issues":null,"Report":{}}')).toEqual([]);
  });
});

describe('cleanLog', () => {
  it('removes browser-specific noise', () => {
    const log = [
      'level=warning msg="Failed to discover go env: command \\"go env -json GOCACHE GOROOT\\": exec: \\"go\\": executable file not found in $PATH: "',
      'level=error msg="[formatter] gci: command \\"go env -json GOMOD\\": exec: \\"go\\": executable file not found in $PATH: "',
      'level=error msg="[pkgcache] cache close: Lock /cache/golangci-lint/trim.txt: operation not supported"',
      'level=warning msg="[linters_context] running gomoddirectives failed"',
    ].join('\n');
    expect(cleanLog(log)).toBe('level=warning msg="[linters_context] running gomoddirectives failed"');
  });
});
