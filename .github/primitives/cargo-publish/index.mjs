import { input, main, run } from "../runtime.mjs";

export function publishCrate({ package: packageName = "", directory = ".", dryRun = false, allowDirty = false }) {
  const args = ["publish"];
  if (packageName) args.push("--package", packageName);
  if (dryRun) args.push("--dry-run");
  if (allowDirty) args.push("--allow-dirty");
  run("cargo", args, { cwd: directory });
}

await main(import.meta.url, () => publishCrate({
  package: input("package", ""), directory: input("working-directory", "."),
  dryRun: input("dry-run", "false") === "true", allowDirty: input("allow-dirty", "false") === "true",
}));
