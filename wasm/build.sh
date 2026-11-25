#!/usr/bin/env bash
# Builds the Go-side assets for the golangci-lint version pinned in go.mod:
#
#   dist/v/<version>/golangci-lint.wasm.bin   golangci-lint (js/wasm) with the patched go/packages
#   dist/v/<version>/std.bundle.bin           std sources + export data + manifest
#   dist/v/<version>/wasm_exec.js            Go's JS runtime glue (must match the Go version)
#   dist/v/<version>/{linters,formatters,schema,build}.json   metadata
#   dist/v/<version>/golangci-lint-source.tar.gz  complete source of the wasm build (GPL-3.0)
#   dist/v/<version>/licenses.txt            licenses and notices of everything in the wasm build
#   .build/golangci-lint                     native build of the same version (metadata, parity tests)
#   .build/warmup/                           program importing all public std packages (cache seeding)
#
# The *.bin files are gzip-compressed. They are deliberately not named *.gz:
# many static servers add "Content-Encoding: gzip" to *.gz files, which makes
# browsers decompress them transparently and breaks the checksums.
#
# The golangci-lint cache bundle and versions.json are produced afterwards by
# ../scripts/build-assets.sh, which needs the TypeScript engine.
#
# golangci-lint is licensed under the GPL-3.0, so the wasm binary is shipped
# with its complete corresponding source: a module with every dependency
# vendored (including the patched golang.org/x/tools). The binary is built from
# exactly that tree, offline, so the published source always matches it.
set -euo pipefail

REPO_URL=https://github.com/utgwkk/golangci-lint-playground

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

# The source tree of the wasm build: go.mod/go.sum of this directory, with
# every module vendored and golang.org/x/tools replaced by the patched copy.
echo "==> Vendoring the source of the wasm build"
SRC_NAME="golangci-lint-$VERSION-js-wasm-source"
SRC="$WORK/$SRC_NAME"
mkdir -p "$SRC/playground"
cp go.mod go.sum "$SRC/"
mv "$WORK/xtools" "$SRC/xtools"
(cd "$SRC" && go mod edit -replace=golang.org/x/tools=./xtools)
# go mod vendor only follows imports, not the tool directive.
printf '//go:build tools\n\npackage tools\n\nimport _ "github.com/golangci/golangci-lint/v2/cmd/golangci-lint"\n' > "$SRC/tools.go"
(cd "$SRC" && go mod vendor)
# vendor/ has the patched packages; the patches themselves are kept for reference.
rm -rf "$SRC/xtools"
cp -r build.sh xtools "$SRC/playground/"
PATCH_DATE="$(git log -1 --format=%cs -- xtools 2>/dev/null || true)"
cat > "$SRC/README.md" <<EOF_README
# golangci-lint $VERSION for js/wasm: corresponding source

This is the complete source code of the WebAssembly build of golangci-lint
$VERSION served by the golangci-lint playground ($REPO_URL).

golangci-lint is free software licensed under the GNU General Public License
version 3 (vendor/github.com/golangci/golangci-lint/v2/LICENSE). Its
dependencies are under their own licenses, found next to their source in
vendor/ and collected in licenses.txt, which is published next to the binary.

## Modifications

golangci-lint itself is not modified. golang.org/x/tools is patched
(last changed ${PATCH_DATE:-unknown}) so that it works in a browser, where the go
command cannot be run:

- go/packages loads packages in-process instead of running \`go list\`
- internal/imports gets its Go environment without running \`go env\`

The patched x/tools is in vendor/golang.org/x/tools. The patches and added
files are in playground/xtools/, and playground/build.sh is the script that
builds all assets of the playground.

## Building

With $GOTOOLCHAIN (no network access needed):

    GOOS=js GOARCH=wasm GOFLAGS=-mod=vendor GOTOOLCHAIN=local \\
      go build -trimpath -ldflags='-s -w' -o golangci-lint.wasm \\
      github.com/golangci/golangci-lint/v2/cmd/golangci-lint

The playground serves the result gzip-compressed as golangci-lint.wasm.bin,
together with Go's lib/wasm/wasm_exec.js.
EOF_README

# The three builds below are independent, so they run in parallel.
# Each one logs to its own file, which is printed when it finishes.

build_wasm() {
  (cd "$SRC" && GOOS=js GOARCH=wasm GOFLAGS=-mod=vendor GOPROXY=off go build -trimpath -ldflags='-s -w' \
    -o "$WORK/golangci-lint.wasm" github.com/golangci/golangci-lint/v2/cmd/golangci-lint)
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

echo "==> Writing licenses.txt and the source archive"
cat > "$WORK/notices-header.txt" <<EOF_HEADER
golangci-lint $VERSION for js/wasm: licenses and notices
=========================================================

golangci-lint.wasm.bin in this directory is golangci-lint $VERSION compiled to
WebAssembly (GOOS=js GOARCH=wasm) with $(go env GOVERSION), as served by the
golangci-lint playground ($REPO_URL).

golangci-lint is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License version 3 (see the license text of
github.com/golangci/golangci-lint/v2 below). The binary includes the modules
listed under COMPONENTS, each under its own license; their license, NOTICE and
PATENTS files follow.

Modification: golang.org/x/tools is patched (last changed ${PATCH_DATE:-unknown}) so that it
works in a browser. golangci-lint itself is not modified.

Corresponding source: golangci-lint-source.tar.gz in this directory contains
the complete source code the binary is built from (all modules vendored, the
patched golang.org/x/tools included) and instructions to build it. The build
scripts are also in $REPO_URL (wasm/).
EOF_HEADER
go run ./tools/mknotices -src "$SRC" -out "$OUT/licenses.txt" -header "$WORK/notices-header.txt"
cp "$OUT/licenses.txt" "$SRC/licenses.txt"
# A reproducible archive: same content, same bytes (GNU tar; others fall back to a plain archive).
TAR_OPTS=()
if tar --sort=name -cf /dev/null -T /dev/null 2>/dev/null; then
  TAR_OPTS=(--sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --format=gnu)
fi
tar "${TAR_OPTS[@]}" -cf - -C "$WORK" "$SRC_NAME" | gzip -9 -n > "$OUT/golangci-lint-source.tar.gz"

chmod u+w "$OUT"/*
ls -l "$OUT"
