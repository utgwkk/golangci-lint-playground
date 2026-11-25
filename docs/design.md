# golangci-lint playground design document

> A Japanese version is in [design.ja.md](design.ja.md). Update both in the same change.

## 1. Overview

A web application where, like the [Go Playground](https://go.dev/play/), you write Go code in the browser and see the results of [golangci-lint](https://golangci-lint.run/) right away.

golangci-lint is built for WebAssembly (js/wasm) and **runs entirely inside the browser**. No server is used to lint the code, so the site can be published with static hosting alone, and the user's code is never sent anywhere.

### 1.1 Goals

- Run golangci-lint on Go code in the browser alone, and show the results inline in the editor
- Let users **write golangci-lint's configuration file (`.golangci.yml`) freely in YAML**, and use what they write as is (see [1.4](#14-requirement-free-form-configuration-file-yaml))
- Also offer a GUI for common settings such as the enabled linters
- Share the state, including the code, the configuration and the version, by URL
- Let users choose among several golangci-lint versions
- Run with static hosting only, without servers that execute code

### 1.2 Non-goals (not for now)

- **Running** Go code (that is the Go Playground's job)
- Loading golangci-lint custom plugins (Module Plugin / Go Plugin)
- Analyzing code that uses cgo
- Analyzing code that depends on third-party modules (only the standard library is supported; see [1.5](#15-scope-decisions))
- Testing and supporting browsers other than Google Chrome (desktop) ([1.5](#15-scope-decisions))
- Reducing the download size ([1.5](#15-scope-decisions))
- User accounts and saved history

### 1.3 Use cases

- Quickly checking how a linter behaves and what it reports ("Does `gocritic` complain about this?")
- Sharing reproductions by URL in golangci-lint issues, PRs and blog posts
- Experimenting with settings (`linters.settings.*`)
- Comparing behavior between versions
- Pasting a project's `.golangci.yml` as is to reproduce and share its behavior

### 1.4 Requirement: free-form configuration file (YAML)

Users can write golangci-lint's configuration file freely in YAML. The playground does not restrict itself to "settings the GUI can choose": every setting golangci-lint accepts can be used as is.

- **The YAML is never rewritten**: the YAML the user writes is passed to golangci-lint as `.golangci.yml`, character for character. What the playground needs to control (where the JSON result is written, disabling the parallel-run lock) is set with **command-line flags**, not in the configuration file. Flags take precedence over the configuration file, so `output.*` settings written by the user do not affect how the results are collected ([4.2](#42-lint-engine-web-worker), verified in the PoC)
- **The YAML editor is the main tool**: the YAML text is the source of truth of the configuration panel. The GUI (choosing linters and so on) is a helper for editing the YAML, and GUI operations rewrite only the affected part of the YAML (comments, key order and settings the GUI does not handle are kept)
- **Unsupported features are made visible**: when the configuration uses settings that do not work in the browser (linters that run the `go` command, custom plugins and so on; see [4.6](#46-features-that-do-not-work-in-the-browser)), the YAML editor shows a warning marker on the line. The configuration is not rewritten and running is not blocked
- **Errors are shown as they are**: YAML syntax errors and configuration errors from golangci-lint are shown in the results panel as they are, and those with a line number are also marked in the editor
- **Easy to paste**: the goal is that pasting a whole `.golangci.yml` from a project just works. When a v1 configuration (one without `version: "2"`) is pasted, the playground offers to convert it to v2 with `golangci-lint migrate` (run in the browser)
- **Included in sharing**: the free-form YAML, comments included, is stored in the share URL as is, and opening the share URL restores exactly the same text

### 1.5 Scope decisions

The following was decided on 2026-11-25, to keep the implementation and maintenance burden low and ship something usable first.

| Item | Decision | Reason | What users see |
| --- | --- | --- | --- |
| Third-party modules | **Not supported**. Only the standard library and packages of the same module can be imported | golangci-lint reads dependencies from export data, and producing export data in the browser needs the compiler. Patching golangci-lint, a proxy for fetching modules or a server would all be a large burden | Importing anything outside the standard library shows an error on that import line ("package ... is not in std (only the standard library is available in the playground)"; see [4.6](#46-features-that-do-not-work-in-the-browser)) |
| Supported browsers | **Working in Google Chrome (desktop) is enough**. Other browsers (including mobile) are not tested or supported | The PoC was verified in Chromium. This avoids the cost of investigating browser differences in WebAssembly memory usage (300–550 MB) and speed | Browsers other than Chrome show the notice "This playground is tested with Google Chrome. It may not work correctly in other browsers." Running is not blocked |
| Go and golangci-lint versions | **Use the latest stable Go (go1.27.4) and the latest golangci-lint that supports it (v2.15.0)** | So that users can try new language features and standard library APIs. Official golangci-lint releases are sometimes built with an older Go, but the parity tests check that the results match the native build (built with the same Go) | The version selector in the toolbar shows e.g. `v2.15.0 (go1.27.4)` |
| Download size | **Not reduced**. The first visit downloads about 24 MB (gzipped) | Reductions (brotli on a CDN, `wasm-opt`, lazy loading of the standard library, etc.) cost a lot of work for their effect | The download progress is shown. Later visits load from the service worker's cache |

## 2. Verified facts

Facts verified with the native golangci-lint (v2.5.0 and v2.15.0), the js/wasm PoC ([Appendix A](#appendix-a-poc-results-of-the-webassembly-approach)) and the Phase 1 implementation.

| Item | Behavior | Impact on the design |
| --- | --- | --- |
| js/wasm build | With `GOOS=js GOARCH=wasm`, golangci-lint builds without modification (`wasip1` fails because dependencies do not support it) | The target is `js/wasm`, with Go's official `wasm_exec.js` |
| Package loading | `go/packages` runs `go list` as a child process, but js/wasm cannot create processes | A small patch to `golang.org/x/tools` replaces it with a driver that loads packages in-process (golangci-lint itself is not modified) |
| Type information of dependencies | golangci-lint reads dependencies from export data (type information written by the compiler) | The standard library's export data is generated at build time and shipped |
| File operations | In the browser, `wasm_exec.js` leaves file operations unimplemented | A Node-compatible `fs` API is implemented in memory and installed as `globalThis.fs` |
| Analysis cache | The first run without a cache takes about 22 seconds. The analysis cache of the whole standard library is 0.3 MB gzipped, and it is valid as is when generated with the same paths as in the browser | The cache is generated at build time and shipped |
| JSON output | `--output.json.path <path>` writes `{"Issues": [...], "Report": {...}}`. The flag takes precedence over `output.*` in the configuration file | The JSON is written to an in-memory file (e.g. `/tmp/report.json`) and read back. The user's YAML is not rewritten |
| Shape of an issue | `FromLinter`, `Text`, `Severity`, `SourceLines`, `Pos{Filename,Offset,Line,Column}`, and for auto-fixable ones `SuggestedFixes[].TextEdits[]{Pos,End,NewText}` (`NewText` is base64) | Usable directly for editor markers and quick fixes |
| Type errors | Reported as `FromLinter: "typecheck"` with `Pos` fixed at `Line:1, Column:0`; the real position is embedded in `Text` as `./main.go:11:2: ...` | `Text` is parsed with a regular expression to correct the position (implemented in the PoC) |
| Exit code | 1 when there are issues. In the browser it is often 7 (errors were logged), because failures such as starting the `go` command are logged | The exit code is not relied on; the JSON is authoritative |
| Linter list | `golangci-lint help linters --json` gives `name, description, groups, fast, autoFix, deprecated, since, originalURL` | Written out per version at build time and used by the linter dialog |
| JSON Schema of the configuration | golangci-lint's module ships `jsonschema/golangci.jsonschema.json` (`config verify` fetches it over the network, so it is not used) | Extracted from the module at build time and shipped |
| Formatters | v2 has a separate `formatters` section. `golangci-lint fmt` formats files | The Format feature uses the `fmt` subcommand. `gci`, however, does not work in the browser |
| Dependence on the `go` command | x/tools' `imports` package (used by `goimports`, `gci` and `swaggo`) tries to run `go env`, fails, and **stops the whole run**. `gomoddirectives` cannot run `go list -m` and is ignored | A second x/tools patch returns the values from environment variables instead of running `go env` (`goimports`, `gci` and `swaggo` now work). The rest is unsupported and the UI warns about it ([4.6](#46-features-that-do-not-work-in-the-browser)) |
| Go version | The Go used to build golangci-lint and the Go of the shipped standard library must match | Each version is built as a fixed pair of "golangci-lint + Go toolchain" |
| Combining Go and golangci-lint | The format of export data changes with the Go version. golangci-lint v2.5.0 (x/tools v0.37.0) cannot read Go 1.27's format (version 5); even the native build cannot import `fmt` | When Go is upgraded, golangci-lint is upgraded to a version that supports it (currently v2.15.0, x/tools v0.52.0) |
| Compression in transit | Many static servers add `Content-Encoding: gzip` to `*.gz`, so the browser decompresses them automatically and the checksums no longer match (happens with `vite preview`) | Gzipped assets use the `.bin` extension |

## 3. Architecture

```
┌──────────────────────── Static hosting (CDN) ──────────────────────────┐
│  /index.html, /assets/*            The app (built with Vite)            │
│  /versions.json                    Available golangci-lint versions     │
│  /v/{version}/                     Per-version assets (content-hashed)  │
│     golangci-lint.wasm.bin         golangci-lint for js/wasm            │
│     std.bundle.bin                 Standard library (source, types)     │
│     cache.bundle.bin               Pre-generated analysis cache         │
│     linters.json / schema.json     Linter list, config JSON Schema      │
└───────────────┬────────────────────────────────────────────────────────┘
                │ HTTPS (first visit only; then the service worker's cache)
┌───────────────▼──────────────────────── Browser ───────────────────────┐
│  Main thread (TypeScript + CodeMirror 6)                               │
│   ├ Go editor (multiple files / txtar)                                 │
│   ├ Configuration panel (YAML editor + linter dialog)                  │
│   ├ Results panel (list + editor markers + quick fixes)                │
│   └ Sharing (compressed into the URL fragment)                         │
│            │ postMessage (files and config ⇄ normalized results)       │
│  ┌─────────▼──────── Web Worker (lint engine) ──────────────────────┐  │
│  │  MemFS (Node-compatible fs in memory, globalThis.fs)             │  │
│  │   /goroot, /stdexport, /stdmanifest.json  ← std.bundle           │  │
│  │   /cache/golangci-lint                    ← cache.bundle         │  │
│  │   /work                                   ← the user's files     │  │
│  │  wasm_exec.js + golangci-lint.wasm (a new instance per run)      │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│  Service worker: stores /v/{version}/* in the Cache API                │
└────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Choosing the approach: server-side or WebAssembly in the browser

At first, WebAssembly in the browser was judged impractical, and the design described running golangci-lint in isolation on servers. The PoC then showed that **golangci-lint runs on js/wasm without modification and gives the same results as the native build**, so the two approaches were compared again.

| Aspect | A. WebAssembly in the browser | B. Isolated execution on servers |
| --- | --- | --- |
| Security | Everything stays in the user's browser, so there is no sandbox to design and operate. The code is never sent to a server | Strong isolation such as gVisor, rate limiting and DoS protection are required |
| Infrastructure and operating cost | Static hosting only; the cost barely grows with the number of users | Needs a VM or container platform for execution. The cost grows with usage |
| First load | About 24 MB (gzipped: WebAssembly 15.1 MB + standard library 9.0 MB + pre-generated cache 0.3 MB). Later visits load from the browser's cache | Light (the editor UI only) |
| Speed | In the browser PoC, about 3 seconds for the first run and about 0.9 seconds after that (default configuration) | About 0.5 seconds |
| Memory | 330–550 MB. Possibly too much for smartphones | Controlled on the server |
| Unsupported features | Linters that run the `go` command (`gomoddirectives` etc.). Supporting third-party modules is hard | None |
| Maintenance | Each new golangci-lint version is rebuilt with small patches to `golang.org/x/tools` | Just use the official binaries |

**Decision (2026-11-25): adopt WebAssembly in the browser (A).** The PoC running in the browser (`poc/wasm/` as of commit `bf8c696` in the git history) confirmed that it runs at a practical speed ([Appendix A.5](#a5-results-in-the-browser)). A summary of the server-side design is kept in [Appendix B](#appendix-b-server-side-approach-rejected).

## 4. Components

### 4.1 Frontend (UI)

- **Technology**: TypeScript + Vite, with **CodeMirror 6** as the editor
  - Lighter than Monaco; `@codemirror/lint` shows diagnostics, and `@codemirror/lang-go` / `@codemirror/lang-yaml` are available
  - Keep the UI framework small (Preact or plain TypeScript)
- **Layout**
  - Header: `Run` (Ctrl/Cmd+Enter), `Format` (Shift+Alt+F), `Fix`, `Cancel` (while running), `Share`, the version selector and the sample selector
    - **`Fix`**: fixes all auto-fixable issues with `golangci-lint run --fix` (using the user's `.golangci.yml`, formatters included). Only the changed files are rewritten, with minimal edits, so the change can be undone. The issues that remain are shown as the result
    - **`Format`**: formats every Go file with goimports, adding missing imports and removing unused ones (`golangci-lint fmt --no-config -E goimports`). The user's `.golangci.yml` is not read, so that other formatters in the configuration (gofumpt etc.) are not mixed in and the result depends on goimports alone. Missing imports are looked up in `$GOROOT/src` thanks to the x/tools patch ([4.3](#43-build-pipeline)). Only the changed files are rewritten, with minimal edits, so the change can be undone. Files that could not be formatted because of syntax errors are named in the status
  - Left: the Go code editor (file tabs: `+` creates `go.mod` or another file, double-click renames, `×` deletes; each tab shows its number of issues). Each file has its own CodeMirror `EditorState`, so undo history and markers are kept per file (`ui/files.ts`)
  - Top right: the configuration panel (for the requirements in [1.4](#14-requirement-free-form-configuration-file-yaml))
    - **YAML editor (source of truth)**: `.golangci.yml` is written freely. On top of highlighting by `@codemirror/lang-yaml`, it is assisted with the per-version JSON Schema (`schema.json`) (`web/src/config/`)
      - **Completion of keys and values**: the YAML path at the cursor (e.g. `linters.settings.govet`) is computed from indentation, so it works even while the YAML is broken mid-typing (`yamlpath.ts`), and the keys and values allowed there (enum values, booleans, linter names, etc.) are offered. A key whose value is an object gets a new indented line; a key whose value is an array gets `- `
      - **Hover**: keys show the schema's description; linter and formatter names show the description from `linters.json` / `formatters.json`
      - **Warnings**: anything that violates the schema (unknown keys, wrong types, enum values or patterns, etc.) is warned about, with "Did you mean …?" suggestions. Warnings never block running (golangci-lint makes the final call)
      - The schema is validated by a small interpreter of our own (`schema.ts`), because validators that generate code, such as ajv, do not work under the CSP (which does not allow `unsafe-eval`). Only the keywords golangci-lint's schema uses are implemented (`$ref`, `properties`, `patternProperties`, `additionalProperties`, `items`, `enum`, `anyOf`, `required`, `pattern`, `minimum`, `uniqueItems`, etc.)
      - The schema's linter names (`linter-names`) are "one of the known names or any string" to allow custom linters, so typos are not detected. The playground cannot load plugins and unknown names always fail at run time, so names in `linters.enable`, `linters.disable` and the `linters` of exclusion rules are checked against the linter list and warned about
    - **GUI (helper)**: the "Choose linters" dialog (`ui/toolspanel.ts`). It lists linters and formatters (generated from `linters.json` / `formatters.json`, with a filter, an "Enabled only" switch, badges for `standard`, `fast`, `autofix`, `deprecated` and unsupported in the browser, descriptions and links to the original repositories) and selects `linters.default`. Each operation rewrites only `linters.enable`, `linters.disable`, `linters.default` or `formatters.enable` in the YAML. The dialog reads its state from the YAML every time it opens
    - Partial rewriting of the YAML finds the position of the affected part from the syntax tree and replaces as little text as possible (`yamledit.ts`), because writing the whole document back with a YAML library would change quotes, indentation, blank lines and so on from how the user wrote them. Block and flow sequences, creating keys (including parents) and removing sequences that became empty (and their parents) are supported
    - Unsupported settings ([4.6](#46-features-that-do-not-work-in-the-browser)) and configuration errors are marked on their lines in the YAML editor
    - A "Reset to default" button
  - Bottom right / bottom: the results panel
    - The list of issues (linter name, message, position). Clicking one jumps to the line
    - Squiggly markers in the editor, with the message on hover
    - **Quick fix**: issues with `SuggestedFixes` get a "Fix" button in the results list and in the editor's issue popup. The edits of a suggested fix are UTF-8 byte offsets, so they are applied byte by byte to the content that was linted (`fixes.ts`), and the code is linted again automatically afterwards. If the code was edited after the run, the offsets would be wrong, so the fix is not applied and the status asks the user to run again
    - The run time and golangci-lint's log (stderr, collapsible)
- **First load**: while the roughly 24 MB download runs, the progress (MB / total) is shown. The editor can be used during the download. Later visits load from the service worker's cache, so there is almost no wait
- **Unsupported browsers**: browsers other than Google Chrome show the notice "This playground is tested with Google Chrome. It may not work correctly in other browsers." ([1.5](#15-scope-decisions)). Running is not blocked
- **Persisting state**: the content being edited is saved to `localStorage` automatically (wrapped in try/catch)
- **Samples**: chosen from the toolbar. Each sample is `web/examples/*.txtar`, with the title on the first line, the description on the following lines and `.golangci.yml` as the configuration (basics, linter settings and exclusions, formatters, multiple packages, nolint, modernize, style). Replacing the content being edited asks for confirmation. The samples are included in the parity tests, which guarantees that they report the same issues as the native build
- **Multiple files**: the same [txtar](https://pkg.go.dev/golang.org/x/tools/txtar) format as the Go Playground is used for share URLs and saved drafts (a lone main.go is stored as is, without txtar, so Phase 1 share URLs still open). The editor shows the files as tabs

  ```
  -- go.mod --
  module playground

  go 1.27
  -- main.go --
  package main
  ...
  ```

### 4.2 Lint engine (Web Worker)

Implemented in `web/src/engine/` (ported from the PoC to TypeScript). On the main thread, `client.ts` fetches and verifies the assets, compiles the WebAssembly module and manages the worker; in the worker, `worker.ts` holds the MemFS (`gofs.ts`) and runs golangci-lint (`runner.ts`). `runner.ts` and what it uses also run as is on Node.js, which is used to generate the cache and for the parity tests.

#### Message protocol

| Direction | Message | Contents |
| --- | --- | --- |
| UI → Worker | `init` | `{ module, wasmExecUrl, std, cache, goVersion }`. Downloading, checksum verification and compiling the WebAssembly module are done on the main thread, which passes the compiled module and the bundles. The worker unpacks the bundles into the MemFS |
| UI → Worker | `lint` | `{ id, files: { name: content } }`. `.golangci.yml` is included in `files`. Runs the linters |
| UI → Worker | `format` | `{ id, files }`. Formats with goimports (`FORMAT_ARGS`) and returns the formatted files as `formatted` (`{ id, files, log, exitCode, ms }`) |
| UI → Worker | `fix` | The same input as `lint`. Runs with `--fix` (`FIX_ARGS`) and returns the fixed files and the remaining issues as `fixed` (`{ id, issues, files, log, exitCode, ms }`) |
| UI → Worker | `migrate` | (Phase 3) `{ id, config }`. Converts a v1 configuration to v2 with `golangci-lint migrate` |
| Worker → UI | `ready` | Initialization finished |
| Worker → UI | `result` | `{ id, issues, files?, log, exitCode, ms }` |
| Worker → UI | `error` | `{ id?, code, message }` |

#### Execution flow

1. Empty `/work` and write the user's files and `.golangci.yml` (the user's YAML as is). Without a `go.mod`, one with `module playground` and the bundled Go version is added
2. Create a new Go instance and start golangci-lint with these arguments and environment variables
   - Arguments: `run --allow-parallel-runners --output.json.path /tmp/report.json --show-stats=false ./...`
   - Environment: `GOROOT=/goroot`, `GOOS=linux`, `GOARCH=amd64`, `CGO_ENABLED=0`, `GOTOOLCHAIN=local`, `GOLANGCI_LINT_CACHE=/cache/golangci-lint`, `WASM_STD_MANIFEST`, `WASM_EXPORT_DIR`, `HOME`
3. Afterwards, read and normalize `/tmp/report.json` (without the JSON, stdout / stderr are returned as an error). Output written to stdout / stderr because of the user's configuration is returned as the log
4. Clear the timers left by the Go runtime (`go._scheduledTimeouts`); otherwise they throw `Go program has already exited`
5. Remove harmless messages caused by running in the browser (failures to run `go env`, to lock files, etc.) from the log (stdout / stderr) before returning it to the UI

The MemFS provides `/dev/null` (writes are discarded, reads return EOF); without it golangci-lint warns on every run.

- **A new Go instance per run**, reusing the MemFS. This keeps golangci-lint's analysis cache across runs, so later runs are fast (about 0.9 seconds in the PoC). The WebAssembly memory is discarded with each instance
- Runs are processed one at a time (a queue)
- **Cancel**: `terminate()` the worker and create a new one. The compiled `WebAssembly.Module` and the bundle bytes are kept on the main thread and passed to the new worker, avoiding another download and compilation (the analysis cache built during the run is lost)
- **Timeouts**: unlike a server, there is no time limit. The elapsed time is shown, and the user can stop the run with `Cancel`

#### Result normalization

```ts
type Issue = {
  linter: string;          // FromLinter
  message: string;         // Text
  severity?: string;
  file: string;            // path relative to /work
  line: number;
  column: number;
  sourceLines?: string[];
  fixes?: { message: string; edits: { start: number; end: number; newText: string }[] }[];
};
```

- `SuggestedFixes[].TextEdits[].NewText` is base64-decoded into a string
- `typecheck` issues are split into one issue per line of `Text`, parsed with `^\.?/?(?<file>[^:\s]+\.go):(?<line>\d+):(?<col>\d+): (?<msg>.*)$` to correct the position
- The exit code is not relied on (1 with issues, 7 when errors are logged)

#### Input limits

The code only runs in the user's own browser, so no limits are needed for safety. For the length of share URLs and memory usage, however, loose limits (e.g. 20 files, 256 KiB in total) produce a warning when exceeded.

### 4.3 Build pipeline

For each golangci-lint version, the following assets are generated in `wasm/dist/v/<version>/`. `scripts/build-assets.sh` runs everything (steps 1–3 and 5 are `wasm/build.sh`; step 4 and `versions.json` are Node.js scripts in `web/scripts/`).

| Step | What | Output |
| --- | --- | --- |
| 1. Patch x/tools | Copy the `golang.org/x/tools` required by golangci-lint's `go.mod` from the module cache, apply the patches in `wasm/xtools/patches/` and add the files in `wasm/xtools/overlay/`. There are two patches: (a) a hook in `go/packages`' `defaultDriver` that calls the in-process driver (`inproc_js.go`, which also returns errors with import positions), and (b) a hook in `internal/imports`' `ProcessEnv.init` that returns values instead of running `go env` (`goenv_js.go`; it searches `$GOROOT/src` in GOPATH mode, so no `go` command is needed). The replacement is done with `replace` in a `-modfile` | — |
| 2. WebAssembly build | `GOOS=js GOARCH=wasm go build -trimpath -ldflags='-s -w'` | `golangci-lint.wasm.bin` (gzip, about 15 MB) |
| 3. Standard library | From `go list -export -json std` (`CGO_ENABLED=0 GOOS=linux GOARCH=amd64`), pack the source, the export data (`__.PKGDEF` only) and a manifest of the packages into one file | `std.bundle.bin` (gzip, about 9.4 MB) |
| 4. Cache | Run the WebAssembly build on Node with the same MemFS and paths as in the browser, linting a program that imports every public standard library package with the default configuration and with `--default=all` | `cache.bundle.bin` (gzip, about 0.3 MB) |
| 5. Metadata | Run `help linters --json` / `help formatters --json` with the native build of the same version (built alongside step 2 and also used by the parity tests). Extract `jsonschema/golangci.jsonschema.json` from the module | `linters.json`, `formatters.json`, `schema.json`, `build.json` (the version and the Go version) |
| 6. Manifest | Write the size and SHA-256 of each asset | `versions.json` |
| 7. Verification | Run the test suite ([section 9](#9-testing-strategy)) | — |

- **Pinning the Go toolchain**: built with the latest stable Go (currently go1.27.4), and the standard library in step 3 comes from the same Go ([1.5](#15-scope-decisions); the original plan was to use the same Go as golangci-lint's official release). It is set by the `toolchain` line of `wasm/go.mod` and enforced by `wasm/build.sh` through `GOTOOLCHAIN`. golangci-lint must be a version that supports that Go ([section 2](#2-verified-facts)). When Go or golangci-lint is upgraded, check that the parity tests match the native build (built with the same Go) and that the list of unsupported features in [4.6](#46-features-that-do-not-work-in-the-browser) has not changed
- **Keeping the patches applying**: the x/tools patch only adds a few lines at the top of `defaultDriver`, so it is likely to keep applying as x/tools is updated. If it stops applying, the build fails, so CI notices
- **The `.bin` extension**: gzipped assets are served as `.bin`, not `.gz`. Many static servers add `Content-Encoding: gzip` to `.gz`, and the browser would decompress them ([section 2](#2-verified-facts))
- **Content hashes in URLs**: the files under `/v/{version}/` can be rebuilt without a version change (CI rebuilds the assets when a file involved in the build changes, and the analysis cache contains timestamps, so its bytes change with every build). The original assumption that "a published file never changes" did not hold, and the service worker served stale files whose checksums did not match. So `versions.json` lists the size and SHA-256 of every file in the version directory, and the page fetches each file with a content-hashed URL such as `cache.bundle.bin?v=<first 16 characters of the SHA-256>` (`assetUrl`). When the content changes, so does the URL, so neither the browser's nor the service worker's cache can serve a stale file

### 4.4 Sharing

Without a server, the **URL fragment** is the basic mechanism.

- The snapshot is serialized to JSON, compressed with `CompressionStream('deflate-raw')`, base64url-encoded and put in `/#s=...`. The fragment is never sent to the server, so shared content does not even appear in access logs
- Opening a share URL only loads the content and **does not run it automatically** (the user presses `Run`)
- When the URL is too long (e.g. more than 8,000 characters), a warning suggests the Gist integration described below

The snapshot format (versioned for future extensions):

```json
{
  "schema": 1,
  "version": "v2.15.0",
  "files": "-- go.mod --\n...\n-- main.go --\n...",
  "config": "version: \"2\"\n..."
}
```

Future extension (Phase 3): **loading from GitHub Gist** (`/#gist=<id>`). The GitHub API supports CORS, so no server is needed. The `.go` files, `go.mod` and `.golangci.yml` in the gist are loaded.

### 4.5 Versions

- `/versions.json` lists the published versions, the default version, and the Go version and asset sizes of each version
- Only the assets of the selected version are fetched (switching versions fetches about 24 MB for that version)
- A scheduled job (GitHub Actions schedule) detects new releases and automatically opens a PR that builds, tests, deploys and updates `versions.json`
- Keep roughly the latest patch release of the last N (e.g. 5) minor versions. If a share URL uses a removed version, open it with the closest version and show a warning

### 4.6 Features that do not work in the browser

The `go` command cannot run in the browser. In Phase 1, each linter and formatter with code that uses the `go` command was run with the WebAssembly build to check it (verified with v2.5.0 and again after upgrading to v2.15.0).

| Feature | Result | Handling |
| --- | --- | --- |
| The `goimports`, `swaggo` and `gci` formatters | Before the patch, x/tools' `imports` package tried to run `go env`, failed, and **stopped the whole run**. With the x/tools patch ([4.3](#43-build-pipeline)) they work and give the same results as the native build (including `gci`'s `localmodule` section) | Supported |
| `depguard` (the `$gostd` variable), `gosec`, `unconvert`, `goheader` (`template-path`) | Work and give the same results as the native build | Supported |
| `gomoddirectives` | Cannot run `go list -m`; logs a warning and is ignored | Unsupported. A warning marker is shown when the configuration enables it |
| `gomodguard`, `gomodguard_v2` | No error, but they check module dependencies, so they never report anything in a playground limited to the standard library | Unsupported. Same as above |
| gocritic's ruleguard | Rule files import `github.com/quasilyte/go-ruleguard/dsl`, so they cannot be loaded, and an "empty rule set" issue is reported | Unsupported. A warning marker is shown on `linters.settings.gocritic.settings.ruleguard` |
| `linters.settings.custom` (plugins) | Cannot be loaded in the browser | Unsupported. A warning marker is shown |
| `linters.default: all` | Enables the unsupported linters above too | A note on the `default: all` line lists the linters that do not work (adding them to `linters.disable` hides it) |
| Imports outside the standard library (third-party modules) | Not supported ([1.5](#15-scope-decisions)). The in-process driver returns an error with the import position, reported as `typecheck` | The results list and the import line in the editor show "package ... is not in std" |
| golangci-lint's internal `go env` calls (cache key computation from go.mod, etc.) and the cache's file locks | Warnings and errors are logged and processing continues. The results are not affected | Removed from the log before it is shown |

- What is unsupported is defined in `web/src/config/unsupported.ts`, shared by the YAML editor's warnings (CodeMirror lint) and the unit tests
- The configuration file is never rewritten; only warnings are shown ([1.4](#14-requirement-free-form-configuration-file-yaml))

## 5. Security and privacy

All linting happens in the user's own browser, so the sandbox, rate limiting and DoS protection needed by the server-side approach are unnecessary. The remaining concerns:

| Threat / concern | Mitigation |
| --- | --- |
| XSS (content planted in share URLs) | The content of share URLs is not trusted. Issue messages, file names and so on are always rendered as text (no `innerHTML`). A CSP is set (`script-src 'self' 'wasm-unsafe-eval'`, `connect-src 'self'`, `worker-src 'self'`, etc.; injected only into the production HTML so that the development server keeps working. The Gist integration in Phase 3 adds `https://api.github.com` to `connect-src`) |
| Heavy share URLs occupying the browser | Share URLs are not run automatically. Linting runs in a worker, so the UI does not freeze, and `Cancel` stops it |
| Supply chain (code used for the build) | golangci-lint and its dependencies are pinned by `go.sum` and built from source in CI. The x/tools patches are kept and reviewed in the repository. Frontend dependencies are pinned by the lockfile |
| Tampering with served assets | Served from the same origin, over HTTPS only. `versions.json` lists the SHA-256 of each asset, verified on the main thread after downloading |
| Privacy | The code is never sent to a server. Shared content is in the URL fragment, so it does not appear in the host's logs either. If analytics are added, they must not use cookies |

## 6. Directory layout

```
.
├── wasm/                          # Build pipeline of golangci-lint for WebAssembly
│   ├── go.mod                     # Pins the golangci-lint version and the Go toolchain
│   ├── build.sh                   # WebAssembly, standard library bundle, metadata → dist/v/<version>/
│   ├── xtools/
│   │   ├── patches/               # Patches to golang.org/x/tools
│   │   └── overlay/               # Files added to x/tools (inproc_js.go, goenv_js.go)
│   └── tools/mkbundle/            # Generates the standard library bundle
├── web/                           # Web app (Vite + TypeScript + CodeMirror 6)
│   ├── index.html
│   ├── src/
│   │   ├── main.ts                # Puts the page together
│   │   ├── engine/                # Lint engine (Web Worker; also runs on Node.js)
│   │   ├── ui/                    # Editor, file tabs, linter dialog, results list, position conversion
│   │   ├── config/                # Configuration assistance: schema (completion, hover, warnings), partial YAML edits, unsupported settings
│   │   ├── share.ts, txtar.ts, samples.ts
│   │   └── sw.ts                  # Service worker
│   ├── examples/                  # Samples (txtar)
│   ├── scripts/                   # Cache generation, versions.json, parity tests (Node.js)
│   ├── test/                      # Unit tests (Vitest)
│   └── e2e/                       # E2E tests (Playwright)
├── scripts/
│   ├── build-assets.sh            # Builds all assets
│   └── check-design-sync.mjs      # Checks that design.md and design.ja.md have the same sections
├── testdata/parity/               # Parity test cases (txtar)
├── .github/workflows/ci.yml       # Tests and deployment to GitHub Pages
├── CLAUDE.md                      # Rules for contributors and coding agents (English only, etc.)
└── docs/design.md, design.ja.md   # This document (English and Japanese)
```

`publicDir` in `vite.config.ts` points to `wasm/dist`, so the built assets are served together with the web app as they are.

## 7. Deployment

- **Hosting**: GitHub Pages (deployed from GitHub Actions). There is no server-side processing
  - On pushes to the `main` branch, `web/dist` is deployed once CI ([section 9](#9-testing-strategy)) passes (`.github/workflows/ci.yml`). Set Settings → Pages → Source to "GitHub Actions" in the repository
  - Vite's `base` is `./`, so the site also works under a subpath such as `https://<user>.github.io/<repo>/`
  - Bandwidth: about 25 MB per new visitor. GitHub Pages has a soft limit of 100 GB per month, so if usage grows, move to static hosting without bandwidth limits (Cloudflare Pages etc.; the files fit within its 25 MiB per-file limit)
- **Caching**: GitHub Pages does not allow setting cache headers. So the service worker (`sw.ts`) stores everything under `/v/` in the Cache API, and later visits do not go to the network for it. `versions.json` and the page are fetched from the network as usual
  - Content-hashed URLs (`?v=`, [4.3](#43-build-pipeline)) are cache-first. When a file with a new hash is stored, older hashes of the same file are deleted
  - URLs without a hash (requests from pages older than content-hashed URLs) are network-first, using the cache only when offline. When the service worker updates, the old cache entries without a hash are deleted
  - If a checksum still does not match (e.g. the CDN returns a file from the previous deployment), the file is fetched once more bypassing the cache (`cache: 'reload'`)
- **Compression**: assets are served as files gzipped by us (`.bin`) and decompressed on the main thread, independent of the host's compression settings. No further size reduction is done ([1.5](#15-scope-decisions))
- **CI jobs**: so that the run time does not grow serially, jobs without dependencies run in parallel. Assets are passed between jobs as artifacts

  ```
  typecheck ───────────────┐
  unit ────────────────────┤
  assets ─┬─ parity ───────┼─ CI success ─ deploy (main only)
          └─ e2e ──────────┘
  ```

  - Within the `assets` job, independent work runs in parallel too. The WebAssembly build, the native build and the standard library bundle run at the same time (`wasm/build.sh`), and cache generation runs the default configuration and all linters as two parallel processes whose results are merged (`web/scripts/seed-cache.ts`; the cache consists of content-addressed files, so taking the union is enough). On 4 cores without a Go build cache, this went from about 220 seconds to about 175 seconds
  - The assets are saved with `actions/cache`, keyed by a hash of the files involved in the build, and the build is skipped when nothing changed
  - **The `CI success` job**: an aggregate job that succeeds only when every job needed for deployment succeeded. Only this job is set as the required check of the `main` branch ruleset and for auto-merge (so changing the job structure does not require changing the ruleset). Required checks treat skipped jobs as successful, so `CI success` always runs even when an upstream job fails (`if: !cancelled()`) and checks that every result is `success`. `deploy` depends only on this job
  - Splitting the jobs further, one runner per Go build, was rejected: the Go build cache (`setup-go` uses a shared cache key) would be contended between jobs and more artifacts would be passed around, for little gain
- **Documentation sync**: the `unit` job runs `scripts/check-design-sync.mjs`, which fails when `docs/design.md` and `docs/design.ja.md` do not have the same heading structure (levels and section numbers)

## 8. Observability

Without a server, little information is available.

- Analytics (optional): lightweight cookie-free analytics, to see roughly the number of visits and the versions used
- Error reports (optional): consider anonymously sending worker initialization and run failures with the user's consent (never the code or the configuration). Not for now; a link for reporting to GitHub Issues is provided instead

## 9. Testing strategy

| Kind | What | How to run |
| --- | --- | --- |
| MemFS compatibility tests | Run the same operations on the MemFS and on `node:fs` (a temporary directory) and check that the results and error codes (`ENOENT`, `EEXIST`, `EISDIR`, `ENOTDIR`, `ENOTEMPTY`, `EBADF`, etc.) match | `npm test` (`web/test/gofs.test.ts`) |
| Unit tests | Result normalization (position correction of `typecheck`, decoding of `SuggestedFixes`, log cleanup), txtar, share URL round trips, conversion of UTF-8 columns, detection of unsupported settings, schema navigation and validation (with a small test schema), the YAML path at the cursor, partial YAML edits (comments and formatting are kept), and checking and toggling whether linters are enabled | `npm test` |
| Parity with the native build | Lint `testdata/parity/*.txtar` and `web/examples/*.txtar` (the samples) with the native and WebAssembly builds (on Node.js) of the same version, and check that the issues (including the suggested fixes) are exactly the same. Each case also runs with `--fix`, checking that the fixed files and remaining issues match too. 9 cases (default configuration, all linters and formatters, type errors, multiple packages, formatters, free-form configuration, nolint, gci's localmodule, auto-fixes including fixes after multibyte characters) and the 7 samples | `npm run parity` |
| E2E | With Playwright (Chromium): linting a sample and the editor markers, jumping to an issue by clicking it, free-form configuration (including `output.*`), warnings about unsupported settings, the error position for imports outside the standard library, file tabs (add, rename, delete, jumping to an issue in another file), errors from an invalid configuration, share URLs (multiple files, not running automatically), cancellation, the service worker cache (assets rebuilt by a redeployment are fetched again without a forced reload), the linter dialog (partial YAML edits), completion, warnings and hover from the schema, the samples, formatting with goimports (adding missing imports, all tabs, undo, the shortcut, files with syntax errors), fixing everything with `Fix` (undo), and quick fixes (applied from the results list and from the editor popup, linting again, not applying after the code was edited). 20 scenarios, including 2 that check how the selection on the cursor line looks in the light and dark themes | `npm run e2e` |
| Documentation sync | `docs/design.md` and `docs/design.ja.md` have the same headings (levels and section numbers) | `node scripts/check-design-sync.mjs` |
| CI | GitHub Actions runs the type check, the unit tests and the asset build in parallel, then the parity tests and E2E in parallel once the assets are ready ([section 7](#7-deployment)) | `.github/workflows/ci.yml` |

There are no unit tests of the in-process driver (Go) yet. Its behavior is covered by the parity tests (multiple packages, type errors) and E2E (imports outside the standard library).

## 10. Implementation phases

### Phase 0: PoC (done)

- The js/wasm build and in-process driver, the standard library bundle, the pre-generated cache, the in-memory fs, the Web Worker, a UI with a plain textarea, and E2E (the PoC: `poc/wasm/` as of commit `bf8c696` in the git history)

### Phase 1: MVP (done)

- Ported the lint engine to TypeScript (`web/src/engine/`) and moved the build pipeline to `wasm/`
- Built with the latest stable Go. It started with go1.25.1, the same as golangci-lint v2.5.0's official release; on 2026-11-25 it moved to go1.27.4, together with golangci-lint v2.15.0, which supports Go 1.27
- The CodeMirror 6 editor (light and dark themes), markers in the editor, and the results list (clicking jumps to the position)
- A single file with a generated `go.mod`. Multiple files can be handled in one editor as txtar (replaced by tabs in Phase 2)
- A free-form YAML configuration (passed as is, without rewriting). When empty, the default configuration (`standard`) is used
- Identified unsupported features and shows warnings ([4.6](#46-features-that-do-not-work-in-the-browser)). Along the way, `goimports` was found to stop the whole run; fixed by patching x/tools
- Cancellation, download progress, and checksum verification of the assets
- Sharing with URL fragments (share URLs are not run automatically)
- Caching the assets with a service worker
- A notice in browsers other than Google Chrome
- Workflows for CI (type check, unit tests, parity tests, E2E) and deployment to GitHub Pages (not yet run on GitHub at the time)

### Phase 2: Configuration (done)

- A better YAML editor: completion, hover documentation and warnings from the JSON Schema (with a validator of our own that works under the CSP). Warnings about unknown linter names
- A GUI for choosing linters: rewrites only part of the YAML, keeping comments and ordering
- Multiple files in tabs (txtar stays as the sharing and storage format)
- Samples (7, also included in the parity tests)

### Phase 3: More features

- Multiple versions, and automatically following new releases
- `Fix` (`--fix`) and quick fixes (applying `SuggestedFixes`) (done). `Format` (formatting with goimports and adding imports) was implemented earlier, after Phase 2
- Help migrating v1 configurations to v2 (running `golangci-lint migrate` in the browser)
- Loading from GitHub Gist
- Comparing the results of two versions side by side

### Phase 4: Beyond

- Patches for individual unsupported linters (most requested first)

## 11. Open questions

Third-party modules, supported browsers and the download size were settled in [1.5](#15-scope-decisions). The remaining questions:

- **Heavy linter configurations**: `--default=all` takes about 7 seconds even with the cache (measured on Node). How to present the wait, and how much is acceptable
- **Choosing the Go version**: whether to let users choose the Go version being analyzed (the `go` line of `go.mod`) separately from the golangci-lint version. The standard library bundle is needed per Go version, so for now it is fixed at "one Go per golangci-lint version"
- **i18n**: the UI is in English only. Whether to offer other languages (e.g. Japanese)

## Appendix A: PoC results of the WebAssembly approach

Verified on 2026-11-25 by building golangci-lint v2.5.0 with `GOOS=js GOARCH=wasm` (Go 1.24.7). A.1–A.4 were verified on Node.js 22, A.5 in the browser.

### A.1 Whether it builds

| Target | Result |
| --- | --- |
| `GOOS=wasip1` | Fails, because dependencies (`termenv`, `logrus`, `viper`'s file watching) do not support it |
| `GOOS=js` | **Builds without modification**. 72 MB (15.4 MB gzipped) |

### A.2 Changes needed to run it

The unmodified binary starts and can print its version, but stops when loading packages. golangci-lint uses `golang.org/x/tools/go/packages`, which runs `go list` as a child process, but js/wasm can create neither processes nor pipes (`pipe: not implemented on js`).

So **golangci-lint itself was left unchanged, and only `golang.org/x/tools` was replaced with a `replace` directive**.

1. Add a hook to `go/packages`' `defaultDriver` that calls an in-process driver only on js/wasm (a few lines)
2. The in-process driver (about 200 lines): resolves the user's packages with `go/build` and looks up standard library packages in a pre-generated manifest. It never calls `go list`
3. Pre-generate and ship the standard library's export data (type information). golangci-lint reads dependencies from export data, so this is required. Only the type information (`__.PKGDEF`) is cut out of the archives written by `go list -export std`
4. Run with `--allow-parallel-runners` (file locks are not available on js/wasm)

The shipped data (when verified on Node; see A.5 for the final sizes in the browser PoC):

| Data | Raw size | Gzipped |
| --- | --- | --- |
| golangci-lint (WebAssembly) | 72 MB | 15.4 MB |
| Export data of the standard library (336 packages) | 8.7 MB | 4.0 MB |
| Source of the standard library (without tests and `cmd`) | 29 MB | 6.6 MB |
| Manifest of the standard library (packages and imports) | 129 KB | — |

The standard library's source is needed to compute the "facts" of dependencies (analysis information used by checks such as `printf`) when there is no cache.

### A.3 Measurements (Node)

Results for a sample (one file with `errcheck`, `ineffassign`, a `govet` printf violation and a `bodyclose` violation).

| Condition | WebAssembly (Node) | Native |
| --- | --- | --- |
| Startup only (`version`) | 0.7 s | — |
| Default configuration, no cache | 23.5 s | 30 s (1 thread) / 5 s (parallel) |
| Default configuration, with cache | **1.9 s** (332 MB of memory) | 0.3–0.5 s |
| `--default=all`, first run | 20.9 s (544 MB of memory) | — |
| `--default=all`, with cache | **6.7 s** (377 MB of memory) | 0.6 s (104 MB of memory) |

- The issues found were **exactly the same** as the native build (default configuration: `errcheck`, `govet`, `ineffassign`; all linters: `bodyclose`, `errcheck`, `forbidigo`, `ineffassign`, `revive`)
- In the first prototype, the driver scanned the standard library with `go/build` every time, and loading took 12.7 seconds. Switching to the manifest brought it down to 30 milliseconds
- WebAssembly runs single-threaded, so without a cache it is about as slow as the native build on one thread (about 1.2×)

### A.4 Limitations found

- Features that run the `go` command internally do not work: `gomoddirectives` (`go list -m`), the `gci` formatter (`go env`), cache key computation from go.mod, etc. They log warnings and processing continues
- golangci-lint's cache cleanup cannot use file locks and logs an error (the results are not affected)
- Third-party modules: dependencies are read from export data, so they cannot be handled as is without running the Go compiler in the browser (decided not to support them; see [1.5](#15-scope-decisions))

### A.5 Results in the browser

A PoC that runs only in the browser was built in `poc/wasm/` (as of commit `bf8c696` in the git history) and tested end to end with headless Chromium (Playwright).

What was implemented:

- **An in-memory file system** (`web/gofs.js`): the Node-compatible `fs` API called by Go's `syscall/fs_js.go` (`open`, `read`, `write`, `stat`, `readdir`, `rename`, etc.) in about 400 lines, installed as `globalThis.fs`. No external libraries
- **A Web Worker**: the worker holds the MemFS and the WebAssembly module, so the UI never freezes. Each run starts a new Go instance, and the MemFS (that is, golangci-lint's cache) is shared between runs
- **Pre-generating the cache**: the WebAssembly golangci-lint runs on Node with the same MemFS and paths as in the browser, linting a program that imports 171 public standard library packages to build the cache. It is only 0.3 MB gzipped and **works as is in the browser**

Measurements (on a local server, so network speed is not included):

| Item | Result |
| --- | --- |
| Download size (gzipped) | About 24.4 MB (WebAssembly 15.1 MB, standard library 9.0 MB, cache 0.3 MB) |
| Initialization (decompression, WebAssembly compilation) | About 0.8 s |
| First run | About 2.7–3.2 s (22.6 s without the pre-generated cache) |
| Later runs | About 0.9 s |
| Code with type errors only | About 0.4 s |

- The issues found matched the native build (`bodyclose`, `errcheck`, `govet`, `ineffassign`)
- A free-form `.golangci.yml` was confirmed to be used as is (`default: none` + only `govet` → only `govet` reports)
- Type errors were shown at the right line and column (`main.go:4:2`) after correcting the position from `Text`
- Timers left after the Go program exited fired and threw `Go program has already exited`. Fixed by clearing `go._scheduledTimeouts` after each run
- Additional check: with the JSON output pointed by flag at an in-memory file (`/tmp/result.json`), the results were written to that file correctly even when the user's configuration set `output.formats.text.path: stdout` / `output.formats.json.path: stderr` (flags take precedence over the configuration). So the user's YAML never needs to be rewritten

## Appendix B: Server-side approach (rejected)

A summary of the server-side approach considered first. For details, see this document as of commit `e74abd3` in the git history.

- **Architecture**: SPA → API server in Go (input validation, result cache, rate limiting, storing shared snippets) → a disposable container per job (gVisor / runsc) running golangci-lint
- **Isolation**: `--network=none`, read-only rootfs, a tmpfs work area, limits on CPU / memory / PIDs / run time, non-root, `cap-drop=ALL`, no host directories mounted. Jobs are passed as JSON on stdin
- **Why it was treated as seriously as arbitrary code execution**: pathological inputs exploiting bugs in parsers or linters, starting a C compiler through cgo, reading and writing files through the configuration, and fetching toolchains or referencing files through `toolchain` / `replace` in `go.mod`
- **Speed**: about 0.5 seconds with the standard library's analysis cache baked into the container image
- **Deployment**: Docker on a VM with gVisor; for scaling, a gVisor RuntimeClass such as GKE Sandbox. Environments that cannot start containers inside containers, such as Cloud Run, cannot host the sandbox
- **Why it was rejected**: designing and operating the sandbox, and the infrastructure cost, would be a heavy burden. WebAssembly in the browser was confirmed to be fast enough for practical use
