import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import {
  auditProductionDependencies,
  checkProductionDependencies,
  readProductionInputs,
  renderProductionReport,
} from "./check-production-dependencies.mjs";

const exec = promisify(execFile);
const name = "@photon-hq/example";
const indirect = "@photon-hq/indirect";
const metadata = async () => ({
  versions: { "1.0.0": {}, "2.0.0": {} },
  "dist-tags": { latest: "2.0.0-staging.1" },
});
function fixture(version = "1.0.0") {
  return {
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
  };
}

test("checks exact published pins, including transitives, without selecting a newer version", async () => {
  const inputs = fixture();
  const before = JSON.stringify(inputs);
  const checked = [];
  assert.deepEqual(
    await checkProductionDependencies(inputs, async (pkg) => {
      checked.push(pkg);
      return metadata();
    }),
    [`${name}@1.0.0`, `${indirect}@1.0.0`]
  );
  assert.deepEqual(checked.sort(), [name, indirect]);
  assert.equal(JSON.stringify(inputs), before);
});

test("staging, feature, beta, rc, ranges, tags, and non-registry pins fail without resolution", async () => {
  for (const version of [
    "1.0.0-staging.1",
    "1.0.0-formatting.2",
    "1.0.0-beta.1",
    "1.0.0-rc.1",
    "^1.0.0",
    "latest",
    "file:../example",
    "workspace:*",
  ]) {
    const inputs = fixture(version);
    const before = JSON.stringify(inputs);
    const checked = [];
    await assert.rejects(
      checkProductionDependencies(inputs, async (pkg) => {
        checked.push(pkg);
        return metadata();
      }),
      /exact stable production version/
    );
    assert.deepEqual(checked, [indirect]);
    assert.equal(JSON.stringify(inputs), before);
  }
});

test("stable build metadata is allowed but normalized prefixes are not exact pins", async () => {
  await checkProductionDependencies(fixture("1.0.0+build.1"), async () => ({
    versions: { "1.0.0": {}, "1.0.0+build.1": {} },
  }));
  await assert.rejects(
    checkProductionDependencies(fixture("v1.0.0"), metadata),
    /exact stable production version/
  );
});

test("indirect and peer-context prereleases cannot hide behind a stable direct catalog", async () => {
  for (const section of ["packages", "snapshots"]) {
    const inputs = fixture();
    inputs.lockfile[section][`${indirect}@2.0.0-staging.1(peer@1.0.0)`] = {};
    await assert.rejects(
      checkProductionDependencies(inputs, metadata),
      /indirect@2.0.0-staging.1/
    );
  }
  const inputs = fixture();
  inputs.lockfile.snapshots["public@1.0.0(@photon-hq/indirect@2.0.0-rc.1)"] =
    {};
  await assert.rejects(
    checkProductionDependencies(inputs, metadata),
    /indirect@2.0.0-rc.1/
  );
});

test("checks optional dependency edges even when their package records are absent", async () => {
  const inputs = fixture();
  inputs.lockfile.snapshots[`${name}@1.0.0`].optionalDependencies = {
    [indirect]: "2.0.0-staging.1",
  };
  await assert.rejects(
    checkProductionDependencies(inputs, metadata),
    /indirect@2.0.0-staging.1/
  );
});

test("stable peer suffixes and Buf commit builds are allowed", async () => {
  const inputs = fixture();
  inputs.lockfile.importers["apps/example"].dependencies[name].version =
    "1.0.0(@photon-hq/indirect@1.0.0)";
  inputs.lockfile.snapshots[`${name}@1.0.0(@photon-hq/indirect@1.0.0)`] = {};
  inputs.workspace.catalog["@buf/photon-hq_example.bufbuild_es"] =
    "2.0.0-20260101.1";
  inputs.lockfile.packages[
    "@buf/photon-hq_example.bufbuild_es@2.0.0-20260101.1"
  ] = {};
  await checkProductionDependencies(inputs, metadata);
});

test("dev, optional, and workspace peer declarations must match their locked stable version", async () => {
  for (const field of [
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const inputs = fixture();
    const manifest = inputs.manifests["apps/example"];
    manifest[field] = { [name]: "1.0.0-staging.1" };
    await assert.rejects(
      checkProductionDependencies(inputs, metadata),
      /exact stable production version/
    );
  }
});

test("rejects stale catalogs/importers and missing lockfile records", async () => {
  for (const change of [
    (i) => {
      i.lockfile.catalogs.default[name].specifier = "2.0.0";
    },
    (i) => {
      delete i.lockfile.catalogs.default[name];
    },
    (i) => {
      i.lockfile.importers["apps/example"].dependencies[name].version = "2.0.0";
    },
    (i) => {
      delete i.lockfile.importers["apps/example"];
    },
    (i) => {
      delete i.lockfile.packages[`${indirect}@1.0.0`];
    },
    (i) => {
      delete i.lockfile.snapshots[`${indirect}@1.0.0`];
    },
    (i) => {
      delete i.manifests["apps/example"];
    },
    (i) => {
      i.lockfile.lockfileVersion = "8.0";
    },
    (i) => {
      i.lockfile.catalogs.removed = {
        [name]: { specifier: "1.0.0", version: "1.0.0" },
      };
    },
  ]) {
    const inputs = fixture();
    change(inputs);
    await assert.rejects(
      checkProductionDependencies(inputs, metadata),
      /lockfile/
    );
  }
});

test("named catalogs are checked and internal package aliases fail closed", async () => {
  const inputs = fixture();
  inputs.workspace.catalogs = { stable: inputs.workspace.catalog };
  inputs.workspace.catalog = {};
  inputs.lockfile.catalogs.stable = inputs.lockfile.catalogs.default;
  delete inputs.lockfile.catalogs.default;
  inputs.manifests["apps/example"].dependencies[name] = "catalog:stable";
  inputs.lockfile.importers["apps/example"].dependencies[name].specifier =
    "catalog:stable";
  await checkProductionDependencies(inputs, metadata);
  inputs.manifests["apps/example"].dependencies.alias =
    `npm:${name}@1.0.0-staging.1`;
  await assert.rejects(
    checkProductionDependencies(inputs, metadata),
    /internal package aliases/
  );
});

test("the strict check requires a published non-deprecated stable version and rejects lookup failures", async () => {
  for (const load of [
    async () => ({ versions: { "2.0.0": {} } }),
    async () => ({ versions: { "1.0.0": { deprecated: "withdrawn" } } }),
    async () => {
      throw new Error("registry returned HTTP 403");
    },
  ]) {
    await assert.rejects(
      checkProductionDependencies(fixture(), load),
      (error) => {
        assert.match(error.message, /@photon-hq\/example/);
        assert.match(error.message, /@photon-hq\/indirect/);
        assert.match(error.message, /not published|deprecated|HTTP 403/);
        return true;
      }
    );
  }
});

async function writeInputs(root, inputs) {
  await mkdir(join(root, "apps/example"), { recursive: true });
  await writeFile(
    join(root, "pnpm-workspace.yaml"),
    stringify(inputs.workspace)
  );
  await writeFile(join(root, "pnpm-lock.yaml"), stringify(inputs.lockfile));
  for (const [path, manifest] of Object.entries(inputs.manifests))
    await writeFile(join(root, path, "package.json"), JSON.stringify(manifest));
}

test("ref checks the immutable release target, never later main or dirty files, without changing the checkout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "production-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (...args) =>
    (await exec("git", args, { cwd: root })).stdout;
  await writeInputs(root, fixture("1.0.0-staging.1"));
  await git("init", "-q");
  await git("add", ".");
  await git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "staging release target"
  );
  const target = (await git("rev-parse", "HEAD")).trim();
  await writeInputs(root, fixture());
  await git("add", ".");
  await git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "later stable pins"
  );
  await writeFile(join(root, "untracked.txt"), "keep me");
  await writeInputs(root, fixture("2.0.0-staging.1"));
  const before = await git("diff");
  await assert.rejects(
    checkProductionDependencies(
      await readProductionInputs(root, target),
      metadata
    ),
    /example@1.0.0-staging.1/
  );
  await checkProductionDependencies(
    await readProductionInputs(root, "HEAD"),
    metadata
  );
  await assert.rejects(
    checkProductionDependencies(await readProductionInputs(root), metadata),
    /example@2.0.0-staging.1/
  );
  assert.equal(await git("diff"), before);
  assert.equal(await readFile(join(root, "untracked.txt"), "utf8"), "keep me");
});

test("a mixed-channel report lists every detected version once and verifies the stable rows", async () => {
  const inputs = fixture("1.0.0-staging.1");
  inputs.lockfile.snapshots[`${name}@1.0.0-staging.1(peer@1.0.0)`] = {};
  const before = JSON.stringify(inputs);
  const report = await auditProductionDependencies(inputs, metadata);
  assert.deepEqual(report.packages, [
    {
      name,
      version: "1.0.0-staging.1",
      production: false,
      reason: "Not an exact stable version",
    },
    {
      name: indirect,
      version: "1.0.0",
      production: true,
      reason: "Published stable version",
    },
  ]);
  const body = renderProductionReport(report);
  assert.match(body, /\| Internal package \| Version \| Prod\? \| Reason \|/);
  assert.match(body, /1.0.0-staging.1 \| ❌ No/);
  assert.match(body, /1.0.0 \| ✅ Yes/);
  assert.match(body, /check failed/);
  assert.equal(JSON.stringify(inputs), before);
});

test("multiple installed versions of the same internal package get separate rows", async () => {
  const inputs = fixture();
  inputs.lockfile.packages[`${indirect}@2.0.0`] = {};
  inputs.lockfile.snapshots[`${indirect}@2.0.0`] = {};
  const report = await auditProductionDependencies(inputs, metadata);
  assert.deepEqual(
    report.packages
      .filter((entry) => entry.name === indirect)
      .map((entry) => entry.version),
    ["1.0.0", "2.0.0"]
  );
});

test("registry outages produce Unknown rows while unpublished/deprecated versions produce No", async () => {
  for (const [load, production, reason] of [
    [
      async () => {
        throw new Error("HTTP 403");
      },
      null,
      "Registry lookup failed",
    ],
    [async () => ({ versions: {} }), false, "Not published"],
    [
      async () => ({ versions: { "1.0.0": { deprecated: "withdrawn" } } }),
      false,
      "Deprecated",
    ],
  ]) {
    const report = await auditProductionDependencies(fixture(), load);
    assert.equal(report.packages.length, 2);
    assert.ok(
      report.packages.every(
        (entry) => entry.production === production && entry.reason === reason
      )
    );
    assert.ok(report.errors.length > 0);
    assert.match(
      renderProductionReport(report),
      production === null ? /❓ Unknown/ : /❌ No/
    );
  }
});

test("comment rendering escapes Markdown, HTML, newlines, and mentions in detected data", () => {
  const body = renderProductionReport({
    source: "HEAD",
    packages: [
      {
        name: "@photon-hq/a|@someone\n<script>",
        version: "`1.0.0`",
        production: false,
        reason: "[link](url)",
      },
    ],
    errors: ["@someone <bad>"],
  });
  assert.ok(!body.includes("@someone"));
  assert.ok(!body.includes("<script>"));
  assert.match(body, /a&#124;&#64;someone&#10;&#60;script&#62;/);
});

test("CLI writes a report on input failure and still exits nonzero", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "production-report-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "report.md");
  await assert.rejects(
    exec(
      process.execPath,
      [
        new URL("./check-production-dependencies.mjs", import.meta.url)
          .pathname,
        "--ref",
        "missing-ref",
        "--report-file",
        path,
      ],
      { cwd: root }
    ),
    (error) => error.code === 1
  );
  const body = await readFile(path, "utf8");
  assert.match(body, /check failed/);
  assert.match(body, /No package inventory is available/);
});

test("internal aliases are included in the inventory even when the lockfile is incomplete", async () => {
  const inputs = fixture();
  inputs.manifests["apps/example"].dependencies.alias =
    "npm:@photon-hq/hidden@1.0.0-staging.1";
  const report = await auditProductionDependencies(inputs, metadata);
  assert.ok(
    report.packages.some(
      (entry) =>
        entry.name === "@photon-hq/hidden" &&
        entry.version === "1.0.0-staging.1" &&
        entry.production === false
    )
  );
  assert.ok(
    report.errors.some((error) => error.includes("aliases are not supported"))
  );
});

test("workspace source packages are not registry releases, but their internal dependencies are checked", async () => {
  const inputs = fixture();
  const local = "@photon-hq/local-contract";
  inputs.workspace.packages.push("packages/*");
  inputs.manifests["packages/local-contract"] = {
    name: local, version: "0.0.0", dependencies: { [name]: "1.0.0" },
  };
  inputs.lockfile.importers["packages/local-contract"] = {
    dependencies: { [name]: { specifier: "1.0.0", version: "1.0.0" } },
  };
  inputs.manifests["apps/example"].dependencies[local] = "workspace:*";
  inputs.lockfile.importers["apps/example"].dependencies[local] = {
    specifier: "workspace:*", version: "link:../../packages/local-contract",
  };
  const report = await auditProductionDependencies(inputs, metadata);
  assert.deepEqual(report.errors, []);
  assert.ok(!report.packages.some(row => row.name === local));
  assert.ok(report.packages.some(row => row.name === name && row.production));
  inputs.manifests["packages/local-contract"].dependencies[name] = "2.0.0-staging.1";
  await assert.rejects(checkProductionDependencies(inputs, metadata), /2.0.0-staging.1/);
});

test("workspace links must resolve to the declared package inside the reviewed workspace", async () => {
  for (const target of ["link:../../../outside", "link:../../packages/missing", "link:../../packages/wrong"]) {
    const inputs = fixture();
    inputs.manifests["packages/wrong"] = { name: "@photon-hq/different-package" };
    inputs.manifests["apps/example"].dependencies[name] = "workspace:*";
    inputs.lockfile.importers["apps/example"].dependencies[name] = { specifier: "workspace:*", version: target };
    await assert.rejects(checkProductionDependencies(inputs, metadata), /exact stable production version/);
  }
});

test("the action selects main, hotfix and manual commits without accepting malformed tags", async (t) => {
  const action = parse(await readFile(new URL("./action.yaml", import.meta.url), "utf8"));
  const step = action.runs.steps.at(-1);
  const root = await mkdtemp(join(tmpdir(), "production-action-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Stub the CLI so the real action shell can be exercised without registry calls.
  await writeFile(join(root, "check-production-dependencies.mjs"), "console.log(process.argv.slice(2).join(' '));\n");
  const sha = "a".repeat(40), baseline = "b".repeat(40);
  for (const [tag, ref, expected] of [[`main-${sha}`, "", sha], [`hotfix-${baseline}-${sha}`, "", sha], ["", "main", "main"]]) {
    const { stdout } = await exec("bash", ["-c", step.run], { env: { ...process.env, IMAGE_TAG: tag, SOURCE_REF: ref, CHECKER_PATH: root } });
    assert.equal(stdout.trim(), `--ref ${expected}`);
  }
  for (const [tag, ref] of [["", ""], ["latest", ""], ["main-abcd", ""], [`main-${sha}`, "main"], [`hotfix-bad-${sha}`, ""]]) {
    await assert.rejects(exec("bash", ["-c", step.run], { env: { ...process.env, IMAGE_TAG: tag, SOURCE_REF: ref, CHECKER_PATH: root } }));
  }
});

const crateCommit = "c".repeat(40);
const errorCommit = "e".repeat(40);
const lockedCrate = (crate, version, repository, pin, commit, extra = {}) => ({
  name: crate,
  version,
  source: `git+https://github.com/photon-hq/${repository}?${pin}#${commit}`,
  ...extra,
});
function cargoFixture() {
  return {
    source: "fixture",
    cargo: {
      lockfile: {
        version: 4,
        package: [
          { name: "service", version: "0.0.0", dependencies: ["photon-example", "serde"] },
          { name: "service-api", version: "0.0.0" },
          lockedCrate("photon-example", "1.2.0", "example", "tag=v3.0.0", crateCommit, { dependencies: ["photon-error"] }),
          lockedCrate("photon-error", "0.1.0", "error", "tag=v0.3.0", errorCommit),
          { name: "serde", version: "1.0.0", source: "registry+https://github.com/rust-lang/crates.io-index", checksum: "0" },
          { name: "public", version: "1.0.0-rc.1", source: `git+https://github.com/someone/public?branch=main#${crateCommit}` },
        ],
      },
      manifests: {
        ".": {
          package: { name: "service", version: "0.0.0" },
          workspace: {
            members: ["crates/*"],
            dependencies: {
              "photon-example": { version: "=1.2.0", git: "https://github.com/photon-hq/example", tag: "v3.0.0" },
            },
          },
          dependencies: { "photon-example": { workspace: true, features: ["axum"] }, serde: "1" },
        },
        "crates/api": { package: { name: "service-api", version: "0.0.0" } },
      },
    },
  };
}
const releases = {
  "photon-hq/example v3.0.0": { draft: false, prerelease: false, commit: crateCommit },
  "photon-hq/error v0.3.0": { draft: false, prerelease: false, commit: errorCommit },
};
const release = async (repository, tag) => releases[`${repository} ${tag}`] ?? null;
const noRegistry = async () => {
  throw new Error("a Cargo workspace has no registry packages");
};

test("a Cargo workspace passes when every internal crate, transitive ones included, resolves from a published release tag", async () => {
  const inputs = cargoFixture();
  const before = JSON.stringify(inputs);
  const checked = [];
  assert.deepEqual(
    await checkProductionDependencies(inputs, noRegistry, async (repository, tag) => {
      checked.push(`${repository} ${tag}`);
      return release(repository, tag);
    }),
    ["photon-error@0.1.0", "photon-example@1.2.0"]
  );
  assert.deepEqual(checked.sort(), Object.keys(releases).sort());
  assert.equal(JSON.stringify(inputs), before);
});

test("crates resolved from a rev, branch, default branch, staging tag or prerelease version fail without a release lookup", async () => {
  for (const [pin, version, expected] of [
    [`rev=${errorCommit}`, "0.1.0", /at rev e{40}, not a release tag/],
    ["branch=main", "0.1.0", /at branch main, not a release tag/],
    ["", "0.1.0", /at its default branch, not a release tag/],
    ["tag=error-staging-0.3.0-staging.1.1", "0.1.0", /at tag error-staging-0.3.0-staging.1.1, not a release tag/],
    ["tag=v0.3.0", "0.1.0-rc.1", /photon-error@0.1.0-rc.1: must be an exact stable production version/],
  ]) {
    const inputs = cargoFixture();
    inputs.cargo.lockfile.package[3] = lockedCrate("photon-error", version, "error", pin, errorCommit);
    const checked = [];
    await assert.rejects(
      checkProductionDependencies(inputs, noRegistry, async (repository, tag) => {
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
    [(pin) => delete pin.version, /Cargo.toml: photon-example must require an exact stable version \(=X.Y.Z\), not any version/],
    [(pin) => (pin.version = "1.2"), /must require an exact stable version \(=X.Y.Z\), not 1.2/],
    [(pin) => (pin.version = "=1.2.0-rc.1"), /must require an exact stable version/],
    [(pin) => { delete pin.tag; pin.rev = crateCommit; }, /must pin a release tag vX.Y.Z of photon-hq\/example, not rev c{40}/],
    [(pin) => (pin.branch = "main"), /must pin a release tag vX.Y.Z of photon-hq\/example, not branch main/],
    [(pin) => (pin.tag = "v3.1.0"), /photon-example =1.2.0 at v3.1.0 has no matching Cargo.lock package/],
    [(pin) => (pin.version = "=1.3.0"), /photon-example =1.3.0 at v3.0.0 has no matching Cargo.lock package/],
  ]) {
    const inputs = cargoFixture();
    change(inputs.cargo.manifests["."].workspace.dependencies["photon-example"]);
    await assert.rejects(checkProductionDependencies(inputs, noRegistry, release), expected);
  }
});

test("dev, build, target and renamed declarations in every workspace package are audited", async () => {
  const pin = { git: "ssh://git@GitHub.com/Photon-HQ/Example.git", branch: "main" };
  for (const [declare, expected] of [
    [(manifest) => (manifest["dev-dependencies"] = { "photon-example": pin }), /crates\/api\/Cargo.toml: photon-example must pin a release tag/],
    [(manifest) => (manifest["build-dependencies"] = { "photon-example": pin }), /crates\/api\/Cargo.toml: photon-example must pin a release tag/],
    [(manifest) => (manifest.target = { "cfg(unix)": { dependencies: { "photon-example": pin } } }), /crates\/api\/Cargo.toml: photon-example must pin a release tag/],
    [(manifest) => (manifest.dependencies = { example: { ...pin, package: "photon-example" } }), /crates\/api\/Cargo.toml: photon-example must pin a release tag/],
  ]) {
    const inputs = cargoFixture();
    declare(inputs.cargo.manifests["crates/api"]);
    await assert.rejects(checkProductionDependencies(inputs, noRegistry, release), expected);
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
    [(cargo) => (cargo.lockfile.version = 5), /Expected a Cargo.lock of version 3 or 4/],
    [(cargo) => delete cargo.lockfile.version, /Expected a Cargo.lock of version 3 or 4/],
    [(cargo) => delete cargo.lockfile.package, /Expected a Cargo.lock of version 3 or 4/],
    [(cargo) => delete cargo.manifests["crates/api"], /service-api: Cargo.lock package has no Cargo.toml in the source/],
  ]) {
    const inputs = cargoFixture();
    change(inputs.cargo);
    await assert.rejects(checkProductionDependencies(inputs, noRegistry, release), expected);
  }
});

test("a crate is production only when its tag is a published release at the resolved commit", async () => {
  for (const [load, production, reason, finding] of [
    [async () => null, false, "Not released", /photon-hq\/error has no release v0.3.0/],
    [async () => ({ draft: false, prerelease: true, commit: errorCommit }), false, "Not a production release", /release v0.3.0 is a draft or prerelease/],
    [async () => ({ draft: true, prerelease: false, commit: errorCommit }), false, "Not a production release", /release v0.3.0 is a draft or prerelease/],
    [async () => ({ draft: false, prerelease: false, commit: crateCommit }), false, "Release tag is at another commit", /tag v0.3.0 is at c{40}, but Cargo.lock resolved e{40}/],
    [async () => { throw new Error("repository returned HTTP 404"); }, null, "Release lookup failed", /photon-hq\/error: repository returned HTTP 404/],
  ]) {
    const report = await auditProductionDependencies(cargoFixture(), noRegistry, (repository, tag) =>
      repository === "photon-hq/error" ? load() : release(repository, tag)
    );
    assert.equal(report.packages, undefined);
    assert.deepEqual(report.crates, [
      { name: "photon-error", version: "0.1.0", repository: "photon-hq/error", reference: "tag v0.3.0", production, reason },
      { name: "photon-example", version: "1.2.0", repository: "photon-hq/example", reference: "tag v3.0.0", production: true, reason: "Production release" },
    ]);
    assert.equal(report.errors.length, 1);
    assert.match(report.errors[0], finding);
    const body = renderProductionReport(report);
    assert.match(body, /\| Internal crate \| Version \| Source \| Prod\? \| Reason \|/);
    assert.ok(!body.includes("Internal package"));
    assert.match(body, production === null ? /❓ Unknown/ : /❌ No/);
    assert.match(body, /photon-hq\/example tag v3.0.0 \| ✅ Yes/);
  }
});

test("a source with both workspaces is audited for packages and crates", async () => {
  const inputs = { ...fixture(), cargo: cargoFixture().cargo };
  assert.deepEqual(await checkProductionDependencies(inputs, metadata, release), [
    `${name}@1.0.0`,
    `${indirect}@1.0.0`,
    "photon-error@0.1.0",
    "photon-example@1.2.0",
  ]);
  const body = renderProductionReport(await auditProductionDependencies(inputs, metadata, release));
  assert.match(body, /check passed/);
  assert.match(body, /\| Internal package \|/);
  assert.match(body, /\| Internal crate \|/);
  await assert.rejects(checkProductionDependencies({ ...fixture("1.0.0-staging.1"), cargo: inputs.cargo }, metadata, release), /example@1.0.0-staging.1/);
  await assert.rejects(checkProductionDependencies(inputs, metadata, async () => null), /has no release/);
  await assert.rejects(checkProductionDependencies({ source: "fixture" }, metadata, release), /No pnpm workspace or Cargo workspace/);
});

test("a Rust-only commit is read from Git; a commit with neither workspace or without Cargo.lock is refused", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "production-cargo-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (...args) => (await exec("git", args, { cwd: root })).stdout;
  const commit = async (message) => {
    await git("add", "-A");
    await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", message);
    return (await git("rev-parse", "HEAD")).trim();
  };
  await git("init", "-q");
  await writeFile(join(root, "README.md"), "no workspace\n");
  const empty = await commit("no workspace");
  await mkdir(join(root, "crates/api"), { recursive: true });
  await mkdir(join(root, "fixtures/broken"), { recursive: true });
  await writeFile(
    join(root, "Cargo.toml"),
    `[package]\nname = "service"\nversion = "0.0.0"\n\n[workspace]\nmembers = ["crates/*"]\n\n[workspace.dependencies]\nphoton-error = { version = "=0.1.0", git = "https://github.com/photon-hq/error", rev = "${errorCommit}" }\n\n[dependencies]\nphoton-error = { workspace = true }\n`
  );
  await writeFile(join(root, "crates/api/Cargo.toml"), `[package]\nname = "service-api"\nversion = "0.0.0"\n`);
  await writeFile(join(root, "fixtures/broken/Cargo.toml"), "not = [toml");
  const unlocked = await commit("manifest without a lockfile");
  const lock = (pin) =>
    `version = 4\n\n[[package]]\nname = "photon-error"\nversion = "0.1.0"\nsource = "git+https://github.com/photon-hq/error?${pin}#${errorCommit}"\n\n[[package]]\nname = "service"\nversion = "0.0.0"\ndependencies = ["photon-error"]\n\n[[package]]\nname = "service-api"\nversion = "0.0.0"\n`;
  await writeFile(join(root, "Cargo.lock"), lock(`rev=${errorCommit}`));
  const pinnedByRev = await commit("rev pin");
  await writeFile(join(root, "Cargo.toml"), (await readFile(join(root, "Cargo.toml"), "utf8")).replace(`rev = "${errorCommit}"`, 'tag = "v0.3.0"'));
  await writeFile(join(root, "Cargo.lock"), lock("tag=v0.3.0"));
  await commit("release tag pin");

  await assert.rejects(readProductionInputs(root, empty), /neither a pnpm workspace nor a Cargo workspace/);
  await assert.rejects(readProductionInputs(root, unlocked), /needs a committed root Cargo.lock/);
  const inputs = await readProductionInputs(root, pinnedByRev);
  assert.equal(inputs.workspace, undefined);
  assert.deepEqual(Object.keys(inputs.cargo.manifests).sort(), [".", "crates/api"]);
  await assert.rejects(checkProductionDependencies(inputs, noRegistry, release), /Cargo.toml: photon-error must pin a release tag vX.Y.Z of photon-hq\/error, not rev/);
  assert.deepEqual(await checkProductionDependencies(await readProductionInputs(root, "HEAD"), noRegistry, release), ["photon-error@0.1.0"]);
  assert.deepEqual(await checkProductionDependencies(await readProductionInputs(root), noRegistry, release), ["photon-error@0.1.0"]);
});

test("release lookups tell an unreleased tag from a repository the token cannot read", async (t) => {
  const { fetchCrateRelease, internalRepository } = await import("./internal-crates.mjs");
  for (const [git, expected] of [
    ["https://github.com/photon-hq/error", "photon-hq/error"],
    ["https://github.com/Photon-HQ/Error.git", "photon-hq/error"],
    ["ssh://git@github.com/photon-hq/error.git", "photon-hq/error"],
    ["https://github.com/someone/error", null],
    ["https://example.com/photon-hq/error", null],
    ["not a url", null],
    [undefined, null],
  ])
    assert.equal(internalRepository(git), expected);

  const realFetch = globalThis.fetch;
  const realToken = process.env.CRATES_TOKEN;
  t.after(() => {
    globalThis.fetch = realFetch;
    if (realToken === undefined) delete process.env.CRATES_TOKEN;
    else process.env.CRATES_TOKEN = realToken;
  });
  const base = "https://api.github.com/repos/photon-hq/error";
  const serve = (responses) => {
    const requested = [];
    globalThis.fetch = async (url, options) => {
      requested.push(url);
      assert.equal(options.headers.authorization, "Bearer token");
      assert.equal(options.redirect, "manual");
      const [status, body = ""] = responses[url] ?? [500];
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    };
    return requested;
  };
  delete process.env.CRATES_TOKEN;
  await assert.rejects(fetchCrateRelease("photon-hq/error", "v0.3.0"), /CRATES_TOKEN is required/);
  process.env.CRATES_TOKEN = "token";
  await assert.rejects(fetchCrateRelease("photon-hq/error", "main"), /Not an internal crate release/);
  await assert.rejects(fetchCrateRelease("photon-hq/a/b", "v0.3.0"), /Not an internal crate release/);

  let requested = serve({
    [`${base}/releases/tags/v0.3.0`]: [200, { draft: false, prerelease: false }],
    [`${base}/commits/refs/tags/v0.3.0`]: [200, `${errorCommit}\n`],
  });
  assert.deepEqual(await fetchCrateRelease("photon-hq/error", "v0.3.0"), { draft: false, prerelease: false, commit: errorCommit });
  assert.equal(requested.length, 2);

  serve({ [`${base}/releases/tags/v0.3.0`]: [404], [base]: [200, {}] });
  assert.equal(await fetchCrateRelease("photon-hq/error", "v0.3.0"), null);
  serve({ [`${base}/releases/tags/v0.3.0`]: [404], [base]: [404] });
  await assert.rejects(fetchCrateRelease("photon-hq/error", "v0.3.0"), /repository returned HTTP 404; the token must be able to read/);
  serve({ [`${base}/releases/tags/v0.3.0`]: [301] });
  await assert.rejects(fetchCrateRelease("photon-hq/error", "v0.3.0"), /release v0.3.0 returned HTTP 301/);
  serve({ [`${base}/releases/tags/v0.3.0`]: [200, { draft: false, prerelease: false }] });
  await assert.rejects(fetchCrateRelease("photon-hq/error", "v0.3.0"), /tag v0.3.0 returned HTTP 500/);
});

test("the action reads crate releases with crates-token, falling back to the calling repository's token", async () => {
  const action = parse(await readFile(new URL("./action.yaml", import.meta.url), "utf8"));
  assert.equal(action.inputs["crates-token"].default, "");
  assert.equal(action.runs.steps.at(-1).env.CRATES_TOKEN, "${{ inputs.crates-token || inputs.github-token }}");
});
