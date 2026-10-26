import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  bumpNotes,
  classify,
  latestReleaseTag,
  nextVersion,
  releaseBump,
  releaseChanges,
} from "../.github/package-release/release-version.mjs";

const REPOSITORY = "photon-hq/adapter";
let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "release-version-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const change = (title, body = "", number = 1) => ({ number, title, ...classify({ title, body }) });

test("a change's Conventional Commits type decides the release it asks for", () => {
  for (const [title, level] of [
    ["fix: retry", "patch"],
    ["feat: retry", "minor"],
    ["feat(api): retry (ENG-1)", "minor"],
    ["FEAT: retry", "minor"],
    ["feat!: drop retry", "major"],
    ["fix(api)!: drop retry", "major"],
    ["docs: explain retry", "patch"],
    ["chore(deps): bump semver", "patch"],
    ['Revert "feat: retry"', "patch"],
  ])
    assert.deepEqual([title, classify({ title }).level, classify({ title }).conventional], [title, level, true]);
  assert.deepEqual(classify({ title: "Add retry (#16)" }), { level: "patch", conventional: false, releaseAs: [] });
  assert.deepEqual(classify({ title: "feature: retry" }).level, "patch");
  assert.equal(classify({ title: "chore: rework", body: "Rework.\n\nBREAKING CHANGE: the retry option is gone" }).level, "major");
  assert.equal(classify({ title: "chore: rework", body: "BREAKING-CHANGE: gone" }).level, "major");
  assert.equal(classify({ title: "chore: rework", body: "Mentions a BREAKING CHANGE: inline" }).level, "patch");
  assert.equal(classify({ title: "fix: retry", body: null }).level, "patch");
});

test("Release-As lines in a description ask for a version", () => {
  assert.deepEqual(classify({ title: "chore: prepare 2.0", body: "Notes.\n\nRelease-As: 2.0.0\n" }).releaseAs, ["2.0.0"]);
  assert.deepEqual(classify({ title: "chore: x", body: "release-as: v3.1.0\r\nRelease-As:  4.0.0  " }).releaseAs, ["3.1.0", "4.0.0"]);
  assert.deepEqual(classify({ title: "chore: x", body: "We could Release-As: 2.0.0 later" }).releaseAs, []);
});

test("the largest change since the latest release decides the next version", () => {
  const base = "1.26.0";
  assert.equal(nextVersion(base, [change("fix: a")]).version, "1.26.1");
  assert.equal(nextVersion(base, [change("fix: a"), change("fix: b")]).version, "1.26.1");
  assert.equal(nextVersion(base, [change("fix: a"), change("feat: b"), change("docs: c")]).version, "1.27.0");
  assert.deepEqual(nextVersion(base, [change("feat!: a"), change("feat: b")]), { version: "2.0.0", level: "major", warnings: [] });
  assert.deepEqual(nextVersion(base, []), { version: "1.26.0", level: "none", warnings: [] });
  assert.equal(nextVersion("0.9.3", [change("fix!: a")]).version, "1.0.0");
  assert.equal(nextVersion("0.9.3", [change("feat: a")]).version, "0.10.0");
});

test("a line without a release starts at 0.1.0", () => {
  assert.equal(nextVersion(undefined, []).version, "0.1.0");
  assert.equal(nextVersion(undefined, [change("feat!: a")]).version, "0.1.0");
  assert.equal(nextVersion(undefined, [change("chore: adopt", "Release-As: 2.0.3")]).version, "2.0.3");
});

test("Release-As raises the version but never lowers it", () => {
  const base = "1.26.0";
  assert.equal(nextVersion(base, [change("chore: prepare", "Release-As: 2.0.0", 1), change("feat: b", "", 2)]).version, "2.0.0");
  assert.equal(nextVersion(base, [change("chore: prepare", "Release-As: 1.26.5", 1), change("feat: b", "", 2)]).version, "1.27.0");
  const ignored = nextVersion(base, [change("fix: a", "Release-As: 1.20.0", 3), change("fix: b", "Release-As: 2.0", 4)]);
  assert.equal(ignored.version, "1.26.1");
  assert.deepEqual(ignored.warnings, [
    "#3 asks for Release-As 1.20.0, which is not newer than 1.26.0; ignored",
    "#4 asks for Release-As 2.0, which is not X.Y.Z; ignored",
  ]);
});

test("a change that is not a Conventional Commit counts as a patch, with a warning", () => {
  const { version, warnings } = nextVersion("1.0.0", [{ sha: "f".repeat(40), title: "Add retry", ...classify({ title: "Add retry" }) }]);
  assert.equal(version, "1.0.1");
  assert.deepEqual(warnings, ['ffffffffffff "Add retry" is not a Conventional Commit; it counts as a patch']);
});

test("the latest release is the highest stable tag under the line's prefix", () => {
  const tags = ["v1.9.0", "v1.10.0", "v2.0.0-rc.1", "adapter-v9.0.0", "adapter-staging-3.0.0-staging.1.1", "v1.10", "vv1.0.0"];
  assert.equal(latestReleaseTag(tags, "v"), "v1.10.0");
  assert.equal(latestReleaseTag(tags, "adapter-v"), "adapter-v9.0.0");
  assert.equal(latestReleaseTag(tags, "core-v"), undefined);
});

/** A repository whose main branch landed pull requests by squash, merge and rebase, and one direct push. */
function history() {
  const directory = join(root, "repository");
  mkdirSync(directory);
  const git = (...args) => execFileSync("git", ["-C", directory, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { encoding: "utf8" }).trim();
  const commit = (path, message) => {
    mkdirSync(join(directory, path, ".."), { recursive: true });
    writeFileSync(join(directory, path), `${message}\n`);
    git("add", ".");
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  commit("pkg/index.js", "feat: start");
  git("tag", "v1.0.0");
  const commits = {};
  commits.squash = commit("pkg/index.js", "feat: add retry (#2)");
  git("checkout", "-qb", "service");
  commit("service/main.js", "work on the service");
  git("checkout", "-q", "main");
  git("merge", "-q", "--no-ff", "service", "-m", "Merge pull request #3 from photon-hq/service");
  commits.merge = git("rev-parse", "HEAD");
  commits.direct = commit("pkg/util.js", "fix: patch directly");
  commits.rebased = [commit("pkg/a.js", "wip one"), commit("pkg/b.js", "wip two")];
  return { directory, commits };
}

/** GitHub's answer for the commits a query names: `pulls` maps a commit to its pull requests. */
function github(pulls, queries = []) {
  return (command, args) => {
    if (command === "git") return execFileSync("git", args, { encoding: "utf8" });
    assert.deepEqual(args.slice(0, 2), ["api", "graphql"]);
    const query = args.find((arg) => arg.startsWith("query="));
    queries.push(query);
    const repository = {};
    for (const [, index, oid] of query.matchAll(/c(\d+): object\(oid: "([a-f0-9]{40})"\)/g))
      repository[`c${index}`] = { associatedPullRequests: { nodes: pulls[oid] ?? [] } };
    return JSON.stringify({ data: { repository } });
  };
}

const merged = (number, title, mergeCommit, body = "", baseRefName = "main") => ({
  number,
  title,
  body,
  baseRefName,
  mergedAt: "2026-10-26T00:00:00Z",
  mergeCommit: { oid: mergeCommit },
});

test("changes since the release are read from the pull requests that merged them", () => {
  const { directory, commits } = history();
  const pulls = {
    [commits.squash]: [merged(2, "feat: add retry", commits.squash, "Release-As: 1.5.0")],
    [commits.merge]: [merged(3, "feat!: rewrite the service", commits.merge)],
    [commits.rebased[0]]: [merged(4, "fix: tidy", commits.rebased[1])],
    [commits.rebased[1]]: [merged(4, "fix: tidy", commits.rebased[1])],
    [commits.direct]: [{ ...merged(9, "feat: elsewhere", commits.direct), baseRefName: "release" }, { ...merged(10, "feat: open", commits.direct), mergedAt: null }],
  };
  const all = releaseChanges({ repository: REPOSITORY, prefix: "v", head: commits.rebased[1], directory, exec: github(pulls) });
  assert.equal(all.from, "v1.0.0");
  assert.equal(all.base, "1.0.0");
  assert.deepEqual(all.changes.map(({ number, sha, title, level }) => [number ?? sha, title, level]), [
    [2, "feat: add retry", "minor"],
    [3, "feat!: rewrite the service", "major"],
    [commits.direct, "fix: patch directly", "patch"],
    [4, "fix: tidy", "patch"],
  ]);
  assert.deepEqual(all.changes[0].releaseAs, ["1.5.0"]);
  assert.equal(releaseBump(all).version, "2.0.0");

  const pkg = releaseChanges({ repository: REPOSITORY, prefix: "v", paths: ["pkg"], head: commits.rebased[1], directory, exec: github(pulls) });
  assert.deepEqual(pkg.changes.map(({ number, sha }) => number ?? sha), [2, commits.direct, 4]);
  assert.equal(releaseBump(pkg).version, "1.5.0");

  const service = releaseChanges({ repository: REPOSITORY, prefix: "v", paths: ["service"], head: commits.squash, directory, exec: github(pulls) });
  assert.deepEqual(service.changes, []);
  assert.equal(releaseBump(service).version, "1.0.0");
});

test("a line without a release reads its whole history, and commits are looked up in pages", () => {
  const { directory } = history();
  const git = (...args) => execFileSync("git", ["-C", directory, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { encoding: "utf8" }).trim();
  for (let index = 0; index < 60; index++) git("commit", "-q", "--allow-empty", "-m", `chore: empty ${index}`);
  const head = git("rev-parse", "HEAD");
  const queries = [];
  const { from, changes } = releaseChanges({ repository: REPOSITORY, prefix: "core-v", head, directory, exec: github({}, queries) });
  assert.equal(from, undefined);
  // Six first-parent commits of history() and the 60 empty ones; the merged branch's own commit is not one.
  assert.equal(changes.length, 66);
  assert.equal(changes[0].title, "feat: start");
  assert.equal(queries.length, 2);
  assert.equal(releaseBump({ from, changes }).version, "0.1.0");
  assert.throws(() => releaseChanges({ repository: REPOSITORY, prefix: "v", head: "main", directory, exec: github({}) }), /exact source commit/);
});

test("a bump lists the newest changes and how the version was reached", () => {
  const changes = Array.from({ length: 205 }, (_, index) => change(`fix: ${index}`, "", index + 1));
  const bump = releaseBump({ from: "v1.0.0", base: "1.0.0", changes });
  assert.equal(bump.version, "1.0.1");
  assert.equal(bump.total, 205);
  assert.equal(bump.changes.length, 200);
  assert.deepEqual(bump.changes[0], { number: 6, title: "fix: 5", level: "patch" });
  const notes = bumpNotes(bump, REPOSITORY).join("\n");
  assert.ok(notes.startsWith("### Version `1.0.1`\n\nA patch release after [`v1.0.0`](https://github.com/photon-hq/adapter/releases/tag/v1.0.0)."));
  assert.ok(notes.includes("- **patch** fix: 204 ([#205](https://github.com/photon-hq/adapter/pull/205))"));
  assert.ok(notes.endsWith("- …and 5 earlier"));
});

test("a bump's notes name a first release, an unchanged line, and every warning", () => {
  const first = bumpNotes(releaseBump({ changes: [] }), REPOSITORY);
  assert.deepEqual(first, ["### Version `0.1.0`", "", "The first release of this line."]);
  const unchanged = bumpNotes(releaseBump({ from: "v1.0.0", base: "1.0.0", changes: [] }), REPOSITORY);
  assert.equal(unchanged[2], "No change since [`v1.0.0`](https://github.com/photon-hq/adapter/releases/tag/v1.0.0) counts toward a new version.");
  const sha = "f".repeat(40);
  const warned = bumpNotes(releaseBump({ from: "v1.0.0", base: "1.0.0", changes: [{ sha, title: "Add retry", ...classify({ title: "Add retry" }) }] }), REPOSITORY);
  assert.deepEqual(warned.slice(-4), [
    `- **patch** Add retry ([\`ffffffffffff\`](https://github.com/photon-hq/adapter/commit/${sha}))`,
    "",
    "> [!WARNING]",
    '> ffffffffffff "Add retry" is not a Conventional Commit; it counts as a patch',
  ]);
});
