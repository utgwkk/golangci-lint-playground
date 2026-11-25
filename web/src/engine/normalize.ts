// Converts golangci-lint's JSON report into the playground's issue model.

export interface TextEdit {
  /** Byte offsets in the file (UTF-8). */
  start: number;
  end: number;
  newText: string;
}

export interface Fix {
  message: string;
  edits: TextEdit[];
}

export interface Issue {
  linter: string;
  message: string;
  severity?: string;
  /** Path relative to the workspace root, e.g. "main.go". */
  file: string;
  /** 1-based. */
  line: number;
  /** 1-based; 0 when golangci-lint reports no column. */
  column: number;
  sourceLines?: string[];
  fixes?: Fix[];
}

interface RawIssue {
  FromLinter: string;
  Text: string;
  Severity?: string;
  SourceLines?: string[];
  Pos: { Filename: string; Line: number; Column: number };
  SuggestedFixes?: { Message?: string; TextEdits?: { Pos: number; End: number; NewText?: string }[] }[];
}

// "./main.go:11:2: declared and not used: x" (one per line inside typecheck's Text).
const TYPECHECK_LINE = /^(?:: )?(?:# \S+\s*)?\.?\/?([^:\s]+\.go):(\d+):(\d+): (.*)$/;

function decodeBase64(s: string | undefined): string {
  if (!s) return '';
  const bin = atob(s);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Parses the JSON report. Returns null when the report is missing. */
export function parseReport(json: string | null): Issue[] | null {
  if (!json) return null;
  const report = JSON.parse(json) as { Issues?: RawIssue[] | null };
  const issues: Issue[] = [];
  for (const raw of report.Issues ?? []) {
    if (raw.FromLinter === 'typecheck') {
      const parsed = raw.Text.split('\n')
        .map((line) => line.match(TYPECHECK_LINE))
        .filter((m): m is RegExpMatchArray => !!m)
        .map((m) => ({ linter: 'typecheck', file: m[1], line: +m[2], column: +m[3], message: m[4] }));
      if (parsed.length) {
        issues.push(...parsed);
        continue;
      }
    }
    const issue: Issue = {
      linter: raw.FromLinter,
      message: raw.Text,
      file: raw.Pos.Filename,
      line: raw.Pos.Line,
      column: raw.Pos.Column,
    };
    if (raw.Severity) issue.severity = raw.Severity;
    if (raw.SourceLines?.length) issue.sourceLines = raw.SourceLines;
    if (raw.SuggestedFixes?.length) {
      issue.fixes = raw.SuggestedFixes.map((f) => ({
        message: f.Message ?? '',
        edits: (f.TextEdits ?? []).map((e) => ({ start: e.Pos, end: e.End, newText: decodeBase64(e.NewText) })),
      }));
    }
    issues.push(issue);
  }
  return issues;
}

// Log lines caused by running in the browser (no `go` command, no file locks).
// They do not affect results, so they are hidden from the log shown to users.
const BROWSER_NOISE = [
  /Failed to discover go env/,
  /\[gomod_salt\] Failed to calculate go\.mod salt/,
  /\[pkgcache\] cache close: Lock .*: operation not supported/,
  // Logged on every run, even when gci is not enabled. Enabling gci is flagged in the UI instead.
  // (golangci-lint logs in logfmt, so the quotes are escaped.)
  /\[formatter\] gci: command \\?"go env -json GOMOD/,
];

/** Removes browser-specific noise from golangci-lint's log output. */
export function cleanLog(log: string): string {
  return log
    .split('\n')
    .filter((line) => !BROWSER_NOISE.some((re) => re.test(line)))
    .join('\n')
    .trim();
}
