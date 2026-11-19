import assert from "node:assert/strict";
import { basename, join } from "node:path";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { dependencyFindings, integrity, registryMetadata, sha256 } from "../.github/package-release/package-release.mjs";
import { BUMP, SUFFIX, collectBoth, commands, pack, publishWith, root, setUp, tearDown, world } from "./fixtures/package-release.mjs";

beforeEach(setUp);
afterEach(tearDown);

const base = "@photon-hq/z-base";
const a = "@photon-hq/b-plugin";
const b = "@photon-hq/c-plugin";
const umbrella = "@photon-hq/adapter";

function packGraph(stagingOverride = {}, suffix = SUFFIX) {
  for (const [channel, version] of [["production", BUMP.version], ["staging", BUMP.version + suffix]]) {
    const graph = {
      [umbrella]: { dependencies: { [a]: version, external: "^1" }, optionalDependencies: { [b]: version } },
      [a]: { peerDependencies: { [base]: version } },
      [b]: { optionalDependencies: { [base]: version } },
      [base]: { devDependencies: { [umbrella]: "workspace:*" } },
      ...(channel === "staging" ? stagingOverride : {}),
    };
    for (const [name, fields] of Object.entries(graph)) pack(join(root, channel), { name, version, ...fields });
  }
}

test("a failed production wave drains its siblings without releasing, then resumes from verified bytes", async () => {
  packGraph();
  const manifest = await collectBoth();
  const files = new Map(manifest.packages.map((pkg) => [pkg.production.file, pkg.name]));
  const fake = world({ parking: { [a]: { "candidate-112-1": BUMP.version, "candidate-901-2": "1.0.0" } } });
  const started = [];
  const afterFailure = Promise.withResolvers();
  const releaseSibling = Promise.withResolvers();
  let finished = false;
  const options = { channel: "production", runId: "901" };
  const attempt = publishWith(fake, {
    ...options,
    runPublish: async (args) => {
      const name = files.get(basename(args[1]));
      started.push(name);
      if (name === b) {
        afterFailure.resolve();
        throw new Error("no acknowledgement");
      }
      if (name === a) await releaseSibling.promise;
      fake.run("npm", args);
    },
  }).finally(() => { finished = true; });
  const rejected = assert.rejects(attempt, /c-plugin: no acknowledgement/);
  await afterFailure.promise;
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(started, [base, a, b]);
  assert.equal(finished, false);
  releaseSibling.resolve();
  await rejected;
  assert.deepEqual(fake.state.tags, {});
  assert.deepEqual(fake.state.releases, {});
  assert.deepEqual(commands(fake.calls, "npm", "dist-tag"), []);
  assert.deepEqual(Object.keys(fake.state.published).sort(), [a, base].sort().map((name) => `${name}@${BUMP.version}`));

  fake.calls.length = 0;
  await publishWith(fake, { ...options, runAttempt: "3" });
  assert.deepEqual(commands(fake.calls, "npm", "publish").map((call) => files.get(basename(call[2]))), [b, umbrella]);
  assert.deepEqual(commands(fake.calls, "npm", "dist-tag").filter((call) => call[2] === "add").map((call) => call[3]),
    [base, a, b, umbrella].map((name) => `${name}@${BUMP.version}`));
  assert.equal(fake.state.releases[manifest.productionTag].prerelease, false);
  assert.deepEqual(fake.state.parking[a], { "candidate-112-1": BUMP.version, "candidate-901-2": "1.0.0" });
  for (const name of [base, b, umbrella]) assert.deepEqual(fake.state.parking[name], {});
});

test("no dependent starts while a sibling is waiting for registry integrity", async () => {
  packGraph();
  const { packages } = await collectBoth();
  const fake = world();
  const seen = Promise.withResolvers();
  const visible = Promise.withResolvers();
  const version = BUMP.version + SUFFIX;
  let wait = true;
  const attempt = publishWith(fake, {
    registry: async (name) => {
      const metadata = await fake.registry(name);
      if (name === b && metadata.versions[version] && wait) delete metadata.versions[version];
      return metadata;
    },
    sleep: async () => {
      seen.resolve();
      await visible.promise;
    },
  });
  await seen.promise;
  assert.deepEqual(Object.keys(fake.state.published).sort(), [base, a, b].map((name) => `${name}@${version}`).sort());
  assert.deepEqual(fake.state.tags, {});
  wait = false;
  visible.resolve();
  await attempt;
  for (const pkg of packages) assert.equal(fake.state.published[`${pkg.name}@${version}`], pkg.staging.integrity);
});

test("retrying a failed stage job reuses the stored version; rebuilding stages a new attempt", async () => {
  packGraph();
  const { packages } = await collectBoth();
  const fake = world();
  const byFile = new Map(packages.map((pkg) => [pkg.staging.file, pkg.name]));
  await assert.rejects(publishWith(fake, { runPublish: (args) => {
    if (byFile.get(basename(args[1])) === b) throw new Error("unavailable");
    fake.run("npm", args);
  } }), /unavailable/);
  fake.calls.length = 0;
  await publishWith(fake, { runAttempt: "2" });
  assert.deepEqual(commands(fake.calls, "npm", "publish").map((call) => byFile.get(basename(call[2]))), [b, umbrella]);
  for (const { name } of packages) {
    assert.equal((await fake.registry(name))["dist-tags"].staging, BUMP.version + SUFFIX);
    assert.deepEqual(fake.state.parking[name], {});
  }

  for (const dir of ["staging", "production", "release"]) rmSync(join(root, dir), { recursive: true });
  const suffix = "-staging.900.3";
  packGraph({}, suffix);
  const rebuilt = await collectBoth({ suffix });
  fake.calls.length = 0;
  await publishWith(fake, { runAttempt: "3" });
  assert.equal(commands(fake.calls, "npm", "publish").length, packages.length);
  for (const { name, staging } of rebuilt.packages)
    assert.equal((await fake.registry(name))["dist-tags"].staging, staging.version);
});

test("a corrupt registry response after publication blocks the next wave and every release tag", async () => {
  packGraph();
  await collectBoth();
  const fake = world();
  const version = BUMP.version + SUFFIX;
  await assert.rejects(publishWith(fake, { registry: async (name) => {
    const metadata = await fake.registry(name);
    if (name === b && metadata.versions[version]) metadata.versions[version].dist.integrity = "wrong";
    return metadata;
  } }), /published with different contents/);
  assert.equal(fake.state.published[`${umbrella}@${version}`], undefined);
  assert.deepEqual(fake.state.tags, {});
  assert.deepEqual(commands(fake.calls, "npm", "dist-tag"), []);
});

test("the offline dry run derives each channel's layers from that channel's verified tarballs", async () => {
  packGraph({ [b]: { dependencies: { [a]: BUMP.version + SUFFIX } } });
  await collectBoth();
  const forbidden = () => assert.fail("dry run attempted an external read or write");
  for (const [channel, layers] of [["staging", [[base], [a], [b], [umbrella]]], ["production", [[base], [a, b], [umbrella]]]]) {
    const logs = [];
    await publishWith(world(), { channel, dryRun: true, registry: forbidden, run: forbidden, runPublish: forbidden, log: (line) => logs.push(line) });
    assert.deepEqual(logs, layers.map((layer, index) => `${channel} layer ${index + 1}: ${layer.join(", ")}`));
  }
});

test("a packed npm alias depends on its target, not its local import name", async () => {
  for (const [channel, version] of [["production", BUMP.version], ["staging", BUMP.version + SUFFIX]]) {
    const directory = join(root, channel);
    pack(directory, { name: umbrella, version, dependencies: { sdk: `npm:${base}@${version}` } });
    pack(directory, { name: base, version, optionalDependencies: { [umbrella]: "npm:third-party@^2" } });
  }
  const { packages } = await collectBoth();
  assert.deepEqual(packages.map((pkg) => pkg.name), [umbrella, base]);
  const fake = world();
  await publishWith(fake);
  assert.deepEqual(commands(fake.calls, "npm", "publish").map((call) => basename(call[2])), [packages[1].staging.file, packages[0].staging.file]);
  assert.deepEqual(await dependencyFindings([
    { name: base, version: BUMP.version, manifest: { optionalDependencies: { [umbrella]: "npm:third-party@^2" } } },
    { name: umbrella, version: BUMP.version, manifest: { optionalDependencies: { sdk: `npm:${base}@0.0.1` } } },
  ], ["@photon-hq/"], fake.registry), [`${umbrella} optionalDependencies: ${base}@0.0.1 differs from the promoted ${BUMP.version}`]);
});

for (const [description, fields, message] of [
  ["a cycle in staging", { peerDependencies: { [umbrella]: "*" } }, /depend on each other/],
  ["a self-cycle", { dependencies: { [base]: "*" } }, /depend on each other/],
  ["malformed optional dependencies", { optionalDependencies: [a] }, /invalid optionalDependencies/],
]) {
  test(`${description} fails before the first write`, async () => {
    packGraph();
    const manifest = await collectBoth();
    packGraph({ [base]: fields });
    await assert.rejects(collectBoth(), message);
    const staged = manifest.packages.find(({ name }) => name === base).staging;
    const from = join(root, "staging", staged.file);
    copyFileSync(from, join(root, "release", staged.file));
    const bytes = readFileSync(from);
    Object.assign(staged, { integrity: integrity(bytes), sha256: sha256(bytes) });
    writeFileSync(join(root, "release", "release-manifest.json"), JSON.stringify(manifest));
    const fake = world();
    await assert.rejects(publishWith(fake), message);
    assert.deepEqual(fake.calls, []);
  });
}

test("an incomplete registry response is not proof that a version is absent", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ versions: [] }));
  await assert.rejects(registryMetadata("https://registry.npmjs.org")(base), /invalid registry metadata/);
});

test("npm child processes overlap and keep private scratch state without changing registry configuration", async (t) => {
  packGraph();
  const { packages } = await collectBoth();
  const records = join(root, "records");
  const bin = join(root, "bin");
  mkdirSync(records);
  mkdirSync(bin);
  writeFileSync(join(root, "npmrc"), "registry=https://registry.invalid\n");
  writeFileSync(join(bin, "npm"), `#!${process.execPath}
    const fs = require("node:fs"), path = require("node:path");
    const [command, file] = process.argv.slice(2);
    if (command !== "publish") throw Error("unexpected command");
    const archive = path.basename(file);
    fs.writeFileSync(path.join(process.env.RECORDS, archive), JSON.stringify({
      cwd: process.cwd(), cache: process.env.npm_config_cache, tmp: process.env.TMPDIR,
      data: process.env.XDG_DATA_HOME, config: fs.readFileSync(process.env.NPM_CONFIG_USERCONFIG, "utf8")
    }));
    if (archive.includes("-plugin-")) {
      const deadline = Date.now() + 4000;
      while (fs.readdirSync(process.env.RECORDS).filter(f => f.includes("-plugin-")).length < 2) {
        if (Date.now() > deadline) throw Error("publishers never overlapped");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  `, { mode: 0o755 });
  const env = process.env;
  process.env = { PATH: `${bin}:${env.PATH}`, HOME: root, RECORDS: records, NPM_CONFIG_USERCONFIG: join(root, "npmrc") };
  t.after(() => { process.env = env; });
  const fake = world();
  const candidates = new Map(packages.map((pkg) => [pkg.name, pkg.staging]));
  await publishWith(fake, {
    runPublish: undefined,
    registry: async (name) => {
      const { version, file, integrity } = candidates.get(name);
      if (existsSync(join(records, file))) fake.state.published[`${name}@${version}`] = integrity;
      return fake.registry(name);
    },
  });
  const dirs = new Set();
  for (const { staging } of packages) {
    const { cwd, cache, tmp, data, config } = JSON.parse(readFileSync(join(records, staging.file)));
    assert.equal(config, "registry=https://registry.invalid\n");
    assert.deepEqual([tmp, data, cache], [cwd, cwd, join(cwd, "cache")]);
    assert.equal(existsSync(cwd), false);
    dirs.add(cwd);
  }
  assert.equal(dirs.size, packages.length);
});
