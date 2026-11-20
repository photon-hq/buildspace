import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { registryMetadata } from "../.github/package-release/package-release.mjs";
import {
  NPMJS,
  PUBLIC,
  PUBLIC_STAGING,
  packPublic,
} from "./fixtures/package-npm.mjs";
import {
  SHA,
  fixturePath,
  collectBoth,
  world,
  commands,
  publishWith,
  stagedWorld,
  resolveWith,
} from "./fixtures/package-release.mjs";

/** A registry that, like npmjs while it scans a new version, does not serve it for its first `reads` reads. */
const processing = (fake, version, reads) => {
  let readsRemaining = reads;

  return async (name) => {
    const metadata = await fake.registry(name);

    if (!metadata.versions[version] || readsRemaining <= 0) {
      return metadata;
    }

    readsRemaining -= 1;
    const { [version]: _hidden, ...versions } = metadata.versions;

    return { ...metadata, versions };
  };
};

export const registerPublishCases = (test) => {
  test("npmjs is read without credentials and past its CDN", async (t) => {
    const requests = [];
    t.mock.method(globalThis, "fetch", async (url, init) => {
      requests.push([url, init.headers]);

      return Response.json({
        versions: { "3.9.0": {} },
        "dist-tags": { latest: "3.9.0" },
      });
    });

    const metadata = await registryMetadata(
      NPMJS,
      "github-token"
    )("@photon-ai/otel");

    assert.deepEqual(metadata["dist-tags"], { latest: "3.9.0" });
    await registryMetadata(
      "https://npm.pkg.github.com",
      "github-token"
    )("@photon-hq/adapter");
    assert.deepEqual(requests, [
      [
        "https://registry.npmjs.org/%40photon-ai%2Fotel?write=true",
        { accept: "application/json" },
      ],
      [
        "https://npm.pkg.github.com/%40photon-hq%2Fadapter",
        { authorization: "Bearer github-token", accept: "application/json" },
      ],
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
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    assert.deepEqual(
      commands(fake.calls, "npm", "publish").map((call) => call.slice(3)),
      [
        [
          "--tag",
          "candidate-900-1",
          "--ignore-scripts",
          "--access",
          "public",
          "--provenance",
          `--registry=${NPMJS}`,
        ],
      ]
    );
    assert.deepEqual(sleeps, [15_000, 15_000]);
    assert.deepEqual(
      commands(fake.calls, "npm", "dist-tag").map((call) => call.slice(2)),
      [
        [
          "add",
          `@photon-ai/otel@${PUBLIC_STAGING}`,
          "staging",
          `--registry=${NPMJS}`,
        ],
        ["rm", "@photon-ai/otel", "candidate-900-1", `--registry=${NPMJS}`],
      ]
    );
    assert.equal(
      fake.state.releases[`adapter-staging-${PUBLIC_STAGING}`].title,
      `@photon-ai/otel ${PUBLIC_STAGING}`
    );
  });

  test("a version the registry never serves stops publication before any tag or release", async () => {
    packPublic();
    await collectBoth(PUBLIC);
    const fake = world();
    let clock = 0;
    await assert.rejects(
      publishWith(fake, {
        ...PUBLIC,
        registry: processing(fake, PUBLIC_STAGING, Number.POSITIVE_INFINITY),
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
      /did not serve it within 30 minutes/
    );
    assert.equal(clock, 30 * 60_000);
    assert.equal(commands(fake.calls, "npm", "dist-tag").length, 0);
    assert.deepEqual(fake.state.releases, {});
  });

  test("a public build is promoted on npmjs, and only there", async () => {
    packPublic();
    const manifest = await collectBoth(PUBLIC);

    const fake = world({
      latest: { "@photon-ai/otel": "3.8.2" },
      tags: { "v3.8.2": "c".repeat(40) },
    });

    await publishWith(fake, PUBLIC);
    fake.calls.length = 0;

    const { manifest: resolved, changes } = await resolveWith(fake, {
      ...PUBLIC,
      version: PUBLIC_STAGING,
    });

    assert.deepEqual(resolved, manifest);
    assert.equal(changes, undefined);
    await assert.rejects(
      resolveWith(fake, {
        packageInput: "@photon-ai/otel",
        version: PUBLIC_STAGING,
      }),
      /registry https:\/\/registry\.npmjs\.org/
    );

    await publishWith(fake, {
      ...PUBLIC,
      directory: fixturePath("candidate"),
      channel: "production",
      sourceSha: undefined,
      runId: "901",
    });
    assert.equal(
      fake.state.published["@photon-ai/otel@3.9.0"],
      manifest.packages[0].production.integrity
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
      [["@photon-ai/otel@3.9.0", "latest", `--registry=${NPMJS}`]]
    );
    assert.equal(fake.state.tags["v3.9.0"], SHA);
    assert.equal(fake.state.releases["v3.9.0"].prerelease, false);
    assert.ok(
      fake.state.releases["v3.9.0"].notes.includes(
        "A minor release after [`v3.8.2`](https://github.com/photon-hq/adapter/releases/tag/v3.8.2)."
      )
    );
  });

  test("a build staged before registries were recorded is promoted to GitHub Packages", async () => {
    const { manifest: staged, fake } = await stagedWorld();
    assert.equal(staged.registry, "https://npm.pkg.github.com");
    const path = fixturePath("release/release-manifest.json");

    const {
      registry: _registry,
      selection: _selection,
      ...manifest
    } = JSON.parse(readFileSync(path, "utf-8"));

    writeFileSync(path, JSON.stringify(manifest));
    assert.equal((await resolveWith(fake)).pending, true);
    await assert.rejects(
      resolveWith(fake, { ...PUBLIC, packageInput: "@photon-hq/adapter" }),
      /registry https:\/\/npm\.pkg\.github\.com/
    );
  });
};
