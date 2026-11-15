import { spawnSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { input, main, output } from "../runtime.mjs";

// With a timeout, the pause between reads doubles from interval-seconds up to this.
const BACKOFF_CEILING_SECONDS = 30;

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** One read of the exact version, classified by what it says about the publication. */
function read({ name, version, registry, integrity, distTag, env }) {
  const result = spawnSync("bash", ["-euo", "pipefail", "-c", 'npm view "$@"', "--", `${name}@${version}`, "version", "dist.integrity", "dist-tags", "--json", "--registry", registry], { env, encoding: "utf8" });
  if (result.error) throw result.error;
  const data = parse(result.stdout.trim() || "null");
  if (result.status !== 0) {
    const code = data?.error?.code ?? /npm (?:error|ERR!) code (\S+)/.exec(result.stderr)?.[1];
    if (code === "E404") return { state: "absent", reason: "not found (E404)" };
    const summary = data?.error?.summary ?? result.stderr.trim().split("\n")[0];
    return { state: "error", reason: `the read failed: ${summary || `npm exited with code ${result.status}`}` };
  }
  // npm prints a bare value when only one requested field exists, and an array when several versions match.
  const fields = [data].flat().map((entry) => (typeof entry === "string" ? { version: entry } : entry)).find((entry) => entry?.version === version);
  if (!fields) return { state: "absent", reason: "not listed yet" };
  if (integrity && fields["dist.integrity"] !== integrity) return { state: "different", actual: fields["dist.integrity"] };
  if (distTag && fields["dist-tags"]?.[distTag] !== version) {
    const tagged = fields["dist-tags"]?.[distTag];
    return { state: "untagged", tagged, reason: `listed, but the ${distTag} dist-tag names ${tagged ?? "no version"}` };
  }
  return { state: "visible" };
}

/**
 * Reads the registry until it serves the exact version. Without a timeout it makes a fixed number of
 * reads; with one it backs off until the deadline, because npm can take minutes to show a new version.
 */
export async function waitNpmVersion({
  package: name,
  version,
  registry,
  attempts = 6,
  intervalSeconds = 5,
  timeoutSeconds,
  integrity = "",
  distTag = "",
  env = process.env,
  now = Date.now,
  sleep = (ms) => setTimeout(ms),
  log = console.log,
}) {
  if (!Number.isInteger(attempts) || attempts < 1 || !Number.isFinite(intervalSeconds) || intervalSeconds < 0) {
    throw new Error("attempts must be a positive integer and interval-seconds must be nonnegative");
  }
  if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0)) {
    throw new Error("timeout-seconds must be a nonnegative number");
  }
  const spec = `${name}@${version}`;
  const started = now();
  const deadline = timeoutSeconds === undefined ? undefined : started + timeoutSeconds * 1000;
  const ceiling = Math.max(BACKOFF_CEILING_SECONDS, intervalSeconds);
  let pause = intervalSeconds;
  let reads = 0;
  let last;
  for (;;) {
    last = read({ name, version, registry, integrity, distTag, env });
    reads++;
    if (last.state === "visible") return version;
    if (last.state === "different") {
      throw new Error(`${spec} on ${registry} has integrity ${last.actual ?? "(none)"}, not ${integrity}: different contents were published under this version`);
    }
    const remaining = deadline === undefined ? undefined : (deadline - now()) / 1000;
    if (deadline === undefined ? reads >= attempts : remaining <= 0) break;
    const seconds = deadline === undefined ? intervalSeconds : Math.min(pause, remaining);
    log(`${spec} on ${registry}: ${last.reason}; reading again in ${Math.ceil(seconds)}s`);
    await sleep(seconds * 1000);
    if (deadline !== undefined) pause = Math.min(ceiling, Math.max(1, pause * 2));
  }
  const waited = `after ${reads} ${reads === 1 ? "read" : "reads"} over ${Math.round((now() - started) / 1000)}s`;
  if (last.state === "untagged") {
    throw new Error(`${spec} is on ${registry}, but its ${distTag} dist-tag names ${last.tagged ?? "no version"} ${waited}`);
  }
  throw new Error(`${spec} is not visible on ${registry} ${waited} (last read: ${last.reason}). npm can take several minutes to serve a new version; check for it before publishing this version again`);
}

const optionalNumber = (name) => {
  const value = input(name, "").trim();
  return value === "" ? undefined : Number(value);
};

await main(import.meta.url, async () => output("version", await waitNpmVersion({
  package: input("package"), version: input("version"), registry: input("registry"),
  attempts: Number(input("attempts", "6")), intervalSeconds: Number(input("interval-seconds", "5")),
  timeoutSeconds: optionalNumber("timeout-seconds"), integrity: input("integrity", ""), distTag: input("dist-tag", ""),
})));
