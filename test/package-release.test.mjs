import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ciStatus, dependencyFindings, publishOrder, waitForCi } from "../.github/package-release/package-release.mjs";
import { SHA, SUFFIX, REPOSITORY, BUMP, root, setUp, tearDown, pack, packBoth, collectBoth, world, commands, publishWith, stagedWorld, resolveWith, asLegacy } from "./fixtures/package-release.mjs";

beforeEach(setUp);
afterEach(tearDown);

test("collect orders dependencies first and names the build after the repository's package", async () => {
  packBoth();
  const manifest = await collectBoth();
  assert.deepEqual(manifest.packages.map(({ name }) => name), ["@photon-hq/adapter-core", "@photon-hq/adapter"]);
  assert.equal(manifest.stagingTag, `adapter-staging-1.2.0${SUFFIX}`);
  assert.equal(manifest.productionTag, "v1.2.0");
  assert.equal(manifest.formatVersion, 3);
  assert.deepEqual(manifest.bump, BUMP);
  const [core] = manifest.packages;
  assert.equal(core.staging.version, `1.2.0${SUFFIX}`);
  assert.equal(core.production.version, "1.2.0");
  const bytes = readFileSync(join(root, "release", core.production.file));
  assert.equal(core.production.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.match(core.production.integrity, /^sha512-/);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "release/release-manifest.json"), "utf8")), manifest);
});

test("collect honours an explicit package and tag prefix", async () => {
  packBoth();
  const manifest = await collectBoth({ packageInput: "@photon-hq/adapter-core", tagPrefix: "core-staging-" });
  assert.equal(manifest.stagingTag, `core-staging-1.2.0${SUFFIX}`);
  assert.equal(manifest.productionTag, "v1.2.0");
});

test("collect names the production tag after a prefix where vX.Y.Z is taken", async () => {
  packBoth();
  const manifest = await collectBoth({ packageInput: "@photon-hq/adapter-core", tagPrefix: "core-staging-", productionTagPrefix: "core-v" });
  assert.equal(manifest.stagingTag, `core-staging-1.2.0${SUFFIX}`);
  assert.equal(manifest.productionTag, "core-v1.2.0");
  for (const productionTagPrefix of ["core-", "Core-v", "-v", "core v", "refs/tags/v"])
    await assert.rejects(collectBoth({ productionTagPrefix }), /Invalid production tag prefix/);
});

test("collect refuses packs that do not describe one build", async (t) => {
  const cases = {
    "staging version without the run suffix": () => packBoth({ suffix: "-staging.899.1" }),
    "packed at another version than the release version": () => packBoth({ adapter: "1.3.0" }),
    "a package at a version of its own": () => packBoth({ core: "0.3.0" }),
    "prerelease production candidate": () => {
      pack(join(root, "staging"), { name: "@photon-hq/adapter", version: `1.0.0-rc.1${SUFFIX}` });
      pack(join(root, "production"), { name: "@photon-hq/adapter", version: "1.0.0-rc.1" });
    },
    "different packages per channel": () => {
      pack(join(root, "staging"), { name: "@photon-hq/adapter", version: `1.0.0${SUFFIX}` });
      pack(join(root, "staging"), { name: "@photon-hq/extra", version: `1.0.0${SUFFIX}` });
      pack(join(root, "production"), { name: "@photon-hq/adapter", version: "1.0.0" });
    },
    "another scope": () => {
      pack(join(root, "staging"), { name: "@other/adapter", version: `1.0.0${SUFFIX}` });
      pack(join(root, "production"), { name: "@other/adapter", version: "1.0.0" });
    },
    "no package named after the repository": () => {
      pack(join(root, "staging"), { name: "@photon-hq/other", version: `1.0.0${SUFFIX}` });
      pack(join(root, "production"), { name: "@photon-hq/other", version: "1.0.0" });
    },
    "empty pack": () => {
      pack(join(root, "staging"), { name: "@photon-hq/adapter", version: `1.0.0${SUFFIX}` });
      mkdirSync(join(root, "production"));
    },
  };
  for (const [name, arrange] of Object.entries(cases))
    await t.test(name, async () => {
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root);
      arrange();
      await assert.rejects(collectBoth());
    });
  await t.test("no release version", async () => {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root);
    packBoth();
    await assert.rejects(collectBoth({ bump: null }), /Invalid release version/);
    await assert.rejects(collectBoth({ bump: { ...BUMP, level: "huge" } }), /Invalid release version: level huge/);
  });
});

test("publish order rejects dependency cycles", () => {
  assert.throws(
    () =>
      publishOrder(
        new Map([
          ["@photon-hq/a", { dependencies: { "@photon-hq/b": "1.0.0" } }],
          ["@photon-hq/b", { peerDependencies: { "@photon-hq/a": "^1.0.0" } }],
        ])
      ),
    /depend on each other/
  );
});

test("CI status considers only the latest main push run of the workflow on the commit", () => {
  const run = (overrides) => ({
    id: 1,
    path: ".github/workflows/ci.yml",
    head_sha: SHA,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    ...overrides,
  });
  const status = (runs) => ciStatus({ workflow_runs: runs }, { sha: SHA, workflow: "ci.yml" });
  assert.equal(status([]), "pending");
  assert.equal(status([run({ status: "in_progress", conclusion: null })]), "pending");
  assert.equal(status([run()]), "success");
  assert.equal(status([run({ event: "pull_request" }), run({ head_branch: "feature" }), run({ path: ".github/workflows/other.yml" })]), "pending");
  assert.throws(() => status([run(), run({ id: 2, conclusion: "failure" })]), /concluded failure/);
  assert.equal(status([run({ conclusion: "failure" }), run({ id: 2 })]), "success");
});

test("waiting for CI polls until success and times out otherwise", async () => {
  let clock = 0;
  const responses = [[], [{ id: 1, path: ".github/workflows/ci.yml", head_sha: SHA, head_branch: "main", event: "push", status: "completed", conclusion: "success" }]];
  await waitForCi({
    repository: REPOSITORY,
    sha: SHA,
    workflow: "ci.yml",
    timeoutMs: 60_000,
    run: () => JSON.stringify({ workflow_runs: responses.shift() }),
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  assert.equal(responses.length, 0);
  await assert.rejects(
    waitForCi({
      repository: REPOSITORY,
      sha: SHA,
      workflow: "ci.yml",
      timeoutMs: 30_000,
      run: () => JSON.stringify({ workflow_runs: [] }),
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    }),
    /Timed out/
  );
});

/** A fake GitHub and registry that records every command. */
test("staging publication parks, verifies, records the release, then moves the channel", async () => {
  packBoth();
  await collectBoth();
  const fake = world();
  const { tag } = await publishWith(fake, { runAttempt: "2" });
  assert.equal(tag, `adapter-staging-1.2.0${SUFFIX}`);
  assert.deepEqual(commands(fake.calls, "npm", "publish").map((call) => call.at(-3)), ["candidate-900-2", "candidate-900-2"]);
  assert.match(commands(fake.calls, "npm", "publish")[0][2], /adapter-core-1\.2\.0-staging/);
  assert.equal(fake.state.tags[tag], SHA);
  const release = fake.state.releases[tag];
  assert.equal(release.prerelease, true);
  assert.equal(release.title, `@photon-hq/adapter 1.2.0${SUFFIX}`);
  assert.deepEqual(release.assets.sort(), [
    "photon-hq-adapter-1.2.0-staging.900.1.tgz",
    "photon-hq-adapter-1.2.0.tgz",
    "photon-hq-adapter-core-1.2.0-staging.900.1.tgz",
    "photon-hq-adapter-core-1.2.0.tgz",
    "release-manifest.json",
  ]);
  assert.match(release.notes, /staging-version: 1\.2\.0-staging\.900\.1/);
  assert.ok(release.notes.includes("### Version `1.2.0`\n\nA minor release after [`v1.1.0`](https://github.com/photon-hq/adapter/releases/tag/v1.1.0)."));
  assert.ok(release.notes.includes("- **minor** feat: one ([#7](https://github.com/photon-hq/adapter/pull/7))"));
  const distTags = commands(fake.calls, "npm", "dist-tag");
  assert.deepEqual(distTags.map((call) => call.slice(2, 5)), [
    ["add", `@photon-hq/adapter-core@1.2.0${SUFFIX}`, "staging"],
    ["add", `@photon-hq/adapter@1.2.0${SUFFIX}`, "staging"],
    ["rm", "@photon-hq/adapter-core", "candidate-900-2"],
    ["rm", "@photon-hq/adapter", "candidate-900-2"],
  ]);
});

test("a retried publication accepts its own earlier work and finishes it", async () => {
  packBoth();
  const manifest = await collectBoth();
  const [core] = manifest.packages;
  const fake = world({
    published: { [`@photon-hq/adapter-core@${core.staging.version}`]: core.staging.integrity },
    tags: { [manifest.stagingTag]: SHA },
    releases: { [manifest.stagingTag]: { prerelease: true, assets: [core.staging.file] } },
  });
  await publishWith(fake, { runAttempt: "3" });
  assert.equal(commands(fake.calls, "npm", "publish").length, 1);
  assert.equal(fake.calls.some((call) => call.includes("--method")), false);
  assert.equal(commands(fake.calls, "gh", "release").filter((call) => call[2] === "upload").length, 1);
  assert.equal(fake.state.releases[manifest.stagingTag].assets.length, 5);
});

test("publication stops before writing when a version, tag or file disagrees", async (t) => {
  const staged = async () => {
    packBoth();
    const manifest = await collectBoth();
    return { manifest, core: manifest.packages[0] };
  };
  await t.test("version published with other contents", async () => {
    const { core } = await staged();
    const fake = world({ published: { [`@photon-hq/adapter-core@${core.staging.version}`]: "sha512-other" } });
    await assert.rejects(publishWith(fake), /different contents/);
    assert.equal(commands(fake.calls, "npm", "publish").length, 0);
  });
  await t.test("tag on another commit", async () => {
    const { manifest } = await staged();
    const fake = world({ tags: { [manifest.stagingTag]: "b".repeat(40) } });
    await assert.rejects(publishWith(fake), /already names/);
    assert.equal(fake.state.releases[manifest.stagingTag], undefined);
  });
  await t.test("file changed after collection", async () => {
    const { core } = await staged();
    writeFileSync(join(root, "release", core.production.file), "tampered");
    const fake = world();
    await assert.rejects(publishWith(fake), /does not match/);
    assert.equal(fake.calls.length, 0);
  });
});

test("the publishing job trusts no manifest claim the files and run do not support", async (t) => {
  const forge = async (edit) => {
    packBoth();
    await collectBoth();
    const path = join(root, "release/release-manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    edit(manifest);
    writeFileSync(path, JSON.stringify(manifest));
  };
  const cases = {
    "tag on another name": [(m) => { m.stagingTag = "v9.9.9"; }, /release tags/],
    "another source commit": [(m) => { m.sourceSha = "b".repeat(40); }, /source/],
    "another run's suffix": [(m) => { m.suffix = "-staging.1.1"; for (const pkg of m.packages) pkg.staging.version = `${pkg.production.version}-staging.1.1`; }, /suffix/],
    "unstable candidate": [(m) => { m.packages[0].production.version = "0.3.0-rc.1"; }, /versions/],
    "another release version": [(m) => { m.bump.version = "1.3.0"; }, /bump, which is not the version this run computed/],
    "bump dropped": [(m) => { delete m.bump; }, /bump version undefined/],
    "file outside the release": [(m) => { m.packages[0].staging.file = "../escape.tgz"; }, /file/],
    "forged npm integrity": [(m) => { m.packages[0].production.integrity = "sha512-forged"; }, /does not match the release manifest/],
    "another package name": [(m) => { m.packages[0].name = "@photon-hq/other"; }, /holds|publish order|file/],
  };
  for (const [name, [edit, error]] of Object.entries(cases))
    await t.test(name, async () => {
      await forge(edit);
      const fake = world();
      await assert.rejects(publishWith(fake), error);
      assert.equal(fake.calls.length, 0);
    });
});

test("a channel tag never moves to an older version", async () => {
  packBoth();
  await collectBoth();
  const fake = world({ staging: { "@photon-hq/adapter": "9.0.0-staging.1.1" } });
  const logs = [];
  await publishWith(fake, { log: (line) => logs.push(line) });
  assert.deepEqual(commands(fake.calls, "npm", "dist-tag").filter((call) => call[2] === "add").map((call) => call[3]), [`@photon-hq/adapter-core@1.2.0${SUFFIX}`]);
  assert.ok(logs.some((line) => line.includes("Kept @photon-hq/adapter@staging on 9.0.0-staging.1.1")));
});

test("dependency findings require released internal dependencies", async () => {
  const fake = world({
    published: {
      "@photon-hq/contracts@0.25.0-staging.39.1": "sha512-x",
      "@photon-hq/contracts@0.26.0": "sha512-y",
      "@photon-hq/payload@1.0.0": "sha512-z",
    },
  });
  const candidates = [
    { name: "@photon-hq/adapter-core", version: "0.3.0", manifest: { peerDependencies: { "@photon-hq/contracts": ">=0.25.0-staging.39.1", zod: "4.0.0" } } },
    {
      name: "@photon-hq/adapter",
      version: "1.2.0",
      manifest: {
        dependencies: { "@photon-hq/adapter-core": "0.3.0", "@photon-hq/payload": "1.0.0", lodash: "^4" },
        peerDependencies: { "@photon-hq/adapter-core": "^0.3.0" },
      },
    },
  ];
  assert.deepEqual(await dependencyFindings(candidates, ["@photon-hq/"], fake.registry), []);
  const blocked = [
    { name: "@photon-hq/adapter-core", version: "0.3.0", manifest: { peerDependencies: { "@photon-hq/contracts": "0.25.0-staging.39.1", "@photon-hq/missing": "^1" } } },
    {
      name: "@photon-hq/adapter",
      version: "1.2.0",
      manifest: {
        dependencies: { "@photon-hq/adapter-core": "0.2.0", "@photon-hq/payload": "1.0.1", "@photon-hq/contracts": "0.25.0-staging.39.1" },
        optionalDependencies: { "@photon-hq/linked": "workspace:*" },
      },
    },
  ];
  const findings = await dependencyFindings(blocked, ["@photon-hq/"], fake.registry);
  assert.equal(findings.length, 6, findings.join("\n"));
  assert.ok(findings.some((finding) => finding.includes("@photon-hq/contracts@0.25.0-staging.39.1 is not an exact stable version")));
  assert.ok(findings.some((finding) => finding.includes("no published stable @photon-hq/contracts satisfies 0.25.0-staging.39.1")));
});

test("promotion resolves the current staging build and verifies each candidate's provenance", async () => {
  const { manifest, fake } = await stagedWorld();
  const { manifest: resolved, changes } = await resolveWith(fake);
  assert.deepEqual(resolved, manifest);
  assert.equal(changes, undefined);
  const attestations = commands(fake.calls, "gh", "attestation");
  assert.equal(attestations.length, 2);
  for (const flag of [["--repo", REPOSITORY], ["--signer-workflow", "photon-hq/buildspace/.github/workflows/package-stage.yml"], ["--source-digest", SHA], ["--source-ref", "refs/heads/main"]])
    assert.equal(attestations[0][attestations[0].indexOf(flag[0]) + 1], flag[1]);

  await publishWith(fake, { directory: join(root, "candidate"), channel: "production", sourceSha: undefined, runId: "901" });
  assert.equal(fake.state.published["@photon-hq/adapter@1.2.0"], manifest.packages[1].production.integrity);
  assert.equal(fake.state.tags["v1.2.0"], SHA);
  const release = fake.state.releases["v1.2.0"];
  assert.equal(release.prerelease, false);
  assert.deepEqual(release.assets.sort(), ["photon-hq-adapter-1.2.0.tgz", "photon-hq-adapter-core-1.2.0.tgz", "release-manifest.json"]);
  assert.deepEqual(commands(fake.calls, "npm", "dist-tag").filter((call) => call[2] === "add").map((call) => call.slice(3, 5)), [
    ["@photon-hq/adapter-core@1.2.0", "latest"],
    ["@photon-hq/adapter@1.2.0", "latest"],
  ]);
});

/** Rewrites the staged manifest as the stage workflow wrote it before it computed versions. */
test("promotion shows the version a build's changes computed", async () => {
  const { fake } = await stagedWorld({ world: { tags: { "v1.1.0": "c".repeat(40) } } });
  const { manifest, changes } = await resolveWith(fake);
  assert.equal(changes, undefined);
  assert.deepEqual(manifest.bump, BUMP);
  await publishWith(fake, { directory: join(root, "candidate"), channel: "production", sourceSha: undefined, runId: "901" });
  assert.equal(commands(fake.calls, "gh", "api").some((call) => call.some((arg) => arg.includes("/compare/v1.1.0"))), false);
  assert.ok(fake.state.releases["v1.2.0"].notes.includes("- **minor** feat: one ([#7](https://github.com/photon-hq/adapter/pull/7))"));
});

test("promotion lists the changes since the current production release", async () => {
  const { fake } = await stagedWorld({ world: { tags: { "v1.1.0": "c".repeat(40) } } });
  // A build staged before versions were computed lists the commits instead.
  asLegacy();
  fake.registry = ((registry) => async (name) => {
    const metadata = await registry(name);
    if (name === "@photon-hq/adapter") metadata["dist-tags"].latest = "1.1.0";
    return metadata;
  })(fake.registry);
  const { changes } = await resolveWith(fake, { version: `1.2.0${SUFFIX}` });
  assert.deepEqual(changes, { previousTag: "v1.1.0", total: 2, subjects: ["fix: two", "feat: one"] });
});

test("promotion under a production tag prefix leaves the repository's vX.Y.Z tags alone", async () => {
  const names = { productionTagPrefix: "adapter-v" };
  // v1.2.0 and v1.1.0 already name the repository's own releases, on other commits.
  const { manifest, fake } = await stagedWorld({
    names,
    world: { tags: { "v1.2.0": "b".repeat(40), "v1.1.0": "b".repeat(40), "adapter-v1.1.0": "c".repeat(40) } },
  });
  assert.equal(manifest.productionTag, "adapter-v1.2.0");
  asLegacy();
  fake.registry = ((registry) => async (name) => {
    const metadata = await registry(name);
    if (name === "@photon-hq/adapter") metadata["dist-tags"].latest = "1.1.0";
    return metadata;
  })(fake.registry);
  const { changes } = await resolveWith(fake, names);
  assert.equal(changes.previousTag, "adapter-v1.1.0");

  await publishWith(fake, { directory: join(root, "candidate"), channel: "production", sourceSha: undefined, runId: "901", ...names });
  assert.equal(fake.state.tags["adapter-v1.2.0"], SHA);
  assert.equal(fake.state.tags["v1.2.0"], "b".repeat(40));
  assert.equal(fake.state.releases["adapter-v1.2.0"].prerelease, false);
  assert.equal(fake.state.releases["v1.2.0"], undefined);
  // The prefix is re-derived from the run's inputs, not taken from the manifest.
  await assert.rejects(resolveWith(fake), /release tags/);
});

const [OLDER, BETWEEN, FREIGHT, NEWER] = ["b", "c", "d", "e"].map((letter) => letter.repeat(40));
const HISTORY = [OLDER, SHA, BETWEEN, FREIGHT, NEWER];
const stageRun = (id, sha, conclusion = "success") => ({
  id,
  head_sha: sha,
  status: conclusion ? "completed" : "in_progress",
  conclusion,
  html_url: `https://github.com/${REPOSITORY}/actions/runs/${id}`,
});

test("an image tag promotes the build its main commit carries", async () => {
  const { manifest, fake } = await stagedWorld({
    // A later commit has its own build, which this image does not contain.
    world: { history: HISTORY, runs: [stageRun(950, NEWER), stageRun(900, SHA)], tags: { "adapter-staging-1.2.0-staging.950.1": NEWER } },
  });
  const { manifest: resolved, pending } = await resolveWith(fake, { imageTag: `main-${FREIGHT}` });
  assert.deepEqual(resolved, manifest);
  assert.equal(pending, true);
  assert.deepEqual((await resolveWith(fake, { imageTag: `main-${SHA}` })).manifest, manifest);
});

test("an image tag is refused when its commit carries no certain build", async (t) => {
  await t.test("a later stage run published nothing", async () => {
    for (const [conclusion, shown] of [["failure", "failure"], [null, "in_progress"]]) {
      const { fake } = await stagedWorld({ world: { history: HISTORY, runs: [stageRun(930, BETWEEN, conclusion), stageRun(900, SHA)] } });
      await assert.rejects(
        resolveWith(fake, { imageTag: `main-${FREIGHT}` }),
        new RegExp(`runs/930 staged ${BETWEEN} after adapter-staging-1\\.2\\.0-staging\\.900\\.1 and published no build \\(${shown}\\)`)
      );
    }
  });
  await t.test("staged only after the commit", async () => {
    const { fake } = await stagedWorld({ world: { history: HISTORY } });
    await assert.rejects(resolveWith(fake, { imageTag: `main-${OLDER}` }), /has no staging build at or before b{40}/);
  });
  await t.test("not an immutable tag, or a version as well", async () => {
    const { fake } = await stagedWorld();
    await assert.rejects(resolveWith(fake, { imageTag: "main-abcd" }), /Invalid immutable image tag/);
    await assert.rejects(resolveWith(fake, { imageTag: `main-${SHA}`, version: `1.2.0${SUFFIX}` }), /not both/);
  });
});

test("a hotfix image releases no packages", async () => {
  const { fake } = await stagedWorld({ world: { environment: [] } });
  assert.deepEqual(await resolveWith(fake, { imageTag: `hotfix-${SHA}-${FREIGHT}` }), { pending: false });
  assert.equal(fake.calls.length, 0);
});

test("a build that is already released has nothing pending", async () => {
  const { fake } = await stagedWorld();
  assert.equal((await resolveWith(fake)).pending, true);
  await publishWith(fake, { directory: join(root, "candidate"), channel: "production", sourceSha: undefined, runId: "901" });
  assert.equal((await resolveWith(fake)).pending, false);
  // Identical packages keep the tag of the commit that first released them.
  fake.state.tags["v1.2.0"] = OLDER;
  assert.equal((await resolveWith(fake)).pending, false);
  // An interrupted release still has work left.
  delete fake.state.releases["v1.2.0"];
  assert.equal((await resolveWith(fake)).pending, true);
});

test("the trusted actor's dispatch stands in for the environment's reviewers", async () => {
  const { manifest, fake } = await stagedWorld({ world: { environment: [] } });
  await assert.rejects(resolveWith(fake), /must exist and require a reviewer/);
  const { manifest: resolved, pending } = await resolveWith(fake, { approvedBy: "release-controller[bot]" });
  assert.deepEqual(resolved, manifest);
  assert.equal(pending, true);
  // Every other check still applies.
  const { fake: unattested } = await stagedWorld({ world: { attested: false } });
  await assert.rejects(resolveWith(unattested, { approvedBy: "release-controller[bot]" }), /no attestations|verification failed/);
});

test("promotion refuses unsafe candidates before anything is published", async (t) => {
  await t.test("environment without reviewers", async () => {
    const { fake } = await stagedWorld({ world: { environment: [] } });
    await assert.rejects(resolveWith(fake), /must exist and require a reviewer/);
  });
  await t.test("missing environment", async () => {
    const { fake } = await stagedWorld({ world: { environment: null } });
    await assert.rejects(resolveWith(fake), /must exist and require a reviewer/);
  });
  await t.test("build from before this workflow", async () => {
    const { fake } = await stagedWorld();
    await assert.rejects(resolveWith(fake, { version: "1.1.0-staging.39.1" }), /has no promotion candidates/);
  });
  await t.test("missing attestation", async () => {
    const { fake } = await stagedWorld({ world: { attested: false } });
    await assert.rejects(resolveWith(fake), /verification failed/);
  });
  await t.test("not newer than latest", async () => {
    const { fake } = await stagedWorld({ world: { latest: { "@photon-hq/adapter-core": "1.2.0" } } });
    await assert.rejects(resolveWith(fake), /not newer than latest 1\.2\.0; stage a newer build/);
  });
  await t.test("depends on a staging build", async () => {
    const { fake } = await stagedWorld({ pack: { extra: { peerDependencies: { "@photon-hq/contracts": "0.25.0-staging.39.1" } } } });
    await assert.rejects(resolveWith(fake), /no published stable @photon-hq\/contracts/);
  });
  await t.test("tampered candidate", async () => {
    const { manifest, fake } = await stagedWorld();
    writeFileSync(fake.state.releases[manifest.stagingTag].files.find((file) => file.endsWith("photon-hq-adapter-1.2.0.tgz")), "tampered");
    await assert.rejects(resolveWith(fake), /does not match the release manifest/);
  });
});
