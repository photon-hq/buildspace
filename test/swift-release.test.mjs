import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, test } from "node:test";
import { collect, formatAge, parseAge, publish, readManifest, resolveCandidate, soakSummary } from "../.github/package-release/swift-release.mjs";

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

const MANIFEST_ONLY = '// swift-tools-version: 6.2\nimport PackageDescription\n\nlet package = Package(name: "macrocosm-astrolabe")\n';

/**
 * A fake GitHub that records every command. `files` are the source commit's;
 * `repos` are the owner's other repositories, a private one readable only
 * through `dependencyRun`, which holds the dependency token. `soak` holds the
 * commits since the latest release, oldest first, with their pull requests,
 * and when each release was published.
 */
function world({ tags = {}, releases = {}, environment = ["octocat"], attested = true, onMain = true, files = { "Package.swift": MANIFEST_ONLY }, repos = {}, soak = {} } = {}) {
  const { commits = [], published = {}, forbidden = "", drafts = [], stable = [] } = soak;
  const calls = [];
  const state = { tags, releases };
  const fail = (message) => Object.assign(new Error(message), { stderr: message });
  const missing = () => fail("gh: Not Found (HTTP 404)");
  const handle = (command, args, privileged) => {
    calls.push([command, ...args]);
    const [first, second] = args;
    if (command === "gh" && first === "api") {
      const path = args.find((arg) => arg.startsWith("repos/"));
      const content = /^repos\/([^/]+\/[^/]+)\/contents\/(.+)\?ref=([a-f0-9]{40})$/.exec(path);
      if (content) {
        if (content[1] !== REPOSITORY || content[3] !== SHA || !(content[2] in files)) throw missing();
        return files[content[2]];
      }
      const [, owner, rest] = /^repos\/([^/]+\/[^/]+)(.*)$/.exec(path);
      if (owner !== REPOSITORY) {
        const repo = repos[owner];
        if (!repo || (repo.private && !privileged)) throw missing();
        if (!rest) return JSON.stringify({ full_name: owner });
        const named = /^\/(?:releases\/tags|git\/ref\/tags)\/(.+)$/.exec(rest)?.[1];
        const release = repo.releases[named];
        if (!release) throw missing();
        if (rest.startsWith("/releases/")) return JSON.stringify({ tag_name: named, draft: Boolean(release.draft), prerelease: Boolean(release.prerelease) });
        return JSON.stringify({ object: { type: "commit", sha: release.sha } });
      }
      if (path.endsWith("/environments/production")) {
        if (!environment) throw fail("gh: Not Found (HTTP 404)");
        return JSON.stringify({ protection_rules: environment.length ? [{ type: "required_reviewers", reviewers: environment }] : [] });
      }
      if (/\/git\/matching-refs\/tags\/v$/.test(path))
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
      const range = /\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})\?per_page=100&page=(\d+)$/.exec(path);
      if (range) {
        // The commits after the base (all of them for a base before the list) up to the head.
        const carried = commits.slice(commits.findIndex(({ sha }) => sha === range[1]) + 1, commits.findIndex(({ sha }) => sha === range[2]) + 1);
        const page = carried.slice((Number(range[3]) - 1) * 100, Number(range[3]) * 100);
        return JSON.stringify({ total_commits: carried.length, commits: page.map(({ sha, message = "" }) => ({ sha, commit: { message } })) });
      }
      const single = /\/commits\/([a-f0-9]{40})$/.exec(path);
      if (single) {
        const found = commits.find(({ sha }) => sha === single[1]);
        if (!found) throw missing();
        return JSON.stringify({ sha: found.sha, commit: { message: found.message ?? "" } });
      }
      const pulls = /\/commits\/([a-f0-9]{40})\/pulls$/.exec(path);
      if (pulls) {
        if (forbidden) throw fail(forbidden);
        const found = commits.find(({ sha }) => sha === pulls[1]);
        const listed = [...(found?.otherPulls ?? []), ...(found?.pull ? [found.pull] : [])];
        return JSON.stringify(listed.map((pull) => ({ merged_at: "2026-01-14T00:00:00Z", base: { ref: "main" }, ...pull, labels: (pull.labels ?? []).map((name) => ({ name })) })));
      }
      const released = /\/releases\/tags\/(.+)$/.exec(path)?.[1];
      if (released) {
        if (!state.releases[released] && !(released in published)) throw missing();
        const prerelease = !stable.includes(released) && (state.releases[released]?.prerelease ?? released.includes("-"));
        return JSON.stringify({ tag_name: released, draft: drafts.includes(released), prerelease, published_at: published[released] ?? null });
      }
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
  return { calls, state, run: (command, args) => handle(command, args, false), dependencyRun: (command, args) => handle(command, args, true) };
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

test("a release newer than the build since it was resolved stops the release before it is tagged", async () => {
  const { fake } = await staged();
  assert.equal((await resolveWith(fake)).pending, true);
  fake.state.tags["v1.28.0"] = OTHER;
  await assert.rejects(
    publishWith(fake, { directory: join(root, "candidate"), channel: "production", sourceSha: undefined }),
    new RegExp(`v1\.27\.0${SUFFIX.replaceAll(".", "\.")} cannot be released: 1\.27\.0 is not newer than the latest release 1\.28\.0`)
  );
  assert.equal(fake.state.tags["v1.27.0"], undefined);
  assert.equal(fake.state.releases["v1.27.0"], undefined);
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

const sha = (digit) => digit.repeat(40);
const RELEASED = {
  "photon-hq/SignozSwift": { releases: { "v0.4.2": { sha: sha("1") }, "v0.4.3": { sha: sha("2"), prerelease: true } } },
  "photon-hq/opentelemetry-swift": { releases: { "3.0.0": { sha: sha("3") } } },
  "photon-hq/IMAgentKit": { private: true, releases: { "v0.1.0": { sha: sha("4") } } },
  "photon-hq/Unreleased": { releases: {} },
};
const pin = (location, state) => ({ identity: location.split("/").at(-1).replace(/\.git$/, "").toLowerCase(), kind: "remoteSourceControl", location, state });
const resolvedFile = (...pins) => JSON.stringify({ originHash: "0", pins, version: 3 });
const manifestWith = (...dependencies) =>
  `// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "macrocosm-astrolabe",
    dependencies: [
${dependencies.map((line) => `        ${line},`).join("\n")}
    ]
)
`;
const contentReads = (calls) => calls.filter((call) => call.some((arg) => /\/contents\//.test(arg))).map((call) => /\/contents\/(.+)\?/.exec(call.at(-1))[1]);

test("promotion lists the production releases a package's Package.resolved pins", async () => {
  const files = {
    "Package.resolved": resolvedFile(
      pin("https://github.com/photon-hq/SignozSwift.git", { revision: sha("1"), version: "0.4.2" }),
      pin("https://github.com/photon-hq/opentelemetry-swift", { revision: sha("3"), version: "3.0.0" }),
      pin("https://github.com/apple/swift-argument-parser.git", { branch: "main", revision: sha("5") })
    ),
    "Package.swift": manifestWith('.package(url: "https://github.com/photon-hq/SignozSwift.git", branch: "main")'),
  };
  const { fake } = await staged({ world: { files, repos: RELEASED } });
  const { pending, dependencies } = await resolveWith(fake);
  assert.equal(pending, true);
  assert.deepEqual(dependencies, [
    { dependency: "photon-hq/SignozSwift", version: "0.4.2" },
    { dependency: "photon-hq/opentelemetry-swift", version: "3.0.0" },
  ]);
  assert.deepEqual(contentReads(fake.calls), ["Package.resolved"]);
  assert.ok(fake.calls.every((call) => !call.some((arg) => String(arg).includes("swift-argument-parser"))));
});

test("promotion refuses a package pinned to anything but the owner's production releases", async () => {
  const files = {
    "Package.resolved": resolvedFile(
      pin("https://github.com/photon-hq/Astrolabe", { branch: "main", revision: sha("6") }),
      pin("git@github.com:photon-hq/BetterEnv.git", { revision: sha("7") }),
      pin("https://github.com/photon-hq/SignozSwift.git", { revision: sha("1"), version: "0.4.2-staging.900.1" }),
      pin("https://github.com/photon-hq/opentelemetry-swift", { revision: sha("8"), version: "3.0.0" }),
      pin("https://github.com/photon-hq/Unreleased", { revision: sha("9"), version: "1.0.0" }),
      pin("https://github.com/photon-hq/IMAgentKit.git", { revision: sha("4"), version: "0.1.0" })
    ),
  };
  const { fake } = await staged({ world: { files, repos: { ...RELEASED, "photon-hq/SignozSwift": { releases: { "v0.4.2-staging.900.1": { sha: sha("1"), prerelease: true } } } } } });
  const error = await resolveWith(fake).catch((caught) => caught);
  assert.match(error.message, /^v1\.27\.0-staging\.900\.1 cannot be promoted until its dependencies are production releases:\n/);
  for (const finding of [
    "- Package.resolved pins photon-hq/Astrolabe to branch main; require a released version",
    `- Package.resolved pins photon-hq/BetterEnv to revision ${sha("7")}; require a released version`,
    "- Package.resolved pins photon-hq/SignozSwift at 0.4.2-staging.900.1, which is not a stable version",
    `- Package.resolved pins photon-hq/opentelemetry-swift: photon-hq/opentelemetry-swift 3.0.0 no longer names the resolved commit ${sha("8")}`,
    "- Package.resolved pins photon-hq/Unreleased: 1.0.0 is not a published release of photon-hq/Unreleased",
    "- Package.resolved pins photon-hq/IMAgentKit: photon-hq/IMAgentKit is not readable to check its releases; promote with private-deps",
  ])
    assert.ok(error.message.includes(finding), finding);
  assert.equal(error.message.split("\n").length, 7);
  const prerelease = await staged({ world: { files: { "Package.resolved": resolvedFile(pin("https://github.com/photon-hq/SignozSwift.git", { revision: sha("2"), version: "0.4.3" })) }, repos: RELEASED } });
  await assert.rejects(resolveWith(prerelease.fake), /photon-hq\/SignozSwift v0\.4\.3 is a prerelease, not a production release/);
});

test("a private dependency's releases are read with the dependency token", async () => {
  const files = { "Package.resolved": resolvedFile(pin("https://github.com/photon-hq/IMAgentKit.git", { revision: sha("4"), version: "0.1.0" })) };
  const { fake } = await staged({ world: { files, repos: RELEASED } });
  await assert.rejects(resolveWith(fake), /IMAgentKit is not readable to check its releases; promote with private-deps/);
  const { pending, dependencies } = await resolveWith(fake, { dependencyRun: fake.dependencyRun });
  assert.equal(pending, true);
  assert.deepEqual(dependencies, [{ dependency: "photon-hq/IMAgentKit", version: "0.1.0" }]);
});

test("a library, and a package without Package.resolved, are held to the requirements in Package.swift", async (t) => {
  const released = manifestWith(
    '// .package(url: "https://github.com/photon-hq/Astrolabe.git", branch: "main")',
    '/* .package(url: "https://github.com/photon-hq/BetterEnv.git", branch: "main") */ .package(url: "https://github.com/photon-hq/SignozSwift.git", from: "0.4.2")',
    '.package(url: "https://github.com/photon-hq/opentelemetry-swift", "3.0.0"..<"4.0.0")',
    '.package(url: "https://github.com/apple/swift-argument-parser.git", branch: "main")',
    '.package(path: "../Local")'
  );
  const expected = [
    { dependency: "photon-hq/SignozSwift", version: "0.4.2" },
    { dependency: "photon-hq/opentelemetry-swift", version: "3.0.0" },
  ];
  await t.test("a library ignores its Package.resolved", async () => {
    const library = { library: true };
    await collectBuild({ ...library, stagingPackage: undefined, productionPackage: undefined });
    const files = { "Package.swift": released, "Package.resolved": resolvedFile(pin("https://github.com/photon-hq/Astrolabe", { branch: "main", revision: sha("6") })) };
    const fake = world({ tags: { "v1.26.0": OTHER }, files, repos: RELEASED });
    await publishWith(fake, library);
    fake.calls.length = 0;
    assert.deepEqual((await resolveWith(fake, library)).dependencies, expected);
    assert.deepEqual(contentReads(fake.calls), ["Package.swift"]);
  });
  await t.test("a package without Package.resolved", async () => {
    const { fake } = await staged({ world: { files: { "Package.swift": released }, repos: RELEASED } });
    assert.deepEqual((await resolveWith(fake)).dependencies, expected);
    assert.deepEqual(contentReads(fake.calls), ["Package.resolved", "Package.swift"]);
  });
  for (const [name, declaration, error] of [
    ["a branch", '.package(url: "https://github.com/photon-hq/SignozSwift.git", branch: "main")', /requires photon-hq\/SignozSwift by branch or revision; require a released version/],
    ["a revision", `.package(url: "https://github.com/photon-hq/SignozSwift", revision: "${sha("1")}")`, /by branch or revision/],
    ["a staging version", '.package(url: "https://github.com/photon-hq/SignozSwift.git", exact: "0.4.2-staging.900.1")', /at 0\.4\.2-staging\.900\.1, which admits prerelease versions/],
    ["an unreleased lower bound", '.package(url: "https://github.com/photon-hq/SignozSwift.git", .upToNextMinor(from: "0.9.0"))', /0\.9\.0 is not a published release of photon-hq\/SignozSwift/],
    ["a version in a variable", '.package(url: "https://github.com/photon-hq/SignozSwift.git", from: signozVersion)', /without a version literal promotion can check/],
    ["a url in a variable", '.package(url: signozURL, from: "0.4.2")', /write the url of \.package\(url: signozURL, from: "0\.4\.2"\) as a string literal/],
  ])
    await t.test(name, async () => {
      const { fake } = await staged({ world: { files: { "Package.swift": manifestWith(declaration) }, repos: RELEASED } });
      await assert.rejects(resolveWith(fake), error);
    });
  await t.test("a commit without Package.swift", async () => {
    const { fake } = await staged({ world: { files: {} } });
    await assert.rejects(resolveWith(fake), new RegExp(`${SHA} has no Package.swift`));
  });
});

const T0 = Date.parse("2026-01-15T12:00:00Z");
const at = (minutes) => new Date(T0 + minutes * 60_000).toISOString();
const C1 = sha("1");
const C2 = sha("2");
const OWN = `v1.27.0${SUFFIX}`;
const EARLIER = "v1.27.0-staging.850.1";

/**
 * Two changes since v1.26.0: #95 at C1, staged as EARLIER at T0, and #96 at
 * SHA, the candidate, staged 50 minutes later.
 */
const soaking = ({ labels = {}, published = {}, commits, ...rest } = {}) =>
  staged({
    world: {
      tags: { "v1.26.0": OTHER, [EARLIER]: C1 },
      soak: {
        commits: commits ?? [
          { sha: C1, message: "fix: drain the queue\n\nbody", pull: { number: 95, title: "fix: drain the queue", labels: labels[95] } },
          { sha: SHA, message: "feat: stage every main push", pull: { number: 96, title: "feat: stage every main push", labels: labels[96] } },
        ],
        published: { "v1.26.0": at(-600), [EARLIER]: at(0), [OWN]: at(50), ...published },
        ...rest,
      },
    },
  });
const soakWith = (fake, minutes, overrides = {}) => resolveWith(fake, { minimumAge: "1h", now: T0 + minutes * 60_000, ...overrides });

test("promotion waits until every change since the latest release has run on staging for the minimum age", async () => {
  const { fake } = await soaking();
  const error = await soakWith(fake, 90).catch((caught) => caught);
  assert.match(error.message, new RegExp(`${OWN.replaceAll(".", "\\.")}: some changes were on staging for less than the minimum time:`));
  assert.match(error.message, /\n- #96 feat: stage every main push: on staging 40m, minimum 1h\n/);
  assert.match(error.message, /To promote now, set skip-minimum-age-reason\.$/);
  assert.doesNotMatch(error.message, /#95/);
  assert.deepEqual(error.soak.changes.map(({ pull, age }) => [pull.number, age / 60_000]), [[95, 90], [96, 40]]);

  const { pending, soak, overridden } = await soakWith(fake, 111);
  assert.equal(pending, true);
  assert.equal(overridden, false);
  assert.deepEqual(soak.waiting, []);
});

test("before the first release, the build's own commit is the change, named by its subject", async () => {
  const { fake } = await staged({
    world: {
      tags: { [EARLIER]: C1 },
      soak: { commits: [{ sha: SHA, message: "feat: first build\n\nbody" }], published: { [OWN]: at(0) } },
    },
  });
  const error = await soakWith(fake, 30).catch((caught) => caught);
  assert.match(error.message, new RegExp(`- ${SHA.slice(0, 12)} feat: first build: on staging 30m, minimum 1h`));
  assert.equal(error.soak.changes.length, 1);
});

test("a pull request's min-staging-age label lengthens its own change's wait and never shortens it", async () => {
  const { fake } = await soaking({ labels: { 95: ["bug", "min-staging-age:3h"], 96: ["min-staging-age:10m"] } });
  const error = await soakWith(fake, 120).catch((caught) => caught);
  assert.match(error.message, /- #95 fix: drain the queue: on staging 2h, minimum 3h \(PR label\)/);
  assert.doesNotMatch(error.message, /#96/);
  assert.deepEqual(error.soak.changes.map(({ required, declared }) => [required / 60_000, declared]), [[180, "min-staging-age:3h"], [60, null]]);
  assert.equal((await soakWith(fake, 180)).soak.waiting.length, 0);
});

test("a change's clock starts with the first staging release that carries it", async (t) => {
  await t.test("a commit whose own stage published nothing rides in the next build", async () => {
    const { fake } = await soaking({
      commits: [
        { sha: C1, pull: { number: 95, title: "fix: drain the queue" } },
        { sha: C2, pull: { number: 97, title: "docs: explain the queue" } },
        { sha: SHA, pull: { number: 96, title: "feat: stage every main push" } },
      ],
    });
    const { soak } = await soakWith(fake, 200);
    assert.deepEqual(soak.changes.map(({ sha, since }) => [sha, since]), [[C1, T0], [C2, T0 + 50 * 60_000], [SHA, T0 + 50 * 60_000]]);
  });
  await t.test("a pull request merged with its own commits is one change, as late as its last commit", async () => {
    const pull = { number: 95, title: "fix: drain the queue" };
    const { fake } = await soaking({
      commits: [
        { sha: C1, pull },
        { sha: C2, pull },
        { sha: SHA, pull: { number: 96, title: "feat: stage every main push" } },
      ],
      published: { "v1.27.0-staging.870.1": at(20) },
    });
    fake.state.tags["v1.27.0-staging.870.1"] = C2;
    const { soak } = await soakWith(fake, 200);
    assert.deepEqual(soak.changes.map(({ sha, pull, since }) => [sha, pull.number, since]), [[C2, 95, T0 + 20 * 60_000], [SHA, 96, T0 + 50 * 60_000]]);
  });
  await t.test("staging releases published before the latest release do not count", async () => {
    const { fake } = await soaking({ published: { "v1.26.0": at(30) } });
    const { soak } = await soakWith(fake, 200);
    assert.deepEqual(soak.changes.map(({ since }) => since), [T0 + 50 * 60_000, T0 + 50 * 60_000]);
  });
  await t.test("a change no counted staging release carries has not started", async () => {
    const { fake } = await soaking({ published: { "v1.26.0": at(60) } });
    const error = await soakWith(fake, 600).catch((caught) => caught);
    assert.match(error.message, /#95 fix: drain the queue: on staging none, minimum 1h/);
  });
});

const SKIP_NOTE = "Promoted without a check of the time on staging.";
/** The GitHub reads only the staging age check makes. */
const soakReads = (calls) => calls.filter((call) => call.some((arg) => /\/pulls$|\?per_page=100&page=|\/releases\/tags\//.test(arg)));

test("a reason skips the check without reading GitHub for it, and the release notes keep the reason", async () => {
  const { fake } = await soaking();
  const reason = "hotfix for a crash";
  const { pending, overridden, soak } = await soakWith(fake, 60, { skipMinimumAge: `  ${reason}  ` });
  assert.equal(pending, true);
  assert.equal(overridden, true);
  assert.equal(soak, undefined);
  assert.deepEqual(soakReads(fake.calls), []);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "candidate", "staging-age-override.json"), "utf8")), { reason });
  await publishWith(fake, { directory: join(root, "candidate"), channel: "production", sourceSha: undefined });
  const notes = fake.state.releases["v1.27.0"].notes;
  assert.equal(notes.split(`${SKIP_NOTE} Reason: ${reason}`).length, 2);
});

test("without a reason, the release notes say nothing about a skip", async () => {
  const { fake } = await soaking();
  assert.equal((await soakWith(fake, 200)).overridden, false);
  assert.throws(() => readFileSync(join(root, "candidate", "staging-age-override.json")), { code: "ENOENT" });
  await publishWith(fake, { directory: join(root, "candidate"), channel: "production", sourceSha: undefined });
  assert.ok(!fake.state.releases["v1.27.0"].notes.includes(SKIP_NOTE));
});

/** v1.26.1 released at minute 120, between resolution and approval; LATER restages the candidate at minute 130. */
const LATER = "v1.27.0-staging.950.1";
const publishedLater = { "v1.26.1": at(120), [LATER]: at(130) };
const promoteWith = (fake, minutes) =>
  publishWith(fake, { directory: join(root, "candidate"), channel: "production", sourceSha: undefined, now: T0 + minutes * 60_000 });

test("a release between resolution and approval makes publishing check the time on staging again", async () => {
  const { fake } = await soaking({ published: publishedLater });
  assert.equal((await soakWith(fake, 111)).overridden, false);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "candidate", "staging-age-check.json"), "utf8")), { baseline: "v1.26.0", minimum: 3_600_000 });
  fake.state.tags["v1.26.1"] = OTHER;
  const error = await promoteWith(fake, 150).catch((caught) => caught);
  assert.match(error.message, /the time on staging was measured from v1\.26\.0, and v1\.26\.1 has been released since, so it was checked again from v1\.26\.1\./);
  assert.match(error.message, /\n- #95 fix: drain the queue: on staging none, minimum 1h\n- #96 feat: stage every main push: on staging none, minimum 1h\n/);
  assert.match(error.message, /To promote now, run the promotion again with skip-minimum-age-reason\.$/);
  assert.equal(fake.state.tags["v1.27.0"], undefined);
  assert.equal(fake.state.releases["v1.27.0"], undefined);

  // A later staging build carries both changes; their time counts from it.
  fake.state.tags[LATER] = SHA;
  await assert.rejects(promoteWith(fake, 189), /- #96 feat: stage every main push: on staging 59m, minimum 1h\n/);
  await promoteWith(fake, 190);
  assert.equal(fake.state.tags["v1.27.0"], SHA);
});

test("publishing reads no pull requests while the release resolution measured from is still the latest", async () => {
  const { fake } = await soaking();
  await soakWith(fake, 111);
  fake.calls.length = 0;
  await promoteWith(fake, 112);
  assert.deepEqual(soakReads(fake.calls), []);
  assert.equal(fake.state.tags["v1.27.0"], SHA);
});

test("a skip reason recorded at resolution also covers a release between resolution and approval", async () => {
  const { fake } = await soaking({ published: publishedLater });
  await soakWith(fake, 60, { skipMinimumAge: "hotfix" });
  assert.throws(() => readFileSync(join(root, "candidate", "staging-age-check.json")), { code: "ENOENT" });
  fake.state.tags["v1.26.1"] = OTHER;
  await promoteWith(fake, 150);
  assert.ok(fake.state.releases["v1.27.0"].notes.includes(`${SKIP_NOTE} Reason: hotfix`));
});

test("a library, and a caller that sets no minimum, skip the staging age", async () => {
  const { fake } = await soaking();
  await resolveWith(fake);
  assert.equal(fake.calls.filter((call) => call.some((arg) => /\/pulls$/.test(arg))).length, 0);

  const library = { library: true };
  await collectBuild({ ...library, stagingPackage: undefined, productionPackage: undefined });
  const libraryWorld = world({ tags: { "v1.26.0": OTHER } });
  await publishWith(libraryWorld, library);
  libraryWorld.calls.length = 0;
  assert.equal((await resolveWith(libraryWorld, { ...library, minimumAge: "1d", now: T0 })).soak, undefined);
  assert.equal(libraryWorld.calls.filter((call) => call.some((arg) => /\/pulls$/.test(arg))).length, 0);
});

test("a refused pull request read is reported by its cause", async (t) => {
  await t.test("a missing permission names the permission", async () => {
    const { fake } = await soaking({ forbidden: "gh: Resource not accessible by integration (HTTP 403)" });
    await assert.rejects(soakWith(fake, 200), /GitHub refused access to the pull requests of .*\. Give the promote job pull-requests: read\./);
  });
  await t.test("rate limiting asks for a rerun", async () => {
    const { fake } = await soaking({ forbidden: "gh: API rate limit exceeded for installation ID 1. (HTTP 403)" });
    await assert.rejects(soakWith(fake, 200), (error) => /rate limit stopped access .* Try again later\./.test(error.message) && !/pull-requests: read/.test(error.message));
  });
  await t.test("any other refusal is passed on unchanged", async () => {
    const { fake } = await soaking({ forbidden: "gh: Must have admin rights to Repository. (HTTP 403)" });
    await assert.rejects(soakWith(fake, 200), (error) => error.message.includes(": cannot check the time on staging. gh: Must have admin rights to Repository. (HTTP 403)\n"));
  });
});

test("the reviewer's summary shows each change's time on staging and its minimum", async () => {
  const { fake } = await soaking({ labels: { 95: ["min-staging-age:3h"] } });
  const { soak } = await soakWith(fake, 200);
  assert.deepEqual(soakSummary(soak, "A note."), [
    "### Time on staging",
    "",
    "A note.",
    "",
    "| Change | On staging | Minimum |",
    "| --- | --- | --- |",
    "| #95 fix: drain the queue | 3h 20m | 3h (PR label) |",
    "| #96 feat: stage every main push | 2h 30m | 1h |",
    "",
  ]);
  assert.deepEqual(soakSummary(undefined, "Cannot check."), ["### Time on staging", "", "Cannot check.", ""]);
});

test("ages are minutes, hours or days", () => {
  assert.equal(parseAge("30m"), 30 * 60_000);
  assert.equal(parseAge("2h"), 2 * 3_600_000);
  assert.equal(parseAge("1d"), 86_400_000);
  assert.equal(parseAge("0m"), 0);
  for (const bad of ["2", "2 hours", "1.5h", "-1h", "01h", ""]) assert.throws(() => parseAge(bad), /Invalid minimum staging age/, bad);
  assert.equal(formatAge(0), "0m");
  assert.equal(formatAge(89 * 60_000 + 59_000), "1h 29m");
  assert.equal(formatAge(89 * 60_000 + 1_000, Math.ceil), "1h 30m");
  assert.equal(formatAge(26 * 3_600_000), "1d 2h");
});

test("an unreadable label age stops promotion instead of being ignored", async () => {
  const { fake } = await soaking({ labels: { 95: ["min-staging-age:a while"] } });
  await assert.rejects(soakWith(fake, 200), /Invalid minimum staging age "a while"/);
  assert.equal((await soakWith(fake, 200, { skipMinimumAge: "hotfix" })).overridden, true);
});

test("promotion refuses when the latest release has no publish time to measure from", async () => {
  const { fake } = await soaking({ published: { "v1.26.0": undefined } });
  delete fake.state.releases["v1.26.0"];
  await assert.rejects(soakWith(fake, 600), (error) =>
    error.message.endsWith(": cannot check the time on staging. v1.26.0 has no published GitHub release.\nTo promote now, set skip-minimum-age-reason.") &&
    error.unchecked === "v1.26.0 has no published GitHub release."
  );
});

test("only published staging prereleases after the latest release start a clock", async (t) => {
  const clocks = async (soak) => {
    const { fake } = await soaking(soak);
    return (await soakWith(fake, 200)).soak.changes.map(({ since }) => (since - T0) / 60_000);
  };
  await t.test("a draft", async () => assert.deepEqual(await clocks({ drafts: [EARLIER] }), [50, 50]));
  await t.test("a release that is not a prerelease", async () => assert.deepEqual(await clocks({ stable: [EARLIER] }), [50, 50]));
  await t.test("a release published at the same moment as the latest release", async () =>
    assert.deepEqual(await clocks({ published: { "v1.26.0": at(0) } }), [50, 50]));
  await t.test("a published prerelease after the latest release", async () => assert.deepEqual(await clocks({}), [0, 50]));
});

test("a change that has been on staging exactly the minimum is ready", async () => {
  const { fake } = await soaking();
  // #96 reached staging at minute 50; the minimum is 1h.
  assert.equal((await soakWith(fake, 110)).soak.waiting.length, 0);
  await assert.rejects(soakWith(fake, 109), /- #96 feat: stage every main push: on staging 59m, minimum 1h\n/);
});

test("every page of a long range of commits is checked", async () => {
  const many = Array.from({ length: 149 }, (_, index) => ({ sha: `c${index.toString(16)}`.padStart(40, "0"), message: `fix: change ${index}` }));
  const { fake } = await soaking({ commits: [...many, { sha: SHA, message: "feat: stage every main push" }] });
  const { soak } = await soakWith(fake, 200);
  assert.equal(soak.changes.length, 150);
  assert.equal(fake.calls.filter((call) => call.some((arg) => /\?per_page=100&page=2$/.test(arg))).length, 1);
});

test("a pull request that was never merged declares nothing", async () => {
  const { fake } = await soaking({
    commits: [
      { sha: C1, otherPulls: [{ number: 90, title: "wip", merged_at: null, labels: ["min-staging-age:3h"] }], pull: { number: 95, title: "fix: drain the queue" } },
      { sha: SHA, pull: { number: 96, title: "feat: stage every main push" } },
    ],
  });
  assert.deepEqual((await soakWith(fake, 200)).soak.changes.map(({ pull, required }) => [pull.number, required / 60_000]), [[95, 60], [96, 60]]);
});

test("a build released again after a rollback is measured from the release before it", async () => {
  const { fake } = await soaking();
  // v1.27.0 was released from this build, then rolled back by marking it a prerelease.
  fake.state.tags["v1.27.0"] = SHA;
  fake.state.releases["v1.27.0"] = { prerelease: true, assets: [] };
  const { pending, soak } = await soakWith(fake, 200);
  assert.equal(pending, true);
  assert.deepEqual(soak.changes.map(({ sha }) => sha), [C1, SHA]);
});

test("a staging tag whose release was never published is skipped", async () => {
  // A stage run that failed between tagging and releasing leaves a tag with no release.
  const { fake } = await soaking();
  fake.state.tags["v1.27.0-staging.860.1"] = C1;
  const { soak } = await soakWith(fake, 200);
  assert.deepEqual(soak.changes.map(({ since }) => (since - T0) / 60_000), [0, 50]);
});

test("a branch merged into main without a pull request waits for its merge commit's build", async () => {
  const SIDE = sha("3");
  // Listed by date, the side commit sits before a main commit that was staged early but doesn't carry it.
  const { fake } = await soaking({
    commits: [
      { sha: SIDE, message: "fix: side work" },
      { sha: C1, pull: { number: 95, title: "fix: drain the queue" } },
      { sha: SHA, message: "Merge branch 'side'" },
    ],
  });
  const error = await soakWith(fake, 100).catch((caught) => caught);
  assert.match(error.message, new RegExp(`- ${SHA.slice(0, 12)} Merge branch 'side': on staging 50m, minimum 1h\n`));
});

test("a labelled pull request merged with a merge commit waits for the merge commit's build", async () => {
  const SIDE = sha("3");
  const pull = { number: 97, title: "fix: risky side work", labels: ["min-staging-age:3h"] };
  // The side commit sits before a main commit staged early that doesn't carry it, so its own row starts too early.
  const { fake } = await soaking({
    commits: [
      { sha: SIDE, pull },
      { sha: C1, pull: { number: 95, title: "fix: drain the queue" } },
      { sha: SHA, pull },
    ],
  });
  // At minute 200 the side commit's early row has its 3h; the merge commit's build has had only 2h 30m.
  const error = await soakWith(fake, 200).catch((caught) => caught);
  assert.match(error.message, /\n- #97 fix: risky side work: on staging 2h 30m, minimum 3h \(PR label\)\n/);
});

test("a reason gets past anything that would stop the check", async (t) => {
  await t.test("a latest release with nothing to measure from", async () => {
    const { fake } = await soaking({ published: { "v1.26.0": undefined } });
    assert.equal((await soakWith(fake, 600, { skipMinimumAge: "hotfix" })).overridden, true);
  });
  await t.test("an invalid minimum", async () => {
    const { fake } = await soaking();
    await assert.rejects(soakWith(fake, 600, { minimumAge: "2 hours" }), /cannot check the time on staging\. Invalid minimum staging age "2 hours".*\nTo promote now, set skip-minimum-age-reason\./s);
    assert.equal((await soakWith(fake, 600, { minimumAge: "2 hours", skipMinimumAge: "hotfix" })).overridden, true);
  });
  await t.test("a refused pull request read", async () => {
    const { fake } = await soaking({ forbidden: "gh: Resource not accessible by integration (HTTP 403)" });
    assert.equal((await soakWith(fake, 600, { skipMinimumAge: "hotfix" })).overridden, true);
  });
});

test("an empty minimum, as the workflow passes it, means the 2h default", async () => {
  const { fake } = await soaking();
  // #96 has 70m on staging: enough for a 1h minimum, not for 2h.
  assert.equal((await soakWith(fake, 120)).overridden, false);
  const error = await soakWith(fake, 120, { minimumAge: "" }).catch((caught) => caught);
  assert.match(error.message, /- #96 feat: stage every main push: on staging 1h 10m, minimum 2h\n/);
});

test("only the pull request that merged a change into main declares its age", async () => {
  const { fake } = await soaking({
    commits: [
      {
        sha: C1,
        // Stacked: first merged into a feature branch under another pull request.
        otherPulls: [{ number: 90, title: "wip: drain the queue", base: { ref: "feature" }, labels: ["min-staging-age:3h"] }],
        pull: { number: 95, title: "fix: drain the queue" },
      },
      { sha: SHA, pull: { number: 96, title: "feat: stage every main push" } },
    ],
  });
  const { soak } = await soakWith(fake, 200);
  assert.deepEqual(soak.changes.map(({ pull, required }) => [pull.number, required / 60_000]), [[95, 60], [96, 60]]);
});

test("a skip reason that starts with a dash is read as the reason, not an option", () => {
  const script = new URL("../.github/package-release/swift-release.mjs", import.meta.url).pathname;
  // An unknown command fails after the arguments parse; a parse failure would name the option instead.
  const run = (args) => {
    try {
      execFileSync(process.execPath, [script, "no-such-command", ...args], { encoding: "utf8", stdio: "pipe" });
    } catch (error) {
      return error.stderr;
    }
  };
  assert.match(run(["--skip-minimum-age-reason=- fix a crash"]), /Usage: swift-release\.mjs/);
  assert.match(run(["--skip-minimum-age-reason", "- fix a crash"]), /ERR_PARSE_ARGS_INVALID_OPTION_VALUE|ambiguous/);
});
