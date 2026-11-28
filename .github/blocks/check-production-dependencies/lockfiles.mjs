// Lockfile reading shared by the production dependency check and the package
// consumer comment.
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml, parseAllDocuments } from "yaml";

export { parseToml, parseYaml };

/**
 * Parse pnpm-lock.yaml. pnpm 12 prepends its package-manager/config dependency
 * graph as a first document; returns `lockfile` (the application graph) and
 * `toolchainLockfiles` (that first document, when present).
 */
export function parsePnpmLockfile(text) {
  const documents = parseAllDocuments(text);
  for (const document of documents) {
    if (document.errors.length) throw document.errors[0];
  }
  const lockfiles = documents.map((document) => document.toJS());
  if (lockfiles.length < 1 || lockfiles.length > 2 ||
      lockfiles.some((lockfile) => !lockfile || typeof lockfile !== "object" || Array.isArray(lockfile)))
    throw new Error("Expected one pnpm lockfile or a toolchain document followed by the application lockfile");
  if (lockfiles.length === 2) {
    // Do not silently select a document from an arbitrary multi-document YAML file.
    const importers = lockfiles[0].importers;
    const importer = importers?.["."];
    const application = lockfiles[1].importers?.["."];
    if (!application || Object.keys(application).some(
      (field) => ["configDependencies", "packageManagerDependencies"].includes(field)))
      throw new Error("The second pnpm lockfile document must contain application importers");
    if (!importer || Object.keys(importers).length !== 1 ||
        !Object.keys(importer).length || Object.keys(importer).some(
          (field) => !["configDependencies", "packageManagerDependencies"].includes(field)))
      throw new Error("The first pnpm lockfile document must contain only toolchain importers");
  }
  return { lockfile: lockfiles.at(-1), toolchainLockfiles: lockfiles.slice(0, -1) };
}
