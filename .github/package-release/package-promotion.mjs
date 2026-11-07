import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import semver from "semver";
import { parse as parseToml } from "smol-toml";
import {
  cached, DEPENDENCY_FIELDS, exec, MANIFEST, matchesPackage, notFound, readCrate,
  readManifest, readTarballManifest, registryMetadata, releaseNames, sha256,
  STABLE, verifyManifest,
} from "./package-artifacts.mjs";
import { changesSince, tagCommit } from "./package-publish.mjs";

const IMAGE_TAG = /^(?:main|hotfix-[a-f0-9]{40})-([a-f0-9]{40})$/;
const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const EXACT_STABLE = /^=\s*(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CRATE_DEPENDENCY_TABLES = ["dependencies", "build-dependencies", "build_dependencies"];

/** Findings that keep a candidate from production: internal dependencies on unreleased builds. */
export async function dependencyFindings(candidates, selection, registry) {
  const promoted = new Map(candidates.map(({ name, version }) => [name, version]));
  const findings = [];
  for (const { name, manifest } of candidates) {
    for (const field of DEPENDENCY_FIELDS)
      for (const [dependency, spec] of Object.entries(manifest[field] ?? {})) {
        if (!matchesPackage(dependency, selection)) continue;
        if (!STABLE.test(spec)) {
          findings.push(`${name} ${field}: ${dependency}@${spec} is not an exact stable version`);
          continue;
        }
        if (promoted.has(dependency)) {
          if (promoted.get(dependency) !== spec)
            findings.push(`${name} ${field}: ${dependency}@${spec} differs from the promoted ${promoted.get(dependency)}`);
          continue;
        }
        const release = (await registry(dependency)).versions[spec];
        if (!release) findings.push(`${name} ${field}: ${dependency}@${spec} is not published`);
        else if (release.deprecated) findings.push(`${name} ${field}: ${dependency}@${spec} is deprecated`);
      }
    for (const [dependency, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (!matchesPackage(dependency, selection)) continue;
      if (!semver.validRange(range)) {
        findings.push(`${name} peerDependencies: ${dependency}@${range} is not a version range`);
        continue;
      }
      if (promoted.has(dependency)) {
        if (!semver.satisfies(promoted.get(dependency), range))
          findings.push(`${name} peerDependencies: the promoted ${dependency}@${promoted.get(dependency)} does not satisfy ${range}`);
        continue;
      }
      const satisfied = Object.entries((await registry(dependency)).versions).some(
        ([version, release]) => STABLE.test(version) && !release.deprecated && semver.satisfies(version, range)
      );
      if (!satisfied)
        findings.push(`${name} peerDependencies: no published stable ${dependency} satisfies ${range}`);
    }
  }
  return findings;
}

/**
 * The crates of the latest production release, the one the primary package's
 * `latest` names, as a lookup by crate name.
 */
export function releasedCrates({ repository, latest, run = exec }) {
  const tag = latest && `v${latest}`;
  let directory;
  let crates;
  return async (name) => {
    if (!tag) return undefined;
    if (!crates) {
      directory = await mkdtemp(join(tmpdir(), "released-crates-"));
      try {
        run("gh", ["release", "download", tag, "--repo", repository, "--pattern", MANIFEST, "--dir", directory, "--clobber"]);
        ({ crates } = await readManifest(directory));
      } catch (error) {
        if (!notFound(error, /release not found|no assets/i)) throw error;
        crates = [];
      }
    }
    const crate = crates.find((entry) => entry.name === name);
    if (!crate) return undefined;
    run("gh", ["release", "download", tag, "--repo", repository, "--pattern", crate.file, "--dir", directory, "--clobber"]);
    const path = join(directory, crate.file);
    if (sha256(await readFile(path)) !== crate.sha256) throw new Error(`${tag}: ${crate.file} does not match its release manifest`);
    return { tag, version: crate.version, digest: readCrate(path).digest };
  };
}

/**
 * A crate keeps its version only while its contents are unchanged, and
 * otherwise moves forward by at least the level of the build's bump. Cargo
 * reads a crate's version from its source at the release tag, so the version
 * is the one in Cargo.toml; the bump only says how far it must move.
 */
export async function crateVersionFindings(manifest, directory, released) {
  const level = [undefined, "none"].includes(manifest.bump?.level) ? "patch" : manifest.bump.level;
  const findings = [];
  for (const crate of manifest.crates) {
    const previous = await released(crate.name);
    if (!previous || previous.digest === readCrate(join(directory, crate.file)).digest) continue;
    const lowest = semver.inc(previous.version, level);
    if (previous.version === crate.version)
      findings.push(`${crate.name} ${crate.version} is already released in ${previous.tag} with other contents; set its Cargo.toml version to at least ${lowest} and stage again`);
    else if (!semver.gt(crate.version, previous.version))
      findings.push(`${crate.name} ${crate.version} is not newer than ${previous.version} in ${previous.tag}; set its Cargo.toml version to at least ${lowest} and stage again`);
    else if (semver.lt(crate.version, lowest))
      findings.push(`${crate.name} ${crate.version} is below ${lowest}, which a ${level} change since ${previous.tag} requires; set its Cargo.toml version to at least ${lowest} and stage again`);
  }
  return findings;
}

/** The workspace manifest a crate inherits from, read lazily at the build's source commit. */
export function workspaceManifest({ repository, sourceSha, crate, run = exec }) {
  let workspace;
  return async () => {
    if (workspace) return workspace;
    const own = parseToml(crate.original);
    if (own.workspace) return (workspace = own);
    const directories = [];
    if (typeof own.package?.workspace === "string")
      directories.push(posix.normalize(posix.join(crate.path ?? "", own.package.workspace)));
    else
      for (let directory = crate.path ?? ""; directory !== "." && directory !== ""; ) {
        directory = posix.dirname(directory);
        directories.push(directory);
      }
    for (const directory of directories) {
      const file = directory === "." ? "Cargo.toml" : `${directory}/Cargo.toml`;
      let text;
      try {
        text = run("gh", [
          "api",
          "-H",
          "Accept: application/vnd.github.raw+json",
          `repos/${repository}/contents/${file.split("/").map(encodeURIComponent).join("/")}?ref=${sourceSha}`,
        ]);
      } catch (error) {
        if (notFound(error)) continue;
        throw error;
      }
      const manifest = parseToml(text);
      if (manifest.workspace) return (workspace = manifest);
    }
    throw new Error(`${crate.name} inherits from a workspace, but no workspace manifest is above ${crate.path || "the repository root"}`);
  };
}

/**
 * Findings that keep a crate from production: a normal or build dependency
 * fetched from one of the owner's repositories that is not pinned to a release
 * tag and an exact stable version. Cargo resolves internal crates from Git, so
 * the tag is their release.
 */
export async function crateDependencyFindings({ crate, owner, workspace }) {
  const manifest = parseToml(crate.original);
  const internal = new RegExp(`^(?:https?|ssh|git)://(?:[^@/]+@)?github\\.com[:/]${owner}/`, "i");
  const findings = [];
  for (const section of [manifest, ...Object.values(manifest.target ?? {})])
    for (const table of CRATE_DEPENDENCY_TABLES)
      for (const [key, declared] of Object.entries(section?.[table] ?? {})) {
        let dependency = typeof declared === "string" ? { version: declared } : declared;
        if (dependency.workspace === true) {
          const inherited = (await workspace()).workspace?.dependencies?.[key];
          dependency = { ...(typeof inherited === "string" ? { version: inherited } : inherited), ...dependency };
        }
        if (!internal.test(dependency.git ?? "")) continue;
        const subject = `${crate.name} ${table}: ${dependency.package ?? key}`;
        const reference =
          dependency.rev !== undefined ? `rev ${dependency.rev}`
          : dependency.branch !== undefined ? `branch ${dependency.branch}`
          : dependency.tag !== undefined ? `tag ${dependency.tag}`
          : "its default branch";
        if (!RELEASE_TAG.test(dependency.tag ?? "") || dependency.rev !== undefined || dependency.branch !== undefined)
          findings.push(`${subject} must pin a release tag vX.Y.Z of ${dependency.git}, not ${reference}`);
        if (!EXACT_STABLE.test(dependency.version ?? ""))
          findings.push(`${subject} must require an exact stable version (=X.Y.Z), not ${dependency.version ?? "any version"}`);
      }
  return findings;
}

/**
 * Find a staging build's candidates and prove they may become production:
 * built by the stage workflow from main, unchanged, newer than `latest`, and
 * depending only on released packages.
 */
/**
 * The staging build a main commit carries: the newest one staged at that commit
 * or at an ancestor. A repository that stages only the commits that change its
 * packages has no build of its own for the commits in between, and none of
 * them may have a stage run that published nothing.
 */
export function stagedBuild({ repository, names, sourceSha, run = exec }) {
  const api = (path) => JSON.parse(run("gh", ["api", path]));
  const known = new Map([[sourceSha, true]]);
  const carried = (commit) => {
    if (!known.has(commit))
      known.set(commit, api(`repos/${repository}/compare/${commit}...${sourceSha}`).status === "ahead");
    return known.get(commit);
  };
  const builds = [];
  for (let page = 1; ; page++) {
    const refs = api(`repos/${repository}/git/matching-refs/tags/${names.tagPrefix}?per_page=100&page=${page}`);
    for (const { ref, object } of refs) {
      const tag = ref.slice("refs/tags/".length);
      const coordinates = /-staging\.(\d+)\.(\d+)$/.exec(tag);
      if (coordinates && semver.valid(tag.slice(names.tagPrefix.length)))
        builds.push({ tag, object, runId: Number(coordinates[1]), attempt: Number(coordinates[2]) });
    }
    if (refs.length < 100) break;
  }
  builds.sort((left, right) => right.runId - left.runId || right.attempt - left.attempt);
  const build = builds.find(({ tag, object }) =>
    carried(object.type === "commit" ? object.sha : tagCommit(run, repository, tag))
  );
  if (!build) throw new Error(`${names.primary} has no staging build at or before ${sourceSha}`);
  const { workflow_id: workflow } = api(`repos/${repository}/actions/runs/${build.runId}`);
  for (let page = 1; page <= 10; page++) {
    const { workflow_runs: runs } = api(
      `repos/${repository}/actions/workflows/${workflow}/runs?branch=main&event=push&per_page=100&page=${page}`
    );
    for (const later of runs) {
      if (later.id <= build.runId) return build.tag.slice(names.tagPrefix.length);
      if (carried(later.head_sha))
        throw new Error(
          `${later.html_url} staged ${later.head_sha} after ${build.tag} and published no build (${later.conclusion ?? later.status}); rerun it, or promote a commit before it`
        );
    }
    if (runs.length < 100) return build.tag.slice(names.tagPrefix.length);
  }
  throw new Error(`${build.tag} is more than 1000 stage runs old; promote it by its staging version`);
}

/**
 * Promotion waits for people: the environment must exist and require a
 * reviewer, unless a trusted actor's own dispatch is the approval.
 */
export function requireReviewers({ repository, environment, approvedBy = "", run = exec }) {
  if (approvedBy) return;
  let rules;
  try {
    rules = JSON.parse(run("gh", ["api", `repos/${repository}/environments/${environment}`])).protection_rules ?? [];
  } catch (error) {
    if (!notFound(error)) throw error;
    rules = [];
  }
  if (!rules.some((rule) => rule.type === "required_reviewers" && rule.reviewers?.length))
    throw new Error(`The ${environment} environment must exist and require a reviewer before anything is promoted`);
}

/**
 * Find the candidates to promote and prove where they came from. `pending` is
 * false when there is nothing left to publish: a hotfix image, whose packages
 * are not staged, or a build whose candidates are all released already.
 */
export async function resolveCandidate({
  repository,
  packageInput,
  tagPrefix,
  productionTagPrefix,
  registryUrl,
  version: requested,
  imageTag = "",
  approvedBy = "",
  environment,
  signerWorkflow,
  output,
  run = exec,
  registry,
}) {
  const names = releaseNames(repository, packageInput, tagPrefix, productionTagPrefix, registryUrl);
  const sourceSha = IMAGE_TAG.exec(imageTag)?.[1];
  if (imageTag && requested) throw new Error("Supply a staging version or an image tag, not both");
  if (imageTag && !sourceSha) throw new Error("Invalid immutable image tag");
  if (sourceSha && !imageTag.startsWith("main-")) return { pending: false };
  requireReviewers({ repository, environment, approvedBy, run });
  const lookup = cached(registry ?? registryMetadata(names.registryUrl));
  const version =
    requested ||
    (sourceSha
      ? stagedBuild({ repository, names, sourceSha, run })
      : (await lookup(names.primary))["dist-tags"].staging);
  if (!version) throw new Error(`${names.primary} has no staging build`);
  const tag = `${names.tagPrefix}${version}`;
  await mkdir(output, { recursive: true });
  try {
    run("gh", ["release", "download", tag, "--repo", repository, "--pattern", MANIFEST, "--dir", output, "--clobber"]);
  } catch (error) {
    if (notFound(error, /release not found|no assets/i))
      throw new Error(`${tag} has no promotion candidates; only builds from the buildspace stage workflow can be promoted`);
    throw error;
  }
  const manifest = await readManifest(output);
  const primary = manifest.packages.find(({ name }) => name === names.primary);
  if (manifest.stagingTag !== tag || primary?.staging.version !== version)
    throw new Error(`The manifest attached to ${tag} does not describe ${names.primary}@${version}`);
  if (tagCommit(run, repository, tag) !== manifest.sourceSha)
    throw new Error(`${tag} no longer names the commit it was built from`);
  const { status } = JSON.parse(run("gh", ["api", `repos/${repository}/compare/${manifest.sourceSha}...main`]));
  if (!["ahead", "identical"].includes(status))
    throw new Error(`${manifest.sourceSha} is not in the history of main`);
  const files = [...manifest.packages.map((pkg) => pkg.production.file), ...manifest.crates.map(({ file }) => file)];
  for (const file of files)
    run("gh", ["release", "download", tag, "--repo", repository, "--pattern", file, "--dir", output, "--clobber"]);
  await verifyManifest(output, manifest, { repository, packageInput, tagPrefix, productionTagPrefix, registryUrl, channels: ["production"] });
  for (const file of files)
    run("gh", [
      "attestation",
      "verify",
      join(output, file),
      "--repo",
      repository,
      "--signer-workflow",
      signerWorkflow,
      "--source-digest",
      manifest.sourceSha,
      "--source-ref",
      "refs/heads/main",
    ]);
  const candidates = manifest.packages.map((pkg) => ({
    name: pkg.name,
    version: pkg.production.version,
    manifest: readTarballManifest(join(output, pkg.production.file)),
  }));
  const findings = await dependencyFindings(candidates, names.selection, lookup);
  const restage = manifest.bump
    ? "stage a newer build, from a change inside the build's paths or a Release-As"
    : "bump the version and stage again";
  let published = true;
  for (const pkg of manifest.packages) {
    const { version: candidate, integrity: expected } = pkg.production;
    const metadata = await lookup(pkg.name);
    const existing = metadata.versions[candidate];
    const latest = metadata["dist-tags"].latest;
    if (existing && existing.dist?.integrity !== expected)
      findings.push(`${pkg.name}@${candidate} is already published with different contents; ${restage}`);
    else if (!existing && latest && !semver.gt(candidate, latest))
      findings.push(`${pkg.name}@${candidate} is not newer than latest ${latest}; ${restage}`);
    published &&= Boolean(existing) && Boolean(latest) && !semver.gt(candidate, latest);
  }
  const latest = (await lookup(names.primary))["dist-tags"].latest;
  findings.push(...(await crateVersionFindings(manifest, output, releasedCrates({ repository, latest, run }))));
  for (const { file } of manifest.crates) {
    const crate = readCrate(join(output, file));
    const workspace = workspaceManifest({ repository, sourceSha: manifest.sourceSha, crate, run });
    findings.push(...(await crateDependencyFindings({ crate, owner: repository.split("/")[0], workspace })));
  }
  if (findings.length)
    throw new Error(`${tag} cannot be promoted:\n${findings.map((finding) => `- ${finding}`).join("\n")}`);
  const changes =
    !manifest.bump && latest && latest !== primary.production.version
      ? changesSince(run, repository, `${names.productionTagPrefix}${latest}`, manifest.sourceSha)
      : undefined;
  return { manifest, changes, pending: !(published && productionReleaseExists(run, manifest)) };
}

/**
 * Whether the production release of these candidates exists. An earlier build
 * may have made it: identical packages keep the tag of the commit that first
 * released them. Crates are released by the tag itself, so theirs must be this
 * build's.
 */
function productionReleaseExists(run, manifest) {
  const commit = tagCommit(run, manifest.repository, manifest.productionTag);
  if (commit === undefined || (manifest.crates.length && commit !== manifest.sourceSha)) return false;
  try {
    const release = run("gh", ["release", "view", manifest.productionTag, "--repo", manifest.repository, "--json", "assets,isPrerelease"]);
    return JSON.parse(release).isPrerelease === false;
  } catch (error) {
    if (notFound(error, /release not found/i)) return false;
    throw error;
  }
}
