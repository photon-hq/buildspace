import { photon } from "@photon-hq/vp-config";

export default photon(
  {
    type: "cli",
    // The scripts are plain JavaScript and have no TypeScript project.
    typeAware: false,
  },
  {
    fmt: {
      ignorePatterns: [
        "**/*.yaml",
        "**/*.yml",
        "**/*.md",
        "**/*.py",
        "**/*.swift",
        ".github/package-release/package*.json",
        ".github/blocks/check-production-dependencies/package*.json",
      ],
    },
    lint: {
      name: "buildspace/node-tests",
      files: [
        "test/*.test.mjs",
        ".github/blocks/check-production-dependencies/*.test.mjs",
      ],
      // CI uses node --test and its --import preload, not Vitest.
      rules: { "vitest/no-import-node-test": "off" },
    },
  }
);
