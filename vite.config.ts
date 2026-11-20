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
    lint: [
      {
        name: "buildspace/node-tests",
        files: [
          "test/*.test.mjs",
          ".github/blocks/check-production-dependencies/*.test.mjs",
        ],
        // CI uses node --test and its --import preload, not Vitest.
        rules: { "vitest/no-import-node-test": "off" },
      },
      {
        name: "buildspace/raw-inputs",
        files: [
          ".github/blocks/check-production-dependencies/dependency-check-utils.mjs",
          ".github/blocks/check-production-dependencies/internal-crates.mjs",
          ".github/blocks/check-production-dependencies/pnpm-graph.mjs",
          ".github/blocks/check-production-dependencies/production-inputs.mjs",
          ".github/package-release/package-artifact-files.mjs",
          ".github/package-release/package-crate-promotion.mjs",
          ".github/package-release/package-release-policy.mjs",
          ".github/primitives/runtime.mjs",
        ],
        // Keep primitive type checks at CLI, JSON, TOML, and YAML input boundaries.
        rules: { "anti-slop/no-runtime-typeof": "off" },
      },
      {
        name: "buildspace/execute-permissions",
        files: [".github/primitives/stage-file/index.mjs"],
        // Adding execute bits must preserve the rest of the file mode.
        rules: { "no-bitwise": ["error", { allow: ["|"] }] },
      },
      {
        name: "buildspace/permission-assertions",
        files: ["test/primitives.test.mjs"],
        // Keep the assertions for individual POSIX permission bits.
        rules: { "no-bitwise": ["error", { allow: ["&"] }] },
      },
      {
        name: "buildspace/offline-test-fixtures",
        files: [
          ".github/blocks/check-production-dependencies/internal-crates-release.cases.mjs",
          "test/fixtures/package-release-cli-preload.mjs",
        ],
        // The Cargo lookup test and node --import preload replace fetch to keep tests offline.
        rules: { "landmines-testing/no-test-doubles": "off" },
      },
    ],
  }
);
