import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { bumpProblem, sha256 } from "./package-release.mjs";
import { bumpNotes } from "./release-version.mjs";

export const MANIFEST = "release-manifest.json";
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SUFFIX = /^-staging\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const SHA = /^[a-f0-9]{40}$/;

export const STAGING_TAG =
  /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-staging\.(?<runId>\d+)\.(?<attempt>\d+)$/;

/**
 * GitGate and the Astrolabe self-updater install the first asset ending in
 * .pkg, so a release holds exactly one: the staging build on a staging
 * release, the promoted candidate on a production one. The candidate rides on
 * the staging release under a name they skip.
 */
export const packageFile = (name) => `${name}.pkg`;

export const candidateFile = (name, version) =>
  `${name}-${version}.pkg.candidate`;

const kind = (library) => (library ? "swift-library" : "swift-package");

/**
 * Lay out a staging build and its production candidate, both packaged from one
 * source commit at the version `bump` computed, with a manifest promotion can
 * verify. A library has no files: its release is the tag.
 */
export const collect = async ({
  stagingPackage,
  productionPackage,
  packageName,
  library = false,
  bump,
  suffix,
  sourceSha,
  repository,
  output,
  runUrl,
}) => {
  if (!NAME.test(packageName ?? "")) {
    throw new Error(`Invalid package name ${packageName}`);
  }

  if (!SUFFIX.test(suffix)) {
    throw new Error(`Invalid staging suffix: ${suffix}`);
  }

  if (!SHA.test(sourceSha)) {
    throw new Error("An exact source commit is required");
  }

  const problem = bumpProblem(bump);

  if (problem) {
    throw new Error(`Invalid release version: ${problem}`);
  }

  await mkdir(output, { recursive: true });
  let pkg = null;

  if (!library) {
    const entry = async (source, version, file) => {
      await copyFile(source, path.join(output, file));

      return { version, file, sha256: sha256(await readFile(source)) };
    };

    pkg = {
      staging: await entry(
        stagingPackage,
        `${bump.version}${suffix}`,
        packageFile(packageName)
      ),
      production: await entry(
        productionPackage,
        bump.version,
        candidateFile(packageName, bump.version)
      ),
    };
  }

  const manifest = {
    formatVersion: 1,
    kind: kind(library),
    repository,
    sourceSha,
    runUrl,
    suffix,
    package: packageName,
    stagingTag: `v${bump.version}${suffix}`,
    productionTag: `v${bump.version}`,
    bump,
    pkg,
  };

  await writeFile(
    path.join(output, MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`
  );

  return manifest;
};

export const readManifest = async (directory) => {
  const manifest = JSON.parse(
    await readFile(path.join(directory, MANIFEST), "utf-8")
  );

  if (
    manifest.formatVersion !== 1 ||
    !["swift-package", "swift-library"].includes(manifest.kind)
  ) {
    throw new Error("Unsupported Swift release manifest");
  }

  return manifest;
};

const invalidManifest = (reason) => {
  throw new Error(
    `The release manifest does not describe this build: ${reason}`
  );
};

const verifyManifestVersion = (manifest, bump) => {
  const problem = bumpProblem(manifest.bump);

  if (problem) {
    invalidManifest(`bump ${problem}`);
  }

  if (bump && JSON.stringify(manifest.bump) !== JSON.stringify(bump)) {
    invalidManifest("bump, which is not the version this run computed");
  }

  const { version } = manifest.bump;

  if (
    manifest.stagingTag !== `v${version}${manifest.suffix}` ||
    manifest.productionTag !== `v${version}`
  ) {
    invalidManifest("release tags");
  }

  return version;
};

/**
 * Rebuild a manifest's claims from the caller's own coordinates and the files
 * it lists. The build job ran repository code, so nothing in the manifest is
 * trusted until it matches.
 */
export const verifyManifest = async (
  directory,
  manifest,
  { repository, sourceSha, runId, packageName, library = false, channels, bump }
) => {
  if (manifest.repository !== repository) {
    invalidManifest(`repository ${manifest.repository}`);
  }

  if (
    !SHA.test(manifest.sourceSha) ||
    (sourceSha && manifest.sourceSha !== sourceSha)
  ) {
    invalidManifest(`source ${manifest.sourceSha}`);
  }

  if (
    !SUFFIX.test(manifest.suffix) ||
    (runId && !manifest.suffix.startsWith(`-staging.${runId}.`))
  ) {
    invalidManifest(`suffix ${manifest.suffix}`);
  }

  if (manifest.package !== packageName) {
    invalidManifest(`package ${manifest.package}`);
  }

  if (manifest.kind !== kind(library)) {
    invalidManifest(`kind ${manifest.kind}`);
  }

  const version = verifyManifestVersion(manifest, bump);

  if (library) {
    if (manifest.pkg !== null) {
      invalidManifest("files of a library");
    }

    return;
  }

  const expected = {
    staging: {
      version: `${version}${manifest.suffix}`,
      file: packageFile(packageName),
    },
    production: { version, file: candidateFile(packageName, version) },
  };

  for (const channel of ["staging", "production"]) {
    const entry = manifest.pkg?.[channel];

    if (
      entry?.version !== expected[channel].version ||
      entry.file !== expected[channel].file
    ) {
      invalidManifest(`${channel} package`);
    }
  }

  for (const channel of channels) {
    if (
      sha256(
        await readFile(path.join(directory, manifest.pkg[channel].file))
      ) !== manifest.pkg[channel].sha256
    ) {
      throw new Error(
        `${manifest.pkg[channel].file} does not match the release manifest`
      );
    }
  }
};

export const releaseNotes = function releaseNotes(
  manifest,
  channel,
  override = null
) {
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const source = `[\`${manifest.sourceSha.slice(0, 12)}\`](${server}/${manifest.repository}/commit/${manifest.sourceSha})`;
  const staging = manifest.pkg?.staging.version ?? manifest.stagingTag.slice(1);

  const lines =
    channel === "staging"
      ? [
          manifest.pkg
            ? `Staging build of ${source} ([run](${manifest.runUrl})). Staging Macs install it. The production candidate is attached; promote this build with \`staging-version: ${staging}\`.`
            : `Staging tag of ${source} ([run](${manifest.runUrl})). Depend on \`.exact("${staging}")\` to try it; promote it with \`staging-version: ${staging}\`.`,
        ]
      : [
          `Promoted from [\`${manifest.stagingTag}\`](${server}/${manifest.repository}/releases/tag/${manifest.stagingTag}), built from ${source} ([run](${manifest.runUrl})).`,
        ];

  if (manifest.pkg) {
    const rows =
      channel === "staging" ? ["staging", "production"] : ["production"];

    lines.push("", "| Package | Version | SHA-256 |", "| --- | --- | --- |");

    for (const row of rows) {
      const { version, sha256: digest } = manifest.pkg[row];

      const label =
        row === "production" && channel === "staging"
          ? " (production candidate)"
          : "";

      lines.push(
        `| \`${packageFile(manifest.package)}\`${label} | \`${version}\` | \`${digest}\` |`
      );
    }
  }

  if (override) {
    lines.push(
      "",
      `Promoted without a check of the time on staging. Reason: ${override.reason}`
    );
  }

  lines.push("", ...bumpNotes(manifest.bump, manifest.repository));

  return `${lines.join("\n")}\n`;
};
