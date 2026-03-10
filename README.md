# BuildSpace

[![GitHub Actions](https://img.shields.io/badge/GitHub%20Actions-2088FF?logo=github-actions&logoColor=white)](https://github.com/features/actions)
[![Rust](https://img.shields.io/badge/Rust-000000?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![NPM](https://img.shields.io/badge/NPM-CB3837?logo=npm&logoColor=white)](https://www.npmjs.com/)
[![Crates.io](https://img.shields.io/badge/Crates.io-FFC832?logo=rust&logoColor=black)](https://crates.io/)

**Reusable GitHub Actions blocks and workflows for fast shipping teams**

BuildSpace packages battle-tested, AI-powered CI/CD building blocks, like generating release notes, bumping versions, publishing, plus ready-made workflows built from those blocks, so teams can either compose custom automations or plug in the prebuilt recipes with only a few inputs.

---

## 📖 Table of Contents

- [Quick Start](#-quick-start)
- [Workflows](#-workflows)
  - [Rust Service Release](#rust-service-release)
  - [TypeScript Service Release](#typescript-service-release)
  - [TypeScript Monorepo Release](#typescript-monorepo-release)
  - [Swift Package PR Build](#swift-package-pr-build)
- [Actions](#-actions)
  - [check-pr-label](#check-pr-label)
  - [generate-release-info](#generate-release-info)
  - [determine-publish-version](#determine-publish-version)
  - [create-github-release](#create-github-release)
  - [detect-changed-packages](#detect-changed-packages)
  - [bump-monorepo-versions](#bump-monorepo-versions)
  - [publish-npm-packages](#publish-npm-packages)
  - [rust-build](#rust-build)
  - [typescript-build](#typescript-build)
  - [sync-crates-version](#sync-crates-version)
  - [publish-crates](#publish-crates)
  - [publish-npm](#publish-npm)
  - [comment-on-pr](#comment-on-pr)
- [PR Labels](#-pr-labels)
- [Architecture](#-architecture)
- [Contributing](#-contributing)
- [License](#-license)

---

## 🚀 Quick Start

### Rust Project

Create `.github/workflows/release.yaml`:

```yaml
name: Release

on:
  push:
    branches: [main]

jobs:
  release:
    uses: photon-hq/buildspace/.github/workflows/rust-service-release.yaml@main
    permissions:
      contents: write
      pull-requests: read
  with:
    service-name: my-service
    binary-name: my-binary
      # Order matters: dependencies first
      crates: '["crates/shared", "crates/client"]'
    secrets:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      CARGO_REGISTRY_TOKEN: ${{ secrets.CARGO_REGISTRY_TOKEN }}
```

### TypeScript Project

Create `.github/workflows/release.yaml
```yaml
name: Release

on:
  push:
    branches: [main]

jobs:
  release:
    uses: photon-hq/buildspace/.github/workflows/typescript-service-release.yaml@main
    permissions:
      contents: write
      pull-requests: read
  with:
      service-name: my-package
      build-command: "npm run build"
    secrets:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### TypeScript Monorepo

Create `.github/workflows/release.yaml`:

```yaml
name: Release

on:
  push:
    branches: [main]

jobs:
  release:
    uses: photon-hq/buildspace/.github/workflows/typescript-monorepo-release.yaml@main
    permissions:
      contents: write
      pull-requests: read
    with:
      service-name: photon-ts
      packages: '[{"name":"photon","path":"packages/photon"},{"name":"@photon/openai-compatible","path":"packages/openai-compatible"}]'
      root-build-command: "turbo build"
    secrets:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Then just add a `release` label to your PR, merge, and watch the magic happen! ✨

---

## 📋 Workflows

### Rust Service Release

**File:** `.github/workflows/rust-service-release.yaml`

A complete release pipeline for Rust services that:
1. Checks PR labels for release triggers
2. Generates version and release notes using AI
3. Builds binaries for Linux (x86_64), macOS (ARM64), and Windows
4. Syncs version across all workspace crates
5. Publishes to crates.io
6. Creates a GitHub Release with attached binaries

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `service-name` | string | ✅ | — | Display name for the service (used in release title) |
| `binary-name` | string | ✅ | — | Name of the binary from `Cargo.toml` |
| `binary-path` | string | ❌ | `""` | Path to crate directory (e.g., `crates/client`) |
| `crates` | string | ❌ | `[]` | JSON array of crate paths to publish in dependency order |
| `build-env` | string | ❌ | `""` | Compile-time env vars (e.g., `BASE_URL=https://...`) |
| `labels-to-check` | string | ❌ | `["release", "prerelease"]` | PR labels that trigger releases |
| `prerelease` | boolean | ❌ | `false` | Force prerelease (adds `-rc.N` suffix) |
| `release` | boolean | ❌ | `false` | Force release (bypasses label check) |
| `dry-run` | boolean | ❌ | `false` | Test without actually publishing |

#### Secrets

| Secret | Required | Description |
|--------|----------|-------------|
| `OPENAI_API_KEY` | ✅ | OpenAI API key for AI-powered versioning and notes |
| `CARGO_REGISTRY_TOKEN` | ❌ | crates.io API token (required for publishing) |

#### Example with All Options

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
      crates: '["crates/shared", "crates/client"]'
      build-env: "API_URL=https://api.example.com"
      prerelease: false
      dry-run: false
    secrets:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      CARGO_REGISTRY_TOKEN: ${{ secrets.CARGO_REGISTRY_TOKEN }}
```

---

### TypeScript Service Release

**File:** `.github/workflows/typescript-service-release.yaml`

A complete release pipeline for TypeScript/JavaScript packages that:
1. Checks PR labels for release triggers
2. Generates version and release notes using AI
3. Bumps `package.json` version and commits
4. Creates a GitHub Release
5. Publishes to npm

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `service-name` | string | ✅ | — | Display name for the service |
| `bun-version` | string | ❌ | `latest` | Bun version to use |
| `npm-tag` | string | ❌ | `latest` | npm tag (e.g., `latest`, `beta`, `next`) |
| `no-npm-publish` | boolean | ❌ | `false` | Skip npm publishing (GitHub Release only) |
| `working-directory` | string | ❌ | `.` | Directory containing `package.json` |
| `build-command` | string | ❌ | `bun run build` | Build command to run |
| `labels-to-check` | string | ❌ | `["release", "prerelease"]` | PR labels that trigger releases |
| `prerelease` | boolean | ❌ | `false` | Force prerelease (adds `-rc.N` suffix) |
| `release` | boolean | ❌ | `false` | Force release (bypasses label check) |
| `dry-run` | boolean | ❌ | `false` | Test without actually publishing |

#### Secrets

| Secret | Required | Description |
|--------|----------|-------------|
| `OPENAI_API_KEY` | ✅ | OpenAI API key for AI-powered versioning and notes |
| `NPM_TOKEN` | ❌ | npm authentication token (required for publishing) |

#### Example with All Options

```yaml
jobs:
  release:
    uses: photon-hq/buildspace/.github/workflows/typescript-service-release.yaml@main
    permissions:
      contents: write
      pull-requests: read
    with:
      service-name: notebooklm-kit
      bun-version: "1.1"
      npm-tag: latest
      working-directory: "."
      build-command: "npm run build"
      prerelease: false
      dry-run: false
    secrets:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

---

### TypeScript Monorepo Release

**File:** `.github/workflows/typescript-monorepo-release.yaml`

A complete release pipeline for TypeScript/JavaScript monorepos that:
1. Checks PR labels for release triggers
2. Detects which packages changed since the last release
3. Topologically sorts changed packages (dependencies before dependents)
4. Uses a single AI call to determine versions and generate combined release notes for all changed packages
5. Bumps each package's `package.json` and commits
6. Creates a single GitHub Release with a `release/YYYY-MM-DD.N` tag
7. Publishes all changed packages to npm in dependency order

Each package is independently versioned — no lockstep.

---

### Swift Package PR Build

**File:** `.github/workflows/swift-pkg-pr.yml`

Builds a macOS `.pkg` distribution package for every PR commit and reports status directly in the PR as a living comment (updated in place — not spammy). If a build is already running when a new commit is pushed, the old run is automatically cancelled.

#### How It Works

1. On every commit to a PR, posts a "⏳ Building…" comment (or updates the existing one)
2. Builds the Swift binary with `swift-build`
3. Creates a `.pkg` with `swift-pkg`, versioned as `pr.<PR#>.<run#>`
4. Uploads the `.pkg` as an Actions artifact (7-day retention)
5. Updates the PR comment to ✅ success (with artifact name + link) or ❌ failure (with log link)

Concurrent runs for the same PR are cancelled via `concurrency: cancel-in-progress: true`.

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `service-name` | string | ✅ | — | Display name for the monorepo (used in release title) |
| `packages` | string | ✅ | — | JSON array of packages: `[{"name":"pkg","path":"packages/pkg"}]` |
| `bun-version` | string | ❌ | `latest` | Bun version to use |
| `npm-tag` | string | ❌ | `latest` | npm tag (e.g., `latest`, `beta`, `next`) |
| `build-command` | string | ❌ | `bun run build` | Build command per package (ignored if `root-build-command` is set) |
| `root-build-command` | string | ❌ | `""` | Build command at repo root (e.g., `turbo build`) |
| `include-dependents` | boolean | ❌ | `false` | Also release downstream dependents of changed packages |
| `labels-to-check` | string | ❌ | `["release", "prerelease"]` | PR labels that trigger releases |
| `prerelease` | boolean | ❌ | `false` | Force prerelease (adds `-rc.N` suffix, publishes as `beta`) |
| `release` | boolean | ❌ | `false` | Force release (bypasses label check) |
| `dry-run` | boolean | ❌ | `false` | Test without actually publishing |

#### Secrets

| Secret | Required | Description |
|--------|----------|-------------|
| `OPENAI_API_KEY` | ✅ | OpenAI API key for AI-powered versioning and notes |
| `NPM_TOKEN` | ✅ | npm authentication token |
| `APP_ID` | ❌ | GitHub App ID (for protected branches) |
| `APP_PRIVATE_KEY` | ❌ | GitHub App private key (for protected branches) |

#### Example with All Options

```yaml
jobs:
  release:
    uses: photon-hq/buildspace/.github/workflows/typescript-monorepo-release.yaml@main
    permissions:
      contents: write
      pull-requests: read
    with:
      service-name: photon-ts
      packages: '[{"name":"photon","path":"packages/photon"},{"name":"@photon/openai-compatible","path":"packages/openai-compatible"},{"name":"create-photon","path":"packages/create-photon"}]'
      bun-version: "1.1"
      npm-tag: latest
      root-build-command: "turbo build"
      include-dependents: true
      prerelease: false
      dry-run: false
    secrets:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

#### How It Works

```
PR merged with "release" label
        │
        ▼
┌─────────────┐     ┌───────────────────┐     ┌─────────────────┐
│ Check Labels │────▶│ Detect Changed    │────▶│ Bump Versions   │
│              │     │ Packages (topo-   │     │ (single AI call │
│              │     │ sorted by deps)   │     │  for all pkgs)  │
└─────────────┘     └───────────────────┘     └────────┬────────┘
                                                       │
                                              ┌────────┴────────┐
                                              │                 │
                                              ▼                 ▼
                                     ┌──────────────┐  ┌─────────────┐
                                     │GitHub Release │  │ npm Publish │
                                     │(combined tag) │  │ (in order)  │
                                     └──────────────┘  └─────────────┘
```

---

### Swift Package PR Build (continued)

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `package-name` | string | ✅ | — | Name of the Swift binary / package |
| `identifier` | string | ✅ | — | Package identifier (e.g. `com.example.mytool`) |
| `scripts-path` | string | ❌ | `""` | Path to scripts directory with preinstall/postinstall scripts |

#### Secrets

| Secret | Required | Description |
|--------|----------|-------------|
| `DEVELOPER_ID_INSTALLER_NAME` | ✅ | Developer ID Installer certificate name |
| `SECRET_ENV_VARS` | ❌ | Compile-time env vars written to `.env` |

#### Example

```yaml
# .github/workflows/pr.yml  (in consuming repo)
name: PR

on:
  pull_request:

jobs:
  swift-pkg:
    uses: photon-hq/buildspace/.github/workflows/swift-pkg-pr.yml@main
    with:
      package-name: my-tool
      identifier: com.example.my-tool
    secrets:
      DEVELOPER_ID_INSTALLER_NAME: ${{ secrets.DEVELOPER_ID_INSTALLER_NAME }}
      SECRET_ENV_VARS: ${{ secrets.SECRET_ENV_VARS }}
```

---

## 🧩 Actions

Individual composite actions that can be used independently or combined into custom workflows.

---

### check-pr-label

**Path:** `.github/blocks/check-pr-label/action.yaml`

Checks PR labels and outputs boolean flags for release decisions. Works on both PR events and push events (looks up the merged PR).

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `labels` | string | ✅ | — | JSON array of labels to check (e.g., `["release", "prerelease"]`) |
| `default-on-push` | string | ❌ | `""` | Comma-separated labels to default to `true` on direct push |

#### Outputs

| Output | Type | Description |
|--------|------|-------------|
| `labels` | JSON | Object with boolean results for each label (e.g., `{"release": true, "prerelease": false}`) |

#### Usage

```yaml
- uses: photon-hq/buildspace/.github/blocks/check-pr-label@main
  id: labels
  with:
    labels: '["release", "prerelease"]'

- if: fromJSON(steps.labels.outputs.labels).release
  run: echo "Release label found!"
```

---

### generate-release-info

**Path:** `.github/blocks/generate-release-info/action.yaml`

Generates a semantic version number and AI-written release notes by analyzing commit history since the last release.

#### How It Works

1. Finds the last GitHub Release tag
2. Analyzes commits between last release and current SHA
3. Uses AI to determine version bump (major/minor/patch)
4. Generates human-readable release notes

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `service-name` | string | ✅ | — | Service name (used in release notes) |
| `prerelease` | boolean | ❌ | `false` | Append `-rc.N` suffix to version |
| `openai-api-key` | secret | ✅ | — | OpenAI API key |

#### Outputs

| Output | Type | Description |
|--------|------|-------------|
| `version` | string | Determined version (e.g., `1.2.3` or `1.2.3-rc.5`) |
| `release_notes` | string | AI-generated release notes in markdown |

#### Usage

```yaml
- uses: actions/checkout@v5
  with:
    fetch-depth: 0  # Required for commit history

- uses: photon-hq/buildspace/.github/blocks/generate-release-info@main
  id: info
  with:
    service-name: my-service
    openai-api-key: ${{ secrets.OPENAI_API_KEY }}

- run: |
    echo "Version: ${{ steps.info.outputs.version }}"
    echo "Notes: ${{ steps.info.outputs.release_notes }}"
```

---

### determine-publish-version

**Path:** `.github/blocks/determine-publish-version/action.yaml`

Standalone action for determining the next semantic version. Lighter-weight alternative to `generate-release-info` when you don't need release notes.

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `prerelease` | boolean | ❌ | `false` | Append `-rc.N` suffix to version |
| `openai-api-key` | secret | ✅ | — | OpenAI API key |

#### Outputs

| Output | Type | Description |
|--------|------|-------------|
| `version` | string | Determined version (e.g., `1.2.3`) |
| `previous-version` | string | Previous version before this release |

#### Usage

```yaml
- uses: photon-hq/buildspace/.github/blocks/determine-publish-version@main
  id: version
  with:
    openai-api-key: ${{ secrets.OPENAI_API_KEY }}

- run: echo "Bumping from ${{ steps.version.outputs.previous-version }} to ${{ steps.version.outputs.version }}"
```

---

### create-github-release

**Path:** `.github/blocks/create-github-release/action.yaml`

Creates a GitHub Release with optional artifact attachments.

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `version` | string | ✅ | — | Version number (e.g., `1.2.3`) |
| `title` | string | ✅ | — | Release title |
| `notes` | string | ❌ | `""` | Release notes in markdown |
| `prerelease` | boolean | ❌ | `false` | Mark as prerelease |
| `draft` | boolean | ❌ | `false` | Create as draft |
| `tag-prefix` | string | ❌ | `v` | Prefix for git tag (e.g., `v1.2.3`) |
| `artifact-pattern` | string | ❌ | `""` | Pattern to match artifacts to attach |

#### Outputs

| Output | Type | Description |
|--------|------|-------------|
| `url` | string | URL of the created release |
| `tag` | string | Created tag name (e.g., `v1.2.3`) |

#### Usage

```yaml
- uses: photon-hq/buildspace/.github/blocks/create-github-release@main
  with:
    version: "1.2.3"
    title: "My Service v1.2.3"
    notes: |
      ## What's New
      - Added awesome feature
      - Fixed annoying bug
    artifact-pattern: "my-binary-*"
```

---

### detect-changed-packages

**Path:** `.github/blocks/detect-changed-packages/action.yaml`

Detects which monorepo packages have changed since the last GitHub Release and outputs them in topological (dependency) order. Optionally includes downstream dependents.

#### How It Works

1. Finds the last GitHub Release tag SHA
2. Runs `git diff --name-only` to get changed files
3. Maps changed files to packages using the provided `packages` JSON
4. Optionally adds downstream dependents by reading each package's `package.json` dependencies
5. Topologically sorts the result (dependencies before dependents)

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `packages` | string | ✅ | — | JSON array: `[{"name":"pkg","path":"packages/pkg"}]` |
| `include-dependents` | boolean | ❌ | `false` | Also include packages that depend on changed packages |

#### Outputs

| Output | Type | Description |
|--------|------|-------------|
| `changed` | JSON | Array of changed packages in topological order |
| `has-changes` | boolean | Whether any packages have changes |

#### Usage

```yaml
- uses: actions/checkout@v5
  with:
    fetch-depth: 0

- uses: photon-hq/buildspace/.github/blocks/detect-changed-packages@main
  id: detect
  with:
    packages: '[{"name":"photon","path":"packages/photon"},{"name":"@photon/openai","path":"packages/openai"}]'
    include-dependents: true

- if: steps.detect.outputs.has-changes == 'true'
  run: echo "Changed packages: ${{ steps.detect.outputs.changed }}"
```

---

### bump-monorepo-versions

**Path:** `.github/blocks/bump-monorepo-versions/action.yaml`

Determines versions for all changed monorepo packages using a single AI call, bumps each `package.json`, and commits/pushes the result.

#### How It Works

1. Gathers commits scoped to each package's path via `git log -- <path>`
2. Sends a single prompt containing all packages and their scoped commits to OpenAI
3. Parses the AI response for per-package versions and combined release notes
4. Runs `npm version` in each package directory
5. Commits all bumps in one commit and pushes

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `changed-packages` | string | ✅ | — | JSON array from `detect-changed-packages` output |
| `service-name` | string | ✅ | — | Service name for commit messages |
| `prerelease` | boolean | ❌ | `false` | Append `-rc.N` suffix to versions |
| `openai-api-key` | secret | ✅ | — | OpenAI API key |
| `github-token` | secret | ✅ | — | GitHub token (fallback) |
| `app-id` | secret | ❌ | `""` | GitHub App ID (for protected branches) |
| `app-private-key` | secret | ❌ | `""` | GitHub App private key |

#### Outputs

| Output | Type | Description |
|--------|------|-------------|
| `versions` | JSON | Object mapping package names to new versions |
| `release-notes` | string | Combined AI-generated release notes |

#### Usage

```yaml
- uses: photon-hq/buildspace/.github/blocks/bump-monorepo-versions@main
  id: bump
  with:
    changed-packages: ${{ steps.detect.outputs.changed }}
    service-name: photon-ts
    openai-api-key: ${{ secrets.OPENAI_API_KEY }}
    github-token: ${{ github.token }}
```

---

### publish-npm-packages

**Path:** `.github/blocks/publish-npm-packages/action.yaml`

Builds and publishes multiple monorepo packages to npm in dependency order. Supports both per-package builds and a single root build command.

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `changed-packages` | string | ✅ | — | JSON array of packages in topological order |
| `bun-version` | string | ❌ | `latest` | Bun version |
| `node-version` | string | ❌ | `20` | Node.js version |
| `tag` | string | ❌ | `latest` | npm tag |
| `build-command` | string | ❌ | `bun run build` | Per-package build command (ignored if `root-build-command` is set) |
| `root-build-command` | string | ❌ | `""` | Build once at repo root (e.g., `turbo build`) |
| `dry-run` | boolean | ❌ | `false` | Run `npm publish --dry-run` |
| `npm-token` | secret | ✅ | — | npm authentication token |

#### Usage

```yaml
- uses: actions/checkout@v5
  with:
    ref: ${{ github.ref_name }}
    fetch-depth: 0

- uses: photon-hq/buildspace/.github/blocks/publish-npm-packages@main
  with:
    changed-packages: ${{ steps.detect.outputs.changed }}
    root-build-command: "turbo build"
    tag: latest
    npm-token: ${{ secrets.NPM_TOKEN }}
```

---

### rust-build

**Path:** `.github/blocks/rust-build/action.yaml`

Builds a Rust binary for a specific target platform.

#### Supported Targets

| Target | OS |
|--------|----|
| `x86_64-unknown-linux-gnu` | Linux (x64) |
| `aarch64-apple-darwin` | macOS (ARM64) |
| `x86_64-pc-windows-msvc` | Windows (x64) |

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `binary-name` | string | ✅ | — | Name of the binary (from `Cargo.toml`) |
| `binary-path` | string | ❌ | `""` | Path to crate directory |
| `target` | string | ✅ | — | Target triple (e.g., `x86_64-unknown-linux-gnu`) |
| `build-env` | string | ❌ | `""` | Compile-time env vars for `.env` file |

#### Outputs

| Output | Type | Description |
|--------|------|-------------|
| `artifact-name` | string | Name of the built artifact |
| `artifact-path` | string | Path to the artifact file |

#### Usage

```yaml
- uses: photon-hq/buildspace/.github/blocks/rust-build@main
  with:
    binary-name: my-cli
    binary-path: crates/client
    target: x86_64-unknown-linux-gnu
    build-env: "API_URL=https://api.example.com"

- uses: actions/upload-artifact@v4
  with:
    name: my-cli-linux
    path: artifacts/*
```

---

### typescript-build

**Path:** `.github/blocks/typescript-build/action.yaml`

Builds a TypeScript project using Bun.

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `bun-version` | string | ❌ | `latest` | Bun version |
| `working-directory` | string | ❌ | `.` | Directory containing `package.json` |
| `build-command` | string | ❌ | `bun run build` | Build command |

#### Usage

```yaml
- uses: photon-hq/buildspace/.github/blocks/typescript-build@main
  with:
    bun-version: "1.1"
    build-command: "npm run build"
```

---

### sync-crates-version

**Path:** `.github/blocks/sync-crates-version/action.yaml`

Syncs version across all workspace crates using `cargo-edit`. Automatically commits and pushes version changes.

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `version` | string | ✅ | — | Version to set across all crates |
| `commit-changes` | boolean | ❌ | `true` | Whether to commit and push |
| `github-token` | secret | ✅ | — | GitHub token for pushing |

#### Outputs

| Output | Type | Description |
|--------|------|-------------|
| `updated-crates` | JSON | Array of crate names that were updated |

#### Usage

```yaml
- uses: actions/checkout@v5
  with:
    token: ${{ github.token }}

- uses: photon-hq/buildspace/.github/blocks/sync-crates-version@main
  with:
    version: "1.2.3"
    github-token: ${{ github.token }}
```

---

### publish-crates

**Path:** `.github/blocks/publish-crates/action.yaml`

Publishes workspace crates to crates.io in dependency order. Includes retry logic and rate limit handling.

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `crates` | string | ✅ | — | JSON array of crate paths in publish order |
| `dry-run` | boolean | ❌ | `false` | Run `cargo publish --dry-run` |
| `cargo-registry-token` | secret | ✅ | — | crates.io API token |

#### Usage

```yaml
- uses: photon-hq/buildspace/.github/blocks/publish-crates@main
  with:
    # Shared first (dependency)
    crates: '["crates/shared", "crates/client"]'
    cargo-registry-token: ${{ secrets.CARGO_REGISTRY_TOKEN }}
```

> ⚠️ **Important:** Order matters! List dependencies before dependents.

---

### publish-npm

**Path:** `.github/blocks/publish-npm/action.yaml`

Publishes a package to npm. Handles dependencies installation, build, and publish.

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `bun-version` | string | ❌ | `latest` | Bun version |
| `node-version` | string | ❌ | `20` | Node.js version |
| `working-directory` | string | ❌ | `.` | Directory containing `package.json` |
| `build-command` | string | ❌ | `bun run build` | Build command |
| `tag` | string | ❌ | `latest` | npm tag |
| `dry-run` | boolean | ❌ | `false` | Run `npm publish --dry-run` |
| `npm-token` | secret | ✅ | — | npm authentication token |

#### Usage

```yaml
- uses: photon-hq/buildspace/.github/blocks/publish-npm@main
  with:
    tag: latest
    build-command: "npm run build"
    npm-token: ${{ secrets.NPM_TOKEN }}
```

---

### comment-on-pr

**Path:** `.github/blocks/comment-on-pr/action.yaml`

Posts or updates a single comment on a pull request. When a `comment-key` is provided it embeds an HTML marker in the comment body so subsequent calls with the same key will edit the existing comment rather than creating a new one — keeping your PR timeline clean.

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `message` | string | ✅ | — | Comment body (markdown supported) |
| `comment-key` | string | ❌ | `""` | Unique key used to find and update an existing comment |

#### Usage

```yaml
- uses: photon-hq/buildspace/.github/blocks/comment-on-pr@main
  with:
    comment-key: my-build-status
    message: |
      ## Build Status
      ✅ All checks passed for commit ${{ github.sha }}
```

---

## 🏷️ PR Labels

Control releases by adding labels to your PR before merging:

| Label | Effect |
|-------|--------|
| `release` | Triggers GitHub Release + package publish (npm/crates.io) |
| `prerelease` | Creates prerelease with `-rc.N` suffix and `beta` npm tag |

**No label = No release.** PRs without labels simply merge without triggering any release jobs.

---

## 🏗️ Architecture

```
buildspace/
├── .github/
│   ├── blocks/                        # Composite actions (building blocks)
│   │   ├── bump-monorepo-versions/    # AI version bump for monorepos (single call)
│   │   ├── check-pr-label/            # PR label detection
│   │   ├── comment-on-pr/             # Post/update PR comments
│   │   ├── create-github-release/     # GitHub Release creation
│   │   ├── detect-changed-packages/   # Monorepo change detection + topo-sort
│   │   ├── determine-publish-version/ # AI version detection (standalone)
│   │   ├── generate-release-info/     # AI version + release notes
│   │   ├── publish-crates/            # crates.io publishing
│   │   ├── publish-npm/               # npm publishing (single package)
│   │   ├── publish-npm-packages/      # npm publishing (monorepo, ordered)
│   │   ├── rust-build/                # Cross-platform Rust builds
│   │   ├── swift-build/               # Swift binary builds
│   │   ├── swift-pkg/                 # macOS .pkg creation
│   │   ├── sync-crates-version/       # Workspace version sync
│   │   └── typescript-build/          # TypeScript builds
│   │
│   └── workflows/                     # Reusable workflows (full pipelines)
│       ├── rust-service-release.yaml            # Complete Rust release pipeline
│       ├── swift-pkg-pr.yml                     # Swift .pkg build on every PR commit
│       ├── swift-release.yml                    # Swift .pkg release pipeline
│       ├── typescript-monorepo-release.yaml     # Complete TS monorepo pipeline
│       └── typescript-service-release.yaml      # Complete TS release pipeline
```

### How Releases Work

#### Single-Package Workflows

This section addresses `rust-service-release` and `typescript-service-release`.

These workflows are complete for fully ai-powered and automated releases from versioning to version notes to publishing. These workflows are built upon the building blocks in the `.github/blocks` folder 

Both workflows share the same initial steps, then diverge for language-specific publishing. The following 
diagram is most accurate. 

```
                        ╔═══════════════════════════════════════════════════╗
                        ║              SHARED STEPS (both workflows)        ║
                        ╠═══════════════════════════════════════════════════╣
                        ║                                                   ║
                        ║  ┌─────────────┐     ┌───────────────┐            ║
                        ║  │  PR Merged  │────▶│ Check Labels  │            ║
                        ║  │ with label  │     │  (release?)   │            ║
                        ║  └─────────────┘     └───────────────┘            ║
                        ║                              │                    ║
                        ║                              ▼                    ║
                        ║                    ┌──────────────────┐           ║
                        ║                    │ Generate Version │           ║
                        ║                    │  + Release Notes │           ║
                        ║                    │     (AI-powered) │           ║
                        ║                    └──────────────────┘           ║
                        ║                              │                    ║
                        ╚══════════════════════════════╪════════════════════╝
                                                       │
                 ┌─────────────────────────────────────┴─────────────────────────────────────┐
                 │                                                                           │
                 ▼                                                                           ▼
╔════════════════════════════════════════╗            ╔════════════════════════════════════════╗
║   rust-service-release.yaml            ║            ║   typescript-service-release.yaml      ║
╠════════════════════════════════════════╣            ╠════════════════════════════════════════╣
║                                        ║            ║                                        ║
║   ┌───────────────┐ ┌───────────────┐  ║            ║         ┌─────────────────┐            ║
║   │ Build Binaries│ │ Sync Versions │  ║            ║         │  Bump Version   │            ║
║   │ (Linux/macOS/ │ │ (all crates)  │  ║            ║         │ (package.json)  │            ║
║   │   Windows)    │ └───────────────┘  ║            ║         └─────────────────┘            ║
║   └───────────────┘         │          ║            ║                   │                    ║
║           │                 ▼          ║            ║         ┌─────────┴─────────┐          ║
║           │       ┌─────────────────┐  ║            ║         │                   │          ║
║           │       │ Publish Crates  │  ║            ║         ▼                   ▼          ║
║           │       │  (crates.io)    │  ║            ║  ┌──────────────┐   ┌─────────────┐    ║
║           │       └─────────────────┘  ║            ║  │GitHub Release│   │ npm Publish │    ║
║           │                 │          ║            ║  └──────────────┘   └─────────────┘    ║
║           └────────┬────────┘          ║            ║                                        ║
║                    ▼                   ║            ╚════════════════════════════════════════╝
║         ┌───────────────────┐          ║
║         │  GitHub Release   │          ║
║         │  (with binaries)  │          ║
║         └───────────────────┘          ║
║                                        ║
╚════════════════════════════════════════╝
```

#### Monorepo Workflow

The `typescript-monorepo-release` workflow extends the single-package pattern to handle multiple independently-versioned packages. Key differences:

- **Change detection** — only packages with file changes (and optionally their dependents) are released
- **Topological ordering** — packages are processed in dependency order so downstream consumers see new versions of their dependencies
- **Single AI call** — one prompt contains all packages and their scoped commits, producing versions and notes in one shot
- **Date-based tags** — since there's no single version, releases use `release/YYYY-MM-DD.N` tags
- **`workspace:*` protocol** — left untouched; Bun/npm resolves these to real versions at pack-time

---

## 🤝 Contributing

1. Create a feature branch from `main`
2. Make your changes
3. Test locally or in a test repository
4. Open a PR with a clear description
5. Add the `release` label when ready to publish

### Testing Workflows

To test without publishing, use `dry-run: true`:

```yaml
with:
  dry-run: true
```

Or test by pointing to your branch:

```yaml
uses: photon-hq/buildspace/.github/workflows/rust-service-release.yaml@your-branch
```

---

## 📄 License

MIT © [Photon](https://github.com/photon-hq)
