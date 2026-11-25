export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

/** A single edit replacing the changed middle part of a text (common prefix and suffix are kept). */
export function diff(a: string, b: string): TextEdit[] {
  if (a === b) return [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return [{ from: start, to: endA, insert: b.slice(start, endB) }];
}
