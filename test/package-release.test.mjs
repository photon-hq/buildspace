import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import {
  ciStatus,
  dependencyFindings,
  publishOrder,
  waitForCi,
} from "../.github/package-release/package-release.mjs";
import {
  SHA,
  SUFFIX,
  REPOSITORY,
  BUMP,
  fixturePath,
  setUp,
  tearDown,
  pack,
  packBoth,
  collectBoth,
  world,
  commands,
  publishWith,
} from "./fixtures/package-release.mjs";
import { registerPromotionCases } from "./package-release-promotion.cases.mjs";

beforeEach(setUp);

afterEach(tearDown);

test("collect orders dependencies first and names the build after the repository's package", async () => {
  packBoth();
  const manifest = await collectBoth();
  assert.deepEqual(
    manifest.packages.map(({ name }) => name),
    ["@photon-hq/adapter-core", "@photon-hq/adapter"]
  );
  assert.equal(manifest.stagingTag, `adapter-staging-1.2.0${SUFFIX}`);
  assert.equal(manifest.productionTag, "v1.2.0");
  assert.equal(manifest.formatVersion, 3);
  assert.deepEqual(manifest.bump, BUMP);
  const [core] = manifest.packages;
  assert.equal(core.staging.version, `1.2.0${SUFFIX}`);
  assert.equal(core.production.version, "1.2.0");

  const bytes = readFileSync(fixturePath("release", core.production.file));

  assert.equal(
    core.production.sha256,
    createHash("sha256").update(bytes).digest("hex")
  );
  assert.match(core.production.integrity, /^sha512-/);
  assert.deepEqual(
    JSON.parse(
      readFileSync(fixturePath("release/release-manifest.json"), "utf-8")
    ),
    manifest
  );
});

test("collect honours an explicit package and tag prefix", async () => {
  packBoth();

  const manifest = await collectBoth({
    packageInput: "@photon-hq/adapter-core",
    tagPrefix: "core-staging-",
  });

  assert.equal(manifest.stagingTag, `core-staging-1.2.0${SUFFIX}`);
  assert.equal(manifest.productionTag, "v1.2.0");
});

test("collect names the production tag after a prefix where vX.Y.Z is taken", async () => {
  packBoth();

  const manifest = await collectBoth({
    packageInput: "@photon-hq/adapter-core",
    tagPrefix: "core-staging-",
    productionTagPrefix: "core-v",
  });

  assert.equal(manifest.stagingTag, `core-staging-1.2.0${SUFFIX}`);
  assert.equal(manifest.productionTag, "core-v1.2.0");

  for (const productionTagPrefix of [
    "core-",
    "Core-v",
    "-v",
    "core v",
    "refs/tags/v",
  ]) {
    await assert.rejects(
      collectBoth({ productionTagPrefix }),
      /Invalid production tag prefix/
    );
  }
});

test("collect refuses packs that do not describe one build", async (t) => {
  const cases = {
    "staging version without the run suffix": () =>
      packBoth({ suffix: "-staging.899.1" }),
    "packed at another version than the release version": () =>
      packBoth({ adapter: "1.3.0" }),
    "a package at a version of its own": () => packBoth({ core: "0.3.0" }),
    "prerelease production candidate": () => {
      pack(fixturePath("staging"), {
        name: "@photon-hq/adapter",
        version: `1.0.0-rc.1${SUFFIX}`,
      });
      pack(fixturePath("production"), {
        name: "@photon-hq/adapter",
        version: "1.0.0-rc.1",
      });
    },
    "different packages per channel": () => {
      pack(fixturePath("staging"), {
        name: "@photon-hq/adapter",
        version: `1.0.0${SUFFIX}`,
      });
      pack(fixturePath("staging"), {
        name: "@photon-hq/extra",
        version: `1.0.0${SUFFIX}`,
      });
      pack(fixturePath("production"), {
        name: "@photon-hq/adapter",
        version: "1.0.0",
      });
    },
    "another scope": () => {
      pack(fixturePath("staging"), {
        name: "@other/adapter",
        version: `1.0.0${SUFFIX}`,
      });
      pack(fixturePath("production"), {
        name: "@other/adapter",
        version: "1.0.0",
      });
    },
    "no package named after the repository": () => {
      pack(fixturePath("staging"), {
        name: "@photon-hq/other",
        version: `1.0.0${SUFFIX}`,
      });
      pack(fixturePath("production"), {
        name: "@photon-hq/other",
        version: "1.0.0",
      });
    },
    "empty pack": () => {
      pack(fixturePath("staging"), {
        name: "@photon-hq/adapter",
        version: `1.0.0${SUFFIX}`,
      });
      mkdirSync(fixturePath("production"));
    },
  };

  for (const [name, arrange] of Object.entries(cases)) {
    await t.test(name, async () => {
      rmSync(fixturePath(), { recursive: true, force: true });
      mkdirSync(fixturePath());
      arrange();
      await assert.rejects(collectBoth());
    });
  }

  await t.test("no release version", async () => {
    rmSync(fixturePath(), { recursive: true, force: true });
    mkdirSync(fixturePath());
    packBoth();
    await assert.rejects(
      collectBoth({ bump: null }),
      /Invalid release version/
    );
    await assert.rejects(
      collectBoth({ bump: { ...BUMP, level: "huge" } }),
      /Invalid release version: level huge/
    );
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

  const status = (runs) =>
    ciStatus({ workflow_runs: runs }, { sha: SHA, workflow: "ci.yml" });

  assert.equal(status([]), "pending");
  assert.equal(
    status([run({ status: "in_progress", conclusion: null })]),
    "pending"
  );
  assert.equal(status([run()]), "success");
  assert.equal(
    status([
      run({ event: "pull_request" }),
      run({ head_branch: "feature" }),
      run({ path: ".github/workflows/other.yml" }),
    ]),
    "pending"
  );
  assert.throws(
    () => status([run(), run({ id: 2, conclusion: "failure" })]),
    /concluded failure/
  );
  assert.equal(
    status([run({ conclusion: "failure" }), run({ id: 2 })]),
    "success"
  );
});

test("waiting for CI polls until success and times out otherwise", async () => {
  let clock = 0;

  const responses = [
    [],
    [
      {
        id: 1,
        path: ".github/workflows/ci.yml",
        head_sha: SHA,
        head_branch: "main",
        event: "push",
        status: "completed",
        conclusion: "success",
      },
    ],
  ];

  await waitForCi({
    repository: REPOSITORY,
    sha: SHA,
    workflow: "ci.yml",
    timeoutMs: 60_000,
    run: () => JSON.stringify({ workflow_runs: responses.shift() }),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
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
      sleep: async (ms) => {
        clock += ms;
      },
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
  assert.deepEqual(
    commands(fake.calls, "npm", "publish").map((call) => call.at(-3)),
    ["candidate-900-2", "candidate-900-2"]
  );
  assert.match(
    commands(fake.calls, "npm", "publish")[0][2],
    /adapter-core-1\.2\.0-staging/
  );
  assert.equal(fake.state.tags[tag], SHA);
  const release = fake.state.releases[tag];
  assert.equal(release.prerelease, true);
  assert.equal(release.title, `@photon-hq/adapter 1.2.0${SUFFIX}`);
  assert.deepEqual(release.assets.toSorted(), [
    "photon-hq-adapter-1.2.0-staging.900.1.tgz",
    "photon-hq-adapter-1.2.0.tgz",
    "photon-hq-adapter-core-1.2.0-staging.900.1.tgz",
    "photon-hq-adapter-core-1.2.0.tgz",
    "release-manifest.json",
  ]);
  assert.match(release.notes, /staging-version: 1\.2\.0-staging\.900\.1/);
  assert.ok(
    release.notes.includes(
      "### Version `1.2.0`\n\nA minor release after [`v1.1.0`](https://github.com/photon-hq/adapter/releases/tag/v1.1.0)."
    )
  );
  assert.ok(
    release.notes.includes(
      "- **minor** feat: one ([#7](https://github.com/photon-hq/adapter/pull/7))"
    )
  );
  const distTags = commands(fake.calls, "npm", "dist-tag");
  assert.deepEqual(
    distTags.map((call) => call.slice(2, 5)),
    [
      ["add", `@photon-hq/adapter-core@1.2.0${SUFFIX}`, "staging"],
      ["add", `@photon-hq/adapter@1.2.0${SUFFIX}`, "staging"],
      ["rm", "@photon-hq/adapter-core", "candidate-900-2"],
      ["rm", "@photon-hq/adapter", "candidate-900-2"],
    ]
  );
});

test("a retried publication accepts its own earlier work and finishes it", async () => {
  packBoth();
  const manifest = await collectBoth();
  const [core] = manifest.packages;

  const fake = world({
    published: {
      [`@photon-hq/adapter-core@${core.staging.version}`]:
        core.staging.integrity,
    },
    tags: { [manifest.stagingTag]: SHA },
    releases: {
      [manifest.stagingTag]: { prerelease: true, assets: [core.staging.file] },
    },
  });

  await publishWith(fake, { runAttempt: "3" });
  assert.equal(commands(fake.calls, "npm", "publish").length, 1);
  assert.equal(
    fake.calls.some((call) => call.includes("--method")),
    false
  );
  assert.equal(
    commands(fake.calls, "gh", "release").filter((call) => call[2] === "upload")
      .length,
    1
  );
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

    const fake = world({
      published: {
        [`@photon-hq/adapter-core@${core.staging.version}`]: "sha512-other",
      },
    });

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
    writeFileSync(fixturePath("release", core.production.file), "tampered");
    const fake = world();
    await assert.rejects(publishWith(fake), /does not match/);
    assert.equal(fake.calls.length, 0);
  });
});

test("the publishing job trusts no manifest claim the files and run do not support", async (t) => {
  const forge = async (edit) => {
    packBoth();
    await collectBoth();
    const path = fixturePath("release/release-manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf-8"));
    edit(manifest);
    writeFileSync(path, JSON.stringify(manifest));
  };

  const cases = {
    "tag on another name": [
      (m) => {
        m.stagingTag = "v9.9.9";
      },
      /release tags/,
    ],
    "another source commit": [
      (m) => {
        m.sourceSha = "b".repeat(40);
      },
      /source/,
    ],
    "another run's suffix": [
      (m) => {
        m.suffix = "-staging.1.1";

        for (const pkg of m.packages) {
          pkg.staging.version = `${pkg.production.version}-staging.1.1`;
        }
      },
      /suffix/,
    ],
    "unstable candidate": [
      (m) => {
        m.packages[0].production.version = "0.3.0-rc.1";
      },
      /versions/,
    ],
    "another release version": [
      (m) => {
        m.bump.version = "1.3.0";
      },
      /bump, which is not the version this run computed/,
    ],
    "bump dropped": [
      (m) => {
        delete m.bump;
      },
      /bump version undefined/,
    ],
    "file outside the release": [
      (m) => {
        m.packages[0].staging.file = "../escape.tgz";
      },
      /file/,
    ],
    "forged npm integrity": [
      (m) => {
        m.packages[0].production.integrity = "sha512-forged";
      },
      /does not match the release manifest/,
    ],
    "another package name": [
      (m) => {
        m.packages[0].name = "@photon-hq/other";
      },
      /holds|publish order|file/,
    ],
  };

  for (const [name, [edit, error]] of Object.entries(cases)) {
    await t.test(name, async () => {
      await forge(edit);
      const fake = world();
      await assert.rejects(publishWith(fake), error);
      assert.equal(fake.calls.length, 0);
    });
  }
});

test("a channel tag never moves to an older version", async () => {
  packBoth();
  await collectBoth();

  const fake = world({
    staging: { "@photon-hq/adapter": "9.0.0-staging.1.1" },
  });

  const logs = [];
  await publishWith(fake, { log: (line) => logs.push(line) });
  assert.deepEqual(
    commands(fake.calls, "npm", "dist-tag")
      .filter((call) => call[2] === "add")
      .map((call) => call[3]),
    [`@photon-hq/adapter-core@1.2.0${SUFFIX}`]
  );
  assert.ok(
    logs.some((line) =>
      line.includes("Kept @photon-hq/adapter@staging on 9.0.0-staging.1.1")
    )
  );
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
    {
      name: "@photon-hq/adapter-core",
      version: "0.3.0",
      manifest: {
        peerDependencies: {
          "@photon-hq/contracts": ">=0.25.0-staging.39.1",
          zod: "4.0.0",
        },
      },
    },
    {
      name: "@photon-hq/adapter",
      version: "1.2.0",
      manifest: {
        dependencies: {
          "@photon-hq/adapter-core": "0.3.0",
          "@photon-hq/payload": "1.0.0",
          lodash: "^4",
        },
        peerDependencies: { "@photon-hq/adapter-core": "^0.3.0" },
      },
    },
  ];

  assert.deepEqual(
    await dependencyFindings(candidates, ["@photon-hq/"], fake.registry),
    []
  );

  const blocked = [
    {
      name: "@photon-hq/adapter-core",
      version: "0.3.0",
      manifest: {
        peerDependencies: {
          "@photon-hq/contracts": "0.25.0-staging.39.1",
          "@photon-hq/missing": "^1",
        },
      },
    },
    {
      name: "@photon-hq/adapter",
      version: "1.2.0",
      manifest: {
        dependencies: {
          "@photon-hq/adapter-core": "0.2.0",
          "@photon-hq/payload": "1.0.1",
          "@photon-hq/contracts": "0.25.0-staging.39.1",
        },
        optionalDependencies: { "@photon-hq/linked": "workspace:*" },
      },
    },
  ];

  const findings = await dependencyFindings(
    blocked,
    ["@photon-hq/"],
    fake.registry
  );

  assert.equal(findings.length, 6, findings.join("\n"));
  assert.ok(
    findings.some((finding) =>
      finding.includes(
        "@photon-hq/contracts@0.25.0-staging.39.1 is not an exact stable version"
      )
    )
  );
  assert.ok(
    findings.some((finding) =>
      finding.includes(
        "no published stable @photon-hq/contracts satisfies 0.25.0-staging.39.1"
      )
    )
  );
});

registerPromotionCases(test);
