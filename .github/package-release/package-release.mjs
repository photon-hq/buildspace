import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
import { join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import semver from "semver";
import { parse as parseToml } from "smol-toml";

const REGISTRY = "https://npm.pkg.github.com";
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SUFFIX = /^-staging\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[a-f0-9]{40}$/;
const CRATE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PRODUCTION_TAG_PREFIX = /^(?:[a-z0-9][a-z0-9._-]*-)?v$/;
const EXACT_STABLE = /^=\s*(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MANIFEST = "release-manifest.json";
const CHANNEL_TAG = { staging: "staging", production: "latest" };
const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies"];
const CRATE_DEPENDENCY_TABLES = ["dependencies", "build-dependencies", "build_dependencies"];

export const sha256 = (buffer) =>
  createHash("sha256").update(buffer).digest("hex");
export const integrity = (buffer) =>
  `sha512-${createHash("sha512").update(buffer).digest("base64")}`;
const fileName = (name, version) =>
  `${name.slice(1).replace("/", "-")}-${version}.tgz`;
const crateFile = (name, version) => `${name}-${version}.crate`;
const sorted = (values) => JSON.stringify([...values].sort());

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

/** The regular files of a gzipped tar archive, such as a `.crate`, by path. */
export function readArchive(path) {
  const archive = gunzipSync(readFileSync(path));
  const files = new Map();
  let longName;
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) =>
      header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156]);
    const body = archive.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = body.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    const prefix = header.subarray(257, 263).toString("latin1") === "ustar\0" ? field(345, 155) : "";
    const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = undefined;
    if (type === "5") continue;
    if (type !== "0" && type !== "\0") throw new Error(`${path}: ${name} is not a regular file`);
    if (files.has(name)) throw new Error(`${path} holds ${name} more than once`);
    files.set(name, body);
  }
  return files;
}

/**
 * What a `.crate` says about itself: the normalized manifest's name and
 * version, the commit `cargo package` recorded, and a digest of every file but
 * that record, so an unchanged crate from another commit compares equal.
 */
export function readCrate(path) {
  const files = readArchive(path);
  const roots = new Set([...files.keys()].map((name) => name.split("/")[0]));
  if (roots.size !== 1) throw new Error(`${path} is not a crate`);
  const [root] = roots;
  const text = (name) => files.get(`${root}/${name}`)?.toString("utf8");
  const manifest = parseToml(text("Cargo.toml") ?? "");
  const vcs = JSON.parse(text(".cargo_vcs_info.json") ?? "{}");
  const digest = createHash("sha256");
  for (const name of [...files.keys()].sort())
    if (name !== `${root}/.cargo_vcs_info.json`) digest.update(`${name}\0${sha256(files.get(name))}\n`);
  return {
    root,
    name: manifest.package?.name,
    version: manifest.package?.version,
    sourceSha: vcs.git?.sha1,
    dirty: vcs.git?.dirty === true,
    path: vcs.path_in_vcs,
    original: text("Cargo.toml.orig") ?? "",
    digest: digest.digest("hex"),
  };
}

/** Why a crate cannot describe this build, if it cannot. */
function crateProblem(crate, sourceSha) {
  if (typeof crate.name !== "string" || !CRATE_NAME.test(crate.name)) return `invalid crate name ${crate.name}`;
  if (!STABLE.test(crate.version ?? "")) return `${crate.name} ${crate.version}: a production candidate must be X.Y.Z`;
  if (crate.root !== `${crate.name}-${crate.version}`) return `${crate.name} is packaged under ${crate.root}`;
  if (crate.sourceSha !== sourceSha || crate.dirty)
    return `${crate.name} was packaged from ${crate.sourceSha ?? "an unknown commit"}${crate.dirty ? " with uncommitted changes" : ""}, not ${sourceSha}`;
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

/**
 * A repository whose `vX.Y.Z` tags already name something else, such as the
 * releases of a service, gives its packages a production tag prefix of their
 * own: `<name>-v`.
 */
export function releaseNames(repository, packageInput = "", tagPrefix = "", productionTagPrefix = "") {
  const [owner, repo] = repository.split("/");
  if (productionTagPrefix && !PRODUCTION_TAG_PREFIX.test(productionTagPrefix))
    throw new Error(`Invalid production tag prefix ${productionTagPrefix}: use v or <name>-v`);
  return {
    scope: `@${owner}/`,
    primary: packageInput || `@${owner}/${repo}`,
    tagPrefix: tagPrefix || `${repo}-staging-`,
    productionTagPrefix: productionTagPrefix || "v",
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

async function readCrates(directory, expected, sourceSha) {
  const files = expected.length
    ? (await readdir(directory)).filter((file) => file.endsWith(".crate")).sort()
    : [];
  const packaged = new Map();
  for (const file of files) {
    const path = join(directory, file);
    const crate = readCrate(path);
    const problem = crateProblem(crate, sourceSha);
    if (problem) throw new Error(`${file}: ${problem}`);
    if (packaged.has(crate.name)) throw new Error(`${crate.name} was packaged more than once`);
    packaged.set(crate.name, { path, version: crate.version });
  }
  if (sorted(packaged.keys()) !== sorted(expected))
    throw new Error(`The packaged crates (${[...packaged.keys()].join(", ") || "none"}) are not the crates input (${expected.join(", ")})`);
  return packaged;
}

/**
 * Validate the two packs of one source commit, and the crates packaged from it,
 * and lay them out with a manifest that promotion can verify: the staging build
 * and its stable candidates.
 */
export async function collect({
  stagingDirectory,
  productionDirectory,
  crateDirectory,
  crates = [],
  suffix,
  sourceSha,
  repository,
  packageInput,
  tagPrefix,
  productionTagPrefix,
  output,
  runUrl,
}) {
  if (!SUFFIX.test(suffix)) throw new Error(`Invalid staging suffix: ${suffix}`);
  if (!SHA.test(sourceSha)) throw new Error("An exact source commit is required");
  const names = releaseNames(repository, packageInput, tagPrefix, productionTagPrefix);
  // Cargo pins an internal crate by the vX.Y.Z tag of its release.
  if (crates.length && names.productionTagPrefix !== "v")
    throw new Error("Crates are released under vX.Y.Z tags; a build with crates cannot use another production tag prefix");
  const staging = await readPacked(stagingDirectory, names.scope);
  const production = await readPacked(productionDirectory, names.scope);
  const packaged = await readCrates(crateDirectory, crates, sourceSha);
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
  const crateEntries = [];
  for (const [name, { path, version }] of [...packaged].sort(([left], [right]) => left.localeCompare(right))) {
    const file = crateFile(name, version);
    await copyFile(path, join(output, file));
    crateEntries.push({ name, version, file, sha256: sha256(await readFile(path)) });
  }
  const primary = packages.find(({ name }) => name === names.primary);
  const manifest = {
    formatVersion: 2,
    repository,
    sourceSha,
    runUrl,
    suffix,
    package: names.primary,
    stagingTag: `${names.tagPrefix}${primary.staging.version}`,
    productionTag: `${names.productionTagPrefix}${primary.production.version}`,
    packages,
    crates: crateEntries,
  };
  await writeFile(join(output, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Format 1 predates crates; it is read as a build without any. */
export async function readManifest(directory) {
  const manifest = JSON.parse(await readFile(join(directory, MANIFEST), "utf8"));
  if (manifest.formatVersion === 1) manifest.crates = [];
  if (![1, 2].includes(manifest.formatVersion) || !Array.isArray(manifest.packages) || !Array.isArray(manifest.crates))
    throw new Error("Unsupported release manifest");
  return manifest;
}

async function verifyFiles(directory, manifest, channels) {
  const files = [
    ...manifest.packages.flatMap((pkg) => channels.map((channel) => pkg[channel])),
    ...manifest.crates,
  ];
  for (const { file, sha256: expected } of files)
    if (sha256(await readFile(join(directory, file))) !== expected)
      throw new Error(`${file} does not match the release manifest`);
}

/**
 * Rebuild a manifest's claims from the files it lists and the caller's own
 * coordinates. The build job ran repository code, so a job that writes trusts
 * nothing in the manifest until it matches.
 */
export async function verifyManifest(
  directory,
  manifest,
  { repository, sourceSha, runId, packageInput, tagPrefix, productionTagPrefix, channels, crates }
) {
  const names = releaseNames(repository, packageInput, tagPrefix, productionTagPrefix);
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
  const crateNames = new Set();
  for (const crate of manifest.crates) {
    if (!CRATE_NAME.test(crate.name ?? "") || crateNames.has(crate.name)) fail(`crate ${crate.name}`);
    crateNames.add(crate.name);
    if (!STABLE.test(crate.version ?? "")) fail(`${crate.name} version`);
    if (crate.file !== crateFile(crate.name, crate.version)) fail(`file ${crate.file}`);
  }
  if (crates && sorted(crateNames) !== sorted(crates)) fail(`crates ${[...crateNames].join(", ") || "none"}`);
  await verifyFiles(directory, manifest, channels);
  for (const crate of manifest.crates) {
    const contents = readCrate(join(directory, crate.file));
    const problem = crateProblem(contents, manifest.sourceSha);
    if (problem) fail(problem);
    if (contents.name !== crate.name || contents.version !== crate.version)
      fail(`${crate.file} holds ${contents.name} ${contents.version}`);
  }
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
    manifest.productionTag !== `${names.productionTagPrefix}${primary.production.version}`
  )
    fail("release tags");
  if (manifest.crates.length && names.productionTagPrefix !== "v") fail("crates under a production tag prefix");
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

/** A build's crates, and the Cargo dependency that pins them at a tag. */
function crateTable(manifest, tag) {
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
 * Publish one channel of a verified build. Every step can be retried: a version
 * already published with the same contents, an existing tag on the same commit
 * and an existing release are accepted; anything else stops before changing it.
 * Crates have no registry: the release tag is what Cargo resolves them from.
 */
export async function publish({
  directory,
  channel,
  repository,
  sourceSha,
  packageInput,
  tagPrefix,
  productionTagPrefix,
  crates,
  runId,
  runAttempt,
  run = exec,
  registry = registryMetadata,
  log = console.log,
}) {
  const manifest = await readManifest(directory);
  const names = releaseNames(repository, packageInput, tagPrefix, productionTagPrefix);
  const uploaded = channel === "staging" ? ["staging", "production"] : ["production"];
  await verifyManifest(directory, manifest, {
    repository,
    sourceSha,
    runId: channel === "staging" ? runId : undefined,
    packageInput,
    tagPrefix,
    productionTagPrefix,
    channels: uploaded,
    crates,
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

/** A crate keeps its version only while its contents are unchanged, and otherwise moves forward. */
export async function crateVersionFindings(manifest, directory, released) {
  const findings = [];
  for (const crate of manifest.crates) {
    const previous = await released(crate.name);
    if (!previous) continue;
    if (previous.version === crate.version) {
      if (previous.digest !== readCrate(join(directory, crate.file)).digest)
        findings.push(`${crate.name} ${crate.version} is already released in ${previous.tag} with other contents; bump its version and stage again`);
    } else if (!semver.gt(crate.version, previous.version))
      findings.push(`${crate.name} ${crate.version} is not newer than ${previous.version} in ${previous.tag}; bump its version and stage again`);
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
export async function resolveCandidate({
  repository,
  packageInput,
  tagPrefix,
  productionTagPrefix,
  version: requested,
  environment,
  signerWorkflow,
  output,
  run = exec,
  registry = registryMetadata,
}) {
  const names = releaseNames(repository, packageInput, tagPrefix, productionTagPrefix);
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
  const files = [...manifest.packages.map((pkg) => pkg.production.file), ...manifest.crates.map(({ file }) => file)];
  for (const file of files)
    run("gh", ["release", "download", tag, "--repo", repository, "--pattern", file, "--dir", output, "--clobber"]);
  await verifyManifest(output, manifest, { repository, packageInput, tagPrefix, productionTagPrefix, channels: ["production"] });
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
    latest && latest !== primary.production.version
      ? changesSince(run, repository, `${names.productionTagPrefix}${latest}`, manifest.sourceSha)
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
      "crate-directory": { type: "string" },
      crates: { type: "string" },
      directory: { type: "string" },
      environment: { type: "string" },
      output: { type: "string" },
      package: { type: "string", default: "" },
      production: { type: "string" },
      "signer-workflow": { type: "string" },
      staging: { type: "string" },
      suffix: { type: "string" },
      "tag-prefix": { type: "string", default: "" },
      "production-tag-prefix": { type: "string", default: "" },
      "timeout-minutes": { type: "string", default: "20" },
      version: { type: "string", default: "" },
      workflow: { type: "string" },
    },
  });
  const env = process.env;
  const repository = env.GITHUB_REPOSITORY;
  const runUrl = `${env.GITHUB_SERVER_URL}/${repository}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`;
  const crates = values.crates?.split(/\s+/).filter(Boolean);
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
        crateDirectory: values["crate-directory"] && resolve(values["crate-directory"]),
        crates: crates ?? [],
        suffix: values.suffix,
        sourceSha: env.GITHUB_SHA,
        repository,
        packageInput: values.package,
        tagPrefix: values["tag-prefix"],
        productionTagPrefix: values["production-tag-prefix"],
        output: resolve(values.output),
        runUrl,
      });
      const warnings = [];
      const lookup = cached(registryMetadata);
      for (const pkg of manifest.packages) {
        const { version, integrity: packed } = pkg.production;
        const metadata = await lookup(pkg.name);
        const released = metadata.versions[version];
        const latest = metadata["dist-tags"].latest;
        if (released ? released.dist?.integrity !== packed : latest && !semver.gt(version, latest))
          warnings.push(`${pkg.name}@${version} cannot be promoted: ${released ? "it is released with other contents" : `latest is ${latest}`}. Bump its version.`);
      }
      const crateHistory = releasedCrates({ repository, latest: (await lookup(manifest.package))["dist-tags"].latest });
      for (const finding of await crateVersionFindings(manifest, resolve(values.output), crateHistory))
        warnings.push(`This build cannot be promoted: ${finding}.`);
      for (const warning of warnings) console.log(`::warning::${warning}`);
      const primary = manifest.packages.find(({ name }) => name === manifest.package);
      await summarize(
        [
          "### Staged packages",
          "",
          ...packageTable(manifest, ["staging", "production"]),
          ...crateTable(manifest, manifest.stagingTag),
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
        productionTagPrefix: values["production-tag-prefix"],
        crates,
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
        productionTagPrefix: values["production-tag-prefix"],
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
      throw new Error("Usage: package-release.mjs wait-ci|collect|publish|resolve [options]");
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
