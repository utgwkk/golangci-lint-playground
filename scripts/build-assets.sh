#!/usr/bin/env bash
# Builds all assets for the golangci-lint version pinned in wasm/go.mod into wasm/dist/:
#   1. Go side (wasm/build.sh): golangci-lint.wasm.bin, std.bundle.bin, metadata
#   2. golangci-lint cache seeding (runs the wasm build in Node.js)
#   3. versions.json
# Requires: Go (the toolchain in wasm/go.mod is downloaded automatically), Node.js,
# and `npm ci` in web/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/wasm/build.sh"

VERSION="$(cd "$ROOT/wasm" && GOFLAGS=-mod=mod go list -m -f '{{.Version}}' github.com/golangci/golangci-lint/v2)"
cd "$ROOT/web"
echo "==> Seeding golangci-lint cache"
npx tsx scripts/seed-cache.ts "$ROOT/wasm/dist/v/$VERSION" "$ROOT/wasm/.build/warmup"
echo "==> Writing versions.json"
npx tsx scripts/write-versions.ts "$ROOT/wasm/dist"
