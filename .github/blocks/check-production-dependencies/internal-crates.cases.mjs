import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  auditProductionDependencies,
  checkProductionDependencies,
  readProductionInputs,
  renderProductionReport,
} from "./check-production-dependencies.mjs";

const exec = promisify(execFile);
const name = "@photon-hq/example";
const indirect = "@photon-hq/indirect";
const crateCommit = "c".repeat(40);
const errorCommit = "e".repeat(40);

const metadata = () => ({
  versions: { "1.0.0": {}, "2.0.0": {} },
  "dist-tags": { latest: "2.0.0-staging.1" },
});

const fixture = (version = "1.0.0") => ({
  source: "fixture",
  workspace: { packages: ["apps/*"], catalog: { [name]: version } },
  manifests: {
    ".": { name: "root", private: true },
    "apps/example": { name: "app", dependencies: { [name]: "catalog:" } },
  },
  lockfile: {
    lockfileVersion: "9.0",
    catalogs: { default: { [name]: { specifier: version, version } } },
    importers: {
      ".": {},
      "apps/example": {
        dependencies: { [name]: { specifier: "catalog:", version } },
      },
    },
    packages: { [`${name}@${version}`]: {}, [`${indirect}@1.0.0`]: {} },
    snapshots: {
      [`${name}@${version}`]: { dependencies: { [indirect]: "1.0.0" } },
      [`${indirect}@1.0.0`]: {},
    },
  },
});

const lockedCrate = (crate, version, repository, pin, commit, extra = {}) => ({
  name: crate,
  version,
  source: `git+https://github.com/photon-hq/${repository}?${pin}#${commit}`,
  ...extra,
});

const cargoFixture = () => ({
  source: "fixture",
  cargo: {
    lockfile: {
      version: 4,
      package: [
        {
          name: "service",
          version: "0.0.0",
          dependencies: ["photon-example", "serde"],
        },
        { name: "service-api", version: "0.0.0" },
        lockedCrate(
          "photon-example",
          "1.2.0",
          "example",
          "tag=v3.0.0",
          crateCommit,
          { dependencies: ["photon-error"] }
        ),
        lockedCrate(
          "photon-error",
          "0.1.0",
          "error",
          "tag=v0.3.0",
          errorCommit
        ),
        {
          name: "serde",
          version: "1.0.0",
          source: "registry+https://github.com/rust-lang/crates.io-index",
          checksum: "0",
        },
        {
          name: "public",
          version: "1.0.0-rc.1",
          source: `git+https://github.com/someone/public?branch=main#${crateCommit}`,
        },
      ],
    },
    manifests: {
      ".": {
        package: { name: "service", version: "0.0.0" },
        workspace: {
          members: ["crates/*"],
          dependencies: {
            "photon-example": {
              version: "=1.2.0",
              git: "https://github.com/photon-hq/example",
              tag: "v3.0.0",
            },
          },
        },
        dependencies: {
          "photon-example": { workspace: true, features: ["axum"] },
          serde: "1",
        },
      },
      "crates/api": { package: { name: "service-api", version: "0.0.0" } },
    },
  },
});

const releases = {
  "photon-hq/example v3.0.0": {
    draft: false,
    prerelease: false,
    commit: crateCommit,
  },
  "photon-hq/error v0.3.0": {
    draft: false,
    prerelease: false,
    commit: errorCommit,
  },
};

const release = (repository, tag) => releases[`${repository} ${tag}`] ?? null;

const noRegistry = () => {
  throw new Error("a Cargo workspace has no registry packages");
};

export const registerInternalCrateCases = () => {
  test("a Cargo workspace passes when every internal crate, transitive ones included, resolves from a published release tag", async () => {
    const inputs = cargoFixture();
    const before = JSON.stringify(inputs);
    const checked = [];
    assert.deepEqual(
      await checkProductionDependencies(
        inputs,
        noRegistry,
        (repository, tag) => {
          checked.push(`${repository} ${tag}`);

          return release(repository, tag);
        }
      ),
      ["photon-error@0.1.0", "photon-example@1.2.0"]
    );
    assert.deepEqual(checked.toSorted(), Object.keys(releases).toSorted());
    assert.equal(JSON.stringify(inputs), before);
  });

  test("crates resolved from a rev, branch, default branch, staging tag or prerelease version fail without a release lookup", async () => {
    for (const [pin, version, expected] of [
      [`rev=${errorCommit}`, "0.1.0", /at rev e{40}, not a release tag/],
      ["branch=main", "0.1.0", /at branch main, not a release tag/],
      ["", "0.1.0", /at its default branch, not a release tag/],
      [
        "tag=error-staging-0.3.0-staging.1.1",
        "0.1.0",
        /at tag error-staging-0.3.0-staging.1.1, not a release tag/,
      ],
      [
        "tag=v0.3.0",
        "0.1.0-rc.1",
        /photon-error@0.1.0-rc.1: must be an exact stable production version/,
      ],
    ]) {
      const inputs = cargoFixture();
      inputs.cargo.lockfile.package[3] = lockedCrate(
        "photon-error",
        version,
        "error",
        pin,
        errorCommit
      );
      const checked = [];
      await assert.rejects(
        checkProductionDependencies(inputs, noRegistry, (repository, tag) => {
          checked.push(repository);

          return release(repository, tag);
        }),
        expected
      );
      assert.deepEqual(checked, ["photon-hq/example"]);
    }
  });

  test("declared internal crates must pin a release tag and an exact version that Cargo.lock resolves", async () => {
    for (const [change, expected] of [
      [
        (pin) => delete pin.version,
        /Cargo.toml: photon-example must require an exact stable version \(=X.Y.Z\), not any version/,
      ],
      [
        (pin) => (pin.version = "1.2"),
        /must require an exact stable version \(=X.Y.Z\), not 1.2/,
      ],
      [
        (pin) => (pin.version = "=1.2.0-rc.1"),
        /must require an exact stable version/,
      ],
      [
        (pin) => {
          delete pin.tag;
          pin.rev = crateCommit;
        },
        /must pin a release tag vX.Y.Z of photon-hq\/example, not rev c{40}/,
      ],
      [
        (pin) => (pin.branch = "main"),
        /must pin a release tag vX.Y.Z of photon-hq\/example, not branch main/,
      ],
      [
        (pin) => (pin.tag = "v3.1.0"),
        /photon-example =1.2.0 at v3.1.0 has no matching Cargo.lock package/,
      ],
      [
        (pin) => (pin.version = "=1.3.0"),
        /photon-example =1.3.0 at v3.0.0 has no matching Cargo.lock package/,
      ],
    ]) {
      const inputs = cargoFixture();
      change(
        inputs.cargo.manifests["."].workspace.dependencies["photon-example"]
      );
      await assert.rejects(
        checkProductionDependencies(inputs, noRegistry, release),
        expected
      );
    }
  });

  test("dev, build, target and renamed declarations in every workspace package are audited", async () => {
    const pin = {
      git: "ssh://git@GitHub.com/Photon-HQ/Example.git",
      branch: "main",
    };

    for (const [declare, expected] of [
      [
        (manifest) =>
          (manifest["dev-dependencies"] = { "photon-example": pin }),
        /crates\/api\/Cargo.toml: photon-example must pin a release tag/,
      ],
      [
        (manifest) =>
          (manifest["build-dependencies"] = { "photon-example": pin }),
        /crates\/api\/Cargo.toml: photon-example must pin a release tag/,
      ],
      [
        (manifest) =>
          (manifest.target = {
            "cfg(unix)": { dependencies: { "photon-example": pin } },
          }),
        /crates\/api\/Cargo.toml: photon-example must pin a release tag/,
      ],
      [
        (manifest) =>
          (manifest.dependencies = {
            example: { ...pin, package: "photon-example" },
          }),
        /crates\/api\/Cargo.toml: photon-example must pin a release tag/,
      ],
    ]) {
      const inputs = cargoFixture();
      declare(inputs.cargo.manifests["crates/api"]);
      await assert.rejects(
        checkProductionDependencies(inputs, noRegistry, release),
        expected
      );
    }

    // A manifest outside the workspace is not part of what Cargo.lock builds.
    const inputs = cargoFixture();
    inputs.cargo.manifests["compat/consumer"] = {
      package: { name: "compat-consumer" },
      dependencies: { "photon-example": pin },
    };
    await checkProductionDependencies(inputs, noRegistry, release);
  });

  test("a Cargo.lock of an unknown format or naming a package without a manifest fails closed", async () => {
    for (const [change, expected] of [
      [
        (cargo) => (cargo.lockfile.version = 5),
        /Expected a Cargo.lock of version 3 or 4/,
      ],
      [
        (cargo) => delete cargo.lockfile.version,
        /Expected a Cargo.lock of version 3 or 4/,
      ],
      [
        (cargo) => delete cargo.lockfile.package,
        /Expected a Cargo.lock of version 3 or 4/,
      ],
      [
        (cargo) => delete cargo.manifests["crates/api"],
        /service-api: Cargo.lock package has no Cargo.toml in the source/,
      ],
    ]) {
      const inputs = cargoFixture();
      change(inputs.cargo);
      await assert.rejects(
        checkProductionDependencies(inputs, noRegistry, release),
        expected
      );
    }
  });

  test("a crate is production only when its tag is a published release at the resolved commit", async () => {
    for (const [load, production, reason, finding] of [
      [
        () => null,
        false,
        "Not released",
        /photon-hq\/error has no release v0.3.0/,
      ],
      [
        () => ({ draft: false, prerelease: true, commit: errorCommit }),
        false,
        "Not a production release",
        /release v0.3.0 is a draft or prerelease/,
      ],
      [
        () => ({ draft: true, prerelease: false, commit: errorCommit }),
        false,
        "Not a production release",
        /release v0.3.0 is a draft or prerelease/,
      ],
      [
        () => ({ draft: false, prerelease: false, commit: crateCommit }),
        false,
        "Release tag is at another commit",
        /tag v0.3.0 is at c{40}, but Cargo.lock resolved e{40}/,
      ],
      [
        () => Promise.reject(new Error("repository returned HTTP 404")),
        null,
        "Release lookup failed",
        /photon-hq\/error: repository returned HTTP 404/,
      ],
    ]) {
      const report = await auditProductionDependencies(
        cargoFixture(),
        noRegistry,
        (repository, tag) =>
          repository === "photon-hq/error" ? load() : release(repository, tag)
      );

      assert.equal(report.packages, undefined);
      assert.deepEqual(report.crates, [
        {
          name: "photon-error",
          version: "0.1.0",
          repository: "photon-hq/error",
          reference: "tag v0.3.0",
          production,
          reason,
        },
        {
          name: "photon-example",
          version: "1.2.0",
          repository: "photon-hq/example",
          reference: "tag v3.0.0",
          production: true,
          reason: "Production release",
        },
      ]);
      assert.equal(report.errors.length, 1);
      assert.match(report.errors[0], finding);
      const body = renderProductionReport(report);
      assert.match(
        body,
        /\| Internal crate \| Version \| Source \| Prod\? \| Reason \|/
      );
      assert.ok(!body.includes("Internal package"));
      assert.match(body, production === null ? /❓ Unknown/ : /❌ No/);
      assert.match(body, /photon-hq\/example tag v3.0.0 \| ✅ Yes/);
    }
  });

  test("a source with both workspaces is audited for packages and crates", async () => {
    const inputs = { ...fixture(), cargo: cargoFixture().cargo };
    assert.deepEqual(
      await checkProductionDependencies(inputs, metadata, release),
      [
        `${name}@1.0.0`,
        `${indirect}@1.0.0`,
        "photon-error@0.1.0",
        "photon-example@1.2.0",
      ]
    );

    const body = renderProductionReport(
      await auditProductionDependencies(inputs, metadata, release)
    );

    assert.match(body, /check passed/);
    assert.match(body, /\| Internal package \|/);
    assert.match(body, /\| Internal crate \|/);
    await assert.rejects(
      checkProductionDependencies(
        { ...fixture("1.0.0-staging.1"), cargo: inputs.cargo },
        metadata,
        release
      ),
      /example@1.0.0-staging.1/
    );
    await assert.rejects(
      checkProductionDependencies(inputs, metadata, () => null),
      /has no release/
    );
    await assert.rejects(
      checkProductionDependencies({ source: "fixture" }, metadata, release),
      /No pnpm workspace or Cargo workspace/
    );
  });

  test("a Rust-only commit is read from Git; a commit with neither workspace or without Cargo.lock is refused", async (t) => {
    const root = await mkdtemp(nodePath.join(tmpdir(), "production-cargo-"));
    t.after(() => rm(root, { recursive: true, force: true }));

    const git = async (...args) =>
      (await exec("git", args, { cwd: root })).stdout;

    const commit = async (message) => {
      await git("add", "-A");
      await git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        message
      );

      return (await git("rev-parse", "HEAD")).trim();
    };

    await git("init", "-q");
    await writeFile(nodePath.join(root, "README.md"), "no workspace\n");
    const empty = await commit("no workspace");
    await mkdir(nodePath.join(root, "crates/api"), { recursive: true });
    await mkdir(nodePath.join(root, "fixtures/broken"), { recursive: true });
    await writeFile(
      nodePath.join(root, "Cargo.toml"),
      `[package]\nname = "service"\nversion = "0.0.0"\n\n[workspace]\nmembers = ["crates/*"]\n\n[workspace.dependencies]\nphoton-error = { version = "=0.1.0", git = "https://github.com/photon-hq/error", rev = "${errorCommit}" }\n\n[dependencies]\nphoton-error = { workspace = true }\n`
    );
    await writeFile(
      nodePath.join(root, "crates/api/Cargo.toml"),
      `[package]\nname = "service-api"\nversion = "0.0.0"\n`
    );
    await writeFile(
      nodePath.join(root, "fixtures/broken/Cargo.toml"),
      "not = [toml"
    );
    const unlocked = await commit("manifest without a lockfile");

    const lock = (pin) =>
      `version = 4\n\n[[package]]\nname = "photon-error"\nversion = "0.1.0"\nsource = "git+https://github.com/photon-hq/error?${pin}#${errorCommit}"\n\n[[package]]\nname = "service"\nversion = "0.0.0"\ndependencies = ["photon-error"]\n\n[[package]]\nname = "service-api"\nversion = "0.0.0"\n`;

    await writeFile(
      nodePath.join(root, "Cargo.lock"),
      lock(`rev=${errorCommit}`)
    );
    const pinnedByRev = await commit("rev pin");
    await writeFile(
      nodePath.join(root, "Cargo.toml"),
      (await readFile(nodePath.join(root, "Cargo.toml"), "utf-8")).replace(
        `rev = "${errorCommit}"`,
        'tag = "v0.3.0"'
      )
    );
    await writeFile(nodePath.join(root, "Cargo.lock"), lock("tag=v0.3.0"));
    await commit("release tag pin");

    await assert.rejects(
      readProductionInputs(root, empty),
      /neither a pnpm workspace nor a Cargo workspace/
    );
    await assert.rejects(
      readProductionInputs(root, unlocked),
      /needs a committed root Cargo.lock/
    );
    const inputs = await readProductionInputs(root, pinnedByRev);
    assert.equal(inputs.workspace, undefined);
    assert.deepEqual(Object.keys(inputs.cargo.manifests).toSorted(), [
      ".",
      "crates/api",
    ]);
    await assert.rejects(
      checkProductionDependencies(inputs, noRegistry, release),
      /Cargo.toml: photon-error must pin a release tag vX.Y.Z of photon-hq\/error, not rev/
    );
    assert.deepEqual(
      await checkProductionDependencies(
        await readProductionInputs(root, "HEAD"),
        noRegistry,
        release
      ),
      ["photon-error@0.1.0"]
    );
    assert.deepEqual(
      await checkProductionDependencies(
        await readProductionInputs(root),
        noRegistry,
        release
      ),
      ["photon-error@0.1.0"]
    );
  });
};
