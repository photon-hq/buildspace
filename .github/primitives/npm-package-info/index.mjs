import { readFileSync } from "node:fs";
import { join } from "node:path";
import { input, main, output } from "../runtime.mjs";

export function packageInfo(directory = ".") {
  const { name, version } = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  if (typeof name !== "string" || !name || typeof version !== "string" || !version) {
    throw new Error(`Missing package name or version in ${directory}/package.json`);
  }
  return { name, version };
}

await main(import.meta.url, () => {
  for (const [name, value] of Object.entries(packageInfo(input("working-directory", ".")))) output(name, value);
});
