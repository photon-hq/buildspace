import path from "node:path";
import { input, main, output, run } from "../runtime.mjs";

// flags are split on whitespace and passed as arguments, never through a shell. An empty product builds the whole package.
export const swiftBuild = function swiftBuild({
  product = "",
  directory = ".",
  flags = "",
}) {
  const extra = flags.split(/\s+/).filter(Boolean);
  run(
    "swift",
    [
      "build",
      "-c",
      "release",
      ...(product ? ["--product", product] : []),
      ...extra,
    ],
    { cwd: directory }
  );

  const binPath = path.resolve(
    directory,
    run("swift", ["build", "-c", "release", ...extra, "--show-bin-path"], {
      cwd: directory,
      stdio: ["ignore", "pipe", "inherit"],
      encoding: "utf-8",
    }).trim()
  );

  return {
    binPath,
    binaryPath: product
      ? path.join(
          binPath,
          `${product}${process.platform === "win32" ? ".exe" : ""}`
        )
      : "",
  };
};

await main(import.meta.url, () => {
  const { binPath, binaryPath } = swiftBuild({
    product: input("product", ""),
    directory: input("working-directory", "."),
    flags: input("build-flags", ""),
  });

  output("bin-path", binPath);
  output("binary-path", binaryPath);
});
