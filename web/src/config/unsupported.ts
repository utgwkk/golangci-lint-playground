// Settings that do not work when golangci-lint runs in the browser, and their
// detection in the user's .golangci.yml. The YAML itself is never modified:
// these are shown as warnings in the editor.
//
// Verified with golangci-lint v2.5.0 and v2.15.0 (see docs/design.md, section 4.6).

import { isMap, isScalar, isSeq, parseDocument, type Document, type Node } from 'yaml';

export const UNSUPPORTED_LINTERS: Record<string, string> = {
  gomoddirectives: 'gomoddirectives runs the go command (go list -m), which is not available in the browser, so it is skipped.',
  gomodguard: 'gomodguard checks module dependencies. The playground supports the standard library only, so it never reports anything.',
  gomodguard_v2: 'gomodguard_v2 checks module dependencies. The playground supports the standard library only, so it never reports anything.',
};

export interface ConfigDiagnostic {
  from: number;
  to: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

function range(node: Node | null | undefined, fallback: [number, number]): [number, number] {
  return node?.range ? [node.range[0], node.range[1]] : fallback;
}

function keyRange(doc: Document, path: string[]): [number, number] | null {
  let node: unknown = doc.contents;
  let found: [number, number] | null = null;
  for (const key of path) {
    if (!isMap(node)) return null;
    const pair = node.items.find((p) => isScalar(p.key) && p.key.value === key);
    if (!pair) return null;
    found = range(pair.key as Node, [0, 0]);
    node = pair.value;
  }
  return found;
}

/** Analyzes the configuration and returns warnings about unsupported features and YAML errors. */
export function checkConfig(text: string): ConfigDiagnostic[] {
  const out: ConfigDiagnostic[] = [];
  if (!text.trim()) return out;
  const doc = parseDocument(text, { keepSourceTokens: false });

  for (const err of doc.errors) {
    out.push({ from: err.pos[0], to: Math.max(err.pos[1], err.pos[0] + 1), severity: 'error', message: err.message });
  }
  if (doc.errors.length) return out;

  const version = doc.get('version');
  if (String(version) !== '2') {
    const firstLineEnd = text.indexOf('\n') < 0 ? text.length : text.indexOf('\n');
    const r = keyRange(doc, ['version']) ?? [0, Math.max(firstLineEnd, 1)];
    out.push({
      from: r[0],
      to: r[1],
      severity: 'warning',
      message: 'golangci-lint v2 configurations need version: "2" (v1 configurations must be migrated to v2).',
    });
  }

  // linters.enable: [...]
  const enable = doc.getIn(['linters', 'enable'], true);
  if (isSeq(enable)) {
    for (const item of enable.items) {
      if (isScalar(item) && typeof item.value === 'string' && UNSUPPORTED_LINTERS[item.value]) {
        const [from, to] = range(item, [0, 0]);
        out.push({ from, to, severity: 'warning', message: UNSUPPORTED_LINTERS[item.value] });
      }
    }
  }

  // linters.default: all enables gomoddirectives too.
  const def = doc.getIn(['linters', 'default'], true);
  if (isScalar(def) && def.value === 'all') {
    const disabled = doc.getIn(['linters', 'disable']);
    const disabledNames = isSeq(disabled) ? disabled.items.map((i) => (isScalar(i) ? i.value : null)) : [];
    const affected = Object.keys(UNSUPPORTED_LINTERS).filter((l) => !disabledNames.includes(l));
    if (affected.length) {
      const [from, to] = range(def, [0, 0]);
      out.push({
        from,
        to,
        severity: 'info',
        message: `These linters do not work in the browser: ${affected.join(', ')} (add them to linters.disable to hide this note)`,
      });
    }
  }

  // Custom linters (plugins) cannot be loaded.
  const custom = keyRange(doc, ['linters', 'settings', 'custom']);
  if (custom) {
    out.push({
      from: custom[0],
      to: custom[1],
      severity: 'warning',
      message: 'Custom linters (plugins) cannot be loaded in the playground.',
    });
  }

  // gocritic's ruleguard needs rule files importing github.com/quasilyte/go-ruleguard/dsl.
  const ruleguard = keyRange(doc, ['linters', 'settings', 'gocritic', 'settings', 'ruleguard']);
  if (ruleguard) {
    out.push({
      from: ruleguard[0],
      to: ruleguard[1],
      severity: 'warning',
      message: "gocritic's ruleguard does not work in the playground: rule files import a package outside the standard library.",
    });
  }
  return out;
}
