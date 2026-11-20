import { readFileSync } from "node:fs";
import path from "node:path";
import { input, isNonemptyString, main, output } from "../runtime.mjs";

export const packageInfo = function packageInfo(directory = ".") {
  const { name, version } = JSON.parse(
    readFileSync(path.join(directory, "package.json"), "utf-8")
  );

  if (!isNonemptyString(name) || !isNonemptyString(version)) {
    throw new Error(
      `Missing package name or version in ${directory}/package.json`
    );
  }

  return { name, version };
};

await main(import.meta.url, () => {
  for (const [name, value] of Object.entries(
    packageInfo(input("working-directory", "."))
  )) {
    output(name, value);
  }
});
