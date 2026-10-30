# Primitive actions

Each directory exposes one operation as a GitHub Action. The metadata in `action.yml` is its public API. The JavaScript exports are internal implementation details shared with Buildspace's recipes.

Primitives do not check out repositories, install dependencies or toolchains, build unrelated artifacts, select channels, generate credentials, or approve releases. GitHub's existing setup, checkout, artifact, and attestation actions remain separate primitives; Buildspace does not wrap them in another setup framework.

## Runtime and compatibility

These actions use the runner's Node 24 runtime. They do not install Node or change `PATH`. Build tools must already be on `PATH`. Shell commands require Bash. Paths are relative to the job's current working directory unless the input says otherwise.

Use `photon-hq/buildspace/.github/primitives/<name>@<full-commit-sha>`. Within Buildspace, `$/` references keep a workflow, recipe, and its nested actions on one revision without reading action code from the caller's checkout. GitHub.com supports these references, including inside reusable workflows and composite actions. GitHub Enterprise Server does not support `$/`.

Keep existing input names, defaults, output names, and side effects compatible. Add an optional input only when its default preserves existing behavior. Ship an incompatible contract under a new action path or a new major release ref. Do not change an immutable SHA. Internal module signatures can change together with their recipes because they resolve from the same revision.

All inputs and outputs are strings. Boolean inputs enable behavior only for the exact value `'true'`. Missing files, failed tools, and invalid tool output fail the action. Primitives do not retry writes, choose fallback credentials, or continue after a failed publication.

## Build operations

### `cargo-build`

Requires Cargo and the requested Rust target. Compiles one binary in release mode. It neither installs system libraries nor writes an `.env` file.

| Input | Default | Meaning |
|-------|---------|---------|
| `binary` | Required | Cargo binary target |
| `package` | `''` | Workspace package; empty uses Cargo's default selection |
| `target` | `''` | Target triple; empty leaves the target selection to Cargo |
| `working-directory` | `.` | Cargo invocation directory |

Output `binary-path` is the absolute compiled binary path. The Windows extension follows the target, not the runner's operating system. Use `stage-file` only when a separate artifact copy is wanted.

### `go-build`

Requires Go and Bash. Builds the package at `working-directory` with `CGO_ENABLED=0`. It does not install Go or stage the binary.

| Input | Default | Meaning |
|-------|---------|---------|
| `output` | Required | Output file, relative to `working-directory`; include `.exe` for Windows |
| `goos` | Required | Target operating system |
| `goarch` | Required | Target architecture |
| `build-flags` | `''` | Trusted shell fragment containing additional build flags |
| `ldflags` | `-s -w` | Linker flags, passed as one literal argument |
| `working-directory` | `.` | Package directory |

Output `binary-path` is absolute. `build-flags` is executable caller configuration, not untrusted event data.

### `swift-build`

Requires Swift and any dependency authentication already configured by the caller. Input `product` is required; `working-directory` defaults to `.`. Compiles only that executable product in release mode and asks Swift for its output directory. Output `binary-path` is absolute. Signing, environment files, caching, resource collection, and staging remain separate steps.

## File and installer operations

### `stage-file`

Requires `source` and `destination` file paths. Creates the destination's parent directories and copies the file, replacing an existing destination. `executable` defaults to `'false'`; `'true'` adds executable bits to the destination. The source is unchanged. Outputs are `name`, the destination filename, and `path`, exactly the supplied destination. This action does not upload anything.

### `pkgbuild`

Requires macOS's `pkgbuild` and a prepared payload directory. Creates one unsigned installer. It does not copy a binary into the payload, collect resources, compile, sign, or install anything.

| Input | Default | Meaning |
|-------|---------|---------|
| `root` | Required | Prepared payload root |
| `identifier` | Required | Installer identifier |
| `version` | Required | Installer version |
| `output` | Required | Output `.pkg` file |
| `install-location` | `/` | Installation location |
| `scripts` | `''` | Optional installer scripts directory |

Output `package-path` is exactly the supplied output path. A payload-only installer and a compiled Swift installer use the same operation.

## Registry operations

### `npm-package-info`

Reads `package.json` from `working-directory`, which defaults to `.`. Outputs `name` and `version`. Fails if either field is missing or empty. Does not install, execute package scripts, or contact a registry.

### `npm-publish`

Requires Bash and the publisher selected by `command`. Publishes one prepared package. Does not install dependencies, build, read package identity, verify remote visibility, or choose credentials.

| Input | Default | Meaning |
|-------|---------|---------|
| `registry` | Required | npm-compatible registry URL |
| `working-directory` | `.` | Prepared package directory |
| `tag` | `latest` | Distribution tag |
| `access` | `''` | Optional package access |
| `dry-run` | `'false'` | Validate without registry writes |
| `provenance` | `'false'` | Append `--provenance` |
| `command` | `npm publish` | Trusted shell command |

The action appends registry, tag, access, and boolean flags as literal arguments. Configure authentication separately, for example with `actions/setup-node` and step-scoped `NODE_AUTH_TOKEN`, or npm trusted publishing and `id-token: write`. A token in `NODE_AUTH_TOKEN` alone does not configure npm's registry auth mapping.

Output `exit-code` records the publisher's exit code, including when the action fails. A nonzero publisher exit fails the action. A zero exit accompanied by an `npm error` or `npm ERR!` line also fails: the wrapper swallowed an error. The compatibility npm recipe uses this distinction to allow a token fallback only after an actual OIDC command failure. A swallowed error remains fatal. A process launch failure might produce no `exit-code`.

### `wait-npm-version`

Requires npm, Bash, and read authentication configured for the registry, if needed. Bash resolves npm's launcher on both Unix and Windows; package names and flags remain literal arguments. Required inputs are `package`, `version`, and `registry`. `attempts` defaults to `6`; `interval-seconds` defaults to `5`. Reads the exact package version until it is visible, then outputs `version`. Fails after the last unsuccessful read. Does not publish or move distribution tags. Call it separately when publication must be verified.

### `cargo-publish`

Requires Cargo and registry authentication configured by the caller. `working-directory` defaults to `.`, and `package` defaults to `''` for Cargo's default selection. `dry-run` and `allow-dirty` both default to `'false'`. Executes one `cargo publish` attempt without installing Rust, retrying, or sleeping. The compatibility crates.io recipe retains dependency order, its existing retry policy, and index propagation delays.

## Composition boundaries

The existing build and publication blocks are recipes, not promises of atomic behavior. They keep their inputs and output names for current callers while composing these operations:

- Rust and Go recipes combine toolchain setup, compilation, and `stage-file`.
- The Swift build recipe retains checkout, caching, environment setup, and authentication. It compiles through `swift-build`, then signs and collects artifacts separately.
- The Swift installer recipe prepares the payload, invokes `pkgbuild`, then stages the installer. It also supports payload-only packages.
- The Makefile recipe still invokes the caller's `make release` target, then uses `stage-file`.
- Single-package registry recipes retain setup, install/build order, registry scope policy, and OIDC/token selection. They compose package identity, publication, and visibility reads.
- Monorepo registry recipes call the same internal operations for each package. They build, publish, and verify a dependency before proceeding to its dependent. A root build still suppresses per-package builds. npm monorepo publication now verifies each exact version and rejects swallowed npm errors, matching the single-package path.
- The crates.io recipe retains ordered publications and retries around the single-attempt `cargo-publish` operation.

The existing `package-stage`, `package-promote`, `swift-stage`, `swift-promote`, and image workflows retain their stronger artifact, attestation, and approval checks. Do not replace a verified promotion with a raw publishing primitive. Use custom compositions only when the caller owns those checks and credential boundaries.

`primitives-smoke.yml` runs real Rust/Go builds and npm dry runs on Linux, macOS, and Windows, plus a macOS Swift-to-installer composition. A local registry fixture verifies reads through each runner's real npm launcher without external registry access. The offline tests exercise command arguments, output contracts, dependency order, and publisher failure behavior without registry writes.
