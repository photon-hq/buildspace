import { chmodSync, copyFileSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { input, main, output } from "../runtime.mjs";

export function stageFile({ source, destination, executable = false }) {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  if (executable) chmodSync(destination, statSync(destination).mode | 0o111);
  return { name: basename(destination), path: destination };
}

await main(import.meta.url, () => {
  const result = stageFile({ source: input("source"), destination: input("destination"), executable: input("executable", "false") === "true" });
  for (const [name, value] of Object.entries(result)) output(name, value);
});
