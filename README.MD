# 🚀 Buildspace

[![GitHub Actions](https://img.shields.io/badge/GitHub%20Actions-2088FF?logo=github-actions&logoColor=white)](https://github.com/features/actions)
[![Rust](https://img.shields.io/badge/Rust-000000?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![NPM](https://img.shields.io/badge/NPM-CB3837?logo=npm&logoColor=white)](https://www.npmjs.com/)
[![Crates.io](https://img.shields.io/badge/Crates.io-FFC832?logo=rust&logoColor=black)](https://crates.io/)

**Reusable GitHub Actions workflows and composite actions for automated releases at Photon.**

Buildspace provides battle-tested CI/CD building blocks that handle semantic versioning, release notes generation, multi-platform builds, and publishing to npm/crates.io—all powered by AI.

---

## 📖 Table of Contents

- [Features](#-features)
- [Quick Start](#-quick-start)
- [Workflows](#-workflows)
  - [Rust Service Release](#rust-service-release)
  - [TypeScript Service Release](#typescript-service-release)
- [Actions](#-actions)
  - [check-pr-label](#check-pr-label)
  - [generate-release-info](#generate-release-info)
  - [determine-publish-version](#determine-publish-version)
  - [create-github-release](#create-github-release)
  - [rust-build](#rust-build)
  - [typescript-build](#typescript-build)
  - [sync-crates-version](#sync-crates-version)
  - [publish-crates](#publish-crates)
  - [publish-npm](#publish-npm)
- [PR Labels](#-pr-labels)
- [Architecture](#-architecture)
- [Contributing](#-contributing)
- [License](#-license)

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🤖 **AI-Powered Versioning** | Automatically determines semantic version bumps from commit history |
| 📝 **Smart Release Notes** | Generates human-readable release notes using AI |
| 🔨 **Multi-Platform Builds** | Cross-compiles Rust binaries for Linux, macOS, and Windows |
| 📦 **Unified Publishing** | Publishes to npm, crates.io, and GitHub Releases in one workflow |
| 🏷️ **Label-Driven Releases** | Control releases via PR labels—no manual version management |
| 🔄 **Workspace Version Sync** | Keeps all crates/packages in a monorepo at the same version |

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

Create `.github/workflows/release.yaml`:

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
│   ├── blocks/                     # Composite actions (building blocks)
│   │   ├── check-pr-label/         # PR label detection
│   │   ├── create-github-release/  # GitHub Release creation
│   │   ├── determine-publish-version/ # AI version detection (standalone)
│   │   ├── generate-release-info/  # AI version + release notes
│   │   ├── publish-crates/         # crates.io publishing
│   │   ├── publish-npm/            # npm publishing
│   │   ├── rust-build/             # Cross-platform Rust builds
│   │   ├── sync-crates-version/    # Workspace version sync
│   │   └── typescript-build/       # TypeScript builds
│   │
│   └── workflows/                  # Reusable workflows (full pipelines)
│       ├── rust-service-release.yaml      # Complete Rust release pipeline
│       └── typescript-service-release.yaml # Complete TS release pipeline
```

### How Releases Work

This secition addresses `rust-service-release` and `typescript-service-release`.

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
