import { exactStable } from "./dependency-check-utils.mjs";
import { auditCrates, fetchCrateRelease } from "./internal-crates.mjs";
import { fetchPackageMetadata } from "./internal-packages.mjs";
import { inspectProductionDependencies } from "./pnpm-graph.mjs";

export { inspectProductionDependencies };

const packageReason = (release) => {
  if (!release) {
    return "Not published";
  }

  return release.deprecated ? "Deprecated" : "Published stable version";
};

const auditPackages = async (inputs, loadMetadata) => {
  const { errors, versions } = inspectProductionDependencies(inputs);

  const packages = [...versions]
    .flatMap(([name, pins]) =>
      [...pins].map((version) => ({
        name,
        version,
        production: exactStable(version) ? null : false,
        reason: exactStable(version)
          ? "Publication not verified"
          : "Not an exact stable version",
      }))
    )
    .toSorted(
      (a, b) =>
        a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
    );

  await Promise.all(
    [...versions.keys()].map(async (name) => {
      const rows = packages.filter(
        (entry) => entry.name === name && entry.production === null
      );

      if (!rows.length) {
        return;
      }

      try {
        const metadata = await loadMetadata(name);

        for (const row of rows) {
          const release = metadata.versions?.[row.version];
          row.production = Boolean(release && !release.deprecated);
          row.reason = packageReason(release);

          if (!row.production) {
            errors.push(
              `${name}@${row.version}: exact version is ${release ? "deprecated" : "not published"}`
            );
          }
        }
      } catch (error) {
        for (const row of rows) {
          row.reason = "Registry lookup failed";
        }

        errors.push(`${name}: ${error.message}`);
      }
    })
  );

  return { packages, errors };
};

export const auditProductionDependencies = async (
  inputs,
  loadMetadata = fetchPackageMetadata,
  loadRelease = fetchCrateRelease
) => {
  const errors = [];
  const report = { source: inputs.source };

  if (inputs.workspace) {
    const audit = await auditPackages(inputs, loadMetadata);
    report.packages = audit.packages;
    errors.push(...audit.errors);
  }

  if (inputs.cargo) {
    const audit = await auditCrates(inputs.cargo, loadRelease);
    report.crates = audit.crates;
    errors.push(...audit.errors);
  }

  if (!inputs.workspace && !inputs.cargo) {
    errors.push("No pnpm workspace or Cargo workspace to check");
  }

  return { ...report, errors: errors.toSorted() };
};

export const checkProductionDependencies = async (
  inputs,
  loadMetadata = fetchPackageMetadata,
  loadRelease = fetchCrateRelease
) => {
  const report = await auditProductionDependencies(
    inputs,
    loadMetadata,
    loadRelease
  );

  if (report.errors.length) {
    throw new Error(
      `Production dependency check failed:\n${report.errors.map((error) => `- ${error}`).join("\n")}\nPublish and review compatible stable pins and their lockfile before releasing.`
    );
  }

  return [...(report.packages ?? []), ...(report.crates ?? [])]
    .map(({ name, version }) => `${name}@${version}`)
    .toSorted();
};
