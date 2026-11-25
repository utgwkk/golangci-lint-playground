// txtar (https://pkg.go.dev/golang.org/x/tools/txtar), as used by the Go Playground
// for multiple files in one editor:
//
//   -- go.mod --
//   module playground
//   -- main.go --
//   package main
//
// Text without any file header is a single main.go.

import type { Files } from './engine/protocol';

export interface TxtarFile {
  name: string;
  content: string;
  /** Offset of the content in the original text. */
  offset: number;
}

const HEADER = /^-- (.+?) --$/;

export function hasHeaders(text: string): boolean {
  return text.split('\n').some((line) => HEADER.test(line));
}

export function parseTxtar(text: string): TxtarFile[] {
  if (!hasHeaders(text)) return [{ name: 'main.go', content: text, offset: 0 }];
  const files: TxtarFile[] = [];
  let current: TxtarFile | null = null;
  let offset = 0;
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  for (const line of lines) {
    const m = line.match(HEADER);
    const next = offset + line.length + 1;
    if (m) {
      current = { name: m[1].trim(), content: '', offset: next };
      files.push(current);
    } else if (current) {
      current.content += line + '\n';
    }
    offset = next;
  }
  // The last line has no trailing newline unless the text ends with one.
  if (current && !text.endsWith('\n')) current.content = current.content.slice(0, -1);
  return files;
}

export function filesFromText(text: string): Files {
  return Object.fromEntries(parseTxtar(text).map((f) => [f.name, f.content]));
}
