import { join } from "node:path/posix";
import semver from "semver";

export const INTERNAL_OWNER = "photon-hq";
const RELEASE_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const EXACT_STABLE = /^=(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const REPOSITORY = /^[a-z0-9-]+\/[a-z0-9._-]+$/;

const TABLES = [
  "dependencies",
  "dev-dependencies",
  "dev_dependencies",
  "build-dependencies",
  "build_dependencies",
];

const stable = (version) => {
  const parsed = typeof version === "string" ? semver.parse(version) : null;

  return (
    parsed !== null &&
    parsed.prerelease.length === 0 &&
    version.startsWith(parsed.version)
  );
};

export const internalRepository = function internalRepository(git) {
  let url;

  try {
    url = new URL(String(git));
  } catch {
    return null;
  }

  if (!/^(?:www\.)?github\.com$/i.test(url.hostname)) {
    return null;
  }

  const [owner, name = ""] = url.pathname.split("/").filter(Boolean);

  if (owner?.toLowerCase() !== INTERNAL_OWNER) {
    return null;
  }

  return `${INTERNAL_OWNER}/${name.replace(/\.git$/i, "").toLowerCase()}`;
};

const reference = ({ rev, branch, tag }) => {
  if (rev !== undefined && rev !== null) {
    return `rev ${rev}`;
  }

  if (branch !== undefined && branch !== null) {
    return `branch ${branch}`;
  }

  if (tag !== undefined && tag !== null) {
    return `tag ${tag}`;
  }

  return "its default branch";
};

const lockedSource = (source) => {
  if (typeof source !== "string" || !source.startsWith("git+")) {
    return null;
  }

  const repository = internalRepository(source.slice(4));

  if (!repository) {
    return null;
  }

  const url = new URL(source.slice(4));
  const pin = Object.fromEntries(url.searchParams);

  return {
    repository,
    tag:
      pin.rev === undefined && pin.branch === undefined ? pin.tag : undefined,
    reference: reference(pin),
    commit: url.hash.slice(1),
  };
};

const inspectLockedPackages = (lockfile, errors) => {
  const crates = [];
  const local = new Set();

  if (![3, 4].includes(lockfile?.version) || !Array.isArray(lockfile.package)) {
    errors.add("Expected a Cargo.lock of version 3 or 4");
  }

  for (const entry of Array.isArray(lockfile?.package)
    ? lockfile.package
    : []) {
    if (entry.source === undefined) {
      local.add(entry.name);
      continue;
    }

    const source = lockedSource(entry.source);

    if (!source) {
      continue;
    }

    const row = {
      name: entry.name,
      version: entry.version,
      ...source,
      production: null,
      reason: "Release not verified",
    };

    if (!stable(row.version)) {
      row.production = false;
      row.reason = "Not an exact stable version";
      errors.add(
        `${row.name}@${row.version}: must be an exact stable production version`
      );
    }

    if (!RELEASE_TAG.test(row.tag ?? "")) {
      row.production = false;
      row.reason = "Not a release tag";
      errors.add(
        `${row.name}@${row.version}: Cargo.lock resolves ${row.repository} at ${row.reference}, not a release tag vX.Y.Z`
      );
    }

    crates.push(row);
  }

  return { crates, local };
};

const indexManifests = (manifests) => {
  const byName = new Map();

  for (const [path, manifest] of Object.entries(manifests)) {
    const name = manifest?.package?.name;

    if (typeof name !== "string") {
      continue;
    }

    if (!byName.has(name)) {
      byName.set(name, []);
    }

    byName.get(name).push([path, manifest]);
  }

  return byName;
};

const dependencyWithWorkspaceVersion = (declared, inherited, key) => {
  let dependency =
    typeof declared === "string" ? { version: declared } : declared;

  if (dependency?.workspace === true) {
    const base = inherited[key];
    dependency = {
      ...(typeof base === "string" ? { version: base } : base),
      ...dependency,
    };
  }

  return dependency;
};

const inspectDeclaration = ({
  path,
  key,
  declared,
  inherited,
  crates,
  errors,
}) => {
  const dependency = dependencyWithWorkspaceVersion(declared, inherited, key);
  const repository = internalRepository(dependency?.git);

  if (!repository) {
    return;
  }

  const crate = dependency.package ?? key;
  const subject = `${join(path, "Cargo.toml")}: ${crate}`;

  const pinned =
    RELEASE_TAG.test(dependency.tag ?? "") &&
    dependency.rev === undefined &&
    dependency.branch === undefined;

  const exact = EXACT_STABLE.test(dependency.version ?? "");

  if (!pinned) {
    errors.add(
      `${subject} must pin a release tag vX.Y.Z of ${repository}, not ${reference(dependency)}`
    );
  }

  if (!exact) {
    errors.add(
      `${subject} must require an exact stable version (=X.Y.Z), not ${dependency.version ?? "any version"}`
    );
  }

  const matched = crates.some(
    (row) =>
      row.name === crate &&
      row.repository === repository &&
      row.tag === dependency.tag &&
      `=${row.version}` === dependency.version
  );

  if (pinned && exact && !matched) {
    errors.add(
      `${subject} ${dependency.version} at ${dependency.tag} has no matching Cargo.lock package`
    );
  }
};

const inspectManifest = ({ path, manifest, inherited, crates, errors }) => {
  const sections = [manifest, ...Object.values(manifest.target ?? {})];

  for (const section of sections) {
    for (const table of TABLES) {
      for (const [key, declared] of Object.entries(section?.[table] ?? {})) {
        inspectDeclaration({
          path,
          key,
          declared,
          inherited,
          crates,
          errors,
        });
      }
    }
  }
};

const inspectLocalCrates = ({ local, byName, manifests, crates, errors }) => {
  const inherited = manifests["."]?.workspace?.dependencies ?? {};

  for (const name of local) {
    if (!byName.has(name)) {
      errors.add(`${name}: Cargo.lock package has no Cargo.toml in the source`);
    }

    for (const [path, manifest] of byName.get(name) ?? []) {
      inspectManifest({ path, manifest, inherited, crates, errors });
    }
  }
};

export const inspectCrates = function inspectCrates({ lockfile, manifests }) {
  const errors = new Set();
  const inspected = inspectLockedPackages(lockfile, errors);
  const byName = indexManifests(manifests);

  inspectLocalCrates({
    local: inspected.local,
    byName,
    manifests,
    crates: inspected.crates,
    errors,
  });

  return { errors: [...errors].toSorted(), crates: inspected.crates };
};

export const fetchCrateRelease = async (repository, tag) => {
  if (!REPOSITORY.test(repository) || !RELEASE_TAG.test(tag)) {
    throw new Error(`Not an internal crate release: ${repository} ${tag}`);
  }

  const token = process.env.CRATES_TOKEN;

  if (!token) {
    throw new Error("CRATES_TOKEN is required to read internal crate releases");
  }

  const get = (path, accept) =>
    fetch(
      `${process.env.GITHUB_API_URL || "https://api.github.com"}/repos/${repository}${path}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept,
          "x-github-api-version": "2022-11-28",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      }
    );

  const release = await get(
    `/releases/tags/${tag}`,
    "application/vnd.github+json"
  );

  if (release.status === 404) {
    const visible = await get("", "application/vnd.github+json");

    if (visible.ok) {
      return null;
    }

    throw new Error(
      `repository returned HTTP ${visible.status}; the token must be able to read its contents`
    );
  }

  if (!release.ok) {
    throw new Error(`release ${tag} returned HTTP ${release.status}`);
  }

  const { draft, prerelease } = await release.json();

  const commit = await get(
    `/commits/refs/tags/${tag}`,
    "application/vnd.github.sha"
  );

  if (!commit.ok) {
    throw new Error(`tag ${tag} returned HTTP ${commit.status}`);
  }

  return { draft, prerelease, commit: (await commit.text()).trim() };
};

const releaseResult = (release, row) => {
  if (!release) {
    return {
      reason: "Not released",
      finding: `${row.repository} has no release ${row.tag}`,
    };
  }

  if (release.draft || release.prerelease) {
    return {
      reason: "Not a production release",
      finding: `${row.repository} release ${row.tag} is a draft or prerelease`,
    };
  }

  if (release.commit === row.commit) {
    return { reason: "Production release", finding: null };
  }

  return {
    reason: "Release tag is at another commit",
    finding: `${row.repository} tag ${row.tag} is at ${release.commit}, but Cargo.lock resolved ${row.commit}`,
  };
};

export const auditCrates = async (cargo, loadRelease = fetchCrateRelease) => {
  const inspected = inspectCrates(cargo);
  const errors = new Set(inspected.errors);
  const releases = new Map();

  await Promise.all(
    inspected.crates
      .filter((row) => row.production === null)
      .map(async (row) => {
        const key = `${row.repository} ${row.tag}`;

        if (!releases.has(key)) {
          releases.set(key, loadRelease(row.repository, row.tag));
        }

        try {
          const release = await releases.get(key);
          const { reason, finding } = releaseResult(release, row);
          row.production = !finding;
          row.reason = reason;

          if (finding) {
            errors.add(`${row.name}@${row.version}: ${finding}`);
          }
        } catch (error) {
          row.reason = "Release lookup failed";
          errors.add(`${row.repository}: ${error.message}`);
        }
      })
  );

  const crates = inspected.crates
    .map(({ tag, commit, ...row }) => row)
    .toSorted(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        a.version.localeCompare(b.version) ||
        a.repository.localeCompare(b.repository) ||
        a.reference.localeCompare(b.reference)
    );

  return { crates, errors: [...errors].toSorted() };
};
