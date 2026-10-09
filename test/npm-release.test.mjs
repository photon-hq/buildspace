import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  ciStatus,
  collect,
  crateDependencyFindings,
  dependencyFindings,
  publish,
  publishOrder,
  readArchive,
  readCrate,
  readManifest,
  resolveCandidate,
  waitForCi,
  workspaceManifest,
} from "../.github/npm-release/npm-release.mjs";

const SHA = "a".repeat(40);
const SUFFIX = "-staging.900.1";
const REPOSITORY = "photon-hq/adapter";
let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "npm-release-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function pack(directory, manifest) {
  const source = mkdtempSync(join(root, "source-"));
  mkdirSync(join(source, "package"));
  writeFileSync(join(source, "package/package.json"), JSON.stringify(manifest));
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${manifest.name.slice(1).replace("/", "-")}-${manifest.version}.tgz`);
  execFileSync("tar", ["-czf", file, "-C", source, "package"]);
  return file;
}

/** A `.crate` as `cargo package` lays it out, packaged from `sha`. */
function crate(directory, { name = "adapter", version = "0.4.0", sha = SHA, dirty = false, path = `crates/${name}`, lib = "pub fn adapter() {}\n", original, root: base = `${name}-${version}`, format = "gnu" } = {}) {
  const source = mkdtempSync(join(root, "crate-"));
  mkdirSync(join(source, base, "src"), { recursive: true });
  writeFileSync(join(source, base, "Cargo.toml"), `[package]\nedition = "2024"\nname = "${name}"\nversion = "${version}"\nbuild = false\n`);
  writeFileSync(join(source, base, "Cargo.toml.orig"), original ?? `[package]\nname = "${name}"\nversion = "${version}"\nedition = "2024"\n`);
  writeFileSync(join(source, base, ".cargo_vcs_info.json"), JSON.stringify({ git: { sha1: sha, ...(dirty && { dirty: true }) }, path_in_vcs: path }));
  writeFileSync(join(source, base, "src/lib.rs"), lib);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${name}-${version}.crate`);
  execFileSync("tar", [`--format=${format}`, "-czf", file, "-C", source, base]);
  return file;
}

function packBoth({ adapter = "1.2.0", core = "0.3.0", suffix = SUFFIX, extra = {} } = {}) {
  for (const [channel, end] of [["staging", suffix], ["production", ""]]) {
    pack(join(root, channel), {
      name: "@photon-hq/adapter",
      version: `${adapter}${end}`,
      dependencies: { "@photon-hq/adapter-core": `${core}${end}` },
      ...extra,
    });
    pack(join(root, channel), { name: "@photon-hq/adapter-core", version: `${core}${end}` });
  }
}

const collectBoth = (overrides = {}) =>
  collect({
    stagingDirectory: join(root, "staging"),
    productionDirectory: join(root, "production"),
    suffix: SUFFIX,
    sourceSha: SHA,
    repository: REPOSITORY,
    packageInput: "",
    tagPrefix: "",
    output: join(root, "release"),
    runUrl: "https://github.com/photon-hq/adapter/actions/runs/900/attempts/1",
    ...overrides,
  });

test("collect orders dependencies first and names the build after the repository's package", async () => {
  packBoth();
  const manifest = await collectBoth();
  assert.deepEqual(manifest.packages.map(({ name }) => name), ["@photon-hq/adapter-core", "@photon-hq/adapter"]);
  assert.equal(manifest.stagingTag, `adapter-staging-1.2.0${SUFFIX}`);
  assert.equal(manifest.productionTag, "v1.2.0");
  const [core] = manifest.packages;
  assert.equal(core.staging.version, `0.3.0${SUFFIX}`);
  assert.equal(core.production.version, "0.3.0");
  const bytes = readFileSync(join(root, "release", core.production.file));
  assert.equal(core.production.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.match(core.production.integrity, /^sha512-/);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "release/release-manifest.json"), "utf8")), manifest);
});

test("collect honours an explicit package and tag prefix", async () => {
  packBoth();
  const manifest = await collectBoth({ packageInput: "@photon-hq/adapter-core", tagPrefix: "core-staging-" });
  assert.equal(manifest.stagingTag, `core-staging-0.3.0${SUFFIX}`);
  assert.equal(manifest.productionTag, "v0.3.0");
});

test("collect refuses packs that do not describe one build", async (t) => {
  const cases = {
    "staging version without the run suffix": () => packBoth({ suffix: "-staging.899.1" }),
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
function world({ published = {}, tags = {}, releases = {}, latest = {}, staging = {}, environment = ["octocat"], attested = true, contents = {} } = {}) {
  const calls = [];
  const state = { published, tags, releases };
  const http404 = (message = "gh: Not Found (HTTP 404)") => Object.assign(new Error(message), { stderr: message });
  const run = (command, args) => {
    calls.push([command, ...args]);
    const [first, second] = args;
    if (command === "npm" && first === "publish") {
      const file = args[1];
      const { name, version } = JSON.parse(execFileSync("tar", ["-xOzf", file, "package/package.json"], { encoding: "utf8" }));
      state.published[`${name}@${version}`] = `sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}`;
      return "";
    }
    if (command === "npm" && first === "view") return JSON.stringify(state.published[second]);
    if (command === "npm" && first === "dist-tag") return "";
    if (command === "gh" && first === "api") {
      const path = args.find((arg) => arg.startsWith("repos/"));
      if (path.endsWith("/environments/production")) {
        if (!environment) throw http404();
        return JSON.stringify({ protection_rules: environment.length ? [{ type: "required_reviewers", reviewers: environment.map((login) => ({ reviewer: { login } })) }] : [] });
      }
      const content = /\/contents\/(.+)\?ref=a{40}$/.exec(path)?.[1];
      if (content) {
        if (contents[decodeURIComponent(content)] === undefined) throw http404();
        return contents[decodeURIComponent(content)];
      }
      const tag = /\/git\/ref\/tags\/(.+)$/.exec(path)?.[1];
      if (tag) {
        if (!state.tags[tag]) throw http404();
        return JSON.stringify({ object: { type: "commit", sha: state.tags[tag] } });
      }
      if (path.endsWith("/git/refs")) {
        const ref = args.find((arg) => arg.startsWith("ref=")).slice("ref=refs/tags/".length);
        state.tags[ref] = args.find((arg) => arg.startsWith("sha=")).slice(4);
        return "";
      }
      if (/\/compare\/a{40}\.\.\.main$/.test(path)) return JSON.stringify({ status: "ahead" });
      if (/\/compare\/v[^.]+.*\.\.\.a{40}$/.test(path))
        return JSON.stringify({ total_commits: 2, commits: [{ commit: { message: "feat: one\n\nbody" } }, { commit: { message: "fix: two" } }] });
    }
    if (command === "gh" && first === "release") {
      const tag = args[2];
      const release = state.releases[tag];
      if (second === "view") {
        if (!release) throw http404("release not found");
        return JSON.stringify({ isPrerelease: release.prerelease, assets: release.assets.map((name) => ({ name })) });
      }
      if (second === "create") {
        const files = args.slice(3, args.indexOf("--repo"));
        state.releases[tag] = { prerelease: args.includes("--prerelease"), assets: files.map((file) => file.split("/").at(-1)), files, notes: readFileSync(args[args.indexOf("--notes-file") + 1], "utf8"), title: args[args.indexOf("--title") + 1] };
        return "";
      }
      if (second === "upload") {
        release.assets.push(...args.slice(3, args.indexOf("--repo")).map((file) => file.split("/").at(-1)));
        return "";
      }
      if (second === "download") {
        if (!release) throw http404("release not found");
        const pattern = args[args.indexOf("--pattern") + 1];
        const source = release.files.find((file) => file.endsWith(`/${pattern}`));
        if (!source) throw http404("no assets match the file pattern");
        writeFileSync(join(args[args.indexOf("--dir") + 1], pattern), readFileSync(source));
        return "";
      }
    }
    if (command === "gh" && first === "attestation") {
      if (!attested) throw Object.assign(new Error("verification failed"), { stderr: "no attestations" });
      return "";
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
  const registry = async (name) => {
    const versions = {};
    for (const [key, value] of Object.entries(state.published)) {
      const at = key.lastIndexOf("@");
      if (key.slice(0, at) === name) versions[key.slice(at + 1)] = { dist: { integrity: value } };
    }
    const tags = {};
    if (latest[name]) tags.latest = latest[name];
    if (staging[name]) tags.staging = staging[name];
    return { versions, "dist-tags": tags };
  };
  return { calls, state, run, registry };
}

const commands = (calls, command, first) => calls.filter((call) => call[0] === command && call[1] === first);
const publishWith = (fake, overrides = {}) =>
  publish({
    directory: join(root, "release"),
    channel: "staging",
    repository: REPOSITORY,
    sourceSha: SHA,
    packageInput: "",
    tagPrefix: "",
    runId: "900",
    runAttempt: "1",
    run: fake.run,
    registry: fake.registry,
    log: () => {},
    ...overrides,
  });

test("staging publication parks, verifies, records the release, then moves the channel", async () => {
  packBoth();
  await collectBoth();
  const fake = world();
  const { tag } = await publishWith(fake, { runAttempt: "2" });
  assert.equal(tag, `adapter-staging-1.2.0${SUFFIX}`);
  assert.deepEqual(commands(fake.calls, "npm", "publish").map((call) => call.at(-3)), ["candidate-900-2", "candidate-900-2"]);
  assert.match(commands(fake.calls, "npm", "publish")[0][2], /adapter-core-0\.3\.0-staging/);
  assert.equal(fake.state.tags[tag], SHA);
  const release = fake.state.releases[tag];
  assert.equal(release.prerelease, true);
  assert.equal(release.title, `@photon-hq/adapter 1.2.0${SUFFIX}`);
  assert.deepEqual(release.assets.sort(), [
    "photon-hq-adapter-1.2.0-staging.900.1.tgz",
    "photon-hq-adapter-1.2.0.tgz",
    "photon-hq-adapter-core-0.3.0-staging.900.1.tgz",
    "photon-hq-adapter-core-0.3.0.tgz",
    "release-manifest.json",
  ]);
  assert.match(release.notes, /staging-version: 1\.2\.0-staging\.900\.1/);
  const distTags = commands(fake.calls, "npm", "dist-tag");
  assert.deepEqual(distTags.map((call) => call.slice(2, 5)), [
    ["add", `@photon-hq/adapter-core@0.3.0${SUFFIX}`, "staging"],
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
    "file outside the release": [(m) => { m.packages[0].staging.file = "../escape.tgz"; }, /file/],
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
  assert.deepEqual(commands(fake.calls, "npm", "dist-tag").filter((call) => call[2] === "add").map((call) => call[3]), [`@photon-hq/adapter-core@0.3.0${SUFFIX}`]);
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
  assert.deepEqual(await dependencyFindings(candidates, "@photon-hq/", fake.registry), []);
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
  const findings = await dependencyFindings(blocked, "@photon-hq/", fake.registry);
  assert.equal(findings.length, 6, findings.join("\n"));
  assert.ok(findings.some((finding) => finding.includes("@photon-hq/contracts@0.25.0-staging.39.1 is not an exact stable version")));
  assert.ok(findings.some((finding) => finding.includes("no published stable @photon-hq/contracts satisfies 0.25.0-staging.39.1")));
});

async function stagedWorld(options = {}) {
  packBoth(options.pack);
  for (const spec of options.crates ?? []) crate(join(root, "crates"), spec);
  const crates = (options.crates ?? []).map(({ name = "adapter" }) => name);
  const manifest = await collectBoth({ crates, crateDirectory: join(root, "crates") });
  const fake = world({ ...options.world, staging: { "@photon-hq/adapter": `1.2.0${SUFFIX}` } });
  await publishWith(fake, { crates });
  fake.calls.length = 0;
  return { manifest, fake };
}

const resolveWith = (fake, overrides = {}) =>
  resolveCandidate({
    repository: REPOSITORY,
    packageInput: "",
    tagPrefix: "",
    version: "",
    environment: "production",
    signerWorkflow: "photon-hq/buildspace/.github/workflows/npm-stage.yml",
    output: join(root, "candidate"),
    run: fake.run,
    registry: fake.registry,
    ...overrides,
  });

test("promotion resolves the current staging build and verifies each candidate's provenance", async () => {
  const { manifest, fake } = await stagedWorld();
  const { manifest: resolved, changes } = await resolveWith(fake);
  assert.deepEqual(resolved, manifest);
  assert.equal(changes, undefined);
  const attestations = commands(fake.calls, "gh", "attestation");
  assert.equal(attestations.length, 2);
  for (const flag of [["--repo", REPOSITORY], ["--signer-workflow", "photon-hq/buildspace/.github/workflows/npm-stage.yml"], ["--source-digest", SHA], ["--source-ref", "refs/heads/main"]])
    assert.equal(attestations[0][attestations[0].indexOf(flag[0]) + 1], flag[1]);

  await publishWith(fake, { directory: join(root, "candidate"), channel: "production", sourceSha: undefined, runId: "901" });
  assert.equal(fake.state.published["@photon-hq/adapter@1.2.0"], manifest.packages[1].production.integrity);
  assert.equal(fake.state.tags["v1.2.0"], SHA);
  const release = fake.state.releases["v1.2.0"];
  assert.equal(release.prerelease, false);
  assert.deepEqual(release.assets.sort(), ["photon-hq-adapter-1.2.0.tgz", "photon-hq-adapter-core-0.3.0.tgz", "release-manifest.json"]);
  assert.deepEqual(commands(fake.calls, "npm", "dist-tag").filter((call) => call[2] === "add").map((call) => call.slice(3, 5)), [
    ["@photon-hq/adapter-core@0.3.0", "latest"],
    ["@photon-hq/adapter@1.2.0", "latest"],
  ]);
});

test("promotion lists the changes since the current production release", async () => {
  const { fake } = await stagedWorld({ world: { tags: { "v1.1.0": "c".repeat(40) } } });
  fake.registry = ((registry) => async (name) => {
    const metadata = await registry(name);
    if (name === "@photon-hq/adapter") metadata["dist-tags"].latest = "1.1.0";
    return metadata;
  })(fake.registry);
  const { changes } = await resolveWith(fake, { version: `1.2.0${SUFFIX}` });
  assert.deepEqual(changes, { previousTag: "v1.1.0", total: 2, subjects: ["fix: two", "feat: one"] });
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
    const { fake } = await stagedWorld({ world: { latest: { "@photon-hq/adapter-core": "0.3.0" } } });
    await assert.rejects(resolveWith(fake), /not newer than latest 0\.3\.0/);
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
  assert.equal(manifest.formatVersion, 2);
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
  writeFileSync(join(directory, "release-manifest.json"), JSON.stringify({ formatVersion: 3, packages: [], crates: [] }));
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
  assert.deepEqual(attested.sort(), ["adapter-0.4.0.crate", "photon-hq-adapter-1.2.0.tgz", "photon-hq-adapter-core-0.3.0.tgz"]);

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
