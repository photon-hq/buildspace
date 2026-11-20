import { mkdirSync } from "node:fs";
import path from "node:path";
import { input, main, output, run } from "../runtime.mjs";

export const goBuild = function goBuild({
  output: destination,
  goos,
  goarch,
  flags = "",
  ldflags = "-s -w",
  directory = ".",
}) {
  const binary = path.resolve(directory, destination);
  mkdirSync(path.dirname(binary), { recursive: true });
  run(
    "bash",
    [
      "-euo",
      "pipefail",
      "-c",
      `go build ${flags} -ldflags "$BUILD_LDFLAGS" -o "$BUILD_OUTPUT" .`,
    ],
    {
      cwd: directory,
      env: {
        ...process.env,
        GOOS: goos,
        GOARCH: goarch,
        CGO_ENABLED: "0",
        BUILD_LDFLAGS: ldflags,
        BUILD_OUTPUT: binary,
      },
    }
  );

  return binary;
};

await main(import.meta.url, () =>
  output(
    "binary-path",
    goBuild({
      output: input("output"),
      goos: input("goos"),
      goarch: input("goarch"),
      flags: input("build-flags", ""),
      ldflags: input("ldflags", "-s -w"),
      directory: input("working-directory", "."),
    })
  )
);
