#!/usr/bin/env bash
# Builds the Go-side assets for the golangci-lint version pinned in go.mod:
#
#   dist/v/<version>/golangci-lint.wasm.bin   golangci-lint (js/wasm) with the patched go/packages
#   dist/v/<version>/std.bundle.bin           std sources + export data + manifest
#   dist/v/<version>/wasm_exec.js            Go's JS runtime glue (must match the Go version)
#   dist/v/<version>/{linters,formatters,schema,build}.json   metadata
#   .build/golangci-lint                     native build of the same version (metadata, parity tests)
#   .build/warmup/                           program importing all public std packages (cache seeding)
#
# The *.bin files are gzip-compressed. They are deliberately not named *.gz:
# many static servers add "Content-Encoding: gzip" to *.gz files, which makes
# browsers decompress them transparently and breaks the checksums.
#
# The golangci-lint cache bundle and versions.json are produced afterwards by
# ../scripts/build-assets.sh, which needs the TypeScript engine.
set -euo pipefail

cd "$(dirname "$0")"
WASM_DIR="$(pwd)"
WORK="$WASM_DIR/.build"

# Use exactly the Go toolchain named in go.mod (see docs/design.md, section 1.5).
export GOTOOLCHAIN="$(sed -n 's/^toolchain //p' go.mod)"
export GOFLAGS=-mod=mod

VERSION="$(go list -m -f '{{.Version}}' github.com/golangci/golangci-lint/v2)"
OUT="$WASM_DIR/dist/v/$VERSION"
echo "==> golangci-lint $VERSION with $(go env GOVERSION)"

rm -rf "$WORK" "$OUT"
mkdir -p "$WORK" "$OUT"

echo "==> Preparing patched golang.org/x/tools"
XT_VERSION="$(go list -m -f '{{.Version}}' golang.org/x/tools)"
XT_DIR="$(go mod download -json "golang.org/x/tools@$XT_VERSION" | sed -n 's/.*"Dir": "\(.*\)".*/\1/p')"
cp -r "$XT_DIR" "$WORK/xtools"
chmod -R u+w "$WORK/xtools"
for p in xtools/patches/*.patch; do
  patch -s -d "$WORK/xtools" -p1 < "$p"
done
cp -r xtools/overlay/. "$WORK/xtools/"
cp go.mod "$WORK/go.mod"
cp go.sum "$WORK/go.sum"
go mod edit -modfile="$WORK/go.mod" -replace="golang.org/x/tools=$WORK/xtools"

# The three builds below are independent, so they run in parallel.
# Each one logs to its own file, which is printed when it finishes.

build_wasm() {
  GOOS=js GOARCH=wasm go build -modfile="$WORK/go.mod" -trimpath -ldflags='-s -w' \
    -o "$WORK/golangci-lint.wasm" github.com/golangci/golangci-lint/v2/cmd/golangci-lint
  gzip -9 -n -c "$WORK/golangci-lint.wasm" > "$OUT/golangci-lint.wasm.bin"
  cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" "$OUT/wasm_exec.js"
}

# Native build of the same version: metadata here, and parity tests later.
build_native() {
  go build -trimpath -o "$WORK/golangci-lint" github.com/golangci/golangci-lint/v2/cmd/golangci-lint
  "$WORK/golangci-lint" help linters --json > "$OUT/linters.json"
  "$WORK/golangci-lint" help formatters --json > "$OUT/formatters.json"
}

bundle_std() {
  go run ./tools/mkbundle -out "$OUT/std.bundle.bin" -warmup "$WORK/warmup"
}

declare -A pids
for task in build_wasm build_native bundle_std; do
  echo "==> Starting $task"
  ( set -euo pipefail; start=$SECONDS; "$task"; echo "$task: done in $((SECONDS - start))s" ) > "$WORK/$task.log" 2>&1 &
  pids[$task]=$!
done
failed=0
for task in build_wasm build_native bundle_std; do
  if wait "${pids[$task]}"; then
    sed 's/^/    /' "$WORK/$task.log"
  else
    echo "==> $task failed:"
    sed 's/^/    /' "$WORK/$task.log"
    failed=1
  fi
done
[ "$failed" = 0 ] || exit 1

cp "$(go list -m -f '{{.Dir}}' github.com/golangci/golangci-lint/v2)/jsonschema/golangci.jsonschema.json" "$OUT/schema.json"
printf '{"version":"%s","goVersion":"%s"}\n' "$VERSION" "$(go env GOVERSION)" > "$OUT/build.json"

chmod u+w "$OUT"/*
ls -l "$OUT"
