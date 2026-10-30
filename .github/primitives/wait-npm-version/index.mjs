import { spawnSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { input, main, output } from "../runtime.mjs";

export async function waitNpmVersion({ package: name, version, registry, attempts = 6, intervalSeconds = 5, env = process.env }) {
  if (!Number.isInteger(attempts) || attempts < 1 || !Number.isFinite(intervalSeconds) || intervalSeconds < 0) {
    throw new Error("attempts must be a positive integer and interval-seconds must be nonnegative");
  }
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", 'npm view "$@"', "--", `${name}@${version}`, "version", "--registry", registry], { env, encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status === 0 && result.stdout.trim() === version) return version;
    if (attempt < attempts) await setTimeout(intervalSeconds * 1000);
  }
  throw new Error(`${name}@${version} is not visible on the requested registry`);
}

await main(import.meta.url, async () => output("version", await waitNpmVersion({
  package: input("package"), version: input("version"), registry: input("registry"),
  attempts: Number(input("attempts", "6")), intervalSeconds: Number(input("interval-seconds", "5")),
})));
