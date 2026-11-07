import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { parse as parseToml } from "smol-toml";

export const GITHUB_PACKAGES = "https://npm.pkg.github.com";
export const NPMJS = "https://registry.npmjs.org";
const SCOPED_NAME = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const UNSCOPED_NAME = /^[a-z0-9][a-z0-9._-]{0,213}$/;
export const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SUFFIX = /^-staging\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const SHA = /^[a-f0-9]{40}$/;
const CRATE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const PRODUCTION_TAG_PREFIX = /^(?:[a-z0-9][a-z0-9._-]*-)?v$/;
export const MANIFEST = "release-manifest.json";
export const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies"];
const LEVELS = ["none", "patch", "minor", "major"];

export const sha256 = (buffer) =>
  createHash("sha256").update(buffer).digest("hex");
export const integrity = (buffer) =>
  `sha512-${createHash("sha512").update(buffer).digest("base64")}`;
const fileName = (name, version) =>
  `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
export const matchesPackage = (name, selection) =>
  typeof name === "string" && (selection.endsWith("/") ? name.startsWith(selection) : name === selection);
const crateFile = (name, version) => `${name}-${version}.crate`;
const sorted = (values) => JSON.stringify([...values].sort());

export function exec(command, args, env = process.env) {
  return execFileSync(command, args, {
    encoding: "utf8",
    env,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export const notFound = (error, pattern = /HTTP 404/) =>
  pattern.test(String(error?.stderr ?? ""));

/**
 * A registry's reader of package metadata. npmjs is public: it is read without
 * credentials, and with `write=true`, as npm reads before a write, so its CDN
 * cannot answer with a packument or a 404 cached minutes ago.
 */
export function registryMetadata(registryUrl = GITHUB_PACKAGES, token = process.env.NODE_AUTH_TOKEN) {
  const npmjs = registryUrl === NPMJS;
  return async (name) => {
    if (!npmjs && !token) throw new Error("NODE_AUTH_TOKEN is required to read GitHub Packages");
    const response = await fetch(`${registryUrl}/${encodeURIComponent(name)}${npmjs ? "?write=true" : ""}`, {
      headers: npmjs ? { accept: "application/json" } : { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404) return { versions: {}, "dist-tags": {} };
    if (!response.ok)
      throw new Error(`${name}: registry returned HTTP ${response.status}`);
    const body = await response.json();
    return { versions: body.versions ?? {}, "dist-tags": body["dist-tags"] ?? {} };
  };
}

export function cached(registry) {
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

/** Why a bump cannot name a build's version, if it cannot. */
export function bumpProblem(bump) {
  if (!STABLE.test(bump?.version ?? "")) return `version ${bump?.version}`;
  if (bump.from !== null && typeof bump.from !== "string") return `from ${bump.from}`;
  if (!LEVELS.includes(bump.level)) return `level ${bump.level}`;
  if (!Number.isInteger(bump.total) || !Array.isArray(bump.changes) || !Array.isArray(bump.warnings)) return "changes";
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
 * own: `<name>-v`. GitHub Packages holds the owner's scope; a public package
 * on npmjs names its own scope, or only itself when unscoped.
 */
export function releaseNames(repository, packageInput = "", tagPrefix = "", productionTagPrefix = "", registryUrl = GITHUB_PACKAGES) {
  const [owner, repo] = repository.split("/");
  if (productionTagPrefix && !PRODUCTION_TAG_PREFIX.test(productionTagPrefix))
    throw new Error(`Invalid production tag prefix ${productionTagPrefix}: use v or <name>-v`);
  if (![GITHUB_PACKAGES, NPMJS].includes(registryUrl))
    throw new Error(`Unsupported registry ${registryUrl}: use ${GITHUB_PACKAGES} or ${NPMJS}`);
  const unscoped = typeof packageInput === "string" && UNSCOPED_NAME.test(packageInput) && !["node_modules", "favicon.ico"].includes(packageInput);
  if (registryUrl === NPMJS && !SCOPED_NAME.test(packageInput) && !unscoped)
    throw new Error("A package on npmjs is named by the package input, @scope/name or name");
  return {
    registryUrl,
    selection: registryUrl === NPMJS ? (unscoped ? packageInput : `${packageInput.split("/")[0]}/`) : `@${owner}/`,
    primary: packageInput || `@${owner}/${repo}`,
    tagPrefix: tagPrefix || `${repo}-staging-`,
    productionTagPrefix: productionTagPrefix || "v",
  };
}

async function readPacked(directory, selection) {
  const files = (await readdir(directory)).filter((file) => file.endsWith(".tgz")).sort();
  if (!files.length)
    throw new Error(`The pack command wrote no .tgz file to ${directory}`);
  const packed = new Map();
  for (const file of files) {
    const path = join(directory, file);
    const manifest = readTarballManifest(path);
    if (!matchesPackage(manifest.name, selection))
      throw new Error(selection.endsWith("/")
        ? `${file}: the package name must use the ${selection} scope`
        : `${file}: the package name must be ${selection}`);
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
 * and its stable candidates, every package at the version `bump` computed.
 */
export async function collect({
  stagingDirectory,
  productionDirectory,
  crateDirectory,
  crates = [],
  suffix,
  bump,
  sourceSha,
  repository,
  packageInput,
  tagPrefix,
  productionTagPrefix,
  registryUrl,
  output,
  runUrl,
}) {
  if (!SUFFIX.test(suffix)) throw new Error(`Invalid staging suffix: ${suffix}`);
  if (!SHA.test(sourceSha)) throw new Error("An exact source commit is required");
  const problem = bumpProblem(bump);
  if (problem) throw new Error(`Invalid release version: ${problem}`);
  const names = releaseNames(repository, packageInput, tagPrefix, productionTagPrefix, registryUrl);
  // Cargo pins an internal crate by the vX.Y.Z tag of its release.
  if (crates.length && names.productionTagPrefix !== "v")
    throw new Error("Crates are released under vX.Y.Z tags; a build with crates cannot use another production tag prefix");
  const staging = await readPacked(stagingDirectory, names.selection);
  const production = await readPacked(productionDirectory, names.selection);
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
    if (candidate !== bump.version)
      throw new Error(`${name}@${candidate}: every package of the build is packed at its release version ${bump.version}, RELEASE_VERSION`);
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
    formatVersion: 3,
    repository,
    sourceSha,
    runUrl,
    suffix,
    package: names.primary,
    registry: names.registryUrl,
    stagingTag: `${names.tagPrefix}${primary.staging.version}`,
    productionTag: `${names.productionTagPrefix}${primary.production.version}`,
    packages,
    crates: crateEntries,
    bump,
  };
  await writeFile(join(output, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/**
 * Format 1 predates crates; it is read as a build without any. Format 3 records
 * the bump that computed the build's version; earlier builds took theirs from
 * package.json.
 */
export async function readManifest(directory) {
  const manifest = JSON.parse(await readFile(join(directory, MANIFEST), "utf8"));
  if (manifest.formatVersion === 1) manifest.crates = [];
  if (![1, 2, 3].includes(manifest.formatVersion) || !Array.isArray(manifest.packages) || !Array.isArray(manifest.crates))
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
  { repository, sourceSha, runId, packageInput, tagPrefix, productionTagPrefix, registryUrl, channels, crates, bump }
) {
  const names = releaseNames(repository, packageInput, tagPrefix, productionTagPrefix, registryUrl);
  const fail = (reason) => {
    throw new Error(`The release manifest does not describe this build: ${reason}`);
  };
  if (manifest.repository !== repository) fail(`repository ${manifest.repository}`);
  if (!SHA.test(manifest.sourceSha) || (sourceSha && manifest.sourceSha !== sourceSha))
    fail(`source ${manifest.sourceSha}`);
  if (!SUFFIX.test(manifest.suffix) || (runId && !manifest.suffix.startsWith(`-staging.${runId}.`)))
    fail(`suffix ${manifest.suffix}`);
  if (manifest.package !== names.primary) fail(`package ${manifest.package}`);
  if ((manifest.registry ?? GITHUB_PACKAGES) !== names.registryUrl) fail(`registry ${manifest.registry ?? GITHUB_PACKAGES}`);
  if (manifest.formatVersion === 3 && bumpProblem(manifest.bump)) fail(`bump ${bumpProblem(manifest.bump)}`);
  if (bump && JSON.stringify(manifest.bump) !== JSON.stringify(bump)) fail("bump, which is not the version this run computed");
  const seen = new Set();
  for (const pkg of manifest.packages) {
    if (!matchesPackage(pkg.name, names.selection) || seen.has(pkg.name))
      fail(`package ${pkg.name}`);
    seen.add(pkg.name);
    if (
      !STABLE.test(pkg.production.version) ||
      pkg.staging.version !== `${pkg.production.version}${manifest.suffix}` ||
      (manifest.bump && pkg.production.version !== manifest.bump.version)
    )
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
