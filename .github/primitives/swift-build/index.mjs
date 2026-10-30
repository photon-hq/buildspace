import { resolve } from "node:path";
import { input, main, output, run } from "../runtime.mjs";

export function swiftBuild({ product, directory = "." }) {
  run("swift", ["build", "-c", "release", "--product", product], { cwd: directory });
  const binaryDirectory = run("swift", ["build", "-c", "release", "--show-bin-path"], { cwd: directory, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" }).trim();
  return resolve(directory, binaryDirectory, `${product}${process.platform === "win32" ? ".exe" : ""}`);
}

await main(import.meta.url, () => output("binary-path", swiftBuild({ product: input("product"), directory: input("working-directory", ".") })));
