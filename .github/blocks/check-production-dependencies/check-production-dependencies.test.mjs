import assert from "node:assert/strict";
import { test } from "node:test";
import { registerProductionDependencyInputCases } from "./check-production-dependencies-inputs.cases.mjs";
import {
  auditProductionDependencies,
  checkProductionDependencies,
} from "./check-production-dependencies.mjs";
import { registerInternalCrateReleaseCases } from "./internal-crates-release.cases.mjs";
import { registerInternalCrateCases } from "./internal-crates.cases.mjs";

const name = "@photon-hq/example";
const indirect = "@photon-hq/indirect";

const metadata = async () => ({
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
  assert.deepEqual(checked.toSorted(), [name, indirect]);
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

test("a workspace peer may be a stable range that its locked version satisfies", async () => {
  for (const range of [
    "1.0.0",
    ">=1.0.0",
    "^1.0.0",
    ">=1.0.0 <2",
    "1.x || 2.x",
  ]) {
    const inputs = fixture();
    inputs.manifests["apps/example"].peerDependencies = { [name]: range };
    const report = await auditProductionDependencies(inputs, metadata);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(
      report.packages
        .filter((row) => row.name === name)
        .map((row) => row.version),
      ["1.0.0"]
    );
  }

  for (const range of [">=2.0.0", "<1.0.0"]) {
    const inputs = fixture();
    inputs.manifests["apps/example"].peerDependencies = { [name]: range };
    await assert.rejects(
      checkProductionDependencies(inputs, metadata),
      /lockfile importer 1.0.0 does not satisfy the peer range/
    );
  }

  const unlocked = fixture();
  unlocked.manifests["apps/example"].peerDependencies = {
    [indirect]: ">=1.0.0",
  };
  await assert.rejects(
    checkProductionDependencies(unlocked, metadata),
    /lockfile importer missing does not satisfy the peer range/
  );

  // A range that admits a prerelease is not a production range.
  for (const range of [">=1.0.0-staging.1", "^1.0.0-rc.1", "latest"]) {
    const inputs = fixture();
    inputs.manifests["apps/example"].peerDependencies = { [name]: range };
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
      i.lockfile.catalogs.default = Object.fromEntries(
        Object.entries(i.lockfile.catalogs.default).filter(
          ([key]) => key !== name
        )
      );
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

registerProductionDependencyInputCases();

registerInternalCrateCases();

registerInternalCrateReleaseCases();
