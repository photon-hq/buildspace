import { mkdirSync } from "node:fs";
import path from "node:path";
import { input, main, output, run } from "../runtime.mjs";

export const pkgbuild = function pkgbuild({
  root,
  identifier,
  version,
  output: destination,
  installLocation = "/",
  scripts = "",
}) {
  mkdirSync(path.dirname(destination), { recursive: true });

  const args = [
    "--root",
    root,
    "--identifier",
    identifier,
    "--install-location",
    installLocation,
    "--version",
    version,
  ];

  if (scripts) {
    args.push("--scripts", scripts);
  }

  run("pkgbuild", [...args, destination]);

  return destination;
};

await main(import.meta.url, () =>
  output(
    "package-path",
    pkgbuild({
      root: input("root"),
      identifier: input("identifier"),
      version: input("version"),
      output: input("output"),
      installLocation: input("install-location", "/"),
      scripts: input("scripts", ""),
    })
  )
);
