import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import semver from "semver";
import { bumpProblem, ensureRelease, ensureTag, exec, notFound, requireReviewers, sha256, tagCommit } from "./package-release.mjs";
import { bumpNotes, latestReleaseTag } from "./release-version.mjs";
import { dependencyFindings } from "./swift-dependencies.mjs";

const MANIFEST = "release-manifest.json";
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SUFFIX = /^-staging\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[a-f0-9]{40}$/;
const STAGING_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-staging\.(\d+)\.(\d+)$/;
const AGE = /^(0|[1-9]\d*)([mhd])$/;
const AGE_LABEL = /^min-staging-age:(.+)$/;
const AGE_UNIT = { m: 60_000, h: 3_600_000, d: 86_400_000 };
const OVERRIDE = "staging-age-override.json";
const CHECKED = "staging-age-check.json";
const DEFAULT_MINIMUM_AGE = "2h";

/**
 * GitGate and the Astrolabe self-updater install the first asset ending in
 * .pkg, so a release holds exactly one: the staging build on a staging
 * release, the promoted candidate on a production one. The candidate rides on
 * the staging release under a name they skip.
 */
export const packageFile = (name) => `${name}.pkg`;
export const candidateFile = (name, version) => `${name}-${version}.pkg.candidate`;

const kind = (library) => (library ? "swift-library" : "swift-package");

/**
 * Lay out a staging build and its production candidate, both packaged from one
 * source commit at the version `bump` computed, with a manifest promotion can
 * verify. A library has no files: its release is the tag.
 */
export async function collect({ stagingPackage, productionPackage, packageName, library = false, bump, suffix, sourceSha, repository, output, runUrl }) {
  if (!NAME.test(packageName ?? "")) throw new Error(`Invalid package name ${packageName}`);
  if (!SUFFIX.test(suffix)) throw new Error(`Invalid staging suffix: ${suffix}`);
  if (!SHA.test(sourceSha)) throw new Error("An exact source commit is required");
  const problem = bumpProblem(bump);
  if (problem) throw new Error(`Invalid release version: ${problem}`);
  await mkdir(output, { recursive: true });
  let pkg = null;
  if (!library) {
    const entry = async (source, version, file) => {
      await copyFile(source, join(output, file));
      return { version, file, sha256: sha256(await readFile(source)) };
    };
    pkg = {
      staging: await entry(stagingPackage, `${bump.version}${suffix}`, packageFile(packageName)),
      production: await entry(productionPackage, bump.version, candidateFile(packageName, bump.version)),
    };
  }
  const manifest = {
    formatVersion: 1,
    kind: kind(library),
    repository,
    sourceSha,
    runUrl,
    suffix,
    package: packageName,
    stagingTag: `v${bump.version}${suffix}`,
    productionTag: `v${bump.version}`,
    bump,
    pkg,
  };
  await writeFile(join(output, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function readManifest(directory) {
  const manifest = JSON.parse(await readFile(join(directory, MANIFEST), "utf8"));
  if (manifest.formatVersion !== 1 || !["swift-package", "swift-library"].includes(manifest.kind))
    throw new Error("Unsupported Swift release manifest");
  return manifest;
}

/**
 * Rebuild a manifest's claims from the caller's own coordinates and the files
 * it lists. The build job ran repository code, so nothing in the manifest is
 * trusted until it matches.
 */
export async function verifyManifest(directory, manifest, { repository, sourceSha, runId, packageName, library = false, channels, bump }) {
  const fail = (reason) => {
    throw new Error(`The release manifest does not describe this build: ${reason}`);
  };
  if (manifest.repository !== repository) fail(`repository ${manifest.repository}`);
  if (!SHA.test(manifest.sourceSha) || (sourceSha && manifest.sourceSha !== sourceSha)) fail(`source ${manifest.sourceSha}`);
  if (!SUFFIX.test(manifest.suffix) || (runId && !manifest.suffix.startsWith(`-staging.${runId}.`))) fail(`suffix ${manifest.suffix}`);
  if (manifest.package !== packageName) fail(`package ${manifest.package}`);
  if (manifest.kind !== kind(library)) fail(`kind ${manifest.kind}`);
  const problem = bumpProblem(manifest.bump);
  if (problem) fail(`bump ${problem}`);
  if (bump && JSON.stringify(manifest.bump) !== JSON.stringify(bump)) fail("bump, which is not the version this run computed");
  const { version } = manifest.bump;
  if (manifest.stagingTag !== `v${version}${manifest.suffix}` || manifest.productionTag !== `v${version}`) fail("release tags");
  if (library) {
    if (manifest.pkg !== null) fail("files of a library");
    return;
  }
  const expected = {
    staging: { version: `${version}${manifest.suffix}`, file: packageFile(packageName) },
    production: { version, file: candidateFile(packageName, version) },
  };
  for (const channel of ["staging", "production"]) {
    const entry = manifest.pkg?.[channel];
    if (entry?.version !== expected[channel].version || entry.file !== expected[channel].file) fail(`${channel} package`);
  }
  for (const channel of channels)
    if (sha256(await readFile(join(directory, manifest.pkg[channel].file))) !== manifest.pkg[channel].sha256)
      throw new Error(`${manifest.pkg[channel].file} does not match the release manifest`);
}

export function releaseNotes(manifest, channel, override = null) {
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const source = `[\`${manifest.sourceSha.slice(0, 12)}\`](${server}/${manifest.repository}/commit/${manifest.sourceSha})`;
  const staging = manifest.pkg?.staging.version ?? manifest.stagingTag.slice(1);
  const lines =
    channel === "staging"
      ? [
          manifest.pkg
            ? `Staging build of ${source} ([run](${manifest.runUrl})). Staging Macs install it. The production candidate is attached; promote this build with \`staging-version: ${staging}\`.`
            : `Staging tag of ${source} ([run](${manifest.runUrl})). Depend on \`.exact("${staging}")\` to try it; promote it with \`staging-version: ${staging}\`.`,
        ]
      : [`Promoted from [\`${manifest.stagingTag}\`](${server}/${manifest.repository}/releases/tag/${manifest.stagingTag}), built from ${source} ([run](${manifest.runUrl})).`];
  if (manifest.pkg) {
    const rows = channel === "staging" ? ["staging", "production"] : ["production"];
    lines.push("", "| Package | Version | SHA-256 |", "| --- | --- | --- |");
    for (const row of rows) {
      const { version, sha256: digest } = manifest.pkg[row];
      const label = row === "production" && channel === "staging" ? " (production candidate)" : "";
      lines.push(`| \`${packageFile(manifest.package)}\`${label} | \`${version}\` | \`${digest}\` |`);
    }
  }
  if (override) lines.push("", `Promoted without a check of the time on staging. Reason: ${override.reason}`);
  lines.push("", ...bumpNotes(manifest.bump, manifest.repository));
  return `${lines.join("\n")}\n`;
}

/**
 * Publish one channel of a verified build: its tag on the source commit and
 * its release. Every step can be retried; an existing tag on the same commit
 * and an existing release are accepted.
 */
export async function publish({ directory, channel, repository, sourceSha, packageName, library = false, runId, bump, now = Date.now(), run = exec }) {
  const manifest = await readManifest(directory);
  const channels = channel === "staging" ? ["staging", "production"] : ["production"];
  await verifyManifest(directory, manifest, { repository, sourceSha, runId: channel === "staging" ? runId : undefined, packageName, library, channels, bump });
  const tag = channel === "staging" ? manifest.stagingTag : manifest.productionTag;
  // Approval can come long after resolution; a newer release in between makes this build stale.
  const override = channel === "production" ? await readRecord(directory, OVERRIDE) : null;
  if (channel === "production") {
    const tags = releaseTags(run, repository);
    const latest = latestReleaseTag(tags, "v")?.slice(1);
    if (behind(manifest.bump.version, latest))
      throw new Error(`${manifest.stagingTag} cannot be released: ${manifest.bump.version} is not newer than the latest release ${latest}; stage a newer build`);
    const checked = await readRecord(directory, CHECKED);
    if (checked && !override) recheckSoak({ repository, manifest, checked, baseline: baselineOf(tags, manifest), now, run });
  }
  let files = [];
  if (manifest.pkg && channel === "staging") files = [manifest.pkg.staging.file, manifest.pkg.production.file];
  if (manifest.pkg && channel === "production") {
    await copyFile(join(directory, manifest.pkg.production.file), join(directory, packageFile(packageName)));
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
}

/**
 * A record resolution left beside the candidate, if any: the skip reason
 * (OVERRIDE) or the baseline and minimum the staging age was checked with (CHECKED).
 */
async function readRecord(directory, name) {
  try {
    return JSON.parse(await readFile(join(directory, name), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * The release a build's time on staging counts from: the latest `vX.Y.Z`
 * other than its own, so a build released again after a rollback is measured
 * from the release before it.
 */
const baselineOf = (tags, manifest) => latestReleaseTag(tags.filter((name) => name !== manifest.productionTag), "v") ?? null;

/**
 * Check the time on staging again when a release came out between resolution
 * and approval. That release sends staging Macs back to it, so the time the
 * build's changes spent on staging before it no longer counts.
 */
function recheckSoak({ repository, manifest, checked, baseline, now, run }) {
  if (baseline === checked.baseline) return;
  const why = `the time on staging was measured from ${checked.baseline ?? "no release"}, and ${baseline} has been released since, so it was checked again from ${baseline}`;
  const skip = "To promote now, run the promotion again with skip-minimum-age-reason.";
  let soak;
  try {
    soak = stagingSoak({ repository, sourceSha: manifest.sourceSha, latest: baseline, minimum: checked.minimum, now, run });
  } catch (error) {
    throw Object.assign(new Error(`${manifest.stagingTag}: ${why}, and it cannot be checked. ${error.message}\n${skip}`), { unchecked: error.message });
  }
  if (soak.waiting.length)
    throw Object.assign(new Error(`${manifest.stagingTag}: ${why}. Some changes were on staging for less than the minimum time since then:\n${soak.waiting.map((change) => `- ${changeLine(change)}`).join("\n")}\n${skip}`), { soak });
}

/** Tags under `v`, read from GitHub; matching-refs returns every match in one response. */
function releaseTags(run, repository) {
  return JSON.parse(run("gh", ["api", `repos/${repository}/git/matching-refs/tags/v`])).map(({ ref }) => ref.slice("refs/tags/".length));
}

/** Whether a version can no longer follow the latest release; a version equal to it is left to the caller. */
const behind = (version, latest) => Boolean(latest) && latest !== version && !semver.gt(version, latest);

/**
 * Find the build to promote and prove where it came from: staged by the stage
 * workflow from a commit on main, unchanged since, newer than the latest
 * release, and depending only on production releases, including those of the
 * repositories it lists at `requiredReleases`. `pending` is false when that
 * release already is this build.
 */
export async function resolveCandidate({
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
  requiredReleases = "",
  now = Date.now(),
  run = exec,
  dependencyRun = run,
}) {
  const reason = skipMinimumAge.trim();
  requireReviewers({ repository, environment, approvedBy, run });
  const tags = releaseTags(run, repository);
  const newest = tags
    .map((tag) => ({ tag, coordinates: STAGING_TAG.exec(tag) }))
    .filter(({ coordinates }) => coordinates)
    .sort((left, right) => Number(right.coordinates[1]) - Number(left.coordinates[1]) || Number(right.coordinates[2]) - Number(left.coordinates[2]))[0];
  const tag = requested ? `v${requested.replace(/^v/, "")}` : newest?.tag;
  if (!tag) throw new Error(`${repository} has no staging build`);
  await mkdir(output, { recursive: true });
  const download = (pattern) => {
    try {
      run("gh", ["release", "download", tag, "--repo", repository, "--pattern", pattern, "--dir", output, "--clobber"]);
    } catch (error) {
      if (/release not found|no assets/i.test(String(error?.stderr ?? "")))
        throw new Error(`${tag} has no promotion candidate; only builds from the buildspace Swift stage workflow can be promoted`);
      throw error;
    }
  };
  download(MANIFEST);
  const manifest = await readManifest(output);
  if (manifest.stagingTag !== tag) throw new Error(`The manifest attached to ${tag} describes ${manifest.stagingTag}`);
  if (tagCommit(run, repository, tag) !== manifest.sourceSha) throw new Error(`${tag} no longer names the commit it was built from`);
  const { status } = JSON.parse(run("gh", ["api", `repos/${repository}/compare/${manifest.sourceSha}...main`]));
  if (!["ahead", "identical"].includes(status)) throw new Error(`${manifest.sourceSha} is not in the history of main`);
  if (manifest.pkg) download(manifest.pkg.production.file);
  await verifyManifest(output, manifest, { repository, packageName, library, channels: manifest.pkg ? ["production"] : [] });
  if (manifest.pkg) {
    // The release, and Jamf, receive the candidate under the name the Macs install.
    await copyFile(join(output, manifest.pkg.production.file), join(output, packageFile(packageName)));
    run("gh", [
      "attestation",
      "verify",
      join(output, manifest.pkg.production.file),
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
  const candidate = manifest.bump.version;
  const latest = latestReleaseTag(tags, "v")?.slice(1);
  if (latest === candidate) {
    if (tagCommit(run, repository, manifest.productionTag) !== manifest.sourceSha)
      throw new Error(`${tag} cannot be promoted: ${manifest.productionTag} is already released from another commit; stage a newer build`);
    if (productionReleaseExists(run, manifest)) return { manifest, pending: false, dependencies: [] };
  } else if (behind(candidate, latest))
    throw new Error(`${tag} cannot be promoted: ${candidate} is not newer than the latest release ${latest}; stage a newer build`);
  const { dependencies, findings } = dependencyFindings({ repository, sourceSha: manifest.sourceSha, library, requiredReleases, run, dependencyRun });
  if (findings.length)
    throw new Error(`${tag} cannot be promoted until its dependencies are production releases:\n${findings.map((finding) => `- ${finding}`).join("\n")}`);
  // A library runs on no staging Mac; the packages that pin it wait instead.
  // A build re-released after a rollback is measured from the release before it.
  const previous = baselineOf(tags, manifest);
  // An unset minimum (only callers of this function can leave it unset) skips the
  // check; an empty one, as the workflow passes it, means the default.
  if (minimumAge === undefined || library) return { manifest, pending: true, dependencies, overridden: false };
  // A reason skips the check outright, so nothing in it can hold up a hotfix.
  if (reason) {
    await writeFile(join(output, OVERRIDE), `${JSON.stringify({ reason }, null, 2)}\n`);
    return { manifest, pending: true, dependencies, overridden: true };
  }
  const skip = "To promote now, set skip-minimum-age-reason.";
  let soak;
  let minimum;
  try {
    minimum = parseAge(minimumAge || DEFAULT_MINIMUM_AGE);
    soak = stagingSoak({ repository, sourceSha: manifest.sourceSha, latest: previous, minimum, now, run });
  } catch (error) {
    throw Object.assign(new Error(`${tag}: cannot check the time on staging. ${error.message}\n${skip}`), { unchecked: error.message });
  }
  if (soak.waiting.length)
    throw Object.assign(new Error(`${tag}: some changes were on staging for less than the minimum time:\n${soak.waiting.map((change) => `- ${changeLine(change)}`).join("\n")}\n${skip}`), { soak });
  // Publishing checks again if a release comes out before approval.
  await writeFile(join(output, CHECKED), `${JSON.stringify({ baseline: previous, minimum }, null, 2)}\n`);
  return { manifest, pending: true, dependencies, soak, overridden: false };
}

/** A duration such as 30m, 2h or 1d, in milliseconds. */
export function parseAge(text) {
  const match = AGE.exec(String(text).trim());
  if (!match) throw new Error(`Invalid minimum staging age "${text}". Use minutes, hours or days, for example 30m, 2h or 1d.`);
  return Number(match[1]) * AGE_UNIT[match[2]];
}

/** A duration for people, in whole minutes rounded with `round`. */
export function formatAge(milliseconds, round = Math.floor) {
  const minutes = Math.max(0, round(milliseconds / 60_000));
  const parts = [[Math.floor(minutes / 1440), "d"], [Math.floor((minutes % 1440) / 60), "h"], [minutes % 60, "m"]].filter(([count]) => count);
  return parts.length ? parts.map(([count, unit]) => `${count}${unit}`).join(" ") : "0m";
}

const changeName = ({ sha, pull, subject }) => (pull ? `#${pull.number} ${pull.title}` : `${sha.slice(0, 12)} ${subject}`);
const onStaging = (change) => (change.since === undefined ? "none" : formatAge(change.age));
const minimumOf = (change) => `${formatAge(change.required)}${change.declared ? " (PR label)" : ""}`;
const changeLine = (change) => `${changeName(change)}: on staging ${onStaging(change)}, minimum ${minimumOf(change)}`;

/**
 * How long each change the build carries, since the latest release, has run
 * on staging. Staging Macs install the newest staging release and every later
 * build on main still carries a change, so a change's clock starts with the
 * first staging release that carries it. Publishing a release sends GitGate's
 * staging Macs back to it until the next main push, so only staging releases
 * published after the latest release count. Each change needs `minimum`, or
 * the longer age its pull request's min-staging-age:<age> label declares;
 * labels only ever lengthen the wait. The build waits for every change.
 */
export function stagingSoak({ repository, sourceSha, latest, minimum, now = Date.now(), run = exec }) {
  const api = (path) => JSON.parse(run("gh", ["api", path]));
  const release = (tag) => {
    try {
      return api(`repos/${repository}/releases/tags/${tag}`);
    } catch (error) {
      if (notFound(error)) return undefined;
      throw error;
    }
  };
  // With no release yet, the build's own commit is the only change.
  let commits = [api(`repos/${repository}/commits/${sourceSha}`)];
  let after = -Infinity;
  if (latest) {
    const base = tagCommit(run, repository, latest);
    if (!base) throw new Error(`${latest} does not point to a commit.`);
    // Without the release's publish time there is no telling which staging
    // builds came after it, so refuse rather than count them all.
    after = Date.parse(release(latest)?.published_at ?? "");
    if (!Number.isFinite(after))
      throw new Error(`${latest} has no published GitHub release.`);
    commits = [];
    for (let page = 1; ; page++) {
      const { total_commits: total, commits: batch } = api(`repos/${repository}/compare/${base}...${sourceSha}?per_page=100&page=${page}`);
      commits.push(...batch);
      if (!batch.length || commits.length >= total) break;
    }
  }
  const position = new Map(commits.map(({ sha }, index) => [sha, index]));
  // The earliest counted staging release built at each commit of the range.
  const firstAt = new Array(commits.length).fill(Infinity);
  for (const { ref, object } of JSON.parse(run("gh", ["api", `repos/${repository}/git/matching-refs/tags/v`]))) {
    const tag = ref.slice("refs/tags/".length);
    if (!STAGING_TAG.test(tag)) continue;
    const index = position.get(object.type === "commit" ? object.sha : tagCommit(run, repository, tag));
    if (index === undefined) continue;
    const staged = release(tag);
    const published = Date.parse(staged?.published_at ?? "");
    if (!staged?.prerelease || staged.draft || !(published > after)) continue;
    firstAt[index] = Math.min(firstAt[index], published);
  }
  // A change rides in the builds at its own commit and every later one.
  const since = new Array(commits.length);
  for (let index = commits.length - 1, earliest = Infinity; index >= 0; index--) {
    earliest = Math.min(earliest, firstAt[index]);
    since[index] = Number.isFinite(earliest) ? earliest : undefined;
  }
  const changes = commits.map(({ sha, commit }, index) => {
    let pulls;
    try {
      pulls = api(`repos/${repository}/commits/${sha}/pulls`);
    } catch (error) {
      // GitHub answers 403 both for a missing permission and for rate limiting; any other 403 is passed on as is.
      const stderr = String(error?.stderr ?? "");
      if (/Resource not accessible by integration/i.test(stderr))
        throw new Error(`GitHub refused access to the pull requests of ${repository}. Give the promote job pull-requests: read.`);
      if (/rate limit/i.test(stderr)) throw new Error(`The GitHub API rate limit stopped access to the pull requests of ${repository}. Try again later.`);
      throw error;
    }
    // Only the pull request that merged the change into main declares its age.
    const pull = pulls.find((candidate) => candidate.merged_at && candidate.base?.ref === "main") ?? null;
    let required = minimum;
    let declared = null;
    for (const { name } of pull?.labels ?? []) {
      const label = AGE_LABEL.exec(name);
      if (!label) continue;
      const age = parseAge(label[1]);
      if (age > required) [required, declared] = [age, name];
    }
    const age = since[index] === undefined ? 0 : now - since[index];
    return {
      sha,
      subject: (commit?.message ?? "").split("\n")[0],
      pull: pull && { number: pull.number, title: pull.title },
      required,
      declared,
      since: since[index],
      age,
      remaining: required - age,
    };
  });
  // A pull request merged with its own commits is one change: its last commit's wait.
  const byPull = new Map();
  for (const change of changes) {
    const key = change.pull ? `#${change.pull.number}` : change.sha;
    if (!byPull.has(key) || change.remaining > byPull.get(key).remaining) byPull.set(key, change);
  }
  const merged = [...byPull.values()];
  return { minimum, changes: merged, waiting: merged.filter(({ remaining }) => remaining > 0) };
}

/** The reviewer's section on time on staging: an optional note, then each change. */
export function soakSummary(soak, note = "") {
  const lines = ["### Time on staging", ""];
  if (note) lines.push(note, "");
  if (soak) {
    const rows = soak.changes.map((change) => `| ${changeName(change).replaceAll("|", "\\|")} | ${onStaging(change)} | ${minimumOf(change)} |`);
    lines.push("| Change | On staging | Minimum |", "| --- | --- | --- |", ...rows, "");
  }
  return lines;
}

function productionReleaseExists(run, manifest) {
  try {
    return JSON.parse(run("gh", ["release", "view", manifest.productionTag, "--repo", manifest.repository, "--json", "isPrerelease"])).isPrerelease === false;
  } catch (error) {
    if (/release not found/i.test(String(error?.stderr ?? ""))) return false;
    throw error;
  }
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      "approved-by": { type: "string", default: "" },
      bump: { type: "string" },
      channel: { type: "string" },
      directory: { type: "string" },
      environment: { type: "string" },
      library: { type: "string", default: "false" },
      "minimum-age": { type: "string", default: "" },
      output: { type: "string" },
      package: { type: "string" },
      production: { type: "string" },
      "required-releases": { type: "string", default: "" },
      "signer-workflow": { type: "string" },
      "skip-minimum-age-reason": { type: "string", default: "" },
      staging: { type: "string" },
      suffix: { type: "string" },
      version: { type: "string", default: "" },
    },
  });
  const env = process.env;
  const repository = env.GITHUB_REPOSITORY;
  const library = values.library === "true";
  const summarize = (markdown) => env.GITHUB_STEP_SUMMARY && writeFile(env.GITHUB_STEP_SUMMARY, `${markdown}\n`, { flag: "a" });
  const outputs = (entries) =>
    env.GITHUB_OUTPUT && writeFile(env.GITHUB_OUTPUT, Object.entries(entries).map(([key, value]) => `${key}=${value}\n`).join(""), { flag: "a" });
  switch (positionals[0]) {
    case "collect": {
      const manifest = await collect({
        stagingPackage: values.staging && resolve(values.staging),
        productionPackage: values.production && resolve(values.production),
        packageName: values.package,
        library,
        bump: JSON.parse(values.bump ?? "null"),
        suffix: values.suffix,
        sourceSha: env.GITHUB_SHA,
        repository,
        output: resolve(values.output),
        runUrl: `${env.GITHUB_SERVER_URL}/${repository}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`,
      });
      await summarize(releaseNotes(manifest, "staging"));
      await outputs({ "staging-version": manifest.stagingTag.slice(1), "production-version": manifest.productionTag.slice(1) });
      return;
    }
    case "publish": {
      let published;
      try {
        published = await publish({
          directory: resolve(values.directory),
          channel: values.channel,
          repository,
          sourceSha: values.channel === "staging" ? env.GITHUB_SHA : undefined,
          packageName: values.package,
          library,
          runId: env.GITHUB_RUN_ID,
          bump: values.bump && JSON.parse(values.bump),
        });
      } catch (error) {
        const skip = "A release came out after this build was resolved. To promote now, run the promotion again with `skip-minimum-age-reason`.";
        if (error.soak) await summarize(soakSummary(error.soak, `Some changes were on staging for less than the minimum time since then. ${skip}`).join("\n"));
        if (error.unchecked !== undefined) await summarize(soakSummary(undefined, `Cannot check the time on staging again. ${error.unchecked} ${skip}`).join("\n"));
        throw error;
      }
      const { tag } = published;
      await summarize(`Published ${values.channel} release [\`${tag}\`](${env.GITHUB_SERVER_URL}/${repository}/releases/tag/${tag}).`);
      return;
    }
    case "resolve": {
      const reason = values["skip-minimum-age-reason"].trim();
      let resolved;
      try {
        resolved = await resolveCandidate({
          repository,
          packageName: values.package,
          library,
          version: values.version,
          approvedBy: values["approved-by"],
          environment: values.environment,
          signerWorkflow: values["signer-workflow"],
          output: resolve(values.output),
          minimumAge: values["minimum-age"],
          skipMinimumAge: reason,
          requiredReleases: values["required-releases"],
          dependencyRun: env.DEPENDENCY_TOKEN ? (command, args) => exec(command, args, { ...env, GH_TOKEN: env.DEPENDENCY_TOKEN }) : exec,
        });
      } catch (error) {
        const skip = "To promote now, set `skip-minimum-age-reason`.";
        if (error.soak) await summarize(soakSummary(error.soak, `Some changes were on staging for less than the minimum time. ${skip}`).join("\n"));
        if (error.unchecked !== undefined) await summarize(soakSummary(undefined, `Cannot check the time on staging. ${error.unchecked} ${skip}`).join("\n"));
        throw error;
      }
      const { manifest, pending, dependencies, soak } = resolved;
      const released = dependencies.length
        ? [
            "Its dependencies were these production releases when promotion resolved:",
            "",
            "| Repository | Release | Required by |",
            "| --- | --- | --- |",
            ...dependencies.map(({ repository: name, release, requiredBy }) => `| ${name} | \`${release}\` | ${requiredBy} |`),
            "",
          ]
        : [];
      await summarize(
        pending
          ? [
              `### Promote \`${manifest.stagingTag}\` to production`,
              "",
              releaseNotes(manifest, "production", resolved.overridden ? { reason } : null),
              ...released,
              // With a skip reason there is no table; the release notes above give the reason.
              ...(soak ? soakSummary(soak) : []),
              "Approve the deployment to release this exact build.",
            ].join("\n")
          : `### \`${manifest.stagingTag}\` is already released as \`${manifest.productionTag}\`\n\nNothing to publish.`
      );
      await outputs({ pending, version: manifest.bump.version });
      return;
    }
    default:
      throw new Error("Usage: swift-release.mjs collect|publish|resolve [options]");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(`::error::${error.message.replaceAll("\n", "%0A")}`);
    process.exitCode = 1;
  }
}
