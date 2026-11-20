import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import {
  ensureRelease,
  ensureTag,
  exec,
  requireReviewers,
  tagCommit,
} from "./package-release.mjs";
import { latestReleaseTag } from "./release-version.mjs";
import { dependencyFindings } from "./swift-release-dependencies.mjs";
import {
  MANIFEST,
  STAGING_TAG,
  packageFile,
  readManifest,
  releaseNotes,
  verifyManifest,
} from "./swift-release-manifest.mjs";
import { changeLine, parseAge, stagingSoak } from "./swift-release-soak.mjs";

const OVERRIDE = "staging-age-override.json";
const CHECKED = "staging-age-check.json";
const DEFAULT_MINIMUM_AGE = "2h";

/**
 * Publish one channel of a verified build: its tag on the source commit and
 * its release. Every step can be retried; an existing tag on the same commit
 * and an existing release are accepted.
 */
export const publish = async ({
  directory,
  channel,
  repository,
  sourceSha,
  packageName,
  library = false,
  runId,
  bump,
  now = Date.now(),
  run = exec,
}) => {
  const manifest = await readManifest(directory);

  const channels =
    channel === "staging" ? ["staging", "production"] : ["production"];

  await verifyManifest(directory, manifest, {
    repository,
    sourceSha,
    runId: channel === "staging" ? runId : undefined,
    packageName,
    library,
    channels,
    bump,
  });

  const tag =
    channel === "staging" ? manifest.stagingTag : manifest.productionTag;

  // Approval can come long after resolution; a newer release in between makes this build stale.
  const override =
    channel === "production" ? await readRecord(directory, OVERRIDE) : null;

  if (channel === "production") {
    const tags = releaseTags(run, repository);
    const latest = latestReleaseTag(tags, "v")?.slice(1);

    if (behind(manifest.bump.version, latest)) {
      throw new Error(
        `${manifest.stagingTag} cannot be released: ${manifest.bump.version} is not newer than the latest release ${latest}; stage a newer build`
      );
    }

    const checked = await readRecord(directory, CHECKED);

    if (checked && !override) {
      recheckSoak({
        repository,
        manifest,
        checked,
        baseline: baselineOf(tags, manifest),
        now,
        run,
      });
    }
  }

  let files = [];

  if (manifest.pkg && channel === "staging") {
    files = [manifest.pkg.staging.file, manifest.pkg.production.file];
  }

  if (manifest.pkg && channel === "production") {
    await copyFile(
      path.join(directory, manifest.pkg.production.file),
      path.join(directory, packageFile(packageName))
    );
    files = [packageFile(packageName)];
  }

  ensureTag(run, manifest, tag);
  await ensureRelease(run, {
    directory,
    manifest,
    channel,
    tag,
    title: `${packageName} ${tag}`,
    files: [...files, MANIFEST],
    notes: releaseNotes(manifest, channel, override),
  });

  return { manifest, tag };
};

/**
 * A record resolution left beside the candidate, if any: the skip reason
 * (OVERRIDE) or the baseline and minimum the staging age was checked with (CHECKED).
 */
const readRecord = async (directory, name) => {
  try {
    return JSON.parse(await readFile(path.join(directory, name), "utf-8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
};

/**
 * The release a build's time on staging counts from: the latest `vX.Y.Z`
 * other than its own, so a build released again after a rollback is measured
 * from the release before it.
 */
const baselineOf = (tags, manifest) =>
  latestReleaseTag(
    tags.filter((name) => name !== manifest.productionTag),
    "v"
  ) ?? null;

/**
 * Check the time on staging again when a release came out between resolution
 * and approval. That release sends staging Macs back to it, so the time the
 * build's changes spent on staging before it no longer counts.
 */
const recheckSoak = ({ repository, manifest, checked, baseline, now, run }) => {
  if (baseline === checked.baseline) {
    return;
  }

  const why = `the time on staging was measured from ${checked.baseline ?? "no release"}, and ${baseline} has been released since, so it was checked again from ${baseline}`;

  const skip =
    "To promote now, run the promotion again with skip-minimum-age-reason.";

  let soak;

  try {
    soak = stagingSoak({
      repository,
      sourceSha: manifest.sourceSha,
      latest: baseline,
      minimum: checked.minimum,
      now,
      run,
    });
  } catch (error) {
    throw Object.assign(
      new Error(
        `${manifest.stagingTag}: ${why}, and it cannot be checked. ${error.message}\n${skip}`
      ),
      { unchecked: error.message }
    );
  }

  if (soak.waiting.length) {
    throw Object.assign(
      new Error(
        `${manifest.stagingTag}: ${why}. Some changes were on staging for less than the minimum time since then:\n${soak.waiting.map((change) => `- ${changeLine(change)}`).join("\n")}\n${skip}`
      ),
      { soak }
    );
  }
};

/** Tags under `v`, read from GitHub; matching-refs returns every match in one response. */
const releaseTags = (run, repository) =>
  JSON.parse(
    run("gh", ["api", `repos/${repository}/git/matching-refs/tags/v`])
  ).map(({ ref }) => ref.slice("refs/tags/".length));

/** Whether a version can no longer follow the latest release; a version equal to it is left to the caller. */
const behind = (version, latest) =>
  Boolean(latest) && latest !== version && !semver.gt(version, latest);

const verifyCandidate = async ({
  tag,
  repository,
  output,
  packageName,
  library,
  signerWorkflow,
  run,
}) => {
  await mkdir(output, { recursive: true });

  const download = (pattern) => {
    try {
      run("gh", [
        "release",
        "download",
        tag,
        "--repo",
        repository,
        "--pattern",
        pattern,
        "--dir",
        output,
        "--clobber",
      ]);
    } catch (error) {
      if (/release not found|no assets/i.test(String(error?.stderr ?? ""))) {
        throw new Error(
          `${tag} has no promotion candidate; only builds from the buildspace Swift stage workflow can be promoted`,
          { cause: error }
        );
      }

      throw error;
    }
  };

  download(MANIFEST);
  const manifest = await readManifest(output);

  if (manifest.stagingTag !== tag) {
    throw new Error(
      `The manifest attached to ${tag} describes ${manifest.stagingTag}`
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

  if (manifest.pkg) {
    download(manifest.pkg.production.file);
  }

  await verifyManifest(output, manifest, {
    repository,
    packageName,
    library,
    channels: manifest.pkg ? ["production"] : [],
  });

  if (manifest.pkg) {
    // The release, and Jamf, receive the candidate under the name the Macs install.
    await copyFile(
      path.join(output, manifest.pkg.production.file),
      path.join(output, packageFile(packageName))
    );
    run("gh", [
      "attestation",
      "verify",
      path.join(output, manifest.pkg.production.file),
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

  return manifest;
};

const checkCandidateSoak = async ({
  tag,
  repository,
  manifest,
  previous,
  minimumAge,
  now,
  run,
  output,
}) => {
  const skip = "To promote now, set skip-minimum-age-reason.";
  let soak;
  let minimum;

  try {
    minimum = parseAge(minimumAge || DEFAULT_MINIMUM_AGE);
    soak = stagingSoak({
      repository,
      sourceSha: manifest.sourceSha,
      latest: previous,
      minimum,
      now,
      run,
    });
  } catch (error) {
    throw Object.assign(
      new Error(
        `${tag}: cannot check the time on staging. ${error.message}\n${skip}`
      ),
      { unchecked: error.message }
    );
  }

  if (soak.waiting.length) {
    throw Object.assign(
      new Error(
        `${tag}: some changes were on staging for less than the minimum time:\n${soak.waiting.map((change) => `- ${changeLine(change)}`).join("\n")}\n${skip}`
      ),
      { soak }
    );
  }

  // Publishing checks again if a release comes out before approval.
  await writeFile(
    path.join(output, CHECKED),
    `${JSON.stringify({ baseline: previous, minimum }, null, 2)}\n`
  );

  return soak;
};

/**
 * Find the build to promote and prove where it came from: staged by the stage
 * workflow from a commit on main, unchanged since, newer than the latest
 * release, and depending only on the owner's production releases. `pending`
 * is false when that release already is this build.
 */
export const resolveCandidate = async ({
  repository,
  packageName,
  library = false,
  version: requested = "",
  approvedBy = "",
  environment,
  signerWorkflow,
  output,
  minimumAge,
  skipMinimumAge = "",
  now = Date.now(),
  run = exec,
  dependencyRun = run,
}) => {
  const reason = skipMinimumAge.trim();
  requireReviewers({ repository, environment, approvedBy, run });
  const tags = releaseTags(run, repository);

  const [newest] = tags
    .map((tag) => ({ tag, coordinates: STAGING_TAG.exec(tag)?.groups }))
    .filter(({ coordinates }) => coordinates)
    .toSorted(
      (left, right) =>
        Number(right.coordinates.runId) - Number(left.coordinates.runId) ||
        Number(right.coordinates.attempt) - Number(left.coordinates.attempt)
    );

  const tag = requested ? `v${requested.replace(/^v/, "")}` : newest?.tag;

  if (!tag) {
    throw new Error(`${repository} has no staging build`);
  }

  const manifest = await verifyCandidate({
    tag,
    repository,
    output,
    packageName,
    library,
    signerWorkflow,
    run,
  });

  const candidate = manifest.bump.version;
  const latest = latestReleaseTag(tags, "v")?.slice(1);

  if (latest === candidate) {
    if (
      tagCommit(run, repository, manifest.productionTag) !== manifest.sourceSha
    ) {
      throw new Error(
        `${tag} cannot be promoted: ${manifest.productionTag} is already released from another commit; stage a newer build`
      );
    }

    if (productionReleaseExists(run, manifest)) {
      return { manifest, pending: false, dependencies: [] };
    }
  } else if (behind(candidate, latest)) {
    throw new Error(
      `${tag} cannot be promoted: ${candidate} is not newer than the latest release ${latest}; stage a newer build`
    );
  }

  const { dependencies, findings } = dependencyFindings({
    repository,
    sourceSha: manifest.sourceSha,
    library,
    run,
    dependencyRun,
  });

  if (findings.length) {
    throw new Error(
      `${tag} cannot be promoted until its dependencies are production releases:\n${findings.map((finding) => `- ${finding}`).join("\n")}`
    );
  }

  // A library runs on no staging Mac; the packages that pin it wait instead.
  // A build re-released after a rollback is measured from the release before it.
  const previous = baselineOf(tags, manifest);

  // An unset minimum (only callers of this function can leave it unset) skips the
  // check; an empty one, as the workflow passes it, means the default.
  if (minimumAge === undefined || library) {
    return { manifest, pending: true, dependencies, overridden: false };
  }

  // A reason skips the check outright, so nothing in it can hold up a hotfix.
  if (reason) {
    await writeFile(
      path.join(output, OVERRIDE),
      `${JSON.stringify({ reason }, null, 2)}\n`
    );

    return { manifest, pending: true, dependencies, overridden: true };
  }

  const soak = await checkCandidateSoak({
    tag,
    repository,
    manifest,
    previous,
    minimumAge,
    now,
    run,
    output,
  });

  return { manifest, pending: true, dependencies, soak, overridden: false };
};

const productionReleaseExists = (run, manifest) => {
  try {
    return (
      JSON.parse(
        run("gh", [
          "release",
          "view",
          manifest.productionTag,
          "--repo",
          manifest.repository,
          "--json",
          "isPrerelease",
        ])
      ).isPrerelease === false
    );
  } catch (error) {
    if (/release not found/i.test(String(error?.stderr ?? ""))) {
      return false;
    }

    throw error;
  }
};
