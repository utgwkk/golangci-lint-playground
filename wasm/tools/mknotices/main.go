// Command mknotices writes the license notices of the js/wasm build of
// golangci-lint: a summary of every module linked into the binary with its
// license, followed by the license, NOTICE and PATENTS files of the modules
// and of Go itself (runtime, standard library and wasm_exec.js).
//
// It reads the vendored source tree that the binary is built from (see
// wasm/build.sh), so the notices always match the shipped binary.
//
// Every license must be one this tool recognizes, all of which are compatible
// with the GPL-3.0 of golangci-lint. A module with an unrecognized or missing
// license fails the build, so that a golangci-lint upgrade cannot silently add
// a dependency whose license has not been reviewed.
package main

import (
	"bytes"
	"crypto/sha256"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Licenses known to be compatible with GPL-3.0 (golangci-lint's license).
var allowed = map[string]bool{
	"MIT": true, "ISC": true, "BSD-2-Clause": true, "BSD-3-Clause": true,
	"Apache-2.0": true, "MPL-2.0": true, "GPL-3.0": true, "Unlicense": true,
}

var noticeFile = regexp.MustCompile(`(?i)^(licen[cs]e|copying|unlicense|notice|patents)([-._].*)?$`)

type module struct {
	path, version string
	files         []string // license-like files, relative to the vendor directory
	licenses      []string // SPDX identifiers found in the files
}

func main() {
	src := flag.String("src", "", "vendored module that the binary is built from")
	pkg := flag.String("pkg", "github.com/golangci/golangci-lint/v2/cmd/golangci-lint", "main package")
	out := flag.String("out", "", "output file")
	header := flag.String("header", "", "file with text to put before the summary")
	flag.Parse()
	if *src == "" || *out == "" {
		log.Fatal("usage: mknotices -src <dir> -out <file> [-header <file>]")
	}

	env := append(os.Environ(), "GOOS=js", "GOARCH=wasm", "GOFLAGS=-mod=vendor", "GOPROXY=off")
	listed := run(*src, env, "go", "list", "-deps", "-f", "{{with .Module}}{{if not .Main}}{{.Path}} {{.Version}}{{end}}{{end}}", *pkg)
	goroot := strings.TrimSpace(run(*src, env, "go", "env", "GOROOT"))
	goversion := strings.TrimSpace(run(*src, env, "go", "env", "GOVERSION"))

	vendor := filepath.Join(*src, "vendor")
	vendored := vendoredModules(filepath.Join(vendor, "modules.txt"))

	seen := map[string]bool{}
	var mods []*module
	for _, line := range strings.Split(listed, "\n") {
		f := strings.Fields(line)
		if len(f) == 0 || seen[f[0]] {
			continue
		}
		seen[f[0]] = true
		m := &module{path: f[0]}
		if len(f) > 1 {
			m.version = f[1]
		}
		mods = append(mods, m)
	}
	sort.Slice(mods, func(i, j int) bool { return mods[i].path < mods[j].path })

	var problems []string
	for _, m := range mods {
		m.files = licenseFiles(vendor, m.path, vendored)
		for _, f := range m.files {
			if isLicense(f) {
				m.licenses = append(m.licenses, classify(read(filepath.Join(vendor, f)))...)
			}
		}
		m.licenses = uniq(m.licenses)
		if len(m.licenses) == 0 {
			problems = append(problems, fmt.Sprintf("%s %s: no recognized license (files: %v)", m.path, m.version, m.files))
		}
		for _, l := range m.licenses {
			if !allowed[l] {
				problems = append(problems, fmt.Sprintf("%s %s: license %s is not known to be compatible with GPL-3.0", m.path, m.version, l))
			}
		}
	}
	if len(problems) > 0 {
		log.Fatalf("review these licenses, then update wasm/tools/mknotices if they are fine:\n  %s", strings.Join(problems, "\n  "))
	}

	var b bytes.Buffer
	if *header != "" {
		b.WriteString(read(*header))
		b.WriteString("\n")
	}
	fmt.Fprintf(&b, "COMPONENTS\n==========\n\n")
	fmt.Fprintf(&b, "%-70s %-40s %s\n", "Go (runtime, standard library, wasm_exec.js)", goversion, "BSD-3-Clause")
	for _, m := range mods {
		fmt.Fprintf(&b, "%-70s %-40s %s\n", m.path, m.version, strings.Join(m.licenses, ", "))
	}

	// License texts, each distinct text once with the components using it.
	type text struct {
		body  string
		users []string
	}
	var order []string
	texts := map[string]*text{}
	add := func(user, name, body string) {
		key := fmt.Sprintf("%x", sha256.Sum256([]byte(name+"\x00"+body)))
		if texts[key] == nil {
			texts[key] = &text{body: body}
			order = append(order, key)
		}
		texts[key].users = append(texts[key].users, user+" ("+name+")")
	}
	for _, name := range []string{"LICENSE", "PATENTS"} {
		add("Go "+goversion, name, read(filepath.Join(goroot, name)))
	}
	for _, m := range mods {
		for _, f := range m.files {
			rel, _ := filepath.Rel(filepath.FromSlash(m.path), f)
			add(m.path+" "+m.version, filepath.ToSlash(rel), read(filepath.Join(vendor, f)))
		}
	}
	fmt.Fprintf(&b, "\n\nLICENSES AND NOTICES\n====================\n")
	for _, key := range order {
		t := texts[key]
		fmt.Fprintf(&b, "\n%s\n%s\n\n%s\n", strings.Repeat("-", 78), strings.Join(t.users, "\n"), strings.TrimRight(t.body, "\n"))
	}
	if err := os.WriteFile(*out, b.Bytes(), 0o644); err != nil {
		log.Fatal(err)
	}
	log.Printf("%s: %d modules", *out, len(mods))
}

func run(dir string, env []string, name string, args ...string) string {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	cmd.Env = env
	cmd.Stderr = os.Stderr
	out, err := cmd.Output()
	if err != nil {
		log.Fatalf("%s %v: %v", name, args, err)
	}
	return string(out)
}

func read(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		log.Fatal(err)
	}
	return string(b)
}

func uniq(s []string) []string {
	sort.Strings(s)
	out := s[:0]
	for i, v := range s {
		if i == 0 || v != s[i-1] {
			out = append(out, v)
		}
	}
	return out
}

// vendoredModules returns the paths of all modules in vendor/modules.txt.
func vendoredModules(modulesTxt string) map[string]bool {
	out := map[string]bool{}
	for _, line := range strings.Split(read(modulesTxt), "\n") {
		if f := strings.Fields(line); len(f) >= 2 && f[0] == "#" {
			out[f[1]] = true
		}
	}
	return out
}

func isLicense(path string) bool {
	base := strings.ToLower(filepath.Base(path))
	return !strings.HasPrefix(base, "notice") && !strings.HasPrefix(base, "patents")
}

// licenseFiles finds the license-like files of a module in the vendor tree:
// those in the module's root directory or, if there are none, the closest
// ones below it (e.g. a fork that keeps the original LICENSE next to the
// forked code). Directories of other vendored modules nested below are skipped.
func licenseFiles(vendor, modPath string, vendored map[string]bool) []string {
	root := filepath.Join(vendor, filepath.FromSlash(modPath))
	var found []string
	depth := -1
	filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(vendor, p)
		if d.IsDir() {
			if p != root && vendored[filepath.ToSlash(rel)] {
				return filepath.SkipDir
			}
			return nil
		}
		if !noticeFile.MatchString(d.Name()) {
			return nil
		}
		dd := strings.Count(rel, string(filepath.Separator))
		if depth == -1 || dd < depth {
			depth, found = dd, nil
		}
		if dd == depth {
			found = append(found, rel)
		}
		return nil
	})
	sort.Strings(found)
	// Only the files at the shallowest level that has a license file count.
	if !hasLicense(found) {
		return nil
	}
	return found
}

func hasLicense(files []string) bool {
	for _, f := range files {
		if isLicense(f) {
			return true
		}
	}
	return false
}

// classify returns the SPDX identifiers of the licenses in a license file.
// A file that only refers to other files (e.g. "dual-licensed under the
// Unlicense and MIT licenses") returns nothing.
func classify(text string) []string {
	t := strings.ToLower(strings.Join(strings.Fields(text), " "))
	head := t
	if len(head) > 300 {
		head = head[:300]
	}
	switch {
	case strings.Contains(head, "gnu lesser general public license"),
		strings.Contains(head, "gnu affero general public license"):
		return []string{"LGPL/AGPL (review)"}
	case strings.Contains(head, "gnu general public license") && strings.Contains(head, "version 3, 29 june 2007"):
		return []string{"GPL-3.0"}
	case strings.Contains(head, "gnu general public license"):
		return []string{"GPL (other than version 3; review)"}
	case strings.Contains(head, "mozilla public license") && strings.Contains(head, "2.0"):
		return []string{"MPL-2.0"}
	}
	var ids []string
	if strings.Contains(t, "apache license") && strings.Contains(t, "version 2.0") {
		ids = append(ids, "Apache-2.0")
	}
	if strings.Contains(t, "permission is hereby granted, free of charge") {
		ids = append(ids, "MIT")
	}
	if strings.Contains(t, "permission to use, copy, modify, and/or distribute this software for any purpose") ||
		strings.Contains(t, "permission to use, copy, modify, and distribute this software for any purpose") {
		ids = append(ids, "ISC")
	}
	if strings.Contains(t, "this is free and unencumbered software released into the public domain") {
		ids = append(ids, "Unlicense")
	}
	if strings.Contains(t, "redistribution and use in source and binary forms") {
		if strings.Contains(t, "neither the name") || strings.Contains(t, "names of its contributors") ||
			strings.Contains(t, "name of the copyright holder") || strings.Contains(t, "names of the copyright holders") {
			ids = append(ids, "BSD-3-Clause")
		} else {
			ids = append(ids, "BSD-2-Clause")
		}
	}
	return ids
}
