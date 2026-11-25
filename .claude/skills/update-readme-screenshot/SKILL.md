---
name: update-readme-screenshot
description: Retake the screenshot in README.md (docs/images/screenshot.png) from the current playground UI. Use when the UI changed visibly (buttons, layout, styles, texts), or when asked to update, retake or refresh the README screenshot.
---

# Update the README screenshot

`docs/images/screenshot.png` is taken by `web/scripts/screenshot.ts`, so it can be retaken the same way whenever the UI changes:

- the production build, served by `vite preview`
- Chromium (Playwright), viewport 1360×820 at device scale factor 2 (a 2720×1640 PNG), light color scheme
- the **Modernize** sample, linted with Run, so that the results show quick fix (`Fix`) buttons
- no focus ring and no hover effect

## Steps

1. Build the golangci-lint assets if `wasm/dist/versions.json` does not exist (this takes a few minutes):

   ```bash
   ./scripts/build-assets.sh
   ```

2. Build the web app from the current code. Run this every time: the screenshot shows `web/dist`, not the source.

   ```bash
   cd web && npm ci && npm run build
   ```

3. Take the screenshot. It overwrites `docs/images/screenshot.png`.

   ```bash
   cd web && npm run screenshot
   ```

   Options, if the default scenario no longer shows the UI well:
   - `--sample <title>`: another sample, by its title in the sample menu (e.g. `"Multiple packages"`)
   - `--tab <file>`: the file tab to show (e.g. `internal/store/store.go`)
   - `--color-scheme dark`
   - `--out <path>`: write elsewhere, e.g. to the scratchpad to compare candidates first

   If Chromium is missing locally, install it with `npx playwright install chromium` (in Claude Code cloud sessions it is preinstalled).

4. Look at the image (Read `docs/images/screenshot.png`) before committing. Check that:
   - the toolbar, both editors and the results are fully visible and nothing is cut off
   - the status says `Done (… s)` and the results list the sample's issues (not a loading or error state)
   - all text is in English

5. If the scenario changed (another sample, tab or color scheme), update the alt text of the image in `README.md` to describe what it shows, and change the defaults in `web/scripts/screenshot.ts` so that the next run reproduces it.

6. Commit `docs/images/screenshot.png` (and `README.md` if changed) with an English commit message, e.g. "Update the README screenshot".

The elapsed time in the status (`Done (1.84 s)`) differs between runs, so the PNG changes slightly even when the UI does not. Do not commit a new screenshot when nothing visible changed.
