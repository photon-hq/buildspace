import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const input = function input(name, fallback) {
  const value = process.env[`INPUT_${name.toUpperCase()}`] ?? fallback;

  if (value === undefined || (value === "" && fallback === undefined)) {
    throw new Error(`Missing required input: ${name}`);
  }

  return value;
};

export const output = function output(name, value) {
  const delimiter = `buildspace_${randomUUID()}`;
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `${name}<<${delimiter}\n${value}\n${delimiter}\n`
  );
};

export const run = function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const error = new Error(
      `${command} failed with ${result.signal ?? `exit code ${result.status}`}`
    );

    error.exitCode = result.status || 1;
    throw error;
  }

  return result.stdout;
};

export const main = async (url, callback) => {
  if (
    !process.argv[1] ||
    path.resolve(process.argv[1]) !== fileURLToPath(url)
  ) {
    return;
  }

  try {
    await callback();
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode || 1;
  }
};
