# Buildspace

Reusable GitHub Action blocks and templates for developers :)

## Usage

### Reusable Blocks

Individual actions for custom workflows:

```yaml
# Check PR labels
- uses: photon-hq/buildspace/.github/actions/check-pr-label@main

# AI version + release notes
- uses: photon-hq/buildspace/.github/actions/generate-release-info@main
  with:
    service-name: my-service
    openai-api-key: ${{ secrets.OPENAI_API_KEY }}

# Build Rust binary
- uses: photon-hq/buildspace/.github/actions/rust-build@main
  with:
    binary-name: my-binary
    target: x86_64-unknown-linux-gnu

# Create GitHub release
- uses: photon-hq/buildspace/.github/actions/create-github-release@main
  with:
    version: "1.0.0"
    title: "v1.0.0"

# Publish to crates.io
- uses: photon-hq/buildspace/.github/actions/publish-crates@main
  with:
    crate-name: my-crate
    cargo-registry-token: ${{ secrets.CARGO_REGISTRY_TOKEN }}

# Publish to npm
- uses: photon-hq/buildspace/.github/actions/publish-npm@main
  with:
    npm-token: ${{ secrets.NPM_TOKEN }}
```

### Rust Releases

```yaml
jobs:
  release:
    uses: photon-hq/buildspace/.github/workflows/rust-service-release.yaml@main
    permissions:
      contents: write
      pull-requests: read
    with:
      service-name: enva
      binary-name: enva
      binary-path: crates/client
    secrets:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      CARGO_REGISTRY_TOKEN: ${{ secrets.CARGO_REGISTRY_TOKEN }}
```

### TypeScript Releases 

```yaml
jobs:
  release:
    uses: photon-hq/buildspace/.github/workflows/typescript-service-release.yaml@main
    permissions:
      contents: write
      pull-requests: read
    with:
      service-name: my-package
    secrets:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

## PR Labels

| Label | Effect |
|-------|--------|
| `github-release` | Create GitHub release |
| `crates-release` | Publish to crates.io |
| `npm-release` | Publish to npm |
| `prerelease` | Mark as prerelease (`-rc.N`) |

## Optional Inputs

**Both workflows:**
- `dry-run` — test without publishing
- `prerelease` — force prerelease
- `github-release` — force GitHub release

**Rust only:**
- `binary-path` — path to crate directory
- `build-env` — compile-time env vars (e.g., `"BASE_URL=https://..."`)
- `crates-release` — force crates.io publish

**TypeScript only:**
- `bun-version` — Bun version (default: `latest`)
- `npm-tag` — npm tag (default: `latest`)
- `npm-release` — force npm publish
- `working-directory` — package directory (default: `.`)
- `build-command` — build command (default: `bun run build`)

## Structure

```
.github/
├── actions/
│   ├── check-pr-label/
│   ├── create-github-release/
│   ├── generate-release-info/
│   ├── publish-crates/
│   ├── publish-npm/
│   └── rust-build/
└── workflows/
    ├── rust-service-release.yaml
    └── typescript-service-release.yaml
```
