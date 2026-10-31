import { spawnSync } from "node:child_process";
import { input, main, output, run } from "../runtime.mjs";

export function commitGit({ message, directory = "." }) {
  const diff = spawnSync("git", ["diff", "--cached", "--quiet", "--exit-code"], { cwd: directory, stdio: "inherit" });
  if (diff.error) throw diff.error;
  if (diff.status === 0) return { committed: false, "commit-sha": "" };
  if (diff.status !== 1) {
    const error = new Error("Could not inspect the Git index");
    error.exitCode = diff.status || 1;
    throw error;
  }
  run("git", ["commit", "--message", message], { cwd: directory });
  const sha = run("git", ["rev-parse", "HEAD"], { cwd: directory, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" }).trim();
  return { committed: true, "commit-sha": sha };
}

await main(import.meta.url, () => {
  for (const [name, value] of Object.entries(commitGit({ message: input("message"), directory: input("working-directory", ".") }))) output(name, value);
});
