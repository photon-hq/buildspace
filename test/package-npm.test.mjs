import assert from "node:assert/strict";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import nodePath from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  releaseNames,
  verifyManifest,
} from "../.github/package-release/package-release.mjs";
import {
  NPMJS,
  PUBLIC,
  PUBLIC_STAGING,
  packPublic,
} from "./fixtures/package-npm.mjs";
import {
  SHA,
  SUFFIX,
  REPOSITORY,
  fixturePath,
  setUp,
  tearDown,
  pack,
  collectBoth,
  world,
  commands,
  publishWith,
  resolveWith,
} from "./fixtures/package-release.mjs";
import { registerPublishCases } from "./package-npm-publish.cases.mjs";

beforeEach(setUp);

afterEach(tearDown);

test("a public package is named by the package input and keeps to its scope on npmjs", async () => {
  packPublic();
  const manifest = await collectBoth(PUBLIC);
  assert.equal(manifest.package, "@photon-ai/otel");
  assert.equal(manifest.registry, NPMJS);
  assert.equal(manifest.stagingTag, `adapter-staging-${PUBLIC_STAGING}`);
  assert.equal(manifest.productionTag, "v3.9.0");
  await assert.rejects(
    collectBoth({ registryUrl: NPMJS }),
    /named by the package input/
  );
  await assert.rejects(
    collectBoth({ ...PUBLIC, registryUrl: "https://registry.example.com" }),
    /Unsupported registry/
  );
  pack(fixturePath("staging"), {
    name: "@photon-hq/adapter",
    version: `1.0.0${SUFFIX}`,
  });
  pack(fixturePath("production"), {
    name: "@photon-hq/adapter",
    version: "1.0.0",
  });
  await assert.rejects(
    collectBoth(PUBLIC),
    /not in the release selection @photon-ai\//
  );
});

test("npmjs accepts an unscoped package input and still rejects invalid names", () => {
  assert.deepEqual(
    releaseNames({
      repository: REPOSITORY,
      packageInput: "dsh-imessage",
      registryUrl: NPMJS,
    }),
    {
      registryUrl: NPMJS,
      selection: ["dsh-imessage"],
      primary: "dsh-imessage",
      tagPrefix: "adapter-staging-",
      productionTagPrefix: "v",
    }
  );
  assert.deepEqual(
    releaseNames({
      repository: REPOSITORY,
      packageInput: PUBLIC.packageInput,
      registryUrl: NPMJS,
    }),
    {
      registryUrl: NPMJS,
      selection: ["@photon-ai/"],
      primary: "@photon-ai/otel",
      tagPrefix: "adapter-staging-",
      productionTagPrefix: "v",
    }
  );
  assert.deepEqual(releaseNames({ repository: REPOSITORY }), {
    registryUrl: "https://npm.pkg.github.com",
    selection: ["@photon-hq/"],
    primary: "@photon-hq/adapter",
    tagPrefix: "adapter-staging-",
    productionTagPrefix: "v",
  });
  assert.equal(
    releaseNames({
      repository: REPOSITORY,
      packageInput: "a".repeat(214),
      registryUrl: NPMJS,
    }).primary.length,
    214
  );

  for (const name of [
    "",
    "@scope",
    "@scope/",
    "@scope/pkg/extra",
    "Uppercase",
    "bad name",
    ".hidden",
    "_hidden",
    "-hidden",
    "pkg%2fother",
    "a".repeat(215),
    "node_modules",
    "favicon.ico",
  ]) {
    assert.throws(
      () =>
        releaseNames({
          repository: REPOSITORY,
          packageInput: name,
          registryUrl: NPMJS,
        }),
      /named by the package input/
    );
  }
});

test("an unscoped npmjs build stages and promotes exactly its named package", async () => {
  const options = { ...PUBLIC, packageInput: "dsh-imessage" };

  for (const [directory, version] of [
    ["staging", PUBLIC_STAGING],
    ["production", "3.9.0"],
  ]) {
    pack(fixturePath(directory), {
      name: options.packageInput,
      version,
      dependencies: { "dsh-imessage-helper": "^1.0.0" },
    });
  }

  const manifest = await collectBoth(options);
  assert.deepEqual(
    manifest.packages.map(({ name }) => name),
    [options.packageInput]
  );
  assert.equal(
    manifest.packages[0].staging.file,
    `dsh-imessage-${PUBLIC_STAGING}.tgz`
  );
  assert.equal(manifest.packages[0].production.file, "dsh-imessage-3.9.0.tgz");
  await assert.rejects(
    verifyManifest(
      fixturePath("release"),
      {
        ...manifest,
        packages: [{ ...manifest.packages[0], name: "dsh-imessage-helper" }],
      },
      {
        repository: REPOSITORY,
        ...options,
        channels: ["staging", "production"],
      }
    ),
    /package dsh-imessage-helper/
  );

  const fake = world();
  await publishWith(fake, options);

  const { manifest: resolved } = await resolveWith(fake, {
    ...options,
    version: PUBLIC_STAGING,
  });

  assert.deepEqual(resolved, manifest);
  const [attestation] = commands(fake.calls, "gh", "attestation");
  assert.equal(attestation[3], fixturePath("candidate/dsh-imessage-3.9.0.tgz"));

  for (const [flag, value] of [
    ["--repo", REPOSITORY],
    [
      "--signer-workflow",
      "photon-hq/buildspace/.github/workflows/package-stage.yml",
    ],
    ["--source-digest", SHA],
    ["--source-ref", "refs/heads/main"],
  ]) {
    assert.equal(attestation[attestation.indexOf(flag) + 1], value);
  }

  await publishWith(fake, {
    ...options,
    directory: fixturePath("candidate"),
    channel: "production",
    sourceSha: undefined,
    runId: "901",
  });
  assert.deepEqual(
    Object.keys(fake.state.published).toSorted(),
    [`dsh-imessage@${PUBLIC_STAGING}`, "dsh-imessage@3.9.0"].toSorted()
  );
  assert.ok(
    commands(fake.calls, "npm", "publish").every(
      (call) =>
        call.includes("--provenance") && call.includes(`--registry=${NPMJS}`)
    )
  );
  assert.deepEqual(
    commands(fake.calls, "npm", "dist-tag")
      .filter((call) => call[2] === "add")
      .map((call) => call.slice(3)),
    [
      [`dsh-imessage@${PUBLIC_STAGING}`, "staging", `--registry=${NPMJS}`],
      ["dsh-imessage@3.9.0", "latest", `--registry=${NPMJS}`],
    ]
  );
  assert.deepEqual(fake.state.releases["v3.9.0"].assets.toSorted(), [
    "dsh-imessage-3.9.0.tgz",
    "release-manifest.json",
  ]);
});

test("an unscoped npmjs pack refuses other packages, including a matching name prefix", async () => {
  const options = { ...PUBLIC, packageInput: "dsh-imessage" };

  for (const [directory, version] of [
    ["staging", PUBLIC_STAGING],
    ["production", "3.9.0"],
  ]) {
    pack(fixturePath(directory), {
      name: options.packageInput,
      version,
    });
  }

  for (const name of ["dsh-imessage-helper", "@photon-ai/otel"]) {
    const extra = pack(fixturePath("staging"), {
      name,
      version: PUBLIC_STAGING,
    });

    await assert.rejects(
      collectBoth(options),
      /not in the release selection dsh-imessage$/
    );
    rmSync(extra);
  }

  await assert.rejects(
    collectBoth({ packageInput: "dsh-imessage" }),
    /not in the release selection @photon-hq\//
  );
});

test("a mixed npmjs build releases exactly the names and scopes its package selection lists", async () => {
  const options = {
    ...PUBLIC,
    packageInput: "app",
    packageSelection: "app @app/",
  };

  for (const [directory, version] of [
    ["staging", PUBLIC_STAGING],
    ["production", "3.9.0"],
  ]) {
    pack(fixturePath(directory), {
      name: "app",
      version,
      dependencies: { "@app/core": version },
    });
    pack(fixturePath(directory), { name: "@app/core", version });
  }

  const manifest = await collectBoth(options);
  assert.deepEqual(
    manifest.packages.map(({ name }) => name),
    ["@app/core", "app"]
  );
  const fake = world();
  await publishWith(fake, options);

  const { manifest: resolved } = await resolveWith(fake, {
    ...options,
    version: PUBLIC_STAGING,
  });

  assert.deepEqual(resolved, manifest);
  await publishWith(fake, {
    ...options,
    packageSelection: "@app/ app app",
    directory: fixturePath("candidate"),
    channel: "production",
    sourceSha: undefined,
    runId: "901",
  });
  assert.deepEqual(
    commands(fake.calls, "npm", "dist-tag")
      .filter((call) => call[2] === "add")
      .map((call) => call.slice(3, 5)),
    [
      [`@app/core@${PUBLIC_STAGING}`, "staging"],
      [`app@${PUBLIC_STAGING}`, "staging"],
      ["@app/core@3.9.0", "latest"],
      ["app@3.9.0", "latest"],
    ]
  );

  pack(fixturePath("staging"), {
    name: "app-helper",
    version: PUBLIC_STAGING,
  });
  await assert.rejects(
    collectBoth(options),
    /app-helper is not in the release selection app @app\//
  );
  assert.throws(
    () =>
      releaseNames({
        repository: REPOSITORY,
        packageInput: "app",
        packageSelection: "@app/",
        registryUrl: NPMJS,
      }),
    /must include the package input app/
  );
});

test("collect refuses package names that would overwrite one release artifact", async () => {
  for (const [channel, version] of [
    ["staging", PUBLIC_STAGING],
    ["production", "3.9.0"],
  ]) {
    const directory = fixturePath(channel);
    renameSync(
      pack(directory, { name: "@app/core", version }),
      nodePath.join(directory, "scoped.tgz")
    );
    pack(directory, { name: "app-core", version });
  }

  await assert.rejects(
    collectBoth({
      ...PUBLIC,
      packageInput: "app-core",
      packageSelection: "app-core @app/",
    }),
    /app-core-3\.9\.0\.tgz: multiple packages map to the same release filename/
  );
});

test("every exact selection is required in the packs and the published manifest", async () => {
  const options = {
    ...PUBLIC,
    packageInput: "app",
    packageSelection: "app @app/core",
  };

  for (const [channel, version] of [
    ["staging", PUBLIC_STAGING],
    ["production", "3.9.0"],
  ]) {
    pack(fixturePath(channel), { name: "app", version });
  }

  await assert.rejects(collectBoth(options), /@app\/core was not packed/);

  const manifest = await collectBoth({
    ...options,
    packageSelection: "app @app/",
  });

  assert.deepEqual(
    manifest.packages.map(({ name }) => name),
    ["app"]
  );
  writeFileSync(
    fixturePath("release/release-manifest.json"),
    JSON.stringify({ ...manifest, selection: ["app", "@app/core"] })
  );
  const fake = world();
  await assert.rejects(
    publishWith(fake, options),
    /selected package @app\/core is missing/
  );
  assert.equal(fake.calls.length, 0);
});

test("promotion cannot narrow the staged dependency policy", async () => {
  const options = {
    ...PUBLIC,
    packageInput: "app",
    packageSelection: "app @app/",
  };

  for (const [channel, version] of [
    ["staging", PUBLIC_STAGING],
    ["production", "3.9.0"],
  ]) {
    pack(fixturePath(channel), {
      name: "app",
      version,
      dependencies: { "@app/core": version },
    });
    pack(fixturePath(channel), {
      name: "@app/core",
      version,
      dependencies: { "@app/helper": "1.0.0" },
    });
  }

  const manifest = await collectBoth(options);
  const fake = world();
  await publishWith(fake, options);
  await assert.rejects(
    resolveWith(fake, { ...options, version: PUBLIC_STAGING }),
    /@app\/helper@1\.0\.0 is not published/
  );
  const narrowed = { ...options, packageSelection: "app @app/core" };
  await assert.rejects(
    resolveWith(fake, { ...narrowed, version: PUBLIC_STAGING }),
    /package selection/
  );

  fake.calls.length = 0;
  await assert.rejects(
    publishWith(fake, {
      ...narrowed,
      channel: "production",
      sourceSha: undefined,
      runId: "901",
    }),
    /package selection/
  );
  assert.equal(fake.calls.length, 0);
  const { selection: _, ...legacy } = manifest;
  await assert.rejects(
    verifyManifest(fixturePath("release"), legacy, {
      repository: REPOSITORY,
      ...options,
      channels: ["production"],
    }),
    /package selection/
  );
});

registerPublishCases(test);
