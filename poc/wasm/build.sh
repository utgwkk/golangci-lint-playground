#!/usr/bin/env bash
# Builds the browser PoC into dist/:
#   golangci-lint.wasm.gz  golangci-lint (js/wasm) with the patched go/packages
#   std.bundle.gz          std sources + export data + manifest
#   cache.bundle.gz        pre-populated golangci-lint cache for std
#   *.js, index.html       web app, plus Go's wasm_exec.js
set -euo pipefail

POC="$(cd "$(dirname "$0")" && pwd)"
DIST="$POC/dist"
WORK="$POC/.build"
export GOTOOLCHAIN=local
export GOFLAGS=-mod=mod

cd "$POC"
rm -rf "$DIST" "$WORK"
mkdir -p "$DIST" "$WORK"

echo "==> Go $(go env GOVERSION), golangci-lint $(go list -m -f '{{.Version}}' github.com/golangci/golangci-lint/v2)"

echo "==> Preparing patched golang.org/x/tools"
XT_VERSION="$(go list -m -f '{{.Version}}' golang.org/x/tools)"
XT_DIR="$(go mod download -json "golang.org/x/tools@$XT_VERSION" | sed -n 's/.*"Dir": "\(.*\)".*/\1/p')"
cp -r "$XT_DIR" "$WORK/xtools"
chmod -R u+w "$WORK/xtools"
patch -s -d "$WORK/xtools" -p1 < "$POC/xtools/defaultdriver-hook.patch"
cp "$POC/xtools/inproc_js.go" "$WORK/xtools/go/packages/inproc_js.go"
cp go.mod "$WORK/go.mod"
cp go.sum "$WORK/go.sum"
go mod edit -modfile="$WORK/go.mod" -replace="golang.org/x/tools=$WORK/xtools"

echo "==> Building golangci-lint for js/wasm"
GOOS=js GOARCH=wasm go build -modfile="$WORK/go.mod" -trimpath -ldflags='-s -w' \
  -o "$WORK/golangci-lint.wasm" github.com/golangci/golangci-lint/v2/cmd/golangci-lint
gzip -9 -c "$WORK/golangci-lint.wasm" > "$DIST/golangci-lint.wasm.gz"

echo "==> Bundling the standard library"
go run ./tools/mkbundle -out "$DIST/std.bundle.gz" -warmup "$WORK/warmup"

echo "==> Copying web files"
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" "$DIST/"
cp "$POC"/web/* "$DIST/"

echo "==> Seeding golangci-lint cache (takes a few minutes)"
node "$POC/scripts/seed-cache.mjs" "$DIST" "$WORK/warmup"

ls -l "$DIST"
