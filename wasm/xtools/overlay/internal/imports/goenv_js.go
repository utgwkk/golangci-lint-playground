//go:build js && wasm

// This file is copied into golang.org/x/tools/internal/imports by wasm/build.sh.
//
// goimports normally runs `go env` to learn about the build environment, which
// is impossible on js/wasm. The playground only supports the standard library,
// so GOPATH mode (GO111MODULE=off) is enough: missing imports are resolved by
// scanning $GOROOT/src, without invoking the go command.

package imports

import (
	"os"
	"path/filepath"
)

func init() {
	inprocGoEnv = func() map[string]string {
		gopath := os.Getenv("GOPATH")
		if gopath == "" {
			gopath = filepath.Join(os.Getenv("HOME"), "go")
		}
		return map[string]string{
			"GO111MODULE": "off",
			"GOFLAGS":     "",
			"GOINSECURE":  "",
			"GOMOD":       "",
			"GOMODCACHE":  filepath.Join(gopath, "pkg", "mod"),
			"GONOPROXY":   "",
			"GONOSUMDB":   "",
			"GOPATH":      gopath,
			"GOPROXY":     "off",
			"GOROOT":      os.Getenv("GOROOT"),
			"GOSUMDB":     "off",
			"GOWORK":      "off",
		}
	}
}
