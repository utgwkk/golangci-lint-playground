// The Stats tab of the results: statistics of a verbose golangci-lint run
// (see engine/stats.ts). Everything is rendered as text and tables, so it is
// readable without the bars, which only visualize the numbers next to them.

import type { RunStats, Stage } from '../engine/stats';

/** What the processors of golangci-lint that can remove issues do. */
const PROCESSORS: Record<string, string> = {
  nolint_filter: '//nolint directives',
  exclusion_rules: 'linters.exclusions.rules and presets',
  exclusion_paths: 'linters.exclusions.paths',
  generated_file_filter: 'Generated files (linters.exclusions.generated)',
  uniq_by_line: 'One issue per line (issues.uniq-by-line)',
  max_same_issues: 'Same issue repeated (issues.max-same-issues)',
  max_from_linter: 'Issues per linter (issues.max-issues-per-linter)',
  max_per_file_from_linter: 'Issues per file of some formatters',
  diff: 'Only new issues (issues.new, new-from-*)',
  fixer: 'Fixed by --fix',
  invalid_issue: 'Invalid issues',
  cgo: 'cgo files',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A duration for people: "0.4 ms", "123 ms", "2.35 s". */
export function formatMs(ms: number): string {
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function tile(label: string, value: string | null, sub?: string): HTMLElement {
  const t = el('div', 'stat-tile');
  t.append(el('div', 'stat-label', label), el('div', 'stat-value', value ?? '—'));
  if (sub) t.append(el('div', 'stat-sub', sub));
  return t;
}

function section(title: string, ...children: Node[]): HTMLElement {
  const s = el('section', 'stats-section');
  s.append(el('h3', undefined, title), ...children);
  return s;
}

/** Ranked horizontal bars: one row per stage, slowest first, one color. */
function bars(stages: Stage[], label: string): HTMLTableElement {
  const max = Math.max(...stages.map((s) => s.ms), 1e-9);
  const table = el('table', 'stats-bars');
  table.setAttribute('aria-label', label);
  const body = el('tbody');
  for (const s of stages) {
    const row = el('tr');
    row.title = `${s.name}: ${formatMs(s.ms)}`;
    const bar = el('span', 'bar');
    bar.style.width = `${Math.max((s.ms / max) * 100, 0.5)}%`;
    const track = el('td', 'bar-cell');
    track.append(bar);
    row.append(el('th', 'bar-name', s.name), track, el('td', 'bar-value', formatMs(s.ms)));
    body.append(row);
  }
  table.append(body);
  return table;
}

function filtersTable(stats: RunStats): Node {
  const removed = stats.filters.filter((f) => f.after < f.before).sort((a, b) => b.before - a.before || a.name.localeCompare(b.name));
  if (!removed.length) return el('p', 'stats-note', 'No issue was filtered out.');
  const table = el('table', 'stats-table');
  const head = el('tr');
  head.append(el('th', undefined, 'Step'), el('th', 'num', 'Before'), el('th', 'num', 'After'), el('th', 'num', 'Removed'));
  const body = el('tbody');
  for (const f of removed) {
    const row = el('tr');
    const name = el('td');
    name.append(el('code', undefined, f.name));
    if (PROCESSORS[f.name]) name.append(el('span', 'stats-desc', PROCESSORS[f.name]));
    row.append(name, el('td', 'num', String(f.before)), el('td', 'num', String(f.after)), el('td', 'num', String(f.before - f.after)));
    body.append(row);
  }
  const thead = el('thead');
  thead.append(head);
  table.append(thead, body);
  return table;
}

/**
 * Renders the Stats tab. `stats` is undefined before any run with statistics,
 * and null when golangci-lint logged none (e.g. it failed before linting).
 */
export function renderStats(container: HTMLElement, stats: RunStats | null | undefined): void {
  container.replaceChildren();
  if (stats === undefined) {
    container.append(el('p', 'placeholder', 'Press Run to collect statistics (golangci-lint run --verbose).'));
    return;
  }
  if (stats === null) {
    container.append(el('p', 'placeholder', 'golangci-lint did not log any statistics for this run. See the golangci-lint log.'));
    return;
  }

  const tiles = el('div', 'stat-tiles');
  const active = stats.activeLinters.length;
  tiles.append(
    tile('Total', stats.totalMs === null ? null : formatMs(stats.totalMs)),
    tile('Loading packages', stats.loadingMs === null ? null : formatMs(stats.loadingMs)),
    tile('Running linters', stats.lintersMs === null ? null : formatMs(stats.lintersMs), active ? `${active} active ${active === 1 ? 'linter' : 'linters'}` : undefined),
    tile('Max memory', stats.memory ? `${stats.memory.maxMB.toFixed(1)} MB` : null, stats.memory ? `avg ${stats.memory.avgMB.toFixed(1)} MB` : undefined),
  );
  container.append(tiles);

  let analyzers: Node;
  if (stats.analyzersCached) {
    analyzers = el(
      'p',
      'stats-note',
      "No analyzer ran: the results were reused from golangci-lint's cache, because the code and configuration did not change since an earlier run. Change the code and run again to measure the analyzers.",
    );
  } else if (stats.analyzers.length) {
    const wrap = el('div');
    wrap.append(
      bars(stats.analyzers, 'Slowest analyzers'),
      el(
        'p',
        'stats-note',
        'golangci-lint logs only the 10 slowest go/analysis analyzers. Their times are summed over all analyzed packages and overlap, so together they can exceed the total. A linter can consist of several analyzers (govet, staticcheck), and some analyzers (such as buildir, inspect or ctrlflow) are shared helpers used by several linters.',
      ),
    );
    analyzers = wrap;
  } else {
    analyzers = el('p', 'stats-note', 'golangci-lint did not log analyzer timings.');
  }
  container.append(section('Slowest analyzers', analyzers));

  const counts =
    stats.issuesBefore !== null && stats.issuesAfter !== null
      ? `${stats.issuesBefore} reported by the linters, ${stats.issuesAfter} left after filtering.`
      : '';
  const filters = el('div');
  if (counts) filters.append(el('p', 'stats-note', counts));
  filters.append(filtersTable(stats));
  container.append(section('Filtered issues', filters));

  if (active) {
    const list = el('p', 'stats-note stats-linters');
    list.textContent = stats.activeLinters.join(', ');
    container.append(section(`Active linters (${active})`, list));
  }
}
