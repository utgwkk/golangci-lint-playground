// Maps golangci-lint positions (file, 1-based line, 1-based byte column) to
// offsets in the editor document, which may contain several txtar files.

import type { Issue } from '../engine/normalize';
import { parseTxtar } from '../txtar';

export interface Range {
  from: number;
  to: number;
}

/** Converts a 1-based UTF-8 byte column to a 0-based character index in line. */
export function byteColumnToIndex(line: string, column: number): number {
  if (column <= 1) return 0;
  const target = column - 1;
  let bytes = 0;
  let i = 0;
  while (i < line.length && bytes < target) {
    const cp = line.codePointAt(i)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    i += cp > 0xffff ? 2 : 1;
  }
  return i;
}

/** Returns the range of an issue in a txtar text, or null if its file is not in it. */
export function issueRange(text: string, issue: Pick<Issue, 'file' | 'line' | 'column'>): Range | null {
  const file = parseTxtar(text).find((f) => f.name === issue.file);
  if (!file) return null;
  const r = fileRange(file.content, issue);
  return { from: file.offset + r.from, to: file.offset + r.to };
}

/** Returns the range of a position (1-based line, 1-based byte column) in a file's content. */
export function fileRange(content: string, issue: Pick<Issue, 'line' | 'column'>): Range {
  const lines = content.split('\n');
  const lineIndex = Math.min(Math.max(issue.line, 1), lines.length) - 1;
  let lineStart = 0;
  for (let i = 0; i < lineIndex; i++) lineStart += lines[i].length + 1;
  const line = lines[lineIndex];
  if (issue.column <= 0) {
    // No column: highlight the whole line (excluding indentation).
    const indent = line.length - line.trimStart().length;
    return { from: lineStart + indent, to: lineStart + Math.max(line.length, indent + 1) };
  }
  const start = Math.min(byteColumnToIndex(line, issue.column), line.length);
  const word = line.slice(start).match(/^[\p{L}\p{N}_]+/u);
  const len = word ? word[0].length : 1;
  return { from: lineStart + start, to: lineStart + Math.min(start + len, Math.max(line.length, start + 1)) };
}
