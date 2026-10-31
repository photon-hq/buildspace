# Release-label compatibility and removal tracker

Part of [ENG-4709](https://linear.app/photonhq/issue/ENG-4709/audit-buildspace-and-remove-obsolete-release-label-handling),
under [ENG-4708](https://linear.app/photonhq/issue/ENG-4708).
The audit checked buildspace at `317f4261d955ce61fc0248619b08de0b9ece32aa`
and fetched the current default-branch contents of the indexed callers on
2026-10-30.

The snapshot found 31 non-archived repositories calling the eight reusable
workflows below, plus five calling the checker directly. One archived caller is
listed separately. These are configured consumers, not evidence of successful
recent runs. Default-branch code search does not cover every historical pin,
other branch, or third-party consumer.

## Completed cleanup

Buildspace's own registered `release` label was removed on 2026-10-30.
No `prerelease`, `pre release`, or `pre-release` label was registered there.
Its only autonomous workflow is PR CI; the other workflows are reusable entry
points, not buildspace's own release pipeline. Merging to `main` publishes
buildspace without a release label.

This does not remove a calling repository's labels. The checker reads
`context.repo`, which is the caller. Caller label objects and executable
release gates remain unchanged in this cleanup.

The README now recommends stage/promote for supported package and Swift
products. The generic checker describes label inspection rather than a release
policy.

Two options that no audited caller used were removed: the checker's
`default-on-push` input and the `labels-to-check` input of six wrappers. Those
wrappers now pass their fixed label lists directly, as `pkg-release.yml` and
`makefile-dylib-release.yml` already did. A caller that still passes
`labels-to-check` to a wrapper fails GitHub's input validation. Everything
else is unchanged: the other inputs, outputs, API error handling, and all
eight label gates.

## Workflow rules

Every path in this table is under `.github/workflows/`. Each wrapper first
runs `check-labels`, which forwards the checker's JSON-encoded string as
`outputs.labels`.

- **R** means `labels.release || inputs.release`.
- **P** means `labels.prerelease || inputs.prerelease`.
- The input booleans default to `false` where exposed.

| Workflow | Requested labels | Entry gate | Result after authorization |
|---|---|---|---|
| `release.yaml` | `release` | R | Generates version/notes and creates a stable GitHub Release. |
| `typescript-service-release.yaml` | `release`, `prerelease` | R | Bumps the package, creates a GitHub Release, and runs enabled registry publishers. P selects RC/beta mode. |
| `typescript-monorepo-release.yaml` | `release`, `prerelease` | R or P | Detects changes, independently versions changed packages, and publishes them. P selects RC/beta mode. |
| `rust-service-release.yaml` | `release`, `prerelease` | R | Builds binaries, synchronizes Cargo versions, releases/publishes crates, and optionally updates Homebrew. P selects RC mode. |
| `go-service-release.yaml` | `release`, `prerelease` | R | Builds binaries, creates a GitHub Release, and optionally updates Homebrew. P selects RC mode. |
| `swift-release.yml` | `release`, `prerelease` | R or P | Builds/releases a Swift package. P selects RC mode and skips Jamf. |
| `pkg-release.yml` | Hard-coded `release` | Release label only | Packages payload/scripts, creates a GitHub Release, and optionally uploads to Jamf. |
| `makefile-dylib-release.yml` | Hard-coded `release` | Release label only | Builds a Makefile dylib and creates a GitHub Release. |

Each wrapper passes a fixed label list to the checker and reads the fixed
`release` and `prerelease` keys. The checker lowercases names but does not turn
`pre release` or `pre-release` into `prerelease`.

`release: true` does not force stable mode when P is true. It also does not
bypass a failed checker job. A prerelease label/input alone starts only the
monorepo and Swift chains; single-package TypeScript, Rust, and Go still need R.

The checker's only input, `labels`, accepts arbitrary names and returns only
the requested lowercase boolean keys. A push or manual run with no matching
merged PR returns `false` for every requested label. An owning PR with none of
the requested labels returns the same results. API failures and multiple merged
PRs matching the commit and base branch fail the checker without emitting
`labels`.

Legacy publisher `dry-run` is not a pipeline-wide write prohibition: version
commits and GitHub Releases can still occur. Configured Rust Homebrew updates
can still commit and push formula changes. `no-npm-publish` disables npmjs
publication, not version commits or GitHub Releases. Removing a label gate
without a replacement can enable stable publishing or Jamf delivery on every
invocation.

## Remaining consumers

The 2026-10-30 snapshot found the following non-archived default-branch
consumers. All audited references used `@main`.

| Compatibility workflow | Repository count |
|---|---:|
| `release.yaml` | 2 |
| `typescript-service-release.yaml` | 20 |
| `typescript-monorepo-release.yaml` | 1 |
| `rust-service-release.yaml` | 2 |
| `go-service-release.yaml` | 1 |
| `swift-release.yml` | 1 |
| `pkg-release.yml` | 1 |
| `makefile-dylib-release.yml` | 3 |

Five additional repositories call `check-pr-label@main` directly, and one
archived repository still contains a legacy workflow caller. Migrating only the
shared wrappers would not replace those five repositories' own gate logic.

Repository-specific caller paths, source evidence, and registered-label findings
are tracked in [ENG-4709](https://linear.app/photonhq/issue/ENG-4709).
Buildspace is public, so this document does not publish internal consumer names
or source links. Revalidate the issue's inventory before deleting shared code;
the counts above are an audit snapshot, not a live registry.

## Keep unrelated label rules

A repository can use the `release` label for an independent automation rule
even after its own package pipeline moves to stage/promote. An empty set of
currently labeled open issues/PRs does not prove that such a rule is unused.
Read workflow-called scripts and external integration rules before deleting a
repository's label object.

GitHub prerelease properties, `-staging.*` versions, registry
`staging`/`latest` tags, Buf's `prerelease` label, OCI image labels, and
production-dependency prerelease rejection are not obsolete PR-label
authorization. They remain intact.

## Removal conditions

1. Re-read each caller's current default-branch files, including workflow-called
   scripts and automations. Check its manual entry points, version/output
   consumers, label objects, and open issues/PRs before deleting a label.
2. Move supported npm packages to `package-stage.yml`/`package-promote.yml`,
   preserving package scope, registry, outputs, and dependency requirements.
   Move supported Swift executables/libraries to
   `swift-stage.yml`/`swift-promote.yml`. The monorepo workflow's independent
   versions differ from modern shared build versions.
3. Design replacements for standalone Go/Rust binaries, crates.io publishing,
   Makefile dylibs, and payload-only packages before retiring their workflows.
   Modern package staging requires npm packages, and its optional Rust crates
   are released by Git tag. Swift staging has no payload-only package mode.
4. Validate the replacement's dry run, first staged build, stored-candidate
   promotion, and production approval path. Legacy RC artifacts cannot be
   promoted as modern candidates without the expected manifests and provenance.
   Only then remove the caller's obsolete labels if no independent rule uses
   them.
5. Recheck every wrapper and direct checker consumer before removing shared
   compatibility code. A historical wrapper SHA is not sufficient isolation:
   all eight wrappers reference `check-pr-label@main`, and their other blocks
   also commonly use `@main`. Third-party consumers need compatibility review.
6. Retire a wrapper's checker job, label outputs, `needs` edges, conditions,
   mode selection, docs, and tests together. Preserve unrelated success,
   no-change, registry opt-in, source-integrity, reviewer, and Jamf-ordering
   checks. The generic checker can remain a composable utility after release
   callers no longer need it.

## Revalidation

Search each of the eight workflow paths and the checker path in the
organization. For example:

```bash
gh api --method GET search/code -f 'q=org:photon-hq "photon-hq/buildspace/.github/blocks/check-pr-label"' -f per_page=100 --paginate
```

Code search is indexed evidence, not a live contents check. Fetch each returned
caller's contents from its current default branch and check whether the
repository is archived. A missing search result does not establish that a
third-party or historical consumer is gone.

Offline regression coverage:

```bash
python3 -m unittest discover -s test -p 'test_release_label_policy.py'
python3 -m unittest discover -s test -p 'test_pr_association.py'
```

These tests protect the label-free modern workflows, buildspace's own lack of a
label-driven release pipeline, the remaining compatibility gates, generic label
inspection, and the inventory's coverage of internal checker consumers. Existing
stage/promote and publisher tests continue to protect real prerelease channels
and production approval.
