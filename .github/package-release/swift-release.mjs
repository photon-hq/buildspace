import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { exec } from "./package-release.mjs";
import { collect, releaseNotes } from "./swift-release-manifest.mjs";
import { publish, resolveCandidate } from "./swift-release-publish.mjs";
import { soakSummary } from "./swift-release-soak.mjs";

export {
  dependencyFindings,
  packageDeclarations,
} from "./swift-release-dependencies.mjs";

export {
  candidateFile,
  packageFile,
  readManifest,
  verifyManifest,
} from "./swift-release-manifest.mjs";

export { formatAge, parseAge, stagingSoak } from "./swift-release-soak.mjs";

export { collect, publish, releaseNotes, resolveCandidate, soakSummary };

const main = async () => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      "approved-by": { type: "string", default: "" },
      bump: { type: "string" },
      channel: { type: "string" },
      directory: { type: "string" },
      environment: { type: "string" },
      library: { type: "string", default: "false" },
      "minimum-age": { type: "string", default: "" },
      output: { type: "string" },
      package: { type: "string" },
      production: { type: "string" },
      "signer-workflow": { type: "string" },
      "skip-minimum-age-reason": { type: "string", default: "" },
      staging: { type: "string" },
      suffix: { type: "string" },
      version: { type: "string", default: "" },
    },
  });

  const { env } = process;
  const repository = env.GITHUB_REPOSITORY;
  const library = values.library === "true";

  const summarize = (markdown) =>
    env.GITHUB_STEP_SUMMARY &&
    writeFile(env.GITHUB_STEP_SUMMARY, `${markdown}\n`, { flag: "a" });

  const outputs = (entries) =>
    env.GITHUB_OUTPUT &&
    writeFile(
      env.GITHUB_OUTPUT,
      Object.entries(entries)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
      { flag: "a" }
    );

  switch (positionals[0]) {
    case "collect": {
      const manifest = await collect({
        stagingPackage: values.staging && path.resolve(values.staging),
        productionPackage: values.production && path.resolve(values.production),
        packageName: values.package,
        library,
        bump: JSON.parse(values.bump ?? "null"),
        suffix: values.suffix,
        sourceSha: env.GITHUB_SHA,
        repository,
        output: path.resolve(values.output),
        runUrl: `${env.GITHUB_SERVER_URL}/${repository}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`,
      });

      await summarize(releaseNotes(manifest, "staging"));
      await outputs({
        "staging-version": manifest.stagingTag.slice(1),
        "production-version": manifest.productionTag.slice(1),
      });

      return;
    }

    case "publish": {
      let published;

      try {
        published = await publish({
          directory: path.resolve(values.directory),
          channel: values.channel,
          repository,
          sourceSha: values.channel === "staging" ? env.GITHUB_SHA : undefined,
          packageName: values.package,
          library,
          runId: env.GITHUB_RUN_ID,
          bump: values.bump && JSON.parse(values.bump),
        });
      } catch (error) {
        const skip =
          "A release came out after this build was resolved. To promote now, run the promotion again with `skip-minimum-age-reason`.";

        if (error.soak) {
          await summarize(
            soakSummary(
              error.soak,
              `Some changes were on staging for less than the minimum time since then. ${skip}`
            ).join("\n")
          );
        }

        if (error.unchecked !== undefined) {
          await summarize(
            soakSummary(
              undefined,
              `Cannot check the time on staging again. ${error.unchecked} ${skip}`
            ).join("\n")
          );
        }

        throw error;
      }

      const { tag } = published;
      await summarize(
        `Published ${values.channel} release [\`${tag}\`](${env.GITHUB_SERVER_URL}/${repository}/releases/tag/${tag}).`
      );

      return;
    }

    case "resolve": {
      const reason = values["skip-minimum-age-reason"].trim();
      let resolved;

      try {
        resolved = await resolveCandidate({
          repository,
          packageName: values.package,
          library,
          version: values.version,
          approvedBy: values["approved-by"],
          environment: values.environment,
          signerWorkflow: values["signer-workflow"],
          output: path.resolve(values.output),
          minimumAge: values["minimum-age"],
          skipMinimumAge: reason,
          dependencyRun: env.DEPENDENCY_TOKEN
            ? (command, args) =>
                exec(command, args, { ...env, GH_TOKEN: env.DEPENDENCY_TOKEN })
            : exec,
        });
      } catch (error) {
        const skip = "To promote now, set `skip-minimum-age-reason`.";

        if (error.soak) {
          await summarize(
            soakSummary(
              error.soak,
              `Some changes were on staging for less than the minimum time. ${skip}`
            ).join("\n")
          );
        }

        if (error.unchecked !== undefined) {
          await summarize(
            soakSummary(
              undefined,
              `Cannot check the time on staging. ${error.unchecked} ${skip}`
            ).join("\n")
          );
        }

        throw error;
      }

      const { manifest, pending, dependencies, soak } = resolved;

      const released = dependencies.length
        ? [
            "Its internal dependencies are production releases:",
            "",
            "| Dependency | Version |",
            "| --- | --- |",
            ...dependencies.map(
              ({ dependency, version }) => `| ${dependency} | \`${version}\` |`
            ),
            "",
          ]
        : [];

      await summarize(
        pending
          ? [
              `### Promote \`${manifest.stagingTag}\` to production`,
              "",
              releaseNotes(
                manifest,
                "production",
                resolved.overridden ? { reason } : null
              ),
              ...released,
              // With a skip reason there is no table; the release notes above give the reason.
              ...(soak ? soakSummary(soak) : []),
              "Approve the deployment to release this exact build.",
            ].join("\n")
          : `### \`${manifest.stagingTag}\` is already released as \`${manifest.productionTag}\`\n\nNothing to publish.`
      );
      await outputs({ pending, version: manifest.bump.version });

      return;
    }

    default: {
      throw new Error(
        "Usage: swift-release.mjs collect|publish|resolve [options]"
      );
    }
  }
};

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  try {
    await main();
  } catch (error) {
    console.error(`::error::${error.message.replaceAll("\n", "%0A")}`);
    process.exitCode = 1;
  }
}
