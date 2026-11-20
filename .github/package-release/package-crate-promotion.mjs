import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import semver from "semver";
import { parse as parseToml } from "smol-toml";
import {
  exec,
  MANIFEST,
  notFound,
  readCrate,
  readManifest,
  sha256,
} from "./package-artifacts.mjs";

const RELEASE_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const EXACT_STABLE = /^=\s*(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

const CRATE_DEPENDENCY_TABLES = [
  "dependencies",
  "build-dependencies",
  "build_dependencies",
];

/**
 * The crates of the latest production release, the one the primary package's
 * `latest` names, as a lookup by crate name.
 */
export const releasedCrates = function releasedCrates({
  repository,
  latest,
  run = exec,
}) {
  const tag = latest && `v${latest}`;
  let directory;
  let crates;

  return async (name) => {
    if (!tag) {
      return;
    }

    if (!crates) {
      directory = await mkdtemp(nodePath.join(tmpdir(), "released-crates-"));

      try {
        run("gh", [
          "release",
          "download",
          tag,
          "--repo",
          repository,
          "--pattern",
          MANIFEST,
          "--dir",
          directory,
          "--clobber",
        ]);
        ({ crates } = await readManifest(directory));
      } catch (error) {
        if (!notFound(error, /release not found|no assets/i)) {
          throw error;
        }

        crates = [];
      }
    }

    const crate = crates.find((entry) => entry.name === name);

    if (!crate) {
      return;
    }

    run("gh", [
      "release",
      "download",
      tag,
      "--repo",
      repository,
      "--pattern",
      crate.file,
      "--dir",
      directory,
      "--clobber",
    ]);
    const path = nodePath.join(directory, crate.file);

    if (sha256(await readFile(path)) !== crate.sha256) {
      throw new Error(
        `${tag}: ${crate.file} does not match its release manifest`
      );
    }

    return { tag, version: crate.version, digest: readCrate(path).digest };
  };
};

/**
 * A crate keeps its version only while its contents are unchanged, and
 * otherwise moves forward by at least the level of the build's bump. Cargo
 * reads a crate's version from its source at the release tag, so the version
 * is the one in Cargo.toml; the bump only says how far it must move.
 */
export const crateVersionFindings = async (manifest, directory, released) => {
  const level = [undefined, "none"].includes(manifest.bump?.level)
    ? "patch"
    : manifest.bump.level;

  const findings = [];

  for (const crate of manifest.crates) {
    const previous = await released(crate.name);

    if (
      !previous ||
      previous.digest === readCrate(nodePath.join(directory, crate.file)).digest
    ) {
      continue;
    }

    const lowest = semver.inc(previous.version, level);

    if (previous.version === crate.version) {
      findings.push(
        `${crate.name} ${crate.version} is already released in ${previous.tag} with other contents; set its Cargo.toml version to at least ${lowest} and stage again`
      );
    } else if (!semver.gt(crate.version, previous.version)) {
      findings.push(
        `${crate.name} ${crate.version} is not newer than ${previous.version} in ${previous.tag}; set its Cargo.toml version to at least ${lowest} and stage again`
      );
    } else if (semver.lt(crate.version, lowest)) {
      findings.push(
        `${crate.name} ${crate.version} is below ${lowest}, which a ${level} change since ${previous.tag} requires; set its Cargo.toml version to at least ${lowest} and stage again`
      );
    }
  }

  return findings;
};

/** The workspace manifest a crate inherits from, read lazily at the build's source commit. */
export const workspaceManifest = function workspaceManifest({
  repository,
  sourceSha,
  crate,
  run = exec,
}) {
  let workspace;

  const read = () => {
    if (workspace) {
      return workspace;
    }

    const own = parseToml(crate.original);

    if (own.workspace) {
      return (workspace = own);
    }

    const directories = [];

    if (typeof own.package?.workspace === "string") {
      directories.push(
        nodePath.posix.normalize(
          nodePath.posix.join(crate.path ?? "", own.package.workspace)
        )
      );
    } else {
      for (
        let directory = crate.path ?? "";
        directory !== "." && directory !== "";
      ) {
        directory = nodePath.posix.dirname(directory);
        directories.push(directory);
      }
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
        if (notFound(error)) {
          continue;
        }

        throw error;
      }

      const manifest = parseToml(text);

      if (manifest.workspace) {
        return (workspace = manifest);
      }
    }

    throw new Error(
      `${crate.name} inherits from a workspace, but no workspace manifest is above ${crate.path || "the repository root"}`
    );
  };

  return () => Promise.try(read);
};

const gitReference = ({ rev, branch, tag }) => {
  if (rev !== undefined) {
    return `rev ${rev}`;
  }

  if (branch !== undefined) {
    return `branch ${branch}`;
  }

  return tag === undefined ? "its default branch" : `tag ${tag}`;
};

const cratePinFindings = (subject, dependency) => {
  const findings = [];
  const reference = gitReference(dependency);

  if (
    !RELEASE_TAG.test(dependency.tag ?? "") ||
    dependency.rev !== undefined ||
    dependency.branch !== undefined
  ) {
    findings.push(
      `${subject} must pin a release tag vX.Y.Z of ${dependency.git}, not ${reference}`
    );
  }

  if (!EXACT_STABLE.test(dependency.version ?? "")) {
    findings.push(
      `${subject} must require an exact stable version (=X.Y.Z), not ${dependency.version ?? "any version"}`
    );
  }

  return findings;
};

/**
 * Findings that keep a crate from production: a normal or build dependency
 * fetched from one of the owner's repositories that is not pinned to a release
 * tag and an exact stable version. Cargo resolves internal crates from Git, so
 * the tag is their release.
 */
export const crateDependencyFindings = async ({ crate, owner, workspace }) => {
  const manifest = parseToml(crate.original);

  const internal = new RegExp(
    `^(?:https?|ssh|git)://(?:[^@/]+@)?github\\.com[:/]${owner}/`,
    "i"
  );

  const findings = [];

  for (const section of [manifest, ...Object.values(manifest.target ?? {})]) {
    for (const table of CRATE_DEPENDENCY_TABLES) {
      for (const [key, declared] of Object.entries(section?.[table] ?? {})) {
        let dependency =
          typeof declared === "string" ? { version: declared } : declared;

        if (dependency.workspace === true) {
          const inherited = (await workspace()).workspace?.dependencies?.[key];
          dependency = {
            ...(typeof inherited === "string"
              ? { version: inherited }
              : inherited),
            ...dependency,
          };
        }

        if (!internal.test(dependency.git ?? "")) {
          continue;
        }

        const subject = `${crate.name} ${table}: ${dependency.package ?? key}`;

        findings.push(...cratePinFindings(subject, dependency));
      }
    }
  }

  return findings;
};
