import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { registryMetadata, releaseNames, verifyManifest } from "../.github/package-release/package-release.mjs";
import { SHA, SUFFIX, REPOSITORY, bumpTo, root, setUp, tearDown, pack, collectBoth, world, commands, publishWith, stagedWorld, resolveWith } from "./fixtures/package-release.mjs";

beforeEach(setUp);
afterEach(tearDown);

const NPMJS = "https://registry.npmjs.org";
const PUBLIC = { packageInput: "@photon-ai/otel", registryUrl: NPMJS, bump: bumpTo("3.9.0", "v3.8.2") };
const PUBLIC_STAGING = `3.9.0${SUFFIX}`;

function packPublic() {
  pack(join(root, "staging"), { name: "@photon-ai/otel", version: PUBLIC_STAGING });
  pack(join(root, "production"), { name: "@photon-ai/otel", version: "3.9.0" });
}

/** A registry that, like npmjs while it scans a new version, does not serve it for its first `reads` reads. */
const processing = (fake, version, reads) => async (name) => {
  const metadata = await fake.registry(name);
  if (metadata.versions[version] && reads-- > 0) delete metadata.versions[version];
  return metadata;
};

test("a public package is named by the package input and keeps to its scope on npmjs", async () => {
  packPublic();
  const manifest = await collectBoth(PUBLIC);
  assert.equal(manifest.package, "@photon-ai/otel");
  assert.equal(manifest.registry, NPMJS);
  assert.equal(manifest.stagingTag, `adapter-staging-${PUBLIC_STAGING}`);
  assert.equal(manifest.productionTag, "v3.9.0");
  await assert.rejects(collectBoth({ registryUrl: NPMJS }), /named by the package input/);
  await assert.rejects(collectBoth({ ...PUBLIC, registryUrl: "https://registry.example.com" }), /Unsupported registry/);
  pack(join(root, "staging"), { name: "@photon-hq/adapter", version: `1.0.0${SUFFIX}` });
  pack(join(root, "production"), { name: "@photon-hq/adapter", version: "1.0.0" });
  await assert.rejects(collectBoth(PUBLIC), /not in the release selection @photon-ai\//);
});

test("npmjs accepts an unscoped package input and still rejects invalid names", () => {
  assert.deepEqual(releaseNames({ repository: REPOSITORY, packageInput: "dsh-imessage", registryUrl: NPMJS }), {
    registryUrl: NPMJS, selection: ["dsh-imessage"], primary: "dsh-imessage", tagPrefix: "adapter-staging-", productionTagPrefix: "v",
  });
  assert.deepEqual(releaseNames({ repository: REPOSITORY, packageInput: PUBLIC.packageInput, registryUrl: NPMJS }), {
    registryUrl: NPMJS, selection: ["@photon-ai/"], primary: "@photon-ai/otel", tagPrefix: "adapter-staging-", productionTagPrefix: "v",
  });
  assert.deepEqual(releaseNames({ repository: REPOSITORY }), {
    registryUrl: "https://npm.pkg.github.com", selection: ["@photon-hq/"], primary: "@photon-hq/adapter", tagPrefix: "adapter-staging-", productionTagPrefix: "v",
  });
  assert.equal(releaseNames({ repository: REPOSITORY, packageInput: "a".repeat(214), registryUrl: NPMJS }).primary.length, 214);
  for (const name of ["", "@scope", "@scope/", "@scope/pkg/extra", "Uppercase", "bad name", ".hidden", "_hidden", "-hidden", "pkg%2fother", "a".repeat(215), "node_modules", "favicon.ico"])
    assert.throws(() => releaseNames({ repository: REPOSITORY, packageInput: name, registryUrl: NPMJS }), /named by the package input/);
});

test("an unscoped npmjs build stages and promotes exactly its named package", async () => {
  const options = { ...PUBLIC, packageInput: "dsh-imessage" };
  for (const [directory, version] of [["staging", PUBLIC_STAGING], ["production", "3.9.0"]])
    pack(join(root, directory), { name: options.packageInput, version, dependencies: { "dsh-imessage-helper": "^1.0.0" } });
  const manifest = await collectBoth(options);
  assert.deepEqual(manifest.packages.map(({ name }) => name), [options.packageInput]);
  assert.equal(manifest.packages[0].staging.file, `dsh-imessage-${PUBLIC_STAGING}.tgz`);
  assert.equal(manifest.packages[0].production.file, "dsh-imessage-3.9.0.tgz");
  await assert.rejects(verifyManifest(join(root, "release"), {
    ...manifest, packages: [{ ...manifest.packages[0], name: "dsh-imessage-helper" }],
  }, { repository: REPOSITORY, ...options, channels: ["staging", "production"] }), /package dsh-imessage-helper/);

  const fake = world();
  await publishWith(fake, options);
  const { manifest: resolved } = await resolveWith(fake, { ...options, version: PUBLIC_STAGING });
  assert.deepEqual(resolved, manifest);
  const [attestation] = commands(fake.calls, "gh", "attestation");
  assert.equal(attestation[3], join(root, "candidate/dsh-imessage-3.9.0.tgz"));
  for (const [flag, value] of [["--repo", REPOSITORY], ["--signer-workflow", "photon-hq/buildspace/.github/workflows/package-stage.yml"], ["--source-digest", SHA], ["--source-ref", "refs/heads/main"]])
    assert.equal(attestation[attestation.indexOf(flag) + 1], value);
  await publishWith(fake, { ...options, directory: join(root, "candidate"), channel: "production", sourceSha: undefined, runId: "901" });
  assert.deepEqual(Object.keys(fake.state.published).sort(), [`dsh-imessage@${PUBLIC_STAGING}`, "dsh-imessage@3.9.0"].sort());
  assert.ok(commands(fake.calls, "npm", "publish").every((call) => call.includes("--provenance") && call.includes(`--registry=${NPMJS}`)));
  assert.deepEqual(commands(fake.calls, "npm", "dist-tag").filter((call) => call[2] === "add").map((call) => call.slice(3)), [
    [`dsh-imessage@${PUBLIC_STAGING}`, "staging", `--registry=${NPMJS}`],
    ["dsh-imessage@3.9.0", "latest", `--registry=${NPMJS}`],
  ]);
  assert.deepEqual(fake.state.releases["v3.9.0"].assets.sort(), ["dsh-imessage-3.9.0.tgz", "release-manifest.json"]);
});

test("an unscoped npmjs pack refuses other packages, including a matching name prefix", async () => {
  const options = { ...PUBLIC, packageInput: "dsh-imessage" };
  for (const [directory, version] of [["staging", PUBLIC_STAGING], ["production", "3.9.0"]])
    pack(join(root, directory), { name: options.packageInput, version });
  for (const name of ["dsh-imessage-helper", "@photon-ai/otel"]) {
    const extra = pack(join(root, "staging"), { name, version: PUBLIC_STAGING });
    await assert.rejects(collectBoth(options), /not in the release selection dsh-imessage$/);
    rmSync(extra);
  }
  await assert.rejects(collectBoth({ packageInput: "dsh-imessage" }), /not in the release selection @photon-hq\//);
});

test("a mixed npmjs build releases exactly the names and scopes its package selection lists", async () => {
  const options = { ...PUBLIC, packageInput: "app", packageSelection: "app @app/" };
  for (const [directory, version] of [["staging", PUBLIC_STAGING], ["production", "3.9.0"]]) {
    pack(join(root, directory), { name: "app", version, dependencies: { "@app/core": version } });
    pack(join(root, directory), { name: "@app/core", version });
  }
  const manifest = await collectBoth(options);
  assert.deepEqual(manifest.packages.map(({ name }) => name), ["@app/core", "app"]);
  const fake = world();
  await publishWith(fake, options);
  const { manifest: resolved } = await resolveWith(fake, { ...options, version: PUBLIC_STAGING });
  assert.deepEqual(resolved, manifest);

  pack(join(root, "staging"), { name: "app-helper", version: PUBLIC_STAGING });
  await assert.rejects(collectBoth(options), /app-helper is not in the release selection app @app\//);
  assert.throws(() => releaseNames({ repository: REPOSITORY, packageInput: "app", packageSelection: "@app/", registryUrl: NPMJS }), /must include the package input app/);
});

test("npmjs is read without credentials and past its CDN", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push([url, init.headers]);
    return new Response(JSON.stringify({ versions: { "3.9.0": {} }, "dist-tags": { latest: "3.9.0" } }));
  });
  const metadata = await registryMetadata(NPMJS, "github-token")("@photon-ai/otel");
  assert.deepEqual(metadata["dist-tags"], { latest: "3.9.0" });
  await registryMetadata("https://npm.pkg.github.com", "github-token")("@photon-hq/adapter");
  assert.deepEqual(requests, [
    ["https://registry.npmjs.org/%40photon-ai%2Fotel?write=true", { accept: "application/json" }],
    ["https://npm.pkg.github.com/%40photon-hq%2Fadapter", { authorization: "Bearer github-token", accept: "application/json" }],
  ]);
});

test("staging on npmjs publishes with provenance and waits until the registry serves the version", async () => {
  packPublic();
  await collectBoth(PUBLIC);
  const fake = world();
  const sleeps = [];
  let clock = 0;
  await publishWith(fake, {
    ...PUBLIC,
    registry: processing(fake, PUBLIC_STAGING, 2),
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
  });
  assert.deepEqual(commands(fake.calls, "npm", "publish").map((call) => call.slice(3)), [
    ["--tag", "candidate-900-1", "--ignore-scripts", "--access", "public", "--provenance", `--registry=${NPMJS}`],
  ]);
  assert.deepEqual(sleeps, [15_000, 15_000]);
  assert.deepEqual(commands(fake.calls, "npm", "dist-tag").map((call) => call.slice(2)), [
    ["add", `@photon-ai/otel@${PUBLIC_STAGING}`, "staging", `--registry=${NPMJS}`],
    ["rm", "@photon-ai/otel", "candidate-900-1", `--registry=${NPMJS}`],
  ]);
  assert.equal(fake.state.releases[`adapter-staging-${PUBLIC_STAGING}`].title, `@photon-ai/otel ${PUBLIC_STAGING}`);
});

test("a version the registry never serves stops publication before any tag or release", async () => {
  packPublic();
  await collectBoth(PUBLIC);
  const fake = world();
  let clock = 0;
  await assert.rejects(
    publishWith(fake, { ...PUBLIC, registry: processing(fake, PUBLIC_STAGING, Number.POSITIVE_INFINITY), now: () => clock, sleep: async (ms) => { clock += ms; } }),
    /did not serve it within 30 minutes/
  );
  assert.equal(clock, 30 * 60_000);
  assert.equal(commands(fake.calls, "npm", "dist-tag").length, 0);
  assert.deepEqual(fake.state.releases, {});
});

test("a public build is promoted on npmjs, and only there", async () => {
  packPublic();
  const manifest = await collectBoth(PUBLIC);
  const fake = world({ latest: { "@photon-ai/otel": "3.8.2" }, tags: { "v3.8.2": "c".repeat(40) } });
  await publishWith(fake, PUBLIC);
  fake.calls.length = 0;
  const { manifest: resolved, changes } = await resolveWith(fake, { ...PUBLIC, version: PUBLIC_STAGING });
  assert.deepEqual(resolved, manifest);
  assert.equal(changes, undefined);
  await assert.rejects(resolveWith(fake, { packageInput: "@photon-ai/otel", version: PUBLIC_STAGING }), /registry https:\/\/registry\.npmjs\.org/);

  await publishWith(fake, { ...PUBLIC, directory: join(root, "candidate"), channel: "production", sourceSha: undefined, runId: "901" });
  assert.equal(fake.state.published["@photon-ai/otel@3.9.0"], manifest.packages[0].production.integrity);
  assert.ok(commands(fake.calls, "npm", "publish").every((call) => call.includes("--provenance") && call.includes(`--registry=${NPMJS}`)));
  assert.deepEqual(commands(fake.calls, "npm", "dist-tag").filter((call) => call[2] === "add").map((call) => call.slice(3)), [
    ["@photon-ai/otel@3.9.0", "latest", `--registry=${NPMJS}`],
  ]);
  assert.equal(fake.state.tags["v3.9.0"], SHA);
  assert.equal(fake.state.releases["v3.9.0"].prerelease, false);
  assert.ok(fake.state.releases["v3.9.0"].notes.includes("A minor release after [`v3.8.2`](https://github.com/photon-hq/adapter/releases/tag/v3.8.2)."));
});

test("a build staged before registries were recorded is promoted to GitHub Packages", async () => {
  const { manifest: staged, fake } = await stagedWorld();
  assert.equal(staged.registry, "https://npm.pkg.github.com");
  const path = join(root, "release/release-manifest.json");
  const { registry: _, ...manifest } = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify(manifest));
  assert.equal((await resolveWith(fake)).pending, true);
  await assert.rejects(resolveWith(fake, { ...PUBLIC, packageInput: "@photon-hq/adapter" }), /registry https:\/\/npm\.pkg\.github\.com/);
});
