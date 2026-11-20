import { execFileSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import nodePath from "node:path";
import {
  crateFile,
  crateProblem,
  fileName,
  integrity,
  readCrate,
  readTarballManifest,
  sha256,
} from "./package-artifact-files.mjs";
import { MANIFEST } from "./package-manifest.mjs";
import {
  bumpProblem,
  GITHUB_PACKAGES,
  matchesPackage,
  missingSelectedPackage,
  NPMJS,
  publishOrder,
  releaseNames,
  SHA,
  sortedNames,
  STABLE,
  SUFFIX,
} from "./package-release-policy.mjs";

export {
  integrity,
  readArchive,
  readCrate,
  readTarballManifest,
  sha256,
} from "./package-artifact-files.mjs";

export { MANIFEST, readManifest, verifyManifest } from "./package-manifest.mjs";

export {
  bumpProblem,
  DEPENDENCY_FIELDS,
  GITHUB_PACKAGES,
  matchesPackage,
  NPMJS,
  publishOrder,
  releaseNames,
  SHA,
  STABLE,
} from "./package-release-policy.mjs";

export const exec = function exec(command, args, env = process.env) {
  return execFileSync(command, args, {
    encoding: "utf-8",
    env,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
};

export const notFound = (error, pattern = /HTTP 404/) =>
  pattern.test(String(error?.stderr ?? ""));

/**
 * A registry's reader of package metadata. npmjs is public: it is read without
 * credentials, and with `write=true`, as npm reads before a write, so its CDN
 * cannot answer with a packument or a 404 cached minutes ago.
 */
export const registryMetadata = function registryMetadata(
  registryUrl = GITHUB_PACKAGES,
  token = process.env.NODE_AUTH_TOKEN
) {
  const npmjs = registryUrl === NPMJS;

  return async (name) => {
    if (!npmjs && !token) {
      throw new Error("NODE_AUTH_TOKEN is required to read GitHub Packages");
    }

    const response = await fetch(
      `${registryUrl}/${encodeURIComponent(name)}${npmjs ? "?write=true" : ""}`,
      {
        headers: npmjs
          ? { accept: "application/json" }
          : { authorization: `Bearer ${token}`, accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      }
    );

    if (response.status === 404) {
      return { versions: {}, "dist-tags": {} };
    }

    if (!response.ok) {
      throw new Error(`${name}: registry returned HTTP ${response.status}`);
    }

    const body = await response.json();

    return {
      versions: body.versions ?? {},
      "dist-tags": body["dist-tags"] ?? {},
    };
  };
};

export const cached = function cached(registry) {
  const entries = new Map();

  return (name) => {
    if (!entries.has(name)) {
      entries.set(name, registry(name));
    }

    return entries.get(name);
  };
};

const readPacked = async (directory, selection) => {
  const files = (await readdir(directory))
    .filter((file) => file.endsWith(".tgz"))
    .toSorted();

  if (!files.length) {
    throw new Error(`The pack command wrote no .tgz file to ${directory}`);
  }

  const packed = new Map();

  for (const file of files) {
    const path = nodePath.join(directory, file);
    const manifest = readTarballManifest(path);

    if (!matchesPackage(manifest.name, selection)) {
      throw new Error(
        `${file}: ${manifest.name} is not in the release selection ${selection.join(" ")}`
      );
    }

    if (packed.has(manifest.name)) {
      throw new Error(`${manifest.name} was packed more than once`);
    }

    packed.set(manifest.name, { path, manifest });
  }

  return packed;
};

const readCrates = async (directory, expected, sourceSha) => {
  const files = expected.length
    ? (await readdir(directory))
        .filter((file) => file.endsWith(".crate"))
        .toSorted()
    : [];

  const packaged = new Map();

  for (const file of files) {
    const path = nodePath.join(directory, file);
    const crate = readCrate(path);
    const problem = crateProblem(crate, sourceSha);

    if (problem) {
      throw new Error(`${file}: ${problem}`);
    }

    if (packaged.has(crate.name)) {
      throw new Error(`${crate.name} was packaged more than once`);
    }

    packaged.set(crate.name, { path, version: crate.version });
  }

  if (sortedNames(packaged.keys()) !== sortedNames(expected)) {
    throw new Error(
      `The packaged crates (${[...packaged.keys()].join(", ") || "none"}) are not the crates input (${expected.join(", ")})`
    );
  }

  return packaged;
};

/**
 * Validate the two packs of one source commit, and the crates packaged from it,
 * and lay them out with a manifest that promotion can verify: the staging build
 * and its stable candidates, every package at the version `bump` computed.
 */
export const collect = async ({
  stagingDirectory,
  productionDirectory,
  crateDirectory,
  crates = [],
  suffix,
  bump,
  sourceSha,
  repository,
  packageInput,
  packageSelection,
  tagPrefix,
  productionTagPrefix,
  registryUrl,
  output,
  runUrl,
}) => {
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

  const names = releaseNames({
    repository,
    packageInput,
    packageSelection,
    tagPrefix,
    productionTagPrefix,
    registryUrl,
  });

  // Cargo pins an internal crate by the vX.Y.Z tag of its release.
  if (crates.length && names.productionTagPrefix !== "v") {
    throw new Error(
      "Crates are released under vX.Y.Z tags; a build with crates cannot use another production tag prefix"
    );
  }

  const staging = await readPacked(stagingDirectory, names.selection);
  const production = await readPacked(productionDirectory, names.selection);
  const packaged = await readCrates(crateDirectory, crates, sourceSha);
  const packed = [...production.keys()].toSorted();

  if (
    JSON.stringify(packed) !== JSON.stringify([...staging.keys()].toSorted())
  ) {
    throw new Error(
      "The staging and production packs contain different packages"
    );
  }

  if (!production.has(names.primary)) {
    throw new Error(
      `${names.primary} was not packed; set the package input to the package that names the release`
    );
  }

  const missing = missingSelectedPackage(names.selection, production);

  if (missing) {
    throw new Error(
      `${missing} was not packed; every exact package selection must be present`
    );
  }

  const filenames = new Set();

  for (const name of packed) {
    const candidate = production.get(name).manifest.version;
    const build = staging.get(name).manifest.version;

    if (!STABLE.test(candidate)) {
      throw new Error(
        `${name}@${candidate}: a production candidate must be X.Y.Z`
      );
    }

    if (candidate !== bump.version) {
      throw new Error(
        `${name}@${candidate}: every package of the build is packed at its release version ${bump.version}, RELEASE_VERSION`
      );
    }

    if (build !== `${candidate}${suffix}`) {
      throw new Error(
        `${name}: staging packed ${build}, expected ${candidate}${suffix}`
      );
    }

    const file = fileName(name, candidate);

    if (filenames.has(file)) {
      throw new Error(
        `${file}: multiple packages map to the same release filename`
      );
    }

    filenames.add(file);
  }

  await mkdir(output, { recursive: true });

  const entry = async ({ path, manifest }) => {
    const file = fileName(manifest.name, manifest.version);
    await copyFile(path, nodePath.join(output, file));
    const buffer = await readFile(path);

    return {
      version: manifest.version,
      file,
      sha256: sha256(buffer),
      integrity: integrity(buffer),
    };
  };

  const packages = [];

  for (const name of publishOrder(
    new Map(
      packed.map((packedName) => [
        packedName,
        production.get(packedName).manifest,
      ])
    )
  )) {
    packages.push({
      name,
      staging: await entry(staging.get(name)),
      production: await entry(production.get(name)),
    });
  }

  const crateEntries = [];

  for (const [name, { path, version }] of [...packaged].toSorted(
    ([left], [right]) => left.localeCompare(right)
  )) {
    const file = crateFile(name, version);
    await copyFile(path, nodePath.join(output, file));
    crateEntries.push({
      name,
      version,
      file,
      sha256: sha256(await readFile(path)),
    });
  }

  const primary = packages.find(({ name }) => name === names.primary);

  const manifest = {
    formatVersion: 3,
    repository,
    sourceSha,
    runUrl,
    suffix,
    package: names.primary,
    registry: names.registryUrl,
    selection: names.selection,
    stagingTag: `${names.tagPrefix}${primary.staging.version}`,
    productionTag: `${names.productionTagPrefix}${primary.production.version}`,
    packages,
    crates: crateEntries,
    bump,
  };

  await writeFile(
    nodePath.join(output, MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`
  );

  return manifest;
};
