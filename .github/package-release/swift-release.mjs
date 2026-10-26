import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import semver from "semver";
import { bumpProblem, ensureRelease, ensureTag, exec, requireReviewers, sha256, tagCommit } from "./package-release.mjs";
import { bumpNotes, latestReleaseTag } from "./release-version.mjs";

const MANIFEST = "release-manifest.json";
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SUFFIX = /^-staging\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[a-f0-9]{40}$/;
const STAGING_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-staging\.(\d+)\.(\d+)$/;

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

export function releaseNotes(manifest, channel) {
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
  lines.push("", ...bumpNotes(manifest.bump, manifest.repository));
  return `${lines.join("\n")}\n`;
}

/**
 * Publish one channel of a verified build: its tag on the source commit and
 * its release. Every step can be retried; an existing tag on the same commit
 * and an existing release are accepted.
 */
export async function publish({ directory, channel, repository, sourceSha, packageName, library = false, runId, bump, run = exec }) {
  const manifest = await readManifest(directory);
  const channels = channel === "staging" ? ["staging", "production"] : ["production"];
  await verifyManifest(directory, manifest, { repository, sourceSha, runId: channel === "staging" ? runId : undefined, packageName, library, channels, bump });
  const tag = channel === "staging" ? manifest.stagingTag : manifest.productionTag;
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
    notes: releaseNotes(manifest, channel),
  });
  return { manifest, tag };
}

/** Tags under `v`, read from GitHub. */
function releaseTags(run, repository) {
  const tags = [];
  for (let page = 1; ; page++) {
    const refs = JSON.parse(run("gh", ["api", `repos/${repository}/git/matching-refs/tags/v?per_page=100&page=${page}`]));
    tags.push(...refs.map(({ ref }) => ref.slice("refs/tags/".length)));
    if (refs.length < 100) return tags;
  }
}

/**
 * Find the build to promote and prove where it came from: staged by the stage
 * workflow from a commit on main, unchanged since, and newer than the latest
 * release. `pending` is false when that release already is this build.
 */
export async function resolveCandidate({ repository, packageName, library = false, version: requested = "", approvedBy = "", environment, signerWorkflow, output, run = exec }) {
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
    return { manifest, pending: !productionReleaseExists(run, manifest) };
  }
  if (latest && !semver.gt(candidate, latest))
    throw new Error(`${tag} cannot be promoted: ${candidate} is not newer than the latest release ${latest}; stage a newer build`);
  return { manifest, pending: true };
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
      output: { type: "string" },
      package: { type: "string" },
      production: { type: "string" },
      "signer-workflow": { type: "string" },
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
      const { tag } = await publish({
        directory: resolve(values.directory),
        channel: values.channel,
        repository,
        sourceSha: values.channel === "staging" ? env.GITHUB_SHA : undefined,
        packageName: values.package,
        library,
        runId: env.GITHUB_RUN_ID,
        bump: values.bump && JSON.parse(values.bump),
      });
      await summarize(`Published ${values.channel} release [\`${tag}\`](${env.GITHUB_SERVER_URL}/${repository}/releases/tag/${tag}).`);
      return;
    }
    case "resolve": {
      const { manifest, pending } = await resolveCandidate({
        repository,
        packageName: values.package,
        library,
        version: values.version,
        approvedBy: values["approved-by"],
        environment: values.environment,
        signerWorkflow: values["signer-workflow"],
        output: resolve(values.output),
      });
      await summarize(
        pending
          ? [`### Promote \`${manifest.stagingTag}\` to production`, "", releaseNotes(manifest, "production"), "Approve the deployment to release this exact build."].join("\n")
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
