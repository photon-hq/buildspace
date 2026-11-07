import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import semver from "semver";
import { cached, collect, GITHUB_PACKAGES, registryMetadata, releaseNames } from "./package-artifacts.mjs";
import { crateVersionFindings, releasedCrates, resolveCandidate } from "./package-promotion.mjs";
import { crateTable, packageTable, publish, releaseNotes, waitForCi } from "./package-publish.mjs";
import { bumpNotes, releaseBump, releaseChanges } from "./release-version.mjs";

export {
  sha256,
  integrity,
  exec,
  notFound,
  registryMetadata,
  readTarballManifest,
  readArchive,
  readCrate,
  bumpProblem,
  publishOrder,
  releaseNames,
  collect,
  readManifest,
  verifyManifest,
} from "./package-artifacts.mjs";
export {
  ciStatus,
  waitForCi,
  tagCommit,
  changesSince,
  releaseNotes,
  ensureTag,
  ensureRelease,
  publishedIntegrity,
  publish,
} from "./package-publish.mjs";
export {
  dependencyFindings,
  releasedCrates,
  crateVersionFindings,
  workspaceManifest,
  crateDependencyFindings,
  stagedBuild,
  requireReviewers,
  resolveCandidate,
} from "./package-promotion.mjs";

async function summarize(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

async function outputs(values) {
  if (process.env.GITHUB_OUTPUT)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join("")
    );
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      channel: { type: "string" },
      "crate-directory": { type: "string" },
      crates: { type: "string" },
      directory: { type: "string" },
      "approved-by": { type: "string", default: "" },
      bump: { type: "string" },
      environment: { type: "string" },
      "image-tag": { type: "string", default: "" },
      output: { type: "string" },
      package: { type: "string", default: "" },
      paths: { type: "string", default: "" },
      production: { type: "string" },
      "signer-workflow": { type: "string" },
      staging: { type: "string" },
      suffix: { type: "string" },
      "tag-prefix": { type: "string", default: "" },
      "production-tag-prefix": { type: "string", default: "" },
      registry: { type: "string", default: GITHUB_PACKAGES },
      "timeout-minutes": { type: "string", default: "20" },
      version: { type: "string", default: "" },
      workflow: { type: "string" },
    },
  });
  const env = process.env;
  const repository = env.GITHUB_REPOSITORY;
  const runUrl = `${env.GITHUB_SERVER_URL}/${repository}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`;
  const crates = values.crates?.split(/\s+/).filter(Boolean);
  switch (positionals[0]) {
    case "wait-ci":
      await waitForCi({
        repository,
        sha: env.GITHUB_SHA,
        workflow: values.workflow,
        timeoutMs: Number(values["timeout-minutes"]) * 60_000,
      });
      console.log(`${values.workflow} passed on ${env.GITHUB_SHA}`);
      return;
    case "version": {
      const { productionTagPrefix: prefix } = releaseNames(repository, "", "", values["production-tag-prefix"]);
      const paths = values.paths.split(/\s+/).filter(Boolean);
      const pending = env.GITHUB_EVENT_NAME === "pull_request"
        ? JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8")).pull_request
        : undefined;
      const bump = releaseBump(releaseChanges({ repository, prefix, paths, head: env.GITHUB_SHA, pending }));
      for (const warning of bump.warnings) console.log(`::warning::${warning}`);
      await summarize(bumpNotes(bump, repository).join("\n"));
      await outputs({ version: bump.version, bump: JSON.stringify(bump) });
      return;
    }
    case "collect": {
      const manifest = await collect({
        stagingDirectory: resolve(values.staging),
        productionDirectory: resolve(values.production),
        crateDirectory: values["crate-directory"] && resolve(values["crate-directory"]),
        crates: crates ?? [],
        suffix: values.suffix,
        bump: JSON.parse(values.bump ?? "null"),
        sourceSha: env.GITHUB_SHA,
        repository,
        packageInput: values.package,
        tagPrefix: values["tag-prefix"],
        productionTagPrefix: values["production-tag-prefix"],
        registryUrl: values.registry,
        output: resolve(values.output),
        runUrl,
      });
      const warnings = [];
      const lookup = cached(registryMetadata(manifest.registry));
      for (const pkg of manifest.packages) {
        const { version, integrity: packed } = pkg.production;
        const metadata = await lookup(pkg.name);
        const released = metadata.versions[version];
        const latest = metadata["dist-tags"].latest;
        if (released ? released.dist?.integrity !== packed : latest && !semver.gt(version, latest))
          warnings.push(`${pkg.name}@${version} cannot be promoted: ${released ? "it is released with other contents" : `latest is ${latest}`}. Merge a change inside the build's paths, or a Release-As, and stage again.`);
      }
      const crateHistory = releasedCrates({ repository, latest: (await lookup(manifest.package))["dist-tags"].latest });
      const findings = await crateVersionFindings(manifest, resolve(values.output), crateHistory);
      for (const warning of warnings) console.log(`::warning::${warning}`);
      if (findings.length)
        throw new Error(`This build cannot be staged:\n${findings.map((finding) => `- ${finding}`).join("\n")}`);
      const primary = manifest.packages.find(({ name }) => name === manifest.package);
      await summarize(
        [
          "### Staged packages",
          "",
          ...packageTable(manifest, ["staging", "production"]),
          ...crateTable(manifest, manifest.stagingTag),
          "",
          `Promote with \`staging-version: ${primary.staging.version}\`.`,
          ...warnings.map((warning) => `\n> [!WARNING]\n> ${warning}`),
        ].join("\n")
      );
      await outputs({ "staging-version": primary.staging.version, "production-version": primary.production.version });
      return;
    }
    case "publish": {
      const { tag } = await publish({
        directory: resolve(values.directory),
        channel: values.channel,
        repository,
        sourceSha: values.channel === "staging" ? env.GITHUB_SHA : undefined,
        packageInput: values.package,
        tagPrefix: values["tag-prefix"],
        productionTagPrefix: values["production-tag-prefix"],
        registryUrl: values.registry,
        crates,
        runId: env.GITHUB_RUN_ID,
        runAttempt: env.GITHUB_RUN_ATTEMPT,
        bump: values.bump && JSON.parse(values.bump),
      });
      await summarize(`Published ${values.channel} release [\`${tag}\`](${env.GITHUB_SERVER_URL}/${repository}/releases/tag/${tag}).`);
      return;
    }
    case "resolve": {
      const { manifest, changes, pending } = await resolveCandidate({
        repository,
        packageInput: values.package,
        tagPrefix: values["tag-prefix"],
        productionTagPrefix: values["production-tag-prefix"],
        registryUrl: values.registry,
        version: values.version,
        imageTag: values["image-tag"],
        approvedBy: values["approved-by"],
        environment: values.environment,
        signerWorkflow: values["signer-workflow"],
        output: resolve(values.output),
      });
      if (!manifest) {
        await summarize("### Nothing to release\n\nPackages are staged from `main`; a hotfix image releases none.");
        await outputs({ pending, version: "" });
        return;
      }
      await summarize(
        pending
          ? [
              `### Promote \`${manifest.stagingTag}\` to production`,
              "",
              releaseNotes(manifest, "production", changes),
              values["approved-by"]
                ? `Dispatched by \`${values["approved-by"]}\`, whose dispatch is the approval: these exact files are published under \`latest\`.`
                : "Approve the deployment to publish these exact files under `latest`.",
            ].join("\n")
          : [
              `### \`${manifest.stagingTag}\` is already released`,
              "",
              ...packageTable(manifest, ["production"]),
              "",
              `Every candidate is published with these contents as \`${manifest.productionTag}\`. Nothing to publish.`,
            ].join("\n")
      );
      await outputs({
        pending,
        version: manifest.packages.find(({ name }) => name === manifest.package).production.version,
      });
      return;
    }
    default:
      throw new Error("Usage: package-release.mjs wait-ci|version|collect|publish|resolve [options]");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(`::error::${error.message.replaceAll("\n", "%0A")}`);
    process.exitCode = 1;
  }
}
