// Command mkbundle packs the parts of the standard library that the wasm
// build of golangci-lint needs into a single gzip-compressed bundle:
//
//	/goroot/src/...         Go source files of std packages (linux/amd64, CGO_ENABLED=0)
//	/stdexport/<path>.a     export data (only the __.PKGDEF archive member)
//	/stdmanifest.json       package graph read by the in-process go/packages driver
//
// It also writes a warmup program that imports every public std package,
// which scripts/seed-cache.mjs uses to pre-populate the golangci-lint cache.
//
// Bundle format (after gzip): "GLPB1\n", then for each file
// uint32le(len(path)) path uint32le(len(data)) data.
package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

const (
	vGOROOT    = "/goroot"
	vExportDir = "/stdexport"
	vManifest  = "/stdmanifest.json"
)

type listedPackage struct {
	ImportPath string
	Name       string
	Dir        string
	GoFiles    []string
	Imports    []string
	ImportMap  map[string]string
	Export     string
}

type manifestPackage struct {
	Name    string            `json:"name"`
	Dir     string            `json:"dir"`
	GoFiles []string          `json:"goFiles"`
	Imports map[string]string `json:"imports"`
	Export  bool              `json:"export"`
}

func main() {
	out := flag.String("out", "std.bundle.gz", "output bundle path")
	warmup := flag.String("warmup", "", "directory to write the warmup program to (optional)")
	flag.Parse()
	log.SetFlags(0)

	goroot := goEnv("GOROOT")
	pkgs := listStd()

	f, err := os.Create(*out)
	check(err)
	zw, _ := gzip.NewWriterLevel(f, gzip.BestCompression)
	bw := bufio.NewWriter(zw)
	_, err = bw.WriteString("GLPB1\n")
	check(err)
	var nfiles, nbytes int
	put := func(name string, data []byte) {
		var hdr [4]byte
		binary.LittleEndian.PutUint32(hdr[:], uint32(len(name)))
		bw.Write(hdr[:])
		bw.WriteString(name)
		binary.LittleEndian.PutUint32(hdr[:], uint32(len(data)))
		bw.Write(hdr[:])
		_, err := bw.Write(data)
		check(err)
		nfiles++
		nbytes += len(data)
	}

	manifest := map[string]manifestPackage{}
	for _, p := range pkgs {
		rel, err := filepath.Rel(filepath.Join(goroot, "src"), p.Dir)
		check(err)
		vdir := path.Join(vGOROOT, "src", filepath.ToSlash(rel))
		mp := manifestPackage{Name: p.Name, Dir: vdir, GoFiles: p.GoFiles, Imports: map[string]string{}}
		inv := map[string]string{}
		for src, resolved := range p.ImportMap {
			inv[resolved] = src
		}
		for _, resolved := range p.Imports {
			src := resolved
			if s, ok := inv[resolved]; ok {
				src = s
			}
			mp.Imports[src] = resolved
		}
		for _, name := range p.GoFiles {
			data, err := os.ReadFile(filepath.Join(p.Dir, name))
			check(err)
			put(path.Join(vdir, name), data)
		}
		if p.Export != "" {
			put(path.Join(vExportDir, p.ImportPath+".a"), pkgdef(p.Export))
			mp.Export = true
		}
		manifest[p.ImportPath] = mp
	}
	mj, err := json.Marshal(manifest)
	check(err)
	put(vManifest, mj)
	if v, err := os.ReadFile(filepath.Join(goroot, "VERSION")); err == nil {
		put(path.Join(vGOROOT, "VERSION"), v)
	}

	check(bw.Flush())
	check(zw.Close())
	check(f.Close())
	st, _ := os.Stat(*out)
	log.Printf("mkbundle: %d packages, %d files, %.1f MB raw -> %s (%.1f MB)",
		len(pkgs), nfiles, float64(nbytes)/1e6, *out, float64(st.Size())/1e6)

	if *warmup != "" {
		writeWarmup(*warmup, pkgs)
	}
}

func listStd() []listedPackage {
	cmd := exec.Command("go", "list", "-export", "-json=ImportPath,Name,Dir,GoFiles,Imports,ImportMap,Export", "std")
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0", "GOOS=linux", "GOARCH=amd64")
	cmd.Stderr = os.Stderr
	stdout, err := cmd.StdoutPipe()
	check(err)
	check(cmd.Start())
	var pkgs []listedPackage
	dec := json.NewDecoder(stdout)
	for {
		var p listedPackage
		if err := dec.Decode(&p); errors.Is(err, io.EOF) {
			break
		} else {
			check(err)
		}
		pkgs = append(pkgs, p)
	}
	check(cmd.Wait())
	return pkgs
}

// pkgdef returns the archive truncated after its first member (__.PKGDEF),
// which holds the export data. The rest is object code we don't need.
func pkgdef(archive string) []byte {
	b, err := os.ReadFile(archive)
	check(err)
	if !bytes.HasPrefix(b, []byte("!<arch>\n")) || len(b) < 68 {
		log.Fatalf("%s: not an archive", archive)
	}
	hdr := b[8:68]
	if name := strings.TrimSpace(string(hdr[0:16])); name != "__.PKGDEF" {
		log.Fatalf("%s: first member is %q, want __.PKGDEF", archive, name)
	}
	size, err := strconv.Atoi(strings.TrimSpace(string(hdr[48:58])))
	check(err)
	end := 68 + size + size%2
	return b[:end]
}

func writeWarmup(dir string, pkgs []listedPackage) {
	var imports []string
	for _, p := range pkgs {
		ip := p.ImportPath
		if p.Name == "main" || strings.HasPrefix(ip, "vendor/") || strings.HasPrefix(ip, "cmd/") ||
			ip == "internal" || strings.HasPrefix(ip, "internal/") || strings.Contains(ip, "/internal/") ||
			strings.HasSuffix(ip, "/internal") || len(p.GoFiles) == 0 {
			continue
		}
		imports = append(imports, ip)
	}
	sort.Strings(imports)
	var src strings.Builder
	src.WriteString("// Code generated by mkbundle. DO NOT EDIT.\n\npackage main\n\nimport (\n")
	for _, ip := range imports {
		fmt.Fprintf(&src, "\t_ %q\n", ip)
	}
	src.WriteString(")\n\nfunc main() {}\n")
	check(os.MkdirAll(dir, 0o755))
	check(os.WriteFile(filepath.Join(dir, "main.go"), []byte(src.String()), 0o644))
	check(os.WriteFile(filepath.Join(dir, "go.mod"), []byte("module warmup\n\ngo 1.24\n"), 0o644))
	log.Printf("mkbundle: warmup program importing %d std packages -> %s", len(imports), dir)
}

func goEnv(key string) string {
	out, err := exec.Command("go", "env", key).Output()
	check(err)
	return strings.TrimSpace(string(out))
}

func check(err error) {
	if err != nil {
		log.Fatal(err)
	}
}
