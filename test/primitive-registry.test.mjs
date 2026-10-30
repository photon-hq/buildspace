import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

test("the real npm launcher verifies an exact version against a local registry", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "buildspace-registry-"));
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ path: request.url, method: request.method, authenticated: Boolean(request.headers.authorization) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ name: "widget", "dist-tags": { latest: "1.2.3" }, versions: { "1.2.3": { name: "widget", version: "1.2.3" } } }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    rmSync(directory, { recursive: true, force: true });
  });
  const output = join(directory, "outputs");
  const userConfig = join(directory, "user.npmrc");
  const globalConfig = join(directory, "global.npmrc");
  writeFileSync(userConfig, "");
  writeFileSync(globalConfig, "");
  const child = spawn(process.execPath, [fileURLToPath(new URL("../.github/primitives/wait-npm-version/index.mjs", import.meta.url))], {
    env: {
      ...process.env, NODE_AUTH_TOKEN: "", NPM_CONFIG_USERCONFIG: userConfig, NPM_CONFIG_GLOBALCONFIG: globalConfig,
      NPM_CONFIG_CACHE: join(directory, "cache"), NPM_CONFIG_FETCH_RETRIES: "0", NPM_CONFIG_FETCH_TIMEOUT: "10000",
      NPM_CONFIG_UPDATE_NOTIFIER: "false",
      GITHUB_OUTPUT: output, INPUT_PACKAGE: "widget", INPUT_VERSION: "1.2.3",
      INPUT_REGISTRY: `http://127.0.0.1:${server.address().port}`, INPUT_ATTEMPTS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stderr.on("data", (chunk) => { diagnostics += chunk; });
  const status = await new Promise((done, reject) => {
    child.on("error", reject);
    child.on("close", done);
  });
  assert.equal(status, 0, diagnostics);
  assert.match(readFileSync(output, "utf8"), /^version<<[^\n]+\n1\.2\.3\n/);
  assert.ok(requests.length > 0);
  assert.ok(requests.every((request) => request.path === "/widget" && request.method === "GET" && !request.authenticated));
});
