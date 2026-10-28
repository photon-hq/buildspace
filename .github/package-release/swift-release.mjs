import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import semver from "semver";
import { bumpProblem, ensureRelease, ensureTag, exec, notFound, requireReviewers, sha256, tagCommit } from "./package-release.mjs";
import { bumpNotes, latestReleaseTag } from "./release-version.mjs";

const MANIFEST = "release-manifest.json";
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SUFFIX = /^-staging\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[a-f0-9]{40}$/;
const STAGING_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-staging\.(\d+)\.(\d+)$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const LITERAL = /"((?:[^"\\\n]|\\.)*)"/g;

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
  // Approval can come long after resolution; a newer release in between makes this build stale.
  if (channel === "production") {
    const latest = latestReleaseTag(releaseTags(run, repository), "v")?.slice(1);
    if (behind(manifest.bump.version, latest))
      throw new Error(`${manifest.stagingTag} cannot be released: ${manifest.bump.version} is not newer than the latest release ${latest}; stage a newer build`);
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
    notes: releaseNotes(manifest, channel),
  });
  return { manifest, tag };
}

/** Tags under `v`, read from GitHub; matching-refs returns every match in one response. */
function releaseTags(run, repository) {
  return JSON.parse(run("gh", ["api", `repos/${repository}/git/matching-refs/tags/v`])).map(({ ref }) => ref.slice("refs/tags/".length));
}

/** Whether a version can no longer follow the latest release; a version equal to it is left to the caller. */
const behind = (version, latest) => Boolean(latest) && latest !== version && !semver.gt(version, latest);

/** A file of the source commit, read from GitHub; undefined when the commit has none. */
function sourceFile(run, repository, sha, path) {
  try {
    return run("gh", ["api", "-H", "Accept: application/vnd.github.raw+json", `repos/${repository}/contents/${path}?ref=${sha}`]);
  } catch (error) {
    if (notFound(error)) return undefined;
    throw error;
  }
}

/** The index just past the string literal opening at `start`; a literal ends with its line at the latest. */
function stringEnd(text, start) {
  let end = start + 1;
  while (end < text.length && text[end] !== '"' && text[end] !== "\n") end += text[end] === "\\" ? 2 : 1;
  return end + 1;
}

/**
 * The argument lists of Package.swift's .package(...) declarations, read as
 * text with its comments dropped. Promotion never runs the manifest.
 */
export function packageDeclarations(source) {
  let code = "";
  for (let i = 0; i < source.length; ) {
    if (source[i] === '"') {
      const end = stringEnd(source, i);
      code += source.slice(i, end);
      i = end;
    } else if (source.startsWith("//", i)) {
      i = source.indexOf("\n", i) < 0 ? source.length : source.indexOf("\n", i);
    } else if (source.startsWith("/*", i)) {
      i = source.indexOf("*/", i + 2) < 0 ? source.length : source.indexOf("*/", i + 2) + 2;
      code += " ";
    } else code += source[i++];
  }
  const declarations = [];
  for (const match of code.matchAll(/\.package\s*\(/g)) {
    let depth = 1;
    let i = match.index + match[0].length;
    for (; i < code.length && depth; i++) {
      if (code[i] === '"') i = stringEnd(code, i) - 1;
      else if (code[i] === "(") depth++;
      else if (code[i] === ")") depth--;
    }
    declarations.push(code.slice(match.index + match[0].length, i - 1));
  }
  return declarations;
}

/**
 * Why a version of one of the owner's repositories is not production, or
 * undefined when it is: a published release under vX.Y.Z or X.Y.Z, not a draft
 * or prerelease, whose tag still names the resolved revision.
 */
function releaseProblem(run, dependency, version, revision) {
  try {
    run("gh", ["api", `repos/${dependency}`]);
  } catch (error) {
    if (notFound(error)) return `${dependency} is not readable to check its releases; promote with private-deps`;
    throw error;
  }
  for (const tag of [`v${version}`, version]) {
    let release;
    try {
      release = JSON.parse(run("gh", ["api", `repos/${dependency}/releases/tags/${tag}`]));
    } catch (error) {
      if (notFound(error)) continue;
      throw error;
    }
    if (release.draft || release.prerelease) return `${dependency} ${tag} is a prerelease, not a production release`;
    if (revision && tagCommit(run, dependency, tag) !== revision) return `${dependency} ${tag} no longer names the resolved commit ${revision}`;
    return undefined;
  }
  return `${version} is not a published release of ${dependency}`;
}

/**
 * Findings that keep a build from production: a dependency on one of the
 * owner's repositories that is not a production release. A package is checked
 * by the pins of its committed Package.resolved, which its build resolved from
 * and could not change. A library, whose consumers resolve its requirements
 * themselves, and a package without Package.resolved are checked by the
 * requirements in Package.swift, whose lowest version must be released.
 */
export function dependencyFindings({ repository, sourceSha, library = false, run = exec, dependencyRun = run }) {
  const owner = repository.split("/")[0];
  const internal = new RegExp(`^(?:(?:https?|ssh|git)://(?:[^@/]+@)?github\\.com/|git@github\\.com:)${owner}/([A-Za-z0-9._-]+?)(?:\\.git)?/?$`, "i");
  const repositoryOf = (url) => {
    const name = internal.exec(url ?? "")?.[1];
    return name && `${owner}/${name}`;
  };
  const stable = (version) => VERSION.test(version) && !semver.prerelease(version);
  const findings = [];
  const dependencies = [];
  const check = (subject, dependency, version, revision) => {
    const problem = releaseProblem(dependencyRun, dependency, version, revision);
    if (problem) findings.push(`${subject}: ${problem}`);
    else dependencies.push({ dependency, version });
  };
  const resolved = library ? undefined : sourceFile(run, repository, sourceSha, "Package.resolved");
  if (resolved !== undefined) {
    const file = JSON.parse(resolved);
    for (const pin of file.pins ?? file.object?.pins ?? []) {
      const dependency = repositoryOf(pin.location ?? pin.repositoryURL);
      if (!dependency) continue;
      const { branch, revision, version } = pin.state ?? {};
      const subject = `Package.resolved pins ${dependency}`;
      if (branch) findings.push(`${subject} to branch ${branch}; require a released version`);
      else if (!version) findings.push(`${subject} to revision ${revision}; require a released version`);
      else if (!stable(version)) findings.push(`${subject} at ${version}, which is not a stable version`);
      else check(subject, dependency, version, revision);
    }
    return { dependencies, findings };
  }
  const manifest = sourceFile(run, repository, sourceSha, "Package.swift");
  if (manifest === undefined) throw new Error(`${sourceSha} has no Package.swift`);
  for (const declaration of packageDeclarations(manifest)) {
    const url = /\burl\s*:\s*"((?:[^"\\\n]|\\.)*)"/.exec(declaration)?.[1];
    if (url === undefined) {
      if (/\burl\s*:/.test(declaration)) findings.push(`Package.swift: write the url of .package(${declaration.trim()}) as a string literal so promotion can check it`);
      continue;
    }
    const dependency = repositoryOf(url);
    if (!dependency) continue;
    const subject = `Package.swift requires ${dependency}`;
    const versions = [...declaration.matchAll(LITERAL)].map((match) => match[1]).filter((value) => VERSION.test(value));
    if (/\b(?:branch|revision)\s*:|\.(?:branch|revision)\s*\(/.test(declaration.replace(LITERAL, '""')))
      findings.push(`${subject} by branch or revision; require a released version`);
    else if (!versions.length) findings.push(`${subject} without a version literal promotion can check`);
    else if (!versions.every(stable)) findings.push(`${subject} at ${versions.join(" to ")}, which admits prerelease versions`);
    else check(subject, dependency, versions[0]);
  }
  return { dependencies, findings };
}

/**
 * Find the build to promote and prove where it came from: staged by the stage
 * workflow from a commit on main, unchanged since, newer than the latest
 * release, and depending only on the owner's production releases. `pending`
 * is false when that release already is this build.
 */
export async function resolveCandidate({ repository, packageName, library = false, version: requested = "", approvedBy = "", environment, signerWorkflow, output, run = exec, dependencyRun = run }) {
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
  const { dependencies, findings } = dependencyFindings({ repository, sourceSha: manifest.sourceSha, library, run, dependencyRun });
  if (findings.length)
    throw new Error(`${tag} cannot be promoted until its dependencies are production releases:\n${findings.map((finding) => `- ${finding}`).join("\n")}`);
  return { manifest, pending: true, dependencies };
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
      const { manifest, pending, dependencies } = await resolveCandidate({
        repository,
        packageName: values.package,
        library,
        version: values.version,
        approvedBy: values["approved-by"],
        environment: values.environment,
        signerWorkflow: values["signer-workflow"],
        output: resolve(values.output),
        dependencyRun: env.DEPENDENCY_TOKEN ? (command, args) => exec(command, args, { ...env, GH_TOKEN: env.DEPENDENCY_TOKEN }) : exec,
      });
      const released = dependencies.length
        ? ["Its internal dependencies are production releases:", "", "| Dependency | Version |", "| --- | --- |", ...dependencies.map(({ dependency, version }) => `| ${dependency} | \`${version}\` |`), ""]
        : [];
      await summarize(
        pending
          ? [`### Promote \`${manifest.stagingTag}\` to production`, "", releaseNotes(manifest, "production"), ...released, "Approve the deployment to release this exact build."].join("\n")
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
