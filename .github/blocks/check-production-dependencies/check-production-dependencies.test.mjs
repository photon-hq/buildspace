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
