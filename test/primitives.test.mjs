import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stageFile } from "../.github/primitives/stage-file/index.mjs";
import { publishNpm } from "../.github/primitives/npm-publish/index.mjs";
import { waitNpmVersion } from "../.github/primitives/wait-npm-version/index.mjs";
import { packageInfo } from "../.github/primitives/npm-package-info/index.mjs";
import { publishPackages } from "../.github/blocks/publish-packages.mjs";

const primitives = fileURLToPath(new URL("../.github/primitives/", import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "buildspace-primitives-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "commands.jsonl");
  const env = { ...process.env, NODE_AUTH_TOKEN: "", PATH: `${bin}:${process.env.PATH}`, COMMAND_LOG: log, GITHUB_OUTPUT: join(root, "outputs"), TEST_ROOT: root };
  const stub = (name, source) => writeFileSync(join(bin, name), `#!${process.execPath}\n${source}`, { mode: 0o755 });
  const record = `require('node:fs').appendFileSync(process.env.COMMAND_LOG, JSON.stringify({command: require('node:path').basename(process.argv[1]), args: process.argv.slice(2), cwd: process.cwd(), goos: process.env.GOOS, goarch: process.env.GOARCH, cgo: process.env.CGO_ENABLED}) + '\\n');`;
  const commands = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  const action = (name, values = {}, overrides = {}) => spawnSync(process.execPath, [join(primitives, name, "index.mjs")], {
    cwd: root, env: { ...env, ...Object.fromEntries(Object.entries(values).map(([key, value]) => [`INPUT_${key.toUpperCase()}`, value])), ...overrides }, encoding: "utf8",
  });
  return { root, env, stub, record, commands, action };
}

function outputs(path) {
  const lines = readFileSync(path, "utf8").split("\n");
  const result = {};
  while (lines.length > 1) {
    const [key, delimiter] = lines.shift().split("<<");
    const end = lines.indexOf(delimiter);
    assert.notEqual(end, -1);
    result[key] = lines.splice(0, end).join("\n");
    lines.shift();
  }
  return result;
}

test("staging only copies the selected file and preserves its source", (t) => {
  const f = fixture(t);
  const source = join(f.root, "input ; literal");
  const destination = join(f.root, "output files", "tool\nname");
  writeFileSync(source, "binary", { mode: 0o640 });
  const result = f.action("stage-file", { source, destination, executable: "true" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(destination, "utf8"), "binary");
  assert.equal(statSync(destination).mode & 0o111, 0o111);
  assert.equal(statSync(source).mode & 0o777, 0o640);
  assert.deepEqual(outputs(f.env.GITHUB_OUTPUT), { name: "tool\nname", path: destination });
  assert.deepEqual(f.commands(), []);
});

test("staging a missing file fails rather than returning an artifact path", (t) => {
  const f = fixture(t);
  const result = f.action("stage-file", { source: "missing", destination: "out/file" });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(f.env.GITHUB_OUTPUT), false);
});

test("Cargo compilation and staging compose across a custom target directory", (t) => {
  const f = fixture(t);
  f.stub("cargo", `${f.record}
const fs = require('node:fs');
const path = require('node:path');
const directory = path.join(process.env.TEST_ROOT, 'custom target');
const target = process.argv[process.argv.indexOf('--target') + 1];
const file = path.join(directory, target, 'release', 'worker.exe');
fs.mkdirSync(path.dirname(file), {recursive:true});
fs.writeFileSync(file, 'windows binary');
console.log(JSON.stringify({reason:'compiler-artifact', target:{name:'worker'}, executable:file}));`);
  const target = "x86_64-pc-windows-gnu";
  const result = f.action("cargo-build", { binary: "worker", package: "worker-crate", target });
  assert.equal(result.status, 0, result.stderr);
  const binary = outputs(f.env.GITHUB_OUTPUT)["binary-path"];
  assert.equal(binary, join(f.root, "custom target", target, "release", "worker.exe"));
  const staged = stageFile({ source: binary, destination: join(f.root, "artifacts", "worker-windows.exe") });
  assert.equal(readFileSync(staged.path, "utf8"), "windows binary");
  assert.deepEqual(f.commands()[0].args, ["build", "--release", "--bin", "worker", "--message-format=json-render-diagnostics", "--target", target, "--package", "worker-crate"]);
});

test("Cargo's reported artifact wins over any assumed native output layout", (t) => {
  const f = fixture(t);
  f.stub("cargo", `${f.record}
console.log(JSON.stringify({reason:'compiler-artifact', target:{name:'worker'}, executable:process.env.TEST_ROOT + '/configured/target/release/worker'}));`);
  const result = f.action("cargo-build", { binary: "worker" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(outputs(f.env.GITHUB_OUTPUT)["binary-path"], join(f.root, "configured/target/release/worker"));
  assert.equal(f.commands().length, 1);
  assert.equal(f.commands()[0].args.includes("--target"), false);
});

test("Cargo failure or a missing executable never produces a binary path", (t) => {
  const f = fixture(t);
  for (const source of ["process.exit(17)", "console.log('{}')"]) {
    f.stub("cargo", source);
    const result = f.action("cargo-build", { binary: "worker" });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(f.env.GITHUB_OUTPUT), false);
  }
});

test("Go compilation keeps linker flags and output paths as literal arguments", (t) => {
  const f = fixture(t);
  f.stub("go", f.record);
  const result = f.action("go-build", { output: "out files/worker.exe", goos: "windows", goarch: "arm64", "build-flags": '-tags "one two" -trimpath', ldflags: "-s -w -X main.version=1.2.3" });
  assert.equal(result.status, 0, result.stderr);
  const [call] = f.commands();
  assert.deepEqual(call.args, ["build", "-tags", "one two", "-trimpath", "-ldflags", "-s -w -X main.version=1.2.3", "-o", join(f.root, "out files/worker.exe"), "."]);
  assert.equal(call.goos, "windows");
  assert.equal(call.goarch, "arm64");
  assert.equal(call.cgo, "0");
  assert.equal(outputs(f.env.GITHUB_OUTPUT)["binary-path"], join(f.root, "out files/worker.exe"));
});

test("Swift compilation resolves the product without signing, staging, or checking out", (t) => {
  const f = fixture(t);
  f.stub("swift", `${f.record}
if (process.argv.includes('--show-bin-path')) console.log(process.env.TEST_ROOT + '/.build/platform/release');`);
  const result = f.action("swift-build", { product: "worker" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.commands().map((call) => call.args), [["build", "-c", "release", "--product", "worker"], ["build", "-c", "release", "--show-bin-path"]]);
  assert.equal(outputs(f.env.GITHUB_OUTPUT)["binary-path"], join(f.root, ".build/platform/release/worker"));
});

test("pkgbuild consumes an existing payload without compiling or signing", (t) => {
  const f = fixture(t);
  f.stub("pkgbuild", f.record);
  const result = f.action("pkgbuild", { root: "payload files", identifier: "org.example.worker", version: "1.2.3", output: "out files/worker.pkg", scripts: "installer scripts", "install-location": "/opt/tools" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.commands().map((call) => call.args), [["--root", "payload files", "--identifier", "org.example.worker", "--install-location", "/opt/tools", "--version", "1.2.3", "--scripts", "installer scripts", "out files/worker.pkg"]]);
  assert.equal(outputs(f.env.GITHUB_OUTPUT)["package-path"], "out files/worker.pkg");
});

test("crate publication only publishes one selected crate and never retries", (t) => {
  const f = fixture(t);
  f.stub("cargo", f.record);
  const result = f.action("cargo-publish", { package: "shared", "dry-run": "true", "allow-dirty": "true" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.commands().map((call) => call.args), [["publish", "--package", "shared", "--dry-run", "--allow-dirty"]]);
});

test("package identity reads no dependencies and fails for an incomplete manifest", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "package.json"), JSON.stringify({ name: "@outside/widget", version: "1.2.3" }));
  assert.deepEqual(packageInfo(f.root), { name: "@outside/widget", version: "1.2.3" });
  const result = f.action("npm-package-info");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(outputs(f.env.GITHUB_OUTPUT), { name: "@outside/widget", version: "1.2.3" });
  writeFileSync(join(f.root, "package.json"), '{"name":"widget"}');
  assert.throws(() => packageInfo(f.root), /Missing package name or version/);
  assert.deepEqual(f.commands(), []);
});

test("npm publication appends literal flags to a custom command without installing or building", async (t) => {
  const f = fixture(t);
  f.stub("publisher", f.record);
  await publishNpm({ directory: f.root, registry: "https://registry.example.com", tag: "candidate; literal", access: "public", dryRun: true, provenance: true, command: "publisher --custom", env: f.env });
  assert.deepEqual(f.commands().map((call) => call.args), [["--custom", "--registry", "https://registry.example.com", "--tag", "candidate; literal", "--access", "public", "--dry-run", "--provenance"]]);
});

test("npm action distinguishes a failed command from a swallowed npm error", (t) => {
  const f = fixture(t);
  for (const [source, status, publisherStatus] of [["process.exit(23)", 23, "23"], ["console.error('npm error code E404')", 1, "0"], ["console.log('npm ERR! code E401')", 1, "0"], ["process.stdout.write('npm err'); process.stdout.write('or code E404');", 1, "0"]]) {
    f.stub("publisher", source);
    const result = f.action("npm-publish", { registry: "https://registry.example.com", command: "publisher" });
    assert.equal(result.status, status, result.stderr);
    assert.equal(outputs(f.env.GITHUB_OUTPUT)["exit-code"], publisherStatus);
    rmSync(f.env.GITHUB_OUTPUT);
  }
});

test("a missing required registry fails before a publisher can use its default registry", (t) => {
  const f = fixture(t);
  f.stub("publisher", f.record);
  const result = f.action("npm-publish", { command: "publisher" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing required input: registry/);
  assert.deepEqual(f.commands(), []);
});

test("registry visibility reads only the exact version and retries propagation", async (t) => {
  const f = fixture(t);
  f.stub("npm", `${f.record}
const fs = require('node:fs');
const state = process.env.TEST_ROOT + '/attempt';
const attempt = fs.existsSync(state) ? Number(fs.readFileSync(state)) + 1 : 1;
fs.writeFileSync(state, String(attempt));
console.log(attempt === 3 ? '1.2.3' : '1.2.2');`);
  assert.equal(await waitNpmVersion({ package: "@outside/widget", version: "1.2.3", registry: "https://registry.example.com", attempts: 3, intervalSeconds: 0, env: f.env }), "1.2.3");
  assert.equal(f.commands().length, 3);
  for (const call of f.commands()) assert.deepEqual(call.args, ["view", "@outside/widget@1.2.3", "version", "--registry", "https://registry.example.com"]);
});

test("registry visibility fails when the version is absent or the registry errors", async (t) => {
  const f = fixture(t);
  f.stub("npm", `${f.record} process.exit(1);`);
  await assert.rejects(waitNpmVersion({ package: "widget", version: "1.2.3", registry: "https://registry.example.com", attempts: 2, intervalSeconds: 0, env: f.env }), /not visible/);
  assert.equal(f.commands().length, 2);
});

test("monorepo recipe builds, publishes, and verifies each dependency before its dependent", async (t) => {
  const f = fixture(t);
  const packages = ["shared", "app"].map((name) => {
    const path = join(f.root, name);
    mkdirSync(path);
    writeFileSync(join(path, "package.json"), JSON.stringify({ name: `@outside/${name}`, version: "1.2.3" }));
    return { name: `@outside/${name}`, path };
  });
  f.stub("build", f.record);
  f.stub("bun", f.record);
  f.stub("npm", `${f.record} console.log('1.2.3');`);
  await publishPackages({ packages, buildCommand: "build", rootBuildCommand: "", registry: "https://registry.example.com", tag: "latest", dryRun: false, owner: "outside", env: { ...f.env, NODE_AUTH_TOKEN: "fixture-token" } });
  assert.deepEqual(f.commands().map((call) => [call.command, call.cwd]), packages.flatMap(({ path }) => [["build", path], ["bun", path], ["npm", process.cwd()]]));
});

test("monorepo dry runs skip builds after a root build, visibility checks, and registry credentials", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "package.json"), '{"name":"@outside/widget","version":"1.2.3"}');
  f.stub("bun", f.record);
  await publishPackages({ packages: [{ path: f.root }], buildCommand: "missing-command", rootBuildCommand: "already ran", registry: "https://registry.example.com", tag: "next", dryRun: true, owner: "outside", env: { ...f.env, NODE_AUTH_TOKEN: "" } });
  assert.equal(f.commands().length, 1);
  assert.ok(f.commands()[0].args.includes("--dry-run"));
});

test("monorepo publication stops before any dependent after the publisher swallows an error", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "package.json"), '{"name":"widget","version":"1.2.3"}');
  f.stub("bun", `${f.record} console.log('npm error code E404');`);
  await assert.rejects(publishPackages({ packages: [{ path: f.root }, { path: "must-not-run" }], buildCommand: "true", registry: "https://registry.example.com", tag: "latest", dryRun: true, env: f.env }), /emitted an npm error/);
  assert.equal(f.commands().length, 1);
});

test("a public npm dry run exercises the real publisher without registry access", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "package.json"), JSON.stringify({ name: "buildspace-primitive-fixture", version: "1.2.3", files: ["index.js"] }));
  writeFileSync(join(f.root, "index.js"), "export const value = 1;\n");
  const result = f.action("npm-publish", { registry: "https://registry.npmjs.org", "dry-run": "true", access: "public" }, { NODE_AUTH_TOKEN: "", NPM_CONFIG_USERCONFIG: "/dev/null", NPM_CONFIG_CACHE: join(f.root, "cache") });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(outputs(f.env.GITHUB_OUTPUT)["exit-code"], "0");
  assert.match(result.stderr, /dry.run/i);
});
