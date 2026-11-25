//go:build tools

// Package tools pins the golangci-lint version built to js/wasm by build.sh.
package tools

import _ "github.com/golangci/golangci-lint/v2/cmd/golangci-lint"
