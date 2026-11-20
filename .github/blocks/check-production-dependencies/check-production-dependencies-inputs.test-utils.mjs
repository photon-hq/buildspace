import { mkdir, writeFile } from "node:fs/promises";
import nodePath from "node:path";
import { stringify } from "yaml";

export const writeInputs = async (root, inputs) => {
  await mkdir(nodePath.join(root, "apps/example"), { recursive: true });
  await writeFile(
    nodePath.join(root, "pnpm-workspace.yaml"),
    stringify(inputs.workspace)
  );
  await writeFile(
    nodePath.join(root, "pnpm-lock.yaml"),
    stringify(inputs.lockfile)
  );

  for (const [path, manifest] of Object.entries(inputs.manifests)) {
    await writeFile(
      nodePath.join(root, path, "package.json"),
      JSON.stringify(manifest)
    );
  }
};

export const toolchainFixture = () => ({
  lockfileVersion: "9.0",
  importers: {
    ".": {
      configDependencies: {},
      packageManagerDependencies: {
        pnpm: { specifier: "12.11.2", version: "12.11.2" },
      },
    },
  },
  packages: { "pnpm@12.11.2": {} },
  snapshots: { "pnpm@12.11.2": {} },
});

export const writeLockfiles = async (root, documents) => {
  await writeFile(
    nodePath.join(root, "pnpm-lock.yaml"),
    documents.map((document) => `---\n${stringify(document)}`).join("\n")
  );
};
