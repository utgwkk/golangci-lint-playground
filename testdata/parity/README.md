# Parity test cases

Each `*.txtar` file here, and each sample in `web/examples/`, is linted by both
the native golangci-lint and the js/wasm build (via `npm run parity` in `web/`).
The normalized issues must be identical.

A file without a `go.mod` gets the playground's default one. A `.golangci.yml`
file in the archive is used as the configuration.
