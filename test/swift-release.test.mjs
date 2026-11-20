import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { readManifest } from "../.github/package-release/swift-release.mjs";
import { registerDependenciesCases } from "./swift-release-dependencies.cases.mjs";
import { registerSoakCases } from "./swift-release-soak.cases.mjs";
import {
  at,
  BUMP,
  NAME,
  OTHER,
  REPOSITORY,
  SHA,
  SIGNER,
  SUFFIX,
  swiftReleaseFixture,
  T0,
  world,
} from "./swift-release.test-utils.mjs";

const fixture = swiftReleaseFixture();

const {
  collectBuild,
  createDirectory,
  fixturePath,
  packages,
  publishWith,
  removeDirectory,
  resolveWith,
  soaking,
  soakWith,
  staged,
} = fixture;

beforeEach(createDirectory);

afterEach(removeDirectory);

const digest = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const commands = (calls, first) =>
  calls.filter((call) => call[0] === "gh" && call[1] === first);

test("collect lays out the staging package and its production candidate at the computed version", async () => {
  packages();
  const manifest = await collectBuild();
  assert.equal(manifest.kind, "swift-package");
  assert.equal(manifest.stagingTag, `v1.27.0${SUFFIX}`);
  assert.equal(manifest.productionTag, "v1.27.0");
  assert.deepEqual(manifest.bump, BUMP);
  assert.deepEqual(manifest.pkg, {
    staging: {
      version: `1.27.0${SUFFIX}`,
      file: `${NAME}.pkg`,
      sha256: digest(fixturePath("pack/staging", `${NAME}.pkg`)),
    },
    production: {
      version: "1.27.0",
      file: `${NAME}-1.27.0.pkg.candidate`,
      sha256: digest(fixturePath("pack/production", `${NAME}.pkg`)),
    },
  });
  assert.deepEqual(await readManifest(fixturePath("release")), manifest);

  for (const [name, overrides, error] of [
    ["package name", { packageName: "../escape" }, /Invalid package name/],
    ["suffix", { suffix: "-rc.1" }, /Invalid staging suffix/],
    ["source", { sourceSha: "main" }, /exact source commit/],
    [
      "version",
      { bump: { ...BUMP, version: "1.27" } },
      /Invalid release version/,
    ],
  ]) {
    await assert.rejects(collectBuild(overrides), error, name);
  }
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
  assert.deepEqual(release.assets.toSorted(), [
    `${NAME}-1.27.0.pkg.candidate`,
    `${NAME}.pkg`,
    "release-manifest.json",
  ]);
  assert.deepEqual(
    release.assets.filter((asset) => asset.endsWith(".pkg")),
    [`${NAME}.pkg`]
  );
  assert.match(release.notes, /Staging Macs install it/);
  assert.ok(release.notes.includes(`staging-version: 1.27.0${SUFFIX}`));
  assert.ok(
    release.notes.includes("- **minor** feat: stage every main push ([#91]")
  );

  const create = commands(fake.calls, "release").find(
    (call) => call[2] === "create"
  );

  assert.ok(
    create.includes("--prerelease") && create.includes("--latest=false")
  );
});

test("the publishing job trusts no manifest claim the files and run do not support", async (t) => {
  const forge = async (edit) => {
    rmSync(fixturePath(), { recursive: true, force: true });
    mkdirSync(fixturePath());
    packages();
    await collectBuild();
    const path = fixturePath("release/release-manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf-8"));
    edit(manifest);
    writeFileSync(path, JSON.stringify(manifest));
  };

  const cases = {
    "another version": [
      (m) => {
        m.bump.version = "2.0.0";
      },
      /bump, which is not the version this run computed/,
    ],
    "another staging tag": [
      (m) => {
        m.stagingTag = "v9.9.9";
      },
      /release tags/,
    ],
    "another source commit": [
      (m) => {
        m.sourceSha = OTHER;
      },
      /source/,
    ],
    "another run's suffix": [
      (m) => {
        m.suffix = "-staging.1.1";
      },
      /suffix/,
    ],
    "another package": [
      (m) => {
        m.package = "other";
      },
      /package other/,
    ],
    "candidate under a .pkg name": [
      (m) => {
        m.pkg.production.file = `${NAME}.pkg`;
      },
      /production package/,
    ],
    "a library's kind": [
      (m) => {
        m.kind = "swift-library";
      },
      /kind swift-library/,
    ],
    "tampered candidate": [
      (m) => {
        m.pkg.production.sha256 = "0".repeat(64);
      },
      /does not match the release manifest/,
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

test("promotion releases the newest staging build's own candidate after proving where it came from", async () => {
  const { manifest, fake } = await staged({
    world: { tags: { "v1.26.0": OTHER, "v1.27.0-staging.850.2": OTHER } },
  });

  const { manifest: resolved, pending } = await resolveWith(fake);
  assert.deepEqual(resolved, manifest);
  assert.equal(pending, true);
  const [attestation] = commands(fake.calls, "attestation");
  assert.equal(
    attestation[3],
    fixturePath("candidate", `${NAME}-1.27.0.pkg.candidate`)
  );

  for (const [flag, value] of [
    ["--repo", REPOSITORY],
    ["--signer-workflow", SIGNER],
    ["--source-digest", SHA],
    ["--source-ref", "refs/heads/main"],
  ]) {
    assert.equal(attestation[attestation.indexOf(flag) + 1], value);
  }

  assert.equal(
    digest(fixturePath("candidate", `${NAME}.pkg`)),
    manifest.pkg.production.sha256
  );

  await publishWith(fake, {
    directory: fixturePath("candidate"),
    channel: "production",
    sourceSha: undefined,
  });
  assert.equal(fake.state.tags["v1.27.0"], SHA);
  const release = fake.state.releases["v1.27.0"];
  assert.equal(release.prerelease, false);
  assert.equal(release.title, `${NAME} v1.27.0`);
  assert.deepEqual(release.assets.toSorted(), [
    `${NAME}.pkg`,
    "release-manifest.json",
  ]);
  assert.equal(
    digest(release.files.find((file) => file.endsWith(`/${NAME}.pkg`))),
    manifest.pkg.production.sha256
  );
  assert.ok(release.notes.startsWith(`Promoted from [\`v1.27.0${SUFFIX}\`]`));
  assert.equal(
    commands(fake.calls, "release")
      .find((call) => call[2] === "create")
      .includes("--prerelease"),
    false
  );
  assert.equal((await resolveWith(fake)).pending, false);
});

test("a release newer than the build since it was resolved stops the release before it is tagged", async () => {
  const { fake } = await staged();
  assert.equal((await resolveWith(fake)).pending, true);
  fake.state.tags["v1.28.0"] = OTHER;
  await assert.rejects(
    publishWith(fake, {
      directory: fixturePath("candidate"),
      channel: "production",
      sourceSha: undefined,
    }),
    new RegExp(
      `v1.27.0${SUFFIX} cannot be released: 1.27.0 is not newer than the latest release 1.28.0`
    )
  );
  assert.equal(fake.state.tags["v1.27.0"], undefined);
  assert.equal(fake.state.releases["v1.27.0"], undefined);
});

test("promotion takes an explicit staging version", async () => {
  const { fake } = await staged();
  assert.equal(
    (await resolveWith(fake, { version: `1.27.0${SUFFIX}` })).manifest
      .stagingTag,
    `v1.27.0${SUFFIX}`
  );
  await assert.rejects(
    resolveWith(fake, { version: "1.26.1-rc.3" }),
    /has no promotion candidate/
  );
});

test("promotion refuses a build it cannot vouch for", async (t) => {
  await t.test("environment without reviewers", async () => {
    const { fake } = await staged({ world: { environment: [] } });
    await assert.rejects(
      resolveWith(fake),
      /must exist and require a reviewer/
    );
    assert.deepEqual(
      fake.calls.map((call) => call[1]),
      ["api"]
    );
  });
  await t.test("no staging build", async () => {
    await assert.rejects(
      resolveWith(world({ tags: { "v1.26.0": OTHER } })),
      /has no staging build/
    );
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
    writeFileSync(
      fake.state.releases[manifest.stagingTag].files.find((file) =>
        file.endsWith(".pkg.candidate")
      ),
      "tampered"
    );
    await assert.rejects(
      resolveWith(fake),
      /does not match the release manifest/
    );
  });
  await t.test("not newer than the latest release", async () => {
    const { fake } = await staged({ world: { tags: { "v1.28.0": OTHER } } });
    await assert.rejects(
      resolveWith(fake),
      /1\.27\.0 is not newer than the latest release 1\.28\.0/
    );
  });
  await t.test("its version released from another commit", async () => {
    const { fake } = await staged({ world: { tags: { "v1.27.0": OTHER } } });
    await assert.rejects(
      resolveWith(fake),
      /v1\.27\.0 is already released from another commit/
    );
  });
});

test("a library is staged and promoted by its tags alone", async () => {
  const library = { library: true };

  const manifest = await collectBuild({
    ...library,
    stagingPackage: undefined,
    productionPackage: undefined,
  });

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
  await publishWith(fake, {
    ...library,
    directory: fixturePath("candidate"),
    channel: "production",
    sourceSha: undefined,
  });
  assert.equal(fake.state.tags["v1.27.0"], SHA);
  assert.deepEqual(fake.state.releases["v1.27.0"].assets, [
    "release-manifest.json",
  ]);
  await assert.rejects(resolveWith(fake), /kind swift-library/);
});

const SKIP_NOTE = "Promoted without a check of the time on staging.";

/** The GitHub reads only the staging age check makes. */
const soakReads = (calls) =>
  calls.filter((call) =>
    call.some((arg) =>
      /\/pulls$|\?per_page=100&page=|\/releases\/tags\//.test(arg)
    )
  );

test("a reason skips the check without reading GitHub for it, and the release notes keep the reason", async () => {
  const { fake } = await soaking();
  const reason = "hotfix for a crash";

  const { pending, overridden, soak } = await soakWith(fake, 60, {
    skipMinimumAge: `  ${reason}  `,
  });

  assert.equal(pending, true);
  assert.equal(overridden, true);
  assert.equal(soak, undefined);
  assert.deepEqual(soakReads(fake.calls), []);
  assert.deepEqual(
    JSON.parse(
      readFileSync(
        fixturePath("candidate", "staging-age-override.json"),
        "utf-8"
      )
    ),
    { reason }
  );
  await publishWith(fake, {
    directory: fixturePath("candidate"),
    channel: "production",
    sourceSha: undefined,
  });
  const { notes } = fake.state.releases["v1.27.0"];
  assert.equal(notes.split(`${SKIP_NOTE} Reason: ${reason}`).length, 2);
});

test("without a reason, the release notes say nothing about a skip", async () => {
  const { fake } = await soaking();
  assert.equal((await soakWith(fake, 200)).overridden, false);
  assert.throws(
    () => readFileSync(fixturePath("candidate", "staging-age-override.json")),
    { code: "ENOENT" }
  );
  await publishWith(fake, {
    directory: fixturePath("candidate"),
    channel: "production",
    sourceSha: undefined,
  });
  assert.ok(!fake.state.releases["v1.27.0"].notes.includes(SKIP_NOTE));
});

/** v1.26.1 released at minute 120, between resolution and approval; LATER restages the candidate at minute 130. */
const LATER = "v1.27.0-staging.950.1";
const publishedLater = { "v1.26.1": at(120), [LATER]: at(130) };

const promoteWith = (fake, minutes) =>
  publishWith(fake, {
    directory: fixturePath("candidate"),
    channel: "production",
    sourceSha: undefined,
    now: T0 + minutes * 60_000,
  });

test("a release between resolution and approval makes publishing check the time on staging again", async () => {
  const { fake } = await soaking({ published: publishedLater });
  assert.equal((await soakWith(fake, 111)).overridden, false);
  assert.deepEqual(
    JSON.parse(
      readFileSync(fixturePath("candidate", "staging-age-check.json"), "utf-8")
    ),
    { baseline: "v1.26.0", minimum: 3_600_000 }
  );
  fake.state.tags["v1.26.1"] = OTHER;
  const error = await promoteWith(fake, 150).catch((error_) => error_);
  assert.match(
    error.message,
    /the time on staging was measured from v1\.26\.0, and v1\.26\.1 has been released since, so it was checked again from v1\.26\.1\./
  );
  assert.match(
    error.message,
    /\n- #95 fix: drain the queue: on staging none, minimum 1h\n- #96 feat: stage every main push: on staging none, minimum 1h\n/
  );
  assert.match(
    error.message,
    /To promote now, run the promotion again with skip-minimum-age-reason\.$/
  );
  assert.equal(fake.state.tags["v1.27.0"], undefined);
  assert.equal(fake.state.releases["v1.27.0"], undefined);

  // A later staging build carries both changes; their time counts from it.
  fake.state.tags[LATER] = SHA;
  await assert.rejects(
    promoteWith(fake, 189),
    /- #96 feat: stage every main push: on staging 59m, minimum 1h\n/
  );
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
  assert.throws(
    () => readFileSync(fixturePath("candidate", "staging-age-check.json")),
    { code: "ENOENT" }
  );
  fake.state.tags["v1.26.1"] = OTHER;
  await promoteWith(fake, 150);
  assert.ok(
    fake.state.releases["v1.27.0"].notes.includes(`${SKIP_NOTE} Reason: hotfix`)
  );
});

test("a reason gets past anything that would stop the check", async (t) => {
  await t.test("a latest release with nothing to measure from", async () => {
    const { fake } = await soaking({ published: { "v1.26.0": undefined } });
    assert.equal(
      (await soakWith(fake, 600, { skipMinimumAge: "hotfix" })).overridden,
      true
    );
  });
  await t.test("an invalid minimum", async () => {
    const { fake } = await soaking();
    await assert.rejects(
      soakWith(fake, 600, { minimumAge: "2 hours" }),
      /cannot check the time on staging\. Invalid minimum staging age "2 hours".*\nTo promote now, set skip-minimum-age-reason\./s
    );
    assert.equal(
      (
        await soakWith(fake, 600, {
          minimumAge: "2 hours",
          skipMinimumAge: "hotfix",
        })
      ).overridden,
      true
    );
  });
  await t.test("a refused pull request read", async () => {
    const { fake } = await soaking({
      forbidden: "gh: Resource not accessible by integration (HTTP 403)",
    });

    assert.equal(
      (await soakWith(fake, 600, { skipMinimumAge: "hotfix" })).overridden,
      true
    );
  });
});

registerDependenciesCases(test, fixture);

registerSoakCases(test, fixture);

test("a skip reason that starts with a dash is read as the reason, not an option", () => {
  const script = new URL(
    "../.github/package-release/swift-release.mjs",
    import.meta.url
  ).pathname;

  // An unknown command fails after the arguments parse; a parse failure would name the option instead.
  const run = (args) => {
    try {
      execFileSync(process.execPath, [script, "no-such-command", ...args], {
        encoding: "utf-8",
        stdio: "pipe",
      });
    } catch (error) {
      return error.stderr;
    }
  };

  assert.match(
    run(["--skip-minimum-age-reason=- fix a crash"]),
    /Usage: swift-release\.mjs/
  );
  assert.match(
    run(["--skip-minimum-age-reason", "- fix a crash"]),
    /ERR_PARSE_ARGS_INVALID_OPTION_VALUE|ambiguous/
  );
});
