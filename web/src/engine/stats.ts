// Statistics of a golangci-lint run, parsed from the log of `run --verbose`.
//
// golangci-lint has no machine-readable timing output; with --verbose it logs
// lines such as
//
//   level=info msg="[loader] Go packages loading at mode 8767 (...) took 14.09ms"
//   level=info msg="[linters_context/goanalysis] analyzers took 2.74s with top 10 stages: misspell: 201.3ms, ..."
//   level=info msg="[runner] Processors filtering stat (in/out): nolint_filter: 19/17, ..."
//   level=info msg="Memory: 43 samples, avg is 74.0MB, max is 104.1MB"
//   level=info msg="Execution took 4.19s"
//
// Only the 10 slowest analyzers are logged (fixed in golangci-lint), and none
// when the analysis results come from golangci-lint's cache.

export interface Stage {
  name: string;
  ms: number;
}

export interface FilterStat {
  /** Name of the processor (e.g. nolint_filter). */
  name: string;
  before: number;
  after: number;
}

export interface RunStats {
  totalMs: number | null;
  loadingMs: number | null;
  lintersMs: number | null;
  /** Time per linter runner (all go/analysis linters run as goanalysis_metalinter). */
  linterStages: Stage[];
  analyzersMs: number | null;
  /** The slowest analyzers, slowest first (at most 10 per analysis run). */
  analyzers: Stage[];
  /** No analyzer ran: the results came from golangci-lint's cache. */
  analyzersCached: boolean;
  processingMs: number | null;
  /** Issues reported by the linters, and left after all processors (exclusions, nolint, limits...). */
  issuesBefore: number | null;
  issuesAfter: number | null;
  /** Issues before and after each processor, in the logged order. */
  filters: FilterStat[];
  memory: { samples: number; avgMB: number; maxMB: number } | null;
  activeLinters: string[];
}

/** Parses a Go duration (e.g. "1m2.5s", "418.88µs") into milliseconds. */
export function parseDuration(s: string): number | null {
  const units: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000, ms: 1, us: 1e-3, µs: 1e-3, μs: 1e-3, ns: 1e-6 };
  if (s === '0') return 0;
  const re = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|s|m|h)/gy;
  let total = 0;
  let end = 0;
  for (const m of s.matchAll(re)) {
    total += parseFloat(m[1]) * units[m[2]];
    end = m.index + m[0].length;
  }
  return end === s.length && end > 0 ? total : null;
}

/** Parses "name: 1.2s, other: 3ms" (the stage lists of golangci-lint's stopwatch). */
function parseStages(list: string): Stage[] {
  const out: Stage[] = [];
  for (const part of list.split(', ')) {
    const i = part.lastIndexOf(': ');
    const ms = i > 0 ? parseDuration(part.slice(i + 2)) : null;
    if (ms !== null) out.push({ name: part.slice(0, i), ms });
  }
  return out;
}

/** The messages of logrus text lines (`level=info msg="..."`). */
function messages(log: string): string[] {
  const out: string[] = [];
  for (const line of log.split('\n')) {
    const m = /^level=\w+ msg="((?:[^"\\]|\\.)*)"/.exec(line);
    if (m) out.push(m[1].replace(/\\(.)/g, '$1'));
  }
  return out;
}

/** Statistics from the log of `golangci-lint run --verbose`, or null if the log has none. */
export function parseStats(log: string): RunStats | null {
  const stats: RunStats = {
    totalMs: null,
    loadingMs: null,
    lintersMs: null,
    linterStages: [],
    analyzersMs: null,
    analyzers: [],
    analyzersCached: false,
    processingMs: null,
    issuesBefore: null,
    issuesAfter: null,
    filters: [],
    memory: null,
    activeLinters: [],
  };
  let found = false;
  let analysisRuns = 0;
  let cachedRuns = 0;
  for (const msg of messages(log)) {
    let m: RegExpExecArray | null;
    if ((m = /^Execution took (\S+)$/.exec(msg))) {
      stats.totalMs = parseDuration(m[1]);
    } else if ((m = /^\[loader\] Go packages loading .* took (\S+)$/.exec(msg))) {
      stats.loadingMs = parseDuration(m[1]);
    } else if ((m = /^\[runner\] linters took (\S+) with stages: (.*)$/.exec(msg))) {
      stats.lintersMs = parseDuration(m[1]);
      stats.linterStages = parseStages(m[2]);
    } else if ((m = /^\[[^\]]*goanalysis\] analyzers took (\S+) with (?:top \d+ stages: (.*)|no stages)$/.exec(msg))) {
      // One line per analysis run (normally a single one: goanalysis_metalinter).
      analysisRuns++;
      stats.analyzersMs = (stats.analyzersMs ?? 0) + (parseDuration(m[1]) ?? 0);
      if (m[2] === undefined) cachedRuns++;
      else stats.analyzers.push(...parseStages(m[2]));
    } else if ((m = /^\[runner\] processing took (\S+)/.exec(msg))) {
      stats.processingMs = parseDuration(m[1]);
    } else if ((m = /^\[runner\] Issues before processing: (\d+), after processing: (\d+)$/.exec(msg))) {
      stats.issuesBefore = Number(m[1]);
      stats.issuesAfter = Number(m[2]);
    } else if ((m = /^\[runner\] Processors filtering stat \(in\/out\): (.*)$/.exec(msg))) {
      for (const part of m[1].split(', ')) {
        const f = /^(.+): (\d+)\/(\d+)$/.exec(part);
        if (f) stats.filters.push({ name: f[1], before: Number(f[2]), after: Number(f[3]) });
      }
    } else if ((m = /^Memory: (\d+) samples, avg is ([\d.]+)MB, max is ([\d.]+)MB$/.exec(msg))) {
      stats.memory = { samples: Number(m[1]), avgMB: Number(m[2]), maxMB: Number(m[3]) };
    } else if ((m = /^\[lintersdb\] Active \d+ linters: \[(.*)\]$/.exec(msg))) {
      stats.activeLinters = m[1].split(' ').filter(Boolean);
    } else {
      continue;
    }
    found = true;
  }
  stats.analyzers.sort((a, b) => b.ms - a.ms);
  stats.analyzersCached = analysisRuns > 0 && cachedRuns === analysisRuns;
  return found ? stats : null;
}
