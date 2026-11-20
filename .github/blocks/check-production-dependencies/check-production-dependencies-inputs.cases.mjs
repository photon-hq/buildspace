import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import {
  toolchainFixture,
  writeInputs,
  writeLockfiles,
} from "./check-production-dependencies-inputs.test-utils.mjs";
import {
  auditProductionDependencies,
  checkProductionDependencies,
  readProductionInputs,
  renderProductionReport,
} from "./check-production-dependencies.mjs";

const exec = promisify(execFile);
const name = "@photon-hq/example";
const indirect = "@photon-hq/indirect";

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

export const registerProductionDependencyInputCases = () => {
  test("pnpm 12 reads the application importer after the toolchain document and audits both graphs", async (t) => {
    const root = await mkdtemp(nodePath.join(tmpdir(), "production-pnpm12-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const inputs = fixture();
    await writeInputs(root, inputs);
    const tools = toolchainFixture();
    await writeLockfiles(root, [tools, inputs.lockfile]);
    await checkProductionDependencies(
      await readProductionInputs(root),
      metadata
    );
    // Selecting only the first document would miss this application prerelease.
    await writeLockfiles(root, [tools, fixture("1.0.0-staging.1").lockfile]);
    await assert.rejects(
      checkProductionDependencies(await readProductionInputs(root), metadata),
      /example@1.0.0-staging.1/
    );

    // Toolchain importer entries cannot hide pins by omitting their graph records.
    for (const field of ["configDependencies", "packageManagerDependencies"]) {
      const missing = toolchainFixture();
      missing.importers["."][field][indirect] = {
        specifier: "1.0.0",
        version: "1.0.0",
      };
      await writeLockfiles(root, [missing, inputs.lockfile]);
      await assert.rejects(
        checkProductionDependencies(await readProductionInputs(root), metadata),
        /missing lockfile package or snapshot/
      );
    }

    // Selecting only the last document would miss toolchain transitives.
    tools.packages[`${indirect}@2.0.0-staging.1`] = {};
    tools.snapshots[`${indirect}@2.0.0-staging.1`] = {};
    tools.snapshots["pnpm@12.11.2"].dependencies = {
      [indirect]: "2.0.0-staging.1",
    };
    await writeLockfiles(root, [tools, inputs.lockfile]);
    await assert.rejects(
      checkProductionDependencies(await readProductionInputs(root), metadata),
      /indirect@2.0.0-staging.1/
    );
  });

  test("toolchain config dependencies must match stable workspace declarations, including a missing boot document", async (t) => {
    const root = await mkdtemp(
      nodePath.join(tmpdir(), "production-pnpm-config-")
    );

    t.after(() => rm(root, { recursive: true, force: true }));
    const inputs = fixture();
    inputs.workspace.configDependencies = { [indirect]: "1.0.0" };
    await writeInputs(root, inputs);
    const tools = toolchainFixture();
    tools.importers["."].configDependencies[indirect] = {
      specifier: "1.0.0",
      version: "1.0.0",
    };
    tools.packages[`${indirect}@1.0.0`] = {};
    tools.snapshots[`${indirect}@1.0.0`] = {};
    await writeLockfiles(root, [tools, inputs.lockfile]);
    await checkProductionDependencies(
      await readProductionInputs(root),
      metadata
    );
    tools.importers["."].configDependencies = {};
    await writeLockfiles(root, [tools, inputs.lockfile]);
    await assert.rejects(
      checkProductionDependencies(await readProductionInputs(root), metadata),
      /does not match its workspace declaration/
    );
    await writeLockfiles(root, [inputs.lockfile]);
    await assert.rejects(
      checkProductionDependencies(await readProductionInputs(root), metadata),
      /does not match its workspace declaration/
    );
    inputs.workspace.configDependencies[indirect] = "2.0.0-staging.1";
    await writeInputs(root, inputs);
    await writeLockfiles(root, [tools, inputs.lockfile]);
    await assert.rejects(
      checkProductionDependencies(await readProductionInputs(root), metadata),
      /indirect@2.0.0-staging.1/
    );
  });

  test("pnpm lockfile documents fail closed on malformed, incomplete, or unrecognized layouts", async (t) => {
    const root = await mkdtemp(
      nodePath.join(tmpdir(), "production-pnpm-layout-")
    );

    t.after(() => rm(root, { recursive: true, force: true }));
    const inputs = fixture();
    await writeInputs(root, inputs);

    for (const documents of [
      [],
      [null],
      ["unexpected"],
      [inputs.lockfile, inputs.lockfile],
      [toolchainFixture(), toolchainFixture()],
      [toolchainFixture(), { ...inputs.lockfile, importers: {} }],
      [toolchainFixture(), inputs.lockfile, inputs.lockfile],
      [toolchainFixture(), null],
    ]) {
      await writeLockfiles(root, documents);
      await assert.rejects(
        readProductionInputs(root),
        /Expected one pnpm lockfile|only toolchain importers|must contain application importers/
      );
    }

    for (const section of ["importers", "packages", "snapshots"]) {
      const tools = toolchainFixture();

      const incomplete = Object.fromEntries(
        Object.entries(tools).filter(([key]) => key !== section)
      );

      await writeLockfiles(root, [incomplete, inputs.lockfile]);
      await assert.rejects(
        async () =>
          checkProductionDependencies(
            await readProductionInputs(root),
            metadata
          ),
        /only toolchain importers|complete pnpm v9/
      );
    }

    await writeFile(
      nodePath.join(root, "pnpm-lock.yaml"),
      `---\ninvalid: [\n---\n${stringify(inputs.lockfile)}`
    );
    await assert.rejects(readProductionInputs(root));
  });

  test("ref checks the immutable release target, never later main or dirty files, without changing the checkout", async (t) => {
    const root = await mkdtemp(nodePath.join(tmpdir(), "production-check-"));
    t.after(() => rm(root, { recursive: true, force: true }));

    const git = async (...args) =>
      (await exec("git", args, { cwd: root })).stdout;

    await writeInputs(root, fixture("1.0.0-staging.1"));
    await writeLockfiles(root, [
      toolchainFixture(),
      fixture("1.0.0-staging.1").lockfile,
    ]);
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
    await writeFile(nodePath.join(root, "untracked.txt"), "keep me");
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
    assert.equal(
      await readFile(nodePath.join(root, "untracked.txt"), "utf-8"),
      "keep me"
    );
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
        () => {
          throw new Error("HTTP 403");
        },
        null,
        "Registry lookup failed",
      ],
      [() => ({ versions: {} }), false, "Not published"],
      [
        () => ({ versions: { "1.0.0": { deprecated: "withdrawn" } } }),
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
    const root = await mkdtemp(nodePath.join(tmpdir(), "production-report-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = nodePath.join(root, "report.md");
    await assert.rejects(
      exec(
        process.execPath,
        [
          new URL("check-production-dependencies.mjs", import.meta.url)
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
    const body = await readFile(path, "utf-8");
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
      name: local,
      version: "0.0.0",
      dependencies: { [name]: "1.0.0" },
    };
    inputs.lockfile.importers["packages/local-contract"] = {
      dependencies: { [name]: { specifier: "1.0.0", version: "1.0.0" } },
    };
    inputs.manifests["apps/example"].dependencies[local] = "workspace:*";
    inputs.lockfile.importers["apps/example"].dependencies[local] = {
      specifier: "workspace:*",
      version: "link:../../packages/local-contract",
    };
    const report = await auditProductionDependencies(inputs, metadata);
    assert.deepEqual(report.errors, []);
    assert.ok(!report.packages.some((row) => row.name === local));
    assert.ok(
      report.packages.some((row) => row.name === name && row.production)
    );
    inputs.manifests["packages/local-contract"].dependencies[name] =
      "2.0.0-staging.1";
    await assert.rejects(
      checkProductionDependencies(inputs, metadata),
      /2.0.0-staging.1/
    );
  });

  test("a published package's peer resolved to a workspace package is that source package", async () => {
    const inputs = fixture();
    const kit = "@photon-hq/kit";
    inputs.workspace.packages.push("packages/*");
    inputs.manifests["packages/kit"] = { name: kit, version: "0.1.2" };
    inputs.lockfile.importers["packages/kit"] = {};
    // The registry package peers on the kit; pnpm links that peer to the workspace.
    inputs.lockfile.snapshots[`${name}@1.0.0`].dependencies[kit] =
      "link:packages/kit";
    inputs.lockfile.snapshots[`${name}@1.0.0(${kit}@link:packages/kit)`] = {
      dependencies: { [kit]: "link:packages/kit" },
    };
    const report = await auditProductionDependencies(inputs, metadata);
    assert.deepEqual(report.errors, []);
    assert.ok(!report.packages.some((row) => row.name === kit));

    // Only a link to the package of that name inside the workspace is local.
    for (const target of [
      "link:../outside",
      "link:packages/missing",
      "link:packages/wrong",
    ]) {
      const linked = fixture();
      linked.workspace.packages.push("packages/*");
      linked.manifests["packages/kit"] = { name: kit, version: "0.1.2" };
      linked.manifests["packages/wrong"] = {
        name: "@photon-hq/different-package",
      };
      linked.lockfile.snapshots[`${name}@1.0.0`].dependencies[kit] = target;
      await assert.rejects(
        checkProductionDependencies(linked, metadata),
        /exact stable production version/
      );
    }
  });

  test("workspace links must resolve to the declared package inside the reviewed workspace", async () => {
    for (const target of [
      "link:../../../outside",
      "link:../../packages/missing",
      "link:../../packages/wrong",
    ]) {
      const inputs = fixture();
      inputs.manifests["packages/wrong"] = {
        name: "@photon-hq/different-package",
      };
      inputs.manifests["apps/example"].dependencies[name] = "workspace:*";
      inputs.lockfile.importers["apps/example"].dependencies[name] = {
        specifier: "workspace:*",
        version: target,
      };
      await assert.rejects(
        checkProductionDependencies(inputs, metadata),
        /exact stable production version/
      );
    }
  });

  test("the action selects main, hotfix and manual commits without accepting malformed tags", async (t) => {
    const action = parse(
      await readFile(new URL("action.yaml", import.meta.url), "utf-8")
    );

    const step = action.runs.steps.at(-1);
    const root = await mkdtemp(nodePath.join(tmpdir(), "production-action-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    // Stub the CLI so the real action shell can be exercised without registry calls.
    await writeFile(
      nodePath.join(root, "check-production-dependencies.mjs"),
      "console.log(process.argv.slice(2).join(' '));\n"
    );
    const sha = "a".repeat(40);
    const baseline = "b".repeat(40);

    for (const [tag, ref, expected] of [
      [`main-${sha}`, "", sha],
      [`hotfix-${baseline}-${sha}`, "", sha],
      ["", "main", "main"],
    ]) {
      const { stdout } = await exec("bash", ["-c", step.run], {
        env: {
          ...process.env,
          IMAGE_TAG: tag,
          SOURCE_REF: ref,
          CHECKER_PATH: root,
        },
      });

      assert.equal(stdout.trim(), `--ref ${expected}`);
    }

    for (const [tag, ref] of [
      ["", ""],
      ["latest", ""],
      ["main-abcd", ""],
      [`main-${sha}`, "main"],
      [`hotfix-bad-${sha}`, ""],
    ]) {
      await assert.rejects(
        exec("bash", ["-c", step.run], {
          env: {
            ...process.env,
            IMAGE_TAG: tag,
            SOURCE_REF: ref,
            CHECKER_PATH: root,
          },
        })
      );
    }
  });
};
