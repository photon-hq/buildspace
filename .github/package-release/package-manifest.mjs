import { readFile } from "node:fs/promises";
import nodePath from "node:path";
import {
  CRATE_NAME,
  crateFile,
  crateProblem,
  fileName,
  integrity,
  readCrate,
  readTarballManifest,
  sha256,
} from "./package-artifact-files.mjs";
import {
  bumpProblem,
  GITHUB_PACKAGES,
  matchesPackage,
  missingSelectedPackage,
  publishOrder,
  releaseNames,
  SHA,
  sortedNames,
  STABLE,
  SUFFIX,
} from "./package-release-policy.mjs";

export const MANIFEST = "release-manifest.json";

/**
 * Format 1 predates crates; it is read as a build without any. Format 3 records
 * the bump that computed the build's version; earlier builds took theirs from
 * package.json.
 */
export const readManifest = async (directory) => {
  const manifest = JSON.parse(
    await readFile(nodePath.join(directory, MANIFEST), "utf-8")
  );

  if (manifest.formatVersion === 1) {
    manifest.crates = [];
  }

  if (
    ![1, 2, 3].includes(manifest.formatVersion) ||
    !Array.isArray(manifest.packages) ||
    !Array.isArray(manifest.crates)
  ) {
    throw new Error("Unsupported release manifest");
  }

  return manifest;
};

const verifyFiles = async (directory, manifest, channels) => {
  const files = [
    ...manifest.packages.flatMap((pkg) =>
      channels.map((channel) => pkg[channel])
    ),
    ...manifest.crates,
  ];

  for (const {
    file,
    sha256: expected,
    integrity: expectedIntegrity,
  } of files) {
    const buffer = await readFile(nodePath.join(directory, file));

    if (
      sha256(buffer) !== expected ||
      (file.endsWith(".tgz") && integrity(buffer) !== expectedIntegrity)
    ) {
      throw new Error(`${file} does not match the release manifest`);
    }
  }
};

const fail = (reason) => {
  throw new Error(
    `The release manifest does not describe this build: ${reason}`
  );
};

const verifyCoordinates = (
  manifest,
  names,
  { repository, sourceSha, runId, packageInput, registryUrl, bump }
) => {
  if (manifest.repository !== repository) {
    fail(`repository ${manifest.repository}`);
  }

  if (
    !SHA.test(manifest.sourceSha) ||
    (sourceSha && manifest.sourceSha !== sourceSha)
  ) {
    fail(`source ${manifest.sourceSha}`);
  }

  if (
    !SUFFIX.test(manifest.suffix) ||
    (runId && !manifest.suffix.startsWith(`-staging.${runId}.`))
  ) {
    fail(`suffix ${manifest.suffix}`);
  }

  if (manifest.package !== names.primary) {
    fail(`package ${manifest.package}`);
  }

  if ((manifest.registry ?? GITHUB_PACKAGES) !== names.registryUrl) {
    fail(`registry ${manifest.registry ?? GITHUB_PACKAGES}`);
  }

  const selection =
    manifest.selection ??
    releaseNames({ repository, packageInput, registryUrl }).selection;

  if (
    !Array.isArray(selection) ||
    sortedNames(new Set(selection)) !== sortedNames(new Set(names.selection))
  ) {
    fail("package selection differs from the staged policy");
  }

  if (manifest.formatVersion === 3 && bumpProblem(manifest.bump)) {
    fail(`bump ${bumpProblem(manifest.bump)}`);
  }

  if (bump && JSON.stringify(manifest.bump) !== JSON.stringify(bump)) {
    fail("bump, which is not the version this run computed");
  }
};

const verifyPackageRecords = (manifest, selection, channels) => {
  const seen = new Set();

  for (const pkg of manifest.packages) {
    if (!matchesPackage(pkg.name, selection) || seen.has(pkg.name)) {
      fail(`package ${pkg.name}`);
    }

    seen.add(pkg.name);

    if (
      !STABLE.test(pkg.production.version) ||
      pkg.staging.version !== `${pkg.production.version}${manifest.suffix}` ||
      (manifest.bump && pkg.production.version !== manifest.bump.version)
    ) {
      fail(`${pkg.name} versions`);
    }

    for (const channel of channels) {
      if (pkg[channel].file !== fileName(pkg.name, pkg[channel].version)) {
        fail(`file ${pkg[channel].file}`);
      }
    }
  }

  const missing = missingSelectedPackage(selection, seen);

  if (missing) {
    fail(`selected package ${missing} is missing`);
  }
};

const verifyCrateRecords = (records, crates) => {
  const crateNames = new Set();

  for (const crate of records) {
    if (!CRATE_NAME.test(crate.name ?? "") || crateNames.has(crate.name)) {
      fail(`crate ${crate.name}`);
    }

    crateNames.add(crate.name);

    if (!STABLE.test(crate.version ?? "")) {
      fail(`${crate.name} version`);
    }

    if (crate.file !== crateFile(crate.name, crate.version)) {
      fail(`file ${crate.file}`);
    }
  }

  if (crates && sortedNames(crateNames) !== sortedNames(crates)) {
    fail(`crates ${[...crateNames].join(", ") || "none"}`);
  }
};

/**
 * Rebuild a manifest's claims from the files it lists and the caller's own
 * coordinates. The build job ran repository code, so a job that writes trusts
 * nothing in the manifest until it matches.
 */
export const verifyManifest = async (
  directory,
  manifest,
  {
    repository,
    sourceSha,
    runId,
    packageInput,
    packageSelection,
    tagPrefix,
    productionTagPrefix,
    registryUrl,
    channels,
    crates,
    bump,
  }
) => {
  const names = releaseNames({
    repository,
    packageInput,
    packageSelection,
    tagPrefix,
    productionTagPrefix,
    registryUrl,
  });

  verifyCoordinates(manifest, names, {
    repository,
    sourceSha,
    runId,
    packageInput,
    registryUrl,
    bump,
  });
  verifyPackageRecords(manifest, names.selection, channels);
  verifyCrateRecords(manifest.crates, crates);

  await verifyFiles(directory, manifest, channels);

  for (const crate of manifest.crates) {
    const contents = readCrate(nodePath.join(directory, crate.file));
    const problem = crateProblem(contents, manifest.sourceSha);

    if (problem) {
      fail(problem);
    }

    if (contents.name !== crate.name || contents.version !== crate.version) {
      fail(`${crate.file} holds ${contents.name} ${contents.version}`);
    }
  }

  const packed = new Map();

  for (const pkg of manifest.packages) {
    for (const channel of channels) {
      const { file, version } = pkg[channel];
      const contents = readTarballManifest(nodePath.join(directory, file));

      if (contents.name !== pkg.name || contents.version !== version) {
        fail(`${file} holds ${contents.name}@${contents.version}`);
      }

      if (channel === "production") {
        packed.set(pkg.name, contents);
      }
    }
  }

  const primary = manifest.packages.find(({ name }) => name === names.primary);

  if (!primary) {
    fail(`${names.primary} is missing`);
  }

  if (
    manifest.stagingTag !== `${names.tagPrefix}${primary.staging.version}` ||
    manifest.productionTag !==
      `${names.productionTagPrefix}${primary.production.version}`
  ) {
    fail("release tags");
  }

  if (manifest.crates.length && names.productionTagPrefix !== "v") {
    fail("crates under a production tag prefix");
  }

  if (
    JSON.stringify(publishOrder(packed)) !==
    JSON.stringify(manifest.packages.map(({ name }) => name))
  ) {
    fail("publish order");
  }
};
