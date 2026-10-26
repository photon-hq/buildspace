import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { collect, publish, readManifest, resolveCandidate } from "../.github/package-release/swift-release.mjs";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const SUFFIX = "-staging.900.1";
const REPOSITORY = "photon-hq/macrocosm-astrolabe";
const NAME = "macrocosm-astrolabe";
const SIGNER = "photon-hq/buildspace/.github/workflows/swift-stage.yml";
const BUMP = { version: "1.27.0", from: "v1.26.0", level: "minor", total: 1, changes: [{ number: 91, title: "feat: stage every main push", level: "minor" }], warnings: [] };
let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "swift-release-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** The two packages pkgbuild wrote: they differ only in the version they were built at. */
function packages() {
  for (const channel of ["staging", "production"]) {
    mkdirSync(join(root, "pack", channel), { recursive: true });
    writeFileSync(join(root, "pack", channel, `${NAME}.pkg`), `xar ${channel}`);
  }
}

const collectBuild = (overrides = {}) =>
  collect({
    stagingPackage: join(root, "pack/staging", `${NAME}.pkg`),
    productionPackage: join(root, "pack/production", `${NAME}.pkg`),
    packageName: NAME,
    bump: BUMP,
    suffix: SUFFIX,
    sourceSha: SHA,
    repository: REPOSITORY,
    output: join(root, "release"),
    runUrl: `https://github.com/${REPOSITORY}/actions/runs/900/attempts/1`,
    ...overrides,
  });

/** A fake GitHub that records every command. */
function world({ tags = {}, releases = {}, environment = ["octocat"], attested = true, onMain = true } = {}) {
  const calls = [];
  const state = { tags, releases };
  const fail = (message) => Object.assign(new Error(message), { stderr: message });
  const run = (command, args) => {
    calls.push([command, ...args]);
    const [first, second] = args;
    if (command === "gh" && first === "api") {
      const path = args.find((arg) => arg.startsWith("repos/"));
      if (path.endsWith("/environments/production")) {
        if (!environment) throw fail("gh: Not Found (HTTP 404)");
        return JSON.stringify({ protection_rules: environment.length ? [{ type: "required_reviewers", reviewers: environment }] : [] });
      }
      if (/\/git\/matching-refs\/tags\/v\?/.test(path))
        return JSON.stringify(Object.entries(state.tags).filter(([name]) => name.startsWith("v")).map(([name, sha]) => ({ ref: `refs/tags/${name}`, object: { type: "commit", sha } })));
      const tag = /\/git\/ref\/tags\/(.+)$/.exec(path)?.[1];
      if (tag) {
        if (!state.tags[tag]) throw fail("gh: Not Found (HTTP 404)");
        return JSON.stringify({ object: { type: "commit", sha: state.tags[tag] } });
      }
      if (path.endsWith("/git/refs")) {
        state.tags[args.find((arg) => arg.startsWith("ref=")).slice("ref=refs/tags/".length)] = args.find((arg) => arg.startsWith("sha=")).slice(4);
        return "";
      }
      if (/\/compare\/[a-f0-9]{40}\.\.\.main$/.test(path)) return JSON.stringify({ status: onMain ? "ahead" : "diverged" });
    }
    if (command === "gh" && first === "release") {
      const tag = args[2];
      const release = state.releases[tag];
      if (second === "view") {
        if (!release) throw fail("release not found");
        return JSON.stringify({ isPrerelease: release.prerelease, assets: release.assets.map((name) => ({ name })) });
      }
      if (second === "create") {
        const files = args.slice(3, args.indexOf("--repo"));
        state.releases[tag] = { prerelease: args.includes("--prerelease"), files, assets: files.map((file) => file.split("/").at(-1)), title: args[args.indexOf("--title") + 1], notes: readFileSync(args[args.indexOf("--notes-file") + 1], "utf8") };
        return "";
      }
      if (second === "download") {
        if (!release) throw fail("release not found");
        const pattern = args[args.indexOf("--pattern") + 1];
        const source = release.files.find((file) => file.endsWith(`/${pattern}`));
        if (!source) throw fail("no assets match the file pattern");
        writeFileSync(join(args[args.indexOf("--dir") + 1], pattern), readFileSync(source));
        return "";
      }
    }
    if (command === "gh" && first === "attestation") {
      if (!attested) throw fail("verification failed");
      return "";
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
  return { calls, state, run };
}

const commands = (calls, first) => calls.filter((call) => call[0] === "gh" && call[1] === first);
const publishWith = (fake, overrides = {}) =>
  publish({
    directory: join(root, "release"),
    channel: "staging",
    repository: REPOSITORY,
    sourceSha: SHA,
    packageName: NAME,
    runId: "900",
    ...(overrides.channel !== "production" && { bump: BUMP }),
    run: fake.run,
    ...overrides,
  });
const resolveWith = (fake, overrides = {}) =>
  resolveCandidate({
    repository: REPOSITORY,
    packageName: NAME,
    environment: "production",
    signerWorkflow: SIGNER,
    output: join(root, "candidate"),
    run: fake.run,
    ...overrides,
  });

/** A build staged by an earlier main push, as the stage workflow left it. */
async function staged(options = {}) {
  packages();
  const manifest = await collectBuild(options.collect);
  const fake = world({ tags: { "v1.26.0": OTHER, "v1.26.1-rc.3": OTHER }, ...options.world });
  await publishWith(fake, options.collect);
  fake.calls.length = 0;
  return { manifest, fake };
}

test("collect lays out the staging package and its production candidate at the computed version", async () => {
  packages();
  const manifest = await collectBuild();
  assert.equal(manifest.kind, "swift-package");
  assert.equal(manifest.stagingTag, `v1.27.0${SUFFIX}`);
  assert.equal(manifest.productionTag, "v1.27.0");
  assert.deepEqual(manifest.bump, BUMP);
  assert.deepEqual(manifest.pkg, {
    staging: { version: `1.27.0${SUFFIX}`, file: `${NAME}.pkg`, sha256: digest(join(root, "pack/staging", `${NAME}.pkg`)) },
    production: { version: "1.27.0", file: `${NAME}-1.27.0.pkg.candidate`, sha256: digest(join(root, "pack/production", `${NAME}.pkg`)) },
  });
  assert.deepEqual(await readManifest(join(root, "release")), manifest);
  for (const [name, overrides, error] of [
    ["package name", { packageName: "../escape" }, /Invalid package name/],
    ["suffix", { suffix: "-rc.1" }, /Invalid staging suffix/],
    ["source", { sourceSha: "main" }, /exact source commit/],
    ["version", { bump: { ...BUMP, version: "1.27" } }, /Invalid release version/],
  ])
    await assert.rejects(collectBuild(overrides), error, name);
});

test("staging publishes one .pkg, the staging build, beside its candidate", async () => {
  packages();
  await collectBuild();
  const fake = world();
  const { tag } = await publishWith(fake);
  assert.equal(tag, `v1.27.0${SUFFIX}`);
  assert.equal(fake.state.tags[tag], SHA);
  const release = fake.state.releases[tag];
  assert.equal(release.prerelease, true);
  assert.equal(release.title, `${NAME} v1.27.0${SUFFIX}`);
  assert.deepEqual(release.assets.sort(), [`${NAME}-1.27.0.pkg.candidate`, `${NAME}.pkg`, "release-manifest.json"]);
  assert.deepEqual(release.assets.filter((asset) => asset.endsWith(".pkg")), [`${NAME}.pkg`]);
  assert.match(release.notes, /Staging Macs install it/);
  assert.ok(release.notes.includes(`staging-version: 1.27.0${SUFFIX}`));
  assert.ok(release.notes.includes("- **minor** feat: stage every main push ([#91]"));
  const create = commands(fake.calls, "release").find((call) => call[2] === "create");
  assert.ok(create.includes("--prerelease") && create.includes("--latest=false"));
});

test("the publishing job trusts no manifest claim the files and run do not support", async (t) => {
  const forge = async (edit) => {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root);
    packages();
    await collectBuild();
    const path = join(root, "release/release-manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    edit(manifest);
    writeFileSync(path, JSON.stringify(manifest));
  };
  const cases = {
    "another version": [(m) => { m.bump.version = "2.0.0"; }, /bump, which is not the version this run computed/],
    "another staging tag": [(m) => { m.stagingTag = "v9.9.9"; }, /release tags/],
    "another source commit": [(m) => { m.sourceSha = OTHER; }, /source/],
    "another run's suffix": [(m) => { m.suffix = "-staging.1.1"; }, /suffix/],
    "another package": [(m) => { m.package = "other"; }, /package other/],
    "candidate under a .pkg name": [(m) => { m.pkg.production.file = `${NAME}.pkg`; }, /production package/],
    "a library's kind": [(m) => { m.kind = "swift-library"; }, /kind swift-library/],
    "tampered candidate": [(m) => { m.pkg.production.sha256 = "0".repeat(64); }, /does not match the release manifest/],
  };
  for (const [name, [edit, error]] of Object.entries(cases))
    await t.test(name, async () => {
      await forge(edit);
      const fake = world();
      await assert.rejects(publishWith(fake), error);
      assert.equal(fake.calls.length, 0);
    });
});

test("promotion releases the newest staging build's own candidate after proving where it came from", async () => {
  const { manifest, fake } = await staged({ world: { tags: { "v1.26.0": OTHER, "v1.27.0-staging.850.2": OTHER } } });
  const { manifest: resolved, pending } = await resolveWith(fake);
  assert.deepEqual(resolved, manifest);
  assert.equal(pending, true);
  const [attestation] = commands(fake.calls, "attestation");
  assert.equal(attestation[3], join(root, "candidate", `${NAME}-1.27.0.pkg.candidate`));
  for (const [flag, value] of [["--repo", REPOSITORY], ["--signer-workflow", SIGNER], ["--source-digest", SHA], ["--source-ref", "refs/heads/main"]])
    assert.equal(attestation[attestation.indexOf(flag) + 1], value);
  assert.equal(digest(join(root, "candidate", `${NAME}.pkg`)), manifest.pkg.production.sha256);

  await publishWith(fake, { directory: join(root, "candidate"), channel: "production", sourceSha: undefined });
  assert.equal(fake.state.tags["v1.27.0"], SHA);
  const release = fake.state.releases["v1.27.0"];
  assert.equal(release.prerelease, false);
  assert.equal(release.title, `${NAME} v1.27.0`);
  assert.deepEqual(release.assets.sort(), [`${NAME}.pkg`, "release-manifest.json"]);
  assert.equal(digest(release.files.find((file) => file.endsWith(`/${NAME}.pkg`))), manifest.pkg.production.sha256);
  assert.ok(release.notes.startsWith(`Promoted from [\`v1.27.0${SUFFIX}\`]`));
  assert.equal(commands(fake.calls, "release").find((call) => call[2] === "create").includes("--prerelease"), false);
  assert.equal((await resolveWith(fake)).pending, false);
});

test("promotion takes an explicit staging version", async () => {
  const { fake } = await staged();
  assert.equal((await resolveWith(fake, { version: `1.27.0${SUFFIX}` })).manifest.stagingTag, `v1.27.0${SUFFIX}`);
  await assert.rejects(resolveWith(fake, { version: "1.26.1-rc.3" }), /has no promotion candidate/);
});

test("promotion refuses a build it cannot vouch for", async (t) => {
  await t.test("environment without reviewers", async () => {
    const { fake } = await staged({ world: { environment: [] } });
    await assert.rejects(resolveWith(fake), /must exist and require a reviewer/);
    assert.deepEqual(fake.calls.map((call) => call[1]), ["api"]);
  });
  await t.test("no staging build", async () => {
    await assert.rejects(resolveWith(world({ tags: { "v1.26.0": OTHER } })), /has no staging build/);
  });
  await t.test("tag moved", async () => {
    const { manifest, fake } = await staged();
    fake.state.tags[manifest.stagingTag] = OTHER;
    await assert.rejects(resolveWith(fake), /no longer names the commit/);
  });
  await t.test("not on main", async () => {
    const { fake } = await staged({ world: { onMain: false } });
    await assert.rejects(resolveWith(fake), /not in the history of main/);
  });
  await t.test("missing attestation", async () => {
    const { fake } = await staged({ world: { attested: false } });
    await assert.rejects(resolveWith(fake), /verification failed/);
  });
  await t.test("tampered candidate", async () => {
    const { manifest, fake } = await staged();
    writeFileSync(fake.state.releases[manifest.stagingTag].files.find((file) => file.endsWith(".pkg.candidate")), "tampered");
    await assert.rejects(resolveWith(fake), /does not match the release manifest/);
  });
  await t.test("not newer than the latest release", async () => {
    const { fake } = await staged({ world: { tags: { "v1.28.0": OTHER } } });
    await assert.rejects(resolveWith(fake), /1\.27\.0 is not newer than the latest release 1\.28\.0/);
  });
  await t.test("its version released from another commit", async () => {
    const { fake } = await staged({ world: { tags: { "v1.27.0": OTHER } } });
    await assert.rejects(resolveWith(fake), /v1\.27\.0 is already released from another commit/);
  });
});

test("a library is staged and promoted by its tags alone", async () => {
  const library = { library: true };
  const manifest = await collectBuild({ ...library, stagingPackage: undefined, productionPackage: undefined });
  assert.equal(manifest.kind, "swift-library");
  assert.equal(manifest.pkg, null);
  const fake = world({ tags: { "v1.26.0": OTHER } });
  await publishWith(fake, library);
  const staging = fake.state.releases[`v1.27.0${SUFFIX}`];
  assert.deepEqual(staging.assets, ["release-manifest.json"]);
  assert.ok(staging.notes.includes(`.exact("1.27.0${SUFFIX}")`));
  fake.calls.length = 0;
  const { pending } = await resolveWith(fake, library);
  assert.equal(pending, true);
  assert.equal(commands(fake.calls, "attestation").length, 0);
  await publishWith(fake, { ...library, directory: join(root, "candidate"), channel: "production", sourceSha: undefined });
  assert.equal(fake.state.tags["v1.27.0"], SHA);
  assert.deepEqual(fake.state.releases["v1.27.0"].assets, ["release-manifest.json"]);
  await assert.rejects(resolveWith(fake), /kind swift-library/);
});
