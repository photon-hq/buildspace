import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
// JSON is YAML: the fixtures need no YAML writer.
const stringify = (value) => JSON.stringify(value);
import {
  changedPackages,
  commitUses,
  deployedServices,
  github,
  packagesBetween,
  readConsumers,
  renderComment,
  watcher,
} from "./consumers.mjs";
import { cargoUses, pnpmUses } from "./graph.mjs";

const contract = "@photon-hq/telnyx-aerial-contract";
const adapter = "@photon-hq/semantic-adapter";
const plain = (uses) =>
  Object.fromEntries([...uses].map(([name, versions]) =>
    [name, Object.fromEntries([...versions].map(([version, vias]) => [version, [...vias].sort()]))]));

function pnpmLock(version, { direct = true, viaAdapter = false } = {}) {
  const importer = { dependencies: {} };
  if (direct) importer.dependencies[contract] = { specifier: version, version };
  if (viaAdapter) importer.dependencies[adapter] = { specifier: "3.0.0", version: "3.0.0(react@19.0.0)" };
  return stringify({
    lockfileVersion: "9.0",
    importers: {
      ".": {},
      "apps/api": importer,
      "apps/web": { dependencies: { "@photon-hq/local": { specifier: "workspace:*", version: "link:../../packages/local" } } },
    },
    packages: {},
    snapshots: {
      [`${contract}@${version}`]: {},
      "@photon-hq/semantic-adapter@3.0.0(react@19.0.0)": { dependencies: { [contract]: "7.0.1", react: "19.0.0" } },
      [`${contract}@7.0.1`]: {},
      "react@19.0.0": {},
    },
  });
}

test("pnpm: direct and transitive uses, with the direct dependency they come through", () => {
  const watched = (name) => name === contract;
  assert.deepEqual(plain(pnpmUses(pnpmLock("7.1.0"), watched)), { [contract]: { "7.1.0": [""] } });
  assert.deepEqual(plain(pnpmUses(pnpmLock("7.1.0", { direct: false, viaAdapter: true }), watched)),
    { [contract]: { "7.0.1": [adapter] } });
  assert.deepEqual(plain(pnpmUses(pnpmLock("7.1.0", { viaAdapter: true }), watched)),
    { [contract]: { "7.1.0": [""], "7.0.1": [adapter] } });
});

test("pnpm: an npm alias counts as a use of the package it resolves to", () => {
  const lock = stringify({
    lockfileVersion: "9.0",
    importers: { ".": { dependencies: {
      "@photon-hq/renamed": { specifier: `npm:${contract}@7.1.0`, version: `${contract}@7.1.0` },
      wrapper: { specifier: "1.0.0", version: "1.0.0" },
    } } },
    snapshots: {
      [`${contract}@7.1.0`]: {},
      "wrapper@1.0.0": { dependencies: { "old-name": `${contract}@7.0.1(react@19.0.0)` } },
      [`${contract}@7.0.1(react@19.0.0)`]: {},
    },
  });
  assert.deepEqual(plain(pnpmUses(lock, (name) => name === contract)),
    { [contract]: { "7.1.0": [""], "7.0.1": ["wrapper"] } });
});

test("pnpm: reads the application document after pnpm 12's toolchain document", () => {
  const toolchain = stringify({ lockfileVersion: "9.0", importers: { ".": { packageManagerDependencies: { pnpm: { specifier: "12.0.0", version: "12.0.0" } } } } });
  assert.deepEqual(plain(pnpmUses(`---\n${toolchain}\n---\n${pnpmLock("7.1.0")}`, (name) => name === contract)),
    { [contract]: { "7.1.0": [""] } });
});

test("cargo: internal crates show their release tag and the crate they come through", () => {
  const lock = [
    '[[package]]\nname = "service"\nversion = "0.1.0"\ndependencies = ["photon-client", "service-core"]',
    '[[package]]\nname = "service-core"\nversion = "0.1.0"\ndependencies = ["photon-error 0.1.0"]',
    '[[package]]\nname = "photon-client"\nversion = "0.1.0"\nsource = "git+https://github.com/photon-hq/client?tag=v1.2.0#abc"\ndependencies = ["photon-error"]',
    '[[package]]\nname = "photon-error"\nversion = "0.1.0"\nsource = "git+https://github.com/photon-hq/error?tag=v0.3.0#def"',
  ].join("\n\n");
  assert.deepEqual(plain(cargoUses(lock, (name) => name === "photon-error")),
    { "photon-error": { "v0.3.0": ["", "photon-client"] } });
  // A rev or branch pin shows its short commit.
  const pinned = [
    '[[package]]\nname = "service"\nversion = "0.1.0"\ndependencies = ["photon-error"]',
    '[[package]]\nname = "photon-error"\nversion = "0.1.0"\nsource = "git+https://github.com/photon-hq/error?branch=main#0123456789abcdef"',
  ].join("\n\n");
  assert.deepEqual(plain(cargoUses(pinned, (name) => name === "photon-error")),
    { "photon-error": { "0123456": [""] } });
  // The same name and version from two sources: the reference names its source.
  const git = "git+https://github.com/photon-hq/error?tag=v0.3.0#def";
  const twice = [
    `[[package]]\nname = "service"\nversion = "0.1.0"\ndependencies = ["photon-error 0.1.0 (${git.split("#")[0]})"]`,
    '[[package]]\nname = "photon-error"\nversion = "0.1.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"',
    `[[package]]\nname = "photon-error"\nversion = "0.1.0"\nsource = "${git}"`,
  ].join("\n\n");
  assert.deepEqual(plain(cargoUses(twice, (name) => name === "photon-error")),
    { "photon-error": { "v0.3.0": [""] } });
});

test("changed packages: the innermost published package owning each changed file", async () => {
  const files = new Map([
    ["package.json", JSON.stringify({ name: "root", private: true })],
    ["packages/aerial-contract/package.json", JSON.stringify({ name: contract, version: "7.1.0" })],
    ["packages/internal/package.json", JSON.stringify({ name: "@photon-hq/internal", private: true })],
    ["crates/error/Cargo.toml", '[package]\nname = "photon-error"\nversion = "0.1.0"\npublish = false'],
    ["services/api/Cargo.toml", '[package]\nname = "api"\nversion = "0.1.0"'],
    ["proto/buf.yaml", stringify({ version: "v2", modules: [{ path: "aerial", name: "buf.build/photon-hq/aerial" }, { path: "scratch" }] })],
  ]);
  const read = [...files].map(([path, text]) => [path, async () => text]);
  const paths = new Set([...files.keys(), "crates/error/src/lib.rs", "services/api/src/main.rs"]);
  const changed = ["README.md", "packages/aerial-contract/src/index.ts", "packages/internal/a.ts",
    "crates/error/src/lib.rs", "services/api/src/main.rs", "proto/aerial/v1/aerial.proto", "proto/scratch/x.proto"];
  // A binary crate is no dependency; a library is, publish = false or not.
  assert.deepEqual((await changedPackages(changed, read, paths)).map(({ kind, name }) => `${kind}:${name}`),
    ["crate:photon-error", "npm:@photon-hq/telnyx-aerial-contract", "buf:buf.build/photon-hq/aerial"].sort((a, b) => a.split(":")[1].localeCompare(b.split(":")[1])));
  assert.deepEqual(await changedPackages(["README.md"], read, paths), []);
  // A buf.yaml change touches the modules it declares, which live below it.
  assert.deepEqual((await changedPackages(["proto/buf.yaml"], read, paths)).map(({ name }) => name), ["buf.build/photon-hq/aerial"]);
  const watched = watcher(await changedPackages(changed, read, paths));
  assert.ok(watched(contract) && watched("@buf/photon-hq_aerial.bufbuild_es") && watched("photon-error"));
  assert.ok(!watched("@buf/photon-hq_aerial-v2.bufbuild_es") && !watched("@photon-hq/internal"));
});

test("changed packages: an npm package and a crate in one directory", async () => {
  const read = [
    ["pkg/package.json", async () => JSON.stringify({ name: contract })],
    ["pkg/Cargo.toml", async () => '[package]\nname = "aerial-contract"\nversion = "0.1.0"'],
  ];
  const paths = new Set(["pkg/package.json", "pkg/Cargo.toml", "pkg/src/lib.rs"]);
  const names = async (changed) => (await changedPackages(changed, read, paths)).map(({ name }) => name);
  assert.deepEqual(await names(["pkg/src/lib.rs"]), [contract, "aerial-contract"]);
  assert.deepEqual(await names(["pkg/Cargo.toml"]), ["aerial-contract"]);
});

test("renders one table per package; buf SDK versions show the module commit", () => {
  const packages = [
    { kind: "npm", name: contract },
    { kind: "buf", name: "buf.build/photon-hq/aerial", prefix: "@buf/photon-hq_aerial." },
    { kind: "npm", name: "@photon-hq/unused" },
    { kind: "crate", name: "service-core" },
  ];
  const uses = (entries) => ({ uses: new Map(entries.map(([name, version, via]) => [name, new Map([[version, new Set([via])]])])) });
  const services = [
    { service: "aerial", production: uses([[contract, "7.0.1", ""]]), staging: uses([[contract, "7.1.0", ""]]), main: uses([[contract, "7.1.0", ""], ["@buf/photon-hq_aerial.bufbuild_es", "2.10.1-20251119095225-0a0a1f2b3c4d.1", ""]]) },
    { service: "base-bffs", production: uses([[contract, "7.0.1", adapter]]), staging: { error: "HTTP 403" }, main: uses([]) },
    { service: "billing-v2", production: uses([]), main: uses([]) },
    { service: "hidden", production: { error: "repository not readable" }, main: { error: "repository not readable" } },
    { service: "manifest", production: { missing: true }, staging: { missing: true }, main: { missing: true } },
  ];
  assert.equal(renderComment(packages, services), [
    "### Services using the packages this PR changes",
    "",
    `#### \`${contract}\``,
    "",
    "| Service | Production | Staging | main |",
    "| --- | --- | --- | --- |",
    "| aerial | 7.0.1 | 7.1.0 | 7.1.0 |",
    `| base-bffs (via \`${adapter}\`) | 7.0.1 | ? | none |`,
    "",
    "#### `buf.build/photon-hq/aerial` SDKs",
    "",
    "| Service | Production | Staging | main |",
    "| --- | --- | --- | --- |",
    "| aerial | none | none | 0a0a1f2b3c4d |",
    "",
    "No use of `@photon-hq/unused` found in the services that could be checked.",
    "",
    "Not checked (no pnpm-lock.yaml or Cargo.lock): manifest production/staging/main.",
    "",
    "Could not read: base-bffs staging (HTTP 403); hidden production/main (repository not readable).",
  ].join("\n"));
  // Only unused crates: nothing to comment.
  assert.equal(renderComment([{ kind: "crate", name: "service-core" }], services), "");
  // Every read succeeded: absence is stated; a direct use elsewhere keeps the via.
  const complete = [
    { service: "aerial", production: uses([[contract, "7.0.1", adapter]]), main: uses([[contract, "7.1.0", ""]]) },
  ];
  assert.equal(renderComment([packages[0], packages[2]], complete), [
    "### Services using the packages this PR changes",
    "",
    `#### \`${contract}\``,
    "",
    "| Service | Production | Staging | main |",
    "| --- | --- | --- | --- |",
    `| aerial (direct and via \`${adapter}\`) | 7.0.1 | — | 7.1.0 |`,
    "",
    "No deployed service uses `@photon-hq/unused`.",
  ].join("\n"));
});

test("reads deployment refs, main heads and each commit's lockfiles once", async () => {
  const sha = (n) => String(n).repeat(40);
  const files = {
    "repos/photon-hq/application-manifest/contents/clusters/photon-production?ref=main": [{ type: "dir", name: "aerial" }, { type: "dir", name: "hidden" }, { type: "dir", name: "manifest" }, { type: "file", name: "README.md" }],
    "repos/photon-hq/application-manifest/contents/clusters/photon-staging-usw2?ref=main": [{ type: "dir", name: "aerial" }, { type: "dir", name: "voice" }],
    "repos/photon-hq/application-manifest/contents/clusters/photon-production/aerial/deployment-ref.yaml?ref=main": stringify({ deployment: { repoURL: "https://github.com/photon-hq/aerial", ref: sha(1) } }),
    "repos/photon-hq/application-manifest/contents/clusters/photon-staging-usw2/aerial/deployment-ref.yaml?ref=main": stringify({ deployment: { repoURL: "https://github.com/photon-hq/aerial", ref: sha(2) } }),
    "repos/photon-hq/application-manifest/contents/clusters/photon-staging-usw2/voice/deployment-ref.yaml?ref=main": stringify({ deployment: { repoURL: "https://github.com/photon-hq/voice", ref: sha(3) } }),
    "repos/photon-hq/aerial/commits/HEAD": sha(2),
    "repos/photon-hq/voice/commits/HEAD": sha(4),
    "repos/photon-hq/application-manifest/contents/clusters/photon-production/hidden/deployment-ref.yaml?ref=main": stringify({ deployment: { repoURL: "https://github.com/photon-hq/hidden", ref: sha(5) } }),
    "repos/photon-hq/application-manifest/contents/clusters/photon-production/manifest/deployment-ref.yaml?ref=main": stringify({ deployment: { repoURL: "https://github.com/photon-hq/manifest", ref: sha(6) } }),
    "repos/photon-hq/manifest/commits/HEAD": sha(6),
    ...Object.fromEntries([[1, "pnpm-lock.yaml"], [2, "pnpm-lock.yaml"], [3, "pnpm-lock.yaml"], [4, "server/pnpm-lock.yaml"], [6, "package-lock.json"]].map(([n, path]) =>
      [`repos/photon-hq/${n === 6 ? "manifest" : n >= 3 ? "voice" : "aerial"}/git/trees/${sha(n)}?recursive=1`,
        { truncated: false, tree: [{ type: "blob", path }, { type: "blob", path: "node_modules/x/pnpm-lock.yaml" }, { type: "tree", path: "src" }] }])),
    [`repos/photon-hq/aerial/contents/pnpm-lock.yaml?ref=${sha(1)}`]: pnpmLock("7.0.1"),
    [`repos/photon-hq/aerial/contents/pnpm-lock.yaml?ref=${sha(2)}`]: pnpmLock("7.1.0"),
    [`repos/photon-hq/voice/contents/server/pnpm-lock.yaml?ref=${sha(4)}`]: pnpmLock("7.1.0"),
  };
  const requests = [];
  const fetchImpl = async (url, { headers }) => {
    const path = url.replace("https://api.github.com/", "");
    requests.push(path);
    assert.equal(headers.authorization, "Bearer token");
    if (path.includes("/contents/") && path.endsWith(`?ref=${sha(3)}`)) return new Response("no", { status: 403 });
    const body = files[path];
    if (body === undefined) return new Response("", { status: 404 });
    return new Response(typeof body === "string" ? body : JSON.stringify(body));
  };
  const api = github("token", fetchImpl);
  const services = await deployedServices(api);
  assert.deepEqual(services, [
    { service: "aerial", repository: "photon-hq/aerial", production: sha(1), staging: sha(2) },
    { service: "hidden", repository: "photon-hq/hidden", production: sha(5) },
    { service: "manifest", repository: "photon-hq/manifest", production: sha(6) },
    { service: "voice", repository: "photon-hq/voice", staging: sha(3) },
  ]);
  const watched = (name) => name === contract;
  const read = await readConsumers(api, services, watched);
  assert.deepEqual(plain(read[0].production.uses), { [contract]: { "7.0.1": [""] } });
  assert.deepEqual(plain(read[0].main.uses), { [contract]: { "7.1.0": [""] } });
  // A repository the token cannot see is a failed read, not a service that uses nothing.
  assert.deepEqual([read[1].production, read[1].staging, read[1].main], [{ error: "repository not readable" }, undefined, { error: "repository not readable" }]);
  // No lockfile anywhere in the commit: not checked, not "uses nothing".
  assert.deepEqual([read[2].production, read[2].main], [{ missing: true }, { missing: true }]);
  assert.equal(read[3].production, undefined);
  assert.equal(read[3].staging.error, "HTTP 403");
  // Lockfiles below the root are read too.
  assert.deepEqual(plain(read[3].main.uses), { [contract]: { "7.1.0": [""] } });
  // aerial's staging and main are the same commit: its lockfiles are read once.
  assert.equal(requests.filter((path) => path === `repos/photon-hq/aerial/contents/pnpm-lock.yaml?ref=${sha(2)}`).length, 1);
});

test("an unreadable application-manifest listing fails instead of listing no services", async () => {
  await assert.rejects(deployedServices(async () => undefined), /Cannot read photon-hq\/application-manifest/);
  assert.deepEqual(await deployedServices(async () => []), []);
});

test("a commit whose only lockfiles are under node_modules is not checked", async () => {
  assert.deepEqual(await commitUses(["README.md", "node_modules/x/pnpm-lock.yaml"], async () => "", () => true), { missing: true });
});

test("a deleted or renamed package, or one a file moves out of, still counts as changed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "package-consumers-"));
  const run = promisify(execFile);
  const git = async (...args) => (await run("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args])).stdout;
  const put = async (path, text) => {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), text);
  };
  try {
    await git("init", "-q", "-b", "main");
    await put("gone/package.json", JSON.stringify({ name: "@photon-hq/gone" }));
    await put("gone/index.js", "x");
    await put("old/package.json", JSON.stringify({ name: "@photon-hq/moved" }));
    await put("old/index.js", "export const value = 1;\n".repeat(20));
    await put("renamed/package.json", JSON.stringify({ name: "@photon-hq/before" }));
    await git("add", ".");
    await git("commit", "-qm", "base");
    const base = (await git("rev-parse", "HEAD")).trim();
    await git("rm", "-rq", "gone");
    // A file moved out of its package: a rename would list only the new path.
    await mkdir(join(dir, "scripts"));
    await git("mv", "old/index.js", "scripts/index.js");
    await put("renamed/package.json", JSON.stringify({ name: "@photon-hq/after" }));
    await git("add", ".");
    await git("commit", "-qm", "head");
    const head = (await git("rev-parse", "HEAD")).trim();
    assert.deepEqual((await packagesBetween(git, base, head)).map((entry) => entry.name), ["@photon-hq/after", "@photon-hq/before", "@photon-hq/gone", "@photon-hq/moved"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
