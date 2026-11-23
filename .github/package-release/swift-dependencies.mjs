import semver from "semver";
import { exec, notFound, tagCommit } from "./package-release.mjs";

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const LITERAL = /"((?:[^"\\\n]|\\.)*)"/g;
const SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

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

/** Why a repository's releases cannot be read, or undefined when they can. */
function unreadable(run, repository) {
  try {
    run("gh", ["api", `repos/${repository}`]);
    return undefined;
  } catch (error) {
    if (notFound(error)) return `${repository} is not readable to check its releases; promote with private-deps`;
    throw error;
  }
}

/** A repository's release at releases/`which` on GitHub, or undefined when there is none. */
function readRelease(run, repository, which) {
  try {
    return JSON.parse(run("gh", ["api", `repos/${repository}/releases/${which}`]));
  } catch (error) {
    if (notFound(error)) return undefined;
    throw error;
  }
}

const isProduction = (release) => !release.draft && !release.prerelease;
const escapeRegExp = (text) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
const assetPattern = (glob) => new RegExp(`^${glob.split("*").map(escapeRegExp).join(".*")}$`);

/**
 * The production release of a version of one of the owner's repositories, or
 * why there is none: a published release under vX.Y.Z or X.Y.Z, not a draft or
 * prerelease, whose tag still names the resolved revision.
 */
function versionRelease(run, dependency, version, revision) {
  const problem = unreadable(run, dependency);
  if (problem) return { problem };
  for (const tag of [`v${version}`, version]) {
    const release = readRelease(run, dependency, `tags/${tag}`);
    if (!release) continue;
    if (!isProduction(release)) return { problem: `${dependency} ${tag} is a prerelease, not a production release` };
    if (revision && tagCommit(run, dependency, tag) !== revision) return { problem: `${dependency} ${tag} no longer names the resolved commit ${revision}` };
    return { release: tag };
  }
  return { problem: `${version} is not a published release of ${dependency}` };
}

/**
 * A repository's latest release, or why it has none to rely on: GitHub's
 * latest release is published and neither a draft nor a prerelease, and one of
 * its assets must match `asset`, where * matches any characters, when given.
 */
function latestRelease(run, repository, asset) {
  const problem = unreadable(run, repository);
  if (problem) return { problem };
  const release = readRelease(run, repository, "latest");
  if (!release || !isProduction(release)) return { problem: `${repository} has no production release; promote it first` };
  if (asset && !release.assets.some(({ name }) => assetPattern(asset).test(name))) return { problem: `${repository} ${release.tag_name} has no asset matching ${asset}` };
  return { release: release.tag_name };
}

/**
 * Findings that keep a build from production: a dependency on one of the
 * owner's repositories that is not a production release. A package is checked
 * by the pins of its committed Package.resolved, which its build resolved from
 * and could not change. A library, whose consumers resolve its requirements
 * themselves, and a package without Package.resolved are checked by the
 * requirements in Package.swift, whose lowest version must be released. A
 * payload with neither Package.resolved nor Package.swift has no SwiftPM
 * dependencies to check.
 */
function swiftPackageFindings({ repository, sourceSha, library, run, dependencyRun }) {
  const owner = repository.split("/")[0];
  const internal = new RegExp(`^(?:(?:https?|ssh|git)://(?:[^@/]+@)?github\\.com/|git@github\\.com:)${owner}/([A-Za-z0-9._-]+?)(?:\\.git)?/?$`, "i");
  const repositoryOf = (url) => {
    const name = internal.exec(url ?? "")?.[1];
    return name && `${owner}/${name}`;
  };
  const stable = (version) => VERSION.test(version) && !semver.prerelease(version);
  const findings = [];
  const dependencies = [];
  const check = (source, subject, dependency, version, revision) => {
    const { release, problem } = versionRelease(dependencyRun, dependency, version, revision);
    if (problem) findings.push(`${subject}: ${problem}`);
    else dependencies.push({ repository: dependency, release, source });
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
      else check("Package.resolved", subject, dependency, version, revision);
    }
    return { dependencies, findings };
  }
  const manifest = sourceFile(run, repository, sourceSha, "Package.swift");
  if (manifest === undefined) {
    if (library) throw new Error(`${sourceSha} has no Package.swift`);
    return { dependencies, findings };
  }
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
    else check("Package.swift", subject, dependency, versions[0]);
  }
  return { dependencies, findings };
}

/**
 * The repositories a build lists at `path` as required releases, one
 * owner/repository a line, optionally followed by an asset pattern; blank lines
 * and anything after # are ignored. Each needs a latest release to rely on.
 */
function requiredReleaseFindings({ repository, sourceSha, path, run, dependencyRun }) {
  const dependencies = [];
  const findings = [];
  const list = sourceFile(run, repository, sourceSha, path);
  if (list === undefined) return { dependencies, findings: [`${sourceSha} has no ${path} to read its required releases from`] };
  let entries = 0;
  for (const [index, line] of list.split("\n").entries()) {
    const fields = line.replace(/#.*/, "").trim().split(/\s+/).filter(Boolean);
    if (!fields.length) continue;
    entries++;
    const [required, asset, ...rest] = fields;
    if (!SLUG.test(required) || rest.length) {
      findings.push(`${path} line ${index + 1}: write owner/repository, optionally followed by an asset pattern`);
      continue;
    }
    const { release, problem } = latestRelease(dependencyRun, required, asset);
    if (problem) findings.push(`${path} requires ${required}: ${problem}`);
    else dependencies.push({ repository: required, release, source: path });
  }
  if (!entries) findings.push(`${path} names no repository; list the repositories the build requires, or stop setting required-releases`);
  return { dependencies, findings };
}

/**
 * Findings that keep a build from production, and the production release each
 * repository it depends on resolved to: the owner's repositories its SwiftPM
 * dependencies come from and, when `requiredReleases` names a list at the
 * source commit, the repositories listed there. Every finding is collected
 * before any is reported.
 */
export function dependencyFindings({ repository, sourceSha, library = false, requiredReleases = "", run = exec, dependencyRun = run }) {
  const swift = swiftPackageFindings({ repository, sourceSha, library, run, dependencyRun });
  if (!requiredReleases) return swift;
  const listed = requiredReleaseFindings({ repository, sourceSha, path: requiredReleases, run, dependencyRun });
  return { dependencies: [...swift.dependencies, ...listed.dependencies], findings: [...swift.findings, ...listed.findings] };
}
