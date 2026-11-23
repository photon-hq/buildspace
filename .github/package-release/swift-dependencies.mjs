import semver from "semver";
import { exec, notFound, tagCommit } from "./package-release.mjs";

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const LITERAL = /"((?:[^"\\\n]|\\.)*)"/g;

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
 * requirements in Package.swift, whose lowest version must be released. A
 * payload with neither Package.resolved nor Package.swift has no SwiftPM
 * dependencies to check.
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
    else check(subject, dependency, versions[0]);
  }
  return { dependencies, findings };
}
