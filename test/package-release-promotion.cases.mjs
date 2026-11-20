import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import {
  SHA,
  SUFFIX,
  REPOSITORY,
  BUMP,
  fixturePath,
  commands,
  publishWith,
  stagedWorld,
  resolveWith,
  asLegacy,
} from "./fixtures/package-release.mjs";

export const registerPromotionCases = (test) => {
  test("promotion resolves the current staging build and verifies each candidate's provenance", async () => {
    const { manifest, fake } = await stagedWorld();
    const { manifest: resolved, changes } = await resolveWith(fake);
    assert.deepEqual(resolved, manifest);
    assert.equal(changes, undefined);
    const attestations = commands(fake.calls, "gh", "attestation");
    assert.equal(attestations.length, 2);

    for (const flag of [
      ["--repo", REPOSITORY],
      [
        "--signer-workflow",
        "photon-hq/buildspace/.github/workflows/package-stage.yml",
      ],
      ["--source-digest", SHA],
      ["--source-ref", "refs/heads/main"],
    ]) {
      assert.equal(
        attestations[0][attestations[0].indexOf(flag[0]) + 1],
        flag[1]
      );
    }

    await publishWith(fake, {
      directory: fixturePath("candidate"),
      channel: "production",
      sourceSha: undefined,
      runId: "901",
    });
    assert.equal(
      fake.state.published["@photon-hq/adapter@1.2.0"],
      manifest.packages[1].production.integrity
    );
    assert.equal(fake.state.tags["v1.2.0"], SHA);
    const release = fake.state.releases["v1.2.0"];
    assert.equal(release.prerelease, false);
    assert.deepEqual(release.assets.toSorted(), [
      "photon-hq-adapter-1.2.0.tgz",
      "photon-hq-adapter-core-1.2.0.tgz",
      "release-manifest.json",
    ]);
    assert.deepEqual(
      commands(fake.calls, "npm", "dist-tag")
        .filter((call) => call[2] === "add")
        .map((call) => call.slice(3, 5)),
      [
        ["@photon-hq/adapter-core@1.2.0", "latest"],
        ["@photon-hq/adapter@1.2.0", "latest"],
      ]
    );
  });

  /** Rewrites the staged manifest as the stage workflow wrote it before it computed versions. */
  test("promotion shows the version a build's changes computed", async () => {
    const { fake } = await stagedWorld({
      world: { tags: { "v1.1.0": "c".repeat(40) } },
    });

    const { manifest, changes } = await resolveWith(fake);
    assert.equal(changes, undefined);
    assert.deepEqual(manifest.bump, BUMP);
    await publishWith(fake, {
      directory: fixturePath("candidate"),
      channel: "production",
      sourceSha: undefined,
      runId: "901",
    });
    assert.equal(
      commands(fake.calls, "gh", "api").some((call) =>
        call.some((arg) => arg.includes("/compare/v1.1.0"))
      ),
      false
    );
    assert.ok(
      fake.state.releases["v1.2.0"].notes.includes(
        "- **minor** feat: one ([#7](https://github.com/photon-hq/adapter/pull/7))"
      )
    );
  });

  test("promotion lists the changes since the current production release", async () => {
    const { fake } = await stagedWorld({
      world: { tags: { "v1.1.0": "c".repeat(40) } },
    });

    // A build staged before versions were computed lists the commits instead.
    asLegacy();
    fake.registry = ((registry) => async (name) => {
      const metadata = await registry(name);

      if (name === "@photon-hq/adapter") {
        metadata["dist-tags"].latest = "1.1.0";
      }

      return metadata;
    })(fake.registry);
    const { changes } = await resolveWith(fake, { version: `1.2.0${SUFFIX}` });
    assert.deepEqual(changes, {
      previousTag: "v1.1.0",
      total: 2,
      subjects: ["fix: two", "feat: one"],
    });
  });

  test("promotion under a production tag prefix leaves the repository's vX.Y.Z tags alone", async () => {
    const names = { productionTagPrefix: "adapter-v" };

    // v1.2.0 and v1.1.0 already name the repository's own releases, on other commits.
    const { manifest, fake } = await stagedWorld({
      names,
      world: {
        tags: {
          "v1.2.0": "b".repeat(40),
          "v1.1.0": "b".repeat(40),
          "adapter-v1.1.0": "c".repeat(40),
        },
      },
    });

    assert.equal(manifest.productionTag, "adapter-v1.2.0");
    asLegacy();
    fake.registry = ((registry) => async (name) => {
      const metadata = await registry(name);

      if (name === "@photon-hq/adapter") {
        metadata["dist-tags"].latest = "1.1.0";
      }

      return metadata;
    })(fake.registry);
    const { changes } = await resolveWith(fake, names);
    assert.equal(changes.previousTag, "adapter-v1.1.0");

    await publishWith(fake, {
      directory: fixturePath("candidate"),
      channel: "production",
      sourceSha: undefined,
      runId: "901",
      ...names,
    });
    assert.equal(fake.state.tags["adapter-v1.2.0"], SHA);
    assert.equal(fake.state.tags["v1.2.0"], "b".repeat(40));
    assert.equal(fake.state.releases["adapter-v1.2.0"].prerelease, false);
    assert.equal(fake.state.releases["v1.2.0"], undefined);
    // The prefix is re-derived from the run's inputs, not taken from the manifest.
    await assert.rejects(resolveWith(fake), /release tags/);
  });

  const [OLDER, BETWEEN, FREIGHT, NEWER] = ["b", "c", "d", "e"].map((letter) =>
    letter.repeat(40)
  );

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
      world: {
        history: HISTORY,
        runs: [stageRun(950, NEWER), stageRun(900, SHA)],
        tags: { "adapter-staging-1.2.0-staging.950.1": NEWER },
      },
    });

    const { manifest: resolved, pending } = await resolveWith(fake, {
      imageTag: `main-${FREIGHT}`,
    });

    assert.deepEqual(resolved, manifest);
    assert.equal(pending, true);
    assert.deepEqual(
      (await resolveWith(fake, { imageTag: `main-${SHA}` })).manifest,
      manifest
    );
  });

  test("an image tag is refused when its commit carries no certain build", async (t) => {
    await t.test("a later stage run published nothing", async () => {
      for (const [conclusion, shown] of [
        ["failure", "failure"],
        [null, "in_progress"],
      ]) {
        const { fake } = await stagedWorld({
          world: {
            history: HISTORY,
            runs: [stageRun(930, BETWEEN, conclusion), stageRun(900, SHA)],
          },
        });

        await assert.rejects(
          resolveWith(fake, { imageTag: `main-${FREIGHT}` }),
          new RegExp(
            `runs/930 staged ${BETWEEN} after adapter-staging-1\\.2\\.0-staging\\.900\\.1 and published no build \\(${shown}\\)`
          )
        );
      }
    });
    await t.test("staged only after the commit", async () => {
      const { fake } = await stagedWorld({ world: { history: HISTORY } });
      await assert.rejects(
        resolveWith(fake, { imageTag: `main-${OLDER}` }),
        /has no staging build at or before b{40}/
      );
    });
    await t.test("not an immutable tag, or a version as well", async () => {
      const { fake } = await stagedWorld();
      await assert.rejects(
        resolveWith(fake, { imageTag: "main-abcd" }),
        /Invalid immutable image tag/
      );
      await assert.rejects(
        resolveWith(fake, {
          imageTag: `main-${SHA}`,
          version: `1.2.0${SUFFIX}`,
        }),
        /not both/
      );
    });
  });

  test("a hotfix image releases no packages", async () => {
    const { fake } = await stagedWorld({ world: { environment: [] } });
    assert.deepEqual(
      await resolveWith(fake, { imageTag: `hotfix-${SHA}-${FREIGHT}` }),
      { pending: false }
    );
    assert.equal(fake.calls.length, 0);
  });

  test("a build that is already released has nothing pending", async () => {
    const { fake } = await stagedWorld();
    assert.equal((await resolveWith(fake)).pending, true);
    await publishWith(fake, {
      directory: fixturePath("candidate"),
      channel: "production",
      sourceSha: undefined,
      runId: "901",
    });
    assert.equal((await resolveWith(fake)).pending, false);
    // Identical packages keep the tag of the commit that first released them.
    fake.state.tags["v1.2.0"] = OLDER;
    assert.equal((await resolveWith(fake)).pending, false);
    // An interrupted release still has work left.
    delete fake.state.releases["v1.2.0"];
    assert.equal((await resolveWith(fake)).pending, true);
  });

  test("the trusted actor's dispatch stands in for the environment's reviewers", async () => {
    const { manifest, fake } = await stagedWorld({
      world: { environment: [] },
    });

    await assert.rejects(
      resolveWith(fake),
      /must exist and require a reviewer/
    );

    const { manifest: resolved, pending } = await resolveWith(fake, {
      approvedBy: "release-controller[bot]",
    });

    assert.deepEqual(resolved, manifest);
    assert.equal(pending, true);

    // Every other check still applies.
    const { fake: unattested } = await stagedWorld({
      world: { attested: false },
    });

    await assert.rejects(
      resolveWith(unattested, { approvedBy: "release-controller[bot]" }),
      /no attestations|verification failed/
    );
  });

  test("promotion refuses unsafe candidates before anything is published", async (t) => {
    await t.test("environment without reviewers", async () => {
      const { fake } = await stagedWorld({ world: { environment: [] } });
      await assert.rejects(
        resolveWith(fake),
        /must exist and require a reviewer/
      );
    });
    await t.test("missing environment", async () => {
      const { fake } = await stagedWorld({ world: { environment: null } });
      await assert.rejects(
        resolveWith(fake),
        /must exist and require a reviewer/
      );
    });
    await t.test("build from before this workflow", async () => {
      const { fake } = await stagedWorld();
      await assert.rejects(
        resolveWith(fake, { version: "1.1.0-staging.39.1" }),
        /has no promotion candidates/
      );
    });
    await t.test("missing attestation", async () => {
      const { fake } = await stagedWorld({ world: { attested: false } });
      await assert.rejects(resolveWith(fake), /verification failed/);
    });
    await t.test("not newer than latest", async () => {
      const { fake } = await stagedWorld({
        world: { latest: { "@photon-hq/adapter-core": "1.2.0" } },
      });

      await assert.rejects(
        resolveWith(fake),
        /not newer than latest 1\.2\.0; stage a newer build/
      );
    });
    await t.test("depends on a staging build", async () => {
      const { fake } = await stagedWorld({
        pack: {
          extra: {
            peerDependencies: { "@photon-hq/contracts": "0.25.0-staging.39.1" },
          },
        },
      });

      await assert.rejects(
        resolveWith(fake),
        /no published stable @photon-hq\/contracts/
      );
    });
    await t.test("tampered candidate", async () => {
      const { manifest, fake } = await stagedWorld();
      writeFileSync(
        fake.state.releases[manifest.stagingTag].files.find((file) =>
          file.endsWith("photon-hq-adapter-1.2.0.tgz")
        ),
        "tampered"
      );
      await assert.rejects(
        resolveWith(fake),
        /does not match the release manifest/
      );
    });
  });
};
