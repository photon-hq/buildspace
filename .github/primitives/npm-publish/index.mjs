import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { input, main, output } from "../runtime.mjs";

export async function publishNpm({ directory = ".", registry, tag = "latest", access = "", dryRun = false, provenance = false, command = "npm publish", env = process.env }) {
  const args = ["--registry", registry, "--tag", tag];
  if (access) args.push("--access", access);
  if (dryRun) args.push("--dry-run");
  if (provenance) args.push("--provenance");
  const child = spawn("bash", ["-euo", "pipefail", "-c", `${command} "$@"`, "--", ...args], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
  let reportedError = false;
  for (const [source, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    source.on("data", (chunk) => destination.write(chunk));
    createInterface({ input: source }).on("line", (line) => {
      if (/^npm (error|ERR!)/.test(line)) reportedError = true;
    });
  }
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => resolve(status ?? 1));
  });
  if (code !== 0 || reportedError) {
    const error = new Error(code !== 0 ? `Publisher exited with code ${code}` : "Publisher exited successfully but emitted an npm error");
    error.publisherExitCode = code;
    error.exitCode = code || 1;
    throw error;
  }
  return code;
}

await main(import.meta.url, async () => {
  try {
    output("exit-code", await publishNpm({
      directory: input("working-directory", "."), registry: input("registry"), tag: input("tag", "latest"),
      access: input("access", ""), dryRun: input("dry-run", "false") === "true", provenance: input("provenance", "false") === "true", command: input("command", "npm publish"),
    }));
  } catch (error) {
    if (error.publisherExitCode !== undefined) output("exit-code", error.publisherExitCode);
    throw error;
  }
});
