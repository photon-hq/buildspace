import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { SHA, OTHER, setUp, tearDown, sha, world, collectBuild, publishWith, resolveWith, staged } from "./fixtures/swift-release.mjs";

beforeEach(setUp);
afterEach(tearDown);

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
    { repository: "photon-hq/SignozSwift", release: "v0.4.2", source: "Package.resolved" },
    { repository: "photon-hq/opentelemetry-swift", release: "3.0.0", source: "Package.resolved" },
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
  assert.deepEqual(dependencies, [{ repository: "photon-hq/IMAgentKit", release: "v0.1.0", source: "Package.resolved" }]);
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
    { repository: "photon-hq/SignozSwift", release: "v0.4.2", source: "Package.swift" },
    { repository: "photon-hq/opentelemetry-swift", release: "3.0.0", source: "Package.swift" },
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
  await t.test("a payload-only package, from a commit without Package.swift, has no dependencies", async () => {
    const { fake } = await staged({ world: { files: {} } });
    const { pending, dependencies } = await resolveWith(fake);
    assert.equal(pending, true);
    assert.deepEqual(dependencies, []);
  });
  await t.test("a library from a commit without Package.swift", async () => {
    const library = { library: true };
    await collectBuild({ ...library, stagingPackage: undefined, productionPackage: undefined });
    const fake = world({ tags: { "v1.26.0": OTHER }, files: {} });
    await publishWith(fake, library);
    await assert.rejects(resolveWith(fake, library), new RegExp(`${SHA} has no Package.swift`));
  });
});

const LIST = ".github/required-releases.txt";
const REQUIRED = {
  "photon-hq/remotegate": { latest: "v0.1.0", releases: { "v0.1.0": { sha: sha("1"), assets: ["remotegate.pkg"] } } },
  "photon-hq/prism": { latest: "v2.0.3-rc.23", releases: { "v2.0.3-rc.23": { sha: sha("2"), assets: ["prism.pkg"] } } },
  "photon-hq/staging-only": { releases: { "v0.2.0-staging.5.1": { sha: sha("3"), prerelease: true } } },
  "photon-hq/archive": { latest: "v1.0.0", releases: { "v1.0.0": { sha: sha("4"), assets: ["archive.zip"] } } },
  "photon-hq/agent": { private: true, latest: "v0.3.0", releases: { "v0.3.0": { sha: sha("5"), assets: ["agent.pkg"] } } },
};

test("promotion lists each required repository's latest release beside the SwiftPM dependencies", async () => {
  const files = {
    "Package.resolved": resolvedFile(pin("https://github.com/photon-hq/SignozSwift.git", { revision: sha("1"), version: "0.4.2" })),
    [LIST]: "# Installed by production hosts\nphoton-hq/remotegate *.pkg\n\n  photon-hq/prism prism.pkg  # GitHub's latest, though its tag reads like a prerelease\n",
  };
  const { fake } = await staged({ world: { files, repos: { ...RELEASED, ...REQUIRED } } });
  const { dependencies } = await resolveWith(fake, { requiredReleases: LIST });
  assert.deepEqual(dependencies, [
    { repository: "photon-hq/SignozSwift", release: "v0.4.2", source: "Package.resolved" },
    { repository: "photon-hq/remotegate", release: "v0.1.0", source: LIST },
    { repository: "photon-hq/prism", release: "v2.0.3-rc.23", source: LIST },
  ]);
});

test("promotion reports the SwiftPM and required-release findings together", async () => {
  const files = {
    "Package.resolved": resolvedFile(pin("https://github.com/photon-hq/Astrolabe", { branch: "main", revision: sha("6") })),
    [LIST]: ["photon-hq/staging-only", "photon-hq/archive *.pkg", "remotegate", "photon-hq/prism *.pkg extra", "photon-hq/remotegate *.pkg"].join("\n"),
  };
  const { fake } = await staged({ world: { files, repos: { ...RELEASED, ...REQUIRED } } });
  const error = await resolveWith(fake, { requiredReleases: LIST }).catch((caught) => caught);
  assert.match(error.message, /^v1\.27\.0-staging\.900\.1 cannot be promoted until its dependencies are production releases:\n/);
  for (const finding of [
    "- Package.resolved pins photon-hq/Astrolabe to branch main; require a released version",
    `- ${LIST} requires photon-hq/staging-only: photon-hq/staging-only has no production release; promote it first`,
    `- ${LIST} requires photon-hq/archive: photon-hq/archive v1.0.0 has no asset matching *.pkg`,
    `- ${LIST} line 3: write owner/repository, optionally followed by an asset pattern`,
    `- ${LIST} line 4: write owner/repository, optionally followed by an asset pattern`,
  ])
    assert.ok(error.message.includes(finding), finding);
  assert.ok(!error.message.includes("photon-hq/remotegate"));
});

test("a private required repository's releases are read with the dependency token", async () => {
  const files = { [LIST]: "photon-hq/agent *.pkg\n" };
  const { fake } = await staged({ world: { files, repos: REQUIRED } });
  await assert.rejects(resolveWith(fake, { requiredReleases: LIST }), /photon-hq\/agent is not readable to check its releases; promote with private-deps/);
  const { dependencies } = await resolveWith(fake, { requiredReleases: LIST, dependencyRun: fake.dependencyRun });
  assert.deepEqual(dependencies, [{ repository: "photon-hq/agent", release: "v0.3.0", source: LIST }]);
});

test("a build is refused when its list of required releases is missing or names no repository", async (t) => {
  await t.test("a commit without the list", async () => {
    const { fake } = await staged({ world: { repos: REQUIRED } });
    await assert.rejects(resolveWith(fake, { requiredReleases: LIST }), new RegExp(`${SHA} has no \\.github/required-releases\\.txt to read its required releases from`));
  });
  await t.test("a list of only comments and blank lines", async () => {
    const { fake } = await staged({ world: { files: { [LIST]: "# Installed by production hosts\n\n" }, repos: REQUIRED } });
    await assert.rejects(resolveWith(fake, { requiredReleases: LIST }), /\.github\/required-releases\.txt names no repository/);
  });
});
