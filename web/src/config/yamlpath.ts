// Locating things in .golangci.yml:
// - completionContext(): what is being typed at the cursor, from the text
//   around it (the document is usually incomplete YAML while typing);
// - pathAt() / rangeOf(): positions <-> paths, from the parsed document.

import { isMap, isPair, isScalar, isSeq, type Document, type Node, type Pair } from 'yaml';
import type { Path } from './schema';

export type CompletionKind =
  /** A key in a mapping (also an item of a sequence, which may be a scalar). */
  | 'key'
  /** The value after "key: ". */
  | 'value';

export interface CompletionContext {
  kind: CompletionKind;
  /** Path of the mapping (kind "key") or of the value (kind "value"). */
  path: Path;
  /** The word being typed and where it starts. */
  prefix: string;
  from: number;
  /** For kind "key": keys already present in the same mapping. */
  siblings: string[];
  /** The cursor is on a sequence item ("- ..." or inside "[...]"). */
  inSequence: boolean;
}

interface Line {
  text: string;
  /** Column of the first non-space character. */
  indent: number;
  /** Starts with "- ". */
  item: boolean;
  /** Column where the key (or item content) starts. */
  keyIndent: number;
  key?: string;
  /** "key:" with nothing (but maybe a comment) after the colon. */
  opensBlock: boolean;
  blank: boolean;
}

const KEY_RE = /^(-\s+)?([^\s:#'"][^:#]*?|"[^"]*"|'[^']*'):(\s+#.*|\s*)$/;
const KEY_VALUE_RE = /^(-\s+)?([^\s:#'"][^:#]*?|"[^"]*"|'[^']*'):\s/;

function unquote(s: string): string {
  return s.replace(/^(["'])(.*)\1$/, '$2');
}

function parseLine(text: string): Line {
  const indent = text.length - text.trimStart().length;
  const body = text.slice(indent);
  const blank = body === '' || body.startsWith('#');
  const item = /^-(\s|$)/.test(body);
  const keyIndent = item ? indent + (body.match(/^-\s*/)![0].length) : indent;
  const block = body.match(KEY_RE);
  const kv = block ? null : body.match(KEY_VALUE_RE);
  const key = block?.[2] ?? kv?.[2];
  return { text, indent, item, keyIndent, key: key ? unquote(key.trim()) : undefined, opensBlock: !!block, blank };
}

/**
 * Path of the mapping or sequence that contains an entry at `column` on line
 * `index` (an item when isItem). Lines above are scanned for the parent block.
 */
function parentPath(lines: Line[], index: number, column: number, isItem: boolean): Path {
  for (let i = index - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.blank) continue;
    // Sibling key inside the same sequence item: "- a: 1\n  b: 2".
    if (!isItem && l.item && l.keyIndent === column) return itemPath(lines, i);
    // Item of a sequence nested in a sequence item is not supported; stop at the item.
    if (l.indent < column || (isItem && l.indent <= column && l.opensBlock && !l.item)) {
      if (l.opensBlock && l.key !== undefined) {
        return l.item ? [...itemPath(lines, i), l.key] : [...parentPath(lines, i, l.indent, false), l.key];
      }
      if (l.item && l.keyIndent <= column) return itemPath(lines, i);
      if (l.indent < column) return parentPath(lines, i, l.indent, l.item);
    }
  }
  return [];
}

function itemPath(lines: Line[], index: number): Path {
  return [...parentPath(lines, index, lines[index].indent, true), 0];
}

export function completionContext(text: string, pos: number): CompletionContext | null {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  const before = text.slice(lineStart, pos);
  if (before.includes('#')) return null;
  const allLines = text.slice(0, lineStart).split('\n');
  allLines.pop(); // the (empty) remainder before the current line
  const lines = allLines.map(parseLine);
  const indent = before.length - before.trimStart().length;
  const body = before.slice(indent);
  const index = lines.length; // the current line

  // Value after "key: [a, b, pre" (flow sequence) or "key: pre".
  const kv = body.match(/^(-\s+)?([^\s:#'"][^:#]*?):\s+(.*)$/);
  if (kv) {
    const isItem = !!kv[1];
    const key = kv[2].trim();
    const column = indent + (kv[1]?.length ?? 0);
    const base = isItem ? [...parentPath(lines, index, indent, true), 0] : parentPath([...lines, parseLine(before)], index, column, false);
    const rest = kv[3];
    const flow = rest.match(/^\[(?:[^\]]*,)?\s*([^\s,\]]*)$/);
    if (flow) {
      return { kind: 'value', path: [...base, key, 0], prefix: flow[1], from: pos - flow[1].length, siblings: [], inSequence: true };
    }
    const word = rest.match(/^["']?([^\s"']*)$/);
    if (!word) return null;
    return { kind: 'value', path: [...base, key], prefix: word[1], from: pos - word[1].length, siblings: [], inSequence: false };
  }

  // A sequence item: "- pre".
  const item = body.match(/^-\s+([^\s:#]*)$/);
  if (item) {
    const path = [...parentPath(lines, index, indent, true), 0];
    return { kind: 'key', path, prefix: item[1], from: pos - item[1].length, siblings: [], inSequence: true };
  }

  // A key: "pre".
  const key = body.match(/^([^\s:#-][^\s:#]*|)$/);
  if (key) {
    const path = parentPath(lines, index, indent, false);
    // Siblings: keys at the same column in the same block (scan up and down).
    const siblings: string[] = [];
    const all = text.split('\n').map(parseLine);
    for (const dir of [-1, 1]) {
      for (let i = index + dir; i >= 0 && i < all.length; i += dir) {
        const l = all[i];
        if (l.blank) continue;
        if (l.indent < indent && !(l.item && l.keyIndent === indent)) break;
        if (l.keyIndent === indent && l.key !== undefined) siblings.push(l.key);
        if (l.item && l.keyIndent === indent) break;
      }
    }
    return { kind: 'key', path, prefix: key[1], from: pos - key[1].length, siblings, inSequence: false };
  }
  return null;
}

/** Finds the path of the key or value at pos in a parsed document. */
export function pathAt(doc: Document, pos: number): { path: Path; onKey: boolean; node: Node } | null {
  const visit = (node: unknown, path: Path): { path: Path; onKey: boolean; node: Node } | null => {
    if (isMap(node)) {
      for (const pair of node.items as Pair<Node, Node>[]) {
        const key = isScalar(pair.key) ? String(pair.key.value) : null;
        if (key === null) continue;
        const kr = pair.key?.range;
        if (kr && pos >= kr[0] && pos <= kr[1]) return { path: [...path, key], onKey: true, node: pair.key! };
        const vr = pair.value?.range;
        if (vr && pos >= vr[0] && pos <= vr[1]) return visit(pair.value, [...path, key]);
      }
    } else if (isSeq(node)) {
      for (let i = 0; i < node.items.length; i++) {
        const item = node.items[i] as Node;
        const r = item?.range;
        if (r && pos >= r[0] && pos <= r[1]) return visit(item, [...path, i]);
      }
    } else if (isScalar(node) && node.range && pos >= node.range[0] && pos <= node.range[1]) {
      return { path, onKey: false, node };
    }
    return null;
  };
  return visit(doc.contents, []);
}

/** Text range of the node at path (or of its key, when atKey). */
export function rangeOf(doc: Document, path: Path, atKey = false): [number, number] | null {
  let node: unknown = doc.contents;
  let keyNode: Node | null = null;
  for (const key of path) {
    keyNode = null;
    if (isMap(node) && typeof key === 'string') {
      const pair = node.items.find((p) => isPair(p) && isScalar(p.key) && String(p.key.value) === key);
      if (!pair) return null;
      keyNode = pair.key as Node;
      node = pair.value;
    } else if (isSeq(node) && typeof key === 'number') {
      node = node.items[key];
    } else {
      return null;
    }
  }
  const target = (atKey && keyNode) || (node as Node | null);
  if (target?.range) return [target.range[0], target.range[1]];
  // Empty values ("key:") have no range of their own: use the key.
  return keyNode?.range ? [keyNode.range[0], keyNode.range[1]] : null;
}
