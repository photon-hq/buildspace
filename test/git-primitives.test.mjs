import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const primitives = fileURLToPath(new URL("../.github/primitives/", import.meta.url));
const sha = "b".repeat(40);

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "buildspace-git-primitives-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "calls.jsonl");
  const output = join(root, "outputs");
  writeFileSync(join(bin, "git"), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GIT_ACTION_TEST_LOG, JSON.stringify({args, cwd:process.cwd()}) + '\\n');
if (args[0] === 'diff') process.exit(Number(process.env.GIT_ACTION_TEST_DIFF || 0));
if (args[0] === 'commit') process.exit(Number(process.env.GIT_ACTION_TEST_COMMIT || 0));
if (args[0] === 'push') process.exit(Number(process.env.GIT_ACTION_TEST_PUSH || 0));
if (args[0] === 'config') {
  if (args.includes('--get-regexp') && process.env.GIT_ACTION_TEST_GROUP) console.log('remotes.origin origin backup');
  else if (args.includes('--bool') && process.env.GIT_ACTION_TEST_MIRROR) console.log('true');
  else if (args.includes('--get-all') && process.env.GIT_ACTION_TEST_CONFIGURED_PUSH) console.log(process.env.GIT_ACTION_TEST_CONFIGURED_PUSH);
  else process.exit(Number(process.env.GIT_ACTION_TEST_CONFIG_ERROR || 1));
}
if (args[0] === 'rev-parse') console.log('${sha}');
`, { mode: 0o755 });
  const action = (name, values = {}, overrides = {}) => spawnSync(process.execPath, [join(primitives, name, "index.mjs")], {
    cwd: root,
    env: { ...process.env, NODE_AUTH_TOKEN: "", PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: output, GIT_ACTION_TEST_LOG: log,
      ...Object.fromEntries(Object.entries(values).map(([key, value]) => [`INPUT_${key.toUpperCase()}`, value])), ...overrides },
    encoding: "utf8",
  });
  const calls = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  const value = (key) => {
    const lines = readFileSync(output, "utf8").split("\n");
    return lines[lines.findIndex((line) => line.startsWith(`${key}<<`)) + 1];
  };
  return { root, output, action, calls, value };
}

test("Git staging passes literal pathspecs and stages deletions without a commit", (t) => {
  const f = fixture(t);
  const paths = ["package files/*.json", "literal\nfilename", "-force"];
  const result = f.action("git-stage", { paths: JSON.stringify(paths) });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), [{ args: ["add", "--all", "--", ...paths], cwd: f.root }]);
  assert.equal(existsSync(f.output), false);
});

test("an empty or invalid pathspec collection cannot stage the whole repository", (t) => {
  const f = fixture(t);
  for (const paths of [[], {}, "package.json", [""], [false]]) {
    const result = f.action("git-stage", { paths: JSON.stringify(paths) });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /nonempty JSON array/);
  }
  assert.deepEqual(f.calls(), []);
});

test("an unchanged index is a successful no-op with no created SHA", (t) => {
  const f = fixture(t);
  const result = f.action("git-commit", { message: "unused message" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.value("committed"), "false");
  assert.equal(f.value("commit-sha"), "");
  assert.deepEqual(f.calls().map(({ args }) => args), [["diff", "--cached", "--quiet", "--exit-code"]]);
});

test("Git commit consumes only the existing index and keeps the message literal", (t) => {
  const f = fixture(t);
  const message = 'chore: a "quoted" message\n$(touch must-not-run)';
  const result = f.action("git-commit", { message }, { GIT_ACTION_TEST_DIFF: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.value("committed"), "true");
  assert.equal(f.value("commit-sha"), sha);
  assert.deepEqual(f.calls().map(({ args }) => args), [
    ["diff", "--cached", "--quiet", "--exit-code"], ["commit", "--message", message], ["rev-parse", "HEAD"],
  ]);
  assert.equal(existsSync(join(f.root, "must-not-run")), false);
});

test("an index inspection failure is not mistaken for a changed index", (t) => {
  const f = fixture(t);
  const result = f.action("git-commit", { message: "must not commit" }, { GIT_ACTION_TEST_DIFF: "128" });
  assert.equal(result.status, 128);
  assert.equal(f.calls().length, 1);
  assert.equal(existsSync(f.output), false);
});

test("a failed commit cannot report success or attempt any publication", (t) => {
  const f = fixture(t);
  const result = f.action("git-commit", { message: "commit" }, { GIT_ACTION_TEST_DIFF: "1", GIT_ACTION_TEST_COMMIT: "7" });
  assert.equal(result.status, 7);
  assert.deepEqual(f.calls().map(({ args }) => args[0]), ["diff", "commit"]);
  assert.equal(existsSync(f.output), false);
});

test("Git pushes keep default branch selection or accept one explicit refspec", (t) => {
  const f = fixture(t);
  assert.equal(f.action("git-push").status, 0);
  const refspec = `${sha}:refs/heads/candidate`;
  const result = f.action("git-push", { refspec, remote: "local remote" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls().filter(({ args }) => args[0] === "push").map(({ args }) => args), [
    ["push", "--no-force", "--", "origin"], ["push", "--no-force", "--", "local remote", refspec],
  ]);
});

test("a forced refspec fails before Git is invoked", (t) => {
  const f = fixture(t);
  const result = f.action("git-push", { refspec: "+HEAD:refs/heads/main" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Forced refspecs/);
  assert.deepEqual(f.calls(), []);
});

test("a rejected push fails without retries or a force fallback", (t) => {
  const f = fixture(t);
  const result = f.action("git-push", { refspec: "HEAD:refs/heads/main" }, { GIT_ACTION_TEST_PUSH: "1" });
  assert.equal(result.status, 1);
  const pushes = f.calls().filter(({ args }) => args[0] === "push");
  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0].args, ["push", "--no-force", "--", "origin", "HEAD:refs/heads/main"]);
});

test("inherited force or mirror policy cannot bypass a non-forcing push", (t) => {
  for (const overrides of [
    { GIT_ACTION_TEST_CONFIGURED_PUSH: "+HEAD:refs/heads/main" },
    { GIT_ACTION_TEST_MIRROR: "true" },
    { GIT_ACTION_TEST_GROUP: "true" },
    { GIT_ACTION_TEST_CONFIG_ERROR: "128" },
  ]) {
    const f = fixture(t);
    const result = f.action("git-push", {}, overrides);
    assert.notEqual(result.status, 0);
    assert.ok(f.calls().every(({ args }) => args[0] !== "push"));
  }
});

test("Git operations use the selected worktree directory without changing identity", (t) => {
  const f = fixture(t);
  const directory = join(f.root, "another worktree");
  mkdirSync(directory);
  for (const [name, values] of [["git-stage", { paths: '["Formula/"]' }], ["git-commit", { message: "formula update" }], ["git-push", {}]]) {
    const result = f.action(name, { ...values, "working-directory": directory });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.ok(f.calls().every(({ cwd }) => cwd === directory));
  assert.ok(f.calls().every(({ args }) => !args.includes("--author") && !args.some((arg) => arg.startsWith("user."))));
});
