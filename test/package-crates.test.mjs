import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { crateDependencyFindings, readArchive, readCrate, readManifest, workspaceManifest } from "../.github/package-release/package-release.mjs";
import { SHA, REPOSITORY, BUMP, root, setUp, tearDown, crate, packBoth, collectBoth, world, commands, publishWith, stagedWorld, resolveWith, asLegacy } from "./fixtures/package-release.mjs";

beforeEach(setUp);
afterEach(tearDown);

test("crates stay under vX.Y.Z tags", async () => {
  packBoth();
  crate(join(root, "crates"));
  await assert.rejects(
    collectBoth({ crates: ["adapter"], crateDirectory: join(root, "crates"), productionTagPrefix: "adapter-v" }),
    /cannot use another production tag prefix/
  );
});

test("archives are read by full path in GNU and ustar layouts", () => {
  const long = `${"nested/".repeat(16)}module.rs`;
  for (const format of ["gnu", "ustar"]) {
    const file = crate(join(root, format), { format });
    const source = mkdtempSync(join(root, "long-"));
    execFileSync("tar", ["-xzf", file, "-C", source]);
    mkdirSync(join(source, "adapter-0.4.0", long, ".."), { recursive: true });
    writeFileSync(join(source, "adapter-0.4.0", long), "mod deep;\n");
    execFileSync("tar", [`--format=${format}`, "-czf", file, "-C", source, "adapter-0.4.0"]);
    const files = readArchive(file);
    assert.equal(files.get(`adapter-0.4.0/${long}`).toString(), "mod deep;\n");
    assert.equal(files.get("adapter-0.4.0/src/lib.rs").toString(), "pub fn adapter() {}\n");
  }
});

test("a crate's digest ignores only the commit cargo recorded", () => {
  const read = (options) => readCrate(crate(mkdtempSync(join(root, "digest-")), options));
  const original = read();
  assert.equal(original.name, "adapter");
  assert.equal(original.version, "0.4.0");
  assert.equal(original.sourceSha, SHA);
  assert.equal(original.path, "crates/adapter");
  assert.equal(read({ sha: "b".repeat(40) }).digest, original.digest);
  assert.notEqual(read({ lib: "pub fn changed() {}\n" }).digest, original.digest);
});

test("collect lays out the crates packaged from the source commit", async () => {
  packBoth();
  crate(join(root, "crates"), { name: "adapter-macros", version: "0.2.0" });
  crate(join(root, "crates"));
  const manifest = await collectBoth({ crates: ["adapter", "adapter-macros"], crateDirectory: join(root, "crates") });
  assert.equal(manifest.formatVersion, 3);
  assert.deepEqual(manifest.crates.map(({ name, version, file }) => [name, version, file]), [
    ["adapter", "0.4.0", "adapter-0.4.0.crate"],
    ["adapter-macros", "0.2.0", "adapter-macros-0.2.0.crate"],
  ]);
  const bytes = readFileSync(join(root, "release/adapter-0.4.0.crate"));
  assert.equal(manifest.crates[0].sha256, createHash("sha256").update(bytes).digest("hex"));
});

test("collect refuses crates that do not belong to this build", async (t) => {
  const cases = {
    "packaged from another commit": [{ sha: "b".repeat(40) }, ["adapter"], /packaged from b{40}/],
    "packaged with uncommitted changes": [{ dirty: true }, ["adapter"], /uncommitted changes/],
    "prerelease version": [{ version: "0.4.0-rc.1" }, ["adapter"], /must be X\.Y\.Z/],
    "packaged under another directory": [{ root: "other-0.4.0" }, ["adapter"], /packaged under other-0\.4\.0/],
    "not in the crates input": [{}, ["adapter-macros"], /are not the crates input/],
  };
  for (const [name, [options, crates, error]] of Object.entries(cases))
    await t.test(name, async () => {
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root);
      packBoth();
      crate(join(root, "crates"), options);
      await assert.rejects(collectBoth({ crates, crateDirectory: join(root, "crates") }), error);
    });
  await t.test("missing from the packaged crates", async () => {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root);
    packBoth();
    mkdirSync(join(root, "crates"));
    await assert.rejects(collectBoth({ crates: ["adapter"], crateDirectory: join(root, "crates") }), /\(none\) are not/);
  });
});

test("a manifest from before crates reads as a build without any", async () => {
  const directory = mkdtempSync(join(root, "v1-"));
  writeFileSync(join(directory, "release-manifest.json"), JSON.stringify({ formatVersion: 1, packages: [] }));
  assert.deepEqual((await readManifest(directory)).crates, []);
  writeFileSync(join(directory, "release-manifest.json"), JSON.stringify({ formatVersion: 4, packages: [], crates: [] }));
  await assert.rejects(readManifest(directory), /Unsupported/);
});

test("staging attaches the crates and shows the dependency that pins the staging tag", async () => {
  const { manifest, fake } = await stagedWorld({ crates: [{}] });
  const release = fake.state.releases[manifest.stagingTag];
  assert.ok(release.assets.includes("adapter-0.4.0.crate"));
  assert.match(release.notes, /\| `adapter` \| `0\.4\.0` \|/);
  assert.ok(release.notes.includes(`adapter = { version = "=0.4.0", git = "https://github.com/photon-hq/adapter", tag = "${manifest.stagingTag}" }`));
});

test("the publishing job refuses crates the files and the crates input do not support", async (t) => {
  const forge = async (edit) => {
    packBoth();
    crate(join(root, "crates"));
    await collectBoth({ crates: ["adapter"], crateDirectory: join(root, "crates") });
    const path = join(root, "release/release-manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    edit(manifest);
    writeFileSync(path, JSON.stringify(manifest));
  };
  const cases = {
    "another version": [(m) => { m.crates[0].version = "0.5.0"; }, /file adapter-0\.4\.0\.crate/],
    "version that leaves the release": [(m) => { m.crates[0].version = "../../escape"; m.crates[0].file = "adapter-../../escape.crate"; }, /adapter version/],
    "file outside the release": [(m) => { m.crates[0].file = "../adapter-0.4.0.crate"; }, /file/],
    "crate dropped": [(m) => { m.crates = []; }, /crates none/],
    "tampered crate": [(m) => { m.crates[0].sha256 = "0".repeat(64); }, /does not match/],
  };
  for (const [name, [edit, error]] of Object.entries(cases))
    await t.test(name, async () => {
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root);
      await forge(edit);
      const fake = world();
      await assert.rejects(publishWith(fake, { crates: ["adapter"] }), error);
      assert.equal(fake.calls.length, 0);
    });
});

/** A production release made before this build, holding `crates` packaged from another commit. */
function releasedBefore(fake, crates) {
  const directory = mkdtempSync(join(root, "previous-"));
  const files = crates.map((options) => crate(directory, { sha: "c".repeat(40), ...options }));
  const manifest = join(directory, "release-manifest.json");
  writeFileSync(manifest, JSON.stringify({
    formatVersion: 2,
    packages: [],
    crates: files.map((file) => {
      const { name, version } = readCrate(file);
      return { name, version, file: `${name}-${version}.crate`, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") };
    }),
  }));
  fake.state.releases["v1.1.0"] = { prerelease: false, files: [...files, manifest], assets: [] };
  fake.state.tags["v1.1.0"] = "c".repeat(40);
  fake.registry = ((registry) => async (name) => {
    const metadata = await registry(name);
    if (name === "@photon-hq/adapter") metadata["dist-tags"].latest = "1.1.0";
    return metadata;
  })(fake.registry);
}

test("promotion verifies each crate and releases it under the production tag", async () => {
  const { manifest, fake } = await stagedWorld({ crates: [{}] });
  releasedBefore(fake, [{ version: "0.3.0" }]);
  const { manifest: resolved } = await resolveWith(fake);
  assert.deepEqual(resolved.crates, manifest.crates);
  const attested = commands(fake.calls, "gh", "attestation").map((call) => call[3].split("/").at(-1));
  assert.deepEqual(attested.sort(), ["adapter-0.4.0.crate", "photon-hq-adapter-1.2.0.tgz", "photon-hq-adapter-core-1.2.0.tgz"]);

  await publishWith(fake, { directory: join(root, "candidate"), channel: "production", sourceSha: undefined, runId: "901" });
  const release = fake.state.releases["v1.2.0"];
  assert.ok(release.assets.includes("adapter-0.4.0.crate"));
  assert.ok(release.notes.includes('adapter = { version = "=0.4.0", git = "https://github.com/photon-hq/adapter", tag = "v1.2.0" }'));
});

test("promotion keeps an unchanged crate's version and refuses reusing or lowering a changed one's", async (t) => {
  await t.test("unchanged", async () => {
    const { fake } = await stagedWorld({ crates: [{}] });
    releasedBefore(fake, [{}]);
    await resolveWith(fake);
  });
  await t.test("changed under the same version", async () => {
    const { fake } = await stagedWorld({ crates: [{}] });
    releasedBefore(fake, [{ lib: "pub fn before() {}\n" }]);
    await assert.rejects(resolveWith(fake), /adapter 0\.4\.0 is already released in v1\.1\.0 with other contents/);
  });
  await t.test("older than the release", async () => {
    const { fake } = await stagedWorld({ crates: [{}] });
    releasedBefore(fake, [{ version: "0.5.0" }]);
    await assert.rejects(resolveWith(fake), /adapter 0\.4\.0 is not newer than 0\.5\.0 in v1\.1\.0/);
  });
  await t.test("moved less than the build's level", async () => {
    const names = { bump: { ...BUMP, level: "major" } };
    const { fake } = await stagedWorld({ crates: [{}], names });
    releasedBefore(fake, [{ version: "0.3.0" }]);
    await assert.rejects(resolveWith(fake), /adapter 0\.4\.0 is below 1\.0\.0, which a major change since v1\.1\.0 requires; set its Cargo\.toml version to at least 1\.0\.0/);
  });
  await t.test("a build staged before versions were computed needs any newer version", async () => {
    const { fake } = await stagedWorld({ crates: [{}], names: { bump: { ...BUMP, level: "major" } } });
    asLegacy();
    releasedBefore(fake, [{ version: "0.3.9" }]);
    await resolveWith(fake);
  });
  await t.test("tampered release", async () => {
    const { fake } = await stagedWorld({ crates: [{}] });
    releasedBefore(fake, [{}]);
    writeFileSync(fake.state.releases["v1.1.0"].files[0], "tampered");
    await assert.rejects(resolveWith(fake), /v1\.1\.0: adapter-0\.4\.0\.crate does not match its release manifest/);
  });
});

test("crate dependency findings require released internal crates", async () => {
  const original = `
[package]
name = "adapter"
version = "0.4.0"
workspace = "../.."

[dependencies]
serde = "1"
photon-error = { version = "=0.1.0", git = "https://github.com/photon-hq/error", tag = "v0.3.0" }
vendored = { version = "0.1", git = "https://github.com/other/vendored", rev = "abc" }
sibling = { version = "0.2.0", path = "../sibling" }
contract = { workspace = true, features = ["serde"] }
events = { workspace = true }

[target.'cfg(unix)'.build-dependencies]
codegen = { git = "ssh://git@github.com/Photon-HQ/codegen", branch = "main" }

[dev-dependencies]
fixtures = { git = "https://github.com/photon-hq/fixtures", rev = "abc" }
`;
  const fake = world({
    contents: {
      "Cargo.toml": `
[workspace]
members = ["crates/*"]

[workspace.dependencies]
contract = { version = "=2.2.0", git = "https://github.com/photon-hq/auth-contract", tag = "error-staging-0.3.0-staging.1.1" }
events = { version = "0.2", git = "https://github.com/photon-hq/cloudevents-rs", tag = "v0.2.0" }
`,
    },
  });
  const contents = { name: "adapter", path: "crates/adapter", original };
  const workspace = workspaceManifest({ repository: REPOSITORY, sourceSha: SHA, crate: contents, run: fake.run });
  const findings = await crateDependencyFindings({ crate: contents, owner: "photon-hq", workspace });
  assert.deepEqual(findings, [
    "adapter dependencies: contract must pin a release tag vX.Y.Z of https://github.com/photon-hq/auth-contract, not tag error-staging-0.3.0-staging.1.1",
    "adapter dependencies: events must require an exact stable version (=X.Y.Z), not 0.2",
    "adapter build-dependencies: codegen must pin a release tag vX.Y.Z of ssh://git@github.com/Photon-HQ/codegen, not branch main",
    "adapter build-dependencies: codegen must require an exact stable version (=X.Y.Z), not any version",
  ]);
});

test("a crate's workspace is the nearest manifest above it with a workspace table", async () => {
  const fake = world({ contents: { "crates/Cargo.toml": "[package]\nname = \"other\"\n", "Cargo.toml": "[workspace]\nmembers = []\n" } });
  const contents = { name: "adapter", path: "crates/adapter/nested", original: "[package]\nname = \"adapter\"\n" };
  const workspace = await workspaceManifest({ repository: REPOSITORY, sourceSha: SHA, crate: contents, run: fake.run })();
  assert.equal(JSON.stringify(workspace.workspace), '{"members":[]}');
  const fetched = commands(fake.calls, "gh", "api").map((call) => call.at(-1).split("?")[0].split("/contents/")[1]);
  assert.deepEqual(fetched, ["crates/adapter/Cargo.toml", "crates/Cargo.toml", "Cargo.toml"]);
  const orphan = workspaceManifest({ repository: REPOSITORY, sourceSha: SHA, crate: { ...contents, path: "lonely" }, run: world().run });
  await assert.rejects(orphan(), /no workspace manifest is above lonely/);
});

test("promotion refuses a crate pinned to an unreleased internal dependency", async () => {
  const { fake } = await stagedWorld({
    crates: [{ original: '[package]\nname = "adapter"\nversion = "0.4.0"\n\n[dependencies]\nphoton-error = { version = "=0.1.0", git = "https://github.com/photon-hq/error", rev = "646e6b987fdba476dba9d10691f442d16706c34a" }\n' }],
  });
  await assert.rejects(resolveWith(fake), /adapter dependencies: photon-error must pin a release tag vX\.Y\.Z of https:\/\/github\.com\/photon-hq\/error, not rev 646e6b98/);
});
