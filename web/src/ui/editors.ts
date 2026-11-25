// CodeMirror 6 editors for Go code and .golangci.yml.

import { indentWithTab } from '@codemirror/commands';
import { go } from '@codemirror/lang-go';
import { yaml } from '@codemirror/lang-yaml';
import { HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint';
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { basicSetup } from 'codemirror';
import { configAssist } from '../config/assist';
import type { Catalog } from '../config/catalog';
import { checkConfig } from '../config/unsupported';

// Colors come from CSS variables so that light and dark themes both work.
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.character], color: 'var(--syn-string)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--syn-number)' },
  { tag: [t.typeName, t.className, t.standard(t.typeName)], color: 'var(--syn-type)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--syn-func)' },
  { tag: [t.propertyName, t.definition(t.propertyName), t.labelName], color: 'var(--syn-property)' },
  { tag: [t.operator, t.punctuation], color: 'var(--syn-operator)' },
  { tag: t.invalid, color: 'var(--danger)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--editor-bg)', color: 'var(--fg)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.55', fontSize: '13px' },
  '.cm-content': { caretColor: 'var(--fg)' },
  '.cm-gutters': { backgroundColor: 'var(--editor-bg)', color: 'var(--muted)', borderRight: '1px solid var(--border)' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--active-line)' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--fg)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection) !important' },
  '.cm-tooltip': { backgroundColor: 'var(--panel)', color: 'var(--fg)', border: '1px solid var(--border)' },
  '.cm-diagnostic': { fontFamily: 'var(--sans)', whiteSpace: 'pre-wrap' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent-soft)', color: 'var(--fg)' },
  '.cm-completionInfo': { maxWidth: '360px' },
  '.cm-schema-info, .cm-schema-hover': { fontFamily: 'var(--sans)', fontSize: '12px', lineHeight: '1.5', whiteSpace: 'pre-wrap' },
  '.cm-schema-hover': { maxWidth: '420px', padding: '6px 8px' },
  '.cm-schema-hover strong': { fontFamily: 'var(--mono)' },
  '.cm-schema-hover p': { margin: '4px 0 0' },
  '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--fg)' },
});

function common(onRun: () => void, extraKeys: { key: string; run: () => void }[] = []): Extension[] {
  return [
    basicSetup,
    syntaxHighlighting(highlight),
    theme,
    lintGutter(),
    keymap.of([indentWithTab]),
    Prec.highest(
      keymap.of([
        {
          key: 'Mod-Enter',
          run: () => {
            onRun();
            return true;
          },
        },
        ...extraKeys.map(({ key, run }) => ({
          key,
          run: () => {
            run();
            return true;
          },
        })),
      ]),
    ),
  ];
}

/**
 * The Go editor. Each file has its own EditorState (made by createState with
 * the same extensions); the view shows the active file.
 */
export function createGoEditor(
  parent: HTMLElement,
  onRun: () => void,
  onChange: () => void,
  onFormat: () => void,
): { view: EditorView; createState: (doc: string) => EditorState } {
  const extensions = [
    // Shift+Alt+F formats, as in VS Code.
    common(onRun, [{ key: 'Shift-Alt-f', run: onFormat }]),
    go(),
    indentUnit.of('\t'),
    EditorState.tabSize.of(4),
    EditorView.contentAttributes.of({ 'aria-label': 'Go code' }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) onChange();
    }),
  ];
  const createState = (doc: string) => EditorState.create({ doc, extensions });
  return { view: new EditorView({ parent, state: createState('') }), createState };
}

// Schema-based completion, hover and validation; replaced when the version changes.
const assist = new Compartment();

export function setConfigCatalog(view: EditorView, catalog: Catalog | null): void {
  view.dispatch({ effects: assist.reconfigure(catalog ? configAssist(catalog) : []) });
}

export function createConfigEditor(parent: HTMLElement, doc: string, onRun: () => void, onChange: () => void): EditorView {
  const configLinter = linter(
    (view): Diagnostic[] => {
      const len = view.state.doc.length;
      return checkConfig(view.state.doc.toString()).map((d) => ({
        from: Math.min(d.from, len),
        to: Math.min(Math.max(d.to, d.from), len),
        severity: d.severity,
        message: d.message,
        source: 'playground',
      }));
    },
    { delay: 300 },
  );
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        common(onRun),
        yaml(),
        indentUnit.of('  '),
        configLinter,
        assist.of([]),
        EditorView.contentAttributes.of({ 'aria-label': '.golangci.yml' }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChange();
        }),
      ],
    }),
  });
}

export function setText(view: EditorView, text: string): void {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}
