// Settings that do not work when golangci-lint runs in the browser, and their
// detection in the user's .golangci.yml. The YAML itself is never modified:
// these are shown as warnings in the editor.
//
// Verified with golangci-lint v2.5.0 (see docs/design.md, section 4.6).

import { isMap, isScalar, isSeq, parseDocument, type Document, type Node } from 'yaml';

export const UNSUPPORTED_LINTERS: Record<string, string> = {
  gomoddirectives: 'gomoddirectives は go コマンド（go list -m）を使うため、ブラウザでは動作しません（無視されます）。',
  gomodguard: 'gomodguard はモジュールの依存関係を検査します。playground は標準ライブラリのみ対応のため、何も検出しません。',
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
      message: 'golangci-lint v2 の設定には version: "2" が必要です（v1 形式の設定は v2 形式への移行が必要です）。',
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
        message: `次のリンターはブラウザでは動作しません: ${affected.join(', ')}（linters.disable に追加すると、この案内は消えます）`,
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
      message: 'カスタムリンター（プラグイン）は playground では読み込めません。',
    });
  }

  // gocritic's ruleguard needs rule files importing github.com/quasilyte/go-ruleguard/dsl.
  const ruleguard = keyRange(doc, ['linters', 'settings', 'gocritic', 'settings', 'ruleguard']);
  if (ruleguard) {
    out.push({
      from: ruleguard[0],
      to: ruleguard[1],
      severity: 'warning',
      message: 'gocritic の ruleguard は、ルールファイルが標準ライブラリ以外のパッケージを使うため動作しません。',
    });
  }
  return out;
}
