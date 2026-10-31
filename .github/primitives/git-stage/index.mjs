import { input, main, run } from "../runtime.mjs";

export function stageGit({ paths, directory = "." }) {
  if (!Array.isArray(paths) || paths.length === 0 || paths.some((path) => typeof path !== "string" || !path)) {
    throw new Error("paths must be a nonempty JSON array of nonempty Git pathspecs");
  }
  run("git", ["add", "--all", "--", ...paths], { cwd: directory });
}

await main(import.meta.url, () => stageGit({ paths: JSON.parse(input("paths")), directory: input("working-directory", ".") }));
