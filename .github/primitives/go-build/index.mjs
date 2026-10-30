import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { input, main, output, run } from "../runtime.mjs";

export function goBuild({ output: destination, goos, goarch, flags = "", ldflags = "-s -w", directory = "." }) {
  const binary = resolve(directory, destination);
  mkdirSync(dirname(binary), { recursive: true });
  run("bash", ["-euo", "pipefail", "-c", `go build ${flags} -ldflags "$BUILD_LDFLAGS" -o "$BUILD_OUTPUT" .`], {
    cwd: directory,
    env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: "0", BUILD_LDFLAGS: ldflags, BUILD_OUTPUT: binary },
  });
  return binary;
}

await main(import.meta.url, () => output("binary-path", goBuild({
  output: input("output"), goos: input("goos"), goarch: input("goarch"), flags: input("build-flags", ""),
  ldflags: input("ldflags", "-s -w"), directory: input("working-directory", "."),
})));
