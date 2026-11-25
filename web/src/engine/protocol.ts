// Messages exchanged between the UI (main thread) and the engine worker.
import type { Issue } from './normalize';

export type Files = Record<string, string>;

export type ToWorker =
  | {
      type: 'init';
      module: WebAssembly.Module;
      wasmExecUrl: string;
      std: Uint8Array;
      cache: Uint8Array | null;
      goVersion: string;
    }
  | { type: 'lint'; id: number; files: Files }
  | { type: 'format'; id: number; files: Files }
  | { type: 'fix'; id: number; files: Files };

export interface LintResult {
  /** null when golangci-lint did not produce a report (e.g. invalid configuration). */
  issues: Issue[] | null;
  /** stdout + stderr of golangci-lint, without browser-specific noise. */
  log: string;
  exitCode: number;
  ms: number;
}

export interface FormatResult {
  /** The files after formatting (all files that were sent). */
  files: Files;
  /** stdout + stderr of golangci-lint, without browser-specific noise. */
  log: string;
  exitCode: number;
  ms: number;
}

export interface FixResult extends LintResult {
  /** The files after applying the fixes (all files that were sent, except .golangci.yml). */
  files: Files;
}

export type FromWorker =
  | { type: 'ready'; files: number }
  | ({ type: 'result'; id: number } & LintResult)
  | ({ type: 'formatted'; id: number } & FormatResult)
  | ({ type: 'fixed'; id: number } & FixResult)
  | { type: 'error'; id?: number; message: string };
