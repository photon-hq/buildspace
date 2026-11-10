import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import semver from "semver";
import {
  exec, MANIFEST, notFound, NPMJS, readManifest, registryMetadata, releaseNames,
  SHA, verifyManifest,
} from "./package-artifacts.mjs";
import { bumpNotes } from "./release-version.mjs";

const CHANNEL_TAG = { staging: "staging", production: "latest" };

/** Fail while CI on the exact commit has failed; wait while it is pending. */
export function ciStatus(response, { sha, workflow }) {
  const latest = (response.workflow_runs ?? [])
    .filter(
      (run) =>
        run.path === `.github/workflows/${workflow}` &&
        run.head_sha === sha &&
        run.head_branch === "main" &&
        run.event === "push"
    )
    .sort((left, right) => right.id - left.id)[0];
  if (latest?.status !== "completed") return "pending";
  if (latest.conclusion !== "success")
    throw new Error(`CI run ${latest.html_url ?? latest.id} concluded ${latest.conclusion}`);
  return "success";
}

export async function waitForCi({
  repository,
  sha,
  workflow,
  timeoutMs,
  run = exec,
  now = Date.now,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
}) {
  if (!SHA.test(sha)) throw new Error("An exact source commit is required");
  const deadline = now() + timeoutMs;
  for (;;) {
    const response = JSON.parse(
      run("gh", [
        "api",
        `repos/${repository}/actions/workflows/${workflow}/runs?head_sha=${sha}&event=push&branch=main&per_page=100`,
      ])
    );
    if (ciStatus(response, { sha, workflow }) === "success") return;
    const remaining = deadline - now();
    if (remaining <= 0)
      throw new Error(`Timed out waiting for ${workflow} to pass on ${sha}`);
    await sleep(Math.min(15_000, remaining));
  }
}

export function tagCommit(run, repository, tag) {
  let reference;
  try {
    reference = JSON.parse(run("gh", ["api", `repos/${repository}/git/ref/tags/${tag}`])).object;
  } catch (error) {
    if (notFound(error)) return undefined;
    throw error;
  }
  for (let depth = 0; reference.type === "tag" && depth < 8; depth++)
    reference = JSON.parse(run("gh", ["api", `repos/${repository}/git/tags/${reference.sha}`])).object;
  if (reference.type !== "commit") throw new Error(`Tag ${tag} does not name a commit`);
  return reference.sha;
}

/** Commit subjects between the previous production tag and the source. */
export function changesSince(run, repository, previousTag, sourceSha) {
  if (!previousTag || tagCommit(run, repository, previousTag) === undefined) return undefined;
  const comparison = JSON.parse(
    run("gh", ["api", `repos/${repository}/compare/${previousTag}...${sourceSha}`])
  );
  return {
    previousTag,
    total: comparison.total_commits,
    subjects: (comparison.commits ?? [])
      .map((commit) => commit.commit.message.split("\n")[0])
      .reverse(),
  };
}

export function packageTable(manifest, channels) {
  const header = channels.map((channel) => ` ${channel} |`).join("");
  return [
    `| Package |${header}`,
    `| --- |${channels.map(() => " --- |").join("")}`,
    ...manifest.packages.map(
      (pkg) =>
        `| \`${pkg.name}\` |${channels.map((channel) => ` \`${pkg[channel].version}\` |`).join("")}`
    ),
  ];
}

/** A build's crates, and the Cargo dependency that pins them at a tag. */
export function crateTable(manifest, tag) {
  if (!manifest.crates.length) return [];
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  return [
    "",
    "| Crate | Version |",
    "| --- | --- |",
    ...manifest.crates.map(({ name, version }) => `| \`${name}\` | \`${version}\` |`),
    "",
    "```toml",
    ...manifest.crates.map(
      ({ name, version }) => `${name} = { version = "=${version}", git = "${server}/${manifest.repository}", tag = "${tag}" }`
    ),
    "```",
  ];
}

export function releaseNotes(manifest, channel, changes) {
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const source = `[\`${manifest.sourceSha.slice(0, 12)}\`](${server}/${manifest.repository}/commit/${manifest.sourceSha})`;
  const lines =
    channel === "staging"
      ? [
          `Staging build of ${source} ([run](${manifest.runUrl})). The production candidates are attached; promote this build with \`staging-version: ${manifest.packages.find(({ name }) => name === manifest.package).staging.version}\`.`,
          "",
          ...packageTable(manifest, ["staging", "production"]),
          ...crateTable(manifest, manifest.stagingTag),
        ]
      : [
          `Promoted from [\`${manifest.stagingTag}\`](${server}/${manifest.repository}/releases/tag/${manifest.stagingTag}), built from ${source} ([run](${manifest.runUrl})).`,
          "",
          ...packageTable(manifest, ["production"]),
          ...crateTable(manifest, manifest.productionTag),
        ];
  if (manifest.bump) lines.push("", ...bumpNotes(manifest.bump, manifest.repository));
  else if (changes) {
    lines.push(
      "",
      `### Changes since [\`${changes.previousTag}\`](${server}/${manifest.repository}/compare/${changes.previousTag}...${manifest.sourceSha})`,
      "",
      ...changes.subjects.map((subject) => `- ${subject}`)
    );
    if (changes.total > changes.subjects.length)
      lines.push(`- …and ${changes.total - changes.subjects.length} more`);
  }
  return `${lines.join("\n")}\n`;
}

export function ensureTag(run, manifest, tag) {
  const commit = tagCommit(run, manifest.repository, tag);
  if (commit === undefined)
    run("gh", [
      "api",
      "--method",
      "POST",
      `repos/${manifest.repository}/git/refs`,
      "-f",
      `ref=refs/tags/${tag}`,
      "-f",
      `sha=${manifest.sourceSha}`,
    ]);
  else if (commit !== manifest.sourceSha)
    throw new Error(`Tag ${tag} already names ${commit}, not ${manifest.sourceSha}`);
}

export async function ensureRelease(run, { directory, manifest, channel, tag, title, files, notes }) {
  let existing;
  try {
    existing = JSON.parse(
      run("gh", ["release", "view", tag, "--repo", manifest.repository, "--json", "assets,isPrerelease"])
    );
  } catch (error) {
    if (!notFound(error, /release not found/i)) throw error;
  }
  const paths = (names) => names.map((name) => join(directory, name));
  if (existing === undefined) {
    const notesFile = join(await mkdtemp(join(tmpdir(), "package-release-")), "notes.md");
    await writeFile(notesFile, notes);
    run("gh", [
      "release",
      "create",
      tag,
      ...paths(files),
      "--repo",
      manifest.repository,
      "--verify-tag",
      "--title",
      title,
      "--notes-file",
      notesFile,
      ...(channel === "staging" ? ["--prerelease", "--latest=false"] : []),
    ]);
    return;
  }
  if (existing.isPrerelease !== (channel === "staging"))
    throw new Error(`Release ${tag} exists with the wrong prerelease state`);
  const present = new Set(existing.assets.map(({ name }) => name));
  const missing = files.filter((name) => !present.has(name));
  if (missing.length)
    run("gh", ["release", "upload", tag, ...paths(missing), "--repo", manifest.repository]);
}

/**
 * The integrity a version was published with, once the registry serves it.
 * npmjs scans a new version for a few minutes before it appears.
 */
export async function publishedIntegrity({ registry, name, version, timeoutMs, now, sleep }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const integrity = (await registry(name)).versions[version]?.dist?.integrity;
    if (integrity) return integrity;
    const remaining = deadline - now();
    if (remaining <= 0)
      throw new Error(`${name}@${version} was published but the registry did not serve it within ${timeoutMs / 60_000} minutes; retry the job once it does`);
    await sleep(Math.min(15_000, remaining));
  }
}

/**
 * Publish one channel of a verified build. Every step can be retried: a version
 * already published with the same contents, an existing tag on the same commit
 * and an existing release are accepted; anything else stops before changing it.
 * Crates have no registry: the release tag is what Cargo resolves them from.
 * npmjs is reached through trusted publishing, with provenance.
 */
export async function publish({
  directory,
  channel,
  repository,
  sourceSha,
  packageInput,
  packageSelection,
  tagPrefix,
  productionTagPrefix,
  registryUrl,
  crates,
  runId,
  runAttempt,
  bump,
  run = exec,
  registry,
  log = console.log,
  availabilityTimeoutMs = 30 * 60_000,
  now = Date.now,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
}) {
  const manifest = await readManifest(directory);
  const names = releaseNames({ repository, packageInput, packageSelection, tagPrefix, productionTagPrefix, registryUrl });
  registry ??= registryMetadata(names.registryUrl);
  const target = `--registry=${names.registryUrl}`;
  const uploaded = channel === "staging" ? ["staging", "production"] : ["production"];
  await verifyManifest(directory, manifest, {
    repository,
    sourceSha,
    runId: channel === "staging" ? runId : undefined,
    packageInput,
    packageSelection,
    tagPrefix,
    productionTagPrefix,
    registryUrl,
    channels: uploaded,
    crates,
    bump,
  });
  const parking = `candidate-${runId}-${runAttempt}`;
  if (!/^candidate-\d+-\d+$/.test(parking)) throw new Error("Invalid run coordinates");
  const parked = [];
  for (const pkg of manifest.packages) {
    const { version, file, integrity: expected } = pkg[channel];
    const existing = (await registry(pkg.name)).versions[version];
    if (existing) {
      if (existing.dist?.integrity !== expected)
        throw new Error(`${pkg.name}@${version} is already published with different contents`);
      log(`${pkg.name}@${version} is already published with these contents`);
      continue;
    }
    run("npm", [
      "publish",
      join(directory, file),
      "--tag",
      parking,
      "--ignore-scripts",
      ...(names.registryUrl === NPMJS ? ["--access", "public", "--provenance"] : []),
      target,
    ]);
    parked.push(pkg.name);
    const published = await publishedIntegrity({ registry, name: pkg.name, version, timeoutMs: availabilityTimeoutMs, now, sleep });
    if (published !== expected)
      throw new Error(`${pkg.name}@${version} was published with different contents; investigate before retrying`);
  }
  const released = manifest.packages.find(({ name }) => name === manifest.package)[channel].version;
  const tag = channel === "staging" ? manifest.stagingTag : manifest.productionTag;
  let changes;
  if (channel === "production" && !manifest.bump) {
    const latest = (await registry(manifest.package))["dist-tags"].latest;
    if (latest && latest !== released)
      changes = changesSince(run, manifest.repository, `${names.productionTagPrefix}${latest}`, manifest.sourceSha);
  }
  ensureTag(run, manifest, tag);
  await ensureRelease(run, {
    directory,
    manifest,
    channel,
    tag,
    title: `${manifest.package} ${released}`,
    files: [
      ...manifest.packages.flatMap((pkg) => uploaded.map((name) => pkg[name].file)),
      ...manifest.crates.map(({ file }) => file),
      MANIFEST,
    ],
    notes: releaseNotes(manifest, channel, changes),
  });
  const channelTag = CHANNEL_TAG[channel];
  for (const pkg of manifest.packages) {
    const { version } = pkg[channel];
    const current = (await registry(pkg.name))["dist-tags"][channelTag];
    if (!current || semver.gt(version, current))
      run("npm", ["dist-tag", "add", `${pkg.name}@${version}`, channelTag, target]);
    else log(`Kept ${pkg.name}@${channelTag} on ${current}, which is not older than ${version}`);
  }
  for (const name of parked)
    run("npm", ["dist-tag", "rm", name, parking, target]);
  return { manifest, tag };
}
