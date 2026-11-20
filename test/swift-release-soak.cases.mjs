import assert from "node:assert/strict";
import {
  formatAge,
  parseAge,
  soakSummary,
} from "../.github/package-release/swift-release.mjs";
import {
  at,
  C1,
  C2,
  EARLIER,
  makeSha,
  OTHER,
  OWN,
  SHA,
  T0,
  world,
} from "./swift-release.test-utils.mjs";

export const registerSoakCases = (
  test,
  { collectBuild, publishWith, resolveWith, soaking, soakWith, staged }
) => {
  test("promotion waits until every change since the latest release has run on staging for the minimum age", async () => {
    const { fake } = await soaking();
    const error = await soakWith(fake, 90).catch((error_) => error_);
    assert.match(
      error.message,
      new RegExp(
        `${OWN.replaceAll(".", "\\.")}: some changes were on staging for less than the minimum time:`
      )
    );
    assert.match(
      error.message,
      /\n- #96 feat: stage every main push: on staging 40m, minimum 1h\n/
    );
    assert.match(
      error.message,
      /To promote now, set skip-minimum-age-reason\.$/
    );
    assert.doesNotMatch(error.message, /#95/);
    assert.deepEqual(
      error.soak.changes.map(({ pull, age }) => [pull.number, age / 60_000]),
      [
        [95, 90],
        [96, 40],
      ]
    );

    const { pending, soak, overridden } = await soakWith(fake, 111);
    assert.equal(pending, true);
    assert.equal(overridden, false);
    assert.deepEqual(soak.waiting, []);
  });

  test("before the first release, the build's own commit is the change, named by its subject", async () => {
    const { fake } = await staged({
      world: {
        tags: { [EARLIER]: C1 },
        soak: {
          commits: [{ sha: SHA, message: "feat: first build\n\nbody" }],
          published: { [OWN]: at(0) },
        },
      },
    });

    const error = await soakWith(fake, 30).catch((error_) => error_);
    assert.match(
      error.message,
      new RegExp(
        `- ${SHA.slice(0, 12)} feat: first build: on staging 30m, minimum 1h`
      )
    );
    assert.equal(error.soak.changes.length, 1);
  });

  test("a pull request's min-staging-age label lengthens its own change's wait and never shortens it", async () => {
    const { fake } = await soaking({
      labels: {
        95: ["bug", "min-staging-age:3h"],
        96: ["min-staging-age:10m"],
      },
    });

    const error = await soakWith(fake, 120).catch((error_) => error_);
    assert.match(
      error.message,
      /- #95 fix: drain the queue: on staging 2h, minimum 3h \(PR label\)/
    );
    assert.doesNotMatch(error.message, /#96/);
    assert.deepEqual(
      error.soak.changes.map(({ required, declared }) => [
        required / 60_000,
        declared,
      ]),
      [
        [180, "min-staging-age:3h"],
        [60, null],
      ]
    );
    assert.equal((await soakWith(fake, 180)).soak.waiting.length, 0);
  });

  test("a change's clock starts with the first staging release that carries it", async (t) => {
    await t.test(
      "a commit whose own stage published nothing rides in the next build",
      async () => {
        const { fake } = await soaking({
          commits: [
            { sha: C1, pull: { number: 95, title: "fix: drain the queue" } },
            { sha: C2, pull: { number: 97, title: "docs: explain the queue" } },
            {
              sha: SHA,
              pull: { number: 96, title: "feat: stage every main push" },
            },
          ],
        });

        const { soak } = await soakWith(fake, 200);
        assert.deepEqual(
          soak.changes.map(({ sha, since }) => [sha, since]),
          [
            [C1, T0],
            [C2, T0 + 50 * 60_000],
            [SHA, T0 + 50 * 60_000],
          ]
        );
      }
    );
    await t.test(
      "a pull request merged with its own commits is one change, as late as its last commit",
      async () => {
        const pull = { number: 95, title: "fix: drain the queue" };

        const { fake } = await soaking({
          commits: [
            { sha: C1, pull },
            { sha: C2, pull },
            {
              sha: SHA,
              pull: { number: 96, title: "feat: stage every main push" },
            },
          ],
          published: { "v1.27.0-staging.870.1": at(20) },
        });

        fake.state.tags["v1.27.0-staging.870.1"] = C2;
        const { soak } = await soakWith(fake, 200);
        assert.deepEqual(
          soak.changes.map(({ sha, pull: changePull, since }) => [
            sha,
            changePull.number,
            since,
          ]),
          [
            [C2, 95, T0 + 20 * 60_000],
            [SHA, 96, T0 + 50 * 60_000],
          ]
        );
      }
    );
    await t.test(
      "staging releases published before the latest release do not count",
      async () => {
        const { fake } = await soaking({ published: { "v1.26.0": at(30) } });
        const { soak } = await soakWith(fake, 200);
        assert.deepEqual(
          soak.changes.map(({ since }) => since),
          [T0 + 50 * 60_000, T0 + 50 * 60_000]
        );
      }
    );
    await t.test(
      "a change no counted staging release carries has not started",
      async () => {
        const { fake } = await soaking({ published: { "v1.26.0": at(60) } });
        const error = await soakWith(fake, 600).catch((error_) => error_);
        assert.match(
          error.message,
          /#95 fix: drain the queue: on staging none, minimum 1h/
        );
      }
    );
  });

  test("a library, and a caller that sets no minimum, skip the staging age", async () => {
    const { fake } = await soaking();
    await resolveWith(fake);
    assert.equal(
      fake.calls.filter((call) => call.some((arg) => arg.endsWith("/pulls")))
        .length,
      0
    );

    const library = { library: true };
    await collectBuild({
      ...library,
      stagingPackage: undefined,
      productionPackage: undefined,
    });
    const libraryWorld = world({ tags: { "v1.26.0": OTHER } });
    await publishWith(libraryWorld, library);
    libraryWorld.calls.length = 0;
    assert.equal(
      (
        await resolveWith(libraryWorld, {
          ...library,
          minimumAge: "1d",
          now: T0,
        })
      ).soak,
      undefined
    );
    assert.equal(
      libraryWorld.calls.filter((call) =>
        call.some((arg) => arg.endsWith("/pulls"))
      ).length,
      0
    );
  });

  test("a refused pull request read is reported by its cause", async (t) => {
    await t.test("a missing permission names the permission", async () => {
      const { fake } = await soaking({
        forbidden: "gh: Resource not accessible by integration (HTTP 403)",
      });

      await assert.rejects(
        soakWith(fake, 200),
        /GitHub refused access to the pull requests of .*\. Give the promote job pull-requests: read\./
      );
    });
    await t.test("rate limiting asks for a rerun", async () => {
      const { fake } = await soaking({
        forbidden:
          "gh: API rate limit exceeded for installation ID 1. (HTTP 403)",
      });

      await assert.rejects(
        soakWith(fake, 200),
        (error) =>
          /rate limit stopped access .* Try again later\./.test(
            error.message
          ) && !/pull-requests: read/.test(error.message)
      );
    });
    await t.test("any other refusal is passed on unchanged", async () => {
      const { fake } = await soaking({
        forbidden: "gh: Must have admin rights to Repository. (HTTP 403)",
      });

      await assert.rejects(soakWith(fake, 200), (error) =>
        error.message.includes(
          ": cannot check the time on staging. gh: Must have admin rights to Repository. (HTTP 403)\n"
        )
      );
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
    assert.deepEqual(soakSummary(undefined, "Cannot check."), [
      "### Time on staging",
      "",
      "Cannot check.",
      "",
    ]);
  });

  test("ages are minutes, hours or days", () => {
    assert.equal(parseAge("30m"), 30 * 60_000);
    assert.equal(parseAge("2h"), 2 * 3_600_000);
    assert.equal(parseAge("1d"), 86_400_000);
    assert.equal(parseAge("0m"), 0);

    for (const bad of ["2", "2 hours", "1.5h", "-1h", "01h", ""]) {
      assert.throws(() => parseAge(bad), /Invalid minimum staging age/, bad);
    }

    assert.equal(formatAge(0), "0m");
    assert.equal(formatAge(89 * 60_000 + 59_000), "1h 29m");
    assert.equal(formatAge(89 * 60_000 + 1000, Math.ceil), "1h 30m");
    assert.equal(formatAge(26 * 3_600_000), "1d 2h");
  });

  test("an unreadable label age stops promotion instead of being ignored", async () => {
    const { fake } = await soaking({
      labels: { 95: ["min-staging-age:a while"] },
    });

    await assert.rejects(
      soakWith(fake, 200),
      /Invalid minimum staging age "a while"/
    );
    assert.equal(
      (await soakWith(fake, 200, { skipMinimumAge: "hotfix" })).overridden,
      true
    );
  });

  test("promotion refuses when the latest release has no publish time to measure from", async () => {
    const { fake } = await soaking({ published: { "v1.26.0": undefined } });
    delete fake.state.releases["v1.26.0"];
    await assert.rejects(
      soakWith(fake, 600),
      (error) =>
        error.message.endsWith(
          ": cannot check the time on staging. v1.26.0 has no published GitHub release.\nTo promote now, set skip-minimum-age-reason."
        ) && error.unchecked === "v1.26.0 has no published GitHub release."
    );
  });

  test("only published staging prereleases after the latest release start a clock", async (t) => {
    const clocks = async (soak) => {
      const { fake } = await soaking(soak);

      return (await soakWith(fake, 200)).soak.changes.map(
        ({ since }) => (since - T0) / 60_000
      );
    };

    await t.test("a draft", async () =>
      assert.deepEqual(await clocks({ drafts: [EARLIER] }), [50, 50])
    );
    await t.test("a release that is not a prerelease", async () =>
      assert.deepEqual(await clocks({ stable: [EARLIER] }), [50, 50])
    );
    await t.test(
      "a release published at the same moment as the latest release",
      async () =>
        assert.deepEqual(
          await clocks({ published: { "v1.26.0": at(0) } }),
          [50, 50]
        )
    );
    await t.test("a published prerelease after the latest release", async () =>
      assert.deepEqual(await clocks({}), [0, 50])
    );
  });

  test("a change that has been on staging exactly the minimum is ready", async () => {
    const { fake } = await soaking();
    // #96 reached staging at minute 50; the minimum is 1h.
    assert.equal((await soakWith(fake, 110)).soak.waiting.length, 0);
    await assert.rejects(
      soakWith(fake, 109),
      /- #96 feat: stage every main push: on staging 59m, minimum 1h\n/
    );
  });

  test("every page of a long range of commits is checked", async () => {
    const many = Array.from({ length: 149 }, (_, index) => ({
      sha: `c${index.toString(16)}`.padStart(40, "0"),
      message: `fix: change ${index}`,
    }));

    const { fake } = await soaking({
      commits: [...many, { sha: SHA, message: "feat: stage every main push" }],
    });

    const { soak } = await soakWith(fake, 200);
    assert.equal(soak.changes.length, 150);
    assert.equal(
      fake.calls.filter((call) =>
        call.some((arg) => arg.endsWith("?per_page=100&page=2"))
      ).length,
      1
    );
  });

  test("a pull request that was never merged declares nothing", async () => {
    const { fake } = await soaking({
      commits: [
        {
          sha: C1,
          otherPulls: [
            {
              number: 90,
              title: "wip",
              merged_at: null,
              labels: ["min-staging-age:3h"],
            },
          ],
          pull: { number: 95, title: "fix: drain the queue" },
        },
        {
          sha: SHA,
          pull: { number: 96, title: "feat: stage every main push" },
        },
      ],
    });

    assert.deepEqual(
      (await soakWith(fake, 200)).soak.changes.map(({ pull, required }) => [
        pull.number,
        required / 60_000,
      ]),
      [
        [95, 60],
        [96, 60],
      ]
    );
  });

  test("a build released again after a rollback is measured from the release before it", async () => {
    const { fake } = await soaking();
    // v1.27.0 was released from this build, then rolled back by marking it a prerelease.
    fake.state.tags["v1.27.0"] = SHA;
    fake.state.releases["v1.27.0"] = { prerelease: true, assets: [] };
    const { pending, soak } = await soakWith(fake, 200);
    assert.equal(pending, true);
    assert.deepEqual(
      soak.changes.map(({ sha }) => sha),
      [C1, SHA]
    );
  });

  test("a staging tag whose release was never published is skipped", async () => {
    // A stage run that failed between tagging and releasing leaves a tag with no release.
    const { fake } = await soaking();
    fake.state.tags["v1.27.0-staging.860.1"] = C1;
    const { soak } = await soakWith(fake, 200);
    assert.deepEqual(
      soak.changes.map(({ since }) => (since - T0) / 60_000),
      [0, 50]
    );
  });

  test("a branch merged into main without a pull request waits for its merge commit's build", async () => {
    const SIDE = makeSha("3");

    // Listed by date, the side commit sits before a main commit that was staged early but doesn't carry it.
    const { fake } = await soaking({
      commits: [
        { sha: SIDE, message: "fix: side work" },
        { sha: C1, pull: { number: 95, title: "fix: drain the queue" } },
        { sha: SHA, message: "Merge branch 'side'" },
      ],
    });

    const error = await soakWith(fake, 100).catch((error_) => error_);
    assert.match(
      error.message,
      new RegExp(
        `- ${SHA.slice(0, 12)} Merge branch 'side': on staging 50m, minimum 1h\n`
      )
    );
  });

  test("a labelled pull request merged with a merge commit waits for the merge commit's build", async () => {
    const SIDE = makeSha("3");

    const pull = {
      number: 97,
      title: "fix: risky side work",
      labels: ["min-staging-age:3h"],
    };

    // The side commit sits before a main commit staged early that doesn't carry it, so its own row starts too early.
    const { fake } = await soaking({
      commits: [
        { sha: SIDE, pull },
        { sha: C1, pull: { number: 95, title: "fix: drain the queue" } },
        { sha: SHA, pull },
      ],
    });

    // At minute 200 the side commit's early row has its 3h; the merge commit's build has had only 2h 30m.
    const error = await soakWith(fake, 200).catch((error_) => error_);
    assert.match(
      error.message,
      /\n- #97 fix: risky side work: on staging 2h 30m, minimum 3h \(PR label\)\n/
    );
  });

  test("an empty minimum, as the workflow passes it, means the 2h default", async () => {
    const { fake } = await soaking();
    // #96 has 70m on staging: enough for a 1h minimum, not for 2h.
    assert.equal((await soakWith(fake, 120)).overridden, false);

    const error = await soakWith(fake, 120, { minimumAge: "" }).catch(
      (error_) => error_
    );

    assert.match(
      error.message,
      /- #96 feat: stage every main push: on staging 1h 10m, minimum 2h\n/
    );
  });

  test("only the pull request that merged a change into main declares its age", async () => {
    const { fake } = await soaking({
      commits: [
        {
          sha: C1,
          // Stacked: first merged into a feature branch under another pull request.
          otherPulls: [
            {
              number: 90,
              title: "wip: drain the queue",
              base: { ref: "feature" },
              labels: ["min-staging-age:3h"],
            },
          ],
          pull: { number: 95, title: "fix: drain the queue" },
        },
        {
          sha: SHA,
          pull: { number: 96, title: "feat: stage every main push" },
        },
      ],
    });

    const { soak } = await soakWith(fake, 200);
    assert.deepEqual(
      soak.changes.map(({ pull, required }) => [
        pull.number,
        required / 60_000,
      ]),
      [
        [95, 60],
        [96, 60],
      ]
    );
  });
};
