import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const primitives = fileURLToPath(
  new URL("../../.github/primitives/", import.meta.url)
);

const fixture = (t) => {
  const root = mkdtempSync(nodePath.join(tmpdir(), "buildspace-primitives-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = nodePath.join(root, "bin");
  mkdirSync(bin);
  const log = nodePath.join(root, "commands.jsonl");

  const env = {
    ...process.env,
    NODE_AUTH_TOKEN: "",
    PATH: `${bin}:${process.env.PATH}`,
    COMMAND_LOG: log,
    GITHUB_OUTPUT: nodePath.join(root, "outputs"),
    TEST_ROOT: root,
  };

  const stub = (name, source) =>
    writeFileSync(
      nodePath.join(bin, name),
      `#!${process.execPath}\n${source}`,
      {
        mode: 0o755,
      }
    );

  const record = `require('node:fs').appendFileSync(process.env.COMMAND_LOG, JSON.stringify({command: require('node:path').basename(process.argv[1]), args: process.argv.slice(2), cwd: process.cwd(), goos: process.env.GOOS, goarch: process.env.GOARCH, cgo: process.env.CGO_ENABLED}) + '\\n');`;

  const commands = () =>
    existsSync(log)
      ? readFileSync(log, "utf-8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(JSON.parse)
      : [];

  const action = (name, values = {}, overrides = {}) =>
    spawnSync(
      process.execPath,
      [nodePath.join(primitives, name, "index.mjs")],
      {
        cwd: root,
        env: {
          ...env,
          ...Object.fromEntries(
            Object.entries(values).map(([key, value]) => [
              `INPUT_${key.toUpperCase()}`,
              value,
            ])
          ),
          ...overrides,
        },
        encoding: "utf-8",
      }
    );

  return { root, env, stub, record, commands, action };
};

const outputs = (path) => {
  const lines = readFileSync(path, "utf-8").split("\n");
  const result = {};

  while (lines.length > 1) {
    const [key, delimiter] = lines.shift().split("<<");
    const end = lines.indexOf(delimiter);
    assert.notEqual(end, -1);
    result[key] = lines.splice(0, end).join("\n");
    lines.shift();
  }

  return result;
};

export { fixture, outputs };
