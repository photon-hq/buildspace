import { resolve } from "node:path";
import { input, main, output, run } from "../runtime.mjs";

// flags are split on whitespace and passed as arguments, never through a shell.
export function swiftBuild({ product, directory = ".", flags = "" }) {
  const extra = flags.split(/\s+/).filter(Boolean);
  run("swift", ["build", "-c", "release", "--product", product, ...extra], { cwd: directory });
  const binaryDirectory = run("swift", ["build", "-c", "release", ...extra, "--show-bin-path"], { cwd: directory, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" }).trim();
  return resolve(directory, binaryDirectory, `${product}${process.platform === "win32" ? ".exe" : ""}`);
}

await main(import.meta.url, () => output("binary-path", swiftBuild({ product: input("product"), directory: input("working-directory", "."), flags: input("build-flags", "") })));
