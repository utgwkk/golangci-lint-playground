// Applying golangci-lint's suggested fixes. Their edits use UTF-8 byte offsets
// in the file content that was linted.

import type { Fix, TextEdit } from './engine/normalize';

/**
 * Applies edits (byte offsets) to content. Edits are applied from the end so
 * that earlier offsets stay valid; edits at the same position keep their order.
 */
export function applyByteEdits(content: string, edits: TextEdit[]): string {
  const bytes = new TextEncoder().encode(content);
  const ordered = edits.map((e, i) => ({ ...e, i })).sort((a, b) => b.start - a.start || b.end - a.end || b.i - a.i);
  let out = bytes;
  for (const e of ordered) {
    if (e.start < 0 || e.end < e.start || e.end > out.length) throw new Error(`invalid edit ${e.start}-${e.end}`);
    const insert = new TextEncoder().encode(e.newText);
    const next = new Uint8Array(out.length - (e.end - e.start) + insert.length);
    next.set(out.subarray(0, e.start), 0);
    next.set(insert, e.start);
    next.set(out.subarray(e.end), e.start + insert.length);
    out = next;
  }
  return new TextDecoder().decode(out);
}

export function applyFix(content: string, fix: Fix): string {
  return applyByteEdits(content, fix.edits);
}
