export const DEFAULT_CODE = `package main

import (
	"fmt"
	"net/http"
	"os"
)

func main() {
	f, _ := os.Open("config.txt")
	defer f.Close()

	count := 1
	count = 2
	_ = count

	fmt.Printf("%d\\n", "hello")

	resp, err := http.Get("https://example.com")
	if err != nil {
		return
	}
	fmt.Println(resp.Status)
}
`;

export const DEFAULT_CONFIG = `version: "2"
linters:
  default: standard
  enable:
    - bodyclose
    - misspell
formatters:
  enable:
    - gofmt
`;
