import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import semver from "semver";

const REGISTRY = "https://npm.pkg.github.com";
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SUFFIX = /^-staging\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[a-f0-9]{40}$/;
const MANIFEST = "release-manifest.json";
const CHANNEL_TAG = { staging: "staging", production: "latest" };
const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies"];

export const sha256 = (buffer) =>
  createHash("sha256").update(buffer).digest("hex");
export const integrity = (buffer) =>
  `sha512-${createHash("sha512").update(buffer).digest("base64")}`;
const fileName = (name, version) =>
  `${name.slice(1).replace("/", "-")}-${version}.tgz`;

export function exec(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const notFound = (error, pattern = /HTTP 404/) =>
  pattern.test(String(error?.stderr ?? ""));

export async function registryMetadata(
  name,
  token = process.env.NODE_AUTH_TOKEN
) {
  if (!token) throw new Error("NODE_AUTH_TOKEN is required to read GitHub Packages");
  const response = await fetch(`${REGISTRY}/${encodeURIComponent(name)}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return { versions: {}, "dist-tags": {} };
  if (!response.ok)
    throw new Error(`${name}: registry returned HTTP ${response.status}`);
  const body = await response.json();
  return { versions: body.versions ?? {}, "dist-tags": body["dist-tags"] ?? {} };
}

function cached(registry) {
  const entries = new Map();
  return (name) => {
    if (!entries.has(name)) entries.set(name, registry(name));
    return entries.get(name);
  };
}

export function readTarballManifest(path) {
  return JSON.parse(
    execFileSync("tar", ["-xOzf", path, "package/package.json"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    })
  );
}

/** A package's internal dependencies are published before it. */
export function publishOrder(manifests) {
  const order = [];
  const state = new Map();
  const visit = (name, path) => {
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting")
      throw new Error(`Packages depend on each other: ${[...path, name].join(" -> ")}`);
    state.set(name, "visiting");
    const manifest = manifests.get(name);
    for (const field of [...DEPENDENCY_FIELDS, "peerDependencies"])
      for (const dependency of Object.keys(manifest[field] ?? {}).sort())
        if (dependency !== name && manifests.has(dependency))
          visit(dependency, [...path, name]);
    state.set(name, "done");
    order.push(name);
  };
  for (const name of [...manifests.keys()].sort()) visit(name, []);
  return order;
}

export function releaseNames(repository, packageInput = "", tagPrefix = "") {
  const [owner, repo] = repository.split("/");
  return {
    scope: `@${owner}/`,
    primary: packageInput || `@${owner}/${repo}`,
    tagPrefix: tagPrefix || `${repo}-staging-`,
  };
}

async function readPacked(directory, scope) {
  const files = (await readdir(directory)).filter((file) => file.endsWith(".tgz")).sort();
  if (!files.length)
    throw new Error(`The pack command wrote no .tgz file to ${directory}`);
  const packed = new Map();
  for (const file of files) {
    const path = join(directory, file);
    const manifest = readTarballManifest(path);
    if (typeof manifest.name !== "string" || !manifest.name.startsWith(scope))
      throw new Error(`${file}: the package name must use the ${scope} scope`);
    if (packed.has(manifest.name))
      throw new Error(`${manifest.name} was packed more than once`);
    packed.set(manifest.name, { path, manifest });
  }
  return packed;
}

/**
 * Validate the two packs of one source commit and lay them out with a manifest
 * that promotion can verify: the staging build and its stable candidate.
 */
export async function collect({
  stagingDirectory,
  productionDirectory,
  suffix,
  sourceSha,
  repository,
  packageInput,
  tagPrefix,
  output,
  runUrl,
}) {
  if (!SUFFIX.test(suffix)) throw new Error(`Invalid staging suffix: ${suffix}`);
  if (!SHA.test(sourceSha)) throw new Error("An exact source commit is required");
  const names = releaseNames(repository, packageInput, tagPrefix);
  const staging = await readPacked(stagingDirectory, names.scope);
  const production = await readPacked(productionDirectory, names.scope);
  const packed = [...production.keys()].sort();
  if (JSON.stringify(packed) !== JSON.stringify([...staging.keys()].sort()))
    throw new Error("The staging and production packs contain different packages");
  if (!production.has(names.primary))
    throw new Error(
      `${names.primary} was not packed; set the package input to the package that names the release`
    );
  for (const name of packed) {
    const candidate = production.get(name).manifest.version;
    const build = staging.get(name).manifest.version;
    if (!STABLE.test(candidate))
      throw new Error(`${name}@${candidate}: a production candidate must be X.Y.Z`);
    if (build !== `${candidate}${suffix}`)
      throw new Error(`${name}: staging packed ${build}, expected ${candidate}${suffix}`);
  }
  await mkdir(output, { recursive: true });
  const entry = async ({ path, manifest }) => {
    const file = fileName(manifest.name, manifest.version);
    await copyFile(path, join(output, file));
    const buffer = await readFile(path);
    return {
      version: manifest.version,
      file,
      sha256: sha256(buffer),
      integrity: integrity(buffer),
    };
  };
  const packages = [];
  for (const name of publishOrder(
    new Map(packed.map((name) => [name, production.get(name).manifest]))
  ))
    packages.push({
      name,
      staging: await entry(staging.get(name)),
      production: await entry(production.get(name)),
    });
  const primary = packages.find(({ name }) => name === names.primary);
  const manifest = {
    formatVersion: 1,
    repository,
    sourceSha,
    runUrl,
    suffix,
    package: names.primary,
    stagingTag: `${names.tagPrefix}${primary.staging.version}`,
    productionTag: `v${primary.production.version}`,
    packages,
  };
  await writeFile(join(output, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function readManifest(directory) {
  const manifest = JSON.parse(await readFile(join(directory, MANIFEST), "utf8"));
  if (manifest.formatVersion !== 1 || !Array.isArray(manifest.packages))
    throw new Error("Unsupported release manifest");
  return manifest;
}

async function verifyFiles(directory, manifest, channels) {
  for (const pkg of manifest.packages)
    for (const channel of channels) {
      const { file, sha256: expected } = pkg[channel];
      if (sha256(await readFile(join(directory, file))) !== expected)
        throw new Error(`${file} does not match the release manifest`);
    }
}

/**
 * Rebuild a manifest's claims from the files it lists and the caller's own
 * coordinates. The build job ran repository code, so a job that writes trusts
 * nothing in the manifest until it matches.
 */
export async function verifyManifest(
  directory,
  manifest,
  { repository, sourceSha, runId, packageInput, tagPrefix, channels }
) {
  const names = releaseNames(repository, packageInput, tagPrefix);
  const fail = (reason) => {
    throw new Error(`The release manifest does not describe this build: ${reason}`);
  };
  if (manifest.repository !== repository) fail(`repository ${manifest.repository}`);
  if (!SHA.test(manifest.sourceSha) || (sourceSha && manifest.sourceSha !== sourceSha))
    fail(`source ${manifest.sourceSha}`);
  if (!SUFFIX.test(manifest.suffix) || (runId && !manifest.suffix.startsWith(`-staging.${runId}.`)))
    fail(`suffix ${manifest.suffix}`);
  if (manifest.package !== names.primary) fail(`package ${manifest.package}`);
  const seen = new Set();
  for (const pkg of manifest.packages) {
    if (typeof pkg.name !== "string" || !pkg.name.startsWith(names.scope) || seen.has(pkg.name))
      fail(`package ${pkg.name}`);
    seen.add(pkg.name);
    if (!STABLE.test(pkg.production.version) || pkg.staging.version !== `${pkg.production.version}${manifest.suffix}`)
      fail(`${pkg.name} versions`);
    for (const channel of channels)
      if (pkg[channel].file !== fileName(pkg.name, pkg[channel].version)) fail(`file ${pkg[channel].file}`);
  }
  await verifyFiles(directory, manifest, channels);
  const packed = new Map();
  for (const pkg of manifest.packages)
    for (const channel of channels) {
      const { file, version } = pkg[channel];
      const contents = readTarballManifest(join(directory, file));
      if (contents.name !== pkg.name || contents.version !== version)
        fail(`${file} holds ${contents.name}@${contents.version}`);
      if (channel === "production") packed.set(pkg.name, contents);
    }
  const primary = manifest.packages.find(({ name }) => name === names.primary);
  if (!primary) fail(`${names.primary} is missing`);
  if (
    manifest.stagingTag !== `${names.tagPrefix}${primary.staging.version}` ||
    manifest.productionTag !== `v${primary.production.version}`
  )
    fail("release tags");
  if (JSON.stringify(publishOrder(packed)) !== JSON.stringify(manifest.packages.map(({ name }) => name)))
    fail("publish order");
}

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

function packageTable(manifest, channels) {
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

export function releaseNotes(manifest, channel, changes) {
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const source = `[\`${manifest.sourceSha.slice(0, 12)}\`](${server}/${manifest.repository}/commit/${manifest.sourceSha})`;
  const lines =
    channel === "staging"
      ? [
          `Staging build of ${source} ([run](${manifest.runUrl})). The production candidates are attached; promote this build with \`staging-version: ${manifest.packages.find(({ name }) => name === manifest.package).staging.version}\`.`,
          "",
          ...packageTable(manifest, ["staging", "production"]),
        ]
      : [
          `Promoted from [\`${manifest.stagingTag}\`](${server}/${manifest.repository}/releases/tag/${manifest.stagingTag}), built from ${source} ([run](${manifest.runUrl})).`,
          "",
          ...packageTable(manifest, ["production"]),
        ];
  if (changes) {
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

function ensureTag(run, manifest, tag) {
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

async function ensureRelease(run, { directory, manifest, channel, tag, title, files, notes }) {
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
    const notesFile = join(await mkdtemp(join(tmpdir(), "npm-release-")), "notes.md");
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
 * Publish one channel of a verified build. Every step can be retried: a version
 * already published with the same contents, an existing tag on the same commit
 * and an existing release are accepted; anything else stops before changing it.
 */
export async function publish({
  directory,
  channel,
  repository,
  sourceSha,
  packageInput,
  tagPrefix,
  runId,
  runAttempt,
  run = exec,
  registry = registryMetadata,
  log = console.log,
}) {
  const manifest = await readManifest(directory);
  const uploaded = channel === "staging" ? ["staging", "production"] : ["production"];
  await verifyManifest(directory, manifest, {
    repository,
    sourceSha,
    runId: channel === "staging" ? runId : undefined,
    packageInput,
    tagPrefix,
    channels: uploaded,
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
    run("npm", ["publish", join(directory, file), "--tag", parking, "--ignore-scripts", `--registry=${REGISTRY}`]);
    parked.push(pkg.name);
    const published = JSON.parse(
      run("npm", ["view", `${pkg.name}@${version}`, "dist.integrity", "--json", `--registry=${REGISTRY}`])
    );
    if (published !== expected)
      throw new Error(`${pkg.name}@${version} was published with different contents; investigate before retrying`);
  }
  const released = manifest.packages.find(({ name }) => name === manifest.package)[channel].version;
  const tag = channel === "staging" ? manifest.stagingTag : manifest.productionTag;
  let changes;
  if (channel === "production") {
    const latest = (await registry(manifest.package))["dist-tags"].latest;
    if (latest && latest !== released)
      changes = changesSince(run, manifest.repository, `v${latest}`, manifest.sourceSha);
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
      MANIFEST,
    ],
    notes: releaseNotes(manifest, channel, changes),
  });
  const channelTag = CHANNEL_TAG[channel];
  for (const pkg of manifest.packages) {
    const { version } = pkg[channel];
    const current = (await registry(pkg.name))["dist-tags"][channelTag];
    if (!current || semver.gt(version, current))
      run("npm", ["dist-tag", "add", `${pkg.name}@${version}`, channelTag, `--registry=${REGISTRY}`]);
    else log(`Kept ${pkg.name}@${channelTag} on ${current}, which is not older than ${version}`);
  }
  for (const name of parked)
    run("npm", ["dist-tag", "rm", name, parking, `--registry=${REGISTRY}`]);
  return { manifest, tag };
}

/** Findings that keep a candidate from production: internal dependencies on unreleased builds. */
export async function dependencyFindings(candidates, scope, registry) {
  const promoted = new Map(candidates.map(({ name, version }) => [name, version]));
  const findings = [];
  for (const { name, manifest } of candidates) {
    for (const field of DEPENDENCY_FIELDS)
      for (const [dependency, spec] of Object.entries(manifest[field] ?? {})) {
        if (!dependency.startsWith(scope)) continue;
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
      if (!dependency.startsWith(scope)) continue;
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
 * Find a staging build's candidates and prove they may become production:
 * built by the stage workflow from main, unchanged, newer than `latest`, and
 * depending only on released packages.
 */
export async function resolveCandidate({
  repository,
  packageInput,
  tagPrefix,
  version: requested,
  environment,
  signerWorkflow,
  output,
  run = exec,
  registry = registryMetadata,
}) {
  const names = releaseNames(repository, packageInput, tagPrefix);
  const environmentRules = (() => {
    try {
      return JSON.parse(run("gh", ["api", `repos/${repository}/environments/${environment}`])).protection_rules ?? [];
    } catch (error) {
      if (notFound(error)) return [];
      throw error;
    }
  })();
  if (!environmentRules.some((rule) => rule.type === "required_reviewers" && rule.reviewers?.length))
    throw new Error(`The ${environment} environment must exist and require a reviewer before anything is promoted`);
  const lookup = cached(registry);
  const version = requested || (await lookup(names.primary))["dist-tags"].staging;
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
  for (const pkg of manifest.packages)
    run("gh", ["release", "download", tag, "--repo", repository, "--pattern", pkg.production.file, "--dir", output, "--clobber"]);
  await verifyManifest(output, manifest, { repository, packageInput, tagPrefix, channels: ["production"] });
  const candidates = [];
  for (const pkg of manifest.packages) {
    const path = join(output, pkg.production.file);
    run("gh", [
      "attestation",
      "verify",
      path,
      "--repo",
      repository,
      "--signer-workflow",
      signerWorkflow,
      "--source-digest",
      manifest.sourceSha,
      "--source-ref",
      "refs/heads/main",
    ]);
    candidates.push({ name: pkg.name, version: pkg.production.version, manifest: readTarballManifest(path) });
  }
  const findings = await dependencyFindings(candidates, names.scope, lookup);
  for (const pkg of manifest.packages) {
    const { version: candidate, integrity: expected } = pkg.production;
    const metadata = await lookup(pkg.name);
    const existing = metadata.versions[candidate];
    const latest = metadata["dist-tags"].latest;
    if (existing && existing.dist?.integrity !== expected)
      findings.push(`${pkg.name}@${candidate} is already published with different contents; bump the version and stage again`);
    else if (!existing && latest && !semver.gt(candidate, latest))
      findings.push(`${pkg.name}@${candidate} is not newer than latest ${latest}; bump the version and stage again`);
  }
  if (findings.length)
    throw new Error(`${tag} cannot be promoted:\n${findings.map((finding) => `- ${finding}`).join("\n")}`);
  const latest = (await lookup(names.primary))["dist-tags"].latest;
  const changes =
    latest && latest !== primary.production.version
      ? changesSince(run, repository, `v${latest}`, manifest.sourceSha)
      : undefined;
  return { manifest, changes };
}

async function summarize(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

async function outputs(values) {
  if (process.env.GITHUB_OUTPUT)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join("")
    );
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      channel: { type: "string" },
      directory: { type: "string" },
      environment: { type: "string" },
      output: { type: "string" },
      package: { type: "string", default: "" },
      production: { type: "string" },
      "signer-workflow": { type: "string" },
      staging: { type: "string" },
      suffix: { type: "string" },
      "tag-prefix": { type: "string", default: "" },
      "timeout-minutes": { type: "string", default: "20" },
      version: { type: "string", default: "" },
      workflow: { type: "string" },
    },
  });
  const env = process.env;
  const repository = env.GITHUB_REPOSITORY;
  const runUrl = `${env.GITHUB_SERVER_URL}/${repository}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`;
  switch (positionals[0]) {
    case "wait-ci":
      await waitForCi({
        repository,
        sha: env.GITHUB_SHA,
        workflow: values.workflow,
        timeoutMs: Number(values["timeout-minutes"]) * 60_000,
      });
      console.log(`${values.workflow} passed on ${env.GITHUB_SHA}`);
      return;
    case "collect": {
      const manifest = await collect({
        stagingDirectory: resolve(values.staging),
        productionDirectory: resolve(values.production),
        suffix: values.suffix,
        sourceSha: env.GITHUB_SHA,
        repository,
        packageInput: values.package,
        tagPrefix: values["tag-prefix"],
        output: resolve(values.output),
        runUrl,
      });
      const warnings = [];
      for (const pkg of manifest.packages) {
        const { version, integrity: packed } = pkg.production;
        const metadata = await registryMetadata(pkg.name);
        const released = metadata.versions[version];
        const latest = metadata["dist-tags"].latest;
        if (released ? released.dist?.integrity !== packed : latest && !semver.gt(version, latest))
          warnings.push(`${pkg.name}@${version} cannot be promoted: ${released ? "it is released with other contents" : `latest is ${latest}`}. Bump its version.`);
      }
      for (const warning of warnings) console.log(`::warning::${warning}`);
      const primary = manifest.packages.find(({ name }) => name === manifest.package);
      await summarize(
        [
          "### Staged packages",
          "",
          ...packageTable(manifest, ["staging", "production"]),
          "",
          `Promote with \`staging-version: ${primary.staging.version}\`.`,
          ...warnings.map((warning) => `\n> [!WARNING]\n> ${warning}`),
        ].join("\n")
      );
      await outputs({ "staging-version": primary.staging.version, "production-version": primary.production.version });
      return;
    }
    case "publish": {
      const { tag } = await publish({
        directory: resolve(values.directory),
        channel: values.channel,
        repository,
        sourceSha: values.channel === "staging" ? env.GITHUB_SHA : undefined,
        packageInput: values.package,
        tagPrefix: values["tag-prefix"],
        runId: env.GITHUB_RUN_ID,
        runAttempt: env.GITHUB_RUN_ATTEMPT,
      });
      await summarize(`Published ${values.channel} release [\`${tag}\`](${env.GITHUB_SERVER_URL}/${repository}/releases/tag/${tag}).`);
      return;
    }
    case "resolve": {
      const { manifest, changes } = await resolveCandidate({
        repository,
        packageInput: values.package,
        tagPrefix: values["tag-prefix"],
        version: values.version,
        environment: values.environment,
        signerWorkflow: values["signer-workflow"],
        output: resolve(values.output),
      });
      await summarize(
        [
          `### Promote \`${manifest.stagingTag}\` to production`,
          "",
          releaseNotes(manifest, "production", changes),
          "Approve the deployment to publish these exact files under `latest`.",
        ].join("\n")
      );
      await outputs({
        version: manifest.packages.find(({ name }) => name === manifest.package).production.version,
      });
      return;
    }
    default:
      throw new Error("Usage: npm-release.mjs wait-ci|collect|publish|resolve [options]");
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
