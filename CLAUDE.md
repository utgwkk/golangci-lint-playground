# CLAUDE.md

Rules for working in this repository (for coding agents and human contributors alike).

## Language: English only

Write everything in this repository in English:

- Commit messages
- Pull request titles and descriptions, issue and review comments
- Markdown files (README, documents)
- UI text (labels, messages, tooltips, `aria-label`s)
- Code comments, identifiers, log and error messages
- Sample code and configuration in `web/examples/` and `testdata/`

This applies even when the conversation with the user is in another language.

### Exceptions

- **`docs/design.ja.md`** is the Japanese version of `docs/design.md`. Whenever you change `docs/design.md`, update `docs/design.ja.md` in the same commit with the same content, and vice versa. Both must keep the same headings (levels and section numbers); `node scripts/check-design-sync.mjs` checks this and runs in CI.
- **Deliberate non-ASCII test data**, such as Japanese text used to test UTF-8 byte offsets or URL round trips, may stay. Add a comment saying why it is there.

## Licenses

This repository is MIT-licensed, but golangci-lint is GPL-3.0 (see docs/design.md, section 12).

- Do not copy code from golangci-lint or other GPL-licensed projects into this repository. Changes to `golang.org/x/tools` go in `wasm/xtools/patches/` (BSD-3-Clause, like x/tools).
- The WebAssembly build must stay buildable from the published source archive: build it only from the vendored tree in `wasm/build.sh`, never from files outside it.
- If `wasm/tools/mknotices` or `web/scripts/licenses-plugin.ts` fails the build because of a new dependency's license, check that the license is compatible with GPL-3.0 (Go modules) or allows bundling with attribution (npm packages) before adding it to the allowed list.

## Before opening a pull request

```bash
node scripts/check-design-sync.mjs
```

```bash
cd web && npm run typecheck && npm test
```

```bash
cd web && npm run parity
```

```bash
cd web && npm run build && npm run e2e
```

The parity tests and E2E need the assets built by `./scripts/build-assets.sh` (see README.md).
