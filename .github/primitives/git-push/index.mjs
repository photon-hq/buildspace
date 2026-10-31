import { spawnSync } from "node:child_process";
import { input, main, run } from "../runtime.mjs";

function gitConfig(args, directory) {
  const result = spawnSync("git", ["config", ...args], { cwd: directory, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status === 1) return "";
  if (result.status !== 0) throw new Error("Could not read Git push configuration");
  return result.stdout.trimEnd();
}

export function pushGit({ refspec = "", remote = "origin", directory = "." }) {
  if (refspec.startsWith("+")) throw new Error("Forced refspecs are not supported");
  const groups = gitConfig(["--get-regexp", "^remotes\\."], directory);
  if (groups.split("\n").some((line) => line.split(/\s/, 1)[0].toLowerCase() === `remotes.${remote.toLowerCase()}`)) {
    throw new Error("Push one remote at a time; remote groups are not supported");
  }
  if (gitConfig(["--bool", "--get", `remote.${remote}.mirror`], directory) === "true") {
    throw new Error("Mirrored remotes are not supported");
  }
  if (!refspec && gitConfig(["--get-all", `remote.${remote}.push`], directory).split("\n").some((value) => value.startsWith("+"))) {
    throw new Error("Forced configured refspecs are not supported");
  }
  run("git", ["push", "--no-force", "--", remote, ...(refspec ? [refspec] : [])], { cwd: directory });
}

await main(import.meta.url, () => pushGit({ refspec: input("refspec", ""), remote: input("remote", "origin"), directory: input("working-directory", ".") }));
