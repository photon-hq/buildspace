import { mkdir } from "node:fs/promises";
import nodePath from "node:path";
import semver from "semver";
import {
  cached,
  DEPENDENCY_FIELDS,
  exec,
  MANIFEST,
  matchesPackage,
  notFound,
  readCrate,
  readManifest,
  readTarballManifest,
  registryMetadata,
  releaseNames,
  STABLE,
  verifyManifest,
} from "./package-artifacts.mjs";
import {
  crateDependencyFindings,
  crateVersionFindings,
  releasedCrates,
  workspaceManifest,
} from "./package-crate-promotion.mjs";
import { changesSince, tagCommit } from "./package-publish.mjs";

export {
  crateDependencyFindings,
  crateVersionFindings,
  releasedCrates,
  workspaceManifest,
} from "./package-crate-promotion.mjs";

const IMAGE_TAG = /^(?:main|hotfix-[a-f0-9]{40})-(?<sourceSha>[a-f0-9]{40})$/;

/** Findings that keep a candidate from production: internal dependencies on unreleased builds. */
export const dependencyFindings = async (candidates, selection, registry) => {
  const promoted = new Map(
    candidates.map(({ name, version }) => [name, version])
  );

  const findings = [];

  for (const { name, manifest } of candidates) {
    for (const field of DEPENDENCY_FIELDS) {
      for (const [dependency, spec] of Object.entries(manifest[field] ?? {})) {
        if (!matchesPackage(dependency, selection)) {
          continue;
        }

        if (!STABLE.test(spec)) {
          findings.push(
            `${name} ${field}: ${dependency}@${spec} is not an exact stable version`
          );
          continue;
        }

        if (promoted.has(dependency)) {
          if (promoted.get(dependency) !== spec) {
            findings.push(
              `${name} ${field}: ${dependency}@${spec} differs from the promoted ${promoted.get(dependency)}`
            );
          }

          continue;
        }

        const release = (await registry(dependency)).versions[spec];

        if (!release) {
          findings.push(
            `${name} ${field}: ${dependency}@${spec} is not published`
          );
        } else if (release.deprecated) {
          findings.push(
            `${name} ${field}: ${dependency}@${spec} is deprecated`
          );
        }
      }
    }

    for (const [dependency, range] of Object.entries(
      manifest.peerDependencies ?? {}
    )) {
      if (!matchesPackage(dependency, selection)) {
        continue;
      }

      if (!semver.validRange(range)) {
        findings.push(
          `${name} peerDependencies: ${dependency}@${range} is not a version range`
        );
        continue;
      }

      if (promoted.has(dependency)) {
        if (!semver.satisfies(promoted.get(dependency), range)) {
          findings.push(
            `${name} peerDependencies: the promoted ${dependency}@${promoted.get(dependency)} does not satisfy ${range}`
          );
        }

        continue;
      }

      const satisfied = Object.entries(
        (await registry(dependency)).versions
      ).some(
        ([version, release]) =>
          STABLE.test(version) &&
          !release.deprecated &&
          semver.satisfies(version, range)
      );

      if (!satisfied) {
        findings.push(
          `${name} peerDependencies: no published stable ${dependency} satisfies ${range}`
        );
      }
    }
  }

  return findings;
};

/**
 * The staging build a main commit carries: the newest one staged at that commit
 * or at an ancestor. A repository that stages only the commits that change its
 * packages has no build of its own for the commits in between, and none of
 * them may have a stage run that published nothing.
 */
export const stagedBuild = function stagedBuild({
  repository,
  names,
  sourceSha,
  run = exec,
}) {
  const api = (path) => JSON.parse(run("gh", ["api", path]));
  const known = new Map([[sourceSha, true]]);

  const carried = (commit) => {
    if (!known.has(commit)) {
      known.set(
        commit,
        api(`repos/${repository}/compare/${commit}...${sourceSha}`).status ===
          "ahead"
      );
    }

    return known.get(commit);
  };

  const builds = [];

  for (let page = 1; ; page += 1) {
    const refs = api(
      `repos/${repository}/git/matching-refs/tags/${names.tagPrefix}?per_page=100&page=${page}`
    );

    for (const { ref, object } of refs) {
      const tag = ref.slice("refs/tags/".length);
      const coordinates = /-staging\.(?<runId>\d+)\.(?<attempt>\d+)$/.exec(tag);

      if (coordinates && semver.valid(tag.slice(names.tagPrefix.length))) {
        builds.push({
          tag,
          object,
          runId: Number(coordinates.groups.runId),
          attempt: Number(coordinates.groups.attempt),
        });
      }
    }

    if (refs.length < 100) {
      break;
    }
  }

  const build = builds
    .toSorted(
      (left, right) => right.runId - left.runId || right.attempt - left.attempt
    )
    .find(({ tag, object }) =>
      carried(
        object.type === "commit" ? object.sha : tagCommit(run, repository, tag)
      )
    );

  if (!build) {
    throw new Error(
      `${names.primary} has no staging build at or before ${sourceSha}`
    );
  }

  const { workflow_id: workflow } = api(
    `repos/${repository}/actions/runs/${build.runId}`
  );

  for (let page = 1; page <= 10; page += 1) {
    const { workflow_runs: runs } = api(
      `repos/${repository}/actions/workflows/${workflow}/runs?branch=main&event=push&per_page=100&page=${page}`
    );

    for (const later of runs) {
      if (later.id <= build.runId) {
        return build.tag.slice(names.tagPrefix.length);
      }

      if (carried(later.head_sha)) {
        throw new Error(
          `${later.html_url} staged ${later.head_sha} after ${build.tag} and published no build (${later.conclusion ?? later.status}); rerun it, or promote a commit before it`
        );
      }
    }

    if (runs.length < 100) {
      return build.tag.slice(names.tagPrefix.length);
    }
  }

  throw new Error(
    `${build.tag} is more than 1000 stage runs old; promote it by its staging version`
  );
};

/**
 * Promotion waits for people: the environment must exist and require a
 * reviewer, unless a trusted actor's own dispatch is the approval.
 */
export const requireReviewers = function requireReviewers({
  repository,
  environment,
  approvedBy = "",
  run = exec,
}) {
  if (approvedBy) {
    return;
  }

  let rules;

  try {
    rules =
      JSON.parse(
        run("gh", ["api", `repos/${repository}/environments/${environment}`])
      ).protection_rules ?? [];
  } catch (error) {
    if (!notFound(error)) {
      throw error;
    }

    rules = [];
  }

  if (
    !rules.some(
      (rule) => rule.type === "required_reviewers" && rule.reviewers?.length
    )
  ) {
    throw new Error(
      `The ${environment} environment must exist and require a reviewer before anything is promoted`
    );
  }
};

const verifyCandidate = async ({
  repository,
  packageInput,
  packageSelection,
  tagPrefix,
  productionTagPrefix,
  registryUrl,
  tag,
  version,
  packageName,
  output,
  signerWorkflow,
  run,
}) => {
  await mkdir(output, { recursive: true });

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
      output,
      "--clobber",
    ]);
  } catch (error) {
    if (notFound(error, /release not found|no assets/i)) {
      throw new Error(
        `${tag} has no promotion candidates; only builds from the buildspace stage workflow can be promoted`,
        { cause: error }
      );
    }

    throw error;
  }

  const manifest = await readManifest(output);
  const primary = manifest.packages.find(({ name }) => name === packageName);

  if (manifest.stagingTag !== tag || primary?.staging.version !== version) {
    throw new Error(
      `The manifest attached to ${tag} does not describe ${packageName}@${version}`
    );
  }

  if (tagCommit(run, repository, tag) !== manifest.sourceSha) {
    throw new Error(`${tag} no longer names the commit it was built from`);
  }

  const { status } = JSON.parse(
    run("gh", [
      "api",
      `repos/${repository}/compare/${manifest.sourceSha}...main`,
    ])
  );

  if (!["ahead", "identical"].includes(status)) {
    throw new Error(`${manifest.sourceSha} is not in the history of main`);
  }

  const files = [
    ...manifest.packages.map((pkg) => pkg.production.file),
    ...manifest.crates.map(({ file }) => file),
  ];

  for (const file of files) {
    run("gh", [
      "release",
      "download",
      tag,
      "--repo",
      repository,
      "--pattern",
      file,
      "--dir",
      output,
      "--clobber",
    ]);
  }

  await verifyManifest(output, manifest, {
    repository,
    packageInput,
    packageSelection,
    tagPrefix,
    productionTagPrefix,
    registryUrl,
    channels: ["production"],
  });

  for (const file of files) {
    run("gh", [
      "attestation",
      "verify",
      nodePath.join(output, file),
      "--repo",
      repository,
      "--signer-workflow",
      signerWorkflow,
      "--source-digest",
      manifest.sourceSha,
      "--source-ref",
      "refs/heads/main",
    ]);
  }

  return { manifest, primary };
};

const checkCandidatePackages = async (manifest, output, selection, lookup) => {
  const candidates = manifest.packages.map((pkg) => ({
    name: pkg.name,
    version: pkg.production.version,
    manifest: readTarballManifest(nodePath.join(output, pkg.production.file)),
  }));

  const findings = await dependencyFindings(candidates, selection, lookup);

  const restage = manifest.bump
    ? "stage a newer build, from a change inside the build's paths or a Release-As"
    : "bump the version and stage again";

  let published = true;

  for (const pkg of manifest.packages) {
    const { version: candidate, integrity: expected } = pkg.production;
    const metadata = await lookup(pkg.name);
    const existing = metadata.versions[candidate];
    const { latest } = metadata["dist-tags"];

    if (existing && existing.dist?.integrity !== expected) {
      findings.push(
        `${pkg.name}@${candidate} is already published with different contents; ${restage}`
      );
    } else if (!existing && latest && !semver.gt(candidate, latest)) {
      findings.push(
        `${pkg.name}@${candidate} is not newer than latest ${latest}; ${restage}`
      );
    }

    published &&=
      Boolean(existing) && Boolean(latest) && !semver.gt(candidate, latest);
  }

  return { findings, published };
};

/**
 * Find the candidates to promote and prove where they came from. `pending` is
 * false when there is nothing left to publish: a hotfix image, whose packages
 * are not staged, or a build whose candidates are all released already.
 */
export const resolveCandidate = async ({
  repository,
  packageInput,
  packageSelection,
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
}) => {
  const names = releaseNames({
    repository,
    packageInput,
    packageSelection,
    tagPrefix,
    productionTagPrefix,
    registryUrl,
  });

  const sourceSha = IMAGE_TAG.exec(imageTag)?.groups.sourceSha;

  if (imageTag) {
    if (requested) {
      throw new Error("Supply a staging version or an image tag, not both");
    }

    if (!sourceSha) {
      throw new Error("Invalid immutable image tag");
    }

    if (!imageTag.startsWith("main-")) {
      return { pending: false };
    }
  }

  requireReviewers({ repository, environment, approvedBy, run });
  const lookup = cached(registry ?? registryMetadata(names.registryUrl));

  const version =
    requested ||
    (sourceSha
      ? stagedBuild({ repository, names, sourceSha, run })
      : (await lookup(names.primary))["dist-tags"].staging);

  if (!version) {
    throw new Error(`${names.primary} has no staging build`);
  }

  const tag = `${names.tagPrefix}${version}`;

  const { manifest, primary } = await verifyCandidate({
    repository,
    packageInput,
    packageSelection,
    tagPrefix,
    productionTagPrefix,
    registryUrl,
    tag,
    version,
    packageName: names.primary,
    output,
    signerWorkflow,
    run,
  });

  const { findings, published } = await checkCandidatePackages(
    manifest,
    output,
    names.selection,
    lookup
  );

  const { latest } = (await lookup(names.primary))["dist-tags"];
  findings.push(
    ...(await crateVersionFindings(
      manifest,
      output,
      releasedCrates({ repository, latest, run })
    ))
  );

  for (const { file } of manifest.crates) {
    const crate = readCrate(nodePath.join(output, file));

    const workspace = workspaceManifest({
      repository,
      sourceSha: manifest.sourceSha,
      crate,
      run,
    });

    findings.push(
      ...(await crateDependencyFindings({
        crate,
        owner: repository.split("/")[0],
        workspace,
      }))
    );
  }

  if (findings.length) {
    throw new Error(
      `${tag} cannot be promoted:\n${findings.map((finding) => `- ${finding}`).join("\n")}`
    );
  }

  const changes =
    !manifest.bump && latest && latest !== primary.production.version
      ? changesSince(
          run,
          repository,
          `${names.productionTagPrefix}${latest}`,
          manifest.sourceSha
        )
      : undefined;

  return {
    manifest,
    changes,
    pending: !(published && productionReleaseExists(run, manifest)),
  };
};

/**
 * Whether the production release of these candidates exists. An earlier build
 * may have made it: identical packages keep the tag of the commit that first
 * released them. Crates are released by the tag itself, so theirs must be this
 * build's.
 */
const productionReleaseExists = (run, manifest) => {
  const commit = tagCommit(run, manifest.repository, manifest.productionTag);

  if (
    commit === undefined ||
    (manifest.crates.length && commit !== manifest.sourceSha)
  ) {
    return false;
  }

  try {
    const release = run("gh", [
      "release",
      "view",
      manifest.productionTag,
      "--repo",
      manifest.repository,
      "--json",
      "assets,isPrerelease",
    ]);

    return JSON.parse(release).isPrerelease === false;
  } catch (error) {
    if (notFound(error, /release not found/i)) {
      return false;
    }

    throw error;
  }
};
