// Editor assistance for .golangci.yml based on the JSON Schema of the selected
// golangci-lint version: completion, hover documentation and validation.
// Schema problems are warnings only; they never block a run.

import type { Completion, CompletionContext as CMCompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { linter, type Diagnostic } from '@codemirror/lint';
import { EditorState, type Extension } from '@codemirror/state';
import { hoverTooltip } from '@codemirror/view';
import { isMap, isScalar, isSeq, parseDocument, type Document, type Node } from 'yaml';
import { toolDescription, type Catalog } from './catalog';
import { SchemaTree, suggest, type JsonValue } from './schema';
import { completionContext, pathAt, rangeOf } from './yamlpath';

function yamlScalar(value: JsonValue): string {
  if (typeof value === 'string') {
    // Quote strings that YAML would read as something else.
    return /^[\w./@-]+$/.test(value) && !/^(true|false|null|~|[-+]?[\d.]+(e[-+]?\d+)?)$/i.test(value) ? value : JSON.stringify(value);
  }
  return String(value);
}

function info(text: string | undefined): Completion['info'] {
  return text ? () => Object.assign(document.createElement('div'), { className: 'cm-schema-info', textContent: text }) : undefined;
}

export function schemaCompletion(tree: SchemaTree, catalog: Catalog) {
  return (ctx: CMCompletionContext): CompletionResult | null => {
    const c = completionContext(ctx.state.doc.toString(), ctx.pos);
    if (!c) return null;
    // Do not pop up on every empty line; Ctrl+Space still works.
    if (!ctx.explicit && c.prefix === '' && c.kind === 'key' && !c.inSequence) return null;

    const options: Completion[] = [];
    const valueOptions = (path: typeof c.path) =>
      tree.values(path).map((v): Completion => {
        const tool = typeof v.value === 'string' ? toolDescription(catalog, v.value) : undefined;
        return {
          label: yamlScalar(v.value),
          type: typeof v.value === 'string' ? 'enum' : 'constant',
          detail: tool?.deprecated ? 'deprecated' : undefined,
          info: info(tool?.description ?? v.description),
          boost: tool?.deprecated ? -10 : 0,
        };
      });

    if (c.kind === 'value') {
      options.push(...valueOptions(c.path));
    } else {
      if (c.inSequence) options.push(...valueOptions(c.path));
      // Objects and arrays continue on the next line, one level deeper.
      const line = ctx.state.doc.lineAt(c.from);
      const indent = ' '.repeat(c.from - line.from + (c.inSequence ? 0 : 2));
      for (const k of tree.keys(c.path)) {
        if (c.siblings.includes(k.name)) continue;
        const path = [...c.path, k.name];
        const apply = tree.expectsArray(path)
          ? `${k.name}:\n${indent}- `
          : tree.expectsObject(path)
            ? `${k.name}:\n${indent}`
            : `${k.name}: `;
        options.push({ label: k.name, type: 'property', apply, info: info(k.description) });
      }
    }
    if (!options.length) return null;
    return { from: c.from, options, validFor: /^[\w./@"'-]*$/ };
  };
}

export function schemaHover(tree: SchemaTree, catalog: Catalog) {
  return hoverTooltip((view, pos) => {
    const doc = parseDocument(view.state.doc.toString());
    const hit = pathAt(doc, pos);
    if (!hit?.node.range) return null;
    let title = hit.path.join('.');
    let text: string | undefined;
    if (!hit.onKey && 'value' in hit.node && typeof hit.node.value === 'string') {
      const tool = toolDescription(catalog, hit.node.value);
      if (tool) {
        title = tool.name;
        text = tool.description + (tool.deprecated ? ' (deprecated)' : '');
      }
    }
    text ??= tree.description(hit.path);
    if (!text) return null;
    return {
      pos: hit.node.range[0],
      end: hit.node.range[1],
      above: true,
      create: () => {
        const dom = document.createElement('div');
        dom.className = 'cm-schema-hover';
        dom.append(Object.assign(document.createElement('strong'), { textContent: title }));
        dom.append(Object.assign(document.createElement('p'), { textContent: text }));
        return { dom };
      },
    };
  });
}

/**
 * Linter names that golangci-lint does not know. The schema accepts any string
 * there (for custom linters), but plugins cannot be loaded in the playground,
 * so an unknown name always fails the run: warn early, with a suggestion.
 */
export function unknownLinterDiagnostics(doc: Document, catalog: Catalog): Diagnostic[] {
  const names = catalog.linters.map((l) => l.name);
  const lists: Node[] = [];
  for (const key of ['enable', 'disable']) {
    const seq = doc.getIn(['linters', key], true);
    if (isSeq(seq)) lists.push(seq);
  }
  const rules = doc.getIn(['linters', 'exclusions', 'rules'], true);
  if (isSeq(rules)) {
    for (const rule of rules.items) {
      const seq = isMap(rule) ? rule.get('linters', true) : null;
      if (isSeq(seq)) lists.push(seq);
    }
  }
  const out: Diagnostic[] = [];
  for (const list of lists) {
    for (const item of (list as { items: unknown[] }).items) {
      if (!isScalar(item) || typeof item.value !== 'string' || !item.range || names.includes(item.value)) continue;
      const hint = suggest(item.value, names);
      out.push({
        from: item.range[0],
        to: item.range[1],
        severity: 'warning',
        source: 'playground',
        message: `Unknown linter: ${item.value}${hint ? `. Did you mean ${hint}?` : ''}`,
      });
    }
  }
  return out;
}

export function schemaDiagnostics(tree: SchemaTree, text: string, catalog?: Catalog): Diagnostic[] {
  if (!text.trim()) return [];
  const doc = parseDocument(text);
  if (doc.errors.length) return []; // reported by checkConfig
  const out: Diagnostic[] = catalog ? unknownLinterDiagnostics(doc, catalog) : [];
  for (const issue of tree.validate(doc.toJS() as JsonValue)) {
    // A missing or wrong "version" is already explained by checkConfig.
    if (issue.path.length === 0 && issue.message.includes('version')) continue;
    if (issue.path[0] === 'version' && issue.path.length === 1) continue;
    const r = rangeOf(doc, issue.path, issue.atKey);
    if (!r) continue;
    out.push({ from: r[0], to: Math.max(r[1], r[0] + 1), severity: 'warning', message: issue.message, source: 'schema' });
  }
  return out;
}

/** Extensions for the configuration editor, for one golangci-lint version. */
export function configAssist(catalog: Catalog): Extension {
  const tree = new SchemaTree(catalog.schema);
  // Created once: CodeMirror matches running completion queries to their source
  // by identity, so the language data must return the same function every time.
  const completion = schemaCompletion(tree, catalog);
  return [
    EditorState.languageData.of(() => [{ autocomplete: completion }]),
    schemaHover(tree, catalog),
    linter((view) => {
      const len = view.state.doc.length;
      return schemaDiagnostics(tree, view.state.doc.toString(), catalog).map((d) => ({ ...d, from: Math.min(d.from, len), to: Math.min(d.to, len) }));
    }, { delay: 400 }),
  ];
}
