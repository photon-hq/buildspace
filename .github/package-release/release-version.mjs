import { execFileSync } from "node:child_process";
import semver from "semver";

const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[a-f0-9]{40}$/;
const HEADER = /^(?<type>[A-Za-z]+)(?:\([^()\r\n]*\))?(?<breaking>!)?: \S/;
const REVERT = /^Revert "/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE: /m;
const RELEASE_AS = /^Release-As:[ \t]*(\S*)[ \t]*$/gim;
const LEVELS = ["none", "patch", "minor", "major"];
const PAGE = 50;
const LISTED = 200;

const run = (command, args) =>
  execFileSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

/**
 * The release a change asks for, read from its Conventional Commits header and
 * footers: a breaking change is major, a feature minor, anything else a patch.
 * `Release-As: X.Y.Z` asks for at least that version.
 */
export function classify({ title, body = "" }) {
  const header = HEADER.exec(title);
  const breaking = Boolean(header?.groups.breaking) || BREAKING_FOOTER.test(body ?? "");
  return {
    level: breaking ? "major" : header?.groups.type.toLowerCase() === "feat" ? "minor" : "patch",
    conventional: Boolean(header) || REVERT.test(title),
    releaseAs: [...(body ?? "").matchAll(RELEASE_AS)].map(([, version]) => version.replace(/^v/, "")),
  };
}

const describe = (change) => (change.number ? `#${change.number}` : change.sha.slice(0, 12));

/**
 * The next version of a release line: its latest release raised by the largest
 * level among the changes since, and then to any higher Release-As. A line with
 * no release yet starts at 0.1.0; one with no change since its release keeps it.
 */
export function nextVersion(base, changes) {
  const level = changes.reduce((top, { level }) => (LEVELS.indexOf(level) > LEVELS.indexOf(top) ? level : top), "none");
  let version = !base ? "0.1.0" : level === "none" ? base : semver.inc(base, level);
  const warnings = [];
  for (const change of changes) {
    if (!change.conventional)
      warnings.push(`${describe(change)} "${change.title}" is not a Conventional Commit; it counts as a patch`);
    for (const requested of change.releaseAs) {
      if (!STABLE.test(requested)) warnings.push(`${describe(change)} asks for Release-As ${requested}, which is not X.Y.Z; ignored`);
      else if (base && !semver.gt(requested, base))
        warnings.push(`${describe(change)} asks for Release-As ${requested}, which is not newer than ${base}; ignored`);
      else if (semver.gt(requested, version)) version = requested;
    }
  }
  return { version, level, warnings };
}

/** The highest stable release tag under a prefix, such as v1.4.0 for `v`. */
export function latestReleaseTag(tags, prefix) {
  return tags
    .filter((tag) => tag.startsWith(prefix) && STABLE.test(tag.slice(prefix.length)))
    .sort((left, right) => semver.rcompare(left.slice(prefix.length), right.slice(prefix.length)))[0];
}

/**
 * The merged pull request behind each commit on the branch, looked up in pages
 * of commits. A squash or merge commit is the pull request's merge commit; a
 * rebased commit belongs to the pull request that merged it.
 */
export function mergedPullRequests({ repository, shas, branch, exec = run }) {
  const [owner, name] = repository.split("/");
  const found = new Map();
  for (let start = 0; start < shas.length; start += PAGE) {
    const page = shas.slice(start, start + PAGE);
    const fields = page.map((sha, index) => {
      if (!SHA.test(sha)) throw new Error(`Invalid commit ${sha}`);
      return `c${index}: object(oid: "${sha}") { ... on Commit { associatedPullRequests(first: 10) { nodes { number title body baseRefName mergedAt mergeCommit { oid } } } } }`;
    });
    const response = JSON.parse(
      exec("gh", [
        "api",
        "graphql",
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        "-f",
        `query=query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields.join(" ")} } }`,
      ])
    );
    page.forEach((sha, index) => {
      const merged = (response.data.repository[`c${index}`]?.associatedPullRequests.nodes ?? []).filter(
        (pull) => pull.mergedAt && pull.baseRefName === branch
      );
      const pull = merged.find((candidate) => candidate.mergeCommit?.oid === sha) ?? merged[0];
      if (pull) found.set(sha, pull);
    });
  }
  return found;
}

/**
 * The changes since a release line's latest release, oldest first: one per
 * merged pull request, read from its title and description, and one per commit
 * that reached the branch without one. Only first-parent commits that touch
 * `paths` count, so packages released separately from one repository, or
 * beside a service, are versioned by their own changes.
 */
export function releaseChanges({ repository, prefix, paths = [], head, branch = "main", directory = ".", exec = run }) {
  if (!SHA.test(head)) throw new Error("An exact source commit is required");
  const git = (...args) => exec("git", ["-C", directory, ...args]);
  const from = latestReleaseTag(git("tag", "--list", `${prefix}*`).split("\n").filter(Boolean), prefix);
  const commits = git("log", "--first-parent", "--format=%H%x00%s%x00%b%x1e", from ? `${from}..${head}` : head, "--", ...paths)
    .split("\x1e")
    .map((entry) => entry.replace(/^\n/, ""))
    .filter(Boolean)
    .map((entry) => {
      const [sha, subject, body] = entry.split("\0");
      return { sha, subject, body };
    })
    .reverse();
  const pulls = mergedPullRequests({ repository, shas: commits.map(({ sha }) => sha), branch, exec });
  const counted = new Set();
  const changes = [];
  for (const { sha, subject, body } of commits) {
    const pull = pulls.get(sha);
    if (!pull) {
      changes.push({ sha, title: subject, ...classify({ title: subject, body }) });
      continue;
    }
    if (counted.has(pull.number)) continue;
    counted.add(pull.number);
    changes.push({ number: pull.number, title: pull.title, ...classify(pull) });
  }
  return { from, base: from?.slice(prefix.length), changes };
}

/**
 * A build's version and the record of how it was reached, as the release
 * manifest and the release notes carry it. The newest changes are listed.
 */
export function releaseBump({ from, base, changes }) {
  const { version, level, warnings } = nextVersion(base, changes);
  return {
    version,
    from: from ?? null,
    level,
    total: changes.length,
    changes: changes.slice(-LISTED).map(({ number, sha, title, level }) => (number ? { number, title, level } : { sha, title, level })),
    warnings,
  };
}

/** A bump as Markdown lines: the version, what it follows, and each change with the release it asks for. */
export function bumpNotes(bump, repository) {
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const release = (tag) => `[\`${tag}\`](${server}/${repository}/releases/tag/${tag})`;
  const lines = [`### Version \`${bump.version}\``, ""];
  if (!bump.from) lines.push("The first release of this line.");
  else if (bump.level === "none") lines.push(`No change since ${release(bump.from)} counts toward a new version.`);
  else lines.push(`A ${bump.level} release after ${release(bump.from)}. The changes since, with the release each asks for:`);
  if (bump.changes.length) lines.push("");
  for (const change of bump.changes) {
    const link = change.number
      ? `[#${change.number}](${server}/${repository}/pull/${change.number})`
      : `[\`${change.sha.slice(0, 12)}\`](${server}/${repository}/commit/${change.sha})`;
    lines.push(`- **${change.level}** ${change.title} (${link})`);
  }
  if (bump.total > bump.changes.length) lines.push(`- …and ${bump.total - bump.changes.length} earlier`);
  for (const warning of bump.warnings) lines.push("", "> [!WARNING]", `> ${warning}`);
  return lines;
}
