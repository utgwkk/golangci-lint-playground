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

/** The text before the first file header (txtar's comment section). */
export function archiveComment(text: string): string {
  if (!hasHeaders(text)) return '';
  const lines = text.split('\n');
  const first = lines.findIndex((line) => HEADER.test(line));
  return lines.slice(0, first).join('\n');
}

/**
 * Formats files as txtar. A lone main.go is returned as plain text, which is
 * what the Go Playground does too (and what links shared from Phase 1 contain).
 */
export function formatTxtar(files: { name: string; content: string }[]): string {
  if (files.length === 1 && files[0].name === 'main.go' && !hasHeaders(files[0].content)) return files[0].content;
  return files.map((f) => `-- ${f.name} --\n${f.content.endsWith('\n') || f.content === '' ? f.content : f.content + '\n'}`).join('');
}
