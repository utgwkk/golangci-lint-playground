import { describe, expect, it } from 'vitest';
import { parseDuration, parseStats } from '../src/engine/stats';

// Abridged log of `golangci-lint run --verbose` (v2.15.0, js/wasm).
const LOG = [
  'level=info msg="golangci-lint has version 2.15.0 built with go1.27.4"',
  'level=info msg="[config_reader] Module name \\"playground\\""',
  'level=info msg="[lintersdb] Active 3 linters: [errcheck govet misspell]"',
  'level=info msg="[loader] Go packages loading at mode 8767 (compiled_files|deps|files|imports|exports_file|name|types_sizes) took 14.092032ms"',
  'level=info msg="[linters_context/goanalysis] analyzers took 2.747639552s with top 10 stages: printf: 145.686528ms, misspell: 201.304576ms, errcheck: 131.298304ms"',
  'level=info msg="[runner] Issues before processing: 19, after processing: 7"',
  'level=info msg="[runner] Processors filtering stat (in/out): nolint_filter: 19/17, uniq_by_line: 17/7, sort_results: 7/7"',
  'level=info msg="[runner] processing took 2.198784ms with stages: nolint_filter: 490.496µs, source_code: 407.552µs"',
  'level=info msg="[runner] linters took 4.165821696s with stages: goanalysis_metalinter: 4.162885376s"',
  '3 issues:',
  '* errcheck: 1',
  'level=info msg="Memory: 43 samples, avg is 74.0MB, max is 104.1MB"',
  'level=info msg="Execution took 4.193947392s"',
].join('\n');

describe('parseDuration', () => {
  it('parses Go durations into milliseconds', () => {
    expect(parseDuration('2.5s')).toBe(2500);
    expect(parseDuration('14.092032ms')).toBeCloseTo(14.092032);
    expect(parseDuration('418.88µs')).toBeCloseTo(0.41888);
    expect(parseDuration('925ns')).toBeCloseTo(0.000925);
    expect(parseDuration('1m2.5s')).toBe(62_500);
    expect(parseDuration('1h0m0s')).toBe(3_600_000);
    expect(parseDuration('0s')).toBe(0);
    expect(parseDuration('0')).toBe(0);
  });

  it('rejects anything else', () => {
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('fast')).toBeNull();
    expect(parseDuration('2.5s!')).toBeNull();
  });
});

describe('parseStats', () => {
  it('reads timings, analyzers, filters and memory', () => {
    const s = parseStats(LOG)!;
    expect(s.totalMs).toBeCloseTo(4193.947392);
    expect(s.loadingMs).toBeCloseTo(14.092032);
    expect(s.lintersMs).toBeCloseTo(4165.821696);
    expect(s.linterStages.map((x) => x.name)).toEqual(['goanalysis_metalinter']);
    expect(s.analyzersMs).toBeCloseTo(2747.639552);
    // Slowest first.
    expect(s.analyzers.map((x) => x.name)).toEqual(['misspell', 'printf', 'errcheck']);
    expect(s.analyzersCached).toBe(false);
    expect(s.processingMs).toBeCloseTo(2.198784);
    expect([s.issuesBefore, s.issuesAfter]).toEqual([19, 7]);
    expect(s.filters).toEqual([
      { name: 'nolint_filter', before: 19, after: 17 },
      { name: 'uniq_by_line', before: 17, after: 7 },
      { name: 'sort_results', before: 7, after: 7 },
    ]);
    expect(s.memory).toEqual({ samples: 43, avgMB: 74, maxMB: 104.1 });
    expect(s.activeLinters).toEqual(['errcheck', 'govet', 'misspell']);
  });

  it('notices when the analysis results came from the cache', () => {
    const s = parseStats('level=info msg="[linters_context/goanalysis] analyzers took 0s with no stages"')!;
    expect(s.analyzersCached).toBe(true);
    expect(s.analyzers).toEqual([]);
    expect(s.analyzersMs).toBe(0);
  });

  it('returns null without verbose output', () => {
    expect(parseStats('')).toBeNull();
    expect(parseStats('level=warning msg="[runner] Can\'t run linter goanalysis_metalinter"\nsome output')).toBeNull();
  });
});
