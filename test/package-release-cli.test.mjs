import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../.github/package-release/package-release.mjs", import.meta.url));
const preload = fileURLToPath(new URL("./fixtures/package-release-cli-preload.mjs", import.meta.url));
const SHA = "a".repeat(40);
const PREVIOUS = "b".repeat(40);
const SUFFIX = "-staging.900.1";
let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "package-release-cli-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function command(args, fixture, eventName = "push", pullRequest) {
  const fixturePath = join(root, "fixture.json");
  const eventPath = join(root, "event.json");
  const output = join(root, "output");
  const log = join(root, "log");
  writeFileSync(fixturePath, JSON.stringify(fixture));
  if (pullRequest) writeFileSync(eventPath, JSON.stringify({ pull_request: pullRequest }));
  writeFileSync(output, "");
  const descriptor = openSync(log, "w");
  let result;
  try {
    result = spawnSync(process.execPath, ["--import", preload, cli, ...args], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        RELEASE_CLI_FIXTURE: fixturePath,
        GITHUB_EVENT_NAME: eventName,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: "photon-hq/adapter",
        GITHUB_SHA: SHA,
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_RUN_ID: "900",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: join(root, "summary"),
      },
      stdio: ["ignore", descriptor, descriptor],
      timeout: 10_000,
    });
  } finally {
    closeSync(descriptor);
  }
  assert.ifError(result.error);
  return { status: result.status, log: readFileSync(log, "utf8"), output: readFileSync(output, "utf8") };
}

function version({ eventName = "pull_request", title = "feat: add a field", body = "", path = "crate/src/field.rs" } = {}) {
  const result = command(["version", "--paths", "crate"], {
    commits: [
      { sha: SHA, subject: "Merge pull into main", paths: [path] },
      { sha: PREVIOUS, subject: "fix: order versions", paths: ["crate/src/lib.rs"] },
    ],
  }, eventName, { number: 8, title, body });
  assert.equal(result.status, 0, result.log);
  const bump = JSON.parse(result.output.split("\n").find((line) => line.startsWith("bump=")).slice(5));
  return { ...result, bump };
}

for (const { title, body, expected, level } of [
  { title: "feat: add a field", body: null, expected: "0.2.0", level: "minor" },
  { title: "fix: update fields", body: "BREAKING CHANGE: remove the old field", expected: "1.0.0", level: "major" },
  { title: "fix: update fields", body: "Release-As: 0.4.0", expected: "0.4.0", level: "patch" },
]) {
  test(`version CLI reads the pull request metadata for ${expected}`, () => {
    const { bump } = version({ title, body });
    assert.equal(bump.version, expected);
    assert.equal(bump.level, level);
    assert.deepEqual(bump.changes.at(-1), { number: 8, title, level });
  });
}

test("version CLI reads an edited pull request title again for the same commit", () => {
  assert.equal(version({ title: "fix: add a field" }).bump.version, "0.1.1");
  assert.equal(version({ title: "feat: add a field" }).bump.version, "0.2.0");
});

test("version CLI excludes the pending pull request when it does not touch the selected paths", () => {
  const { bump } = version({ path: "docs/field.md" });
  assert.equal(bump.version, "0.1.1");
  assert.equal(bump.level, "patch");
  assert.deepEqual(bump.changes.map(({ sha }) => sha), [PREVIOUS]);
});

for (const eventName of ["push", "workflow_dispatch"]) {
  test(`version CLI does not use pending pull request metadata on ${eventName}`, () => {
    const { bump } = version({ eventName });
    assert.equal(bump.version, "0.1.1");
    assert.equal(bump.level, "patch");
    assert.equal(bump.changes.at(-1).sha, SHA);
    assert.equal(bump.changes.at(-1).number, undefined);
  });
}

test("version CLI does not need an event file for a push", () => {
  const result = command(["version"], { commits: [{ sha: SHA, subject: "fix: update fields", paths: ["crate/src/lib.rs"] }] });
  assert.equal(result.status, 0, result.log);
  assert.match(result.output, /^version=0\.1\.1\n/);
});

function pack(directory, version) {
  const source = mkdtempSync(join(root, "package-"));
  mkdirSync(join(source, "package"));
  writeFileSync(join(source, "package/package.json"), JSON.stringify({ name: "adapter", version }));
  mkdirSync(directory, { recursive: true });
  execFileSync("tar", ["-czf", join(directory, `adapter-${version}.tgz`), "-C", source, "package"]);
}

function crate(directory, version, sourceSha, lib) {
  const source = mkdtempSync(join(root, "crate-"));
  const name = `adapter-${version}`;
  mkdirSync(join(source, name, "src"), { recursive: true });
  const manifest = `[package]\nname = "adapter"\nversion = "${version}"\nedition = "2024"\n`;
  writeFileSync(join(source, name, "Cargo.toml"), manifest);
  writeFileSync(join(source, name, "Cargo.toml.orig"), manifest);
  writeFileSync(join(source, name, ".cargo_vcs_info.json"), JSON.stringify({ git: { sha1: sourceSha }, path_in_vcs: "crate" }));
  writeFileSync(join(source, name, "src/lib.rs"), lib);
  mkdirSync(directory, { recursive: true });
  const file = `${name}.crate`;
  execFileSync("tar", ["-czf", join(directory, file), "-C", source, name]);
  return { name: "adapter", version, file, sha256: createHash("sha256").update(readFileSync(join(directory, file))).digest("hex") };
}

function collect({ crateVersion = "0.1.0", lib = "pub fn changed() {}", warning = false } = {}) {
  const staging = join(root, "staging");
  const production = join(root, "production");
  const crates = join(root, "crates");
  const released = join(root, "released");
  pack(staging, `0.2.0${SUFFIX}`);
  pack(production, "0.2.0");
  crate(crates, crateVersion, SHA, lib);
  const previous = crate(released, "0.1.0", PREVIOUS, "pub fn original() {}");
  writeFileSync(join(released, "release-manifest.json"), JSON.stringify({ formatVersion: 2, packages: [], crates: [previous] }));
  return command([
    "collect", "--staging", staging, "--production", production, "--crate-directory", crates,
    "--crates", "adapter", `--suffix=${SUFFIX}`, "--package", "adapter", "--registry", "https://registry.npmjs.org",
    "--output", join(root, "release"), "--bump", JSON.stringify({
      version: "0.2.0", from: "v0.1.0", level: "minor", total: 1,
      changes: [{ number: 8, title: "feat: add a field", level: "minor" }], warnings: [],
    }),
  ], {
    released,
    registry: {
      versions: warning ? { "0.2.0": { dist: { integrity: "different-contents" } } } : {},
      "dist-tags": { latest: "0.1.0" },
    },
  });
}

test("collect CLI prints package warnings before failing the crate version gate", () => {
  const result = collect({ warning: true });
  assert.equal(result.status, 1, result.log);
  assert.match(result.log, /::warning::adapter@0\.2\.0 cannot be promoted: it is released with other contents/);
  assert.match(result.log, /::error::This build cannot be staged:/);
  assert.match(result.log, /set its Cargo\.toml version to at least 0\.2\.0 and stage again/);
  assert.ok(result.log.indexOf("::warning::") < result.log.indexOf("::error::"));
  assert.equal(result.output, "");
});

test("collect CLI accepts a crate raised by the pull request's bump", () => {
  const result = collect({ crateVersion: "0.2.0" });
  assert.equal(result.status, 0, result.log);
  assert.match(result.output, /^staging-version=0\.2\.0-staging\.900\.1\nproduction-version=0\.2\.0\n$/);
});

test("collect CLI accepts unchanged crate contents at their existing version", () => {
  const result = collect({ lib: "pub fn original() {}" });
  assert.equal(result.status, 0, result.log);
});
