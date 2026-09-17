import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("../", import.meta.url);

function stepScript(path, name, key) {
  const source = readFileSync(new URL(path, root), "utf8");
  const start = source.indexOf(`- name: ${name}\n`);
  assert.ok(start >= 0, `Missing step: ${name}`);
  const lines = source.slice(start).split("\n");
  const index = lines.findIndex((line) => line.trim() === `${key}: |`);
  assert.ok(index >= 0, `Missing ${key} block`);
  const indent = lines[index].length - lines[index].trimStart().length + 2;
  const script = [];
  for (const line of lines.slice(index + 1)) {
    if (line.trim() && line.length - line.trimStart().length < indent) break;
    script.push(line.slice(indent));
  }
  return script.join("\n");
}

test("optional source validation preserves HEAD and rejects invalid or mismatched commits", () => {
  const dir = mkdtempSync(join(tmpdir(), "buildspace-source-"));
  try {
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "source"]);
    const sha = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const script = stepScript(".github/workflows/typescript-service-release.yaml", "Validate release source", "run");
    for (const requested of ["", sha, "not-a-sha", "f".repeat(40)]) {
      const output = join(dir, "output"); writeFileSync(output, "");
      const result = spawnSync("bash", ["-c", script], { cwd: dir, env: { ...process.env, REQUESTED_SHA: requested, GITHUB_OUTPUT: output }, encoding: "utf8" });
      if (requested === "" || requested === sha) {
        assert.equal(result.status, 0);
        assert.equal(readFileSync(output, "utf8").trim(), `sha=${sha}`);
      } else { assert.notEqual(result.status, 0); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("existing tag validation permits a missing tag or the exact source, and refuses another commit", async () => {
  const script = stepScript(".github/blocks/create-github-release/action.yaml", "Verify an existing tag still identifies the requested source", "script");
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  for (const scenario of ["missing", "same", "different", "forbidden"]) {
    let failed;
    const github = { rest: { repos: { getCommit: async ({ ref }) => {
      if (ref === "requested") return { data: { sha: "a".repeat(40) } };
      if (scenario === "missing" || scenario === "forbidden") throw Object.assign(new Error("API failure"), { status: scenario === "missing" ? 404 : 403 });
      return { data: { sha: (scenario === "same" ? "a" : "b").repeat(40) } };
    } } } };
    const run = () => new AsyncFunction("github", "context", "core", "process", script)(github, { repo: { owner: "photon-hq", repo: "test" } }, { setFailed: (message) => { failed = message; } }, { env: { TARGET_COMMIT: "requested", RELEASE_TAG: "v1.0.0" } });
    if (scenario === "forbidden") { await assert.rejects(run); continue; }
    await run();
    assert.equal(Boolean(failed), scenario === "different");
  }
});

test("retry reuses the version already released for the source SHA", async () => {
  const script = stepScript(".github/workflows/typescript-service-release.yaml", "Reuse a release already created for this exact source", "script");
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const outputs = {};
  const github = { paginate: async () => [{ draft: false, target_commitish: "source", tag_name: "v1.2.3", body: "Original notes" }], rest: { repos: { listReleases: {} } } };
  await new AsyncFunction("github", "context", "core", "process", script)(github, { repo: { owner: "photon-hq", repo: "test" } }, { setOutput: (key, value) => { outputs[key] = value; } }, { env: { SOURCE_SHA: "source" } });
  assert.equal(outputs.version, "1.2.3");
  assert.equal(outputs.notes, "Original notes");
});
