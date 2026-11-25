// Renders lint results as a list. Every value is inserted as text (never as HTML).

import type { Issue } from '../engine/normalize';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function sortIssues(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
}

export function renderIssues(container: HTMLElement, issues: Issue[], onSelect: (issue: Issue) => void): void {
  container.replaceChildren();
  if (!issues.length) {
    container.append(el('p', 'clean', '指摘はありません'));
    return;
  }
  const list = el('ul', 'issues');
  for (const issue of sortIssues(issues)) {
    const item = el('li');
    const button = el('button', 'issue');
    button.type = 'button';
    button.dataset.linter = issue.linter;
    const pos = issue.column > 0 ? `${issue.file}:${issue.line}:${issue.column}` : `${issue.file}:${issue.line}`;
    button.append(
      el('span', `badge${issue.linter === 'typecheck' ? ' error' : ''}`, issue.linter),
      el('span', 'message', issue.message),
      el('span', 'pos', pos),
    );
    button.addEventListener('click', () => onSelect(issue));
    item.append(button);
    list.append(item);
  }
  container.append(list);
}

export function renderMessage(container: HTMLElement, message: string, kind: 'error' | 'placeholder' = 'placeholder'): void {
  container.replaceChildren(el('p', kind, message));
}
