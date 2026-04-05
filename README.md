# BuildSpace

[![GitHub Actions](https://img.shields.io/badge/GitHub%20Actions-2088FF?logo=github-actions&logoColor=white)](https://github.com/features/actions)
[![Rust](https://img.shields.io/badge/Rust-000000?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![NPM](https://img.shields.io/badge/NPM-CB3837?logo=npm&logoColor=white)](https://www.npmjs.com/)
[![Crates.io](https://img.shields.io/badge/Crates.io-FFC832?logo=rust&logoColor=black)](https://crates.io/)

**Reusable GitHub Actions blocks and workflows for fast shipping teams**

BuildSpace gives you two layers of CI/CD automation:

- **Workflows**: plug-and-play release pipelines. Point a workflow at your repo, provide a few secrets, and you're done. Most teams only need this.
- **Blocks**: the composable actions that workflows are built from. Use them to assemble custom pipelines when the prebuilt workflows don't fit.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Prerequisites](#prerequisites)
- [Workflows](#workflows)
  - [Rust Service Release](#rust-service-release)
  - [TypeScript Service Release](#typescript-service-release)
  - [TypeScript Monorepo Release](#typescript-monorepo-release)
  - [Go Binary Release](#go-binary-release)
  - [Swift Release](#swift-release)
  - [Package Release](#package-release)
  - [Package PR Build](#package-pr-build)
  - [Swift Package PR Build](#swift-package-pr-build)
  - [Check README](#check-readme)
  - [Update Documentation](#update-documentation)
  - [Blocks (Composite Actions)](#blocks-composite-actions)
  - [check-pr-label](#check-pr-label)
  - [check-readme](#check-readme-1)
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
  - [update-docs](#update-docs)
- [Architecture](#architecture)
- [Contributing](#contributing)
- [License](#license)

---

## Quick Start

### Which workflow do I need?

| I have a... | Use this workflow | Trigger |
|---|---|---|
| Single Rust binary or library | [`rust-service-release`](#rust-service-release) | PR label `release` |
| Single TypeScript / JavaScript package | [`typescript-service-release`](#typescript-service-release) | PR label `release` |
| TypeScript monorepo (multiple packages) | [`typescript-monorepo-release`](#typescript-monorepo-release) | PR label `release` |
| Go binary | [`go-binary-release`](#go-binary-release) | PR label `release` |
| Swift macOS `.pkg` (release) | [`swift-release`](#swift-release) | PR label `release` |
| macOS `.pkg` without binary (payload/scripts only) | [`pkg-release`](#package-release) | PR label `release` |
| macOS `.pkg` PR build (no binary) | [`pkg-release-pr`](#package-pr-build) | Every PR commit |
| Swift macOS `.pkg` (PR build previews) | [`swift-pkg-pr`](#swift-package-pr-build) | Every PR commit |
| Any project — check if README is current | [`check-readme`](#check-readme) | Every PR |

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

### README Update-To-Date Check

Add to any repo's `.github/workflows/ci.yaml`:

```yaml
name: CI

on:
  pull_request:

jobs:
  check-readme:
    uses: photon-hq/buildspace/.github/workflows/check-readme.yaml@main
    secrets:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

Then add a `release` label to your PR, merge, and let BuildSpace do the rest.

### Pinning to a Version

All examples above use `@main` which tracks the latest changes. For production stability, pin to a specific release tag:

```yaml
uses: photon-hq/buildspace/.github/workflows/rust-service-release.yaml@v1.2.3
```

Available versions are listed on the [GitHub Releases](https://github.com/photon-hq/buildspace/releases) page. Buildspace versions itself using the same AI-powered release pipeline it provides to other repos.

---

## Prerequisites

### Required Secrets

Most release workflows need `OPENAI_API_KEY` for AI-powered versioning and release notes. The `update-docs` workflow uses `ANTHROPIC_API_KEY` instead. Add secrets depending on which workflows you use:

| Secret | Needed for | Where to get it |
|--------|-----------|-----------------|
| `OPENAI_API_KEY` | Release workflows | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| `ANTHROPIC_API_KEY` | Update Documentation | [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) |
| `NPM_TOKEN` | TypeScript publishing | [npmjs.com/settings/tokens](https://www.npmjs.com/settings/tokens) |
| `CARGO_REGISTRY_TOKEN` | Rust crate publishing | [crates.io/settings/tokens](https://crates.io/settings/tokens) |
| `APP_ID` | Update Documentation (required), release workflows (optional, for protected branches) | GitHub App settings |
| `APP_PRIVATE_KEY` | Update Documentation (required), release workflows (optional, for protected branches) | GitHub App settings |

Add these in your repo's **Settings > Secrets and variables > Actions**, or set them as **org-level secrets** under `photon-hq` so every repo inherits them automatically via `secrets: inherit`.

### PR Labels

Control releases by adding labels to your PR before merging:

| Label | Effect |
|-------|--------|
| `release` | Triggers a full release (GitHub Release + package publish) |
| `prerelease` | Creates a prerelease with `-rc.N` suffix and `beta` npm tag |

**No label = no release** PRs without labels merge without triggering any release jobs. You can customize your release label with the input 'labels-to-check' in the 'release.yml'. 

### Permissions

Workflows that create releases or push commits need `contents: write`. Workflows that read PR labels need `pull-requests: read`. Workflows that post comments need `pull-requests: write`. Each workflow section below lists the exact permissions required.

---

## Workflows

Ready-to-use release pipelines. Each workflow composes the lower-level [blocks](#blocks-composite-actions) internally - you don't need to know about individual blocks unless you're building a custom pipeline.

---

### Rust Service Release

**File:** `.github/workflows/rust-service-release.yaml`

Complete release pipeline for Rust services: checks PR labels, generates version and release notes with AI, builds binaries for Linux (x86_64), macOS (ARM64), and Windows, syncs version across all workspace crates, publishes to crates.io, and creates a GitHub Release with attached binaries.

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `service-name` | string | Yes | — | Display name for the service |
| `binary-name` | string | Yes | — | Name of the binary from `Cargo.toml` |
| `binary-path` | string | No | `""` | Path to crate directory (e.g., `crates/client`) |
| `crates` | string | No | `[]` | JSON array of crate paths to publish in dependency order |
| `build-env` | string | No | `""` | Compile-time env vars (e.g., `BASE_URL=https://...`) |
| `labels-to-check` | string | No | `["release", "prerelease"]` | PR labels that trigger releases |
| `prerelease` | boolean | No | `false` | Force prerelease (adds `-rc.N` suffix) |
| `release` | boolean | No | `false` | Force release (bypasses label check) |
| `dry-run` | boolean | No | `false` | Test without actually publishing |

#### Secrets

| Secret | Required | Description |
|--------|----------|-------------|
| `OPENAI_API_KEY` | Yes | For AI-powered versioning and release notes |
| `CARGO_REGISTRY_TOKEN` | No | crates.io API token (required for publishing) |

#### Example

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
    secrets:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      CARGO_REGISTRY_TOKEN: ${{ secrets.CARGO_REGISTRY_TOKEN }}
```

---

### TypeScript Service Release

**File:** `.github/workflows/typescript-service-release.yaml`

Complete release pipeline for a single TypeScript/JavaScript package: checks PR labels, generates version and release notes with AI, bumps `package.json`, creates a GitHub Release, and publishes to npm.

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `service-name` | string | Yes | — | Display name for the service |
| `bun-version` | string | No | `latest` | Bun version to use |
| `npm-tag` | string | No | `latest` | npm dist-tag (e.g., `latest`, `beta`, `next`) |
| `no-npm-publish` | boolean | No | `false` | Skip npm publishing (GitHub Release only) |
| `working-directory` | string | No | `.` | Directory containing `package.json` |
| `build-command` | string | No | `bun run build` | Build command to run |
| `labels-to-check` | string | No | `["release", "prerelease"]` | PR labels that trigger releases |
| `prerelease` | boolean | No | `false` | Force prerelease |
| `release` | boolean | No | `false` | Force release (bypasses label check) |
| `dry-run` | boolean | No | `false` | Test without actually publishing |

#### Secrets

| Secret | Required | Description |
|--------|----------|-------------|
| `OPENAI_API_KEY` | Yes | For AI-powered versioning and release notes |
| `NPM_TOKEN` | No | npm auth token (required for publishing) |

#### Example

```yaml
jobs:
  release:
    uses: photon-hq/buildspace/.github/workflows/typescript-service-release.yaml@main
    permissions:
      contents: write
      pull-requests: read
    with:
      service-name: notebooklm-kit
      build-command: "npm run build"
    secrets:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

---

### TypeScript Monorepo Release

**File:** `.github/workflows/typescript-monorepo-release.yaml`

Complete release pipeline for TypeScript/JavaScript monorepos with independently-versioned packages. Detects which packages changed since the last release, topologically sorts them by dependency order, uses a single AI call to determine all versions and generate combined release notes, bumps each `package.json`, creates a GitHub Release with a `release/YYYY-MM-DD.N` tag, and publishes all changed packages to npm in dependency order.

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `service-name` | string | Yes | — | Display name for the monorepo |
| `packages` | string | Yes | — | JSON array of packages: `[{"name":"pkg","path":"packages/pkg"}]` |
| `bun-version` | string | No | `latest` | Bun version to use |
| `npm-tag` | string | No | `latest` | npm dist-tag |
| `build-command` | string | No | `bun run build` | Per-package build command (ignored if `root-build-command` is set) |
| `root-build-command` | string | No | `""` | Build once at repo root (e.g., `turbo build`) |
| `include-dependents` | boolean | No | `false` | Also release downstream dependents of changed packages |
| `labels-to-check` | string | No | `["release", "prerelease"]` | PR labels that trigger releases |
| `prerelease` | boolean | No | `false` | Force prerelease |
| `release` | boolean | No | `false` | Force release (bypasses label check) |
| `dry-run` | boolean | No | `false` | Test without actually publishing |

#### Secrets

| Secret | Required | Description |
|--------|----------|-------------|
| `OPENAI_API_KEY` | Yes | For AI-powered versioning and release notes |
| `NPM_TOKEN` | Yes | npm authentication token |
| `APP_ID` | No | GitHub App ID (for pushing to protected branches) |
| `APP_PRIVATE_KEY` | No | GitHub App private key (for pushing to protected branches) |

#### Example

```yaml
jobs:
  release:
    uses: photon-hq/buildspace/.github/workflows/typescript-monorepo-release.yaml@main
    permissions:
      contents: write
      pull-requests: read
    with:
      service-name: photon-ts
      packages: |
        [
          {"name":"photon","path":"packages/photon"},
          {"name":"@photon/openai-compatible","path":"packages/openai-compatible"},
          {"name":"create-photon","path":"packages/create-photon"}
        ]
      root-build-command: "turbo build"
      include-dependents: true
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

### Go Binary Release

**File:** `.github/workflows/go-service-release.yaml`

Complete release pipeline for Go binaries: checks PR labels, generates version and release notes with AI, cross-compiles for Linux (x64/ARM64), macOS (ARM64), and Windows (x64), and creates a GitHub Release with attached binaries.

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `service-name` | string | Yes | — | Display name for the service |
| `binary-name` | string | Yes | — | Output binary name |
| `go-version` | string | No | `stable` | Go version to use |
| `build-flags` | string | No | `""` | Additional `go build` flags |
| `ldflags` | string | No | `-s -w` | Linker flags |
| `labels-to-check` | string | No | `["release", "prerelease"]` | PR labels that trigger releases |
| `prerelease` | boolean | No | `false` | Force prerelease |
| `release` | boolean | No | `false` | Force release (bypasses label check) |

#### Secrets

| Secret | Required | Description |
|--------|----------|-------------|
| `OPENAI_API_KEY` | Yes | For AI-powered versioning and release notes |

#### Example

```yaml
jobs:
  release:
    uses: photon-hq/buildspace/.github/workflows/go-service-release.yaml@main
    permissions:
      contents: write
      pull-requests: read
    with:
      service-name: my-go-tool
      binary-name: my-go-tool
    secrets:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

---

### Swift Release

**File:** `.github/workflows/swift-release.yml`

Complete release pipeline for macOS `.pkg` distribution packages: checks PR labels, generates version and release notes with AI, builds the Swift binary, creates a `.pkg`, creates a GitHub Release, and optionally uploads to Jamf Pro.

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `package-name` | string | Yes | — | Name of the Swift binary / package |
| `identifier` | string | Yes | — | Package identifier (e.g., `com.example.mytool`) |
| `scripts-path` | string | No | `""` | Path to scripts directory with preinstall/postinstall scripts |
| `jamf-url` | string | No | `""` | Jamf Pro instance URL (leave empty to skip Jamf upload) |
| `jamf-package-priority` | string | No | `""` | Package priority in Jamf Pro |
| `jamf-package-name` | string | No | `""` | Package name to match in Jamf Pro |

#### Secrets

| Secret | Required | Description |
|--------|----------|-------------|
| `OPENAI_API_KEY` | Yes | For AI-powered versioning and release notes |
| `SECRET_ENV_VARS` | No | Compile-time env vars written to `.env` |
| `JAMF_CLIENT_ID` | No | Jamf Pro API client ID |
| `JAMF_CLIENT_SECRET` | No | Jamf Pro API client secret |

#### Example

```yaml
jobs:
  release:
    uses: photon-hq/buildspace/.github/workflows/swift-release.yml@main
    with:
      package-name: my-tool
      identifier: com.example.my-tool
    secrets:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

---

### Package Release

**File:** `.github/workflows/pkg-release.yml`

Release pipeline for macOS `.pkg` distribution packages that don't contain a compiled binary. Packages payload files and scripts into a `.pkg`, creates a GitHub Release, and optionally uploads to Jamf Pro. Use this instead of `swift-release` when your package only delivers configuration files, LaunchDaemons, scripts, or other non-binary payload.

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `package-name` | string | Yes | — | Name of the package |
| `identifier` | string | Yes | — | Package identifier (e.g., `com.example.my-config`) |
| `scripts-path` | string | No | `""` | Path to scripts directory with preinstall/postinstall scripts |
| `payload-path` | string | No | `""` | Path to payload directory whose contents mirror the install root |
| `jamf-url` | string | No | `""` | Jamf Pro instance URL (leave empty to skip Jamf upload) |
| `jamf-package-priority` | string | No | `""` | Package priority in Jamf Pro |
| `jamf-package-name` | string | No | `""` | Package name to match in Jamf Pro |

#### Secrets

| Secret | Required | Description |
|--------|----------|-------------|
| `OPENAI_API_KEY` | Yes | For AI-powered versioning and release notes |
| `JAMF_CLIENT_ID` | No | Jamf Pro API client ID |
| `JAMF_CLIENT_SECRET` | No | Jamf Pro API client secret |

#### Example

```yaml
jobs:
  release:
    uses: photon-hq/buildspace/.github/workflows/pkg-release.yml@main
    with:
      package-name: my-config-pkg
      identifier: com.example.my-config
      payload-path: payload
      scripts-path: scripts
    secrets:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

---

### Package PR Build

**File:** `.github/workflows/pkg-release-pr.yml`

Builds a macOS `.pkg` (without compiling a binary) on every PR commit and reports status directly in the PR as a living comment. Same PR experience as `swift-pkg-pr` but for payload/scripts-only packages. If a build is already running when a new commit is pushed, the old run is automatically cancelled.

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `package-name` | string | Yes | — | Name of the package |
| `identifier` | string | Yes | — | Package identifier (e.g., `com.example.my-config`) |
| `scripts-path` | string | No | `""` | Path to scripts directory with preinstall/postinstall scripts |
| `payload-path` | string | No | `""` | Path to payload directory whose contents mirror the install root |

#### Example

```yaml
# .github/workflows/pr.yml
name: PR

on:
  pull_request:

jobs:
  pkg:
    uses: photon-hq/buildspace/.github/workflows/pkg-release-pr.yml@main
    with:
      package-name: my-config-pkg
      identifier: com.example.my-config
      payload-path: payload
      scripts-path: scripts
```

---

### Swift Package PR Build

**File:** `.github/workflows/swift-pkg-pr.yml`

Builds a macOS `.pkg` on every PR commit and reports status directly in the PR as a living comment (updated in place, not spammy). If a build is already running when a new commit is pushed, the old run is automatically cancelled.

1. Posts a "Building..." comment on the PR (or updates the existing one)
2. Builds the Swift binary, creates a `.pkg` versioned as `pr.<PR#>.<run#>`
3. Uploads the `.pkg` as an Actions artifact (7-day retention)
4. Updates the PR comment to success (with artifact link) or failure (with log link)

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `package-name` | string | Yes | — | Name of the Swift binary / package |
| `identifier` | string | Yes | — | Package identifier (e.g., `com.example.mytool`) |
| `scripts-path` | string | No | `""` | Path to scripts directory with preinstall/postinstall scripts |

#### Secrets

| Secret | Required | Description |
|--------|----------|-------------|
| `SECRET_ENV_VARS` | No | Compile-time env vars written to `.env` |

#### Example

```yaml
# .github/workflows/pr.yml
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
      SECRET_ENV_VARS: ${{ secrets.SECRET_ENV_VARS }}
```

---

### Check README

**File:** `.github/workflows/check-readme.yaml`

Runs on every PR to verify that `README.md` is up to date with the changes being introduced. Uses AI to read the README and the changed files, then determines whether the documentation needs updating. Posts a PR comment explaining what's missing when the README is stale, and automatically removes the comment when the README is brought up to date.

Flags changes to public APIs, features, configuration, install steps, and environment variables. Ignores internal refactors, test-only changes, CI tweaks, and bug fixes that don't affect documented behavior.

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `blocking` | boolean | No | `false` | If `true`, fail the workflow when the README is outdated. If `false`, only post a warning comment. |

#### Secrets

| Secret | Required | Description |
|--------|----------|-------------|
| `OPENAI_API_KEY` | Yes | For AI-powered README analysis |

#### Example (warning only)

```yaml
name: CI

on:
  pull_request:

jobs:
  check-readme:
    uses: photon-hq/buildspace/.github/workflows/check-readme.yaml@main
    secrets:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

#### Example (block the PR)

```yaml
jobs:
  check-readme:
    uses: photon-hq/buildspace/.github/workflows/check-readme.yaml@main
    with:
      blocking: true
    secrets:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

> To enforce this as a required check, also add `check-readme` as a required status check in your branch protection rules (Settings > Branches > Branch protection rule).

---

### Update Documentation

**File:** `.github/workflows/update-docs.yaml`

Runs when a release is published. Uses [Claude Code Action](https://github.com/anthropics/claude-code-action) to analyze the changes between the current and previous release, then submits a PR to the documentation repository with any necessary updates. Focuses on API changes, new features, configuration changes, breaking changes, and deprecations.

The workflow automatically generates a cross-repo GitHub App token from the `photon-hq` org-level `APP_ID` and `APP_PRIVATE_KEY` secrets, clones the target docs repo, lets Claude Code read the existing docs and modify them based on the release diff and notes, then opens a PR if any changes were made. No per-repo secret configuration is needed — just use `secrets: inherit`.

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `service-name` | string | Yes | — | Name of the service being released |
| `docs-repo` | string | No | `photon-hq/docs` | Target documentation repository (`owner/repo`) |
| `docs-branch` | string | No | `main` | Base branch of the docs repo |

#### Secrets

Handled automatically. The workflow reads `ANTHROPIC_API_KEY`, `APP_ID`, and `APP_PRIVATE_KEY` from the `photon-hq` org-level secrets (passed via `secrets: inherit`). It uses the GitHub App credentials internally to mint a short-lived token scoped to the docs repo — individual repos never need to configure these.

#### Example

```yaml
name: Update Docs on Release

on:
  release:
    types: [published]

jobs:
  update-docs:
    uses: photon-hq/buildspace/.github/workflows/update-docs.yaml@main
    with:
      service-name: my-service
    secrets: inherit
```

---

## How Releases Work

### Single-Package Workflows

`rust-service-release`, `typescript-service-release`, `go-binary-release`, and `swift-release` all share the same initial steps then diverge for language-specific publishing:

```
                        ╔═══════════════════════════════════════════════════╗
                        ║              SHARED STEPS (all workflows)         ║
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
║   rust-service-release                ║            ║   typescript-service-release            ║
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

### Monorepo Workflow

`typescript-monorepo-release` extends the single-package pattern to handle multiple independently-versioned packages:

- **Change detection** — only packages with file changes (and optionally their dependents) are released
- **Topological ordering** — packages are processed in dependency order so downstream consumers see new versions of their dependencies
- **Single AI call** — one prompt contains all packages and their scoped commits, producing versions and notes in one shot
- **Date-based tags** — since there's no single version, releases use `release/YYYY-MM-DD.N` tags
- **`workspace:*` protocol** — left untouched; Bun/npm resolves these to real versions at pack-time

---

## Blocks (Composite Actions)

Individual building blocks that the workflows above are assembled from. Use these directly when you need a custom pipeline.

<details>
<summary><strong>Expand all blocks</strong></summary>

---

### check-pr-label

**Path:** `.github/blocks/check-pr-label/action.yaml`

Decides whether a PR should trigger a release based on its labels. Works on both PR events and push events (looks up the merged PR).

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `labels` | string | Yes | — | JSON array of labels to check (e.g., `["release", "prerelease"]`) |
| `default-on-push` | string | No | `""` | Comma-separated labels to default to `true` on direct push |

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

### check-readme

**Path:** `.github/blocks/check-readme/action.yaml`

Uses AI to read the project's `README.md` alongside the PR's changed files and determine whether the documentation needs updating. Returns a boolean verdict and a one-sentence explanation. This is the block that powers the [Check README workflow](#check-readme).

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `openai-api-key` | secret | Yes | — | OpenAI API key |

#### Outputs

| Output | Type | Description |
|--------|------|-------------|
| `up-to-date` | boolean | `true` if the README appears current, `false` if it likely needs changes |
| `explanation` | string | One-sentence AI explanation of the verdict |

#### Usage

```yaml
- uses: actions/checkout@v5

- uses: photon-hq/buildspace/.github/blocks/check-readme@main
  id: readme
  with:
    openai-api-key: ${{ secrets.OPENAI_API_KEY }}

- if: steps.readme.outputs.up-to-date == 'false'
  run: echo "README needs updating — ${{ steps.readme.outputs.explanation }}"
```

---

### generate-release-info

**Path:** `.github/blocks/generate-release-info/action.yaml`

Generates a semantic version number and AI-written release notes by analyzing commit history since the last release. Combines `determine-publish-version` with release note generation in one step.

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `service-name` | string | Yes | — | Service name (used in release notes) |
| `prerelease` | boolean | No | `false` | Append `-rc.N` suffix to version |
| `openai-api-key` | secret | Yes | — | OpenAI API key |

#### Outputs

| Output | Type | Description |
|--------|------|-------------|
| `version` | string | Determined version (e.g., `1.2.3` or `1.2.3-rc.5`) |
| `release_notes` | string | AI-generated release notes in markdown |

#### Usage

```yaml
- uses: actions/checkout@v5
  with:
    fetch-depth: 0

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

Standalone action for determining the next semantic version using AI analysis of commits. Lighter-weight alternative to `generate-release-info` when you don't need release notes.

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `prerelease` | boolean | No | `false` | Append `-rc.N` suffix to version |
| `openai-api-key` | secret | Yes | — | OpenAI API key |

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
| `version` | string | Yes | — | Version number (e.g., `1.2.3`) |
| `title` | string | Yes | — | Release title |
| `notes` | string | No | `""` | Release notes in markdown |
| `prerelease` | boolean | No | `false` | Mark as prerelease |
| `draft` | boolean | No | `false` | Create as draft |
| `tag-prefix` | string | No | `v` | Prefix for git tag (e.g., `v1.2.3`) |
| `artifact-pattern` | string | No | `""` | Pattern to match artifacts to attach |

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
    artifact-pattern: "my-binary-*"
```

---

### detect-changed-packages

**Path:** `.github/blocks/detect-changed-packages/action.yaml`

Detects which monorepo packages have changed since the last GitHub Release and returns them in topological (dependency) order. Optionally includes downstream dependents.

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `packages` | string | Yes | — | JSON array: `[{"name":"pkg","path":"packages/pkg"}]` |
| `include-dependents` | boolean | No | `false` | Also include packages that depend on changed packages |

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

Determines versions for all changed monorepo packages using a single AI call, bumps each `package.json`, commits, and pushes.

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `changed-packages` | string | Yes | — | JSON array from `detect-changed-packages` output |
| `service-name` | string | Yes | — | Service name for commit messages |
| `prerelease` | boolean | No | `false` | Append `-rc.N` suffix to versions |
| `openai-api-key` | secret | Yes | — | OpenAI API key |
| `github-token` | secret | Yes | — | GitHub token (fallback) |
| `app-id` | secret | No | `""` | GitHub App ID (for protected branches) |
| `app-private-key` | secret | No | `""` | GitHub App private key |

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
| `changed-packages` | string | Yes | — | JSON array of packages in topological order |
| `bun-version` | string | No | `latest` | Bun version |
| `node-version` | string | No | `20` | Node.js version |
| `tag` | string | No | `latest` | npm dist-tag |
| `build-command` | string | No | `bun run build` | Per-package build command (ignored if `root-build-command` is set) |
| `root-build-command` | string | No | `""` | Build once at repo root (e.g., `turbo build`) |
| `dry-run` | boolean | No | `false` | Run `npm publish --dry-run` |
| `npm-token` | secret | Yes | — | npm authentication token |

#### Usage

```yaml
- uses: photon-hq/buildspace/.github/blocks/publish-npm-packages@main
  with:
    changed-packages: ${{ steps.detect.outputs.changed }}
    root-build-command: "turbo build"
    npm-token: ${{ secrets.NPM_TOKEN }}
```

---

### rust-build

**Path:** `.github/blocks/rust-build/action.yaml`

Builds a Rust binary for a specific target platform.

| Target | OS |
|--------|----|
| `x86_64-unknown-linux-gnu` | Linux (x64) |
| `aarch64-apple-darwin` | macOS (ARM64) |
| `x86_64-pc-windows-msvc` | Windows (x64) |

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `binary-name` | string | Yes | — | Name of the binary (from `Cargo.toml`) |
| `binary-path` | string | No | `""` | Path to crate directory |
| `target` | string | Yes | — | Target triple |
| `build-env` | string | No | `""` | Compile-time env vars for `.env` file |

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
    target: x86_64-unknown-linux-gnu
```

---

### typescript-build

**Path:** `.github/blocks/typescript-build/action.yaml`

Builds a TypeScript project using Bun.

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `bun-version` | string | No | `latest` | Bun version |
| `working-directory` | string | No | `.` | Directory containing `package.json` |
| `build-command` | string | No | `bun run build` | Build command |

#### Usage

```yaml
- uses: photon-hq/buildspace/.github/blocks/typescript-build@main
  with:
    build-command: "npm run build"
```

---

### sync-crates-version

**Path:** `.github/blocks/sync-crates-version/action.yaml`

Sets a single version across all workspace crates using `cargo-edit`, commits, and pushes.

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `version` | string | Yes | — | Version to set across all crates |
| `commit-changes` | boolean | No | `true` | Whether to commit and push |
| `github-token` | secret | Yes | — | GitHub token for pushing |

#### Outputs

| Output | Type | Description |
|--------|------|-------------|
| `updated-crates` | JSON | Array of crate names that were updated |

#### Usage

```yaml
- uses: photon-hq/buildspace/.github/blocks/sync-crates-version@main
  with:
    version: "1.2.3"
    github-token: ${{ github.token }}
```

---

### publish-crates

**Path:** `.github/blocks/publish-crates/action.yaml`

Publishes workspace crates to crates.io in dependency order with retry logic and rate limit handling.

> **Order matters.** List dependencies before dependents.

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `crates` | string | Yes | — | JSON array of crate paths in publish order |
| `dry-run` | boolean | No | `false` | Run `cargo publish --dry-run` |
| `cargo-registry-token` | secret | Yes | — | crates.io API token |

#### Usage

```yaml
- uses: photon-hq/buildspace/.github/blocks/publish-crates@main
  with:
    crates: '["crates/shared", "crates/client"]'
    cargo-registry-token: ${{ secrets.CARGO_REGISTRY_TOKEN }}
```

---

### publish-npm

**Path:** `.github/blocks/publish-npm/action.yaml`

Publishes a single package to npm (installs dependencies, builds, publishes).

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `bun-version` | string | No | `latest` | Bun version |
| `node-version` | string | No | `20` | Node.js version |
| `working-directory` | string | No | `.` | Directory containing `package.json` |
| `build-command` | string | No | `bun run build` | Build command |
| `tag` | string | No | `latest` | npm dist-tag |
| `dry-run` | boolean | No | `false` | Run `npm publish --dry-run` |
| `npm-token` | secret | Yes | — | npm authentication token |

#### Usage

```yaml
- uses: photon-hq/buildspace/.github/blocks/publish-npm@main
  with:
    build-command: "npm run build"
    npm-token: ${{ secrets.NPM_TOKEN }}
```

---

### comment-on-pr

**Path:** `.github/blocks/comment-on-pr/action.yaml`

Posts or updates a single comment on a pull request. When a `comment-key` is provided, subsequent calls with the same key update the existing comment instead of creating a new one.

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `message` | string | Yes | — | Comment body (markdown supported) |
| `comment-key` | string | No | `""` | Unique key to find and update an existing comment |

#### Usage

```yaml
- uses: photon-hq/buildspace/.github/blocks/comment-on-pr@main
  with:
    comment-key: my-build-status
    message: |
      ## Build Status
      All checks passed for commit ${{ github.sha }}
```


---

### update-docs

**Path:** `.github/blocks/update-docs/action.yaml`

Uses [Claude Code Action](https://github.com/anthropics/claude-code-action) to analyze release changes and submit a PR to a documentation repository. Clones the docs repo, runs Claude Code via `anthropics/claude-code-action@v1` to identify and make documentation updates, then creates a PR if changes were made. Expects a pre-generated `github-token` with write access to the docs repo (the `update-docs` workflow handles token generation automatically from org secrets).

#### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `service-name` | string | Yes | — | Name of the service that was released |
| `version` | string | Yes | — | The released version (e.g., `1.2.3`) |
| `release-tag` | string | Yes | — | The raw release tag (e.g., `v1.2.3`). Used for linking back to the release. |
| `release-notes` | string | Yes | — | Release notes markdown from the release |
| `changes-diff` | string | Yes | — | Git diff of changes in this release |
| `docs-repo` | string | No | `photon-hq/docs` | Target docs repository (`owner/repo`) |
| `docs-branch` | string | No | `main` | Base branch of the docs repo |
| `anthropic-api-key` | secret | Yes | — | Anthropic API key for Claude Code |
| `github-token` | secret | Yes | — | GitHub token with write access to the docs repo |

#### Outputs

| Output | Type | Description |
|--------|------|-------------|
| `pr-url` | string | URL of the created PR (empty if no changes needed) |
| `has-changes` | string | `'true'` or `'false'` whether docs updates were generated |

#### Usage

```yaml
- uses: photon-hq/buildspace/.github/blocks/update-docs@main
  with:
    service-name: my-service
    version: '1.2.3'
    release-tag: 'v1.2.3'
    release-notes: 'Added new feature X'
    changes-diff: ${{ steps.diff.outputs.diff }}
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    github-token: ${{ steps.app-token.outputs.token }}
```

</details>

---

## Architecture

```
buildspace/
├── .github/
│   ├── blocks/                        # Composite actions (building blocks)
│   │   ├── bump-monorepo-versions/    # AI version bump for monorepos
│   │   ├── check-pr-label/            # PR label detection
│   │   ├── check-readme/              # AI README freshness check
│   │   ├── comment-on-pr/             # Post/update PR comments
│   │   ├── create-github-release/     # GitHub Release creation
│   │   ├── detect-changed-packages/   # Monorepo change detection + topo-sort
│   │   ├── determine-publish-version/ # AI version detection (standalone)
│   │   ├── generate-release-info/     # AI version + release notes
│   │   ├── go-build/                  # Go cross-compilation
│   │   ├── publish-crates/            # crates.io publishing
│   │   ├── publish-npm/               # npm publishing (single package)
│   │   ├── publish-npm-packages/      # npm publishing (monorepo, ordered)
│   │   ├── rust-build/                # Cross-platform Rust builds
│   │   ├── swift-build/               # Swift binary builds
│   │   ├── swift-pkg/                 # macOS .pkg creation
│   │   ├── sync-crates-version/       # Workspace version sync
│   │   ├── typescript-build/          # TypeScript builds
│   │   └── update-docs/               # AI docs update via Claude Code
│   │
│   └── workflows/                     # Reusable workflows (full pipelines)
│       ├── check-readme.yaml          # AI README freshness check (PR)
│       ├── go-service-release.yaml    # Complete Go release pipeline
│       ├── rust-service-release.yaml  # Complete Rust release pipeline
│       ├── pkg-release.yml             # .pkg release pipeline (no binary)
│       ├── pkg-release-pr.yml         # .pkg PR build (no binary)
│       ├── self-release.yaml          # Buildspace's own versioned releases
│       ├── swift-pkg-pr.yml           # Swift .pkg build on every PR commit
│       ├── swift-release.yml          # Swift .pkg release pipeline
│       ├── typescript-monorepo-release.yaml  # Complete TS monorepo pipeline
│       ├── typescript-service-release.yaml   # Complete TS release pipeline
│       └── update-docs.yaml                  # AI docs update on release
```

---

## Contributing

1. Create a feature branch from `main`
2. Make your changes
3. Test locally or in a test repository
4. Open a PR with a clear description
5. Add the `release` label when ready to publish

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

## License

MIT © [Photon](https://github.com/photon-hq)
