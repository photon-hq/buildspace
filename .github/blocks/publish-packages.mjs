import { packageInfo } from "../primitives/npm-package-info/index.mjs";
import { publishNpm } from "../primitives/npm-publish/index.mjs";
import { waitNpmVersion } from "../primitives/wait-npm-version/index.mjs";
import { main, run } from "../primitives/runtime.mjs";

export async function publishPackages({ packages, buildCommand, rootBuildCommand, registry, tag, dryRun, owner = "", access = "", verifyTimeoutSeconds, env = process.env }) {
  if (owner && !dryRun && !env.NODE_AUTH_TOKEN) throw new Error("No GitHub Packages token was provided");
  if (verifyTimeoutSeconds !== undefined && !(Number.isInteger(verifyTimeoutSeconds) && verifyTimeoutSeconds >= 0)) {
    throw new Error("verify-timeout-seconds must be a whole number of seconds");
  }
  // The npmjs recipe passes a timeout and waits for the tag too; the GitHub Packages recipes keep six fixed reads.
  const verification = verifyTimeoutSeconds === undefined ? {} : { timeoutSeconds: verifyTimeoutSeconds, distTag: tag };
  for (const { path: directory } of packages) {
    const { name, version } = packageInfo(directory);
    if (owner && !name.toLowerCase().startsWith(`@${owner.toLowerCase()}/`)) {
      throw new Error(`GitHub Packages requires @${owner}/<package>, found ${name}`);
    }
    if (!rootBuildCommand) run("bash", ["-euo", "pipefail", "-c", buildCommand], { cwd: directory, env });
    await publishNpm({ directory, registry, tag, dryRun, access, command: "bun publish", env });
    if (!dryRun) await waitNpmVersion({ package: name, version, registry, env, ...verification });
  }
}

// Only the npmjs recipe sets VERIFY_TIMEOUT_SECONDS; anything but a whole number fails before publishing.
const verifyTimeout = process.env.VERIFY_TIMEOUT_SECONDS;

await main(import.meta.url, () => publishPackages({
  packages: JSON.parse(process.env.CHANGED_JSON), buildCommand: process.env.BUILD_CMD,
  rootBuildCommand: process.env.ROOT_BUILD_CMD, registry: process.env.REGISTRY_URL,
  tag: process.env.TAG, dryRun: process.env.DRY_RUN === "true", owner: process.env.PACKAGE_OWNER, access: process.env.PACKAGE_ACCESS,
  verifyTimeoutSeconds: verifyTimeout === undefined ? undefined : /^\d+$/.test(verifyTimeout) ? Number(verifyTimeout) : NaN,
}));
