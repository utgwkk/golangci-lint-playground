// Minimal text edits to .golangci.yml: only the affected part of the text is
// changed, so comments, ordering, quoting and formatting elsewhere are kept.
// (Re-serializing the whole document with the yaml library could change them.)

import { isMap, isPair, isScalar, isSeq, parseDocument, type Document, type Node, type Pair, type YAMLMap, type YAMLSeq } from 'yaml';

export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

type Key = string;

function lineStart(text: string, pos: number): number {
  return text.lastIndexOf('\n', pos - 1) + 1;
}

function lineEnd(text: string, pos: number): number {
  const i = text.indexOf('\n', pos);
  return i < 0 ? text.length : i;
}

function column(text: string, pos: number): number {
  return pos - lineStart(text, pos);
}

function findPair(map: YAMLMap, key: Key): Pair<Node, Node> | undefined {
  return map.items.find((p) => isPair(p) && isScalar(p.key) && String(p.key.value) === key) as Pair<Node, Node> | undefined;
}

function nodeAt(doc: Document, path: Key[]): { pair?: Pair<Node, Node>; node: unknown } {
  let node: unknown = doc.contents;
  let pair: Pair<Node, Node> | undefined;
  for (const key of path) {
    if (!isMap(node)) return { node: undefined };
    pair = findPair(node, key);
    if (!pair) return { node: undefined };
    node = pair.value;
  }
  return { pair, node };
}

/** The indentation step used in the document (2 if it cannot be told). */
function indentUnit(text: string): number {
  const m = text.match(/^[^\s#][^\n]*:\s*(?:#[^\n]*)?\n(?:\s*(?:#[^\n]*)?\n)*( +)\S/m);
  return m ? m[1].length : 2;
}

function scalar(value: string): string {
  return /^[\w./@-]+$/.test(value) && !/^(true|false|null|~|yes|no|on|off|[-+]?[\d.]+)$/i.test(value) ? value : JSON.stringify(value);
}

/** End of the last line that belongs to a block node (its value, including nested lines). */
function blockEnd(text: string, node: Node): number {
  const end = node.range ? node.range[1] : 0;
  // range[1] may point past the trailing newline; go back to the end of the content line.
  let e = end;
  while (e > 0 && /\s/.test(text[e - 1])) e--;
  return lineEnd(text, e);
}

/**
 * Builds the text for a key that does not exist yet: `key: value` or, for a
 * sequence, `key:` followed by `- item` lines.
 */
function keyBlock(keys: Key[], leaf: { seq: string[] } | { value: string }, indent: number, unit: number): string {
  const pad = (n: number) => ' '.repeat(n);
  let out = '';
  keys.forEach((k, i) => {
    const isLast = i === keys.length - 1;
    out += `${pad(indent + i * unit)}${k}:`;
    if (!isLast) out += '\n';
    else if ('value' in leaf) out += ` ${leaf.value}`;
    else out += leaf.seq.map((v) => `\n${pad(indent + (i + 1) * unit)}- ${scalar(v)}`).join('');
  });
  return out;
}

/** Inserts the keys path[from..] under the deepest existing mapping of path. */
function insertMissing(text: string, doc: Document, path: Key[], leaf: { seq: string[] } | { value: string }): TextEdit {
  const unit = indentUnit(text);
  // Find the deepest existing block mapping along the path.
  let depth = 0;
  let map: YAMLMap | null = isMap(doc.contents) ? doc.contents : null;
  let mapIndent = 0;
  let pair: Pair<Node, Node> | undefined;
  while (map && depth < path.length) {
    const next = findPair(map, path[depth]);
    if (!next) break;
    pair = next;
    if (!isMap(next.value)) {
      depth++;
      break;
    }
    map = next.value;
    depth++;
  }
  if (map && depth < path.length && !findPair(map, path[depth])) {
    // Add the remaining keys as the last entry of `map`.
    const first = map.items[0] as Pair<Node, Node> | undefined;
    if (map.flow) throw new Error('flow mapping');
    if (first?.key?.range) {
      mapIndent = column(text, first.key.range[0]);
      const last = map.items[map.items.length - 1] as Pair<Node, Node>;
      const at = blockEnd(text, (last.value ?? last.key) as Node);
      return { from: at, to: at, insert: '\n' + keyBlock(path.slice(depth), leaf, mapIndent, unit) };
    }
  }
  if (pair && depth === path.length && (pair.value === null || (isScalar(pair.value) && pair.value.value === null))) {
    // "key:" without a value.
    const keyCol = column(text, pair.key!.range![0]);
    const at = lineEnd(text, pair.key!.range![1]);
    if ('value' in leaf) {
      const colon = text.indexOf(':', pair.key!.range![1]);
      return { from: colon + 1, to: at, insert: ` ${leaf.value}` };
    }
    return { from: at, to: at, insert: leaf.seq.map((v) => `\n${' '.repeat(keyCol + unit)}- ${scalar(v)}`).join('') };
  }
  if (!isMap(doc.contents) || (doc.contents.items.length === 0 && depth === 0)) {
    // Empty document (maybe only comments).
    const prefix = text === '' || text.endsWith('\n') ? '' : '\n';
    return { from: text.length, to: text.length, insert: prefix + keyBlock(path, leaf, 0, unit) + '\n' };
  }
  throw new Error('unsupported structure');
}

function itemText(text: string, item: Node): string {
  return item.range ? text.slice(item.range[0], item.range[1]).trim() : '';
}

/** Adds value to the sequence at path (creating it and its parents if needed). */
export function addToSequence(text: string, path: Key[], value: string): TextEdit[] {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new Error('invalid YAML');
  const { node } = nodeAt(doc, path);
  if (isSeq(node)) {
    const seq = node as YAMLSeq<Node>;
    if (seq.items.some((i) => isScalar(i) && String(i.value) === value)) return [];
    if (seq.flow) {
      const close = text.lastIndexOf(']', seq.range![1]);
      const hasItems = seq.items.length > 0;
      const before = text.slice(seq.range![0], close).trimEnd();
      const at = seq.range![0] + before.length;
      return [{ from: at, to: at, insert: (hasItems ? ', ' : '') + scalar(value) }];
    }
    const last = seq.items[seq.items.length - 1];
    const start = lineStart(text, last.range![0]);
    const dash = text.slice(start, last.range![0]).match(/^(\s*)-/);
    const indent = dash ? dash[1] : '';
    const at = blockEnd(text, last);
    return [{ from: at, to: at, insert: `\n${indent}- ${scalar(value)}` }];
  }
  if (node !== undefined && node !== null && !(isScalar(node) && node.value === null)) throw new Error('not a sequence');
  return [insertMissing(text, doc, path, { seq: [value] })];
}

/** Removes value from the sequence at path. An emptied sequence is removed with its key. */
export function removeFromSequence(text: string, path: Key[], value: string): TextEdit[] {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new Error('invalid YAML');
  const { pair, node } = nodeAt(doc, path);
  if (!isSeq(node) || !pair) return [];
  const seq = node as YAMLSeq<Node>;
  const index = seq.items.findIndex((i) => isScalar(i) && String(i.value) === value);
  if (index < 0) return [];
  const remaining = seq.items.filter((_, i) => i !== index);

  if (!remaining.length) {
    // Remove the whole "key: ..." entry, and parents that would become empty.
    let top = path.length;
    while (top > 1) {
      const parent = nodeAt(doc, path.slice(0, top - 1)).node;
      if (!isMap(parent) || parent.items.length !== 1) break;
      top--;
    }
    return removeKey(text, path.slice(0, top));
  }
  if (seq.flow) {
    return [{ from: seq.range![0], to: text.lastIndexOf(']', seq.range![1]) + 1, insert: `[${remaining.map((i) => itemText(text, i)).join(', ')}]` }];
  }
  const item = seq.items[index];
  const from = lineStart(text, item.range![0]);
  const end = blockEnd(text, item);
  return [{ from, to: Math.min(end + 1, text.length), insert: '' }];
}

/** Sets the scalar at path (creating the key and its parents if needed). */
export function setScalar(text: string, path: Key[], value: string): TextEdit[] {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new Error('invalid YAML');
  const { node } = nodeAt(doc, path);
  if (isScalar(node) && node.value !== null && node.range) {
    if (String(node.value) === value) return [];
    return [{ from: node.range[0], to: node.range[1], insert: scalar(value) }];
  }
  if (node !== undefined && node !== null && !(isScalar(node) && node.value === null)) throw new Error('not a scalar');
  return [insertMissing(text, doc, path, { value: scalar(value) })];
}

/** Removes "key: value" at path (no-op if missing). */
export function removeKey(text: string, path: Key[]): TextEdit[] {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new Error('invalid YAML');
  const { pair } = nodeAt(doc, path);
  if (!pair?.key?.range) return [];
  const from = lineStart(text, pair.key.range[0]);
  const end = blockEnd(text, (pair.value ?? pair.key) as Node);
  return [{ from, to: Math.min(end + 1, text.length), insert: '' }];
}

export function applyEdits(text: string, edits: TextEdit[]): string {
  return [...edits].sort((a, b) => b.from - a.from).reduce((t, e) => t.slice(0, e.from) + e.insert + t.slice(e.to), text);
}
