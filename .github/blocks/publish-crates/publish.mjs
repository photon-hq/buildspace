import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { publishCrate } from "../../primitives/cargo-publish/index.mjs";
import { main } from "../../primitives/runtime.mjs";

await main(import.meta.url, async () => {
  const crates = JSON.parse(process.env.CRATES);
  const dryRun = process.env.DRY_RUN === "true";
  if (!crates.length) throw new Error("No crates specified; provide crate paths or package names");
  for (const crate of crates) {
    const options = existsSync(join(crate, "Cargo.toml")) ? { directory: crate } : { package: crate };
    const attempts = dryRun ? 1 : 3;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        publishCrate({ ...options, dryRun, allowDirty: true });
        break;
      } catch (error) {
        if (attempt === attempts) throw error;
        await setTimeout(30000);
      }
    }
    if (!dryRun) await setTimeout(10000);
  }
});
